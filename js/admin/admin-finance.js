// ============================================================
// FINANCE DASHBOARD
// Charts and financial analytics for Full Access users.
// Reuses _buildRoomPnlData() from admin-reports.js.
// ============================================================

let _financeCharts = {}; // Chart instances — destroy before re-rendering

function setupFinanceDashboard() {
    document.getElementById('generateFinanceBtn')
        ?.addEventListener('click', generateFinanceDashboard);
    document.getElementById('generateYoyBtn')
        ?.addEventListener('click', generateYoyComparison);

    setupExpenseLines();
    setupModelingTool();

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
}

function _destroyChart(key) {
    if (_financeCharts[key]) { _financeCharts[key].destroy(); delete _financeCharts[key]; }
}

function _financeYear() {
    return parseInt(document.getElementById('financeYear')?.value || new Date().getFullYear());
}

// ── Helpers ──────────────────────────────────────────────────
const FIN_MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

function _moRev(pnl, mo) {
    return Object.values(pnl.data[mo] || {}).reduce((s, r) => s + (r.revenue || 0), 0);
}
function _moLab(pnl, mo) {
    if (pnl.hasFallbackLabor) return pnl.centerLaborByMonth[mo] || 0;
    return Object.values(pnl.data[mo] || {}).reduce((s, r) => s + (r.labor || 0), 0);
}
function _fmt$(v) { return '$' + Math.round(v).toLocaleString(); }

// ── Financial Dashboard ───────────────────────────────────────
async function generateFinanceDashboard() {
    const year = _financeYear();
    const container = document.getElementById('financeDashContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        // Ensure expense config is loaded before rendering KPIs
        if (!_expenseConfig) {
            _expenseConfig = await fetchExpenseConfig();
        }

        const pnl = await _buildRoomPnlData(`${year}-01-01`, `${year}-12-31`);
        const { months } = pnl;

        if (!months.length) {
            container.innerHTML = '<p class="empty-hint">No data found for this year.</p>';
            return;
        }

        let totalRev = 0, totalLab = 0, totalExp = 0;
        const moRevArr = [], moLabArr = [], moExpArr = [], moNetArr = [], moLabPctArr = [], moLabels = [];

        months.forEach(mo => {
            const rev  = _moRev(pnl, mo);
            const lab  = _moLab(pnl, mo);
            const moNum = parseInt(mo.split('-')[1]);
            const exp  = _monthlyExpenseBurden(moNum);
            totalRev += rev;
            totalLab += lab;
            totalExp += exp;
            moRevArr.push(Math.round(rev));
            moLabArr.push(Math.round(lab));
            moExpArr.push(Math.round(exp));
            moNetArr.push(Math.round(rev - lab - exp));
            moLabPctArr.push(rev > 0 ? parseFloat((lab / rev * 100).toFixed(1)) : 0);
            moLabels.push(FIN_MONTH_SHORT[moNum - 1]);
        });

        const hasExpenses = totalExp > 0;
        const totalMargin    = totalRev - totalLab - totalExp;
        const totalMarginPct = totalRev > 0 ? (totalMargin / totalRev * 100) : 0;
        const marginClass    = totalMarginPct >= 30 ? 'fin-positive' : totalMarginPct >= 15 ? 'fin-warn' : 'fin-negative';
        const labPct         = totalRev > 0 ? totalLab / totalRev * 100 : 0;

        container.innerHTML = `
            <div class="fin-kpi-row">
                <div class="fin-kpi">
                    <span class="fin-kpi-label">YTD Revenue</span>
                    <span class="fin-kpi-value fin-positive">${_fmt$(totalRev)}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">YTD Labor</span>
                    <span class="fin-kpi-value">${_fmt$(totalLab)}</span>
                </div>
                ${hasExpenses ? `
                <div class="fin-kpi">
                    <span class="fin-kpi-label">YTD Other Expenses</span>
                    <span class="fin-kpi-value">${_fmt$(totalExp)}</span>
                </div>` : ''}
                <div class="fin-kpi">
                    <span class="fin-kpi-label">YTD Net${hasExpenses ? '' : ' (before expenses)'}</span>
                    <span class="fin-kpi-value ${marginClass}">${_fmt$(totalMargin)}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Net Margin %${hasExpenses ? '' : ' (before expenses)'}</span>
                    <span class="fin-kpi-value ${marginClass}">${totalMarginPct.toFixed(1)}%</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Labor % of Revenue</span>
                    <span class="fin-kpi-value ${labPct <= 70 ? 'fin-positive' : 'fin-negative'}">
                        ${totalRev > 0 ? labPct.toFixed(1) + '%' : '—'}
                        <span class="fin-kpi-target">target ≤ 70%</span>
                    </span>
                </div>
            </div>
            <div class="fin-charts-row">
                <div class="fin-chart-wrap">
                    <h4 class="fin-chart-title">Revenue vs. Labor${hasExpenses ? ' vs. Net' : ''} by Month</h4>
                    <canvas id="chartRevLabor"></canvas>
                </div>
                <div class="fin-chart-wrap">
                    <h4 class="fin-chart-title">Labor as % of Revenue</h4>
                    <canvas id="chartLaborPct"></canvas>
                </div>
            </div>`;

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

        // Labor % line chart with 70% target line
        _destroyChart('laborPct');
        _financeCharts.laborPct = new Chart(
            document.getElementById('chartLaborPct').getContext('2d'), {
                type: 'line',
                data: {
                    labels: moLabels,
                    datasets: [
                        { label: 'Labor %', data: moLabPctArr,
                          borderColor: 'rgb(245,158,11)', backgroundColor: 'rgba(245,158,11,.12)',
                          tension: 0.3, fill: true, pointBackgroundColor: 'rgb(245,158,11)' },
                        { label: '70% Target', data: moLabels.map(() => 70),
                          borderColor: 'rgba(239,68,68,.55)', borderDash: [6,3],
                          pointRadius: 0, fill: false },
                    ],
                },
                options: {
                    responsive: true,
                    plugins: { legend: { position: 'top' } },
                    scales: { y: { beginAtZero: true, max: 105, ticks: { callback: v => v + '%' } } },
                },
            }
        );

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
const MONTH_NAMES_FIN = ['January','February','March','April','May','June',
                         'July','August','September','October','November','December'];
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
        ?.addEventListener('change', _toggleExpenseMonth);
    loadExpenseLines();
}

function _toggleExpenseMonth() {
    const type = document.getElementById('expenseTypeInput')?.value;
    const wrap = document.getElementById('expenseMonthWrap');
    if (wrap) wrap.style.display = type === 'annual' ? '' : 'none';
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
                ? `Annual — ${MONTH_NAMES_FIN[(item.month || 1) - 1]}`
                : 'Monthly'}</td>
            <td class="report-num">${item.amount < 0 ? '-' : ''}$${Math.abs(parseFloat(item.amount)||0).toLocaleString(undefined,{minimumFractionDigits:2,maximumFractionDigits:2})}</td>
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
    _toggleExpenseMonth();
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
function _monthlyExpenseBurden(moNum) {
    const items = _expenseConfig?.items || [];
    const fixed   = items.filter(i => i.type === 'monthly').reduce((s, i) => s + (parseFloat(i.amount)||0), 0);
    const oneTime = items.filter(i => i.type === 'annual' && (i.month||1) === moNum)
                         .reduce((s, i) => s + (parseFloat(i.amount)||0), 0);
    return fixed + oneTime;
}

// ============================================================
// RATE / WAGE MODELING TOOL
// ============================================================
function setupModelingTool() {
    document.getElementById('runModelBtn')
        ?.addEventListener('click', runFinanceModel);
}

async function runFinanceModel() {
    const rateInc  = parseFloat(document.getElementById('modelRateInc')?.value  || 0) / 100;
    const wageInc  = parseFloat(document.getElementById('modelWageInc')?.value  || 0);
    const salInc   = parseFloat(document.getElementById('modelSalInc')?.value   || 0) / 100;
    const container = document.getElementById('modelResults');
    container.innerHTML = '<p class="empty-hint">Calculating…</p>';

    try {
        const year = _financeYear();
        // Use most recent 3 complete months as baseline for per-month averages
        const toDate   = new Date(); toDate.setDate(0); // last day of previous month
        const fromDate = new Date(toDate); fromDate.setMonth(fromDate.getMonth() - 2); fromDate.setDate(1);
        const fmt = d => d.toISOString().split('T')[0];

        const pnl = await _buildRoomPnlData(fmt(fromDate), fmt(toDate));
        const { months } = pnl;

        if (!months.length) {
            container.innerHTML = '<p class="empty-hint">No recent data to model from. Generate the dashboard first.</p>';
            return;
        }

        // Average monthly revenue and labor over the baseline period
        let sumRev = 0, sumLab = 0;
        months.forEach(mo => {
            sumRev += Object.values(pnl.data[mo]||{}).reduce((s,r)=>s+(r.revenue||0),0);
            sumLab += pnl.hasFallbackLabor ? (pnl.centerLaborByMonth[mo]||0)
                    : Object.values(pnl.data[mo]||{}).reduce((s,r)=>s+(r.labor||0),0);
        });
        const baseRev = sumRev / months.length;
        const baseLab = sumLab / months.length;

        // Apply increases
        const projRev   = baseRev * (1 + rateInc);
        const projLab   = baseLab + (baseLab * salInc) + (wageInc > 0 ? _estimateHourlyWageImpact(wageInc) : 0);

        // Monthly expenses (use average across months)
        const avgExpenses = months.reduce((s, mo) => s + _monthlyExpenseBurden(parseInt(mo.split('-')[1])), 0) / months.length;

        const scenarios = [
            { label: 'Current',            rev: baseRev, lab: baseLab },
            { label: `+${(rateInc*100).toFixed(1)}% Rates`, rev: projRev, lab: baseLab },
            { label: `+$${wageInc}/hr Wages${salInc>0?` +${(salInc*100).toFixed(0)}% Salary`:''}`,
              rev: baseRev, lab: projLab },
            { label: 'Both',               rev: projRev, lab: projLab },
        ];

        const fmt$ = v => '$' + Math.round(v).toLocaleString();
        const fmtPct = v => isFinite(v) ? v.toFixed(1)+'%' : '—';

        const cols = scenarios.map(s => {
            const net = s.rev - s.lab - avgExpenses;
            const pct = s.rev > 0 ? (net / s.rev * 100) : 0;
            return { ...s, exp: avgExpenses, net, pct };
        });

        container.innerHTML = `
            <div style="overflow-x:auto">
            <table class="report-table" style="min-width:560px">
                <thead><tr>
                    <th>Metric</th>
                    ${cols.map(c=>`<th class="report-num">${escHtml(c.label)}</th>`).join('')}
                </tr></thead>
                <tbody>
                    <tr><td>Monthly Revenue</td>${cols.map(c=>`<td class="report-num report-revenue">${fmt$(c.rev)}</td>`).join('')}</tr>
                    <tr><td>Monthly Labor</td>${cols.map(c=>`<td class="report-num">${fmt$(c.lab)}</td>`).join('')}</tr>
                    <tr><td>Monthly Expenses</td>${cols.map(c=>`<td class="report-num">${avgExpenses>0?fmt$(c.exp):'—'}</td>`).join('')}</tr>
                    <tr class="report-total-row"><td>Monthly Net</td>${cols.map(c=>`<td class="report-num ${c.net>=0?'report-revenue':''}" style="${c.net<0?'color:#dc2626':''}">${fmt$(c.net)}</td>`).join('')}</tr>
                    <tr><td>Annual Net</td>${cols.map(c=>`<td class="report-num">${fmt$(c.net*12)}</td>`).join('')}</tr>
                    <tr><td>Margin %</td>${cols.map(c=>`<td class="report-num">${fmtPct(c.pct)}</td>`).join('')}</tr>
                </tbody>
            </table>
            </div>
            <p style="font-size:.8em;color:#6b7280;margin-top:.5rem">
                Based on average of ${months.length} month${months.length>1?'s':''} (${months[0]} – ${months[months.length-1]}).
                ${avgExpenses > 0 ? '' : 'Add expense lines above to include fixed costs in the model.'}
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
