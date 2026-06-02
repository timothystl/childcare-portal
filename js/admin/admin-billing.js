// ============================================================
// MODULE: Admin Billing (Rates, Invoices, Payments, AR, Dashboard)
// Sub-tabs: Rates | Invoices | Payments (CSV) | AR | Dashboard
// ============================================================

// ============================================================
// STATE
// ============================================================
let _billingCharts = {};
let _allRates = [];              // cached [{family_id, family_name, rates: [...]}]
let _currentCycleId = null;
let _arData = [];
let _csvParsedRows = [];         // raw rows from uploaded CSV
let _csvHeaders = [];
let _ratesLoaded = false;
let _cyclesLoaded = false;
let _arLoaded = false;
let _blDashLoaded = false;
let _paymentModalContext = {};   // {familyId, invoiceId, familyName, finalAmount}
let _lockModalContext = {};      // {familyId, familyName, isLocking}

// Internal: all cycles array
let _billingCycles = [];

// ============================================================
// ENTRY POINT
// ============================================================
function setupBilling() {
    // Sub-tab navigation
    document.querySelectorAll('.billing-sub-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const target = btn.dataset.billingTab;
            _switchBillingSubTab(target, btn);
        });
    });

    // Rates tab
    document.getElementById('refreshRatesBtn')
        ?.addEventListener('click', () => { _ratesLoaded = false; loadFamilyRates(); });
    document.getElementById('rateSearchInput')
        ?.addEventListener('input', e => {
            renderBillingRatesTable(_allRates, e.target.value.trim());
        });
    document.getElementById('brDiscountType')
        ?.addEventListener('change', e => {
            const wrap = document.getElementById('brDiscountAmountWrap');
            if (!wrap) return;
            wrap.classList.toggle('hidden', e.target.value === 'none' || e.target.value === 'staff');
        });
    document.getElementById('billingRateModalSaveBtn')
        ?.addEventListener('click', saveRateFromModal);
    document.getElementById('billingRateModalCancelBtn')
        ?.addEventListener('click', _closeBillingRateModal);
    document.getElementById('billingRateModalCloseBtn')
        ?.addEventListener('click', _closeBillingRateModal);
    document.getElementById('billingRateHistoryCloseBtn')
        ?.addEventListener('click', () => document.getElementById('billingRateHistoryModal')?.classList.add('hidden'));

    // Invoices tab
    document.getElementById('invoiceCycleSelect')
        ?.addEventListener('change', onCycleSelect);
    document.getElementById('createCycleBtn')
        ?.addEventListener('click', createBillingCycle);
    document.getElementById('generateInvoicesBtn')
        ?.addEventListener('click', () => {
            if (_currentCycleId) generateDraftInvoices(_currentCycleId);
        });
    document.getElementById('finalizeCycleBtn')
        ?.addEventListener('click', () => {
            if (_currentCycleId) finalizeCycle(_currentCycleId);
        });

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

    // Open first sub-tab by default
    const firstBtn = document.querySelector('.billing-sub-btn[data-billing-tab="rates"]');
    if (firstBtn) _switchBillingSubTab('rates', firstBtn);
}

// ============================================================
// SUB-TAB NAVIGATION
// ============================================================
function _switchBillingSubTab(target, clickedBtn) {
    document.querySelectorAll('.billing-sub-btn').forEach(b => b.classList.remove('active'));
    if (clickedBtn) clickedBtn.classList.add('active');

    document.querySelectorAll('.billing-sub-pane').forEach(p => p.classList.add('hidden'));
    const pane = document.getElementById('bst-' + target);
    if (pane) pane.classList.remove('hidden');

    // Lazy-load data on first open
    if (target === 'rates' && !_ratesLoaded) {
        loadFamilyRates();
    } else if (target === 'invoices' && !_cyclesLoaded) {
        loadBillingCycles();
    } else if (target === 'ar' && !_arLoaded) {
        loadArView();
    } else if (target === 'bldash' && !_blDashLoaded) {
        setupBillingDashYear();
    }
}

// ============================================================
// RATES SUB-TAB
// ============================================================
async function loadFamilyRates() {
    const wrap = document.getElementById('ratesTableWrap-billing');
    if (wrap) wrap.innerHTML = '<p class="empty-hint">Loading rates…</p>';

    try {
        const rows = await fetchAllCurrentRates();

        // Group by family_id, keeping only the latest effective_date per family
        const latestByFamily = rows.reduce((acc, row) => {
            if (!acc[row.family_id]) {
                acc[row.family_id] = row;
            } else {
                if ((row.effective_date || '') > (acc[row.family_id].effective_date || '')) {
                    acc[row.family_id] = row;
                }
            }
            return acc;
        }, {});

        // Also gather all rows per family for history
        const allByFamily = rows.reduce((acc, row) => {
            if (!acc[row.family_id]) acc[row.family_id] = [];
            acc[row.family_id].push(row);
            return acc;
        }, {});

        // Merge with allFamiliesData for names
        const familyMap = {};
        (allFamiliesData || []).forEach(f => { familyMap[f.id] = f; });

        // Build _allRates: one entry per family (all active families, rate or not)
        _allRates = (allFamiliesData || []).filter(f => f.active !== false).map(f => {
            const latestRate = latestByFamily[f.id] || null;
            const histRates = allByFamily[f.id] || [];
            return {
                family_id:    f.id,
                family_name:  f.parent_name || '(unnamed)',
                family_email: f.parent_email || '',
                latestRate,
                histRates,
            };
        });

        _ratesLoaded = true;
        renderBillingRatesTable(_allRates, document.getElementById('rateSearchInput')?.value.trim() || '');
    } catch (err) {
        if (wrap) wrap.innerHTML = `<p class="empty-hint">Error loading rates: ${escHtml(err.message)}</p>`;
    }
}

function renderBillingRatesTable(rates, searchTerm) {
    const wrap = document.getElementById('ratesTableWrap-billing');
    if (!wrap) return;

    let filtered = rates;
    if (searchTerm) {
        const lc = searchTerm.toLowerCase();
        filtered = rates.filter(r =>
            (r.family_name || '').toLowerCase().includes(lc) ||
            (r.family_email || '').toLowerCase().includes(lc)
        );
    }

    if (!filtered.length) {
        wrap.innerHTML = '<p class="empty-hint">No data yet. Set rates for families to see them here.</p>';
        return;
    }

    const rows = filtered.map(r => {
        const lr = r.latestRate;
        const rateCell = lr
            ? `$${parseFloat(lr.monthly_rate || 0).toFixed(2)}`
            : '<span style="color:var(--muted)">—</span>';
        const effDate = lr
            ? _fmtDate(lr.effective_date)
            : '<span style="color:var(--muted)">—</span>';
        const discount = lr
            ? _fmtDiscount(lr.discount_type, lr.discount_amount)
            : '<span style="color:var(--muted)">—</span>';

        return `<tr data-family-id="${escHtml(r.family_id)}">
            <td>${escHtml(r.family_name)}<br><small style="color:var(--muted)">${escHtml(r.family_email)}</small></td>
            <td>${rateCell}</td>
            <td>${effDate}</td>
            <td>${discount}</td>
            <td>
                <button class="btn-xs" onclick="openSetRateModal('${escHtml(r.family_id)}')">
                    ${lr ? 'Update Rate' : 'Set Rate'}
                </button>
                <button class="btn-xs" onclick="openRateHistoryModal('${escHtml(r.family_id)}')">▸ History</button>
            </td>
        </tr>`;
    }).join('');

    wrap.innerHTML = `
        <div class="table-wrapper">
            <table>
                <thead>
                    <tr>
                        <th>Family</th>
                        <th>Current Rate</th>
                        <th>Eff. Date</th>
                        <th>Discount</th>
                        <th>Actions</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
}

function openSetRateModal(familyId) {
    const entry = _allRates.find(r => r.family_id === familyId);
    const familyName = entry ? entry.family_name : 'Family';
    const lr = entry ? entry.latestRate : null;

    const titleEl = document.getElementById('billingRateModalTitle');
    const nameEl  = document.getElementById('billingRateModalFamilyName');
    const statusEl = document.getElementById('billingRateModalStatus');
    if (titleEl)  titleEl.textContent = lr ? 'Update Rate' : 'Set Rate';
    if (nameEl)   nameEl.textContent  = familyName;
    if (statusEl) statusEl.textContent = '';

    const today = _todayStr();
    const rateInput = document.getElementById('brMonthlyRate');
    const dateInput = document.getElementById('brEffectiveDate');
    const discType  = document.getElementById('brDiscountType');
    const discAmt   = document.getElementById('brDiscountAmount');
    const discWrap  = document.getElementById('brDiscountAmountWrap');
    const discNote  = document.getElementById('brDiscountNote');

    if (rateInput) rateInput.value = lr ? parseFloat(lr.monthly_rate || 0).toFixed(2) : '';
    if (dateInput) dateInput.value = today;
    if (discType)  discType.value  = lr ? (lr.discount_type || 'none') : 'none';
    if (discAmt)   discAmt.value   = lr ? (lr.discount_amount || '') : '';
    if (discNote)  discNote.value  = lr ? (lr.discount_note || '') : '';
    if (discWrap) {
        const dt = discType ? discType.value : 'none';
        discWrap.classList.toggle('hidden', dt === 'none' || dt === 'staff');
    }

    // Store context on modal
    const modal = document.getElementById('billingRateModal');
    if (modal) {
        modal.dataset.familyId = familyId;
        modal.classList.remove('hidden');
    }
}

async function saveRateFromModal() {
    const modal    = document.getElementById('billingRateModal');
    const familyId = modal?.dataset.familyId;
    const statusEl = document.getElementById('billingRateModalStatus');
    const saveBtn  = document.getElementById('billingRateModalSaveBtn');

    if (!familyId) return;

    const monthlyRate   = parseFloat(document.getElementById('brMonthlyRate')?.value || '');
    const effectiveDate = document.getElementById('brEffectiveDate')?.value?.trim();
    const discountType  = document.getElementById('brDiscountType')?.value || 'none';
    const discountAmt   = parseFloat(document.getElementById('brDiscountAmount')?.value || '0') || 0;
    const discountNote  = document.getElementById('brDiscountNote')?.value?.trim() || '';

    if (!monthlyRate || isNaN(monthlyRate) || monthlyRate <= 0) {
        if (statusEl) statusEl.textContent = 'Monthly rate is required.';
        return;
    }
    if (!effectiveDate) {
        if (statusEl) statusEl.textContent = 'Effective date is required.';
        return;
    }

    if (saveBtn) saveBtn.disabled = true;
    if (statusEl) statusEl.textContent = 'Saving…';

    try {
        const row = {
            family_id:       familyId,
            monthly_rate:    monthlyRate,
            effective_date:  effectiveDate,
            discount_type:   discountType,
            discount_amount: (discountType !== 'none' && discountType !== 'staff') ? discountAmt : 0,
            discount_note:   discountNote,
        };
        await insertFamilyRate(row);
        await logAdminAction('set_rate', 'family_rate', null, {
            family_id:      familyId,
            monthly_rate:   monthlyRate,
            effective_date: effectiveDate,
        });
        _ratesLoaded = false;
        await loadFamilyRates();
        _closeBillingRateModal();
    } catch (err) {
        if (statusEl) statusEl.textContent = 'Error: ' + err.message;
        alert('Failed to save rate: ' + err.message);
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

async function openRateHistoryModal(familyId) {
    const entry = _allRates.find(r => r.family_id === familyId);
    const familyName = entry ? entry.family_name : 'Family';

    const nameEl = document.getElementById('brhFamilyName');
    const wrapEl = document.getElementById('brhHistoryTableWrap');
    if (nameEl) nameEl.textContent = familyName;
    if (wrapEl) wrapEl.innerHTML = '<p class="empty-hint">Loading…</p>';

    document.getElementById('billingRateHistoryModal')?.classList.remove('hidden');

    try {
        const rows = await fetchFamilyRates(familyId);
        if (!rows.length) {
            if (wrapEl) wrapEl.innerHTML = '<p class="empty-hint">No rate history for this family.</p>';
            return;
        }
        const tableRows = rows.map(r => `<tr>
            <td>${_fmtDate(r.effective_date)}</td>
            <td>$${parseFloat(r.monthly_rate || 0).toFixed(2)}</td>
            <td>${_fmtDiscount(r.discount_type, r.discount_amount)}</td>
            <td>${escHtml(r.discount_note || '—')}</td>
        </tr>`).join('');

        if (wrapEl) wrapEl.innerHTML = `
            <div class="table-wrapper">
                <table>
                    <thead><tr>
                        <th>Effective Date</th><th>Monthly Rate</th><th>Discount</th><th>Note</th>
                    </tr></thead>
                    <tbody>${tableRows}</tbody>
                </table>
            </div>`;
    } catch (err) {
        if (wrapEl) wrapEl.innerHTML = `<p class="empty-hint">Error: ${escHtml(err.message)}</p>`;
    }
}

function _closeBillingRateModal() {
    const modal = document.getElementById('billingRateModal');
    if (modal) {
        modal.classList.add('hidden');
        delete modal.dataset.familyId;
    }
    const statusEl = document.getElementById('billingRateModalStatus');
    if (statusEl) statusEl.textContent = '';
}

// ============================================================
// INVOICES SUB-TAB
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
    if (!_ratesLoaded) await loadFamilyRates();

    const previewWrap = document.getElementById('invoicePreviewWrap');
    if (previewWrap) previewWrap.innerHTML = '<p class="empty-hint">Generating invoices…</p>';

    const genBtn = document.getElementById('generateInvoicesBtn');
    if (genBtn) genBtn.disabled = true;

    try {
        const activeFamilies = (allFamiliesData || []).filter(f => f.active !== false);
        const rateMap = {};
        _allRates.forEach(r => { rateMap[r.family_id] = r; });

        const invoices   = [];
        let   skippedCnt = 0;

        for (const family of activeFamilies) {
            const entry = rateMap[family.id];
            if (!entry || !entry.latestRate) {
                skippedCnt++;
                continue;
            }

            const lr = entry.latestRate;
            const baseAmount = parseFloat(lr.monthly_rate || 0);
            let   discountAmount = 0;

            if (lr.discount_type === 'staff') {
                discountAmount = baseAmount;
            } else if (lr.discount_type === 'custom') {
                discountAmount = parseFloat(lr.discount_amount || 0);
            }

            const finalAmount = Math.max(0, baseAmount - discountAmount);

            const row = await upsertBillingInvoice({
                cycle_id:        cycleId,
                family_id:       family.id,
                base_amount:     baseAmount,
                discount_amount: discountAmount,
                discount_type:   lr.discount_type || 'none',
                adjustment_amount: 0,
                adjustment_note: '',
                final_amount:    finalAmount,
                status:          'draft',
            });
            invoices.push({
                ...row,
                parent_name:  family.parent_name,
                parent_email: family.parent_email,
            });
        }

        // Enable finalize button now that invoices exist
        _setInvoiceBtns(true, invoices.length > 0);

        renderInvoicePreview(invoices);

        if (skippedCnt > 0) {
            const hint = document.createElement('p');
            hint.className = 'empty-hint';
            hint.textContent = `${skippedCnt} ${skippedCnt === 1 ? 'family was' : 'families were'} skipped (no rate set).`;
            previewWrap?.appendChild(hint);
        }

        await logAdminAction('generate_invoices', 'billing_cycle', cycleId, {
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

        renderColumnMappingStep(_csvHeaders);
    } catch (err) {
        if (wrap) wrap.innerHTML = `<p class="empty-hint">Error parsing file: ${escHtml(err.message)}</p>`;
        alert('Failed to parse CSV/XLSX file: ' + err.message);
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
async function loadArView() {
    const wrap = document.getElementById('arTableWrap');
    if (wrap) wrap.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        // Fetch all needed data in parallel
        const activeFamilies = (allFamiliesData || []).filter(f => f.active !== false);

        // Fetch all cycles then all invoices
        const cycles   = await fetchBillingCycles();
        const closedCycleIds = cycles
            .filter(c => c.status === 'closed')
            .map(c => c.id);

        // Fetch invoices per closed cycle in parallel
        const invoiceArrays = await Promise.all(
            closedCycleIds.map(cid => fetchInvoicesForCycle(cid).catch(() => []))
        );
        const allInvoices = invoiceArrays.flat();

        // Fetch payments per family in parallel (limit concurrency by batching)
        const paymentArrays = await Promise.all(
            activeFamilies.map(f => fetchPaymentsForFamily(f.id).catch(() => []))
        );
        const paymentsByFamily = {};
        activeFamilies.forEach((f, i) => { paymentsByFamily[f.id] = paymentArrays[i]; });

        _arData = buildArData(activeFamilies, allInvoices, paymentsByFamily);
        _arLoaded = true;
        renderArTable(_arData);
    } catch (err) {
        if (wrap) wrap.innerHTML = `<p class="empty-hint">Error loading AR data: ${escHtml(err.message)}</p>`;
        alert('Failed to load AR data: ' + err.message);
    }
}

function buildArData(families, allInvoices, paymentsByFamily) {
    // Group invoices by family_id
    const invByFamily = {};
    allInvoices.forEach(inv => {
        if (!invByFamily[inv.family_id]) invByFamily[inv.family_id] = [];
        invByFamily[inv.family_id].push(inv);
    });

    return families.map(family => {
        const invoices  = (invByFamily[family.id] || [])
            .filter(inv => ['finalized', 'paid', 'partial'].includes(inv.status));

        // Most recent finalized invoice
        const mostRecent = invoices.sort((a, b) =>
            (b.finalized_at || b.created_at || '') > (a.finalized_at || a.created_at || '') ? 1 : -1
        )[0] || null;

        const payments  = paymentsByFamily[family.id] || [];
        const invoicePayments = mostRecent
            ? payments.filter(p => String(p.invoice_id) === String(mostRecent.id))
            : payments;

        const billed    = mostRecent ? parseFloat(mostRecent.final_amount || 0) : 0;
        const collected = invoicePayments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
        const outstanding = Math.max(0, billed - collected);

        let daysSince = null;
        if (mostRecent?.finalized_at) {
            const diff = Date.now() - new Date(mostRecent.finalized_at).getTime();
            daysSince  = Math.floor(diff / (1000 * 60 * 60 * 24));
        }

        let status;
        if (!mostRecent) {
            status = 'no_invoice';
        } else if (outstanding <= 0) {
            status = 'paid';
        } else if (collected > 0) {
            status = 'partial';
        } else if (daysSince != null && daysSince > 30) {
            status = 'overdue';
        } else {
            status = 'partial';
        }

        return {
            familyId:    family.id,
            familyName:  family.parent_name || '(unnamed)',
            familyEmail: family.parent_email || '',
            invoiceId:   mostRecent ? mostRecent.id : null,
            billed,
            collected,
            outstanding,
            daysSince,
            status,
            isLocked:    !!family.registration_locked,
            lockReason:  family.registration_lock_reason || '',
        };
    });
}

function renderArTable(data) {
    const wrap = document.getElementById('arTableWrap');
    if (!wrap) return;

    const filterVal = document.getElementById('arStatusFilter')?.value || '';
    const filtered  = filterVal ? data.filter(r => r.status === filterVal) : data;

    if (!filtered.length) {
        wrap.innerHTML = '<p class="empty-hint">No AR data found for the selected filter.</p>';
        return;
    }

    const rows = filtered.map(r => {
        const lockBtn = r.isLocked
            ? `<button class="btn-xs btn-warn" onclick="doSetFamilyLockWithReason('${escHtml(r.familyId)}', false, null, '${escHtml(r.familyName)}')">Unlock</button>`
            : `<button class="btn-xs btn-danger" onclick="openLockWithReasonModal('${escHtml(r.familyId)}', '${escHtml(r.familyName)}')">Lock</button>`;

        const days = r.daysSince != null ? r.daysSince : '—';

        return `<tr data-family-id="${escHtml(r.familyId)}">
            <td>
                ${escHtml(r.familyName)}
                ${r.isLocked ? '<span class="bl-badge bl-badge-overdue" title="Registration locked">Locked</span>' : ''}
                <br><small style="color:var(--muted)">${escHtml(r.familyEmail)}</small>
            </td>
            <td>${r.billed > 0 ? '$' + r.billed.toFixed(2) : '—'}</td>
            <td>${r.collected > 0 ? '$' + r.collected.toFixed(2) : '—'}</td>
            <td>${r.outstanding > 0 ? '$' + r.outstanding.toFixed(2) : '—'}</td>
            <td>${days}</td>
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
                    <th>Billed</th>
                    <th>Collected</th>
                    <th>Outstanding</th>
                    <th>Days</th>
                    <th>Status</th>
                    <th>Actions</th>
                </tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
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
    detailTr.innerHTML = `<td colspan="7"><p class="empty-hint">Loading…</p></td>`;
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
    if (container) container.innerHTML = '<p class="empty-hint">Loading dashboard…</p>';

    const genBtn = document.getElementById('generateBlDashBtn');
    if (genBtn) genBtn.disabled = true;

    try {
        const { cycles, invoices, payments } = await fetchBillingDashData(year);
        const metrics = computeDashMetrics(cycles, invoices, payments, year);

        _blDashLoaded = true;

        if (container) container.innerHTML = '';

        renderBillingKpis(metrics, container);

        // Chart for expected vs collected
        const chartWrap = document.createElement('div');
        chartWrap.className = 'fin-chart-wrap';
        chartWrap.innerHTML = '<h4 class="fin-chart-title">Expected vs. Collected by Month</h4><canvas id="blMainChart"></canvas>';
        if (container) container.appendChild(chartWrap);
        renderBlExpectedVsCollectedChart(metrics.monthData);

        // YOY chart (prior year)
        if (metrics.priorYearData) {
            const yoyWrap = document.createElement('div');
            yoyWrap.className = 'fin-chart-wrap';
            yoyWrap.innerHTML = '<h4 class="fin-chart-title">Year-over-Year: Collected</h4><canvas id="blYoyChart"></canvas>';
            if (container) container.appendChild(yoyWrap);
            renderBlYoyChart(metrics.monthData, metrics.priorYearData);
        }

        // Discount summary
        const discWrap = document.createElement('div');
        discWrap.innerHTML = '<h4>Discount Summary</h4>';
        if (container) container.appendChild(discWrap);
        renderDiscountSummaryTable(invoices, discWrap);

        document.getElementById('exportBlDashBtn').disabled = false;

        // Store for export
        document.getElementById('blDashContent').dataset.metricsYear = year;
    } catch (err) {
        if (container) container.innerHTML = `<p class="empty-hint">Error: ${escHtml(err.message)}</p>`;
        alert('Failed to generate billing dashboard: ' + err.message);
    } finally {
        if (genBtn) genBtn.disabled = false;
    }
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

function computeDashMetrics(cycles, invoices, payments, year) {
    const BL_MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    // Group by month
    const monthData = {};
    for (let m = 1; m <= 12; m++) {
        const moKey = `${year}-${String(m).padStart(2,'0')}`;
        const moInvoices = invoices.filter(inv =>
            (inv.cycle_month || '').startsWith(moKey) &&
            ['finalized', 'paid', 'partial'].includes(inv.status)
        );
        const expected  = moInvoices.reduce((s, inv) => s + parseFloat(inv.final_amount || 0), 0);
        const moPayments = payments.filter(p => (p.cycle_month || '').startsWith(moKey));
        const collected  = moPayments.reduce((s, p) => s + parseFloat(p.amount || 0), 0);
        const outstanding = Math.max(0, expected - collected);
        const collectionRate = expected > 0 ? collected / expected : 0;

        monthData[moKey] = {
            label: BL_MONTHS[m - 1],
            expected,
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
