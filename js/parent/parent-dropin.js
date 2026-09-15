// ============================================================
// parent-dropin — "need a day you didn't sign up for?"
// ============================================================
// Design handoff: Capacity & Fill, 1c. The parent half of the director's
// drop-in release. Its whole reason to exist is the 1st–15th registration
// window: once that closes, a family who needs an extra Thursday has no
// way to ask for one, and the room sits half empty with a child who wanted
// to be in it.
//
// ── What is real here ───────────────────────────────────────
// The open-seat counts are not illustrative. `capacity_counts` is an
// existing SECURITY DEFINER RPC (fetchCapacityForDates, js/supabase.js)
// that returns booking counts — counts only, no names — for one room and a
// list of dates, and it is already reachable from the parent session. So
// this card shows the same seat arithmetic the director's Fill the Rooms
// screen shows, from the same underlying registrations:
//
//     open    = room capacity − confirmed bookings that day
//     atRatio = bookings % staffRatio === 0   (and bookings > 0)
//
// A day sitting exactly on a ratio boundary is NOT offered, however many
// seats look open, because the next child there costs another adult. That
// is the same rule admin-fill-rooms.js applies, deliberately duplicated in
// one expression rather than shared through a helper the parent bundle
// would have to import the admin bundle to reach — the business-logic
// suite has a drift guard over the pair (see AGENTS.md on intentional
// copies).
//
// Days the child is ALREADY booked for are filtered out: offering to sell
// a parent a day they have already paid for is the one bug that would
// make this feature worse than nothing.
//
// ── What is not wired ───────────────────────────────────────
// Booking. There is no `drop_in_days` table, no released-day flag on a
// registration, and no write path — and crucially, WHICH days are open to
// drop-in is the director's decision, not a consequence of arithmetic.
// Until the release table exists, "these days have room" is a true
// statement and "you may book them" is not, so the card says the first and
// the confirm step says the second is not open yet, in those words. It
// does not pretend to submit.

const PDI_LOOKAHEAD_DAYS = 14;   // calendar days scanned forward for open weekdays
const PDI_MAX_TILES      = 3;    // day tiles on the collapsed card

let _pdiState = null;   // { childId, roomId, days: [...] }
let _pdiPick  = null;   // { date, dayType }
let _pdiBound = false;

function pdiEl(id) { return document.getElementById(id); }

function pdiEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

/** The next N weekdays from tomorrow, in the center's timezone. */
function pdiUpcomingWeekdays(n = PDI_LOOKAHEAD_DAYS) {
    const out = [];
    const d = new Date();
    for (let i = 1; i <= n; i++) {
        d.setTime(Date.now() + i * 86400000);
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue;
        out.push(d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }));
    }
    return out;
}

/**
 * Open days for one child's room — real counts, same seat/ratio rule as the
 * director's screen. Returns [] rather than throwing: this is a bonus card
 * on the Today feed, and a capacity query that fails must not take the
 * day's timeline down with it.
 */
async function pdiOpenDaysFor(child, sched) {
    const room = (typeof ROOMS !== 'undefined' && ROOMS.find(r => r.id === child.room_id)) || null;
    if (!room || !room.capacity || typeof fetchCapacityForDates !== 'function') return [];

    const closed = new Set((sched?.closures || [])
        .filter(c => !c.half_day).map(c => c.close_date));

    // Every date this child already holds, across every registration — a day
    // they are booked for is never an "open day" to sell them again.
    const alreadyBooked = new Set();
    (sched?.registrations || []).forEach(r => {
        if (String(r.child_id ?? r.student_id ?? '') !== String(child.id)) return;
        (r.dates || []).forEach(d => { if (!d.waitlisted) alreadyBooked.add(d.care_date); });
    });

    const dates = pdiUpcomingWeekdays().filter(d => !closed.has(d) && !alreadyBooked.has(d));
    if (!dates.length) return [];

    let counts = {};
    try { counts = await fetchCapacityForDates(room.id, dates); }
    catch (e) { console.warn('dropin capacity:', e); return []; }

    const ratio = Number(room.staffRatio) || 0;
    return dates.map(date => {
        const booked = Number(counts[date]) || 0;
        const open = Math.max(0, Number(room.capacity) - booked);
        // The shared rule — see the module header.
        const atRatio = ratio > 0 && booked > 0 && booked % ratio === 0;
        return { date, booked, open, atRatio, offerable: open > 0 && !atRatio };
    }).filter(d => d.offerable);
}

function pdiDayLabel(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    return {
        dow: d.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase(),
        num: d.getDate(),
        long: d.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
    };
}

function pdiRate(room, dayType) {
    return typeof psDayRate === 'function' ? psDayRate(room, dayType) : 0;
}

function pdiMoney(n) { return '$' + (Number(n) || 0).toFixed(2); }

// ── Collapsed card ──────────────────────────────────────────
function pdiCardHtml(state) {
    const tiles = state.days.slice(0, PDI_MAX_TILES).map(d => {
        const l = pdiDayLabel(d.date);
        return `<div class="pdi-tile">
            <span class="pdi-tile-dow">${l.dow}</span>
            <span class="pdi-tile-num">${l.num}</span>
            <span class="pdi-tile-open">${d.open} ${d.open === 1 ? 'spot' : 'spots'}</span>
        </div>`;
    }).join('');
    const more = state.days.length > PDI_MAX_TILES
        ? `<div class="pdi-tile pdi-tile-more"><span class="pdi-tile-plus">＋</span><span class="pdi-tile-open">${state.days.length - PDI_MAX_TILES} more</span></div>`
        : '';

    return `
        <div class="pdi-head">
            <div class="pdi-kicker">Open days coming up</div>
            <div class="pdi-title">Need a day you didn't sign up for?</div>
            <p class="pdi-sub">${pdiEsc(state.roomLabel)} has room on ${state.days.length} upcoming ${state.days.length === 1 ? 'day' : 'days'}.</p>
        </div>
        <div class="pdi-tiles">${tiles}${more}</div>
        <button type="button" class="pdi-cta" data-pdi-open>See the open days</button>`;
}

// ── Expanded booking form ───────────────────────────────────
// In place, not a modal — the rest of this app expands cards where they sit
// (see ptOpenAllergyEditor), and a bottom sheet here would be a second
// interaction pattern for no gain.
function pdiFormHtml(state) {
    const room = state.room;
    const pick = _pdiPick || { date: state.days[0].date, dayType: 'full' };
    const chosen = state.days.find(d => d.date === pick.date) || state.days[0];
    const full = pdiRate(room, 'full');
    const half = pdiRate(room, 'half');
    const canHalf = !room.fullDayOnly && half > 0;
    const amount = pdiRate(room, canHalf ? pick.dayType : 'full');

    const tiles = state.days.map(d => {
        const l = pdiDayLabel(d.date);
        return `<button type="button" class="pdi-pick${d.date === pick.date ? ' is-on' : ''}" data-pdi-date="${pdiEsc(d.date)}">
            <span class="pdi-tile-dow">${l.dow}</span>
            <span class="pdi-tile-num">${l.num}</span>
            <span class="pdi-tile-open">${d.open} ${d.open === 1 ? 'spot' : 'spots'}</span>
        </button>`;
    }).join('');

    const lengths = canHalf ? `
        <div class="pdi-label">How long</div>
        <div class="pdi-lengths">
            <button type="button" class="pdi-length${pick.dayType === 'full' ? ' is-on' : ''}" data-pdi-type="full">
                <span class="pdi-radio"></span>
                <span class="pdi-length-main"><strong>Full day</strong><small>9:00a – 3:00p</small></span>
                <span class="pdi-length-rate">${pdiMoney(full)}</span>
            </button>
            <button type="button" class="pdi-length${pick.dayType === 'half' ? ' is-on' : ''}" data-pdi-type="half">
                <span class="pdi-radio"></span>
                <span class="pdi-length-main"><strong>Half day</strong><small>9:00a – 12:30p, lunch included</small></span>
                <span class="pdi-length-rate">${pdiMoney(half)}</span>
            </button>
        </div>` : `
        <div class="pdi-note">${pdiEsc(state.roomLabel)} is a full-day room — ${pdiMoney(full)} for the day.</div>`;

    return `
        <div class="pdi-head">
            <div class="pdi-title">An extra day for ${pdiEsc(state.firstName)}</div>
            <p class="pdi-sub">${pdiEsc(state.roomLabel)}</p>
        </div>

        <div class="pdi-label">Which day</div>
        <div class="pdi-picks">${tiles}</div>

        ${lengths}

        <div class="pdi-total">
            <span>${pdiEsc(pdiDayLabel(chosen.date).long)}${canHalf && pick.dayType === 'half' ? ' · half day' : ''}</span>
            <strong>${pdiMoney(amount)}</strong>
        </div>

        <!-- ⚠️ Not a submit. Which days are open to drop-in is the office's
             decision and there is no table recording it yet — see the module
             header. The card states what is true (these days have room) and
             stops short of what is not (that a parent may take one). -->
        <div class="pdi-pending">
            <strong>Booking isn't open yet.</strong>
            Drop-in days have to be released by the office before they can be taken, and that switch isn't built yet. Call us on (314) 843-3600 and we'll add the day by hand.
        </div>
        <button type="button" class="pdi-cta pdi-cta-ghost" data-pdi-close>Close</button>`;
}

// ── Render ──────────────────────────────────────────────────
async function pdiRender(child) {
    const wrap = pdiEl('ptDropIn');
    if (!wrap || !child) return;

    let sched = null;
    try { sched = typeof psSchedule === 'function' ? await psSchedule() : null; }
    catch (_) { /* the card is optional; a failed schedule just hides it */ }

    const days = await pdiOpenDaysFor(child, sched);
    if (!days.length) { wrap.classList.add('hidden'); _pdiState = null; return; }

    const room = (typeof ROOMS !== 'undefined' && ROOMS.find(r => r.id === child.room_id)) || null;
    _pdiState = {
        childId: child.id,
        room,
        roomLabel: room ? room.label : 'Their room',
        firstName: String(child.child_name || '').split(' ')[0] || 'them',
        days,
    };
    _pdiPick = { date: days[0].date, dayType: 'full' };

    wrap.classList.remove('hidden');
    wrap.innerHTML = pdiCardHtml(_pdiState);
}

function pdiShowForm() {
    const wrap = pdiEl('ptDropIn');
    if (!wrap || !_pdiState) return;
    wrap.classList.add('is-open');
    wrap.innerHTML = pdiFormHtml(_pdiState);
}

function pdiShowCard() {
    const wrap = pdiEl('ptDropIn');
    if (!wrap || !_pdiState) return;
    wrap.classList.remove('is-open');
    wrap.innerHTML = pdiCardHtml(_pdiState);
}

// One delegated listener for the life of the page: the card rewrites its own
// innerHTML on every state change, so per-button binding would have to be
// redone each time.
function pdiSetup() {
    if (_pdiBound) return;
    const wrap = pdiEl('ptDropIn');
    if (!wrap) return;
    _pdiBound = true;

    wrap.addEventListener('click', (ev) => {
        if (ev.target.closest('[data-pdi-open]'))  { pdiShowForm(); return; }
        if (ev.target.closest('[data-pdi-close]')) { pdiShowCard(); return; }

        const day = ev.target.closest('[data-pdi-date]');
        if (day) {
            _pdiPick = { ..._pdiPick, date: day.dataset.pdiDate };
            pdiShowForm();
            return;
        }
        const len = ev.target.closest('[data-pdi-type]');
        if (len) {
            _pdiPick = { ..._pdiPick, dayType: len.dataset.pdiType };
            pdiShowForm();
        }
    });
}
