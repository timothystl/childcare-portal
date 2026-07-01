// ============================================================
// MODULE: Admin Classrooms (classroom roster — Day / Week / Month views)
// ============================================================

// ROSTER — MODE SWITCHING
// ============================================================
function setupRoster() {
    document.getElementById('rosterViewMode')?.addEventListener('change', updateRosterModeUI);
    updateRosterModeUI();

    // Default week-of to the current Monday
    const weekInput = document.getElementById('rosterWeekOf');
    if (weekInput) {
        const today = new Date();
        const day   = today.getDay();               // 0=Sun … 6=Sat
        const diff  = (day === 0 ? -6 : 1 - day);    // days back to Mon
        const mon   = new Date(today);
        mon.setDate(today.getDate() + diff);
        weekInput.value = mon.toISOString().split('T')[0];
    }

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

    const rooms = (roomId ? ROOMS.filter(r => r.id === roomId) : ROOMS).map(room => ({
        room,
        days: workingDays.map(({ dateStr, label }) => {
            const children = (childrenByRoomDate[room.id]?.[dateStr] || [])
                .sort((a, b) => a.name.localeCompare(b.name));
            return { dateStr, label, children, count: children.length, cap: room.capacity };
        }),
    }));

    return { monthLabel, workingDays, rooms };
}

function _renderMonthlyRosterRoomsHtml(rooms, monthLabel) {
    return rooms.map(({ room, days }) => {
        const dayRows = days.map(({ label, children, count, cap }) => {
            const fullFlag = count >= cap ? ' roster-day-full' : count >= cap * .8 ? ' roster-day-near' : '';
            const childList = children.length
                ? children.map(c =>
                    `<span class="roster-child${c.dayType === 'half' ? ' roster-half' : ''}">${escHtml(c.name)}${c.dayType === 'half' ? ' ½' : ''}</span>`
                  ).join('')
                : '<span class="roster-empty-day">—</span>';
            return `
                <tr class="roster-day-row${fullFlag}">
                    <td class="roster-date-cell">${label}</td>
                    <td class="roster-count-cell">${count}/${cap}</td>
                    <td class="roster-names-cell">${childList}</td>
                </tr>`;
        }).join('');

        return `
            <div class="roster-room-block">
                <div class="roster-room-header">
                    <span class="roster-room-title">${escHtml(room.label)}</span>
                    <span class="roster-room-meta">${monthLabel} &nbsp;·&nbsp; Max ${room.capacity}/day</span>
                </div>
                <table class="roster-day-table">
                    <thead>
                        <tr>
                            <th class="roster-th-date">Date</th>
                            <th class="roster-th-count">Count</th>
                            <th class="roster-th-names">Enrolled Children</th>
                        </tr>
                    </thead>
                    <tbody>${dayRows}</tbody>
                </table>
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

function _viewDayRoster(date, roomId) {
    if (!date) { alert('Please select a date.'); return; }

    const roster    = getRosterForDate(date, roomId);
    const container = document.getElementById('rosterContent');

    if (!roster.length) {
        container.innerHTML = `<p class="empty-hint">No confirmed registrations for ${friendlyShort(date)}.</p>`;
        return;
    }

    const byRoom = _groupRosterByRoom(roster);
    container.innerHTML = `
        <p class="roster-date-heading">${friendlyShort(date)}</p>
        ${Object.entries(byRoom).map(([roomLabel, kids]) => `
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
            </div>`).join('')}`;
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
            ${_renderMonthlyRosterRoomsHtml(rooms, monthLabel)}
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

const _ROSTER_PRINT_STYLE = `
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    padding: 36px 48px;
    color: #222;
    max-width: 680px;
    margin: 0 auto;
  }
  h1 {
    font-size: 1.4em;
    font-weight: 700;
    border-bottom: 3px solid #333;
    padding-bottom: 10px;
    margin-bottom: 28px;
  }
  h1 .facility { font-size: .75em; font-weight: 400; color: #666; display: block; margin-bottom: 4px; }
  .room-block { margin-bottom: 32px; page-break-inside: avoid; }
  h2 {
    font-size: 1.05em;
    font-weight: 700;
    background: #f0f0f0;
    padding: 8px 14px;
    border-left: 4px solid #555;
    margin-bottom: 0;
  }
  .count { font-size: .8em; font-weight: 400; color: #666; margin-left: 10px; }
  ul { list-style: none; border: 1px solid #ddd; border-top: none; }
  li {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 9px 14px;
    border-bottom: 1px solid #eee;
    font-size: .97em;
  }
  li:last-child { border-bottom: none; }
  .child-name { font-weight: 500; }
  .day-label {
    font-size: .82em;
    padding: 3px 10px;
    border-radius: 12px;
    font-weight: 600;
    letter-spacing: .02em;
  }
  .day-label.full { background: #d1fae5; color: #065f46; }
  .day-label.half { background: #fef3c7; color: #92400e; }
  .empty-day { color: #999; font-style: italic; padding: 10px 0; }
  .footer { margin-top: 40px; font-size: .78em; color: #aaa; text-align: center; }
  @media print {
    body { padding: 20px 24px; }
    @page { margin: 0.75in; }
  }
`;

function _rosterRoomBlocksHtml(roster) {
    const byRoom = _groupRosterByRoom(roster);
    const blocks = Object.entries(byRoom).map(([roomLabel, kids]) => `
        <div class="room-block">
            <h2>${escHtml(roomLabel)} <span class="count">${kids.length} child${kids.length !== 1 ? 'ren' : ''}</span></h2>
            <ul>
                ${kids.map(k => `
                    <li>
                        <span class="child-name">${escHtml(k.childName)}</span>
                        <span class="day-label ${k.dayType}">${k.dayType === 'half' ? 'Half Day' : 'Full Day'}</span>
                    </li>`).join('')}
            </ul>
        </div>`).join('');
    return blocks || '<p class="empty-day">No confirmed registrations.</p>';
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
<style>${_ROSTER_PRINT_STYLE}</style>
</head>
<body>
  <h1><span class="facility">Daily Classroom Roster</span>${dateLabel}</h1>
  ${_rosterRoomBlocksHtml(roster)}
  <div class="footer">Printed ${new Date().toLocaleString('en-US')}</div>
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

// "Print day by day" — one full daily-roster page per weekday in the week, in a single print job.
function _printWeekRoster(weekOf, roomId) {
    if (!weekOf) { alert('Please select a week first.'); return; }
    const weekDates = _buildWeekDates(weekOf);
    if (!weekDates.length) { alert('No open weekdays found for that week.'); return; }

    const pages = weekDates.map((date, i) => {
        const roster    = getRosterForDate(date, roomId);
        const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-US',
            { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        return `
            <section class="day-page${i > 0 ? ' page-break' : ''}">
                <h1><span class="facility">Daily Classroom Roster</span>${dateLabel}</h1>
                ${_rosterRoomBlocksHtml(roster)}
                <div class="footer">Printed ${new Date().toLocaleString('en-US')}</div>
            </section>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Weekly Roster — Week of ${escHtml(weekOf)}</title>
<style>
  ${_ROSTER_PRINT_STYLE}
  .day-page { page-break-inside: avoid; }
  .day-page.page-break { page-break-before: always; }
</style>
</head>
<body>
  ${pages}
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
  body { font-family: Arial, Helvetica, sans-serif; padding: 30px 40px; color: #222; }
  .roster-report-header {
    font-size: 1.1em;
    border-bottom: 3px solid #333;
    padding-bottom: 10px;
    margin-bottom: 24px;
  }
  .roster-report-header .printed { float: right; font-size: .7em; color: #888; font-weight: 400; }
  .roster-room-block { margin-bottom: 28px; page-break-inside: avoid; }
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
  .roster-day-table { width: 100%; border-collapse: collapse; font-size: .85em; border: 1px solid #ddd; border-top: none; }
  .roster-day-table th {
    background: #f0f0f0; padding: 6px 10px; text-align: left; font-size: .78em;
    color: #666; font-weight: 700; letter-spacing: .03em; text-transform: uppercase; border-bottom: 2px solid #ddd;
  }
  .roster-th-date  { width: 70px; }
  .roster-th-count { width: 60px; text-align: center; }
  .roster-day-row  { border-bottom: 1px solid #eee; }
  .roster-date-cell  { padding: 4px 10px; font-weight: 600; white-space: nowrap; }
  .roster-count-cell { padding: 4px 10px; text-align: center; font-size: .82em; color: #666; }
  .roster-names-cell { padding: 4px 10px; line-height: 1.7; }
  .roster-day-full  { background: #fde2e1; }
  .roster-day-near  { background: #fef3c7; }
  .roster-child {
    display: inline-block; background: #f0f0f0; color: #222; font-size: .82em; font-weight: 600;
    padding: 1px 8px; border-radius: 12px; margin: 2px 3px 2px 0;
  }
  .roster-child.roster-half { background: #fef3c7; color: #92400e; }
  .roster-empty-day { color: #bbb; font-style: italic; font-size: .85em; }
  @media print {
    @page { margin: 0.6in; }
    .roster-room-block:not(:first-child) { page-break-before: always; }
  }
</style>
</head>
<body>
  <div class="roster-report-header">
    <strong>Timothy Lutheran MDO</strong> — ${escHtml(monthLabel)} Classroom Roster
    <span class="printed">Printed ${new Date().toLocaleString('en-US')}</span>
  </div>
  ${_renderMonthlyRosterRoomsHtml(rooms, monthLabel)}
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

// "Print All Rooms" — compact single-page grid of every room for one day (Day view only)
function printAllRoomsRoster() {
    const date = document.getElementById('rosterDate').value;
    if (!date) { alert('Please select a date first.'); return; }

    const roster = getRosterForDate(date, null);
    const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-US',
        { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    // Build per-room child lists in ROOMS order (include every room, even empty)
    const roomBlocks = ROOMS.map(room => {
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

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Daily Roster — ${dateLabel}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: landscape; margin: 0.4in 0.45in; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    color: #111;
    font-size: 9pt;
    width: 10.1in;
  }
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
</style>
</head>
<body>
  <div class="page-header">
    <h1>Daily Classroom Roster &nbsp;<span class="sub">${escHtml(dateLabel)}</span></h1>
    <span class="printed">Timothy Lutheran MDO &nbsp;·&nbsp; Printed ${new Date().toLocaleString('en-US')}</span>
  </div>
  <div class="rooms-grid">${roomBlocks}</div>
  <script>
    window.addEventListener('load', function() {
      var PAGE_H = 7.7 * 96;   // printable height in CSS px (8.5in - 2×0.4in margins)
      var MIN_SCALE = 7 / 9;   // floor: ~7pt from 9pt base — don't go smaller than this
      var h = document.body.scrollHeight;
      if (h > PAGE_H) {
        var s = Math.max(PAGE_H / h, MIN_SCALE);
        document.body.style.transformOrigin = 'top left';
        document.body.style.transform = 'scale(' + s + ')';
        document.body.style.width = (10.1 / s) + 'in';
      }
      window.print();
    });
  <\/script>
</body>
</html>`;

    const w = window.open('', '_blank');
    if (!w) { alert('Pop-up was blocked. Please allow pop-ups for this site and try again.'); return; }
    w.document.write(html);
    w.document.close();
}
