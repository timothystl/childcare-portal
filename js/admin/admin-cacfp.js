// ============================================================
// MODULE: Admin CACFP (income eligibility, meal counts, menus, claims)
// ============================================================

let _cacfpLoaded      = false;
let _cacfpFamilies    = [];
let _cacfpIncomeApps  = [];
let _cacfpRates       = [];
let _cacfpThresholds  = { effectiveDate: '', sizes: [] };
let _cacfpMealRoster  = []; // roster rows + editable status, for the meal-count screen
let _cacfpMenuWeekRows = []; // currently loaded week of cacfp_menus rows
let _cacfpMenuEditingKey = null; // { date, mealType } open in the day modal
let _cacfpCurrentClaim = null; // { period, lines }

const CACFP_COMPONENT_LABELS = { milk: 'Milk', meat_alt: 'Meat/Alt', vegetable: 'Veg', fruit: 'Fruit', grain: 'Grain' };

async function initCacfpTab() {
    _populateCacfpRoomSelect();
    _setCacfpDefaultDates();
    _wireCacfpMealCount();
    _wireCacfpMenuPlanner();
    _wireCacfpIncome();
    _wireCacfpClaims();

    _cacfpFamilies = await fetchFamiliesLite();
    await Promise.all([_reloadCacfpIncomeApps(), _reloadCacfpRates(), _reloadCacfpThresholds()]);
}

function _cacfpCloseModal(id) {
    document.getElementById(id)?.classList.add('hidden');
}

function _populateCacfpRoomSelect() {
    const sel = document.getElementById('cacfpMealRoom');
    if (!sel || sel.options.length > 1) return;
    getSortedRooms().forEach(room => {
        const opt = document.createElement('option');
        opt.value = room.id;
        opt.textContent = room.label;
        sel.appendChild(opt);
    });
}

function _setCacfpDefaultDates() {
    const today = new Date().toISOString().split('T')[0];
    const mealDate = document.getElementById('cacfpMealDate');
    if (mealDate && !mealDate.value) mealDate.value = today;
    const weekOf = document.getElementById('cacfpMenuWeekOf');
    if (weekOf && !weekOf.value) weekOf.value = _currentWeekMonday();
    const claimMonth = document.getElementById('cacfpClaimMonth');
    if (claimMonth && !claimMonth.value) claimMonth.value = today.slice(0, 7);
}

function _cacfpWeekdayDates(weekOf) {
    const start = new Date(weekOf + 'T00:00:00');
    const dates = [];
    for (let i = 0; i < 7; i++) {
        const d = new Date(start);
        d.setDate(start.getDate() + i);
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue;
        dates.push(d.toISOString().split('T')[0]);
    }
    return dates;
}

// ============================================================
// DAILY MEAL COUNTS
// ============================================================
function _wireCacfpMealCount() {
    document.getElementById('cacfpMealLoadBtn')?.addEventListener('click', _loadCacfpMealRoster);
    document.getElementById('cacfpMealSaveBtn')?.addEventListener('click', _saveCacfpMealRoster);
}

async function _loadCacfpMealRoster() {
    const date     = document.getElementById('cacfpMealDate').value;
    const roomId   = document.getElementById('cacfpMealRoom').value;
    const mealType = document.getElementById('cacfpMealType').value;
    if (!date || !mealType) return;

    const roster   = getRosterForDate(date, roomId || null);
    const existing = await fetchCacfpMealRecords(date, date);
    const existingMap = {};
    existing.filter(r => r.meal_type === mealType).forEach(r => { existingMap[r.registration_id] = r.status; });

    _cacfpMealRoster = roster.map(r => {
        const match = matchFamilyByEmail(_cacfpFamilies, r.parentEmail);
        return { ...r, familyId: match ? match.id : null, status: existingMap[r.registrationId] || 'served' };
    });
    _renderCacfpMealRoster();
}

function _renderCacfpMealRoster() {
    const el = document.getElementById('cacfpMealContent');
    if (!el) return;
    if (!_cacfpMealRoster.length) {
        el.innerHTML = '<p class="empty-hint">No children scheduled for care on that date/room.</p>';
        return;
    }
    el.innerHTML = `
        <table class="rates-table cacfp-meal-table">
            <thead><tr><th>Child</th><th>Room</th><th>Status</th></tr></thead>
            <tbody>
                ${_cacfpMealRoster.map((r, i) => `
                    <tr>
                        <td>${escHtml(r.childName)}</td>
                        <td>${escHtml(r.roomLabel)}</td>
                        <td>
                            <div class="cacfp-status-group" data-idx="${i}">
                                ${CACFP_MEAL_STATUSES.map(s => `
                                    <button type="button" class="cacfp-status-btn ${r.status === s.id ? 'active' : ''}" data-status="${s.id}">${escHtml(s.label)}</button>
                                `).join('')}
                            </div>
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>`;
    el.querySelectorAll('.cacfp-status-group').forEach(group => {
        group.querySelectorAll('.cacfp-status-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const idx = Number(group.dataset.idx);
                _cacfpMealRoster[idx].status = btn.dataset.status;
                group.querySelectorAll('.cacfp-status-btn').forEach(b => b.classList.toggle('active', b === btn));
            });
        });
    });
}

async function _saveCacfpMealRoster() {
    const btn = document.getElementById('cacfpMealSaveBtn');
    if (!btn || !_cacfpMealRoster.length) return;
    const date     = document.getElementById('cacfpMealDate').value;
    const mealType = document.getElementById('cacfpMealType').value;
    if (!date || !mealType) return;

    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        const records = _cacfpMealRoster.map(r => ({
            registration_id: r.registrationId,
            family_id:       r.familyId,
            child_name:      r.childName,
            room_id:         r.roomId,
            care_date:       date,
            meal_type:       mealType,
            status:          r.status,
            recorded_by:     window._adminSession?.user?.email || '',
        }));
        await upsertCacfpMealRecordsBatch(records);
        btn.textContent = '✓ Saved';
        setTimeout(() => { btn.textContent = '💾 Save All'; }, 1500);
    } catch (err) {
        alert('Error saving meal counts: ' + err.message);
        btn.textContent = '💾 Save All';
    } finally {
        btn.disabled = false;
    }
}

// ============================================================
// MENU PLANNER
// ============================================================
function _wireCacfpMenuPlanner() {
    document.getElementById('cacfpMenuLoadBtn')?.addEventListener('click', _loadCacfpMenuWeek);
    document.getElementById('cacfpMenuCopyBtn')?.addEventListener('click', _copyCacfpMenuPreviousWeek);
    document.getElementById('cacfpMenuPublishBtn')?.addEventListener('click', () => _setCacfpMenuWeekPublishState('published'));
    document.getElementById('cacfpMenuUnpublishBtn')?.addEventListener('click', () => _setCacfpMenuWeekPublishState('draft'));
    document.getElementById('cmdCancelBtn')?.addEventListener('click', () => _cacfpCloseModal('cacfpMenuDayModal'));
    document.getElementById('cmdCloseBtn')?.addEventListener('click', () => _cacfpCloseModal('cacfpMenuDayModal'));
    document.getElementById('cmdSaveBtn')?.addEventListener('click', _saveCacfpMenuDay);
}

async function _loadCacfpMenuWeek() {
    const weekOf = document.getElementById('cacfpMenuWeekOf').value;
    if (!weekOf) return;
    const dates = _cacfpWeekdayDates(weekOf);
    _cacfpMenuWeekRows = await fetchCacfpMenus(dates[0], dates[dates.length - 1]);
    _renderCacfpMenuWeek(dates);
}

function _renderCacfpMenuWeek(dates) {
    const el = document.getElementById('cacfpMenuContent');
    if (!el) return;
    const dayLabel = d => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    const cellFor  = (date, mealType) => _cacfpMenuWeekRows.find(r => r.menu_date === date && r.meal_type === mealType);
    const anyPublished = _cacfpMenuWeekRows.some(r => r.status === 'published');

    el.innerHTML = `
        <p class="empty-hint" style="margin-bottom:10px">
            ${anyPublished
                ? '<span class="tag-published">Published</span> — visible on the public menu page.'
                : '<span class="tag-draft">Draft</span> — not yet visible to parents.'}
        </p>
        <div class="cacfp-menu-grid-wrap">
        <table class="rates-table cacfp-menu-table">
            <thead><tr><th>Meal</th>${dates.map(d => `<th>${dayLabel(d)}</th>`).join('')}</tr></thead>
            <tbody>
                ${CACFP_MEAL_TYPES.map(mt => `
                    <tr>
                        <td><strong>${escHtml(mt.label)}</strong></td>
                        ${dates.map(d => {
                            const cell = cellFor(d, mt.id);
                            const chips = cell
                                ? Object.keys(CACFP_COMPONENT_LABELS).filter(c => cell[c])
                                    .map(c => `<span class="cacfp-chip">${CACFP_COMPONENT_LABELS[c]}</span>`).join('')
                                : '';
                            return `<td class="cacfp-menu-cell" data-date="${d}" data-meal="${mt.id}">
                                ${cell && cell.food_items ? escHtml(cell.food_items) : '<span class="empty-hint">— add —</span>'}
                                ${chips ? `<div class="cacfp-components">${chips}</div>` : ''}
                            </td>`;
                        }).join('')}
                    </tr>
                `).join('')}
            </tbody>
        </table>
        </div>`;
    el.querySelectorAll('.cacfp-menu-cell').forEach(td => {
        td.addEventListener('click', () => _openCacfpMenuDayModal(td.dataset.date, td.dataset.meal));
    });
}

function _openCacfpMenuDayModal(date, mealType) {
    _cacfpMenuEditingKey = { date, mealType };
    const cell = _cacfpMenuWeekRows.find(r => r.menu_date === date && r.meal_type === mealType) || {};
    const mtLabel = CACFP_MEAL_TYPES.find(m => m.id === mealType)?.label || mealType;
    document.getElementById('cmdTitle').textContent =
        `${mtLabel} — ${new Date(date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })}`;
    document.getElementById('cmdFoodItems').value  = cell.food_items || '';
    document.getElementById('cmdMilk').checked      = !!cell.milk;
    document.getElementById('cmdMeatAlt').checked   = !!cell.meat_alt;
    document.getElementById('cmdVegetable').checked = !!cell.vegetable;
    document.getElementById('cmdFruit').checked     = !!cell.fruit;
    document.getElementById('cmdGrain').checked     = !!cell.grain;
    document.getElementById('cacfpMenuDayModal').classList.remove('hidden');
}

async function _saveCacfpMenuDay() {
    if (!_cacfpMenuEditingKey) return;
    const { date, mealType } = _cacfpMenuEditingKey;
    const existing = _cacfpMenuWeekRows.find(r => r.menu_date === date && r.meal_type === mealType);
    const row = {
        menu_date:  date,
        meal_type:  mealType,
        food_items: document.getElementById('cmdFoodItems').value.trim(),
        milk:       document.getElementById('cmdMilk').checked,
        meat_alt:   document.getElementById('cmdMeatAlt').checked,
        vegetable:  document.getElementById('cmdVegetable').checked,
        fruit:      document.getElementById('cmdFruit').checked,
        grain:      document.getElementById('cmdGrain').checked,
        status:     existing?.status || 'draft',
        updated_at: new Date().toISOString(),
    };
    try {
        await upsertCacfpMenu(row);
        _cacfpCloseModal('cacfpMenuDayModal');
        await _loadCacfpMenuWeek();
    } catch (err) {
        alert('Error saving menu: ' + err.message);
    }
}

async function _copyCacfpMenuPreviousWeek() {
    const weekOf = document.getElementById('cacfpMenuWeekOf').value;
    if (!weekOf) return;
    const prevMonday = new Date(weekOf + 'T00:00:00');
    prevMonday.setDate(prevMonday.getDate() - 7);
    const prevWeekOf  = prevMonday.toISOString().split('T')[0];
    const prevDates   = _cacfpWeekdayDates(prevWeekOf);
    const curDates    = _cacfpWeekdayDates(weekOf);
    const prevRows    = await fetchCacfpMenus(prevDates[0], prevDates[prevDates.length - 1]);
    if (!prevRows.length) { alert('No menu found for the previous week.'); return; }
    if (!confirm('Copy last week\'s menu into this week? This overwrites any items already entered for this week.')) return;

    const newRows = prevRows.map(r => {
        const idx = prevDates.indexOf(r.menu_date);
        const newDate = curDates[idx];
        if (!newDate) return null;
        return {
            menu_date: newDate, meal_type: r.meal_type, food_items: r.food_items,
            milk: r.milk, meat_alt: r.meat_alt, vegetable: r.vegetable, fruit: r.fruit, grain: r.grain,
            status: 'draft', updated_at: new Date().toISOString(),
        };
    }).filter(Boolean);

    try {
        for (const row of newRows) await upsertCacfpMenu(row);
        await _loadCacfpMenuWeek();
    } catch (err) {
        alert('Error copying menu: ' + err.message);
    }
}

async function _setCacfpMenuWeekPublishState(status) {
    const weekOf = document.getElementById('cacfpMenuWeekOf').value;
    if (!weekOf) return;
    try {
        await setCacfpMenuWeekStatus(_cacfpWeekdayDates(weekOf), status);
        await _loadCacfpMenuWeek();
    } catch (err) {
        alert('Error updating menu status: ' + err.message);
    }
}

// ============================================================
// INCOME ELIGIBILITY
// ============================================================
function _wireCacfpIncome() {
    document.getElementById('cacfpAddApplicationBtn')?.addEventListener('click', _openCacfpIncomeModal);
    document.getElementById('cacfpIncomeRefreshBtn')?.addEventListener('click', _reloadCacfpIncomeApps);
    document.getElementById('cacfpThresholdsBtn')?.addEventListener('click', _openCacfpThresholdsModal);
    document.getElementById('cimCancelBtn')?.addEventListener('click', () => _cacfpCloseModal('cacfpIncomeModal'));
    document.getElementById('cimCloseBtn')?.addEventListener('click', () => _cacfpCloseModal('cacfpIncomeModal'));
    document.getElementById('cimSaveBtn')?.addEventListener('click', _saveCacfpIncomeApplication);
    document.getElementById('cimHouseholdSize')?.addEventListener('input', _suggestCacfpTier);
    document.getElementById('cimAnnualIncome')?.addEventListener('input', _suggestCacfpTier);
    document.getElementById('ctmCancelBtn')?.addEventListener('click', () => _cacfpCloseModal('cacfpThresholdsModal'));
    document.getElementById('ctmCloseBtn')?.addEventListener('click', () => _cacfpCloseModal('cacfpThresholdsModal'));
    document.getElementById('ctmAddSizeBtn')?.addEventListener('click', _addCacfpThresholdSizeRow);
    document.getElementById('ctmSaveBtn')?.addEventListener('click', _saveCacfpThresholds);
}

async function _reloadCacfpIncomeApps() {
    _cacfpIncomeApps = await fetchCacfpIncomeApplications();
    _renderCacfpIncomeTable();
}

function _cacfpCurrentApplication(familyId) {
    const today = new Date().toISOString().split('T')[0];
    return _cacfpIncomeApps
        .filter(a => a.family_id === familyId && a.effective_date <= today)
        .sort((a, b) => b.effective_date.localeCompare(a.effective_date))[0] || null;
}

function _renderCacfpIncomeTable() {
    const el = document.getElementById('cacfpIncomeContent');
    if (!el) return;
    const today = new Date();
    const rows = _cacfpFamilies.filter(f => f.active !== false).map(f => {
        const app = _cacfpCurrentApplication(f.id);
        let expired = true;
        if (app) {
            const ageDays = (today - new Date(app.effective_date + 'T00:00:00')) / 86400000;
            expired = ageDays > 366;
        }
        return { family: f, app, missing: !app || expired };
    }).sort((a, b) => (b.missing - a.missing) || a.family.parent_name.localeCompare(b.family.parent_name));

    const missingCount = rows.filter(r => r.missing).length;
    el.innerHTML = `
        <p class="empty-hint" style="margin-bottom:10px">${missingCount} of ${rows.length} families missing a current-year application (defaulting to <strong>paid</strong>).</p>
        <table class="rates-table">
            <thead><tr><th>Family</th><th>Tier</th><th>Effective</th><th>Household</th><th>Income</th></tr></thead>
            <tbody>
                ${rows.map(r => `
                    <tr class="${r.missing ? 'cacfp-missing-row' : ''}">
                        <td>${escHtml(r.family.parent_name)}</td>
                        <td><span class="cacfp-tier-tag cacfp-tier-${r.app ? r.app.tier : 'paid'}">${
                            r.app ? escHtml(CACFP_TIERS.find(t => t.id === r.app.tier)?.label || r.app.tier) : 'Paid (default)'
                        }</span></td>
                        <td>${r.app ? friendlyShort(r.app.effective_date) : '—'}</td>
                        <td>${r.app ? r.app.household_size : '—'}</td>
                        <td>${r.app ? '$' + Number(r.app.annual_income).toLocaleString() : '—'}</td>
                    </tr>
                `).join('')}
            </tbody>
        </table>`;
}

function _openCacfpIncomeModal() {
    const sel = document.getElementById('cimFamily');
    sel.innerHTML = '<option value="">— select family —</option>' +
        _cacfpFamilies.filter(f => f.active !== false)
            .map(f => `<option value="${f.id}">${escHtml(f.parent_name)}</option>`).join('');
    document.getElementById('cimHouseholdSize').value = '';
    document.getElementById('cimAnnualIncome').value = '';
    document.getElementById('cimTier').value = 'paid';
    document.getElementById('cimEffectiveDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('cimNotes').value = '';
    document.getElementById('cimSuggestedTier').textContent = '';
    document.getElementById('cimErr').textContent = '';
    document.getElementById('cacfpIncomeModal').classList.remove('hidden');
}

function _suggestCacfpTier() {
    const size   = Number(document.getElementById('cimHouseholdSize').value);
    const income = Number(document.getElementById('cimAnnualIncome').value);
    const hint   = document.getElementById('cimSuggestedTier');
    if (!size || !income || !_cacfpThresholds.sizes?.length) { hint.textContent = ''; return; }

    const sizes = [..._cacfpThresholds.sizes].sort((a, b) => a.size - b.size);
    const row   = sizes.find(s => s.size === size) || sizes[sizes.length - 1];
    let tier = 'paid';
    if (income <= Number(row.freeMax)) tier = 'free';
    else if (income <= Number(row.reducedMax)) tier = 'reduced';

    hint.textContent = `Suggested tier based on thresholds (${_cacfpThresholds.effectiveDate || 'unset'}): ${tier.toUpperCase()}` +
        (row.size !== size ? ` — using household size ${row.size} threshold; add size ${size} for an exact match` : '');
    document.getElementById('cimTier').value = tier;
}

async function _saveCacfpIncomeApplication() {
    const errEl = document.getElementById('cimErr');
    errEl.textContent = '';
    const familyId      = document.getElementById('cimFamily').value;
    const householdSize = Number(document.getElementById('cimHouseholdSize').value);
    const annualIncome  = Number(document.getElementById('cimAnnualIncome').value);
    const tier           = document.getElementById('cimTier').value;
    const effectiveDate  = document.getElementById('cimEffectiveDate').value;
    const notes           = document.getElementById('cimNotes').value.trim();
    if (!familyId || !householdSize || !annualIncome || !effectiveDate) {
        errEl.textContent = 'Family, household size, income, and effective date are required.';
        return;
    }
    const btn = document.getElementById('cimSaveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        await insertCacfpIncomeApplication({
            family_id: familyId, household_size: householdSize, annual_income: annualIncome,
            tier, effective_date: effectiveDate, notes,
            submitted_by: window._adminSession?.user?.email || '',
        });
        _cacfpCloseModal('cacfpIncomeModal');
        await _reloadCacfpIncomeApps();
    } catch (err) {
        errEl.textContent = 'Error: ' + err.message;
    } finally {
        btn.disabled = false; btn.textContent = 'Save Application';
    }
}

async function _reloadCacfpThresholds() {
    _cacfpThresholds = await fetchCacfpIncomeThresholds();
    if (!_cacfpThresholds.sizes) _cacfpThresholds.sizes = [];
}

function _openCacfpThresholdsModal() {
    document.getElementById('ctmEffectiveDate').value = _cacfpThresholds.effectiveDate || '';
    _renderCacfpThresholdRows();
    document.getElementById('cacfpThresholdsModal').classList.remove('hidden');
}

function _renderCacfpThresholdRows() {
    const wrap = document.getElementById('ctmSizesTable');
    wrap.innerHTML = `
        <table class="rates-table">
            <thead><tr><th>Household Size</th><th>Free — max income ($)</th><th>Reduced — max income ($)</th><th></th></tr></thead>
            <tbody>
                ${_cacfpThresholds.sizes.map((s, i) => `
                    <tr data-idx="${i}">
                        <td><input type="number" class="rate-input ctm-size" value="${s.size ?? ''}" min="1" step="1" style="width:70px"></td>
                        <td><input type="number" class="rate-input ctm-free" value="${s.freeMax ?? ''}" min="0" step="1"></td>
                        <td><input type="number" class="rate-input ctm-reduced" value="${s.reducedMax ?? ''}" min="0" step="1"></td>
                        <td><button type="button" class="btn-ghost ctm-remove-row" title="Remove">&#10005;</button></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>`;
    wrap.querySelectorAll('.ctm-remove-row').forEach(btn => {
        btn.addEventListener('click', () => {
            const idx = Number(btn.closest('tr').dataset.idx);
            _cacfpThresholds.sizes.splice(idx, 1);
            _renderCacfpThresholdRows();
        });
    });
}

function _addCacfpThresholdSizeRow() {
    const nextSize = (_cacfpThresholds.sizes[_cacfpThresholds.sizes.length - 1]?.size || 0) + 1;
    _cacfpThresholds.sizes.push({ size: nextSize, freeMax: '', reducedMax: '' });
    _renderCacfpThresholdRows();
}

async function _saveCacfpThresholds() {
    const rows = document.querySelectorAll('#ctmSizesTable tbody tr');
    const sizes = Array.from(rows).map(tr => ({
        size:       Number(tr.querySelector('.ctm-size').value) || 0,
        freeMax:    Number(tr.querySelector('.ctm-free').value) || 0,
        reducedMax: Number(tr.querySelector('.ctm-reduced').value) || 0,
    })).filter(s => s.size > 0);
    const effectiveDate = document.getElementById('ctmEffectiveDate').value;

    const btn = document.getElementById('ctmSaveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        _cacfpThresholds = { effectiveDate, sizes };
        await saveCacfpIncomeThresholds(_cacfpThresholds);
        _cacfpCloseModal('cacfpThresholdsModal');
    } catch (err) {
        alert('Error saving thresholds: ' + err.message);
    } finally {
        btn.disabled = false; btn.textContent = 'Save Thresholds';
    }
}

// ============================================================
// MONTHLY CLAIM
// ============================================================
function _wireCacfpClaims() {
    document.getElementById('cacfpGenerateClaimBtn')?.addEventListener('click', _generateCacfpClaim);
    document.getElementById('cacfpExportClaimCsvBtn')?.addEventListener('click', _exportCacfpClaimCsv);
    document.getElementById('cacfpPrintClaimBtn')?.addEventListener('click', _printCacfpClaim);
    document.getElementById('cacfpFinalizeClaimBtn')?.addEventListener('click', _finalizeCacfpClaim);
    document.getElementById('cacfpAddRateBtn')?.addEventListener('click', _openCacfpRateModal);
    document.getElementById('crmCancelBtn')?.addEventListener('click', () => _cacfpCloseModal('cacfpRateModal'));
    document.getElementById('crmCloseBtn')?.addEventListener('click', () => _cacfpCloseModal('cacfpRateModal'));
    document.getElementById('crmSaveBtn')?.addEventListener('click', _saveCacfpRates);
}

async function _reloadCacfpRates() {
    _cacfpRates = await fetchCacfpReimbursementRates();
    _renderCacfpRatesTable();
}

function _renderCacfpRatesTable() {
    const el = document.getElementById('cacfpRatesContent');
    if (!el) return;
    if (!_cacfpRates.length) {
        el.innerHTML = '<p class="empty-hint">No reimbursement rates on file yet — add one below.</p>';
        return;
    }
    const today = new Date().toISOString().split('T')[0];
    const latestEffective = [...new Set(_cacfpRates.map(r => r.effective_date))].sort().reverse()[0];
    el.innerHTML = `
        <p class="empty-hint" style="margin-bottom:8px">Current rates (effective ${friendlyShort(latestEffective)}):</p>
        <table class="rates-table">
            <thead><tr><th>Meal</th>${CACFP_TIERS.map(t => `<th>${escHtml(t.label)}</th>`).join('')}</tr></thead>
            <tbody>
                ${CACFP_MEAL_TYPES.map(mt => `
                    <tr>
                        <td>${escHtml(mt.label)}</td>
                        ${CACFP_TIERS.map(t => `<td>$${cacfpRateAsOf(_cacfpRates, mt.id, t.id, today).toFixed(4)}</td>`).join('')}
                    </tr>
                `).join('')}
            </tbody>
        </table>`;
}

function _openCacfpRateModal() {
    document.getElementById('crmEffectiveDate').value = new Date().toISOString().split('T')[0];
    document.getElementById('crmErr').textContent = '';
    const today = new Date().toISOString().split('T')[0];
    const grid = document.getElementById('crmRatesGrid');
    grid.innerHTML = `
        <table class="rates-table">
            <thead><tr><th>Meal</th>${CACFP_TIERS.map(t => `<th>${escHtml(t.label)}</th>`).join('')}</tr></thead>
            <tbody>
                ${CACFP_MEAL_TYPES.map(mt => `
                    <tr>
                        <td>${escHtml(mt.label)}</td>
                        ${CACFP_TIERS.map(t => {
                            const current = cacfpRateAsOf(_cacfpRates, mt.id, t.id, today);
                            return `<td><input type="number" class="rate-input crm-rate" data-meal="${mt.id}" data-tier="${t.id}" min="0" step="0.0001" value="${current || ''}"></td>`;
                        }).join('')}
                    </tr>
                `).join('')}
            </tbody>
        </table>`;
    document.getElementById('cacfpRateModal').classList.remove('hidden');
}

async function _saveCacfpRates() {
    const effectiveDate = document.getElementById('crmEffectiveDate').value;
    const errEl = document.getElementById('crmErr');
    errEl.textContent = '';
    if (!effectiveDate) { errEl.textContent = 'Effective date is required.'; return; }

    const rows = Array.from(document.querySelectorAll('.crm-rate'))
        .filter(i => i.value !== '')
        .map(i => ({ effective_date: effectiveDate, meal_type: i.dataset.meal, tier: i.dataset.tier, rate: Number(i.value) }));
    if (!rows.length) { errEl.textContent = 'Enter at least one rate.'; return; }

    const btn = document.getElementById('crmSaveBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        for (const row of rows) await insertCacfpReimbursementRate(row);
        _cacfpCloseModal('cacfpRateModal');
        await _reloadCacfpRates();
    } catch (err) {
        errEl.textContent = 'Error: ' + err.message;
    } finally {
        btn.disabled = false; btn.textContent = 'Save Rates';
    }
}

async function _generateCacfpClaim() {
    const monthVal = document.getElementById('cacfpClaimMonth').value; // 'YYYY-MM'
    if (!monthVal) return;
    const monthDate = monthVal + '-01';

    const btn = document.getElementById('cacfpGenerateClaimBtn');
    btn.disabled = true; btn.textContent = 'Generating…';
    try {
        const period = await ensureCacfpClaimPeriod(monthDate);
        if (period.status === 'finalized') {
            _cacfpCurrentClaim = { period, lines: await fetchCacfpClaimLines(period.id) };
            _renderCacfpClaim();
            return;
        }

        const [y, m] = monthVal.split('-').map(Number);
        const firstDay = monthDate;
        const lastDay  = new Date(y, m, 0).toISOString().split('T')[0]; // last calendar day of the month

        const [records, apps, rates] = await Promise.all([
            fetchCacfpMealRecords(firstDay, lastDay),
            _cacfpIncomeApps.length ? Promise.resolve(_cacfpIncomeApps) : fetchCacfpIncomeApplications(),
            _cacfpRates.length ? Promise.resolve(_cacfpRates) : fetchCacfpReimbursementRates(),
        ]);

        // Only 'served' meals are reimbursable — brought_own/absent are excluded by construction.
        const counts = {};
        records.filter(r => r.status === 'served').forEach(r => {
            const tier = cacfpTierAsOf(apps, r.family_id, r.care_date);
            const key = r.meal_type + '|' + tier;
            counts[key] = (counts[key] || 0) + 1;
        });

        const lines = [];
        CACFP_MEAL_TYPES.forEach(mt => {
            CACFP_TIERS.forEach(t => {
                const count = counts[mt.id + '|' + t.id] || 0;
                const rate  = cacfpRateAsOf(rates, mt.id, t.id, monthDate);
                lines.push({
                    meal_type: mt.id, tier: t.id, meal_count: count,
                    rate_applied: rate, reimbursement_amount: Math.round(count * rate * 100) / 100,
                });
            });
        });

        await saveCacfpClaimLines(period.id, lines);
        _cacfpCurrentClaim = { period, lines: lines.map(l => ({ ...l, claim_period_id: period.id })) };
        _renderCacfpClaim();
    } catch (err) {
        alert('Error generating claim: ' + err.message);
    } finally {
        btn.disabled = false; btn.textContent = 'Generate / Refresh';
    }
}

function _renderCacfpClaim() {
    const el = document.getElementById('cacfpClaimContent');
    if (!el || !_cacfpCurrentClaim) return;
    const { period, lines } = _cacfpCurrentClaim;
    const total      = lines.reduce((sum, l) => sum + Number(l.reimbursement_amount), 0);
    const grandMeals = lines.reduce((sum, l) => sum + Number(l.meal_count), 0);

    el.innerHTML = `
        <p class="empty-hint" style="margin-bottom:10px">
            Status: <strong>${period.status === 'finalized' ? '🔒 Finalized' : 'Open (draft)'}</strong>
            ${period.status === 'finalized' && period.finalized_at ? ' · ' + friendlyShort(period.finalized_at.split('T')[0]) : ''}
        </p>
        <table class="rates-table">
            <thead><tr><th>Meal</th><th>Tier</th><th>Meals Served</th><th>Rate</th><th>Reimbursement</th></tr></thead>
            <tbody>
                ${CACFP_MEAL_TYPES.map(mt => CACFP_TIERS.map(t => {
                    const line = lines.find(l => l.meal_type === mt.id && l.tier === t.id);
                    if (!line) return '';
                    return `<tr>
                        <td>${escHtml(mt.label)}</td>
                        <td>${escHtml(t.label)}</td>
                        <td>${line.meal_count}</td>
                        <td>$${Number(line.rate_applied).toFixed(4)}</td>
                        <td>$${Number(line.reimbursement_amount).toFixed(2)}</td>
                    </tr>`;
                }).join('')).join('')}
                <tr style="font-weight:700;background:var(--warm-gray)">
                    <td colspan="2">Total</td>
                    <td>${grandMeals}</td>
                    <td></td>
                    <td>$${total.toFixed(2)}</td>
                </tr>
            </tbody>
        </table>`;
}

function _exportCacfpClaimCsv() {
    if (!_cacfpCurrentClaim) { alert('Generate the claim first.'); return; }
    const { period, lines } = _cacfpCurrentClaim;
    const rows = [['Month', period.month], ['Status', period.status], [],
        ['Meal Type', 'Tier', 'Meals Served', 'Rate', 'Reimbursement']];
    lines.forEach(l => rows.push([
        CACFP_MEAL_TYPES.find(m => m.id === l.meal_type)?.label || l.meal_type,
        CACFP_TIERS.find(t => t.id === l.tier)?.label || l.tier,
        l.meal_count, Number(l.rate_applied).toFixed(4), Number(l.reimbursement_amount).toFixed(2),
    ]));
    const total = lines.reduce((s, l) => s + Number(l.reimbursement_amount), 0);
    rows.push([], ['Total', '', '', '', total.toFixed(2)]);
    const csv = rows.map(r => r.map(csvCell).join(',')).join('\n');
    downloadFile(`cacfp-claim-${period.month}.csv`, 'text/csv', csv);
}

function _printCacfpClaim() {
    if (!_cacfpCurrentClaim) { alert('Generate the claim first.'); return; }
    const { period, lines } = _cacfpCurrentClaim;
    const total = lines.reduce((s, l) => s + Number(l.reimbursement_amount), 0);
    const rowsHtml = CACFP_MEAL_TYPES.map(mt => CACFP_TIERS.map(t => {
        const line = lines.find(l => l.meal_type === mt.id && l.tier === t.id);
        if (!line) return '';
        return `<tr><td>${escHtml(mt.label)}</td><td>${escHtml(t.label)}</td><td>${line.meal_count}</td>` +
            `<td>$${Number(line.rate_applied).toFixed(4)}</td><td>$${Number(line.reimbursement_amount).toFixed(2)}</td></tr>`;
    }).join('')).join('');

    const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8"><title>CACFP Claim — ${period.month}</title>
<style>
  body{font-family:sans-serif;padding:24px;color:#222}
  h1{font-size:1.3em;margin-bottom:4px}
  table{border-collapse:collapse;width:100%;margin-top:16px}
  th,td{border:1px solid #ccc;padding:6px 10px;text-align:left;font-size:.92em}
  th{background:#f2f2f2}
  tfoot td{font-weight:700}
</style></head>
<body>
  <h1>CACFP Monthly Claim — ${period.month}</h1>
  <p>Status: ${period.status === 'finalized' ? 'Finalized' : 'Draft'} &middot; Printed ${new Date().toLocaleString('en-US')}</p>
  <table>
    <thead><tr><th>Meal</th><th>Tier</th><th>Meals Served</th><th>Rate</th><th>Reimbursement</th></tr></thead>
    <tbody>${rowsHtml}</tbody>
    <tfoot><tr><td colspan="4">Total</td><td>$${total.toFixed(2)}</td></tr></tfoot>
  </table>
  <script>window.onload = () => window.print();<\/script>
</body></html>`;

    const w = window.open('', '_blank');
    if (!w) { alert('Pop-up was blocked. Please allow pop-ups for this site and try again.'); return; }
    w.document.write(html);
    w.document.close();
}

async function _finalizeCacfpClaim() {
    if (!_cacfpCurrentClaim) { alert('Generate the claim first.'); return; }
    if (_cacfpCurrentClaim.period.status === 'finalized') { alert('This claim is already finalized.'); return; }
    if (!confirm('Finalize this claim? The numbers will be locked and will not update automatically if meal counts change later.')) return;

    const btn = document.getElementById('cacfpFinalizeClaimBtn');
    btn.disabled = true;
    try {
        await finalizeCacfpClaimPeriod(_cacfpCurrentClaim.period.id, window._adminSession?.user?.email || '');
        _cacfpCurrentClaim.period = await fetchCacfpClaimPeriod(_cacfpCurrentClaim.period.month);
        _renderCacfpClaim();
    } catch (err) {
        alert('Error finalizing claim: ' + err.message);
    } finally {
        btn.disabled = false;
    }
}
