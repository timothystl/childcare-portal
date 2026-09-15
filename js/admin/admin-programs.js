// ============================================================
// MODULE: Programs & add-ons  (design handoff: Capacity & Fill, 4d)
// ============================================================
// Settings → Rooms & rates gains a second table. Before care, after care
// and camps each carry their own hours, rate and ratio, so the staffing
// tools, the parent's add-days screen and the before/after care screen all
// read one definition rather than three hardcoded guesses.
//
// ⚠️ Only camp carries a CAPACITY. Andrew: "the pre-k before care and after
// care is not a room, just a charge that is applied if a child attends."
// See _pgCapacityCell() below for what that rules out and why.
//
// ── Why a program is not a room ─────────────────────────────
// A room is a place a child is ENROLLED in: it consumes room capacity,
// drives the ratio math, has a waitlist, and appears in the fill forecast.
// A program is an add-on to a day that is already happening. Modelling
// before care as a sixth room would put six morning children into the
// enrollment numbers and the capacity planner, where they do not belong
// and where they would double-count against the room the same child sits
// in at 9:01.
//
// So programs live in `settings.programs` — the same key/value document
// pattern room_rates, staff_ratios, room_capacities and geofence already
// use. One admin-editable JSON blob, no migration, no new RLS policy, and
// nothing new in the capacity path. PROGRAMS/PROGRAM_FEES in js/supabase.js
// are the shape and the defaults.
//
// ⚠️ After care's ratio is NOT editable here, and that is deliberate. The
// pooled afternoon group has exactly one definition — PM_COMBINED_RATIO,
// read by apStaffing(), Build Staff Schedule and the live Attendance
// Board's ratio watch. A second, editable copy on this screen would let a
// director change the number here and have the staffing grid quietly
// disagree with the roster. The field renders as a read-only value that
// says where it comes from.

let _pgBound = false;
let _pgState = null;     // { programs, fees } as loaded/edited

function _pgEl(id) { return document.getElementById(id); }

function _pgTime(hhmm) {
    if (!hhmm) return '';
    const [h, m] = String(hhmm).split(':').map(Number);
    const ampm = h >= 12 ? 'p' : 'a';
    const h12 = h % 12 === 0 ? 12 : h % 12;
    return `${h12}:${String(m).padStart(2, '0')}${ampm}`;
}

function _pgRateLabel(p) {
    if (p.kind === 'standing') return `$${p.rate}/wk`;
    if (p.kind === 'camp')     return `$${p.rate}/day`;
    return `$${p.rate}`;
}

// After care's ratio comes from one place; see the header.
function _pgRatioCell(p) {
    if (p.id === 'after_care') {
        return `<span class="pg-locked" title="Defined by PM_COMBINED_RATIO — the pooled afternoon group the staffing grid and the attendance board both read">
                    1:${PM_COMBINED_RATIO} <span class="pg-locked-note">shared</span>
                </span>`;
    }
    if (p.sharesRatioWith) {
        return `<span class="pg-locked">shares ${escHtml(p.sharesRatioWith.replace(/_/g, ' '))}</span>`;
    }
    return `<input type="number" class="pg-input" data-pg-field="ratio" value="${p.ratio ?? ''}" min="1" step="1" placeholder="1:">`;
}

// ⚠️ Only a program that is BOOKED AHEAD has a capacity. Andrew: "the pre-k
// before care and after care is not a room, just a charge that is applied if
// a child attends." Nobody reserves a morning, so there is no seat to hold —
// what limits the floor is the ratio, and that has its own column. Camp is
// the exception and the only one: it is booked for a specific week and
// genuinely fills up.
//
// The others render as a dash, not an empty input, on purpose. An editable
// box invites a director to type 20 into it, and the moment a capacity
// exists somebody builds a "spots left" badge on top of it — counting down
// against reservations nobody makes.
function _pgCapacityCell(p) {
    if (p.kind !== 'camp') {
        return `<span class="pg-locked" title="Not booked ahead — the charge follows attendance, so there is no seat to hold.">—</span>`;
    }
    return `<input type="number" class="pg-input" data-pg-field="capacity" value="${p.capacity ?? ''}" min="0" step="1" placeholder="—">`;
}

function _pgRowHtml(p) {
    return `
        <div class="pg-row${p.active ? '' : ' is-off'}" data-pg-id="${escHtml(p.id)}">
            <div class="pg-row-head">
                <label class="pg-toggle">
                    <input type="checkbox" data-pg-field="active" ${p.active ? 'checked' : ''}>
                    <span>${escHtml(p.label)}</span>
                </label>
                <span class="pg-scope">${escHtml(p.scope || '')}</span>
            </div>
            <div class="pg-fields">
                <div class="pg-field">
                    <span class="pg-label">Starts</span>
                    <input type="time" class="pg-input" data-pg-field="startTime" value="${escHtml(p.startTime || '')}">
                </div>
                <div class="pg-field">
                    <span class="pg-label">Ends</span>
                    <input type="time" class="pg-input" data-pg-field="endTime" value="${escHtml(p.endTime || '')}">
                </div>
                <div class="pg-field">
                    <span class="pg-label">Rate ($)</span>
                    <input type="number" class="pg-input" data-pg-field="rate" value="${p.rate ?? ''}" min="0" step="0.01">
                    <span class="pg-unit">${escHtml(_pgRateLabel(p))}</span>
                </div>
                <div class="pg-field">
                    <span class="pg-label">Capacity</span>
                    ${_pgCapacityCell(p)}
                </div>
                <div class="pg-field">
                    <span class="pg-label">Ratio</span>
                    ${_pgRatioCell(p)}
                </div>
            </div>
            ${p.note ? `<p class="pg-note">${escHtml(p.note)}</p>` : ''}
        </div>`;
}

async function renderProgramsTable() {
    const wrap = _pgEl('programsTableWrap');
    if (!wrap) return;
    try {
        _pgState = await loadProgramSettings();
    } catch (e) {
        wrap.innerHTML = `<p class="empty-hint">Could not load programs: ${escHtml(e.message || e)}</p>`;
        return;
    }
    const f = _pgState.fees || {};
    wrap.innerHTML = `
        <div class="pg-rows">${_pgState.programs.map(_pgRowHtml).join('')}</div>

        <div class="pg-fees">
            <div class="pg-fees-title">Fees</div>
            <label class="pg-fee">
                <span>Late pickup, per 15 minutes after close</span>
                <input type="number" class="pg-input" id="pgFeeLate" value="${f.latePickupPer15Min ?? ''}" min="0" step="0.01">
            </label>
            <label class="pg-fee">
                <span>Schedule change after the 15th</span>
                <input type="number" class="pg-input" id="pgFeeChange" value="${f.scheduleChangeAfterWindow ?? ''}" min="0" step="0.01">
            </label>
            <label class="pg-fee">
                <span>Camp deposit, credited against the total</span>
                <input type="number" class="pg-input" id="pgFeeDeposit" value="${f.campDeposit ?? ''}" min="0" step="0.01">
            </label>
        </div>

        <p class="rates-hint">💡 A program is an add-on to a day that is already happening, not a room. Before and after care are <strong>a charge that follows attendance</strong> — nobody books them, so they have no capacity and no waitlist, and the number that limits the floor is the ratio. Only camp is booked ahead, so only camp fills up. After care's ratio is shared with the staffing grid's pooled afternoon group and is shown here rather than edited, so the two can never disagree.</p>

        <div class="pg-actions">
            <button type="button" class="btn-primary" id="pgSaveBtn">Save programs</button>
            <span class="set-caption" id="pgStatus"></span>
        </div>`;
    _pgEl('pgSaveBtn')?.addEventListener('click', _pgSave);
}

async function _pgSave() {
    const btn = _pgEl('pgSaveBtn');
    const status = _pgEl('pgStatus');
    if (!btn || !_pgState) return;
    btn.disabled = true;
    btn.textContent = 'Saving…';
    if (status) status.textContent = '';

    try {
        const programs = _pgState.programs.map(p => ({ ...p }));
        const byId = new Map(programs.map(p => [p.id, p]));

        document.querySelectorAll('#programsTableWrap .pg-row[data-pg-id]').forEach(row => {
            const p = byId.get(row.dataset.pgId);
            if (!p) return;
            row.querySelectorAll('[data-pg-field]').forEach(input => {
                const field = input.dataset.pgField;
                if (field === 'active') { p.active = input.checked; return; }
                const val = input.value.trim();
                if (field === 'rate')     { p.rate = val === '' ? null : parseFloat(val); return; }
                if (field === 'capacity') { p.capacity = val === '' ? null : parseInt(val, 10); return; }
                if (field === 'ratio')    { p.ratio = val === '' ? null : parseInt(val, 10); return; }
                p[field] = val || null;
            });
        });

        // After care's ratio is never written from this screen — it is
        // PM_COMBINED_RATIO's, and saving a copy would create the second
        // source of truth the header exists to prevent.
        const ac = byId.get('after_care');
        if (ac) ac.ratio = PM_COMBINED_RATIO;

        // Same reasoning for capacity, in the other direction: a program
        // nobody books has none, so any value a previously saved document
        // still carries is dropped here rather than quietly surviving. A
        // stale capacity is worse than none — it reads like a real limit.
        programs.forEach(p => { if (p.kind !== 'camp') delete p.capacity; });

        const num = (id) => {
            const v = (_pgEl(id)?.value || '').trim();
            return v === '' ? null : parseFloat(v);
        };
        const fees = {
            latePickupPer15Min:        num('pgFeeLate'),
            scheduleChangeAfterWindow: num('pgFeeChange'),
            campDeposit:               num('pgFeeDeposit'),
        };

        await saveProgramSettings({ programs, fees });
        if (typeof logAdminAction === 'function') {
            await logAdminAction('update', 'programs', null,
                { programs: programs.filter(p => p.active).map(p => p.id) });
        }
        _pgState = { programs, fees };
        if (status) status.textContent = 'Saved.';
    } catch (e) {
        if (status) status.textContent = 'Could not save: ' + (e.message || e);
    } finally {
        btn.disabled = false;
        btn.textContent = 'Save programs';
    }
}

function setupProgramsTable() {
    if (_pgBound) return;
    _pgBound = true;
    // Re-render live when a program is switched on or off, so the row dims
    // (and a camp's own date fields appear) without waiting for a save.
    _pgEl('programsTableWrap')?.addEventListener('change', (ev) => {
        const row = ev.target.closest('.pg-row[data-pg-id]');
        if (!row || ev.target.dataset.pgField !== 'active') return;
        row.classList.toggle('is-off', !ev.target.checked);
    });
}
