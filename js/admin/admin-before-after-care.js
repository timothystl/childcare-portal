// ============================================================
// MODULE: Before & After Care  (design handoff: Capacity & Fill, 5a)
// ============================================================
// Classrooms → Daily → Before & After Care. The program's own floor: who
// is on it this afternoon, and how many more children can walk in before
// the ratio needs another adult.
//
// ── The afternoon floor IS real, and this is why ────────────
// Goose, Turtle and Owl physically combine into one supervised group from
// 1:00p — PM_COMBINED_ROOM_IDS, with PM_COMBINED_RATIO as its pooled
// ratio, both already in js/supabase.js and already read by apStaffing(),
// Build Staff Schedule and the Attendance Board's ratio watch. A full-day
// booking in one of those three rooms IS a child on that floor.
//
// So this screen can answer the number that does the real work — "how many
// more can still walk in" — from registrations that already exist, using
// the same pooled rule every staffing screen uses. It does not invent a
// second definition of the afternoon.
//
// Hours, rate and capacity come from the `after_care` program in
// settings.programs (Settings → Programs & add-ons), so the office changes
// them in one place.
//
// ── ⚠️ THE PRE-K HALF DOES NOT EXIST YET ────────────────────
// The handoff's second group — Timothy Lutheran Pre-K children who use the
// care and never the program — has no record of any kind in myMDO. By
// design they must have:
//
//   * a family and child record, with guardians, allergies and a pickup
//     list, the same as anyone else;
//   * an enrolment in a PROGRAM rather than a room, so they never touch
//     room capacity, the ratio math for a room, the waitlist or the fill
//     forecast;
//   * an attendance row per session used, because nothing is booked ahead
//     — the check-in IS the record;
//   * a monthly invoice counted off that attendance.
//
// None of those tables exist. The proposed shape is written up as a
// migration source file (supabase/migrations/PROPOSED_program_enrolments
// _and_attendance.sql) which is NOT applied — see AGENTS.md: migrations in
// that folder are source records, applied by hand, and a schema change
// needs Andrew's explicit approval.
//
// Until then this screen shows the MDO afternoon truthfully and names the
// Pre-K gap, rather than rendering a roster of invented children that a
// director might act on.

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
    const capacity = Number(program?.capacity) || 0;
    const ratio = PM_COMBINED_RATIO;
    const present = kids.length;
    const adults = present > 0 ? Math.ceil(present / ratio) : 0;
    // How many more before ceil() steps up — the same "next child costs an
    // adult" arithmetic the teacher's ratio bar and the release grid use.
    const beforeNextAdult = ratio > 0 ? (adults * ratio) - present : null;
    const seatsLeft = capacity ? Math.max(0, capacity - present) : null;

    return { closed, kids, present, capacity, ratio, adults, beforeNextAdult, seatsLeft, program };
}

function _bacMorning(date) {
    const program = _bacProgram('before_care');
    // ⚠️ Before care has no booking record at all — unlike the afternoon,
    // there is no registration day_type that means "came in at 7:30". It is
    // capacity and hours from the programs document and nothing else.
    return { program, capacity: Number(program?.capacity) || 0 };
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
                <h3>Walk-in headroom</h3>
                <p>Nobody books the afternoon ahead, so this is the only number protecting the ratio.</p>
            </div>
            <div class="bac-rows">
                <div class="bac-stat"><span>Room for</span><strong>${f.capacity || '—'} at 1:${f.ratio}</strong></div>
                <div class="bac-stat"><span>On the floor</span><strong>${f.present}</strong></div>
                <div class="bac-stat"><span>Seats left</span><strong class="${f.seatsLeft === 0 ? 'is-warn' : 'is-ok'}">${f.seatsLeft == null ? '—' : f.seatsLeft}</strong></div>
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
                <p>Room for ${m.capacity || '—'} at 1:${p.ratio || '—'}, at $${p.rate} a morning.</p>
            </div>
            <div class="bac-gap bac-gap-soft">
                <strong>Who came this morning isn't recorded.</strong>
                Unlike the afternoon — where a full-day booking IS a child on the combined floor — there is no booking or attendance row that means "arrived at 7:30". The hours, rate and capacity above are real; the register is the piece that has to be built.
            </div>
        </div>`;
}

function _bacPrekHtml() {
    return `
        <div class="ap-panel bac-prek">
            <div class="ap-panel-head">
                <h3>Pre-K children on file</h3>
                <p>The second group this program serves: Timothy Lutheran Pre-K children who use the care and never the MDO program.</p>
            </div>
            <div class="bac-gap">
                <strong>There are none, because there is nowhere to put them.</strong>
                A Pre-K child needs a family and child record like anyone else, but an enrolment in a <em>program</em> rather than a room — so they never touch room capacity, a room's ratio math, the waitlist or the fill forecast. That does not exist in myMDO today, so this list would be empty however it were drawn.
            </div>
            <div class="bac-spec">
                <div class="bac-spec-title">What it needs, precisely</div>
                <ul class="bac-spec-list">
                    <li><strong>program_enrolments</strong> — a child in a program rather than a room, so capacity and the waitlist never see them.</li>
                    <li><strong>program_attendance</strong> — one row per session actually used. Nothing is booked ahead, so the check-in IS the record and there is no billed-versus-booked gap to reconcile.</li>
                    <li><strong>A provisional flag</strong> — a name taken at the door is a real child in the ratio and a real line on the invoice, but badged unfinished until the office closes the file.</li>
                </ul>
                <p class="bac-spec-note">The shape is written up in <code>supabase/migrations/PROPOSED_program_enrolments_and_attendance.sql</code>. It is <strong>not applied</strong> — per <code>AGENTS.md</code>, migrations in that folder are source records applied by hand, and a schema change on a live childcare system needs Andrew's explicit approval first.</p>
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
                <p>One invoice per family, counted straight off the check-in record — so there is no "billed versus booked" gap to reconcile.</p>
            </div>
            <div class="bac-rows">
                <div class="bac-stat"><span>Afternoon rate</span><strong>$${p?.rate ?? '—'}</strong></div>
                <div class="bac-stat"><span>Morning rate</span><strong>$${_bacProgram('before_care')?.rate ?? '—'}</strong></div>
                <div class="bac-stat"><span>Late pickup, per 15 min</span><strong>$${fees.latePickupPer15Min ?? '—'}</strong></div>
            </div>
            <div class="bac-gap bac-gap-soft">
                <strong>Nothing to invoice yet.</strong>
                The rates above are live, from Settings → Programs &amp; add-ons. The run itself counts sessions out of <code>program_attendance</code>, which is the table that does not exist — so this would produce an empty invoice for every family however it were built.
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
