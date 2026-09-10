# Stax go-live checklist

Written 2026-08-30, at the point where Stax is the **only** payment processor
(Authorize.net was removed the same day — see CLAUDE.md). Everything below is
either a step nobody can do from code, or a test that has to be run against a
real production merchant. Work top to bottom; the order matters.

Today's state: **not live.** `STAX_ENVIRONMENT` is sandbox, so both parent
endpoints refuse and the portal tells families online payment is not available
yet. Nothing charges anyone.

---

## 1. Before Stax is signed up

- [ ] **Delete the four retired Authorize.net functions** in the Supabase
      dashboard (Edge Functions → … → Delete). All four are inert 410 stubs
      already, so there is no exposure — this is tidiness, and it keeps the
      deployed slug list matching `supabase/functions/`:
      `create-payment-session`, `authorizenet-webhook`, `admin-refund-payment`,
      `reconcile-anet-payments`.
- [ ] **Delete the three retired debug/temp functions**, same place:
      `stax-webhook-admin-tmp`, `debug-list-webhooks`, `debug-anet-webhooks`.
      ⚠️ `stax-webhook-admin-tmp` once carried a hardcoded admin token that
      could create Stax charges and refunds. It is a 410 stub now, but treat
      that token as compromised — it must not be reused anywhere.

## 2. When the production Stax account exists

- [ ] Replace **`STAX_API_KEY`** with the production Core API key.
- [ ] Replace **`STAX_WEB_PAYMENTS_TOKEN`** with the production Web Payments
      token (Stax dashboard → Settings → Web Payments). ⚠️ This is a
      *different* value from the API key and must never be the API key — the
      browser receives it.
- [x] **Deploy the four Stax edge functions from `main`.** Confirmed deployed
      (2026-09-10) — `charge-stax-payment`, `create-stax-charge`,
      `admin-refund-stax-payment` and `reconcile-stax-payments` are all
      ACTIVE, and the deployed `charge-stax-payment` source was checked
      directly and does contain `assertStaxMerchant`. If you ever push a
      code change to any of these four, redeploy with
      `supabase functions deploy <name>` and re-verify the pin is still
      there — it is worthless if only git has it.
- [ ] Set **`STAX_MERCHANT_ID`** to the production merchant id.
      ⚠️ **This is the guard that stops the worst launch-day mistake.** Sandbox
      and production share one API host; only the key decides which merchant is
      charged, and `STAX_ENVIRONMENT` is a label this app sets for itself.
      Without the pin, a production flip with a stale sandbox key would charge
      nobody while the app recorded real payments, marked invoices paid and
      emailed receipts. With it, every call verifies first and fails closed.
- [ ] Set a fresh **`STAX_WEBHOOK_SECRET`** (a long random value we choose).
- [ ] **Register the webhook on the production merchant** for the
      `create_transaction` event, target:
      `<stax-webhook function URL>?secret=<STAX_WEBHOOK_SECRET>`
      ⚠️ Sandbox registration does not carry over, and `update_transaction`
      never fires — a refund arrives as its own `create_transaction`.
- [ ] Confirm **`STAX_SANDBOX_TEST_ENABLED` is OFF** (or unset). It is the
      sandbox click-through bypass and has no business being on in production.
- [ ] Only then set **`STAX_ENVIRONMENT=production`** and
      **`STAX_PAYMENTS_ENABLED=true`**. This is the switch — see §4.

## 3. First production charge (do this yourself, small amount, own card)

- [ ] The merchant pin is unproven against a real `/self` response: it reads
      `merchant.id` / `merchant_id` and **fails closed** if it can't find one.
      So the very first charge after setting `STAX_MERCHANT_ID` either works or
      returns "Could not verify the payment merchant." If it's the latter, the
      response shape differs from what was assumed — fix the pin before
      launching; do not remove it.
- [ ] Open the portal in a real browser with the console visible. **Watch for
      CSP refusals.** The card fields are iframed from whatever vault vendor
      *this* merchant's gateway uses — sandbox routed through BlockChyp; the
      production merchant may differ, and a blocked vault iframe looks exactly
      like a broken app. Allowlisted today: `staxjs.staxpayments.com`,
      `core.spreedly.com`, `test.blockchyp.com`, `api.blockchyp.com`,
      `omni.fattmerchant.com` (`_headers` **and** `worker.js` — keep in sync).
- [ ] Charge succeeds; exactly one `billing_payments` row; invoice balance and
      status correct; receipt email arrives and reads right.
- [ ] **Refund that same charge** from Finance → Ledger → the family drawer.
      The reversal should be recorded by the webhook, not by the button.
- [ ] Leave a charge deliberately unfinished (close the tab mid-payment) and
      confirm `reconcile-stax-payments` clears the lock within 30 minutes
      rather than locking that family out of paying.

## 4. Rollout — a small pilot group, not everyone at once

A per-family pilot gate now exists (`families.stax_pilot_enabled`,
default false). §2's environment secrets still turn the *feature* on for
the whole app, but a family's own "Pay online" button will not actually
work until an admin flips it on for that family from **Finance → Ledger →
[family] → Online payments (Stax)**. Enforced in both `create-stax-charge`
and `charge-stax-payment` server-side — never only in the UI — so there is
no path to a real charge for a family that hasn't been enabled, even by
calling the API directly.

- [ ] Before phase 3's first real charge, enable it for your own family
      first (the office account you'll pay with).
- [ ] After phase 3 succeeds, enable it for a handful of willing families
      (the director's plan, same shape as the scheduler rollout), and only
      widen from there.

Also before the flip:

- [ ] **Mark every pre-Stax invoice paid.** In-house reconciliation starts at
      go-live; historical balances must not present themselves to a pilot
      family as something to pay online. Note that a Stax charge rolls up every
      unpaid issued invoice through the anchor month — an old unpaid month
      would be swept into a pilot family's first real payment.

## 5. Not carried over from Authorize.net

Nothing. `billing_payments` never held a single Authorize.net row, so there is
no payment history, no refund path and no reconciliation backlog tied to it.
