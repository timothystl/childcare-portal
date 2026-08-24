# Billing Model — one channel, immutable invoices, reviewed adjustments

**Status:** implemented. Adjustment schema agreed 2026-08-11; invoice-integrity consolidation added 2026-08-24.
**Supersedes:** the ad-hoc invoice writes described in `docs/CODE_REVIEW.md` (FS3, FS5).

---

## Why

Billing is the center's biggest operational problem. Before this system it was pen
and paper, with errors that mostly ran toward **under**-billing.

What has actually been billing families is **Family Billing Summary**, which
recomputes from live registration data every time it is opened. Its numbers are
correct. What was missing is not accuracy — it is *the record*: what was sent, when,
and what has been paid against it.

The **Invoices** tool (Finance → Invoices,
`#invoicesSection`, `renderInvoicesTool()` in `js/admin/admin-billing.js`) added the
draft → issued path that never existed, and `add_invoice_send_stamp.sql` (applied
2026-08-11) gave `billing_invoices` the `sent_at` / `sent_to` columns. Marking sent
sets `status = 'sent'`, and `saveInvoiceDrafts()` skips any row that already has
`sent_at` — so issued bills are already protected from being rewritten.

That establishes the **issued boundary** this model needs. Schedule changes after
that boundary are reconciled against everything already issued and produce one
reviewable draft adjustment. Normal invoice tools call the database reconciler and
do not submit a browser-calculated amount.

That record is also the precondition for taking card payments. You cannot charge a
saved card for "what this family owes" when nothing durably states what they owe.

---

## The model

### 1. An issued invoice is immutable

An invoice is a record of what the center told a family they owe. Once issued it is
never edited. Changes produce a **new document** that references it.

This is what makes the number defensible when a parent asks why it differs from the
email they received.

### 2. Registration issues the original

A parent registers for a month, receives a confirmation email with a total, and that
email **is** the invoice. It is issued at that moment, typically before the month of
care begins. Most families never change after this.

### 3. Every later change drafts an adjustment

Any change to a child's days after the original is issued — director adds a day, a
parent registers extra days, a day is removed, a full day becomes a half — produces a
**draft adjustment** for that family and month.

```
adjustment = compute_family_month_charges(family, month).final
           − SUM(final_amount) of all non-void invoices for that family + month
```

Positive is an extra charge, negative is a credit. The comparison is always against
*what has already been issued*, which is precisely "compare against the first
invoice" generalised to work when there is more than one.

### 4. The director reviews and issues

Adjustments never go out automatically. They sit as drafts until she reviews and
issues them. Credits work identically — drafted, reviewed, issued by her.

**One pending draft adjustment per family per month.** Repeated edits update that
same draft rather than spawning one per click, so she reviews one net adjustment
instead of eleven.

### 5. The family sees one bill

Documents are immutable underneath; the statement consolidates them:

```
August 2026
  Original invoice            1 Aug        $500.00
  Adjustment — 2nd child added 10 Aug      $400.00
  ──────────────────────────────────────────────────
  Month total                              $900.00
  Paid                                    −$500.00
  Balance due                              $400.00
```

"Amend the original" describes this presentation, not the storage.

---

## Consequences to expect

**Sibling credits land on a child whose schedule did not change.** Adding a second
child triggers the $10/day sibling discount, so the adjustment carries a credit
against the *first* child. This is correct and will appear as a line on the
statement.

**The parent quote must be family-aware.** When a parent registers a second child in
a separate session, today's quote does not see the first child's booked days, so it
misses the sibling discount — the bug behind the Millman / Heck / Smith invoices.
Once the confirmation email *is* an issued invoice, it has to be right when sent.
Making the parent-side quote family-aware is part of this work, not a follow-up.

---

## Schema

```sql
ALTER TABLE billing_invoices
    ADD COLUMN invoice_type      text   NOT NULL DEFAULT 'original',  -- 'original' | 'adjustment'
    ADD COLUMN sequence          int    NOT NULL DEFAULT 1,
    ADD COLUMN parent_invoice_id bigint REFERENCES billing_invoices(id),
    ADD COLUMN issued_at         timestamptz,
    ADD COLUMN issued_by         text,
    ADD COLUMN reason            text;   -- why this adjustment exists

-- One invoice per family per month no longer holds — adjustments need siblings.
ALTER TABLE billing_invoices DROP CONSTRAINT billing_invoices_cycle_id_family_id_key;
ALTER TABLE billing_invoices ADD  CONSTRAINT billing_invoices_cycle_family_seq_key
    UNIQUE (cycle_id, family_id, sequence);

-- Only one pending draft adjustment per family per month.
CREATE UNIQUE INDEX billing_invoices_one_pending_draft
    ON billing_invoices (cycle_id, family_id)
    WHERE status = 'draft' AND invoice_type = 'adjustment';
```

`status`: `draft` → `sent` → `paid` / `partial`, plus `void`. **`sent` is the issued
boundary** and already exists — `markInvoicesSent()` sets it alongside `sent_at`.
Nothing in this model introduces a new status.

A family's balance for a month is
`SUM(final_amount) WHERE status <> 'void'` − `SUM(payments)`.

---

## What changes in code

**`create_billing_invoice_by_email`** currently recomputes and overwrites the draft,
and refuses to touch anything that is not `status = 'draft'`. That guard is already
correct; it simply does nothing useful once a bill has been sent. It gains a branch:

- no `sent` invoice for this family+month → write/refresh the **original** draft, as now
- a `sent` invoice exists → leave it alone; upsert the single **pending draft
  adjustment** carrying the computed delta
- delta is zero → delete any pending draft adjustment (the change cancelled out)

**`_recomputeInvoice()`** in `js/admin/admin-calendar.js` keeps its current role —
every mutation path calls it, and the branch above decides what that means. The
eight-paths-one-recompute work already done is the foundation this sits on; nothing
there needs revisiting.

⚠️ **Never reintroduce a delta-based write.** A delta requires every mutation site to
opt in, and five of eight silently did not, which is how invoices came to only ever
ratchet upward.

**UI — extend the Invoices tool, don't add a third place.** Finance → Invoices is
already the billing screen. It gains:

- a **review queue** of pending draft adjustments, with Issue / Discard on each
- per family, a month view: original, issued adjustments, pending draft, balance
- print / export a consolidated month statement per family

Family Billing Summary stays a read-only report — it is the calculation preview, and
Jacinda is used to it. The Invoices tool is where money becomes a record.

`generateDraftInvoices()` in admin-billing.js is superseded dead code — its
`generateInvoicesBtn` / `invoicePreviewWrap` / `createCycleBtn` elements have never
existed in `admin.html`. Delete it as part of this work so there is one path, not a
live one and a ghost.

---

## Open question: the 495 existing rows

Every invoice from April onward is `draft` and none reflects what was actually
billed (families were billed off Family Billing Summary). Recomputing April–July
would re-bill closed months with facts that arrived later — July alone would move
**+$5,250** — so those must not be rewritten.

Proposed: mark **April–July** as `issued` with `reason = 'pre-system record'`, freezing
them as-is without claiming they are accurate, and start clean from **August**, whose
recompute lands about **$1,000 lower** (the sibling-discount and double-count
corrections, in families' favor).

Needs a decision with the director before anything is written.

---

## Open question: when is the original issued?

This is the one place the agreed model and the shipped Invoices tool disagree, and it
decides where the adjustment boundary sits.

- **As agreed:** the parent registers, gets a confirmation email carrying the total,
  and *that* is the invoice. It is issued at registration. Everything after is an
  adjustment. Under this reading, registration should stamp `sent_at` itself, and
  Invoices → "Mark all as sent" becomes a catch-up for stragglers rather than the
  normal path.
- **As built:** registration writes a draft. Jacinda reviews the month in Invoices and
  marks them sent. The boundary is her send, not the parent's email.

The difference is real: a day changed between registration and her send is an
*amendment to an unsent draft* under the second reading, and an *adjustment against
an issued bill* under the first. The first matches what parents actually experience —
they have an email with a number on it — but it removes her chance to review a month
before anything is issued.

**Recommendation:** keep her review step, and make the registration confirmation email
say what it truly is — a booking confirmation with an estimated total, with the
invoice to follow. One sentence of copy, and the model stays coherent. If instead the
email must be the invoice, registration auto-stamps `sent_at` and she loses the
pre-send review.

Needs a decision before step 1.

## Sequence

1. Schema migration + the `create_billing_invoice_by_email` branch.
2. Family-aware parent quote, so issued originals are right when sent.
3. Billing screen: statements, review queue, issue actions.
4. Backfill decision for April–July; issue August originals.
5. Payment processor attaches to this — see `docs/PARENT_PORTAL_PLAN.md` §8.
