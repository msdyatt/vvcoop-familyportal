-- Native app push (iOS and Android through Firebase Cloud Messaging). A phone
-- app's device token lives in the same table as a browser's web-push
-- subscription, so "who has a device" and "turn this one off" stay one idea.
-- A row is exactly one of: a web subscription (endpoint + keys) or a native
-- token. Existing rows are all web and are unchanged.
alter table public.push_subscriptions
  add column if not exists platform text not null default 'web'
    check (platform in ('web', 'ios', 'android')),
  add column if not exists device_token text;

alter table public.push_subscriptions
  alter column endpoint drop not null,
  alter column p256dh drop not null,
  alter column auth drop not null;

alter table public.push_subscriptions
  add constraint push_subscriptions_shape check (
    (platform = 'web' and endpoint is not null and p256dh is not null and auth is not null and device_token is null)
    or (platform in ('ios', 'android') and device_token is not null and endpoint is null and p256dh is null and auth is null)
  );

create unique index if not exists push_subscriptions_device_token_key
  on public.push_subscriptions (device_token) where device_token is not null;

-- Same shape as register_push_subscription: one row per physical device, and
-- if a phone is signed into a different account later the row moves to them
-- rather than duplicating (so the previous person stops receiving it).
create or replace function public.register_device_token(p_token text, p_platform text, p_user_agent text default null)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if (select auth.uid()) is null then
    raise exception 'Sign in first.';
  end if;
  if p_platform is null or p_platform not in ('ios', 'android') then
    raise exception 'Unknown platform.';
  end if;
  if coalesce(p_token, '') = '' or length(p_token) > 4096 then
    raise exception 'That is not a valid device token.';
  end if;

  insert into public.push_subscriptions (user_id, platform, device_token, user_agent)
  values ((select auth.uid()), p_platform, p_token, left(p_user_agent, 300))
  on conflict (device_token) where device_token is not null do update
    set user_id = excluded.user_id, platform = excluded.platform,
        user_agent = excluded.user_agent, last_seen_at = now();
end;
$function$;

create or replace function public.unregister_device_token(p_token text)
returns void
language sql security definer set search_path to ''
as $function$
  delete from public.push_subscriptions
  where device_token = p_token and user_id = (select auth.uid());
$function$;

revoke all on function public.register_device_token(text, text, text) from public, anon;
revoke all on function public.unregister_device_token(text) from public, anon;
grant execute on function public.register_device_token(text, text, text) to authenticated;
grant execute on function public.unregister_device_token(text) to authenticated;
