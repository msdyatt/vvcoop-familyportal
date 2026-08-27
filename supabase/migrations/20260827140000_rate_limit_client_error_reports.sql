-- QA finding VV-13: report_client_error is callable by anon (intentionally
-- -- the shared-password gate and sign-in pages can fail before anyone is
-- logged in, and those errors are exactly the ones worth seeing), takes an
-- unbounded jsonb context with no size cap at all (every other field was
-- already length-limited via left(...), context was not), and had no rate
-- limit of any kind -- a trivial, repeatable way to grow error_log without
-- bound.
--
-- A plain SQL function has no real notion of "the caller's IP" the way an
-- edge function would -- but PostgREST does forward the original request
-- headers into a GUC this function CAN read, so this uses that (falling back
-- to the session's own auth.uid() when signed in, which is the more
-- reliable identity anyway) as a rate-limit bucket key: fixed 5-minute
-- windows, 20 reports per window per bucket. Over the limit, the report is
-- just dropped -- silently, not an error -- matching the same "reporting an
-- error must never itself throw" rule the client side already follows.
create table private.error_report_rate_limit (
  bucket_key text primary key,
  window_start timestamptz not null default now(),
  report_count int not null default 1
);
revoke all on table private.error_report_rate_limit from public, anon, authenticated;

create or replace function public.report_client_error(
  p_message text, p_stack text default null, p_url text default null,
  p_user_agent text default null, p_context jsonb default null
) returns void
language plpgsql security definer set search_path to ''
as $$
declare
  v_key text;
  v_window interval := interval '5 minutes';
  v_max_per_window constant int := 20;
  v_row private.error_report_rate_limit%rowtype;
  v_safe_context jsonb;
begin
  v_key := coalesce(
    (select auth.uid())::text,
    nullif(current_setting('request.headers', true)::jsonb ->> 'cf-connecting-ip', ''),
    nullif(current_setting('request.headers', true)::jsonb ->> 'x-forwarded-for', ''),
    'unknown'
  );

  select * into v_row from private.error_report_rate_limit where bucket_key = v_key for update;

  if v_row.bucket_key is null then
    insert into private.error_report_rate_limit (bucket_key) values (v_key);
  elsif v_row.window_start < now() - v_window then
    update private.error_report_rate_limit set window_start = now(), report_count = 1 where bucket_key = v_key;
  else
    update private.error_report_rate_limit set report_count = report_count + 1 where bucket_key = v_key;
    if v_row.report_count + 1 > v_max_per_window then
      return;
    end if;
  end if;

  -- Drop an oversized context outright rather than truncating it -- a
  -- truncated jsonb-as-text is not valid JSON, and re-casting it back would
  -- just turn a client error report into a server error of its own.
  v_safe_context := case when length(p_context::text) <= 4000 then p_context else null end;

  insert into public.error_log (user_id, source, message, stack, url, user_agent, context)
  values ((select auth.uid()), 'client', left(p_message, 2000), left(p_stack, 8000), left(p_url, 2000), left(p_user_agent, 500), v_safe_context);
end;
$$;
