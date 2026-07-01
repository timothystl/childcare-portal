// ============================================================
// MODULE: Admin Core (state, auth, inactivity, helpers, shared constants)
// ============================================================

// ============================================================
// STATE
// ============================================================
let currentAdminRole = 'full'; // 'full' | 'restricted' — set after login
let allRegistrations = [];
let allClosureDates  = new Set(); // YYYY-MM-DD strings
let tableSortState   = { col: 'submitted', dir: 'desc' }; // default: newest first
let familiesSortBy   = 'name'; // 'name' | 'room' | 'discount' | 'age_asc' | 'age_desc'
let familiesPage     = 0;
const FAMILIES_PAGE_SIZE = 20;

// ============================================================
// LOGIN  (Supabase Auth — server-validated)
// ============================================================
document.getElementById('loginBtn').addEventListener('click', attemptLogin);
document.getElementById('loginForm').addEventListener('submit', e => { e.preventDefault(); attemptLogin(); });

async function attemptLogin() {
    const email = document.getElementById('adminEmail').value.trim();
    const pwd   = document.getElementById('adminPassword').value;
    const errEl = document.getElementById('loginError');
    const btn   = document.getElementById('loginBtn');

    errEl.classList.add('hidden');
    btn.disabled    = true;
    btn.textContent = 'Signing in…';

    try {
        await loginAdmin(email, pwd);
        showDashboard();
    } catch (_) {
        errEl.textContent = 'Incorrect email or password.';
        errEl.classList.remove('hidden');
    } finally {
        btn.disabled    = false;
        btn.textContent = 'Login';
    }
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
    stopInactivityTimer();
    await logoutAdmin();
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('adminPassword').value = '';
    document.getElementById('adminEmail').value    = '';
    document.getElementById('loginError').classList.add('hidden');
});

// ============================================================
// INACTIVITY TIMEOUT
// ============================================================
const INACTIVITY_MS = 30 * 60 * 1000; // 30 minutes
let _inactivityTimer = null;

function _resetInactivityTimer() {
    clearTimeout(_inactivityTimer);
    _inactivityTimer = setTimeout(_signOutInactive, INACTIVITY_MS);
}

async function _signOutInactive() {
    stopInactivityTimer();
    await logoutAdmin();
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('adminPassword').value = '';
    document.getElementById('adminEmail').value    = '';
    const errEl = document.getElementById('loginError');
    errEl.textContent = 'You were signed out due to inactivity.';
    errEl.classList.remove('hidden');
    document.getElementById('loginScreen').classList.remove('hidden');
}

function startInactivityTimer() {
    ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(evt =>
        document.addEventListener(evt, _resetInactivityTimer, { passive: true })
    );
    _resetInactivityTimer();
}

function stopInactivityTimer() {
    clearTimeout(_inactivityTimer);
    ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'].forEach(evt =>
        document.removeEventListener(evt, _resetInactivityTimer)
    );
}

async function showDashboard() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    startInactivityTimer();
    await initDashboard();    // wait for full setup before applying restrictions
    await applySessionRole(); // runs on every login — fresh roles + restrictions
}

// Determine the current user's role, apply restrictions, update display.
// Called on every login so switching accounts always reflects correctly.
async function applySessionRole() {
    _resetRoleRestrictions();
    try {
        const [roles, session] = await Promise.all([loadAdminRoles(), getAdminSession()]);
        window._adminRoles   = roles;
        window._adminSession = session;
        const email    = (session?.user?.email || '').toLowerCase().trim();
        const hasRules = Object.keys(roles).length > 0;
        // Validate the configured role against the known set so a typo in the
        // admin_roles settings (e.g. "restriced") can't silently grant access.
        // Unknown/missing roles fall back to least privilege when rules exist.
        const validRoles = Object.keys(ROLE_LABELS); // ['full','restricted','staff']
        const assigned   = roles[email];
        if (assigned && !validRoles.includes(assigned)) {
            console.warn('Unknown admin role for', email, '->', assigned, '— defaulting to staff');
        }
        currentAdminRole = validRoles.includes(assigned)
            ? assigned
            : (hasRules ? 'staff' : 'full');
        // Show logged-in email + role in header
        const displayEl = document.getElementById('currentUserDisplay');
        if (displayEl) {
            displayEl.textContent = email
                ? `${email} · ${ROLE_LABELS[currentAdminRole] || currentAdminRole}`
                : '';
        }
    } catch (err) {
        console.error('applySessionRole failed:', err);
    }
    applyRoleRestrictions();
}

// Undo any restrictions from a previous session before applying new ones.
function _resetRoleRestrictions() {
    ['logHoursSection', 'payrollSection', 'staffRosterToggleWrap',
     'staffRosterSection', 'adminRolesSection',
     'closedDaysSection', 'ratesSection', 'ratiosSection', 'offerLinksSection', 'summerCampSection']
        .forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = '';
        });
    document.querySelectorAll('.mobile-nav-item')
        .forEach(item => { item.style.display = ''; });
}

// Auto-restore session if already logged in — wait for all scripts to load first
document.addEventListener('DOMContentLoaded', async () => {
    const session = await getAdminSession();
    if (session) showDashboard();
});

// ============================================================
// SHARED CONSTANTS
// ============================================================
// MONTH_NAMES is defined in supabase.js (loaded first) and shared globally.

// ============================================================
// HELPERS
// ============================================================
function csvCell(val) {
    const str = String(val ?? '');
    return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadFile(name, type, content) {
    const blob = new Blob([content], { type });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
}

function friendlyShort(dateStr) {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US',
        { month: 'short', day: 'numeric', year: 'numeric' });
}

