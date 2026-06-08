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

function renderRoomSelect(staffId, roomMap, eventsMap) {
    const evs = eventsMap.get(staffId) || [];
    const hasEvents = evs.length > 0;
    const distinctRooms = [...new Set(evs.map(e => e.room_id).filter(Boolean))];
    // If the staff member clocked into more than one room today, editing a single
    // room here would silently overwrite the others. Show a read-only label instead.
    if (distinctRooms.length > 1) {
        return `<span class="room-today-multi" title="Multiple rooms today — edit individual clock events to change">${escHtml(roomMap.get(staffId) || '—')}</span>`;
    }
    const currentRoomId = distinctRooms[0] || '';
    const options = ROOMS.map(r =>
        `<option value="${r.id}"${currentRoomId === r.id ? ' selected' : ''}>${r.label}</option>`
    ).join('');
    return `<select class="room-today-select" data-staff-id="${staffId}" data-prev-value="${currentRoomId}" ${hasEvents ? '' : 'disabled'}>
        <option value="">—</option>
        ${options}
    </select>`;
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

        // Determine which room(s) each staff member clocked into today
        const roomMap = new Map(); // staff_id -> display string
        eventsMap.forEach((evs, staffId) => {
            const rooms = [...new Set(evs.map(e => e.room_id).filter(Boolean))];
            roomMap.set(staffId, rooms.map(id => ROOMS.find(r => r.id === id)?.label || id).join(', ') || '—');
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
                        <th>Room Today</th>
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
                                <td>${renderRoomSelect(s.id, roomMap, eventsMap)}</td>
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

        // Room Today dropdown — update all clock events for this staff+date
        container.querySelectorAll('.room-today-select').forEach(sel => {
            sel.addEventListener('change', async () => {
                if (currentAdminRole !== 'full') {
                    alert('You do not have permission to update room assignments.');
                    sel.value = sel.dataset.prevValue ?? '';
                    return;
                }
                const sid  = sel.dataset.staffId;
                const prev = sel.dataset.prevValue ?? '';
                sel.dataset.prevValue = sel.value;
                try {
                    await updateClockEventsRoom(sid, date, sel.value || null);
                } catch (err) {
                    alert('Failed to update room: ' + err.message);
                    sel.value = prev;
                    sel.dataset.prevValue = prev;
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
