// ============================================================
// admin-incidents — the director's incident queue and sign-off drawer
// ============================================================
// Design handoff, Admin Desktop Companion `1g`: a 520px right-hand drawer over
// a dimmed records list, three tabs, and the full report with her sign-off
// action inside it.
//
// ⚠️ SHE IS SIGNATURE 3, NOT SIGNATURE 2. The parent has already signed at
// pickup on the teacher's phone; her signature closes the record and unlocks
// the printable copy. If the parent has not signed yet, the drawer says so and
// does not offer the button — and the database refuses it independently, so a
// modified client gets `false` rather than an out-of-order record.
//
// ⚠️ SIGNING IS PUBLICATION. A report the family cannot read yet is a family
// that has not been told the whole story, so the queue leads with how long each
// one has been waiting. "Return" sends it back to be rewritten rather than
// deleting it — nothing here can delete a report, because there is no DELETE
// grant on incident_reports for anyone.
//
// ⚠️ THE PRINTED COPY IS NOT RENDERED FROM THIS PAGE'S DATA. It comes from
// incident_print_record(), which refuses to assemble one until all three
// signatures exist. Never build a print view from `_incData` — that is exactly
// the "client screenshot" the handoff rules out, and it would print
// half-signed reports.

let _incData    = [];
let _incSigs    = {};     // incident_id -> { teacher, parent, director }
let _incFilter  = 'submitted';
let _incOpenId  = null;
let _incComposeOpen  = false;   // "+ Write a report" panel
let _incComposeState = null;    // chip/checkbox/witness state — see staff-incident.js's slIncState

function _incEl(id) { return document.getElementById(id); }

const INC_TYPE_LABEL = {
    injury: 'Injury', illness: 'Illness', behavior: 'Behavior', other: 'Other',
};

// The teacher-facing chip label (incident_kind) vs. the four-value stored
// category (incident_type) — same split incident_kind_and_after_notes.sql
// documents: four chips map to 'injury', one each to 'illness' and 'other'.
const INC_KIND_OPTIONS = ['Fall', 'Bump or bruise', 'Bite', 'Scratch', 'Illness', 'Other'];
const INC_KIND_TO_TYPE = {
    Fall: 'injury', 'Bump or bruise': 'injury', Bite: 'injury', Scratch: 'injury',
    Illness: 'illness', Other: 'other',
};

// The rest of this file's "+ Write a report" fields mirror staff-incident.js's
// form exactly — same chip lists, same body/first-aid/after-notes semantics —
// so a report the director files herself carries the same information a
// teacher's does. See admin_incident_report_full_fields.sql.
const INC_TIME_CHIPS = [
    { label: 'Just now',     mins: 0   },
    { label: '15 min ago',   mins: 15  },
    { label: 'An hour ago',  mins: 60  },
    { label: 'Before lunch', mins: 190 },
];
const INC_BODY_CHIPS = ['Forehead', 'Knee', 'Elbow', 'Lip', 'Hand', 'Back of head'];
const INC_AID = ['Cold pack', 'Comfort / rest', 'Cleaned', 'Bandage', 'None needed'];
const INC_AFTER = [
    'Back to playing within 5 minutes',
    'Parent called at the time',
    'Medical attention recommended',
];

const INC_TABS = [
    { key: 'submitted', label: 'Awaiting sign-off' },
    { key: 'approved',  label: 'Signed &amp; sent' },
    { key: 'returned',  label: 'Returned to teacher' },
];

// How long a family has been waiting, which is the thing that should nag.
function _incWaiting(iso) {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 60)   return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24)    return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
    const days = Math.round(hrs / 24);
    return days === 1 ? 'yesterday' : `${days} days ago`;
}

function _incTime(iso) {
    return iso ? new Date(iso).toLocaleString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
    }).replace(/\s?([AP])M/i, (_, p) => p.toLowerCase()) : '—';
}

// students has no room column — only room_override, with the rest derived from
// date of birth. Same derivation the roster uses, so the drawer and the
// classroom list never disagree about which room a child is in.
function _incRoom(st) {
    if (!st) return '';
    const id = st.room_override || (typeof getRoomIdFromDob === 'function'
        ? getRoomIdFromDob(st.child_dob) : null);
    const room = (typeof ROOMS !== 'undefined' ? ROOMS : []).find(r => r.id === id);
    return room ? room.label : '';
}

function _incWhen(iso) {
    return iso ? new Date(iso).toLocaleString('en-US', {
        weekday: 'long', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
    }) : '—';
}

async function renderIncidentsTool() {
    const wrap = _incEl('incidentsBody');
    if (!wrap) return;
    wrap.innerHTML = '<p class="muted">Loading…</p>';
    try {
        _incData = await fetchIncidentReports({ status: _incFilter || null });
        const sigs = await fetchIncidentSignatures(_incData.map(r => r.id));
        _incSigs = {};
        for (const s of sigs) {
            (_incSigs[s.incident_id] ||= {})[s.role] = s;
        }
    } catch (e) {
        wrap.innerHTML = `<p class="muted">Could not load reports: ${escHtml(e.message || e)}</p>`;
        return;
    }
    _incRender();
}

function _incRender() {
    const wrap = _incEl('incidentsBody');
    if (!wrap) return;

    const tabs = INC_TABS.map(t =>
        `<button class="inc-tab ${_incFilter === t.key ? 'active' : ''}" data-filter="${t.key}">
            ${t.label}${_incFilter === t.key ? ` · ${_incData.length}` : ''}
         </button>`).join('');
    const composeBtn = `<button type="button" class="btn-primary inc-compose-open" id="incComposeOpenBtn">&#43; Write a report</button>`;

    const rows = _incData.length ? _incData.map(r => {
        const child = r.students?.child_name || 'Unknown child';
        const sig   = _incSigs[r.id] || {};
        const day   = new Date(r.occurred_at).toLocaleDateString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric', timeZone: 'America/Chicago',
        });
        const isToday = new Date(r.occurred_at).toDateString() === new Date().toDateString();

        // The stage badge is what stops her opening a row she cannot act on.
        let stage, stageCls;
        if (r.status === 'approved')      { stage = 'Closed';            stageCls = 'ok'; }
        else if (r.status === 'returned') { stage = 'With the teacher';  stageCls = 'no'; }
        else if (sig.parent)              { stage = 'Ready for you';     stageCls = 'ready'; }
        else                              { stage = 'Waiting on parent'; stageCls = 'wait'; }

        return `<button class="inc-row${_incOpenId === r.id ? ' is-open' : ''}" data-open="${r.id}">
            <span class="inc-row-icon">🩹</span>
            <span class="inc-row-main">
                <span class="inc-row-title">${escHtml(child)} · ${escHtml(_incRoom(r.students))}
                    ${escHtml(isToday ? `${_incTime(r.occurred_at)} today` : `${day} ${_incTime(r.occurred_at)}`)}</span>
                <span class="inc-row-sub">${escHtml(
                    (r.incident_kind || INC_TYPE_LABEL[r.incident_type] || '') +
                    (r.location ? ' · ' + r.location : '') +
                    (r.reported_by_name ? ' · ' + r.reported_by_name : ''))}</span>
            </span>
            <span class="inc-stage ${stageCls}">${stage}</span>
            <span class="inc-row-open">Open</span>
        </button>`;
    }).join('') : `<p class="muted" style="padding:18px 2px">${
        _incFilter === 'submitted'
            ? 'Nothing waiting. Every filed report has been reviewed.'
            : 'Nothing here.'}</p>`;

    wrap.innerHTML = `
        <div class="inc-tabs-row">
            <div class="inc-tabs">${tabs}</div>
            ${composeBtn}
        </div>
        ${_incComposeOpen ? _incComposeHtml(_incComposeStudentList()) : ''}
        <div class="inc-list">${rows}</div>
        <div class="inc-scrim${_incOpenId ? '' : ' hidden'}" id="incScrim"></div>
        <aside class="inc-drawer${_incOpenId ? ' is-open' : ''}" id="incDrawer"
               role="dialog" aria-modal="true" aria-labelledby="incDrawerName"></aside>`;

    _incBind();
    if (_incComposeOpen) _incComposeWireExtras();
    if (_incOpenId) _incRenderDrawer();
}

function _incBind() {
    document.querySelectorAll('.inc-tab').forEach(b => {
        b.onclick = () => { _incFilter = b.dataset.filter; _incOpenId = null; renderIncidentsTool(); };
    });
    document.querySelectorAll('[data-open]').forEach(b => {
        b.onclick = () => { _incOpenId = Number(b.dataset.open); _incRender(); };
    });
    _incEl('incScrim')?.addEventListener('click', _incCloseDrawer);
    _incEl('incComposeOpenBtn')?.addEventListener('click', _incOpenCompose);
    _incEl('incComposeCancel')?.addEventListener('click', _incCloseCompose);
    _incEl('incComposeSave')?.addEventListener('click', _incComposeSave);
}

// ── "+ Write a report" — the director files it herself ──────
// Filing IS signing (she's signature 1, same rule as a teacher's own report —
// see admin_submit_incident_report). The parent still has to sign at pickup
// on the teacher's phone before this can be closed; it lands in "Waiting on
// parent" like any other freshly-filed report.

function _incComposeStudentList() {
    if (typeof allFamiliesData === 'undefined') return [];
    return allFamiliesData
        .flatMap(f => (f.students || []).map(s => ({ id: s.id, name: s.child_name })))
        .filter(s => s.id && s.name)
        .sort((a, b) => a.name.localeCompare(b.name));
}

function _incComposeFreshState() {
    return {
        occurred:    new Date(),      // clamped to never-future, same rule as staff
        bodyView:    'front',
        bodyPart:    '',
        aid:         new Set(),
        after:       new Set(),
        witnesses:   [],
        location:    '',
        description: '',
        actionTaken: '',
        ratioNote:   '',
    };
}

async function _incOpenCompose() {
    _incComposeOpen  = true;
    _incComposeState = _incComposeFreshState();
    if (typeof allFamiliesData !== 'undefined' && !allFamiliesData.length && typeof loadFamilies === 'function') {
        try { await loadFamilies(); } catch (e) { console.warn('incident compose: loadFamilies failed', e); }
    }
    // Staff-to-child ratio, prefilled the same way slIncRatioNote() derives it
    // for a teacher's own report — a number counted by the office, not typed
    // from memory. Best-effort: an empty/failed read just leaves the field
    // blank rather than blocking the form.
    if (typeof centerHeadcountAdmin === 'function') {
        try {
            const board = await centerHeadcountAdmin();
            const present = (board?.children || []).filter(c => c.attendance_status === 'present').length;
            if (present) _incComposeState.ratioNote = `${present} children present in the room at the time`;
        } catch (e) { console.warn('incident compose: ratio note fetch failed', e); }
    }
    _incRender();
}

function _incCloseCompose() {
    _incComposeOpen  = false;
    _incComposeState = null;
    _incRender();
}

function _incComposeHtml(students) {
    const options = students.map(s => `<option value="${escHtml(s.id)}">${escHtml(s.name)}</option>`).join('');
    const pad = n => String(n).padStart(2, '0');
    const d = _incComposeState?.occurred || new Date();
    const dateVal = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const timeVal = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
    return `<div class="inc-compose">
        <h3 class="inc-compose-title">Write a report</h3>
        <div class="inc-compose-field">
            <label for="incComposeChild">Child</label>
            <select id="incComposeChild">
                <option value="">${students.length ? 'Select a child…' : 'Loading…'}</option>
                ${options}
            </select>
        </div>
        <div class="inc-compose-field">
            <label for="incComposeKind">Type</label>
            <select id="incComposeKind">${INC_KIND_OPTIONS.map(k =>
                `<option value="${escHtml(k)}">${escHtml(k)}</option>`).join('')}</select>
        </div>
        <div class="inc-compose-grid2">
            <div class="inc-compose-field">
                <label for="incComposeDate">Date it happened</label>
                <input type="date" id="incComposeDate" value="${dateVal}">
            </div>
            <div class="inc-compose-field">
                <label for="incComposeTime">Time it happened</label>
                <input type="time" id="incComposeTime" value="${timeVal}">
            </div>
        </div>
        <div class="inc-compose-field">
            <label>Quick pick</label>
            <div class="inc-chip-row" id="incComposeTimeChips"></div>
        </div>
        <div class="inc-compose-field">
            <label for="incComposeLocation">Location</label>
            <input type="text" id="incComposeLocation" placeholder="Where did it happen?"
                   value="${escHtml(_incComposeState?.location || '')}">
        </div>
        <div class="inc-compose-field" id="incComposeBodyBlock">
            <label>Mark on skin</label>
            <div class="inc-chip-row" id="incComposeBodyViews"></div>
            <div class="inc-chip-row" id="incComposeBodyChips"></div>
        </div>
        <div class="inc-compose-field">
            <label for="incComposeDesc">What happened</label>
            <textarea id="incComposeDesc" rows="3"
                      placeholder="Describe what happened…">${escHtml(_incComposeState?.description || '')}</textarea>
        </div>
        <div class="inc-compose-field">
            <label>Care given</label>
            <div class="inc-chip-row" id="incComposeAidChips"></div>
        </div>
        <div class="inc-compose-field">
            <label for="incComposeAction">What we did</label>
            <textarea id="incComposeAction" rows="2"
                      placeholder="First aid, comfort given, etc.">${escHtml(_incComposeState?.actionTaken || '')}</textarea>
        </div>
        <div class="inc-compose-field">
            <label>Since then</label>
            <div class="inc-compose-checks" id="incComposeAfterChecks"></div>
        </div>
        <div class="inc-compose-field">
            <label>Witnesses</label>
            <div class="inc-chip-row" id="incComposeWitnesses"></div>
            <div class="inc-witness-add">
                <input type="text" id="incComposeWitnessInput" placeholder="Who else saw it?">
                <button type="button" class="btn-ghost" id="incComposeWitnessAdd">&#43; Add</button>
            </div>
        </div>
        <div class="inc-compose-field">
            <label for="incComposeRatio">Staff-to-child ratio at the time</label>
            <input type="text" id="incComposeRatio" placeholder="e.g. 3 children present in the room at the time"
                   value="${escHtml(_incComposeState?.ratioNote || '')}">
        </div>
        <div class="inc-compose-btns">
            <button type="button" class="btn-primary" id="incComposeSave">Save</button>
            <button type="button" class="btn-ghost" id="incComposeCancel">Cancel</button>
        </div>
    </div>`;
}

// ── Compose extras — chips, checkboxes, witnesses, the time picker ──
// Wired once per render, same as slIncRenderChips()/slIncRenderTime() in the
// staff app: each control mutates _incComposeState and toggles its own DOM
// directly, rather than re-rendering the whole tool (which would blow away
// whatever the director had already typed into the description/action boxes).

function _incComposeWireExtras() {
    if (!_incComposeState) return;

    // Kept in state (not just read from the DOM at save time) so a re-render
    // triggered by something else on the page — opening a drawer row while
    // this panel is still open — doesn't wipe out what was already typed.
    _incEl('incComposeLocation')?.addEventListener('input', e => { _incComposeState.location = e.target.value; });
    _incEl('incComposeDesc')?.addEventListener('input', e => { _incComposeState.description = e.target.value; });
    _incEl('incComposeAction')?.addEventListener('input', e => { _incComposeState.actionTaken = e.target.value; });
    _incEl('incComposeRatio')?.addEventListener('input', e => { _incComposeState.ratioNote = e.target.value; });

    const syncBodyVisibility = () => {
        const kind = _incEl('incComposeKind')?.value;
        _incEl('incComposeBodyBlock')?.classList.toggle('hidden', INC_KIND_TO_TYPE[kind] !== 'injury');
    };
    _incEl('incComposeKind')?.addEventListener('change', syncBodyVisibility);
    syncBodyVisibility();

    _incEl('incComposeDate')?.addEventListener('change', _incComposeSyncTimeFromInputs);
    _incEl('incComposeTime')?.addEventListener('change', _incComposeSyncTimeFromInputs);

    _incRenderComposeTimeChips();
    _incRenderComposeBodyViews();
    _incRenderComposeBodyChips();
    _incRenderComposeAidChips();
    _incRenderComposeAfterChecks();
    _incRenderComposeWitnesses();

    const addWitness = () => {
        const input = _incEl('incComposeWitnessInput');
        const name = (input?.value || '').trim();
        if (!name) return;
        _incComposeState.witnesses.push(name);
        input.value = '';
        _incRenderComposeWitnesses();
    };
    _incEl('incComposeWitnessAdd')?.addEventListener('click', addWitness);
    _incEl('incComposeWitnessInput')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); addWitness(); }
    });
}

// Date + time inputs are the source of truth; a step here re-derives
// _incComposeState.occurred and clamps it the same way slIncStepTime() does —
// no back-date limit, but never into the future.
function _incComposeSyncTimeFromInputs() {
    const dateVal = _incEl('incComposeDate')?.value;
    const timeVal = _incEl('incComposeTime')?.value || '00:00';
    if (!dateVal) return;
    const [y, m, day] = dateVal.split('-').map(Number);
    const [hh, mm] = timeVal.split(':').map(Number);
    const next = new Date(_incComposeState.occurred);
    next.setFullYear(y, m - 1, day);
    next.setHours(hh, mm, 0, 0);
    if (next.getTime() > Date.now()) {
        showToast('That would be in the future.', 'error');
        _incComposeSetTimeInputs(_incComposeState.occurred);
        return;
    }
    _incComposeState.occurred = next;
    _incRenderComposeTimeChips();
}

function _incComposeSetTimeInputs(d) {
    const pad = n => String(n).padStart(2, '0');
    const dateEl = _incEl('incComposeDate');
    const timeEl = _incEl('incComposeTime');
    if (dateEl) dateEl.value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    if (timeEl) timeEl.value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function _incRenderComposeTimeChips() {
    const wrap = _incEl('incComposeTimeChips');
    if (!wrap) return;
    wrap.innerHTML = INC_TIME_CHIPS.map(c =>
        `<button type="button" class="inc-chip" data-mins="${c.mins}">${escHtml(c.label)}</button>`).join('');
    wrap.querySelectorAll('[data-mins]').forEach(b => {
        const target = Date.now() - Number(b.dataset.mins) * 60000;
        b.classList.toggle('is-on', Math.abs(target - _incComposeState.occurred.getTime()) < 60000);
        b.onclick = () => {
            _incComposeState.occurred = new Date(Date.now() - Number(b.dataset.mins) * 60000);
            _incComposeSetTimeInputs(_incComposeState.occurred);
            _incRenderComposeTimeChips();
        };
    });
}

function _incRenderComposeBodyViews() {
    const wrap = _incEl('incComposeBodyViews');
    if (!wrap) return;
    wrap.innerHTML = ['front', 'back'].map(v =>
        `<button type="button" class="inc-chip" data-view="${v}">${v === 'front' ? 'Front' : 'Back'}</button>`
    ).join('');
    wrap.querySelectorAll('[data-view]').forEach(b => {
        b.classList.toggle('is-on', b.dataset.view === _incComposeState.bodyView);
        b.onclick = () => { _incComposeState.bodyView = b.dataset.view; _incRenderComposeBodyViews(); };
    });
}

function _incRenderComposeBodyChips() {
    const wrap = _incEl('incComposeBodyChips');
    if (!wrap) return;
    wrap.innerHTML = INC_BODY_CHIPS.map(c =>
        `<button type="button" class="inc-chip" data-part="${escHtml(c)}">${escHtml(c)}</button>`).join('');
    wrap.querySelectorAll('[data-part]').forEach(b => {
        b.classList.toggle('is-on', b.dataset.part === _incComposeState.bodyPart);
        b.onclick = () => {
            // A second tap clears it — same as tapping the same figure zone twice.
            _incComposeState.bodyPart = _incComposeState.bodyPart === b.dataset.part ? '' : b.dataset.part;
            _incRenderComposeBodyChips();
        };
    });
}

function _incRenderComposeAidChips() {
    const wrap = _incEl('incComposeAidChips');
    if (!wrap) return;
    wrap.innerHTML = INC_AID.map(a =>
        `<button type="button" class="inc-chip" data-aid="${escHtml(a)}">${escHtml(a)}</button>`).join('');
    wrap.querySelectorAll('[data-aid]').forEach(b => {
        b.classList.toggle('is-on', _incComposeState.aid.has(b.dataset.aid));
        b.onclick = () => {
            const v = b.dataset.aid;
            if (_incComposeState.aid.has(v)) _incComposeState.aid.delete(v); else _incComposeState.aid.add(v);
            b.classList.toggle('is-on', _incComposeState.aid.has(v));
        };
    });
}

function _incRenderComposeAfterChecks() {
    const wrap = _incEl('incComposeAfterChecks');
    if (!wrap) return;
    wrap.innerHTML = INC_AFTER.map(a =>
        `<label class="inc-compose-check"><input type="checkbox" data-after="${escHtml(a)}">
            <span>${escHtml(a)}</span></label>`).join('');
    wrap.querySelectorAll('[data-after]').forEach(b => {
        b.checked = _incComposeState.after.has(b.dataset.after);
        b.onchange = () => {
            const v = b.dataset.after;
            if (b.checked) _incComposeState.after.add(v); else _incComposeState.after.delete(v);
        };
    });
}

// Free text rather than a staff picker, same rationale as staff-incident.js:
// the witness to an office-filed report is as likely a parent or a sub as
// someone on the roster.
function _incRenderComposeWitnesses() {
    const wrap = _incEl('incComposeWitnesses');
    if (!wrap) return;
    wrap.innerHTML = (_incComposeState.witnesses.map((w, i) =>
        `<span class="inc-chip is-on">${escHtml(w)}
            <button type="button" class="inc-chip-x" data-drop="${i}"
                    aria-label="Remove ${escHtml(w)}">&#10005;</button></span>`
    ).join('')) || '<span class="muted inc-witness-empty">None added</span>';
    wrap.querySelectorAll('[data-drop]').forEach(b => {
        b.onclick = () => {
            _incComposeState.witnesses.splice(Number(b.dataset.drop), 1);
            _incRenderComposeWitnesses();
        };
    });
}

async function _incComposeSave() {
    const studentId   = _incEl('incComposeChild')?.value;
    const kind        = _incEl('incComposeKind')?.value;
    const description = _incEl('incComposeDesc')?.value?.trim();
    const typedAction = _incEl('incComposeAction')?.value?.trim();
    const location     = _incEl('incComposeLocation')?.value?.trim();
    const ratioNote    = _incEl('incComposeRatio')?.value?.trim();
    if (!studentId) { showToast('Choose a child.', 'error'); return; }

    const aid = [..._incComposeState.aid];
    // action_taken is NOT NULL and the RPC rejects an empty one — same rule
    // as the staff form: a checked "Cold pack" chip with nothing typed has in
    // fact told us what was done, so build the sentence rather than blocking.
    const actionTaken = typedAction || (aid.length ? aid.join(', ') : '');
    if (!description || !actionTaken) {
        showToast('Describe what happened and what you did about it.', 'error');
        return;
    }

    const isInjury = INC_KIND_TO_TYPE[kind] === 'injury';
    const btn = _incEl('incComposeSave');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Saving…';
    try {
        const id = await adminSubmitIncidentReport({
            studentId, incidentType: INC_KIND_TO_TYPE[kind] || 'other',
            incidentKind: kind, description, actionTaken,
            location, occurredAt: _incComposeState.occurred.toISOString(),
            bodyArea: isInjury ? _incComposeState.bodyPart : '',
            bodyPart: isInjury ? _incComposeState.bodyPart : '',
            bodyView: isInjury ? _incComposeState.bodyView : null,
            witnesses:  _incComposeState.witnesses,
            firstAid:   aid,
            afterNotes: [..._incComposeState.after],
            ratioNote,
        });
        if (id == null) {
            showToast("Couldn't save — check your admin role.", 'error');
            return;
        }
        showToast('Report filed. It needs the parent’s signature at pickup before you can sign off.');
        _incComposeOpen  = false;
        _incComposeState = null;
        _incFilter = 'submitted';
        await renderIncidentsTool();
    } catch (e) {
        showToast('Error: ' + (e.message || e), 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = label;
    }
}

function _incCloseDrawer() {
    _incOpenId = null;
    _incRender();
}

// ── The drawer ──────────────────────────────────────────────

function _incRenderDrawer() {
    const r = _incData.find(x => x.id === _incOpenId);
    const el = _incEl('incDrawer');
    if (!r || !el) return;

    const sig      = _incSigs[r.id] || {};
    const child    = r.students?.child_name || 'Unknown child';
    const complete = !!(sig.teacher && sig.parent && sig.director);
    const canSign  = r.status === 'submitted' && !!sig.parent;

    const facts = [
        ['Care given',   (r.first_aid || []).join(', ')],
        ['Mark on skin', r.body_part || r.body_area],
        ['Witness',      (r.witnesses || []).join(', ')],
        ['Logged by',    r.reported_by_name
                            ? `${r.reported_by_name}, ${_incTime(r.filed_at || r.created_at)}` : ''],
        ['Ratio at the time', r.ratio_note],
    ].filter(([, v]) => v);

    el.innerHTML = `
        <div class="inc-dr-head">
            <div>
                <div class="inc-dr-eyebrow">${escHtml(
                    r.status === 'approved' ? 'Closed'
                  : r.status === 'returned' ? 'Returned to the teacher'
                  : sig.parent ? 'Awaiting your sign-off' : 'Awaiting the parent')}</div>
                <h3 id="incDrawerName">${escHtml(child)}</h3>
                <div class="inc-dr-sub">${escHtml(
                    `${_incRoom(r.students)} · ${_incWhen(r.occurred_at)}`)}</div>
            </div>
            <button class="inc-dr-x" id="incDrawerClose" aria-label="Close">✕</button>
        </div>

        ${r.students?.allergies ? `<div class="inc-dr-alert">${escHtml(r.students.allergies)}</div>` : ''}

        <div class="inc-dr-body">
            <div class="inc-dr-field">
                <div class="inc-dr-label">What happened</div>
                <p>${escHtml(r.description)}</p>
            </div>
            ${facts.length ? `<div class="inc-dr-grid">${facts.map(([k, v]) =>
                `<div><div class="inc-dr-label">${escHtml(k)}</div><div>${escHtml(v)}</div></div>`
            ).join('')}</div>` : ''}
            <div class="inc-dr-field">
                <div class="inc-dr-label">What we did</div>
                <p>${escHtml(r.action_taken)}</p>
            </div>
            ${(r.after_notes || []).length ? `<div class="inc-dr-field">
                <div class="inc-dr-label">Since then</div>
                <p>${escHtml((r.after_notes || []).join(' · '))}</p>
            </div>` : ''}

            <!-- Both timestamps, never collapsed. The gap between them is how
                 long it took to write down, which is information. -->
            <div class="inc-dr-grid">
                <div><div class="inc-dr-label">Happened</div><div>${escHtml(_incTime(r.occurred_at))}</div></div>
                <div><div class="inc-dr-label">Filed</div><div>${escHtml(_incTime(r.filed_at || r.created_at))}</div></div>
            </div>

            ${_incSigBlock(sig)}
        </div>

        ${r.status === 'submitted' ? `
        <div class="inc-dr-actions">
            <div class="inc-dr-label">Add a note before it goes to the parent</div>
            <textarea class="inc-dr-note" id="incDrawerNote" rows="3"
                      placeholder="Optional — the family reads this with the report."></textarea>
            <p class="inc-dr-explain">${canSign
                ? `Signing sends the report and your note to the family in the parent app,
                   and unlocks the printable copy. Nothing reaches a parent before you sign.`
                : `<strong>The parent hasn't signed yet.</strong> They sign at pickup on the
                   teacher's phone — you're the third signature, so this stays here until
                   they have.`}</p>
            <div class="inc-dr-btns">
                <button class="btn-primary inc-sign" ${canSign ? '' : 'disabled'}>✓ Sign &amp; send to parent</button>
                <button class="btn-ghost inc-return">Return to ${escHtml(
                    (r.reported_by_name || 'the teacher').split(' ')[0])}</button>
            </div>
        </div>` : ''}

        <div class="inc-dr-foot">
            <button class="btn-ghost inc-pdf" ${complete ? '' : 'disabled'}>
                ${complete ? '🖨️ Print the signed copy' : '🔒 Print — needs all three signatures'}
            </button>
            ${r.reviewed_by ? `<span class="inc-dr-signedas">Signed as ${escHtml(r.reviewed_by)}${
                r.reviewed_at ? ' · ' + _incTime(r.reviewed_at) : ''}</span>` : ''}
        </div>`;

    _incEl('incDrawerClose').onclick = _incCloseDrawer;
    el.querySelector('.inc-sign')?.addEventListener('click', e => _incSign(r.id, e.currentTarget));
    el.querySelector('.inc-return')?.addEventListener('click', e => _incReturn(r.id, e.currentTarget));
    el.querySelector('.inc-pdf')?.addEventListener('click', () => incidentPrint(r.id));
}

function _incSigBlock(sig) {
    const rows = [
        { role: 'teacher',  n: 1, who: 'Teacher',  wait: 'not filed' },
        { role: 'parent',   n: 2, who: 'Parent',   wait: 'signs at pickup on the teacher’s phone' },
        { role: 'director', n: 3, who: 'Director', wait: 'waiting on the parent' },
    ].map(r => {
        const s = sig[r.role];
        return `<div class="inc-sig${s ? ' is-done' : ''}">
            <span class="inc-sig-n">${r.n}</span>
            <span class="inc-sig-who">
                <span class="inc-sig-name">${escHtml(s ? s.signed_name : '—')}</span>
                <span class="inc-sig-status">${escHtml(
                    s ? `${r.who} · ${_incTime(s.signed_at)}${
                        s.on_device_of ? ` · on ${s.on_device_of}’s phone` : ''}`
                      : `${r.who} · ${r.wait}`)}</span>
            </span>
            ${s ? `<span class="inc-sig-mark">${escHtml(s.signed_name)}</span>`
                : '<span class="inc-sig-locked">Waiting</span>'}
        </div>`;
    }).join('');

    return `<div class="inc-dr-field">
        <div class="inc-dr-label">Signatures — in order</div>
        <div class="inc-sig-list">${rows}</div>
    </div>`;
}

// ── Actions ─────────────────────────────────────────────────

async function _incSign(id, btn) {
    const notes = _incEl('incDrawerNote')?.value?.trim() || '';

    // Signing tells a family their child was hurt and closes a record that
    // cannot then be unsigned. That is not an action to fire on a stray tap.
    if (!confirm('Sign this report? The family will be able to read it and will be notified, and the record closes.')) return;

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Signing…';
    try {
        const ok = await signIncidentAsDirector(id, null, notes);
        if (!ok) {
            // The most likely cause: the parent signature landed after this
            // page was loaded, or never did. Either way, re-read rather than
            // guess out loud.
            showToast('That signature was not accepted — the parent may not have signed yet.', 'error');
            await renderIncidentsTool();
            return;
        }
        await _incNotifyFamily(id);
        showToast('Signed. The family can read it now.');
        _incOpenId = null;
        await renderIncidentsTool();
    } catch (e) {
        showToast('Error: ' + (e.message || e), 'error');
    } finally {
        btn.disabled = false; btn.textContent = label;
    }
}

async function _incReturn(id, btn) {
    const notes = _incEl('incDrawerNote')?.value?.trim() || '';
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Sending back…';
    try {
        const ok = await reviewIncidentReport(id, 'returned', notes);
        if (!ok) { showToast('That did not go through.', 'error'); return; }
        showToast('Sent back to staff.');
        _incOpenId = null;
        await renderIncidentsTool();
    } catch (e) {
        showToast('Error: ' + (e.message || e), 'error');
    } finally {
        btn.disabled = false; btn.textContent = label;
    }
}

// The notification deliberately carries NO detail — not the injury, not the
// body part. A lock-screen preview is read in public, by whoever is holding the
// phone. It says to open the portal, where the actual report is.
async function _incNotifyFamily(id) {
    const rep = _incData.find(r => r.id === id);
    const familyId = rep?.students?.family_id;
    if (!familyId) return;
    try {
        const { data: { session } } = await sbClient.auth.getSession();
        await fetch('/send-push', {
            method:  'POST',
            headers: {
                'Content-Type':  'application/json',
                'Authorization': `Bearer ${session?.access_token || ''}`,
            },
            body: JSON.stringify({
                family_id: familyId,
                title: 'A note from MDO',
                body:  'The director has shared a report about your child. Please open the portal.',
            }),
        });
    } catch (e) {
        // The report is signed and readable either way; a failed push must not
        // make the director think the signature failed.
        console.warn('incident notify (non-fatal):', e);
    }
}

// ── Print ───────────────────────────────────────────────────
// Opens the standalone one-page record. That page fetches the document from
// incident_print_record(), which is where the three-signature gate lives — this
// function deliberately passes an id and nothing else, so there is no way for
// the admin page's own copy of the data to end up on paper.
function incidentPrint(id) {
    window.open(`incident-print.html?id=${encodeURIComponent(id)}`, '_blank', 'noopener');
}
