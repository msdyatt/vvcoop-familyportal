-- Dues checkout fixes from the November 2026 bug bash (#169, #186).
--
-- #169: a payment attempt the portal had canceled (an admin cancel, the app
-- taking over from a Checkout page, or the two-day cleanup) can still succeed at
-- Stripe. Until now the webhook answered 'ignored' and the money was never
-- credited. Now Stripe's word wins: the row moves from canceled to succeeded (or
-- processing for a bank transfer), the household is credited, and administrators
-- are told so they can check for a second payment.
--
-- #186: "Pay the full balance" could reopen an earlier installment-sized
-- attempt. billing_begin_payment now says when the attempt in flight is for a
-- different amount than this request would charge, so the checkout function
-- closes it and starts the right one.

-- --- the ledger guard: canceled may move forward only when Stripe confirms the money -------
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
    or (old.status = 'succeeded' and new.status = 'failed')
    -- Stripe took the money for an attempt the portal had given up on. Only
    -- billing_apply_payment_update sets this switch, after re-reading Stripe.
    or (old.status = 'canceled' and new.status in ('processing', 'succeeded') and old.direction = 'charge'
        and coalesce(current_setting('vv.stripe_revive', true), '') = 'on')) then
    raise exception 'A % payment cannot become %.', old.status, new.status using errcode = '23000';
  end if;

  new.updated_at := now();
  return new;
end;
$function$;

-- --- starting a payment: say when the attempt in flight is for another amount ----------------
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
  v_saved boolean;
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

  -- What this request would charge: the next installment, or the whole balance.
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

  select id, amount_cents, status, stripe_checkout_session_id, stripe_payment_intent_id into v_exist
  from public.dues_payments where charge_id = p_charge and direction = 'charge' and status in ('pending', 'processing') limit 1;
  if found then
    -- amount_mismatch: the attempt in flight is for another amount (an installment
    -- when the family now asks to pay it all, or the other way round). The checkout
    -- function closes it at Stripe, cancels it, and asks again.
    return jsonb_build_object('payment_id', v_exist.id, 'amount_cents', v_exist.amount_cents, 'existing', true,
      'status', v_exist.status, 'checkout_session_id', v_exist.stripe_checkout_session_id,
      'payment_intent_id', v_exist.stripe_payment_intent_id,
      'amount_mismatch', v_exist.status = 'pending' and v_exist.amount_cents <> v_amount,
      'wanted_amount_cents', v_amount);
  end if;

  -- Automatic payments only make sense with a plan to collect against.
  v_saved := coalesce(p_autopay, false) and pl.id is not null;
  insert into public.dues_payments (charge_id, family_id, installment_id, direction, amount_cents, status, source, livemode,
    saved_for_autopay, initiated_by)
  values (p_charge, c.family_id, v_inst, 'charge', v_amount, 'pending', 'portal', v_provider = 'stripe_live', v_saved, p_user)
  returning id into v_id;

  return jsonb_build_object('payment_id', v_id, 'amount_cents', v_amount, 'existing', false, 'status', 'pending',
    'checkout_session_id', null, 'family_id', c.family_id, 'saved_for_autopay', v_saved, 'installment_id', v_inst,
    'livemode', v_provider = 'stripe_live');
end;
$function$;

-- --- applying Stripe's word: a canceled attempt that Stripe says was paid is credited ----------
create or replace function public.billing_apply_payment_update(p_payment uuid, p_status text, p_event_id text, p_fields jsonb default '{}'::jsonb)
returns text language plpgsql security definer set search_path to ''
as $function$
declare
  pay public.dues_payments%rowtype;
  s public.billing_settings%rowtype;
  v_allowed boolean;
  v_revive boolean := false;
  v_title text;
  v_attempts integer;
  v_family text;
begin
  select * into pay from public.dues_payments where id = p_payment for update;
  if not found then raise exception 'payment_not_found'; end if;
  select * into s from public.billing_settings where id = 'dues';
  v_family := coalesce((select f.display_name from public.families f where f.id = pay.family_id), 'A household');

  -- Stripe re-read says the money moved for an attempt the portal had canceled.
  if pay.status = 'canceled' and pay.direction = 'charge' and p_status in ('processing', 'succeeded') then
    -- Only one attempt may be in flight per charge. If the family already opened a
    -- new one, a clearing bank transfer waits here; its 'succeeded' event (which
    -- does not count as in flight) is credited when it arrives.
    if p_status = 'processing' and pay.charge_id is not null and exists (
         select 1 from public.dues_payments x where x.charge_id = pay.charge_id and x.id <> pay.id
           and x.direction = 'charge' and x.status in ('pending', 'processing')) then
      perform private.notify_admins('payment_revived', 'A canceled dues payment is clearing at Stripe',
        v_family || ': ' || private.money(pay.amount_cents) || ' that the portal had canceled is now clearing at Stripe, while another payment is open. Check the household before it pays twice.',
        'dues_payment', pay.id);
      return 'flagged';
    end if;
    v_revive := true;
  end if;

  v_allowed := p_status = pay.status or v_revive
    or (pay.status = 'pending' and p_status in ('processing', 'succeeded', 'failed', 'canceled'))
    or (pay.status = 'processing' and p_status in ('succeeded', 'failed', 'canceled'))
    or (pay.status = 'succeeded' and p_status = 'failed');
  if not v_allowed then return 'ignored'; end if;

  if v_revive then perform set_config('vv.stripe_revive', 'on', true); end if;
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
  if v_revive then perform set_config('vv.stripe_revive', 'off', true); end if;

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

  if v_revive then
    perform private.notify_admins('payment_revived', 'A canceled dues payment went through at Stripe',
      v_family || ': ' || private.money(pay.amount_cents) || ' that the portal had canceled '
        || case when p_status = 'succeeded' then 'was paid at Stripe and has been credited.' else 'is clearing at Stripe and will be credited when it settles.' end
        || ' Check whether the household also paid again.', 'dues_payment', pay.id);
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
        v_family || ': ' || private.money(pay.amount_cents)
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

-- create or replace keeps the existing grants (service role only); restated for clarity.
revoke all on function public.billing_begin_payment(uuid, uuid, boolean, boolean) from public, anon, authenticated;
grant execute on function public.billing_begin_payment(uuid, uuid, boolean, boolean) to service_role;
revoke all on function public.billing_apply_payment_update(uuid, text, text, jsonb) from public, anon, authenticated;
grant execute on function public.billing_apply_payment_update(uuid, text, text, jsonb) to service_role;
