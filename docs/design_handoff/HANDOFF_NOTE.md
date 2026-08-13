# Design handoff — kept in the repo on purpose

`README.md` here is the **spec** for the parent communication build: 19–21
screens, two persistent tab bars, exact tokens and geometry.

It lives in the repo because it was lost once. It arrived as an upload, dropped
out of context, and several screens were then built from the plan's prose
description rather than the designs — which is why the shipped portal is a
single scrolling page and the design is a five-tab app. Re-uploading a handoff
mid-build is not a recovery strategy; committing it is.

- `README.md` — the spec. Read this first.
- `Parent Communication.dc.html` — all screens side by side.
- `Parent App Clickthrough.dc.html` — the same screens wired up; authoritative
  for routing and tab-bar states.
- `ios-frame.jsx`, `image-slot.js`, `support.js` — canvas scaffolding, **never
  shipped**. They render the two `.dc.html` files and nothing else.

⚠️ The `.dc.html` files pull React from unpkg, so they need network access to
render. They cannot be rendered from a sandboxed agent session — read the
markup (everything is inline-styled and explicit) or open them in a browser.

## Decisions since the handoff was written

Its "Open Decisions" list is partly settled:

| # | Question | Decided |
|---|---|---|
| 3 | Incident routing | **Director reviews BEFORE the family is notified.** Built that way. The README's §14 flow (parent first) is superseded. |
| 7 | Payment processor | Still open. Build waits; onboarding paperwork does not. |
| 2 | Photo consent / retention | Multi-child photos visible only if every child in frame is released; 7-day window, swept by `pg_cron`. Built. |

Allergies are now recorded for all 150 children, and parents can confirm their
own child's record from the portal — which is not in the handoff, and should be
folded into screen 10c (child info) when that is built.
