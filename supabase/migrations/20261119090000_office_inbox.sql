-- Shared office inbox (issue #112).
-- ---------------------------------------------------------------------------
-- The co-op's office mailbox (one Google Workspace user) is read through the Gmail API and shown
-- to administrators as threads with a status, an assignee, internal notes and the family's
-- context. Replies go back out through the same mailbox, in the same Gmail thread.
--
-- Who can see any of it: administrators only, at the second-factor level when they have one
-- enrolled, and never a reviewer (demo) account. Email bodies can carry children's information,
-- so every table here is administrator-only and every write goes through a function below.
--
-- What lives where:
--   * The Google refresh token is in Supabase Vault (OFFICE_INBOX_REFRESH_TOKEN). It is written
--     and removed only by the service-role functions below and read only by the office-inbox
--     Edge Functions through public.read_vault_secret (service role only).
--   * The OAuth client id and secret are Edge Function secrets the owner sets. Not here.
--   * Message bodies are stored in inbox_messages; HTML is sanitised before it is stored and
--     again before it is shown. Attachments are copied into the private 'office-inbox' storage
--     bucket and opened through a two-minute, logged grant (like the records vault).
--   * Nothing is ever deleted in Gmail. Imported messages get the "Portal imported" label.
--
-- New mail is polled: pg_cron calls the office-inbox-sync function every minute while the
-- mailbox is connected (docs/office-inbox-setup.md says how to switch to Gmail push later).
-- The function's address is recorded at connect time from the function's own SUPABASE_URL, so
-- the same migration works on staging and production without a hard-coded project URL.
--
-- Audit: every send, assignment, status, category and family-link change, note, attachment
-- opening, connect and disconnect writes an inbox_events row (append-only) and an audit_log row
-- (the Activity tab).
-- ---------------------------------------------------------------------------

-- --- helpers ---------------------------------------------------------------------------------
-- The one access rule: an active administrator who is not a reviewer account. Used by policies,
-- so it stays executable by signed-in users (the private schema is not exposed through the API).
create or replace function private.is_inbox_admin()
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select private.has_role('admin') and not private.is_demo_user();
$function$;
revoke all on function private.is_inbox_admin() from public, anon;
grant execute on function private.is_inbox_admin() to authenticated;

-- For the browser-facing functions: who is calling, refused unless allowed.
create or replace function private.require_inbox_admin()
returns uuid
language plpgsql stable security definer set search_path to ''
as $function$
declare v uuid := (select auth.uid());
begin
  if v is null or not private.has_role('admin') or private.is_demo_user() then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if not private.aal_satisfied() then
    raise exception 'Complete two-factor verification before continuing.' using errcode = '42501';
  end if;
  return v;
end;
$function$;
revoke all on function private.require_inbox_admin() from public, anon, authenticated;

-- For the service-role functions, which act for a person the Edge Function has already
-- checked (session, role, second factor). Checked again here so a stale call cannot act for
-- someone who has since lost the role.
create or replace function private.inbox_actor_ok(p_user uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (
    select 1 from public.profiles p
    join public.user_roles r on r.user_id = p.id and r.role = 'admin'
    where p.id = p_user and p.status = 'active' and not p.is_demo);
$function$;
revoke all on function private.inbox_actor_ok(uuid) from public, anon, authenticated;

-- --- settings (one row) ------------------------------------------------------------------------
create table public.office_inbox_settings (
  id text primary key default 'office' check (id = 'office'),
  status text not null default 'disconnected' check (status in ('disconnected', 'connected', 'attention')),
  mailbox_address text,
  -- The name replies are sent under: "Veritas Village" <office@...>.
  display_name text not null default 'Veritas Village' check (char_length(display_name) between 1 and 80),
  gmail_label_id text,
  history_id text,
  -- The project's own URL, recorded by the connect function; the poll job calls <this>/functions/v1/office-inbox-sync.
  functions_url text check (functions_url is null or functions_url ~ '^https?://[A-Za-z0-9.:-]+$'),
  connected_at timestamptz,
  connected_by uuid references public.profiles(id) on delete set null,
  last_sync_at timestamptz,
  last_sync_error text,
  last_sync_imported integer,
  sync_lease_until timestamptz,
  -- How far back the first import reaches.
  backfill_days integer not null default 30 check (backfill_days between 0 and 90),
  updated_at timestamptz not null default now()
);
insert into public.office_inbox_settings (id) values ('office') on conflict do nothing;

-- Sign-in attempts in flight (the OAuth "state"), ten minutes each, used once.
create table public.office_inbox_oauth_states (
  state_hash text primary key check (state_hash ~ '^[0-9a-f]{64}$'),
  user_id uuid not null references public.profiles(id) on delete cascade,
  code_verifier text not null check (char_length(code_verifier) between 43 and 128),
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

-- --- threads, messages, attachments ----------------------------------------------------------------
create table public.inbox_threads (
  id uuid primary key default gen_random_uuid(),
  gmail_thread_id text unique,
  -- Room for portal messages and texts later; today every thread is email.
  channel text not null default 'email' check (channel in ('email')),
  subject text not null default '' check (char_length(subject) <= 500),
  -- The family's side of the conversation (lower-case address).
  counterpart_email text,
  counterpart_name text,
  -- Matched automatically from the sender's address, or linked by hand.
  family_id uuid references public.families(id) on delete set null,
  matched_user_id uuid references public.profiles(id) on delete set null,
  family_linked_by_hand boolean not null default false,
  status text not null default 'new' check (status in ('new', 'open', 'waiting', 'done')),
  category text not null default 'general'
    check (category in ('general', 'concern', 'reimbursement', 'dues', 'enrollment', 'absence', 'other')),
  assignee_id uuid references public.profiles(id) on delete set null,
  snippet text,
  message_count integer not null default 0,
  has_attachments boolean not null default false,
  last_message_at timestamptz,
  last_inbound_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index inbox_threads_list_idx on public.inbox_threads (status, last_message_at desc);
create index inbox_threads_assignee_idx on public.inbox_threads (assignee_id);
create index inbox_threads_family_idx on public.inbox_threads (family_id);
create index inbox_threads_counterpart_idx on public.inbox_threads (counterpart_email);

create table public.inbox_messages (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.inbox_threads(id) on delete cascade,
  gmail_message_id text unique,
  direction text not null check (direction in ('inbound', 'outbound')),
  from_address text,
  from_name text,
  reply_to text,
  to_addresses text[] not null default '{}',
  cc_addresses text[] not null default '{}',
  subject text,
  sent_at timestamptz not null,
  rfc_message_id text,
  in_reply_to text,
  references_header text,
  body_text text,
  -- Sanitised before it is stored (scripts, styles, event handlers removed). Shown in a sandbox.
  body_html text,
  snippet text,
  -- The administrator who sent it from the portal (null for mail written in Gmail itself).
  sent_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  search tsvector generated always as (
    to_tsvector('english'::regconfig,
      coalesce(subject, '') || ' ' || coalesce(from_name, '') || ' ' || coalesce(from_address, '') || ' ' || left(coalesce(body_text, ''), 200000))
  ) stored
);
create index inbox_messages_thread_idx on public.inbox_messages (thread_id, sent_at);
create index inbox_messages_search_idx on public.inbox_messages using gin (search);

create table public.inbox_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references public.inbox_messages(id) on delete cascade,
  thread_id uuid not null references public.inbox_threads(id) on delete cascade,
  filename text not null default 'attachment',
  mime_type text,
  size_bytes bigint,
  content_id text,
  is_inline boolean not null default false,
  -- Null when the file was too large to copy (it stays in Gmail).
  storage_path text check (storage_path is null or storage_path ~ '^messages/[A-Za-z0-9_-]+/[0-9]+$'),
  created_at timestamptz not null default now()
);
create index inbox_attachments_message_idx on public.inbox_attachments (message_id);
create index inbox_attachments_thread_idx on public.inbox_attachments (thread_id);

-- Internal notes. Never sent anywhere; administrators only.
create table public.inbox_notes (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.inbox_threads(id) on delete cascade,
  author_id uuid references public.profiles(id) on delete set null,
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  created_at timestamptz not null default now()
);
create index inbox_notes_thread_idx on public.inbox_notes (thread_id, created_at);

-- Per administrator: when they last opened the thread (unread = newer mail since).
create table public.inbox_thread_reads (
  thread_id uuid not null references public.inbox_threads(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  read_at timestamptz not null default now(),
  primary key (thread_id, user_id)
);

create table public.inbox_canned_replies (
  id uuid primary key default gen_random_uuid(),
  title text not null check (char_length(btrim(title)) between 1 and 80),
  body text not null check (char_length(btrim(body)) between 1 and 5000),
  archived boolean not null default false,
  created_by uuid references public.profiles(id) on delete set null,
  updated_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- One row per reply the portal tries to send. Rate limits and double-click protection read it.
create table public.inbox_sends (
  id uuid primary key default gen_random_uuid(),
  thread_id uuid not null references public.inbox_threads(id) on delete cascade,
  sent_by uuid references public.profiles(id) on delete set null,
  client_key uuid not null unique,
  to_address text not null,
  body_text text not null,
  next_status text not null default 'waiting' check (next_status in ('open', 'waiting', 'done')),
  status text not null default 'sending' check (status in ('sending', 'sent', 'failed')),
  gmail_message_id text,
  error_detail text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index inbox_sends_recent_idx on public.inbox_sends (created_at desc);

-- What happened, in order. Append-only.
create table public.inbox_events (
  id bigint generated always as identity primary key,
  thread_id uuid references public.inbox_threads(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  kind text not null check (kind in ('status', 'assigned', 'category', 'family_linked', 'note_added', 'reply_sent', 'reply_failed',
                                     'attachment_opened', 'connected', 'disconnected', 'canned_saved', 'canned_archived')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index inbox_events_thread_idx on public.inbox_events (thread_id, created_at);

create or replace function private.inbox_events_append_only()
returns trigger
language plpgsql set search_path to ''
as $function$
begin
  -- A thread's history may go with the thread (cascade); nothing else changes it.
  if tg_op = 'DELETE' and old.thread_id is not null
     and not exists (select 1 from public.inbox_threads t where t.id = old.thread_id) then
    return old;
  end if;
  raise exception 'The office inbox history cannot be changed.' using errcode = '42501';
end;
$function$;
create trigger inbox_events_append_only before update or delete on public.inbox_events
  for each row execute function private.inbox_events_append_only();

-- Short-lived permission to read one stored attachment (made by office_inbox_open_attachment).
create table public.inbox_attachment_grants (
  id uuid primary key default gen_random_uuid(),
  storage_path text not null,
  admin_id uuid not null references public.profiles(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index inbox_attachment_grants_lookup_idx on public.inbox_attachment_grants (admin_id, storage_path, expires_at);

-- --- access rules -------------------------------------------------------------------------------------
do $do$
declare t text;
begin
  foreach t in array array['office_inbox_settings', 'office_inbox_oauth_states', 'inbox_threads', 'inbox_messages', 'inbox_attachments',
                           'inbox_notes', 'inbox_thread_reads', 'inbox_canned_replies', 'inbox_sends', 'inbox_events', 'inbox_attachment_grants']
  loop
    execute format('alter table public.%I enable row level security', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('create policy aal2_required on public.%I as restrictive for all to authenticated using (private.aal_satisfied())', t);
  end loop;
  -- What an administrator may read directly. Writes always go through the functions below.
  foreach t in array array['office_inbox_settings', 'inbox_threads', 'inbox_messages', 'inbox_attachments', 'inbox_notes',
                           'inbox_thread_reads', 'inbox_canned_replies', 'inbox_events']
  loop
    execute format('create policy inbox_admin_read on public.%I for select to authenticated using (private.is_inbox_admin())', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
  -- Sign-in attempts, sends and file grants are not readable from the browser at all.
end;
$do$;

grant select, insert, update, delete on public.office_inbox_settings, public.office_inbox_oauth_states, public.inbox_threads,
  public.inbox_messages, public.inbox_attachments, public.inbox_notes, public.inbox_thread_reads, public.inbox_canned_replies,
  public.inbox_sends, public.inbox_attachment_grants to service_role;
grant select, insert on public.inbox_events to service_role;

-- --- storage: the private bucket for attachments ------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit)
values ('office-inbox', 'office-inbox', false, 26214400)
on conflict (id) do update set public = false;

create or replace function private.inbox_object_readable(p_name text)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (
    select 1 from public.inbox_attachment_grants g
    where g.storage_path = p_name and g.admin_id = (select auth.uid()) and g.expires_at > now());
$function$;
revoke all on function private.inbox_object_readable(text) from public, anon;
grant execute on function private.inbox_object_readable(text) to authenticated;

-- Reading needs the logged open step. Nobody signed in writes, changes or removes these files;
-- only the sync function (service role) stores them.
create policy office_inbox_read on storage.objects for select to authenticated
  using (bucket_id = 'office-inbox' and private.is_inbox_admin() and private.aal_satisfied() and private.inbox_object_readable(name));
create policy office_inbox_gate_select on storage.objects as restrictive for select to authenticated
  using (bucket_id <> 'office-inbox' or (private.is_inbox_admin() and private.aal_satisfied() and private.inbox_object_readable(name)));
create policy office_inbox_gate_insert on storage.objects as restrictive for insert to authenticated
  with check (bucket_id <> 'office-inbox');
create policy office_inbox_gate_update on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'office-inbox');
create policy office_inbox_gate_delete on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'office-inbox');

-- --- shared logic ----------------------------------------------------------------------------------------
-- The portal account and household a sender's address belongs to. Reviewer accounts never match.
create or replace function private.inbox_match_family(p_email text)
returns table (user_id uuid, family_id uuid)
language sql stable security definer set search_path to ''
as $function$
  select p.id, (select fm.family_id from public.family_members fm where fm.user_id = p.id order by fm.created_at limit 1)
  from public.profiles p
  where lower(p.email) = lower(btrim(coalesce(p_email, ''))) and not p.is_demo
    and lower(p.email) not like '%@demo.veritasvillage.org'
  limit 1;
$function$;
revoke all on function private.inbox_match_family(text) from public, anon, authenticated;

-- Where a reply goes: the Reply-To (or From) of the latest message the family sent.
create or replace function private.inbox_reply_target(p_thread uuid)
returns text
language sql stable security definer set search_path to ''
as $function$
  select coalesce(nullif(btrim(m.reply_to), ''), m.from_address)
  from public.inbox_messages m
  where m.thread_id = p_thread and m.direction = 'inbound'
  order by m.sent_at desc, m.created_at desc
  limit 1;
$function$;
revoke all on function private.inbox_reply_target(uuid) from public, anon, authenticated;

create or replace function private.inbox_log(p_thread uuid, p_actor uuid, p_kind text, p_detail jsonb)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  insert into public.inbox_events (thread_id, actor_id, kind, detail) values (p_thread, p_actor, p_kind, coalesce(p_detail, '{}'::jsonb));
  if p_actor is not null then
    insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
    values (p_actor, 'office_inbox_' || p_kind, case when p_thread is null then 'office_inbox' else 'inbox_thread' end,
            coalesce(p_thread::text, 'office'), coalesce(p_detail, '{}'::jsonb));
  end if;
end;
$function$;
revoke all on function private.inbox_log(uuid, uuid, text, jsonb) from public, anon, authenticated;

create or replace function private.inbox_name(p_user uuid)
returns text
language sql stable security definer set search_path to ''
as $function$
  select coalesce(nullif(btrim(p.display_name), ''), p.email) from public.profiles p where p.id = p_user;
$function$;
revoke all on function private.inbox_name(uuid) from public, anon, authenticated;

-- --- what administrators call ------------------------------------------------------------------------------
-- The connection, for the Integrations card.
create or replace function public.office_inbox_status()
returns jsonb
language plpgsql stable security definer set search_path to ''
as $function$
declare s public.office_inbox_settings;
begin
  perform private.require_inbox_admin();
  select * into s from public.office_inbox_settings where id = 'office';
  return jsonb_build_object(
    'status', s.status, 'mailbox_address', s.mailbox_address, 'display_name', s.display_name,
    'connected_at', s.connected_at, 'connected_by', private.inbox_name(s.connected_by),
    'last_sync_at', s.last_sync_at, 'last_sync_error', s.last_sync_error, 'last_sync_imported', s.last_sync_imported);
end;
$function$;

-- The thread list. p_assignee: null (anyone), 'me', 'none' or a person's id.
create or replace function public.office_inbox_threads(
  p_status text default null, p_assignee text default null, p_category text default null,
  p_unread_only boolean default false, p_query text default null, p_limit integer default 50, p_offset integer default 0)
returns table (
  id uuid, subject text, counterpart_email text, counterpart_name text, family_id uuid, family_name text,
  status text, category text, assignee_id uuid, assignee_name text, snippet text, message_count integer,
  has_attachments boolean, last_message_at timestamptz, unread boolean)
language plpgsql stable security definer set search_path to ''
as $function$
declare
  v_me uuid := private.require_inbox_admin();
  v_q text := nullif(btrim(coalesce(p_query, '')), '');
  v_like text;
  v_ts tsquery;
  v_assignee uuid;
begin
  if p_assignee is not null and p_assignee not in ('me', 'none') then
    if p_assignee !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then raise exception 'Unknown assignee.'; end if;
    v_assignee := p_assignee::uuid;
  end if;
  if p_status is not null and p_status not in ('new', 'open', 'waiting', 'done', 'active') then raise exception 'Unknown status.'; end if;
  if v_q is not null then
    v_like := '%' || replace(replace(replace(lower(v_q), '\', '\\'), '%', '\%'), '_', '\_') || '%';
    v_ts := websearch_to_tsquery('english'::regconfig, v_q);
  end if;
  return query
  select t.id, t.subject, t.counterpart_email, t.counterpart_name, t.family_id, f.display_name,
    t.status, t.category, t.assignee_id, private.inbox_name(t.assignee_id), t.snippet, t.message_count,
    t.has_attachments, t.last_message_at,
    (t.last_inbound_at is not null and t.last_inbound_at > coalesce(r.read_at, '-infinity'::timestamptz))
  from public.inbox_threads t
  left join public.families f on f.id = t.family_id
  left join public.inbox_thread_reads r on r.thread_id = t.id and r.user_id = v_me
  where (p_status is null or (p_status = 'active' and t.status <> 'done') or t.status = p_status)
    and (p_assignee is null
         or (p_assignee = 'me' and t.assignee_id = v_me)
         or (p_assignee = 'none' and t.assignee_id is null)
         or (v_assignee is not null and t.assignee_id = v_assignee))
    and (p_category is null or t.category = p_category)
    and (not coalesce(p_unread_only, false) or (t.last_inbound_at is not null and t.last_inbound_at > coalesce(r.read_at, '-infinity'::timestamptz)))
    and (v_q is null
         or lower(t.subject) like v_like escape '\'
         or lower(coalesce(t.counterpart_email, '')) like v_like escape '\'
         or lower(coalesce(t.counterpart_name, '')) like v_like escape '\'
         or lower(coalesce(f.display_name, '')) like v_like escape '\'
         or (numnode(v_ts) > 0 and exists (select 1 from public.inbox_messages m where m.thread_id = t.id and m.search @@ v_ts)))
  order by t.last_message_at desc nulls last, t.created_at desc
  limit least(greatest(coalesce(p_limit, 50), 1), 200) offset greatest(coalesce(p_offset, 0), 0);
end;
$function$;

-- Counts for the filter list.
create or replace function public.office_inbox_counts()
returns jsonb
language plpgsql stable security definer set search_path to ''
as $function$
declare v_me uuid := private.require_inbox_admin();
begin
  return (
    select jsonb_build_object(
      'new', count(*) filter (where t.status = 'new'),
      'open', count(*) filter (where t.status = 'open'),
      'waiting', count(*) filter (where t.status = 'waiting'),
      'done', count(*) filter (where t.status = 'done'),
      'mine', count(*) filter (where t.status <> 'done' and t.assignee_id = v_me),
      'unassigned', count(*) filter (where t.status <> 'done' and t.assignee_id is null),
      'unread', count(*) filter (where t.last_inbound_at is not null and t.last_inbound_at > coalesce(r.read_at, '-infinity'::timestamptz)))
    from public.inbox_threads t
    left join public.inbox_thread_reads r on r.thread_id = t.id and r.user_id = v_me);
end;
$function$;

-- One thread: the messages with their attachments, the notes, the history, and where a reply goes.
-- Opening it marks it read for the caller.
create or replace function public.office_inbox_thread(p_thread uuid)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  v_me uuid := private.require_inbox_admin();
  t public.inbox_threads;
begin
  select * into t from public.inbox_threads where id = p_thread;
  if not found then raise exception 'That conversation does not exist.'; end if;
  insert into public.inbox_thread_reads (thread_id, user_id, read_at) values (p_thread, v_me, now())
  on conflict (thread_id, user_id) do update set read_at = excluded.read_at;
  return jsonb_build_object(
    'thread', to_jsonb(t) || jsonb_build_object(
      'assignee_name', private.inbox_name(t.assignee_id),
      'family_name', (select f.display_name from public.families f where f.id = t.family_id),
      'reply_to', private.inbox_reply_target(t.id),
      'mailbox_address', (select s.mailbox_address from public.office_inbox_settings s where s.id = 'office')),
    'messages', coalesce((
      select jsonb_agg(jsonb_build_object(
        'id', m.id, 'direction', m.direction, 'from_address', m.from_address, 'from_name', m.from_name,
        'to_addresses', m.to_addresses, 'cc_addresses', m.cc_addresses, 'subject', m.subject, 'sent_at', m.sent_at,
        'body_text', m.body_text, 'body_html', m.body_html, 'sent_by_name', private.inbox_name(m.sent_by),
        'attachments', coalesce((
          select jsonb_agg(jsonb_build_object('id', a.id, 'filename', a.filename, 'mime_type', a.mime_type,
                                              'size_bytes', a.size_bytes, 'is_inline', a.is_inline, 'stored', a.storage_path is not null)
                           order by a.created_at)
          from public.inbox_attachments a where a.message_id = m.id), '[]'::jsonb))
        order by m.sent_at, m.created_at)
      from public.inbox_messages m where m.thread_id = t.id), '[]'::jsonb),
    'notes', coalesce((
      select jsonb_agg(jsonb_build_object('id', n.id, 'body', n.body, 'author_name', private.inbox_name(n.author_id), 'created_at', n.created_at)
                       order by n.created_at)
      from public.inbox_notes n where n.thread_id = t.id), '[]'::jsonb),
    'events', coalesce((
      select jsonb_agg(jsonb_build_object('kind', e.kind, 'detail', e.detail, 'actor_name', private.inbox_name(e.actor_id), 'created_at', e.created_at)
                       order by e.created_at)
      from public.inbox_events e where e.thread_id = t.id and e.kind in ('status', 'assigned', 'category', 'family_linked', 'reply_failed')), '[]'::jsonb));
end;
$function$;

create or replace function public.office_inbox_mark_unread(p_thread uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_me uuid := private.require_inbox_admin();
begin
  delete from public.inbox_thread_reads where thread_id = p_thread and user_id = v_me;
end;
$function$;

create or replace function public.office_inbox_set_status(p_thread uuid, p_status text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_me uuid := private.require_inbox_admin(); v_old text;
begin
  if p_status is null or p_status not in ('new', 'open', 'waiting', 'done') then raise exception 'Choose a status.'; end if;
  select status into v_old from public.inbox_threads where id = p_thread for update;
  if not found then raise exception 'That conversation does not exist.'; end if;
  if v_old = p_status then return; end if;
  update public.inbox_threads set status = p_status, updated_at = now() where id = p_thread;
  perform private.inbox_log(p_thread, v_me, 'status', jsonb_build_object('from', v_old, 'to', p_status));
end;
$function$;

create or replace function public.office_inbox_assign(p_thread uuid, p_assignee uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_me uuid := private.require_inbox_admin(); v_old uuid;
begin
  if p_assignee is not null and not private.inbox_actor_ok(p_assignee) then
    raise exception 'Conversations can only be assigned to an administrator.';
  end if;
  select assignee_id into v_old from public.inbox_threads where id = p_thread for update;
  if not found then raise exception 'That conversation does not exist.'; end if;
  if v_old is not distinct from p_assignee then return; end if;
  update public.inbox_threads set assignee_id = p_assignee, updated_at = now() where id = p_thread;
  perform private.inbox_log(p_thread, v_me, 'assigned', jsonb_build_object(
    'from', v_old, 'to', p_assignee, 'to_name', private.inbox_name(p_assignee)));
end;
$function$;

create or replace function public.office_inbox_set_category(p_thread uuid, p_category text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_me uuid := private.require_inbox_admin(); v_old text;
begin
  if p_category is null or p_category not in ('general', 'concern', 'reimbursement', 'dues', 'enrollment', 'absence', 'other') then
    raise exception 'Choose a category.';
  end if;
  select category into v_old from public.inbox_threads where id = p_thread for update;
  if not found then raise exception 'That conversation does not exist.'; end if;
  if v_old = p_category then return; end if;
  update public.inbox_threads set category = p_category, updated_at = now() where id = p_thread;
  perform private.inbox_log(p_thread, v_me, 'category', jsonb_build_object('from', v_old, 'to', p_category));
end;
$function$;

-- Link a thread to a household by hand (a sender who is not in the portal), or clear the link.
create or replace function public.office_inbox_link_family(p_thread uuid, p_family uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_me uuid := private.require_inbox_admin(); v_old uuid;
begin
  if p_family is not null and not exists (select 1 from public.families f where f.id = p_family) then
    raise exception 'That family does not exist.';
  end if;
  select family_id into v_old from public.inbox_threads where id = p_thread for update;
  if not found then raise exception 'That conversation does not exist.'; end if;
  update public.inbox_threads set family_id = p_family, family_linked_by_hand = true, updated_at = now() where id = p_thread;
  perform private.inbox_log(p_thread, v_me, 'family_linked', jsonb_build_object('from', v_old, 'to', p_family));
end;
$function$;

create or replace function public.office_inbox_add_note(p_thread uuid, p_body text)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare v_me uuid := private.require_inbox_admin(); v_id uuid;
begin
  if coalesce(btrim(p_body), '') = '' then raise exception 'Write the note first.'; end if;
  if char_length(btrim(p_body)) > 5000 then raise exception 'Keep a note under 5,000 characters.'; end if;
  if not exists (select 1 from public.inbox_threads where id = p_thread) then raise exception 'That conversation does not exist.'; end if;
  insert into public.inbox_notes (thread_id, author_id, body) values (p_thread, v_me, btrim(p_body)) returning id into v_id;
  -- The note's text is not copied into the audit trail.
  perform private.inbox_log(p_thread, v_me, 'note_added', jsonb_build_object('note_id', v_id));
  return v_id;
end;
$function$;

-- Canned replies.
create or replace function public.office_inbox_save_canned(p_id uuid, p_title text, p_body text)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare v_me uuid := private.require_inbox_admin(); v_id uuid;
begin
  if coalesce(btrim(p_title), '') = '' or coalesce(btrim(p_body), '') = '' then raise exception 'Give the reply a title and some text.'; end if;
  if char_length(btrim(p_title)) > 80 then raise exception 'Keep the title under 80 characters.'; end if;
  if char_length(btrim(p_body)) > 5000 then raise exception 'Keep a canned reply under 5,000 characters.'; end if;
  if p_id is null then
    insert into public.inbox_canned_replies (title, body, created_by, updated_by) values (btrim(p_title), btrim(p_body), v_me, v_me) returning id into v_id;
  else
    update public.inbox_canned_replies set title = btrim(p_title), body = btrim(p_body), updated_by = v_me, updated_at = now()
    where id = p_id and not archived returning id into v_id;
    if v_id is null then raise exception 'That canned reply does not exist.'; end if;
  end if;
  perform private.inbox_log(null, v_me, 'canned_saved', jsonb_build_object('canned_id', v_id, 'title', btrim(p_title)));
  return v_id;
end;
$function$;

create or replace function public.office_inbox_archive_canned(p_id uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_me uuid := private.require_inbox_admin();
begin
  update public.inbox_canned_replies set archived = true, updated_by = v_me, updated_at = now() where id = p_id and not archived;
  if not found then raise exception 'That canned reply does not exist.'; end if;
  perform private.inbox_log(null, v_me, 'canned_archived', jsonb_build_object('canned_id', p_id));
end;
$function$;

-- Who a thread can be assigned to.
create or replace function public.office_inbox_admins()
returns table (id uuid, name text)
language plpgsql stable security definer set search_path to ''
as $function$
begin
  perform private.require_inbox_admin();
  return query
  select p.id, coalesce(nullif(btrim(p.display_name), ''), p.email)
  from public.profiles p join public.user_roles r on r.user_id = p.id and r.role = 'admin'
  where p.status = 'active' and not p.is_demo
  order by 2;
end;
$function$;

-- The family context panel. Unmatched senders get { matched: false } and nothing else.
create or replace function public.office_inbox_family_context(p_thread uuid)
returns jsonb
language plpgsql stable security definer set search_path to ''
as $function$
declare
  v_me uuid := private.require_inbox_admin();
  t public.inbox_threads;
  v_year uuid;
begin
  select * into t from public.inbox_threads where id = p_thread;
  if not found then raise exception 'That conversation does not exist.'; end if;
  select y.id into v_year from public.school_years y where y.is_current limit 1;
  return jsonb_build_object(
    'matched', t.family_id is not null,
    'linked_by_hand', t.family_linked_by_hand,
    'sender', jsonb_build_object('email', t.counterpart_email, 'name', t.counterpart_name,
      'portal_account', t.matched_user_id is not null),
    'family', (select jsonb_build_object('id', f.id, 'name', f.display_name) from public.families f where f.id = t.family_id),
    'adults', coalesce((
      select jsonb_agg(jsonb_build_object('name', coalesce(nullif(btrim(p.display_name), ''), p.email), 'email', p.email,
                                          'relationship', fm.relationship, 'status', p.status) order by fm.created_at)
      from public.family_members fm join public.profiles p on p.id = fm.user_id
      where fm.family_id = t.family_id and not p.is_demo), '[]'::jsonb),
    'children', coalesce((
      select jsonb_agg(jsonb_build_object('first_name', c.first_name, 'last_name', coalesce(c.last_name, c.last_initial),
                                          'grade', c.age_band, 'active', c.active) order by c.active desc, c.first_name)
      from public.children c where c.family_id = t.family_id), '[]'::jsonb),
    'forms', coalesce((
      select jsonb_agg(jsonb_build_object('title', rq.title, 'status', fr.status) order by rq.sort_order, rq.title)
      from public.family_requirements fr join public.requirements rq on rq.id = fr.requirement_id
      where fr.family_id = t.family_id and rq.kind = 'document' and rq.active and rq.school_year_id = v_year), '[]'::jsonb),
    'dues', coalesce((
      select jsonb_agg(jsonb_build_object('title', rq.title, 'amount_due_cents', dc.amount_due_cents,
                                          'amount_paid_cents', dc.amount_paid_cents, 'status', dc.status) order by rq.sort_order, rq.title)
      from public.dues_charges dc join public.requirements rq on rq.id = dc.requirement_id
      where dc.family_id = t.family_id and dc.school_year_id = v_year and dc.status <> 'void'), '[]'::jsonb),
    'earlier_threads', coalesce((
      select jsonb_agg(x.j order by x.at desc) from (
        select jsonb_build_object('id', o.id, 'subject', o.subject, 'status', o.status, 'category', o.category,
                                  'last_message_at', o.last_message_at) as j, o.last_message_at as at
        from public.inbox_threads o
        where o.id <> t.id
          and ((t.family_id is not null and o.family_id = t.family_id)
               or (t.counterpart_email is not null and o.counterpart_email = t.counterpart_email))
        order by o.last_message_at desc nulls last limit 10) x), '[]'::jsonb));
end;
$function$;

-- Open a stored attachment: a two-minute grant for the caller, logged. Returns the storage path
-- the browser then asks Storage to sign.
create or replace function public.office_inbox_open_attachment(p_attachment uuid)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare v_me uuid := private.require_inbox_admin(); a public.inbox_attachments;
begin
  select * into a from public.inbox_attachments where id = p_attachment;
  if not found then raise exception 'That attachment does not exist.'; end if;
  if a.storage_path is null then raise exception 'This file was too large to copy. Open it in Gmail.'; end if;
  delete from public.inbox_attachment_grants where expires_at < now() - interval '1 hour';
  insert into public.inbox_attachment_grants (storage_path, admin_id, expires_at) values (a.storage_path, v_me, now() + interval '2 minutes');
  perform private.inbox_log(a.thread_id, v_me, 'attachment_opened', jsonb_build_object('attachment_id', a.id, 'filename', a.filename));
  return jsonb_build_object('bucket', 'office-inbox', 'path', a.storage_path, 'filename', a.filename, 'mime_type', a.mime_type);
end;
$function$;

-- --- what the Edge Functions call (service role only) --------------------------------------------------------
create or replace function public.office_inbox_begin_oauth(p_user uuid, p_state_hash text, p_code_verifier text)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not private.inbox_actor_ok(p_user) then raise exception 'Administrator access is required.' using errcode = '42501'; end if;
  delete from public.office_inbox_oauth_states where expires_at < now() or user_id = p_user;
  insert into public.office_inbox_oauth_states (state_hash, user_id, code_verifier, expires_at)
  values (p_state_hash, p_user, p_code_verifier, now() + interval '10 minutes');
end;
$function$;

-- Used once: the row is removed whether or not it was still valid.
create or replace function public.office_inbox_take_oauth(p_state_hash text)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare r public.office_inbox_oauth_states;
begin
  delete from public.office_inbox_oauth_states where state_hash = p_state_hash returning * into r;
  if r.state_hash is null or r.expires_at < now() or not private.inbox_actor_ok(r.user_id) then return null; end if;
  return jsonb_build_object('user_id', r.user_id, 'code_verifier', r.code_verifier);
end;
$function$;

create or replace function public.office_inbox_save_connection(
  p_user uuid, p_address text, p_refresh_token text, p_label_id text, p_functions_url text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_secret uuid;
begin
  if not private.inbox_actor_ok(p_user) then raise exception 'Administrator access is required.' using errcode = '42501'; end if;
  if coalesce(p_refresh_token, '') = '' then raise exception 'Google did not return a refresh token.'; end if;
  select id into v_secret from vault.secrets where name = 'OFFICE_INBOX_REFRESH_TOKEN';
  if v_secret is null then
    perform vault.create_secret(p_refresh_token, 'OFFICE_INBOX_REFRESH_TOKEN', 'Office inbox: Google refresh token for the office mailbox');
  else
    perform vault.update_secret(v_secret, p_refresh_token);
  end if;
  update public.office_inbox_settings set
    status = 'connected', mailbox_address = lower(btrim(p_address)), gmail_label_id = p_label_id,
    functions_url = p_functions_url, connected_at = now(), connected_by = p_user,
    -- A different mailbox starts over from its own history.
    history_id = case when mailbox_address is not distinct from lower(btrim(p_address)) then history_id else null end,
    last_sync_error = null, sync_lease_until = null, updated_at = now()
  where id = 'office';
  perform private.inbox_log(null, p_user, 'connected', jsonb_build_object('mailbox', lower(btrim(p_address))));
end;
$function$;

create or replace function public.office_inbox_clear_connection(p_user uuid)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  if not private.inbox_actor_ok(p_user) then raise exception 'Administrator access is required.' using errcode = '42501'; end if;
  delete from vault.secrets where name = 'OFFICE_INBOX_REFRESH_TOKEN';
  update public.office_inbox_settings set status = 'disconnected', sync_lease_until = null, updated_at = now() where id = 'office';
  perform private.inbox_log(null, p_user, 'disconnected', jsonb_build_object('mailbox', (select mailbox_address from public.office_inbox_settings where id = 'office')));
end;
$function$;

-- One sync at a time: a run takes a 90-second lease. Returns the settings it needs, or null.
create or replace function public.office_inbox_claim_sync()
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare s public.office_inbox_settings;
begin
  update public.office_inbox_settings set sync_lease_until = now() + interval '90 seconds'
  where id = 'office' and status = 'connected' and (sync_lease_until is null or sync_lease_until < now())
  returning * into s;
  if s.id is null then return null; end if;
  return jsonb_build_object('mailbox_address', s.mailbox_address, 'gmail_label_id', s.gmail_label_id,
                            'history_id', s.history_id, 'backfill_days', s.backfill_days);
end;
$function$;

-- p_history_id null keeps the current one. p_attention marks the connection as needing a reconnect.
create or replace function public.office_inbox_finish_sync(p_history_id text, p_imported integer, p_error text, p_attention boolean, p_reset_history boolean default false)
returns void
language plpgsql security definer set search_path to ''
as $function$
begin
  update public.office_inbox_settings set
    history_id = case when coalesce(p_reset_history, false) then null else coalesce(p_history_id, history_id) end,
    last_sync_at = now(), last_sync_imported = p_imported, last_sync_error = left(p_error, 500),
    status = case when coalesce(p_attention, false) and status = 'connected' then 'attention' else status end,
    sync_lease_until = null, updated_at = now()
  where id = 'office';
end;
$function$;

-- Which of these Gmail message ids are already in the portal.
create or replace function public.office_inbox_known_messages(p_ids text[])
returns text[]
language sql stable security definer set search_path to ''
as $function$
  select coalesce(array_agg(m.gmail_message_id), '{}'::text[]) from public.inbox_messages m where m.gmail_message_id = any (p_ids);
$function$;

-- Import one message. Returns { skipped } or { thread_id, message_id, created }.
create or replace function public.office_inbox_import_message(p jsonb)
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  v_thread public.inbox_threads;
  v_message uuid;
  v_direction text := p->>'direction';
  v_sent_at timestamptz := coalesce((p->>'sent_at')::timestamptz, now());
  v_from text := lower(btrim(coalesce(p->>'from_address', '')));
  v_counterpart text;
  v_match_user uuid;
  v_match_family uuid;
  v_att jsonb;
begin
  if v_direction not in ('inbound', 'outbound') then raise exception 'Unknown direction.'; end if;
  if coalesce(p->>'gmail_message_id', '') = '' or coalesce(p->>'gmail_thread_id', '') = '' then raise exception 'Missing Gmail ids.'; end if;
  if exists (select 1 from public.inbox_messages m where m.gmail_message_id = p->>'gmail_message_id') then
    return jsonb_build_object('skipped', 'known');
  end if;

  select * into v_thread from public.inbox_threads where gmail_thread_id = p->>'gmail_thread_id' for update;
  if not found then
    -- Mail the office sent from Gmail starts no conversation of its own.
    if v_direction = 'outbound' then return jsonb_build_object('skipped', 'outbound_without_thread'); end if;
    v_counterpart := nullif(lower(btrim(coalesce(nullif(p->>'reply_to', ''), v_from))), '');
    select mf.user_id, mf.family_id into v_match_user, v_match_family from private.inbox_match_family(v_counterpart) mf;
    insert into public.inbox_threads (gmail_thread_id, subject, counterpart_email, counterpart_name, family_id, matched_user_id, category)
    values (p->>'gmail_thread_id', left(coalesce(nullif(btrim(p->>'subject'), ''), '(no subject)'), 500), v_counterpart,
            nullif(left(btrim(coalesce(p->>'from_name', '')), 200), ''), v_match_family, v_match_user,
            case when p->>'category' in ('general', 'concern', 'reimbursement', 'dues', 'enrollment', 'absence', 'other') then p->>'category' else 'general' end)
    returning * into v_thread;
  end if;

  insert into public.inbox_messages (thread_id, gmail_message_id, direction, from_address, from_name, reply_to, to_addresses, cc_addresses,
    subject, sent_at, rfc_message_id, in_reply_to, references_header, body_text, body_html, snippet)
  values (v_thread.id, p->>'gmail_message_id', v_direction, nullif(v_from, ''), nullif(left(btrim(coalesce(p->>'from_name', '')), 200), ''),
    nullif(lower(btrim(coalesce(p->>'reply_to', ''))), ''),
    coalesce((select array_agg(lower(x)) from jsonb_array_elements_text(coalesce(p->'to', '[]'::jsonb)) x), '{}'),
    coalesce((select array_agg(lower(x)) from jsonb_array_elements_text(coalesce(p->'cc', '[]'::jsonb)) x), '{}'),
    left(p->>'subject', 500), v_sent_at, left(p->>'rfc_message_id', 500), left(p->>'in_reply_to', 500), left(p->>'references', 4000),
    left(p->>'body_text', 500000), left(p->>'body_html', 1000000), left(p->>'snippet', 300))
  returning id into v_message;

  for v_att in select * from jsonb_array_elements(coalesce(p->'attachments', '[]'::jsonb)) loop
    insert into public.inbox_attachments (message_id, thread_id, filename, mime_type, size_bytes, content_id, is_inline, storage_path)
    values (v_message, v_thread.id, left(coalesce(nullif(btrim(v_att->>'filename'), ''), 'attachment'), 255), left(v_att->>'mime_type', 200),
            (v_att->>'size_bytes')::bigint, left(v_att->>'content_id', 500), coalesce((v_att->>'is_inline')::boolean, false),
            nullif(v_att->>'storage_path', ''));
  end loop;

  update public.inbox_threads set
    message_count = message_count + 1,
    has_attachments = has_attachments or jsonb_array_length(coalesce(p->'attachments', '[]'::jsonb)) > 0,
    last_message_at = greatest(coalesce(last_message_at, v_sent_at), v_sent_at),
    snippet = case when v_sent_at >= coalesce(last_message_at, v_sent_at) then left(p->>'snippet', 300) else snippet end,
    last_inbound_at = case when v_direction = 'inbound' then greatest(coalesce(last_inbound_at, v_sent_at), v_sent_at) else last_inbound_at end,
    -- A family writing again reopens the conversation.
    status = case when v_direction = 'inbound' and status in ('waiting', 'done') then 'open' else status end,
    updated_at = now()
  where id = v_thread.id;
  if v_direction = 'inbound' and v_thread.status in ('waiting', 'done') then
    perform private.inbox_log(v_thread.id, null, 'status', jsonb_build_object('from', v_thread.status, 'to', 'open', 'reason', 'new_mail'));
  end if;

  return jsonb_build_object('thread_id', v_thread.id, 'message_id', v_message, 'created', true);
end;
$function$;

-- Before a reply goes out: check the sender, the limits and the thread; record the attempt.
-- A repeat of the same client_key returns the first attempt instead of sending twice.
create or replace function public.office_inbox_begin_send(p_user uuid, p_thread uuid, p_body text, p_client_key uuid, p_next_status text default 'waiting')
returns jsonb
language plpgsql security definer set search_path to ''
as $function$
declare
  t public.inbox_threads;
  s public.office_inbox_settings;
  v_existing public.inbox_sends;
  v_to text;
  v_last_id text;
  v_last_refs text;
  v_send uuid;
begin
  if not private.inbox_actor_ok(p_user) then raise exception 'Administrator access is required.' using errcode = '42501'; end if;
  if p_client_key is null then raise exception 'Missing send key.'; end if;
  select * into v_existing from public.inbox_sends where client_key = p_client_key;
  if found then
    return jsonb_build_object('duplicate', true, 'send_id', v_existing.id, 'status', v_existing.status);
  end if;
  if coalesce(btrim(p_body), '') = '' then raise exception 'Write the reply first.'; end if;
  if char_length(p_body) > 20000 then raise exception 'Keep a reply under 20,000 characters.'; end if;
  if coalesce(p_next_status, 'waiting') not in ('open', 'waiting', 'done') then raise exception 'Choose a status.'; end if;

  select * into s from public.office_inbox_settings where id = 'office';
  if s.status <> 'connected' or s.mailbox_address is null then raise exception 'The office inbox is not connected.'; end if;
  select * into t from public.inbox_threads where id = p_thread for update;
  if not found then raise exception 'That conversation does not exist.'; end if;
  v_to := private.inbox_reply_target(p_thread);
  if v_to is null or v_to !~ '^[^@\s<>"]+@[^@\s<>"]+\.[^@\s<>"]+$' then raise exception 'There is no address to reply to.'; end if;

  -- Limits: 20 replies an hour per administrator, 60 an hour for the whole office, one per
  -- conversation every 10 seconds (a double click).
  if (select count(*) from public.inbox_sends where sent_by = p_user and created_at > now() - interval '1 hour' and status <> 'failed') >= 20 then
    raise exception 'You have sent 20 replies in the last hour. Wait a little before sending more.';
  end if;
  if (select count(*) from public.inbox_sends where created_at > now() - interval '1 hour' and status <> 'failed') >= 60 then
    raise exception 'The office has sent 60 replies in the last hour. Wait a little before sending more.';
  end if;
  if exists (select 1 from public.inbox_sends where thread_id = p_thread and created_at > now() - interval '10 seconds' and status <> 'failed') then
    raise exception 'A reply to this conversation was sent a moment ago.';
  end if;

  select m.rfc_message_id, m.references_header into v_last_id, v_last_refs
  from public.inbox_messages m where m.thread_id = p_thread and m.rfc_message_id is not null
  order by m.sent_at desc, m.created_at desc limit 1;

  insert into public.inbox_sends (thread_id, sent_by, client_key, to_address, body_text, next_status)
  values (p_thread, p_user, p_client_key, v_to, p_body, coalesce(p_next_status, 'waiting'))
  returning id into v_send;

  return jsonb_build_object(
    'send_id', v_send, 'to', v_to, 'from_address', s.mailbox_address, 'from_name', s.display_name,
    'subject', t.subject, 'gmail_thread_id', t.gmail_thread_id,
    'in_reply_to', v_last_id, 'references', v_last_refs);
end;
$function$;

create or replace function public.office_inbox_finish_send(
  p_send uuid, p_ok boolean, p_gmail_message_id text, p_rfc_message_id text, p_subject text, p_body_html text, p_error text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v public.inbox_sends;
  s public.office_inbox_settings;
  v_old text;
  v_message uuid;
begin
  select * into v from public.inbox_sends where id = p_send for update;
  if not found or v.status <> 'sending' then raise exception 'That reply is not waiting to be recorded.'; end if;
  if not coalesce(p_ok, false) then
    update public.inbox_sends set status = 'failed', error_detail = left(p_error, 500), finished_at = now() where id = p_send;
    perform private.inbox_log(v.thread_id, v.sent_by, 'reply_failed', jsonb_build_object('send_id', p_send, 'to', v.to_address, 'error', left(p_error, 200)));
    return;
  end if;
  select * into s from public.office_inbox_settings where id = 'office';
  update public.inbox_sends set status = 'sent', gmail_message_id = p_gmail_message_id, finished_at = now() where id = p_send;
  insert into public.inbox_messages (thread_id, gmail_message_id, direction, from_address, from_name, to_addresses, subject, sent_at,
                                     rfc_message_id, body_text, body_html, snippet, sent_by)
  values (v.thread_id, p_gmail_message_id, 'outbound', s.mailbox_address, s.display_name, array[v.to_address], left(p_subject, 500), now(),
          left(p_rfc_message_id, 500), v.body_text, p_body_html, left(regexp_replace(v.body_text, '\s+', ' ', 'g'), 200), v.sent_by)
  on conflict (gmail_message_id) do nothing
  returning id into v_message;
  select status into v_old from public.inbox_threads where id = v.thread_id for update;
  update public.inbox_threads set
    status = v.next_status,
    message_count = message_count + case when v_message is null then 0 else 1 end,
    last_message_at = now(), snippet = left(regexp_replace(v.body_text, '\s+', ' ', 'g'), 200), updated_at = now()
  where id = v.thread_id;
  perform private.inbox_log(v.thread_id, v.sent_by, 'reply_sent', jsonb_build_object('send_id', p_send, 'to', v.to_address, 'gmail_message_id', p_gmail_message_id));
  if v_old is distinct from v.next_status then
    perform private.inbox_log(v.thread_id, v.sent_by, 'status', jsonb_build_object('from', v_old, 'to', v.next_status, 'reason', 'reply_sent'));
  end if;
end;
$function$;

-- --- who may call what --------------------------------------------------------------------------------------
do $do$
declare f text;
begin
  foreach f in array array[
    'public.office_inbox_status()',
    'public.office_inbox_threads(text, text, text, boolean, text, integer, integer)',
    'public.office_inbox_counts()',
    'public.office_inbox_thread(uuid)',
    'public.office_inbox_mark_unread(uuid)',
    'public.office_inbox_set_status(uuid, text)',
    'public.office_inbox_assign(uuid, uuid)',
    'public.office_inbox_set_category(uuid, text)',
    'public.office_inbox_link_family(uuid, uuid)',
    'public.office_inbox_add_note(uuid, text)',
    'public.office_inbox_save_canned(uuid, text, text)',
    'public.office_inbox_archive_canned(uuid)',
    'public.office_inbox_admins()',
    'public.office_inbox_family_context(uuid)',
    'public.office_inbox_open_attachment(uuid)']
  loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
  foreach f in array array[
    'public.office_inbox_begin_oauth(uuid, text, text)',
    'public.office_inbox_take_oauth(text)',
    'public.office_inbox_save_connection(uuid, text, text, text, text)',
    'public.office_inbox_clear_connection(uuid)',
    'public.office_inbox_claim_sync()',
    'public.office_inbox_finish_sync(text, integer, text, boolean, boolean)',
    'public.office_inbox_known_messages(text[])',
    'public.office_inbox_import_message(jsonb)',
    'public.office_inbox_begin_send(uuid, uuid, text, uuid, text)',
    'public.office_inbox_finish_send(uuid, boolean, text, text, text, text, text)']
  loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
    execute format('grant execute on function %s to service_role', f);
  end loop;
end;
$do$;

-- --- the poll ------------------------------------------------------------------------------------------------
-- A shared secret for the poll job, made here with a random value (never written down anywhere).
-- The sync function reads it from Vault and refuses any call that does not present it.
do $do$
begin
  if not exists (select 1 from vault.secrets where name = 'OFFICE_INBOX_CRON_SECRET') then
    perform vault.create_secret(replace(gen_random_uuid()::text || gen_random_uuid()::text, '-', ''),
                                'OFFICE_INBOX_CRON_SECRET', 'Office inbox: shared secret between pg_cron and office-inbox-sync');
  end if;
end;
$do$;

-- Every minute, only while the mailbox is connected and no run holds the lease.
select cron.unschedule('office-inbox-sync')
where exists (select 1 from cron.job where jobname = 'office-inbox-sync');

select cron.schedule(
  'office-inbox-sync',
  '* * * * *',
  $$
  select net.http_post(
    url := s.functions_url || '/functions/v1/office-inbox-sync',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-delivery-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'OFFICE_INBOX_CRON_SECRET')
    ),
    body := jsonb_build_object('mode', 'process'),
    timeout_milliseconds := 60000
  )
  from public.office_inbox_settings s
  where s.id = 'office' and s.status = 'connected' and s.functions_url is not null
    and (s.sync_lease_until is null or s.sync_lease_until < now());
  $$
);
