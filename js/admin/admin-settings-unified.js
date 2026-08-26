// ============================================================
// admin-settings-unified — Settings screen (design handoff:
// design_handoff_messages_settings/Settings.dc.html)
// ============================================================
// One continuous page, no dashboard/tool split, no accordion — ordered by
// how often it's touched: Registration + Rooms & rates side by side up top
// (the two groups touched with any regularity), Access & oversight
// full-width below (rare but high-stakes).
//
// This file owns exactly one genuinely new piece: the combined Rooms &
// rates table, which replaces three separate tables (#ratesTableWrap /
// #ratiosTableWrap / #capacityTableWrap) that all keyed off the same ROOMS
// array. Registration (window override, closed days, Summer Camp) and
// Access & oversight (admin users, audit log) keep their original element
// ids and setup*() functions from admin-calendar.js / admin-settings.js
// completely unchanged — only their markup moved into this page's cards.
//
// "Last changed by" captions read the existing audit log (no new table),
// per entity name. Some of those entities were not being logged at all
// before this redesign (registration window, closures, ratios, admin role
// changes) — logAdminAction() calls were added at each save site rather
// than leaving the caption to read an empty log forever. A caption whose
// producer doesn't exist is the FS29/daysSince mistake this file's own
// CLAUDE.md warns about; don't repeat it here.

let _setAuditCache = null; // fetched once per page open

function _setEl(id) { return document.getElementById(id); }

async function renderSettingsUnifiedTool() {
    _renderRoomsTable();
    await _setLoadAuditCaptions();
    _setBindRoomsSave();
}

// ── "Last changed by" captions ─────────────────────────────────
async function _setLoadAuditCaptions() {
    try {
        _setAuditCache = await fetchAuditLog();
    } catch (err) {
        console.warn('settings captions: could not load audit log:', err);
        _setAuditCache = [];
    }
    _setRenderCaption('regWindowCaption', ['registration_window']);
    _setRenderCaption('summerCampCaption', ['summer_camp_setting']);
    _setRenderCaption('roomsCaption', ['rate_settings', 'ratio_settings', 'capacity_settings', 'room_settings']);
}

function _setRenderCaption(elId, entities) {
    const el = _setEl(elId);
    if (!el) return;
    const entry = (_setAuditCache || []).find(e => entities.includes(e.entity));
    if (!entry) { el.textContent = 'No changes logged yet.'; return; }
    const when = new Date(entry.ts).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    el.textContent = `Last changed by ${entry.admin_email || 'unknown'} · ${when}`;
}

// ── Rooms & rates — ONE table replacing rates + ratios + capacity ──────
function _renderRoomsTable() {
    const wrap = _setEl('roomsTableWrap');
    if (!wrap) return;
    wrap.innerHTML = `
        <table class="rates-table">
            <thead>
                <tr>
                    <th>Room</th>
                    <th>Ages (months)</th>
                    <th>Daily ($)</th>
                    <th>Half-day ($)</th>
                    <th>Weekly full ($)</th>
                    <th>Weekly half ($)</th>
                    <th>Ratio (1:)</th>
                    <th>Capacity</th>
                </tr>
            </thead>
            <tbody>
                ${getSortedRooms().map(room => `
                    <tr data-room-id="${room.id}">
                        <td class="rates-room-label">
                            <strong>${escHtml(room.label)}</strong>
                            ${room.status === 'coming_soon' ? '<span class="rates-badge-soon">Coming Soon</span>' : ''}
                            ${room.status === 'seasonal' ? '<span class="rates-badge-soon" style="background:#e0f2fe;color:#0369a1">Seasonal</span>' : ''}
                        </td>
                        <td>
                            <div style="display:flex;gap:4px;align-items:center;">
                                <input type="number" class="rate-input" data-field="ageMinMonths"
                                    value="${room.ageMinMonths ?? ''}" min="0" step="1" placeholder="min" style="width:52px;">
                                <span>–</span>
                                <input type="number" class="rate-input" data-field="ageMaxMonths"
                                    value="${room.ageMaxMonths ?? ''}" min="0" step="1" placeholder="∞" style="width:52px;">
                            </div>
                        </td>
                        <td><input type="number" class="rate-input" data-field="fullDayRate"
                                value="${room.fullDayRate ?? ''}" min="0" step="0.01" placeholder="0.00" style="width:70px;"></td>
                        <td>${room.fullDayOnly ? '<span class="rates-na">—</span>' :
                            `<input type="number" class="rate-input" data-field="halfDayRate"
                                value="${room.halfDayRate ?? ''}" min="0" step="0.01" placeholder="0.00" style="width:70px;">`}</td>
                        <td><input type="number" class="rate-input" data-field="weeklyFullRate"
                                value="${room.weeklyFullRate ?? ''}" min="0" step="0.01" placeholder="—" style="width:70px;"></td>
                        <td>${room.fullDayOnly ? '<span class="rates-na">—</span>' :
                            `<input type="number" class="rate-input" data-field="weeklyHalfRate"
                                value="${room.weeklyHalfRate ?? ''}" min="0" step="0.01" placeholder="—" style="width:70px;">`}</td>
                        <td><input type="number" class="ratio-input rate-input" data-field="staffRatio"
                                value="${room.staffRatio ?? ''}" min="1" step="1" placeholder="e.g. 4" style="width:56px;"></td>
                        <td><input type="number" class="capacity-input rate-input" data-field="capacity"
                                value="${room.capacity ?? ''}" min="0" step="1" placeholder="e.g. 12" style="width:56px;"></td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
        <p class="rates-hint">💡 Age range controls which room a child is auto-assigned to. Weekly rates apply when a child books all 5 Mon–Fri days in a week with the same day type. Ratio is the maximum children per staff member; capacity is the maximum enrolled children per day.</p>`;
}

function _setBindRoomsSave() {
    const btn = _setEl('saveRoomsBtn');
    if (!btn || btn.dataset.bound) return;
    btn.dataset.bound = '1';
    btn.addEventListener('click', _onSaveRoomsTable);
}

async function _onSaveRoomsTable() {
    const btn      = _setEl('saveRoomsBtn');
    const statusEl = _setEl('roomsStatus');
    if (!btn) return;
    btn.disabled    = true;
    btn.textContent = 'Saving…';
    if (statusEl) statusEl.textContent = '';

    try {
        const rates = {}, ratios = {}, capacities = {};
        document.querySelectorAll('#roomsTableWrap tbody tr[data-room-id]').forEach(row => {
            const id = row.dataset.roomId;
            rates[id] = {};
            row.querySelectorAll('.rate-input[data-field]').forEach(input => {
                const val   = input.value.trim();
                const field = input.dataset.field;
                if (field === 'staffRatio') { ratios[id] = val === '' ? null : parseInt(val, 10); return; }
                if (field === 'capacity')   { capacities[id] = val === '' ? null : parseInt(val, 10); return; }
                if (field === 'ageMinMonths' || field === 'ageMaxMonths') {
                    rates[id][field] = val === '' ? null : parseInt(val, 10);
                } else {
                    rates[id][field] = val === '' ? null : parseFloat(val);
                }
            });
            const r = rates[id];
            const min = r.ageMinMonths ?? 0;
            const max = r.ageMaxMonths ?? null;
            rates[id].ages = max == null ? (min > 0 ? `${min}+ months` : '') : `${min} – ${max} months`;
        });

        await saveRateSettings(rates);
        await saveRatioSettings(ratios);
        await saveCapacitySettings(capacities);
        await logAdminAction('update', 'room_settings', null, { rooms: Object.keys(rates) });

        // Merge straight into ROOMS — avoids a silent DB round-trip failure
        // reverting the display back to hardcoded defaults.
        ROOMS.forEach(room => {
            const r = rates[room.id];
            if (r) {
                if (r.fullDayRate    != null) room.fullDayRate    = r.fullDayRate;
                if (r.halfDayRate    != null) room.halfDayRate    = r.halfDayRate;
                if (r.weeklyFullRate != null) room.weeklyFullRate = r.weeklyFullRate;
                if (r.weeklyHalfRate != null) room.weeklyHalfRate = r.weeklyHalfRate;
                if ('ageMinMonths'   in r)    room.ageMinMonths   = r.ageMinMonths;
                if ('ageMaxMonths'   in r)    room.ageMaxMonths   = r.ageMaxMonths;
                if (r.ages           != null) room.ages           = r.ages;
            }
            if (ratios[room.id] != null)     room.staffRatio = ratios[room.id];
            if (capacities[room.id] != null) room.capacity   = capacities[room.id];
        });
        _renderRoomsTable();
        await _setLoadAuditCaptions();

        if (statusEl) {
            statusEl.textContent = '✓ Saved!';
            statusEl.style.color = '#2e7d32';
            setTimeout(() => { statusEl.textContent = ''; }, 3000);
        }
    } catch (err) {
        if (statusEl) { statusEl.textContent = '⚠️ ' + err.message; statusEl.style.color = '#c62828'; }
        console.error('_onSaveRoomsTable:', err);
    } finally {
        btn.disabled    = false;
        btn.textContent = '💾 Save changes';
    }
}
