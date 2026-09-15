// ============================================================
// MODULE: Family transactions  (design handoff: Capacity & Fill, 4c)
// ============================================================
// The charges card inside Finance → Finance Hub's family drawer, rebuilt.
// The drawer itself, and every action on it, is unchanged — this replaces
// one flat "Base tuition / adjustment / total" block with the three
// changes the handoff actually asks for:
//
//   1. Lines group under the CHILD they belong to, not in one list.
//   2. Every line names WHY it exists — registered, schedule change after
//      the 15th, staff or scholarship discount — rather than appearing as
//      an unexplained number a parent has to ring up about.
//   3. Discounts and payments sit at the FAMILY level, where they actually
//      apply, instead of being smeared across the children.
//
// Plus the four figures at the top, which the handoff observes are the
// only ones a parent ever asks about.
//
// ── Same math as every other billing screen ─────────────────
// ⚠️ This computes nothing. Per-child figures come from
// _buildFamilyBillingData(month, overridesMap) — the same call behind Bill
// This Month, the Billing Report and the drawer's own total — loaded with
// the same fetchBillingOverrides() map, so an overridden child prices
// identically here and in the family total it rolls up into. An empty
// overrides map is exactly the bug that once made "Base tuition" and
// "Total to bill" disagree (see admin-billing-report.js's note), so it is
// not repeated here.
//
// ── What the handoff shows that MDO has no data for ─────────
// The design's example lines include a late-pickup fee and a Labor Day
// closure credit. Neither exists as a record:
//
//   * Late pickup — nothing times a pickup against a room's closing time,
//     so there is no fee to show. (It becomes real with the kiosk.)
//   * Closure credit — a closure in myMDO does not credit a charge, it
//     suppresses one: the day is simply never billed, so there is no
//     negative line to print. Showing an invented credit would misdescribe
//     how a family's bill actually works. The card names the closed days
//     it excluded instead, which is the same fact stated truthfully.

function _ftMoney(n) {
    const v = Math.abs(Number(n) || 0);
    return (Number(n) < 0 ? '−$' : '$') + v.toFixed(2);
}

/**
 * Per-child billing detail for one family in one month, from the shared
 * builder. Returns null when the family has nothing that month, so the
 * caller can fall back rather than print an empty shell.
 */
async function ftFamilyDetail(month, familyEmail) {
    let overrideRows = [];
    try { overrideRows = await fetchBillingOverrides(month); }
    catch (e) { console.warn('ft overrides:', e); }
    const overridesMap = new Map(overrideRows.map(r => [
        `${(r.parent_email || '').toLowerCase()}:${(r.child_name || '').toLowerCase()}`,
        parseFloat(r.override_amount),
    ]));

    const target = (familyEmail || '').toLowerCase();
    const fam = _buildFamilyBillingData(month, overridesMap)
        .find(f => (f.parentEmail || '').toLowerCase() === target);
    return fam || null;
}

/** Closed weekdays inside a month — days that are never billed at all. */
function ftClosedDaysIn(month) {
    if (typeof allClosureDates === 'undefined') return [];
    return [...allClosureDates]
        .filter(d => String(d).startsWith(month))
        .filter(d => { const n = new Date(d + 'T00:00:00').getDay(); return n >= 1 && n <= 5; })
        .sort();
}

// ── One child's block ───────────────────────────────────────
function _ftChildHtml(c) {
    const billed = c.hasOverride ? c.overrideAmount : c.subtotal;
    const lines = [];

    // The care days themselves. "Registered" is the why: these were chosen
    // during the registration window and billed on the 1st.
    const dayBits = [];
    if (c.fullDays) dayBits.push(`${c.fullDays} full`);
    if (c.halfDays) dayBits.push(`${c.halfDays} half`);
    if (dayBits.length) {
        lines.push({
            label: `Care days · ${dayBits.join(', ')}`,
            why: 'Registered for the month',
            amount: c.subtotal,
            badge: 'BILLED', badgeTone: 'ok',
        });
    }

    // A change fee is the one line families query most, and it has a real
    // cause: the schedule was changed after the window closed.
    if (c.changeFees > 0) {
        lines.push({
            label: 'Schedule change after the 15th',
            why: 'Days added or moved once the month had started',
            amount: c.changeFees,
            badge: 'FEE', badgeTone: 'warn',
        });
    }

    // An individual discount belongs to the child it was granted to;
    // the sibling discount does not, and is printed at family level below.
    if (c.discountDollar > 0) {
        lines.push({
            label: c.discLabel && c.discLabel !== '—' ? c.discLabel : 'Discount',
            why: 'On this child’s record',
            amount: -c.discountDollar,
            badge: 'DISCOUNT', badgeTone: 'ok',
        });
    }

    if (c.hasOverride) {
        lines.push({
            label: 'Billing override',
            why: 'Set by the office, with a reason on the invoice audit',
            amount: c.overrideAmount - c.subtotal,
            badge: 'OVERRIDE', badgeTone: 'muted',
        });
    }

    const rows = lines.map(l => `
        <div class="ft-line">
            <span class="ft-line-label">${escHtml(l.label)}</span>
            <span class="ft-line-why">${escHtml(l.why)}</span>
            <span class="ft-line-amt${l.amount < 0 ? ' is-credit' : ''}">${_ftMoney(l.amount)}</span>
            <span class="ft-badge is-${l.badgeTone}">${escHtml(l.badge)}</span>
        </div>`).join('');

    return `
        <div class="ft-child">
            <div class="ft-child-head">
                <span class="ft-child-name">${escHtml(c.childName)}</span>
                <span class="ft-child-room">${escHtml(c.roomLabel || '')}</span>
                <span class="ft-child-total">${_ftMoney(billed)}</span>
            </div>
            ${rows || '<div class="ft-line ft-line-none">No days registered this month.</div>'}
        </div>`;
}

// ── The whole card ──────────────────────────────────────────
/**
 * @param {Object}   row       the ledger row the drawer already has
 * @param {Object}   fam       ftFamilyDetail() output, or null
 * @param {Array}    payments  fetchPaymentsForFamily() output
 * @param {string}   month     YYYY-MM
 */
function ftTransactionsHtml(row, fam, payments, month) {
    const children = fam?.children || [];
    const sibDiscount = children.reduce((s, c) => s + (c.sibDiscount || 0), 0);

    const charged = children.reduce((s, c) =>
        s + (c.hasOverride ? c.overrideAmount : c.subtotal) + (c.changeFees || 0), 0);

    const monthPayments = (payments || []).filter(p => String(p.payment_date || '').startsWith(month));
    const paidThisMonth = monthPayments.reduce((s, p) => s + (Number(p.amount) || 0), 0);

    const year = month.slice(0, 4);
    const paidThisYear = (payments || [])
        .filter(p => String(p.payment_date || '').startsWith(year))
        .reduce((s, p) => s + (Number(p.amount) || 0), 0);

    // Past due is anything outstanding from a month BEFORE this one — the
    // drawer's own owedMonths, which is already computed across a trailing
    // window, rather than a second definition of "late".
    const pastDue = (row.owedMonths || [])
        .filter(m => m.month < month)
        .reduce((s, m) => s + Math.max(0, (m.billed || 0) - (m.collected || 0)), 0);

    const balance = Math.max(0, charged - sibDiscount - paidThisMonth) + pastDue;

    const closed = ftClosedDaysIn(month);
    const closedNote = closed.length ? `
        <div class="ft-note">
            <strong>${closed.length} closed ${closed.length === 1 ? 'day' : 'days'} this month</strong>
            — ${escHtml(closed.map(d => new Date(d + 'T00:00:00')
                    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })).join(', '))}.
            A closure is not credited back; the day is simply never charged, so it does not appear as a line above.
        </div>` : '';

    const familyLines = [];
    if (sibDiscount > 0) {
        familyLines.push({
            label: 'Sibling discount',
            why: 'Applies across the family, not to one child',
            amount: -sibDiscount,
        });
    }
    monthPayments.forEach(p => {
        familyLines.push({
            label: (p.payment_method === 'autopay' || p.source === 'processor')
                ? 'Payment · autopay' : `Payment${p.payment_method ? ' · ' + p.payment_method : ''}`,
            why: friendlyShort(String(p.payment_date || '').slice(0, 10)),
            amount: -(Number(p.amount) || 0),
        });
    });

    return `
        <div class="ft-summary">
            <div class="ft-sum-main">
                <span class="ft-sum-label">Balance due now</span>
                <div class="ft-sum-n">${_ftMoney(balance)}</div>
                <span class="ft-sum-sub">${pastDue > 0
                    ? `${_ftMoney(pastDue)} of it is from an earlier month`
                    : 'Nothing carried over from an earlier month'}</span>
            </div>
            <div class="ft-sum-grid">
                <div><span>Charged this month</span><strong>${_ftMoney(charged)}</strong></div>
                <div><span>Paid this month</span><strong>${_ftMoney(paidThisMonth)}</strong></div>
                <div><span>Past due</span><strong>${_ftMoney(pastDue)}</strong></div>
                <div><span>Paid in ${escHtml(year)}</span><strong>${_ftMoney(paidThisYear)}</strong></div>
            </div>
        </div>

        <div class="inc-dr-field ft-card">
            <div class="fh-dr-card-title">${escHtml(_fhMonthLabel(month))} — what it is made of</div>
            <p class="ft-hint">Grouped by child, then by what each line is for, so a parent's question always has a line to point at.</p>
            ${children.length
                ? children.map(_ftChildHtml).join('')
                : '<p class="empty-hint">No children registered for this month.</p>'}

            ${familyLines.length ? `
                <div class="ft-family">
                    <div class="ft-family-title">The family, not one child</div>
                    ${familyLines.map(l => `
                        <div class="ft-line">
                            <span class="ft-line-label">${escHtml(l.label)}</span>
                            <span class="ft-line-why">${escHtml(l.why)}</span>
                            <span class="ft-line-amt is-credit">${_ftMoney(l.amount)}</span>
                            <span></span>
                        </div>`).join('')}
                </div>` : ''}

            ${closedNote}

            <div class="ft-total">
                <span>Balance carried forward</span>
                <strong>${_ftMoney(balance)}</strong>
            </div>
        </div>`;
}
