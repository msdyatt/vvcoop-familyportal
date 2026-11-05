-- invitations.accepted_at existed from the start but nothing ever wrote it, so
-- the Invitations list could only ever say "Awaiting response" or "Expired",
-- even for families who had long since signed up -- which also made it unsafe
-- to offer "delete" on that list. An invited person is a real auth account
-- from the moment the invitation is made; they accept by confirming it (the
-- invite link sets email_confirmed_at), so that is the moment to record it.
create or replace function private.mark_invitation_accepted()
returns trigger
language plpgsql security definer set search_path to ''
as $function$
begin
  update public.invitations
  set accepted_at = coalesce(new.email_confirmed_at, now())
  where lower(email) = lower(new.email) and accepted_at is null;
  return new;
end;
$function$;

revoke all on function private.mark_invitation_accepted() from public, anon, authenticated;

drop trigger if exists on_auth_user_confirmed on auth.users;
create trigger on_auth_user_confirmed
  after update of email_confirmed_at on auth.users
  for each row
  when (old.email_confirmed_at is null and new.email_confirmed_at is not null)
  execute function private.mark_invitation_accepted();

-- Backfill: anyone already confirmed whose invitation still reads as pending.
update public.invitations i
set accepted_at = u.email_confirmed_at
from auth.users u
where lower(u.email) = lower(i.email)
  and u.email_confirmed_at is not null
  and i.accepted_at is null;
