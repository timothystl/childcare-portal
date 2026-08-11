// ============================================================
// MODULE: Admin Portal Shell  (design handoff — myMDO Admin Portal)
// ============================================================
// The redesign's information architecture, layered over the admin
// sections that already exist. Nothing here re-implements a tool: each
// `.admin-section` / `.table-section` in admin.html becomes one entry in
// AP_TOOLS, and the shell decides which one is on screen.
//
// Three levels of navigation, all client-side:
//   1. Dashboard  (layout 'dash', no tool open) — metrics + panels + attention
//   2. Hub        (layout 'list' | 'rail', no tool open) — index of the tab
//   3. Detail     (a tool is open) — that one section, with a back link
//
// Two tools are new and fully built here rather than mapped:
//   * Daily Staffing Requirement — ceil(registered children / ratio) per
//     room per day, from booked registrations only. Never clock-in data.
//   * Rate Increase Scenarios — annual revenue/labour/net projection off
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
    // ── Daily operations (reachable from the Director tab) ──
    { key: 'roster',      pane: 'daily',         section: 'dailyRosterSection',    tab: 'director', group: 'Daily Ops', tint: AP_TINT.green, icon: '📋', name: 'Classroom Roster',
      blurb: 'Who is in each room today, this week, or this month.' },
    { key: 'capOverview', pane: 'daily',         section: 'capacityOverviewSection', tab: 'director', group: 'Daily Ops', tint: AP_TINT.green, icon: '📆', name: 'Capacity Overview',
      blurb: 'Every room, every day of a month, against capacity.' },
    { key: 'roomSched',   pane: 'daily',         section: 'roomSchedSection',      tab: 'director', group: 'Daily Ops', tint: AP_TINT.green, icon: '📅', name: 'Room Schedule Planner',
      blurb: 'Move children between rooms day by day.' },
    { key: 'careCal',     pane: 'registrations', section: 'allRegistrationsSection', tab: 'director', group: 'Daily Ops', tint: AP_TINT.green, icon: '🗒️', name: 'Care Calendar',
      blurb: 'Every registration — search, filter, edit days, add a child.' },
    { key: 'missingCal',  pane: 'registrations', section: 'missingCalendarSection', tab: 'director', group: 'Daily Ops', tint: AP_TINT.green, icon: '⚠️', name: 'Missing Care Calendar',
      blurb: 'Active children with no registration for a month.' },
    { key: 'families',    pane: 'families',      section: 'familiesSection',       tab: 'director', group: 'Daily Ops', tint: AP_TINT.green, icon: '👨‍👩‍👧', name: 'Family Directory',
      blurb: 'Family and child records, PINs, discounts, imports.' },

    // ── Finance · Money In ──
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

    // ── Finance · Payroll ──
    // Historical Payroll Records is commented out in admin.html ("hidden
    // 2026-07, may bring back later") — same for New Family Enrollment,
    // Enrollment Forms, and Offer Email Links. They are not registered here;
    // uncomment the section and add an entry to bring the tool back.
    { key: 'payroll',     pane: 'staffing', section: 'payrollSection',       tab: 'finance', group: 'Payroll', tint: AP_TINT.sand, icon: '💵', name: 'Payroll',
      blurb: 'Hours, PTO, and pay for a bi-weekly period.' },

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

    // ── Planning · Family Communication ──
    { key: 'msgHistory',  pane: 'messages', section: 'messagesSection', tab: 'planning', group: 'Family Communication', tint: AP_TINT.gold, icon: '💬', name: 'Parent Messages',
      blurb: 'Everything families have sent through the portal.' },

    // ── Planning · Staffing Needs ──
    { key: 'schedule',    pane: 'staffing', section: 'staffScheduleSection', tab: 'planning', group: 'Staffing Needs', tint: AP_TINT.sand, icon: '🗓️', name: 'Build Staff Schedule',
      blurb: 'Assign staff to rooms and shifts for the week, against what the ratios require.' },
    { key: 'staffreq',    pane: 'staffing', section: 'staffReqSection',      tab: 'planning', group: 'Staffing Needs', tint: AP_TINT.tang, icon: '👥', name: 'Daily Staffing Requirement',
      blurb: 'Exactly how many staff each day needs, from the kids actually registered.' },

    // ── Planning · Your Team ──
    { key: 'staffRoster', pane: 'staffing', section: 'staffRosterSection',   tab: 'planning', group: 'Your Team', tint: AP_TINT.sand, icon: '👥', name: 'Staff Roster',
      blurb: 'Staff records, pay type, rooms, and availability.' },
    { key: 'staffDir',    pane: 'staffing', section: 'staffDirectorySection', tab: 'planning', group: 'Your Team', tint: AP_TINT.sand, icon: '🧑‍🏫', name: 'Staff Directory',
      blurb: 'Printable contact list for the team.' },
    { key: 'pto',         pane: 'staffing', section: 'ptoSection',           tab: 'planning', group: 'Your Team', tint: AP_TINT.sand, icon: '🏖️', name: 'PTO Settings',
      blurb: 'Accrual rules and starting balances.' },
    { key: 'geofence',    pane: 'staffing', section: 'geofenceSection',      tab: 'planning', group: 'Your Team', tint: AP_TINT.sand, icon: '📍', name: 'Geofence & Clock Reminders',
      blurb: 'Where the time clock will accept a punch, and when to nudge.' },

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

// The Director tab is a curated cross-tab shortlist, not a home for tools of
// its own — these keys point at entries that live under another tab.
const AP_DIRECTOR_GROUPS = [
    { label: 'Staffing',      keys: ['schedule', 'staffreq', 'ratios', 'capacity'] },
    { label: 'Who Is Coming', keys: ['planner', 'fte', 'seatDay', 'trends'] },
    { label: 'Filling Seats', keys: ['wlPlanner', 'wlDemand', 'wlNotify', 'wlImport', 'promotions'] },
    { label: 'Messages',      keys: ['msgHistory'] },
    { label: 'Billing',       keys: ['ar', 'procare', 'discount'] },
    { label: 'Day to Day',    keys: ['closedDays', 'regWindow'] },
    { label: 'Daily Ops',     keys: ['roster', 'capOverview', 'roomSched', 'careCal', 'missingCal', 'families'] },
];

const AP_TOOL_BY_KEY = Object.fromEntries(AP_TOOLS.map(t => [t.key, t]));

// ── Shell state ──────────────────────────────────────────────
const apState = {
    tab:    'director',
    view:   null,          // tool key, or null for dashboard/hub
    layout: 'dash',        // 'dash' | 'list' | 'rail'
    done:   {},            // dashboard done-flags, persisted
    live:   null,          // last loaded dashboard data
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
        apState.layout = localStorage.getItem('apLayout') || 'dash';
        apState.tab    = localStorage.getItem('apTab')    || 'director';
        apState.done   = JSON.parse(localStorage.getItem('apDone') || '{}') || {};
    } catch (_) { /* defaults stand */ }
    if (!AP_TABS[apState.tab]) apState.tab = 'director';
    if (!['dash', 'list', 'rail'].includes(apState.layout)) apState.layout = 'dash';
}

function apSavePrefs() {
    try {
        localStorage.setItem('apLayout', apState.layout);
        localStorage.setItem('apTab',    apState.tab);
        localStorage.setItem('apDone',   JSON.stringify(apState.done));
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
//   restricted — schedule planner, enrollment/waitlist, limited Settings.
//                No Finance and no Market Analysis at all. (This is slightly
//                tighter than before: Historical Payroll and Family Billing
//                Summary used to sit in the Staffing/Billing panes and were
//                reachable. They are financial data, the documented role says
//                "no Finance", and they now live under the Finance tab.)
//   staff      — Classrooms only
const AP_FULL_ONLY_TABS = ['finance', 'market'];

function apToolAvailable(tool) {
    const el = document.getElementById(tool.section);
    if (!el) return false;
    if (el.style.display === 'none') return false;
    const pane = document.getElementById('tab-' + tool.pane);
    if (pane && pane.style.display === 'none') return false;

    const role = typeof currentAdminRole !== 'undefined' ? currentAdminRole : 'full';
    if (role === 'staff') return tool.pane === 'daily';
    if (role !== 'full' && AP_FULL_ONLY_TABS.includes(tool.tab)) return false;
    return true;
}

function apGroupsForTab(tab) {
    const groups = [];
    if (tab === 'director') {
        AP_DIRECTOR_GROUPS.forEach(g => {
            const tools = g.keys.map(k => AP_TOOL_BY_KEY[k]).filter(t => t && apToolAvailable(t));
            if (tools.length) groups.push({ label: g.label, tools });
        });
    } else {
        AP_TOOLS.filter(t => t.tab === tab && apToolAvailable(t)).forEach(t => {
            let g = groups.find(x => x.label === t.group);
            if (!g) { g = { label: t.group, tools: [] }; groups.push(g); }
            g.tools.push(t);
        });
    }
    return groups;
}

function apTabAvailable(tab) {
    return apGroupsForTab(tab).length > 0;
}

// ── Navigation ───────────────────────────────────────────────
function apGo(key) {
    const tool = AP_TOOL_BY_KEY[key];
    if (!tool || !apToolAvailable(tool)) return;
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

function apSetLayout(layout) {
    apState.layout = layout;
    apSavePrefs();
    apRender();
}

function apBack() {
    apState.view = null;
    apSavePrefs();
    apRender();
    window.scrollTo(0, 0);
}

/** The tab a tool is filed under for the purpose of the back link + related chips. */
function apContextTab(tool) {
    const inDirector = apState.tab === 'director' &&
        AP_DIRECTOR_GROUPS.some(g => g.keys.includes(tool.key));
    return inDirector ? 'director' : tool.tab;
}

// ── Render ───────────────────────────────────────────────────
function apRender() {
    if (!_apReady) return;
    const page   = document.getElementById('apPage');
    const detail = document.getElementById('apDetail');
    const rail   = document.getElementById('apRail');
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

    // Layout toggle + tab chip
    document.querySelectorAll('#apLayoutToggle button').forEach(b =>
        b.classList.toggle('is-active', b.dataset.layout === apState.layout));
    const meta      = AP_TABS[apState.tab];
    const chipIcon  = document.getElementById('currentTabIcon');
    const chipLabel = document.getElementById('currentTabLabel');
    if (chipIcon)  chipIcon.textContent  = meta.icon;
    if (chipLabel) chipLabel.textContent = meta.label;

    // Menu drawer — rebuilt on every render so a role that cannot reach a
    // tab never sees an inert button for it.
    const navList = document.querySelector('.mobile-nav-list');
    if (navList) {
        navList.innerHTML = `
            <div class="mobile-nav-group-label">Go to</div>
            ${Object.keys(AP_TABS).filter(apTabAvailable).map(k => `
            <button class="mobile-nav-item${k === apState.tab ? ' active' : ''}" data-ap-tab="${k}">
                <span class="mni-icon">${AP_TABS[k].icon}</span><span>${escHtml(AP_TABS[k].label)}</span>
            </button>`).join('')}
            <div class="mobile-nav-group-label">Layout</div>
            <div class="ap-layout-toggle ap-drawer-toggle">
                ${[['dash', 'Dashboard'], ['list', 'List'], ['rail', 'Rail']].map(([k, label]) =>
                    `<button type="button" data-ap-layout="${k}"${apState.layout === k ? ' class="is-active"' : ''}>${label}</button>`).join('')}
            </div>`;
    }

    // Rail
    const showRail = apState.layout === 'rail';
    if (rail) {
        rail.classList.toggle('hidden', !showRail);
        if (showRail) apRenderRail(rail);
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
        if (apState.layout === 'dash') apRenderDashboard(page);
        else                           apRenderHub(page);
    }
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
        s.classList.toggle('ap-hidden-tool', !tool || s.id !== tool.section);
    });
}

function apRenderRail(rail) {
    const tabs = Object.keys(AP_TABS).filter(apTabAvailable).map(k => `
        <button class="ap-rail-tab${k === apState.tab ? ' is-active' : ''}" data-ap-tab="${k}">
            <span>${AP_TABS[k].icon}</span><span>${escHtml(AP_TABS[k].label)}</span>
        </button>`).join('');
    const groups = apGroupsForTab(apState.tab).map(g => `
        <div class="ap-rail-group">${escHtml(g.label)}</div>
        ${g.tools.map(t => `
            <button class="ap-rail-item${t.key === apState.view ? ' is-active' : ''}" data-ap-go="${t.key}">
                <span>${t.icon}</span><span>${escHtml(t.name)}</span>
            </button>`).join('')}`).join('');
    rail.innerHTML = `<div class="ap-rail-tabs">${tabs}</div>${groups}`;
}

function apRenderHub(page) {
    const meta   = AP_TABS[apState.tab];
    const groups = apGroupsForTab(apState.tab);
    const isList = apState.layout === 'list';
    const body   = groups.map(g => `
        <section class="ap-group">
            <div class="ap-group-head">
                <h3>${escHtml(g.label)}</h3>
                <div class="ap-group-rule"></div>
            </div>
            ${isList ? `
            <div class="ap-list">
                ${g.tools.map(t => `
                <button class="ap-list-row" data-ap-go="${t.key}">
                    <span class="ap-list-icon" style="background:${t.tint}">${t.icon}</span>
                    <span class="ap-list-name">${escHtml(t.name)}</span>
                    <span class="ap-list-blurb">${escHtml(t.blurb)}</span>
                    <span class="ap-list-arrow">→</span>
                </button>`).join('')}
            </div>` : `
            <div class="ap-tiles">
                ${g.tools.map(t => `
                <button class="ap-tile" data-ap-go="${t.key}">
                    <span class="ap-tile-icon" style="background:${t.tint}">${t.icon}</span>
                    <span class="ap-tile-name">${escHtml(t.name)}</span>
                    <span class="ap-tile-blurb">${escHtml(t.blurb)}</span>
                </button>`).join('')}
            </div>`}
        </section>`).join('');

    page.innerHTML = `
        <div class="ap-head">
            <div>
                <h2>${escHtml(meta.label)}</h2>
                <p>${escHtml(meta.blurb)}</p>
            </div>
        </div>
        ${body}`;
}

function apRenderDetail(tool) {
    const ctxTab   = apContextTab(tool);
    const backEl   = document.getElementById('apBack');
    if (backEl) backEl.textContent = `← All ${AP_TABS[ctxTab].label.toLowerCase()} tools`;

    apShowSection(tool);

    // Related: the rest of this tool's group, in whichever tab we came from.
    let related;
    if (ctxTab === 'director') {
        const g = AP_DIRECTOR_GROUPS.find(x => x.keys.includes(tool.key));
        related = (g ? g.keys : []).filter(k => k !== tool.key)
            .map(k => AP_TOOL_BY_KEY[k]).filter(t => t && apToolAvailable(t));
    } else {
        related = AP_TOOLS.filter(t =>
            t.tab === tool.tab && t.group === tool.group && t.key !== tool.key && apToolAvailable(t));
    }
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
        nextClosure: null,
    };

    const settled = await Promise.allSettled([
        typeof fetchTimeOffRequests === 'function' ? fetchTimeOffRequests({ sinceDate: weekDates[0] }) : [],
        typeof fetchWaitlistApplications === 'function' ? fetchWaitlistApplications() : [],
        typeof fetchMessages === 'function' ? fetchMessages(false) : [],
    ]);
    if (settled[0].status === 'fulfilled') {
        const rows = settled[0].value || [];
        live.pending = rows.filter(r => r.status === 'pending');
        live.timeOff = rows.filter(r => r.status === 'approved');
    }
    if (settled[1].status === 'fulfilled') {
        live.waitlist = (settled[1].value || []).filter(a => !a.archived_at &&
            a.status !== 'enrolled' && a.status !== 'declined' && a.status !== 'withdrawn');
    }
    if (settled[2].status === 'fulfilled') {
        live.unread = (settled[2].value || []).filter(m => !m.is_read && !m.is_archived).length;
    }

    // Billed this month — the same per-registration calculation the billing
    // tools use, summed over registrations that have a day in this month.
    const monthKey = new Date().toLocaleDateString('en-CA').slice(0, 7);
    const seen = new Set();
    (allRegistrations || []).forEach(reg => {
        const inMonth = (reg.registration_dates || []).some(d => !d.waitlisted && String(d.care_date).startsWith(monthKey));
        if (!inMonth) return;
        seen.add(`${(reg.parent_email || '').toLowerCase()}:${(reg.child_name || '').toLowerCase()}`);
        try { live.billed += calcRegistrationBill(reg); } catch (_) { /* rates not loaded yet */ }
    });
    live.billedKids = seen.size;

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
        apLoadLive().then(() => { if (!apState.view && apState.layout === 'dash') apRender(); })
                    .catch(err => {
                        console.error('apLoadLive:', err);
                        page.innerHTML = `<p class="empty-hint">Could not load the dashboard — ${escHtml(err.message || 'unknown error')}. Use the List or Rail layout to reach the tools directly.</p>`;
                    });
        return;
    }

    const groups    = apGroupsForTab(apState.tab);
    const toolCount = groups.reduce((a, g) => a + g.tools.length, 0);
    const meta      = AP_TABS[apState.tab];
    const builder   = {
        director: apDashDirector,
        finance:  apDashFinance,
        planning: apDashPlanning,
        market:   apDashSimple,
        settings: apDashSettings,
    }[apState.tab] || apDashSimple;
    const dash = builder(live);

    page.innerHTML = `
        <div class="ap-head">
            <div>
                <h2>${escHtml(meta.label)}</h2>
                <p>${escHtml(dash.stamp)}</p>
            </div>
            <button class="ap-ghost-btn" data-ap-layout="list">All ${toolCount} tools →</button>
        </div>
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
                <section class="ap-mini-panel is-inset">
                    <h3 class="ap-mini-title">Jump to</h3>
                    <div style="display:flex;flex-direction:column;gap:2px">
                        ${Object.keys(AP_TABS).filter(k => k !== apState.tab && apTabAvailable(k)).map(k => `
                        <button class="ap-jump" data-ap-tab="${k}"><span>${AP_TABS[k].icon}</span><span>${escHtml(AP_TABS[k].label)}</span></button>`).join('')}
                    </div>
                </section>
            </div>
        </div>`;
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

function apDashDirector(live) {
    const sf     = live.staffing;
    const peak   = Math.max(0, ...sf.classroom);
    const peakIx = sf.classroom.indexOf(peak);
    const peakDay = AP_DAYS[peakIx < 0 ? 0 : peakIx];
    const posted = !!apState.done['Schedule posted to staff'];
    const waiting = live.pending.map(r => (r.staff_name || '').split(' ')[0]).filter(Boolean);
    const byRoom  = apWaitlistByRoom(live);

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
            label: 'Billed this month', tone: 'warn', value: apMoney(live.billed),
            sub: `${live.billedKids} children registered`,
            check: 'Billing completed',
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

    const attention = [];
    if (peak > 0) attention.push({ icon: '👥', key: 'staffreq',
        text: `${peakDay} needs ${peak} staff on the floor — the heaviest day of the week.`, cta: 'Open Daily Staffing' });
    if (live.pending.length) attention.push({ icon: '🚫', key: 'schedule', urgent: true,
        text: `${live.pending.length} time-off request${live.pending.length > 1 ? 's are' : ' is'} waiting on your approval.`, cta: 'Review requests' });
    const edgeRooms = sf.rows.filter(r => r.cells[peakIx < 0 ? 0 : peakIx]?.atEdge);
    if (edgeRooms.length) attention.push({ icon: '⚖️', key: 'ratios',
        text: `${edgeRooms.map(r => r.label).join(', ')} sit${edgeRooms.length > 1 ? '' : 's'} exactly at ratio on ${peakDay} — one more child adds a staff member.`, cta: 'Open Ratios' });
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
    const sf = live.staffing;
    const rateRows = sf.rows.map(r => ({
        label: r.label,
        note:  `full day ${apMoney(r.room.fullDayRate || 0)}${r.room.fullDayOnly ? '' : ' · half day ' + apMoney(r.room.halfDayRate || 0)}`,
        value: `${r.cells.reduce((a, c) => a + c.kids, 0)} care days`,
    }));
    return {
        stamp: `${new Date().toLocaleDateString('en-US', { month: 'long', year: 'numeric' })} · figures from live registrations`,
        kpis: [
            { label: 'Billed this month', tone: 'navy', value: apMoney(live.billed), sub: 'from registered days and saved rates' },
            { label: 'Children billed',   tone: 'ok',   value: live.billedKids, sub: 'with at least one day this month' },
            { label: 'Care days booked',  tone: 'gold', value: sf.kids.reduce((a, b) => a + b, 0), sub: 'this week, all rooms' },
            { label: 'Rooms in use',      tone: 'navy', value: sf.rows.length, sub: 'with a child booked this week' },
        ],
        left: [
            apPanel({ title: 'Where the volume is', sub: 'Care days booked this week per room — what the tuition line is made of.',
                body: apRowsHtml(rateRows), tools: ['ar', 'famBilling', 'revdash'] }),
            apPanel({ title: 'How full each room is', sub: 'Average booked children per day against capacity.',
                body: apBarsHtml(apFillBars(sf)), tools: ['pnl', 'arrev', 'budget'] }),
        ],
        right: [],
        attention: [
            { icon: '📋', key: 'ar',       text: 'Accounts receivable has not been refreshed on this screen yet.', cta: 'Open Accounts Receivable' },
            { icon: '🧮', key: 'scenario', text: 'Model a rate change against real care-day volume before you commit.', cta: 'Open Rate Increase Scenarios' },
            { icon: '🎯', key: 'budget',   text: 'Check this year’s budget targets against the actuals.', cta: 'Open Annual Budget' },
        ],
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
    if (req.recurring && req.weekday != null) return `${AP_DAYS[req.weekday]}, every week`;
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
                    <button class="ap-ok-approve" data-ap-off-decide="${r.id}" data-verdict="approved"${_apTimeOff.busy === r.id ? ' disabled' : ''}>Approve</button>
                    <button class="ap-ok-deny"    data-ap-off-decide="${r.id}" data-verdict="declined"${_apTimeOff.busy === r.id ? ' disabled' : ''}>Not this week</button>
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

async function apDecideOff(id, verdict) {
    _apTimeOff.busy = Number(id);
    apDrawScheduleTimeOff();
    try {
        await decideTimeOffRequest(Number(id), verdict);
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
    const staffId = parseInt(document.getElementById('apOffStaff')?.value, 10);
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
        const staff = (typeof allStaffData !== 'undefined' ? allStaffData : []).find(s => s.id === staffId);
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
        await deleteTimeOffRequest(Number(id));
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

    // Layout toggle
    document.getElementById('apLayoutToggle')?.addEventListener('click', e => {
        const btn = e.target.closest('button[data-layout]');
        if (btn) apSetLayout(btn.dataset.layout);
    });

    document.getElementById('apBack')?.addEventListener('click', apBack);

    // One delegated handler for every navigation affordance the shell renders.
    document.addEventListener('click', e => {
        const go = e.target.closest('[data-ap-go]');
        if (go) { apGo(go.dataset.apGo); apCloseMenu(); return; }
        const tab = e.target.closest('[data-ap-tab]');
        if (tab) { apGoTab(tab.dataset.apTab); apCloseMenu(); return; }
        const lay = e.target.closest('[data-ap-layout]');
        if (lay) { apSetLayout(lay.dataset.apLayout); apCloseMenu(); return; }

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
