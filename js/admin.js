// ============================================================
// ADMIN PASSWORD
// Change this to your desired password.
// For extra security you can move this to an environment
// variable (see README) — but for a small childcare centre
// this is sufficient.
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
    await loadRegistrations();
    renderCapacityOverview();
    setupFilters();
    document.getElementById('refreshBtn').addEventListener('click', loadRegistrations);
    document.getElementById('exportCsvBtn').addEventListener('click', exportCSV);
    document.getElementById('exportXlsxBtn').addEventListener('click', exportExcel);
}

function populateRoomFilter() {
    const sel = document.getElementById('roomFilter');
    ROOMS.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = r.label;
        sel.appendChild(opt);
    });
}

// ============================================================
// LOAD DATA
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
            '<tr><td colspan="9" class="loading-cell error">Failed to load — check your Supabase config.</td></tr>';
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
        const room   = ROOMS.find(r => r.id === reg.room_id) || { label: reg.room_id };
        const dates  = (reg.registration_dates || [])
            .sort((a, b) => a.care_date.localeCompare(b.care_date));

        const datesHtml = dates.map(d => {
            const cls  = d.waitlisted ? 'badge-waitlist' : 'badge-confirmed';
            const label = d.waitlisted ? 'W' : 'C';
            return `<span class="date-chip ${cls}" title="${d.waitlisted ? 'Waitlist' : 'Confirmed'}">${friendlyShort(d.care_date)} <em>${label}</em></span>`;
        }).join('');

        const submitted = new Date(reg.created_at).toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric'
        });

        return `
            <tr data-id="${reg.id}" data-room="${reg.room_id}">
                <td>${submitted}</td>
                <td>${escHtml(reg.parent_name)}</td>
                <td><a href="mailto:${escHtml(reg.parent_email)}">${escHtml(reg.parent_email)}</a></td>
                <td>${escHtml(reg.parent_phone)}</td>
                <td>${escHtml(reg.child_name)}</td>
                <td>${reg.child_age}</td>
                <td>${room.label}</td>
                <td class="dates-cell">${datesHtml}</td>
                <td>
                    <button class="btn-delete" data-id="${reg.id}">Delete</button>
                </td>
            </tr>`;
    }).join('');

    // Delete handlers
    tbody.querySelectorAll('.btn-delete').forEach(btn => {
        btn.addEventListener('click', async e => {
            const id = e.currentTarget.getAttribute('data-id');
            const reg = allRegistrations.find(r => String(r.id) === id);
            const name = reg ? reg.child_name : 'this registration';
            if (!confirm(`Delete registration for ${name}? This cannot be undone.`)) return;
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
    const grid = document.getElementById('capacityGrid');
    const today = new Date(); today.setHours(0,0,0,0);

    // Count confirmed registrations per room over next 30 days
    const counts = {};
    ROOMS.forEach(r => { counts[r.id] = 0; });

    allRegistrations.forEach(reg => {
        (reg.registration_dates || []).forEach(d => {
            if (d.waitlisted) return;
            const dateVal = new Date(d.care_date + 'T00:00:00');
            const diff    = (dateVal - today) / 86400000;
            if (diff >= 0 && diff <= 30) {
                counts[reg.room_id] = (counts[reg.room_id] || 0) + 1;
            }
        });
    });

    grid.innerHTML = ROOMS.map(room => {
        const used  = counts[room.id] || 0;
        const cap   = room.capacity * 30; // rough max over 30 days
        const pct   = Math.min(100, Math.round((used / cap) * 100));
        const color = pct >= 90 ? 'bar-red' : pct >= 70 ? 'bar-orange' : 'bar-green';
        return `
            <div class="cap-card">
                <h3>${room.label}</h3>
                <p class="cap-meta">Max ${room.capacity}/day &middot; ${used} bookings next 30d</p>
                <div class="progress-bar">
                    <div class="progress-fill ${color}" style="width:${pct}%"></div>
                </div>
                <p class="cap-pct">${pct}% utilisation</p>
            </div>`;
    }).join('');
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

        const matchRoom = !room || reg.room_id === room;

        const matchStatus = !status || (reg.registration_dates || []).some(d =>
            status === 'waitlist' ? d.waitlisted : !d.waitlisted
        );

        return matchSearch && matchRoom && matchStatus;
    });

    renderTable(filtered);
}

// ============================================================
// EXPORT — CSV
// ============================================================
function exportCSV() {
    const rows = flattenForExport(allRegistrations);
    const headers = Object.keys(rows[0] || {});
    const csv = [
        headers.join(','),
        ...rows.map(r => headers.map(h => csvCell(r[h])).join(','))
    ].join('\n');

    downloadFile('registrations.csv', 'text/csv', csv);
}

// ============================================================
// EXPORT — EXCEL (.xlsx via SheetJS)
// ============================================================
function exportExcel() {
    const rows = flattenForExport(allRegistrations);
    const ws   = XLSX.utils.json_to_sheet(rows);
    const wb   = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Registrations');

    // Auto-width columns
    const colWidths = Object.keys(rows[0] || {}).map(key => ({
        wch: Math.max(key.length, ...rows.map(r => String(r[key] || '').length))
    }));
    ws['!cols'] = colWidths;

    XLSX.writeFile(wb, 'registrations.xlsx');
}

// ============================================================
// HELPERS
// ============================================================
function flattenForExport(data) {
    const rows = [];
    data.forEach(reg => {
        const room = ROOMS.find(r => r.id === reg.room_id)?.label || reg.room_id;
        const dates = (reg.registration_dates || [])
            .sort((a, b) => a.care_date.localeCompare(b.care_date));

        if (!dates.length) {
            rows.push(baseRow(reg, room, '', ''));
        } else {
            dates.forEach(d => {
                rows.push(baseRow(reg, room, d.care_date, d.waitlisted ? 'Waitlist' : 'Confirmed'));
            });
        }
    });
    return rows;
}

function baseRow(reg, roomLabel, date, status) {
    return {
        'Submitted':    new Date(reg.created_at).toLocaleDateString('en-US'),
        'Parent Name':  reg.parent_name,
        'Email':        reg.parent_email,
        'Phone':        reg.parent_phone,
        'Child Name':   reg.child_name,
        'Child Age':    reg.child_age,
        'Room':         roomLabel,
        'Care Date':    date,
        'Status':       status,
    };
}

function csvCell(val) {
    const str = String(val ?? '');
    return str.includes(',') || str.includes('"') || str.includes('\n')
        ? `"${str.replace(/"/g, '""')}"`
        : str;
}

function downloadFile(name, type, content) {
    const blob = new Blob([content], { type });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
}

function friendlyShort(dateStr) {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
        month: 'short', day: 'numeric'
    });
}

function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}
