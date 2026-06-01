// ============================================================
// MODULE: Admin Calendar (registration management tab)
// Sections: Load Registrations, Table Render, Edit Days Modal,
//           Capacity Overview, Room Capacity Calendar Modal,
//           Registration Window Override, Filters, Export
// ============================================================

// ── Push notification helper (non-blocking, best-effort) ────────────────────
async function _sendSchedulePush(parentEmail, childName, title, body) {
    try {
        const session = await getAdminSession();
        if (!session) return;
        await fetch('/send-push', {
            method:  'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${session.access_token}`,
            },
            body: JSON.stringify({ parent_email: parentEmail, title, body }),
        });
    } catch (err) {
        console.warn('Schedule push notification failed:', err);
    }
}

// LOAD REGISTRATIONS
// ============================================================
async function loadRegistrations() {
    document.getElementById('regTableBody').innerHTML =
        '<tr><td colspan="12" class="loading-cell">Loading…</td></tr>';
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
        tbody.innerHTML = '<tr><td colspan="12" class="loading-cell">No registrations found.</td></tr>';
        return;
    }

    tbody.innerHTML = data.map(reg => {
        const room  = ROOMS.find(r => r.id === reg.room_id) || { label: reg.room_id };
        const dates = (reg.registration_dates || [])
            .sort((a, b) => a.care_date.localeCompare(b.care_date));

        const submittedByLabel = {
            parent1: 'Parent 1',
            parent2: 'Parent 2',
            admin:   'Admin',
        }[reg.submitted_by] || (reg.submitted_by || '—');

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
                <td class="submitted-by-cell">${escHtml(submittedByLabel)}</td>
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
                    <button class="btn-secondary btn-edit-bill" data-id="${reg.id}" title="Edit Bill">&#128178; Bill</button>
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
                await logAdminAction('delete', 'registration', id, { child_name: reg?.child_name, parent_name: reg?.parent_name });
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

    tbody.querySelectorAll('.btn-edit-bill').forEach(btn => {
        btn.addEventListener('click', e => {
            const id  = e.currentTarget.getAttribute('data-id');
            const reg = allRegistrations.find(r => String(r.id) === id);
            if (reg) openEditBillModal(reg);
        });
    });
}

// ============================================================
// EDIT DAYS MODAL
// ============================================================
let editDaysReg        = null;
let _editDaysPickDate  = null;
let _calViewYear   = null;
let _calViewMonth  = null; // 0-indexed

function openEditDaysModal(reg) {
    editDaysReg = reg;
    _editDaysPickDate = null;
    document.getElementById('editDaysTitle').textContent =
        `Edit Days — ${reg.child_name}`;
    document.getElementById('editDaysPicker').style.display = 'none';
    document.getElementById('editDaysError').textContent = '';

    // Initialize calendar to the month of the first care date, or current month
    const firstDate = (reg.registration_dates || [])
        .slice().sort((a, b) => a.care_date.localeCompare(b.care_date))[0];
    const seed = firstDate ? new Date(firstDate.care_date + 'T12:00:00') : new Date();
    _calViewYear  = seed.getFullYear();
    _calViewMonth = seed.getMonth();

    // Infant (Bear room) recurring days reminder note
    const noteEl  = document.getElementById('editDaysRecurringNote');
    noteEl.style.display = 'none';
    noteEl.textContent   = '';
    const bearRoom = ROOMS.find(r => r.ageMaxMonths != null && r.ageMaxMonths <= 12);
    const isInfant = bearRoom && reg.room_id === bearRoom.id;
    if (isInfant) {
        fetchStudentRecurringDays(reg.parent_email, reg.child_name).then(recurDays => {
            if (recurDays) {
                noteEl.textContent = `\uD83D\uDD01 Recurring schedule: ${recurDays.replace(/,/g, ', ')}`;
            } else {
                noteEl.textContent = '\u2139\uFE0F No recurring days set for this infant — set them in Families';
            }
            noteEl.style.display = 'block';
        }).catch(() => {});
    }

    renderEditCalGrid();
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
            const feeTag   = d.change_fee > 0 ? ` <span style="font-size:.75em;padding:1px 5px;background:#fef3c7;border:1px solid #fbbf24;border-radius:3px;color:#92400e">+$${Number(d.change_fee).toFixed(0)} fee</span>` : '';
            return `<div style="display:flex;justify-content:space-between;align-items:center;padding:6px 8px;background:#f8f9ff;border-radius:8px;font-size:.9em">
                <span>${label} — <strong>${typeTag}</strong>${wlTag}${feeTag}</span>
                <button class="btn-delete edit-days-remove-btn" data-date-id="${d.id}" style="padding:3px 10px;font-size:.82em">Remove</button>
            </div>`;
        }).join('')}
    </div>`;

    body.querySelectorAll('.edit-days-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const dateId = btn.dataset.dateId;
            btn.disabled = true;
            try {
                const removedDate = editDaysReg.registration_dates.find(d => String(d.id) === String(dateId));
                await deleteRegistrationDate(dateId);
                if (removedDate) {
                    await logAdminAction('remove_date', 'registration', String(editDaysReg.id), {
                        child_name:   editDaysReg.child_name,
                        parent_email: editDaysReg.parent_email,
                        care_date:    removedDate.care_date,
                        day_type:     removedDate.day_type,
                    });
                }
                // Update local state
                editDaysReg.registration_dates = editDaysReg.registration_dates.filter(
                    d => String(d.id) !== String(dateId)
                );
                allRegistrations = allRegistrations.map(r =>
                    r.id === editDaysReg.id ? editDaysReg : r
                );
                renderEditDaysList();
                renderTable(allRegistrations);
                // Notify parent (non-blocking)
                if (removedDate) {
                    const dateLabel = friendlyShort(removedDate.care_date);
                    _sendSchedulePush(
                        editDaysReg.parent_email,
                        editDaysReg.child_name,
                        'Schedule Update — Timothy Lutheran MDO',
                        `${editDaysReg.child_name}'s care day on ${dateLabel} has been removed from your schedule.`
                    );
                }
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

document.getElementById('editDaysCalPrev')?.addEventListener('click', () => {
    _calViewMonth--;
    if (_calViewMonth < 0) { _calViewMonth = 11; _calViewYear--; }
    _editDaysPickDate = null;
    document.getElementById('editDaysPicker').style.display = 'none';
    renderEditCalGrid();
});
document.getElementById('editDaysCalNext')?.addEventListener('click', () => {
    _calViewMonth++;
    if (_calViewMonth > 11) { _calViewMonth = 0; _calViewYear++; }
    _editDaysPickDate = null;
    document.getElementById('editDaysPicker').style.display = 'none';
    renderEditCalGrid();
});
document.getElementById('editDaysPickerFull')?.addEventListener('click',     () => _editDaysPickSelect('full', false));
document.getElementById('editDaysPickerHalf')?.addEventListener('click',     () => _editDaysPickSelect('half', false));
document.getElementById('editDaysPickerWaitlist')?.addEventListener('click', () => _editDaysPickSelect('full', true));
document.getElementById('editDaysPickerCancel')?.addEventListener('click',   () => {
    _editDaysPickDate = null;
    document.getElementById('editDaysPicker').style.display = 'none';
});

function renderEditCalGrid() {
    const grid  = document.getElementById('editDaysCalGrid');
    const label = document.getElementById('editDaysCalLabel');
    if (!grid || !label) return;

    const DAYS_SHORT = ['Su', 'Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa'];
    const MONTHS     = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
    label.textContent = `${MONTHS[_calViewMonth]} ${_calViewYear}`;

    // Build a set of existing care dates for fast lookup
    const existingMap = {}; // care_date -> registration_date obj
    (editDaysReg?.registration_dates || []).forEach(d => { existingMap[d.care_date] = d; });

    // First day of month and total days
    const firstDow = new Date(_calViewYear, _calViewMonth, 1).getDay(); // 0=Sun
    const daysInMonth = new Date(_calViewYear, _calViewMonth + 1, 0).getDate();

    let html = DAYS_SHORT.map(d => `<div class="cal-day-hdr">${d}</div>`).join('');

    // Blank cells before the 1st
    for (let i = 0; i < firstDow; i++) {
        html += '<div class="cal-day other-month"></div>';
    }

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${_calViewYear}-${String(_calViewMonth + 1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
        const dow = new Date(_calViewYear, _calViewMonth, day).getDay();
        const isWeekend = dow === 0 || dow === 6;
        const existing  = existingMap[dateStr];
        let cls = 'cal-day';
        if (isWeekend) {
            cls += ' weekend';
        } else if (existing) {
            cls += existing.waitlisted ? ' sel-waitlist' : (existing.day_type === 'half' ? ' sel-half' : ' sel-full');
        }
        const title = existing
            ? `${existing.day_type === 'half' ? 'Half Day' : 'Full Day'}${existing.waitlisted ? ' (Waitlisted)' : ''} — click to remove`
            : (isWeekend ? '' : 'Click to add');
        html += `<div class="${cls}" data-date="${dateStr}" title="${title}">${day}</div>`;
    }

    // Fill trailing cells to complete last week row
    const totalCells = firstDow + daysInMonth;
    const remainder  = totalCells % 7;
    if (remainder > 0) {
        for (let i = remainder; i < 7; i++) html += '<div class="cal-day other-month"></div>';
    }

    grid.innerHTML = html;

    grid.querySelectorAll('.cal-day:not(.other-month):not(.weekend)').forEach(cell => {
        cell.addEventListener('click', () => _handleCalDayClick(cell.dataset.date));
    });
}

async function _handleCalDayClick(dateStr) {
    if (!editDaysReg) return;
    const errEl    = document.getElementById('editDaysError');
    errEl.textContent = '';

    const existing = (editDaysReg.registration_dates || []).find(d => d.care_date === dateStr);

    if (existing) {
        // Remove
        if (!confirm(`Remove ${friendlyShort(dateStr)} from this registration?`)) return;
        try {
            const removedDate = existing;
            await deleteRegistrationDate(existing.id);
            await logAdminAction('remove_date', 'registration', String(editDaysReg.id), {
                child_name:   editDaysReg.child_name,
                parent_email: editDaysReg.parent_email,
                care_date:    removedDate.care_date,
                day_type:     removedDate.day_type,
            });
            editDaysReg.registration_dates = editDaysReg.registration_dates.filter(d => d.id !== existing.id);
            allRegistrations = allRegistrations.map(r => r.id === editDaysReg.id ? editDaysReg : r);
            renderEditCalGrid();
            renderEditDaysList();
            renderTable(allRegistrations);
            _sendSchedulePush(
                editDaysReg.parent_email, editDaysReg.child_name,
                'Schedule Update — Timothy Lutheran MDO',
                `${editDaysReg.child_name}'s care day on ${friendlyShort(removedDate.care_date)} has been removed.`
            );
        } catch (err) {
            errEl.textContent = 'Remove failed: ' + err.message;
        }
    } else {
        // Show inline picker
        _editDaysPickDate = dateStr;
        document.getElementById('editDaysPickerDate').textContent = friendlyShort(dateStr);
        document.getElementById('editDaysPicker').style.display = '';
        errEl.textContent = '';
    }
}

async function _editDaysPickSelect(dayType, waitlist) {
    if (!_editDaysPickDate || !editDaysReg) return;
    const dateStr = _editDaysPickDate;
    _editDaysPickDate = null;
    document.getElementById('editDaysPicker').style.display = 'none';
    const errEl = document.getElementById('editDaysError');
    try {
        const regSnapshot = editDaysReg;
        await addRegistrationDate(editDaysReg.id, editDaysReg.room_id, dateStr, dayType, waitlist);
        await logAdminAction('add_date', 'registration', String(editDaysReg.id), {
            child_name:   editDaysReg.child_name,
            parent_email: editDaysReg.parent_email,
            care_date:    dateStr,
            day_type:     dayType,
            waitlisted:   waitlist,
        });
        const fresh = await fetchAllRegistrations();
        allRegistrations = fresh;
        editDaysReg = fresh.find(r => r.id === editDaysReg.id) || editDaysReg;
        renderEditCalGrid();
        renderEditDaysList();
        renderTable(allRegistrations);
        if (!waitlist) {
            const typeLabel = dayType === 'half' ? 'half day' : 'full day';
            _sendSchedulePush(
                regSnapshot.parent_email, regSnapshot.child_name,
                'Schedule Update — Timothy Lutheran MDO',
                `${regSnapshot.child_name} has been added on ${friendlyShort(dateStr)} (${typeLabel}).`
            );
        }
    } catch (err) {
        errEl.textContent = 'Add failed: ' + err.message;
    }
}

// ============================================================
// EDIT BILL MODAL
// ============================================================
let _editBillReg   = null;
let _editBillMonth = null;

async function openEditBillModal(reg) {
    _editBillReg = reg;

    // Determine month from first care date
    const dates = (reg.registration_dates || [])
        .slice().sort((a, b) => a.care_date.localeCompare(b.care_date));
    if (!dates.length) {
        alert('No care dates on this registration — cannot edit bill.');
        return;
    }
    _editBillMonth = dates[0].care_date.slice(0, 7); // YYYY-MM

    const calculated = calcRegistrationBill(reg);
    const [y, m]     = _editBillMonth.split('-').map(Number);
    const monthLabel = `${MONTH_NAMES_ADMIN[m - 1]} ${y}`;

    document.getElementById('editBillDesc').textContent       = `${monthLabel} — ${reg.child_name}`;
    document.getElementById('editBillCalculated').textContent = `$${calculated.toFixed(2)}`;
    document.getElementById('editBillAmount').value           = calculated.toFixed(2);

    const overrideNote = document.getElementById('editBillOverrideNote');
    overrideNote.style.display = 'none';

    try {
        const existing = await fetchBillingOverride(_editBillMonth, reg.parent_email, reg.child_name);
        if (existing) {
            document.getElementById('editBillCurrentAmt').textContent = `$${parseFloat(existing.override_amount).toFixed(2)}`;
            document.getElementById('editBillAmount').value            = parseFloat(existing.override_amount).toFixed(2);
            overrideNote.style.display = 'block';
        }
    } catch (err) {
        console.warn('fetchBillingOverride failed:', err);
    }

    document.getElementById('editBillModal').classList.remove('hidden');
}

document.getElementById('editBillClose')?.addEventListener('click', () => {
    document.getElementById('editBillModal').classList.add('hidden');
    _editBillReg = null; _editBillMonth = null;
});
document.getElementById('editBillCancelBtn')?.addEventListener('click', () => {
    document.getElementById('editBillModal').classList.add('hidden');
    _editBillReg = null; _editBillMonth = null;
});

document.getElementById('editBillSaveBtn')?.addEventListener('click', async () => {
    if (!_editBillReg || !_editBillMonth) return;
    const amount = parseFloat(document.getElementById('editBillAmount').value);
    if (isNaN(amount) || amount < 0) { alert('Please enter a valid amount.'); return; }
    const btn = document.getElementById('editBillSaveBtn');
    btn.disabled = true;
    try {
        await upsertBillingOverride({
            month:           _editBillMonth,
            parent_email:    _editBillReg.parent_email,
            child_name:      _editBillReg.child_name,
            override_amount: amount,
        });
        document.getElementById('editBillModal').classList.add('hidden');
        renderTable(allRegistrations); // refresh bill column
    } catch (err) {
        alert('Save failed: ' + err.message);
    } finally {
        btn.disabled = false;
    }
});

document.getElementById('editBillRemoveBtn')?.addEventListener('click', async () => {
    if (!_editBillReg || !_editBillMonth) return;
    if (!confirm('Remove the billing override? The calculated amount will be restored.')) return;
    const btn = document.getElementById('editBillRemoveBtn');
    btn.disabled = true;
    try {
        await deleteBillingOverride(_editBillMonth, _editBillReg.parent_email, _editBillReg.child_name);
        document.getElementById('editBillModal').classList.add('hidden');
        renderTable(allRegistrations);
    } catch (err) {
        alert('Remove failed: ' + err.message);
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
        const used    = counts[room.id] || 0;
        const hasCap  = room.capacity != null && room.capacity > 0;
        const cap     = hasCap ? room.capacity * workingDays : 0;
        const pct     = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
        const color   = pct >= 90 ? 'bar-red' : pct >= 70 ? 'bar-orange' : 'bar-green';
        const metaTxt = hasCap
            ? `Max ${room.capacity}/day &middot; ${used} booking${used !== 1 ? 's' : ''}`
            : `Capacity TBD &middot; ${used} booking${used !== 1 ? 's' : ''}`;
        const pctTxt  = hasCap ? `${pct}% utilisation` : 'Utilisation pending capacity';
        return `
            <div class="cap-card" data-room-id="${room.id}" data-month-key="${key}" role="button" tabindex="0" title="View ${room.label} calendar">
                <h3>${room.label}</h3>
                <p class="cap-meta">${metaTxt}</p>
                <div class="progress-bar"><div class="progress-fill ${color}" style="width:${pct}%"></div></div>
                <p class="cap-pct">${pctTxt}</p>
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
                const toRoomObj   = ROOMS.find(r => r.id === newRoomId);
                const toRoom      = toRoomObj?.label || newRoomId;
                const toCnt       = roomCounts[newRoomId] || 0;
                const toFull      = toRoomObj && toRoomObj.capacity > 0 && toCnt >= toRoomObj.capacity;
                const overCapNote = toFull ? `\n\n⚠️ ${toRoom} is at capacity (${toCnt}/${toRoomObj.capacity}). This will force it over capacity.` : '';
                if (!confirm(`Move ${childName} from ${fromRoom} to ${toRoom} for ${friendlyShort(dateStr)} only?${overCapNote}\n\nAll other days stay unchanged.`)) {
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

    // "+ Add Child to This Day" button
    const addBtn = document.createElement('button');
    addBtn.className = 'btn-secondary';
    addBtn.textContent = '+ Add Child to This Day';
    addBtn.style.cssText = 'margin-top:14px;width:100%;font-size:.85em';
    addBtn.addEventListener('click', () => openAdminAddDayModal(dateStr, roomId));
    bodyEl.appendChild(addBtn);

    panel.classList.remove('hidden');
    panel.classList.add('visible');
}

function closeDayRosterDetail() {
    const panel = document.getElementById('dayDetailPanel');
    if (panel) { panel.classList.remove('visible'); panel.classList.add('hidden'); }
}

// ── Admin Add Day Modal ─────────────────────────────────────
let _aadDateStr  = '';
let _aadRoomId   = '';
let _aadSelected = null; // the registration record chosen

function openAdminAddDayModal(dateStr, roomId) {
    _aadDateStr  = dateStr;
    _aadRoomId   = roomId;
    _aadSelected = null;
    document.getElementById('aadDateLabel').textContent = friendlyShort(dateStr);
    document.getElementById('aadSearch').value = '';
    document.getElementById('aadResults').innerHTML = '';
    document.getElementById('aadForm').classList.add('hidden');
    document.getElementById('aadError').textContent = '';
    document.getElementById('aadChangeFee').checked = true;
    document.getElementById('adminAddDayModal').classList.remove('hidden');
}

function _closeAdminAddDayModal() {
    document.getElementById('adminAddDayModal').classList.add('hidden');
    _aadSelected = null;
}

function _aadSelectChild(reg) {
    _aadSelected = reg;
    const room = ROOMS.find(r => r.id === reg.room_id);
    document.getElementById('aadChildInfo').textContent =
        `Adding: ${reg.child_name} — ${reg.parent_name} (${room?.label || reg.room_id})`;
    document.getElementById('aadForm').classList.remove('hidden');
    document.getElementById('aadError').textContent = '';
}

function _aadRunSearch() {
    const q = document.getElementById('aadSearch').value.trim().toLowerCase();
    const resultsEl = document.getElementById('aadResults');
    if (!q) { resultsEl.innerHTML = ''; return; }

    // Collect unique child+registration combos from allRegistrations, excluding already booked on this date in this room
    const seen = new Set();
    const matches = [];
    allRegistrations.forEach(reg => {
        if (!reg.child_name.toLowerCase().includes(q) && !reg.parent_name.toLowerCase().includes(q)) return;
        const key = `${reg.id}`;
        if (seen.has(key)) return;
        seen.add(key);
        // Skip if already booked for this exact date in this room
        const alreadyBooked = (reg.registration_dates || []).some(
            d => d.care_date === _aadDateStr && (d.room_id || reg.room_id) === _aadRoomId && !d.waitlisted
        );
        if (alreadyBooked) return;
        matches.push(reg);
    });

    if (!matches.length) {
        resultsEl.innerHTML = `<p style="font-size:.85em;color:#888;padding:8px">No matching children found. Child must have an active registration.</p>`;
        return;
    }

    resultsEl.innerHTML = matches.slice(0, 10).map(reg => {
        const room = ROOMS.find(r => r.id === reg.room_id);
        return `<div class="aad-result-row" data-reg-id="${reg.id}"
            style="padding:8px 10px;cursor:pointer;border-radius:6px;font-size:.88em;border-bottom:1px solid #f0f0f0">
            <strong>${escHtml(reg.child_name)}</strong> — ${escHtml(reg.parent_name)}
            <span style="color:#888;font-size:.9em"> · ${escHtml(room?.label || reg.room_id)}</span>
        </div>`;
    }).join('');

    resultsEl.querySelectorAll('.aad-result-row').forEach(row => {
        row.addEventListener('mouseenter', () => { row.style.background = '#f0f4ff'; });
        row.addEventListener('mouseleave', () => { row.style.background = ''; });
        row.addEventListener('click', () => {
            const reg = matches.find(r => String(r.id) === row.dataset.regId);
            if (reg) { _aadSelectChild(reg); resultsEl.innerHTML = ''; document.getElementById('aadSearch').value = reg.child_name; }
        });
    });
}

async function _aadConfirm() {
    if (!_aadSelected) return;
    const errEl = document.getElementById('aadError');
    errEl.textContent = '';
    const dayType   = document.getElementById('aadDayType').value;
    const applyFee  = document.getElementById('aadChangeFee').checked;
    const changeFee = applyFee ? 5 : 0;
    const btn = document.getElementById('aadConfirmBtn');
    btn.disabled = true;

    try {
        // Check capacity
        const roomCap = ROOMS.find(r => r.id === _aadRoomId)?.capacity || 0;
        const bookedCount = allRegistrations.reduce((count, reg) => {
            return count + (reg.registration_dates || []).filter(
                d => d.care_date === _aadDateStr && (d.room_id || reg.room_id) === _aadRoomId && !d.waitlisted
            ).length;
        }, 0);
        if (roomCap > 0 && bookedCount >= roomCap) {
            if (!confirm(`⚠️ ${ROOMS.find(r => r.id === _aadRoomId)?.label} is at capacity (${bookedCount}/${roomCap}) on this day.\n\nForce add over capacity?`)) {
                btn.disabled = false;
                return;
            }
        }

        await addRegistrationDate(_aadSelected.id, _aadRoomId, _aadDateStr, dayType, false, changeFee);
        await logAdminAction('add_date', 'registration', String(_aadSelected.id), {
            child_name:   _aadSelected.child_name,
            parent_email: _aadSelected.parent_email,
            care_date:    _aadDateStr,
            day_type:     dayType,
            change_fee:   changeFee,
        });

        // Reload registration data
        allRegistrations = await fetchAllRegistrations();
        const updatedReg = allRegistrations.find(r => r.id === _aadSelected.id) || _aadSelected;

        // Send change notice email (non-blocking)
        try {
            const room = ROOMS.find(r => r.id === (updatedReg.room_id || _aadRoomId));
            const rate = dayType === 'half' ? (room?.halfDayRate || 0) : (room?.fullDayRate || 0);
            const [y, m] = _aadDateStr.substring(0, 7).split('-').map(Number);
            const monthLabel = MONTH_NAMES_ADMIN[m - 1] + ' ' + y;
            const existingDates = (updatedReg.registration_dates || [])
                .filter(d => !d.waitlisted && d.care_date !== _aadDateStr && d.care_date.startsWith(_aadDateStr.substring(0, 7)))
                .map(d => {
                    const r2 = ROOMS.find(x => x.id === (d.room_id || updatedReg.room_id));
                    const r2rate = d.day_type === 'half' ? (r2?.halfDayRate || 0) : (r2?.fullDayRate || 0);
                    return { date: d.care_date, dayType: d.day_type, amount: r2rate };
                });
            await sendScheduleChangeEmail({
                parentName: updatedReg.parent_name,
                parentEmail: updatedReg.parent_email,
                childName: updatedReg.child_name,
                monthLabel,
                existingDates,
                addedDate: { date: _aadDateStr, dayType, amount: rate },
                changeFee,
            });
        } catch (emailErr) {
            console.warn('Change notice email failed:', emailErr);
        }

        // Send push notification (non-blocking)
        const dateLabel = friendlyShort(_aadDateStr);
        const typeLabel = dayType === 'half' ? 'half day' : 'full day';
        _sendSchedulePush(
            updatedReg.parent_email,
            updatedReg.child_name,
            'Schedule Update — Timothy Lutheran MDO',
            `${updatedReg.child_name} has been added on ${dateLabel} (${typeLabel}).`
        );

        _closeAdminAddDayModal();
        drawRoomCalendar();
        renderCapacityOverview();
        // Refresh the day detail panel for the same date
        const enrolled = [];
        allRegistrations.forEach(reg => {
            (reg.registration_dates || []).forEach(d => {
                if (d.care_date === _aadDateStr && (d.room_id || reg.room_id) === _aadRoomId && !d.waitlisted) {
                    enrolled.push({ childName: reg.child_name, dayType: d.day_type, dateId: d.id });
                }
            });
        });
        const room = ROOMS.find(r => r.id === _aadRoomId);
        showDayRosterDetail(_aadDateStr, _aadRoomId, enrolled, room?.capacity || 0);
    } catch (err) {
        errEl.textContent = 'Failed to add: ' + err.message;
    } finally {
        btn.disabled = false;
    }
}

// Wire up modal events once DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('aadCloseBtn')?.addEventListener('click', _closeAdminAddDayModal);
    document.getElementById('aadCancelBtn')?.addEventListener('click', _closeAdminAddDayModal);
    document.getElementById('aadConfirmBtn')?.addEventListener('click', _aadConfirm);
    document.getElementById('aadSearch')?.addEventListener('input', _aadRunSearch);
    document.getElementById('adminAddDayModal')?.addEventListener('click', e => {
        if (e.target === document.getElementById('adminAddDayModal')) _closeAdminAddDayModal();
    });
});

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
        auto:   '⚙️ Auto — open 9 AM Central on the 1st through 11:59 PM Central on the 15th each month.',
        open:   '🟢 Force Open — registration is open for all parents right now.',
        closed: '🔴 Force Closed — registration is blocked for all parents right now.',
    };
    el.textContent = (saved ? '✅ Saved. ' : '') + (labels[val] || '');
    el.className   = `override-status override-${val}`;
}


// ============================================================
// ADMIN NEW REGISTRATION MODAL
// Director-facing registration flow mirroring the parent form.
// ============================================================
let _arFamilies       = null;   // lazy-loaded family cache
let _arFamily         = null;
let _arStudent        = null;
let _arRoom           = null;
let _arYear           = null;
let _arMonth          = null;   // 0-indexed
let _arDates          = new Map(); // dateStr → 'full'|'half'
let _arPickDate       = null;
let _arCapacity       = {}; // dateStr → booked count for current month/room
let _arSelectedFamily = null; // tracks selected family for "Change" nav
let _arBookedMap      = new Map(); // dateStr → { day_type, reg_id, date_id } for already-booked dates
let _arPickIsBooked   = false;    // true when picker is open for an existing booked date
let _arPickBookedInfo = null;     // { day_type, reg_id, date_id } for the booked date being edited

document.getElementById('adminNewRegBtn')?.addEventListener('click', _openAdminRegModal);
document.getElementById('adminRegClose')?.addEventListener('click',  _closeAdminRegModal);
document.getElementById('adminRegChangeChild')?.addEventListener('click', () => {
    _arFamily = null; _arStudent = null; _arRoom = null; _arDates = new Map();
    document.getElementById('adminRegMain').style.display = 'none';
    if (_arSelectedFamily && (_arSelectedFamily.students || []).length > 1) {
        // Multi-child family — go back to child picker
        _arShowChildPicker(_arSelectedFamily, _arSelectedFamily.students);
    } else {
        // Single child or unknown — go back to search
        _arSelectedFamily = null;
        document.getElementById('adminRegStep1').style.display = '';
        document.getElementById('adminRegStep2').style.display = 'none';
        document.getElementById('adminRegSearch').value = '';
        document.getElementById('adminRegResults').innerHTML = '';
    }
});

document.getElementById('adminRegStep2Back')?.addEventListener('click', () => {
    document.getElementById('adminRegStep2').style.display = 'none';
    document.getElementById('adminRegStep1').style.display = '';
    _arSelectedFamily = null;
});
document.getElementById('adminRegCalPrev')?.addEventListener('click', () => {
    if (--_arMonth < 0) { _arMonth = 11; _arYear--; }
    document.getElementById('adminRegDayPicker').style.display = 'none';
    _arPickDate = null;
    _arLoadCapacity();
});
document.getElementById('adminRegCalNext')?.addEventListener('click', () => {
    if (++_arMonth > 11) { _arMonth = 0; _arYear++; }
    document.getElementById('adminRegDayPicker').style.display = 'none';
    _arPickDate = null;
    _arLoadCapacity();
});
document.getElementById('adminRegPickerFull')?.addEventListener('click',   () => _arPickSelect('full'));
document.getElementById('adminRegPickerHalf')?.addEventListener('click',   () => _arPickSelect('half'));
document.getElementById('adminRegPickerRemove')?.addEventListener('click', () => _arPickRemoveBooked());
document.getElementById('adminRegPickerCancel')?.addEventListener('click', () => {
    document.getElementById('adminRegDayPicker').style.display = 'none';
    _arPickDate = null;
    _arPickIsBooked   = false;
    _arPickBookedInfo = null;
});
document.getElementById('adminRegSearch')?.addEventListener('input', _arRunSearch);
document.getElementById('adminRegSubmit')?.addEventListener('click', _arSubmit);

async function _openAdminRegModal() {
    _arFamily = null; _arStudent = null; _arRoom = null;
    _arDates  = new Map(); _arPickDate = null; _arSelectedFamily = null;

    document.getElementById('adminRegSearch').value            = '';
    document.getElementById('adminRegResults').innerHTML       = '';
    document.getElementById('adminRegStep1').style.display     = '';
    document.getElementById('adminRegStep2').style.display     = 'none';
    document.getElementById('adminRegMain').style.display      = 'none';
    document.getElementById('adminRegDayPicker').style.display = 'none';
    document.getElementById('adminRegError').textContent       = '';
    document.getElementById('adminRegModal').classList.remove('hidden');

    if (!_arFamilies) {
        document.getElementById('adminRegResults').innerHTML =
            '<p style="color:#888;font-size:.85em;padding:4px 0">Loading families…</p>';
        try {
            _arFamilies = await fetchAllFamilies();
            document.getElementById('adminRegResults').innerHTML = '';
        } catch (err) {
            document.getElementById('adminRegResults').innerHTML =
                `<p style="color:#dc2626;font-size:.85em">Load failed: ${escHtml(err.message)}</p>`;
        }
    }
}

function _closeAdminRegModal() {
    document.getElementById('adminRegModal').classList.add('hidden');
    const titleEl = document.getElementById('adminRegTitle');
    if (titleEl) titleEl.textContent = 'New Registration';
    const submitBtn = document.getElementById('adminRegSubmit');
    if (submitBtn) submitBtn.textContent = 'Create Registration';
    _arPickIsBooked = false; _arPickBookedInfo = null;
}

function _arRunSearch() {
    const q   = (document.getElementById('adminRegSearch').value || '').toLowerCase().trim();
    const out = document.getElementById('adminRegResults');
    if (!_arFamilies || !q) { out.innerHTML = ''; return; }

    // Group matching children by family
    const byFamily = new Map();
    for (const fam of _arFamilies) {
        for (const st of (fam.students || [])) {
            const matchChild = (st.child_name || '').toLowerCase().includes(q);
            const matchFam   = (fam.parent_name  || '').toLowerCase().includes(q)
                            || (fam.parent_email || '').toLowerCase().includes(q)
                            || (fam.parent2_name || '').toLowerCase().includes(q);
            if (matchChild || matchFam) {
                if (!byFamily.has(fam.id)) byFamily.set(fam.id, { fam, students: [] });
                byFamily.get(fam.id).students.push(st);
            }
        }
        if (byFamily.size >= 8) break;
    }

    if (!byFamily.size) {
        out.innerHTML = '<p style="color:#888;font-size:.85em;padding:4px 0">No matches.</p>';
        return;
    }

    const famHits = [...byFamily.values()];
    out.innerHTML = famHits.map((h, i) => {
        const childNames = h.students.map(s => escHtml(s.child_name)).join(', ');
        const count      = h.students.length;
        return `<div class="ar-result-row" data-fam-idx="${i}"
            style="padding:8px 10px;cursor:pointer;border-radius:6px;border:1px solid #e5e7eb;
                   margin-bottom:4px;font-size:.88em;background:#fff">
            <strong>${escHtml(h.fam.parent_name || h.fam.parent_email || '')}</strong>
            <span style="color:#6b7280;font-size:.9em;margin-left:6px">
                ${count === 1 ? childNames : `${count} children: ${childNames}`}
            </span>
        </div>`;
    }).join('');

    out.querySelectorAll('.ar-result-row').forEach(row => {
        row.addEventListener('mouseenter', () => { row.style.background = '#f0f4ff'; });
        row.addEventListener('mouseleave', () => { row.style.background = '#fff'; });
        row.addEventListener('click', () => {
            const { fam, students } = famHits[parseInt(row.dataset.famIdx)];
            if (students.length === 1) {
                _arSelectChild(fam, students[0]);
            } else {
                _arShowChildPicker(fam, students);
            }
        });
    });
}

function _arShowChildPicker(fam, students) {
    document.getElementById('adminRegStep1').style.display = 'none';
    document.getElementById('adminRegStep2').style.display = '';
    document.getElementById('adminRegMain').style.display  = 'none';

    const list = document.getElementById('adminRegChildList');
    list.innerHTML = students.map((st, i) => {
        const room   = _arResolveRoom(st);
        const dobStr = st.child_dob
            ? new Date(st.child_dob + 'T00:00:00').toLocaleDateString('en-US',
                { month: 'short', day: 'numeric', year: 'numeric' })
            : '';
        return `<div class="ar-result-row ar-child-pick-row" data-child-idx="${i}"
            style="padding:9px 12px;cursor:pointer;border-radius:8px;border:1px solid #e5e7eb;
                   margin-bottom:6px;font-size:.9em;background:#fff">
            <strong>${escHtml(st.child_name)}</strong>
            <span style="color:#6b7280;margin-left:8px">${escHtml(room?.label || '—')}</span>
            ${dobStr ? `<span style="color:#9ca3af;margin-left:8px;font-size:.88em">${dobStr}</span>` : ''}
        </div>`;
    }).join('');

    list.querySelectorAll('.ar-child-pick-row').forEach(row => {
        row.addEventListener('mouseenter', () => { row.style.background = '#f0f4ff'; });
        row.addEventListener('mouseleave', () => { row.style.background = '#fff'; });
        row.addEventListener('click', () => {
            _arSelectChild(fam, students[parseInt(row.dataset.childIdx)]);
        });
    });

    // Store family so "Change" can return to Step 2
    _arSelectedFamily = fam;
}

function _arResolveRoom(student) {
    if (student.room_override) return ROOMS.find(r => r.id === student.room_override) || null;
    const dob = student.child_dob;
    if (!dob) return ROOMS.find(r => r.status === 'active') || ROOMS[0];
    const ageMonths = Math.floor((Date.now() - new Date(dob)) / (1000 * 60 * 60 * 24 * 30.44));
    return ROOMS.find(r => r.ageMinMonths != null && r.ageMaxMonths != null
        && ageMonths >= r.ageMinMonths && ageMonths <= r.ageMaxMonths)
        || ROOMS.find(r => r.status === 'active') || ROOMS[0];
}

function _arSelectChild(family, student) {
    _arFamily         = family;
    _arStudent        = student;
    _arRoom           = _arResolveRoom(student);
    _arDates          = new Map();
    _arSelectedFamily = family;

    const now = new Date();
    _arYear  = now.getFullYear();
    _arMonth = now.getMonth();

    const email = (family.parent_email || '').toLowerCase();
    const name  = (student.child_name  || '').toLowerCase();
    const hasExisting = allRegistrations.some(r =>
        (r.parent_email || '').toLowerCase() === email &&
        (r.child_name   || '').toLowerCase() === name
    );
    const titleEl = document.getElementById('adminRegTitle');
    if (titleEl) titleEl.textContent = hasExisting ? `Edit Calendar — ${student.child_name}` : 'New Registration';

    const submitBtn = document.getElementById('adminRegSubmit');
    if (submitBtn) submitBtn.textContent = hasExisting ? 'Add New Days' : 'Create Registration';

    document.getElementById('adminRegChildName').textContent = student.child_name;
    document.getElementById('adminRegChildRoom').textContent = _arRoom?.label || '—';
    document.getElementById('adminRegStep1').style.display   = 'none';
    document.getElementById('adminRegStep2').style.display   = 'none';
    document.getElementById('adminRegMain').style.display    = '';
    document.getElementById('adminRegDayPicker').style.display = 'none';

    _arLoadCapacity();
    _arRenderReview();
}

async function _arLoadCapacity() {
    _arCapacity = {};
    if (!_arRoom) { _arRenderCal(); return; }
    const daysInMonth = new Date(_arYear, _arMonth + 1, 0).getDate();
    const dates = [];
    for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(_arYear, _arMonth, d).getDay();
        if (dow >= 1 && dow <= 5) {
            dates.push(`${_arYear}-${String(_arMonth+1).padStart(2,'0')}-${String(d).padStart(2,'0')}`);
        }
    }
    try { _arCapacity = await fetchCapacityForDates(_arRoom.id, dates); } catch(e) { /* ignore */ }
    _arRenderCal();
}

function _arRenderCal() {
    const grid  = document.getElementById('adminRegCalGrid');
    const label = document.getElementById('adminRegCalLabel');
    if (!grid || !label) return;

    // Apply grid layout inline so stale CSS cache can't break it
    grid.style.cssText = 'display:grid;grid-template-columns:repeat(5,1fr);gap:4px;margin-bottom:.75rem';

    const MONTHS = ['January','February','March','April','May','June',
                    'July','August','September','October','November','December'];
    label.textContent = `${MONTHS[_arMonth]} ${_arYear}`;

    const today       = new Date(); today.setHours(0, 0, 0, 0);
    const lastOfMonth = new Date(_arYear, _arMonth + 1, 0);

    // Build map of already-booked dates for this child: dateStr → { day_type, reg_id }
    _arBookedMap = new Map();
    if (_arFamily && _arStudent) {
        const email = (_arFamily.parent_email || '').toLowerCase();
        const name  = (_arStudent.child_name  || '').toLowerCase();
        allRegistrations
            .filter(r => (r.parent_email || '').toLowerCase() === email &&
                         (r.child_name  || '').toLowerCase() === name)
            .forEach(r => (r.registration_dates || []).forEach(d => {
                if (!d.waitlisted) _arBookedMap.set(d.care_date, { day_type: d.day_type || 'full', reg_id: r.id, date_id: d.id });
            }));
    }

    // Find the Monday on or before the 1st of the month
    const firstOfMonth = new Date(_arYear, _arMonth, 1);
    const dow1    = firstOfMonth.getDay(); // 0=Sun
    const daysBack = dow1 === 0 ? 6 : dow1 - 1;
    const startMon = new Date(firstOfMonth);
    startMon.setDate(startMon.getDate() - daysBack);

    let html = ['MON','TUE','WED','THU','FRI'].map(d =>
        `<div class="ar-cal-hdr">${d}</div>`).join('');

    let weekStart = new Date(startMon);
    while (weekStart <= lastOfMonth) {
        for (let wd = 0; wd < 5; wd++) {
            const curr    = new Date(weekStart);
            curr.setDate(weekStart.getDate() + wd);
            const inMonth = curr.getMonth() === _arMonth && curr.getFullYear() === _arYear;

            if (!inMonth) {
                html += '<div class="ar-cal-day other-month"></div>';
                continue;
            }

            const dateStr  = `${curr.getFullYear()}-${String(curr.getMonth()+1).padStart(2,'0')}-${String(curr.getDate()).padStart(2,'0')}`;
            const isPast   = curr < today;
            const isClosed = allClosureDates.has(dateStr);
            const sel       = _arDates.get(dateStr);
            const bookedInfo = _arBookedMap.get(dateStr);
            const booked    = !!bookedInfo;

            let cls = 'ar-cal-day';
            if (isPast || isClosed) {
                cls += ' past';
            } else if (booked) {
                cls += bookedInfo.day_type === 'half' ? ' sel-half' : ' sel-full';
            } else if (sel === 'full') {
                cls += ' sel-full';
            } else if (sel === 'half') {
                cls += ' sel-half';
            }

            // Booked and new-selected days are clickable; past/closed are not
            const attr = (!isPast && !isClosed) ? ` data-date="${dateStr}"` : '';

            // Badge: selected type, booked type, or capacity count
            let badge = '';
            if (sel) {
                badge = `<span class="ar-day-badge">${sel === 'half' ? '½ Day' : 'Full Day'}</span>`;
            } else if (booked) {
                badge = `<span class="ar-day-badge">${bookedInfo.day_type === 'half' ? '½ Day' : 'Full Day'}</span>`;
            } else if (isClosed) {
                badge = `<span class="ar-cap-badge" style="background:#f3f4f6;color:#6b7280">Closed</span>`;
            } else if (!isPast) {
                const cap    = _arRoom?.capacity || 0;
                const cnt    = _arCapacity[dateStr] || 0;
                if (cap > 0) {
                    const capCls = cnt >= cap ? 'ar-cap-full' : cnt >= cap - 2 ? 'ar-cap-near' : 'ar-cap-open';
                    badge = `<span class="ar-cap-badge ${capCls}">${cnt}/${cap}</span>`;
                }
            }

            const title = booked    ? `${bookedInfo.day_type === 'half' ? '½ Day' : 'Full Day'} — click to edit`
                        : isClosed  ? 'Closed'
                        : isPast    ? ''
                        : 'Click to add';
            html += `<div class="${cls}"${attr} title="${title}">
                <span class="ar-day-num">${curr.getDate()}</span>${badge}
            </div>`;
        }
        weekStart.setDate(weekStart.getDate() + 7);
    }

    grid.innerHTML = html;
    grid.querySelectorAll('.ar-cal-day[data-date]').forEach(cell => {
        cell.addEventListener('click', () => _arDayClick(cell.dataset.date));
    });
}

function _arDayClick(dateStr) {
    const room   = _arRoom;
    const fdRate = room?.fullDayRate ?? 0;
    const hdRate = room?.halfDayRate ?? 0;

    // Click an already-booked day → show inline edit picker (change type or remove)
    const bookedInfo = _arBookedMap.get(dateStr);
    if (bookedInfo) {
        _arPickDate       = dateStr;
        _arPickIsBooked   = true;
        _arPickBookedInfo = bookedInfo;
        document.getElementById('adminRegPickerDate').textContent = friendlyShort(dateStr);
        const fullBtn = document.getElementById('adminRegPickerFull');
        const halfBtn = document.getElementById('adminRegPickerHalf');
        const removeBtn = document.getElementById('adminRegPickerRemove');
        fullBtn.textContent  = `Full Day — $${fdRate}`;
        fullBtn.style.display = bookedInfo.day_type === 'full' ? 'none' : '';
        if (hdRate && !room?.fullDayOnly) {
            halfBtn.textContent   = `Half Day — $${hdRate}`;
            halfBtn.style.display = bookedInfo.day_type === 'half' ? 'none' : '';
        } else {
            halfBtn.style.display = 'none';
        }
        removeBtn.style.display = '';
        document.getElementById('adminRegDayPicker').style.display = '';
        return;
    }

    // Click newly-selected day → deselect
    if (_arDates.has(dateStr)) {
        _arDates.delete(dateStr);
        document.getElementById('adminRegDayPicker').style.display = 'none';
        _arPickDate = null;
        _arRenderCal(); _arRenderReview();
        return;
    }

    // Click empty day → show add picker
    _arPickDate       = dateStr;
    _arPickIsBooked   = false;
    _arPickBookedInfo = null;
    document.getElementById('adminRegPickerDate').textContent = friendlyShort(dateStr);
    document.getElementById('adminRegPickerFull').textContent = `Full Day — $${fdRate}`;
    document.getElementById('adminRegPickerRemove').style.display = 'none';
    const halfBtn = document.getElementById('adminRegPickerHalf');
    if (hdRate && !room?.fullDayOnly) {
        halfBtn.textContent   = `Half Day — $${hdRate}`;
        halfBtn.style.display = '';
    } else {
        halfBtn.style.display = 'none';
    }
    document.getElementById('adminRegDayPicker').style.display = '';
}

async function _arPickSelect(type) {
    if (!_arPickDate) return;
    document.getElementById('adminRegDayPicker').style.display = 'none';

    if (_arPickIsBooked && _arPickBookedInfo) {
        // Live-save: change day type on an existing booked date
        const info    = _arPickBookedInfo;
        const dateStr = _arPickDate;
        _arPickDate = null; _arPickIsBooked = false; _arPickBookedInfo = null;
        const reg = allRegistrations.find(r => r.id === info.reg_id);
        if (!reg || info.day_type === type) return; // no-op if same type
        const errEl = document.getElementById('adminRegError');
        try {
            await deleteRegistrationDate(info.date_id);
            await addRegistrationDate(reg.id, reg.room_id, dateStr, type, false);
            const fresh = await fetchAllRegistrations();
            allRegistrations = fresh;
            _arRenderCal();
        } catch (err) {
            errEl.textContent = 'Update failed: ' + err.message;
        }
        return;
    }

    // New date: add to pending map
    _arDates.set(_arPickDate, type);
    _arPickDate = null;
    _arRenderCal(); _arRenderReview();
}

async function _arPickRemoveBooked() {
    if (!_arPickIsBooked || !_arPickBookedInfo) return;
    document.getElementById('adminRegDayPicker').style.display = 'none';
    const info    = _arPickBookedInfo;
    const dateStr = _arPickDate;
    _arPickDate = null; _arPickIsBooked = false; _arPickBookedInfo = null;
    const errEl = document.getElementById('adminRegError');
    try {
        await deleteRegistrationDate(info.date_id);
        const fresh = await fetchAllRegistrations();
        allRegistrations = fresh;
        _arRenderCal();
    } catch (err) {
        errEl.textContent = 'Remove failed: ' + err.message;
    }
}

function _arRenderReview() {
    const el = document.getElementById('adminRegReview');
    if (!_arDates.size) {
        el.innerHTML = '<p style="color:#9ca3af;font-size:.85em;margin:.4rem 0 0">No days selected — click weekdays on the calendar above.</p>';
        document.getElementById('adminRegSubmit').disabled = true;
        return;
    }
    const room = _arRoom;
    let total = 0;
    const rows = [..._arDates.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([date, type]) => {
            const rate = type === 'full' ? (room?.fullDayRate || 0) : (room?.halfDayRate || 0);
            const disc = _arStudent?.discount_type === 'staff'   ? rate
                       : _arStudent?.discount_type === 'custom'  ? rate * (_arStudent.discount_value || 0) / 100 : 0;
            const net  = rate - disc;
            total += net;
            return `<div style="display:flex;justify-content:space-between;font-size:.85em;padding:2px 0">
                <span>${friendlyShort(date)} &mdash; ${type === 'half' ? 'Half Day' : 'Full Day'}</span>
                <span>$${net.toFixed(2)}</span></div>`;
        });
    el.innerHTML = `<div style="border-top:1px solid #e5e7eb;padding-top:.6rem;margin-top:.4rem">
        ${rows.join('')}
        <div style="display:flex;justify-content:space-between;font-weight:600;font-size:.9em;
                    border-top:1px solid #e5e7eb;padding-top:.4rem;margin-top:.4rem">
            <span>${_arDates.size} day${_arDates.size > 1 ? 's' : ''}</span>
            <span>$${total.toFixed(2)}</span>
        </div>
    </div>`;
    document.getElementById('adminRegSubmit').disabled = false;
}

// Entry point from the Families tab — opens the modal with the family pre-selected.
// Skips search (Step 1); goes to child picker (Step 2) for multi-child families,
// or directly to the calendar (Step 3) for single-child families.
function openAdminRegModalForFamily(family) {
    _arFamily = null; _arStudent = null; _arRoom = null;
    _arDates  = new Map(); _arPickDate = null;
    _arSelectedFamily = family;

    document.getElementById('adminRegError').textContent       = '';
    document.getElementById('adminRegDayPicker').style.display = 'none';

    const students = (family.students || []).filter(s => s.child_name);
    if (students.length === 1) {
        document.getElementById('adminRegStep1').style.display = 'none';
        document.getElementById('adminRegStep2').style.display = 'none';
        _arSelectChild(family, students[0]);
    } else if (students.length > 1) {
        document.getElementById('adminRegStep1').style.display = 'none';
        document.getElementById('adminRegMain').style.display  = 'none';
        _arShowChildPicker(family, students);
    } else {
        // No students yet — fall back to search
        document.getElementById('adminRegSearch').value        = family.parent_name || '';
        document.getElementById('adminRegStep1').style.display = '';
        document.getElementById('adminRegStep2').style.display = 'none';
        document.getElementById('adminRegMain').style.display  = 'none';
        if (!_arFamilies) {
            fetchAllFamilies().then(f => { _arFamilies = f; }).catch(() => {});
        }
    }

    document.getElementById('adminRegModal').classList.remove('hidden');
}

async function _arSubmit() {
    if (!_arFamily || !_arStudent || !_arDates.size) return;
    const btn = document.getElementById('adminRegSubmit');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    document.getElementById('adminRegError').textContent = '';
    try {
        const confirmedDates = [..._arDates.entries()].map(([date, dayType]) => ({ date, dayType }));
        const dob = _arStudent.child_dob || null;
        const ageMonths = dob ? Math.floor((Date.now() - new Date(dob)) / (1000 * 60 * 60 * 24 * 30.44)) : null;
        const newReg = await submitRegistration({
            parent:         { name: _arFamily.parent_name, email: _arFamily.parent_email, phone: _arFamily.parent_phone },
            child:          { name: _arStudent.child_name, ageMonths, dob },
            roomId:         _arRoom?.id,
            confirmedDates,
            status:         'confirmed',
            submittedBy:    'admin',
        });
        await logAdminAction('create', 'registration', String(newReg.id), {
            child_name:   _arStudent.child_name,
            parent_name:  _arFamily.parent_name,
            parent_email: _arFamily.parent_email,
            room_id:      _arRoom?.id,
            dates:        confirmedDates.map(d => d.date),
        });
        _closeAdminRegModal();
        await loadRegistrations();
    } catch (err) {
        document.getElementById('adminRegError').textContent = 'Save failed: ' + err.message;
        btn.disabled = false;
        btn.textContent = 'Create Registration';
    }
}

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
            (reg.child_name   || '').toLowerCase().includes(search) ||
            (reg.parent_name  || '').toLowerCase().includes(search) ||
            (reg.parent_email || '').toLowerCase().includes(search);
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
    const submittedByLabel = { parent1: 'Parent 1', parent2: 'Parent 2', admin: 'Admin' }[reg.submitted_by] || (reg.submitted_by || '');
    return {
        'Submitted':    new Date(reg.created_at).toLocaleDateString('en-US'),
        'Entered By':   submittedByLabel,
        'Parent Name':  reg.parent_name,
        'Email':        reg.parent_email,
        'Phone':        reg.parent_phone,
        'Child Name':   reg.child_name,
        'DOB':          reg.child_dob || '',
        'Room':         roomLabel,
        'Care Date':    date,
        'Day Type':     dayType,
        'Status':       status,
        'Rate':         date && rate ? `$${rate}` : '',
        'Total Bill':   `$${bill.toFixed(2)}`,
    };
}

// ============================================================
