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

// Human-readable "who entered this registration" label. `submitted_by` is
// 'parent1' / 'parent2' (the registration's own parent_name is the real name
// in those cases) or 'admin' / 'admin:<email>' (recorded at submit time so we
// can show which staff member entered it on the family's behalf).
function submittedByLabel(reg) {
    const raw = reg.submitted_by || '';
    if (raw === 'parent1' || raw === 'parent2') return reg.parent_name || (raw === 'parent1' ? 'Parent 1' : 'Parent 2');
    if (raw === 'admin') return 'Admin';
    if (raw.startsWith('admin:')) return `Admin (${raw.slice('admin:'.length)})`;
    return raw || '—';
}

// LOAD REGISTRATIONS
// ============================================================
async function loadRegistrations() {
    document.getElementById('regTableBody').innerHTML =
        '<tr><td colspan="5" class="loading-cell">Loading…</td></tr>';
    try {
        allRegistrations = await fetchAllRegistrations();
        // Discounts (the Discount column + bill estimate) read from
        // allFamiliesData via getDiscountMap(), which is otherwise lazy-loaded
        // only by the Families/Billing tools. Without this, opening
        // Registrations first shows every discounted child at full price with
        // no discount label — same guard admin-portal.js uses for the
        // dashboard's "Billed this month" card.
        if (!allFamiliesData || !allFamiliesData.length) {
            allFamiliesData = await fetchAllFamilies({ includeArchived: false });
            _discountMap = null;
        }
        populateCareMonthFilter();
        applyFilters();
        renderCapacityOverview();
    } catch (err) {
        console.error(err);
        document.getElementById('regTableBody').innerHTML =
            '<tr><td colspan="5" class="loading-cell error">Failed to load — check Supabase config.</td></tr>';
    }
}

// Only auto-select the current month once, on the tab's first load — later
// reloads (e.g. after adding a registration) must preserve whatever the
// admin has since chosen, including explicitly switching back to "All".
let _careMonthFilterDefaulted = false;

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
        const label = MONTH_NAMES[mo - 1] + ' ' + y;
        const opt = document.createElement('option');
        opt.value       = m;
        opt.textContent = label;
        sel.appendChild(opt);
    });

    if (current) {
        sel.value = current; // restore selection
    } else if (!_careMonthFilterDefaulted) {
        const now = new Date();
        const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        if (months.has(thisMonth)) sel.value = thisMonth;
        _careMonthFilterDefaulted = true;
    }
}

// ============================================================
// TABLE RENDER
// ============================================================
// The Monday of the week containing a care date — the grouping key for
// "does this weekday recur every week" below.
function _regWeekMonday(dateStr) {
    const d = new Date(dateStr + 'T12:00:00');
    const day = d.getDay();
    d.setDate(d.getDate() + (day === 0 ? -6 : 1 - day));
    return d.toISOString().split('T')[0];
}

const _REG_PATTERN_LETTERS = ['M', 'T', 'W', 'T', 'F'];

// Care Calendar redesign (2026-08-27): a weekday-pattern summary instead of a
// pill per date. `activeWeekdays` is a 5-item boolean array, Mon..Fri — which
// weekdays this registration has at least one confirmed (non-waitlisted) day
// on. "Fixed" means a weekday that's active appears in nearly every week this
// registration spans (tolerating one missed week, e.g. a closure) — otherwise
// the schedule is irregular and the summary says so rather than implying a
// pattern that isn't really there.
function _regPatternInfo(reg) {
    const dates = (reg.registration_dates || []).filter(d => !d.waitlisted && d.care_date);
    if (!dates.length) {
        return { activeWeekdays: [false, false, false, false, false], summary: 'No days scheduled' };
    }

    const byWeekday = [[], [], [], [], []]; // Mon..Fri
    const weeksSeen = new Set();
    dates.forEach(d => {
        weeksSeen.add(_regWeekMonday(d.care_date));
        const dow = new Date(d.care_date + 'T12:00:00').getDay(); // 0=Sun..6=Sat
        const idx = dow - 1; // Mon=0..Fri=4
        if (idx >= 0 && idx <= 4) byWeekday[idx].push(d.day_type || 'full');
    });

    const weekCount = weeksSeen.size;
    const activeWeekdays = byWeekday.map(arr => arr.length > 0);
    const activeCount = activeWeekdays.filter(Boolean).length;
    const isFixed = activeWeekdays.every((active, i) =>
        !active || byWeekday[i].length >= weekCount - 1);

    const dayTypes = new Set(dates.map(d => d.day_type || 'full'));
    const dayTypeLabel = dayTypes.size > 1 ? 'Mixed' : (dayTypes.has('half') ? 'Half' : 'Full');

    let freqLabel;
    if (!isFixed) {
        freqLabel = 'No fixed pattern';
    } else if (activeCount === 5) {
        freqLabel = 'Every day';
    } else {
        const letters = _REG_PATTERN_LETTERS.filter((_, i) => activeWeekdays[i]).join('/');
        freqLabel = `${activeCount}x/wk (${letters})`;
    }

    return {
        activeWeekdays,
        summary: `${dayTypeLabel} · ${freqLabel} · ${dates.length} day${dates.length !== 1 ? 's' : ''} this month`,
    };
}

function _regPatternHtml(reg) {
    const info = _regPatternInfo(reg);
    const chips = _REG_PATTERN_LETTERS.map((letter, i) =>
        `<span class="rc-pat-chip${info.activeWeekdays[i] ? ' is-on' : ''}">${letter}</span>`).join('');
    return `<div class="rc-pattern">
        <div class="rc-pat-chips">${chips}</div>
        <div class="rc-pat-summary">${escHtml(info.summary)}</div>
    </div>`;
}

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
        tbody.innerHTML = '<tr><td colspan="5" class="loading-cell">No registrations found.</td></tr>';
        return;
    }

    tbody.innerHTML = data.map(reg => {
        const room = ROOMS.find(r => r.id === reg.room_id) || { label: reg.room_id };
        const bill = calcRegistrationBill(reg);

        // Discount info — try reg email first, fall back to searching all family emails
        const discKey = `${(reg.parent_email || '').toLowerCase()}:${(reg.child_name || '').toLowerCase()}`;
        const disc    = getDiscountMap().get(discKey);
        const discLabel = disc
            ? (disc.type === 'staff' ? 'Staff (free)' : `${disc.value}% off`)
            : '';

        return `
            <tr data-id="${reg.id}" data-room="${reg.room_id}">
                <td class="rc-parent-cell">
                    <div class="rc-parent-name">${escHtml(reg.parent_name)}</div>
                    <div class="rc-parent-sub">${escHtml(reg.parent_phone || reg.parent_email || '')}</div>
                </td>
                <td class="rc-child-cell">
                    <div class="rc-child-name">${escHtml(reg.child_name)}</div>
                    <div class="rc-child-room">${escHtml(room.label)}</div>
                </td>
                <td>${_regPatternHtml(reg)}</td>
                <td class="rc-bill-cell">
                    <div class="rc-bill-amt">$${bill.toFixed(2)}</div>
                    ${discLabel ? `<div class="rc-bill-disc">${escHtml(discLabel)}</div>` : ''}
                </td>
                <td class="rc-actions-cell">
                    <button class="rc-icon-btn btn-view-days" data-id="${reg.id}" title="View days">&#128197;</button>
                    <button class="rc-icon-btn btn-edit-bill" data-id="${reg.id}" title="Edit bill">&#128178;</button>
                    <button class="rc-icon-btn rc-icon-btn-danger btn-delete" data-id="${reg.id}" title="Delete">&#128465;&#65039;</button>
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

    tbody.querySelectorAll('.btn-view-days').forEach(btn => {
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
        // The Calendar tab doesn't load allFamiliesData, so fall back to a direct
        // fetch when the family isn't cached — otherwise this always shows "none".
        (async () => {
            const family = (allFamiliesData || []).find(f =>
                (f.parent_email || '').toLowerCase() === (reg.parent_email || '').toLowerCase() ||
                (f.parent2_email || '').toLowerCase() === (reg.parent_email || '').toLowerCase());
            let recurDays;
            if (family) {
                const student = (family.students || []).find(s =>
                    (s.child_name || '').toLowerCase() === (reg.child_name || '').toLowerCase());
                recurDays = student?.recurring_days || null;
            } else {
                recurDays = await fetchStudentRecurringDays(reg.parent_email, reg.child_name);
            }
            if (recurDays) {
                noteEl.textContent = `🔁 Recurring schedule: ${recurDays.replace(/,/g, ', ')}`;
            } else {
                noteEl.textContent = 'ℹ️ No recurring days set for this infant — set them in Families';
            }
            noteEl.style.display = 'block';
        })();
    }

    renderEditCalGrid();
    renderEditDaysList();
    document.getElementById('editDaysModal').classList.remove('hidden');

    // Recompute on open, before any edit. The figure shown has to BE the
    // invoice rather than a possibly-stale draft, and because the recompute is
    // idempotent this also quietly heals any month that drifted under the old
    // delta-based paths — the director sees the true number the moment she
    // looks at a child.
    const openMonth = (reg.month_key
        || reg.registration_dates?.[0]?.care_date?.substring(0, 7)
        || '');
    if (openMonth) _recomputeAndShow(reg.parent_email, openMonth);
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
                // Billing follows the days, always.
                if (removedDate) {
                    await _recomputeAndShow(editDaysReg.parent_email, removedDate.care_date.substring(0, 7));
                }
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
            await _recomputeAndShow(editDaysReg.parent_email, removedDate.care_date.substring(0, 7));
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
        const room = ROOMS.find(r => r.id === editDaysReg?.room_id);
        document.getElementById('editDaysPickerHalf').style.display = room?.fullDayOnly ? 'none' : '';
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
        // Waitlisted days aren't billable, but recompute regardless — the
        // recompute filters them out itself, and hooking every mutation
        // unconditionally is what keeps this from drifting again.
        await _recomputeAndShow(regSnapshot.parent_email, dateStr.substring(0, 7));
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
    const monthLabel = `${MONTH_NAMES[m - 1]} ${y}`;

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
let capOverviewDate   = null; // JS Date set to 1st of currently displayed month
let capOverviewRoomId = null; // room id currently selected in the Month view's room tabs

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
            opt.textContent = MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
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
        opt.textContent = MONTH_NAMES[capOverviewDate.getMonth()] + ' ' + capOverviewDate.getFullYear();
        sel.appendChild(opt);
    }
    sel.value = key;
}

// ============================================================
// BILLING RECOMPUTE — the single path
// ============================================================
// Any change to a child's days — added, removed, or switched between full and
// half — re-runs the server-side recompute for that family's whole month.
//
// This replaced a set of delta adjustments. A delta is a guess about what
// changed, so every mutation site has to remember to participate; three of
// them didn't, which meant removing a day never reduced the invoice and the
// number could only ratchet upward. A recompute is a statement about what is,
// and it is idempotent — calling it twice, or after a mutation nobody hooked
// up, still lands on the right answer.
//
// Non-blocking by design: the day change is already saved and must not be
// rolled back if billing is briefly unreachable. A failure is surfaced so the
// director knows to regenerate, rather than silently leaving a stale figure.
async function _recomputeInvoice(parentEmail, monthKey) {
    if (!parentEmail || !monthKey) return null;
    try {
        const invoiceId = await createInvoiceByEmail(parentEmail, monthKey);
        if (!invoiceId) return null;
        return await fetchBillingInvoiceById(invoiceId);
    } catch (err) {
        console.error('Invoice recompute failed:', parentEmail, monthKey, err);
        window.reportClientError?.(
            `Invoice recompute failed: ${err?.message || err}`,
            err?.stack || null,
            { type: 'billing_reconcile', month: monthKey, source: 'admin_calendar' },
        );
        if (typeof showToast === 'function') {
            showToast('Day saved, but the invoice could not be recalculated. Regenerate invoices for this month.', 'error');
        }
        return null;
    }
}

// Recompute, then show the resulting month total in the Edit Days modal so the
// director watches the figure move as she works rather than trusting that it
// will be right later.
async function _recomputeAndShow(parentEmail, monthKey) {
    const el = document.getElementById('editDaysTotal');
    if (el) el.textContent = 'Recalculating…';
    const invoice = await _recomputeInvoice(parentEmail, monthKey);
    if (!el) return;
    if (!invoice) {
        el.textContent = 'Invoice total unavailable — regenerate invoices for this month.';
        return;
    }
    const label = new Date(`${monthKey}-01T00:00:00`).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    el.textContent = `${label} total for this family: $${Number(invoice.final_amount).toFixed(2)}`;
}

// Room-tabs + a Mon–Fri day grid for whichever room is selected — matches the
// design source's Month view exactly (one room's whole month, click a day to
// move a child) rather than the aggregate progress-bar cards this replaced.
// The aggregate monthly utilization % those cards showed didn't disappear —
// it's the FTE / Seat-Day sub-view's Capacity/Seat-Day Occupancy columns,
// which read the same registrations at the whole-month grain this view no
// longer needs to also carry.
function renderCapacityOverview() {
    const grid = document.getElementById('capacityGrid');
    if (!grid) return;
    if (!capOverviewDate) capOverviewDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const rooms = getSortedRooms().filter(r => r.status !== 'coming_soon');
    if (!rooms.length) { grid.innerHTML = '<p class="empty-hint">No active rooms found.</p>'; return; }
    if (!capOverviewRoomId || !rooms.some(r => r.id === capOverviewRoomId)) capOverviewRoomId = rooms[0].id;
    const room = rooms.find(r => r.id === capOverviewRoomId);

    const y   = capOverviewDate.getFullYear();
    const m   = capOverviewDate.getMonth();
    const key = `${y}-${String(m + 1).padStart(2, '0')}`;
    const cap = room.capacity || 0;

    // dayMap: 'YYYY-MM-DD' → [{ childName, dayType, dateId }]. Filtered by the
    // date's own room_id (not the registration's) so a per-day move is reflected
    // — same rule drawRoomCalendar() uses for the pre-existing per-room modal.
    const dayMap = {};
    allRegistrations.forEach(reg => {
        (reg.registration_dates || []).forEach(d => {
            if (d.room_id !== room.id) return;
            if (d.waitlisted || !d.care_date || !d.care_date.startsWith(key)) return;
            (dayMap[d.care_date] = dayMap[d.care_date] || []).push({ childName: reg.child_name, dayType: d.day_type, dateId: d.id });
        });
    });

    // Lead in enough empty cells that the 1st actually lands under its real
    // weekday column — a month starting on, say, a Wednesday shouldn't render
    // the 1st under Monday.
    const firstDow    = new Date(y, m, 1).getDay(); // 0=Sun … 6=Sat
    const monBased    = firstDow === 0 ? 6 : firstDow - 1; // 0=Mon … 4=Fri, 5=Sat, 6=Sun
    const leadEmpties = monBased < 5 ? monBased : 0;

    const monAbbr = MONTH_NAMES[m].slice(0, 3);

    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < leadEmpties; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) {
        const dow = new Date(y, m, day).getDay();
        if (dow === 0 || dow === 6) continue;
        const dateStr  = `${key}-${String(day).padStart(2, '0')}`;
        const enrolled = (dayMap[dateStr] || []).slice().sort((a, b) => a.childName.localeCompare(b.childName));
        const isClosed = typeof allClosureDates !== 'undefined' && allClosureDates.has(dateStr);
        cells.push({ day, dateStr, enrolled, isClosed });
    }

    const tabsHtml = rooms.map(r => `
        <button type="button" class="ec-room-tab${r.id === capOverviewRoomId ? ' is-active' : ''}" data-room="${r.id}">${escHtml(r.label)}</button>`).join('');

    const cellsHtml = cells.map(c => {
        if (!c) return `<div class="ec-month-cell ec-month-cell-empty"></div>`;
        if (c.isClosed) return `<div class="ec-month-cell is-closed"><span class="ec-month-date">${monAbbr} ${c.day}</span><span class="ec-month-closed">Closed</span></div>`;
        const count = c.enrolled.length;
        const full  = !!cap && count >= cap;
        const near  = !full && !!cap && count >= cap * 0.85;
        return `<button type="button" class="ec-month-cell${full ? ' is-full' : near ? ' is-near' : ''}" data-date="${c.dateStr}">
            <span class="ec-month-date">${monAbbr} ${c.day}</span>
            <span class="ec-month-count">${count}${cap ? '/' + cap : ''}</span>
        </button>`;
    }).join('');

    grid.innerHTML = `
        <div class="ec-room-tabs">${tabsHtml}</div>
        <div class="ec-month-dow">${['Mon', 'Tue', 'Wed', 'Thu', 'Fri'].map(d => `<div class="ec-month-dow-cell">${d}</div>`).join('')}</div>
        <div class="ec-month-grid">${cellsHtml}</div>`;

    grid.querySelectorAll('.ec-room-tab').forEach(btn => {
        btn.addEventListener('click', () => { capOverviewRoomId = btn.dataset.room; renderCapacityOverview(); });
    });
    grid.querySelectorAll('.ec-month-cell[data-date]').forEach(btn => {
        btn.addEventListener('click', () => {
            const cell = cells.find(c => c && c.dateStr === btn.dataset.date);
            if (cell) showDayRosterDetail(cell.dateStr, room.id, cell.enrolled, cap);
        });
    });
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

        const sortedRoomsForSchedule = getSortedRooms();
        const roomHeaders = sortedRoomsForSchedule.map(r => `<th colspan="2" class="staff-room-header">${r.label}</th>`).join('');
        const subHeaders  = sortedRoomsForSchedule.map(() =>
            `<th class="staff-sub-head shift-am-th">AM</th><th class="staff-sub-head shift-pm-th">PM</th>`
        ).join('');

        const rows = weekDates.map(d => {
            const dt    = new Date(d + 'T00:00:00');
            const label = `${DAY_ABBR[dt.getDay()]} ${friendlyShort(d)}`;
            const cells = sortedRoomsForSchedule.map(room => {
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

    const otherRooms = getSortedRooms().filter(r => r.id !== roomId);
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

        // Recompute the family's month. The change fee was just written onto
        // the registration_dates row above, so the recompute includes it —
        // no need to hand billing a separately-calculated delta.
        await _recomputeInvoice(_aadSelected.parent_email, _aadDateStr.substring(0, 7));

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
            const rate = (!room?.fullDayOnly && dayType === 'half') ? (room?.halfDayRate || 0) : (room?.fullDayRate || 0);
            const [y, m] = _aadDateStr.substring(0, 7).split('-').map(Number);
            const monthLabel = MONTH_NAMES[m - 1] + ' ' + y;
            const existingDates = (updatedReg.registration_dates || [])
                .filter(d => !d.waitlisted && d.care_date !== _aadDateStr && d.care_date.startsWith(_aadDateStr.substring(0, 7)))
                .map(d => {
                    const r2 = ROOMS.find(x => x.id === (d.room_id || updatedReg.room_id));
                    const r2rate = (!r2?.fullDayOnly && d.day_type === 'half') ? (r2?.halfDayRate || 0) : (r2?.fullDayRate || 0);
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
    document.getElementById('rcalMonthLabel').textContent = MONTH_NAMES[m] + ' ' + y;

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
            await logAdminAction('update', 'registration_window', null, { value: val });
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
// Set only when this modal was opened via wlpEnrollFromWaitlist() — on a
// successful submit, _arSubmit() also marks this waitlist application
// 'enrolled' so it drops off the Planner. Reset on every other open/close
// path so it can never leak into an unrelated registration.
let _arWaitlistAppId  = null;
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
    _arWaitlistAppId = null;

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
    _arWaitlistAppId = null;
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
    const roomId = roomIdForAgeMonths(calcAgeMonths(dob), ROOMS.filter(r => r.status === 'active'));
    return (roomId && ROOMS.find(r => r.id === roomId))
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
            // Full↔half is a price change, so billing has to follow it.
            await _recomputeInvoice(reg.parent_email, dateStr.substring(0, 7));
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
        const reg = allRegistrations.find(r => r.id === info.reg_id);
        await deleteRegistrationDate(info.date_id);
        const fresh = await fetchAllRegistrations();
        allRegistrations = fresh;
        await _recomputeInvoice(reg?.parent_email, dateStr.substring(0, 7));
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
    _arWaitlistAppId = null;

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

// Opens the Add Registration flow pre-filled from a waitlist application —
// called from wlpEnrollFromWaitlist() (admin-waitlist.js) for the "this is
// after I've already talked to the parent" enroll action. A waitlisted
// family isn't in `families`/`students` yet, so _arFamily/_arStudent are
// duck-typed with just the fields submitRegistration()/_arRenderCal() read
// (parent_name/email/phone, child_name/dob) rather than real DB records.
// Skips straight to the calendar step with the matched dates pre-checked —
// the admin still reviews and clicks Submit, this doesn't book anything by
// itself.
function openAdminRegModalForWaitlistKid({ parentName, parentEmail, parentPhone, childName, childDob, room, moKey, waitlistAppId }) {
    _arFamily = { parent_name: parentName, parent_email: parentEmail, parent_phone: parentPhone };
    _arStudent = { child_name: childName, child_dob: childDob, discount_type: null, discount_value: null };
    _arRoom = room;
    _arSelectedFamily = null;
    _arWaitlistAppId = waitlistAppId;

    const [y, m] = moKey.split('-').map(Number); // m is 1-based
    _arYear  = y;
    _arMonth = m - 1;
    _arDates = new Map(); // no pre-checked days — admin picks dates on the calendar
    _arPickDate = null;

    document.getElementById('adminRegError').textContent       = '';
    document.getElementById('adminRegDayPicker').style.display = 'none';
    document.getElementById('adminRegTitle').textContent       = `Enroll from Waitlist — ${childName}`;
    document.getElementById('adminRegSubmit').textContent      = 'Create Registration';
    document.getElementById('adminRegChildName').textContent   = childName;
    document.getElementById('adminRegChildRoom').textContent   = room?.label || '—';
    document.getElementById('adminRegStep1').style.display     = 'none';
    document.getElementById('adminRegStep2').style.display     = 'none';
    document.getElementById('adminRegMain').style.display      = '';
    document.getElementById('adminRegModal').classList.remove('hidden');

    _arLoadCapacity();
    _arRenderReview();
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
        const ageMonths = dob ? calcAgeMonths(dob) : null;

        // FS2: if this child already has a confirmed registration for the month
        // shown in the modal, append the newly-selected days to that existing
        // registration instead of inserting a second registrations row (which
        // double-counts the child in rosters/capacity/billing). Only a genuinely
        // new child+month combination creates a fresh registration.
        const monthPrefix = `${_arYear}-${String(_arMonth + 1).padStart(2, '0')}`;
        let existingRegId = null;
        for (const [dateStr, info] of _arBookedMap.entries()) {
            if (dateStr.startsWith(monthPrefix) && info && info.reg_id) { existingRegId = info.reg_id; break; }
        }

        let newReg;
        if (existingRegId) {
            for (const { date, dayType } of confirmedDates) {
                await addRegistrationDate(existingRegId, _arRoom?.id, date, dayType, false);
            }
            newReg = { id: existingRegId };
            await logAdminAction('update', 'registration', String(existingRegId), {
                child_name:   _arStudent.child_name,
                parent_email: _arFamily.parent_email,
                added_dates:  confirmedDates.map(d => d.date),
            });
        } else {
            newReg = await submitRegistration({
                parent:         { name: _arFamily.parent_name, email: _arFamily.parent_email, phone: _arFamily.parent_phone },
                child:          { name: _arStudent.child_name, ageMonths, dob },
                roomId:         _arRoom?.id,
                confirmedDates,
                status:         'confirmed',
                submittedBy:    window._adminSession?.user?.email ? `admin:${window._adminSession.user.email}` : 'admin',
            });
            await logAdminAction('create', 'registration', String(newReg.id), {
                child_name:   _arStudent.child_name,
                parent_name:  _arFamily.parent_name,
                parent_email: _arFamily.parent_email,
                room_id:      _arRoom?.id,
                dates:        confirmedDates.map(d => d.date),
            });
        }

        // Create billing invoice. FS5: the RPC recomputes the family's whole
        // month server-side from the registration rows, so no total is passed.
        // That also picks up the sibling discount across separate registrations,
        // which the old per-session calculation here could not see.
        try {
            const monthKey = [..._arDates.keys()][0].substring(0, 7);
            await createInvoiceByEmail(_arFamily.parent_email, monthKey);
        } catch (err) {
            console.error('Invoice draft failed after admin registration:', err);
            window.reportClientError?.(
                `Invoice draft failed after admin registration: ${err?.message || err}`,
                err?.stack || null,
                { type: 'billing_reconcile', source: 'admin_registration' },
            );
        }

        if (_arWaitlistAppId) {
            try { await updateWaitlistApplication(_arWaitlistAppId, { status: 'enrolled' }); } catch (_) { /* non-blocking — registration is already created */ }
            _arWaitlistAppId = null;
            if (typeof loadWaitlistApplications === 'function') loadWaitlistApplications();
        }

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
            case 'child':
                va = (a.child_name || '').toLowerCase(); vb = (b.child_name || '').toLowerCase();
                return mult * va.localeCompare(vb);
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
        'Submitted':    new Date(reg.created_at).toLocaleDateString('en-US'),
        'Entered By':   submittedByLabel(reg),
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
