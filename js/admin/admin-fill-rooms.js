// ============================================================
// MODULE: Fill the Rooms  (design handoff — Capacity & Fill, turn 1)
// ============================================================
// Planning → Enrollment Outlook → Fill the Rooms. The director's two tied
// priorities from the handoff conversation, on one screen: every empty
// seat-day this week, and every family who stopped moving toward a paying
// seat.
//
// The handoff ships TWO layouts of the same screen and asks for a choice
// between them (1a "dense" — everything visible, nothing to scroll past to
// decide; 1b "calm" — one number, three moves, detail behind pills). Both
// are built here behind a density toggle rather than one being guessed at,
// because the decision is a fortnight of real use, not a design review.
// _frDensity persists in the same apSavePrefs() store the rest of the shell
// uses, so the choice survives a reload while it's being made.
//
// ── Where the numbers come from ─────────────────────────────
// Nothing here computes capacity a second way. Specifically:
//
//   * Seat counts per room per day read `allRegistrations` +
//     `allClosureDates` with the same "!waitlisted && care_date === date"
//     test apStaffing() (admin-portal.js) uses, so the grid and the staffing
//     requirement can never disagree about who is booked.
//   * "At ratio" is apStaffing()'s own `atEdge` rule — booked % staffRatio
//     === 0 — restated, not a second threshold. A cell at the edge is NOT
//     offered for release however empty it looks, because the next child
//     there costs an adult.
//   * The waitlist queue and the fill forecast call wlpRunAllocation()
//     (admin-waitlist.js) directly. That is the same allocation the Waitlist
//     & Capacity Planner draws, which is the whole reason this screen can
//     say "these nine fit days you already have open" without inventing a
//     second definition of "fits".
//   * The inquiry → paying seat funnel reads `waitlist_applications` status
//     and tour_* columns, which already exist (migration
//     waitlist_inquiry_tour_reminders.sql). The handoff describes stages 1–3
//     as having "no data behind them"; that was true of a lead who never
//     filled the form, and still is — see FR_LEAD_GAP below — but every
//     family who DID apply already carries their own tour state.
//
// ── What is deliberately not wired ──────────────────────────
// Drop-in release has no table yet: there is no `drop_in_days`, no released
// -day flag on a registration, and no parent-side booking write. The screen
// therefore computes and shows which room-days WOULD be releasable (open
// seats, not at a ratio edge) and renders the release actions disabled with
// an explicit note, rather than drawing a button that silently does nothing.
// Same for the drop-in revenue tile. See docs at the PR for the three tables
// this needs.

const FR_LEAD_GAP = 'Leads who never filled in the form are not counted — nothing records a phone call yet.';

// The handoff's own prop: how many days of silence counts as stalled.
// Exposed here rather than inlined so the action queue, the funnel's
// "silent" annotations and the calm layout's copy all move together.
const FR_STALL_DAYS = 5;

let _frDensity = 'dense';     // 'dense' (1a) | 'calm' (1b)
let _frWeekOf  = null;        // Monday, YYYY-MM-DD
let _frBound   = false;

function _frEl(id) { return document.getElementById(id); }

function _frMoney(n) { return '$' + Math.round(Number(n) || 0).toLocaleString(); }

function _frDaysSince(iso) {
    if (!iso) return null;
    const then = new Date(iso);
    if (isNaN(then)) return null;
    return Math.max(0, Math.floor((Date.now() - then.getTime()) / 86400000));
}

function _frToday() { return new Date().toLocaleDateString('en-CA'); }

// ── The week grid ───────────────────────────────────────────
// One pass over allRegistrations per week, shared by every tile, the table,
// and both layouts — so "14 open Thursday" is literally the same number
// wherever it appears on the screen.
function _frWeekData(weekOf) {
    const dates = apWeekDates(weekOf);
    const rooms = getSortedRooms().filter(r => !r.hidden && r.status === 'active');

    const rows = rooms.map(room => {
        const ratio = room.staffRatio || 10;
        const cap   = Number(room.capacity) || 0;
        const cells = dates.map(date => {
            const closed = typeof allClosureDates !== 'undefined' && allClosureDates.has(date);
            let booked = 0;
            if (!closed) {
                (allRegistrations || []).forEach(reg => {
                    if (reg.room_id !== room.id) return;
                    (reg.registration_dates || []).forEach(d => {
                        if (!d.waitlisted && d.care_date === date) booked++;
                    });
                });
            }
            const open = closed ? 0 : Math.max(0, cap - booked);
            // apStaffing()'s own atEdge rule, restated — see the header note.
            const atRatio = !closed && booked > 0 && booked % ratio === 0;
            return { date, closed, booked, open, atRatio, releasable: open > 0 && !atRatio && !closed };
        });
        return { room, ratio, cap, cells };
    });

    const byDay = dates.map((date, i) => {
        const closed = rows.length ? rows[0].cells[i].closed : false;
        return {
            date, closed,
            open:       rows.reduce((s, r) => s + r.cells[i].open, 0),
            booked:     rows.reduce((s, r) => s + r.cells[i].booked, 0),
            capacity:   closed ? 0 : rows.reduce((s, r) => s + r.cap, 0),
            releasable: rows.reduce((s, r) => s + (r.cells[i].releasable ? r.cells[i].open : 0), 0),
        };
    });

    const capacity = byDay.reduce((s, d) => s + d.capacity, 0);
    const booked   = byDay.reduce((s, d) => s + d.booked, 0);
    const open     = byDay.reduce((s, d) => s + d.open, 0);

    // Worst two days carry the release recommendation — the handoff's
    // "Thursday and Friday hold two-thirds of them" line, derived rather
    // than asserted, so it stays true in a week shaped differently.
    const worst = byDay.filter(d => !d.closed).slice()
        .sort((a, b) => b.open - a.open).slice(0, 2).map(d => d.date);
    const worstShare = open ? byDay.filter(d => worst.includes(d.date))
        .reduce((s, d) => s + d.open, 0) / open : 0;

    return {
        dates, rows, byDay, capacity, booked, open, worst, worstShare,
        soldPct: capacity ? (booked / capacity) * 100 : 0,
        releasable: byDay.reduce((s, d) => s + d.releasable, 0),
    };
}

// ── The funnel ──────────────────────────────────────────────
// Real waitlist_applications state. `since` is the start of the current
// program year (July 1), matching how the rest of the app talks about a
// year, rather than a rolling window that would make the figure drift.
function _frProgramYearStart() {
    const now = new Date();
    const y = now.getMonth() >= 6 ? now.getFullYear() : now.getFullYear() - 1;
    return `${y}-07-01`;
}

function _frFunnel() {
    const since = _frProgramYearStart();
    const apps = (_allWaitlistApps || []).filter(a => (a.applied_at || '') >= since);

    const toured    = apps.filter(a => a.tour_status === 'completed' || a.tour_completed_at);
    const scheduled = apps.filter(a => a.tour_status === 'scheduled' || a.tour_scheduled_at || a.tour_status === 'completed' || a.tour_completed_at);
    const offered   = apps.filter(a => ['offered', 'accepted', 'enrolled'].includes(a.status));
    const paperwork = apps.filter(a => a.status === 'accepted' && !a.paperwork_received);
    const enrolled  = apps.filter(a => a.status === 'enrolled');

    const silent = offered.filter(a =>
        a.status === 'offered' && !a.still_interested_confirmed_at &&
        (_frDaysSince(a.offered_at) ?? 0) >= FR_STALL_DAYS);
    // A tour that was booked, whose date has passed, and which was never
    // marked completed — the handoff's "no-show, never rebooked".
    const noShow = scheduled.filter(a =>
        a.tour_status === 'scheduled' && a.tour_scheduled_at &&
        new Date(a.tour_scheduled_at) < new Date() && !a.tour_completed_at);

    const total = apps.length;
    const pct = n => (total ? Math.round((n / total) * 100) : 0);

    return {
        since, total, apps,
        stages: [
            { label: 'Inquired',        n: total,             pct: 100,                   note: FR_LEAD_GAP, tone: '' },
            { label: 'Tour scheduled',  n: scheduled.length,  pct: pct(scheduled.length), note: `${total - scheduled.length} never booked`, tone: '' },
            { label: 'Toured',          n: toured.length,     pct: pct(toured.length),    note: noShow.length ? `${noShow.length} no-show${noShow.length === 1 ? '' : 's'}` : '', tone: noShow.length ? 'warn' : '' },
            { label: 'Offered a seat',  n: offered.length,    pct: pct(offered.length),   note: silent.length ? `${silent.length} silent ${FR_STALL_DAYS}+ days` : '', tone: silent.length ? 'warn' : '' },
            { label: 'Paperwork open',  n: paperwork.length,  pct: pct(paperwork.length), note: paperwork.length ? `${paperwork.length} blocking a start date` : '', tone: paperwork.length ? 'warn' : '' },
            { label: 'Enrolled & billed', n: enrolled.length, pct: pct(enrolled.length),  note: `${pct(enrolled.length)}% of inquiries`, tone: 'ok' },
        ],
        silent, noShow, paperwork, offered, enrolled,
    };
}

// ── The action queue ────────────────────────────────────────
// Every row is a real record with a real reason to act, ordered most
// urgent first. Actions that would write to a table that does not exist
// yet are marked `pending:true` and render disabled.
function _frActions(week, funnel, alloc) {
    const today = _frToday();
    const out = [];

    (funnel.offered || []).forEach(a => {
        if (a.status !== 'offered' || !a.offer_deadline) return;
        if (a.offer_deadline > _frAddDays(today, 2)) return;
        const expired = a.offer_deadline < today;
        const silentDays = _frDaysSince(a.offered_at);
        out.push({
            urgent: true, icon: '📨',
            title: `Offer to the ${_frSurname(a)} family ${expired ? 'expired' : 'expires'} ${_frWhen(a.offer_deadline)}`,
            tag: silentDays != null && silentDays >= FR_STALL_DAYS ? `${silentDays} DAYS SILENT` : null,
            body: `${wlRoomLabel(wlDeriveRoom(a))} · ${wlDaysLabel(a)} · offered ${_frWhen(a.offered_at)}${a.still_interested_confirmed_at ? '' : ', no reply'}.`,
            actions: [
                { label: 'Open the record', go: 'wlPlanner' },
                { label: 'Release seat', pending: true },
            ],
        });
    });

    (funnel.paperwork || []).forEach(a => {
        out.push({
            urgent: true, icon: '📄',
            title: `${a.child_name} accepted a seat with paperwork outstanding`,
            tag: 'BLOCKS START',
            body: `${wlRoomLabel(wlDeriveRoom(a))} · accepted ${_frWhen(a.offered_at)}. The family still owes forms.`,
            actions: [
                { label: 'Open the record', go: 'wlPlanner' },
                { label: 'Nudge parent', pending: true },
            ],
        });
    });

    (funnel.noShow || []).forEach(a => {
        const room = wlDeriveRoom(a);
        const openHere = week.rows.find(r => r.room.id === room);
        const openDays = openHere ? openHere.cells.filter(c => c.open > 0).length : 0;
        out.push({
            urgent: false, icon: '🚪',
            title: `Tour no-show — ${_frSurname(a)} family, ${_frWhen(a.tour_scheduled_at)}`,
            tag: 'NEVER REBOOKED',
            body: `Inquired ${_frWhen(a.applied_at)} for ${wlRoomLabel(room)}, ${wlDaysLabel(a)}.${openDays ? ` That room has open seats on ${openDays} of this week's days.` : ''}`,
            actions: [
                { label: 'Open the record', go: 'wlPlanner' },
                { label: 'Offer tour times', pending: true },
            ],
        });
    });

    // The handoff's own headline move: the emptiest day, if it has seats
    // that are genuinely releasable (open AND not at a ratio edge).
    const worstDay = week.byDay.filter(d => !d.closed).slice().sort((a, b) => b.releasable - a.releasable)[0];
    if (worstDay && worstDay.releasable > 0) {
        out.push({
            urgent: false, icon: '🎟️',
            title: `${apFmtDayShort(worstDay.date)} has ${worstDay.releasable} seats that could be released to drop-in`,
            body: `${worstDay.open} open in total; ${worstDay.open - worstDay.releasable} of those sit at a ratio edge and stay closed. Releasing the rest would let already-enrolled families book them without a new registration.`,
            actions: [{ label: 'Release the day', pending: true }],
        });
    }

    // Children aging out next month, with the seats they leave behind.
    if (alloc) {
        const nextIdx = 1;
        const mo = alloc.months[nextIdx];
        alloc.rooms.forEach(room => {
            const evs = (alloc.gradOut[room.id] || {})[nextIdx] || [];
            if (evs.length < 2) return;
            out.push({
                urgent: false, icon: '🎓', ok: true,
                title: `${evs.length} children age out of ${wlRoomLabel(room.id)} in ${mo.label}`,
                body: `Their seats open that month. Pre-offering the waitlist families who want those days is the difference between starting ${mo.label} full and starting it short.`,
                actions: [{ label: 'Open the planner', go: 'wlPlanner' }],
            });
        });
    }

    return out;
}

function _frAddDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString('en-CA');
}

function _frSurname(a) {
    const parts = String(a.parent_name || a.child_name || '').trim().split(/\s+/);
    return parts.length > 1 ? parts[parts.length - 1] : (parts[0] || 'this');
}

function _frWhen(iso) {
    if (!iso) return 'recently';
    const d = new Date(String(iso).length <= 10 ? iso + 'T00:00:00' : iso);
    if (isNaN(d)) return 'recently';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const diff = Math.round((d - today) / 86400000);
    if (diff === 0) return 'today';
    if (diff === 1) return 'tomorrow';
    if (diff === -1) return 'yesterday';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

// ── Waitlist families placeable right now ───────────────────
// alloc.preGridByKid holds, per kid, the open-day grid of the month they
// asked to start. A kid is "placeable now" when the CURRENT month (index 0)
// can seat at least one of the days they want — wlpBestFitDays()'s own
// definition, called against month 0 rather than their desired month.
function _frPlaceableNow(alloc) {
    if (!alloc) return [];
    const ranked = wlpRankedKids(alloc);
    return ranked.map(k => {
        const grid = alloc.preGridByKid[k.id] && alloc.preGridByKid[k.id][0];
        if (!grid) return null;
        const fitDays = k.flexible
            ? Math.min(k.flexibleCount || 0, TREND_DAYS.filter(d => grid[d] >= 1).length)
            : k.days.filter(d => grid[d] >= 1).length;
        if (fitDays <= 0) return null;
        const wanted = k.flexible ? (k.flexibleCount || 0) : k.days.length;
        return { kid: k, fitDays, wanted, complete: fitDays >= wanted };
    }).filter(Boolean);
}

// ── Fill forecast ───────────────────────────────────────────
// Booked seat-days ÷ available seat-days, per month, straight off
// allRegistrations — the same registrations every other capacity screen
// reads. The "if you pre-offer" row adds the placeable waitlist kids' days
// on top, so the gap between the two bars is exactly the decision.
function _frForecast(alloc, placeable) {
    const rooms = getSortedRooms().filter(r => !r.hidden && r.status === 'active');
    const capPerDay = rooms.reduce((s, r) => s + (Number(r.capacity) || 0), 0);
    const months = (alloc ? alloc.months : wlpMonths()).slice(0, 3);

    const out = months.map((mo, i) => {
        const dates = _frWeekdaysInMonth(mo.key).filter(d =>
            !(typeof allClosureDates !== 'undefined' && allClosureDates.has(d)));
        const avail = dates.length * capPerDay;
        let booked = 0;
        (allRegistrations || []).forEach(reg => {
            if (!rooms.some(r => r.id === reg.room_id)) return;
            (reg.registration_dates || []).forEach(d => {
                if (!d.waitlisted && String(d.care_date).startsWith(mo.key)) booked++;
            });
        });
        const ageOut = alloc
            ? alloc.rooms.reduce((s, r) => s + ((alloc.gradOut[r.id] || {})[i] || []).length, 0)
            : 0;
        return { key: mo.key, label: mo.label, pct: avail ? (booked / avail) * 100 : 0, avail, booked, ageOut, dates: dates.length };
    });

    // One "if you pre-offer" row against the weakest of the three.
    const weakest = out.slice().sort((a, b) => a.pct - b.pct)[0];
    if (weakest && weakest.avail && placeable.length) {
        const extra = placeable.reduce((s, p) => s + p.fitDays, 0) * (weakest.dates / 5);
        weakest.ifPreOffer = Math.min(100, ((weakest.booked + extra) / weakest.avail) * 100);
    }
    return out;
}

function _frWeekdaysInMonth(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    const out = [];
    const d = new Date(y, m - 1, 1);
    while (d.getMonth() === m - 1) {
        const dow = d.getDay();
        if (dow >= 1 && dow <= 5) out.push(d.toLocaleDateString('en-CA'));
        d.setDate(d.getDate() + 1);
    }
    return out;
}

// ============================================================
// Rendering
// ============================================================

function _frMetricHtml({ accent, label, value, sub, subTone, extra }) {
    return `
        <div class="fr-metric" style="border-top-color:${accent}">
            <span class="fr-metric-label">${escHtml(label)}</span>
            <div class="fr-metric-value">${escHtml(String(value))}</div>
            ${sub ? `<span class="fr-metric-sub${subTone ? ' ' + subTone : ''}">${sub}</span>` : ''}
            ${extra || ''}
        </div>`;
}

function _frActionRowHtml(a) {
    const tone = a.urgent ? 'is-urgent' : a.ok ? 'is-ok' : 'is-warn';
    const btns = a.actions.map(b => b.pending
        ? `<button type="button" class="fr-act-btn is-pending" disabled
               title="Needs the drop-in/messaging tables — not wired yet">${escHtml(b.label)}</button>`
        : `<button type="button" class="fr-act-btn is-primary" data-ap-go="${escHtml(b.go)}">${escHtml(b.label)}</button>`
    ).join('');
    return `
        <div class="fr-act ${tone}">
            <span class="fr-act-bar"></span>
            <span class="fr-act-icon">${a.icon}</span>
            <div class="fr-act-main">
                <span class="fr-act-title">${escHtml(a.title)}${a.tag ? `<span class="fr-act-tag">${escHtml(a.tag)}</span>` : ''}</span>
                <span class="fr-act-body">${escHtml(a.body)}</span>
            </div>
            <div class="fr-act-btns">${btns}</div>
        </div>`;
}

function _frGridHtml(week) {
    const head = week.dates.map(d => {
        const day = week.byDay.find(x => x.date === d);
        const hot = week.worst.includes(d);
        return `<th class="fr-grid-day${hot ? ' is-hot' : ''}">${escHtml(apFmtDayShort(d))}</th>`;
    }).join('');

    const body = week.rows.map(r => {
        const cells = r.cells.map(c => {
            if (c.closed) return `<td class="fr-cell is-closed">—<div class="fr-cell-note">CLOSED</div></td>`;
            if (c.atRatio) return `<td class="fr-cell is-ratio">${c.open}<div class="fr-cell-note">AT RATIO</div></td>`;
            if (c.releasable && week.worst.includes(c.date)) return `<td class="fr-cell is-open">${c.open}</td>`;
            return `<td class="fr-cell">${c.open}</td>`;
        }).join('');
        const releasableDays = r.cells.filter(c => c.releasable && week.worst.includes(c.date));
        const chip = releasableDays.length
            ? `<span class="fr-chip-open">${releasableDays.map(c => apFmtDayShort(c.date).split(' ')[0]).join(' · ')}</span>`
            : `<span class="fr-chip-closed">None</span>`;
        return `
            <tr>
                <td class="fr-grid-room">
                    <div class="fr-room-name">${escHtml(r.room.label)}</div>
                    <div class="fr-room-meta">cap ${r.cap} · 1:${r.ratio}</div>
                </td>
                ${cells}
                <td class="fr-cell">${chip}</td>
            </tr>`;
    }).join('');

    const foot = week.byDay.map(d =>
        `<td class="fr-foot-cell${week.worst.includes(d.date) ? ' is-hot' : ''}">${d.open}</td>`).join('');

    return `
        <table class="fr-grid">
            <thead>
                <tr>
                    <th class="fr-grid-room">Room</th>
                    ${head}
                    <th class="fr-grid-day">Releasable</th>
                </tr>
            </thead>
            <tbody>${body}</tbody>
            <tfoot>
                <tr>
                    <td class="fr-grid-room">Open seats</td>
                    ${foot}
                    <td class="fr-foot-cell is-ok">${week.releasable}</td>
                </tr>
            </tfoot>
        </table>`;
}

function _frFunnelHtml(funnel) {
    const rows = funnel.stages.map(s => `
        <div class="fr-funnel-row">
            <span class="fr-funnel-label${s.tone === 'ok' ? ' is-ok' : ''}">${escHtml(s.label)}</span>
            <div class="fr-bar"><div class="fr-bar-fill${s.tone ? ' is-' + s.tone : ''}" style="width:${Math.max(2, s.pct)}%"></div></div>
            <span class="fr-funnel-n${s.tone === 'ok' ? ' is-ok' : ''}">${s.n}</span>
            <span class="fr-funnel-note${s.tone === 'warn' ? ' is-warn' : ''}">${escHtml(s.note || '')}</span>
        </div>`).join('');

    const gap = funnel.stages[3].n - funnel.stages[5].n;
    return `
        <div class="ap-panel">
            <div class="ap-panel-head">
                <h3>Inquiry → paying seat</h3>
                <p>Where every family who applied since ${escHtml(_frLongDate(funnel.since))} is sitting right now. ${escHtml(FR_LEAD_GAP)}</p>
            </div>
            <div class="fr-funnel">${rows}</div>
            <div class="fr-foot">
                <p>${gap > 0
                    ? `The drop between <strong>Offered</strong> and <strong>Enrolled</strong> is where the seats go: ${gap} ${gap === 1 ? 'family' : 'families'} were offered one and have not started.`
                    : 'Everyone offered a seat this year has started. Nothing is stalled between offer and enrollment.'}</p>
            </div>
        </div>`;
}

function _frLongDate(iso) {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
}

function _frPlaceableHtml(placeable) {
    if (!placeable.length) {
        return `
            <div class="ap-panel">
                <div class="ap-panel-head">
                    <h3>Place these today</h3>
                    <p>Nobody on the waitlist can be seated into this month's open days right now.</p>
                </div>
            </div>`;
    }
    const rows = placeable.slice(0, 4).map(p => {
        const k = p.kid;
        const days = k.flexible ? `any ${k.flexibleCount} days` : k.days.join('/');
        return `
            <div class="fr-place">
                <span class="fr-place-bar${k.sibling ? ' is-sib' : ''}"></span>
                <div class="fr-place-main">
                    <div class="fr-place-name">${escHtml(k.name)}</div>
                    <div class="fr-place-meta">${escHtml(wlRoomLabel(k.room))}${k.sibling ? ' · 👨‍👩‍👧 sibling here' : ''} · waiting ${escHtml(wlDaysWaiting(k.appliedAt))}</div>
                    <div class="fr-place-fit">Wants ${escHtml(days)} · ${p.complete ? 'all open now' : `${p.fitDays} of ${p.wanted} open now`}</div>
                </div>
                <button type="button" class="fr-act-btn is-primary" data-ap-go="wlPlanner">Offer</button>
            </div>`;
    }).join('');

    const sibs = placeable.filter(p => p.kid.sibling).length;
    const longest = placeable.reduce((m, p) => Math.max(m, _frDaysSince(p.kid.appliedAt) || 0), 0);
    return `
        <div class="ap-panel tone-gold">
            <div class="ap-panel-head">
                <h3>Place these ${placeable.length} today</h3>
                <p>Waitlist families whose requested days are open this month. Sibling priority first, then longest waiting — the planner's own order.</p>
            </div>
            <div class="fr-place-list">${rows}</div>
            <div class="fr-foot">
                <button type="button" class="ap-pill" data-ap-go="wlPlanner">See all ${placeable.length} in the planner</button>
                <span class="fr-foot-note">${sibs} sibling-priority · longest wait ${longest} days</span>
            </div>
        </div>`;
}

function _frForecastHtml(forecast) {
    const rows = forecast.map(f => {
        const tone = f.pct >= 80 ? '' : f.pct >= 72 ? ' is-warn' : ' is-low';
        return `
            <div class="fr-forecast-row">
                <div class="fr-forecast-head">
                    <span>${escHtml(f.label)}</span>
                    <span class="fr-forecast-note">${Math.round(f.pct)}%${f.ageOut ? ` · ${f.ageOut} age out` : ''}</span>
                </div>
                <div class="fr-bar"><div class="fr-bar-fill${tone}" style="width:${Math.max(2, Math.min(100, f.pct))}%"></div></div>
            </div>`;
    }).join('');

    const pre = forecast.find(f => f.ifPreOffer != null);
    const preRow = pre ? `
        <div class="fr-forecast-row">
            <div class="fr-forecast-head">
                <span>${escHtml(pre.label)}, if you pre-offer</span>
                <span class="fr-forecast-note is-ok">${Math.round(pre.ifPreOffer)}%</span>
            </div>
            <div class="fr-bar"><div class="fr-bar-fill is-ok" style="width:${Math.max(2, Math.min(100, pre.ifPreOffer))}%"></div></div>
        </div>` : '';

    return `
        <div class="ap-panel">
            <div class="ap-panel-head">
                <h3>How full we'll be</h3>
                <p>Booked seat-days against available seat-days, off the same registrations every capacity screen reads. Closed days are excluded from both sides.</p>
            </div>
            <div class="fr-forecast">${rows}${preRow}</div>
            ${pre ? `<div class="fr-foot"><p>${escHtml(pre.label)} is the month to act on — the waitlist families who already fit this month's open days would carry it to ${Math.round(pre.ifPreOffer)}%.</p></div>` : ''}
        </div>`;
}

// ── Layout 1a — dense ───────────────────────────────────────
function _frDenseHtml(d) {
    const { week, funnel, actions, placeable, forecast } = d;
    const urgent = actions.filter(a => a.urgent).length;

    return `
        <div class="ap-panel fr-queue">
            <div class="fr-queue-head">
                <h3>Holding a seat empty</h3>
                <span class="fr-queue-meta">${actions.length} to work${urgent ? '' : ' · nothing urgent'}</span>
                ${urgent ? `<span class="fr-queue-badge">${urgent} URGENT</span>` : ''}
            </div>
            ${actions.length
                ? actions.map(_frActionRowHtml).join('')
                : `<p class="empty-hint">Nothing is stalled. Every offer is inside its deadline, every accepted family has their paperwork in, and no tour has been missed.</p>`}
        </div>

        <div class="fr-metrics">
            ${_frMetricHtml({
                accent: 'var(--tang)', label: 'Empty seat-days this week',
                value: `${week.open} of ${week.capacity}`,
                sub: `${Math.round(100 - week.soldPct)}% of the week unsold`, subTone: 'is-warn',
                extra: `<div class="fr-daystrip">${week.byDay.map(b => `
                    <div class="fr-daystrip-cell${week.worst.includes(b.date) ? ' is-hot' : ''}${b.closed ? ' is-closed' : ''}">
                        <div class="fr-daystrip-day">${escHtml(apFmtDayShort(b.date).split(' ')[0])}</div>
                        <div class="fr-daystrip-n">${b.closed ? '—' : b.open}</div>
                    </div>`).join('')}</div>
                    <span class="fr-metric-foot">${week.worst.length === 2
                        ? `${week.worst.map(d => apFmtDayShort(d).split(' ')[0]).join(' and ')} carry ${Math.round(week.worstShare * 100)}% of it.`
                        : 'Spread evenly across the week.'}</span>`,
            })}
            ${_frMetricHtml({
                accent: 'var(--navy)', label: 'Seats sold',
                value: `${week.soldPct.toFixed(1)}%`,
                sub: `${week.booked} of ${week.capacity} seat-days`,
                extra: `<div class="fr-bar fr-bar-lg"><div class="fr-bar-fill" style="width:${week.soldPct}%"></div></div>`,
            })}
            ${_frMetricHtml({
                accent: 'var(--sun)', label: 'Waitlist, placeable now',
                value: `${placeable.length} of ${(_allWaitlistApps || []).filter(a => ['pending', 'offered', 'accepted'].includes(a.status)).length}`,
                sub: 'Their days are open this month', subTone: 'is-gold',
                extra: `<span class="fr-metric-foot">${placeable.filter(p => p.kid.sibling).length} are sibling-priority. The rest need a month we have no seat in yet.</span>
                    <button type="button" class="ap-pill" data-ap-go="wlPlanner">Open the queue →</button>`,
            })}
            ${_frMetricHtml({
                accent: 'var(--ap-neutral-bar, #C9C0A8)', label: 'Drop-in booked',
                value: '—',
                sub: 'Not wired yet', subTone: 'is-muted',
                extra: `<span class="fr-metric-foot">${week.releasable} seat-days this week are open and clear of a ratio edge, so they could be released. Booking them needs the drop-in tables — see the note under the grid.</span>`,
            })}
        </div>

        <div class="fr-cols">
            <div class="fr-col">
                <div class="ap-panel">
                    <div class="ap-panel-head">
                        <h3>Open seats, room by day</h3>
                        <p>Coral means one more child there tips the room past ratio — those stay closed however empty they look. The rest of the open seats on ${escHtml(week.worst.map(d => apFmtDayShort(d).split(' ')[0]).join(' and '))} are the ones worth releasing.</p>
                    </div>
                    <div class="fr-grid-wrap">${_frGridHtml(week)}</div>
                    <div class="fr-foot fr-foot-pending">
                        <button type="button" class="ap-pill is-pending" disabled title="Needs the drop-in tables">Release ${escHtml(week.worst.map(d => apFmtDayShort(d).split(' ')[0]).join(' + '))} everywhere</button>
                        <button type="button" class="ap-pill is-pending" disabled title="Needs the drop-in tables">Set drop-in rates</button>
                        <span class="fr-foot-note">Drop-in release has no table yet — these read the live grid but cannot write.</span>
                    </div>
                </div>
                ${_frFunnelHtml(funnel)}
            </div>
            <div class="fr-col">
                ${_frPlaceableHtml(placeable)}
                ${_frForecastHtml(forecast)}
            </div>
        </div>`;
}

// ── Layout 1b — calm ────────────────────────────────────────
function _frCalmHtml(d) {
    const { week, actions, placeable, forecast } = d;
    const moves = actions.slice(0, 3);
    const worstLabels = week.worst.map(x => apFmtDayShort(x).split(' ')[0]);

    return `
        <div class="fr-hero">
            <span class="fr-hero-label">Empty seat-days this week</span>
            <div class="fr-hero-n">${week.open}</div>
            <p class="fr-hero-line">That is ${Math.round(100 - week.soldPct)}% of the week unsold.${week.worst.length === 2
                ? ` ${escHtml(worstLabels.join(' and '))} hold ${Math.round(week.worstShare * 100)}% of them.`
                : ''}</p>
            <div class="fr-hero-btns">
                <button type="button" class="fr-hero-cta is-pending" disabled title="Needs the drop-in tables">Release ${escHtml(worstLabels.join(' + '))} to drop-in</button>
                <button type="button" class="fr-hero-cta is-ghost" data-fr-density="dense">See the week by room</button>
            </div>
        </div>

        <span class="fr-section-label">${moves.length ? `${moves.length === 1 ? 'One move' : `${moves.length} moves`} worth making today` : 'Nothing needs you today'}</span>
        <div class="fr-moves">
            ${moves.length ? moves.map(a => `
                <div class="fr-move ${a.urgent ? 'is-urgent' : a.ok ? 'is-ok' : 'is-warn'}">
                    <span class="fr-move-icon">${a.icon}</span>
                    <div class="fr-move-main">
                        <div class="fr-move-title">${escHtml(a.title)}</div>
                        <p class="fr-move-body">${escHtml(a.body)}</p>
                    </div>
                    <div class="fr-move-btns">
                        ${a.actions.map(b => b.pending
                            ? `<button type="button" class="fr-act-btn is-pending" disabled title="Not wired yet">${escHtml(b.label)}</button>`
                            : `<button type="button" class="fr-act-btn is-primary" data-ap-go="${escHtml(b.go)}">${escHtml(b.label)}</button>`).join('')}
                    </div>
                </div>`).join('')
            : `<p class="empty-hint">Every offer is inside its deadline, every accepted family has their forms in, and no tour has been missed.</p>`}
        </div>

        <div class="ap-panel">
            <div class="ap-panel-head fr-head-row">
                <div>
                    <h3>This week at a glance</h3>
                    <p>Open seats per day, all rooms pooled.</p>
                </div>
                <button type="button" class="ap-pill" data-fr-density="dense">Room by room →</button>
            </div>
            <div class="fr-glance">
                ${week.byDay.map(b => `
                    <div class="fr-glance-cell${week.worst.includes(b.date) ? ' is-hot' : ''}${b.closed ? ' is-closed' : ''}">
                        <div class="fr-glance-day">${escHtml(apFmtDayShort(b.date).split(' ')[0])}</div>
                        <div class="fr-glance-n">${b.closed ? '—' : b.open}</div>
                        <div class="fr-glance-note">${b.closed ? 'closed' : week.worst.includes(b.date) && b.releasable ? 'worth releasing' : 'open'}</div>
                    </div>`).join('')}
            </div>
        </div>

        <div class="fr-behind">
            <span class="fr-foot-note">The numbers behind this:</span>
            <button type="button" class="ap-pill" data-fr-density="dense">Seats sold · ${week.soldPct.toFixed(1)}%</button>
            <button type="button" class="ap-pill" data-fr-density="dense">Placeable now · ${placeable.length}</button>
            <button type="button" class="ap-pill" data-fr-density="dense">${escHtml(forecast[0] ? `${forecast[0].label} · ${Math.round(forecast[0].pct)}%` : 'Forecast')}</button>
            <button type="button" class="ap-pill" data-fr-density="dense">Full pipeline ▾</button>
        </div>`;
}

// ── Entry point ─────────────────────────────────────────────
async function renderFillRoomsTool() {
    const body = _frEl('frBody');
    if (!body) return;
    if (!_frWeekOf) _frWeekOf = apWeekStart();

    body.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        if (typeof allRegistrations !== 'undefined' && !allRegistrations.length) {
            allRegistrations = await fetchAllRegistrations().catch(() => []);
        }
        if (typeof _allWaitlistApps !== 'undefined' && !_allWaitlistApps.length &&
            typeof loadWaitlistApplications === 'function') {
            await loadWaitlistApplications().catch(() => {});
        }

        const week = _frWeekData(_frWeekOf);
        const funnel = _frFunnel();
        // The allocation is the Planner's, not a copy — see the header note.
        // It throws if the waitlist never loaded, which is survivable: every
        // panel that needs it degrades to an explicit empty state.
        let alloc = null;
        try { alloc = wlpRunAllocation(); } catch (e) { console.warn('fillRooms alloc:', e); }
        const placeable = _frPlaceableNow(alloc);
        const data = { week, funnel, alloc, placeable, forecast: _frForecast(alloc, placeable), actions: _frActions(week, funnel, alloc) };

        body.innerHTML = _frDensity === 'calm' ? _frCalmHtml(data) : _frDenseHtml(data);
        _frSyncHead(week);
    } catch (e) {
        console.warn('renderFillRoomsTool:', e);
        body.innerHTML = `<p class="empty-hint">Could not load: ${escHtml(e.message || String(e))}</p>`;
    }
}

function _frSyncHead(week) {
    const sub = _frEl('frWeekLabel');
    if (sub) {
        const start = new Date(week.dates[0] + 'T00:00:00');
        sub.textContent = `Week of ${start.toLocaleDateString('en-US', { month: 'long', day: 'numeric' })}`;
    }
    document.querySelectorAll('#fillRoomsSection .fr-density [data-fr-density]').forEach(b => {
        b.classList.toggle('is-active', b.dataset.frDensity === _frDensity);
    });
}

function _frSetDensity(next) {
    if (next !== 'dense' && next !== 'calm') return;
    _frDensity = next;
    try { localStorage.setItem('ap.fillRooms.density', next); } catch (e) { /* private mode */ }
    renderFillRoomsTool();
}

// delta 0 is "back to the current week", not a no-op shift — the middle
// button in the week nav is a reset, the way "Today" is on a date picker.
function _frShiftWeek(delta) {
    if (!delta) {
        _frWeekOf = apWeekStart();
    } else {
        const d = new Date((_frWeekOf || apWeekStart()) + 'T00:00:00');
        d.setDate(d.getDate() + delta * 7);
        _frWeekOf = apWeekStart(d);
    }
    renderFillRoomsTool();
}

function setupFillRoomsTool() {
    if (_frBound) return;
    _frBound = true;
    try {
        const saved = localStorage.getItem('ap.fillRooms.density');
        if (saved === 'calm' || saved === 'dense') _frDensity = saved;
    } catch (e) { /* private mode */ }

    const section = _frEl('fillRoomsSection');
    if (!section) return;
    // One delegated listener: both layouts re-render their own markup, so
    // binding per button would have to re-bind on every density switch.
    section.addEventListener('click', (ev) => {
        const dens = ev.target.closest('[data-fr-density]');
        if (dens) { _frSetDensity(dens.dataset.frDensity); return; }
        const nav = ev.target.closest('[data-fr-week]');
        if (nav) { _frShiftWeek(Number(nav.dataset.frWeek)); return; }
        // data-ap-go is handled by the shell's own delegated handler.
    });
}
