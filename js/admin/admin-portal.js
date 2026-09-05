// ============================================================
// MODULE: Admin Portal Shell  (design handoff — myMDO Admin Portal)
// ============================================================
// The redesign's information architecture, layered over the admin
// sections that already exist. Nothing here re-implements a tool: each
// `.admin-section` / `.table-section` in admin.html becomes one entry in
// AP_TOOLS, and the shell decides which one is on screen.
//
// Two levels, no modes:
//   1. Dashboard — the landing state for every tab. Metrics, panels,
//      attention list, and contextual tool pills next to the numbers
//      that motivate opening them.
//   2. Detail    — a tool is open; the sidebar stays put and highlights
//      where you are, so no back link is needed.
//
// The permanent left sidebar (#apNav) is the tool index. There is no
// layout toggle and no separate list-of-everything screen: asking the
// director to pick a presentation of the menu before picking a tool was
// a decision the product should never have put to her.
//
// Two tools are new and fully built here rather than mapped:
//   * Daily Staffing Requirement — ceil(registered children / ratio) per
//     room per day, from booked registrations only. Never clock-in data.
//   * Rate Increase Scenarios — annual revenue/labor/net projection off
//     real care-day volume.
// A third, the time-off approval queue, is injected into the existing
// Build Staff Schedule tool; it is the director half of the kiosk's
// "Ask for a day off" flow.
// ============================================================

const AP_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

const AP_TINT = {
    gold:  '#FFF8E1',
    green: '#EAF5EF',
    tang:  '#FDEEE8',
    sand:  '#F5F0E4',
    blue:  '#E4EEF6',
};

const AP_TONE = { navy: '#01294A', ok: '#3A7B60', gold: '#F5B731', warn: '#E97D55', deep: '#B3452B' };

const AP_TABS = {
    director: {
        icon: '🧭', label: 'Director',
        blurb: "Staffing and enrollment in one place — who's coming, who you need on the floor, and who's waiting for a seat.",
    },
    messages: {
        icon: '💬', label: 'Messages',
        blurb: "Every conversation with families and prospects, in one place — who's waiting on you, and what still needs an email.",
        // One working inbox (design handoff design_handoff_messages_settings/
        // Messages.dc.html, 2026-08-26) replaced the tab's old two-tool split
        // (Family Conversations / Contact Us Messages). Same reasoning as
        // Finance's defaultTool: one real tool, no dashboard to land on first.
        defaultTool: 'messages',
    },
    classrooms: {
        icon: '📋', label: 'Classrooms',
        blurb: 'Who is here, in which room, on which day — and the family records behind them.',
    },
    staff: {
        icon: '👥', label: 'Staff',
        blurb: "Who's working, when, and what they're owed — plus the day-off requests waiting on you.",
    },
    finance: {
        icon: '💰', label: 'Finance',
        blurb: 'Billing, invoices, and who owes — one ledger, one number for each.',
        // Finance Hub (design handoff, 2026-08-26) replaced the four screens
        // this tab used to fan out to (Bill This Month / Who Owes / Invoices /
        // Family Billing Summary) with one ledger. A landing dashboard that
        // still linked out to those tools would put the director right back
        // where the redesign started — pick a screen before you can do
        // anything. Finance opens straight into its one real tool instead of
        // the generic Dashboard/Detail split every other tab uses.
        defaultTool: 'financeHub',
    },
    planning: {
        icon: '🗓️', label: 'Planning',
        blurb: "The waitlist and everything downstream of it — who's waiting, what's opening up, and how full we'll be.",
    },
    market: {
        icon: '📈', label: 'Market Analysis', short: 'Market',
        blurb: 'How we compare to other providers on price, flexibility, and cost — and the provider set behind those numbers.',
    },
    settings: {
        icon: '⚙️', label: 'Settings',
        blurb: 'The rules the portal runs on. Every control shows who last changed it.',
        // One continuous page (design handoff design_handoff_messages_settings/
        // Settings.dc.html, 2026-08-26) replaced the flat 9-panel tab. Same
        // reasoning as Finance's defaultTool: one real tool, no dashboard to
        // land on first.
        defaultTool: 'settingsHub',
    },
};

// ── Tool registry ────────────────────────────────────────────
// `section` is the id of the existing DOM section the tool opens;
// `pane` is the legacy tab-pane that section lives inside (the shell has
// to un-hide the pane before it can show the section).
const AP_TOOLS = [
    // ── Classrooms · Daily (design handoff: Classroom Tab Redesign, 2026-08-27) ──
    // 13 Classroom-tab screens → 7. Attendance Board absorbed Classroom
    // Roster's day-view In/Out marking (the one thing Roster had that the
    // board didn't) plus a Move-a-child shortcut; `roster` itself was
    // retired here at the time, then restored 2026-08-28 — see its entry
    // below, it was the only source of Print/PDF rosters and nothing else
    // replaced that. Incident Reports and Fire Drills each gained a
    // director-authored path
    // ("+ Write a report" / "+ Log a Drill") alongside reviewing what staff
    // filed — see admin-attendance.js/admin-incidents.js/admin-safety.js.
    //
    // Print Attendance — added 2026-08-28, first in the group: a blank paper
    // sign-in/sign-out sheet per room, for a parent or staff member to
    // hand-sign at drop-off/pickup. Distinct from both `roster` below (a
    // reference list, no signature lines) and `attBoard` (digital, live
    // In/Out marking) — this is the paper backup licensing still expects at
    // the door. Its section lives in #tab-daily, so pane:'daily' is correct
    // here (unlike the three below it).
    { key: 'printAttendance', pane: 'daily', section: 'printAttendanceSection', tab: 'classrooms', group: 'Daily', tint: AP_TINT.green, icon: '🖨️', name: 'Print Attendance',
      blurb: 'A blank sign-in/sign-out sheet per room — Time In/Out and a parent signature line for each child.' },
    // ⚠️ `pane` must be 'families', not 'daily': all three sections
    // (attendanceBoardSection/incidentsSection/fireDrillsSection) live inside
    // admin.html's #tab-families, not #tab-daily. They previously carried
    // pane:'daily', which made apShowSection() hide #tab-families (and the
    // section along with it) the moment any of these three was opened —
    // confirmed by reading apShowSection(), not assumed. The 'staff'-role
    // visibility check in apToolAvailable() no longer keys off `pane` for
    // exactly this reason (see that function's comment).
    { key: 'attBoard',    pane: 'families', section: 'attendanceBoardSection',  tab: 'classrooms', group: 'Daily', tint: AP_TINT.green, icon: '🚸', name: 'Attendance Board',
      blurb: 'Live — every room, who is in, who is expected, staff present, ratio. Mark In/Out/Absent and move a child, all from here.' },
    { key: 'incidents',   pane: 'families', section: 'incidentsSection',        tab: 'classrooms', group: 'Daily', tint: AP_TINT.green, icon: '🩹', name: 'Incident Reports',
      blurb: 'Review what staff filed, then release it to the family — or write one yourself.' },
    { key: 'drills',      pane: 'families', section: 'fireDrillsSection',       tab: 'classrooms', group: 'Daily', tint: AP_TINT.tang, icon: '🔥', name: 'Fire Drills',
      blurb: 'Every drill run, who was in the building, and how long it took — or log one yourself.' },
    // Restored 2026-08-28: the Classroom Tab Redesign retired this tool,
    // reasoning that Attendance Board absorbed the one thing it did that
    // nothing else did (day-view In/Out marking) and that its week/month
    // browsing "had no taker in the redesign." That dropped its print
    // function too — Day/Week/Month PDF export and "Print All Rooms" — which
    // nothing else in the app replaces; the Attendance Board has no print
    // path at all. `dailyRosterSection`'s markup and `setupRoster()` were
    // never removed, so this is a re-registration, not a rebuild. `group:
    // 'Daily'` is deliberate, not cosmetic: the admin-role picker's own label
    // for the 'staff' role — "Staff — Classroom Roster (read-only)"
    // (admin-settings.js) — has named this exact tool the whole time via
    // apToolAvailable()'s group==='Daily' gate; without an entry here that
    // label was describing a tool 'staff' accounts could no longer reach.
    { key: 'roster',      pane: 'daily',    section: 'dailyRosterSection',      tab: 'classrooms', group: 'Daily', tint: AP_TINT.green, icon: '📋', name: 'Classroom Roster',
      blurb: 'Who is in each room today, this week, or this month — Day/Week/Month PDF export and Print All Rooms.' },

    // ── Classrooms · Planning ──
    // Replaces three screens that read the same registrations at different
    // grains (Capacity Overview's month grid, Room Schedule Planner's weekly
    // AM/PM view, and Planning's own FTE/seat-day Room Capacity Overview) with
    // one Day/Week/Month/FTE view switcher — see admin-enrollment-capacity.js.
    // `capOverview`, `roomSched` and Planning's `capacityOverview` are retired
    // below; their old section wrappers are removed from admin.html since
    // this tool relocated their actual content rather than leaving it behind
    // unreferenced (contrast with CACFP below, and `roster` at the time this
    // was written — `roster` was restored 2026-08-28, see the Daily group).
    { key: 'enrollCap',   pane: 'daily',    section: 'enrollmentCapacitySection', tab: 'classrooms', group: 'Planning', tint: AP_TINT.green, icon: '📆', name: 'Enrollment & Capacity',
      blurb: 'Day, week, month, or FTE view of how full each room is — one screen, replacing three.' },

    // ── Classrooms · Records ──
    { key: 'careCal',     pane: 'registrations', section: 'allRegistrationsSection', tab: 'classrooms', group: 'Records', tint: AP_TINT.green, icon: '🗒️', name: 'Care Calendar',
      blurb: 'Every registration — search, filter, edit days, add a child.' },
    { key: 'missingCal',  pane: 'registrations', section: 'missingCalendarSection',  tab: 'classrooms', group: 'Records', tint: AP_TINT.green, icon: '⚠️', name: 'Missing Care Calendar',
      blurb: 'Active children with no registration for a month.' },
    { key: 'families',    pane: 'families',      section: 'familiesSection',         tab: 'classrooms', group: 'Records', tint: AP_TINT.green, icon: '👨‍👩‍👧', name: 'Family Directory',
      blurb: 'Family and child records, PINs, discounts, imports.' },

    // ── Finance · Money In (design handoff: Finance Hub, 2026-08-26) ──
    // Bill This Month, Invoices, Who Owes, and Family Billing Summary are
    // consolidated into one ledger screen — the director's own complaint was
    // too many screens with numbers that didn't visibly agree ("111 to bill"
    // vs. "96 drafted" vs. "84 owe", no explanation of the gap). Billing
    // Report survives as this tool's own second tab (Ledger / Billing
    // Report), not a separate nav entry — see admin-finance-hub.js and the
    // nested #billingReportSection markup in admin.html.
    // Finance is the tab's one real tool (AP_TABS.finance's own defaultTool),
    // and the design handoff puts its title/subtitle on the SAME row as the
    // month switcher and search — those live inside financeHubSection
    // (admin.html's own .fh-head). apRenderDetail() no longer renders a shell
    // header for any tool (see that function), so this needs no special
    // handling anymore — it just always worked out that way.
    // No `blurb` — apRenderDetail() hasn't rendered a shell header for any
    // tool since 2026-08-28 (see that function's own comment), and this
    // entry's own on-screen title was removed from #fhBody the same day, so
    // the field had nothing left reading it.
    { key: 'financeHub',  pane: 'finance', section: 'financeHubSection',    tab: 'finance', group: 'Money In', tint: AP_TINT.gold, icon: '💵', name: 'Finance' },
    // ⚠️ Restored 2026-08-31. The Bookkeeper redesign retired seven Finance
    // tools from AP_TOOLS; #billingPaymentsSection was not one of the seven
    // it named, but it was never registered either, so the ProCare Import
    // screen has been unreachable in this shell since the redesign shipped —
    // unreferenced means unreachable, per the shell's own rule. Found the
    // same way the retired Refund button was: by grepping AP_TOOLS for the
    // section id before telling the director where to click, rather than
    // assuming a screen that exists in admin.html can be opened.
    //
    // It is a genuine tool with no replacement anywhere in Bookkeeper: the
    // Ledger's "+ Record payment" enters ONE payment by hand. Recording a
    // month of ProCare payments needs the bulk path, its preview, its
    // duplicate guard and its unmatched-name dropdown.
    //
    // `pane: 'finance'` matches where the section actually lives in
    // admin.html (#tab-finance) — checked against apShowSection()'s own
    // hide rule, not inferred from the tab it appears under.
    { key: 'procareImport', pane: 'finance', section: 'billingPaymentsSection', tab: 'finance', group: 'Money In', tint: AP_TINT.gold, icon: '📂', name: 'ProCare Import',
      blurb: 'Bulk-import payments exported from ProCare. Shows every row for review first, skips rows already recorded, and lets you assign any child it could not match.' },
    { key: 'discount',    pane: 'finance', section: 'discountPricingSection', tab: 'finance', group: 'Money In', tint: AP_TINT.gold, icon: '🏷️', name: 'Discounts & Scholarships',
      blurb: 'Children on a staff, custom, or scholarship discount, with expiry.' },

    // ── Finance · Bookkeeper group — now EMPTY, and that's the point ──
    // Ten tools used to live in this sidebar group across two sessions and
    // no longer do: Accounts Receivable, Reconcile Payments, Revenue
    // Dashboard, Financial Dashboard, Room Profitability, Attendance &
    // Revenue, Annual Budget & Actuals, Year-over-Year, Expense Lines, and
    // ChMS Finance API. They are now:
    //   - the six sub-views of the Finance Hub's **Bookkeeper tab**
    //     (js/admin/admin-finance-bookkeeper.js) — Overview · Accounts
    //     Receivable · Room P&L · Month-End Close · Reconciliation ·
    //     GL Export;
    //   - Year-over-Year and the Expense Lines editor, folded directly into
    //     Bookkeeper → Overview, under its Annual Budget card
    //     (2026-08-28 — see admin-finance-bookkeeper.js's
    //     `_bkOverviewHtml()`, the "Budget lines" editor and the embedded
    //     `#financeYoyContent`);
    //   - ChMS Finance API, moved to Settings → Access & oversight
    //     (`#financeApiCard`, admin.html) — it needed a tab, not a
    //     Bookkeeper sub-view, and Settings already hosts the other
    //     admin-account-oversight tools.
    //
    // This is the whole point of the overhaul: the numbers on those ten
    // screens were computed several different ways and did not visibly
    // agree. Leaving the originals reachable next to their replacement would
    // have kept every one of those disagreements on the shelf and made the
    // shelf longer. Their sections stay in admin.html (unreferenced by
    // AP_TOOLS = unreachable, per the shell's own rule) so nothing that
    // reads their DOM breaks — except #financeYoySection and
    // #financeApiTesterSection, deleted outright because their ids/markup
    // were reused at the new location (see admin.html's own comments there).
    //
    // Attendance & Revenue is gone as a screen, not just as a nav entry:
    // child-days is a stat on each Room P&L card now, from the same dataset
    // that card's revenue comes from, so the two can no longer disagree.

    // Historical Payroll Records is commented out in admin.html ("hidden
    // 2026-07, may bring back later") — same for New Family Enrollment,
    // Enrollment Forms, and Offer Email Links. They are not registered here;
    // uncomment the section and add an entry to bring the tool back.
    //
    // ⚠️ Payroll is deliberately NOT duplicated into a Finance-sidebar
    // "Payroll" group. The handoff's nav sketch shows one ("Pay Runs · Wages
    // & Rates") but its own open-decisions list marks payroll depth
    // unconfirmed ("were not designed... confirm whether in scope"), and
    // apGroupsForTab() filters strictly on a tool's own `tab` — a second
    // AP_TOOLS entry pointing at the existing Staff-tab payroll section would
    // be a real duplicate object, not a link, the first time its role gating
    // or its section markup changed independently on one side. The Finance
    // sidebar's dashed note (apNavHtml) points to Staff → Pay & Policy
    // instead of inventing two undesigned screens.

    // ── Classrooms · Food Program — retired 2026-08-28 ──
    // The four CACFP tools (Daily Meal Counts, Menu Planner, Income
    // Eligibility, Monthly Claim) are removed from the sidebar at the
    // director's request. Same convention as every other retirement in this
    // file: unreferenced by AP_TOOLS = unreachable, per the shell's own rule.
    // `cacfpMealSection`/`cacfpMenuSection`/`cacfpIncomeSection`/
    // `cacfpClaimsSection` stay in admin.html and `js/admin/admin-cacfp.js`
    // stays in the tree, unreferenced, in case the program is ever revived.

    // ── Planning · Waitlist ──
    // Consolidation pass (design_handoff_planning_market, 2026-08-27): 15
    // Planning + Market Analysis tools → 6. Retired entries below: `planner`
    // (Enrollment Planner) was a duplicate of `wlPlanner`; `wlDemand`
    // (Waitlist Demand by Month), `forecast` (Demand Forecast) and
    // `promotions` (Upcoming Room Promotions) moved inline into wlPlanner's
    // own Grid render (see wlpRenderDemandStrip/wlpRenderAgeOutStrip in
    // admin-waitlist.js) rather than staying separate tools; `trends`, `fte`
    // and `seatDay` are replaced by the single `capacityOverview` entry below,
    // which zips their same underlying queries into one table instead of
    // three. The underlying report functions (generateDemandForecast,
    // generatePromotionsReport, generateEnrollmentTrends, etc.) are NOT
    // deleted — only their standalone AP_TOOLS entries/sections are, per the
    // handoff's explicit instruction. `ratioStep` is unchanged (no visual
    // redesign) but its render function is now also mounted a second time
    // inside Staff → Build Staff Schedule — see apOnToolOpened().
    { key: 'wlPlanner',   pane: 'waitlist', section: 'waitlistPlannerSection', tab: 'planning', group: 'Waitlist', tint: AP_TINT.gold, icon: '🗂️', name: 'Waitlist & Capacity Planner',
      blurb: 'The queue, the grid, and the board — one shared allocation, now with demand-by-month and age-out rollups inline.' },
    { key: 'wlNotify',    pane: 'waitlist', section: 'wlNotifySection',       tab: 'planning', group: 'Waitlist', tint: AP_TINT.gold, icon: '📨', name: 'Waitlist Signup Link',
      blurb: 'Shareable signup link, notification email, and weekly reminders.' },
    // 'wlImport' (Import Waitlist from File) was retired from the sidebar at
    // the director's request — #wlImportSection stays in admin.html but is
    // unreferenced here, which is this shell's own way of making a tool
    // unreachable without deleting markup anything else might read.

    // ── Planning · Enrollment Outlook ──
    // `capacityOverview` was retired from here in the Classroom Tab Redesign
    // (its content folded into the FTE/Seat-Day sub-view of Classrooms →
    // Planning → Enrollment & Capacity, `enrollCap`, above) but restored
    // 2026-08-28: design_handoff_planning_market's own sidebar mock shows it
    // as its own tool under Planning, and that handoff is what this
    // consolidation pass is implementing. Same renderCapacityOverviewTool()
    // as enrollCap's sub-view, second mount point with its own container/
    // drawer ids — see the comment on that function in admin-reports.js.
    { key: 'capacityOverview', pane: 'waitlist', section: 'roomCapacityOverviewSection', tab: 'planning',
      group: 'Enrollment Outlook', tint: AP_TINT.green, icon: '📆', name: 'Room Capacity Overview',
      blurb: 'Enrollment, FTE, and seat-day occupancy — one table, the same underlying data as before.' },
    { key: 'ratioStep',   pane: 'waitlist', section: 'ratioStepSection',       tab: 'planning', group: 'Enrollment Outlook', tint: AP_TINT.green, icon: '⚖️', name: 'Ratio Step & Next Child',
      blurb: 'Where the next child tips a room into another staff member.' },

    // ── Planning · What-If ──
    // Moved out of Finance by the Finance Hub handoff, which draws the line
    // explicitly: "Scenario planning and enrollment modeling have moved out of
    // Finance — they'll live in a separate Planning area. [Finance] stays
    // close-focused: what happened, what reconciles, what exports." A model of
    // a rate you have not set is not a thing that happened, so it does not
    // belong on a close screen. Their sections still live in the `finance`
    // pane (the shell un-hides the pane, so a cross-pane tool is fine) and
    // both are in AP_FULL_ONLY_KEYS below — they show wages and rates, and the
    // Planning tab, unlike Finance, is open to `restricted`.
    { key: 'scenario',    pane: 'finance', section: 'rateScenarioSection',   tab: 'planning', group: 'What-If', tint: AP_TINT.tang, icon: '🧮', name: 'Rate Increase Scenarios',
      blurb: 'What-if a rate, registration, or supply fee change — annual net, before you commit.' },
    { key: 'model',       pane: 'finance', section: 'financeModelSection',   tab: 'planning', group: 'What-If', tint: AP_TINT.tang, icon: '🔧', name: 'Rate & Wage Modeling',
      blurb: 'Project the impact of tuition and wage changes before you make them.' },

    // ── Staff tab consolidation (design_handoff_staff, 2026-08-28) ──
    // Audit finding: 9 tools, 3 groups → 4 tools, 3 groups. Every retired
    // key's real logic is untouched — this only changes which tools are
    // separate nav entries versus tabs inside one screen. Three
    // single-source-of-truth pairs: the `staff` table (Roster, with
    // Directory now a read tab of it, not a parallel table), `apStaffing()`
    // (Schedule, with the Requirement now a tab reading the same call
    // instead of a separate entry that could compute it differently), and
    // Payroll (PTO rate + Time Clock settings/integrity now tabs of the
    // screen whose numbers they actually feed).
    //
    // ⚠️ Fixed in the same pass: staffInjuriesSection/clockIntegritySection
    // carried `pane:'staffing'` here but their markup lived in `#tab-families`
    // — apShowSection() hides every pane whose id isn't `tab-<pane>`, so
    // opening either tool from the sidebar hid `#tab-families` and showed the
    // empty `#tab-staffing`, leaving both tools permanently blank. Never
    // caught because nothing else in `#tab-families` depends on them. Their
    // markup is now physically inside `#tab-staffing`, so `pane` finally
    // matches where the DOM actually is.

    // ── Staff · Scheduling ──
    { key: 'schedule',    pane: 'staffing', section: 'staffScheduleSection',  tab: 'staff', group: 'Scheduling', tint: AP_TINT.sand, icon: '🗓️', name: 'Build Staff Schedule',
      blurb: 'Assign staff to rooms and shifts for the week, against what the ratios require.' },

    // ── Staff · Your Team ──
    { key: 'staffRoster', pane: 'staffing', section: 'staffRosterSection',    tab: 'staff', group: 'Your Team', tint: AP_TINT.sand, icon: '🧑‍🏫', name: 'Staff Roster',
      blurb: 'Staff records, pay type, rooms, and availability — the one place these get edited.' },

    // ── Staff · Pay & Policy ──
    // Payroll is money but it is about people, and everything it needs
    // (hours, PTO balances, pay type, the time clock that produces the
    // punches) lives in the Staff tools. It keeps its full-role gate via
    // AP_FULL_ONLY_KEYS even though the tab is open to `restricted` — and
    // since Time Clock is now a tab inside it, Time Clock inherits the same
    // gate for free (the stricter of its two former gates, Clock-In
    // Integrity's, is the one that wins).
    { key: 'payroll',     pane: 'staffing', section: 'payrollSection',        tab: 'staff', group: 'Pay & Policy', tint: AP_TINT.sand, icon: '💵', name: 'Payroll',
      blurb: 'Hours, PTO, and pay for a bi-weekly period.' },
    // HR & Handbook is new — reference policy docs, a write-up log for
    // documenting lateness/rule breaks, and Staff Injury Reports (moved here
    // from its own nav entry, same table, same full-role reasoning: an
    // injury report names an employee, their body and their medical
    // treatment). The tool itself is open to `restricted` for Policies and
    // Write-ups; the Injury Reports tab specifically is hidden client-side
    // for anyone but `full` — see applyRoleRestrictions() in admin-safety.js.
    { key: 'hrHandbook',  pane: 'staffing', section: 'hrHandbookSection',     tab: 'staff', group: 'Pay & Policy', tint: AP_TINT.tang, icon: '📖', name: 'HR & Handbook',
      blurb: "Policies every staff member has agreed to, and the written record when one wasn't followed." },

    // ── Messages ──
    // One working inbox (design handoff design_handoff_messages_settings/
    // Messages.dc.html, 2026-08-26) — merges Family Conversations, Contact Us
    // Messages, and Announcements into a single feed. Retired the three-tool
    // split (`threads`, `msgHistory`, `announce`) and `adminPush`: there is no
    // dashboard/tool split on this tab anymore — this IS the landing page.
    { key: 'messages',    pane: 'messages', section: 'messagesUnifiedSection', tab: 'messages', group: 'Inbox', tint: AP_TINT.gold, icon: '💬', name: 'Messages',
      blurb: "Every conversation with families and prospects, in one place — who's waiting on you, and what still needs an email." },

    // ── Market Analysis ──
    // mktPos/mktPricing/mktCost retired in favor of one directorReport entry
    // (its three panes read the exact same fetchMarketProviders() call these
    // three tools used — see renderDirectorReportTool() in admin-market.js).
    { key: 'directorReport', pane: 'market', section: 'directorReportSection', tab: 'market', group: 'Where We Stand', tint: AP_TINT.green, icon: '📈', name: 'Director Report',
      blurb: 'Market position, pricing, and cost & wage — auto-pulled from Comparable Providers.' },
    { key: 'mktProviders', pane: 'market', section: 'marketProvidersSection', tab: 'market', group: 'The Field', tint: AP_TINT.sand, icon: '🏫', name: 'Comparable Providers',
      blurb: 'The full comparable set — edit a row or add a provider.' },

    // ── Settings ──
    // One continuous page (design handoff design_handoff_messages_settings/
    // Settings.dc.html, 2026-08-26) — no dashboard/tool split, no accordion.
    // Retired the eight separate tools (regWindow, closedDays, summerCamp,
    // rates, ratios, capacity, adminRoles, auditLog); rates+ratios+capacity
    // collapsed into one Rooms & rates table. "My Notifications" (adminPush)
    // moved to the Messages tab header.
    // MDO Website — the public home page's own copy (mdo_site_content).
    // ⚠️ NOT in AP_FULL_ONLY_KEYS on purpose: a `restricted` admin may write a
    // draft, and only publishing is full-only. That split is enforced in the
    // database by admin_mdo_publish, not by this list — the Publish button is
    // hidden for `restricted` as a courtesy, not as the control.
    { key: 'mdoWebsite', pane: 'settings', section: 'mdoWebsiteSection', tab: 'settings', group: 'Website', tint: AP_TINT.green, icon: '🌐', name: 'MDO Website',
      blurb: 'Switches for the seasonal blocks on the public mdo.timothystl.org home page. The wording itself is part of the site and changes through a developer.' },
    { key: 'settingsHub', pane: 'settings', section: 'settingsUnifiedSection', tab: 'settings', group: 'Settings', tint: AP_TINT.gold, icon: '⚙️', name: 'Settings',
      blurb: 'The rules the portal runs on. Every control shows who last changed it.' },
];

// Director owns no tools. It is a dashboard: every link on it deep-links
// to the tool under its real home tab, so the sidebar reveals where the
// thing actually lives instead of maintaining a parallel index.

const AP_TOOL_BY_KEY = Object.fromEntries(AP_TOOLS.map(t => [t.key, t]));

// ── Shell state ──────────────────────────────────────────────
const apState = {
    tab:  'director',
    view: null,   // tool key, or null for the tab's dashboard
    done: {},     // dashboard done-flags, persisted
    live: null,   // last loaded dashboard data
};

let _apReady       = false;
let _apLastOpened  = null;   // tool key whose lazy loads have already fired

// ── Small helpers ────────────────────────────────────────────
function apMoney(n) {
    const v = Math.round(Math.abs(Number(n) || 0));
    return (n < 0 ? '−$' : '$') + v.toLocaleString();
}

function apInitials(name) {
    const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '··';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function apRoleClass(role) {
    const r = String(role || '').toLowerCase();
    if (r.includes('lead') || r.includes('director') || r.includes('admin')) return '';
    if (r.includes('float') || r.includes('sub')) return 'role-float';
    return 'role-assistant';
}

/** Monday of the week containing `d` (defaults to today), as YYYY-MM-DD. */
function apWeekStart(d = new Date()) {
    const dt  = new Date(d);
    const dow = dt.getDay();                       // 0=Sun … 6=Sat
    dt.setDate(dt.getDate() - (dow === 0 ? 6 : dow - 1));
    return dt.toLocaleDateString('en-CA');
}

/** The five weekday dates of a week, closures included (the caller decides). */
function apWeekDates(weekOf) {
    const start = new Date(weekOf + 'T00:00:00');
    const out   = [];
    for (let i = 0; i < 5; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        out.push(d.toLocaleDateString('en-CA'));
    }
    return out;
}

function apFmtDayShort(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    return `${AP_DAYS[(d.getDay() + 6) % 7]} ${d.getMonth() + 1}/${d.getDate()}`;
}

/**
 * The shared staffing computation — the single source of truth behind the
 * dashboard's "Staff needed this week" grid, the schedule mini-strip, and
 * the Daily Staffing Requirement tool.
 *
 * Built ONLY from booked registrations and the saved ratios. Clock-in room
 * data is deliberately never read: room selection at the time clock is
 * spotty and would distort the requirement.
 *
 * Each cell carries an AM and a PM figure, not one blended number — a room
 * full of morning-only half-day children needs its full AM staff count and
 * a genuinely smaller PM count once they leave, and showing only one number
 * hid that split. AM = every child booked that day; PM = full-day children
 * only, since a half-day booking here is a morning slot that drops for the
 * afternoon. This mirrors the "AM = all enrolled · PM = full-day only" rule
 * `_buildShiftCounts()` (admin-reports.js) already uses for Build Staff
 * Schedule's own AM/PM columns — same rule, same source data, so the two
 * tools can't disagree about which shift needs more coverage.
 * `staff`/`kids` stay the AM figures (unchanged field names, since AM is
 * always the day's peak — a half-day booking only ever removes a PM child,
 * never adds one) so every existing "needed" comparison elsewhere in this
 * file keeps reading the conservative, whole-day figure without change.
 */
function apStaffing(weekDates) {
    const rooms = getSortedRooms().filter(r => !r.hidden);
    const combinedIds = new Set(PM_COMBINED_ROOM_IDS);
    const rows  = rooms.map(room => {
        const ratio = room.staffRatio || 10;
        const combines = combinedIds.has(room.id);
        const cells = weekDates.map(date => {
            const closed = allClosureDates.has(date);
            let kids = 0, kidsPm = 0;
            if (!closed) {
                (allRegistrations || []).forEach(reg => {
                    if (reg.room_id !== room.id) return;
                    (reg.registration_dates || []).forEach(d => {
                        if (!d.waitlisted && d.care_date === date) {
                            kids++;
                            if (d.day_type !== 'half') kidsPm++;
                        }
                    });
                });
            }
            const staff = kids > 0 ? Math.ceil(kids / ratio) : 0;
            // Goose/Turtle/Owl combine into one supervised group from
            // 1:00p–5:00p (PM_COMBINED_ROOM_IDS, supabase.js) — their PM
            // headcount is pooled and staffed under After Care (below)
            // instead of counted separately per room, so a combined room's
            // own PM figure here is always 0 rather than its own ceil().
            const staffPm = combines ? 0 : (kidsPm > 0 ? Math.ceil(kidsPm / ratio) : 0);
            return {
                kids, kidsPm: combines ? 0 : kidsPm, staff, staffPm, closed,
                // "at ratio" — one more child adds another staff member, AM or PM
                atEdge:   kids   > 0 && kids   % ratio === 0,
                atEdgePm: !combines && kidsPm > 0 && kidsPm % ratio === 0,
            };
        });
        return { room, label: room.label, ratio, ratioLabel: `1 : ${ratio}`, cells };
    }).filter(r => r.cells.some(c => c.kids > 0));

    // The pooled After Care row: PM-only, built from the SAME per-room kid
    // counts above (before they were zeroed out) so the combined figure can
    // never disagree with what the three rooms' own AM figures already show.
    const combinedRooms = rooms.filter(r => combinedIds.has(r.id));
    if (combinedRooms.length) {
        const acCells = weekDates.map((date, i) => {
            const closed = allClosureDates.has(date);
            let kidsPm = 0;
            if (!closed) {
                (allRegistrations || []).forEach(reg => {
                    if (!combinedIds.has(reg.room_id)) return;
                    (reg.registration_dates || []).forEach(d => {
                        if (!d.waitlisted && d.care_date === date && d.day_type !== 'half') kidsPm++;
                    });
                });
            }
            const staffPm = kidsPm > 0 ? Math.ceil(kidsPm / PM_COMBINED_RATIO) : 0;
            return {
                kids: 0, kidsPm, staff: 0, staffPm, closed,
                atEdge: false, atEdgePm: kidsPm > 0 && kidsPm % PM_COMBINED_RATIO === 0,
            };
        });
        if (acCells.some(c => c.kidsPm > 0)) {
            rows.push({
                room: { id: PM_COMBINED_HOST_ROOM_ID },
                label: `🌆 After Care · combined 1–5p (${combinedRooms.map(r => r.label.replace(/^\S+\s/, '')).join('/')})`,
                ratio: PM_COMBINED_RATIO, ratioLabel: `1 : ${PM_COMBINED_RATIO}`,
                cells: acCells,
            });
        }
    }

    const classroom   = weekDates.map((_, i) => rows.reduce((a, r) => a + r.cells[i].staff,   0));
    const classroomPm = weekDates.map((_, i) => rows.reduce((a, r) => a + r.cells[i].staffPm, 0));
    const kids      = weekDates.map((_, i) => rows.reduce((a, r) => a + r.cells[i].kids, 0));
    const closed    = weekDates.map(d => allClosureDates.has(d));
    return { rows, classroom, classroomPm, kids, closed, weekDates };
}

// ── Persistence ──────────────────────────────────────────────
function apLoadPrefs() {
    try {
        // The layout toggle is gone; drop the key it used to persist.
        localStorage.removeItem('apLayout');
        apState.tab  = localStorage.getItem('apTab') || 'director';
        apState.done = JSON.parse(localStorage.getItem('apDone') || '{}') || {};
    } catch (_) { /* defaults stand */ }
    if (!AP_TABS[apState.tab]) apState.tab = 'director';
}

function apSavePrefs() {
    try {
        localStorage.setItem('apTab',  apState.tab);
        localStorage.setItem('apDone', JSON.stringify(apState.done));
    } catch (_) { /* private mode — prefs simply don't persist */ }
}

// ── Availability ─────────────────────────────────────────────
// applyRoleRestrictions() hides sections with inline display:none. A tool
// whose section is hidden that way must not appear in the index either.
//
// It also used to gate whole tabs by hiding the drawer's `[data-tab=…]`
// buttons. The portal rebuilds that drawer, so the tab-level rules are
// restated here rather than inferred from DOM that no longer exists:
//   full       — everything
//   restricted — scheduling, enrollment/waitlist, limited Settings.
//                No Finance and no Market Analysis at all.
//   staff      — Classrooms only
const AP_FULL_ONLY_TABS = ['finance', 'market'];
// Financial tools that live outside the Finance tab, so the tab rule
// above cannot catch them. Payroll sits under Staff because it is about
// people, but it is still pay data. Time Clock (settings + integrity) and
// PTO policy are now tabs inside Payroll, so gating `payroll` alone covers
// them — no separate keys needed for what used to be `geofence` and
// `clockIntegrity`.
// `scenario` and `model` moved to the Planning tab (see above). Planning is
// open to `restricted`; Finance was not, so without these two keys the move
// would have quietly widened who can see wage and rate modeling.
// HR & Handbook (`hrHandbook`) is deliberately NOT in this list — Policies
// and Write-ups are fine for `restricted`. Only its Injury Reports tab needs
// the stricter gate (the report names an employee, the part of their body,
// and where they were treated), so that tab is hidden client-side inside the
// tool itself rather than the whole tool being pulled from `restricted`.
const AP_FULL_ONLY_KEYS = ['payroll', 'scenario', 'model'];

function apToolAvailable(tool) {
    const el = document.getElementById(tool.section);
    if (!el) return false;
    if (el.style.display === 'none') return false;
    const pane = document.getElementById('tab-' + tool.pane);
    if (pane && pane.style.display === 'none') return false;

    const role = typeof currentAdminRole !== 'undefined' ? currentAdminRole : 'full';
    // ⚠️ Was `tool.pane === 'daily'` — that happened to work only because
    // attBoard/incidents/drills carried (wrong) pane:'daily' themselves. Fixing
    // their pane to match where the sections actually live (#tab-families)
    // would have silently dropped 'staff'-role access to all three. `group`
    // is what the design handoff actually means by "Classrooms tab only,
    // read-only roster view": the Daily group, not a DOM-location field.
    if (role === 'staff') return tool.tab === 'classrooms' && tool.group === 'Daily';
    if (role !== 'full' && AP_FULL_ONLY_TABS.includes(tool.tab)) return false;
    if (role !== 'full' && AP_FULL_ONLY_KEYS.includes(tool.key)) return false;
    return true;
}

function apGroupsForTab(tab) {
    const groups = [];
    AP_TOOLS.filter(t => t.tab === tab && apToolAvailable(t)).forEach(t => {
        let g = groups.find(x => x.label === t.group);
        if (!g) { g = { label: t.group, tools: [] }; groups.push(g); }
        g.tools.push(t);
    });
    return groups;
}

// Director deliberately owns no tools, so an empty group list does not
// mean "no access" for it — it always has its dashboard.
function apTabAvailable(tab) {
    if (!AP_TABS[tab]) return false;
    const role = typeof currentAdminRole !== 'undefined' ? currentAdminRole : 'full';
    if (tab === 'director') return role !== 'staff';
    return apGroupsForTab(tab).length > 0;
}

// ── Navigation ───────────────────────────────────────────────
// Opening a tool always switches the sidebar to that tool's real tab, so
// a deep link from the Director dashboard teaches where the thing lives.
function apGo(key) {
    const tool = AP_TOOL_BY_KEY[key];
    if (!tool || !apToolAvailable(tool)) return;
    apState.tab  = tool.tab;
    apState.view = key;
    // Any navigation — including clicking a sidebar search result — lands
    // on the tool's own tab, so a stale search query left in the sidebar
    // would otherwise keep showing search results instead of that tab's
    // real groups the moment apNavHtml() next re-renders.
    _apNavSearchQuery = '';
    apSavePrefs();
    apRender();
    window.scrollTo(0, 0);
}

function apGoTab(tab) {
    if (!AP_TABS[tab] || !apTabAvailable(tab)) return;
    apState.tab  = tab;
    apState.view = null;
    apSavePrefs();
    apRender();
    window.scrollTo(0, 0);
}

// ── Render ───────────────────────────────────────────────────
function apRender() {
    if (!_apReady) return;
    const page   = document.getElementById('apPage');
    const detail = document.getElementById('apDetail');
    if (!page || !detail) return;

    // Fall back to a tab this account can actually see.
    if (!apTabAvailable(apState.tab)) {
        const next = Object.keys(AP_TABS).find(apTabAvailable);
        if (!next) {
            page.classList.remove('hidden');
            detail.classList.add('hidden');
            page.innerHTML = '<p class="empty-hint">Your account does not have access to any tools. Ask an administrator to review your access level.</p>';
            return;
        }
        apState.tab = next;
    }
    let tool = apState.view ? AP_TOOL_BY_KEY[apState.view] : null;
    if (apState.view && (!tool || !apToolAvailable(tool))) { apState.view = null; tool = null; }

    // A tab can name its own landing tool (see AP_TABS.finance) instead of
    // falling through to the generic Dashboard/Detail split — covers a fresh
    // tab click (apGoTab sets view to null), a restored session, and initial
    // load alike, since all three funnel through this one render. Messages
    // and Settings use this for the same reason finance does: each has
    // exactly one tool, so there is no dashboard/tool split to fall into
    // (design handoff design_handoff_messages_settings, 2026-08-26).
    if (!apState.view) {
        const defaultKey = AP_TABS[apState.tab]?.defaultTool;
        const defaultTool = defaultKey ? AP_TOOL_BY_KEY[defaultKey] : null;
        if (defaultTool && apToolAvailable(defaultTool)) { apState.view = defaultKey; tool = defaultTool; }
    }

    const meta      = AP_TABS[apState.tab];
    const chipIcon  = document.getElementById('currentTabIcon');
    const chipLabel = document.getElementById('currentTabLabel');
    if (chipIcon)  chipIcon.textContent  = meta.icon;
    if (chipLabel) chipLabel.textContent = meta.label;

    // The sidebar is permanent chrome, on the dashboard and inside a tool
    // (900px+); the bottom tab bar is its mobile equivalent, same pattern as
    // the parent app. Both rebuilt on every render so a role that cannot
    // reach a tab never sees a button for it.
    const nav = document.getElementById('apNav');
    if (nav) nav.innerHTML = apNavHtml();

    const tabbar = document.getElementById('apTabbar');
    if (tabbar) {
        const visible = Object.keys(AP_TABS).filter(apTabAvailable);
        tabbar.style.gridTemplateColumns = `repeat(${visible.length},1fr)`;
        tabbar.innerHTML = apTabbarHtml();
    }

    if (apState.view) {
        page.classList.add('hidden');
        detail.classList.remove('hidden');
        apRenderDetail(AP_TOOL_BY_KEY[apState.view]);
    } else {
        detail.classList.add('hidden');
        _apLastOpened = null;
        apShowSection(null);
        page.classList.remove('hidden');
        apRenderDashboard(page);
    }
}

/**
 * The tool index — the permanent desktop sidebar (900px+). Below that, the
 * bottom tab bar (apTabbarHtml) takes over navigation entirely and this
 * tool-group listing isn't shown; the dashboard's own contextual pills are
 * the mobile way to reach a tool, same as the sidebar highlights it above.
 *
 * Carries a search box (apNavSearchHtml/_apNavGroupsBodyHtml) so a tool
 * "buried" under a tab the director doesn't think to open is still findable
 * by name — see the search section below.
 */
function apNavHtml() {
    const tabs = Object.keys(AP_TABS).filter(apTabAvailable).map(k => `
        <button class="ap-nav-tab${k === apState.tab ? ' active is-active' : ''}" data-ap-tab="${k}">
            <span>${AP_TABS[k].icon}</span><span>${escHtml(AP_TABS[k].label)}</span>
        </button>`).join('');

    return `<div class="ap-nav-tabs">${tabs}</div>
        ${apNavSearchHtml()}
        <div id="apNavGroups">${_apNavGroupsBodyHtml()}</div>`;
}

// ── Sidebar feature search ──────────────────────────────────
// A director who doesn't remember which of the seven tabs a tool lives
// under can type its name here instead of clicking through each one.
// Searches every tool in AP_TOOLS regardless of the tab currently open —
// apToolAvailable() doesn't read apState.tab, so this is a real cross-tab
// search, not just a filter on the current tab's own groups.
//
// Deliberately desktop-sidebar-only (#apNav), same as the rest of this
// nav — the <900px bottom tab bar carries no tool sub-list at all (a tool
// is "one tap further, via the dashboard's own pills" there), so there is
// no equivalent list for a mobile search to filter. A mobile search
// overlay would be a separate, larger feature, not attempted here.
let _apNavSearchQuery = '';

function apNavSearchHtml() {
    return `
        <div class="ap-nav-search">
            <input type="text" id="apNavSearchInput" class="ap-nav-search-input"
                placeholder="Search features…" autocomplete="off" value="${escHtml(_apNavSearchQuery)}">
            ${_apNavSearchQuery ? `<button type="button" class="ap-nav-search-clear" data-ap-nav-search-clear aria-label="Clear search">✕</button>` : ''}
        </div>`;
}

// Split out of apNavHtml() so typing a search query only has to replace
// this sub-tree (#apNavGroups) rather than the whole nav — the tabs row
// and the search input itself stay untouched, so the input never loses
// focus/cursor position mid-keystroke the way re-rendering it would.
function _apNavGroupsBodyHtml() {
    const q = _apNavSearchQuery.trim();
    if (q) return _apNavSearchResultsHtml(q);

    const groups = apGroupsForTab(apState.tab);
    // A single group carries no differentiating information — only print the
    // heading when a tab has more than one, or "SETTINGS"/"INBOX" sit above
    // their tab's only tool group forever. apNavHtml() rebuilds this on every
    // render, so a hand-edit to admin.html/CSS instead of here gets silently
    // overwritten the next time it runs.
    const body = groups.length
        ? groups.map(g => `
            ${groups.length > 1 ? `<div class="ap-nav-group">${escHtml(g.label)}</div>` : ''}
            ${g.tools.map(t => `
            <button class="ap-nav-item${t.key === apState.view ? ' active is-active' : ''}" data-ap-go="${t.key}">
                <span>${t.icon}</span><span>${escHtml(t.name)}</span>
            </button>`).join('')}`).join('')
        // Director is the one tab with no tools of its own — say so rather
        // than leaving a bare gap under it.
        : `<p class="ap-nav-note">${apState.tab === 'director'
              ? 'Director is an overview. Every tool lives under its own tab — links on the dashboard take you straight there.'
              : 'No tools here for your access level.'}</p>`;

    // Finance handoff (`1a`, "Navigation"): a dashed note under the groups
    // states the split in plain words rather than leaving the director to
    // infer it from where things aren't. Payroll genuinely lives under Staff
    // — see the note at AP_TOOLS about why it is not duplicated into a
    // Finance-sidebar "Payroll" group of its own.
    const financeNote = apState.tab === 'finance' ? `
        <p class="ap-nav-note ap-nav-dashed">Payroll — under Staff → Pay &amp; Policy.
        The close, bank matching and room P&amp;L live under Bookkeeper below;
        nothing here pushes them at you.</p>` : '';

    return `${body}${financeNote}`;
}

// Matches on the tool's own name and blurb, plus the tab/group it lives
// under — "who owes" or "PTO" should find a tool even if that phrase is
// only in its description, not its title.
function _apNavSearchResultsHtml(q) {
    const lower = q.toLowerCase();
    const matches = AP_TOOLS.filter(t => {
        if (!apToolAvailable(t)) return false;
        const tabLabel = AP_TABS[t.tab]?.label || '';
        return t.name.toLowerCase().includes(lower) ||
               (t.blurb || '').toLowerCase().includes(lower) ||
               (t.group || '').toLowerCase().includes(lower) ||
               tabLabel.toLowerCase().includes(lower);
    });
    if (!matches.length) return `<p class="ap-nav-note">No feature matches "${escHtml(q)}".</p>`;
    return `<div class="ap-nav-group">${matches.length} result${matches.length === 1 ? '' : 's'}</div>` +
        matches.map(t => {
            const tabLabel = AP_TABS[t.tab]?.label || '';
            return `
            <button class="ap-nav-item ap-nav-search-result${t.key === apState.view ? ' active is-active' : ''}" data-ap-go="${t.key}">
                <span>${t.icon}</span>
                <span class="ap-nav-search-result-text">
                    <span class="ap-nav-search-result-name">${escHtml(t.name)}</span>
                    <span class="ap-nav-search-result-loc">${escHtml(tabLabel)}${t.group ? ' · ' + escHtml(t.group) : ''}</span>
                </span>
            </button>`;
        }).join('');
}

function apNavSearchInput(value) {
    _apNavSearchQuery = value;
    const host = document.getElementById('apNavGroups');
    if (host) host.innerHTML = _apNavGroupsBodyHtml();
    // The clear button's presence depends on the query, so it's the one
    // part of apNavSearchHtml() outside #apNavGroups that still needs a
    // repaint — done in place rather than re-rendering the whole search
    // box, which would drop the input's focus mid-keystroke.
    const wrap = document.querySelector('.ap-nav-search');
    if (wrap) {
        let clearBtn = wrap.querySelector('.ap-nav-search-clear');
        if (_apNavSearchQuery && !clearBtn) {
            clearBtn = document.createElement('button');
            clearBtn.type = 'button';
            clearBtn.className = 'ap-nav-search-clear';
            clearBtn.setAttribute('data-ap-nav-search-clear', '');
            clearBtn.setAttribute('aria-label', 'Clear search');
            clearBtn.textContent = '✕';
            wrap.appendChild(clearBtn);
        } else if (!_apNavSearchQuery && clearBtn) {
            clearBtn.remove();
        }
    }
}

function apNavSearchClear() {
    _apNavSearchQuery = '';
    const input = document.getElementById('apNavSearchInput');
    if (input) input.value = '';
    const host = document.getElementById('apNavGroups');
    if (host) host.innerHTML = _apNavGroupsBodyHtml();
    document.querySelector('.ap-nav-search-clear')?.remove();
    input?.focus();
}

/**
 * The bottom tab bar — the mobile (<900px) equivalent of the sidebar, same
 * seven tabs and same visual pattern (.tabbar) as the parent app's own
 * bottom nav in parent.html. Unlike the sidebar it carries no tool
 * sub-list — a tool is one tap further, via the dashboard's own pills.
 */
function apTabbarHtml() {
    return Object.keys(AP_TABS).filter(apTabAvailable).map(k => {
        const t = AP_TABS[k];
        return `<button type="button" class="tabbar-item${k === apState.tab ? ' is-active' : ''}"
                    data-ap-tab="${k}" role="tab" aria-selected="${k === apState.tab}">
            <span class="tabbar-icon" aria-hidden="true">${t.icon}</span>
            <span class="tabbar-label">${escHtml(t.short || t.label)}</span>
        </button>`;
    }).join('');
}

/** Show exactly one section (and the pane containing it); hide everything else. */
function apShowSection(tool) {
    document.querySelectorAll('.tab-pane').forEach(p => {
        p.classList.toggle('hidden', !tool || p.id !== 'tab-' + tool.pane);
    });
    // Three section flavours exist in the legacy markup: .admin-section is the
    // common one, .table-section wraps the registrations table, and
    // .capacity-section is the Capacity Overview's own styling.
    document.querySelectorAll('.tab-pane .admin-section, .tab-pane .table-section, .tab-pane .capacity-section').forEach(s => {
        // Never override a section the role restrictions have hidden.
        if (s.style.display === 'none') return;
        const open = !!tool && s.id === tool.section;
        s.classList.toggle('ap-hidden-tool', !open);

        // Never hide a section's own heading. This used to strip it whenever
        // the shell printed the tool's name+blurb above it — but that shell
        // tile (icon + name + blurb, from apRenderDetail below) was itself
        // the unwanted repetition: the sidebar already names the open tool,
        // and the section's own heading already carries a more specific
        // description. The shell tile is gone now (see apRenderDetail), so
        // there is nothing left for a section's own <h2> to duplicate.
        //
        // waitlistPlannerSection is the one exception: it carries no static
        // <h2>/<p> at all (deleted, not just hidden) because its inner
        // renderWaitlistPlanner() already renders a real header of its own
        // (icon, name, subtitle, tab pills) into #wlpRoot — keeping a static
        // pair there would still have duplicated against THAT header even
        // with the shell tile gone. Every other section keeps its own
        // heading as its one and only header.
    });
}

function apRenderDetail(tool) {
    // No back link: the sidebar keeps its place and highlights where you
    // are, which is the way back. No shell heading either — every section
    // already carries its own <h2> + description, and printing the tool's
    // name and blurb again above it just retyped the same header a second
    // time on every tab (found live 2026-08-28, screenshotted on Waitlist &
    // Capacity Planner: the shell's "Waitlist & Capacity Planner" tile sat
    // directly on top of the section's own near-identical subtitle). Finance
    // (`customHeader: true`) already skipped this shell tile for the same
    // reason; every tool now gets that same treatment instead of carrying a
    // one-off flag.
    const head = document.getElementById('apDetailHead');
    if (head) head.innerHTML = '';

    apShowSection(tool);

    const related = AP_TOOLS.filter(t =>
        t.tab === tool.tab && t.group === tool.group && t.key !== tool.key && apToolAvailable(t));
    const relatedEl = document.getElementById('apRelated');
    if (relatedEl) {
        relatedEl.innerHTML = related.length ? `
            <p class="ap-mini-title">Related</p>
            <div class="ap-related-chips">
                ${related.map(t => `<button class="ap-pill" data-ap-go="${t.key}"><span>${t.icon}</span><span>${escHtml(t.name)}</span></button>`).join('')}
            </div>` : '';
    }

    apOnToolOpened(tool);
}

// Lazy loads that the legacy tab switcher used to trigger on tab change.
// Now that a tool is a page of its own, the trigger moves to opening it —
// once per open, not on every re-render of the same open tool (apRender()
// runs again after applySessionRole(), and after every time-off decision).
function apOnToolOpened(tool) {
    if (_apLastOpened === tool.key) return;
    _apLastOpened = tool.key;
    try {
        switch (tool.key) {
            case 'families':
                if (typeof allFamiliesData !== 'undefined' && !allFamiliesData.length) loadFamilies();
                break;
            case 'staffRoster':
            case 'schedule':
            case 'payroll':
            case 'histPayroll':
                if (typeof allStaffData !== 'undefined' && !allStaffData.length) loadStaffList();
                break;
            case 'wlPlanner':
                if (typeof loadWaitlistApplications === 'function' &&
                    typeof _allWaitlistApps !== 'undefined' && !_allWaitlistApps.length) loadWaitlistApplications();
                break;
        }
        if (tool.pane === 'cacfp' && typeof initCacfpTab === 'function' && !window._apCacfpInit) {
            window._apCacfpInit = true; initCacfpTab();
        }
        if (tool.pane === 'market' && typeof initMarketTab === 'function' && !window._apMarketInit) {
            window._apMarketInit = true; initMarketTab();
        }
        if (tool.key === 'attBoard' && typeof renderAttendanceBoard === 'function') renderAttendanceBoard();
        if (tool.key === 'printAttendance' && typeof renderPrintAttendanceTool === 'function') renderPrintAttendanceTool();
        if (tool.key === 'financeHub' && typeof renderFinanceHubTool === 'function') renderFinanceHubTool();
        if (tool.key === 'mdoWebsite' && typeof renderMdoWebsiteTool === 'function') renderMdoWebsiteTool();
        if (tool.key === 'incidents' && typeof renderIncidentsTool === 'function') renderIncidentsTool();
        if (tool.key === 'drills' && typeof renderFireDrillsTool === 'function') renderFireDrillsTool();
        if (tool.key === 'messages' && typeof renderMessagesUnifiedTool === 'function') renderMessagesUnifiedTool();
        if (tool.key === 'settingsHub' && typeof renderSettingsUnifiedTool === 'function') renderSettingsUnifiedTool();
        if (tool.key === 'schedule')  apRenderScheduleTimeOff();
        if (tool.key === 'schedule' && typeof apMountStaffRatioStep === 'function') apMountStaffRatioStep();
        // Daily Staffing Requirement is now the schedule's second tab, not a
        // separate tool key — render it whenever Build Staff Schedule opens
        // so switching tabs never shows a stale/empty pane.
        if (tool.key === 'schedule')  apRenderStaffReq();
        // Staff Directory, PTO policy, and Time Clock → Settings (geofence)
        // are all already loaded unconditionally at portal boot
        // (setupStaffDirectory()/setupPtoSettings()/setupGeofence() in
        // admin-init.js) regardless of which tab is visible, same as before
        // this consolidation — only their markup moved. Only Staff Injury
        // Reports and Time Clock → Integrity were previously lazy, gated on
        // their own AP_TOOLS key being opened; Injury Reports keeps that
        // here, Integrity is lazy-rendered from the Time Clock sub-tab
        // switch instead (apSwitchTimeClockTab()).
        if (tool.key === 'hrHandbook' && typeof renderStaffInjuriesTool === 'function') renderStaffInjuriesTool();
        if (tool.key === 'hrHandbook' && typeof renderStaffWriteUpsTool === 'function') renderStaffWriteUpsTool();
        if (tool.key === 'hrHandbook' && typeof renderHrPoliciesTool === 'function') renderHrPoliciesTool();
        // Credentials — full-role only, same gate as Injury Reports (a TB
        // test result is medical information about an employee). Rendered
        // unconditionally alongside the other three sub-tabs so switching
        // straight to it never shows a stale/empty pane.
        if (tool.key === 'hrHandbook' && typeof renderStaffCredentialsTool === 'function') renderStaffCredentialsTool();
        if (tool.key === 'scenario')  apRenderScenario();
        if (tool.key === 'enrollCap' && typeof renderEnrollCapTool === 'function') renderEnrollCapTool();
        if (tool.key === 'capacityOverview' && typeof renderCapacityOverviewTool === 'function') {
            renderCapacityOverviewTool(undefined, { containerId: 'roomCapacityOverviewContent', idPrefix: 'pcapov' });
        }
    } catch (err) {
        console.error('apOnToolOpened:', tool.key, err);
    }
}

// ============================================================
// DASHBOARD
// ============================================================
// Every number below is computed from data this portal already holds.
// Where a figure has no live source it is not invented — the panel is
// simply not rendered, and the tool that owns the number is linked instead.

async function apLoadLive() {
    const weekOf    = apWeekStart();
    const weekDates = apWeekDates(weekOf);
    const live = {
        weekOf, weekDates,
        staffing:  apStaffing(weekDates),
        pending:   [], timeOff: [],
        waitlist:  [], unread: 0,
        billed:    0, billedKids: 0,
        families:  [], schedule: [], invoices: [], providers: [],
        incidents: [], missing: [],
        billException: null, whoOwesRows: [],
        nextClosure: null,
        monthKey:  new Date().toLocaleDateString('en-CA').slice(0, 7),
        today:     new Date().toLocaleDateString('en-CA'),
    };

    // Every source is optional: allSettled so one missing table or a
    // permission error degrades that card, not the whole dashboard.
    const settled = await Promise.allSettled([
        typeof fetchTimeOffRequests === 'function' ? fetchTimeOffRequests({ sinceDate: weekDates[0] }) : [],
        typeof fetchWaitlistApplications === 'function' ? fetchWaitlistApplications() : [],
        typeof fetchMessages === 'function' ? fetchMessages(false) : [],
        typeof fetchAllFamilies === 'function' ? fetchAllFamilies({ includeArchived: false }) : [],
        typeof fetchStaffScheduleWeek === 'function' ? fetchStaffScheduleWeek(weekDates[0], weekDates[4]) : [],
        typeof fetchAllBillingInvoices === 'function' ? fetchAllBillingInvoices() : [],
        typeof fetchMarketProviders === 'function' ? fetchMarketProviders() : [],
        // Both feed the "Needs you" queue. An incident waiting on the director
        // is a family that has not been told the whole story, and a live
        // missing-child alert outranks literally everything else on the page.
        typeof fetchIncidentReports === 'function' ? fetchIncidentReports({ status: 'submitted' }) : [],
        typeof fetchActiveMissingChildAdmin === 'function' ? fetchActiveMissingChildAdmin() : [],
    ]);
    const val = i => settled[i].status === 'fulfilled' ? settled[i].value : null;

    const off = val(0);
    if (off) {
        live.pending = off.filter(r => r.status === 'pending');
        live.timeOff = off.filter(r => r.status === 'approved');
    }
    const wl = val(1);
    if (wl) {
        live.waitlist = wl.filter(a => !a.archived_at &&
            a.status !== 'enrolled' && a.status !== 'declined' && a.status !== 'withdrawn');
    }
    const msgs = val(2);
    if (msgs) live.unread = msgs.filter(m => !m.is_read && !m.is_archived).length;

    live.families  = val(3) || [];
    live.schedule  = val(4) || [];
    live.invoices  = val(5) || [];
    live.providers = val(6) || [];
    live.missing   = val(8) || [];

    // ⚠️ Only the reports she can actually close. status='submitted' is not
    // enough — she is signature 3, so a report the parent has not signed at
    // pickup is not hers yet, and a queue full of rows that cannot be cleared
    // is a queue she learns to scroll past. Mark each one with whether the
    // parent signature exists, then filter on that.
    const submitted = val(7) || [];
    live.incidents = submitted;
    if (submitted.length && typeof fetchIncidentSignatures === 'function') {
        try {
            const sigs = await fetchIncidentSignatures(submitted.map(r => r.id));
            const parentSigned = new Set(
                sigs.filter(g => g.role === 'parent').map(g => g.incident_id));
            live.incidents = submitted.map(r => ({ ...r, parentSigned: parentSigned.has(r.id) }));
        } catch (e) {
            // Degrade to showing none rather than showing all: a row she cannot
            // action is worse than a row she has to find in the tool.
            console.warn('apLoadLive incident signatures:', e);
            live.incidents = [];
        }
    }

    // Billed this month — read from _buildFamilyBillingData(), the SAME function
    // that renders Family Billing Summary and generates draft invoices. This
    // card used to run its own per-registration sum (calcRegistrationBill),
    // which structurally could not apply the sibling discount, leaked in days
    // from other months, and ignored change fees and billing overrides — so it
    // disagreed with Family Billing by thousands. Money is computed in exactly
    // one place now; if this figure is wrong, it is wrong in both.
    const monthKey = live.monthKey;
    try {
        // Discounts and family grouping both come from allFamiliesData, which is
        // lazy-loaded when the Families tab opens. Without it the dashboard would
        // quietly bill every discounted child at full price, so load it here —
        // same guard the invoice generator uses.
        if (!allFamiliesData || !allFamiliesData.length) {
            allFamiliesData = await fetchAllFamilies({ includeArchived: false });
            _discountMap = null;
        }

        let overridesMap = new Map();
        try {
            const rows = await fetchBillingOverrides(monthKey);
            overridesMap = new Map((rows || []).map(r => [
                `${(r.parent_email || '').toLowerCase()}:${(r.child_name || '').toLowerCase()}`,
                parseFloat(r.override_amount),
            ]));
        } catch (e) { console.warn('apLoadLive overrides:', e); }

        const families = _buildFamilyBillingData(monthKey, overridesMap);
        families.forEach(fam => {
            (fam.children || []).forEach(child => {
                live.billed += child.hasOverride
                    ? parseFloat(child.overrideAmount || 0)
                    : (child.subtotal || 0) + (child.changeFees || 0);
                live.billedKids++;
            });
        });
    } catch (err) {
        console.warn('apLoadLive billed:', err); // rates or registrations not loaded yet
    }

    // Finance home (1a) needs two more things the rest of the dashboard
    // doesn't: which families are exceptions this month (Bill the Month's
    // engine), and who still owes (Accounts Receivable's engine). Both are
    // the SAME functions the Bill the Month and Who Owes screens themselves
    // call — computed once here, read synchronously by apDashFinanceHome(),
    // never recomputed a third way.
    try {
        live.billException = typeof computeBillMonthExceptions === 'function'
            ? await computeBillMonthExceptions(monthKey) : null;
    } catch (err) {
        console.warn('apLoadLive billException:', err);
        live.billException = null;
    }
    try {
        if (typeof _buildArRows === 'function' && typeof getOrCreateBillingCycle === 'function') {
            const cycle = await getOrCreateBillingCycle(monthKey);
            const [invoices, payments] = await Promise.all([
                fetchInvoicesForCycle(cycle.id),
                fetchPaymentsForMonth(monthKey).catch(() => []),
            ]);
            live.whoOwesRows = _buildArRows(monthKey, live.families, invoices, payments);
        }
    } catch (err) {
        console.warn('apLoadLive whoOwesRows:', err);
        live.whoOwesRows = [];
    }

    const today = new Date().toLocaleDateString('en-CA');
    const upcoming = [...allClosureDates].filter(d => d >= today).sort();
    live.nextClosure = upcoming[0] || null;
    live.closuresAhead = upcoming.length;

    apState.live = live;
    return live;
}

function apRenderDashboard(page) {
    const live = apState.live;
    if (!live) {
        // No tab-name heading here: the sidebar already highlights the open
        // tab, and the header chip (#currentTabLabel) already names it — a
        // third "Planning"/"Market Analysis" as a page <h2> was pure repeat,
        // the same class of retyping fixed in apRenderDetail() above (found
        // live 2026-08-28, on the dashboard rather than a tool this time).
        page.innerHTML = `<p class="ap-dash-stamp">Loading today's figures…</p>`;
        apLoadLive().then(() => { if (!apState.view) apRender(); })
                    .catch(err => {
                        console.error('apLoadLive:', err);
                        page.innerHTML = `<p class="empty-hint">Could not load the dashboard — ${escHtml(err.message || 'unknown error')}. The tools in the sidebar still work.</p>`;
                    });
        return;
    }

    const builder = {
        director:   apDashDirector,
        classrooms: apDashClassrooms,
        staff:      apDashStaff,
        finance:    apDashFinanceHome,
        planning:   apDashPlanning,
        market:     apDashMarket,
    }[apState.tab] || apDashSimple;
    const dash = builder(live);

    // No tab-name heading here either — see the loading-state comment above.
    // dash.stamp is real per-load context (a week, a count, a data source),
    // not a repeat of the tab's own name, so it stays as a plain caption.
    page.innerHTML = `
        <p class="ap-dash-stamp">${escHtml(dash.stamp)}</p>
        ${dash.needsYou && dash.needsYou.length ? apNeedsYouHtml(dash.needsYou) : ''}
        ${dash.top && dash.top.length ? dash.top.join('') : ''}
        ${dash.kpis.length ? `<div class="ap-metrics">${dash.kpis.map(apKpiHtml).join('')}</div>` : ''}
        <div class="ap-body">
            <div class="ap-col">${(dash.left || []).join('')}</div>
            <div class="ap-col">
                ${(dash.right || []).join('')}
                ${dash.attention && dash.attention.length ? `
                <section class="ap-mini-panel">
                    <h3 class="ap-mini-title">Needs attention</h3>
                    <div class="ap-attention">
                        ${dash.attention.map(a => `
                        <button class="ap-attn${a.urgent ? ' is-urgent' : ''}" data-ap-go="${a.key}">
                            <span class="ap-attn-icon">${a.icon}</span>
                            <span style="min-width:0">
                                <span class="ap-attn-text">${escHtml(a.text)}</span>
                                <span class="ap-attn-cta">${escHtml(a.cta)} →</span>
                            </span>
                        </button>`).join('')}
                    </div>
                </section>` : ''}
            </div>
        </div>`;
}

// ── "Needs you" (design handoff `1a`) ────────────────────────
// A single action queue, not a list of links. Each row carries a status rail, a
// glyph, a title and pill, one line of context, and THE ACTIONS INLINE — she
// clears the row without leaving the page, and "Open" is the escape hatch to
// the full record rather than the only route.
//
// ⚠️ The count in the header is the point of the whole component. The old
// "Needs attention" panel sat in the right-hand column below the metrics, so
// the number of things actually waiting on her was something she had to
// assemble by reading. Sorted urgent-first, and urgent rows sit on the coral
// tint so the split is visible before anything is read.
function apNeedsYouHtml(rows) {
    const urgent = rows.filter(r => r.urgent).length;
    return `
    <section class="ap-needs">
        <header class="ap-needs-head">
            <h3>Needs you</h3>
            <span class="ap-needs-count">${rows.length} ${rows.length === 1 ? 'thing' : 'things'}</span>
            ${urgent ? `<span class="ap-needs-urgent">${urgent} URGENT</span>` : ''}
        </header>
        ${rows.map(r => `
        <div class="ap-needs-row${r.urgent ? ' is-urgent' : ''}">
            <span class="ap-needs-rail" style="background:${r.rail || 'var(--border)'}"></span>
            <span class="ap-needs-glyph" aria-hidden="true">${r.icon}</span>
            <span class="ap-needs-main">
                <span class="ap-needs-title">${escHtml(r.title)}
                    ${r.pill ? `<span class="ap-needs-pill${r.urgent ? ' is-urgent' : ''}">${escHtml(r.pill)}</span>` : ''}
                </span>
                <span class="ap-needs-ctx">${escHtml(r.context)}</span>
            </span>
            <span class="ap-needs-acts">
                ${(r.actions || []).map(a =>
                    `<button class="ap-needs-btn${a.primary ? ' is-primary' : ''}" data-ap-go="${a.key}">${escHtml(a.label)}</button>`
                ).join('')}
            </span>
        </div>`).join('')}
    </section>`;
}

function apKpiHtml(k) {
    const tone = k.tone || 'navy';
    const mini = k.days ? `
        <div class="ap-mini-strip">
            ${k.days.map(d => `
            <div class="ap-mini-day${d.peak ? ' is-peak' : ''}">
                <div class="ap-mini-label">${escHtml(d.label)}</div>
                <div class="ap-mini-value">${escHtml(String(d.value))}</div>
            </div>`).join('')}
        </div>` : `<div class="ap-metric-value">${escHtml(String(k.value))}</div>`;
    const check = k.check ? `
        <label class="ap-check-row${apState.done[k.check] ? ' is-done' : ''}">
            <input type="checkbox" data-ap-check="${escHtml(k.check)}"${apState.done[k.check] ? ' checked' : ''}>
            <span>${escHtml(k.check)}</span>
        </label>` : '';
    const link = k.link ? `
        <button class="ap-pill" data-ap-go="${k.link}"><span>${k.linkIcon || '🗓️'}</span><span>${escHtml(k.linkLabel)}</span></button>` : '';
    return `
        <div class="ap-metric tone-${tone}${k.span2 ? ' span-2' : ''}">
            <div class="ap-eyebrow">${escHtml(k.label)}</div>
            ${mini}
            <div class="ap-metric-sub">${escHtml(k.sub || '')}</div>
            ${check}${link}
        </div>`;
}

function apPanel({ title, sub, tone, cls, body, tools }) {
    return `
        <section class="ap-panel${tone ? ' tone-' + tone : ''}${cls ? ' ' + cls : ''}">
            <div class="ap-panel-head">
                <h3>${escHtml(title)}</h3>
                ${sub ? `<p>${escHtml(sub)}</p>` : ''}
            </div>
            ${body}
            ${tools && tools.length ? `<div class="ap-panel-tools">${tools.map(k => {
                const t = AP_TOOL_BY_KEY[k];
                return t && apToolAvailable(t)
                    ? `<button class="ap-pill" data-ap-go="${t.key}"><span>${t.icon}</span><span>${escHtml(t.name)}</span></button>` : '';
            }).join('')}</div>` : ''}
        </section>`;
}

function apBarsHtml(bars) {
    return `<div class="ap-bars">${bars.map(b => `
        <div>
            <div class="ap-bar-head">
                <span class="ap-bar-label">${escHtml(b.label)}</span>
                <span class="ap-bar-note">${escHtml(b.note)}</span>
            </div>
            <div class="ap-bar-track"><div class="ap-bar-fill" style="width:${b.pct}%;background:${b.color}"></div></div>
        </div>`).join('')}</div>`;
}

function apRowsHtml(rows) {
    return `<div class="ap-rows">${rows.map(r => `
        <div class="ap-row">
            <div>
                <div class="ap-row-label">${escHtml(r.label)}</div>
                <div class="ap-row-note">${escHtml(r.note || '')}</div>
            </div>
            <span class="ap-row-value" style="${r.color ? `color:${r.color}` : ''}">${escHtml(String(r.value))}</span>
        </div>`).join('')}</div>`;
}

/** The "Staff needed this week" matrix — rooms down, Mon–Fri across. */
function apStaffGridHtml(sf) {
    const peak = Math.max(0, ...sf.classroom);
    return `
    <div class="ap-grid-wrap"><div class="ap-grid-inner">
        <div class="ap-grid-headrow">
            <div></div>
            ${sf.weekDates.map((d, i) => `
            <div class="ap-grid-dayhead${sf.classroom[i] === peak && peak > 0 ? ' is-peak' : ''}">${AP_DAYS[i]}</div>`).join('')}
        </div>
        ${sf.rows.map(r => `
        <div class="ap-grid-row">
            <div class="ap-grid-roomlabel">
                <div class="ap-grid-room">${escHtml(r.label)}</div>
                <div class="ap-grid-ratio">${escHtml(r.ratioLabel)}</div>
            </div>
            ${r.cells.map(c => `
            <div class="ap-grid-cell${(c.atEdge || c.atEdgePm) ? ' is-edge' : ''}">
                ${c.closed ? `
                <div class="ap-grid-staff">—</div>
                <div class="ap-grid-kids">closed</div>` : c.staffPm !== c.staff ? `
                <div class="ap-grid-staff">${c.staff}<span class="ap-grid-shift">AM</span></div>
                <div class="ap-grid-staff ap-grid-staff-pm">${c.staffPm}<span class="ap-grid-shift">PM</span></div>
                <div class="ap-grid-kids">${c.kids}→${c.kidsPm} kids</div>` : `
                <div class="ap-grid-staff">${c.staff}</div>
                <div class="ap-grid-kids">${c.kids} kids</div>`}
            </div>`).join('')}
        </div>`).join('')}
        <p class="ap-grid-foot">AM = every child booked that day · PM = full-day children only, since a half-day booking drops for the afternoon — shown split whenever the two differ. A shaded cell is at ratio for either shift, meaning one more child adds another staff member. Built from booked registrations; clock-in room data is never used.</p>
    </div></div>`;
}

function apFillBars(sf) {
    return sf.rows.map(r => {
        const open = r.cells.filter(c => !c.closed);
        const avg  = open.length ? open.reduce((a, c) => a + c.kids, 0) / open.length : 0;
        const cap  = r.room.capacity || 0;
        const pct  = cap ? Math.round((avg / cap) * 100) : 0;
        return {
            label: r.label,
            note:  cap ? `${Math.round(avg * 10) / 10} of ${cap} seats · ${pct}%` : `${Math.round(avg * 10) / 10} per day · no capacity set`,
            pct:   Math.min(100, pct),
            color: pct >= 85 ? AP_TONE.warn : pct >= 70 ? AP_TONE.gold : AP_TONE.ok,
        };
    });
}

function apWaitlistByRoom(live) {
    const byRoom = {};
    live.waitlist.forEach(a => {
        const rid = typeof wlDeriveRoom === 'function' ? wlDeriveRoom(a) : null;
        const key = rid || 'unknown';
        byRoom[key] = (byRoom[key] || 0) + 1;
    });
    return byRoom;
}

// Draft/sent counts for the month on screen, from billing_invoices joined
// to its cycle. Used by both the Director and Finance billing cards.
function apInvoiceState(live) {
    const rows = (live.invoices || []).filter(i =>
        (i.billing_cycles?.month || i.month || '').startsWith(live.monthKey));
    return {
        drafted: rows.length,
        sent:    rows.filter(i => i.sent_at).length,
        unsent:  rows.filter(i => !i.sent_at).length,
        total:   rows.reduce((a, i) => a + (parseFloat(i.final_amount) || 0), 0),
    };
}

// Rooms sitting exactly at ratio on the busiest day. Pulled out because both
// the queue and the older attention list ask the same question, and two copies
// of this filter would answer it differently the first time one is edited.
function edgeRoomsForQueue(sf, peakIx) {
    return sf.rows.filter(r => r.cells[peakIx < 0 ? 0 : peakIx]?.atEdge);
}

function apDashDirector(live) {
    const sf     = live.staffing;
    const peak   = Math.max(0, ...sf.classroom);
    const peakIx = sf.classroom.indexOf(peak);
    const peakDay = AP_DAYS[peakIx < 0 ? 0 : peakIx];
    const posted = !!apState.done['Schedule posted to staff'];
    const waiting = live.pending.map(r => (r.staff_name || '').split(' ')[0]).filter(Boolean);
    const byRoom  = apWaitlistByRoom(live);

    const inv = apInvoiceState(live);
    const sentThisMonth = inv.sent > 0;
    const invSub = inv.drafted
        ? `${inv.drafted} drafted, ${inv.sent ? inv.sent + ' sent' : 'none sent'}`
        : `${live.billedKids} children registered, nothing drafted`;

    const seatsOpen = sf.rows.reduce((a, r) => {
        const cap = r.room.capacity || 0;
        if (!cap) return a;
        const busiest = Math.max(0, ...r.cells.map(c => c.kids));
        return a + Math.max(0, cap - busiest);
    }, 0);

    const kpis = [
        {
            label: 'Staff schedule', span2: true, tone: posted ? 'ok' : 'warn',
            days: sf.weekDates.map((d, i) => ({
                label: AP_DAYS[i], value: sf.closed[i] ? '—' : sf.classroom[i],
                peak: !sf.closed[i] && sf.classroom[i] === peak && peak > 0,
            })),
            sub: posted
                ? `Posted · ${peakDay} needs the most at ${peak}`
                : `Not posted yet · ${peakDay} needs ${peak}`,
            check: 'Schedule posted to staff',
            link: 'schedule', linkLabel: 'Build staff schedule', linkIcon: '🗓️',
        },
        {
            label: 'Days off to approve', tone: live.pending.length ? 'warn' : 'ok',
            value: live.pending.length,
            sub: waiting.length ? `${waiting.slice(0, 3).join(', ')} waiting on you` : 'nothing waiting on you',
            ...(live.pending.length ? { link: 'schedule', linkLabel: 'Review requests', linkIcon: '✅' } : {}),
        },
        {
            label: 'Unread messages', tone: 'gold', value: live.unread,
            sub: live.unread ? 'from families through the portal' : 'nothing new',
            ...(live.unread ? { link: 'messages', linkLabel: 'Open messages', linkIcon: '💬' } : {}),
        },
        {
            label: 'Seats open this week', tone: 'ok', value: seatsOpen,
            sub: `${live.waitlist.length} on the waitlist`,
        },
        {
            label: 'Billed this month', tone: sentThisMonth ? 'ok' : 'warn', value: apMoney(live.billed),
            sub: invSub,
            check: 'Billing completed',
            link: 'financeHub', linkIcon: '🧾', linkLabel: 'Review and send',
        },
    ];

    const queueRows = live.waitlist.slice(0, 4).map(a => {
        const rid  = typeof wlDeriveRoom === 'function' ? wlDeriveRoom(a) : null;
        const room = ROOMS.find(r => r.id === rid);
        // Whole days since the inquiry — wlDaysWaiting() returns prose
        // ("3 weeks ago"), which does not fit the "waiting N days" phrasing.
        const days = a.applied_at
            ? Math.max(0, Math.floor((Date.now() - new Date(a.applied_at).getTime()) / 86400000))
            : null;
        return {
            name: `${(a.parent_name || '').split(' ').slice(-1)[0]}, ${a.child_name || ''}`.replace(/^, /, ''),
            room: room ? room.label : 'Room to be assigned',
            wait: days != null ? `waiting ${days} day${days === 1 ? '' : 's'}` : '',
            want: [a.days_of_week || 'days flexible', a.desired_start_date ? `from ${friendlyShort(a.desired_start_date)}` : ''].filter(Boolean).join(' '),
            tone: rid === 'bear' || rid === 'bee' ? AP_TONE.warn : AP_TONE.ok,
        };
    });

    // ── The "Needs you" queue (handoff `1a`) ───────────────
    // Ordered by what happens if she does not do it today. A child who cannot
    // be found is first and has no competition; a family who has not been told
    // their child was hurt is second. Everything below that is money and
    // paperwork, which keeps.
    const needsYou = [];

    for (const m of (live.missing || [])) {
        needsYou.push({
            urgent: true, rail: AP_TONE.warn, icon: '🚨',
            title: `${m.child_name} is missing`,
            pill: 'SEARCH ON',
            context: [
                (ROOMS.find(r => r.id === m.room_id) || {}).label,
                m.wearing ? `wearing ${m.wearing}` : '',
                `${(m.searchers || []).length} searching`,
            ].filter(Boolean).join(' · '),
            actions: [{ key: 'attBoard', label: 'Open the board', primary: true }],
        });
    }

    // Only the ones she can actually close. A report still waiting on the
    // parent's pickup signature is not hers yet, and putting it in her queue
    // teaches her the queue contains things she cannot clear.
    const readyIncidents = (live.incidents || []).filter(r => r.parentSigned);
    for (const r of readyIncidents.slice(0, 4)) {
        const hrs = Math.max(0, Math.round((Date.now() - new Date(r.created_at).getTime()) / 3600000));
        needsYou.push({
            urgent: hrs >= 4, rail: AP_TONE.warn, icon: '🩹',
            title: `Incident — ${r.students?.child_name || 'a child'}`,
            pill: hrs >= 4 ? `${hrs}H WAITING` : 'AWAITING SIGN-OFF',
            context: `${r.incident_kind || r.incident_type || 'Report'}` +
                     `${r.location ? ' · ' + r.location : ''}` +
                     `${r.reported_by_name ? ' · filed by ' + r.reported_by_name : ''}` +
                     ' · the family cannot read it until you sign',
            actions: [{ key: 'incidents', label: 'Sign off', primary: true }],
        });
    }

    if (live.pending.length) needsYou.push({
        urgent: false, rail: AP_TONE.gold, icon: '🚫',
        title: `${live.pending.length} day-off request${live.pending.length > 1 ? 's' : ''}`,
        pill: 'WAITING ON YOU',
        context: waiting.length ? `${waiting.slice(0, 3).join(', ')} — nothing changes on the schedule until you answer`
                                : 'nothing changes on the schedule until you answer',
        actions: [{ key: 'schedule', label: 'Review', primary: true }],
    });

    if (inv.unsent) needsYou.push({
        urgent: false, rail: AP_TONE.gold, icon: '🧾',
        title: `${inv.unsent} invoice${inv.unsent === 1 ? '' : 's'} drafted, not sent`,
        pill: 'THIS MONTH',
        context: `${apMoney(inv.total)} sitting in draft — accounts receivable ages from the day you send.`,
        actions: [{ key: 'financeHub', label: 'Review and send', primary: true }],
    });

    if (live.unread) needsYou.push({
        urgent: false, rail: AP_TONE.ok, icon: '✉️',
        title: `${live.unread} unread message${live.unread > 1 ? 's' : ''}`,
        pill: 'FROM FAMILIES',
        context: 'sent through the parent portal',
        actions: [{ key: 'messages', label: 'Open', primary: true }],
    });

    const infantsWaiting = (byRoom.bear || 0) + (byRoom.bee || 0);
    if (infantsWaiting) needsYou.push({
        urgent: false, rail: AP_TONE.ok, icon: '🍼',
        title: `${infantsWaiting} famil${infantsWaiting > 1 ? 'ies' : 'y'} waiting on an infant seat`,
        pill: 'WAITLIST',
        context: 'the rooms with the least give — worth an answer even when it is no',
        actions: [{ key: 'wlPlanner', label: 'Open planner', primary: false }],
    });

    if (edgeRoomsForQueue(sf, peakIx).length) {
        const rooms = edgeRoomsForQueue(sf, peakIx);
        needsYou.push({
            urgent: false, rail: AP_TONE.gold, icon: '⚖️',
            title: `${rooms.map(r => r.label).join(', ')} at ratio on ${peakDay}`,
            pill: 'RATIO',
            context: 'one more child that day adds a staff member',
            actions: [{ key: 'schedule', label: 'Daily staffing', primary: false }],
        });
    }

    const attention = [];
    if (peak > 0) attention.push({ icon: '👥', key: 'schedule',
        text: `${peakDay} needs ${peak} staff on the floor — the heaviest day of the week.`, cta: 'Open Daily Staffing' });
    if (live.pending.length) attention.push({ icon: '🚫', key: 'schedule', urgent: true,
        text: `${live.pending.length} time-off request${live.pending.length > 1 ? 's are' : ' is'} waiting on your approval.`, cta: 'Review requests' });
    const edgeRooms = edgeRoomsForQueue(sf, peakIx);
    if (edgeRooms.length) attention.push({ icon: '⚖️', key: 'settingsHub',
        text: `${edgeRooms.map(r => r.label).join(', ')} sit${edgeRooms.length > 1 ? '' : 's'} exactly at ratio on ${peakDay} — one more child adds a staff member.`, cta: 'Open Ratios' });
    if (inv.unsent) attention.push({ icon: '🧾', key: 'financeHub', urgent: true,
        text: `${inv.unsent} invoice${inv.unsent === 1 ? ' is' : 's are'} drafted for this month but not marked sent.`, cta: 'Review and send invoices' });
    else if (!inv.drafted && live.billed > 0) attention.push({ icon: '🧾', key: 'financeHub',
        text: `${apMoney(live.billed)} is billable this month but no invoices have been drafted.`, cta: 'Open invoices' });
    if (live.unread) attention.push({ icon: '✉️', key: 'messages',
        text: `${live.unread} Contact Us message${live.unread > 1 ? 's have' : ' has'} not been read.`, cta: 'Open Messages' });
    if (live.nextClosure) attention.push({ icon: '🚫', key: 'settingsHub',
        text: `Next closure is ${friendlyShort(live.nextClosure)} — ${live.closuresAhead} on the calendar ahead.`, cta: 'Open Closed Days' });
    else attention.push({ icon: '🚫', key: 'settingsHub',
        text: 'No closures are on the calendar ahead — check the holidays are blocked.', cta: 'Open Closed Days' });
    const infants = (byRoom.bear || 0) + (byRoom.bee || 0);
    if (infants) attention.push({ icon: '🍼', key: 'wlPlanner',
        text: `${infants} famil${infants > 1 ? 'ies are' : 'y is'} waiting on an infant seat.`, cta: 'Open Waitlist Planner' });

    return {
        stamp: `Week of ${friendlyShort(live.weekOf)} · registrations as booked`,
        needsYou,
        top: [apFamilyLookupPanelHtml(live)],
        kpis,
        left: [
            apPanel({ title: 'Staff needed this week',
                sub: 'Each room, each day — from registered children and your saved ratios. Clock-in room data is never used.',
                body: apStaffGridHtml(sf), tools: ['schedule', 'settingsHub'] }),
            apPanel({ title: 'How full each room is',
                sub: 'Average booked children per day against capacity.',
                body: apBarsHtml(apFillBars(sf)), tools: ['settingsHub', 'capacityOverview'] }),
        ],
        right: queueRows.length ? [
            apPanel({ title: 'Next up on the waitlist', tone: 'gold',
                sub: `${live.waitlist.length} active applications, first-come first-served by inquiry date.`,
                body: `<div class="ap-queue">${queueRows.map(q => `
                    <div class="ap-queue-row">
                        <span class="ap-queue-bar" style="background:${q.tone}"></span>
                        <div style="min-width:0">
                            <div class="ap-queue-name">${escHtml(q.name)}</div>
                            <div class="ap-queue-meta">${escHtml([q.room, q.wait].filter(Boolean).join(' · '))}</div>
                            <div class="ap-queue-want">${escHtml(q.want)}</div>
                        </div>
                    </div>`).join('')}</div>`,
                tools: ['wlPlanner', 'wlNotify'] }),
        ] : [],
        attention,
    };
}

// apDashFinance (the old Finance-home dashboard) is retired in favor of
// apDashFinanceHome() in admin-finance-home.js -- design handoff `1a`. Kept
// out of this file entirely rather than left dead beside its replacement.

function apDashPlanning(live) {
    const sf     = live.staffing;
    const peak   = Math.max(0, ...sf.classroom);
    const byRoom = apWaitlistByRoom(live);
    const pressure = sf.rows.map(r => {
        const waiting = byRoom[r.room.id] || 0;
        const cap     = r.room.capacity || 0;
        const busiest = Math.max(0, ...r.cells.map(c => c.kids));
        const opening = Math.max(0, cap - busiest);
        const ratio   = opening ? waiting / opening : (waiting ? Infinity : 0);
        return {
            label: r.label,
            note:  `${waiting} waiting · ${opening} seat${opening === 1 ? '' : 's'} open`,
            value: opening ? `${(Math.round(ratio * 10) / 10).toFixed(1)}×` : (waiting ? 'no seats' : '—'),
            color: ratio >= 2 || (!opening && waiting) ? AP_TONE.warn : ratio >= 1 ? AP_TONE.gold : AP_TONE.ok,
        };
    });
    return {
        stamp: `Week of ${friendlyShort(live.weekOf)} · from registrations`,
        kpis: [
            { label: 'Care days this week', tone: 'navy', value: sf.kids.reduce((a, b) => a + b, 0), sub: 'across all rooms' },
            { label: 'Peak staff needed',   tone: 'warn', value: peak, sub: 'on the heaviest day' },
            { label: 'On the waitlist',     tone: 'gold', value: live.waitlist.length, sub: 'active applications' },
            { label: 'Days off approved',   tone: 'ok',   value: live.timeOff.length, sub: 'in effect for scheduling' },
        ],
        left: [
            apPanel({ title: 'Waitlist pressure by room',
                sub: 'Active applications against the seats actually open this week.',
                body: apRowsHtml(pressure), tools: ['wlPlanner'] }),
        ],
        // Enrollment Outlook's own pill — otherwise ratioStep had no path in
        // from a phone at all. Demand-by-month, the demand forecast, and
        // upcoming promotions are inline inside wlPlanner's own Grid render
        // now, so their pill is wlPlanner itself, above. The FTE/seat-day
        // table that used to live at `capacityOverview` is now a sub-view of
        // Classrooms → Planning → Enrollment & Capacity (`enrollCap`).
        right: [
            apPanel({ title: 'Enrollment outlook', sub: 'Room capacity trends and the next ratio step.',
                body: '', tools: ['enrollCap', 'ratioStep'] }),
        ],
        attention: [
            { icon: '👥', key: 'schedule',   text: `The heaviest day this week needs ${peak} staff on the floor.`, cta: 'Open Daily Staffing' },
            { icon: '🎂', key: 'wlPlanner', text: 'The Capacity Planner grid shows who ages up out of their room next, and where unmet demand sits by month.', cta: 'Open the Capacity Planner' },
        ],
    };
}

// Settings has no dashboard of its own — the tab has exactly one tool
// (`settingsHub`), so apRender()'s single-tool auto-open lands directly on
// the unified page. See design_handoff_messages_settings/Settings.dc.html.

// ── Classrooms ───────────────────────────────────────────────
function apDashClassrooms(live) {
    const sf  = live.staffing;
    const idx = Math.max(0, live.weekDates.indexOf(live.today));
    const dayIx = live.weekDates.includes(live.today) ? idx : 0;
    const isToday = live.weekDates.includes(live.today);

    const hereToday = sf.rows.reduce((a, r) => a + r.cells[dayIx].kids, 0);
    const atRatio   = sf.rows.filter(r => r.cells[dayIx].atEdge);
    const openRooms = sf.rows.filter(r => r.cells[dayIx].kids > 0).length;

    // Children with a registration this month but none for the *next* one is
    // the Missing Care Calendar tool's job; here we can honestly report the
    // children on file with no booked day at all this month.
    const billedKeys = new Set();
    (allRegistrations || []).forEach(reg => {
        if ((reg.registration_dates || []).some(d => !d.waitlisted && String(d.care_date).startsWith(live.monthKey)))
            billedKeys.add((reg.child_name || '').toLowerCase().trim());
    });
    let onFile = 0, missing = 0;
    live.families.forEach(f => (f.students || []).forEach(st => {
        onFile++;
        if (!billedKeys.has((st.child_name || '').toLowerCase().trim())) missing++;
    }));

    const bars = sf.rows.map(r => {
        const kids = r.cells[dayIx].kids;
        const cap  = r.room.capacity || 0;
        const pct  = cap ? Math.round((kids / cap) * 100) : 0;
        return {
            label: r.label,
            note:  cap ? `${kids} of ${cap} seats · ${pct}%` : `${kids} booked · no capacity set`,
            pct:   Math.min(100, pct),
            color: r.cells[dayIx].atEdge ? AP_TONE.warn : pct >= 85 ? AP_TONE.warn : pct >= 70 ? AP_TONE.gold : AP_TONE.ok,
        };
    });

    const kpis = [
        { label: isToday ? 'Children here today' : 'Children on Monday', tone: 'navy', value: hereToday,
          sub: `${openRooms} room${openRooms === 1 ? '' : 's'} in use` },
        { label: 'Rooms at ratio', tone: atRatio.length ? 'warn' : 'ok', value: atRatio.length,
          sub: atRatio.length ? atRatio.map(r => r.label.replace(/^\S+\s/, '')).join(', ') : 'all rooms have headroom' },
    ];
    if (live.families.length) {
        // ⚠️ Below 900px the sidebar's tool-group listing is hidden entirely
        // (apNavHtml's comment) and a dashboard pill is the ONLY way to reach
        // a tool on mobile. Without `link` here, Family Directory had no path
        // in from the Classrooms dashboard on a phone at all.
        kpis.push({ label: 'Children on file', tone: 'ok', value: onFile,
                    sub: `${live.families.length} families`,
                    link: 'families', linkIcon: '👨‍👩‍👧', linkLabel: 'Open Family Directory' });
        if (missing) kpis.push({ label: 'No days this month', tone: 'gold', value: missing,
                                 sub: 'children with nothing booked',
                                 link: 'missingCal', linkIcon: '⚠️', linkLabel: 'Review them' });
    }

    const attention = [];
    if (missing) attention.push({ icon: '📋', key: 'missingCal', urgent: true,
        text: `${missing} child${missing === 1 ? ' has' : 'ren have'} no booked day this month.`, cta: 'Open missing calendars' });
    if (atRatio.length) attention.push({ icon: '🏫', key: 'enrollCap',
        text: `${atRatio.map(r => r.label).join(', ')} ${atRatio.length === 1 ? 'is' : 'are'} exactly at ratio — the next child adds a staff member.`, cta: 'Open room planner' });
    attention.push({ icon: '🗒️', key: 'careCal',
        text: 'Add a day, edit a calendar, or register a child from the care calendar.', cta: 'Open care calendar' });

    return {
        stamp: `${new Date(live.today + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · ${hereToday} children expected`,
        kpis,
        left: [
            apPanel({ title: isToday ? "Today's roster by room" : "Monday's roster by room",
                sub: 'Headcount against capacity. A room at ratio needs another staff member before the next child.',
                body: apBarsHtml(bars), tools: ['attBoard', 'enrollCap'] }),
        ],
        // Food Program panel removed 2026-08-28 along with its AP_TOOLS
        // entries — see the retirement comment above `enrollCap`'s block.
        right: [],
        attention,
    };
}

// ── Staff ────────────────────────────────────────────────────
function apDashStaff(live) {
    const sf = live.staffing;
    const roster = (typeof allStaffData !== 'undefined' ? allStaffData : []).filter(s => s.active);

    // Scheduled per day, from saved staff_schedules rows for this week.
    const scheduledByDay = live.weekDates.map(d => {
        const names = new Set();
        live.schedule.forEach(r => { if (r.work_date === d) names.add(r.staff_name); });
        return names.size;
    });
    const scheduledAll = new Set(live.schedule.map(r => r.staff_name)).size;
    const anySchedule  = live.schedule.length > 0;

    const bars = live.weekDates.map((d, i) => {
        const need = sf.classroom[i];
        const have = scheduledByDay[i];
        const short = need - have;
        return {
            label: AP_DAYS[i],
            note: sf.closed[i] ? 'closed'
                : anySchedule ? `${need} needed · ${have} scheduled${short > 0 ? ` · short ${short}` : ''}`
                : `${need} needed · nothing scheduled yet`,
            pct: need ? Math.min(100, Math.round((have / need) * 100)) : 0,
            color: sf.closed[i] ? AP_TONE.gold : short > 0 ? AP_TONE.warn : AP_TONE.ok,
        };
    });

    const offRows = live.pending.map(r => ({
        label: r.staff_name || 'Staff member',
        note: `${apDayListLabel(r, live.weekDates)} · asked at the time clock`,
        value: 'Pending', color: AP_TONE.warn,
    })).concat(live.timeOff.slice(0, 4).map(r => ({
        label: r.staff_name || 'Staff member',
        note: `${apDayListLabel(r, live.weekDates)} · ${r.source === 'director' ? 'you entered this' : 'you approved this'}`,
        value: r.recurring ? 'Standing' : 'Approved',
        color: r.recurring ? AP_TONE.navy : AP_TONE.ok,
    })));

    const kpis = [
        { label: 'Scheduled this week', tone: anySchedule ? 'ok' : 'warn',
          value: anySchedule ? `${scheduledAll} of ${roster.length || '—'}` : 'Not built',
          sub: anySchedule ? 'staff on the posted week' : 'no schedule saved for this week',
          link: 'schedule', linkIcon: '🗓️', linkLabel: 'Build staff schedule' },
        { label: 'Days off to approve', tone: live.pending.length ? 'warn' : 'ok', value: live.pending.length,
          sub: live.pending.length
              ? live.pending.map(r => (r.staff_name || '').split(' ')[0]).filter(Boolean).slice(0, 3).join(', ') + ' waiting on you'
              : 'nothing waiting on you',
          ...(live.pending.length ? { link: 'schedule', linkIcon: '✅', linkLabel: 'Review requests' } : {}) },
        { label: 'Peak staff needed', tone: 'navy', value: Math.max(0, ...sf.classroom), sub: 'on the heaviest day' },
    ];
    if (roster.length) kpis.push({ label: 'On the roster', tone: 'ok', value: roster.length, sub: 'active staff' });

    const attention = [];
    const shortDays = live.weekDates.map((d, i) => ({ i, short: sf.classroom[i] - scheduledByDay[i] }))
        .filter(x => anySchedule && x.short > 0 && !sf.closed[x.i]);
    if (!anySchedule) attention.push({ icon: '🗓️', key: 'schedule', urgent: true,
        text: 'No staff schedule is saved for this week yet.', cta: 'Build staff schedule' });
    else if (shortDays.length) attention.push({ icon: '⏰', key: 'schedule', urgent: true,
        text: `${shortDays.map(x => AP_DAYS[x.i]).join(', ')} ${shortDays.length === 1 ? 'is' : 'are'} short of what the ratios ask for.`, cta: 'Build staff schedule' });
    if (live.pending.length) attention.push({ icon: '✅', key: 'schedule', urgent: true,
        text: `${live.pending.length} day-off request${live.pending.length === 1 ? '' : 's'} from the time clock ${live.pending.length === 1 ? 'is' : 'are'} waiting on you.`, cta: 'Review requests' });
    attention.push({ icon: '📍', key: 'payroll',
        text: 'Check where the time clock accepts a punch and when staff get nudged.', cta: 'Open Time Clock (Payroll)' });

    return {
        stamp: `Week of ${friendlyShort(live.weekOf)} · ${roster.length || 'no'} staff on the roster`,
        kpis,
        left: [
            apPanel({ title: 'Staff needed this week',
                sub: 'From registered children and saved ratios — no clock-in data involved.',
                body: apStaffGridHtml(sf), tools: ['schedule'] }),
            apPanel({ title: 'Coverage against requirement',
                sub: 'What the saved schedule puts on the floor, against what the ratios ask for that day.',
                body: apBarsHtml(bars), tools: ['schedule', 'staffRoster', 'payroll'] }),
        ],
        right: offRows.length ? [
            apPanel({ title: 'Time off this week', tone: 'gold',
                sub: 'Only approved days are avoided by the scheduler — pending ones change nothing until you say yes.',
                body: apRowsHtml(offRows), tools: ['schedule'] }),
        ] : [],
        attention,
    };
}

// ── Market ───────────────────────────────────────────────────
function apDashMarket(live) {
    const providers = live.providers || [];
    if (!providers.length) {
        return {
            stamp: 'No comparable providers recorded yet',
            kpis: [],
            left: [apPanel({ title: 'Nothing to compare against yet',
                sub: 'Add the providers you compete with and this dashboard fills in — weekly rates, registration fees, and where we sit in the set.',
                body: '', tools: ['mktProviders', 'directorReport'] })],
            right: [],
            attention: [{ icon: '🏫', key: 'mktProviders',
                text: 'The comparable provider set is empty.', cta: 'Add providers' }],
        };
    }

    // Weekly-equivalent midpoint per provider, so a range and a single
    // figure compare on the same basis.
    const rate = p => {
        const lo = Number(p.rate_low) || 0, hi = Number(p.rate_high) || lo;
        const mid = hi ? (lo + hi) / 2 : lo;
        if (!mid) return 0;
        const unit = (p.rate_unit || 'week').toLowerCase();
        return unit.startsWith('day') ? mid * 5 : unit.startsWith('month') ? mid * 12 / 52 : mid;
    };
    const priced = providers.map(p => ({ ...p, weekly: rate(p) })).filter(p => p.weekly > 0);
    const us     = priced.find(p => p.is_own_program);
    const sorted = [...priced].sort((a, b) => a.weekly - b.weekly);
    const median = sorted.length
        ? (sorted.length % 2 ? sorted[(sorted.length - 1) / 2].weekly
                             : (sorted[sorted.length / 2 - 1].weekly + sorted[sorted.length / 2].weekly) / 2)
        : 0;
    const rank = us ? sorted.findIndex(p => p.id === us.id) + 1 : 0;
    const gap  = us && median ? Math.round(((us.weekly - median) / median) * 100) : 0;
    const max  = Math.max(...priced.map(p => p.weekly), 1);

    const kpis = [];
    if (us) kpis.push({ label: 'Our weekly rate', tone: 'navy', value: apMoney(us.weekly),
                        sub: rank ? `${rank} of ${sorted.length} by price` : 'in the set' });
    if (median) kpis.push({ label: 'Market median', tone: 'ok', value: apMoney(median),
                            sub: us ? (gap === 0 ? 'we match it' : `we sit ${Math.abs(gap)}% ${gap < 0 ? 'under' : 'over'}`) : 'across the set' });
    kpis.push({ label: 'Providers tracked', tone: 'ok', value: providers.length,
                sub: `${priced.length} with a rate on file`, link: 'mktProviders', linkIcon: '🏫', linkLabel: 'See the set' });
    const fees = providers.map(p => Number(p.reg_fee_low) || 0).filter(Boolean);
    if (fees.length) {
        const fmed = [...fees].sort((a, b) => a - b)[Math.floor(fees.length / 2)];
        kpis.push({ label: 'Median registration fee', tone: 'gold', value: apMoney(fmed), sub: `${fees.length} providers report one` });
    }

    const bars = sorted.slice().reverse().slice(0, 8).map(p => ({
        label: p.name || 'Provider',
        note:  apMoney(p.weekly) + '/wk' + (us && p.id !== us.id && us.weekly
                 ? ` · ${Math.abs(Math.round(((p.weekly - us.weekly) / us.weekly) * 100))}% ${p.weekly >= us.weekly ? 'above' : 'below'} us`
                 : p.is_own_program ? ' · our rate' : ''),
        pct:   Math.round((p.weekly / max) * 100),
        color: p.is_own_program ? AP_TONE.navy : AP_TONE.gold,
    }));

    return {
        stamp: `${providers.length} comparable providers · weekly-equivalent rates`,
        kpis,
        left: [
            apPanel({ title: 'Pricing landscape',
                sub: 'Weekly-equivalent full-time rate, us against the comparable set. Ranges are shown at their midpoint.',
                body: apBarsHtml(bars), tools: ['directorReport', 'mktProviders'] }),
        ],
        right: [],
        attention: [
            ...(us && gap < -3 ? [{ icon: '💲', key: 'scenario',
                text: `We are ${Math.abs(gap)}% under the market median with no rate change modeled.`, cta: 'Open rate scenarios' }] : []),
            { icon: '🏫', key: 'mktProviders', text: 'Keep the comparable set current — rates move.', cta: 'Review providers' },
            { icon: '💵', key: 'directorReport', text: 'Cost and wage context explains why infant care prices the way it does.', cta: 'Open the Director Report' },
        ],
    };
}

function apDashSimple() {
    return {
        stamp: AP_TABS[apState.tab].blurb,
        kpis: [],
        left: apGroupsForTab(apState.tab).map(g => apPanel({
            title: g.label, sub: '', body: '', tools: g.tools.map(t => t.key),
        })),
        right: [],
        attention: [],
    };
}

// ============================================================
// TOOL: Daily Staffing Requirement  (new, fully built)
// ============================================================
const apReqInputs = { hours: 10.5, floaters: 1, wage: 15.5, burden: 12 };

// Build Staff Schedule and Daily Staffing Requirement are tabs of one tool
// now (design_handoff_staff, 2026-08-28) and share a single "Week of" date
// field (#staffWeekOf) instead of two independent pickers that could drift
// apart. apSchedHeaderStats() reads the exact same apStaffing()+apReqInputs
// figures this function computes — one calculation, so the header cards and
// the Requirement tab's own totals can never disagree.
function apRenderStaffReq() {
    const host = document.getElementById('staffReqBody');
    if (!host) return;
    const weekOf    = document.getElementById('staffWeekOf')?.value || apWeekStart();
    const weekDates = apWeekDates(weekOf);
    const sf        = apStaffing(weekDates);

    const floaters = Number(apReqInputs.floaters) || 0;
    const total    = sf.classroom.map((n, i) => (sf.closed[i] ? 0 : n + floaters));
    const hrs      = total.map(n => n * (Number(apReqInputs.hours) || 0));
    const cost     = hrs.map(h => h * (Number(apReqInputs.wage) || 0) * (1 + (Number(apReqInputs.burden) || 0) / 100));
    const peak     = Math.max(0, ...total);
    const peakDay  = AP_DAYS[total.indexOf(peak)] || AP_DAYS[0];

    apSchedHeaderStats(sf, cost);

    if (!sf.rows.length) {
        host.innerHTML = '<p class="empty-hint">No children are registered for this week yet — pick another week above.</p>';
        apCostRender(sf);
        return;
    }

    const dayHead = sf.weekDates.map((d, i) =>
        `<th>${AP_DAYS[i]}<br><span style="font-weight:400;text-transform:none;letter-spacing:0">${escHtml(friendlyShort(d).replace(/, \d{4}$/, ''))}</span></th>`).join('');

    const footRow = (label, cells, cls) => `
        <tr class="${cls}">
            <td colspan="2" style="text-align:left">${escHtml(label)}</td>
            ${cells.map(c => `<td>${escHtml(String(c))}</td>`).join('')}
        </tr>`;

    host.innerHTML = `
        <div class="ap-stats" style="margin-bottom:18px">
            <div class="ap-stat">
                <div class="ap-stat-label">Peak day</div>
                <div class="ap-stat-value is-alert">${escHtml(peakDay)} · ${peak} staff</div>
            </div>
            <div class="ap-stat">
                <div class="ap-stat-label">Children this week</div>
                <div class="ap-stat-value">${sf.kids.reduce((a, b) => a + b, 0)}</div>
            </div>
            <div class="ap-stat">
                <div class="ap-stat-label">Est. labor cost</div>
                <div class="ap-stat-value">${escHtml(apMoney(cost.reduce((a, b) => a + b, 0)))}</div>
            </div>
        </div>
        <div style="overflow-x:auto">
            <table class="ap-req-table">
                <thead>
                    <tr>
                        <th class="ap-th-left">Room</th>
                        <th class="ap-th-left">Ratio</th>
                        ${dayHead}
                    </tr>
                </thead>
                <tbody>
                    ${sf.rows.map(r => `
                    <tr>
                        <td class="ap-td-room">${escHtml(r.label)}</td>
                        <td class="ap-td-ratio">${escHtml(r.ratioLabel)}</td>
                        ${r.cells.map(c => `
                        <td>
                            ${c.closed ? `
                            <div class="ap-req-staff">—</div>
                            <div class="ap-req-kids">closed</div>` : c.staffPm !== c.staff ? `
                            <div class="ap-req-staff${c.atEdge ? ' is-edge' : ''}">${c.staff}<span class="ap-req-shift">AM</span></div>
                            <div class="ap-req-staff${c.atEdgePm ? ' is-edge' : ''}">${c.staffPm}<span class="ap-req-shift">PM</span></div>
                            <div class="ap-req-kids">${c.kids}→${c.kidsPm} kids</div>` : `
                            <div class="ap-req-staff${c.atEdge ? ' is-edge' : ''}">${c.staff}</div>
                            <div class="ap-req-kids">${c.kids} kids</div>`}
                        </td>`).join('')}
                    </tr>`).join('')}
                </tbody>
                <tfoot>
                    ${footRow('Children registered',      sf.kids,                          'is-soft')}
                    ${footRow('AM staff required',        sf.classroom,                     'is-strong')}
                    ${footRow('PM staff required',        sf.classroomPm,                   'is-soft')}
                    ${footRow('Floaters / break relief',  total.map((_, i) => sf.closed[i] ? 0 : floaters), 'is-soft')}
                    ${footRow('Total on the floor',       total,                            'is-total')}
                    ${footRow('Staff-hours',              hrs.map(h => Math.round(h)),      'is-soft')}
                    ${footRow('Est. labor cost',          cost.map(apMoney),                'is-strong')}
                </tfoot>
            </table>
        </div>
        <p style="color:var(--text-muted);font-size:.86em;margin-top:14px;max-width:76ch;text-wrap:pretty">
            Ratios come from Settings → Staff-to-Child Ratios. AM counts every child booked that day; PM counts full-day children only, since a half-day booking drops for the afternoon — a room shows one number when AM and PM match, and both when they don't. An orange count means that shift is exactly at ratio — one more child adds another staff member. "Total on the floor" and the cost estimate are built from the AM figure, since it is always the day's peak. Goose, Turtle and Owl combine into one supervised group from 1:00p–5:00p — their own PM figure is always 0, and the pooled staffing need for the three together shows as the After Care row.
        </p>`;
    apCostRender(sf);
}

// ============================================================
// Cost to add staff — Day / Week, one calculation
// ============================================================
// The design handoff's own version of this was a flat table: one row per
// room, "next AM hire +$104 / next PM hire +$78" — the same two figures
// repeated five times, because a hire costs the same wherever it stands.
// What actually differs per room is what that hire *covers*: at 1:4 a Bear
// hire buys 4 seats ($21.70/child at our shift length), at 1:12 a Pre-K
// hire buys 12 ($7.23/child). Three times the value for the same dollar,
// and the flat table hid it entirely.
//
// So this is a coverage view instead. Each staff member owns a group of
// `ratio` seats; children fill the seats left to right; a group with
// nobody assigned to it is the deficit, drawn in deep tangerine. Assigning
// one more person in the grid turns the next group green — the whole point
// of the ask ("as staff are added to a room"), which a static snapshot
// cannot show.
//
// ⚠️ Assigned counts come from _readAssignmentsFromDOM() (admin-reports.js)
// — the same helper saveStaffSchedule(), the XLSX export and the By-worker
// pivot all read through. Any second source and this could show coverage
// that disagrees with what Save would actually persist.
//
// ⚠️ Shift cost uses SCHED_SHIFT_HOURS, the app's own real shift lengths
// (5h / 5h), NOT the mockup's 6h/4.5h split — which would make AM and PM
// hires cost $104/$78 as drawn but disagree with the per-person cost
// renderScheduleByWorker() already prints from the same constant. Same
// reasoning as everywhere else in this tool: one number, one source.
const apCostState = { view: 'day', dayIdx: 0 };
let _apCostWired = false;

// apMoney() rounds to whole dollars — right for a week's labor total, wrong
// for a wage or a per-child figure, where the rounding is a third of the
// number. These two get cents.
function apCostCents(n) {
    return '$' + (Number(n) || 0).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function apShiftHireCost(shift) {
    const hours  = (typeof SCHED_SHIFT_HOURS === 'object' && SCHED_SHIFT_HOURS[shift]) || 5;
    const wage   = Number(apReqInputs.wage) || 0;
    const burden = 1 + (Number(apReqInputs.burden) || 0) / 100;
    return hours * wage * burden;
}

// One row per room per day, both shifts, with what's actually assigned
// laid over what the ratios require.
function apCoverage(sf, assignments) {
    return sf.rows.map(r => {
        const ratio = r.ratio;
        const days  = sf.weekDates.map((date, i) => {
            const cell = r.cells[i];
            const shift = (key, kids, required) => {
                const assigned = (assignments?.[date]?.[r.room.id]?.[key] || []).length;
                const groups   = Math.max(required, assigned, kids > 0 ? 1 : 0);
                return {
                    kids, required, assigned, groups,
                    covered: Math.min(kids, assigned * ratio),
                    deficit: Math.max(0, required - assigned),
                    buffer:  Math.max(0, assigned - required),
                    hireCost: apShiftHireCost(key),
                };
            };
            return {
                date, closed: cell.closed,
                am: shift('am', cell.kids,   cell.staff),
                pm: shift('pm', cell.kidsPm, cell.staffPm),
            };
        });
        return { room: r.room, label: r.label, ratio, ratioLabel: r.ratioLabel, days };
    });
}

function apCostRender(sf) {
    const host = document.getElementById('staffCostAddBody');
    if (!host) return;

    if (!sf.rows.length) { host.innerHTML = ''; return; }

    const assignments = (typeof _readAssignmentsFromDOM === 'function')
        ? _readAssignmentsFromDOM(sf.weekDates) : {};
    const rows = apCoverage(sf, assignments);

    // ⚠️ A week nobody has filled in yet would otherwise render as five
    // rooms fully in the red, which reads as a crisis rather than as an
    // empty form. Until at least one slot is assigned anywhere in the week,
    // this shows the requirement and the price of meeting it — no deficit
    // styling, because "0 assigned" and "not filled in yet" are the same
    // DOM state and only one of them is a problem.
    const anyAssigned = rows.some(r => r.days.some(d => d.am.assigned || d.pm.assigned));

    if (apCostState.dayIdx > sf.weekDates.length - 1) apCostState.dayIdx = 0;

    const toggle = `
        <div class="ap-seg ap-cost-seg" id="apCostViewToggle">
            <button class="ap-seg-btn${apCostState.view === 'day'  ? ' is-on' : ''}" data-ap-cost-view="day">One day</button>
            <button class="ap-seg-btn${apCostState.view === 'week' ? ' is-on' : ''}" data-ap-cost-view="week">All week</button>
        </div>`;

    const planningNote = anyAssigned ? '' : `
        <p class="ap-cost-note is-planning">No one is assigned for this week yet, so nothing below is counted as short — these are the seats the ratios require and what covering them costs.</p>`;

    host.innerHTML = `
        <div class="ap-cost-head">
            <div>
                <h3 class="ap-cost-title">Cost to add staff</h3>
                <p class="ap-cost-sub">What one more hire covers, and what it costs, at ${escHtml(apCostCents(Number(apReqInputs.wage) || 0))}/hr + ${escHtml(String(Number(apReqInputs.burden) || 0))}% burden.</p>
            </div>
            ${toggle}
        </div>
        ${planningNote}
        ${apCostState.view === 'day' ? apCostDayView(sf, rows, anyAssigned) : apCostWeekView(sf, rows, anyAssigned)}
        <p class="ap-cost-note">Each block is one staff member's worth of seats at that room's ratio. Filled dots are children booked; a block with nobody on it is the gap. Assign someone in <strong>This week's schedule</strong> and these update — the count comes from the same grid Save writes, so it can't disagree with it.</p>`;

    apCostWire();
}

function apCostShiftRow(shiftKey, s, ratio, anyAssigned) {
    const label = shiftKey === 'am' ? 'AM' : 'PM';
    if (!s.kids) {
        return `<div class="ap-cost-shift is-empty"><span class="ap-cost-shift-tag">${label}</span><span class="ap-cost-shift-none">no children booked</span></div>`;
    }

    // Seats, grouped one block per staff member. Children fill left to
    // right, so the block that runs out of staff is visibly the last one.
    let seated = 0;
    const blocks = [];
    for (let g = 0; g < s.groups; g++) {
        const staffed = g < s.assigned;
        const dots = [];
        for (let i = 0; i < ratio; i++) {
            dots.push(`<span class="ap-cost-seat${seated < s.kids ? ' is-filled' : ''}"></span>`);
            seated++;
        }
        const beyondNeed = g >= s.required;
        const cls = !anyAssigned ? 'is-plan' : staffed ? (beyondNeed ? 'is-buffer' : 'is-staffed') : 'is-gap';
        blocks.push(`<span class="ap-cost-block ${cls}">${dots.join('')}</span>`);
    }

    let status;
    if (!anyAssigned) {
        status = `<span class="is-plan-text">${s.required} needed · ${escHtml(apMoney(s.required * s.hireCost))}</span>`;
    } else if (s.deficit > 0) {
        status = `<span class="is-gap-text">Short ${s.deficit} · ${escHtml(apMoney(s.deficit * s.hireCost))} to cover</span>`;
    } else {
        const seats = Math.max(0, s.assigned * ratio - s.kids);
        const seatTxt = seats === 0
            ? 'at ratio — the next child adds staff'
            : `${seats} seat${seats === 1 ? '' : 's'} of room`;
        status = s.buffer > 0
            ? `<span class="is-buffer-text">Covered · ${s.buffer} spare staff · ${escHtml(seatTxt)}</span>`
            : `<span class="is-ok-text">Covered · ${escHtml(seatTxt)}</span>`;
    }

    return `
        <div class="ap-cost-shift">
            <span class="ap-cost-shift-tag">${label}</span>
            <span class="ap-cost-blocks">${blocks.join('')}</span>
            <span class="ap-cost-shift-meta">
                <span class="ap-cost-shift-kids">${s.kids} kids · ${s.assigned} on</span>
                ${status}
            </span>
        </div>`;
}

function apCostDayView(sf, rows, anyAssigned) {
    const i = apCostState.dayIdx;
    const days = sf.weekDates.map((d, idx) => `
        <button class="ap-cost-day${idx === i ? ' is-on' : ''}${sf.closed[idx] ? ' is-closed' : ''}" data-ap-cost-day="${idx}">
            ${AP_DAYS[idx]}<span>${escHtml(friendlyShort(d).replace(/, \d{4}$/, '').replace(/^[A-Za-z]+, /, ''))}</span>
        </button>`).join('');

    if (sf.closed[i]) {
        return `<div class="ap-cost-days">${days}</div>
            <p class="empty-hint">The center is closed on ${escHtml(AP_DAYS[i])} — no staffing required.</p>`;
    }

    const cards = rows.map(r => {
        const d = r.days[i];
        return `
        <div class="ap-cost-room">
            <div class="ap-cost-room-head">
                <span class="ap-cost-room-name">${escHtml(r.label)}</span>
                <span class="ap-cost-room-ratio">${escHtml(r.ratioLabel)}</span>
                <span class="ap-cost-room-hire">
                    <strong>+${escHtml(apCostCents(apShiftHireCost('am')))}</strong> per hire
                    · covers ${r.ratio} · ${escHtml(apCostCents(apShiftHireCost('am') / r.ratio))}/child
                </span>
            </div>
            ${apCostShiftRow('am', d.am, r.ratio, anyAssigned)}
            ${apCostShiftRow('pm', d.pm, r.ratio, anyAssigned)}
        </div>`;
    }).join('');

    const gapCost = rows.reduce((a, r) =>
        a + r.days[i].am.deficit * r.days[i].am.hireCost + r.days[i].pm.deficit * r.days[i].pm.hireCost, 0);
    const gapStaff = rows.reduce((a, r) => a + r.days[i].am.deficit + r.days[i].pm.deficit, 0);

    const footer = !anyAssigned ? '' : gapStaff
        ? `<div class="ap-cost-total is-gap">${gapStaff} shift${gapStaff === 1 ? '' : 's'} unstaffed on ${escHtml(AP_DAYS[i])} · ${escHtml(apMoney(gapCost))} to close the gap</div>`
        : `<div class="ap-cost-total is-ok">Every room is covered on ${escHtml(AP_DAYS[i])}.</div>`;

    return `<div class="ap-cost-days">${days}</div><div class="ap-cost-rooms">${cards}</div>${footer}`;
}

// All-week view is AM only, on purpose: apStaffing()'s own note says AM is
// always the day's peak (a half-day booking can only ever remove a PM
// child, never add one), so the AM figure is the one that decides whether
// the day is staffed. Five rooms x five days x two shifts of seat blocks
// would also be unreadable — the day view is where both shifts live.
function apCostWeekView(sf, rows, anyAssigned) {
    const head = sf.weekDates.map((d, i) =>
        `<th>${AP_DAYS[i]}<span>${escHtml(friendlyShort(d).replace(/, \d{4}$/, '').replace(/^[A-Za-z]+, /, ''))}</span></th>`).join('');

    const body = rows.map(r => `
        <tr>
            <td class="ap-cost-wk-room">
                <span class="ap-cost-room-name">${escHtml(r.label)}</span>
                <span class="ap-cost-room-ratio">${escHtml(r.ratioLabel)} · +${escHtml(apCostCents(apShiftHireCost('am')))} per hire covers ${r.ratio}</span>
            </td>
            ${r.days.map((d, i) => {
                if (sf.closed[i]) return '<td class="ap-cost-wk-cell is-closed"><span class="ap-cost-wk-none">closed</span></td>';
                const s = d.am;
                if (!s.kids)     return '<td class="ap-cost-wk-cell"><span class="ap-cost-wk-none">—</span></td>';
                const pct = Math.round((s.covered / s.kids) * 100);
                const cls = !anyAssigned ? 'is-plan' : s.deficit ? 'is-gap' : s.buffer ? 'is-buffer' : 'is-ok';
                const note = !anyAssigned ? `${s.required} needed`
                    : s.deficit ? `short ${s.deficit} · ${apMoney(s.deficit * s.hireCost)}`
                    : s.buffer  ? `${s.buffer} spare` : 'covered';
                return `
                <td class="ap-cost-wk-cell ${cls}">
                    <div class="ap-cost-wk-bar"><span style="width:${anyAssigned ? pct : 0}%"></span></div>
                    <div class="ap-cost-wk-kids">${s.kids} kids · ${s.assigned}/${s.required}</div>
                    <div class="ap-cost-wk-note">${escHtml(note)}</div>
                </td>`;
            }).join('')}
        </tr>`).join('');

    const perDayGap = sf.weekDates.map((_, i) =>
        rows.reduce((a, r) => a + (sf.closed[i] ? 0 : r.days[i].am.deficit * r.days[i].am.hireCost), 0));

    return `
        <div style="overflow-x:auto">
            <table class="ap-cost-wk-table">
                <thead><tr><th class="ap-cost-wk-roomhead">Room · AM shift</th>${head}</tr></thead>
                <tbody>${body}</tbody>
                ${anyAssigned ? `<tfoot><tr>
                    <td class="ap-cost-wk-roomhead">Cost to close the gap</td>
                    ${perDayGap.map(v => `<td>${v ? escHtml(apMoney(v)) : '—'}</td>`).join('')}
                </tr></tfoot>` : ''}
            </table>
        </div>`;
}

// Delegated once on the persistent container — apCostRender() replaces its
// innerHTML on every re-render, so a listener bound to the buttons
// themselves would be dropped each time.
function apCostWire() {
    if (_apCostWired) return;
    const host = document.getElementById('staffCostAddBody');
    if (!host) return;
    _apCostWired = true;
    host.addEventListener('click', e => {
        const v = e.target.closest('[data-ap-cost-view]');
        if (v) { apCostState.view = v.dataset.apCostView; apRenderStaffReq(); return; }
        const d = e.target.closest('[data-ap-cost-day]');
        if (d) { apCostState.dayIdx = parseInt(d.dataset.apCostDay, 10) || 0; apRenderStaffReq(); }
    });
}

// Shared header cards (Children this week / Est. labor cost) above the tab
// strip — same figures apRenderStaffReq() computes for its own footer, so
// the two can never disagree. Deliberately the wage-model estimate (avg
// wage × hours × burden), not a sum of individually assigned staff's real
// rates — Build Staff Schedule's own assignments are frequently incomplete
// mid-week, and a cost built from "who's actually filled in so far" would
// swing every time a slot is assigned, reading as broken rather than live.
function apSchedHeaderStats(sf, cost) {
    const host = document.getElementById('apSchedHeaderStats');
    if (!host) return;
    const kids  = sf.kids.reduce((a, b) => a + b, 0);
    const labor = cost.reduce((a, b) => a + b, 0);
    host.innerHTML = `
        <div class="bk-stat">
            <div class="bk-stat-label">Children this week</div>
            <div class="bk-stat-num">${kids}</div>
        </div>
        <div class="bk-stat">
            <div class="bk-stat-label">Est. labor cost</div>
            <div class="bk-stat-num">${escHtml(apMoney(labor))}</div>
        </div>`;
}

// Build Staff Schedule: "This week's schedule" / "Daily Staffing
// Requirement" tabs, and — inside the schedule tab — "By room & shift"
// (editable, the director's own working format, default) / "By worker"
// (read-only pivot of the same assignments, for a quick per-person glance).
let _apSchedTab  = 'week';
let _apSchedView = 'room';

function apSwitchSchedTab(key) {
    _apSchedTab = key;
    document.querySelectorAll('#apSchedTabs [data-ap-sched-tab]').forEach(b =>
        b.classList.toggle('is-on', b.dataset.apSchedTab === key));
    document.getElementById('apSchedTabWeek')?.classList.toggle('ap-hidden-tool', key !== 'week');
    document.getElementById('apSchedTabReq')?.classList.toggle('ap-hidden-tool', key !== 'req');
}

function apSwitchSchedView(key) {
    _apSchedView = key;
    document.querySelectorAll('#apSchedViewToggle [data-ap-sched-view]').forEach(b =>
        b.classList.toggle('is-on', b.dataset.apSchedView === key));
    document.getElementById('staffContent')?.classList.toggle('ap-hidden-tool', key !== 'room');
    const byWorker = document.getElementById('staffContentByWorker');
    if (byWorker) {
        byWorker.classList.toggle('ap-hidden-tool', key !== 'worker');
        if (key === 'worker' && typeof renderScheduleByWorker === 'function') renderScheduleByWorker();
    }
}

// Staff Roster: "Roster" (editable, the staff table) / "Directory (print)"
// (renderStaffDirectory(), the public-site list, read here as a tab of the
// same table rather than a parallel screen).
function apSwitchRosterTab(key) {
    document.querySelectorAll('#apRosterTabs [data-ap-roster-tab]').forEach(b =>
        b.classList.toggle('is-on', b.dataset.apRosterTab === key));
    document.getElementById('apRosterTabRoster')?.classList.toggle('ap-hidden-tool', key !== 'roster');
    document.getElementById('apRosterTabDirectory')?.classList.toggle('ap-hidden-tool', key !== 'directory');
}

// Payroll: "Pay period" / "PTO policy" / "Time Clock" tabs. Time Clock
// itself has "Settings" (geofence config) / "Integrity" (the diagnostic
// report on whether that config is actually working) sub-tabs — one merged
// tool for tuning the time clock's rules and seeing whether they hold, per
// design_handoff_staff. Integrity is lazy-rendered on first open of its
// sub-tab, matching how it was lazy before this consolidation (Pay period
// and PTO policy are both already loaded unconditionally at portal boot).
let _apClockIntegrityLoaded = false;

function apSwitchPayrollTab(key) {
    document.querySelectorAll('#apPayrollTabs [data-ap-payroll-tab]').forEach(b =>
        b.classList.toggle('is-on', b.dataset.apPayrollTab === key));
    document.getElementById('apPayrollTabPeriod')?.classList.toggle('ap-hidden-tool', key !== 'period');
    document.getElementById('apPayrollTabPto')?.classList.toggle('ap-hidden-tool', key !== 'pto');
    document.getElementById('apPayrollTabClock')?.classList.toggle('ap-hidden-tool', key !== 'clock');
}

function apSwitchTimeClockTab(key) {
    document.querySelectorAll('#apTimeClockTabs [data-ap-tc-tab]').forEach(b =>
        b.classList.toggle('is-on', b.dataset.apTcTab === key));
    document.getElementById('apTimeClockTabSettings')?.classList.toggle('ap-hidden-tool', key !== 'settings');
    document.getElementById('apTimeClockTabIntegrity')?.classList.toggle('ap-hidden-tool', key !== 'integrity');
    if (key === 'integrity' && !_apClockIntegrityLoaded && typeof renderClockIntegrityTool === 'function') {
        _apClockIntegrityLoaded = true;
        renderClockIntegrityTool();
    }
}

// HR & Handbook: "Policies" / "Write-ups" / "Injury Reports" / "Credentials"
// tabs. Injury Reports and Credentials are both hidden client-side for
// anyone but a `full` admin — see applyRoleRestrictions() in
// admin-settings.js — same reasoning `staffInjury` carried as its own
// AP_FULL_ONLY_KEYS entry before this consolidation.
function apSwitchHrTab(key) {
    document.querySelectorAll('#apHrTabs [data-ap-hr-tab]').forEach(b =>
        b.classList.toggle('is-on', b.dataset.apHrTab === key));
    document.getElementById('apHrTabPolicies')?.classList.toggle('ap-hidden-tool', key !== 'policies');
    document.getElementById('apHrTabWriteUps')?.classList.toggle('ap-hidden-tool', key !== 'writeups');
    document.getElementById('apHrTabInjury')?.classList.toggle('ap-hidden-tool', key !== 'injury');
    document.getElementById('apHrTabCredentials')?.classList.toggle('ap-hidden-tool', key !== 'credentials');
}

// ── Ratio Step & Next Child, embedded in Build Staff Schedule ──────────
// Second mount point for generateRatioStepReport() (admin-reports.js) —
// design_handoff_planning_market, 2026-08-27: "Ratio Step must be a single
// render function taking a mount element, called from two places, not
// duplicated markup." The Planning tab's own Ratio Step tool is untouched
// (default ids); this one reuses the schedule's own week-of picker instead
// of a second date input, has no export button, and never alert()s on a
// missing week — it renders nothing until one is chosen.
let _apStaffRatioStepWired = false;

function apMountStaffRatioStep() {
    const mount = document.getElementById('staffRatioStepSection');
    if (!mount || typeof generateRatioStepReport !== 'function') return;

    if (!_apStaffRatioStepWired) {
        _apStaffRatioStepWired = true;
        document.getElementById('staffWeekOf')?.addEventListener('change', apRenderStaffRatioStep);
    }
    apRenderStaffRatioStep();
}

function apRenderStaffRatioStep() {
    const mount = document.getElementById('staffRatioStepSection');
    if (!mount) return;
    const weekOf = document.getElementById('staffWeekOf')?.value || apWeekStart();
    generateRatioStepReport({
        containerId: 'staffRatioStepContent',
        weekOf, roomSel: 'all',
        showExport: false, silent: true,
    });
}

// ============================================================
// TOOL: Rate Increase Scenarios  (new, fully built)
// ============================================================
// 50 working weeks a year, matching the design handoff's annual model.
const AP_WEEKS = 50;
const apScenario = { inc: {}, regFee: 0, supFee: 0, newFam: 40, wageAdd: 0, burden: 12 };

function apRenderScenario() {
    const host = document.getElementById('rateScenarioBody');
    if (!host) return;
    const sf   = apStaffing(apWeekDates(apWeekStart()));
    const rooms = sf.rows.length ? sf.rows : getSortedRooms().filter(r => !r.hidden).map(r => ({
        room: r, label: r.label, ratio: r.staffRatio || 10, cells: AP_DAYS.map(() => ({ kids: 0, staff: 0, closed: false, atEdge: false })),
    }));

    let tuitionAdd = 0;
    const incRows = rooms.map(r => {
        const weekDays = r.cells.reduce((a, c) => a + c.kids, 0);
        const careDays = weekDays * AP_WEEKS;
        const inc      = Number(apScenario.inc[r.room.id]) || 0;
        tuitionAdd += inc * careDays;
        return { id: r.room.id, label: r.label, detail: `${careDays.toLocaleString()} care days/yr · 1:${r.ratio}`, value: inc };
    });

    const kids = new Set();
    (allRegistrations || []).forEach(reg => {
        if ((reg.registration_dates || []).some(d => !d.waitlisted)) {
            kids.add(`${(reg.parent_email || '').toLowerCase()}:${(reg.child_name || '').toLowerCase()}`);
        }
    });
    const kidCount = kids.size;
    const feeAdd   = apScenario.regFee * apScenario.newFam + apScenario.supFee * kidCount;

    const floorHoursWeek = sf.classroom.reduce((a, n, i) => a + (sf.closed[i] ? 0 : (n + 1) * 10.5), 0);
    const annualHours    = floorHoursWeek * AP_WEEKS;
    const laborAdd       = apScenario.wageAdd * annualHours * (1 + apScenario.burden / 100);
    const net            = tuitionAdd + feeAdd - laborAdd;
    const families       = Math.max(1, Math.round(kidCount / 1.35));

    const numField = (name, value, step = '1') =>
        `<input type="number" step="${step}" value="${value}" data-ap-scen="${name}"
                style="width:88px;text-align:right;padding:8px 11px;border:1px solid var(--border);border-radius:8px;font-family:var(--font-body);background:#fff">`;
    const lever = (label, detail, prefix, input) => `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:14px;padding:10px 0;border-bottom:1px solid var(--ap-border-lt)">
            <div>
                <div style="font-weight:700;font-size:.94em;color:var(--navy)">${escHtml(label)}</div>
                <div style="font-size:.78em;color:var(--text-muted)">${escHtml(detail)}</div>
            </div>
            <div style="display:flex;align-items:center;gap:8px">
                <span style="color:var(--text-muted);font-size:.9em">${escHtml(prefix)}</span>${input}
            </div>
        </div>`;

    host.innerHTML = `
    <div style="display:grid;grid-template-columns:minmax(300px,1fr) minmax(280px,340px);gap:28px;align-items:start">
        <div>
            <h4 class="ap-mini-title">Tuition — increase per care day</h4>
            ${incRows.map(r => lever(r.label, r.detail, '+$', numField('inc:' + r.id, r.value))).join('')}

            <h4 class="ap-mini-title" style="margin-top:26px">Fees</h4>
            ${lever('Registration fee increase', 'charged to new families only', '+$', numField('regFee', apScenario.regFee))}
            ${lever('Annual supply fee increase', `per enrolled child · ${kidCount} children`, '+$', numField('supFee', apScenario.supFee))}
            ${lever('New families per year', 'drives registration fee revenue', '#', numField('newFam', apScenario.newFam))}

            <h4 class="ap-mini-title" style="margin-top:26px">Cost side</h4>
            ${lever('Hourly wage increase', 'applied to every floor hour', '+$', numField('wageAdd', apScenario.wageAdd, '0.25'))}
            ${lever('Payroll burden', 'taxes, comp, benefits', '%', numField('burden', apScenario.burden, '0.5'))}
        </div>
        <div style="background:var(--cream);border:1px solid var(--border);border-radius:12px;padding:22px;position:sticky;top:110px">
            <p class="ap-mini-title">Projected annual impact</p>
            ${apRowsHtml([
                { label: 'Added tuition revenue', value: apMoney(tuitionAdd), color: AP_TONE.ok },
                { label: 'Added fee revenue',     value: apMoney(feeAdd),     color: AP_TONE.ok },
                { label: 'Added labor cost',      value: apMoney(-laborAdd),  color: AP_TONE.warn },
                { label: 'Annual floor hours',    value: Math.round(annualHours).toLocaleString(), color: 'var(--text-muted)' },
            ])}
            <div style="margin-top:18px;padding:16px;background:#fff;border:1px solid var(--border);border-radius:10px">
                <div style="font-size:.76em;text-transform:uppercase;letter-spacing:.07em;color:var(--text-muted);margin-bottom:6px">Net change</div>
                <div style="font-family:var(--font-head);font-size:1.9em;font-weight:700;color:${net < 0 ? AP_TONE.warn : AP_TONE.navy}">${escHtml(apMoney(net))}</div>
                <div style="font-size:.82em;color:var(--text-muted);margin-top:8px;text-wrap:pretty">${net >= 0
                    ? 'Projected annual gain against today’s registration volume, before any enrollment loss.'
                    : 'This scenario costs more than it brings in at current volume.'}</div>
            </div>
            <div style="margin-top:14px;font-size:.84em;color:var(--text-muted);text-wrap:pretty">
                Average family pays <strong style="color:var(--navy)">${escHtml(apMoney((tuitionAdd + feeAdd) / families / 12))}</strong> more per month.
            </div>
            <div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:18px">
                <button class="btn-ghost" data-ap-scen-reset>Reset</button>
            </div>
        </div>
    </div>
    <p style="color:var(--text-muted);font-size:.84em;margin-top:16px;max-width:76ch;text-wrap:pretty">
        Care-day volume is this week's booked registrations projected over ${AP_WEEKS} weeks, so the projection reflects how families really book rather than a full-time assumption.
    </p>`;
}

// ============================================================
// Build Staff Schedule — time-off approval queue
// ============================================================
// The director half of the kiosk's "Ask for a day off" flow. Approving is
// what makes a day off real: only `approved` rows are drawn here and only
// they are handed to the schedule auto-fill as blocked days.

let _apTimeOff = { pending: [], approved: [], loaded: false, addOpen: false, addDays: [], busy: null };

function apScheduleWeekDates() {
    const weekOf = document.getElementById('staffWeekOf')?.value || apWeekStart();
    return apWeekDates(weekOf);
}

async function apRenderScheduleTimeOff() {
    const host = document.getElementById('apSchedTimeOff');
    if (!host) return;
    if (!_apTimeOff.loaded) {
        host.innerHTML = '<p class="empty-hint">Loading time off…</p>';
        try {
            const weekDates = apScheduleWeekDates();
            const rows = await fetchTimeOffRequests({ sinceDate: weekDates[0] });
            _apTimeOff.pending  = rows.filter(r => r.status === 'pending');
            _apTimeOff.approved = rows.filter(r => r.status === 'approved');
            _apTimeOff.loaded   = true;
        } catch (err) {
            host.innerHTML = `<p class="empty-hint">Time off could not be loaded — ${escHtml(err.message || 'unknown error')}.<br>
                If this says the table is missing, apply <code>supabase/migrations/add_staff_time_off_requests.sql</code>.</p>`;
            return;
        }
    }
    apDrawScheduleTimeOff();
}

/** Approved days off that land inside the week on screen, per staff id. */
function apApprovedOffForWeek(weekDates) {
    const map = {};
    _apTimeOff.approved.forEach(r => {
        const hits = weekDates.filter((d, i) =>
            (r.off_dates || []).includes(d) || (r.recurring && r.weekday === i));
        if (hits.length) map[r.staff_id] = (map[r.staff_id] || []).concat(hits);
    });
    return map;
}
// Exposed so the schedule auto-fill can skip anyone approved off that day.
window.apApprovedOffForWeek = apApprovedOffForWeek;

function apDayListLabel(req, weekDates) {
    // AP_DAYS is Mon–Fri only. A weekend weekday cannot be produced by the
    // kiosk (weekday-only calendar) or by the director's Mon–Fri chips, and
    // the DB constraint now rejects it — but fall back to the dates rather
    // than rendering "undefined, every week" if one ever appears.
    if (req.recurring && AP_DAYS[req.weekday]) return `${AP_DAYS[req.weekday]}, every week`;
    const days = (req.off_dates || []);
    if (!days.length) return '—';
    return days.slice(0, 4).map(apFmtDayShort).join(', ') + (days.length > 4 ? ` +${days.length - 4} more` : '');
}

function apDrawScheduleTimeOff() {
    const host = document.getElementById('apSchedTimeOff');
    if (!host) return;
    const weekDates = apScheduleWeekDates();
    const pending   = _apTimeOff.pending;
    const staffList = (typeof allStaffData !== 'undefined' ? allStaffData : []).filter(s => s.active);

    const offThisWeek = _apTimeOff.approved.filter(r =>
        r.recurring || (r.off_dates || []).some(d => weekDates.includes(d)));

    const okPanel = pending.length ? `
        <div class="ap-ok-panel">
            <p class="ap-ok-title">Needs your OK</p>
            ${pending.map(r => `
            <div class="ap-ok-card">
                <div class="ap-ok-who">
                    <span class="ap-avatar ${apRoleClass(r.staff_role)}">${escHtml(apInitials(r.staff_name))}</span>
                    <span class="ap-ok-name">${escHtml(r.staff_name || 'Staff member')}</span>
                </div>
                <div class="ap-ok-days">Asking off ${escHtml(apDayListLabel(r, weekDates))} — ${r.recurring ? 'every week' : 'this week'}</div>
                <div class="ap-ok-reason">${escHtml([r.reason, r.note].filter(Boolean).join(' — '))}</div>
                <div class="ap-ok-when">Sent from the time clock, ${escHtml(new Date(r.submitted_at).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' }))}</div>
                <div class="ap-ok-actions">
                    <button class="ap-ok-approve" data-ap-off-decide="${r.id}" data-verdict="approved"${_apTimeOff.busy === String(r.id) ? ' disabled' : ''}>Approve</button>
                    <button class="ap-ok-deny"    data-ap-off-decide="${r.id}" data-verdict="declined"${_apTimeOff.busy === String(r.id) ? ' disabled' : ''}>Not this week</button>
                </div>
            </div>`).join('')}
        </div>` : '';

    const list = offThisWeek.length ? `
        <div class="ap-off-list">
            ${offThisWeek.map(r => `
            <div class="ap-off-item">
                <span class="ap-avatar ${apRoleClass(r.staff_role)}">${escHtml(apInitials(r.staff_name))}</span>
                <span style="min-width:0;flex:1">
                    <span class="ap-off-line">
                        <span class="ap-off-name">${escHtml(r.staff_name || 'Staff member')}</span>
                        <span class="ap-off-days">${escHtml(apDayListLabel(r, weekDates))}</span>
                        <span class="ap-tag${r.recurring ? ' is-standing' : ''}">${r.recurring ? 'Every week' : 'This week'}</span>
                    </span>
                    <span class="ap-off-src">${escHtml(r.source === 'director' ? 'You entered this' : 'Requested at the time clock — you approved it')}${r.reason ? ' · ' + escHtml(r.reason) : ''}</span>
                </span>
                <button class="ap-off-remove" data-ap-off-remove="${r.id}" title="Remove this day off">✕</button>
            </div>`).join('')}
        </div>` : '<p class="ap-note">Nobody is off this week.</p>';

    const addForm = _apTimeOff.addOpen ? `
        <div class="ap-add-form">
            <div class="ap-add-field">
                <label class="ap-add-label">Who</label>
                <select id="apOffStaff">
                    ${staffList.map(s => `<option value="${s.id}">${escHtml(s.name)}${s.role ? ' · ' + escHtml(s.role) : ''}</option>`).join('')}
                </select>
            </div>
            <div class="ap-add-field">
                <label class="ap-add-label">Which days</label>
                <div class="ap-day-chips">
                    ${AP_DAYS.map((d, i) => `<button type="button" class="ap-day-chip${_apTimeOff.addDays.includes(i) ? ' is-on' : ''}" data-ap-off-day="${i}">${d}</button>`).join('')}
                </div>
            </div>
            <div class="ap-add-field">
                <label class="ap-add-label">Reason</label>
                <input type="text" id="apOffReason" placeholder="told me in person">
            </div>
            <label class="ap-add-check">
                <input type="checkbox" id="apOffRepeat">
                <span>Every week from now on</span>
            </label>
            <p class="ap-err" id="apOffError"></p>
            <div class="ap-add-actions">
                <button class="ap-add-save"   id="apOffSave">Save day off</button>
                <button class="ap-add-cancel" data-ap-off-toggle>Cancel</button>
            </div>
        </div>` : '';

    host.innerHTML = `
        <div class="ap-off-side">
            ${okPanel}
            <p class="ap-mini-title">Time off this week</p>
            ${list}
            ${addForm}
            ${_apTimeOff.addOpen ? '' : '<button class="ap-add-off" data-ap-off-toggle>+ Enter a day off someone told you</button>'}
            <p class="ap-note">Requests staff send from the time clock land above under <strong>Needs your OK</strong>. Nothing changes the schedule until you approve it. Days you enter here apply immediately — you have already vetted them.</p>
        </div>`;
}

// Ids stay opaque strings end to end: the request id is a bigserial and
// staff.id is a uuid, so nothing here may be coerced to a Number.
async function apDecideOff(id, verdict) {
    _apTimeOff.busy = String(id);
    apDrawScheduleTimeOff();
    try {
        await decideTimeOffRequest(id, verdict);
        const row = _apTimeOff.pending.find(r => String(r.id) === String(id));
        _apTimeOff.pending = _apTimeOff.pending.filter(r => String(r.id) !== String(id));
        if (row && verdict === 'approved') {
            _apTimeOff.approved.push({ ...row, status: 'approved' });
        }
        apState.live = null;   // the dashboard's pending count is now stale
    } catch (err) {
        alert('Could not save that decision: ' + (err.message || err));
    } finally {
        _apTimeOff.busy = null;
        apDrawScheduleTimeOff();
    }
}

async function apSaveDirectorOff() {
    const errEl = document.getElementById('apOffError');
    const set = msg => { if (errEl) errEl.textContent = msg; };
    const staffId = document.getElementById('apOffStaff')?.value || '';   // uuid
    const repeat  = !!document.getElementById('apOffRepeat')?.checked;
    const reason  = document.getElementById('apOffReason')?.value.trim() || '';
    if (!staffId)                  return set('Pick a staff member.');
    if (!_apTimeOff.addDays.length) return set('Pick at least one day.');

    const weekDates = apScheduleWeekDates();
    const dates = _apTimeOff.addDays.slice().sort((a, b) => a - b).map(i => weekDates[i]);
    const btn = document.getElementById('apOffSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const id = await addDirectorTimeOff({ staffId, dates, recurring: repeat, reason });
        const staff = (typeof allStaffData !== 'undefined' ? allStaffData : []).find(s => String(s.id) === staffId);
        _apTimeOff.approved.push({
            id, staff_id: staffId, staff_name: staff?.name || '', staff_role: staff?.role || '',
            off_dates: dates, recurring: repeat,
            weekday: repeat ? _apTimeOff.addDays[0] : null,
            reason: reason || 'told me in person', note: '', status: 'approved', source: 'director',
            submitted_at: new Date().toISOString(),
        });
        _apTimeOff.addOpen = false;
        _apTimeOff.addDays = [];
        apState.live = null;
        apDrawScheduleTimeOff();
    } catch (err) {
        set(err.message || String(err));
        if (btn) { btn.disabled = false; btn.textContent = 'Save day off'; }
    }
}

async function apRemoveOff(id) {
    if (!confirm('Remove this day off? The schedule will stop working around it.')) return;
    try {
        await deleteTimeOffRequest(id);
        _apTimeOff.approved = _apTimeOff.approved.filter(r => String(r.id) !== String(id));
        apState.live = null;
        apDrawScheduleTimeOff();
    } catch (err) {
        alert('Could not remove that: ' + (err.message || err));
    }
}

// ============================================================
// WIRING
// ============================================================
function setupAdminPortal() {
    apLoadPrefs();

    document.body.classList.add('ap-on');

    // One delegated handler for every navigation affordance the shell renders.
    document.addEventListener('click', e => {
        const go = e.target.closest('[data-ap-go]');
        if (go) { apGo(go.dataset.apGo); return; }
        const tab = e.target.closest('[data-ap-tab]');
        if (tab) { apGoTab(tab.dataset.apTab); return; }
        const decide = e.target.closest('[data-ap-off-decide]');
        if (decide) { apDecideOff(decide.dataset.apOffDecide, decide.dataset.verdict); return; }
        const remove = e.target.closest('[data-ap-off-remove]');
        if (remove) { apRemoveOff(remove.dataset.apOffRemove); return; }
        if (e.target.closest('[data-ap-off-toggle]')) {
            _apTimeOff.addOpen = !_apTimeOff.addOpen;
            apDrawScheduleTimeOff();
            return;
        }
        const chip = e.target.closest('[data-ap-off-day]');
        if (chip) {
            const i = Number(chip.dataset.apOffDay);
            _apTimeOff.addDays = _apTimeOff.addDays.includes(i)
                ? _apTimeOff.addDays.filter(x => x !== i)
                : _apTimeOff.addDays.concat([i]);
            chip.classList.toggle('is-on');
            return;
        }
        if (e.target.closest('#apOffSave')) { apSaveDirectorOff(); return; }
        const schedTab = e.target.closest('[data-ap-sched-tab]');
        if (schedTab) { apSwitchSchedTab(schedTab.dataset.apSchedTab); return; }
        const schedView = e.target.closest('[data-ap-sched-view]');
        if (schedView) { apSwitchSchedView(schedView.dataset.apSchedView); return; }
        if (e.target.closest('#printStaffScheduleBtn')) {
            document.getElementById('printStaffAssignBtn')?.click();
            return;
        }
        const rosterTab = e.target.closest('[data-ap-roster-tab]');
        if (rosterTab) { apSwitchRosterTab(rosterTab.dataset.apRosterTab); return; }
        const payrollTab = e.target.closest('[data-ap-payroll-tab]');
        if (payrollTab) { apSwitchPayrollTab(payrollTab.dataset.apPayrollTab); return; }
        const tcTab = e.target.closest('[data-ap-tc-tab]');
        if (tcTab) { apSwitchTimeClockTab(tcTab.dataset.apTcTab); return; }
        const hrTab = e.target.closest('[data-ap-hr-tab]');
        if (hrTab) { apSwitchHrTab(hrTab.dataset.apHrTab); return; }
        if (e.target.closest('[data-ap-scen-reset]')) {
            apScenario.inc = {}; apScenario.regFee = 0; apScenario.supFee = 0; apScenario.wageAdd = 0;
            apRenderScenario();
        }
        // Family Lookup (Director dashboard) — see admin-family-lookup.js.
        // Edit / Edit Calendar / the "⋮" menu use admin-families.js's own
        // fm-edit-btn / fm-cal-btn / fm-kebab* classes and are handled by
        // that module's document-level click listener above; only the
        // controls unique to this panel are wired here.
        const flToggle = e.target.closest('[data-fl-toggle]');
        if (flToggle) { _flToggleChild(flToggle.dataset.flToggle); return; }
        const flNav = e.target.closest('[data-fl-nav-key]');
        if (flNav) { _flNavCalendar(flNav.dataset.flNavKey, parseInt(flNav.dataset.flNavDelta, 10) || 0); return; }
        const flChangeDays = e.target.closest('[data-fl-change-days]');
        if (flChangeDays) { _flChangeDays(flChangeDays.dataset.flChangeDays); return; }
        if (e.target.closest('[data-ap-nav-search-clear]')) { apNavSearchClear(); return; }
    });

    // Family Lookup's search box, and the sidebar's own feature search —
    // the shell had no delegated 'input' listener before Family Lookup
    // added one; both live here rather than each adding a separate listener.
    document.addEventListener('input', e => {
        if (e.target.id === 'flSearchInput') _flHandleSearchInput(e.target.value);
        if (e.target.id === 'apNavSearchInput') apNavSearchInput(e.target.value);
    });

    document.addEventListener('change', e => {
        const check = e.target.closest('[data-ap-check]');
        if (check) {
            apState.done[check.dataset.apCheck] = check.checked;
            apSavePrefs();
            check.closest('.ap-check-row')?.classList.toggle('is-done', check.checked);
            return;
        }
        const scen = e.target.closest('[data-ap-scen]');
        if (scen) {
            const name = scen.dataset.apScen;
            const val  = parseFloat(scen.value);
            const num  = isNaN(val) ? 0 : val;
            if (name.startsWith('inc:')) apScenario.inc[name.slice(4)] = num;
            else apScenario[name] = num;
            apRenderScenario();
            return;
        }
        if (e.target.id === 'staffWeekOf' && apState.view === 'schedule') {
            _apTimeOff.loaded = false;
            apRenderScheduleTimeOff();
            apRenderStaffReq();
        }
    });

    // Daily Staffing Requirement inputs
    ['hours', 'floaters', 'wage', 'burden'].forEach(field => {
        document.getElementById('staffReq_' + field)?.addEventListener('input', e => {
            const v = parseFloat(e.target.value);
            apReqInputs[field] = isNaN(v) ? 0 : v;
            apRenderStaffReq();
        });
    });

    _apReady = true;
    apRender();
}
