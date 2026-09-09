-- Public registration is the only anonymous workflow that needs to create a
-- draft invoice. Reconcile inside that transaction, then remove the separate
-- email-address billing endpoint so billing cannot be triggered independently.

CREATE TABLE IF NOT EXISTS private.registration_submission_audit (
    id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    submitted_at    timestamptz NOT NULL DEFAULT now(),
    email_hash      text NOT NULL,
    month_key       text NOT NULL,
    registration_id bigint NOT NULL,
    invoice_id      bigint
);

REVOKE ALL ON TABLE private.registration_submission_audit
    FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE private.registration_submission_audit_id_seq
    FROM PUBLIC, anon, authenticated;

CREATE INDEX IF NOT EXISTS registration_submission_audit_submitted_at_idx
    ON private.registration_submission_audit (submitted_at DESC);

CREATE OR REPLACE FUNCTION public.submit_registration(p_payload jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
    v_id          bigint;
    v_month       text;
    v_status      text;
    v_submitted   text;
    v_email       text;
    v_dates       jsonb := COALESCE(p_payload->'dates', '[]'::jsonb);
    v_family_id   uuid;
    v_invoice_id  bigint;
    v_is_admin    boolean := COALESCE(public.is_admin(), false);
BEGIN
    v_status := COALESCE(p_payload->>'status', 'confirmed');
    IF v_status NOT IN ('confirmed', 'waitlist') THEN
        RAISE EXCEPTION 'invalid status';
    END IF;

    SELECT to_char(min((d->>'date')::date), 'YYYY-MM') INTO v_month
      FROM jsonb_array_elements(v_dates) d;
    IF v_month IS NULL THEN
        RAISE EXCEPTION 'at least one registration date is required';
    END IF;

    v_email := lower(trim(p_payload->>'parent_email'));
    IF v_email IS NULL OR v_email = '' THEN
        RAISE EXCEPTION 'parent email is required';
    END IF;

    -- Ten registrations for one address/month within 15 minutes is comfortably
    -- above legitimate family use while bounding anonymous database work. The
    -- rolling window avoids permanently locking a family out after mistakes.
    IF NOT v_is_admin AND (
        SELECT count(*)
          FROM public.registrations r
         WHERE lower(trim(r.parent_email)) = v_email
           AND r.month_key = v_month
           AND r.created_at >= now() - interval '15 minutes'
    ) >= 10 THEN
        RAISE EXCEPTION 'registration submission limit reached; please try again later';
    END IF;

    v_submitted := COALESCE(p_payload->>'submitted_by', 'parent1');
    IF NOT v_is_admin AND v_submitted NOT IN ('parent1', 'parent2') THEN
        v_submitted := 'parent1';
    END IF;

    INSERT INTO public.registrations (
        parent_name, parent_email, parent_phone,
        child_name, child_age, child_dob,
        room_id, status, submitted_by, month_key
    ) VALUES (
        p_payload->>'parent_name',
        v_email,
        p_payload->>'parent_phone',
        p_payload->>'child_name',
        (p_payload->>'child_age')::int,
        nullif(p_payload->>'child_dob','')::date,
        p_payload->>'room_id',
        v_status,
        v_submitted,
        v_month
    ) RETURNING id INTO v_id;

    INSERT INTO public.registration_dates (
        registration_id, room_id, care_date, waitlisted, day_type
    )
    SELECT v_id,
           COALESCE(d->>'room_id', p_payload->>'room_id'),
           (d->>'date')::date,
           COALESCE((d->>'waitlisted')::boolean, false),
           d->>'day_type'
      FROM jsonb_array_elements(v_dates) d;

    SELECT f.id INTO v_family_id
      FROM public.families f
     WHERE lower(trim(f.parent_email)) = v_email
        OR lower(trim(COALESCE(f.parent2_email, ''))) = v_email
     LIMIT 1;

    IF v_family_id IS NOT NULL THEN
        v_invoice_id := public._reconcile_billing_invoice_internal(v_family_id, v_month::char(7));
    END IF;

    INSERT INTO private.registration_submission_audit (
        email_hash, month_key, registration_id, invoice_id
    ) VALUES (
        encode(extensions.digest(v_email, 'sha256'), 'hex'),
        v_month, v_id, v_invoice_id
    );

    RETURN (SELECT to_jsonb(r) FROM public.registrations r WHERE r.id = v_id);
END;
$$;

REVOKE EXECUTE ON FUNCTION public.submit_registration(jsonb) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.submit_registration(jsonb) TO anon, authenticated;

REVOKE EXECUTE ON FUNCTION public.create_billing_invoice_by_email(text, char(7))
    FROM PUBLIC, anon, authenticated;
REVOKE EXECUTE ON FUNCTION public.create_billing_invoice_by_email(text, char(7), numeric)
    FROM PUBLIC, anon, authenticated;
DROP FUNCTION IF EXISTS public.create_billing_invoice_by_email(text, char(7), numeric);
DROP FUNCTION IF EXISTS public.create_billing_invoice_by_email(text, char(7));
