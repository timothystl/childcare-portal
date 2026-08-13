// ============================================================
// portal-schedule — the parent's Schedule tab (design §7)
// ============================================================
// "The existing lookup.js month-grouping logic, restyled per-month as a card."
// The rate maths is deliberately the same shape as lookup.js and app.js:
// half-day rate when the room offers one and the day is a half, full otherwise.
//
// ⚠️ THE DESIGN'S "PAID Aug 1" / "DUE SEP 1" PILL IS NOT RENDERED FROM NOTHING.
// Every billing_invoices row in production is draft or void — no invoice has
// ever been finalized, sent or paid. So a status pill appears only when a real
// issued invoice exists for that month, and an amount without one is labeled an
// estimate. Showing "DUE" off a computed figure would tell a parent they owe
// money the office has never billed them for.

let psData = null;

function psEl(id) { return document.getElementById(id); }
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
        wrap.innerHTML = '<p class="pa-empty">Could not load your schedule.</p>';
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
        wrap.innerHTML = `<div class="tab-placeholder">
            <h2>No care days booked yet</h2>
            <p>Once you register, your days and what they cost appear here.</p>
            <div class="tab-ph-links">
                <a class="btn-secondary" href="calendar.html">Register for care days</a>
            </div></div>`;
        return;
    }

    wrap.innerHTML = children.map(c => psChildCard(c, closed, invoiceByMonth)).join('') + `
        <a class="ps-register" href="calendar.html">Register for additional days →</a>
        <p class="ps-disclaimer">Amounts are worked out from the days booked and
           your room's rates. Your statement from the office is the bill —
           anything issued will show here as it happens.</p>`;
}

function psChildCard(child, closed, invoiceByMonth) {
    const room = psRoom(child.roomId);
    const months = Object.entries(child.months).sort(([a], [b]) => a.localeCompare(b));

    return `<section class="pa-card">
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

    const tally = [
        full ? `<span class="ps-tally-full">${full} Full</span>` : '',
        half ? `<span class="ps-tally-half">${half} Half</span>` : '',
    ].filter(Boolean).join(' + ');

    return `<div class="ps-month">
        <div class="ps-month-row">
            <span class="ps-month-label">${psEsc(psMonthLabel(monthKey))}</span>
            <span class="ps-month-meta">
                <span class="ps-tally">${tally}</span>
                <span class="ps-month-bill">${psMoney(total)}</span>
                ${status || '<span class="ps-est">estimate</span>'}
            </span>
        </div>
        <div class="ps-chips">${days.map(d => psChip(d, closed)).join('')}</div>
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
    const cls = isClosed ? 'ps-chip ps-chip-closed'
              : isHalf   ? 'ps-chip ps-chip-half' : 'ps-chip';
    const kind = isClosed ? 'Closed' : (isHalf ? '½' : 'Full');
    const title = isClosed ? ` title="${psEsc(closed.get(d.care_date) || 'Center closed')} — no charge"` : '';
    return `<span class="${cls}"${title}>
        <span class="ps-chip-dow">${dow}</span>
        <span class="ps-chip-date">${date}</span>
        <span class="ps-chip-kind">${kind}</span>
    </span>`;
}

async function psLoad() {
    const wrap = psEl('ptScheduleBody');
    if (wrap) wrap.innerHTML = '<p class="pa-empty">Loading…</p>';
    try {
        psData = await fetchMySchedule();
    } catch (e) {
        console.warn('schedule:', e);
        psData = null;
    }
    psRender();
}
