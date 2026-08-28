// ============================================================
// incident-print — the signed, printable incident report
// ============================================================
// Surface 4 of the design handoff. One US Letter page, portrait, sized to fit
// without overflow.
//
// ⚠️ EVERY FIELD ON THIS PAGE COMES FROM incident_print_record(). There is no
// second source and there must never be one. That function refuses to return a
// document until the teacher, the parent and the director have all signed, and
// it applies the same refusal to a full admin as to anybody else. If this file
// ever grows a "render from what the opener passed us" path, the gate is gone —
// the handoff rules out exactly that ("not from a client screenshot").
//
// The page is reachable by the office and by the child's own family. Which of
// those you are is decided in the database (is_admin() OR
// parent_owns_student()), not by which app opened the window.

function ipEl(id) { return document.getElementById(id); }

function ipShowState(msg, tone = '') {
    const el = ipEl('ipState');
    el.className = `ip-state ${tone}`;
    el.innerHTML = msg;
    el.classList.remove('hidden');
    ipEl('ipPage').classList.add('hidden');
}

const IP_ROLE_LABEL = {
    teacher:  'Teacher',
    parent:   'Parent / guardian',
    director: 'Director',
};

function ipTime(iso) {
    return iso ? new Date(iso).toLocaleString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
    }).replace(/\s?([AP])M/i, (_, p) => p.toLowerCase()) : '—';
}

function ipDate(iso) {
    return iso ? new Date(iso).toLocaleDateString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
        timeZone: 'America/Chicago',
    }) : '—';
}

function ipStamp(iso) {
    return iso ? new Date(iso).toLocaleString('en-US', {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
        timeZone: 'America/Chicago',
    }).replace(/\s?([AP])M/i, (_, p) => p.toUpperCase()) : '';
}

// Months, because "29 mo" is how a childcare licensing form reads an infant's
// age and "2 years 5 months" is not.
function ipAgeMonths(dob) {
    if (!dob) return '';
    const b = new Date(dob), n = new Date();
    const m = (n.getFullYear() - b.getFullYear()) * 12 + (n.getMonth() - b.getMonth())
            - (n.getDate() < b.getDate() ? 1 : 0);
    return m >= 0 ? ` (${m} mo)` : '';
}

function ipRoomLabel(id) {
    const room = (typeof ROOMS !== 'undefined' ? ROOMS : []).find(r => r.id === id);
    return room ? room.label : (id || '—');
}

// The same figure the teacher marked on, redrawn at print scale with the marked
// zone filled. Drawn inline so the sheet needs no image asset and prints
// identically from any browser.
function ipBodyFigure(part, view) {
    const marks = {
        head: [50, 11, 9], face: [50, 14, 7], forehead: [50, 7, 6],
        shoulder: [50, 21, 0], arm: [50, 34, 0], torso: [50, 33, 0],
        back: [50, 33, 0], hand: [50, 48, 0], hip: [50, 48, 0],
        bottom: [50, 48, 0], leg: [50, 66, 0], foot: [50, 87, 0], heel: [50, 87, 0],
        neck: [50, 18, 4], lip: [50, 16, 4], knee: [50, 70, 0], elbow: [50, 40, 0],
    };
    const key  = String(part || '').toLowerCase().split(',')[0].trim()
                    .replace('back of head', 'head');
    const side = /left side/.test(part || '') ? -1 : /right side/.test(part || '') ? 1 : 0;
    const hit  = marks[key];

    // Viewer's left is the child's right on a front view, which is how the tap
    // zones stored it — mirror back so the printed mark lands where the teacher
    // pointed.
    const flip = view === 'back' ? 1 : -1;
    const cx   = hit ? hit[0] + (side * flip * 13) : null;

    return `<svg viewBox="0 0 100 100" class="ip-body-svg" aria-hidden="true"
                 preserveAspectRatio="xMidYMid meet">
        <circle cx="50" cy="11" r="9"/>
        <path d="M50 20 C40 20 33 25 32 34 L29 56 C29 59 34 59 34 56 L36 42 L36 60
                 L34 88 C34 92 40 92 41 88 L45 62 L50 62 L55 62 L59 88
                 C60 92 66 92 66 88 L64 60 L64 42 L66 56 C66 59 71 59 71 56 L68 34
                 C67 25 60 20 50 20 Z"/>
        ${view === 'back' ? '<line x1="50" y1="22" x2="50" y2="60"/>' : ''}
        ${hit ? `<circle class="ip-mark" cx="${cx}" cy="${hit[1]}" r="${hit[2] || 5}"/>` : ''}
    </svg>`;
}

async function ipLoad() {
    const id = new URLSearchParams(location.search).get('id');
    if (!id) { ipShowState('No report was named.', 'is-err'); return; }

    let rec;
    try {
        rec = await fetchIncidentPrintRecord(Number(id));
    } catch (e) {
        ipShowState(`Could not load the record. ${escHtml(e.message || e)}`, 'is-err');
        return;
    }

    // null means the caller may not see this report at all — not the office,
    // not this child's family. Say that plainly rather than implying it is
    // merely unfinished.
    if (!rec) {
        ipShowState(`This report isn't available to you. Only the office and the
                     child's own family can open it.`, 'is-err');
        return;
    }

    if (rec.ok === false) {
        const have = Array.isArray(rec.have) ? rec.have : [];
        const missing = ['teacher', 'parent', 'director']
            .filter(r => !have.includes(r))
            .map(r => IP_ROLE_LABEL[r].toLowerCase());
        ipShowState(`
            <strong>This report can't be printed yet.</strong>
            <p>It needs all three signatures — teacher, then parent, then director —
               and it is still waiting on the ${escHtml(missing.join(' and '))}.</p>
            <p class="ip-fine">A half-signed report can't leave the building.</p>`, 'is-wait');
        return;
    }

    ipRender(rec);
}

function ipRender(rec) {
    const r     = rec.report || {};
    const child = rec.child  || {};
    const sigs  = rec.signatures || [];
    const byRole = Object.fromEntries(sigs.map(s => [s.role, s]));

    const num = `INC-${new Date(r.occurred_at).getFullYear()}-${String(r.id).padStart(4, '0')}`;
    ipEl('ipNum').textContent   = `Report #${num}`;
    ipEl('ipFiled').textContent = `Filed ${ipDate(r.filed_at || r.created_at)} · ${ipTime(r.filed_at || r.created_at)}`;

    ipEl('ipChild').textContent = child.child_name || '—';
    ipEl('ipDob').textContent   = child.child_dob
        ? `${ipDate(child.child_dob)}${ipAgeMonths(child.child_dob)}` : '—';
    ipEl('ipRoom').textContent  = ipRoomLabel(child.room_id);
    ipEl('ipWhen').textContent  = `${ipTime(r.occurred_at)} · ${ipDate(r.occurred_at)}`;

    ipEl('ipWhat').textContent = r.description || '—';

    const aid = (r.first_aid || []).join(', ');
    ipEl('ipAid').textContent = [aid, r.action_taken].filter(Boolean).join('. ') || '—';

    ipEl('ipWitnesses').innerHTML = (r.witnesses || []).length
        ? (r.witnesses || []).map(w => escHtml(w)).join('<br>')
        : 'None recorded';
    ipEl('ipAfter').textContent = (r.after_notes || []).join(' · ') || 'No further concerns recorded.';

    ipEl('ipFigure').innerHTML   = ipBodyFigure(r.body_part || r.body_area, r.body_view);
    ipEl('ipBodyPart').textContent = r.body_part || r.body_area || 'Not marked';

    ipEl('ipWhere').innerHTML =
        `${escHtml(r.location || 'Not recorded')}` +
        (r.ratio_note ? `<br>Ratio at the time: ${escHtml(r.ratio_note)}` : '');

    ipEl('ipType').innerHTML = r.incident_kind
        ? `<strong>${escHtml(r.incident_kind)}</strong>`
        : escHtml(r.incident_type || '—');

    // The notification sentence is the handoff's, and it is load-bearing: it is
    // what tells a licensing inspector the order the signatures were taken in.
    const parentSig = byRole.parent;
    ipEl('ipNotify').innerHTML =
        `${escHtml(child.child_name || 'The family')}'s parent was notified ` +
        `<strong>${escHtml(ipTime(r.parent_notified_at || r.filed_at))}</strong> ` +
        `by app notification` +
        (parentSig ? ` and in person at pickup, ${escHtml(ipTime(parentSig.signed_at))}` : '') +
        `. Signed by the teacher before the parent was notified; the parent signed ` +
        `at pickup, and the director's signature closed the record. ` +
        `This copy prints only with all three.`;

    ipEl('ipComplete').textContent = `RECORD COMPLETE · ${ipStamp(rec.completed_at)}`;

    // Addenda supplement the signed record above without altering it — shown
    // only when at least one exists, so a report with none looks unchanged.
    const addenda = rec.addenda || [];
    ipEl('ipAddendaBlock').classList.toggle('hidden', addenda.length === 0);
    ipEl('ipAddendaList').innerHTML = addenda.map(a => `<div class="ip-addendum">
        <span class="ip-addendum-meta">${escHtml(a.added_by_name || 'Office')} · ${escHtml(ipStamp(a.created_at))}</span>
        <p>${escHtml(a.note)}</p>
    </div>`).join('');

    ipEl('ipSigLines').innerHTML = ['teacher', 'parent', 'director'].map((role, i) => {
        const s = byRole[role];
        return `<div class="ip-sig">
            <div class="ip-sig-mark">${escHtml(s?.signed_name || '')}</div>
            <div class="ip-sig-rule"></div>
            <div class="ip-sig-cap">
                <strong>${i + 1} · ${IP_ROLE_LABEL[role]}</strong> · signed
                ${escHtml(ipTime(s?.signed_at))} ${escHtml(ipDate(s?.signed_at))}
                ${s?.on_device_of ? `<br><span class="ip-fine">In person on ${escHtml(s.on_device_of)}'s device</span>` : ''}
            </div>
        </div>`;
    }).join('');

    ipEl('ipFootNote').textContent =
        `Signed copy filed in the child's record and in the center's incident binder. ` +
        `A copy was delivered to the parent through the myMDO app on ` +
        `${ipDate(rec.completed_at)}. Original retained by the center for three years.`;
    ipEl('ipFootRight').innerHTML = `myMDO · ${escHtml(num)}<br>Printed from the myMDO portal`;

    ipEl('ipState').classList.add('hidden');
    ipEl('ipPage').classList.remove('hidden');
    document.title = `Incident ${num} — ${child.child_name || ''}`.trim();
}

document.addEventListener('DOMContentLoaded', () => {
    ipEl('ipPrint').addEventListener('click', () => window.print());
    ipLoad();
});
