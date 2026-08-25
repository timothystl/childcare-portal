// ============================================================
// admin-finance-home — Finance › Overview (design handoff `1a`)
// ============================================================
// "Three questions, in order: who to bill, what went out, who still owes."
// The client's own framing for the whole redesign: the director does not do
// the monthly close-out and does not need room profitability — she needs to
// see who to bill, see what went out, and see who still owes. Everything
// else (the close, bank matching, room-level P&L) moved to the Bookkeeper
// shelf; nothing about them appears here.
//
// ⚠️ NOTHING ON THIS SCREEN IS COMPUTED HERE. `live.billException` and
// `live.whoOwesRows` are populated once in apLoadLive() by calling the exact
// same functions the Bill the Month and Who Owes screens themselves call
// (computeBillMonthExceptions / _buildArRows). This function only reads what
// is already sitting on `live` — the dashboard render contract in
// admin-portal.js is synchronous, so there is no second async fetch here to
// quietly drift from what those two full screens show for the same month.

function apDashFinanceHome(live) {
    const be = live.billException;   // { rows, exceptions, clean, cleanTotal, exceptionTotal }
    const wo = live.whoOwesRows || [];

    const toBill    = be ? be.exceptionTotal + be.cleanTotal : live.billed;
    const inv       = apInvoiceState(live);
    const collected = wo.reduce((s, r) => s + r.collected, 0);
    const stillOwed = wo.reduce((s, r) => s + r.outstanding, 0);
    const unpaidFamilies = wo.filter(r => r.outstanding > 0);

    const methodCounts = { autopay: 0, check: 0 };
    wo.forEach(r => (r.payments || []).forEach(p => {
        if (p.source === 'manual' || p.payment_method === 'check') methodCounts.check++;
        else methodCounts.autopay++;
    }));

    const kpis = [
        { label: `To bill · ${_afhMonthLabel(live.monthKey)}`, tone: 'gold', value: apMoney(toBill),
          sub: be ? `${be.rows.length} families` : '—',
          link: 'billMonth', linkIcon: '🧾', linkLabel: 'Bill the month' },
        { label: 'Invoices out', tone: 'navy', value: apMoney(inv.total),
          sub: `${inv.sent} sent${inv.unsent ? `, ${inv.unsent} held` : ''}` },
        { label: 'Collected', tone: 'ok', value: apMoney(collected),
          sub: methodCounts.autopay || methodCounts.check
              ? `${methodCounts.autopay} autopay, ${methodCounts.check} check` : 'this month' },
        { label: 'Still owed', tone: 'warn', value: apMoney(stillOwed),
          sub: `${unpaidFamilies.length} famil${unpaidFamilies.length === 1 ? 'y' : 'ies'}`,
          link: 'whoOwes', linkIcon: '📋', linkLabel: 'Open Who Owes' },
    ];

    return {
        stamp: `${_afhMonthLabel(live.monthKey)} drafts are ready · invoices are out · ` +
               `${unpaidFamilies.length} famil${unpaidFamilies.length === 1 ? 'y' : 'ies'} still owe${unpaidFamilies.length === 1 ? 's' : ''}`,
        kpis,
        left: [
            _afhWhoToBill(be),
            _afhInvoices(wo, inv),
        ],
        right: [
            _afhWhoStillOwes(unpaidFamilies),
            _afhComingUp(live),
        ],
        attention: [],
    };
}

function _afhMonthLabel(monthKey) {
    const [y, m] = (monthKey || '').split('-').map(Number);
    return m ? `${MONTH_NAMES[m - 1]} ${y}` : monthKey;
}

// ── Who to bill ─────────────────────────────────────────────
function _afhWhoToBill(be) {
    if (!be) {
        return apPanel({ title: 'Who to bill', body: '<p class="empty-hint">Could not load this month’s drafts.</p>', tools: ['billMonth'] });
    }
    const clean = be.clean.filter(r => !r.withdrawn);
    const exceptions = be.exceptions.filter(r => !r.withdrawn);

    const body = `
        <div class="afh-clean-row">
            <span>Same rooms, same days, same discounts — $${be.cleanTotal.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
            <button class="btn-primary btn-sm" data-ap-go="billMonth">Release all ${clean.length}</button>
        </div>
        ${exceptions.length ? `
        <div class="afh-exc-band">${exceptions.length} need${exceptions.length === 1 ? 's' : ''} a look before they send</div>
        <div class="afh-exc-list">
            ${exceptions.slice(0, 5).map(r => `
                <div class="afh-exc-row">
                    <span class="afh-exc-name">${escHtml(r.name)}</span>
                    <span class="afh-exc-cause">${escHtml(r.causes[0]?.text || '')}</span>
                    <span class="afh-exc-amt">$${r.total.toFixed(2)}</span>
                    <button class="afh-review" data-ap-go="billMonth">Review →</button>
                </div>`).join('')}
        </div>` : '<p class="afh-none">Nothing needs a look.</p>'}`;

    return apPanel({ title: 'Who to bill', sub: `${be.rows.length} families this month`, body, tools: ['billMonth', 'discount'] });
}

// ── Invoices ────────────────────────────────────────────────
function _afhInvoices(wo, inv) {
    const paid    = wo.filter(r => r.status === 'paid').length;
    const partial = wo.filter(r => r.status === 'partial').length;
    const unpaid  = wo.filter(r => r.status === 'overdue' || r.status === 'no_invoice' && r.billed > 0).length;
    const total   = Math.max(1, paid + partial + unpaid);

    const recent = wo
        .flatMap(r => (r.payments || []).map(p => ({ ...p, familyName: r.familyName })))
        .sort((a, b) => new Date(b.payment_date || 0) - new Date(a.payment_date || 0))
        .slice(0, 3);

    const body = `
        <div class="afh-stack-bar">
            <div class="afh-seg afh-seg-paid" style="width:${(paid / total) * 100}%"></div>
            <div class="afh-seg afh-seg-partial" style="width:${(partial / total) * 100}%"></div>
            <div class="afh-seg afh-seg-unpaid" style="width:${(unpaid / total) * 100}%"></div>
        </div>
        <div class="afh-stack-legend">
            <span class="is-paid">${paid} paid</span>
            <span class="is-partial">${partial} partial</span>
            <span class="is-unpaid">${unpaid} unpaid</span>
        </div>
        ${recent.length ? `<div class="afh-recent">
            ${recent.map(p => `<div class="afh-recent-row">
                <span>${escHtml(p.familyName)}</span>
                <span class="afh-recent-note">${escHtml(_afhProvenance(p))}</span>
            </div>`).join('')}
        </div>` : ''}
        <button class="ap-pill" data-ap-go="invoices">Show all ${wo.length || inv.drafted}</button>`;

    return apPanel({ title: 'Invoices', sub: 'Status and where each payment came from', body, tools: ['invoices'] });
}

function _afhProvenance(p) {
    const when = p.payment_date ? friendlyShort(p.payment_date) : '';
    if (p.source === 'manual' || p.payment_method === 'check') {
        return `Check${p.note ? ' #' + p.note : ''} · entered by ${p.created_by || 'the office'} ${when}`;
    }
    return `Autopay ${when} · bank feed`;
}

// ── Who still owes ──────────────────────────────────────────
function _afhWhoStillOwes(unpaid) {
    const sorted = [...unpaid].sort((a, b) => b.outstanding - a.outstanding);
    const total  = sorted.reduce((s, r) => s + r.outstanding, 0);

    const blocks = sorted.slice(0, 4).map((r, i) => {
        const days = r.sentAt ? Math.max(0, Math.floor((Date.now() - new Date(r.sentAt).getTime()) / 86400000)) : null;
        const ageCls = days == null ? '' : days >= 30 ? 'is-severe' : days >= 15 ? 'is-watch' : '';
        const why = r.collected > 0 ? `Partial payment — $${r.outstanding.toFixed(2)} remaining` : 'No payment received';
        const worst = i === 0;
        return `<div class="afh-owe-block">
            <div class="afh-owe-top">
                <span class="afh-owe-name">${escHtml(r.familyName)}</span>
                <span class="afh-owe-amt">$${r.outstanding.toFixed(2)}</span>
            </div>
            <div class="afh-owe-days ${ageCls}">${days == null ? 'Not sent yet' : `${days} day${days === 1 ? '' : 's'} late`}</div>
            <div class="afh-owe-why">${escHtml(why)}</div>
            ${worst ? `<div class="afh-owe-decide">
                <button class="btn-xs" data-ap-go="whoOwes">Payment plan</button>
                <button class="btn-xs" data-ap-go="whoOwes">Write off</button>
            </div>` : ''}
        </div>`;
    }).join('');

    return `<section class="ap-panel afh-owes-card">
        <div class="afh-owes-head">
            <span>${sorted.length} famil${sorted.length === 1 ? 'y' : 'ies'} owe</span>
            <span class="afh-owes-total">$${total.toLocaleString(undefined, { minimumFractionDigits: 2 })}</span>
        </div>
        ${blocks || '<p class="afh-none">Nobody owes anything right now.</p>'}
        <div class="afh-owes-foot">
            <button class="ap-pill" data-ap-go="whoOwes">Open Who Owes →</button>
            ${sorted.length ? `<button class="btn-primary btn-sm" data-ap-go="whoOwes">Nudge all ${sorted.length}</button>` : ''}
        </div>
    </section>`;
}

// ── Coming up ───────────────────────────────────────────────
function _afhComingUp(live) {
    const rows = [];
    const now = new Date();
    const nextMonthFirst = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    rows.push({ label: `${MONTH_NAMES[nextMonthFirst.getMonth()]} invoices auto-run`,
                value: friendlyShort(nextMonthFirst.toISOString().slice(0, 10)) });

    if (live.nextClosure) {
        rows.push({ label: 'Next closure', value: friendlyShort(live.nextClosure) });
    }

    const infants = (typeof apWaitlistByRoom === 'function') ? apWaitlistByRoom(live) : {};
    const infantWaiting = (infants.bear || 0) + (infants.bee || 0);
    if (infantWaiting) {
        rows.push({ label: 'Waitlist pressure', value: `${infantWaiting} waiting on an infant seat` });
    }

    return apPanel({
        title: 'Coming up',
        body: rows.length ? apRowsHtml(rows) : '<p class="afh-none">Nothing scheduled.</p>',
        tools: ['famBilling', 'scenario'],
    });
}
