// ============================================================
// MODULE: Before & After Care  (design handoff: Capacity & Fill, 5a)
// ============================================================
// Classrooms → Daily → Before & After Care.
//
// ── ⚠️ BEFORE AND AFTER CARE IS NOT A ROOM ──────────────────
// Andrew, correcting an earlier version of this screen:
//
//     "the pre-k before care and after care is not a room, just a charge
//      that is applied if a child attends."
//
// That sentence rules out most of what a room screen would show. There is
// no enrolment, so there is no roster to draw before the day starts. There
// is no reservation, so there are no seats to count down and no "5 spots
// left" to put in a stat tile. Nobody is turned away at a capacity line,
// because there is no line — a child attends, and a charge follows.
//
// What survives is two genuinely different things, and this screen keeps
// them apart on purpose:
//
//   1. WHO IS SUPERVISED RIGHT NOW. Ratio is licensing law and applies to
//      any group of children however it is billed. A staffing fact.
//   2. WHAT IS OWED. One charge per child per session attended. A billing
//      fact, and the whole of what the program is.
//
// ── The afternoon floor IS real, and this is why ────────────
// Goose, Turtle and Owl physically combine into one supervised group from
// 1:00p — PM_COMBINED_ROOM_IDS, with PM_COMBINED_RATIO as its pooled
// ratio, both already in js/supabase.js and already read by apStaffing(),
// Build Staff Schedule and the Attendance Board's ratio watch. A full-day
// booking in one of those three rooms IS a child on that floor.
//
// That floor is the MDO day, not the after-care program. This screen shows
// it because it is who the teacher is actually watching at 3:00 — not
// because those children are "enrolled in after care." It does not invent
// a second definition of the afternoon.
//
// Hours and rate come from settings.programs (Settings → Programs &
// add-ons), so the office changes them in one place. Capacity is NOT read
// here, and the daily programs no longer carry one: a seat you cannot
// reserve is not a seat.
//
// ── ⚠️ THE CHARGE HAS NOWHERE TO LAND YET ───────────────────
// A charge needs a record that a child attended, and myMDO has no such
// record for before or after care. Billing runs off `registration_dates` —
// a day BOOKED in a room — and nobody books a morning at 7:30.
//
// So the missing piece is exactly one table: this child, this program,
// this date, this rate. The proposed shape is written up as a migration
// source file (supabase/migrations/PROPOSED_before_after_care_charges.sql)
// which is NOT applied — per AGENTS.md, migrations there are source records
// applied by hand, and a schema change needs Andrew's explicit approval.
//
// Pre-K children need nothing more than that table plus a `students` row.
// They have no registration, so room capacity, the ratio math for a room,
// the waitlist and the fill forecast — all of which read `registrations`
// and `registration_dates` — correctly never see them. Nothing has to
// remember to exclude them.
//
// Until then this screen shows the MDO afternoon truthfully and names the
// gap, rather than rendering charges nobody has recorded.

let _bacDate  = null;
let _bacBound = false;
let _bacPrograms = null;

function _bacEl(id) { return document.getElementById(id); }

function _bacToday() { return new Date().toLocaleDateString('en-CA'); }

function _bacProgram(id) {
    return (_bacPrograms?.programs || []).find(p => p.id === id) || null;
}

function _bacTime(hhmm) {
    if (!hhmm) return '';
    const [h, m] = String(hhmm).split(':').map(Number);
    const ampm = h >= 12 ? 'p.m.' : 'a.m.';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

/**
 * The pooled afternoon group for a date — the SAME rule apStaffing() uses
 * for its After Care row: full-day children only, across
 * PM_COMBINED_ROOM_IDS, because a half-day booking is a morning slot that
 * has gone home by the time the three rooms combine.
 */
function _bacAfternoonFloor(date) {
    const closed = typeof allClosureDates !== 'undefined' && allClosureDates.has(date);
    const kids = [];
    if (!closed) {
        (allRegistrations || []).forEach(reg => {
            (reg.registration_dates || []).forEach(d => {
                if (d.waitlisted || d.care_date !== date) return;
                const roomId = d.room_id || reg.room_id;
                if (!PM_COMBINED_ROOM_IDS.includes(roomId)) return;
                if ((d.day_type || 'full') === 'half') return;   // gone before 1:00p
                kids.push({
                    name: reg.child_name,
                    roomId,
                    roomLabel: (typeof ROOMS !== 'undefined' &&
                        ROOMS.find(r => r.id === roomId)?.label) || roomId,
                });
            });
        });
    }
    kids.sort((a, b) => a.roomLabel.localeCompare(b.roomLabel) || a.name.localeCompare(b.name));

    const program = _bacProgram('after_care');
    const ratio = PM_COMBINED_RATIO;
    const present = kids.length;
    const adults = present > 0 ? Math.ceil(present / ratio) : 0;
    // How many more before ceil() steps up — the same "next child costs an
    // adult" arithmetic the teacher's ratio bar and the release grid use.
    //
    // ⚠️ There is deliberately no seatsLeft here. A seat implies a booking,
    // and nobody books before or after care; the number that limits the
    // afternoon is staffing, not a capacity line. Counting down to a cap
    // nobody reserves against would invent a queue that does not exist.
    const beforeNextAdult = ratio > 0 ? (adults * ratio) - present : null;

    return { closed, kids, present, ratio, adults, beforeNextAdult, program };
}

function _bacMorning(date) {
    const program = _bacProgram('before_care');
    // ⚠️ Before care has no record of any kind — unlike the afternoon, there
    // is no registration day_type that means "came in at 7:30", and there is
    // no booking to read because none is made. Hours and rate from the
    // programs document, and nothing else.
    return { program };
}

// ── Render ──────────────────────────────────────────────────
function _bacFloorHtml(f) {
    if (f.closed) {
        return `<div class="ap-panel"><div class="ap-panel-head">
            <h3>Closed today</h3><p>No care, and nothing to staff.</p></div></div>`;
    }
    const p = f.program;
    const edge = f.beforeNextAdult === 0;

    const rows = f.kids.length ? f.kids.map(k => `
        <div class="bac-row">
            <span class="bac-avatar">${escHtml((k.name || '?').trim()[0] || '?')}</span>
            <span class="bac-name">${escHtml(k.name)}</span>
            <span class="bac-room">${escHtml(k.roomLabel)}</span>
            <span class="bac-tag">MDO</span>
        </div>`).join('')
        : '<p class="empty-hint">Nobody is booked a full day in the three combining rooms today.</p>';

    return `
        <div class="ap-panel">
            <div class="ap-panel-head">
                <h3>🌆 ${escHtml(p?.label || 'After care')} · ${escHtml(_bacTime(p?.startTime))} – ${escHtml(_bacTime(p?.endTime))}</h3>
                <p>Goose, Turtle and Owl combine into one supervised group. Every child booked a FULL day in those rooms is on this floor — a half day has gone home before the rooms combine, which is the same rule the staffing grid applies.</p>
            </div>
            <div class="bac-list">${rows}</div>
        </div>`;
}

function _bacHeadroomHtml(f) {
    const edge = f.beforeNextAdult === 0;
    return `
        <div class="ap-panel${edge ? ' bac-edge' : ''}">
            <div class="ap-panel-head">
                <h3>Staffing the floor</h3>
                <p>Ratio is the law, whatever the billing says. This is the number that decides whether another adult is needed &mdash; there is no seat count, because nobody reserves a place.</p>
            </div>
            <div class="bac-rows">
                <div class="bac-stat"><span>Ratio</span><strong>1:${f.ratio}</strong></div>
                <div class="bac-stat"><span>On the floor</span><strong>${f.present}</strong></div>
                <div class="bac-stat"><span>Adults needed</span><strong class="${edge ? 'is-warn' : ''}">${f.adults || '—'}</strong></div>
            </div>
            <div class="bac-note${edge ? ' is-edge' : ''}">
                ${edge
                    ? `One more child needs another adult on the floor.`
                    : f.beforeNextAdult != null
                        ? `${f.beforeNextAdult} more before another adult is needed.`
                        : 'No ratio set for this program.'}
            </div>
        </div>`;
}

function _bacMorningHtml(m) {
    const p = m.program;
    if (!p) return '';
    return `
        <div class="ap-panel">
            <div class="ap-panel-head">
                <h3>🌅 ${escHtml(p.label)} · ${escHtml(_bacTime(p.startTime))} – ${escHtml(_bacTime(p.endTime))}</h3>
                <p>$${p.rate} a morning, staffed at 1:${p.ratio || '—'}.</p>
            </div>
            <div class="bac-gap bac-gap-soft">
                <strong>Who came this morning isn't recorded.</strong>
                Unlike the afternoon — where a full-day booking IS a child on the combined floor — there is no row anywhere that means "arrived at 7:30". The hours and rate above are real; the register that turns a morning into a charge is the piece that has to be built.
            </div>
        </div>`;
}

function _bacPrekHtml() {
    return `
        <div class="ap-panel bac-prek">
            <div class="ap-panel-head">
                <h3>Who attended, and what it cost</h3>
                <p>Before and after care is not a room and nobody enrolls in it. A child attends, and a charge follows. This is the register of that &mdash; including the Timothy Lutheran Pre-K children who use the care and never the MDO program.</p>
            </div>
            <div class="bac-gap">
                <strong>It is empty because nothing records the attendance.</strong>
                Billing here runs off a day <em>booked</em> in a room, and nobody books a morning at 7:30. There is no table that says a child was here, so there is nothing to charge from &mdash; for MDO children or Pre-K ones.
            </div>
            <div class="bac-spec">
                <div class="bac-spec-title">What it needs, precisely</div>
                <ul class="bac-spec-list">
                    <li><strong>One table, and it is a charge.</strong> Child, program, date, rate as charged. A row exists because a child attended; no row means nothing is owed. No booking, so no billed-versus-booked gap to reconcile.</li>
                    <li><strong>The rate copied in, not looked up later.</strong> A price change in October must not silently re-price September.</li>
                    <li><strong>A waived session stays visible</strong>, with its reason, rather than vanishing. A charge that disappears is one nobody can ask about later.</li>
                </ul>
                <p class="bac-spec-note">A Pre-K child needs that table, a child record and a family to bill &mdash; nothing else. With no registration, room capacity, a room's ratio math, the waitlist and the fill forecast never see them, because every one of those reads registrations. And because every family is billed directly, a Pre-K family goes through the same statements, balances and payment screens as everyone else &mdash; there is no second billing mode to build or maintain.</p>
                <p class="bac-spec-note"><strong>A child nobody has on file can still be taken in.</strong> The door kiosk creates a provisional family from a staff PIN &mdash; the teacher's, not the parent's &mdash; so the charge has somewhere to land immediately. That record is deliberately unfinished: no email, no login, and a cap of two sessions before the kiosk stops and sends the family to the office. Two of its details are safety rather than billing, and the office owns both &mdash; the child's allergies are <em>unknown</em>, not &ldquo;none&rdquo;, and photo release is set to no until somebody actually asks.</p>
                <p class="bac-spec-note">The shape is written up in <code>supabase/migrations/PROPOSED_before_after_care_charges.sql</code>. It is <strong>not applied</strong> &mdash; per <code>AGENTS.md</code>, migrations in that folder are source records applied by hand, and a schema change on a live childcare system needs Andrew's explicit approval first.</p>
            </div>
        </div>`;
}

function _bacInvoiceHtml(f) {
    const p = f.program;
    const fees = _bacPrograms?.fees || {};
    return `
        <div class="ap-panel">
            <div class="ap-panel-head">
                <h3>Month-end invoices</h3>
                <p><strong>Every family is billed directly</strong> &mdash; Pre-K families included, on their own invoice, not one consolidated bill to the Pre-K office. Charges are added up from what was actually recorded, so there is no "billed versus booked" gap to reconcile.</p>
            </div>
            <div class="bac-rows">
                <div class="bac-stat"><span>Afternoon rate</span><strong>$${p?.rate ?? '—'}</strong></div>
                <div class="bac-stat"><span>Morning rate</span><strong>$${_bacProgram('before_care')?.rate ?? '—'}</strong></div>
                <div class="bac-stat"><span>Late pickup, per 15 min</span><strong>$${fees.latePickupPer15Min ?? '—'}</strong></div>
            </div>
            <div class="bac-gap bac-gap-soft">
                <strong>Nothing to invoice yet.</strong>
                The rates above are live, from Settings → Programs &amp; add-ons. The run itself adds up the charges recorded for the month, and that table does not exist — so this would produce an empty invoice for every family however it were built.
            </div>
        </div>`;
}

async function renderBeforeAfterCareTool() {
    const body = _bacEl('bacBody');
    if (!body) return;
    if (!_bacDate) _bacDate = _bacToday();
    body.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        if (!_bacPrograms) _bacPrograms = await loadProgramSettings();
        if (typeof allRegistrations !== 'undefined' && !allRegistrations.length) {
            allRegistrations = await fetchAllRegistrations().catch(() => []);
        }

        const f = _bacAfternoonFloor(_bacDate);
        const m = _bacMorning(_bacDate);
        const label = new Date(_bacDate + 'T00:00:00')
            .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });

        body.innerHTML = `
            <div class="bac-toolbar">
                <label class="bac-ctrl">
                    <span>Date</span>
                    <input type="date" id="bacDate" value="${escHtml(_bacDate)}">
                </label>
                <span class="bac-day">${escHtml(label)}</span>
                <button type="button" class="ap-pill" data-ap-go="settingsHub">Rates &amp; hours →</button>
            </div>
            <div class="bac-cols">
                <div class="bac-col">
                    ${_bacFloorHtml(f)}
                    ${_bacMorningHtml(m)}
                    ${_bacPrekHtml()}
                </div>
                <div class="bac-col">
                    ${_bacHeadroomHtml(f)}
                    ${_bacInvoiceHtml(f)}
                </div>
            </div>`;

        _bacEl('bacDate')?.addEventListener('change', (e) => {
            _bacDate = e.target.value || _bacToday();
            renderBeforeAfterCareTool();
        });
    } catch (e) {
        console.warn('renderBeforeAfterCareTool:', e);
        body.innerHTML = `<p class="empty-hint">Could not load: ${escHtml(e.message || String(e))}</p>`;
    }
}

function setupBeforeAfterCareTool() {
    if (_bacBound) return;
    _bacBound = true;
    // The date control is bound per render; nothing else here is
    // interactive, because nothing on this screen writes.
}
