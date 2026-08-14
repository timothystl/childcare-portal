// ============================================================
// admin-safety — staff injury reports and the fire drill log
// ============================================================
// Two director's desks, both added 2026-08-14, both about compliance rather
// than care:
//
//   Staff Injury Reports — workers' compensation. What staff file from the
//   Account tab of the staff app lands here.
//   Fire Drills — the record of every drill run from the head count screen.
//
// ⚠️ STAFF INJURIES ARE NOT CHILD INCIDENTS AND THE TWO QUEUES NEVER MIX.
// Approving a child's incident report publishes it to that family. Nothing in
// this file publishes anything to anyone: the audience is the director, the
// carrier, and a state inspector. `staff_injury_reports` carries no
// parent-facing policy at all, and none should ever be added.

let _siData   = [];
let _siFilter = 'reported';
let _fdData   = [];

function _sfEl(id) { return document.getElementById(id); }

const SI_STATUS_LABEL = {
    reported:     'Just reported',
    acknowledged: 'Seen by you',
    filed:        'Filed with carrier',
    closed:       'Closed',
};
const SI_TREATMENT_LABEL = {
    none:             'No treatment',
    onsite_first_aid: 'First aid on site',
    clinic_er:        'Clinic or ER',
    later:            'Planning to see a doctor',
    declined:         'Offered, declined',
};
const FD_TYPE_LABEL = {
    fire: '🔥 Fire', tornado: '🌪️ Tornado', lockdown: '🔒 Lockdown',
    earthquake: '🌎 Earthquake', other: 'Drill',
};

function _sfDays(iso) {
    if (!iso) return null;
    return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
}

function _sfWhen(iso, withTime = true) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        ...(withTime ? { hour: 'numeric', minute: '2-digit' } : {}),
        timeZone: 'America/Chicago',
    });
}

// ============================================================
// Staff injury reports
// ============================================================

async function renderStaffInjuriesTool() {
    const wrap = _sfEl('staffInjuriesBody');
    if (!wrap) return;
    wrap.innerHTML = '<p class="muted">Loading…</p>';
    try {
        _siData = await fetchStaffInjuryReports({
            status: _siFilter === 'all' ? null : _siFilter,
        });
    } catch (e) {
        wrap.innerHTML = `<p class="muted">Could not load reports: ${escHtml(e.message || e)}</p>`;
        return;
    }
    _siRender();
}

function _siRender() {
    const wrap = _sfEl('staffInjuriesBody');
    if (!wrap) return;

    const tabs = [
        ['reported', 'Needs your attention'],
        ['acknowledged', 'Open'],
        ['filed', 'With the carrier'],
        ['closed', 'Closed'],
        ['all', 'Everything'],
    ].map(([k, label]) =>
        `<button class="inc-tab ${_siFilter === k ? 'active' : ''}" data-sifilter="${k}">${label}</button>`
    ).join('');

    if (!_siData.length) {
        wrap.innerHTML = `<div class="inc-tabs">${tabs}</div>
            <p class="muted" style="padding:18px 2px">${
                _siFilter === 'reported'
                    ? 'Nothing new. No staff injuries are waiting on you.'
                    : 'Nothing here.'}</p>`;
        _siBind();
        return;
    }

    wrap.innerHTML = `<div class="inc-tabs">${tabs}</div>` + _siData.map(r => {
        const age = _sfDays(r.reported_at);
        // ⚠️ THE 30-DAY CLOCK IS THE REASON THIS QUEUE EXISTS. Missouri gives
        // the employer 30 days from knowing about an injury to file the First
        // Report with the Division (RSMo 287.380). The report's own date-stamp
        // is when we knew. Anything not yet filed and past ~3 weeks gets loud.
        const unfiled = r.status === 'reported' || r.status === 'acknowledged';
        const late    = unfiled && age !== null && age >= 30;
        const soon    = unfiled && age !== null && age >= 21 && age < 30;

        return `<div class="inc-card ${unfiled ? 'inc-pending' : ''}" data-siid="${r.id}">
            <div class="inc-head">
                <div>
                    <span class="inc-child">${escHtml(r.staff_name || 'Staff member')}</span>
                    <span class="inc-type">${escHtml(SI_STATUS_LABEL[r.status] || r.status)}</span>
                </div>
                <span class="inc-when">${escHtml(_sfWhen(r.occurred_at))}</span>
            </div>

            ${late ? `<div class="si-late">⚠️ Reported ${age} days ago and not yet filed with the
                        carrier. The state's First Report window is 30 days from when you knew.</div>`
                   : soon ? `<div class="inc-waiting">Reported ${age} days ago — the 30-day
                              First Report window closes in ${30 - age} days.</div>`
                   : unfiled ? `<div class="inc-waiting">Reported ${age === 0 ? 'today' : age + ' days ago'}.</div>`
                   : ''}

            ${r.lost_time ? '<div class="si-losttime">Lost time — they stopped work or went home.</div>' : ''}

            <dl class="inc-detail">
                <dt>Treatment</dt><dd>${escHtml(SI_TREATMENT_LABEL[r.sought_treatment] || r.sought_treatment)}${
                    r.treatment_facility ? ' — ' + escHtml(r.treatment_facility) : ''}</dd>
                ${r.location  ? `<dt>Where</dt><dd>${escHtml(r.location)}</dd>` : ''}
                ${r.body_area ? `<dt>Body area</dt><dd>${escHtml(r.body_area)}</dd>` : ''}
                <dt>What happened</dt><dd>${escHtml(r.description)}</dd>
                <dt>What was done</dt><dd>${escHtml(r.action_taken)}</dd>
                ${r.witness ? `<dt>Witness</dt><dd>${escHtml(r.witness)}</dd>` : ''}
                <dt>Reported</dt><dd>${escHtml(_sfWhen(r.reported_at))} by ${escHtml(r.reported_by_name || '—')}</dd>
                ${r.insurer_claim_ref ? `<dt>Claim reference</dt><dd>${escHtml(r.insurer_claim_ref)}</dd>` : ''}
                ${r.insurer_reported_at ? `<dt>Filed with carrier</dt><dd>${escHtml(_sfWhen(r.insurer_reported_at))}</dd>` : ''}
                ${r.reviewed_by ? `<dt>Last touched by</dt><dd>${escHtml(r.reviewed_by)}</dd>` : ''}
                ${r.director_notes ? `<dt>Your note</dt><dd>${escHtml(r.director_notes)}</dd>` : ''}
            </dl>

            ${r.status !== 'closed' ? `
                <textarea class="inc-notes" rows="2"
                          placeholder="Note for the file — who you called, what the carrier said."></textarea>
                <input type="text" class="si-claim" placeholder="Carrier claim reference (if you have one)">
                <div class="inc-actions">
                    ${r.status === 'reported'
                        ? '<button class="btn-secondary si-act" data-status="acknowledged">Mark as seen</button>' : ''}
                    <button class="btn-primary si-act" data-status="filed">Filed with the carrier</button>
                    <button class="btn-ghost si-act" data-status="closed">Close</button>
                </div>` : ''}
            <div class="inc-print-actions">
                <button class="btn-ghost si-pdf">🖨️ Export PDF</button>
            </div>
        </div>`;
    }).join('');

    _siBind();
}

function _siBind() {
    document.querySelectorAll('[data-sifilter]').forEach(b => {
        b.onclick = () => { _siFilter = b.dataset.sifilter; renderStaffInjuriesTool(); };
    });
    document.querySelectorAll('.si-act').forEach(b => {
        b.onclick = () => _siReview(b);
    });
    document.querySelectorAll('.si-pdf').forEach(b => {
        b.onclick = () => staffInjuryPrint(Number(b.closest('.inc-card')?.dataset.siid));
    });
}

async function _siReview(btn) {
    const card = btn.closest('.inc-card');
    const id   = Number(card?.dataset.siid);
    const status = btn.dataset.status;
    if (!id) return;

    const notes = card.querySelector('.inc-notes')?.value?.trim() || '';
    const claim = card.querySelector('.si-claim')?.value?.trim() || '';

    // Closing ends the center's active handling of a claim. Not a stray tap.
    if (status === 'closed' &&
        !confirm('Close this report? Do this once the claim is settled or you are sure no claim is coming.')) return;

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Saving…';
    try {
        const ok = await reviewStaffInjuryReport(id, status, notes, claim);
        if (!ok) { showToast('That did not go through.', 'error'); return; }
        showToast(status === 'filed' ? 'Marked as filed with the carrier.' : 'Saved.');
        await renderStaffInjuriesTool();
    } catch (e) {
        showToast('Error: ' + (e.message || e), 'error');
    } finally {
        btn.disabled = false; btn.textContent = label;
    }
}

// Prints through the same hidden host and print stylesheet as the child
// incident export — it is the same kind of document, and a second copy of that
// CSS is a second thing to keep in step.
function staffInjuryPrint(id) {
    const r = _siData.find(x => x.id === id);
    if (!r) return;
    const host = _sfEl('incidentPrintHost');
    if (!host) return;

    host.innerHTML = `
        <div class="incp-head">
            <div class="incp-org">Timothy Lutheran Church — Mother's Day Out</div>
            <h1>Employee Injury Report</h1>
        </div>
        <table class="incp-table">
            <tr><th>Employee</th><td>${escHtml(r.staff_name || '—')}</td></tr>
            <tr><th>Date &amp; time of injury</th><td>${escHtml(_sfWhen(r.occurred_at))}</td></tr>
            <tr><th>Reported to employer</th><td>${escHtml(_sfWhen(r.reported_at))}</td></tr>
            <tr><th>Reported by</th><td>${escHtml(r.reported_by_name || '—')}</td></tr>
            ${r.location  ? `<tr><th>Location</th><td>${escHtml(r.location)}</td></tr>` : ''}
            ${r.body_area ? `<tr><th>Part of body</th><td>${escHtml(r.body_area)}</td></tr>` : ''}
            <tr><th>What happened</th><td>${escHtml(r.description)}</td></tr>
            <tr><th>Action taken</th><td>${escHtml(r.action_taken)}</td></tr>
            ${r.witness ? `<tr><th>Witness</th><td>${escHtml(r.witness)}</td></tr>` : ''}
            <tr><th>Medical treatment</th><td>${escHtml(SI_TREATMENT_LABEL[r.sought_treatment] || r.sought_treatment)}${
                r.treatment_facility ? ' — ' + escHtml(r.treatment_facility) : ''}</td></tr>
            <tr><th>Lost time from work</th><td>${r.lost_time ? 'Yes' : 'No'}</td></tr>
            <tr><th>Status</th><td>${escHtml(SI_STATUS_LABEL[r.status] || r.status)}</td></tr>
            ${r.insurer_claim_ref ? `<tr><th>Claim reference</th><td>${escHtml(r.insurer_claim_ref)}</td></tr>` : ''}
            ${r.insurer_reported_at ? `<tr><th>Filed with carrier</th><td>${escHtml(_sfWhen(r.insurer_reported_at))}</td></tr>` : ''}
            ${r.director_notes ? `<tr><th>Director's note</th><td>${escHtml(r.director_notes)}</td></tr>` : ''}
        </table>
        <div class="incp-sign">
            <div><span class="incp-line"></span>Employee signature &amp; date</div>
            <div><span class="incp-line"></span>Director signature &amp; date</div>
        </div>
        <div class="incp-foot">Injury report #${r.id} · generated ${escHtml(_sfWhen(new Date().toISOString()))}</div>`;

    document.body.classList.add('printing-incident');
    const cleanup = () => document.body.classList.remove('printing-incident');
    window.addEventListener('afterprint', cleanup, { once: true });
    setTimeout(cleanup, 60000);
    window.print();
}

// ============================================================
// Fire drills
// ============================================================
// ⚠️ Licensing expects a drill roughly monthly and the records kept
// (19 CSR 30-62). The nag at the top is the whole reason this is a screen and
// not a table: a drill log you have to remember to look at does not remind
// anyone to hold a drill.

async function renderFireDrillsTool() {
    const wrap = _sfEl('fireDrillsBody');
    if (!wrap) return;
    wrap.innerHTML = '<p class="muted">Loading…</p>';
    try {
        _fdData = await fetchFireDrills(60);
    } catch (e) {
        wrap.innerHTML = `<p class="muted">Could not load the drill log: ${escHtml(e.message || e)}</p>`;
        return;
    }
    _fdRender();
}

function _fdRender() {
    const wrap = _sfEl('fireDrillsBody');
    if (!wrap) return;

    const lastFire = _fdData.find(d => d.drill_type === 'fire');
    const since    = lastFire ? _sfDays(lastFire.started_at) : null;

    let banner;
    if (since === null) {
        banner = `<div class="fd-nag fd-nag-warn">
            <strong>No fire drill recorded yet.</strong>
            Drills run before today were kept on paper — this log starts from the
            first one recorded on a phone. Run one from the Count tab of the staff
            app and it lands here.
        </div>`;
    } else if (since > 30) {
        banner = `<div class="fd-nag fd-nag-warn">
            <strong>${since} days since the last fire drill.</strong>
            Licensing expects one a month. Run one from the Count tab of the staff app.
        </div>`;
    } else {
        banner = `<div class="fd-nag fd-nag-ok">
            Last fire drill was ${since === 0 ? 'today' : since === 1 ? 'yesterday' : since + ' days ago'}.
        </div>`;
    }

    if (!_fdData.length) { wrap.innerHTML = banner; return; }

    wrap.innerHTML = banner + `<div class="fd-list">` + _fdData.map(d => {
        const kidsShort  = d.children_present - d.children_accounted;
        const staffShort = d.staff_present - d.staff_accounted;
        const short = kidsShort + staffShort;
        const secs = d.evacuation_seconds;
        const time = secs === null || secs === undefined
            ? '—' : `${Math.floor(secs / 60)}m ${secs % 60}s`;
        const snap = d.snapshot || {};
        // ⚠️ 'booked' means the count was taken against who was scheduled, not
        // who had been checked in. Saying so on the record matters: an
        // inspector reading "39 children" deserves to know how we knew.
        const basis = snap.source === 'checked_in'
            ? 'counted from check-ins'
            : 'counted from the day\'s bookings';

        const missing = [
            ...(snap.children || []).filter(c => !c.accounted).map(c => c.name),
            ...(snap.staff    || []).filter(s => !s.accounted).map(s => s.name),
        ];

        return `<div class="fd-card ${short ? 'fd-short' : ''}">
            <div class="fd-head">
                <span class="fd-type">${escHtml(FD_TYPE_LABEL[d.drill_type] || d.drill_type)}</span>
                <span class="fd-when">${escHtml(_sfWhen(d.started_at))}</span>
            </div>
            <div class="fd-stats">
                <span><strong>${d.children_accounted}/${d.children_present}</strong> children</span>
                <span><strong>${d.staff_accounted}/${d.staff_present}</strong> staff</span>
                <span><strong>${escHtml(time)}</strong> to clear</span>
            </div>
            ${short
                ? `<div class="fd-missing">⚠️ ${short} not accounted for: ${escHtml(missing.join(', ') || 'unnamed')}</div>`
                : '<div class="fd-allclear">✓ Everyone accounted for</div>'}
            <div class="fd-meta">
                Run by ${escHtml(d.conducted_by_name || '—')} · ${escHtml(basis)}
            </div>
            ${d.notes ? `<div class="fd-notes">${escHtml(d.notes)}</div>` : ''}
            <details class="fd-roster">
                <summary>Who was in the building</summary>
                <div class="fd-roster-body">
                    ${_fdRosterList('Children', snap.children)}
                    ${_fdRosterList('Staff', snap.staff)}
                </div>
            </details>
        </div>`;
    }).join('') + '</div>';
}

function _fdRosterList(title, list) {
    if (!Array.isArray(list) || !list.length) return '';
    return `<div class="fd-roster-group"><h4>${escHtml(title)}</h4><ul>` +
        list.map(p => `<li class="${p.accounted ? '' : 'fd-unaccounted'}">
            ${escHtml(p.name || 'Unnamed')}
            <span class="fd-roster-room">${escHtml(p.room || '—')}</span>
            ${p.accounted ? '' : '<span class="fd-roster-flag">not accounted for</span>'}
        </li>`).join('') + '</ul></div>';
}
