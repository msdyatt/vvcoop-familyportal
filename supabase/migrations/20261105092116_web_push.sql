-- Web push for the installable app. A device's push subscription is stored
-- here; the deliver-push edge function reads public.notifications (the one
-- place every fan-out already writes to) and sends each new row to the
-- recipient's devices. Nothing about who gets notified changes -- only that a
-- notification now also reaches the phone instead of waiting for the bell.

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create index push_subscriptions_user_idx on public.push_subscriptions(user_id);

alter table public.push_subscriptions enable row level security;

-- Read-only from the browser: a person can see their own devices. Writes go
-- through the two SECURITY DEFINER functions below, because one phone can be
-- signed in as a different person later and an upsert by endpoint has to be
-- able to move the row, which RLS on the old owner's row would forbid.
create policy push_subscriptions_read_own on public.push_subscriptions
  for select to authenticated using (user_id = (select auth.uid()));

grant select on public.push_subscriptions to authenticated;

create or replace function public.register_push_subscription(
  p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null
) returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in first.';
  end if;
  if p_endpoint is null or p_endpoint !~ '^https://' or length(p_endpoint) > 2048 then
    raise exception 'That is not a valid push endpoint.';
  end if;
  if coalesce(p_p256dh, '') = '' or coalesce(p_auth, '') = '' then
    raise exception 'The subscription keys are missing.';
  end if;

  insert into public.push_subscriptions (user_id, endpoint, p256dh, auth, user_agent)
  values ((select auth.uid()), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300))
  on conflict (endpoint) do update
    set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth,
        user_agent = excluded.user_agent, last_seen_at = now();
end;
$function$;

create or replace function public.unregister_push_subscription(p_endpoint text)
returns void
language sql security definer set search_path to ''
as $function$
  delete from public.push_subscriptions
  where endpoint = p_endpoint and user_id = (select auth.uid());
$function$;

revoke all on function public.register_push_subscription(text, text, text, text) from public, anon;
revoke all on function public.unregister_push_subscription(text) from public, anon;
grant execute on function public.register_push_subscription(text, text, text, text) to authenticated;
grant execute on function public.unregister_push_subscription(text) to authenticated;

-- One row per notification the push sender has claimed. Claiming first (insert
-- ... on conflict do nothing) is what stops two overlapping runs from sending
-- the same notification twice. Kept separate from public.notifications on
-- purpose: that table's BEFORE UPDATE trigger only lets a recipient change
-- read_at, and a service-role write has no has_role('admin') to pass it.
create table public.notification_push_log (
  notification_id uuid primary key references public.notifications(id) on delete cascade,
  claimed_at timestamptz not null default now(),
  sent_count integer not null default 0,
  failed_count integer not null default 0
);

alter table public.notification_push_log enable row level security;
create policy notification_push_log_admin_read on public.notification_push_log
  for select to authenticated using (private.has_role('admin'));
grant select on public.notification_push_log to authenticated;

-- The VAPID key pair identifies this site to the browsers' push services. The
-- edge function creates it the first time it is needed and keeps it in Vault,
-- like every other secret here, so no key is ever pasted into chat or a file.
-- Same narrow service_role-only bridge as read_vault_secret.
create or replace function public.vault_create_secret_if_absent(secret_name text, secret_value text)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if exists (select 1 from vault.decrypted_secrets where name = secret_name) then return; end if;
  perform vault.create_secret(secret_value, secret_name);
exception when unique_violation then
  null;
end;
$function$;

revoke all on function public.vault_create_secret_if_absent(text, text) from public, anon, authenticated;
grant execute on function public.vault_create_secret_if_absent(text, text) to service_role;

-- Send within a minute of a notification being created, but only call the
-- function when there is actually something unclaimed for a device that
-- exists. Reuses the delivery secret deliver-emails already reads from Vault.
select cron.unschedule('deliver-push')
where exists (select 1 from cron.job where jobname = 'deliver-push');

select cron.schedule(
  'deliver-push',
  '* * * * *',
  $$
  select net.http_post(
    url := 'https://jtwemgyhxylbhjzxgyvh.supabase.co/functions/v1/deliver-push',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-delivery-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'EMAIL_DELIVERY_SECRET')
    ),
    body := jsonb_build_object('mode', 'process')
  )
  where exists (
    select 1 from public.notifications n
    where n.created_at > now() - interval '15 minutes'
      and not exists (select 1 from public.notification_push_log l where l.notification_id = n.id)
      and exists (select 1 from public.push_subscriptions s where s.user_id = n.recipient_user_id)
  );
  $$
);
