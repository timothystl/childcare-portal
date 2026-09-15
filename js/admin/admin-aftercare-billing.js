// ============================================================
// MODULE: Aftercare Billing
// ============================================================
// Finance → Money In → Aftercare Billing.
//
// Lives in Finance, not next to Before & After Care in Classrooms → Daily —
// that group is the staff role's read-only classroom-roster surface
// (apToolAvailable() in admin-portal.js), and this writes real charges to a
// family's invoice.
//
// The office's one write path for care_charges (see
// supabase/migrations/PROPOSED_bill_after_care_charges.sql). Before &
// After Care (admin-before-after-care.js) shows the combined afternoon
// floor and explains the gap; this screen is what closes it — recording
// that a specific child attended, which bills that child's own family.
//
// ── Who this bills, and who it never touches ────────────────
// Goose, Turtle and Owl combine into one supervised group from 1:00p
// (PM_COMBINED_ROOM_IDS). A child with a full-day booking in one of those
// three rooms already paid for that stretch as part of full-day tuition —
// nothing more is owed, and record_care_charge() REFUSES to create a charge
// for that child on that date server-side. This screen mirrors the same
// check before submitting, so the office sees the reason immediately
// instead of a server error, but the server's refusal is what actually
// protects the family's bill.
//
// From 3:00p, Timothy Lutheran Pre-K children who are not in the MDO
// program join the same floor. Those are who this screen actually bills —
// searched from existing families/students if myMDO has already seen them,
// or added on the spot (quick-add) the first time they show up.

let _acbDate = null;
let _acbProgram = 'after_care';
let _acbBound = false;
let _acbFamilies = null;
let _acbCharges = [];
let _acbQuickAddOpen = false;

function _acbEl(id) { return document.getElementById(id); }
function _acbToday() { return new Date().toLocaleDateString('en-CA'); }

function _acbProgramLabel(id) {
    return id === 'before_care' ? 'Before care' : 'After care';
}

/**
 * True if this child already has a full-day booking in the combined
 * afternoon rooms on this date — the same population record_care_charge()
 * refuses server-side. Client-side mirror only, for an immediate warning;
 * the RPC call is the real guard.
 */
function _acbAlreadyCoveredFullDay(childName, date) {
    const key = (childName || '').trim().toLowerCase();
    if (!key || typeof allRegistrations === 'undefined') return false;
    return (allRegistrations || []).some(reg => {
        if ((reg.child_name || '').trim().toLowerCase() !== key) return false;
        return (reg.registration_dates || []).some(d =>
            d.care_date === date &&
            !d.waitlisted &&
            (d.day_type || 'full') === 'full' &&
            PM_COMBINED_ROOM_IDS.includes(d.room_id || reg.room_id));
    });
}

/** Every (family, student) pair across myMDO, flattened for search. */
function _acbAllChildren() {
    const rows = [];
    (_acbFamilies || []).forEach(fam => {
        (fam.students || []).forEach(s => {
            rows.push({ studentId: s.id, childName: s.child_name, familyId: fam.id, parentName: fam.parent_name, parentEmail: fam.parent_email });
        });
    });
    return rows;
}

function _acbMatches(query) {
    const q = (query || '').trim().toLowerCase();
    if (q.length < 2) return [];
    return _acbAllChildren()
        .filter(c => (c.childName || '').toLowerCase().includes(q) || (c.parentName || '').toLowerCase().includes(q))
        .slice(0, 8);
}

// ── Render ──────────────────────────────────────────────────
function _acbChargeRowHtml(c) {
    const childName = c.students?.child_name || '(child removed)';
    const parentName = c.families?.parent_name || '';
    const status = c.waived
        ? `<span class="acb-tag acb-tag-waived" title="${escHtml(c.waived_reason || '')}">Waived</span>`
        : `<span class="acb-tag acb-tag-billed">$${Number(c.rate_charged).toFixed(2)}</span>`;
    return `
        <div class="acb-row" data-charge-id="${c.id}">
            <span class="acb-avatar">${escHtml((childName[0] || '?').toUpperCase())}</span>
            <span class="acb-name">${escHtml(childName)}<small>${escHtml(parentName)}</small></span>
            <span class="acb-program">${escHtml(_acbProgramLabel(c.program_id))}</span>
            ${status}
            ${!c.waived ? `<button type="button" class="ap-pill acb-waive" data-acb-waive="${c.id}">Waive…</button>` : ''}
        </div>`;
}

function _acbSearchResultHtml(c) {
    const blocked = _acbProgram === 'after_care' && _acbAlreadyCoveredFullDay(c.childName, _acbDate);
    return `
        <div class="acb-row acb-result">
            <span class="acb-avatar">${escHtml((c.childName[0] || '?').toUpperCase())}</span>
            <span class="acb-name">${escHtml(c.childName)}<small>${escHtml(c.parentName || '')}</small></span>
            ${blocked
                ? `<span class="acb-tag acb-tag-blocked" title="Already booked a full day in the combined afternoon rooms this date">Already covered</span>`
                : `<button type="button" class="ap-pill" data-acb-charge="${c.studentId}">Record charge</button>`}
        </div>`;
}

function _acbQuickAddHtml() {
    if (!_acbQuickAddOpen) {
        return `<button type="button" class="ap-pill" id="acbOpenQuickAdd">+ Add a new Pre-K child</button>`;
    }
    return `
        <form id="acbQuickAddForm" class="acb-quickadd">
            <div class="acb-quickadd-grid">
                <label>Child's name <input type="text" name="childName" required></label>
                <label>Child's birthdate <input type="date" name="childDob"></label>
                <label>Parent name <input type="text" name="parentName" required></label>
                <label>Parent email <input type="email" name="parentEmail" required></label>
                <label>Parent phone <input type="tel" name="parentPhone"></label>
            </div>
            <p class="empty-hint">Finds the family by email first, so a second Pre-K sibling never creates a duplicate family record.</p>
            <div class="acb-quickadd-actions">
                <button type="submit" class="ap-pill">Add child &amp; record charge</button>
                <button type="button" class="ap-pill" id="acbCancelQuickAdd">Cancel</button>
            </div>
        </form>`;
}

async function renderAftercareBillingTool() {
    const body = _acbEl('acbBody');
    if (!body) return;
    if (!_acbDate) _acbDate = _acbToday();
    body.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        if (!_acbFamilies) _acbFamilies = await fetchAllFamilies();
        if (typeof allRegistrations !== 'undefined' && !allRegistrations.length) {
            allRegistrations = await fetchAllRegistrations().catch(() => []);
        }
        _acbCharges = await fetchCareCharges(_acbDate);

        const label = new Date(_acbDate + 'T00:00:00')
            .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
        const query = _acbEl('acbSearch')?.value || '';
        const matches = _acbMatches(query);

        body.innerHTML = `
            <div class="acb-toolbar">
                <label class="acb-ctrl">
                    <span>Date</span>
                    <input type="date" id="acbDate" value="${escHtml(_acbDate)}">
                </label>
                <label class="acb-ctrl">
                    <span>Program</span>
                    <select id="acbProgram">
                        <option value="after_care" ${_acbProgram === 'after_care' ? 'selected' : ''}>After care (3:00–5:00p)</option>
                        <option value="before_care" ${_acbProgram === 'before_care' ? 'selected' : ''}>Before care (7:30–9:00a)</option>
                    </select>
                </label>
                <span class="acb-day">${escHtml(label)}</span>
            </div>
            <div class="acb-cols">
                <div class="acb-col">
                    <div class="ap-panel">
                        <div class="ap-panel-head">
                            <h3>Record a charge</h3>
                            <p>Search a child already in myMDO, or add a Pre-K child who has never been here before. A child already booked a full day in Goose, Turtle or Owl this date is excluded automatically — that afternoon is already paid for.</p>
                        </div>
                        <input type="search" id="acbSearch" placeholder="Search by child or parent name…" value="${escHtml(query)}" autocomplete="off">
                        <div class="acb-results">
                            ${query.trim().length >= 2
                                ? (matches.length ? matches.map(_acbSearchResultHtml).join('') : '<p class="empty-hint">No match. Add them as a new Pre-K child below.</p>')
                                : ''}
                        </div>
                        <div class="acb-quickadd-wrap">${_acbQuickAddHtml()}</div>
                    </div>
                </div>
                <div class="acb-col">
                    <div class="ap-panel">
                        <div class="ap-panel-head">
                            <h3>Recorded today</h3>
                            <p>${_acbCharges.length ? `${_acbCharges.length} charge${_acbCharges.length === 1 ? '' : 's'} recorded for ${escHtml(label)}.` : 'Nothing recorded yet for this date.'}</p>
                        </div>
                        <div class="acb-list">
                            ${_acbCharges.length ? _acbCharges.map(_acbChargeRowHtml).join('') : '<p class="empty-hint">Record a charge on the left once a child attends.</p>'}
                        </div>
                    </div>
                </div>
            </div>`;

        _acbBindRow();
    } catch (e) {
        console.warn('renderAftercareBillingTool:', e);
        body.innerHTML = `<p class="empty-hint">Could not load: ${escHtml(e.message || String(e))}</p>`;
    }
}

// ── Interaction (re-bound every render, since the body is replaced) ──
function _acbBindRow() {
    const body = _acbEl('acbBody');
    _acbEl('acbDate')?.addEventListener('change', (e) => {
        _acbDate = e.target.value || _acbToday();
        renderAftercareBillingTool();
    });
    _acbEl('acbProgram')?.addEventListener('change', (e) => {
        _acbProgram = e.target.value || 'after_care';
        renderAftercareBillingTool();
    });
    let searchTimer = null;
    _acbEl('acbSearch')?.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(renderAftercareBillingTool, 150);
    });
    _acbEl('acbOpenQuickAdd')?.addEventListener('click', () => {
        _acbQuickAddOpen = true;
        renderAftercareBillingTool();
    });
    _acbEl('acbCancelQuickAdd')?.addEventListener('click', () => {
        _acbQuickAddOpen = false;
        renderAftercareBillingTool();
    });
    _acbEl('acbQuickAddForm')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fd = new FormData(e.target);
        try {
            const result = await adminCreatePrekChild({
                childName: fd.get('childName'),
                childDob: fd.get('childDob') || null,
                parentName: fd.get('parentName'),
                parentEmail: fd.get('parentEmail'),
                parentPhone: fd.get('parentPhone'),
            });
            await recordCareCharge(result.student_id, _acbProgram, _acbDate);
            _acbQuickAddOpen = false;
            _acbFamilies = null; // refetch so the new child shows up in search
            await renderAftercareBillingTool();
        } catch (err) {
            alert(err.message || 'Could not add that child.');
        }
    });
    body?.querySelectorAll('[data-acb-charge]').forEach(btn => {
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                await recordCareCharge(btn.getAttribute('data-acb-charge'), _acbProgram, _acbDate);
                await renderAftercareBillingTool();
            } catch (err) {
                alert(err.message || 'Could not record that charge.');
                btn.disabled = false;
            }
        });
    });
    body?.querySelectorAll('[data-acb-waive]').forEach(btn => {
        btn.addEventListener('click', async () => {
            const reason = prompt('Reason for waiving this charge (required, stays visible on the invoice):');
            if (reason === null) return;
            if (!reason.trim()) { alert('A waived charge needs a reason.'); return; }
            try {
                await waiveCareCharge(btn.getAttribute('data-acb-waive'), reason.trim());
                await renderAftercareBillingTool();
            } catch (err) {
                alert(err.message || 'Could not waive that charge.');
            }
        });
    });
}

function setupAftercareBillingTool() {
    if (_acbBound) return;
    _acbBound = true;
    // Everything on this screen is bound per render (_acbBindRow), since the
    // whole body is replaced on every date/program/search change.
}
