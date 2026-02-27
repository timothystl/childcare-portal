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
// LOAD REGISTRATIONS
// ============================================================
async function loadRegistrations() {
    document.getElementById('regTableBody').innerHTML =
        '<tr><td colspan="9" class="loading-cell">Loading…</td></tr>';
    try {
        allRegistrations = await fetchAllRegistrations();
        renderTable(allRegistrations);
        renderCapacityOverview();
        document.getElementById('regCount').textContent =
            `${allRegistrations.length} registration${allRegistrations.length !== 1 ? 's' : ''} total`;
    } catch (err) {
        console.error(err);
        document.getElementById('regTableBody').innerHTML =
            '<tr><td colspan="9" class="loading-cell error">Failed to load — check Supabase config.</td></tr>';
    }
}

// ============================================================
// TABLE RENDER
// ============================================================
function renderTable(data) {
    const tbody = document.getElementById('regTableBody');
    if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="9" class="loading-cell">No registrations found.</td></tr>';
        return;
    }

    tbody.innerHTML = data.map(reg => {
        const room  = ROOMS.find(r => r.id === reg.room_id) || { label: reg.room_id };
        const dates = (reg.registration_dates || [])
            .sort((a, b) => a.care_date.localeCompare(b.care_date));

        const datesHtml = dates.map(d => {
            const cls      = d.waitlisted ? 'badge-waitlist' : 'badge-confirmed';
            const typeChar = d.day_type === 'half' ? '½' : 'F';
            const status   = d.waitlisted ? 'W' : 'C';
            return `<span class="date-chip ${cls}" title="${d.waitlisted ? 'Waitlist' : 'Confirmed'} · ${d.day_type === 'half' ? 'Half Day' : 'Full Day'}">${friendlyShort(d.care_date)} <em>${typeChar}·${status}</em></span>`;
        }).join('');

        const submitted = new Date(reg.created_at).toLocaleDateString('en-US',
            { month: 'short', day: 'numeric', year: 'numeric' });

        const dobDisplay = reg.child_dob
            ? new Date(reg.child_dob + 'T00:00:00').toLocaleDateString('en-US',
                { month: 'short', day: 'numeric', year: 'numeric' })
            : (reg.child_age != null ? reg.child_age + ' mo' : '—');

        return `
            <tr data-id="${reg.id}" data-room="${reg.room_id}">
                <td>${submitted}</td>
                <td>${escHtml(reg.parent_name)}</td>
                <td><a href="mailto:${escHtml(reg.parent_email)}">${escHtml(reg.parent_email)}</a></td>
                <td>${escHtml(reg.parent_phone)}</td>
                <td>${escHtml(reg.child_name)}</td>
                <td>${dobDisplay}</td>
                <td>${room.label}</td>
                <td class="dates-cell">${datesHtml}</td>
                <td>
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
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const counts = {};
    ROOMS.forEach(r => { counts[r.id] = 0; });

    allRegistrations.forEach(reg => {
        (reg.registration_dates || []).forEach(d => {
            if (d.waitlisted) return;
            const diff = (new Date(d.care_date + 'T00:00:00') - today) / 86400000;
            if (diff >= 0 && diff <= 30) counts[reg.room_id] = (counts[reg.room_id] || 0) + 1;
        });
    });

    grid.innerHTML = ROOMS.map(room => {
        const used  = counts[room.id] || 0;
        const cap   = room.capacity * 30;
        const pct   = Math.min(100, Math.round((used / cap) * 100));
        const color = pct >= 90 ? 'bar-red' : pct >= 70 ? 'bar-orange' : 'bar-green';
        return `
            <div class="cap-card">
                <h3>${room.label}</h3>
                <p class="cap-meta">Max ${room.capacity}/day &middot; ${used} bookings next 30d</p>
                <div class="progress-bar"><div class="progress-fill ${color}" style="width:${pct}%"></div></div>
                <p class="cap-pct">${pct}% utilisation</p>
            </div>`;
    }).join('');
}

// ============================================================
// DAILY ROSTER  (Item 2: simplified to just names per room)
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

// Item 2: Simplified view — just child names per room with day type chip
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

    // Group by room
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

    const rows = roster.map(r => ({
        'Date':         date,
        'Room':         r.roomLabel,
        'Child Name':   r.childName,
        'DOB':          r.childDob || '',
        'Day Type':     r.dayType === 'half' ? 'Half Day' : 'Full Day',
        'Rate':         `$${r.rate}`,
        'Parent Name':  r.parentName,
        'Phone':        r.parentPhone,
        'Email':        r.parentEmail,
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Roster ${date}`);
    ws['!cols'] = Object.keys(rows[0]).map(k => ({
        wch: Math.max(k.length, ...rows.map(r => String(r[k] || '').length))
    }));
    XLSX.writeFile(wb, `roster-${date}.xlsx`);
}

// ============================================================
// MONTHLY BILLING REPORT  (Item 5)
// ============================================================
const MONTH_NAMES_ADMIN = ['January','February','March','April','May','June',
                           'July','August','September','October','November','December'];

function setupMonthlyReport() {
    document.getElementById('generateReportBtn').addEventListener('click', generateMonthlyReport);
    document.getElementById('exportReportBtn').addEventListener('click', exportMonthlyReport);

    // Default to current month
    const now = new Date();
    const monthStr = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    document.getElementById('reportMonth').value = monthStr;
}

function generateMonthlyReport() {
    const monthVal = document.getElementById('reportMonth').value;
    if (!monthVal) { alert('Please select a month.'); return; }

    const breakdown = {};
    ROOMS.forEach(r => {
        breakdown[r.id] = {
            roomLabel: r.label,
            full: 0, half: 0,
            waitlistFull: 0, waitlistHalf: 0,
            revenue: 0,
        };
    });

    let totalFull = 0, totalHalf = 0, totalRevenue = 0, totalWaitlist = 0;

    allRegistrations.forEach(reg => {
        const room = ROOMS.find(r => r.id === reg.room_id);
        if (!room) return;
        (reg.registration_dates || []).forEach(d => {
            if (!d.care_date.startsWith(monthVal)) return;
            if (d.waitlisted) {
                if (d.day_type === 'half') breakdown[reg.room_id].waitlistHalf++;
                else                       breakdown[reg.room_id].waitlistFull++;
                totalWaitlist++;
            } else if (d.day_type === 'half') {
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

    renderMonthlyReport(monthLabel, monthVal, breakdown,
        { totalFull, totalHalf, totalRevenue, totalWaitlist });
}

function renderMonthlyReport(monthLabel, monthVal, breakdown, totals) {
    const container = document.getElementById('reportContent');

    const rows = ROOMS.map(room => {
        const b         = breakdown[room.id];
        const totalDays = b.full + b.half;
        const waitlist  = b.waitlistFull + b.waitlistHalf;
        return `
            <tr>
                <td>${room.label}</td>
                <td class="report-num">${b.full}</td>
                <td class="report-num">${b.half}</td>
                <td class="report-num"><strong>${totalDays}</strong></td>
                <td class="report-num report-revenue">$${b.revenue.toFixed(2)}</td>
                <td class="report-num">${waitlist > 0 ? waitlist : '—'}</td>
            </tr>`;
    }).join('');

    if (totals.totalFull === 0 && totals.totalHalf === 0 && totals.totalWaitlist === 0) {
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
                        <th>Waitlisted</th>
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
                        <td class="report-num"><strong>${totals.totalWaitlist > 0 ? totals.totalWaitlist : '—'}</strong></td>
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
        let full = 0, half = 0, waitlist = 0, revenue = 0;
        allRegistrations.forEach(reg => {
            if (reg.room_id !== room.id) return;
            (reg.registration_dates || []).forEach(d => {
                if (!d.care_date.startsWith(monthVal)) return;
                if (d.waitlisted) { waitlist++; return; }
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
            'Waitlisted':  waitlist,
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
    ['searchInput', 'roomFilter', 'statusFilter'].forEach(id => {
        document.getElementById(id).addEventListener('input', applyFilters);
    });
}

function applyFilters() {
    const search = document.getElementById('searchInput').value.toLowerCase();
    const room   = document.getElementById('roomFilter').value;
    const status = document.getElementById('statusFilter').value;

    const filtered = allRegistrations.filter(reg => {
        const matchSearch = !search ||
            reg.parent_name.toLowerCase().includes(search)  ||
            reg.parent_email.toLowerCase().includes(search) ||
            reg.child_name.toLowerCase().includes(search);
        const matchRoom   = !room   || reg.room_id === room;
        const matchStatus = !status || (reg.registration_dates || []).some(d =>
            status === 'waitlist' ? d.waitlisted : !d.waitlisted);
        return matchSearch && matchRoom && matchStatus;
    });
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
    };
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
