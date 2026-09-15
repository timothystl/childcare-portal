// ============================================================
// MODULE: Program calendar  (design handoff: Capacity & Fill, 4f)
// ============================================================
// Planning → Getting In → Program Calendar. One month grid carrying
// everything that already has a date on it, so the answer to "what is
// happening on the 13th" stops being four screens.
//
// ── Five real sources, nothing invented ─────────────────────
// Every entry on this calendar is a row that already exists somewhere:
//
//   🔴 Closure          `closures` (close_date, reason, half_day). A full
//                       closure suppresses that day's charge and shows on
//                       every family's schedule; a half-day closure is
//                       still a billed morning, and the two are drawn
//                       differently because they mean different things.
//   🟡 Tour             `waitlist_applications.tour_scheduled_at` — the
//                       same tours the Leads & Tours board lists.
//   🔵 Announcement     `announcements` (published_at / expires_at).
//   🟢 Menu week        `cacfp_menus` — the same CACFP week families
//                       already see on the public menu page.
//   🟠 Camp             the `camp` program's own dates, from
//                       settings.programs.
//
// A closure added here is the SAME record the parent schedule and the
// billing run already read. That is the whole point of the screen: added
// once, honoured everywhere. Nothing on this calendar is a second copy of
// a date held somewhere else.
//
// ── What the handoff shows that has no record ───────────────
// ⚠️ TIMED EVENTS AND RSVPs ARE NOT BUILT. The design's chapel at 9:15, the
// fire drill at 11:00, the pumpkin patch walk with "18 RSVPs · 4 parents
// driving" — none of those exist as data. `announcements` carries a title
// and a body but no start time, no end time, no room, no audience reply.
// An events table with an RSVP child table is a real migration and a real
// decision about who may reply on a family's behalf, so this screen draws
// what it has and names what it would need, rather than rendering a
// plausible grid of invented 9:15s.
//
// "Director out · office only" is the same gap: a staff-visible-but-not-
// family-visible entry needs an audience flag no date-carrying table has.

const PC_TYPES = {
    closure:     { label: 'Closure · suppresses charges',  color: 'var(--tang)' },
    halfday:     { label: 'Half day · still billed',       color: 'var(--sun)' },
    tour:        { label: 'Tour',                          color: 'var(--sun)' },
    announcement:{ label: 'Announcement',                  color: 'var(--navy)' },
    menu:        { label: 'CACFP menu week',               color: 'var(--green)' },
    camp:        { label: 'Camp',                          color: 'var(--green)' },
};

let _pcMonth = null;     // 'YYYY-MM'
let _pcBound = false;
let _pcSel   = null;     // selected day, 'YYYY-MM-DD'

function _pcEl(id) { return document.getElementById(id); }

function _pcThisMonth() { return new Date().toLocaleDateString('en-CA').slice(0, 7); }

function _pcShiftMonth(month, delta) {
    const [y, m] = month.split('-').map(Number);
    const d = new Date(y, m - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function _pcMonthLabel(month) {
    const [y, m] = month.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
}

function _pcBounds(month) {
    const [y, m] = month.split('-').map(Number);
    const first = new Date(y, m - 1, 1);
    const last  = new Date(y, m, 0);
    return { start: first.toLocaleDateString('en-CA'), end: last.toLocaleDateString('en-CA'), first, last };
}

// ── Gather ──────────────────────────────────────────────────
async function _pcGather(month) {
    const { start, end } = _pcBounds(month);
    const byDate = {};
    const add = (date, entry) => {
        if (!date || date < start || date > end) return;
        (byDate[date] = byDate[date] || []).push(entry);
    };

    const [closures, menus, programs] = await Promise.all([
        (typeof fetchClosures === 'function' ? fetchClosures() : Promise.resolve([])).catch(() => []),
        (typeof fetchCacfpMenus === 'function' ? fetchCacfpMenus(start, end) : Promise.resolve([])).catch(() => []),
        (typeof loadProgramSettings === 'function' ? loadProgramSettings() : Promise.resolve(null)).catch(() => null),
    ]);

    (closures || []).forEach(c => add(c.close_date, {
        type: c.half_day ? 'halfday' : 'closure',
        title: c.half_day ? (c.reason || 'Closing early') : (c.reason || 'Closed'),
        detail: c.half_day
            ? 'Still a billed morning — the day is charged as a half day.'
            : 'No charge for this day. It is removed from every family\'s schedule.',
    }));

    // Tours already on the books — the same rows the Leads board shows.
    if (typeof _allWaitlistApps !== 'undefined') {
        (_allWaitlistApps || []).forEach(a => {
            if (!a.tour_scheduled_at) return;
            const date = String(a.tour_scheduled_at).slice(0, 10);
            const at = new Date(a.tour_scheduled_at);
            add(date, {
                type: 'tour',
                title: `Tour · ${(a.parent_name || a.child_name || 'family').split(' ').pop()}`,
                detail: `${at.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase()} · ${a.child_name || ''}`,
                appId: a.id,
            });
        });
    }

    // Announcements, on the day they were published.
    try {
        const anns = typeof fetchAnnouncements === 'function' ? await fetchAnnouncements() : [];
        (anns || []).forEach(a => {
            const date = String(a.published_at || a.created_at || '').slice(0, 10);
            add(date, { type: 'announcement', title: a.title || 'Announcement', detail: a.body || '' });
        });
    } catch (_) { /* optional layer */ }

    // The CACFP menu, as one marker on the Monday of each week that has one.
    const menuWeeks = new Set();
    (menus || []).forEach(m => {
        const d = new Date(m.menu_date + 'T00:00:00');
        const dow = d.getDay();
        d.setDate(d.getDate() - (dow === 0 ? 6 : dow - 1));
        menuWeeks.add(d.toLocaleDateString('en-CA'));
    });
    menuWeeks.forEach(mon => add(mon, {
        type: 'menu', title: 'Menu week published',
        detail: 'The same CACFP week families see on the public menu page.',
    }));

    // Camp, when the program carries dates and is switched on.
    const camp = (programs?.programs || []).find(p => p.id === 'camp' && p.active);
    if (camp && camp.startDate && camp.endDate) {
        const d = new Date(camp.startDate + 'T00:00:00');
        const stop = new Date(camp.endDate + 'T00:00:00');
        while (d <= stop) {
            add(d.toLocaleDateString('en-CA'), {
                type: 'camp', title: camp.label || 'Camp',
                detail: `${camp.startTime || ''}–${camp.endTime || ''} · $${camp.rate}/day`,
            });
            d.setDate(d.getDate() + 1);
        }
    }

    return byDate;
}

// ── Render ──────────────────────────────────────────────────
function _pcGridHtml(month, byDate) {
    const { first, last } = _pcBounds(month);
    const today = new Date().toLocaleDateString('en-CA');

    // Monday-first grid, padded to whole weeks.
    const lead = (first.getDay() + 6) % 7;
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push(null);
    for (let d = 1; d <= last.getDate(); d++) {
        cells.push(new Date(first.getFullYear(), first.getMonth(), d).toLocaleDateString('en-CA'));
    }
    while (cells.length % 7) cells.push(null);

    const head = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
        .map(d => `<div class="pc-dow">${d}</div>`).join('');

    const body = cells.map(date => {
        if (!date) return '<div class="pc-cell is-blank"></div>';
        const entries = byDate[date] || [];
        const dow = new Date(date + 'T00:00:00').getDay();
        const weekend = dow === 0 || dow === 6;
        const closed = entries.some(e => e.type === 'closure');
        const chips = entries.slice(0, 3).map(e =>
            `<div class="pc-chip is-${e.type}" title="${escHtml(e.detail || '')}">${escHtml(e.title)}</div>`).join('');
        const more = entries.length > 3 ? `<div class="pc-more">+${entries.length - 3} more</div>` : '';
        return `
            <button type="button" class="pc-cell${weekend ? ' is-weekend' : ''}${closed ? ' is-closed' : ''}${date === today ? ' is-today' : ''}${date === _pcSel ? ' is-sel' : ''}"
                    data-pc-day="${date}">
                <span class="pc-num">${Number(date.slice(-2))}</span>
                ${chips}${more}
            </button>`;
    }).join('');

    return `<div class="pc-grid"><div class="pc-dows">${head}</div><div class="pc-cells">${body}</div></div>`;
}

function _pcDayPanelHtml(byDate) {
    if (!_pcSel) {
        return `<div class="ap-panel">
            <div class="ap-panel-head"><h3>Pick a day</h3>
            <p>Everything on it — closures, tours, announcements, the menu week — shows here.</p></div>
        </div>`;
    }
    const entries = byDate[_pcSel] || [];
    const label = new Date(_pcSel + 'T00:00:00')
        .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' });
    return `
        <div class="ap-panel">
            <div class="ap-panel-head"><h3>${escHtml(label)}</h3></div>
            <div class="pc-day-list">
                ${entries.length ? entries.map(e => `
                    <div class="pc-day-row is-${e.type}">
                        <span class="pc-day-bar"></span>
                        <div>
                            <div class="pc-day-title">${escHtml(e.title)}</div>
                            ${e.detail ? `<div class="pc-day-detail">${escHtml(e.detail)}</div>` : ''}
                        </div>
                    </div>`).join('')
                : '<p class="empty-hint">Nothing on this day.</p>'}
            </div>
        </div>`;
}

function _pcLegendHtml() {
    return `
        <div class="ap-panel">
            <div class="ap-panel-head"><h3>What's on here</h3></div>
            <div class="pc-legend">
                ${Object.entries(PC_TYPES).map(([k, v]) =>
                    `<div class="pc-legend-row"><span class="pc-swatch" style="background:${v.color}"></span>
                     <span>${escHtml(v.label)}</span></div>`).join('')}
            </div>
            <div class="pc-foot">
                <p>Every entry is a record that already exists — a closure here is the same row the parent schedule and the billing run read, so it is added once and honoured everywhere.</p>
            </div>
        </div>

        <div class="ap-panel pc-gap">
            <div class="ap-panel-head">
                <h3>Not on here yet</h3>
                <p>Timed events and RSVPs.</p>
            </div>
            <div class="pc-foot">
                <p>Chapel at 9:15, a fire drill at 11:00, a pumpkin-patch walk with replies from families — none of those exist as data. <code>announcements</code> carries a title and a body but no start time, no room, and no way for a family to answer. That is an <code>events</code> table plus an RSVP table, and a decision about who may reply on a family's behalf — so this calendar draws what it has rather than a plausible grid of invented times.</p>
            </div>
        </div>`;
}

async function renderProgramCalendarTool() {
    const body = _pcEl('pcBody');
    if (!body) return;
    if (!_pcMonth) _pcMonth = _pcThisMonth();
    body.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        // The tour layer reads the waitlist; load it if nothing else has.
        if (typeof _allWaitlistApps !== 'undefined' && !_allWaitlistApps.length &&
            typeof loadWaitlistApplications === 'function') {
            await loadWaitlistApplications().catch(() => {});
        }
        const byDate = await _pcGather(_pcMonth);
        const counts = Object.values(byDate).flat().reduce((acc, e) => {
            acc[e.type] = (acc[e.type] || 0) + 1; return acc;
        }, {});

        body.innerHTML = `
            <div class="pc-toolbar">
                <div class="pc-nav">
                    <button type="button" class="ap-pill" data-pc-month="-1" aria-label="Previous month">‹</button>
                    <span class="pc-month">${escHtml(_pcMonthLabel(_pcMonth))}</span>
                    <button type="button" class="ap-pill" data-pc-month="1" aria-label="Next month">›</button>
                    <button type="button" class="ap-pill" data-pc-month="0">This month</button>
                </div>
                <div class="pc-counts">
                    ${counts.closure ? `<span class="pc-count is-closure">${counts.closure} closed</span>` : ''}
                    ${counts.halfday ? `<span class="pc-count is-halfday">${counts.halfday} half day</span>` : ''}
                    ${counts.tour ? `<span class="pc-count is-tour">${counts.tour} tour${counts.tour === 1 ? '' : 's'}</span>` : ''}
                    ${counts.camp ? `<span class="pc-count is-camp">camp</span>` : ''}
                </div>
            </div>
            <div class="pc-cols">
                <div class="pc-col-wide">${_pcGridHtml(_pcMonth, byDate)}</div>
                <div class="pc-col-narrow">
                    ${_pcDayPanelHtml(byDate)}
                    ${_pcLegendHtml()}
                </div>
            </div>`;
    } catch (e) {
        console.warn('renderProgramCalendarTool:', e);
        body.innerHTML = `<p class="empty-hint">Could not load: ${escHtml(e.message || String(e))}</p>`;
    }
}

function setupProgramCalendarTool() {
    if (_pcBound) return;
    const section = _pcEl('programCalendarSection');
    if (!section) return;
    _pcBound = true;
    section.addEventListener('click', (ev) => {
        const nav = ev.target.closest('[data-pc-month]');
        if (nav) {
            const delta = Number(nav.dataset.pcMonth);
            _pcMonth = delta ? _pcShiftMonth(_pcMonth || _pcThisMonth(), delta) : _pcThisMonth();
            _pcSel = null;
            renderProgramCalendarTool();
            return;
        }
        const day = ev.target.closest('[data-pc-day]');
        if (day) {
            _pcSel = _pcSel === day.dataset.pcDay ? null : day.dataset.pcDay;
            renderProgramCalendarTool();
        }
    });
}
