// ============================================================
// admin-safety — injury reports, fire drills, clock-in integrity
// ============================================================
// Three director's desks, all added 2026-08-14, all about compliance and
// records rather than care:
//
//   Staff Injury Reports — workers' compensation. What staff file from the
//   Account tab of the staff app lands here.
//   Fire Drills — the record of every drill run from the head count screen.
//   Clock-In Integrity — whether the geofence is recording anything, and
//   whether two staff are punching from one phone.
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

let _fdComposeOpen = false;   // "+ Log a Drill" panel

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

    const bannerRow = `<div class="fd-banner-row">${banner}
        <button type="button" class="btn-primary fd-compose-open" id="fdComposeOpenBtn">&#43; Log a Drill</button>
    </div>${_fdComposeOpen ? _fdComposeHtml() : ''}`;

    if (!_fdData.length) { wrap.innerHTML = bannerRow; _fdBind(); return; }

    wrap.innerHTML = bannerRow + `<div class="fd-list">` + _fdData.map(d => {
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
    _fdBind();
}

function _fdBind() {
    _sfEl('fdComposeOpenBtn')?.addEventListener('click', () => { _fdComposeOpen = true; _fdRender(); });
    _sfEl('fdComposeCancel')?.addEventListener('click', () => { _fdComposeOpen = false; _fdRender(); });
    _sfEl('fdComposeSave')?.addEventListener('click', _fdComposeSave);
}

function _fdComposeHtml() {
    return `<div class="fd-compose">
        <h3 class="fd-compose-title">Log a drill</h3>
        <div class="fd-compose-grid">
            <div class="fd-compose-field">
                <label for="fdComposeType">Type</label>
                <select id="fdComposeType">
                    <option value="fire">Fire</option>
                    <option value="tornado">Tornado</option>
                    <option value="lockdown">Lockdown</option>
                    <option value="earthquake">Earthquake</option>
                    <option value="other">Other</option>
                </select>
            </div>
            <div class="fd-compose-field">
                <label for="fdComposeSecs">Time to clear (seconds)</label>
                <input type="number" id="fdComposeSecs" min="0" step="1" placeholder="e.g. 90">
            </div>
            <div class="fd-compose-field">
                <label for="fdComposeKidsPresent">Children present</label>
                <input type="number" id="fdComposeKidsPresent" min="0" step="1" value="0">
            </div>
            <div class="fd-compose-field">
                <label for="fdComposeKidsAccounted">Children accounted for</label>
                <input type="number" id="fdComposeKidsAccounted" min="0" step="1" value="0">
            </div>
            <div class="fd-compose-field">
                <label for="fdComposeStaffPresent">Staff present</label>
                <input type="number" id="fdComposeStaffPresent" min="0" step="1" value="0">
            </div>
            <div class="fd-compose-field">
                <label for="fdComposeStaffAccounted">Staff accounted for</label>
                <input type="number" id="fdComposeStaffAccounted" min="0" step="1" value="0">
            </div>
        </div>
        <div class="fd-compose-field">
            <label for="fdComposeNotes">Notes (optional)</label>
            <textarea id="fdComposeNotes" rows="2"></textarea>
        </div>
        <div class="fd-compose-btns">
            <button type="button" class="btn-primary" id="fdComposeSave">Save</button>
            <button type="button" class="btn-ghost" id="fdComposeCancel">Cancel</button>
        </div>
    </div>`;
}

async function _fdComposeSave() {
    const type   = _sfEl('fdComposeType')?.value || 'fire';
    const secs   = _sfEl('fdComposeSecs')?.value;
    const kidsPresent    = Number(_sfEl('fdComposeKidsPresent')?.value || 0);
    const kidsAccounted  = Number(_sfEl('fdComposeKidsAccounted')?.value || 0);
    const staffPresent   = Number(_sfEl('fdComposeStaffPresent')?.value || 0);
    const staffAccounted = Number(_sfEl('fdComposeStaffAccounted')?.value || 0);
    const notes  = _sfEl('fdComposeNotes')?.value?.trim() || '';

    const btn = _sfEl('fdComposeSave');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Saving…';
    try {
        const id = await adminLogFireDrill({
            drill_type: type,
            evacuation_seconds: secs === '' || secs == null ? null : Number(secs),
            children_present: kidsPresent, children_accounted: kidsAccounted,
            staff_present: staffPresent, staff_accounted: staffAccounted,
            notes,
        });
        if (id == null) {
            showToast("Couldn't save — check your admin role.", 'error');
            return;
        }
        showToast('Drill logged.');
        _fdComposeOpen = false;
        await renderFireDrillsTool();
    } catch (e) {
        showToast('Error: ' + (e.message || e), 'error');
    } finally {
        btn.disabled = false;
        btn.textContent = label;
    }
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

// ============================================================
// Clock-in integrity
// ============================================================
// Added 2026-08-14, answering "can we tie their login to their device so staff
// can't log each other in?" The decision was to MEASURE BEFORE BLOCKING: this
// screen refuses nobody and locks nobody out at 7am. It answers whether buddy
// punching is actually happening, so the question of whether to spend a
// director's mornings on device-approval requests can be settled with data.
//
// ⚠️ WHAT THE DEVICE ID CAN AND CANNOT SHOW. It is a random UUID in the
// browser's localStorage, minted on first punch. Clearing site data mints a new
// one. So:
//
//   two staff sharing one id   -> real evidence, worth a conversation
//   a staff member's id changed -> proves nothing (new phone, cleared Safari,
//                                  reinstalled the app, private window)
//
// The panels below are ordered by how much weight the signal carries, and the
// second one says out loud that it is a prompt to ask, not a finding.

let _ciRows  = [];
let _ciStaff = [];
let _ciDays  = 30;

const CI_LOC_LABEL = {
    ok: 'Location recorded', denied: 'Permission denied', timeout: 'Timed out',
    unavailable: 'Position unavailable', unsupported: 'Browser cannot',
    off: 'Geofence off', not_recorded: 'Before we tracked it',
};

async function renderClockIntegrityTool() {
    const wrap = _sfEl('clockIntegrityBody');
    if (!wrap) return;
    wrap.innerHTML = '<p class="muted">Loading…</p>';
    try {
        const since = new Date(Date.now() - _ciDays * 86400000).toISOString().slice(0, 10);
        [_ciRows, _ciStaff] = await Promise.all([
            fetchClockIntegrity(since),
            fetchAllStaff({ includeInactive: true }),
        ]);
    } catch (e) {
        wrap.innerHTML = `<p class="muted">Could not load clock events: ${escHtml(e.message || e)}</p>`;
        return;
    }
    _ciRender();
}

function _ciName(id) {
    return _ciStaff.find(s => String(s.id) === String(id))?.name || 'Unknown';
}

// Short, readable stand-in for a UUID nobody needs to read in full.
function _ciDevShort(id) { return id ? id.slice(0, 8) : '—'; }

function _ciRender() {
    const wrap = _sfEl('clockIntegrityBody');
    if (!wrap) return;

    const ranges = [7, 30, 90].map(d =>
        `<button class="inc-tab ${_ciDays === d ? 'active' : ''}" data-cidays="${d}">Last ${d} days</button>`).join('');

    if (!_ciRows.length) {
        wrap.innerHTML = `<div class="inc-tabs">${ranges}</div>
            <p class="muted" style="padding:18px 2px">No clock events in this window.</p>`;
        _ciBind();
        return;
    }

    wrap.innerHTML = `<div class="inc-tabs">${ranges}</div>`
        + _ciCoveragePanel() + _ciSharedPanel() + _ciUnusualPanel();
    _ciBind();
}

// ── Panel 1: is anything being recorded at all ──────────────
function _ciCoveragePanel() {
    const counts = {};
    _ciRows.forEach(r => {
        const k = r.clock_in_location_status || 'not_recorded';
        counts[k] = (counts[k] || 0) + 1;
    });
    const withDevice = _ciRows.filter(r => r.clock_in_device_id).length;
    const pct = n => Math.round((n / _ciRows.length) * 100);

    // Until the updated clock-in page has been live for a while, everything in
    // range is 'not_recorded' and both numbers are 0. Saying so beats showing a
    // zero that looks like a finding.
    const warming = counts.not_recorded === _ciRows.length;

    return `<section class="ci-panel">
        <h3>Are we recording anything?</h3>
        ${warming ? `<div class="fd-nag fd-nag-warn">
            <strong>Nothing recorded yet in this window.</strong>
            Device and location capture went live 2026-08-14. Every punch before
            that is marked "before we tracked it" — this panel fills in as staff
            clock in from now on.
        </div>` : ''}
        <div class="ci-stats">
            <div class="ci-stat"><span class="ci-num">${_ciRows.length}</span><span class="ci-lab">Punches</span></div>
            <div class="ci-stat"><span class="ci-num">${pct(withDevice)}%</span><span class="ci-lab">With a device id</span></div>
            <div class="ci-stat"><span class="ci-num">${pct(counts.ok || 0)}%</span><span class="ci-lab">With a location</span></div>
        </div>
        <ul class="ci-breakdown">
            ${Object.entries(counts).sort((a, b) => b[1] - a[1]).map(([k, n]) =>
                `<li><span>${escHtml(CI_LOC_LABEL[k] || k)}</span><strong>${n}</strong></li>`).join('')}
        </ul>
        ${counts.denied ? `<p class="ci-note">${counts.denied} ${counts.denied === 1 ? 'punch' : 'punches'}
            had location refused on the phone. The geofence cannot see those at all —
            it is worth asking staff to allow location for the clock-in page.</p>` : ''}
    </section>`;
}

// ── Panel 2: two people, one phone ──────────────────────────
function _ciSharedPanel() {
    const byDevice = new Map();
    _ciRows.filter(r => r.clock_in_device_id).forEach(r => {
        if (!byDevice.has(r.clock_in_device_id)) byDevice.set(r.clock_in_device_id, new Map());
        const m = byDevice.get(r.clock_in_device_id);
        if (!m.has(r.staff_id)) m.set(r.staff_id, []);
        m.get(r.staff_id).push(r);
    });

    const shared = [...byDevice.entries()].filter(([, m]) => m.size > 1);

    if (!shared.length) {
        return `<section class="ci-panel">
            <h3>Two staff, one phone</h3>
            <p class="ci-clear">✓ No device has been used by more than one staff member.</p>
        </section>`;
    }

    return `<section class="ci-panel">
        <h3>Two staff, one phone <span class="ci-flag">${shared.length}</span></h3>
        <p class="ci-note">The strongest signal available: these punches came from the
           same browser. Worth asking about.</p>
        ${shared.map(([dev, m]) => `
            <div class="ci-card">
                <div class="ci-card-head">Device ${escHtml(_ciDevShort(dev))}…</div>
                ${[...m.entries()].map(([sid, rows]) => `
                    <div class="ci-row">
                        <span class="ci-who">${escHtml(_ciName(sid))}</span>
                        <span class="ci-count">${rows.length} ${rows.length === 1 ? 'punch' : 'punches'}</span>
                        <span class="ci-dates">${escHtml(rows[rows.length - 1].work_date)} → ${escHtml(rows[0].work_date)}</span>
                    </div>`).join('')}
            </div>`).join('')}
    </section>`;
}

// ── Panel 3: punched from somebody else's usual phone ───────
function _ciUnusualPanel() {
    const byStaff = new Map();
    _ciRows.filter(r => r.clock_in_device_id).forEach(r => {
        if (!byStaff.has(r.staff_id)) byStaff.set(r.staff_id, []);
        byStaff.get(r.staff_id).push(r);
    });

    const odd = [];
    byStaff.forEach((rows, sid) => {
        // "Usual" = the device this person punches from most often. Anything
        // else is worth a look, but a new phone looks identical to a borrowed
        // one, which is why this panel asks rather than accuses.
        const tally = {};
        rows.forEach(r => { tally[r.clock_in_device_id] = (tally[r.clock_in_device_id] || 0) + 1; });
        const usual = Object.entries(tally).sort((a, b) => b[1] - a[1])[0];
        if (!usual || Object.keys(tally).length < 2) return;
        Object.entries(tally).filter(([d]) => d !== usual[0]).forEach(([dev, n]) => {
            const on = rows.filter(r => r.clock_in_device_id === dev);
            odd.push({ sid, dev, n, first: on[on.length - 1].work_date, last: on[0].work_date });
        });
    });

    if (!odd.length) {
        return `<section class="ci-panel">
            <h3>Punched from a different phone than usual</h3>
            <p class="ci-clear">✓ Everyone has clocked in from a single device.</p>
        </section>`;
    }

    return `<section class="ci-panel">
        <h3>Punched from a different phone than usual <span class="ci-flag">${odd.length}</span></h3>
        <p class="ci-note">A new phone, a cleared browser and a borrowed handset all
           look the same here. Treat this as a question, not a finding.</p>
        ${odd.map(o => `
            <div class="ci-row ci-row-standalone">
                <span class="ci-who">${escHtml(_ciName(o.sid))}</span>
                <span class="ci-count">${o.n} on device ${escHtml(_ciDevShort(o.dev))}…</span>
                <span class="ci-dates">${escHtml(o.first)}${o.first === o.last ? '' : ' → ' + escHtml(o.last)}</span>
            </div>`).join('')}
    </section>`;
}

function _ciBind() {
    document.querySelectorAll('[data-cidays]').forEach(b => {
        b.onclick = () => { _ciDays = Number(b.dataset.cidays); renderClockIntegrityTool(); };
    });
}

// ============================================================
// HR & Handbook — Policies, Write-ups
// ============================================================
// New for the Staff tab consolidation (design_handoff_staff, 2026-08-28).
// Both are genuinely new — everything else in this file is a relocated,
// unchanged tool. See add_staff_write_ups_and_hr_policies.sql for the table,
// RPCs, and the hr-policies storage bucket.

let _hrPolicies    = [];
let _hrPolicyOpen  = false;
let _wuData        = [];
let _wuComposeOpen = false;

// ── Policies ─────────────────────────────────────────────────
async function renderHrPoliciesTool() {
    const wrap = _sfEl('hrPoliciesBody');
    if (!wrap) return;
    wrap.innerHTML = '<p class="muted">Loading…</p>';
    try {
        _hrPolicies = await loadHrPolicies();
    } catch (e) {
        wrap.innerHTML = `<p class="muted">Could not load policies: ${escHtml(e.message || e)}</p>`;
        return;
    }
    _hrRenderPolicies();
}

function _hrRenderPolicies() {
    const wrap = _sfEl('hrPoliciesBody');
    if (!wrap) return;

    const rows = _hrPolicies.length ? _hrPolicies.map(p => `
        <div class="hr-policy-row" data-hrpid="${escHtml(p.id)}">
            <div class="hr-policy-icon">${escHtml(p.icon || '📄')}</div>
            <div class="hr-policy-main">
                <div class="hr-policy-title">${escHtml(p.title)}</div>
                <div class="hr-policy-updated">${p.updatedLabel ? 'Updated ' + escHtml(p.updatedLabel) : ''}</div>
            </div>
            <div class="hr-policy-actions">
                <button class="btn-ghost hr-policy-view">View PDF</button>
                <button class="btn-ghost hr-policy-remove" title="Remove">🗑️</button>
            </div>
        </div>`).join('') : '<p class="empty-hint">No policy documents yet — add one below.</p>';

    const addForm = _hrPolicyOpen ? `
        <div class="hr-policy-add">
            <div class="fm-field"><label>Title</label>
                <input type="text" id="hrPolTitle" placeholder="e.g. Employee Handbook"></div>
            <div class="fm-field"><label>Icon (optional)</label>
                <input type="text" id="hrPolIcon" placeholder="📘" maxlength="4" style="width:60px"></div>
            <div class="fm-field"><label>"Updated" label</label>
                <input type="text" id="hrPolUpdated" placeholder="e.g. Jan 2026"></div>
            <div class="fm-field"><label>PDF or Word file</label>
                <input type="file" id="hrPolFile" accept="application/pdf,.doc,.docx"></div>
            <div class="rates-actions">
                <button class="btn-primary" id="hrPolSave">Save</button>
                <button class="btn-ghost" id="hrPolCancel">Cancel</button>
                <span id="hrPolStatus" class="rates-status"></span>
            </div>
        </div>` : '';

    wrap.innerHTML = `
        <div class="hr-policy-list">${rows}</div>
        ${addForm}
        ${_hrPolicyOpen ? '' : '<button class="btn-secondary" id="hrPolAddBtn" style="margin-top:12px">+ Add a policy document</button>'}`;

    wrap.querySelectorAll('.hr-policy-row').forEach(row => {
        const id = row.dataset.hrpid;
        const p  = _hrPolicies.find(x => String(x.id) === id);
        if (!p) return;
        row.querySelector('.hr-policy-view')?.addEventListener('click', () => _hrViewPolicy(p));
        row.querySelector('.hr-policy-remove')?.addEventListener('click', () => _hrRemovePolicy(p));
    });
    _sfEl('hrPolAddBtn')?.addEventListener('click', () => { _hrPolicyOpen = true; _hrRenderPolicies(); });
    _sfEl('hrPolCancel')?.addEventListener('click', () => { _hrPolicyOpen = false; _hrRenderPolicies(); });
    _sfEl('hrPolSave')?.addEventListener('click', _hrSavePolicy);
}

async function _hrViewPolicy(p) {
    try {
        const url = await fetchHrPolicyUrl(p.path);
        if (url) window.open(url, '_blank');
        else showToast("Couldn't open that document.", 'error');
    } catch (e) {
        showToast('Error: ' + (e.message || e), 'error');
    }
}

async function _hrRemovePolicy(p) {
    if (!confirm(`Remove "${p.title}"? This can't be undone.`)) return;
    try {
        const updated = _hrPolicies.filter(x => x.id !== p.id);
        await saveHrPolicies(updated);
        _hrPolicies = updated;
        _hrRenderPolicies();
        await deleteHrPolicyFile(p.path);
    } catch (e) {
        showToast('Error removing that document: ' + (e.message || e), 'error');
    }
}

async function _hrSavePolicy() {
    const title   = _sfEl('hrPolTitle')?.value.trim();
    const icon    = _sfEl('hrPolIcon')?.value.trim();
    const updated = _sfEl('hrPolUpdated')?.value.trim();
    const file    = _sfEl('hrPolFile')?.files[0];
    const statusEl = _sfEl('hrPolStatus');
    if (!title) { showToast('Give the document a title.', 'error'); return; }
    if (!file)  { showToast('Choose a file to upload.', 'error'); return; }

    const btn = _sfEl('hrPolSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    if (statusEl) statusEl.textContent = '';
    try {
        const path = await uploadHrPolicyFile(file);
        const updatedList = _hrPolicies.concat([{
            id: crypto.randomUUID(), title, icon: icon || '📄', updatedLabel: updated, path,
        }]);
        await saveHrPolicies(updatedList);
        _hrPolicies   = updatedList;
        _hrPolicyOpen = false;
        _hrRenderPolicies();
        showToast('Policy document added.');
    } catch (e) {
        if (statusEl) statusEl.textContent = '⚠️ ' + (e.message || e);
        if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
    }
}

// ── Write-ups ────────────────────────────────────────────────
const WU_KINDS = ['Lateness', 'Policy violation', 'Attendance', 'Performance', 'Other'];

async function renderStaffWriteUpsTool() {
    const wrap = _sfEl('hrWriteUpsBody');
    if (!wrap) return;
    wrap.innerHTML = '<p class="muted">Loading…</p>';
    try {
        _wuData = await fetchStaffWriteUps();
    } catch (e) {
        wrap.innerHTML = `<p class="muted">Could not load write-ups: ${escHtml(e.message || e)}</p>`;
        return;
    }
    _wuRender();
}

function _wuRender() {
    const wrap = _sfEl('hrWriteUpsBody');
    if (!wrap) return;

    const staffOpts = (typeof allStaffData !== 'undefined' ? allStaffData : [])
        .filter(s => s.active)
        .map(s => `<option value="${escHtml(s.id)}">${escHtml(s.name)}</option>`).join('');

    const composeForm = _wuComposeOpen ? `
        <div class="wu-compose">
            <div class="fm-field"><label>Staff member</label>
                <select id="wuStaff" class="family-search-input">${staffOpts}</select></div>
            <div class="fm-field"><label>Type</label>
                <select id="wuKind" class="family-search-input">
                    ${WU_KINDS.map(k => `<option value="${escHtml(k)}">${escHtml(k)}</option>`).join('')}
                </select></div>
            <div class="fm-field"><label>Date</label>
                <input type="date" id="wuDate" value="${new Date().toLocaleDateString('en-CA')}"></div>
            <div class="fm-field fm-field-grow"><label>Note</label>
                <textarea id="wuNote" rows="3" placeholder="What happened"></textarea></div>
            <div class="rates-actions">
                <button class="btn-primary" id="wuSave">Save write-up</button>
                <button class="btn-ghost" id="wuCancel">Cancel</button>
                <span id="wuStatus" class="rates-status"></span>
            </div>
        </div>` : '';

    const cards = _wuData.length ? _wuData.map(w => {
        const name   = w.staff?.name || 'Former staff member';
        const signed = w.status === 'signed';
        return `
        <div class="wu-card">
            <div class="wu-card-head">
                <span class="wu-name">${escHtml(name)}</span>
                <span class="wu-kind-chip">${escHtml(w.kind)}</span>
                <span class="wu-date">${escHtml(friendlyShort(w.occurred_at))}</span>
            </div>
            <div class="wu-note">${escHtml(w.note)}</div>
            <div class="wu-foot">
                <span class="wu-issuer">Issued by ${escHtml(w.issued_by_name)}</span>
                ${signed
                    ? `<span class="wu-status wu-status-signed">Signed ${escHtml(new Date(w.signed_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }))}</span>`
                    : `<button class="wu-status wu-status-pending" data-wuid="${w.id}">Awaiting signature — mark signed</button>`}
            </div>
        </div>`;
    }).join('') : '<p class="empty-hint">No write-ups on file.</p>';

    wrap.innerHTML = `
        <div class="rates-actions" style="margin-bottom:14px">
            ${_wuComposeOpen ? '' : '<button class="btn-primary" id="wuAddBtn">+ New write-up</button>'}
        </div>
        ${composeForm}
        <div class="wu-list">${cards}</div>`;

    _sfEl('wuAddBtn')?.addEventListener('click', () => { _wuComposeOpen = true; _wuRender(); });
    _sfEl('wuCancel')?.addEventListener('click', () => { _wuComposeOpen = false; _wuRender(); });
    _sfEl('wuSave')?.addEventListener('click', _wuSave);
    wrap.querySelectorAll('.wu-status-pending').forEach(b => {
        b.addEventListener('click', () => _wuMarkSigned(Number(b.dataset.wuid)));
    });
}

async function _wuSave() {
    const staffId = _sfEl('wuStaff')?.value;
    const kind    = _sfEl('wuKind')?.value;
    const date    = _sfEl('wuDate')?.value;
    const note    = _sfEl('wuNote')?.value.trim();
    const statusEl = _sfEl('wuStatus');
    if (!staffId) { showToast('Pick a staff member.', 'error'); return; }
    if (!note)    { showToast('Add a note describing what happened.', 'error'); return; }

    const btn = _sfEl('wuSave');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    if (statusEl) statusEl.textContent = '';
    try {
        const id = await submitStaffWriteUp({ staffId, kind, note, occurredAt: date || null });
        if (!id) { showToast("Couldn't save — check your admin role.", 'error'); return; }
        _wuComposeOpen = false;
        await renderStaffWriteUpsTool();
        showToast('Write-up saved.');
    } catch (e) {
        if (statusEl) statusEl.textContent = '⚠️ ' + (e.message || e);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Save write-up'; }
    }
}

async function _wuMarkSigned(id) {
    if (!confirm('Mark this write-up as acknowledged/signed?')) return;
    try {
        const ok = await markStaffWriteUpSigned(id);
        if (!ok) { showToast('That did not go through.', 'error'); return; }
        showToast('Marked signed.');
        await renderStaffWriteUpsTool();
    } catch (e) {
        showToast('Error: ' + (e.message || e), 'error');
    }
}
