-- Dues ledger fixes from the November 2026 bug bash (#170, #185, #208).
--
-- #170: cash, check, Crowded and other payments an administrator records are
-- real money whatever mode Stripe is in. They were written with livemode = false
-- while the co-op rehearsed in test mode, so the test-data purge deleted them and
-- live mode stopped counting them. They are now always livemode = true, rows
-- already written that way are corrected, and the purge only touches Stripe rows.
--
-- #185: a refund webhook that lands before billing_attach_refund now finds the
-- portal's own refund row (by the refund id Stripe carries in metadata, or the one
-- pending refund for that payment and amount) instead of recording a second
-- "dashboard" refund; billing_attach_refund then still writes the "reduce what is
-- owed" credit, once. A refund for a charge that is not a dues payment answers
-- 'not_ours' instead of failing, so Stripe stops retrying it.
--
-- #208: two overlapping daily runs no longer send the same reminder twice.

-- --- #170: offline payments are real money ------------------------------------------------------
-- The ledger guard refuses any change to livemode, so it is paused for this one
-- correction, inside this migration's transaction.
alter table public.dues_payments disable trigger dues_payments_guard;
update public.dues_payments o set livemode = true
where not o.livemode and o.direction = 'charge' and o.source in ('admin_manual', 'migration_import');
update public.dues_payments r set livemode = true
where not r.livemode and r.direction = 'refund'
  and exists (select 1 from public.dues_payments o where o.id = r.refunds_payment_id and o.livemode
              and o.source in ('admin_manual', 'migration_import'));
alter table public.dues_payments enable trigger dues_payments_guard;
-- Balances move only where a correction above changed what counts.
select private.recompute_charge(c.id) from public.dues_charges c
where exists (select 1 from public.dues_payments p where p.charge_id = c.id and p.source in ('admin_manual', 'migration_import'));

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
  -- livemode is true whatever mode Stripe is in: cash and checks are real money (#170).
  insert into public.dues_payments (charge_id, family_id, direction, amount_cents, method, status, source, livemode,
    note, initiated_by, occurred_at)
  values (p_charge, c.family_id, 'charge', p_amount_cents, p_method, 'succeeded', 'admin_manual',
    true, nullif(concat_ws(' · ', nullif(trim(coalesce(p_reference, '')), ''), nullif(trim(coalesce(p_note, '')), '')), ''), v_actor,
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

-- Clears Stripe test-mode rows before going live. Payments an administrator
-- recorded by hand, and their refunds, are never touched (#170).
create or replace function public.admin_purge_test_billing_data()
returns jsonb language plpgsql security definer set search_path to ''
as $function$
declare
  v_payments integer;
  v_refunds integer;
  v_customers integer;
  v_events integer;
begin
  perform private.require_billing_admin();
  perform private.require_admin_permission('integrations');
  if private.billing_provider() = 'stripe_live' then raise exception 'Switch back to test mode first.'; end if;
  perform set_config('vv.purge_test_billing', 'on', true);
  delete from public.dues_payments r
  where not r.livemode and r.direction = 'refund'
    and exists (select 1 from public.dues_payments o where o.id = r.refunds_payment_id
                and o.source not in ('admin_manual', 'migration_import'));
  get diagnostics v_refunds = row_count;
  delete from public.dues_payments
  where not livemode and direction = 'charge' and source not in ('admin_manual', 'migration_import');
  get diagnostics v_payments = row_count;
  delete from public.billing_customers where not livemode;
  get diagnostics v_customers = row_count;
  delete from public.stripe_webhook_events where not livemode;
  get diagnostics v_events = row_count;
  perform set_config('vv.purge_test_billing', 'off', true);
  perform private.recompute_charge(id) from public.dues_charges;
  v_payments := v_payments + v_refunds;
  perform private.audit_billing('billing_test_data_purged', 'billing_settings', 'dues',
    jsonb_build_object('payments', v_payments, 'customers', v_customers, 'events', v_events));
  return jsonb_build_object('payments', v_payments, 'customers', v_customers, 'events', v_events);
end;
$function$;

-- --- #185: refunds made in the portal are matched, not doubled ----------------------------------
-- Links a portal refund to the "reduce what is owed" credit it wrote, so the
-- credit is written once however the webhook and the admin call interleave.
alter table public.dues_payments add column if not exists credit_adjustment_id uuid references public.dues_adjustments(id);

drop function if exists public.billing_apply_refund(text, text, text, integer, text, text, text);
create or replace function public.billing_apply_refund(
  p_stripe_refund_id text, p_payment_intent text, p_stripe_charge text, p_amount_cents integer, p_status text, p_event_id text,
  p_failure text default null, p_refund_id uuid default null)
returns text language plpgsql security definer set search_path to ''
as $function$
declare
  o public.dues_payments%rowtype;
  r public.dues_payments%rowtype;
  v_status text := case p_status when 'succeeded' then 'succeeded' when 'failed' then 'failed' when 'canceled' then 'canceled' else 'processing' end;
begin
  select * into r from public.dues_payments where stripe_refund_id = p_stripe_refund_id for update;
  if found then
    if r.status = v_status or r.status = 'succeeded' then return 'ignored'; end if;
    update public.dues_payments set status = v_status, stripe_event_id = coalesce(p_event_id, stripe_event_id), failure_message = left(p_failure, 300),
      occurred_at = case when v_status = 'succeeded' then now() else occurred_at end where id = r.id;
    if r.charge_id is not null then perform private.recompute_charge(r.charge_id); end if;
    return 'applied';
  end if;

  select * into o from public.dues_payments
  where direction = 'charge' and ((p_payment_intent is not null and stripe_payment_intent_id = p_payment_intent)
    or (p_stripe_charge is not null and stripe_charge_id = p_stripe_charge))
  limit 1;
  -- Another product, a donation: not a dues payment. Acknowledge it so Stripe stops retrying.
  if not found then return 'not_ours'; end if;

  -- A refund the portal started whose webhook beat billing_attach_refund: the
  -- refund's metadata names our row; failing that, the one pending refund on this
  -- payment for this amount that has not been given its Stripe id yet.
  select * into r from public.dues_payments
  where direction = 'refund' and refunds_payment_id = o.id and stripe_refund_id is null and source = 'admin_manual'
    and status in ('pending', 'processing')
    and ((p_refund_id is not null and id = p_refund_id)
      or (p_refund_id is null and status = 'pending' and amount_cents = p_amount_cents))
  order by created_at limit 1
  for update;
  if found then
    update public.dues_payments set stripe_refund_id = p_stripe_refund_id, stripe_event_id = coalesce(p_event_id, stripe_event_id),
      status = v_status, failure_message = left(p_failure, 300),
      occurred_at = case when v_status = 'succeeded' then now() else occurred_at end
    where id = r.id;
    if r.charge_id is not null then perform private.recompute_charge(r.charge_id); end if;
    return 'applied';
  end if;

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

-- Called once Stripe has accepted the refund. Only now does the household's
-- balance drop, so a refund Stripe refused leaves the books untouched. The
-- webhook may already have matched the row (above); the credit is still written here, once.
create or replace function public.billing_attach_refund(p_refund uuid, p_stripe_refund_id text, p_status text, p_reduce_owed boolean default false)
returns void language plpgsql security definer set search_path to ''
as $function$
declare
  r public.dues_payments%rowtype;
  v_adjustment uuid;
begin
  select * into r from public.dues_payments where id = p_refund and direction = 'refund' for update;
  if not found then return; end if;
  if r.stripe_refund_id is not null and r.stripe_refund_id <> p_stripe_refund_id then
    raise exception 'refund_already_attached';
  end if;
  if r.stripe_refund_id is null then
    if r.status <> 'pending' then return; end if;   -- canceled because Stripe refused it
    update public.dues_payments set stripe_refund_id = p_stripe_refund_id where id = r.id;
  end if;
  if p_reduce_owed and p_status <> 'failed' and p_status <> 'canceled' and r.charge_id is not null and r.credit_adjustment_id is null then
    insert into public.dues_adjustments (charge_id, amount_cents, reason, memo, created_by)
    values (r.charge_id, -r.amount_cents, 'refund_credit', 'Refund of ' || private.money(r.amount_cents) || ' issued', r.initiated_by)
    returning id into v_adjustment;
    update public.dues_charges set adjustment_total_cents = adjustment_total_cents - r.amount_cents where id = r.charge_id;
    update public.dues_payments set credit_adjustment_id = v_adjustment where id = r.id;
  end if;
  perform public.billing_apply_refund(p_stripe_refund_id, null, null, r.amount_cents, p_status, null);
  if r.charge_id is not null then perform private.recompute_charge(r.charge_id); end if;
end;
$function$;

-- --- #208: a reminder goes out once, even if two daily runs overlap -----------------------------
create or replace function public.billing_queue_reminders(p_today date default current_date)
returns integer language plpgsql security definer set search_path to ''
as $function$
declare
  s public.billing_settings%rowtype;
  r record;
  v_claimed integer;
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
    -- The log row is the claim. A second run that got this far waits on the first
    -- run's row, then inserts nothing, and sends nothing.
    insert into public.dues_reminder_log (installment_id, kind) values (r.installment_id, r.kind) on conflict do nothing;
    get diagnostics v_claimed = row_count;
    if v_claimed = 0 then continue; end if;
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

-- --- who may call what ----------------------------------------------------------------------------
revoke all on function public.admin_record_offline_payment(uuid, integer, text, text, date, text) from public, anon;
grant execute on function public.admin_record_offline_payment(uuid, integer, text, text, date, text) to authenticated;
revoke all on function public.admin_purge_test_billing_data() from public, anon;
grant execute on function public.admin_purge_test_billing_data() to authenticated;
revoke all on function public.billing_apply_refund(text, text, text, integer, text, text, text, uuid) from public, anon, authenticated;
grant execute on function public.billing_apply_refund(text, text, text, integer, text, text, text, uuid) to service_role;
revoke all on function public.billing_attach_refund(uuid, text, text, boolean) from public, anon, authenticated;
grant execute on function public.billing_attach_refund(uuid, text, text, boolean) to service_role;
revoke all on function public.billing_queue_reminders(date) from public, anon, authenticated;
grant execute on function public.billing_queue_reminders(date) to service_role;
