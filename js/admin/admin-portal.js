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
        blurb: "Everything financial, grouped by what you're trying to do. Pick a tool to open it — you'll land on just that tool, not the whole page.",
    },
    planning: {
        icon: '🗓️', label: 'Planning',
        blurb: "The waitlist and everything downstream of it — who's waiting, what's opening up, and how full we'll be.",
    },
    market: {
        icon: '📈', label: 'Market Analysis',
        blurb: 'How we compare to other providers on price, flexibility, and cost — and the provider set behind those numbers.',
    },
    settings: {
        icon: '⚙️', label: 'Settings',
        blurb: 'The rules the portal runs on. Change these rarely — most take effect immediately for parents.',
    },
};

// ── Tool registry ────────────────────────────────────────────
// `section` is the id of the existing DOM section the tool opens;
// `pane` is the legacy tab-pane that section lives inside (the shell has
// to un-hide the pane before it can show the section).
const AP_TOOLS = [
    // ── Classrooms · Today ──
    // First in the group on purpose: it is the office mirror of the teachers'
    // head count, and it is where a missing-child alert lights up for the
    // director at the same instant it hits every staff phone.
    { key: 'attBoard',    pane: 'daily',         section: 'attendanceBoardSection',  tab: 'classrooms', group: 'Today', tint: AP_TINT.green, icon: '🚸', name: 'Attendance Board',
      blurb: 'Live — every room, who is in, who is expected, staff present, ratio.' },
    { key: 'roster',      pane: 'daily',         section: 'dailyRosterSection',      tab: 'classrooms', group: 'Today', tint: AP_TINT.green, icon: '📋', name: 'Classroom Roster',
      blurb: 'Who is in each room today, this week, or this month.' },
    { key: 'capOverview', pane: 'daily',         section: 'capacityOverviewSection', tab: 'classrooms', group: 'Today', tint: AP_TINT.green, icon: '📆', name: 'Capacity Overview',
      blurb: 'Every room, every day of a month, against capacity.' },
    { key: 'roomSched',   pane: 'daily',         section: 'roomSchedSection',        tab: 'classrooms', group: 'Today', tint: AP_TINT.green, icon: '📅', name: 'Room Schedule Planner',
      blurb: 'Move children between rooms day by day.' },

    // ── Classrooms · Records ──
    { key: 'careCal',     pane: 'registrations', section: 'allRegistrationsSection', tab: 'classrooms', group: 'Records', tint: AP_TINT.green, icon: '🗒️', name: 'Care Calendar',
      blurb: 'Every registration — search, filter, edit days, add a child.' },
    { key: 'missingCal',  pane: 'registrations', section: 'missingCalendarSection',  tab: 'classrooms', group: 'Records', tint: AP_TINT.green, icon: '⚠️', name: 'Missing Care Calendar',
      blurb: 'Active children with no registration for a month.' },
    { key: 'families',    pane: 'families',      section: 'familiesSection',         tab: 'classrooms', group: 'Records', tint: AP_TINT.green, icon: '👨‍👩‍👧', name: 'Family Directory',
      blurb: 'Family and child records, PINs, discounts, imports.' },
    // Incidents sit under Classrooms because that is where they happen and who
    // reports them. Approval is what notifies the family, so a report waiting
    // here is a parent who has not been told yet.
    { key: 'incidents',   pane: 'daily',         section: 'incidentsSection',        tab: 'classrooms', group: 'Records', tint: AP_TINT.green, icon: '🩹', name: 'Incident Reports',
      blurb: 'Review what staff filed, then release it to the family.' },
    // Drills sit under Classrooms with the incidents: same shelf, same
    // inspector, and the count they record is a count of children.
    { key: 'drills',      pane: 'daily',         section: 'fireDrillsSection',       tab: 'classrooms', group: 'Records', tint: AP_TINT.tang, icon: '🔥', name: 'Fire Drills',
      blurb: 'Every drill run, who was in the building, and how long it took.' },
    { key: 'announce',    pane: 'daily',         section: 'announcementsSection',    tab: 'classrooms', group: 'Records', tint: AP_TINT.tang, icon: '📣', name: 'Announcements',
      blurb: 'Write once — closures, news, events — and see who gets it.' },
    // Separate from the Contact Us inbox: that is the public form, this is
    // families you already have. Teachers only see their own room's threads,
    // so the office is the only place the whole picture exists.
    { key: 'threads',     pane: 'families',      section: 'threadsSection',          tab: 'classrooms', group: 'Records', tint: AP_TINT.green, icon: '💬', name: 'Parent Messages',
      blurb: 'Conversations with enrolled families — reply as the office.' },

    // ── Finance · Money In ──
    // Invoices comes first: you create the bill before you chase it.
    { key: 'invoices',    pane: 'finance', section: 'invoicesSection',       tab: 'finance', group: 'Money In', tint: AP_TINT.gold, icon: '🧾', name: 'Invoices',
      blurb: "Draft, adjust, and issue this month's family invoices." },
    { key: 'ar',          pane: 'finance', section: 'billingArSection',      tab: 'finance', group: 'Money In', tint: AP_TINT.gold, icon: '📋', name: 'Accounts Receivable',
      blurb: 'Payment status per family for a month — overdue, partial, paid.' },
    { key: 'procare',     pane: 'finance', section: 'billingPaymentsSection', tab: 'finance', group: 'Money In', tint: AP_TINT.gold, icon: '📂', name: 'ProCare Import',
      blurb: 'Upload a ProCare transaction export and review the aging report.' },
    { key: 'revdash',     pane: 'finance', section: 'billingDashSection',    tab: 'finance', group: 'Money In', tint: AP_TINT.gold, icon: '📊', name: 'Revenue Dashboard',
      blurb: 'Collection rate, YTD trends, and scholarship summary.' },
    { key: 'discount',    pane: 'finance', section: 'discountPricingSection', tab: 'finance', group: 'Money In', tint: AP_TINT.gold, icon: '🏷️', name: 'Kids Discount Pricing',
      blurb: 'Children on a staff or custom discount, with days and price tag.' },
    { key: 'famBilling',  pane: 'reports', section: 'familyBillingSection',  tab: 'finance', group: 'Money In', tint: AP_TINT.gold, icon: '👨‍👩‍👧', name: 'Family Billing Summary',
      blurb: 'Per-family totals for a month, ready to invoice.' },

    // ── Finance · How We're Doing ──
    { key: 'dash',        pane: 'finance', section: 'financeDashSection',    tab: 'finance', group: "How We're Doing", tint: AP_TINT.green, icon: '💰', name: 'Financial Dashboard',
      blurb: 'Year-to-date revenue, labor, and margin with monthly charts.' },
    { key: 'yoy',         pane: 'finance', section: 'financeYoySection',     tab: 'finance', group: "How We're Doing", tint: AP_TINT.green, icon: '📈', name: 'Year-over-Year',
      blurb: 'Revenue and labor month-by-month against the prior year.' },
    { key: 'pnl',         pane: 'finance', section: 'roomPnlSection',        tab: 'finance', group: "How We're Doing", tint: AP_TINT.green, icon: '🏫', name: 'Room Profitability (P&L)',
      blurb: 'Monthly revenue vs. labor cost per classroom.' },
    { key: 'arrev',       pane: 'finance', section: 'attendanceRevenueSection', tab: 'finance', group: "How We're Doing", tint: AP_TINT.green, icon: '📊', name: 'Attendance & Revenue',
      blurb: 'Monthly attendance and net revenue across all rooms.' },

    // ── Finance · Plan & Model ──
    { key: 'budget',      pane: 'finance', section: 'financeBudgetSection',  tab: 'finance', group: 'Plan & Model', tint: AP_TINT.tang, icon: '🎯', name: 'Annual Budget & Actuals',
      blurb: "Set yearly targets and record what you've actually spent." },
    { key: 'expense',     pane: 'finance', section: 'financeExpenseSection', tab: 'finance', group: 'Plan & Model', tint: AP_TINT.tang, icon: '📋', name: 'Expense Lines',
      blurb: 'Fixed monthly costs and annual one-time expenses.' },
    { key: 'model',       pane: 'finance', section: 'financeModelSection',   tab: 'finance', group: 'Plan & Model', tint: AP_TINT.tang, icon: '🔧', name: 'Rate & Wage Modeling',
      blurb: 'Project the impact of tuition and wage changes before you make them.' },
    { key: 'scenario',    pane: 'finance', section: 'rateScenarioSection',   tab: 'finance', group: 'Plan & Model', tint: AP_TINT.tang, icon: '🧮', name: 'Rate Increase Scenarios',
      blurb: 'What-if a rate, registration, or supply fee change — annual net, before you commit.' },
    { key: 'api',         pane: 'finance', section: 'financeApiTesterSection', tab: 'finance', group: 'Plan & Model', tint: AP_TINT.sand, icon: '🔌', name: 'ChMS Finance API',
      blurb: 'Test the connection the church accounting system uses.' },

    // Historical Payroll Records is commented out in admin.html ("hidden
    // 2026-07, may bring back later") — same for New Family Enrollment,
    // Enrollment Forms, and Offer Email Links. They are not registered here;
    // uncomment the section and add an entry to bring the tool back.

    // ── Finance · Food Program ──
    { key: 'cacfpMeal',   pane: 'cacfp', section: 'cacfpMealSection',   tab: 'finance', group: 'Food Program', tint: AP_TINT.gold, icon: '🍽️', name: 'Daily Meal Counts',
      blurb: 'Record meals served for the CACFP claim.' },
    { key: 'cacfpMenu',   pane: 'cacfp', section: 'cacfpMenuSection',   tab: 'finance', group: 'Food Program', tint: AP_TINT.gold, icon: '📋', name: 'Menu Planner',
      blurb: 'Plan compliant menus week by week.' },
    { key: 'cacfpIncome', pane: 'cacfp', section: 'cacfpIncomeSection', tab: 'finance', group: 'Food Program', tint: AP_TINT.gold, icon: '💵', name: 'Income Eligibility',
      blurb: 'Household eligibility forms and tiering.' },
    { key: 'cacfpClaims', pane: 'cacfp', section: 'cacfpClaimsSection', tab: 'finance', group: 'Food Program', tint: AP_TINT.gold, icon: '🧾', name: 'Monthly Claim',
      blurb: 'Assemble and export the monthly reimbursement claim.' },

    // ── Planning · Waitlist ──
    { key: 'wlPlanner',   pane: 'waitlist', section: 'waitlistPlannerSection', tab: 'planning', group: 'Waitlist', tint: AP_TINT.gold, icon: '🗂️', name: 'Waitlist & Capacity Planner',
      blurb: 'The queue, the grid, and the board — one shared allocation.' },
    { key: 'wlNotify',    pane: 'waitlist', section: 'wlNotifySection',       tab: 'planning', group: 'Waitlist', tint: AP_TINT.gold, icon: '📨', name: 'Waitlist Inquiries',
      blurb: 'Shareable inquiry link, notification email, and weekly reminders.' },
    { key: 'wlImport',    pane: 'waitlist', section: 'wlImportSection',       tab: 'planning', group: 'Waitlist', tint: AP_TINT.gold, icon: '📥', name: 'Import Waitlist from File',
      blurb: 'Bulk-import waitlist applications from CSV or Excel.' },
    { key: 'wlDemand',    pane: 'waitlist', section: 'waitlistDemandSection', tab: 'planning', group: 'Waitlist', tint: AP_TINT.gold, icon: '📊', name: 'Waitlist Demand by Month',
      blurb: 'Active applications by room and desired start month.' },

    // ── Planning · Enrollment Outlook ──
    { key: 'trends',      pane: 'waitlist', section: 'enrollmentTrendsSection', tab: 'planning', group: 'Enrollment Outlook', tint: AP_TINT.green, icon: '📈', name: 'Enrollment Trends',
      blurb: 'Month-by-month enrollment count per room.' },
    { key: 'fte',         pane: 'waitlist', section: 'enrollmentFteSection',   tab: 'planning', group: 'Enrollment Outlook', tint: AP_TINT.green, icon: '📊', name: 'Total Enrollment & FTE',
      blurb: 'Monthly headcount and full-time-equivalent enrollment per room.' },
    { key: 'seatDay',     pane: 'waitlist', section: 'seatDayCapacitySection', tab: 'planning', group: 'Enrollment Outlook', tint: AP_TINT.green, icon: '🪑', name: 'Seat-Day Capacity Model',
      blurb: 'Plans around occupied seats per day, not enrolled headcount.' },
    { key: 'forecast',    pane: 'waitlist', section: 'forecastSection',        tab: 'planning', group: 'Enrollment Outlook', tint: AP_TINT.green, icon: '📉', name: 'Demand Forecast',
      blurb: 'Projected demand per room from history and the waitlist.' },
    { key: 'ratioStep',   pane: 'waitlist', section: 'ratioStepSection',       tab: 'planning', group: 'Enrollment Outlook', tint: AP_TINT.green, icon: '⚖️', name: 'Ratio Step & Next Child',
      blurb: 'Where the next child tips a room into another staff member.' },
    { key: 'promotions',  pane: 'waitlist', section: 'promotionsSection',      tab: 'planning', group: 'Enrollment Outlook', tint: AP_TINT.green, icon: '🎂', name: 'Upcoming Room Promotions',
      blurb: 'Children aging out of their room in the next 2 years.' },
    { key: 'planner',     pane: 'waitlist', section: 'enrollmentPlannerSection', tab: 'planning', group: 'Enrollment Outlook', tint: AP_TINT.green, icon: '📅', name: 'Enrollment Planner',
      blurb: 'Cross-reference open capacity with waitlist demand.' },

    // ── Staff · Scheduling ──
    { key: 'schedule',    pane: 'staffing', section: 'staffScheduleSection',  tab: 'staff', group: 'Scheduling', tint: AP_TINT.sand, icon: '🗓️', name: 'Build Staff Schedule',
      blurb: 'Assign staff to rooms and shifts for the week, against what the ratios require.' },
    { key: 'staffreq',    pane: 'staffing', section: 'staffReqSection',       tab: 'staff', group: 'Scheduling', tint: AP_TINT.tang, icon: '👥', name: 'Daily Staffing Requirement',
      blurb: 'Exactly how many staff each day needs, from the kids actually registered.' },

    // ── Staff · Your Team ──
    { key: 'staffRoster', pane: 'staffing', section: 'staffRosterSection',    tab: 'staff', group: 'Your Team', tint: AP_TINT.sand, icon: '🧑‍🏫', name: 'Staff Roster',
      blurb: 'Staff records, pay type, rooms, and availability.' },
    { key: 'staffDir',    pane: 'staffing', section: 'staffDirectorySection', tab: 'staff', group: 'Your Team', tint: AP_TINT.sand, icon: '📇', name: 'Staff Directory',
      blurb: 'Printable contact list for the team.' },

    // ── Staff · Pay & Policy ──
    // Payroll is money but it is about people, and everything it needs
    // (hours, PTO balances, pay type) lives in the Staff tools. It keeps
    // its full-role gate via AP_FULL_ONLY_KEYS even though the tab is open
    // to `restricted`.
    { key: 'payroll',     pane: 'staffing', section: 'payrollSection',        tab: 'staff', group: 'Pay & Policy', tint: AP_TINT.sand, icon: '💵', name: 'Payroll',
      blurb: 'Hours, PTO, and pay for a bi-weekly period.' },
    { key: 'pto',         pane: 'staffing', section: 'ptoSection',            tab: 'staff', group: 'Pay & Policy', tint: AP_TINT.sand, icon: '🏖️', name: 'PTO Settings',
      blurb: 'Accrual rules and starting balances.' },
    { key: 'geofence',    pane: 'staffing', section: 'geofenceSection',       tab: 'staff', group: 'Pay & Policy', tint: AP_TINT.sand, icon: '📍', name: 'Geofence & Clock Reminders',
      blurb: 'Where the time clock will accept a punch, and when to nudge.' },
    // ⚠️ Under Staff, not Classrooms, and gated to `full` below. An injury
    // report names an employee, their body and their medical treatment — it
    // belongs with pay data, not with the child incident queue.
    { key: 'staffInjury', pane: 'staffing', section: 'staffInjuriesSection',  tab: 'staff', group: 'Pay & Policy', tint: AP_TINT.tang, icon: '🚑', name: 'Staff Injury Reports',
      blurb: "Work injuries staff filed, and the 30-day clock on the carrier's First Report." },
    // Full-role only as well: it names who clocked in from whose phone, which
    // is an HR conversation before it is anything else.
    { key: 'clockIntegrity', pane: 'staffing', section: 'clockIntegritySection', tab: 'staff', group: 'Pay & Policy', tint: AP_TINT.tang, icon: '📱', name: 'Clock-In Integrity',
      blurb: 'Whether the geofence is recording anything, and whether two staff share a phone.' },

    // ── Planning · Family Communication ──
    { key: 'msgHistory',  pane: 'messages', section: 'messagesSection', tab: 'planning', group: 'Family Communication', tint: AP_TINT.gold, icon: '💬', name: 'Parent Messages',
      blurb: 'Everything families have sent through the portal.' },

    // ── Market Analysis ──
    { key: 'mktPos',      pane: 'market', section: 'marketOverviewSection',  tab: 'market', group: 'Where We Stand', tint: AP_TINT.green, icon: '📈', name: 'Market Position',
      blurb: 'Flexibility vs. age range served, provider by provider.' },
    { key: 'mktPricing',  pane: 'market', section: 'marketPricingSection',   tab: 'market', group: 'Where We Stand', tint: AP_TINT.green, icon: '💲', name: 'Pricing Landscape',
      blurb: 'Weekly-equivalent rates and registration fees across providers.' },
    { key: 'mktCost',     pane: 'market', section: 'marketCostSection',      tab: 'market', group: 'Where We Stand', tint: AP_TINT.green, icon: '💵', name: 'Cost & Wage Context',
      blurb: 'Why infant care and staff pay are priced the way they are.' },
    { key: 'mktProviders', pane: 'market', section: 'marketProvidersSection', tab: 'market', group: 'The Field', tint: AP_TINT.sand, icon: '🏫', name: 'Comparable Providers',
      blurb: 'The full comparable set — edit a row or add a provider.' },

    // ── Settings ──
    { key: 'regWindow',   pane: 'settings', section: 'regWindowSection',     tab: 'settings', group: 'Registration', tint: AP_TINT.gold, icon: '🔓', name: 'Registration Window',
      blurb: 'Force the registration window open or closed.' },
    { key: 'closedDays',  pane: 'settings', section: 'closedDaysSection',    tab: 'settings', group: 'Registration', tint: AP_TINT.gold, icon: '🚫', name: 'Closed Days',
      blurb: 'Block dates so they show as unavailable to parents.' },
    { key: 'summerCamp',  pane: 'settings', section: 'summerCampSection',    tab: 'settings', group: 'Registration', tint: AP_TINT.gold, icon: '☀️', name: 'Summer Camp',
      blurb: 'Show or hide Summer Camp in the parent portal.' },
    { key: 'rates',       pane: 'settings', section: 'ratesSection',         tab: 'settings', group: 'Rooms & Rates', tint: AP_TINT.green, icon: '⚙️', name: 'Room Rates & Fees',
      blurb: 'Daily and weekly rates, age ranges, and one-time fees.' },
    { key: 'ratios',      pane: 'settings', section: 'ratiosSection',        tab: 'settings', group: 'Rooms & Rates', tint: AP_TINT.green, icon: '👷', name: 'Staff-to-Child Ratios',
      blurb: 'Maximum children per staff member for each room.' },
    { key: 'capacity',    pane: 'settings', section: 'capacitySection',      tab: 'settings', group: 'Rooms & Rates', tint: AP_TINT.green, icon: '🏫', name: 'Classroom Capacity',
      blurb: 'Maximum enrolled children per room per day.' },
    { key: 'adminRoles',  pane: 'settings', section: 'adminRolesSection',    tab: 'settings', group: 'Access & Oversight', tint: AP_TINT.tang, icon: '🔐', name: 'Admin Access',
      blurb: 'Admin login accounts and their access levels.' },
    { key: 'auditLog',    pane: 'settings', section: 'auditLogSection',      tab: 'settings', group: 'Access & Oversight', tint: AP_TINT.tang, icon: '🧾', name: 'Admin Audit Log',
      blurb: 'Who changed what, recorded automatically and unerasable.' },
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
 */
function apStaffing(weekDates) {
    const rooms = getSortedRooms().filter(r => !r.hidden);
    const rows  = rooms.map(room => {
        const ratio = room.staffRatio || 10;
        const cells = weekDates.map(date => {
            const closed = allClosureDates.has(date);
            let kids = 0;
            if (!closed) {
                (allRegistrations || []).forEach(reg => {
                    if (reg.room_id !== room.id) return;
                    (reg.registration_dates || []).forEach(d => {
                        if (!d.waitlisted && d.care_date === date) kids++;
                    });
                });
            }
            const staff = kids > 0 ? Math.ceil(kids / ratio) : 0;
            return {
                kids, staff, closed,
                // "at ratio" — one more child adds another staff member
                atEdge: kids > 0 && kids % ratio === 0,
            };
        });
        return { room, label: room.label, ratio, ratioLabel: `1 : ${ratio}`, cells };
    }).filter(r => r.cells.some(c => c.kids > 0));

    const classroom = weekDates.map((_, i) => rows.reduce((a, r) => a + r.cells[i].staff, 0));
    const kids      = weekDates.map((_, i) => rows.reduce((a, r) => a + r.cells[i].kids, 0));
    const closed    = weekDates.map(d => allClosureDates.has(d));
    return { rows, classroom, kids, closed, weekDates };
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
// people, but it is still pay data.
// staffInjury for the same reason as payroll but more so: the report names an
// employee, the part of their body, and where they were treated. A `restricted`
// admin who plans schedules has no business reading it.
const AP_FULL_ONLY_KEYS = ['payroll', 'staffInjury', 'clockIntegrity'];

function apToolAvailable(tool) {
    const el = document.getElementById(tool.section);
    if (!el) return false;
    if (el.style.display === 'none') return false;
    const pane = document.getElementById('tab-' + tool.pane);
    if (pane && pane.style.display === 'none') return false;

    const role = typeof currentAdminRole !== 'undefined' ? currentAdminRole : 'full';
    if (role === 'staff') return tool.tab === 'classrooms' && tool.pane === 'daily';
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
    const tool = apState.view ? AP_TOOL_BY_KEY[apState.view] : null;
    if (apState.view && (!tool || !apToolAvailable(tool))) apState.view = null;

    const meta      = AP_TABS[apState.tab];
    const chipIcon  = document.getElementById('currentTabIcon');
    const chipLabel = document.getElementById('currentTabLabel');
    if (chipIcon)  chipIcon.textContent  = meta.icon;
    if (chipLabel) chipLabel.textContent = meta.label;

    // Menu drawer — rebuilt on every render so a role that cannot reach a
    // tab never sees an inert button for it.
    const navList = document.querySelector('.mobile-nav-list');
    if (navList) navList.innerHTML = apNavHtml('mobile');

    // The sidebar is permanent chrome, on the dashboard and inside a tool.
    const nav = document.getElementById('apNav');
    if (nav) nav.innerHTML = apNavHtml('side');

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
 * The tool index. Rendered twice with the same content: as the permanent
 * desktop sidebar, and inside the hamburger drawer below 900px.
 */
function apNavHtml(where) {
    const tabCls  = where === 'mobile' ? 'mobile-nav-item' : 'ap-nav-tab';
    const groupCls = where === 'mobile' ? 'mobile-nav-group-label' : 'ap-nav-group';
    const itemCls = where === 'mobile' ? 'mobile-nav-item' : 'ap-nav-item';

    const tabs = Object.keys(AP_TABS).filter(apTabAvailable).map(k => `
        <button class="${tabCls}${k === apState.tab ? ' active is-active' : ''}" data-ap-tab="${k}">
            <span class="${where === 'mobile' ? 'mni-icon' : ''}">${AP_TABS[k].icon}</span><span>${escHtml(AP_TABS[k].label)}</span>
        </button>`).join('');

    const groups = apGroupsForTab(apState.tab);
    const body = groups.length
        ? groups.map(g => `
            <div class="${groupCls}">${escHtml(g.label)}</div>
            ${g.tools.map(t => `
            <button class="${itemCls}${t.key === apState.view ? ' active is-active' : ''}" data-ap-go="${t.key}">
                <span class="${where === 'mobile' ? 'mni-icon' : ''}">${t.icon}</span><span>${escHtml(t.name)}</span>
            </button>`).join('')}`).join('')
        // Director is the one tab with no tools of its own — say so rather
        // than leaving a bare gap under it.
        : `<p class="ap-nav-note">${apState.tab === 'director'
              ? 'Director is an overview. Every tool lives under its own tab — links on the dashboard take you straight there.'
              : 'No tools here for your access level.'}</p>`;

    return `<div class="ap-nav-tabs">${tabs}</div>${body}`;
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

        // The shell now renders the tool's name above the card, so the
        // section's own <h2> is a duplicate — but only hide it when it is
        // inert text. Several carry controls inside the heading (Care
        // Calendar's "New Registration" button, the collapse chevron),
        // and those must stay reachable.
        const h2 = s.querySelector(':scope > h2');
        if (h2) h2.classList.toggle('ap-dup-head',
            open && !h2.querySelector('button, input, select, a'));
    });
}

function apRenderDetail(tool) {
    // No back link: the sidebar keeps its place and highlights where you
    // are, which is the way back. A heading instead, so a tool page starts
    // at the same left edge as a dashboard heading and nothing shifts.
    const head = document.getElementById('apDetailHead');
    if (head) {
        head.innerHTML = `
            <div class="ap-head">
                <div>
                    <h2>${tool.icon} ${escHtml(tool.name)}</h2>
                    <p>${escHtml(tool.blurb)}</p>
                </div>
            </div>`;
    }

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
            case 'staffDir':
                if (typeof allStaffData !== 'undefined' && !allStaffData.length) loadStaffList();
                break;
            case 'msgHistory':
                if (typeof loadMessages === 'function') loadMessages();
                break;
            case 'auditLog':
                if (typeof loadAuditLogTab === 'function') loadAuditLogTab();
                break;
            case 'wlPlanner':
            case 'wlDemand':
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
        if (tool.key === 'ar' && typeof setupBillingDashYear === 'function' && !window._apArInit) {
            window._apArInit = true; setupBillingDashYear();
        }
        if (tool.key === 'invoices' && typeof renderInvoicesTool === 'function') renderInvoicesTool();
        if (tool.key === 'attBoard' && typeof renderAttendanceBoard === 'function') renderAttendanceBoard();
        if (tool.key === 'announce' && typeof renderAnnouncementsTool === 'function') renderAnnouncementsTool();
        if (tool.key === 'incidents' && typeof renderIncidentsTool === 'function') renderIncidentsTool();
        if (tool.key === 'drills' && typeof renderFireDrillsTool === 'function') renderFireDrillsTool();
        if (tool.key === 'staffInjury' && typeof renderStaffInjuriesTool === 'function') renderStaffInjuriesTool();
        if (tool.key === 'clockIntegrity' && typeof renderClockIntegrityTool === 'function') renderClockIntegrityTool();
        if (tool.key === 'threads' && typeof renderThreadsTool === 'function') renderThreadsTool();
        if (tool.key === 'schedule')  apRenderScheduleTimeOff();
        if (tool.key === 'staffreq')  apRenderStaffReq();
        if (tool.key === 'scenario')  apRenderScenario();
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
        page.innerHTML = `
            <div class="ap-head"><div>
                <h2>${escHtml(AP_TABS[apState.tab].label)}</h2>
                <p>Loading today's figures…</p>
            </div></div>`;
        apLoadLive().then(() => { if (!apState.view) apRender(); })
                    .catch(err => {
                        console.error('apLoadLive:', err);
                        page.innerHTML = `<p class="empty-hint">Could not load the dashboard — ${escHtml(err.message || 'unknown error')}. The tools in the sidebar still work.</p>`;
                    });
        return;
    }

    const meta = AP_TABS[apState.tab];
    const builder = {
        director:   apDashDirector,
        classrooms: apDashClassrooms,
        staff:      apDashStaff,
        finance:    apDashFinance,
        planning:   apDashPlanning,
        market:     apDashMarket,
        settings:   apDashSettings,
    }[apState.tab] || apDashSimple;
    const dash = builder(live);

    page.innerHTML = `
        <div class="ap-head">
            <div>
                <h2>${escHtml(meta.label)}</h2>
                <p>${escHtml(dash.stamp)}</p>
            </div>
        </div>
        ${dash.needsYou && dash.needsYou.length ? apNeedsYouHtml(dash.needsYou) : ''}
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

function apPanel({ title, sub, tone, body, tools }) {
    return `
        <section class="ap-panel${tone ? ' tone-' + tone : ''}">
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
            <div class="ap-grid-cell${c.atEdge ? ' is-edge' : ''}">
                <div class="ap-grid-staff">${c.closed ? '—' : c.staff}</div>
                <div class="ap-grid-kids">${c.closed ? 'closed' : c.kids + ' kids'}</div>
            </div>`).join('')}
        </div>`).join('')}
        <p class="ap-grid-foot">A shaded cell is a room exactly at ratio that day — one more child adds another staff member. Built from booked registrations; clock-in room data is never used.</p>
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
            ...(live.unread ? { link: 'msgHistory', linkLabel: 'Open messages', linkIcon: '💬' } : {}),
        },
        {
            label: 'Seats open this week', tone: 'ok', value: seatsOpen,
            sub: `${live.waitlist.length} on the waitlist`,
        },
        {
            label: 'Billed this month', tone: sentThisMonth ? 'ok' : 'warn', value: apMoney(live.billed),
            sub: invSub,
            check: 'Billing completed',
            link: 'invoices', linkIcon: '🧾', linkLabel: 'Review and send',
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
        actions: [{ key: 'invoices', label: 'Review and send', primary: true }],
    });

    if (live.unread) needsYou.push({
        urgent: false, rail: AP_TONE.ok, icon: '✉️',
        title: `${live.unread} unread message${live.unread > 1 ? 's' : ''}`,
        pill: 'FROM FAMILIES',
        context: 'sent through the parent portal',
        actions: [{ key: 'msgHistory', label: 'Open', primary: true }],
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
            actions: [{ key: 'staffreq', label: 'Daily staffing', primary: false }],
        });
    }

    const attention = [];
    if (peak > 0) attention.push({ icon: '👥', key: 'staffreq',
        text: `${peakDay} needs ${peak} staff on the floor — the heaviest day of the week.`, cta: 'Open Daily Staffing' });
    if (live.pending.length) attention.push({ icon: '🚫', key: 'schedule', urgent: true,
        text: `${live.pending.length} time-off request${live.pending.length > 1 ? 's are' : ' is'} waiting on your approval.`, cta: 'Review requests' });
    const edgeRooms = edgeRoomsForQueue(sf, peakIx);
    if (edgeRooms.length) attention.push({ icon: '⚖️', key: 'ratios',
        text: `${edgeRooms.map(r => r.label).join(', ')} sit${edgeRooms.length > 1 ? '' : 's'} exactly at ratio on ${peakDay} — one more child adds a staff member.`, cta: 'Open Ratios' });
    if (inv.unsent) attention.push({ icon: '🧾', key: 'invoices', urgent: true,
        text: `${inv.unsent} invoice${inv.unsent === 1 ? ' is' : 's are'} drafted for this month but not marked sent.`, cta: 'Review and send invoices' });
    else if (!inv.drafted && live.billed > 0) attention.push({ icon: '🧾', key: 'invoices',
        text: `${apMoney(live.billed)} is billable this month but no invoices have been drafted.`, cta: 'Open invoices' });
    if (live.unread) attention.push({ icon: '✉️', key: 'msgHistory',
        text: `${live.unread} parent message${live.unread > 1 ? 's have' : ' has'} not been read.`, cta: 'Open Parent Messages' });
    if (live.nextClosure) attention.push({ icon: '🚫', key: 'closedDays',
        text: `Next closure is ${friendlyShort(live.nextClosure)} — ${live.closuresAhead} on the calendar ahead.`, cta: 'Open Closed Days' });
    else attention.push({ icon: '🚫', key: 'closedDays',
        text: 'No closures are on the calendar ahead — check the holidays are blocked.', cta: 'Open Closed Days' });
    const infants = (byRoom.bear || 0) + (byRoom.bee || 0);
    if (infants) attention.push({ icon: '🍼', key: 'wlPlanner',
        text: `${infants} famil${infants > 1 ? 'ies are' : 'y is'} waiting on an infant seat.`, cta: 'Open Waitlist Planner' });

    return {
        stamp: `Week of ${friendlyShort(live.weekOf)} · registrations as booked`,
        needsYou,
        kpis,
        left: [
            apPanel({ title: 'Staff needed this week',
                sub: 'Each room, each day — from registered children and your saved ratios. Clock-in room data is never used.',
                body: apStaffGridHtml(sf), tools: ['staffreq', 'ratios'] }),
            apPanel({ title: 'How full each room is',
                sub: 'Average booked children per day against capacity.',
                body: apBarsHtml(apFillBars(sf)), tools: ['capacity', 'fte', 'seatDay'] }),
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

function apDashFinance(live) {
    const sf  = live.staffing;
    const inv = apInvoiceState(live);

    const rateRows = sf.rows.map(r => ({
        label: r.label,
        note:  `full day ${apMoney(r.room.fullDayRate || 0)}${r.room.fullDayOnly ? '' : ' · half day ' + apMoney(r.room.halfDayRate || 0)}`,
        value: `${r.cells.reduce((a, c) => a + c.kids, 0)} care days`,
    }));

    const kpis = [
        { label: 'Billed this month', tone: inv.sent ? 'ok' : 'warn', value: apMoney(live.billed),
          sub: inv.drafted ? `${inv.drafted} drafted, ${inv.sent ? inv.sent + ' sent' : 'none sent'}` : 'nothing drafted yet',
          link: 'invoices', linkIcon: '🧾', linkLabel: 'Review and send' },
        { label: 'Children billed', tone: 'ok', value: live.billedKids, sub: 'with at least one day this month' },
        { label: 'Care days booked', tone: 'gold', value: sf.kids.reduce((a, b) => a + b, 0), sub: 'this week, all rooms' },
    ];
    if (inv.drafted) kpis.push({ label: 'Invoiced value', tone: 'navy', value: apMoney(inv.total),
                                 sub: 'across drafted invoices' });

    const attention = [];
    if (inv.unsent) attention.push({ icon: '🧾', key: 'invoices', urgent: true,
        text: `${inv.unsent} invoice${inv.unsent === 1 ? '' : 's'} for this month ${inv.unsent === 1 ? 'is' : 'are'} drafted but not sent.`,
        cta: 'Review and send invoices' });
    else if (!inv.drafted && live.billed > 0) attention.push({ icon: '🧾', key: 'invoices', urgent: true,
        text: `${apMoney(live.billed)} is billable this month and no invoices are drafted.`, cta: 'Open invoices' });
    attention.push({ icon: '📋', key: 'ar',       text: 'Accounts receivable ages overdue from the date an invoice was sent.', cta: 'Open accounts receivable' });
    attention.push({ icon: '🧮', key: 'scenario', text: 'Model a rate change against real care-day volume before you commit.', cta: 'Open rate scenarios' });
    attention.push({ icon: '🎯', key: 'budget',   text: 'Check this year\u2019s budget targets against the actuals.', cta: 'Open annual budget' });

    return {
        stamp: `${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} · billed from care days actually booked`,
        kpis,
        left: [
            apPanel({ title: 'Where the volume is', sub: 'Care days booked this week per room — what the tuition line is made of.',
                body: apRowsHtml(rateRows), tools: ['invoices', 'ar', 'famBilling'] }),
            apPanel({ title: 'How full each room is', sub: 'Average booked children per day against capacity.',
                body: apBarsHtml(apFillBars(sf)), tools: ['pnl', 'arrev', 'budget'] }),
        ],
        right: [],
        attention,
    };
}

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
            apPanel({ title: 'Staff needed this week',
                sub: 'From registered children and saved ratios — no clock-in data involved.',
                body: apStaffGridHtml(sf), tools: ['staffreq', 'schedule'] }),
            apPanel({ title: 'Waitlist pressure by room',
                sub: 'Active applications against the seats actually open this week.',
                body: apRowsHtml(pressure), tools: ['wlPlanner', 'wlDemand', 'planner', 'promotions'] }),
        ],
        right: [],
        attention: [
            { icon: '👥', key: 'staffreq',   text: `The heaviest day this week needs ${peak} staff on the floor.`, cta: 'Open Daily Staffing' },
            { icon: '🎂', key: 'promotions', text: 'Check who ages up out of their room next — those days reopen.', cta: 'See Room Promotions' },
            { icon: '📊', key: 'wlDemand',   text: 'Waitlist demand by month shows where the real unmet demand sits.', cta: 'Open Waitlist Demand' },
        ],
    };
}

function apDashSettings(live) {
    const roles = window._adminRoles || {};
    const roleCount = Object.keys(roles).length;
    const restricted = Object.values(roles).filter(r => r !== 'full').length;
    return {
        stamp: 'Live configuration · changes apply immediately',
        kpis: [
            { label: 'Closed days ahead', tone: 'navy', value: live.closuresAhead || 0,
              sub: live.nextClosure ? `next: ${friendlyShort(live.nextClosure)}` : 'none scheduled' },
            { label: 'Admin accounts', tone: 'navy', value: roleCount || '—',
              sub: roleCount ? `${restricted} not full access` : 'open Admin Access to load' },
            { label: 'Rooms configured', tone: 'ok', value: getSortedRooms().filter(r => !r.hidden).length, sub: 'with rates and ratios' },
        ],
        left: [
            apPanel({ title: 'Room configuration',
                sub: 'Capacity against the ratios everything else is calculated from.',
                body: apRowsHtml(getSortedRooms().filter(r => !r.hidden).map(r => ({
                    label: r.label,
                    note:  `cap ${r.capacity || '—'} · ratio 1:${r.staffRatio || '—'}`,
                    value: apMoney(r.fullDayRate || 0) + '/day',
                }))),
                tools: ['capacity', 'ratios', 'rates'] }),
        ],
        right: [],
        attention: [
            { icon: '🔐', key: 'adminRoles', text: 'Review who holds full access to the portal.', cta: 'Open Admin Access' },
            { icon: '🧾', key: 'auditLog',   text: 'The audit log records every significant admin action.', cta: 'Open Audit Log' },
            { icon: '🚫', key: 'closedDays', text: 'Blocked dates show as unavailable on the parent calendar.', cta: 'Open Closed Days' },
        ],
    };
}

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
        kpis.push({ label: 'Children on file', tone: 'ok', value: onFile,
                    sub: `${live.families.length} families` });
        if (missing) kpis.push({ label: 'No days this month', tone: 'gold', value: missing,
                                 sub: 'children with nothing booked',
                                 link: 'missingCal', linkIcon: '⚠️', linkLabel: 'Review them' });
    }

    const attention = [];
    if (missing) attention.push({ icon: '📋', key: 'missingCal', urgent: true,
        text: `${missing} child${missing === 1 ? ' has' : 'ren have'} no booked day this month.`, cta: 'Open missing calendars' });
    if (atRatio.length) attention.push({ icon: '🏫', key: 'roomSched',
        text: `${atRatio.map(r => r.label).join(', ')} ${atRatio.length === 1 ? 'is' : 'are'} exactly at ratio — the next child adds a staff member.`, cta: 'Open room planner' });
    attention.push({ icon: '🗒️', key: 'careCal',
        text: 'Add a day, edit a calendar, or register a child from the care calendar.', cta: 'Open care calendar' });

    return {
        stamp: `${new Date(live.today + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' })} · ${hereToday} children expected`,
        kpis,
        left: [
            apPanel({ title: isToday ? "Today's roster by room" : "Monday's roster by room",
                sub: 'Headcount against capacity. A room at ratio needs another staff member before the next child.',
                body: apBarsHtml(bars), tools: ['roster', 'roomSched', 'capOverview'] }),
        ],
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
    attention.push({ icon: '📍', key: 'geofence',
        text: 'Check where the time clock accepts a punch and when staff get nudged.', cta: 'Open clock reminders' });

    return {
        stamp: `Week of ${friendlyShort(live.weekOf)} · ${roster.length || 'no'} staff on the roster`,
        kpis,
        left: [
            apPanel({ title: 'Coverage against requirement',
                sub: 'What the saved schedule puts on the floor, against what the ratios ask for that day.',
                body: apBarsHtml(bars), tools: ['schedule', 'staffreq', 'staffRoster'] }),
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
                body: '', tools: ['mktProviders', 'mktPricing'] })],
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
                body: apBarsHtml(bars), tools: ['mktPricing', 'mktPos', 'mktProviders'] }),
        ],
        right: [],
        attention: [
            ...(us && gap < -3 ? [{ icon: '💲', key: 'scenario',
                text: `We are ${Math.abs(gap)}% under the market median with no rate change modeled.`, cta: 'Open rate scenarios' }] : []),
            { icon: '🏫', key: 'mktProviders', text: 'Keep the comparable set current — rates move.', cta: 'Review providers' },
            { icon: '💵', key: 'mktCost', text: 'Cost and wage context explains why infant care prices the way it does.', cta: 'Open cost context' },
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

function apRenderStaffReq() {
    const host = document.getElementById('staffReqBody');
    if (!host) return;
    const weekEl = document.getElementById('staffReqWeekOf');
    if (weekEl && !weekEl.value) weekEl.value = apWeekStart();
    const weekOf    = weekEl?.value || apWeekStart();
    const weekDates = apWeekDates(weekOf);
    const sf        = apStaffing(weekDates);

    const floaters = Number(apReqInputs.floaters) || 0;
    const total    = sf.classroom.map((n, i) => (sf.closed[i] ? 0 : n + floaters));
    const hrs      = total.map(n => n * (Number(apReqInputs.hours) || 0));
    const cost     = hrs.map(h => h * (Number(apReqInputs.wage) || 0) * (1 + (Number(apReqInputs.burden) || 0) / 100));
    const peak     = Math.max(0, ...total);
    const peakDay  = AP_DAYS[total.indexOf(peak)] || AP_DAYS[0];

    if (!sf.rows.length) {
        host.innerHTML = '<p class="empty-hint">No children are registered for this week yet — pick another week above.</p>';
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
                            <div class="ap-req-staff${c.atEdge ? ' is-edge' : ''}">${c.closed ? '—' : c.staff}</div>
                            <div class="ap-req-kids">${c.closed ? 'closed' : c.kids + ' kids'}</div>
                        </td>`).join('')}
                    </tr>`).join('')}
                </tbody>
                <tfoot>
                    ${footRow('Children registered',      sf.kids,                          'is-soft')}
                    ${footRow('Classroom staff required', sf.classroom,                     'is-strong')}
                    ${footRow('Floaters / break relief',  total.map((_, i) => sf.closed[i] ? 0 : floaters), 'is-soft')}
                    ${footRow('Total on the floor',       total,                            'is-total')}
                    ${footRow('Staff-hours',              hrs.map(h => Math.round(h)),      'is-soft')}
                    ${footRow('Est. labor cost',          cost.map(apMoney),                'is-strong')}
                </tfoot>
            </table>
        </div>
        <p style="color:var(--text-muted);font-size:.86em;margin-top:14px;max-width:76ch;text-wrap:pretty">
            Ratios come from Settings → Staff-to-Child Ratios. An orange count means the room is exactly at ratio that day — one more child adds another staff member.
        </p>`;
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

    const stats = document.getElementById('apSchedStats');
    if (stats) {
        const offCount = Object.keys(apApprovedOffForWeek(weekDates)).length;
        stats.innerHTML = `
            <div class="ap-stat">
                <div class="ap-stat-label">Needs your OK</div>
                <div class="ap-stat-value ${pending.length ? 'is-alert' : 'is-ok'}">${pending.length}</div>
            </div>
            <div class="ap-stat">
                <div class="ap-stat-label">Off this week</div>
                <div class="ap-stat-value">${offCount} staff</div>
            </div>
            <div class="ap-stat">
                <div class="ap-stat-label">Staff on roster</div>
                <div class="ap-stat-value">${staffList.length}</div>
            </div>`;
    }
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
        if (go) { apGo(go.dataset.apGo); apCloseMenu(); return; }
        const tab = e.target.closest('[data-ap-tab]');
        if (tab) { apGoTab(tab.dataset.apTab); apCloseMenu(); return; }
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
        if (e.target.closest('[data-ap-scen-reset]')) {
            apScenario.inc = {}; apScenario.regFee = 0; apScenario.supFee = 0; apScenario.wageAdd = 0;
            apRenderScenario();
        }
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
        if (e.target.id === 'staffReqWeekOf') { apRenderStaffReq(); return; }
        if (e.target.id === 'staffWeekOf' && apState.view === 'schedule') {
            _apTimeOff.loaded = false;
            apRenderScheduleTimeOff();
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

function apCloseMenu() {
    document.getElementById('mobileNavOverlay')?.classList.remove('open');
    document.getElementById('mobileMenuBtn')?.setAttribute('aria-expanded', 'false');
}
