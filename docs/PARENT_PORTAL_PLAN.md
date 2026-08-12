# myMDO Parent Communication — Build Plan

**Status:** planning · no code written yet
**Design source:** `design_handoff_parent_communication` (canvas + README, 14 screens)
**Written:** 2026-08-11

Replaces ProCare parent communication: daily feed of photos and moments,
check-in/out, naps, meals & bottles, diapering, direct messaging, announcements,
incident reports, push notifications, and online billing.

Design premise, from the client: **parents rarely open the app.** The home screen
answers the whole day at a glance, and the push notification is the real front
door — the notification carries the news, the app carries the detail.

---

## 1. Decisions locked

| Question | Decision |
|---|---|
| Platform | **PWA**, not native. Installable, Add-to-Home-Screen onboarding. |
| Unlock | Email + PIN first; **WebAuthn passkey** offered after first sign-in (this is what makes the design's "Face ID" screen real). PIN always remains the fallback and recovery path. |
| Existing pages | `lookup.html` and `calendar.html` **stay**, untouched and working. The new app is an additional page. |
| Payment processor | **Not chosen.** Tithe.ly and Square are existing relationships. Requirements in §8. |
| Card fees | **Passed to families** at rollout. ACH is the fee-free option. |
| Photo release | Checkbox on the child profile, **parent-toggleable, default enrolled**. Director fixes the few opt-outs. |
| Photo retention | Daily photos **~7 days**, then auto-deleted. Parents told they're ephemeral; every photo has a save button. |
| Incident retention | The **signed PDF is the archival record** (3yr guideline / 5yr SOL / to age 23 for major injury). Live photo rows expire on the short clock. |
| Incident routing | Parent notified **immediately**; director reviews after. |
| Check-in/out | **Staff-performed**, replacing the ProCare flow. No parent signature required. |
| Staff devices | Personal phones, individual login. **Kiosk PIN is sufficient** to sign a report. |
| Meals | Parents pack food. **Bottles + feeding times for Bear (infants)**; broad meal report elsewhere. No CACFP coupling. |
| Diapering | Shown in **all rooms**, ignored where irrelevant (potty training crosses room lines). |
| Announcements | Purely informational. Closures continue to read from the **existing `closures` data**; billing consequences handled separately. |
| Director | A **configurable role**, not a hardcoded person. Reassignable in Settings. Incident review notifications go to the role address **`mdo@timothystl.org`**. |
| Push scope | **Per family** — both parents are notified of the same events. Content is still scoped to that family's own children. |
| Scale | 121 families (~242 parents), 149 children. |

---

## 2. Notification policy

Real-time push (per-parent, own children only):

- new message from staff
- **first photo of the day** per child (not per photo — that's how you get muted)
- incident report
- invoice due and payment receipt

End-of-day summary push (one per child):

- check-in / check-out times
- naps, diapers, meals/bottles
- teacher note
- low-supplies request

Announcements and closures notify center-wide when published.

Every notification deep-links to the specific moment, not the app root. Billing
notifications open the pay sheet with the amount prefilled.

---

## 3. Architecture

### 3.1 The security problem, and the fix

Everything parents see today rides the **public anon key**. That is survivable for
a schedule listing. It is *not* survivable for nap logs, diaper logs, allergies,
photographs of children, and incident reports — and the open findings in
`docs/CODE_REVIEW_2026-08.md` (R1, R3, R26, R27) are all the same failure: anon
holding grants nobody audited.

**Parents get a real database identity.** ✅ **Built 2026-08-12 — Option B.**
Parents are ordinary **Supabase Auth users**. The `parent-session` edge function
verifies email + PIN through `family_login`, maps the address to an `auth.users`
row in `parent_accounts`, and returns a genuine Supabase session. Every new table
then gets an ordinary RLS policy and the *database* enforces family isolation:

```sql
USING (family_id IN (SELECT parent_family_ids()))
```

No `SECURITY DEFINER` RPC per read (that would be ~15 functions, and it is exactly
the pattern that produced R1/R3/R26/R27) — one definer function, reused by every
policy.

> ### ⚠️ Why `role: authenticated` is now safe — and the order that made it so
>
> **This section originally said the opposite, and was right at the time.** Every
> admin table then carried `FOR ALL TO authenticated USING (true)` —
> `billing_invoices`, `staff`, `admin_audit_log`, all of them. Handing parents the
> `authenticated` role would have given all 242 of them read/write on staff wages
> and the billing ledger. The plan was a dedicated `parent_portal` Postgres role.
>
> **The policy-scoping work (stages 1–5, 2026-08-12) removed the reason for it.**
> All 27 of those tables are now scoped to `is_admin()`, so an `authenticated`
> token grants **nothing** by default. Access exists only where an explicit parent
> policy keys through `parent_family_ids()`.
>
> That is a strictly better boundary than the custom role was going to be: it needs
> no access-token hook rewriting the `role` claim on every login, and it cannot be
> defeated by that hook silently failing. `parent_portal` and its refresh-token
> table were dropped — see
> `parent_portal_option_b_retire_phase0_auth_APPLIED.sql`.
>
> **Acceptance test, must still run before any parent traffic:** hold a real parent
> session and confirm `permission denied` / zero rows on `families`, `staff`,
> `billing_invoices`, `admin_audit_log`, `staff_clock_events`,
> `attendance_records` and `parent_accounts`; and confirm a parent of family A
> returns zero rows for family B's photos, logs, messages, and incidents.

Sessions are Supabase's own: a 1-hour access token plus a rotating refresh token
that supabase-js renews on its own. Sign-out is `auth.signOut()`. This replaces
both the 1-hour HMAC token that only `/push-subscribe` accepted **and** the
hand-signed HS256 token Phase 0 shipped.

⚠️ Login is minted with `admin.generateLink` + `verifyOtp`, **not** by rotating the
user's password and signing in. An admin password update revokes every existing
session for that user, so the password route would silently sign a parent out of
their phone whenever they logged in on a laptop. `generateLink` sends no mail.

### 3.2 Pages and build

New, additive — nothing existing is modified or removed:

```
portal.html            parent app (tabbed: Today / Schedule / Billing / Messages)   ✅ sign-in shipped
staff.html             staff phone (roster, quick log, incident report)
css/portal.css         phone-first styles, built on existing tokens                 ✅ shipped
js/portal/             portal-auth ✅, portal-today, portal-day,
                       portal-schedule, portal-billing, portal-messages
js/staff/              staff-roster, staff-log, staff-incident
```

`portal.html` shipped 2026-08-12 as **sign-in only** — the tabs come with the
Today feed. It exists this early because Option B changed what a login produces
and that round trip needed a way to be run for real; `?check=1` is that. It is
deliberately **not linked from anywhere** yet, so parents keep using
`calendar.html` / `lookup.html` until there is something behind the door.

Both pages get bundle entries in `scripts/build.js`. Per `CLAUDE.md`, the deploy
has **no build step** — `dist/` is committed, so `npm run build` runs and `dist/`
is committed with every JS change.

Fidelity is high: recreate pixel-accurately using the existing `var(--*)` tokens.
No hardcoded hex. `--green` is background and border only; green *text* is
`--green-text`.

### 3.3 Photos

- Client-side compression before upload: longest edge 1280px, JPEG q0.75, ~150KB.
- Private Supabase Storage bucket. Access via short-lived signed URLs issued by an
  edge function that validates the parent JWT — never a public bucket.
- Storage footprint at this scale is trivial: a 7-day rolling window across 149
  children lands well under a gigabyte.
- `pg_cron` daily job deletes expired rows and their storage objects. (`pg_cron` is
  already in use — see `setup_missed_clock_cron.sql`.)

**Visibility rule.** A photo is visible to a family when one of their children
appears in it **and** every child in it has `photo_release = true`. A photo
containing a non-released child stays internal to staff. Since the default is
released, this affects a small handful of families; the director gets a settings
view listing opt-outs so fixing them is a two-minute job rather than a hunt.

---

## 4. Phase 0 — Foundation

*Nothing parent-visible. Prerequisite for everything below.*

- ~~Postgres role `parent_portal` + grants~~ — **superseded by Option B.** Replaced
  by `parent_accounts` (`user_id` → `family_id`) and `parent_family_ids()`. The
  acceptance test in §3.1 still applies, run against a real parent session.
- ~~`parent_refresh_tokens`~~ — **dropped.** Supabase Auth owns refresh now.
- Edge function `parent-session`: login → a real Supabase session (access +
  refresh token). Reuses the existing `family_login(text, text)` RPC unchanged —
  PIN semantics, lockout, and the SS2 text-PIN fix all stay exactly as they are.
  Client entry point is `parentPortalLogin()` / `parentPortalLogout()` in
  `js/supabase.js`.
- `students` gains:
  - `photo_release boolean NOT NULL DEFAULT true`
  - `allergies jsonb NOT NULL DEFAULT '[]'` — `[{label, severity}]` where severity
    is `severe` | `sensitivity` | `note`, driving the design's chip styling
  - `care_notes text`
- Admin child profile gains the photo-release checkbox and the allergy editor.
- Settings gains the **director role** assignment.

**Allergy data has to be entered before Phase 1 ships.** There is currently no
allergy field anywhere in the system, and the design makes the allergy panel a
safety requirement — it renders above every input on the quick-log screen, before
a staff member can log a meal. 149 children of data entry from the paper
enrollment forms is a real task; it should start during Phase 0, not on Phase 1
launch day.

---

## 5. Phase 1 — The daily feed

*The actual ProCare replacement. The largest phase and the one parents judge.*

**Screens:** Today · Full day report · Staff room roster · Staff quick log
**Plus:** photos, announcements, push, PWA install and passkey onboarding.

### Data

`child_day_events` — one row per logged moment, which is what a timeline wants:

| column | notes |
|---|---|
| `student_id`, `registration_id`, `care_date` | |
| `event_type` | `check_in` `check_out` `nap_start` `nap_end` `diaper` `bottle` `meal` `note` `supplies` |
| `occurred_at` | staff-editable; defaults to now |
| `detail jsonb` | diaper type; bottle oz; meal + amount (`some`/`most`/`all`/`none`); note text |
| `recorded_by_staff_id` | |

`child_photos` — depicted students, room, care_date, storage path, caption,
poster, `expires_at`.

`announcements` — title, body, published/expires, optional informational closure
reference. Reads existing `closures` for closed days; does not write billing.

Check-in/out is staff-tapped from the roster and also upserts `attendance_records`
(applied 2026-08-11), so attendance reporting gets filled in as a side effect
rather than as separate work.

### Behavior

- **Optimistic quick log.** Tapping a chip commits locally and syncs; entries queue
  offline and flush on reconnect. "Post N" batches a room's unposted entries into
  one request. Long-press Save suppresses the push.
- **Allergy panel renders above all inputs** on the quick-log sheet. Severe
  allergies are solid `--tang` on white; sensitivities and care notes are outlined.
- Child switcher on Today swaps content in place, no navigation.
- Every tap target ≥ 44px.

---

## 6. Phase 2 — Messaging

Threaded parent ↔ staff, upgrading the one-way contact form.

- `message_threads` (family, assigned staff, last_message_at)
- `message_items` (sender type + identity, body, optional photo, read_at)
- The existing `messages` table and its admin inbox stay as-is for the public
  contact form — this is additive.
- Staff reply from `staff.html`; office replies from the admin inbox.
- Read receipts on outgoing parent messages.
- Quick reply ("Will do 👍") posts from Today without leaving the screen.
- "Usually replies by 3p" is a displayed hint, not an enforced window.

---

## 7. Phase 3 — Incident reports

`incidents` — occurred_at, place, type, body-map location, narrative, first-aid
(multi), aftercare checklist, witnesses, optional photo, and the signature block:
teacher (staff id + timestamp), director (staff id + timestamp), parent
acknowledgment (name + timestamp).

Status flow, per the decision above: `draft` → **`parent_notified`** →
`director_reviewed` → `acknowledged`. The parent hears immediately; the director
reviews after.

The parent-facing view leads with reassurance — headline, then a plain-language
summary opening with "She's okay," then what happened, care given, and signatures.

**Retention.** On the second signature, the report renders to a PDF stored on the
long schedule; that PDF is the record you retain and hand to a licensing
inspector. Keeping a child's injury photo in live storage until they turn 23 is a
twenty-year liability in a system that isn't an archive — one artifact to retain,
one to print.

---

## 8. Phase 4 — Billing and online payments

*Last deliberately — but processor onboarding has the longest lead time and should
start whenever you're ready, independent of build order.*

### 8.1 Prerequisite, non-negotiable

**FS5 / T1 must be closed first.** Invoice amounts were client-supplied, and
`anon` could inflate a known family's draft invoice. That is tolerable only
while no payment processor is attached; attaching one converts it into a live
financial vector.

**Status: migrations written 2026-08-11, not yet applied.**
`fs5_phase1_revoke_add_day_anon.sql` and
`fs5_phase2_server_side_invoice_amount.sql`, with rollbacks for both. Phase 2
removes the amount from the API surface entirely and recomputes it in the
database. Apply and verify both before any processor work begins.

### 8.2 Processor requirements

**Disqualifying if absent:**

1. **Hosted fields / tokenization.** Card entry inside a processor-controlled
   iframe. Keeps you at PCI SAQ-A. Anything wanting card data posted to your
   backend is out.
2. **Arbitrary-amount charges against a saved method.** This eliminates most
   "recurring billing" products. Tuition varies monthly with days registered — you
   need "charge this family's stored card $272.00 on the 1st," not a fixed
   subscription plan. In processor language: merchant-initiated transactions
   against a stored credential.
3. **ACH / bank debit, flat or near-zero fee.** Since card fees pass to families,
   ACH must be visibly cheaper or the pay-sheet design collapses. Ask: per-txn
   cost, cap, settlement time, NSF return fee and retry behavior.
4. **Surcharging with automatic debit exclusion.** The biggest trap. Surcharging is
   legal in Missouri, but network rules cap it at 3%, require disclosure before
   entry and on the receipt, require registering with Visa/Mastercard ~30 days
   ahead, and **prohibit surcharging debit and prepaid cards entirely** — even run
   as credit. The processor must identify debit at BIN level and suppress the fee
   automatically. Ask in exactly those words; a processor that simply adds 3% to
   everything will get you fined.
5. **Signed webhooks** — succeeded / failed / refunded / disputed — so
   `billing_payments` reconciles itself.
6. **Vaulting with an account updater.** Without automatic card-reissue updates,
   autopay silently dies for a few families every month and nobody notices until
   they're delinquent.
7. Sandbox environment; idempotency keys on charge creation.

**Strongly wanted:** Apple Pay / Google Pay (one tap on a phone-first PWA, and it
cuts failed payments); nonprofit pricing (both Stripe and Square discount for
501(c)(3) but you must apply); deposit-level settlement reporting that ties to the
bank deposit; API refunds including partial; **vault portability** — confirm you
can migrate stored cards to another processor, or 121 families' saved cards become
the reason you can never switch.

**Ask about:** the full fee sheet including monthly minimum, gateway fee, PCI fee,
chargeback fee; underwriting lead time for a church-affiliated childcare (EIN, bank
account, beneficial ownership — often the real critical path); whether they class
your fee as a **surcharge** or a **convenience fee**, in writing, since these are
regulated differently; and who sends the receipt.

**The math:** ~121 families at a few hundred a month is roughly $30–40k/month. At
3% that's on the order of $1,000/month in card fees — which is why passing them on
matters, and why every family moved to ACH is real money. The pay sheet should
make ACH the obvious choice, which is what the design already does.

**On the two existing relationships:** Square clears most of this list — real Web
Payments SDK, card and ACH, webhooks, vaulting. Tithe.ly is built for donations and
recurring giving; variable-amount tuition invoicing and compliant surcharging are
worth asking them about directly. Either way, keep tuition on a separate merchant
account from offering, even with the same vendor — it keeps the church's books
clean.

### 8.3 Build

- `payment_methods` — family, processor customer/method ids, brand, last4, type,
  is_default. **No PAN, ever.**
- `families.autopay_enabled`; `billing_payments` gains processor payment id and fee
  amount.
- Screens: Billing (balance hero, statement, methods, history) and the pay sheet
  (fee consequence inline, fee-free method preselected, autopay opt-in).
- The autopay toggle appears in three places — Billing hero, pay sheet, settings —
  and all three write the same family-level flag.

---

## 9. Rollout

1. Phase 0 ships silently; allergy and photo-release data entry begins.
2. Phase 1 pilots with a handful of staff and ~5 friendly families for two weeks
   before center-wide. The staff quick-log flow is the risk — if logging a child
   takes more than about a minute, staff won't do it and the parent feed is empty.
3. PWA install is prompted on first sign-in and re-prompted; on iOS, push does not
   work at all until the app is on the home screen, so install rate is worth
   watching as a real metric.
4. `lookup.html` and `calendar.html` keep working throughout. No cutover, no
   removal.

---

## 10. Open items

- Real-time vs. summary for check-in/out — currently planned as summary; the "she
  made it" reassurance may be worth a real-time push.
- Meal amount scale: `some` / `most` / `all` — is a "didn't touch it" option
  wanted?
- Confirm the director is in `admin_roles` as **full**.
### Phase 0 verification (2026-08-11) — historical, superseded by Option B

> These checks were run against the Phase 0 hand-signed-token design. The
> objects they verify (`parent_portal`, `parent_refresh_tokens`) no longer
> exist. Kept for the record; the live verification is the Option B section
> below.

- `parent-session` deployed, `PARENT_JWT_SECRET` set. A login with a bogus email
  returned **401 `not_found`**, not 500 `server_misconfigured` — so the secret is
  present and the call reached `family_login`. Edge logs show `OPTIONS 200`
  (CORS preflight) then `POST 401`, no server error.
- `pg_has_role('authenticator','parent_portal','MEMBER')` = **true**, so
  PostgREST can `SET ROLE` from the token's `role` claim. `parent_portal` is
  `NOLOGIN` and holds schema `USAGE` only.
- `parent_portal` holds **zero** table privileges; `parent_refresh_tokens` is
  unreadable by `anon`, `authenticated` and `parent_portal` alike.
- The allergy shape guard rejects an empty label and an unknown severity, and
  accepts a well-formed value. 149 children default to `photo_release = true`.

**Still unexercised:** a real issued token has not yet been presented to
PostgREST — that needs one login with a genuine family email and PIN. Every
component it depends on is verified; the end-to-end round trip is not. Do this
as the first step of Phase 1, before any table policy is written against it.

### Option B verification (2026-08-12)

- `parent-session` redeployed as **v4**, `verify_jwt: false` (parents arrive with
  an email and a PIN, not a token).
- `parent_refresh_tokens` dropped (0 rows); `parent_portal` role dropped after
  revoking its incidental grants and its `authenticator` membership. Catalog
  re-checked after: role gone, table gone, `parent_accounts` +
  `parent_family_ids()` + `my_parent_context()` present.
- `PARENT_JWT_SECRET` is no longer read by anything. It can be deleted from the
  function secrets — but see the DO-NOT-REVOKE box below, which is about the
  *underlying* legacy secret and still stands.

**✅ Exercised end to end 2026-08-12 — all green.** A real family signed in at
`portal.html?check=1` on the live site. The session came back as a genuine
Supabase token (`role: authenticated`), `my_parent_context()` recognised the
family, and every admin table returned nothing. The OTP redemption — the one
step with real runtime uncertainty, since which type a magic-link hash answers
to has moved between GoTrue releases — works.

**Phase 0 is therefore closed, and the §3.1 acceptance test has passed against
the real identity.** Phase 1 table policies can be written against
`parent_family_ids()`.

⚠️ **The first run was NOT green, and that is the point of the panel.** It found
three tables answering a parent — `staff`, `staff_hours`, `staff_clock_events` —
because their policies were written `TO public`, which includes `authenticated`,
not just anon. Sweeping the catalog for the same shape found four more
(`church_staff`, `church_staff_period_entries`, `payroll_periods`,
`staff_pto_entries`) that were open to the public anon key outright. See
`close_to_public_policy_leaks_APPLIED.sql`.

**Re-run this panel after every migration that adds or changes a policy.**
Reasoning about RLS from the catalog missed all seven; asking the database as
the actual role found them in one page load.

## ⚠️ JWT signing — settled, with an expiry date

> **Update 2026-08-12 — this section is now history for parents.** Option B
> removed the parent portal's dependency on the legacy secret entirely. The
> DO-NOT-REVOKE warning below still stands, but for a different reason: the
> `anon` key that `index.html`, `lookup.html` and `calendar.html` run on is still
> an HS256 token verified by it.

**This project has ALREADY migrated to JWT Signing Keys.** The dashboard's
Legacy JWT Secret tab states it plainly: *"Legacy JWT secret has been migrated
to new JWT Signing Keys… It is used to **only verify** JSON Web Tokens."*

The legacy HS256 secret survives as a **verification-only** key. That is what
still validates the `anon` and `service_role` keys the whole app runs on, and
it is why `parent-session` can sign HS256 tokens that Supabase accepts.

`PARENT_JWT_SECRET` is that legacy secret. It is not readable from SQL or the
management API — copy it from Dashboard → JWT Keys → Legacy JWT Secret. Without
it `parent-session` returns 500 rather than issuing a token nothing can verify.

> ### 🚫 DO NOT REVOKE THE LEGACY JWT SECRET
> Revoking it invalidates **every** HS256 token at once — parent sessions *and*
> the `anon` key `index.html`, `lookup.html` and `calendar.html` all depend on.
> Supabase's UI actively nudges toward this ("Consider switching to publishable
> and secret API keys to disable them"). Do not accept that prompt until the
> work below is done.

**Agreed plan (2026-08-11): A now, B before Phase 1 ships.**

- **A — legacy secret + RLS.** ~~Built 2026-08-11~~, **retired 2026-08-12.**
  Parents got a `parent_portal` token signed with the legacy secret. It worked,
  and it died the day the secret was revoked — which is why it was always a
  stopgap.
- **B — parents become real Supabase Auth users.** ✅ **Shipped 2026-08-12.** On
  first PIN login the edge function creates or looks up an `auth.users` row for
  that parent and returns a genuine Supabase session. The PIN stays the
  credential and `family_login` keeps owning the bcrypt compare and lockout.

  **Simpler than designed: no custom access token hook.** The plan was to inject
  `family_id` into the claims. That turned out to be unnecessary — the policy
  scoping done the same day means a plain `authenticated` token grants nothing,
  so family isolation can come from a join (`parent_accounts`, read through
  `parent_family_ids()`) rather than from a claim. A join is a fact the database
  owns; a claim is only as good as the hook that keeps writing it.

  B was deliberately scheduled *before* Phase 1 rather than after: Phase 1 is
  where photos of children and daily logs get their table policies, and those
  policies should be written once against the identity model that will still be
  there in a year.

- **C — rejected.** Routing every parent read through service-role edge
  functions moves enforcement out of the database and into per-endpoint
  discipline. That is the shape of R1/R3/R26/R27, and this project has spent
  months moving the other way.

---

## 11. Standing constraints

From `CLAUDE.md` and the review docs — these bite every phase:

- **`supabase/migrations/` is not auto-applied.** Run migrations by hand in the SQL
  Editor and verify against the catalog. A committed migration is not a deployed
  one — that is exactly how R5 and R24 hid.
- Re-run the migration/catalog diff after any migration work in this project.
- Auth, billing, and RLS changes get staged and smoke-tested (parent login, kiosk,
  a test registration, admin tabs) before production.
- `dist/` is committed; rebuild and commit it with every JS change.
- `npm run bump` before every PR.
- Don't run two `claude/**` branches editing shared files at once.
