// ============================================================
// parent-programs — before care, after care and camps
// ============================================================
// Design handoff: Capacity & Fill, 4d, parent side. A card on the Schedule
// tab, below the child's booked care days: the add-ons that attach to a day
// that is already happening.
//
// ── One definition of a program ─────────────────────────────
// Hours, rate, capacity and ratio come from `settings.programs` via
// loadProgramSettings() — the same document the director edits in Settings
// → Programs & add-ons. The parent app does not carry its own copy of "$12
// for after care": if the office changes the rate on Monday, this card
// quotes the new one on Tuesday without a deploy.
//
// A program that is switched off (`active: false`) is not rendered at all.
// Camp in particular is off outside a break, which is why the card is empty
// for most of the year rather than advertising a camp that is not running.
//
// ── What is not wired, and why it is stated rather than faked ──
// Booking. There is no `program_enrollments` table and no write path, so
// the card shows what is genuinely true — which programs run, when, and
// what they cost — and stops at the point where it would have to claim a
// day is held. That is the same line js/parent/parent-dropin.js draws for
// drop-in days, for the same reason: the office decides what is open, and
// nothing records that decision yet.
//
// The weekly standing rate IS quoted against the daily one, because that
// arithmetic is real and is the thing a parent actually wants to know:
// five afternoons at the daily rate versus the weekly price.

let _ppState = null;     // { programs, fees }
let _ppBound = false;
let _ppOpen  = null;     // program id whose day-picker is expanded

function ppEl(id) { return document.getElementById(id); }

function ppEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function ppMoney(n) {
    const v = Number(n) || 0;
    return '$' + (Number.isInteger(v) ? v : v.toFixed(2));
}

function ppTime(hhmm) {
    if (!hhmm) return '';
    const [h, m] = String(hhmm).split(':').map(Number);
    const ampm = h >= 12 ? 'p.m.' : 'a.m.';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

const PP_DAYS = [
    { key: 'Mon', label: 'M' }, { key: 'Tue', label: 'T' }, { key: 'Wed', label: 'W' },
    { key: 'Thu', label: 'Th' }, { key: 'Fri', label: 'F' },
];

/**
 * Whether a child's room takes part in a program. After care pools only the
 * three older rooms (PM_COMBINED_ROOM_IDS, carried on the program as
 * `pooledRooms`); before care is all rooms combined. A program that names
 * no rooms applies to everyone.
 */
function ppAppliesTo(program, roomId) {
    if (!program.pooledRooms || !program.pooledRooms.length) return true;
    return program.pooledRooms.includes(roomId);
}

function _ppDayChipsHtml(p) {
    return `<div class="pp-days">${PP_DAYS.map(d =>
        `<button type="button" class="pp-day" data-pp-day="${d.key}">${d.label}</button>`).join('')}</div>`;
}

function _ppCardHtml(p, fees) {
    const daily = Number(p.rate) || 0;
    const weekly = _ppState.programs.find(x => x.sharesCapacityWith === p.id && x.active);

    const savings = weekly && daily
        ? Math.max(0, daily * 5 - (Number(weekly.rate) || 0))
        : 0;

    const hours = p.startTime && p.endTime
        ? `${ppTime(p.startTime)} – ${ppTime(p.endTime)}`
        : '';

    const weeklyLine = weekly ? `
        <div class="pp-weekly">
            Every weekday is cheaper as a standing add-on — <strong>${ppMoney(weekly.rate)} a week</strong>
            instead of ${ppMoney(daily * 5)}${savings ? `, saving ${ppMoney(savings)}` : ''}.
        </div>` : '';

    return `
        <div class="pp-card" data-pp-id="${ppEsc(p.id)}">
            <div class="pp-card-head">
                <span class="pp-card-name">${ppEsc(p.label)}</span>
                <span class="pp-card-rate">${ppMoney(daily)}${p.kind === 'camp' ? ' / day' : ''}</span>
            </div>
            <div class="pp-card-body">
                <p class="pp-card-when">${ppEsc(hours)}${p.note ? ` ${ppEsc(p.note)}` : ''}</p>
                ${_ppDayChipsHtml(p)}
                ${weeklyLine}
            </div>
        </div>`;
}

function ppRender(child) {
    const wrap = ppEl('ptPrograms');
    if (!wrap || !_ppState) return;

    const roomId = child?.roomId || child?.room_id || null;
    const runnable = _ppState.programs.filter(p =>
        p.active && p.kind !== 'standing' && ppAppliesTo(p, roomId));

    if (!runnable.length) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }

    const first = String(child?.child || child?.child_name || '').split(' ')[0] || 'your child';
    const fees = _ppState.fees || {};

    wrap.classList.remove('hidden');
    wrap.innerHTML = `
        <div class="pp-head">
            <h3>Add to ${ppEsc(first)}'s week</h3>
            <p>Before and after care attach to a day that is already booked. They do not change ${ppEsc(first)}'s room or their place in it.</p>
        </div>
        ${runnable.map(p => _ppCardHtml(p, fees)).join('')}
        <div class="pp-pending">
            <strong>Picking days isn't switched on yet.</strong>
            The hours and prices above are live — the office sets them in myMDO — but nothing here books a morning or an afternoon yet. Ring the office on (314) 843-3600 and we'll add them by hand.
        </div>
        ${fees.latePickupPer15Min ? `<p class="pp-fee-note">Pickup after the end of after care is ${ppMoney(fees.latePickupPer15Min)} per 15 minutes.</p>` : ''}`;
}

/** Called by the Schedule tab once it knows which child is showing. */
async function ppLoad(child) {
    if (!_ppState) {
        try { _ppState = await loadProgramSettings(); }
        catch (e) { console.warn('programs:', e); return; }
    }
    ppRender(child);
}

function ppSetup() {
    if (_ppBound) return;
    const wrap = ppEl('ptPrograms');
    if (!wrap) return;
    _ppBound = true;
    // Day chips are a preview of the shape, not a booking — they toggle so
    // a parent can see what they would be choosing, and the card says
    // plainly that nothing is saved. When program_enrollments exists, this
    // is the one listener that has to start writing.
    wrap.addEventListener('click', (ev) => {
        const day = ev.target.closest('[data-pp-day]');
        if (day) day.classList.toggle('is-on');
    });
}
