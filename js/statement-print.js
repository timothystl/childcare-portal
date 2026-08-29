// ============================================================
// statement-print — the printable childcare statement
// ============================================================
// Opened as statement-print.html?family=<uuid>&from=YYYY-MM-DD&to=YYYY-MM-DD
// by both the parent portal and the admin portal. Which of those you are is
// decided in the database (is_admin() OR the family is your own), not by which
// app opened the window — same stance as incident-print.js.
//
// ⚠️ Two refusals, and neither has an override. A statement missing the
// provider's EIN is unusable on Form 2441, and a statement covering a month
// whose payments were never recorded understates what a family paid. Both
// would be filed anyway by someone who trusted it.

function spEl(id) { return document.getElementById(id); }

function spEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function spMoney(n) {
    return '$' + (Number(n) || 0).toLocaleString('en-US',
        { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Date-only strings are civil dates. new Date('YYYY-MM-DD') is UTC by spec and
// lands on the previous day in Central — the trap this repo already documents.
function spDate(d, opts) {
    if (!d) return '—';
    return new Date(String(d) + 'T12:00:00').toLocaleDateString('en-US',
        opts || { month: 'long', day: 'numeric', year: 'numeric' });
}

function spFail(title, detail) {
    const el = spEl('spState');
    el.className = 'sp-state sp-state-fail';
    el.innerHTML = `<strong>${spEsc(title)}</strong><p>${detail}</p>`;
    el.classList.remove('hidden');
    spEl('spPage').classList.add('hidden');
    spEl('spBarNote').textContent = 'Not issued';
}

function spParams() {
    const q = new URLSearchParams(location.search);
    return { family: q.get('family'), from: q.get('from'), to: q.get('to') };
}

// ── The two gates ───────────────────────────────────────────

// Name, address and EIN are what a tax preparer needs. The license number is
// genuinely optional — some states do not issue one — so it is rendered when
// present and its row removed when not, rather than blocking the document.
function spMissingProviderFields(p) {
    const need = [
        ['legal_name', 'Provider name'],
        ['address',    'Address'],
        ['ein',        'Employer Identification Number (EIN)'],
    ];
    return need.filter(([k]) => !String(p?.[k] || '').trim()).map(([, label]) => label);
}

// A month with care days and no payment recorded means the total is short.
// Reported by month so the office knows exactly which one to reconcile.
function spUncoveredMonths(coverage) {
    return (coverage || []).filter(m => (m.care_days || 0) > 0 && (m.payments || 0) === 0);
}

function spMonthLabel(month) {
    const [y, m] = String(month).split('-').map(Number);
    return new Date(y, m - 1, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
}

// ── Render ──────────────────────────────────────────────────

function spRender(s, params) {
    const p = s.provider || {};
    const fam = s.family || {};

    spEl('spOrgName').textContent = p.legal_name || '';
    spEl('spOrgSub').textContent  = p.org_line || '';
    spEl('spOrgAddr').textContent = [p.address, p.phone, p.email].filter(Boolean).join(' · ');

    const sameYear = String(params.from).slice(0, 4) === String(params.to).slice(0, 4);
    const wholeYear = sameYear && String(params.from).endsWith('-01-01') && String(params.to).endsWith('-12-31');
    spEl('spTaxYear').textContent = wholeYear ? String(params.from).slice(0, 4)
        : `${spDate(params.from, { month: 'short', day: 'numeric' })} – ${spDate(params.to, { month: 'short', day: 'numeric', year: 'numeric' })}`;

    spEl('spTitle').textContent = wholeYear ? 'Year-End Childcare Statement' : 'Childcare Statement';
    spEl('spLede').textContent = wholeYear
        ? 'For claiming the Child and Dependent Care Credit. Provide this statement to your tax preparer or attach to Form 2441.'
        : 'For dependent-care reimbursement. Provide this statement to your employer or benefits administrator.';

    spEl('spProvName').textContent = p.legal_name || '';
    spEl('spProvAddr').textContent = p.address || '';
    spEl('spProvEin').textContent  = p.ein || '';
    if (String(p.license_no || '').trim()) {
        spEl('spProvLic').textContent = p.license_no;
    } else {
        spEl('spProvLicRow').remove();
    }

    const parents = [fam.parent_name, fam.parent2_name].filter(Boolean).join(' and ');
    spEl('spParent').textContent = parents || fam.parent_email || '';

    const kids = s.children || [];
    spEl('spChildLabel').textContent = kids.length === 1 ? 'Child' : 'Children';
    spEl('spChildren').innerHTML = kids.length
        ? kids.map(c => `${spEsc(c.child_name)} <span class="sp-kid-days">(${c.days} ${
              c.days === 1 ? 'day' : 'days'})</span>`).join('<br>')
        : '<span class="sp-none">No care days recorded in this period</span>';

    const first = s.period?.first_care_date, last = s.period?.last_care_date;
    spEl('spCarePeriod').textContent = (first && last)
        ? `${spDate(first)} – ${spDate(last)}`
        : `${spDate(params.from)} – ${spDate(params.to)}`;

    spEl('spTotalPaid').textContent = spMoney(s.total_paid);
    spEl('spTotalPaidSub').textContent =
        `${spDate(params.from, { month: 'short', day: 'numeric' })} – ${spDate(params.to, { month: 'short', day: 'numeric', year: 'numeric' })}`;
    spEl('spTotalDays').textContent = String(s.days_of_care ?? 0);
    spEl('spTotalDaysSub').textContent = 'days attended in this period';

    spEl('spNote').textContent =
        'This statement reflects amounts paid directly to the provider named above for qualifying '
        + 'childcare expenses during the stated period. It does not constitute tax advice — please '
        + 'consult your tax preparer regarding eligibility for the Child and Dependent Care Credit '
        + '(IRS Form 2441).';

    const pays = s.payments || [];
    if (!pays.length) {
        spEl('spPaymentsBlock').remove();
    } else {
        spEl('spPaymentsTable').innerHTML =
            '<tr><th>Date</th><th>Method</th><th class="sp-right">Amount</th></tr>'
            + pays.map(x => `<tr>
                    <td>${spEsc(spDate(x.payment_date, { month: 'short', day: 'numeric', year: 'numeric' }))}</td>
                    <td>${spEsc(x.payment_method || '—')}</td>
                    <td class="sp-right">${spEsc(spMoney(x.amount))}</td>
                </tr>`).join('')
            + `<tr class="sp-total-row"><td colspan="2">Total</td>
                 <td class="sp-right">${spEsc(spMoney(s.total_paid))}</td></tr>`;
    }

    spEl('spIssued').textContent = 'Issued ' + spDate(
        new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' }));
    spEl('spContact').textContent = [p.email, p.phone].filter(Boolean).join(' · ');
    spEl('spSignName').textContent = p.signature_name || p.legal_name || '';

    spEl('spState').classList.add('hidden');
    spEl('spPage').classList.remove('hidden');
    spEl('spBarNote').textContent = 'One statement · letter · keep for your records';
    spEl('spPrint').hidden = false;
}

async function spLoad() {
    const params = spParams();
    if (!params.family || !params.from || !params.to) {
        spFail('This link is incomplete.',
            'A statement needs a family and a date range. Open it again from the Documents tab or the admin portal.');
        return;
    }

    let s;
    try {
        s = await fetchFamilyCareStatement(params.family, params.from, params.to);
    } catch (e) {
        spFail('The statement could not be loaded.', spEsc(e.message || String(e)));
        return;
    }

    if (!s) {
        spFail('This statement is not available to you.',
            'Either the sign-in does not belong to this family, or the family no longer exists.');
        return;
    }

    const missing = spMissingProviderFields(s.provider);
    if (missing.length) {
        spFail('The provider tax details are not on file yet.',
            'A statement is only usable on Form 2441 once it carries the center’s '
            + 'legal name, address and EIN. Still to enter: <strong>'
            + missing.map(spEsc).join(', ') + '</strong>.<br><br>'
            + 'An administrator adds these once, in the admin portal under '
            + 'Settings → Provider tax details.');
        return;
    }

    const uncovered = spUncoveredMonths(s.coverage);
    if (uncovered.length) {
        spFail('This period is not fully reconciled, so the statement was not issued.',
            'These months have care days on record but no payment recorded against them, '
            + 'which means the total below them would be short: <strong>'
            + uncovered.map(m => spEsc(spMonthLabel(m.month)) + ' ('
                + m.care_days + ' care ' + (m.care_days === 1 ? 'day' : 'days') + ')').join(', ')
            + '</strong>.<br><br>'
            + 'Record those payments in Finance → Ledger, or choose a period that ends '
            + 'before them. A statement that understates what a family paid is worse than '
            + 'one they have to wait for.');
        return;
    }

    spRender(s, params);
}

document.addEventListener('DOMContentLoaded', () => {
    spEl('spPrint')?.addEventListener('click', () => window.print());
    spLoad();
});
