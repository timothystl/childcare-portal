// ============================================================
// portal-documents — the family's paperwork
// ============================================================
// Handoff, Surface 2 §4: "signed incident reports (the completed
// three-signature copy lands here), immunization records, policies, tax
// statements."
//
// ⚠️ AN INCIDENT REPORT IS ONLY LISTED HERE ONCE IT IS CLOSED, and that is
// enforced by RLS rather than by this file. The "parent read approved" policy
// on incident_reports filters to status = 'approved' AND the family's own
// child, so the query below carries neither condition — a report still waiting
// on the director's signature returns zero rows to a parent no matter what this
// code asks for.
//
// The printable copy opens incident-print.html, which fetches the document from
// incident_print_record(). Same gate, same refusal, whether the office or the
// family asks. A parent cannot obtain a half-signed report either.
//
// ⚠️ Sections with no real source say so plainly instead of rendering an empty
// shelf. Immunization records and tax statements have no table in this app
// today; a "Documents" tab that looks broken is worse than one that is honest
// about where a document currently comes from.

let pdReports = [];
let pdForms   = [];

function pdEl(id) { return document.getElementById(id); }

function pdDate(iso) {
    return iso ? new Date(iso).toLocaleDateString('en-US', {
        month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago',
    }) : '';
}

async function pdLoad() {
    const body = pdEl('pdBody');
    if (!body) return;
    body.innerHTML = '<p class="pt-empty">Loading…</p>';

    // Settled together: one slow fetch should not hold the whole tab, and the
    // forms list is a public setting that can legitimately be empty.
    const [reports, forms] = await Promise.allSettled([
        fetchMyIncidentReports(),
        loadEnrollmentForms(),
    ]);

    pdReports = reports.status === 'fulfilled' ? (reports.value || []) : [];
    pdForms   = forms.status   === 'fulfilled' ? (forms.value   || []) : [];
    if (reports.status === 'rejected') console.warn('documents/reports:', reports.reason);
    if (forms.status   === 'rejected') console.warn('documents/forms:',   forms.reason);

    pdRender();
}

function pdRender() {
    const body = pdEl('pdBody');
    if (!body) return;

    body.innerHTML = `
        <h1 class="portal-greeting">Documents</h1>
        <p class="portal-sub">Everything the center has on file for your family.</p>
        ${pdIncidentSection()}
        ${pdFormsSection()}
        ${pdImmunizationSection()}
        ${pdStatementsSection()}`;

    body.querySelectorAll('[data-print]').forEach(b => {
        b.onclick = () => window.open(
            `incident-print.html?id=${encodeURIComponent(b.dataset.print)}`, '_blank', 'noopener');
    });
}

function pdIncidentSection() {
    if (!pdReports.length) {
        return pdCard('Incident reports', '🩹', `
            <p class="pd-none">Nothing on file — no incident report has been filed
            and closed for your ${pdChildWord()}.</p>
            <p class="pd-fine">If a teacher files one, you'll be told the same day and
            asked to sign at pickup. The full signed copy appears here once the
            director closes it.</p>`);
    }

    const rows = pdReports.map(r => {
        const who = pdChildName(r.student_id);
        return `<div class="pd-row">
            <div class="pd-row-main">
                <div class="pd-row-title">${escHtml(
                    (r.incident_kind || r.incident_type || 'Incident')
                    + (who ? ` — ${who}` : ''))}</div>
                <div class="pd-row-sub">${escHtml(
                    `${pdDate(r.occurred_at)}${r.location ? ' · ' + r.location : ''}`)}</div>
                <p class="pd-row-body">${escHtml(r.description || '')}</p>
                ${r.action_taken ? `<p class="pd-row-body"><strong>What we did:</strong>
                    ${escHtml(r.action_taken)}</p>` : ''}
            </div>
            <button type="button" class="pd-print" data-print="${escHtml(String(r.id))}">
                🖨️ Signed copy
            </button>
        </div>`;
    }).join('');

    return pdCard('Incident reports', '🩹', rows + `
        <p class="pd-fine">Each copy carries all three signatures — the teacher who
        filed it, you at pickup, and the director. The center keeps the original for
        three years.</p>`);
}

function pdFormsSection() {
    if (!pdForms.length) {
        return pdCard('Policies and forms', '📋', `
            <p class="pd-none">The office hasn't posted any forms here yet.</p>`);
    }
    const rows = pdForms.map(f => `
        <a class="pd-row pd-row-link" href="${escHtml(f.url || '#')}" target="_blank" rel="noopener">
            <div class="pd-row-main">
                <div class="pd-row-title">${escHtml(f.name || 'Form')}</div>
                ${f.description ? `<div class="pd-row-sub">${escHtml(f.description)}</div>` : ''}
            </div>
            <span class="pd-print">Open</span>
        </a>`).join('');
    return pdCard('Policies and forms', '📋', rows);
}

// ⚠️ No immunization table exists in this app. Rather than draw an empty
// shelf that looks like a bug, the card says where the record actually lives
// today. When a table lands, this becomes a list and nothing else changes.
function pdImmunizationSection() {
    return pdCard('Immunization records', '💉', `
        <p class="pd-none">Your ${pdChildWord()}'s immunization record is held on
        paper in the office.</p>
        <p class="pd-fine">Missouri licensing requires a current copy on file. Message
        the office from the Messages tab if you need a copy or have an updated one to
        hand in.</p>`);
}

function pdStatementsSection() {
    return pdCard('Statements and tax documents', '🧾', `
        <p class="pd-none">Bills and year-end tax statements come from the office by
        email.</p>
        <p class="pd-fine">Online statements, a saved card and autopay are still to
        come. Nothing about how you pay has changed.</p>`);
}

function pdCard(title, icon, inner) {
    return `<section class="pd-card">
        <div class="pd-card-head"><span aria-hidden="true">${icon}</span>${escHtml(title)}</div>
        <div class="pd-card-body">${inner}</div>
    </section>`;
}

// portal-today owns the children list; this tab is often opened before Today
// has finished loading, so both the name lookup and the singular/plural wording
// have to survive an empty array.
function pdChildName(studentId) {
    const kids = typeof ptChildren !== 'undefined' ? ptChildren : [];
    const kid  = kids.find(c => String(c.id) === String(studentId));
    return kid ? kid.child_name : '';
}

function pdChildWord() {
    const kids = typeof ptChildren !== 'undefined' ? ptChildren : [];
    return kids.length > 1 ? 'children' : 'child';
}
