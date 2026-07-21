// ============================================================
// MODULE: Admin Staffing (staff roster, ratios, hours entry)
// Sections: Staff Ratios Settings, Staff Roster, Log Hours
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
                ${getSortedRooms().map(room => `
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

// STAFF ROSTER
// ============================================================
let allStaffData       = [];
let showInactiveStaff  = false;
let editingStaffId     = null;
let staffAvailability  = {};   // { staffId: { days: [...], maxHours: 40 } }

function setupStaffRoster() {
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
        getSortedRooms().forEach(r => {
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
                    const pinDisplay = s.has_staff_pin ? '●●●●' : '—';
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
    document.getElementById('sfEmail').value     = staff?.email || '';
    document.getElementById('sfRole').value      = staff?.role || '';
    document.getElementById('sfRoom').value      = staff?.room_id || '';
    document.getElementById('sfHireDate').value  = staff?.hire_date || '';
    document.getElementById('sfPtoStartingBalance').value = staff?.pto_starting_balance || '';
    const pinEl = document.getElementById('sfPin');
    pinEl.value       = '';
    pinEl.placeholder = 'Set 4-digit PIN';

    const payType = staff?.pay_type || 'hourly';
    document.getElementById('sfPayType').value   = payType;
    document.getElementById('sfRate').value      = staff?.hourly_rate || '';
    document.getElementById('sfSalary').value    = staff?.salary_biweekly || '';
    _togglePayFields(payType);

    // Availability
    const avail = staff ? (staffAvailability[staff.id] || {}) : {};
    // Build dayPeriods — support old format (days + periods) for backward compat
    let dayPeriods = avail.dayPeriods;
    if (!dayPeriods) {
        const days    = avail.days    || ['Mon','Tue','Wed','Thu','Fri'];
        const periods = avail.periods || ['am','pm'];
        dayPeriods = {};
        days.forEach(d => { dayPeriods[d] = [...periods]; });
    }
    document.querySelectorAll('.sfDayPeriod').forEach(cb => {
        const day    = cb.dataset.day;
        const period = cb.dataset.period;
        cb.checked = !!(dayPeriods[day] && dayPeriods[day].includes(period));
    });
    document.getElementById('sfMaxHours').value = avail.maxHours != null ? avail.maxHours : 40;
    document.getElementById('sfMaxDays').value  = avail.maxDays  != null ? avail.maxDays  : 5;
    const excl = avail.excluded_rooms || [];
    document.querySelectorAll('.sfExcludeRoom').forEach(cb => {
        cb.checked = excl.includes(cb.dataset.roomId);
    });

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
    // Reset the Save button — the success path closes the form without re-enabling
    // it, so without this it would stay disabled ("Saving…") on the next open.
    const saveBtn = document.getElementById('saveStaffBtn');
    if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
}

async function onSaveStaffMember() {
    const name = document.getElementById('sfName').value.trim();
    if (!name) { alert('Name is required.'); return; }

    const pinVal = document.getElementById('sfPin').value.trim();
    if (pinVal && (!/^\d{4}$/.test(pinVal))) { alert('PIN must be exactly 4 digits.'); return; }

    const saveBtn = document.getElementById('saveStaffBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Saving…'; }

    const payType = document.getElementById('sfPayType').value;

    // Capture availability before closing the form
    const dayPeriods = {};
    document.querySelectorAll('.sfDayPeriod').forEach(cb => {
        if (cb.checked) {
            const day    = cb.dataset.day;
            const period = cb.dataset.period;
            if (!dayPeriods[day]) dayPeriods[day] = [];
            dayPeriods[day].push(period);
        }
    });
    const maxHours = parseFloat(document.getElementById('sfMaxHours').value) || 40;
    const maxDays  = parseInt(document.getElementById('sfMaxDays').value, 10) || 5;
    const excluded_rooms = [];
    document.querySelectorAll('.sfExcludeRoom').forEach(cb => {
        if (cb.checked) excluded_rooms.push(cb.dataset.roomId);
    });
    const savingId     = editingStaffId;

    try {
        const returnedId = await upsertStaffMember({
            id:              savingId,
            name,
            email:           document.getElementById('sfEmail').value.trim() || null,
            role:            document.getElementById('sfRole').value.trim(),
            payType,
            hourlyRate:      parseFloat(document.getElementById('sfRate').value) || 0,
            salaryBiweekly:  parseFloat(document.getElementById('sfSalary').value) || 0,
            roomId:          document.getElementById('sfRoom').value || null,
            hireDate:        document.getElementById('sfHireDate').value || null,
            staffPin:        pinVal || null,
            ptoStartingBalance: parseFloat(document.getElementById('sfPtoStartingBalance').value) || 0,
        });

        // Close immediately — don't make the user wait for the list to reload
        closeStaffForm();

        // Save availability and refresh the list in the background
        const staffId = savingId || returnedId;
        if (staffId) {
            if (typeof staffAvailability !== 'object' || Array.isArray(staffAvailability) || staffAvailability === null) {
                staffAvailability = {};
            }
            staffAvailability[staffId] = { dayPeriods, maxHours, maxDays, excluded_rooms };
            saveStaffAvailability(staffAvailability).catch(err => {
                alert('Staff details saved but availability could not be saved: ' + err.message);
            });
        }
        loadStaffList();
    } catch (err) {
        alert('Save failed: ' + err.message);
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    }
}

// ============================================================

// (Log Hours section removed — daily hour editing is now in the unified Payroll section)

// ============================================================
