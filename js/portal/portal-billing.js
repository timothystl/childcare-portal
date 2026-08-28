// ============================================================
// portal-billing — the parent's Billing tab
// ============================================================
// Real invoices, no online payment yet. Reuses fetchMySchedule() (the same
// call the Schedule tab makes) rather than a second RPC — my_schedule()
// already returns this family's own billing_invoices rows via the
// SECURITY DEFINER / parent_family_ids() path (see
// supabase/migrations/parent_billing_tab_and_grant_fix.sql), and Billing
// only needs the `invoices` array out of that same payload.
//
// ⚠️ A DRAFT INVOICE IS NOT A BILL. my_schedule() includes every
// non-void invoice, draft or otherwise, but a draft is the office still
// working the month out — nothing has been billed yet. Only a row with
// sent_at is shown here, same rule the Schedule tab's status pill already
// follows (portal-schedule.js, psStatusPill).
//
// ⚠️ THERE IS NO PAYMENT PROCESSOR WIRED INTO THIS APP, ANYWHERE. The old
// Billing tab (replaced by Documents, then folded into Account, see
// portal-nav.js) was a placeholder for the same reason. "Pay" here is
// still a placeholder — it tells a parent how much is owed and that online
// payment is coming, rather than pretending a card can be charged. When a
// processor is chosen, this is the one place a Pay button needs to change.

let pbData = null;

function pbEl(id) { return document.getElementById(id); }
function pbEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}
function pbMoney(n) { return '$' + (Number(n) || 0).toFixed(2); }

function pbMonthLabel(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    const names = (typeof MONTH_NAMES !== 'undefined' && MONTH_NAMES) ||
        ['January','February','March','April','May','June','July','August',
         'September','October','November','December'];
    return `${names[m - 1]} ${y}`;
}

function pbIssuedInvoices() {
    return (pbData?.invoices || []).filter(i => i.sent_at).sort((a, b) => b.month.localeCompare(a.month));
}

function pbRender() {
    const body = pbEl('pbBody');
    if (!body) return;
    if (!pbData) {
        body.innerHTML = '<p class="pa-empty">Could not load your billing. Pull down to retry.</p>';
        return;
    }

    const invoices = pbIssuedInvoices();
    const totalDue = invoices.reduce((sum, i) =>
        sum + Math.max(0, (Number(i.final_amount) || 0) - (Number(i.paid_amount) || 0)), 0);

    // The balance card renders even with no invoices at all. "$0.00, nothing
    // owed" is a real answer to the question this tab exists for; the old empty
    // state answered a different one ("no bills issued yet") and made a parent
    // work out for themselves whether that meant they were square.
    const balanceCard = `<section class="pb-card pb-balance">
        <div class="pb-label">Balance due</div>
        <p class="pb-total">${pbMoney(totalDue)}</p>
        <button type="button" class="pb-pay-btn" disabled
            title="Online payment is coming soon">Pay online (coming soon)</button>
        <p class="pb-fine">${totalDue > 0
            ? `Online payment is coming soon. For now, bills are paid the same way
               they are today — contact the office with any questions about a balance.`
            : `Nothing owed right now. Your next statement will appear here as soon
               as the office sends it.`}</p>
    </section>`;

    body.innerHTML = `<div class="pb-cards">${balanceCard}${invoices.map(pbInvoiceCard).join('')}</div>`;
}

// Which children were booked in the invoice's month, and how many days each.
// ⚠️ Day counts only — deliberately no per-child dollar figure. The invoice
// carries ONE total, computed server-side; splitting it per child in the
// browser would be a second billing calculation that can drift from the bill
// itself, which is the same reason a per-day amount was kept off the invoice
// detail screen. Days booked are a fact this payload already holds.
function pbChildLines(monthKey) {
    const byChild = new Map();
    (pbData?.registrations || []).forEach(r => {
        const days = (r.dates || []).filter(d => !d.waitlisted && String(d.care_date).startsWith(monthKey));
        if (!days.length) return;
        const prev = byChild.get(r.child_name) || { days: 0, roomId: r.room_id };
        byChild.set(r.child_name, { days: prev.days + days.length, roomId: prev.roomId || r.room_id });
    });
    if (!byChild.size) return '';

    return [...byChild.entries()].map(([name, v]) => {
        const room = (typeof ROOMS !== 'undefined' && ROOMS.find(x => x.id === v.roomId)) || null;
        const label = room ? room.label.replace(/^[^A-Za-z]+/, '').trim() : '';
        return `<div class="pb-row">
            <span class="pb-row-label">${pbEsc(name)}${label ? ' — ' + pbEsc(label) : ''}</span>
            <span class="pb-row-value">${v.days} ${v.days === 1 ? 'day' : 'days'}</span>
        </div>`;
    }).join('');
}

function pbInvoiceCard(inv) {
    const due  = Math.max(0, (Number(inv.final_amount) || 0) - (Number(inv.paid_amount) || 0));
    const paid = inv.status === 'paid';
    const pill = paid
        ? '<span class="ps-status ps-paid">PAID</span>'
        : `<span class="ps-status ps-due">${inv.status === 'partial' ? 'PARTIAL' : 'DUE'}</span>`;

    return `<section class="pb-card">
        <div class="pb-label">${pbEsc(pbMonthLabel(inv.month))}</div>
        ${pbChildLines(inv.month)}
        <div class="pb-row pb-row-total">
            <span class="pb-row-label">Total</span>
            <span class="pb-row-value">${pbMoney(inv.final_amount)}</span>
        </div>
        ${inv.paid_amount > 0 && !paid ? `<div class="pb-row">
            <span class="pb-row-label">Paid so far</span>
            <span class="pb-row-value">${pbMoney(inv.paid_amount)}</span>
        </div>
        <div class="pb-row"><span class="pb-row-label">Balance due</span>
            <span class="pb-row-value">${pbMoney(due)}</span></div>` : ''}
        <div class="pb-status-row">${pill}</div>
    </section>`;
}

async function pbLoad() {
    const body = pbEl('pbBody');
    if (body) body.innerHTML = '<p class="pa-empty">Loading…</p>';
    try {
        pbData = await psSchedule();   // shared with Schedule and Today — one fetch, not three
    } catch (e) {
        console.warn('billing:', e);
        pbData = null;
    }
    pbRender();
}
