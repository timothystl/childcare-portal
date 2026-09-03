-- Folds the annual supply fee and one-time new-family fee into the invoice
-- amount `reconcile_billing_invoice()` actually writes, and stamps them paid
-- only once the invoice is actually SENT — never at draft time, since a draft
-- can be recomputed or discarded without ever becoming a real bill.
--
-- Root cause this closes: computeBillMonthExceptions() (Bill the Month /
-- Ledger, admin-bill-month.js) has always DISPLAYED the annual supply fee as
-- part of a family's total and let the director approve/send on that basis,
-- but compute_family_month_charges() — the function reconcile_billing_invoice()
-- actually calls to write the real invoice amount — never included it. The
-- fee was shown, "approved", and then silently never charged, and because
-- nothing ever stamped reg_fee_paid_year through this path, the same note
-- reappeared on every later month forever. The only thing that ever stamped
-- it was the separate Family Billing Summary report tool, which had not
-- actually been re-run since the Sept 1 renewal (verified live before this
-- migration: zero students anywhere carried the new cycle's stamp).
--
-- Scope, confirmed directly with the director: only actively enrolled
-- families with real care days THIS month should be charged the fee here —
-- which is exactly what "has a real, non-waitlisted care day in this month"
-- already restricts to below.
--
-- ⚠️ DELIBERATELY NOT folded into compute_family_month_charges() itself.
-- That function is re-run on every recompute (a schedule change calls
-- _recomputeInvoice(), which calls this same chain) — if the fee lived there,
-- it would vanish from the computed total the moment reg_fee_paid_year gets
-- stamped, and a later schedule-change adjustment would show a spurious
-- NEGATIVE delta equal to the fee (looking like a refund) purely because the
-- live recompute stopped including something the family had already been
-- correctly charged once. Instead the fee is added exactly once, at the
-- moment a family's ORIGINAL invoice for a cycle is first drafted (while
-- still unissued), and the amount is stamped onto that invoice row
-- (annual_fee_amount) so every later adjustment for the same cycle can add
-- it back into the comparison instead of losing it.

alter table public.billing_invoices
  add column if not exists annual_fee_amount numeric(10,2) not null default 0;
comment on column public.billing_invoices.annual_fee_amount is
  'Portion of this invoice''s original final_amount that was the annual supply fee and/or new-family fee, not tuition. Set once, on the original invoice, when first drafted unissued; read back by later adjustment recomputes so a schedule change never appears to "refund" the fee.';

-- ── Shared helper: who owes what, for one family/month ──
-- STABLE, writes nothing itself — callers decide whether to stamp. Restricted
-- to children who have a real billed day this month, matching "current days
-- in September" exactly.
create or replace function public._family_month_annual_fees(p_family_id uuid, p_month text)
returns table(reg_fee numeric, new_family_fee numeric, owing_student_ids uuid[],
              owes_new_family_fee boolean, cycle_year int)
language plpgsql
stable security definer
set search_path to 'public'
as $function$
declare
    v_month_start date;
    v_month_end   date;
    v_reg_fee_amount   numeric;
    v_new_family_fee   numeric;
    v_supply_fee_max   numeric;
    v_renewal_md       text;
    v_today_md         text;
    v_cycle_year       int;
    v_owed_ids         uuid[];
    v_raw_supply       numeric;
    v_reg_fee          numeric;
    v_owes_new_family  boolean;
begin
    v_month_start := (p_month || '-01')::date;
    v_month_end   := (v_month_start + interval '1 month')::date;

    select nullif(regexp_replace(coalesce(value, ''), '[^0-9.]', '', 'g'), '')::numeric
      into v_reg_fee_amount from settings where key = 'registration_fee';
    select nullif(regexp_replace(coalesce(value, ''), '[^0-9.]', '', 'g'), '')::numeric
      into v_new_family_fee from settings where key = 'new_family_fee';
    select nullif(regexp_replace(coalesce(value, ''), '[^0-9.]', '', 'g'), '')::numeric
      into v_supply_fee_max from settings where key = 'supply_fee_family_max';
    select value into v_renewal_md from settings where key = 'registration_fee_renewal_date';

    v_reg_fee_amount := coalesce(v_reg_fee_amount, 0);
    v_new_family_fee := coalesce(v_new_family_fee, 0);
    v_supply_fee_max := coalesce(v_supply_fee_max, 0);
    if v_renewal_md !~ '^\d{2}-\d{2}$' then v_renewal_md := '01-01'; end if;

    v_today_md   := to_char(now() at time zone 'America/Chicago', 'MM-DD');
    v_cycle_year := extract(year from (now() at time zone 'America/Chicago'))::int;
    if v_today_md < v_renewal_md then v_cycle_year := v_cycle_year - 1; end if;

    -- Children of this family who actually have a real, non-waitlisted care
    -- day in this month (same population compute_family_month_charges bills),
    -- and who haven't been stamped paid for the current cycle yet.
    select array_agg(distinct s.id)
      into v_owed_ids
      from students s
      join families f on f.id = s.family_id
      where f.id = p_family_id
        and (s.reg_fee_paid_year is null or s.reg_fee_paid_year <> v_cycle_year)
        and exists (
            select 1
              from registrations r
              join registration_dates rd on rd.registration_id = r.id
             where r.status = 'confirmed'
               and lower(trim(r.child_name)) = lower(trim(s.child_name))
               and (lower(trim(r.parent_email)) = lower(trim(f.parent_email))
                 or (coalesce(f.parent2_email, '') <> ''
                     and lower(trim(r.parent_email)) = lower(trim(f.parent2_email))))
               and coalesce(rd.waitlisted, false) = false
               and rd.care_date >= v_month_start
               and rd.care_date <  v_month_end
        );

    v_raw_supply := coalesce(array_length(v_owed_ids, 1), 0) * v_reg_fee_amount;
    v_reg_fee := case when v_supply_fee_max > 0 and v_raw_supply > v_supply_fee_max
                       then v_supply_fee_max else v_raw_supply end;
    if v_reg_fee_amount <= 0 then v_reg_fee := 0; v_owed_ids := null; end if;

    select (v_new_family_fee > 0 and not f.new_family_fee_charged)
        and exists (
            select 1
              from registrations r
              join registration_dates rd on rd.registration_id = r.id
             where r.status = 'confirmed'
               and (lower(trim(r.parent_email)) = lower(trim(f.parent_email))
                 or (coalesce(f.parent2_email, '') <> ''
                     and lower(trim(r.parent_email)) = lower(trim(f.parent2_email))))
               and coalesce(rd.waitlisted, false) = false
               and rd.care_date >= v_month_start
               and rd.care_date <  v_month_end
        )
      into v_owes_new_family
      from families f where f.id = p_family_id;

    return query select
        v_reg_fee,
        case when coalesce(v_owes_new_family, false) then v_new_family_fee else 0 end,
        v_owed_ids,
        coalesce(v_owes_new_family, false),
        v_cycle_year;
end;
$function$;

revoke all on function public._family_month_annual_fees(uuid, text) from public, anon, authenticated;

-- ── _reconcile_billing_invoice_internal: add the fee once, at first draft ──
create or replace function public._reconcile_billing_invoice_internal(p_family_id uuid, p_month text)
returns bigint
language plpgsql
security definer
set search_path to 'public'
as $function$
DECLARE
    v_cycle_id     bigint;
    v_invoice_id   bigint;
    v_base         numeric(10,2);
    v_final        numeric(10,2);
    v_issued_count integer;
    v_baseline     numeric(10,2);
    v_delta        numeric(10,2);
    v_next_seq     integer;
    v_fee_reg      numeric;
    v_fee_new      numeric;
    v_fee_total    numeric;
    v_orig_fee     numeric;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM families WHERE id = p_family_id) THEN
        RETURN NULL;
    END IF;

    PERFORM pg_advisory_xact_lock(hashtextextended(p_family_id::text || ':' || p_month, 0));

    SELECT c.base, c.final INTO v_base, v_final
      FROM public.compute_family_month_charges(p_family_id, p_month) c;
    v_base  := GREATEST(COALESCE(v_base, 0), 0);
    v_final := GREATEST(COALESCE(v_final, 0), 0);

    SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;
    IF v_cycle_id IS NULL THEN
        IF v_base = 0 AND v_final = 0 THEN RETURN NULL; END IF;
        INSERT INTO billing_cycles (month) VALUES (p_month)
        ON CONFLICT (month) DO NOTHING;
        SELECT id INTO v_cycle_id FROM billing_cycles WHERE month = p_month;
    END IF;

    SELECT count(*), COALESCE(sum(final_amount), 0)
      INTO v_issued_count, v_baseline
      FROM billing_invoices
     WHERE cycle_id = v_cycle_id
       AND family_id = p_family_id
       AND status IN ('sent', 'finalized', 'paid', 'partial');

    IF v_issued_count = 0 THEN
        -- Annual supply / new-family fees are added exactly here, the one
        -- time a family's original invoice for a cycle is created or updated
        -- while still unissued — see this file's own header for why they
        -- never live inside compute_family_month_charges() itself.
        SELECT f.reg_fee, f.new_family_fee INTO v_fee_reg, v_fee_new
          FROM public._family_month_annual_fees(p_family_id, p_month) f;
        v_fee_total := COALESCE(v_fee_reg, 0) + COALESCE(v_fee_new, 0);
        v_base  := v_base  + v_fee_total;
        v_final := v_final + v_fee_total;

        IF v_base = 0 AND v_final = 0 THEN
            DELETE FROM billing_invoices
             WHERE cycle_id = v_cycle_id
               AND family_id = p_family_id
               AND status IN ('draft', 'void');
            RETURN NULL;
        END IF;

        INSERT INTO billing_invoices (
            cycle_id, family_id, base_amount, discount_amount,
            adjustment_amount, adjustment_note, final_amount,
            status, invoice_type, sequence, annual_fee_amount
        ) VALUES (
            v_cycle_id, p_family_id, v_base, GREATEST(v_base - v_final, 0),
            0, '', v_final, 'draft', 'original', 1, v_fee_total
        )
        ON CONFLICT (cycle_id, family_id, sequence) DO UPDATE
            SET base_amount       = EXCLUDED.base_amount,
                discount_amount   = EXCLUDED.discount_amount,
                adjustment_amount = 0,
                adjustment_note   = '',
                final_amount      = EXCLUDED.final_amount,
                annual_fee_amount = EXCLUDED.annual_fee_amount,
                status            = 'draft'
          WHERE billing_invoices.status IN ('draft', 'void')
            AND billing_invoices.invoice_type = 'original'
        RETURNING id INTO v_invoice_id;

        IF v_invoice_id IS NULL THEN
            SELECT id INTO v_invoice_id
              FROM billing_invoices
             WHERE cycle_id = v_cycle_id
               AND family_id = p_family_id
               AND sequence = 1;
        END IF;
        RETURN v_invoice_id;
    END IF;

    -- Add back whatever fee was baked into the ORIGINAL invoice, so a pure
    -- tuition-only recompute (compute_family_month_charges never includes
    -- the fee) doesn't read as a spurious "refund" of a fee already charged.
    SELECT annual_fee_amount INTO v_orig_fee
      FROM billing_invoices
     WHERE cycle_id = v_cycle_id AND family_id = p_family_id AND invoice_type = 'original'
     ORDER BY sequence LIMIT 1;
    v_final := v_final + COALESCE(v_orig_fee, 0);

    v_delta := round(v_final - v_baseline, 2);
    IF v_delta = 0 THEN
        DELETE FROM billing_invoices
         WHERE cycle_id = v_cycle_id
           AND family_id = p_family_id
           AND status = 'draft'
           AND invoice_type = 'adjustment';
        RETURN NULL;
    END IF;

    SELECT id INTO v_invoice_id
      FROM billing_invoices
     WHERE cycle_id = v_cycle_id
       AND family_id = p_family_id
       AND status = 'draft'
       AND invoice_type = 'adjustment';

    IF v_invoice_id IS NOT NULL THEN
        UPDATE billing_invoices
           SET base_amount = v_delta,
               discount_amount = 0,
               adjustment_amount = 0,
               adjustment_note = '',
               final_amount = v_delta,
               reason = 'Schedule changed after the invoice was issued'
         WHERE id = v_invoice_id;
        RETURN v_invoice_id;
    END IF;

    SELECT COALESCE(max(sequence), 0) + 1 INTO v_next_seq
      FROM billing_invoices
     WHERE cycle_id = v_cycle_id AND family_id = p_family_id;

    INSERT INTO billing_invoices (
        cycle_id, family_id, base_amount, discount_amount,
        adjustment_amount, adjustment_note, final_amount,
        status, invoice_type, sequence, parent_invoice_id, reason
    ) VALUES (
        v_cycle_id, p_family_id, v_delta, 0, 0, '', v_delta,
        'draft', 'adjustment', v_next_seq,
        (SELECT id FROM billing_invoices
          WHERE cycle_id = v_cycle_id AND family_id = p_family_id
            AND invoice_type = 'original'
          ORDER BY sequence LIMIT 1),
        'Schedule changed after the invoice was issued'
    ) RETURNING id INTO v_invoice_id;

    RETURN v_invoice_id;
END;
$function$;

-- ── Stamp paid only once the invoice is actually sent, never at draft time ──
create or replace function public._stamp_annual_fees_on_invoice_sent()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
    v_month text;
    v_fees  record;
begin
    -- Only the original invoice ever carries a fee (annual_fee_amount is
    -- only ever set on invoice_type = 'original' — see
    -- _reconcile_billing_invoice_internal). An adjustment invoice being sent
    -- has nothing new to stamp.
    if new.invoice_type <> 'original' then return new; end if;

    select bc.month into v_month from billing_cycles bc where bc.id = new.cycle_id;
    if v_month is null then return new; end if;

    select * into v_fees from public._family_month_annual_fees(new.family_id, v_month);

    if v_fees.owing_student_ids is not null and array_length(v_fees.owing_student_ids, 1) > 0 then
        update students
           set reg_fee_paid_year = v_fees.cycle_year
         where id = any(v_fees.owing_student_ids);
    end if;

    if coalesce(v_fees.owes_new_family_fee, false) then
        update families set new_family_fee_charged = true where id = new.family_id;
    end if;

    return new;
end;
$function$;

drop trigger if exists stamp_annual_fees_on_invoice_sent on billing_invoices;
create trigger stamp_annual_fees_on_invoice_sent
    after update on billing_invoices
    for each row
    when (old.sent_at is null and new.sent_at is not null)
    execute function public._stamp_annual_fees_on_invoice_sent();
