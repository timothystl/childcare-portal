# Handoff: myMDO Parent Communication

## Overview

Build-out of a **parent communication section** for the Timothy Lutheran MDO childcare portal (`timothystl/childcare-portal`), replacing ProCare parent communication. Covers: a daily feed of photos and moments, check-in/out, naps, meals & bottles, diapering, direct messaging with staff, center announcements, incident/injury reports, push notifications, and full online billing (statements, saved card/ACH, autopay, pay sheet). Includes the staff-phone logging screens that produce the parent-facing content.

Both apps carry a **persistent bottom tab bar** and the whole set is navigable: `Parent App Clickthrough.dc.html` is a working click-through of all 19 screens.

Design premise, from the client: **parents rarely open the app.** So the home screen answers the entire day at a glance, and push notifications are treated as the real front door — the notification itself carries the news, and the app is where you go for detail.

## About the Design Files

The files in this bundle are **design references created in HTML** — prototypes showing intended look and behavior, not production code to copy directly. The task is to **recreate these designs inside the existing `childcare-portal` codebase**, using its established patterns: static HTML pages at the repo root, page-scoped scripts in `js/`, shared tokens and components in `css/styles.css`, Supabase for data, esbuild bundling into `dist/` via `scripts/build.js`, and Cloudflare Pages for hosting. Do not introduce a framework — the app has no build-time component layer, and none of these screens require one.

`Parent Communication.dc.html` is a design-canvas file: 21 phone screens laid out side by side inside device frames. `Parent App Clickthrough.dc.html` is the same screens wired into one phone — tapping tabs, rows and buttons navigates, so it documents the intended routing better than prose can. Both are references; the routing table below is the spec. `ios-frame.jsx`, `image-slot.js`, and `support.js` exist only to render that canvas; **none of them ship**. The device bezels, status bars, and drag-and-drop photo placeholders are presentation scaffolding.

## Fidelity

**High fidelity.** Every color, font, radius, and shadow comes from the real tokens in `css/styles.css` (the "Sunlit Neighborhood — Variation B" system). Spacing and type sizes are final. Recreate pixel-perfectly using the existing CSS variables — do not hardcode the hex values listed below; use the `var(--*)` names.

Copy is written to be shipped as-is, but names (Ellie, Jack, Hannah Reyes, Miss Amy, Miss Kiara, Sonya Bell) and all amounts are placeholder data.

## Navigation

Two tab bars, both **persistent on every non-modal screen** of their side of the app. Shared geometry: `display:grid` with equal columns, `background:var(--white)`, `border-top:1px solid var(--border)`, `padding:8px 2px 22px` (bottom clears the home indicator), `flex-shrink:0` so it never compresses. Cell: column flex, `gap:3px`, `padding:2px 0`, icon 20px, label 10.5px. Active = icon at full opacity + label 800 weight in `--navy`; inactive = icon `opacity:.5` + label 600 in `--text-muted`. Unread counts are `--tang` pills, 10px/800, absolutely positioned `top:-2px; right:14px`. Screen bodies are `flex:1; min-height:0; overflow:auto` above the bar — the bar never scrolls.

**Parent — 5 tabs:** 🏠 Today · 🗓 Schedule · 💳 Billing (badge = unpaid statements) · 💬 Messages (badge = unread threads) · 👤 Account.

**Staff — 4 tabs:** 👶 Room · 🗓 Schedule · 💬 Messages (badge = unread) · 👤 Account.

Pushed detail screens (full-day report, message thread, child info, incident report) keep the tab bar and use a back chevron in the header. Modal sheets (pay sheet, quick log, day-off request) cover it entirely — they are dismissed by the grab handle, never by a tab.

### Routing table

| From | Tap | To |
| --- | --- | --- |
| Any parent screen | tab | Today / Schedule / Billing / Messages / Account |
| Today | See full day → | Full day report |
| Today, Billing, Schedule | Pay | Pay sheet → payment confirmed → Billing |
| Today | Reply | Message thread |
| Messages | a conversation row | Message thread |
| Account | a child row | Child info |
| Child info | ← | Account |
| Any staff screen | tab | Room / Schedule / Messages / Account |
| Staff Room | + on a child row | Quick log sheet |
| Quick log | Flag as incident | Incident form (staff) |
| Incident form | Send to office | Office review → parent's incident view |
| Staff Schedule | Request a day off | Day-off request sheet → back to Schedule |
| Sign in | Unlock with Face ID | Today |

## Screens / Views

Screens are grouped into three rows on the canvas. Row 1 is the recreation of what exists today; rows 2 and 3 are the new work.

---

### Row 1 — Current production (reference only, already built)

**1. `lookup.html` — sign in.** Exact recreation of the shipping page. Background `--green-lt`; centered white card, `max-width:440px`, `padding:44px 40px`, `border-radius:var(--radius-md)`, `box-shadow:0 16px 56px rgba(0,0,0,.22)`, `border:1px solid var(--border)`. Logo `images/logo/myMDO_primary_logo_light.png` at `height:70px`. H1 "My Schedule" in `--font-head` at `1.45em`, `--navy`. Email + PIN fields, ProCare hint line, full-width `.btn-primary`, "← Back to Registration".

**2. `lookup.html` — results.** Header block `background:var(--green)`, `border-radius:var(--radius-md)`, `padding:24px 28px`: white `--font-head` H1, parent email at `rgba(255,255,255,.7)`, Print (`.btn-secondary`) and Log Out (`.btn-ghost` overridden white). Per-child card: `--linen` header with child first name + room label + green grand total; month blocks with tally (`N Full` in `--green-dark`, `N Half` in `--mustard-dark`) and month bill; date chips (`min-width:58px`, DOW / date / Full-or-½; half days use `--sun-pale` + `--sun-lt`); grand-total footer on `--green-pale` with `border-top:2px solid var(--green-lt)`.

---

### Row 2 — Parent app

**3. Notifications (lock screen).** The front door. Four stacked iOS notification cards over a blurred wallpaper: nap ended (with photo mention), message from staff, checked in, and an amber billing card (`rgba(249,183,49,.92)`) for the statement due. Each card: `background:rgba(255,255,255,.82)`, `backdrop-filter:blur(18px)`, `border-radius:18px`, `padding:12px 14px`; 34×34 app icon at `border-radius:9px` on `--navy`; title 14px/700, body 14px/400 at `line-height:1.35`; timestamp 12px `--text-muted`.

Notification triggers to implement: new photo posted, checked in / out, nap logged, diaper change, message from staff, announcement or closure, invoice due and payment receipt, low-supplies request.

**4. Sign in — Face ID.** Same card treatment as `lookup.html` sign-in, plus: logo at `height:78px`, a 76×76 `border-radius:20px` `3px solid --navy` biometric target, "Welcome back, {firstName}" in `--font-head` 22px, full-width navy "Unlock with Face ID", and a 4-box PIN entry row (46×56, `--linen` fill, active box `2px solid var(--sun)` + `box-shadow:0 0 0 3px rgba(245,183,49,0.15)` — the exact focus treatment from `css/styles.css`). Footnote: session persists on the device until sign-out; two parents have two PINs against one family record.

**5. Today — the one-glance home.** The most important screen.
- Header: `background:var(--green-lt)`, `border-bottom:3px solid var(--sun)`, `padding:52px 18px 14px` (top padding clears the status bar). myMDO lockup at 26px, bell with a `--tang` unread dot. Below it, child-switcher chips: active chip is `--navy` pill with white 800-weight name; inactive is `rgba(255,255,255,.6)` with navy text. Avatars under 64px are **monogram circles** (colored fill + `--font-head` letter), never photos.
- **Day card** (white, `--border`, `--radius-md`, `--shadow-card`): date in `--font-head` 19px + room and teachers; status pill "AT SCHOOL" on `--green-pale`/`--green-dark`. A 2×2 stat grid separated by 1px `--warm-gray` gaps — Checked in `8:42a`, Nap `1h 35m`, Meals `3 of 3`, Diapers `4 changes` (label 12px/700 uppercase muted, value 20px/800 navy). Then a timeline: 52px-wide left time column with a 2px `--border` connector, entry title 15px/700, detail 14px muted, and inline photos in a 2-column grid at `height:96px`. Footer button "See full day →" (`.btn-ghost`).
- **Billing nudge**: `--sun-pale` card, `1.5px solid --sun-lt`, statement + due date + autopay state, `--sun` Pay button.
- **Message preview**: staff monogram, name, timestamp, message body, and two quick actions — a navy "Will do 👍" one-tap reply and a ghost "Reply".
- **Announcement**: `--green-pale` card with a `--green-text` uppercase "ANNOUNCEMENT" label; closure copy states the billing consequence ("No charge for that day").
- **Tab bar**: the 5-tab parent bar described under Navigation, with Today active.

**6. Full day + end-of-day report.** Back header with a download affordance. A 210px hero photo with a bottom gradient scrim (`rgba(1,41,74,0)` → `rgba(1,41,74,.78)`) carrying caption and attribution. Then sectioned cards, each with a `--linen` header bar in `--font-head` 16px: **Naps** (times, duration in `--green-dark`, and a 10px-tall bar showing the sleep window within an 11a–3p axis); **Meals & bottles** (row per meal with time, foods, and an amount pill — All/Most on `--green-pale`, Some on `--sun-pale`); **Diapering** (time+type chips matching the schedule chip style, plus a `--tang-pale` supplies request); and a plain "A note from Miss Amy" card, 15px at `line-height:1.55`.

**7. Schedule — with inline charges.** The existing `lookup.js` month-grouping logic, restyled per-month as a card: month name + tally on the left, amount + status on the right (`PAID Aug 1` in `--green-text`, `DUE SEP 1` in `--mustard-dark`). Same date chips as production, plus a closed-day chip (`--warm-gray`, strikethrough, `opacity:.65`). An unpaid month gets a full-width `--sun` "Pay September · $272.00" button inside its own card. Below: ghost "Register for additional days →" linking to `index.html`, and the existing hidden-months disclaimer, reworded to point at Billing → Statements.

**8. Billing.** Navy balance hero: uppercase "BALANCE DUE" label, amount at 40px/800, due date in `--sun-lt`, full-width `--sun` "Pay now", and an autopay row with a toggle, divided by `1px solid rgba(255,255,255,.18)`. Then: **August statement** (line per child, sibling discount as a negative in `--green-text`, bold total); **Payment method** (card and ACH rows, a DEFAULT pill, "Change" link); **History** (paid months and the registration fee with method and date). Footer: ghost "Download statements (PDF)".

**9. Pay sheet.** Modal sheet over a dimmed navy scrim: `border-radius:22px 22px 0 0`, 42×5 grab handle. Amount card with 32px total and a Full-balance / Other-amount segmented pair. Method rows show the **fee consequence** inline — card "+ $9.36 card fee (3%)", ACH "No fee" in `--green-text` — with the fee-free option preselected. A checked `--green-pale` autopay opt-in. Total row, then navy "Pay $312.00". Footnote: processed by the card processor; myMDO never stores card or bank numbers. Processor is deliberately unnamed in the design — swap in Stripe/Square copy when chosen.

**10. Messages.** Thread header with staff monogram, name, and an expectation line ("usually replies by 3p"). Date divider 12px/700 uppercase. Incoming bubbles white with `--border`, `border-radius:14px 14px 14px 4px`; outgoing `--navy` with white text and `14px 14px 4px 14px`; both `padding:11px 14px`, 15px text at `line-height:1.45`, timestamp 11px, read receipt on the outgoing. Photos post inline in a bubble. Composer: `＋` attach, `--linen` rounded input, 38px navy send circle; `padding-bottom:26px`.

**10a. Messages — inbox.** The Messages tab lands here, not in a thread. Header `--green-lt` with a navy "New" button. Conversation rows: white card, `--border`, `--radius-sm+` (12px), 42px monogram, name 16px (800 when unread), role sub-line 12px/600 muted, one-line preview 14px, timestamp 12px, and a 10px `--tang` unread dot on the right. Below a "FROM THE CENTER" micro-label, announcements render as `--green-pale` cards with `1.5px solid --green-lt` and are explicitly not replyable.

**10b. Account (parent).** Everything a family maintains itself, as `--linen`-headed cards:
- **Children** — a row per child (42px monogram, name, room + teacher, allergy badge, `›` chevron) → child info. Plus "+ Add a child" in `--green-text`.
- **Parents & guardians** — a row per parent, then editable field rows for email, mobile, and PIN. Field row pattern: 12px/700 uppercase muted label over a 15px/700 value, with "Edit"/"Change" in `--green-text` on the right, `border-bottom:1px solid var(--warm-gray)`. "+ Invite another parent" issues a second PIN against the same family record.
- **Approved for pickup** — non-app contacts (name, relationship, constraint like "Thursdays only"), each editable, with a `--sun-pale` caution note that new names show ID at the desk and the office reviews additions.
- **Notifications** — five toggles: Daily moments, Messages from staff, Billing reminders, Center announcements, Quiet hours (7p–7a, default off). Toggle: 48×29 track, `--green` when on / `--border` when off, 23px white knob, `box-shadow:0 1px 3px rgba(0,0,0,.2)`.
- **This phone** — Face ID toggle, language, and "Sign out" in `--tang-dark` 15px/800.
- Footer: center name, version, and a Privacy & photo policy link.

**10c. Account → child info.** Header back chevron + child name. Cards: identity (74px circular photo, full name, birthday + computed age, "Change photo", nickname, room — room changes are a "Request"); **Allergies & medical** as a full `--tang`-bordered card with a `#f8ded3` header bar, severity chips (severe = solid `--tang`; others white with `--tang-soft` border), the line "Shows on a teacher's screen before they log any meal or snack", a navy "Request a change" and outlined "Upload action plan", and the rule that medical detail is office-edited so the nurse form stays on file; **Day-to-day** field rows (nap, comfort item, potty, words to know) which parents *can* edit directly; **Photos & privacy** (share with room / use in center materials / 12-month archive retention); **On file** (immunization record CURRENT pill, emergency contact form due for renewal in `--mustard-dark`). Closing note points enrollment and rates back to Schedule.

**10d. Payment confirmed.** Full-bleed `--navy`, centered: 78px `--green` check circle, "Paid $312.00" in `--font-head` 26px white, method + confirmation number at `rgba(255,255,255,.75)`, next autopay charge in `--sun-lt`, a `rgba(255,255,255,.1)` panel confirming the emailed receipt, and a `--sun` "Done" returning to Billing.

---

### Row 3 — Staff phone

**11. Room roster.** Navy header: room name, "9 present · 2 absent · 2 with allergies", a `--sun` time pill, and three `rgba(255,255,255,.12)` stat tiles — NAPPING, NEEDS CHANGE (value in `--sun` when non-zero), UNPOSTED. Child rows: 44px monogram, name, and a one-line status. **Allergy badge** sits inline next to the name — `--tang-pale` fill, `1.5px solid --tang`, `--tang-dark` text, 11px/800 uppercase, e.g. `PEANUT`, `EGG · DAIRY`. A row needing attention is outlined `1.5px solid var(--sun)` with its status in `--mustard-dark` ("Last change 3h ago"); absent children drop to `opacity:.55` and lose the add button. Each active row ends in a 34px navy `+`. Sticky footer: `--sun` "📷 Photo to whole room" and navy "Post 5" (the unposted batch).

**12. Quick log — one child.** Sheet, same geometry as the pay sheet. Header: monogram, name, "Logging at 2:41p". Directly beneath — before any input — the **allergy panel**: `--tang-pale` card with a `--tang` `!` badge, "ALLERGIES & CARE NOTES" label, and chips (severe allergies are solid `--tang` on white text; sensitivities and care notes are white with `--tang-soft` border). This is the placement requirement: allergies are visible on the child's page before a staff member logs a meal.
Then tap-target groups, each with a 12px/800 uppercase muted label: **Diapering** 4-up grid (Wet / BM / Both / Dry), **Nap** 2-up (Fell asleep / Woke — selected state `2px solid --green` on `--green-pale`), **Snack** 4-up (None / Some / Most / All — selected `2px solid --sun` on `--sun-pale`). Selected navy options are solid `--navy` with white text. Two dashed secondary actions: Add photo, Note to parent. Then the **incident button** (see below). Primary: navy "Save · notify Hannah", with "hold to save without a push notification" as the quiet alternative. Every tap target is ≥44px.

**13. Incident report — staff.** Full screen with a `--tang` header and a DRAFT pill. Warning strip explains the routing: office review first, nothing sent until teacher and director both sign. Fields: time + place; incident type chips (Fall / Bump / Bite / Scratch / Illness / Other); a body-map location picker with a `--tang` marker and a resulting location chip; free-text "what happened"; first-aid chips (multi-select, green when chosen); an "After" checklist (back to playing, parent called, medical attention recommended); witness chips; and an optional photo scoped to the office and this child's parents. Signature block: teacher signed with timestamp (script rendering of the name), director row pending in `--mustard-dark`. Footer: ghost "Save draft" + `--tang` "Send to office".

**14. Incident report — parent.** Leads with reassurance: `--tang-pale` card, `!` badge, headline "A small fall on the playground", and a plain-language summary that opens with "She's okay." Then **What happened** (narrative + Where / Type tiles), **Care given** (green check list plus a `--green-pale` watch-for note), and **Signed by** (both signatures with roles and times). Footer: navy "Sign — I've read this" and ghost "Message Miss Amy about this".

**15. Staff — my schedule & days off.** The staff Schedule tab. Navy header: "My schedule", staff name + role, a `--sun` hours-this-week pill, and three `rgba(255,255,255,.12)` tiles — SHIFTS LEFT, DAYS OFF LEFT, PENDING (value in `--sun` when non-zero). Cards: **This week** and **Next week** shift rows (52px left day/date column, hours 15px/700, room + partner or assignment sub-line, and a status pill — Today, Half, Training, Sub on `--green-pale`; Off/Closed on `--warm-gray`); **Days off requested** (date range, reason, and a status pill: APPROVED `--green-pale`, PENDING `--sun-pale`, NEEDS COVER `--tang-pale`) with a navy "Request a day off"; **Center calendar** (closures and optional events, same row pattern). Footnote: the director sees requests immediately, and anything inside two weeks needs a named sub.

**16. Staff — request a day off.** Sheet. Date chips in the schedule-chip style with the selected day solid `--navy` (its "Full" label in `--sun`) and closed days shown but not selectable, plus "+ Pick dates". Reason chips (Personal / Sick / Appointment / Family / Other), single-select navy. **Coverage** card listing available colleagues with availability in `--green-text` and a radio-style select; unavailable staff show why. A note-to-director field, then navy "Send request" and a line that the answer arrives as a push.

**17. Staff — messages.** Navy header, unread count, `--sun` "New". A `--sun-pale` note states the parent-facing expectation ("usually replies by 3p") and that quiet hours hold pushes until 7a. Threads with parents, the director, and a broadcast row ("Toddlers parents · 11 families"); allergy context appears in a parent's sub-line where relevant.

**18. Staff — account.** Navy header. **Me** (display name shown to parents, mobile, rooms — room assignment is office-controlled, PIN). **Training & clearances** — CPR/First Aid with an expiry date and a RENEW SOON `--sun-pale` pill, background check and mandated-reporter training as CURRENT. **Notifications** — parent messages only while clocked in, schedule changes, time-off decisions, quiet hours 5p–7a (default on). **This phone** — Face ID, "Sign out of this room" in `--tang-dark`. Footnote: pay, hours and HR paperwork stay in the office system.

## Interactions & Behavior

- **Push → deep link.** Every notification opens the specific moment, not the app root. Billing notifications open the pay sheet with the amount prefilled.
- **Child switcher** on Today swaps all content in place; no navigation.
- **Quick reply** ("Will do 👍") posts to the thread without leaving Today.
- **Quick log** is optimistic: tapping a chip commits locally and syncs; "Post N" batches unposted entries for a room in one request. Long-press on Save suppresses the push.
- **Incident routing**: staff draft → office review → both signatures → parent notified. The parent's acknowledgment signature writes back to the report.
- **Autopay toggle** appears in three places (Billing hero, pay sheet, settings); all three write the same family-level flag.
- **Pay sheet** defaults to the no-fee method and recomputes "Total today" when the method changes.
- **Photo consent**: a photo containing more than one child is only visible to families who have consented; otherwise it stays internal.
- Transitions: 0.15–0.25s on background/border/transform, matching existing `css/styles.css`. Respect the existing `prefers-reduced-motion` block.
- **Tab state** is a single `route` value; tabs reset a tab's own stack, pushed screens keep it. Modal sheets are a separate layer above the route.
- **Staff schedule** is read-only except for day-off requests: shift edits, room assignment and subbing are office-side writes. A request inside 14 days requires a selected coverage name before Send enables.
- **Time-off status** transitions requested → approved / needs-cover / declined, each pushing to the staff member.
- **Parent Account** writes directly for contact info, PIN, pickup list, notification and photo preferences. Allergies, immunizations, room changes and withdrawal are **requests routed to the office**, never direct edits — that split is deliberate and load-bearing.
- Responsive: designed at 390×844. Below 600px the existing mobile rules apply (44×44 minimum tap targets, icon-only floating buttons).

## State Management

- `family` (id, parents, PINs, autopay flag, payment methods), `students[]` (room, allergies, care notes, consent flags) — extends the existing `registrations` / family-lookup RPC.
- `session` — family id + token, persisted for biometric re-entry; existing PIN lockout rules (`add_login_lockout.sql`) still apply.
- `dayLog[childId][date]` — check-in/out, naps, meals, diapers, notes, photos. Staff writes are queued offline-first and flushed on reconnect.
- `messages[threadId]` — extends the existing parent-contact-form inbox in `js/admin/admin-messages.js` from one-way to threaded.
- `announcements[]` — center-wide, with optional closure date that suppresses the day's charge.
- `incidents[]` — draft / in-review / signed / acknowledged.
- `billing` — statement lines derived from `registration_dates` × room rates (already computed in `js/lookup.js` and `js/admin/admin-billing.js`), plus payments, methods, and autopay.
- `staffSchedule` — shifts (staff id, date, start/end, room, assignment type: regular | half | sub | training), `timeOffRequests` (dates, reason, coverage staff id, status, note, decided_by/at), and `centerCalendar` (closures and events; a closure suppresses that day's charge — same record the parent Schedule reads).
- `staffProfile` — display name, mobile, room assignments, clearances with expiry dates, notification prefs.
- `preferences` — per-family notification toggles, quiet hours, per-child photo consent (room / center materials) and archive retention.
- `pushSubscriptions` — already exists (`add_staff_push_subscriptions.sql`, `js/push-notifications.js`, `sw.js`, `/push-subscribe`); extend the existing VAPID flow to per-event parent preferences.

## Design Tokens

All from `css/styles.css` — use the variable, not the literal.

Colors: `--navy #01294A`, `--navy-lt #013d6b`, `--navy-dk #010f1a`, `--sun #F5B731`, `--sun-lt #FDE598`, `--sun-pale #FFF8E1`, `--green #5BAD8B`, `--green-text #3A7B60`, `--green-lt #C9E6DC`, `--green-pale #EAF5EF`, `--green-dark #1a5c3e`, `--tang #E97D55`, `--tang-pale #FDEEE8`, `--tang-soft #f2b89a`, `--tang-dark #7a2a18`, `--mustard-dark #7a5a00`, `--cream #FDFAF0`, `--linen #FAF7ED`, `--warm-gray #F5F0E4`, `--border #E8E0CC`, `--text #2E2A22`, `--text-muted #7A6E5A`, `--white #FFFFFF`.

Contrast rule already documented in the repo: `--green` is for backgrounds and borders only; any green **text** uses `--green-text`.

Type: `--font-head 'Lora', Georgia, serif` (all headings, child names, card headers); `--font-body 'Nunito', system-ui, sans-serif` (everything else, weights 400/600/700/800); `'Dancing Script'` for the script "my" in the lockup and for rendered signatures only. Scale in use: 40/34/26/22/20/19/17/16/15/14/13/12/11px. Uppercase micro-labels are 12px/800 with `letter-spacing:.08em`.

Radii: `--radius-sm 8px`, `--radius-md 14px`, `--radius-lg 22px`; pills `999px`; sheets `22px 22px 0 0`; message bubbles `14px` with a 4px tail corner.

Shadows: `--shadow-card 0 2px 12px rgba(1,41,74,0.06)`, `--shadow-lift 0 6px 32px rgba(1,41,74,0.12)`, auth card `0 16px 56px rgba(0,0,0,.22)`.

Spacing: 4px base. Card padding 14–18px; screen gutters 16px; section gaps 14px; chip gaps 7–8px. Screen top padding 52px (status bar) and bottom 22–30px (home indicator).

Buttons: reuse `.btn-primary` (navy), `.btn-secondary` (sun), `.btn-ghost` (navy outline), `.btn-sm`. Focus ring is the existing `2px solid var(--navy)` at `outline-offset:2px`.

## Assets

- `images/logo/myMDO_primary_logo_light.png` — the shipping logo, used on both sign-in screens (70px and 78px tall). Included in this bundle; already in the repo.
- `img/mymdo-logo.svg` — vector alternative, also in the repo.
- Icons are emoji, matching the current codebase (🔔 📷 🖨️ ⬇ 🏦 ✎ ✓ ✕ ← →). Swap for an icon set only if the team decides to; do not mix.
- All photographic content is placeholder. The `<image-slot>` elements are canvas-only.
- Child, parent, and staff names and all dollar amounts are fictional.

## Files

- `Parent Communication.dc.html` — the full design canvas, all 21 screens side by side.
- `Parent App Clickthrough.dc.html` — the same screens wired into one navigable phone; the authoritative reference for routing and tab-bar states.
- `ios-frame.jsx`, `image-slot.js`, `support.js` — canvas rendering scaffolding, **not for production**.
- `images/logo/myMDO_primary_logo_light.png` — real asset.

Repo files to read before implementing: `css/styles.css` (tokens and components), `lookup.html` + `js/lookup.js` + `css/lookup.css` (existing parent portal and month/rate math), `js/push-notifications.js` + `sw.js` + `worker.js` (push plumbing and the `/push-subscribe` endpoint), `js/admin/admin-messages.js` (message inbox), `js/admin/admin-billing.js` + `supabase/migrations/add_billing_module.sql` (billing model), `supabase/migrations/add_attendance_records.sql` (attendance), and `scripts/build.js` (add any new page bundle here).

## Open Decisions

1. **Card fees** — the pay sheet assumes a 3% card fee passed to families and free ACH. If the center absorbs it, remove that line and the method-preference logic.
2. **Photo consent and retention** — who sees a photo containing multiple children, and how long photos stay in the archive.
3. **Incident routing** — whether director sign-off must precede parent notification, or the parent is notified immediately with review after.
4. **Staff schedule ownership** — the design treats shift editing as office-only, with staff able to request time off but not swap shifts directly. If teachers should trade shifts peer-to-peer, that's an extra flow.
5. **Paid time off accounting** — "4 days off left" assumes the app knows the PTO balance. If that lives only in the church's payroll system, drop the counter and keep the request list.
6. **Message hours** — staff replying from personal phones after 5p sets an expectation; "usually replies by 3p" is a hint, not an enforced window.
7. **Payment processor** — not chosen; all processor-specific copy is generic.
