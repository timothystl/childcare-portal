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

function _incEl(id) { return document.getElementById(id); }

const INC_TYPE_LABEL = {
    injury: 'Injury', illness: 'Illness', behavior: 'Behavior', other: 'Other',
};

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
        <div class="inc-tabs">${tabs}</div>
        <div class="inc-list">${rows}</div>
        <div class="inc-scrim${_incOpenId ? '' : ' hidden'}" id="incScrim"></div>
        <aside class="inc-drawer${_incOpenId ? ' is-open' : ''}" id="incDrawer"
               role="dialog" aria-modal="true" aria-labelledby="incDrawerName"></aside>`;

    _incBind();
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
