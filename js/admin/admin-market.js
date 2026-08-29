// ============================================================
// MODULE: Admin Market Analysis (comparable providers + board figures)
// ============================================================

let _marketLoaded = false;
let _marketProviders = [];
let _marketContext = {};
let _marketShowInactive = false;
let _marketEditingProviderId = null;
let _marketEditHeroStats = [];
let _marketEditWageRows  = [];

async function initMarketTab() {
    _wireMarketProviders();
    _wireMarketContext();
    _wireDirectorReportSeg();
    document.getElementById('marketRefreshBtn')?.addEventListener('click', _reloadMarketData);
    await _reloadMarketData();
}

function _marketCloseModal(id) {
    document.getElementById(id)?.classList.add('hidden');
}

async function _reloadMarketData() {
    _marketProviders = await fetchMarketProviders(_marketShowInactive);
    _marketContext   = await fetchMarketContext();
    const synced = document.getElementById('drSyncedNote');
    if (synced) synced.textContent = ` Synced ${new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
    _renderMarketHeroStats();
    _renderMarketPositionList();
    _renderMarketPricingTable();
    _renderMarketCostContext();
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
}

// ============================================================
// DIRECTOR REPORT PANES  (design_handoff_planning_market)
// ============================================================
// The three panes are plain lists/tables, not charts. The columns are
// deliberately the SAME ones _openDirectorReportPacket() already prints —
// Provider/Age range/Schedule, Provider/Weekly rate/Reg. fee, and the cost +
// wage figures — so what a director reads on screen and what she hands the
// board cannot say different things. The old scatter/bar charts are gone; see
// the log entry in CLAUDE.md for what that dropped and what replaced it.

// Flexible / Partial / Set, read from the flexible_text the director already
// types ("Yes — unique", "Partial (choose days)", "No (full-day only)") rather
// than a threshold invented over flexibility_score — the score orders the
// list, the text says what the schedule actually is.
function _marketScheduleKind(p) {
    const t = (p.flexible_text || '').trim();
    if (/^no\b/i.test(t) || t === '') return { key: 'set', label: 'Set' };
    if (/^partial/i.test(t)) return { key: 'partial', label: 'Partial' };
    return { key: 'flexible', label: 'Flexible' };
}

// The detail beside a schedule badge, with the word the badge already shows
// stripped off: "Partial (choose days)" → "choose days", "No" → nothing.
function _marketScheduleDetail(p) {
    const t = (p.flexible_text || '').trim();
    const rest = t.replace(/^(yes|no|partial)\b/i, '').replace(/^[\s—–-]+/, '').trim();
    return rest.replace(/^\((.*)\)$/, '$1');
}

// Our own weekly rate, computed from Settings → Rates rather than typed a
// second time into our own provider row. This program bills by the day, so the
// weekly equivalent is a full day x 5, across the active rooms (Summer Camp is
// seasonal and priced differently, so it is left out of the comparison).
// Returns null if no rate is configured, and a rate typed into the provider
// row always wins over this — see _marketRateCell().
function _marketOwnWeeklyRate() {
    if (typeof ROOMS === 'undefined') return null;
    const rates = ROOMS
        .filter(r => r.status === 'active' && !r.hidden && Number(r.fullDayRate) > 0)
        .map(r => Number(r.fullDayRate) * 5);
    if (!rates.length) return null;
    return { low: Math.min(...rates), high: Math.max(...rates) };
}

// The rate cell for one provider row. Everyone else shows what is on file;
// our own row falls back to the computed figure above when nothing is, so the
// one screen built to compare our price against the market is never missing
// the only price the app already knows.
function _marketRateCell(p) {
    if (p.rate_low != null || !p.is_own_program) return { label: _drRateLabel(p.rate_low, p.rate_high), computed: false };
    const own = _marketOwnWeeklyRate();
    if (!own) return { label: '—', computed: false };
    return { label: _drRateLabel(own.low, own.high), computed: true };
}

function _marketTypeLabel(p) {
    return MARKET_PROVIDER_TYPES.find(t => t.id === p.provider_type)?.label || p.provider_type;
}

// Most flexible first — that is the axis this program competes on, so the
// providers most like us sort to the top. flexibility_score keeps earning its
// place here now that the scatter chart it was built for is gone.
function _marketByFlexibility() {
    return _marketProviders.slice().sort((a, b) =>
        (Number(b.flexibility_score) || 0) - (Number(a.flexibility_score) || 0));
}

function _marketRateCellHtml(p) {
    const cell = _marketRateCell(p);
    return cell.computed
        ? `${escHtml(cell.label)}<span class="mk-num-note" title="A full day x 5, from Settings → Rates. Type a rate into this provider row to override it.">from your rates</span>`
        : escHtml(cell.label);
}

function _renderMarketPositionList() {
    const el = document.getElementById('marketPositionList');
    if (!el) return;
    el.innerHTML = _marketByFlexibility().map(p => {
        const kind = _marketScheduleKind(p);
        return `
        <div class="mk-row${p.is_own_program ? ' is-us' : ''}">
            <div class="mk-row-main">
                <div class="mk-row-name">${p.is_own_program ? 'Us — ' : ''}${escHtml(p.name)}</div>
                <div class="mk-row-sub">${escHtml(p.ages_text || '—')}${p.is_own_program ? '' : ' · ' + escHtml(_marketTypeLabel(p))}</div>
            </div>
            <span class="mk-sched mk-sched-${kind.key}">${kind.label}</span>
        </div>`;
    }).join('');
    const note = document.getElementById('marketPositioningNote');
    if (note) note.textContent = _marketContext.positioningNote || '';
}

function _renderMarketPricingTable() {
    const el = document.getElementById('marketPricingTable');
    if (!el) return;
    // Cheapest first, but anyone with no rate on file sinks to the bottom
    // rather than sorting as $0 — an unknown rate is not a low one.
    const own = _marketOwnWeeklyRate();
    const sortRate = p => {
        if (p.rate_low != null) return Number(p.rate_low);
        if (p.is_own_program && own) return own.low;
        return Infinity;
    };
    const rows = _marketProviders.slice().sort((a, b) => sortRate(a) - sortRate(b));
    el.innerHTML = `
        <table class="mk-table">
            <thead><tr><th>Provider</th><th class="mk-num">Weekly rate</th><th class="mk-num">Reg. fee</th><th>Schedule</th></tr></thead>
            <tbody>
                ${rows.map(p => `
                    <tr${p.is_own_program ? ' class="is-us"' : ''}>
                        <td class="mk-td-name">${p.is_own_program ? 'Us — ' : ''}${escHtml(p.name)}</td>
                        <td class="mk-num">${_marketRateCellHtml(p)}</td>
                        <td class="mk-num">${escHtml(_drFeeLabel(p.reg_fee_low, p.reg_fee_high))}</td>
                        <td><span class="mk-sched mk-sched-${_marketScheduleKind(p).key}">${_marketScheduleKind(p).label}</span> <span class="mk-sched-text">${escHtml(_marketScheduleDetail(p))}</span></td>
                    </tr>`).join('')}
            </tbody>
        </table>`;
}

function _renderMarketCostContext() {
    const el = document.getElementById('marketCostContent');
    if (!el) return;
    const ic = _marketContext.infantCost || {};
    const wage = (_marketContext.wageLadder || []).filter(w => w.role);
    const minWage = Number(_marketContext.minWage) || 0;
    const money = n => '$' + Number(n || 0).toLocaleString();
    const ratio = (Number(ic.infantAnnual) && Number(ic.preschoolAnnual))
        ? (Number(ic.infantAnnual) / Number(ic.preschoolAnnual)).toFixed(1) + '×'
        : '—';

    el.innerHTML = `
        <div class="mk-costgrid">
            <div class="mk-costbox"><div class="mk-costbox-label">Infant care</div><div class="mk-costbox-val">${money(ic.infantAnnual)}</div><div class="mk-costbox-sub">annual cost to provide</div></div>
            <div class="mk-costbox"><div class="mk-costbox-label">Preschool care</div><div class="mk-costbox-val">${money(ic.preschoolAnnual)}</div><div class="mk-costbox-sub">annual cost to provide</div></div>
            <div class="mk-costbox"><div class="mk-costbox-label">Infant vs. preschool</div><div class="mk-costbox-val">${ratio}</div><div class="mk-costbox-sub">more expensive to deliver</div></div>
        </div>
        ${ic.source ? `<p class="chart-note">${escHtml(ic.source)}</p>` : ''}
        ${wage.length ? `
            <div class="mk-subhead">Wage ladder${minWage ? ` — Missouri minimum wage $${escHtml(String(minWage))}/hr` : ''}</div>
            <table class="mk-table">
                <thead><tr><th>Role</th><th class="mk-num">Hourly range</th><th class="mk-num">vs. minimum</th></tr></thead>
                <tbody>
                    ${wage.map(w => {
                        const over = minWage ? (Number(w.low) - minWage) : null;
                        const overLabel = over == null ? '—' : (over > 0 ? `+$${over.toFixed(2)}` : over < 0 ? `-$${Math.abs(over).toFixed(2)}` : 'at minimum');
                        return `<tr>
                            <td class="mk-td-name">${escHtml(w.role)}</td>
                            <td class="mk-num">$${escHtml(String(w.low))}–$${escHtml(String(w.high))}/hr</td>
                            <td class="mk-num${over != null && over <= 0 ? ' mk-num-flag' : ''}">${escHtml(overLabel)}</td>
                        </tr>`;
                    }).join('')}
                </tbody>
            </table>
            ${_marketContext.wageSource ? `<p class="chart-note">${escHtml(_marketContext.wageSource)}</p>` : ''}
        ` : '<p class="empty-hint">No wage ladder entered yet — add one under “Edit Stats &amp; Figures.”</p>'}`;
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
        <table class="mk-table">
            <thead><tr><th>Provider</th><th>Age range</th><th class="mk-num">Rate / wk</th><th>Schedule</th><th></th></tr></thead>
            <tbody>
                ${_marketProviders.map(p => `
                    <tr${p.is_own_program ? ' class="is-us"' : ''}${p.active === false ? ' style="opacity:.5"' : ''}>
                        <td class="mk-td-name">${p.is_own_program ? 'Us — ' : ''}${escHtml(p.name)}${p.is_own_program ? '' : `<span class="mk-td-type">${escHtml(_marketTypeLabel(p))}</span>`}</td>
                        <td>${escHtml(p.ages_text || '—')}</td>
                        <td class="mk-num">${_marketRateCellHtml(p)}</td>
                        <td><span class="mk-sched mk-sched-${_marketScheduleKind(p).key}">${_marketScheduleKind(p).label}</span> <span class="mk-sched-text">${escHtml(_marketScheduleDetail(p))}</span></td>
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
        _renderMarketPositionList();
        _renderMarketCostContext();
    } catch (err) {
        alert('Error saving: ' + err.message);
    } finally {
        btn.disabled = false; btn.textContent = 'Save';
    }
}

// ============================================================
// DIRECTOR REPORT  (consolidation pass, design_handoff_planning_market,
// 2026-08-27) — replaces the three separate Market Position / Pricing
// Landscape / Cost & Wage Context tools with one segmented view. Each
// segment is one of the three panes above. _reloadMarketData() renders all
// three on load regardless of which is showing; switching segments re-invokes
// that segment's own renderer so a pane can never show pre-refresh figures.
// (When these were charts, the re-render was mandatory — Chart.js sizes a
// canvas off its layout box at creation time, so one built inside a
// `display:none` pane drew at zero size. Plain HTML has no such problem; the
// re-render is kept because it is cheap and keeps the panes in step.)
// ============================================================

const DR_SEGMENTS = ['position', 'pricing', 'cost'];
const DR_SEG_RENDER = {
    position: () => { _renderMarketHeroStats(); _renderMarketPositionList(); },
    pricing:  _renderMarketPricingTable,
    cost:     _renderMarketCostContext,
};
const DR_SEG_PANE_ID = { position: 'drPanePosition', pricing: 'drPanePricing', cost: 'drPaneCost' };

function _wireDirectorReportSeg() {
    document.querySelectorAll('#drSeg [data-dr-seg]').forEach(btn => {
        btn.addEventListener('click', () => _switchDirectorReportSeg(btn.dataset.drSeg));
    });
    document.getElementById('drExportPacketBtn')?.addEventListener('click', _openDirectorReportPacket);
}

function _switchDirectorReportSeg(seg) {
    if (!DR_SEG_RENDER[seg]) return;
    document.querySelectorAll('#drSeg [data-dr-seg]').forEach(btn => {
        btn.classList.toggle('is-on', btn.dataset.drSeg === seg);
    });
    DR_SEGMENTS.forEach(s => {
        const pane = document.getElementById(DR_SEG_PANE_ID[s]);
        if (pane) pane.style.display = s === seg ? '' : 'none';
    });
    DR_SEG_RENDER[seg]();
}

function _drRateLabel(low, high) {
    if (low == null) return '—';
    return '$' + low + (high != null && high !== low ? '–$' + high : '') + '/wk';
}
function _drFeeLabel(low, high) {
    if (low == null) return '—';
    return '$' + low + (high != null && high !== low ? '–$' + high : '');
}

// In-DOM print overlay — reuses the exact .fh-print-scrim/.fh-print-sheet
// pattern already built for Finance Hub's statement print (css/admin-portal.css)
// rather than a second print component, per the handoff's explicit
// "reuse the @media print pattern already in admin-portal.css" instruction.
function _openDirectorReportPacket() {
    document.getElementById('drPrintScrim')?.remove();
    const generated = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
    const ic = _marketContext.infantCost || {};
    const wageRows = (_marketContext.wageLadder || []).filter(w => w.role).map(w => `
        <tr><td>${escHtml(w.role)}</td><td>$${w.low}–$${w.high}/hr</td></tr>`).join('');

    const wrap = document.createElement('div');
    wrap.id = 'drPrintScrim';
    wrap.className = 'fh-print-scrim';
    wrap.innerHTML = `
        <div class="fh-print-sheet">
            <h1>Board Packet — Market Analysis</h1>
            <p style="color:#6b7280;font-size:13px;margin:-10px 0 18px">
                Generated ${escHtml(generated)} from Comparable Providers — Market Position, Pricing Landscape, and Cost Context, one printable page.
            </p>

            <h2>Market Position</h2>
            <table>
                <thead><tr><th>Provider</th><th>Age range</th><th>Schedule</th></tr></thead>
                <tbody>
                    ${_marketProviders.map(p => `
                    <tr>
                        <td${p.is_own_program ? ' style="font-weight:700"' : ''}>${escHtml(p.name)}</td>
                        <td>${escHtml(p.ages_text || '—')}</td>
                        <td>${escHtml(p.flexible_text || '—')}</td>
                    </tr>`).join('')}
                </tbody>
            </table>

            <h2>Pricing Landscape</h2>
            <table>
                <thead><tr><th>Provider</th><th>Weekly rate</th><th>Reg. fee</th></tr></thead>
                <tbody>
                    ${_marketProviders.map(p => `
                    <tr>
                        <td${p.is_own_program ? ' style="font-weight:700"' : ''}>${escHtml(p.name)}</td>
                        <td>${escHtml(_marketRateCell(p).label)}</td>
                        <td>${_drFeeLabel(p.reg_fee_low, p.reg_fee_high)}</td>
                    </tr>`).join('')}
                </tbody>
            </table>

            <h2>Cost Context</h2>
            <table>
                <thead><tr><th></th><th>Annual cost</th></tr></thead>
                <tbody>
                    <tr><td>Infant care</td><td>${apMoney(ic.infantAnnual || 0)}</td></tr>
                    <tr><td>Preschool care</td><td>${apMoney(ic.preschoolAnnual || 0)}</td></tr>
                </tbody>
            </table>
            ${ic.source ? `<p style="font-size:12px;color:#6b7280;margin-top:6px">${escHtml(ic.source)}</p>` : ''}
            ${wageRows ? `
            <h2 style="margin-top:22px">Wage Ladder${_marketContext.minWage ? ` — min. wage $${escHtml(String(_marketContext.minWage))}/hr` : ''}</h2>
            <table>
                <thead><tr><th>Role</th><th>Range</th></tr></thead>
                <tbody>${wageRows}</tbody>
            </table>
            ${_marketContext.wageSource ? `<p style="font-size:12px;color:#6b7280;margin-top:6px">${escHtml(_marketContext.wageSource)}</p>` : ''}` : ''}

            <div class="fh-print-btns no-print">
                <button type="button" class="fh-print-btn" id="drPrintBtn">🖨️ Print / Save as PDF</button>
                <button type="button" class="fh-print-close" id="drPrintCloseBtn">Close</button>
            </div>
        </div>`;
    document.body.appendChild(wrap);
    document.getElementById('drPrintBtn')?.addEventListener('click', () => window.print());
    document.getElementById('drPrintCloseBtn')?.addEventListener('click', () => wrap.remove());
}
