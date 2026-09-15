// ============================================================
// MODULE: Sign-in & sign-out record  (design handoff: 4b)
// ============================================================
// Classrooms → Daily → Sign-in & Sign-out Record. One row per child per
// day: when they arrived, when they left, and who signed for them.
//
// This is the licensing artifact. Today it exists only on paper —
// admin-print-attendance.js prints a blank sheet precisely BECAUSE there
// is no digital record of who handed a child over. The kiosk (kiosk.html)
// is the other half of closing that gap.
//
// ── What is real ────────────────────────────────────────────
// The attendance itself, from two reads that each do one job:
//
//   who was here   `center_headcount_admin` — the same RPC behind the
//                  Attendance Board, identical body
//                  (center_headcount_rows), so this screen and the board
//                  cannot disagree about who was in the building.
//   what times     `child_day_events` for the date, first check_in and
//                  last check_out per child. The head-count RPC carries
//                  only `attendance_status` and one `last_event_at`,
//                  because it answers "who is here right now" — it has no
//                  separate in and out, and asking it for two timestamps
//                  it does not have would render a dash in every row and
//                  look like missing attendance rather than a wrong query.
//
// ── ⚠️ THE SIGNATURE COLUMN IS THE POINT, AND IT IS EMPTY ───
// There is no signature anywhere in this database: no column, no table,
// no storage bucket. So every row here reads "Teacher marked in — no
// signature", which is not a placeholder — it is the true state of the
// record today, and it is exactly the row the handoff draws in coral as
// the one licensing would query.
//
// That is why this screen is worth shipping before the kiosk writes
// anything: it makes the gap countable. A director can see that 43 of 46
// children were marked in by a member of staff with nobody's signature
// against them, which is the argument for building the rest.
//
// The export is deliberately NOT built. An export implies the file is the
// record, and a PDF of "no signature" forty-six times is not a record —
// it is a liability with a letterhead. Print Attendance still produces the
// paper sheet that IS the record until the kiosk writes.

let _srDate  = null;
let _srRoom  = '';
let _srBound = false;
let _srData  = null;

function _srEl(id) { return document.getElementById(id); }

function _srToday() { return new Date().toLocaleDateString('en-CA'); }

function _srTime(iso) {
    if (!iso) return null;
    const d = new Date(iso);
    if (isNaN(d)) return null;
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        .replace(' ', '').toLowerCase();
}

function _srRoomLabel(roomId) {
    if (typeof getSortedRooms !== 'function') return roomId || '—';
    return getSortedRooms().find(r => r.id === roomId)?.label || roomId || '—';
}

/**
 * One row per child on the board, with the first arrival and last departure
 * actually recorded that day.
 *
 * ⚠️ The times come from the EVENTS, not from the head-count RPC.
 * `center_headcount_admin` carries `attendance_status` and a single
 * `last_event_at` because it answers "who is in the building right now";
 * it has no separate in and out. Reading it for two timestamps it does not
 * have would have rendered a dash in every row and looked like missing
 * data rather than a wrong query.
 *
 * `attendance_status`, not `checked_in` — the latter is EXISTS(check_in)
 * and stays true all afternoon after a child has gone home, the same trap
 * js/staff/staff-log.js records in its own comment.
 */
function _srRows(board, events) {
    const firstIn = new Map(), lastOut = new Map();
    (events || []).forEach(e => {
        const id = String(e.student_id);
        if (e.event_type === 'check_in') {
            if (!firstIn.has(id)) firstIn.set(id, e.occurred_at);   // ordered ascending
        } else {
            lastOut.set(id, e.occurred_at);                          // keep overwriting
        }
    });

    const kids = (board?.children || board?.kids || []);
    return kids.map(c => {
        const id = String(c.student_id ?? c.id ?? '');
        const status = c.attendance_status || (c.checked_in ? 'present' : 'not_arrived');
        return {
            name: c.child_name || c.name || 'Child',
            roomId: c.room_id,
            inAt: _srTime(firstIn.get(id)),
            outAt: _srTime(lastOut.get(id)),
            status,
        };
    }).sort((a, b) =>
        (a.roomId || '').localeCompare(b.roomId || '') || a.name.localeCompare(b.name));
}

function _srRowHtml(r) {
    const arrived = r.status === 'present' || r.status === 'left';
    return `
        <div class="sr-row${arrived ? '' : ' is-absent'}">
            <div class="sr-child">
                <span class="sr-avatar">${escHtml((r.name || '?').trim()[0] || '?')}</span>
                <span class="sr-name">${escHtml(r.name)}</span>
            </div>
            <span class="sr-room">${escHtml(_srRoomLabel(r.roomId))}</span>
            <span class="sr-time">${r.inAt ? escHtml(r.inAt) : '—'}</span>
            <span class="sr-time">${r.outAt ? escHtml(r.outAt) : '—'}</span>
            <span class="sr-sig${arrived ? ' is-missing' : ''}">${arrived
                ? 'Teacher marked in — no signature'
                : 'Not in today'}</span>
        </div>`;
}

async function renderSignatureRecordTool() {
    const body = _srEl('srBody');
    if (!body) return;
    if (!_srDate) _srDate = _srToday();
    body.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        const [board, events] = await Promise.all([
            centerHeadcountAdmin(_srDate),
            fetchAttendanceEventsForDate(_srDate).catch(() => []),
        ]);
        if (!board) { body.innerHTML = '<p class="empty-hint">Only the office can open this record.</p>'; return; }
        _srData = board;

        const all = _srRows(board, events);
        const rows = _srRoom ? all.filter(r => r.roomId === _srRoom) : all;
        const arrived = rows.filter(r => r.status === 'present' || r.status === 'left');
        const out = arrived.filter(r => r.outAt);

        const roomOpts = getSortedRooms().filter(r => !r.hidden)
            .map(r => `<option value="${r.id}"${_srRoom === r.id ? ' selected' : ''}>${escHtml(r.label)}</option>`).join('');

        body.innerHTML = `
            <div class="sr-toolbar">
                <label class="sr-ctrl">
                    <span>Date</span>
                    <input type="date" id="srDate" value="${escHtml(_srDate)}">
                </label>
                <label class="sr-ctrl">
                    <span>Room</span>
                    <select id="srRoom"><option value="">All rooms</option>${roomOpts}</select>
                </label>
                <button type="button" class="ap-pill" data-ap-go="printAttendance">🖨️ Print the paper sheet</button>
            </div>

            <div class="sr-stats">
                <div class="sr-stat">
                    <span class="sr-stat-label">Signed in</span>
                    <span class="sr-stat-n">${arrived.length} of ${rows.length}</span>
                </div>
                <div class="sr-stat is-gap">
                    <span class="sr-stat-label">With a signature</span>
                    <span class="sr-stat-n">0</span>
                </div>
                <div class="sr-stat">
                    <span class="sr-stat-label">Signed out</span>
                    <span class="sr-stat-n">${out.length}</span>
                </div>
            </div>

            <!-- ⚠️ Not a placeholder. Zero is the true figure: nothing in
                 this database stores a signature. See the module header. -->
            <div class="sr-gap">
                <strong>No signature in this system has ever been captured.</strong>
                There is no column, no table and no bucket for one — so every row below reads the same way, and that is the record as it stands rather than a gap in this screen. ${arrived.length} ${arrived.length === 1 ? 'child was' : 'children were'} marked in by a member of staff on this day with nobody's signature against ${arrived.length === 1 ? 'them' : 'them'}. The paper sheet at the door is still the licensed record; the tablet (<code>/kiosk</code>) is the half of this that has to write before this column can fill.
            </div>

            <div class="sr-table">
                <div class="sr-head">
                    <span>Child</span><span>Room</span><span>In</span><span>Out</span><span>Signature</span>
                </div>
                ${rows.length ? rows.map(_srRowHtml).join('')
                    : '<p class="empty-hint">Nobody is booked for this date.</p>'}
            </div>`;

        _srEl('srDate')?.addEventListener('change', (e) => {
            _srDate = e.target.value || _srToday();
            renderSignatureRecordTool();
        });
        _srEl('srRoom')?.addEventListener('change', (e) => {
            _srRoom = e.target.value;
            renderSignatureRecordTool();
        });
    } catch (e) {
        console.warn('renderSignatureRecordTool:', e);
        body.innerHTML = `<p class="empty-hint">Could not load: ${escHtml(e.message || String(e))}</p>`;
    }
}

function setupSignatureRecordTool() {
    if (_srBound) return;
    _srBound = true;
    // Date and room are bound per render (the controls are rewritten each
    // time); nothing else on this screen is interactive, because nothing on
    // it writes.
}
