-- Year-end tax summary: the numbers and facts an administrator (or the bookkeeper) needs for the
-- IRS annual return. A helper, not tax advice: the IRS rules decide and a tax professional
-- should confirm.
-- ---------------------------------------------------------------------------
-- For one fiscal year (the year that ENDS in the chosen calendar year, using the fiscal year end
-- in compliance_settings), from the portal's own records:
--   * gross receipts: dues collected online (Stripe) and offline (cash, check, Crowded, other),
--     plus "other income" an administrator enters by hand (donations, fundraisers, grants);
--   * refunds, shown separately (the form test uses gross receipts before refunds, which is the
--     cautious reading; the tax professional can say whether to subtract them);
--   * expenses by category, and the net;
--   * the gross receipts of the two years before, for the 3-year average behind the 990-N
--     "normally $50,000 or less" test. Years before the portal can be entered by hand;
--   * total assets at year end (entered by hand) for the 990-EZ test;
--   * payees paid the 1099-NEC threshold or more in the calendar year (from expenses.vendor);
--   * the key facts the 990-N asks for, from the records vault (the EIN masked).
-- Which form probably applies is worked out in the browser (lib/tax-form-choice.ts) so the
-- arithmetic can be shown step by step and unit-tested.
--
-- Payments count the same way as everywhere else in billing (private.payment_counts): real
-- money only, or test-mode money while billing itself is in test mode. Reviewer (demo) families
-- are always left out.
-- ---------------------------------------------------------------------------

-- --- key facts the 990-N asks for -----------------------------------------------------------------
insert into public.org_facts (key, label, sensitive, sort_order) values
  ('website', 'Website', false, 35),
  ('principal_officer_name', 'Principal officer (name)', false, 36),
  ('principal_officer_address', 'Principal officer (address)', false, 37),
  ('year_formed', 'First tax year (year formed)', false, 45)
on conflict (key) do nothing;
update public.org_facts set label = 'Mailing address' where key = 'address' and label = 'Address';

-- --- other income, entered by hand ----------------------------------------------------------------
create table public.tax_other_income (
  id uuid primary key default gen_random_uuid(),
  received_on date not null,
  amount_cents bigint not null check (amount_cents > 0 and amount_cents < 100000000000),
  kind text not null check (kind in ('donation', 'fundraiser', 'grant', 'other')),
  description text not null check (char_length(description) between 1 and 200),
  note text check (note is null or char_length(note) <= 1000),
  voided_at timestamptz,
  void_reason text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  voided_by uuid references public.profiles(id) on delete set null,
  constraint tax_other_income_void_shape check ((voided_at is null) = (void_reason is null))
);
create index tax_other_income_received_idx on public.tax_other_income (received_on);

-- --- per-year figures entered by hand -------------------------------------------------------------
create table public.tax_year_inputs (
  year_end date primary key,
  total_assets_cents bigint check (total_assets_cents is null or (total_assets_cents >= 0 and total_assets_cents < 100000000000)),
  -- For a year the portal has no (or incomplete) records of: the gross receipts to use instead.
  gross_receipts_override_cents bigint check (gross_receipts_override_cents is null or (gross_receipts_override_cents >= 0 and gross_receipts_override_cents < 100000000000)),
  note text check (note is null or char_length(note) <= 1000),
  updated_at timestamptz not null default now(),
  updated_by uuid references public.profiles(id) on delete set null
);

do $$
declare t text;
begin
  foreach t in array array['tax_other_income', 'tax_year_inputs'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.has_role(''admin''))', t || '_admin_read', t);
    execute format('create policy aal2_required on public.%I as restrictive for all to authenticated using (private.aal_satisfied())', t);
    execute format('create policy no_demo_access on public.%I as restrictive for select to authenticated using (not private.is_demo_user())', t);
    execute format('revoke all on public.%I from public, anon, authenticated', t);
    execute format('grant select on public.%I to authenticated', t);
  end loop;
end $$;

-- --- the fiscal year ---------------------------------------------------------------------------------
-- The fiscal year ending in p_year: (first day, last day).
create or replace function private.tax_year_bounds(p_year integer, out first_day date, out last_day date)
language sql stable security definer set search_path to ''
as $function$
  select private.fiscal_year_end(s.fiscal_year_end_month, p_year - 1) + 1, private.fiscal_year_end(s.fiscal_year_end_month, p_year)
  from public.compliance_settings s where s.id = 'org';
$function$;

-- A family is a reviewer (demo) family if any member is a reviewer account.
create or replace function private.is_demo_family(p_family uuid)
returns boolean
language sql stable security definer set search_path to ''
as $function$
  select exists (select 1 from public.family_members fm join public.profiles p on p.id = fm.user_id where fm.family_id = p_family and p.is_demo);
$function$;

-- Gross receipts the portal knows of for a date range: dues collected plus other income.
create or replace function private.portal_gross_receipts(p_from date, p_to date)
returns bigint
language sql stable security definer set search_path to ''
as $function$
  select coalesce((select sum(d.amount_cents) from public.dues_payments d
                   where d.direction = 'charge' and d.status = 'succeeded' and private.payment_counts(d.livemode)
                     and (coalesce(d.occurred_at, d.created_at) at time zone 'America/Chicago')::date between p_from and p_to
                     and not private.is_demo_family(d.family_id)), 0)
       + coalesce((select sum(o.amount_cents) from public.tax_other_income o
                   where o.voided_at is null and o.received_on between p_from and p_to), 0);
$function$;

-- The 1099-NEC threshold for payments made in a calendar year, in cents, and whether it is
-- a figure this code knows for certain (after 2026 the IRS adjusts it for inflation).
create or replace function private.nec_threshold(p_year integer, out cents bigint, out certain boolean)
language sql immutable set search_path to ''
as $function$
  select case when p_year <= 2025 then 60000::bigint else 200000::bigint end, p_year <= 2026;
$function$;

-- --- the summary -------------------------------------------------------------------------------------
create or replace function public.admin_tax_summary(p_year integer)
returns jsonb
language plpgsql stable security definer set search_path to ''
as $function$
declare
  v_first date; v_last date;
  v_online bigint; v_offline bigint; v_refunds bigint; v_other jsonb; v_other_total bigint;
  v_expenses jsonb; v_expense_total bigint;
  v_years jsonb; v_payees jsonb; v_facts jsonb; v_inputs public.tax_year_inputs;
  v_threshold record;
  v_month integer;
begin
  perform private.require_records_admin();
  if p_year is null or p_year not between 2000 and 2100 then raise exception 'Choose a tax year.'; end if;
  select b.first_day, b.last_day into v_first, v_last from private.tax_year_bounds(p_year) b;
  select fiscal_year_end_month into v_month from public.compliance_settings where id = 'org';

  with pay as (
    select d.direction, d.amount_cents, d.source
    from public.dues_payments d
    where d.status = 'succeeded' and private.payment_counts(d.livemode)
      and (coalesce(d.occurred_at, d.created_at) at time zone 'America/Chicago')::date between v_first and v_last
      and not private.is_demo_family(d.family_id))
  select coalesce(sum(amount_cents) filter (where direction = 'charge' and source not in ('admin_manual', 'migration_import')), 0),
         coalesce(sum(amount_cents) filter (where direction = 'charge' and source in ('admin_manual', 'migration_import')), 0),
         coalesce(sum(amount_cents) filter (where direction = 'refund'), 0)
  into v_online, v_offline, v_refunds from pay;

  select coalesce(jsonb_agg(jsonb_build_object('id', o.id, 'received_on', o.received_on, 'amount_cents', o.amount_cents, 'kind', o.kind,
                                               'description', o.description, 'note', o.note) order by o.received_on, o.created_at), '[]'::jsonb),
         coalesce(sum(o.amount_cents), 0)
  into v_other, v_other_total
  from public.tax_other_income o where o.voided_at is null and o.received_on between v_first and v_last;

  select coalesce(jsonb_agg(jsonb_build_object('category', x.name, 'cents', x.cents, 'count', x.n) order by x.cents desc, x.name), '[]'::jsonb),
         coalesce(sum(x.cents), 0)
  into v_expenses, v_expense_total
  from (select c.name, sum(e.amount_cents)::bigint as cents, count(*)::int as n
        from public.expenses e join public.expense_categories c on c.id = e.category_id
        where e.voided_at is null and e.spent_on between v_first and v_last group by c.name) x;

  -- This year and the two before, for the 3-year average.
  select jsonb_agg(jsonb_build_object(
           'year', y.y, 'first_day', b.first_day, 'last_day', b.last_day,
           'portal_cents', private.portal_gross_receipts(b.first_day, b.last_day),
           'override_cents', i.gross_receipts_override_cents,
           'used_cents', coalesce(i.gross_receipts_override_cents, private.portal_gross_receipts(b.first_day, b.last_day)),
           'has_portal_records', exists (select 1 from public.dues_payments d where (coalesce(d.occurred_at, d.created_at) at time zone 'America/Chicago')::date between b.first_day and b.last_day)
                                 or exists (select 1 from public.tax_other_income o where o.received_on between b.first_day and b.last_day))
         order by y.y desc)
  into v_years
  from generate_series(p_year - 2, p_year) as y(y)
  cross join lateral private.tax_year_bounds(y.y) b
  left join public.tax_year_inputs i on i.year_end = b.last_day;

  select * into v_inputs from public.tax_year_inputs where year_end = v_last;

  -- Payees for the CALENDAR year p_year (1099-NEC is always calendar-year based).
  select * into v_threshold from private.nec_threshold(p_year);
  select coalesce(jsonb_agg(jsonb_build_object('payee', p.vendor, 'cents', p.cents, 'count', p.n, 'categories', p.categories) order by p.cents desc), '[]'::jsonb)
  into v_payees
  -- The payee's name as first entered (by date), so the choice does not depend on collation.
  from (select (array_agg(btrim(e.vendor) order by e.spent_on, e.created_at, e.id))[1] as vendor, sum(e.amount_cents)::bigint as cents, count(*)::int as n,
               array_agg(distinct c.name order by c.name) as categories
        from public.expenses e join public.expense_categories c on c.id = e.category_id
        where e.voided_at is null and e.spent_on between make_date(p_year, 1, 1) and make_date(p_year, 12, 31)
        group by lower(btrim(e.vendor))
        having sum(e.amount_cents) >= v_threshold.cents) p;

  select coalesce(jsonb_object_agg(f.key, jsonb_build_object('label', f.label,
           'value', case when f.sensitive then private.mask_fact(f.value) else f.value end,
           'has_value', f.value is not null and f.value <> '', 'sensitive', f.sensitive)), '{}'::jsonb)
  into v_facts
  from public.org_facts f
  where f.key in ('legal_name', 'ein', 'address', 'website', 'principal_officer_name', 'principal_officer_address', 'year_formed');

  -- The EIN comes back masked. Revealing it is admin_reveal_org_fact, which writes the audit entry.
  return jsonb_build_object(
    'tax_year', p_year, 'first_day', v_first, 'last_day', v_last, 'fiscal_year_end_month', v_month,
    'billing_test_mode', private.billing_provider() = 'stripe_test',
    'dues_online_cents', v_online, 'dues_offline_cents', v_offline, 'refunds_cents', v_refunds,
    'other_income', v_other, 'other_income_cents', v_other_total,
    'gross_receipts_cents', v_online + v_offline + v_other_total,
    'expenses', v_expenses, 'expenses_cents', v_expense_total,
    'net_cents', v_online + v_offline + v_other_total - v_refunds - v_expense_total,
    'years', v_years,
    'total_assets_cents', v_inputs.total_assets_cents, 'inputs_note', v_inputs.note,
    'nec_threshold_cents', v_threshold.cents, 'nec_threshold_certain', v_threshold.certain, 'payees', v_payees,
    'facts', v_facts);
end;
$function$;

-- --- changes ---------------------------------------------------------------------------------------
create or replace function public.admin_add_other_income(p_received_on date, p_amount_cents bigint, p_kind text, p_description text, p_note text)
returns uuid
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  v_id uuid;
begin
  if p_received_on is null then raise exception 'Enter the date it was received.'; end if;
  if p_received_on > (now() at time zone 'America/Chicago')::date + 1 then raise exception 'The date cannot be in the future.'; end if;
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Enter the amount.'; end if;
  if p_kind is null or p_kind not in ('donation', 'fundraiser', 'grant', 'other') then raise exception 'Choose what kind of income it is.'; end if;
  if coalesce(btrim(p_description), '') = '' then raise exception 'Say what it was (for example, "Spring bake sale").'; end if;
  insert into public.tax_other_income (received_on, amount_cents, kind, description, note, created_by)
  values (p_received_on, p_amount_cents, p_kind, left(btrim(p_description), 200), nullif(left(btrim(coalesce(p_note, '')), 1000), ''), v_actor)
  returning id into v_id;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'other_income_added', 'tax_other_income', v_id::text, jsonb_build_object('kind', p_kind, 'amount_cents', p_amount_cents, 'received_on', p_received_on));
  return v_id;
end;
$function$;

create or replace function public.admin_void_other_income(p_id uuid, p_reason text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_records_admin();
begin
  if coalesce(btrim(p_reason), '') = '' then raise exception 'Say why it is being voided.'; end if;
  update public.tax_other_income set voided_at = now(), void_reason = left(btrim(p_reason), 500), voided_by = v_actor
  where id = p_id and voided_at is null;
  if not found then raise exception 'That entry does not exist or is already voided.'; end if;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'other_income_voided', 'tax_other_income', p_id::text, jsonb_build_object('reason', left(btrim(p_reason), 500)));
end;
$function$;

create or replace function public.admin_set_tax_year_inputs(p_year integer, p_total_assets_cents bigint, p_gross_receipts_override_cents bigint, p_note text)
returns void
language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_records_admin();
  v_last date;
begin
  if p_year is null or p_year not between 2000 and 2100 then raise exception 'Choose a tax year.'; end if;
  if coalesce(p_total_assets_cents, 0) < 0 or coalesce(p_gross_receipts_override_cents, 0) < 0 then raise exception 'Amounts cannot be negative.'; end if;
  select b.last_day into v_last from private.tax_year_bounds(p_year) b;
  insert into public.tax_year_inputs (year_end, total_assets_cents, gross_receipts_override_cents, note, updated_by)
  values (v_last, p_total_assets_cents, p_gross_receipts_override_cents, nullif(left(btrim(coalesce(p_note, '')), 1000), ''), v_actor)
  on conflict (year_end) do update set total_assets_cents = excluded.total_assets_cents,
    gross_receipts_override_cents = excluded.gross_receipts_override_cents, note = excluded.note, updated_at = now(), updated_by = v_actor;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (v_actor, 'tax_year_inputs_set', 'tax_year', v_last::text,
    jsonb_build_object('total_assets_cents', p_total_assets_cents, 'gross_receipts_override_cents', p_gross_receipts_override_cents));
end;
$function$;

-- --- access -----------------------------------------------------------------------------------------
do $$
declare f text;
begin
  foreach f in array array['private.tax_year_bounds(integer)', 'private.is_demo_family(uuid)', 'private.portal_gross_receipts(date,date)', 'private.nec_threshold(integer)'] loop
    execute format('revoke all on function %s from public, anon, authenticated', f);
  end loop;
  foreach f in array array['admin_tax_summary(integer)', 'admin_add_other_income(date,bigint,text,text,text)',
    'admin_void_other_income(uuid,text)', 'admin_set_tax_year_inputs(integer,bigint,bigint,text)'] loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;
end $$;
