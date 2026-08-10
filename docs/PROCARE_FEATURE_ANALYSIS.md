# Procare Feature Scope, Build Analysis & Cost Model

**Date:** 2026-08-10 · **Author:** Claude Code session · **Status:** analysis only, no code changes
**Revised 2026-08-10** after confirming we already use Procare / Tuition Express to take
payments. §6–§8 were rewritten; the earlier version assumed a check-and-cash baseline at
$0 processing cost, which was wrong and inverted the billing recommendation.

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

**Payments already run through Procare / Tuition Express:**

| Metric (`billing_payments`, live) | Value |
|---|---|
| Payments recorded | 453 — **100% `payment_method = 'procare_payment'`** |
| Total collected | **$235,133** (2026-01-01 → 2026-06-30) |
| Payments per month | ~76 |
| Average payment | **$519** (range $4 – $2,500) |
| Distinct families paying | 81 |
| Payments linked to a specific invoice | **0** |
| CSV imports ever run | **1**, on 2026-07-01 — no payment data since 2026-06-30 |

Three things follow immediately:

1. **We have no scale problem.** 1,250 child-days/month is roughly 60 child-days on a
   busy day. Nothing in this analysis is a load or performance question. The hard parts
   are reliability, staff adoption, privacy, and support — not throughput.
2. **We are already a paying Procare customer.** This is not a build-vs-buy decision from
   a standing start; it is a question of whether to *expand* what we build alongside a
   vendor we already pay, and which pieces to leave with them. See §7.
3. **The real billing friction is reconciliation, not collection.** Money is being
   collected fine. What's broken is that payment data reaches our ledger by a hand-run CSV
   import that has been run exactly once, no payment is matched to an invoice, and our
   copy of the payment record is ~6 weeks stale. That is an integration problem measured
   in hours, not a payments platform measured in months. See §6.

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
| **Online payment collection** | ✅ **handled by Procare / Tuition Express today** — $235K collected Jan–Jun 2026 | ✅ solved, by vendor |
| **Autopay / stored payment methods** | ✅ Procare | ✅ solved, by vendor |
| **Parent-facing statement / pay button** | ✅ Procare parent portal | ✅ solved, by vendor |
| **Payment → invoice reconciliation** | 🔴 hand-run CSV, run once ever, 0 of 453 payments matched to an invoice, ledger 6 weeks stale | 🔴 **the actual gap** |
| Incident reports w/ signature | ❌ | 🔴 missing |
| Subsidy / third-party payer | ❌ (CACFP income tiers exist, not payer splits) | 🟡 not needed today |

**The headline finding:** on billing there is very little left to build. The ledger exists,
and the money rail and parent pay surface are already provided by Procare. The only gap is
the seam between them — see §6.

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

### Phase 5 — Billing — **6–12 hrs, not 70–100** (revised)
The original version of this document scoped a full Stripe payments build. **That is the
wrong project.** Procare already collects the money, holds the stored payment methods and
autopay mandates, runs the parent-facing pay portal, and absorbs the PCI and Nacha
compliance scope. Rebuilding that on Stripe would take 70–100 hours to arrive at parity
with something already working, and would very likely *raise* our processing cost (§6).

What is actually broken is reconciliation. Scope:

- **Make the Procare payment import routine and reliable.** It has been run once, on
  2026-07-01, and our ledger has no payment data after 2026-06-30. Either a documented
  monthly step in the billing runbook, or a scheduled job if Procare exposes an export
  endpoint. (~4–6 hrs)
- **Match payments to invoices.** All 453 payments have `invoice_id = NULL`, so
  outstanding-balance figures are family-level aggregates rather than per-invoice truth.
  A matcher on family + amount + date window with an admin review screen for the
  ambiguous ones. (~4–6 hrs)
- **Fix the known import bugs first** — FS12 (generic CSV import shifts payment dates by
  −1 day or to today) directly corrupts this data.

**Do not build a payment rail. Fix the pipe between two systems that both already work.**

**Revised total build: ~205–320 engineering hours** across the classroom phases, the
security gate, and the small billing-reconciliation fix.

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

## 6. Cost model — payment processing (revised: we already pay this, and Stripe is worse)

We collect **~76 payments/month averaging $519** (~$39K/month) through Tuition Express.
We are already paying processing fees; the question is not whether to start paying them,
but whether moving to Stripe would lower them. **At our payment size, it would not.**

The decisive detail is that **Tuition Express prices ACH as a flat per-transaction fee
while Stripe prices it as a percentage.** Reported Tuition Express rates are ACH **$1.25
flat** and card **2.75% + $1** (some centers publish 3.5% for card; rates are set per
center and are quote-based).

| Rail | Rate | Per $519 payment | Per month (76) | Per year |
|---|---|---|---|---|
| **ACH — Tuition Express (today)** | **$1.25 flat** | **$1.25** | **$95** | **$1,140** |
| ACH — Stripe | 0.8%, capped $5 | $4.15 | $315 | **$3,785** |
| Card — Tuition Express | 2.75% + $1 | $15.27 | $1,161 | $13,927 |
| Card — Stripe standard | 2.9% + $0.30 | $15.35 | $1,167 | $14,000 |
| Card — Stripe nonprofit | 2.2% + $0.30 | $11.72 | $891 | $10,689 |

**Corrections to the earlier draft:**

1. **Moving ACH to Stripe would cost us roughly $2,600/year more, not less.** A flat $1.25
   beats 0.8% on every payment above **$156**, and our average is $519. The earlier
   "default to ACH and save $12K/yr" conclusion was arithmetic against a $0 baseline that
   does not exist. Against the real baseline, ACH-on-Stripe is a **downgrade**.
2. **On card, Stripe's nonprofit rate is genuinely better** — ~$3.55 per transaction, or
   ~$3,200/yr if every payment were card. That is the only place Stripe wins, and it only
   matters in proportion to how much of our volume is card rather than ACH.
3. **The reported ACH batch fee and per-account fee are the unknown.** Reviews consistently
   mention both, amounts unspecified. They could erase the ACH advantage above.

**Action before any of this is decided: pull the last three Procare statements** and read
the actual effective rate — total fees ÷ total collected — plus the ACH/card split and any
monthly account or batch fees. That single number settles §6 and §7, and we already have
it sitting in our own records. Everything in this table is public-rate inference until then.

**Second question worth asking:** does Timothy absorb these fees, or pass them to families?
Several centers using Tuition Express publish the ACH/card fee as a parent-paid service
charge. If we already pass it through, processing cost is not our cost at all and drops out
of the comparison entirely.

---

## 7. Build vs. buy — reframed

**We are not choosing between building and buying. We already bought.** The real menu is:

| Option | What it means | Verdict |
|---|---|---|
| **A. Keep Procare for payments, build the classroom/parent side ourselves** | Procare stays the money rail; we build check-in/out, daily sheets, messaging. Fix the CSV reconciliation. | ✅ **recommended** |
| **B. Ask Procare what the parent app / daily-sheet tier costs** | We are already a customer — the daily-activity and messaging features may be an add-on tier on our existing account rather than a new purchase. | ✅ **do this first — it is a phone call and it could moot Phases 2–4** |
| **C. Expand Procare to be the whole system** | Replaces registration, waitlist, payroll, CACFP, finance, staff clock-in — all working today, none of which Procare replicates for a per-day registration model. | ❌ high migration risk, poor model fit |
| **D. Leave Procare entirely, build payments on Stripe** | 70–100 hrs of work to reach parity with something already working, and ~$2,600/yr *more* in ACH fees. | ❌ **do not** |

Option B is the highest-value 20 minutes in this document and should happen before any
code is written. If Procare's existing parent app covers daily sheets adequately for a
price we're already close to paying, Phases 2–4 (~140–210 hours) may simply not need to
exist — and the answer might be that we're entitled to it already.

The genuine argument for still building the classroom side even if B comes back cheap: our
per-day registration model is unusual, our teachers already use our kiosk, and a daily
sheet that reads from our own roster is simpler than one bolted to a vendor's enrollment
model. But that is a fit argument, not a cost argument, and it should be made honestly.

### 3-year cost, for reference

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
dollars of each other over three years — and note that the "build" column no longer saves
the Procare subscription, because under the recommended option we keep paying it for
payments. Roughly, our ~$1,100–1,450/yr of new infrastructure offsets against a
subscription we retain either way. **The classroom build has to justify itself on
capability and fit, not on savings.** The decisive factors are:

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

## 8. Recommendation (revised)

**Keep Procare for payments. Build the classroom and parent-communication side — but make
two phone calls before writing any code.**

### Before any code
1. **Pull the last three Procare statements.** Effective rate (total fees ÷ total
   collected), ACH/card split, and any monthly account or batch fee. Also settle whether we
   absorb the fees or pass them to families. This is the number §6 and §7 turn on, and it
   is in our own filing cabinet.
2. **Ask Procare what the parent-app / daily-activity tier costs on our existing account.**
   We are already a customer. If daily sheets and messaging are an add-on tier at a
   reasonable price, **Phases 2–4 (~140–210 hours) may not need to exist.** Twenty minutes
   that could save four months.

### Then, in this order
1. **Phase 0, security gate** (30–50 hrs). Close R1, R4, R20, R24. Not optional before any
   child-level data ships — and worth doing on its own merits regardless of this project.
2. **Phase 1, child check-in/out** (30–45 hrs). Best value per hour in the document, and
   the one thing here Procare's payment product does not give us. True attendance, live
   ratio counts, CACFP point-of-service accuracy. **Do this even if nothing else happens.**
3. **Phase 5-revised, billing reconciliation** (6–12 hrs). Make the Procare payment import
   routine, match payments to invoices, fix FS12's date corruption. Small, cheap, and it
   fixes a ledger that is currently six weeks stale with zero invoice-level matching.
4. **Phase 2, daily activity logging + daily report** (60–90 hrs) — **only if the Procare
   add-on answer comes back unattractive.** Must be offline-tolerant.
5. **Phase 3, messaging** (40–60 hrs) — only after a written communications policy exists.
6. **Phase 4, photos** — **defer.** Highest risk, lowest operational readiness.

### What not to do
- **Do not build payments on Stripe.** It is 70–100 hours to reach parity with a working
  system, and at our $519 average payment it would likely *raise* ACH cost by ~$2,600/yr.
- **Do not expand Procare into the whole system.** It would replace working software that
  fits our per-day registration model, which Procare does not.

**The decision that carries the most money** is no longer a rail choice — it is whether the
Procare parent-app tier is cheaper than 140–210 hours of building. Find out first.

**The decision that carries the most risk** is unchanged: whether 31 staff will actually
fill in daily sheets every day. Pilot in **one room for one month** before rolling out —
whether we build it or buy it. If adoption fails there, stop. The money was never the
constraint.

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
- [Tuition Express fee schedule as published by a center (ACH $1.25 / card 2.75%+$1)](https://www.whatisgrace.org/images/uploads/Preschool/2024-2025_Forms/2025-2026%20Tuition%20Information%20-%20Tution%20Express%20Instructions.pdf)
- [Tuition Express Agreement (sample)](https://cdn.hibuwebsites.com/c4b19a99b3f3497a882adb79f9b9880d/files/uploaded/Tuition%20Express%20Agreement.pdf)
- [Tuition Express — SoftwareSuggest](https://www.softwaresuggest.com/tuition-express)
