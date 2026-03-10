// ============================================================
// STATE
// ============================================================
let allRegistrations = [];
let allClosureDates  = new Set(); // YYYY-MM-DD strings
let tableSortState   = { col: 'submitted', dir: 'desc' }; // default: newest first
let familiesSortBy   = 'name'; // 'name' | 'room' | 'discount' | 'age_asc' | 'age_desc'
let familiesPage     = 0;
const FAMILIES_PAGE_SIZE = 20;

// ============================================================
// LOGIN  (Supabase Auth — server-validated)
// ============================================================
document.getElementById('loginBtn').addEventListener('click', attemptLogin);
document.getElementById('adminPassword').addEventListener('keydown', e => {
    if (e.key === 'Enter') attemptLogin();
});
document.getElementById('adminEmail').addEventListener('keydown', e => {
    if (e.key === 'Enter') attemptLogin();
});

async function attemptLogin() {
    const email = document.getElementById('adminEmail').value.trim();
    const pwd   = document.getElementById('adminPassword').value;
    const errEl = document.getElementById('loginError');
    const btn   = document.getElementById('loginBtn');

    errEl.classList.add('hidden');
    btn.disabled    = true;
    btn.textContent = 'Signing in…';

    try {
        await loginAdmin(email, pwd);
        showDashboard();
    } catch (_) {
        errEl.textContent = 'Incorrect email or password.';
        errEl.classList.remove('hidden');
    } finally {
        btn.disabled    = false;
        btn.textContent = 'Login';
    }
}

document.getElementById('logoutBtn').addEventListener('click', async () => {
    await logoutAdmin();
    document.getElementById('loginScreen').classList.remove('hidden');
    document.getElementById('dashboard').classList.add('hidden');
    document.getElementById('adminPassword').value = '';
    document.getElementById('adminEmail').value    = '';
});

function showDashboard() {
    document.getElementById('loginScreen').classList.add('hidden');
    document.getElementById('dashboard').classList.remove('hidden');
    initDashboard();
}

// Auto-restore session if already logged in
(async () => {
    const session = await getAdminSession();
    if (session) showDashboard();
})();

// ============================================================
// DASHBOARD INIT
// ============================================================
let dashboardInitDone = false;
async function initDashboard() {
    if (dashboardInitDone) return;
    dashboardInitDone = true;
    populateRoomFilter();
    populateRosterRoomFilter();
    try {
        await Promise.all([loadRegistrations(), loadClosureList(), loadRateSettings(), loadRatioSettings(), loadOfferLinks().then(v => { window._globalOfferLinks = v; })]);
    } catch (err) {
        console.error('initDashboard: initial data load failed —', err);
        // Continue setup so the tab structure is always rendered
    }
    initCapacityMonthNav();
    renderCapacityOverview();
    setupFilters();
    setupRoster();
    setupClosures();
    setupMonthlyReport();
    setupMonthlyRoster();
    setupFamilyBilling();
    setupWindowOverride();
    setupFamilies();
    setupMessages();
    setupRoomCalendar();
    setupRates();
    setupRatios();
    setupOfferLinks();
    setupStaffScheduling();
    setupStaffRoster();
    setupHoursEntry();
    setupPayrollReport();
    setupExtraReports();
    setupWaitlistAdmin();
    setupTabs();
    setupCollapsibles();
    document.getElementById('refreshBtn').addEventListener('click', () => {
        const active = localStorage.getItem('adminActiveTab') || 'daily';
        if (active === 'registrations') loadRegistrations();
        else if (active === 'families')  loadFamilies();
        else if (active === 'messages')  loadMessages();
        else if (active === 'waitlist')  loadWaitlist();
        else if (active === 'staffing')  loadStaffList();
        else loadRegistrations(); // daily / settings / reports — fall back to registrations
    });
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

// Applies an individual student discount (same logic as app.js effectiveRate)
function effectiveAdminRate(baseRate, discountType, discountValue) {
    if (!baseRate) return 0;
    if (discountType === 'staff') return 0;
    if (discountType === 'custom' && discountValue > 0)
        return Math.round(baseRate * (1 - discountValue / 100) * 100) / 100;
    return baseRate;
}

// Build a fast lookup: `${parentEmail}:${childName}` (lower-cased) → {type, value}
// Uses allFamiliesData if already loaded (populated by loadFamilies())
function buildDiscountMap() {
    const map = new Map();
    (allFamiliesData || []).forEach(f => {
        (f.students || []).forEach(s => {
            if (!s.discount_type || s.discount_type === 'none') return;
            const childKey = (s.child_name || '').toLowerCase();
            const disc = { type: s.discount_type, value: s.discount_value || 0 };
            // Index by both parent emails so registrations by either parent get the discount
            [f.parent_email, f.parent2_email].filter(Boolean).forEach(email => {
                map.set(`${email.toLowerCase()}:${childKey}`, disc);
            });
        });
    });
    return map;
}

// Cached discount map — rebuilt whenever families are loaded
let _discountMap = null;
function getDiscountMap() {
    if (!_discountMap) _discountMap = buildDiscountMap();
    return _discountMap;
}

function calcRegistrationBill(reg) {
    const room = ROOMS.find(r => r.id === reg.room_id);
    if (!room) return 0;
    const dmap  = getDiscountMap();
    const key   = `${(reg.parent_email || '').toLowerCase()}:${(reg.child_name || '').toLowerCase()}`;
    const disc  = dmap.get(key) || { type: 'none', value: 0 };
    return (reg.registration_dates || [])
        .filter(d => !d.waitlisted)
        .reduce((sum, d) => {
            const rate = d.day_type === 'half' ? (room.halfDayRate || 0) : (room.fullDayRate || 0);
            return sum + effectiveAdminRate(rate, disc.type, disc.value);
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
    // Update sort indicators on column headers
    document.querySelectorAll('#regTable thead th[data-col]').forEach(th => {
        const col = th.dataset.col;
        const isActive = col === tableSortState.col;
        th.classList.toggle('sort-active', isActive);
        // Strip old indicator then re-add
        th.textContent = th.textContent.replace(/\s*[▲▼]$/, '');
        if (isActive) th.textContent += tableSortState.dir === 'asc' ? ' ▲' : ' ▼';
    });

    const tbody = document.getElementById('regTableBody');
    if (!data.length) {
        tbody.innerHTML = '<tr><td colspan="11" class="loading-cell">No registrations found.</td></tr>';
        return;
    }

    tbody.innerHTML = data.map(reg => {
        const room  = ROOMS.find(r => r.id === reg.room_id) || { label: reg.room_id };
        const dates = (reg.registration_dates || [])
            .sort((a, b) => a.care_date.localeCompare(b.care_date));

        // Date chips — show ½ day or Full
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

        // Discount info — try reg email first, fall back to searching all family emails
        const discKey = `${(reg.parent_email || '').toLowerCase()}:${(reg.child_name || '').toLowerCase()}`;
        const disc    = getDiscountMap().get(discKey);
        const discLabel = disc
            ? (disc.type === 'staff' ? 'Staff (free)' : `${disc.value}% off`)
            : '—';

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
                <td class="discount-cell">${discLabel}</td>
                <td class="actions-cell">
                    <button class="btn-secondary btn-edit-days" data-id="${reg.id}">Edit Days</button>
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

    tbody.querySelectorAll('.btn-edit-days').forEach(btn => {
        btn.addEventListener('click', e => {
            const id  = e.currentTarget.getAttribute('data-id');
            const reg = allRegistrations.find(r => String(r.id) === id);
            if (reg) openEditDaysModal(reg);
        });
    });
}

// ============================================================
// EDIT DAYS MODAL
// ============================================================
let editDaysReg = null;

function openEditDaysModal(reg) {
    editDaysReg = reg;
    document.getElementById('editDaysTitle').textContent =
        `Edit Days — ${reg.child_name}`;
    document.getElementById('editDaysDate').value = '';
    document.getElementById('editDaysDayType').value = 'full';
    document.getElementById('editDaysWaitlist').checked = false;
    document.getElementById('editDaysError').textContent = '';
    renderEditDaysList();
    document.getElementById('editDaysModal').classList.remove('hidden');
}

function renderEditDaysList() {
    const reg   = editDaysReg;
    const dates = (reg.registration_dates || [])
        .slice()
        .sort((a, b) => a.care_date.localeCompare(b.care_date));

    const body = document.getElementById('editDaysBody');
    if (!dates.length) {
        body.innerHTML = '<p style="color:#888;font-size:.9em;padding:8px 0">No days scheduled.</p>';
        return;
    }
    body.innerHTML = `<div style="display:flex;flex-direction:column;gap:4px;max-height:280px;overflow-y:auto;margin-bottom:8px">
        ${dates.map(d => {
            const label    = friendlyShort(d.care_date);
            const typeTag  = d.day_type === 'half' ? 'Half' : 'Full';
            const wlTag    = d.waitlisted ? ' · Waitlist' : '';
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:#f8f9ff;border-radius:8px;font-size:.9em">
                <span>${label} — <strong>${typeTag}</strong>${wlTag}</span>
                <button class="btn-delete edit-days-remove-btn" data-date-id="${d.id}" style="padding:3px 10px;font-size:.82em">Remove</button>
            </div>`;
        }).join('')}
    </div>`;

    body.querySelectorAll('.edit-days-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const dateId = btn.dataset.dateId;
            btn.disabled = true;
            try {
                await deleteRegistrationDate(dateId);
                // Update local state
                editDaysReg.registration_dates = editDaysReg.registration_dates.filter(
                    d => String(d.id) !== String(dateId)
                );
                allRegistrations = allRegistrations.map(r =>
                    r.id === editDaysReg.id ? editDaysReg : r
                );
                renderEditDaysList();
                renderTable(allRegistrations);
            } catch (err) {
                alert('Remove failed: ' + err.message);
                btn.disabled = false;
            }
        });
    });
}

document.getElementById('editDaysClose')?.addEventListener('click', () => {
    document.getElementById('editDaysModal').classList.add('hidden');
    editDaysReg = null;
});

document.getElementById('editDaysAddBtn')?.addEventListener('click', async () => {
    const dateVal  = document.getElementById('editDaysDate').value;
    const dayType  = document.getElementById('editDaysDayType').value;
    const waitlist = document.getElementById('editDaysWaitlist').checked;
    const errEl    = document.getElementById('editDaysError');

    if (!dateVal) { errEl.textContent = 'Please select a date.'; return; }
    if (!editDaysReg) return;

    // Check for duplicate
    if ((editDaysReg.registration_dates || []).some(d => d.care_date === dateVal)) {
        errEl.textContent = 'That date is already on this registration.';
        return;
    }

    errEl.textContent = '';
    const btn = document.getElementById('editDaysAddBtn');
    btn.disabled = true;
    try {
        await addRegistrationDate(editDaysReg.id, editDaysReg.room_id, dateVal, dayType, waitlist);
        // Reload registration to get the new date's ID
        const fresh = await fetchAllRegistrations();
        allRegistrations = fresh;
        editDaysReg = fresh.find(r => r.id === editDaysReg.id) || editDaysReg;
        renderEditDaysList();
        renderTable(allRegistrations);
        document.getElementById('editDaysDate').value = '';
    } catch (err) {
        errEl.textContent = 'Add failed: ' + err.message;
    } finally {
        btn.disabled = false;
    }
});

// ============================================================
// CAPACITY OVERVIEW
// ============================================================
let capOverviewDate = null; // JS Date set to 1st of currently displayed month

function initCapacityMonthNav() {
    const today = new Date();
    capOverviewDate = new Date(today.getFullYear(), today.getMonth(), 1);

    // Populate select: 6 months back → 12 months ahead
    const sel = document.getElementById('capMonthSelect');
    if (sel) {
        sel.innerHTML = '';
        for (let offset = -6; offset <= 12; offset++) {
            const d = new Date(today.getFullYear(), today.getMonth() + offset, 1);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = MONTH_NAMES_ADMIN[d.getMonth()] + ' ' + d.getFullYear();
            if (offset === 0) opt.selected = true;
            sel.appendChild(opt);
        }
        sel.addEventListener('change', () => {
            const [y, m] = sel.value.split('-').map(Number);
            capOverviewDate = new Date(y, m - 1, 1);
            renderCapacityOverview();
        });
    }

    document.getElementById('capPrevMonth')?.addEventListener('click', () => {
        capOverviewDate = new Date(capOverviewDate.getFullYear(), capOverviewDate.getMonth() - 1, 1);
        _syncCapSelect();
        renderCapacityOverview();
    });
    document.getElementById('capNextMonth')?.addEventListener('click', () => {
        capOverviewDate = new Date(capOverviewDate.getFullYear(), capOverviewDate.getMonth() + 1, 1);
        _syncCapSelect();
        renderCapacityOverview();
    });
}

function _syncCapSelect() {
    const sel = document.getElementById('capMonthSelect');
    if (!sel || !capOverviewDate) return;
    const key = `${capOverviewDate.getFullYear()}-${String(capOverviewDate.getMonth() + 1).padStart(2, '0')}`;
    // If the target month isn't in the select, add it
    let opt = [...sel.options].find(o => o.value === key);
    if (!opt) {
        opt = document.createElement('option');
        opt.value = key;
        opt.textContent = MONTH_NAMES_ADMIN[capOverviewDate.getMonth()] + ' ' + capOverviewDate.getFullYear();
        sel.appendChild(opt);
    }
    sel.value = key;
}

function renderCapacityOverview() {
    const grid = document.getElementById('capacityGrid');
    if (!capOverviewDate) capOverviewDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const y = capOverviewDate.getFullYear();
    const m = capOverviewDate.getMonth();
    const key = `${y}-${String(m + 1).padStart(2, '0')}`;

    // Count Mon–Fri working days in the month
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
                const roomKey = d.room_id || reg.room_id;
                counts[roomKey] = (counts[roomKey] || 0) + 1;
            }
        });
    });

    const cards = ROOMS.map(room => {
        const used  = counts[room.id] || 0;
        const cap   = room.capacity * workingDays;
        const pct   = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
        const color = pct >= 90 ? 'bar-red' : pct >= 70 ? 'bar-orange' : 'bar-green';
        return `
            <div class="cap-card" data-room-id="${room.id}" data-month-key="${key}" role="button" tabindex="0" title="View ${room.label} calendar">
                <h3>${room.label}</h3>
                <p class="cap-meta">Max ${room.capacity}/day &middot; ${used} booking${used !== 1 ? 's' : ''}</p>
                <div class="progress-bar"><div class="progress-fill ${color}" style="width:${pct}%"></div></div>
                <p class="cap-pct">${pct}% utilisation</p>
                <p class="cap-card-hint">Click to view calendar →</p>
            </div>`;
    }).join('');

    grid.innerHTML = `<div class="capacity-grid">${cards}</div>`;
}

// ============================================================
// ROOM CAPACITY CALENDAR MODAL
// ============================================================
let rcalRoomId    = null;
let rcalMonthDate = null; // JS Date set to 1st of displayed month
let rcalSetupDone = false; // guard against double-registration if initDashboard runs twice

function setupRoomCalendar() {
    if (rcalSetupDone) return;
    rcalSetupDone = true;

    // Wire up modal buttons (null-safe in case modal HTML is missing/cached)
    document.getElementById('rcalClose')?.addEventListener('click', closeRoomCalendar);
    document.getElementById('rcalPrev')?.addEventListener('click', () => {
        rcalMonthDate = new Date(rcalMonthDate.getFullYear(), rcalMonthDate.getMonth() - 1, 1);
        drawRoomCalendar();
    });
    document.getElementById('rcalNext')?.addEventListener('click', () => {
        rcalMonthDate = new Date(rcalMonthDate.getFullYear(), rcalMonthDate.getMonth() + 1, 1);
        drawRoomCalendar();
    });
    document.getElementById('roomCalModal')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) closeRoomCalendar();
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            closeDayRosterDetail();
            closeRoomCalendar();
        }
    });

    // Cap-card click/keyboard delegation (capacity overview → open room calendar)
    document.addEventListener('click', e => {
        const card = e.target.closest('.cap-card[data-room-id]');
        if (card) openRoomCalendar(card.dataset.roomId, card.dataset.monthKey);
    });
    document.addEventListener('keydown', e => {
        if (e.key === 'Enter' || e.key === ' ') {
            const card = e.target.closest('.cap-card[data-room-id]');
            if (card) { e.preventDefault(); openRoomCalendar(card.dataset.roomId, card.dataset.monthKey); }
        }
    });

    // Default room schedule week to the current Monday
    const rsWeekInput = document.getElementById('roomSchedWeekOf');
    if (rsWeekInput) {
        const today = new Date();
        const day   = today.getDay();                         // 0=Sun … 6=Sat
        const diff  = (day === 0 ? -6 : 1 - day);            // days back to Mon
        const mon   = new Date(today);
        mon.setDate(today.getDate() + diff);
        rsWeekInput.value = mon.toISOString().split('T')[0];
    }
    document.getElementById('viewRoomSchedBtn')?.addEventListener('click', renderRoomSchedule);
}

async function renderRoomSchedule() {
    const weekOf    = document.getElementById('roomSchedWeekOf')?.value;
    if (!weekOf) { alert('Please select a week first.'); return; }

    const btn       = document.getElementById('viewRoomSchedBtn');
    const container = document.getElementById('roomSchedContent');
    btn.disabled = true; btn.textContent = 'Loading…';
    container.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        // Ensure registration data is loaded
        if (!allRegistrations.length) allRegistrations = await fetchAllRegistrations();

        const weekDates = _buildWeekDates(weekOf);
        if (!weekDates.length) {
            container.innerHTML = '<p class="empty-hint">No school days in this week (all weekends or closed days).</p>';
            return;
        }

        const counts = _buildShiftCounts(weekDates);

        const roomHeaders = ROOMS.map(r => `<th colspan="2" class="staff-room-header">${r.label}</th>`).join('');
        const subHeaders  = ROOMS.map(() =>
            `<th class="staff-sub-head shift-am-th">AM</th><th class="staff-sub-head shift-pm-th">PM</th>`
        ).join('');

        const rows = weekDates.map(d => {
            const dt    = new Date(d + 'T00:00:00');
            const label = `${DAY_ABBR[dt.getDay()]} ${friendlyShort(d)}`;
            const cells = ROOMS.map(room => {
                const c   = counts[d][room.id] || { total: 0, fullDay: 0 };
                const cap = room.capacity || 0;

                const amCls = cap && c.total   >= cap ? 'sched-full' : cap && c.total   >= cap * .8 ? 'sched-near' : '';
                const pmCls = cap && c.fullDay >= cap ? 'sched-full' : cap && c.fullDay >= cap * .8 ? 'sched-near' : '';

                const amStr = cap ? `${c.total}/${cap}`    : (c.total   > 0 ? String(c.total)   : '—');
                const pmStr = cap ? `${c.fullDay}/${cap}`  : (c.fullDay > 0 ? String(c.fullDay) : '—');

                return `<td class="sched-cell ${amCls}">${amStr}</td><td class="sched-cell ${pmCls}">${pmStr}</td>`;
            }).join('');
            return `<tr><td class="staff-date-cell"><strong>${label}</strong></td>${cells}</tr>`;
        }).join('');

        container.innerHTML = `
            <div class="table-wrapper staff-table-wrap">
                <table class="report-table autofill-table">
                    <thead>
                        <tr>
                            <th rowspan="2" class="staff-date-header">Date</th>
                            ${roomHeaders}
                        </tr>
                        <tr>${subHeaders}</tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>
            <p class="sched-legend">AM = all enrolled &nbsp;·&nbsp; PM = full-day only &nbsp;·&nbsp; <span class="sched-near-swatch"></span> ≥80% full &nbsp;·&nbsp; <span class="sched-full-swatch"></span> at/over capacity</p>`;
    } catch (err) {
        container.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    } finally {
        btn.disabled = false; btn.textContent = 'View Week';
    }
}

// ---- Day Roster Detail popup (inside room calendar) ----
function showDayRosterDetail(dateStr, roomId, enrolled, cap) {
    // Lazy-create the detail panel
    let panel = document.getElementById('dayDetailPanel');
    if (!panel) {
        panel = document.createElement('div');
        panel.id        = 'dayDetailPanel';
        panel.className = 'day-detail-panel';
        panel.innerHTML = `
            <div class="day-detail-inner">
                <div class="day-detail-header">
                    <span id="dayDetailTitle" class="day-detail-title"></span>
                    <button id="dayDetailClose" class="day-detail-close" title="Close">✕</button>
                </div>
                <div id="dayDetailBody" class="day-detail-body"></div>
            </div>`;
        document.getElementById('roomCalModal')?.querySelector('.rcal-dialog')?.appendChild(panel)
            || document.body.appendChild(panel);
        document.getElementById('dayDetailClose').addEventListener('click', closeDayRosterDetail);
    }

    const room = ROOMS.find(r => r.id === roomId);
    document.getElementById('dayDetailTitle').textContent =
        `${room?.label || roomId} — ${friendlyShort(dateStr)}`;

    // Build per-room enrollment counts for this date (for availability info in dropdown)
    const roomCounts = {};
    ROOMS.forEach(r => { roomCounts[r.id] = 0; });
    allRegistrations.forEach(reg => {
        (reg.registration_dates || []).forEach(d => {
            if (d.care_date === dateStr && !d.waitlisted) {
                roomCounts[d.room_id] = (roomCounts[d.room_id] || 0) + 1;
            }
        });
    });

    const otherRooms = ROOMS.filter(r => r.id !== roomId);
    const isFull     = cap > 0 && enrolled.length >= cap;

    const bodyEl = document.getElementById('dayDetailBody');
    if (!enrolled.length) {
        bodyEl.innerHTML = '<p class="empty-hint" style="padding:12px 0;">No children booked for this day.</p>';
    } else {
        const countBadge = isFull
            ? `<span class="day-detail-full-badge">Room is full</span>`
            : ``;
        const moveOptions = otherRooms.map(r => {
            const cnt       = roomCounts[r.id] || 0;
            const spotsLeft = Math.max(0, r.capacity - cnt);
            const avail     = spotsLeft === 0 ? 'Full' : `${spotsLeft} open`;
            return `<option value="${r.id}">${r.label} — ${avail}</option>`;
        }).join('');

        bodyEl.innerHTML = `
            <p class="day-detail-count">
                ${enrolled.length} / ${cap} spots filled ${countBadge}
            </p>
            <ul class="day-detail-list">
                ${enrolled.map(e => `
                    <li class="day-detail-item">
                        <span class="day-detail-name">${escHtml(e.childName)}</span>
                        <span class="day-chip ${e.dayType}">${e.dayType === 'half' ? 'Half Day' : 'Full Day'}</span>
                        <select class="day-move-select" data-date-id="${e.dateId}"
                                data-child="${escHtml(e.childName)}"
                                data-from-room="${roomId}"
                                title="Move ${escHtml(e.childName)} to a different room for this day only">
                            <option value="">Move to…</option>
                            ${moveOptions}
                        </select>
                    </li>`).join('')}
            </ul>`;

        // Wire move dropdowns
        bodyEl.querySelectorAll('.day-move-select').forEach(sel => {
            sel.addEventListener('change', async () => {
                const newRoomId   = sel.value;
                if (!newRoomId) return;
                const childName   = sel.dataset.child;
                const dateId      = sel.dataset.dateId;
                const fromRoom    = ROOMS.find(r => r.id === sel.dataset.fromRoom)?.label || sel.dataset.fromRoom;
                const toRoom      = ROOMS.find(r => r.id === newRoomId)?.label || newRoomId;
                if (!confirm(`Move ${childName} from ${fromRoom} to ${toRoom} for ${friendlyShort(dateStr)} only?\n\nAll other days stay unchanged.`)) {
                    sel.value = '';
                    return;
                }
                sel.disabled = true;
                try {
                    await updateRegistrationDateRoom(dateId, newRoomId);
                    // Update in-memory allRegistrations so the calendar redraws correctly
                    allRegistrations = allRegistrations.map(reg => {
                        const dates = (reg.registration_dates || []).map(d =>
                            String(d.id) === String(dateId) ? { ...d, room_id: newRoomId } : d
                        );
                        return { ...reg, registration_dates: dates };
                    });
                    closeDayRosterDetail();
                    drawRoomCalendar();
                    renderCapacityOverview();
                } catch (err) {
                    alert('Move failed: ' + err.message);
                    sel.disabled = false;
                    sel.value = '';
                }
            });
        });
    }

    panel.classList.remove('hidden');
    panel.classList.add('visible');
}

function closeDayRosterDetail() {
    const panel = document.getElementById('dayDetailPanel');
    if (panel) { panel.classList.remove('visible'); panel.classList.add('hidden'); }
}

function openRoomCalendar(roomId, monthKey) {
    try {
        rcalRoomId    = roomId;
        const [y, m]  = monthKey.split('-').map(Number);
        rcalMonthDate = new Date(y, m - 1, 1);
        drawRoomCalendar();
        const modal = document.getElementById('roomCalModal');
        if (!modal) { console.error('roomCalModal element not found'); return; }
        modal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    } catch (err) {
        console.error('openRoomCalendar error:', err);
    }
}

function closeRoomCalendar() {
    const modal = document.getElementById('roomCalModal');
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
}

function drawRoomCalendar() {
    const room  = ROOMS.find(r => r.id === rcalRoomId);
    const y     = rcalMonthDate.getFullYear();
    const m     = rcalMonthDate.getMonth(); // 0-based
    const monthKey = `${y}-${String(m + 1).padStart(2, '0')}`;

    document.getElementById('rcalRoomName').textContent  = room?.label || rcalRoomId;
    document.getElementById('rcalMonthLabel').textContent = MONTH_NAMES_ADMIN[m] + ' ' + y;

    // Build dayMap: 'YYYY-MM-DD' → [{ childName, dayType, dateId }]
    // Filter by the date's own room_id (not the registration's) so per-day moves are reflected.
    const dayMap = {};
    allRegistrations.forEach(reg => {
        (reg.registration_dates || []).forEach(d => {
            if (d.room_id !== rcalRoomId) return;
            if (d.waitlisted || !d.care_date || !d.care_date.startsWith(monthKey)) return;
            if (!dayMap[d.care_date]) dayMap[d.care_date] = [];
            dayMap[d.care_date].push({ childName: reg.child_name, dayType: d.day_type, dateId: d.id });
        });
    });

    const cap        = room?.capacity || 0;
    const daysInMonth = new Date(y, m + 1, 0).getDate();

    // Mon-offset for first day of month in a Mon–Fri 5-column grid.
    // If month starts Sat or Sun, first weekday is Mon the 2nd/3rd → 0 lead empties.
    const firstDow  = new Date(y, m, 1).getDay(); // 0=Sun … 6=Sat
    const monBased  = firstDow === 0 ? 6 : firstDow - 1; // 0=Mon … 4=Fri, 5=Sat, 6=Sun
    const leadEmpties = monBased < 5 ? monBased : 0; // Sat/Sun → 0, weekday → its Mon-based offset

    // Build cell data
    const cells = [];
    for (let i = 0; i < leadEmpties; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
        const dow = new Date(y, m, day).getDay();
        if (dow === 0 || dow === 6) continue;
        const dateStr  = `${monthKey}-${String(day).padStart(2, '0')}`;
        const enrolled = (dayMap[dateStr] || []).slice().sort((a, b) => a.childName.localeCompare(b.childName));
        const isClosed = allClosureDates.has(dateStr);
        cells.push({ day, dateStr, enrolled, cap, isClosed });
    }

    // Render day-of-week header
    const dowHtml = ['Mon','Tue','Wed','Thu','Fri']
        .map(d => `<div class="rcal-dow-cell">${d}</div>`).join('');

    // Render cells
    const cellsHtml = cells.map(cell => {
        if (!cell) return `<div class="rcal-cell rcal-cell-empty"></div>`;
        const { day, dateStr, enrolled, cap, isClosed } = cell;
        if (isClosed) return `
            <div class="rcal-cell rcal-cell-closed">
                <div class="rcal-day-num">${day}</div>
                <div class="rcal-closed-label">Closed</div>
            </div>`;
        const count    = enrolled.length;
        const pct      = cap > 0 ? count / cap : 0;
        const cls      = pct >= 1 ? 'rcal-cell-full' : pct >= 0.75 ? 'rcal-cell-near' : 'rcal-cell-open';
        const countLbl = cap ? `${count}/${cap}` : `${count}`;
        const spotsLeft = Math.max(0, cap - count);
        const slotLabel = spotsLeft === 0 ? 'Full' : `${spotsLeft} open`;
        return `
            <div class="rcal-cell ${cls} rcal-cell-clickable"
                 data-date="${dateStr}"
                 role="button" tabindex="0" title="Click to view roster for this day">
                <div class="rcal-day-num">${day}</div>
                <div class="rcal-count">${countLbl}</div>
                <div class="rcal-slots-label">${slotLabel}</div>
            </div>`;
    }).join('');

    document.getElementById('rcalBody').innerHTML = `
        <div class="rcal-dow-row">${dowHtml}</div>
        <div class="rcal-grid">${cellsHtml}</div>`;

    // Attach click listeners directly to each cell via closure data (avoids JSON
    // attribute parsing and stopPropagation conflicts with the modal overlay).
    cells.forEach(cell => {
        if (!cell || cell.isClosed) return;
        const el = document.querySelector(`#rcalBody [data-date="${cell.dateStr}"]`);
        if (el) {
            el.addEventListener('click', () =>
                showDayRosterDetail(cell.dateStr, rcalRoomId, cell.enrolled, cell.cap));
        }
    });
}

// ============================================================
// DAILY ROSTER
// ============================================================
function setupRoster() {
    document.getElementById('viewRosterBtn').addEventListener('click', viewRoster);
    document.getElementById('exportRosterBtn').addEventListener('click', exportRoster);
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
// FAMILY BILLING REPORT
// ============================================================
function setupFamilyBilling() {
    document.getElementById('generateFamilyBillingBtn')?.addEventListener('click', async () => {
        if (allFamiliesData.length === 0) await loadFamilies();
        generateFamilyBillingReport();
    });
    document.getElementById('exportFamilyBillingBtn')?.addEventListener('click', exportFamilyBillingReport);
    const now = new Date();
    const el = document.getElementById('familyBillingMonth');
    if (el) el.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}

function _buildFamilyBillingData(monthVal) {
    const dmap      = getDiscountMap();
    const familyMap = new Map();

    allRegistrations.forEach(reg => {
        const dates = (reg.registration_dates || []).filter(d =>
            !d.waitlisted && d.care_date && d.care_date.startsWith(monthVal));
        if (!dates.length) return;

        const key = (reg.parent_email || reg.parent_name || '').toLowerCase().trim();
        if (!familyMap.has(key)) {
            familyMap.set(key, {
                parentName:  reg.parent_name,
                parentEmail: reg.parent_email,
                parentPhone: reg.parent_phone,
                children: [],
            });
        }
        const fam      = familyMap.get(key);
        const room     = ROOMS.find(r => r.id === reg.room_id);
        const discKey  = `${(reg.parent_email || '').toLowerCase()}:${(reg.child_name || '').toLowerCase()}`;
        const disc     = dmap.get(discKey) || { type: 'none', value: 0 };
        let fullDays = 0, halfDays = 0, subtotal = 0;
        dates.forEach(d => {
            const rate = d.day_type === 'half' ? (room?.halfDayRate || 0) : (room?.fullDayRate || 0);
            subtotal += effectiveAdminRate(rate, disc.type, disc.value);
            if (d.day_type === 'half') halfDays++; else fullDays++;
        });

        // Merge if child already present (multiple reg rows for same child + month)
        const existing = fam.children.find(c => c.childName === reg.child_name);
        if (existing) {
            existing.fullDays += fullDays;
            existing.halfDays += halfDays;
            existing.subtotal += subtotal;
        } else {
            fam.children.push({
                childName: reg.child_name,
                roomLabel: room?.label || reg.room_id,
                fullDays,
                halfDays,
                subtotal,
                discLabel: disc.type === 'staff'  ? 'Staff (free)' :
                           disc.type === 'custom' ? `${disc.value}% off` : '—',
            });
        }
    });

    return [...familyMap.values()].sort((a, b) => {
        const la = (a.parentName || '').split(' ').pop().toLowerCase();
        const lb = (b.parentName || '').split(' ').pop().toLowerCase();
        return la.localeCompare(lb);
    });
}

function generateFamilyBillingReport() {
    const monthVal = document.getElementById('familyBillingMonth')?.value;
    if (!monthVal) { alert('Please select a month.'); return; }

    const [y, m]    = monthVal.split('-').map(Number);
    const monthLabel = MONTH_NAMES_ADMIN[m - 1] + ' ' + y;
    const families   = _buildFamilyBillingData(monthVal);

    const container = document.getElementById('familyBillingContent');
    if (!families.length) {
        container.innerHTML = `<p class="empty-hint">No registrations found for ${monthLabel}.</p>`;
        return;
    }

    let grandTotal = 0;
    const rows = families.map(fam => {
        const familyTotal = fam.children.reduce((s, c) => s + c.subtotal, 0);
        grandTotal += familyTotal;
        const childRows = fam.children.map(c => `
            <tr class="billing-child-row">
                <td class="billing-indent">${escHtml(c.childName)}</td>
                <td>${escHtml(c.roomLabel)}</td>
                <td class="report-num">${c.fullDays || '—'}</td>
                <td class="report-num">${c.halfDays || '—'}</td>
                <td class="report-num">${c.discLabel}</td>
                <td class="report-num report-revenue">$${c.subtotal.toFixed(2)}</td>
            </tr>`).join('');
        return `
            <tr class="billing-family-row">
                <td colspan="5">
                    <strong>${escHtml(fam.parentName)}</strong>
                    <span class="billing-contact">${escHtml(fam.parentEmail)}${fam.parentPhone ? ' · ' + escHtml(fam.parentPhone) : ''}</span>
                </td>
                <td class="report-num report-revenue billing-family-total"><strong>$${familyTotal.toFixed(2)}</strong></td>
            </tr>
            ${childRows}`;
    }).join('');

    container.innerHTML = `
        <h3 class="report-month-title">${monthLabel} — ${families.length} famil${families.length !== 1 ? 'ies' : 'y'}</h3>
        <div class="table-wrapper report-table-wrap">
            <table class="report-table billing-table">
                <thead>
                    <tr>
                        <th>Family / Child</th>
                        <th>Room</th>
                        <th>Full Days</th>
                        <th>Half Days</th>
                        <th>Discount</th>
                        <th>Amount Due</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
                <tfoot>
                    <tr class="report-total-row">
                        <td colspan="5"><strong>Grand Total — ${families.length} famil${families.length !== 1 ? 'ies' : 'y'}</strong></td>
                        <td class="report-num report-revenue"><strong>$${grandTotal.toFixed(2)}</strong></td>
                    </tr>
                </tfoot>
            </table>
        </div>`;
}

function exportFamilyBillingReport() {
    const monthVal = document.getElementById('familyBillingMonth')?.value;
    if (!monthVal) { alert('Please select a month first.'); return; }

    const families = _buildFamilyBillingData(monthVal);
    if (!families.length) { alert('No data to export.'); return; }

    const rows = [];
    families.forEach(fam => {
        fam.children.forEach(c => {
            rows.push({
                'Parent Name':  fam.parentName,
                'Email':        fam.parentEmail,
                'Phone':        fam.parentPhone,
                'Child Name':   c.childName,
                'Room':         c.roomLabel,
                'Full Days':    c.fullDays,
                'Half Days':    c.halfDays,
                'Discount':     c.discLabel,
                'Amount Due':   `$${c.subtotal.toFixed(2)}`,
            });
        });
    });

    const [y, m] = monthVal.split('-').map(Number);
    const label  = MONTH_NAMES_ADMIN[m - 1] + '-' + y;
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, label);
    ws['!cols'] = Object.keys(rows[0]).map(k => ({
        wch: Math.max(k.length, ...rows.map(r => String(r[k] || '').length))
    }));
    XLSX.writeFile(wb, `family-billing-${monthVal}.xlsx`);
}

// ============================================================
// STAFF SCHEDULING
// ============================================================
function setupStaffScheduling() {
    document.getElementById('generateStaffBtn')?.addEventListener('click', generateStaffSchedule);
    document.getElementById('autoFillStaffBtn')?.addEventListener('click', autoFillStaffSchedule);
    document.getElementById('exportStaffBtn')?.addEventListener('click', exportStaffSchedule);

    // Default to the Monday of the current week
    const el = document.getElementById('staffWeekOf');
    if (el) {
        const today = new Date();
        const dow   = today.getDay(); // 0=Sun
        const monday = new Date(today);
        monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
        el.value = monday.toISOString().split('T')[0];
    }
}

function _buildWeekDates(weekOf) {
    const start = new Date(weekOf + 'T00:00:00');
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue;
        const str = d.toISOString().split('T')[0];
        if (!allClosureDates.has(str)) dates.push(str);
    }
    return dates;
}

function _buildEnrollmentCounts(weekDates) {
    const counts = {};
    weekDates.forEach(d => {
        counts[d] = {};
        ROOMS.forEach(r => { counts[d][r.id] = 0; });
    });
    allRegistrations.forEach(reg => {
        (reg.registration_dates || []).forEach(d => {
            if (!d.waitlisted && weekDates.includes(d.care_date)) {
                counts[d.care_date][reg.room_id] = (counts[d.care_date][reg.room_id] || 0) + 1;
            }
        });
    });
    return counts;
}

function _buildShiftCounts(weekDates) {
    const counts = {};
    weekDates.forEach(d => {
        counts[d] = {};
        ROOMS.forEach(r => { counts[d][r.id] = { total: 0, halfDay: 0, fullDay: 0 }; });
    });
    allRegistrations.forEach(reg => {
        (reg.registration_dates || []).forEach(d => {
            if (!d.waitlisted && weekDates.includes(d.care_date)) {
                const c = counts[d.care_date][reg.room_id];
                if (!c) return;
                c.total++;
                if (d.day_type === 'half') c.halfDay++; else c.fullDay++;
            }
        });
    });
    return counts;
}

function generateStaffSchedule() {
    const weekOf = document.getElementById('staffWeekOf')?.value;
    if (!weekOf) { alert('Please select a week.'); return; }

    const weekDates = _buildWeekDates(weekOf);
    if (!weekDates.length) {
        document.getElementById('staffContent').innerHTML =
            '<p class="empty-hint">No school days in this week (all days are weekends or closures).</p>';
        return;
    }
    const counts = _buildShiftCounts(weekDates);
    renderStaffSchedule(weekDates, counts);
}

function renderStaffSchedule(weekDates, counts) {
    const container  = document.getElementById('staffContent');
    const dayNames   = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    // Each room gets 4 columns: AM Kids, AM Staff, PM Kids, PM Staff
    const roomHeaders = ROOMS.map(r =>
        `<th colspan="4" class="staff-room-header">${r.label}</th>`).join('');
    const shiftHeaders = ROOMS.map(() =>
        `<th colspan="2" class="staff-shift-head staff-shift-am">AM 8:15–1:15</th>` +
        `<th colspan="2" class="staff-shift-head staff-shift-pm">PM 1:00–5:00</th>`).join('');
    const subHeaders = ROOMS.map(() =>
        `<th class="staff-sub-head">Kids</th><th class="staff-sub-head">Staff</th>` +
        `<th class="staff-sub-head">Kids</th><th class="staff-sub-head">Staff</th>`).join('');

    const dataRows = weekDates.map(d => {
        const dt    = new Date(d + 'T00:00:00');
        const label = `${dayNames[dt.getDay()]} ${friendlyShort(d)}`;
        const cells = ROOMS.map(room => {
            const c       = counts[d][room.id] || { total: 0, halfDay: 0, fullDay: 0 };
            const ratio   = room.staffRatio || 10;
            // AM shift: all kids present (half-day + full-day)
            const amKids  = c.total;
            const amStaff = amKids > 0 ? Math.ceil(amKids / ratio) : 0;
            // PM shift: full-day kids only
            const pmKids  = c.fullDay;
            const pmStaff = pmKids > 0 ? Math.ceil(pmKids / ratio) : 0;
            const amCls   = amStaff >= 3 ? 'staff-high' : amStaff === 2 ? 'staff-mid' : '';
            const pmCls   = pmStaff >= 3 ? 'staff-high' : pmStaff === 2 ? 'staff-mid' : '';
            return `<td class="report-num shift-am">${amKids || '—'}</td>` +
                   `<td class="report-num shift-am ${amCls}">${amStaff > 0 ? amStaff : '—'}</td>` +
                   `<td class="report-num shift-pm">${pmKids || '—'}</td>` +
                   `<td class="report-num shift-pm ${pmCls}">${pmStaff > 0 ? pmStaff : '—'}</td>`;
        }).join('');
        return `<tr><td class="staff-date-cell">${label}</td>${cells}</tr>`;
    }).join('');

    const totalCells = ROOMS.map(room => {
        const ratio   = room.staffRatio || 10;
        const avgAm   = weekDates.length
            ? (weekDates.reduce((s, d) => s + ((counts[d][room.id] || {}).total || 0), 0) / weekDates.length).toFixed(1)
            : 0;
        const avgPm   = weekDates.length
            ? (weekDates.reduce((s, d) => s + ((counts[d][room.id] || {}).fullDay || 0), 0) / weekDates.length).toFixed(1)
            : 0;
        return `<td class="report-num shift-am"><em>avg ${avgAm}</em></td>` +
               `<td class="report-num shift-am"><em>1:${ratio}</em></td>` +
               `<td class="report-num shift-pm"><em>avg ${avgPm}</em></td>` +
               `<td class="report-num shift-pm"><em>1:${ratio}</em></td>`;
    }).join('');

    container.innerHTML = `
        <div class="staff-legend">
            <span class="staff-legend-dot staff-high">●</span> 3+ staff &nbsp;
            <span class="staff-legend-dot staff-mid">●</span> 2 staff &nbsp;
            <span class="staff-legend-dot">●</span> 0–1 staff &nbsp;
            <span class="shift-am-chip">AM</span> 8:15am–1:15pm (all kids) &nbsp;
            <span class="shift-pm-chip">PM</span> 1:00pm–5:00pm (full-day only)
            <span class="staff-ratio-note">Ratios: ⚙️ Settings → Staff-to-Child Ratios</span>
        </div>
        <div class="table-wrapper staff-table-wrap">
            <table class="report-table staff-table">
                <thead>
                    <tr>
                        <th rowspan="3" class="staff-date-header">Date</th>
                        ${roomHeaders}
                    </tr>
                    <tr>${shiftHeaders}</tr>
                    <tr>${subHeaders}</tr>
                </thead>
                <tbody>${dataRows}</tbody>
                <tfoot>
                    <tr class="report-total-row">
                        <td><strong>Week Avg</strong></td>
                        ${totalCells}
                    </tr>
                </tfoot>
            </table>
        </div>`;
}

function exportStaffSchedule() {
    const weekOf = document.getElementById('staffWeekOf')?.value;
    if (!weekOf) { alert('Please select a week first.'); return; }

    const weekDates = _buildWeekDates(weekOf);
    if (!weekDates.length) { alert('No school days in this week.'); return; }

    const counts = _buildShiftCounts(weekDates);
    const rows   = weekDates.map(d => {
        const row = { Date: friendlyShort(d) };
        ROOMS.forEach(room => {
            const c     = counts[d][room.id] || { total: 0, halfDay: 0, fullDay: 0 };
            const ratio = room.staffRatio || 10;
            row[`${room.label} – AM Kids`]   = c.total;
            row[`${room.label} – AM Staff`]  = c.total > 0 ? Math.ceil(c.total / ratio) : 0;
            row[`${room.label} – PM Kids`]   = c.fullDay;
            row[`${room.label} – PM Staff`]  = c.fullDay > 0 ? Math.ceil(c.fullDay / ratio) : 0;
        });
        return row;
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Staff Schedule');
    ws['!cols'] = Object.keys(rows[0]).map(k => ({
        wch: Math.max(k.length, ...rows.map(r => String(r[k] || '').length))
    }));
    XLSX.writeFile(wb, `staff-schedule-${weekOf}.xlsx`);
}

// ============================================================
// AUTO-FILL STAFF SCHEDULE
// ============================================================
// AM shift ≈ 5 hrs (8:15–1:15), PM shift ≈ 4 hrs (1:00–5:00)
const SHIFT_HRS = { am: 5, pm: 4 };
const DAY_ABBR  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

// Module-level storage for current auto-fill assignments (enables manual editing)
let _autoFillAssignments = null;
let _autoFillWeekDates   = null;
let _autoFillCounts      = null;

async function autoFillStaffSchedule() {
    const weekOf = document.getElementById('staffWeekOf')?.value;
    if (!weekOf) { alert('Please select a week first.'); return; }

    const btn = document.getElementById('autoFillStaffBtn');
    btn.disabled = true; btn.textContent = 'Filling…';
    try {
        // Ensure staff + availability are loaded
        if (!allStaffData.length) await loadStaffList();
        else staffAvailability = await fetchStaffAvailability();

        const weekDates = _buildWeekDates(weekOf);
        if (!weekDates.length) {
            document.getElementById('staffContent').innerHTML =
                '<p class="empty-hint">No school days in this week (all days are weekends or closures).</p>';
            return;
        }

        const counts = _buildShiftCounts(weekDates);
        // Exclude administrators from auto-assignment
        const active = allStaffData.filter(s => s.active && !/^admin(istrator)?$/i.test((s.role || '').trim()));

        // Track weekly hours and days used per staff
        const weeklyHours = new Map(active.map(s => [s.id, 0]));
        const weeklyDays  = new Map(active.map(s => [s.id, 0]));

        // Build assignment map: { date: { roomId: { am: [names], pm: [names] } } }
        const assignments = {};
        weekDates.forEach(d => {
            assignments[d] = {};
            ROOMS.forEach(r => { assignments[d][r.id] = { am: [], pm: [] }; });
        });

        weekDates.forEach(d => {
            const dayName = DAY_ABBR[new Date(d + 'T00:00:00').getDay()];

            ROOMS.forEach(room => {
                const c       = counts[d][room.id] || { total: 0, fullDay: 0 };
                const ratio   = room.staffRatio || 10;
                const amNeed  = c.total  > 0 ? Math.ceil(c.total  / ratio) : 0;
                const pmNeed  = c.fullDay > 0 ? Math.ceil(c.fullDay / ratio) : 0;

                // Candidates: active staff available today and assigned to this room (or float)
                // Also respect AM/PM period availability if set
                const candidates = active.filter(s => {
                    const avail   = staffAvailability[s.id];
                    const days    = avail?.days    ?? ['Mon','Tue','Wed','Thu','Fri'];
                    return days.includes(dayName) &&
                        (s.room_id === room.id || !s.room_id); // room match or float
                });

                // Sort by hours used ascending so we spread load evenly
                candidates.sort((a, b) => (weeklyHours.get(a.id) || 0) - (weeklyHours.get(b.id) || 0));

                // Assign AM — respect AM period availability
                const amCandidates = candidates.filter(s => {
                    const periods = staffAvailability[s.id]?.periods;
                    return !periods || periods.includes('am');
                });
                let amFilled = 0;
                for (const s of amCandidates) {
                    if (amFilled >= amNeed) break;
                    const maxHrs  = staffAvailability[s.id]?.maxHours ?? 40;
                    const maxDays = staffAvailability[s.id]?.maxDays  ?? 5;
                    const used    = weeklyHours.get(s.id) || 0;
                    const daysUsed = weeklyDays.get(s.id) || 0;
                    if (used + SHIFT_HRS.am > maxHrs) continue;
                    if (daysUsed >= maxDays) continue;
                    assignments[d][room.id].am.push(s.name);
                    weeklyHours.set(s.id, used + SHIFT_HRS.am);
                    weeklyDays.set(s.id, daysUsed + 1);
                    amFilled++;
                }

                // Assign PM (prefer staff already on AM shift first, then others)
                // Respect PM period availability
                const pmAvail = candidates.filter(s => {
                    const periods = staffAvailability[s.id]?.periods;
                    return !periods || periods.includes('pm');
                });
                const pmCandidates = [
                    ...pmAvail.filter(s => assignments[d][room.id].am.includes(s.name)),
                    ...pmAvail.filter(s => !assignments[d][room.id].am.includes(s.name)),
                ];
                let pmFilled = 0;
                for (const s of pmCandidates) {
                    if (pmFilled >= pmNeed) break;
                    if (assignments[d][room.id].pm.includes(s.name)) continue;
                    const maxHrs   = staffAvailability[s.id]?.maxHours ?? 40;
                    const maxDays  = staffAvailability[s.id]?.maxDays  ?? 5;
                    const used     = weeklyHours.get(s.id) || 0;
                    const daysUsed = weeklyDays.get(s.id) || 0;
                    // AM staff already had their hours and day counted; PM-only is additional
                    const alreadyOnAm = assignments[d][room.id].am.includes(s.name);
                    const addHrs  = alreadyOnAm ? 0 : SHIFT_HRS.pm;
                    const addDays = alreadyOnAm ? 0 : 1;
                    if (used + addHrs > maxHrs) continue;
                    if (!alreadyOnAm && daysUsed >= maxDays) continue;
                    assignments[d][room.id].pm.push(s.name);
                    if (!alreadyOnAm) {
                        weeklyHours.set(s.id, used + SHIFT_HRS.pm);
                        weeklyDays.set(s.id, daysUsed + addDays);
                    }
                    pmFilled++;
                }
            });
        });

        _autoFillAssignments = assignments;
        _autoFillWeekDates   = weekDates;
        _autoFillCounts      = counts;
        renderAutoFillSchedule(weekDates, assignments, counts);
    } catch (err) {
        alert('Auto-fill failed: ' + err.message);
    } finally {
        btn.disabled = false; btn.textContent = '🪄 Auto-Fill Names';
    }
}

function renderAutoFillSchedule(weekDates, assignments, counts) {
    const container = document.getElementById('staffContent');

    const roomHeaders = ROOMS.map(r => `<th colspan="2" class="staff-room-header">${r.label}</th>`).join('');
    const subHeaders  = ROOMS.map(() =>
        `<th class="staff-sub-head shift-am-th">AM Staff</th><th class="staff-sub-head shift-pm-th">PM Staff</th>`
    ).join('');

    const rows = weekDates.map(d => {
        const dt    = new Date(d + 'T00:00:00');
        const label = `${DAY_ABBR[dt.getDay()]} ${friendlyShort(d)}`;
        const cells = ROOMS.map(room => {
            const slot   = assignments[d][room.id];
            const c      = counts[d][room.id] || { total: 0, fullDay: 0 };
            const ratio  = room.staffRatio || 10;
            const amNeed = c.total  > 0 ? Math.ceil(c.total  / ratio) : 0;
            const pmNeed = c.fullDay > 0 ? Math.ceil(c.fullDay / ratio) : 0;

            const amChips = slot.am.map(n =>
                `<span class="staff-name-chip">${escHtml(n)}<button class="chip-remove" data-date="${d}" data-room="${room.id}" data-shift="am" data-name="${escHtml(n)}" title="Remove">×</button></span>`
            ).join(' ');
            const pmChips = slot.pm.map(n =>
                `<span class="staff-name-chip">${escHtml(n)}<button class="chip-remove" data-date="${d}" data-room="${room.id}" data-shift="pm" data-name="${escHtml(n)}" title="Remove">×</button></span>`
            ).join(' ');

            const amContent = slot.am.length
                ? amChips
                : (amNeed > 0 ? `<span class="staff-unfilled">⚠ ${amNeed} needed</span>` : '—');
            const pmContent = slot.pm.length
                ? pmChips
                : (pmNeed > 0 ? `<span class="staff-unfilled">⚠ ${pmNeed} needed</span>` : '—');

            return `<td class="autofill-cell">${amContent}<button class="chip-add-staff" data-date="${d}" data-room="${room.id}" data-shift="am" title="Add staff to AM slot">+</button></td>` +
                   `<td class="autofill-cell">${pmContent}<button class="chip-add-staff" data-date="${d}" data-room="${room.id}" data-shift="pm" title="Add staff to PM slot">+</button></td>`;
        }).join('');
        return `<tr><td class="staff-date-cell"><strong>${label}</strong></td>${cells}</tr>`;
    }).join('');

    const fillHtml = `
        <div style="display:flex;align-items:center;gap:10px;margin:24px 0 8px;">
            <h4 style="margin:0;color:#333">Staff Name Assignment</h4>
            <button id="printStaffAssignBtn" class="btn-secondary" style="margin-left:auto;">🖨 Print</button>
            <button id="exportStaffAssignBtn" class="btn-secondary">⬇ Export XLSX</button>
        </div>
        <p style="font-size:.85em;color:#888;margin-bottom:10px">
            Based on room assignment, availability days, and max hrs/week. Click <strong>+</strong> to manually add staff to a slot. Click <strong>×</strong> to remove.
        </p>
        <div class="table-wrapper staff-table-wrap" id="autoFillTableWrap">
            <table class="report-table autofill-table" id="autoFillTable">
                <thead>
                    <tr>
                        <th rowspan="2" class="staff-date-header">Date</th>
                        ${roomHeaders}
                    </tr>
                    <tr>${subHeaders}</tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;

    // Replace the existing section in-place, or append it — prevents stacking duplicate copies
    const existing = document.getElementById('autoFillSection');
    if (existing) {
        existing.innerHTML = fillHtml;
    } else {
        const section = document.createElement('div');
        section.id = 'autoFillSection';
        section.innerHTML = fillHtml;
        container.appendChild(section);
    }

    const section = document.getElementById('autoFillSection');

    // Wire up print
    section.querySelector('#printStaffAssignBtn')?.addEventListener('click', () => {
        const weekOf = document.getElementById('staffWeekOf')?.value || '';
        const tbl = document.getElementById('autoFillTable');
        if (!tbl) return;
        const cleanHtml = tbl.outerHTML
            .replace(/<button class="chip-remove"[^>]*>×<\/button>/g, '')
            .replace(/<button class="chip-add-staff"[^>]*>\+<\/button>/g, '');
        const win = window.open('', '_blank');
        win.document.write(`<!DOCTYPE html><html><head><title>Staff Schedule – ${weekOf}</title>
            <style>body{font-family:Arial,sans-serif;font-size:12px}table{border-collapse:collapse;width:100%}
            th,td{border:1px solid #ccc;padding:6px 8px;text-align:left}
            th{background:#f0f0f0}.staff-name-chip{display:inline-block;background:#e0e7ff;padding:2px 6px;border-radius:4px;margin:2px}
            .staff-unfilled{color:#c00}</style></head><body>
            <h2>Staff Name Assignment – Week of ${weekOf}</h2>${cleanHtml}</body></html>`);
        win.document.close();
        win.print();
    });

    // Wire up XLSX export
    section.querySelector('#exportStaffAssignBtn')?.addEventListener('click', () => {
        const weekOf = document.getElementById('staffWeekOf')?.value || 'schedule';
        if (!_autoFillAssignments || !_autoFillWeekDates) return;
        const headers = ['Date', ...ROOMS.flatMap(r => [`${r.label} AM`, `${r.label} PM`])];
        const dataRows = _autoFillWeekDates.map(d => {
            const dt    = new Date(d + 'T00:00:00');
            const label = `${DAY_ABBR[dt.getDay()]} ${friendlyShort(d)}`;
            return [label, ...ROOMS.flatMap(r => [
                (_autoFillAssignments[d][r.id].am || []).join(', ') || '—',
                (_autoFillAssignments[d][r.id].pm || []).join(', ') || '—',
            ])];
        });
        const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
        ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length, 16) }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Staff Assignment');
        XLSX.writeFile(wb, `staff-assignment-${weekOf}.xlsx`);
    });

    // Event delegation for + and × — one listener on the section, no re-attachment on re-render
    section.addEventListener('click', e => {
        const addBtn = e.target.closest('.chip-add-staff');
        if (addBtn) {
            e.stopPropagation();
            _showStaffPicker(addBtn, addBtn.dataset.date, addBtn.dataset.room, addBtn.dataset.shift);
            return;
        }
        const removeBtn = e.target.closest('.chip-remove');
        if (removeBtn) {
            const { date, room, shift, name } = removeBtn.dataset;
            const arr = _autoFillAssignments[date][room][shift];
            const idx = arr.indexOf(name);
            if (idx !== -1) arr.splice(idx, 1);
            renderAutoFillSchedule(_autoFillWeekDates, _autoFillAssignments, _autoFillCounts);
        }
    });
}

function _showStaffPicker(anchorBtn, date, room, shift) {
    document.getElementById('_staffPickerPopup')?.remove();

    const already = _autoFillAssignments[date][room][shift] || [];
    const staff   = allStaffData.filter(s => s.active);
    if (!staff.length) { alert('No active staff found.'); return; }

    const popup = document.createElement('div');
    popup.id = '_staffPickerPopup';
    popup.className = 'staff-picker-popup';
    popup.innerHTML = staff.map(s => {
        const assigned = already.includes(s.name);
        return `<button class="staff-picker-item${assigned ? ' staff-picker-assigned' : ''}" data-name="${escHtml(s.name)}">${escHtml(s.name)}${assigned ? ' ✓' : ''}</button>`;
    }).join('');

    const rect = anchorBtn.getBoundingClientRect();
    popup.style.top  = (rect.bottom + window.scrollY + 4) + 'px';
    popup.style.left = (rect.left  + window.scrollX) + 'px';
    document.body.appendChild(popup);

    popup.addEventListener('click', e => {
        const item = e.target.closest('.staff-picker-item');
        if (!item || item.classList.contains('staff-picker-assigned')) return;
        const name = item.dataset.name;
        if (!_autoFillAssignments[date][room][shift].includes(name)) {
            _autoFillAssignments[date][room][shift].push(name);
        }
        popup.remove();
        renderAutoFillSchedule(_autoFillWeekDates, _autoFillAssignments, _autoFillCounts);
    });

    // Close when clicking outside
    setTimeout(() => {
        document.addEventListener('click', function close(e) {
            if (!popup.contains(e.target)) {
                popup.remove();
                document.removeEventListener('click', close);
            }
        });
    }, 0);
}

// ============================================================
// STAFF RATIOS SETTINGS
// ============================================================
function setupRatios() {
    renderRatiosTable();
    document.getElementById('saveRatiosBtn')?.addEventListener('click', onSaveRatios);
}

function renderRatiosTable() {
    const wrap = document.getElementById('ratiosTableWrap');
    if (!wrap) return;
    wrap.innerHTML = `
        <table class="rates-table">
            <thead>
                <tr>
                    <th>Room</th>
                    <th>Age Group</th>
                    <th>Max Children per Staff</th>
                </tr>
            </thead>
            <tbody>
                ${ROOMS.map(room => `
                    <tr data-room-id="${room.id}">
                        <td class="rates-room-label">
                            <strong>${escHtml(room.label)}</strong>
                        </td>
                        <td class="rates-ages">${escHtml(room.ages)}</td>
                        <td>
                            <input type="number" class="ratio-input rate-input"
                                value="${room.staffRatio ?? ''}" min="1" step="1" placeholder="e.g. 4"
                                style="width:80px;">
                        </td>
                    </tr>`).join('')}
            </tbody>
        </table>
        <p class="rates-hint">💡 Enter the maximum number of children one staff member may supervise. Typical state minimums: infants 4, young toddlers 5, 2-year-olds 8, 3-year-olds 10.</p>`;
}

async function onSaveRatios() {
    const btn      = document.getElementById('saveRatiosBtn');
    const statusEl = document.getElementById('ratiosStatus');
    if (!btn) return;
    btn.disabled    = true;
    btn.textContent = 'Saving…';
    if (statusEl) statusEl.textContent = '';

    try {
        const ratios = {};
        document.querySelectorAll('#ratiosTableWrap tbody tr[data-room-id]').forEach(row => {
            const id  = row.dataset.roomId;
            const val = row.querySelector('.ratio-input')?.value.trim();
            ratios[id] = val === '' ? null : parseInt(val, 10);
        });

        await saveRatioSettings(ratios);
        // Merge directly into ROOMS to avoid a silent DB round-trip failure.
        ROOMS.forEach(room => {
            if (ratios[room.id] != null) room.staffRatio = ratios[room.id];
        });
        renderRatiosTable();

        if (statusEl) {
            statusEl.textContent = '✓ Saved!';
            statusEl.style.color = '#2e7d32';
            setTimeout(() => { statusEl.textContent = ''; }, 3000);
        }
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = '⚠️ ' + err.message;
            statusEl.style.color = '#c62828';
        }
        console.error('onSaveRatios:', err);
    } finally {
        btn.disabled    = false;
        btn.textContent = '💾 Save Ratios';
    }
}

// ============================================================
// OFFER EMAIL LINKS (global settings)
// ============================================================
function setupOfferLinks() {
    const g = window._globalOfferLinks || {};
    const procareEl   = document.getElementById('globalProcareLink');
    const paperworkEl = document.getElementById('globalPaperworkLinks');
    if (procareEl)   procareEl.value   = g.procareLink   || '';
    if (paperworkEl) paperworkEl.value = (g.paperworkLinks || []).join(', ');

    document.getElementById('saveOfferLinksBtn')?.addEventListener('click', async () => {
        const btn      = document.getElementById('saveOfferLinksBtn');
        const statusEl = document.getElementById('offerLinksStatus');
        btn.disabled    = true;
        btn.textContent = 'Saving…';
        if (statusEl) statusEl.textContent = '';
        try {
            const procareLink   = procareEl?.value.trim() || null;
            const paperworkLinks = (paperworkEl?.value || '').split(',').map(s => s.trim()).filter(Boolean);
            const payload = { procareLink, paperworkLinks };
            await saveOfferLinks(payload);
            window._globalOfferLinks = payload;
            if (statusEl) {
                statusEl.textContent = '✓ Saved!';
                statusEl.style.color = '#2e7d32';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }
        } catch (err) {
            if (statusEl) { statusEl.textContent = '⚠️ ' + err.message; statusEl.style.color = '#c62828'; }
            console.error('saveOfferLinks:', err);
        } finally {
            btn.disabled    = false;
            btn.textContent = '💾 Save Links';
        }
    });
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
        allClosureDates = new Set(closures.map(c => c.close_date));
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
    ['searchInput', 'roomFilter', 'careMonthFilter'].forEach(id => {
        document.getElementById(id)?.addEventListener('input', applyFilters);
    });

    // Sortable column headers
    document.querySelectorAll('#regTable thead th[data-col]').forEach(th => {
        th.style.cursor = 'pointer';
        th.title = 'Click to sort';
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (tableSortState.col === col) {
                tableSortState.dir = tableSortState.dir === 'asc' ? 'desc' : 'asc';
            } else {
                tableSortState = { col, dir: 'asc' };
            }
            applyFilters();
        });
    });
}

function sortRegistrations(data) {
    const { col, dir } = tableSortState;
    const mult = dir === 'asc' ? 1 : -1;
    return [...data].sort((a, b) => {
        let va, vb;
        switch (col) {
            case 'submitted':
                va = a.created_at || ''; vb = b.created_at || '';
                return mult * va.localeCompare(vb);
            case 'parent':
                va = (a.parent_name || '').toLowerCase(); vb = (b.parent_name || '').toLowerCase();
                return mult * va.localeCompare(vb);
            case 'email':
                va = (a.parent_email || '').toLowerCase(); vb = (b.parent_email || '').toLowerCase();
                return mult * va.localeCompare(vb);
            case 'child':
                va = (a.child_name || '').toLowerCase(); vb = (b.child_name || '').toLowerCase();
                return mult * va.localeCompare(vb);
            case 'room':
                va = a.room_id || ''; vb = b.room_id || '';
                return mult * va.localeCompare(vb);
            case 'tally': {
                const tally = reg => (reg.registration_dates || []).filter(d => !d.waitlisted).length;
                return mult * (tally(a) - tally(b));
            }
            case 'bill':
                return mult * (calcRegistrationBill(a) - calcRegistrationBill(b));
            default:
                return 0;
        }
    });
}

function applyFilters() {
    const search    = document.getElementById('searchInput').value.toLowerCase();
    const room      = document.getElementById('roomFilter').value;
    const careMonth = document.getElementById('careMonthFilter').value; // 'YYYY-MM' or ''

    let filtered = allRegistrations.filter(reg => {
        const matchSearch = !search ||
            (reg.parent_name  || '').toLowerCase().includes(search) ||
            (reg.parent_email || '').toLowerCase().includes(search) ||
            (reg.child_name   || '').toLowerCase().includes(search);
        const matchRoom      = !room      || reg.room_id === room;
        const matchCareMonth = !careMonth || (reg.registration_dates || []).some(d =>
            d.care_date && d.care_date.startsWith(careMonth));
        return matchSearch && matchRoom && matchCareMonth;
    });

    // When a specific care month is selected also sort by earliest care date in that month
    // (overrides column sort for that scenario for clarity)
    if (careMonth && tableSortState.col === 'submitted') {
        filtered = filtered.slice().sort((a, b) => {
            const earliest = regs => (regs || [])
                .filter(d => d.care_date?.startsWith(careMonth))
                .map(d => d.care_date).sort()[0] || '';
            return earliest(a.registration_dates).localeCompare(earliest(b.registration_dates));
        });
    } else {
        filtered = sortRegistrations(filtered);
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
let importRows        = [];
let allFamiliesData   = [];
let editingFamilyId   = null;   // null = adding new, string = editing existing
let familyModalChildren = [];   // working copy of children in the modal
let showArchivedFamilies = false;

function setupFamilies() {
    const fileInput  = document.getElementById('familiesFileInput');
    const importBtn  = document.getElementById('importFamiliesBtn');
    const refreshBtn = document.getElementById('refreshFamiliesBtn');

    fileInput?.addEventListener('change', onFamiliesFileChange);
    importBtn?.addEventListener('click', onImportFamilies);
    refreshBtn?.addEventListener('click', loadFamilies);
    document.getElementById('familyChildSearch')?.addEventListener('input', onFamilySearch);
    document.getElementById('familySortBy')?.addEventListener('change', e => {
        familiesSortBy = e.target.value;
        onFamilySearch(); // re-render with new sort
    });

    // New family management buttons
    document.getElementById('addFamilyBtn')?.addEventListener('click', () => openFamilyModal());
    document.getElementById('archiveSummerBtn')?.addEventListener('click', onArchiveSummerFamilies);
    document.getElementById('familiesToggleArchivedBtn')?.addEventListener('click', () => {
        showArchivedFamilies = !showArchivedFamilies;
        const btn = document.getElementById('familiesToggleArchivedBtn');
        btn.textContent = showArchivedFamilies ? 'Hide Archived' : 'Show Archived';
        btn.classList.toggle('btn-active', showArchivedFamilies);
        loadFamilies();
    });

    // Family modal buttons
    document.getElementById('fmCloseBtn')?.addEventListener('click', closeFamilyModal);
    document.getElementById('fmCancelBtn')?.addEventListener('click', closeFamilyModal);
    document.getElementById('fmSaveBtn')?.addEventListener('click', saveFamilyModal);
    document.getElementById('fmAddChildBtn')?.addEventListener('click', addModalChildRow);
    document.getElementById('fmNewPinBtn')?.addEventListener('click', () => {
        document.getElementById('fmPin').value = generateLocalPin();
    });
    document.getElementById('fmNewPin2Btn')?.addEventListener('click', () => {
        document.getElementById('fmParent2Pin').value = generateLocalPin();
    });
    document.getElementById('familyModal')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) closeFamilyModal();
    });

    // Merge modal
    document.getElementById('mergeCancelBtn')?.addEventListener('click', closeMergeModal);
    document.getElementById('mergeConfirmBtn')?.addEventListener('click', doMergeFamilies);
    document.getElementById('mergeModal')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) closeMergeModal();
    });

    // Document-level delegation for Edit / Archive / Restore / Delete / Merge buttons in family rows
    document.addEventListener('click', e => {
        const editBtn = e.target.closest('.fm-edit-btn[data-family-id]');
        if (editBtn) {
            const fam = allFamiliesData.find(f => f.id === editBtn.dataset.familyId);
            if (fam) openFamilyModal(fam);
            return;
        }
        const archiveBtn = e.target.closest('.fm-archive-btn[data-family-id]');
        if (archiveBtn) {
            confirmArchiveFamily(archiveBtn.dataset.familyId, archiveBtn.dataset.familyName);
            return;
        }
        const restoreBtn = e.target.closest('.fm-restore-btn[data-family-id]');
        if (restoreBtn) { doRestoreFamily(restoreBtn.dataset.familyId); return; }

        const deleteBtn = e.target.closest('.fm-delete-btn[data-family-id]');
        if (deleteBtn) {
            confirmDeleteFamily(deleteBtn.dataset.familyId, deleteBtn.dataset.familyName);
            return;
        }

        const mergeBtn = e.target.closest('.fm-merge-btn[data-family-id]');
        if (mergeBtn) {
            openMergeModal(mergeBtn.dataset.familyId, mergeBtn.dataset.familyName);
            return;
        }

        const lockBtn = e.target.closest('.fm-lock-btn[data-family-id]');
        if (lockBtn) {
            doSetFamilyLock(lockBtn.dataset.familyId, true);
            return;
        }
        const unlockBtn = e.target.closest('.fm-unlock-btn[data-family-id]');
        if (unlockBtn) {
            doSetFamilyLock(unlockBtn.dataset.familyId, false);
            return;
        }
        const loginUnlockBtn = e.target.closest('.fm-login-unlock-btn[data-family-id]');
        if (loginUnlockBtn) {
            doSetFamilyLoginLock(loginUnlockBtn.dataset.familyId, false);
            return;
        }
    });

    // Escape closes family modal (visibility-safe)
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            const fm = document.getElementById('familyModal');
            if (fm && !fm.classList.contains('hidden')) closeFamilyModal();
        }
    });
}

function onFamilySearch() {
    const q = (document.getElementById('familyChildSearch')?.value || '').toLowerCase().trim();
    familiesPage = 0;
    if (!q) {
        renderFamiliesList(allFamiliesData);
        return;
    }
    const filtered = allFamiliesData.filter(f =>
        (f.students || []).some(s => s.child_name && s.child_name.toLowerCase().includes(q)) ||
        (f.parent_name  && f.parent_name.toLowerCase().includes(q)) ||
        (f.parent2_name && f.parent2_name.toLowerCase().includes(q))
    );
    renderFamiliesList(filtered);
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
                const rows = XLSX.utils.sheet_to_json(ws, { raw: false, defval: '', range: 2 });
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
        const childName  = [childFirst, childLast].filter(Boolean).join(' ').trim();
        const childDob   = normalizeDobStr(get('Birthdate'));

        const p1Name  = get('Parent1 Name');
        const p1Email = get('Parent1 Email');
        const p1Phone = get('Parent1 Phone');
        const p1Pin   = get('Parent1 Sign-In Code');

        const p2Name  = get('Parent2 Name');
        const p2Email = get('Parent2 Email');
        const p2Phone = get('Parent2 Phone');
        const p2Pin   = get('Parent2 Sign-In Code');

        // Primary parent must have an email for lookup; swap if Parent1 has none
        let parentName, parentEmail, parentPhone, parentPin;
        let parent2Name, parent2Email, parent2Phone, parent2Pin;

        if (p1Email || !p2Email) {
            parentName = p1Name;  parentEmail = p1Email;  parentPhone = p1Phone;  parentPin = p1Pin;
            parent2Name = p2Name; parent2Email = p2Email; parent2Phone = p2Phone; parent2Pin = p2Pin;
        } else {
            parentName = p2Name;  parentEmail = p2Email;  parentPhone = p2Phone;  parentPin = p2Pin;
            parent2Name = p1Name; parent2Email = p1Email; parent2Phone = p1Phone; parent2Pin = p1Pin;
        }

        return { parentName, parentEmail, parentPhone, parentPin,
                 parent2Name, parent2Email, parent2Phone, parent2Pin,
                 childName, childDob };
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
    // Excel serial date (e.g. 44289 → 2021-04-03)
    const num = Number(str);
    if (!isNaN(num) && num > 10000 && num < 60000) {
        const d = new Date(Math.round((num - 25569) * 86400000));
        return d.toISOString().split('T')[0];
    }
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
            <td>${escHtml(r.parentPin || '')}</td>
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
                        <th>PIN</th><th>Child Name</th><th>Child DOB</th>
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
    if (container) container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        allFamiliesData = await fetchAllFamilies({ includeArchived: showArchivedFamilies });
        _discountMap = null; // invalidate cached discount map
        const searchEl = document.getElementById('familyChildSearch');
        if (searchEl) searchEl.value = '';
        familiesPage = 0;
        renderFamiliesList(allFamiliesData);
    } catch (err) {
        if (container) container.innerHTML = `<p class="import-error">Failed to load families: ${escHtml(err.message)}</p>`;
    }
}

function sortFamilies(families) {
    const sorted = [...families];
    switch (familiesSortBy) {
        case 'room':
            sorted.sort((a, b) => {
                const roomA = ((a.students || [])[0]?.room_override || '') ;
                const roomB = ((b.students || [])[0]?.room_override || '') ;
                return roomA.localeCompare(roomB) || (a.parent_name || '').localeCompare(b.parent_name || '');
            });
            break;
        case 'discount':
            sorted.sort((a, b) => {
                const hasDisc = f => (f.students || []).some(s => s.discount_type && s.discount_type !== 'none');
                return (hasDisc(b) ? 1 : 0) - (hasDisc(a) ? 1 : 0)
                    || (a.parent_name || '').localeCompare(b.parent_name || '');
            });
            break;
        case 'age_asc': // youngest first = most recent DOB first
            sorted.sort((a, b) => {
                const newestDob = f => (f.students || [])
                    .map(s => s.child_dob || '').filter(Boolean).sort().reverse()[0] || '';
                return newestDob(b).localeCompare(newestDob(a));
            });
            break;
        case 'age_desc': // oldest first = earliest DOB first
            sorted.sort((a, b) => {
                const oldestDob = f => (f.students || [])
                    .map(s => s.child_dob || '').filter(Boolean).sort()[0] || '';
                return oldestDob(a).localeCompare(oldestDob(b));
            });
            break;
        case 'child_name':
            sorted.sort((a, b) => {
                const firstChild = f => (f.students || [])
                    .map(s => (s.child_name || '').toLowerCase())
                    .sort()[0] || '';
                return firstChild(a).localeCompare(firstChild(b))
                    || (a.parent_name || '').localeCompare(b.parent_name || '');
            });
            break;
        default: { // 'name' — sort by family last name (as shown in heading)
            const lname = n => (n || '').trim().split(/\s+/).pop()?.toLowerCase() || '';
            sorted.sort((a, b) =>
                lname(a.parent_name).localeCompare(lname(b.parent_name)) ||
                (a.parent_name || '').localeCompare(b.parent_name || ''));
            break;
        }
    }
    return sorted;
}

function renderFamiliesList(families) {
    const container = document.getElementById('familiesList');
    if (!families.length) {
        container.innerHTML = showArchivedFamilies
            ? '<p class="empty-hint">No archived families.</p>'
            : '<p class="empty-hint">No families yet. Use + Add Family or import from Excel.</p>';
        return;
    }

    // Deduplicate by family ID in case the DB ever returns the same row twice
    const _seenIds = new Set();
    const unique   = families.filter(f => {
        if (_seenIds.has(f.id)) return false;
        _seenIds.add(f.id);
        return true;
    });

    const sorted      = sortFamilies(unique);
    const totalCount  = sorted.length;
    const totalPages  = Math.ceil(totalCount / FAMILIES_PAGE_SIZE);
    if (familiesPage >= totalPages) familiesPage = Math.max(0, totalPages - 1);
    const pageStart   = familiesPage * FAMILIES_PAGE_SIZE;
    const pageFamilies = sorted.slice(pageStart, pageStart + FAMILIES_PAGE_SIZE);
    const roomOptions = ROOMS.map(r =>
        `<option value="${r.id}">${r.label}</option>`
    ).join('');

    const parentRow = (name, email, phone, pin) => {
        if (!name && !email) return '';
        return `<div class="family-parent-row">
            <span class="family-row-name">${escHtml(name || '')}</span>
            <span class="family-pin-badge">${pin ? `PIN: ${pin}` : ''}</span>
            <span class="family-row-meta">${escHtml(email || '')}${email && phone ? ' &middot; ' : ''}${escHtml(phone || '')}</span>
            <span></span>
        </div>`;
    };

    const pageEnd = Math.min(pageStart + FAMILIES_PAGE_SIZE, totalCount);
    const paginationHtml = totalPages > 1 ? `
        <div class="families-pagination">
            <button class="btn-secondary families-prev-btn" ${familiesPage === 0 ? 'disabled' : ''}>&#8592; Prev</button>
            <span class="families-page-info">Page ${familiesPage + 1} of ${totalPages}</span>
            <button class="btn-secondary families-next-btn" ${familiesPage >= totalPages - 1 ? 'disabled' : ''}>Next &#8594;</button>
        </div>` : '';

    container.innerHTML = `
        <p class="families-count">Showing ${pageStart + 1}–${pageEnd} of ${totalCount} famil${totalCount !== 1 ? 'ies' : 'y'}${showArchivedFamilies ? ' (including archived)' : ''}</p>
        ${paginationHtml}
        <ul class="families-list">
            ${pageFamilies.map(f => {
                const kids     = (f.students || []);
                const archived = f.active === false;
                const lastName = (f.parent_name || '').trim().split(/\s+/).pop() || '';
                return `
                    <li class="family-row${archived ? ' family-row-archived' : ''}">
                        <div class="family-heading">${escHtml(lastName)} Family</div>
                        <div class="family-row-top">
                            <div class="family-parent-row">
                                <span class="family-row-name">${escHtml(f.parent_name || '')}</span>
                                <span class="family-pin-badge">${f.pin ? `PIN: ${f.pin}` : ''}</span>
                                <span class="family-row-meta">${escHtml(f.parent_email || '')}${f.parent_email && f.parent_phone ? ' &middot; ' : ''}${escHtml(f.parent_phone || '')}</span>
                                <div class="family-row-actions">
                                    ${f.group === 'summer' ? '<span class="family-badge-summer">Summer</span>' : ''}
                                    ${archived ? '<span class="family-badge-archived">Archived</span>' : ''}
                                    ${f.registration_locked ? '<span class="family-badge-locked" title="Registration locked for nonpayment">🔒 Reg Locked</span>' : ''}
                                    ${f.login_locked ? `<span class="family-badge-login-locked" title="Login locked — too many failed attempts">🚫 Login Locked</span><button class="fm-login-unlock-btn btn-secondary" data-family-id="${f.id}" title="Unlock login access">🔓 Unlock Login</button>` : ''}
                                    ${!archived
                                        ? `<button class="fm-edit-btn" data-family-id="${f.id}" title="Edit family">✏ Edit</button>
                                           <button class="fm-archive-btn" data-family-id="${f.id}" data-family-name="${escHtml(f.parent_name || 'this family')}" title="Archive family">Archive</button>`
                                        : `<button class="fm-restore-btn" data-family-id="${f.id}" title="Restore family">↩ Restore</button>`
                                    }
                                    ${f.registration_locked
                                        ? `<button class="fm-unlock-btn btn-secondary" data-family-id="${f.id}" title="Unlock registration">🔓 Unlock Reg</button>`
                                        : `<button class="fm-lock-btn btn-warning" data-family-id="${f.id}" title="Lock registration for nonpayment">🔒 Lock Reg</button>`
                                    }
                                    <button class="fm-delete-btn" data-family-id="${f.id}" data-family-name="${escHtml(f.parent_name || 'this family')}" title="Permanently delete this family">🗑 Delete</button>
                                </div>
                            </div>
                            ${(f.parent2_name || f.parent2_email) ? parentRow(f.parent2_name, f.parent2_email, f.parent2_phone, f.parent2_pin) : ''}
                        </div>
                        ${kids.length ? `
                            <ul class="family-students">
                                ${kids.map(s => {
                                    const dobStr = s.child_dob
                                        ? new Date(s.child_dob + 'T00:00:00').toLocaleDateString('en-US',
                                            { month: 'short', day: 'numeric', year: 'numeric' })
                                        : '';
                                    const dt = s.discount_type || 'none';
                                    const dv = s.discount_value || 0;
                                    return `<li class="family-student-item" data-student-id="${s.id}">
                                        <span class="student-bullet">Child</span>
                                        <span class="student-name">${escHtml(s.child_name)}</span>
                                        <span class="student-dob">${dobStr}</span>
                                        <div class="room-override-wrap">
                                            <label class="room-override-label">Room:</label>
                                            <select class="room-override-select" data-student-id="${s.id}">
                                                <option value="">Auto (age-based)</option>
                                                ${roomOptions}
                                            </select>
                                        </div>
                                        <div class="discount-wrap">
                                            <label class="room-override-label">Discount:</label>
                                            <select class="discount-type-inline" data-student-id="${s.id}">
                                                <option value="none"   ${dt === 'none'   ? 'selected' : ''}>None</option>
                                                <option value="staff"  ${dt === 'staff'  ? 'selected' : ''}>Staff (free)</option>
                                                <option value="custom" ${dt === 'custom' ? 'selected' : ''}>Custom %</option>
                                            </select>
                                            <input type="number" class="discount-value-inline"
                                                   data-student-id="${s.id}"
                                                   value="${dv}" min="0" max="100" step="1"
                                                   placeholder="%" style="width:52px;${dt !== 'custom' ? 'display:none' : ''}">
                                        </div>
                                    </li>`;
                                }).join('')}
                            </ul>` : ''}
                    </li>`;
            }).join('')}
        </ul>
        ${paginationHtml}`;

    // Pagination button events
    container.querySelector('.families-prev-btn')?.addEventListener('click', () => {
        if (familiesPage > 0) { familiesPage--; renderFamiliesList(families); }
    });
    container.querySelector('.families-next-btn')?.addEventListener('click', () => {
        if (familiesPage < totalPages - 1) { familiesPage++; renderFamiliesList(families); }
    });

    // Bind room override + discount change events
    pageFamilies.forEach(f => {
        (f.students || []).forEach(s => {
            // Room override
            const roomSel = container.querySelector(`.room-override-select[data-student-id="${s.id}"]`);
            if (roomSel) {
                roomSel.value = s.room_override || '';
                roomSel.addEventListener('change', async () => {
                    try {
                        await updateStudentRoomOverride(s.id, roomSel.value || null);
                        roomSel.style.borderColor = '#68d391';
                        setTimeout(() => { roomSel.style.borderColor = ''; }, 2000);
                    } catch (err) {
                        alert('Failed to update room: ' + err.message);
                        roomSel.value = s.room_override || '';
                    }
                });
            }

            // Inline discount
            const discSel = container.querySelector(`.discount-type-inline[data-student-id="${s.id}"]`);
            const discVal = container.querySelector(`.discount-value-inline[data-student-id="${s.id}"]`);
            if (discSel) {
                discSel.addEventListener('change', async () => {
                    if (discVal) discVal.style.display = discSel.value === 'custom' ? '' : 'none';
                    if (discSel.value !== 'custom') {
                        try {
                            await updateStudent(s.id, { discount_type: discSel.value, discount_value: null });
                            _discountMap = null;
                            discSel.style.borderColor = '#68d391';
                            setTimeout(() => { discSel.style.borderColor = ''; }, 2000);
                        } catch (err) {
                            alert('Failed to update discount: ' + err.message);
                        }
                    }
                });
            }
            if (discVal) {
                discVal.addEventListener('change', async () => {
                    const val = parseFloat(discVal.value) || 0;
                    try {
                        await updateStudent(s.id, { discount_type: 'custom', discount_value: val });
                        _discountMap = null;
                        discVal.style.borderColor = '#68d391';
                        setTimeout(() => { discVal.style.borderColor = ''; }, 2000);
                    } catch (err) {
                        alert('Failed to update discount: ' + err.message);
                    }
                });
            }
        });
    });
}

// ============================================================
// FAMILY MODAL — Add / Edit
// ============================================================
function generateLocalPin() {
    return Math.floor(1000 + Math.random() * 9000);
}

function openFamilyModal(family = null) {
    editingFamilyId = family ? family.id : null;

    // Set title
    document.getElementById('fmTitle').textContent = family ? 'Edit Family' : 'Add Family';

    if (family) {
        // Populate parent fields
        document.getElementById('fmParentName').value    = family.parent_name  || '';
        document.getElementById('fmParentEmail').value   = family.parent_email || '';
        document.getElementById('fmParentPhone').value   = family.parent_phone || '';
        document.getElementById('fmPin').value           = family.pin          || '';
        document.getElementById('fmParent2Name').value   = family.parent2_name  || '';
        document.getElementById('fmParent2Email').value  = family.parent2_email || '';
        document.getElementById('fmParent2Phone').value  = family.parent2_phone || '';
        document.getElementById('fmParent2Pin').value    = family.parent2_pin   || '';
        // Group radio
        const grp = family.group || 'regular';
        document.querySelectorAll('input[name="fmGroup"]').forEach(r => {
            r.checked = (r.value === grp);
        });
        // Children
        familyModalChildren = (family.students || []).map(s => ({ ...s }));
    } else {
        // Clear all fields
        ['fmParentName','fmParentEmail','fmParentPhone',
         'fmParent2Name','fmParent2Email','fmParent2Phone','fmParent2Pin'].forEach(id => {
            document.getElementById(id).value = '';
        });
        document.getElementById('fmPin').value = generateLocalPin();
        document.querySelectorAll('input[name="fmGroup"]').forEach(r => {
            r.checked = (r.value === 'regular');
        });
        familyModalChildren = [];
    }

    renderModalChildRows();

    const modal = document.getElementById('familyModal');
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    document.getElementById('fmParentName').focus();
}

function closeFamilyModal() {
    const modal = document.getElementById('familyModal');
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    editingFamilyId     = null;
    familyModalChildren = [];
}

function renderModalChildRows() {
    const container = document.getElementById('fmChildRows');
    if (!container) return;

    if (!familyModalChildren.length) {
        container.innerHTML = '<p class="fm-no-children">No children added yet. Click + Add Child below.</p>';
        return;
    }

    const roomOptions = ROOMS.map(r => `<option value="${r.id}">${r.label}</option>`).join('');

    container.innerHTML = familyModalChildren.map((child, i) => {
        const dt = child.discount_type || 'none';
        const dv = (child.discount_value != null) ? child.discount_value : 0;
        const selectedRoom = child.room_override || '';
        return `
            <div class="fm-child-row" data-index="${i}">
                <div class="fm-child-main">
                    <div class="fm-field fm-field-grow">
                        <label>Name *</label>
                        <input type="text" class="fmc-name" value="${escHtml(child.child_name || '')}" placeholder="Child's full name">
                    </div>
                    <div class="fm-field">
                        <label>Date of Birth</label>
                        <input type="date" class="fmc-dob" value="${child.child_dob || ''}">
                    </div>
                    <div class="fm-field">
                        <label>Room</label>
                        <select class="fmc-room">
                            <option value="" ${!selectedRoom ? 'selected' : ''}>Auto (age-based)</option>
                            ${ROOMS.map(r => `<option value="${r.id}" ${selectedRoom === r.id ? 'selected' : ''}>${r.label}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="fm-child-discount">
                    <div class="fm-field">
                        <label>Discount</label>
                        <select class="fmc-discount-type">
                            <option value="none"   ${dt === 'none'   ? 'selected' : ''}>None</option>
                            <option value="staff"  ${dt === 'staff'  ? 'selected' : ''}>Staff (100% free)</option>
                            <option value="custom" ${dt === 'custom' ? 'selected' : ''}>Custom %</option>
                        </select>
                    </div>
                    <div class="fm-field discount-value-wrap" ${dt !== 'custom' ? 'style="display:none"' : ''}>
                        <label>% Off</label>
                        <input type="number" class="fmc-discount-value" value="${dv}" min="0" max="100" step="1" style="width:70px">
                    </div>
                    <div class="fm-field fm-field-grow">
                        <label>Note</label>
                        <input type="text" class="fmc-discount-note" value="${escHtml(child.discount_note || '')}" placeholder="Optional note">
                    </div>
                </div>
                <div class="fm-child-recurring">
                    <label style="font-size:.82em;color:#555;font-weight:600;display:block;margin-bottom:4px">Recurring Days <span style="font-weight:400;color:#888">(pre-fill calendar each month)</span></label>
                    <div style="display:flex;gap:8px;flex-wrap:wrap">
                        ${['Mon','Tue','Wed','Thu','Fri'].map(day => {
                            const rd = Array.isArray(child.recurring_days) ? child.recurring_days : [];
                            return `<label style="font-size:.85em;display:flex;align-items:center;gap:3px"><input type="checkbox" class="fmc-recurring-day" value="${day}" ${rd.includes(day) ? 'checked' : ''}> ${day}</label>`;
                        }).join('')}
                    </div>
                </div>
                <button type="button" class="fmc-remove-btn" data-index="${i}" title="Remove child">✕</button>
            </div>`;
    }).join('');

    // Bind discount-type toggles
    container.querySelectorAll('.fmc-discount-type').forEach(sel => {
        sel.addEventListener('change', () => {
            const wrap = sel.closest('.fm-child-discount').querySelector('.discount-value-wrap');
            if (wrap) wrap.style.display = sel.value === 'custom' ? '' : 'none';
        });
    });

    // Bind remove buttons
    container.querySelectorAll('.fmc-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => removeModalChildRow(parseInt(btn.dataset.index)));
    });
}

function addModalChildRow() {
    // Sync any values already typed in the DOM back to familyModalChildren
    // before re-rendering (prevents wiping unsaved inputs).
    document.querySelectorAll('#fmChildRows .fm-child-row').forEach(row => {
        const idx = parseInt(row.dataset.index);
        if (!isNaN(idx) && familyModalChildren[idx]) {
            familyModalChildren[idx].child_name     = row.querySelector('.fmc-name')?.value.trim() || '';
            familyModalChildren[idx].child_dob      = row.querySelector('.fmc-dob')?.value || null;
            familyModalChildren[idx].room_override  = row.querySelector('.fmc-room')?.value || null;
            familyModalChildren[idx].discount_type  = row.querySelector('.fmc-discount-type')?.value || 'none';
            familyModalChildren[idx].discount_value = parseFloat(row.querySelector('.fmc-discount-value')?.value) || 0;
            familyModalChildren[idx].discount_note  = row.querySelector('.fmc-discount-note')?.value.trim() || null;
            familyModalChildren[idx].recurring_days = [...row.querySelectorAll('.fmc-recurring-day:checked')].map(cb => cb.value);
        }
    });

    familyModalChildren.push({
        id: null, child_name: '', child_dob: null,
        room_override: null, discount_type: 'none', discount_value: 0, discount_note: null,
        recurring_days: [],
    });
    renderModalChildRows();
    // Focus the new name input
    const rows = document.querySelectorAll('#fmChildRows .fm-child-row');
    if (rows.length) rows[rows.length - 1].querySelector('.fmc-name')?.focus();
}

function removeModalChildRow(index) {
    familyModalChildren.splice(index, 1);
    renderModalChildRows();
}

function readModalChildrenFromDom() {
    const children = [];
    document.querySelectorAll('#fmChildRows .fm-child-row').forEach(row => {
        const idx  = parseInt(row.dataset.index);
        const name = row.querySelector('.fmc-name').value.trim();
        if (!name) return;
        children.push({
            originalId:     familyModalChildren[idx]?.id || null,
            child_name:     name,
            child_dob:      row.querySelector('.fmc-dob').value || null,
            room_override:  row.querySelector('.fmc-room').value  || null,
            discount_type:  row.querySelector('.fmc-discount-type').value || 'none',
            discount_value: parseFloat(row.querySelector('.fmc-discount-value').value) || 0,
            discount_note:  row.querySelector('.fmc-discount-note').value.trim() || null,
            recurring_days: [...row.querySelectorAll('.fmc-recurring-day:checked')].map(cb => cb.value),
        });
    });
    return children;
}

async function saveFamilyModal() {
    const saveBtn = document.getElementById('fmSaveBtn');
    if (!saveBtn) return;
    saveBtn.disabled    = true;
    saveBtn.textContent = 'Saving…';

    try {
        const parentName  = document.getElementById('fmParentName').value.trim();
        const parentEmail = document.getElementById('fmParentEmail').value.trim();
        const parentPhone = document.getElementById('fmParentPhone').value.trim();
        const pinVal      = document.getElementById('fmPin').value.trim();
        const pin         = pinVal ? parseInt(pinVal, 10) : null;
        const p2Name      = document.getElementById('fmParent2Name').value.trim()  || null;
        const p2Email     = document.getElementById('fmParent2Email').value.trim() || null;
        const p2Phone     = document.getElementById('fmParent2Phone').value.trim() || null;
        const p2PinVal    = document.getElementById('fmParent2Pin').value.trim();
        const p2Pin       = p2PinVal ? parseInt(p2PinVal, 10) : null;
        const group       = document.querySelector('input[name="fmGroup"]:checked')?.value || 'regular';

        if (!parentName) { alert('Parent name is required.'); return; }

        const children = readModalChildrenFromDom();

        if (!editingFamilyId) {
            // ---- CREATE ----
            const fam = await createFamily({
                parentName, parentEmail, parentPhone, pin: pin || null,
                parent2Name: p2Name, parent2Email: p2Email,
                parent2Phone: p2Phone, parent2Pin: p2Pin,
            });
            // Set group (createFamily doesn't set it)
            await updateFamily(fam.id, { group });

            for (const child of children) {
                const student = await addStudent({
                    familyId: fam.id,
                    childName: child.child_name,
                    childDob:  child.child_dob,
                });
                await updateStudent(student.id, {
                    room_override:  child.room_override,
                    discount_type:  child.discount_type,
                    discount_value: child.discount_value,
                    discount_note:  child.discount_note,
                });
            }
        } else {
            // ---- UPDATE ----
            await updateFamily(editingFamilyId, {
                parent_name:  parentName,
                parent_email: parentEmail,
                parent_phone: parentPhone,
                pin:          pin || null,
                parent2_name:  p2Name,
                parent2_email: p2Email,
                parent2_phone: p2Phone,
                parent2_pin:   p2Pin,
                group,
            });

            // Reconcile children
            const origIds = familyModalChildren.map(c => c.id).filter(Boolean);
            const keptIds = children.map(c => c.originalId).filter(Boolean);

            // Delete removed children
            for (const origId of origIds) {
                if (!keptIds.includes(origId)) await deleteStudent(origId);
            }

            // Update existing / add new children
            for (const child of children) {
                if (child.originalId) {
                    await updateStudent(child.originalId, {
                        child_name:     child.child_name,
                        child_dob:      child.child_dob,
                        room_override:  child.room_override,
                        discount_type:  child.discount_type,
                        discount_value: child.discount_value,
                        discount_note:  child.discount_note,
                        recurring_days: child.recurring_days?.length ? child.recurring_days : null,
                    });
                } else {
                    const student = await addStudent({
                        familyId: editingFamilyId,
                        childName: child.child_name,
                        childDob:  child.child_dob,
                    });
                    await updateStudent(student.id, {
                        room_override:  child.room_override,
                        discount_type:  child.discount_type,
                        discount_value: child.discount_value,
                        discount_note:  child.discount_note,
                        recurring_days: child.recurring_days?.length ? child.recurring_days : null,
                    });
                }
            }
        }

        closeFamilyModal();
        await loadFamilies();

    } catch (err) {
        alert('Save failed: ' + err.message);
        console.error('saveFamilyModal:', err);
    } finally {
        saveBtn.disabled    = false;
        saveBtn.textContent = 'Save Family';
    }
}

// ---- Archive / Restore ----
async function confirmArchiveFamily(id, name) {
    if (!confirm(`Archive ${name}?\n\nThey'll be hidden from the active roster. Their registration history is preserved and you can restore them at any time.`)) return;
    await doArchiveFamily(id);
}

async function doArchiveFamily(id) {
    try {
        await archiveFamily(id);
        await loadFamilies();
    } catch (err) {
        alert('Archive failed: ' + err.message);
    }
}

async function doRestoreFamily(id) {
    try {
        await restoreFamily(id);
        await loadFamilies();
    } catch (err) {
        alert('Restore failed: ' + err.message);
    }
}

// ---- Delete ----
async function doSetFamilyLock(id, locked) {
    try {
        await setFamilyRegistrationLock(id, locked);
        const fam = allFamiliesData.find(f => f.id === id);
        if (fam) fam.registration_locked = locked;
        onFamilySearch();
    } catch (err) {
        alert((locked ? 'Lock' : 'Unlock') + ' failed: ' + err.message);
    }
}

async function doSetFamilyLoginLock(id, locked) {
    try {
        await setFamilyLoginLock(id, locked);
        const fam = allFamiliesData.find(f => f.id === id);
        if (fam) { fam.login_locked = locked; if (!locked) fam.login_attempts = 0; }
        onFamilySearch();
    } catch (err) {
        alert('Unlock login failed: ' + err.message);
    }
}

function confirmDeleteFamily(id, name) {
    if (!confirm(`Permanently delete the ${name} family and ALL their children?\n\nThis cannot be undone.`)) return;
    doDeleteFamily(id);
}

async function doDeleteFamily(id) {
    try {
        await deleteFamily(id);
        await loadFamilies();
    } catch (err) {
        alert('Delete failed: ' + err.message);
    }
}

// ---- Merge ----
let _mergingFamilyId = null;

function openMergeModal(familyId, familyName) {
    _mergingFamilyId = familyId;
    document.getElementById('mergeFromName').textContent = familyName;
    const select = document.getElementById('mergeIntoSelect');
    select.innerHTML = allFamiliesData
        .filter(f => f.id !== familyId)
        .map(f => {
            const ln = (f.parent_name || '').trim().split(/\s+/).pop() || '';
            return `<option value="${escHtml(f.id)}">${escHtml(ln)} Family — ${escHtml(f.parent_name || '')}</option>`;
        })
        .join('');
    document.getElementById('mergeModal').classList.remove('hidden');
}

function closeMergeModal() {
    _mergingFamilyId = null;
    document.getElementById('mergeModal').classList.add('hidden');
}

async function doMergeFamilies() {
    const toId = document.getElementById('mergeIntoSelect').value;
    if (!toId || !_mergingFamilyId) return;
    const btn = document.getElementById('mergeConfirmBtn');
    btn.disabled = true;
    btn.textContent = 'Merging…';
    try {
        await mergeFamilies(_mergingFamilyId, toId);
        closeMergeModal();
        await loadFamilies();
    } catch (err) {
        alert('Merge failed: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Merge & Delete';
    }
}

async function onArchiveSummerFamilies() {
    // Count summer families first
    const summerFamilies = allFamiliesData.filter(f => f.group === 'summer' && f.active !== false);
    if (!summerFamilies.length) {
        alert('No active summer families found.');
        return;
    }
    if (!confirm(`Archive all ${summerFamilies.length} summer program families?\n\nThey'll be hidden from the active roster but can be restored individually. Registration history is preserved.`)) return;
    try {
        const count = await archiveSummerFamilies();
        await loadFamilies();
        alert(`✅ ${count} summer famil${count !== 1 ? 'ies' : 'y'} archived.`);
    } catch (err) {
        alert('Archive failed: ' + err.message);
    }
}

// ============================================================
// MESSAGES
// ============================================================
let showArchivedMessages = false;
let _messagesLoaded      = false;

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
                            <button class="btn-delete-msg" data-id="${m.id}" title="Delete message permanently">🗑 Delete</button>
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

    container.querySelectorAll('.btn-delete-msg').forEach(btn => {
        btn.addEventListener('click', async e => {
            const id = e.currentTarget.getAttribute('data-id');
            if (!confirm('Permanently delete this message? This cannot be undone.')) return;
            try {
                await deleteMessage(id);
                await loadMessages();
            } catch (err) {
                alert('Failed to delete: ' + err.message);
            }
        });
    });
}

// ============================================================
// TABS
// ============================================================
function setupTabs() {
    const btns  = document.querySelectorAll('#adminTabs .admin-tab-btn');
    const panes = document.querySelectorAll('.tab-pane');

    function activate(tab) {
        btns.forEach(b  => b.classList.toggle('active', b.dataset.tab === tab));
        panes.forEach(p => p.classList.toggle('hidden', p.id !== 'tab-' + tab));
        localStorage.setItem('adminActiveTab', tab);
        // Lazy-load heavy data the first time each tab is opened
        if (tab === 'families'  && allFamiliesData.length === 0) loadFamilies();
        if (tab === 'staffing'  && allStaffData.length === 0)    loadStaffList();
        if (tab === 'messages'  && !_messagesLoaded)             { _messagesLoaded = true; loadMessages(); }
    }

    btns.forEach(btn => btn.addEventListener('click', () => activate(btn.dataset.tab)));

    // Restore last-used tab, defaulting to 'daily'
    const saved = localStorage.getItem('adminActiveTab') || 'daily';
    activate(saved);
}

// ============================================================
// COLLAPSIBLES  (Settings tab sections)
// ============================================================
function setupCollapsibles() {
    document.querySelectorAll('.collapsible-section').forEach(section => {
        const id = section.id;
        const h2 = section.querySelector('h2');
        if (!h2 || !id) return;
        // Skip if already processed (guards against double-init)
        if (section.querySelector(':scope > .collapsible-body')) return;

        // Wrap all content after h2 in a collapsible body div
        const body = document.createElement('div');
        body.className = 'collapsible-body';
        while (h2.nextSibling) body.appendChild(h2.nextSibling);
        section.appendChild(body);

        // Add toggle button inside h2
        const btn = document.createElement('button');
        btn.type      = 'button';
        btn.className = 'collapse-toggle';
        btn.setAttribute('aria-expanded', 'true');
        btn.title     = 'Collapse / expand';
        btn.innerHTML = '<span class="collapse-chevron" aria-hidden="true"></span>';
        h2.appendChild(btn);

        function setCollapsed(collapsed) {
            body.hidden = collapsed;
            section.classList.toggle('is-collapsed', collapsed);
            btn.setAttribute('aria-expanded', String(!collapsed));
            localStorage.setItem('adminCollapse_' + id, collapsed ? '1' : '0');
        }

        btn.addEventListener('click', () => setCollapsed(!section.classList.contains('is-collapsed')));

        // Restore saved state (default: open)
        if (localStorage.getItem('adminCollapse_' + id) === '1') setCollapsed(true);
    });
}

// ============================================================
// RATES & SETTINGS
// ============================================================
function setupRates() {
    renderRatesTable();
    document.getElementById('saveRatesBtn')?.addEventListener('click', onSaveRates);
}

function renderRatesTable() {
    const wrap = document.getElementById('ratesTableWrap');
    if (!wrap) return;
    wrap.innerHTML = `
        <table class="rates-table">
            <thead>
                <tr>
                    <th>Room</th>
                    <th>Full Day Rate ($)</th>
                    <th>Half Day Rate ($)</th>
                    <th>Weekly Full ($)<br><small>All 5 weekdays full</small></th>
                    <th>Weekly Half ($)<br><small>All 5 weekdays half</small></th>
                </tr>
            </thead>
            <tbody>
                ${ROOMS.map(room => `
                    <tr data-room-id="${room.id}">
                        <td class="rates-room-label">
                            <strong>${escHtml(room.label)}</strong>
                            <span class="rates-ages">${escHtml(room.ages)}</span>
                        </td>
                        <td>
                            <input type="number" class="rate-input" data-field="fullDayRate"
                                value="${room.fullDayRate ?? ''}" min="0" step="0.01" placeholder="0.00">
                        </td>
                        <td>
                            ${room.fullDayOnly
                                ? '<span class="rates-na">Full day only</span>'
                                : `<input type="number" class="rate-input" data-field="halfDayRate"
                                    value="${room.halfDayRate ?? ''}" min="0" step="0.01" placeholder="0.00">`
                            }
                        </td>
                        <td>
                            <input type="number" class="rate-input" data-field="weeklyFullRate"
                                value="${room.weeklyFullRate ?? ''}" min="0" step="0.01" placeholder="— disabled">
                        </td>
                        <td>
                            ${room.fullDayOnly
                                ? '<span class="rates-na">—</span>'
                                : `<input type="number" class="rate-input" data-field="weeklyHalfRate"
                                    value="${room.weeklyHalfRate ?? ''}" min="0" step="0.01" placeholder="— disabled">`
                            }
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
        <p class="rates-hint">💡 Weekly rates apply when a child books all 5 Mon–Fri days in a single week with the same day type. Leave blank to disable the discount for that room.</p>`;
}

async function onSaveRates() {
    const btn      = document.getElementById('saveRatesBtn');
    const statusEl = document.getElementById('ratesStatus');
    if (!btn) return;
    btn.disabled    = true;
    btn.textContent = 'Saving…';
    if (statusEl) { statusEl.textContent = ''; }

    try {
        const rates = {};
        document.querySelectorAll('#ratesTableWrap tbody tr[data-room-id]').forEach(row => {
            const id = row.dataset.roomId;
            rates[id] = {};
            row.querySelectorAll('.rate-input[data-field]').forEach(input => {
                const val = input.value.trim();
                rates[id][input.dataset.field] = val === '' ? null : parseFloat(val);
            });
        });

        await saveRateSettings(rates);
        // Merge saved values directly into ROOMS (avoids a DB round-trip that can
        // silently fail and revert the display back to hardcoded defaults).
        ROOMS.forEach(room => {
            const r = rates[room.id];
            if (!r) return;
            if (r.fullDayRate   != null) room.fullDayRate   = r.fullDayRate;
            if (r.halfDayRate   != null) room.halfDayRate   = r.halfDayRate;
            if (r.weeklyFullRate != null) room.weeklyFullRate = r.weeklyFullRate;
            if (r.weeklyHalfRate != null) room.weeklyHalfRate = r.weeklyHalfRate;
        });
        renderRatesTable();

        if (statusEl) {
            statusEl.textContent   = '✓ Saved!';
            statusEl.style.color   = '#2e7d32';
            setTimeout(() => { statusEl.textContent = ''; }, 3000);
        }
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = '⚠️ ' + err.message;
            statusEl.style.color = '#c62828';
        }
        console.error('onSaveRates:', err);
    } finally {
        btn.disabled    = false;
        btn.textContent = '💾 Save Rates';
    }
}

// ============================================================
// STAFF ROSTER
// ============================================================
let allStaffData       = [];
let showInactiveStaff  = false;
let editingStaffId     = null;
let staffAvailability  = {};   // { staffId: { days: [...], maxHours: 40 } }

function setupStaffRoster() {
    // Toggle Staff Roster visibility (shown below Payroll)
    document.getElementById('toggleStaffRosterBtn')?.addEventListener('click', () => {
        const section = document.getElementById('staffRosterSection');
        const btn     = document.getElementById('toggleStaffRosterBtn');
        const visible = section.style.display !== 'none';
        section.style.display = visible ? 'none' : '';
        btn.textContent = visible ? '👥 Show Staff Roster' : '👥 Hide Staff Roster';
        btn.classList.toggle('btn-active', !visible);
        if (!visible && !allStaffData.length) loadStaffList();
    });

    document.getElementById('addStaffBtn')?.addEventListener('click', () => openStaffForm());
    document.getElementById('cancelStaffBtn')?.addEventListener('click', closeStaffForm);
    document.getElementById('saveStaffBtn')?.addEventListener('click', onSaveStaffMember);
    document.getElementById('refreshStaffBtn')?.addEventListener('click', loadStaffList);
    document.getElementById('toggleInactiveStaffBtn')?.addEventListener('click', () => {
        showInactiveStaff = !showInactiveStaff;
        const btn = document.getElementById('toggleInactiveStaffBtn');
        btn.textContent = showInactiveStaff ? 'Hide Inactive' : 'Show Inactive';
        btn.classList.toggle('btn-active', showInactiveStaff);
        loadStaffList();
    });

    // Pay type toggle
    document.getElementById('sfPayType')?.addEventListener('change', e => _togglePayFields(e.target.value));

    // Populate room picker in the add/edit form
    const sel = document.getElementById('sfRoom');
    if (sel) {
        ROOMS.forEach(r => {
            const opt = document.createElement('option');
            opt.value = r.id; opt.textContent = r.label;
            sel.appendChild(opt);
        });
    }
}

async function loadStaffList() {
    const container = document.getElementById('staffRosterContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        [allStaffData, staffAvailability] = await Promise.all([
            fetchAllStaff({ includeInactive: showInactiveStaff }),
            fetchStaffAvailability(),
        ]);
        renderStaffList(allStaffData);
    } catch (err) {
        container.innerHTML = `<p class="import-error">Failed to load staff: ${escHtml(err.message)}</p>`;
    }
}

function renderStaffList(staff) {
    const container = document.getElementById('staffRosterContent');
    if (!staff.length) {
        container.innerHTML = '<p class="empty-hint">No staff members found. Click "+ Add Staff Member" to get started.</p>';
        return;
    }
    container.innerHTML = `
        <div class="table-wrapper">
        <table class="report-table staff-roster-table">
            <thead>
                <tr>
                    <th class="sr-col-name">Name</th>
                    <th class="sr-col-role">Role</th>
                    <th class="sr-col-room">Room</th>
                    <th class="sr-col-pay">Pay</th>
                    <th class="sr-col-pin">PIN</th>
                    <th class="sr-col-status">Status</th>
                    <th class="sr-col-actions">Actions</th>
                </tr>
            </thead>
            <tbody>
                ${staff.map(s => {
                    const roomLabel  = ROOMS.find(r => r.id === s.room_id)?.label || 'Float';
                    const pinDisplay = s.staff_pin != null ? String(s.staff_pin).padStart(4, '0') : '—';
                    const isSalary   = s.pay_type === 'salary';
                    const payDisplay = isSalary
                        ? `<span class="pay-type-chip pay-salary">Salary</span> $${(s.salary_biweekly || 0).toFixed(2)}/period`
                        : `$${(s.hourly_rate || 0).toFixed(2)}/hr`;
                    return `
                        <tr class="${s.active ? '' : 'staff-inactive-row'}" data-staff-id="${s.id}">
                            <td><strong>${escHtml(s.name)}</strong></td>
                            <td>${escHtml(s.role || '—')}</td>
                            <td>${escHtml(roomLabel)}</td>
                            <td>${payDisplay}</td>
                            <td><code>${pinDisplay}</code></td>
                            <td><span class="status-chip ${s.active ? 'chip-confirmed' : 'chip-waitlist'}">${s.active ? 'Active' : 'Inactive'}</span></td>
                            <td class="actions-cell">
                                <button class="btn-secondary staff-edit-btn" data-staff-id="${s.id}">Edit</button>
                                <button class="${s.active ? 'btn-warning' : 'btn-secondary'} staff-toggle-btn"
                                    data-staff-id="${s.id}" data-active="${s.active}">
                                    ${s.active ? 'Deactivate' : 'Restore'}
                                </button>
                                <button class="btn-danger staff-delete-btn" data-staff-id="${s.id}" data-staff-name="${escHtml(s.name)}" title="Permanently delete staff member">🗑 Delete</button>
                            </td>
                        </tr>`;
                }).join('')}
            </tbody>
        </table>
        </div>`;

    container.querySelectorAll('.staff-edit-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const s = allStaffData.find(x => x.id === btn.dataset.staffId);
            if (s) openStaffForm(s);
        });
    });
    container.querySelectorAll('.staff-toggle-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            const active = btn.dataset.active !== 'true';
            try {
                await setStaffActive(btn.dataset.staffId, active);
                await loadStaffList();
            } catch (err) {
                alert('Error: ' + err.message);
                btn.disabled = false;
            }
        });
    });
    container.querySelectorAll('.staff-delete-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const name = btn.dataset.staffName;
            if (!confirm(`Permanently delete ${name}?\n\nThis will remove all their records and cannot be undone.`)) return;
            btn.disabled = true;
            try {
                await deleteStaff(btn.dataset.staffId);
                await loadStaffList();
            } catch (err) {
                alert('Delete failed: ' + err.message);
                btn.disabled = false;
            }
        });
    });
}

function openStaffForm(staff = null) {
    // Ensure the Staff Roster section is expanded before showing the form
    const rosterSection = document.getElementById('staffRosterSection');
    if (rosterSection?.classList.contains('is-collapsed')) {
        const body = rosterSection.querySelector(':scope > .collapsible-body');
        if (body) body.hidden = false;
        rosterSection.classList.remove('is-collapsed');
        rosterSection.querySelector('.collapse-toggle')?.setAttribute('aria-expanded', 'true');
        localStorage.setItem('adminCollapse_staffRosterSection', '0');
    }

    editingStaffId = staff?.id || null;
    document.getElementById('staffFormTitle').textContent = staff ? 'Edit Staff Member' : 'Add Staff Member';
    document.getElementById('sfName').value      = staff?.name || '';
    document.getElementById('sfRole').value      = staff?.role || '';
    document.getElementById('sfRoom').value      = staff?.room_id || '';
    document.getElementById('sfHireDate').value  = staff?.hire_date || '';
    const rawPin = staff?.staff_pin;
    document.getElementById('sfPin').value = rawPin != null ? String(rawPin).padStart(4, '0') : '';

    const payType = staff?.pay_type || 'hourly';
    document.getElementById('sfPayType').value   = payType;
    document.getElementById('sfRate').value      = staff?.hourly_rate || '';
    document.getElementById('sfSalary').value    = staff?.salary_biweekly || '';
    _togglePayFields(payType);

    // Availability
    const avail = staff ? (staffAvailability[staff.id] || {}) : {};
    const availDays    = avail.days    || ['Mon','Tue','Wed','Thu','Fri'];
    const availPeriods = avail.periods || ['am','pm'];
    document.querySelectorAll('.sfAvailDay').forEach(cb => {
        cb.checked = availDays.includes(cb.value);
    });
    document.querySelectorAll('.sfAvailPeriod').forEach(cb => {
        cb.checked = availPeriods.includes(cb.value);
    });
    document.getElementById('sfMaxHours').value = avail.maxHours != null ? avail.maxHours : 40;
    document.getElementById('sfMaxDays').value  = avail.maxDays  != null ? avail.maxDays  : 5;

    document.getElementById('staffFormStatus').textContent = '';
    document.getElementById('staffEditForm').classList.remove('hidden');
    document.getElementById('sfName').focus();
}

function _togglePayFields(payType) {
    const hourlyRow = document.getElementById('sfHourlyRow');
    const salaryRow = document.getElementById('sfSalaryRow');
    if (payType === 'salary') {
        hourlyRow?.classList.add('hidden');
        salaryRow?.classList.remove('hidden');
    } else {
        hourlyRow?.classList.remove('hidden');
        salaryRow?.classList.add('hidden');
    }
}

function closeStaffForm() {
    document.getElementById('staffEditForm').classList.add('hidden');
    editingStaffId = null;
}

async function onSaveStaffMember() {
    const name = document.getElementById('sfName').value.trim();
    if (!name) { alert('Name is required.'); return; }

    const pinVal = document.getElementById('sfPin').value.trim();
    if (pinVal && (!/^\d{4}$/.test(pinVal))) { alert('PIN must be exactly 4 digits.'); return; }

    const payType = document.getElementById('sfPayType').value;

    // Capture availability before closing the form
    const availDays    = [...document.querySelectorAll('.sfAvailDay:checked')].map(cb => cb.value);
    const availPeriods = [...document.querySelectorAll('.sfAvailPeriod:checked')].map(cb => cb.value);
    const maxHours     = parseFloat(document.getElementById('sfMaxHours').value) || 40;
    const maxDays      = parseInt(document.getElementById('sfMaxDays').value, 10) || 5;
    const savingId     = editingStaffId;

    try {
        const returnedId = await upsertStaffMember({
            id:              savingId,
            name,
            role:            document.getElementById('sfRole').value.trim(),
            payType,
            hourlyRate:      parseFloat(document.getElementById('sfRate').value) || 0,
            salaryBiweekly:  parseFloat(document.getElementById('sfSalary').value) || 0,
            roomId:          document.getElementById('sfRoom').value || null,
            hireDate:        document.getElementById('sfHireDate').value || null,
            staffPin:        pinVal || null,
        });

        // Close immediately — don't make the user wait for the list to reload
        closeStaffForm();

        // Save availability and refresh the list in the background
        const staffId = savingId || returnedId;
        if (staffId) {
            if (typeof staffAvailability !== 'object' || Array.isArray(staffAvailability) || staffAvailability === null) {
                staffAvailability = {};
            }
            staffAvailability[staffId] = { days: availDays, periods: availPeriods, maxHours, maxDays };
            saveStaffAvailability(staffAvailability).catch(console.error);
        }
        loadStaffList();
    } catch (err) {
        alert('Save failed: ' + err.message);
    }
}

// ============================================================
// LOG HOURS
// ============================================================
function setupHoursEntry() {
    const el = document.getElementById('logHoursDate');
    if (el) el.value = new Date().toISOString().split('T')[0];
    document.getElementById('loadHoursBtn')?.addEventListener('click', loadHoursForDate);
    document.getElementById('saveHoursBtn')?.addEventListener('click', saveHoursForDate);
    document.getElementById('syncClockBtn')?.addEventListener('click', syncFromClockEvents);
}

async function syncFromClockEvents() {
    const date = document.getElementById('logHoursDate')?.value;
    if (!date) { alert('Please select a date first.'); return; }

    const btn = document.getElementById('syncClockBtn');
    btn.disabled = true; btn.textContent = 'Syncing…';
    try {
        const events = await fetchClockEventsForDate(date);
        if (!events.length) {
            alert('No clock events found for this date.');
            return;
        }
        // Sum all events per staff (supports multiple shifts in one day)
        // Shifts < 10 minutes are discarded (clock-in errors)
        const totals = new Map();
        events.forEach(ev => {
            if (!ev.clock_in || !ev.clock_out) return;
            const ms = new Date(ev.clock_out) - new Date(ev.clock_in);
            if (ms < 10 * 60 * 1000) return;           // discard < 10 min
            const hrs = Math.round(ms / 3600000 * 100) / 100;  // exact, 2 dp
            totals.set(ev.staff_id, (totals.get(ev.staff_id) || 0) + hrs);
        });
        const saves = [...totals.entries()].map(([staffId, hrs]) =>
            upsertStaffHours(staffId, date, hrs, 'Synced from clock-in'));
        await Promise.all(saves);
        await loadHoursForDate();
        btn.textContent = `✓ Synced ${saves.length} record(s)!`;
        setTimeout(() => { btn.textContent = '⟳ Sync from Clock-In'; }, 3000);
    } catch (err) {
        alert('Sync failed: ' + err.message);
        btn.textContent = '⟳ Sync from Clock-In';
    } finally { btn.disabled = false; }
}

function _fmtClockTime(isoStr) {
    if (!isoStr) return '—';
    return new Date(isoStr).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

function _timeInputDefault(isoStr) {
    // Returns "HH:MM" for a time input default, local time
    const d = isoStr ? new Date(isoStr) : new Date();
    return d.toTimeString().slice(0, 5);
}

function _localTimeToISO(workDate, timeStr) {
    // Combine a work_date (YYYY-MM-DD) with a time input value (HH:MM) → ISO string
    return new Date(`${workDate}T${timeStr}:00`).toISOString();
}

async function loadHoursForDate() {
    const date = document.getElementById('logHoursDate')?.value;
    if (!date) { alert('Please select a date.'); return; }

    const container = document.getElementById('hoursEntryContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        if (!allStaffData.length) await loadStaffList();
        const active = allStaffData.filter(s => s.active);
        if (!active.length) {
            container.innerHTML = '<p class="empty-hint">No active staff. Add staff in the Staff Roster section above.</p>';
            return;
        }

        const [hoursList, clockEvents] = await Promise.all([
            fetchStaffHours(date, date),
            fetchClockEventsForDate(date)
        ]);
        const hoursMap  = new Map(hoursList.map(h => [h.staff_id, h]));

        // Group clock events by staff
        const eventsMap = new Map(); // staff_id -> event[]
        clockEvents
            .sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in))
            .forEach(ev => {
                if (!eventsMap.has(ev.staff_id)) eventsMap.set(ev.staff_id, []);
                eventsMap.get(ev.staff_id).push(ev);
            });

        // Sum completed events per staff (≥10 min)
        const clockedMap = new Map();
        clockEvents.forEach(ev => {
            if (!ev.clock_in || !ev.clock_out) return;
            const ms = new Date(ev.clock_out) - new Date(ev.clock_in);
            if (ms < 10 * 60 * 1000) return;
            const hrs = Math.round(ms / 3600000 * 100) / 100;
            clockedMap.set(ev.staff_id, (clockedMap.get(ev.staff_id) || 0) + hrs);
        });

        const renderEvents = (staffId) => {
            const evs = eventsMap.get(staffId) || [];
            const rows = evs.map(ev => {
                const isOpen = ev.clock_in && !ev.clock_out;
                const inTime  = _fmtClockTime(ev.clock_in);
                const outDefault = _timeInputDefault(null); // current time as default
                if (isOpen) {
                    return `<div class="clock-event-item clock-event-open">
                        <span class="clock-event-label">⚠ ${inTime} → not clocked out</span>
                        <input type="time" class="clock-out-time-input" value="${outDefault}">
                        <button class="btn-secondary clock-out-manual-btn" data-event-id="${ev.id}">Clock Out</button>
                        <button class="btn-ghost clock-delete-btn" data-event-id="${ev.id}" title="Delete entry">✕</button>
                    </div>`;
                }
                const ms  = new Date(ev.clock_out) - new Date(ev.clock_in);
                const hrs = (ms / 3600000).toFixed(2);
                const inVal  = _timeInputDefault(ev.clock_in);
                const outVal = _timeInputDefault(ev.clock_out);
                return `<div class="clock-event-item">
                    <span class="clock-event-label">${inTime} → ${_fmtClockTime(ev.clock_out)} (${hrs}h)</span>
                    <button class="btn-ghost clock-edit-btn" data-event-id="${ev.id}" title="Edit times">Edit</button>
                    <button class="btn-ghost clock-delete-btn" data-event-id="${ev.id}" title="Delete entry">✕</button>
                    <div class="clock-edit-form hidden">
                        <input type="time" class="edit-clock-in-input" value="${inVal}">
                        <span>→</span>
                        <input type="time" class="edit-clock-out-input" value="${outVal}">
                        <button class="btn-secondary confirm-edit-clock-btn" data-event-id="${ev.id}">Save</button>
                        <button class="btn-ghost cancel-edit-clock-btn">Cancel</button>
                    </div>
                </div>`;
            });

            return `<div class="clock-events-wrap" data-staff-id="${staffId}">
                ${rows.join('')}
                <div class="clock-add-form hidden">
                    <input type="time" class="new-clock-in-input">
                    <span>→</span>
                    <input type="time" class="new-clock-out-input" placeholder="(leave blank = open)">
                    <button class="btn-secondary confirm-add-clock-btn">Add</button>
                    <button class="btn-ghost cancel-add-clock-btn">Cancel</button>
                </div>
                <div class="clock-action-btns">
                    <button class="btn-ghost show-add-clock-btn">+ Add Entry</button>
                    <button class="btn-secondary clock-in-now-btn">Clock In Now</button>
                </div>
            </div>`;
        };

        container.innerHTML = `
            <table class="report-table hours-entry-table">
                <thead>
                    <tr>
                        <th>Staff Member</th>
                        <th>Role</th>
                        <th>Clock Events</th>
                        <th>Clocked Hrs</th>
                        <th>Hours Worked</th>
                        <th>Notes</th>
                    </tr>
                </thead>
                <tbody>
                    ${active.map(s => {
                        const entry     = hoursMap.get(s.id);
                        const clocked   = clockedMap.get(s.id);
                        const hoursVal  = entry?.hours_worked ?? (clocked != null ? clocked : '');
                        const clockedDisplay = clocked != null ? clocked.toFixed(2) : '—';
                        return `
                            <tr data-staff-id="${s.id}">
                                <td><strong>${escHtml(s.name)}</strong></td>
                                <td>${escHtml(s.role || '—')}</td>
                                <td>${renderEvents(s.id)}</td>
                                <td>${clockedDisplay}</td>
                                <td><input type="number" class="rate-input hours-input"
                                    min="0" max="24" step="0.25" placeholder="0.00" style="width:80px"
                                    value="${hoursVal}"></td>
                                <td><input type="text" class="hours-notes-input"
                                    placeholder="Optional note" style="width:160px"
                                    value="${escHtml(entry?.notes || '')}"></td>
                            </tr>`;
                    }).join('')}
                </tbody>
            </table>`;

        // Clock Out buttons (for open events)
        container.querySelectorAll('.clock-out-manual-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const eventId  = btn.dataset.eventId;
                const timeInput = btn.previousElementSibling;
                if (!timeInput?.value) { alert('Enter a clock-out time.'); return; }
                btn.disabled = true;
                try {
                    await updateClockEventOut(eventId, _localTimeToISO(date, timeInput.value));
                    await loadHoursForDate();
                } catch (err) {
                    alert('Clock-out failed: ' + err.message);
                    btn.disabled = false;
                }
            });
        });

        // Show/hide Add Entry form
        container.querySelectorAll('.show-add-clock-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const wrap = btn.closest('.clock-events-wrap');
                const form = wrap.querySelector('.clock-add-form');
                form.classList.remove('hidden');
                btn.closest('.clock-action-btns').classList.add('hidden');
                form.querySelector('.new-clock-in-input').value  = '09:00';
                form.querySelector('.new-clock-out-input').value = '';
                form.querySelector('.new-clock-in-input').focus();
            });
        });

        // Clock In Now — creates an open event with current time, employee clocks out themselves
        container.querySelectorAll('.clock-in-now-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const wrap    = btn.closest('.clock-events-wrap');
                const staffId = wrap.dataset.staffId;
                btn.disabled = true; btn.textContent = 'Clocking in…';
                try {
                    await insertManualClockEvent(staffId, date, new Date().toISOString(), null);
                    await loadHoursForDate();
                } catch (err) {
                    alert('Clock-in failed: ' + err.message);
                    btn.disabled = false; btn.textContent = 'Clock In Now';
                }
            });
        });

        container.querySelectorAll('.cancel-add-clock-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const form = btn.closest('.clock-add-form');
                form.classList.add('hidden');
                form.closest('.clock-events-wrap').querySelector('.clock-action-btns').classList.remove('hidden');
            });
        });

        container.querySelectorAll('.confirm-add-clock-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const form    = btn.closest('.clock-add-form');
                const wrap    = btn.closest('.clock-events-wrap');
                const staffId = wrap.dataset.staffId;
                const inVal   = form.querySelector('.new-clock-in-input').value;
                const outVal  = form.querySelector('.new-clock-out-input').value;
                if (!inVal) { alert('Clock-in time is required.'); return; }
                btn.disabled = true;
                try {
                    await insertManualClockEvent(
                        staffId, date,
                        _localTimeToISO(date, inVal),
                        outVal ? _localTimeToISO(date, outVal) : null
                    );
                    await loadHoursForDate();
                } catch (err) {
                    alert('Failed to add entry: ' + err.message);
                    btn.disabled = false;
                }
            });
        });

        // Delete clock event
        container.querySelectorAll('.clock-delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this clock entry?')) return;
                btn.disabled = true;
                try {
                    await deleteClockEvent(btn.dataset.eventId);
                    await loadHoursForDate();
                } catch (err) {
                    alert('Delete failed: ' + err.message);
                    btn.disabled = false;
                }
            });
        });

        // Show edit form
        container.querySelectorAll('.clock-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const item = btn.closest('.clock-event-item');
                item.querySelector('.clock-edit-form').classList.remove('hidden');
                item.querySelector('.clock-event-label').classList.add('hidden');
                btn.classList.add('hidden');
                item.querySelector('.clock-delete-btn').classList.add('hidden');
            });
        });

        // Cancel edit
        container.querySelectorAll('.cancel-edit-clock-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const item = btn.closest('.clock-event-item');
                item.querySelector('.clock-edit-form').classList.add('hidden');
                item.querySelector('.clock-event-label').classList.remove('hidden');
                item.querySelector('.clock-edit-btn').classList.remove('hidden');
                item.querySelector('.clock-delete-btn').classList.remove('hidden');
            });
        });

        // Save edit
        container.querySelectorAll('.confirm-edit-clock-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const form  = btn.closest('.clock-edit-form');
                const inVal  = form.querySelector('.edit-clock-in-input').value;
                const outVal = form.querySelector('.edit-clock-out-input').value;
                if (!inVal) { alert('Clock-in time is required.'); return; }
                btn.disabled = true;
                try {
                    await updateClockEvent(
                        btn.dataset.eventId,
                        _localTimeToISO(date, inVal),
                        outVal ? _localTimeToISO(date, outVal) : null
                    );
                    await loadHoursForDate();
                } catch (err) {
                    alert('Save failed: ' + err.message);
                    btn.disabled = false;
                }
            });
        });

    } catch (err) {
        container.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    }
}

async function saveHoursForDate() {
    const date = document.getElementById('logHoursDate')?.value;
    if (!date) { alert('Please select a date first.'); return; }

    const rows = document.querySelectorAll('#hoursEntryContent tbody tr[data-staff-id]');
    if (!rows.length) { alert('Click Load first to bring up the staff list.'); return; }

    const btn = document.getElementById('saveHoursBtn');
    btn.disabled = true; btn.textContent = 'Saving…';

    try {
        const saves = [];
        rows.forEach(row => {
            const staffId  = row.dataset.staffId;
            const hoursVal = row.querySelector('.hours-input')?.value.trim();
            const notes    = row.querySelector('.hours-notes-input')?.value.trim() || '';
            if (hoursVal !== '' && !isNaN(parseFloat(hoursVal))) {
                saves.push(upsertStaffHours(staffId, date, parseFloat(hoursVal), notes));
            }
        });
        await Promise.all(saves);
        btn.textContent = '✓ Saved!';
        setTimeout(() => { btn.textContent = '💾 Save Hours'; }, 2000);
    } catch (err) {
        alert('Save failed: ' + err.message);
        btn.textContent = '💾 Save Hours';
    } finally { btn.disabled = false; }
}

// ============================================================
// PAYROLL REPORT
// ============================================================
// Anchor: the pay period that ended 2026-03-01 (Sunday).
// All bi-weekly periods are Mon–Sun, 14 days, on that fixed schedule.
const PAYROLL_ANCHOR_END = '2026-03-01';

function _buildPayrollPeriodList() {
    const fmt   = d => d.toISOString().split('T')[0];
    const anchor = new Date(PAYROLL_ANCHOR_END + 'T00:00:00');
    // Earliest period to show: Jan 1, 2026
    const earliest = new Date('2026-01-01T00:00:00');

    // Latest period to show: 3 years forward from today
    const latest = new Date();
    latest.setFullYear(latest.getFullYear() + 3);

    // Walk anchor backwards until we're before 'earliest'
    let endDate = new Date(anchor);
    while (endDate > earliest) endDate.setDate(endDate.getDate() - 14);
    endDate.setDate(endDate.getDate() + 14); // step into range

    const periods = [];
    while (endDate <= latest) {
        const startDate = new Date(endDate);
        startDate.setDate(endDate.getDate() - 13);
        periods.push({ start: fmt(startDate), end: fmt(endDate) });
        endDate.setDate(endDate.getDate() + 14);
    }
    return periods;
}

function _payrollPeriodLabel(start, end) {
    const [sy, sm, sd] = start.split('-').map(Number);
    const [,   em, ed] = end.split('-').map(Number);
    return `${MONTH_NAMES_ADMIN[sm-1]} ${sd} – ${MONTH_NAMES_ADMIN[em-1]} ${ed}, ${sy}`;
}

function setupPayrollReport() {
    document.getElementById('generatePayrollBtn')?.addEventListener('click', generatePayrollReport);
    document.getElementById('exportPayrollBtn')?.addEventListener('click', exportPayrollReport);

    const sel = document.getElementById('payrollPeriod');
    if (!sel) return;

    const periods = _buildPayrollPeriodList();
    const todayStr = new Date().toISOString().split('T')[0];

    // Find the most-recently-completed period (end ≤ today), default to it
    let defaultIdx = 0;
    periods.forEach((p, i) => { if (p.end <= todayStr) defaultIdx = i; });

    periods.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = `${p.start}|${p.end}`;
        opt.textContent = _payrollPeriodLabel(p.start, p.end);
        if (i === defaultIdx) opt.selected = true;
        sel.appendChild(opt);
    });
}

async function _buildPayrollData(startVal, endVal) {
    const ytdStart = `${endVal.substring(0, 4)}-01-01`;
    const [allStaff, periodHrs, ytdHrs, periodClockEvents, ytdClockEvents] = await Promise.all([
        fetchAllStaff({ includeInactive: true }),
        fetchStaffHours(startVal, endVal),
        fetchStaffHours(ytdStart, endVal),
        fetchClockEventsForRange(startVal, endVal),
        fetchClockEventsForRange(ytdStart, endVal),
    ]);

    // Build a set of (staff_id, work_date) keys that already have a manual hours entry
    function manualKey(staffId, workDate) { return `${staffId}|${workDate}`; }
    const manualPeriodKeys = new Set(periodHrs.map(h => manualKey(h.staff_id, h.work_date)));
    const manualYtdKeys    = new Set(ytdHrs.map(h => manualKey(h.staff_id, h.work_date)));

    function calcClockHrs(ev) {
        if (!ev.clock_in || !ev.clock_out) return 0;
        const ms = new Date(ev.clock_out) - new Date(ev.clock_in);
        if (ms < 10 * 60 * 1000) return 0;             // discard < 10 min
        return Math.round(ms / 3600000 * 100) / 100;   // exact, 2 dp
    }

    // Sum manual hours
    const periodMap = new Map();
    periodHrs.forEach(h => periodMap.set(h.staff_id, (periodMap.get(h.staff_id) || 0) + parseFloat(h.hours_worked)));
    const ytdMap = new Map();
    ytdHrs.forEach(h => ytdMap.set(h.staff_id, (ytdMap.get(h.staff_id) || 0) + parseFloat(h.hours_worked)));

    // Add clock-calculated hours for any day without a manual entry
    periodClockEvents.forEach(ev => {
        if (manualPeriodKeys.has(manualKey(ev.staff_id, ev.work_date))) return;
        const hrs = calcClockHrs(ev);
        if (hrs > 0) periodMap.set(ev.staff_id, (periodMap.get(ev.staff_id) || 0) + hrs);
    });
    ytdClockEvents.forEach(ev => {
        if (manualYtdKeys.has(manualKey(ev.staff_id, ev.work_date))) return;
        const hrs = calcClockHrs(ev);
        if (hrs > 0) ytdMap.set(ev.staff_id, (ytdMap.get(ev.staff_id) || 0) + hrs);
    });

    // Include active staff + anyone with hours in the period
    const staff = allStaff.filter(s => s.active || periodMap.has(s.id));
    staff.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return { staff, periodMap, ytdMap };
}

async function generatePayrollReport() {
    const sel = document.getElementById('payrollPeriod');
    if (!sel?.value) { alert('Please select a pay period.'); return; }
    const [startVal, endVal] = sel.value.split('|');

    const container = document.getElementById('payrollContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const { staff, periodMap, ytdMap } = await _buildPayrollData(startVal, endVal);
        renderPayrollReport(startVal, endVal, staff, periodMap, ytdMap);
    } catch (err) {
        container.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    }
}

function _calcYtdPeriods(startVal, endVal) {
    // Count how many complete 14-day periods from Jan 1 of end year through endVal
    const year     = parseInt(endVal.substring(0, 4), 10);
    const jan1     = new Date(`${year}-01-01T00:00:00`);
    const end      = new Date(endVal + 'T00:00:00');
    const days     = Math.round((end - jan1) / 86400000) + 1;
    return Math.max(1, Math.ceil(days / 14));
}

function renderPayrollReport(startVal, endVal, staff, periodMap, ytdMap) {
    const container = document.getElementById('payrollContent');
    if (!staff.length) {
        container.innerHTML = '<p class="empty-hint">No staff data found.</p>';
        return;
    }

    let totPeriodPay = 0, totYtdPay = 0;
    const ytdPeriods = _calcYtdPeriods(startVal, endVal);

    const rows = staff.map(s => {
        const isSalary   = s.pay_type === 'salary';
        const roomLabel  = ROOMS.find(r => r.id === s.room_id)?.label || 'Float';
        const inactive   = !s.active ? ' <span class="chip-waitlist status-chip" style="font-size:.75em">Inactive</span>' : '';
        let periodPayStr, ytdPayStr, rateStr, periodHrsStr, ytdHrsStr;

        if (isSalary) {
            const sal      = s.salary_biweekly || 0;
            const ytdSal   = sal * ytdPeriods;
            totPeriodPay  += sal;
            totYtdPay     += ytdSal;
            rateStr        = `<span class="pay-type-chip pay-salary">Salary</span>`;
            periodHrsStr   = '—';
            periodPayStr   = sal > 0 ? '$' + sal.toFixed(2) : '—';
            ytdHrsStr      = '—';
            ytdPayStr      = ytdSal > 0 ? '$' + ytdSal.toFixed(2) : '—';
        } else {
            const pHrs = periodMap.get(s.id) || 0;
            const yHrs = ytdMap.get(s.id) || 0;
            const rate = s.hourly_rate || 0;
            totPeriodPay += pHrs * rate;
            totYtdPay    += yHrs * rate;
            rateStr       = `$${rate.toFixed(2)}/hr`;
            periodHrsStr  = pHrs > 0 ? pHrs.toFixed(2) : '—';
            periodPayStr  = pHrs > 0 ? '$' + (pHrs * rate).toFixed(2) : '—';
            ytdHrsStr     = yHrs > 0 ? yHrs.toFixed(2) : '—';
            ytdPayStr     = yHrs > 0 ? '$' + (yHrs * rate).toFixed(2) : '—';
        }

        return `
            <tr>
                <td>
                    <strong>${escHtml(s.name)}</strong>${inactive}
                    <br><small class="rates-ages">${escHtml(s.role || '')} · ${escHtml(roomLabel)}</small>
                </td>
                <td>${rateStr}</td>
                <td class="report-num payroll-hrs">${periodHrsStr}</td>
                <td class="report-num report-revenue">${periodPayStr}</td>
                <td class="report-num payroll-hrs">${ytdHrsStr}</td>
                <td class="report-num report-revenue">${ytdPayStr}</td>
            </tr>`;
    }).join('');

    const [sy, sm, sd] = startVal.split('-').map(Number);
    const [ey, em, ed] = endVal.split('-').map(Number);
    const periodLabel  = `${MONTH_NAMES_ADMIN[sm-1]} ${sd} – ${MONTH_NAMES_ADMIN[em-1]} ${ed}, ${ey}`;

    container.innerHTML = `
        <h3 class="report-month-title">Pay Period: ${periodLabel}</h3>
        <div class="table-wrapper report-table-wrap">
            <table class="report-table payroll-table">
                <thead>
                    <tr>
                        <th rowspan="2">Staff Member</th>
                        <th rowspan="2">Rate</th>
                        <th colspan="2" class="staff-room-header">This Period</th>
                        <th colspan="2" class="staff-room-header">Year to Date (${ey})</th>
                    </tr>
                    <tr>
                        <th class="staff-sub-head">Hours</th><th class="staff-sub-head">Gross Pay</th>
                        <th class="staff-sub-head">Hours</th><th class="staff-sub-head">Gross Pay</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
                <tfoot>
                    <tr class="report-total-row">
                        <td colspan="2"><strong>Total Payroll</strong></td>
                        <td class="report-num">—</td>
                        <td class="report-num report-revenue"><strong>$${totPeriodPay.toFixed(2)}</strong></td>
                        <td class="report-num">—</td>
                        <td class="report-num report-revenue"><strong>$${totYtdPay.toFixed(2)}</strong></td>
                    </tr>
                </tfoot>
            </table>
        </div>`;
}

async function exportPayrollReport() {
    const sel = document.getElementById('payrollPeriod');
    if (!sel?.value) { alert('Please select a pay period first.'); return; }
    const [startVal, endVal] = sel.value.split('|');

    const { staff, periodMap, ytdMap } = await _buildPayrollData(startVal, endVal);
    const ytdPeriods = _calcYtdPeriods(startVal, endVal);
    const rows = staff.map(s => {
        const isSalary = s.pay_type === 'salary';
        if (isSalary) {
            const sal    = s.salary_biweekly || 0;
            return {
                'Name':             s.name,
                'Role':             s.role || '',
                'Room':             ROOMS.find(r => r.id === s.room_id)?.label || 'Float',
                'Pay Type':         'Salary',
                'Rate':             `$${sal.toFixed(2)}/period`,
                'Period Hours':     '—',
                'Period Gross Pay': `$${sal.toFixed(2)}`,
                'YTD Hours':        '—',
                'YTD Gross Pay':    `$${(sal * ytdPeriods).toFixed(2)}`,
            };
        }
        const pHrs = periodMap.get(s.id) || 0;
        const yHrs = ytdMap.get(s.id) || 0;
        const rate = s.hourly_rate || 0;
        return {
            'Name':             s.name,
            'Role':             s.role || '',
            'Room':             ROOMS.find(r => r.id === s.room_id)?.label || 'Float',
            'Pay Type':         'Hourly',
            'Rate':             `$${rate.toFixed(2)}/hr`,
            'Period Hours':     pHrs.toFixed(2),
            'Period Gross Pay': `$${(pHrs * rate).toFixed(2)}`,
            'YTD Hours':        yHrs.toFixed(2),
            'YTD Gross Pay':    `$${(yHrs * rate).toFixed(2)}`,
        };
    });

    if (!rows.length) { alert('No data to export.'); return; }
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Payroll');
    ws['!cols'] = Object.keys(rows[0]).map(k => ({
        wch: Math.max(k.length, ...rows.map(r => String(r[k] || '').length))
    }));
    XLSX.writeFile(wb, `payroll-${startVal}-to-${endVal}.xlsx`);
}

// ============================================================
// EXTRA REPORTS  (Enrollment Trends · Waitlist Demand · YTD Revenue)
// ============================================================
function setupExtraReports() {
    document.getElementById('generateTrendsBtn')?.addEventListener('click', generateEnrollmentTrends);
    document.getElementById('exportTrendsBtn')?.addEventListener('click', exportEnrollmentTrends);
    document.getElementById('generateYtdBtn')?.addEventListener('click', generateYtdRevenue);
    document.getElementById('exportYtdBtn')?.addEventListener('click', exportYtdRevenue);
    setupHistoricalAttendance();
}

// ============================================================
// HISTORICAL ATTENDANCE — Jan through Apr 2026
// ============================================================
const HISTORICAL_ROOM_LABELS = {
    bear:   'Bear Room (Infants)',
    bee:    'Bee Room (Ones)',
    turtle: 'Turtle Room (Twos)',
    owl:    'Owl Room (Threes)',
};

function setupHistoricalAttendance() {
    loadHistoricalBilling();
    document.getElementById('loadHistoricalBtn')?.addEventListener('click', loadHistoricalDaily);
    document.getElementById('exportHistoricalBtn')?.addEventListener('click', exportHistoricalDaily);
}

async function loadHistoricalBilling() {
    const wrap = document.getElementById('historicalBillingTable');
    if (!wrap) return;
    wrap.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const data = await fetchBillingSummary();
        if (!data || data.length === 0) {
            wrap.innerHTML = '<p class="empty-hint">No billing summary data found. Run the seed SQL in Supabase first.</p>';
            return;
        }
        wrap.innerHTML = _buildBillingTable(data);
    } catch (e) {
        wrap.innerHTML = `<p class="empty-hint" style="color:red;">Error loading billing data: ${escHtml(e.message)}</p>`;
    }
}

function _buildBillingTable(rows) {
    const months = [...new Set(rows.map(r => r.month))].sort();
    const rooms  = ['bear', 'bee', 'turtle', 'owl'];

    // Index by month+room
    const idx = {};
    rows.forEach(r => { idx[`${r.month}|${r.room_id}`] = r; });

    const fmt  = v => v != null ? `$${Number(v).toLocaleString('en-US', { minimumFractionDigits: 0 })}` : '—';
    const fmtN = v => v != null ? v.toLocaleString() : '—';

    const monthLabel = m => new Date(m + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    let html = '<div style="overflow-x:auto"><table class="report-table" style="font-size:0.85rem">';
    html += '<thead><tr><th>Room</th>';
    months.forEach(m => {
        html += `<th colspan="4" style="text-align:center;border-left:2px solid #ccc">${monthLabel(m)}</th>`;
    });
    html += '</tr><tr><th></th>';
    months.forEach(() => {
        html += '<th style="border-left:2px solid #ccc">Half Days</th><th>Full Days</th><th>Discount</th><th>Net Billed</th>';
    });
    html += '</tr></thead><tbody>';

    let colTotals = {}; // month -> { half, full, discount, net }
    months.forEach(m => { colTotals[m] = { half: 0, full: 0, discount: 0, net: 0 }; });

    rooms.forEach(roomId => {
        html += `<tr><td><strong>${escHtml(HISTORICAL_ROOM_LABELS[roomId] || roomId)}</strong></td>`;
        months.forEach(m => {
            const r = idx[`${m}|${roomId}`];
            const half     = r?.half_days;
            const full     = r?.full_days;
            const discount = r?.discount;
            const net      = r?.net_billed;
            if (r) {
                colTotals[m].half     += half     ?? 0;
                colTotals[m].full     += full     ?? 0;
                colTotals[m].discount += discount ?? 0;
                colTotals[m].net      += net      ?? 0;
            }
            html += `<td style="border-left:2px solid #ccc;text-align:right">${fmtN(half)}</td>`;
            html += `<td style="text-align:right">${fmtN(full)}</td>`;
            html += `<td style="text-align:right;color:#b00">${r?.discount != null ? fmt(discount) : '—'}</td>`;
            html += `<td style="text-align:right;font-weight:600">${fmt(net)}</td>`;
        });
        html += '</tr>';
    });

    // Totals row
    html += '<tr style="font-weight:700;background:#f0f4ff"><td>TOTAL</td>';
    months.forEach(m => {
        const t = colTotals[m];
        html += `<td style="border-left:2px solid #ccc;text-align:right">${t.half.toLocaleString()}</td>`;
        html += `<td style="text-align:right">${t.full.toLocaleString()}</td>`;
        html += `<td style="text-align:right;color:#b00">${t.discount ? fmt(t.discount) : '—'}</td>`;
        html += `<td style="text-align:right">${fmt(t.net)}</td>`;
    });
    html += '</tr>';

    html += '</tbody></table></div>';
    return html;
}

async function loadHistoricalDaily() {
    const month = document.getElementById('historicalMonth')?.value;
    const room  = document.getElementById('historicalRoom')?.value;
    const wrap  = document.getElementById('historicalDailyTable');
    if (!wrap || !month) return;
    wrap.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const data = await fetchAttendanceSummary({ month, roomId: room || null });
        if (!data || data.length === 0) {
            wrap.innerHTML = '<p class="empty-hint">No daily attendance data found for this selection. Run the seed SQL in Supabase first.</p>';
            return;
        }
        wrap.innerHTML = _buildDailyTable(data);
    } catch (e) {
        wrap.innerHTML = `<p class="empty-hint" style="color:red;">Error: ${escHtml(e.message)}</p>`;
    }
}

function _buildDailyTable(rows) {
    const dayFmt = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    let html = '<div style="overflow-x:auto"><table class="report-table" style="font-size:0.85rem">';
    html += '<thead><tr><th>Date</th><th>Room</th><th style="text-align:right">Half Days</th><th style="text-align:right">Full Days</th><th style="text-align:right">Total</th></tr></thead><tbody>';
    let lastDate = '';
    rows.forEach(r => {
        const isNewDate = r.summary_date !== lastDate;
        lastDate = r.summary_date;
        html += `<tr${isNewDate ? ' style="border-top:1px solid #ddd"' : ''}>`;
        html += `<td>${isNewDate ? escHtml(dayFmt(r.summary_date)) : ''}</td>`;
        html += `<td>${escHtml(HISTORICAL_ROOM_LABELS[r.room_id] || r.room_id)}</td>`;
        html += `<td style="text-align:right">${r.half_days ?? '<em style="color:#888">n/a</em>'}</td>`;
        html += `<td style="text-align:right">${r.full_days ?? '<em style="color:#888">n/a</em>'}</td>`;
        html += `<td style="text-align:right;font-weight:600">${r.total_attended}</td>`;
        html += '</tr>';
    });
    html += '</tbody></table></div>';
    return html;
}

async function exportHistoricalDaily() {
    const month = document.getElementById('historicalMonth')?.value || '2026-01';
    const room  = document.getElementById('historicalRoom')?.value;
    const data  = await fetchAttendanceSummary({ month, roomId: room || null });
    if (!data || data.length === 0) return;
    const lines = ['Date,Room,Half Days,Full Days,Total'];
    data.forEach(r => {
        lines.push([r.summary_date, HISTORICAL_ROOM_LABELS[r.room_id] || r.room_id,
            r.half_days ?? '', r.full_days ?? '', r.total_attended].map(csvCell).join(','));
    });
    downloadFile(`attendance_${month}.csv`, 'text/csv', lines.join('\n'));
}

// ── Enrollment Trends ──────────────────────────────────────
function _buildTrendMap() {
    // Returns { 'YYYY-MM': { roomId: Set<regId>, _full: N, _half: N } }
    const trendMap = {};
    allRegistrations.forEach(reg => {
        (reg.registration_dates || []).forEach(d => {
            if (d.waitlisted || !d.care_date) return;
            const mo = d.care_date.substring(0, 7);
            if (!trendMap[mo]) trendMap[mo] = { _full: 0, _half: 0 };
            if (!trendMap[mo][reg.room_id]) trendMap[mo][reg.room_id] = new Set();
            trendMap[mo][reg.room_id].add(reg.id);
            if (d.day_type === 'half') trendMap[mo]._half++;
            else                       trendMap[mo]._full++;
        });
    });
    return trendMap;
}

function generateEnrollmentTrends() {
    const trendMap = _buildTrendMap();
    const months   = Object.keys(trendMap).sort();
    const container = document.getElementById('trendsContent');
    if (!months.length) {
        container.innerHTML = '<p class="empty-hint">No enrollment data found.</p>';
        return;
    }

    const roomHeaders = ROOMS.map(r => `<th>${r.label}</th>`).join('');
    const rows = months.map(mo => {
        const [y, m] = mo.split('-').map(Number);
        const label  = MONTH_NAMES_ADMIN[m - 1] + ' ' + y;
        const cells  = ROOMS.map(room => {
            const count = trendMap[mo][room.id]?.size || 0;
            return `<td class="report-num">${count || '—'}</td>`;
        }).join('');
        const total    = ROOMS.reduce((s, r) => s + (trendMap[mo][r.id]?.size || 0), 0);
        const fullDays = trendMap[mo]._full;
        const halfDays = trendMap[mo]._half;
        return `<tr>
            <td class="staff-date-cell">${label}</td>
            ${cells}
            <td class="report-num"><strong>${total}</strong></td>
            <td class="report-num">${fullDays || '—'}</td>
            <td class="report-num">${halfDays || '—'}</td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div class="table-wrapper report-table-wrap">
            <table class="report-table">
                <thead>
                    <tr>
                        <th>Month</th>${roomHeaders}
                        <th>Total Children</th>
                        <th>Full-Day Care Days</th>
                        <th>Half-Day Care Days</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>
        <p style="font-size:.8em;color:#888;margin-top:6px">Children = unique enrollments per room · Care Days = total confirmed day bookings</p>`;
}

function exportEnrollmentTrends() {
    const trendMap = _buildTrendMap();
    const months   = Object.keys(trendMap).sort();
    if (!months.length) { alert('No data to export.'); return; }

    const rows = months.map(mo => {
        const [y, m] = mo.split('-').map(Number);
        const row = { Month: MONTH_NAMES_ADMIN[m - 1] + ' ' + y };
        ROOMS.forEach(r => { row[r.label] = trendMap[mo][r.id]?.size || 0; });
        row['Total Children']      = ROOMS.reduce((s, r) => s + (trendMap[mo][r.id]?.size || 0), 0);
        row['Full-Day Care Days']  = trendMap[mo]._full;
        row['Half-Day Care Days']  = trendMap[mo]._half;
        return row;
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Enrollment Trends');
    XLSX.writeFile(wb, 'enrollment-trends.xlsx');
}

// ── Waitlist Demand ────────────────────────────────────────
let _wlDemandCache = [];

async function generateWaitlistReport() {
    const container = document.getElementById('waitlistContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const apps = await fetchWaitlistApplications();
        _wlDemandCache = apps;
        // Active = pending | offered | accepted
        const active = apps.filter(a => ['pending','offered','accepted'].includes(a.status));
        const demandMap = {}; // { 'YYYY-MM': { roomId: count } }
        active.forEach(a => {
            const mo   = (a.desired_start_date || '').substring(0, 7);
            if (!mo) return;
            const room = wlDeriveRoom(a) || 'tbd';
            if (!demandMap[mo]) demandMap[mo] = {};
            demandMap[mo][room] = (demandMap[mo][room] || 0) + 1;
        });

        const months = Object.keys(demandMap).sort();
        if (!months.length) {
            container.innerHTML = '<p class="empty-hint">No active waitlist applications found.</p>';
            return;
        }

        const allRooms = [...ROOMS, { id: 'tbd', label: 'TBD/Unborn' }];
        const roomHeaders = allRooms.map(r => `<th>${r.label}</th>`).join('');
        const rows = months.map(mo => {
            const [y, m] = mo.split('-').map(Number);
            const label  = MONTH_NAMES_ADMIN[m - 1] + ' ' + y;
            const cells  = allRooms.map(room => {
                const count = demandMap[mo][room.id] || 0;
                const cls   = count >= 5 ? 'staff-high' : count >= 2 ? 'staff-mid' : '';
                return `<td class="report-num ${cls}">${count || '—'}</td>`;
            }).join('');
            const total = allRooms.reduce((s, r) => s + (demandMap[mo][r.id] || 0), 0);
            return `<tr><td class="staff-date-cell">${label}</td>${cells}<td class="report-num"><strong>${total}</strong></td></tr>`;
        }).join('');

        container.innerHTML = `
            <p class="section-desc" style="margin-bottom:8px">Active applications (pending + offered + accepted) by desired start month. Higher numbers = more unmet demand.</p>
            <div class="table-wrapper report-table-wrap">
                <table class="report-table">
                    <thead>
                        <tr><th>Desired Start</th>${roomHeaders}<th>Total</th></tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    } catch (err) {
        container.innerHTML = `<p class="empty-hint">Error: ${escHtml(err.message)}</p>`;
    }
}

// ── Year-to-Date Revenue ───────────────────────────────────
function _buildYtdRevenueMap(yearKey) {
    // Returns { 'YYYY-MM': { roomId: actualRevenue, _discounts: totalDiscounted } }
    const map  = {};
    const dmap = getDiscountMap();
    allRegistrations.forEach(reg => {
        const room = ROOMS.find(r => r.id === reg.room_id);
        if (!room) return;
        const discKey = `${(reg.parent_email || '').toLowerCase()}:${(reg.child_name || '').toLowerCase()}`;
        const disc    = dmap.get(discKey) || { type: 'none', value: 0 };
        (reg.registration_dates || []).forEach(d => {
            if (d.waitlisted || !d.care_date || !d.care_date.startsWith(yearKey)) return;
            const mo       = d.care_date.substring(0, 7);
            if (!map[mo]) map[mo] = { _discounts: 0 };
            const baseRate   = d.day_type === 'half' ? (room.halfDayRate || 0) : (room.fullDayRate || 0);
            const actual     = effectiveAdminRate(baseRate, disc.type, disc.value);
            map[mo][reg.room_id] = (map[mo][reg.room_id] || 0) + actual;
            map[mo]._discounts  += Math.max(0, baseRate - actual);
        });
    });
    return map;
}

function generateYtdRevenue() {
    const year       = new Date().getFullYear();
    const revenueMap = _buildYtdRevenueMap(String(year));
    const months     = Object.keys(revenueMap).sort();
    const container  = document.getElementById('ytdContent');
    if (!months.length) {
        container.innerHTML = `<p class="empty-hint">No revenue data found for ${year}.</p>`;
        return;
    }

    const roomHeaders = ROOMS.map(r => `<th>${r.label}</th>`).join('');
    let runningTotal = 0;
    let totalDiscounts = 0;
    const rows = months.map(mo => {
        const [y, m]  = mo.split('-').map(Number);
        const label   = MONTH_NAMES_ADMIN[m - 1] + ' ' + y;
        const moTotal = ROOMS.reduce((s, r) => s + (revenueMap[mo][r.id] || 0), 0);
        const moDisc  = revenueMap[mo]._discounts || 0;
        runningTotal  += moTotal;
        totalDiscounts += moDisc;
        const cells = ROOMS.map(room =>
            `<td class="report-num report-revenue">$${(revenueMap[mo][room.id] || 0).toFixed(2)}</td>`
        ).join('');
        return `
            <tr>
                <td class="staff-date-cell">${label}</td>
                ${cells}
                <td class="report-num report-revenue"><strong>$${moTotal.toFixed(2)}</strong></td>
                <td class="report-num ytd-discount-cell">${moDisc > 0 ? `-$${moDisc.toFixed(2)}` : '—'}</td>
                <td class="report-num report-revenue">$${runningTotal.toFixed(2)}</td>
            </tr>`;
    }).join('');

    container.innerHTML = `
        <h3 class="report-month-title">${year} Year to Date — $${runningTotal.toFixed(2)} collected · <span class="ytd-discount-total">-$${totalDiscounts.toFixed(2)} discounted</span></h3>
        <div class="table-wrapper report-table-wrap">
            <table class="report-table">
                <thead>
                    <tr><th>Month</th>${roomHeaders}<th>Monthly Revenue</th><th>Discounts Given</th><th>Running Total</th></tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

function exportYtdRevenue() {
    const year       = new Date().getFullYear();
    const revenueMap = _buildYtdRevenueMap(String(year));
    const months     = Object.keys(revenueMap).sort();
    if (!months.length) { alert('No data to export.'); return; }

    let running = 0;
    const rows = months.map(mo => {
        const [y, m] = mo.split('-').map(Number);
        const row    = { Month: MONTH_NAMES_ADMIN[m - 1] + ' ' + y };
        ROOMS.forEach(r => { row[r.label] = `$${(revenueMap[mo][r.id] || 0).toFixed(2)}`; });
        const moTotal = ROOMS.reduce((s, r) => s + (revenueMap[mo][r.id] || 0), 0);
        running += moTotal;
        row['Monthly Revenue']  = `$${moTotal.toFixed(2)}`;
        row['Discounts Given']  = revenueMap[mo]._discounts > 0 ? `-$${revenueMap[mo]._discounts.toFixed(2)}` : '$0.00';
        row['Running Total']    = `$${running.toFixed(2)}`;
        return row;
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, `Revenue ${year}`);
    XLSX.writeFile(wb, `ytd-revenue-${year}.xlsx`);
}

// ============================================================
// WAITLIST MANAGEMENT (admin)
// ============================================================

// Derive room from a waitlist application record
function wlDeriveRoom(app) {
    const dobStr = app.child_dob || app.expected_due_date;
    if (!dobStr || !app.desired_start_date) return null;
    const dob   = new Date(dobStr + 'T00:00:00');
    const start = new Date(app.desired_start_date + 'T00:00:00');
    const months = (start.getFullYear() - dob.getFullYear()) * 12 +
                   (start.getMonth() - dob.getMonth());
    if (months < 12)  return 'bear';
    if (months < 24)  return 'bee';
    if (months < 36)  return 'turtle';
    return 'owl';
}

function wlRoomLabel(roomId) {
    const map = { bear: '🐻 Bear', bee: '🐝 Bee', turtle: '🐢 Turtle', owl: '🦉 Owl' };
    return map[roomId] || '—';
}

function wlStatusBadge(app) {
    const today = new Date().toISOString().split('T')[0];
    if (app.status === 'offered' && app.offer_deadline && app.offer_deadline < today) {
        return '<span class="wl-badge wl-badge-expired">Offer Expired</span>';
    }
    const map = {
        pending:  '<span class="wl-badge wl-badge-pending">Pending</span>',
        offered:  '<span class="wl-badge wl-badge-offered">Spot Offered</span>',
        accepted: '<span class="wl-badge wl-badge-accepted">Accepted</span>',
        enrolled: '<span class="wl-badge wl-badge-enrolled">Enrolled</span>',
        declined: '<span class="wl-badge wl-badge-archived">Declined</span>',
        expired:  '<span class="wl-badge wl-badge-archived">Expired</span>',
        archived: '<span class="wl-badge wl-badge-archived">Archived</span>',
    };
    return map[app.status] || `<span class="wl-badge">${escHtml(app.status)}</span>`;
}

function wlFlexLabel(f) {
    return { exact: 'Exact date', within_month: 'Within a month', within_quarter: 'Within a few months', flexible: 'Very flexible' }[f] || f;
}

function wlDaysWaiting(appliedAt) {
    const ms = Date.now() - new Date(appliedAt).getTime();
    const d  = Math.floor(ms / 86400000);
    if (d === 0) return 'today';
    if (d === 1) return '1 day ago';
    if (d < 7)   return `${d} days ago`;
    const w = Math.floor(d / 7);
    return w === 1 ? '1 week ago' : `${w} weeks ago`;
}

let _allWaitlistApps = [];
let _wlSortCol = 'start';   // 'pos'|'child'|'start'|'age'|'room'|'status'|'parent'|'waiting'
let _wlSortDir = 1;          // 1 = asc, -1 = desc

async function loadWaitlistApplications() {
    const container = document.getElementById('wlQuickListContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        _allWaitlistApps = await fetchWaitlistApplications();
        renderWaitlistAdmin();
        renderWaitlistQuickList();
    } catch (err) {
        document.getElementById('wlQuickListContent').innerHTML = `<p class="empty-hint">Error: ${escHtml(err.message)}</p>`;
    }
}

function renderWaitlistQuickList() {
    const container = document.getElementById('wlQuickListContent');
    if (!container) return;

    const statusFilter = document.getElementById('wlStatusFilter')?.value || 'active';
    const roomFilter   = document.getElementById('wlRoomFilter')?.value   || '';

    let apps = (_allWaitlistApps || []).slice();

    if (statusFilter === 'active') {
        apps = apps.filter(a => ['pending','offered','accepted'].includes(a.status));
    } else if (statusFilter === 'enrolled') {
        apps = apps.filter(a => a.status === 'enrolled');
    } else if (statusFilter === 'archived') {
        apps = apps.filter(a => ['declined','expired','archived'].includes(a.status));
    }

    if (roomFilter) {
        apps = apps.filter(a => {
            if (roomFilter === 'tbd') return !a.child_dob && !a.expected_due_date;
            return wlDeriveRoom(a) === roomFilter;
        });
    }

    // Priority sort baseline (sibling priority stays as tiebreaker for position)
    apps.sort((a, b) => {
        const sibA = a.has_sibling ? 0 : 1, sibB = b.has_sibling ? 0 : 1;
        if (sibA !== sibB) return sibA - sibB;
        return new Date(a.applied_at) - new Date(b.applied_at);
    });

    // Numbered position before user sort
    apps.forEach((a, i) => { a._pos = i + 1; });

    // User-selected sort
    apps.sort((a, b) => {
        let va, vb;
        switch (_wlSortCol) {
            case 'pos':     va = a._pos; vb = b._pos; break;
            case 'child':   va = a.child_name || ''; vb = b.child_name || ''; break;
            case 'start':   va = a.desired_start_date || ''; vb = b.desired_start_date || ''; break;
            case 'age': {
                const ageMonths = x => {
                    const dob = x.child_dob || x.expected_due_date;
                    if (!dob || !x.desired_start_date) return 9999;
                    return Math.round((new Date(x.desired_start_date+'T00:00:00') - new Date(dob+'T00:00:00')) / (1000*60*60*24*30.44));
                };
                va = ageMonths(a); vb = ageMonths(b); break;
            }
            case 'room':    va = wlDeriveRoom(a) || 'zzz'; vb = wlDeriveRoom(b) || 'zzz'; break;
            case 'status':  va = a.status || ''; vb = b.status || ''; break;
            case 'parent':  va = a.parent_name || ''; vb = b.parent_name || ''; break;
            case 'waiting': va = a.applied_at || ''; vb = b.applied_at || ''; break;
            default:        va = 0; vb = 0;
        }
        if (va < vb) return -1 * _wlSortDir;
        if (va > vb) return  1 * _wlSortDir;
        return 0;
    });

    document.getElementById('wlCount').textContent = `${apps.length} application${apps.length !== 1 ? 's' : ''}`;

    if (!apps.length) {
        container.innerHTML = '<p class="empty-hint">No applications match the current filter.</p>';
        return;
    }

    const allRooms = [...ROOMS, { id: 'tbd', label: 'TBD / Unborn' }];

    const sortArrow = col => {
        if (_wlSortCol !== col) return ' <span class="sort-arrow sort-arrow-none">⇅</span>';
        return _wlSortDir === 1 ? ' <span class="sort-arrow">▲</span>' : ' <span class="sort-arrow">▼</span>';
    };

    const rows = apps.map((a, idx) => {
        const roomId    = wlDeriveRoom(a) || 'tbd';
        const roomObj   = allRooms.find(r => r.id === roomId);
        const roomLabel = roomObj?.label || 'TBD';

        const startStr = a.desired_start_date
            ? new Date(a.desired_start_date + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
            : '—';

        let ageLabel = '—';
        const dobStr = a.child_dob || a.expected_due_date;
        if (dobStr && a.desired_start_date) {
            const months = Math.round((new Date(a.desired_start_date+'T00:00:00') - new Date(dobStr+'T00:00:00')) / (1000*60*60*24*30.44));
            if (months < 0)       ageLabel = 'Unborn';
            else if (months < 24) ageLabel = `${months} mo`;
            else                  ageLabel = `${Math.floor(months/12)} yr ${months%12} mo`;
        }

        const canOffer = ['pending','offered'].includes(a.status);

        return `<tr>
            <td class="wl-td-pos">${a._pos}</td>
            <td class="wl-td-child"><strong>${escHtml(a.child_name)}</strong>${a.has_sibling ? `<br><span class="wl-sib-tag">👨‍👩‍👧 sibling</span>` : ''}</td>
            <td class="wl-td-start">${startStr}</td>
            <td class="wl-td-age">${escHtml(ageLabel)}</td>
            <td class="wl-td-room">${escHtml(roomLabel)}</td>
            <td class="wl-td-status">${wlStatusBadge(a)}</td>
            <td class="wl-td-parent">${escHtml(a.parent_name)}<br><a href="mailto:${escHtml(a.parent_email)}" class="wl-email-link">${escHtml(a.parent_email)}</a>${a.parent_phone ? `<br><span class="wl-phone">${escHtml(a.parent_phone)}</span>` : ''}</td>
            <td class="wl-td-waiting">${wlDaysWaiting(a.applied_at)}</td>
            <td class="wl-td-actions">${canOffer ? `<button class="btn-wl-offer-quick" data-id="${a.id}" data-name="${escHtml(a.parent_name)}" data-email="${escHtml(a.parent_email)}" data-child="${escHtml(a.child_name)}">Make Offer</button>` : ''}</td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div class="table-wrapper">
            <table class="report-table wl-quick-table">
                <thead>
                    <tr>
                        <th class="wl-th" data-col="pos"   style="width:36px">#${sortArrow('pos')}</th>
                        <th class="wl-th" data-col="child" style="width:13%">Child${sortArrow('child')}</th>
                        <th class="wl-th" data-col="start" style="width:108px">Desired Start${sortArrow('start')}</th>
                        <th class="wl-th" data-col="age"   style="width:90px">Age at Start${sortArrow('age')}</th>
                        <th class="wl-th" data-col="room"  style="width:13%">Room${sortArrow('room')}</th>
                        <th class="wl-th" data-col="status" style="width:88px">Status${sortArrow('status')}</th>
                        <th class="wl-th" data-col="parent">Parent / Contact${sortArrow('parent')}</th>
                        <th class="wl-th" data-col="waiting" style="width:90px">Waiting Since${sortArrow('waiting')}</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;

    // Sort header clicks
    container.querySelectorAll('.wl-th').forEach(th => {
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (_wlSortCol === col) _wlSortDir *= -1;
            else { _wlSortCol = col; _wlSortDir = 1; }
            renderWaitlistQuickList();
        });
    });

    // Make Offer buttons
    container.querySelectorAll('.btn-wl-offer-quick').forEach(btn => {
        btn.addEventListener('click', () => {
            const modal = document.getElementById('wlOfferModal');
            modal.dataset.appId      = btn.dataset.id;
            modal.dataset.parentName = btn.dataset.name;
            modal.dataset.parentEmail= btn.dataset.email;
            modal.dataset.childName  = btn.dataset.child;
            document.getElementById('wlOfferModalDesc').textContent = `Offering a spot to ${btn.dataset.child} — parent: ${btn.dataset.name} (${btn.dataset.email})`;
            document.getElementById('wlOfferErr').textContent = '';
            document.getElementById('wlOfferSendBtn').disabled = false;
            document.getElementById('wlOfferSendBtn').textContent = 'Send & Email Parent';
            // Pre-fill global links
            fetchGlobalOfferLinks().then(g => {
                const procareEl  = document.getElementById('wlOfferProcare');
                const paperwkEl  = document.getElementById('wlOfferPaperwork');
                if (procareEl && !procareEl.value) procareEl.value = g.procareLink || '';
                if (paperwkEl && !paperwkEl.value) paperwkEl.value = (g.paperworkLinks || []).join(', ');
            }).catch(() => {});
            modal.classList.remove('hidden');
        });
    });
}

function renderWaitlistAdmin() {
    const statusFilter = document.getElementById('wlStatusFilter').value;
    const roomFilter   = document.getElementById('wlRoomFilter').value;
    const container    = document.getElementById('waitlistAdminContent');
    const today        = new Date().toISOString().split('T')[0];

    let apps = _allWaitlistApps.slice();

    // Status filter
    if (statusFilter === 'active') {
        apps = apps.filter(a => ['pending','offered','accepted'].includes(a.status));
    } else if (statusFilter === 'enrolled') {
        apps = apps.filter(a => a.status === 'enrolled');
    } else if (statusFilter === 'archived') {
        apps = apps.filter(a => ['declined','expired','archived'].includes(a.status));
    }

    // Room filter
    if (roomFilter) {
        apps = apps.filter(a => {
            if (roomFilter === 'tbd') return !a.child_dob && !a.expected_due_date;
            return wlDeriveRoom(a) === roomFilter;
        });
    }

    // Priority sort: sibling first (tier 1 vs 2), then desired_start_date, then applied_at
    apps.sort((a, b) => {
        const sibA = a.has_sibling ? 0 : 1;
        const sibB = b.has_sibling ? 0 : 1;
        if (sibA !== sibB) return sibA - sibB;
        const startA = a.desired_start_date || '';
        const startB = b.desired_start_date || '';
        if (startA !== startB) return startA < startB ? -1 : 1;
        return new Date(a.applied_at) - new Date(b.applied_at);
    });

    document.getElementById('wlCount').textContent = `${apps.length} application${apps.length !== 1 ? 's' : ''}`;

    if (!apps.length) {
        container.innerHTML = '<p class="empty-hint">No applications match the current filter.</p>';
        return;
    }

    const cards = apps.map(app => {
        const room     = wlDeriveRoom(app);
        const isUnborn = !!app.expected_due_date && !app.child_dob;
        const dobInfo  = isUnborn
            ? `Due ${app.expected_due_date}`
            : app.child_dob ? `DOB ${app.child_dob}` : '';
        const daysStr  = (app.days_of_week || '').split(',').filter(Boolean).join(', ');
        const offerExpired = app.status === 'offered' && app.offer_deadline && app.offer_deadline < today;

        const priorityBadges = [
            app.has_sibling ? '<span class="wl-pri-badge wl-sib">👨‍👩‍👧 Sibling</span>' : '',
            isUnborn        ? '<span class="wl-pri-badge wl-prenatal">👶 Prenatal</span>' : '',
            offerExpired    ? '<span class="wl-pri-badge wl-expired-warn">⚠️ Offer Expired</span>' : '',
        ].filter(Boolean).join(' ');

        // Checklist (shown once accepted)
        const checklistHtml = ['accepted','enrolled'].includes(app.status) ? `
            <div class="wl-checklist">
                <label class="wl-check-item">
                    <input type="checkbox" class="wl-paperwork" data-id="${app.id}" ${app.paperwork_received ? 'checked' : ''}>
                    Paperwork received
                </label>
                <label class="wl-check-item">
                    <input type="checkbox" class="wl-deposit" data-id="${app.id}" ${app.deposit_paid ? 'checked' : ''}>
                    Deposit paid
                </label>
                ${(app.paperwork_received && app.deposit_paid && app.status !== 'enrolled') ? `
                    <button class="btn-primary wl-action wl-enroll" data-id="${app.id}" style="margin-left:10px;">✓ Mark Enrolled</button>
                ` : ''}
            </div>` : '';

        // Action buttons
        const actionBtns = (() => {
            const id = app.id;
            if (['declined','expired','archived','enrolled'].includes(app.status)) {
                return `<button class="btn-ghost wl-action wl-unarchive" data-id="${id}">↩ Restore</button>
                        <button class="btn-danger wl-action wl-delete" data-id="${id}" data-child="${escHtml(app.child_name)}">🗑 Delete</button>`;
            }
            const offer = app.status === 'pending' || offerExpired
                ? `<button class="btn-secondary wl-action wl-offer" data-id="${id}">🎉 Offer a Spot</button>`
                : '';
            const accept = app.status === 'offered'
                ? `<button class="btn-secondary wl-action wl-accept" data-id="${id}">✓ Mark Accepted</button>`
                : '';
            const archive = `<button class="btn-ghost wl-action wl-archive" data-id="${id}">Archive ▾</button>`;
            return [offer, accept, archive].filter(Boolean).join(' ');
        })();

        // Offer details row
        const offerRow = app.status === 'offered' && app.offer_deadline ? `
            <div class="wl-offer-row">
                Spot offered ${app.offered_at ? new Date(app.offered_at).toLocaleDateString() : ''}
                · Deadline: <strong>${app.offer_deadline}</strong>
                ${app.offer_notes ? `· <em>${escHtml(app.offer_notes)}</em>` : ''}
            </div>` : '';

        return `
        <div class="wl-card" data-id="${app.id}">
            <div class="wl-card-header">
                <div class="wl-card-title">
                    <strong>${escHtml(app.child_name)}</strong>
                    ${dobInfo ? `<span class="wl-dob">${escHtml(dobInfo)}</span>` : ''}
                    ${room ? `<span class="wl-room">${wlRoomLabel(room)}</span>` : '<span class="wl-room">Room TBD</span>'}
                    ${priorityBadges}
                </div>
                <div class="wl-card-status">${wlStatusBadge(app)}</div>
            </div>
            <div class="wl-card-body">
                <div class="wl-detail-row">
                    <span class="wl-detail-label">Start:</span>
                    ${escHtml(app.desired_start_date)} <em class="wl-flex">(${wlFlexLabel(app.start_flexibility)})</em>
                </div>
                <div class="wl-detail-row">
                    <span class="wl-detail-label">Days:</span>
                    ${escHtml(daysStr)} · ${app.day_type === 'half' ? 'Half Day' : 'Full Day'}
                </div>
                <div class="wl-detail-row">
                    <span class="wl-detail-label">Parent:</span>
                    ${escHtml(app.parent_name)}
                    · <a href="mailto:${escHtml(app.parent_email)}">${escHtml(app.parent_email)}</a>
                    ${app.parent_phone ? `· ${escHtml(app.parent_phone)}` : ''}
                </div>
                ${app.has_sibling ? `<div class="wl-detail-row"><span class="wl-detail-label">Sibling:</span> ${escHtml(app.sibling_child_name || '—')} ${app.sibling_room_id ? `(${wlRoomLabel(app.sibling_room_id)})` : ''}</div>` : ''}
                ${app.notes ? `<div class="wl-detail-row"><span class="wl-detail-label">Notes:</span> <em>${escHtml(app.notes)}</em></div>` : ''}
                <div class="wl-detail-row wl-applied">Applied ${wlDaysWaiting(app.applied_at)} (${new Date(app.applied_at).toLocaleDateString()})</div>
            </div>
            ${offerRow}
            ${checklistHtml}
            <div class="wl-card-actions">${actionBtns}</div>

            <!-- Offer form (hidden by default) -->
            <div class="wl-offer-form hidden" id="wl-offer-form-${app.id}">
                <div class="wl-offer-fields">
                    <label>Offer deadline: <input type="date" class="wl-deadline-input" id="wl-deadline-${app.id}"
                        value="${new Date(Date.now() + 14*86400000).toISOString().split('T')[0]}"></label>
                    <label style="flex:1">Notes (optional): <input type="text" class="wl-notes-input" id="wl-ofnotes-${app.id}" placeholder="e.g. Bear room opening Sept 1"></label>
                </div>
                <div class="wl-offer-fields" style="margin-top:8px;">
                    <label style="flex:1">Paperwork link(s) (optional, comma-separated URLs):
                        <input type="text" class="wl-paperwork-links" id="wl-paperwk-${app.id}" placeholder="https://docs.google.com/..."></label>
                    <label style="flex:1">Procare enrollment link (optional):
                        <input type="text" class="wl-procare-link" id="wl-procare-${app.id}" placeholder="https://app.procaresoftware.com/..."></label>
                </div>
                <div class="wl-offer-fields" style="margin-top:8px;">
                    <button class="btn-primary wl-offer-send" data-id="${app.id}" data-name="${escHtml(app.parent_name)}" data-email="${escHtml(app.parent_email)}" data-child="${escHtml(app.child_name)}">🎉 Send Spot Offer</button>
                    <button class="btn-ghost wl-offer-cancel" data-id="${app.id}">Cancel</button>
                </div>
            </div>

            <!-- Archive dropdown (hidden by default) -->
            <div class="wl-archive-form hidden" id="wl-archive-form-${app.id}">
                <div class="wl-offer-fields">
                    <span>Archive reason:</span>
                    <select id="wl-archive-reason-${app.id}">
                        <option value="declined">Family declined</option>
                        <option value="no_response">No response to offer</option>
                        <option value="enrolled_elsewhere">Enrolled elsewhere</option>
                        <option value="other">Other</option>
                    </select>
                    <button class="btn-warning wl-archive-confirm" data-id="${app.id}">Archive</button>
                    <button class="btn-ghost wl-archive-cancel" data-id="${app.id}">Cancel</button>
                </div>
            </div>
        </div>`;
    }).join('');

    container.innerHTML = `<div class="wl-list">${cards}</div>`;

    // Wire up all event handlers
    container.querySelectorAll('.wl-offer').forEach(btn =>
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            const g = window._globalOfferLinks || {};
            const procareEl   = document.getElementById(`wl-procare-${id}`);
            const paperwkEl   = document.getElementById(`wl-paperwk-${id}`);
            if (procareEl && !procareEl.value)   procareEl.value   = g.procareLink   || '';
            if (paperwkEl && !paperwkEl.value)   paperwkEl.value   = (g.paperworkLinks || []).join(', ');
            document.getElementById(`wl-offer-form-${id}`)?.classList.remove('hidden');
        }));

    container.querySelectorAll('.wl-offer-cancel').forEach(btn =>
        btn.addEventListener('click', () => {
            document.getElementById(`wl-offer-form-${btn.dataset.id}`)?.classList.add('hidden');
        }));

    container.querySelectorAll('.wl-offer-send').forEach(btn =>
        btn.addEventListener('click', async () => {
            const id          = btn.dataset.id;
            const deadline    = document.getElementById(`wl-deadline-${id}`)?.value;
            const notes       = document.getElementById(`wl-ofnotes-${id}`)?.value || '';
            const parentName  = btn.dataset.name;
            const parentEmail = btn.dataset.email;
            const childName   = btn.dataset.child;
            const paperwkRaw  = document.getElementById(`wl-paperwk-${id}`)?.value || '';
            const procareLink = document.getElementById(`wl-procare-${id}`)?.value.trim() || null;
            const papeworkLinks = paperwkRaw.split(',').map(s => s.trim()).filter(Boolean);
            if (!deadline) { alert('Please set an offer deadline.'); return; }
            btn.disabled    = true;
            btn.textContent = 'Sending…';
            try {
                // Save status first
                await updateWaitlistApplication(Number(id), {
                    status:         'offered',
                    offered_at:     new Date().toISOString(),
                    offer_deadline: deadline,
                    offer_notes:    notes || null,
                });
                // Send email
                await sendWaitlistOfferEmail({ parentName, parentEmail, childName, offerDeadline: deadline, offerNotes: notes || null, papeworkLinks, procareLink });
                const app = _allWaitlistApps.find(a => a.id === Number(id));
                if (app) { app.status = 'offered'; app.offered_at = new Date().toISOString(); app.offer_deadline = deadline; app.offer_notes = notes || null; }
                renderWaitlistAdmin();
            } catch (err) {
                // If only the email failed, status was already saved — note this in the alert
                let detail = err.message;
                try { const ctx = await err.context?.json(); detail += '\n' + JSON.stringify(ctx); } catch {}
                console.error('Email error full detail:', err);
                alert('Offer saved, but email failed: ' + detail + '\n\nYou can email the parent manually at ' + parentEmail);
                const app = _allWaitlistApps.find(a => a.id === Number(id));
                if (app && app.status !== 'offered') { btn.disabled = false; btn.textContent = 'Send & Email Parent'; }
                else renderWaitlistAdmin();
            }
        }));

    container.querySelectorAll('.wl-accept').forEach(btn =>
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                const id = Number(btn.dataset.id);
                await updateWaitlistApplication(id, { status: 'accepted' });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) app.status = 'accepted';
                renderWaitlistAdmin();
            } catch (err) { alert('Error: ' + err.message); btn.disabled = false; }
        }));

    container.querySelectorAll('.wl-enroll').forEach(btn =>
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                const id = Number(btn.dataset.id);
                await updateWaitlistApplication(id, { status: 'enrolled' });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) app.status = 'enrolled';
                renderWaitlistAdmin();
            } catch (err) { alert('Error: ' + err.message); btn.disabled = false; }
        }));

    container.querySelectorAll('.wl-paperwork').forEach(cb =>
        cb.addEventListener('change', async () => {
            const id = Number(cb.dataset.id);
            try {
                await updateWaitlistApplication(id, { paperwork_received: cb.checked });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) app.paperwork_received = cb.checked;
                renderWaitlistAdmin();
            } catch (err) { alert('Error: ' + err.message); cb.checked = !cb.checked; }
        }));

    container.querySelectorAll('.wl-deposit').forEach(cb =>
        cb.addEventListener('change', async () => {
            const id = Number(cb.dataset.id);
            try {
                await updateWaitlistApplication(id, { deposit_paid: cb.checked });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) app.deposit_paid = cb.checked;
                renderWaitlistAdmin();
            } catch (err) { alert('Error: ' + err.message); cb.checked = !cb.checked; }
        }));

    container.querySelectorAll('.wl-archive').forEach(btn =>
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            document.getElementById(`wl-archive-form-${id}`)?.classList.remove('hidden');
        }));

    container.querySelectorAll('.wl-archive-cancel').forEach(btn =>
        btn.addEventListener('click', () => {
            document.getElementById(`wl-archive-form-${btn.dataset.id}`)?.classList.add('hidden');
        }));

    container.querySelectorAll('.wl-archive-confirm').forEach(btn =>
        btn.addEventListener('click', async () => {
            const id     = Number(btn.dataset.id);
            const reason = document.getElementById(`wl-archive-reason-${id}`)?.value || 'other';
            btn.disabled = true;
            try {
                await updateWaitlistApplication(id, {
                    status:         'archived',
                    archive_reason: reason,
                    archived_at:    new Date().toISOString(),
                });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) { app.status = 'archived'; app.archive_reason = reason; }
                renderWaitlistAdmin();
            } catch (err) { alert('Error: ' + err.message); btn.disabled = false; }
        }));

    container.querySelectorAll('.wl-unarchive').forEach(btn =>
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                const id = Number(btn.dataset.id);
                await updateWaitlistApplication(id, { status: 'pending', archived_at: null, archive_reason: null });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) { app.status = 'pending'; app.archived_at = null; app.archive_reason = null; }
                renderWaitlistAdmin();
            } catch (err) { alert('Error: ' + err.message); btn.disabled = false; }
        }));

    container.querySelectorAll('.wl-delete').forEach(btn =>
        btn.addEventListener('click', async () => {
            const id    = Number(btn.dataset.id);
            const child = btn.dataset.child || 'this entry';
            if (!confirm(`Permanently delete the waitlist entry for ${child}? This cannot be undone.`)) return;
            btn.disabled = true;
            try {
                await deleteWaitlistApplication(id);
                _allWaitlistApps = _allWaitlistApps.filter(a => a.id !== id);
                renderWaitlistAdmin();
            } catch (err) { alert('Error: ' + err.message); btn.disabled = false; }
        }));
}

// ============================================================
// WAITLIST PLANNING PANEL
// ============================================================
function renderWaitlistPlanning() {
    const container = document.getElementById('wlPlanContent');
    if (!container) return;

    // Show next 4 months starting from current month
    const today = new Date();
    const months = Array.from({ length: 4 }, (_, i) => {
        const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
        return { year: d.getFullYear(), month: d.getMonth(), key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`, label: MONTH_NAMES_ADMIN[d.getMonth()] + ' ' + d.getFullYear() };
    });

    // Count confirmed bookings per room per day from allRegistrations
    const dailyBookings = {}; // 'YYYY-MM-DD' → { roomId: count }
    allRegistrations.forEach(reg => {
        (reg.registration_dates || []).forEach(d => {
            if (d.waitlisted || !d.care_date) return;
            const roomId = d.room_id || reg.room_id;
            if (!dailyBookings[d.care_date]) dailyBookings[d.care_date] = {};
            dailyBookings[d.care_date][roomId] = (dailyBookings[d.care_date][roomId] || 0) + 1;
        });
    });

    // Aging-out: for each enrolled child, calculate when they graduate to next room
    // Bear → Bee at 12mo, Bee → Turtle at 24mo, Turtle → Owl at 36mo, Owl → out at 60mo
    const ageOutThresholds = { bear: 12, bee: 24, turtle: 36, owl: 60 };
    const agingOut = {}; // 'YYYY-MM' → { roomId: [childName, ...] }
    const seenChildren = new Set();
    allRegistrations.forEach(reg => {
        if (!reg.child_dob || !reg.room_id || !ageOutThresholds[reg.room_id]) return;
        const key = `${reg.child_name}:${reg.room_id}`;
        if (seenChildren.has(key)) return;
        seenChildren.add(key);
        const dob        = new Date(reg.child_dob);
        const monthsOld  = ageOutThresholds[reg.room_id];
        const graduates  = new Date(dob.getFullYear(), dob.getMonth() + monthsOld, 1);
        const gradKey    = `${graduates.getFullYear()}-${String(graduates.getMonth()+1).padStart(2,'0')}`;
        if (!agingOut[gradKey]) agingOut[gradKey] = {};
        if (!agingOut[gradKey][reg.room_id]) agingOut[gradKey][reg.room_id] = [];
        agingOut[gradKey][reg.room_id].push(reg.child_name);
    });

    // Build the planning grid
    const waitlistByRoom = {};
    (_allWaitlistApps || []).filter(a => ['pending','offered','accepted'].includes(a.status)).forEach(a => {
        const rid = a.sibling_room_id || 'tbd';
        if (!waitlistByRoom[rid]) waitlistByRoom[rid] = [];
        waitlistByRoom[rid].push(a);
    });

    const roomRows = ROOMS.filter(r => r.id !== 'summer').map(room => {
        const monthCells = months.map(({ key, label, year, month: mo }) => {
            // Count working days in month
            const daysInMonth = new Date(year, mo + 1, 0).getDate();
            let workDays = 0; const dailyCounts = [];
            for (let day = 1; day <= daysInMonth; day++) {
                const dow = new Date(year, mo, day).getDay();
                if (dow === 0 || dow === 6) continue;
                workDays++;
                const dateStr = `${key}-${String(day).padStart(2,'0')}`;
                dailyCounts.push((dailyBookings[dateStr]?.[room.id] || 0));
            }
            const avgBooked  = workDays ? dailyCounts.reduce((a,b)=>a+b,0)/workDays : 0;
            const avgOpen    = Math.max(0, room.capacity - avgBooked).toFixed(1);
            const pct        = room.capacity > 0 ? avgBooked / room.capacity : 0;
            const color      = pct >= 0.9 ? '#fff5f5' : pct >= 0.7 ? '#fffaf0' : '#f0fff4';
            const textColor  = pct >= 0.9 ? '#9b2c2c' : pct >= 0.7 ? '#b45309' : '#276749';

            // Aging-out events this month
            const outs  = (agingOut[key]?.[room.id] || []);
            const outHtml = outs.length ? `<div style="font-size:.75em;color:#667eea;margin-top:3px">→ ${outs.length} graduate${outs.length>1?'s':''} out</div>` : '';

            return `<td style="background:${color};color:${textColor};text-align:center;padding:8px 6px;font-size:.85em;white-space:nowrap">
                <strong>${avgOpen}</strong><br><span style="font-size:.78em;color:#888">avg open/day</span>${outHtml}
            </td>`;
        }).join('');

        const wl = (waitlistByRoom[room.id] || []).slice(0,5);
        const wlHtml = wl.length
            ? wl.map(a => `<div style="font-size:.8em;color:#555;padding:2px 0">${escHtml(a.child_name)} <span style="color:#aaa">(${a.desired_start_date || '?'})</span></div>`).join('')
            : '<div style="font-size:.8em;color:#aaa">No waitlist</div>';

        return `<tr>
            <td style="font-weight:600;white-space:nowrap;padding:8px 10px">${room.label}<br><span style="font-weight:400;font-size:.8em;color:#888">Cap ${room.capacity}/day</span></td>
            ${monthCells}
            <td style="padding:8px 10px;max-width:200px">${wlHtml}</td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div style="overflow-x:auto">
        <table class="report-table" style="min-width:700px">
            <thead><tr>
                <th>Room</th>
                ${months.map(m => `<th style="text-align:center">${m.label}</th>`).join('')}
                <th>Waitlisted (next up)</th>
            </tr></thead>
            <tbody>${roomRows}</tbody>
        </table></div>
        <p style="font-size:.8em;color:#888;margin-top:8px">Avg open/day based on known registrations. → Graduates = children aging out of this room that month, freeing a permanent spot.</p>`;
}

// ============================================================
// WAITLIST IMPORT
// ============================================================
async function previewWaitlistImport() {
    const fileInput = document.getElementById('wlImportFile');
    const preview   = document.getElementById('wlImportPreview');
    if (!fileInput?.files?.length) { preview.innerHTML = '<p class="import-error">Please choose a file first.</p>'; return; }

    const file = fileInput.files[0];
    let rows;
    try {
        rows = await parseUploadedFile(file);
    } catch (err) {
        preview.innerHTML = `<p class="import-error">Could not read file: ${escHtml(err.message)}</p>`;
        return;
    }

    if (!rows.length) { preview.innerHTML = '<p class="import-error">No data rows found in file.</p>'; return; }

    // Detect columns (case-insensitive fuzzy match)
    const headers  = Object.keys(rows[0]).map(h => h.trim());
    const col = (keywords) => headers.find(h => keywords.some(k => h.toLowerCase().includes(k))) || null;

    const colParent  = col(['parent name','guardian name','parent']);
    const colEmail   = col(['email','e-mail']);
    const colPhone   = col(['phone','cell','mobile']);
    const colChild   = col(['child name','student name','child first','first name']);
    const colDob     = col(['dob','birth date','birthdate','date of birth','birthday']);
    const colStart   = col(['start date','desired start','start']);
    const colDays    = col(['days requested','days of week','days','weekdays']);
    const colType    = col(['day type','full or half','half or full','type']);
    const colNotes   = col(['notes','comments','note']);

    if (!colParent || !colEmail || !colChild) {
        preview.innerHTML = `<p class="import-error">Missing required columns. Need at least: Parent Name, Email, Child Name. Detected columns: ${escHtml(headers.join(', '))}</p>`;
        return;
    }

    // Normalize rows into waitlist records
    const records = rows.map(r => {
        const parentName  = (r[colParent] || '').trim();
        const parentEmail = (r[colEmail]  || '').trim().toLowerCase();
        const parentPhone = colPhone  ? (r[colPhone]  || '').trim() : '';
        const childName   = (r[colChild]  || '').trim();
        const childDob    = colDob    ? _normDateStr(r[colDob])   : null;
        const startDate   = colStart  ? _normDateStr(r[colStart]) : null;
        const daysOfWeek  = colDays   ? (r[colDays]  || '').trim() : '';
        const dayType     = colType   ? ((r[colType] || '').toLowerCase().includes('half') ? 'half' : 'full') : 'full';
        const notes       = colNotes  ? (r[colNotes] || '').trim() : '';
        return { parentName, parentEmail, parentPhone, childName, childDob, startDate, daysOfWeek, dayType, notes };
    }).filter(r => r.parentName && r.parentEmail && r.childName);

    if (!records.length) { preview.innerHTML = '<p class="import-error">No valid rows after normalization.</p>'; return; }

    preview.innerHTML = `
        <p style="margin-bottom:8px;font-size:.9em;color:#555">${records.length} record(s) ready to import. Review below, then click <strong>Import</strong>.</p>
        <div style="overflow-x:auto;margin-bottom:12px">
        <table class="report-table" style="font-size:.82em">
            <thead><tr>
                <th>Parent</th><th>Email</th><th>Child</th><th>Child DOB</th>
                <th>Desired Start</th><th>Days</th><th>Type</th><th>Notes</th>
            </tr></thead>
            <tbody>
                ${records.map(r => `<tr>
                    <td>${escHtml(r.parentName)}</td>
                    <td>${escHtml(r.parentEmail)}</td>
                    <td>${escHtml(r.childName)}</td>
                    <td>${r.childDob || '—'}</td>
                    <td>${r.startDate || '—'}</td>
                    <td>${escHtml(r.daysOfWeek) || '—'}</td>
                    <td>${r.dayType}</td>
                    <td>${escHtml(r.notes) || '—'}</td>
                </tr>`).join('')}
            </tbody>
        </table></div>
        <button id="wlImportConfirmBtn" class="btn-primary">Import ${records.length} Record(s)</button>
        <span id="wlImportStatus" style="margin-left:12px;font-size:.88em;color:#555"></span>`;

    document.getElementById('wlImportConfirmBtn').addEventListener('click', async () => {
        const btn    = document.getElementById('wlImportConfirmBtn');
        const status = document.getElementById('wlImportStatus');
        btn.disabled = true; btn.textContent = 'Importing…';
        let imported = 0, failed = 0;
        for (const r of records) {
            try {
                await submitWaitlistApplication({
                    parent_name:          r.parentName,
                    parent_email:         r.parentEmail,
                    parent_phone:         r.parentPhone || null,
                    child_name:           r.childName,
                    child_dob:            r.childDob || null,
                    desired_start_date:   r.startDate || new Date().toISOString().split('T')[0],
                    days_of_week:         r.daysOfWeek || null,
                    day_type:             r.dayType,
                    notes:                r.notes || null,
                    status:               'pending',
                });
                imported++;
            } catch { failed++; }
        }
        status.textContent = `✓ ${imported} imported${failed ? `, ${failed} failed` : ''}`;
        btn.textContent = 'Done';
        if (imported > 0) await loadWaitlistApplications();
    });
}

function _normDateStr(val) {
    if (!val) return null;
    const s = String(val).trim();
    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // MM/DD/YYYY or M/D/YYYY
    const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`;
    // Try native parse
    const d = new Date(s);
    if (!isNaN(d)) return d.toLocaleDateString('en-CA');
    return null;
}

function setupWaitlistAdmin() {
    document.getElementById('refreshWaitlistBtn')?.addEventListener('click', loadWaitlistApplications);
    document.getElementById('wlStatusFilter')?.addEventListener('change', () => { renderWaitlistAdmin(); renderWaitlistQuickList(); });
    document.getElementById('wlRoomFilter')?.addEventListener('change', () => { renderWaitlistAdmin(); renderWaitlistQuickList(); });

    // Offer modal
    document.getElementById('wlOfferCancelBtn')?.addEventListener('click', () => document.getElementById('wlOfferModal').classList.add('hidden'));
    document.getElementById('wlOfferModal')?.addEventListener('click', e => { if (e.target === document.getElementById('wlOfferModal')) document.getElementById('wlOfferModal').classList.add('hidden'); });
    document.getElementById('wlOfferSendBtn')?.addEventListener('click', async () => {
        const modal     = document.getElementById('wlOfferModal');
        const id        = Number(modal.dataset.appId);
        const deadline  = document.getElementById('wlOfferDeadline').value;
        const notes     = document.getElementById('wlOfferNotes').value || '';
        const procareLink   = document.getElementById('wlOfferProcare').value.trim() || null;
        const paperwkRaw    = document.getElementById('wlOfferPaperwork').value || '';
        const papeworkLinks = paperwkRaw.split(',').map(s => s.trim()).filter(Boolean);
        const parentName    = modal.dataset.parentName;
        const parentEmail   = modal.dataset.parentEmail;
        const childName     = modal.dataset.childName;
        const errEl = document.getElementById('wlOfferErr');
        if (!deadline) { errEl.textContent = 'Please set an offer deadline.'; return; }
        const btn = document.getElementById('wlOfferSendBtn');
        btn.disabled = true; btn.textContent = 'Sending…'; errEl.textContent = '';
        try {
            await updateWaitlistApplication(id, { status: 'offered', offered_at: new Date().toISOString(), offer_deadline: deadline, offer_notes: notes || null });
            await sendWaitlistOfferEmail({ parentName, parentEmail, childName, offerDeadline: deadline, offerNotes: notes || null, papeworkLinks, procareLink });
            const app = _allWaitlistApps.find(a => a.id === id);
            if (app) { app.status = 'offered'; app.offered_at = new Date().toISOString(); app.offer_deadline = deadline; app.offer_notes = notes || null; }
            modal.classList.add('hidden');
            document.getElementById('wlOfferDeadline').value = '';
            document.getElementById('wlOfferNotes').value = '';
            renderWaitlistQuickList();
            renderWaitlistAdmin();
        } catch (err) {
            errEl.textContent = 'Offer saved, but email failed: ' + err.message + '. Email parent manually at ' + parentEmail;
            btn.disabled = false; btn.textContent = 'Send & Email Parent';
            const app = _allWaitlistApps.find(a => a.id === id);
            if (app) { app.status = 'offered'; renderWaitlistQuickList(); renderWaitlistAdmin(); }
        }
    });
    document.getElementById('addToWaitlistBtn')?.addEventListener('click', _openAdminWlModal);
    document.getElementById('generateWaitlistBtn')?.addEventListener('click', generateWaitlistReport);
    document.getElementById('generateWlPlanBtn')?.addEventListener('click', renderWaitlistPlanning);

    // Waitlist import
    document.getElementById('wlImportParseBtn')?.addEventListener('click', previewWaitlistImport);

    // Modal controls
    document.getElementById('adminWlCancelBtn')?.addEventListener('click', _closeAdminWlModal);
    document.getElementById('adminWlSubmitBtn')?.addEventListener('click', _submitAdminWlEntry);
    document.getElementById('adminWlOverlay')?.addEventListener('click', e => {
        if (e.target === document.getElementById('adminWlOverlay')) _closeAdminWlModal();
    });
    document.getElementById('adminWlIsUnborn')?.addEventListener('change', e => {
        document.getElementById('adminWlDobRow').classList.toggle('hidden',  e.target.checked);
        document.getElementById('adminWlDueRow').classList.toggle('hidden', !e.target.checked);
    });
    document.getElementById('adminWlHasSibling')?.addEventListener('change', e => {
        document.getElementById('adminWlSibRow').classList.toggle('hidden', !e.target.checked);
    });
}

function _openAdminWlModal() {
    document.getElementById('adminWlForm').reset();
    document.getElementById('adminWlDobRow').classList.remove('hidden');
    document.getElementById('adminWlDueRow').classList.add('hidden');
    document.getElementById('adminWlSibRow').classList.add('hidden');
    document.getElementById('adminWlErr').textContent = '';
    document.getElementById('adminWlSubmitBtn').disabled = false;
    document.getElementById('adminWlSubmitBtn').textContent = 'Add to Waitlist';
    document.getElementById('adminWlOverlay').classList.remove('hidden');
    document.getElementById('adminWlParentName').focus();
}

function _closeAdminWlModal() {
    document.getElementById('adminWlOverlay').classList.add('hidden');
}

async function _submitAdminWlEntry() {
    const err = document.getElementById('adminWlErr');
    err.textContent = '';

    const unborn   = document.getElementById('adminWlIsUnborn').checked;
    const hasSib   = document.getElementById('adminWlHasSibling').checked;
    const days     = [...document.querySelectorAll('#adminWlForm .adminWlDay:checked')].map(c => c.value);
    const dayType  = document.querySelector('#adminWlForm input[name="adminWlDayType"]:checked')?.value || 'full';

    const payload = {
        parent_name:        document.getElementById('adminWlParentName').value.trim(),
        parent_email:       document.getElementById('adminWlParentEmail').value.trim(),
        parent_phone:       document.getElementById('adminWlParentPhone').value.trim() || null,
        child_name:         document.getElementById('adminWlChildName').value.trim(),
        child_dob:          !unborn ? (document.getElementById('adminWlDob').value || null) : null,
        expected_due_date:  unborn  ? (document.getElementById('adminWlDueDate').value || null) : null,
        desired_start_date: document.getElementById('adminWlStartDate').value,
        start_flexibility:  document.getElementById('adminWlFlexibility').value,
        days_of_week:       days.length ? days.join(', ') : null,
        day_type:           dayType,
        has_sibling:        hasSib,
        sibling_child_name: hasSib ? (document.getElementById('adminWlSibName').value.trim() || null) : null,
        sibling_room_id:    hasSib ? (document.getElementById('adminWlSibRoom').value || null) : null,
        notes:              document.getElementById('adminWlNotes').value.trim() || null,
        status:             'pending',
    };

    if (!payload.parent_name || !payload.parent_email || !payload.child_name || !payload.desired_start_date) {
        err.textContent = 'Please fill in the required fields: parent name, email, child name, and desired start date.';
        return;
    }

    const btn = document.getElementById('adminWlSubmitBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        await submitWaitlistApplication(payload);
        _closeAdminWlModal();
        await loadWaitlistApplications();
    } catch (e) {
        err.textContent = 'Error: ' + e.message;
        btn.disabled = false; btn.textContent = 'Add to Waitlist';
    }
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
