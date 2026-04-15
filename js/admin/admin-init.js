// ============================================================
// MODULE: Admin Init (dashboard initialization, billing helpers)
// ============================================================

// ============================================================
// DASHBOARD INIT
// ============================================================
let dashboardInitDone = false;
async function initDashboard() {
    if (dashboardInitDone) return;
    dashboardInitDone = true;
    populateRoomFilter();
    populateRosterRoomFilter();
    populateWlRoomFilter();
    try {
        await Promise.all([
            loadRegistrations(),
            loadClosureList(),
            loadRateSettings(),
            loadRatioSettings(),
            loadSummerCampSetting(),
            loadOfferLinks().then(v => { window._globalOfferLinks = v; }),
        ]);
    } catch (err) {
        console.error('initDashboard: initial data load failed —', err);
        // Continue setup so the tab structure is always rendered
    }
    initCapacityMonthNav();
    renderCapacityOverview();
    setupFilters();
    setupRoster();
    setupClosures();
    setupMonthlyRoster();
    setupAttendanceRevenue();
    setupFamilyBilling();
    setupWindowOverride();
    setupFamilies();
    setupMessages();
    setupRoomCalendar();
    setupRates();
    setupRatios();
    setupSummerCamp();
    setupEnrollmentCapacity();
    setupEnrollmentForms();
    setupOfferLinks();
    setupStaffScheduling();
    setupStaffRoster();
    setupHoursEntry();
    setupScheduleTimes();
    setupAutoClockoutLog();
    setupPayrollReport();
    setupExtraReports();
    setupWaitlistAdmin();
    setupAdminRoles();
    setupClockEnforcement();
    setupFinanceDashboard();
    setupTabs();
    setupCollapsibles();
    document.getElementById('refreshBtn').addEventListener('click', () => {
        const active = localStorage.getItem('adminActiveTab') || 'daily';
        if (active === 'registrations') loadRegistrations();
        else if (active === 'families')  loadFamilies();
        else if (active === 'messages')  loadMessages();
        else if (active === 'waitlist')  loadWaitlist();
        else if (active === 'staffing')  loadStaffList();
        else loadRegistrations(); // daily / settings / reports — fall back to registrations
    });
    document.getElementById('exportXlsxBtn').addEventListener('click', exportExcel);
}

function populateRoomFilter() {
    const sel = document.getElementById('roomFilter');
    ROOMS.forEach(r => {
        const opt = document.createElement('option');
        opt.value       = r.id;
        opt.textContent = r.label;
        sel.appendChild(opt);
    });
}

function populateRosterRoomFilter() {
    const sel = document.getElementById('rosterRoomFilter');
    ROOMS.forEach(r => {
        const opt = document.createElement('option');
        opt.value       = r.id;
        opt.textContent = r.label;
        sel.appendChild(opt);
    });
}

function populateWlRoomFilter() {
    // Insert ROOMS options before the static "TBD / Unborn" option
    const sel = document.getElementById('wlRoomFilter');
    if (!sel) return;
    const tbdOpt = sel.querySelector('option[value="tbd"]');
    ROOMS.forEach(r => {
        const opt = document.createElement('option');
        opt.value       = r.id;
        opt.textContent = r.label + (r.status === 'coming_soon' ? ' (Coming Soon)' : '');
        sel.insertBefore(opt, tbdOpt);
    });
}

// ============================================================
// BILLING HELPER
// ============================================================

// Applies an individual student discount (same logic as app.js effectiveRate)
function effectiveAdminRate(baseRate, discountType, discountValue) {
    if (!baseRate) return 0;
    if (discountType === 'staff') return 0;
    if (discountType === 'custom' && discountValue > 0)
        return Math.round(baseRate * (1 - discountValue / 100) * 100) / 100;
    return baseRate;
}

// Build a fast lookup: `${parentEmail}:${childName}` (lower-cased) → {type, value}
// Uses allFamiliesData if already loaded (populated by loadFamilies())
function buildDiscountMap() {
    const map = new Map();
    (allFamiliesData || []).forEach(f => {
        (f.students || []).forEach(s => {
            if (!s.discount_type || s.discount_type === 'none') return;
            const childKey = (s.child_name || '').toLowerCase();
            const disc = { type: s.discount_type, value: s.discount_value || 0 };
            // Index by both parent emails so registrations by either parent get the discount
            [f.parent_email, f.parent2_email].filter(Boolean).forEach(email => {
                map.set(`${email.toLowerCase()}:${childKey}`, disc);
            });
        });
    });
    return map;
}

// Cached discount map — rebuilt whenever families are loaded
let _discountMap = null;
function getDiscountMap() {
    if (!_discountMap) _discountMap = buildDiscountMap();
    return _discountMap;
}

function calcRegistrationBill(reg) {
    const room = ROOMS.find(r => r.id === reg.room_id);
    if (!room) return 0;
    const dmap  = getDiscountMap();
    const key   = `${(reg.parent_email || '').toLowerCase()}:${(reg.child_name || '').toLowerCase()}`;
    const disc  = dmap.get(key) || { type: 'none', value: 0 };
    return (reg.registration_dates || [])
        .filter(d => !d.waitlisted)
        .reduce((sum, d) => {
            const rate = d.day_type === 'half' ? (room.halfDayRate || 0) : (room.fullDayRate || 0);
            return sum + effectiveAdminRate(rate, disc.type, disc.value);
        }, 0);
}
