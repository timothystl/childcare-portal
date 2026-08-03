# Live Test Checklist — after the 2026-08-02/03 security remediation

Covers everything changed at `v2.3.19 → v2.3.25`. Every item below is either
something a change could plausibly have broken, something newly visible, or a
question that cannot be answered from the code.

**Roughly 30–40 minutes.** Test 1 first — it is the only genuine unknown.

**Update (v2.3.25):** four feature items added below — the Turtle/Owl room
split, the homepage waitlist link, the new Audit Log tab, and the font trim.
Original Parts 1–4 are unchanged and still apply if you haven't done them yet.

## Before you start

Open the browser console so errors are visible while you click:
- **Mac Chrome/Edge:** ⌘ + ⌥ + J · **Windows:** F12, then the *Console* tab
- **Safari:** enable Develop menu first (Settings → Advanced → Show features for web developers), then ⌥ + ⌘ + C

Red lines are errors. Yellow warnings are usually fine. If you see red, copy the
text — that is the single most useful thing you can bring back.

Do a hard refresh on each page the first time: **⌘ + Shift + R** / **Ctrl + Shift + R**.
Caching behaviour changed, so the first load should be from scratch.

---

## PART 1 — The one real unknown

### ☐ 1. Public waitlist form submission — **do this first**

**Why:** `submitWaitlistApplication()` asks the database to hand the new row back
after inserting it. Under the current security rules an anonymous visitor has
permission to insert but *not* to read that table — and reading is required to hand
the row back. Either this is failing today, or something is carrying it that I
couldn't see. The most recent real application is dated **11 July**, three weeks ago,
which is suggestive but not proof. I deliberately changed nothing near this.

**Steps**
1. Open the public waitlist/inquiry form as a stranger would — **log out first, or use
   a private/incognito window**. This matters: logged in, it may work when it wouldn't
   for a parent.
2. Fill it in with obvious test data — child name `ZZ Test Child`, your own email.
3. Submit. Watch the console as you press it.

**Expect:** a success message, and the entry appears in the admin Waitlist tab.

**Report back either way**, including any red console text. If it fails this is a
live bug predating all of this work, and I'll fix it. If it succeeds, tell me — I'll
tighten that table's permissions too, which I held off on.

Delete the test entry from the admin Waitlist tab afterwards.

---

## PART 2 — Did I break anything? (regression checks)

These exercise every path touched by a database permission change.

### ☐ 2. Parent login — **the highest-risk item**
A previous attempt at this kind of change broke parent login. I changed which columns
an anonymous visitor may read from the family table.

1. Log out / incognito. Go to the parent portal.
2. Log in with a real family email + PIN (use your own test family).
3. Confirm the children and their schedules appear.

**Expect:** normal login. **Bad:** "permission denied", a spinner that never resolves,
or children missing.

### ☐ 3. Parent PIN reset
Uses a different mechanism than the one I locked down, but it is adjacent.
1. Use "Forgot PIN" on the parent portal. 2. Follow the emailed link. 3. Set a new PIN.
4. Log in with the new PIN.

### ☐ 4. Clock-in kiosk — **test on the actual tablet**
I removed the kiosk's ability to read the staff table directly (it uses a
purpose-built lookup instead), and re-enabled pinch-zoom.
1. Open the kiosk on the tablet staff actually use. 2. Clock a staff member in with
their PIN. 3. Clock them out. 4. Try pinch-to-zoom — it should now work (it was
disabled before; this is intended).

**Bad:** PIN not recognised, or an error on clock-in.

### ☐ 5. Registration — a real submission
Registration is open now (the window runs the 1st–15th).
1. Log in as a parent. 2. Pick days for a child. 3. Confirm **closed days are greyed
out** — this checks the closures permission change. 4. Confirm the rate/price shows —
this checks the settings permission change. 5. Submit.
6. Confirm it appears in the admin Calendar tab.

Delete the test registration afterwards.

### ☐ 6. Contact Us / Message the Office
I removed anonymous *read* access to messages while keeping *write*.
1. Logged out, send a message through Contact Us. 2. Send one through the waitlist
status page's "Message the Office" if you use it. 3. Confirm both arrive in the admin
Messages tab.

**Bad:** an error on send, or a success message with nothing arriving.

### ☐ 7. Admin — setting PINs
This is the function I locked down hardest. All four paths:
1. Edit a family → set a new family PIN → save. 2. Set a second-parent PIN.
3. Create a brand-new family *with* a PIN. 4. Staff roster → set a staff PIN.

**Bad:** "permission denied for function set_family_pin". If you see that, tell me
immediately — it means an admin path runs anonymously and I need to adjust.

### ☐ 8. Admin — settings and closures
1. Settings → change a room rate → save → reload → confirm it stuck.
2. Add a closure date → confirm it appears → delete it.

### ☐ 9. Admin — Excel exports and charts
I made the spreadsheet and chart libraries load later so pages render faster.
1. Export any report to Excel/CSV. 2. Open a tab with a chart (Finance, Reports).
3. Confirm charts draw and the export downloads and opens.

**Bad:** "XLSX is not defined" or "Chart is not defined" in the console.

### ☐ 10. Admin — staff roster and payroll
1. Open the Staff Roster — confirm names, rates, and pay types all show.
2. Run a payroll report — confirm wages calculate.

**Bad:** blank wage columns. Would mean the admin session isn't authenticating as I expect.

---

## PART 3 — Deliberate visible changes

Not bugs. Confirm they look right, and tell me if you dislike any.

### ☐ 11. Fonts — **the most noticeable change**
The site's security headers were blocking Google Fonts in production, so the brand
typefaces (Lora, Nunito, Dancing Script) were **never loading on the live site** —
it silently fell back to system fonts. That's fixed, so the site will look different.

Check the "myMDO" logo lockup on the parent portal — the script "my" should render in
a handwriting face. Confirm headings look right and nothing overflows its box on
mobile. If the layout now breaks somewhere because real fonts are wider, tell me.

### ☐ 12. Link colour
Links were a light green that failed accessibility contrast standards. They're now a
darker green. Purely a legibility fix — confirm it still looks like your brand.

### ☐ 13. CSV exports — **check this one specifically**
I added protection against a real risk: a parent could type `=SOMETHING` into their
child's name and have it execute as a formula when you open the export. Cells
starting with `=`, `+`, `-` or `@` now get a leading apostrophe.

**The trade-off:** phone numbers stored as `+1 314…` may now display with a visible
apostrophe in the export. Export an AR or family report, open it, and look at the
phone column. **If it looks wrong, tell me** — I can narrow the guard to only `=` and
`@`, which keeps the protection where it matters and leaves phone numbers alone.

### ☐ 14. Keyboard focus in admin
Press **Tab** repeatedly on the admin dashboard. Each button/field should show a
visible dark blue outline. There was none before.

---

## PART 4 — New capability

### ☐ 15. Audit log is recording
The audit log never existed until 3 August — the setup script was written but never
run, and the failure was invisible. It's live now.

1. Perform any admin action that logs — delete a registration, change a rate, lock a family.
2. If the admin UI has an audit view, open it and confirm the entry appears with
   **your email**, the action, and a timestamp.
3. If there's no UI for it yet, tell me and I'll confirm from the database.

Note: nothing before 3 August 2026 was recorded and that history cannot be recovered.

---

## PART 5 — What to send back

1. Which numbered items passed.
2. Any **red console text**, copied as text.
3. Anything that looked visually wrong after the font change.
4. Your verdict on the CSV apostrophe (item 13).
5. The result of item 1 — the waitlist form.

Every database change is individually and instantly reversible. If something breaks,
say which item number and what you saw, and I'll revert that specific change rather
than unpicking the whole set.

---

## PART 6 — New this round (v2.3.25)

### ☐ 16. Turtle/Owl room split
Your live Settings → Rates currently has Turtle and Owl both covering 24–36
months (Goose covers 36–60). That's what you confirmed you want, so the app
now splits registrations between them: a returning child stays in whichever
of the two they were most recently enrolled in; a child with no history in
either goes to whichever room has more open seats that month.

1. Log in as a parent with a child aged 24–36 months who has **no prior
   registration**. Check their box on the registration screen.
2. A small room badge should now appear on their card — confirm it shows
   **Turtle or Owl**, not blank.
3. If you have a second such family available, register that child too —
   confirm the badge tends toward whichever room has fewer kids so far that
   month (not always the same room every time).
4. Register a child who **was** in Turtle or Owl last month — confirm the
   badge matches last month's room, not whatever the fill count would
   otherwise suggest.

**Bad:** no room badge appears, the badge is blank, or "Could not assign a
room" shows for a 24–36-month-old.

If you'd actually rather Turtle/Owl/Goose go back to non-overlapping bands
(24–30 / 30–36 / 36+) instead of splitting, say so — the split logic just
won't run in that case, no cleanup needed.

### ☐ 17. Homepage waitlist link
1. Log out, visit the homepage.
2. Scroll to (or click "Get Started" in the nav to jump to) the **Ready to
   join us?** section.
3. Confirm there are now **three** cards — Enroll, Request Days, and a new
   **"Not Yet Enrolled — Join the Waitlist"** card.
4. Click it, confirm it opens the waitlist form (`/inquiry`).

### ☐ 18. Audit Log tab
1. Log in as a **full-access** admin. Confirm a new **🧾 Audit Log** item
   appears in the admin nav.
2. Open it — confirm you see entries with a timestamp, your email, an
   action, and an entity (your two rate-setting saves from testing earlier
   should be there).
3. Type something in the filter box (e.g. your own email) — confirm the list
   narrows. Clear it, confirm it returns to the full list.
4. Click **Refresh** — confirm it reloads without error.
5. If you have a **restricted** or **staff**-level admin account, log in as
   that role and confirm the Audit Log tab is **not visible** to them.

**Bad:** the tab doesn't appear at all, it errors on load, or a
restricted/staff account can see it.

### ☐ 19. Fonts, second pass
The font set changed again (10 files → 7). This should look **identical** to
what you confirmed in item 11 — the two files removed were confirmed unused
anywhere in the site's CSS. If anything about text weight or a small italic
label (there's one, on the calendar page's registration-month heading) looks
different from before, tell me — it would mean I missed a usage.

## Not on this list — decisions, not tests

- **R24** — the registration window is not enforced on the server; the deadline is
  currently enforced only by the browser and can be bypassed. Fixing it changes
  behaviour at a live deadline, so it needs a deliberate go-ahead.
- **R4** — an anonymous visitor can still delete child records. Needs the same
  function-by-function tracing I did elsewhere; the parent portal genuinely writes to
  that table, so it isn't a one-liner.
- **R1** — the main event: the public key can still read family and child records.
  Four-phase plan in `docs/CODE_REVIEW_2026-08.md`; phase 3 is the real work.
- Whether to notify families about the PIN-hash exposure. Evidence says it was never
  accessed — see the exposure check in the review doc — but the decision is the
  church's.
