-- Authorize.net is retired as a payment processor (2026-08-30). Stax is the
-- only one. Its reconciliation job has nothing left to reconcile: the edge
-- function it calls is now an inert 410 stub, and billing_payments has never
-- held a single row with processor = 'authorizenet'.
--
-- Unscheduled rather than left running: a cron job POSTing every day to a
-- function that answers 410 is noise in the run log that hides a real failure.
-- reconcile-stax-payments (every 30 min) is untouched.
do $$
begin
    if exists (select 1 from cron.job where jobname = 'reconcile-anet-payments') then
        perform cron.unschedule('reconcile-anet-payments');
    end if;
end $$;
