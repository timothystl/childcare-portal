// ============================================================
// admin-incidents — the director's incident review queue
// ============================================================
// ⚠️ APPROVAL IS PUBLICATION. A submitted report is invisible to the family;
// approving it is what makes it readable in the portal and what sends the
// notification. A report sitting in this queue is a parent who has not been
// told yet, so the queue leads with how long each one has been waiting.
//
// "Return" sends it back to be rewritten rather than deleting it. Nothing here
// can delete a report — there is no DELETE grant on incident_reports for
// anyone, because an injury record is not the director's to erase.

let _incData   = [];
let _incFilter = 'submitted';

function _incEl(id) { return document.getElementById(id); }

const INC_TYPE_LABEL = {
    injury: 'Injury', illness: 'Illness', behavior: 'Behavior', other: 'Other',
};

// How long a family has been waiting, which is the thing that should nag.
function _incWaiting(iso) {
    const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
    if (mins < 60)   return `${mins} min ago`;
    const hrs = Math.round(mins / 60);
    if (hrs < 24)    return hrs === 1 ? '1 hour ago' : `${hrs} hours ago`;
    const days = Math.round(hrs / 24);
    return days === 1 ? 'yesterday' : `${days} days ago`;
}

async function renderIncidentsTool() {
    const wrap = _incEl('incidentsBody');
    if (!wrap) return;
    wrap.innerHTML = '<p class="muted">Loading…</p>';
    try {
        _incData = await fetchIncidentReports({ status: _incFilter || null });
    } catch (e) {
        wrap.innerHTML = `<p class="muted">Could not load reports: ${escHtml(e.message || e)}</p>`;
        return;
    }
    _incRender();
}

function _incRender() {
    const wrap = _incEl('incidentsBody');
    if (!wrap) return;

    const tabs = ['submitted', 'approved', 'returned'].map(s =>
        `<button class="inc-tab ${_incFilter === s ? 'active' : ''}" data-filter="${s}">
            ${s === 'submitted' ? 'Waiting on you' : s === 'approved' ? 'Released' : 'Sent back'}
         </button>`).join('');

    if (!_incData.length) {
        wrap.innerHTML = `<div class="inc-tabs">${tabs}</div>
            <p class="muted" style="padding:18px 2px">${
                _incFilter === 'submitted'
                    ? 'Nothing waiting. Every filed report has been reviewed.'
                    : 'Nothing here.'}</p>`;
        _incBind();
        return;
    }

    wrap.innerHTML = `<div class="inc-tabs">${tabs}</div>` + _incData.map(r => {
        const child = r.students?.child_name || 'Unknown child';
        const when  = new Date(r.occurred_at).toLocaleString('en-US', {
            weekday: 'short', month: 'short', day: 'numeric',
            hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
        });
        const pending = r.status === 'submitted';
        return `<div class="inc-card ${pending ? 'inc-pending' : ''}" data-id="${r.id}">
            <div class="inc-head">
                <div>
                    <span class="inc-child">${escHtml(child)}</span>
                    <span class="inc-type">${escHtml(INC_TYPE_LABEL[r.incident_type] || r.incident_type)}</span>
                </div>
                <span class="inc-when">${escHtml(when)}</span>
            </div>
            ${pending ? `<div class="inc-waiting">Family not yet told — filed ${escHtml(_incWaiting(r.created_at))}</div>` : ''}
            <dl class="inc-detail">
                ${r.location  ? `<dt>Where</dt><dd>${escHtml(r.location)}</dd>` : ''}
                ${r.body_area ? `<dt>Body area</dt><dd>${escHtml(r.body_area)}</dd>` : ''}
                <dt>What happened</dt><dd>${escHtml(r.description)}</dd>
                <dt>What was done</dt><dd>${escHtml(r.action_taken)}</dd>
                <dt>Filed by</dt><dd>${escHtml(r.reported_by_name || '—')}</dd>
                ${r.reviewed_by ? `<dt>Reviewed by</dt><dd>${escHtml(r.reviewed_by)}</dd>` : ''}
                ${r.director_notes ? `<dt>Your note</dt><dd>${escHtml(r.director_notes)}</dd>` : ''}
            </dl>
            ${pending ? `
                <textarea class="inc-notes" rows="2"
                          placeholder="Optional note — visible to the family on the report."></textarea>
                <div class="inc-actions">
                    <button class="btn-primary inc-approve" data-id="${r.id}">Approve &amp; tell the family</button>
                    <button class="btn-ghost inc-return" data-id="${r.id}">Send back to staff</button>
                </div>` : ''}
            <div class="inc-print-actions">
                <button class="btn-ghost inc-pdf" data-id="${r.id}">🖨️ Export PDF</button>
            </div>
        </div>`;
    }).join('');

    _incBind();
}

function _incBind() {
    document.querySelectorAll('.inc-tab').forEach(b => {
        b.onclick = () => { _incFilter = b.dataset.filter; renderIncidentsTool(); };
    });
    document.querySelectorAll('.inc-approve').forEach(b => {
        b.onclick = () => _incReview(Number(b.dataset.id), 'approved', b);
    });
    document.querySelectorAll('.inc-return').forEach(b => {
        b.onclick = () => _incReview(Number(b.dataset.id), 'returned', b);
    });
    document.querySelectorAll('.inc-pdf').forEach(b => {
        b.onclick = () => incidentPrint(Number(b.dataset.id));
    });
}

async function _incReview(id, status, btn) {
    const card  = btn.closest('.inc-card');
    const notes = card?.querySelector('.inc-notes')?.value?.trim() || '';

    // Approving tells a family their child was hurt. That is not an action to
    // fire on a stray tap.
    if (status === 'approved' &&
        !confirm('Approve this report? The family will be able to read it and will be notified.')) return;

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = status === 'approved' ? 'Releasing…' : 'Sending back…';
    try {
        const ok = await reviewIncidentReport(id, status, notes);
        if (!ok) { showToast('That did not go through.', 'error'); return; }
        if (status === 'approved') await _incNotifyFamily(id);
        showToast(status === 'approved' ? 'Released to the family.' : 'Sent back to staff.');
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
        // The report is approved and readable either way; a failed push must
        // not make the director think the approval failed.
        console.warn('incident notify (non-fatal):', e);
    }
}

// ── PDF export ──────────────────────────────────────────────
// Record keeping: guidelines say 3 years, statute of limitations 5, and a major
// injury until the child is 23. That is far longer than this app should be the
// only copy, so the director can take a permanent one out.
//
// Rendered into a hidden print container and printed via the browser, rather
// than pulling in a PDF library — "Save as PDF" is in every print dialog, and a
// dependency here would be a dependency in the audit trail.
function incidentPrint(id) {
    const r = _incData.find(x => x.id === id);
    if (!r) return;
    const host = _incEl('incidentPrintHost');
    if (!host) return;

    const child = r.students?.child_name || 'Unknown child';
    const fmt = iso => iso ? new Date(iso).toLocaleString('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
        hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
    }) : '—';

    host.innerHTML = `
        <div class="incp-head">
            <div class="incp-org">Timothy Lutheran Church — Mother's Day Out</div>
            <h1>Incident Report</h1>
        </div>
        <table class="incp-table">
            <tr><th>Child</th><td>${escHtml(child)}</td></tr>
            <tr><th>Date &amp; time</th><td>${escHtml(fmt(r.occurred_at))}</td></tr>
            <tr><th>Type</th><td>${escHtml(INC_TYPE_LABEL[r.incident_type] || r.incident_type)}</td></tr>
            ${r.location  ? `<tr><th>Location</th><td>${escHtml(r.location)}</td></tr>` : ''}
            ${r.body_area ? `<tr><th>Body area</th><td>${escHtml(r.body_area)}</td></tr>` : ''}
            <tr><th>What happened</th><td>${escHtml(r.description)}</td></tr>
            <tr><th>Action taken</th><td>${escHtml(r.action_taken)}</td></tr>
            <tr><th>Reported by</th><td>${escHtml(r.reported_by_name || '—')}</td></tr>
            <tr><th>Status</th><td>${escHtml(r.status)}</td></tr>
            <tr><th>Reviewed by</th><td>${escHtml(r.reviewed_by || '—')}</td></tr>
            <tr><th>Reviewed at</th><td>${escHtml(fmt(r.reviewed_at))}</td></tr>
            ${r.director_notes ? `<tr><th>Director's note</th><td>${escHtml(r.director_notes)}</td></tr>` : ''}
        </table>
        <div class="incp-sign">
            <div><span class="incp-line"></span>Director signature</div>
            <div><span class="incp-line"></span>Parent / guardian signature &amp; date</div>
        </div>
        <div class="incp-foot">Report #${r.id} · generated ${escHtml(fmt(new Date().toISOString()))}</div>`;

    document.body.classList.add('printing-incident');
    // The class must be off again afterwards or the admin page stays in print
    // mode for the next thing the director prints.
    const cleanup = () => document.body.classList.remove('printing-incident');
    window.addEventListener('afterprint', cleanup, { once: true });
    setTimeout(cleanup, 60000);   // belt and braces: afterprint is unreliable on some mobile browsers
    window.print();
}
