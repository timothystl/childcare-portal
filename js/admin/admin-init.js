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
    const versionBadge = document.getElementById('versionBadge');
    if (versionBadge) versionBadge.textContent = window.__BUILD_VERSION__ || 'dev';
    const mobileNavVersion = document.getElementById('mobileNavVersion');
    if (mobileNavVersion) mobileNavVersion.textContent = window.__BUILD_VERSION__ || 'dev';
    populateRoomFilter();
    populateRosterRoomFilter();
    try {
        await Promise.all([
            loadRegistrations(),
            loadClosureList(),
            loadRateSettings(),
            loadRatioSettings(),
            loadCapacitySettings(),
            loadSummerCampSetting(),
            loadOfferLinks().then(v => { window._globalOfferLinks = v; }),
            loadGeofenceSettings(),
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
    if (typeof apPushInit === 'function') apPushInit();
    setupAttendanceRevenue();
    setupFamilyBilling();
    setupMissingCalendarReport();
    setupWindowOverride();
    setupFamilies();
    setupMessages();
    setupRoomCalendar();
    setupRates();
    setupRegFee();
    setupPtoSettings();
    setupRatios();
    setupCapacity();
    setupStaffDirectory();
    setupSummerCamp();
    setupEnrollmentCapacity();
    setupEnrollmentForms();
    setupOfferLinks();
    setupStaffScheduling();
    setupStaffRoster();
    setupPayrollReport();
    setupHistoricalPayroll();
    setupExtraReports();
    setupWaitlistAdmin();
    setupAdminRoles();
    setupGeofence();
    setupFinanceDashboard();
    setupBilling();
    setupInvoices();
    setupAuditLog();
    setupTabs();
    setupCollapsibles();
}

function populateRoomFilter() {
    const sel = document.getElementById('roomFilter');
    getSortedRooms().forEach(r => {
        const opt = document.createElement('option');
        opt.value       = r.id;
        opt.textContent = r.label;
        sel.appendChild(opt);
    });
}

function populateRosterRoomFilter() {
    const sel = document.getElementById('rosterRoomFilter');
    getSortedRooms().forEach(r => {
        const opt = document.createElement('option');
        opt.value       = r.id;
        opt.textContent = r.label;
        sel.appendChild(opt);
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

// Build a lookup: parent email (lower-cased) → family id, for BOTH parents.
// Billing groups by family, not by the email that happened to submit the
// registration — otherwise two parents of one family register separately and
// look like two families, so their children never see the sibling discount.
function buildFamilyKeyMap() {
    const map = new Map();
    (allFamiliesData || []).forEach(f => {
        [f.parent_email, f.parent2_email].filter(Boolean).forEach(email => {
            map.set(email.toLowerCase().trim(), f.id);
        });
    });
    return map;
}

// Cached maps — rebuilt whenever families are loaded.
// Call sites all over the admin modules invalidate by assigning
// `_discountMap = null`, so _familyKeyMap deliberately rides the SAME signal
// (rebuilt inside getDiscountMap) rather than needing its own invalidation at
// nine separate call sites — one of which would inevitably be missed.
let _discountMap  = null;
let _familyKeyMap = null;

function getDiscountMap() {
    if (!_discountMap) {
        _discountMap  = buildDiscountMap();
        _familyKeyMap = buildFamilyKeyMap();
    }
    return _discountMap;
}

function getFamilyKeyMap() {
    getDiscountMap();   // ensures both maps are fresh
    return _familyKeyMap;
}

// Per-registration estimate for a single row in the registration list.
// ⚠️ NOT the billing source of truth — it is scoped to one registration, so it
// cannot apply the family-level sibling discount, and it ignores change fees
// and billing overrides. For any TOTAL, or anything that becomes an invoice,
// use _buildFamilyBillingData() in admin-reports.js instead.
function calcRegistrationBill(reg) {
    const room = ROOMS.find(r => r.id === reg.room_id);
    if (!room) return 0;
    const dmap  = getDiscountMap();
    const key   = `${(reg.parent_email || '').toLowerCase()}:${(reg.child_name || '').toLowerCase()}`;
    const disc  = dmap.get(key) || { type: 'none', value: 0 };
    return (reg.registration_dates || [])
        .filter(d => !d.waitlisted)
        .reduce((sum, d) => {
            const rate = (!room.fullDayOnly && d.day_type === 'half') ? (room.halfDayRate || 0) : (room.fullDayRate || 0);
            return sum + effectiveAdminRate(rate, disc.type, disc.value);
        }, 0);
}
