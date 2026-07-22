// ============================================================
// FINANCE DASHBOARD
// Charts and financial analytics for Full Access users.
// Reuses _buildRoomPnlData() from admin-reports.js.
// ============================================================

let _financeCharts = {}; // Chart instances — destroy before re-rendering
let _annualBudget = null;     // cached budget object for the currently-selected year
let _annualBudgetYear = null; // which year _annualBudget was loaded for

function setupFinanceDashboard() {
    document.getElementById('generateFinanceBtn')
        ?.addEventListener('click', generateFinanceDashboard);
    document.getElementById('generateYoyBtn')
        ?.addEventListener('click', generateYoyComparison);

    setupExpenseLines();
    setupModelingTool();
    setupFinanceApiTester();

    // Populate year selector: current year ± 2
    const sel = document.getElementById('financeYear');
    if (sel) {
        const cur = new Date().getFullYear();
        for (let y = cur + 1; y >= cur - 2; y--) {
            const opt = document.createElement('option');
            opt.value = y;
            opt.textContent = y;
            if (y === cur) opt.selected = true;
            sel.appendChild(opt);
        }
    }

    setupBudget();
}

// ── ChMS Finance API Tester ─────────────────────────────────────
// Calls the finance-summary edge function directly (through the same-origin
// /sb proxy, like the other fetch()-based edge function calls in
// js/supabase.js) so an admin can confirm the FINANCE_API_KEY secret and the
// deployed function actually agree, without needing curl/Postman.
function setupFinanceApiTester() {
    document.getElementById('financeApiTestBtn')?.addEventListener('click', testFinanceApiConnection);
}

async function testFinanceApiConnection() {
    const btn    = document.getElementById('financeApiTestBtn');
    const status = document.getElementById('financeApiTestStatus');
    const output = document.getElementById('financeApiTestOutput');
    const key    = document.getElementById('financeApiTestKey')?.value.trim();

    if (!key) {
        if (status) status.textContent = 'Paste the API key first.';
        return;
    }

    if (btn) btn.disabled = true;
    if (status) status.textContent = 'Testing…';
    if (output) { output.classList.add('hidden'); output.textContent = ''; }

    try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/finance-summary`, {
            headers: { 'X-Api-Key': key },
        });
        const text = await res.text();
        let pretty = text;
        try { pretty = JSON.stringify(JSON.parse(text), null, 2); } catch { /* not JSON */ }

        if (status) status.textContent = res.ok ? `✅ ${res.status} OK` : `❌ ${res.status} ${res.statusText}`;
        if (output) { output.textContent = pretty; output.classList.remove('hidden'); }
    } catch (err) {
        if (status) status.textContent = '❌ Request failed';
        if (output) { output.textContent = String(err?.message || err); output.classList.remove('hidden'); }
    } finally {
        if (btn) btn.disabled = false;
    }
}

function _destroyChart(key) {
    if (_financeCharts[key]) { _financeCharts[key].destroy(); delete _financeCharts[key]; }
}

function _financeYear() {
    return parseInt(document.getElementById('financeYear')?.value || new Date().getFullYear());
}
function _financeMonth() {
    return document.getElementById('financeMonth')?.value || '';
}

// ── Helpers ──────────────────────────────────────────────────
const FIN_MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function _moRev(pnl, mo) {
    return Object.values(pnl.data[mo] || {}).reduce((s, r) => s + (r.revenue || 0), 0);
}
function _moLab(pnl, mo) {
    const perRoom = Object.values(pnl.data[mo] || {}).reduce((s, r) => s + (r.labor || 0), 0);
    const center  = pnl.centerLaborByMonth?.[mo] || 0;
    return perRoom + center;
}
function _fmt$(v) { return '$' + Math.round(v).toLocaleString(); }

// ── Annual Budget ─────────────────────────────────────────────
function setupBudget() {
    document.getElementById('saveBudgetBtn')?.addEventListener('click', saveBudget);
    // Reload budget inputs when year changes
    document.getElementById('financeYear')?.addEventListener('change', () => {
        _annualBudget = null;
        _annualBudgetYear = null;
        loadBudgetInputs(_financeYear());
    });
    loadBudgetInputs(_financeYear());
}

async function loadBudgetInputs(year) {
    _annualBudgetYear = year;
    try {
        const budget = await fetchAnnualBudget(year);
        _annualBudget = budget;
        _populateBudgetForm(budget);
        _renderBudgetSummary(budget, year);
    } catch(e) { console.warn('Budget load:', e); }
}

function _populateBudgetForm(budget) {
    const set = (id, key) => {
        const el = document.getElementById(id);
        if (el) el.value = budget?.[key] != null ? budget[key] : '';
    };
    set('budgetIncome',      'income');
    set('budgetWages',       'wages');
    set('budgetTaxes',       'taxes');
    set('budgetWorkersComp', 'workersComp');
    set('budgetPayrollExp',  'payrollExp');
    set('budgetOtherExp',    'otherExp');
    set('actualTaxes',       'actualTaxes');
    set('actualWorkersComp', 'actualWorkersComp');
    set('actualPayrollExp',  'actualPayrollExp');
    set('actualOtherExp',    'actualOtherExp');
}

async function saveBudget() {
    const year   = _financeYear();
    const status = document.getElementById('budgetSaveStatus');
    const get    = id => parseFloat(document.getElementById(id)?.value) || 0;
    const budget = {
        income:           get('budgetIncome'),
        wages:            get('budgetWages'),
        taxes:            get('budgetTaxes'),
        workersComp:      get('budgetWorkersComp'),
        payrollExp:       get('budgetPayrollExp'),
        otherExp:         get('budgetOtherExp'),
        actualTaxes:      get('actualTaxes'),
        actualWorkersComp:get('actualWorkersComp'),
        actualPayrollExp: get('actualPayrollExp'),
        actualOtherExp:   get('actualOtherExp'),
    };
    if (status) status.textContent = 'Saving…';
    try {
        await saveAnnualBudget(year, budget);
        _annualBudget     = budget;
        _annualBudgetYear = year;
        _renderBudgetSummary(budget, year);
        if (status) { status.textContent = `Saved for ${year}.`; setTimeout(() => { status.textContent = ''; }, 3000); }
    } catch(e) {
        if (status) status.textContent = 'Save failed: ' + e.message;
    }
}

function _renderBudgetSummary(budget, year) {
    const wrap = document.getElementById('budgetSummaryWrap');
    const el   = document.getElementById('budgetSummary');
    if (!wrap || !el) return;
    if (!budget?.income) { wrap.classList.add('hidden'); return; }

    const bTotalExp = (budget.taxes||0) + (budget.workersComp||0) + (budget.payrollExp||0) + (budget.otherExp||0);
    const bNet      = budget.income - (budget.wages||0) - bTotalExp;
    const labPct    = budget.income > 0 ? (budget.wages / budget.income * 100) : 0;
    const netPct    = budget.income > 0 ? (bNet / budget.income * 100) : 0;
    const netCls    = netPct >= 15 ? 'fin-positive' : netPct >= 0 ? 'fin-warn' : 'fin-negative';

    const hasActuals = (budget.actualTaxes||0) + (budget.actualWorkersComp||0) +
                       (budget.actualPayrollExp||0) + (budget.actualOtherExp||0) > 0;
    const aTotalExp  = (budget.actualTaxes||0) + (budget.actualWorkersComp||0) +
                       (budget.actualPayrollExp||0) + (budget.actualOtherExp||0);

    const varCell = (actual, budgeted, lowerIsBetter) => {
        if (!actual && !budgeted) return '';
        const v    = actual - budgeted;
        const good = lowerIsBetter ? v <= 0 : v >= 0;
        return `<span class="${good ? 'fin-positive' : 'fin-negative'}" style="font-size:.8em;margin-left:.3rem">(${v >= 0 ? '+' : ''}${_fmt$(v)})</span>`;
    };

    wrap.classList.remove('hidden');
    el.innerHTML = `
        <div class="fin-kpi-row" style="margin-bottom:.5rem">
            <div class="fin-kpi">
                <span class="fin-kpi-label">Revenue Target</span>
                <span class="fin-kpi-value fin-positive">${_fmt$(budget.income)}</span>
            </div>
            <div class="fin-kpi">
                <span class="fin-kpi-label">Wages Budget</span>
                <span class="fin-kpi-value">${_fmt$(budget.wages||0)}</span>
            </div>
            <div class="fin-kpi">
                <span class="fin-kpi-label">Other Expenses Budget</span>
                <span class="fin-kpi-value">${_fmt$(bTotalExp)}</span>
                ${hasActuals ? `<span class="fin-kpi-target">actual: ${_fmt$(aTotalExp)}${varCell(aTotalExp, bTotalExp, true)}</span>` : ''}
            </div>
            <div class="fin-kpi">
                <span class="fin-kpi-label">Budget Net</span>
                <span class="fin-kpi-value ${netCls}">${_fmt$(bNet)} <span class="fin-kpi-target">${netPct.toFixed(1)}%</span></span>
            </div>
            <div class="fin-kpi">
                <span class="fin-kpi-label">Wages % Target</span>
                <span class="fin-kpi-value">${budget.income > 0 ? labPct.toFixed(1) + '%' : '—'} <span class="fin-kpi-target">of revenue</span></span>
            </div>
        </div>`;
}

// Returns the budget-derived labor % target, or null if no budget is set.
function _budgetLaborPct() {
    if (!_annualBudget?.income || !_annualBudget?.wages) return null;
    return _annualBudget.wages / _annualBudget.income * 100;
}

// Ensure budget is loaded for the given year (no-op if already cached).
async function _ensureBudget(year) {
    if (_annualBudgetYear === year && _annualBudget !== undefined) return;
    try {
        _annualBudget     = await fetchAnnualBudget(year);
        _annualBudgetYear = year;
    } catch(e) { _annualBudget = null; }
}

// ── Financial Dashboard ───────────────────────────────────────
async function generateFinanceDashboard() {
    const year  = _financeYear();
    const month = _financeMonth();
    const container = document.getElementById('financeDashContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';

    if (month && month !== 'ytd') {
        await _generateMonthDetail(year, month, container);
        return;
    }

    // For YTD: cap at the current month when viewing the current year
    const todayDateGlobal  = new Date();
    const todayYearGlobal  = todayDateGlobal.getFullYear();
    const todayMonthGlobal = todayDateGlobal.getMonth() + 1; // 1–12
    const ytdCutoff = (month === 'ytd' && year === todayYearGlobal) ? todayMonthGlobal : 12;
    const isCurrentYearYtd  = month === 'ytd' && year === todayYearGlobal;
    // Elapsed fraction of the current calendar month (1.0 once the month is over)
    const daysInCurrentMonth = new Date(todayYearGlobal, todayMonthGlobal, 0).getDate();
    const currentMonthFrac   = todayDateGlobal.getDate() / daysInCurrentMonth;
    const currentMoKey       = isCurrentYearYtd ? `${year}-${String(todayMonthGlobal).padStart(2,'0')}` : null;

    try {
        await _ensureBudget(year);

        // Ensure expense config is loaded before rendering KPIs
        if (!_expenseConfig) {
            _expenseConfig = await fetchExpenseConfig();
        }

        // Labor comes from _buildRoomPnlData (staff schedules/clock events).
        // Revenue comes from _buildFamilyBillingData per month — same calculation as the
        // month detail view and Family Billing report — to guarantee consistent numbers.
        //
        // Cap at TODAY, not the end of the current month: _buildRoomPnlData's labor
        // cost is driven by planned staff_schedules rows, which include shifts already
        // scheduled for the rest of the current month — using end-of-month here would
        // count those not-yet-worked days as "actual" labor (mirrors the fix already
        // applied in _buildRoomModelData for the same reason).
        const endDate = isCurrentYearYtd
            ? todayDateGlobal.toISOString().split('T')[0]
            : `${year}-12-31`;
        const [pnl] = await Promise.all([
            _buildRoomPnlData(`${year}-01-01`, endDate),
        ]);

        // Fresh data for revenue calculation
        try { allFamiliesData = await fetchAllFamilies({ includeArchived: true }); _discountMap = null; } catch(e) {}
        try { const f = await fetchAllRegistrations(); if (f?.length) allRegistrations = f; } catch(e) {}

        // Billing overrides for months in range (YTD or full year)
        const allMoList = Array.from({length: ytdCutoff}, (_, i) => `${year}-${String(i+1).padStart(2,'0')}`);
        const overridesByMo = new Map();
        await Promise.all(allMoList.map(async mo => {
            try {
                const rows = await fetchBillingOverrides(mo);
                overridesByMo.set(mo, new Map(rows.map(r => [
                    `${(r.parent_email||'').toLowerCase()}:${(r.child_name||'').toLowerCase()}`,
                    parseFloat(r.override_amount),
                ])));
            } catch(e) {}
        }));

        // Live revenue per month via Family Billing calculation
        const liveRevByMo = {};
        const liveDaysByRoomMo = {};    // mo → roomId → { half, full }
        const liveRevByRoomMo = {};     // mo → roomId → actual billed $ (includes discounts/overrides)
        allMoList.forEach(mo => {
            const families = _buildFamilyBillingData(mo, overridesByMo.get(mo) || new Map());
            liveDaysByRoomMo[mo] = {};
            liveRevByRoomMo[mo] = {};
            liveRevByMo[mo] = families.reduce((s, fam) => s + fam.children.reduce((cs, c) => {
                if (c.roomId) {
                    if (!liveDaysByRoomMo[mo][c.roomId]) liveDaysByRoomMo[mo][c.roomId] = { half: 0, full: 0 };
                    liveDaysByRoomMo[mo][c.roomId].half += c.halfDays || 0;
                    liveDaysByRoomMo[mo][c.roomId].full += c.fullDays || 0;
                    const childRev = (c.hasOverride ? c.overrideAmount : c.subtotal) + (c.changeFees || 0);
                    liveRevByRoomMo[mo][c.roomId] = (liveRevByRoomMo[mo][c.roomId] || 0) + childRev;
                }
                return cs + (c.hasOverride ? c.overrideAmount : c.subtotal) + (c.changeFees || 0);
            }, 0), 0);
        });

        // Historical billing_summary totals — used as fallback for months with no live registrations
        const historicalRevByMo = {};
        const historicalDaysByRoomMo = {}; // mo → roomId → { half, full }
        const historicalRevByRoomMo = {};  // mo → roomId → net_billed (includes discounts)
        try {
            const rows = await fetchBillingSummary();
            rows.forEach(r => {
                const mo = (r.month || '').substring(0, 7);
                if (!mo.startsWith(String(year))) return;
                historicalRevByMo[mo] = (historicalRevByMo[mo] || 0) + (parseFloat(r.net_billed) || 0);
                if (r.room_id) {
                    if (!historicalDaysByRoomMo[mo]) historicalDaysByRoomMo[mo] = {};
                    if (!historicalDaysByRoomMo[mo][r.room_id]) historicalDaysByRoomMo[mo][r.room_id] = { half: 0, full: 0 };
                    historicalDaysByRoomMo[mo][r.room_id].half += r.half_days || 0;
                    historicalDaysByRoomMo[mo][r.room_id].full += r.full_days || 0;
                    if (!historicalRevByRoomMo[mo]) historicalRevByRoomMo[mo] = {};
                    historicalRevByRoomMo[mo][r.room_id] = (historicalRevByRoomMo[mo][r.room_id] || 0) + (parseFloat(r.net_billed) || 0);
                }
            });
        } catch(e) {}

        // Combined day counts and revenue per room per month: prefer live data, fall back to billing_summary
        const daysByRoomMo = {};
        const revByRoomMo = {};
        allMoList.forEach(mo => {
            const useLive = liveRevByMo[mo] > 0;
            daysByRoomMo[mo] = useLive ? (liveDaysByRoomMo[mo] || {}) : (historicalDaysByRoomMo[mo] || {});
            revByRoomMo[mo]  = useLive ? (liveRevByRoomMo[mo]  || {}) : (historicalRevByRoomMo[mo]  || {});
        });

        // Combine: use live rev if > 0, else fall back to historical (e.g. Jan-Mar manual entries)
        const { months } = pnl;
        const allMonths = [...new Set([...months, ...Object.keys(historicalRevByMo)])].sort();

        if (!allMonths.length) {
            container.innerHTML = '<p class="empty-hint">No data found for this year.</p>';
            return;
        }

        let totalRev = 0, totalLab = 0, totalExpLines = 0;
        const moRevArr = [], moLabArr = [], moExpArr = [], moNetArr = [], moLabPctArr = [], moLabels = [];

        allMonths.forEach(mo => {
            let rev = liveRevByMo[mo] > 0 ? liveRevByMo[mo] : (historicalRevByMo[mo] || 0);
            // _buildFamilyBillingData bills the whole calendar month regardless of
            // which day it is "today" — prorate the current partial month so it
            // isn't counted as a fully-elapsed month of actual revenue.
            if (mo === currentMoKey) rev = Math.round(rev * currentMonthFrac);
            const lab  = _moLab(pnl, mo);
            const moNum = parseInt(mo.split('-')[1]);
            const exp  = _monthlyExpenseBurden(moNum, lab, rev);
            totalRev += rev;
            totalLab += lab;
            totalExpLines += exp;
            moRevArr.push(Math.round(rev));
            moLabArr.push(Math.round(lab));
            moExpArr.push(Math.round(exp));
            moLabPctArr.push(rev > 0 ? parseFloat((lab / rev * 100).toFixed(1)) : 0);
            moLabels.push(FIN_MONTH_SHORT[moNum - 1]);
        });

        // Prefer manually entered expense actuals from the budget record; fall back to Expense Lines
        const b = _annualBudget;
        const enteredActualExp = b
            ? (b.actualTaxes||0) + (b.actualWorkersComp||0) + (b.actualPayrollExp||0) + (b.actualOtherExp||0)
            : 0;
        const hasEnteredActuals = enteredActualExp > 0;
        const totalExp    = hasEnteredActuals ? enteredActualExp : totalExpLines;
        const periodLabel = month === 'ytd' ? 'YTD' : 'Annual';
        const expLabel    = hasEnteredActuals ? `${periodLabel} Other Expenses (actual)` : (totalExpLines > 0 ? `${periodLabel} Other Expenses (est.)` : '');

        // Rebuild moNetArr using the best expense figure per-month (Expense Lines; actuals are YTD totals not per-month)
        allMonths.forEach((mo, i) => {
            moNetArr.push(Math.round(moRevArr[i] - moLabArr[i] - moExpArr[i]));
        });

        const hasExpenses    = totalExp > 0;
        const totalMargin    = totalRev - totalLab - totalExp;
        const totalMarginPct = totalRev > 0 ? (totalMargin / totalRev * 100) : 0;
        const marginClass    = totalMarginPct >= 30 ? 'fin-positive' : totalMarginPct >= 15 ? 'fin-warn' : 'fin-negative';
        const labPct         = totalRev > 0 ? totalLab / totalRev * 100 : 0;
        const budgLabPct     = _budgetLaborPct();

        // Build Budget vs Actuals table if budget is set
        let bvaHtml = '';
        if (b?.income) {
            const bTotalExp  = (b.taxes||0) + (b.workersComp||0) + (b.payrollExp||0) + (b.otherExp||0);
            const bNet       = b.income - (b.wages||0) - bTotalExp;
            const moCount    = allMonths.length;
            // Fraction of the year elapsed based on the calendar, not months-with-data.
            // Past years: 100%. Current year: (whole months so far + fraction of the
            // current month elapsed) ÷ 12, so this lines up with how actual revenue
            // above is now prorated for the current partial month. Future: 0.
            const yearFrac = year < todayYearGlobal
                ? 1
                : (year === todayYearGlobal ? (todayMonthGlobal - 1 + currentMonthFrac) / 12 : 0);
            const expYTD     = v => Math.round(v * yearFrac); // expected-YTD = annual budget × fraction elapsed

            const varSpan = (actual, expected, lowerIsBetter) => {
                if (!expected) return '—';
                const v    = actual - expected;
                const good = lowerIsBetter ? v <= 0 : v >= 0;
                return `<span class="${good ? 'fin-positive' : 'fin-negative'}">${v >= 0 ? '+' : ''}${_fmt$(v)}</span>`;
            };
            const aRow = (label, annualBudget, actual, lowerIsBetter, note = '') => {
                if (!actual && !annualBudget) return '';
                const exp  = expYTD(annualBudget);
                const proj = actual > 0 && yearFrac > 0 ? Math.round(actual / yearFrac) : annualBudget;
                return `<tr>
                    <td>${label}${note ? ` <span style="font-size:.78em;color:#6b7280">${note}</span>` : ''}</td>
                    <td class="report-num">${annualBudget > 0 ? _fmt$(annualBudget) : '—'}</td>
                    <td class="report-num">${exp > 0 ? _fmt$(exp) : '—'}</td>
                    <td class="report-num">${actual > 0 ? _fmt$(actual) : '—'}</td>
                    <td class="report-num">${actual > 0 && exp > 0 ? varSpan(actual, exp, lowerIsBetter) : '—'}</td>
                    <td class="report-num" style="color:#6b7280">${proj > 0 ? _fmt$(proj) : '—'}</td>
                </tr>`;
            };

            const aTaxes      = b.actualTaxes       || 0;
            const aComp       = b.actualWorkersComp  || 0;
            const aPayrollExp = b.actualPayrollExp   || 0;
            const aOtherExp   = b.actualOtherExp     || 0;
            const aTotalExp   = aTaxes + aComp + aPayrollExp + aOtherExp;
            const aNet        = totalRev - totalLab - aTotalExp;
            const bNetExp     = expYTD(bNet); // prorated budget net

            // Full-year projection: annualize YTD actuals by the elapsed fraction of
            // the year — same approach the smaller expense-line rows use (aRow's
            // `proj`). Previously used a trend average hardcoded to specific months
            // (Jan–May / Jun–Jul, with month 8 as a special case), which broke down
            // for any month past August and — combined with the current month being
            // counted as fully elapsed above — could overstate the projection by
            // roughly one extra month of revenue.
            const projRev = totalRev > 0 && yearFrac > 0 ? Math.round(totalRev / yearFrac) : b.income;
            const projLab = totalLab > 0 && yearFrac > 0 ? Math.round(totalLab / yearFrac) : (b.wages || 0);
            const projExp = yearFrac > 0 && aTotalExp > 0 ? Math.round(aTotalExp / yearFrac) : bTotalExp;
            const projNet = projRev - projLab - (aTotalExp > 0 ? projExp : 0);

            bvaHtml = `
                <h4 style="margin:1.5rem 0 .5rem;font-weight:600">Budget vs Actuals — ${year}</h4>
                <div style="overflow-x:auto;margin-bottom:1.5rem">
                <table class="report-table" style="max-width:920px">
                    <thead><tr>
                        <th>Category</th>
                        <th class="report-num">Annual Budget</th>
                        <th class="report-num">Expected YTD</th>
                        <th class="report-num">YTD Actual</th>
                        <th class="report-num">Variance</th>
                        <th class="report-num" style="color:#6b7280">Proj. Full Year</th>
                    </tr></thead>
                    <tbody>
                        <tr>
                            <td>Revenue</td>
                            <td class="report-num">${_fmt$(b.income)}</td>
                            <td class="report-num" style="color:#6b7280">${_fmt$(expYTD(b.income))}</td>
                            <td class="report-num report-revenue">${_fmt$(totalRev)}</td>
                            <td class="report-num">${varSpan(totalRev, expYTD(b.income), false)}</td>
                            <td class="report-num" style="color:#6b7280" id="finBvaProjRev">${projRev > 0 ? _fmt$(projRev) : '—'}</td>
                        </tr>
                        <tr>
                            <td>Wages / Labor <span style="font-size:.78em;color:#6b7280">(from payroll data)</span></td>
                            <td class="report-num">${_fmt$(b.wages||0)}</td>
                            <td class="report-num" style="color:#6b7280">${_fmt$(expYTD(b.wages||0))}</td>
                            <td class="report-num">${_fmt$(totalLab)}</td>
                            <td class="report-num">${varSpan(totalLab, expYTD(b.wages||0), true)}</td>
                            <td class="report-num" style="color:#6b7280">${projLab > 0 ? _fmt$(projLab) : '—'}</td>
                        </tr>
                        ${aRow('Payroll Taxes', b.taxes||0, aTaxes, true, '(FICA, FUTA, SUTA)')}
                        ${aRow('Workers Comp', b.workersComp||0, aComp, true)}
                        ${aRow('Other Payroll Expenses', b.payrollExp||0, aPayrollExp, true, '(benefits, bonuses)')}
                        ${aRow('Other Expenses', b.otherExp||0, aOtherExp, true, '(supplies, insurance, etc.)')}
                        ${bTotalExp > 0 || aTotalExp > 0 ? `<tr style="background:#f8fafc">
                            <td><strong>Total Other Expenses</strong></td>
                            <td class="report-num"><strong>${bTotalExp > 0 ? _fmt$(bTotalExp) : '—'}</strong></td>
                            <td class="report-num" style="color:#6b7280"><strong>${bTotalExp > 0 ? _fmt$(expYTD(bTotalExp)) : '—'}</strong></td>
                            <td class="report-num"><strong>${aTotalExp > 0 ? _fmt$(aTotalExp) : '—'}</strong></td>
                            <td class="report-num">${aTotalExp > 0 && bTotalExp > 0 ? varSpan(aTotalExp, expYTD(bTotalExp), true) : '—'}</td>
                            <td class="report-num" style="color:#6b7280"><strong>${projExp > 0 ? _fmt$(projExp) : '—'}</strong></td>
                        </tr>` : ''}
                        <tr class="report-total-row">
                            <td><strong>Net</strong></td>
                            <td class="report-num"><strong>${_fmt$(bNet)}</strong></td>
                            <td class="report-num" style="color:#6b7280"><strong>${_fmt$(bNetExp)}</strong></td>
                            <td class="report-num"><strong>${_fmt$(aTotalExp > 0 ? aNet : totalMargin)}</strong></td>
                            <td class="report-num">${varSpan(aTotalExp > 0 ? aNet : totalMargin, bNetExp, false)}</td>
                            <td class="report-num" style="color:#6b7280" id="finBvaProjNet" data-lab="${projLab}" data-exp="${projExp}"><strong>${_fmt$(projNet)}</strong></td>
                        </tr>
                    </tbody>
                </table>
                <p style="font-size:.8em;color:#6b7280;margin:.25rem 0 0">
                    Expected YTD = annual budget × (${year < todayYearGlobal ? '12.0' : (todayMonthGlobal - 1 + currentMonthFrac).toFixed(1)} of 12 months elapsed).
                    ${!hasEnteredActuals && bTotalExp > 0 ? 'Enter actual expense amounts in the Annual Budget section above to track non-labor costs.' : ''}
                </p>
                </div>`;
        }

        container.innerHTML = `
            <div class="fin-kpi-row">
                <div class="fin-kpi">
                    <span class="fin-kpi-label">${periodLabel} Revenue</span>
                    <span class="fin-kpi-value fin-positive">${_fmt$(totalRev)}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">${periodLabel} Labor</span>
                    <span class="fin-kpi-value">${_fmt$(totalLab)}</span>
                </div>
                ${hasExpenses ? `
                <div class="fin-kpi">
                    <span class="fin-kpi-label">${expLabel || `${periodLabel} Other Expenses`}</span>
                    <span class="fin-kpi-value">${_fmt$(totalExp)}</span>
                </div>` : ''}
                <div class="fin-kpi">
                    <span class="fin-kpi-label">${periodLabel} Net${hasExpenses ? '' : ' (before expenses)'}</span>
                    <span class="fin-kpi-value ${marginClass}">${_fmt$(totalMargin)}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Net Margin %${hasExpenses ? '' : ' (before expenses)'}</span>
                    <span class="fin-kpi-value ${marginClass}">${totalMarginPct.toFixed(1)}%</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Labor % of Revenue</span>
                    <span class="fin-kpi-value ${budgLabPct !== null ? (labPct <= budgLabPct ? 'fin-positive' : 'fin-negative') : ''}">
                        ${totalRev > 0 ? labPct.toFixed(1) + '%' : '—'}
                        ${budgLabPct !== null
                            ? `<span class="fin-kpi-target">budget ≤ ${budgLabPct.toFixed(0)}%</span>`
                            : `<span class="fin-kpi-target" style="color:#9ca3af">set budget above</span>`}
                    </span>
                </div>
            </div>
            ${bvaHtml}
            <div class="fin-charts-row">
                <div class="fin-chart-wrap">
                    <h4 class="fin-chart-title">Revenue vs. Labor${hasExpenses ? ' vs. Net' : ''} by Month</h4>
                    <canvas id="chartRevLabor"></canvas>
                </div>
                <div class="fin-chart-wrap">
                    <h4 class="fin-chart-title">Labor as % of Revenue</h4>
                    <canvas id="chartLaborPct"></canvas>
                </div>
            </div>
            <div id="finAttendanceProj"></div>`;

        // Revenue vs Labor (+ Net if expenses exist) bar chart
        _destroyChart('revLabor');
        const revLaborDatasets = [
            { label: 'Revenue', data: moRevArr,
              backgroundColor: 'rgba(22,163,74,.75)', borderColor: 'rgb(22,163,74)', borderWidth: 1 },
            { label: 'Labor',   data: moLabArr,
              backgroundColor: 'rgba(245,158,11,.75)', borderColor: 'rgb(245,158,11)', borderWidth: 1 },
        ];
        if (hasExpenses) {
            revLaborDatasets.push(
                { label: 'Net (after all costs)', data: moNetArr,
                  type: 'line', borderColor: 'rgb(99,102,241)', backgroundColor: 'rgba(99,102,241,.12)',
                  tension: 0.3, fill: false, pointBackgroundColor: 'rgb(99,102,241)', yAxisID: 'y' }
            );
        }
        if (b?.income) {
            const budgRevMo = Math.round((b.income || 0) / 12);
            const budgLabMo = Math.round((b.wages  || 0) / 12);
            if (budgRevMo > 0) revLaborDatasets.push({
                label: 'Budget Rev/mo', data: moLabels.map(() => budgRevMo),
                type: 'line', borderColor: 'rgba(22,163,74,.5)', borderDash: [5, 4],
                pointRadius: 0, fill: false, yAxisID: 'y',
            });
            if (budgLabMo > 0) revLaborDatasets.push({
                label: 'Budget Wages/mo', data: moLabels.map(() => budgLabMo),
                type: 'line', borderColor: 'rgba(245,158,11,.5)', borderDash: [5, 4],
                pointRadius: 0, fill: false, yAxisID: 'y',
            });
        }
        _financeCharts.revLabor = new Chart(
            document.getElementById('chartRevLabor').getContext('2d'), {
                type: 'bar',
                data: { labels: moLabels, datasets: revLaborDatasets },
                options: {
                    responsive: true,
                    plugins: { legend: { position: 'top' } },
                    scales: { y: { beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() } } },
                },
            }
        );

        // Labor % line chart — budget target + industry standard reference lines
        _destroyChart('laborPct');
        const laborPctDatasets = [
            { label: 'Labor %', data: moLabPctArr,
              borderColor: 'rgb(245,158,11)', backgroundColor: 'rgba(245,158,11,.12)',
              tension: 0.3, fill: true, pointBackgroundColor: 'rgb(245,158,11)' },
        ];
        if (budgLabPct !== null) {
            laborPctDatasets.push({
                label: `${Math.round(budgLabPct)}% Budget Target`,
                data: moLabels.map(() => Math.round(budgLabPct * 10) / 10),
                borderColor: 'rgba(239,68,68,.7)', borderDash: [6,3],
                pointRadius: 0, fill: false,
            });
        }
        // Always show the 70% industry standard as a grey reference line
        laborPctDatasets.push({
            label: '70% Industry Standard',
            data: moLabels.map(() => 70),
            borderColor: 'rgba(156,163,175,.6)', borderDash: [3,3],
            pointRadius: 0, fill: false,
        });
        const chartMax = Math.max(105, budgLabPct !== null ? Math.ceil(budgLabPct / 10) * 10 + 15 : 0);
        _financeCharts.laborPct = new Chart(
            document.getElementById('chartLaborPct').getContext('2d'), {
                type: 'line',
                data: { labels: moLabels, datasets: laborPctDatasets },
                options: {
                    responsive: true,
                    plugins: { legend: { position: 'top' } },
                    scales: { y: { beginAtZero: true, max: chartMax, ticks: { callback: v => v + '%' } } },
                },
            }
        );

        // Attendance-based projection section
        _renderAttendanceProjection(
            document.getElementById('finAttendanceProj'),
            { year, allMoList, daysByRoomMo, revByRoomMo, liveRevByMo, historicalRevByMo, totalLab,
              annualExpenses: totalExp * (12 / (allMonths.length || 1)), currentMoKey, currentMonthFrac }
        );

    } catch (err) {
        container.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    }
}

// ── Attendance-Based Revenue Projection ──────────────────────
async function _renderAttendanceProjection(el, { year, allMoList, daysByRoomMo, revByRoomMo, liveRevByMo, historicalRevByMo, totalLab, annualExpenses, currentMoKey, currentMonthFrac }) {
    if (!el) return;
    try {
        await loadRateSettings();

        const today = new Date();
        const todayYear  = today.getFullYear();

        const activeRooms = getSortedRooms().filter(r => r.status === 'active' || r.status === 'coming_soon');

        // Per-room: accumulate half/full days and actual revenue across *complete* months
        // only — the current (partial) month is excluded here rather than prorated, since
        // it's used to compute a "typical complete month" average for projecting future
        // months; including a partial month (even scaled down) would still skew that average.
        const roomStats = {};
        activeRooms.forEach(r => { roomStats[r.id] = { halfTotal: 0, fullTotal: 0, revTotal: 0, moCount: 0 }; });

        allMoList.forEach(mo => {
            if (mo === currentMoKey) return;
            const dayData = daysByRoomMo[mo] || {};
            const revData = revByRoomMo[mo] || {};
            activeRooms.forEach(r => {
                const d = dayData[r.id];
                if (!d || (d.half === 0 && d.full === 0)) return;
                roomStats[r.id].halfTotal += d.half;
                roomStats[r.id].fullTotal += d.full;
                roomStats[r.id].revTotal  += revData[r.id] || 0;
                roomStats[r.id].moCount++;
            });
        });

        // Build per-room projection rows (only rooms with data)
        // projMonthly uses actual average revenue (includes discounts for staff kids etc.)
        // If actual revenue data isn't available per-room, fall back to days × rate.
        const roomProj = activeRooms.map(r => {
            const st = roomStats[r.id];
            if (st.moCount === 0) return null;
            const avgHalf = st.halfTotal / st.moCount;
            const avgFull = st.fullTotal / st.moCount;
            const halfRate = r.halfDayRate || 0;
            const fullRate = r.fullDayRate || 0;
            const avgTotalDays = avgHalf + avgFull;
            // Use actual billed revenue average when available; fall back to rate × days
            const projMonthly = st.revTotal > 0
                ? st.revTotal / st.moCount
                : avgHalf * halfRate + avgFull * fullRate;
            return { id: r.id, label: r.label, avgHalf, avgFull, avgTotalDays, halfRate, fullRate, projMonthly, moCount: st.moCount };
        }).filter(Boolean);

        if (!roomProj.length) { el.innerHTML = ''; return; }

        const totalProjMonthly = roomProj.reduce((s, r) => s + r.projMonthly, 0);
        const totalChildDaysPerMo = roomProj.reduce((s, r) => s + r.avgTotalDays, 0);
        const avgHalfRate = roomProj.filter(r => r.halfRate > 0).reduce((s, r) => s + r.halfRate, 0) / Math.max(1, roomProj.filter(r => r.halfRate > 0).length);
        const avgFullRate = roomProj.reduce((s, r) => s + r.fullRate, 0) / Math.max(1, roomProj.length);
        // Labor cost per child-day: used to estimate staffing impact of extra days
        const moCount = allMoList.length || 1;
        const laborCostPerChildDay = totalChildDaysPerMo > 0 ? (totalLab / moCount) / totalChildDaysPerMo : 0;

        // ── Determine operational months per room from all-years billing_summary ──
        // This prevents seasonal rooms (Summer Camp) from being projected year-round.
        const roomOpMonths = {}; // roomId → Set<1..12>
        activeRooms.forEach(r => { roomOpMonths[r.id] = new Set(); });
        // Seed with current-year live data months
        allMoList.forEach(mo => {
            const moNum = parseInt(mo.split('-')[1]);
            const dayData = daysByRoomMo[mo] || {};
            activeRooms.forEach(r => {
                const d = dayData[r.id];
                if (d && (d.half > 0 || d.full > 0)) roomOpMonths[r.id].add(moNum);
            });
        });
        // Supplement with prior years' billing_summary (provides room_id if the column exists)
        try {
            const allBs = await fetchBillingSummary();
            allBs.forEach(row => {
                if (!row.room_id || (!row.full_days && !row.half_days)) return;
                const moNum = parseInt((row.month || '').split('-')[1]);
                if (moNum >= 1 && moNum <= 12 && roomOpMonths[row.room_id]) {
                    roomOpMonths[row.room_id].add(moNum);
                }
            });
        } catch(e) {}

        // Fallback: assume every room here operates all 12 months. `activeRooms` above
        // already excludes `seasonal` rooms (Summer Camp), so anything reaching this
        // point runs year-round regardless of how many months of current-year data
        // happen to exist yet — gating on `size <= 6` used to make this silently stop
        // applying once more than half the year had elapsed (e.g. every month from
        // July on), leaving future months un-projected.
        activeRooms.forEach(r => {
            for (let m = 1; m <= 12; m++) roomOpMonths[r.id].add(m);
        });

        // ── Closure scaling: count weekday closures per future month ──
        // weekdays_in_month − closure_days_in_month gives the operating fraction.
        // Use the last month that has actual data — not the last month in allMoList,
        // which for "All months" view is always December, leaving no future months.
        let lastDataMoNum = 0;
        allMoList.forEach(mo => {
            const dayData = daysByRoomMo[mo] || {};
            const hasData = activeRooms.some(r => { const d = dayData[r.id]; return d && (d.half > 0 || d.full > 0); });
            if (hasData) { const n = parseInt(mo.split('-')[1]); if (n > lastDataMoNum) lastDataMoNum = n; }
        });
        const futureMonthNums = (year === todayYear && lastDataMoNum > 0 && lastDataMoNum < 12)
            ? Array.from({ length: 12 - lastDataMoNum }, (_, i) => lastDataMoNum + 1 + i)
            : [];

        // closure scale: moNum → fraction (0..1), default 1 (full month)
        const closureScale = {};
        futureMonthNums.forEach(m => { closureScale[m] = 1; });

        if (futureMonthNums.length > 0) {
            try {
                const closures = await fetchClosures();
                // Count weekday closures per future month
                const closuresByMo = {};
                closures.forEach(c => {
                    const d = new Date(c.close_date + 'T12:00:00');
                    if (isNaN(d)) return;
                    if (d.getFullYear() !== year) return;
                    const moNum  = d.getMonth() + 1;
                    const dow    = d.getDay();
                    if (dow === 0 || dow === 6) return; // skip weekends
                    if (!futureMonthNums.includes(moNum)) return;
                    closuresByMo[moNum] = (closuresByMo[moNum] || 0) + 1;
                });
                // Count total weekdays in each future month
                futureMonthNums.forEach(m => {
                    let weekdays = 0;
                    const daysInMo = new Date(year, m, 0).getDate();
                    for (let day = 1; day <= daysInMo; day++) {
                        const dow = new Date(year, m - 1, day).getDay();
                        if (dow !== 0 && dow !== 6) weekdays++;
                    }
                    const closed = closuresByMo[m] || 0;
                    closureScale[m] = weekdays > 0 ? Math.max(0, (weekdays - closed) / weekdays) : 1;
                });
            } catch(e) {}
        }

        // ── Project remaining months, per-room, with closure scaling ──
        let projRemainingTotal = 0;
        const projMonthRows = []; // { moNum, label, rev, scale, rooms }
        futureMonthNums.forEach(m => {
            const scale = closureScale[m] || 1;
            let moRev = 0;
            const activeInMo = [];
            roomProj.forEach(r => {
                if (roomOpMonths[r.id]?.has(m)) {
                    moRev += r.projMonthly * scale;
                    activeInMo.push(r.id);
                }
            });
            projRemainingTotal += moRev;
            projMonthRows.push({ moNum: m, label: FIN_MONTH_SHORT[m - 1], rev: moRev, scale, roomCount: activeInMo.length });
        });

        // YTD actual = sum of actual revenue (live preferred, historical fallback).
        // The current month is billed for the whole calendar month regardless of
        // today's date, so prorate it by how much of the month has elapsed —
        // otherwise this (and the Full-Year Projection below, which the Budget vs
        // Actuals table's Proj. Full Year cell defers to) counts the not-yet-elapsed
        // remainder of the current month as if it had already happened.
        const ytdActual = allMoList.reduce((s, mo) => {
            let rev = liveRevByMo[mo] > 0 ? liveRevByMo[mo] : (historicalRevByMo[mo] || 0);
            if (mo === currentMoKey) rev = Math.round(rev * currentMonthFrac);
            return s + rev;
        }, 0);

        const fullYearProj = ytdActual + projRemainingTotal;

        // Update Budget vs Actuals projected revenue with attendance-based number
        // (BVA uses a simple YTD×2 annualization; attendance-based is more accurate
        //  since regular rooms run year-round and fall enrollment may differ from spring)
        const bvaProjRevEl = document.getElementById('finBvaProjRev');
        const bvaProjNetEl = document.getElementById('finBvaProjNet');
        if (bvaProjRevEl && fullYearProj > 0) {
            bvaProjRevEl.innerHTML = `${_fmt$(fullYearProj)} <span style="font-size:.78em;color:#9ca3af" title="Attendance-based projection">(att.)</span>`;
            if (bvaProjNetEl) {
                const pLab = parseFloat(bvaProjNetEl.dataset.lab) || 0;
                const pExp = parseFloat(bvaProjNetEl.dataset.exp) || 0;
                const attNet = fullYearProj - pLab - pExp;
                bvaProjNetEl.innerHTML = `<strong>${_fmt$(attNet)}</strong>`;
            }
        }

        // ── Render HTML ───────────────────────────────────────
        const rowHtml = roomProj.map(r => {
            const opMos = futureMonthNums.filter(m => roomOpMonths[r.id]?.has(m));
            const opLabel = opMos.length === futureMonthNums.length
                ? 'all remaining'
                : (opMos.length === 0 ? 'none' : opMos.map(m => FIN_MONTH_SHORT[m-1]).join(', '));
            return `<tr>
                <td>${escHtml(r.label)}</td>
                <td class="report-num">${r.moCount}</td>
                <td class="report-num">${r.avgHalf > 0 ? r.avgHalf.toFixed(1) : '—'}</td>
                <td class="report-num">${r.avgFull > 0 ? r.avgFull.toFixed(1) : '—'}</td>
                <td class="report-num" style="color:#6b7280;font-size:.88em">
                    ${r.halfRate > 0 && r.avgHalf > 0 ? `$${r.halfRate}` : ''}${r.halfRate > 0 && r.avgHalf > 0 && r.fullRate > 0 ? ' / ' : ''}${r.fullRate > 0 ? `$${r.fullRate}` : ''}
                </td>
                <td class="report-num report-revenue"><strong>${_fmt$(r.projMonthly)}</strong></td>
                ${futureMonthNums.length > 0 ? `<td style="font-size:.8em;color:#6b7280">${escHtml(opLabel)}</td>` : ''}
            </tr>`;
        }).join('');

        // Monthly breakdown of remaining months
        const projMonthHtml = projMonthRows.length > 0 ? `
            <details style="margin-top:.5rem;margin-bottom:.75rem">
            <summary style="cursor:pointer;font-size:.85em;color:#6b7280">Monthly projection breakdown</summary>
            <table class="report-table" style="max-width:460px;margin-top:.4rem">
                <thead><tr>
                    <th>Month</th>
                    <th class="report-num">Closure Adj.</th>
                    <th class="report-num">Projected Rev</th>
                </tr></thead>
                <tbody>${projMonthRows.map(m => `<tr>
                    <td>${m.label} ${year}</td>
                    <td class="report-num" style="color:${m.scale < 1 ? '#d97706' : '#9ca3af'};font-size:.88em">
                        ${m.scale < 1 ? (Math.round((1 - m.scale) * 100) + '% fewer days') : '—'}
                    </td>
                    <td class="report-num">${_fmt$(m.rev)}</td>
                </tr>`).join('')}</tbody>
                <tfoot><tr class="report-total-row">
                    <td colspan="2"><strong>Total Projected Remaining</strong></td>
                    <td class="report-num"><strong>${_fmt$(projRemainingTotal)}</strong></td>
                </tr></tfoot>
            </table>
            </details>` : '';

        const budgetVsHtml = _annualBudget?.income
            ? `<div class="fin-kpi">
                <span class="fin-kpi-label">vs. Annual Budget</span>
                <span class="fin-kpi-value ${fullYearProj >= _annualBudget.income ? 'fin-positive' : 'fin-negative'}">
                    ${fullYearProj >= _annualBudget.income ? '+' : ''}${_fmt$(fullYearProj - _annualBudget.income)}
                </span>
              </div>` : '';

        const hasClosureAdj = projMonthRows.some(m => m.scale < 1);

        el.innerHTML = `
        <details open style="margin-top:1.5rem">
        <summary style="cursor:pointer;font-weight:600;font-size:.95rem;margin-bottom:.75rem">▸ Attendance-Based Revenue Projection</summary>
        <p style="font-size:.85em;color:#6b7280;margin:.25rem 0 .75rem">
            Avg half/full attendance days per room × current room rates.
            Remaining months projected only for rooms that historically operate that month.
            ${hasClosureAdj ? 'Months with entered school closures are scaled down proportionally.' : ''}
        </p>
        <div style="overflow-x:auto;margin-bottom:.5rem">
        <table class="report-table" style="max-width:${futureMonthNums.length > 0 ? '860px' : '740px'}">
            <thead><tr>
                <th>Room</th>
                <th class="report-num">Mo. of Data</th>
                <th class="report-num">Avg Half/Mo</th>
                <th class="report-num">Avg Full/Mo</th>
                <th class="report-num">Rate H/F</th>
                <th class="report-num">Proj. Rev/Mo</th>
                ${futureMonthNums.length > 0 ? '<th>Projected for</th>' : ''}
            </tr></thead>
            <tbody>${rowHtml}</tbody>
            <tfoot><tr class="report-total-row">
                <td colspan="5"><strong>Avg Projected Monthly (all rooms)</strong></td>
                <td class="report-num report-revenue"><strong>${_fmt$(totalProjMonthly)}</strong></td>
                ${futureMonthNums.length > 0 ? '<td></td>' : ''}
            </tr></tfoot>
        </table>
        </div>
        ${projMonthHtml}
        ${futureMonthNums.length > 0 ? `
        <div class="fin-kpi-row" style="margin-bottom:1rem">
            <div class="fin-kpi">
                <span class="fin-kpi-label">YTD Actual (${allMoList.length} mo)</span>
                <span class="fin-kpi-value fin-positive">${_fmt$(ytdActual)}</span>
            </div>
            <div class="fin-kpi">
                <span class="fin-kpi-label">+ Projected Remaining</span>
                <span class="fin-kpi-value">${_fmt$(projRemainingTotal)}</span>
            </div>
            <div class="fin-kpi">
                <span class="fin-kpi-label">Full-Year Projection</span>
                <span class="fin-kpi-value fin-positive"><strong>${_fmt$(fullYearProj)}</strong></span>
            </div>
            ${budgetVsHtml}
        </div>` : `
        <div class="fin-kpi-row" style="margin-bottom:1rem">
            <div class="fin-kpi">
                <span class="fin-kpi-label">Avg Monthly Revenue (attendance-based)</span>
                <span class="fin-kpi-value fin-positive">${_fmt$(totalProjMonthly)}</span>
            </div>
        </div>`}

        <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:1rem;max-width:860px;margin-top:.25rem">
            <h5 style="margin:0 0 .75rem;font-weight:600;font-size:.92rem">What-If Adjustments</h5>

            <div style="display:flex;gap:1.25rem;flex-wrap:wrap;align-items:flex-end;margin-bottom:1rem;padding-bottom:1rem;border-bottom:1px solid #e2e8f0">
                <div>
                    <label style="display:block;font-size:.82em;color:#6b7280;margin-bottom:.2rem">Revenue % change</label>
                    <div style="display:flex;align-items:center;gap:.3rem">
                        <input type="number" id="projRevAdj" value="0" step="1" min="-50" max="100"
                            class="form-control" style="width:80px;text-align:right">
                        <span style="color:#6b7280;font-size:.9em">%</span>
                    </div>
                </div>
                <div>
                    <label style="display:block;font-size:.82em;color:#6b7280;margin-bottom:.2rem">Flat $ / month extra</label>
                    <div style="display:flex;align-items:center;gap:.3rem">
                        <span style="color:#6b7280;font-size:.9em">$</span>
                        <input type="number" id="projFlatAdj" value="0" step="100" min="-50000" max="50000"
                            class="form-control" style="width:100px;text-align:right">
                    </div>
                </div>
                <div>
                    <label style="display:block;font-size:.82em;color:#6b7280;margin-bottom:.2rem">Wages % change</label>
                    <div style="display:flex;align-items:center;gap:.3rem">
                        <input type="number" id="projWageAdj" value="0" step="1" min="-50" max="100"
                            class="form-control" style="width:80px;text-align:right">
                        <span style="color:#6b7280;font-size:.9em">%</span>
                    </div>
                </div>
            </div>

            <div style="margin-bottom:.5rem">
                <div style="font-size:.82em;color:#6b7280;font-weight:600;margin-bottom:.25rem">Extra kids per room</div>
                <div style="font-size:.75em;color:#9ca3af;margin-bottom:.6rem">Each "kid" = 1 child at that room's typical monthly attendance. Half-day and full-day kids are billed at different rates.</div>
                <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:.6rem">
                    ${roomProj.map(r => {
                        const estimatedKids = Math.max(1, Math.round(r.avgTotalDays / 9));
                        const halfPerKid = r.avgHalf / estimatedKids;
                        const fullPerKid = r.avgFull / estimatedKids;
                        const revenuePerHalfKid = Math.round(halfPerKid) * (r.halfRate || 0);
                        const revenuePerFullKid = Math.round(fullPerKid) * (r.fullRate || 0);
                        const hasHalf = halfPerKid >= 0.5 && r.halfRate > 0;
                        const hasFull = fullPerKid >= 0.5 && r.fullRate > 0;
                        return `<div style="background:#fff;border:1px solid #e2e8f0;border-radius:6px;padding:.55rem .7rem">
                            <div style="font-size:.82em;font-weight:600;color:#374151;margin-bottom:.4rem">${escHtml(r.label)}</div>
                            ${hasHalf ? `<div style="display:flex;align-items:center;gap:.4rem;margin-bottom:.3rem">
                                <div style="flex:1;min-width:0">
                                    <div style="font-size:.72em;color:#6b7280">Half-day · $${r.halfRate}/day · ~${Math.round(halfPerKid)} days/kid/mo · ~${Math.round(r.avgHalf / 20)} kids/day</div>
                                </div>
                                <input type="number" id="projHalfKidsAdj_${escHtml(r.id)}" value="0" step="1" min="-20" max="20"
                                    class="form-control proj-kids-input" style="width:52px;text-align:right;padding:.2rem .35rem;font-size:.85em">
                                <span style="font-size:.75em;color:#6b7280;white-space:nowrap">kids</span>
                                <span id="projHalfKidsAmt_${escHtml(r.id)}" style="font-size:.75em;min-width:52px;text-align:right;display:none"></span>
                            </div>` : ''}
                            ${hasFull ? `<div style="display:flex;align-items:center;gap:.4rem">
                                <div style="flex:1;min-width:0">
                                    <div style="font-size:.72em;color:#6b7280">Full-day · $${r.fullRate}/day · ~${Math.round(fullPerKid)} days/kid/mo · ~${Math.round(r.avgFull / 20)} kids/day</div>
                                </div>
                                <input type="number" id="projFullKidsAdj_${escHtml(r.id)}" value="0" step="1" min="-20" max="20"
                                    class="form-control proj-kids-input" style="width:52px;text-align:right;padding:.2rem .35rem;font-size:.85em">
                                <span style="font-size:.75em;color:#6b7280;white-space:nowrap">kids</span>
                                <span id="projFullKidsAmt_${escHtml(r.id)}" style="font-size:.75em;min-width:52px;text-align:right;display:none"></span>
                            </div>` : ''}
                            ${!hasHalf && !hasFull ? `<div style="font-size:.75em;color:#9ca3af">No rate data</div>` : ''}
                        </div>`;
                    }).join('')}
                </div>
            </div>

            <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid #e2e8f0">
                <div style="font-size:.82em;color:#6b7280;font-weight:600;margin-bottom:.25rem">Extra care days / month (any source)</div>
                <div style="font-size:.75em;color:#9ca3af;margin-bottom:.6rem">Use this to model extra billing days regardless of how they come about — new enrollments, existing kids adding days, etc. Billed at the center's average rate for that day type.</div>
                <div style="display:flex;gap:1.25rem;flex-wrap:wrap;align-items:flex-end">
                    <div>
                        <label style="display:block;font-size:.82em;color:#6b7280;margin-bottom:.2rem">Extra half days/mo <span style="color:#9ca3af">(avg $${Math.round(avgHalfRate)}/day)</span></label>
                        <div style="display:flex;align-items:center;gap:.3rem">
                            <input type="number" id="projExtraHalfDays" value="0" step="1" min="-500" max="500"
                                class="form-control proj-days-input" style="width:80px;text-align:right">
                            <span style="color:#6b7280;font-size:.9em">days</span>
                            <span id="projExtraHalfDaysAmt" style="font-size:.82em;color:#059669;display:none"></span>
                        </div>
                    </div>
                    <div>
                        <label style="display:block;font-size:.82em;color:#6b7280;margin-bottom:.2rem">Extra full days/mo <span style="color:#9ca3af">(avg $${Math.round(avgFullRate)}/day)</span></label>
                        <div style="display:flex;align-items:center;gap:.3rem">
                            <input type="number" id="projExtraFullDays" value="0" step="1" min="-500" max="500"
                                class="form-control proj-days-input" style="width:80px;text-align:right">
                            <span style="color:#6b7280;font-size:.9em">days</span>
                            <span id="projExtraFullDaysAmt" style="font-size:.82em;color:#059669;display:none"></span>
                        </div>
                    </div>
                </div>
            </div>

            <div style="margin-top:1rem;padding-top:1rem;border-top:1px solid #e2e8f0">
                <div style="font-size:.82em;color:#6b7280;font-weight:600;margin-bottom:.25rem">Staffing impact estimate</div>
                <div style="font-size:.75em;color:#9ca3af;margin-bottom:.6rem">
                    Based on your current labor cost, you spend about <strong>$${Math.round(laborCostPerChildDay)}/child-day</strong> on staffing.
                    Extra care days will estimate additional labor at that rate. Override below if you expect a different staffing cost per day.
                </div>
                <div style="display:flex;gap:1.25rem;flex-wrap:wrap;align-items:flex-end">
                    <div>
                        <label style="display:block;font-size:.82em;color:#6b7280;margin-bottom:.2rem">Staff cost per extra day <span style="color:#9ca3af">(override, or leave 0 to use $${Math.round(laborCostPerChildDay)}/day)</span></label>
                        <div style="display:flex;align-items:center;gap:.3rem">
                            <span style="color:#6b7280;font-size:.9em">$</span>
                            <input type="number" id="projStaffCostPerDay" value="0" step="1" min="0" max="500"
                                class="form-control proj-days-input" style="width:80px;text-align:right">
                            <span style="color:#6b7280;font-size:.9em">/day</span>
                            <span id="projStaffImpactAmt" style="font-size:.82em;color:#dc2626;margin-left:.5rem;display:none"></span>
                        </div>
                    </div>
                </div>
            </div>

            <div id="projWhatIfResult" style="display:none"></div>
        </div>
        </details>`;

        // Store projection data on the element for the what-if handler
        el._projData = {
            totalProjMonthly, ytdActual, futureMonthNums, projRemainingTotal, fullYearProj,
            roomProj, roomOpMonths, closureScale, totalLab, allMoList, annualExpenses,
            avgHalfRate, avgFullRate, laborCostPerChildDay,
        };

        const updateWhatIf = () => {
            const revPct         = parseFloat(document.getElementById('projRevAdj')?.value)       || 0;
            const flatAdj        = parseFloat(document.getElementById('projFlatAdj')?.value)       || 0;
            const wagePct        = parseFloat(document.getElementById('projWageAdj')?.value)       || 0;
            const extraHalfDays  = parseFloat(document.getElementById('projExtraHalfDays')?.value) || 0;
            const extraFullDays  = parseFloat(document.getElementById('projExtraFullDays')?.value) || 0;
            const staffOverride  = parseFloat(document.getElementById('projStaffCostPerDay')?.value) || 0;
            const d = el._projData;
            if (!d) return;

            const extraDaysRevPerMo = extraHalfDays * d.avgHalfRate + extraFullDays * d.avgFullRate;
            const totalExtraDays = extraHalfDays + extraFullDays;
            const staffCostPerDay = staffOverride > 0 ? staffOverride : d.laborCostPerChildDay;
            const extraStaffCostPerMo = totalExtraDays * staffCostPerDay;

            // Update day input chips
            const halfDaysEl = document.getElementById('projExtraHalfDaysAmt');
            if (halfDaysEl) {
                if (extraHalfDays !== 0) { halfDaysEl.style.display = ''; halfDaysEl.textContent = `${extraHalfDays > 0 ? '+' : ''}${_fmt$(extraHalfDays * d.avgHalfRate)}/mo`; }
                else halfDaysEl.style.display = 'none';
            }
            const fullDaysEl = document.getElementById('projExtraFullDaysAmt');
            if (fullDaysEl) {
                if (extraFullDays !== 0) { fullDaysEl.style.display = ''; fullDaysEl.textContent = `${extraFullDays > 0 ? '+' : ''}${_fmt$(extraFullDays * d.avgFullRate)}/mo`; }
                else fullDaysEl.style.display = 'none';
            }
            const staffImpactEl = document.getElementById('projStaffImpactAmt');
            if (staffImpactEl) {
                if (totalExtraDays !== 0) {
                    staffImpactEl.style.display = '';
                    staffImpactEl.textContent = `+${_fmt$(extraStaffCostPerMo)}/mo est. labor`;
                } else staffImpactEl.style.display = 'none';
            }

            // Read per-room extra half/full kids and compute each room's extra monthly revenue
            const roomKidsExtra = {}; // roomId → extra $/mo
            let anyKids = false;
            d.roomProj.forEach(r => {
                const estimatedKids = Math.max(1, Math.round(r.avgTotalDays / 9));
                const halfPerKid = r.avgHalf / estimatedKids;
                const fullPerKid = r.avgFull / estimatedKids;

                const extraHalf = parseFloat(document.getElementById(`projHalfKidsAdj_${r.id}`)?.value) || 0;
                const extraFull = parseFloat(document.getElementById(`projFullKidsAdj_${r.id}`)?.value) || 0;
                if (extraHalf !== 0 || extraFull !== 0) anyKids = true;

                const halfExtra = extraHalf * Math.round(halfPerKid) * (r.halfRate || 0);
                const fullExtra = extraFull * Math.round(fullPerKid) * (r.fullRate || 0);
                roomKidsExtra[r.id] = halfExtra + fullExtra;

                // Update inline amount chips
                const halfChip = document.getElementById(`projHalfKidsAmt_${r.id}`);
                if (halfChip) {
                    if (extraHalf !== 0) {
                        halfChip.style.display = '';
                        halfChip.textContent = `${halfExtra >= 0 ? '+' : ''}${_fmt$(halfExtra)}/mo`;
                        halfChip.style.color = halfExtra >= 0 ? '#059669' : '#dc2626';
                    } else { halfChip.style.display = 'none'; }
                }
                const fullChip = document.getElementById(`projFullKidsAmt_${r.id}`);
                if (fullChip) {
                    if (extraFull !== 0) {
                        fullChip.style.display = '';
                        fullChip.textContent = `${fullExtra >= 0 ? '+' : ''}${_fmt$(fullExtra)}/mo`;
                        fullChip.style.color = fullExtra >= 0 ? '#059669' : '#dc2626';
                    } else { fullChip.style.display = 'none'; }
                }
            });
            const kidsExtraPerMo = Object.values(roomKidsExtra).reduce((s, v) => s + v, 0);

            const noChange = revPct === 0 && !anyKids && flatAdj === 0 && wagePct === 0 && extraHalfDays === 0 && extraFullDays === 0;
            const resultEl = document.getElementById('projWhatIfResult');
            if (!resultEl) return;
            if (noChange) { resultEl.style.display = 'none'; return; }

            const hasFuture = d.futureMonthNums.length > 0;
            let adjFullYear, adjLabel, delta;
            const moCount = d.allMoList.length || 1;

            if (hasFuture) {
                // Current year with remaining months: adjust the future projection
                let adjProjRemaining = 0;
                d.futureMonthNums.forEach(m => {
                    const scale = d.closureScale[m] || 1;
                    let moRev = 0;
                    d.roomProj.forEach(r => {
                        if (d.roomOpMonths[r.id]?.has(m)) {
                            moRev += r.projMonthly * (1 + revPct / 100) * scale;
                            moRev += (roomKidsExtra[r.id] || 0) * scale;
                        }
                    });
                    adjProjRemaining += moRev + (flatAdj + extraDaysRevPerMo) * scale;
                });
                adjFullYear = d.ytdActual + adjProjRemaining;
                adjLabel = 'Adj. Full-Year Revenue';
                delta = adjFullYear - d.fullYearProj;
            } else {
                // No future months (prior year or complete year): annualized model
                const adjMonthly = d.totalProjMonthly * (1 + revPct / 100) + kidsExtraPerMo + flatAdj + extraDaysRevPerMo;
                adjFullYear = adjMonthly * 12;
                adjLabel = 'Annualized Estimate';
                delta = adjFullYear - d.totalProjMonthly * 12;
            }

            const adjAnnualLab = d.totalLab * (1 + wagePct / 100) * (12 / moCount)
                + extraStaffCostPerMo * (hasFuture ? d.futureMonthNums.length : 12);
            const adjNet       = adjFullYear - adjAnnualLab - (d.annualExpenses || 0);

            resultEl.style.display = '';
            resultEl.innerHTML = `
                <div class="fin-kpi-row" style="margin-top:.5rem;padding-top:.5rem;border-top:1px solid #e2e8f0">
                    <div class="fin-kpi">
                        <span class="fin-kpi-label">${adjLabel}</span>
                        <span class="fin-kpi-value fin-positive"><strong>${_fmt$(adjFullYear)}</strong>
                            <span class="fin-kpi-target ${delta >= 0 ? 'fin-positive' : 'fin-negative'}" style="font-size:.8em">
                                ${delta >= 0 ? '+' : ''}${_fmt$(delta)} vs base
                            </span>
                        </span>
                    </div>
                    ${(wagePct !== 0 || totalExtraDays !== 0) ? `<div class="fin-kpi">
                        <span class="fin-kpi-label">Adj. Annual Labor</span>
                        <span class="fin-kpi-value">${_fmt$(adjAnnualLab)}
                            ${totalExtraDays !== 0 ? `<span style="font-size:.8em;color:#dc2626">+${_fmt$(extraStaffCostPerMo * (hasFuture ? d.futureMonthNums.length : 12))} staffing</span>` : ''}
                        </span>
                    </div>
                    <div class="fin-kpi">
                        <span class="fin-kpi-label">Adj. Net (est.)</span>
                        <span class="fin-kpi-value ${adjNet >= 0 ? 'fin-positive' : 'fin-negative'}">${_fmt$(adjNet)}</span>
                    </div>` : ''}
                </div>`;
        };

        ['projRevAdj','projFlatAdj','projWageAdj','projExtraHalfDays','projExtraFullDays','projStaffCostPerDay'].forEach(id => {
            document.getElementById(id)?.addEventListener('input', updateWhatIf);
        });
        document.querySelectorAll('.proj-kids-input').forEach(inp => {
            inp.addEventListener('input', updateWhatIf);
        });

    } catch(e) {
        console.warn('Attendance projection:', e);
    }
}

// ── Single-Month Detail View ──────────────────────────────────
async function _generateMonthDetail(year, month, container) {
    const mo       = `${year}-${month}`;
    const fromDate = `${mo}-01`;
    const lastDay  = new Date(year, parseInt(month), 0).getDate();
    const toDate   = `${mo}-${String(lastDay).padStart(2, '0')}`;
    const label    = `${['January','February','March','April','May','June','July','August','September','October','November','December'][parseInt(month)-1]} ${year}`;

    try {
        await _ensureBudget(year);
        if (!_expenseConfig) _expenseConfig = await fetchExpenseConfig();

        // Revenue: use the same Family Billing calculation so both reports always agree.
        // Labor: still fetched via _buildRoomPnlData (uses staff schedules/clock events).
        try {
            allFamiliesData = await fetchAllFamilies({ includeArchived: true });
            _discountMap = null;
        } catch (e) { console.warn('Could not load families:', e); }
        try {
            const fresh = await fetchAllRegistrations();
            if (fresh && fresh.length) allRegistrations = fresh;
        } catch (e) { console.warn('Could not refresh registrations:', e); }

        let overrideRows = [];
        try { overrideRows = await fetchBillingOverrides(`${year}-${month}`); } catch (e) {}
        const overridesMap = new Map(overrideRows.map(r => [
            `${(r.parent_email || '').toLowerCase()}:${(r.child_name || '').toLowerCase()}`,
            parseFloat(r.override_amount),
        ]));

        const families = _buildFamilyBillingData(`${year}-${month}`, overridesMap);
        const roomRevMap = {};
        families.forEach(fam => {
            fam.children.forEach(c => {
                const billed = (c.hasOverride ? c.overrideAmount : c.subtotal) + (c.changeFees || 0);
                if (!roomRevMap[c.roomId]) roomRevMap[c.roomId] = { revenue: 0, fullDays: 0, halfDays: 0 };
                roomRevMap[c.roomId].revenue  += billed;
                roomRevMap[c.roomId].fullDays += c.fullDays || 0;
                roomRevMap[c.roomId].halfDays += c.halfDays || 0;
            });
        });

        // For historical months with no live registrations, fall back to billing_summary
        const liveTotal = Object.values(roomRevMap).reduce((s, v) => s + v.revenue, 0);
        if (liveTotal === 0) {
            try {
                const summaryRows = await fetchBillingSummary();
                summaryRows.forEach(row => {
                    if ((row.month || '').substring(0, 7) !== mo) return;
                    if (!roomRevMap[row.room_id]) roomRevMap[row.room_id] = { revenue: 0, fullDays: 0, halfDays: 0 };
                    roomRevMap[row.room_id].revenue  += parseFloat(row.net_billed) || 0;
                    roomRevMap[row.room_id].fullDays += row.full_days || 0;
                    roomRevMap[row.room_id].halfDays += row.half_days || 0;
                });
            } catch (e) { console.warn('billing_summary fallback failed:', e); }
        }

        const pnl = await _buildRoomPnlData(fromDate, toDate, { skipHistoricalOverride: true });
        const moData = pnl.data[mo] || {};

        const hasPerRoomLab = pnl.hasScheduleData || pnl.hasClockBasedLabor;
        // centerLab = any remaining unallocated labor (lump-sum periods not yet imported, untagged floats)
        const centerLab = pnl.centerLaborByMonth?.[mo] || 0;
        const laborNote = pnl.hasClockBasedLabor
            ? `<p style="margin:.5rem 0 1rem;font-size:.85em;color:#2e7d32">ℹ Labor estimated from clock records — assigned staff direct to room; salaried overhead by attendance.</p>`
            : (pnl.hasFallbackLabor && centerLab > 0
                ? `<p style="margin:.5rem 0 1rem;font-size:.85em;color:#92400e">⚠ No room schedules saved — labor total is center-wide and cannot be split by room.</p>`
                : (!pnl.hasFallbackLabor && !pnl.hasScheduleData
                    ? `<p style="margin:.5rem 0 1rem;font-size:.85em;color:#6b7280">No payroll data found for this period — labor shows as $0.</p>`
                    : ''));

        let totalRev = 0, totalLab = centerLab, totalFull = 0, totalHalf = 0;
        const activeRoomIds = new Set([...Object.keys(roomRevMap), ...Object.keys(moData)]);
        const roomRows = getSortedRooms().filter(r => activeRoomIds.has(r.id)).map(r => {
            // Use live billing data when available; fall back to billing_summary for historical months
            const rev  = roomRevMap[r.id]?.revenue  || moData[r.id]?.revenue  || 0;
            const full = roomRevMap[r.id]?.fullDays || 0;
            const half = roomRevMap[r.id]?.halfDays || 0;
            const lab  = hasPerRoomLab ? (moData[r.id]?.labor || 0) : 0;
            totalRev  += rev;
            if (hasPerRoomLab) totalLab += lab;
            totalFull += full;
            totalHalf += half;
            return { label: r.label, fullDays: full, halfDays: half, revenue: rev, labor: lab };
        });

        const moNum  = parseInt(month);
        const totalExp = _monthlyExpenseBurden(moNum, totalLab, totalRev);
        const totalNet = totalRev - totalLab - totalExp;
        const labPct   = totalRev > 0 ? totalLab / totalRev * 100 : 0;
        const netPct   = totalRev > 0 ? totalNet / totalRev * 100 : 0;
        const hasExp   = totalExp > 0;
        const marginClass = netPct >= 30 ? 'fin-positive' : netPct >= 15 ? 'fin-warn' : 'fin-negative';
        const budgLabPct  = _budgetLaborPct();

        const roomRowsHtml = roomRows.map(r => {
            const net = r.revenue - r.labor;
            return `<tr>
                <td>${escHtml(r.label)}</td>
                <td class="report-num">${r.fullDays || '—'}</td>
                <td class="report-num">${r.halfDays || '—'}</td>
                <td class="report-num report-revenue">${_fmt$(r.revenue)}</td>
                <td class="report-num">${r.labor > 0 ? _fmt$(r.labor) : (hasPerRoomLab ? _fmt$(0) : '—')}</td>
                <td class="report-num ${net >= 0 ? 'fin-positive' : 'fin-negative'}">${_fmt$(net)}</td>
            </tr>`;
        }).join('');

        container.innerHTML = `
            <h3 style="margin:0 0 1rem">${escHtml(label)}</h3>
            ${laborNote}
            <div class="fin-kpi-row">
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Revenue</span>
                    <span class="fin-kpi-value fin-positive">${_fmt$(totalRev)}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Full Days</span>
                    <span class="fin-kpi-value">${totalFull.toLocaleString()}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Half Days</span>
                    <span class="fin-kpi-value">${totalHalf.toLocaleString()}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Labor${pnl.hasFallbackLabor ? ' (center)' : ''}</span>
                    <span class="fin-kpi-value">${_fmt$(totalLab)}</span>
                </div>
                ${hasExp ? `<div class="fin-kpi">
                    <span class="fin-kpi-label">Other Expenses</span>
                    <span class="fin-kpi-value">${_fmt$(totalExp)}</span>
                </div>` : ''}
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Net${hasExp ? '' : ' (before expenses)'}</span>
                    <span class="fin-kpi-value ${marginClass}">${_fmt$(totalNet)}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Net Margin %</span>
                    <span class="fin-kpi-value ${marginClass}">${netPct.toFixed(1)}%</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Labor % of Revenue</span>
                    <span class="fin-kpi-value ${budgLabPct !== null ? (labPct <= budgLabPct ? 'fin-positive' : 'fin-negative') : ''}">
                        ${totalRev > 0 ? labPct.toFixed(1) + '%' : '—'}
                        ${budgLabPct !== null
                            ? `<span class="fin-kpi-target">budget ≤ ${budgLabPct.toFixed(0)}%</span>`
                            : `<span class="fin-kpi-target" style="color:#9ca3af">set budget above</span>`}
                    </span>
                </div>
            </div>
            <table class="report-table" style="margin-top:1.5rem">
                <thead>
                    <tr>
                        <th>Room</th>
                        <th class="report-num">Full Days</th>
                        <th class="report-num">Half Days</th>
                        <th class="report-num">Revenue</th>
                        <th class="report-num">Labor</th>
                        <th class="report-num">Net (Rev−Lab)</th>
                    </tr>
                </thead>
                <tbody>${roomRowsHtml}</tbody>
                <tfoot>
                    <tr style="font-weight:700;border-top:2px solid #cbd5e1">
                        <td>Total</td>
                        <td class="report-num">${totalFull}</td>
                        <td class="report-num">${totalHalf}</td>
                        <td class="report-num report-revenue">${_fmt$(totalRev)}</td>
                        <td class="report-num">${_fmt$(totalLab)}${pnl.hasFallbackLabor && totalLab > 0 ? '*' : ''}</td>
                        <td class="report-num ${marginClass}">${_fmt$(totalRev - totalLab)}</td>
                    </tr>
                </tfoot>
            </table>`;
    } catch (err) {
        container.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    }
}

// ── Year-over-Year Comparison ─────────────────────────────────
async function generateYoyComparison() {
    const year  = _financeYear();
    const prior = year - 1;
    const container = document.getElementById('financeYoyContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        const [curr, prev] = await Promise.all([
            _buildRoomPnlData(`${year}-01-01`,  `${year}-12-31`),
            _buildRoomPnlData(`${prior}-01-01`, `${prior}-12-31`),
        ]);

        // Build month-number → value maps for both years
        const currRevMap = {}, currLabMap = {}, prevRevMap = {}, prevLabMap = {};
        curr.months.forEach(mo => {
            const n = parseInt(mo.split('-')[1]);
            currRevMap[n] = _moRev(curr, mo);
            currLabMap[n] = _moLab(curr, mo);
        });
        prev.months.forEach(mo => {
            const n = parseInt(mo.split('-')[1]);
            prevRevMap[n] = _moRev(prev, mo);
            prevLabMap[n] = _moLab(prev, mo);
        });

        const nums      = [1,2,3,4,5,6,7,8,9,10,11,12];
        const currRevArr = nums.map(n => Math.round(currRevMap[n] || 0));
        const prevRevArr = nums.map(n => Math.round(prevRevMap[n] || 0));
        const currLabArr = nums.map(n => Math.round(currLabMap[n] || 0));
        const prevLabArr = nums.map(n => Math.round(prevLabMap[n] || 0));

        const totalCurrRev = currRevArr.reduce((a,b)=>a+b,0);
        const totalPrevRev = prevRevArr.reduce((a,b)=>a+b,0);
        const yoyChange    = totalPrevRev > 0 ? ((totalCurrRev - totalPrevRev) / totalPrevRev * 100) : null;
        const yoyClass     = yoyChange === null ? '' : yoyChange >= 0 ? 'fin-positive' : 'fin-negative';

        container.innerHTML = `
            <div class="fin-kpi-row" style="margin-bottom:1rem">
                <div class="fin-kpi">
                    <span class="fin-kpi-label">${prior} Total Revenue</span>
                    <span class="fin-kpi-value">${_fmt$(totalPrevRev)}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">${year} Total Revenue</span>
                    <span class="fin-kpi-value fin-positive">${_fmt$(totalCurrRev)}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">YoY Change</span>
                    <span class="fin-kpi-value ${yoyClass}">
                        ${yoyChange !== null ? (yoyChange >= 0 ? '+' : '') + yoyChange.toFixed(1) + '%' : '—'}
                    </span>
                </div>
            </div>
            <div class="fin-charts-row">
                <div class="fin-chart-wrap">
                    <h4 class="fin-chart-title">Revenue: ${prior} vs ${year}</h4>
                    <canvas id="chartYoyRev"></canvas>
                </div>
                <div class="fin-chart-wrap">
                    <h4 class="fin-chart-title">Labor: ${prior} vs ${year}</h4>
                    <canvas id="chartYoyLab"></canvas>
                </div>
            </div>`;

        const chartDefaults = (prevArr, currArr, prevYear, currYear, prevColor, currColor) => ({
            type: 'bar',
            data: {
                labels: FIN_MONTH_SHORT,
                datasets: [
                    { label: String(prevYear), data: prevArr,
                      backgroundColor: prevColor[0], borderColor: prevColor[1], borderWidth: 1 },
                    { label: String(currYear), data: currArr,
                      backgroundColor: currColor[0], borderColor: currColor[1], borderWidth: 1 },
                ],
            },
            options: {
                responsive: true,
                plugins: { legend: { position: 'top' } },
                scales: { y: { beginAtZero: true, ticks: { callback: v => '$' + v.toLocaleString() } } },
            },
        });

        _destroyChart('yoyRev');
        _financeCharts.yoyRev = new Chart(
            document.getElementById('chartYoyRev').getContext('2d'),
            chartDefaults(prevRevArr, currRevArr, prior, year,
                ['rgba(148,163,184,.65)', 'rgb(148,163,184)'],
                ['rgba(22,163,74,.75)',   'rgb(22,163,74)'])
        );

        _destroyChart('yoyLab');
        _financeCharts.yoyLab = new Chart(
            document.getElementById('chartYoyLab').getContext('2d'),
            chartDefaults(prevLabArr, currLabArr, prior, year,
                ['rgba(148,163,184,.65)', 'rgb(148,163,184)'],
                ['rgba(245,158,11,.75)',  'rgb(245,158,11)'])
        );

    } catch (err) {
        container.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`;
    }
}

// ============================================================
// EXPENSE LINES
// ============================================================
// MONTH_NAMES is defined in supabase.js (loaded first) and shared globally.
let _expenseConfig = null; // cached { items: [...] }
let _editingExpenseId = null;

function setupExpenseLines() {
    document.getElementById('addExpenseBtn')
        ?.addEventListener('click', () => openExpenseForm(null));
    document.getElementById('expenseFormCancel')
        ?.addEventListener('click', closeExpenseForm);
    document.getElementById('expenseFormSave')
        ?.addEventListener('click', saveExpenseLine);
    document.getElementById('expenseTypeInput')
        ?.addEventListener('change', _toggleExpenseFields);
    loadExpenseLines();
}

function _toggleExpenseFields() {
    const type = document.getElementById('expenseTypeInput')?.value;
    const wrap = document.getElementById('expenseMonthWrap');
    if (wrap) wrap.style.display = type === 'annual' ? '' : 'none';
    const lbl = document.getElementById('expenseAmountLabel');
    const isPct = type === 'payroll_pct' || type === 'revenue_pct';
    if (lbl) lbl.textContent = isPct ? 'Rate (%) *' : 'Amount ($) *';
    const inp = document.getElementById('expenseAmountInput');
    if (inp) inp.placeholder = isPct ? 'e.g. 7.65' : '0.00';
}

async function loadExpenseLines() {
    try {
        _expenseConfig = await fetchExpenseConfig();
        renderExpenseLines();
    } catch (e) {
        const el = document.getElementById('expenseLinesContent');
        if (el) el.innerHTML = `<p class="import-error">Error loading expenses: ${escHtml(e.message)}</p>`;
    }
}

function renderExpenseLines() {
    const container = document.getElementById('expenseLinesContent');
    if (!container) return;
    const items = _expenseConfig?.items || [];

    const monthly = items.filter(i => i.type === 'monthly');
    const annual  = items.filter(i => i.type === 'annual');

    const monthlyTotal = monthly.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);
    const annualTotal  = annual.reduce((s, i) => s + (parseFloat(i.amount) || 0), 0);

    const rowHtml = (item) => `
        <tr>
            <td>${escHtml(item.label)}</td>
            <td>${item.type === 'annual'
                ? `Annual — ${MONTH_NAMES[(item.month || 1) - 1]}`
                : item.type === 'payroll_pct'
                ? '% of wages (auto)'
                : item.type === 'revenue_pct'
                ? '% of revenue (auto)'
                : 'Monthly'}</td>
            <td class="report-num">${(item.type === 'payroll_pct' || item.type === 'revenue_pct')
                ? `${parseFloat(item.amount||0).toFixed(2)}%`
                : `${item.amount < 0 ? '-' : ''}$${Math.abs(parseFloat(item.amount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}`}</td>
            <td class="report-num" style="color:#6b7280;font-size:.85em">${escHtml(item.notes||'')}</td>
            <td style="white-space:nowrap">
                <button class="btn-link" data-exp-edit="${escHtml(item.id)}">Edit</button>
                <button class="btn-link" style="color:#dc2626" data-exp-del="${escHtml(item.id)}">Delete</button>
            </td>
        </tr>`;

    container.innerHTML = `
        <table class="report-table" style="margin-bottom:1rem">
            <thead><tr>
                <th>Expense</th><th>Frequency</th><th class="report-num">Amount</th>
                <th>Notes</th><th></th>
            </tr></thead>
            <tbody>
                ${items.length ? items.map(rowHtml).join('') : '<tr><td colspan="5" class="empty-hint">No expenses entered yet.</td></tr>'}
            </tbody>
            ${items.length ? `<tfoot><tr class="report-total-row">
                <td colspan="2"><strong>Monthly Fixed Total</strong></td>
                <td class="report-num"><strong>$${monthlyTotal.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</strong></td>
                <td colspan="2"><span style="color:#6b7280;font-size:.85em">+ $${annualTotal.toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})} in one-time annual items</span></td>
            </tr></tfoot>` : ''}
        </table>`;

    container.querySelectorAll('[data-exp-edit]').forEach(btn =>
        btn.addEventListener('click', () => {
            const item = (_expenseConfig?.items||[]).find(i => i.id === btn.dataset.expEdit);
            if (item) openExpenseForm(item);
        }));
    container.querySelectorAll('[data-exp-del]').forEach(btn =>
        btn.addEventListener('click', () => deleteExpenseLine(btn.dataset.expDel)));
}

function openExpenseForm(item) {
    _editingExpenseId = item?.id || null;
    document.getElementById('expenseFormTitle').textContent = item ? 'Edit Expense' : 'Add Expense';
    document.getElementById('expenseLabelInput').value  = item?.label  || '';
    document.getElementById('expenseAmountInput').value = item?.amount != null ? item.amount : '';
    document.getElementById('expenseTypeInput').value   = item?.type   || 'monthly';
    document.getElementById('expenseMonthInput').value  = item?.month  || 1;
    document.getElementById('expenseNotesInput').value  = item?.notes  || '';
    document.getElementById('expenseFormStatus').textContent = '';
    _toggleExpenseFields();
    document.getElementById('expenseFormWrap').classList.remove('hidden');
    document.getElementById('expenseLabelInput').focus();
}

function closeExpenseForm() {
    document.getElementById('expenseFormWrap').classList.add('hidden');
    _editingExpenseId = null;
}

async function saveExpenseLine() {
    const label  = document.getElementById('expenseLabelInput').value.trim();
    const amount = document.getElementById('expenseAmountInput').value;
    const type   = document.getElementById('expenseTypeInput').value;
    const month  = parseInt(document.getElementById('expenseMonthInput').value) || 1;
    const notes  = document.getElementById('expenseNotesInput').value.trim();
    const status = document.getElementById('expenseFormStatus');

    if (!label)                    { status.textContent = 'Label is required.'; return; }
    if (amount === '' || isNaN(parseFloat(amount))) { status.textContent = 'Enter a valid amount.'; return; }
    status.textContent = 'Saving…';

    const cfg = { items: [...(_expenseConfig?.items || [])] };
    if (_editingExpenseId) {
        const idx = cfg.items.findIndex(i => i.id === _editingExpenseId);
        if (idx >= 0) cfg.items[idx] = { ...cfg.items[idx], label, amount: parseFloat(amount), type, month, notes };
    } else {
        cfg.items.push({ id: crypto.randomUUID(), label, amount: parseFloat(amount), type, month, notes });
    }
    try {
        await saveExpenseConfig(cfg);
        _expenseConfig = cfg;
        renderExpenseLines();
        closeExpenseForm();
    } catch (e) { status.textContent = 'Save failed: ' + e.message; }
}

async function deleteExpenseLine(id) {
    if (!confirm('Delete this expense?')) return;
    const cfg = { items: (_expenseConfig?.items || []).filter(i => i.id !== id) };
    try {
        await saveExpenseConfig(cfg);
        _expenseConfig = cfg;
        renderExpenseLines();
    } catch (e) { alert('Delete failed: ' + e.message); }
}

// Helper: total monthly expense burden for a given month number (1-12)
// Pass laborAmount so payroll_pct items can auto-calculate.
// Pass revenueAmount so revenue_pct items (e.g. payment processor fee) auto-calculate.
function _monthlyExpenseBurden(moNum, laborAmount = 0, revenueAmount = 0) {
    const items = _expenseConfig?.items || [];
    const fixed      = items.filter(i => i.type === 'monthly')
                            .reduce((s, i) => s + (parseFloat(i.amount)||0), 0);
    const oneTime    = items.filter(i => i.type === 'annual' && (i.month||1) === moNum)
                            .reduce((s, i) => s + (parseFloat(i.amount)||0), 0);
    const payrollTax = items.filter(i => i.type === 'payroll_pct')
                            .reduce((s, i) => s + laborAmount * (parseFloat(i.amount)||0) / 100, 0);
    const processorFee = items.filter(i => i.type === 'revenue_pct')
                              .reduce((s, i) => s + revenueAmount * (parseFloat(i.amount)||0) / 100, 0);
    return fixed + oneTime + payrollTax + processorFee;
}

// ============================================================
// RATE / WAGE MODELING TOOL
// Uses actual per-room revenue from _buildRoomPnlData().
// ============================================================
let _roomModelData = null; // cache — cleared on tab switch

function setupModelingTool() {
    document.getElementById('runModelBtn')
        ?.addEventListener('click', runFinanceModel);
    renderRoomRateGrid();
}

// Build per-room baseline metrics.
// Revenue: _buildRoomPnlData (authoritative, same as dashboard)
// Child-days: billing_summary full_days/half_days (works for both historical and live months)
// Enrollment: direct count of confirmed registrations per room
async function _buildRoomModelData() {
    const today = new Date();
    // Include current month + up to 6 prior; skip months with no center-wide revenue; use max 6
    const candidateMonths = [];
    for (let i = 0; i <= 6; i++) {
        const d     = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const moKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        const end   = i === 0 ? today : new Date(d.getFullYear(), d.getMonth()+1, 0);
        candidateMonths.push({ key: moKey, start: `${moKey}-01`, end: end.toISOString().split('T')[0] });
    }
    const fromDate = candidateMonths[candidateMonths.length-1].start;
    const toDate   = candidateMonths[0].end;

    await Promise.all([loadRateSettings(), loadCapacitySettings()]);

    const [pnlData, allBilling, allStaff] = await Promise.all([
        _buildRoomPnlData(fromDate, toDate),
        fetchBillingSummary(),
        fetchAllStaff({ includeInactive: false }),
    ]);

    // Per-room monthly revenue from PnL
    const roomRevByMonth = {};
    pnlData.months.forEach(mo => {
        const moKey = mo.substring(0, 7);
        Object.entries(pnlData.data[mo] || {}).forEach(([roomId, rd]) => {
            if (!roomRevByMonth[roomId]) roomRevByMonth[roomId] = {};
            roomRevByMonth[roomId][moKey] = (roomRevByMonth[roomId][moKey] || 0) + (rd.revenue || 0);
        });
    });

    // Skip months with no center-wide revenue
    const totalRevByMonth = {};
    Object.values(roomRevByMonth).forEach(roomMap => {
        Object.entries(roomMap).forEach(([mo, rev]) => {
            totalRevByMonth[mo] = (totalRevByMonth[mo] || 0) + rev;
        });
    });
    const lastN = candidateMonths
        .filter(m => (totalRevByMonth[m.key] || 0) > 0)
        .slice(0, 6);

    if (!lastN.length) {
        _roomModelData = { roomData: {}, lastN: [], pnlData, centerAvgDaysPerFull: 18, centerAvgDaysPerHalf: 14, avgHourlyRate: 0 };
        return _roomModelData;
    }

    // Fetch enrollment filtered to the exact months we're reporting on,
    // then average monthly counts per room (not an all-time total)
    const enrollByRoom = await fetchEnrollmentByRoomForMonths(lastN.map(m => m.key));

    // Filter billing summary to our months
    const recentBilling = allBilling.filter(b =>
        lastN.some(m => (b.month || '').substring(0, 7) === m.key)
    );

    const activeRooms = getSortedRooms().filter(r => r.status === 'active' || r.status === 'coming_soon');
    const SCHOOL_DAYS = 21; // avg billable days per month — used when no better data
    const roomData = {};

    activeRooms.forEach(r => {
        const billingRows = recentBilling.filter(b => b.room_id === r.id);

        // Revenue avg: divide by months this room actually had revenue (not the full window)
        const roomRevMonths = lastN.filter(m => (roomRevByMonth[r.id]?.[m.key] || 0) > 0).length;
        const avgNetBilled  = roomRevMonths > 0
            ? lastN.reduce((s, m) => s + (roomRevByMonth[r.id]?.[m.key] || 0), 0) / roomRevMonths
            : 0;

        // Child-days from billing_summary — divide by months with data for this room
        const avgFullChildDays = billingRows.length > 0
            ? billingRows.reduce((s, b) => s + (b.full_days || 0), 0) / billingRows.length
            : 0;
        const avgHalfChildDays = billingRows.length > 0
            ? billingRows.reduce((s, b) => s + (b.half_days || 0), 0) / billingRows.length
            : 0;

        // Avg monthly enrollment across the last 3 months with revenue
        const enrollment = enrollByRoom[r.id] || 0;

        // Avg days per enrolled child: child-days ÷ enrollment
        // Falls back to a typical pattern if enrollment unknown
        const avgDaysPerFullChild = enrollment > 0 && avgFullChildDays > 0
            ? Math.round(avgFullChildDays / enrollment * 10) / 10
            : (avgFullChildDays > 0 ? Math.round(avgFullChildDays / Math.max(1, SCHOOL_DAYS * 0.6) * 10) / 10 : SCHOOL_DAYS);
        const avgDaysPerHalfChild = enrollment > 0 && avgHalfChildDays > 0
            ? Math.round(avgHalfChildDays / enrollment * 10) / 10
            : (avgHalfChildDays > 0 ? Math.round(avgHalfChildDays / Math.max(1, SCHOOL_DAYS * 0.6) * 10) / 10 : SCHOOL_DAYS * 0.7);

        const availableSlots = r.capacity != null ? Math.max(0, r.capacity - enrollment) : null;
        const staffNeeded    = r.staffRatio > 0 ? Math.ceil(enrollment / r.staffRatio) : 0;

        roomData[r.id] = {
            room: r,
            avgNetBilled, avgFullChildDays, avgHalfChildDays,
            enrollment,
            avgDaysPerFullChild, avgDaysPerHalfChild,
            availableSlots, staffNeeded,
            hasData: avgNetBilled > 0 || enrollment > 0,
        };
    });

    // Center-wide avg days per child (fallback for new/coming_soon rooms)
    const roomsWithData = Object.values(roomData).filter(rd => rd.enrollment > 0 && rd.avgFullChildDays > 0);
    const centerAvgDaysPerFull = roomsWithData.length > 0
        ? roomsWithData.reduce((s, rd) => s + rd.avgDaysPerFullChild, 0) / roomsWithData.length
        : SCHOOL_DAYS * 0.7;
    const centerAvgDaysPerHalf = SCHOOL_DAYS * 0.6;

    // Avg hourly staff rate
    const hourlyStaff   = allStaff.filter(s => s.pay_type !== 'salary' && s.active !== false);
    const avgHourlyRate = hourlyStaff.length > 0
        ? hourlyStaff.reduce((s, st) => s + (parseFloat(st.hourly_rate) || 0), 0) / hourlyStaff.length
        : 0;

    _roomModelData = { roomData, lastN, pnlData, centerAvgDaysPerFull, centerAvgDaysPerHalf, avgHourlyRate };
    return _roomModelData;
}

async function renderRoomRateGrid() {
    const grid = document.getElementById('modelRoomGrid');
    if (!grid) return;
    grid.innerHTML = '<p class="empty-hint">Loading room data…</p>';

    try {
        const { roomData, lastN } = await _buildRoomModelData();
        const activeRooms = getSortedRooms().filter(r => r.status === 'active' || r.status === 'coming_soon');
        const hasHalf     = activeRooms.some(r => !r.fullDayOnly);

        const overviewRows = activeRooms.map(r => {
            const rd = roomData[r.id];
            const enrollStr = rd.enrollment > 0
                ? `${rd.enrollment} enrolled`
                : '<span style="color:#9ca3af">None recorded</span>';
            const daysStr = rd.hasData && rd.avgFullChildDays > 0
                ? `${rd.avgDaysPerFullChild}/mo FD${rd.avgHalfChildDays > 0 ? `, ${rd.avgDaysPerHalfChild}/mo HD` : ''}`
                : '<span style="color:#9ca3af;font-size:.8em">Est. from avg</span>';
            const slotsStyle = rd.availableSlots === 0 ? 'color:#dc2626' : rd.availableSlots <= 2 ? 'color:#d97706' : 'color:#16a34a';
            return `<tr${r.status === 'coming_soon' ? ' style="background:#fefce8"' : ''}>
                <td>${escHtml(r.label)}${r.status === 'coming_soon' ? ' <span style="font-size:.75em;color:#d97706">(upcoming)</span>' : ''}</td>
                <td class="report-num">${r.capacity}</td>
                <td class="report-num">${enrollStr}</td>
                <td class="report-num" style="${slotsStyle}">${rd.availableSlots > 0 ? (Math.round(rd.availableSlots * 10) / 10) : 'Full'}</td>
                <td class="report-num">${daysStr}</td>
                <td class="report-num">${rd.staffNeeded}</td>
            </tr>`;
        }).join('');

        const inputRows = activeRooms.map(r => {
            const rd = roomData[r.id];
            return `<tr>
                <td>${escHtml(r.label)}</td>
                <td class="report-num">
                    <input type="number" step="1" min="0" value="0" class="form-control"
                        style="width:70px;text-align:right;display:inline-block"
                        data-model-room="${escHtml(r.id)}" data-model-type="full-rate">
                </td>
                ${hasHalf ? (r.fullDayOnly
                    ? '<td style="color:#9ca3af;font-size:.8em;text-align:center">FD only</td>'
                    : `<td class="report-num"><input type="number" step="1" min="0" value="0" class="form-control"
                        style="width:70px;text-align:right;display:inline-block"
                        data-model-room="${escHtml(r.id)}" data-model-type="half-rate"></td>`) : ''}
                <td class="report-num">
                    <input type="number" step="1" value="0" class="form-control"
                        style="width:70px;text-align:right;display:inline-block"
                        data-model-room="${escHtml(r.id)}" data-model-type="full-enroll">
                </td>
                ${hasHalf ? (r.fullDayOnly
                    ? '<td></td>'
                    : `<td class="report-num"><input type="number" step="1" value="0" class="form-control"
                        style="width:70px;text-align:right;display:inline-block"
                        data-model-room="${escHtml(r.id)}" data-model-type="half-enroll"></td>`) : ''}
            </tr>`;
        }).join('');

        grid.innerHTML = `
            <details open>
                <summary style="cursor:pointer;font-weight:600;margin-bottom:.5rem;font-size:.95rem">
                    ▸ Current Room Utilization (last ${lastN.length} months)
                </summary>
                <div style="overflow-x:auto;margin-bottom:.75rem">
                <table class="report-table" style="max-width:720px">
                    <thead><tr>
                        <th>Room</th>
                        <th class="report-num">Capacity</th>
                        <th class="report-num">Avg Enrolled</th>
                        <th class="report-num">Open Slots</th>
                        <th class="report-num">Avg Days/Child/Mo</th>
                        <th class="report-num">Staff Needed</th>
                    </tr></thead>
                    <tbody>${overviewRows}</tbody>
                </table>
                </div>
                <p style="font-size:.8em;color:#6b7280;margin:0">
                    Enrollment and days/child from actual registration history.
                    Staff needed = ceil(enrolled ÷ staff-to-child ratio).
                </p>
            </details>

            <div style="margin-top:1.1rem">
            <h5 style="margin:0 0 .4rem;font-size:.92rem;font-weight:600">Rate &amp; Enrollment Adjustments</h5>
            <div style="overflow-x:auto">
            <table class="report-table" style="max-width:700px">
                <thead>
                    <tr>
                        <th rowspan="2">Room</th>
                        <th class="report-num" colspan="${hasHalf ? 2 : 1}" style="text-align:center;border-bottom:1px solid #e5e7eb">Rate Increase ($/day)</th>
                        <th class="report-num" colspan="${hasHalf ? 2 : 1}" style="text-align:center;border-bottom:1px solid #e5e7eb">Enrollment Change (kids)</th>
                    </tr>
                    <tr>
                        <th class="report-num">Full Day</th>
                        ${hasHalf ? '<th class="report-num">Half Day</th>' : ''}
                        <th class="report-num">Full Day</th>
                        ${hasHalf ? '<th class="report-num">Half Day</th>' : ''}
                    </tr>
                </thead>
                <tbody>${inputRows}</tbody>
            </table>
            </div>
            <p style="font-size:.8em;color:#6b7280;margin:.25rem 0 0">
                Enrollment +/− uses each room's actual historical avg days/child. New rooms use center average.
            </p>
            </div>`;

    } catch (e) {
        grid.innerHTML = `<p class="import-error">Error loading room data: ${escHtml(e.message)}</p>`;
    }
}

async function runFinanceModel() {
    const wageInc = parseFloat(document.getElementById('modelWageInc')?.value || 0);
    const salInc  = parseFloat(document.getElementById('modelSalInc')?.value  || 0) / 100;
    const container = document.getElementById('modelResults');
    container.innerHTML = '<p class="empty-hint">Calculating…</p>';

    try {
        if (!_roomModelData) await _buildRoomModelData();
        const { roomData, lastN, pnlData, centerAvgDaysPerFull, centerAvgDaysPerHalf, avgHourlyRate } = _roomModelData;

        // Collect per-room inputs
        const roomInputs = {};
        document.querySelectorAll('[data-model-room]').forEach(inp => {
            const roomId = inp.dataset.modelRoom;
            const type   = inp.dataset.modelType;
            if (!roomInputs[roomId]) roomInputs[roomId] = {};
            roomInputs[roomId][type] = parseFloat(inp.value) || 0;
        });

        const activeRooms = getSortedRooms().filter(r => r.status === 'active' || r.status === 'coming_soon');
        const hasHalfAny  = activeRooms.some(r => !r.fullDayOnly);

        let totalBaseRev = 0, totalProjRev = 0;
        let totalAdditionalStaff = 0, totalAdditionalStaffCost = 0;
        const roomProjections = [];

        activeRooms.forEach(r => {
            const rd  = roomData[r.id];
            if (!rd) return;
            const inp = roomInputs[r.id] || {};

            const fullRateInc   = inp['full-rate']    || 0;
            const halfRateInc   = inp['half-rate']    || 0;
            const fullEnrollInc = inp['full-enroll']  || 0;
            const halfEnrollInc = inp['half-enroll']  || 0;

            // Rate change revenue: applied to the actual child-days already happening
            const rateRevInc = fullRateInc * rd.avgFullChildDays
                             + halfRateInc * rd.avgHalfChildDays;

            // Enrollment change revenue: uses actual avg days/child for this room
            const daysPerFull = rd.hasData ? rd.avgDaysPerFullChild : centerAvgDaysPerFull;
            const daysPerHalf = rd.hasData ? rd.avgDaysPerHalfChild : centerAvgDaysPerHalf;
            const projFDRate  = (r.fullDayRate  || 0) + fullRateInc;
            const projHDRate  = (r.halfDayRate  || 0) + halfRateInc;
            const enrollRevInc = fullEnrollInc * daysPerFull * projFDRate
                               + halfEnrollInc * daysPerHalf * projHDRate;

            const totalRevInc = rateRevInc + enrollRevInc;
            totalBaseRev += rd.avgNetBilled;
            totalProjRev += rd.avgNetBilled + totalRevInc;

            // Staff impact
            const newTotalEnroll  = Math.max(0, rd.enrollment + fullEnrollInc + halfEnrollInc);
            const newStaffNeeded  = r.staffRatio > 0 ? Math.ceil(newTotalEnroll / r.staffRatio) : 0;
            const additionalStaff = Math.max(0, newStaffNeeded - rd.staffNeeded);
            const additionalStaffCost = additionalStaff * avgHourlyRate * 160;
            totalAdditionalStaff     += additionalStaff;
            totalAdditionalStaffCost += additionalStaffCost;

            roomProjections.push({
                id: r.id, label: r.label, isNew: r.status === 'coming_soon',
                fullDayOnly: r.fullDayOnly,
                baseRev: rd.avgNetBilled,
                rateRevInc, enrollRevInc, totalRevInc,
                projRev: rd.avgNetBilled + totalRevInc - additionalStaffCost,
                fullEnrollInc, halfEnrollInc, fullRateInc, halfRateInc,
                daysPerFull, daysPerHalf,
                additionalStaff, additionalStaffCost,
                anyChange: fullRateInc || halfRateInc || fullEnrollInc || halfEnrollInc,
            });
        });

        // Baseline labor from the same PnL data used for revenue
        const { months } = pnlData;
        let sumLab = 0;
        months.forEach(mo => {
            sumLab += pnlData.hasFallbackLabor ? (pnlData.centerLaborByMonth[mo] || 0)
                    : Object.values(pnlData.data[mo] || {}).reduce((s, r) => s + (r.labor || 0), 0);
        });
        const baseLab    = months.length ? sumLab / months.length : 0;
        const projLabWage = baseLab + (baseLab * salInc) + (wageInc > 0 ? _estimateHourlyWageImpact(wageInc) : 0);

        // Fixed + one-time expenses
        const avgFixedExp = months.reduce((s, mo) => {
            const moNum = parseInt(mo.split('-')[1]);
            const items = _expenseConfig?.items || [];
            const fixed   = items.filter(i => i.type === 'monthly').reduce((s2, i) => s2 + (parseFloat(i.amount)||0), 0);
            const oneTime = items.filter(i => i.type === 'annual' && (i.month||1) === moNum).reduce((s2, i) => s2 + (parseFloat(i.amount)||0), 0);
            return s + fixed + oneTime;
        }, 0) / (months.length || 1);

        const payrollPctRate = (_expenseConfig?.items||[]).filter(i => i.type === 'payroll_pct').reduce((s, i) => s + (parseFloat(i.amount)||0), 0) / 100;
        const revenuePctRate = (_expenseConfig?.items||[]).filter(i => i.type === 'revenue_pct').reduce((s, i) => s + (parseFloat(i.amount)||0), 0) / 100;

        const scenarios = [
            { label: 'Current',            rev: totalBaseRev, lab: baseLab },
            { label: 'Rate + Enrollment',  rev: totalProjRev, lab: baseLab + totalAdditionalStaffCost },
            { label: 'Wage Changes',       rev: totalBaseRev, lab: projLabWage },
            { label: 'All Changes',        rev: totalProjRev, lab: projLabWage + totalAdditionalStaffCost },
        ];

        const fmt$   = v => '$' + Math.round(v).toLocaleString();
        const fmtPct = v => isFinite(v) ? v.toFixed(1) + '%' : '—';
        const cols   = scenarios.map(s => {
            const exp = avgFixedExp + s.lab * payrollPctRate + s.rev * revenuePctRate;
            const net = s.rev - s.lab - exp;
            const pct = s.rev > 0 ? net / s.rev * 100 : 0;
            return { ...s, exp, net, pct };
        });

        const changedRooms = roomProjections.filter(r => r.anyChange || r.baseRev > 0);
        const staffAlert = totalAdditionalStaff > 0
            ? `<div style="background:#fef3c7;border:1px solid #f59e0b;border-radius:6px;padding:.75rem;margin-bottom:1rem">
                <strong>⚠ Staffing:</strong> The enrollment changes require approximately
                <strong>${totalAdditionalStaff} additional staff member${totalAdditionalStaff > 1 ? 's' : ''}</strong>
                (~${fmt$(totalAdditionalStaffCost)}/month at avg $${Math.round(avgHourlyRate)}/hr × 160 hrs).
                Already included in "Rate + Enrollment" and "All Changes" scenarios.
               </div>` : '';

        container.innerHTML = `
            ${staffAlert}
            ${changedRooms.length ? `
            <h4 style="margin:0 0 .5rem">Revenue Impact by Room</h4>
            <div style="overflow-x:auto;margin-bottom:1.5rem">
            <table class="report-table" style="max-width:820px">
                <thead><tr>
                    <th>Room</th>
                    <th class="report-num">Avg Rev/mo</th>
                    <th class="report-num">Rate Change</th>
                    <th class="report-num">Enrollment Change</th>
                    <th class="report-num">Staff Cost</th>
                    <th class="report-num">Projected Net/mo</th>
                </tr></thead>
                <tbody>
                ${changedRooms.map(r => `<tr>
                    <td>${escHtml(r.label)}${r.isNew ? ' <span style="font-size:.75em;color:#d97706">(new)</span>' : ''}</td>
                    <td class="report-num">${r.baseRev > 0 ? fmt$(r.baseRev) : '<span style="color:#9ca3af">—</span>'}</td>
                    <td class="report-num" style="color:${r.rateRevInc ? '#16a34a' : '#9ca3af'}">
                        ${r.rateRevInc ? '+'+fmt$(r.rateRevInc) : '—'}
                        ${r.fullRateInc||r.halfRateInc ? `<br><span style="font-size:.78em;color:#6b7280">${[r.fullRateInc?`FD +$${r.fullRateInc}/day`:'',r.halfRateInc?`HD +$${r.halfRateInc}/day`:''].filter(Boolean).join(', ')}</span>` : ''}
                    </td>
                    <td class="report-num" style="color:${r.enrollRevInc !== 0 ? (r.enrollRevInc > 0 ? '#16a34a' : '#dc2626') : '#9ca3af'}">
                        ${r.enrollRevInc ? (r.enrollRevInc > 0 ? '+' : '') + fmt$(r.enrollRevInc) : '—'}
                        ${r.fullEnrollInc||r.halfEnrollInc ? `<br><span style="font-size:.78em;color:#6b7280">${[r.fullEnrollInc?`${r.fullEnrollInc>0?'+':''}${r.fullEnrollInc} FD (~${r.daysPerFull.toFixed(1)} d/mo)`:'',r.halfEnrollInc?`${r.halfEnrollInc>0?'+':''}${r.halfEnrollInc} HD (~${r.daysPerHalf.toFixed(1)} d/mo)`:''].filter(Boolean).join('<br>')}</span>` : ''}
                    </td>
                    <td class="report-num" style="color:${r.additionalStaffCost > 0 ? '#ef4444' : '#9ca3af'}">
                        ${r.additionalStaffCost > 0 ? '+'+fmt$(r.additionalStaffCost)+`<br><span style="font-size:.78em">+${r.additionalStaff} staff</span>` : '—'}
                    </td>
                    <td class="report-num"><strong>${fmt$(r.projRev)}</strong></td>
                </tr>`).join('')}
                <tr class="report-total-row">
                    <td><strong>Total</strong></td>
                    <td class="report-num"><strong>${fmt$(totalBaseRev)}</strong></td>
                    <td class="report-num" style="color:#16a34a"><strong>${roomProjections.reduce((s,r)=>s+r.rateRevInc,0) > 0 ? '+'+fmt$(roomProjections.reduce((s,r)=>s+r.rateRevInc,0)) : '—'}</strong></td>
                    <td class="report-num" style="color:#16a34a"><strong>${roomProjections.reduce((s,r)=>s+r.enrollRevInc,0) > 0 ? '+'+fmt$(roomProjections.reduce((s,r)=>s+r.enrollRevInc,0)) : '—'}</strong></td>
                    <td class="report-num" style="color:#ef4444"><strong>${totalAdditionalStaffCost > 0 ? '+'+fmt$(totalAdditionalStaffCost) : '—'}</strong></td>
                    <td class="report-num"><strong>${fmt$(totalProjRev - totalAdditionalStaffCost)}</strong></td>
                </tr>
                </tbody>
            </table>
            </div>` : ''}
            <h4 style="margin:0 0 .5rem">Scenario Comparison</h4>
            <div style="overflow-x:auto">
            <table class="report-table" style="min-width:580px">
                <thead><tr>
                    <th>Metric</th>
                    ${cols.map(c => `<th class="report-num">${escHtml(c.label)}</th>`).join('')}
                </tr></thead>
                <tbody>
                    <tr><td>Monthly Revenue</td>${cols.map(c=>`<td class="report-num report-revenue">${fmt$(c.rev)}</td>`).join('')}</tr>
                    <tr><td>Monthly Labor</td>${cols.map(c=>`<td class="report-num">${fmt$(c.lab)}</td>`).join('')}</tr>
                    <tr><td>Monthly Expenses</td>${cols.map(c=>`<td class="report-num">${c.exp>0?fmt$(c.exp):'—'}</td>`).join('')}</tr>
                    <tr class="report-total-row"><td>Monthly Net</td>${cols.map(c=>`<td class="report-num" style="${c.net<0?'color:#dc2626':''}">${fmt$(c.net)}</td>`).join('')}</tr>
                    <tr><td>Annual Net</td>${cols.map(c=>`<td class="report-num">${fmt$(c.net*12)}</td>`).join('')}</tr>
                    <tr><td>Margin %</td>${cols.map(c=>`<td class="report-num">${fmtPct(c.pct)}</td>`).join('')}</tr>
                </tbody>
            </table>
            </div>
            <p style="font-size:.8em;color:#6b7280;margin-top:.5rem">
                Revenue baseline uses the same calculation as the Financial Dashboard (${lastN.map(m => FIN_MONTH_SHORT[parseInt(m.key.split('-')[1])-1]).reverse().join(', ')}).
                Enrollment impact uses each room's actual avg days/child from registration history.
                ${avgHourlyRate > 0 ? `Staff cost: $${Math.round(avgHourlyRate)}/hr avg × 160 hrs/mo.` : 'Add staff hourly rates to include staffing cost.'}
            </p>`;

    } catch (e) {
        container.innerHTML = `<p class="import-error">Error: ${escHtml(e.message)}</p>`;
    }
}

// Estimate additional monthly labor cost from an hourly wage increase
// Uses allStaffData if available, otherwise falls back to a rough ratio
function _estimateHourlyWageImpact(wageIncPerHr) {
    const staff = (typeof allStaffData !== 'undefined' ? allStaffData : [])
        .filter(s => s.pay_type !== 'salary' && s.active);
    if (!staff.length) return 0;
    // Assume ~160 hours/month per FTE (biweekly 80hr periods × 2)
    return staff.length * 160 * wageIncPerHr;
}
