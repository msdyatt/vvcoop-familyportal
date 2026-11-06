-- Dues payments: the ledger, payment plans and the rules around them.
-- ---------------------------------------------------------------------------
-- Today dues are tracked, not collected (requirements / family_requirements).
-- This adds the money side beside them, designed for Stripe (docs/stripe-dues-
-- migration-design.md) but with no Stripe call in here: every rule is SQL, so
-- it holds no matter which client or edge function asks.
--
--   * Amounts are integer cents. Card and bank details never reach this
--     database; only Stripe ids and a brand / last four for a recognisable
--     label are stored.
--   * Browsers read, they never write money tables. Every change goes through
--     a SECURITY DEFINER function: admin functions check the caller's role and
--     two-factor level, service-role functions are for the edge functions.
--   * Paid totals are never typed in. dues_charges.amount_paid_cents is derived
--     from the payment ledger by private.recompute_charge(), and the ledger is
--     written only by the Stripe webhook path and a few admin actions.
--   * The payment ledger is append-only: rows are never deleted, never change
--     amount / family / direction, and status only moves forward (pending ->
--     processing -> succeeded -> failed for a late ACH return). Mistakes are
--     fixed with adjustments or refund rows, never by editing.
--   * Records the co-op must keep are not cascaded away. Deleting a household
--     with billing records is refused for an administrator, and kept (renamed
--     "Former household") when the cause is a member erasing their account.
--   * Live billing needs billing_approvals: an approved row by a human admin
--     who is not the requester. Test mode needs nothing.
-- ---------------------------------------------------------------------------

alter table public.families add column if not exists records_retained_at timestamptz;

-- --- settings -----------------------------------------------------------------
create table public.billing_settings (
  id text primary key default 'dues' check (id = 'dues'),
  provider text not null default 'off' check (provider in ('off', 'stripe_test', 'stripe_live')),
  live_approval_id uuid,
  reminder_days_before integer not null default 3 check (reminder_days_before between 0 and 14),
  retry_after_days integer not null default 3 check (retry_after_days between 1 and 14),
  max_attempts integer not null default 3 check (max_attempts between 1 and 6),
  -- Printed on receipts. The legal name and EIN are the co-op's to fill in.
  receipt_org_name text not null default 'Veritas Village',
  receipt_ein text check (receipt_ein is null or char_length(receipt_ein) <= 20),
  receipt_address text check (receipt_address is null or char_length(receipt_address) <= 300),
  receipt_note text check (receipt_note is null or char_length(receipt_note) <= 500),
  updated_by uuid references public.profiles(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint billing_live_needs_approval check (provider <> 'stripe_live' or live_approval_id is not null)
);
insert into public.billing_settings (id) values ('dues');

-- --- approvals ----------------------------------------------------------------
create table public.billing_approvals (
  id uuid primary key default gen_random_uuid(),
  action text not null check (action in ('enable_livemode', 'refund', 'offline_refund')),
  target_type text,
  target_id uuid,
  amount_cents integer check (amount_cents is null or amount_cents >= 0),
  requested_by uuid references public.profiles(id) on delete set null,
  request_note text check (request_note is null or char_length(request_note) <= 500),
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'consumed')),
  approved_by uuid references public.profiles(id) on delete set null,
  decision_note text check (decision_note is null or char_length(decision_note) <= 500),
  decided_at timestamptz,
  expires_at timestamptz not null default now() + interval '30 minutes',
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  -- The person who asks can never be the person who approves.
  constraint billing_approvals_two_people check (approved_by is null or approved_by is distinct from requested_by),
  constraint billing_approvals_decided check ((status in ('approved', 'rejected', 'consumed')) = (decided_at is not null))
);
create index billing_approvals_open_idx on public.billing_approvals (created_at desc) where status in ('pending', 'approved');

alter table public.billing_settings
  add constraint billing_settings_live_approval_fk foreign key (live_approval_id) references public.billing_approvals(id) on delete restrict;

-- --- Stripe customers (one per household per mode) ----------------------------
create table public.billing_customers (
  id uuid primary key default gen_random_uuid(),
  family_id uuid not null references public.families(id) on delete restrict,
  livemode boolean not null,
  stripe_customer_id text not null unique,
  -- Display only. No card number, no bank account number, ever.
  stripe_payment_method_id text,
  default_pm_type text,
  default_pm_brand text,
  default_pm_last4 text check (default_pm_last4 is null or default_pm_last4 ~ '^[0-9]{4}$'),
  default_pm_bank_name text,
  mandate_id text,
  autopay boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (family_id, livemode)
);

-- --- charges -------------------------------------------------------------------
create table public.dues_charges (
  id uuid primary key default gen_random_uuid(),
  requirement_id uuid not null references public.requirements(id) on delete restrict,
  family_id uuid not null references public.families(id) on delete restrict,
  school_year_id uuid not null references public.school_years(id) on delete restrict,
  currency text not null default 'usd' check (currency = 'usd'),
  subtotal_cents integer not null check (subtotal_cents >= 0),
  discount_total_cents integer not null default 0 check (discount_total_cents >= 0),
  adjustment_total_cents integer not null default 0,
  amount_due_cents integer generated always as (greatest(subtotal_cents - discount_total_cents + adjustment_total_cents, 0)) stored,
  -- Derived from the payment ledger by private.recompute_charge(); never typed.
  amount_paid_cents integer not null default 0,
  amount_refunded_cents integer not null default 0,
  status text not null default 'open' check (status in ('open', 'partially_paid', 'paid', 'void', 'uncollectible')),
  void_reason text,
  external_ref text unique,
  opened_by uuid references public.profiles(id) on delete set null,
  closed_by uuid references public.profiles(id) on delete set null,
  disputed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (requirement_id, family_id)
);
create index dues_charges_family_idx on public.dues_charges (family_id);
create index dues_charges_year_idx on public.dues_charges (school_year_id);

-- What an administrator turns on for a dues requirement.
create table public.dues_requirement_options (
  requirement_id uuid primary key references public.requirements(id) on delete cascade,
  monthly_enabled boolean not null default false,
  monthly_count integer not null default 9 check (monthly_count between 2 and 12),
  monthly_first_due_on date,
  updated_at timestamptz not null default now()
);

-- --- discounts and adjustments (append-only) --------------------------------------
create table public.dues_discount_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z0-9_]{2,40}$'),
  label text not null check (char_length(label) between 1 and 80),
  kind text not null check (kind in ('percent', 'fixed')),
  value integer not null check (value > 0),   -- basis points for percent, cents for fixed
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint dues_discount_percent_max check (kind <> 'percent' or value <= 10000)
);

create table public.dues_discount_lines (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid not null references public.dues_charges(id) on delete restrict,
  discount_type_id uuid references public.dues_discount_types(id) on delete set null,
  label text not null check (char_length(label) between 1 and 80),
  amount_cents integer not null check (amount_cents > 0),
  note text,
  applied_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index dues_discount_lines_charge_idx on public.dues_discount_lines (charge_id);

create table public.dues_adjustments (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid not null references public.dues_charges(id) on delete restrict,
  -- Positive raises what is owed, negative is a credit.
  amount_cents integer not null check (amount_cents <> 0),
  reason text not null check (reason in ('correction', 'late_fee', 'goodwill_credit', 'hardship', 'refund_credit', 'other')),
  -- Shown to the family on their balance, so it is written for them.
  memo text not null check (char_length(memo) between 1 and 300),
  reverses_adjustment_id uuid unique references public.dues_adjustments(id),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index dues_adjustments_charge_idx on public.dues_adjustments (charge_id);

-- --- payment plans -------------------------------------------------------------------
create table public.dues_payment_plans (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid not null references public.dues_charges(id) on delete restrict,
  kind text not null check (kind in ('full', 'monthly', 'custom')),
  -- What had already been paid when the plan was made. The installments split
  -- the rest, so paid-ness is "money paid so far beyond this, in due-date order".
  paid_before_cents integer not null default 0 check (paid_before_cents >= 0),
  status text not null default 'active' check (status in ('active', 'completed', 'cancelled')),
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index dues_payment_plans_one_open on public.dues_payment_plans (charge_id) where status in ('active', 'completed');

create table public.dues_installments (
  id uuid primary key default gen_random_uuid(),
  plan_id uuid not null references public.dues_payment_plans(id) on delete restrict,
  charge_id uuid not null references public.dues_charges(id) on delete restrict,
  seq integer not null check (seq > 0),
  due_on date not null,
  amount_cents integer not null check (amount_cents > 0),
  status text not null default 'scheduled' check (status in ('scheduled', 'paid', 'cancelled')),
  paid_at timestamptz,
  attempts integer not null default 0,
  last_attempt_at timestamptz,
  next_attempt_on date,
  needs_attention boolean not null default false,
  unique (plan_id, seq)
);
create index dues_installments_due_idx on public.dues_installments (due_on) where status = 'scheduled';
create index dues_installments_charge_idx on public.dues_installments (charge_id);

-- --- the payment ledger ------------------------------------------------------------------
create sequence public.dues_receipt_seq;

create table public.dues_payments (
  id uuid primary key default gen_random_uuid(),
  charge_id uuid references public.dues_charges(id) on delete restrict,
  family_id uuid not null references public.families(id) on delete restrict,
  installment_id uuid references public.dues_installments(id) on delete restrict,
  direction text not null check (direction in ('charge', 'refund')),
  amount_cents integer not null check (amount_cents > 0),
  method text check (method in ('card', 'us_bank_account', 'cash', 'check', 'crowded', 'other')),
  wallet text check (wallet in ('apple_pay', 'google_pay', 'link', 'other')),
  brand text,
  last4 text check (last4 is null or last4 ~ '^[0-9]{4}$'),
  bank_name text,
  status text not null default 'pending' check (status in ('pending', 'processing', 'succeeded', 'failed', 'canceled')),
  source text not null check (source in ('portal', 'autopay', 'admin_manual', 'migration_import', 'stripe_dashboard')),
  -- False for test-mode Stripe activity. Offline and imported rows are real money.
  livemode boolean not null,
  -- Sent to Stripe as the Idempotency-Key, so a retry returns the original object.
  idempotency_key text generated always as (case when direction = 'refund' then 'ref_' else 'pay_' end || id::text) stored unique,
  external_ref text unique,
  refunds_payment_id uuid references public.dues_payments(id),
  saved_for_autopay boolean not null default false,
  stripe_checkout_session_id text unique,
  stripe_payment_intent_id text,
  stripe_charge_id text,
  stripe_refund_id text unique,
  stripe_event_id text,
  receipt_url text,
  receipt_no bigint unique,
  failure_code text,
  failure_message text,
  reason text,
  note text,
  initiated_by uuid references public.profiles(id) on delete set null,
  approval_id uuid references public.billing_approvals(id) on delete set null,
  occurred_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint dues_payments_refund_shape check ((direction = 'refund') = (refunds_payment_id is not null))
);
create index dues_payments_charge_idx on public.dues_payments (charge_id);
create index dues_payments_family_idx on public.dues_payments (family_id, created_at desc);
create index dues_payments_pi_idx on public.dues_payments (stripe_payment_intent_id) where stripe_payment_intent_id is not null;
create index dues_payments_stripe_charge_idx on public.dues_payments (stripe_charge_id) where stripe_charge_id is not null;
-- At most one payment attempt in flight per charge: a double click or a
-- refresh cannot open a second one.
create unique index dues_payments_one_open_per_charge on public.dues_payments (charge_id)
  where direction = 'charge' and status in ('pending', 'processing') and charge_id is not null;

create table public.dues_reminder_log (
  installment_id uuid not null references public.dues_installments(id) on delete cascade,
  kind text not null check (kind in ('upcoming', 'overdue')),
  sent_at timestamptz not null default now(),
  primary key (installment_id, kind)
);

-- --- Stripe's events, received once -------------------------------------------------------
create table public.stripe_webhook_events (
  id text primary key,                       -- Stripe's event id
  type text not null,
  livemode boolean not null,
  payload jsonb,                             -- nulled after 90 days; see billing_prune_webhook_events
  received_at timestamptz not null default now(),
  processed_at timestamptz,
  process_error text,
  attempts integer not null default 1
);
create index stripe_webhook_events_unprocessed_idx on public.stripe_webhook_events (received_at) where processed_at is null;

-- --- append-only guards ---------------------------------------------------------------------
-- A test-mode purge is the one sanctioned deletion; it sets this switch for the
-- length of its own transaction and only ever touches rows marked test.
create or replace function private.ledger_purge_allowed()
returns boolean language sql stable set search_path to ''
as $$ select coalesce(current_setting('vv.purge_test_billing', true), '') = 'on'; $$;

create or replace function private.guard_payment_ledger()
returns trigger language plpgsql set search_path to ''
as $function$
begin
  if tg_op = 'DELETE' then
    if private.ledger_purge_allowed() and not old.livemode then return old; end if;
    raise exception 'Payment records are never deleted. Record a refund or an adjustment instead.' using errcode = '23000';
  end if;

  if new.id is distinct from old.id or new.charge_id is distinct from old.charge_id
     or new.family_id is distinct from old.family_id or new.direction is distinct from old.direction
     or new.amount_cents is distinct from old.amount_cents or new.source is distinct from old.source
     or new.livemode is distinct from old.livemode or new.refunds_payment_id is distinct from old.refunds_payment_id
     or new.created_at is distinct from old.created_at
     or new.initiated_by is distinct from old.initiated_by and old.initiated_by is not null and new.initiated_by is not null then
    raise exception 'A payment record cannot be changed after it is written. Record a refund or an adjustment instead.' using errcode = '23000';
  end if;

  if new.status is distinct from old.status and not (
       (old.status = 'pending' and new.status in ('processing', 'succeeded', 'failed', 'canceled'))
    or (old.status = 'processing' and new.status in ('succeeded', 'failed', 'canceled'))
    or (old.status = 'succeeded' and new.status = 'failed')) then
    raise exception 'A % payment cannot become %.', old.status, new.status using errcode = '23000';
  end if;

  new.updated_at := now();
  return new;
end;
$function$;

create trigger dues_payments_guard before update or delete on public.dues_payments
  for each row execute function private.guard_payment_ledger();

create or replace function private.guard_append_only()
returns trigger language plpgsql set search_path to ''
as $function$
begin
  if tg_op = 'DELETE' and private.ledger_purge_allowed() then return old; end if;
  raise exception '% records are never edited or deleted. Add a reversing entry instead.', tg_table_name using errcode = '23000';
end;
$function$;

create trigger dues_adjustments_append_only before update or delete on public.dues_adjustments
  for each row execute function private.guard_append_only();
create trigger dues_discount_lines_append_only before update or delete on public.dues_discount_lines
  for each row execute function private.guard_append_only();

create trigger billing_customers_touch before update on public.billing_customers
  for each row execute function public.touch_updated_at();
create trigger dues_charges_touch before update on public.dues_charges
  for each row execute function public.touch_updated_at();

-- --- keeping the records of a household that goes away ---------------------------------------
-- The foreign keys above refuse to cascade. This turns that refusal into the
-- rule the co-op wants: an administrator who deletes a household that has
-- billing records is told no; a member erasing their own account (the service
-- role, with no signed-in user) gets the household's personal data removed
-- while the household row, renamed, stays so the payments keep their owner.
create or replace function private.retain_household_billing_records()
returns trigger language plpgsql security definer set search_path to ''
as $function$
declare
  v_has_records boolean;
  v_demo boolean;
begin
  v_has_records := exists (select 1 from public.dues_charges where family_id = old.id)
    or exists (select 1 from public.dues_payments where family_id = old.id)
    or exists (select 1 from public.billing_customers where family_id = old.id);
  if not v_has_records then return old; end if;

  v_demo := exists (select 1 from public.family_members fm join public.profiles p on p.id = fm.user_id
    where fm.family_id = old.id and p.is_demo);
  if v_demo then
    -- Reviewer accounts hold sample money only; it is cleared with the sample world.
    perform set_config('vv.purge_test_billing', 'on', true);
    delete from public.dues_reminder_log where installment_id in (select id from public.dues_installments where charge_id in (select id from public.dues_charges where family_id = old.id));
    delete from public.dues_payments where family_id = old.id and direction = 'refund';
    delete from public.dues_payments where family_id = old.id;
    delete from public.dues_installments where charge_id in (select id from public.dues_charges where family_id = old.id);
    delete from public.dues_payment_plans where charge_id in (select id from public.dues_charges where family_id = old.id);
    delete from public.dues_adjustments where charge_id in (select id from public.dues_charges where family_id = old.id);
    delete from public.dues_discount_lines where charge_id in (select id from public.dues_charges where family_id = old.id);
    delete from public.dues_charges where family_id = old.id;
    delete from public.billing_customers where family_id = old.id;
    perform set_config('vv.purge_test_billing', 'off', true);
    return old;
  end if;

  if (select auth.uid()) is not null then
    raise exception 'This household has payment records the co-op keeps. Remove its adults instead, or ask an administrator of the database to close it out.' using errcode = '23503';
  end if;

  delete from public.children where family_id = old.id;
  delete from public.documents where family_id = old.id;
  update public.families
  set display_name = 'Former household', last_name = null, records_retained_at = now()
  where id = old.id;
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values (null, 'household_records_retained', 'family', old.id::text, jsonb_build_object('reason', 'billing records kept'));
  return null;   -- cancels the delete; the household stays, without a name
end;
$function$;

create trigger families_retain_billing_records before delete on public.families
  for each row execute function private.retain_household_billing_records();

-- --- helpers -------------------------------------------------------------------------------------
create or replace function private.billing_provider()
returns text language sql stable security definer set search_path to ''
as $$ select coalesce((select provider from public.billing_settings where id = 'dues'), 'off'); $$;

-- Test-mode amounts count toward balances only while the co-op is in test mode.
create or replace function private.payment_counts(p_livemode boolean)
returns boolean language sql stable security definer set search_path to ''
as $$ select p_livemode or private.billing_provider() = 'stripe_test'; $$;

create or replace function private.require_billing_admin()
returns uuid language plpgsql stable security definer set search_path to ''
as $function$
declare v uuid := (select auth.uid());
begin
  if v is null or not private.has_role('admin') then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  if not private.aal_satisfied() then
    raise exception 'Complete two-factor verification before continuing.' using errcode = '42501';
  end if;
  return v;
end;
$function$;

create or replace function private.audit_billing(p_action text, p_subject_type text, p_subject_id text, p_detail jsonb default '{}'::jsonb)
returns void language sql security definer set search_path to ''
as $$
  insert into public.audit_log (actor_user_id, action, subject_type, subject_id, detail)
  values ((select auth.uid()), p_action, p_subject_type, p_subject_id, coalesce(p_detail, '{}'::jsonb));
$$;

create or replace function private.charge_family_access(p_charge uuid)
returns boolean language sql stable security definer set search_path to ''
as $$
  select exists (select 1 from public.dues_charges c where c.id = p_charge and private.has_family_access(c.family_id));
$$;

-- Tells every active adult of a household, in the app and by email.
create or replace function private.notify_family(p_family uuid, p_kind text, p_title text, p_body text, p_subject_type text, p_subject_id uuid)
returns void language plpgsql security definer set search_path to ''
as $function$
begin
  insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
  select fm.user_id, p_kind, p_title, p_body, '/family-village/dues', p_subject_type, p_subject_id
  from public.family_members fm join public.profiles p on p.id = fm.user_id
  where fm.family_id = p_family and p.status = 'active';

  insert into public.email_outbox (recipient_email, subject, html_body, kind, subject_type, subject_id)
  select p.email, p_title,
    '<p>' || private.escape_html(p_body) || '</p><p>See the details in Family Village: <a href="https://family.veritasvillage.org/family-village/dues">family.veritasvillage.org</a></p>',
    p_kind, p_subject_type, p_subject_id
  from public.family_members fm join public.profiles p on p.id = fm.user_id
  where fm.family_id = p_family and p.status = 'active' and p.email is not null and p.email <> '';
end;
$function$;

create or replace function private.notify_admins(p_kind text, p_title text, p_body text, p_subject_type text, p_subject_id uuid)
returns void language sql security definer set search_path to ''
as $$
  insert into public.notifications (recipient_user_id, kind, title, body, link_path, subject_type, subject_id)
  select r.user_id, p_kind, p_title, p_body, '/family-village/admin?tab=dues', p_subject_type, p_subject_id
  from public.user_roles r join public.profiles p on p.id = r.user_id and p.status = 'active'
  where r.role = 'admin';
$$;

create or replace function private.money(p_cents integer)
returns text language sql immutable set search_path to ''
as $$ select '$' || to_char(p_cents / 100.0, 'FM999,999,990.00'); $$;

-- Mirrors the charge into the compliance row families and the matrix already read.
create or replace function private.sync_family_requirement(p_charge uuid)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  c public.dues_charges%rowtype;
  v_last timestamptz;
  v_method text;
begin
  select * into c from public.dues_charges where id = p_charge;
  if not found then return; end if;

  select max(occurred_at), (array_agg(method order by occurred_at desc))[1]
  into v_last, v_method
  from public.dues_payments
  where charge_id = p_charge and direction = 'charge' and status = 'succeeded' and private.payment_counts(livemode);

  insert into public.family_requirements (requirement_id, family_id, status, amount_due, amount_paid)
  values (c.requirement_id, c.family_id, 'outstanding', c.amount_due_cents / 100.0, 0)
  on conflict (requirement_id, family_id) do nothing;

  update public.family_requirements fr
  set amount_due = c.amount_due_cents / 100.0,
      amount_paid = greatest(c.amount_paid_cents - c.amount_refunded_cents, 0) / 100.0,
      status = case
        when c.status = 'void' then 'waived'
        when c.status = 'paid' then 'complete'
        when c.status = 'partially_paid' then 'sent'
        else case when fr.status in ('complete', 'waived') then 'sent' else fr.status end end,
      paid_at = case when c.status = 'paid' then coalesce(v_last, fr.paid_at, now()) else null end,
      payment_method = case when c.status = 'paid' then
        case v_method when 'us_bank_account' then 'Bank transfer' when 'card' then 'Card' when 'cash' then 'Cash'
          when 'check' then 'Check' when 'crowded' then 'Crowded' else 'Other' end
        else null end
  where fr.requirement_id = c.requirement_id and fr.family_id = c.family_id;
end;
$function$;

-- Keeps an active plan's installments adding up to what is still owed after an
-- adjustment, a discount or a recalculation. The difference lands on the last
-- unpaid installment (and walks backwards if it has to remove more than that).
create or replace function private.reflow_plan(p_charge uuid)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  c public.dues_charges%rowtype;
  pl public.dues_payment_plans%rowtype;
  v_target integer;
  v_sum integer;
  v_delta integer;
  v_last record;
  v_take integer;
begin
  select * into c from public.dues_charges where id = p_charge;
  select * into pl from public.dues_payment_plans where charge_id = p_charge and status in ('active', 'completed');
  if not found then return; end if;

  v_target := greatest(c.amount_due_cents - pl.paid_before_cents, 0);
  select coalesce(sum(amount_cents), 0) into v_sum from public.dues_installments where plan_id = pl.id and status <> 'cancelled';
  v_delta := v_target - v_sum;
  if v_delta = 0 then return; end if;

  if v_delta > 0 then
    select * into v_last from public.dues_installments where plan_id = pl.id and status = 'scheduled' order by seq desc limit 1;
    if found then
      update public.dues_installments set amount_cents = amount_cents + v_delta where id = v_last.id;
    else
      insert into public.dues_installments (plan_id, charge_id, seq, due_on, amount_cents)
      select pl.id, p_charge, coalesce(max(seq), 0) + 1, greatest(current_date + 7, coalesce(max(due_on), current_date)), v_delta
      from public.dues_installments where plan_id = pl.id;
    end if;
    update public.dues_payment_plans set status = 'active' where id = pl.id and status = 'completed';
  else
    v_delta := -v_delta;
    for v_last in select * from public.dues_installments where plan_id = pl.id and status = 'scheduled' order by seq desc loop
      exit when v_delta <= 0;
      v_take := least(v_last.amount_cents, v_delta);
      if v_take = v_last.amount_cents then
        update public.dues_installments set status = 'cancelled' where id = v_last.id;
      else
        update public.dues_installments set amount_cents = amount_cents - v_take where id = v_last.id;
      end if;
      v_delta := v_delta - v_take;
    end loop;
  end if;
end;
$function$;

-- The one place paid totals, status and installment state are worked out. Every
-- path that changes money calls this; nothing else writes those columns.
create or replace function private.recompute_charge(p_charge uuid)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  c public.dues_charges%rowtype;
  pl public.dues_payment_plans%rowtype;
  v_paid integer;
  v_refunded integer;
  v_net integer;
  v_last timestamptz;
  v_status text;
  v_open integer;
begin
  select * into c from public.dues_charges where id = p_charge for update;
  if not found then return; end if;

  select coalesce(sum(amount_cents) filter (where direction = 'charge' and status = 'succeeded'), 0),
         coalesce(sum(amount_cents) filter (where direction = 'refund' and status = 'succeeded'), 0),
         max(occurred_at) filter (where direction = 'charge' and status = 'succeeded')
  into v_paid, v_refunded, v_last
  from public.dues_payments
  where charge_id = p_charge and private.payment_counts(livemode);

  v_refunded := least(v_refunded, v_paid);
  v_net := v_paid - v_refunded;
  v_status := case
    when c.status in ('void', 'uncollectible') then c.status
    when c.amount_due_cents - v_net <= 0 then 'paid'
    when v_net > 0 then 'partially_paid'
    else 'open' end;

  update public.dues_charges
  set amount_paid_cents = v_paid, amount_refunded_cents = v_refunded, status = v_status
  where id = p_charge;

  perform private.reflow_plan(p_charge);

  select * into pl from public.dues_payment_plans where charge_id = p_charge and status in ('active', 'completed');
  if found then
    update public.dues_installments i
    set status = case when s.cum <= greatest(v_net - pl.paid_before_cents, 0) then 'paid' else 'scheduled' end,
        paid_at = case when s.cum <= greatest(v_net - pl.paid_before_cents, 0) then coalesce(i.paid_at, v_last, now()) else null end,
        needs_attention = case when s.cum <= greatest(v_net - pl.paid_before_cents, 0) then false else i.needs_attention end
    from (select id, sum(amount_cents) over (order by seq) as cum
          from public.dues_installments where plan_id = pl.id and status <> 'cancelled') s
    where i.id = s.id;

    select count(*) into v_open from public.dues_installments where plan_id = pl.id and status = 'scheduled';
    update public.dues_payment_plans set status = case when v_open = 0 then 'completed' else 'active' end where id = pl.id;
  end if;

  perform private.sync_family_requirement(p_charge);
end;
$function$;

-- Consumes an approval for a live action, or explains why it cannot.
create or replace function private.consume_approval(p_approval uuid, p_action text, p_target_id uuid, p_amount integer, p_actor uuid)
returns void language plpgsql security definer set search_path to ''
as $function$
declare a public.billing_approvals%rowtype;
begin
  select * into a from public.billing_approvals where id = p_approval for update;
  if not found then raise exception 'This action needs an approval from a second administrator.' using errcode = '42501'; end if;
  if a.status <> 'approved' or a.expires_at < now() then
    raise exception 'That approval is no longer valid. Ask for a new one.' using errcode = '42501';
  end if;
  if a.action <> p_action or a.target_id is distinct from p_target_id or coalesce(p_amount, 0) > coalesce(a.amount_cents, 0) then
    raise exception 'That approval was for a different action or amount.' using errcode = '42501';
  end if;
  if a.approved_by is null or a.approved_by is not distinct from a.requested_by or a.approved_by is not distinct from p_actor then
    raise exception 'An approval must come from a different administrator.' using errcode = '42501';
  end if;
  if not exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id and p.status = 'active'
                 where r.user_id = a.approved_by and r.role = 'admin') then
    raise exception 'The approver is no longer an administrator.' using errcode = '42501';
  end if;
  update public.billing_approvals set status = 'consumed', consumed_at = now() where id = p_approval;
end;
$function$;

-- Builds a plan's installments. p_items is [{"due_on": "2026-09-01", "amount_cents": 5000}, ...]
create or replace function private.build_plan(p_charge uuid, p_kind text, p_items jsonb, p_actor uuid)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare
  c public.dues_charges%rowtype;
  v_plan uuid;
  v_remaining integer;
  v_sum integer;
  v_open_payment boolean;
begin
  select * into c from public.dues_charges where id = p_charge for update;
  if not found then raise exception 'That charge does not exist.'; end if;
  if c.status in ('void', 'uncollectible') then raise exception 'That charge is closed.'; end if;
  v_remaining := c.amount_due_cents - (c.amount_paid_cents - c.amount_refunded_cents);
  if v_remaining <= 0 then raise exception 'Nothing is owed on that charge.'; end if;

  select exists (select 1 from public.dues_payments where charge_id = p_charge and direction = 'charge' and status in ('pending', 'processing'))
  into v_open_payment;
  if v_open_payment then raise exception 'A payment is in progress. Try again once it settles.'; end if;

  update public.dues_payment_plans set status = 'cancelled' where charge_id = p_charge and status in ('active', 'completed');
  update public.dues_installments set status = 'cancelled' where charge_id = p_charge and status = 'scheduled';

  if p_kind = 'full' then
    return null;   -- paying in full is simply having no plan
  end if;

  if jsonb_typeof(p_items) <> 'array' or jsonb_array_length(p_items) < 1 or jsonb_array_length(p_items) > 24 then
    raise exception 'A plan needs between 1 and 24 installments.';
  end if;
  select coalesce(sum((x ->> 'amount_cents')::integer), 0) into v_sum from jsonb_array_elements(p_items) x;
  if v_sum <> v_remaining then
    raise exception 'The installments add up to % but % is still owed.', private.money(v_sum), private.money(v_remaining);
  end if;
  if exists (select 1 from jsonb_array_elements(p_items) x where (x ->> 'amount_cents')::integer <= 0 or (x ->> 'due_on') is null) then
    raise exception 'Every installment needs a date and an amount above zero.';
  end if;

  insert into public.dues_payment_plans (charge_id, kind, paid_before_cents, created_by)
  values (p_charge, p_kind, c.amount_paid_cents - c.amount_refunded_cents, p_actor) returning id into v_plan;

  insert into public.dues_installments (plan_id, charge_id, seq, due_on, amount_cents)
  select v_plan, p_charge, row_number() over (order by (x ->> 'due_on')::date, ord), (x ->> 'due_on')::date, (x ->> 'amount_cents')::integer
  from jsonb_array_elements(p_items) with ordinality as t(x, ord);

  return v_plan;
end;
$function$;

-- Splits what is still owed into N monthly payments, the first due today.
create or replace function private.monthly_items(p_remaining integer, p_count integer, p_first date)
returns jsonb language sql immutable set search_path to ''
as $$
  select jsonb_agg(jsonb_build_object(
    'due_on', (p_first + make_interval(months => n - 1))::date,
    'amount_cents', (p_remaining / p_count) + case when n = p_count then p_remaining % p_count else 0 end) order by n)
  from generate_series(1, p_count) n;
$$;

-- --- row level security ------------------------------------------------------------------------
alter table public.billing_settings enable row level security;
alter table public.billing_approvals enable row level security;
alter table public.billing_customers enable row level security;
alter table public.dues_charges enable row level security;
alter table public.dues_requirement_options enable row level security;
alter table public.dues_discount_types enable row level security;
alter table public.dues_discount_lines enable row level security;
alter table public.dues_adjustments enable row level security;
alter table public.dues_payment_plans enable row level security;
alter table public.dues_installments enable row level security;
alter table public.dues_payments enable row level security;
alter table public.dues_reminder_log enable row level security;
alter table public.stripe_webhook_events enable row level security;

-- Administrators read everything money-related; families read only their own
-- household. Nobody writes through the table API: there are no insert, update
-- or delete grants, and every change goes through the functions below.
create policy billing_settings_read on public.billing_settings for select to authenticated using (private.is_active_user());
create policy billing_approvals_admin_read on public.billing_approvals for select to authenticated using (private.has_role('admin'));
create policy dues_discount_types_read on public.dues_discount_types for select to authenticated using (private.is_active_user());
create policy dues_requirement_options_read on public.dues_requirement_options for select to authenticated using (private.is_active_user());
create policy dues_reminder_log_admin_read on public.dues_reminder_log for select to authenticated using (private.has_role('admin'));

create policy billing_customers_family_read on public.billing_customers for select to authenticated using (private.has_family_access(family_id));
create policy billing_customers_admin_read on public.billing_customers for select to authenticated using (private.has_role('admin'));
create policy dues_charges_family_read on public.dues_charges for select to authenticated using (private.has_family_access(family_id));
create policy dues_charges_admin_read on public.dues_charges for select to authenticated using (private.has_role('admin'));
create policy dues_payments_family_read on public.dues_payments for select to authenticated using (private.has_family_access(family_id));
create policy dues_payments_admin_read on public.dues_payments for select to authenticated using (private.has_role('admin'));
create policy dues_discount_lines_family_read on public.dues_discount_lines for select to authenticated using (private.charge_family_access(charge_id));
create policy dues_discount_lines_admin_read on public.dues_discount_lines for select to authenticated using (private.has_role('admin'));
create policy dues_adjustments_family_read on public.dues_adjustments for select to authenticated using (private.charge_family_access(charge_id));
create policy dues_adjustments_admin_read on public.dues_adjustments for select to authenticated using (private.has_role('admin'));
create policy dues_payment_plans_family_read on public.dues_payment_plans for select to authenticated using (private.charge_family_access(charge_id));
create policy dues_payment_plans_admin_read on public.dues_payment_plans for select to authenticated using (private.has_role('admin'));
create policy dues_installments_family_read on public.dues_installments for select to authenticated using (private.charge_family_access(charge_id));
create policy dues_installments_admin_read on public.dues_installments for select to authenticated using (private.has_role('admin'));
-- stripe_webhook_events: RLS on and no policy at all. Only the service role reads it.

-- Two-factor is required for these tables exactly as for the rest of the app,
-- and a reviewer (demo) account can only ever see its own sample household.
do $$
declare t text;
begin
  foreach t in array array['billing_settings', 'billing_approvals', 'billing_customers', 'dues_charges', 'dues_requirement_options',
    'dues_discount_types', 'dues_discount_lines', 'dues_adjustments', 'dues_payment_plans', 'dues_installments',
    'dues_payments', 'dues_reminder_log', 'stripe_webhook_events']
  loop
    execute format('create policy aal2_required on public.%I as restrictive for all to authenticated using (private.aal_satisfied())', t);
  end loop;
end $$;

create policy demo_isolation on public.dues_charges as restrictive for select to authenticated
  using (not private.is_demo_user() or private.has_family_access(family_id));
create policy demo_isolation on public.dues_payments as restrictive for select to authenticated
  using (not private.is_demo_user() or private.has_family_access(family_id));
create policy demo_isolation on public.billing_customers as restrictive for select to authenticated
  using (not private.is_demo_user() or private.has_family_access(family_id));

grant select on public.billing_settings, public.billing_approvals, public.billing_customers, public.dues_charges,
  public.dues_requirement_options, public.dues_discount_types, public.dues_discount_lines, public.dues_adjustments,
  public.dues_payment_plans, public.dues_installments, public.dues_payments, public.dues_reminder_log to authenticated;

-- --- the balance, defined once --------------------------------------------------------------------
create view public.dues_ledger with (security_invoker = true) as
select c.id, c.requirement_id, c.family_id, c.school_year_id, c.subtotal_cents, c.discount_total_cents,
  c.adjustment_total_cents, c.amount_due_cents, c.amount_paid_cents, c.amount_refunded_cents,
  c.amount_due_cents - (c.amount_paid_cents - c.amount_refunded_cents) as balance_cents,
  c.status, c.void_reason, c.disputed_at, c.created_at,
  f.display_name as family_name, r.title as requirement_title, r.due_on
from public.dues_charges c
join public.families f on f.id = c.family_id
join public.requirements r on r.id = c.requirement_id;
grant select on public.dues_ledger to authenticated;

-- ==============================================================================================
-- ADMIN FUNCTIONS (signed-in administrator, two-factor level checked inside)
-- ==============================================================================================

create or replace function public.admin_set_dues_options(p_requirement uuid, p_monthly_enabled boolean, p_monthly_count integer, p_first_due_on date)
returns void language plpgsql security definer set search_path to ''
as $function$
begin
  perform private.require_billing_admin();
  if not exists (select 1 from public.requirements where id = p_requirement and kind = 'dues') then
    raise exception 'That is not a dues requirement.';
  end if;
  insert into public.dues_requirement_options (requirement_id, monthly_enabled, monthly_count, monthly_first_due_on)
  values (p_requirement, p_monthly_enabled, coalesce(p_monthly_count, 9), p_first_due_on)
  on conflict (requirement_id) do update
    set monthly_enabled = excluded.monthly_enabled, monthly_count = excluded.monthly_count,
        monthly_first_due_on = excluded.monthly_first_due_on, updated_at = now();
  perform private.audit_billing('dues_options_set', 'requirement', p_requirement::text,
    jsonb_build_object('monthly_enabled', p_monthly_enabled, 'monthly_count', p_monthly_count));
end;
$function$;

-- Opens a charge for every household (or just the ones named) from the
-- requirement's formula. Safe to run again: existing charges are left alone.
create or replace function public.admin_open_dues(p_requirement uuid, p_family_ids uuid[] default null)
returns integer language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_billing_admin();
  r public.requirements%rowtype;
  v_count integer;
begin
  select * into r from public.requirements where id = p_requirement and kind = 'dues';
  if not found then raise exception 'That is not a dues requirement.'; end if;

  with inserted as (
    insert into public.dues_charges (requirement_id, family_id, school_year_id, subtotal_cents, opened_by)
    select r.id, f.id, r.school_year_id,
      round((coalesce(r.amount_per_family, 0) + coalesce(r.amount_per_child, 0)
        * (select count(*) from public.children ch where ch.family_id = f.id and ch.active)) * 100)::integer,
      v_actor
    from public.families f
    where f.records_retained_at is null
      and (p_family_ids is null or f.id = any (p_family_ids))
      and exists (select 1 from public.family_members fm where fm.family_id = f.id)
      and not exists (select 1 from public.family_members fm join public.profiles p on p.id = fm.user_id where fm.family_id = f.id and p.is_demo)
    on conflict (requirement_id, family_id) do nothing
    returning id
  )
  select count(*) into v_count from inserted;

  perform private.recompute_charge(c.id) from public.dues_charges c where c.requirement_id = r.id
    and (p_family_ids is null or c.family_id = any (p_family_ids));
  perform private.audit_billing('dues_opened', 'requirement', r.id::text, jsonb_build_object('charges_created', v_count));
  return v_count;
end;
$function$;

-- Re-derives the base amount from the family's current children, on purpose.
create or replace function public.admin_recalculate_charge(p_charge uuid)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  c public.dues_charges%rowtype;
  r public.requirements%rowtype;
  v_new integer;
begin
  perform private.require_billing_admin();
  select * into c from public.dues_charges where id = p_charge for update;
  if not found then raise exception 'That charge does not exist.'; end if;
  select * into r from public.requirements where id = c.requirement_id;
  v_new := round((coalesce(r.amount_per_family, 0) + coalesce(r.amount_per_child, 0)
    * (select count(*) from public.children ch where ch.family_id = c.family_id and ch.active)) * 100)::integer;
  if v_new = c.subtotal_cents then return; end if;
  update public.dues_charges set subtotal_cents = v_new where id = p_charge;
  perform private.recompute_charge(p_charge);
  perform private.audit_billing('dues_recalculated', 'dues_charge', p_charge::text,
    jsonb_build_object('from_cents', c.subtotal_cents, 'to_cents', v_new));
end;
$function$;

create or replace function public.admin_add_adjustment(p_charge uuid, p_amount_cents integer, p_reason text, p_memo text)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_billing_admin();
  v_id uuid;
begin
  if not exists (select 1 from public.dues_charges where id = p_charge) then raise exception 'That charge does not exist.'; end if;
  if p_amount_cents is null or p_amount_cents = 0 then raise exception 'An adjustment needs an amount.'; end if;
  insert into public.dues_adjustments (charge_id, amount_cents, reason, memo, created_by)
  values (p_charge, p_amount_cents, p_reason, trim(p_memo), v_actor) returning id into v_id;
  update public.dues_charges set adjustment_total_cents = adjustment_total_cents + p_amount_cents where id = p_charge;
  perform private.recompute_charge(p_charge);
  perform private.audit_billing('dues_adjustment_added', 'dues_charge', p_charge::text,
    jsonb_build_object('adjustment_id', v_id, 'amount_cents', p_amount_cents, 'reason', p_reason));
  return v_id;
end;
$function$;

-- An adjustment is never edited; this adds the opposite entry.
create or replace function public.admin_reverse_adjustment(p_adjustment uuid, p_memo text)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_billing_admin();
  a public.dues_adjustments%rowtype;
  v_id uuid;
begin
  select * into a from public.dues_adjustments where id = p_adjustment;
  if not found then raise exception 'That adjustment does not exist.'; end if;
  if a.reverses_adjustment_id is not null then raise exception 'A reversal cannot itself be reversed. Add a new adjustment instead.'; end if;
  if exists (select 1 from public.dues_adjustments where reverses_adjustment_id = p_adjustment) then
    raise exception 'That adjustment was already reversed.';
  end if;
  insert into public.dues_adjustments (charge_id, amount_cents, reason, memo, reverses_adjustment_id, created_by)
  values (a.charge_id, -a.amount_cents, 'correction', trim(p_memo), p_adjustment, v_actor) returning id into v_id;
  update public.dues_charges set adjustment_total_cents = adjustment_total_cents - a.amount_cents where id = a.charge_id;
  perform private.recompute_charge(a.charge_id);
  perform private.audit_billing('dues_adjustment_reversed', 'dues_charge', a.charge_id::text,
    jsonb_build_object('adjustment_id', p_adjustment, 'reversal_id', v_id));
  return v_id;
end;
$function$;

-- Either a catalogue discount (percent of the base, or a fixed amount) or an ad-hoc one.
create or replace function public.admin_apply_discount(p_charge uuid, p_type uuid, p_label text, p_amount_cents integer, p_note text default null)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_billing_admin();
  c public.dues_charges%rowtype;
  t public.dues_discount_types%rowtype;
  v_label text := trim(coalesce(p_label, ''));
  v_amount integer := p_amount_cents;
  v_id uuid;
begin
  select * into c from public.dues_charges where id = p_charge for update;
  if not found then raise exception 'That charge does not exist.'; end if;
  if p_type is not null then
    select * into t from public.dues_discount_types where id = p_type and active;
    if not found then raise exception 'That discount is not available.'; end if;
    v_label := t.label;
    v_amount := case t.kind when 'percent' then round(c.subtotal_cents * t.value / 10000.0)::integer else t.value end;
  end if;
  if v_amount is null or v_amount <= 0 then raise exception 'A discount needs an amount above zero.'; end if;
  if v_label = '' then raise exception 'A discount needs a label the family can read.'; end if;
  if c.discount_total_cents + v_amount > c.subtotal_cents then raise exception 'Discounts cannot exceed the base amount.'; end if;
  insert into public.dues_discount_lines (charge_id, discount_type_id, label, amount_cents, note, applied_by)
  values (p_charge, p_type, v_label, v_amount, p_note, v_actor) returning id into v_id;
  update public.dues_charges set discount_total_cents = discount_total_cents + v_amount where id = p_charge;
  perform private.recompute_charge(p_charge);
  perform private.audit_billing('dues_discount_applied', 'dues_charge', p_charge::text,
    jsonb_build_object('discount_line_id', v_id, 'amount_cents', v_amount, 'label', v_label));
  return v_id;
end;
$function$;

create or replace function public.admin_create_discount_type(p_code text, p_label text, p_kind text, p_value integer)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare v_id uuid;
begin
  perform private.require_billing_admin();
  insert into public.dues_discount_types (code, label, kind, value) values (lower(trim(p_code)), trim(p_label), p_kind, p_value) returning id into v_id;
  perform private.audit_billing('dues_discount_type_created', 'dues_discount_type', v_id::text, jsonb_build_object('code', p_code));
  return v_id;
end;
$function$;

-- A waiver. The family sees "Not required"; the money history stays.
create or replace function public.admin_set_charge_void(p_charge uuid, p_void boolean, p_reason text default null)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_billing_admin();
  c public.dues_charges%rowtype;
begin
  select * into c from public.dues_charges where id = p_charge for update;
  if not found then raise exception 'That charge does not exist.'; end if;
  if p_void then
    if coalesce(trim(p_reason), '') = '' then raise exception 'Say why this charge is being waived.'; end if;
    if exists (select 1 from public.dues_payments where charge_id = p_charge and direction = 'charge' and status in ('pending', 'processing')) then
      raise exception 'A payment is in progress. Wait for it to settle first.';
    end if;
    update public.dues_charges set status = 'void', void_reason = trim(p_reason), closed_by = v_actor where id = p_charge;
    update public.dues_payment_plans set status = 'cancelled' where charge_id = p_charge and status in ('active', 'completed');
    update public.dues_installments set status = 'cancelled' where charge_id = p_charge and status = 'scheduled';
  else
    update public.dues_charges set status = 'open', void_reason = null, closed_by = null where id = p_charge;
  end if;
  perform private.recompute_charge(p_charge);
  perform private.audit_billing(case when p_void then 'dues_charge_voided' else 'dues_charge_reopened' end, 'dues_charge', p_charge::text,
    jsonb_build_object('reason', p_reason));
end;
$function$;

-- The plan an administrator sets for a household: a deposit now and the rest
-- later, a per-term split, anything that adds up to what is still owed.
create or replace function public.admin_set_plan(p_charge uuid, p_installments jsonb)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_billing_admin();
  v_plan uuid;
begin
  v_plan := private.build_plan(p_charge, 'custom', p_installments, v_actor);
  perform private.recompute_charge(p_charge);
  perform private.audit_billing('dues_plan_set', 'dues_charge', p_charge::text, jsonb_build_object('plan_id', v_plan, 'installments', p_installments));
  return v_plan;
end;
$function$;

create or replace function public.admin_clear_plan(p_charge uuid)
returns void language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_billing_admin();
begin
  perform private.build_plan(p_charge, 'full', '[]'::jsonb, v_actor);
  perform private.recompute_charge(p_charge);
  perform private.audit_billing('dues_plan_cleared', 'dues_charge', p_charge::text, '{}'::jsonb);
end;
$function$;

-- Cash, a cheque, or a payment that came in outside Stripe.
create or replace function public.admin_record_offline_payment(
  p_charge uuid, p_amount_cents integer, p_method text, p_reference text, p_received_on date, p_note text default null)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_billing_admin();
  c public.dues_charges%rowtype;
  v_id uuid;
  v_balance integer;
begin
  if p_method not in ('cash', 'check', 'crowded', 'other') then raise exception 'Choose cash, check, Crowded or other.'; end if;
  select * into c from public.dues_charges where id = p_charge for update;
  if not found then raise exception 'That charge does not exist.'; end if;
  if c.status in ('void', 'uncollectible') then raise exception 'That charge is closed.'; end if;
  v_balance := c.amount_due_cents - (c.amount_paid_cents - c.amount_refunded_cents);
  if p_amount_cents is null or p_amount_cents <= 0 then raise exception 'Enter an amount above zero.'; end if;
  if p_amount_cents > v_balance then
    raise exception 'That is more than the % still owed. Record the exact amount, then refund or credit any extra separately.', private.money(v_balance);
  end if;
  insert into public.dues_payments (charge_id, family_id, direction, amount_cents, method, status, source, livemode,
    note, initiated_by, occurred_at)
  values (p_charge, c.family_id, 'charge', p_amount_cents, p_method, 'succeeded', 'admin_manual',
    private.billing_provider() <> 'stripe_test', nullif(concat_ws(' · ', nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), '')), ''), v_actor,
    coalesce(p_received_on::timestamptz, now()))
  returning id into v_id;
  update public.dues_payments set receipt_no = nextval('public.dues_receipt_seq') where id = v_id;
  perform private.recompute_charge(p_charge);
  perform private.audit_billing('dues_payment_recorded', 'dues_charge', p_charge::text,
    jsonb_build_object('payment_id', v_id, 'amount_cents', p_amount_cents, 'method', p_method));
  perform private.notify_family(c.family_id, 'payment_received', 'Payment received',
    'The co-op recorded your ' || private.money(p_amount_cents) || ' payment. Thank you.', 'dues_payment', v_id);
  return v_id;
end;
$function$;

-- A refund of cash or a cheque. Stripe refunds go through the stripe-admin
-- function, which creates the row with billing_begin_refund.
create or replace function public.admin_record_offline_refund(p_payment uuid, p_amount_cents integer, p_reason text, p_reduce_owed boolean, p_approval uuid default null)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_billing_admin();
  o public.dues_payments%rowtype;
  v_id uuid;
begin
  select * into o from public.dues_payments where id = p_payment and direction = 'charge' and status = 'succeeded' for update;
  if not found then raise exception 'Only a settled payment can be refunded.'; end if;
  if o.method in ('card', 'us_bank_account') and o.source <> 'migration_import' then
    raise exception 'Refund card and bank payments through Stripe so the money actually goes back.';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0
     or p_amount_cents > o.amount_cents - coalesce((select sum(amount_cents) from public.dues_payments
        where refunds_payment_id = p_payment and status in ('pending', 'processing', 'succeeded')), 0) then
    raise exception 'That is more than is left to refund on this payment.';
  end if;
  if private.billing_provider() = 'stripe_live' then
    perform private.consume_approval(p_approval, 'offline_refund', p_payment, p_amount_cents, v_actor);
  end if;
  insert into public.dues_payments (charge_id, family_id, direction, amount_cents, method, status, source, livemode,
    refunds_payment_id, reason, initiated_by, approval_id, occurred_at)
  values (o.charge_id, o.family_id, 'refund', p_amount_cents, o.method, 'succeeded', 'admin_manual', o.livemode,
    p_payment, trim(p_reason), v_actor, p_approval, now())
  returning id into v_id;
  if o.charge_id is not null then
    if p_reduce_owed then
      insert into public.dues_adjustments (charge_id, amount_cents, reason, memo, created_by)
      values (o.charge_id, -p_amount_cents, 'refund_credit', 'Refund of ' || private.money(p_amount_cents) || ' issued', v_actor);
      update public.dues_charges set adjustment_total_cents = adjustment_total_cents - p_amount_cents where id = o.charge_id;
    end if;
    perform private.recompute_charge(o.charge_id);
  end if;
  perform private.audit_billing('dues_refund_recorded', 'dues_payment', p_payment::text,
    jsonb_build_object('refund_id', v_id, 'amount_cents', p_amount_cents, 'offline', true));
  return v_id;
end;
$function$;

create or replace function public.admin_update_billing_settings(
  p_reminder_days integer, p_retry_after_days integer, p_max_attempts integer,
  p_org_name text, p_ein text, p_address text, p_note text)
returns void language plpgsql security definer set search_path to ''
as $function$
declare v_actor uuid := private.require_billing_admin();
begin
  update public.billing_settings
  set reminder_days_before = p_reminder_days, retry_after_days = p_retry_after_days, max_attempts = p_max_attempts,
      receipt_org_name = coalesce(nullif(trim(p_org_name), ''), 'Veritas Village'),
      receipt_ein = nullif(trim(coalesce(p_ein, '')), ''), receipt_address = nullif(trim(coalesce(p_address, '')), ''),
      receipt_note = nullif(trim(coalesce(p_note, '')), ''), updated_by = v_actor, updated_at = now()
  where id = 'dues';
  perform private.audit_billing('billing_settings_updated', 'billing_settings', 'dues', '{}'::jsonb);
end;
$function$;

-- --- approvals --------------------------------------------------------------------------------
create or replace function public.admin_request_approval(p_action text, p_target_type text, p_target_id uuid, p_amount_cents integer, p_note text)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_billing_admin();
  v_id uuid;
begin
  if not exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id and p.status = 'active'
                 where r.role = 'admin' and r.user_id <> v_actor) then
    raise exception 'Live billing needs a second administrator to approve. Add one first.';
  end if;
  insert into public.billing_approvals (action, target_type, target_id, amount_cents, requested_by, request_note)
  values (p_action, p_target_type, p_target_id, p_amount_cents, v_actor, left(p_note, 500)) returning id into v_id;
  perform private.audit_billing('billing_approval_requested', 'billing_approval', v_id::text,
    jsonb_build_object('action', p_action, 'amount_cents', p_amount_cents));
  perform private.notify_admins('billing_approval', 'A billing action needs your approval',
    'Open Admin → Dues → Approvals to review it.', 'billing_approval', v_id);
  return v_id;
end;
$function$;

create or replace function public.admin_decide_approval(p_approval uuid, p_approve boolean, p_note text default null)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_billing_admin();
  a public.billing_approvals%rowtype;
begin
  select * into a from public.billing_approvals where id = p_approval for update;
  if not found or a.status <> 'pending' then raise exception 'That request is no longer open.'; end if;
  if a.requested_by is not distinct from v_actor then raise exception 'You cannot approve your own request. Another administrator has to.'; end if;
  if a.expires_at < now() then raise exception 'That request expired. Ask for a new one.'; end if;
  update public.billing_approvals
  set status = case when p_approve then 'approved' else 'rejected' end, approved_by = case when p_approve then v_actor else null end,
      decision_note = left(p_note, 500), decided_at = now(),
      expires_at = case when p_approve then now() + interval '30 minutes' else expires_at end
  where id = p_approval;
  perform private.audit_billing(case when p_approve then 'billing_approval_granted' else 'billing_approval_rejected' end,
    'billing_approval', p_approval::text, jsonb_build_object('action', a.action));
end;
$function$;

-- off -> stripe_test needs nothing. Anything -> stripe_live needs an approved
-- enable_livemode request by a different administrator. Moving back is always allowed.
create or replace function public.admin_set_billing_provider(p_provider text, p_approval uuid default null)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := private.require_billing_admin();
  v_old text := private.billing_provider();
begin
  if p_provider not in ('off', 'stripe_test', 'stripe_live') then raise exception 'Unknown mode.'; end if;
  if p_provider = 'stripe_live' then
    perform private.consume_approval(p_approval, 'enable_livemode', null, 0, v_actor);
  end if;
  update public.billing_settings
  set provider = p_provider, live_approval_id = case when p_provider = 'stripe_live' then p_approval else null end,
      updated_by = v_actor, updated_at = now()
  where id = 'dues';
  perform private.recompute_charge(id) from public.dues_charges;
  perform private.audit_billing('billing_provider_changed', 'billing_settings', 'dues', jsonb_build_object('from', v_old, 'to', p_provider, 'approval_id', p_approval));
end;
$function$;

-- Clears Stripe test-mode rows (and nothing else) before going live.
create or replace function public.admin_purge_test_billing_data()
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_payments integer;
  v_customers integer;
  v_events integer;
begin
  perform private.require_billing_admin();
  if private.billing_provider() = 'stripe_live' then raise exception 'Switch back to test mode first.'; end if;
  perform set_config('vv.purge_test_billing', 'on', true);
  delete from public.dues_payments where not livemode and direction = 'refund';
  delete from public.dues_payments where not livemode;
  get diagnostics v_payments = row_count;
  delete from public.billing_customers where not livemode;
  get diagnostics v_customers = row_count;
  delete from public.stripe_webhook_events where not livemode;
  get diagnostics v_events = row_count;
  perform set_config('vv.purge_test_billing', 'off', true);
  perform private.recompute_charge(id) from public.dues_charges;
  perform private.audit_billing('billing_test_data_purged', 'billing_settings', 'dues',
    jsonb_build_object('payments', v_payments, 'customers', v_customers, 'events', v_events));
  return jsonb_build_object('payments', v_payments, 'customers', v_customers, 'events', v_events);
end;
$function$;

-- ==============================================================================================
-- FAMILY FUNCTIONS
-- ==============================================================================================

-- Pay in full, or split into the monthly plan the co-op offers for this year.
create or replace function public.family_choose_plan(p_charge uuid, p_kind text)
returns uuid language plpgsql security definer set search_path to ''
as $function$
declare
  v_actor uuid := (select auth.uid());
  c public.dues_charges%rowtype;
  o public.dues_requirement_options%rowtype;
  v_plan public.dues_payment_plans%rowtype;
  v_id uuid;
  v_remaining integer;
begin
  select * into c from public.dues_charges where id = p_charge;
  if not found or v_actor is null or not private.has_family_access(c.family_id) then raise exception 'That charge does not exist.'; end if;
  if p_kind not in ('full', 'monthly') then raise exception 'Choose pay in full or monthly.'; end if;
  if private.billing_provider() = 'off' then raise exception 'Online payments are not turned on yet.'; end if;

  select * into v_plan from public.dues_payment_plans where charge_id = p_charge and status in ('active', 'completed');
  if found and v_plan.kind = 'custom' then
    raise exception 'The co-op set a custom payment plan for your household. Ask an administrator to change it.';
  end if;

  v_remaining := c.amount_due_cents - (c.amount_paid_cents - c.amount_refunded_cents);
  if p_kind = 'monthly' then
    select * into o from public.dues_requirement_options where requirement_id = c.requirement_id;
    if not found or not o.monthly_enabled then raise exception 'Monthly payments are not offered for these dues.'; end if;
    v_id := private.build_plan(p_charge, 'monthly',
      private.monthly_items(v_remaining, o.monthly_count, greatest(coalesce(o.monthly_first_due_on, current_date), current_date)), v_actor);
  else
    v_id := private.build_plan(p_charge, 'full', '[]'::jsonb, v_actor);
  end if;
  perform private.recompute_charge(p_charge);
  return v_id;
end;
$function$;

-- Turns automatic monthly charges off. Turning them on happens only inside
-- Stripe's checkout, where the family agrees to the bank or card authorisation.
create or replace function public.family_stop_autopay(p_family uuid)
returns void language plpgsql security definer set search_path to ''
as $function$
begin
  if (select auth.uid()) is null or not private.has_family_access(p_family) then raise exception 'That household does not exist.'; end if;
  update public.billing_customers set autopay = false where family_id = p_family;
end;
$function$;

-- ==============================================================================================
-- SERVICE-ROLE FUNCTIONS (called only by the edge functions)
-- ==============================================================================================

create or replace function public.stripe_claim_event(p_id text, p_type text, p_livemode boolean, p_payload jsonb)
returns text language plpgsql security definer set search_path to ''
as $function$
declare v_processed timestamptz;
begin
  insert into public.stripe_webhook_events (id, type, livemode, payload) values (p_id, p_type, p_livemode, p_payload)
  on conflict (id) do nothing;
  if found then return 'new'; end if;
  select processed_at into v_processed from public.stripe_webhook_events where id = p_id;
  if v_processed is not null then return 'processed'; end if;
  update public.stripe_webhook_events set attempts = attempts + 1 where id = p_id;
  return 'retry';
end;
$function$;

create or replace function public.stripe_finish_event(p_id text, p_error text default null)
returns void language sql security definer set search_path to ''
as $$
  update public.stripe_webhook_events
  set processed_at = case when p_error is null then now() else null end, process_error = left(p_error, 500)
  where id = p_id;
$$;

-- Payloads can hold names and emails; keep them 90 days, keep the fact of the event.
create or replace function public.billing_prune_webhook_events()
returns integer language plpgsql security definer set search_path to ''
as $function$
declare v integer;
begin
  update public.stripe_webhook_events set payload = null
  where payload is not null and processed_at is not null and received_at < now() - interval '90 days';
  get diagnostics v = row_count;
  return v;
end;
$function$;

create or replace function public.billing_set_customer(p_family uuid, p_livemode boolean, p_customer_id text)
returns void language sql security definer set search_path to ''
as $$
  insert into public.billing_customers (family_id, livemode, stripe_customer_id) values (p_family, p_livemode, p_customer_id)
  on conflict (family_id, livemode) do nothing;
$$;

-- Starts a payment a household member asked for. The amount is decided here,
-- never by the client: the next installment, or the whole balance.
create or replace function public.billing_begin_payment(p_user uuid, p_charge uuid, p_pay_all boolean default false, p_autopay boolean default false)
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  c public.dues_charges%rowtype;
  pl public.dues_payment_plans%rowtype;
  v_provider text := private.billing_provider();
  v_balance integer;
  v_net integer;
  v_amount integer;
  v_inst uuid;
  v_exist record;
  v_id uuid;
begin
  if v_provider = 'off' then raise exception 'online_payments_off'; end if;
  select * into c from public.dues_charges where id = p_charge for update;
  if not found then raise exception 'charge_not_found'; end if;
  if not exists (select 1 from public.family_members fm join public.profiles p on p.id = fm.user_id
                 where fm.family_id = c.family_id and fm.user_id = p_user and p.status = 'active') then
    raise exception 'not_allowed';
  end if;
  if exists (select 1 from public.profiles where id = p_user and is_demo) then raise exception 'demo_account'; end if;
  if c.status in ('void', 'uncollectible') then raise exception 'charge_closed'; end if;

  v_net := c.amount_paid_cents - c.amount_refunded_cents;
  v_balance := c.amount_due_cents - v_net;
  if v_balance <= 0 then raise exception 'nothing_due'; end if;

  select id, amount_cents, status, stripe_checkout_session_id into v_exist
  from public.dues_payments where charge_id = p_charge and direction = 'charge' and status in ('pending', 'processing') limit 1;
  if found then
    return jsonb_build_object('payment_id', v_exist.id, 'amount_cents', v_exist.amount_cents, 'existing', true,
      'status', v_exist.status, 'checkout_session_id', v_exist.stripe_checkout_session_id);
  end if;

  v_amount := v_balance;
  select * into pl from public.dues_payment_plans where charge_id = p_charge and status = 'active';
  if found and not p_pay_all then
    select x.id, least(x.amount_cents, x.cum - greatest(v_net - pl.paid_before_cents, 0)) into v_inst, v_amount
    from (select i.id, i.amount_cents, i.seq, i.status, sum(i.amount_cents) over (order by i.seq) as cum
          from public.dues_installments i where i.plan_id = pl.id and i.status <> 'cancelled') x
    where x.cum > greatest(v_net - pl.paid_before_cents, 0)
    order by x.seq limit 1;
    v_amount := least(coalesce(v_amount, v_balance), v_balance);
  end if;

  insert into public.dues_payments (charge_id, family_id, installment_id, direction, amount_cents, status, source, livemode,
    saved_for_autopay, initiated_by)
  values (p_charge, c.family_id, v_inst, 'charge', v_amount, 'pending', 'portal', v_provider = 'stripe_live',
    coalesce(p_autopay, false) and pl.id is not null, p_user)
  returning id into v_id;

  return jsonb_build_object('payment_id', v_id, 'amount_cents', v_amount, 'existing', false, 'status', 'pending',
    'checkout_session_id', null, 'family_id', c.family_id);
end;
$function$;

create or replace function public.billing_attach_checkout(p_payment uuid, p_session_id text)
returns void language sql security definer set search_path to ''
as $$ update public.dues_payments set stripe_checkout_session_id = p_session_id where id = p_payment and status = 'pending'; $$;

-- Marks an attempt that never reached a payment (an abandoned or expired checkout).
create or replace function public.billing_cancel_payment(p_payment uuid, p_reason text default null)
returns void language sql security definer set search_path to ''
as $$
  update public.dues_payments set status = 'canceled', failure_message = left(p_reason, 300)
  where id = p_payment and status = 'pending';
$$;

-- Applies what Stripe says happened to one payment attempt. Safe to call twice
-- with the same data, and out-of-order events are ignored rather than applied.
create or replace function public.billing_apply_payment_update(p_payment uuid, p_status text, p_event_id text, p_fields jsonb default '{}'::jsonb)
returns text language plpgsql security definer set search_path to ''
as $function$
declare
  pay public.dues_payments%rowtype;
  s public.billing_settings%rowtype;
  v_allowed boolean;
  v_title text;
  v_attempts integer;
begin
  select * into pay from public.dues_payments where id = p_payment for update;
  if not found then raise exception 'payment_not_found'; end if;
  select * into s from public.billing_settings where id = 'dues';

  v_allowed := p_status = pay.status
    or (pay.status = 'pending' and p_status in ('processing', 'succeeded', 'failed', 'canceled'))
    or (pay.status = 'processing' and p_status in ('succeeded', 'failed', 'canceled'))
    or (pay.status = 'succeeded' and p_status = 'failed');
  if not v_allowed then return 'ignored'; end if;

  update public.dues_payments set
    status = p_status,
    method = coalesce(p_fields ->> 'method', method),
    wallet = coalesce(p_fields ->> 'wallet', wallet),
    brand = coalesce(p_fields ->> 'brand', brand),
    last4 = coalesce(p_fields ->> 'last4', last4),
    bank_name = coalesce(p_fields ->> 'bank_name', bank_name),
    stripe_payment_intent_id = coalesce(p_fields ->> 'payment_intent_id', stripe_payment_intent_id),
    stripe_charge_id = coalesce(p_fields ->> 'charge_id', stripe_charge_id),
    receipt_url = coalesce(p_fields ->> 'receipt_url', receipt_url),
    failure_code = case when p_status = 'failed' then p_fields ->> 'failure_code' else null end,
    failure_message = case when p_status = 'failed' then left(p_fields ->> 'failure_message', 300) else null end,
    stripe_event_id = p_event_id,
    occurred_at = case when p_status = 'succeeded' then coalesce((p_fields ->> 'occurred_at')::timestamptz, occurred_at, now()) else occurred_at end
  where id = p_payment;

  if p_status = 'succeeded' and pay.receipt_no is null then
    update public.dues_payments set receipt_no = nextval('public.dues_receipt_seq') where id = p_payment;
  end if;

  if pay.charge_id is not null then perform private.recompute_charge(pay.charge_id); end if;

  -- Remember the method for the monthly plan, but only when the household agreed to that at checkout.
  if p_status = 'succeeded' and pay.saved_for_autopay and p_fields ->> 'payment_method_id' is not null then
    update public.billing_customers set
      stripe_payment_method_id = p_fields ->> 'payment_method_id', default_pm_type = p_fields ->> 'method',
      default_pm_brand = coalesce(p_fields ->> 'brand', default_pm_brand),
      default_pm_last4 = coalesce(p_fields ->> 'last4', default_pm_last4),
      default_pm_bank_name = coalesce(p_fields ->> 'bank_name', default_pm_bank_name),
      mandate_id = coalesce(p_fields ->> 'mandate_id', mandate_id), autopay = true
    where family_id = pay.family_id and livemode = pay.livemode;
  end if;

  if p_status is distinct from pay.status then
    if p_status = 'succeeded' then
      perform private.notify_family(pay.family_id, 'payment_received', 'Payment received',
        'Your ' || private.money(pay.amount_cents) || ' dues payment went through. A receipt is in Family Village.', 'dues_payment', pay.id);
    elsif p_status = 'failed' then
      v_title := case when pay.status = 'succeeded' then 'A bank transfer was returned' else 'A dues payment did not go through' end;
      perform private.notify_family(pay.family_id, 'payment_failed', v_title,
        'Your ' || private.money(pay.amount_cents) || ' payment failed: ' || coalesce(nullif(p_fields ->> 'failure_message', ''), 'the bank did not accept it')
          || '. Please try again or choose another method.', 'dues_payment', pay.id);
      perform private.notify_admins('payment_failed', 'A dues payment failed',
        (select f.display_name from public.families f where f.id = pay.family_id) || ': ' || private.money(pay.amount_cents)
          || case when pay.status = 'succeeded' then ' (returned after it had cleared)' else '' end, 'dues_payment', pay.id);
      if pay.installment_id is not null and pay.source = 'autopay' then
        select attempts into v_attempts from public.dues_installments where id = pay.installment_id;
        if v_attempts >= s.max_attempts then
          update public.dues_installments set needs_attention = true where id = pay.installment_id;
          update public.billing_customers set autopay = false where family_id = pay.family_id and livemode = pay.livemode;
        end if;
      end if;
    end if;
  end if;
  return 'applied';
end;
$function$;

-- A refund Stripe reports (made here or in the Stripe dashboard).
create or replace function public.billing_apply_refund(
  p_stripe_refund_id text, p_payment_intent text, p_stripe_charge text, p_amount_cents integer, p_status text, p_event_id text, p_failure text default null)
returns text language plpgsql security definer set search_path to ''
as $function$
declare
  o public.dues_payments%rowtype;
  r public.dues_payments%rowtype;
  v_status text := case p_status when 'succeeded' then 'succeeded' when 'failed' then 'failed' when 'canceled' then 'canceled' else 'processing' end;
begin
  select * into r from public.dues_payments where stripe_refund_id = p_stripe_refund_id;
  if found then
    if r.status = v_status or r.status = 'succeeded' then return 'ignored'; end if;
    update public.dues_payments set status = v_status, stripe_event_id = p_event_id, failure_message = left(p_failure, 300),
      occurred_at = case when v_status = 'succeeded' then now() else occurred_at end where id = r.id;
    if r.charge_id is not null then perform private.recompute_charge(r.charge_id); end if;
    return 'applied';
  end if;

  select * into o from public.dues_payments
  where direction = 'charge' and ((p_payment_intent is not null and stripe_payment_intent_id = p_payment_intent)
    or (p_stripe_charge is not null and stripe_charge_id = p_stripe_charge))
  limit 1;
  if not found then raise exception 'refund_payment_not_found'; end if;

  -- Created from the Stripe dashboard: record it so the books match.
  insert into public.dues_payments (charge_id, family_id, direction, amount_cents, method, status, source, livemode,
    refunds_payment_id, stripe_refund_id, stripe_event_id, reason, occurred_at)
  values (o.charge_id, o.family_id, 'refund', p_amount_cents, o.method, v_status, 'stripe_dashboard', o.livemode,
    o.id, p_stripe_refund_id, p_event_id, 'Refunded in the Stripe dashboard', case when v_status = 'succeeded' then now() end);
  if o.charge_id is not null then perform private.recompute_charge(o.charge_id); end if;
  perform private.notify_admins('refund_recorded', 'A refund was made in Stripe',
    private.money(p_amount_cents) || ' was refunded outside the portal. Check whether the family still owes it.', 'dues_payment', o.id);
  return 'applied';
end;
$function$;

-- The stripe-admin function starts a Stripe refund here: it validates the
-- actor and approval, and returns the pending refund row to send to Stripe.
create or replace function public.billing_begin_refund(p_actor uuid, p_payment uuid, p_amount_cents integer, p_reason text, p_reduce_owed boolean, p_approval uuid default null)
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  o public.dues_payments%rowtype;
  v_id uuid;
  v_left integer;
begin
  if not exists (select 1 from public.user_roles r join public.profiles p on p.id = r.user_id and p.status = 'active'
                 where r.user_id = p_actor and r.role = 'admin') then
    raise exception 'Administrator access is required.' using errcode = '42501';
  end if;
  select * into o from public.dues_payments where id = p_payment and direction = 'charge' and status = 'succeeded' for update;
  if not found then raise exception 'Only a settled payment can be refunded.'; end if;
  if o.method not in ('card', 'us_bank_account') or o.stripe_payment_intent_id is null then
    raise exception 'That payment did not go through Stripe. Record the refund as cash or check instead.';
  end if;
  v_left := o.amount_cents - coalesce((select sum(amount_cents) from public.dues_payments
    where refunds_payment_id = p_payment and status in ('pending', 'processing', 'succeeded')), 0);
  if p_amount_cents is null or p_amount_cents <= 0 or p_amount_cents > v_left then
    raise exception 'That is more than is left to refund on this payment (%).', private.money(v_left);
  end if;
  if o.livemode then
    perform private.consume_approval(p_approval, 'refund', p_payment, p_amount_cents, p_actor);
  end if;
  insert into public.dues_payments (charge_id, family_id, direction, amount_cents, method, status, source, livemode,
    refunds_payment_id, reason, initiated_by, approval_id)
  values (o.charge_id, o.family_id, 'refund', p_amount_cents, o.method, 'pending', 'admin_manual', o.livemode,
    p_payment, trim(p_reason), p_actor, p_approval)
  returning id into v_id;
  if p_reduce_owed and o.charge_id is not null then
    insert into public.dues_adjustments (charge_id, amount_cents, reason, memo, created_by)
    values (o.charge_id, -p_amount_cents, 'refund_credit', 'Refund of ' || private.money(p_amount_cents) || ' issued', p_actor);
    update public.dues_charges set adjustment_total_cents = adjustment_total_cents - p_amount_cents where id = o.charge_id;
    perform private.recompute_charge(o.charge_id);
  end if;
  return jsonb_build_object('refund_id', v_id, 'payment_intent_id', o.stripe_payment_intent_id, 'amount_cents', p_amount_cents,
    'idempotency_key', 'ref_' || v_id::text, 'livemode', o.livemode);
end;
$function$;

create or replace function public.billing_attach_refund(p_refund uuid, p_stripe_refund_id text, p_status text)
returns void language plpgsql security definer set search_path to ''
as $function$
declare r public.dues_payments%rowtype;
begin
  update public.dues_payments set stripe_refund_id = p_stripe_refund_id where id = p_refund and direction = 'refund' and status = 'pending'
  returning * into r;
  if found then perform public.billing_apply_refund(p_stripe_refund_id, null, null, r.amount_cents, p_status, null); end if;
end;
$function$;

create or replace function public.billing_flag_dispute(p_payment_intent text, p_stripe_charge text)
returns void language plpgsql security definer set search_path to ''
as $function$
declare o public.dues_payments%rowtype;
begin
  select * into o from public.dues_payments
  where direction = 'charge' and ((p_payment_intent is not null and stripe_payment_intent_id = p_payment_intent)
    or (p_stripe_charge is not null and stripe_charge_id = p_stripe_charge)) limit 1;
  if not found then return; end if;
  if o.charge_id is not null then update public.dues_charges set disputed_at = coalesce(disputed_at, now()) where id = o.charge_id; end if;
  perform private.notify_admins('payment_dispute', 'A dues payment was disputed',
    'The bank or card issuer disputed a ' || private.money(o.amount_cents) || ' payment. Respond in the Stripe dashboard.', 'dues_payment', o.id);
end;
$function$;

-- Installments the daily run should try to collect automatically.
create or replace function public.billing_due_autopay(p_today date default current_date)
returns table (installment_id uuid)
language sql stable security definer set search_path to ''
as $$
  select i.id
  from public.dues_installments i
  join public.dues_payment_plans pl on pl.id = i.plan_id and pl.status = 'active'
  join public.dues_charges c on c.id = i.charge_id and c.status in ('open', 'partially_paid')
  join public.billing_customers bc on bc.family_id = c.family_id and bc.autopay and bc.stripe_payment_method_id is not null
    and bc.livemode = (private.billing_provider() = 'stripe_live')
  cross join public.billing_settings s
  where i.status = 'scheduled' and i.due_on <= p_today and i.attempts < s.max_attempts and not i.needs_attention
    and (i.next_attempt_on is null or i.next_attempt_on <= p_today)
    -- Always the earliest unpaid installment, so a missed one is never skipped over.
    and i.seq = (select min(x.seq) from public.dues_installments x where x.plan_id = i.plan_id and x.status = 'scheduled')
    and s.provider <> 'off'
    and not exists (select 1 from public.dues_payments p where p.charge_id = c.id and p.direction = 'charge' and p.status in ('pending', 'processing'));
$$;

-- Creates the pending row for one automatic installment charge and counts the attempt.
create or replace function public.billing_begin_autopay(p_installment uuid, p_today date default current_date)
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  i public.dues_installments%rowtype;
  c public.dues_charges%rowtype;
  pl public.dues_payment_plans%rowtype;
  bc public.billing_customers%rowtype;
  s public.billing_settings%rowtype;
  v_net integer;
  v_amount integer;
  v_id uuid;
begin
  select * into s from public.billing_settings where id = 'dues';
  select * into i from public.dues_installments where id = p_installment for update;
  if not found or i.status <> 'scheduled' then raise exception 'installment_not_due'; end if;
  select * into c from public.dues_charges where id = i.charge_id for update;
  select * into pl from public.dues_payment_plans where id = i.plan_id;
  select * into bc from public.billing_customers where family_id = c.family_id and livemode = (s.provider = 'stripe_live');
  if s.provider = 'off' or pl.status <> 'active' or c.status not in ('open', 'partially_paid') or not found or not bc.autopay
     or bc.stripe_payment_method_id is null or i.due_on > p_today or i.attempts >= s.max_attempts
     or i.seq <> (select min(x.seq) from public.dues_installments x where x.plan_id = i.plan_id and x.status = 'scheduled') then
    raise exception 'installment_not_due';
  end if;
  if exists (select 1 from public.dues_payments where charge_id = c.id and direction = 'charge' and status in ('pending', 'processing')) then
    raise exception 'payment_in_flight';
  end if;
  v_net := c.amount_paid_cents - c.amount_refunded_cents;
  select least(x.amount_cents, x.cum - greatest(v_net - pl.paid_before_cents, 0)) into v_amount
  from (select ii.id, ii.amount_cents, sum(ii.amount_cents) over (order by ii.seq) as cum
        from public.dues_installments ii where ii.plan_id = pl.id and ii.status <> 'cancelled') x
  where x.id = i.id;
  v_amount := least(coalesce(v_amount, 0), c.amount_due_cents - v_net);
  if v_amount <= 0 then raise exception 'installment_not_due'; end if;

  insert into public.dues_payments (charge_id, family_id, installment_id, direction, amount_cents, method, status, source, livemode)
  values (c.id, c.family_id, i.id, 'charge', v_amount, bc.default_pm_type, 'pending', 'autopay', s.provider = 'stripe_live')
  returning id into v_id;
  update public.dues_installments
  set attempts = attempts + 1, last_attempt_at = now(), next_attempt_on = p_today + s.retry_after_days
  where id = i.id;

  return jsonb_build_object('payment_id', v_id, 'amount_cents', v_amount, 'family_id', c.family_id, 'charge_id', c.id,
    'stripe_customer_id', bc.stripe_customer_id, 'payment_method_id', bc.stripe_payment_method_id,
    'method', bc.default_pm_type, 'livemode', s.provider = 'stripe_live');
end;
$function$;

-- Attempts that never reached Stripe (a crash between the row and the call).
create or replace function public.billing_expire_stale()
returns integer language plpgsql security definer set search_path to ''
as $function$
declare v integer;
begin
  update public.dues_payments set status = 'canceled', failure_message = 'The payment was never completed.'
  where direction = 'charge' and status = 'pending'
    and ((stripe_checkout_session_id is null and stripe_payment_intent_id is null and created_at < now() - interval '30 minutes')
      or created_at < now() - interval '2 days');
  get diagnostics v = row_count;
  return v;
end;
$function$;

create or replace function public.billing_queue_reminders(p_today date default current_date)
returns integer language plpgsql security definer set search_path to ''
as $function$
declare
  s public.billing_settings%rowtype;
  r record;
  v_count integer := 0;
begin
  select * into s from public.billing_settings where id = 'dues';
  if s.provider = 'off' then return 0; end if;
  for r in
    select i.id as installment_id, i.due_on, i.amount_cents, c.family_id,
      case when i.due_on < p_today then 'overdue' else 'upcoming' end as kind,
      coalesce(bc.autopay, false) and bc.stripe_payment_method_id is not null as autopay
    from public.dues_installments i
    join public.dues_payment_plans pl on pl.id = i.plan_id and pl.status = 'active'
    join public.dues_charges c on c.id = i.charge_id and c.status in ('open', 'partially_paid')
    left join public.billing_customers bc on bc.family_id = c.family_id and bc.livemode = (s.provider = 'stripe_live')
    where i.status = 'scheduled'
      and ((i.due_on = p_today + s.reminder_days_before) or (i.due_on = p_today - 3))
      and not exists (select 1 from public.dues_reminder_log l where l.installment_id = i.id
        and l.kind = case when i.due_on < p_today then 'overdue' else 'upcoming' end)
  loop
    insert into public.dues_reminder_log (installment_id, kind) values (r.installment_id, r.kind) on conflict do nothing;
    if r.kind = 'upcoming' then
      perform private.notify_family(r.family_id, 'installment_reminder',
        case when r.autopay then 'A dues installment will be collected soon' else 'A dues installment is coming due' end,
        private.money(r.amount_cents) || ' is due ' || to_char(r.due_on, 'FMMonth FMDD') ||
          case when r.autopay then ' and will be collected automatically from the method you saved.' else '. You can pay it in Family Village.' end,
        'dues_installment', r.installment_id);
    else
      perform private.notify_family(r.family_id, 'installment_overdue', 'A dues installment is past due',
        private.money(r.amount_cents) || ' was due ' || to_char(r.due_on, 'FMMonth FMDD') || '. Please pay it in Family Village, or contact the co-op if something is wrong.',
        'dues_installment', r.installment_id);
    end if;
    v_count := v_count + 1;
  end loop;
  return v_count;
end;
$function$;

-- --- who may call what -----------------------------------------------------------------------------
do $$
declare f text;
begin
  -- Signed-in users: admin functions check the role inside; family functions check household access.
  foreach f in array array[
    'admin_set_dues_options(uuid,boolean,integer,date)', 'admin_open_dues(uuid,uuid[])', 'admin_recalculate_charge(uuid)',
    'admin_add_adjustment(uuid,integer,text,text)', 'admin_reverse_adjustment(uuid,text)',
    'admin_apply_discount(uuid,uuid,text,integer,text)', 'admin_create_discount_type(text,text,text,integer)',
    'admin_set_charge_void(uuid,boolean,text)', 'admin_set_plan(uuid,jsonb)', 'admin_clear_plan(uuid)',
    'admin_record_offline_payment(uuid,integer,text,text,date,text)',
    'admin_record_offline_refund(uuid,integer,text,boolean,uuid)',
    'admin_update_billing_settings(integer,integer,integer,text,text,text,text)',
    'admin_request_approval(text,text,uuid,integer,text)', 'admin_decide_approval(uuid,boolean,text)',
    'admin_set_billing_provider(text,uuid)', 'admin_purge_test_billing_data()',
    'family_choose_plan(uuid,text)', 'family_stop_autopay(uuid)']
  loop
    execute format('revoke all on function public.%s from public, anon', f);
    execute format('grant execute on function public.%s to authenticated', f);
  end loop;

  -- The edge functions only.
  foreach f in array array[
    'stripe_claim_event(text,text,boolean,jsonb)', 'stripe_finish_event(text,text)', 'billing_prune_webhook_events()',
    'billing_set_customer(uuid,boolean,text)', 'billing_begin_payment(uuid,uuid,boolean,boolean)',
    'billing_attach_checkout(uuid,text)', 'billing_cancel_payment(uuid,text)',
    'billing_apply_payment_update(uuid,text,text,jsonb)', 'billing_apply_refund(text,text,text,integer,text,text,text)',
    'billing_begin_refund(uuid,uuid,integer,text,boolean,uuid)', 'billing_attach_refund(uuid,text,text)',
    'billing_flag_dispute(text,text)', 'billing_due_autopay(date)', 'billing_begin_autopay(uuid,date)',
    'billing_expire_stale()', 'billing_queue_reminders(date)']
  loop
    execute format('revoke all on function public.%s from public, anon, authenticated', f);
    execute format('grant execute on function public.%s to service_role', f);
  end loop;
end $$;

-- private helpers are not part of the API
revoke all on function private.recompute_charge(uuid), private.reflow_plan(uuid), private.sync_family_requirement(uuid),
  private.build_plan(uuid, text, jsonb, uuid), private.consume_approval(uuid, text, uuid, integer, uuid),
  private.notify_family(uuid, text, text, text, text, uuid), private.notify_admins(text, text, text, text, uuid),
  private.audit_billing(text, text, text, jsonb), private.require_billing_admin(), private.billing_provider(),
  private.payment_counts(boolean), private.money(integer), private.monthly_items(integer, integer, date)
  from public, anon, authenticated;
-- The policies call these as the signed-in user, so they must stay executable.
grant execute on function private.charge_family_access(uuid) to authenticated;
revoke all on function private.charge_family_access(uuid) from public, anon;
