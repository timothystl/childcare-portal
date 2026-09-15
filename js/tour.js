// ============================================================
// tour — public tour booking (design handoff: Capacity & Fill, 2b)
// ============================================================
// A public page, no login. Today a family who wants to come and look round
// has to ring the office during office hours; if nobody picks up, the call
// leaves no trace at all. This is the front of the funnel that the Leads &
// Tours board (admin-leads.js) reads from.
//
// ── One table, and why that is right here ───────────────────
// A tour request writes a real `waitlist_applications` row through the
// existing public `submit_waitlist_application()` RPC. There is no separate
// "lead" table, and there should not be one: the app already treats an
// inquiry and a waitlist entry as the same record with a `tour_status` on
// it, and the director's actual complaint was that a family who contacts
// us leaves NO record. Giving a tour request its own row is that record.
//
// It also means the family keeps their place in line from the day they
// asked, ordered by `applied_at` like everyone else. The page says so
// plainly rather than leaving it as a surprise — it is a reason to book,
// not a trap.
//
// ── Why the tour time goes in `notes` ───────────────────────
// ⚠️ `submit_waitlist_application()` has an explicit column allow-list, and
// `tour_*` is deliberately NOT on it — see
// supabase/migrations/fix_public_waitlist_submit_APPLIED.sql, whose own
// comment reads: "The caller is the public internet, so the
// admin-controlled fields (status, offer_*, tour_*, paperwork, deposit,
// archive_*, reminder_*) are simply not reachable."
//
// That is a correct boundary, not an oversight: a stranger should not be
// able to write themselves onto the tour calendar. So this page records the
// time the family ASKED for, in `notes`, and the office confirms it from
// the Leads & Tours board — which sets `tour_status`/`tour_scheduled_at`
// as an authenticated write. The confirmation screen promises exactly that
// and nothing more ("we'll confirm by email"), because that is what
// actually happens.
//
// Widening the RPC's allow-list to let the public set a tour slot directly
// would be a schema change AND a loosening of a deliberate security
// boundary. Not done here.
//
// ── What IS real ────────────────────────────────────────────
// The room derived from the child's birthday (getRoomIdFromDob), and that
// room's genuinely open days over the next few weeks (capacity_counts, the
// same counts-only RPC the enrollment form and the parent drop-in card
// read). A family sees real availability before they commit, which is the
// whole point of showing it.

// Published tour windows. Not a table: whether tour times are fixed weekly
// slots or ad-hoc is an open decision in the handoff itself, so this is the
// simplest thing that lets a family say WHEN suits them. The office is free
// to offer a different time when it confirms.
const TOUR_WINDOWS = [
    { key: 'wed_am', dow: 3, hour: 9,  minute: 30, blurb: 'Morning free play — the busiest, liveliest hour' },
    { key: 'fri_pm', dow: 5, hour: 13, minute: 0,  blurb: 'Quieter — most of the children are resting' },
];

const TOUR_LOOKAHEAD_WEEKS = 3;

let tourRoomId   = null;
let tourOpenDays = [];
let tourPick     = null;

function tEl(id) { return document.getElementById(id); }

function tEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/** The next few occurrences of each published window, soonest first. */
function tourSlots() {
    const out = [];
    const now = new Date();
    for (let w = 0; w < TOUR_LOOKAHEAD_WEEKS; w++) {
        TOUR_WINDOWS.forEach(win => {
            const d = new Date(now);
            const delta = (win.dow - d.getDay() + 7) % 7;
            d.setDate(d.getDate() + delta + w * 7);
            d.setHours(win.hour, win.minute, 0, 0);
            if (d <= now) return;
            out.push({ key: `${win.key}-${d.toLocaleDateString('en-CA')}`, at: d, blurb: win.blurb });
        });
    }
    return out.sort((a, b) => a.at - b.at).slice(0, 4);
}

function tourSlotLabel(slot) {
    return slot.at.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' }) +
        ' · ' + slot.at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
            .replace(' ', '').toLowerCase();
}

// ── Room, derived from the birthday ─────────────────────────
async function tourDeriveRoom() {
    const dob = tEl('tChildDob')?.value || '';
    const wrap = tEl('tRoomCard');
    if (!wrap) return;

    tourRoomId = dob ? getRoomIdFromDob(dob) : null;
    const room = tourRoomId ? ROOMS.find(r => r.id === tourRoomId) : null;

    if (!room) {
        wrap.classList.add('hidden');
        wrap.innerHTML = '';
        tourOpenDays = [];
        return;
    }

    const childName = (tEl('tChildName')?.value || '').trim() || 'Your child';
    wrap.classList.remove('hidden');
    wrap.innerHTML = `
        <div class="t-room-kicker">${tEsc(childName)} would be in</div>
        <div class="t-room-name">${tEsc(room.label)}</div>
        <div class="t-room-ages">${tEsc(room.ages)}</div>
        <div class="t-room-days" id="tRoomDays">Checking which days have room…</div>`;

    tourOpenDays = await tourOpenDaysFor(room);
    const daysEl = tEl('tRoomDays');
    if (!daysEl) return;

    if (!tourOpenDays.length) {
        daysEl.innerHTML = `<span class="t-room-full">${tEsc(room.label)} is full on every day for the next few weeks — a tour is still worth it, and the waitlist is how you get the next seat.</span>`;
        return;
    }
    const names = [...new Set(tourOpenDays.map(d =>
        new Date(d.date + 'T12:00:00').toLocaleDateString('en-US', { weekday: 'long' })))];
    daysEl.innerHTML = `<span class="t-room-open">Open seats on ${tEsc(
        names.length > 1 ? names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1] : names[0]
    )} right now.</span>`;
}

/**
 * Real open days for a room. Same seat/at-ratio rule the director's release
 * grid and the parent drop-in card use — a day sitting exactly on a ratio
 * boundary is not "open", because the next child there costs another adult.
 */
async function tourOpenDaysFor(room) {
    if (!room?.capacity || typeof fetchCapacityForDates !== 'function') return [];
    const dates = [];
    const d = new Date();
    for (let i = 1; i <= 21; i++) {
        d.setTime(Date.now() + i * 86400000);
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue;
        dates.push(d.toLocaleDateString('en-CA'));
    }
    let counts = {};
    try { counts = await fetchCapacityForDates(room.id, dates); }
    catch (e) { console.warn('tour capacity:', e); return []; }

    const ratio = Number(room.staffRatio) || 0;
    return dates.map(date => {
        const booked = Number(counts[date]) || 0;
        const open = Math.max(0, Number(room.capacity) - booked);
        const atRatio = ratio > 0 && booked > 0 && booked % ratio === 0;
        return { date, open, atRatio };
    }).filter(x => x.open > 0 && !x.atRatio);
}

// ── Slots ───────────────────────────────────────────────────
function tourRenderSlots() {
    const wrap = tEl('tSlots');
    if (!wrap) return;
    const slots = tourSlots();
    if (!tourPick) tourPick = slots[0]?.key || null;

    wrap.innerHTML = slots.map(s => `
        <button type="button" class="t-slot${s.key === tourPick ? ' is-on' : ''}" data-slot="${tEsc(s.key)}"
            data-label="${tEsc(tourSlotLabel(s))}">
            <span class="t-radio"></span>
            <span class="t-slot-main">
                <strong>${tEsc(tourSlotLabel(s))}</strong>
                <small>${tEsc(s.blurb)}</small>
            </span>
        </button>`).join('') + `
        <button type="button" class="t-slot${tourPick === 'other' ? ' is-on' : ''}" data-slot="other" data-label="None of these — the office will ring to arrange one">
            <span class="t-radio"></span>
            <span class="t-slot-main">
                <strong>None of these work</strong>
                <small>Tell us below and we'll ring you to find a time</small>
            </span>
        </button>`;

    wrap.querySelectorAll('.t-slot').forEach(b => {
        b.addEventListener('click', () => { tourPick = b.dataset.slot; tourRenderSlots(); });
    });
}

// ── Days wanted ─────────────────────────────────────────────
function tourRenderDays() {
    const wrap = tEl('tDays');
    if (!wrap) return;
    wrap.querySelectorAll('.t-day').forEach(b => {
        b.addEventListener('click', () => b.classList.toggle('is-on'));
    });
}

function tourSelectedDays() {
    return Array.from(document.querySelectorAll('#tDays .t-day.is-on')).map(b => b.dataset.day);
}

// ── Submit ──────────────────────────────────────────────────
async function tourSubmit(ev) {
    ev.preventDefault();
    const msg = tEl('tMsg');
    const btn = tEl('tSubmit');
    const val = id => (tEl(id)?.value || '').trim();

    const parentName  = val('tParentName');
    const parentEmail = val('tParentEmail');
    const childName   = val('tChildName');
    const childDob    = val('tChildDob');

    if (!parentName || !parentEmail || !childName || !childDob) {
        if (msg) msg.textContent = 'We need your name, an email, and your child’s name and birthday.';
        return;
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(parentEmail)) {
        if (msg) msg.textContent = 'That email address does not look right.';
        return;
    }

    const slots = tourSlots();
    const picked = tourPick === 'other'
        ? null
        : slots.find(s => s.key === tourPick);
    const slotLabel = picked ? tourSlotLabel(picked)
        : 'No published time suited them — please ring to arrange one';

    const days = tourSelectedDays();
    // The start date is required by the table and is not something a family
    // booking a tour has decided yet — the 1st of next month is the earliest
    // month they could realistically start, and the office edits it later.
    const start = new Date();
    start.setMonth(start.getMonth() + 1, 1);

    // ⚠️ The requested tour time rides in `notes`, NOT in tour_scheduled_at —
    // see the module header. The office confirms it from the board.
    const noteLines = [
        `TOUR REQUESTED: ${slotLabel}.`,
        val('tNotes'),
    ].filter(Boolean);

    if (btn) { btn.disabled = true; btn.textContent = 'Booking…'; }
    if (msg) msg.textContent = '';

    try {
        const result = await submitWaitlistApplication({
            parent_name:        parentName,
            parent_email:       parentEmail.toLowerCase(),
            parent_phone:       val('tParentPhone') || null,
            child_name:         childName,
            child_dob:          childDob,
            desired_start_date: start.toLocaleDateString('en-CA'),
            start_flexibility:  'flexible',
            days_of_week:       days.length ? days.join(',') : null,
            day_type:           'full',
            notes:              noteLines.join(' '),
            status:             'pending',
        });

        // Best effort, exactly as the inquiry form treats it: the record is
        // already saved even if the email never goes out.
        if (typeof sendWaitlistConfirmationEmail === 'function') {
            sendWaitlistConfirmationEmail(result.id).catch(() => {});
        }
        tourShowConfirmation(slotLabel, picked);
    } catch (e) {
        if (msg) msg.textContent = 'We could not save that — please ring the office on (314) 843-3600. ' + (e.message || '');
        if (btn) { btn.disabled = false; btn.textContent = 'Book this tour'; }
    }
}

function tourShowConfirmation(slotLabel, picked) {
    tEl('tFormScreen')?.classList.add('hidden');
    const wrap = tEl('tDoneScreen');
    if (!wrap) return;
    wrap.classList.remove('hidden');

    const room = tourRoomId ? ROOMS.find(r => r.id === tourRoomId) : null;
    const openLine = tourOpenDays.length && room
        ? `<div class="t-done-card t-done-open">
               <div class="t-done-card-kicker">While you wait</div>
               <div class="t-done-card-title">${tEsc(room.label)} has open seats on ${tourOpenDays.length} of the next few weeks' days</div>
               <p>They are not held for you — booking a tour keeps your place in line from today, which is what decides who gets the next seat.</p>
           </div>`
        : '';

    wrap.innerHTML = `
        <div class="t-done-head">
            <div class="t-done-tick">✓</div>
            <h2>${picked ? "We've got you down" : "We'll ring you"}</h2>
            <p>${picked
                ? `You asked for <strong>${tEsc(slotLabel)}</strong>. We'll confirm by email — usually the same day — and text you the evening before.`
                : `We'll ring you to find a time that works. Nothing else to do.`}</p>
        </div>

        <div class="t-done-card">
            <div class="t-done-card-kicker">What to expect</div>
            <ul class="t-done-list">
                <li>🧸 You'll see the room while the children are in it — not an empty room after hours.</li>
                <li>⏱️ About twenty minutes. Bring your child if you like.</li>
                <li>📋 Nothing to bring. If you want a spot afterward, we can start the paperwork the same day.</li>
            </ul>
        </div>

        ${openLine}

        <p class="t-done-foot">Questions before then? Call the office on <a href="tel:+13148433600">(314) 843-3600</a>.</p>`;
    window.scrollTo(0, 0);
}

// ── Init ────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    tourRenderSlots();
    tourRenderDays();
    tEl('tChildDob')?.addEventListener('change', tourDeriveRoom);
    tEl('tChildName')?.addEventListener('input', () => {
        if (tourRoomId) tourDeriveRoom();
    });
    tEl('tForm')?.addEventListener('submit', tourSubmit);
});
