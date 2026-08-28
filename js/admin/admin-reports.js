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
    const monthLabel = m ? (MONTH_NAMES[m - 1] + ' ' + y) : '';

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

// ============================================================
// Admin itemization of the billing calculation.
// ============================================================
// Used by: Family Billing Summary (this file), draft-invoice generation
// (admin-billing.js), and the Director dashboard's "Billed this month"
// (admin-portal.js). Do NOT add a fourth implementation — the dashboard used
// to have its own per-registration sum and disagreed with this one by
// thousands of dollars, because a per-registration calculation structurally
// cannot apply the sibling discount and does not see change fees or overrides.
// The database compute_family_month_charges() function is authoritative for
// stored invoice money; this function mirrors it for previews and reports.
function _buildFamilyBillingData(monthVal, overridesMap = new Map()) {
    const dmap      = getDiscountMap();
    const famKeyMap = getFamilyKeyMap();
    const familyMap = new Map();

    // First pass: collect each child's registration info per family key
    allRegistrations.forEach(reg => {
        const dates = (reg.registration_dates || []).filter(d =>
            !d.waitlisted && d.care_date && d.care_date.startsWith(monthVal));
        if (!dates.length) return;

        // Group by FAMILY, not by the email that submitted the registration.
        // Two parents on one family record register separately otherwise, and
        // their children never qualify each other for the sibling discount.
        // Falls back to the email when no family record matches.
        const email = (reg.parent_email || '').toLowerCase().trim();
        const key   = famKeyMap.get(email)
                   || email
                   || (reg.parent_name || '').toLowerCase().trim();
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

        const roomForDate = (reg, date) =>
            ROOMS.find(r => r.id === (date.room_id || reg.room_id))
            || ROOMS.find(r => r.id === reg.room_id);
        const weekMonday = dateStr => {
            const dt = new Date(`${dateStr}T00:00:00Z`);
            const daysSinceMonday = (dt.getUTCDay() + 6) % 7;
            dt.setUTCDate(dt.getUTCDate() - daysSinceMonday);
            return dt.toISOString().slice(0, 10);
        };

        // Identify each child's complete, same-room Monday-Friday weeks.
        // Those dates are billed once at the weekly rate and are excluded from
        // daily sibling discounts, matching the parent quote and SQL ledger.
        const weekGroups = new Map();
        regs.forEach(({ reg, disc, dates }) => dates.forEach(date => {
            const room = roomForDate(reg, date);
            const childKey = (reg.child_name || '').toLowerCase().trim();
            const key = `${childKey}:${weekMonday(date.care_date)}`;
            if (!weekGroups.has(key)) weekGroups.set(key, []);
            weekGroups.get(key).push({ reg, disc, date, room });
        }));
        const weeklyEntries = new Map();
        for (const entries of weekGroups.values()) {
            const uniqueDates = new Set(entries.map(e => e.date.care_date));
            const roomIds = new Set(entries.map(e => e.room?.id || ''));
            const dayTypes = new Set(entries.map(e => e.date.day_type));
            const weekdaysOnly = entries.every(e => {
                const day = new Date(`${e.date.care_date}T00:00:00Z`).getUTCDay();
                return day >= 1 && day <= 5;
            });
            if (uniqueDates.size !== 5 || roomIds.size !== 1 || dayTypes.size !== 1 || !weekdaysOnly) continue;
            const first = [...entries].sort((a, b) => a.date.care_date.localeCompare(b.date.care_date))[0];
            const weeklyRate = first.date.day_type === 'half'
                ? first.room?.weeklyHalfRate
                : first.room?.weeklyFullRate;
            if (weeklyRate == null) continue;
            const group = { first, weeklyRate: Number(weeklyRate) || 0 };
            entries.forEach(e => weeklyEntries.set(`${e.reg.id}:${e.date.care_date}`, group));
        }

        // Build map: care_date → array of { childName, effRate, hasIndividualDiscount }
        // used to figure out which days have multiple siblings
        const dateChildMap = new Map();
        regs.forEach(({ reg, disc, dates }) => {
            const hasIndividualDiscount = disc.type === 'staff' || (disc.type === 'custom' && disc.value > 0);
            dates.forEach(d => {
                if (weeklyEntries.has(`${reg.id}:${d.care_date}`)) return;
                const room    = roomForDate(reg, d);
                const base    = d.day_type === 'half'
                    ? (room?.halfDayRate ?? room?.fullDayRate ?? 0)
                    : (room?.fullDayRate || 0);
                const effRate = effectiveAdminRate(base, disc.type, disc.value);
                if (!dateChildMap.has(d.care_date)) dateChildMap.set(d.care_date, []);
                dateChildMap.get(d.care_date).push({ childName: reg.child_name, effRate, hasIndividualDiscount });
            });
        });

        // The $10 sibling discount is a family-level "you have a sibling in care"
        // perk, not per-child — if anyone present that day already has their own
        // individual discount, the family already has a discount that day, so the
        // sibling discount doesn't also apply to anyone in the group. It only
        // applies among a group where nobody present has an individual discount.
        // Key: `${childName}:${care_date}` → discount amount
        const siblingDiscMap = new Map();
        for (const [date, children] of dateChildMap) {
            if (children.length < 2) continue;
            if (children.some(c => c.hasIndividualDiscount)) continue;
            const ranked  = [...children].sort((a, b) => b.effRate - a.effRate);
            const winners = ranked.slice(1);
            winners.forEach(c => {
                const k = `${c.childName}:${date}`;
                siblingDiscMap.set(k, (siblingDiscMap.get(k) || 0) + Math.min(10, c.effRate));
            });
        }

        // Now aggregate per-child totals with sibling discounts applied
        const childMap = new Map();
        regs.forEach(({ reg, room, disc, dates }) => {
            let fullDays = 0, halfDays = 0, subtotal = 0, changeFees = 0, sibDiscount = 0, discountDollar = 0;
            dates.forEach(d => {
                const dateRoom = roomForDate(reg, d);
                const weekly = weeklyEntries.get(`${reg.id}:${d.care_date}`);
                const isWeeklyFirst = weekly?.first.reg.id === reg.id
                    && weekly?.first.date.care_date === d.care_date;
                const base = weekly
                    ? (isWeeklyFirst ? weekly.weeklyRate : 0)
                    : d.day_type === 'half' ? (dateRoom?.halfDayRate ?? dateRoom?.fullDayRate ?? 0)
                                            : (dateRoom?.fullDayRate || 0);
                const effRate = effectiveAdminRate(base, disc.type, disc.value);
                const sib     = weekly ? 0 : (siblingDiscMap.get(`${reg.child_name}:${d.care_date}`) || 0);
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
                    roomId:         reg.room_id,
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
    const monthLabel = MONTH_NAMES[m - 1] + ' ' + y;
    const container  = document.getElementById('familyBillingContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';

    // Always load fresh families and registrations so discounts and new entries are up to date.
    let allStudents = [];
    await Promise.all([
        fetchAllFamilies({ includeArchived: true })
            .then(d => { allFamiliesData = d; _discountMap = null; })
            .catch(e => console.warn('Could not load families for discount map:', e)),
        fetchAllRegistrations()
            .then(d => { if (d?.length) allRegistrations = d; })
            .catch(e => console.warn('Could not refresh registrations:', e)),
        fetchStudents()
            .then(d => { allStudents = d || []; })
            .catch(e => console.warn('Could not load students:', e)),
    ]);

    // Fee amounts from settings (cached on window by setupRegFee; fall back to DB fetch)
    let regFeeAmount = window._regFeeAmount ?? 0;
    if (!regFeeAmount) {
        try {
            const val = await fetchSetting('registration_fee');
            regFeeAmount = (typeof val === 'number' && val >= 0) ? val : 0;
            window._regFeeAmount = regFeeAmount;
        } catch (e) { /* ignore */ }
    }
    let newFamilyFeeAmount = window._newFamilyFee ?? 0;
    if (!newFamilyFeeAmount) {
        try {
            const val = await fetchSetting('new_family_fee');
            newFamilyFeeAmount = (typeof val === 'number' && val >= 0) ? val : 0;
            window._newFamilyFee = newFamilyFeeAmount;
        } catch (e) { /* ignore */ }
    }
    let supplyFeeFamilyMax = window._supplyFeeFamilyMax ?? 0;
    if (!supplyFeeFamilyMax) {
        try {
            const val = await fetchSetting('supply_fee_family_max');
            supplyFeeFamilyMax = (typeof val === 'number' && val >= 0) ? val : 0;
            window._supplyFeeFamilyMax = supplyFeeFamilyMax;
        } catch (e) { /* ignore */ }
    }

    // Build student lookup: childName.toLowerCase() → {id, reg_fee_paid_year, family_id}
    // A child may appear multiple times (shouldn't, but guard). Use first match.
    const studentByName = new Map();
    allStudents.forEach(s => {
        const k = (s.child_name || '').toLowerCase().trim();
        if (!studentByName.has(k)) studentByName.set(k, s);
    });

    // Family lookup by email, for the one-time new-family fee's charged flag
    const familyByEmail = new Map();
    (allFamiliesData || []).forEach(f => {
        const k = (f.parent_email || '').toLowerCase().trim();
        if (k && !familyByEmail.has(k)) familyByEmail.set(k, f);
    });

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

    // "currentYear" here labels the current annual-fee cycle (see
    // currentFeeCycleYear), not necessarily the calendar year — the fee
    // becomes due again for everyone once the renewal date passes each year.
    // The fee is fully automatic: a child owes it whenever they haven't yet
    // been charged for the current cycle (student.reg_fee_paid_year !==
    // currentYear) — either because a new cycle just started (renewal date
    // passed) or because they're a brand-new student who's never been
    // charged. Whoever owes it gets charged and stamped for this cycle the
    // moment their billing report is generated — no manual paid/unpaid step.
    const currentYear = currentFeeCycleYear(window._regFeeRenewalDate);
    const regFeeOwedByChild = new Map(); // childName key → { owed, studentId }
    const feeChargeStudentIds = [];
    families.forEach(fam => fam.children.forEach(c => {
        const key = (c.childName || '').toLowerCase().trim();
        if (regFeeOwedByChild.has(key)) return;
        const student = studentByName.get(key);
        const owed = regFeeAmount > 0 && !!student && student.reg_fee_paid_year !== currentYear;
        regFeeOwedByChild.set(key, { owed, studentId: student?.id });
        if (owed && student.id) feeChargeStudentIds.push(student.id);
    }));
    if (feeChargeStudentIds.length) {
        await Promise.all(feeChargeStudentIds.map(id =>
            updateStudentRegFee(id, currentYear).catch(e => console.warn('updateStudentRegFee failed for', id, e))));
    }

    // One-time new-family fee: owed whenever the family record exists and hasn't
    // been stamped yet. Charged and stamped the moment their billing report is
    // generated, same "no manual step" pattern as the supply fee above.
    const newFamilyFeeOwedByEmail = new Map(); // parentEmail → owed boolean
    const newFamilyFeeChargeIds = [];
    families.forEach(fam => {
        const key = (fam.parentEmail || '').toLowerCase().trim();
        if (newFamilyFeeOwedByEmail.has(key)) return;
        const family = familyByEmail.get(key);
        const owed = newFamilyFeeAmount > 0 && !!family && !family.new_family_fee_charged;
        newFamilyFeeOwedByEmail.set(key, owed);
        if (owed) newFamilyFeeChargeIds.push(family.id);
    });
    if (newFamilyFeeChargeIds.length) {
        await Promise.all(newFamilyFeeChargeIds.map(id =>
            markNewFamilyFeeCharged(id).catch(e => console.warn('markNewFamilyFeeCharged failed for', id, e))));
    }

    let grandTotal = 0;
    const rows = families.map(fam => {
        // Supply fee: sum what each owing child would cost, then cap the family's
        // total at the family max (if one's set) — capped families aren't billed
        // more, and every owing child is still stamped paid for this cycle since
        // nothing further is owed by anyone in the family until the next cycle.
        const owedChildren = fam.children.filter(c =>
            regFeeOwedByChild.get((c.childName || '').toLowerCase().trim())?.owed);
        const rawSupplyFeeTotal = owedChildren.length * regFeeAmount;
        const supplyFeeCapped   = supplyFeeFamilyMax > 0 && rawSupplyFeeTotal > supplyFeeFamilyMax;
        const supplyFeeCharged  = supplyFeeCapped ? supplyFeeFamilyMax : rawSupplyFeeTotal;

        const newFamilyFeeOwed = newFamilyFeeOwedByEmail.get((fam.parentEmail || '').toLowerCase().trim());

        const familyTotal = fam.children.reduce((s, c) => {
            const billed = c.hasOverride ? c.overrideAmount : c.subtotal;
            return s + billed + (c.changeFees || 0);
        }, 0) + supplyFeeCharged + (newFamilyFeeOwed ? newFamilyFeeAmount : 0);
        grandTotal += familyTotal;

        const childRows = fam.children.map(c => {
            const billed      = c.hasOverride ? c.overrideAmount : c.subtotal;
            const discDisplay = c.discountDollar > 0
                ? `${escHtml(c.discLabel)} (−$${c.discountDollar.toFixed(2)})`
                : escHtml(c.discLabel);

            const { owed: regFeeOwed } = regFeeOwedByChild.get((c.childName || '').toLowerCase().trim());

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
            // Shown per-child only when the family's supply fee isn't capped —
            // once capped, a single family-level row (below) covers the total instead.
            const regFeeRow = (regFeeOwed && !supplyFeeCapped)
                ? `<tr class="billing-child-row" style="background:#f0fdf4">
                    <td class="billing-indent" style="color:#166534;font-size:.85em" colspan="4">↳ Annual supply fee</td>
                    <td class="report-num" style="color:#166534">—</td>
                    <td class="report-num report-revenue" style="color:#166534">+$${regFeeAmount.toFixed(2)}</td>
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
            </tr>${sibRow}${feeRow}${regFeeRow}`;
        }).join('');

        const newFamilyFeeRow = newFamilyFeeOwed
            ? `<tr class="billing-child-row" style="background:#f0fdf4">
                <td style="color:#166534;font-size:.85em;padding-left:12px" colspan="5">New family fee</td>
                <td class="report-num report-revenue" style="color:#166534">+$${newFamilyFeeAmount.toFixed(2)}</td>
               </tr>`
            : '';
        const supplyFeeFamilyRow = supplyFeeCapped
            ? `<tr class="billing-child-row" style="background:#f0fdf4">
                <td style="color:#166534;font-size:.85em;padding-left:12px" colspan="5">Annual supply fee — ${owedChildren.length} child${owedChildren.length !== 1 ? 'ren' : ''} (capped at family max)</td>
                <td class="report-num report-revenue" style="color:#166534">+$${supplyFeeCharged.toFixed(2)}</td>
               </tr>`
            : '';

        return `
            <tr class="billing-family-row">
                <td colspan="5">
                    <strong>${escHtml(fam.parentName)}</strong>
                    <span class="billing-contact">${escHtml(fam.parentEmail)}${fam.parentPhone ? ' · ' + escHtml(fam.parentPhone) : ''}</span>
                </td>
                <td class="report-num report-revenue billing-family-total"><strong>$${familyTotal.toFixed(2)}</strong></td>
            </tr>
            ${newFamilyFeeRow}${supplyFeeFamilyRow}${childRows}`;
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
    const label  = MONTH_NAMES[m - 1] + '-' + y;
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
    document.getElementById('saveScheduleBtn')?.addEventListener('click', saveStaffSchedule);
    document.getElementById('exportStaffBtn')?.addEventListener('click', exportStaffSchedule);
    document.getElementById('emailStaffScheduleBtn')?.addEventListener('click', emailStaffSchedule);

    // Default to the Monday of the current week, then auto-load
    const el = document.getElementById('staffWeekOf');
    if (el) {
        const today = new Date();
        const dow   = today.getDay(); // 0=Sun
        const monday = new Date(today);
        monday.setDate(today.getDate() - (dow === 0 ? 6 : dow - 1));
        el.value = monday.toISOString().split('T')[0];
        el.addEventListener('change', _loadScheduleForWeek);
    }
    // Auto-load the current week's schedule on tab open
    _loadScheduleForWeek();
}

// Convert flat DB rows back to the nested assignments structure
function _dbRowsToAssignments(rows, weekDates) {
    const assignments = {};
    weekDates.forEach(d => {
        assignments[d] = {};
        ROOMS.forEach(r => { assignments[d][r.id] = { am: [], pm: [] }; });
    });
    rows.forEach(row => {
        const slot = assignments[row.work_date]?.[row.room_id];
        if (slot) slot[row.shift].push(row.staff_name);
    });
    return assignments;
}

// Auto-load saved schedule for the selected week; fall back to requirements view
async function _loadScheduleForWeek() {
    const weekOf = document.getElementById('staffWeekOf')?.value;
    if (!weekOf) return;
    const weekDates = _buildWeekDates(weekOf);
    if (!weekDates.length) {
        document.getElementById('staffContent').innerHTML =
            '<p class="empty-hint">No school days in this week (all days are weekends or closures).</p>';
        return;
    }
    // Ensure staff list is loaded so dropdowns are populated immediately
    if (!allStaffData.length) await loadStaffList();
    const counts = _buildShiftCounts(weekDates);
    try {
        const rows = await fetchStaffScheduleWeek(weekDates[0], weekDates[weekDates.length - 1]);
        if (rows.length) {
            const assignments = _dbRowsToAssignments(rows, weekDates);
            renderScheduleTables(weekDates, counts, assignments);
            return;
        }
    } catch (_) { /* fall through */ }
    // No saved schedule — show empty schedule tables
    renderScheduleTables(weekDates, counts, null);
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
    renderScheduleTables(weekDates, counts, null);
}

// ============================================================
// PER-ROOM SCHEDULE TABLE RENDERER
// ============================================================
// Renders one table per room: days across the top, kids counts + staff dropdowns down the side.
// assignments: { date: { roomId: { am: [name,...], pm: [name,...] } } } or null for empty dropdowns.

function renderScheduleTables(weekDates, counts, assignments) {
    _autoFillWeekDates = weekDates;
    _autoFillCounts    = counts;

    const container  = document.getElementById('staffContent');
    const activeStaff = (allStaffData || []).filter(s => s.active);

    function buildOpts(preSelected) {
        let html = '<option value="">—</option>';
        let found = false;
        for (const s of activeStaff) {
            const sel = s.name === preSelected ? ' selected' : '';
            if (sel) found = true;
            html += `<option value="${escHtml(s.name)}"${sel}>${escHtml(s.name)}</option>`;
        }
        if (preSelected && !found) {
            html += `<option value="${escHtml(preSelected)}" selected>${escHtml(preSelected)}</option>`;
        }
        return html;
    }

    const roomBlocks = getSortedRooms().map(room => {
        const ratio = room.staffRatio || 10;
        const hasEnrollment = weekDates.some(d => (counts[d]?.[room.id]?.total || 0) > 0);

        const maxAmNeed = weekDates.reduce((mx, d) => {
            const total = counts[d]?.[room.id]?.total || 0;
            return Math.max(mx, total > 0 ? Math.ceil(total / ratio) : 0);
        }, 0);
        const maxPmNeed = weekDates.reduce((mx, d) => {
            const fd = counts[d]?.[room.id]?.fullDay || 0;
            return Math.max(mx, fd > 0 ? Math.ceil(fd / ratio) : 0);
        }, 0);

        const numCols = weekDates.length + 1;

        const dayHeaders = weekDates.map(d => {
            const dt = new Date(d + 'T00:00:00');
            return `<th class="sched-day-head">${DAY_ABBR[dt.getDay()]}<br><span class="sched-day-date">${friendlyShort(d)}</span><br><button class="sched-day-print-btn" data-date="${d}" title="Print this day">🖨</button></th>`;
        }).join('');

        if (!hasEnrollment) {
            return `
            <div class="room-schedule-block">
                <div class="room-schedule-title">
                    <span class="room-sched-label">${escHtml(room.label)}</span>
                    <span class="room-sched-ratio">Ratio 1:${ratio}</span>
                </div>
                <div class="table-wrapper">
                    <table class="report-table room-sched-table">
                        <thead><tr><th class="sched-row-label-head"></th>${dayHeaders}</tr></thead>
                        <tbody>
                            <tr><td colspan="${numCols}" class="sched-no-enrollment">No enrollment this week</td></tr>
                        </tbody>
                    </table>
                </div>
            </div>`;
        }

        const halfDayCells = weekDates.map(d => {
            const v = counts[d]?.[room.id]?.halfDay || 0;
            return `<td class="sched-kids-cell">${v || '—'}</td>`;
        }).join('');
        const fullDayCells = weekDates.map(d => {
            const v = counts[d]?.[room.id]?.fullDay || 0;
            return `<td class="sched-kids-cell">${v || '—'}</td>`;
        }).join('');
        const amKidsCells = weekDates.map(d => {
            const v = counts[d]?.[room.id]?.total || 0;
            return `<td class="sched-kids-cell sched-am-cell">${v || '—'}</td>`;
        }).join('');
        const amNeededCells = weekDates.map(d => {
            const total = counts[d]?.[room.id]?.total || 0;
            const need  = total > 0 ? Math.ceil(total / ratio) : 0;
            return `<td class="sched-need-cell sched-am-cell">${need || '—'}</td>`;
        }).join('');
        const pmKidsCells = weekDates.map(d => {
            const v = counts[d]?.[room.id]?.fullDay || 0;
            return `<td class="sched-kids-cell sched-pm-cell">${v || '—'}</td>`;
        }).join('');
        const pmNeededCells = weekDates.map(d => {
            const fd   = counts[d]?.[room.id]?.fullDay || 0;
            const need = fd > 0 ? Math.ceil(fd / ratio) : 0;
            return `<td class="sched-need-cell sched-pm-cell">${need || '—'}</td>`;
        }).join('');

        function buildStaffRows(shift, maxNeed, shiftClass) {
            const rows = [];
            for (let slot = 0; slot < maxNeed + 1; slot++) {
                const isOptRow = slot >= maxNeed;
                const label = isOptRow
                    ? `<td class="sched-row-label sched-row-optional-label">+ optional</td>`
                    : `<td class="sched-row-label sched-${shiftClass}-label">${shift.toUpperCase()} Staff ${slot + 1}</td>`;
                const cells = weekDates.map(d => {
                    const countKey = shift === 'am' ? 'total' : 'fullDay';
                    const dayCount = counts[d]?.[room.id]?.[countKey] || 0;
                    const needed   = dayCount > 0 ? Math.ceil(dayCount / ratio) : 0;
                    const isOpt    = slot >= needed;
                    const preVal   = assignments?.[d]?.[room.id]?.[shift]?.[slot] || '';
                    const cls      = isOpt ? 'sched-cell-optional' : `sched-${shiftClass}-cell`;
                    return `<td class="sched-staff-cell ${cls}"><select class="sched-staff-select" data-date="${d}" data-room="${escHtml(room.id)}" data-shift="${shift}" data-slot="${slot}">${buildOpts(preVal)}</select></td>`;
                }).join('');
                rows.push(`<tr class="sched-row-staff${isOptRow ? ' sched-row-optional' : ''}">${label}${cells}</tr>`);
            }
            return rows.join('');
        }

        return `
        <div class="room-schedule-block">
            <div class="room-schedule-title">
                <span class="room-sched-label">${escHtml(room.label)}</span>
                <span class="room-sched-ratio">Ratio 1:${ratio}</span>
            </div>
            <div class="table-wrapper">
                <table class="report-table room-sched-table">
                    <thead>
                        <tr><th class="sched-row-label-head"></th>${dayHeaders}</tr>
                    </thead>
                    <tbody>
                        <tr class="sched-row-kids">
                            <td class="sched-row-label sched-kids-label">Half-Day Kids</td>${halfDayCells}
                        </tr>
                        <tr class="sched-row-kids">
                            <td class="sched-row-label sched-kids-label">Full-Day Kids</td>${fullDayCells}
                        </tr>
                        <tr class="sched-row-shift-header">
                            <td colspan="${numCols}" class="sched-shift-header-cell sched-am-header">AM Shift · 8:15 am – 1:15 pm</td>
                        </tr>
                        <tr class="sched-row-kids">
                            <td class="sched-row-label sched-kids-label">AM Kids (total)</td>${amKidsCells}
                        </tr>
                        <tr class="sched-row-needed">
                            <td class="sched-row-label">AM Staff Needed</td>${amNeededCells}
                        </tr>
                        ${buildStaffRows('am', maxAmNeed, 'am')}
                        <tr class="sched-row-shift-header">
                            <td colspan="${numCols}" class="sched-shift-header-cell sched-pm-header">PM Shift · 12:00 pm – 5:00 pm</td>
                        </tr>
                        <tr class="sched-row-kids">
                            <td class="sched-row-label sched-kids-label">PM Kids (full-day)</td>${pmKidsCells}
                        </tr>
                        <tr class="sched-row-needed">
                            <td class="sched-row-label">PM Staff Needed</td>${pmNeededCells}
                        </tr>
                        ${buildStaffRows('pm', maxPmNeed, 'pm')}
                    </tbody>
                </table>
            </div>
        </div>`;
    }).join('');

    container.innerHTML = `
        <div class="sched-actions-bar">
            <button id="printStaffAssignBtn" class="btn-secondary">🖨 Print</button>
            <button id="exportStaffAssignBtn" class="btn-secondary">⬇ Export XLSX</button>
        </div>
        <div id="scheduleTablesWrap">${roomBlocks}</div>`;

    document.getElementById('printStaffAssignBtn')?.addEventListener('click', () => {
        const weekOf = document.getElementById('staffWeekOf')?.value || '';
        const wrap   = document.getElementById('scheduleTablesWrap');
        if (!wrap) return;
        const clone = wrap.cloneNode(true);
        clone.querySelectorAll('select.sched-staff-select').forEach(sel => {
            const span = document.createElement('span');
            span.textContent = sel.value || '—';
            sel.replaceWith(span);
        });
        const win = window.open('', '_blank');
        win.document.write(`<!DOCTYPE html><html><head><title>Staff Schedule – ${escHtml(weekOf)}</title>
            <style>
            body{font-family:Arial,sans-serif;font-size:11px}
            .room-schedule-block{margin-bottom:18px}
            .room-schedule-title{font-weight:bold;font-size:13px;margin-bottom:4px;display:flex;gap:12px}
            .room-sched-ratio{color:#666;font-weight:normal}
            table{border-collapse:collapse;width:100%}
            th,td{border:1px solid #ccc;padding:4px 6px;text-align:center}
            .sched-row-label{text-align:left;white-space:nowrap;font-size:10px}
            .sched-shift-header-cell{font-weight:bold;text-align:left}
            .sched-am-header{background:#dbeafe}
            .sched-pm-header{background:#fef9c3}
            .sched-row-optional td{color:#aaa}
            .sched-no-enrollment{color:#999;font-style:italic}
            </style></head><body>
            <h2 style="font-size:14px">Staff Schedule – Week of ${escHtml(weekOf)}</h2>
            ${clone.innerHTML}
            </body></html>`);
        win.document.close();
        win.print();
    });

    document.getElementById('exportStaffAssignBtn')?.addEventListener('click', () => {
        const weekOf = document.getElementById('staffWeekOf')?.value || 'schedule';
        const wDates = _autoFillWeekDates || weekDates;
        const asgn   = _readAssignmentsFromDOM(wDates);
        const headers = ['Room', ...wDates.flatMap(d => {
            const dt    = new Date(d + 'T00:00:00');
            const label = `${DAY_ABBR[dt.getDay()]} ${friendlyShort(d)}`;
            return [`${label} AM`, `${label} PM`];
        })];
        const dataRows = getSortedRooms().map(r => {
            const row = [r.label];
            wDates.forEach(d => {
                row.push((asgn[d]?.[r.id]?.am || []).join(', ') || '—');
                row.push((asgn[d]?.[r.id]?.pm || []).join(', ') || '—');
            });
            return row;
        });
        const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
        ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length, 16) }));
        const wb = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(wb, ws, 'Staff Schedule');
        XLSX.writeFile(wb, `staff-schedule-${weekOf}.xlsx`);
    });

    // Lock out already-chosen names within the same date/room/shift group
    function _syncGroup(sel) {
        const { date, shift } = sel.dataset;
        const group = [...container.querySelectorAll(
            `select.sched-staff-select[data-date="${date}"][data-shift="${shift}"]`
        )];
        group.forEach(s => {
            const othersChosen = new Set(group.filter(g => g !== s && g.value).map(g => g.value));
            for (const opt of s.options) {
                if (!opt.value) continue;
                opt.disabled = othersChosen.has(opt.value);
            }
        });
    }

    container.addEventListener('change', e => {
        const sel = e.target.closest('select.sched-staff-select');
        if (sel) _syncGroup(sel);
    });

    container.addEventListener('click', e => {
        const printBtn = e.target.closest('.sched-day-print-btn');
        if (printBtn) _printDay(printBtn.dataset.date, weekDates, counts, assignments);
    });

    // Apply locking to any pre-filled selects (from auto-fill or saved schedule)
    const seenGroups = new Set();
    container.querySelectorAll('select.sched-staff-select').forEach(sel => {
        if (!sel.value) return;
        const key = `${sel.dataset.date}|${sel.dataset.shift}`;
        if (!seenGroups.has(key)) { seenGroups.add(key); _syncGroup(sel); }
    });
}

function _printDay(date, weekDates, counts, assignments) {
    const currentAsgn = _readAssignmentsFromDOM(weekDates || _autoFillWeekDates || [date]);
    const currentCounts = counts || _autoFillCounts || {};
    const dt       = new Date(date + 'T00:00:00');
    const dayLabel = `${DAY_ABBR[dt.getDay()]} ${friendlyShort(date)}`;

    const roomSections = getSortedRooms().map(room => {
        const ratio  = room.staffRatio || 10;
        const c      = currentCounts[date]?.[room.id] || { total: 0, fullDay: 0, halfDay: 0 };
        if (!c.total && !c.fullDay) return '';
        const amStaff = (currentAsgn[date]?.[room.id]?.am || []).filter(Boolean);
        const pmStaff = (currentAsgn[date]?.[room.id]?.pm || []).filter(Boolean);
        const amNeed  = c.total   > 0 ? Math.ceil(c.total   / ratio) : 0;
        const pmNeed  = c.fullDay > 0 ? Math.ceil(c.fullDay / ratio) : 0;
        const amStatus = amStaff.length >= amNeed ? '' : ` <span style="color:#c00">(need ${amNeed})</span>`;
        const pmStatus = pmStaff.length >= pmNeed ? '' : ` <span style="color:#c00">(need ${pmNeed})</span>`;
        return `
        <div style="margin-bottom:16px;border:1px solid #ddd;border-radius:6px;overflow:hidden">
            <div style="background:#f0f4ff;padding:7px 12px;font-weight:700;font-size:13px">${escHtml(room.label)} <span style="font-weight:400;color:#666;font-size:11px">· ratio 1:${ratio}</span></div>
            <table style="width:100%;border-collapse:collapse;font-size:12px">
                <tr style="background:#fafafa">
                    <td style="padding:5px 12px;border-bottom:1px solid #eee;font-weight:600;color:#1d4ed8">AM 8:15–1:15</td>
                    <td style="padding:5px 12px;border-bottom:1px solid #eee">${c.total} kids${amStatus}</td>
                    <td style="padding:5px 12px;border-bottom:1px solid #eee">${amStaff.length ? escHtml(amStaff.join(', ')) : '<em style="color:#999">unassigned</em>'}</td>
                </tr>
                <tr>
                    <td style="padding:5px 12px;font-weight:600;color:#92400e">PM 12:00–5:00</td>
                    <td style="padding:5px 12px">${c.fullDay} kids (full-day)${pmStatus}</td>
                    <td style="padding:5px 12px">${pmStaff.length ? escHtml(pmStaff.join(', ')) : '<em style="color:#999">unassigned</em>'}</td>
                </tr>
            </table>
        </div>`;
    }).filter(Boolean).join('');

    const win = window.open('', '_blank');
    win.document.write(`<!DOCTYPE html><html><head><title>Daily Staff – ${escHtml(dayLabel)}</title>
        <style>body{font-family:Arial,sans-serif;font-size:12px;padding:20px;max-width:700px;margin:0 auto}
        h2{font-size:15px;margin-bottom:4px}p{margin:0 0 14px;color:#666;font-size:11px}
        @media print{body{padding:0}}</style></head>
        <body><h2>Daily Staff Schedule — ${escHtml(dayLabel)}</h2>
        <p>Timothy Lutheran MDO · Printed ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</p>
        ${roomSections || '<p>No enrollment on this day.</p>'}
        </body></html>`);
    win.document.close();
    win.print();
}

function _readAssignmentsFromDOM(weekDates) {
    const assignments = {};
    weekDates.forEach(d => {
        assignments[d] = {};
        ROOMS.forEach(r => { assignments[d][r.id] = { am: [], pm: [] }; });
    });
    const slotMap = {};
    document.querySelectorAll('#staffContent select.sched-staff-select').forEach(sel => {
        const { date, room, shift, slot } = sel.dataset;
        const val = sel.value;
        if (!val) return;
        const key = `${date}|${room}|${shift}`;
        if (!slotMap[key]) slotMap[key] = {};
        slotMap[key][parseInt(slot, 10)] = val;
    });
    Object.entries(slotMap).forEach(([key, slots]) => {
        const [date, room, shift] = key.split('|');
        if (!assignments[date]?.[room]) return;
        const maxSlot = Math.max(...Object.keys(slots).map(Number));
        const arr = [];
        for (let i = 0; i <= maxSlot; i++) {
            if (slots[i]) arr.push(slots[i]);
        }
        assignments[date][room][shift] = arr;
    });
    return assignments;
}

function exportStaffSchedule() {
    const weekOf = document.getElementById('staffWeekOf')?.value;
    if (!weekOf) { alert('Please select a week first.'); return; }
    const weekDates = _autoFillWeekDates || _buildWeekDates(weekOf);
    if (!weekDates.length) { alert('No school days in this week.'); return; }
    const asgn    = _readAssignmentsFromDOM(weekDates);
    const counts  = _autoFillCounts || _buildShiftCounts(weekDates);
    const headers = ['Room', ...weekDates.flatMap(d => {
        const dt    = new Date(d + 'T00:00:00');
        const label = `${DAY_ABBR[dt.getDay()]} ${friendlyShort(d)}`;
        return [`${label} AM Kids`, `${label} AM Staff`, `${label} PM Kids`, `${label} PM Staff`];
    })];
    const dataRows = getSortedRooms().map(r => {
        const ratio = r.staffRatio || 10;
        const row   = [r.label];
        weekDates.forEach(d => {
            const c      = counts[d]?.[r.id] || { total: 0, fullDay: 0 };
            const amNeed = c.total   > 0 ? Math.ceil(c.total   / ratio) : 0;
            const pmNeed = c.fullDay > 0 ? Math.ceil(c.fullDay / ratio) : 0;
            row.push(c.total, amNeed, c.fullDay, pmNeed);
            // Overwrite staff counts with actual names if assigned
            const amNames = (asgn[d]?.[r.id]?.am || []).join(', ');
            const pmNames = (asgn[d]?.[r.id]?.pm || []).join(', ');
            if (amNames) row[row.length - 3] = amNames;
            if (pmNames) row[row.length - 1] = pmNames;
        });
        return row;
    });
    const ws = XLSX.utils.aoa_to_sheet([headers, ...dataRows]);
    ws['!cols'] = headers.map(h => ({ wch: Math.max(h.length, 14) }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Staff Schedule');
    XLSX.writeFile(wb, `staff-schedule-${weekOf}.xlsx`);
}

// ============================================================
// AUTO-FILL STAFF SCHEDULE
// ============================================================
// AM shift ≈ 5 hrs (8:15–1:15), PM shift ≈ 5 hrs (12:00–5:00)
const SHIFT_HRS = { am: 5, pm: 5 };
const DAY_ABBR  = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

let _autoFillWeekDates = null;
let _autoFillCounts    = null;

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
        // Approved time off blocks assignment for that staff member on that
        // date. Only *approved* rows are in this map — a request still sitting
        // in the director's "Needs your OK" queue deliberately has no effect
        // on the draft schedule until she says yes.
        const approvedOff = typeof window.apApprovedOffForWeek === 'function'
            ? window.apApprovedOffForWeek(weekDates)
            : {};
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
                    if ((approvedOff[s.id] || []).includes(d)) return false;
                    const avail = staffAvailability[s.id];
                    // Determine available days from dayPeriods keys or legacy days array
                    const availDays = avail?.dayPeriods
                        ? Object.keys(avail.dayPeriods).filter(d => avail.dayPeriods[d]?.length > 0)
                        : (avail?.days ?? ['Mon','Tue','Wed','Thu','Fri']);
                    const excluded = avail?.excluded_rooms || [];
                    return availDays.includes(dayName) &&
                        (s.room_id === room.id || (!s.room_id && !excluded.includes(room.id)));
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
                    const maxHrs   = staffAvailability[s.id]?.maxHours ?? 40;
                    const maxDays  = staffAvailability[s.id]?.maxDays  ?? 5;
                    const used     = weeklyHours.get(s.id) || 0;
                    const daysUsed = weeklyDays.get(s.id) || 0;
                    if (used + SHIFT_HRS.am > maxHrs) continue;
                    if (daysUsed >= maxDays) continue;
                    assignments[d][room.id].am.push(s.name);
                    weeklyHours.set(s.id, used + SHIFT_HRS.am);
                    weeklyDays.set(s.id, daysUsed + 1);
                    amFilled++;
                }

                // Assign PM (prefer staff already on AM shift first, then others)
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

        renderScheduleTables(weekDates, counts, assignments);
    } catch (err) {
        alert('Auto-fill failed: ' + err.message);
    } finally {
        btn.disabled = false; btn.textContent = '🪄 Auto-Schedule';
    }
}

// ============================================================
// SAVE STAFF SCHEDULE
// ============================================================

async function saveStaffSchedule() {
    if (!_autoFillWeekDates) {
        alert('Please generate a schedule first.');
        return;
    }

    const btn = document.getElementById('saveScheduleBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';

    try {
        if (!allStaffData.length) await loadStaffList();

        const assignments = _readAssignmentsFromDOM(_autoFillWeekDates);
        const count = await saveStaffScheduleWeek(
            _autoFillWeekDates,
            assignments,
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
// EMAIL STAFF SCHEDULE
// ============================================================

async function emailStaffSchedule() {
    if (!_autoFillWeekDates) {
        alert('Please generate a schedule first.');
        return;
    }

    const btn = document.getElementById('emailStaffScheduleBtn');
    btn.disabled = true;
    btn.textContent = 'Sending…';

    try {
        if (!allStaffData.length) await loadStaffList();

        const weekDates   = _autoFillWeekDates;
        const weekStart   = weekDates[0];
        const assignments = _readAssignmentsFromDOM(weekDates);

        // Build per-staff shift lists: { staffName -> [{date, dayLabel, roomLabel, shift}] }
        const staffShifts = {};
        weekDates.forEach(d => {
            const dt       = new Date(d + 'T00:00:00');
            const dayLabel = `${DAY_ABBR[dt.getDay()]} ${friendlyShort(d)}`;
            ROOMS.forEach(room => {
                ['am', 'pm'].forEach(shift => {
                    (assignments[d]?.[room.id]?.[shift] || []).forEach(name => {
                        if (!staffShifts[name]) staffShifts[name] = [];
                        staffShifts[name].push({ date: d, dayLabel, roomLabel: room.label, shift });
                    });
                });
            });
        });

        const staffByName = new Map(allStaffData.map(s => [s.name, s]));
        let sent = 0, skipped = 0;
        const errors = [];

        for (const [name, shifts] of Object.entries(staffShifts)) {
            const staffMember = staffByName.get(name);
            if (!staffMember?.email) { skipped++; continue; }
            try {
                await sendStaffScheduleEmail({
                    staffName:  name,
                    staffEmail: staffMember.email,
                    weekStart,
                    shifts,
                });
                sent++;
            } catch (err) {
                errors.push(`${name}: ${err.message}`);
            }
        }

        let msg = `✓ Sent ${sent} schedule email${sent !== 1 ? 's' : ''}.`;
        if (skipped) msg += ` Skipped ${skipped} (no email on file).`;
        if (errors.length) msg += `\n\nErrors:\n${errors.join('\n')}`;
        alert(msg);
    } catch (err) {
        alert('Email failed: ' + err.message);
    } finally {
        btn.disabled    = false;
        btn.textContent = '✉️ Email Schedules';
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
    return `${MONTH_NAMES[sm-1]} ${sd} – ${MONTH_NAMES[em-1]} ${ed}, ${sy}`;
}

function setupPayrollReport() {
    document.getElementById('generatePayrollBtn')?.addEventListener('click', generatePayrollReport);
    document.getElementById('exportPayrollBtn')?.addEventListener('click', exportPayrollReport);
    document.getElementById('printPayrollBtn')?.addEventListener('click', printPayrollSummary);
    document.getElementById('approveMdoPayrollBtn')?.addEventListener('click', _onToggleMdoPayrollApproval);

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

    // PTO balance cutoff: if set (e.g. imported starting balances from an
    // outside payroll system), PTO accrual/usage below is only counted from
    // this date forward, so it doesn't double-count hours already reflected
    // in someone's imported starting balance. Falls back to ytdStart (old
    // behavior) when unset.
    const [ptoRateHistory, ptoCutoffSetting] = await Promise.all([
        fetchPtoRateHistory(),
        fetchSetting('pto_balance_cutoff_date'),
    ]);
    const ptoCutoffDate = /^\d{4}-\d{2}-\d{2}$/.test(ptoCutoffSetting) ? ptoCutoffSetting : ytdStart;
    // Single "current" rate (as of the period end date) — used only for the
    // period's informational "PTO Accrued This Period" display and its live
    // preview as PTO Requested is edited. The persisted running PTO Balance
    // below is fully date-aware instead, valuing each day worked at whatever
    // rate was in effect that day.
    const ptoCurrentRate = ptoRateForDate(ptoRateHistory, endVal);

    const [allStaff, periodHrs, ytdHrs, cutoffHrs, periodClockEvents, ytdClockEvents, cutoffClockEvents, periodPtoRaw, cutoffPtoRaw] = await Promise.all([
        fetchAllStaff({ includeInactive: true }),
        fetchStaffHours(startVal, endVal),
        fetchStaffHours(ytdStart, endVal),
        fetchStaffHours(ptoCutoffDate, endVal),
        fetchClockEventsForRange(startVal, endVal),
        fetchClockEventsForRange(ytdStart, endVal),
        fetchClockEventsForRange(ptoCutoffDate, endVal),
        fetchStaffPtoEntries(startVal),
        fetchStaffPtoUsedSince(ptoCutoffDate),
    ]);

    // Build a set of (staff_id, work_date) keys that already have a manual hours entry
    function manualKey(staffId, workDate) { return `${staffId}|${workDate}`; }
    const manualPeriodKeys = new Set(periodHrs.map(h => manualKey(h.staff_id, h.work_date)));
    const manualYtdKeys    = new Set(ytdHrs.map(h => manualKey(h.staff_id, h.work_date)));
    const manualCutoffKeys = new Set(cutoffHrs.map(h => manualKey(h.staff_id, h.work_date)));

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
    // Hours worked since the PTO balance cutoff, per staff PER DAY — feeds PTO
    // accrual only, kept separate from ytdMap (which stays calendar-year-based
    // for the report's "Year to Date" column). Day-level granularity (rather
    // than a flat sum) is required so each day's hours can be valued at
    // whatever accrual rate was in effect on that specific date.
    const cutoffDailyMap = new Map(); // staffId -> Map(work_date -> hours)
    function addCutoffDaily(staffId, workDate, hrs) {
        if (!cutoffDailyMap.has(staffId)) cutoffDailyMap.set(staffId, new Map());
        const m = cutoffDailyMap.get(staffId);
        m.set(workDate, (m.get(workDate) || 0) + hrs);
    }
    cutoffHrs.forEach(h => addCutoffDaily(h.staff_id, h.work_date, parseFloat(h.hours_worked)));

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
    cutoffClockEvents.forEach(ev => {
        if (manualCutoffKeys.has(manualKey(ev.staff_id, ev.work_date))) return;
        const hrs = calcClockHrs(ev);
        if (hrs > 0) addCutoffDaily(ev.staff_id, ev.work_date, hrs);
    });

    // Each staff member's total PTO accrued since cutoff, date-aware.
    const cutoffAccruedMap = new Map(); // staffId -> accrued hours
    cutoffDailyMap.forEach((dailyHours, staffId) => {
        let accrued = 0;
        dailyHours.forEach((hrs, workDate) => { accrued += hrs * ptoRateForDate(ptoRateHistory, workDate); });
        cutoffAccruedMap.set(staffId, Math.round(accrued * 100) / 100);
    });

    // Build per-day detail for each staff member (used by click-to-expand in the report)
    // Each entry: { work_date, hours, source, events? }
    // source: 'manual' = typed in by admin, 'clock-sync' = synced from clock-in, 'clock' = live clock calc
    // events: [{clockIn, clockOut}] — individual clock punches for clock and clock-sync days

    // Index all period clock events by staffId|date so we can attach them to detail entries
    const clockEventsByDay = new Map(); // staffId|date → [{clockIn, clockOut, roomId}]
    periodClockEvents.forEach(ev => {
        if (!ev.clock_in || !ev.clock_out) return;
        if (calcClockHrs(ev) <= 0) return;
        const key = manualKey(ev.staff_id, ev.work_date);
        if (!clockEventsByDay.has(key)) clockEventsByDay.set(key, []);
        clockEventsByDay.get(key).push({ id: ev.id, clockIn: ev.clock_in, clockOut: ev.clock_out, roomId: ev.room_id || null });
    });

    const periodDetailMap = new Map(); // staff_id → [{ work_date, hours, source, notes, events }]
    periodHrs.forEach(h => {
        const source = (h.notes || '').toLowerCase().includes('clock') ? 'clock-sync' : 'manual';
        if (!periodDetailMap.has(h.staff_id)) periodDetailMap.set(h.staff_id, []);
        const key = manualKey(h.staff_id, h.work_date);
        const events = clockEventsByDay.get(key) || [];
        periodDetailMap.get(h.staff_id).push({ work_date: h.work_date, hours: parseFloat(h.hours_worked), source, notes: h.notes || '', events, timeIn: h.time_in || null, timeOut: h.time_out || null, roomId: h.room_id || null });
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
        const sepIdx = key.indexOf('|');
        const staffId = key.slice(0, sepIdx);
        const work_date = key.slice(sepIdx + 1);
        if (!periodDetailMap.has(staffId)) periodDetailMap.set(staffId, []);
        const events = clockEventsByDay.get(key) || [];
        periodDetailMap.get(staffId).push({ work_date, hours: hrs, source: 'clock', notes: '', events, timeIn: null, timeOut: null, roomId: null });
    });
    // Sort each staff's detail entries by date
    periodDetailMap.forEach(entries => entries.sort((a, b) => a.work_date.localeCompare(b.work_date)));

    // Build PTO map and add PTO hours to periodMap for gross calc
    const periodPtoMap = new Map(); // staff_id -> { used }
    periodPtoRaw.forEach(p => {
        const used = parseFloat(p.pto_hours_used) || 0;
        periodPtoMap.set(p.staff_id, { used });
        if (used > 0) periodMap.set(p.staff_id, (periodMap.get(p.staff_id) || 0) + used);
    });

    // Running PTO balance (starting balance + accrued − used, since the cutoff date):
    // accrual is earned on hours actually worked (cutoffAccruedMap excludes
    // PTO-used hours), valued at whichever rate was in effect on each work date.
    const cutoffPtoUsedMap = new Map(); // staff_id -> total PTO hours used since cutoff (across all periods)
    cutoffPtoRaw.forEach(p => {
        const used = parseFloat(p.pto_hours_used) || 0;
        cutoffPtoUsedMap.set(p.staff_id, (cutoffPtoUsedMap.get(p.staff_id) || 0) + used);
    });

    // Include active staff + anyone with hours in the period
    const staff = allStaff.filter(s => s.active || periodMap.has(s.id));
    staff.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    return { staff, periodMap, ytdMap, cutoffAccruedMap, periodDetailMap, periodPtoMap, cutoffPtoUsedMap, ptoCurrentRate };
}

async function generatePayrollReport() {
    const sel = document.getElementById('payrollPeriod');
    if (!sel?.value) { alert('Please select a pay period.'); return; }
    const [startVal, endVal] = sel.value.split('|');

    const container = document.getElementById('payrollContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const { staff, periodMap, ytdMap, cutoffAccruedMap, periodDetailMap, periodPtoMap, cutoffPtoUsedMap, ptoCurrentRate } = await _buildPayrollData(startVal, endVal);
        renderPayrollReport(startVal, endVal, staff, periodMap, ytdMap, periodDetailMap, periodPtoMap, cutoffAccruedMap, cutoffPtoUsedMap, ptoCurrentRate);
        await _refreshMdoPayrollApprovalUI(startVal);
    } catch (err) {
        container.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    }
}

// Reads mdo_payroll_approvals for the loaded period and updates the button +
// status line. This is a signal read by the church admin app's own combined
// payroll report over its payroll_get_mdo_period_approval RPC — it says
// nothing about, and is never affected by, that app's own payroll_periods
// approval. Only visible/actionable to a 'full' admin, since the section
// itself is AP_FULL_ONLY_KEYS-gated, but checked again here in case a stale
// tab tries anyway — the RLS policy is the real backstop.
async function _refreshMdoPayrollApprovalUI(periodStart) {
    const btn    = document.getElementById('approveMdoPayrollBtn');
    const status = document.getElementById('mdoPayrollApprovalStatus');
    if (!btn || !status) return;
    btn.dataset.periodStart = periodStart;
    btn.style.display = currentAdminRole === 'full' ? '' : 'none';
    status.style.display = 'none';
    try {
        const approval = await fetchMdoPayrollApproval(periodStart);
        if (approval) {
            btn.textContent = 'Unapprove MDO Payroll';
            const when = new Date(approval.approved_at).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
            status.textContent = `✓ MDO payroll approved by ${approval.approved_by} on ${when}`;
            status.style.display = '';
        } else {
            btn.textContent = 'Approve MDO Payroll';
        }
    } catch (err) {
        console.error('Could not load MDO payroll approval status:', err);
        // Non-fatal — the report itself already rendered. Leave the button
        // showing "Approve" rather than guessing a state we couldn't read.
        btn.textContent = 'Approve MDO Payroll';
    }
}

async function _onToggleMdoPayrollApproval() {
    const btn = document.getElementById('approveMdoPayrollBtn');
    const periodStart = btn?.dataset.periodStart;
    if (!periodStart) return;
    const isApproving = btn.textContent.trim().startsWith('Approve');
    if (!confirm(isApproving
        ? 'Mark this pay period’s MDO hours as approved? The church office will see this when they build the combined payroll.'
        : 'Remove the MDO approval for this pay period?')) return;
    btn.disabled = true;
    try {
        if (isApproving) {
            const email = (window._adminSession?.user?.email || '').trim() || 'unknown';
            await approveMdoPayrollPeriod(periodStart, email);
        } else {
            await unapproveMdoPayrollPeriod(periodStart);
        }
        await _refreshMdoPayrollApprovalUI(periodStart);
    } catch (err) {
        alert(`Could not update the MDO payroll approval: ${err.message}`);
    } finally {
        btn.disabled = false;
    }
}

function _buildAllDaysInPeriod(startISO, endISO) {
    const days = [];
    const cur = new Date(startISO + 'T12:00:00');
    const end = new Date(endISO + 'T12:00:00');
    while (cur <= end) {
        days.push(cur.toISOString().split('T')[0]);
        cur.setDate(cur.getDate() + 1);
    }
    return days;
}

let _ptoPendingTimers = {};
function _schedulePtoSaveUnified(container, staffId, periodStart) {
    clearTimeout(_ptoPendingTimers[staffId]);
    _ptoPendingTimers[staffId] = setTimeout(async () => {
        const usedInput = container.querySelector(`.payroll-pto-input[data-sid="${staffId}"][data-field="used"]`);
        const used = parseFloat(usedInput?.value) || 0;
        // "Earned" is computed live (hours worked this period × the global accrual rate) rather
        // than typed in — read it straight off the display span _recalcPayrollStaff keeps in sync.
        const earnedDisplay = container.querySelector(`.payroll-pto-earned-display[data-staff-id="${staffId}"]`);
        const earned = parseFloat(earnedDisplay?.textContent) || 0;
        try {
            await upsertStaffPtoEntry(staffId, periodStart, used, earned);
            const tick = container.querySelector(`.payroll-pto-save-tick[data-sid="${staffId}"]`);
            if (tick) { tick.style.display = ''; clearTimeout(_ptoPendingTimers[staffId + '_flash']); _ptoPendingTimers[staffId + '_flash'] = setTimeout(() => { tick.style.display = 'none'; }, 1800); }
        } catch(e) { console.error('PTO save error', e); }
    }, 600);
}

function _updatePayrollDayRowState(container, staffId, workDate) {
    const panel  = container.querySelector(`.payroll-detail-panel[data-staff-id="${staffId}"]`);
    const dayRow = panel?.querySelector(`tr.payroll-day-row[data-date="${workDate}"]`);
    if (!dayRow) return;

    const clockPairs = [...dayRow.querySelectorAll('.payroll-clk-pair[data-event-id]')];
    const clockedHrs = parseFloat(dayRow.dataset.clockedHrs || '0') || 0;

    let state = 'empty';
    let displayHrs = null;
    let statusIcon = '';

    if (clockPairs.length > 0) {
        const anyMissingRoom = clockPairs.some(p => !p.querySelector('.payroll-room-select')?.value);
        state = anyMissingRoom ? 'missing' : 'complete';
        displayHrs = clockedHrs > 0 ? clockedHrs : null;
        if (state === 'missing') statusIcon = `<span title="No room assigned" style="color:#E9A020;font-size:15px;cursor:help">⚠</span>`;
        else if (state === 'complete') statusIcon = `<span style="color:#4CAF50;font-size:14px">✓</span>`;
    } else {
        const ti      = dayRow.querySelector('.payroll-time-in')?.value  || '';
        const to      = dayRow.querySelector('.payroll-time-out')?.value || '';
        const roomVal = dayRow.querySelector('.payroll-room-select')?.value || '';
        const calcHrs = (() => {
            if (!ti || !to) return null;
            const [h1, m1] = ti.split(':').map(Number);
            const [h2, m2] = to.split(':').map(Number);
            const mins = (h2 * 60 + m2) - (h1 * 60 + m1);
            return mins > 0 ? Math.round(mins / 60 * 100) / 100 : null;
        })();
        const missingRoom = !!(ti || to) && !roomVal;
        const complete    = calcHrs !== null && !!roomVal;
        const isClockOnly = calcHrs === null && clockedHrs > 0;
        displayHrs = calcHrs !== null ? calcHrs : (clockedHrs > 0 ? clockedHrs : null);
        if (complete)         state = 'complete';
        else if (missingRoom) state = 'missing';
        if (missingRoom)      statusIcon = `<span title="No room assigned" style="color:#E9A020;font-size:15px;cursor:help">⚠</span>`;
        else if (complete)    statusIcon = `<span style="color:#4CAF50;font-size:14px">✓</span>`;
        if (displayHrs !== null && !calcHrs && isClockOnly) {
            // gray for clock-only (no manual entry)
        }
    }

    const hrsCell = dayRow.querySelector('.payroll-day-calc-hrs');
    if (hrsCell) hrsCell.innerHTML = displayHrs !== null
        ? `<strong style="color:var(--navy)">${displayHrs}h</strong>`
        : '<span class="text-muted">—</span>';

    const iconEl = dayRow.querySelector('.payroll-day-status-icon');
    if (iconEl) iconEl.innerHTML = statusIcon;

    dayRow.dataset.state = state;
}

async function _savePayrollTimeInline(staffId, workDate, container, force = false) {
    const panel  = container?.querySelector(`.payroll-detail-panel[data-staff-id="${staffId}"]`);
    const dayRow = panel?.querySelector(`tr.payroll-day-row[data-date="${workDate}"]`);
    if (!dayRow) return;

    const ti     = dayRow.querySelector('.payroll-time-in')?.value  || '';
    const to     = dayRow.querySelector('.payroll-time-out')?.value || '';
    const notes  = dayRow.querySelector('.payroll-notes-input')?.value.trim() || '';
    const roomId = dayRow.querySelector('.payroll-room-select')?.value || null;
    const clockedHrs = parseFloat(dayRow.dataset.clockedHrs || '0') || 0;

    if (!ti && !to && !notes && !roomId && !force) return;

    let hours = 0;
    if (ti && to) {
        const [h1, m1] = ti.split(':').map(Number);
        const [h2, m2] = to.split(':').map(Number);
        const mins = (h2 * 60 + m2) - (h1 * 60 + m1);
        if (mins > 0) hours = Math.round(mins / 60 * 100) / 100;
    } else if (!ti && !to) {
        hours = clockedHrs;
    }

    const tick   = dayRow.querySelector('.payroll-day-save-tick');
    const iconEl = dayRow.querySelector('.payroll-day-status-icon');
    try {
        await upsertStaffHours(staffId, workDate, hours, notes, ti || null, to || null, roomId || null);
        dayRow.dataset.state = 'flash';
        if (tick)   { tick.style.display = ''; if (iconEl) iconEl.style.display = 'none'; }
        setTimeout(() => {
            if (tick)   { tick.style.display = 'none'; if (iconEl) iconEl.style.display = ''; }
            _updatePayrollDayRowState(container, staffId, workDate);
        }, 1800);
        const staffName = container.querySelector(`.payroll-staff-row[data-staff-id="${staffId}"] .payroll-expand-icon + span`)
            ?.childNodes[0]?.textContent?.trim() || 'entry';
        showToast(`Saved ${staffName} — ${dateLabelFor(workDate)}`);
    } catch(e) {
        console.error('Time save error', e);
        // A failed save used to be silent past this console.error — the only
        // feedback was a green check that simply never appeared. That reads
        // identically to "nothing happened yet," which is exactly the
        // "I entered it and it didn't save" report this toast is for.
        showToast('Could not save that entry — check your connection and try again', 'error');
    }
}

function dateLabelFor(workDate) {
    const [, m, d] = workDate.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${d}`;
}

function _recalcPayrollStaff(container, staffId) {
    const summaryRow = container.querySelector(`.payroll-staff-row[data-staff-id="${staffId}"]`);
    if (!summaryRow || summaryRow.dataset.payType === 'salary') return;
    const rate = parseFloat(summaryRow.dataset.rate) || 0;

    let sumHrs = 0, completeDays = 0;
    container.querySelectorAll(`.payroll-day-row[data-staff-id="${staffId}"]`).forEach(dayRow => {
        const clockPairs = [...dayRow.querySelectorAll('.payroll-clk-pair[data-event-id]')];
        if (clockPairs.length > 0) {
            const hrs = parseFloat(dayRow.dataset.clockedHrs || '0') || 0;
            sumHrs += hrs;
            if (dayRow.dataset.state === 'complete') completeDays++;
        } else {
            const ti = dayRow.querySelector('.payroll-time-in')?.value  || '';
            const to = dayRow.querySelector('.payroll-time-out')?.value || '';
            if (ti && to) {
                const [h1, m1] = ti.split(':').map(Number);
                const [h2, m2] = to.split(':').map(Number);
                const mins = (h2 * 60 + m2) - (h1 * 60 + m1);
                if (mins > 0) {
                    sumHrs += Math.round(mins / 60 * 100) / 100;
                    completeDays++;
                }
            } else {
                sumHrs += parseFloat(dayRow.dataset.clockedHrs || '0') || 0;
            }
        }
    });
    const ptoUsedNow = parseFloat(container.querySelector(`.payroll-pto-input[data-sid="${staffId}"][data-field="used"]`)?.value) || 0;
    sumHrs += ptoUsedNow;

    const ptoRate = parseFloat(summaryRow.dataset.ptoRate) || 0;
    const workedHrsNow = Math.max(0, sumHrs - ptoUsedNow);
    const earnedNow = Math.round(workedHrsNow * ptoRate * 100) / 100;
    const earnedDisplay = container.querySelector(`.payroll-pto-earned-display[data-staff-id="${staffId}"]`);
    if (earnedDisplay) earnedDisplay.textContent = `${earnedNow.toFixed(2)} hrs`;

    const ptoUsedInitial     = parseFloat(summaryRow.dataset.ptoUsedInitial) || 0;
    const ptoStartingBalance = parseFloat(summaryRow.dataset.ptoStartingBalance) || 0;
    const cutoffAccrued      = parseFloat(summaryRow.dataset.cutoffAccrued) || 0;
    const cutoffPtoUsedSaved = parseFloat(summaryRow.dataset.cutoffPtoUsedSaved) || 0;
    const liveBalance = Math.round((ptoStartingBalance + cutoffAccrued - (cutoffPtoUsedSaved - ptoUsedInitial + ptoUsedNow)) * 100) / 100;
    const balanceBadge = container.querySelector(`.payroll-pto-balance-badge[data-staff-id="${staffId}"]`);
    if (balanceBadge) {
        balanceBadge.textContent = `PTO Balance: ${liveBalance.toFixed(2)} hrs`;
        balanceBadge.classList.toggle('payroll-pto-balance-negative', liveBalance < 0);
    }

    const hrsCell = container.querySelector(`.payroll-period-hrs-cell[data-staff-id="${staffId}"]`);
    const payCell = container.querySelector(`.payroll-period-pay-cell[data-staff-id="${staffId}"]`);
    if (hrsCell) hrsCell.textContent = sumHrs > 0 ? sumHrs.toFixed(2) + 'h' : '—';
    if (payCell) payCell.textContent = sumHrs > 0 ? '$' + (sumHrs * rate).toFixed(2) : '—';

    const ptHrs = container.querySelector(`.payroll-period-total-hrs[data-staff-id="${staffId}"]`);
    const ptPay = container.querySelector(`.payroll-period-total-pay[data-staff-id="${staffId}"]`);
    if (ptHrs) ptHrs.textContent = sumHrs > 0 ? sumHrs.toFixed(2) + 'h' : '—';
    if (ptPay) ptPay.textContent = sumHrs > 0 ? '$' + (sumHrs * rate).toFixed(2) : '—';

    const totalWkDays = container.querySelectorAll(`.payroll-day-row[data-staff-id="${staffId}"]`).length;
    const pillEl = container.querySelector(`.payroll-completion-pill[data-staff-id="${staffId}"]`);
    if (pillEl) {
        const pillAll  = completeDays === totalWkDays && totalWkDays > 0;
        const pillSome = completeDays > 0 && !pillAll;
        pillEl.style.background  = pillAll ? '#EAF5EA' : pillSome ? '#FEF3E0' : '#F3F2F0';
        pillEl.style.color       = pillAll ? '#2E7D32' : pillSome ? '#9A6800' : '#999';
        pillEl.style.borderColor = pillAll ? '#A5D6A7' : pillSome ? '#E0C060' : '#DDD';
        pillEl.textContent       = `${completeDays}/${totalWkDays} days`;
    }

    _recalcPayrollTotal(container);
}

function _recalcPayrollTotal(container) {
    let total = 0;
    container.querySelectorAll('.payroll-staff-row').forEach(row => {
        const sid = row.dataset.staffId;
        if (row.dataset.payType === 'salary') {
            const payCell = container.querySelector(`.payroll-period-pay-cell[data-staff-id="${sid}"]`);
            total += parseFloat((payCell?.textContent || '').replace('$', '')) || 0;
        } else {
            const rate = parseFloat(row.dataset.rate) || 0;
            const hrsCell = container.querySelector(`.payroll-period-hrs-cell[data-staff-id="${sid}"]`);
            total += (parseFloat(hrsCell?.textContent) || 0) * rate;
        }
    });
    const totalEl = container.querySelector('#payrollTotalRow .report-revenue strong');
    if (totalEl) totalEl.textContent = '$' + total.toFixed(2);
}

function _calcYtdPeriods(startVal, endVal) {
    // Count how many complete 14-day periods from Jan 1 of end year through endVal
    const year     = parseInt(endVal.substring(0, 4), 10);
    const jan1     = new Date(`${year}-01-01T00:00:00`);
    const end      = new Date(endVal + 'T00:00:00');
    const days     = Math.round((end - jan1) / 86400000) + 1;
    return Math.max(1, Math.ceil(days / 14));
}

function renderPayrollReport(startVal, endVal, staff, periodMap, ytdMap, periodDetailMap = new Map(), periodPtoMap = new Map(), cutoffAccruedMap = new Map(), cutoffPtoUsedMap = new Map(), ptoCurrentRate = 0) {
    const container = document.getElementById('payrollContent');
    if (!staff.length) {
        container.innerHTML = '<p class="empty-hint">No staff data found.</p>';
        return;
    }

    const allDays    = _buildAllDaysInPeriod(startVal, endVal);
    const weekDays   = allDays.filter(d => { const dow = new Date(d + 'T12:00:00').getDay(); return dow >= 1 && dow <= 5; });
    const ytdPeriods = _calcYtdPeriods(startVal, endVal);
    const DOW        = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

    const [sy, sm, sd] = startVal.split('-').map(Number);
    const [ey, em, ed] = endVal.split('-').map(Number);
    const periodLabel  = `${MONTH_NAMES[sm-1]} ${sd} – ${MONTH_NAMES[em-1]} ${ed}, ${ey}`;

    const calcH = (ti, to) => {
        if (!ti || !to) return null;
        const [h1, m1] = ti.split(':').map(Number);
        const [h2, m2] = to.split(':').map(Number);
        const mins = (h2 * 60 + m2) - (h1 * 60 + m1);
        return mins > 0 ? Math.round(mins / 60 * 100) / 100 : null;
    };
    const isoToHHMM = iso => {
        if (!iso) return '';
        const d = new Date(iso);
        return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    };
    const fmtEvt = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });

    let totPeriodPay = 0, totYtdPay = 0;

    const rows = staff.map(s => {
        const isSalary  = s.pay_type === 'salary';
        const roomLabel = ROOMS.find(r => r.id === s.room_id)?.label || 'Float';
        const inactive  = !s.active ? ' <span class="chip-waitlist status-chip" style="font-size:.75em">Inactive</span>' : '';

        const pHrsTotal = periodMap.get(s.id) || 0;
        const ptoUsed   = (periodPtoMap.get(s.id) || {}).used || 0;
        const yHrs      = ytdMap.get(s.id) || 0;
        const rate      = isSalary ? 0 : (s.hourly_rate || 0);

        // PTO: earned this period is computed live from hours actually worked (excludes PTO-used
        // hours already folded into pHrsTotal), valued at the rate in effect as of the period's
        // end date — an informational display only. Balance is an imported starting balance
        // (0 if never set) plus accrued-since-cutoff minus used-since-cutoff — "cutoff" being
        // settings.pto_balance_cutoff_date — and IS fully rate-history-aware: cutoffAccruedMap
        // already valued each day worked at whatever rate applied on that specific date, so a
        // scheduled future rate change never retroactively changes past accrual.
        const workedHrsThisPeriod = Math.max(0, pHrsTotal - ptoUsed);
        const ptoEarnedThisPeriod = Math.round(workedHrsThisPeriod * ptoCurrentRate * 100) / 100;
        const ptoStartingBalance  = s.pto_starting_balance || 0;
        const cutoffAccrued       = cutoffAccruedMap.get(s.id) || 0;
        const cutoffPtoUsedSaved  = cutoffPtoUsedMap.get(s.id) || 0;
        const ptoBalance          = Math.round((ptoStartingBalance + cutoffAccrued - cutoffPtoUsedSaved) * 100) / 100;

        const detailByDate = new Map();
        (periodDetailMap.get(s.id) || []).forEach(d => detailByDate.set(d.work_date, d));

        let completeDays = 0;
        weekDays.forEach(date => {
            const d = detailByDate.get(date);
            const ti = d?.timeIn || '';
            const to = d?.timeOut || '';
            if (!ti && !to) {
                const ev0 = d?.events?.[0], evL = d?.events?.[d.events.length - 1];
                if (ev0 && evL && calcH(isoToHHMM(ev0.clockIn), isoToHHMM(evL.clockOut)) !== null) completeDays++;
            } else if (calcH(ti, to) !== null) completeDays++;
        });
        const totalWkDays = weekDays.length;
        const pillAll  = completeDays === totalWkDays && totalWkDays > 0;
        const pillSome = completeDays > 0 && !pillAll;
        const pillBg    = pillAll ? '#EAF5EA' : pillSome ? '#FEF3E0' : '#F3F2F0';
        const pillColor = pillAll ? '#2E7D32' : pillSome ? '#9A6800' : '#999';
        const pillBdr   = pillAll ? '#A5D6A7' : pillSome ? '#E0C060' : '#DDD';

        let rateStr, periodHrsStr, periodPayStr, ytdHrsStr, ytdPayStr;
        if (isSalary) {
            const sal    = s.salary_biweekly || 0;
            const ytdSal = sal * ytdPeriods;
            totPeriodPay += sal;
            totYtdPay    += ytdSal;
            rateStr       = `<span class="pay-type-chip pay-salary">Salary</span>`;
            periodHrsStr  = '—';
            periodPayStr  = sal > 0 ? '$' + sal.toFixed(2) : '—';
            ytdHrsStr     = '—';
            ytdPayStr     = ytdSal > 0 ? '$' + ytdSal.toFixed(2) : '—';
        } else {
            totPeriodPay += pHrsTotal * rate;
            totYtdPay    += yHrs * rate;
            rateStr       = `$${rate.toFixed(2)}/hr`;
            periodHrsStr  = pHrsTotal > 0 ? pHrsTotal.toFixed(2) + 'h' : '—';
            periodPayStr  = pHrsTotal > 0 ? '$' + (pHrsTotal * rate).toFixed(2) : '—';
            ytdHrsStr     = yHrs > 0 ? yHrs.toFixed(2) + 'h' : '—';
            ytdPayStr     = yHrs > 0 ? '$' + (yHrs * rate).toFixed(2) : '—';
        }

        const dailyRows = weekDays.map(date => {
            const d = detailByDate.get(date);
            const [, dm, dd] = date.split('-').map(Number);
            const dowIdx    = new Date(date + 'T12:00:00').getDay();
            const dateLabel = `${DOW[dowIdx]} ${MONTH_NAMES[dm-1]} ${dd}`;

            const dayEvents  = d?.events || [];
            const clockedHrs = dayEvents.reduce((sum, ev) => {
                const ms = new Date(ev.clockOut) - new Date(ev.clockIn);
                return sum + (ms >= 600000 ? Math.round(ms / 3600000 * 100) / 100 : 0);
            }, 0);
            const validPairs = dayEvents.filter(ev => ev.clockIn && ev.clockOut);

            const timeIn  = d?.timeIn  || '';
            const timeOut = d?.timeOut || '';
            const roomId  = d?.roomId  || '';

            const roomOptsManual = getSortedRooms().map(r =>
                `<option value="${escHtml(r.id)}"${roomId === r.id ? ' selected' : ''}>${escHtml(r.label)}</option>`
            ).join('');

            const clockPairsHtml = validPairs.length
                ? validPairs.map(ev => {
                    const tiVal = isoToHHMM(ev.clockIn);
                    const toVal = isoToHHMM(ev.clockOut);
                    const evRoomOpts = getSortedRooms().map(r =>
                        `<option value="${escHtml(r.id)}"${ev.roomId === r.id ? ' selected' : ''}>${escHtml(r.label)}</option>`
                    ).join('');
                    return `<div class="payroll-clk-pair" data-event-id="${escHtml(ev.id)}">` +
                        `<select class="payroll-room-select payroll-pair-room" data-event-id="${escHtml(ev.id)}" data-staff-id="${escHtml(s.id)}" data-work-date="${date}" data-prev-value="${escHtml(ev.roomId || '')}"><option value="">— Room</option>${evRoomOpts}</select>` +
                        `<span class="payroll-pair-clk-ref">${escHtml(fmtEvt(ev.clockIn))} → ${escHtml(fmtEvt(ev.clockOut))}</span>` +
                        `<input type="time" class="payroll-pair-time-in" data-event-id="${escHtml(ev.id)}" data-staff-id="${escHtml(s.id)}" data-work-date="${date}" value="${escHtml(tiVal)}">` +
                        `<span class="payroll-pair-sep">→</span>` +
                        `<input type="time" class="payroll-pair-time-out" data-event-id="${escHtml(ev.id)}" data-staff-id="${escHtml(s.id)}" data-work-date="${date}" value="${escHtml(toVal)}">` +
                        `<button class="payroll-clk-delete-btn btn-ghost" data-event-id="${escHtml(ev.id)}" data-staff-id="${escHtml(s.id)}" data-work-date="${date}" title="Delete clock event">×</button>` +
                        `</div>`;
                }).join('')
                : `<div class="payroll-manual-pair">` +
                    `<select class="payroll-room-select payroll-pair-room" data-staff-id="${escHtml(s.id)}" data-work-date="${date}" data-prev-value="${escHtml(roomId)}"><option value="">— Room</option>${roomOptsManual}</select>` +
                    `<span class="payroll-pair-clk-ref"></span>` +
                    `<input type="time" class="payroll-time-input payroll-time-in" data-staff-id="${escHtml(s.id)}" data-work-date="${date}" value="${escHtml(timeIn)}">` +
                    `<span class="payroll-pair-sep">→</span>` +
                    `<input type="time" class="payroll-time-input payroll-time-out" data-staff-id="${escHtml(s.id)}" data-work-date="${date}" value="${escHtml(timeOut)}">` +
                    `</div>`;

            let state = 'empty';
            if (validPairs.length > 0) {
                const anyMissingRoom = validPairs.some(ev => !ev.roomId);
                state = anyMissingRoom ? 'missing' : 'complete';
            } else {
                const missingRoom = !!(timeIn || timeOut) && !roomId;
                const calcHrs = calcH(timeIn, timeOut);
                if (calcHrs !== null && !!roomId) state = 'complete';
                else if (missingRoom) state = 'missing';
            }

            const isClockDay  = validPairs.length > 0;
            const displayHrs  = isClockDay ? (clockedHrs > 0 ? clockedHrs : null)
                                           : (calcH(timeIn, timeOut) ?? (clockedHrs > 0 ? clockedHrs : null));
            const hoursHtml   = displayHrs !== null
                ? `<strong style="color:${isClockDay ? 'var(--navy)' : (!timeIn || !timeOut) && clockedHrs > 0 ? '#888' : 'var(--navy)'}">${displayHrs}h</strong>`
                : '<span class="text-muted">—</span>';

            const missingRoom = !isClockDay && !!(timeIn || timeOut) && !roomId;
            const complete    = state === 'complete';
            let statusIcon = '';
            if (missingRoom || state === 'missing') statusIcon = `<span title="No room assigned" style="color:#E9A020;font-size:15px;cursor:help">⚠</span>`;
            else if (complete)                      statusIcon = `<span style="color:#4CAF50;font-size:14px">✓</span>`;

            return `<tr class="payroll-day-row" data-date="${date}" data-staff-id="${escHtml(s.id)}"
                        data-state="${state}" data-clocked-hrs="${clockedHrs.toFixed(2)}">
                <td class="payroll-day-date">${dateLabel}</td>
                <td class="payroll-day-events">
                    ${clockPairsHtml}
                    <button class="btn-ghost payroll-edit-clk-btn"
                        data-staff-id="${escHtml(s.id)}" data-staff-name="${escHtml(s.name)}" data-work-date="${date}"
                        title="Add / edit clock events" style="font-size:.75em;padding:2px 5px;margin-top:4px;opacity:.45;display:block">✎</button>
                </td>
                <td class="payroll-day-calc-hrs">${hoursHtml}</td>
                <td class="payroll-day-notes">
                    <input type="text" class="payroll-notes-input"
                        placeholder="Notes"
                        data-staff-id="${escHtml(s.id)}" data-work-date="${date}"
                        value="${escHtml(d?.notes || '')}">
                </td>
                <td class="payroll-day-status">
                    <span class="payroll-day-status-icon">${statusIcon}</span>
                    <span class="payroll-day-save-tick" style="display:none;color:#2E7D32;font-size:14px;font-weight:700">✓</span>
                </td>
            </tr>`;
        }).join('');

        const ptHrs = isSalary ? '—' : (pHrsTotal > 0 ? pHrsTotal.toFixed(2) + 'h' : '—');
        const ptPay = isSalary ? (s.salary_biweekly > 0 ? '$' + s.salary_biweekly.toFixed(2) : '—')
                               : (pHrsTotal > 0 ? '$' + (pHrsTotal * rate).toFixed(2) : '—');

        const ptoSection = !isSalary ? `
            <tr class="payroll-pto-row">
                <td colspan="5" style="padding:0">
                    <div class="payroll-pto-bar">
                        <span class="payroll-pto-label">PTO Accrued This Period:</span>
                        <span class="payroll-pto-earned-display" data-staff-id="${escHtml(s.id)}">${ptoEarnedThisPeriod.toFixed(2)} hrs</span>
                        ${ptoCurrentRate > 0 ? `<span class="payroll-pto-rate-note">(at ${ptoCurrentRate} hr per hr worked)</span>` : `<span class="payroll-pto-rate-note">(no accrual rate set — see Settings)</span>`}
                        <span class="payroll-pto-save-tick" data-sid="${escHtml(s.id)}" style="display:none;color:#166534;font-size:.78em;margin-left:8px">✓ Saved</span>
                    </div>
                </td>
            </tr>` : '';

        const ptoCell = isSalary ? '<td class="payroll-pto-main-cell report-num">—</td>' : `
                <td class="payroll-pto-main-cell">
                    <div class="payroll-pto-requested">
                        <label class="payroll-pto-label">PTO Requested</label>
                        <input type="number" class="payroll-pto-input rate-input" min="0" step="0.25" style="width:60px"
                            data-sid="${escHtml(s.id)}" data-field="used" value="${ptoUsed || ''}">
                        <span class="payroll-pto-unit">hrs</span>
                    </div>
                    <span class="payroll-pto-balance-badge${ptoBalance < 0 ? ' payroll-pto-balance-negative' : ''}" data-staff-id="${escHtml(s.id)}">
                        PTO Balance: ${ptoBalance.toFixed(2)} hrs
                    </span>
                </td>`;

        return `
            <tr class="payroll-staff-row payroll-expandable" data-staff-id="${escHtml(s.id)}"
                data-rate="${rate}" data-pay-type="${s.pay_type || 'hourly'}"
                data-pto-rate="${ptoCurrentRate}" data-pto-used-initial="${ptoUsed}"
                data-pto-starting-balance="${ptoStartingBalance}"
                data-cutoff-accrued="${cutoffAccrued}" data-cutoff-pto-used-saved="${cutoffPtoUsedSaved}">
                <td class="payroll-staff-name-cell">
                    <span class="payroll-expand-icon" style="margin-right:6px;color:#8C8070;font-size:11px;user-select:none">▶</span><span style="font-size:14px;font-weight:700;color:var(--navy)">${escHtml(s.name)}${inactive}</span>
                    <div class="rates-ages" style="margin-left:17px">${escHtml(s.role || '')} · ${escHtml(roomLabel)}</div>
                </td>
                <td class="payroll-rate-cell">${rateStr}</td>
                <td class="report-num payroll-period-hrs-cell" data-staff-id="${escHtml(s.id)}">${periodHrsStr}</td>
                <td class="report-num report-revenue payroll-period-pay-cell" data-staff-id="${escHtml(s.id)}">${periodPayStr}</td>
                <td class="report-num payroll-ytd-cell">${ytdHrsStr}</td>
                <td class="report-num report-revenue payroll-ytd-pay-cell">${ytdPayStr}</td>
                ${ptoCell}
                <td class="payroll-completion-cell">
                    <span class="payroll-completion-pill" data-staff-id="${escHtml(s.id)}"
                        style="background:${pillBg};color:${pillColor};border:1px solid ${pillBdr}">
                        ${completeDays}/${totalWkDays} days
                    </span>
                </td>
            </tr>
            <tr class="payroll-detail-panel" data-staff-id="${escHtml(s.id)}" style="display:none">
                <td colspan="7" class="payroll-panel-cell">
                    <table class="payroll-day-table">
                        <colgroup>
                            <col style="width:115px">
                            <col>
                            <col style="width:52px">
                            <col>
                            <col style="width:38px">
                        </colgroup>
                        <thead>
                            <tr>
                                <th class="payroll-day-th">Date</th>
                                <th class="payroll-day-th">Clock Events</th>
                                <th class="payroll-day-th payroll-day-th-center">Hours</th>
                                <th class="payroll-day-th">Notes</th>
                                <th class="payroll-day-th"></th>
                            </tr>
                        </thead>
                        <tbody>${dailyRows}</tbody>
                        <tfoot>
                            <tr class="payroll-period-total-row">
                                <td colspan="5">
                                    <div class="payroll-period-total-inner">
                                        <span class="payroll-period-total-label">Period Total</span>
                                        <span class="payroll-period-total-hrs" data-staff-id="${escHtml(s.id)}">${ptHrs}</span>
                                        <span class="payroll-period-total-pay" data-staff-id="${escHtml(s.id)}">${ptPay}</span>
                                    </div>
                                </td>
                            </tr>
                            ${ptoSection}
                        </tfoot>
                    </table>
                </td>
            </tr>`;
    }).join('');

    container.innerHTML = `
        <p style="font-size:12.5px;color:#6B7280;margin:0 0 16px">${periodLabel} — click a staff row to expand daily hours. Time entries auto-save on blur.</p>
        <div class="table-wrapper report-table-wrap payroll-table-wrap">
            <table class="report-table payroll-table">
                <thead>
                    <tr class="payroll-outer-head-1">
                        <th style="text-align:left">Staff Member</th>
                        <th class="payroll-rate-header">Rate</th>
                        <th colspan="2" class="staff-room-header payroll-period-header">This Period</th>
                        <th colspan="2" class="staff-room-header payroll-period-header">Year to Date (${ey})</th>
                        <th class="payroll-pto-header">PTO</th>
                        <th></th>
                    </tr>
                    <tr class="payroll-outer-head-2">
                        <th></th>
                        <th></th>
                        <th class="staff-sub-head">Hours</th>
                        <th class="staff-sub-head">Gross Pay</th>
                        <th class="staff-sub-head">Hours</th>
                        <th class="staff-sub-head">Gross Pay</th>
                        <th></th>
                        <th></th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
                <tfoot>
                    <tr class="report-total-row" id="payrollTotalRow">
                        <td><strong>Total Payroll</strong></td>
                        <td></td>
                        <td class="report-num">—</td>
                        <td class="report-num report-revenue"><strong>$${totPeriodPay.toFixed(2)}</strong></td>
                        <td class="report-num">—</td>
                        <td class="report-num report-revenue"><strong>$${totYtdPay.toFixed(2)}</strong></td>
                        <td></td>
                        <td></td>
                    </tr>
                </tfoot>
            </table>
        </div>
        <div class="payroll-legend">
            <div class="payroll-legend-item"><div class="payroll-legend-bar" style="background:#4CAF50"></div>Day complete</div>
            <div class="payroll-legend-item"><div class="payroll-legend-bar" style="background:#E9A020"></div>Missing room</div>
            <div class="payroll-legend-item"><span style="color:#C0392B;font-weight:700;font-size:13px">≠</span> Hours differ from clock record</div>
            <div class="payroll-legend-item"><span style="color:#2E7D32">✓</span> Saved</div>
        </div>`;

    container.querySelectorAll('.payroll-expandable').forEach(row => {
        row.addEventListener('click', e => {
            if (e.target.closest('input, select, button, a')) return;
            const staffId  = row.dataset.staffId;
            const panel    = container.querySelector(`.payroll-detail-panel[data-staff-id="${staffId}"]`);
            if (!panel) return;
            const icon     = row.querySelector('.payroll-expand-icon');
            const expanded = panel.style.display !== 'none';
            panel.style.display = expanded ? 'none' : '';
            row.style.background = expanded ? '' : '#EDE6D6';
            if (icon) icon.textContent = expanded ? '▶' : '▼';
        });
    });

    container.querySelectorAll('.payroll-time-input').forEach(input => {
        input.addEventListener('input', () => {
            _updatePayrollDayRowState(container, input.dataset.staffId, input.dataset.workDate);
            _recalcPayrollStaff(container, input.dataset.staffId);
        });
        input.addEventListener('blur', () => _savePayrollTimeInline(input.dataset.staffId, input.dataset.workDate, container));
    });

    container.querySelectorAll('.payroll-pair-time-in, .payroll-pair-time-out').forEach(input => {
        input.addEventListener('change', () => {
            _updatePayrollDayRowState(container, input.dataset.staffId, input.dataset.workDate);
            _recalcPayrollStaff(container, input.dataset.staffId);
        });
        input.addEventListener('blur', () =>
            _saveClockEventEdit(input.dataset.eventId, input.dataset.workDate, input.dataset.staffId, container)
        );
    });

    container.querySelectorAll('.payroll-notes-input').forEach(input => {
        input.addEventListener('blur', () => _savePayrollTimeInline(input.dataset.staffId, input.dataset.workDate, container));
    });

    container.querySelectorAll('.payroll-room-select').forEach(sel => {
        sel.addEventListener('change', async () => {
            if (typeof currentAdminRole !== 'undefined' && currentAdminRole !== 'full') {
                alert('You do not have permission to update room assignments.');
                sel.value = sel.dataset.prevValue ?? '';
                return;
            }
            const prev = sel.dataset.prevValue ?? '';
            sel.dataset.prevValue = sel.value;
            const eventId = sel.dataset.eventId;
            if (eventId) {
                try {
                    await updateClockEventRoom(eventId, sel.value || null);
                } catch (err) {
                    alert('Failed to update room: ' + err.message);
                    sel.value = prev;
                    sel.dataset.prevValue = prev;
                    return;
                }
                _updatePayrollDayRowState(container, sel.dataset.staffId, sel.dataset.workDate);
                _recalcPayrollStaff(container, sel.dataset.staffId);
            } else {
                _updatePayrollDayRowState(container, sel.dataset.staffId, sel.dataset.workDate);
                _savePayrollTimeInline(sel.dataset.staffId, sel.dataset.workDate, container);
            }
        });
    });

    container.querySelectorAll('.payroll-pto-input').forEach(input => {
        input.addEventListener('input', () => {
            const sid = input.dataset.sid;
            _schedulePtoSaveUnified(container, sid, startVal);
            _recalcPayrollStaff(container, sid);
        });
    });

    container.querySelectorAll('.payroll-edit-clk-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            _openInlineClockEditor(btn.closest('tr'), btn.dataset.staffId, btn.dataset.staffName, btn.dataset.workDate);
        });
    });

    container.querySelectorAll('.payroll-clk-delete-btn').forEach(btn => {
        btn.addEventListener('click', async e => {
            e.stopPropagation();
            const { eventId, staffId, workDate } = btn.dataset;
            if (!confirm('Delete this clock event?')) return;
            btn.disabled = true; btn.textContent = '…';
            try {
                await deleteClockEvent(eventId);
                await _refreshPayrollDayRow(staffId, workDate);
            } catch(err) {
                alert('Failed to delete: ' + err.message);
                btn.disabled = false; btn.textContent = '×';
            }
        });
    });
}

// ── Inline Clock Event Editor (expands below the clicked day row) ────────────
function _openInlineClockEditor(dayRow, staffId, staffName, workDate) {
    const existing = document.querySelector('.payroll-clk-editor-row');
    if (existing) {
        const sameRow = existing.dataset.staffId === staffId && existing.dataset.workDate === workDate;
        const oldSid  = existing.dataset.staffId;
        const oldDate = existing.dataset.workDate;
        existing.remove();
        _refreshPayrollDayRow(oldSid, oldDate);
        if (sameRow) return;
    }

    const [, dm, dd] = workDate.split('-').map(Number);
    const dateLabel = `${MONTH_NAMES[dm-1]} ${dd}`;

    const editorRow = document.createElement('tr');
    editorRow.className = 'payroll-clk-editor-row';
    editorRow.dataset.staffId  = staffId;
    editorRow.dataset.workDate = workDate;
    editorRow.innerHTML = `
        <td colspan="5" class="payroll-clk-editor-cell">
            <div class="cee-inline-header">
                <strong>${escHtml(staffName)}</strong>
                <span class="text-muted" style="font-size:.85em;margin-left:6px">· Clock Events · ${escHtml(dateLabel)}</span>
                <button class="btn-ghost cee-done-btn" style="margin-left:auto;font-size:.82em">✕ Done</button>
            </div>
            <div id="clockEditorBody" class="cee-inline-body">
                <p class="empty-hint">Loading…</p>
            </div>
        </td>`;

    dayRow.insertAdjacentElement('afterend', editorRow);

    editorRow.querySelector('.cee-done-btn').addEventListener('click', () => {
        editorRow.remove();
        _refreshPayrollDayRow(staffId, workDate);
    });

    _renderClockEditorBody(staffId, workDate);
}

async function _renderClockEditorBody(staffId, workDate) {
    const body = document.getElementById('clockEditorBody');
    if (!body) return;

    const fmtTime  = iso => iso ? new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) : '—';
    const fmtInput = iso => { const d = iso ? new Date(iso) : new Date(); return d.toTimeString().slice(0, 5); };
    const toISO    = t  => new Date(`${workDate}T${t}:00`).toISOString();

    try {
        const allEvents  = await fetchClockEventsForDate(workDate);
        const events     = allEvents.filter(e => e.staff_id === staffId).sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in));

        const eventRows = events.map(ev => {
            const isOpen = ev.clock_in && !ev.clock_out;
            const hrs    = (ev.clock_in && ev.clock_out) ? ((new Date(ev.clock_out) - new Date(ev.clock_in)) / 3600000).toFixed(2) : null;
            return `<div class="cee-event-item${isOpen ? ' cee-open' : ''}" data-event-id="${ev.id}">
                <div class="cee-display">
                    <span class="cee-label">${isOpen ? '⚠ ' : ''}${fmtTime(ev.clock_in)} → ${isOpen ? '<em>open</em>' : fmtTime(ev.clock_out)}${hrs ? ` <span class="cee-hrs">(${hrs}h)</span>` : ''}</span>
                    ${isOpen ? `<input type="time" class="cee-out-time" value="${fmtInput(null)}">
                        <button class="btn-secondary cee-clock-out-btn" data-event-id="${ev.id}">Clock Out</button>` : `<button class="btn-ghost cee-edit-btn">Edit</button>`}
                    <button class="btn-ghost cee-delete-btn" data-event-id="${ev.id}" style="color:var(--tang-dark)">✕</button>
                </div>
                <div class="cee-edit-form" style="display:none">
                    <input type="time" class="cee-edit-in" value="${fmtInput(ev.clock_in)}">
                    <span>→</span>
                    <input type="time" class="cee-edit-out" value="${fmtInput(ev.clock_out)}">
                    <button class="btn-secondary cee-save-btn" data-event-id="${ev.id}">Save</button>
                    <button class="btn-ghost cee-cancel-edit-btn">Cancel</button>
                </div>
            </div>`;
        }).join('');

        body.innerHTML = `
            <div class="cee-events-list">${events.length ? eventRows : '<p class="empty-hint" style="margin:0 0 12px">No clock events for this day.</p>'}</div>
            <div class="cee-add-form" style="display:none">
                <input type="time" class="cee-new-in" value="09:00">
                <span>→</span>
                <input type="time" class="cee-new-out">
                <button class="btn-secondary cee-confirm-add-btn">Add</button>
                <button class="btn-ghost cee-cancel-add-btn">Cancel</button>
            </div>
            <div class="cee-actions">
                <button class="btn-ghost cee-show-add-btn">+ Add Entry</button>
                <button class="btn-ghost cee-clock-in-now-btn">Clock In Now</button>
            </div>`;

        // Edit / cancel edit
        body.querySelectorAll('.cee-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const item = btn.closest('.cee-event-item');
                item.querySelector('.cee-display').style.display = 'none';
                item.querySelector('.cee-edit-form').style.display = 'flex';
            });
        });
        body.querySelectorAll('.cee-cancel-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const item = btn.closest('.cee-event-item');
                item.querySelector('.cee-edit-form').style.display = 'none';
                item.querySelector('.cee-display').style.display = '';
            });
        });

        // Save edit
        body.querySelectorAll('.cee-save-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const item = btn.closest('.cee-event-item');
                const inV  = item.querySelector('.cee-edit-in').value;
                const outV = item.querySelector('.cee-edit-out').value;
                if (!inV) { alert('Clock-in time is required.'); return; }
                btn.disabled = true;
                try {
                    await updateClockEvent(btn.dataset.eventId, toISO(inV), outV ? toISO(outV) : null);
                    await _renderClockEditorBody(staffId, workDate);
                } catch(e) { alert('Save failed: ' + e.message); btn.disabled = false; }
            });
        });

        // Delete
        body.querySelectorAll('.cee-delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                if (!confirm('Delete this clock entry?')) return;
                btn.disabled = true;
                try {
                    await deleteClockEvent(btn.dataset.eventId);
                    await _renderClockEditorBody(staffId, workDate);
                } catch(e) { alert('Delete failed: ' + e.message); btn.disabled = false; }
            });
        });

        // Clock out open events
        body.querySelectorAll('.cee-clock-out-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const item = btn.closest('.cee-event-item');
                const tInp = item.querySelector('.cee-out-time');
                if (!tInp?.value) { alert('Enter a clock-out time.'); return; }
                btn.disabled = true;
                try {
                    await updateClockEventOut(btn.dataset.eventId, toISO(tInp.value));
                    await _renderClockEditorBody(staffId, workDate);
                } catch(e) { alert('Clock-out failed: ' + e.message); btn.disabled = false; }
            });
        });

        // Show/hide Add Entry form
        body.querySelector('.cee-show-add-btn').addEventListener('click', () => {
            body.querySelector('.cee-add-form').style.display = 'flex';
            body.querySelector('.cee-actions').style.display = 'none';
            body.querySelector('.cee-new-in').value = '09:00';
            body.querySelector('.cee-new-out').value = '';
            body.querySelector('.cee-new-in').focus();
        });
        body.querySelector('.cee-cancel-add-btn').addEventListener('click', () => {
            body.querySelector('.cee-add-form').style.display = 'none';
            body.querySelector('.cee-actions').style.display = '';
        });
        body.querySelector('.cee-confirm-add-btn').addEventListener('click', async () => {
            const inV  = body.querySelector('.cee-new-in').value;
            const outV = body.querySelector('.cee-new-out').value;
            if (!inV) { alert('Clock-in time is required.'); return; }
            const b = body.querySelector('.cee-confirm-add-btn');
            b.disabled = true;
            try {
                await insertManualClockEvent(staffId, workDate, toISO(inV), outV ? toISO(outV) : null);
                await _renderClockEditorBody(staffId, workDate);
            } catch(e) { alert('Failed: ' + e.message); b.disabled = false; }
        });

        // Clock In Now
        body.querySelector('.cee-clock-in-now-btn').addEventListener('click', async () => {
            const b = body.querySelector('.cee-clock-in-now-btn');
            b.disabled = true; b.textContent = 'Clocking in…';
            try {
                await insertManualClockEvent(staffId, workDate, new Date().toISOString(), null);
                await _renderClockEditorBody(staffId, workDate);
            } catch(e) { alert('Failed: ' + e.message); b.disabled = false; b.textContent = 'Clock In Now'; }
        });

    } catch(e) {
        body.innerHTML = `<p class="import-error">Error: ${escHtml(e.message)}</p>`;
    }
}

async function _saveClockEventEdit(eventId, workDate, staffId, container) {
    const panel  = container?.querySelector(`.payroll-detail-panel[data-staff-id="${staffId}"]`);
    const pair   = panel?.querySelector(`.payroll-clk-pair[data-event-id="${eventId}"]`);
    if (!pair) return;
    const tiVal  = pair.querySelector('.payroll-pair-time-in')?.value  || '';
    const toVal  = pair.querySelector('.payroll-pair-time-out')?.value || '';
    if (!tiVal && !toVal) return;
    const toISO  = t => new Date(`${workDate}T${t}:00`).toISOString();
    const ciISO  = tiVal ? toISO(tiVal) : null;
    const coISO  = toVal ? toISO(toVal) : null;
    const dayRow = panel?.querySelector(`tr.payroll-day-row[data-date="${workDate}"]`);
    const tick   = dayRow?.querySelector('.payroll-day-save-tick');
    const iconEl = dayRow?.querySelector('.payroll-day-status-icon');
    try {
        await updateClockEvent(eventId, ciISO, coISO);
        if (dayRow) dayRow.dataset.state = 'flash';
        if (tick)   { tick.style.display = ''; if (iconEl) iconEl.style.display = 'none'; }
        setTimeout(() => {
            if (tick)   { tick.style.display = 'none'; if (iconEl) iconEl.style.display = ''; }
            _refreshPayrollDayRow(staffId, workDate);
        }, 1200);
    } catch(e) { console.error('Clock event edit error', e); }
}

async function _refreshPayrollDayRow(staffId, workDate) {
    const container = document.getElementById('payrollContent');
    if (!container) return;
    try {
        const allEvents   = await fetchClockEventsForDate(workDate);
        const staffEvents = allEvents.filter(e => e.staff_id === staffId && e.clock_in && e.clock_out)
            .sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in));
        const fmtTime    = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
        const isoToHHMM = iso => { const d = new Date(iso); return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
        const clockedHrs = staffEvents.reduce((sum, ev) => {
            const ms = new Date(ev.clock_out) - new Date(ev.clock_in);
            return sum + (ms >= 600000 ? Math.round(ms / 3600000 * 100) / 100 : 0);
        }, 0);

        const panel  = container.querySelector(`.payroll-detail-panel[data-staff-id="${staffId}"]`);
        const dayRow = panel?.querySelector(`tr.payroll-day-row[data-date="${workDate}"]`);
        if (!dayRow) return;

        const eventsCell = dayRow.querySelector('.payroll-day-events');
        if (eventsCell) {
            const editBtn = eventsCell.querySelector('.payroll-edit-clk-btn');
            const clockPairsHtml = staffEvents.length
                ? staffEvents.map(ev => {
                    const tiVal = isoToHHMM(ev.clock_in);
                    const toVal = isoToHHMM(ev.clock_out);
                    const evRoomOpts = getSortedRooms().map(r =>
                        `<option value="${escHtml(r.id)}"${ev.room_id === r.id ? ' selected' : ''}>${escHtml(r.label)}</option>`
                    ).join('');
                    return `<div class="payroll-clk-pair" data-event-id="${escHtml(ev.id)}">` +
                        `<select class="payroll-room-select payroll-pair-room" data-event-id="${escHtml(ev.id)}" data-staff-id="${escHtml(staffId)}" data-work-date="${escHtml(workDate)}" data-prev-value="${escHtml(ev.room_id || '')}"><option value="">— Room</option>${evRoomOpts}</select>` +
                        `<span class="payroll-pair-clk-ref">${escHtml(fmtTime(ev.clock_in))} → ${escHtml(fmtTime(ev.clock_out))}</span>` +
                        `<input type="time" class="payroll-pair-time-in" data-event-id="${escHtml(ev.id)}" data-staff-id="${escHtml(staffId)}" data-work-date="${escHtml(workDate)}" value="${escHtml(tiVal)}">` +
                        `<span class="payroll-pair-sep">→</span>` +
                        `<input type="time" class="payroll-pair-time-out" data-event-id="${escHtml(ev.id)}" data-staff-id="${escHtml(staffId)}" data-work-date="${escHtml(workDate)}" value="${escHtml(toVal)}">` +
                        `<button class="payroll-clk-delete-btn btn-ghost" data-event-id="${escHtml(ev.id)}" data-staff-id="${escHtml(staffId)}" data-work-date="${escHtml(workDate)}" title="Delete clock event">×</button>` +
                        `</div>`;
                }).join('')
                : '';
            // Replace everything before the ✎ button
            [...eventsCell.children].forEach(el => { if (!el.classList.contains('payroll-edit-clk-btn')) el.remove(); });
            if (clockPairsHtml) {
                const tmp = document.createElement('div');
                tmp.innerHTML = clockPairsHtml;
                [...tmp.children].forEach(el => eventsCell.insertBefore(el, editBtn));
            }

            // Re-attach listeners for new elements
            eventsCell.querySelectorAll('.payroll-clk-delete-btn').forEach(btn => {
                btn.addEventListener('click', async e => {
                    e.stopPropagation();
                    const { eventId, staffId: sid, workDate: wd } = btn.dataset;
                    if (!confirm('Delete this clock event?')) return;
                    btn.disabled = true; btn.textContent = '…';
                    try {
                        await deleteClockEvent(eventId);
                        await _refreshPayrollDayRow(sid, wd);
                    } catch(err) {
                        alert('Failed to delete: ' + err.message);
                        btn.disabled = false; btn.textContent = '×';
                    }
                });
            });
            eventsCell.querySelectorAll('.payroll-pair-time-in, .payroll-pair-time-out').forEach(input => {
                input.addEventListener('change', () => {
                    _updatePayrollDayRowState(container, input.dataset.staffId, input.dataset.workDate);
                    _recalcPayrollStaff(container, input.dataset.staffId);
                });
                input.addEventListener('blur', () =>
                    _saveClockEventEdit(input.dataset.eventId, input.dataset.workDate, input.dataset.staffId, container)
                );
            });
            eventsCell.querySelectorAll('.payroll-room-select').forEach(sel => {
                sel.addEventListener('change', async () => {
                    if (typeof currentAdminRole !== 'undefined' && currentAdminRole !== 'full') {
                        alert('You do not have permission to update room assignments.');
                        sel.value = sel.dataset.prevValue ?? '';
                        return;
                    }
                    const prev = sel.dataset.prevValue ?? '';
                    sel.dataset.prevValue = sel.value;
                    const evId = sel.dataset.eventId;
                    if (evId) {
                        try { await updateClockEventRoom(evId, sel.value || null); }
                        catch(err) { alert('Failed to update room: ' + err.message); sel.value = prev; sel.dataset.prevValue = prev; return; }
                        _updatePayrollDayRowState(container, sel.dataset.staffId, sel.dataset.workDate);
                        _recalcPayrollStaff(container, sel.dataset.staffId);
                    } else {
                        _updatePayrollDayRowState(container, sel.dataset.staffId, sel.dataset.workDate);
                        _savePayrollTimeInline(sel.dataset.staffId, sel.dataset.workDate, container);
                    }
                });
            });
        }

        dayRow.dataset.clockedHrs = clockedHrs.toFixed(2);
        _updatePayrollDayRowState(container, staffId, workDate);
        _recalcPayrollStaff(container, staffId);
    } catch(e) { console.error('Failed to refresh daily row', e); }
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

// Pulls the same numbers a director already loaded on screen and lays them
// out as a paper record she can check off against — the thing to hand her
// instead of asking her to trust a small green checkmark that a save landed.
async function printPayrollSummary() {
    const sel = document.getElementById('payrollPeriod');
    if (!sel?.value) { alert('Please select a pay period first.'); return; }
    const [startVal, endVal] = sel.value.split('|');
    const periodLabel = sel.options[sel.selectedIndex].textContent;

    const { staff, periodMap, ytdMap, periodPtoMap } = await _buildPayrollData(startVal, endVal);
    if (!staff.length) { alert('No staff data to print.'); return; }

    let totPeriodPay = 0;
    const rowsHtml = staff.map(s => {
        const isSalary = s.pay_type === 'salary';
        const roomLabel = ROOMS.find(r => r.id === s.room_id)?.label || 'Float';
        const ptoUsed = (periodPtoMap.get(s.id) || {}).used || 0;
        let hrsStr, payStr;
        if (isSalary) {
            const sal = s.salary_biweekly || 0;
            totPeriodPay += sal;
            hrsStr = '—';
            payStr = `$${sal.toFixed(2)}`;
        } else {
            const pHrs = periodMap.get(s.id) || 0;
            const rate = s.hourly_rate || 0;
            totPeriodPay += pHrs * rate;
            hrsStr = `${pHrs.toFixed(2)}h`;
            payStr = `$${(pHrs * rate).toFixed(2)}`;
        }
        return `<tr>
            <td>${escHtml(s.name)}</td>
            <td>${escHtml(s.role || '')} · ${escHtml(roomLabel)}</td>
            <td class="num">${isSalary ? 'Salary' : `$${(s.hourly_rate || 0).toFixed(2)}/hr`}</td>
            <td class="num">${hrsStr}</td>
            <td class="num">${ptoUsed > 0 ? ptoUsed.toFixed(2) + 'h' : '—'}</td>
            <td class="num">${payStr}</td>
            <td class="ok-col"></td>
        </tr>`;
    }).join('');

    const win = window.open('', '_blank');
    if (!win) { alert('Please allow popups to print the payroll summary.'); return; }
    win.document.write(`<!doctype html><html><head><title>Payroll — ${escHtml(periodLabel)}</title>
        <style>
            body { font-family: -apple-system, Arial, sans-serif; padding: 24px; color: #1C3C52; }
            h1 { font-size: 18px; margin: 0 0 2px; }
            .sub { font-size: 12px; color: #6B7280; margin: 0 0 18px; }
            table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
            th, td { border: 1px solid #D8D2C6; padding: 6px 8px; text-align: left; }
            th { background: #DDD5C3; font-size: 10.5px; text-transform: uppercase; letter-spacing: .04em; }
            .num { text-align: right; font-variant-numeric: tabular-nums; }
            .ok-col { width: 70px; }
            tfoot td { font-weight: 700; background: #E4DCCB; }
            .sign { margin-top: 36px; display: flex; gap: 60px; }
            .sign div { flex: 1; border-top: 1px solid #1C3C52; padding-top: 4px; font-size: 11px; color: #6B7280; }
            @media print { body { padding: 0; } }
        </style></head><body>
        <h1>Payroll Summary — ${escHtml(periodLabel)}</h1>
        <p class="sub">Printed ${new Date().toLocaleString('en-US')} — check each row against the admin screen before approving.</p>
        <table>
            <thead><tr><th>Staff</th><th>Role / Room</th><th>Rate</th><th>Hours</th><th>PTO Used</th><th>Gross Pay</th><th>OK</th></tr></thead>
            <tbody>${rowsHtml}</tbody>
            <tfoot><tr><td colspan="5">Total Payroll</td><td class="num">$${totPeriodPay.toFixed(2)}</td><td></td></tr></tfoot>
        </table>
        <div class="sign">
            <div>Director signature</div>
            <div>Date approved</div>
        </div>
        </body></html>`);
    win.document.close();
    win.focus();
    win.print();
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
// Historical billing_summary rows take precedence over live calculations unless skipHistoricalOverride=true.
async function _buildArDataMap(fromDate, toDate, { skipHistoricalOverride = false } = {}) {
    const fromMo = fromDate.substring(0, 7);
    const toMo   = toDate.substring(0, 7);
    const map    = {};

    // Step 1: build from live registrations
    // Ensure family discount data and full registration history are loaded in parallel.
    // Always reload families with archived included so discount map is never stale.
    // Fetch registrations with no date filter — any sinceDate/untilDate restriction causes
    // PostgreSQL to exclude rows with NULL created_at, silently dropping revenue.
    let regsForReport = allRegistrations;
    await Promise.all([
        fetchAllFamilies({ includeArchived: true })
            .then(d => { allFamiliesData = d; _discountMap = null; })
            .catch(e => console.warn('Could not load families for discount map:', e)),
        fetchAllRegistrations()
            .then(d => { if (d) { regsForReport = d; allRegistrations = d; } })
            .catch(e => console.warn('Could not fetch full registration history; falling back to loaded data:', e)),
    ]);
    const dmap = getDiscountMap();

    // Fetch billing overrides for every month in the report range (parallel)
    const overridesByMonth = new Map(); // 'YYYY-MM' → Map(parentEmail:childName → overrideAmount)
    {
        const months = [];
        let [oy, om] = fromMo.split('-').map(Number);
        while (true) {
            const mo = `${oy}-${String(om).padStart(2, '0')}`;
            if (mo > toMo) break;
            months.push(mo);
            if (om === 12) { oy++; om = 1; } else { om++; }
        }
        await Promise.all(months.map(async mo => {
            try {
                const rows = await fetchBillingOverrides(mo);
                overridesByMonth.set(mo, new Map(rows.map(r => [
                    `${(r.parent_email || '').toLowerCase()}:${(r.child_name || '').toLowerCase()}`,
                    parseFloat(r.override_amount),
                ])));
            } catch (e) { console.warn(`fetchBillingOverrides(${mo}):`, e); }
        }));
    }

    // Group registrations by family — mirrors _buildFamilyBillingData exactly.
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
        // ── Sibling discount: same per-date logic as _buildFamilyBillingData ──
        // Build dateChildMap per month, then resolve a per-date siblingDiscMap.
        // Key: `childName:date` → discount amount (mirrors _buildFamilyBillingData exactly).
        const moDateChildMap = new Map(); // mo → Map(date → [{childName, effRate, hasIndividualDiscount}])
        regs.forEach(({ reg, room, disc, dates }) => {
            const hasIndividualDiscount = disc.type === 'staff' || (disc.type === 'custom' && disc.value > 0);
            dates.forEach(d => {
                const mo   = d.care_date.substring(0, 7);
                const base = d.day_type === 'half' ? (room.halfDayRate || 0) : (room.fullDayRate || 0);
                const eff  = effectiveAdminRate(base, disc.type, disc.value);
                if (!moDateChildMap.has(mo)) moDateChildMap.set(mo, new Map());
                const dateMap = moDateChildMap.get(mo);
                if (!dateMap.has(d.care_date)) dateMap.set(d.care_date, []);
                dateMap.get(d.care_date).push({ childName: reg.child_name, effRate: eff, hasIndividualDiscount });
            });
        });

        // Resolve per-date sibling discounts for each month — a family-level perk
        // that doesn't apply at all if anyone present that day already has their
        // own individual discount (mirrors _buildFamilyBillingData).
        const moSibDiscMap = new Map(); // mo → Map(`childName:date` → discount)
        for (const [mo, dateMap] of moDateChildMap) {
            const sibMap = new Map();
            for (const [date, children] of dateMap) {
                if (children.length < 2) continue;
                if (children.some(c => c.hasIndividualDiscount)) continue;
                const ranked  = [...children].sort((a, b) => b.effRate - a.effRate);
                const winners = ranked.slice(1);
                winners.forEach(c => {
                    const k = `${c.childName}:${date}`;
                    sibMap.set(k, (sibMap.get(k) || 0) + Math.min(10, c.effRate));
                });
            }
            moSibDiscMap.set(mo, sibMap);
        }

        // Aggregate billing per registration per month, applying per-date sibling discounts
        // then billing overrides — identical calculation path to _buildFamilyBillingData.
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
                const sibMap = moSibDiscMap.get(mo) || new Map();
                let calcSubtotal = 0, baseTotal = 0, changeFees = 0;
                // Apply sibling discount per date (same as _buildFamilyBillingData)
                moDates.forEach(d => {
                    const base     = d.day_type === 'half' ? (room.halfDayRate || 0) : (room.fullDayRate || 0);
                    const effRate  = effectiveAdminRate(base, disc.type, disc.value);
                    const sib      = sibMap.get(`${reg.child_name}:${d.care_date}`) || 0;
                    calcSubtotal  += Math.max(0, effRate - sib);
                    baseTotal     += base;
                    changeFees    += Number(d.change_fee) || 0;
                });

                const overridesMap = overridesByMonth.get(mo);
                const baseCharge   = overridesMap?.has(overrideKey) ? overridesMap.get(overrideKey) : calcSubtotal;
                const billedAmount = baseCharge + changeFees;

                if (!map[mo]) map[mo] = {};
                if (!map[mo][reg.room_id]) map[mo][reg.room_id] = { attendees: 0, netBilled: 0, liveDisc: 0 };
                map[mo][reg.room_id].attendees += moDates.length;
                map[mo][reg.room_id].netBilled += billedAmount;
                map[mo][reg.room_id].liveDisc  += Math.max(0, baseTotal - baseCharge);
            }
        });
    }

    // Step 2: historical billing_summary overwrites live per room+month (unless caller opts out).
    // Only applied for months strictly before the current month so stale rows never override
    // live calculations for the current or future months.
    if (!skipHistoricalOverride) {
        const currentMo = new Date().toISOString().substring(0, 7);
        let historical = [];
        try { historical = await fetchBillingSummary(); } catch (e) { console.warn('billing_summary unavailable:', e); }
        historical.forEach(row => {
            const mo = (row.month || '').substring(0, 7);
            if (mo < fromMo || mo > toMo) return;
            if (mo >= currentMo) return; // never override live data for current/future months
            if (!map[mo]) map[mo] = {};
            map[mo][row.room_id] = {
                attendees: (row.half_days || 0) + (row.full_days || 0),
                netBilled: parseFloat(row.net_billed) || 0,
                histDisc:  parseFloat(row.discount)   || 0,
                liveDisc:  0,
            };
        });
    }

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

        const rooms = roomFilter ? ROOMS.filter(r => r.id === roomFilter) : getSortedRooms();
        const showTotalCol = rooms.length > 1;

        // Accumulate totals per room
        const roomTotals = {};
        rooms.forEach(r => { roomTotals[r.id] = { attendees: 0, netBilled: 0 }; });
        let grandAttendees = 0, grandRevenue = 0, grandDiscounts = 0;

        const fmtRev = v => v > 0 ? `$${Math.round(v).toLocaleString('en-US')}` : '—';

        const rowsHtml = months.map(mo => {
            const [y, m] = mo.split('-').map(Number);
            const label  = MONTH_NAMES[m - 1] + ' ' + y;
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
    const label   = MONTH_NAMES[m - 1] + ' ' + y;
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

    const rooms = roomFilter ? ROOMS.filter(r => r.id === roomFilter) : getSortedRooms();

    const rows = months.map(mo => {
        const [y, m] = mo.split('-').map(Number);
        const row    = { Month: MONTH_NAMES[m - 1] + ' ' + y };
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
// UPCOMING ROOM PROMOTIONS (AGING-OUT) REPORT
// ============================================================
async function generatePromotionsReport() {
    const container = document.getElementById('promotionsContent');
    if (!container) return;
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    document.getElementById('exportPromotionsBtn').style.display = 'none';
    document.getElementById('printPromotionsBtn').style.display = 'none';
    try {
        // Age ceilings (months) per room and where each room transitions to —
        // derived LIVE from the room age ranges (admin-editable via Settings →
        // Rates), never hardcoded. A room graduates into the next AGE BRACKET
        // (first room starting at/after its age-out), so co-equal rooms sharing
        // a window (e.g. Turtle & Owl both 24–36mo) both age up past each other
        // into the older bracket rather than sideways into a twin. Mirrors
        // wlpPromotionChain() in the Capacity Planner so the two never disagree.
        const _orderedRooms  = getSortedRooms().filter(r => r.id !== 'summer' && r.ageMinMonths != null);
        const ROOM_CEILINGS  = {};
        const ROOM_NEXT      = {};
        _orderedRooms.forEach(room => {
            ROOM_CEILINGS[room.id] = room.ageMaxMonths;
            const nx = room.ageMaxMonths == null ? null : _orderedRooms.find(r => r.ageMinMonths >= room.ageMaxMonths);
            ROOM_NEXT[room.id] = nx ? nx.id : null;
        });
        const ROOM_LABEL     = Object.fromEntries(ROOMS.map(r => [r.id, r.label]));

        const allRegs = await fetchAllRegistrations();

        // Build day-pattern from actual registration_dates history.
        // For each child, track which months they attended and how often each weekday appears.
        // A day is "typical" if it shows up in ≥50% of the months they've been enrolled.
        const DAY_ABBR = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        const childDayInfo = {};
        allRegs.filter(r => r.status === 'confirmed').forEach(reg => {
            if (!reg.child_dob) return;
            const key = `${(reg.child_name || '').toLowerCase()}|${reg.child_dob}`;
            if (!childDayInfo[key]) childDayInfo[key] = { months: new Set(), dayCounts: {} };
            (reg.registration_dates || []).forEach(d => {
                if (!d.care_date) return;
                const dt  = new Date(d.care_date + 'T12:00:00');
                const mo  = d.care_date.slice(0, 7);
                const dow = dt.getDay();
                childDayInfo[key].months.add(mo);
                childDayInfo[key].dayCounts[dow] = (childDayInfo[key].dayCounts[dow] || 0) + 1;
            });
        });

        function typicalDays(key) {
            const info = childDayInfo[key];
            if (!info || !info.months.size) return [];
            const threshold = Math.max(1, Math.ceil(info.months.size * 0.5));
            return [1, 2, 3, 4, 5].filter(d => (info.dayCounts[d] || 0) >= threshold).map(d => DAY_ABBR[d]);
        }

        // Most-recent confirmed room per unique child (keyed by name|dob)
        const childRoom = {};
        allRegs.filter(r => r.status === 'confirmed').forEach(reg => {
            if (!reg.child_dob || !reg.room_id) return;
            const key        = `${(reg.child_name || '').toLowerCase()}|${reg.child_dob}`;
            const latestDate = (reg.registration_dates || []).map(d => d.care_date).sort().pop() || '';
            if (!childRoom[key] || latestDate > childRoom[key].latestDate) {
                childRoom[key] = { child_name: reg.child_name, child_dob: reg.child_dob, room_id: reg.room_id, latestDate };
            }
        });

        const today   = new Date();
        const horizon = new Date(today.getFullYear(), today.getMonth() + 13, 1);

        const promotions = [];
        Object.entries(childRoom).forEach(([key, info]) => {
            const { child_name, child_dob, room_id } = info;
            if (!ROOM_CEILINGS[room_id]) return;
            const dob     = new Date(child_dob);
            const dayList = typicalDays(key);
            // Walk the full room chain from the child's current room forward
            let room = room_id;
            while (ROOM_CEILINGS[room] && ROOM_NEXT[room]) {
                const promoteDate = new Date(dob.getFullYear(), dob.getMonth() + ROOM_CEILINGS[room], 1);
                if (promoteDate > today && promoteDate <= horizon) {
                    const moKey = `${promoteDate.getFullYear()}-${String(promoteDate.getMonth() + 1).padStart(2, '0')}`;
                    promotions.push({ child_name, dob, promoteDate, moKey, fromRoom: room, toRoom: ROOM_NEXT[room], dayList });
                }
                room = ROOM_NEXT[room];
            }
        });

        promotions.sort((a, b) => a.promoteDate - b.promoteDate);

        if (!promotions.length) {
            container.innerHTML = '<p class="empty-hint">No upcoming promotions in the next 13 months based on current enrollment.</p>';
            return;
        }

        _promotionsData = promotions;
        _promotionsSort = { col: 'month', dir: 1 };

        const MONTH_NAME = ['January','February','March','April','May','June','July','August','September','October','November','December'];

        let html = `
            <p style="font-size:.85em;color:#6b7280;margin-bottom:1rem">
                Dates are when each child reaches the age ceiling for their current room.
                "Typical Days" shows weekdays the child attended in at least half their enrolled months. "varies" means no consistent pattern.
                <br><em>Click any column header to sort.</em>
            </p>` + _promotionsMainTableHtml();

        // ---- Subsection: Days opening up (by source room) ----
        // Group promotions by fromRoom, then by month
        const byFromRoom = {};
        promotions.forEach(p => {
            if (!byFromRoom[p.fromRoom]) byFromRoom[p.fromRoom] = {};
            const mk = p.moKey;
            (byFromRoom[p.fromRoom][mk] = byFromRoom[p.fromRoom][mk] || []).push(p);
        });

        html += `<h4 style="margin:2rem 0 .5rem;font-size:1rem">Days Opening Up (by Room)</h4>
            <p style="font-size:.85em;color:#6b7280;margin-bottom:1rem">Spots that will become available when a child ages out of each room.</p>`;

        const _roomAgeOrder = getSortedRooms().map(r => r.id);
        Object.keys(byFromRoom).sort((a, b) => _roomAgeOrder.indexOf(a) - _roomAgeOrder.indexOf(b)).forEach(room => {
            html += `<div style="margin-bottom:1.25rem">
                <div style="font-weight:600;margin-bottom:.35rem">${escHtml(ROOM_LABEL[room] || room)}</div>
                <div style="overflow-x:auto"><table class="report-table"><thead><tr>
                    <th>Month</th><th>Child</th><th>Typical Days</th>
                </tr></thead><tbody>`;
            Object.keys(byFromRoom[room]).sort().forEach(mk => {
                const kids = byFromRoom[room][mk];
                const [y, m] = mk.split('-').map(Number);
                kids.forEach((p, i) => {
                    html += `<tr>
                        ${i === 0 ? `<td rowspan="${kids.length}" style="font-weight:600;vertical-align:top">${escHtml(MONTH_NAME[m - 1] + ' ' + y)}</td>` : ''}
                        <td>${escHtml(p.child_name)}</td>
                        <td style="color:#6b7280">${p.dayList.length ? escHtml(p.dayList.join(', ')) : '<span style="color:#d1d5db">varies</span>'}</td>
                    </tr>`;
                });
            });
            html += `</tbody></table></div></div>`;
        });

        // ---- Subsection: Rooms gaining children (by destination room) ----
        const byToRoom = {};
        promotions.forEach(p => {
            if (!p.toRoom) return;
            if (!byToRoom[p.toRoom]) byToRoom[p.toRoom] = {};
            const mk = p.moKey;
            (byToRoom[p.toRoom][mk] = byToRoom[p.toRoom][mk] || []).push(p);
        });

        html += `<h4 style="margin:2rem 0 .5rem;font-size:1rem">Rooms Gaining Children (by Room)</h4>
            <p style="font-size:.85em;color:#6b7280;margin-bottom:1rem">Rooms that will need to accommodate an incoming child.</p>`;

        Object.keys(byToRoom).sort((a, b) => _roomAgeOrder.indexOf(a) - _roomAgeOrder.indexOf(b)).forEach(room => {
            html += `<div style="margin-bottom:1.25rem">
                <div style="font-weight:600;margin-bottom:.35rem">${escHtml(ROOM_LABEL[room] || room)}</div>
                <div style="overflow-x:auto"><table class="report-table"><thead><tr>
                    <th>Month</th><th>Child</th><th>Typical Days</th>
                </tr></thead><tbody>`;
            Object.keys(byToRoom[room]).sort().forEach(mk => {
                const kids = byToRoom[room][mk];
                const [y, m] = mk.split('-').map(Number);
                kids.forEach((p, i) => {
                    html += `<tr>
                        ${i === 0 ? `<td rowspan="${kids.length}" style="font-weight:600;vertical-align:top">${escHtml(MONTH_NAME[m - 1] + ' ' + y)}</td>` : ''}
                        <td>${escHtml(p.child_name)}</td>
                        <td style="color:#6b7280">${p.dayList.length ? escHtml(p.dayList.join(', ')) : '<span style="color:#d1d5db">varies</span>'}</td>
                    </tr>`;
                });
            });
            html += `</tbody></table></div></div>`;
        });

        container.innerHTML = html;
        _attachPromotionsSort();
        _promotionsData = promotions;
        document.getElementById('exportPromotionsBtn').style.display = '';
        document.getElementById('printPromotionsBtn').style.display = '';
    } catch (err) {
        container.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    }
}

let _promotionsData = [];
let _promotionsSort = { col: 'month', dir: 1 };

const _PROMO_MONTHS = ['January','February','March','April','May','June','July','August','September','October','November','December'];
const _PROMO_COLS = [['month','Month'],['child','Child'],['dob','Birthday'],['from','From Room'],['to','To Room'],['days','Typical Days']];

function _promoRoomLabel(id) {
    const r = ROOMS.find(x => x.id === id);
    return r ? r.label : (id || '—');
}

function _promoSortVal(p, col) {
    switch (col) {
        case 'child': return (p.child_name || '').toLowerCase();
        case 'dob':   return p.dob.getTime();
        case 'from':  return _promoRoomLabel(p.fromRoom).toLowerCase();
        case 'to':    return _promoRoomLabel(p.toRoom).toLowerCase();
        case 'days':  return p.dayList.length;
        case 'month':
        default:      return p.promoteDate.getTime();
    }
}

function _sortedPromotions() {
    const { col, dir } = _promotionsSort;
    return _promotionsData.slice().sort((a, b) => {
        const av = _promoSortVal(a, col), bv = _promoSortVal(b, col);
        if (av < bv) return -dir;
        if (av > bv) return dir;
        if (a.promoteDate - b.promoteDate) return a.promoteDate - b.promoteDate; // stable tiebreak
        return (a.child_name || '').localeCompare(b.child_name || '');
    });
}

function _promotionsHeadHtml() {
    return '<tr>' + _PROMO_COLS.map(([key, label]) => {
        const active = _promotionsSort.col === key;
        const arrow = active ? (_promotionsSort.dir === 1 ? ' ▲' : ' ▼') : '';
        return `<th class="promo-sort-th${active ? ' promo-sort-active' : ''}" data-promo-sort="${key}" style="cursor:pointer;user-select:none;white-space:nowrap">${escHtml(label)}${arrow}</th>`;
    }).join('') + '</tr>';
}

function _promotionRowHtml(p) {
    const [y, m] = p.moKey.split('-').map(Number);
    const dobStr = `${_PROMO_MONTHS[p.dob.getMonth()].slice(0, 3)} ${p.dob.getDate()}, ${p.dob.getFullYear()}`;
    return `<tr>
        <td style="font-weight:600;white-space:nowrap">${escHtml(_PROMO_MONTHS[m - 1] + ' ' + y)}</td>
        <td>${escHtml(p.child_name)}</td>
        <td style="color:#6b7280;white-space:nowrap">${dobStr}</td>
        <td>${escHtml(_promoRoomLabel(p.fromRoom))}</td>
        <td style="color:#16a34a">${escHtml(_promoRoomLabel(p.toRoom))}</td>
        <td style="color:#6b7280">${p.dayList.length ? escHtml(p.dayList.join(', ')) : '<span style="color:#d1d5db">varies</span>'}</td>
    </tr>`;
}

function _promotionsMainTableHtml() {
    return `<div style="overflow-x:auto"><table class="report-table" id="promotionsMainTable">
        <thead id="promotionsMainHead">${_promotionsHeadHtml()}</thead>
        <tbody id="promotionsMainTbody">${_sortedPromotions().map(_promotionRowHtml).join('')}</tbody>
    </table></div>`;
}

// Delegated on the (stable) table element, so re-rendering the head/tbody
// innerHTML on each sort doesn't drop the listener.
function _attachPromotionsSort() {
    const table = document.getElementById('promotionsMainTable');
    if (!table) return;
    table.addEventListener('click', e => {
        const th = e.target.closest('[data-promo-sort]');
        if (!th) return;
        const col = th.dataset.promoSort;
        if (_promotionsSort.col === col) _promotionsSort.dir *= -1;
        else _promotionsSort = { col, dir: col === 'days' ? -1 : 1 }; // Typical Days defaults to most-first
        const head = document.getElementById('promotionsMainHead');
        const body = document.getElementById('promotionsMainTbody');
        if (head) head.innerHTML = _promotionsHeadHtml();
        if (body) body.innerHTML = _sortedPromotions().map(_promotionRowHtml).join('');
    });
}

function exportPromotionsReport() {
    if (!_promotionsData.length) return;
    const ROOM_LABEL = Object.fromEntries(ROOMS.map(r => [r.id, r.label]));
    const headers = ['Month', 'Child', 'Birthday', 'From Room', 'To Room', 'Typical Days'];
    const rows = _promotionsData.map(p => {
        const dob = p.dob;
        const dobStr = `${dob.getFullYear()}-${String(dob.getMonth()+1).padStart(2,'0')}-${String(dob.getDate()).padStart(2,'0')}`;
        const [y, m] = p.moKey.split('-').map(Number);
        const MONTH_NAME = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        return [
            MONTH_NAME[m - 1] + ' ' + y,
            p.child_name,
            dobStr,
            ROOM_LABEL[p.fromRoom] || p.fromRoom,
            ROOM_LABEL[p.toRoom]   || p.toRoom || '',
            p.dayList.length ? p.dayList.join(', ') : 'varies',
        ];
    });
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Room Promotions');
    XLSX.writeFile(wb, 'room-promotions.xlsx');
}

function printPromotionsReport() {
    const content = document.getElementById('promotionsContent');
    if (!content || !_promotionsData.length) return;
    const win = window.open('', '_blank');
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Upcoming Room Promotions</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 12px; color: #000; margin: 24px; }
  h1 { font-size: 16px; margin: 0 0 4px; }
  p.subtitle { font-size: 10px; color: #666; margin: 0 0 16px; }
  h4 { font-size: 13px; margin: 20px 0 4px; }
  table { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
  th { background: #1e3a5f; color: #fff; padding: 5px 8px; text-align: left; font-size: 11px; }
  td { padding: 4px 8px; font-size: 11px; border-bottom: 1px solid #e8e8e8; vertical-align: top; }
  @media print { body { margin: 12px; } }
</style></head><body>
<h1>Upcoming Room Promotions</h1>
<p class="subtitle">Printed ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</p>
${content.innerHTML}
</body></html>`);
    win.document.close();
    win.focus();
    win.print();
}

// ============================================================
// TOTAL ENROLLMENT & FTE REPORT
// ============================================================
async function generateEnrollmentFteReport() {
    const container = document.getElementById('enrollmentFteContent');
    if (!container) return;
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const allRegs = await fetchAllRegistrations();
        const confirmed = allRegs.filter(r => r.status === 'confirmed');

        // For each registration: determine its month and whether FD or HD (majority of care dates)
        const MONTH_NAME  = ['January','February','March','April','May','June','July','August','September','October','November','December'];
        const activeRooms = getSortedRooms().filter(r => r.status !== 'coming_soon');
        const ROOM_LABEL  = Object.fromEntries(ROOMS.map(r => [r.id, r.label]));

        const byMonth = {}; // 'YYYY-MM' → [{ room_id, type: 'full'|'half' }, ...]
        confirmed.forEach(reg => {
            const dates = (reg.registration_dates || []).filter(d => !d.waitlisted);
            if (!dates.length) return;
            const moKey   = dates.map(d => d.care_date.slice(0, 7)).sort()[0];
            const fullCt  = dates.filter(d => d.day_type === 'full').length;
            const halfCt  = dates.filter(d => d.day_type === 'half').length;
            const type    = fullCt >= halfCt ? 'full' : 'half';
            (byMonth[moKey] = byMonth[moKey] || []).push({ room_id: reg.room_id, type });
        });

        const months = Object.keys(byMonth).sort().reverse().slice(0, 18);
        if (!months.length) {
            container.innerHTML = '<p class="empty-hint">No confirmed enrollment data found.</p>';
            return;
        }

        // Current-month snapshot KPI row
        const today     = new Date();
        const curMo     = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}`;
        const curEntries = byMonth[curMo] || byMonth[months[0]] || [];
        const curFull   = curEntries.filter(e => e.type === 'full').length;
        const curHalf   = curEntries.filter(e => e.type === 'half').length;
        const curFte    = curFull + curHalf * 0.5;
        const curMoLabel = (() => { const [y, m] = (byMonth[curMo] ? curMo : months[0]).split('-').map(Number); return `${MONTH_NAME[m - 1]} ${y}`; })();

        // Build column headers from active rooms that actually appear in data
        const roomsWithData = activeRooms.filter(r => months.some(mo => (byMonth[mo] || []).some(e => e.room_id === r.id)));

        let html = `
            <div class="fin-kpi-row" style="margin-bottom:1.25rem">
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Enrolled (${curMoLabel})</span>
                    <span class="fin-kpi-value fin-positive">${curFull + curHalf}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Full-day children</span>
                    <span class="fin-kpi-value">${curFull}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Half-day children</span>
                    <span class="fin-kpi-value">${curHalf}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">FTE Enrollment</span>
                    <span class="fin-kpi-value">${curFte % 1 === 0 ? curFte : curFte.toFixed(1)}</span>
                </div>
            </div>
            <div style="overflow-x:auto">
            <table class="report-table">
                <thead>
                    <tr>
                        <th rowspan="2">Month</th>
                        ${roomsWithData.map(r => `<th colspan="3" class="ar-room-header">${r.label}</th>`).join('')}
                        <th colspan="4" class="ar-room-header ar-total-col">Total</th>
                    </tr>
                    <tr>
                        ${roomsWithData.map(() =>
                            `<th class="report-num ar-sub-header">FD</th>` +
                            `<th class="report-num ar-sub-header">HD</th>` +
                            `<th class="report-num ar-sub-header">FTE</th>`
                        ).join('')}
                        <th class="report-num ar-sub-header ar-total-col">FD</th>
                        <th class="report-num ar-sub-header ar-total-col">HD</th>
                        <th class="report-num ar-sub-header ar-total-col">Children</th>
                        <th class="report-num ar-sub-header ar-total-col">FTE</th>
                    </tr>
                </thead>
                <tbody>`;

        months.forEach(mo => {
            const entries  = byMonth[mo] || [];
            const [y, m]   = mo.split('-').map(Number);
            const moLabel  = `${MONTH_NAME[m - 1]} ${y}`;
            const totFull  = entries.filter(e => e.type === 'full').length;
            const totHalf  = entries.filter(e => e.type === 'half').length;
            const totFte   = totFull + totHalf * 0.5;

            const roomCells = roomsWithData.map(r => {
                const roomEntries = entries.filter(e => e.room_id === r.id);
                const fd  = roomEntries.filter(e => e.type === 'full').length;
                const hd  = roomEntries.filter(e => e.type === 'half').length;
                const fte = fd + hd * 0.5;
                return (fd || hd)
                    ? `<td class="report-num">${fd || '—'}</td><td class="report-num">${hd || '—'}</td><td class="report-num" style="color:#6b7280">${fte % 1 === 0 ? fte : fte.toFixed(1)}</td>`
                    : `<td class="report-num" style="color:#d1d5db">—</td><td class="report-num" style="color:#d1d5db">—</td><td class="report-num" style="color:#d1d5db">—</td>`;
            }).join('');

            html += `<tr${mo === curMo ? ' style="font-weight:600"' : ''}>
                <td>${escHtml(moLabel)}${mo === curMo ? ' <span style="font-size:.75em;color:#6b7280">(current)</span>' : ''}</td>
                ${roomCells}
                <td class="report-num ar-total-col">${totFull || '—'}</td>
                <td class="report-num ar-total-col">${totHalf || '—'}</td>
                <td class="report-num ar-total-col"><strong>${totFull + totHalf}</strong></td>
                <td class="report-num ar-total-col"><strong>${totFte % 1 === 0 ? totFte : totFte.toFixed(1)}</strong></td>
            </tr>`;
        });

        html += `</tbody></table></div>
            <p style="font-size:.8em;color:#6b7280;margin:.5rem 0 0">
                FTE = full-day children × 1.0 + half-day children × 0.5.
                Children classified by majority of their care dates for the month. Shows last 18 months.
            </p>`;
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    }
}

// ============================================================
// SEAT-DAY CAPACITY MODEL
// ============================================================
// Seat capacity is always DERIVED from the per-room capacities configured in
// Settings → Rates & Settings (the `room_capacity` setting, merged into ROOMS
// by loadCapacitySettings() at admin load). Nothing here is hardcoded: adding a
// room, or raising a room's capacity, lifts the center-wide ceiling
// automatically. See the totalCapacity calculation in
// generateSeatDayCapacityReport() for how the center-wide figure is summed.
//
// Recommended operating band for average occupied seats/weekday, held as a
// fraction of whatever capacity applies to the current scope. The ratios below
// preserve the intent of the original fixed 34–40 band, which was calibrated
// against a 46-child center — keeping them as ratios means the absolute band
// tracks real capacity instead of drifting out of date as rooms change.
const SEAT_BAND_MIN_RATIO = 34 / 46;   // ≈ 74% of capacity
const SEAT_BAND_MAX_RATIO = 40 / 46;   // ≈ 87% of capacity

// Operating band for a given seat capacity. The same proportional rule applies
// whether `capacity` is the center-wide total or a single room's own seats.
function _seatBandFor(capacity) {
    const cap = capacity || 0;
    return {
        min: Math.round(cap * SEAT_BAND_MIN_RATIO * 10) / 10,
        max: Math.round(cap * SEAT_BAND_MAX_RATIO * 10) / 10,
    };
}

let _reportCharts = {};
function _destroyReportChart(key) {
    if (_reportCharts[key]) { _reportCharts[key].destroy(); delete _reportCharts[key]; }
}

function _weekdaysInMonth(year, month /* 1-12 */) {
    const daysInMonth = new Date(year, month, 0).getDate();
    let count = 0;
    for (let d = 1; d <= daysInMonth; d++) {
        const dow = new Date(year, month - 1, d).getDay();
        if (dow !== 0 && dow !== 6) count++;
    }
    return count;
}

function initSeatDayRoomSelector() {
    const sel = document.getElementById('seatDayRoomSel');
    if (!sel || sel.options.length > 1) return;
    getSortedRooms().forEach(r => {
        const opt = document.createElement('option');
        opt.value = r.id;
        opt.textContent = r.label;
        sel.appendChild(opt);
    });
}

async function generateSeatDayCapacityReport() {
    initSeatDayRoomSelector();
    const container = document.getElementById('seatDayCapacityContent');
    if (!container) return;
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const roomId = document.getElementById('seatDayRoomSel')?.value || 'all';
        const room   = roomId === 'all' ? null : ROOMS.find(r => r.id === roomId);
        const scopeLabel = roomId === 'all' ? 'Full Center (excl. Summer Camp)' : room?.label || roomId;

        const allRegs  = await fetchAllRegistrations();
        const confirmed = allRegs.filter(r => r.status === 'confirmed');
        const MONTH_NAME = ['January','February','March','April','May','June','July','August','September','October','November','December'];

        // byMonth: 'YYYY-MM' → [{ childDays }] — one entry per child registered that month.
        // Full Center excludes Summer Camp (separate seasonal program, different
        // ages, different capacity question); a specific room shows that room only.
        const byMonth = {};
        confirmed.forEach(reg => {
            if (roomId === 'all' ? reg.room_id === 'summer' : reg.room_id !== roomId) return;
            const dates = (reg.registration_dates || []).filter(d => !d.waitlisted);
            if (!dates.length) return;
            const moKey = dates.map(d => d.care_date.slice(0, 7)).sort()[0];
            (byMonth[moKey] = byMonth[moKey] || []).push({ childDays: dates.length, room_id: reg.room_id });
        });

        const months = Object.keys(byMonth).sort().reverse().slice(0, 18).reverse();
        if (!months.length) {
            container.innerHTML = `<p class="empty-hint">No confirmed enrollment data found for ${escHtml(scopeLabel)}.</p>`;
            return;
        }

        const stats = months.map(mo => {
            const [y, m]        = mo.split('-').map(Number);
            const entries       = byMonth[mo] || [];
            const totalChildDays = entries.reduce((s, e) => s + e.childDays, 0);
            const distinctChildren = entries.length;
            const weekdays       = _weekdaysInMonth(y, m);
            const weeksInMonth   = weekdays / 5;
            const avgSeatsPerDay = weekdays ? totalChildDays / weekdays : 0;
            // Booked days/child converted to a per-week figure (weekdays ÷ 5 = weeks in
            // the month) so it lines up with the "× 5 weekdays" in the formula below —
            // mixing a monthly days/child total into that formula overstates the divisor
            // and understates max active children.
            const avgDaysPerChildPerWeek = (distinctChildren && weeksInMonth)
                ? (totalChildDays / distinctChildren) / weeksInMonth
                : 0;
            return { mo, label: `${MONTH_NAME[m - 1]} ${y}`, avgSeatsPerDay, avgDaysPerChildPerWeek, distinctChildren };
        });

        const cur = stats[stats.length - 1];

        // Total seat capacity. Full Center: every room actually holding a confirmed
        // child this month (regardless of its static status flag — a room can be
        // occupied before its config catches up) union'd with any room currently
        // marked 'active', so a fully-empty active room still counts. A specific
        // room: just that room's own capacity.
        let totalCapacity;
        if (roomId === 'all') {
            const roomsInUseThisMonth = new Set((byMonth[cur.mo] || []).map(e => e.room_id));
            const activeRoomIds = new Set(getSortedRooms().filter(r => r.status === 'active').map(r => r.id));
            const capacityRoomIds = new Set([...activeRoomIds, ...roomsInUseThisMonth]);
            totalCapacity = getSortedRooms()
                .filter(r => capacityRoomIds.has(r.id))
                .reduce((s, r) => s + (r.capacity || 0), 0);
        } else {
            totalCapacity = room?.capacity || 0;
        }

        const isFullCenter = roomId === 'all';
        const band = _seatBandFor(totalCapacity);
        // No scope can hold more children than it has seats — for Full Center that
        // is the summed room capacities, for a single room its own capacity.
        const scenarioCap = totalCapacity || Infinity;
        const scenario = seats => cur.avgDaysPerChildPerWeek
            ? Math.min(scenarioCap, Math.round(seats * 5 / cur.avgDaysPerChildPerWeek))
            : null;

        container.innerHTML = `
            <p style="font-weight:600;color:#374151;margin:0 0 10px">${escHtml(scopeLabel)}</p>
            <div class="fin-kpi-row" style="margin-bottom:1.25rem">
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Avg occupied seats/day (${cur.label})</span>
                    <span class="fin-kpi-value fin-positive">${cur.avgSeatsPerDay.toFixed(1)}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Avg booked days/child (per week)</span>
                    <span class="fin-kpi-value">${cur.avgDaysPerChildPerWeek.toFixed(2)}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Enrolled children</span>
                    <span class="fin-kpi-value">${cur.distinctChildren}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Total seat capacity</span>
                    <span class="fin-kpi-value">${totalCapacity || '—'}</span>
                </div>
            </div>
            <div class="fin-chart-wrap" style="margin-bottom:1.25rem">
                <h4 class="fin-chart-title">Average Occupied Seats/Day vs. Operating Band — ${escHtml(scopeLabel)}</h4>
                <canvas id="chartSeatDayCapacity"></canvas>
            </div>
            <div style="overflow-x:auto">
            <table class="report-table">
                <thead><tr>
                    <th>Scenario</th>
                    <th class="report-num">Avg occupied seats/day</th>
                    <th class="report-num">Max active children</th>
                </tr></thead>
                <tbody>
                    <tr>
                        <td>Min recommended (band floor)</td>
                        <td class="report-num">${band.min}</td>
                        <td class="report-num"><strong>${scenario(band.min) ?? '—'}</strong></td>
                    </tr>
                    <tr>
                        <td>Max recommended (band ceiling)</td>
                        <td class="report-num">${band.max}</td>
                        <td class="report-num"><strong>${scenario(band.max) ?? '—'}</strong></td>
                    </tr>
                    <tr>
                        <td>Full physical capacity (all seats filled)</td>
                        <td class="report-num">${totalCapacity || '—'}</td>
                        <td class="report-num"><strong>${totalCapacity ? (scenario(totalCapacity) ?? '—') : '—'}</strong></td>
                    </tr>
                </tbody>
            </table>
            </div>
            <p style="font-size:.8em;color:#6b7280;margin:.5rem 0 0">
                Avg occupied seats/day = confirmed child-days &divide; weekdays in month.
                Avg booked days/child (per week) = confirmed child-days &divide; distinct children &divide; weeks in the month
                (currently ${cur.avgDaysPerChildPerWeek.toFixed(2)}). Max active children = seats/day &times; 5 &divide; avg booked days/child per week,
                capped at ${isFullCenter ? `the ${totalCapacity || '—'}-seat center-wide capacity` : `this room's ${totalCapacity || '—'}-seat capacity`}.
                The operating band is ${(SEAT_BAND_MIN_RATIO * 100).toFixed(0)}&ndash;${(SEAT_BAND_MAX_RATIO * 100).toFixed(0)}% of ${isFullCenter ? 'total' : `this room's`} seat capacity (${band.min}&ndash;${band.max} seats).
                ${isFullCenter
                    ? `Capacity is summed from the per-room capacities set in Settings &rarr; Rates &amp; Settings, so it rises automatically when a room is added or resized. Summer Camp is excluded (separate seasonal program, different age range).`
                    : ``}
                Shows last ${months.length} months. This is a planning display only — it does not affect what enrollment allows.
            </p>`;

        _destroyReportChart('seatDayCapacity');
        const canvas = document.getElementById('chartSeatDayCapacity');
        _reportCharts.seatDayCapacity = new Chart(canvas.getContext('2d'), {
            type: 'line',
            data: {
                labels: stats.map(s => s.label),
                datasets: [
                    {
                        label: 'Avg occupied seats/day',
                        data: stats.map(s => Math.round(s.avgSeatsPerDay * 10) / 10),
                        borderColor: 'rgb(99,102,241)', backgroundColor: 'rgba(99,102,241,.12)',
                        tension: 0.3, fill: true, pointBackgroundColor: 'rgb(99,102,241)',
                    },
                    {
                        label: `Max recommended (${band.max})`,
                        data: stats.map(() => band.max),
                        borderColor: 'rgba(22,163,74,.6)', borderDash: [6, 3], pointRadius: 0, fill: false,
                    },
                    {
                        label: `Min recommended (${band.min})`,
                        data: stats.map(() => band.min),
                        borderColor: 'rgba(245,158,11,.6)', borderDash: [6, 3], pointRadius: 0, fill: false,
                    },
                    ...(totalCapacity ? [{
                        label: `Total seat capacity (${totalCapacity})`,
                        data: stats.map(() => totalCapacity),
                        borderColor: 'rgba(239,68,68,.6)', borderDash: [3, 3], pointRadius: 0, fill: false,
                    }] : []),
                ],
            },
            options: {
                responsive: true,
                plugins: { legend: { position: 'top' } },
                scales: { y: { beginAtZero: true } },
            },
        });
    } catch (err) {
        container.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    }
}

// ============================================================
// RATIO-STEP / NEXT-CHILD CALCULATOR
// ============================================================
// Staffing is a step function, not a slope. A room needs
// ceil(children ÷ ratio) teachers, so the one child who crosses a ratio
// boundary carries the whole cost of an extra teacher for that day — and can
// be worth less than nothing on their own. This report shows, per room per
// day, how much headroom is left before that step and what the next booking
// is actually worth once the step is priced in.
//
// The day is modelled as two shifts. The morning holds every child booked
// that day; the afternoon holds only the full-day children, because a
// half-day booking is a morning session. That is the same AM/PM rule the
// Schedule Planner uses for amNeed/pmNeed in renderScheduleTables(), so the
// two reports agree on what a day requires.
//
// Splitting the day this way is what makes the half-day question answerable:
// a half-day child only has to fit the morning, so they can be free to take
// when a full-day child in the same seat would cost an afternoon teacher —
// or the reverse, when the morning is the tight shift.

// Shift lengths come from SHIFT_HRS, the same model the Schedule Planner and
// Room P&L already use, so labor costs agree across reports.

let _ratioStepRows = [];   // flat rows, retained for export

// Average hourly wage to price one more teacher-day in a room: staff assigned
// to that room, else the center-wide average of active hourly staff. Salaried
// staff are excluded — adding a child doesn't change a salary. Returns 0 when
// there is no wage data to go on, which callers surface as "unknown" rather
// than as a free teacher.
function _ratioStepWage(staff, roomId) {
    const hourly = staff.filter(s => s.pay_type === 'hourly' && Number(s.hourly_rate) > 0);
    const inRoom = hourly.filter(s => s.room_id === roomId);
    const pool   = inRoom.length ? inRoom : hourly;
    if (!pool.length) return 0;
    return pool.reduce((sum, s) => sum + Number(s.hourly_rate), 0) / pool.length;
}

// Teachers a shift requires. Mirrors the amNeed/pmNeed rule in
// renderScheduleTables() — keep the two in step if either changes.
function _ratioStaffNeed(children, ratio) {
    if (!ratio || ratio <= 0) return null;
    return Math.ceil(children / ratio);
}

// Price one more booking of a given type. Returns which shifts it trips, what
// the triggered labor costs, and the resulting margin — or a reason the
// question can't be answered (no seat, no ratio, no wage, not offered).
// `null` cost/margin always means "unknown", never "free".
function _ratioStepOffer(opts) {
    const { isFullDay, rate, ratio, wage, openSeats, headroomAm, headroomPm, amChildren } = opts;
    const none = { stepsAm: false, stepsPm: false, cost: null, margin: null };

    if (!rate || rate <= 0)                        return Object.assign({ verdict: 'not-offered' }, none);
    if (openSeats !== null && openSeats <= 0)      return Object.assign({ verdict: 'full' }, none);
    if (!ratio || ratio <= 0)                      return Object.assign({ verdict: 'no-ratio' }, none);

    // The morning must absorb every booking; only a full day also has to fit
    // the afternoon.
    const stepsAm = headroomAm === 0;
    const stepsPm = isFullDay && headroomPm === 0;

    if (!stepsAm && !stepsPm) {
        return { verdict: 'free', stepsAm, stepsPm, cost: 0, margin: rate };
    }
    // A room with nobody booked needs its first teacher for this child.
    const verdict = amChildren === 0 ? 'opens' : 'step';
    if (!wage || wage <= 0) {
        return { verdict, stepsAm, stepsPm, cost: null, margin: null };
    }
    const cost = (stepsAm ? SHIFT_HRS.am : 0) * wage + (stepsPm ? SHIFT_HRS.pm : 0) * wage;
    return { verdict, stepsAm, stepsPm, cost, margin: rate - cost };
}

// Build one row per room per day for the given week.
function _buildRatioStepRows(weekDates, rooms, staff) {
    const counts = {};                       // date → roomId → { total, half }
    weekDates.forEach(d => { counts[d] = {}; });

    allRegistrations.forEach(reg => {
        if (reg.status !== 'confirmed') return;
        (reg.registration_dates || []).forEach(rd => {
            if (rd.waitlisted || !counts[rd.care_date]) return;
            const roomId = rd.room_id || reg.room_id;
            if (!roomId) return;
            const c = counts[rd.care_date][roomId] ||
                      (counts[rd.care_date][roomId] = { total: 0, half: 0 });
            c.total++;
            if (rd.day_type === 'half') c.half++;
        });
    });

    const wageByRoom = {};
    rooms.forEach(r => { wageByRoom[r.id] = _ratioStepWage(staff, r.id); });

    const rows = [];
    weekDates.forEach(date => {
        rooms.forEach(room => {
            const c        = counts[date][room.id] || { total: 0, half: 0 };
            const ratio    = room.staffRatio || 0;
            const capacity = room.capacity   || 0;
            const wage     = wageByRoom[room.id] || 0;
            const fullRate = room.fullDayRate || 0;
            // A full-day-only room has no half-day booking to price.
            const halfRate = room.fullDayOnly ? 0 : (room.halfDayRate || 0);

            // Morning holds everyone; the afternoon holds only full-day children.
            const amChildren = c.total;
            const pmChildren = c.total - c.half;

            // ceil() is the step. With 0 children 0 teachers are required, so
            // the first child of a shift genuinely does cost a teacher — that
            // is a real step, not an edge case to paper over.
            const staffAm    = _ratioStaffNeed(amChildren, ratio);
            const staffPm    = _ratioStaffNeed(pmChildren, ratio);
            const headroomAm = ratio > 0 ? staffAm * ratio - amChildren : null;
            const headroomPm = ratio > 0 ? staffPm * ratio - pmChildren : null;
            const openSeats  = capacity > 0 ? capacity - amChildren : null;

            // Teachers the afternoon does not need — they can leave at midday
            // once the half-day children go home.
            const releasable      = (staffAm === null || staffPm === null) ? null : staffAm - staffPm;
            const releasableHours = releasable === null ? null : releasable * SHIFT_HRS.pm;

            const shared = { ratio, wage, openSeats, headroomAm, headroomPm, amChildren };
            const fullDay = _ratioStepOffer(Object.assign({ isFullDay: true,  rate: fullRate }, shared));
            const halfDay = _ratioStepOffer(Object.assign({ isFullDay: false, rate: halfRate }, shared));

            rows.push({
                date, roomId: room.id, roomLabel: room.label,
                children: c.total, half: c.half, amChildren, pmChildren,
                ratio, capacity, openSeats,
                staffAm, staffPm, headroomAm, headroomPm,
                releasable, releasableHours,
                fullRate, halfRate, wage,
                fullDay, halfDay,
            });
        });
    });
    return rows;
}

// Mounted twice (design_handoff_planning_market, 2026-08-27): the Planning
// tab's own Ratio Step & Next Child tool (no visual change — every id below
// defaults to that tool's existing markup), and a second time embedded in
// Staff → Build Staff Schedule (see apMountStaffRatioStep() in
// admin-portal.js), which passes its own container/export ids and a `weekOf`
// value taken directly from the schedule's own week picker rather than a
// second date input. One render function, not duplicated markup, per the
// handoff's explicit "mount into a <div> slot" instruction.
async function generateRatioStepReport(opts) {
    opts = opts || {};
    const container = document.getElementById(opts.containerId || 'ratioStepContent');
    if (!container) return;
    const weekOf = opts.weekOf || document.getElementById(opts.weekOfId || 'ratioStepWeekOf')?.value;
    if (!weekOf) { if (!opts.silent) alert('Please select a week.'); return; }

    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const weekDates = _buildWeekDates(weekOf);
        if (!weekDates.length) {
            container.innerHTML = '<p class="empty-hint">No school days in this week (all days are weekends or closures).</p>';
            return;
        }

        if (!allRegistrations.length) allRegistrations = await fetchAllRegistrations();
        const staff = await fetchAllStaff();

        const roomSel = opts.roomSel || document.getElementById(opts.roomSelId || 'ratioStepRoomSel')?.value || 'all';
        let rooms = getSortedRooms();
        if (roomSel === 'all') {
            // Drop rooms with no bookings anywhere this week — an out-of-season
            // room would otherwise fill the table with "first child costs a
            // teacher" rows that aren't decisions anyone is weighing.
            const booked = new Set();
            allRegistrations.forEach(reg => {
                if (reg.status !== 'confirmed') return;
                (reg.registration_dates || []).forEach(rd => {
                    if (!rd.waitlisted && weekDates.includes(rd.care_date)) {
                        booked.add(rd.room_id || reg.room_id);
                    }
                });
            });
            rooms = rooms.filter(r => booked.has(r.id));
        } else {
            rooms = rooms.filter(r => r.id === roomSel);
        }
        if (!rooms.length) {
            container.innerHTML = '<p class="empty-hint">No confirmed bookings in any room this week.</p>';
            return;
        }

        const rows = _buildRatioStepRows(weekDates, rooms, staff);
        _ratioStepRows = rows;

        const fmt$ = v => `$${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
        const signed$ = v => (v < 0 ? '−' : '+') + fmt$(v);

        // ── Summary ─────────────────────────────────────────
        const atEdge = rows.filter(r => r.fullDay.verdict === 'step');
        const costly = atEdge.filter(r => r.fullDay.margin !== null && r.fullDay.margin < 0);
        // Full-day children absorbable at zero extra labor: they must fit both
        // shifts, and there must be a seat.
        const freeSeats = rows
            .filter(r => r.fullDay.verdict === 'free')
            .reduce((s, r) => s + Math.min(r.headroomAm, r.headroomPm, r.openSeats ?? Infinity), 0);
        // Afternoon teachers the bookings don't require.
        const releasableHours = rows.reduce((s, r) => s + (r.releasableHours || 0), 0);
        // Where a half day is takeable for free but a full day is not — the
        // shift split earning its keep.
        const halfOnlyFree = rows.filter(r =>
            r.halfDay.verdict === 'free' && r.fullDay.verdict === 'step').length;

        const wageKnown = rows.some(r => r.wage > 0);

        const summary = `
            <div class="fin-kpi-row" style="margin-bottom:1.25rem">
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Room-days at a ratio edge</span>
                    <span class="fin-kpi-value${atEdge.length ? ' fin-negative' : ''}">${atEdge.length}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">…where the next full day loses money</span>
                    <span class="fin-kpi-value${costly.length ? ' fin-negative' : ''}">${costly.length}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Afternoon teacher-hours not required</span>
                    <span class="fin-kpi-value${releasableHours ? ' fin-positive' : ''}">${releasableHours || 0} h</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Room-days where only a half day is free</span>
                    <span class="fin-kpi-value">${halfOnlyFree}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Full days absorbable with no new staff</span>
                    <span class="fin-kpi-value fin-positive">${freeSeats}</span>
                </div>
            </div>`;

        // ── Table ───────────────────────────────────────────
        const body = weekDates.map(date => {
            const dayRows = rows.filter(r => r.date === date);
            const dayTotal = dayRows.reduce((s, r) => s + r.children, 0);
            const dayHalf = dayRows.reduce((s, r) => s + r.half, 0);
            const header = `<tr class="ar-month-row"><td colspan="8"><strong>${escHtml(friendlyShort(date))}</strong>
                <span style="font-weight:400;color:#6b7280"> — ${dayTotal} ${dayTotal === 1 ? 'child' : 'children'} booked${dayHalf ? `, ${dayHalf} leaving at midday` : ''}</span></td></tr>`;

            // Renders one offer (a full-day or half-day booking) as a cell.
            const offerHtml = (o, shiftNote) => {
                switch (o.verdict) {
                    case 'not-offered': return '<span style="color:#9ca3af">not offered</span>';
                    case 'full':        return '<span style="color:#6b7280">no seat</span>';
                    case 'no-ratio':    return '<span style="color:#6b7280">set a ratio</span>';
                    case 'free':        return `<span style="color:#2e7d32">${signed$(o.margin)} <span style="color:#6b7280">— no new staff</span></span>`;
                    default: {          // 'step' | 'opens'
                        const what = o.verdict === 'opens' ? 'opens the room' : shiftNote(o);
                        return o.margin === null
                            ? `<span style="color:#6b7280">needs staff (${escHtml(what)}) — wage unknown</span>`
                            : `<span style="color:${o.margin < 0 ? '#c62828' : '#2e7d32'}"><strong>${signed$(o.margin)}</strong> <span style="color:#6b7280">— ${escHtml(what)}</span></span>`;
                    }
                }
            };
            const stepNote = o => {
                if (o.stepsAm && o.stepsPm) return 'a teacher all day';
                if (o.stepsAm)              return 'a morning teacher';
                if (o.stepsPm)              return 'an afternoon teacher';
                return 'a teacher';
            };

            const cells = dayRows.map(r => {
                const worst = r.fullDay.margin;
                const rowStyle = worst !== null && worst < 0 ? ' style="background:#fdf2f2"'
                    : r.fullDay.verdict === 'step' || r.fullDay.verdict === 'opens' ? ' style="background:#fffdf5"'
                    : '';

                const pair = (am, pm, flagZero) => {
                    if (am === null || pm === null) return '—';
                    const f = v => flagZero && v === 0 ? `<strong style="color:#c62828">0</strong>` : String(v);
                    return `${f(am)} <span style="color:#9ca3af">/</span> <span style="color:#6b7280">${f(pm)}</span>`;
                };

                const staffCell = r.staffAm === null ? '—'
                    : pair(r.staffAm, r.staffPm, false) +
                      (r.releasable > 0
                          ? `<div style="font-size:.75em;color:#2e7d32">−${r.releasable} at midday</div>`
                          : '');

                return `<tr${rowStyle}>
                    <td style="padding-left:1.5rem">${escHtml(r.roomLabel)}</td>
                    <td class="report-num">${pair(r.amChildren, r.pmChildren, false)}</td>
                    <td class="report-num" style="color:#6b7280">${r.ratio ? '1:' + r.ratio : '—'}</td>
                    <td class="report-num">${staffCell}</td>
                    <td class="report-num">${pair(r.headroomAm, r.headroomPm, true)}</td>
                    <td class="report-num">${r.openSeats ?? '—'}</td>
                    <td>${offerHtml(r.fullDay, stepNote)}</td>
                    <td>${offerHtml(r.halfDay, stepNote)}</td>
                </tr>`;
            }).join('');

            return header + cells;
        }).join('');

        container.innerHTML = summary + `
            <div style="overflow-x:auto">
            <table class="report-table">
                <thead><tr>
                    <th>Room</th>
                    <th class="report-num">Children<br><span style="font-weight:400;font-size:.85em">AM / PM</span></th>
                    <th class="report-num">Ratio</th>
                    <th class="report-num">Staff req.<br><span style="font-weight:400;font-size:.85em">AM / PM</span></th>
                    <th class="report-num">Headroom<br><span style="font-weight:400;font-size:.85em">AM / PM</span></th>
                    <th class="report-num">Open seats</th>
                    <th>Next full-day child</th>
                    <th>Next half-day child</th>
                </tr></thead>
                <tbody>${body}</tbody>
            </table>
            </div>
            <p style="font-size:.8em;color:#6b7280;margin:.75rem 0 0">
                The day is split into two shifts: <strong>AM</strong> holds every child booked, <strong>PM</strong> holds only the full-day children,
                since a half-day booking is a morning session — the same rule the Schedule Planner uses.
                <strong>Staff req.</strong> = ceil(children &divide; ratio) for each shift; <em>&minus;n at midday</em> marks teachers the afternoon doesn't need.
                <strong>Headroom</strong> = children who still fit that shift before another teacher is required; <strong>0</strong> means the next booking trips the ratio.
                <strong>Next child</strong> prices one more booking at the room's rate minus only the shifts it actually triggers —
                ${wageKnown
                    ? `each shift costed at the room's average hourly wage &times; ${SHIFT_HRS.am} h (the shift length used by the Schedule Planner and Room P&amp;L)`
                    : `no hourly wage is on file for these rooms, so the labor side can't be priced — set hourly rates on the Staff Roster`}.
                A half day only has to fit the morning, so it can be free to take where a full day is not; rooms without a half-day rate show <em>not offered</em>.
                Ratios, capacities and rates come from Settings &rarr; Rates &amp; Settings.
                Booked children are not the same as attended children — the portal has no child check-in, so these are bookings.
            </p>`;

        if (opts.showExport !== false) {
            const exportBtn = document.getElementById(opts.exportBtnId || 'exportRatioStepBtn');
            if (exportBtn) exportBtn.style.display = '';
        }
    } catch (err) {
        container.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    }
}

function exportRatioStepReport() {
    if (!_ratioStepRows.length) return;
    const describeOffer = o => {
        switch (o.verdict) {
            case 'not-offered': return 'Not offered in this room';
            case 'full':        return 'Room full — no seat';
            case 'no-ratio':    return 'Ratio not configured';
            case 'free':        return 'Absorbed by current staff';
            case 'opens':       return 'Opens the room — needs a teacher';
            default:
                if (o.stepsAm && o.stepsPm) return 'Trips both shifts — needs a teacher all day';
                if (o.stepsAm)              return 'Trips the morning — needs a morning teacher';
                if (o.stepsPm)              return 'Trips the afternoon — needs an afternoon teacher';
                return 'Trips the ratio';
        }
    };
    const headers = ['Date', 'Room', 'Children AM', 'Children PM', 'Half-day', 'Ratio',
                     'Staff required AM', 'Staff required PM', 'Releasable at midday',
                     'Releasable hours', 'Headroom AM', 'Headroom PM', 'Open seats',
                     'Full-day rate', 'Next full-day labor', 'Next full-day margin', 'Next full-day',
                     'Half-day rate', 'Next half-day labor', 'Next half-day margin', 'Next half-day'];
    const rows = _ratioStepRows.map(r => [
        r.date,
        r.roomLabel,
        r.amChildren,
        r.pmChildren,
        r.half,
        r.ratio ? `1:${r.ratio}` : '',
        r.staffAm ?? '',
        r.staffPm ?? '',
        r.releasable ?? '',
        r.releasableHours ?? '',
        r.headroomAm ?? '',
        r.headroomPm ?? '',
        r.openSeats ?? '',
        r.fullRate || '',
        r.fullDay.cost   === null ? '' : Math.round(r.fullDay.cost),
        r.fullDay.margin === null ? '' : Math.round(r.fullDay.margin),
        describeOffer(r.fullDay),
        r.halfRate || '',
        r.halfDay.cost   === null ? '' : Math.round(r.halfDay.cost),
        r.halfDay.margin === null ? '' : Math.round(r.halfDay.margin),
        describeOffer(r.halfDay),
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Ratio Step');
    XLSX.writeFile(wb, 'ratio-step-next-child.xlsx');
}

// ============================================================
// DEMAND FORECAST
// ============================================================
// Projects children per room per day for the weeks ahead, at the grain of
// date × room × half/full, from two models:
//
//   * Same-weekday average — the mean of that weekday's realized level over
//     the history window. This is the primary model, because the weekday
//     signal here is large (Thursdays have run ~26% heavier than Mondays).
//   * Four-week moving average — the mean daily level over the last four
//     weeks, regardless of weekday. A level check against the first.
//
// What is deliberately NOT modelled, because the data cannot support it yet:
// seasonality and year-over-year (bookings only start April 2026 — less than
// one full cycle), weather, and the booking curve (bookings for a future date
// keep arriving, so "booked so far" understates it; the column is shown
// alongside the forecast so the gap is visible rather than hidden).
//
// The forecast projects BOOKINGS. Where attendance has been marked, the
// show rate converts that into expected attendance; until then that column
// says so rather than quietly assuming everyone turns up.

const FORECAST_HISTORY_WEEKS = 8;   // weekday samples drawn from this window
const FORECAST_RECENT_WEEKS  = 4;   // moving-average window
const FORECAST_MIN_SAMPLES   = 4;   // below this a weekday estimate is "thin"

let _forecastRows = [];   // flat rows, retained for export

// Mean of a list, or null when there is nothing to average. Never 0 — an
// absent estimate and an estimate of zero children are different claims.
function _forecastMean(values) {
    if (!values || !values.length) return null;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

// Share of marked children who actually attended. Days nobody marked are
// absent from the table entirely and contribute nothing — an unmarked day is
// not evidence of a no-show. Returns null when there is nothing to go on.
function _forecastShowRate(attendanceRows) {
    let present = 0, marked = 0;
    (attendanceRows || []).forEach(r => {
        if (r.status === 'present')     { present++; marked++; }
        else if (r.status === 'absent') { marked++; }
    });
    if (marked === 0) return null;
    return { rate: present / marked, marked };
}

// How much to trust a weekday estimate, given how many times we have seen it.
function _forecastConfidence(sampleCount) {
    if (!sampleCount)                          return 'none';
    if (sampleCount < FORECAST_MIN_SAMPLES)    return 'thin';
    return 'good';
}

// Build one projected row per room per target date.
//   history[roomId][dow] = { totals: number[], halves: number[] }
//   recent[roomId]       = number[]   daily totals over the moving-average window
//   booked[date][roomId] = { total, half }   bookings already on the books
//   showRate             = { rate, marked } | null
function _buildForecastRows(opts) {
    const { targetDates, rooms, history, recent, booked, showRate } = opts;
    const rows = [];

    targetDates.forEach(date => {
        const dow = new Date(date + 'T00:00:00').getDay();
        rooms.forEach(room => {
            const h        = history[room.id]?.[dow] || { totals: [], halves: [] };
            const samples  = h.totals.length;
            const weekday  = _forecastMean(h.totals);
            const moving   = _forecastMean(recent[room.id]);
            // Prefer the weekday-specific estimate; fall back to the flat level
            // only when that weekday has never been seen for this room.
            const forecast = weekday !== null ? weekday : moving;

            // Half-day share drives the afternoon, so carry it through rather
            // than assuming the mix holds at the center-wide average.
            const meanHalf  = _forecastMean(h.halves);
            const halfShare = (forecast && meanHalf !== null && weekday)
                ? Math.min(1, meanHalf / weekday)
                : 0;

            const bookedNow  = booked[date]?.[room.id]?.total || 0;
            const expected   = (forecast !== null && showRate) ? forecast * showRate.rate : null;
            // Staff to what we expect to walk in where that is known, else to
            // the booking forecast.
            const basis      = expected !== null ? expected : forecast;
            const amChildren = basis === null ? null : Math.round(basis);
            const pmChildren = amChildren === null ? null : Math.round(basis * (1 - halfShare));
            const staffAm    = amChildren === null ? null : _ratioStaffNeed(amChildren, room.staffRatio || 0);
            const staffPm    = pmChildren === null ? null : _ratioStaffNeed(pmChildren, room.staffRatio || 0);

            rows.push({
                date, dow, roomId: room.id, roomLabel: room.label,
                samples, confidence: _forecastConfidence(samples),
                weekdayAvg: weekday, movingAvg: moving, forecast,
                halfShare, bookedNow, expected,
                amChildren, pmChildren, staffAm, staffPm,
                capacity: room.capacity || 0,
                overCapacity: room.capacity > 0 && amChildren !== null && amChildren > room.capacity,
            });
        });
    });
    return rows;
}

// Collect realized daily counts from allRegistrations over a date window.
// Returns { byDate, history, recent } in the shapes _buildForecastRows wants.
function _collectForecastHistory(historyDates, recentDates, rooms) {
    const byDate = {};
    historyDates.forEach(d => { byDate[d] = {}; });

    allRegistrations.forEach(reg => {
        if (reg.status !== 'confirmed') return;
        (reg.registration_dates || []).forEach(rd => {
            if (rd.waitlisted || !byDate[rd.care_date]) return;
            const roomId = rd.room_id || reg.room_id;
            if (!roomId) return;
            const c = byDate[rd.care_date][roomId] ||
                      (byDate[rd.care_date][roomId] = { total: 0, half: 0 });
            c.total++;
            if (rd.day_type === 'half') c.half++;
        });
    });

    const history = {}, recent = {};
    rooms.forEach(room => { history[room.id] = {}; recent[room.id] = []; });

    historyDates.forEach(date => {
        const dow = new Date(date + 'T00:00:00').getDay();
        rooms.forEach(room => {
            const c = byDate[date][room.id] || { total: 0, half: 0 };
            const slot = history[room.id][dow] ||
                         (history[room.id][dow] = { totals: [], halves: [] });
            slot.totals.push(c.total);
            slot.halves.push(c.half);
            if (recentDates.includes(date)) recent[room.id].push(c.total);
        });
    });

    return { byDate, history, recent };
}

// Open weekdays in [from, to), skipping weekends and closures.
function _forecastOpenDays(fromDate, toDate) {
    const out = [];
    const d = new Date(fromDate + 'T00:00:00');
    const end = new Date(toDate + 'T00:00:00');
    while (d < end) {
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) {
            const s = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
            if (!allClosureDates.has(s)) out.push(s);
        }
        d.setDate(d.getDate() + 1);
    }
    return out;
}

async function generateDemandForecast() {
    const container = document.getElementById('forecastContent');
    if (!container) return;
    container.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        if (!allRegistrations.length) allRegistrations = await fetchAllRegistrations();

        const weeksAhead = Number(document.getElementById('forecastWeeks')?.value) || 4;
        const roomSel    = document.getElementById('forecastRoomSel')?.value || 'all';
        const rooms = roomSel === 'all'
            ? getSortedRooms().filter(r => r.status !== 'seasonal')
            : getSortedRooms().filter(r => r.id === roomSel);
        if (!rooms.length) { container.innerHTML = '<p class="empty-hint">No rooms to forecast.</p>'; return; }

        const iso   = d => d.toISOString().split('T')[0];
        const today = new Date(); today.setHours(12, 0, 0, 0);

        const histStart   = new Date(today); histStart.setDate(today.getDate() - FORECAST_HISTORY_WEEKS * 7);
        const recentStart = new Date(today); recentStart.setDate(today.getDate() - FORECAST_RECENT_WEEKS * 7);
        const horizonEnd  = new Date(today); horizonEnd.setDate(today.getDate() + weeksAhead * 7);

        const historyDates = _forecastOpenDays(iso(histStart), iso(today));
        const recentDates  = _forecastOpenDays(iso(recentStart), iso(today));
        const targetDates  = _forecastOpenDays(iso(today), iso(horizonEnd));

        if (!historyDates.length) {
            container.innerHTML = '<p class="empty-hint">No history in the last ' +
                FORECAST_HISTORY_WEEKS + ' weeks to forecast from.</p>';
            return;
        }

        const { byDate, history, recent } = _collectForecastHistory(historyDates, recentDates, rooms);

        // Bookings already on the books for the horizon.
        const { byDate: bookedByDate } = _collectForecastHistory(targetDates, [], rooms);

        // Show rate, if anyone has been marking attendance.
        let showRate = null, attendanceErr = false;
        try {
            showRate = _forecastShowRate(await fetchAttendanceRange(iso(histStart), iso(today)));
        } catch (err) {
            console.warn('fetchAttendanceRange:', err);
            attendanceErr = true;
        }

        const rows = _buildForecastRows({
            targetDates, rooms, history, recent, booked: bookedByDate, showRate,
        });
        _forecastRows = rows;

        const n1 = v => v === null ? '—' : (Math.round(v * 10) / 10).toString().replace(/\.0$/, '');

        // ── Banner: what the forecast is actually of ──────────
        const basisBanner = showRate
            ? `<p class="att-hint" style="color:var(--green-dark)">Adjusted for a
               <strong>${Math.round(showRate.rate * 100)}%</strong> show rate, measured from
               ${showRate.marked} marked child-day${showRate.marked === 1 ? '' : 's'} in the last
               ${FORECAST_HISTORY_WEEKS} weeks.</p>`
            : `<p class="att-hint"><strong>These are booking forecasts, not attendance forecasts.</strong>
               ${attendanceErr
                   ? `Attendance marks couldn't be loaded.`
                   : `No attendance has been marked yet, so there is no show rate to apply.`}
               Mark children in or out on the <em>Classrooms</em> tab and this report will convert
               bookings into expected attendance automatically.</p>`;

        const thin = rows.filter(r => r.confidence !== 'good').length;

        // ── Summary ──────────────────────────────────────────
        const totalForecast = rows.reduce((s, r) => s + (r.amChildren || 0), 0);
        const totalBooked   = rows.reduce((s, r) => s + r.bookedNow, 0);
        const overCap       = rows.filter(r => r.overCapacity).length;
        const summary = `
            <div class="fin-kpi-row" style="margin-bottom:1.25rem">
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Projected child-days (next ${weeksAhead} wk)</span>
                    <span class="fin-kpi-value">${totalForecast}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Already booked</span>
                    <span class="fin-kpi-value">${totalBooked}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Still expected to book</span>
                    <span class="fin-kpi-value${totalForecast - totalBooked > 0 ? ' fin-positive' : ''}">${Math.max(0, totalForecast - totalBooked)}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Room-days projected over capacity</span>
                    <span class="fin-kpi-value${overCap ? ' fin-negative' : ''}">${overCap}</span>
                </div>
            </div>`;

        // ── Table ────────────────────────────────────────────
        const body = targetDates.map(date => {
            const dayRows = rows.filter(r => r.date === date);
            const header = `<tr class="ar-month-row"><td colspan="8"><strong>${escHtml(friendlyShort(date))}</strong></td></tr>`;
            const cells = dayRows.map(r => {
                const conf = r.confidence === 'good' ? ''
                    : r.confidence === 'thin'
                        ? ` <span title="Only ${r.samples} past occurrence${r.samples === 1 ? '' : 's'} of this weekday" style="color:#b45309">thin</span>`
                        : ` <span title="This weekday has never been seen for this room" style="color:#6b7280">no history</span>`;
                return `<tr${r.overCapacity ? ' style="background:#fdf2f2"' : ''}>
                    <td style="padding-left:1.5rem">${escHtml(r.roomLabel)}</td>
                    <td class="report-num"><strong>${r.amChildren ?? '—'}</strong>${conf}</td>
                    <td class="report-num" style="color:#6b7280">${r.pmChildren ?? '—'}</td>
                    <td class="report-num" style="color:#6b7280">${n1(r.weekdayAvg)}</td>
                    <td class="report-num" style="color:#6b7280">${n1(r.movingAvg)}</td>
                    <td class="report-num">${r.bookedNow}</td>
                    <td class="report-num">${r.staffAm ?? '—'} <span style="color:#9ca3af">/</span> <span style="color:#6b7280">${r.staffPm ?? '—'}</span></td>
                    <td class="report-num"${r.overCapacity ? ' style="color:#c62828;font-weight:700"' : ''}>${r.capacity || '—'}</td>
                </tr>`;
            }).join('');
            return header + cells;
        }).join('');

        container.innerHTML = basisBanner + summary + `
            <div style="overflow-x:auto">
            <table class="report-table">
                <thead><tr>
                    <th>Room</th>
                    <th class="report-num">Projected<br><span style="font-weight:400;font-size:.85em">AM</span></th>
                    <th class="report-num">Projected<br><span style="font-weight:400;font-size:.85em">PM</span></th>
                    <th class="report-num">Same-weekday<br><span style="font-weight:400;font-size:.85em">avg</span></th>
                    <th class="report-num">${FORECAST_RECENT_WEEKS}-wk moving<br><span style="font-weight:400;font-size:.85em">avg</span></th>
                    <th class="report-num">Booked<br><span style="font-weight:400;font-size:.85em">so far</span></th>
                    <th class="report-num">Staff req.<br><span style="font-weight:400;font-size:.85em">AM / PM</span></th>
                    <th class="report-num">Capacity</th>
                </tr></thead>
                <tbody>${body}</tbody>
            </table>
            </div>
            <p style="font-size:.8em;color:#6b7280;margin:.75rem 0 0">
                <strong>Projected</strong> uses the same-weekday average over the last ${FORECAST_HISTORY_WEEKS} weeks,
                falling back to the ${FORECAST_RECENT_WEEKS}-week moving average where a weekday has no history for that room.
                PM applies that weekday's own half-day share, since half days are morning sessions.
                <strong>Booked so far</strong> is what is already on the books — bookings for a future date keep arriving,
                so it is expected to sit below the projection, and the gap is the booking still to come.
                Estimates drawn from fewer than ${FORECAST_MIN_SAMPLES} past occurrences are marked <em>thin</em>${thin ? ` (${thin} here)` : ''}.
                Seasonality, year-over-year and weather are <strong>not</strong> modelled — bookings only begin in April 2026,
                which is less than one full cycle, and a seasonal curve fitted to that would be invented rather than measured.
            </p>`;

        const btn = document.getElementById('exportForecastBtn');
        if (btn) btn.style.display = '';
    } catch (err) {
        container.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    }
}

function exportDemandForecast() {
    if (!_forecastRows.length) return;
    const headers = ['Date', 'Room', 'Projected AM', 'Projected PM', 'Same-weekday avg',
                     `${FORECAST_RECENT_WEEKS}-week moving avg`, 'Half-day share', 'Booked so far',
                     'Staff required AM', 'Staff required PM', 'Capacity', 'Over capacity',
                     'Weekday samples', 'Confidence'];
    const rows = _forecastRows.map(r => [
        r.date, r.roomLabel,
        r.amChildren ?? '', r.pmChildren ?? '',
        r.weekdayAvg === null ? '' : Math.round(r.weekdayAvg * 10) / 10,
        r.movingAvg  === null ? '' : Math.round(r.movingAvg  * 10) / 10,
        Math.round(r.halfShare * 100) / 100,
        r.bookedNow,
        r.staffAm ?? '', r.staffPm ?? '',
        r.capacity || '', r.overCapacity ? 'YES' : '',
        r.samples, r.confidence,
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Demand Forecast');
    XLSX.writeFile(wb, 'demand-forecast.xlsx');
}

// ============================================================
function setupExtraReports() {
    document.getElementById('generateTrendsBtn')?.addEventListener('click', generateEnrollmentTrends);
    document.getElementById('exportTrendsBtn')?.addEventListener('click', exportEnrollmentTrends);
    document.getElementById('generateRoomPnlBtn')?.addEventListener('click', generateRoomPnl);
    document.getElementById('exportRoomPnlBtn')?.addEventListener('click', exportRoomPnl);
    document.getElementById('generatePromotionsBtn')?.addEventListener('click', generatePromotionsReport);
    document.getElementById('exportPromotionsBtn')?.addEventListener('click', exportPromotionsReport);
    document.getElementById('printPromotionsBtn')?.addEventListener('click', printPromotionsReport);
    document.getElementById('generateFteBtn')?.addEventListener('click', generateEnrollmentFteReport);
    document.getElementById('generateSeatDayBtn')?.addEventListener('click', generateSeatDayCapacityReport);
    document.getElementById('seatDayRoomSel')?.addEventListener('change', generateSeatDayCapacityReport);
    document.getElementById('generateForecastBtn')?.addEventListener('click', generateDemandForecast);
    document.getElementById('exportForecastBtn')?.addEventListener('click', exportDemandForecast);
    document.getElementById('forecastRoomSel')?.addEventListener('change', generateDemandForecast);
    document.getElementById('forecastWeeks')?.addEventListener('change', generateDemandForecast);
    // Wrapped in arrow functions rather than passed directly: generateRatioStepReport
    // now takes an optional opts object (it's also mounted a second time inside
    // Build Staff Schedule — see apMountStaffRatioStep() in admin-portal.js), and an
    // event listener would otherwise pass the click/change Event as that argument.
    document.getElementById('generateRatioStepBtn')?.addEventListener('click', () => generateRatioStepReport());
    document.getElementById('exportRatioStepBtn')?.addEventListener('click', exportRatioStepReport);
    document.getElementById('ratioStepRoomSel')?.addEventListener('change', () => generateRatioStepReport());
    document.getElementById('generateDiscountPricingBtn')?.addEventListener('click', generateDiscountPricingReport);
    document.getElementById('exportDiscountPricingBtn')?.addEventListener('click', exportDiscountPricingReport);
    document.getElementById('printDiscountPricingBtn')?.addEventListener('click', printDiscountPricingReport);

    // Demand forecast: room picker (non-seasonal rooms)
    const fcSel = document.getElementById('forecastRoomSel');
    if (fcSel && fcSel.options.length <= 1) {
        getSortedRooms().filter(r => r.status !== 'seasonal').forEach(r => {
            const opt = document.createElement('option');
            opt.value = r.id;
            opt.textContent = r.label;
            fcSel.appendChild(opt);
        });
    }

    // Ratio-step: room picker + default to the Monday of the current week
    const rsSel = document.getElementById('ratioStepRoomSel');
    if (rsSel && rsSel.options.length <= 1) {
        getSortedRooms().forEach(r => {
            const opt = document.createElement('option');
            opt.value = r.id;
            opt.textContent = r.label;
            rsSel.appendChild(opt);
        });
    }
    const rsWeek = document.getElementById('ratioStepWeekOf');
    if (rsWeek && !rsWeek.value) {
        const t = new Date();
        const dow = t.getDay();                       // 0 = Sunday
        const monday = new Date(t);
        monday.setDate(t.getDate() - (dow === 0 ? 6 : dow - 1));
        rsWeek.value = monday.toISOString().split('T')[0];
    }

    const now2 = new Date();
    const dpEl = document.getElementById('discountPricingMonth');
    if (dpEl) dpEl.value = `${now2.getFullYear()}-${String(now2.getMonth() + 1).padStart(2, '0')}`;

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
async function _buildRoomPnlData(fromDate, toDate, { skipHistoricalOverride = false } = {}) {
    const fromMo = fromDate.substring(0, 7);
    const toMo   = toDate.substring(0, 7);

    // Fetch revenue and schedule data in parallel
    const [arMap, scheduleRows] = await Promise.all([
        _buildArDataMap(fromDate, toDate, { skipHistoricalOverride }),
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

    // ── Fallback: center-wide labor when no room schedules saved ─────────────
    // Priority order:
    //   1. Historical Payroll Records (Staffing tab) — actual total paid per period
    //   2. Logged staff hours (staff_hours table)    — for months not in history
    //   3. Salary estimates from staff table          — absolute last resort
    const centerLaborByMonth = {}; // mo → total cost
    const centerLaborSource  = {}; // mo → 'historical' | 'hours' | 'salary_estimate'

    // Helper: parse "Month Day[, Year] - Month Day, Year" label → {start, end} Date objects
    function _parsePayrollLabel(label) {
        const m = label.match(/^(.+?)\s*[-–]\s*(.+)$/);
        if (!m) return null;
        const [, rawStart, rawEnd] = m;
        const end = new Date(rawEnd.trim());
        if (isNaN(end)) return null;
        // Only trust the start date directly if it contains a 4-digit year.
        // new Date("January 5") returns year 2001 in some browsers instead of Invalid Date.
        const startHasYear = /\b\d{4}\b/.test(rawStart.trim());
        let start;
        if (startHasYear) {
            start = new Date(rawStart.trim());
        } else {
            start = new Date(`${rawStart.trim()}, ${end.getFullYear()}`);
            if (!isNaN(start) && start.getMonth() > end.getMonth()) {
                // Start month is later in the year than end month → prior year
                start = new Date(`${rawStart.trim()}, ${end.getFullYear() - 1}`);
            }
        }
        return isNaN(start) ? null : { start, end };
    }

    // Helper: count Mon–Fri days in a date range (inclusive)
    function _workDaysInRange(start, end) {
        let n = 0;
        const d = new Date(start); d.setHours(12);
        const e = new Date(end);   e.setHours(12);
        while (d <= e) { const dow = d.getDay(); if (dow >= 1 && dow <= 5) n++; d.setDate(d.getDate() + 1); }
        return n;
    }

    const rooms = getSortedRooms().filter(r => r.status !== 'seasonal');

    if (scheduleRows.length === 0) {
        try {
            // Fetch all data sources used by the Payroll Report
            const [histRecords, hoursRowsAll, allStaff, clockEventsAll] = await Promise.all([
                fetchHistoricalPayroll(),
                fetchStaffHoursWithPay(fromDate, toDate),
                fetchAllStaff({ includeInactive: true }),
                fetchClockEventsForRange(fromDate, toDate),
            ]);

            // Staff lookup by ID (for clock events which don't carry pay info)
            const staffById = new Map(allStaff.map(s => [s.id, s]));

            // Build a lookup: set of date strings (YYYY-MM-DD) covered by historical records
            // so logged-hours entries on those dates aren't double-counted.
            const histCoveredDates = new Set();

            // ── Tier 1: Historical Payroll Records ──────────────────────────
            histRecords.forEach(r => {
                const parsed = _parsePayrollLabel(r.label);
                if (!parsed) return;
                const { start, end } = parsed;
                const totalWorkDays = _workDaysInRange(start, end);
                if (totalWorkDays === 0) return;
                // Walk each day in period, tally working days per month + record covered dates
                const moWorkDays = {};
                const d = new Date(start); d.setHours(12);
                const e = new Date(end);   e.setHours(12);
                while (d <= e) {
                    const dow = d.getDay();
                    if (dow >= 1 && dow <= 5) {
                        const mo = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                        const ds = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
                        moWorkDays[mo] = (moWorkDays[mo] || 0) + 1;
                        histCoveredDates.add(ds);
                    }
                    d.setDate(d.getDate() + 1);
                }

                if (Array.isArray(r.staff) && r.staff.length > 0) {
                    // Per-person detail: allocate each staff member's gross_pay to their room (or float)
                    const floatByMo = {};
                    r.staff.forEach(s => {
                        if (!s.gross_pay || s.gross_pay <= 0) return;
                        // Find room_id for this staff_id (staffById built in Tier 2 block, but we need it here too)
                        const staffRec = s.staff_id ? allStaff.find(a => a.id === s.staff_id) : null;
                        const roomId = staffRec?.room_id || null;
                        Object.entries(moWorkDays).forEach(([mo, days]) => {
                            if (mo < fromMo || mo > toMo) return;
                            const prorated = s.gross_pay * days / totalWorkDays;
                            if (roomId && staffRec?.pay_type !== 'salary') {
                                const key = `${mo}|${roomId}`;
                                laborMap.set(key, (laborMap.get(key) || 0) + prorated);
                            } else {
                                floatByMo[mo] = (floatByMo[mo] || 0) + prorated;
                            }
                            centerLaborByMonth[mo] = (centerLaborByMonth[mo] || 0);
                            centerLaborSource[mo] = 'historical_detail';
                        });
                    });
                    // Distribute float/unmatched wages across rooms by attendance weight
                    Object.entries(floatByMo).forEach(([mo, floatCost]) => {
                        const moRooms = rooms.filter(r2 => (arMap[mo]?.[r2.id]?.attendees || 0) > 0);
                        const totalAtt = moRooms.reduce((s, r2) => s + arMap[mo][r2.id].attendees, 0);
                        if (totalAtt > 0) {
                            moRooms.forEach(r2 => {
                                const share = floatCost * arMap[mo][r2.id].attendees / totalAtt;
                                const key = `${mo}|${r2.id}`;
                                laborMap.set(key, (laborMap.get(key) || 0) + share);
                            });
                        } else {
                            centerLaborByMonth[mo] = (centerLaborByMonth[mo] || 0) + floatCost;
                        }
                    });
                } else {
                    // Lump-sum: prorate total_paid by proportion of working days in each month
                    Object.entries(moWorkDays).forEach(([mo, days]) => {
                        if (mo < fromMo || mo > toMo) return;
                        centerLaborByMonth[mo] = (centerLaborByMonth[mo] || 0) +
                            (parseFloat(r.total_paid) * days / totalWorkDays);
                        centerLaborSource[mo] = 'historical';
                    });
                }
            });

            // ── Tier 2: Per-room allocation from manual hours + clock events ──
            // Hourly assigned staff  → direct to their room (staff.room_id)
            // Hourly float with room tag → direct to tagged room (ev.room_id)
            // Hourly float without tag → unallocated (stays in centerLaborByMonth)

            function calcClockHrs(ev) {
                if (!ev.clock_in || !ev.clock_out) return 0;
                const ms = new Date(ev.clock_out) - new Date(ev.clock_in);
                if (ms < 10 * 60 * 1000) return 0;
                return Math.round(ms / 3600000 * 100) / 100;
            }

            // Set of (staff_id|work_date) keys already in staff_hours (for non-hist dates)
            const manualHrsKeys = new Set(
                hoursRowsAll
                    .filter(h => !histCoveredDates.has(h.work_date))
                    .map(h => `${h.staff_id}|${h.work_date}`)
            );

            // Manual hours → per-room where staff has an assignment, else unallocated
            hoursRowsAll.forEach(h => {
                const mo = h.work_date.substring(0, 7);
                if (mo < fromMo || mo > toMo) return;
                if (histCoveredDates.has(h.work_date)) return;
                if (h.pay_type === 'salary') return;
                const s = staffById.get(h.staff_id);
                const roomId = s?.room_id;
                const cost = (h.hourly_rate || 0) * h.hours_worked;
                if (roomId) {
                    const key = `${mo}|${roomId}`;
                    laborMap.set(key, (laborMap.get(key) || 0) + cost);
                } else {
                    centerLaborByMonth[mo] = (centerLaborByMonth[mo] || 0) + cost;
                    if (!centerLaborSource[mo]) centerLaborSource[mo] = 'hours';
                }
            });

            // Clock events → per-room using ev.room_id first, then staff.room_id, else unallocated
            clockEventsAll.forEach(ev => {
                const mo = (ev.work_date || '').substring(0, 7);
                if (mo < fromMo || mo > toMo) return;
                if (histCoveredDates.has(ev.work_date)) return;
                if (manualHrsKeys.has(`${ev.staff_id}|${ev.work_date}`)) return;
                const hrs = calcClockHrs(ev);
                if (hrs <= 0) return;
                const s = staffById.get(ev.staff_id);
                if (!s || s.pay_type === 'salary') return;
                const roomId = ev.room_id || s.room_id;
                const cost = (s.hourly_rate || 0) * hrs;
                if (roomId) {
                    const key = `${mo}|${roomId}`;
                    laborMap.set(key, (laborMap.get(key) || 0) + cost);
                } else {
                    // Float without a room tag: unallocated until they use the room picker at clock-in
                    centerLaborByMonth[mo] = (centerLaborByMonth[mo] || 0) + cost;
                    if (!centerLaborSource[mo]) centerLaborSource[mo] = 'hours';
                }
            });

            // ── Tier 3: Salaried overhead staff (no room) → attendance-weighted per room ──
            // Director salary is split across rooms proportional to child-attendance each month.
            const salaryOverhead = allStaff.filter(s => s.pay_type === 'salary' && !s.room_id && (s.salary_biweekly || 0) > 0);
            if (salaryOverhead.length > 0) {
                const totalOvhdPerPeriod = salaryOverhead.reduce((sum, s) => sum + (s.salary_biweekly || 0), 0);
                _buildPayrollPeriodList().forEach(p => {
                    if (p.end < fromDate || p.start > toDate) return;
                    const moUncoveredDays = {};
                    let totalWorkDays = 0;
                    const d = new Date(p.start + 'T12:00:00');
                    const e = new Date(p.end   + 'T12:00:00');
                    while (d <= e) {
                        const dow = d.getDay();
                        if (dow >= 1 && dow <= 5) {
                            totalWorkDays++;
                            const ds = d.toISOString().split('T')[0];
                            const mo = ds.substring(0, 7);
                            if (!histCoveredDates.has(ds) && mo >= fromMo && mo <= toMo) {
                                moUncoveredDays[mo] = (moUncoveredDays[mo] || 0) + 1;
                            }
                        }
                        d.setDate(d.getDate() + 1);
                    }
                    if (totalWorkDays === 0) return;
                    Object.entries(moUncoveredDays).forEach(([mo, days]) => {
                        const monthlyCost = totalOvhdPerPeriod * days / totalWorkDays;
                        const moRooms = rooms.filter(r => (arMap[mo]?.[r.id]?.attendees || 0) > 0);
                        const totalAtt = moRooms.reduce((s, r) => s + arMap[mo][r.id].attendees, 0);
                        if (totalAtt > 0) {
                            moRooms.forEach(r => {
                                const share = monthlyCost * arMap[mo][r.id].attendees / totalAtt;
                                const key = `${mo}|${r.id}`;
                                laborMap.set(key, (laborMap.get(key) || 0) + share);
                            });
                        } else {
                            // No attendance data: equal split
                            const perRoom = monthlyCost / rooms.length;
                            rooms.forEach(r => {
                                const key = `${mo}|${r.id}`;
                                laborMap.set(key, (laborMap.get(key) || 0) + perRoom);
                            });
                        }
                        if (!centerLaborSource[mo]) centerLaborSource[mo] = 'hours';
                    });
                });
            }
        } catch (e) {
            console.warn('Center-wide labor fallback failed:', e);
        }
    }

    // ── Merge revenue + labor into a unified data map ───────
    const data  = {};

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
    const hasClockBasedLabor = scheduleRows.length === 0 && laborMap.size > 0;
    return { months, rooms, data, hasScheduleData: scheduleRows.length > 0,
             centerLaborByMonth, centerLaborSource, hasFallbackLabor, hasClockBasedLabor };
}

async function generateRoomPnl() {
    const fromDate  = document.getElementById('pnlDateFrom')?.value;
    const toDate    = document.getElementById('pnlDateTo')?.value;
    const container = document.getElementById('roomPnlContent');

    if (!fromDate || !toDate) { alert('Please select both a start and end date.'); return; }
    if (fromDate > toDate)    { alert('Start date must be before end date.'); return; }

    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const { months, rooms, data, hasScheduleData, centerLaborByMonth, centerLaborSource, hasFallbackLabor, hasClockBasedLabor } = await _buildRoomPnlData(fromDate, toDate);

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
            const label  = MONTH_NAMES[m - 1] + ' ' + y;
            let moRev = 0, moLab = 0;

            const cells = rooms.map(r => {
                const d   = data[mo]?.[r.id] || { revenue: 0, labor: 0, margin: 0, attendees: 0 };
                const pct = d.revenue > 0 ? (d.margin / d.revenue) * 100 : (d.labor > 0 ? -100 : 0);
                roomTotals[r.id].revenue   += d.revenue;
                roomTotals[r.id].labor     += d.labor;
                roomTotals[r.id].margin    += d.margin;
                roomTotals[r.id].attendees += d.attendees;
                moRev += d.revenue;
                // Accumulate per-room labor when we have schedule or clock-based data
                if (hasScheduleData || hasClockBasedLabor) moLab += d.labor;
                const revPerChild  = d.attendees > 0 ? fmt$(Math.round(d.revenue / d.attendees)) : '—';
                const margPerChild = d.attendees > 0
                    ? (d.margin < 0 ? '−' : '') + fmt$(Math.round(Math.abs(d.margin) / d.attendees))
                    : '—';
                return `<td class="report-num report-revenue">${d.revenue > 0 ? fmt$(d.revenue) : '—'}</td>` +
                       `<td class="report-num">${d.labor > 0 ? fmt$(d.labor) : '—'}</td>` +
                       `<td class="report-num"${marginStyle(d.margin)}>${d.revenue > 0 || d.labor > 0 ? (d.margin < 0 ? '−' : '') + fmt$(d.margin) : '—'}</td>` +
                       `<td class="report-num"${marginStyle(pct)}>${d.revenue > 0 || d.labor > 0 ? fmtPct(pct) : '—'}</td>` +
                       `<td class="report-num" style="color:#6b7280;font-size:.85em">${revPerChild}</td>` +
                       `<td class="report-num" style="color:#6b7280;font-size:.85em"${d.attendees > 0 ? marginStyle(d.margin / d.attendees) : ''}>${margPerChild}</td>`;
            }).join('');

            // Total-column labor: per-room sum + any unallocated (historical / untagged floats)
            const centerLab = centerLaborByMonth[mo] || 0;
            if (hasScheduleData) {
                // moLab already summed from per-room schedule data
            } else if (hasClockBasedLabor) {
                moLab += centerLab; // add unallocated portion to the total
            } else {
                moLab = centerLab; // center-wide only
            }

            grandRev += moRev;
            grandLab += moLab;
            const moMargin = moRev - moLab;
            const moPct    = moRev > 0 ? (moMargin / moRev) * 100 : 0;

            const labCell  = moLab > 0 ? fmt$(moLab) : '—';
            const src = centerLaborSource?.[mo];
            const labNote = (hasFallbackLabor && centerLab > 0) || src === 'historical_detail'
                ? src === 'historical_detail'
                    ? ' <span title="Allocated from imported per-person payroll records" style="font-size:0.75em;opacity:0.7">†</span>'
                    : src === 'historical'
                        ? ' <span title="From Historical Payroll Records, prorated across months by working days" style="font-size:0.75em;opacity:0.7">📋</span>'
                        : src === 'salary_estimate'
                            ? ' <span title="Salary estimate — no payroll data found for this month" style="font-size:0.75em;opacity:0.7">~est</span>'
                            : ' <span title="From logged staff hours" style="font-size:0.75em;opacity:0.7">*</span>'
                : '';

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
            `<th colspan="6" class="ar-room-header">${r.label}</th>`).join('');
        const roomSubHeaders = rooms.map(() =>
            `<th class="report-num ar-sub-header">Revenue</th>` +
            `<th class="report-num ar-sub-header">Labor</th>` +
            `<th class="report-num ar-sub-header">Margin $</th>` +
            `<th class="report-num ar-sub-header">Margin %</th>` +
            `<th class="report-num ar-sub-header" style="color:#6b7280">Rev/child</th>` +
            `<th class="report-num ar-sub-header" style="color:#6b7280">Margin/child</th>`).join('');

        const totalCells = rooms.map(r => {
            const t   = roomTotals[r.id];
            const pct = t.revenue > 0 ? (t.margin / t.revenue) * 100 : 0;
            const tRevPerChild  = t.attendees > 0 ? fmt$(Math.round(t.revenue / t.attendees)) : '—';
            const tMargPerChild = t.attendees > 0
                ? (t.margin < 0 ? '−' : '') + fmt$(Math.round(Math.abs(t.margin) / t.attendees))
                : '—';
            return `<td class="report-num report-revenue"><strong>${fmt$(t.revenue)}</strong></td>` +
                   `<td class="report-num"><strong>${t.labor > 0 ? fmt$(t.labor) : '—'}</strong></td>` +
                   `<td class="report-num"${marginStyle(t.margin)}><strong>${t.labor > 0 || t.revenue > 0 ? (t.margin < 0 ? '−' : '') + fmt$(t.margin) : '—'}</strong></td>` +
                   `<td class="report-num"${marginStyle(pct)}><strong>${t.revenue > 0 ? fmtPct(pct) : '—'}</strong></td>` +
                   `<td class="report-num" style="color:#6b7280;font-size:.85em"><strong>${tRevPerChild}</strong></td>` +
                   `<td class="report-num" style="color:#6b7280;font-size:.85em"${t.attendees > 0 ? marginStyle(t.margin / t.attendees) : ''}><strong>${tMargPerChild}</strong></td>`;
        }).join('');

        const grandMargin = grandRev - grandLab;
        const grandPct    = grandRev > 0 ? (grandMargin / grandRev) * 100 : 0;

        const sources = Object.values(centerLaborSource || {});
        const hasEstimates = hasFallbackLabor && sources.includes('salary_estimate');
        const hasHistorical = hasFallbackLabor && sources.includes('historical');
        let laborBanner = '';
        if (!hasScheduleData) {
            if (hasClockBasedLabor) {
                const unallocNote = hasFallbackLabor
                    ? ' Untagged float hours and historical payroll records are included in totals only.'
                    : '';
                laborBanner = `<p class="import-warning" style="margin-bottom:8px;background:#e8f5e9;color:#2e7d32;padding:8px 12px;border-radius:4px;border-left:3px solid #4caf50">
                    ℹ️ Labor estimated from clock records — assigned staff costs are direct to their room; salaried overhead is split by attendance.${unallocNote}
                </p>`;
            } else if (hasFallbackLabor) {
                const sourceNote = hasHistorical
                    ? '📋 = from Historical Payroll Records. * = from logged staff hours.' +
                      (hasEstimates ? ' ~est = salary estimate (no data for that month).' : '')
                    : '* = from logged staff hours.' + (hasEstimates ? ' ~est = salary estimate.' : '');
                laborBanner = `<p class="import-warning" style="margin-bottom:8px;background:#fff3e0;color:#e65100;padding:8px 12px;border-radius:4px;border-left:3px solid #ff9800">
                    ⚠️ No saved room schedules — labor totals are center-wide and cannot be broken down by room.
                    ${sourceNote}
                    Save schedules on the Staffing tab to enable per-room allocation.
                </p>`;
            } else {
                laborBanner = `<p class="import-error" style="margin-bottom:8px">
                    ⚠️ No payroll data found for this period — labor shows as $0.
                    Add Historical Payroll Records on the Staffing tab or save staff schedules.
                </p>`;
            }
        }

        container.innerHTML = `
            ${laborBanner}
            <div class="ar-summary-meta">
                <span class="ar-total-badge">$${Math.round(grandRev).toLocaleString('en-US')} revenue</span>
                <span class="ar-discount-badge">$${Math.round(grandLab).toLocaleString('en-US')} labor${hasEstimates ? ' (~est)' : (hasFallbackLabor && !hasClockBasedLabor) ? '*' : ''}</span>
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
                            <td class="report-num ar-total-col"><strong>${fmt$(grandLab)}${hasEstimates ? '~' : (hasFallbackLabor && !hasClockBasedLabor) ? '*' : ''}</strong></td>
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

    const { months, rooms, data, hasScheduleData, centerLaborByMonth, hasFallbackLabor, hasClockBasedLabor } = await _buildRoomPnlData(fromDate, toDate);
    const fmtPct = v => isFinite(v) && v !== 0 ? `${Math.round(v)}%` : '';

    const rows = months.map(mo => {
        const [y, m] = mo.split('-').map(Number);
        const row    = { Month: MONTH_NAMES[m - 1] + ' ' + y };
        rooms.forEach(r => {
            const d   = data[mo]?.[r.id] || { revenue: 0, labor: 0, margin: 0 };
            const pct = d.revenue > 0 ? (d.margin / d.revenue) * 100 : 0;
            row[`${r.label} Revenue`] = d.revenue ? `$${d.revenue.toFixed(2)}` : '';
            row[`${r.label} Labor`]   = d.labor   ? `$${d.labor.toFixed(2)}`   : '';
            row[`${r.label} Margin`]  = d.revenue || d.labor ? `$${d.margin.toFixed(2)}` : '';
            row[`${r.label} Margin%`] = d.revenue || d.labor ? fmtPct(pct) : '';
        });
        const moRev = rooms.reduce((s, r) => s + (data[mo]?.[r.id]?.revenue || 0), 0);
        const moRoomLab = rooms.reduce((s, r) => s + (data[mo]?.[r.id]?.labor || 0), 0);
        const moLab = (hasScheduleData || hasClockBasedLabor)
            ? moRoomLab + (centerLaborByMonth[mo] || 0)
            : (centerLaborByMonth[mo] || 0);
        row['Total Revenue'] = `$${moRev.toFixed(2)}`;
        row['Total Labor']   = moLab ? `$${moLab.toFixed(2)}${(!hasScheduleData && !hasClockBasedLabor && hasFallbackLabor) ? ' (center total)' : ''}` : '';
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
// Families submit a month's schedule by the 15th of the month before it starts,
// with a few days' buffer for late changes/admin cleanup — so a month's numbers
// aren't dependable ("final") until we're 20+ days into the month before it.
// Historical months (from attendance_summary) are always final.
function _isTrendMonthComplete(mo, isHistorical, today) {
    if (isHistorical) return true;
    const [y, m] = mo.split('-').map(Number); // m is 1-based
    return today >= new Date(y, m - 2, 20); // 20th of the month before `mo`
}

// ── Shared "what does this room's weekday pattern look like" resolver ──────
// Single source of truth used by BOTH Enrollment Trends and Waitlist Planning,
// so the two can never show different numbers for the same room/month again:
// a finalized month shows its own real bookings. A month whose registrations
// haven't locked in yet (see _isTrendMonthComplete) shows a forecast rooted in
// the last known real month, carried forward through known graduations (kids
// aging into/out of the room) and known waitlist starts — see
// _projectedWeekdayPattern() in admin-waitlist.js, which owns that domain
// knowledge. A plain statistical blend would ignore facts we already know
// (who's leaving, who's starting), so it isn't used here.

function _isTrendMonthFinal(trendMap, moKey, today) {
    return _isTrendMonthComplete(moKey, !!(trendMap[moKey] || {})._historical, today);
}

// Most recent month in trendMap that's finalized — the real-data anchor that
// projected months are carried forward from.
function _lastFinalTrendMonthKey(trendMap, today) {
    return Object.keys(trendMap).filter(mo => _isTrendMonthFinal(trendMap, mo, today)).sort().pop() || null;
}

function _trendMonthOwnPattern(trendMap, roomId, moKey) {
    const avg = {};
    TREND_DAYS.forEach(day => {
        const c = _trendCell(trendMap[moKey] || {}, roomId, day);
        const count = c.dates.size;
        avg[day] = { half: count ? c.halfSum / count : 0, full: count ? c.fullSum / count : 0, count };
    });
    return avg;
}

/**
 * The single weekday-pattern resolver both reports call: finalized months get
 * their own actual bookings; non-final months get a forecast (see above).
 * @returns {{isFinal: boolean, pattern: Object<string, {half:number, full:number, count:number}>}}
 */
function _weekdayPatternForMonth(trendMap, roomId, moKey, today) {
    const isFinal = _isTrendMonthFinal(trendMap, moKey, today);
    if (isFinal) return { isFinal, pattern: _trendMonthOwnPattern(trendMap, roomId, moKey) };
    return { isFinal, pattern: _projectedWeekdayPattern(trendMap, roomId, moKey, today) };
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

// Format an average value: show one decimal unless it's a whole number, '—' for
// zero. Shared with Waitlist Planning so a booked count reads identically in
// both places — not just the same number, the same formatted string.
function fmtAvg(v) {
    if (!v) return '—';
    return v % 1 === 0 ? String(v) : v.toFixed(1);
}

// "Average day across the month": mean children on a typical operating weekday.
// Averages only over the weekdays that actually had bookings (total > 0) so a
// weekday the center never operates (e.g. an MDO room closed Mondays) doesn't
// drag the figure down. Takes a { Mon:{half,full}, Tue:{...}, ... } map and
// returns { half, full } averaged across operating weekdays.
function _avgOperatingDay(dayVals) {
    const op = TREND_DAYS.filter(d => ((dayVals[d]?.half || 0) + (dayVals[d]?.full || 0)) > 0);
    const n = op.length;
    return {
        half: n ? op.reduce((s, d) => s + (dayVals[d].half || 0), 0) / n : 0,
        full: n ? op.reduce((s, d) => s + (dayVals[d].full || 0), 0) / n : 0,
    };
}

function _renderTrendsTable(trendMap) {
    const months = Object.keys(trendMap).sort();
    if (!months.length) return '<p class="empty-hint">No enrollment data found.</p>';
    const today = new Date();

    // Facility totals accumulate each room's avg-across-months, summed across
    // rooms. Seasonal rooms (Summer Camp) are kept OUT of the year-round center
    // average and broken out on their own row, so a few weeks of camp don't
    // distort the school-year picture. shape: { day: { halfSum, fullSum } }.
    const yearRoundAccum = {};
    TREND_DAYS.forEach(d => { yearRoundAccum[d] = { halfSum: 0, fullSum: 0 }; });
    // seasonalAccums: roomId → { label, accum: { day: { halfSum, fullSum } } }
    const seasonalAccums = {};

    const roomHtml = getSortedRooms().map(room => {
        // Rooms with half-day option show Half | Full | Total per day; full-day-only rooms show just Total
        const showSplit = !room.fullDayOnly;
        // Seasonal rooms (Summer Camp) feed a separate facility row, not the
        // year-round center average.
        const isSeasonal = room.status === 'seasonal';
        let facTarget;
        if (isSeasonal) {
            if (!seasonalAccums[room.id]) {
                seasonalAccums[room.id] = { label: room.label, accum: {} };
                TREND_DAYS.forEach(d => { seasonalAccums[room.id].accum[d] = { halfSum: 0, fullSum: 0 }; });
            }
            facTarget = seasonalAccums[room.id].accum;
        } else {
            facTarget = yearRoundAccum;
        }

        const dayHeaders = TREND_DAYS.map(d =>
            showSplit
                ? `<th colspan="3" style="text-align:center;border-left:2px solid #ddd">Avg ${d}</th>`
                : `<th style="text-align:center;border-left:2px solid #ddd">Avg ${d}</th>`
        ).join('');

        // "Avg Day" = average children on a typical operating weekday that month
        const avgDayHeader = showSplit
            ? `<th colspan="3" style="text-align:center;border-left:2px solid #ddd;background:#eef2ff">Avg Day</th>`
            : `<th style="text-align:center;border-left:2px solid #ddd;background:#eef2ff">Avg Day</th>`;

        const daySubHeaders = showSplit
            ? TREND_DAYS.map(() =>
                `<th style="text-align:right;border-left:2px solid #ddd;font-weight:normal">Half</th>` +
                `<th style="text-align:right;font-weight:normal">Full</th>` +
                `<th style="text-align:right;font-weight:normal">Total</th>`
              ).join('')
            : null;

        const avgDaySubHeaders = showSplit
            ? `<th style="text-align:right;border-left:2px solid #ddd;font-weight:normal;background:#eef2ff">Half</th>` +
              `<th style="text-align:right;font-weight:normal;background:#eef2ff">Full</th>` +
              `<th style="text-align:right;font-weight:normal;background:#eef2ff">Total</th>`
            : null;

        // roomAccum: accumulates monthly averages for this room to compute an "avg across months" row
        const roomAccum = {};
        TREND_DAYS.forEach(d => { roomAccum[d] = { halfSum: 0, fullSum: 0, count: 0 }; });

        const rows = months.map(mo => {
            const [y, m] = mo.split('-').map(Number);
            const label  = MONTH_NAMES[m - 1] + ' ' + y;
            const isHist = trendMap[mo]._historical;
            // Same resolver Waitlist Planning uses, so the two reports can never
            // show different weekday numbers for the same room/month again.
            const { isFinal, pattern } = _weekdayPatternForMonth(trendMap, room.id, mo, today);
            const src = isHist
                ? ' <span style="font-size:.7em;color:#888">(hist)</span>'
                : (!isFinal ? ' <span style="font-size:.7em;color:#888">(in progress)</span>' : '');
            let moHalfTotal = 0, moFullTotal = 0;

            const dayCells = TREND_DAYS.map(d => {
                // Month Total stays a real running count of bookings entered so
                // far, even for an in-progress month whose weekday cells below
                // show a blended projection rather than that partial count.
                const raw = _trendCell(trendMap[mo], room.id, d);
                moHalfTotal += raw.halfSum;
                moFullTotal += raw.fullSum;

                const { half: avgHalf, full: avgFull } = pattern[d];
                if (isFinal && raw.dates.size) {
                    roomAccum[d].halfSum += avgHalf;
                    roomAccum[d].fullSum += avgFull;
                    roomAccum[d].count++;
                }
                return showSplit
                    ? `<td class="report-num" style="border-left:2px solid #ddd">${fmtAvg(avgHalf)}</td>` +
                      `<td class="report-num">${fmtAvg(avgFull)}</td>` +
                      `<td class="report-num">${fmtAvg(avgHalf + avgFull)}</td>`
                    : `<td class="report-num" style="border-left:2px solid #ddd">${fmtAvg(avgHalf + avgFull)}</td>`;
            }).join('');

            // Average day across this month (mean over operating weekdays)
            const moAd = _avgOperatingDay(pattern);
            const avgDayCells = showSplit
                ? `<td class="report-num" style="border-left:2px solid #ddd;background:#f7f9ff">${fmtAvg(moAd.half)}</td>` +
                  `<td class="report-num" style="background:#f7f9ff">${fmtAvg(moAd.full)}</td>` +
                  `<td class="report-num" style="background:#f7f9ff"><strong>${fmtAvg(moAd.half + moAd.full)}</strong></td>`
                : `<td class="report-num" style="border-left:2px solid #ddd;background:#f7f9ff"><strong>${fmtAvg(moAd.half + moAd.full)}</strong></td>`;

            const moTotal = moHalfTotal + moFullTotal;
            if (showSplit) {
                return `<tr>
                    <td class="staff-date-cell">${label}${src}</td>
                    ${dayCells}
                    ${avgDayCells}
                    <td class="report-num" style="border-left:2px solid #ddd">${moHalfTotal || '—'}</td>
                    <td class="report-num">${moFullTotal || '—'}</td>
                    <td class="report-num"><strong>${moTotal || '—'}</strong></td>
                </tr>`;
            }
            return `<tr>
                <td class="staff-date-cell">${label}${src}</td>
                ${dayCells}
                ${avgDayCells}
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
            // Accumulate into facility totals (year-round or seasonal bucket)
            facTarget[d].halfSum += avgH;
            facTarget[d].fullSum += avgF;
            return showSplit
                ? `<td class="report-num" style="border-left:2px solid #ddd;background:#f0f4ff;font-weight:600">${fmtAvg(avgH)}</td>` +
                  `<td class="report-num" style="background:#f0f4ff;font-weight:600">${fmtAvg(avgF)}</td>` +
                  `<td class="report-num" style="background:#f0f4ff;font-weight:600">${fmtAvg(avgH + avgF)}</td>`
                : `<td class="report-num" style="border-left:2px solid #ddd;background:#f0f4ff;font-weight:600">${fmtAvg(avgH + avgF)}</td>`;
        }).join('');

        // Avg-day cell for the "Avg across months" row: mean over operating
        // weekdays of each weekday's cross-month average.
        const roomAvgByDay = {};
        TREND_DAYS.forEach(d => {
            const { halfSum, fullSum, count } = roomAccum[d];
            roomAvgByDay[d] = { half: count ? halfSum / count : 0, full: count ? fullSum / count : 0 };
        });
        const amAd = _avgOperatingDay(roomAvgByDay);
        const avgRowAvgDay = showSplit
            ? `<td class="report-num" style="border-left:2px solid #ddd;background:#dfe6ff;font-weight:700">${fmtAvg(amAd.half)}</td>` +
              `<td class="report-num" style="background:#dfe6ff;font-weight:700">${fmtAvg(amAd.full)}</td>` +
              `<td class="report-num" style="background:#dfe6ff;font-weight:700">${fmtAvg(amAd.half + amAd.full)}</td>`
            : `<td class="report-num" style="border-left:2px solid #ddd;background:#dfe6ff;font-weight:700">${fmtAvg(amAd.half + amAd.full)}</td>`;

        const avgRowTrailer = showSplit
            ? `<td colspan="3" style="border-left:2px solid #ddd;background:#f0f4ff"></td>`
            : `<td style="border-left:2px solid #ddd;background:#f0f4ff"></td>`;

        const avgRow = `<tr style="background:#f0f4ff;border-top:2px solid #c0c8e0">
            <td class="staff-date-cell" style="font-weight:700;font-style:italic">Avg across months</td>
            ${avgCells}
            ${avgRowAvgDay}
            ${avgRowTrailer}
        </tr>`;

        const monthHeader = showSplit ? `<th rowspan="2">Month</th>` : `<th>Month</th>`;
        const monthTotalHeader = showSplit
            ? `<th colspan="2" style="text-align:center;border-left:2px solid #ddd">Month Total</th>` +
              `<th style="border-left:none">All Days</th>`
            : `<th style="text-align:center;border-left:2px solid #ddd">Month Total</th>`;
        const subHeaderRow = showSplit
            ? `<tr>${daySubHeaders}${avgDaySubHeaders}` +
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
                            ${avgDayHeader}
                            ${monthTotalHeader}
                        </tr>
                        ${subHeaderRow}
                    </thead>
                    <tbody>${rows}${avgRow}</tbody>
                </table>
            </div>`;
    }).join('');

    // Facility totals table — sum of all room averages per day of week, with
    // Half/Full/Total split, plus an "Avg Day" (typical operating weekday) column.
    // Summer Camp (seasonal) is broken out onto its own row rather than folded
    // into the year-round center average.
    const facilityDayHeaders = TREND_DAYS.map(d =>
        `<th colspan="3" style="text-align:center;border-left:2px solid #ddd">Avg ${d}</th>`
    ).join('') +
        `<th colspan="3" style="text-align:center;border-left:2px solid #ddd;background:#eef2ff">Avg Day</th>`;

    const facilitySubHeaders = TREND_DAYS.map(() =>
        `<th style="text-align:right;border-left:2px solid #ddd;font-weight:normal">Half</th>` +
        `<th style="text-align:right;font-weight:normal">Full</th>` +
        `<th style="text-align:right;font-weight:normal">Total</th>`
    ).join('') +
        `<th style="text-align:right;border-left:2px solid #ddd;font-weight:normal;background:#eef2ff">Half</th>` +
        `<th style="text-align:right;font-weight:normal;background:#eef2ff">Full</th>` +
        `<th style="text-align:right;font-weight:normal;background:#eef2ff">Total</th>`;

    // Build one row per scope: the year-round center total, then each seasonal
    // room (Summer Camp) that has data. A seasonal room with no bookings in the
    // window is skipped rather than shown as an all-dashes row.
    const seasonalRows = getSortedRooms()
        .filter(r => r.status === 'seasonal' && seasonalAccums[r.id])
        .map(r => ({ label: r.label, accum: seasonalAccums[r.id].accum }))
        .filter(({ accum }) => TREND_DAYS.some(d => (accum[d].halfSum + accum[d].fullSum) > 0));

    const facRows = [
        { label: seasonalRows.length ? 'All Rooms (excl. Summer Camp)' : 'All Rooms', accum: yearRoundAccum },
        ...seasonalRows,
    ];

    const facilityBody = facRows.map(({ label, accum }) => {
        const cells = TREND_DAYS.map(d => {
            const { halfSum, fullSum } = accum[d];
            return `<td class="report-num" style="border-left:2px solid #ddd;font-weight:600">${fmtAvg(halfSum)}</td>` +
                   `<td class="report-num" style="font-weight:600">${fmtAvg(fullSum)}</td>` +
                   `<td class="report-num" style="font-weight:600">${fmtAvg(halfSum + fullSum)}</td>`;
        }).join('');
        const byDay = {};
        TREND_DAYS.forEach(d => { byDay[d] = { half: accum[d].halfSum, full: accum[d].fullSum }; });
        const ad = _avgOperatingDay(byDay);
        const avgDayCell =
            `<td class="report-num" style="border-left:2px solid #ddd;background:#eef2ff;font-weight:700">${fmtAvg(ad.half)}</td>` +
            `<td class="report-num" style="background:#eef2ff;font-weight:700">${fmtAvg(ad.full)}</td>` +
            `<td class="report-num" style="background:#eef2ff;font-weight:700">${fmtAvg(ad.half + ad.full)}</td>`;
        return `<tr><td class="staff-date-cell" style="font-weight:700">${escHtml(label)}</td>${cells}${avgDayCell}</tr>`;
    }).join('');

    const facilityHtml = `
        <h4 style="margin:28px 0 4px;font-size:1em;border-top:2px solid #c0c8e0;padding-top:14px">Facility Total Averages</h4>
        <p style="font-size:.8em;color:#666;margin:0 0 8px">Average children per day of week across all rooms combined (sum of room averages). <strong>Avg Day</strong> = children on a typical operating weekday (averaged over the weekdays that had bookings). Summer Camp is shown separately so its seasonal weeks don't skew the year-round center average.</p>
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
                    ${facilityBody}
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
            `<p style="font-size:.8em;color:#888;margin-top:8px">(hist) = sourced from imported attendance records &nbsp;·&nbsp; (in progress) = this month's registrations aren't final yet (they're locked in on the 15th of the prior month, with a few days' buffer), so it's excluded from "Avg across months" until then</p>`;
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
        const moLabel = MONTH_NAMES[m - 1] + ' ' + y;
        const isHist  = trendMap[mo]._historical;
        getSortedRooms().forEach(room => {
            const row = { Month: moLabel, Room: room.label, Source: isHist ? 'historical' : 'live' };
            let moHalfTotal = 0, moFullTotal = 0;
            const byDay = {};
            TREND_DAYS.forEach(d => {
                const c = _trendCell(trendMap[mo], room.id, d);
                const count = c.dates.size;
                const avgHalf = count ? c.halfSum / count : 0;
                const avgFull = count ? c.fullSum / count : 0;
                byDay[d] = { half: avgHalf, full: avgFull };
                if (room.fullDayOnly) {
                    row[`Avg ${d}`] = +(avgHalf + avgFull).toFixed(2);
                } else {
                    row[`Avg ${d} Half`] = +avgHalf.toFixed(2);
                    row[`Avg ${d} Full`] = +avgFull.toFixed(2);
                    row[`Avg ${d} Total`] = +(avgHalf + avgFull).toFixed(2);
                }
                moHalfTotal += c.halfSum;
                moFullTotal += c.fullSum;
            });
            // Avg Day = children on a typical operating weekday that month
            const ad = _avgOperatingDay(byDay);
            if (room.fullDayOnly) {
                row['Avg Day'] = +(ad.half + ad.full).toFixed(2);
            } else {
                row['Avg Day Half'] = +ad.half.toFixed(2);
                row['Avg Day Full'] = +ad.full.toFixed(2);
                row['Avg Day Total'] = +(ad.half + ad.full).toFixed(2);
            }
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

// ============================================================
// ROOM CAPACITY OVERVIEW  (consolidation pass, design_handoff_planning_market,
// 2026-08-27) — replaces the three separate Enrollment Trends / Total
// Enrollment & FTE / Seat-Day Capacity Model screens with one table: Room ·
// Enrolled · FTE · Seat-days occupied/available · %-full bar · 6-month trend.
//
// Per the handoff: "do not re-derive, call the existing helper each used and
// zip the results by room+month." `_buildTrendMap()`/`_trendMonthOwnPattern()`
// (Enrollment Trends' own helpers, above) are reused as-is for the per-weekday
// drawer. Enrolled/FTE/seat-days reuse the exact same registration
// classification the FTE and Seat-Day reports used (majority day-type per
// registration, bucketed to the earliest care-date month) — but computed from
// ONE fetchAllRegistrations() call instead of three independent ones.
// generateEnrollmentFteReport()/generateSeatDayCapacityReport() themselves are
// left in place (dead code, no AP_TOOLS entry reaches them) rather than
// deleted, per the handoff's instruction to remove only the registry entries.
// ============================================================

// Keyed by idPrefix so the two mount points (see renderCapacityOverviewTool)
// don't clobber each other's rows/open-drawer state.
let _capacityOverviewRows = {};
let _capacityOverviewOpenRoom = {};

function _capacityOverviewByMonth(registrations) {
    const byMonth = {}; // 'YYYY-MM' → [{ room_id, type: 'full'|'half', childDays }]
    registrations.filter(r => r.status === 'confirmed').forEach(reg => {
        const dates = (reg.registration_dates || []).filter(d => !d.waitlisted);
        if (!dates.length) return;
        const moKey  = dates.map(d => d.care_date.slice(0, 7)).sort()[0];
        const fullCt = dates.filter(d => d.day_type === 'full').length;
        const halfCt = dates.filter(d => d.day_type === 'half').length;
        const type   = fullCt >= halfCt ? 'full' : 'half';
        (byMonth[moKey] = byMonth[moKey] || []).push({ room_id: reg.room_id, type, childDays: dates.length });
    });
    return byMonth;
}

// Non-weekend calendar days in a month — same convention as the Seat-Day
// report's own _weekdaysInMonth(), mirrored rather than shared since that
// function is coupled to no other state worth importing for it alone.
function _capacityOverviewWeekdays(year, month1based) {
    let count = 0;
    const d = new Date(year, month1based - 1, 1);
    while (d.getMonth() === month1based - 1) {
        const dow = d.getDay();
        if (dow !== 0 && dow !== 6) count++;
        d.setDate(d.getDate() + 1);
    }
    return count;
}

// `targetMonth` — a Date set to the 1st of the month to show, or omitted for
// the current month. The Enrollment & Capacity tool's FTE/Seat-Day sub-view
// has its own independent month picker (deliberately not shared with the
// Month sub-view's), so this needs to compute against whatever month that
// picker is on, not always "today".
async function _buildCapacityOverviewRows(targetMonth) {
    const allRegs = await fetchAllRegistrations();
    const byMonth = _capacityOverviewByMonth(allRegs);

    const target  = targetMonth instanceof Date ? targetMonth : new Date();
    const curMo   = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
    const priorD  = new Date(target.getFullYear(), target.getMonth() - 6, 1);
    const priorMo = `${priorD.getFullYear()}-${String(priorD.getMonth() + 1).padStart(2, '0')}`;
    const [curY, curM] = curMo.split('-').map(Number);
    const weekdays = _capacityOverviewWeekdays(curY, curM);

    const activeRooms = getSortedRooms().filter(r => r.status !== 'coming_soon');
    return activeRooms.map(room => {
        const curEntries   = (byMonth[curMo]   || []).filter(e => e.room_id === room.id);
        const priorEntries = (byMonth[priorMo] || []).filter(e => e.room_id === room.id);
        const enrolled = curEntries.length;
        const full = curEntries.filter(e => e.type === 'full').length;
        const half = curEntries.filter(e => e.type === 'half').length;
        const fte  = full + half * 0.5;
        const seatDaysOcc   = curEntries.reduce((s, e) => s + e.childDays, 0);
        const seatDaysAvail = weekdays * (room.capacity || 0);
        const pct   = room.capacity ? Math.round((enrolled / room.capacity) * 100) : 0;
        const delta = enrolled - priorEntries.length;
        return { room, curMo, priorMo, enrolled, fte, seatDaysOcc, seatDaysAvail, pct, delta };
    });
}

// `opts.containerId`/`opts.idPrefix` let this mount twice on the same page —
// Classrooms → Planning → Enrollment & Capacity's FTE/Seat-Day sub-view (the
// original mount) and Planning → Room Capacity Overview (added back
// 2026-08-28 to match design_handoff_planning_market's own sidebar, which
// this tool had been retired from in favor of the Classrooms mount alone).
// Both sections exist in the DOM at once (the shell only hides the inactive
// one), so the row/drawer ids below are namespaced by idPrefix — sharing
// `capovDrawer_${roomId}` between two mounted tables would let opening a
// drawer in one silently toggle the other's matching-id row instead.
async function renderCapacityOverviewTool(targetMonth, opts) {
    opts = opts || {};
    const containerId = opts.containerId || 'capacityOverviewContent';
    const idPrefix = opts.idPrefix || 'capov';
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const rows = await _buildCapacityOverviewRows(targetMonth);
        _capacityOverviewRows[idPrefix] = rows;
        _capacityOverviewOpenRoom[idPrefix] = null;
        container.innerHTML = _renderCapacityOverviewTable(rows, idPrefix);
        _wireCapacityOverviewRows(container, idPrefix);
    } catch (err) {
        container.innerHTML = `<p class="import-error">Error loading capacity overview: ${escHtml(err.message)}</p>`;
    }
}

function _renderCapacityOverviewTable(rows, idPrefix) {
    if (!rows.length) return '<p class="empty-hint">No active rooms found.</p>';
    return `
    <div style="overflow-x:auto">
    <table class="report-table">
        <thead><tr>
            <th>Room</th>
            <th class="report-num">Enrolled</th>
            <th class="report-num">FTE</th>
            <th class="report-num">Seat-days occ. / avail.</th>
            <th style="width:200px">% full</th>
            <th class="report-num">6-mo trend</th>
        </tr></thead>
        <tbody>
        ${rows.map(r => {
            const pctColor   = r.pct >= 95 ? 'var(--ap-deep-tang)' : 'var(--navy)';
            const trendLabel = r.delta > 0 ? `▲ +${r.delta}` : r.delta < 0 ? `▼ ${r.delta}` : '— flat';
            const trendColor = r.delta > 0 ? 'var(--green-text)' : r.delta < 0 ? 'var(--ap-deep-tang)' : 'var(--text-muted)';
            return `
            <tr class="capov-row" data-capov-room="${r.room.id}" style="cursor:pointer">
                <td><strong>${escHtml(r.room.label)}</strong></td>
                <td class="report-num">${r.enrolled}</td>
                <td class="report-num">${r.fte % 1 === 0 ? r.fte : r.fte.toFixed(1)}</td>
                <td class="report-num" style="font-size:.9em">${r.seatDaysOcc} / ${r.seatDaysAvail}</td>
                <td>
                    <div style="height:12px;border-radius:99px;background:var(--border);overflow:hidden">
                        <div style="height:100%;width:${Math.min(100, r.pct)}%;border-radius:99px;background:${pctColor}"></div>
                    </div>
                    <div style="font-size:.72em;color:var(--text-muted);margin-top:3px">${r.pct}% full</div>
                </td>
                <td class="report-num" style="font-weight:800;color:${trendColor}">${trendLabel}</td>
            </tr>
            <tr class="capov-drawer-row" id="${idPrefix}Drawer_${r.room.id}" style="display:none"><td colspan="6"></td></tr>`;
        }).join('')}
        </tbody>
    </table>
    </div>
    <p style="font-size:.8em;color:#6b7280;margin:.75rem 0 0">
        One table replacing three screens that computed the same room-fullness from the same data —
        Enrollment Trends, Total Enrollment &amp; FTE, and the Seat-Day Capacity Model.
        Seat-days occupied/available and % full are for the current month; the trend column compares
        against enrollment 6 months ago. Click a room to see the same month broken out by weekday —
        enrollment isn't even across the week.
    </p>`;
}

function _wireCapacityOverviewRows(container, idPrefix) {
    container.querySelectorAll('[data-capov-room]').forEach(row => {
        row.addEventListener('click', () => _toggleCapacityOverviewDrawer(row.dataset.capovRoom, idPrefix));
    });
}

async function _toggleCapacityOverviewDrawer(roomId, idPrefix) {
    const drawerRow = document.getElementById(`${idPrefix}Drawer_${roomId}`);
    if (!drawerRow) return;
    if (_capacityOverviewOpenRoom[idPrefix] === roomId) {
        drawerRow.style.display = 'none';
        _capacityOverviewOpenRoom[idPrefix] = null;
        return;
    }
    if (_capacityOverviewOpenRoom[idPrefix]) {
        const prev = document.getElementById(`${idPrefix}Drawer_${_capacityOverviewOpenRoom[idPrefix]}`);
        if (prev) prev.style.display = 'none';
    }
    _capacityOverviewOpenRoom[idPrefix] = roomId;
    const td = drawerRow.querySelector('td');
    td.innerHTML = '<p class="empty-hint">Loading…</p>';
    drawerRow.style.display = '';
    try {
        const trendMap = await _buildTrendMap();
        const row = _capacityOverviewRows[idPrefix].find(r => r.room.id === roomId);
        const pattern = _trendMonthOwnPattern(trendMap, roomId, row.curMo);
        td.innerHTML = _renderCapacityOverviewDrawer(row, pattern);
    } catch (err) {
        td.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    }
}

function _renderCapacityOverviewDrawer(row, pattern) {
    const cap = row.room.capacity || 0;
    return `
    <div style="border:1px solid var(--border);border-radius:12px;padding:14px 16px;margin:6px 0;background:var(--linen)">
        <div style="font-weight:800;color:var(--navy);margin-bottom:2px">${escHtml(row.room.label)} — by weekday</div>
        <p style="color:var(--text-muted);font-size:.8em;margin:2px 0 12px">Same room, same month — enrollment isn't even across the week.</p>
        <div style="display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:8px">
            ${TREND_DAYS.map(day => {
                const p = pattern[day] || { half: 0, full: 0, count: 0 };
                const total = p.half + p.full;
                const pct = cap ? Math.min(100, Math.round((total / cap) * 100)) : 0;
                const tight = pct >= 95;
                return `<div style="background:${tight ? 'var(--tang-pale)' : '#fff'};border:1px solid ${tight ? 'var(--tang)' : 'var(--border)'};border-radius:9px;padding:8px 4px 9px;text-align:center">
                    <div style="font-size:.68em;font-weight:800;letter-spacing:.05em;text-transform:uppercase;color:var(--text-muted)">${escHtml(day)}</div>
                    <div style="font-family:var(--font-head);font-size:1.15em;font-weight:700;color:var(--navy);margin-top:3px">${pct}%</div>
                    <div style="font-size:.68em;color:var(--text-muted)">${fmtAvg(total)} of ${cap}</div>
                </div>`;
            }).join('')}
        </div>
    </div>`;
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
            const label  = MONTH_NAMES[m - 1] + ' ' + y;
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
    getSortedRooms().forEach(r => {
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
        opt.textContent = MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
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
    const monthLabel = MONTH_NAMES[m - 1] + ' ' + y;
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
// MISSING CARE CALENDAR REPORT
// Shows children with no registration for a given month.
// ============================================================
function setupMissingCalendarReport() {
    const now = new Date();
    const el = document.getElementById('missingCalendarMonth');
    if (el) el.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

    document.getElementById('generateMissingCalendarBtn')?.addEventListener('click', generateMissingCalendarReport);
    document.getElementById('exportMissingCalendarBtn')?.addEventListener('click', exportMissingCalendarReport);
}

let _missingCalendarData = [];

async function generateMissingCalendarReport() {
    const monthVal = document.getElementById('missingCalendarMonth')?.value;
    if (!monthVal) { alert('Please select a month.'); return; }

    const contentEl = document.getElementById('missingCalendarContent');
    const exportBtn = document.getElementById('exportMissingCalendarBtn');
    contentEl.innerHTML = '<p class="empty-hint">Generating…</p>';
    if (exportBtn) exportBtn.style.display = 'none';

    try {
        if (allFamiliesData.length === 0) await loadFamilies();
        if (allRegistrations.length === 0) allRegistrations = await fetchAllRegistrations();

        const [y, m] = monthVal.split('-').map(Number);
        const monthLabel = `${MONTH_NAMES[m - 1]} ${y}`;

        // Build set of child names that have at least one confirmed (non-waitlisted) date in this month
        const registeredChildren = new Set();
        allRegistrations.forEach(reg => {
            const hasDateInMonth = (reg.registration_dates || []).some(d =>
                !d.waitlisted && d.care_date && d.care_date.startsWith(monthVal)
            );
            if (hasDateInMonth) {
                registeredChildren.add((reg.child_name || '').toLowerCase().trim());
            }
        });

        // Collect all active students from active families
        const missing = [];
        const activeFamilies = allFamiliesData.filter(f => f.active !== false);
        activeFamilies.forEach(fam => {
            (fam.students || []).forEach(st => {
                const key = (st.child_name || '').toLowerCase().trim();
                if (!registeredChildren.has(key)) {
                    const room = _resolveRoomForStudent(st);
                    missing.push({
                        childName:   st.child_name,
                        parentName:  fam.parent_name,
                        parentEmail: fam.parent_email,
                        parentPhone: fam.parent_phone,
                        parent2Name: fam.parent2_name || '',
                        parent2Email: fam.parent2_email || '',
                        roomLabel:   room?.label || '—',
                    });
                }
            });
        });

        _missingCalendarData = missing;

        if (!missing.length) {
            contentEl.innerHTML = `<p class="empty-hint">✅ All active children have a care calendar for ${escHtml(monthLabel)}.</p>`;
            return;
        }

        // Sort by room then child name
        missing.sort((a, b) => a.roomLabel.localeCompare(b.roomLabel) || a.childName.localeCompare(b.childName));

        const rows = missing.map(r => `
            <tr>
                <td>${escHtml(r.childName)}</td>
                <td>${escHtml(r.roomLabel)}</td>
                <td>${escHtml(r.parentName)}</td>
                <td><a href="mailto:${escHtml(r.parentEmail)}">${escHtml(r.parentEmail)}</a></td>
                <td>${escHtml(r.parentPhone || '—')}</td>
                <td>${r.parent2Name ? escHtml(r.parent2Name) : '—'}</td>
                <td>${r.parent2Email ? `<a href="mailto:${escHtml(r.parent2Email)}">${escHtml(r.parent2Email)}</a>` : '—'}</td>
            </tr>`).join('');

        contentEl.innerHTML = `
            <p style="margin-bottom:.75rem;font-size:.9em;color:#555">
                <strong>${missing.length}</strong> child${missing.length !== 1 ? 'ren' : ''} without a care calendar for <strong>${escHtml(monthLabel)}</strong>.
            </p>
            <div class="table-wrapper report-table-wrap">
                <table class="report-table" id="missingCalendarTable">
                    <thead>
                        <tr>
                            <th>Child</th>
                            <th>Room</th>
                            <th>Parent / Guardian</th>
                            <th>Email</th>
                            <th>Phone</th>
                            <th>Parent 2</th>
                            <th>Parent 2 Email</th>
                        </tr>
                    </thead>
                    <tbody>${rows}</tbody>
                </table>
            </div>`;

        if (exportBtn) exportBtn.style.display = '';
    } catch (err) {
        contentEl.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    }
}

function _resolveRoomForStudent(student) {
    if (student.room_override) return ROOMS.find(r => r.id === student.room_override) || null;
    const dob = student.child_dob;
    if (!dob) return null;
    const roomId = roomIdForAgeMonths(calcAgeMonths(dob), ROOMS.filter(r => r.status === 'active'));
    return roomId ? (ROOMS.find(r => r.id === roomId) || null) : null;
}

function exportMissingCalendarReport() {
    if (!_missingCalendarData.length) { alert('Generate the report first.'); return; }
    const monthVal  = document.getElementById('missingCalendarMonth')?.value || 'unknown';
    const rows = _missingCalendarData.map(r => ({
        'Child Name':     r.childName,
        'Room':           r.roomLabel,
        'Parent Name':    r.parentName,
        'Email':          r.parentEmail,
        'Phone':          r.parentPhone || '',
        'Parent 2 Name':  r.parent2Name || '',
        'Parent 2 Email': r.parent2Email || '',
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Missing Calendars');
    ws['!cols'] = Object.keys(rows[0]).map(k => ({
        wch: Math.max(k.length, ...rows.map(r => String(r[k] || '').length))
    }));
    XLSX.writeFile(wb, `missing-calendars-${monthVal}.xlsx`);
}

// ── Historical Payroll Import ────────────────────────────────

function setupHistoricalPayroll() {
    loadHistoricalPayrollSection();
}

async function loadHistoricalPayrollSection() {
    const el = document.getElementById('histPayrollContent');
    if (!el) return;
    el.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const records = await fetchHistoricalPayroll();
        renderHistPayrollSection(records);
    } catch (e) {
        el.innerHTML = `<p class="empty-hint" style="color:var(--danger)">Failed to load: ${escHtml(e.message)}</p>`;
    }
}

function renderHistPayrollSection(records) {
    const el = document.getElementById('histPayrollContent');
    if (!el) return;
    if (!records || records.length === 0) {
        el.innerHTML = '<p class="empty-hint">No historical payroll records found.</p>';
        return;
    }
    const rows = records.map((r, idx) => {
        const hasDetail = Array.isArray(r.staff) && r.staff.length > 0;
        const badge = hasDetail
            ? `<span class="hist-payroll-badge detail">Staff detail imported</span>`
            : `<span class="hist-payroll-badge center-wide">Center-wide only</span>`;
        const revertBtn = hasDetail
            ? `<button class="btn-ghost btn-sm" data-hist-revert="${idx}">Revert</button>`
            : '';
        const total = parseFloat(r.total_paid) || 0;
        let staffDetailHtml = '';
        if (hasDetail) {
            const importedTotal = r.staff.reduce((s, p) => s + (parseFloat(p.gross_pay) || 0), 0);
            const staffRows = r.staff.map(p => {
                const gross = `$${parseFloat(p.gross_pay).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
                const status = p.staff_id
                    ? `<span style="color:var(--success,#2a7a2a)">✓ Matched</span>`
                    : `<span style="color:#b07800">~ Float (attendance-weighted)</span>`;
                return `<tr><td>${escHtml(p.name)}</td><td>${status}</td><td style="text-align:right">${gross}</td></tr>`;
            }).join('');
            const importedTotalFmt = `$${importedTotal.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
            staffDetailHtml = `
            <div class="hist-staff-detail" id="hist-detail-${idx}">
                <table class="hist-payroll-preview" style="margin-top:8px">
                    <thead><tr><th>Name</th><th>Status</th><th style="text-align:right">Gross Pay</th></tr></thead>
                    <tbody>${staffRows}</tbody>
                    <tfoot><tr style="font-weight:600"><td colspan="2">Imported total</td><td style="text-align:right">${importedTotalFmt}</td></tr></tfoot>
                </table>
            </div>`;
        }
        return `
        <div class="hist-payroll-row" id="hist-row-${idx}">
            <div class="hist-payroll-header">
                <span class="hist-payroll-label">${escHtml(r.label)}</span>
                <span class="hist-payroll-amount">$${total.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}</span>
                ${badge}
                <div class="hist-payroll-actions">
                    ${hasDetail ? `<button class="btn-ghost btn-sm" data-hist-detail="${idx}">▶ View Wages</button>` : ''}
                    <button class="btn-secondary btn-sm" data-hist-import="${idx}">Import Staff Wages</button>
                    ${revertBtn}
                </div>
            </div>
            ${staffDetailHtml}
            <div class="hist-payroll-import-area" id="hist-import-${idx}">
                <p style="font-size:.82em;color:var(--text-muted);margin:0 0 6px">Paste payroll data from Excel (Ctrl+A → Ctrl+C on the sheet, then paste here). Supports QuickBooks payroll summary or ProCare export — format is auto-detected.</p>
                <textarea id="hist-paste-${idx}" placeholder="QuickBooks: select all cells and paste the full sheet.&#10;ProCare: include the header row (Staff Name, Hours, Rate, Bonus, Gross Pay)."></textarea>
                <div class="hist-import-actions">
                    <button class="btn-secondary btn-sm" data-hist-preview="${idx}">Preview</button>
                    <button class="btn-primary btn-sm hidden" id="hist-confirm-${idx}" data-hist-confirm="${idx}">Confirm &amp; Save</button>
                    <span class="hist-import-status" id="hist-status-${idx}"></span>
                </div>
                <div class="hist-payroll-preview" id="hist-preview-${idx}"></div>
            </div>
        </div>`;
    }).join('');
    el.innerHTML = `<div class="hist-payroll-list">${rows}</div>`;

    el.querySelectorAll('[data-hist-detail]').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.histDetail);
            const detail = document.getElementById(`hist-detail-${idx}`);
            const open = detail.classList.toggle('open');
            btn.textContent = open ? '▼ View Wages' : '▶ View Wages';
        });
    });
    el.querySelectorAll('[data-hist-import]').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.histImport);
            const area = document.getElementById(`hist-import-${idx}`);
            area.classList.toggle('open');
            btn.textContent = area.classList.contains('open') ? 'Cancel' : 'Import Staff Wages';
        });
    });
    el.querySelectorAll('[data-hist-preview]').forEach(btn => {
        btn.addEventListener('click', () => previewHistPayroll(parseInt(btn.dataset.histPreview), records));
    });
    el.querySelectorAll('[data-hist-confirm]').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = parseInt(btn.dataset.histConfirm);
            btn._matchedData && confirmSaveHistPayroll(idx, records, btn._matchedData);
        });
    });
    el.querySelectorAll('[data-hist-revert]').forEach(btn => {
        btn.addEventListener('click', () => revertHistPayroll(parseInt(btn.dataset.histRevert), records));
    });
}

async function previewHistPayroll(idx, records) {
    const statusEl  = document.getElementById(`hist-status-${idx}`);
    const previewEl = document.getElementById(`hist-preview-${idx}`);
    const confirmBtn = document.getElementById(`hist-confirm-${idx}`);
    const pasteText  = document.getElementById(`hist-paste-${idx}`)?.value || '';

    statusEl.textContent = '';
    previewEl.innerHTML  = '';
    confirmBtn.classList.add('hidden');
    confirmBtn._matchedData = null;

    const parsed = parsePayrollPaste(pasteText);
    if (parsed.length === 0) {
        statusEl.textContent = 'No valid rows found. Paste must include a "Staff Name" header row (ProCare) or the full QuickBooks payroll summary.';
        return;
    }

    statusEl.textContent = 'Matching names…';
    let allStaff;
    try {
        allStaff = await fetchAllStaff({ includeInactive: true });
    } catch (e) {
        statusEl.textContent = `Error loading staff: ${e.message}`;
        return;
    }

    const matched = matchStaffNames(parsed, allStaff);
    const matchedCount = matched.filter(m => m.matched).length;
    const floatCount   = matched.filter(m => !m.matched).length;
    statusEl.textContent = `${matched.length} rows — ${matchedCount} matched, ${floatCount} unmatched. Uncheck anyone not in the MDO program before saving.`;

    const tbody = matched.map((m, i) => {
        const cls   = m.matched ? 'match-yes' : 'match-float';
        const gross = `$${parseFloat(m.gross_pay).toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2})}`;
        let nameCell;
        if (m.matched) {
            const room = m.room_id ? escHtml(m.room_id) : 'no room';
            nameCell = `<td><input type="checkbox" class="hist-row-check" data-idx="${i}" checked>
                <span style="color:#065f46;font-weight:600">✓ ${escHtml(m.name)}</span>
                <span style="font-size:.8em;color:var(--text-muted)"> → ${room}</span></td>`;
        } else {
            // Suggestions first, then a divider, then all remaining staff alphabetically
            const suggestedIds = new Set(m.suggestions.map(s => s.id));
            const suggestOpts = m.suggestions.map(s =>
                `<option value="${s.id}" data-room="${s.room_id || ''}" data-pay="${s.pay_type || ''}">${escHtml(s.name)}${s.room_id ? ` (${escHtml(s.room_id)})` : ''}</option>`
            ).join('');
            const otherOpts = allStaff
                .filter(s => !suggestedIds.has(s.id))
                .sort((a, b) => a.name.localeCompare(b.name))
                .map(s =>
                    `<option value="${s.id}" data-room="${s.room_id || ''}" data-pay="${s.pay_type || ''}">${escHtml(s.name)}${s.room_id ? ` (${escHtml(s.room_id)})` : ''}</option>`
                ).join('');
            const divider = suggestOpts && otherOpts ? `<option disabled>──────────</option>` : '';
            nameCell = `<td><input type="checkbox" class="hist-row-check" data-idx="${i}" checked>
                <span style="color:#92400e;font-weight:600">~ ${escHtml(m.name)}</span>
                <select class="hist-name-override" data-idx="${i}" style="font-size:.8em;margin-left:6px;max-width:200px">
                    <option value="">Float (unmatched)</option>
                    ${suggestOpts}${divider}${otherOpts}
                </select></td>`;
        }
        return `<tr class="${cls}" data-row-idx="${i}">
            ${nameCell}
            <td style="text-align:right">${gross}</td>
        </tr>`;
    }).join('');

    const periodTotal = parseFloat(records[idx]?.total_paid) || 0;
    const fmt$ = n => '$' + n.toLocaleString('en-US', {minimumFractionDigits:2, maximumFractionDigits:2});

    previewEl.innerHTML = `<table style="width:100%;border-collapse:collapse">
        <thead><tr><th>Name / Match</th><th style="text-align:right">Gross Pay</th></tr></thead>
        <tbody>${tbody}</tbody>
    </table>
    <div id="hist-running-${idx}" style="margin-top:10px;padding:8px 10px;background:#f0fdf4;border:1px solid #bbf7d0;border-radius:6px;font-size:.85em;display:flex;gap:16px;flex-wrap:wrap">
        <span>Selected total: <strong id="hist-sel-total-${idx}">—</strong></span>
        <span style="color:var(--text-muted)">Period total on file: <strong>${fmt$(periodTotal)}</strong></span>
        <span id="hist-diff-${idx}" style="font-weight:600"></span>
    </div>
    <p style="font-size:.78em;color:var(--text-muted);margin:6px 0 0">Unmatched names (orange ~) have a suggestion dropdown — pick the correct staff member or leave as "Float". Uncheck anyone not in the MDO program.</p>`;

    // Wire up running total
    const updateTotal = () => {
        let sum = 0;
        previewEl.querySelectorAll('.hist-row-check:checked').forEach(cb => {
            const i = parseInt(cb.dataset.idx);
            sum += parseFloat(matched[i]?.gross_pay) || 0;
        });
        const selEl  = document.getElementById(`hist-sel-total-${idx}`);
        const diffEl = document.getElementById(`hist-diff-${idx}`);
        if (selEl) selEl.textContent = fmt$(sum);
        if (diffEl) {
            const diff = sum - periodTotal;
            const absDiff = Math.abs(diff);
            if (absDiff < 0.05) {
                diffEl.textContent = '✓ Matches period total';
                diffEl.style.color = '#065f46';
            } else {
                diffEl.textContent = `${diff > 0 ? '+' : '−'}${fmt$(absDiff)} vs period total`;
                diffEl.style.color = '#92400e';
            }
        }
    };
    previewEl.querySelectorAll('.hist-row-check').forEach(cb => cb.addEventListener('change', updateTotal));
    updateTotal();

    confirmBtn.classList.remove('hidden');
    confirmBtn._matchedData = matched;
    confirmBtn._previewEl   = previewEl;
}

async function confirmSaveHistPayroll(idx, records, matched) {
    const statusEl  = document.getElementById(`hist-status-${idx}`);
    const confirmBtn = document.getElementById(`hist-confirm-${idx}`);

    // Read which rows are checked
    const previewEl = confirmBtn._previewEl || document.getElementById(`hist-preview-${idx}`);
    const checkedIdxs = new Set(
        [...(previewEl?.querySelectorAll('.hist-row-check:checked') || [])].map(c => parseInt(c.dataset.idx))
    );
    const filteredMatched = matched.filter((_, i) => checkedIdxs.size === 0 || checkedIdxs.has(i));

    if (filteredMatched.length === 0) {
        statusEl.textContent = 'No rows selected — nothing to save.';
        return;
    }

    statusEl.textContent = 'Saving…';
    confirmBtn.disabled  = true;

    // Read any manual overrides from the suggestion dropdowns
    const overrides = {};
    previewEl?.querySelectorAll('.hist-name-override').forEach(sel => {
        const rowIdx = parseInt(sel.dataset.idx);
        if (sel.value) {
            overrides[rowIdx] = {
                staff_id: parseInt(sel.value),
                room_id:  sel.selectedOptions[0]?.dataset.room || null,
                pay_type: sel.selectedOptions[0]?.dataset.pay  || null,
            };
        }
    });

    const updated = records.map((r, i) => {
        if (i !== idx) return r;
        const staffArr = filteredMatched.map(m => {
            const ov = overrides[matched.indexOf(m)];
            return {
                name:      m.name,
                staff_id:  ov?.staff_id ?? m.staff_id ?? null,
                gross_pay: parseFloat(m.gross_pay),
            };
        });
        return { ...r, staff: staffArr };
    });

    try {
        await saveHistoricalPayroll(updated);
        statusEl.textContent = 'Saved.';
        setTimeout(() => loadHistoricalPayrollSection(), 600);
    } catch (e) {
        statusEl.textContent = `Error: ${e.message}`;
        confirmBtn.disabled = false;
    }
}

async function revertHistPayroll(idx, records) {
    const r = records[idx];
    if (!confirm(`Remove per-person staff data for "${r.label}"?\n\nThe lump-sum total ($${r.total_paid}) will be kept. The P&L will revert to center-wide allocation for this period.`)) return;

    const updated = records.map((rec, i) => {
        if (i !== idx) return rec;
        const { staff: _removed, ...rest } = rec;
        return rest;
    });

    try {
        await saveHistoricalPayroll(updated);
        loadHistoricalPayrollSection();
    } catch (e) {
        alert(`Error reverting: ${e.message}`);
    }
}

function parsePayrollPaste(text) {
    // QuickBooks pivot format: employees are columns, "Gross pay - total" is a row
    if (/gross\s*pay\s*-\s*total/i.test(text)) {
        return _parseQBOPayrollPaste(text);
    }
    // Row-per-employee format: ProCare ("Staff Name" column) or QBO Payroll Summary ("Name" + "Gross pay" columns)
    const lines = text.split(/\r?\n/).map(l => l.split('\t'));
    let headerIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        const row = lines[i];
        const hasStaffName   = row.some(c => /staff\s*name/i.test(c));
        const hasNameAndGross = row.some(c => /^name$/i.test(c.trim())) && row.some(c => /gross\s*pay/i.test(c.trim()));
        if (hasStaffName || hasNameAndGross) { headerIdx = i; break; }
    }
    if (headerIdx < 0) return [];

    const header  = lines[headerIdx].map(c => c.trim().toLowerCase());
    const nameCol  = header.findIndex(c => /staff\s*name/i.test(c) || /^name$/i.test(c));
    const hrsCol   = header.findIndex(c => /^hours$/i.test(c));
    const grossCol = header.findIndex(c => /gross\s*pay/i.test(c));
    if (nameCol < 0 || grossCol < 0) return [];

    const results = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const cols = lines[i];
        const name = (cols[nameCol] || '').trim();
        if (!name) continue;
        if (/MDO\s*TOTAL/i.test(name) || /^total$/i.test(name)) break;
        if (/blank\s*space/i.test(name)) continue;
        const hrsRaw = hrsCol >= 0 ? (cols[hrsCol] || '').trim() : '';
        if (/salary/i.test(hrsRaw)) continue;
        const grossRaw = (cols[grossCol] || '').replace(/[$,]/g, '').trim();
        const gross = parseFloat(grossRaw);
        if (isNaN(gross) || gross <= 0) continue;
        results.push({ name, gross_pay: gross });
    }
    return results;
}

function _parseQBOPayrollPaste(text) {
    const lines = text.split(/\r?\n/).map(l => l.split('\t'));
    // Find the header row: first cell is "Item"
    const headerIdx = lines.findIndex(l => /^item$/i.test((l[0] || '').trim()));
    if (headerIdx < 0) return [];
    // Employee names start at column 2 (skip "Item" and "Total")
    const names = lines[headerIdx].slice(2).map(n => n.trim().replace(/^\*/, ''));
    // Find the "Gross pay - total" row
    const grossRow = lines.find(l => /gross\s*pay\s*-\s*total/i.test((l[0] || '').trim()));
    if (!grossRow) return [];
    const values = grossRow.slice(2);
    const results = [];
    names.forEach((name, i) => {
        if (!name) return;
        const gross = parseFloat((values[i] || '').replace(/[$,]/g, ''));
        if (isNaN(gross) || gross <= 0) return;
        results.push({ name, gross_pay: gross });
    });
    return results;
}

function matchStaffNames(rows, allStaff) {
    const normalize = s => s.toLowerCase().trim().replace(/,/g, ' ').replace(/\s*\(.*?\)\s*/g, '').replace(/\s+/g, ' ').trim();
    const staffNorm = allStaff.map(s => ({ ...s, _norm: normalize(s.name) }));

    // Try "Last First M" → "First Last" reversal for QuickBooks names
    const tryReverse = name => {
        const parts = name.trim().split(/\s+/);
        if (parts.length < 2) return null;
        return normalize(`${parts[1]} ${parts[0]}`);
    };

    // Score staff candidates by shared word tokens (for suggestions on unmatched rows)
    const scoreSuggestions = (name, topN = 4) => {
        const tokens = normalize(name).split(' ').filter(Boolean);
        const revTokens = (tryReverse(name) || '').split(' ').filter(Boolean);
        const allTokens = [...new Set([...tokens, ...revTokens])];
        return staffNorm
            .map(s => {
                const sTokens = s._norm.split(' ');
                const shared = allTokens.filter(t => sTokens.some(st => st.startsWith(t) || t.startsWith(st))).length;
                return { ...s, score: shared };
            })
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, topN);
    };

    return rows.map(row => {
        const norm  = normalize(row.name);
        let match   = staffNorm.find(s => s._norm === norm);
        if (!match) {
            const reversed = tryReverse(row.name);
            if (reversed) match = staffNorm.find(s => s._norm === reversed);
        }
        const suggestions = match ? [] : scoreSuggestions(row.name);
        return {
            name:        row.name,
            gross_pay:   row.gross_pay,
            matched:     !!match,
            staff_id:    match?.id      || null,
            room_id:     match?.room_id || null,
            pay_type:    match?.pay_type || null,
            suggestions,
        };
    });
}

// ============================================================

// KIDS DISCOUNT PRICING REPORT
// ============================================================

let _discountPricingRows = [];

async function generateDiscountPricingReport() {
    const monthVal = document.getElementById('discountPricingMonth')?.value;
    if (!monthVal) { alert('Please select a month.'); return; }

    const el = document.getElementById('discountPricingContent');
    el.innerHTML = '<p class="empty-hint">Loading…</p>';
    document.getElementById('exportDiscountPricingBtn').style.display = 'none';
    document.getElementById('printDiscountPricingBtn').style.display = 'none';

    if (allFamiliesData.length === 0) await loadFamilies();
    if (!allRegistrations.length) allRegistrations = await fetchAllRegistrations();

    const dmap = getDiscountMap();

    _discountPricingRows = [];
    allRegistrations.forEach(reg => {
        if (reg.status === 'cancelled') return;
        const dates = (reg.registration_dates || []).filter(d =>
            !d.waitlisted && d.care_date && d.care_date.startsWith(monthVal));
        if (!dates.length) return;

        const key  = `${(reg.parent_email || '').toLowerCase()}:${(reg.child_name || '').toLowerCase()}`;
        const disc = dmap.get(key);
        if (!disc || disc.type === 'none') return;

        const room     = ROOMS.find(r => r.id === reg.room_id);
        const fullRate = room?.fullDayRate || 0;
        const halfRate = room?.halfDayRate || room?.fullDayRate || 0;
        const effFull  = effectiveAdminRate(fullRate, disc.type, disc.value);
        const effHalf  = effectiveAdminRate(halfRate, disc.type, disc.value);
        const fullDays = dates.filter(d => d.day_type === 'full').length;
        const halfDays = dates.filter(d => d.day_type === 'half').length;
        const listPrice = fullDays * fullRate + halfDays * halfRate;
        const amtDue    = fullDays * effFull  + halfDays * effHalf;

        _discountPricingRows.push({
            childName:  reg.child_name,
            parentName: reg.parent_name,
            parentEmail: reg.parent_email,
            roomId:     reg.room_id,
            roomLabel:  room?.label || reg.room_id,
            discType:   disc.type,
            discValue:  disc.value,
            fullDays,
            halfDays,
            totalDays:  fullDays + halfDays,
            listPrice,
            amtDue,
            saved: listPrice - amtDue,
        });
    });

    _discountPricingRows.sort((a, b) => {
        if (a.discType !== b.discType) return a.discType === 'staff' ? -1 : 1;
        return a.childName.localeCompare(b.childName);
    });

    if (_discountPricingRows.length === 0) {
        el.innerHTML = '<p class="empty-hint">No children with discounts found for this month.</p>';
        return;
    }

    const [y, m]     = monthVal.split('-').map(Number);
    const monthLabel = MONTH_NAMES[m - 1] + ' ' + y;
    const fmt        = v => '$' + v.toFixed(2);

    const staffRows  = _discountPricingRows.filter(r => r.discType === 'staff');
    const otherRows  = _discountPricingRows.filter(r => r.discType !== 'staff');

    const subtotal = rows => ({
        fullDays:     rows.reduce((s,r)=>s+r.fullDays,0),
        halfDays:     rows.reduce((s,r)=>s+r.halfDays,0),
        totalDays:    rows.reduce((s,r)=>s+r.totalDays,0),
        listPrice:    rows.reduce((s,r)=>s+r.listPrice,0),
        costToCenter: rows.reduce((s,r)=>s+r.saved,0),
    });

    const renderRows = rows => rows.map(r => {
        const discLabel = r.discType === 'staff' ? 'Staff (100% off)' : `${r.discValue}% off`;
        return `<tr>
  <td>${escHtml(r.childName)}</td>
  <td>${escHtml(r.parentName || '')}</td>
  <td>${escHtml(r.roomLabel)}</td>
  <td><span class="${r.discType === 'staff' ? 'badge-confirmed' : 'family-badge-discount'}">${escHtml(discLabel)}</span></td>
  <td class="report-num">${r.fullDays}</td>
  <td class="report-num">${r.halfDays}</td>
  <td class="report-num">${r.totalDays}</td>
  <td class="report-num">${fmt(r.listPrice)}</td>
  <td class="report-num" style="color:#c0392b;">${fmt(r.saved)}</td>
</tr>`;
    }).join('');

    const renderSubtotal = (label, rows) => {
        if (!rows.length) return '';
        const t = subtotal(rows);
        return `<tr style="font-weight:700;background:#e8f0f8;">
  <td colspan="4">${escHtml(label)} subtotal (${rows.length} child${rows.length !== 1 ? 'ren' : ''})</td>
  <td class="report-num">${t.fullDays}</td>
  <td class="report-num">${t.halfDays}</td>
  <td class="report-num">${t.totalDays}</td>
  <td class="report-num">${fmt(t.listPrice)}</td>
  <td class="report-num" style="color:#c0392b;">${fmt(t.costToCenter)}</td>
</tr>`;
    };

    const grand = subtotal(_discountPricingRows);

    let html = `<p style="margin:0 0 10px;font-size:13px;color:#555;">${escHtml(monthLabel)} &mdash; ${_discountPricingRows.length} children with discounts</p>`;
    html += `<table class="admin-table" id="discountPricingTable"><thead><tr>
  <th>Child</th><th>Parent</th><th>Room</th><th>Discount</th>
  <th class="report-num">Full Days</th><th class="report-num">Half Days</th><th class="report-num">Total Days</th>
  <th class="report-num">List Price</th><th class="report-num">Cost to Center</th>
</tr></thead><tbody>`;

    if (staffRows.length) {
        html += `<tr><td colspan="9" style="background:#f5f5f5;font-weight:700;font-size:11px;letter-spacing:.04em;padding:6px 10px;color:#555;">STAFF</td></tr>`;
        html += renderRows(staffRows);
        html += renderSubtotal('Staff', staffRows);
    }
    if (otherRows.length) {
        html += `<tr><td colspan="9" style="background:#f5f5f5;font-weight:700;font-size:11px;letter-spacing:.04em;padding:6px 10px;color:#555;">OTHER DISCOUNTS</td></tr>`;
        html += renderRows(otherRows);
        html += renderSubtotal('Other discounts', otherRows);
    }

    html += `</tbody><tfoot><tr style="font-weight:700;background:#f0ebe0;">
  <td colspan="4">Grand Total</td>
  <td class="report-num">${grand.fullDays}</td>
  <td class="report-num">${grand.halfDays}</td>
  <td class="report-num">${grand.totalDays}</td>
  <td class="report-num">${fmt(grand.listPrice)}</td>
  <td class="report-num" style="color:#c0392b;">${fmt(grand.costToCenter)}</td>
</tr></tfoot></table>`;

    el.innerHTML = html;
    document.getElementById('exportDiscountPricingBtn').style.display = '';
    document.getElementById('printDiscountPricingBtn').style.display = '';
}

function exportDiscountPricingReport() {
    if (!_discountPricingRows.length) return;
    const monthVal   = document.getElementById('discountPricingMonth')?.value || '';
    const [y, m]     = monthVal.split('-').map(Number);
    const monthLabel = m ? (MONTH_NAMES[m - 1] + ' ' + y) : monthVal;
    const headers = ['Child', 'Parent', 'Email', 'Room', 'Discount Type', 'Discount %', 'Full Days', 'Half Days', 'Total Days', 'List Price', 'Cost to Center'];
    const rows = _discountPricingRows.map(r => [
        r.childName, r.parentName || '', r.parentEmail || '', r.roomLabel,
        r.discType === 'staff' ? 'Staff' : 'Custom',
        r.discType === 'staff' ? 100 : (r.discValue || 0),
        r.fullDays, r.halfDays, r.totalDays, r.listPrice, r.saved,
    ]);
    const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, monthLabel.substring(0, 31));
    XLSX.writeFile(wb, `discount-pricing-${monthVal}.xlsx`);
}

function printDiscountPricingReport() {
    const monthVal = document.getElementById('discountPricingMonth')?.value || '';
    const table    = document.getElementById('discountPricingTable');
    if (!table || !_discountPricingRows.length) return;
    const [y, m]     = monthVal.split('-').map(Number);
    const monthLabel = m ? (MONTH_NAMES[m - 1] + ' ' + y) : monthVal;
    const win = window.open('', '_blank');
    win.document.write(`<!DOCTYPE html><html><head><meta charset="utf-8">
<title>Discount Pricing — ${escHtml(monthLabel)}</title>
<style>
  body { font-family: Arial, sans-serif; font-size: 12px; color: #000; margin: 24px; }
  h1 { font-size: 16px; margin: 0 0 2px; }
  p.subtitle { font-size: 10px; color: #666; margin: 0 0 16px; }
  table { width: 100%; border-collapse: collapse; }
  th { background: #1e3a5f; color: #fff; padding: 5px 8px; text-align: left; font-size: 11px; }
  th:nth-child(n+5) { text-align: right; }
  td { padding: 4px 8px; font-size: 11px; border-bottom: 1px solid #e8e8e8; }
  td.report-num { text-align: right; }
  tfoot tr td { font-weight: 700; background: #f0ebe0; border-top: 2px solid #bbb; }
  @media print { body { margin: 12px; } }
</style></head><body>
<h1>Kids Discount Pricing — ${escHtml(monthLabel)}</h1>
<p class="subtitle">Printed ${new Date().toLocaleDateString('en-US',{month:'short',day:'numeric',year:'numeric'})}</p>
${table.outerHTML}
</body></html>`);
    win.document.close();
    win.focus();
    win.print();
}
