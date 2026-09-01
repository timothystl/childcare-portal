// ============================================================
// portal-schedule — the parent's Schedule tab (design §7)
// ============================================================
// "The existing lookup.js month-grouping logic, restyled per-month as a card."
// The rate maths is deliberately the same shape as lookup.js and app.js:
// half-day rate when the room offers one and the day is a half, full otherwise.
//
// ⚠️ THE DESIGN'S "PAID Aug 1" / "DUE SEP 1" PILL IS NOT RENDERED FROM NOTHING.
// A status pill appears only when a real issued invoice exists for that month.
// Showing "DUE" off a computed figure would tell a parent they owe money the
// office has never billed them for.
//
// ⚠️ And the amount beside that pill is the INVOICE's amount whenever an
// invoice exists — never the rate maths below. The two disagreeing in front of
// a parent (Schedule "$75.00 DUE", Billing "INV-3995 $50.00", same child, same
// month) is what this rule exists to prevent; see psMonthBlock().

let psData = null;
let psLoadFailed = false;   // a thrown error, as distinct from an empty payload
let psPromise = null;      // one fetch, shared with Billing and Today
let psActiveChild = null;  // phone only — the wide layout shows every child

function psEl(id) { return document.getElementById(id); }

/**
 * my_schedule(), fetched at most once per session and shared.
 * Today reads it for the room label beside a child's name, Billing reads it for
 * invoices, Schedule reads it for booked days — three tabs asking the database
 * the same question three times was three round trips for one answer.
 * Rejections are not cached: a failed load should be retryable by reopening the
 * tab, not sticky for the life of the session.
 */
function psSchedule() {
    if (!psPromise) {
        // ⚠️ The live room_rates setting is loaded alongside the schedule, not
        // assumed from the ROOMS defaults in js/supabase.js. Those defaults have
        // drifted from what the office actually charges (Summer Camp is $50 in
        // settings and $75 in the defaults), so an estimate built from them told
        // a parent a number the invoice for the same month contradicted. Rates
        // are best-effort: a failure leaves the defaults in place rather than
        // failing the whole tab, and the invoice figure below is what a month
        // with a real invoice shows anyway.
        psPromise = Promise.all([
            fetchMySchedule(),
            (typeof loadRateSettings === 'function'
                ? loadRateSettings() : Promise.resolve(false)).catch(() => false),
        ]).then(([sched]) => sched)
          .catch(e => { psPromise = null; throw e; });
    }
    return psPromise;
}

/**
 * Clears the shared cache so the next psSchedule() call actually refetches.
 * Billing calls this after a payment succeeds — my_schedule()'s invoices are
 * exactly what changed, and this promise is otherwise cached for the life of
 * the session (parent-nav.js's lazy-first-open guard means a tab switch does
 * NOT re-trigger a load), so without this a paid invoice would read as still
 * due until the parent reloads the whole page.
 */
function psInvalidate() { psPromise = null; }
function psEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function psMoney(n) { return '$' + (Number(n) || 0).toFixed(2); }

function psRoom(roomId) {
    return (typeof ROOMS !== 'undefined' && ROOMS.find(r => r.id === roomId)) || null;
}

// Same rule as lookup.js / app.js: a room with no half-day rate charges full
// for every day, whatever the day_type says.
function psDayRate(room, dayType) {
    if (!room) return 0;
    return (!room.fullDayOnly && dayType === 'half')
        ? (room.halfDayRate || 0)
        : (room.fullDayRate || 0);
}

function psMonthLabel(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    const names = (typeof MONTH_NAMES !== 'undefined' && MONTH_NAMES) ||
        ['January','February','March','April','May','June','July','August',
         'September','October','November','December'];
    return `${names[m - 1]} ${y}`;
}

// ── Render ──────────────────────────────────────────────────

function psRender() {
    const wrap = psEl('ptScheduleBody');
    if (!wrap) return;
    if (!psData) {
        // Same distinction as Billing: an empty payload means no family behind
        // this session, not a call that failed.
        wrap.innerHTML = psLoadFailed
            ? '<p class="pa-empty">Could not load your schedule. Pull down to retry.</p>'
            : '<p class="pa-empty">This sign-in is not linked to a family account, so there are no care days on it.</p>';
        return;
    }

    const closed = new Map((psData.closures || []).map(c => [c.close_date, c.reason]));
    const invoiceByMonth = new Map((psData.invoices || []).map(i => [i.month, i]));

    // child -> month -> days
    const byChild = {};
    (psData.registrations || []).forEach(r => {
        const child = r.child_name || 'Child';
        byChild[child] = byChild[child] || { child, roomId: r.room_id, months: {} };
        (r.dates || []).forEach(d => {
            if (d.waitlisted) return;             // not booked; not billed
            const mk = String(d.care_date).slice(0, 7);
            (byChild[child].months[mk] = byChild[child].months[mk] || []).push({
                ...d, roomId: d.room_id || r.room_id,
            });
        });
    });

    const children = Object.values(byChild).filter(c => Object.keys(c.months).length);
    if (!children.length) {
        wrap.innerHTML = `<div class="tab-placeholder ui-empty-state">
            <img class="ui-empty-illustration" src="/images/illustrations/empty-schedule.svg" alt="">
            <h2>No care days booked yet</h2>
            <p>Once you register, your days and what they cost appear here.</p>
            <div class="tab-ph-links">
                <a class="btn-secondary" href="/calendar">Register for care days</a>
            </div></div>`;
        return;
    }

    if (!psActiveChild || !children.some(c => c.child === psActiveChild)) {
        psActiveChild = children[0].child;
    }

    // Every child is rendered every time. Which ones are VISIBLE is CSS's job:
    // the phone shows one at a time behind the switcher (design), the wide
    // layout lays them out side by side and hides the switcher entirely. Doing
    // it this way means the two layouts share one render rather than one of
    // them being a special case in here.
    const pills = children.length > 1
        ? `<div class="pt-switcher ps-switcher">${children.map(c =>
            `<button type="button" class="pt-childbtn ${c.child === psActiveChild ? 'active' : ''}"
                     data-child="${psEsc(c.child)}">${psEsc(String(c.child).split(' ')[0])}</button>`
          ).join('')}</div>`
        : '';

    wrap.innerHTML = pills + `<div class="ps-cards">${
        children.map(c => psChildCard(c, closed, invoiceByMonth)).join('')}</div>` + `
        <a class="ps-register" href="/calendar">Register for additional days →</a>
        <p class="ps-disclaimer">Amounts are worked out from the days booked and
           your room's rates. Your statement from the office is the bill —
           anything issued will show here as it happens.</p>`;

    wrap.querySelectorAll('.ps-switcher .pt-childbtn').forEach(b => {
        b.addEventListener('click', () => { psActiveChild = b.dataset.child; psRender(); });
    });
}

function psChildCard(child, closed, invoiceByMonth) {
    const room = psRoom(child.roomId);
    const months = Object.entries(child.months).sort(([a], [b]) => a.localeCompare(b));

    return `<section class="pa-card ps-card ${child.child === psActiveChild ? 'is-active' : ''}"
             data-child="${psEsc(child.child)}">
        <h2 class="pa-card-head">${psEsc(String(child.child).split(' ')[0])}${
            room ? ` · <span class="ps-room">${psEsc(room.label)}</span>` : ''}</h2>
        <div class="pa-card-body">
            ${months.map(([mk, days]) => psMonthBlock(mk, days, room, closed, invoiceByMonth)).join('')}
        </div>
    </section>`;
}

function psMonthBlock(monthKey, days, room, closed, invoiceByMonth) {
    days.sort((a, b) => a.care_date.localeCompare(b.care_date));

    const full  = days.filter(d => d.day_type !== 'half').length;
    const half  = days.filter(d => d.day_type === 'half').length;
    // A closed day is not charged — the announcement copy in the design says so
    // explicitly ("No charge for that day"), so the total must agree with it.
    const total = days.reduce((sum, d) =>
        closed.has(d.care_date) ? sum : sum + psDayRate(psRoom(d.roomId) || room, d.day_type), 0);

    const inv = invoiceByMonth.get(monthKey);
    const status = inv ? psStatusPill(inv) : '';

    // ⚠️ ONE FIGURE PER MONTH, AND THE INVOICE WINS.
    // `total` above is a client-side estimate; billing_invoices.final_amount is
    // what the office actually billed, computed server-side by
    // compute_family_month_charges(). When both exist they are two answers to
    // one question, and the parent saw both at once — this screen showing an
    // estimate beside a DUE pill while Billing showed the real invoice. An
    // invoice, draft or issued, is therefore the only amount this row prints;
    // the estimate is for a month nothing has been billed for yet.
    const billed  = inv ? Number(inv.final_amount) || 0 : total;
    const isBilled = !!inv;

    const tally = [
        full ? `<span class="ps-tally-full">${full} Full</span>` : '',
        half ? `<span class="ps-tally-half">${half} Half</span>` : '',
    ].filter(Boolean).join(' + ');

    return `<div class="ps-month">
        <div class="ps-month-row">
            <span class="ps-month-label">${psEsc(psMonthLabel(monthKey))}</span>
            <span class="ps-month-meta">
                <span class="ps-month-bill">${psMoney(billed)}</span>
                ${status || `<span class="ps-est">${isBilled ? 'not sent yet' : 'estimate'}</span>`}
            </span>
        </div>
        <div class="ps-days">${days.map(d => psChip(d, closed)).join('')}</div>
        ${tally ? `<div class="ps-tally">${tally}</div>` : ''}
    </div>`;
}

function psStatusPill(inv) {
    const when = inv.sent_at
        ? new Date(inv.sent_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
        : '';
    if (inv.status === 'paid')   return `<span class="ps-status ps-paid">PAID${when ? ' ' + psEsc(when) : ''}</span>`;
    if (inv.status === 'finalized' || inv.status === 'sent')
        return `<span class="ps-status ps-due">DUE${when ? ' ' + psEsc(when) : ''}</span>`;
    return '';   // draft is not a bill; say nothing rather than imply one
}

function psChip(d, closed) {
    const dt   = new Date(d.care_date + 'T00:00:00');
    const dow  = dt.toLocaleDateString('en-US', { weekday: 'short' });
    const date = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    const isClosed = closed.has(d.care_date);
    const isHalf   = d.day_type === 'half';
    const cls = isClosed ? 'ps-day ps-day-closed'
              : isHalf   ? 'ps-day ps-day-half' : 'ps-day';
    const kind = isClosed ? 'Closed' : (isHalf ? '½' : 'Full');
    const title = isClosed ? ` title="${psEsc(closed.get(d.care_date) || 'Center closed')} — no charge"` : '';
    return `<span class="${cls}"${title}>
        <span class="ps-day-dow">${dow.toUpperCase()}</span>
        <span class="ps-day-date">${date}</span>
        <span class="ps-day-kind">${kind}</span>
    </span>`;
}

async function psLoad() {
    const wrap = psEl('ptScheduleBody');
    if (wrap) wrap.innerHTML = '<p class="pa-empty">Loading…</p>';
    psLoadFailed = false;
    try {
        psData = await psSchedule();
    } catch (e) {
        console.warn('schedule:', e);
        psData = null;
        psLoadFailed = true;
    }
    psRender();
}
