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

    // ProCare AR aging — default to Jan of current year through current month
    {
        const now = new Date();
        const cur = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const jan = `${now.getFullYear()}-01`;
        const fromEl = document.getElementById('procareArFrom');
        const toEl   = document.getElementById('procareArTo');
        if (fromEl && !fromEl.value) fromEl.value = jan;
        if (toEl   && !toEl.value)   toEl.value   = cur;
    }
    document.getElementById('loadProcareArBtn')
        ?.addEventListener('click', loadProcareArView);
    document.getElementById('exportProcareArBtn')
        ?.addEventListener('click', exportProcareArXlsx);

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
function openRecordPaymentModal(familyId, invoiceId, invoiceFinalAmount) {
    // Derive the display name from loaded data rather than trusting a value
    // interpolated into the inline onclick (see FS4: names could break out of
    // the JS-string context and inject script).
    const familyName = _arData.find(r => r.familyId === familyId)?.familyName || 'Family';
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
        try { recordedBy = await getAdminEmail(); } catch (_) {}

        const row = {
            family_id:      familyId,
            invoice_id:     invoiceId || null,
            amount:         amount,
            payment_date:   date,
            payment_method: method || 'other',
            note:           note,
            created_by:     recordedBy,
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

        // ProCare xlsx files have a title row then a blank row before the real headers.
        // Scan the first 5 rows to find the actual header row.
        const PROCARE_COLS = ['Date','Student','Type','Description','Due Date','Status','Amount'];
        let headerRowIdx = 0;
        for (let i = 0; i < Math.min(5, rows.length); i++) {
            if (PROCARE_COLS.every((col, j) => (String(rows[i][j] || '')).trim() === col)) {
                headerRowIdx = i;
                break;
            }
        }

        _csvHeaders    = (rows[headerRowIdx] || []).map(h => String(h));
        _csvParsedRows = rows.slice(headerRowIdx + 1).filter(r => r.some(cell => cell !== ''));

        // Auto-detect ProCare format: Date, Student, Type, Description, Due Date, Status, Amount
        const isProCare = PROCARE_COLS.every((col, i) => (_csvHeaders[i] || '').trim() === col);
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
        const adminEmail = await getAdminEmail();
        const batch = await insertImportBatch({ source: 'procare_xlsx', imported_by: adminEmail, filename: '', row_count: valid.length, notes: `ProCare import — ${valid.length} rows` });
        const batchId = batch?.id || null;

        // Aggregate invoice rows by (familyId, month) so each family gets one invoice record per month
        const invoiceMap = new Map(); // key: `${familyId}|${month}`
        for (const row of valid) {
            if (row.type !== 'Invoice') continue;
            const month = row.dateVal.substring(0, 7); // YYYY-MM
            const key = `${row.familyId}|${month}`;
            if (!invoiceMap.has(key)) invoiceMap.set(key, { familyId: row.familyId, month, amount: 0 });
            invoiceMap.get(key).amount += row.amount;
        }

        let ok = 0, fail = 0;

        // Import invoices → billing_invoices, tracking each invoice's id by (familyId, month)
        // so payments below can be linked to the invoice they're paying off.
        const invoiceIdMap = new Map(); // key: `${familyId}|${month}` -> invoice id
        for (const { familyId, month, amount } of invoiceMap.values()) {
            try {
                const cycle = await getOrCreateBillingCycle(month);
                const invoice = await upsertBillingInvoice({
                    cycle_id:     cycle.id,
                    family_id:    familyId,
                    base_amount:  amount,
                    final_amount: amount,
                    status:       'finalized',
                });
                if (invoice?.id) invoiceIdMap.set(`${familyId}|${month}`, invoice.id);
                ok++;
            } catch (_) { fail++; }
        }

        // Also look up any invoices that already existed before this import (e.g. created
        // by a prior import run) so payments can link to those too.
        const paymentMonths = new Set(
            valid.filter(r => r.type !== 'Invoice').map(r => r.dateVal.substring(0, 7))
        );
        for (const month of paymentMonths) {
            try {
                const cycle = await getOrCreateBillingCycle(month);
                const existingInvoices = await fetchInvoicesForCycle(cycle.id);
                existingInvoices.forEach(inv => {
                    const key = `${inv.family_id}|${month}`;
                    if (!invoiceIdMap.has(key)) invoiceIdMap.set(key, inv.id);
                });
            } catch (_) { /* leave unlinked if lookup fails */ }
        }

        // Import payments and credits → billing_payments, linking to the matching invoice
        // (same family + same month as the payment date) when one exists.
        for (const row of valid) {
            if (row.type === 'Invoice') continue;
            const method = row.type === 'Credit' ? 'procare_credit' : 'procare_payment';
            const month = row.dateVal.substring(0, 7);
            const invoiceId = invoiceIdMap.get(`${row.familyId}|${month}`) || null;
            try {
                await insertBillingPayment({
                    family_id:       row.familyId,
                    invoice_id:      invoiceId,
                    amount:          row.amount,
                    payment_date:    row.dateVal,
                    payment_method:  method,
                    note:            row.description,
                    import_batch_id: batchId,
                    created_by:      adminEmail,
                });
                ok++;
            } catch (_) { fail++; }
        }

        const invoiceCount = invoiceMap.size;
        const paymentCount = valid.filter(r => r.type !== 'Invoice').length;
        wrap.innerHTML = `<p class="empty-hint" style="color:#15803d">✓ Imported ${invoiceCount} invoice${invoiceCount !== 1 ? 's' : ''} and ${paymentCount} payment/credit row${paymentCount !== 1 ? 's' : ''}${fail ? ` (${fail} failed)` : ''}. Upload another file to import more.</p>`;
    } catch (err) {
        if (btn) { btn.disabled = false; btn.textContent = 'Retry Import'; }
        alert('Import failed: ' + err.message);
    }
}

// ============================================================
// PROCARE AR AGING VIEW
// ============================================================

let _procareArData = [];

// Build YYYY-MM list between two YYYY-MM strings (inclusive)
function _monthRange(from, to) {
    const months = [];
    let [y, m] = from.split('-').map(Number);
    const [ey, em] = to.split('-').map(Number);
    while (y < ey || (y === ey && m <= em)) {
        months.push(`${y}-${String(m).padStart(2, '0')}`);
        m++; if (m > 12) { m = 1; y++; }
    }
    return months;
}

async function loadProcareArView() {
    const wrap   = document.getElementById('procareArWrap');
    const expBtn = document.getElementById('exportProcareArBtn');
    if (!wrap) return;
    wrap.innerHTML = '<p class="empty-hint">Loading…</p>';
    if (expBtn) expBtn.style.display = 'none';

    // Read month range from pickers
    const now     = new Date();
    const todayM  = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const fromVal = document.getElementById('procareArFrom')?.value || `${now.getFullYear()}-01`;
    const toVal   = document.getElementById('procareArTo')?.value   || todayM;

    try {
        // Load payments + families + registrations in parallel
        const [payments, families] = await Promise.all([
            fetchAllBillingPayments(),
            fetchAllFamilies({ includeArchived: true }),
        ]);
        allFamiliesData = families;
        _discountMap = null;

        // Refresh registrations if stale
        if (!allRegistrations.length) {
            const fresh = await fetchAllRegistrations();
            if (fresh?.length) allRegistrations = fresh;
        }

        // Only successful ProCare payments
        const procarePaid = payments.filter(p => p.payment_method === 'procare_payment');

        if (!procarePaid.length) {
            wrap.innerHTML = '<p class="empty-hint">No ProCare payments imported yet. Upload a ProCare export file above.</p>';
            return;
        }

        const familyById = new Map(families.map(f => [String(f.id), f]));

        // Group payments by family_id + month
        const paidByKey = new Map(); // key = familyId:month → total paid
        procarePaid.forEach(p => {
            const month = (p.payment_date || '').substring(0, 7);
            if (!month) return;
            const key = `${p.family_id}:${month}`;
            paidByKey.set(key, (paidByKey.get(key) || 0) + (parseFloat(p.amount) || 0));
        });

        // For each month in range, run billing calculation to get "owed" per family
        const months = _monthRange(fromVal, toVal);
        const today  = new Date(); today.setHours(0,0,0,0);
        const MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

        const resultMap = new Map(); // key = familyId:month

        for (const month of months) {
            let overrideRows = [];
            try { overrideRows = await fetchBillingOverrides(month); } catch (_) {}
            const overridesMap = new Map(overrideRows.map(r => [
                `${(r.parent_email || '').toLowerCase()}:${(r.child_name || '').toLowerCase()}`,
                parseFloat(r.override_amount),
            ]));

            const billingData = _buildFamilyBillingData(month, overridesMap);

            billingData.forEach(fam => {
                const matchedFamily = families.find(f =>
                    (f.parent_email  || '').toLowerCase() === (fam.parentEmail || '').toLowerCase() ||
                    (f.parent2_email || '').toLowerCase() === (fam.parentEmail || '').toLowerCase()
                );
                if (!matchedFamily) return;

                const owed = fam.children.reduce((s, c) => {
                    const billed = c.hasOverride ? c.overrideAmount : c.subtotal;
                    return s + billed + (c.changeFees || 0);
                }, 0);
                if (owed <= 0) return;

                const key  = `${matchedFamily.id}:${month}`;
                const paid = paidByKey.get(key) || 0;
                const [y, mo] = month.split('-').map(Number);
                const dueDate = new Date(y, mo, 0); // last day of billing month
                const balance = Math.max(0, owed - paid);
                const daysOverdue = balance > 0 ? Math.floor((today - dueDate) / 86400000) : 0;

                resultMap.set(key, {
                    familyId:    matchedFamily.id,
                    familyName:  matchedFamily.parent_name || fam.parentName || '(unknown)',
                    familyEmail: matchedFamily.parent_email || fam.parentEmail || '',
                    month,
                    monthLabel:  `${MONTH_SHORT[mo - 1]} ${y}`,
                    owed:        Math.round(owed * 100) / 100,
                    paid:        Math.round(paid * 100) / 100,
                    balance:     Math.round(balance * 100) / 100,
                    dueDate:     dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                    daysOverdue,
                });
            });
        }

        // Also include any ProCare payments that don't match a billing row
        // (payments in months outside the range or for families with no registrations)
        paidByKey.forEach((paid, key) => {
            if (resultMap.has(key)) return;
            const [familyId, month] = key.split(':');
            if (month < fromVal || month > toVal) return;
            const fam = familyById.get(familyId);
            if (!fam) return;
            const [y, mo] = month.split('-').map(Number);
            const dueDate = new Date(y, mo, 0);
            resultMap.set(key, {
                familyId,
                familyName:  fam.parent_name || '',
                familyEmail: fam.parent_email || '',
                month,
                monthLabel:  `${MONTH_SHORT[mo - 1]} ${y}`,
                owed:        0,
                paid:        Math.round(paid * 100) / 100,
                balance:     0,
                dueDate:     dueDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
                daysOverdue: 0,
            });
        });

        _procareArData = [...resultMap.values()].sort((a, b) => {
            // Most overdue first, then by month desc, then by family name
            if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
            if (b.month !== a.month) return b.month.localeCompare(a.month);
            return (a.familyName || '').localeCompare(b.familyName || '');
        });

        renderProcareArTable();
        if (expBtn && _procareArData.length) expBtn.style.display = '';
    } catch (err) {
        wrap.innerHTML = `<p class="empty-hint">Error: ${escHtml(err.message)}</p>`;
        console.error('loadProcareArView:', err);
    }
}

// Collapse the per-family-per-month rows in _procareArData into one row per family,
// summed across the selected date range. daysOverdue/dueDate reflect the oldest
// month that still has a balance (the worst-case aging for that family).
function _groupProcareArByFamily(data) {
    const map = new Map();
    data.forEach(r => {
        if (!map.has(r.familyId)) {
            map.set(r.familyId, {
                familyId:    r.familyId,
                familyName:  r.familyName,
                familyEmail: r.familyEmail,
                owed:        0,
                paid:        0,
                balance:     0,
                daysOverdue: 0,
                dueDate:     r.dueDate,
                monthsBilled: 0,
            });
        }
        const g = map.get(r.familyId);
        g.owed    += r.owed;
        g.paid    += r.paid;
        g.balance += r.balance;
        g.monthsBilled++;
        if (r.balance > 0 && r.daysOverdue > g.daysOverdue) {
            g.daysOverdue = r.daysOverdue;
            g.dueDate     = r.dueDate;
        }
    });
    return [...map.values()].sort((a, b) => {
        if (b.daysOverdue !== a.daysOverdue) return b.daysOverdue - a.daysOverdue;
        if (b.balance !== a.balance) return b.balance - a.balance;
        return (a.familyName || '').localeCompare(b.familyName || '');
    });
}

function renderProcareArTable() {
    const wrap = document.getElementById('procareArWrap');
    if (!wrap || !_procareArData.length) return;

    const grouped = _groupProcareArByFamily(_procareArData);

    const rowBg = d => d > 30 ? '#fef2f2' : d > 0 ? '#fffbeb' : '#f0fdf4';
    const ageBadge = d => {
        if (d <= 0) return '<span style="background:#dcfce7;color:#166534;font-size:.75em;padding:2px 7px;border-radius:3px;white-space:nowrap;">Current</span>';
        if (d <= 30) return `<span style="background:#fef9c3;color:#854d0e;font-size:.75em;padding:2px 7px;border-radius:3px;white-space:nowrap;">${d}d overdue</span>`;
        return `<span style="background:#fee2e2;color:#991b1b;font-size:.75em;padding:2px 7px;border-radius:3px;white-space:nowrap;">${d}d overdue</span>`;
    };

    const rows = grouped.map(r => `
        <tr style="background:${rowBg(r.daysOverdue)}">
            <td>${escHtml(r.familyName)}<br><small style="color:var(--muted)">${escHtml(r.familyEmail)}</small></td>
            <td>${r.monthsBilled} mo${r.monthsBilled !== 1 ? 's' : ''}</td>
            <td class="report-num">${r.owed > 0 ? '$' + r.owed.toFixed(2) : '—'}</td>
            <td class="report-num">${r.paid > 0 ? '$' + r.paid.toFixed(2) : '—'}</td>
            <td class="report-num" style="font-weight:${r.balance > 0 ? '600' : 'normal'}">${r.balance > 0 ? '$' + r.balance.toFixed(2) : '—'}</td>
            <td>${r.balance > 0 ? escHtml(r.dueDate) : '—'}</td>
            <td>${ageBadge(r.daysOverdue)}</td>
        </tr>`).join('');

    const totOwed    = grouped.reduce((s, r) => s + r.owed, 0);
    const totPaid    = grouped.reduce((s, r) => s + r.paid, 0);
    const totBalance = grouped.reduce((s, r) => s + r.balance, 0);
    const overdueCount = grouped.filter(r => r.daysOverdue > 0).length;

    wrap.innerHTML = `
        ${overdueCount > 0 ? `<p style="margin:0 0 .5rem 0;font-size:.875rem;color:#991b1b;font-weight:600;">${overdueCount} famil${overdueCount !== 1 ? 'ies' : 'y'} with outstanding balance</p>` : ''}
        <div class="table-wrapper" style="margin-top:.25rem">
            <table class="report-table" id="procareArTable">
                <thead><tr>
                    <th>Family</th><th>Months Billed</th><th>Owed</th><th>Paid (ProCare)</th><th>Balance</th><th>Due Since</th><th>Aging</th>
                </tr></thead>
                <tbody>${rows}</tbody>
                <tfoot><tr class="report-total-row">
                    <td colspan="2"><strong>Total</strong></td>
                    <td class="report-num"><strong>$${totOwed.toFixed(2)}</strong></td>
                    <td class="report-num"><strong>$${totPaid.toFixed(2)}</strong></td>
                    <td class="report-num"><strong>$${totBalance.toFixed(2)}</strong></td>
                    <td colspan="2"></td>
                </tr></tfoot>
            </table>
        </div>`;
}

function exportProcareArXlsx() {
    if (!_procareArData.length) return;
    const grouped = _groupProcareArByFamily(_procareArData);
    const rows = grouped.map(r => ({
        'Family':        r.familyName,
        'Email':         r.familyEmail,
        'Months Billed': r.monthsBilled,
        'Owed':          r.owed,
        'Paid (ProCare)': r.paid,
        'Balance':       r.balance,
        'Due Since':     r.balance > 0 ? r.dueDate : '',
        'Days Overdue':  r.daysOverdue > 0 ? r.daysOverdue : 0,
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'ProCare AR');
    ws['!cols'] = Object.keys(rows[0]).map(k => ({ wch: Math.max(k.length, ...rows.map(r => String(r[k] ?? '').length)) }));
    XLSX.writeFile(wb, `procare-ar-${new Date().toISOString().slice(0,10)}.xlsx`);
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
    try { recordedBy = await getAdminEmail(); } catch (_) {}

    try {
        // Insert batch record
        const batchRow = await insertImportBatch({
            imported_by: recordedBy,
            filename:    '',
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
                payment_method:  r.method || 'other',
                note:            `Imported from CSV`,
                created_by:      recordedBy,
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
            ? `<button class="btn-xs btn-warn" onclick="doSetFamilyLockWithReason('${escHtml(r.familyId)}', false, null)">Unlock</button>`
            : `<button class="btn-xs btn-danger" onclick="openLockWithReasonModal('${escHtml(r.familyId)}')">Lock</button>`;

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
                    ? `<button class="btn-xs" onclick="openRecordPaymentModal('${escHtml(r.familyId)}','${escHtml(String(r.invoiceId))}',${r.billed})">💳 Payment</button>`
                    : `<button class="btn-xs" onclick="openRecordPaymentModal('${escHtml(r.familyId)}',null,null)">💳 Payment</button>`
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
            const invMonth = inv.billing_cycles?.month || null;
            // Match payments linked by invoice_id, or by payment_date falling in the invoice's month (for imports)
            const invPayments = payments.filter(p => {
                if (p.invoice_id && String(p.invoice_id) === String(inv.id)) return true;
                if (!p.invoice_id && invMonth && p.payment_date?.startsWith(invMonth)) return true;
                return false;
            });
            const totalPaid   = invPayments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
            return `<tr>
                <td>${escHtml(invMonth || '—')}</td>
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
                    ${topFinalAmt != null ? topFinalAmt : 'null'}
                )">💳 Record Payment</button>
            </div>`;

        // Include payments linked by invoice_id, or (for imports) by payment_date in the current AR month
        const invPayments = payments.filter(p => {
            if (topInvoice && p.invoice_id && String(p.invoice_id) === String(topInvoice)) return true;
            if (!p.invoice_id && _blArMonth && p.payment_date?.startsWith(_blArMonth)) return true;
            if (!topInvoice) return true;
            return false;
        });

        renderPaymentHistory(invPayments, topFinalAmt, payHistContainerId);
    } catch (err) {
        detailTr.querySelector('td').innerHTML =
            `<p class="empty-hint">Error loading details: ${escHtml(err.message)}</p>`;
    }
}

function openLockWithReasonModal(familyId) {
    // Name derived from loaded data, not from the inline onclick (FS4).
    const familyName = _arData.find(r => r.familyId === familyId)?.familyName || 'Family';
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

async function doSetFamilyLockWithReason(familyId, locked, reason) {
    // Name derived from loaded data, not from the inline onclick (FS4).
    const familyName = _arData.find(r => r.familyId === familyId)?.familyName || '';
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

// ============================================================
// INVOICES  — the middle of the money flow
// ============================================================
// The portal could already see what was owed (Accounts Receivable),
// compute what to charge (Family Billing Summary) and record what was
// paid (ProCare Import) — but nothing issued the bill. 496 rows sat in
// billing_invoices at status='draft' because the draft → issued path
// had no UI. This is that UI.
//
// It computes NOTHING new: _buildFamilyBillingData() is the same
// function behind Family Billing Summary and the dashboard's billed
// figure, so money stays calculated in exactly one place. Invoices is a
// workflow over that output — draft, adjust, override, issue, export.

let _invMonth   = '';
let _invRows    = [];     // [{ familyId, name, email, children, days, base, discount, changeFees, total, invoice }]
let _invCycleId = null;
let _invBusy    = false;
let _invAdjustments = [];  // pending draft adjustments awaiting review

function _invDefaultMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** Entry point — called by the portal shell when the Invoices tool opens. */
async function renderInvoicesTool() {
    const monthEl = document.getElementById('invMonth');
    if (monthEl && !monthEl.value) monthEl.value = _invMonth || _invDefaultMonth();
    _invMonth = monthEl?.value || _invDefaultMonth();
    await loadInvoicesForMonth();
}

async function loadInvoicesForMonth() {
    const body = document.getElementById('invBody');
    if (!body) return;
    body.innerHTML = '<p class="empty-hint">Loading invoices…</p>';
    try {
        const families = (allFamiliesData && allFamiliesData.length)
            ? allFamiliesData
            : await fetchAllFamilies({ includeArchived: false });

        const overrideRows = await fetchBillingOverrides(_invMonth);
        const overridesMap = new Map();
        overrideRows.forEach(r => overridesMap.set(
            `${(r.parent_email || '').toLowerCase()}:${(r.child_name || '').toLowerCase()}`,
            parseFloat(r.override_amount || 0)));

        // Same calculation as Family Billing Summary — one source of truth.
        const billing = _buildFamilyBillingData(_invMonth, overridesMap);

        // Existing invoice rows for this month, so status/send stamps survive.
        const cycle = await getOrCreateBillingCycle(_invMonth);
        _invCycleId = cycle?.id ?? null;
        const existing = _invCycleId ? await fetchInvoicesForCycle(_invCycleId) : [];

        // A family can now hold several rows for one month: the original plus
        // any adjustments. The table shows the ORIGINAL — keying the map on
        // family_id alone would let a later adjustment shadow it.
        const byFamily = new Map(
            existing.filter(i => (i.invoice_type || 'original') === 'original')
                    .map(i => [String(i.family_id), i])
        );

        // Adjustments awaiting the director's review, newest first.
        _invAdjustments = existing
            .filter(i => i.invoice_type === 'adjustment' && i.status === 'draft')
            .map(i => ({
                id:     i.id,
                amount: Number(i.final_amount) || 0,
                reason: i.reason || 'Schedule change',
                name:   i.families?.parent_name  || '(no name)',
                email:  i.families?.parent_email || '',
            }))
            .sort((a, b) => Math.abs(b.amount) - Math.abs(a.amount));

        _invRows = billing.map(fam => {
            const match = families.find(f =>
                (f.parent_email  || '').toLowerCase() === (fam.parentEmail || '').toLowerCase() ||
                (f.parent2_email || '').toLowerCase() === (fam.parentEmail || '').toLowerCase());
            let base = 0, discount = 0, changeFees = 0, total = 0, days = 0, overridden = false;
            (fam.children || []).forEach(c => {
                base       += (c.subtotal || 0) + (c.changeFees || 0) + (c.discountDollar || 0) + (c.sibDiscount || 0);
                discount   += (c.discountDollar || 0) + (c.sibDiscount || 0);
                changeFees += c.changeFees || 0;
                days       += (c.fullDays || 0) + (c.halfDays || 0);
                total      += c.hasOverride
                    ? parseFloat(c.overrideAmount || 0)
                    : (c.subtotal || 0) + (c.changeFees || 0);
                if (c.hasOverride) overridden = true;
            });
            return {
                familyId:   match?.id || null,
                name:       fam.parentName || '(no name)',
                email:      fam.parentEmail || '',
                children:   (fam.children || []).map(c => c.childName).filter(Boolean),
                days,
                base:       Math.round(base * 100) / 100,
                discount:   Math.round(discount * 100) / 100,
                changeFees: Math.round(changeFees * 100) / 100,
                total:      Math.round(Math.max(0, total) * 100) / 100,
                overridden,
                invoice:    match ? byFamily.get(String(match.id)) || null : null,
            };
        });
        renderInvoiceList();
    } catch (err) {
        console.error('loadInvoicesForMonth:', err);
        body.innerHTML = `<p class="empty-hint">Could not load invoices — ${escHtml(err.message || 'unknown error')}</p>`;
    }
}

function _invStatusOf(row) {
    const inv = row.invoice;
    if (!inv)                       return 'unsaved';
    if (inv.status === 'void')      return 'void';
    if (inv.status === 'paid')      return 'paid';
    if (inv.status === 'partial')   return 'partial';
    if (inv.sent_at)                return 'sent';
    return 'draft';
}

const _INV_PILL = {
    unsaved: ['bl-badge-noinv',     'Not drafted'],
    draft:   ['bl-badge-finalized', 'Draft'],
    sent:    ['bl-badge-partial',   'Sent'],
    partial: ['bl-badge-partial',   'Part paid'],
    paid:    ['bl-badge-paid',      'Paid'],
    void:    ['bl-badge-noinv',     'Pre-system'],
};

// ── Adjustment review queue ──────────────────────────────────
// Adjustments never go out on their own. A schedule change to a month whose
// invoice has been sent drafts one of these; it waits here until the director
// issues it. Repeated edits update the same draft, so this lists one net
// adjustment per family, not one per click.
function renderAdjustmentQueue() {
    const wrap = document.getElementById('invAdjustments');
    if (!wrap) return;

    if (!_invAdjustments.length) {
        wrap.innerHTML = '';
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = '';

    const rows = _invAdjustments.map(a => {
        const isCredit = a.amount < 0;
        const amtTxt   = `${isCredit ? '−' : '+'}$${Math.abs(a.amount).toFixed(2)}`;
        const amtColor = isCredit ? 'var(--green-text)' : 'var(--mustard-dark)';
        return `
            <li style="display:flex;align-items:center;gap:.75rem;padding:.6rem .25rem;
                       border-bottom:1px solid var(--border)">
                <div style="flex:1;min-width:0">
                    <strong>${escHtml(a.name)}</strong>
                    <div style="font-size:.82em;color:var(--text-muted)">${escHtml(a.reason)}</div>
                </div>
                <strong style="color:${amtColor};font-variant-numeric:tabular-nums">${amtTxt}</strong>
                <button type="button" class="btn-primary btn-sm inv-adj-issue"
                        data-id="${a.id}" data-email="${escHtml(a.email)}">Issue</button>
                <button type="button" class="btn-ghost btn-sm inv-adj-discard"
                        data-id="${a.id}">Discard</button>
            </li>`;
    }).join('');

    const net = _invAdjustments.reduce((s, a) => s + a.amount, 0);
    wrap.innerHTML = `
        <div style="background:var(--sun-pale);border:1.5px solid var(--sun-lt);
                    border-radius:var(--radius-md);padding:.9rem 1rem;margin-bottom:1rem">
            <h3 style="margin:0 0 .15rem;font-size:1em;color:var(--navy)">
                Adjustments awaiting review (${_invAdjustments.length})
            </h3>
            <p style="margin:0 0 .5rem;font-size:.85em;color:var(--text-muted)">
                Days changed after these invoices were sent. Net
                ${net < 0 ? '−' : '+'}$${Math.abs(net).toFixed(2)}.
                Issuing records the adjustment as billed; it does not email.
            </p>
            <ul style="list-style:none;margin:0;padding:0">${rows}</ul>
        </div>`;

    wrap.querySelectorAll('.inv-adj-issue').forEach(btn => {
        btn.addEventListener('click', () => _invIssueAdjustment(btn.dataset.id, btn.dataset.email));
    });
    wrap.querySelectorAll('.inv-adj-discard').forEach(btn => {
        btn.addEventListener('click', () => _invDiscardAdjustment(btn.dataset.id));
    });
}

async function _invIssueAdjustment(id, email) {
    if (!confirm('Issue this adjustment?\n\nIt becomes part of the family\'s bill for the month and can no longer be edited. This records it — it does not email.')) return;
    try {
        await markInvoicesSent([{ id: Number(id), email }]);
        await loadInvoicesForMonth();
        showAdminNote('Adjustment issued.');
    } catch (err) {
        alert('Could not issue that adjustment: ' + (err.message || err));
    }
}

async function _invDiscardAdjustment(id) {
    if (!confirm('Discard this adjustment?\n\nThe schedule change stays; only the pending bill for it is withdrawn. It will reappear if the days change again.')) return;
    try {
        await deleteDraftAdjustment(Number(id));
        await loadInvoicesForMonth();
        showAdminNote('Adjustment discarded.');
    } catch (err) {
        alert('Could not discard that adjustment: ' + (err.message || err));
    }
}

function renderInvoiceList() {
    const body = document.getElementById('invBody');
    renderAdjustmentQueue();
    if (!body) return;
    if (!_invRows.length) {
        body.innerHTML = '<p class="empty-hint">No families have booked days in this month, so there is nothing to bill.</p>';
        _invRenderSummary();
        return;
    }

    const rows = _invRows.map((r, i) => {
        const st = _invStatusOf(r);
        const [cls, label] = _INV_PILL[st];
        const sentNote = r.invoice?.sent_at
            ? `<br><small style="color:var(--text-muted)">sent ${escHtml(friendlyShort(String(r.invoice.sent_at).slice(0, 10)))}</small>`
            : '';
        return `<tr>
            <td>
                <strong>${escHtml(r.name)}</strong>${sentNote}
                <br><small style="color:var(--text-muted)">${escHtml(r.email || 'no email on file')}</small>
            </td>
            <td>${escHtml(r.children.join(', ') || '—')}</td>
            <td style="text-align:center">${r.days}</td>
            <td style="text-align:right">$${r.base.toFixed(2)}</td>
            <td style="text-align:right">${r.discount ? '−$' + r.discount.toFixed(2) : '—'}</td>
            <td style="text-align:right">${r.changeFees ? '$' + r.changeFees.toFixed(2) : '—'}</td>
            <td style="text-align:right"><strong>$${r.total.toFixed(2)}</strong>${
                r.overridden ? '<br><small style="color:var(--tang)">overridden</small>' : ''}</td>
            <td><span class="bl-badge ${cls}">${label}</span></td>
            <td style="white-space:nowrap">
                ${st === 'sent' || st === 'paid' || st === 'partial'
                    ? `<button class="btn-xs" data-inv-unsend="${i}" ${st === 'sent' ? '' : 'disabled'}>Undo send</button>`
                    : `<button class="btn-xs" data-inv-send="${i}" ${r.familyId ? '' : 'disabled title="No family record matched — fix the email in Family Directory"'}>Mark sent</button>`}
            </td>
        </tr>`;
    }).join('');

    body.innerHTML = `
        <div class="table-wrapper">
            <table class="report-table">
                <thead><tr>
                    <th>Family</th><th>Children</th><th style="text-align:center">Days</th>
                    <th style="text-align:right">Base</th><th style="text-align:right">Discount</th>
                    <th style="text-align:right">Change fees</th><th style="text-align:right">Total</th>
                    <th>Status</th><th></th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    _invRenderSummary();
}

function _invRenderSummary() {
    const el = document.getElementById('invSummary');
    if (!el) return;
    const total   = _invRows.reduce((a, r) => a + r.total, 0);
    const drafted = _invRows.filter(r => r.invoice).length;
    const sent    = _invRows.filter(r => r.invoice?.sent_at).length;
    const unmatched = _invRows.filter(r => !r.familyId).length;
    el.innerHTML = `
        <div class="ap-stat"><div class="ap-stat-label">Families</div><div class="ap-stat-value">${_invRows.length}</div></div>
        <div class="ap-stat"><div class="ap-stat-label">Total billed</div><div class="ap-stat-value">$${Math.round(total).toLocaleString()}</div></div>
        <div class="ap-stat"><div class="ap-stat-label">Drafted</div><div class="ap-stat-value">${drafted} of ${_invRows.length}</div></div>
        <div class="ap-stat"><div class="ap-stat-label">Sent</div><div class="ap-stat-value ${sent ? 'is-ok' : 'is-alert'}">${sent}</div></div>
        ${unmatched ? `<div class="ap-stat"><div class="ap-stat-label">No family record</div><div class="ap-stat-value is-alert">${unmatched}</div></div>` : ''}`;
}

/** Write the current calculation into billing_invoices as drafts. */
async function saveInvoiceDrafts() {
    if (_invBusy) return;
    const btn = document.getElementById('invDraftBtn');
    _invBusy = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const cycle = await getOrCreateBillingCycle(_invMonth);
        _invCycleId = cycle.id;
        let saved = 0;
        for (const r of _invRows) {
            if (!r.familyId) continue;
            // Never overwrite a bill that has already gone out — once issued,
            // a change becomes an adjustment, not an edit.
            if (r.invoice?.sent_at) continue;
            // Never revive a frozen pre-system month.
            if (r.invoice?.status === 'void') continue;
            const row = await upsertBillingInvoice({
                cycle_id:          _invCycleId,
                family_id:         r.familyId,
                base_amount:       r.base,
                discount_amount:   r.discount,
                adjustment_amount: 0,
                adjustment_note:   '',
                final_amount:      r.total,
                status:            'draft',
            });
            r.invoice = row;
            saved++;
        }
        await logAdminAction('draft', 'billing_invoice', null, { month: _invMonth, count: saved });
        renderInvoiceList();
        showAdminNote(`${saved} invoice${saved === 1 ? '' : 's'} drafted for ${_invMonth}.`);
    } catch (err) {
        alert('Could not save drafts: ' + (err.message || err));
    } finally {
        _invBusy = false;
        if (btn) { btn.disabled = false; btn.textContent = '💾 Save drafts'; }
    }
}

/**
 * Records that the bills went out. This stamps the rows and writes an
 * audit entry — it does not email anything. There is no invoice email
 * function in this project yet; see the note under the table.
 */
async function markAllInvoicesSent() {
    const pending = _invRows.filter(r => r.invoice && !r.invoice.sent_at);
    if (!pending.length) { alert('Every drafted invoice for this month is already marked sent.'); return; }
    if (!confirm(`Mark ${pending.length} invoice${pending.length === 1 ? '' : 's'} as sent for ${_invMonth}?\n\n` +
                 'This records the issue date — Accounts Receivable ages overdue from it. It does not email anything.')) return;
    const btn = document.getElementById('invSendBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Marking…'; }
    try {
        await markInvoicesSent(pending.map(r => ({ id: r.invoice.id, email: r.email })));
        await loadInvoicesForMonth();
        showAdminNote(`${pending.length} invoice${pending.length === 1 ? '' : 's'} marked sent.`);
    } catch (err) {
        alert('Could not mark those sent: ' + (err.message || err));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '🧾 Mark all as sent'; }
    }
}

function exportInvoicesCsv() {
    if (!_invRows.length) { alert('Nothing to export.'); return; }
    const header = ['Family', 'Email', 'Children', 'Days', 'Base', 'Discount', 'Change fees', 'Total', 'Status', 'Sent'];
    const lines = [header.join(',')].concat(_invRows.map(r => [
        csvCell(r.name), csvCell(r.email), csvCell(r.children.join('; ')), r.days,
        r.base.toFixed(2), r.discount.toFixed(2), r.changeFees.toFixed(2), r.total.toFixed(2),
        csvCell(_INV_PILL[_invStatusOf(r)][1]),
        csvCell(r.invoice?.sent_at ? String(r.invoice.sent_at).slice(0, 10) : ''),
    ].join(',')));
    downloadFile(`invoices-${_invMonth}.csv`, 'text/csv', lines.join('\n'));
}

/** Small inline confirmation under the toolbar — the admin CSS has no toast. */
function showAdminNote(msg) {
    const el = document.getElementById('invNote');
    if (!el) return;
    el.textContent = msg;
    setTimeout(() => { if (el.textContent === msg) el.textContent = ''; }, 6000);
}

function setupInvoices() {
    document.getElementById('invMonth')?.addEventListener('change', e => {
        _invMonth = e.target.value;
        loadInvoicesForMonth();
    });
    document.getElementById('invDraftBtn')?.addEventListener('click', saveInvoiceDrafts);
    document.getElementById('invSendBtn') ?.addEventListener('click', markAllInvoicesSent);
    document.getElementById('invCsvBtn')  ?.addEventListener('click', exportInvoicesCsv);
    document.getElementById('invBody')    ?.addEventListener('click', async e => {
        const sendBtn = e.target.closest('[data-inv-send]');
        if (sendBtn) {
            const r = _invRows[Number(sendBtn.dataset.invSend)];
            if (!r?.invoice) { alert('Save the drafts first, then mark them sent.'); return; }
            sendBtn.disabled = true;
            try {
                await markInvoicesSent([{ id: r.invoice.id, email: r.email }]);
                await loadInvoicesForMonth();
            } catch (err) { alert('Could not mark that sent: ' + (err.message || err)); sendBtn.disabled = false; }
            return;
        }
        const undoBtn = e.target.closest('[data-inv-unsend]');
        if (undoBtn) {
            const r = _invRows[Number(undoBtn.dataset.invUnsend)];
            if (!r?.invoice) return;
            if (!confirm('Put this invoice back to draft? Accounts Receivable will stop ageing it.')) return;
            undoBtn.disabled = true;
            try {
                await unmarkInvoiceSent(r.invoice.id);
                await loadInvoicesForMonth();
            } catch (err) { alert('Could not undo that: ' + (err.message || err)); undoBtn.disabled = false; }
        }
    });
}
