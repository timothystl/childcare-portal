-- ============================================================
-- COUNT FAMILY MONTH CARE DAYS
-- ============================================================
-- A small, single-purpose companion to compute_family_month_charges() —
-- returns how many care days a family's invoice for one month actually
-- covers, so a payment receipt can say "12 days of care" alongside the
-- dollar amount. Mirrors compute_family_month_charges()'s exact
-- family-matching logic (parent_email/parent2_email, confirmed
-- registrations only, non-waitlisted dates within the calendar month) so
-- the day count this returns can never disagree with the amount that
-- function already computed for the same family/month.
--
-- Read-only, no amounts, so a much smaller privilege footprint is
-- appropriate: SECURITY DEFINER purely to reach registrations/
-- registration_dates without requiring the caller to hold table grants —
-- reached only from edge functions on the service-role connection
-- (charge-stax-payment / authorizenet-webhook's receipt emails), so it is
-- revoked from every browser-reachable role, same posture as
-- compute_family_month_charges.
-- ============================================================

CREATE OR REPLACE FUNCTION public.count_family_month_care_days(
    p_family_id UUID,
    p_month     TEXT
) RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
    WITH fam AS (
        SELECT f.id,
               lower(trim(f.parent_email)) AS e1,
               lower(trim(COALESCE(f.parent2_email, ''))) AS e2
          FROM families f
         WHERE f.id = p_family_id
    ),
    fam_regs AS (
        SELECT r.id
          FROM registrations r, fam
         WHERE r.status = 'confirmed'
           AND (lower(trim(r.parent_email)) = fam.e1
             OR (fam.e2 <> '' AND lower(trim(r.parent_email)) = fam.e2))
    )
    SELECT count(*)::int
      FROM registration_dates rd
      JOIN fam_regs fr ON fr.id = rd.registration_id
     WHERE COALESCE(rd.waitlisted, false) = false
       AND rd.care_date >= (p_month || '-01')::date
       AND rd.care_date <  ((p_month || '-01')::date + interval '1 month');
$$;

REVOKE EXECUTE ON FUNCTION public.count_family_month_care_days(UUID, TEXT)
    FROM PUBLIC, anon, authenticated;
