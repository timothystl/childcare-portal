// ============================================================
// MODULE: Admin Classrooms (daily and monthly roster views)
// Sections: Daily Roster, Monthly Classroom Roster
// ============================================================

// DAILY ROSTER
// ============================================================
function setupRoster() {
    document.getElementById('viewRosterBtn').addEventListener('click', viewRoster);
    document.getElementById('exportRosterBtn').addEventListener('click', exportRoster);
    document.getElementById('printAllRoomsBtn').addEventListener('click', printAllRoomsRoster);
}

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

function viewRoster() {
    const date   = document.getElementById('rosterDate').value;
    const roomId = document.getElementById('rosterRoomFilter').value;
    if (!date) { alert('Please select a date.'); return; }

    const roster    = getRosterForDate(date, roomId || null);
    const container = document.getElementById('rosterContent');

    if (!roster.length) {
        container.innerHTML = `<p class="empty-hint">No confirmed registrations for ${friendlyShort(date)}.</p>`;
        return;
    }

    const byRoom = {};
    roster.forEach(r => {
        if (!byRoom[r.roomLabel]) byRoom[r.roomLabel] = [];
        byRoom[r.roomLabel].push(r);
    });

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

function exportRoster() {
    const date   = document.getElementById('rosterDate').value;
    const roomId = document.getElementById('rosterRoomFilter').value;
    if (!date) { alert('Please select a date first.'); return; }

    const roster = getRosterForDate(date, roomId || null);
    if (!roster.length) { alert('No confirmed registrations for this date.'); return; }

    const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString('en-US',
        { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });

    const byRoom = {};
    roster.forEach(r => {
        if (!byRoom[r.roomLabel]) byRoom[r.roomLabel] = [];
        byRoom[r.roomLabel].push(r);
    });

    const roomSections = Object.entries(byRoom).map(([roomLabel, kids]) => `
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

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Daily Roster — ${dateLabel}</title>
<style>
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
  .footer { margin-top: 40px; font-size: .78em; color: #aaa; text-align: center; }
  @media print {
    body { padding: 20px 24px; }
    @page { margin: 0.75in; }
  }
</style>
</head>
<body>
  <h1><span class="facility">Daily Classroom Roster</span>${dateLabel}</h1>
  ${roomSections}
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

        return `
            <div class="room-block">
                <div class="room-header">
                    <span class="room-label">${escHtml(room.label)}</span>
                    <span class="room-count">${countLabel}</span>
                </div>
                <div class="kids-list">${rows}</div>
            </div>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>Daily Roster — ${dateLabel}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  @page { size: 11in 8.5in landscape; margin: 0.45in 0.5in; }
  body {
    font-family: Arial, Helvetica, sans-serif;
    color: #111;
    font-size: 10pt;
  }
  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    border-bottom: 2.5px solid #333;
    padding-bottom: 6px;
    margin-bottom: 12px;
  }
  .page-header h1 {
    font-size: 13pt;
    font-weight: 700;
  }
  .page-header .sub {
    font-size: 9pt;
    color: #555;
    font-weight: 400;
  }
  .page-header .printed {
    font-size: 8pt;
    color: #999;
  }
  .rooms-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px 14px;
  }
  .room-block {
    border: 1px solid #ccc;
    border-radius: 4px;
    overflow: hidden;
  }
  .room-header {
    background: #f2f2f2;
    border-bottom: 1px solid #ccc;
    padding: 5px 9px;
  }
  .room-label {
    font-weight: 700;
    font-size: 10.5pt;
    display: block;
  }
  .room-count {
    font-size: 8pt;
    color: #666;
  }
  .kids-list {
    padding: 3px 0;
  }
  .kid-row {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: 4px 9px;
    border-bottom: 1px solid #f0f0f0;
    font-size: 9.5pt;
  }
  .kid-row:last-child { border-bottom: none; }
  .kid-name { font-weight: 500; }
  .day-badge {
    font-size: 7.5pt;
    font-weight: 700;
    padding: 2px 7px;
    border-radius: 10px;
    letter-spacing: 0.02em;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .day-badge.full { background: #d1fae5; color: #065f46; }
  .day-badge.half { background: #fef3c7; color: #92400e; }
  .empty-room { padding: 6px 9px; color: #bbb; font-size: 9pt; }
  .page-footer {
    position: fixed;
    bottom: 0.3in;
    right: 0.5in;
    font-size: 7.5pt;
    color: #bbb;
  }
</style>
</head>
<body>
  <div class="page-header">
    <h1>Daily Classroom Roster &nbsp;<span class="sub">${escHtml(dateLabel)}</span></h1>
    <span class="printed">Timothy Lutheran MDO &nbsp;·&nbsp; Printed ${new Date().toLocaleString('en-US')}</span>
  </div>
  <div class="rooms-grid">${roomBlocks}</div>
  <div class="page-footer">Timothy Lutheran MDO</div>
  <script>window.addEventListener('load', function() { window.print(); });<\/script>
</body>
</html>`;

    const w = window.open('', '_blank');
    if (!w) { alert('Pop-up was blocked. Please allow pop-ups for this site and try again.'); return; }
    w.document.write(html);
    w.document.close();
}

// ============================================================

// MONTHLY CLASSROOM ROSTER
// ============================================================
function setupMonthlyRoster() {
    const now = new Date();
    const el  = document.getElementById('rosterMonth');
    if (el) el.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    document.getElementById('generateRosterBtn')?.addEventListener('click', generateMonthlyRoster);
    document.getElementById('printRosterBtn')?.addEventListener('click', () => window.print());
}

function generateMonthlyRoster() {
    const monthVal = document.getElementById('rosterMonth')?.value;
    if (!monthVal) { alert('Please select a month.'); return; }

    const [y, m] = monthVal.split('-').map(Number);
    const monthLabel = MONTH_NAMES_ADMIN[m - 1] + ' ' + y;
    const daysInMonth = new Date(y, m, 0).getDate();

    // Build list of working days in the month (Mon–Fri, excluding closures)
    const workingDays = [];
    for (let day = 1; day <= daysInMonth; day++) {
        const d   = new Date(y, m - 1, day);
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue;
        const dateStr = `${y}-${String(m).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        workingDays.push({ dateStr, label: `${DAY_ABBR[dow]} ${day}` });
    }

    if (!workingDays.length) {
        document.getElementById('monthlyRosterContent').innerHTML = `<p class="empty-hint">No weekdays found for ${monthLabel}.</p>`;
        return;
    }

    // Build per-room, per-day child lists
    // childrenByRoomDate[roomId][dateStr] = [{ name, dayType, family }]
    const childrenByRoomDate = {};
    ROOMS.forEach(r => { childrenByRoomDate[r.id] = {}; });

    allRegistrations.forEach(reg => {
        const parentName = reg.families?.parent_name || '';
        (reg.registration_dates || []).forEach(d => {
            if (d.waitlisted || !d.care_date) return;
            if (!d.care_date.startsWith(monthVal)) return;
            const roomId  = d.room_id || reg.room_id;
            if (!childrenByRoomDate[roomId]) childrenByRoomDate[roomId] = {};
            if (!childrenByRoomDate[roomId][d.care_date]) childrenByRoomDate[roomId][d.care_date] = [];
            childrenByRoomDate[roomId][d.care_date].push({
                name:    reg.child_name || '—',
                dayType: d.day_type || 'full',
                family:  parentName,
            });
        });
    });

    // Generate HTML — one section per room
    const roomSections = ROOMS.map(room => {
        const dayRows = workingDays.map(({ dateStr, label }) => {
            const children = (childrenByRoomDate[room.id]?.[dateStr] || [])
                .sort((a, b) => a.name.localeCompare(b.name));
            const count = children.length;
            const cap   = room.capacity;
            const fullFlag = count >= cap ? ' roster-day-full' : count >= cap * .8 ? ' roster-day-near' : '';
            const childList = children.length
                ? children.map(c =>
                    `<span class="roster-child${c.dayType === 'half' ? ' roster-half' : ''}">${c.name}${c.dayType === 'half' ? ' ½' : ''}</span>`
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
            <div class="roster-room-block print-page-break">
                <div class="roster-room-header">
                    <span class="roster-room-title">${room.label}</span>
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

    document.getElementById('monthlyRosterContent').innerHTML = `
        <div class="monthly-roster-wrap" id="monthlyRosterPrintArea">
            <div class="roster-report-header">
                <strong>Timothy Lutheran MDO</strong> — Monthly Classroom Roster
                <span style="float:right;font-size:.85em;color:#888;">Generated ${new Date().toLocaleDateString()}</span>
            </div>
            ${roomSections}
        </div>`;

    document.getElementById('printRosterBtn').style.display = '';
}

// ============================================================
