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
function _financeMonth() {
    return document.getElementById('financeMonth')?.value || '';
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
    const year  = _financeYear();
    const month = _financeMonth();
    const container = document.getElementById('financeDashContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';

    if (month) {
        await _generateMonthDetail(year, month, container);
        return;
    }

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
            const exp  = _monthlyExpenseBurden(moNum, lab, rev);
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

// ── Single-Month Detail View ──────────────────────────────────
async function _generateMonthDetail(year, month, container) {
    const mo       = `${year}-${month}`;
    const fromDate = `${mo}-01`;
    const lastDay  = new Date(year, parseInt(month), 0).getDate();
    const toDate   = `${mo}-${String(lastDay).padStart(2, '0')}`;
    const label    = `${['January','February','March','April','May','June','July','August','September','October','November','December'][parseInt(month)-1]} ${year}`;

    try {
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

        const pnl = await _buildRoomPnlData(fromDate, toDate, { skipHistoricalOverride: true });
        const moData = pnl.data[mo] || {};

        // When no room-level schedules are saved, labor is a center-wide total, not per-room.
        const centerLab = pnl.hasFallbackLabor ? (pnl.centerLaborByMonth?.[mo] || 0) : 0;
        const laborNote = pnl.hasFallbackLabor && centerLab > 0
            ? `<p style="margin:.5rem 0 1rem;font-size:.85em;color:#92400e">⚠ No room schedules saved — labor total is center-wide and cannot be split by room.</p>`
            : (!pnl.hasFallbackLabor && !pnl.hasScheduleData
                ? `<p style="margin:.5rem 0 1rem;font-size:.85em;color:#6b7280">No payroll data found for this period — labor shows as $0.</p>`
                : '');

        let totalRev = 0, totalLab = centerLab, totalFull = 0, totalHalf = 0;
        const activeRoomIds = new Set([...Object.keys(roomRevMap), ...Object.keys(moData)]);
        const roomRows = ROOMS.filter(r => activeRoomIds.has(r.id)).map(r => {
            const rev  = roomRevMap[r.id]?.revenue  || 0;
            const full = roomRevMap[r.id]?.fullDays || 0;
            const half = roomRevMap[r.id]?.halfDays || 0;
            const lab  = pnl.hasFallbackLabor ? 0 : (moData[r.id]?.labor || 0);
            totalRev  += rev;
            if (!pnl.hasFallbackLabor) totalLab += lab;
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

        const roomRowsHtml = roomRows.map(r => {
            const net = r.revenue - r.labor;
            return `<tr>
                <td>${escHtml(r.label)}</td>
                <td class="report-num">${r.fullDays || '—'}</td>
                <td class="report-num">${r.halfDays || '—'}</td>
                <td class="report-num report-revenue">${_fmt$(r.revenue)}</td>
                <td class="report-num">${r.labor > 0 ? _fmt$(r.labor) : (pnl.hasFallbackLabor ? '—' : _fmt$(0))}</td>
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
                    <span class="fin-kpi-value ${labPct <= 70 ? 'fin-positive' : 'fin-negative'}">
                        ${totalRev > 0 ? labPct.toFixed(1) + '%' : '—'}
                        <span class="fin-kpi-target">target ≤ 70%</span>
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
                ? `Annual — ${MONTH_NAMES_FIN[(item.month || 1) - 1]}`
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
// Uses actual per-room revenue from _buildRoomPnlData() and
// real enrollment counts from fetchRegistrationDatesForRange().
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
    // Include current month + up to 3 prior; skip months with no revenue; use max 3
    const candidateMonths = [];
    for (let i = 0; i <= 3; i++) {
        const d     = new Date(today.getFullYear(), today.getMonth() - i, 1);
        const moKey = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
        const end   = i === 0 ? today : new Date(d.getFullYear(), d.getMonth()+1, 0);
        candidateMonths.push({ key: moKey, start: `${moKey}-01`, end: end.toISOString().split('T')[0] });
    }
    const fromDate = candidateMonths[candidateMonths.length-1].start;
    const toDate   = candidateMonths[0].end;

    await loadRateSettings();

    const [pnlData, allBilling, enrollByRoom, allStaff] = await Promise.all([
        _buildRoomPnlData(fromDate, toDate),
        fetchBillingSummary(),
        fetchConfirmedEnrollmentByRoom(),
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
    const last3 = candidateMonths
        .filter(m => (totalRevByMonth[m.key] || 0) > 0)
        .slice(0, 3);

    if (!last3.length) {
        _roomModelData = { roomData: {}, last3: [], pnlData, centerAvgDaysPerFull: 18, centerAvgDaysPerHalf: 14, avgHourlyRate: 0 };
        return _roomModelData;
    }

    // Filter billing summary to our months
    const recentBilling = allBilling.filter(b =>
        last3.some(m => (b.month || '').substring(0, 7) === m.key)
    );

    const n = last3.length;
    const activeRooms = ROOMS.filter(r => r.status === 'active' || r.status === 'coming_soon');
    const SCHOOL_DAYS = 21; // avg billable days per month — used when no better data
    const roomData = {};

    activeRooms.forEach(r => {
        const billingRows = recentBilling.filter(b => b.room_id === r.id);

        // Revenue avg from PnL
        const avgNetBilled = last3.reduce((s, m) =>
            s + (roomRevByMonth[r.id]?.[m.key] || 0), 0) / n;

        // Child-days from billing_summary (total per room per month)
        const avgFullChildDays = billingRows.reduce((s, b) => s + (b.full_days || 0), 0) / n;
        const avgHalfChildDays = billingRows.reduce((s, b) => s + (b.half_days || 0), 0) / n;

        // Enrollment from confirmed registrations (current snapshot)
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

    _roomModelData = { roomData, last3, pnlData, centerAvgDaysPerFull, centerAvgDaysPerHalf, avgHourlyRate };
    return _roomModelData;
}

async function renderRoomRateGrid() {
    const grid = document.getElementById('modelRoomGrid');
    if (!grid) return;
    grid.innerHTML = '<p class="empty-hint">Loading room data…</p>';

    try {
        const { roomData } = await _buildRoomModelData();
        const activeRooms = ROOMS.filter(r => r.status === 'active' || r.status === 'coming_soon');
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
                <td class="report-num" style="${slotsStyle}">${rd.availableSlots > 0 ? rd.availableSlots : 'Full'}</td>
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
                    ▸ Current Room Utilization (last 3 months)
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
        const { roomData, last3, pnlData, centerAvgDaysPerFull, centerAvgDaysPerHalf, avgHourlyRate } = _roomModelData;

        // Collect per-room inputs
        const roomInputs = {};
        document.querySelectorAll('[data-model-room]').forEach(inp => {
            const roomId = inp.dataset.modelRoom;
            const type   = inp.dataset.modelType;
            if (!roomInputs[roomId]) roomInputs[roomId] = {};
            roomInputs[roomId][type] = parseFloat(inp.value) || 0;
        });

        const activeRooms = ROOMS.filter(r => r.status === 'active' || r.status === 'coming_soon');
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
                Revenue baseline uses the same calculation as the Financial Dashboard (${last3.map(m => FIN_MONTH_SHORT[parseInt(m.key.split('-')[1])-1]).reverse().join(', ')}).
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
