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
        const pnl = await _buildRoomPnlData(`${year}-01-01`, `${year}-12-31`);
        const { months } = pnl;

        if (!months.length) {
            container.innerHTML = '<p class="empty-hint">No data found for this year.</p>';
            return;
        }

        let totalRev = 0, totalLab = 0;
        const moRevArr = [], moLabArr = [], moLabPctArr = [], moLabels = [];

        months.forEach(mo => {
            const rev = _moRev(pnl, mo);
            const lab = _moLab(pnl, mo);
            totalRev += rev;
            totalLab += lab;
            moRevArr.push(Math.round(rev));
            moLabArr.push(Math.round(lab));
            moLabPctArr.push(rev > 0 ? parseFloat((lab / rev * 100).toFixed(1)) : 0);
            moLabels.push(FIN_MONTH_SHORT[parseInt(mo.split('-')[1]) - 1]);
        });

        const totalMargin    = totalRev - totalLab;
        const totalMarginPct = totalRev > 0 ? (totalMargin / totalRev * 100) : 0;
        const marginClass    = totalMarginPct >= 30 ? 'fin-positive' : totalMarginPct >= 15 ? 'fin-warn' : 'fin-negative';

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
                <div class="fin-kpi">
                    <span class="fin-kpi-label">YTD Margin</span>
                    <span class="fin-kpi-value ${marginClass}">${_fmt$(totalMargin)}</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Margin %</span>
                    <span class="fin-kpi-value ${marginClass}">${totalMarginPct.toFixed(1)}%</span>
                </div>
                <div class="fin-kpi">
                    <span class="fin-kpi-label">Labor % of Revenue</span>
                    <span class="fin-kpi-value ${totalRev > 0 && (totalLab/totalRev) <= 0.70 ? 'fin-positive' : 'fin-negative'}">
                        ${totalRev > 0 ? (totalLab / totalRev * 100).toFixed(1) + '%' : '—'}
                        <span class="fin-kpi-target">target ≤ 70%</span>
                    </span>
                </div>
            </div>
            <div class="fin-charts-row">
                <div class="fin-chart-wrap">
                    <h4 class="fin-chart-title">Revenue vs. Labor by Month</h4>
                    <canvas id="chartRevLabor"></canvas>
                </div>
                <div class="fin-chart-wrap">
                    <h4 class="fin-chart-title">Labor as % of Revenue</h4>
                    <canvas id="chartLaborPct"></canvas>
                </div>
            </div>`;

        // Revenue vs Labor bar chart
        _destroyChart('revLabor');
        _financeCharts.revLabor = new Chart(
            document.getElementById('chartRevLabor').getContext('2d'), {
                type: 'bar',
                data: {
                    labels: moLabels,
                    datasets: [
                        { label: 'Revenue', data: moRevArr,
                          backgroundColor: 'rgba(22,163,74,.75)', borderColor: 'rgb(22,163,74)', borderWidth: 1 },
                        { label: 'Labor',   data: moLabArr,
                          backgroundColor: 'rgba(245,158,11,.75)', borderColor: 'rgb(245,158,11)', borderWidth: 1 },
                    ],
                },
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
