-- ============================================================
-- ROLLBACK for tighten_anon_rls_policies.sql
-- ============================================================
-- ONLY run this if a smoke test fails after applying
-- tighten_anon_rls_policies.sql — it re-creates the exact anon/public
-- policies that were dropped, restoring the previous behaviour.
-- (Recreating these RE-OPENS the PII/pay/tamper exposure, so use it only as
-- a temporary unblock, then tell the assistant which flow broke so we can add
-- a scoped policy or RPC instead.)
-- ============================================================

CREATE POLICY "anon select families"   ON families FOR SELECT TO anon USING (true);
CREATE POLICY "anon update families"   ON families FOR UPDATE TO anon USING (true) WITH CHECK (true);

CREATE POLICY "anon select students"   ON students FOR SELECT TO anon USING (true);
CREATE POLICY "anon update students"   ON students FOR UPDATE TO anon USING (true) WITH CHECK (true);
CREATE POLICY "anon delete students"   ON students FOR DELETE TO anon USING (true);

CREATE POLICY "Anon PIN lookup"        ON staff    FOR SELECT TO public USING (true);
CREATE POLICY "anon read active staff" ON staff    FOR SELECT TO anon   USING (active = true);
