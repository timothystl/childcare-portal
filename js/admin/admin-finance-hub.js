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

// "Read-only history" means the month already happened — a future month has
// no history yet and should get the same live, editable Ledger the current
// month gets. String comparison is safe here: month keys are zero-padded
// 'YYYY-MM', which sorts identically to chronological order.
function _fhIsLedgerMonth(month) { return month >= _fhDefaultMonth(); }

// ── Entry point ──────────────────────────────────────────────
// #fhBody (header + tabs + panes, all of it — see admin.html) stays behind
// #fhSkeleton until this first _fhLoad() resolves, so the header — grouped
// with the month label and search in one row now — never renders a beat
// ahead of the data-dependent content underneath it. Only the FIRST open
// gates on this; _fhGoToMonth()/_fhSwitchTab() call _fhLoad() again later
// without touching the skeleton, so the header/tabs/search stay visible and
// interactive during ordinary navigation (only #fhRoot's own "Loading…"
// swaps in place there, same as it always has).
async function renderFinanceHubTool() {
    if (!_fhMonth) _fhMonth = _fhDefaultMonth();
    _fhTab = 'ledger';
    _fhFilter = 'all';
    _fhSearch = '';
    _fhReportLoaded = false;
    _fhBindHeaderOnce();
    // Re-entering the tool must land on the Ledger *visually*, not just in
    // state: pane visibility survives navigating away, so leaving on Billing
    // Report and coming back showed the report under a highlighted Ledger tab.
    _fhSwitchTab('ledger');
    _fhEl('fhBody')?.style.setProperty('display', 'none');
    _fhEl('fhSkeleton')?.style.removeProperty('display');
    try {
        await _fhLoad();
    } finally {
        _fhEl('fhSkeleton')?.style.setProperty('display', 'none');
        _fhEl('fhBody')?.style.removeProperty('display');
    }
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
    _fhEl('fhPrintNowBtn')?.addEventListener('click', () => window.print());

    // Billing Report row clicks switch to the Ledger tab AND open that
    // family's drawer in the same action (implementation spec §5) — a
    // delegated listener so admin-billing-report.js's own render functions
    // never need to know Finance Hub exists.
    _fhEl('billingReportSection')?.addEventListener('click', async e => {
        const tr = e.target.closest('[data-br-email]');
        if (!tr) return;
        const email = (tr.dataset.brEmail || '').toLowerCase();
        if (!email) return;
        const fam = (allFamiliesData || []).find(f =>
            (f.parent_email  || '').toLowerCase() === email ||
            (f.parent2_email || '').toLowerCase() === email);
        if (!fam) return;
        const brMonthVal = _fhEl('brMonth')?.value;
        if (brMonthVal && brMonthVal !== _fhMonth) { _fhMonth = brMonthVal; await _fhLoad(); }
        _fhSwitchTab('ledger');
        _fhOpenDrawer(fam.id);
    });
}

function _fhGoToMonth(month) {
    _fhMonth = month;
    _fhFilter = 'all';
    _fhLoad();
    // The header's month nav is shared across all three tabs, but Billing
    // Report and Bookkeeper each keep their own month state (_brMonth /
    // _bkMonth) — _fhLoad() only refreshes the Ledger pane, so without this
    // the tab actually on screen kept showing the *old* month while the
    // header above it already said the new one.
    if (_fhTab === 'report') {
        const brMonth = _fhEl('brMonth');
        if (brMonth) brMonth.value = _fhMonth;
        if (typeof renderBillingReportTool === 'function') renderBillingReportTool();
    } else if (_fhTab === 'bookkeeper' && typeof renderFinanceBookkeeper === 'function') {
        renderFinanceBookkeeper(_fhMonth);
    }
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
    const bkPane     = _fhEl('fhBookkeeperPane');
    if (ledgerPane) ledgerPane.style.display = tab === 'ledger' ? '' : 'none';
    if (reportPane) reportPane.style.display = tab === 'report' ? '' : 'none';
    if (bkPane)     bkPane.style.display     = tab === 'bookkeeper' ? '' : 'none';
    // The note editor and the month/search toolbar belong to the Ledger and
    // the Billing Report. Bookkeeper carries its own month controls per
    // sub-view, and "note on every invoice email" is a Ledger setting — both
    // read as broken controls on a close screen.
    const noteEditor = document.querySelector('#financeHubSection .fh-note-editor');
    if (noteEditor) noteEditor.style.display = tab === 'bookkeeper' ? 'none' : '';
    const searchBox = _fhEl('fhSearch');
    if (searchBox) searchBox.style.display = tab === 'bookkeeper' ? 'none' : '';
    if (tab === 'report' && !_fhReportLoaded) {
        _fhReportLoaded = true;
        const brMonth = _fhEl('brMonth');
        if (brMonth && !brMonth.value) brMonth.value = _fhMonth;
        if (typeof renderBillingReportTool === 'function') renderBillingReportTool();
    }
    if (tab === 'bookkeeper' && typeof renderFinanceBookkeeper === 'function') {
        renderFinanceBookkeeper(_fhMonth);
    }
}

/** getOrCreateBillingCycle(), tolerant of one specific transient failure:
 *  if the read half of that read-then-insert momentarily can't see an
 *  already-existing row (a session/token hiccup right as the RLS-gated
 *  SELECT runs), it wrongly concludes the cycle doesn't exist and tries to
 *  INSERT one — which then fails loudly on the same RLS check, as
 *  "new row violates row-level security policy for table billing_cycles"
 *  even though the row was there the whole time. A plain re-read a moment
 *  later almost always finds it, since the hiccup was momentary, not a real
 *  permission problem (admin_role() is otherwise unchanged for this admin). */
async function _fhGetOrCreateCycleResilient(month) {
    try {
        return await getOrCreateBillingCycle(month);
    } catch (err) {
        const msg = String(err?.message || '');
        if (!/row-level security/i.test(msg)) throw err;
        await new Promise(r => setTimeout(r, 400));
        const retried = await fetchBillingCycle(month);
        if (retried) return retried;
        throw err;
    }
}

// ── Load ─────────────────────────────────────────────────────
async function _fhLoad() {
    // Bookkeeper reads the same figures; a ledger write must not leave the
    // close screen showing the pre-write numbers behind a tab switch. Pass
    // the month explicitly — bookkeeperInvalidate() evicts only that one
    // cached month rather than recomputing the whole year on every write,
    // which was the actual cause of "the Bookkeeper tab is very slow."
    if (typeof bookkeeperInvalidate === 'function') bookkeeperInvalidate(_fhMonth);
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
        const cycle  = await _fhGetOrCreateCycleResilient(_fhMonth);
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
                // Carried through from computeBillMonthExceptions() so the
                // strip can show gross tuition / discounts / fees separately
                // instead of just the one net number. base is already net of
                // both the individual and sibling discount (see that
                // function's own comment); discount is the sum of both, so
                // base + discount is the pre-discount "sticker" tuition.
                base: r.base || 0, discount: r.discount || 0,
                changeFees: r.changeFees || 0, regFee: r.regFee || 0,
                familyNewFee: r.familyNewFee || 0, creditTotal: r.creditTotal || 0,
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
            // Read-only — a month that was never billed has no cycle row,
            // and that means "nothing happened," not something to create.
            // getOrCreateBillingCycle() is for the one month _fhLoad() is
            // actually editing; this trailing-months pass only ever reads.
            const cycle = await fetchBillingCycle(mk);
            const invAll = cycle ? await fetchInvoicesForCycle(cycle.id) : [];
            const invoices = invAll.filter(i => (i.invoice_type || 'original') === 'original' && i.status !== 'void');
            const payments = await fetchPaymentsForMonth(mk);
            const paymentsByFamily = new Map();
            payments.forEach(p => {
                const key = String(p.family_id);
                const prev = paymentsByFamily.get(key) || [];
                prev.push(p);
                paymentsByFamily.set(key, prev);
            });

            const rows = _buildArRows(mk, allFamiliesData, invoices, payments);
            rows.forEach(r => {
                if (!r.familyId) return;
                const key = String(r.familyId);
                const prev = byFamily.get(key) || { outstanding: 0, months: [] };
                prev.outstanding += r.outstanding;
                if (r.billed > 0 || r.collected > 0) {
                    const famPayments = paymentsByFamily.get(key) || [];
                    const lastPaymentDate = famPayments.length
                        ? famPayments.map(p => p.payment_date).sort().slice(-1)[0]
                        : null;
                    prev.months.push({
                        month: mk, billed: r.billed, collected: r.collected,
                        sentAt: r.sentAt, invoiceId: r.invoiceId, lastPaymentDate,
                    });
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

    if (_fhIsLedgerMonth(_fhMonth)) {
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

/** One row per family that owes money — deduplicated by familyId.
 *  ⚠️ _fhRows can carry TWO rows for the same family in the same month.
 *  computeBillMonthExceptions() flags "withdrawn" by comparing which
 *  parent's email is on *this* month's registration-derived row against
 *  *last* month's — so a family where either parent can register, and a
 *  different parent happens to submit each month, reads as "present last
 *  month, absent this month" even though they never actually left. That
 *  produces a real active row AND a spurious withdrawn row, both resolved
 *  to the same familyId in _fhLoad() (it matches on both parent_email and
 *  parent2_email) and both carrying the identical _fhOwed balance. Verified
 *  live: the Scheetz family registered under lindseymartie@gmail.com in
 *  July and fscheetz31@yahoo.com in August — same family, same three kids,
 *  never withdrew. Summing every row with owed > 0 double-counts every
 *  family this happens to. Preferring the non-withdrawn row when both
 *  exist keeps the real, current one. */
function _fhOwingRowsDeduped() {
    const byFamily = new Map();
    _fhRows.forEach(r => {
        if (r.owed <= 0 || !r.familyId) return;
        const existing = byFamily.get(r.familyId);
        if (!existing || (existing.status === 'withdrawn' && r.status !== 'withdrawn')) {
            byFamily.set(r.familyId, r);
        }
    });
    return [...byFamily.values()];
}

function _fhFilterCounts() {
    const active = _fhRows.filter(r => r.status !== 'withdrawn');
    return {
        all:           active.length,
        needs_review:  active.filter(r => r.status === 'needs_review').length,
        drafted:       active.filter(r => r.status === 'drafted').length,
        sent:          active.filter(r => r.status === 'sent').length,
        card_declined: 0, // no payment-processor decline signal exists yet — see BILLING_MODEL.md
        // ⚠️ Deliberately NOT scoped to `active`. r.owed is the cross-month
        // balance (_fhOwed), not this month's invoice — a family with no
        // booking in the viewed month still owes whatever they owed before,
        // and "withdrawn" here only ever means "no days booked this month."
        // Deduplicated per _fhOwingRowsDeduped — see its own comment.
        owing:         _fhOwingRowsDeduped().length,
        // r.ar?.billed alone no longer implies "sent" — _buildArRows() keeps
        // it as the raw drafted-or-sent amount now that `owed` is correctly
        // gated on sent_at (see that function's own comment). Check sentAt
        // directly so an unsent draft with owed<=0 (nothing sent, so nothing
        // owed) doesn't misread as "paid."
        paid:          active.filter(r => r.owed <= 0 && r.ar?.sentAt).length,
        withdrawn:     _fhRows.filter(r => r.status === 'withdrawn').length,
    };
}

function _fhVisibleRows() {
    const q = _fhSearch.trim().toLowerCase();
    const owingRows = _fhFilter === 'owing' ? _fhOwingRowsDeduped() : null;
    return _fhRows.filter(r => {
        if (q && !r.name.toLowerCase().includes(q)) return false;
        switch (_fhFilter) {
            case 'all':           return r.status !== 'withdrawn';
            case 'needs_review':  return r.status === 'needs_review';
            case 'drafted':       return r.status === 'drafted';
            case 'sent':          return r.status === 'sent';
            case 'card_declined': return false;
            case 'owing':         return owingRows.includes(r); // deduplicated — see _fhOwingRowsDeduped
            case 'paid':          return r.status !== 'withdrawn' && r.owed <= 0 && r.ar?.sentAt;
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

    // What this one month's care actually costs, full stop — every active
    // family's row.total (drafted, sent, or already paid, doesn't matter),
    // summed. Same source as Billing Report's own "Total to bill" (no second
    // calculation, per this file's header note), just surfaced right here so
    // it doesn't take a tab switch to see. Deliberately NOT the owed banner's
    // number: this is what this month alone bills for; the banner below is a
    // running balance across every open month.
    const monthTotal = active.reduce((s, r) => s + r.total, 0);

    // The single "Total to bill" figure above reads as the final answer, but
    // it's a net number — discounts are already subtracted into it and fees
    // already added — so a director asking "why is it this much" had no way
    // to see either piece. Broken out here from the same per-row fields
    // computeBillMonthExceptions() already computes (nothing new calculated):
    // grossTuition is the sticker-price tuition before any discount (r.base
    // is already net of both the individual and sibling discount, so adding
    // r.discount back gives the pre-discount figure); discountsTotal is what
    // came off; feesTotal is what got added on top (registration fee,
    // new-family fee, schedule-change fees, net of any account credit
    // applied). grossTuition − discountsTotal + feesTotal === monthTotal.
    const grossTuition   = active.reduce((s, r) => s + (r.base || 0) + (r.discount || 0), 0);
    const discountsTotal = active.reduce((s, r) => s + (r.discount || 0), 0);
    const feesTotal      = active.reduce((s, r) =>
        s + (r.changeFees || 0) + (r.regFee || 0) + (r.familyNewFee || 0) - (r.creditTotal || 0), 0);

    // ⚠️ NOT `active.filter(...)`. r.owed is the real cross-month balance
    // (_fhOwed) — a family with no booking this month ("withdrawn" for this
    // month's exceptions only) can still owe every dollar of an earlier
    // month's unpaid invoice, and this banner promises "across every open
    // month, not just [this month]." Scoping to `active` silently dropped
    // any family not currently billed, which made the total (and the
    // aging detail, and Nudge all's own displayed count below) collapse
    // toward zero the moment registrations thinned out for a future month
    // — read as "paid off" when nothing had actually been paid. Deduplicated
    // by family — see _fhOwingRowsDeduped — so a family whose withdrawal
    // flag is a false positive (a different parent registered this month)
    // is counted once, not twice.
    const owingRows = _fhOwingRowsDeduped();
    const owedTotal = owingRows.reduce((s, r) => s + r.owed, 0);

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
                <div class="fh-stat-num">${_fhMoney(grossTuition)}</div>
                <div class="fh-stat-label">Tuition, ${_fhMonthLabel(_fhMonth)} — before discounts</div>
            </div>
            <span class="fh-arrow">→</span>
            <div class="fh-stat fh-stat-muted">
                <div class="fh-stat-num">${_fhMoney(-discountsTotal)}</div>
                <div class="fh-stat-label">Discounts</div>
            </div>
            <span class="fh-arrow">→</span>
            <div class="fh-stat">
                <div class="fh-stat-num">${_fhMoney(feesTotal)}</div>
                <div class="fh-stat-label">Fees</div>
            </div>
            <span class="fh-arrow">→</span>
            <div class="fh-stat fh-stat-month">
                <div class="fh-stat-num">${_fhMoney(monthTotal)}</div>
                <div class="fh-stat-label">Amount to collect, ${_fhMonthLabel(_fhMonth)} — this month alone</div>
            </div>
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
            <div class="fh-stat fh-stat-muted is-clickable" data-fh-filter="sent">
                <div class="fh-stat-num">${sent.length}</div>
                <div class="fh-stat-label">Issued</div>
            </div>
            <div class="fh-strip-spacer"></div>
            <button type="button" class="fh-release-btn" id="fhReleaseBtn" title="Recomputes and emails every invoice above, then marks each Issued." ${drafted.length ? '' : 'disabled'}>Release ${drafted.length} invoice${drafted.length === 1 ? '' : 's'}</button>
        </div>

        <div class="fh-owed-banner">
            <div class="fh-owed-main">
                <strong>${_fhMoney(owedTotal)} owed</strong> · <span class="fh-owed-famcount">${owingRows.length} famil${owingRows.length === 1 ? 'y' : 'ies'}</span>
                <div class="fh-owed-sub">across every open month, not just ${_fhMonthLabel(_fhMonth)} · computed live from the rows below</div>
            </div>
            <div class="fh-owed-actions">
                <button type="button" class="fh-owed-btn-primary" id="fhNudgeAllBtn" ${owingRows.length ? '' : 'disabled'}>Nudge all ${owingRows.length}</button>
                <button type="button" class="fh-owed-btn-outline" id="fhAgingToggleBtn">${_fhShowAging ? 'Hide aging detail' : 'Open aging detail →'}</button>
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
                    <th>Family</th><th class="fh-money-col">${_fhMonthLabel(_fhMonth).split(' ')[0]}</th>
                    <th class="fh-money-col">Paid this month</th>
                    <th>Status</th><th>Note</th>
                    <th class="fh-money-col">Balance, all months</th><th></th>
                </tr></thead>
                <tbody>
                    ${rows.length ? rows.map(_fhRowHtml).join('') : `<tr><td colspan="7"><p class="empty-hint">No families match.</p></td></tr>`}
                </tbody>
            </table>
        </div>
        <p class="ap-note fh-footer-note">${_fhBillingReportLinkNote()}</p>`;

    _fhBindLedgerListeners(root);
}

/** "Billing Report is the only other screen — read-only, for the binder or
 *  export. This ledger is the only place balances change." — always visible
 *  per the implementation spec, with "Billing Report" as a live link into
 *  that tab (not just prose), on both the Ledger and the month-history view. */
function _fhBillingReportLinkNote() {
    return `<button type="button" class="fh-link-btn" data-fh-tab="report">Billing Report</button> is the only other screen — read-only, for the binder or export. This ledger is the only place balances change.`;
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
        ? `<button type="button" class="fh-send-btn" data-fh-send="${row.familyId}">Send invoice</button>` : '';
    const remindSlot = row.owed > 0
        ? `<button type="button" class="btn-xs" data-fh-remind="${row.familyId}">${dispStatus === 'card_declined' ? 'Retry charge' : 'Remind'}</button>` : '';
    const actions = `<span class="fh-action-slot">${sendSlot}</span><span class="fh-action-slot">${remindSlot}</span>`;

    const paidThisMonth = row.ar?.collected || 0;

    return `<tr data-fh-row="${row.familyId}">
        <td class="fh-row-open" data-fh-open="${row.familyId}"><strong>${escHtml(row.name)}</strong></td>
        <td class="fh-money-col">${_fhMoney(row.total)}</td>
        <td class="fh-money-col ${paidThisMonth > 0 ? 'fh-bal-clear' : ''}">${paidThisMonth > 0 ? _fhMoney(paidThisMonth) : '—'}</td>
        <td><span class="fh-pill ${meta.cls}">${escHtml(pillLabel)}</span></td>
        <td class="fh-note">${_fhNoteFor(row)}</td>
        <td class="fh-money-col ${balCls}">${_fhMoney(row.owed)}</td>
        <td class="fh-row-actions">${actions}</td>
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
    root.querySelectorAll('[data-fh-tab]').forEach(el => {
        el.addEventListener('click', () => _fhSwitchTab(el.dataset.fhTab));
    });
}

// ── Month history (read-only) ───────────────────────────────
function _fhRenderMonthHistory() {
    const root = _fhEl('fhRoot');
    if (!root) return;
    const rows = _fhRows.filter(r => r.status !== 'withdrawn' && (r.ar?.billed > 0 || r.total > 0));
    // Same figure the "Charged" column below sums to — r.ar?.billed is the
    // real invoice amount where one exists, r.total (computeBillMonthExceptions)
    // otherwise. No second calculation, so this card can't disagree with the
    // table under it.
    const monthTotal = rows.reduce((s, r) => s + (r.ar?.billed || r.total), 0);
    root.innerHTML = `
        <div class="fh-strip">
            <div class="fh-stat fh-stat-month">
                <div class="fh-stat-num">${_fhMoney(monthTotal)}</div>
                <div class="fh-stat-label">Total invoiced, ${_fhMonthLabel(_fhMonth)}</div>
            </div>
            <div class="fh-stat">
                <div class="fh-stat-num">${rows.length}</div>
                <div class="fh-stat-label">Families, ${_fhMonthLabel(_fhMonth).split(' ')[0]}</div>
            </div>
        </div>
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
        <p class="ap-note fh-footer-note fh-history-foot">${_fhBillingReportLinkNote()}</p>`;

    root.querySelectorAll('[data-fh-open]').forEach(el => {
        el.addEventListener('click', () => _fhOpenDrawer(el.dataset.fhOpen));
    });
    root.querySelectorAll('[data-fh-tab]').forEach(el => {
        el.addEventListener('click', () => _fhSwitchTab(el.dataset.fhTab));
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
    // Deduplicated — see _fhOwingRowsDeduped. Without it, a family whose
    // withdrawal flag is a false positive would get nudged twice in one click.
    const owing = _fhOwingRowsDeduped();
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
                <button type="button" class="fh-dr-action-btn fh-dr-action-fee" id="fhAddFeeBtn">+ Add a fee</button>
                <button type="button" class="fh-dr-action-btn fh-dr-action-credit" id="fhAddCreditBtn">+ Add a credit</button>` : ''}
            ${row.status === 'drafted' ? `<button type="button" class="fh-dr-action-btn fh-dr-action-send" id="fhDrSendBtn">Send invoice</button>` : ''}
            <button type="button" class="fh-dr-action-btn fh-dr-action-print" id="fhPrintStatementBtn">Print statement</button>
        </div>
        <div id="fhInlineForm"></div>
        <div class="fh-dr-row">
            ${row.status !== 'sent' ? `<button type="button" class="fh-override-btn" id="fhOverrideBtn">Override total (rare — needs a reason)</button>` : ''}
            ${row.status === 'needs_review' ? `<button type="button" class="btn-approve" id="fhApproveBtn">&check; Approve as-is</button>` : ''}
        </div>

        <div class="inc-dr-field">
            <div class="fh-dr-card-title">Balance by month</div>
            ${(row.owedMonths.length ? row.owedMonths : [{ month: _fhMonth, billed: row.total, collected: 0, sentAt: null, lastPaymentDate: null }]).map(m => `
                <div class="fh-dr-line">
                    <span>${escHtml(_fhMonthLabel(m.month))} · charged ${_fhMoney(m.billed)}${m.sentAt ? ` (${escHtml(friendlyShort(String(m.sentAt).slice(0, 10)))})` : ''} · paid ${_fhMoney(m.collected)}${m.lastPaymentDate ? ` (${escHtml(friendlyShort(String(m.lastPaymentDate).slice(0, 10)))})` : ''}</span>
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
                    <span>${escHtml(friendlyShort(String(p.payment_date || '').slice(0, 10)))} · ${p.payment_method === 'autopay' || p.source === 'processor' ? 'Autopay' : `Manual${p.payment_method ? ' · ' + escHtml(p.payment_method) : ''}`}</span>
                    <span class="fh-pay-amt">${_fhMoney(p.amount)} → ${escHtml(_fhMonthLabel(_fhMonthForInvoice(row, p.invoice_id)))}</span>
                    ${_fhCanRefund(p, familyPayments)
                        ? `<button type="button" class="fh-link-btn fh-pay-refund-btn" data-payment-id="${p.id}" data-processor="${escHtml(p.processor)}">↩ Refund</button>`
                        : ''}
                </li>`).join('')}</ul>` : '<p class="empty-hint">No payments recorded yet.</p>'}
        </div>

        <div class="inc-dr-foot">
            <button type="button" class="fh-dr-save-btn" id="fhDrawerCloseFoot">Save</button>
            <button type="button" class="fh-dr-remind-btn" id="fhDrawerRemindBtn">Send payment reminder</button>
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
    body.querySelectorAll('.fh-pay-refund-btn').forEach(btn => {
        btn.addEventListener('click', () => _fhRefundPayment(Number(btn.dataset.paymentId), btn.dataset.processor, row));
    });
}

/** An online card charge (Authorize.net or Stax) can be reversed; a payment
 *  already reversed (or itself a reversal) never gets a button, so it can't
 *  be double-clicked into two refunds for the same charge. Mirrors the same
 *  gate the old admin-billing.js AR table used, before that table's own
 *  section (billingArSection) was retired from AP_TOOLS and became
 *  unreachable — this drawer is the live place a family's payments are
 *  actually seen today, so this is where the control has to live. */
function _fhCanRefund(p, allPayments) {
    const REFUNDABLE_PROCESSORS = new Set(['authorizenet', 'stax']);
    if (!REFUNDABLE_PROCESSORS.has(p.processor)) return false;
    if (!(parseFloat(p.amount || 0) > 0)) return false;
    if (p.refund_of_payment_id) return false;
    return !allPayments.some(o => o.refund_of_payment_id === p.id);
}

/** Refund/void an online card payment from the Ledger drawer. Only asks the
 *  processor that actually took the charge to reverse it —
 *  admin-refund-payment / admin-refund-stax-payment never touch
 *  billing_payments or the invoice itself, so this button's job ends at
 *  "submitted," not "done." The processor's own webhook records the actual
 *  reversal a few seconds later; _fhLoad() (which invalidates Bookkeeper's
 *  cache, per this file's own convention) and a drawer re-render pick it up
 *  the next time either is opened, not because the reversal is guaranteed
 *  to be reflected immediately. */
async function _fhRefundPayment(paymentId, processor, row) {
    const processorName = processor === 'stax' ? 'Stax' : 'Authorize.net';
    if (!confirm(`Refund or void this online payment? This asks ${processorName} to reverse the charge and cannot be undone from here.`)) {
        return;
    }
    try {
        const result = await adminRefundPayment(paymentId, processor);
        alert(`${result.kind === 'void' ? 'Void' : 'Refund'} submitted. It will show here once ${processorName} confirms it (usually a few seconds).`);
        await logAdminAction(`${result.kind}_submitted`, 'billing_payment', paymentId);
        await _fhLoad();
        _fhDrawerRow = _fhRows.find(r => String(r.familyId) === String(row.familyId)) || null;
        if (_fhDrawerRow) await _fhRenderDrawer(); else _fhCloseDrawer();
    } catch (err) {
        alert('Refund failed: ' + err.message);
    }
}

/** Which open month a payment belongs to, from the invoice it was recorded
 *  against — payments carry an invoice_id, not a month, so this resolves it
 *  from the trailing-months lookup already built for the drawer. Falls back
 *  to the current month for a payment outside that window (rare — mostly
 *  matters for the display label, never for the underlying record). */
function _fhMonthForInvoice(row, invoiceId) {
    if (invoiceId != null) {
        const hit = row.owedMonths.find(m => String(m.invoiceId) === String(invoiceId));
        if (hit) return hit.month;
        if (row.ar?.invoiceId != null && String(row.ar.invoiceId) === String(invoiceId)) return _fhMonth;
    }
    return _fhMonth;
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
    host.innerHTML = `
        <div class="fh-mini-form fh-mini-form-fee">
            <div class="fh-mini-form-title">${kind === 'fee' ? 'New fee' : 'New credit'}</div>
            <input type="text" id="fhLineLabel" placeholder="${kind === 'fee' ? 'e.g. Late pickup fee' : 'e.g. Sibling credit'}">
            <input type="number" id="fhLineAmount" min="0.01" step="0.01" placeholder="Amount">
            <div class="fh-mini-form-btns">
                <button type="button" class="fh-mini-confirm fh-mini-confirm-fee" id="fhLineAdd">Add</button>
                <button type="button" class="fh-mini-cancel" id="fhLineCancel">Cancel</button>
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
        if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
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
            <div class="fh-mini-form-title">Override total for ${escHtml(_fhMonthLabel(_fhMonth))}</div>
            <input type="number" id="fhOvAmount" min="0" step="0.01" placeholder="New total" value="${row.total.toFixed(2)}">
            <input type="text" id="fhOvReason" placeholder="Reason (required — shows on the statement)">
            <div class="fh-mini-form-btns">
                <button type="button" class="fh-mini-confirm fh-mini-confirm-override" id="fhOvSave">Override</button>
                <button type="button" class="fh-mini-cancel" id="fhOvCancel">Cancel</button>
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
        if (btn) { btn.disabled = false; btn.textContent = 'Override'; }
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

    // Sort every open month oldest-first and default to the earliest one
    // that still has a balance — never default to "today's month" (spec §5:
    // "a payment's month is chosen explicitly... defaulted to the family's
    // first open month, not necessarily the current month").
    const months = (row.owedMonths.length ? [...row.owedMonths] : [{ month: _fhMonth, billed: row.total, collected: 0 }]);
    if (!months.some(m => m.month === _fhMonth)) months.push({ month: _fhMonth, billed: row.total, collected: 0 });
    months.sort((a, b) => a.month.localeCompare(b.month));
    const firstOpen = months.find(m => (m.billed - m.collected) > 0) || months[0];

    host.innerHTML = `
        <div class="fh-mini-form fh-mini-form-pay">
            <input type="number" id="fhPayAmount" min="0.01" step="0.01" placeholder="Amount">
            <input type="date" id="fhPayDate" value="${new Date().toISOString().slice(0, 10)}">
            <select id="fhPayMonth">${months.map(m => `<option value="${m.month}"${m.month === firstOpen.month ? ' selected' : ''}>Apply to ${_fhMonthLabel(m.month)}</option>`).join('')}</select>
            <select id="fhPayMethod"><option value="check">Check</option><option value="cash">Cash</option><option value="other">Other</option></select>
            <div class="fh-mini-form-btns">
                <button type="button" class="fh-mini-confirm fh-mini-confirm-pay" id="fhPaySave">Record</button>
                <button type="button" class="fh-mini-cancel" id="fhPayCancel">Cancel</button>
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
        if (btn) { btn.disabled = false; btn.textContent = 'Record'; }
    }
}

// ── Print statement overlay ──────────────────────────────────
function _fhPrintStatement(row, payments) {
    const scrim = _fhEl('fhPrintScrim');
    const sheet = _fhEl('fhPrintSheet');
    if (!scrim || !sheet) return;
    const monthLabel = _fhMonthLabel(_fhMonth);
    const monthWord  = monthLabel.split(' ')[0];
    const thisMonth = row.owedMonths.find(m => m.month === _fhMonth) || { billed: row.total, collected: 0 };

    const chargeRows = (row.owedMonths.length ? row.owedMonths : [{ month: _fhMonth, billed: row.total }])
        .map(m => `<tr><td>${escHtml(_fhMonthLabel(m.month))} charge</td><td style="text-align:right">${_fhMoney(m.billed)}</td></tr>`)
        .join('');
    const paymentsHtml = (payments || []).map(p =>
        `<tr><td>${escHtml(friendlyShort(String(p.payment_date || '').slice(0, 10)))} — ${escHtml(p.payment_method || 'payment')}</td><td style="text-align:right">${_fhMoney(p.amount)}</td></tr>`
    ).join('') || '<tr><td>No payments recorded.</td><td></td></tr>';

    sheet.innerHTML = `
        <h1>${escHtml(row.name)} — ${escHtml(monthLabel)} statement</h1>
        <table><thead><tr><th>Charge</th><th>Amount</th></tr></thead><tbody>${chargeRows}
            <tr><td><strong>Total, ${escHtml(monthWord)}</strong></td><td style="text-align:right"><strong>${_fhMoney(thisMonth.billed)}</strong></td></tr>
        </tbody></table>
        <h2>Payments</h2>
        <table><thead><tr><th>Payments</th><th></th></tr></thead><tbody>${paymentsHtml}</tbody></table>
        <p class="fh-print-balance">Balance, all open months: ${_fhMoney(row.owed)}</p>`;
    scrim.style.display = 'flex';
}

function _fhClosePrintOverlay() {
    const scrim = _fhEl('fhPrintScrim');
    if (scrim) scrim.style.display = 'none';
}
