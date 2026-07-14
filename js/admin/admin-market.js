// ============================================================
// MODULE: Admin Market Analysis (comparable providers + board figures)
// ============================================================

let _marketLoaded = false;
let _marketProviders = [];
let _marketContext = {};
let _marketShowInactive = false;
let _marketEditingProviderId = null;
let _marketCharts = {}; // canvas key -> Chart instance, destroyed before each re-render

// Fixed categorical colors, one per provider_type — pulled from this app's own
// design tokens (css/styles.css), never cycled/reassigned.
const MARKET_COLORS = {
    tlc:    '#01294A', // --navy    (this program — always emphasized)
    church: '#5BAD8B', // --green
    profit: '#F5B731', // --sun
    public: '#7A6E5A', // --text-muted
};
const MARKET_ACCENT = '#E97D55'; // --tang — reference lines/callouts only, never a series

let _marketEditHeroStats = [];
let _marketEditWageRows  = [];

async function initMarketTab() {
    _wireMarketProviders();
    _wireMarketContext();
    document.getElementById('marketRefreshBtn')?.addEventListener('click', _reloadMarketData);
    await _reloadMarketData();
}

function _marketCloseModal(id) {
    document.getElementById(id)?.classList.add('hidden');
}

function _marketProviderColor(p) {
    return MARKET_COLORS[p.provider_type] || MARKET_COLORS.public;
}

/** Light -> dark, interpolated between this app's --green-lt and --green-dark tokens. */
function _marketGreenRamp(n) {
    const light = [201, 230, 220]; // #C9E6DC
    const dark  = [26, 92, 62];    // #1a5c3e
    const steps = [];
    for (let i = 0; i < n; i++) {
        const t = n === 1 ? 0 : i / (n - 1);
        const rgb = light.map((c, idx) => Math.round(c + (dark[idx] - c) * t));
        steps.push(`rgb(${rgb.join(',')})`);
    }
    return steps;
}

function _destroyMarketChart(key) {
    if (_marketCharts[key]) { _marketCharts[key].destroy(); delete _marketCharts[key]; }
}

async function _reloadMarketData() {
    _marketProviders = await fetchMarketProviders(_marketShowInactive);
    _marketContext   = await fetchMarketContext();
    _renderMarketHeroStats();
    _renderMarketTypeLegend();
    _renderMarketPositionChart();
    _renderMarketRateChart();
    _renderMarketRegFeeChart();
    _renderMarketInfantCostChart();
    _renderMarketWageChart();
    _renderMarketProvidersTable();
}

// ============================================================
// HERO STATS / LEGEND (read-only render)
// ============================================================
function _renderMarketHeroStats() {
    const el = document.getElementById('marketHeroStats');
    if (!el) return;
    const stats = _marketContext.heroStats || [];
    el.innerHTML = stats.map(s => `
        <div class="market-hero-stat">
            <div class="market-hero-num">${escHtml(s.num)}<span>${escHtml(s.suffix || '')}</span></div>
            <div class="market-hero-label">${escHtml(s.label)}</div>
        </div>`).join('');
    document.getElementById('marketPositioningNote').textContent = _marketContext.positioningNote || '';
}

function _renderMarketTypeLegend() {
    const el = document.getElementById('marketTypeLegend');
    if (!el) return;
    el.innerHTML = MARKET_PROVIDER_TYPES.map(t => `
        <span><span class="swatch" style="background:${MARKET_COLORS[t.id]}"></span>${escHtml(t.label)}</span>
    `).join('');
}

// ============================================================
// CHARTS
// ============================================================
function _renderMarketPositionChart() {
    const canvas = document.getElementById('marketPositionChart');
    if (!canvas || typeof Chart === 'undefined') return;
    _destroyMarketChart('position');

    const datasets = _marketProviders.map(p => ({
        label: p.name,
        data: [{ x: Number(p.flexibility_score) || 0, y: Number(p.age_range_score) || 0 }],
        backgroundColor: _marketProviderColor(p),
        borderColor: p.is_own_program ? MARKET_COLORS.tlc : _marketProviderColor(p),
        borderWidth: p.is_own_program ? 2 : 0,
        pointRadius: p.is_own_program ? 11 : 7,
        pointHoverRadius: p.is_own_program ? 13 : 9,
    }));

    _marketCharts.position = new Chart(canvas, {
        type: 'scatter',
        data: { datasets },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                x: { min: 0, max: 11, title: { display: true, text: 'Scheduling flexibility  →  fixed full-week  to  day-by-day' } },
                y: { min: 0, max: 11, title: { display: true, text: 'Age range  →  preschool-only  to  birth-through-pre-K' } },
            },
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => ctx.dataset.label } },
            },
        },
        plugins: [{
            id: 'marketLabels',
            afterDatasetsDraw(chart) {
                const { ctx } = chart;
                chart.data.datasets.forEach((ds, i) => {
                    const meta = chart.getDatasetMeta(i);
                    const pt = meta.data[0];
                    if (!pt) return;
                    ctx.save();
                    ctx.font = '600 11px sans-serif';
                    ctx.fillStyle = '#5B6472';
                    ctx.textAlign = pt.x > chart.chartArea.right - 130 ? 'right' : 'left';
                    const offset = pt.x > chart.chartArea.right - 130 ? -10 : 10;
                    ctx.fillText(ds.label, pt.x + offset, pt.y - 10);
                    ctx.restore();
                });
            },
        }],
    });
}

function _renderMarketRateChart() {
    const canvas = document.getElementById('marketRateChart');
    if (!canvas || typeof Chart === 'undefined') return;
    _destroyMarketChart('rate');

    const rows = _marketProviders
        .filter(p => p.rate_low != null && p.rate_high != null)
        .sort((a, b) => Number(a.rate_low) - Number(b.rate_low));

    _marketCharts.rate = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: rows.map(p => p.name),
            datasets: [{
                label: 'Weekly-equivalent rate range ($)',
                data: rows.map(p => [Number(p.rate_low), Number(p.rate_high)]),
                backgroundColor: rows.map(_marketProviderColor),
                borderRadius: 2,
            }],
        },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
            scales: {
                x: { title: { display: true, text: 'Approx. $ per week' } },
                y: { ticks: { font: { size: 11 } } },
            },
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => {
                    const v = ctx.raw;
                    return v[0] === v[1] ? `$${v[0]}/wk` : `$${v[0]}–$${v[1]}/wk`;
                } } },
            },
        },
    });
}

function _renderMarketRegFeeChart() {
    const canvas = document.getElementById('marketRegFeeChart');
    if (!canvas || typeof Chart === 'undefined') return;
    _destroyMarketChart('regfee');

    const rows = _marketProviders
        .filter(p => p.reg_fee_low != null)
        .map(p => ({ ...p, mid: (Number(p.reg_fee_low) + Number(p.reg_fee_high ?? p.reg_fee_low)) / 2 }))
        .sort((a, b) => a.mid - b.mid);

    _marketCharts.regfee = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: rows.map(p => p.name),
            datasets: [{
                data: rows.map(p => p.mid),
                backgroundColor: rows.map(_marketProviderColor),
                borderRadius: 3,
            }],
        },
        options: {
            responsive: true, maintainAspectRatio: false,
            scales: {
                y: { title: { display: true, text: '$' } },
                x: { ticks: { font: { size: 10 }, maxRotation: 40, minRotation: 40 } },
            },
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => {
                    const p = rows[ctx.dataIndex];
                    return (p.reg_fee_high != null && p.reg_fee_high !== p.reg_fee_low)
                        ? `$${p.reg_fee_low}–$${p.reg_fee_high}` : `$${p.reg_fee_low}`;
                } } },
            },
        },
    });
}

function _renderMarketInfantCostChart() {
    const canvas = document.getElementById('marketInfantCostChart');
    if (!canvas || typeof Chart === 'undefined') return;
    _destroyMarketChart('infant');
    const ic = _marketContext.infantCost || {};
    document.getElementById('marketInfantCostSource').textContent = ic.source || '';

    _marketCharts.infant = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: ['Infant care', 'Preschool care'],
            datasets: [{
                data: [Number(ic.infantAnnual) || 0, Number(ic.preschoolAnnual) || 0],
                backgroundColor: [MARKET_COLORS.tlc, MARKET_COLORS.church],
                borderRadius: 4,
                barThickness: 44,
            }],
        },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
            scales: { x: { title: { display: true, text: 'Annual cost to provide ($, Missouri)' } } },
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => `$${ctx.raw.toLocaleString()}/year` } },
            },
        },
    });
}

function _renderMarketWageChart() {
    const canvas = document.getElementById('marketWageChart');
    if (!canvas || typeof Chart === 'undefined') return;
    _destroyMarketChart('wage');
    const roles   = _marketContext.wageLadder || [];
    const minWage = Number(_marketContext.minWage) || 0;
    document.getElementById('marketWageSource').textContent = _marketContext.wageSource || '';

    _marketCharts.wage = new Chart(canvas, {
        type: 'bar',
        data: {
            labels: roles.map(r => r.role),
            datasets: [{
                data: roles.map(r => [Number(r.low), Number(r.high)]),
                backgroundColor: _marketGreenRamp(roles.length || 1),
                borderRadius: 3,
                barThickness: 18,
            }],
        },
        options: {
            indexAxis: 'y',
            responsive: true, maintainAspectRatio: false,
            scales: { x: { title: { display: true, text: '$ per hour' }, min: 10 } },
            plugins: {
                legend: { display: false },
                tooltip: { callbacks: { label: ctx => { const v = ctx.raw; return `$${v[0]}–$${v[1]}/hr`; } } },
            },
        },
        plugins: [{
            id: 'marketMinWageLine',
            afterDraw(chart) {
                if (!minWage) return;
                const { ctx, scales: { x, y } } = chart;
                const xPos = x.getPixelForValue(minWage);
                ctx.save();
                ctx.strokeStyle = MARKET_ACCENT;
                ctx.setLineDash([4, 3]);
                ctx.lineWidth = 1.5;
                ctx.beginPath();
                ctx.moveTo(xPos, y.top);
                ctx.lineTo(xPos, y.bottom);
                ctx.stroke();
                ctx.setLineDash([]);
                ctx.fillStyle = MARKET_ACCENT;
                ctx.font = '600 10px sans-serif';
                ctx.fillText(`MO min. wage $${minWage.toFixed(2)}`, xPos + 4, y.top + 10);
                ctx.restore();
            },
        }],
    });
}

// ============================================================
// COMPARABLE PROVIDERS TABLE + CRUD
// ============================================================
function _wireMarketProviders() {
    document.getElementById('marketAddProviderBtn')?.addEventListener('click', () => _openMarketProviderModal(null));
    document.getElementById('marketToggleInactiveBtn')?.addEventListener('click', async () => {
        _marketShowInactive = !_marketShowInactive;
        document.getElementById('marketToggleInactiveBtn').textContent = _marketShowInactive ? 'Hide Archived' : 'Show Archived';
        _marketProviders = await fetchMarketProviders(_marketShowInactive);
        _renderMarketProvidersTable();
    });
    document.getElementById('mpmCancelBtn')?.addEventListener('click', () => _marketCloseModal('marketProviderModal'));
    document.getElementById('mpmCloseBtn')?.addEventListener('click', () => _marketCloseModal('marketProviderModal'));
    document.getElementById('mpmSaveBtn')?.addEventListener('click', _saveMarketProvider);
    document.getElementById('mpmArchiveBtn')?.addEventListener('click', _archiveMarketProvider);
}

function _renderMarketProvidersTable() {
    const wrap = document.getElementById('marketProvidersTableWrap');
    if (!wrap) return;
    wrap.innerHTML = `
        <table class="rates-table">
            <thead><tr><th>Provider</th><th>Type</th><th>Ages</th><th>Reg. Fee</th><th>Rate</th><th>Flexible?</th><th></th></tr></thead>
            <tbody>
                ${_marketProviders.map(p => `
                    <tr ${p.is_own_program ? 'class="highlight-row"' : ''} style="${p.active === false ? 'opacity:.5' : ''}">
                        <td><strong>${escHtml(p.name)}</strong></td>
                        <td><span class="tag ${p.provider_type}">${escHtml(MARKET_PROVIDER_TYPES.find(t => t.id === p.provider_type)?.label || p.provider_type)}</span></td>
                        <td>${escHtml(p.ages_text || '—')}</td>
                        <td>${p.reg_fee_low != null ? '$' + p.reg_fee_low + (p.reg_fee_high != null && p.reg_fee_high !== p.reg_fee_low ? '–$' + p.reg_fee_high : '') : '—'}</td>
                        <td>${p.rate_low != null ? '$' + p.rate_low + (p.rate_high != null && p.rate_high !== p.rate_low ? '–$' + p.rate_high : '') + '/wk' : '—'}</td>
                        <td>${escHtml(p.flexible_text || '—')}</td>
                        <td><button type="button" class="btn-ghost market-edit-provider-btn" data-id="${p.id}">Edit</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>`;
    wrap.querySelectorAll('.market-edit-provider-btn').forEach(btn => {
        btn.addEventListener('click', () => _openMarketProviderModal(btn.dataset.id));
    });
}

function _openMarketProviderModal(id) {
    _marketEditingProviderId = id || null;
    const p = id ? _marketProviders.find(x => x.id === id) : null;
    document.getElementById('mpmTitle').textContent = p ? 'Edit Provider' : 'Add Provider';
    document.getElementById('mpmName').value = p?.name || '';
    document.getElementById('mpmType').value = p?.provider_type || 'church';
    document.getElementById('mpmAges').value = p?.ages_text || '';
    document.getElementById('mpmFlexibleText').value = p?.flexible_text || '';
    document.getElementById('mpmFlexScore').value = p?.flexibility_score ?? '';
    document.getElementById('mpmAgeScore').value = p?.age_range_score ?? '';
    document.getElementById('mpmRegFeeLow').value = p?.reg_fee_low ?? '';
    document.getElementById('mpmRegFeeHigh').value = p?.reg_fee_high ?? '';
    document.getElementById('mpmRateLow').value = p?.rate_low ?? '';
    document.getElementById('mpmRateHigh').value = p?.rate_high ?? '';
    document.getElementById('mpmNotes').value = p?.notes || '';

    const archiveBtn = document.getElementById('mpmArchiveBtn');
    if (p && !p.is_own_program) {
        archiveBtn.classList.remove('hidden');
        archiveBtn.textContent = p.active === false ? 'Restore' : 'Archive';
    } else {
        archiveBtn.classList.add('hidden');
    }
    document.getElementById('marketProviderModal').classList.remove('hidden');
}

async function _saveMarketProvider() {
    const name = document.getElementById('mpmName').value.trim();
    if (!name) { alert('Provider name is required.'); return; }

    const numOrNull = id => { const v = document.getElementById(id).value; return v === '' ? null : Number(v); };
    const fields = {
        name,
        provider_type:     document.getElementById('mpmType').value,
        ages_text:         document.getElementById('mpmAges').value.trim(),
        flexible_text:     document.getElementById('mpmFlexibleText').value.trim(),
        flexibility_score: Number(document.getElementById('mpmFlexScore').value) || 0,
        age_range_score:   Number(document.getElementById('mpmAgeScore').value) || 0,
        reg_fee_low:       numOrNull('mpmRegFeeLow'),
        reg_fee_high:      numOrNull('mpmRegFeeHigh'),
        rate_low:          numOrNull('mpmRateLow'),
        rate_high:         numOrNull('mpmRateHigh'),
        notes:             document.getElementById('mpmNotes').value.trim(),
    };

    const btn = document.getElementById('mpmSaveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        if (_marketEditingProviderId) {
            await updateMarketProvider(_marketEditingProviderId, fields);
        } else {
            await insertMarketProvider({ ...fields, sort_order: _marketProviders.length });
        }
        _marketCloseModal('marketProviderModal');
        await _reloadMarketData();
    } catch (err) {
        alert('Error saving provider: ' + err.message);
    } finally {
        btn.disabled = false; btn.textContent = 'Save Provider';
    }
}

async function _archiveMarketProvider() {
    if (!_marketEditingProviderId) return;
    const p = _marketProviders.find(x => x.id === _marketEditingProviderId);
    if (!p) return;
    try {
        await archiveMarketProvider(_marketEditingProviderId, p.active === false);
        _marketCloseModal('marketProviderModal');
        await _reloadMarketData();
    } catch (err) {
        alert('Error: ' + err.message);
    }
}

// ============================================================
// STATS & FIGURES (context settings) MODAL
// ============================================================
function _wireMarketContext() {
    document.getElementById('marketEditContextBtn')?.addEventListener('click', _openMarketContextModal);
    document.getElementById('mcmCancelBtn')?.addEventListener('click', () => _marketCloseModal('marketContextModal'));
    document.getElementById('mcmCloseBtn')?.addEventListener('click', () => _marketCloseModal('marketContextModal'));
    document.getElementById('mcmSaveBtn')?.addEventListener('click', _saveMarketContext);
    document.getElementById('mcmAddHeroStatBtn')?.addEventListener('click', () => {
        _marketEditHeroStats.push({ num: '', suffix: '', label: '' });
        _renderMcmHeroStatsRows();
    });
    document.getElementById('mcmAddWageBtn')?.addEventListener('click', () => {
        _marketEditWageRows.push({ role: '', low: '', high: '' });
        _renderMcmWageRows();
    });
}

function _wireMcmRowRemoval(wrap, arr, rerender) {
    wrap.querySelectorAll('.mcm-remove-row').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = Number(btn.closest('[data-idx]').dataset.idx);
            arr.splice(idx, 1);
            rerender();
        });
    });
}

function _renderMcmHeroStatsRows() {
    const wrap = document.getElementById('mcmHeroStatsRows');
    wrap.innerHTML = _marketEditHeroStats.map((s, i) => `
        <div class="fm-row" data-idx="${i}">
            <div class="fm-field" style="max-width:80px"><label>Number</label><input type="text" class="mcm-hs-num" value="${escHtml(s.num || '')}"></div>
            <div class="fm-field" style="max-width:80px"><label>Suffix</label><input type="text" class="mcm-hs-suffix" value="${escHtml(s.suffix || '')}"></div>
            <div class="fm-field fm-field-grow"><label>Label</label><input type="text" class="mcm-hs-label" value="${escHtml(s.label || '')}"></div>
            <button type="button" class="btn-ghost mcm-remove-row" style="align-self:flex-end">&#10005;</button>
        </div>`).join('');
    _wireMcmRowRemoval(wrap, _marketEditHeroStats, _renderMcmHeroStatsRows);
}

function _renderMcmWageRows() {
    const wrap = document.getElementById('mcmWageRows');
    wrap.innerHTML = _marketEditWageRows.map((r, i) => `
        <div class="fm-row" data-idx="${i}">
            <div class="fm-field fm-field-grow"><label>Role</label><input type="text" class="mcm-wage-role" value="${escHtml(r.role || '')}"></div>
            <div class="fm-field" style="max-width:90px"><label>Low ($/hr)</label><input type="number" step="0.01" class="mcm-wage-low" value="${r.low ?? ''}"></div>
            <div class="fm-field" style="max-width:90px"><label>High ($/hr)</label><input type="number" step="0.01" class="mcm-wage-high" value="${r.high ?? ''}"></div>
            <button type="button" class="btn-ghost mcm-remove-row" style="align-self:flex-end">&#10005;</button>
        </div>`).join('');
    _wireMcmRowRemoval(wrap, _marketEditWageRows, _renderMcmWageRows);
}

function _openMarketContextModal() {
    document.getElementById('mcmPositioningNote').value  = _marketContext.positioningNote || '';
    document.getElementById('mcmInfantAnnual').value     = _marketContext.infantCost?.infantAnnual ?? '';
    document.getElementById('mcmPreschoolAnnual').value  = _marketContext.infantCost?.preschoolAnnual ?? '';
    document.getElementById('mcmInfantCostSource').value = _marketContext.infantCost?.source || '';
    document.getElementById('mcmMinWage').value           = _marketContext.minWage ?? '';
    document.getElementById('mcmWageSource').value        = _marketContext.wageSource || '';

    _marketEditHeroStats = JSON.parse(JSON.stringify(_marketContext.heroStats || []));
    _marketEditWageRows  = JSON.parse(JSON.stringify(_marketContext.wageLadder || []));
    _renderMcmHeroStatsRows();
    _renderMcmWageRows();
    document.getElementById('marketContextModal').classList.remove('hidden');
}

async function _saveMarketContext() {
    const heroStats = Array.from(document.querySelectorAll('#mcmHeroStatsRows .fm-row')).map(row => ({
        num:    row.querySelector('.mcm-hs-num').value.trim(),
        suffix: row.querySelector('.mcm-hs-suffix').value.trim(),
        label:  row.querySelector('.mcm-hs-label').value.trim(),
    })).filter(s => s.num || s.label);

    const wageLadder = Array.from(document.querySelectorAll('#mcmWageRows .fm-row')).map(row => ({
        role: row.querySelector('.mcm-wage-role').value.trim(),
        low:  Number(row.querySelector('.mcm-wage-low').value) || 0,
        high: Number(row.querySelector('.mcm-wage-high').value) || 0,
    })).filter(r => r.role);

    const context = {
        heroStats,
        positioningNote: document.getElementById('mcmPositioningNote').value.trim(),
        infantCost: {
            infantAnnual:    Number(document.getElementById('mcmInfantAnnual').value) || 0,
            preschoolAnnual: Number(document.getElementById('mcmPreschoolAnnual').value) || 0,
            source:          document.getElementById('mcmInfantCostSource').value.trim(),
        },
        wageLadder,
        minWage:     Number(document.getElementById('mcmMinWage').value) || 0,
        wageSource:  document.getElementById('mcmWageSource').value.trim(),
    };

    const btn = document.getElementById('mcmSaveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        await saveMarketContext(context);
        _marketContext = context;
        _marketCloseModal('marketContextModal');
        _renderMarketHeroStats();
        _renderMarketTypeLegend();
        _renderMarketPositionChart();
        _renderMarketInfantCostChart();
        _renderMarketWageChart();
    } catch (err) {
        alert('Error saving: ' + err.message);
    } finally {
        btn.disabled = false; btn.textContent = 'Save';
    }
}
