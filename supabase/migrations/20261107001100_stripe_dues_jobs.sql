-- Schedules the daily dues run, and gives the Stripe edge functions the table
-- access they read directly (everything they write goes through the functions
-- in the schema migration).

grant select on public.billing_settings, public.billing_customers, public.dues_charges, public.dues_payments,
  public.dues_installments, public.dues_payment_plans to service_role;
grant update on public.billing_customers to service_role;

-- Once a day at 14:00 UTC (9am Central in summer, 8am in winter): tidy abandoned
-- attempts, queue installment reminders, drop old Stripe payloads, and collect
-- each household's next due installment from the method it saved. With billing
-- off, or no Stripe key in Vault, the function only does the housekeeping.
-- Reuses the shared secret deliver-emails and deliver-push already read from Vault.
select cron.unschedule('dues-daily')
where exists (select 1 from cron.job where jobname = 'dues-daily');

select cron.schedule(
  'dues-daily',
  '0 14 * * *',
  $$
  select net.http_post(
    url := 'https://jtwemgyhxylbhjzxgyvh.supabase.co/functions/v1/dues-daily',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-delivery-secret', (select decrypted_secret from vault.decrypted_secrets where name = 'EMAIL_DELIVERY_SECRET')
    ),
    body := jsonb_build_object('mode', 'process')
  )
  where (select provider from public.billing_settings where id = 'dues') <> 'off';
  $$
);
