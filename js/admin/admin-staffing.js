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
let _staffPhotoUrlCache = new Map(); // profile_photo_path -> signed URL, for the roster table
// A photo replaced/removed in the edit form, deleted only once the save
// succeeds (see the identical reasoning in admin-families.js).
let _sfPhotoToDelete = null;
let _sfPendingPhotoPath = null; // uploaded-but-unsaved path for the currently open form

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
        const photoPaths = allStaffData.map(s => s.profile_photo_path).filter(Boolean);
        _staffPhotoUrlCache = photoPaths.length
            ? await fetchStaffProfilePhotoUrls(photoPaths).catch(() => new Map())
            : new Map();
        renderStaffList(allStaffData);
    } catch (err) {
        container.innerHTML = `<p class="import-error">Failed to load staff: ${escHtml(err.message)}</p>`;
    }
}

// The email is flagged, the mobile is not: one blocks the move to real
// accounts, the other is just convenient. Flagging both equally would make the
// blocking one easy to miss.
function _srContactCell(s) {
    const email = (s.email || '').trim();
    const phone = (s.phone || '').trim();
    const rows  = [];
    // Only flag it on active staff. Someone deactivated has no sign-in to lose,
    // and marking them red makes the banner's count disagree with the table.
    rows.push(email
        ? `<span class="sr-contact-ok" title="${escHtml(email)}">${escHtml(email)}</span>`
        : (s.active ? `<span class="sr-contact-missing">No email — can't sign in</span>`
                    : `<span class="sr-contact-ok">—</span>`));
    if (phone) rows.push(`<span class="sr-contact-ok">${escHtml(phone)}</span>`);
    return rows.join('<br>');
}

function renderStaffList(staff) {
    const container = document.getElementById('staffRosterContent');
    if (!staff.length) {
        container.innerHTML = '<p class="empty-hint">No staff members found. Click "+ Add Staff Member" to get started.</p>';
        return;
    }
    // Staff are moving from PINs to real sign-in accounts, and the address is
    // the identity — so a missing email is a person who cannot be migrated.
    // Showing the count turns "collect the emails" into a list she can work
    // down rather than a chore with no visible end.
    const needContact = staff.filter(s => s.active && !(s.email || '').trim()).length;
    const contactBanner = needContact ? `
        <div class="staff-contact-gap">
            <strong>${needContact} active staff ${needContact === 1 ? 'has' : 'have'} no email address on file.</strong>
            Staff are moving to their own sign-in instead of a shared 4-digit PIN,
            and the email address is what they sign in with — anyone without one
            can't be moved over. Add them with <em>Edit</em>; the mobile number is
            optional but useful for reaching people.
        </div>` : '';

    container.innerHTML = `
        ${contactBanner}
        <div class="table-wrapper">
        <table class="report-table staff-roster-table">
            <thead>
                <tr>
                    <th class="sr-col-photo"></th>
                    <th class="sr-col-name">Name</th>
                    <th class="sr-col-role">Role</th>
                    <th class="sr-col-room">Room</th>
                    <th class="sr-col-pay">Pay</th>
                    <th class="sr-col-pin">PIN</th>
                    <th class="sr-col-contact">Contact</th>
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
                    const photoUrl = s.profile_photo_path ? _staffPhotoUrlCache.get(s.profile_photo_path) : null;
                    return `
                        <tr class="${s.active ? '' : 'staff-inactive-row'}" data-staff-id="${s.id}">
                            <td>${photoUrl
                                ? `<img src="${escHtml(photoUrl)}" alt="" class="roster-photo-thumb">`
                                : '<span class="roster-photo-thumb roster-photo-thumb-empty" aria-hidden="true"></span>'}</td>
                            <td><strong>${escHtml(s.name)}</strong></td>
                            <td>${escHtml(s.role || '—')}</td>
                            <td>${escHtml(roomLabel)}</td>
                            <td>${payDisplay}</td>
                            <td><code>${pinDisplay}</code></td>
                            <td class="sr-contact-cell">${_srContactCell(s)}</td>
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
    _sfPhotoToDelete = null;
    _sfPendingPhotoPath = staff?.profile_photo_path || null;
    _renderStaffFormPhoto(staff?.profile_photo_path
        ? _staffPhotoUrlCache.get(staff.profile_photo_path) : null);
    document.getElementById('staffFormTitle').textContent = staff ? 'Edit Staff Member' : 'Add Staff Member';
    document.getElementById('sfName').value      = staff?.name || '';
    document.getElementById('sfEmail').value     = staff?.email || '';
    document.getElementById('sfPhone').value     = staff?.phone || '';
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

// Repaints the staff form's photo cell and (re)binds its upload/remove
// controls. Mirrors _fmRepaintPhoto() in admin-families.js — the storage
// delete for a replaced/removed photo is deferred to save-success, so
// cancelling the form never orphans a path the DB still references.
function _renderStaffFormPhoto(photoUrl) {
    const wrap = document.getElementById('sfPhotoWrap');
    if (!wrap) return;
    wrap.innerHTML = `
        ${photoUrl ? `<img src="${escHtml(photoUrl)}" alt="" class="fmc-photo-img">` : '<span class="fmc-photo-empty">No photo</span>'}
        <input type="file" accept="image/jpeg,image/png,image/webp" class="fmc-photo-file" id="sfPhotoFile" title="Upload a profile picture">
        ${_sfPendingPhotoPath ? '<button type="button" class="fmc-photo-remove btn-secondary btn-sm" id="sfPhotoRemove" title="Remove photo">✕</button>' : ''}
    `;
    document.getElementById('sfPhotoFile')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        try {
            const ext = (file.name.split('.').pop() || 'jpg').replace(/[^a-zA-Z0-9]/g, '') || 'jpg';
            const filename = `${editingStaffId || 'new'}-${Date.now()}.${ext}`;
            const oldPath = _sfPendingPhotoPath;
            const newPath = await uploadStaffProfilePhoto(file, filename);
            _sfPendingPhotoPath = newPath;
            _staffPhotoUrlCache.set(newPath, URL.createObjectURL(file));
            if (oldPath && oldPath !== newPath) _sfPhotoToDelete = oldPath;
            _renderStaffFormPhoto(_staffPhotoUrlCache.get(newPath));
        } catch (err) {
            alert('Photo upload failed: ' + err.message);
        }
    });
    document.getElementById('sfPhotoRemove')?.addEventListener('click', () => {
        if (_sfPendingPhotoPath) _sfPhotoToDelete = _sfPendingPhotoPath;
        _sfPendingPhotoPath = null;
        _renderStaffFormPhoto(null);
    });
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
    // Discard — nothing was actually deleted from storage yet, and an
    // uploaded-but-unsaved photo (if any) is simply left orphaned in storage,
    // same tradeoff as admin-families.js.
    _sfPhotoToDelete = null;
    _sfPendingPhotoPath = null;
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

    // This address becomes their sign-in identity once staff move to real
    // accounts, so a typo here is a login that never works. The field is
    // type=email but it sits outside a <form>, so nothing validates it for us.
    const emailVal = document.getElementById('sfEmail').value.trim();
    if (emailVal && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailVal)) {
        alert('That email address does not look right.\n\nIt becomes their sign-in, so it needs to be exact.');
        return;
    }

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
    // Captured before closeStaffForm() clears them.
    const photoToDelete  = _sfPhotoToDelete;
    const pendingPhotoPath = _sfPendingPhotoPath;

    try {
        const returnedId = await upsertStaffMember({
            id:              savingId,
            name,
            email:           document.getElementById('sfEmail').value.trim() || null,
            phone:           document.getElementById('sfPhone').value.trim() || null,
            role:            document.getElementById('sfRole').value.trim(),
            payType,
            hourlyRate:      parseFloat(document.getElementById('sfRate').value) || 0,
            salaryBiweekly:  parseFloat(document.getElementById('sfSalary').value) || 0,
            roomId:          document.getElementById('sfRoom').value || null,
            hireDate:        document.getElementById('sfHireDate').value || null,
            staffPin:        pinVal || null,
            ptoStartingBalance: parseFloat(document.getElementById('sfPtoStartingBalance').value) || 0,
            profilePhotoPath: pendingPhotoPath,
        });

        // Only now, with the DB row saved successfully, is it safe to drop a
        // replaced/removed photo object (same reasoning as admin-families.js).
        if (photoToDelete) deleteStaffProfilePhoto(photoToDelete).catch(() => {});

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
        // staff_email_unique. Two people on one address would map two staff
        // onto a single account at the auth cutover, so it's blocked at entry —
        // but "duplicate key value violates unique constraint" means nothing to
        // the person typing it.
        const msg = /staff_email_unique|duplicate key/i.test(err.message || '')
            ? `Another staff member already uses ${document.getElementById('sfEmail').value.trim()}.\n\n`
              + 'Each person needs their own address — it becomes their sign-in.'
            : 'Save failed: ' + err.message;
        alert(msg);
        if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Save'; }
    }
}

// ============================================================

// (Log Hours section removed — daily hour editing is now in the unified Payroll section)

// ============================================================
