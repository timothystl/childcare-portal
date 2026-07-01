// ============================================================
// MODULE: Admin Billing (AR, CSV Import, Dashboard)
// Sub-tabs: AR | CSV Import | Dashboard
// ============================================================

// ============================================================
// STATE
// ============================================================
let _billingCharts = {};
let _arData = [];
let _csvParsedRows = [];         // raw rows from uploaded CSV
let _csvHeaders = [];
let _arLoaded = false;
let _blDashLoaded = false;
let _paymentModalContext = {};   // {familyId, invoiceId, familyName, finalAmount}
let _lockModalContext = {};      // {familyId, familyName, isLocking}
let _blArMonth = '';               // selected AR month (YYYY-MM)

// ============================================================
// ENTRY POINT
// ============================================================
function setupBilling() {
    // AR month selector — default to current month, reload on change
    const arMonthSel = document.getElementById('arMonthSelect');
    if (arMonthSel) {
        const now = new Date();
        arMonthSel.value = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        arMonthSel.addEventListener('change', () => { _arLoaded = false; loadArView(); });
    }

    // Payments tab
    const csvInput = document.getElementById('paymentCsvInput');
    csvInput?.addEventListener('change', e => {
        const file = e.target.files[0];
        if (file) onPaymentCsvChange(file);
    });
    document.getElementById('clearPaymentCsvBtn')
        ?.addEventListener('click', () => {
            const inp = document.getElementById('paymentCsvInput');
            if (inp) inp.value = '';
            const nameEl = document.getElementById('paymentCsvFileName');
            if (nameEl) nameEl.textContent = 'No file chosen';
            _csvParsedRows = [];
            _csvHeaders = [];
            const wrap = document.getElementById('paymentImportWrap');
            if (wrap) wrap.innerHTML = '';
        });

    // AR tab
    document.getElementById('arStatusFilter')
        ?.addEventListener('change', () => renderArTable(_arData));
    document.getElementById('lockAllOverdueBtn')
        ?.addEventListener('click', lockAllOverdue);
    document.getElementById('refreshArBtn')
        ?.addEventListener('click', () => { _arLoaded = false; loadArView(); });
    document.getElementById('backfillInvoicesBtn')
        ?.addEventListener('click', backfillAllInvoices);
    document.getElementById('exportArCsvBtn')
        ?.addEventListener('click', exportArCsv);

    // AR lock modal
    document.getElementById('blmConfirmBtn')
        ?.addEventListener('click', _doLockModalConfirm);
    document.getElementById('blmCancelBtn')
        ?.addEventListener('click', () => document.getElementById('billingLockModal')?.classList.add('hidden'));
    document.getElementById('blmCloseBtn')
        ?.addEventListener('click', () => document.getElementById('billingLockModal')?.classList.add('hidden'));

    // Payment modal
    document.getElementById('bpmSaveBtn')
        ?.addEventListener('click', savePaymentFromModal);
    document.getElementById('bpmCancelBtn')
        ?.addEventListener('click', () => document.getElementById('billingPaymentModal')?.classList.add('hidden'));
    document.getElementById('bpmCloseBtn')
        ?.addEventListener('click', () => document.getElementById('billingPaymentModal')?.classList.add('hidden'));

    // Import map modal
    document.getElementById('bimPreviewBtn')
        ?.addEventListener('click', _doImportPreview);
    document.getElementById('bimCancelBtn')
        ?.addEventListener('click', () => document.getElementById('billingImportMapModal')?.classList.add('hidden'));
    document.getElementById('bimCloseBtn')
        ?.addEventListener('click', () => document.getElementById('billingImportMapModal')?.classList.add('hidden'));

    // Dashboard tab
    setupBillingDashYear();
    document.getElementById('generateBlDashBtn')
        ?.addEventListener('click', generateBillingDashboard);
    document.getElementById('exportBlDashBtn')
        ?.addEventListener('click', exportBlDashCsv);

    // Sub-tab visual state is set by HTML defaults (invoices pane has no hidden class).
    // Data loads lazily when the user first opens the billing main tab (see setupTabs).
}


// ============================================================
// INVOICES SUB-TAB (legacy — kept for dashboard data only)
// ============================================================
async function loadBillingCycles() {
    const sel = document.getElementById('invoiceCycleSelect');
    if (sel) sel.innerHTML = '<option value="">— Select cycle —</option>';

    const previewWrap = document.getElementById('invoicePreviewWrap');
    if (previewWrap) previewWrap.innerHTML = '';

    _setInvoiceBtns(false, false);

    try {
        _billingCycles = await fetchBillingCycles();
        if (sel) {
            _billingCycles.forEach(c => {
                const opt = document.createElement('option');
                opt.value       = c.id;
                opt.textContent = `${c.month}  [${c.status || 'open'}]`;
                sel.appendChild(opt);
            });
        }
        _cyclesLoaded = true;

        // Auto-select first cycle if available
        if (_billingCycles.length && sel) {
            sel.value = _billingCycles[0].id;
            onCycleSelect();
        }
    } catch (err) {
        alert('Failed to load billing cycles: ' + err.message);
    }
}

function onCycleSelect() {
    const sel = document.getElementById('invoiceCycleSelect');
    const cycleId = sel?.value || '';
    _currentCycleId = cycleId || null;

    const previewWrap = document.getElementById('invoicePreviewWrap');
    if (previewWrap) previewWrap.innerHTML = '';

    if (!cycleId) {
        _setInvoiceBtns(false, false);
        return;
    }

    const cycle = _billingCycles.find(c => String(c.id) === String(cycleId));
    if (!cycle) { _setInvoiceBtns(false, false); return; }

    const isOpen   = (cycle.status || 'open') === 'open';
    const isClosed = (cycle.status || 'open') === 'closed';

    _setInvoiceBtns(isOpen, false);
    if (!isOpen) {
        // Load existing invoices for closed cycle
        _loadAndRenderInvoices(cycleId);
    }
}

function _setInvoiceBtns(generateEnabled, finalizeEnabled) {
    const genBtn = document.getElementById('generateInvoicesBtn');
    const finBtn = document.getElementById('finalizeCycleBtn');
    if (genBtn) genBtn.disabled = !generateEnabled;
    if (finBtn) finBtn.disabled = !finalizeEnabled;
}

async function createBillingCycle() {
    const monthInput = document.getElementById('newCycleMonth');
    const month = monthInput?.value?.trim();
    if (!month || !/^\d{4}-\d{2}$/.test(month)) {
        alert('Please enter a valid month in YYYY-MM format.');
        return;
    }

    // Check for duplicate
    const existing = _billingCycles.find(c => c.month === month);
    if (existing) {
        alert(`A billing cycle for ${month} already exists.`);
        return;
    }

    const btn = document.getElementById('createCycleBtn');
    if (btn) btn.disabled = true;

    try {
        const row = await insertBillingCycle(month);
        await logAdminAction('create_billing_cycle', 'billing_cycle', row.id, { month });
        _cyclesLoaded = false;
        await loadBillingCycles();
        // Select the newly created cycle
        const sel = document.getElementById('invoiceCycleSelect');
        if (sel && row.id) {
            sel.value = row.id;
            onCycleSelect();
        }
        if (monthInput) monthInput.value = '';
    } catch (err) {
        alert('Failed to create billing cycle: ' + err.message);
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function generateDraftInvoices(cycleId) {
    const cycle = _billingCycles.find(c => c.id === cycleId);
    const monthVal = cycle ? cycle.month : null;
    if (!monthVal) {
        alert('Cannot determine month for this billing cycle.');
        return;
    }

    const previewWrap = document.getElementById('invoicePreviewWrap');
    if (previewWrap) previewWrap.innerHTML = '<p class="empty-hint">Generating invoices…</p>';

    const genBtn = document.getElementById('generateInvoicesBtn');
    if (genBtn) genBtn.disabled = true;

    try {
        // allFamiliesData is lazy-loaded when the Families tab opens; fetch here if not yet loaded
        const families = (allFamiliesData && allFamiliesData.length > 0)
            ? allFamiliesData
            : await fetchAllFamilies({ includeArchived: false });

        // Load billing overrides for this month (from existing billing_overrides table)
        const overrideRows = await fetchBillingOverrides(monthVal);
        const overridesMap = new Map();
        overrideRows.forEach(row => {
            const key = `${(row.parent_email || '').toLowerCase()}:${(row.child_name || '').toLowerCase()}`;
            overridesMap.set(key, parseFloat(row.override_amount || 0));
        });

        // Use existing billing calculation
        const familyBillingResults = _buildFamilyBillingData(monthVal, overridesMap);

        const invoices = [];
        let skippedCnt = 0;

        for (const result of familyBillingResults) {
            // Find matching family record for the UUID
            const fam = families.find(f =>
                (f.parent_email || '').toLowerCase() === (result.parentEmail || '').toLowerCase() ||
                (f.parent2_email || '').toLowerCase() === (result.parentEmail || '').toLowerCase()
            );
            if (!fam) { skippedCnt++; continue; }

            // Compute totals from children
            let baseAmount = 0;
            let discountAmount = 0;
            let finalAmount = 0;

            (result.children || []).forEach(child => {
                const childBase = (child.subtotal || 0) + (child.changeFees || 0) + (child.discountDollar || 0) + (child.sibDiscount || 0);
                const childDisc = (child.discountDollar || 0) + (child.sibDiscount || 0);
                const childFinal = child.hasOverride
                    ? parseFloat(child.overrideAmount || 0)
                    : (child.subtotal || 0) + (child.changeFees || 0);
                baseAmount    += childBase;
                discountAmount += childDisc;
                finalAmount   += childFinal;
            });

            baseAmount     = Math.round(baseAmount * 100) / 100;
            discountAmount = Math.round(discountAmount * 100) / 100;
            finalAmount    = Math.round(Math.max(0, finalAmount) * 100) / 100;

            const row = await upsertBillingInvoice({
                cycle_id:         cycleId,
                family_id:        fam.id,
                base_amount:      baseAmount,
                discount_amount:  discountAmount,
                adjustment_amount: 0,
                adjustment_note:  '',
                final_amount:     finalAmount,
                status:           'draft',
            });

            invoices.push({
                ...row,
                parent_name:  result.parentName,
                parent_email: result.parentEmail,
            });
        }

        _setInvoiceBtns(true, invoices.length > 0);
        renderInvoicePreview(invoices);

        if (skippedCnt > 0) {
            const hint = document.createElement('p');
            hint.className = 'empty-hint';
            hint.style.marginTop = '8px';
            hint.textContent = `${skippedCnt} ${skippedCnt === 1 ? 'family was' : 'families were'} skipped (no registrations found for this month or no family record match).`;
            previewWrap?.appendChild(hint);
        }

        await logAdminAction('generate_invoices', 'billing_cycle', cycleId, {
            month: monthVal,
            count: invoices.length,
            skipped: skippedCnt,
        });
    } catch (err) {
        if (previewWrap) previewWrap.innerHTML = `<p class="empty-hint">Error: ${escHtml(err.message)}</p>`;
        alert('Failed to generate invoices: ' + err.message);
        _setInvoiceBtns(true, false);
    } finally {
        if (genBtn) genBtn.disabled = false;
    }
}

async function _loadAndRenderInvoices(cycleId) {
    const previewWrap = document.getElementById('invoicePreviewWrap');
    if (previewWrap) previewWrap.innerHTML = '<p class="empty-hint">Loading invoices…</p>';

    try {
        const invoices = await fetchInvoicesForCycle(cycleId);
        renderInvoicePreview(invoices);
    } catch (err) {
        if (previewWrap) previewWrap.innerHTML = `<p class="empty-hint">Error loading invoices: ${escHtml(err.message)}</p>`;
    }
}

function renderInvoicePreview(invoices) {
    const wrap = document.getElementById('invoicePreviewWrap');
    if (!wrap) return;

    if (!invoices.length) {
        wrap.innerHTML = '<p class="empty-hint">No invoices yet. Click Generate to create draft invoices.</p>';
        return;
    }

    const tableRows = invoices.map(inv => {
        const base     = parseFloat(inv.base_amount || 0);
        const disc     = parseFloat(inv.discount_amount || 0);
        const adjAmt   = parseFloat(inv.adjustment_amount || 0);
        const finalAmt = parseFloat(inv.final_amount || 0);
        const status   = inv.status || 'draft';

        return `<tr data-inv-id="${escHtml(String(inv.id))}">
            <td>${escHtml(inv.parent_name || inv.family_id)}<br><small style="color:var(--muted)">${escHtml(inv.parent_email || '')}</small></td>
            <td>$${base.toFixed(2)}</td>
            <td>$${disc.toFixed(2)}</td>
            <td>
                <input type="number" class="bl-adj-input" data-inv-id="${escHtml(String(inv.id))}"
                    value="${adjAmt.toFixed(2)}" step="0.01"
                    style="width:80px" ${status !== 'draft' ? 'disabled' : ''}>
            </td>
            <td>
                <input type="text" class="bl-adj-note-input" data-inv-id="${escHtml(String(inv.id))}"
                    value="${escHtml(inv.adjustment_note || '')}" placeholder="Note…"
                    style="width:120px" ${status !== 'draft' ? 'disabled' : ''}>
            </td>
            <td class="bl-final-cell" data-inv-id="${escHtml(String(inv.id))}">$${finalAmt.toFixed(2)}</td>
            <td>${_invStatusBadge(status)}</td>
        </tr>`;
    }).join('');

    wrap.innerHTML = `
        <div class="table-wrapper">
            <table id="invoicePreviewTable">
                <thead><tr>
                    <th>Family</th>
                    <th>Base</th>
                    <th>Discount</th>
                    <th>Adjustment ($)</th>
                    <th>Adj. Note</th>
                    <th>Final</th>
                    <th>Status</th>
                </tr></thead>
                <tbody>${tableRows}</tbody>
            </table>
        </div>`;

    // Wire blur events for adjustment inputs
    wrap.querySelectorAll('.bl-adj-input').forEach(inp => {
        inp.addEventListener('blur', () => saveInvoiceAdjustment(inp.dataset.invId));
    });
    wrap.querySelectorAll('.bl-adj-note-input').forEach(inp => {
        inp.addEventListener('blur', () => saveInvoiceAdjustment(inp.dataset.invId));
    });
}

async function saveInvoiceAdjustment(invId) {
    const adjInput  = document.querySelector(`.bl-adj-input[data-inv-id="${invId}"]`);
    const noteInput = document.querySelector(`.bl-adj-note-input[data-inv-id="${invId}"]`);
    if (!adjInput) return;

    const adjAmt = parseFloat(adjInput.value || '0') || 0;
    const note   = noteInput ? noteInput.value.trim() : '';

    if (adjAmt !== 0 && !note) {
        // Don't block the user, just quietly require a note
        if (noteInput) noteInput.style.border = '1px solid red';
        return;
    }
    if (noteInput) noteInput.style.border = '';

    // Find the invoice's base and discount to compute new final
    const row = document.querySelector(`tr[data-inv-id="${invId}"]`);
    if (!row) return;

    const cells = row.querySelectorAll('td');
    const base = parseFloat((cells[1]?.textContent || '').replace('$', '')) || 0;
    const disc = parseFloat((cells[2]?.textContent || '').replace('$', '')) || 0;
    const finalAmt = Math.max(0, base - disc + adjAmt);

    const finalCell = document.querySelector(`.bl-final-cell[data-inv-id="${invId}"]`);

    try {
        await updateBillingInvoice(invId, {
            adjustment_amount: adjAmt,
            adjustment_note:   note,
            final_amount:      finalAmt,
        });
        if (finalCell) finalCell.textContent = `$${finalAmt.toFixed(2)}`;
    } catch (err) {
        alert('Failed to save adjustment: ' + err.message);
    }
}

async function finalizeCycle(cycleId) {
    if (!confirm('Finalize this billing cycle? All invoices will be locked.')) return;

    const finBtn = document.getElementById('finalizeCycleBtn');
    if (finBtn) finBtn.disabled = true;

    try {
        const invoices = await fetchInvoicesForCycle(cycleId);
        const now      = new Date().toISOString();

        // Finalize each draft invoice
        for (const inv of invoices) {
            if (inv.status === 'draft') {
                await updateBillingInvoice(inv.id, {
                    status:       'finalized',
                    finalized_at: now,
                });
            }
        }

        // Close the cycle
        await updateBillingCycle(cycleId, { status: 'closed', closed_at: now });

        await logAdminAction('finalize_cycle', 'billing_cycle', cycleId, {
            invoice_count: invoices.length,
        });

        _cyclesLoaded = false;
        await loadBillingCycles();

        // Re-select the cycle to refresh display
        const sel = document.getElementById('invoiceCycleSelect');
        if (sel && cycleId) {
            sel.value = cycleId;
            onCycleSelect();
        }
    } catch (err) {
        alert('Failed to finalize cycle: ' + err.message);
        if (finBtn) finBtn.disabled = false;
    }
}

// ============================================================
// PAYMENT MODAL (used from AR tab)
// ============================================================
function openRecordPaymentModal(familyId, invoiceId, familyName, invoiceFinalAmount) {
    _paymentModalContext = { familyId, invoiceId, familyName, finalAmount: invoiceFinalAmount };

    const nameEl    = document.getElementById('bpmFamilyName');
    const infoEl    = document.getElementById('bpmInvoiceInfo');
    const statusEl  = document.getElementById('bpmModalStatus');
    const dateInput = document.getElementById('bpmDate');
    const amtInput  = document.getElementById('bpmAmount');
    const methInput = document.getElementById('bpmMethod');
    const noteInput = document.getElementById('bpmNote');

    if (nameEl)   nameEl.textContent  = familyName || 'Family';
    if (infoEl)   infoEl.textContent  = invoiceFinalAmount != null
        ? `Invoice amount: $${parseFloat(invoiceFinalAmount).toFixed(2)}`
        : '';
    if (statusEl) statusEl.textContent = '';
    if (dateInput) dateInput.value = _todayStr();
    if (amtInput)  amtInput.value  = '';
    if (methInput) methInput.value = '';
    if (noteInput) noteInput.value = '';

    document.getElementById('billingPaymentModal')?.classList.remove('hidden');
}

async function savePaymentFromModal() {
    const { familyId, invoiceId, familyName } = _paymentModalContext;
    const statusEl = document.getElementById('bpmModalStatus');
    const saveBtn  = document.getElementById('bpmSaveBtn');

    const amount = parseFloat(document.getElementById('bpmAmount')?.value || '');
    const date   = document.getElementById('bpmDate')?.value?.trim();
    const method = document.getElementById('bpmMethod')?.value?.trim() || '';
    const note   = document.getElementById('bpmNote')?.value?.trim() || '';

    if (!amount || isNaN(amount) || amount <= 0) {
        if (statusEl) statusEl.textContent = 'Amount must be greater than $0.';
        return;
    }
    if (!date) {
        if (statusEl) statusEl.textContent = 'Payment date is required.';
        return;
    }

    if (saveBtn) saveBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Saving…';

    try {
        let recordedBy = '';
        try {
            const session = await getAdminSession();
            recordedBy = session?.user?.email || '';
        } catch (_) {}

        const row = {
            family_id:    familyId,
            invoice_id:   invoiceId || null,
            amount:       amount,
            payment_date: date,
            method:       method,
            note:         note,
            recorded_by:  recordedBy,
        };
        await insertBillingPayment(row);

        if (invoiceId) {
            await reconcileInvoiceStatus(invoiceId);
        }

        await logAdminAction('record_payment', 'billing_payment', null, {
            family_id:  familyId,
            invoice_id: invoiceId,
            amount,
            payment_date: date,
        });

        _arLoaded = false;
        await loadArView();
        document.getElementById('billingPaymentModal')?.classList.add('hidden');
    } catch (err) {
        if (statusEl) statusEl.textContent = 'Error: ' + err.message;
        alert('Failed to save payment: ' + err.message);
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

async function reconcileInvoiceStatus(invoiceId) {
    try {
        const payments = await fetchPaymentsForInvoice(invoiceId);
        const totalPaid = payments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);

        // Get invoice to find final_amount
        // We don't have a fetchInvoiceById, so we look it up from _arData
        let finalAmount = null;
        for (const row of _arData) {
            if (row.invoiceId === invoiceId || String(row.invoiceId) === String(invoiceId)) {
                finalAmount = row.billed;
                break;
            }
        }

        // Fallback: query via family invoices if not found in _arData
        if (finalAmount == null && _paymentModalContext.finalAmount != null) {
            finalAmount = parseFloat(_paymentModalContext.finalAmount);
        }

        let status;
        if (finalAmount != null) {
            if (totalPaid >= finalAmount) {
                status = 'paid';
            } else if (totalPaid > 0) {
                status = 'partial';
            } else {
                status = 'finalized';
            }
        } else {
            status = totalPaid > 0 ? 'partial' : 'finalized';
        }

        await updateBillingInvoice(invoiceId, { status });
        return { status, totalPaid, finalAmount };
    } catch (err) {
        console.warn('reconcileInvoiceStatus failed:', err.message);
        return null;
    }
}

// ============================================================
// CSV IMPORT SUB-TAB (Procare CSV)
// ============================================================
async function onPaymentCsvChange(file) {
    const nameEl = document.getElementById('paymentCsvFileName');
    if (nameEl) nameEl.textContent = file.name;

    const wrap = document.getElementById('paymentImportWrap');
    if (wrap) wrap.innerHTML = '<p class="empty-hint">Parsing file…</p>';

    try {
        const data = await _readFileAsArrayBuffer(file);
        const wb   = XLSX.read(data, { type: 'array' });
        const sheet = wb.Sheets[wb.SheetNames[0]];
        const rows  = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

        if (!rows.length) {
            if (wrap) wrap.innerHTML = '<p class="empty-hint">File appears to be empty.</p>';
            return;
        }

        _csvHeaders    = (rows[0] || []).map(h => String(h));
        _csvParsedRows = rows.slice(1).filter(r => r.some(cell => cell !== ''));

        // Auto-detect ProCare format: Date, Student, Type, Description, Due Date, Status, Amount
        const isProCare = ['Date','Student','Type','Description','Due Date','Status','Amount']
            .every((col, i) => (_csvHeaders[i] || '').trim() === col);
        if (isProCare) {
            await _handleProCareImport(_csvParsedRows, wrap);
            return;
        }

        renderColumnMappingStep(_csvHeaders);
    } catch (err) {
        if (wrap) wrap.innerHTML = `<p class="empty-hint">Error parsing file: ${escHtml(err.message)}</p>`;
        alert('Failed to parse CSV/XLSX file: ' + err.message);
    }
}

// ============================================================
// PROCARE IMPORT
// ============================================================

async function _handleProCareImport(rows, wrap) {
    wrap.innerHTML = '<p class="empty-hint">Loading child roster for matching…</p>';

    let students = [];
    try { students = await fetchStudents(); } catch (_) {}

    // Build name → family_id map, stripping quoted nicknames (e.g. Sullivan "Sully" O'Neill)
    const nameMap = new Map();
    students.forEach(s => {
        const clean = (s.child_name || '').replace(/"[^"]*"\s*/g, '').trim().toLowerCase();
        if (clean) nameMap.set(clean, s.family_id);
    });

    // Parse each row and attempt a match
    const parsed = rows.map((r, idx) => {
        const [dateRaw, studentRaw, type, description, dueDateRaw, status, amountRaw] = r;
        // Convert Excel serial dates
        const dateVal = typeof dateRaw === 'number'
            ? new Date(Math.round((dateRaw - 25569) * 86400 * 1000)).toISOString().substring(0, 10)
            : dateRaw instanceof Date
                ? dateRaw.toISOString().substring(0, 10)
                : String(dateRaw || '').substring(0, 10);

        const firstChild = String(studentRaw || '').split(',')[0].replace(/"[^"]*"\s*/g, '').trim();
        const familyId = nameMap.get(firstChild.toLowerCase()) || null;
        return { idx, dateVal, studentRaw: String(studentRaw || ''), firstChild, familyId, type: String(type || ''), description: String(description || ''), status: String(status || ''), amount: Number(amountRaw) || 0 };
    }).filter(r => r.dateVal && r.type && r.amount > 0);

    const matched   = parsed.filter(r => r.familyId);
    const unmatched = parsed.filter(r => !r.familyId);

    // Build family options for unmatched rows
    const familyOpts = [...new Map(students.map(s => [s.family_id, s])).values()]
        .sort((a, b) => (a.child_name || '').localeCompare(b.child_name || ''))
        .map(s => `<option value="${escHtml(String(s.family_id))}">${escHtml(s.child_name)}</option>`)
        .join('');

    const typeLabel = type => type === 'Invoice' ? '🧾 Invoice' : type === 'Credit' ? '💳 Credit' : '✅ Payment';

    const rows_html = parsed.map(r => {
        const isMatched = !!r.familyId;
        const bg = isMatched ? '' : 'background:#fffbeb';
        const matchCell = isMatched
            ? `<td style="color:#15803d">✓ ${escHtml(r.firstChild)}</td>`
            : `<td><select class="procare-family-sel form-control" data-idx="${r.idx}" style="font-size:.8rem;padding:2px 4px">
                <option value="">— skip —</option>${familyOpts}
               </select></td>`;
        return `<tr style="${bg}">
            <td style="white-space:nowrap">${escHtml(r.dateVal)}</td>
            <td style="font-size:.8rem">${escHtml(r.studentRaw)}</td>
            <td>${typeLabel(r.type)}</td>
            <td style="font-size:.8rem;color:#6b7280">${escHtml(r.description.substring(0, 50))}${r.description.length > 50 ? '…' : ''}</td>
            <td>${escHtml(r.status)}</td>
            <td style="text-align:right">$${r.amount.toFixed(2)}</td>
            ${matchCell}
        </tr>`;
    }).join('');

    wrap.innerHTML = `
        <div style="margin-bottom:12px;display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
            <span style="font-size:.9rem"><strong>${matched.length}</strong> matched &nbsp;·&nbsp; <strong style="color:#d97706">${unmatched.length}</strong> unmatched (assign below or skip)</span>
            <button id="procareImportBtn" class="btn-primary">Import ${matched.length} matched rows</button>
        </div>
        <div style="overflow-x:auto">
        <table class="report-table" style="font-size:.82rem">
            <thead><tr><th>Date</th><th>Student</th><th>Type</th><th>Description</th><th>Status</th><th>Amount</th><th>Matched To</th></tr></thead>
            <tbody>${rows_html}</tbody>
        </table>
        </div>`;

    document.getElementById('procareImportBtn')?.addEventListener('click', () => _confirmProCareImport(parsed, wrap));

    // When a manual family assignment is made, update familyId in parsed array and refresh button label
    wrap.querySelectorAll('.procare-family-sel').forEach(sel => {
        sel.addEventListener('change', () => {
            const idx = Number(sel.dataset.idx);
            const row = parsed.find(r => r.idx === idx);
            if (row) row.familyId = sel.value || null;
            const nowMatched = parsed.filter(r => r.familyId).length;
            const btn = document.getElementById('procareImportBtn');
            if (btn) btn.textContent = `Import ${nowMatched} matched rows`;
        });
    });
}

async function _confirmProCareImport(rows, wrap) {
    const btn = document.getElementById('procareImportBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }

    const valid = rows.filter(r => r.familyId && !(r.type === 'Payment' && r.status !== 'Success'));

    try {
        const batch = await insertImportBatch({ source: 'procare_xlsx', row_count: valid.length, notes: `ProCare import — ${valid.length} rows` });
        const batchId = batch?.id || null;

        let ok = 0, fail = 0;
        for (const row of valid) {
            const method = row.type === 'Invoice' ? 'procare_invoice'
                         : row.type === 'Credit'  ? 'procare_credit'
                         :                          'procare_payment';
            try {
                await insertBillingPayment({
                    family_id:      row.familyId,
                    amount:         row.amount,
                    payment_date:   row.dateVal,
                    payment_method: method,
                    note:           row.description,
                    import_batch_id: batchId,
                });
                ok++;
            } catch (_) { fail++; }
        }

        wrap.innerHTML = `<p class="empty-hint" style="color:#15803d">✓ Imported ${ok} rows${fail ? ` (${fail} failed)` : ''}. Upload another file to import more.</p>`;
    } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Retry Import'; }
        alert('Import failed: ' + err.message);
    }
}

function _readFileAsArrayBuffer(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = e => resolve(e.target.result);
        reader.onerror = () => reject(new Error('Failed to read file.'));
        reader.readAsArrayBuffer(file);
    });
}

function detectCsvColumns(headers) {
    const score = (header, keywords) => {
        const h = (header || '').toLowerCase();
        return keywords.reduce((s, kw) => s + (h.includes(kw) ? 1 : 0), 0);
    };

    const colGroups = {
        familyName: ['parent', 'family', 'name', 'guardian'],
        amount:     ['amount', 'payment', 'total', 'paid'],
        date:       ['date', 'paid', 'when'],
        method:     ['method', 'type', 'how', 'mode'],
    };

    const result = {};
    for (const [key, keywords] of Object.entries(colGroups)) {
        let best = -1, bestScore = 0;
        headers.forEach((h, i) => {
            const s = score(h, keywords);
            if (s > bestScore) { bestScore = s; best = i; }
        });
        result[key] = bestScore > 0 ? best : -1;
    }
    return result;
}

function renderColumnMappingStep(headers) {
    const wrap = document.getElementById('paymentImportWrap');
    if (!wrap) return;

    const guesses = detectCsvColumns(headers);
    const makeSelect = (id, guessIdx) => {
        const opts = headers.map((h, i) =>
            `<option value="${i}" ${i === guessIdx ? 'selected' : ''}>${escHtml(h)}</option>`
        ).join('');
        return `<select id="${id}" class="bl-col-map-select">
            <option value="-1">— Not mapped —</option>
            ${opts}
        </select>`;
    };

    wrap.innerHTML = `
        <div class="bl-import-map">
            <h4>Map CSV Columns</h4>
            <p class="empty-hint">Select which column corresponds to each field. Auto-detected where possible.</p>
            <table>
                <tbody>
                    <tr><td><label>Family Name</label></td><td>${makeSelect('bimFamilyColInline', guesses.familyName)}</td></tr>
                    <tr><td><label>Amount</label></td><td>${makeSelect('bimAmountColInline', guesses.amount)}</td></tr>
                    <tr><td><label>Date</label></td><td>${makeSelect('bimDateColInline', guesses.date)}</td></tr>
                    <tr><td><label>Method</label></td><td>${makeSelect('bimMethodColInline', guesses.method)}</td></tr>
                </tbody>
            </table>
            <br>
            <button class="btn-primary" id="bimPreviewBtnInline">Preview Matches</button>
        </div>`;

    document.getElementById('bimPreviewBtnInline')?.addEventListener('click', () => {
        const mapping = {
            familyCol:  parseInt(document.getElementById('bimFamilyColInline')?.value ?? '-1'),
            amountCol:  parseInt(document.getElementById('bimAmountColInline')?.value ?? '-1'),
            dateCol:    parseInt(document.getElementById('bimDateColInline')?.value ?? '-1'),
            methodCol:  parseInt(document.getElementById('bimMethodColInline')?.value ?? '-1'),
        };
        buildImportPreview(mapping);
    });
}

function _doImportPreview() {
    // Used by the billingImportMapModal modal buttons (secondary path)
    const mapping = {
        familyCol:  parseInt(document.getElementById('bimFamilyCol')?.value ?? '-1'),
        amountCol:  parseInt(document.getElementById('bimAmountCol')?.value ?? '-1'),
        dateCol:    parseInt(document.getElementById('bimDateCol')?.value ?? '-1'),
        methodCol:  parseInt(document.getElementById('bimMethodCol')?.value ?? '-1'),
    };
    document.getElementById('billingImportMapModal')?.classList.add('hidden');
    buildImportPreview(mapping);
}

function buildImportPreview(mapping) {
    const wrap = document.getElementById('paymentImportWrap');
    if (!wrap) return;

    const matchResults = _csvParsedRows.map((row, idx) => {
        const csvName   = mapping.familyCol >= 0 ? String(row[mapping.familyCol] || '') : '';
        const amount    = mapping.amountCol >= 0
            ? parseFloat(String(row[mapping.amountCol] || '').replace(/[$,]/g, '')) || 0
            : 0;
        const date      = mapping.dateCol >= 0   ? String(row[mapping.dateCol]   || '') : '';
        const method    = mapping.methodCol >= 0 ? String(row[mapping.methodCol] || '') : '';

        const matches = fuzzyMatchFamilyName(csvName);
        const top     = matches[0] || null;
        const confidence = !top || top.score < 2 ? 'low'
            : top.score >= 4 ? 'high' : 'medium';

        return {
            rowIdx:     idx,
            csvName,
            amount,
            date,
            method,
            matches,
            topMatch:   top ? top.family : null,
            confidence,
        };
    });

    renderImportPreviewTable(matchResults, mapping);
}

function fuzzyMatchFamilyName(name) {
    const normalize = s => (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').trim();
    const tokens = normalize(name).split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];

    const scored = (allFamiliesData || []).map(family => {
        const p1Tokens = normalize(family.parent_name  || '').split(/\s+/).filter(Boolean);
        const p2Tokens = normalize(family.parent2_name || '').split(/\s+/).filter(Boolean);

        let score = 0;
        tokens.forEach(t => {
            if (p1Tokens.includes(t)) score += 2;
            if (p2Tokens.includes(t)) score += 1;
        });
        return { family, score };
    });

    return scored.filter(r => r.score > 0).sort((a, b) => b.score - a.score);
}

function renderImportPreviewTable(matchResults, mapping) {
    const wrap = document.getElementById('paymentImportWrap');
    if (!wrap) return;

    if (!matchResults.length) {
        wrap.innerHTML = '<p class="empty-hint">No data rows found in the file.</p>';
        return;
    }

    const familyOptions = (allFamiliesData || [])
        .filter(f => f.active !== false)
        .map(f => `<option value="${escHtml(f.id)}">${escHtml(f.parent_name || f.parent_email || f.id)}</option>`)
        .join('');

    const tableRows = matchResults.map((r, i) => {
        const badgeClass = r.confidence === 'high' ? 'bl-badge-paid'
            : r.confidence === 'medium' ? 'bl-badge-partial' : 'bl-badge-overdue';
        const badgeLabel = r.confidence === 'high' ? 'High' : r.confidence === 'medium' ? 'Medium' : 'Unmatched';

        const matchedName = r.topMatch
            ? escHtml(r.topMatch.parent_name || r.topMatch.parent_email || '')
            : '<em>No match</em>';

        const manualSelect = r.confidence === 'low'
            ? `<br><select class="bl-manual-family-sel" data-row="${i}">
                <option value="">— Pick family —</option>
                ${familyOptions}
               </select>`
            : `<input type="hidden" class="bl-manual-family-sel" data-row="${i}"
                value="${r.topMatch ? escHtml(r.topMatch.id) : ''}">`;

        return `<tr>
            <td>${escHtml(r.csvName)}</td>
            <td>${matchedName}${manualSelect}</td>
            <td><span class="bl-badge ${badgeClass}">${badgeLabel}</span></td>
            <td>$${r.amount.toFixed(2)}</td>
            <td>${escHtml(r.date)}</td>
            <td><input type="checkbox" class="bl-skip-chk" data-row="${i}"></td>
        </tr>`;
    }).join('');

    wrap.innerHTML = `
        <div class="table-wrapper">
            <table id="importPreviewTable">
                <thead><tr>
                    <th>CSV Name</th><th>Matched Family</th><th>Confidence</th>
                    <th>Amount</th><th>Date</th><th>Skip?</th>
                </tr></thead>
                <tbody>${tableRows}</tbody>
            </table>
        </div>
        <br>
        <button class="btn-primary" id="confirmImportBtn">Confirm Import</button>`;

    // Store match results for confirm step
    wrap.dataset.matchJson = JSON.stringify(matchResults);
    wrap.dataset.mappingJson = JSON.stringify(mapping);

    document.getElementById('confirmImportBtn')?.addEventListener('click', () => confirmPaymentImport(matchResults));
}

async function confirmPaymentImport(matchResults) {
    const wrap    = document.getElementById('paymentImportWrap');
    const confirmBtn = document.getElementById('confirmImportBtn');
    if (confirmBtn) confirmBtn.disabled = true;

    let recordedBy = '';
    try {
        const session = await getAdminSession();
        recordedBy = session?.user?.email || '';
    } catch (_) {}

    try {
        // Insert batch record
        const batchRow = await insertImportBatch({
            imported_by: recordedBy,
            row_count:   matchResults.length,
            source:      'procare_csv',
            imported_at: new Date().toISOString(),
        });
        const batchId = batchRow?.id || null;

        let matched = 0, skipped = 0;

        for (let i = 0; i < matchResults.length; i++) {
            const r = matchResults[i];

            // Check skip checkbox
            const skipChk = document.querySelector(`.bl-skip-chk[data-row="${i}"]`);
            if (skipChk?.checked) { skipped++; continue; }

            // Resolve family id — prefer manual override select if present
            const manualSel = document.querySelector(`.bl-manual-family-sel[data-row="${i}"]`);
            const familyId  = (manualSel && manualSel.value)
                ? manualSel.value
                : (r.topMatch ? r.topMatch.id : null);

            if (!familyId || r.confidence === 'low' && !(manualSel?.value)) {
                skipped++;
                continue;
            }
            if (r.amount <= 0) { skipped++; continue; }

            await insertBillingPayment({
                family_id:       familyId,
                invoice_id:      null,
                amount:          r.amount,
                payment_date:    _normalizeImportDate(r.date),
                method:          r.method || '',
                note:            `Imported from CSV`,
                recorded_by:     recordedBy,
                import_batch_id: batchId,
            });
            matched++;
        }

        await logAdminAction('import_payments', 'billing_import', batchId, {
            matched,
            skipped,
            total: matchResults.length,
        });

        if (wrap) {
            wrap.innerHTML = `
                <p class="empty-hint" style="color:var(--positive,green)">
                    Import complete: <strong>${matched}</strong> payment${matched !== 1 ? 's' : ''} recorded,
                    <strong>${skipped}</strong> skipped.
                </p>
                <button class="btn-xs" onclick="
                    document.getElementById('paymentCsvInput').value='';
                    document.getElementById('paymentCsvFileName').textContent='No file chosen';
                    document.getElementById('paymentImportWrap').innerHTML='';
                ">Clear / Import Another</button>`;
        }

        _arLoaded = false;
        // Don't force AR load if user is on payments tab
    } catch (err) {
        alert('Import failed: ' + err.message);
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

function renderPaymentHistory(payments, finalAmount, containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;

    if (!payments.length) {
        el.innerHTML = '<p class="empty-hint">No payments recorded.</p>';
        return;
    }

    let running = 0;
    const rows = payments.map(p => {
        const amt = parseFloat(p.amount || 0);
        running  += amt;
        const overPay = finalAmount != null && running > finalAmount && finalAmount > 0;
        return `<tr ${overPay ? 'class="bl-overpay-badge"' : ''}>
            <td>${_fmtDate(p.payment_date)}</td>
            <td>${escHtml(p.method || '—')}</td>
            <td>$${amt.toFixed(2)}</td>
            <td>${escHtml(p.note || '—')}</td>
            <td>$${running.toFixed(2)}</td>
        </tr>`;
    }).join('');

    el.innerHTML = `
        <div class="table-wrapper">
            <table>
                <thead><tr>
                    <th>Date</th><th>Method</th><th>Amount</th><th>Note</th><th>Running Balance</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

// ============================================================
// AR SUB-TAB
// ============================================================

async function backfillAllInvoices() {
    if (!confirm(
        'Backfill invoices from registration history?\n\n' +
        'This will create invoices for all past months where a family has ' +
        'registrations but no invoice yet. Existing invoices will not be changed.'
    )) return;

    const btn = document.getElementById('backfillInvoicesBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Backfilling…'; }
    const wrap = document.getElementById('arTableWrap');
    if (wrap) wrap.innerHTML = '<p class="empty-hint">Backfilling invoices from registration data — this may take a moment…</p>';

    try {
        // Fresh fetch so discount map and registrations are current
        allFamiliesData = await fetchAllFamilies({ includeArchived: true });
        _discountMap = null;
        const freshRegs = await fetchAllRegistrations();
        if (freshRegs && freshRegs.length) allRegistrations = freshRegs;

        // Collect every unique YYYY-MM that appears in registration dates
        const monthSet = new Set();
        allRegistrations.forEach(reg => {
            (reg.registration_dates || []).forEach(d => {
                if (d.care_date) monthSet.add(d.care_date.substring(0, 7));
            });
        });
        const months = [...monthSet].sort();

        if (!months.length) {
            alert('No registration data found to backfill.');
            return;
        }

        let totalCreated = 0;
        let totalSkipped = 0; // already had an invoice or no family match

        for (const month of months) {
            let overrideRows = [];
            try { overrideRows = await fetchBillingOverrides(month); } catch (_) { }
            const overridesMap = new Map(overrideRows.map(r => [
                `${(r.parent_email || '').toLowerCase()}:${(r.child_name || '').toLowerCase()}`,
                parseFloat(r.override_amount || 0),
            ]));

            const billingResults = _buildFamilyBillingData(month, overridesMap);
            if (!billingResults.length) continue;

            const cycle = await getOrCreateBillingCycle(month);
            const existingInvoices = await fetchInvoicesForCycle(cycle.id);
            const existingByFamily = new Map(existingInvoices.map(inv => [String(inv.family_id), inv]));

            for (const result of billingResults) {
                const fam = allFamiliesData.find(f =>
                    (f.parent_email  || '').toLowerCase() === (result.parentEmail || '').toLowerCase() ||
                    (f.parent2_email || '').toLowerCase() === (result.parentEmail || '').toLowerCase()
                );
                if (!fam || existingByFamily.has(String(fam.id))) { totalSkipped++; continue; }

                let baseAmount = 0, discountAmount = 0, finalAmount = 0;
                (result.children || []).forEach(child => {
                    baseAmount     += (child.subtotal || 0) + (child.changeFees || 0) + (child.discountDollar || 0) + (child.sibDiscount || 0);
                    discountAmount += (child.discountDollar || 0) + (child.sibDiscount || 0);
                    finalAmount    += child.hasOverride
                        ? parseFloat(child.overrideAmount || 0)
                        : (child.subtotal || 0) + (child.changeFees || 0);
                });
                baseAmount     = Math.round(baseAmount * 100) / 100;
                discountAmount = Math.round(discountAmount * 100) / 100;
                finalAmount    = Math.round(Math.max(0, finalAmount) * 100) / 100;

                await upsertBillingInvoice({
                    cycle_id:          cycle.id,
                    family_id:         fam.id,
                    base_amount:       baseAmount,
                    discount_amount:   discountAmount,
                    adjustment_amount: 0,
                    adjustment_note:   '',
                    final_amount:      finalAmount,
                    status:            'draft',
                });
                totalCreated++;
            }
        }

        await logAdminAction('backfill_invoices', 'billing_invoices', null, {
            months_processed: months.length,
            invoices_created: totalCreated,
        });

        alert(
            `Backfill complete.\n\n` +
            `Created ${totalCreated} invoice${totalCreated !== 1 ? 's' : ''} ` +
            `across ${months.length} month${months.length !== 1 ? 's' : ''}.` +
            (totalSkipped > 0 ? `\n${totalSkipped} skipped (already had an invoice or no matching family).` : '')
        );

        _arLoaded = false;
        await loadArView();
    } catch (err) {
        alert('Backfill failed: ' + err.message);
        if (wrap) wrap.innerHTML = `<p class="empty-hint">Backfill error: ${escHtml(err.message)}</p>`;
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📥 Backfill Past Invoices'; }
    }
}

async function loadArView() {
    const wrap = document.getElementById('arTableWrap');
    if (wrap) wrap.innerHTML = '<p class="empty-hint">Loading…</p>';

    const arMonthSel = document.getElementById('arMonthSelect');
    const now   = new Date();
    const month = arMonthSel?.value ||
        `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    _blArMonth = month;

    // Reset status filter to "All Statuses" so families with invoices aren't hidden
    const filterEl = document.getElementById('arStatusFilter');
    if (filterEl) filterEl.value = '';

    try {
        const [families, cycle] = await Promise.all([
            fetchAllFamilies({ includeArchived: true }),
            getOrCreateBillingCycle(month),
        ]);
        allFamiliesData = families;

        const [invoices, monthPayments] = await Promise.all([
            fetchInvoicesForCycle(cycle.id),
            fetchPaymentsForMonth(month).catch(() => []),
        ]);

        const invoiceByFamily = new Map(invoices.map(inv => [String(inv.family_id), inv]));

        const paymentsByFamily = {};
        monthPayments.forEach(p => {
            const fid = String(p.family_id);
            if (!paymentsByFamily[fid]) paymentsByFamily[fid] = [];
            paymentsByFamily[fid].push(p);
        });

        _arData = families.map(family => {
            const inv      = invoiceByFamily.get(String(family.id));
            const payments = paymentsByFamily[String(family.id)] || [];

            const billed      = parseFloat(inv?.final_amount || 0);
            const collected   = payments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
            const outstanding = Math.max(0, billed - collected);

            let status;
            if (billed === 0 && collected === 0) status = 'no_invoice';
            else if (outstanding <= 0 && billed > 0) status = 'paid';
            else if (collected > 0)                  status = 'partial';
            else                                     status = 'overdue';

            return {
                familyId:    family.id,
                familyName:  family.parent_name || '(unnamed)',
                familyEmail: family.parent_email || '',
                invoiceId:   inv?.id || null,
                billed,
                collected,
                outstanding,
                status,
                isLocked:    !!family.registration_locked,
                lockReason:  family.registration_lock_reason || '',
            };
        });

        _arLoaded = true;
        renderArTable(_arData);
    } catch (err) {
        if (wrap) wrap.innerHTML = `<p class="empty-hint">Error: ${escHtml(err.message)}</p>`;
    }
}

function renderArTable(data) {
    const wrap = document.getElementById('arTableWrap');
    if (!wrap) return;

    const filterVal = document.getElementById('arStatusFilter')?.value || '';
    const filtered  = (filterVal && filterVal !== 'all') ? data.filter(r => r.status === filterVal) : data;

    if (!filtered.length) {
        wrap.innerHTML = '<p class="empty-hint">No AR data found for the selected filter.</p>';
        return;
    }

    const rows = filtered.map(r => {
        const lockBtn = r.isLocked
            ? `<button class="btn-xs btn-warn" onclick="doSetFamilyLockWithReason('${escHtml(r.familyId)}', false, null, '${escHtml(r.familyName)}')">Unlock</button>`
            : `<button class="btn-xs btn-danger" onclick="openLockWithReasonModal('${escHtml(r.familyId)}', '${escHtml(r.familyName)}')">Lock</button>`;

        // Billed cell: editable input when no invoice; clickable value when invoice exists
        const billedCell = r.billed > 0
            ? `<span class="bl-editable-amount" title="Click to edit" onclick="startEditBilledAmount('${escHtml(r.familyId)}',${r.billed})">$${r.billed.toFixed(2)} <small style="opacity:.45;cursor:pointer">✎</small></span>`
            : `<input type="number" class="bl-adj-input" style="width:78px" step="0.01" min="0" placeholder="Set amount"
                 onblur="saveBilledAmount('${escHtml(r.familyId)}',this.value)"
                 onkeydown="if(event.key==='Enter')this.blur()">`;

        return `<tr data-family-id="${escHtml(r.familyId)}">
            <td>
                ${escHtml(r.familyName)}
                ${r.isLocked ? '<span class="bl-badge bl-badge-overdue" title="Registration locked">Locked</span>' : ''}
                <br><small style="color:var(--muted)">${escHtml(r.familyEmail)}</small>
            </td>
            <td id="bl-billed-cell-${escHtml(r.familyId)}">${billedCell}</td>
            <td>${r.collected > 0 ? '$' + r.collected.toFixed(2) : '—'}</td>
            <td>${r.outstanding > 0 ? '$' + r.outstanding.toFixed(2) : '—'}</td>
            <td>${getArStatusBadge(r.status)}</td>
            <td>
                <button class="btn-xs" onclick="toggleArRowDetail('${escHtml(r.familyId)}')">▸ Details</button>
                ${r.invoiceId
                    ? `<button class="btn-xs" onclick="openRecordPaymentModal('${escHtml(r.familyId)}','${escHtml(String(r.invoiceId))}','${escHtml(r.familyName)}',${r.billed})">💳 Payment</button>`
                    : `<button class="btn-xs" onclick="openRecordPaymentModal('${escHtml(r.familyId)}',null,'${escHtml(r.familyName)}',null)">💳 Payment</button>`
                }
                ${lockBtn}
            </td>
        </tr>`;
    }).join('');

    wrap.innerHTML = `
        <div class="table-wrapper">
            <table id="arTable">
                <thead><tr>
                    <th>Family</th>
                    <th>Billed <small style="opacity:.5;font-weight:normal">(click to edit)</small></th>
                    <th>Collected</th>
                    <th>Outstanding</th>
                    <th>Status</th>
                    <th>Actions</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

function startEditBilledAmount(familyId, currentVal) {
    const cell = document.getElementById(`bl-billed-cell-${familyId}`);
    if (!cell) return;
    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'bl-adj-input';
    input.style.width = '78px';
    input.step = '0.01';
    input.min = '0';
    input.value = currentVal.toFixed(2);
    input.addEventListener('blur',    () => saveBilledAmount(familyId, input.value));
    input.addEventListener('keydown', e => { if (e.key === 'Enter') input.blur(); });
    cell.innerHTML = '';
    cell.appendChild(input);
    input.focus();
    input.select();
}

async function saveBilledAmount(familyId, rawVal) {
    const amount = parseFloat(rawVal);
    if (isNaN(amount) || amount < 0) return;
    const month = _blArMonth;
    if (!month) return;
    try {
        const cycle = await getOrCreateBillingCycle(month);
        await upsertBillingInvoice({
            cycle_id:         cycle.id,
            family_id:        familyId,
            base_amount:      amount,
            discount_amount:  0,
            adjustment_amount: 0,
            final_amount:     amount,
            status:           'draft',
        });
        _arLoaded = false;
        await loadArView();
    } catch (err) {
        alert('Error saving billing amount: ' + err.message);
    }
}

function getArStatusBadge(status) {
    const map = {
        paid:       ['bl-badge-paid',     'Paid'],
        partial:    ['bl-badge-partial',  'Partial'],
        overdue:    ['bl-badge-overdue',  'Overdue'],
        no_invoice: ['bl-badge-noinv',    'No Invoice'],
        finalized:  ['bl-badge-partial',  'Finalized'],
    };
    const [cls, label] = map[status] || ['bl-badge-noinv', status || 'Unknown'];
    return `<span class="bl-badge ${cls}">${label}</span>`;
}

async function toggleArRowDetail(familyId) {
    const table = document.getElementById('arTable');
    if (!table) return;

    // If detail row already open, remove it
    const existing = table.querySelector(`.bl-detail-row[data-detail-family="${familyId}"]`);
    if (existing) { existing.remove(); return; }

    const mainRow = table.querySelector(`tr[data-family-id="${familyId}"]`);
    if (!mainRow) return;

    const detailTr = document.createElement('tr');
    detailTr.className = 'bl-detail-row';
    detailTr.dataset.detailFamily = familyId;
    detailTr.innerHTML = `<td colspan="6"><p class="empty-hint">Loading…</p></td>`;
    mainRow.after(detailTr);

    try {
        const [invoices, payments] = await Promise.all([
            fetchInvoicesForFamily(familyId),
            fetchPaymentsForFamily(familyId),
        ]);

        const arRow = _arData.find(r => r.familyId === familyId);
        const topInvoice = arRow?.invoiceId || null;

        const invRows = invoices.map(inv => {
            const invPayments = payments.filter(p => String(p.invoice_id) === String(inv.id));
            const totalPaid   = invPayments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
            return `<tr>
                <td>${escHtml(inv.month || '—')}</td>
                <td>$${parseFloat(inv.final_amount || 0).toFixed(2)}</td>
                <td>$${totalPaid.toFixed(2)}</td>
                <td>$${Math.max(0, parseFloat(inv.final_amount || 0) - totalPaid).toFixed(2)}</td>
                <td>${_invStatusBadge(inv.status)}</td>
            </tr>`;
        }).join('') || '<tr><td colspan="5"><em>No invoices</em></td></tr>';

        const topFinalAmt = arRow ? arRow.billed : null;
        const payHistContainerId = `pay-hist-${familyId}`;

        detailTr.querySelector('td').innerHTML = `
            <div style="padding:12px">
                <h4 style="margin:0 0 8px">Invoice History</h4>
                <div class="table-wrapper">
                    <table>
                        <thead><tr><th>Month</th><th>Billed</th><th>Paid</th><th>Outstanding</th><th>Status</th></tr></thead>
                        <tbody>${invRows}</tbody>
                    </table>
                </div>
                <h4 style="margin:12px 0 8px">Payment History</h4>
                <div id="${payHistContainerId}"></div>
                <br>
                <button class="btn-xs" onclick="openRecordPaymentModal(
                    '${escHtml(familyId)}',
                    '${topInvoice ? escHtml(String(topInvoice)) : ''}',
                    '${escHtml(arRow?.familyName || '')}',
                    ${topFinalAmt != null ? topFinalAmt : 'null'}
                )">💳 Record Payment</button>
            </div>`;

        const invPayments = topInvoice
            ? payments.filter(p => String(p.invoice_id) === String(topInvoice))
            : payments;

        renderPaymentHistory(invPayments, topFinalAmt, payHistContainerId);
    } catch (err) {
        detailTr.querySelector('td').innerHTML =
            `<p class="empty-hint">Error loading details: ${escHtml(err.message)}</p>`;
    }
}

function openLockWithReasonModal(familyId, familyName) {
    _lockModalContext = { familyId, familyName, isLocking: true };

    const nameEl   = document.getElementById('blmFamilyName');
    const reasonEl = document.getElementById('blmLockReason');
    const statusEl = document.getElementById('blmModalStatus');

    if (nameEl)   nameEl.textContent  = familyName || 'Family';
    if (reasonEl) reasonEl.value      = '';
    if (statusEl) statusEl.textContent = '';

    document.getElementById('billingLockModal')?.classList.remove('hidden');
}

async function _doLockModalConfirm() {
    const { familyId, familyName, isLocking } = _lockModalContext;
    const reason   = document.getElementById('blmLockReason')?.value?.trim() || '';
    const statusEl = document.getElementById('blmModalStatus');
    const confirmBtn = document.getElementById('blmConfirmBtn');

    if (isLocking && !reason) {
        if (statusEl) statusEl.textContent = 'Please provide a lock reason.';
        return;
    }

    if (confirmBtn) confirmBtn.disabled = true;
    if (statusEl)   statusEl.textContent = 'Saving…';

    try {
        await doSetFamilyLockWithReason(familyId, isLocking, isLocking ? reason : null);
        document.getElementById('billingLockModal')?.classList.add('hidden');
    } catch (err) {
        if (statusEl) statusEl.textContent = 'Error: ' + err.message;
        alert('Failed to update lock: ' + err.message);
    } finally {
        if (confirmBtn) confirmBtn.disabled = false;
    }
}

async function doSetFamilyLockWithReason(familyId, locked, reason, familyName) {
    await setFamilyRegistrationLock(familyId, locked, reason || null);
    await logAdminAction(
        locked ? 'lock_family' : 'unlock_family',
        'family',
        familyId,
        { reason: reason || null, family_name: familyName || '' }
    );
    _arLoaded = false;
    await loadArView();
}

async function lockAllOverdue() {
    const overdueUnlocked = _arData.filter(r => r.status === 'overdue' && !r.isLocked);

    if (!overdueUnlocked.length) {
        alert('No unlocked overdue families found.');
        return;
    }

    if (!confirm(`Lock ${overdueUnlocked.length} overdue ${overdueUnlocked.length === 1 ? 'family' : 'families'} from registering?`)) {
        return;
    }

    const btn = document.getElementById('lockAllOverdueBtn');
    if (btn) btn.disabled = true;

    try {
        await Promise.all(
            overdueUnlocked.map(r =>
                setFamilyRegistrationLock(r.familyId, true, 'Overdue balance — locked via bulk AR action')
            )
        );
        await logAdminAction('bulk_lock_overdue', 'billing_ar', null, {
            count: overdueUnlocked.length,
            family_ids: overdueUnlocked.map(r => r.familyId),
        });
        _arLoaded = false;
        await loadArView();
    } catch (err) {
        alert('Bulk lock failed: ' + err.message);
    } finally {
        if (btn) btn.disabled = false;
    }
}

function exportArCsv() {
    const header = ['Family', 'Email', 'Billed', 'Collected', 'Outstanding', 'Days Since Invoice', 'Status'];
    const rows   = _arData.map(r => [
        csvCell(r.familyName),
        csvCell(r.familyEmail),
        csvCell(r.billed.toFixed(2)),
        csvCell(r.collected.toFixed(2)),
        csvCell(r.outstanding.toFixed(2)),
        csvCell(r.daysSince != null ? String(r.daysSince) : ''),
        csvCell(r.status),
    ]);

    const csv = [header.map(csvCell), ...rows].map(r => r.join(',')).join('\n');
    const today = _todayStr();
    downloadFile(`ar-report-${today}.csv`, 'text/csv', csv);
}

// ============================================================
// DASHBOARD SUB-TAB
// ============================================================
function setupBillingDashYear() {
    const sel = document.getElementById('blDashYear');
    if (!sel || sel.options.length > 1) return; // already populated

    const cur = new Date().getFullYear();
    for (let y = cur + 2; y >= cur - 2; y--) {
        const opt = document.createElement('option');
        opt.value       = y;
        opt.textContent = y;
        if (y === cur) opt.selected = true;
        sel.appendChild(opt);
    }
}

async function generateBillingDashboard() {
    const year = parseInt(document.getElementById('blDashYear')?.value || new Date().getFullYear());
    const container = document.getElementById('blDashContent');
    if (container) container.innerHTML = '<p class="empty-hint">Loading billing data…</p>';

    const genBtn = document.getElementById('generateBlDashBtn');
    if (genBtn) genBtn.disabled = true;

    try {
        // Ensure billing_cycle rows exist for all months in this year
        await _syncAllMonthsForYear(year);

        const [{ cycles, invoices, payments }, manualRevenue] = await Promise.all([
            fetchBillingDashData(year),
            fetchSetting('billing_manual_revenue').then(v => v || {}),
        ]);
        const metrics = computeDashMetrics(cycles, invoices, payments, year, manualRevenue);

        _blDashLoaded = true;
        if (container) container.innerHTML = '';

        renderBillingKpis(metrics, container);

        const chartWrap = document.createElement('div');
        chartWrap.className = 'fin-chart-wrap';
        chartWrap.innerHTML = '<h4 class="fin-chart-title">Expected vs. Collected by Month</h4><canvas id="blMainChart"></canvas>';
        if (container) container.appendChild(chartWrap);
        renderBlExpectedVsCollectedChart(metrics.monthData);

        if (metrics.priorYearData) {
            const yoyWrap = document.createElement('div');
            yoyWrap.className = 'fin-chart-wrap';
            yoyWrap.innerHTML = '<h4 class="fin-chart-title">Year-over-Year: Collected</h4><canvas id="blYoyChart"></canvas>';
            if (container) container.appendChild(yoyWrap);
            renderBlYoyChart(metrics.monthData, metrics.priorYearData);
        }

        const discWrap = document.createElement('div');
        discWrap.innerHTML = '<h4>Discount Summary</h4>';
        if (container) container.appendChild(discWrap);
        renderDiscountSummaryTable(invoices, discWrap);

        // Manual revenue override table (for months without family-level registration data)
        renderManualRevenueTable(year, metrics.monthData, manualRevenue, container);

        document.getElementById('exportBlDashBtn').disabled = false;
        document.getElementById('blDashContent').dataset.metricsYear = year;
    } catch (err) {
        if (container) container.innerHTML = `<p class="empty-hint">Error: ${escHtml(err.message)}</p>`;
        alert('Failed to generate billing dashboard: ' + err.message);
    } finally {
        if (genBtn) genBtn.disabled = false;
    }
}

async function _syncAllMonthsForYear(year) {
    // Ensure a billing_cycle row exists for every month that has passed this year.
    // Invoices are created at registration time — no sync needed here.
    const now = new Date();
    const maxMonth = year < now.getFullYear() ? 12 : now.getMonth() + 1;
    await Promise.all(
        Array.from({ length: maxMonth }, (_, i) => i + 1).map(m =>
            getOrCreateBillingCycle(`${year}-${String(m).padStart(2, '0')}`).catch(() => {})
        )
    );
}

async function fetchBillingDashData(year) {
    // Fetch current year cycles joined with invoices and payments
    const { data: cycles, error } = await sbClient
        .from('billing_cycles')
        .select('*, billing_invoices(*, billing_payments(*))')
        .like('month', `${year}-%`);

    if (error) throw error;

    const safe = cycles || [];

    const invoices = safe.flatMap(c =>
        (c.billing_invoices || []).map(inv => ({
            ...inv,
            cycle_month: c.month,
            cycle_status: c.status,
        }))
    );

    const payments = invoices.flatMap(inv =>
        (inv.billing_payments || []).map(p => ({
            ...p,
            cycle_month: inv.cycle_month,
        }))
    );

    return { cycles: safe, invoices, payments };
}

function computeDashMetrics(cycles, invoices, payments, year, manualRevenue = {}) {
    const BL_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    const monthData = {};
    for (let m = 1; m <= 12; m++) {
        const moKey = `${year}-${String(m).padStart(2,'0')}`;
        const moInvoices = invoices.filter(inv =>
            (inv.cycle_month || '').startsWith(moKey) &&
            ['draft', 'finalized', 'paid', 'partial'].includes(inv.status)
        );
        const invoiceTotal = moInvoices.reduce((s, inv) => s + parseFloat(inv.final_amount || 0), 0);
        // Use manual override when no family-level invoices exist for this month
        const manualAmt = parseFloat(manualRevenue[moKey] || 0);
        const expected  = invoiceTotal > 0 ? invoiceTotal : manualAmt;

        const moPayments = payments.filter(p => (p.cycle_month || '').startsWith(moKey));
        const collected  = moPayments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
        const outstanding = Math.max(0, expected - collected);
        const collectionRate = expected > 0 ? collected / expected : 0;

        monthData[moKey] = {
            label:        BL_MONTHS[m - 1],
            expected,
            invoiceTotal,
            manualAmt,
            collected,
            outstanding,
            collectionRate,
        };
    }

    const ytdExpected    = Object.values(monthData).reduce((s, m) => s + m.expected,   0);
    const ytdCollected   = Object.values(monthData).reduce((s, m) => s + m.collected,  0);
    const ytdOutstanding = Object.values(monthData).reduce((s, m) => s + m.outstanding, 0);
    const ytdRate        = ytdExpected > 0 ? ytdCollected / ytdExpected : 0;

    return {
        year,
        monthData,
        ytdExpected,
        ytdCollected,
        ytdOutstanding,
        ytdRate,
        priorYearData: null, // populated separately if needed
    };
}

function renderBillingKpis(metrics, container) {
    const rateClass = metrics.ytdRate >= 0.9 ? 'fin-positive'
        : metrics.ytdRate >= 0.7 ? 'fin-warn' : 'fin-negative';

    const kpiHtml = `
        <div class="fin-kpi-row">
            <div class="fin-kpi">
                <span class="fin-kpi-label">Total Expected</span>
                <span class="fin-kpi-value">$${metrics.ytdExpected.toFixed(2)}</span>
            </div>
            <div class="fin-kpi">
                <span class="fin-kpi-label">Total Collected</span>
                <span class="fin-kpi-value fin-positive">$${metrics.ytdCollected.toFixed(2)}</span>
            </div>
            <div class="fin-kpi">
                <span class="fin-kpi-label">Collection Rate</span>
                <span class="fin-kpi-value ${rateClass}">${(metrics.ytdRate * 100).toFixed(1)}%</span>
            </div>
            <div class="fin-kpi">
                <span class="fin-kpi-label">Total Outstanding</span>
                <span class="fin-kpi-value ${metrics.ytdOutstanding > 0 ? 'fin-warn' : ''}">$${metrics.ytdOutstanding.toFixed(2)}</span>
            </div>
        </div>`;

    const kpiDiv = document.createElement('div');
    kpiDiv.innerHTML = kpiHtml;
    if (container) container.appendChild(kpiDiv);
}

function renderBlExpectedVsCollectedChart(monthData) {
    if (_billingCharts.main) {
        _billingCharts.main.destroy();
        delete _billingCharts.main;
    }

    const canvas = document.getElementById('blMainChart');
    if (!canvas) return;

    const months   = Object.keys(monthData).sort();
    const labels   = months.map(k => monthData[k].label);
    const expected = months.map(k => Math.round(monthData[k].expected));
    const collected = months.map(k => Math.round(monthData[k].collected));

    _billingCharts.main = new Chart(canvas.getContext('2d'), {
        type: 'bar',
        data: {
            labels,
            datasets: [
                {
                    label:           'Expected',
                    data:            expected,
                    backgroundColor: 'rgba(1,41,74,0.7)',
                    borderColor:     'rgba(1,41,74,0.9)',
                    borderWidth:     1,
                },
                {
                    label:           'Collected',
                    data:            collected,
                    backgroundColor: 'rgba(243,158,18,0.7)',
                    borderColor:     'rgba(243,158,18,0.9)',
                    borderWidth:     1,
                },
            ],
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'top' } },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { callback: v => '$' + v.toLocaleString() },
                },
            },
        },
    });
}

function renderBlYoyChart(thisYearData, priorYearData) {
    if (!priorYearData) return;

    if (_billingCharts.yoy) {
        _billingCharts.yoy.destroy();
        delete _billingCharts.yoy;
    }

    const canvas = document.getElementById('blYoyChart');
    if (!canvas) return;

    const months      = Object.keys(thisYearData).sort();
    const labels      = months.map(k => thisYearData[k].label);
    const thisCollected  = months.map(k => Math.round(thisYearData[k].collected));
    const priorCollected = months.map((k, i) => {
        const priorKey = Object.keys(priorYearData).sort()[i];
        return priorKey ? Math.round(priorYearData[priorKey].collected) : 0;
    });

    _billingCharts.yoy = new Chart(canvas.getContext('2d'), {
        type: 'line',
        data: {
            labels,
            datasets: [
                {
                    label:           'This Year',
                    data:            thisCollected,
                    borderColor:     'rgba(1,41,74,0.9)',
                    backgroundColor: 'rgba(1,41,74,0.1)',
                    tension:         0.3,
                    fill:            true,
                },
                {
                    label:           'Prior Year',
                    data:            priorCollected,
                    borderColor:     'rgba(243,158,18,0.8)',
                    backgroundColor: 'rgba(243,158,18,0.08)',
                    borderDash:      [5, 4],
                    tension:         0.3,
                    fill:            false,
                },
            ],
        },
        options: {
            responsive: true,
            plugins: { legend: { position: 'top' } },
            scales: {
                y: {
                    beginAtZero: true,
                    ticks: { callback: v => '$' + v.toLocaleString() },
                },
            },
        },
    });
}

function renderDiscountSummaryTable(invoices, container) {
    const byFamily = {};
    invoices.forEach(inv => {
        const disc = parseFloat(inv.discount_amount || 0);
        if (!disc) return;
        const name = inv.parent_name || inv.family_id || '';
        if (!byFamily[inv.family_id]) byFamily[inv.family_id] = { name, total: 0 };
        byFamily[inv.family_id].total += disc;
    });

    const entries = Object.values(byFamily).sort((a, b) => b.total - a.total);

    if (!entries.length) {
        const p = document.createElement('p');
        p.className   = 'empty-hint';
        p.textContent = 'No discounts applied in this period.';
        if (container) container.appendChild(p);
        return;
    }

    const rows = entries.map(e =>
        `<tr><td>${escHtml(e.name)}</td><td>$${e.total.toFixed(2)}</td></tr>`
    ).join('');

    const div = document.createElement('div');
    div.className = 'table-wrapper';
    div.innerHTML = `
        <table>
            <thead><tr><th>Family</th><th>Total Discount</th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;
    if (container) container.appendChild(div);
}

function renderManualRevenueTable(year, monthData, manualRevenue, container) {
    // MONTH_NAMES is defined in supabase.js (loaded first) and shared globally.
    const rows = Object.entries(monthData).map(([moKey, mo], i) => {
        const hasInvoices = mo.invoiceTotal > 0;
        const manual = mo.manualAmt || '';
        return `<tr>
            <td style="padding:6px 12px">${MONTH_NAMES[i]}</td>
            <td style="padding:6px 12px;color:${hasInvoices ? 'var(--navy)' : 'var(--text-muted)'}">
                ${hasInvoices ? `$${mo.invoiceTotal.toFixed(2)} (${hasInvoices ? 'from registrations' : ''})` : '—'}
            </td>
            <td style="padding:6px 12px">
                ${hasInvoices
                    ? '<span style="color:var(--text-muted);font-size:.85em">n/a — using registration data</span>'
                    : `<input type="number" step="0.01" min="0" placeholder="0.00"
                          value="${escHtml(String(manual))}"
                          data-month="${moKey}"
                          class="bl-manual-rev-input"
                          style="width:120px;padding:4px 8px;border:1px solid var(--border);border-radius:4px">`
                }
            </td>
        </tr>`;
    }).join('');

    const wrap = document.createElement('div');
    wrap.style.marginTop = '24px';
    wrap.innerHTML = `
        <h4 style="margin-bottom:8px">Manual Revenue Overrides
            <span style="font-size:.78em;font-weight:400;color:var(--text-muted);margin-left:8px">
                For months without family-level registration data — enter a total. Saves automatically.
            </span>
        </h4>
        <table style="border-collapse:collapse;font-size:.9em;width:100%;max-width:640px">
            <thead>
                <tr style="background:var(--warm-gray)">
                    <th style="padding:6px 12px;text-align:left">Month</th>
                    <th style="padding:6px 12px;text-align:left">Registration Revenue</th>
                    <th style="padding:6px 12px;text-align:left">Manual Override</th>
                </tr>
            </thead>
            <tbody>${rows}</tbody>
        </table>
        <p id="blManualRevStatus" style="font-size:.85em;color:var(--text-muted);margin-top:6px"></p>`;
    if (container) container.appendChild(wrap);

    wrap.querySelectorAll('.bl-manual-rev-input').forEach(input => {
        input.addEventListener('change', async () => {
            const month = input.dataset.month;
            const val   = parseFloat(input.value) || 0;
            const current = await fetchSetting('billing_manual_revenue') || {};
            if (val > 0) current[month] = val; else delete current[month];
            await upsertSetting('billing_manual_revenue', current);
            const status = document.getElementById('blManualRevStatus');
            if (status) {
                status.textContent = `Saved manual override for ${month}.`;
                setTimeout(() => { status.textContent = ''; }, 2500);
            }
        });
    });
}

function exportBlDashCsv() {
    const container  = document.getElementById('blDashContent');
    const year       = container?.dataset.metricsYear || new Date().getFullYear();

    // Re-read from last computed metrics via DOM isn't possible — we need to re-read from last run.
    // Since we don't cache metrics globally, we rebuild from month data in the chart.
    const chart = _billingCharts.main;
    if (!chart) {
        alert('Please generate the dashboard first.');
        return;
    }

    const labels   = chart.data.labels;
    const expected = chart.data.datasets[0].data;
    const collected = chart.data.datasets[1].data;

    const header = ['Month', 'Expected', 'Collected', 'Outstanding', 'Collection Rate'];
    const rows   = labels.map((lbl, i) => {
        const exp   = expected[i]  || 0;
        const col   = collected[i] || 0;
        const out   = Math.max(0, exp - col);
        const rate  = exp > 0 ? ((col / exp) * 100).toFixed(1) + '%' : '—';
        return [csvCell(lbl), csvCell(exp.toFixed(2)), csvCell(col.toFixed(2)),
                csvCell(out.toFixed(2)), csvCell(rate)];
    });

    const csv = [header.map(csvCell), ...rows].map(r => r.join(',')).join('\n');
    downloadFile(`billing-dashboard-${year}.csv`, 'text/csv', csv);
}

// ============================================================
// PRIVATE HELPERS
// ============================================================
function _todayStr() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function _fmtDate(dateStr) {
    if (!dateStr) return '—';
    try {
        return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
        });
    } catch (_) {
        return dateStr;
    }
}

function _fmtDiscount(discountType, discountAmount) {
    if (!discountType || discountType === 'none') return '<span style="color:var(--muted)">None</span>';
    if (discountType === 'staff')  return '<span class="bl-badge bl-badge-partial">Staff (100%)</span>';
    if (discountType === 'custom') return `<span class="bl-badge bl-badge-noinv">-$${parseFloat(discountAmount || 0).toFixed(2)}</span>`;
    return escHtml(discountType);
}

function _invStatusBadge(status) {
    const map = {
        draft:     ['bl-badge-noinv',   'Draft'],
        finalized: ['bl-badge-partial', 'Finalized'],
        paid:      ['bl-badge-paid',    'Paid'],
        partial:   ['bl-badge-partial', 'Partial'],
    };
    const [cls, label] = map[status] || ['bl-badge-noinv', status || 'Unknown'];
    return `<span class="bl-badge ${cls}">${label}</span>`;
}

function _normalizeImportDate(raw) {
    if (!raw) return _todayStr();
    // Try to parse common date formats
    const d = new Date(raw);
    if (!isNaN(d.getTime())) {
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
    }
    // MM/DD/YYYY
    const mdy = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy) {
        const [, m, dd, yyyy] = mdy;
        return `${yyyy}-${m.padStart(2,'0')}-${dd.padStart(2,'0')}`;
    }
    return _todayStr();
}
