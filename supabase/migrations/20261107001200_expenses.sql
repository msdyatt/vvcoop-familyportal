-- Expense tracking: what the co-op actually spends, with the receipt for each.
-- ---------------------------------------------------------------------------
-- Administrators record an expense (date, amount, category, vendor, note),
-- attach receipts (image or PDF) kept in the private bucket, and read totals
-- next to the dues collected. Records are never silently changed:
--   * an edit writes a new revision with who, when and why; the old values stay;
--   * a mistaken expense is voided (with a reason), never deleted;
--   * a receipt is removed by marking it removed; the file and the row stay, and
--     nobody but the service role can change or delete a receipt file.
-- Browsers read; every change is a SECURITY DEFINER function that checks the
-- caller is an administrator at the right two-factor level. No expense is
-- visible to families, teachers or reviewer (demo) accounts.
-- ---------------------------------------------------------------------------

create table public.expense_categories (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(name) between 1 and 60),
  active boolean not null default true,
  sort_order integer not null default 100,
  created_at timestamptz not null default now()
);

insert into public.expense_categories (name, sort_order) values
  ('Facilities and rent', 10), ('Insurance', 20), ('Curriculum and supplies', 30), ('Teacher stipends', 40),
  ('Events and field trips', 50), ('Technology and software', 60), ('Payment processing fees', 70),
  ('Printing and postage', 80), ('Professional services', 90), ('Other', 100);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  spent_on date not null,
  amount_cents integer not null check (amount_cents > 0 and amount_cents < 100000000),
  category_id uuid not null references public.expense_categories(id) on delete restrict,
  vendor text not null check (char_length(vendor) between 1 and 120),
  note text check (note is null or char_length(note) <= 1000),
  school_year_id uuid references public.school_years(id) on delete set null,
  entered_by uuid references public.profiles(id) on delete set null,
  version integer not null default 1,
  voided_at timestamptz,
  voided_by uuid references public.profiles(id) on delete set null,
  void_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint expenses_void_shape check ((voided_at is null) = (void_reason is null))
);
create index expenses_spent_on_idx on public.expenses (spent_on desc);
create index expenses_category_idx on public.expenses (category_id);

-- Every state the expense has been in, including the first.
create table public.expense_revisions (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete restrict,
  version integer not null,
  spent_on date not null,
  amount_cents integer not null,
  category_id uuid not null references public.expense_categories(id) on delete restrict,
  vendor text not null,
  note text,
  voided boolean not null default false,
  change_note text,
  changed_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  unique (expense_id, version)
);

create table public.expense_receipts (
  id uuid primary key default gen_random_uuid(),
  expense_id uuid not null references public.expenses(id) on delete restrict,
  storage_path text not null unique,
  file_name text not null check (char_length(file_name) between 1 and 200),
  content_type text not null check (content_type in ('image/jpeg', 'image/png', 'image/webp', 'application/pdf')),
  size_bytes integer not null check (size_bytes > 0 and size_bytes <= 20971520),
  uploaded_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  removed_at timestamptz,
  removed_by uuid references public.profiles(id) on delete set null,
  removed_reason text,
  constraint expense_receipts_path check (storage_path like 'expenses/' || expense_id::text || '/%'),
  constraint expense_receipts_removed_shape check ((removed_at is null) = (removed_reason is null))
);
create index expense_receipts_expense_idx on public.expense_receipts (expense_id);

-- Revisions are append-only. The expense and receipt rows move only through the functions below.
create or replace function private.guard_expense_history()
returns trigger language plpgsql set search_path to ''
as $function$
begin
  raise exception 'Expense history is never edited or deleted.' using errcode = '23000';
end;
$function$;
create trigger expense_revisions_append_only before update or delete on public.expense_revisions
  for each row execute function private.guard_expense_history();

create or replace function private.guard_expense_receipts()
returns trigger language plpgsql set search_path to ''
as $function$
begin
  if tg_op = 'DELETE' then raise exception 'Receipts are never deleted. Remove one with a reason instead.' using errcode = '23000'; end if;
  if new.expense_id is distinct from old.expense_id or new.storage_path is distinct from old.storage_path
     or new.file_name is distinct from old.file_name or new.content_type is distinct from old.content_type
     or new.size_bytes is distinct from old.size_bytes or new.created_at is distinct from old.created_at
     or (old.removed_at is not null and new.removed_at is distinct from old.removed_at) then
    raise exception 'A receipt cannot be changed after it is added.' using errcode = '23000';
  end if;
  return new;
end;
$function$;
create trigger expense_receipts_guard before update or delete on public.expense_receipts
  for each row execute function private.guard_expense_receipts();

alter table public.expense_categories enable row level security;
alter table public.expenses enable row level security;
alter table public.expense_revisions enable row level security;
alter table public.expense_receipts enable row level security;

create policy expense_categories_admin_read on public.expense_categories for select to authenticated using (private.has_role('admin'));
create policy expenses_admin_read on public.expenses for select to authenticated using (private.has_role('admin'));
create policy expense_revisions_admin_read on public.expense_revisions for select to authenticated using (private.has_role('admin'));
create policy expense_receipts_admin_read on public.expense_receipts for select to authenticated using (private.has_role('admin'));

do $$
declare t text;
begin
  foreach t in array array['expense_categories', 'expenses', 'expense_revisions', 'expense_receipts'] loop
    execute format('create policy aal2_required on public.%I as restrictive for all to authenticated using (private.aal_satisfied())', t);
    execute format('create policy no_demo_access on public.%I as restrictive for select to authenticated using (not private.is_demo_user())', t);
  end loop;
end $$;

grant select on public.expense_categories, public.expenses, public.expense_revisions, public.expense_receipts to authenticated;

-- The receipt files themselves: administrators upload and read them through the
-- bucket-wide admin policies; this makes sure nobody signed in can replace or
-- delete one afterwards. (The service role is not subject to policies.)
create policy expense_receipts_no_update on storage.objects as restrictive for update to authenticated
  using (bucket_id <> 'family-village-private' or name not like 'expenses/%');
create policy expense_receipts_no_delete on storage.objects as restrictive for delete to authenticated
  using (bucket_id <> 'family-village-private' or name not like 'expenses/%');

-- --- functions ----------------------------------------------------------------------------
create or replace function private.require_expense_admin()
returns uuid language plpgsql stable security definer set search_path to ''
as $function$
declare v uuid := (select auth.uid());
begin
  if v is null or not private.has_role('admin') then raise exception 'Administrator access is required.' using errcode = '42501'; end if;
  if not private.aal_satisfied() then raise exception 'Complete two-factor verification before continuing.' using errcode = '42501'; end if;
  return v;
end;
$function$;

create or replace function public.admin_create_expense(p_spent_on date, p_amount_cents integer, p_category uuid, p_vendor text, p_note text)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_expense_admin();
  v_id uuid;
begin
  if p_spent_on > current_date + 1 then raise exception 'The date is in the future.'; end if;
  if not exists (select 1 from public.expense_categories where id = p_category and active) then raise exception 'Choose a category.'; end if;
  insert into public.expenses (spent_on, amount_cents, category_id, vendor, note, school_year_id, entered_by)
  values (p_spent_on, p_amount_cents, p_category, trim(p_vendor), nullif(trim(coalesce(p_note, '')), ''),
    (select id from public.school_years where starts_on <= p_spent_on and (ends_on is null or ends_on >= p_spent_on) order by starts_on desc nulls last limit 1), v_actor)
  returning id into v_id;
  insert into public.expense_revisions (expense_id, version, spent_on, amount_cents, category_id, vendor, note, change_note, changed_by)
  select id, 1, spent_on, amount_cents, category_id, vendor, note, 'Entered', v_actor from public.expenses where id = v_id;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'expense_created', 'expense', v_id::text, jsonb_build_object('amount_cents', p_amount_cents, 'vendor', trim(p_vendor)));
  return v_id;
end;
$function$;

create or replace function public.admin_update_expense(p_expense uuid, p_spent_on date, p_amount_cents integer, p_category uuid, p_vendor text, p_note text, p_change_note text)
returns integer language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_expense_admin();
  e public.expenses%rowtype;
  v_version integer;
begin
  select * into e from public.expenses where id = p_expense for update;
  if not found then raise exception 'That expense does not exist.'; end if;
  if e.voided_at is not null then raise exception 'A voided expense cannot be edited.'; end if;
  if coalesce(trim(p_change_note), '') = '' then raise exception 'Say why you are changing it.'; end if;
  if not exists (select 1 from public.expense_categories where id = p_category) then raise exception 'Choose a category.'; end if;
  v_version := e.version + 1;
  update public.expenses
  set spent_on = p_spent_on, amount_cents = p_amount_cents, category_id = p_category, vendor = trim(p_vendor),
      note = nullif(trim(coalesce(p_note, '')), ''), version = v_version, updated_at = now(),
      school_year_id = (select id from public.school_years where starts_on <= p_spent_on and (ends_on is null or ends_on >= p_spent_on) order by starts_on desc nulls last limit 1)
  where id = p_expense;
  insert into public.expense_revisions (expense_id, version, spent_on, amount_cents, category_id, vendor, note, change_note, changed_by)
  select id, version, spent_on, amount_cents, category_id, vendor, note, trim(p_change_note), v_actor from public.expenses where id = p_expense;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'expense_updated', 'expense', p_expense::text, jsonb_build_object('version', v_version, 'from_cents', e.amount_cents, 'to_cents', p_amount_cents));
  return v_version;
end;
$function$;

create or replace function public.admin_void_expense(p_expense uuid, p_reason text)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_expense_admin();
  e public.expenses%rowtype;
begin
  select * into e from public.expenses where id = p_expense for update;
  if not found then raise exception 'That expense does not exist.'; end if;
  if e.voided_at is not null then raise exception 'It is already voided.'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'Say why it is being voided.'; end if;
  update public.expenses set voided_at = now(), voided_by = v_actor, void_reason = trim(p_reason), version = version + 1, updated_at = now() where id = p_expense;
  insert into public.expense_revisions (expense_id, version, spent_on, amount_cents, category_id, vendor, note, voided, change_note, changed_by)
  values (p_expense, e.version + 1, e.spent_on, e.amount_cents, e.category_id, e.vendor, e.note, true, 'Voided: ' || trim(p_reason), v_actor);
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'expense_voided', 'expense', p_expense::text, jsonb_build_object('reason', trim(p_reason)));
end;
$function$;

create or replace function public.admin_add_expense_receipt(p_expense uuid, p_path text, p_file_name text, p_content_type text, p_size_bytes integer)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_expense_admin();
  v_id uuid;
begin
  if not exists (select 1 from public.expenses where id = p_expense) then raise exception 'That expense does not exist.'; end if;
  insert into public.expense_receipts (expense_id, storage_path, file_name, content_type, size_bytes, uploaded_by)
  values (p_expense, p_path, left(p_file_name, 200), p_content_type, p_size_bytes, v_actor) returning id into v_id;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'expense_receipt_added', 'expense', p_expense::text, jsonb_build_object('receipt_id', v_id));
  return v_id;
end;
$function$;

create or replace function public.admin_remove_expense_receipt(p_receipt uuid, p_reason text)
returns void language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_expense_admin();
begin
  if coalesce(trim(p_reason), '') = '' then raise exception 'Say why the receipt is being removed.'; end if;
  update public.expense_receipts set removed_at = now(), removed_by = v_actor, removed_reason = trim(p_reason)
  where id = p_receipt and removed_at is null;
  if not found then raise exception 'That receipt does not exist or was already removed.'; end if;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'expense_receipt_removed', 'expense_receipt', p_receipt::text, jsonb_build_object('reason', trim(p_reason)));
end;
$function$;

create or replace function public.admin_add_expense_category(p_name text)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare v_id uuid;
begin
  perform private.require_expense_admin();
  insert into public.expense_categories (name) values (trim(p_name)) returning id into v_id;
  return v_id;
end;
$function$;

-- Money in and money out for a date range, side by side. Dues collected is net
-- of refunds, counts only payments that count right now (private.payment_counts),
-- and comes from the payment ledger, not from the per-family status.
create or replace function public.admin_finance_summary(p_from date, p_to date)
returns jsonb language plpgsql stable security definer set search_path to ''
as $function$
declare
  v_dues integer;
  v_expenses integer;
  v_by_category jsonb;
begin
  perform private.require_expense_admin();
  select coalesce(sum(case when direction = 'charge' then amount_cents else -amount_cents end), 0) into v_dues
  from public.dues_payments
  where status = 'succeeded' and private.payment_counts(livemode)
    and (occurred_at at time zone 'America/Chicago')::date between p_from and p_to;
  select coalesce(sum(amount_cents), 0) into v_expenses from public.expenses where voided_at is null and spent_on between p_from and p_to;
  select coalesce(jsonb_agg(jsonb_build_object('category', c.name, 'cents', x.cents) order by x.cents desc), '[]'::jsonb) into v_by_category
  from (select category_id, sum(amount_cents)::integer as cents from public.expenses where voided_at is null and spent_on between p_from and p_to group by category_id) x
  join public.expense_categories c on c.id = x.category_id;
  return jsonb_build_object('dues_collected_cents', v_dues, 'expenses_cents', v_expenses, 'net_cents', v_dues - v_expenses, 'by_category', v_by_category);
end;
$function$;

revoke all on function private.require_expense_admin() from public, anon, authenticated;
do $$
declare f text;
begin
  foreach f in array array['admin_create_expense(date,integer,uuid,text,text)', 'admin_update_expense(uuid,date,integer,uuid,text,text,text)',
    'admin_void_expense(uuid,text)', 'admin_add_expense_receipt(uuid,text,text,text,integer)', 'admin_remove_expense_receipt(uuid,text)',
    'admin_add_expense_category(text)', 'admin_finance_summary(date,date)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
