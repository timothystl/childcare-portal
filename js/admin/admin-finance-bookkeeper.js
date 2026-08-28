// ============================================================
// admin-finance-bookkeeper — Finance Hub, third tab (design handoff:
// Finance Hub §6 / IMPLEMENTATION_SPEC §8–§9, 2026-08-26)
// ============================================================
// Six sub-views behind one pill nav: Overview · Accounts Receivable ·
// Room P&L · Month-End Close · Reconciliation · GL Export.
//
// This tab consolidates what used to be seven separate Finance sidebar
// tools (Revenue Dashboard, Financial Dashboard, Room Profitability,
// Attendance & Revenue, Annual Budget, Accounts Receivable, Reconcile
// Payments). Those AP_TOOLS entries are retired in admin-portal.js —
// the director's complaint was a shelf of screens whose numbers did not
// visibly agree, and adding a Bookkeeper tab while leaving the originals
// reachable would have made the shelf longer, not shorter.
//
// ⚠️ ONE COMPUTED DATASET, same rule as the Ledger. Revenue and child-days
// come from _buildFamilyBillingData() (admin-reports.js) — the function the
// Billing Report and the Ledger already read. Labor comes from
// _buildRoomPnlData() (admin-reports.js) — the function the retired
// dashboards already read. Nothing here re-derives a dollar figure of its
// own, and nothing here writes to billing_invoices.
//
// ⚠️ Reconciliation NEVER changes an invoice or a balance. It links
// existing billing_payments rows to a bank-deposit record and nothing
// more. A payment with no matching invoice is a data problem to surface in
// the Ledger, not something this screen resolves by itself.
//
// ⚠️ Scenario planning and enrollment modeling are deliberately absent —
// they are planning tools, not close tools, and they now live under
// Planning. Do not carry setupModelingTool() in here.

let _bkView       = 'overview';
let _bkMonth      = '';
let _bkYear       = 0;
let _bkData       = null;   // { months, byMonth, rooms, pnl, budget, expenses }
let _bkPnlScope   = 'month'; // 'month' | 'ytd'
let _bkPnlMonth   = '';
let _bkAr         = { rows: [], writeOffs: [] };
let _bkClose      = null;   // { [month]: { [itemKey]: true } }
let _bkRecon      = null;   // { deposits: [], assign: { [paymentId]: depositId } }
let _bkMatching   = null;   // deposit id currently in matching mode
let _bkMatchPicks = new Set();
let _bkBusy       = false;
let _bkLoaded     = false;
let _bkYoyLoaded  = false; // Year-over-year is expensive; render it at most once per Bookkeeper session — see _bkBindOverview()
// mo → { tuition, fees, rooms } — the expensive part of _bkLoad()'s per-month
// loop (_buildFamilyBillingData(), one real synchronous pass per month),
// cached across _bkLoad() calls and across Bookkeeper sessions in this tab
// (survives navigating away and back; only a hard page reload clears it).
// Evicted per month by bookkeeperInvalidate(month), never wholesale — see
// that function's own comment for why a full clear is never actually needed.
let _bkMonthCache = new Map();

const BK_CLOSE_SETTING = 'finance_close_checklist';
const BK_RECON_SETTING = 'finance_reconciliation';

const BK_VIEWS = [
    ['overview', 'Overview'],
    ['ar',       'Accounts Receivable'],
    ['pnl',      'Room P&L'],
    ['close',    'Month-End Close'],
    ['recon',    'Reconciliation'],
    ['gl',       'GL Export'],
];

// Exact labels/details from IMPLEMENTATION_SPEC §8. `detail` may be a
// function of the render context when the copy is dynamic.
const BK_CLOSE_ITEMS = [
    { key: 'bank',    label: 'Reconcile bank feed',        detail: () => 'Match every deposit to a payment before locking the month' },
    { key: 'issued',  label: 'Confirm all invoices issued', detail: ctx => `No drafts left in the ledger for ${ctx.monthName}` },
    { key: 'writeoff',label: 'Review write-offs',           detail: ctx => ctx.writeOffDetail },
    { key: 'gl',      label: 'Export GL categories',        detail: () => 'Hand category totals to the bookkeeper' },
    { key: 'lock',    label: 'Lock the month',              detail: ctx => ctx.lockDetail },
];

function _bkEl(id) { return document.getElementById(id); }

function _bkMoney(n) {
    const v = Math.abs(Number(n) || 0);
    return (Number(n) < 0 ? '−$' : '$') + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function _bkMoney0(n) {
    const v = Math.abs(Math.round(Number(n) || 0));
    return (Number(n) < 0 ? '−$' : '$') + v.toLocaleString();
}

function _bkPct(n) { return `${Math.round(Number(n) || 0)}%`; }

function _bkMonthLabel(month) {
    const [y, m] = (month || '').split('-').map(Number);
    return m ? `${MONTH_NAMES[m - 1]} ${y}` : month;
}

function _bkMonthName(month) {
    const [, m] = (month || '').split('-').map(Number);
    return m ? MONTH_NAMES[m - 1] : month;
}

function _bkToday() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── Entry point ──────────────────────────────────────────────
// Called by _fhSwitchTab('bookkeeper') in admin-finance-hub.js. `month` is
// whatever month the Ledger is showing, so the two tabs never disagree
// about which month "this month" means.
async function renderFinanceBookkeeper(month) {
    _bkMonth = month || _bkMonth;
    if (!_bkPnlMonth || !_bkData) _bkPnlMonth = _bkMonth;
    const root = _bkEl('bkRoot');
    if (!root) return;
    if (!_bkLoaded || _bkYear !== Number((_bkMonth || '').split('-')[0])) {
        root.innerHTML = '<p class="empty-hint">Loading…</p>';
        try {
            await _bkLoad();
            _bkLoaded = true;
        } catch (err) {
            console.error('Bookkeeper load:', err);
            root.innerHTML = `<p class="empty-hint">Could not load the bookkeeper view — ${escHtml(err.message || 'unknown error')}</p>`;
            return;
        }
    }
    _bkRender();
}

/** Invalidate the cache so the next open re-reads. Called when the Ledger
 *  writes anything (invoice sent, payment recorded, fee added) — the
 *  bookkeeper numbers are the same numbers and must not go stale behind a
 *  tab switch. */
/** Called whenever the Ledger writes anything for a given month (invoice
 *  sent, payment recorded, fee added). `month`, when given, evicts only that
 *  one entry from _bkMonthCache — a Ledger write only ever changes the month
 *  it was made against, so every other month's cached figure is still
 *  correct and recomputing it would be pure waste. Omit `month` for a
 *  lighter refresh that leaves the whole cache alone (used by the
 *  lock/unlock toggle, which changes which cached figure is *displayed*,
 *  never the figure itself — see _bkLoad()'s own comment). There is
 *  deliberately no "clear everything" path: nothing in this file has ever
 *  needed one, and a family-level change (a discount edited in Family
 *  Directory, say) already isn't tracked by this signal either — that gap
 *  predates this cache and isn't one this function claims to close. */
function bookkeeperInvalidate(month) {
    _bkLoaded = false;
    _bkYoyLoaded = false;
    if (month) _bkMonthCache.delete(month);
}

// ── Load ─────────────────────────────────────────────────────
async function _bkLoad() {
    const year = Number((_bkMonth || '').split('-')[0]) || new Date().getFullYear();
    _bkYear = year;

    const today      = new Date();
    const isThisYear = year === today.getFullYear();
    // Never stop short of the month the Ledger is on: the month switcher can
    // step into a future month, and a Bookkeeper tab that silently had no row
    // for it would read as "$0 revenue," not as "not yet."
    const openMonth  = Number((_bkMonth || '').split('-')[1]) || 1;
    const lastMonth  = Math.max(isThisYear ? today.getMonth() + 1 : 12, openMonth);
    const months     = Array.from({ length: lastMonth }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);

    // Labor is capped at today rather than year-end: _buildRoomPnlData reads
    // planned staff_schedules rows, and shifts scheduled for later this month
    // have not been worked. Same reasoning as generateFinanceDashboard().
    const endDate = isThisYear ? _bkToday() : `${year}-12-31`;

    if (typeof allFamiliesData === 'undefined' || !allFamiliesData || !allFamiliesData.length) {
        allFamiliesData = await fetchAllFamilies({ includeArchived: true });
    }
    if (typeof allRegistrations === 'undefined' || !allRegistrations || !allRegistrations.length) {
        allRegistrations = await fetchAllRegistrations();
    }

    const [pnl, budget, expenses, writeOffs, closeState, reconState] = await Promise.all([
        _buildRoomPnlData(`${year}-01-01`, endDate).catch(e => { console.warn('bk pnl:', e); return { months: [], rooms: [], data: {}, centerLaborByMonth: {} }; }),
        fetchAnnualBudget(year).catch(() => null),
        fetchExpenseConfig().catch(() => ({ items: [] })),
        fetchWriteOffs().catch(() => []),
        fetchSetting(BK_CLOSE_SETTING).catch(() => null),
        fetchSetting(BK_RECON_SETTING).catch(() => null),
    ]);

    _bkClose = _bkParseState(closeState, {});
    const recon = _bkParseState(reconState, {});
    _bkRecon = { deposits: Array.isArray(recon.deposits) ? recon.deposits : [], assign: recon.assign && typeof recon.assign === 'object' ? recon.assign : {} };

    // Per-month revenue and child-days, from the one billing calculation.
    // ⚠️ Cached across _bkLoad() calls, per month (_bkMonthCache) — this is
    // the fix for "Bookkeeper is very slow." _buildFamilyBillingData() does
    // real synchronous work per family (weekly-rate grouping, sibling-
    // discount ranking) and was being re-run for all 8-12 months of the year
    // on EVERY load, including every time _fhLoad() called
    // bookkeeperInvalidate() after a single Ledger write. A Ledger write
    // only ever changes the ONE month it was made against — _fhLoad() now
    // passes that month to bookkeeperInvalidate(month), which evicts just
    // that one cache entry. Every other month's figure is already correct
    // and is reused as-is, its billing-overrides fetch included, instead of
    // being recomputed (and re-fetched) for no reason. The lock/historical
    // decision below is NOT cached — it re-reads current _bkClose state
    // every load, so locking or unlocking a month never needs a cache
    // eviction to take effect.
    const missingMonths = months.filter(mo => !_bkMonthCache.has(mo));
    // ⚠️ fetchBillingOverrides is awaited as one wave, not serially inside the
    // month loop — SX12 flags the serial version elsewhere; don't repeat it.
    const overrideRows = await Promise.all(missingMonths.map(mo => fetchBillingOverrides(mo).catch(() => [])));
    missingMonths.forEach((mo, i) => {
        const overrides = new Map((overrideRows[i] || []).map(r => [
            `${(r.parent_email || '').toLowerCase()}:${(r.child_name || '').toLowerCase()}`,
            parseFloat(r.override_amount),
        ]));
        const families = _buildFamilyBillingData(mo, overrides);
        const liveRooms = {};
        let tuition = 0, fees = 0;
        families.forEach(fam => fam.children.forEach(c => {
            const billed = (c.hasOverride ? c.overrideAmount : c.subtotal) || 0;
            const fee    = c.changeFees || 0;
            tuition += billed;
            fees    += fee;
            if (!c.roomId) return;
            if (!liveRooms[c.roomId]) liveRooms[c.roomId] = { revenue: 0, childDays: 0 };
            liveRooms[c.roomId].revenue   += billed + fee;
            liveRooms[c.roomId].childDays += (c.halfDays || 0) + (c.fullDays || 0);
        }));
        _bkMonthCache.set(mo, { tuition, fees, rooms: liveRooms });
    });

    // ⚠️ Live registrations are not the only source of truth for a past month —
    // a month billed before this app tracked registrations (or entered by hand
    // for any other reason) has rows in billing_summary and nothing in
    // registration_dates, so _buildFamilyBillingData alone reads it as $0.
    // generateFinanceDashboard() and the YoY report both fall back to
    // billing_summary for exactly this reason; mirrored here so Bookkeeper
    // never shows $0 for a month the director can see real numbers for
    // elsewhere in Finance. Historical rows have no tuition/fees split (only
    // a net_billed total), so a historical month reports its whole total as
    // tuition and $0 fees — the same simplification the dashboard makes.
    const historicalRevByMo     = {}; // mo → total net_billed
    const historicalRoomsByMo   = {}; // mo → roomId → { revenue, childDays }
    try {
        (await fetchBillingSummary()).forEach(r => {
            const mo = (r.month || '').substring(0, 7);
            if (!months.includes(mo)) return;
            const net = parseFloat(r.net_billed) || 0;
            historicalRevByMo[mo] = (historicalRevByMo[mo] || 0) + net;
            if (!r.room_id) return;
            if (!historicalRoomsByMo[mo]) historicalRoomsByMo[mo] = {};
            if (!historicalRoomsByMo[mo][r.room_id]) historicalRoomsByMo[mo][r.room_id] = { revenue: 0, childDays: 0 };
            historicalRoomsByMo[mo][r.room_id].revenue   += net;
            historicalRoomsByMo[mo][r.room_id].childDays += (r.half_days || 0) + (r.full_days || 0);
        });
    } catch (e) { console.warn('bk historical billing_summary:', e); }

    // ⚠️ A locked month must be read from exactly one place, never blended.
    // Without this, "Lock the month" would freeze a snapshot into
    // billing_summary that a month with live registrations still sitting in
    // registration_dates would simply outvote every load — the checkbox
    // would do nothing, and the two numbers could quietly drift apart with
    // no way to tell which one a report actually used. Locked ⇒ the frozen
    // snapshot always wins, live data or not. Unlocked ⇒ the existing
    // live-else-historical rule, unchanged.
    const byMonth     = {};
    const liveByMonth = {}; // mo → { tuition, fees, rooms } — what live computes RIGHT NOW, kept so _bkLockMonth() can snapshot it without a second pass over every month
    months.forEach(mo => {
        const live = _bkMonthCache.get(mo); // always populated — either just computed above, or a hit from a prior _bkLoad()
        liveByMonth[mo] = live;

        const locked  = !!_bkClose[mo]?.lock;
        const useLive = !locked && (live.tuition + live.fees) > 0;
        byMonth[mo] = useLive
            ? { tuition: live.tuition, fees: live.fees, revenue: live.tuition + live.fees, rooms: live.rooms }
            : { tuition: historicalRevByMo[mo] || 0, fees: 0, revenue: historicalRevByMo[mo] || 0, rooms: historicalRoomsByMo[mo] || {} };
    });

    _bkData = { year, months, byMonth, liveByMonth, pnl, budget: budget || null, expenses: expenses || { items: [] } };

    // AR rows are the Ledger's own owed figures — never a second query.
    _bkAr = { rows: _bkArRowsFromLedger(), writeOffs: writeOffs || [] };
}

function _bkParseState(raw, fallback) {
    if (!raw) return fallback;
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return fallback; } }
    return (raw && typeof raw === 'object') ? raw : fallback;
}

/** AR list = exactly the Ledger's owing rows. The banner copy promises
 *  "same figures as the Ledger" and this is what makes that true rather
 *  than aspirational. Reuses _fhOwingRowsDeduped() (admin-finance-hub.js) —
 *  a second, differently-scoped filter here (this used to exclude
 *  `status === 'withdrawn'`, which was the Ledger's *old* scoping) would
 *  silently stop being "the same figures" the moment either file changed. */
function _bkArRowsFromLedger() {
    const rows = (typeof _fhOwingRowsDeduped === 'function') ? _fhOwingRowsDeduped() : [];
    const now = Date.now();
    return rows
        .map(r => {
            const sentAt = r.ar?.sentAt || null;
            const days   = sentAt ? Math.floor((now - new Date(sentAt).getTime()) / 86400000) : null;
            return {
                familyId: r.familyId, name: r.name, owed: r.owed,
                invoiceId: r.ar?.invoiceId || null, sentAt, days,
                why: _bkArWhy(r, days),
            };
        })
        .sort((a, b) => (b.days ?? -1) - (a.days ?? -1));
}

/** Write-offs, summed per family, limited to the months the Ledger's `owed`
 *  figure actually spans. */
function _bkForgivenByFamily() {
    const months = (typeof _fhOwed !== 'undefined' && Array.isArray(_fhOwed?.months) && _fhOwed.months.length)
        ? new Set(_fhOwed.months) : null;
    const map = new Map();
    (_bkAr.writeOffs || []).forEach(w => {
        const mo = (w.created_at || '').slice(0, 7);
        if (months && mo && !months.has(mo)) return;
        const key = String(w.family_id);
        map.set(key, (map.get(key) || 0) + (parseFloat(w.amount) || 0));
    });
    return map;
}

/** Write-offs recorded during the month being closed — those are the ones
 *  this close has to account for. `billing_write_offs` has no reviewed flag
 *  (and deliberately no DELETE grant), so "pending" means "recorded in this
 *  month," not "not yet ticked." */
function _bkWriteOffsThisMonth() {
    return (_bkAr.writeOffs || []).filter(w => (w.created_at || '').startsWith(_bkMonth));
}

function _bkArWhy(row, days) {
    if (!row.ar || !row.ar.sentAt) return 'Invoice not sent yet';
    if (row.ar.collected > 0)      return 'Partial payment received';
    if (days != null && days >= 30) return 'No payment, 30+ days since send';
    return 'Invoice sent, awaiting payment';
}

// ── Labor helpers ────────────────────────────────────────────
/** Total labor for one month across every room, plus whatever labor could
 *  not be attributed to a room (float staff, hours with no schedule). Both
 *  halves matter: dropping the unallocated half would understate payroll on
 *  the Overview while the Room P&L cards still looked right. */
function _bkLaborForMonth(mo) {
    const pnl = _bkData?.pnl || {};
    const roomRows = pnl.data?.[mo] || {};
    let roomLabor = 0;
    Object.values(roomRows).forEach(v => { roomLabor += v.labor || 0; });
    const center = pnl.centerLaborByMonth?.[mo] || 0;
    // centerLaborByMonth is the fallback total when no room schedules exist;
    // when room rows carry labor it is the unallocated remainder.
    return roomLabor > 0 ? roomLabor + center : center;
}

function _bkRoomLabor(mo, roomId) {
    return _bkData?.pnl?.data?.[mo]?.[roomId]?.labor || 0;
}

function _bkRooms() {
    const rooms = _bkData?.pnl?.rooms;
    if (rooms && rooms.length) return rooms;
    return (typeof getSortedRooms === 'function' ? getSortedRooms() : (typeof ROOMS !== 'undefined' ? ROOMS : []));
}

// ── Shell ────────────────────────────────────────────────────
function _bkRender() {
    const root = _bkEl('bkRoot');
    if (!root) return;
    const nav = BK_VIEWS.map(([key, label]) =>
        `<button type="button" class="bk-pill${_bkView === key ? ' is-on' : ''}" data-bk-view="${key}">${escHtml(label)}</button>`).join('');

    let body = '';
    switch (_bkView) {
        case 'overview': body = _bkOverviewHtml(); break;
        case 'ar':       body = _bkArHtml();       break;
        case 'pnl':      body = _bkPnlHtml();      break;
        case 'close':    body = _bkCloseHtml();    break;
        case 'recon':    body = _bkReconHtml();    break;
        case 'gl':       body = _bkGlHtml();       break;
    }

    root.innerHTML = `
        <h3 class="bk-title">Bookkeeper</h3>
        <p class="section-desc bk-subtitle">Month-end close, reconciliation, and the exports the books need &mdash; this ledger's numbers, nothing recomputed.</p>
        <div class="bk-nav">${nav}</div><div class="bk-body">${body}</div>`;
    _bkBind(root);
}

function _bkBind(root) {
    root.querySelectorAll('[data-bk-view]').forEach(btn => {
        btn.addEventListener('click', () => { _bkView = btn.dataset.bkView; _bkRender(); });
    });
    const handlers = {
        overview: _bkBindOverview, ar: _bkBindAr, pnl: _bkBindPnl,
        close: _bkBindClose, recon: _bkBindRecon, gl: _bkBindGl,
    };
    handlers[_bkView]?.(root);
}

// ── 1. Overview ──────────────────────────────────────────────
function _bkOverviewHtml() {
    const mo    = _bkMonth;
    const m     = _bkData.byMonth[mo] || { revenue: 0, tuition: 0, fees: 0 };
    const labor = _bkLaborForMonth(mo);
    const net   = m.revenue - labor;
    const b     = _bkData.budget;

    const laborPct  = m.revenue > 0 ? (labor / m.revenue * 100) : 0;
    const targetPct = b?.income > 0 ? (b.wages / b.income * 100) : 0;
    const marginPct = m.revenue > 0 ? (net / m.revenue * 100) : 0;

    const budgetNet = b
        ? (b.income || 0) - (b.wages || 0) - (b.taxes || 0) - (b.workersComp || 0) - (b.payrollExp || 0) - (b.otherExp || 0)
        : null;

    const rows = _bkData.months.map(k => ({
        key: k, label: MONTH_NAMES[Number(k.split('-')[1]) - 1].slice(0, 3),
        rev: _bkData.byMonth[k]?.revenue || 0, lab: _bkLaborForMonth(k),
        locked: !!_bkClose[k]?.lock,
    }));
    // Each bar sizes against its own series' peak (revenue vs. labor), not a
    // shared one — otherwise labor (always the smaller number) would read as
    // flat across every month regardless of how it actually moved.
    const peakRev = Math.max(1, ...rows.map(r => r.rev));
    const peakLab = Math.max(1, ...rows.map(r => r.lab));

    const bars = rows.map(r => `
        <div class="bk-bar-row">
            <div class="bk-bar-label">${escHtml(r.label)}${r.locked ? ' <span class="bk-lock-dot" title="Locked — reading the frozen historical total, not live registrations">&#128274;</span>' : ''}</div>
            <div class="bk-bar-pair">
                <div class="bk-bar-track"><div class="bk-bar bk-bar-rev" style="width:${(r.rev / peakRev * 100).toFixed(1)}%"></div></div>
                <div class="bk-bar-val bk-bar-rev-val">${_bkMoney(r.rev)}</div>
            </div>
            <div class="bk-bar-pair">
                <div class="bk-bar-track"><div class="bk-bar bk-bar-lab" style="width:${(r.lab / peakLab * 100).toFixed(1)}%"></div></div>
                <div class="bk-bar-val bk-bar-lab-val">${_bkMoney(r.lab)}</div>
            </div>
        </div>`).join('');

    // "Projected full year" extrapolates the elapsed months' actual margin
    // (revenue minus labor — no monthly opex actuals exist to add in) plus
    // the full budgeted net rate for whatever months are left. It is an
    // estimate, not a recomputation of the budget figure above it.
    let projectedFullYear = null;
    if (budgetNet != null) {
        const elapsed = rows.length;
        const remaining = Math.max(0, 12 - elapsed);
        const ytdActualMargin = rows.reduce((s, r) => s + (r.rev - r.lab), 0);
        projectedFullYear = ytdActualMargin + remaining * (budgetNet / 12);
    }

    return `
        <div class="bk-stats">
            <div class="bk-stat"><div class="bk-stat-label">Revenue, MTD</div><div class="bk-stat-num">${_bkMoney(m.revenue)}</div><div class="bk-stat-sub">${_bkMonthLabel(mo)}</div></div>
            <div class="bk-stat"><div class="bk-stat-label">Labor, MTD</div><div class="bk-stat-num">${_bkMoney(labor)}</div><div class="bk-stat-sub">${_bkPct(laborPct)} of revenue${targetPct ? ` · budget ≤${_bkPct(targetPct)}` : ''}</div></div>
            <div class="bk-stat"><div class="bk-stat-label">Net margin, MTD</div><div class="bk-stat-num ${net < 0 ? 'is-neg' : 'is-pos'}">${_bkMoney(net)}</div><div class="bk-stat-sub">${_bkPct(marginPct)} of revenue</div></div>
            <div class="bk-stat bk-stat-sun"><div class="bk-stat-label">Annual budget net</div><div class="bk-stat-num">${budgetNet == null ? '—' : _bkMoney(budgetNet)}</div><div class="bk-stat-sub">${projectedFullYear == null ? 'No budget set for ' + _bkData.year : 'projected full year ' + _bkMoney(projectedFullYear)}</div></div>
        </div>

        <div class="bk-card">
            <h4 class="bk-h">Revenue vs. labor by month</h4>
            <div class="bk-legend"><span class="bk-key bk-key-rev"></span> Revenue <span class="bk-key bk-key-lab"></span> Labor</div>
            <div class="bk-bars">${bars || '<p class="empty-hint">No months to chart yet.</p>'}</div>
        </div>
        <p class="ap-note bk-scope-note">Scenario planning and enrollment modeling have moved out of Finance — they'll live in a separate Planning area. This screen stays close-focused: what happened, what reconciles, what exports.</p>

        <div class="bk-card bk-budget-card">
            <div class="bk-card-head">
                <h4 class="bk-h">Annual budget, ${_bkData.year}</h4>
                <button type="button" class="bk-link" id="bkEditBudget">Edit budget</button>
            </div>
            <div class="bk-budget-grid">
                <div><span class="bk-kv-label">Revenue target</span><span class="bk-kv-val">${b?.income ? _bkMoney(b.income) : '—'}</span></div>
                <div><span class="bk-kv-label">Wages budget</span><span class="bk-kv-val">${b?.wages ? _bkMoney(b.wages) : '—'}</span></div>
                <div><span class="bk-kv-label">Payroll taxes</span><span class="bk-kv-val">${b?.taxes ? _bkMoney(b.taxes) : '—'}</span></div>
                <div><span class="bk-kv-label">Other expenses</span><span class="bk-kv-val">${b?.otherExp ? _bkMoney(b.otherExp) : '—'}</span></div>
            </div>
            <div class="bk-form bk-form-sun" id="bkBudgetForm" style="display:none">
                <label class="bk-field"><span>Revenue target ($/yr)</span><input type="number" step="0.01" id="bkBudgetIncome" value="${b?.income || ''}"></label>
                <label class="bk-field"><span>Wages budget ($/yr)</span><input type="number" step="0.01" id="bkBudgetWages" value="${b?.wages || ''}"></label>
                <label class="bk-field"><span>Payroll taxes ($/yr)</span><input type="number" step="0.01" id="bkBudgetTaxes" value="${b?.taxes || ''}"></label>
                <label class="bk-field"><span>Other expenses ($/yr)</span><input type="number" step="0.01" id="bkBudgetOther" value="${b?.otherExp || ''}"></label>
                <div class="bk-form-btns">
                    <button type="button" class="bk-btn-solid" id="bkBudgetSave">Save budget</button>
                    <button type="button" class="bk-btn-text" id="bkBudgetCancel">Cancel</button>
                </div>
            </div>

            <!-- Budget lines — absorbs the retired standalone "Expense Lines"
                 tool (2026-08-28). Same data (expense_config setting, same
                 fetchExpenseConfig()/saveExpenseConfig()), same four line
                 types the old tool supported — GL Export's Rent/Supplies
                 match against these by label, so nothing downstream changed,
                 only where you add/remove a line. -->
            <div class="bk-exp-head">
                <span class="bk-kv-label">Budget lines</span>
                <button type="button" class="bk-link" id="bkAddExpLine">+ Add line</button>
            </div>
            <div class="bk-exp-list">${_bkExpenseLinesHtml()}</div>
            <div class="bk-form bk-form-sun" id="bkExpForm" style="display:none">
                <label class="bk-field"><span>Label</span><input type="text" id="bkExpLabel" placeholder="e.g. Rent, Workers Comp, Supplies"></label>
                <label class="bk-field"><span>Type</span>
                    <select id="bkExpType">
                        <option value="monthly">Monthly (recurring)</option>
                        <option value="annual">Annual (one-time)</option>
                        <option value="payroll_pct">Payroll tax — % of wages</option>
                        <option value="revenue_pct">Payment processing — % of revenue</option>
                    </select>
                </label>
                <label class="bk-field" id="bkExpAmountWrap"><span>Amount ($)</span><input type="number" step="0.01" id="bkExpAmount" placeholder="0.00"></label>
                <label class="bk-field" id="bkExpMonthWrap" style="display:none"><span>Month it occurs</span>
                    <select id="bkExpMonth">${MONTH_NAMES.map((n, i) => `<option value="${i + 1}">${n}</option>`).join('')}</select>
                </label>
                <div class="bk-form-btns">
                    <button type="button" class="bk-btn-solid" id="bkExpSave">Add</button>
                    <button type="button" class="bk-btn-text" id="bkExpCancel">Cancel</button>
                </div>
            </div>
        </div>

        <div class="bk-card">
            <h4 class="bk-h">Year-over-year</h4>
            <p class="bk-lede">This year against last, month by month — the same revenue and labor figures as the chart above.</p>
            <div id="financeYoyContent"><p class="empty-hint">Loading…</p></div>
        </div>`;
}

/** Exact four types the retired Expense Lines tool supported — label text
 *  mirrors that tool's own copy so a director who used it before recognizes
 *  the same categories in the same words. */
function _bkExpenseLineLabel(item) {
    const amt = parseFloat(item.amount) || 0;
    switch (item.type) {
        case 'annual':      return `${_bkMoney(amt)} in ${MONTH_NAMES[(Number(item.month) || 1) - 1]}`;
        case 'payroll_pct': return `${amt}% of payroll`;
        case 'revenue_pct': return `${amt}% of revenue`;
        default:            return `${_bkMoney(amt)} / month`;
    }
}

function _bkExpenseLinesHtml() {
    const items = _bkData.expenses?.items || [];
    if (!items.length) return '<p class="empty-hint">No budget lines yet.</p>';
    return items.map(it => `
        <div class="bk-exp-row">
            <span class="bk-exp-name">${escHtml(it.label || '(untitled)')}</span>
            <span class="bk-exp-val">${_bkExpenseLineLabel(it)}</span>
            <button type="button" class="bk-exp-del" data-bk-exp-del="${escHtml(it.id)}" title="Remove this line" aria-label="Remove ${escHtml(it.label || 'line')}">&times;</button>
        </div>`).join('');
}

function _bkBindOverview(root) {
    root.querySelector('#bkEditBudget')?.addEventListener('click', () => {
        const f = root.querySelector('#bkBudgetForm');
        if (f) f.style.display = f.style.display === 'none' ? '' : 'none';
    });
    root.querySelector('#bkBudgetCancel')?.addEventListener('click', () => {
        const f = root.querySelector('#bkBudgetForm');
        if (f) f.style.display = 'none';
    });
    root.querySelector('#bkBudgetSave')?.addEventListener('click', async () => {
        if (_bkBusy) return;
        const num = id => parseFloat(root.querySelector('#' + id)?.value) || 0;
        // Merge, never replace: the budget record also carries the actual*
        // fields the ChMS finance API reads, and this form does not show them.
        const next = Object.assign({}, _bkData.budget || {}, {
            income:   num('bkBudgetIncome'),
            wages:    num('bkBudgetWages'),
            taxes:    num('bkBudgetTaxes'),
            otherExp: num('bkBudgetOther'),
        });
        _bkBusy = true;
        try {
            await saveAnnualBudget(_bkData.year, next);
            _bkData.budget = next;
            showToast(`Budget saved for ${_bkData.year}.`);
            _bkRender();
        } catch (e) {
            showToast('Could not save the budget: ' + (e.message || e), 'error');
        } finally { _bkBusy = false; }
    });

    // ── Budget lines (Expense Lines, absorbed) ──
    root.querySelector('#bkExpType')?.addEventListener('change', e => {
        const isAnnual = e.target.value === 'annual';
        const isPct    = e.target.value === 'payroll_pct' || e.target.value === 'revenue_pct';
        const amountLabel = root.querySelector('#bkExpAmountWrap span');
        if (amountLabel) amountLabel.textContent = isPct ? 'Percent (%)' : 'Amount ($)';
        const monthWrap = root.querySelector('#bkExpMonthWrap');
        if (monthWrap) monthWrap.style.display = isAnnual ? '' : 'none';
    });
    root.querySelector('#bkAddExpLine')?.addEventListener('click', () => {
        const f = root.querySelector('#bkExpForm');
        if (f) f.style.display = f.style.display === 'none' ? '' : 'none';
    });
    root.querySelector('#bkExpCancel')?.addEventListener('click', () => {
        const f = root.querySelector('#bkExpForm');
        if (f) f.style.display = 'none';
    });
    root.querySelector('#bkExpSave')?.addEventListener('click', async () => {
        if (_bkBusy) return;
        const label  = (root.querySelector('#bkExpLabel')?.value || '').trim();
        const type   = root.querySelector('#bkExpType')?.value || 'monthly';
        const amount = parseFloat(root.querySelector('#bkExpAmount')?.value);
        const month  = parseInt(root.querySelector('#bkExpMonth')?.value, 10) || null;
        if (!label || !(amount >= 0)) { alert('A budget line needs a label and an amount.'); return; }
        _bkBusy = true;
        try {
            const items = (_bkData.expenses?.items || []).slice();
            items.push({
                id: (typeof crypto !== 'undefined' && crypto.randomUUID) ? crypto.randomUUID() : `exp-${Date.now()}`,
                label, type, amount, month: type === 'annual' ? month : null, notes: '',
            });
            const nextConfig = { items };
            await saveExpenseConfig(nextConfig);
            _bkData.expenses = nextConfig;
            showToast(`Added "${label}".`);
            _bkRender();
        } catch (e) {
            showToast('Could not add that line: ' + (e.message || e), 'error');
        } finally { _bkBusy = false; }
    });
    root.querySelectorAll('[data-bk-exp-del]').forEach(btn => {
        btn.addEventListener('click', async () => {
            if (_bkBusy) return;
            const id = btn.dataset.bkExpDel;
            const items = (_bkData.expenses?.items || []).filter(it => it.id !== id);
            _bkBusy = true;
            try {
                const nextConfig = { items };
                await saveExpenseConfig(nextConfig);
                _bkData.expenses = nextConfig;
                _bkRender();
            } catch (e) {
                showToast('Could not remove that line: ' + (e.message || e), 'error');
            } finally { _bkBusy = false; }
        });
    });

    // ── Year-over-year, absorbed from its own sidebar entry (2026-08-28) ──
    // Lazy + cached: generateYoyComparison() does two full _buildRoomPnlData()
    // scans (real current year vs. prior — it reads its year from a
    // long-retired dashboard's own selector, falls back to the true current
    // year when that's absent, same as before this move) on top of
    // everything _bkLoad() already computed. Re-running it on every Overview
    // re-render (e.g. after saving a budget line, which calls _bkRender())
    // would make the tab's own "very slow load" complaint worse, not better —
    // so it runs once per Bookkeeper session, not once per render.
    if (typeof generateYoyComparison === 'function' && !_bkYoyLoaded) {
        _bkYoyLoaded = true;
        generateYoyComparison();
    }
}

// ── 2. Accounts Receivable ───────────────────────────────────
function _bkArHtml() {
    // A write-off forgives a balance without touching the invoice, so AR has
    // to net it out here rather than the Ledger netting it out upstream.
    // ⚠️ Scoped to the same trailing months the Ledger's `owed` figure covers
    // — a write-off against a long-settled invoice must not quietly reduce
    // today's balance.
    const forgiven = _bkForgivenByFamily();
    const rows = _bkAr.rows
        .map(r => Object.assign({}, r, { owed: r.owed - (forgiven.get(String(r.familyId)) || 0) }))
        .filter(r => r.owed > 0.005);
    const total = rows.reduce((s, r) => s + r.owed, 0);

    const mo      = _bkMonth;
    const billed  = _bkData.byMonth[mo]?.revenue || 0;
    const collectedPct = billed > 0 ? Math.max(0, Math.min(100, (1 - total / billed) * 100)) : 0;

    const band = d => (d == null ? 'b0' : d >= 30 ? 'b30' : d >= 15 ? 'b15' : 'b0');
    const bands = { b0: [], b15: [], b30: [] };
    rows.forEach(r => bands[band(r.days)].push(r));
    const sum = a => a.reduce((s, r) => s + r.owed, 0);

    const body = rows.length ? rows.map(r => `
        <tr>
            <td><strong>${escHtml(r.name)}</strong></td>
            <td>${r.days == null ? '—' : r.days}</td>
            <td class="bk-why">${escHtml(r.why)}</td>
            <td class="fh-money-col fh-bal-owed">${_bkMoney(r.owed)}</td>
            <td class="fh-money-col"><button type="button" class="bk-btn-mini" data-bk-writeoff="${r.familyId}" data-bk-amt="${r.owed}" data-bk-inv="${r.invoiceId || ''}" data-bk-name="${escHtml(r.name)}">Write off</button></td>
        </tr>`).join('') : `<tr><td colspan="5"><p class="empty-hint">Nothing outstanding.</p></td></tr>`;

    return `
        <div class="fh-owed-banner">
            <div class="fh-owed-main">
                <strong>${_bkMoney(total)} outstanding</strong> · <span class="fh-owed-famcount">${rows.length} famil${rows.length === 1 ? 'y' : 'ies'}</span>
                <div class="fh-owed-sub">${_bkPct(collectedPct)} collected this month · aged from invoice send date, same figures as the Ledger</div>
            </div>
        </div>
        <div class="fh-aging">
            <div class="fh-aging-col"><div class="fh-aging-label">0–14 days</div><div class="fh-aging-amt">${_bkMoney(sum(bands.b0))}</div><div class="fh-aging-count">${bands.b0.length} famil${bands.b0.length === 1 ? 'y' : 'ies'}</div></div>
            <div class="fh-aging-col fh-aging-watch"><div class="fh-aging-label">15–29 days</div><div class="fh-aging-amt">${_bkMoney(sum(bands.b15))}</div><div class="fh-aging-count">${bands.b15.length} famil${bands.b15.length === 1 ? 'y' : 'ies'}</div></div>
            <div class="fh-aging-col fh-aging-severe"><div class="fh-aging-label">30+ days</div><div class="fh-aging-amt">${_bkMoney(sum(bands.b30))}</div><div class="fh-aging-count">${bands.b30.length} famil${bands.b30.length === 1 ? 'y' : 'ies'}</div></div>
        </div>
        <div class="table-wrapper">
            <table class="report-table fh-table">
                <thead><tr><th>Family</th><th>Days late</th><th>Why</th><th class="fh-money-col">Owed</th><th></th></tr></thead>
                <tbody>${body}</tbody>
            </table>
        </div>
        <p class="ap-note">A write-off forgives the balance for the close. The invoice itself is untouched — it stays the record of what was actually charged.</p>`;
}

function _bkBindAr(root) {
    root.querySelectorAll('[data-bk-writeoff]').forEach(btn => {
        btn.addEventListener('click', () => _bkWriteOff(btn));
    });
}

async function _bkWriteOff(btn) {
    if (_bkBusy) return;
    const familyId = btn.dataset.bkWriteoff;
    const amount   = parseFloat(btn.dataset.bkAmt) || 0;
    const name     = btn.dataset.bkName || 'this family';
    const invoiceId = btn.dataset.bkInv || null;
    if (!confirm(`Write off ${_bkMoney(amount)} owed by ${name}? This forgives the balance for the close.`)) return;
    const note = (prompt('Why? (goes on the record)') || '').trim();
    if (!note) { alert('A write-off needs a reason.'); return; }
    _bkBusy = true;
    btn.disabled = true;
    try {
        const { data: { session } } = await sbClient.auth.getSession();
        await insertWriteOff({
            family_id: familyId, invoice_id: invoiceId || null, amount, note,
            approved_by: session?.user?.email || 'admin',
        });
        _bkAr.writeOffs = await fetchWriteOffs().catch(() => _bkAr.writeOffs);
        showToast(`Written off for ${name}.`);
        _bkRender();
    } catch (e) {
        btn.disabled = false;
        showToast('Could not record that write-off: ' + (e.message || e), 'error');
    } finally { _bkBusy = false; }
}

// ── 3. Room P&L ──────────────────────────────────────────────
function _bkPnlHtml() {
    const months = _bkData.months;
    if (!_bkPnlMonth || !months.includes(_bkPnlMonth)) _bkPnlMonth = months[months.length - 1] || _bkMonth;
    const rooms  = _bkRooms();
    const ytd    = _bkPnlScope === 'ytd';
    const scope  = ytd ? months : [_bkPnlMonth];

    const cards = rooms.map(room => {
        let revenue = 0, labor = 0, childDays = 0;
        scope.forEach(mo => {
            const r = _bkData.byMonth[mo]?.rooms?.[room.id];
            revenue   += r?.revenue   || 0;
            childDays += r?.childDays || 0;
            labor     += _bkRoomLabor(mo, room.id);
        });
        const net = revenue - labor;
        const margin = revenue > 0 ? (net / revenue * 100) : 0;
        return `
            <div class="bk-room-card">
                <div class="bk-room-name">${escHtml(room.label || room.id)}</div>
                <div class="bk-room-grid">
                    <div><span class="bk-kv-label">Revenue</span><span class="bk-kv-val">${_bkMoney(revenue)}</span></div>
                    <div><span class="bk-kv-label">Labor</span><span class="bk-kv-val">${_bkMoney(labor)}</span></div>
                    <div><span class="bk-kv-label">Net</span><span class="bk-kv-val ${net < 0 ? 'is-neg' : 'is-pos'}">${_bkMoney(net)}</span></div>
                    <div><span class="bk-kv-label">Margin</span><span class="bk-kv-val ${margin < 0 ? 'is-neg' : 'is-pos'}">${revenue > 0 ? _bkPct(margin) : '—'}</span></div>
                    <div><span class="bk-kv-label">Child-days</span><span class="bk-kv-val">${childDays.toLocaleString()}</span></div>
                </div>
            </div>`;
    }).join('');

    const lockedThisMonth = !ytd && !!_bkClose[_bkPnlMonth]?.lock;

    return `
        <p class="bk-lede">One card per room &mdash; no wide table to scroll through.</p>
        <div class="bk-toolbar">
            <select id="bkPnlMonth" class="bk-select"${ytd ? ' disabled' : ''}>
                ${months.map(mo => `<option value="${mo}"${mo === _bkPnlMonth ? ' selected' : ''}>${escHtml(_bkMonthLabel(mo))}</option>`).join('')}
            </select>
            <div class="ap-seg" role="group" aria-label="Scope">
                <button type="button" class="ap-seg-btn${ytd ? '' : ' is-on'}" data-bk-scope="month">This month</button>
                <button type="button" class="ap-seg-btn${ytd ? ' is-on' : ''}" data-bk-scope="ytd">YTD</button>
            </div>
            ${lockedThisMonth ? '<span class="bk-lock-badge" title="Reading the frozen historical total for this month, not live registrations">&#128274; Locked</span>' : ''}
        </div>
        <div class="bk-room-grid-wrap">${cards || '<p class="empty-hint">No rooms configured.</p>'}</div>
        <p class="ap-note">Revenue and child-days are the same per-room figures the Ledger and Billing Report bill from. Labor is real — staff schedules and clock events per room — not a flat percentage of revenue. Labor that could not be tied to one room (float staff, hours with no schedule) is excluded here and shown in the Overview's total.</p>`;
}

function _bkBindPnl(root) {
    root.querySelector('#bkPnlMonth')?.addEventListener('change', e => {
        _bkPnlMonth = e.target.value;
        _bkRender();
    });
    root.querySelectorAll('[data-bk-scope]').forEach(btn => {
        btn.addEventListener('click', () => { _bkPnlScope = btn.dataset.bkScope; _bkRender(); });
    });
}

// ── 4. Month-End Close ───────────────────────────────────────
function _bkCloseHtml() {
    const mo    = _bkMonth;
    const state = _bkClose[mo] || {};
    const pending = _bkWriteOffsThisMonth();
    const locked  = !!state.lock;
    const ctx = {
        monthName: _bkMonthName(mo),
        writeOffDetail: pending.length
            ? `${pending.length} write-off${pending.length === 1 ? '' : 's'} totaling ${_bkMoney(pending.reduce((s, w) => s + (parseFloat(w.amount) || 0), 0))} to confirm`
            : 'No write-offs pending for this close',
        lockDetail: locked
            ? `Locked ${escHtml(state.lockedBy || 'by an admin')}${state.lockedAt ? ' on ' + escHtml(friendlyShort(state.lockedAt)) : ''} — Overview, Room P&L and GL Export now read the frozen total for ${escHtml(_bkMonthName(mo))}, not live registrations`
            : `Freezes today's computed total into the permanent historical record for ${escHtml(_bkMonthName(mo))} — this is what next year compares against`,
    };
    const done = BK_CLOSE_ITEMS.filter(i => state[i.key]).length;

    const items = BK_CLOSE_ITEMS.map(item => `
        <button type="button" class="bk-check-row${state[item.key] ? ' is-done' : ''}" data-bk-check="${item.key}">
            <span class="bk-check-box">${state[item.key] ? '✓' : ''}</span>
            <span class="bk-check-text">
                <span class="bk-check-label">${escHtml(item.label)}</span>
                <span class="bk-check-detail">${item.detail(ctx)}</span>
            </span>
        </button>`).join('');

    return `
        <p class="bk-progress">${done} of ${BK_CLOSE_ITEMS.length} done · close ${escHtml(_bkMonthName(mo))} when every item is checked.</p>
        <div class="bk-card bk-check-card">${items}</div>
        <p class="ap-note">⚠️ "Lock the month" freezes ${escHtml(_bkMonthName(mo))}'s current total into <code>billing_summary</code> and switches Overview/Room P&L/GL Export to read that frozen number instead of recomputing live — this is what keeps next year's comparison stable even if an invoice for this month is edited later. It does <strong>not</strong> stop that Ledger edit from happening; re-lock afterward to fold the correction into the frozen number. Unchecking un-freezes the display (back to live, if any exists) without deleting the saved snapshot.</p>`;
}

function _bkBindClose(root) {
    root.querySelectorAll('[data-bk-check]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const key = btn.dataset.bkCheck;
            const mo  = _bkMonth;
            if (!_bkClose[mo]) _bkClose[mo] = {};

            if (key === 'lock') {
                if (_bkBusy) return;
                const turningOn = !_bkClose[mo].lock;
                _bkBusy = true;
                btn.disabled = true;
                try {
                    if (turningOn) {
                        const ok = await _bkLockMonth(mo);
                        if (!ok) return;
                        _bkClose[mo].lock = true;
                        _bkClose[mo].lockedAt = _bkToday();
                        try {
                            const { data: { session } } = await sbClient.auth.getSession();
                            _bkClose[mo].lockedBy = session?.user?.email ? `by ${session.user.email}` : 'by an admin';
                        } catch { _bkClose[mo].lockedBy = 'by an admin'; }
                    } else {
                        delete _bkClose[mo].lock;
                        delete _bkClose[mo].lockedAt;
                        delete _bkClose[mo].lockedBy;
                    }
                    await upsertSetting(BK_CLOSE_SETTING, _bkClose);
                    // Locking changes which source byMonth reads for this month —
                    // reload rather than patch in place, so Overview/Room P&L/GL
                    // Export pick up the frozen (or unfrozen) number in the same
                    // pass the checklist does, never a stale one behind a tab.
                    bookkeeperInvalidate();
                    await _bkLoad();
                    showToast(turningOn ? `${_bkMonthName(mo)} locked.` : `${_bkMonthName(mo)} unlocked.`);
                } catch (e) {
                    showToast('Could not change the lock: ' + (e.message || e), 'error');
                } finally {
                    _bkBusy = false;
                    _bkRender();
                }
                return;
            }

            if (_bkClose[mo][key]) delete _bkClose[mo][key];
            else _bkClose[mo][key] = true;
            _bkRender();
            try { await upsertSetting(BK_CLOSE_SETTING, _bkClose); }
            catch (e) { showToast('Could not save that checklist change: ' + (e.message || e), 'error'); }
        });
    });
}

/** Snapshot the currently-open month's live totals into billing_summary, per
 *  room, so it becomes the permanent historical record — the same table
 *  every historical-month fallback already reads. Returns false if the
 *  director cancels the confirm, true otherwise (including the no-op case
 *  where there is nothing live to freeze). */
async function _bkLockMonth(mo) {
    const live  = _bkData.liveByMonth?.[mo] || { tuition: 0, fees: 0, rooms: {} };
    const total = live.tuition + live.fees;
    const monthName = _bkMonthName(mo);

    if (total <= 0) {
        // Already historical-only (imported data, or a month before this app
        // tracked registrations) — the existing billing_summary row already
        // IS the frozen number. Nothing to snapshot; locking just records
        // that the month is considered closed.
        return confirm(`Lock ${monthName}? There's no live-computed total for this month to freeze — it already reads from a saved historical record. This just marks it closed.`);
    }

    const isOpenCalendarMonth = mo === _bkToday().slice(0, 7);
    const warn = isOpenCalendarMonth
        ? `\n\n⚠️ ${monthName} is still the current month and may still change — freezing it now will miss anything added after today unless you lock again.`
        : '';
    if (!confirm(`Lock ${monthName}? This freezes today's computed total — ${_bkMoney0(total)} — as the permanent historical record for this month, per room.\n\nThe Ledger stays fully editable. If an invoice for ${monthName} changes afterward, this frozen number will not — re-lock to bring it up to date.${warn}`)) {
        return false;
    }

    const rooms = _bkRooms();
    for (const room of rooms) {
        const r = live.rooms[room.id] || { revenue: 0, childDays: 0 };
        await upsertBillingSummary({
            month:       `${mo}-01`,
            room_id:     room.id,
            half_days:   null,
            full_days:   r.childDays,
            net_billed:  r.revenue,
            data_source: 'month_lock_snapshot',
        });
    }
    return true;
}

// ── 5. Reconciliation ────────────────────────────────────────
async function _bkLoadPayments() {
    if (_bkRecon.payments && _bkRecon.paymentsMonth === _bkMonth) return;
    const rows = await fetchPaymentsForMonth(_bkMonth).catch(e => { console.warn('bk payments:', e); return []; });
    const nameById = new Map((allFamiliesData || []).map(f => [String(f.id), f.parent_name || f.parent_email || 'Family']));
    _bkRecon.payments = rows.map(p => ({
        id: String(p.id),
        date: p.payment_date,
        name: nameById.get(String(p.family_id)) || 'Family',
        amount: parseFloat(p.amount) || 0,
        method: p.payment_method || 'Payment',
    }));
    // Manually-added items (a payment the processor feed missed) live in the
    // saved state, not in billing_payments — adding one here must never
    // fabricate a payment record the Ledger would then bill against.
    (_bkRecon.manual || []).forEach(m => _bkRecon.payments.push(Object.assign({ manual: true }, m)));
    _bkRecon.paymentsMonth = _bkMonth;
}

function _bkDepositMatched(depositId) {
    return (_bkRecon.payments || [])
        .filter(p => _bkRecon.assign[p.id] === depositId)
        .reduce((s, p) => s + p.amount, 0);
}

function _bkReconHtml() {
    if (!_bkRecon.payments || _bkRecon.paymentsMonth !== _bkMonth) {
        _bkLoadPayments().then(() => { if (_bkView === 'recon') _bkRender(); });
        return '<p class="empty-hint">Loading payments…</p>';
    }

    const deposits = (_bkRecon.deposits || []).filter(d => (d.date || '').startsWith(_bkMonth));
    const payments = _bkRecon.payments;

    const depositHtml = deposits.length ? deposits.map(d => {
        const matched   = _bkDepositMatched(d.id);
        const remaining = (d.amount || 0) - matched;
        const isMatched = matched >= (d.amount || 0) - 0.005;
        const open      = _bkMatching === d.id;
        const picked    = open ? payments.filter(p => _bkMatchPicks.has(p.id)).reduce((s, p) => s + p.amount, 0) : 0;
        const exact     = Math.abs(picked - (d.amount || 0)) < 0.005;

        const candidates = open ? payments.filter(p => !_bkRecon.assign[p.id] || _bkRecon.assign[p.id] === d.id) : [];

        return `
            <div class="bk-dep${open ? ' is-open' : ''}">
                <div class="bk-dep-head">
                    <div>
                        <div class="bk-dep-amt">${_bkMoney(d.amount)}</div>
                        <div class="bk-dep-meta">${escHtml(d.date || '')}${d.memo ? ' · ' + escHtml(d.memo) : ''}</div>
                    </div>
                    <div class="bk-dep-right">
                        <span class="fh-pill ${isMatched ? 'fh-pill-paid' : 'fh-pill-review'}">${isMatched ? 'Matched' : `${_bkMoney(remaining)} left to match`}</span>
                        <button type="button" class="bk-btn-solid" data-bk-match="${escHtml(d.id)}">${open ? 'Close' : (isMatched ? 'Review' : 'Match transactions')}</button>
                    </div>
                </div>
                ${open ? `
                <div class="bk-match">
                    ${candidates.length ? candidates.map(p => `
                        <label class="bk-match-row">
                            <input type="checkbox" data-bk-pick="${escHtml(p.id)}"${_bkMatchPicks.has(p.id) ? ' checked' : ''}>
                            <span class="bk-match-name">${escHtml(p.name)}</span>
                            <span class="bk-match-meta">${escHtml(p.date || '')} · ${escHtml(p.method)}</span>
                            <span class="bk-match-amt">${_bkMoney(p.amount)}</span>
                        </label>`).join('') : '<p class="empty-hint">No unassigned payments this month.</p>'}
                    <div class="bk-match-foot">
                        <span class="bk-match-total${exact ? ' is-exact' : ''}">Selected: ${_bkMoney(picked)} of ${_bkMoney(d.amount)}</span>
                        <button type="button" class="bk-btn-solid" id="bkConfirmMatch"${exact ? '' : ' disabled'}>Confirm match</button>
                        <button type="button" class="bk-btn-text" id="bkCancelMatch">Cancel</button>
                    </div>
                </div>` : ''}
            </div>`;
    }).join('') : '<p class="empty-hint">No deposits entered for this month.</p>';

    const depById = new Map(deposits.map(d => [d.id, d]));
    const paymentHtml = payments.length ? payments.map(p => {
        const dep = depById.get(_bkRecon.assign[p.id]);
        return `
            <div class="bk-pay-row">
                <span class="bk-pay-name">${escHtml(p.name)}${p.manual ? ' <span class="bk-tag">added by hand</span>' : ''}</span>
                <span class="bk-pay-meta">${escHtml(p.date || '')} · ${escHtml(p.method)}</span>
                <span class="bk-pay-dep">${dep ? `→ deposit ${escHtml(dep.date || '')}` : 'unassigned'}</span>
                <span class="bk-pay-amt">${_bkMoney(p.amount)}</span>
            </div>`;
    }).join('') : '<p class="empty-hint">No payments recorded this month.</p>';

    return `
        <p class="bk-lede">Match bank deposits to the parent payments that make them up. The processor pays out in batches — one deposit usually equals several parent payments summed. Procare is fully retired; nothing here reads from it.</p>

        <div class="bk-card">
            <div class="bk-card-head"><h4 class="bk-h">Bank deposits</h4><button type="button" class="bk-link" id="bkAddDeposit">+ Add deposit</button></div>
            <div class="bk-form bk-form-sun" id="bkDepositForm" style="display:none">
                <label class="bk-field"><span>Date</span><input type="date" id="bkDepDate" value="${escHtml(_bkToday())}"></label>
                <label class="bk-field"><span>Amount</span><input type="number" step="0.01" id="bkDepAmount" placeholder="Amount"></label>
                <label class="bk-field"><span>Memo</span><input type="text" id="bkDepMemo" placeholder="Memo"></label>
                <div class="bk-form-btns">
                    <button type="button" class="bk-btn-solid" id="bkDepSave">Add</button>
                    <button type="button" class="bk-btn-text" id="bkDepCancel">Cancel</button>
                </div>
            </div>
            ${depositHtml}
        </div>

        <div class="bk-card">
            <div class="bk-card-head"><h4 class="bk-h">Parent payments (from processor) &middot; ${payments.filter(p => !_bkRecon.assign[p.id]).length} unassigned</h4><button type="button" class="bk-link" id="bkAddItem">+ Add item</button></div>
            <div class="bk-form bk-form-green" id="bkItemForm" style="display:none">
                <label class="bk-field"><span>Date</span><input type="date" id="bkItemDate" value="${escHtml(_bkToday())}"></label>
                <label class="bk-field"><span>Family name</span><input type="text" id="bkItemName" placeholder="Family name" autocomplete="off"></label>
                <label class="bk-field"><span>Amount</span><input type="number" step="0.01" id="bkItemAmount" placeholder="Amount"></label>
                <div class="bk-form-btns">
                    <button type="button" class="bk-btn-solid" id="bkItemSave">Add</button>
                    <button type="button" class="bk-btn-text" id="bkItemCancel">Cancel</button>
                </div>
            </div>
            ${paymentHtml}
        </div>
        <p class="ap-note">Reconciliation never changes an invoice or a balance — it only links payments that already exist to a deposit. A payment with no invoice behind it is a Ledger problem, not something to resolve here.</p>`;
}

async function _bkSaveRecon() {
    const payload = {
        deposits: _bkRecon.deposits || [],
        assign:   _bkRecon.assign   || {},
        manual:   _bkRecon.manual   || [],
    };
    try { await upsertSetting(BK_RECON_SETTING, payload); }
    catch (e) { showToast('Could not save reconciliation: ' + (e.message || e), 'error'); }
}

function _bkBindRecon(root) {
    const toggle = (btnId, formId) => root.querySelector('#' + btnId)?.addEventListener('click', () => {
        const f = root.querySelector('#' + formId);
        if (f) f.style.display = f.style.display === 'none' ? '' : 'none';
    });
    toggle('bkAddDeposit', 'bkDepositForm');
    toggle('bkAddItem', 'bkItemForm');
    root.querySelector('#bkDepCancel')?.addEventListener('click', () => { const f = root.querySelector('#bkDepositForm'); if (f) f.style.display = 'none'; });
    root.querySelector('#bkItemCancel')?.addEventListener('click', () => { const f = root.querySelector('#bkItemForm'); if (f) f.style.display = 'none'; });

    root.querySelector('#bkDepSave')?.addEventListener('click', async () => {
        const date   = root.querySelector('#bkDepDate')?.value;
        const amount = parseFloat(root.querySelector('#bkDepAmount')?.value);
        const memo   = (root.querySelector('#bkDepMemo')?.value || '').trim();
        if (!date || !(amount > 0)) { alert('A deposit needs a date and an amount.'); return; }
        _bkRecon.deposits.push({ id: `dep-${Date.now()}`, date, amount, memo });
        await _bkSaveRecon();
        _bkRender();
    });

    root.querySelector('#bkItemSave')?.addEventListener('click', async () => {
        const date   = root.querySelector('#bkItemDate')?.value;
        const name   = (root.querySelector('#bkItemName')?.value || '').trim();
        const amount = parseFloat(root.querySelector('#bkItemAmount')?.value);
        if (!date || !name || !(amount > 0)) { alert('An item needs a date, a family name, and an amount.'); return; }
        if (!_bkRecon.manual) _bkRecon.manual = [];
        const row = { id: `man-${Date.now()}`, date, name, amount, method: 'Entered by hand' };
        _bkRecon.manual.push(row);
        _bkRecon.payments.push(Object.assign({ manual: true }, row));
        await _bkSaveRecon();
        _bkRender();
    });

    root.querySelectorAll('[data-bk-match]').forEach(btn => {
        btn.addEventListener('click', () => {
            const id = btn.dataset.bkMatch;
            // Only one deposit matches at a time — opening a second closes the
            // first, so a payment can never be provisionally checked against two.
            if (_bkMatching === id) { _bkMatching = null; _bkMatchPicks = new Set(); }
            else {
                _bkMatching = id;
                _bkMatchPicks = new Set((_bkRecon.payments || []).filter(p => _bkRecon.assign[p.id] === id).map(p => p.id));
            }
            _bkRender();
        });
    });

    root.querySelectorAll('[data-bk-pick]').forEach(cb => {
        cb.addEventListener('change', () => {
            const id = cb.dataset.bkPick;
            if (cb.checked) _bkMatchPicks.add(id); else _bkMatchPicks.delete(id);
            _bkRender();
        });
    });

    root.querySelector('#bkCancelMatch')?.addEventListener('click', () => {
        _bkMatching = null; _bkMatchPicks = new Set(); _bkRender();
    });

    root.querySelector('#bkConfirmMatch')?.addEventListener('click', async () => {
        const id = _bkMatching;
        if (!id) return;
        (_bkRecon.payments || []).forEach(p => {
            if (_bkMatchPicks.has(p.id)) _bkRecon.assign[p.id] = id;
            else if (_bkRecon.assign[p.id] === id) delete _bkRecon.assign[p.id];
        });
        _bkMatching = null; _bkMatchPicks = new Set();
        await _bkSaveRecon();
        showToast('Deposit matched.');
        _bkRender();
    });
}

// ── 6. GL Export ─────────────────────────────────────────────
/** Category totals for the open month. Tuition and fees split from the same
 *  per-family billing calculation the Ledger uses; payroll from the same
 *  labor data the Overview and Room P&L use; rent and supplies from the
 *  Expense Lines config, matched on the line's own label. This is a
 *  category-totals export, deliberately not a double-entry GL. */
function _bkGlRows() {
    const mo    = _bkMonth;
    const m     = _bkData.byMonth[mo] || { tuition: 0, fees: 0 };
    const labor = _bkLaborForMonth(mo);
    const moNum = Number(mo.split('-')[1]);

    const expenseFor = re => (_bkData.expenses.items || [])
        .filter(it => re.test(it.label || ''))
        .reduce((s, it) => {
            const amt = parseFloat(it.amount) || 0;
            if (it.type === 'annual') return s + (Number(it.month) === moNum ? amt : 0);
            return s + amt;
        }, 0);

    const tuition  = m.tuition || 0;
    const fees     = m.fees || 0;
    const rent     = expenseFor(/rent|lease|mortgage/i);
    const supplies = expenseFor(/suppl|material|classroom/i);
    // Income rows are positive, expense rows negative — Net is a plain sum
    // of the rows above it, never a separately-derived figure that could
    // drift from what the table actually shows.
    const lineItems = [
        { label: 'Tuition income', amount: tuition },
        { label: 'Fees income',    amount: fees },
        { label: 'Rent',           amount: -rent },
        { label: 'Payroll',        amount: -labor },
        { label: 'Supplies',       amount: -supplies },
    ];
    const net = lineItems.reduce((s, r) => s + r.amount, 0);
    return [...lineItems, { label: 'Net', amount: net, isNet: true }];
}

function _bkGlHtml() {
    const rows = _bkGlRows();
    const cellCls = r => r.isNet ? '' : (r.amount < 0 ? 'is-neg' : 'is-pos');
    const locked = !!_bkClose[_bkMonth]?.lock;
    return `
        <div class="bk-card-head bk-gl-head">
            <p class="bk-lede">Category totals for ${escHtml(_bkMonthName(_bkMonth))} — hand this to the bookkeeper as-is, or export.${locked ? ' <span class="bk-lock-badge" title="Reading the frozen historical total for this month, not live registrations">&#128274; Locked</span>' : ''}</p>
            <button type="button" class="bk-btn-solid" id="bkGlCsv">&#8595; Export CSV</button>
        </div>
        <div class="table-wrapper">
            <table class="report-table fh-table bk-gl-table">
                <thead><tr><th>Category</th><th class="fh-money-col">Amount</th></tr></thead>
                <tbody>
                    ${rows.map(r => `<tr class="${r.isNet ? 'bk-gl-net' : ''}"><td>${escHtml(r.label)}</td><td class="fh-money-col ${cellCls(r)}">${_bkMoney(r.amount)}</td></tr>`).join('')}
                </tbody>
            </table>
        </div>
        <p class="ap-note">Rent and Supplies come from Expense Lines, matched on the line's label. Payroll is the same labor figure the Overview and Room P&amp;L read. A category with no matching expense line reads $0.00 rather than guessing.</p>`;
}

function _bkBindGl(root) {
    root.querySelector('#bkGlCsv')?.addEventListener('click', () => {
        // Raw numbers in the file even though the table shows currency —
        // a spreadsheet cannot sum "$1,234.00".
        const lines = _bkGlRows().map(r => `${csvCell(r.label)},${r.amount.toFixed(2)}`);
        downloadFile(`gl-categories-${_bkMonth}.csv`, 'text/csv', ['Category,Amount', ...lines].join('\n'));
    });
}
