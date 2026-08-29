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

    pdWireStatement();

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

// ⚠️ The period options exist because two different people ask for this
// document for two different reasons: an employer running a dependent-care
// reimbursement account wants ONE MONTH at a time, and a tax preparer wants
// the WHOLE YEAR for Form 2441. Year to date sits between them for anyone
// checking where they are.
//
// The statement itself is statement-print.html, which reads
// family_care_statement() directly — this card only builds the link. It does
// not compute or preview a total, deliberately: a figure here that disagreed
// with the document by a rounding step would be the parent's problem to
// explain to the IRS, not ours.
function pdStatementsSection() {
    const famId = portalContext?.family_id;
    if (!famId) {
        return pdCard('Statements and tax documents', '🧾', `
            <p class="pd-none">This sign-in is not linked to a family account, so there
            is no statement to issue.</p>`);
    }

    const now  = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Chicago' }));
    const year = now.getFullYear();
    const months = [];
    for (let m = now.getMonth(); m >= 0; m--) {
        const d = new Date(year, m, 1);
        months.push({
            value: `${year}-${String(m + 1).padStart(2, '0')}`,
            label: d.toLocaleDateString('en-US', { month: 'long', year: 'numeric' }),
        });
    }

    return pdCard('Statements and tax documents', '🧾', `
        <p class="pd-row-body">A statement of what you have paid for care, for your
        employer's reimbursement account or for your tax preparer (IRS Form 2441).</p>
        <div class="pd-stmt">
            <label class="pd-stmt-label" for="pdStmtPeriod">Period</label>
            <select id="pdStmtPeriod" class="pd-stmt-select">
                <option value="ytd">Year to date — ${year}</option>
                <option value="year:${year}">All of ${year}</option>
                <option value="year:${year - 1}">All of ${year - 1}</option>
                ${months.map(m => `<option value="month:${m.value}">${escHtml(m.label)}</option>`).join('')}
            </select>
            <button type="button" id="pdStmtOpen" class="pd-print">Open statement</button>
        </div>
        <p class="pd-fine">Opens as a printable page. If a month has not been
        reconciled by the office yet, the statement will say so rather than give you
        a total that is short.</p>`);
}

// month:YYYY-MM | year:YYYY | ytd  →  { from, to }
function pdStatementRange(value) {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    if (String(value).startsWith('month:')) {
        const [y, m] = value.slice(6).split('-').map(Number);
        const last = new Date(y, m, 0).getDate();   // day 0 of next month
        return { from: `${value.slice(6)}-01`, to: `${value.slice(6)}-${String(last).padStart(2, '0')}` };
    }
    if (String(value).startsWith('year:')) {
        const y = value.slice(5);
        return { from: `${y}-01-01`, to: `${y}-12-31` };
    }
    return { from: today.slice(0, 4) + '-01-01', to: today };   // ytd
}

function pdWireStatement() {
    const btn = pdEl('pdStmtOpen');
    if (!btn) return;
    btn.addEventListener('click', () => {
        const famId = portalContext?.family_id;
        if (!famId) return;
        const { from, to } = pdStatementRange(pdEl('pdStmtPeriod').value);
        window.open(`statement-print.html?family=${encodeURIComponent(famId)}`
            + `&from=${from}&to=${to}`, '_blank', 'noopener');
    });
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
