-- ============================================================
-- Stax pilot rollout gate
-- ============================================================
-- Per docs/STAX_GO_LIVE.md §4: as built, flipping STAX_ENVIRONMENT and
-- STAX_PAYMENTS_ENABLED turns "Pay online" on for every family at once, with
-- no way to start with a small pilot group first. This adds that gate.
--
-- Defaults to false, so the column's mere existence changes nothing for any
-- family until an admin explicitly opts one in from the Finance -> Ledger
-- drawer. Enforced server-side in create-stax-charge and charge-stax-payment
-- (never only hidden in the UI, per this repo's own rule that UI hiding is
-- not authorization) so a family cannot reach a real charge by calling the
-- API directly before being enabled.
--
-- No RLS change needed: public.families already carries "admin any role"
-- (FOR ALL TO authenticated USING (is_admin())), which covers this column
-- for the admin UI, and the two edge functions read/write it with the
-- service-role key, which bypasses RLS entirely.
ALTER TABLE public.families
    ADD COLUMN IF NOT EXISTS stax_pilot_enabled boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.families.stax_pilot_enabled IS
    'Stax online-payment pilot allowlist. Must be true for create-stax-charge/charge-stax-payment to let this family pay online. See docs/STAX_GO_LIVE.md.';
