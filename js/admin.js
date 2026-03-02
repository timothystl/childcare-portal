// ============================================================
// ADMIN PASSWORD
// ============================================================
const ADMIN_PASSWORD = 'childcare2024';

// ============================================================
// STATE
// ============================================================
let allRegistrations = [];

// ============================================================
// LOGIN
// ============================================================
document.getElementById('loginBtn').addEventListener('click', attemptLogin);
document.getElementById('adminPassword').addEventListener('keydown', e => {
    if (e.key === 'Enter') attemptLogin();
});

function attemptLogin() {
    const pwd = document.getElementById('adminPassword').value;
    if (pwd === ADMIN_PASSWORD) {
        document.getElementById('loginScreen').classList.add('hidden');
        document.getElementById('dashboard').classList.remove('hidden');
        initDashboard();
    } else {
        document.getElementById('loginError').classList.remove('hidden');
    }
}

document.getElementById('logoutBtn').addEventListener('click', () => {
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('adminPassword').value = '';
});

// ============================================================
// DASHBOARD INIT
// ============================================================
async function initDashboard() {
    populateRoomFilter();
    populateRosterRoomFilter();
    await Promise.all([loadRegistrations(), loadClosureList()]);
    renderCapacityOverview();
    setupFilters();
    setupRoster();
    setupClosures();
    setupMonthlyReport();
    setupWindowOverride();
    setupFamilies();
    setupMessages();
    document.getElementById('refreshBtn').addEventListener('click', loadRegistrations);
    document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
    document.getElementById('exportXlsxBtn').addEventListener('click', exportExcel);
}

function populateRoomFilter() {
    const sel = document.getElementById('roomFilter');
    ROOMS.forEach(r => {
        const opt = document.createElement('option');
        opt.value       = r.id;
        opt.textContent = r.label;
        sel.appendChild(opt);
    });
}

function populateRosterRoomFilter() {
    const sel = document.getElementById('rosterRoomFilter');
    ROOMS.forEach(r => {
        const opt = document.createElement('option');
        opt.value       = r.id;
        opt.textContent = r.label;
        sel.appendChild(opt);
    });
}

// ============================================================
// BILLING HELPER
// ============================================================
function calcRegistrationBill(reg) {
    const room = ROOMS.find(r => r.id === reg.room_id);
    if (!room) return 0;
    return (reg.registration_dates || [])
        .filter(d => !d.waitlisted)
        .reduce((sum, d) => {
            const rate = d.day_type === 'half' ? (room.halfDayRate || 0) : (room.fullDayRate || 0);
            return sum + rate;
        }, 0);
}

// ============================================================
// LOAD REGISTRATIONS
// ============================================================
async function loadRegistrations() {
    document.getElementById('regTableBody').innerHTML =
        '<tr><td colspan="10" class="loading-cell">Loading…</td></tr>';
    try {
        allRegistrations = await fetchAllRegistrations();
        populateCareMonthFilter();
        renderTable(allRegistrations);
        renderCapacityOverview();
        document.getElementById('regCount').textContent =
            `${allRegistrations.length} registration${allRegistrations.length !== 1 ? 's' : ''} total`;
    } catch (err) {
        console.error(err);
        document.getElementById('regTableBody').innerHTML =
            '<tr><td colspan="10" class="loading-cell error">Failed to load — check Supabase config.</td></tr>';
    }
}

// Populate care-month dropdown with all months present in registration_dates
function populateCareMonthFilter() {
    const sel = document.getElementById('careMonthFilter');
    const current = sel.value; // preserve selection if already set
    while (sel.options.length > 1) sel.remove(1);

    const months = new Set();
    allRegistrations.forEach(reg => {
        (reg.registration_dates || []).forEach(d => {
            if (d.care_date) months.add(d.care_date.substring(0, 7));
        });
    });

    [...months].sort().forEach(m => {
        const [y, mo] = m.split('-').map(Number);
        const label = MONTH_NAMES_ADMIN[mo - 1] + ' ' + y;
        const opt = document.createElement('option');
        opt.value       = m;
        opt.textContent = label;
        sel.appendChild(opt);
    });

    if (current) sel.value = current; // restore selection
}

// ============================================================
// TABLE RENDER
// ============================================================
function renderTable(data) {
    const tbody = document.getElementById('regTableBody');
    if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="10" class="loading-cell">No registrations found.</td></tr>';
        return;
    }

    tbody.innerHTML = data.map(reg => {
        const room  = ROOMS.find(r => r.id === reg.room_id) || { label: reg.room_id };
        const dates = (reg.registration_dates || [])
            .sort((a, b) => a.care_date.localeCompare(b.care_date));

        // Date chips — show ½ day or Full, no ·C suffix (all confirmed, waitlist removed)
        const datesHtml = dates.map(d => {
            const cls       = d.waitlisted ? 'badge-waitlist' : 'badge-confirmed';
            const typeLabel = d.day_type === 'half' ? '½ day' : 'Full';
            return `<span class="date-chip ${cls}" title="${d.day_type === 'half' ? 'Half Day' : 'Full Day'}">${friendlyShort(d.care_date)} <em>${typeLabel}</em></span>`;
        }).join('');

        // Full / Half tally
        const confirmed = dates.filter(d => !d.waitlisted);
        const fullCount = confirmed.filter(d => d.day_type !== 'half').length;
        const halfCount = confirmed.filter(d => d.day_type === 'half').length;
        const tallyParts = [];
        if (fullCount) tallyParts.push(`<span class="tally-full">${fullCount} Full</span>`);
        if (halfCount) tallyParts.push(`<span class="tally-half">${halfCount} Half</span>`);
        const tallyHtml = tallyParts.join('<br>') || '—';

        const submitted = new Date(reg.created_at).toLocaleDateString('en-US',
            { month: 'short', day: 'numeric', year: 'numeric' });

        const bill = calcRegistrationBill(reg);

        return `
            <tr data-id="${reg.id}" data-room="${reg.room_id}">
                <td>${submitted}</td>
                <td>${escHtml(reg.parent_name)}</td>
                <td><a href="mailto:${escHtml(reg.parent_email)}">${escHtml(reg.parent_email)}</a></td>
                <td>${escHtml(reg.parent_phone)}</td>
                <td>${escHtml(reg.child_name)}</td>
                <td>${room.label}</td>
                <td class="dates-cell">${datesHtml}</td>
                <td class="tally-cell">${tallyHtml}</td>
                <td class="bill-cell">$${bill.toFixed(2)}</td>
                <td class="actions-cell">
                    <button class="btn-delete" data-id="${reg.id}">Delete</button>
                </td>
            </tr>`;
    }).join('');

    tbody.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', async e => {
            const id  = e.currentTarget.getAttribute('data-id');
            const reg = allRegistrations.find(r => String(r.id) === id);
            if (!confirm(`Delete registration for ${reg?.child_name ?? 'this child'}? This cannot be undone.`)) return;
            try {
                await deleteRegistration(id);
                await loadRegistrations();
            } catch (err) {
                alert('Delete failed: ' + err.message);
            }
        });
    });
}

// ============================================================
// CAPACITY OVERVIEW
// ============================================================
function renderCapacityOverview() {
    const grid  = document.getElementById('capacityGrid');
    const today = new Date();

    // Build current-month and next-month descriptors
    const months = [0, 1].map(offset => {
        const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
        const y = d.getFullYear();
        const m = d.getMonth();
        const key = `${y}-${String(m + 1).padStart(2, '0')}`;

        // Count Mon–Fri working days in the month (closures not excluded for simplicity)
        const daysInMonth = new Date(y, m + 1, 0).getDate();
        let workingDays = 0;
        for (let day = 1; day <= daysInMonth; day++) {
            const dow = new Date(y, m, day).getDay();
            if (dow !== 0 && dow !== 6) workingDays++;
        }

        // Count confirmed bookings per room for this month
        const counts = {};
        ROOMS.forEach(r => { counts[r.id] = 0; });
        allRegistrations.forEach(reg => {
            (reg.registration_dates || []).forEach(d => {
                if (d.waitlisted || !d.care_date) return;
                if (d.care_date.startsWith(key)) {
                    counts[reg.room_id] = (counts[reg.room_id] || 0) + 1;
                }
            });
        });

        return { label: MONTH_NAMES_ADMIN[m] + ' ' + y, key, counts, workingDays };
    });

    grid.innerHTML = months.map(({ label, counts, workingDays }) => {
        const cards = ROOMS.map(room => {
            const used  = counts[room.id] || 0;
            const cap   = room.capacity * workingDays;
            const pct   = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
            const color = pct >= 90 ? 'bar-red' : pct >= 70 ? 'bar-orange' : 'bar-green';
            return `
                <div class="cap-card">
                    <h3>${room.label}</h3>
                    <p class="cap-meta">Max ${room.capacity}/day &middot; ${used} booking${used !== 1 ? 's' : ''}</p>
                    <div class="progress-bar"><div class="progress-fill ${color}" style="width:${pct}%"></div></div>
                    <p class="cap-pct">${pct}% utilisation</p>
                </div>`;
        }).join('');
        return `
            <div class="cap-month-group">
                <h3 class="cap-month-heading">${label}</h3>
                <div class="capacity-grid">${cards}</div>
            </div>`;
    }).join('');
}

// ============================================================
// DAILY ROSTER
// ============================================================
function setupRoster() {
    document.getElementById('viewRosterBtn').addEventListener('click', viewRoster);
    document.getElementById('exportRosterBtn').addEventListener('click', exportRoster);
}

function getRosterForDate(date, roomId) {
    return allRegistrations
        .filter(reg => {
            if (roomId && reg.room_id !== roomId) return false;
            return (reg.registration_dates || []).some(d => d.care_date === date && !d.waitlisted);
        })
        .map(reg => {
            const d    = (reg.registration_dates || []).find(d => d.care_date === date && !d.waitlisted);
            const room = ROOMS.find(r => r.id === reg.room_id);
            const rate = d?.day_type === 'half' ? room?.halfDayRate : room?.fullDayRate;
            return {
                roomLabel:   room?.label || reg.room_id,
                roomId:      reg.room_id,
                childName:   reg.child_name,
                childDob:    reg.child_dob,
                parentName:  reg.parent_name,
                parentPhone: reg.parent_phone,
                parentEmail: reg.parent_email,
                dayType:     d?.day_type || 'full',
                rate:        rate || 0,
            };
        })
        .sort((a, b) => a.roomId.localeCompare(b.roomId) || a.childName.localeCompare(b.childName));
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

// ============================================================
// REGISTRATION WINDOW OVERRIDE
// ============================================================
async function setupWindowOverride() {
    try {
        const current = await fetchSetting('reg_window_override') || 'auto';
        document.getElementById('windowOverrideSelect').value = current;
        showOverrideStatus(current, false);
    } catch (err) {
        console.warn('Could not load window override setting:', err);
    }

    document.getElementById('saveOverrideBtn').addEventListener('click', async () => {
        const val    = document.getElementById('windowOverrideSelect').value;
        const btn    = document.getElementById('saveOverrideBtn');
        btn.disabled    = true;
        btn.textContent = 'Saving…';
        try {
            await upsertSetting('reg_window_override', val);
            showOverrideStatus(val, true);
        } catch (err) {
            alert('Error saving override: ' + err.message);
        } finally {
            btn.disabled    = false;
            btn.textContent = 'Save';
        }
    });
}

function showOverrideStatus(val, saved) {
    const el = document.getElementById('overrideStatus');
    const labels = {
        auto:   '⚙️ Auto — open days 1–20, closed days 21+ each month.',
        open:   '🟢 Force Open — registration is open for all parents right now.',
        closed: '🔴 Force Closed — registration is blocked for all parents right now.',
    };
    el.textContent = (saved ? '✅ Saved. ' : '') + (labels[val] || '');
    el.className   = `override-status override-${val}`;
}

// ============================================================
// MONTHLY BILLING REPORT
// ============================================================
const MONTH_NAMES_ADMIN = ['January','February','March','April','May','June',
                           'July','August','September','October','November','December'];

function setupMonthlyReport() {
    document.getElementById('generateReportBtn').addEventListener('click', generateMonthlyReport);
    document.getElementById('exportReportBtn').addEventListener('click', exportMonthlyReport);

    const now = new Date();
    const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    document.getElementById('reportMonth').value = monthStr;
}

function generateMonthlyReport() {
    const monthVal = document.getElementById('reportMonth').value;
    if (!monthVal) { alert('Please select a month.'); return; }

    const breakdown = {};
    ROOMS.forEach(r => {
        breakdown[r.id] = { roomLabel: r.label, full: 0, half: 0, revenue: 0 };
    });

    let totalFull = 0, totalHalf = 0, totalRevenue = 0;

    allRegistrations.forEach(reg => {
        const room = ROOMS.find(r => r.id === reg.room_id);
        if (!room) return;
        (reg.registration_dates || []).forEach(d => {
            if (!d.care_date.startsWith(monthVal)) return;
            if (d.waitlisted) return;
            if (d.day_type === 'half') {
                breakdown[reg.room_id].half++;
                breakdown[reg.room_id].revenue += room.halfDayRate || 0;
                totalHalf++;
                totalRevenue += room.halfDayRate || 0;
            } else {
                breakdown[reg.room_id].full++;
                breakdown[reg.room_id].revenue += room.fullDayRate || 0;
                totalFull++;
                totalRevenue += room.fullDayRate || 0;
            }
        });
    });

    const [y, m] = monthVal.split('-').map(Number);
    const monthLabel = MONTH_NAMES_ADMIN[m - 1] + ' ' + y;

    renderMonthlyReport(monthLabel, monthVal, breakdown, { totalFull, totalHalf, totalRevenue });
}

function renderMonthlyReport(monthLabel, monthVal, breakdown, totals) {
    const container = document.getElementById('reportContent');

    const rows = ROOMS.map(room => {
        const b         = breakdown[room.id];
        const totalDays = b.full + b.half;
        return `
            <tr>
                <td>${room.label}</td>
                <td class="report-num">${b.full}</td>
                <td class="report-num">${b.half}</td>
                <td class="report-num"><strong>${totalDays}</strong></td>
                <td class="report-num report-revenue">$${b.revenue.toFixed(2)}</td>
            </tr>`;
    }).join('');

    if (totals.totalFull === 0 && totals.totalHalf === 0) {
        container.innerHTML = `<p class="empty-hint">No registrations found for ${monthLabel}.</p>`;
        return;
    }

    container.innerHTML = `
        <h3 class="report-month-title">${monthLabel}</h3>
        <div class="table-wrapper report-table-wrap">
            <table class="report-table">
                <thead>
                    <tr>
                        <th>Room</th>
                        <th>Full Days</th>
                        <th>Half Days</th>
                        <th>Total Days</th>
                        <th>Revenue</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
                <tfoot>
                    <tr class="report-total-row">
                        <td><strong>Grand Total</strong></td>
                        <td class="report-num"><strong>${totals.totalFull}</strong></td>
                        <td class="report-num"><strong>${totals.totalHalf}</strong></td>
                        <td class="report-num"><strong>${totals.totalFull + totals.totalHalf}</strong></td>
                        <td class="report-num report-revenue"><strong>$${totals.totalRevenue.toFixed(2)}</strong></td>
                    </tr>
                </tfoot>
            </table>
        </div>`;
}

function exportMonthlyReport() {
    const monthVal = document.getElementById('reportMonth').value;
    if (!monthVal) { alert('Please select a month first.'); return; }

    const rows = [];
    ROOMS.forEach(room => {
        let full = 0, half = 0, revenue = 0;
        allRegistrations.forEach(reg => {
            if (reg.room_id !== room.id) return;
            (reg.registration_dates || []).forEach(d => {
                if (!d.care_date.startsWith(monthVal)) return;
                if (d.waitlisted) return;
                if (d.day_type === 'half') { half++; revenue += room.halfDayRate || 0; }
                else                       { full++; revenue += room.fullDayRate || 0; }
            });
        });
        rows.push({
            'Room':        room.label,
            'Full Days':   full,
            'Half Days':   half,
            'Total Days':  full + half,
            'Revenue':     `$${revenue.toFixed(2)}`,
        });
    });

    if (!rows.length) { alert('No data to export.'); return; }

    const [y, m] = monthVal.split('-').map(Number);
    const label  = MONTH_NAMES_ADMIN[m - 1] + '-' + y;

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, label);
    ws['!cols'] = Object.keys(rows[0]).map(k => ({
        wch: Math.max(k.length, ...rows.map(r => String(r[k] || '').length))
    }));
    XLSX.writeFile(wb, `billing-report-${monthVal}.xlsx`);
}

// ============================================================
// CLOSURES
// ============================================================
function setupClosures() {
    document.getElementById('addClosureBtn').addEventListener('click', async () => {
        const date   = document.getElementById('closureDate').value;
        const reason = document.getElementById('closureReason').value.trim();
        if (!date) { alert('Please select a date to block.'); return; }
        try {
            await addClosure(date, reason);
            document.getElementById('closureDate').value   = '';
            document.getElementById('closureReason').value = '';
            await loadClosureList();
        } catch (err) {
            alert('Error: ' + err.message);
        }
    });
}

async function loadClosureList() {
    try {
        const closures  = await fetchClosures();
        const container = document.getElementById('closureList');
        if (!closures.length) {
            container.innerHTML = '<p class="empty-hint">No closures set.</p>';
            return;
        }
        container.innerHTML = `
            <ul class="closure-list">
                ${closures.map(c => `
                    <li class="closure-item">
                        <span class="closure-date-lbl">${friendlyShort(c.close_date)}</span>
                        <span class="closure-reason-lbl">${escHtml(c.reason || '—')}</span>
                        <button class="btn-remove-closure" data-date="${c.close_date}">Remove</button>
                    </li>`).join('')}
            </ul>`;
        container.querySelectorAll('.btn-remove-closure').forEach(btn => {
            btn.addEventListener('click', async e => {
                const d = e.currentTarget.getAttribute('data-date');
                if (!confirm(`Remove closure for ${friendlyShort(d)}?`)) return;
                try {
                    await deleteClosure(d);
                    await loadClosureList();
                } catch (err) {
                    alert('Error: ' + err.message);
                }
            });
        });
    } catch (err) {
        console.error('loadClosureList:', err);
    }
}

// ============================================================
// FILTERS
// ============================================================
function setupFilters() {
    ['searchInput', 'roomFilter', 'careMonthFilter', 'statusFilter'].forEach(id => {
        document.getElementById(id).addEventListener('input', applyFilters);
    });
}

function applyFilters() {
    const search    = document.getElementById('searchInput').value.toLowerCase();
    const room      = document.getElementById('roomFilter').value;
    const careMonth = document.getElementById('careMonthFilter').value;   // 'YYYY-MM' or ''
    const status    = document.getElementById('statusFilter').value;

    let filtered = allRegistrations.filter(reg => {
        const matchSearch = !search ||
            (reg.parent_name  || '').toLowerCase().includes(search) ||
            (reg.parent_email || '').toLowerCase().includes(search) ||
            (reg.child_name   || '').toLowerCase().includes(search);
        const matchRoom      = !room      || reg.room_id === room;
        const matchCareMonth = !careMonth || (reg.registration_dates || []).some(d =>
            d.care_date && d.care_date.startsWith(careMonth));
        const matchStatus    = !status    || (reg.registration_dates || []).some(d =>
            status === 'confirmed' ? !d.waitlisted : d.waitlisted);
        return matchSearch && matchRoom && matchCareMonth && matchStatus;
    });

    // When a care month is selected, sort by earliest care date in that month
    if (careMonth) {
        filtered = filtered.slice().sort((a, b) => {
            const earliest = regs => (regs || [])
                .filter(d => d.care_date?.startsWith(careMonth))
                .map(d => d.care_date).sort()[0] || '';
            return earliest(a.registration_dates).localeCompare(earliest(b.registration_dates));
        });
    }

    renderTable(filtered);
}

// ============================================================
// EXPORT — CSV / EXCEL
// ============================================================
function exportCSV() {
    const rows    = flattenForExport(allRegistrations);
    const headers = Object.keys(rows[0] || {});
    const csv     = [headers.join(','), ...rows.map(r => headers.map(h => csvCell(r[h])).join(','))].join('\n');
    downloadFile('registrations.csv', 'text/csv', csv);
}

function exportExcel() {
    const rows = flattenForExport(allRegistrations);
    const ws   = XLSX.utils.json_to_sheet(rows);
    const wb   = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Registrations');
    ws['!cols'] = Object.keys(rows[0] || {}).map(k => ({
        wch: Math.max(k.length, ...rows.map(r => String(r[k] || '').length))
    }));
    XLSX.writeFile(wb, 'registrations.xlsx');
}

function flattenForExport(data) {
    const rows = [];
    data.forEach(reg => {
        const room  = ROOMS.find(r => r.id === reg.room_id)?.label || reg.room_id;
        const dates = (reg.registration_dates || [])
            .sort((a, b) => a.care_date.localeCompare(b.care_date));
        if (!dates.length) {
            rows.push(baseRow(reg, room, '', '', ''));
        } else {
            dates.forEach(d => {
                rows.push(baseRow(reg, room, d.care_date,
                    d.waitlisted ? 'Waitlist' : 'Confirmed',
                    d.day_type === 'half' ? 'Half Day' : 'Full Day'));
            });
        }
    });
    return rows;
}

function baseRow(reg, roomLabel, date, status, dayType) {
    const room = ROOMS.find(r => r.label === roomLabel);
    const rate = dayType === 'Half Day' ? room?.halfDayRate : room?.fullDayRate;
    const bill = calcRegistrationBill(reg);
    return {
        'Submitted':   new Date(reg.created_at).toLocaleDateString('en-US'),
        'Parent Name': reg.parent_name,
        'Email':       reg.parent_email,
        'Phone':       reg.parent_phone,
        'Child Name':  reg.child_name,
        'DOB':         reg.child_dob || '',
        'Room':        roomLabel,
        'Care Date':   date,
        'Day Type':    dayType,
        'Status':      status,
        'Rate':        date && rate ? `$${rate}` : '',
        'Total Bill':  `$${bill.toFixed(2)}`,
    };
}

// ============================================================
// FAMILIES & STUDENTS
// ============================================================
let importRows = [];

function setupFamilies() {
    const fileInput  = document.getElementById('familiesFileInput');
    const importBtn  = document.getElementById('importFamiliesBtn');
    const refreshBtn = document.getElementById('refreshFamiliesBtn');

    fileInput?.addEventListener('change', onFamiliesFileChange);
    importBtn?.addEventListener('click', onImportFamilies);
    refreshBtn?.addEventListener('click', loadFamilies);
}

async function onFamiliesFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('familiesFileName').textContent = file.name;
    document.getElementById('importFamiliesBtn').disabled = true;
    document.getElementById('importPreview').innerHTML =
        '<p class="empty-hint">Parsing file…</p>';
    importRows = [];

    try {
        const rawRows = await parseUploadedFile(file);
        if (!rawRows.length) {
            document.getElementById('importPreview').innerHTML =
                '<p class="empty-hint">No data rows found in the file.</p>';
            return;
        }

        importRows = rawRows.map(normalizeImportRow).filter(r => r.parentName);

        if (!importRows.length) {
            document.getElementById('importPreview').innerHTML =
                '<p class="import-error">Could not detect parent name column. ' +
                'Expected headers like "Parent Name", "Guardian", or "First Name" + "Last Name".</p>';
            return;
        }

        renderImportPreview(importRows);
        document.getElementById('importFamiliesBtn').disabled = false;
    } catch (err) {
        document.getElementById('importPreview').innerHTML =
            `<p class="import-error">Error reading file: ${escHtml(err.message)}</p>`;
        console.error('File parse error:', err);
    }
}

function parseUploadedFile(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => {
            try {
                const data = new Uint8Array(e.target.result);
                const wb   = XLSX.read(data, { type: 'array', cellDates: true });
                const ws   = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(ws, { raw: false, defval: '' });
                resolve(rows);
            } catch (err) { reject(err); }
        };
        reader.onerror = () => reject(new Error('File read failed.'));
        reader.readAsArrayBuffer(file);
    });
}

// Auto-detect ProCare / custom column mapping
function normalizeImportRow(rawRow) {
    const keys   = Object.keys(rawRow);
    const get    = key => String(rawRow[key] ?? '').trim();
    const findCol = (...keywords) => {
        const key = keys.find(k =>
            keywords.some(kw => k.toLowerCase().replace(/[^a-z ]/g, ' ').includes(kw))
        );
        return key ? String(rawRow[key] ?? '').trim() : '';
    };

    // ProCare format: "Parent1 Name" is unique to ProCare exports
    // "First Name" / "Last Name" are the CHILD's names in ProCare
    const isProCare = keys.includes('Parent1 Name');

    if (isProCare) {
        const childFirst = get('First Name');
        const childLast  = get('Last Name');
        const childName  = childFirst && childLast
            ? `${childFirst} ${childLast}`.trim()
            : (childFirst || childLast || '');
        const childDob    = normalizeDobStr(get('Birthdate'));
        const parentName  = get('Parent1 Name');
        const parentEmail = get('Parent1 Email');
        const parentPhone = get('Parent1 Phone');
        return { parentName, parentEmail, parentPhone, childName, childDob };
    }

    // Generic auto-detect (non-ProCare files)
    let parentName = findCol('parent name', 'guardian name', 'primary contact');
    if (!parentName) {
        const f = findCol('parent first', 'guardian first');
        const l = findCol('parent last',  'guardian last');
        if (f && l) parentName = `${f} ${l}`.trim();
        else if (f) parentName = f;
    }
    if (!parentName) {
        const f = findCol('first name', 'first');
        const l = findCol('last name',  'last');
        if (f && l) parentName = `${f} ${l}`.trim();
        else if (f) parentName = f;
    }

    const parentEmail = findCol('email', 'e-mail', 'e mail');
    const parentPhone = findCol('phone', 'cell', 'mobile', 'telephone');

    let childName = findCol('student name', 'child name', 'student first name');
    if (!childName) {
        const f = findCol('student first', 'child first');
        const l = findCol('student last',  'child last');
        if (f && l) childName = `${f} ${l}`.trim();
        else if (f) childName = f;
    }

    const childDobRaw = findCol('dob', 'birth date', 'birthday', 'date of birth', 'birthdate');
    const childDob    = normalizeDobStr(childDobRaw);

    return { parentName, parentEmail, parentPhone, childName, childDob };
}

function normalizeDobStr(raw) {
    if (!raw) return null;
    const str = String(raw).trim();
    if (!str) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    return null;
}

function renderImportPreview(rows) {
    const preview   = rows.slice(0, 10);
    const remaining = rows.length - preview.length;

    const tableRows = preview.map(r => `
        <tr>
            <td>${escHtml(r.parentName)}</td>
            <td>${escHtml(r.parentEmail)}</td>
            <td>${escHtml(r.parentPhone)}</td>
            <td>${escHtml(r.childName)}</td>
            <td>${escHtml(r.childDob || '')}</td>
        </tr>`).join('');

    document.getElementById('importPreview').innerHTML = `
        <p class="import-preview-count">
            <strong>${rows.length}</strong> record${rows.length !== 1 ? 's' : ''} detected
            ${remaining > 0 ? ` (showing first 10)` : ''}
        </p>
        <div class="table-wrapper import-table-wrap">
            <table class="import-preview-table">
                <thead>
                    <tr>
                        <th>Parent Name</th><th>Email</th><th>Phone</th>
                        <th>Child Name</th><th>Child DOB</th>
                    </tr>
                </thead>
                <tbody>${tableRows}</tbody>
            </table>
        </div>`;
}

async function onImportFamilies() {
    if (!importRows.length) return;
    const btn = document.getElementById('importFamiliesBtn');
    btn.disabled    = true;
    btn.textContent = 'Importing…';
    try {
        const { familiesImported, studentsImported } = await importFamiliesData(importRows);
        document.getElementById('importPreview').innerHTML =
            `<p class="import-success">
                ✅ Import complete — <strong>${familiesImported}</strong> families,
                <strong>${studentsImported}</strong> students.
             </p>`;
        importRows = [];
        document.getElementById('familiesFileInput').value = '';
        document.getElementById('familiesFileName').textContent = 'No file chosen';
        await loadFamilies();
    } catch (err) {
        alert('Import failed: ' + err.message);
        btn.disabled    = false;
        btn.textContent = '⬆ Import';
    }
}

async function loadFamilies() {
    const container = document.getElementById('familiesList');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const families = await fetchAllFamilies();
        renderFamiliesList(families);
    } catch (err) {
        container.innerHTML = `<p class="import-error">Failed to load families: ${escHtml(err.message)}</p>`;
    }
}

function renderFamiliesList(families) {
    const container = document.getElementById('familiesList');
    if (!families.length) {
        container.innerHTML = '<p class="empty-hint">No families yet. Import from Excel or submit a registration.</p>';
        return;
    }

    const roomOptions = ROOMS.map(r =>
        `<option value="${r.id}">${r.label}</option>`
    ).join('');

    container.innerHTML = `
        <p class="families-count">${families.length} famil${families.length !== 1 ? 'ies' : 'y'}</p>
        <ul class="families-list">
            ${families.map(f => {
                const kids  = (f.students || []);
                const since = f.created_at
                    ? new Date(f.created_at).toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
                    : '';
                return `
                    <li class="family-row">
                        <div class="family-row-top">
                            <span class="family-row-name">${escHtml(f.parent_name)}</span>
                            ${f.pin ? `<span class="family-pin-badge">PIN: ${f.pin}</span>` : ''}
                            <span class="family-row-meta">${escHtml(f.parent_email || '')}${f.parent_email && f.parent_phone ? ' &middot; ' : ''}${escHtml(f.parent_phone || '')}</span>
                            ${since ? `<span class="family-row-since">Since ${since}</span>` : ''}
                        </div>
                        ${kids.length ? `
                            <ul class="family-students">
                                ${kids.map(s => {
                                    const dobStr = s.child_dob
                                        ? new Date(s.child_dob + 'T00:00:00').toLocaleDateString('en-US',
                                            { month: 'short', day: 'numeric', year: 'numeric' })
                                        : '';
                                    return `<li class="family-student-item" data-student-id="${s.id}">
                                        <span class="student-bullet">└</span>
                                        <span class="student-name">${escHtml(s.child_name)}</span>
                                        ${dobStr ? `<span class="student-dob">${dobStr}</span>` : ''}
                                        <div class="room-override-wrap">
                                            <label class="room-override-label">Room:</label>
                                            <select class="room-override-select" data-student-id="${s.id}">
                                                <option value="">Auto (age-based)</option>
                                                ${roomOptions}
                                            </select>
                                        </div>
                                    </li>`;
                                }).join('')}
                            </ul>` : ''}
                    </li>`;
            }).join('')}
        </ul>`;

    // Set current room override values + bind change events
    families.forEach(f => {
        (f.students || []).forEach(s => {
            const sel = container.querySelector(`.room-override-select[data-student-id="${s.id}"]`);
            if (sel) {
                sel.value = s.room_override || '';
                sel.addEventListener('change', async () => {
                    const newVal = sel.value || null;
                    try {
                        await updateStudentRoomOverride(s.id, newVal);
                        sel.style.borderColor = '#68d391';
                        setTimeout(() => { sel.style.borderColor = ''; }, 2000);
                    } catch (err) {
                        alert('Failed to update room: ' + err.message);
                        sel.value = s.room_override || '';
                    }
                });
            }
        });
    });
}

// ============================================================
// MESSAGES
// ============================================================
let showArchivedMessages = false;

function setupMessages() {
    document.getElementById('refreshMessagesBtn')?.addEventListener('click', loadMessages);
    document.getElementById('toggleArchivedBtn')?.addEventListener('click', () => {
        showArchivedMessages = !showArchivedMessages;
        const btn = document.getElementById('toggleArchivedBtn');
        btn.textContent = showArchivedMessages ? 'Hide Archived' : 'Show Archived';
        btn.classList.toggle('btn-active', showArchivedMessages);
        loadMessages();
    });
}

async function loadMessages() {
    const container = document.getElementById('messagesList');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const messages = await fetchMessages(showArchivedMessages);
        renderMessagesList(messages);
    } catch (err) {
        container.innerHTML = `<p class="import-error">Failed to load messages: ${escHtml(err.message)}</p>`;
    }
}

function renderMessagesList(messages) {
    const container    = document.getElementById('messagesList');
    const unreadBadge  = document.getElementById('unreadBadge');
    const unreadCount  = messages.filter(m => !m.is_read && !m.is_archived).length;

    if (unreadBadge) {
        if (unreadCount > 0) {
            unreadBadge.textContent = `${unreadCount} unread`;
            unreadBadge.classList.remove('hidden');
        } else {
            unreadBadge.classList.add('hidden');
        }
    }

    if (!messages.length) {
        container.innerHTML = showArchivedMessages
            ? '<p class="empty-hint">No archived messages.</p>'
            : '<p class="empty-hint">No messages yet.</p>';
        return;
    }

    container.innerHTML = `
        <ul class="messages-list">
            ${messages.map(m => {
                const ts = new Date(m.created_at).toLocaleString('en-US',
                    { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
                const isArchived = !!m.is_archived;
                return `
                    <li class="message-item${m.is_read ? '' : ' message-unread'}${isArchived ? ' message-archived' : ''}" data-id="${m.id}">
                        <div class="message-header">
                            <span class="message-from">${escHtml(m.parent_name || 'Unknown')}</span>
                            ${m.parent_email ? `<a href="mailto:${escHtml(m.parent_email)}" class="message-email">${escHtml(m.parent_email)}</a>` : ''}
                            <span class="message-time">${ts}</span>
                            ${!m.is_read && !isArchived ? '<span class="message-new-badge">New</span>' : ''}
                            ${isArchived ? '<span class="message-archived-badge">Archived</span>' : ''}
                        </div>
                        <div class="message-body">${escHtml(m.message)}</div>
                        <div class="message-actions">
                            ${!m.is_read && !isArchived ? `<button class="btn-mark-read" data-id="${m.id}">Mark as Read</button>` : ''}
                            ${isArchived
                                ? `<button class="btn-restore-msg" data-id="${m.id}">↩ Restore</button>`
                                : `<button class="btn-archive-msg" data-id="${m.id}" title="Archive message">📥 Archive</button>`
                            }
                        </div>
                    </li>`;
            }).join('')}
        </ul>`;

    container.querySelectorAll('.btn-mark-read').forEach(btn => {
        btn.addEventListener('click', async e => {
            const id = e.currentTarget.getAttribute('data-id');
            try {
                await markMessageRead(id);
                await loadMessages();
            } catch (err) {
                alert('Failed to mark read: ' + err.message);
            }
        });
    });

    container.querySelectorAll('.btn-archive-msg').forEach(btn => {
        btn.addEventListener('click', async e => {
            const id = e.currentTarget.getAttribute('data-id');
            try {
                await archiveMessage(id, true);
                await loadMessages();
            } catch (err) {
                alert('Failed to archive: ' + err.message);
            }
        });
    });

    container.querySelectorAll('.btn-restore-msg').forEach(btn => {
        btn.addEventListener('click', async e => {
            const id = e.currentTarget.getAttribute('data-id');
            try {
                await archiveMessage(id, false);
                await loadMessages();
            } catch (err) {
                alert('Failed to restore: ' + err.message);
            }
        });
    });
}

// ============================================================
// HELPERS
// ============================================================
function csvCell(val) {
    const str = String(val ?? '');
    return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"` : str;
}

function downloadFile(name, type, content) {
    const blob = new Blob([content], { type });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href = url; a.download = name; a.click();
    URL.revokeObjectURL(url);
}

function friendlyShort(dateStr) {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US',
        { month: 'short', day: 'numeric', year: 'numeric' });
}

function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
