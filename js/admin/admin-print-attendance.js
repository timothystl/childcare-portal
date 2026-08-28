// ============================================================
// admin-print-attendance — blank paper sign-in/sign-out sheet
// ============================================================
// A different artifact from Classroom Roster's print grid (a reference list,
// no signature lines) and from the Attendance Board's live In/Out marking
// (digital, updates the same child_day_events the teacher app writes to).
// This is the paper backup every licensed center still needs at the door:
// one row per booked child, blank Time In/Out and a parent/guardian
// signature line for each, filled by hand at drop-off and pickup.

let _paBound = false;

function _paEl(id) { return document.getElementById(id); }

function populatePrintAttendanceRoomFilter() {
    const sel = _paEl('paRoomFilter');
    if (!sel) return;
    getSortedRooms().filter(r => r.status !== 'coming_soon').forEach(r => {
        const opt = document.createElement('option');
        opt.value       = r.id;
        opt.textContent = r.label;
        sel.appendChild(opt);
    });
}

function _paDateLabel(dateStr) {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US',
        { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
}

// One sheet per room: the room itself, its booked roster for the date, and
// who is clocked into it right now (same center_headcount_rows() staff join
// the Attendance Board reads — never a second query for "who's on shift").
function _paBuildSheets(date, roomId, staffByRoom) {
    const rooms = getSortedRooms()
        .filter(r => r.status !== 'coming_soon' && (!roomId || r.id === roomId));

    return rooms
        .map(room => ({
            room,
            roster: getRosterForDate(date, room.id),
            staffNames: (staffByRoom[room.id] || []).join(' · '),
        }))
        // "All rooms" skips rooms nobody's booked into today (nothing to sign
        // for), but a room picked explicitly always shows, even empty —
        // the office may be printing ahead for a room about to open.
        .filter(s => roomId || s.roster.length);
}

function _paSheetHtml(dateLabel, s) {
    const ratio = Number(s.room.staffRatio) || null;
    const rows = s.roster.length
        ? s.roster.map(r => `<tr>
            <td>${escHtml(r.childName)}</td>
            <td class="pa-blank-cell"></td>
            <td class="pa-blank-cell"></td>
            <td class="pa-blank-cell"></td>
            <td class="pa-blank-cell"></td>
        </tr>`).join('')
        : `<tr><td colspan="5" class="pa-empty">No children currently booked for this date.</td></tr>`;

    return `
        <div class="pa-sheet">
            <div class="pa-sheet-head">
                <div>
                    <div class="pa-org">Timothy Lutheran MDO</div>
                    <div class="pa-room-title">${escHtml(s.room.label)} &mdash; Daily Attendance</div>
                </div>
                <div class="pa-meta">
                    <div>Date: <strong>${escHtml(dateLabel)}</strong></div>
                    <div>Staff: ${escHtml(s.staffNames || '—')}</div>
                    <div>${ratio ? `Ratio 1:${ratio} &middot; ` : ''}Capacity ${escHtml(String(s.room.capacity ?? '—'))}</div>
                </div>
            </div>
            <table class="pa-table">
                <thead>
                    <tr>
                        <th>Child's Name</th>
                        <th>Time In</th>
                        <th>Parent/Guardian Signature (In)</th>
                        <th>Time Out</th>
                        <th>Parent/Guardian Signature (Out)</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
            <div class="pa-sheet-foot">
                <div>Staff signature: <span class="pa-blank-line"></span></div>
                <div>Children present: <span class="pa-blank-short"></span> / ${s.roster.length}</div>
            </div>
        </div>`;
}

async function renderPrintAttendanceTool() {
    const wrap = _paEl('paPreview');
    if (!wrap) return;
    wrap.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        const board = await centerHeadcountAdmin();
        if (!board) { wrap.innerHTML = '<p class="empty-hint">Only the office can open this tool.</p>'; return; }
        if (typeof allRegistrations !== 'undefined' && !allRegistrations.length) {
            allRegistrations = await fetchAllRegistrations().catch(() => []);
        }

        const staffByRoom = {};
        (board.staff || []).forEach(st => {
            const rid = st.room_id || 'unassigned';
            (staffByRoom[rid] = staffByRoom[rid] || []).push(st.staff_name);
        });

        const roomId    = _paEl('paRoomFilter')?.value || '';
        const dateLabel = _paDateLabel(board.care_date);
        const sheets    = _paBuildSheets(board.care_date, roomId, staffByRoom);

        wrap.innerHTML = sheets.length
            ? sheets.map(s => _paSheetHtml(dateLabel, s)).join('')
            : '<p class="empty-hint">Nobody is booked for this date.</p>';
    } catch (e) {
        wrap.innerHTML = `<p class="empty-hint">Could not load: ${escHtml(e.message || e)}</p>`;
    }
}

// The printed copy is its own standalone document — same "open a new window,
// write the full HTML, print()" pattern _printDayRoster/_printWeekRoster
// (admin-classrooms.js) already use, rather than print-scoping the whole
// admin shell around one tool's preview.
function printAttendanceSheets() {
    const wrap = _paEl('paPreview');
    const allSheets = wrap ? Array.from(wrap.querySelectorAll('.pa-sheet')) : [];
    if (!allSheets.length) { alert('Nothing to print — no children booked for this date.'); return; }

    const pages = allSheets.map((el, i) =>
        `<div class="pa-print-page${i > 0 ? ' pa-page-break' : ''}">${el.outerHTML}</div>`).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Print Attendance</title>
<style>${_PA_PRINT_STYLE}</style>
</head>
<body>
  ${pages}
  <script>window.addEventListener('load', function() { window.print(); });<\/script>
</body>
</html>`;

    const w = window.open('', '_blank');
    if (!w) { alert('Pop-up was blocked. Please allow pop-ups for this site and try again.'); return; }
    w.document.write(html);
    w.document.close();
}

const _PA_PRINT_STYLE = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: portrait; margin: 0.5in; }
  body { font-family: Arial, Helvetica, sans-serif; color: #111; font-size: 10pt; }
  .pa-print-page.pa-page-break { page-break-before: always; }
  .pa-sheet-head {
    display: flex; justify-content: space-between; align-items: flex-start;
    border-bottom: 2px solid #01294A; padding-bottom: 8px; margin-bottom: 12px;
  }
  .pa-org { font-size: 15pt; font-weight: 700; color: #01294A; }
  .pa-room-title { font-size: 11pt; font-weight: 600; margin-top: 2px; }
  .pa-meta { text-align: right; font-size: 9pt; line-height: 1.5; }
  .pa-table { width: 100%; border-collapse: collapse; }
  .pa-table th, .pa-table td { border: 1px solid #ccc; padding: 8px 10px; text-align: left; font-size: 9.5pt; }
  .pa-table th { background: #f2f2f2; font-weight: 700; }
  .pa-blank-cell { height: 32px; }
  .pa-empty { text-align: center; color: #999; font-style: italic; padding: 16px; }
  .pa-sheet-foot {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-top: 16px; font-size: 10pt;
  }
  .pa-blank-line { display: inline-block; width: 220px; border-bottom: 1px solid #333; }
  .pa-blank-short { display: inline-block; width: 40px; border-bottom: 1px solid #333; }
`;

function setupPrintAttendance() {
    if (_paBound) return;
    _paBound = true;
    _paEl('paRoomFilter')?.addEventListener('change', renderPrintAttendanceTool);
    _paEl('paPrintBtn')?.addEventListener('click', printAttendanceSheets);
}
