// ============================================================
// admin-bill-month — "Bill the month" (design handoff `1c`)
// ============================================================
// "38 drafts built from registrations, 5 need you." The client's own framing:
// she does not read 38 rows to find the 5 that changed — the engine finds them
// and she reviews only those. The other 33 release in one tap.
//
// ⚠️ THIS COMPUTES NOTHING NEW FOR THE PREVIEW. Every displayed figure comes from
// _buildFamilyBillingData() in admin-reports.js, the same function behind
// Family Billing Summary, the Invoices tool and the Director dashboard's
// "Billed this month" card. This file adds exactly one thing on top: which
// families changed since last month, and why. If a number here ever disagrees
// with Family Billing Summary for the same month, the bug is in the exception
// diff below. The database independently recomputes the stored invoice amount
// when it is drafted, so this screen never submits a caller-calculated dollar.
//
// ⚠️ RELEASING WRITES THROUGH THE SAME PATH AS THE INVOICES TOOL.
// reconcileBillingInvoice() + emailInvoices() are the exact calls
// saveInvoiceDrafts()/emailAllInvoices() already make in admin-billing.js —
// this file does not reimplement drafting or sending, it scopes those two
// calls to a chosen subset of families (the clean 33, or one approved
// exception) instead of the whole month. send-invoice still reads the
// recipient and every figure itself from the database; nothing here can aim a
// bill at the wrong address or a wrong amount.

let _bmMonth  = '';
let _bmRows   = [];   // every family this month, clean + exception, from the engine
let _bmBusy   = false;

function _bmEl(id) { return document.getElementById(id); }

function _bmDefaultMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function _bmPrevMonth(month) {
    const [y, m] = month.split('-').map(Number);
    return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

// ── The exception engine ─────────────────────────────────────
// Reads the same globals _buildFamilyBillingData() already relies on
// (allFamiliesData, allRegistrations, the discount map) — every other billing
// screen in this app does the same rather than threading them as parameters,
// and matching that convention means this can't quietly drift from what
// Family Billing Summary shows for the same inputs.
//
// Returns { rows, cleanTotal, exceptionCount } where each row is:
//   { familyId, name, email, children, days, base, discount, changeFees,
//     regFee, newFamilyFee, credit, total, prevTotal, isException, causes[] }
async function computeBillMonthExceptions(month) {
    if (!allFamiliesData || !allFamiliesData.length) {
        allFamiliesData = await fetchAllFamilies({ includeArchived: false });
        _discountMap = null;
    }
    if (!allRegistrations || !allRegistrations.length) {
        allRegistrations = await fetchAllRegistrations();
    }

    const prevMonth = _bmPrevMonth(month);
    let overrideRows = [];
    try { overrideRows = await fetchBillingOverrides(month); } catch (e) { console.warn('bm overrides:', e); }
    const overridesMap = new Map(overrideRows.map(r => [
        `${(r.parent_email || '').toLowerCase()}:${(r.child_name || '').toLowerCase()}`,
        parseFloat(r.override_amount),
    ]));

    const [thisMonth, lastMonth, students, credits] = await Promise.all([
        Promise.resolve(_buildFamilyBillingData(month, overridesMap)),
        Promise.resolve(_buildFamilyBillingData(prevMonth)),
        fetchStudents().catch(() => []),
        fetchBillingCredits({ unappliedOnly: true }).catch(() => []),
    ]);

    // Fee settings — same source as Family Billing Summary and the report.
    const regFeeAmount    = window._regFeeAmount ?? (await fetchSetting('registration_fee').catch(() => 0)) ?? 0;
    const newFamilyFee    = window._newFamilyFee ?? (await fetchSetting('new_family_fee').catch(() => 0)) ?? 0;
    const supplyFeeMax    = window._supplyFeeFamilyMax ?? (await fetchSetting('supply_fee_family_max').catch(() => 0)) ?? 0;
    const currentYear     = currentFeeCycleYear(window._regFeeRenewalDate);

    const studentByName = new Map();
    students.forEach(s => {
        const k = (s.child_name || '').toLowerCase().trim();
        if (!studentByName.has(k)) studentByName.set(k, s);
    });

    const familyByEmail = new Map();
    allFamiliesData.forEach(f => {
        const k = (f.parent_email || '').toLowerCase().trim();
        if (k && !familyByEmail.has(k)) familyByEmail.set(k, f);
    });

    const creditsByFamily = new Map();
    credits.forEach(c => {
        const arr = creditsByFamily.get(c.family_id) || [];
        arr.push(c);
        creditsByFamily.set(c.family_id, arr);
    });

    // Prior month, by child name — used only to tell "new this month" apart
    // from an existing child. A plain day-count difference from last month is
    // NOT surfaced as a cause: every family's schedule varies month to month
    // by design (that's the whole point of flexible day booking), so flagging
    // it read as "this kid has 4 days this month, 5 last month" on every
    // single row — noise dressed up as a review flag, not a real exception.
    const prevChildDays = new Map();   // childName(lower) -> {full, half, total}
    lastMonth.forEach(fam => fam.children.forEach(c => {
        prevChildDays.set((c.childName || '').toLowerCase().trim(), {
            full: c.fullDays, half: c.halfDays, total: c.fullDays + c.halfDays,
        });
    }));
    const prevFamilyTotal = new Map();  // parentEmail(lower) -> family total last month
    lastMonth.forEach(fam => {
        const total = fam.children.reduce((s, c) => s + (c.hasOverride ? c.overrideAmount : c.subtotal) + (c.changeFees || 0), 0);
        prevFamilyTotal.set((fam.parentEmail || '').toLowerCase().trim(), total);
    });
    const prevChildCount = new Map(); // parentEmail(lower) -> child count last month
    lastMonth.forEach(fam => prevChildCount.set((fam.parentEmail || '').toLowerCase().trim(), fam.children.length));

    // ── This month's families ──
    const regFeeOwedByChild = new Map();
    thisMonth.forEach(fam => fam.children.forEach(c => {
        const key = (c.childName || '').toLowerCase().trim();
        if (regFeeOwedByChild.has(key)) return;
        const student = studentByName.get(key);
        regFeeOwedByChild.set(key, regFeeAmount > 0 && !!student && student.reg_fee_paid_year !== currentYear);
    }));

    const rows = thisMonth.map(fam => {
        const emailKey = (fam.parentEmail || '').toLowerCase().trim();
        const match = allFamiliesData.find(f =>
            (f.parent_email || '').toLowerCase() === emailKey ||
            (f.parent2_email || '').toLowerCase() === emailKey);

        const owedChildren = fam.children.filter(c => regFeeOwedByChild.get((c.childName || '').toLowerCase().trim()));
        const rawSupply    = owedChildren.length * regFeeAmount;
        const regFee       = supplyFeeMax > 0 && rawSupply > supplyFeeMax ? supplyFeeMax : rawSupply;
        const familyNewFee = newFamilyFee > 0 && match && !match.new_family_fee_charged ? newFamilyFee : 0;

        const famCredits = match ? (creditsByFamily.get(match.id) || []) : [];
        const creditTotal = famCredits.reduce((s, c) => s + parseFloat(c.amount || 0), 0);

        let base = 0, discount = 0, changeFees = 0;
        const causes = [];
        fam.children.forEach(c => {
            const billed = c.hasOverride ? c.overrideAmount : c.subtotal;
            base       += billed;
            discount   += (c.discountDollar || 0) + (c.sibDiscount || 0);
            changeFees += c.changeFees || 0;

            const key  = (c.childName || '').toLowerCase().trim();
            const prev = prevChildDays.get(key);
            if (!prev) {
                causes.push({ kind: 'new', child: c.childName, text: `${c.childName}: new this month` });
            }

            const student = studentByName.get(key);
            if (student?.discount_expires_at) {
                const days2go = Math.floor((new Date(student.discount_expires_at) - Date.now()) / 86400000);
                if (days2go <= 45) {
                    causes.push({
                        kind: 'discount', child: c.childName,
                        text: days2go < 0
                            ? `${c.childName}: ${student.discount_type === 'scholarship' ? 'Scholarship' : 'Discount'} expired ${friendlyShort(student.discount_expires_at)} — renew or bill full?`
                            : `${c.childName}: ${student.discount_type === 'scholarship' ? 'Scholarship' : 'Discount'} expires ${friendlyShort(student.discount_expires_at)}`,
                    });
                }
            }
        });

        if (regFeeOwedByChild.size && owedChildren.length && regFee > 0) {
            causes.push({ kind: 'fee', text: `Registration fee due — ${owedChildren.map(c => c.childName).join(', ')}` });
        }
        if (familyNewFee > 0) causes.push({ kind: 'fee', text: 'New-family fee due' });
        if (creditTotal > 0)  causes.push({ kind: 'credit', text: `$${creditTotal.toFixed(2)} credit on account, unapplied` });

        const prevCount = prevChildCount.get(emailKey);
        if (prevCount != null && fam.children.length > prevCount) {
            causes.push({ kind: 'sibling', text: 'New sibling added since last month' });
        }

        const total = Math.max(0, base + regFee + familyNewFee - creditTotal);

        return {
            familyId: match?.id || null,
            name: fam.parentName || '(no name)',
            email: fam.parentEmail || '',
            children: fam.children.map(c => c.childName).filter(Boolean),
            days: fam.children.reduce((s, c) => s + c.fullDays + c.halfDays, 0),
            base: Math.round(base * 100) / 100,
            discount: Math.round(discount * 100) / 100,
            changeFees: Math.round(changeFees * 100) / 100,
            regFee, familyNewFee, creditTotal,
            credits: famCredits,
            total: Math.round(total * 100) / 100,
            prevTotal: prevFamilyTotal.get(emailKey) ?? null,
            isException: causes.length > 0,
            causes,
        };
    });

    // Withdrawals: present last month, absent (or every child gone) this month.
    const thisMonthEmails = new Set(thisMonth.map(f => (f.parentEmail || '').toLowerCase().trim()));
    lastMonth.forEach(fam => {
        const emailKey = (fam.parentEmail || '').toLowerCase().trim();
        if (thisMonthEmails.has(emailKey)) return;
        const match = allFamiliesData.find(f =>
            (f.parent_email || '').toLowerCase() === emailKey || (f.parent2_email || '').toLowerCase() === emailKey);
        rows.push({
            familyId: match?.id || null,
            name: fam.parentName || '(no name)',
            email: fam.parentEmail || '',
            children: fam.children.map(c => c.childName).filter(Boolean),
            days: 0, base: 0, discount: 0, changeFees: 0, regFee: 0, familyNewFee: 0,
            creditTotal: 0, credits: [], total: 0,
            prevTotal: prevFamilyTotal.get(emailKey) ?? null,
            isException: true, withdrawn: true,
            causes: [{ kind: 'withdrawn', text: 'No days booked this month — withdrawn or on hold' }],
        });
    });

    rows.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    const exceptions = rows.filter(r => r.isException);
    const clean       = rows.filter(r => !r.isException);
    return {
        rows,
        exceptions,
        clean,
        cleanTotal: Math.round(clean.reduce((s, r) => s + r.total, 0) * 100) / 100,
        exceptionTotal: Math.round(exceptions.reduce((s, r) => s + r.total, 0) * 100) / 100,
    };
}

// ── The screen ──────────────────────────────────────────────

async function renderBillMonthTool() {
    const monthEl = _bmEl('bmMonth');
    if (monthEl && !monthEl.value) monthEl.value = _bmMonth || _bmDefaultMonth();
    _bmMonth = monthEl?.value || _bmDefaultMonth();

    const body = _bmEl('bmBody');
    if (body) body.innerHTML = '<p class="empty-hint">Building the month\'s drafts…</p>';
    try {
        const { rows } = await computeBillMonthExceptions(_bmMonth);
        _bmRows = rows;
    } catch (err) {
        console.error('renderBillMonthTool:', err);
        if (body) body.innerHTML = `<p class="empty-hint">Could not build drafts — ${escHtml(err.message || err)}</p>`;
        return;
    }
    _bmRender();
}

function _bmRender() {
    const body = _bmEl('bmBody');
    if (!body) return;

    const exceptions = _bmRows.filter(r => r.isException);
    const clean       = _bmRows.filter(r => !r.isException);
    const cleanTotal  = Math.round(clean.reduce((s, r) => s + r.total, 0) * 100) / 100;

    const [y, m] = _bmMonth.split('-').map(Number);
    const monthLabel = m ? `${MONTH_NAMES[m - 1]} ${y}` : _bmMonth;

    body.innerHTML = `
    <div class="bm-head">
        <div>
            <h2>${escHtml(monthLabel)} is drafted — ${exceptions.length} need${exceptions.length === 1 ? 's' : ''} you</h2>
            <p class="bm-sub">${_bmRows.length} families · your approval sends them</p>
        </div>
        <div class="bm-head-actions">
            <a class="btn-ghost" href="#" id="bmSeeAll">See all ${_bmRows.length}</a>
            <button class="btn-primary" id="bmReleaseClean" ${clean.length ? '' : 'disabled'}>
                Release the ${clean.length} clean bill${clean.length === 1 ? '' : 's'}
            </button>
        </div>
    </div>

    <div class="bm-grid">
        <div class="bm-exceptions">
            ${exceptions.length ? exceptions.map(_bmExceptionCard).join('') : `
                <div class="bm-empty">Nothing needs you. Every family's month matches what it billed last time.</div>`}
        </div>

        <aside class="bm-clean-card">
            <div class="bm-clean-head">The clean ${clean.length}</div>
            <div class="bm-clean-amt">$${cleanTotal.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</div>
            <p class="bm-clean-note">Nothing changed, so nothing to read.</p>
            <ul class="bm-clean-lines">
                <li>Tuition ${clean.length} famil${clean.length === 1 ? 'y' : 'ies'}</li>
                <li>Same rooms, same days, same discounts as last time</li>
            </ul>
            <button class="btn-primary bm-release-btn" id="bmReleaseClean2" ${clean.length ? '' : 'disabled'}>
                Release all ${clean.length}
            </button>
            <button class="btn-ghost bm-open-list" id="bmOpenClean">Open the list anyway</button>
        </aside>
    </div>

    <div class="bm-tracker">
        <div class="bm-track-step is-done"><span>✓</span>Drafted by the engine</div>
        <div class="bm-track-step ${exceptions.length ? 'is-open' : 'is-done'}">
            <span>${exceptions.length ? exceptions.length : '✓'}</span>Your approval — ${exceptions.length ? `${exceptions.length} open` : 'all clear'}
        </div>
        <div class="bm-track-step">
            <span>→</span>Sent to parents when you approve
        </div>
    </div>`;

    _bmBind();
}

function _bmExceptionCard(r) {
    const oldLine = r.prevTotal != null
        ? `<div class="bm-old">$${r.prevTotal.toFixed(2)} last time</div>` : '';
    const lines = [
        r.base       ? { label: 'Tuition', amt: r.base } : null,
        r.discount   ? { label: 'Discounts', amt: -r.discount } : null,
        r.changeFees ? { label: 'Schedule change fees', amt: r.changeFees } : null,
        r.regFee     ? { label: 'Registration fee', amt: r.regFee } : null,
        r.familyNewFee ? { label: 'New-family fee', amt: r.familyNewFee } : null,
        r.creditTotal ? { label: 'Credit applied', amt: -r.creditTotal } : null,
    ].filter(Boolean);

    return `<div class="bm-card" data-family="${escHtml(r.email)}">
        <div class="bm-card-head">
            <div>
                <div class="bm-card-name">${escHtml(r.name)}</div>
                <div class="bm-card-kids">${escHtml(r.children.join(', ') || '—')} · ${r.days} day${r.days === 1 ? '' : 's'}</div>
            </div>
            <div class="bm-card-causes">
                ${r.causes.map(c => `<span class="bm-cause bm-cause-${c.kind}">${escHtml(c.text)}</span>`).join('')}
            </div>
        </div>
        <div class="bm-card-math">
            <div class="bm-new">$${r.total.toFixed(2)}</div>
            ${oldLine}
            <div class="bm-lines">
                ${lines.map(l => `<span>${escHtml(l.label)} ${l.amt < 0 ? '−' : ''}$${Math.abs(l.amt).toFixed(2)}</span>`).join('')}
            </div>
        </div>
        <div class="bm-card-actions">
            ${r.withdrawn || !r.familyId
                ? `<span class="bm-nofamily">${r.withdrawn ? 'Nothing to bill' : 'No matching family record — fix the email in Family Directory'}</span>`
                : `<button class="btn-primary bm-approve" data-email="${escHtml(r.email)}">Approve $${r.total.toFixed(2)}</button>
                   <button class="btn-ghost bm-hold" data-email="${escHtml(r.email)}">Hold</button>`}
        </div>
    </div>`;
}

function _bmBind() {
    _bmEl('bmReleaseClean')?.addEventListener('click', _bmReleaseClean);
    _bmEl('bmReleaseClean2')?.addEventListener('click', _bmReleaseClean);
    _bmEl('bmOpenClean')?.addEventListener('click', e => { e.preventDefault(); _bmShowCleanList(); });
    _bmEl('bmSeeAll')?.addEventListener('click', e => { e.preventDefault(); _bmShowCleanList(); });
    document.querySelectorAll('.bm-approve').forEach(b => {
        b.addEventListener('click', () => _bmApproveOne(b.dataset.email, b));
    });
    document.querySelectorAll('.bm-hold').forEach(b => {
        b.addEventListener('click', () => _bmHoldOne(b.dataset.email));
    });
}

// A held family is simply left undrafted this pass — she reviews it again
// next time the screen is opened. Nothing to persist; "held" is the absence
// of an approval, not a state of its own.
function _bmHoldOne(email) {
    _bmRows = _bmRows.filter(r => r.email !== email);
    _bmRender();
    showToast('Held — it will come back up next time you open this.');
}

async function _bmApproveOne(email, btn) {
    const row = _bmRows.find(r => r.email === email);
    if (!row || !row.familyId) return;
    if (_bmBusy) return;
    _bmBusy = true;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = 'Sending…';
    try {
        const sentIds = await _bmDraftAndSend(_bmMonth, [row]);
        if (row.credits?.length) {
            const invId = sentIds[0];
            await Promise.all(row.credits.map(c => applyBillingCredit(c.id, invId).catch(() => null)));
        }
        _bmRows = _bmRows.filter(r => r.email !== email);
        _bmRender();
        showToast(`Sent — $${row.total.toFixed(2)} to ${row.name}.`);
    } catch (err) {
        alert('Could not approve that bill: ' + (err.message || err));
    } finally {
        _bmBusy = false;
        btn.disabled = false; btn.textContent = label;
    }
}

async function _bmReleaseClean() {
    const clean = _bmRows.filter(r => !r.isException && r.familyId);
    if (!clean.length) { alert('Nothing clean to release.'); return; }
    if (!confirm(`Release ${clean.length} clean bill${clean.length === 1 ? '' : 's'} totaling $${
        clean.reduce((s, r) => s + r.total, 0).toFixed(2)}?\n\nThey email to families now.`)) return;
    if (_bmBusy) return;
    _bmBusy = true;
    const btns = [_bmEl('bmReleaseClean'), _bmEl('bmReleaseClean2')].filter(Boolean);
    btns.forEach(b => { b.disabled = true; b.textContent = 'Sending…'; });
    try {
        await _bmDraftAndSend(_bmMonth, clean);
        _bmRows = _bmRows.filter(r => r.isException);
        _bmRender();
        showToast(`${clean.length} bill${clean.length === 1 ? '' : 's'} released.`);
    } catch (err) {
        alert('Could not release those bills: ' + (err.message || err));
    } finally {
        _bmBusy = false;
    }
}

/**
 * Draft, then email, a chosen subset of rows for a month. Scoped version of
 * saveInvoiceDrafts()/emailAllInvoices() in admin-billing.js — same two calls,
 * same order, restricted to the families passed in rather than the whole
 * month. Returns the invoice ids that were sent.
 */
async function _bmDraftAndSend(month, rows) {
    const drafted = [];
    for (const r of rows) {
        if (!r.familyId) continue;
        const inv = await reconcileBillingInvoice(r.familyId, month);
        if (!inv) continue;
        drafted.push({ id: inv.id, email: r.email });
    }
    if (!drafted.length) return [];

    await logAdminAction('draft', 'billing_invoice', null, { month, count: drafted.length, via: 'bill_the_month' });

    const withEmail    = drafted.filter(d => d.email);
    const withoutEmail = drafted.filter(d => !d.email);
    if (withEmail.length) {
        const res = await emailInvoices(withEmail.map(d => d.id));
        const skipped = res?.skipped || [];
        if (skipped.length) {
            alert(`${res.sent?.length || 0} sent, ${skipped.length} could not be emailed:\n\n` +
                  skipped.map(s => `· #${s.id} — ${s.reason}`).join('\n') +
                  `\n\nThose stay drafted — mark them sent by hand in Invoices once you know they went out another way.`);
        }
    }
    if (withoutEmail.length) {
        await markInvoicesSent(withoutEmail.map(d => ({ id: d.id, email: '' })));
    }
    return drafted.map(d => d.id);
}

// The escape hatch: show the whole month as a flat table, per the handoff's
// "an escape hatch to open the list anyway" — nobody should have to trust a
// count they cannot verify.
function _bmShowCleanList() {
    const body = _bmEl('bmBody');
    if (!body) return;
    const rows = _bmRows.map(r => `
        <tr class="${r.isException ? 'bm-list-exc' : ''}">
            <td>${escHtml(r.name)}</td>
            <td>${escHtml(r.children.join(', '))}</td>
            <td style="text-align:center">${r.days}</td>
            <td style="text-align:right">$${r.total.toFixed(2)}</td>
            <td>${r.isException ? escHtml(r.causes.map(c => c.text).join(' · ')) : 'Clean'}</td>
        </tr>`).join('');
    body.innerHTML = `
        <button class="btn-ghost" id="bmBackToCards">← Back</button>
        <div class="table-wrapper">
            <table class="report-table">
                <thead><tr><th>Family</th><th>Children</th><th>Days</th><th>Total</th><th>Status</th></tr></thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;
    _bmEl('bmBackToCards')?.addEventListener('click', _bmRender);
}
