// ============================================================
// admin-finance-hub — Finance Hub ledger (design handoff: Finance Hub, 2026-08-26)
// ============================================================
// Consolidates Bill This Month, Who Owes, Invoices, and Family Billing
// Summary into one screen. Billing Report stays a first-class, printable
// second tab (its own file/logic is untouched — see admin-billing-report.js).
//
// ⚠️ ONE COMPUTED DATASET, NO SECOND CALCULATION. Every stat, filter count,
// and row below comes from the exact functions the four retired screens
// already called: computeBillMonthExceptions() (admin-bill-month.js),
// _buildArRows() (admin-billing.js), and reconcileBillingInvoice() /
// setBillingInvoiceDraftAmount() (js/supabase.js). This file does not
// recompute a bill — it reads those outputs and gives them one worklist.
//
// ⚠️ Fee/credit/override all route through the same guarded RPCs the rest
// of the app already uses (reconcile_billing_invoice / set_billing_invoice_draft_amount
// in 20260825040000_billing_invoice_integrity.sql). Per BILLING_MODEL.md,
// a browser-calculated delta is never written directly to billing_invoices —
// every write here recomputes the true registration-based total first
// (reconcileBillingInvoice) and then applies the fee/credit/override on top
// of THAT number, via the same admin-entered-amount RPC the app already
// uses elsewhere. set_billing_invoice_draft_amount only accepts a change
// while the original invoice is still a draft (the database itself enforces
// this — "An issued invoice cannot be replaced"), so a fee/credit/override
// on an already-sent month surfaces that constraint rather than silently
// doing nothing.

let _fhMonth        = '';
let _fhTab          = 'ledger';   // 'ledger' | 'report'
let _fhFilter       = 'all';
let _fhSearch       = '';
let _fhRows         = [];         // this month's per-family ledger rows
let _fhOwed         = { months: [], byFamily: new Map() }; // trailing-months balances
let _fhDrawerRow    = null;       // the row currently open in the drawer
let _fhShowAging    = false;
let _fhBusy         = false;
let _fhReportLoaded = false;

const FH_OWED_TRAILING_MONTHS = 2; // + the open month = 3 months of real balance history

function _fhEl(id) { return document.getElementById(id); }

function _fhMoney(n) {
    const v = Math.abs(Number(n) || 0);
    return (Number(n) < 0 ? '−$' : '$') + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _fhDefaultMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function _fhShiftMonth(month, delta) {
    let [y, m] = month.split('-').map(Number);
    m += delta;
    while (m < 1) { m += 12; y -= 1; }
    while (m > 12) { m -= 12; y += 1; }
    return `${y}-${String(m).padStart(2, '0')}`;
}

function _fhMonthLabel(month) {
    const [y, m] = (month || '').split('-').map(Number);
    return m ? `${MONTH_NAMES[m - 1]} ${y}` : month;
}

function _fhIsCurrentMonth(month) { return month === _fhDefaultMonth(); }

// ── Entry point ──────────────────────────────────────────────
async function renderFinanceHubTool() {
    if (!_fhMonth) _fhMonth = _fhDefaultMonth();
    _fhTab = 'ledger';
    _fhFilter = 'all';
    _fhSearch = '';
    _fhReportLoaded = false;
    _fhBindHeaderOnce();
    await _fhLoad();
}

function _fhBindHeaderOnce() {
    if (window._fhHeaderBound) return;
    window._fhHeaderBound = true;
    _fhEl('fhMonthPrev')?.addEventListener('click', () => _fhGoToMonth(_fhShiftMonth(_fhMonth, -1)));
    _fhEl('fhMonthNext')?.addEventListener('click', () => _fhGoToMonth(_fhShiftMonth(_fhMonth, 1)));
    _fhEl('fhSearch')?.addEventListener('input', e => {
        _fhSearch = e.target.value || '';
        _fhRenderLedger();
    });
    document.querySelectorAll('#fhTabs .fh-tab').forEach(btn => {
        btn.addEventListener('click', () => _fhSwitchTab(btn.dataset.fhTab));
    });
    _fhEl('fhPrintCloseBtn')?.addEventListener('click', _fhClosePrintOverlay);
}

function _fhGoToMonth(month) {
    _fhMonth = month;
    _fhFilter = 'all';
    _fhLoad();
}

function _fhSwitchTab(tab) {
    _fhTab = tab;
    document.querySelectorAll('#fhTabs .fh-tab').forEach(b => {
        const on = b.dataset.fhTab === tab;
        b.classList.toggle('is-on', on);
        b.setAttribute('aria-selected', String(on));
    });
    const ledgerPane = _fhEl('fhLedgerPane');
    const reportPane = _fhEl('billingReportSection');
    if (ledgerPane) ledgerPane.style.display = tab === 'ledger' ? '' : 'none';
    if (reportPane) reportPane.style.display = tab === 'report' ? '' : 'none';
    if (tab === 'report' && !_fhReportLoaded) {
        _fhReportLoaded = true;
        const brMonth = _fhEl('brMonth');
        if (brMonth && !brMonth.value) brMonth.value = _fhMonth;
        if (typeof renderBillingReportTool === 'function') renderBillingReportTool();
    }
}

// ── Load ─────────────────────────────────────────────────────
async function _fhLoad() {
    const label = _fhEl('fhMonthLabel');
    if (label) label.textContent = _fhMonthLabel(_fhMonth);
    const root = _fhEl('fhRoot');
    if (root) root.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        if (typeof allFamiliesData === 'undefined' || !allFamiliesData || !allFamiliesData.length) {
            allFamiliesData = await fetchAllFamilies({ includeArchived: false });
        }
        if (typeof allRegistrations === 'undefined' || !allRegistrations || !allRegistrations.length) {
            allRegistrations = await fetchAllRegistrations();
        }

        const isCurrent = _fhIsCurrentMonth(_fhMonth);

        const be     = await computeBillMonthExceptions(_fhMonth);
        const cycle  = await getOrCreateBillingCycle(_fhMonth);
        const invAll = cycle ? await fetchInvoicesForCycle(cycle.id) : [];
        const invoices = invAll.filter(i => (i.invoice_type || 'original') === 'original');
        const payments = await fetchPaymentsForMonth(_fhMonth);
        const arRows   = _buildArRows(_fhMonth, allFamiliesData, invoices, payments);
        const arByFamily = new Map(arRows.map(r => [String(r.familyId), r]));

        _fhOwed = await _fhLoadOwedAcrossMonths(_fhMonth, FH_OWED_TRAILING_MONTHS);

        _fhRows = be.rows.map(r => {
            const fam = allFamiliesData.find(f =>
                (f.parent_email  || '').toLowerCase() === (r.email || '').toLowerCase() ||
                (f.parent2_email || '').toLowerCase() === (r.email || '').toLowerCase());
            const familyId = fam ? fam.id : null;
            const ar = familyId != null ? arByFamily.get(String(familyId)) : null;
            const owedRow = (familyId != null && _fhOwed.byFamily.get(String(familyId))) || { outstanding: 0, months: [] };

            let status;
            if (r.withdrawn) status = 'withdrawn';
            else if (ar && ar.sentAt) status = 'sent';
            else if (ar && ar.invoiceId) status = 'drafted';
            else if ((r.causes || []).length > 0) status = 'needs_review';
            else status = 'drafted'; // clean and computed, ready to release — not yet a persisted row

            return {
                familyId, name: r.name, email: r.email,
                total: r.total, causes: r.causes || [],
                withdrawn: !!r.withdrawn, status,
                ar, owed: owedRow.outstanding, owedMonths: owedRow.months,
            };
        }).filter(r => r.familyId != null);

        _fhRenderShell();
    } catch (err) {
        console.error('Finance Hub load:', err);
        if (root) root.innerHTML = `<p class="empty-hint">Could not load the ledger — ${escHtml(err.message || 'unknown error')}</p>`;
    }
}

/** Real balances for the open month plus a bounded trailing window — bounded
 *  rather than "every month ever" so this stays a handful of existing calls,
 *  not an unbounded full-history scan. */
async function _fhLoadOwedAcrossMonths(month, priorCount) {
    const months = [month];
    let m = month;
    for (let i = 0; i < priorCount; i++) { m = _fhShiftMonth(m, -1); months.push(m); }

    const byFamily = new Map();
    for (const mk of months) {
        try {
            const cycle = await getOrCreateBillingCycle(mk);
            const invAll = cycle ? await fetchInvoicesForCycle(cycle.id) : [];
            const invoices = invAll.filter(i => (i.invoice_type || 'original') === 'original' && i.status !== 'void');
            const payments = await fetchPaymentsForMonth(mk);
            const rows = _buildArRows(mk, allFamiliesData, invoices, payments);
            rows.forEach(r => {
                if (!r.familyId) return;
                const key = String(r.familyId);
                const prev = byFamily.get(key) || { outstanding: 0, months: [] };
                prev.outstanding += r.outstanding;
                if (r.billed > 0 || r.collected > 0) {
                    prev.months.push({ month: mk, billed: r.billed, collected: r.collected, sentAt: r.sentAt, invoiceId: r.invoiceId });
                }
                byFamily.set(key, prev);
            });
        } catch (e) { console.warn('Finance Hub owed-month load failed:', mk, e); }
    }
    return { months, byFamily };
}

// ── Shell / tabs ─────────────────────────────────────────────
function _fhRenderShell() {
    const prevBtn = _fhEl('fhMonthPrev');
    if (prevBtn) prevBtn.disabled = false;

    if (_fhIsCurrentMonth(_fhMonth)) {
        _fhRenderLedger();
    } else {
        _fhRenderMonthHistory();
    }
}

// ── Ledger (current month, editable) ────────────────────────
const FH_STATUS_META = {
    needs_review: { label: 'Needs review',       cls: 'fh-pill-review' },
    // "Drafted" read as "someone is in the middle of drafting this" — it's
    // the opposite: the database already computed it from booked days, and
    // nothing more happens to it until you click Send. "Ready to send" says
    // what it actually is and what the button next to it does.
    drafted:      { label: 'Ready to send',      cls: 'fh-pill-drafted' },
    sent:         { label: 'Invoice sent',       cls: 'fh-pill-sent' },
    paid:         { label: 'Paid in full',       cls: 'fh-pill-paid' },
    card_declined:{ label: 'Card declined',      cls: 'fh-pill-declined' },
    withdrawn:    { label: 'Withdrawn',          cls: 'fh-pill-withdrawn' },
};

function _fhRowDisplayStatus(row) {
    // "Paid in full" wins visually once the balance is actually zero,
    // regardless of how the invoice got there.
    if (row.status === 'withdrawn') return 'withdrawn';
    if (row.status === 'sent' && row.ar && row.ar.status === 'paid') return 'paid';
    return row.status;
}

function _fhFilterCounts() {
    const active = _fhRows.filter(r => r.status !== 'withdrawn');
    return {
        all:           active.length,
        needs_review:  active.filter(r => r.status === 'needs_review').length,
        drafted:       active.filter(r => r.status === 'drafted').length,
        sent:          active.filter(r => r.status === 'sent').length,
        card_declined: 0, // no payment-processor decline signal exists yet — see BILLING_MODEL.md
        owing:         active.filter(r => r.owed > 0).length,
        paid:          active.filter(r => r.owed <= 0 && (r.ar?.billed > 0 || r.status === 'sent')).length,
        withdrawn:     _fhRows.filter(r => r.status === 'withdrawn').length,
    };
}

function _fhVisibleRows() {
    const q = _fhSearch.trim().toLowerCase();
    return _fhRows.filter(r => {
        if (q && !r.name.toLowerCase().includes(q)) return false;
        switch (_fhFilter) {
            case 'all':           return r.status !== 'withdrawn';
            case 'needs_review':  return r.status === 'needs_review';
            case 'drafted':       return r.status === 'drafted';
            case 'sent':          return r.status === 'sent';
            case 'card_declined': return false;
            case 'owing':         return r.status !== 'withdrawn' && r.owed > 0;
            case 'paid':          return r.status !== 'withdrawn' && r.owed <= 0 && (r.ar?.billed > 0 || r.status === 'sent');
            case 'withdrawn':     return r.status === 'withdrawn';
            default:              return true;
        }
    });
}

function _fhRenderLedger() {
    const root = _fhEl('fhRoot');
    if (!root) return;

    const active     = _fhRows.filter(r => r.status !== 'withdrawn');
    const needsLook  = active.filter(r => r.status === 'needs_review');
    const drafted    = active.filter(r => r.status === 'drafted');
    const sent       = active.filter(r => r.status === 'sent');
    const draftedTotal = drafted.reduce((s, r) => s + r.total, 0);

    const owingRows = active.filter(r => r.owed > 0);
    const owedTotal = owingRows.reduce((s, r) => s + r.owed, 0);
    const monthsSpan = _fhOwed.months.length > 1
        ? `${_fhMonthLabel(_fhOwed.months[_fhOwed.months.length - 1])}–${_fhMonthLabel(_fhOwed.months[0])}`
        : _fhMonthLabel(_fhMonth);

    const counts = _fhFilterCounts();
    const rows = _fhVisibleRows();

    const chips = [
        ['all', 'All'], ['needs_review', 'Needs review'], ['drafted', 'Ready to send'],
        ['sent', 'Issued'], ['card_declined', 'Card declined'], ['owing', 'Owing'],
        ['paid', 'Paid in full'], ['withdrawn', 'Withdrawn'],
    ];

    root.innerHTML = `
        <div class="fh-strip">
            <div class="fh-stat">
                <div class="fh-stat-num">${active.length}</div>
                <div class="fh-stat-label">Families, ${_fhMonthLabel(_fhMonth).split(' ')[0]}</div>
            </div>
            <span class="fh-arrow">→</span>
            <div class="fh-stat fh-stat-tang${needsLook.length ? ' is-clickable' : ''}" ${needsLook.length ? 'data-fh-filter="needs_review"' : ''}>
                <div class="fh-stat-num">${needsLook.length}</div>
                <div class="fh-stat-label fh-underline">Need a look</div>
            </div>
            <span class="fh-arrow">→</span>
            <div class="fh-stat is-clickable" data-fh-filter="drafted">
                <div class="fh-stat-num">${drafted.length}</div>
                <div class="fh-stat-label">Ready to send · ${_fhMoney(draftedTotal)}</div>
            </div>
            <span class="fh-arrow">→</span>
            <div class="fh-stat is-clickable" data-fh-filter="sent">
                <div class="fh-stat-num">${sent.length}</div>
                <div class="fh-stat-label">Issued</div>
            </div>
            <button type="button" class="btn-primary" id="fhReleaseBtn" ${drafted.length ? '' : 'disabled'}>Release ${drafted.length} invoice${drafted.length === 1 ? '' : 's'}</button>
        </div>

        <div class="fh-owed-banner">
            <div class="fh-owed-main">
                <strong>${_fhMoney(owedTotal)} owed</strong> · ${owingRows.length} famil${owingRows.length === 1 ? 'y' : 'ies'}
                <div class="fh-owed-sub">Across ${monthsSpan}, not just ${_fhMonthLabel(_fhMonth)} · computed live from the rows below</div>
            </div>
            <div class="fh-owed-actions">
                <button type="button" class="btn-primary" id="fhNudgeAllBtn" ${owingRows.length ? '' : 'disabled'}>Nudge all ${owingRows.length}</button>
                <button type="button" class="btn-secondary" id="fhAgingToggleBtn">${_fhShowAging ? 'Hide' : 'Open'} aging detail →</button>
            </div>
        </div>
        ${_fhShowAging ? _fhAgingHtml(owingRows) : ''}

        <div class="fh-chips">
            ${chips.map(([key, label]) => `
                <button type="button" class="fh-chip fh-chip-${key}${_fhFilter === key ? ' is-on' : ''}" data-fh-filter="${key}">
                    ${escHtml(label)} <span class="fh-chip-count">${counts[key]}</span>
                </button>`).join('')}
        </div>

        <div class="table-wrapper">
            <table class="report-table fh-table">
                <thead><tr>
                    <th>Family</th><th>${_fhMonthLabel(_fhMonth).split(' ')[0]} charge</th>
                    <th>Status</th><th>Note</th>
                    <th style="text-align:right">Balance, all months</th><th></th>
                </tr></thead>
                <tbody>
                    ${rows.length ? rows.map(_fhRowHtml).join('') : `<tr><td colspan="6"><p class="empty-hint">No families match.</p></td></tr>`}
                </tbody>
            </table>
        </div>`;

    _fhBindLedgerListeners(root);
}

function _fhAgingHtml(owingRows) {
    const now = Date.now();
    const bands = { b0: [], b15: [], b30: [] };
    owingRows.forEach(r => {
        const sentAt = r.ar?.sentAt;
        const days = sentAt ? Math.floor((now - new Date(sentAt).getTime()) / 86400000) : 0;
        if (days >= 30) bands.b30.push(r);
        else if (days >= 15) bands.b15.push(r);
        else bands.b0.push(r);
    });
    const sum = arr => arr.reduce((s, r) => s + r.owed, 0);
    return `
        <div class="fh-aging">
            <div class="fh-aging-col"><div class="fh-aging-label">0–14 days</div><div class="fh-aging-amt">${_fhMoney(sum(bands.b0))}</div><div class="fh-aging-count">${bands.b0.length} famil${bands.b0.length === 1 ? 'y' : 'ies'}</div></div>
            <div class="fh-aging-col fh-aging-watch"><div class="fh-aging-label">15–29 days</div><div class="fh-aging-amt">${_fhMoney(sum(bands.b15))}</div><div class="fh-aging-count">${bands.b15.length} famil${bands.b15.length === 1 ? 'y' : 'ies'}</div></div>
            <div class="fh-aging-col fh-aging-severe"><div class="fh-aging-label">30+ days</div><div class="fh-aging-amt">${_fhMoney(sum(bands.b30))}</div><div class="fh-aging-count">${bands.b30.length} famil${bands.b30.length === 1 ? 'y' : 'ies'}</div></div>
        </div>`;
}

function _fhNoteFor(row) {
    if (row.status === 'card_declined') return 'Card on file was declined';
    if (row.causes.length) return escHtml(row.causes[0].text || '');
    if (row.status === 'sent' && row.owed > 0) return 'Invoice sent — balance outstanding';
    if (row.status === 'drafted') return 'Ready to send';
    if (row.owed <= 0 && row.status === 'sent') return 'Paid';
    return '—';
}

function _fhRowHtml(row) {
    const dispStatus = _fhRowDisplayStatus(row);
    const meta = FH_STATUS_META[dispStatus] || FH_STATUS_META.drafted;
    const sentDate = row.ar?.sentAt ? friendlyShort(String(row.ar.sentAt).slice(0, 10)) : '';
    const pillLabel = dispStatus === 'sent' && sentDate ? `Invoice sent ${sentDate}` : meta.label;
    const balCls = row.owed > 0 ? 'fh-bal-owed' : 'fh-bal-clear';

    // Two fixed slots, always both present (empty when the action doesn't
    // apply to this row) — Send invoice and Remind/Retry charge otherwise
    // land at a different x-position on every row depending on which
    // buttons a given row happens to have, which is what actually made the
    // column look misaligned rather than any one row being wrong.
    const sendSlot = row.status === 'drafted'
        ? `<button type="button" class="btn-xs btn-primary" data-fh-send="${row.familyId}">Send invoice</button>` : '';
    const remindSlot = row.owed > 0
        ? `<button type="button" class="btn-xs" data-fh-remind="${row.familyId}">${dispStatus === 'card_declined' ? 'Retry charge' : 'Remind'}</button>` : '';
    const actions = `<span class="fh-action-slot">${sendSlot}</span><span class="fh-action-slot">${remindSlot}</span>`;

    return `<tr data-fh-row="${row.familyId}">
        <td class="fh-row-open" data-fh-open="${row.familyId}"><strong>${escHtml(row.name)}</strong></td>
        <td>${_fhMoney(row.total)}</td>
        <td><span class="fh-pill ${meta.cls}">${escHtml(pillLabel)}</span></td>
        <td class="fh-note">${_fhNoteFor(row)}</td>
        <td style="text-align:right" class="${balCls}">${_fhMoney(row.owed)}</td>
        <td class="fh-row-actions" onclick="event.stopPropagation()">${actions}</td>
    </tr>`;
}

function _fhBindLedgerListeners(root) {
    root.querySelectorAll('[data-fh-filter]').forEach(el => {
        el.addEventListener('click', () => { _fhFilter = el.dataset.fhFilter; _fhRenderLedger(); });
    });
    root.querySelectorAll('[data-fh-open]').forEach(el => {
        el.addEventListener('click', () => _fhOpenDrawer(el.dataset.fhOpen));
    });
    root.querySelectorAll('[data-fh-send]').forEach(el => {
        el.addEventListener('click', () => _fhSendInvoiceRow(el.dataset.fhSend, el));
    });
    root.querySelectorAll('[data-fh-remind]').forEach(el => {
        el.addEventListener('click', () => _fhRemindOne(el.dataset.fhRemind, el));
    });
    _fhEl('fhReleaseBtn')?.addEventListener('click', _fhReleaseDrafts);
    _fhEl('fhNudgeAllBtn')?.addEventListener('click', _fhNudgeAll);
    _fhEl('fhAgingToggleBtn')?.addEventListener('click', () => { _fhShowAging = !_fhShowAging; _fhRenderLedger(); });
}

// ── Month history (read-only) ───────────────────────────────
function _fhRenderMonthHistory() {
    const root = _fhEl('fhRoot');
    if (!root) return;
    const rows = _fhRows.filter(r => r.status !== 'withdrawn' && (r.ar?.billed > 0 || r.total > 0));
    root.innerHTML = `
        <div class="fh-history-banner">
            <strong>${_fhMonthLabel(_fhMonth)} — read-only history</strong>
            <p>To record a late payment against this month, open the family (click a row) and use Record payment — it applies to whichever month you pick, regardless of today's date.</p>
        </div>
        <div class="table-wrapper">
            <table class="report-table fh-table">
                <thead><tr><th>Family</th><th style="text-align:right">Charged</th><th style="text-align:right">Paid</th><th style="text-align:right">Balance</th></tr></thead>
                <tbody>
                    ${rows.length ? rows.map(r => `
                        <tr data-fh-row="${r.familyId}">
                            <td class="fh-row-open" data-fh-open="${r.familyId}"><strong>${escHtml(r.name)}</strong></td>
                            <td style="text-align:right">${_fhMoney(r.ar?.billed || r.total)}</td>
                            <td style="text-align:right">${_fhMoney(r.ar?.collected || 0)}</td>
                            <td style="text-align:right" class="${(r.ar?.outstanding || 0) > 0 ? 'fh-bal-owed' : 'fh-bal-clear'}">${_fhMoney(r.ar?.outstanding || 0)}</td>
                        </tr>`).join('') : '<tr><td colspan="4"><p class="empty-hint">No billing activity this month.</p></td></tr>'}
                </tbody>
            </table>
        </div>
        <p class="ap-note fh-history-foot">Billing Report is the only other screen — read-only, for the binder or export. This ledger is the only place balances change.</p>`;

    root.querySelectorAll('[data-fh-open]').forEach(el => {
        el.addEventListener('click', () => _fhOpenDrawer(el.dataset.fhOpen));
    });
}

// ── Bulk actions ─────────────────────────────────────────────
async function _fhReleaseDrafts() {
    const drafted = _fhRows.filter(r => r.status === 'drafted' && r.familyId);
    if (!drafted.length) return;
    if (!confirm(`Release ${drafted.length} invoice${drafted.length === 1 ? '' : 's'} totaling ${_fhMoney(drafted.reduce((s, r) => s + r.total, 0))}?\n\nThey email to families now.`)) return;
    if (_fhBusy) return;
    _fhBusy = true;
    const btn = _fhEl('fhReleaseBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
        await _bmDraftAndSend(_fhMonth, drafted);
        showToast(`${drafted.length} invoice${drafted.length === 1 ? '' : 's'} released.`);
        await _fhLoad();
    } catch (err) {
        alert('Could not release those invoices: ' + (err.message || err));
    } finally {
        _fhBusy = false;
    }
}

async function _fhNudgeAll() {
    const owing = _fhRows.filter(r => r.owed > 0 && r.familyId);
    if (!owing.length) return;
    if (!confirm(`Nudge ${owing.length} famil${owing.length === 1 ? 'y' : 'ies'} with a balance?`)) return;
    const btn = _fhEl('fhNudgeAllBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
        const { data: { session } } = await sbClient.auth.getSession();
        for (const r of owing) {
            if (typeof _woSendPush === 'function') {
                await _woSendPush(r.familyId, 'A note from MDO', `Your account has a balance of ${_fhMoney(r.owed)}. Open the portal for details.`);
            }
            await insertNudge({ family_id: r.familyId, invoice_id: r.ar?.invoiceId || null, channel: 'push', sent_by: session?.user?.email || 'admin' });
        }
        showToast(`Nudged ${owing.length} famil${owing.length === 1 ? 'y' : 'ies'}.`);
        await _fhLoad();
    } catch (err) {
        alert('Could not finish nudging: ' + (err.message || err));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Nudge all'; }
    }
}

async function _fhRemindOne(familyId, btn) {
    const row = _fhRows.find(r => String(r.familyId) === String(familyId));
    if (!row) return;
    if (btn) btn.disabled = true;
    try {
        const { data: { session } } = await sbClient.auth.getSession();
        if (typeof _woSendPush === 'function') {
            await _woSendPush(familyId, 'A note from MDO', `Your account has a balance of ${_fhMoney(row.owed)}. Open the portal for details.`);
        }
        await insertNudge({ family_id: familyId, invoice_id: row.ar?.invoiceId || null, channel: 'push', sent_by: session?.user?.email || 'admin' });
        showToast(`Reminded ${row.name}.`);
    } catch (err) {
        alert('Could not send that reminder: ' + (err.message || err));
    } finally {
        if (btn) btn.disabled = false;
    }
}

async function _fhSendInvoiceRow(familyId, btn) {
    const row = _fhRows.find(r => String(r.familyId) === String(familyId));
    if (!row) return;
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
        await _bmDraftAndSend(_fhMonth, [{ familyId: row.familyId, email: row.email }]);
        showToast(`Sent — ${_fhMoney(row.total)} to ${row.name}.`);
        await _fhLoad();
        if (_fhDrawerRow && String(_fhDrawerRow.familyId) === String(familyId)) _fhCloseDrawer();
    } catch (err) {
        alert('Could not send that invoice: ' + (err.message || err));
        if (btn) { btn.disabled = false; btn.textContent = 'Send invoice'; }
    }
}

// ============================================================
// FAMILY DRAWER
// ============================================================
// Reuses the incident-drawer visual pattern (css/admin.css, .inc-drawer /
// .inc-scrim) — the app's one existing right-anchored slide-over — rather
// than inventing a second drawer component.

async function _fhOpenDrawer(familyId) {
    const row = _fhRows.find(r => String(r.familyId) === String(familyId));
    if (!row) return;
    _fhDrawerRow = row;
    await _fhRenderDrawer();
}

function _fhCloseDrawer() {
    _fhDrawerRow = null;
    _fhEl('fhDrawerRoot')?.remove();
}

async function _fhRenderDrawer() {
    _fhEl('fhDrawerRoot')?.remove();
    const row = _fhDrawerRow;
    if (!row) return;

    const wrap = document.createElement('div');
    wrap.id = 'fhDrawerRoot';
    wrap.innerHTML = `
        <div class="inc-scrim" id="fhDrawerScrim"></div>
        <aside class="inc-drawer" id="fhDrawer" role="dialog" aria-label="${escHtml(row.name)}">
            <div class="inc-dr-head">
                <button type="button" class="inc-dr-x" id="fhDrawerClose">&larr; Close</button>
                <div class="inc-dr-eyebrow">${escHtml(_fhMonthLabel(_fhMonth))}</div>
                <h3>${escHtml(row.name)}</h3>
                <p class="inc-dr-sub">${row.causes.length ? escHtml(row.causes[0].text || '') : 'No review needed'}</p>
            </div>
            <div class="inc-dr-body" id="fhDrawerBody"><p class="empty-hint">Loading…</p></div>
        </aside>`;
    document.body.appendChild(wrap);
    requestAnimationFrame(() => _fhEl('fhDrawer')?.classList.add('is-open'));

    _fhEl('fhDrawerScrim')?.addEventListener('click', _fhCloseDrawer);
    _fhEl('fhDrawerClose')?.addEventListener('click', _fhCloseDrawer);

    await _fhLoadDrawerBody(row);
}

async function _fhLoadDrawerBody(row) {
    const body = _fhEl('fhDrawerBody');
    if (!body) return;
    let auditLines = [];
    try { auditLines = await _fhFetchInvoiceAudit(row.ar?.invoiceId); } catch (_) { /* best-effort only */ }
    let familyPayments = [];
    try { familyPayments = await fetchPaymentsForFamily(row.familyId); } catch (_) { /* non-fatal */ }

    const baseAmt = row.ar?.invoiceId ? (row.ar.billed || 0) : row.total;
    const overrideLine = auditLines.find(a => ['add_fee', 'add_credit', 'override_total'].includes(a.action));

    body.innerHTML = `
        <div class="inc-dr-field">
            <div class="fh-dr-card-title">${escHtml(_fhMonthLabel(_fhMonth))} charges</div>
            <div class="fh-dr-line">
                <span>Base tuition</span><strong>${_fhMoney((row.ar?.billed && !overrideLine) ? row.ar.billed : row.total)}</strong>
            </div>
            <div class="fh-dr-line-sub">System · 1 ${_fhMonthLabel(_fhMonth).split(' ')[0]}</div>
            ${overrideLine ? `
                <div class="fh-dr-line"><span>${escHtml(overrideLine.label || 'Adjustment')}</span><strong>${_fhMoney(overrideLine.amount)}</strong></div>
                <div class="fh-dr-line-sub">${escHtml(overrideLine.by)} · ${escHtml(overrideLine.when)}</div>` : ''}
            <div class="fh-dr-line fh-dr-total"><span>Total, ${_fhMonthLabel(_fhMonth).split(' ')[0]}</span><strong>${_fhMoney(baseAmt)}</strong></div>
        </div>

        <div class="fh-dr-actions">
            ${row.status !== 'sent' ? `
                <button type="button" class="btn-outline" id="fhAddFeeBtn">+ Add a fee</button>
                <button type="button" class="btn-outline fh-btn-green" id="fhAddCreditBtn">+ Add a credit</button>` : ''}
            ${row.status === 'drafted' ? `<button type="button" class="btn-primary" id="fhDrSendBtn">Send invoice</button>` : ''}
            <button type="button" class="btn-secondary" id="fhPrintStatementBtn">Print statement</button>
        </div>
        <div id="fhInlineForm"></div>
        <div class="fh-dr-row">
            ${row.status !== 'sent' ? `<button type="button" class="fh-override-btn" id="fhOverrideBtn">Override total (rare — needs a reason)</button>` : ''}
            ${row.status === 'needs_review' ? `<button type="button" class="btn-approve" id="fhApproveBtn">&check; Approve as-is</button>` : ''}
        </div>

        <div class="inc-dr-field">
            <div class="fh-dr-card-title">Balance by month</div>
            ${(row.owedMonths.length ? row.owedMonths : [{ month: _fhMonth, billed: row.total, collected: 0, sentAt: null }]).map(m => `
                <div class="fh-dr-line">
                    <span>${escHtml(_fhMonthLabel(m.month))} · charged ${_fhMoney(m.billed)}${m.sentAt ? ` (${escHtml(friendlyShort(String(m.sentAt).slice(0, 10)))})` : ''} · paid ${_fhMoney(m.collected)}</span>
                    <strong class="${(m.billed - m.collected) > 0 ? 'fh-bal-owed' : 'fh-bal-clear'}">${_fhMoney(Math.max(0, m.billed - m.collected))}</strong>
                </div>`).join('')}
        </div>

        <div class="inc-dr-field">
            <div class="fh-dr-card-title-row">
                <div class="fh-dr-card-title">Payments</div>
                <button type="button" class="fh-link-btn" id="fhRecordPaymentBtn">+ Record payment</button>
            </div>
            ${familyPayments.length ? `<ul class="inc-sig-list">${familyPayments.map(p => `
                <li class="inc-sig">
                    <span>${escHtml(friendlyShort(String(p.payment_date || '').slice(0, 10)))} — ${_fhMoney(p.amount)}</span>
                    <span class="fh-pay-method">${p.payment_method === 'autopay' || p.source === 'processor' ? 'Autopay' : `Manual${p.payment_method ? ' · ' + escHtml(p.payment_method) : ''}`}</span>
                </li>`).join('')}</ul>` : '<p class="empty-hint">No payments recorded yet.</p>'}
        </div>

        <div class="inc-dr-foot">
            <button type="button" class="btn-secondary" id="fhDrawerCloseFoot">Save</button>
            <button type="button" class="fh-remind-btn" id="fhDrawerRemindBtn">Send payment reminder</button>
        </div>`;

    _fhEl('fhAddFeeBtn')?.addEventListener('click', () => _fhShowLineItemForm(row, 'fee'));
    _fhEl('fhAddCreditBtn')?.addEventListener('click', () => _fhShowLineItemForm(row, 'credit'));
    _fhEl('fhOverrideBtn')?.addEventListener('click', () => _fhShowOverrideForm(row));
    _fhEl('fhApproveBtn')?.addEventListener('click', () => _fhApproveAsIs(row));
    _fhEl('fhDrSendBtn')?.addEventListener('click', () => _fhSendInvoiceRow(row.familyId, _fhEl('fhDrSendBtn')));
    _fhEl('fhPrintStatementBtn')?.addEventListener('click', () => _fhPrintStatement(row, familyPayments));
    _fhEl('fhRecordPaymentBtn')?.addEventListener('click', () => _fhShowPaymentForm(row));
    _fhEl('fhDrawerCloseFoot')?.addEventListener('click', _fhCloseDrawer);
    _fhEl('fhDrawerRemindBtn')?.addEventListener('click', () => _fhRemindOne(row.familyId, _fhEl('fhDrawerRemindBtn')));
}

/** Best-effort read of who/when for a manual fee, credit, or override on this
 *  invoice — admin_audit_log is the only place that trail exists (there is
 *  no line-items table), so this degrades quietly if it can't be read. */
async function _fhFetchInvoiceAudit(invoiceId) {
    if (!invoiceId || typeof sbClient === 'undefined' || !sbClient) return [];
    const { data, error } = await sbClient
        .from('admin_audit_log')
        .select('*')
        .eq('entity', 'billing_invoice')
        .eq('entity_id', String(invoiceId))
        .in('action', ['add_fee', 'add_credit', 'override_total'])
        .order('ts', { ascending: false })
        .limit(1);
    if (error || !data || !data.length) return [];
    const a = data[0];
    const details = a.details || {};
    return [{
        action: a.action,
        label: details.label || (a.action === 'override_total' ? 'Override' : a.action === 'add_credit' ? 'Credit' : 'Fee'),
        amount: Number(details.amount) || 0,
        by: a.admin_email || 'Admin',
        when: friendlyShort(String(a.ts || '').slice(0, 10)),
    }];
}

// ── Inline mini-forms (no modal-within-modal, per the handoff) ─────────────
function _fhShowLineItemForm(row, kind) {
    const host = _fhEl('fhInlineForm');
    if (!host) return;
    const verb = kind === 'fee' ? 'fee' : 'credit';
    host.innerHTML = `
        <div class="fh-mini-form">
            <label>Label <input type="text" id="fhLineLabel" placeholder="${kind === 'fee' ? 'e.g. Late pickup fee' : 'e.g. Closure credit'}"></label>
            <label>Amount <input type="number" id="fhLineAmount" min="0.01" step="0.01" placeholder="0.00"></label>
            <div class="fh-mini-form-btns">
                <button type="button" class="btn-primary btn-sm" id="fhLineAdd">Add ${verb}</button>
                <button type="button" class="btn-ghost btn-sm" id="fhLineCancel">Cancel</button>
            </div>
        </div>`;
    _fhEl('fhLineCancel').addEventListener('click', () => { host.innerHTML = ''; });
    _fhEl('fhLineAdd').addEventListener('click', () => _fhSubmitLineItem(row, kind));
}

async function _fhSubmitLineItem(row, kind) {
    const label = _fhEl('fhLineLabel')?.value.trim();
    const amount = parseFloat(_fhEl('fhLineAmount')?.value || '');
    if (!label) { alert('Give this a label.'); return; }
    if (!amount || isNaN(amount) || amount <= 0) { alert('Enter an amount greater than $0.'); return; }
    const btn = _fhEl('fhLineAdd');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        await _fhApplyLineItem(row, kind, label, amount);
        showToast(`${kind === 'fee' ? 'Fee' : 'Credit'} added.`);
        await _fhLoad();
        _fhDrawerRow = _fhRows.find(r => String(r.familyId) === String(row.familyId)) || null;
        if (_fhDrawerRow) await _fhRenderDrawer(); else _fhCloseDrawer();
    } catch (err) {
        alert('Could not add that: ' + (err.message || err));
        if (btn) { btn.disabled = false; btn.textContent = kind === 'fee' ? 'Add fee' : 'Add credit'; }
    }
}

/** The actual write: recompute the true registration-based total first
 *  (never trust a stale on-screen number), then layer the fee/credit on top
 *  of that via the same admin-entered-amount RPC the rest of the app uses.
 *  Throws with the database's own message if the invoice has already been
 *  sent — set_billing_invoice_draft_amount refuses to replace an issued row. */
async function _fhApplyLineItem(row, kind, label, amount) {
    const inv = await reconcileBillingInvoice(row.familyId, _fhMonth);
    const base = inv ? Number(inv.final_amount) || 0 : row.total;
    const delta = kind === 'fee' ? Math.abs(amount) : -Math.abs(amount);
    const newTotal = Math.max(0, Math.round((base + delta) * 100) / 100);
    const updated = await setBillingInvoiceDraftAmount(row.familyId, _fhMonth, newTotal);

    if (kind === 'credit' && typeof insertBillingCredit === 'function') {
        try {
            const email = await getAdminEmail();
            const credit = await insertBillingCredit({ family_id: row.familyId, amount: Math.abs(amount), reason: label, created_by: email });
            if (updated && typeof applyBillingCredit === 'function') await applyBillingCredit(credit.id, updated.id);
        } catch (e) { console.warn('billing_credits ledger row failed (total was still updated):', e); }
    }

    await logAdminAction(kind === 'fee' ? 'add_fee' : 'add_credit', 'billing_invoice', updated?.id || null,
        { family_id: row.familyId, month: _fhMonth, label, amount: delta });
    return updated;
}

function _fhShowOverrideForm(row) {
    const host = _fhEl('fhInlineForm');
    if (!host) return;
    host.innerHTML = `
        <div class="fh-mini-form fh-mini-form-caution">
            <label>New total <input type="number" id="fhOvAmount" min="0" step="0.01" placeholder="0.00" value="${row.total.toFixed(2)}"></label>
            <label>Reason <span class="fh-required">(required)</span> <input type="text" id="fhOvReason" placeholder="Why the total is different from what registrations compute"></label>
            <div class="fh-mini-form-btns">
                <button type="button" class="btn-primary btn-sm" id="fhOvSave">Save override</button>
                <button type="button" class="btn-ghost btn-sm" id="fhOvCancel">Cancel</button>
            </div>
        </div>`;
    _fhEl('fhOvCancel').addEventListener('click', () => { host.innerHTML = ''; });
    _fhEl('fhOvSave').addEventListener('click', () => _fhSubmitOverride(row));
}

async function _fhSubmitOverride(row) {
    const amount = parseFloat(_fhEl('fhOvAmount')?.value || '');
    const reason = _fhEl('fhOvReason')?.value.trim();
    if (isNaN(amount) || amount < 0) { alert('Enter a valid total.'); return; }
    if (!reason) { alert('A reason is required for an override.'); return; }
    const btn = _fhEl('fhOvSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const updated = await setBillingInvoiceDraftAmount(row.familyId, _fhMonth, Math.round(amount * 100) / 100);
        await logAdminAction('override_total', 'billing_invoice', updated?.id || null,
            { family_id: row.familyId, month: _fhMonth, label: `Override: ${reason}`, amount, reason });
        showToast('Override saved.');
        await _fhLoad();
        _fhDrawerRow = _fhRows.find(r => String(r.familyId) === String(row.familyId)) || null;
        if (_fhDrawerRow) await _fhRenderDrawer(); else _fhCloseDrawer();
    } catch (err) {
        alert('Could not save that override: ' + (err.message || err));
        if (btn) { btn.disabled = false; btn.textContent = 'Save override'; }
    }
}

async function _fhApproveAsIs(row) {
    try {
        const inv = await reconcileBillingInvoice(row.familyId, _fhMonth);
        await logAdminAction('approve_as_is', 'billing_invoice', inv?.id || null, { family_id: row.familyId, month: _fhMonth });
        showToast(`${row.name} approved as-is.`);
        await _fhLoad();
        _fhDrawerRow = _fhRows.find(r => String(r.familyId) === String(row.familyId)) || null;
        if (_fhDrawerRow) await _fhRenderDrawer(); else _fhCloseDrawer();
    } catch (err) {
        alert('Could not approve that bill: ' + (err.message || err));
    }
}

function _fhShowPaymentForm(row) {
    const host = _fhEl('fhInlineForm');
    if (!host) return;
    const monthOptions = (row.owedMonths.length ? row.owedMonths.map(m => m.month) : [_fhMonth]);
    if (!monthOptions.includes(_fhMonth)) monthOptions.unshift(_fhMonth);
    host.innerHTML = `
        <div class="fh-mini-form">
            <label>Amount <input type="number" id="fhPayAmount" min="0.01" step="0.01" placeholder="0.00"></label>
            <label>Date <input type="date" id="fhPayDate" value="${new Date().toISOString().slice(0, 10)}"></label>
            <label>Apply to
                <select id="fhPayMonth">${monthOptions.map(m => `<option value="${m}">${_fhMonthLabel(m)}</option>`).join('')}</select>
            </label>
            <label>Method
                <select id="fhPayMethod"><option value="check">Check</option><option value="cash">Cash</option><option value="other">Other</option></select>
            </label>
            <div class="fh-mini-form-btns">
                <button type="button" class="btn-primary btn-sm" id="fhPaySave">Record payment</button>
                <button type="button" class="btn-ghost btn-sm" id="fhPayCancel">Cancel</button>
            </div>
        </div>`;
    _fhEl('fhPayCancel').addEventListener('click', () => { host.innerHTML = ''; });
    _fhEl('fhPaySave').addEventListener('click', () => _fhSubmitPayment(row));
}

async function _fhSubmitPayment(row) {
    const amount = parseFloat(_fhEl('fhPayAmount')?.value || '');
    const date   = _fhEl('fhPayDate')?.value;
    const month  = _fhEl('fhPayMonth')?.value || _fhMonth;
    const method = _fhEl('fhPayMethod')?.value || 'other';
    if (!amount || isNaN(amount) || amount <= 0) { alert('Amount must be greater than $0.'); return; }
    if (!date) { alert('Payment date is required.'); return; }
    const btn = _fhEl('fhPaySave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const cycle = await getOrCreateBillingCycle(month);
        const invAll = cycle ? await fetchInvoicesForCycle(cycle.id) : [];
        const invoice = invAll.find(i => String(i.family_id) === String(row.familyId) && (i.invoice_type || 'original') === 'original');
        const recordedBy = await getAdminEmail().catch(() => '');
        await insertBillingPayment({
            family_id: row.familyId, invoice_id: invoice?.id || null,
            amount, payment_date: date, payment_method: method, note: '', created_by: recordedBy,
        });
        if (invoice?.id && typeof reconcileInvoiceStatus === 'function') await reconcileInvoiceStatus(invoice.id);
        await logAdminAction('record_payment', 'billing_payment', null, { family_id: row.familyId, invoice_id: invoice?.id || null, amount, payment_date: date, month });
        showToast('Payment recorded.');
        await _fhLoad();
        _fhDrawerRow = _fhRows.find(r => String(r.familyId) === String(row.familyId)) || null;
        if (_fhDrawerRow) await _fhRenderDrawer(); else _fhCloseDrawer();
    } catch (err) {
        alert('Could not save that payment: ' + (err.message || err));
        if (btn) { btn.disabled = false; btn.textContent = 'Record payment'; }
    }
}

// ── Print statement overlay ──────────────────────────────────
function _fhPrintStatement(row, payments) {
    const scrim = _fhEl('fhPrintScrim');
    const sheet = _fhEl('fhPrintSheet');
    if (!scrim || !sheet) return;
    const monthsHtml = (row.owedMonths.length ? row.owedMonths : [{ month: _fhMonth, billed: row.total, collected: 0 }])
        .map(m => `<tr><td>${escHtml(_fhMonthLabel(m.month))}</td><td style="text-align:right">${_fhMoney(m.billed)}</td><td style="text-align:right">${_fhMoney(m.collected)}</td><td style="text-align:right">${_fhMoney(Math.max(0, m.billed - m.collected))}</td></tr>`)
        .join('');
    const paymentsHtml = (payments || []).map(p =>
        `<tr><td>${escHtml(friendlyShort(String(p.payment_date || '').slice(0, 10)))}</td><td>${escHtml(p.payment_method || '')}</td><td style="text-align:right">${_fhMoney(p.amount)}</td></tr>`
    ).join('') || '<tr><td colspan="3">No payments recorded.</td></tr>';

    sheet.innerHTML = `
        <h1>${escHtml(row.name)}</h1>
        <p>Statement generated ${escHtml(friendlyShort(new Date().toISOString().slice(0, 10)))}</p>
        <h2>Balance by month</h2>
        <table><thead><tr><th>Month</th><th>Charged</th><th>Paid</th><th>Balance</th></tr></thead><tbody>${monthsHtml}</tbody></table>
        <h2>Payments</h2>
        <table><thead><tr><th>Date</th><th>Method</th><th>Amount</th></tr></thead><tbody>${paymentsHtml}</tbody></table>
        <h2>Total balance due: ${_fhMoney(row.owed)}</h2>`;
    scrim.style.display = 'flex';
    setTimeout(() => window.print(), 300);
}

function _fhClosePrintOverlay() {
    const scrim = _fhEl('fhPrintScrim');
    if (scrim) scrim.style.display = 'none';
}
