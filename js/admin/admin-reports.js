// ============================================================
// MODULE: Admin Reports (billing, payroll, attendance, scheduling)
// Sections: Family Billing Report, Staff Scheduling,
//           Auto-Fill Staff Schedule, Historical Payroll Records,
//           Payroll Report, Attendance & Revenue, Extra Reports
// ============================================================

// FAMILY BILLING REPORT
// ============================================================
function setupFamilyBilling() {
    document.getElementById('generateFamilyBillingBtn')?.addEventListener('click', async () => {
        if (allFamiliesData.length === 0) await loadFamilies();
        await generateFamilyBillingReport();
    });
    document.getElementById('exportFamilyBillingBtn')?.addEventListener('click', exportFamilyBillingReport);
    document.getElementById('printFamilyBillingBtn')?.addEventListener('click', printFamilyBillingReport);

    const now = new Date();
    const el = document.getElementById('familyBillingMonth');
    if (el) el.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    // Single delegated listener for all billing override interactions
    document.getElementById('familyBillingContent')?.addEventListener('click', async e => {
        // Show inline edit input
        if (e.target.classList.contains('billing-override-btn')) {
            const cell    = e.target.closest('.billing-override-cell');
            if (!cell) return;
            const current = parseFloat(cell.dataset.calculated) || 0;
            cell.innerHTML = `
                <input type="number" class="billing-override-input" value="${current.toFixed(2)}" step="0.01" min="0">
                <button class="billing-override-save btn-xs">Save</button>
                <button class="billing-override-cancel btn-xs">Cancel</button>`;
            cell.querySelector('.billing-override-input').focus();
        }

        // Save the override
        if (e.target.classList.contains('billing-override-save')) {
            const cell   = e.target.closest('.billing-override-cell');
            const input  = cell.querySelector('.billing-override-input');
            const amount = parseFloat(input.value);
            if (isNaN(amount) || amount < 0) { alert('Please enter a valid amount.'); return; }
            try {
                await upsertBillingOverride({
                    month:           cell.dataset.month,
                    parent_email:    cell.dataset.email,
                    child_name:      cell.dataset.child,
                    override_amount: amount,
                });
                await generateFamilyBillingReport();
            } catch (err) { alert('Failed to save override: ' + err.message); }
        }

        // Cancel edit, restore report
        if (e.target.classList.contains('billing-override-cancel')) {
            await generateFamilyBillingReport();
        }

        // Remove override, restore calculated amount
        if (e.target.classList.contains('billing-override-reset')) {
            if (!confirm('Remove manual override and restore the calculated amount?')) return;
            const cell = e.target.closest('.billing-override-cell');
            try {
                await deleteBillingOverride(cell.dataset.month, cell.dataset.email, cell.dataset.child);
                await generateFamilyBillingReport();
            } catch (err) { alert('Failed to remove override: ' + err.message); }
        }
    });
}

function printFamilyBillingReport() {
    const monthVal  = document.getElementById('familyBillingMonth')?.value;
    const table     = document.getElementById('billingReportTable');
    if (!table) { alert('Please generate the billing report first.'); return; }

    const [y, m]     = (monthVal || '--').split('-').map(Number);
    const monthLabel = m ? (MONTH_NAMES_ADMIN[m - 1] + ' ' + y) : '';

    // Clone table and strip interactive override elements
    const tableClone = table.cloneNode(true);
    tableClone.querySelectorAll('.billing-override-btn, .billing-override-reset, .billing-override-label, .billing-override-input, .billing-override-save, .billing-override-cancel').forEach(el => el.remove());

    const win = window.open('', '_blank');
    win.document.write(`<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Family Billing — ${escHtml(monthLabel)}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 12px; color: #000; margin: 24px; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  p.subtitle { font-size: 10px; color: #666; margin: 0 0 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #1e3a5f; color: #fff; padding: 6px 10px; text-align: left; font-size: 11px; }
  th:nth-child(3), th:nth-child(4), th:nth-child(5), th:nth-child(6) { text-align: right; }
  td { padding: 5px 10px; font-size: 11px; vertical-align: middle; }
  td.report-num { text-align: right; }
  tr.billing-family-row td { background: #f0ebe0; border-top: 2px solid #bbb; font-weight: bold; }
  tr.billing-child-row td { background: #fff; border-bottom: 1px solid #e8e8e8; }
  td.billing-indent { padding-left: 22px; }
  span.billing-contact { font-size: 10px; color: #555; font-weight: normal; margin-left: 8px; }
  tr.report-total-row td { background: #e8eef5; font-weight: bold; border-top: 2px solid #1e3a5f; }
  span.billing-override-amount { font-style: italic; }
  @media print { body { margin: 0; } }
</style>
</head>
<body>
<h1>Family Billing Summary — ${escHtml(monthLabel)}</h1>
<p class="subtitle">Printed ${new Date().toLocaleDateString()}</p>
${tableClone.outerHTML}
</body>
</html>`);
    win.document.close();
    win.focus();
    setTimeout(() => win.print(), 400);
}

function _buildFamilyBillingData(monthVal, overridesMap = new Map()) {
    const dmap      = getDiscountMap();
    const familyMap = new Map();

    // First pass: collect each child's registration info per family key
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
                regs: [],
            });
        }
        const room    = ROOMS.find(r => r.id === reg.room_id);
        const discKey = `${(reg.parent_email || '').toLowerCase()}:${(reg.child_name || '').toLowerCase()}`;
        const disc    = dmap.get(discKey) || { type: 'none', value: 0 };
        familyMap.get(key).regs.push({ reg, room, disc, dates });
    });

    // Second pass: compute billing per family, applying sibling discount per day
    const result = [];
    for (const fam of familyMap.values()) {
        const { regs } = fam;

        // Build map: care_date → array of { childName, effRate }
        // used to figure out which days have multiple siblings
        const dateChildMap = new Map();
        regs.forEach(({ reg, room, disc, dates }) => {
            dates.forEach(d => {
                const base    = d.day_type === 'half' ? (room?.halfDayRate || 0) : (room?.fullDayRate || 0);
                const effRate = effectiveAdminRate(base, disc.type, disc.value);
                if (!dateChildMap.has(d.care_date)) dateChildMap.set(d.care_date, []);
                dateChildMap.get(d.care_date).push({ childName: reg.child_name, effRate });
            });
        });

        // For each shared date, identify which child (lowest rate) gets the $10 sibling discount
        // Key: `${childName}:${care_date}` → discount amount
        const siblingDiscMap = new Map();
        for (const [date, children] of dateChildMap) {
            if (children.length < 2) continue;
            const sorted = [...children].sort((a, b) => b.effRate - a.effRate);
            sorted.forEach((c, i) => {
                if (i > 0) {
                    const k = `${c.childName}:${date}`;
                    siblingDiscMap.set(k, (siblingDiscMap.get(k) || 0) + Math.min(10, c.effRate));
                }
            });
        }

        // Now aggregate per-child totals with sibling discounts applied
        const childMap = new Map();
        regs.forEach(({ reg, room, disc, dates }) => {
            let fullDays = 0, halfDays = 0, subtotal = 0, changeFees = 0, sibDiscount = 0, discountDollar = 0;
            dates.forEach(d => {
                const base    = d.day_type === 'half' ? (room?.halfDayRate || 0) : (room?.fullDayRate || 0);
                const effRate = effectiveAdminRate(base, disc.type, disc.value);
                const sib     = siblingDiscMap.get(`${reg.child_name}:${d.care_date}`) || 0;
                subtotal      += Math.max(0, effRate - sib);
                sibDiscount   += sib;
                discountDollar += Math.max(0, base - effRate);
                changeFees    += Number(d.change_fee) || 0;
                if (d.day_type === 'half') halfDays++; else fullDays++;
            });

            // Check for manual billing override
            const overrideKey    = `${(reg.parent_email || '').toLowerCase()}:${(reg.child_name || '').toLowerCase()}`;
            const overrideAmount = overridesMap.get(overrideKey);
            const hasOverride    = overrideAmount !== undefined;

            const existing = childMap.get(reg.child_name);
            if (existing) {
                existing.fullDays      += fullDays;
                existing.halfDays      += halfDays;
                existing.subtotal      += subtotal;
                existing.changeFees    += changeFees;
                existing.sibDiscount   += sibDiscount;
                existing.discountDollar += discountDollar;
            } else {
                const discLabel = disc.type === 'staff'  ? 'Staff (free)' :
                                  disc.type === 'custom' ? `${disc.value}% off` : '—';
                childMap.set(reg.child_name, {
                    childName:      reg.child_name,
                    roomLabel:      room?.label || reg.room_id,
                    fullDays,
                    halfDays,
                    subtotal,
                    changeFees,
                    sibDiscount,
                    discountDollar,
                    discLabel,
                    hasOverride,
                    overrideAmount: hasOverride ? overrideAmount : undefined,
                    parentEmail:    (reg.parent_email || '').toLowerCase(),
                });
            }
        });

        result.push({
            parentName:  fam.parentName,
            parentEmail: fam.parentEmail,
            parentPhone: fam.parentPhone,
            children:    [...childMap.values()],
        });
    }

    return result.sort((a, b) => {
        const la = (a.parentName || '').split(' ').pop().toLowerCase();
        const lb = (b.parentName || '').split(' ').pop().toLowerCase();
        return la.localeCompare(lb);
    });
}

async function generateFamilyBillingReport() {
    const monthVal = document.getElementById('familyBillingMonth')?.value;
    if (!monthVal) { alert('Please select a month.'); return; }

    const [y, m]     = monthVal.split('-').map(Number);
    const monthLabel = MONTH_NAMES_ADMIN[m - 1] + ' ' + y;
    const container  = document.getElementById('familyBillingContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';

    // Load any manual billing overrides for this month
    let overrideRows = [];
    try { overrideRows = await fetchBillingOverrides(monthVal); } catch (e) { console.warn('fetchBillingOverrides:', e); }
    const overridesMap = new Map(overrideRows.map(r => [
        `${(r.parent_email || '').toLowerCase()}:${(r.child_name || '').toLowerCase()}`,
        parseFloat(r.override_amount),
    ]));

    const families = _buildFamilyBillingData(monthVal, overridesMap);

    if (!families.length) {
        container.innerHTML = `<p class="empty-hint">No registrations found for ${monthLabel}.</p>`;
        return;
    }

    let grandTotal = 0;
    const rows = families.map(fam => {
        const familyTotal = fam.children.reduce((s, c) => {
            const billed = c.hasOverride ? c.overrideAmount : c.subtotal;
            return s + billed + (c.changeFees || 0);
        }, 0);
        grandTotal += familyTotal;

        const childRows = fam.children.map(c => {
            const billed      = c.hasOverride ? c.overrideAmount : c.subtotal;
            const discDisplay = c.discountDollar > 0
                ? `${escHtml(c.discLabel)} (−$${c.discountDollar.toFixed(2)})`
                : escHtml(c.discLabel);

            const feeRow = c.changeFees > 0
                ? `<tr class="billing-child-row" style="background:#fffbeb">
                    <td class="billing-indent" style="color:#92400e;font-size:.85em" colspan="4">↳ Schedule change fee${c.changeFees > 5 ? 's (' + Math.round(c.changeFees / 5) + ' × $5)' : ''}</td>
                    <td class="report-num" style="color:#92400e">—</td>
                    <td class="report-num report-revenue" style="color:#92400e">+$${c.changeFees.toFixed(2)}</td>
                   </tr>`
                : '';
            const sibRow = !c.hasOverride && c.sibDiscount > 0
                ? `<tr class="billing-child-row" style="background:#f0fdf4">
                    <td class="billing-indent" style="color:#166534;font-size:.85em" colspan="4">↳ Sibling discount applied</td>
                    <td class="report-num" style="color:#166534">—</td>
                    <td class="report-num report-revenue" style="color:#166534">−$${c.sibDiscount.toFixed(2)}</td>
                   </tr>`
                : '';

            const amountCell = c.hasOverride
                ? `<td class="report-num report-revenue billing-override-cell has-override"
                       data-month="${escHtml(monthVal)}"
                       data-email="${escHtml(c.parentEmail)}"
                       data-child="${escHtml(c.childName)}"
                       data-calculated="${c.subtotal.toFixed(2)}">
                       <span class="billing-override-amount">$${billed.toFixed(2)}</span>
                       <span class="billing-override-label">overridden</span>
                       <button class="billing-override-reset" title="Remove override and restore calculated amount">×</button>
                   </td>`
                : `<td class="report-num report-revenue billing-override-cell"
                       data-month="${escHtml(monthVal)}"
                       data-email="${escHtml(c.parentEmail)}"
                       data-child="${escHtml(c.childName)}"
                       data-calculated="${c.subtotal.toFixed(2)}">
                       $${billed.toFixed(2)}
                       <button class="billing-override-btn" title="Override this amount">✏</button>
                   </td>`;

            return `<tr class="billing-child-row">
                <td class="billing-indent">${escHtml(c.childName)}</td>
                <td>${escHtml(c.roomLabel)}</td>
                <td class="report-num">${c.fullDays || '—'}</td>
                <td class="report-num">${c.halfDays || '—'}</td>
                <td class="report-num">${discDisplay}</td>
                ${amountCell}
            </tr>${sibRow}${feeRow}`;
        }).join('');

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
            <table class="report-table billing-table" id="billingReportTable">
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

async function exportFamilyBillingReport() {
    const monthVal = document.getElementById('familyBillingMonth')?.value;
    if (!monthVal) { alert('Please select a month first.'); return; }

    let overrideRows = [];
    try { overrideRows = await fetchBillingOverrides(monthVal); } catch (e) { console.warn('fetchBillingOverrides:', e); }
    const overridesMap = new Map(overrideRows.map(r => [
        `${(r.parent_email || '').toLowerCase()}:${(r.child_name || '').toLowerCase()}`,
        parseFloat(r.override_amount),
    ]));

    const families = _buildFamilyBillingData(monthVal, overridesMap);
    if (!families.length) { alert('No data to export.'); return; }

    const rows = [];
    families.forEach(fam => {
        fam.children.forEach(c => {
            const billed = c.hasOverride ? c.overrideAmount : c.subtotal;
            rows.push({
                'Parent Name':        fam.parentName,
                'Email':              fam.parentEmail,
                'Phone':              fam.parentPhone,
                'Child Name':         c.childName,
                'Room':               c.roomLabel,
                'Full Days':          c.fullDays,
                'Half Days':          c.halfDays,
                'Total Days':         (c.fullDays || 0) + (c.halfDays || 0),
                'Discount Type':      c.discLabel,
                'Discount Amount':    c.discountDollar > 0 ? `-$${c.discountDollar.toFixed(2)}` : '—',
                'Sibling Discount':   c.sibDiscount > 0 ? `-$${c.sibDiscount.toFixed(2)}` : '—',
                'Care Amount':        c.hasOverride ? `$${billed.toFixed(2)} (manual)` : `$${billed.toFixed(2)}`,
                'Change Fees':        c.changeFees > 0 ? `$${c.changeFees.toFixed(2)}` : '—',
                'Total Due':          `$${(billed + (c.changeFees || 0)).toFixed(2)}`,
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
    document.getElementById('saveScheduleBtn')?.addEventListener('click', saveStaffSchedule);
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
        // Exclude administrators, directors, assistant directors, and "Other" from auto-assignment
        const active = allStaffData.filter(s => s.active &&
            !/^admin(istrator)?$/i.test((s.role || '').trim()) &&
            !/^(director|asst\.?\s*director)$/i.test((s.role || '').trim()) &&
            !/^other$/i.test((s.role || '').trim()));

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
                const candidates = active.filter(s => {
                    const avail = staffAvailability[s.id];
                    // Determine available days from dayPeriods keys or legacy days array
                    const availDays = avail?.dayPeriods
                        ? Object.keys(avail.dayPeriods).filter(d => avail.dayPeriods[d]?.length > 0)
                        : (avail?.days ?? ['Mon','Tue','Wed','Thu','Fri']);
                    return availDays.includes(dayName) &&
                        (s.room_id === room.id || !s.room_id); // room match or float
                });

                // Sort by hours used ascending so we spread load evenly
                candidates.sort((a, b) => (weeklyHours.get(a.id) || 0) - (weeklyHours.get(b.id) || 0));

                // Assign AM — respect per-day AM availability
                const amCandidates = candidates.filter(s => {
                    const avail = staffAvailability[s.id];
                    if (avail?.dayPeriods) return avail.dayPeriods[dayName]?.includes('am') ?? false;
                    const periods = avail?.periods;
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
                // Respect per-day PM availability
                const pmAvail = candidates.filter(s => {
                    const avail = staffAvailability[s.id];
                    if (avail?.dayPeriods) return avail.dayPeriods[dayName]?.includes('pm') ?? false;
                    const periods = avail?.periods;
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
// SAVE STAFF SCHEDULE
// ============================================================

async function saveStaffSchedule() {
    if (!_autoFillAssignments || !_autoFillWeekDates) {
        alert('Please generate and auto-fill a schedule first.');
        return;
    }

    const btn = document.getElementById('saveScheduleBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
        if (!allStaffData.length) await loadStaffList();

        const count = await saveStaffScheduleWeek(
            _autoFillWeekDates,
            _autoFillAssignments,
            allStaffData
        );

        await logAdminAction('save', 'staff_schedule', null,
            { week_start: _autoFillWeekDates[0], rows_saved: count });

        btn.textContent = `✓ Saved (${count} assignments)`;
        setTimeout(() => {
            btn.disabled    = false;
            btn.textContent = '💾 Save Schedule';
        }, 2500);
    } catch (err) {
        alert('Save failed: ' + err.message);
        btn.disabled    = false;
        btn.textContent = '💾 Save Schedule';
    }
}

// ============================================================

// HISTORICAL PAYROLL RECORDS
// ============================================================

let _historicalPayrollRecords = [];
let _editingHistoricalId = null;

function setupHistoricalPayroll() {
    document.getElementById('addHistoricalPayrollBtn')?.addEventListener('click', () => openHistoricalPayrollForm(null));
    document.getElementById('saveHistoricalPayrollBtn')?.addEventListener('click', saveHistoricalPayrollRecord);
    document.getElementById('cancelHistoricalPayrollBtn')?.addEventListener('click', closeHistoricalPayrollForm);
    loadHistoricalPayroll();
}

async function loadHistoricalPayroll() {
    try {
        _historicalPayrollRecords = await fetchHistoricalPayroll();
        renderHistoricalPayroll();
    } catch (err) {
        const container = document.getElementById('historicalPayrollContent');
        if (container) container.innerHTML = `<p class="import-error">Error loading records: ${escHtml(err.message)}</p>`;
    }
}

function renderHistoricalPayroll() {
    const container = document.getElementById('historicalPayrollContent');
    if (!container) return;
    if (!_historicalPayrollRecords.length) {
        container.innerHTML = '<p class="empty-hint">No historical payroll records yet. Click &ldquo;+ Add Record&rdquo; to add one.</p>';
        return;
    }
    const rows = _historicalPayrollRecords.map(r => `
        <tr>
            <td><strong>${escHtml(r.label)}</strong></td>
            <td class="report-num report-revenue">$${parseFloat(r.total_paid || 0).toFixed(2)}</td>
            <td>${escHtml(r.notes || '—')}</td>
            <td>
                <button class="btn-ghost btn-sm" data-hp-edit="${escHtml(r.id)}">Edit</button>
                <button class="btn-danger btn-sm" data-hp-delete="${escHtml(r.id)}" style="margin-left:4px">Delete</button>
            </td>
        </tr>`).join('');
    container.innerHTML = `
        <div class="table-wrapper report-table-wrap">
            <table class="report-table payroll-table">
                <thead>
                    <tr>
                        <th>Period</th>
                        <th class="report-num">Total Paid</th>
                        <th>Notes</th>
                        <th style="width:140px">Actions</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    container.querySelectorAll('[data-hp-edit]').forEach(btn => {
        btn.addEventListener('click', () => {
            const record = _historicalPayrollRecords.find(r => r.id === btn.dataset.hpEdit);
            if (record) openHistoricalPayrollForm(record);
        });
    });
    container.querySelectorAll('[data-hp-delete]').forEach(btn => {
        btn.addEventListener('click', () => deleteHistoricalPayrollRecord(btn.dataset.hpDelete));
    });
}

function openHistoricalPayrollForm(record) {
    _editingHistoricalId = record ? record.id : null;
    document.getElementById('historicalPayrollFormTitle').textContent =
        record ? 'Edit Historical Payroll Record' : 'Add Historical Payroll Record';
    document.getElementById('hpLabel').value = record?.label || '';
    document.getElementById('hpAmount').value = record?.total_paid != null ? record.total_paid : '';
    document.getElementById('hpNotes').value = record?.notes || '';
    document.getElementById('historicalPayrollFormStatus').textContent = '';
    document.getElementById('historicalPayrollForm').classList.remove('hidden');
    document.getElementById('hpLabel').focus();
}

function closeHistoricalPayrollForm() {
    document.getElementById('historicalPayrollForm').classList.add('hidden');
    _editingHistoricalId = null;
}

async function saveHistoricalPayrollRecord() {
    const label  = document.getElementById('hpLabel').value.trim();
    const amount = document.getElementById('hpAmount').value;
    const notes  = document.getElementById('hpNotes').value.trim();
    const status = document.getElementById('historicalPayrollFormStatus');

    if (!label)  { status.textContent = 'Period label is required.'; return; }
    if (amount === '' || isNaN(parseFloat(amount))) { status.textContent = 'Please enter a valid amount.'; return; }

    const btn = document.getElementById('saveHistoricalPayrollBtn');
    btn.disabled = true;
    status.textContent = 'Saving…';

    try {
        let records = [..._historicalPayrollRecords];
        if (_editingHistoricalId) {
            const idx = records.findIndex(r => r.id === _editingHistoricalId);
            if (idx >= 0) records[idx] = { ...records[idx], label, total_paid: parseFloat(amount), notes };
        } else {
            records.push({ id: crypto.randomUUID(), label, total_paid: parseFloat(amount), notes });
        }
        await saveHistoricalPayroll(records);
        _historicalPayrollRecords = records;
        renderHistoricalPayroll();
        closeHistoricalPayrollForm();
    } catch (err) {
        status.textContent = 'Save failed: ' + err.message;
    } finally {
        btn.disabled = false;
    }
}

async function deleteHistoricalPayrollRecord(id) {
    if (!confirm('Delete this historical payroll record?')) return;
    try {
        const records = _historicalPayrollRecords.filter(r => r.id !== id);
        await saveHistoricalPayroll(records);
        _historicalPayrollRecords = records;
        renderHistoricalPayroll();
    } catch (err) {
        alert('Delete failed: ' + err.message);
    }
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

    // Build per-day detail for each staff member (used by click-to-expand in the report)
    // Each entry: { work_date, hours, source }
    // source: 'manual' = typed in by admin, 'clock-sync' = synced from clock-in, 'clock' = live clock calc
    const periodDetailMap = new Map(); // staff_id → [{ work_date, hours, source }]
    periodHrs.forEach(h => {
        const source = (h.notes || '').toLowerCase().includes('clock') ? 'clock-sync' : 'manual';
        if (!periodDetailMap.has(h.staff_id)) periodDetailMap.set(h.staff_id, []);
        periodDetailMap.get(h.staff_id).push({ work_date: h.work_date, hours: parseFloat(h.hours_worked), source });
    });
    // Add clock-only days (not yet synced to staff_hours)
    const clockOnlyDayMap = new Map(); // `staffId|date` → accumulated hours
    periodClockEvents.forEach(ev => {
        if (manualPeriodKeys.has(manualKey(ev.staff_id, ev.work_date))) return;
        const hrs = calcClockHrs(ev);
        if (hrs <= 0) return;
        const key = manualKey(ev.staff_id, ev.work_date);
        clockOnlyDayMap.set(key, (clockOnlyDayMap.get(key) || 0) + hrs);
    });
    clockOnlyDayMap.forEach((hrs, key) => {
        const [staffId, work_date] = key.split('|');
        if (!periodDetailMap.has(staffId)) periodDetailMap.set(staffId, []);
        periodDetailMap.get(staffId).push({ work_date, hours: hrs, source: 'clock' });
    });
    // Sort each staff's detail entries by date
    periodDetailMap.forEach(entries => entries.sort((a, b) => a.work_date.localeCompare(b.work_date)));

    // Include active staff + anyone with hours in the period
    const staff = allStaff.filter(s => s.active || periodMap.has(s.id));
    staff.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return { staff, periodMap, ytdMap, periodDetailMap };
}

async function generatePayrollReport() {
    const sel = document.getElementById('payrollPeriod');
    if (!sel?.value) { alert('Please select a pay period.'); return; }
    const [startVal, endVal] = sel.value.split('|');

    const container = document.getElementById('payrollContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const { staff, periodMap, ytdMap, periodDetailMap } = await _buildPayrollData(startVal, endVal);
        renderPayrollReport(startVal, endVal, staff, periodMap, ytdMap, periodDetailMap);
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

function renderPayrollReport(startVal, endVal, staff, periodMap, ytdMap, periodDetailMap = new Map()) {
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

        const hasDetail = !isSalary && (periodDetailMap.get(s.id) || []).length > 0;
        const detailRows = (periodDetailMap.get(s.id) || []).map(d => {
            const [dy, dm, dd] = d.work_date.split('-').map(Number);
            const dateLabel = `${MONTH_NAMES_ADMIN[dm - 1]} ${dd}`;
            const sourceChip = d.source === 'clock-sync'
                ? '<span style="font-size:.75em;color:#6b7280">clock sync</span>'
                : d.source === 'clock'
                ? '<span style="font-size:.75em;color:#9a6700">clock only</span>'
                : '<span style="font-size:.75em;color:#166534">manual</span>';
            return `<tr class="payroll-detail-row" style="display:none">
                <td colspan="2" class="billing-indent" style="padding-left:2.5rem">${dateLabel} ${sourceChip}</td>
                <td class="report-num payroll-hrs">${d.hours.toFixed(2)}</td>
                <td colspan="3"></td>
            </tr>`;
        }).join('');

        return `
            <tr class="payroll-staff-row${hasDetail ? ' payroll-expandable' : ''}" data-staff-id="${escHtml(s.id)}" style="${hasDetail ? 'cursor:pointer' : ''}">
                <td>
                    <strong>${escHtml(s.name)}</strong>${inactive}${hasDetail ? ' <span class="payroll-expand-icon" style="font-size:.8em;color:#6b7280">▶</span>' : ''}
                    <br><small class="rates-ages">${escHtml(s.role || '')} · ${escHtml(roomLabel)}</small>
                </td>
                <td>${rateStr}</td>
                <td class="report-num payroll-hrs">${periodHrsStr}</td>
                <td class="report-num report-revenue">${periodPayStr}</td>
                <td class="report-num payroll-hrs">${ytdHrsStr}</td>
                <td class="report-num report-revenue">${ytdPayStr}</td>
            </tr>${detailRows}`;
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

    // Wire up click-to-expand detail rows for hourly staff
    container.querySelectorAll('.payroll-expandable').forEach(row => {
        row.addEventListener('click', () => {
            const icon     = row.querySelector('.payroll-expand-icon');
            let next       = row.nextElementSibling;
            let expanded   = false;
            while (next && next.classList.contains('payroll-detail-row')) {
                const showing = next.style.display !== 'none';
                next.style.display = showing ? 'none' : '';
                expanded = !showing;
                next = next.nextElementSibling;
            }
            if (icon) icon.textContent = expanded ? '▼' : '▶';
        });
    });
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
// ATTENDANCE & REVENUE — unified date-range report
// ============================================================

function setupAttendanceRevenue() {
    // Populate room filter dropdown
    const roomSel = document.getElementById('arRoomFilter');
    if (roomSel) {
        ROOMS.forEach(r => {
            const opt = document.createElement('option');
            opt.value = r.id;
            opt.textContent = r.label;
            roomSel.appendChild(opt);
        });
    }

    // Default: Jan 1 of current year → today
    const today = new Date();
    const todayStr = today.toISOString().substring(0, 10);
    const janFirst = `${today.getFullYear()}-01-01`;
    const fromEl = document.getElementById('arDateFrom');
    const toEl   = document.getElementById('arDateTo');
    if (fromEl) fromEl.value = janFirst;
    if (toEl)   toEl.value   = todayStr;

    document.getElementById('generateArBtn')?.addEventListener('click', generateAttendanceRevenue);
    document.getElementById('exportArBtn')?.addEventListener('click', exportAttendanceRevenue);
}

// Build unified data map for any date range.
// Returns { 'YYYY-MM': { [roomId]: { attendees, netBilled, liveDisc, histDisc? }, _discounts } }
// Historical billing_summary rows take precedence over live calculations for the same room+month.
async function _buildArDataMap(fromDate, toDate) {
    const fromMo = fromDate.substring(0, 7);
    const toMo   = toDate.substring(0, 7);
    const map    = {};

    // Step 1: build from live registrations
    // Ensure family discount data is loaded — it's only lazy-loaded when the Families tab is opened,
    // so a user who goes straight to Reports would have an empty discount map otherwise.
    if (allFamiliesData.length === 0) {
        try {
            allFamiliesData = await fetchAllFamilies({ includeArchived: true });
            _discountMap = null; // force rebuild with freshly loaded data
        } catch (e) { console.warn('Could not load families for discount map:', e); }
    }
    // Fetch all registrations for the report range regardless of when they were submitted.
    // The global allRegistrations only covers recently-submitted registrations (last ~2 months),
    // which would miss families who registered earlier in the year.
    let regsForReport = allRegistrations;
    try {
        regsForReport = await fetchAllRegistrations({ sinceDate: '2020-01-01', untilDate: new Date().toISOString() });
    } catch (e) { console.warn('Could not fetch full registration history; falling back to loaded data:', e); }
    const dmap = getDiscountMap();

    // Fetch billing overrides for every month in the report range
    const overridesByMonth = new Map(); // 'YYYY-MM' → Map(parentEmail:childName → overrideAmount)
    {
        let [oy, om] = fromMo.split('-').map(Number);
        while (true) {
            const mo = `${oy}-${String(om).padStart(2, '0')}`;
            if (mo > toMo) break;
            try {
                const rows = await fetchBillingOverrides(mo);
                overridesByMonth.set(mo, new Map(rows.map(r => [
                    `${(r.parent_email || '').toLowerCase()}:${(r.child_name || '').toLowerCase()}`,
                    parseFloat(r.override_amount),
                ])));
            } catch (e) { console.warn(`fetchBillingOverrides(${mo}):`, e); }
            if (om === 12) { oy++; om = 1; } else { om++; }
        }
    }

    // Group registrations by family so we can compute sibling discounts the same way
    // the Family Billing report does ($10/day off the lower-rate sibling when 2+ attend same day).
    const familyMap = new Map(); // familyKey → [{ reg, room, disc, dates }]
    regsForReport.forEach(reg => {
        const dates = (reg.registration_dates || []).filter(d =>
            !d.waitlisted && d.care_date && d.care_date >= fromDate && d.care_date <= toDate);
        if (!dates.length) return;
        const room = ROOMS.find(r => r.id === reg.room_id);
        if (!room) return;
        const discKey = `${(reg.parent_email || '').toLowerCase()}:${(reg.child_name || '').toLowerCase()}`;
        const disc = dmap.get(discKey) || { type: 'none', value: 0 };
        const familyKey = (reg.parent_email || reg.parent_name || '').toLowerCase().trim();
        if (!familyMap.has(familyKey)) familyMap.set(familyKey, []);
        familyMap.get(familyKey).push({ reg, room, disc, dates });
    });

    for (const regs of familyMap.values()) {
        // Build per-month sibling discount map for this family: mo → childName → totalSibDiscount
        const moSibDisc = new Map();
        regs.forEach(({ reg, room, disc, dates }) => {
            dates.forEach(d => {
                const mo = d.care_date.substring(0, 7);
                const base = d.day_type === 'half' ? (room.halfDayRate || 0) : (room.fullDayRate || 0);
                const eff  = effectiveAdminRate(base, disc.type, disc.value);
                if (!moSibDisc.has(mo)) moSibDisc.set(mo, { dateChildMap: new Map(), sibMap: null });
                const dateMap = moSibDisc.get(mo).dateChildMap;
                if (!dateMap.has(d.care_date)) dateMap.set(d.care_date, []);
                dateMap.get(d.care_date).push({ childName: reg.child_name, effRate: eff });
            });
        });
        // Resolve sibling discounts per date within each month
        for (const moEntry of moSibDisc.values()) {
            const sibMap = new Map();
            for (const children of moEntry.dateChildMap.values()) {
                if (children.length < 2) continue;
                [...children].sort((a, b) => b.effRate - a.effRate).forEach((c, i) => {
                    if (i > 0) sibMap.set(c.childName, (sibMap.get(c.childName) || 0) + Math.min(10, c.effRate));
                });
            }
            moEntry.sibMap = sibMap;
        }

        // Aggregate each child's per-month subtotal to room+month,
        // applying sibling discounts and billing overrides to match Family Billing totals.
        regs.forEach(({ reg, room, disc, dates }) => {
            const overrideKey = `${(reg.parent_email || '').toLowerCase()}:${(reg.child_name || '').toLowerCase()}`;
            // Group dates by month
            const moGroups = new Map();
            dates.forEach(d => {
                const mo = d.care_date.substring(0, 7);
                if (!moGroups.has(mo)) moGroups.set(mo, []);
                moGroups.get(mo).push(d);
            });
            for (const [mo, moDates] of moGroups) {
                let calcSubtotal = 0, baseTotal = 0;
                moDates.forEach(d => {
                    const base = d.day_type === 'half' ? (room.halfDayRate || 0) : (room.fullDayRate || 0);
                    calcSubtotal += effectiveAdminRate(base, disc.type, disc.value);
                    baseTotal    += base;
                });
                const sibTotal = (moSibDisc.get(mo)?.sibMap?.get(reg.child_name)) || 0;
                calcSubtotal = Math.max(0, calcSubtotal - sibTotal);

                const overridesMap  = overridesByMonth.get(mo);
                const billedAmount  = overridesMap?.has(overrideKey) ? overridesMap.get(overrideKey) : calcSubtotal;

                if (!map[mo]) map[mo] = {};
                if (!map[mo][reg.room_id]) map[mo][reg.room_id] = { attendees: 0, netBilled: 0, liveDisc: 0 };
                map[mo][reg.room_id].attendees += moDates.length;
                map[mo][reg.room_id].netBilled += billedAmount;
                map[mo][reg.room_id].liveDisc  += Math.max(0, baseTotal - billedAmount);
            }
        });
    }

    // Step 2: historical billing_summary overwrites live per room+month
    let historical = [];
    try { historical = await fetchBillingSummary(); } catch (e) { console.warn('billing_summary unavailable:', e); }
    historical.forEach(row => {
        const mo = (row.month || '').substring(0, 7);
        if (mo < fromMo || mo > toMo) return;
        if (!map[mo]) map[mo] = {};
        map[mo][row.room_id] = {
            attendees: (row.half_days || 0) + (row.full_days || 0),
            netBilled: parseFloat(row.net_billed) || 0,
            histDisc:  parseFloat(row.discount)   || 0,
            liveDisc:  0,
        };
    });

    // Step 3: sum total discounts per month (historical discount per room takes precedence over live)
    Object.keys(map).forEach(mo => {
        map[mo]._discounts = ROOMS.reduce((sum, r) => {
            const e = map[mo][r.id];
            if (!e) return sum;
            return sum + (e.histDisc != null ? e.histDisc : e.liveDisc || 0);
        }, 0);
    });

    return map;
}

async function generateAttendanceRevenue() {
    const fromDate   = document.getElementById('arDateFrom')?.value;
    const toDate     = document.getElementById('arDateTo')?.value;
    const roomFilter = document.getElementById('arRoomFilter')?.value || '';
    const container  = document.getElementById('arContent');

    if (!fromDate || !toDate) { alert('Please select both a start and end date.'); return; }
    if (fromDate > toDate)    { alert('Start date must be before end date.'); return; }

    container.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        const arMap  = await _buildArDataMap(fromDate, toDate);
        const fromMo = fromDate.substring(0, 7);
        const toMo   = toDate.substring(0, 7);
        const months = Object.keys(arMap).sort().filter(mo => mo >= fromMo && mo <= toMo);

        if (!months.length) {
            container.innerHTML = '<p class="empty-hint">No attendance or revenue data found for the selected date range.</p>';
            return;
        }

        const rooms = roomFilter ? ROOMS.filter(r => r.id === roomFilter) : ROOMS;
        const showTotalCol = rooms.length > 1;

        // Accumulate totals per room
        const roomTotals = {};
        rooms.forEach(r => { roomTotals[r.id] = { attendees: 0, netBilled: 0 }; });
        let grandAttendees = 0, grandRevenue = 0, grandDiscounts = 0;

        const fmtRev = v => v > 0 ? `$${Math.round(v).toLocaleString('en-US')}` : '—';

        const rowsHtml = months.map(mo => {
            const [y, m] = mo.split('-').map(Number);
            const label  = MONTH_NAMES_ADMIN[m - 1] + ' ' + y;
            let moAttendees = 0, moRevenue = 0;

            const cells = rooms.map(r => {
                const e   = arMap[mo]?.[r.id];
                const att = e?.attendees || 0;
                const rev = e?.netBilled || 0;
                roomTotals[r.id].attendees += att;
                roomTotals[r.id].netBilled += rev;
                moAttendees += att;
                moRevenue   += rev;
                return `<td class="report-num">${att > 0 ? att.toLocaleString() : '—'}</td>` +
                       `<td class="report-num report-revenue">${fmtRev(rev)}</td>`;
            }).join('');

            grandAttendees += moAttendees;
            grandRevenue   += moRevenue;
            grandDiscounts += arMap[mo]._discounts || 0;

            const totalCols = showTotalCol
                ? `<td class="report-num ar-total-col"><strong>${moAttendees > 0 ? moAttendees.toLocaleString() : '—'}</strong></td>` +
                  `<td class="report-num report-revenue ar-total-col"><strong>${fmtRev(moRevenue)}</strong></td>`
                : '';

            return `<tr class="ar-editable-row" data-month="${mo}" style="cursor:pointer" title="Click to edit">
                        <td class="staff-date-cell">${label}</td>
                        ${cells}${totalCols}
                    </tr>`;
        }).join('');

        // Build header rows
        const roomColHeaders = rooms.map(r =>
            `<th colspan="2" class="ar-room-header">${r.label}</th>`
        ).join('');
        const roomSubHeaders = rooms.map(() =>
            `<th class="report-num ar-sub-header">Attendees</th><th class="report-num ar-sub-header">Net Billed</th>`
        ).join('');
        const totalColHeader    = showTotalCol ? '<th colspan="2" class="ar-room-header ar-total-col">Total</th>' : '';
        const totalSubHeader    = showTotalCol ? '<th class="report-num ar-sub-header ar-total-col">Attendees</th><th class="report-num ar-sub-header ar-total-col">Net Billed</th>' : '';

        // Totals row
        const n = months.length;
        const totalCells = rooms.map(r => {
            const t = roomTotals[r.id];
            return `<td class="report-num"><strong>${t.attendees > 0 ? t.attendees.toLocaleString() : '—'}</strong></td>` +
                   `<td class="report-num report-revenue"><strong>${fmtRev(t.netBilled)}</strong></td>`;
        }).join('');
        const grandTotalCols = showTotalCol
            ? `<td class="report-num ar-total-col"><strong>${grandAttendees > 0 ? grandAttendees.toLocaleString() : '—'}</strong></td>` +
              `<td class="report-num report-revenue ar-total-col"><strong>${fmtRev(grandRevenue)}</strong></td>`
            : '';

        // Averages row
        const avgCells = rooms.map(r => {
            const t      = roomTotals[r.id];
            const avgAtt = n > 0 ? Math.round(t.attendees / n) : 0;
            const avgRev = n > 0 ? t.netBilled / n : 0;
            return `<td class="report-num">${avgAtt > 0 ? avgAtt.toLocaleString() : '—'}</td>` +
                   `<td class="report-num report-revenue">${fmtRev(avgRev)}</td>`;
        }).join('');
        const grandAvgCols = showTotalCol
            ? `<td class="report-num ar-total-col">${n > 0 ? Math.round(grandAttendees / n).toLocaleString() : '—'}</td>` +
              `<td class="report-num report-revenue ar-total-col">${fmtRev(n > 0 ? grandRevenue / n : 0)}</td>`
            : '';

        const discStr = grandDiscounts > 0
            ? `-$${Math.round(grandDiscounts).toLocaleString('en-US')}`
            : '$0';

        container.innerHTML = `
            <div class="ar-summary-meta">
                <span class="ar-total-badge">$${Math.round(grandRevenue).toLocaleString('en-US')} total revenue</span>
                <span class="ar-discount-badge ytd-discount-total">${discStr} in discounts</span>
                <span class="ar-hint">Click a month row to edit its data.</span>
                <button type="button" class="btn-secondary ar-add-month-btn" id="arAddMonthBtn">+ Add Month</button>
            </div>
            <div class="table-wrapper report-table-wrap">
                <table class="report-table ar-summary-table" id="arSummaryTable">
                    <thead>
                        <tr>
                            <th rowspan="2" class="ar-month-th">Month</th>
                            ${roomColHeaders}${totalColHeader}
                        </tr>
                        <tr>${roomSubHeaders}${totalSubHeader}</tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                    <tfoot>
                        <tr class="report-total-row">
                            <td><strong>Totals</strong></td>
                            ${totalCells}${grandTotalCols}
                        </tr>
                        <tr class="report-total-row ar-avg-row">
                            <td><em>Monthly Avg</em></td>
                            ${avgCells}${grandAvgCols}
                        </tr>
                    </tfoot>
                </table>
            </div>`;

        // Wire up click-to-edit on month rows
        container.querySelectorAll('.ar-editable-row').forEach(row => {
            row.addEventListener('click', () => _arStartEdit(row, arMap, rooms, showTotalCol));
        });

        // Wire up Add Month button
        document.getElementById('arAddMonthBtn')?.addEventListener('click', () => {
            _arShowAddMonthForm(container, rooms);
        });

    } catch (err) {
        container.innerHTML = `<p class="import-error">Error loading data: ${escHtml(err.message)}</p>`;
    }
}


// ── Inline Edit: click a month row to edit attendees + net billed per room ──

function _arStartEdit(row, arMap, rooms, showTotalCol) {
    // Prevent double-entry
    if (row.classList.contains('ar-editing')) return;
    row.classList.add('ar-editing');

    const mo = row.dataset.month;
    const fmtRev = v => v > 0 ? `$${Math.round(v).toLocaleString('en-US')}` : '—';

    // Replace each room's two cells with inputs
    const cells = row.querySelectorAll('td');
    // cells[0] is the month label; then pairs of (attendees, netBilled) per room; then optional total pair
    const inputs = []; // collect { roomId, attInput, revInput }
    rooms.forEach((r, i) => {
        const attTd = cells[1 + i * 2];
        const revTd = cells[1 + i * 2 + 1];
        const e     = arMap[mo]?.[r.id];
        const att   = e?.attendees || 0;
        const rev   = e?.netBilled || 0;

        const attInput = document.createElement('input');
        attInput.type = 'number';
        attInput.min  = '0';
        attInput.value = att;
        attInput.className = 'ar-edit-input ar-edit-att';
        attInput.title = `${r.label} – Attendees`;

        const revInput = document.createElement('input');
        revInput.type = 'number';
        revInput.min  = '0';
        revInput.step = '0.01';
        revInput.value = rev > 0 ? rev.toFixed(2) : '0';
        revInput.className = 'ar-edit-input ar-edit-rev';
        revInput.title = `${r.label} – Net Billed`;

        attTd.textContent = '';
        attTd.appendChild(attInput);
        revTd.textContent = '';
        revTd.appendChild(revInput);

        inputs.push({ roomId: r.id, attInput, revInput });
    });

    // Replace total columns (if shown) with a placeholder
    if (showTotalCol) {
        const totalAttTd = cells[1 + rooms.length * 2];
        const totalRevTd = cells[1 + rooms.length * 2 + 1];
        if (totalAttTd) totalAttTd.innerHTML = '<em>—</em>';
        if (totalRevTd) totalRevTd.innerHTML = '<em>—</em>';
    }

    // Replace month label cell with save/cancel/clear buttons
    const labelTd = cells[0];
    const [y, m] = mo.split('-').map(Number);
    const label   = MONTH_NAMES_ADMIN[m - 1] + ' ' + y;
    labelTd.innerHTML = `
        <span class="ar-edit-label">${escHtml(label)}</span>
        <div class="ar-edit-actions">
            <button type="button" class="btn-primary ar-save-btn" title="Save changes">Save</button>
            <button type="button" class="btn-secondary ar-cancel-btn" title="Cancel editing">Cancel</button>
            <button type="button" class="btn-danger ar-clear-btn" title="Delete saved data for this month and revert to live calculated data">Clear (use live data)</button>
        </div>`;

    // Stop clicks on inputs/buttons from re-triggering row click
    labelTd.addEventListener('click', e => e.stopPropagation());
    inputs.forEach(({ attInput, revInput }) => {
        attInput.addEventListener('click', e => e.stopPropagation());
        revInput.addEventListener('click', e => e.stopPropagation());
    });

    // Cancel → re-generate
    labelTd.querySelector('.ar-cancel-btn').addEventListener('click', e => {
        e.stopPropagation();
        generateAttendanceRevenue();
    });

    // Clear → delete all billing_summary rows for this month, revert to live data
    labelTd.querySelector('.ar-clear-btn').addEventListener('click', async e => {
        e.stopPropagation();
        if (!confirm(`Delete all saved billing data for ${label} and revert to live calculated data?`)) return;
        const clearBtn = e.target;
        clearBtn.disabled = true;
        clearBtn.textContent = 'Clearing…';
        try {
            const monthDate = `${mo}-01`;
            for (const r of rooms) {
                await deleteBillingSummary(monthDate, r.id);
            }
            await generateAttendanceRevenue();
        } catch (err) {
            alert('Error clearing data: ' + err.message);
            clearBtn.disabled = false;
            clearBtn.textContent = 'Clear (use live data)';
        }
    });

    // Save → upsert each room's billing_summary, then re-generate
    labelTd.querySelector('.ar-save-btn').addEventListener('click', async e => {
        e.stopPropagation();
        const saveBtn = e.target;
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';

        try {
            const monthDate = `${mo}-01`; // e.g. "2026-03-01"
            for (const { roomId, attInput, revInput } of inputs) {
                const attendees = parseInt(attInput.value, 10) || 0;
                const netBilled = parseFloat(revInput.value) || 0;
                await upsertBillingSummary({
                    month:      monthDate,
                    room_id:    roomId,
                    half_days:  null,
                    full_days:  attendees,
                    net_billed: netBilled,
                    data_source: 'admin_edit',
                });
            }
            await generateAttendanceRevenue();
        } catch (err) {
            alert('Error saving: ' + err.message);
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save';
        }
    });
}

// ── Add Month: show a form to add a new month of data ──

function _arShowAddMonthForm(container, rooms) {
    // Don't add twice
    if (document.getElementById('arAddMonthForm')) return;

    const roomInputs = rooms.map(r => `
        <tr>
            <td class="ar-add-room-label">${r.label}</td>
            <td><input type="number" min="0" value="0" class="ar-edit-input ar-edit-att" data-room="${r.id}" data-field="attendees" title="Attendees"></td>
            <td><input type="number" min="0" step="0.01" value="0" class="ar-edit-input ar-edit-rev" data-room="${r.id}" data-field="netBilled" title="Net Billed"></td>
        </tr>
    `).join('');

    const formHtml = `
        <div id="arAddMonthForm" class="ar-add-month-form">
            <h3>Add New Month</h3>
            <div class="ar-add-month-field">
                <label for="arNewMonth">Month</label>
                <input type="month" id="arNewMonth" required>
            </div>
            <table class="ar-add-month-table">
                <thead>
                    <tr>
                        <th>Room</th>
                        <th>Attendees</th>
                        <th>Net Billed ($)</th>
                    </tr>
                </thead>
                <tbody>${roomInputs}</tbody>
            </table>
            <div class="ar-add-month-actions">
                <button type="button" class="btn-primary" id="arAddMonthSave">Save Month</button>
                <button type="button" class="btn-secondary" id="arAddMonthCancel">Cancel</button>
            </div>
        </div>`;

    container.insertAdjacentHTML('afterbegin', formHtml);

    document.getElementById('arAddMonthCancel').addEventListener('click', () => {
        document.getElementById('arAddMonthForm')?.remove();
    });

    document.getElementById('arAddMonthSave').addEventListener('click', async () => {
        const monthVal = document.getElementById('arNewMonth')?.value;
        if (!monthVal) { alert('Please select a month.'); return; }

        const saveBtn = document.getElementById('arAddMonthSave');
        saveBtn.disabled = true;
        saveBtn.textContent = 'Saving…';

        try {
            const monthDate = `${monthVal}-01`;
            const form = document.getElementById('arAddMonthForm');
            const attInputs = form.querySelectorAll('[data-field="attendees"]');
            const revInputs = form.querySelectorAll('[data-field="netBilled"]');

            for (let i = 0; i < attInputs.length; i++) {
                const roomId    = attInputs[i].dataset.room;
                const attendees = parseInt(attInputs[i].value, 10) || 0;
                const netBilled = parseFloat(revInputs[i].value) || 0;
                if (attendees === 0 && netBilled === 0) continue; // skip empty rooms
                await upsertBillingSummary({
                    month:      monthDate,
                    room_id:    roomId,
                    half_days:  null,
                    full_days:  attendees,
                    net_billed: netBilled,
                    data_source: 'admin_entry',
                });
            }

            // Update the date range to include the new month and regenerate
            const newFrom = document.getElementById('arDateFrom');
            const newTo   = document.getElementById('arDateTo');
            if (newFrom && monthDate < newFrom.value) newFrom.value = monthDate;
            if (newTo && monthDate > newTo.value) newTo.value = monthDate;

            await generateAttendanceRevenue();
        } catch (err) {
            alert('Error saving month: ' + err.message);
            saveBtn.disabled = false;
            saveBtn.textContent = 'Save Month';
        }
    });
}

async function exportAttendanceRevenue() {
    const fromDate   = document.getElementById('arDateFrom')?.value;
    const toDate     = document.getElementById('arDateTo')?.value;
    const roomFilter = document.getElementById('arRoomFilter')?.value || '';
    if (!fromDate || !toDate) { alert('Please generate a report first.'); return; }

    let arMap;
    try {
        arMap = await _buildArDataMap(fromDate, toDate);
    } catch (err) {
        alert('Error loading data: ' + err.message);
        return;
    }

    const fromMo = fromDate.substring(0, 7);
    const toMo   = toDate.substring(0, 7);
    const months = Object.keys(arMap).sort().filter(mo => mo >= fromMo && mo <= toMo);
    if (!months.length) { alert('No data to export.'); return; }

    const rooms = roomFilter ? ROOMS.filter(r => r.id === roomFilter) : ROOMS;

    const rows = months.map(mo => {
        const [y, m] = mo.split('-').map(Number);
        const row    = { Month: MONTH_NAMES_ADMIN[m - 1] + ' ' + y };
        rooms.forEach(r => {
            const e = arMap[mo]?.[r.id];
            row[`${r.label} – Attendees`]  = e?.attendees  || 0;
            row[`${r.label} – Net Billed`] = e?.netBilled  ? `$${e.netBilled.toFixed(2)}` : '$0.00';
        });
        const totalAtt = rooms.reduce((s, r) => s + (arMap[mo]?.[r.id]?.attendees || 0), 0);
        const totalRev = rooms.reduce((s, r) => s + (arMap[mo]?.[r.id]?.netBilled || 0), 0);
        row['Total Attendees']   = totalAtt;
        row['Total Revenue']     = `$${totalRev.toFixed(2)}`;
        row['Total Discounts']   = arMap[mo]._discounts > 0 ? `-$${arMap[mo]._discounts.toFixed(2)}` : '$0.00';
        return row;
    });

    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Attendance-Revenue');
    const roomSuffix = roomFilter ? `_${roomFilter}` : '';
    XLSX.writeFile(wb, `attendance-revenue_${fromDate}_to_${toDate}${roomSuffix}.xlsx`);
}

// ============================================================
// EXTRA REPORTS  (Enrollment Trends · Waitlist Demand)
// ============================================================
function setupExtraReports() {
    document.getElementById('generateTrendsBtn')?.addEventListener('click', generateEnrollmentTrends);
    document.getElementById('exportTrendsBtn')?.addEventListener('click', exportEnrollmentTrends);
    document.getElementById('generateRoomPnlBtn')?.addEventListener('click', generateRoomPnl);
    document.getElementById('exportRoomPnlBtn')?.addEventListener('click', exportRoomPnl);

    // Default P&L date range: first of current month → today
    const today = new Date().toISOString().split('T')[0];
    const firstOfMonth = today.substring(0, 7) + '-01';
    const pnlFrom = document.getElementById('pnlDateFrom');
    const pnlTo   = document.getElementById('pnlDateTo');
    if (pnlFrom && !pnlFrom.value) pnlFrom.value = firstOfMonth;
    if (pnlTo   && !pnlTo.value)   pnlTo.value   = today;
}

// ============================================================
// ROOM P&L REPORT
// ============================================================

/**
 * Builds per-room, per-month P&L data.
 * Revenue comes from _buildArDataMap (same as Attendance & Revenue report).
 * Labor cost comes from saved staff_schedules:
 *   - Hourly staff: hourly_rate × shift_hours per assignment
 *   - Salary staff: (salary_biweekly / 10) prorated by shift hours across rooms on the same day
 *
 * Returns { months, rooms, data }
 *   data[mo][roomId] = { revenue, labor, margin, attendees }
 */
async function _buildRoomPnlData(fromDate, toDate) {
    const fromMo = fromDate.substring(0, 7);
    const toMo   = toDate.substring(0, 7);

    // Fetch revenue and schedule data in parallel
    const [arMap, scheduleRows] = await Promise.all([
        _buildArDataMap(fromDate, toDate),
        fetchStaffScheduleRange(fromDate, toDate).catch(e => {
            console.warn('fetchStaffScheduleRange failed:', e);
            return [];
        }),
    ]);

    // ── Labor cost calculation ──────────────────────────────
    // Group schedule rows by staff+date so salaried staff can be prorated across rooms
    const staffDayMap = new Map(); // `staffId|date` → [row, ...]
    scheduleRows.forEach(row => {
        const key = `${row.staff_id}|${row.work_date}`;
        if (!staffDayMap.has(key)) staffDayMap.set(key, []);
        staffDayMap.get(key).push(row);
    });

    // Accumulate labor cost per room per month
    const laborMap = new Map(); // `mo|roomId` → cost
    staffDayMap.forEach(shifts => {
        const mo        = shifts[0].work_date.substring(0, 7);
        const payType   = shifts[0].pay_type;
        const totalHrs  = shifts.reduce((s, r) => s + (SHIFT_HRS[r.shift] || 0), 0);

        shifts.forEach(r => {
            const mapKey = `${mo}|${r.room_id}`;
            let cost = 0;
            if (payType === 'salary') {
                // Daily cost = biweekly salary / 10 working days, prorated by this shift's hours
                const dailyCost = (r.salary_biweekly || 0) / 10;
                cost = totalHrs > 0 ? dailyCost * ((SHIFT_HRS[r.shift] || 0) / totalHrs) : 0;
            } else {
                cost = (r.hourly_rate || 0) * (SHIFT_HRS[r.shift] || 0);
            }
            laborMap.set(mapKey, (laborMap.get(mapKey) || 0) + cost);
        });
    });

    // ── Fallback: center-wide labor from staff_hours when no schedule data ─
    // When schedules haven't been saved, compute total labor per month from
    // actual clock/manual hours so the P&L still shows meaningful totals.
    const centerLaborByMonth = {}; // mo → total cost (only populated when no schedule data)
    if (scheduleRows.length === 0) {
        try {
            const hoursRows = await fetchStaffHoursWithPay(fromDate, toDate);
            hoursRows.forEach(h => {
                const mo = h.work_date.substring(0, 7);
                if (mo < fromMo || mo > toMo) return;
                let cost = 0;
                if (h.pay_type === 'salary') {
                    // Each hours entry = 1 working day
                    cost = h.salary_biweekly / 10;
                } else {
                    cost = h.hourly_rate * h.hours_worked;
                }
                centerLaborByMonth[mo] = (centerLaborByMonth[mo] || 0) + cost;
            });
        } catch (e) {
            console.warn('Center-wide labor fallback failed:', e);
        }
    }

    // ── Merge revenue + labor into a unified data map ───────
    const data  = {};
    const rooms = ROOMS.filter(r => r.status !== 'seasonal');

    // Seed months from AR data
    Object.keys(arMap).sort().forEach(mo => {
        if (mo < fromMo || mo > toMo) return;
        data[mo] = {};
        rooms.forEach(r => {
            const rev  = arMap[mo]?.[r.id]?.netBilled  || 0;
            const att  = arMap[mo]?.[r.id]?.attendees  || 0;
            const lab  = laborMap.get(`${mo}|${r.id}`) || 0;
            data[mo][r.id] = { revenue: rev, labor: lab, margin: rev - lab, attendees: att };
        });
    });

    // Also seed months that have labor but no AR entries
    laborMap.forEach((cost, key) => {
        const [mo, roomId] = key.split('|');
        if (mo < fromMo || mo > toMo) return;
        if (!data[mo]) data[mo] = {};
        if (!data[mo][roomId]) data[mo][roomId] = { revenue: 0, labor: 0, margin: 0, attendees: 0 };
        data[mo][roomId].labor   = cost;
        data[mo][roomId].margin  = data[mo][roomId].revenue - cost;
    });

    // Seed months that only have center labor fallback
    Object.keys(centerLaborByMonth).forEach(mo => {
        if (!data[mo]) data[mo] = {};
    });

    const months = Object.keys(data).sort();
    const hasFallbackLabor = scheduleRows.length === 0 && Object.keys(centerLaborByMonth).length > 0;
    return { months, rooms, data, hasScheduleData: scheduleRows.length > 0, centerLaborByMonth, hasFallbackLabor };
}

async function generateRoomPnl() {
    const fromDate  = document.getElementById('pnlDateFrom')?.value;
    const toDate    = document.getElementById('pnlDateTo')?.value;
    const container = document.getElementById('roomPnlContent');

    if (!fromDate || !toDate) { alert('Please select both a start and end date.'); return; }
    if (fromDate > toDate)    { alert('Start date must be before end date.'); return; }

    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const { months, rooms, data, hasScheduleData, centerLaborByMonth, hasFallbackLabor } = await _buildRoomPnlData(fromDate, toDate);

        if (!months.length) {
            container.innerHTML = '<p class="empty-hint">No data found for the selected range.</p>';
            return;
        }

        const fmt$  = v => v !== 0 ? `$${Math.round(Math.abs(v)).toLocaleString('en-US')}` : '—';
        const fmtPct = v => isFinite(v) && v !== 0 ? `${Math.round(v)}%` : '—';
        const marginStyle = v => v < 0 ? ' style="color:#c62828"' : v > 0 ? ' style="color:#2e7d32"' : '';

        // Totals accumulators
        const roomTotals = {};
        rooms.forEach(r => { roomTotals[r.id] = { revenue: 0, labor: 0, margin: 0, attendees: 0 }; });
        let grandRev = 0, grandLab = 0;

        const rowsHtml = months.map(mo => {
            const [y, m] = mo.split('-').map(Number);
            const label  = MONTH_NAMES_ADMIN[m - 1] + ' ' + y;
            let moRev = 0, moLab = 0;

            const cells = rooms.map(r => {
                const d   = data[mo]?.[r.id] || { revenue: 0, labor: 0, margin: 0, attendees: 0 };
                const pct = d.revenue > 0 ? (d.margin / d.revenue) * 100 : (d.labor > 0 ? -100 : 0);
                roomTotals[r.id].revenue   += d.revenue;
                roomTotals[r.id].labor     += d.labor;
                roomTotals[r.id].margin    += d.margin;
                roomTotals[r.id].attendees += d.attendees;
                moRev += d.revenue;
                // Only add room labor to moLab when we have schedule data (otherwise use center total below)
                if (hasScheduleData) moLab += d.labor;
                return `<td class="report-num report-revenue">${d.revenue > 0 ? fmt$(d.revenue) : '—'}</td>` +
                       `<td class="report-num">${d.labor > 0 ? fmt$(d.labor) : '—'}</td>` +
                       `<td class="report-num"${marginStyle(d.margin)}>${d.revenue > 0 || d.labor > 0 ? (d.margin < 0 ? '−' : '') + fmt$(d.margin) : '—'}</td>` +
                       `<td class="report-num"${marginStyle(pct)}>${d.revenue > 0 || d.labor > 0 ? fmtPct(pct) : '—'}</td>`;
            }).join('');

            // Use center-wide fallback labor for the totals column when no schedule data
            const centerLab = hasFallbackLabor ? (centerLaborByMonth[mo] || 0) : 0;
            moLab = hasScheduleData ? moLab : centerLab;

            grandRev += moRev;
            grandLab += moLab;
            const moMargin = moRev - moLab;
            const moPct    = moRev > 0 ? (moMargin / moRev) * 100 : 0;

            const labCell  = moLab > 0 ? fmt$(moLab) : '—';
            const labNote  = hasFallbackLabor && centerLab > 0 ? ' <span title="Center-wide total from logged hours — save room schedules for per-room breakdown" style="font-size:0.75em;opacity:0.7">*</span>' : '';

            return `<tr>
                <td class="staff-date-cell">${label}</td>
                ${cells}
                <td class="report-num report-revenue ar-total-col"><strong>${moRev > 0 ? fmt$(moRev) : '—'}</strong></td>
                <td class="report-num ar-total-col"><strong>${labCell}${labNote}</strong></td>
                <td class="report-num ar-total-col"${marginStyle(moMargin)}><strong>${moRev > 0 || moLab > 0 ? (moMargin < 0 ? '−' : '') + fmt$(moMargin) : '—'}</strong></td>
                <td class="report-num ar-total-col"${marginStyle(moPct)}><strong>${moRev > 0 || moLab > 0 ? fmtPct(moPct) : '—'}</strong></td>
            </tr>`;
        }).join('');

        const roomColHeaders = rooms.map(r =>
            `<th colspan="4" class="ar-room-header">${r.label}</th>`).join('');
        const roomSubHeaders = rooms.map(() =>
            `<th class="report-num ar-sub-header">Revenue</th>` +
            `<th class="report-num ar-sub-header">Labor</th>` +
            `<th class="report-num ar-sub-header">Margin $</th>` +
            `<th class="report-num ar-sub-header">Margin %</th>`).join('');

        const totalCells = rooms.map(r => {
            const t   = roomTotals[r.id];
            const pct = t.revenue > 0 ? (t.margin / t.revenue) * 100 : 0;
            return `<td class="report-num report-revenue"><strong>${fmt$(t.revenue)}</strong></td>` +
                   `<td class="report-num"><strong>${t.labor > 0 ? fmt$(t.labor) : '—'}</strong></td>` +
                   `<td class="report-num"${marginStyle(t.margin)}><strong>${t.labor > 0 || t.revenue > 0 ? (t.margin < 0 ? '−' : '') + fmt$(t.margin) : '—'}</strong></td>` +
                   `<td class="report-num"${marginStyle(pct)}><strong>${t.revenue > 0 ? fmtPct(pct) : '—'}</strong></td>`;
        }).join('');

        const grandMargin = grandRev - grandLab;
        const grandPct    = grandRev > 0 ? (grandMargin / grandRev) * 100 : 0;

        let laborBanner = '';
        if (!hasScheduleData) {
            if (hasFallbackLabor) {
                laborBanner = `<p class="import-warning" style="margin-bottom:8px;background:#fff3e0;color:#e65100;padding:8px 12px;border-radius:4px;border-left:3px solid #ff9800">
                    ⚠️ No saved room schedules found — labor totals (*) are center-wide from logged staff hours and cannot be broken down by room.
                    Save schedules on the Staffing tab to enable per-room labor allocation.
                </p>`;
            } else {
                laborBanner = `<p class="import-error" style="margin-bottom:8px">
                    ⚠️ No schedule or staff hours data found for this period — labor costs show as $0.
                    Use the Staffing tab to auto-fill and save schedules.
                </p>`;
            }
        }

        container.innerHTML = `
            ${laborBanner}
            <div class="ar-summary-meta">
                <span class="ar-total-badge">$${Math.round(grandRev).toLocaleString('en-US')} revenue</span>
                <span class="ar-discount-badge">$${Math.round(grandLab).toLocaleString('en-US')} labor${hasFallbackLabor ? '*' : ''}</span>
                <span class="ar-total-badge" style="background:${grandMargin >= 0 ? '#e8f5e9;color:#2e7d32' : '#ffebee;color:#c62828'}">$${Math.round(Math.abs(grandMargin)).toLocaleString('en-US')} ${grandMargin >= 0 ? 'margin' : 'loss'} (${Math.round(grandPct)}%)</span>
            </div>
            <div class="table-wrapper report-table-wrap">
                <table class="report-table ar-summary-table">
                    <thead>
                        <tr>
                            <th rowspan="2" class="ar-month-th">Month</th>
                            ${roomColHeaders}
                            <th colspan="4" class="ar-room-header ar-total-col">Total</th>
                        </tr>
                        <tr>${roomSubHeaders}
                            <th class="report-num ar-sub-header ar-total-col">Revenue</th>
                            <th class="report-num ar-sub-header ar-total-col">Labor</th>
                            <th class="report-num ar-sub-header ar-total-col">Margin $</th>
                            <th class="report-num ar-sub-header ar-total-col">Margin %</th>
                        </tr>
                    </thead>
                    <tbody>${rowsHtml}</tbody>
                    <tfoot>
                        <tr class="report-total-row">
                            <td><strong>Totals</strong></td>
                            ${totalCells}
                            <td class="report-num report-revenue ar-total-col"><strong>${fmt$(grandRev)}</strong></td>
                            <td class="report-num ar-total-col"><strong>${fmt$(grandLab)}${hasFallbackLabor ? '*' : ''}</strong></td>
                            <td class="report-num ar-total-col"${marginStyle(grandMargin)}><strong>${(grandMargin < 0 ? '−' : '') + fmt$(grandMargin)}</strong></td>
                            <td class="report-num ar-total-col"${marginStyle(grandPct)}><strong>${fmtPct(grandPct)}</strong></td>
                        </tr>
                    </tfoot>
                </table>
            </div>`;
    } catch (err) {
        container.innerHTML = `<p class="import-error">Error loading data: ${escHtml(err.message)}</p>`;
    }
}

async function exportRoomPnl() {
    const fromDate = document.getElementById('pnlDateFrom')?.value;
    const toDate   = document.getElementById('pnlDateTo')?.value;
    if (!fromDate || !toDate) { alert('Please select a date range first.'); return; }

    const { months, rooms, data, hasScheduleData, centerLaborByMonth, hasFallbackLabor } = await _buildRoomPnlData(fromDate, toDate);
    const fmtPct = v => isFinite(v) && v !== 0 ? `${Math.round(v)}%` : '';

    const rows = months.map(mo => {
        const [y, m] = mo.split('-').map(Number);
        const row    = { Month: MONTH_NAMES_ADMIN[m - 1] + ' ' + y };
        rooms.forEach(r => {
            const d   = data[mo]?.[r.id] || { revenue: 0, labor: 0, margin: 0 };
            const pct = d.revenue > 0 ? (d.margin / d.revenue) * 100 : 0;
            row[`${r.label} Revenue`] = d.revenue ? `$${d.revenue.toFixed(2)}` : '';
            row[`${r.label} Labor`]   = d.labor   ? `$${d.labor.toFixed(2)}`   : '';
            row[`${r.label} Margin`]  = d.revenue || d.labor ? `$${d.margin.toFixed(2)}` : '';
            row[`${r.label} Margin%`] = d.revenue || d.labor ? fmtPct(pct) : '';
        });
        const moRev = rooms.reduce((s, r) => s + (data[mo]?.[r.id]?.revenue || 0), 0);
        // Use center-wide fallback when no schedule data, else sum room labors
        const moLab = hasScheduleData
            ? rooms.reduce((s, r) => s + (data[mo]?.[r.id]?.labor || 0), 0)
            : (centerLaborByMonth[mo] || 0);
        row['Total Revenue'] = `$${moRev.toFixed(2)}`;
        row['Total Labor']   = moLab ? `$${moLab.toFixed(2)}${hasFallbackLabor ? ' (center total)' : ''}` : '';
        row['Total Margin']  = `$${(moRev - moLab).toFixed(2)}`;
        row['Margin %']      = moRev > 0 ? fmtPct(((moRev - moLab) / moRev) * 100) : '';
        return row;
    });

    if (!rows.length) { alert('No data to export.'); return; }
    downloadXlsx(rows, `room-pnl-${fromDate}-${toDate}.xlsx`);
}

// ── Enrollment Trends ──────────────────────────────────────
// trendMap shape:
// { 'YYYY-MM': { _historical: bool, [roomId]: { Mon:{half,full}, Tue:{half,full}, ... } } }

const TREND_DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
function _trendDayName(dateStr) {
    const idx = new Date(dateStr + 'T12:00:00').getDay() - 1; // 0=Mon..4=Fri
    return idx >= 0 && idx <= 4 ? TREND_DAYS[idx] : null;
}
function _trendCell(map, roomId, day) {
    return map[roomId]?.[day] || { halfSum: 0, fullSum: 0, dates: new Set() };
}

async function _buildTrendMap() {
    const trendMap = {};

    function ensureRoom(mo, roomId) {
        if (!trendMap[mo]) trendMap[mo] = { _historical: false };
        if (!trendMap[mo][roomId]) {
            trendMap[mo][roomId] = {};
            TREND_DAYS.forEach(d => { trendMap[mo][roomId][d] = { halfSum: 0, fullSum: 0, dates: new Set() }; });
        }
    }

    // Fetch all registrations across all time (not the date-limited cache)
    const allRegs = await fetchAllRegistrations({ sinceDate: '2000-01-01T00:00:00Z' });

    // Build a per-date accumulator: date → roomId → { half, full }
    const liveDateMap = {};
    allRegs.forEach(reg => {
        (reg.registration_dates || []).forEach(d => {
            if (d.waitlisted || !d.care_date) return;
            if (!liveDateMap[d.care_date]) liveDateMap[d.care_date] = {};
            if (!liveDateMap[d.care_date][reg.room_id]) liveDateMap[d.care_date][reg.room_id] = { half: 0, full: 0 };
            if (d.day_type === 'half') liveDateMap[d.care_date][reg.room_id].half++;
            else                       liveDateMap[d.care_date][reg.room_id].full++;
        });
    });

    // Fold per-date data into trendMap
    Object.entries(liveDateMap).forEach(([date, rooms]) => {
        const day = _trendDayName(date);
        if (!day) return;
        const mo = date.substring(0, 7);
        Object.entries(rooms).forEach(([roomId, counts]) => {
            ensureRoom(mo, roomId);
            trendMap[mo][roomId][day].halfSum += counts.half;
            trendMap[mo][roomId][day].fullSum += counts.full;
            trendMap[mo][roomId][day].dates.add(date);
        });
    });

    // Historical attendance_summary — overrides any live data for matching months
    let historical = [];
    try { historical = await fetchAttendanceSummary(); } catch (e) { console.warn('Could not load attendance_summary:', e); }

    // Group by month first so we can flag entire months as historical
    const histByMonth = {};
    historical.forEach(row => {
        const mo = (row.summary_date || '').substring(0, 7);
        const day = _trendDayName(row.summary_date);
        if (!mo || !day) return;
        if (!histByMonth[mo]) histByMonth[mo] = [];
        // Bear Room Jan/Feb has no half/full split — fall back to total_attended as full days
        const noSplit = row.half_days == null && row.full_days == null;
        histByMonth[mo].push({
            roomId: row.room_id, day,
            date: row.summary_date,
            half: noSplit ? 0 : (row.half_days || 0),
            full: noSplit ? (row.total_attended || 0) : (row.full_days || 0),
        });
    });

    Object.entries(histByMonth).forEach(([mo, entries]) => {
        // Clear any live data for this month — historical is authoritative
        trendMap[mo] = { _historical: true };
        entries.forEach(({ roomId, day, date, half, full }) => {
            ensureRoom(mo, roomId);
            trendMap[mo][roomId][day].halfSum += half;
            trendMap[mo][roomId][day].fullSum += full;
            trendMap[mo][roomId][day].dates.add(date);
        });
    });

    return trendMap;
}

function _renderTrendsTable(trendMap) {
    const months = Object.keys(trendMap).sort();
    if (!months.length) return '<p class="empty-hint">No enrollment data found.</p>';

    // Format an average value: show one decimal unless it's a whole number, '—' for zero
    function fmtAvg(v) {
        if (!v) return '—';
        return v % 1 === 0 ? String(v) : v.toFixed(1);
    }

    // facilityAccum: accumulates per-room avg across all months, then sums across rooms
    // shape: { day: { halfSum, fullSum } } — summed room averages (already averaged per month)
    const facilityAccum = {};
    TREND_DAYS.forEach(d => { facilityAccum[d] = { halfSum: 0, fullSum: 0 }; });

    const roomHtml = ROOMS.map(room => {
        // Rooms with half-day option show Half | Full | Total per day; full-day-only rooms show just Total
        const showSplit = !room.fullDayOnly;

        const dayHeaders = TREND_DAYS.map(d =>
            showSplit
                ? `<th colspan="3" style="text-align:center;border-left:2px solid #ddd">Avg ${d}</th>`
                : `<th style="text-align:center;border-left:2px solid #ddd">Avg ${d}</th>`
        ).join('');

        const daySubHeaders = showSplit
            ? TREND_DAYS.map(() =>
                `<th style="text-align:right;border-left:2px solid #ddd;font-weight:normal">Half</th>` +
                `<th style="text-align:right;font-weight:normal">Full</th>` +
                `<th style="text-align:right;font-weight:normal">Total</th>`
              ).join('')
            : null;

        // roomAccum: accumulates monthly averages for this room to compute an "avg across months" row
        const roomAccum = {};
        TREND_DAYS.forEach(d => { roomAccum[d] = { halfSum: 0, fullSum: 0, count: 0 }; });

        const rows = months.map(mo => {
            const [y, m] = mo.split('-').map(Number);
            const label  = MONTH_NAMES_ADMIN[m - 1] + ' ' + y;
            const isHist = trendMap[mo]._historical;
            const src    = isHist ? ' <span style="font-size:.7em;color:#888">(hist)</span>' : '';
            let moHalfTotal = 0, moFullTotal = 0;

            const dayCells = TREND_DAYS.map(d => {
                const c = _trendCell(trendMap[mo], room.id, d);
                const count = c.dates.size;
                if (!count) {
                    return showSplit
                        ? `<td class="report-num" style="border-left:2px solid #ddd">—</td>` +
                          `<td class="report-num">—</td>` +
                          `<td class="report-num">—</td>`
                        : `<td class="report-num" style="border-left:2px solid #ddd">—</td>`;
                }
                const avgHalf = c.halfSum / count;
                const avgFull = c.fullSum / count;
                moHalfTotal += c.halfSum;
                moFullTotal += c.fullSum;
                roomAccum[d].halfSum += avgHalf;
                roomAccum[d].fullSum += avgFull;
                roomAccum[d].count++;
                return showSplit
                    ? `<td class="report-num" style="border-left:2px solid #ddd">${fmtAvg(avgHalf)}</td>` +
                      `<td class="report-num">${fmtAvg(avgFull)}</td>` +
                      `<td class="report-num">${fmtAvg(avgHalf + avgFull)}</td>`
                    : `<td class="report-num" style="border-left:2px solid #ddd">${fmtAvg(avgHalf + avgFull)}</td>`;
            }).join('');

            const moTotal = moHalfTotal + moFullTotal;
            if (showSplit) {
                return `<tr>
                    <td class="staff-date-cell">${label}${src}</td>
                    ${dayCells}
                    <td class="report-num" style="border-left:2px solid #ddd">${moHalfTotal || '—'}</td>
                    <td class="report-num">${moFullTotal || '—'}</td>
                    <td class="report-num"><strong>${moTotal || '—'}</strong></td>
                </tr>`;
            }
            return `<tr>
                <td class="staff-date-cell">${label}${src}</td>
                ${dayCells}
                <td class="report-num" style="border-left:2px solid #ddd"><strong>${moTotal || '—'}</strong></td>
            </tr>`;
        }).join('');

        // "Avg across months" row for this room
        const avgCells = TREND_DAYS.map(d => {
            const { halfSum, fullSum, count } = roomAccum[d];
            if (!count) {
                return showSplit
                    ? `<td class="report-num" style="border-left:2px solid #ddd;background:#f0f4ff">—</td>` +
                      `<td class="report-num" style="background:#f0f4ff">—</td>` +
                      `<td class="report-num" style="background:#f0f4ff">—</td>`
                    : `<td class="report-num" style="border-left:2px solid #ddd;background:#f0f4ff">—</td>`;
            }
            const avgH = halfSum / count;
            const avgF = fullSum / count;
            // Accumulate into facility totals
            facilityAccum[d].halfSum += avgH;
            facilityAccum[d].fullSum += avgF;
            return showSplit
                ? `<td class="report-num" style="border-left:2px solid #ddd;background:#f0f4ff;font-weight:600">${fmtAvg(avgH)}</td>` +
                  `<td class="report-num" style="background:#f0f4ff;font-weight:600">${fmtAvg(avgF)}</td>` +
                  `<td class="report-num" style="background:#f0f4ff;font-weight:600">${fmtAvg(avgH + avgF)}</td>`
                : `<td class="report-num" style="border-left:2px solid #ddd;background:#f0f4ff;font-weight:600">${fmtAvg(avgH + avgF)}</td>`;
        }).join('');

        const avgRowTrailer = showSplit
            ? `<td colspan="3" style="border-left:2px solid #ddd;background:#f0f4ff"></td>`
            : `<td style="border-left:2px solid #ddd;background:#f0f4ff"></td>`;

        const avgRow = `<tr style="background:#f0f4ff;border-top:2px solid #c0c8e0">
            <td class="staff-date-cell" style="font-weight:700;font-style:italic">Avg across months</td>
            ${avgCells}
            ${avgRowTrailer}
        </tr>`;

        const monthHeader = showSplit ? `<th rowspan="2">Month</th>` : `<th>Month</th>`;
        const monthTotalHeader = showSplit
            ? `<th colspan="2" style="text-align:center;border-left:2px solid #ddd">Month Total</th>` +
              `<th style="border-left:none">All Days</th>`
            : `<th style="text-align:center;border-left:2px solid #ddd">Month Total</th>`;
        const subHeaderRow = showSplit
            ? `<tr>${daySubHeaders}` +
              `<th style="text-align:right;border-left:2px solid #ddd;font-weight:normal">Half</th>` +
              `<th style="text-align:right;font-weight:normal">Full</th>` +
              `<th style="text-align:right;font-weight:normal">Total</th>` +
              `</tr>`
            : '';

        return `
            <h4 style="margin:18px 0 6px;font-size:1em;display:flex;align-items:center;gap:10px">
                ${escHtml(room.label)}
                <button onclick="(function(btn){var w=document.getElementById('trendsRoom_${room.id}');var collapsed=w.style.display==='none';w.style.display=collapsed?'':'none';btn.textContent=collapsed?'▲ Collapse':'▼ Expand';})(this)" style="font-size:.75em;padding:2px 8px;cursor:pointer;background:#f0f4ff;border:1px solid #c0c8e0;border-radius:4px">▲ Collapse</button>
            </h4>
            <div id="trendsRoom_${room.id}" class="table-wrapper report-table-wrap">
                <table class="report-table" style="font-size:.85rem">
                    <thead>
                        <tr>
                            ${monthHeader}
                            ${dayHeaders}
                            ${monthTotalHeader}
                        </tr>
                        ${subHeaderRow}
                    </thead>
                    <tbody>${rows}${avgRow}</tbody>
                </table>
            </div>`;
    }).join('');

    // Facility totals table — sum of all room averages per day of week, with Half/Full/Total split
    const facilityDayHeaders = TREND_DAYS.map(d =>
        `<th colspan="3" style="text-align:center;border-left:2px solid #ddd">Avg ${d}</th>`
    ).join('');

    const facilitySubHeaders = TREND_DAYS.map(() =>
        `<th style="text-align:right;border-left:2px solid #ddd;font-weight:normal">Half</th>` +
        `<th style="text-align:right;font-weight:normal">Full</th>` +
        `<th style="text-align:right;font-weight:normal">Total</th>`
    ).join('');

    const facilityCells = TREND_DAYS.map(d => {
        const { halfSum, fullSum } = facilityAccum[d];
        return `<td class="report-num" style="border-left:2px solid #ddd;font-weight:600">${fmtAvg(halfSum)}</td>` +
               `<td class="report-num" style="font-weight:600">${fmtAvg(fullSum)}</td>` +
               `<td class="report-num" style="font-weight:600">${fmtAvg(halfSum + fullSum)}</td>`;
    }).join('');

    const facilityHtml = `
        <h4 style="margin:28px 0 4px;font-size:1em;border-top:2px solid #c0c8e0;padding-top:14px">Facility Total Averages</h4>
        <p style="font-size:.8em;color:#666;margin:0 0 8px">Average children per day of week across all rooms combined (sum of room averages).</p>
        <div class="table-wrapper report-table-wrap">
            <table class="report-table" style="font-size:.85rem">
                <thead>
                    <tr>
                        <th rowspan="2">Scope</th>
                        ${facilityDayHeaders}
                    </tr>
                    <tr>${facilitySubHeaders}</tr>
                </thead>
                <tbody>
                    <tr>
                        <td class="staff-date-cell" style="font-weight:700">All Rooms</td>
                        ${facilityCells}
                    </tr>
                </tbody>
            </table>
        </div>`;

    return roomHtml + facilityHtml;
}

async function generateEnrollmentTrends() {
    const container = document.getElementById('trendsContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const trendMap = await _buildTrendMap();
        const html = _renderTrendsTable(trendMap);
        container.innerHTML = html +
            `<p style="font-size:.8em;color:#888;margin-top:8px">(hist) = sourced from imported attendance records</p>`;
    } catch (err) {
        container.innerHTML = `<p class="import-error">Error loading trends: ${escHtml(err.message)}</p>`;
    }
}

async function exportEnrollmentTrends() {
    let trendMap;
    try {
        trendMap = await _buildTrendMap();
    } catch (err) {
        alert('Error loading trend data: ' + err.message);
        return;
    }
    const months = Object.keys(trendMap).sort();
    if (!months.length) { alert('No data to export.'); return; }

    const rows = [];
    months.forEach(mo => {
        const [y, m] = mo.split('-').map(Number);
        const moLabel = MONTH_NAMES_ADMIN[m - 1] + ' ' + y;
        const isHist  = trendMap[mo]._historical;
        ROOMS.forEach(room => {
            const row = { Month: moLabel, Room: room.label, Source: isHist ? 'historical' : 'live' };
            let moHalfTotal = 0, moFullTotal = 0;
            TREND_DAYS.forEach(d => {
                const c = _trendCell(trendMap[mo], room.id, d);
                const count = c.dates.size;
                if (room.fullDayOnly) {
                    row[`Avg ${d}`] = count ? +((c.halfSum + c.fullSum) / count).toFixed(2) : 0;
                } else {
                    row[`Avg ${d} Half`] = count ? +(c.halfSum / count).toFixed(2) : 0;
                    row[`Avg ${d} Full`] = count ? +(c.fullSum / count).toFixed(2) : 0;
                    row[`Avg ${d} Total`] = count ? +((c.halfSum + c.fullSum) / count).toFixed(2) : 0;
                }
                moHalfTotal += c.halfSum;
                moFullTotal += c.fullSum;
            });
            if (room.fullDayOnly) {
                row['Month Total'] = moHalfTotal + moFullTotal;
            } else {
                row['Month Half Total'] = moHalfTotal;
                row['Month Full Total'] = moFullTotal;
                row['Month Total']      = moHalfTotal + moFullTotal;
            }
            rows.push(row);
        });
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


// ── Enrollment Planner ─────────────────────────────────────

function initEnrollmentPlannerSelectors() {
    const roomSel = document.getElementById('plannerRoomSel');
    if (!roomSel || roomSel.options.length > 0) return;
    ROOMS.forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = r.label;
        roomSel.appendChild(opt);
    });
    const monthSel = document.getElementById('plannerMonthSel');
    const now = new Date();
    for (let i = 0; i < 6; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
        const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        const opt = document.createElement('option');
        opt.value = key;
        opt.textContent = MONTH_NAMES_ADMIN[d.getMonth()] + ' ' + d.getFullYear();
        if (i === 1) opt.selected = true;
        monthSel.appendChild(opt);
    }
}

// Build per-day slot counts for a room/month from allRegistrations.
// Falls back to prior month's data as a projection if the target month has no data.
function _buildPlannerSlots(roomId, monthKey, room) {
    const DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    function _tally(monthPrefix) {
        const acc = {};
        TREND_DAYS.forEach(d => { acc[d] = { full: 0, half: 0, dates: new Set() }; });
        let found = false;
        allRegistrations.forEach(reg => {
            (reg.registration_dates || []).forEach(rd => {
                if (!rd.care_date || rd.waitlisted) return;
                if (!rd.care_date.startsWith(monthPrefix)) return;
                const effectiveRoom = rd.room_id || reg.room_id;
                if (effectiveRoom !== roomId) return;
                const dow = DAY_NAMES[new Date(rd.care_date + 'T00:00:00').getDay()];
                if (!TREND_DAYS.includes(dow)) return;
                acc[dow].dates.add(rd.care_date);
                if (rd.day_type === 'half') acc[dow].half++;
                else acc[dow].full++;
                found = true;
            });
        });
        return { acc, found };
    }

    let { acc, found } = _tally(monthKey);
    let sourceType = 'live';

    if (!found) {
        const prev = new Date(monthKey + '-01');
        prev.setMonth(prev.getMonth() - 1);
        const prevKey = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;
        ({ acc } = _tally(prevKey));
        sourceType = 'projected';
    }

    const days = {};
    TREND_DAYS.forEach(d => {
        const cnt = acc[d].dates.size || 1; // avoid div/0; open = capacity when no data
        const avgFull = acc[d].full / cnt;
        const avgHalf = acc[d].half / cnt;
        const avgTotal = avgFull + avgHalf;
        const open = Math.max(0, room.capacity - Math.round(avgTotal));
        days[d] = { full: avgFull, half: avgHalf, total: avgTotal, open, hasDates: acc[d].dates.size > 0 };
    });
    return { days, sourceType };
}

async function generateEnrollmentPlanner() {
    initEnrollmentPlannerSelectors();
    const roomId   = document.getElementById('plannerRoomSel').value;
    const monthKey = document.getElementById('plannerMonthSel').value;
    const container = document.getElementById('plannerContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        if (!allRegistrations.length) allRegistrations = await fetchAllRegistrations();

        const room = ROOMS.find(r => r.id === roomId);
        if (!room) throw new Error('Room not found');

        const { days, sourceType } = _buildPlannerSlots(roomId, monthKey, room);

        // Fetch or reuse waitlist
        if (!_wlDemandCache.length) _wlDemandCache = await fetchWaitlistApplications();
        const active = _wlDemandCache.filter(a => ['pending','offered','accepted'].includes(a.status));

        // Filter waitlist applicants: must map to this room, desired start within ±1 month
        const [planY, planM] = monthKey.split('-').map(Number);
        const planDate = new Date(planY, planM - 1, 1);
        const candidates = active.filter(a => {
            if (wlDeriveRoom(a) !== roomId) return false;
            const startMo = (a.desired_start_date || '').substring(0, 7);
            if (!startMo) return false;
            const [sy, sm] = startMo.split('-').map(Number);
            const diff = (sy - planY) * 12 + (sm - planM);
            return Math.abs(diff) <= 1;
        });

        // Compute revenue potential per candidate
        const fullDayRate = room.fullDayRate || 0;
        const halfDayRate = room.halfDayRate || fullDayRate;

        const enriched = candidates.map(a => {
            const desiredDays = (a.days_of_week || '').split(',').map(s => s.trim()).filter(Boolean);
            const isHalf = a.day_type === 'half';
            const rate = isHalf ? halfDayRate : fullDayRate;
            const weeklyRev = desiredDays.length * rate;
            // Per-day slot availability for desired days
            const dayStatus = {};
            desiredDays.forEach(d => {
                if (!TREND_DAYS.includes(d)) return;
                const open = days[d]?.open ?? 0;
                dayStatus[d] = open > 1 ? 'open' : open === 1 ? 'tight' : 'full';
            });
            const canFit = desiredDays.every(d => (days[d]?.open ?? 0) > 0);
            return { ...a, desiredDays, isHalf, weeklyRev, dayStatus, canFit };
        });

        // Sort: fully-fittable first, then by weekly revenue desc, then by applied_at asc
        enriched.sort((a, b) => {
            if (a.canFit !== b.canFit) return a.canFit ? -1 : 1;
            if (b.weeklyRev !== a.weeklyRev) return b.weeklyRev - a.weeklyRev;
            return (a.applied_at || '') < (b.applied_at || '') ? -1 : 1;
        });

        container.innerHTML = _renderPlannerContent(room, monthKey, days, sourceType, enriched, fullDayRate, halfDayRate);
    } catch(err) {
        container.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    }
}

function _renderPlannerContent(room, monthKey, days, sourceType, candidates, fullDayRate, halfDayRate) {
    const [y, m] = monthKey.split('-').map(Number);
    const monthLabel = MONTH_NAMES_ADMIN[m - 1] + ' ' + y;
    const srcBadge = sourceType === 'projected'
        ? `<span style="font-size:.75em;padding:2px 7px;background:#fff3cd;border:1px solid #ffc107;border-radius:4px;color:#856404">projected from prior month</span>`
        : `<span style="font-size:.75em;padding:2px 7px;background:#d4edda;border:1px solid #28a745;border-radius:4px;color:#155724">live registration data</span>`;

    // ── Availability Matrix ──────────────────────────────────
    const matrixRows = [
        { label: 'Full-day enrolled', key: 'full', fmt: v => v > 0 ? v.toFixed(1).replace(/\.0$/,'') : '—' },
        { label: 'Half-day enrolled', key: 'half', fmt: v => v > 0 ? v.toFixed(1).replace(/\.0$/,'') : '—' },
        { label: `Total / ${room.capacity} capacity`, key: 'total', fmt: v => v > 0 ? v.toFixed(1).replace(/\.0$/,'') : '—', bold: true },
        { label: 'Open slots', key: 'open', fmt: v => v, color: true },
    ];

    const matrixHtml = `
        <h4 style="margin:0 0 6px;font-size:.95em">Schedule Availability — ${escHtml(room.label)} &bull; ${monthLabel} ${srcBadge}</h4>
        <div class="table-wrapper report-table-wrap" style="margin-bottom:18px">
            <table class="report-table" style="font-size:.85rem">
                <thead><tr>
                    <th>Metric</th>
                    ${TREND_DAYS.map(d => `<th style="text-align:center">${d}</th>`).join('')}
                </tr></thead>
                <tbody>
                    ${matrixRows.map(row => {
                        const cells = TREND_DAYS.map(d => {
                            const val = days[d]?.[row.key] ?? 0;
                            const hasDates = days[d]?.hasDates;
                            let style = 'text-align:center';
                            if (row.bold) style += ';font-weight:600';
                            if (row.color && hasDates) {
                                const open = days[d]?.open ?? 0;
                                const bg = open === 0 ? '#f8d7da' : open <= 2 ? '#fff3cd' : '#d4edda';
                                style += `;background:${bg}`;
                            }
                            const display = hasDates ? row.fmt(val) : '—';
                            return `<td class="report-num" style="${style}">${display}</td>`;
                        }).join('');
                        return `<tr><td class="staff-date-cell">${row.label}</td>${cells}</tr>`;
                    }).join('')}
                </tbody>
            </table>
        </div>`;

    // ── Optimization Alerts ─────────────────────────────────
    const alerts = [];
    const halfBlockedDays = TREND_DAYS.filter(d => days[d]?.half > 0 && days[d]?.hasDates);
    const fullWlWantHalfDays = candidates.filter(c => !c.isHalf && c.desiredDays.some(d => halfBlockedDays.includes(d)));
    if (halfBlockedDays.length && fullWlWantHalfDays.length) {
        alerts.push(`⚠️ Half-day children are enrolled on <strong>${halfBlockedDays.join(', ')}</strong> — <strong>${fullWlWantHalfDays.length}</strong> full-day waitlist applicant${fullWlWantHalfDays.length > 1 ? 's' : ''} want those days. Consider whether holding for a full-day child would better use the space.`);
    }
    const fittable = candidates.filter(c => c.canFit);
    if (fittable.length) {
        alerts.push(`✅ <strong>${fittable.length}</strong> waitlist applicant${fittable.length > 1 ? 's' : ''} can be fully accommodated with current open slots.`);
    } else if (candidates.length) {
        alerts.push(`⚠️ No waitlist applicants for this room/month can be fully accommodated with current open slots.`);
    }
    if (fullDayRate && halfDayRate && fullDayRate > halfDayRate) {
        const revDiff = fullDayRate - halfDayRate;
        alerts.push(`💡 Full-day placement earns <strong>$${revDiff}/day more</strong> than half-day. Prefer full-day waitlist applicants when filling open slots.`);
    }

    const alertsHtml = alerts.length
        ? `<div style="margin-bottom:18px;display:flex;flex-direction:column;gap:8px">
            ${alerts.map(a => `<div style="padding:8px 12px;background:#f8f9fa;border-left:4px solid #6c757d;border-radius:0 4px 4px 0;font-size:.88em;line-height:1.4">${a}</div>`).join('')}
           </div>`
        : '';

    // ── Waitlist Candidates ─────────────────────────────────
    let candidatesHtml;
    if (!candidates.length) {
        candidatesHtml = `<p class="empty-hint">No active waitlist applicants for ${escHtml(room.label)} within ±1 month of ${monthLabel}.</p>`;
    } else {
        const today = new Date().toISOString().split('T')[0];
        const rows = candidates.map(c => {
            const waitSince = c.applied_at ? c.applied_at.substring(0, 10) : '—';
            const desiredStart = c.desired_start_date || '—';
            const typeLabel = c.isHalf ? 'Half' : 'Full';
            const typeBg = c.isHalf ? '#fff3cd' : '#d4edda';
            const revLabel = c.weeklyRev > 0 ? `$${c.weeklyRev}/wk` : '—';

            // Days display with status icons
            const daysDisplay = c.desiredDays.length
                ? c.desiredDays.map(d => {
                    const status = c.dayStatus[d] || 'open';
                    const icon = status === 'full' ? '✗' : status === 'tight' ? '⚠' : '✓';
                    const color = status === 'full' ? '#dc3545' : status === 'tight' ? '#856404' : '#155724';
                    return `<span style="color:${color};white-space:nowrap">${icon} ${d}</span>`;
                  }).join(' &nbsp;')
                : '<span style="color:#888">not specified</span>';

            const fitBg = c.canFit ? '' : 'background:#fff5f5';
            return `<tr style="${fitBg}">
                <td class="staff-date-cell">${escHtml(c.child_name)}</td>
                <td style="font-size:.85em">${escHtml(c.parent_name)}</td>
                <td style="font-size:.85em">${desiredStart}</td>
                <td style="font-size:.85em">${daysDisplay}</td>
                <td style="text-align:center"><span style="padding:1px 7px;border-radius:3px;font-size:.82em;background:${typeBg}">${typeLabel}</span></td>
                <td class="report-num" style="font-weight:600;color:#1a5276">${revLabel}</td>
                <td style="font-size:.8em;color:#888">${waitSince}</td>
            </tr>`;
        }).join('');

        candidatesHtml = `
            <h4 style="margin:0 0 6px;font-size:.95em">Waitlist Candidates — sorted by fit &amp; weekly revenue potential</h4>
            <p style="font-size:.8em;color:#666;margin:0 0 8px">✓ = open slot &nbsp; ⚠ = only 1 spot left &nbsp; ✗ = no available slot on that day. Highlighted rows cannot be fully accommodated.</p>
            <div class="table-wrapper report-table-wrap">
                <table class="report-table" style="font-size:.85rem">
                    <thead><tr>
                        <th>Child</th>
                        <th>Parent</th>
                        <th>Desired Start</th>
                        <th>Days Wanted</th>
                        <th style="text-align:center">Type</th>
                        <th style="text-align:right">Wkly Rev</th>
                        <th>On List Since</th>
                    </tr></thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;
    }

    return matrixHtml + alertsHtml + candidatesHtml;
}

// ============================================================
