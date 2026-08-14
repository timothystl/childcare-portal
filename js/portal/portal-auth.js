// ============================================================
// portal-auth — parent portal sign-in
// ============================================================
// The first page of the parent portal, and for now the only one. It exists
// ahead of the rest of Phase 1 on purpose: Option B changed what a parent
// login PRODUCES (a real Supabase session, not a data payload), and that round
// trip had never been run against the live project. Everything the portal
// builds later — photos, daily logs, incident reports — gets its RLS policies
// written against this identity, so the identity gets proven first.
//
// Two things live here:
//   1. The sign-in itself, which is what parents will use.
//   2. An isolation check, hidden behind ?check=1, which asserts that a signed-in
//      parent is denied on every admin table. That is the acceptance test from
//      PARENT_PORTAL_PLAN.md §3.1, run as the real role rather than reasoned
//      about from the catalog.

// Tables a parent must never reach. Read as "expect nothing back": either
// permission denied, or RLS silently filters every row. Both are passes — the
// distinction is a grant-vs-policy detail, and what matters is that no data
// comes out.
//
// ⚠️ Two of these change meaning later. Phase 4 gives parents scoped read on
// their OWN billing_invoices, and Phase 1 does the same for attendance_records.
// When that happens the row moves from "expect nothing" to "expect only mine" —
// move it out of this list and give it a real ownership assertion. Leaving it
// here would turn a correct policy into a red X and train you to ignore the
// panel, which is worse than not having one.
const PORTAL_FORBIDDEN = [
    'staff',
    'staff_hours',
    'staff_clock_events',
    'billing_invoices',
    'admin_audit_log',
    'attendance_records',
    'parent_accounts',   // the mapping that decides which family you are
    'settings',          // admin_roles, wages, budgets live here
];

let portalContext = null;

function pEl(id) { return document.getElementById(id); }

function portalShowError(msg) {
    const box = pEl('portalError');
    if (!box) return;
    box.textContent = msg;
    box.classList.remove('hidden');
}

function portalClearError() {
    pEl('portalError')?.classList.add('hidden');
}

// The PIN lockout is real and counts failures, so the messages have to be
// honest about how much room is left rather than saying "try again" eight times
// and then locking the family out with no warning.
function portalErrorText(res) {
    switch (res.error) {
        case 'login_locked':
            return 'This account is locked after too many incorrect PINs. Contact the office to unlock it.';
        case 'not_found':
        case 'invalid_pin':
        case 'invalid_credentials':
            return typeof res.attempts_left === 'number'
                ? `That email and PIN don't match. ${res.attempts_left} ${res.attempts_left === 1 ? 'attempt' : 'attempts'} left before the account locks.`
                : "That email and PIN don't match our records.";
        case 'unavailable':
            return 'Cannot reach the server. Check your connection and try again.';
        default:
            return 'Something went wrong signing in. Please try again, or contact the office.';
    }
}

async function portalSignIn() {
    portalClearError();
    const email = (pEl('portalEmail')?.value || '').trim();
    const pin   = (pEl('portalPin')?.value || '').trim();

    if (!email || !/^\d{4,8}$/.test(pin)) {
        portalShowError('Enter your email address and your PIN.');
        return;
    }

    const btn = pEl('portalSignInBtn');
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Signing in…'; }

    try {
        const res = await parentPortalLogin(email, pin);
        if (res.error) {
            portalShowError(portalErrorText(res));
            return;
        }
        await portalShowSignedIn();
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = label; }
    }
}

async function portalSignOut() {
    await parentPortalLogout();
    portalContext = null;
    pEl('portalSignedIn')?.classList.add('hidden');
    pEl('portalSignIn')?.classList.remove('hidden');
    document.body.classList.remove('portal-app-open');
    const pin = pEl('portalPin');
    if (pin) pin.value = '';
}

// Reads identity from my_parent_context() rather than from the login response,
// so what renders is what the DATABASE says about the session — the same source
// every RLS policy will use. If these disagree, the session is the problem and
// this page should say so.
async function portalLoadContext() {
    const { data, error } = await sbClient.rpc('my_parent_context');
    if (error) {
        console.warn('my_parent_context:', error);
        return null;
    }
    return data && data !== 'null' ? data : null;
}

async function portalShowSignedIn() {
    portalContext = await portalLoadContext();

    pEl('portalSignIn')?.classList.add('hidden');
    pEl('portalSignedIn')?.classList.remove('hidden');
    // The body stops being the sign-in page's centering wrapper — see
    // .portal-app-open in portal.css. Without this the shell sits inside 24px
    // of padding and the page scrolls a little on iOS, tab bar and all.
    document.body.classList.add('portal-app-open');

    const name = portalContext?.parent_name || portalContext?.family_name || 'there';
    const greet = pEl('portalGreeting');
    if (greet) greet.textContent = `Hi, ${name}.`;

    const sub = pEl('portalGreetingSub');
    if (sub) {
        sub.textContent = portalContext
            ? "Here's how the day is going."
            : 'You are signed in, but the database did not recognize this session as a parent. Contact the office.';
    }

    // The feed is the point of the page. It loads after the greeting so the
    // parent sees who they are signed in as while it fetches, rather than a
    // blank card.
    if (portalContext && typeof ptLoadToday === 'function') {
        await ptLoadToday();
    }
    // Account tab identity.
    const acctName = pEl('ptAccountName');
    if (acctName) acctName.textContent = portalContext?.parent_name || '';
    const acctEmail = pEl('ptAccountEmail');
    if (acctEmail) acctEmail.textContent = portalContext?.parent_email || '';

    // ⚠️ pmInit only — NOT pmLoad. Messages moved behind their own tab, and
    // reading the thread marks it read. Loading it here would clear the unread
    // badge for a parent who never opened Messages. portal-nav loads it on
    // first open; pmUnreadCount only counts, and does not mark.
    if (portalContext && typeof pmInit === 'function') {
        pmInit();
        if (typeof pmUnreadCount === 'function' && typeof ptSetBadge === 'function') {
            pmUnreadCount().then(n => ptSetBadge('messages', n)).catch(() => {});
        }
    }

    // The tab shell last: every tab's content is in the DOM by now, so the
    // first render cannot flash an empty pane.
    if (typeof ptInitTabs === 'function') ptInitTabs();

    if (new URLSearchParams(location.search).get('check') === '1') {
        pEl('portalCheck')?.classList.remove('hidden');
        await portalRunChecks();
    }
}

// ── The isolation check ──────────────────────────────────────
// Deliberately not "does the portal work" — it is "can this session reach
// anything it shouldn't". A green row means a real parent token got nothing
// back from an admin table.
function portalCheckRow(label, pass, detail) {
    return `<li class="pchk ${pass ? 'pchk-ok' : 'pchk-fail'}">
        <span class="pchk-mark">${pass ? '✓' : '✕'}</span>
        <span class="pchk-label">${escapePortal(label)}</span>
        <span class="pchk-detail">${escapePortal(detail)}</span>
    </li>`;
}

function escapePortal(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

async function portalRunChecks() {
    const out = pEl('portalCheckList');
    if (!out) return;
    out.innerHTML = '<li class="pchk">Running…</li>';

    const rows = [];

    // Session shape. A parent must be `authenticated` — that is the whole
    // premise of Option B, and it is only safe because every admin table is
    // scoped to is_admin().
    const { data: sessionData } = await sbClient.auth.getSession();
    const token = sessionData?.session?.access_token;
    let claims = null;
    try {
        claims = JSON.parse(atob(token.split('.')[1]));
    } catch (_) { /* leave null; reported below */ }

    rows.push(portalCheckRow(
        'Session is a real Supabase token',
        !!claims,
        claims ? `role: ${claims.role}` : 'no readable token',
    ));
    rows.push(portalCheckRow(
        'Database sees a parent identity',
        !!portalContext?.family_id,
        portalContext?.family_id ? `family ${String(portalContext.family_id).slice(0, 8)}…` : 'my_parent_context() returned null',
    ));

    // Every admin table, in turn.
    for (const table of PORTAL_FORBIDDEN) {
        const { data, error } = await sbClient.from(table).select('*').limit(1);
        // Denied outright, or allowed through but filtered to nothing. Either
        // way no data escaped, which is the property being tested.
        const pass = !!error || !data || data.length === 0;
        rows.push(portalCheckRow(
            table,
            pass,
            error ? 'permission denied' : (data && data.length ? `LEAKED ${data.length} row(s)` : 'no rows'),
        ));
    }

    out.innerHTML = rows.join('');

    const failed = rows.filter(r => r.includes('pchk-fail')).length;
    const summary = pEl('portalCheckSummary');
    if (summary) {
        summary.textContent = failed === 0
            ? 'All checks passed — this session is scoped to one family and nothing else.'
            : `${failed} check${failed === 1 ? '' : 's'} failed. Do not build Phase 1 policies on this until they pass.`;
        summary.className = failed === 0 ? 'portal-check-summary ok' : 'portal-check-summary fail';
    }
}

// ── Init ─────────────────────────────────────────────────────
// A session already in localStorage means the parent is returning — go straight
// to the signed-in view rather than asking for the PIN again. getSession() only
// reads storage, so an expired token would slip through here; getUser() is
// validated server-side, which is the lesson from the payroll.html exposure.
document.addEventListener('DOMContentLoaded', async () => {
    pEl('portalSignInBtn')?.addEventListener('click', portalSignIn);
    pEl('portalSignOutBtn')?.addEventListener('click', portalSignOut);
    pEl('portalPin')?.addEventListener('keydown', e => { if (e.key === 'Enter') portalSignIn(); });
    pEl('portalEmail')?.addEventListener('keydown', e => { if (e.key === 'Enter') pEl('portalPin')?.focus(); });

    // `sbClient` is a top-level binding in supabase.js, not a window property —
    // the build writes plain globals rather than modules (bundle: false), so it
    // is in scope here but `window.sbClient` is undefined.
    if (typeof sbClient === 'undefined' || !sbClient) return;
    try {
        const { data, error } = await sbClient.auth.getUser();
        if (!error && data?.user) await portalShowSignedIn();
    } catch (_) { /* not signed in — the login card is already showing */ }
});
