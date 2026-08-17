// ============================================================
// admin-who-owes — "Who owes" (design handoff `1e` — one list, worst first)
// ============================================================
// "$38,220 of $40,400 collected · 95%." Unpaid sorts first, worst at the top;
// paid-in-full collapses underneath with who entered it and when. One screen
// answers both "who owes" and "was the Beck check entered."
//
// ⚠️ THIS COMPUTES NOTHING NEW. _buildArRows() in admin-billing.js is the same
// function behind Accounts Receivable — billed, collected, outstanding, and
// status all come from there. This file adds sorting, aging color, the
// paid/unpaid split, and three new actions on top: nudge, payment plan,
// write-off. If this screen and Accounts Receivable ever show a different
// outstanding total for the same month, the bug is here, never in AR.
//
// ⚠️ NUDGES ARE HONEST ABOUT WHAT THEY DO TODAY. The handoff: "Nudges go to
// the parent app and email only." What is actually wired: a best-effort push
// to the family's phone (same /send-push call admin-calendar.js already
// makes for schedule changes) plus a written row in billing_nudges — the
// audit trail the "Nudged Jun 10, 20, 30 · not opened" line reads from. There
// is no separate reminder-email function in this app yet; the invoice email
// itself is the only email delivery that exists. Do not claim this sends an
// email until send-invoice (or a sibling) actually does.
//
// ⚠️ WRITE-OFF AND PAYMENT PLAN ARE DIRECTOR ACTIONS. Both write to their own
// ledger table with no DELETE grant for write-offs and no UPDATE for anyone
// but the plan's own status field — see finance_exceptions_and_actions.sql.

let _woMonth = '';
let _woRows  = [];
let _woNudgesByFamily = new Map();
let _woPlansByFamily  = new Map();
let _woBusy  = false;

function _woEl(id) { return document.getElementById(id); }

function _woDefaultMonth() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function _woDaysLate(sentAt) {
    if (!sentAt) return null;
    return Math.max(0, Math.floor((Date.now() - new Date(sentAt).getTime()) / 86400000));
}

function _woAgeBand(days) {
    if (days == null)  return 'unsent';
    if (days >= 30)     return 'severe';   // 30+
    if (days >= 15)     return 'watch';    // 15–29
    return 'fresh';                        // under 15
}

async function renderWhoOwesTool() {
    const monthEl = _woEl('woMonth');
    if (monthEl && !monthEl.value) monthEl.value = _woMonth || _woDefaultMonth();
    _woMonth = monthEl?.value || _woDefaultMonth();

    const body = _woEl('woBody');
    if (body) body.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        const [families, cycle] = await Promise.all([
            fetchAllFamilies({ includeArchived: true }),
            getOrCreateBillingCycle(_woMonth),
        ]);
        const [invoices, monthPayments, nudges] = await Promise.all([
            fetchInvoicesForCycle(cycle.id),
            fetchPaymentsForMonth(_woMonth).catch(() => []),
            fetchAllNudgesSince(`${_woMonth}-01`).catch(() => []),
        ]);

        _woRows = _buildArRows(_woMonth, families, invoices, monthPayments)
            .filter(r => r.billed > 0 || r.outstanding > 0);

        _woNudgesByFamily = new Map();
        nudges.forEach(n => {
            const arr = _woNudgesByFamily.get(n.family_id) || [];
            arr.push(n);
            _woNudgesByFamily.set(n.family_id, arr);
        });

        const plans = await fetchPaymentPlans({ activeOnly: true }).catch(() => []);
        _woPlansByFamily = new Map(plans.map(p => [p.family_id, p]));
    } catch (err) {
        console.error('renderWhoOwesTool:', err);
        if (body) body.innerHTML = `<p class="empty-hint">Could not load — ${escHtml(err.message || err)}</p>`;
        return;
    }
    _woRender();
}

function _woRender() {
    const body = _woEl('woBody');
    if (!body) return;

    const unpaid = _woRows.filter(r => r.outstanding > 0)
        .sort((a, b) => b.outstanding - a.outstanding || _woSentRank(b) - _woSentRank(a));
    const paid = _woRows.filter(r => r.outstanding <= 0 && r.billed > 0);

    const totalBilled    = _woRows.reduce((s, r) => s + r.billed, 0);
    const totalCollected = _woRows.reduce((s, r) => s + r.collected, 0);
    const pct = totalBilled ? Math.round((totalCollected / totalBilled) * 100) : 0;

    const methodCounts = { check: 0, feed: 0 };
    _woRows.forEach(r => (r.payments || []).forEach(p => {
        if (p.source === 'manual' || p.payment_method === 'check') methodCounts.check++;
        else methodCounts.feed++;
    }));

    body.innerHTML = `
    <div class="wo-summary">
        <div class="wo-bar">
            <div class="wo-bar-seg wo-seg-paid" style="width:${pct}%"></div>
            <div class="wo-bar-seg wo-seg-unpaid" style="width:${100 - pct}%"></div>
        </div>
        <div class="wo-summary-line">
            <strong>$${totalCollected.toLocaleString(undefined, { maximumFractionDigits: 0 })}</strong>
            of $${totalBilled.toLocaleString(undefined, { maximumFractionDigits: 0 })} collected · ${pct}%
            ${methodCounts.check || methodCounts.feed
                ? ` · hand-entered: ${methodCounts.check} · bank feed: ${methodCounts.feed}` : ''}
        </div>
    </div>

    <div class="wo-unpaid">
        ${unpaid.length ? unpaid.map(_woRow).join('') : '<p class="empty-hint">Everyone billed this month has paid in full.</p>'}
    </div>

    ${paid.length ? `
    <button class="wo-paid-toggle" id="woPaidToggle" aria-expanded="false">
        Paid in full · ${paid.length} famil${paid.length === 1 ? 'y' : 'ies'} <span>▾</span>
    </button>
    <div class="wo-paid-list hidden" id="woPaidList">
        ${paid.map(_woPaidRow).join('')}
    </div>` : ''}`;

    _woBind();
}

// Sort tiebreak: an unsent bill (billed via a draft that was never emailed)
// sorts after everything with a real age, since "how many days late" is
// undefined for it.
function _woSentRank(r) { return r.sentAt ? new Date(r.sentAt).getTime() : Infinity; }

function _woRow(r) {
    const days = _woDaysLate(r.sentAt);
    const band = _woAgeBand(days);
    const nudges = _woNudgesByFamily.get(r.familyId) || [];
    const plan = _woPlansByFamily.get(r.familyId);

    const why = plan
        ? `On a payment plan — ${plan.schedule?.length || 0} installment${plan.schedule?.length === 1 ? '' : 's'}`
        : r.collected > 0
            ? `Partial payment — $${r.outstanding.toFixed(2)} remaining`
            : days == null
                ? 'Billed but not yet sent'
                : 'No payment received';

    const nudgeLine = nudges.length
        ? `Nudged ${nudges.slice(0, 4).map(n => friendlyShort(String(n.sent_at).slice(0, 10))).join(', ')}` +
          `${nudges.length > 4 ? ` +${nudges.length - 4} more` : ''} · ` +
          `${nudges.some(n => n.opened_at) ? 'opened' : 'not opened'}`
        : '';

    return `<div class="wo-card band-${band}" data-family="${escHtml(r.familyId)}">
        <div class="wo-card-main">
            <div>
                <div class="wo-card-name">${escHtml(r.familyName)}
                    ${r.isLocked ? '<span class="wo-locked" title="Registration locked">🔒</span>' : ''}</div>
                <div class="wo-card-days">${days == null ? 'Not sent yet' : `${days} day${days === 1 ? '' : 's'} late`}</div>
            </div>
            <div class="wo-card-amt">$${r.outstanding.toFixed(2)}</div>
        </div>
        <div class="wo-card-why">${escHtml(why)}${nudgeLine ? ` · <span class="wo-nudge-trail">${escHtml(nudgeLine)}</span>` : ''}</div>
        <div class="wo-card-actions">
            <button class="btn-xs wo-nudge" data-id="${escHtml(r.familyId)}" data-inv="${escHtml(String(r.invoiceId || ''))}">Nudge</button>
            <button class="btn-xs wo-payment" data-id="${escHtml(r.familyId)}" data-inv="${escHtml(String(r.invoiceId || ''))}" data-amt="${r.outstanding}">💳 Record payment</button>
            ${!plan ? `<button class="btn-xs wo-plan" data-id="${escHtml(r.familyId)}" data-inv="${escHtml(String(r.invoiceId || ''))}" data-amt="${r.outstanding}" data-name="${escHtml(r.familyName)}">Payment plan</button>` : ''}
            <button class="btn-xs wo-writeoff" data-id="${escHtml(r.familyId)}" data-inv="${escHtml(String(r.invoiceId || ''))}" data-amt="${r.outstanding}" data-name="${escHtml(r.familyName)}">Write off</button>
        </div>
    </div>`;
}

function _woPaidRow(r) {
    const paidVia = (r.payments || [])[0];
    const provenance = paidVia
        ? (paidVia.source === 'manual' || paidVia.payment_method === 'check'
            ? `Check${paidVia.note ? ' #' + escHtml(paidVia.note) : ''} · entered by ${escHtml(paidVia.created_by || 'the office')} ${friendlyShort(paidVia.payment_date)}`
            : `Autopay · ${friendlyShort(paidVia.payment_date)}`)
        : '';
    return `<div class="wo-paid-row">
        <span class="wo-paid-name">${escHtml(r.familyName)}</span>
        <span class="wo-paid-amt">$${r.billed.toFixed(2)}</span>
        <span class="wo-paid-via">${provenance}</span>
    </div>`;
}

function _woBind() {
    _woEl('woPaidToggle')?.addEventListener('click', () => {
        const list = _woEl('woPaidList');
        const btn  = _woEl('woPaidToggle');
        const open = !list.classList.contains('hidden');
        list.classList.toggle('hidden', open);
        btn.setAttribute('aria-expanded', String(!open));
    });
    document.querySelectorAll('.wo-nudge').forEach(b => b.addEventListener('click', () => _woNudge(b.dataset.id, b.dataset.inv, b)));
    document.querySelectorAll('.wo-payment').forEach(b => b.addEventListener('click', () =>
        openRecordPaymentModal(b.dataset.id, b.dataset.inv || null, parseFloat(b.dataset.amt))));
    document.querySelectorAll('.wo-plan').forEach(b => b.addEventListener('click', () => _woOpenPlan(b.dataset)));
    document.querySelectorAll('.wo-writeoff').forEach(b => b.addEventListener('click', () => _woOpenWriteOff(b.dataset)));
    _woEl('woNudgeAllBtn')?.addEventListener('click', _woNudgeAll);
    _woEl('woRecordCheckBtn')?.addEventListener('click', () => openRecordPaymentModal(null, null, null));
}

// The push half of a nudge — same call admin-calendar.js already makes for
// schedule changes. Best-effort: a failed push must not stop the audit row
// from being written, since the row is what makes the trail honest either way.
async function _woSendPush(familyId, title, body) {
    try {
        const { data: { session } } = await sbClient.auth.getSession();
        await fetch('/send-push', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${session?.access_token || ''}` },
            body: JSON.stringify({ family_id: familyId, title, body }),
        });
    } catch (e) { console.warn('nudge push (non-fatal):', e); }
}

async function _woNudge(familyId, invoiceId, btn) {
    const row = _woRows.find(r => r.familyId === familyId);
    if (!row) return;
    btn.disabled = true;
    try {
        await _woSendPush(familyId, 'A note from MDO', `Your account has a balance of $${row.outstanding.toFixed(2)}. Open the portal for details.`);
        const { data: { session } } = await sbClient.auth.getSession();
        await insertNudge({
            family_id: familyId, invoice_id: invoiceId || null,
            channel: 'push', sent_by: session?.user?.email || 'admin',
        });
        showToast(`Nudged ${row.familyName}.`);
        await renderWhoOwesTool();
    } catch (e) {
        alert('Could not send that nudge: ' + (e.message || e));
        btn.disabled = false;
    }
}

async function _woNudgeAll() {
    const unpaid = _woRows.filter(r => r.outstanding > 0 && r.familyId);
    if (!unpaid.length) { alert('Nobody unpaid to nudge.'); return; }
    if (!confirm(`Nudge ${unpaid.length} famil${unpaid.length === 1 ? 'y' : 'ies'}?`)) return;
    const btn = _woEl('woNudgeAllBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
        const { data: { session } } = await sbClient.auth.getSession();
        for (const r of unpaid) {
            await _woSendPush(r.familyId, 'A note from MDO', `Your account has a balance of $${r.outstanding.toFixed(2)}. Open the portal for details.`);
            await insertNudge({ family_id: r.familyId, invoice_id: r.invoiceId || null, channel: 'push', sent_by: session?.user?.email || 'admin' });
        }
        showToast(`Nudged ${unpaid.length} famil${unpaid.length === 1 ? 'y' : 'ies'}.`);
        await renderWhoOwesTool();
    } catch (e) {
        alert('Could not finish nudging: ' + (e.message || e));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Nudge the unpaid'; }
    }
}

// ── Payment plan ────────────────────────────────────────────
function _woOpenPlan({ id, inv, amt, name }) {
    const n = prompt(`Payment plan for ${name} — how many installments?`, '2');
    const count = parseInt(n, 10);
    if (!count || count < 1) return;
    const per = Math.round((parseFloat(amt) / count) * 100) / 100;
    const schedule = Array.from({ length: count }, (_, i) => {
        const due = new Date();
        due.setMonth(due.getMonth() + i + 1);
        return { due_date: due.toISOString().slice(0, 10), amount: per };
    });
    const note = prompt('Anything to note about this plan? (optional)') || '';
    _woSavePlan(id, inv, parseFloat(amt), schedule, note, name);
}

async function _woSavePlan(familyId, invoiceId, amount, schedule, note, name) {
    try {
        const { data: { session } } = await sbClient.auth.getSession();
        await insertPaymentPlan({
            family_id: familyId, invoice_id: invoiceId || null, total_amount: amount,
            schedule, note: note || null, approved_by: session?.user?.email || 'admin',
        });
        showToast(`Payment plan set for ${name}.`);
        await renderWhoOwesTool();
    } catch (e) {
        alert('Could not save that plan: ' + (e.message || e));
    }
}

// ── Write off ───────────────────────────────────────────────
function _woOpenWriteOff({ id, inv, amt, name }) {
    if (!confirm(`Write off $${parseFloat(amt).toFixed(2)} owed by ${name}?\n\nThis forgives the balance and posts to the bookkeeper's queue. It does not undo — reverse it by recording a manual adjustment if needed.`)) return;
    const note = prompt('Why? (goes on the record)') || '';
    if (!note.trim()) { alert('A write-off needs a reason.'); return; }
    _woSaveWriteOff(id, inv, parseFloat(amt), note.trim(), name);
}

async function _woSaveWriteOff(familyId, invoiceId, amount, note, name) {
    try {
        const { data: { session } } = await sbClient.auth.getSession();
        await insertWriteOff({
            family_id: familyId, invoice_id: invoiceId || null, amount, note,
            approved_by: session?.user?.email || 'admin',
        });
        // The AR/invoice figure itself is untouched — a write-off is recorded
        // alongside the balance, not subtracted from billing_invoices, so the
        // original bill stays the historical record of what was actually
        // charged. The bookkeeper reconciles the difference at close.
        showToast(`Written off for ${name}. It's in the bookkeeper's queue.`);
        await renderWhoOwesTool();
    } catch (e) {
        alert('Could not record that write-off: ' + (e.message || e));
    }
}
