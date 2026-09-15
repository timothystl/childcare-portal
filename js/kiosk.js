// ============================================================
// kiosk — the tablet at the door
// ============================================================
// Design handoff: Capacity & Fill, 4a (MDO drop-off + signature), and the
// after-care walk-in states from turn 5 (5b, 5d).
//
// Today the door has a printed sheet: admin-print-attendance.js exists
// precisely BECAUSE there is no digital record of who handed a child over
// and when. This is the screen that replaces it.
//
// ── What is real ────────────────────────────────────────────
//   Identifying the family   `family_login` — the same rate-limited,
//                            fail-closed, server-side PIN check the parent
//                            lookup uses, sharing its lockout so this
//                            cannot become a second door to brute-force a
//                            PIN. The kiosk never sees a PIN hash and
//                            never decides whether one is right.
//   Their children           returned by that same call.
//   Today's booking          `family_registrations`, which the same PIN
//                            authorizes and which returns only that
//                            family's own rows.
//   The signature            drawn on a real canvas, with a real
//                            timestamp, exportable as a PNG data URL.
//
// ── ⚠️ WHAT IS NOT WIRED, AND WHY IT IS NOT FAKED ───────────
// The write. Two things are missing and both are schema:
//
//   1. A parent-callable check-in. `log_child_event` takes a STAFF id and
//      a STAFF pin; `admin_log_child_event` needs an admin session.
//      Neither is reachable from a family's PIN, and widening one to
//      accept a family PIN is an auth change, not a UI change.
//   2. Somewhere to put a signature. There is no column and no table. A
//      signature is a licensing record — it needs its own row with the
//      time, the device, who signed, and which children it covered.
//
// So the kiosk composes a complete, correct check-in and stops at the
// point of writing it, saying so in those words. It does NOT store the
// signature in localStorage and call that a record: a licensing artifact
// that lives only in one tablet's browser is worse than the paper sheet it
// would replace, because it looks like a system of record and is not.
//
// The after-care walk-in states (5b/5d) are further from data again — a
// Pre-K child who uses only the care program has no room, no registration
// and no place in capacity, which is a `program_enrollments` table. Those
// states render from the real programs document for hours and rates, and
// say plainly that the roster behind them does not exist yet.

const KIOSK_IDLE_MS = 90 * 1000;      // back to the start if a family walks away

let kState = 'start';       // start | family | sign | done | program
let kFamily = null;         // { family, isParent2 } from family_login
let kPin = null;            // held in memory only, never stored
let kRegs = [];             // that family's registrations
let kPicked = new Set();    // student ids staying today
let kPrograms = null;
let kIdleTimer = null;
let kSigDirty = false;

function kEl(id) { return document.getElementById(id); }

function kEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function kToday() { return new Date().toLocaleDateString('en-CA'); }

function kNowLabel() {
    return new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        .replace(' ', '').toLowerCase();
}

function kDateLabel() {
    return new Date().toLocaleDateString('en-US',
        { weekday: 'long', month: 'long', day: 'numeric' });
}

// A shared tablet must not hold a family's session after they walk away.
function kBumpIdle() {
    clearTimeout(kIdleTimer);
    if (kState === 'start') return;
    kIdleTimer = setTimeout(kReset, KIOSK_IDLE_MS);
}

function kReset() {
    clearTimeout(kIdleTimer);
    kState = 'start';
    kFamily = null;
    kPin = null;           // ⚠️ the PIN never outlives the visit
    kRegs = [];
    kPicked = new Set();
    kSigDirty = false;
    kRender();
}

// ── Screens ─────────────────────────────────────────────────
function kStartHtml() {
    const inCare = kProgramWindow();
    return `
        <div class="k-start">
            <h1 class="k-h1">Good ${kGreeting()}</h1>
            <p class="k-sub">${kEsc(kDateLabel())} · ${kEsc(kNowLabel())}</p>

            <form id="kSignInForm" class="k-signin" novalidate>
                <label class="k-field">
                    <span>Your email</span>
                    <input type="email" id="kEmail" autocomplete="off" autocapitalize="none"
                           spellcheck="false" placeholder="you@example.com" required>
                </label>
                <label class="k-field">
                    <span>Your PIN</span>
                    <input type="password" id="kPin" inputmode="numeric" autocomplete="off"
                           maxlength="8" placeholder="••••" required>
                </label>
                <p class="k-msg" id="kMsg"></p>
                <button type="submit" class="k-btn k-btn-primary" id="kSignInBtn">Sign in to drop off</button>
            </form>

            ${inCare ? `
                <div class="k-program-hint">
                    <strong>${kEsc(inCare.label)} is open right now</strong>
                    ${kEsc(inCare.window)} · ${kEsc(inCare.rateLabel)}. A child who only uses before or after care is checked in by a teacher — see the note below.
                </div>` : ''}

            <p class="k-foot">Forgotten your PIN? The office can reset it, or use the link in any email from us.</p>
        </div>`;
}

function kGreeting() {
    const h = new Date().getHours();
    return h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
}

/** Whether a before/after care window is open right now, from the real programs document. */
function kProgramWindow() {
    const list = (kPrograms?.programs || []).filter(p => p.active && p.kind === 'daily');
    const now = new Date();
    const mins = now.getHours() * 60 + now.getMinutes();
    const toMins = (hhmm) => {
        const [h, m] = String(hhmm || '').split(':').map(Number);
        return Number.isFinite(h) ? h * 60 + (m || 0) : null;
    };
    for (const p of list) {
        const a = toMins(p.startTime), b = toMins(p.endTime);
        if (a == null || b == null) continue;
        if (mins >= a && mins <= b) {
            return {
                label: p.label,
                window: `${p.startTime}–${p.endTime}`,
                rateLabel: `$${p.rate} per session`,
                id: p.id,
            };
        }
    }
    return null;
}

/** Today's booking for one child, from their real registrations. */
function kTodayFor(studentName) {
    const today = kToday();
    for (const reg of kRegs) {
        if ((reg.child_name || '').toLowerCase() !== String(studentName || '').toLowerCase()) continue;
        const d = (reg.registration_dates || []).find(x => x.care_date === today && !x.waitlisted);
        if (d) return { dayType: d.day_type || 'full', roomId: d.room_id || reg.room_id };
    }
    return null;
}

function kFamilyHtml() {
    const kids = kFamily?.family?.students || [];
    const today = kDateLabel();

    const rows = kids.map(c => {
        const booked = kTodayFor(c.child_name);
        const room = booked && typeof ROOMS !== 'undefined'
            ? ROOMS.find(r => r.id === booked.roomId) : null;
        const picked = kPicked.has(String(c.id));
        const allergies = Array.isArray(c.allergies) ? c.allergies : [];

        return `
            <button type="button" class="k-child${picked ? ' is-on' : ''}${booked ? '' : ' is-unbooked'}"
                    data-k-child="${kEsc(c.id)}" ${booked ? '' : 'disabled'}>
                <span class="k-avatar">${kEsc((c.child_name || '?').trim()[0] || '?')}</span>
                <span class="k-child-main">
                    <span class="k-child-name">
                        ${kEsc(c.child_name)}
                        ${allergies.map(a => `<span class="k-allergy">${kEsc(String(a.label || '').toUpperCase())}</span>`).join('')}
                    </span>
                    <span class="k-child-sub">${booked
                        ? `${kEsc(room ? room.label : '')} · booked ${booked.dayType === 'half' ? 'half day' : 'full day'}`
                        : 'Not booked today'}</span>
                </span>
                <span class="k-tick">${picked ? '✓' : ''}</span>
            </button>`;
    }).join('');

    const n = kPicked.size;
    return `
        <div class="k-head">
            <div>
                <div class="k-kicker">Step 1</div>
                <h1 class="k-h1">Who's staying today?</h1>
                <p class="k-sub">${kEsc(kFamily.family.parent_name || 'Family')} · ${kEsc(today)} · ${kEsc(kNowLabel())}</p>
            </div>
            <button type="button" class="k-btn k-btn-ghost" data-k-reset>Not you? Start over</button>
        </div>

        <div class="k-children">${rows || '<p class="k-empty">No children on this family record.</p>'}</div>

        <p class="k-note">Tap each child who is staying. A child with no booking today cannot be checked in here — the office adds a day.</p>

        <button type="button" class="k-btn k-btn-primary k-wide" data-k-step="sign" ${n ? '' : 'disabled'}>
            ${n ? `Continue with ${n} ${n === 1 ? 'child' : 'children'}` : 'Choose at least one child'}
        </button>`;
}

function kSignHtml() {
    const kids = (kFamily?.family?.students || []).filter(c => kPicked.has(String(c.id)));
    return `
        <div class="k-head">
            <div>
                <div class="k-kicker">Step 2</div>
                <h1 class="k-h1">Sign to drop off</h1>
                <p class="k-sub">Your signature is the licensed record of who handed the children over, and at what time.</p>
            </div>
            <button type="button" class="k-btn k-btn-ghost" data-k-step="family">Back</button>
        </div>

        <div class="k-signing">
            <div class="k-signing-list">
                <div class="k-kicker">Signing in</div>
                ${kids.map(c => {
                    const b = kTodayFor(c.child_name);
                    return `<div class="k-signing-row">
                        <span>${kEsc(c.child_name)} · ${b?.dayType === 'half' ? 'half day' : 'full day'}</span>
                        <span>${kEsc(kNowLabel())}</span>
                    </div>`;
                }).join('')}
            </div>

            <div class="k-pad-wrap">
                <div class="k-kicker">${kEsc(kFamily.family.parent_name || 'Parent')}</div>
                <canvas id="kPad" class="k-pad"></canvas>
                <div class="k-pad-row">
                    <button type="button" class="k-link" data-k-clear>Clear and start again</button>
                    <span class="k-pad-stamp">Stamped ${kEsc(kNowLabel())} · this device</span>
                </div>
            </div>
        </div>

        <!-- ⚠️ Not a submit. There is no parent-callable check-in RPC and
             nowhere to put a signature — see this file's header. The button
             says what is true rather than appearing to save. -->
        <div class="k-blocked">
            <strong>This can't be saved yet.</strong>
            The signature pad works and the check-in is correct, but myMDO has nowhere to put either: a parent-callable check-in and a signature record are both still to be built. Until then the paper sheet at the desk is the record — the office prints it from Classrooms → Print Attendance.
        </div>

        <button type="button" class="k-btn k-btn-primary k-wide" disabled>
            Check in ${kids.length} ${kids.length === 1 ? 'child' : 'children'}
        </button>`;
}

function kProgramHtml() {
    const w = kProgramWindow();
    return `
        <div class="k-head">
            <div>
                <div class="k-kicker">Before &amp; after care</div>
                <h1 class="k-h1">${w ? kEsc(w.label) + ' walk-in' : 'Not open right now'}</h1>
                <p class="k-sub">${w ? `${kEsc(w.window)} · ${kEsc(w.rateLabel)} · ${kEsc(kDateLabel())}` : 'Before and after care are closed at this hour.'}</p>
            </div>
            <button type="button" class="k-btn k-btn-ghost" data-k-reset>Back</button>
        </div>

        <div class="k-blocked">
            <strong>The walk-in roster isn't built yet.</strong>
            A child who uses only before or after care — a Pre-K child, say — has no room, no registration and no place in capacity. They need a program enrolment of their own, and that table does not exist. Until it does there is nobody for this screen to search, so it would only ever show an empty list.
        </div>

        <div class="k-plan">
            <div class="k-kicker">What this screen becomes</div>
            <ol class="k-plan-list">
                <li><strong>Search and tap.</strong> The afternoon becomes a line on the month's invoice — the check-in IS the booking, because nothing is reserved ahead.</li>
                <li><strong>Walk-in headroom.</strong> With nobody booking ahead, "how many more can come in" is the only thing protecting the ratio, so the kiosk refuses a child past it.</li>
                <li><strong>A name recorded at the door.</strong> Four fields — the child, who is dropping off, a mobile that rings today, and anything that could hurt them at snack — saved as a provisional record that is badged unfinished until the office closes it.</li>
            </ol>
            ${w ? `<p class="k-plan-note">The hours and the rate above are already real — they come from Settings → Programs &amp; add-ons, and change here the moment the office changes them there.</p>` : ''}
        </div>`;
}

function kDoneHtml() {
    return `<div class="k-start"><h1 class="k-h1">Thank you</h1>
        <p class="k-sub">Have a lovely day.</p></div>`;
}

// ── Signature pad ───────────────────────────────────────────
// A real canvas, sized to its box and drawn with pointer events so it
// works with a finger, a stylus and a mouse alike.
function kMountPad() {
    const canvas = kEl('kPad');
    if (!canvas) return;
    const ratio = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(rect.width * ratio));
    canvas.height = Math.max(1, Math.round(rect.height * ratio));

    const ctx = canvas.getContext('2d');
    ctx.scale(ratio, ratio);
    ctx.lineWidth = 2.5;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.strokeStyle = '#01294A';

    let drawing = false;
    const pos = (ev) => {
        const r = canvas.getBoundingClientRect();
        return { x: ev.clientX - r.left, y: ev.clientY - r.top };
    };

    canvas.addEventListener('pointerdown', (ev) => {
        drawing = true;
        kSigDirty = true;
        canvas.setPointerCapture(ev.pointerId);
        const { x, y } = pos(ev);
        ctx.beginPath();
        ctx.moveTo(x, y);
        kBumpIdle();
    });
    canvas.addEventListener('pointermove', (ev) => {
        if (!drawing) return;
        const { x, y } = pos(ev);
        ctx.lineTo(x, y);
        ctx.stroke();
    });
    const stop = () => { drawing = false; };
    canvas.addEventListener('pointerup', stop);
    canvas.addEventListener('pointercancel', stop);
    canvas.addEventListener('pointerleave', stop);
}

function kClearPad() {
    const canvas = kEl('kPad');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    kSigDirty = false;
}

// ── Sign in ─────────────────────────────────────────────────
async function kSignIn(ev) {
    ev.preventDefault();
    const msg = kEl('kMsg');
    const btn = kEl('kSignInBtn');
    const email = (kEl('kEmail')?.value || '').trim().toLowerCase();
    const pin = (kEl('kPin')?.value || '').trim();

    if (!email || !pin) { if (msg) msg.textContent = 'Your email and PIN, please.'; return; }

    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    if (msg) msg.textContent = '';

    try {
        // Server-side. The kiosk never sees a hash and never decides whether
        // a PIN is right — family_login does, with its own lockout.
        const res = await familyLogin(email, pin);
        if (!res || res.error || !res.family) {
            if (msg) msg.textContent = res?.error === 'locked'
                ? 'That account is locked after too many tries. The office can unlock it.'
                : 'That email and PIN do not match. Please try again, or ask at the desk.';
            if (btn) { btn.disabled = false; btn.textContent = 'Sign in to drop off'; }
            return;
        }
        kFamily = res;
        kPin = pin;
        try { kRegs = await fetchRegistrationsByEmail(email, pin); }
        catch (_) { kRegs = []; }

        // Pre-select every child who actually has a booking today: that is
        // the common case, and a parent holding two bags should not have to
        // tap what the schedule already knows.
        kPicked = new Set((kFamily.family.students || [])
            .filter(c => kTodayFor(c.child_name))
            .map(c => String(c.id)));

        kState = 'family';
        kRender();
    } catch (e) {
        if (msg) msg.textContent = 'Could not reach myMDO. Please sign the sheet at the desk.';
        if (btn) { btn.disabled = false; btn.textContent = 'Sign in to drop off'; }
    }
}

// ── Render ──────────────────────────────────────────────────
function kRender() {
    const root = kEl('kRoot');
    if (!root) return;
    root.className = 'k-root k-' + kState;
    root.innerHTML = kState === 'start'   ? kStartHtml()
                   : kState === 'family'  ? kFamilyHtml()
                   : kState === 'sign'    ? kSignHtml()
                   : kState === 'program' ? kProgramHtml()
                   :                        kDoneHtml();

    if (kState === 'start') kEl('kSignInForm')?.addEventListener('submit', kSignIn);
    if (kState === 'sign')  kMountPad();
    kBumpIdle();
}

document.addEventListener('DOMContentLoaded', async () => {
    try { kPrograms = await loadProgramSettings(); } catch (_) { kPrograms = null; }
    kRender();

    // One delegated listener for the whole kiosk; every screen rewrites the
    // root, so per-button binding would have to be redone on each render.
    kEl('kRoot')?.addEventListener('click', (ev) => {
        kBumpIdle();
        if (ev.target.closest('[data-k-reset]')) { kReset(); return; }
        if (ev.target.closest('[data-k-clear]')) { kClearPad(); return; }
        const step = ev.target.closest('[data-k-step]');
        if (step) { kState = step.dataset.kStep; kRender(); return; }
        const child = ev.target.closest('[data-k-child]');
        if (child && !child.disabled) {
            const id = child.dataset.kChild;
            if (kPicked.has(id)) kPicked.delete(id); else kPicked.add(id);
            kRender();
        }
    });

    kEl('kProgramLink')?.addEventListener('click', (e) => {
        e.preventDefault();
        kState = 'program';
        kRender();
    });

    ['pointerdown', 'keydown'].forEach(t => document.addEventListener(t, kBumpIdle));
});
