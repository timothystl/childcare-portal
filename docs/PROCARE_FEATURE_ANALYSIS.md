# Procare Feature Scope, Build Analysis & Cost Model

**Date:** 2026-08-10 · **Author:** Claude Code session · **Status:** analysis only, no code changes

Question asked: what would it take to add Procare-style **parent communication** (daily
reports — naps, diapers, feeding, child welfare, "how the day went") and **billing**
functionality to our portal — not just the coding, but the infrastructure to run and
maintain it — and what does that cost?

Everything below uses **live production numbers** pulled from our Supabase project on
2026-08-10, not estimates.

---

## 0. Our actual scale (from prod, 2026-08-10)

| Metric | Value |
|---|---|
| Families | 122 |
| Children (students) | 149 |
| Active staff | 31 |
| Child-days per month (peak, Jun–Aug 2026) | 1,119 – 1,251 |
| Distinct children served per month | 86 – 115 |
| Invoices per month | 77 – 96 |
| Average invoice | **$602** |
| Billed per month | **$42K – $58K** (Aug 2026: $57,793) |
| Annualized billing | **~$600K – $650K** |
| Database size | 21 MB |
| Web-push subscriptions already live | 58 |

Two things follow immediately:

1. **We have no scale problem.** 1,250 child-days/month is roughly 60 child-days on a
   busy day. Nothing in this analysis is a load or performance question. The hard parts
   are reliability, staff adoption, privacy, and support — not throughput.
2. **Money moving through the system is the dominant cost variable.** At ~$650K/yr
   billed, payment-processing percentages swamp every server, storage, and license line
   item combined. See §6.

---

## 1. What Procare actually does

Procare Solutions is the incumbent center-management suite (it absorbed Kinderlime; the
mobile app still ships under that bundle ID). The functionality splits into three
products that are sold together:

### 1a. Procare Online / Cloud — the admin system of record
Enrollment and waitlist, family and child records, room/ratio management, staff records
and timecards, attendance, immunization and document tracking, state-subsidy handling,
compliance and licensing reports, food-program tracking, and a full reporting suite.
**We already have most of this** — registration, waitlist, rooms, staff roster, staff
clock kiosk, payroll, CACFP, finance/P&L, reports.

### 1b. Procare Childcare App — the classroom + parent side (this is what you asked about)
- **Teacher-side daily logging on a tablet:** diaper changes and bathroom visits, bottles
  and meals, naps (start/stop), mood/observations, activities, and developmental
  milestones — recorded per child, per event, timestamped.
- **Automatic daily report** ("daily sheet") assembled from those events and delivered to
  the parent — in-app plus an end-of-day summary.
- **Photos and videos** attached to the child's day, with parent-visible feed.
- **Two-way messaging** — teacher↔parent, plus center-wide and room-wide broadcasts
  (in-app, with email/SMS fallback).
- **Child check-in / check-out**, typically parent-signed on a lobby tablet or via QR,
  producing the attendance record and driving room ratio counts.
- **Incident / accident reports** with parent signature capture.
- **Calendar and event sharing**, staff clock-in from the same app.

### 1c. Tuition Express — the billing/payments rail
Recurring auto-payments by ACH bank draft or card, family-initiated payments from the
parent app, stored payment methods, scheduled/recurring billing, late fees, payment
plans, statements and receipts, subsidy/third-party payer splits, and automated
reconciliation back into the ledger. Pricing is quote-only; user reviews consistently
report an **ACH batch fee plus a per-account fee** on top of percentage rates, and
month-to-month variability in card rates.

### Pricing, as publicly reported (all vendors are quote-gated — treat as directional)
- Procare Express (very small in-home programs): **~$25/mo**, lacks subsidy/compliance features.
- A licensed single center on cloud management **+ the parent app**: **~$85–150/mo**.
- **First-year setup/onboarding commonly runs $1,500–$3,000** on top of subscription.
- Brightwheel (the main alternative, stronger parent app): reported around **$21–31 per
  child**, quote-gated. At our 115 active children that is a materially bigger number if
  it is per-child/month; it is likely tiered in practice, but it is the one pricing model
  that scales *against* us as enrollment grows.
- Tuition Express / Brightwheel Billing processing fees are **separate and additional** in
  every case.

---

## 2. Gap analysis — what we already have vs. what's missing

| Procare capability | Our portal today | Gap |
|---|---|---|
| Family / child records | `families`, `students` | ✅ none |
| Enrollment + waitlist | full module | ✅ none |
| Room roster / daily attendance view | `admin-classrooms.js`, `getRosterForDate()` | ✅ view exists |
| Staff clock in/out | `clockin.html` kiosk + `staff_clock_events` + geofence | ✅ none |
| Payroll | `admin-reports.js` | ✅ none |
| Meals / food program | CACFP module (`cacfp_meal_records`: breakfast, AM snack, lunch, PM snack per child per day) | 🟡 **admin-entered, not teacher-live, not parent-visible** |
| **Child check-in / check-out** | ❌ **does not exist** — attendance is *scheduled* (`registration_dates`), never *actual* | 🔴 **missing foundation** |
| **Diapers / bathroom** | ❌ | 🔴 missing |
| **Naps** | ❌ | 🔴 missing |
| **Bottles / feeding detail** | 🟡 CACFP meal status only (`served`/`brought_own`/`absent`) | 🔴 missing |
| **Mood / observations / daily note** | ❌ | 🔴 missing |
| **Daily report to parents** | ❌ | 🔴 missing |
| **Photos** | 🟡 `staff-photos` bucket only (staff headshots, **and it is public**) | 🔴 missing + a security item |
| **Two-way parent↔teacher messaging** | 🟡 one-way: parent "Contact Us" → `messages` → admin inbox (`admin-messages.js`), 9 messages total | 🔴 no reply path, no teacher access, no threading |
| Push notifications | ✅ web push, VAPID, 58 live subscriptions, service worker | ✅ **plumbing already built** |
| Transactional email | ✅ Resend via edge functions | ✅ none |
| Invoicing / ledger | `billing_cycles`, `billing_invoices`, `billing_payments`, `billing_overrides`, change fees, CSV import | ✅ **substantial — better than assumed** |
| **Online payment collection** | ❌ payments are recorded by hand / CSV import; `payment_method` defaults to `'check'` | 🔴 missing |
| **Autopay / stored payment methods** | ❌ | 🔴 missing |
| **Parent-facing statement / pay button** | ❌ | 🔴 missing |
| Incident reports w/ signature | ❌ | 🔴 missing |
| Subsidy / third-party payer | ❌ (CACFP income tiers exist, not payer splits) | 🟡 not needed today |

**The headline finding:** we are much closer than it looks on the billing *ledger* side —
invoices, cycles, payments, overrides and reconciliation already exist. What is missing on
billing is only the **money rail** (a processor) and the **parent-facing pay surface**.

On the classroom side we are further away than it looks, because of one thing:
**we have no actual child attendance record.** Everything Procare's parent app does hangs
off "this child is here right now, in this room, with this teacher." We only know who was
*scheduled*. That has to be built first, and it also fixes real problems we already have
(true ratio counts, CACFP point-of-service accuracy, and no-show/late-pickup tracking).

---

## 3. What it would take to build — phased

Effort figures are **engineering hours** at the quality bar this repo already holds
(RLS-first schema, hand-applied migrations, `dist/` rebuild, tests, no framework).

### Phase 0 — Security prerequisites (**non-negotiable, ships first**) — 30–50 hrs
The open queue in `docs/CODE_REVIEW_2026-08.md` currently has the anon key able to read
all of `families`/`students`/`registrations` (**R1**), holding `DELETE` on `students` and
`UPDATE` on `families`/`students` (**R4**), no server-side registration-window enforcement
(**R24**), and admin roles enforced only in the browser (**R20**).

Adding nap/diaper logs, photos of children, and stored payment mandates on top of that
posture converts an existing PII exposure into a child-safety and payment-security
exposure. **This phase is a gate, not a nice-to-have.**

Also in scope: the `staff-photos` bucket is **public** — any child-photo bucket must be
private with short-lived signed URLs, and staff photos should move to the same model.

### Phase 1 — Child check-in / check-out — 30–45 hrs
New `child_attendance` table (child, date, room, in/out timestamps, who released the
child, signature blob or PIN attestation). Lobby-tablet flow reusing the existing PIN
pattern from `clockin.html` and `lookup_staff_by_pin`, plus a teacher-side override.
Live room ratio counter for the classrooms tab. Backfills CACFP accuracy.

**This is the highest value-per-hour item in the whole document** and is worth doing even
if nothing else here gets built.

### Phase 2 — Daily activity logging + daily report — 60–90 hrs
- Schema: one `child_events` table (child, care_date, type, subtype, occurred_at, notes,
  recorded_by, room) covering diaper/bathroom, nap start/stop, bottle/meal, mood, activity,
  note. One table, not five — keeps queries and the parent timeline simple.
- Teacher tablet UI: large-target, one-thumb, room-scoped list of today's present children,
  two taps to log the common events. Must be **offline-tolerant** (IndexedDB queue + sync)
  because classroom wifi will drop and a teacher who loses entries stops using it in a week.
- Parent timeline view in the portal + an end-of-day digest (push, already built; email
  via Resend, already built).
- Wire the existing CACFP meal capture into the same event stream so meals are logged once
  by the teacher rather than re-entered by admin — a real staff-time saving.

### Phase 3 — Two-way messaging — 40–60 hrs
Thread model (`message_threads` / `message_posts`), participant scoping so a teacher sees
only their room's families, room and center broadcast, read receipts, notification fan-out
through the existing push + Resend paths, retention policy, and an admin-visible archive.
The existing `messages` table becomes a legacy inbox that feeds into it.

**Non-code decision required:** if teachers message parents directly, the church needs a
communications policy (business hours, what belongs in a message vs. a phone call,
retention, and the fact that these records are discoverable).

### Phase 4 — Photos — 40–60 hrs
Upload with client-side compression, per-child tagging, **per-family photo-consent flag
enforced at query time**, private bucket + signed URLs, Cloudflare R2 or Supabase Storage,
scheduled retention purge, and honoring `deletion_requests`.

**This is the highest-risk feature in the document.** A photo tagged to the wrong child, or
a group photo delivered to a family whose neighbor withheld consent, is a privacy incident
with a parent, not a bug. It needs a review step or a strict "one child per photo" rule.

### Phase 5 — Billing: online payments — 70–100 hrs
- Stripe as the rail: **Stripe Checkout / Payment Element** so card data never touches our
  servers (keeps us in PCI **SAQ-A**, the minimal scope). Never store card numbers.
- ACH Direct Debit with a stored mandate for autopay, including Nacha-compliant
  authorization capture and 2-year retention of that authorization.
- Parent-facing statement + "Pay now" + "Enroll in autopay" in the portal.
- Webhook edge function → writes into the existing `billing_payments` with
  `payment_method='ach'|'card'`, marks invoices paid/partial. The reconciliation model we
  need **already exists**; this is mostly plumbing into it.
- Failed-payment retry, receipts, refunds, and late-fee automation on top of the existing
  change-fee logic.

**Total build: ~270–405 engineering hours across five phases plus the security gate.**

---

## 4. Infrastructure and operations — the part that isn't code

This is where a self-built system actually differs from buying one, and it is where most
church-built systems fail. Ranked by how likely each is to sink the project:

1. **Devices in classrooms.** 5 active rooms + lobby = **6 tablets** minimum, realistically
   7 with a spare. Wall mounts or stands, cases, charging, and a kiosk-lock browser so a
   teacher can't wander into a browser tab. Replacement cycle ~3 years; assume one
   breakage per year.
2. **Wifi coverage in every classroom.** The daily-sheet feature is only as good as the
   weakest AP. Bear/Bee rooms behind masonry are the usual failure point. Budget for 1–2
   additional access points and a survey.
3. **Offline tolerance.** Non-optional, as above. This is engineering work driven purely by
   infrastructure reality.
4. **Staff adoption across 31 people.** Training, a written one-pager, and a supervisor who
   checks that sheets are actually being filled. **A half-used daily-sheet system is worse
   than none** — parents notice the days their child "has no entries" and read it as
   neglect, not as a software gap.
5. **Support burden shifts to us.** Today nobody is on call. With daily sheets and
   payments, someone answers "the app won't log me in" at 6:45am and "my card was charged
   twice" on a Saturday. Procare has a support line; if we build, **we are the support
   line.** Realistically 4–8 hrs/month ongoing, spiking around billing runs.
6. **Bus factor of one.** This codebase has a single maintainer. A vendor outage is the
   vendor's problem at 3am; ours is ours. Mitigations: Supabase Pro with point-in-time
   recovery, documented runbooks, and keeping the manual CSV/check path working as a
   fallback so billing never hard-depends on the new rail.
7. **Privacy, consent and records.** Photos and health-adjacent notes about minors:
   written parent consent per family, a retention schedule, deletion honored on request
   (`deletion_requests` exists), and access scoped so a teacher sees only their room.
   CACFP already requires 3+ year retention; incident reports and attendance have their own
   licensing retention requirements. Get the church's insurer and the licensing
   requirements checked **before** Phase 4 ships.
8. **Payment compliance.** SAQ-A via Stripe Checkout, Nacha authorization retention for
   ACH, a written refund/NSF policy, and a named person reconciling. Chargebacks cost $15
   each and someone has to respond to them.
9. **Backups and DR.** Supabase Pro includes daily backups and PITR; the free tier does
   not, and free projects pause. **If we take payments, the free tier is not an option.**
10. **Migration/dual-run.** If we ever do move off manual billing, run both for one full
    cycle. Everything in §0 says a month is $55K — a botched cutover is not recoverable
    from goodwill alone.

**Load, by contrast, is a non-issue.** 1,250 child-days × ~8 events = ~10K rows/month.
The database is 21 MB today and would grow by single-digit MB per year.

---

## 5. Cost model — building it ourselves

### 5a. One-time
| Item | Low | High | Note |
|---|---|---|---|
| Engineering, 270–405 hrs @ contractor $100–150/hr | $27,000 | $60,750 | **$0 cash if done in-house with Claude Code** — the real cost is your attention |
| Tablets (7 × Fire HD 10 $150 → iPad 11 $329) | $1,050 | $2,300 | |
| Mounts, cases, chargers | $250 | $500 | |
| Wifi APs + survey | $200 | $900 | may be $0 if coverage is fine |
| Kiosk-lock software (optional, one-time per device) | $0 | $85 | Fully Kiosk ~$12/device |
| Staff training time (31 staff × 1 hr) | — | ~$450 | at ~$14.50/hr |
| **One-time total (cash, in-house build)** | **$1,500** | **$4,235** | |
| **One-time total (contracted build)** | **$28,500** | **$65,000** | |

### 5b. Recurring infrastructure (monthly)
| Item | Cost | Basis |
|---|---|---|
| Supabase Pro | **$25/mo** | required — PITR, no project pausing, backups. Free tier is disqualifying once payments exist |
| Cloudflare Workers paid | $5/mo | likely already in place |
| Photo storage — Cloudflare R2 | **~$0.15–0.50/mo** | 1,250 child-days × 1–2 photos × 250 KB ≈ 0.3–0.6 GB/mo; 2-yr retention ≈ 8–15 GB @ $0.015/GB-mo, **egress free** |
| Email — Resend Pro | **$20/mo** | daily digests ≈ 115 families × 20 school days = **2,300/mo**, which breaks the free tier's 100/day cap |
| Web push | **$0** | self-hosted VAPID, already built |
| SMS fallback (optional) | ~$28/mo | 2,300 msgs @ ~$0.012 all-in — **recommend skipping**; push + email covers it |
| Tablet replacement, amortized over 3 yrs | ~$36/mo | |
| **Recurring subtotal** | **~$90–120/mo** | **≈ $1,100–1,450/yr** |

### 5c. Ongoing human cost
Maintenance and support, 4–8 hrs/mo. At $0 cash in-house; **$4,800–14,400/yr** if contracted.

**The infrastructure bill is trivially small. The cost of building is time, and the cost of
running it is attention.**

---

## 6. Cost model — payment processing (the number that actually matters)

We bill **~$55,000/month across ~95 invoices, averaging $602**. Today that arrives as
checks and cash, so processing costs us **$0**. Any online-payment feature — bought *or*
built — introduces this cost for the first time.

| Rail | Rate | Per $602 invoice | Per month (95 invoices) | Per year |
|---|---|---|---|---|
| Card, Stripe standard | 2.9% + $0.30 | $17.76 | $1,687 | **$20,242** |
| Card, Stripe nonprofit rate | 2.2% + $0.30 | $13.54 | $1,287 | **$15,439** |
| **ACH bank debit** | **0.8%, capped at $5** | **$4.82** | **$458** | **$5,494** |
| Realistic mix — 70% ACH / 30% card (nonprofit rate) | — | — | $707 | **$8,478** |
| **ACH-only (recommended)** | — | — | **$458** | **$5,494** |

Three conclusions:

1. **Processing dwarfs everything else in this document by an order of magnitude.** $5.5K–20K
   a year against a ~$1.3K/yr infrastructure bill and a ~$2K/yr license.
2. **Default families to ACH, not card.** ACH costs about a quarter of card at our invoice
   size, and our average invoice ($602) sits just under the $5 ACH cap — nearly the
   best-case position on that fee schedule. Making card the path of least resistance costs
   roughly **$12,000/year** in avoidable fees.
3. **Apply for Stripe's nonprofit rate** before launch (2.2% vs 2.9%) — worth ~$4,800/yr on
   the card portion of a mixed model, and it takes an afternoon.
4. This cost is **identical in kind if we buy Procare** — Tuition Express charges
   percentage rates *plus* a reported ACH batch fee and per-account fee, and is quote-only,
   so it is likely to be no better and possibly worse than published Stripe rates. Buying
   does not avoid this line; it only makes it less visible.

---

## 7. Build vs. buy — 3-year total cost of ownership

Both columns pay processing, so it is shown separately; the comparison is everything else.

| | **Build in-house** | **Buy Procare** | **Buy Brightwheel** |
|---|---|---|---|
| Year-1 setup / onboarding | $1,500–4,235 (hardware, wifi, training) | $1,500–3,000 setup **+** same hardware $1,500–2,800 | similar to Procare |
| License / subscription | $0 | $1,020–1,800/yr | $1,000–3,000/yr (per-child model — **scales against us**) |
| Infrastructure | $1,100–1,450/yr | $0 (theirs) | $0 |
| Engineering (in-house) | 270–405 hrs, then 4–8 hrs/mo | ~0 | ~0 |
| Engineering (if contracted) | $27K–61K + $5K–14K/yr | — | — |
| **3-yr cash, in-house build** | **~$5,000–8,600** | **~$6,600–11,200** | **~$6,500–14,800** |
| **3-yr cash, contracted build** | **~$47,000–107,000** | — | — |
| Processing (all options) | $5,500–20,200/yr | comparable or worse, opaque | comparable |
| Fits our data model | ✅ perfectly — MDO monthly-days model is unusual | ⚠️ built for full-time weekly/monthly tuition | ⚠️ same |
| Support when it breaks | **you** | vendor | vendor |
| Data ownership / exit | ✅ ours | ⚠️ export-dependent | ⚠️ export-dependent |
| Migration risk | none — additive to what exists | **high** — would replace registration, waitlist, payroll, CACFP, finance, all working today | high |

**The decisive factor is not price.** On cash, build and buy land within a few thousand
dollars of each other over three years. The decisive factors are:

- **Our registration model is genuinely unusual** — parents pick individual care days per
  month, not a fixed weekly schedule. Procare and Brightwheel are built around full-time
  and fixed part-time enrollment. Adopting either means either bending our program to their
  model or fighting their billing engine every month.
- **We would be throwing away working software.** Waitlist, CACFP, payroll with PTO,
  geofenced staff clock-in, finance/P&L, the church ChMS finance API — all built, all in
  production, none of which a vendor replicates exactly.
- **The counter-argument is real:** buying converts a single-maintainer dependency into a
  vendor SLA. If the maintainer's availability is uncertain, that is worth more than the
  price difference.

---

## 8. Recommendation

**Build, but narrowly and in this order — and do not attempt all five phases.**

1. **Phase 0, security gate** (30–50 hrs). Close R1, R4, R20, R24 first. Not optional
   before any child-level or payment data ships.
2. **Phase 1, child check-in/out** (30–45 hrs). Best value per hour in the document.
   Delivers true attendance, live ratio counts, CACFP point-of-service accuracy, and the
   foundation every other feature needs. **Do this even if nothing else here happens.**
3. **Phase 2, daily activity logging + daily report** (60–90 hrs). This is the feature
   parents actually experience as "the Procare thing." Must be offline-tolerant.
4. **Phase 5, billing/online payments** (70–100 hrs) — **ACH-first, Stripe Checkout,
   nonprofit rate applied for, manual check path kept alive as fallback.** The ledger
   already exists; this is the rail and the parent-facing button.
5. **Phase 3, messaging** (40–60 hrs) — only after a written communications policy exists.
6. **Phase 4, photos** — **defer.** Highest risk, lowest operational readiness. Revisit
   once consent tracking, private buckets, and a review workflow are in place.

**Do not buy Procare.** It would replace working software, does not fit the per-day
registration model, and does not avoid the processing cost that dominates the budget.

**The two decisions that carry the most money:** default families to ACH (~$12K/yr vs.
card-default), and get the Stripe nonprofit rate before launch.

**The one decision that carries the most risk:** whether 31 staff will actually fill in
daily sheets every day. Pilot Phase 2 in **one room for one month** before rolling it out.
If adoption fails there, stop — the money was never the constraint.

---

## Sources

- [Procare: Childcare App — Google Play](https://play.google.com/store/apps/details?id=com.kinderlime.dev&hl=en_US)
- [Procare: Childcare App — App Store](https://apps.apple.com/us/app/procare-childcare-app/id1309822135)
- [Parents: Review your Child's Daily Activities — Procare Support](https://www.procaresupport.com/procare-online/docs/parents-review-your-childs-daily-activities-1)
- [Tuition Express Guide — Procare Support](https://www.procaresupport.com/procare-online/docs/tuition-express-guide)
- [Procare Solutions 2026 Pricing, Features, Reviews — GetApp](https://www.getapp.com/education-childcare-software/a/procare-child-care-management/)
- [Procare Solutions — Capterra](https://www.capterra.com/p/23486/Procare-Child-Care-Management/)
- [Tuition Express Pricing — Capterra](https://www.capterra.com/p/177236/Tuition-Express/pricing/)
- [Procare Solutions vs. brightwheel — G2](https://www.g2.com/compare/procare-solutions-vs-brightwheel)
- [Lillio vs brightwheel — Capterra](https://capterra.com/compare/134048-144060/HiMama-Preschool-Child-Care-App-vs-brightwheel)
- [Stripe ACH Fees: 0.8%, $5 cap — FeeProbe](https://feeprobe.com/stripe-ach-fees/)
- [Stripe fees explained (2026)](https://checkoutpage.com/blog/stripe-processing-fees)
- [Stripe for Nonprofits: fees & compliance (2026)](https://bankingcrowded.com/all-blogs/stripe-for-nonprofits/)
- [Supabase Pricing in 2026 — UI Bakery](https://uibakery.io/blog/supabase-pricing)
- [Cloudflare R2 Pricing 2026 — EgressCost](https://egresscost.com/cloudflare/)
- [Cloudflare Images Pricing 2026 — Image CDN](https://theimagecdn.com/docs/cloudflare-images-pricing)
- [Resend Pricing 2026 — Nuntly](https://nuntly.com/resend-pricing)
- [Twilio SMS Pricing — US](https://www.twilio.com/en-us/sms/pricing/us)
