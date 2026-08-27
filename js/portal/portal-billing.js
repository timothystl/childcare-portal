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
// ⚠️ PROCESSOR: Authorize.net Accept Hosted, wired for evaluation against
// their SANDBOX credentials — nothing here has moved real money yet. "Pay"
// opens #pbPayModal and loads Authorize.net's own hosted payment page into
// an iframe INSIDE it (create-payment-session gets the token; this file
// never touches card data, keeping the app at PCI SAQ A) rather than
// redirecting the whole page — paying stays inside the portal.
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
// navigating the return URL instead of using the communicator.
//
// STAX PAYMENT FLOW (live 2026-08-27): the normal Pay online button uses
// Stax.js/Bolt fields. The full outstanding balance is the default; parents
// can deliberately choose a smaller installment, which the server validates
// against a fresh balance before charging.

let pbData = null;
let pbReturnState = null;   // 'paid' | 'cancelled' | null — set by portal-auth.js
let pbPaying = null;        // invoice id currently starting a payment, or null
let pbStaxPaying = null;    // invoice id currently in the Stax comparison modal, or null
let pbStaxInstance = null;  // the live StaxJs() instance for the open modal, or null

/** Called from portal-auth.js when Authorize.net's hosted page redirects back. */
function pbSetReturnState(kind) { pbReturnState = kind; }

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
    if (!invoices.length) {
        body.innerHTML = `<div class="tab-placeholder">
            <h2>No bills issued yet</h2>
            <p>Once the office issues a bill for a month, it will show up here
               with what's owed. Until then, nothing has changed about how you pay.</p>
        </div>`;
        return;
    }

    const totalDue = invoices.reduce((sum, i) =>
        sum + Math.max(0, (Number(i.final_amount) || 0) - (Number(i.paid_amount) || 0)), 0);

    const banner = pbReturnState ? pbReturnBanner(pbReturnState) : '';

    body.innerHTML = `
        ${banner}
        <section class="pd-card pb-summary">
            <div class="pd-card-head"><span aria-hidden="true">💳</span>Total balance due</div>
            <div class="pd-card-body">
                <p class="pb-total">${pbMoney(totalDue)}</p>
                <p class="pb-fine">Pay online below, or contact the office if you have
                   questions about a balance.</p>
            </div>
        </section>
        ${invoices.map(pbInvoiceCard).join('')}
    `;

    body.querySelectorAll('.pb-stax-btn[data-invoice-id]').forEach(btn => {
        btn.addEventListener('click', () => pbStartStaxPayment(Number(btn.dataset.invoiceId)));
    });

    // A parent freshly back from a payment attempt: reload once more shortly
    // after, since the webhook that actually records the payment can lag
    // the redirect back here by a few seconds. This is a courtesy re-check,
    // not a promise — the invoice list above already reflects whatever is
    // true right now.
    if (pbReturnState === 'paid') {
        setTimeout(() => { pbLoad(); }, 3000);
    }
    pbReturnState = null;
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

function pbInvoiceCard(inv) {
    const due = Math.max(0, (Number(inv.final_amount) || 0) - (Number(inv.paid_amount) || 0));
    const paid = inv.status === 'paid';
    const pill = paid
        ? '<span class="ps-status ps-paid">PAID</span>'
        : `<span class="ps-status ps-due">${inv.status === 'partial' ? 'PARTIAL' : 'DUE'}</span>`;
    return `<section class="pd-card">
        <div class="pd-card-head"><span aria-hidden="true">🧾</span>${pbEsc(pbMonthLabel(inv.month))}</div>
        <div class="pd-card-body">
            <div class="pb-row">
                <span class="pb-row-label">Billed</span>
                <span class="pb-row-value">${pbMoney(inv.final_amount)}</span>
            </div>
            ${inv.paid_amount > 0 ? `<div class="pb-row">
                <span class="pb-row-label">Paid</span>
                <span class="pb-row-value">${pbMoney(inv.paid_amount)}</span>
            </div>` : ''}
            <div class="pb-row pb-row-strong">
                <span class="pb-row-label">${paid ? 'Balance' : 'Balance due'}</span>
                <span class="pb-row-value">${pbMoney(due)} ${pill}</span>
            </div>
            ${!paid ? `<button type="button" class="pb-pay-btn pb-stax-btn" data-invoice-id="${inv.id}"
                ${pbStaxPaying === inv.id ? 'disabled' : ''}>${pbStaxPaying === inv.id ? 'Starting payment…' : `Pay ${pbMoney(due)} online`}</button>
                <p class="pb-pay-error" id="pbStaxError-${inv.id}" hidden></p>` : ''}
        </div>
    </section>`;
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
    if (success) pbSetReturnState('paid');
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
        const session = await createStaxChargeSession(invoiceId);
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
    if (nameEl) nameEl.textContent = `${session.firstname} ${session.lastname}`.trim();
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
        });
        if (!chargeResult || chargeResult.success !== true) {
            throw new Error('Payment was not confirmed. Please try again.');
        }

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
        });
        if (!chargeResult || chargeResult.success !== true) {
            throw new Error('Payment was not confirmed. Please try again.');
        }
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
    if (success) pbSetReturnState('paid');
    pbRender();
}

async function pbLoad() {
    const body = pbEl('pbBody');
    if (body) body.innerHTML = '<p class="pa-empty">Loading…</p>';
    try {
        pbData = await fetchMySchedule();
    } catch (e) {
        console.warn('billing:', e);
        pbData = null;
    }
    pbRender();
}
