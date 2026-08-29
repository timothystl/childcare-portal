// ============================================================
// portal-documents — the family's paperwork
// ============================================================
// Handoff, Surface 2 §4: "signed incident reports (the completed
// three-signature copy lands here), immunization records, policies, tax
// statements."
//
// Renders into #pdBody, which lives inside the Account tab (not a tab of its
// own — see the note on PT_TABS in portal-nav.js). Loaded by ptGoTab
// alongside paLoad() the first time a parent opens Account.
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

    // No page-level heading here — #pdBody renders inside the Account tab
    // (portal.html), under the "Documents" <h2> that already sits above it.
    body.innerHTML = `
        ${pdIncidentSection()}
        ${pdFormsSection()}
        ${pdImmunizationSection()}
        ${pdStatementsSection()}`;

    body.querySelectorAll('[data-print]').forEach(b => {
        b.onclick = () => window.open(
            `incident-print.html?id=${encodeURIComponent(b.dataset.print)}`, '_blank', 'noopener');
    });

    body.querySelectorAll('.pd-upload-input').forEach(input => {
        input.addEventListener('change', () => pdUploadDocument(input));
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

// ⚠️ No immunization table exists in this app, and this card doesn't list
// anything back — uploadChildDocumentAsParent() is write-only by design
// (see parent_upload_child_documents.sql), the same way handing a paper
// copy across the counter isn't something you can browse afterward. The
// office reviews what actually landed in the child-documents bucket; this
// card only confirms that a file was handed in, one child at a time.
function pdImmunizationSection() {
    const kids = typeof ptChildren !== 'undefined' ? ptChildren : [];
    const rows = kids.map(k => `
        <div class="pd-upload-row" data-student="${escHtml(String(k.id))}">
            ${kids.length > 1 ? `<div class="pd-upload-name">${escHtml(k.child_name)}</div>` : ''}
            <div class="pd-upload-btns">
                <label class="pd-upload-btn">📷 Take a photo
                    <input type="file" class="pd-upload-input hidden-file-input"
                           accept="image/*" capture="environment" data-student="${escHtml(String(k.id))}">
                </label>
                <label class="pd-upload-btn">&#8593; Upload a file
                    <input type="file" class="pd-upload-input hidden-file-input"
                           accept="image/jpeg,image/png,image/webp,application/pdf" data-student="${escHtml(String(k.id))}">
                </label>
            </div>
            <p class="pd-upload-status" data-student-status="${escHtml(String(k.id))}"></p>
        </div>`).join('');

    const forWhom = kids.length > 1 ? 'each of your children' : 'your child';
    return pdCard('Immunization & medical records', '💉', `
        <p class="pd-none">Missouri licensing requires a current immunization record on
        file for ${forWhom}. You can hand one in below, or a doctor's note for anything
        else we need on file.</p>
        ${rows || ''}
        <p class="pd-fine">A photo or a scanned copy both work. Once it's uploaded, the
        office reviews it and adds it to your ${pdChildWord()}'s file — you won't see it
        listed back here, the same way you wouldn't see a paper copy again once you
        hand it across the counter. Already sent one and just checking? Ask from the
        Messages tab instead of uploading it twice.</p>`);
}

async function pdUploadDocument(input) {
    const studentId = input.dataset.student;
    const file = input.files?.[0];
    input.value = ''; // allow picking the exact same file again later
    if (!studentId || !file) return;

    const status = document.querySelector(`.pd-upload-status[data-student-status="${studentId}"]`);
    if (status) { status.textContent = 'Uploading…'; status.className = 'pd-upload-status'; }

    try {
        await uploadChildDocumentAsParent(studentId, file);
        if (status) {
            status.textContent = `Uploaded — ${pdDate(new Date().toISOString())}. The office will add it to the file.`;
            status.classList.add('pd-upload-ok');
        }
    } catch (err) {
        if (status) {
            status.textContent = `Couldn't upload that: ${err.message || err}. Please try again, or message the office.`;
            status.classList.add('pd-upload-err');
        }
    }
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
