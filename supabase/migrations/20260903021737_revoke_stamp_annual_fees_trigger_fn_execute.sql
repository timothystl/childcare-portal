-- Supabase grants EXECUTE on every new function to anon/authenticated by
-- default (the same trap NEW-1/SX1/R26/R27 already document repeatedly in
-- this schema). This is a TRIGGER function — NEW/OLD only exist inside an
-- actual trigger firing, so a direct RPC call would error rather than do
-- anything useful — but the advisor is right that it should never have been
-- reachable at all. Revoke from both anon and authenticated, and PUBLIC,
-- matching this schema's own established fix pattern.
revoke all on function public._stamp_annual_fees_on_invoice_sent() from public, anon, authenticated;
