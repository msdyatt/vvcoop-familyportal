alter table public.profiles
  add column calendar_token uuid not null default gen_random_uuid() unique;

comment on column public.profiles.calendar_token is
  'Opaque token for this profile''s personal subscribable calendar feed (supabase/functions/calendar-feed). Not meant to be set directly by clients -- see regenerate_calendar_token(). A leaked link is invalidated by regenerating.';

create or replace function public.regenerate_calendar_token()
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  new_token uuid := gen_random_uuid();
begin
  update public.profiles set calendar_token = new_token where id = auth.uid();
  return new_token;
end;
$$;

revoke all on function public.regenerate_calendar_token() from public;
grant execute on function public.regenerate_calendar_token() to authenticated;
