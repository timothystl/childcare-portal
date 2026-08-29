// ============================================================
// portal-billing — the parent's Billing tab
// ============================================================
// Real invoices, real online payment. Reuses psSchedule() (portal-schedule.js)
// rather than a second RPC — my_schedule() already returns this family's own
// billing_invoices rows (plus each one's last_payment_date) via the
// SECURITY DEFINER / parent_family_ids() path (see
// supabase/migrations/parent_billing_tab_and_grant_fix.sql), and that one
// fetch is shared with Today and Schedule (see psSchedule's own comment) —
// Billing only needs the `invoices` (and, for the days-of-care screen below,
// `registrations`) arrays out of that same payload.
//
// ⚠️ A DRAFT INVOICE IS NOT A BILL. my_schedule() includes every
// non-void invoice, draft or otherwise, but a draft is the office still
// working the month out — nothing has been billed yet. Only a row with
// sent_at is shown here, same rule the Schedule tab's status pill already
// follows (portal-schedule.js, psStatusPill).
//
// ── Screens (2026-08-28 redesign) ──────────────────────────────
// Home (total due + pay button + "view all invoices") → All Invoices (one
// card per issued invoice) → Invoice Detail (billed/paid/balance +
// day-of-care calendar, no per-day dollar figure — see
// pbChildDayCardsForMonth's own comment) → Payment Received (Stax only; see
// pbLastReceipt below). See pbRender()'s dispatcher and the pbGo*()
// navigation functions. No history/hash routing — the app has none
// anywhere else, and "back" only ever needs to go one level up.
//
// ⚠️ PROCESSOR: two live processors, both real money — Authorize.net
// Accept Hosted (deployed and taking real payments) and Stax.js/Bolt
// (production-gated; see pbStaxTestEnabled below for the sandbox
// click-through path). "Pay" opens #pbPayModal and loads Authorize.net's
// own hosted payment page into an iframe INSIDE it (create-payment-session
// gets the token; this file never touches card data, keeping the app at
// PCI SAQ A) rather than redirecting the whole page — paying stays inside
// the portal.
//
// Authorize.net relays the result back to us via iframe-communicator.html
// (a small page hosted on our own domain, required by their
// hostedPaymentIFrameCommunicatorUrl setting — see create-payment-session)
// calling window.CommunicationHandler.onReceiveCommunication, defined below.
// That relay is COSMETIC ONLY, same as the old full-page return trip was:
// the authorizenet-webhook edge function is the one thing that actually
// marks an invoice paid, so a parent who closes the modal mid-payment, or
// whose browser never delivers the message, leaves nothing in an
// inconsistent state — the invoice list simply still shows what's owed.
// portal-auth.js's location.search handling (?paid=/?cancelled=) stays in
// place as a fallback for the rare case Authorize.net falls back to
// navigating the return URL instead of using the communicator. Because that
// confirmation is async-only, a successful Authorize.net payment still gets
// the older "we're confirming your payment now" banner on Home
// (pbReturnBanner) rather than the richer Payment Received screen below.
//
// STAX PAYMENT FLOW (live 2026-08-27): the normal Pay online button uses
// Stax.js/Bolt fields. The full outstanding balance is the default; parents
// can deliberately choose a smaller installment, which the server validates
// against a fresh balance before charging. Unlike Authorize.net, a
// successful Stax charge returns real confirmation data synchronously
// (transactionId/amount), so it navigates straight to the in-app Payment
// Received screen (pbRenderReceipt) instead of the async-confirmation
// banner — see pbLastReceipt and pbCloseStaxModal.

let pbData = null;
let pbLoadFailed = false;   // a thrown error, as distinct from an empty payload
let pbReturnState = null;   // 'paid' | 'cancelled' | null — set by portal-auth.js
let pbPaying = null;        // invoice id currently starting a payment, or null
let pbStaxPaying = null;    // invoice id currently in the Stax comparison modal, or null
let pbStaxInstance = null;  // the live StaxJs() instance for the open modal, or null

// ── Screen navigation (2026-08-28 redesign) ──────────────────
// Billing is its own small stack — Home → All Invoices → Invoice Detail,
// plus a Payment Received screen — entirely inside #pbBody. No history/hash
// routing: the app has none anywhere else, and the back button here only
// ever needs to go one level up, which a plain variable handles.
let pbView = 'home';          // 'home' | 'invoices' | 'invoice' | 'receipt'
let pbActiveInvoiceId = null; // set when navigating into an invoice's detail
let pbShowBreakdown = false;  // Home screen's "Show breakdown" toggle
// Set right before a successful Stax charge closes its modal, read once by
// pbRenderReceipt(), then cleared. Authorize.net has no equivalent — see
// pbClosePayModal's own comment for why that flow keeps the older banner
// instead of this richer screen.
let pbLastReceipt = null;

/** Called from portal-auth.js when Authorize.net's hosted page redirects back. */
function pbSetReturnState(kind) { pbReturnState = kind; }

// Reintroduced 2026-08-28 for sandbox click-through testing ahead of a real
// Stax production account. Hidden from every real family by default: only
// ?staxtest=1 on the URL this tab loaded with turns it on, then it sticks in
// sessionStorage for the rest of the tab's life so navigating within the app
// doesn't drop it. This flag ALONE does nothing — create-stax-charge and
// charge-stax-payment both also require the server secret
// STAX_SANDBOX_TEST_ENABLED=true before a non-production charge is allowed
// through, so a tester adding this to a URL and sending it to someone else
// can't accidentally charge them against the sandbox merchant.
function pbStaxTestEnabled() {
    try {
        if (new URLSearchParams(location.search).get('staxtest') === '1') {
            sessionStorage.setItem('pbStaxTest', '1');
        }
        return sessionStorage.getItem('pbStaxTest') === '1';
    } catch (_) {
        return false;
    }
}

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

function pbBalance(inv) {
    return Math.max(0, (Number(inv.final_amount) || 0) - (Number(inv.paid_amount) || 0));
}

function pbStatusPill(inv) {
    if (inv.status === 'paid') return '<span class="ps-status ps-paid">PAID</span>';
    return `<span class="ps-status ps-due">${inv.status === 'partial' ? 'PARTIAL' : 'DUE'}</span>`;
}

/** A bare "YYYY-MM-DD" (e.g. last_payment_date) must be read as a local
 *  date, not UTC — new Date('YYYY-MM-DD') is UTC by spec and lands a day
 *  early in America/Chicago. A real timestamptz (sent_at) parses safely as
 *  a plain ISO string either way, so this only special-cases the bare form. */
function pbDate(value) {
    if (!value) return '—';
    const d = /^\d{4}-\d{2}-\d{2}$/.test(value) ? new Date(`${value}T00:00:00`) : new Date(value);
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function pbGoHome() { pbView = 'home'; pbShowBreakdown = false; pbRender(); }
function pbGoInvoices() { pbView = 'invoices'; pbRender(); }
function pbGoInvoiceDetail(id) { pbActiveInvoiceId = id; pbView = 'invoice'; pbRender(); }

function pbRender() {
    const body = pbEl('pbBody');
    if (!body) return;
    if (!pbData) {
        body.innerHTML = pbLoadFailed
            ? '<p class="pa-empty">Could not load your billing. Pull down to retry.</p>'
            : '<p class="pa-empty">This sign-in is not linked to a family account, so there is nothing billed to it.</p>';
        return;
    }
    if (pbView === 'invoices') return pbRenderInvoiceList();
    if (pbView === 'invoice') return pbRenderInvoiceDetail();
    if (pbView === 'receipt') return pbRenderReceipt();
    return pbRenderHome();
}

function pbReturnBanner(kind) {
    if (kind === 'cancelled') {
        return `<section class="pd-card pb-return-banner pb-return-cancelled">
            <div class="pd-card-body"><p>Payment cancelled — nothing was charged.</p></div>
        </section>`;
    }
    return `<section class="pd-card pb-return-banner pb-return-paid">
        <div class="pd-card-body">
            <p>Thanks — we're confirming your payment now. This can take a few seconds;
               the balance below will update on its own once it's confirmed.</p>
        </div>
    </section>`;
}

// The summary card renders even with no invoices at all. "$0.00, nothing
// owed" is a real answer to the question this tab exists for — a parent
// should not have to work out for themselves whether an empty screen means
// they're square.
function pbRenderHome() {
    const body = pbEl('pbBody');
    const invoices = pbIssuedInvoices();
    const unpaid = invoices.filter(i => pbBalance(i) > 0.004);
    const totalDue = unpaid.reduce((s, i) => s + pbBalance(i), 0);
    // unpaid inherits pbIssuedInvoices()'s desc-by-month order, so [0] is
    // the most recent unpaid invoice — anchoring a payment there rolls up
    // every older unpaid month too (see createStaxChargeSession's own
    // due-set logic), which is what "Pay $X online" here is meant to clear.
    const mostRecentUnpaid = unpaid[0] || null;
    const priorUnpaid = unpaid.slice(1);
    const priorBalance = priorUnpaid.reduce((s, i) => s + pbBalance(i), 0);

    const banner = pbReturnState ? pbReturnBanner(pbReturnState) : '';
    const breakdownHtml = pbShowBreakdown ? `
        <div class="pb-breakdown">
            ${unpaid.map(i => `<div class="pb-breakdown-row">
                <span>${pbEsc(pbMonthLabel(i.month))}</span><span>${pbMoney(pbBalance(i))}</span>
            </div>`).join('')}
        </div>` : '';

    body.innerHTML = `
        ${banner}
        <section class="pd-card pb-summary">
            <div class="pd-card-body">
                <p class="pb-total">${pbMoney(totalDue)}</p>
                ${unpaid.length ? `<button type="button" class="pb-link-btn" id="pbBreakdownToggle">${pbShowBreakdown ? 'Hide breakdown' : 'Show breakdown'}</button>` : ''}
                ${breakdownHtml}
                ${mostRecentUnpaid ? `<button type="button" class="pb-pay-btn pb-stax-btn" data-invoice-id="${mostRecentUnpaid.id}"
                    ${pbStaxPaying === mostRecentUnpaid.id ? 'disabled' : ''}>${pbStaxPaying === mostRecentUnpaid.id ? 'Starting payment…' : `Pay ${pbMoney(totalDue)} online`}</button>
                    <p class="pb-pay-error" id="pbStaxError-${mostRecentUnpaid.id}" hidden></p>` : ''}
                <p class="pb-fine">${totalDue > 0
                    ? `Pay online above, or contact the office if you have questions about a balance.`
                    : `Nothing owed right now. Your next statement will appear here as soon as the office sends it.`}</p>
            </div>
        </section>
        ${priorBalance > 0.004 ? `
        <section class="pb-prior-banner">
            <p class="pb-prior-banner-title">Balance carried from a prior month</p>
            <p class="pb-prior-banner-body">We recommend paying the prior balance
               (${pbMoney(priorBalance)}) in full before it grows further. Partial
               payments are still accepted on any invoice.</p>
        </section>` : ''}
        ${invoices.length ? `<button type="button" class="pd-row pb-view-all-btn" id="pbViewAllBtn">
            <span class="pd-row-main"><span class="pd-row-title">🧾 View all invoices</span></span>
            <span aria-hidden="true">›</span>
        </button>` : ''}
    `;

    pbEl('pbBreakdownToggle')?.addEventListener('click', () => { pbShowBreakdown = !pbShowBreakdown; pbRenderHome(); });
    pbEl('pbViewAllBtn')?.addEventListener('click', pbGoInvoices);
    body.querySelectorAll('.pb-stax-btn[data-invoice-id]').forEach(btn => {
        btn.addEventListener('click', () => pbStartStaxPayment(Number(btn.dataset.invoiceId)));
    });

    // A parent freshly back from a payment attempt: reload once more shortly
    // after, since the webhook that actually records the payment can lag
    // the redirect back here by a few seconds. This is a courtesy re-check,
    // not a promise — the summary above already reflects whatever is true
    // right now.
    if (pbReturnState === 'paid') {
        setTimeout(() => { pbLoad(); }, 3000);
    }
    pbReturnState = null;
}

function pbSubheadHtml(title, eyebrow) {
    return `<div class="pb-subhead">
        <button type="button" class="pb-back-btn" id="pbBackBtn" aria-label="Back">&larr;</button>
        <div class="pb-subhead-text">
            ${eyebrow ? `<p class="pb-subhead-eyebrow">${pbEsc(eyebrow)}</p>` : ''}
            <h2 class="pb-subhead-title">${pbEsc(title)}</h2>
        </div>
    </div>`;
}

function pbRenderInvoiceList() {
    const body = pbEl('pbBody');
    const invoices = pbIssuedInvoices();
    body.innerHTML = `
        ${pbSubheadHtml('All invoices')}
        ${invoices.length ? invoices.map(pbInvoiceListCard).join('') : '<p class="pa-empty">No bills issued yet.</p>'}
    `;
    pbEl('pbBackBtn')?.addEventListener('click', pbGoHome);
    body.querySelectorAll('.pb-stax-btn[data-invoice-id]').forEach(btn => {
        btn.addEventListener('click', () => pbStartStaxPayment(Number(btn.dataset.invoiceId)));
    });
    body.querySelectorAll('.pb-view-invoice-btn[data-invoice-id]').forEach(btn => {
        btn.addEventListener('click', () => pbGoInvoiceDetail(Number(btn.dataset.invoiceId)));
    });
}

function pbInvoiceListCard(inv) {
    const due = pbBalance(inv);
    const paid = inv.status === 'paid';
    // ⚠️ "Due by" reads the same as "Bill date" (both sent_at) — there is no
    // separate due-date column or setting anywhere in this app's schema.
    // Office guidance on when payment is expected lives in the admin-edited
    // invoice_email_note text, not a structured per-invoice field, so
    // showing a fabricated due date here would be worse than showing the
    // one real date twice.
    return `<section class="pd-card">
        <div class="pd-card-head"><span aria-hidden="true">🧾</span>${pbEsc(pbMonthLabel(inv.month))}<span class="pb-card-head-spacer"></span>${pbStatusPill(inv)}</div>
        <div class="pd-card-body">
            <div class="pb-row"><span class="pb-row-label">Invoice #</span><span class="pb-row-value">INV-${inv.id}</span></div>
            <div class="pb-row"><span class="pb-row-label">Bill date</span><span class="pb-row-value">${pbDate(inv.sent_at)}</span></div>
            <div class="pb-row"><span class="pb-row-label">Due by</span><span class="pb-row-value">${pbDate(inv.sent_at)}</span></div>
            <div class="pb-row"><span class="pb-row-label">Billed</span><span class="pb-row-value">${pbMoney(inv.final_amount)}</span></div>
            ${inv.paid_amount > 0 ? `<div class="pb-row"><span class="pb-row-label">Paid</span><span class="pb-row-value">${pbMoney(inv.paid_amount)}</span></div>` : ''}
            <div class="pb-row pb-row-strong"><span class="pb-row-label">${paid ? 'Balance' : 'Balance due'}</span><span class="pb-row-value">${pbMoney(due)}</span></div>
            <button type="button" class="pb-secondary-btn pb-view-invoice-btn" data-invoice-id="${inv.id}">View invoice — days of care</button>
            ${!paid ? `<button type="button" class="pb-pay-btn pb-stax-btn" data-invoice-id="${inv.id}"
                ${pbStaxPaying === inv.id ? 'disabled' : ''}>${pbStaxPaying === inv.id ? 'Starting payment…' : `Pay ${pbMoney(due)} online`}</button>
                <p class="pb-pay-error" id="pbStaxError-${inv.id}" hidden></p>` : ''}
        </div>
    </section>`;
}

function pbRenderInvoiceDetail() {
    const body = pbEl('pbBody');
    const inv = (pbData?.invoices || []).find(i => i.id === pbActiveInvoiceId);
    if (!inv) { pbGoInvoices(); return; }
    const due = pbBalance(inv);
    const paid = inv.status === 'paid';

    body.innerHTML = `
        ${pbSubheadHtml(`INV-${inv.id}`, 'Invoice')}
        <section class="pd-card">
            <div class="pd-card-head">INV-${inv.id}<span class="pb-card-head-spacer"></span>${pbStatusPill(inv)}</div>
            <div class="pd-card-body">
                <div class="pb-detail-meta">
                    <div><span class="pb-detail-meta-label">Bill date</span><span class="pb-detail-meta-value">${pbDate(inv.sent_at)}</span></div>
                    <div><span class="pb-detail-meta-label">Due by</span><span class="pb-detail-meta-value">${pbDate(inv.sent_at)}</span></div>
                    ${inv.last_payment_date ? `<div><span class="pb-detail-meta-label">Payment date</span><span class="pb-detail-meta-value">${pbDate(inv.last_payment_date)}</span></div>` : ''}
                </div>
            </div>
        </section>
        <p class="pb-days-heading">Days of care requested</p>
        ${pbChildDayCardsForMonth(inv.month)}
        <section class="pd-card pb-summary">
            <div class="pd-card-body">
                <div class="pb-row"><span class="pb-row-label">Billed</span><span class="pb-row-value">${pbMoney(inv.final_amount)}</span></div>
                ${inv.paid_amount > 0 ? `<div class="pb-row"><span class="pb-row-label">Paid</span><span class="pb-row-value">${pbMoney(inv.paid_amount)}</span></div>` : ''}
                <div class="pb-row pb-row-strong"><span class="pb-row-label">${paid ? 'Balance' : 'Balance due'}</span><span class="pb-row-value">${pbMoney(due)}</span></div>
                ${!paid ? `<button type="button" class="pb-pay-btn pb-stax-btn" data-invoice-id="${inv.id}"
                    ${pbStaxPaying === inv.id ? 'disabled' : ''}>${pbStaxPaying === inv.id ? 'Starting payment…' : `Pay ${pbMoney(due)} online`}</button>
                    <p class="pb-pay-error" id="pbStaxError-${inv.id}" hidden></p>` : ''}
            </div>
        </section>
    `;
    pbEl('pbBackBtn')?.addEventListener('click', pbGoInvoices);
    body.querySelectorAll('.pb-stax-btn[data-invoice-id]').forEach(btn => {
        btn.addEventListener('click', () => pbStartStaxPayment(Number(btn.dataset.invoiceId)));
    });
}

/** ⚠️ Deliberately no per-day or per-child dollar figure — my_schedule()
 *  gives real, always-accurate care_date/day_type per child (the same data
 *  the Schedule tab's own calendar reads), which is what these cells show.
 *  A per-child subtotal would mean a second, client-side billing calculation
 *  that could drift from the real invoice; the invoice's own final_amount
 *  above stays the one dollar figure this screen shows, because it's the
 *  only one guaranteed to match what was actually billed. Same reasoning
 *  the six-tab redesign's own pbChildLines() (day counts, no dollars) used
 *  for its month cards — this screen just shows the days themselves. */
function pbChildDayCardsForMonth(month) {
    const regs = (pbData?.registrations || []).filter(r => r.month_key === month);
    if (!regs.length) {
        return '<p class="pa-empty">No day-of-care detail found for this invoice\'s month.</p>';
    }
    return regs.map(reg => {
        const dates = (reg.dates || []).filter(d => !d.waitlisted)
            .sort((a, b) => a.care_date.localeCompare(b.care_date));
        const fullDays = dates.filter(d => d.day_type !== 'half').length;
        const halfDays = dates.filter(d => d.day_type === 'half').length;
        const room = (typeof ROOMS !== 'undefined' ? ROOMS : []).find(r => r.id === reg.room_id);
        const summary = [
            fullDays ? `${fullDays} full day${fullDays === 1 ? '' : 's'}` : '',
            halfDays ? `${halfDays} half day${halfDays === 1 ? '' : 's'}` : '',
        ].filter(Boolean).join(', ');
        return `<section class="pd-card">
            <div class="pd-card-head">${pbEsc(reg.child_name)}<span class="pb-card-head-spacer"></span><span class="pb-room-label">${pbEsc(room?.label || '')}</span></div>
            <div class="pd-card-body">
                <div class="ps-chips">${dates.map(pbDayChip).join('')}</div>
                ${summary ? `<p class="pb-days-summary">${pbEsc(summary)}</p>` : ''}
            </div>
        </section>`;
    }).join('');
}

function pbDayChip(d) {
    const dt = new Date(`${d.care_date}T00:00:00`);
    const dow = dt.toLocaleDateString('en-US', { weekday: 'short' }).toUpperCase();
    const dateLabel = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const half = d.day_type === 'half';
    return `<div class="ps-chip${half ? ' ps-chip-half' : ''}">
        <span class="ps-chip-dow">${dow}</span>
        <span class="ps-chip-date">${dateLabel}</span>
        <span class="ps-chip-kind">${half ? 'Half' : 'Full'}</span>
    </div>`;
}

/** Stax only — see pbLastReceipt's own comment for why Authorize.net has no
 *  equivalent screen. Cleared after render so a stale receipt never shows
 *  again if the parent somehow lands back on this view. */
function pbRenderReceipt() {
    const body = pbEl('pbBody');
    const r = pbLastReceipt;
    if (!r) { pbGoHome(); return; }

    body.innerHTML = `
        <section class="pd-card pb-receipt">
            <div class="pd-card-body pb-receipt-body">
                <div class="pb-receipt-check" aria-hidden="true">&#10003;</div>
                <h2 class="pb-receipt-title">Payment received</h2>
                <p class="pb-receipt-thanks">Thank you, ${pbEsc(r.familyName)}.</p>
                <p class="pb-receipt-amount">${pbMoney(r.amount)}</p>
                <div class="pb-receipt-box">
                    <div class="pb-row"><span class="pb-row-label">Invoice</span><span class="pb-row-value">${pbEsc(r.invoiceNumber)}</span></div>
                    <div class="pb-row"><span class="pb-row-label">Paid on</span><span class="pb-row-value">${pbEsc(r.paidOn)}</span></div>
                    ${r.paymentMethodLine ? `<div class="pb-row"><span class="pb-row-label">Payment method</span><span class="pb-row-value">${pbEsc(r.paymentMethodLine)}</span></div>` : ''}
                    <div class="pb-row"><span class="pb-row-label">Confirmation #</span><span class="pb-row-value">${pbEsc(r.confirmationNumber)}</span></div>
                </div>
                <p class="pb-receipt-emailed">A copy of this receipt has been emailed to the address on file.</p>
                <button type="button" class="pb-pay-btn" id="pbReceiptDoneBtn">Done</button>
            </div>
        </section>
    `;
    pbLastReceipt = null;
    pbEl('pbReceiptDoneBtn')?.addEventListener('click', pbGoHome);
}

/**
 * Start an Accept Hosted payment: get a one-time token from
 * create-payment-session (server-computed amount, ownership already
 * checked there), then POST it into the #pbPayFrame iframe inside
 * #pbPayModal. Nothing here ever sees a card number — the iframe's
 * document is Authorize.net's own, on their own domain.
 */
async function pbStartPayment(invoiceId) {
    if (pbPaying) return;
    pbPaying = invoiceId;
    pbRender();
    try {
        const { token, formUrl, priorBalance } = await createPaymentSession(invoiceId);
        pbEnsureCommunicationHandler();
        pbOpenPayModal(priorBalance);

        const form = document.createElement('form');
        form.method = 'POST';
        form.action = formUrl;
        form.target = 'pbPayFrame';
        form.style.display = 'none';
        const input = document.createElement('input');
        input.type = 'hidden';
        input.name = 'token';
        input.value = token;
        form.appendChild(input);
        document.body.appendChild(form);
        form.submit();
        form.remove();
        // pbPaying stays set — and the modal stays open — until the
        // communicator reports a result or the parent closes it by hand.
    } catch (e) {
        pbPaying = null;
        pbRender();
        const errEl = pbEl(`pbPayError-${invoiceId}`);
        if (errEl) {
            errEl.textContent = e.message || 'Could not start payment. Please try again.';
            errEl.hidden = false;
        }
    }
}

function pbOpenPayModal(priorBalance) {
    const modal = pbEl('pbPayModal');
    const status = pbEl('pbPayModalStatus');
    const frame = pbEl('pbPayFrame');
    const priorNote = pbEl('pbPayPriorBalanceNote');
    if (status) { status.hidden = false; status.textContent = 'Loading secure payment form…'; }
    if (priorNote) {
        if (priorBalance > 0) {
            priorNote.textContent = `This payment includes ${pbMoney(priorBalance)} carried over from a previous month.`;
            priorNote.hidden = false;
        } else {
            priorNote.hidden = true;
        }
    }
    if (frame) {
        frame.style.height = '';
        frame.addEventListener('load', pbHidePayModalStatusOnce, { once: true });
    }
    if (modal) modal.classList.remove('hidden');
    document.body.classList.add('pb-modal-open');
}

function pbHidePayModalStatusOnce() {
    const status = pbEl('pbPayModalStatus');
    if (status) status.hidden = true;
}

/** success=true only for a completed transactResponse; false for cancel/close. */
function pbClosePayModal(success) {
    const modal = pbEl('pbPayModal');
    const frame = pbEl('pbPayFrame');
    if (modal) modal.classList.add('hidden');
    document.body.classList.remove('pb-modal-open');
    // Drop the hosted form out of the DOM's live document rather than just
    // hiding it — leaving Authorize.net's page loaded in a hidden iframe
    // would keep its card-entry JS running for no reason.
    if (frame) frame.src = 'about:blank';
    pbPaying = null;
    if (success) {
        pbSetReturnState('paid');
        if (typeof psInvalidate === 'function') psInvalidate();
        // The return banner only renders on the Home screen — force it back
        // there so a payment started from Invoices/Invoice Detail doesn't
        // strand the parent on a screen that never shows the banner.
        pbView = 'home';
        pbShowBreakdown = false;
    }
    pbRender();
}

/**
 * Wired once, at module load — the modal lives outside #pbBody so it
 * survives every pbRender() re-paint, and this must too. Authorize.net's
 * iframe-communicator.html (loaded on our own domain, inside the hosted
 * form's own inner iframe) calls this directly via
 * window.parent.parent.CommunicationHandler.onReceiveCommunication — see
 * that file for why the parent.parent hop is required.
 */
function pbEnsureCommunicationHandler() {
    if (window.__pbCommHandlerInstalled) return;
    window.__pbCommHandlerInstalled = true;
    window.CommunicationHandler = window.CommunicationHandler || {};
    window.CommunicationHandler.onReceiveCommunication = function (argument) {
        const params = pbParseCommQueryString(argument && argument.qstr);
        switch (params.action) {
            case 'resizeWindow': {
                const h = parseInt(params.height, 10);
                const frame = pbEl('pbPayFrame');
                if (frame && Number.isFinite(h) && h > 0) frame.style.height = Math.max(h, 300) + 'px';
                break;
            }
            case 'cancel':
                pbClosePayModal(false);
                break;
            case 'transactResponse':
            case 'successfulSave':
                // The webhook — not this message — is what actually marks the
                // invoice paid; see the file header. This just closes the
                // modal and lets pbRender()'s existing return-banner /
                // reload-after-3s logic take it from here.
                pbClosePayModal(true);
                break;
            case 'errorResponse':
                // Authorize.net's own hosted form already shows the decline
                // or validation error inline, inside the iframe — nothing to
                // add here, and the modal stays open so the parent can retry.
                break;
        }
    };
}

/**
 * Authorize.net's own communicator passes a query-string-shaped payload
 * (action=...&response=...&height=...). Mirrors the parsing in their
 * reference app (accept-sample-app/index.php's parseQueryString) — the
 * `response` value is a bare JSON object with no & or = in it, so a plain
 * split-then-decode is safe.
 */
function pbParseCommQueryString(str) {
    const out = {};
    String(str || '').split('&').forEach(pair => {
        if (!pair) return;
        const idx = pair.indexOf('=');
        const key = idx === -1 ? pair : pair.slice(0, idx);
        const val = idx === -1 ? '' : pair.slice(idx + 1);
        try { out[decodeURIComponent(key)] = decodeURIComponent(val); }
        catch (_) { out[key] = val; }
    });
    return out;
}

document.addEventListener('DOMContentLoaded', () => {
    pbEl('pbPayModalClose')?.addEventListener('click', () => pbClosePayModal(false));
    pbEl('pbStaxModalClose')?.addEventListener('click', () => pbCloseStaxModal(false));
    pbEl('pbStaxPayBtn')?.addEventListener('click', pbStaxTokenizeAndCharge);
    pbEl('pbStaxUseSavedCardBtn')?.addEventListener('click', pbStaxChargeSavedCard);
    pbEl('pbStaxUseNewCardBtn')?.addEventListener('click', () => {
        pbEl('pbStaxSavedCard')?.classList.add('hidden');
        pbEl('pbStaxCardEntry')?.classList.remove('hidden');
    });
    pbEl('pbStaxPartialToggle')?.addEventListener('click', pbToggleStaxPartialAmount);
    pbEl('pbStaxPaymentAmount')?.addEventListener('input', pbUpdateStaxDisplayedAmount);
});

// ============================================================
// Stax payment flow — embedded Stax.js (Bolt) fields, our own modal
// ============================================================
// Unlike the Authorize.net flow above (their hosted page, in an iframe we
// don't control the inside of), Stax.js mounts just the card-number and
// CVV fields as small individual iframes into divs WE own — everything
// around them (layout, labels, the Pay button, the amount shown, the
// receipt that follows) is this app's own markup and its own branded
// email, not Stax's. Card number and CVV stay inside Stax-owned iframes.

const PB_STAXJS_URL = 'https://staxjs.staxpayments.com/staxjs-captcha.js';
let pbStaxJsLoadPromise = null;

function pbLoadStaxJs() {
    if (window.StaxJs) return Promise.resolve();
    if (pbStaxJsLoadPromise) return pbStaxJsLoadPromise;
    pbStaxJsLoadPromise = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = PB_STAXJS_URL;
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Could not load the Stax payment library.'));
        document.head.appendChild(script);
    });
    return pbStaxJsLoadPromise;
}

async function pbStartStaxPayment(invoiceId) {
    if (pbStaxPaying) return;
    pbStaxPaying = invoiceId;
    pbRender();
    const errEl = pbEl(`pbStaxError-${invoiceId}`);
    if (errEl) errEl.hidden = true;
    try {
        const session = await createStaxChargeSession(invoiceId, { sandboxTest: pbStaxTestEnabled() });
        await pbLoadStaxJs();
        pbOpenStaxModal(session);
    } catch (e) {
        pbStaxPaying = null;
        pbRender();
        // Keep online payments available during a controlled processor
        // rollout. Stax itself fails closed unless production credentials are
        // explicitly configured; in that state, use the already-live
        // Authorize.net hosted checkout rather than leaving families blocked.
        if (e?.message === 'Online payments are not configured for production yet.'
            || e?.message === 'Stax payments are not currently available.') {
            return pbStartPayment(invoiceId);
        }
        const err = pbEl(`pbStaxError-${invoiceId}`);
        if (err) {
            err.textContent = e.message || 'Could not start payment. Please try again.';
            err.hidden = false;
        }
    }
}

function pbPopulateStaxExpYearOnce() {
    const yearEl = pbEl('pbStaxExpYear');
    if (!yearEl || yearEl.options.length) return;
    const thisYear = new Date().getFullYear();
    const blank = document.createElement('option');
    blank.value = ''; blank.textContent = 'YYYY';
    yearEl.appendChild(blank);
    for (let y = thisYear; y <= thisYear + 15; y++) {
        const opt = document.createElement('option');
        opt.value = String(y); opt.textContent = String(y);
        yearEl.appendChild(opt);
    }
}

/**
 * Mounts fresh card-number/CVV fields for this session. A new StaxJs()
 * instance is created every time the modal opens rather than reused —
 * Stax.js's cleanup/teardown API isn't documented anywhere this session
 * could find, so replacing the mount divs' contents outright (via
 * innerHTML reset before construction) is the safe way to avoid stacking
 * stale iframes across repeated opens.
 */
/** Renders the itemized per-child breakdown + prior-balance line the server computed. */
function pbRenderStaxLineItems(session) {
    const el = pbEl('pbStaxLineItems');
    if (!el) return;
    const items = Array.isArray(session.lineItems) ? session.lineItems : [];
    if (!items.length && !(session.priorBalance > 0)) { el.innerHTML = ''; return; }
    const rows = items.map(li => {
        const dayParts = [];
        if (li.fullDays) dayParts.push(`${li.fullDays} full day${li.fullDays === 1 ? '' : 's'}`);
        if (li.halfDays) dayParts.push(`${li.halfDays} half day${li.halfDays === 1 ? '' : 's'}`);
        return `<div class="pb-stax-line-item">
            <span><span class="pb-stax-line-item-child">${pbEsc(li.childName)}</span>
                ${dayParts.length ? `<br><span class="pb-stax-line-item-detail">${pbEsc(dayParts.join(', '))}</span>` : ''}</span>
            <span class="pb-stax-line-item-amount">${pbMoney(li.amount)}</span>
        </div>`;
    }).join('');
    const priorRow = session.priorBalance > 0 ? `<div class="pb-stax-prior-balance">
        <span>Includes balance from a previous month</span>
        <span>${pbMoney(session.priorBalance)}</span>
    </div>` : '';
    el.innerHTML = rows + priorRow;
}

/** Shows the "use card on file" offer if the family has a saved Stax card, hides card entry until they choose. */
function pbRenderStaxSavedCard(session) {
    const wrap = pbEl('pbStaxSavedCard');
    const entry = pbEl('pbStaxCardEntry');
    const label = pbEl('pbStaxSavedCardLabel');
    if (!wrap || !entry) return;
    if (session.savedCard) {
        if (label) label.textContent = `${pbEsc(session.savedCard.brand || 'Card')} ending in ${pbEsc(session.savedCard.last4 || '????')}`;
        wrap.classList.remove('hidden');
        entry.classList.add('hidden');
    } else {
        wrap.classList.add('hidden');
        entry.classList.remove('hidden');
    }
}

/**
 * Returns the parent's selected amount in whole cents. The full live balance
 * is prefilled and remains the default; this only becomes an installment when
 * the parent deliberately enters a smaller amount. The edge function repeats
 * all validation against a freshly-computed balance before moving money.
 */
function pbSelectedStaxAmount() {
    const session = window.__pbStaxSession;
    const input = pbEl('pbStaxPaymentAmount');
    const amount = Number(input?.value);
    const amountCents = Math.round(amount * 100);
    const balanceCents = Math.round((Number(session?.amount) || 0) * 100);
    if (!Number.isFinite(amount) || amountCents < 1) {
        throw new Error('Enter a payment amount of at least $0.01.');
    }
    if (Math.abs(amount * 100 - amountCents) > 0.000001) {
        throw new Error('Enter no more than two decimal places.');
    }
    if (amountCents > balanceCents) {
        throw new Error(`The payment cannot exceed the ${pbMoney(balanceCents / 100)} balance.`);
    }
    return amountCents / 100;
}

function pbUpdateStaxDisplayedAmount() {
    const amountEl = pbEl('pbStaxAmount');
    const payBtn = pbEl('pbStaxPayBtn');
    const savedBtn = pbEl('pbStaxUseSavedCardBtn');
    try {
        const amount = pbSelectedStaxAmount();
        if (amountEl) amountEl.textContent = pbMoney(amount);
        if (payBtn) payBtn.textContent = `Pay ${pbMoney(amount)}`;
        if (savedBtn) savedBtn.textContent = `Pay ${pbMoney(amount)} with this card`;
    } catch (_) {
        if (amountEl) amountEl.textContent = '—';
        if (payBtn) payBtn.textContent = 'Pay';
        if (savedBtn) savedBtn.textContent = 'Pay with this card';
    }
}

function pbToggleStaxPartialAmount() {
    const toggle = pbEl('pbStaxPartialToggle');
    const fields = pbEl('pbStaxPartialFields');
    const input = pbEl('pbStaxPaymentAmount');
    if (!toggle || !fields) return;
    const opening = fields.hidden;
    fields.hidden = !opening;
    toggle.setAttribute('aria-expanded', String(opening));
    toggle.textContent = opening ? 'Pay the full balance instead' : 'Pay a different amount';
    if (opening) {
        input?.focus();
        input?.select();
    } else {
        const session = window.__pbStaxSession;
        if (input && session) input.value = Number(session.amount).toFixed(2);
        pbUpdateStaxDisplayedAmount();
    }
}

function pbOpenStaxModal(session) {
    pbPopulateStaxExpYearOnce();
    const modal = pbEl('pbStaxModal');
    const numberMount = pbEl('pbStaxCardNumber');
    const cvvMount = pbEl('pbStaxCardCvv');
    const nameEl = pbEl('pbStaxName');
    const amountEl = pbEl('pbStaxAmount');
    const balanceEl = pbEl('pbStaxBalanceDue');
    const amountWrap = pbEl('pbStaxPaymentAmountWrap');
    const amountInput = pbEl('pbStaxPaymentAmount');
    const partialFields = pbEl('pbStaxPartialFields');
    const partialToggle = pbEl('pbStaxPartialToggle');
    const payBtn = pbEl('pbStaxPayBtn');
    const status = pbEl('pbStaxModalStatus');
    const saveCardEl = pbEl('pbStaxSaveCard');
    if (numberMount) numberMount.innerHTML = '';
    if (cvvMount) cvvMount.innerHTML = '';
    if (nameEl) {
        const who = `${session.firstname} ${session.lastname}`.trim();
        nameEl.textContent = session.invoiceId ? `${who} · Invoice INV-${session.invoiceId}` : who;
    }
    if (amountEl) amountEl.textContent = pbMoney(session.amount);
    if (balanceEl) balanceEl.textContent = pbMoney(session.amount);
    // An older deployed charge function ignores unknown request fields and
    // would charge the full balance. Keep installments unavailable unless
    // the server explicitly advertises the matching validation behavior.
    if (amountWrap) amountWrap.hidden = session.supportsPartialPayments !== true;
    if (amountInput) {
        amountInput.value = Number(session.amount).toFixed(2);
        amountInput.max = Number(session.amount).toFixed(2);
    }
    if (partialFields) partialFields.hidden = true;
    if (partialToggle) {
        partialToggle.textContent = 'Pay a different amount';
        partialToggle.setAttribute('aria-expanded', 'false');
    }
    if (payBtn) payBtn.disabled = true;
    if (saveCardEl) saveCardEl.checked = false;
    if (status) { status.hidden = false; status.textContent = 'Loading secure card fields…'; }

    pbRenderStaxLineItems(session);
    pbRenderStaxSavedCard(session);

    window.__pbStaxSession = session;
    pbUpdateStaxDisplayedAmount();

    pbStaxInstance = new StaxJs(session.webPaymentsToken, {
        number: {
            id: 'pbStaxCardNumber',
            placeholder: '0000 0000 0000 0000',
            style: 'height: 44px; width: 100%; font-size: 16px; padding: 0 12px; border: none; outline: none;',
            type: 'text',
            format: 'prettyFormat',
        },
        cvv: {
            id: 'pbStaxCardCvv',
            placeholder: 'CVV',
            style: 'height: 44px; width: 100%; font-size: 16px; padding: 0 12px; border: none; outline: none;',
            type: 'text',
        },
    });

    // .showCardForm() is documented on Stax's "accepting a credit card
    // payment" sample; feature-detect it in case a given Stax.js build
    // mounts on construction instead, since this hasn't been run live.
    const mounted = typeof pbStaxInstance.showCardForm === 'function'
        ? pbStaxInstance.showCardForm()
        : Promise.resolve();

    mounted
        .then(() => { if (status) status.hidden = true; })
        .catch(err => {
            if (status) { status.textContent = 'Could not load the card form. Please try again.'; }
            console.error('Stax.js showCardForm failed');
        });

    if (typeof pbStaxInstance.on === 'function') {
        pbStaxInstance.on('card_form_complete', () => { if (payBtn) payBtn.disabled = false; });
        pbStaxInstance.on('card_form_uncomplete', () => { if (payBtn) payBtn.disabled = true; });
    }

    if (modal) modal.classList.remove('hidden');
    document.body.classList.add('pb-modal-open');
}

async function pbStaxTokenizeAndCharge() {
    const session = window.__pbStaxSession;
    const payBtn = pbEl('pbStaxPayBtn');
    const status = pbEl('pbStaxModalStatus');
    const monthEl = pbEl('pbStaxExpMonth');
    const yearEl = pbEl('pbStaxExpYear');
    if (!session || !pbStaxInstance) return;

    if (payBtn) payBtn.disabled = true;
    if (status) { status.hidden = false; status.textContent = 'Processing payment…'; }

    try {
        const amount = pbSelectedStaxAmount();
        // Per Stax's documented sample, expiration month/year travel as
        // plain fields here — only the number and CVV are collected inside
        // Stax's own iframes. See create-stax-charge's ✅ note for why.
        const tokenizeResult = await pbStaxInstance.tokenize({
            firstname: session.firstname,
            lastname: session.lastname,
            person_name: `${session.firstname} ${session.lastname}`.trim(),
            phone: session.phone || '',
            method: 'card',
            month: monthEl ? monthEl.value : '',
            year: yearEl ? yearEl.value : '',
            customer_id: session.customerId,
            match_customer: true,
            validate: true,
        });

        const paymentMethodId = tokenizeResult && tokenizeResult.id;
        if (!paymentMethodId) throw new Error('Could not read the card. Please check the details and try again.');

        const saveCard = !!pbEl('pbStaxSaveCard')?.checked;
        const chargeResult = await chargeStaxPayment(session.invoiceId, paymentMethodId, {
            saveCard, amount, paymentAttemptId: session.paymentAttemptId,
            sandboxTest: pbStaxTestEnabled(),
        });
        if (!chargeResult || chargeResult.success !== true) {
            throw new Error('Payment was not confirmed. Please try again.');
        }

        // A fresh card's brand/last-four live only inside Stax's own iframe —
        // this app never reads card data, so unlike the saved-card path below
        // there's no verified field to show here. pbRenderReceipt already
        // omits the row entirely when paymentMethodLine is null.
        pbLastReceipt = {
            familyName: (typeof portalContext !== 'undefined' && (portalContext?.parent_name || portalContext?.family_name)) || 'there',
            amount: Number(chargeResult.amount) || amount,
            invoiceNumber: `INV-${session.invoiceId}`,
            paidOn: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            paymentMethodLine: null,
            confirmationNumber: chargeResult.transactionId || '—',
        };
        pbCloseStaxModal(true);
    } catch (e) {
        if (e.nextPaymentAttemptId) session.paymentAttemptId = e.nextPaymentAttemptId;
        if (status) {
            status.hidden = false;
            status.textContent = e.message || 'Payment failed. Please check the card details and try again.';
        }
        if (payBtn) payBtn.disabled = false;
    }
}

/** Charges the family's saved card on file directly — no tokenization needed, this app never handles the card. */
async function pbStaxChargeSavedCard() {
    const session = window.__pbStaxSession;
    const btn = pbEl('pbStaxUseSavedCardBtn');
    const status = pbEl('pbStaxModalStatus');
    if (!session) return;
    if (btn) btn.disabled = true;
    if (status) { status.hidden = false; status.textContent = 'Processing payment…'; }
    try {
        const amount = pbSelectedStaxAmount();
        const chargeResult = await chargeStaxPayment(session.invoiceId, null, {
            useSavedCard: true, amount, paymentAttemptId: session.paymentAttemptId,
            sandboxTest: pbStaxTestEnabled(),
        });
        if (!chargeResult || chargeResult.success !== true) {
            throw new Error('Payment was not confirmed. Please try again.');
        }
        pbLastReceipt = {
            familyName: (typeof portalContext !== 'undefined' && (portalContext?.parent_name || portalContext?.family_name)) || 'there',
            amount: Number(chargeResult.amount) || amount,
            invoiceNumber: `INV-${session.invoiceId}`,
            paidOn: new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }),
            paymentMethodLine: session.savedCard
                ? `${session.savedCard.brand || 'Card'} ending in ${session.savedCard.last4 || '????'}`
                : null,
            confirmationNumber: chargeResult.transactionId || '—',
        };
        pbCloseStaxModal(true);
    } catch (e) {
        if (e.nextPaymentAttemptId) session.paymentAttemptId = e.nextPaymentAttemptId;
        if (status) {
            status.hidden = false;
            status.textContent = e.message || 'Payment failed. Please try again or use a different card.';
        }
        if (btn) btn.disabled = false;
    }
}

function pbCloseStaxModal(success) {
    const modal = pbEl('pbStaxModal');
    if (modal) modal.classList.add('hidden');
    document.body.classList.remove('pb-modal-open');
    const numberMount = pbEl('pbStaxCardNumber');
    const cvvMount = pbEl('pbStaxCardCvv');
    if (numberMount) numberMount.innerHTML = '';
    if (cvvMount) cvvMount.innerHTML = '';
    pbStaxInstance = null;
    window.__pbStaxSession = null;
    pbStaxPaying = null;
    // A confirmed Stax charge has real, synchronous confirmation data (see
    // pbStaxTokenizeAndCharge/pbStaxChargeSavedCard) — go straight to the
    // Payment Received screen instead of the older "confirming now" banner,
    // which stays reserved for Authorize.net's async-only confirmation.
    if (success && pbLastReceipt) {
        if (typeof psInvalidate === 'function') psInvalidate();
        pbView = 'receipt';
    } else if (success) {
        pbSetReturnState('paid');
        if (typeof psInvalidate === 'function') psInvalidate();
        pbView = 'home';
        pbShowBreakdown = false;
    }
    pbRender();
    // Refresh pbData in the background once the cache above is invalidated,
    // so Home reflects the real post-payment balance whenever the parent
    // navigates there — psSchedule() is otherwise cached for the rest of the
    // session (portal-nav.js only calls pbLoad() on Billing's first open),
    // and pbLoad()'s own "Loading…" wipe would blank the receipt screen the
    // parent is looking at right now, so this refetches quietly instead.
    if (success) pbRefreshQuietly();
}

async function pbLoad() {
    const body = pbEl('pbBody');
    if (body) body.innerHTML = '<p class="pa-empty">Loading…</p>';
    // ⚠️ A null payload is NOT a failure. my_schedule() returns the jsonb
    // 'null' for a caller with no family behind the session, and folding that
    // into the catch told a reader to "pull down to retry" a state no retry
    // can change. Non-parent sessions are redirected away before this runs
    // (portal-auth.js), so this is the residue: a session that matched no app.
    pbLoadFailed = false;
    try {
        pbData = await psSchedule();   // shared with Schedule and Today — one fetch, not three
    } catch (e) {
        console.warn('billing:', e);
        pbData = null;
        pbLoadFailed = true;
    }
    pbRender();
}

/** Same fetch as pbLoad(), without the "Loading…" wipe — used right after a
 *  payment so a screen already on view (the receipt, or Home's return
 *  banner) doesn't flash blank while pbData catches up in the background. */
async function pbRefreshQuietly() {
    try {
        pbData = await psSchedule();
        pbRender();
    } catch (e) {
        console.warn('billing refresh:', e);
    }
}
