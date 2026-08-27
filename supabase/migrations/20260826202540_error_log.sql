-- Error monitoring: a system-level log, distinct from audit_log (which
-- requires a known actor -- errors can come from anonymous/pre-login
-- visitors, so user_id here must be nullable).
create table public.error_log (
  id bigint generated always as identity primary key,
  user_id uuid references public.profiles(id) on delete set null,
  source text not null,
  message text not null,
  stack text,
  url text,
  user_agent text,
  context jsonb,
  created_at timestamptz not null default now()
);

create index error_log_created_idx on public.error_log(created_at desc);

alter table public.error_log enable row level security;

create policy error_log_admin_read on public.error_log
  for select to authenticated using (private.has_role('admin'));

grant select on public.error_log to authenticated;
-- No insert grant to authenticated/anon: every write goes through
-- report_client_error() below (SECURITY DEFINER, runs as its owner) or a
-- service-role client from an edge function -- never directly from a client
-- session, so an error report can't be used to read or tamper with the table.

create or replace function public.report_client_error(
  p_message text, p_stack text default null, p_url text default null,
  p_user_agent text default null, p_context jsonb default null
) returns void
language plpgsql security definer set search_path to ''
as $$
begin
  insert into public.error_log (user_id, source, message, stack, url, user_agent, context)
  values ((select auth.uid()), 'client', left(p_message, 2000), left(p_stack, 8000), left(p_url, 2000), left(p_user_agent, 500), p_context);
end;
$$;

revoke all on function public.report_client_error(text, text, text, text, jsonb) from public;
grant execute on function public.report_client_error(text, text, text, text, jsonb) to anon, authenticated;
