// ============================================================
// MODULE: Admin Classrooms (classroom roster — Day / Week / Month views)
// ============================================================

// ROSTER — MODE SWITCHING
// ============================================================
// The current week's Monday, as an ISO date string (YYYY-MM-DD).
function _currentWeekMonday() {
    const today = new Date();
    const day   = today.getDay();               // 0=Sun … 6=Sat
    const diff  = (day === 0 ? -6 : 1 - day);    // days back to Mon
    const mon   = new Date(today);
    mon.setDate(today.getDate() + diff);
    return mon.toISOString().split('T')[0];
}

function setupRoster() {
    document.getElementById('rosterViewMode')?.addEventListener('change', updateRosterModeUI);
    updateRosterModeUI();

    // Default week-of to the current Monday
    const weekInput = document.getElementById('rosterWeekOf');
    if (weekInput) weekInput.value = _currentWeekMonday();

    // Default month to the current month
    const monthInput = document.getElementById('rosterMonth');
    if (monthInput) {
        const now = new Date();
        monthInput.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    }

    document.getElementById('viewRosterBtn').addEventListener('click', viewRoster);
    document.getElementById('exportRosterBtn').addEventListener('click', exportRoster);
    document.getElementById('printAllRoomsBtn').addEventListener('click', printAllRoomsRoster);
}

function updateRosterModeUI() {
    const mode = document.getElementById('rosterViewMode')?.value || 'day';
    document.getElementById('rosterDateField')?.classList.toggle('hidden', mode !== 'day');
    document.getElementById('rosterWeekField')?.classList.toggle('hidden', mode !== 'week');
    document.getElementById('rosterMonthField')?.classList.toggle('hidden', mode !== 'month');
    // "Print All Rooms" is a day-only compact one-page grid
    document.getElementById('printAllRoomsBtn')?.classList.toggle('hidden', mode !== 'day');

    // Switching back into Week view should always land on the current week's
    // Monday, not whatever date was left over from a prior visit to this view.
    if (mode === 'week') {
        const weekInput = document.getElementById('rosterWeekOf');
        if (weekInput) weekInput.value = _currentWeekMonday();
    }

    const hint = mode === 'week'
        ? 'Select a week above and click View Roster.'
        : mode === 'month'
            ? 'Select a month above and click View Roster.'
            : 'Select a date above and click View Roster.';
    document.getElementById('rosterContent').innerHTML = `<p class="empty-hint">${hint}</p>`;
}

// ROSTER — SHARED DATA HELPERS
// ============================================================
function getRosterForDate(date, roomId) {
    const results = [];
    allRegistrations.forEach(reg => {
        const d = (reg.registration_dates || []).find(rd => rd.care_date === date && !rd.waitlisted);
        if (!d) return;
        // Use the per-day room_id (falls back to registration room_id for older records)
        const effectiveRoomId = d.room_id || reg.room_id;
        if (roomId && effectiveRoomId !== roomId) return;
        const room = ROOMS.find(r => r.id === effectiveRoomId);
        const rate = d.day_type === 'half' ? room?.halfDayRate : room?.fullDayRate;
        results.push({
            registrationId: reg.id,
            roomLabel:   room?.label || effectiveRoomId,
            roomId:      effectiveRoomId,
            childName:   reg.child_name,
            childDob:    reg.child_dob,
            parentName:  reg.parent_name,
            parentPhone: reg.parent_phone,
            parentEmail: reg.parent_email,
            dayType:     d.day_type || 'full',
            rate:        rate || 0,
        });
    });
    return results.sort((a, b) => a.roomId.localeCompare(b.roomId) || a.childName.localeCompare(b.childName));
}

function _groupRosterByRoom(roster) {
    const byRoom = {};
    roster.forEach(r => {
        if (!byRoom[r.roomLabel]) byRoom[r.roomLabel] = [];
        byRoom[r.roomLabel].push(r);
    });
    return byRoom;
}

// Per-room, per-day child lists for a month, optionally filtered to one room.
function _buildMonthlyRosterRoomSections(monthVal, roomId) {
    const [y, m] = monthVal.split('-').map(Number);
    const monthLabel  = MONTH_NAMES[m - 1] + ' ' + y;
    const daysInMonth = new Date(y, m, 0).getDate();

    const workingDays = [];
    for (let day = 1; day <= daysInMonth; day++) {
        const d   = new Date(y, m - 1, day);
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue;
        const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        workingDays.push({ dateStr, label: `${DAY_ABBR[dow]} ${day}` });
    }
    if (!workingDays.length) return { monthLabel, workingDays, rooms: [] };

    const childrenByRoomDate = {};
    ROOMS.forEach(r => { childrenByRoomDate[r.id] = {}; });

    allRegistrations.forEach(reg => {
        (reg.registration_dates || []).forEach(d => {
            if (d.waitlisted || !d.care_date) return;
            if (!d.care_date.startsWith(monthVal)) return;
            const rId = d.room_id || reg.room_id;
            if (!childrenByRoomDate[rId]) childrenByRoomDate[rId] = {};
            if (!childrenByRoomDate[rId][d.care_date]) childrenByRoomDate[rId][d.care_date] = [];
            childrenByRoomDate[rId][d.care_date].push({
                name:    reg.child_name || '—',
                dayType: d.day_type || 'full',
            });
        });
    });

    const rooms = (roomId ? ROOMS.filter(r => r.id === roomId) : getSortedRooms()).map(room => ({
        room,
        days: workingDays.map(({ dateStr, label }) => {
            const children = (childrenByRoomDate[room.id]?.[dateStr] || [])
                .sort((a, b) => a.name.localeCompare(b.name));
            return { dateStr, label, children, count: children.length, cap: room.capacity };
        }),
    }));

    return { monthLabel, workingDays, rooms };
}

// Mon-Fri grid of a calendar month, with null placeholders for the
// leading/trailing blanks needed to complete each week's row.
function _buildMonthCalendarWeeks(y, m) {
    const daysInMonth = new Date(y, m, 0).getDate();

    const cells = [];
    for (let day = 1; day <= daysInMonth; day++) {
        const dow = new Date(y, m - 1, day).getDay();
        if (dow === 0 || dow === 6) continue;
        cells.push({ day, dateStr: `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}` });
    }
    if (!cells.length) return [];

    const mondayIndex = dow => (dow + 6) % 7; // Mon=0 … Fri=4
    const leading = mondayIndex(new Date(y, m - 1, cells[0].day).getDay());
    const padded  = [...Array(leading).fill(null), ...cells];
    while (padded.length % 5 !== 0) padded.push(null);

    const weeks = [];
    for (let i = 0; i < padded.length; i += 5) weeks.push(padded.slice(i, i + 5));
    return weeks;
}

const _CAL_DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

function _renderMonthlyRosterCalendarHtml(rooms, monthVal, monthLabel) {
    const [y, m] = monthVal.split('-').map(Number);
    const weeks  = _buildMonthCalendarWeeks(y, m);

    return rooms.map(({ room, days }) => {
        const byDate = {};
        days.forEach(d => { byDate[d.dateStr] = d; });

        const weeksHtml = weeks.map(week => `
            <div class="cal-week">
                ${week.map(cell => {
                    if (!cell) return '<div class="cal-cell cal-cell-blank"></div>';
                    const info = byDate[cell.dateStr];
                    if (!info) {
                        return `
                            <div class="cal-cell cal-cell-closed">
                                <span class="cal-day-num">${cell.day}</span>
                            </div>`;
                    }
                    const { count, cap, children } = info;
                    const fullFlag = count >= cap ? ' cal-cell-full' : count >= cap * .8 ? ' cal-cell-near' : '';
                    const childList = children.length
                        ? children.map(c =>
                            `<span class="cal-child${c.dayType === 'half' ? ' cal-child-half' : ''}">${c.dayType === 'half' ? '½ ' : ''}${escHtml(c.name)}</span>`
                          ).join('')
                        : '<span class="cal-empty">—</span>';
                    return `
                        <div class="cal-cell${fullFlag}">
                            <div class="cal-cell-head">
                                <span class="cal-day-num">${cell.day}</span>
                                <span class="cal-count">${count}/${cap}</span>
                            </div>
                            <div class="cal-children">${childList}</div>
                        </div>`;
                }).join('')}
            </div>`).join('');

        return `
            <div class="roster-room-block">
                <div class="roster-room-header">
                    <span class="roster-room-title">${escHtml(room.label)}</span>
                    <span class="roster-room-meta">${monthLabel} &nbsp;·&nbsp; Max ${room.capacity}/day</span>
                </div>
                <div class="cal-grid">
                    <div class="cal-week cal-dow-row">
                        ${_CAL_DOW_LABELS.map(d => `<div class="cal-dow">${d}</div>`).join('')}
                    </div>
                    ${weeksHtml}
                </div>
            </div>`;
    }).join('');
}

// ROSTER — ON-SCREEN VIEW
// ============================================================
function viewRoster() {
    const mode   = document.getElementById('rosterViewMode')?.value || 'day';
    const roomId = document.getElementById('rosterRoomFilter').value || null;

    if (mode === 'week')  return _viewWeekRoster(document.getElementById('rosterWeekOf')?.value, roomId);
    if (mode === 'month') return _viewMonthRoster(document.getElementById('rosterMonth')?.value, roomId);
    return _viewDayRoster(document.getElementById('rosterDate').value, roomId);
}

// ── Attendance marking (Day view only) ──────────────────────
// The day currently on screen and its marks, keyed by registration_id.
// A missing entry means "not yet marked", which is deliberately distinct from
// 'absent' — an unmarked day must never be counted as a no-show.
let _attendanceDate   = null;
let _attendanceMap    = new Map();
let _attendanceByRoom = {};      // roomLabel → kids[], for live tally updates
let _attendanceBound  = false;   // the delegated listener is attached once only

// Present / absent / unmarked tallies for one room's children.
function _attendanceTally(kids) {
    let present = 0, absent = 0;
    kids.forEach(k => {
        const st = _attendanceMap.get(k.registrationId)?.status;
        if (st === 'present') present++;
        else if (st === 'absent') absent++;
    });
    return { present, absent, unmarked: kids.length - present - absent };
}

function _attendanceSummaryHtml(kids) {
    const t = _attendanceTally(kids);
    const parts = [];
    if (t.present)  parts.push(`<span class="att-sum-present">${t.present} in</span>`);
    if (t.absent)   parts.push(`<span class="att-sum-absent">${t.absent} out</span>`);
    if (t.unmarked) parts.push(`<span class="att-sum-unmarked">${t.unmarked} unmarked</span>`);
    return parts.join('<span class="att-sum-sep">·</span>');
}

function _attendanceControlsHtml(k) {
    const st = _attendanceMap.get(k.registrationId)?.status || '';
    const btn = (status, label) =>
        `<button type="button" class="att-btn att-${status}${st === status ? ' is-on' : ''}"
                 data-status="${status}"
                 aria-pressed="${st === status}"
                 title="${st === status ? 'Click again to clear' : `Mark ${label.toLowerCase()}`}">${label}</button>`;
    return `<span class="att-controls" data-reg="${k.registrationId}"
                  data-room="${escHtml(k.roomId)}" data-name="${escHtml(k.childName)}">
                ${btn('present', 'In')}${btn('absent', 'Out')}
            </span>`;
}

async function _viewDayRoster(date, roomId) {
    if (!date) { alert('Please select a date.'); return; }

    const roster    = getRosterForDate(date, roomId);
    const container = document.getElementById('rosterContent');

    if (!roster.length) {
        container.innerHTML = `<p class="empty-hint">No confirmed registrations for ${friendlyShort(date)}.</p>`;
        return;
    }

    // Attendance records what happened, so it can't be taken ahead of time.
    const today    = new Date().toISOString().split('T')[0];
    const markable = date <= today;

    _attendanceDate = date;
    _attendanceMap  = new Map();
    let loadWarning = '';
    if (markable) {
        try {
            _attendanceMap = await fetchAttendanceForDate(date);
        } catch (err) {
            console.warn('fetchAttendanceForDate:', err);
            loadWarning = `<p class="import-error">Couldn't load attendance marks: ${escHtml(err.message)}. The roster below is still accurate; marks may be missing.</p>`;
        }
    }

    const byRoom = _groupRosterByRoom(roster);
    container.innerHTML = `
        <p class="roster-date-heading">${friendlyShort(date)}</p>
        ${loadWarning}
        ${markable
            ? '<p class="att-hint">Tap <strong>In</strong> or <strong>Out</strong> to record who actually came. Tap the lit button again to clear it.</p>'
            : '<p class="att-hint att-hint-future">This date is in the future — attendance can be recorded on or after the care date.</p>'}
        ${Object.entries(byRoom).map(([roomLabel, kids]) => `
            <div class="roster-group">
                <h3 class="roster-room-title">${roomLabel}
                    <span class="roster-count">${kids.length} child${kids.length !== 1 ? 'ren' : ''}</span>
                    ${markable ? `<span class="att-summary" data-room-label="${escHtml(roomLabel)}">${_attendanceSummaryHtml(kids)}</span>` : ''}
                </h3>
                <ul class="name-list">
                    ${kids.map(k => `
                        <li class="name-list-item">
                            <span class="name-list-name">${escHtml(k.childName)}</span>
                            <span class="day-chip ${k.dayType}">${k.dayType === 'half' ? 'Half Day' : 'Full Day'}</span>
                            ${markable ? _attendanceControlsHtml(k) : ''}
                        </li>`).join('')}
                </ul>
            </div>`).join('')}`;

    _attendanceByRoom = byRoom;
    if (markable) _bindAttendanceHandlers(container);
}

// The roster container outlives each render, so this listener is attached
// exactly once — re-binding per render would stack duplicate handlers and fire
// one save per past render. All mutable state is read from module globals.
function _bindAttendanceHandlers(container) {
    if (_attendanceBound) return;
    _attendanceBound = true;

    container.addEventListener('click', async (e) => {
        const btn = e.target.closest('.att-btn');
        if (!btn || !container.contains(btn)) return;

        const wrap  = btn.closest('.att-controls');
        const regId = Number(wrap.dataset.reg);
        const want  = btn.dataset.status;
        const current = _attendanceMap.get(regId)?.status || '';
        // Tapping the lit button clears the mark, back to "not yet marked".
        const next  = current === want ? null : want;

        const buttons = wrap.querySelectorAll('.att-btn');
        buttons.forEach(b => { b.disabled = true; });
        try {
            if (next === null) {
                await clearAttendanceRecord(regId, _attendanceDate);
                _attendanceMap.delete(regId);
            } else {
                await saveAttendanceRecord({
                    registrationId: regId,
                    careDate:       _attendanceDate,
                    roomId:         wrap.dataset.room,
                    childName:      wrap.dataset.name,
                    status:         next,
                });
                _attendanceMap.set(regId, { registration_id: regId, status: next });
            }
            buttons.forEach(b => {
                const on = b.dataset.status === next;
                b.classList.toggle('is-on', on);
                b.setAttribute('aria-pressed', String(on));
            });
            // Refresh the room's tally in place.
            const group = wrap.closest('.roster-group');
            const sumEl = group?.querySelector('.att-summary');
            const label = sumEl?.dataset.roomLabel;
            if (sumEl && _attendanceByRoom[label]) {
                sumEl.innerHTML = _attendanceSummaryHtml(_attendanceByRoom[label]);
            }
        } catch (err) {
            console.error('attendance save:', err);
            alert(`Couldn't save attendance: ${err.message}`);
        } finally {
            buttons.forEach(b => { b.disabled = false; });
        }
    });
}

function _viewWeekRoster(weekOf, roomId) {
    if (!weekOf) { alert('Please select a week.'); return; }
    const weekDates = _buildWeekDates(weekOf);
    const container = document.getElementById('rosterContent');

    if (!weekDates.length) {
        container.innerHTML = `<p class="empty-hint">No open weekdays found for that week.</p>`;
        return;
    }

    container.innerHTML = weekDates.map(date => {
        const roster = getRosterForDate(date, roomId);
        const body = roster.length
            ? Object.entries(_groupRosterByRoom(roster)).map(([roomLabel, kids]) => `
                <div class="roster-group">
                    <h3 class="roster-room-title">${roomLabel}
                        <span class="roster-count">${kids.length} child${kids.length !== 1 ? 'ren' : ''}</span>
                    </h3>
                    <ul class="name-list">
                        ${kids.map(k => `
                            <li class="name-list-item">
                                <span class="name-list-name">${escHtml(k.childName)}</span>
                                <span class="day-chip ${k.dayType}">${k.dayType === 'half' ? 'Half Day' : 'Full Day'}</span>
                            </li>`).join('')}
                    </ul>
                </div>`).join('')
            : '<p class="empty-hint">No confirmed registrations.</p>';
        return `
            <div class="roster-week-day">
                <p class="roster-date-heading">${friendlyShort(date)}</p>
                ${body}
            </div>`;
    }).join('');
}

function _viewMonthRoster(monthVal, roomId) {
    if (!monthVal) { alert('Please select a month.'); return; }
    const { monthLabel, workingDays, rooms } = _buildMonthlyRosterRoomSections(monthVal, roomId);
    const container = document.getElementById('rosterContent');

    if (!workingDays.length) {
        container.innerHTML = `<p class="empty-hint">No weekdays found for ${monthLabel}.</p>`;
        return;
    }

    container.innerHTML = `
        <div class="monthly-roster-wrap">
            <div class="roster-report-header">
                <strong>Timothy Lutheran MDO</strong> — ${escHtml(monthLabel)} Classroom Roster
                <span style="float:right;font-size:.85em;color:#888;">Generated ${new Date().toLocaleDateString()}</span>
            </div>
            ${_renderMonthlyRosterCalendarHtml(rooms, monthVal, monthLabel)}
        </div>`;
}

// ROSTER — PRINT / PDF
// ============================================================
function exportRoster() {
    const mode   = document.getElementById('rosterViewMode')?.value || 'day';
    const roomId = document.getElementById('rosterRoomFilter').value || null;

    if (mode === 'week')  return _printWeekRoster(document.getElementById('rosterWeekOf')?.value, roomId);
    if (mode === 'month') return _printMonthRoster(document.getElementById('rosterMonth')?.value, roomId);
    return _printDayRoster(document.getElementById('rosterDate').value, roomId);
}

// Shared with "Print All Rooms" — compact landscape grid of room tiles,
// one page per day. Print/PDF (day & week) reuses this same layout so all
// three roster print paths look identical; only "Print All Rooms" always
// shows every room regardless of the room filter, the other two respect it.
const _ROSTER_GRID_PRINT_STYLE = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: landscape; margin: 0.4in 0.45in; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    color: #111;
    font-size: 9pt;
  }
  .print-page { width: 10.1in; }
  .print-page.page-break { page-break-before: always; }
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    border-bottom: 2px solid #333;
    padding-bottom: 5px;
    margin-bottom: 8px;
  }
  .page-header h1 { font-size: 12pt; font-weight: 700; }
  .page-header .sub { font-size: 9pt; color: #555; font-weight: 400; }
  .page-header .printed { font-size: 7.5pt; color: #999; }
  .rooms-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 8px 12px;
  }
  .room-block {
    border: 1px solid #ccc;
    border-radius: 3px;
    overflow: hidden;
  }
  .room-header {
    background: #f2f2f2;
    border-bottom: 1px solid #ccc;
    padding: 4px 8px;
  }
  .room-label { font-weight: 700; font-size: 10pt; display: block; }
  .room-count { font-size: 7.5pt; color: #666; }
  .kids-list { padding: 2px 0; }
  .kids-list.two-col {
    columns: 2;
    column-gap: 0;
    padding: 0;
  }
  .kids-list.two-col .kid-row { break-inside: avoid; }
  .kid-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 3px 8px;
    border-bottom: 1px solid #f0f0f0;
    font-size: 9pt;
  }
  .kid-row:last-child { border-bottom: none; }
  .kid-name { font-weight: 500; }
  .day-badge {
    font-size: 7pt;
    font-weight: 700;
    padding: 1px 6px;
    border-radius: 8px;
    letter-spacing: 0.02em;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .day-badge.full { background: #d1fae5; color: #065f46; }
  .day-badge.half { background: #fef3c7; color: #92400e; }
  .empty-room { padding: 5px 8px; color: #bbb; font-size: 8.5pt; }
`;

// Auto-scales each .print-page to fit one printed page (landscape letter,
// 8.5in - 2×0.4in margins = 7.7in printable height), independently per page.
const _ROSTER_GRID_AUTOSCALE_SCRIPT = `
    window.addEventListener('load', function() {
      var PAGE_H = 7.7 * 96;
      var MIN_SCALE = 7 / 9;
      document.querySelectorAll('.print-page').forEach(function(pageEl) {
        var h = pageEl.scrollHeight;
        if (h > PAGE_H) {
          var s = Math.max(PAGE_H / h, MIN_SCALE);
          pageEl.style.transformOrigin = 'top left';
          pageEl.style.transform = 'scale(' + s + ')';
          pageEl.style.width = (10.1 / s) + 'in';
        }
      });
      window.print();
    });
`;

function _rosterGridBlocksHtml(roster, roomId) {
    const roomsToShow = roomId ? ROOMS.filter(r => r.id === roomId) : getSortedRooms();
    return roomsToShow.map(room => {
        const kids = roster.filter(r => r.roomId === room.id)
            .sort((a, b) => a.childName.localeCompare(b.childName));
        const fullCount = kids.filter(k => k.dayType !== 'half').length;
        const halfCount = kids.filter(k => k.dayType === 'half').length;

        const countParts = [];
        if (fullCount) countParts.push(`${fullCount} full`);
        if (halfCount) countParts.push(`${halfCount} half`);
        const countLabel = kids.length
            ? `${kids.length} child${kids.length !== 1 ? 'ren' : ''} (${countParts.join(', ')})`
            : 'No registrations';

        const rows = kids.length
            ? kids.map(k => `
                <div class="kid-row">
                    <span class="kid-name">${escHtml(k.childName)}</span>
                    <span class="day-badge ${k.dayType === 'half' ? 'half' : 'full'}">${k.dayType === 'half' ? 'Half' : 'Full'}</span>
                </div>`).join('')
            : '<div class="empty-room">—</div>';
        const twoCol = kids.length > 12 ? ' two-col' : '';

        return `
            <div class="room-block">
                <div class="room-header">
                    <span class="room-label">${escHtml(room.label)}</span>
                    <span class="room-count">${countLabel}</span>
                </div>
                <div class="kids-list${twoCol}">${rows}</div>
            </div>`;
    }).join('');
}

function _rosterGridPageHtml(dateLabel, roster, roomId, pageBreak) {
    return `
        <div class="print-page${pageBreak ? ' page-break' : ''}">
            <div class="page-header">
                <h1>Daily Classroom Roster &nbsp;<span class="sub">${escHtml(dateLabel)}</span></h1>
                <span class="printed">Timothy Lutheran MDO &nbsp;·&nbsp; Printed ${new Date().toLocaleString('en-US')}</span>
            </div>
            <div class="rooms-grid">${_rosterGridBlocksHtml(roster, roomId)}</div>
        </div>`;
}

function _printDayRoster(date, roomId) {
    if (!date) { alert('Please select a date first.'); return; }

    const roster = getRosterForDate(date, roomId);
    if (!roster.length) { alert('No confirmed registrations for this date.'); return; }

    const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-US',
        { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Daily Roster — ${dateLabel}</title>
<style>${_ROSTER_GRID_PRINT_STYLE}</style>
</head>
<body>
  ${_rosterGridPageHtml(dateLabel, roster, roomId, false)}
  <script>${_ROSTER_GRID_AUTOSCALE_SCRIPT}<\/script>
</body>
</html>`;

    const w = window.open('', '_blank');
    if (!w) { alert('Pop-up was blocked. Please allow pop-ups for this site and try again.'); return; }
    w.document.write(html);
    w.document.close();
}

// "Print day by day" — one full daily-roster grid page per weekday in the week, in a single print job.
function _printWeekRoster(weekOf, roomId) {
    if (!weekOf) { alert('Please select a week first.'); return; }
    const weekDates = _buildWeekDates(weekOf);
    if (!weekDates.length) { alert('No open weekdays found for that week.'); return; }

    const pages = weekDates.map((date, i) => {
        const roster    = getRosterForDate(date, roomId);
        const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-US',
            { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        return _rosterGridPageHtml(dateLabel, roster, roomId, i > 0);
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Weekly Roster — Week of ${escHtml(weekOf)}</title>
<style>${_ROSTER_GRID_PRINT_STYLE}</style>
</head>
<body>
  ${pages}
  <script>${_ROSTER_GRID_AUTOSCALE_SCRIPT}<\/script>
</body>
</html>`;

    const w = window.open('', '_blank');
    if (!w) { alert('Pop-up was blocked. Please allow pop-ups for this site and try again.'); return; }
    w.document.write(html);
    w.document.close();
}

// All weekdays (Mon-Fri) in monthVal ('YYYY-MM'), excluding closure dates —
// same rule _buildWeekDates (admin-reports.js) already applies to a week,
// generalized to a whole month. Deliberately NOT _buildMonthlyRosterRoomSections's
// workingDays: that list is used for the compact calendar-grid print below and
// does not exclude closures, which would print an empty daily page for a day
// the center wasn't even open.
function _buildMonthWeekdays(monthVal) {
    const [y, m] = monthVal.split('-').map(Number);
    const daysInMonth = new Date(y, m, 0).getDate();
    const dates = [];
    for (let day = 1; day <= daysInMonth; day++) {
        const d = new Date(y, m - 1, day);
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue;
        const dateStr = `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        if (!allClosureDates.has(dateStr)) dates.push(dateStr);
    }
    return dates;
}

// "Print day by day", extended to a whole month — one full daily-roster grid
// page per weekday, in a single print job. Same per-page layout _printWeekRoster
// uses above (the autoscale script already handles any number of .print-page
// elements independently), just a longer date list. This is a different
// artifact from _printMonthRoster below: that one is a single-page compact
// calendar grid; this is the same "one child list per room, per day" sheet a
// teacher already knows from the day/week prints, one page per weekday.
function _printMonthDailyRoster(monthVal, roomId) {
    if (!monthVal) { alert('Please select a month first.'); return; }
    const monthDates = _buildMonthWeekdays(monthVal);
    if (!monthDates.length) { alert('No open weekdays found for that month.'); return; }

    const [y, m]    = monthVal.split('-').map(Number);
    const monthLabel = MONTH_NAMES[m - 1] + ' ' + y;

    const pages = monthDates.map((date, i) => {
        const roster    = getRosterForDate(date, roomId);
        const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-US',
            { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        return _rosterGridPageHtml(dateLabel, roster, roomId, i > 0);
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Daily Rosters — ${escHtml(monthLabel)}</title>
<style>${_ROSTER_GRID_PRINT_STYLE}</style>
</head>
<body>
  ${pages}
  <script>${_ROSTER_GRID_AUTOSCALE_SCRIPT}<\/script>
</body>
</html>`;

    const w = window.open('', '_blank');
    if (!w) { alert('Pop-up was blocked. Please allow pop-ups for this site and try again.'); return; }
    w.document.write(html);
    w.document.close();
}

// Monday of the ISO week containing dateStr ('YYYY-MM-DD'), as an ISO date
// string — generalizes _currentWeekMonday() to an arbitrary date, for the
// Attendance Board's "print this week" against whatever date is picked
// there rather than always the current week.
function _mondayOfWeek(dateStr) {
    const d    = new Date(dateStr + 'T00:00:00');
    const day  = d.getDay();
    const diff = (day === 0 ? -6 : 1 - day);
    const mon  = new Date(d);
    mon.setDate(d.getDate() + diff);
    return mon.toISOString().split('T')[0];
}

function _printMonthRoster(monthVal, roomId) {
    if (!monthVal) { alert('Please select a month first.'); return; }
    const { monthLabel, workingDays, rooms } = _buildMonthlyRosterRoomSections(monthVal, roomId);
    if (!workingDays.length) { alert(`No weekdays found for ${monthLabel}.`); return; }

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Monthly Roster — ${escHtml(monthLabel)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; padding: 20px 24px; color: #222; }
  .roster-report-header {
    font-size: 1.1em;
    border-bottom: 3px solid #333;
    padding-bottom: 10px;
    margin-bottom: 18px;
  }
  .roster-report-header .printed { float: right; font-size: .7em; color: #888; font-weight: 400; }
  .roster-room-block { margin-bottom: 24px; page-break-inside: avoid; }
  .roster-room-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    background: #333;
    color: #fff;
    padding: 8px 14px;
    flex-wrap: wrap;
    gap: 8px;
  }
  .roster-room-title { font-size: 1.05em; font-weight: 700; }
  .roster-room-meta { font-size: .8em; color: #ccc; }

  .cal-grid { border: 1px solid #ccc; border-top: none; }
  .cal-week { display: grid; grid-template-columns: repeat(5, 1fr); }
  .cal-dow-row { background: #f0f0f0; border-bottom: 2px solid #ccc; }
  .cal-dow {
    padding: 5px 6px; text-align: center; font-size: .72em; font-weight: 700;
    letter-spacing: .03em; text-transform: uppercase; color: #666;
  }
  .cal-cell {
    min-height: 78px; border: 1px solid #ddd; margin: -1px 0 0 -1px;
    padding: 4px 6px; display: flex; flex-direction: column;
  }
  .cal-cell-blank, .cal-cell-closed { background: #f7f7f7; }
  .cal-cell-closed .cal-day-num { color: #ccc; }
  .cal-cell-head {
    display: flex; justify-content: space-between; align-items: baseline;
    margin-bottom: 3px; flex-shrink: 0;
  }
  .cal-day-num { font-weight: 700; font-size: .82em; }
  .cal-count { font-size: .68em; color: #666; font-weight: 600; }
  .cal-children { flex: 1; display: grid; grid-template-columns: repeat(2, 1fr); align-content: start; gap: 1px 4px; }
  .cal-child {
    display: block; background: #f0f0f0; color: #222; font-size: .64em; font-weight: 600;
    padding: 0 4px; border-radius: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
  }
  .cal-empty { color: #ccc; font-style: italic; font-size: .68em; }

  @media print {
    @page { size: landscape; margin: 0.4in; }
    .roster-room-block:not(:first-child) { page-break-before: always; }
  }
</style>
</head>
<body>
  <div class="roster-report-header">
    <strong>Timothy Lutheran MDO</strong> — ${escHtml(monthLabel)} Classroom Roster
    <span class="printed">Printed ${new Date().toLocaleString('en-US')}</span>
  </div>
  ${_renderMonthlyRosterCalendarHtml(rooms, monthVal, monthLabel)}
  <script>
    window.addEventListener('load', function() { window.print(); });
  <\/script>
</body>
</html>`;

    const w = window.open('', '_blank');
    if (!w) { alert('Pop-up was blocked. Please allow pop-ups for this site and try again.'); return; }
    w.document.write(html);
    w.document.close();
}

// "Print All Rooms" — compact single-page grid of every room for one day (Day view only).
// Always shows every room regardless of the room filter (unlike Print/PDF above).
function printAllRoomsRoster() {
    const date = document.getElementById('rosterDate').value;
    if (!date) { alert('Please select a date first.'); return; }

    const roster = getRosterForDate(date, null);
    const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-US',
        { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Daily Roster — ${dateLabel}</title>
<style>${_ROSTER_GRID_PRINT_STYLE}</style>
</head>
<body>
  ${_rosterGridPageHtml(dateLabel, roster, null, false)}
  <script>${_ROSTER_GRID_AUTOSCALE_SCRIPT}<\/script>
</body>
</html>`;

    const w = window.open('', '_blank');
    if (!w) { alert('Pop-up was blocked. Please allow pop-ups for this site and try again.'); return; }
    w.document.write(html);
    w.document.close();
}
