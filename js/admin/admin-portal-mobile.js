// ============================================================
// MODULE: Admin Portal — phone shell
// (design handoff "Admin Mobile Redesigns.dc.html", model 1a
//  "Five tabs, inbox first", 2026-09-13)
// ============================================================
// Below 900px the seven-tab portal becomes five thumb-width tabs and four
// purpose-built screens. Nothing here re-implements a tool: every screen
// reads the same apState.live the desktop dashboards read, and every action
// hands off to the real tool through apGo(). What changes is the route in.
//
// The five tabs, and what each one is FOR on a phone:
//   Inbox    — the launch tab. Messages from families is the thing a
//              director actually opens her phone for, so it is what the app
//              opens on. It is the real Messages tool (AP_TABS.messages),
//              not a mobile copy of it: the handoff's inbox screen is a
//              segmented filter over accent-railed message cards, which is
//              what that tool already is. Only its widths needed work — see
//              the Inbox block in css/admin-portal.css.
//   Today    — the "Needs you" queue: incidents to sign, days off to
//              answer, invoices to send. Checked, not landed on.
//   Rooms    — who is in which room right now, whether anything is at
//              ratio, and the two things she starts from a hallway: a fire
//              drill and an incident report. Staff schedule underneath.
//   Families — a hallway lookup. Search, then an A–Z list where the only
//              badges shown are the ones that need something.
//   Money    — collected against billed, and who owes. Billing only.
//
// Deliberately NOT here (the brief was "things that might need to be
// checked on, or small edits — planning doesn't need to be there"):
// Planning, Staff, Market Analysis and Settings have no tab. They are not
// hard-hidden either — apmMoreHtml() prints them at the foot of the four
// screens, because a director who needs Settings from a parking lot should
// not be told the app has no opinion about her.
//
// ⚠️ apState.mTab is the mobile tab and is INDEPENDENT of apState.tab.
// Adding these five to AP_TABS would have changed the desktop sidebar,
// which this handoff does not touch. The mapping between the two lives in
// APM_TABS below and nowhere else.
// ============================================================

const APM_BREAKPOINT = 900;

// `tab`  — the AP_TABS key this mobile tab borrows availability from.
// `tool` — set when the tab IS a tool rather than a screen (Inbox).
const APM_TABS = [
    { key: 'inbox',    icon: '💬',      label: 'Inbox',    tab: 'messages',   tool: 'messages' },
    { key: 'today',    icon: '🧭',      label: 'Today',    tab: 'director'   },
    { key: 'rooms',    icon: '🚸',      label: 'Rooms',    tab: 'classrooms' },
    { key: 'families', icon: '👨‍👩‍👧', label: 'Families', tab: 'classrooms', needsTool: 'families' },
    { key: 'money',    icon: '💰',      label: 'Money',    tab: 'finance'    },
];

// The tabs with no phone slot, in the order they are offered at the foot of
// a screen. Market Analysis is already hideFromTabbar on desktop mobile for
// the same reason it is absent here.
const APM_MORE_TABS = ['planning', 'staff', 'market', 'settings'];

const APM_TAB_BY_KEY = Object.fromEntries(APM_TABS.map(t => [t.key, t]));

// Screen-local UI state. Not persisted: a search string or a filter chip is
// what she is doing right now, not a preference.
const apmState = {
    famQuery: '',
    famFilter: 'here',   // here | all | owes
};

let _apmMql = null;
// The phone tab to come back to from a desktop-only tab. apState.mTab goes
// null while she is off the phone shell (see apmMoreHtml / apmSetup); this
// is what "back" then means, and what a reload restores.
let _apmLastTab = 'inbox';

/** True when the phone shell owns navigation. */
function apmActive() {
    if (typeof window === 'undefined' || !window.matchMedia) return false;
    if (!_apmMql) _apmMql = window.matchMedia(`(max-width: ${APM_BREAKPOINT}px)`);
    return _apmMql.matches;
}

// ── Tab model ────────────────────────────────────────────────

function apmTabAvailable(t) {
    if (typeof apTabAvailable === 'function' && !apTabAvailable(t.tab)) return false;
    if (t.tool) {
        const tool = AP_TOOL_BY_KEY[t.tool];
        if (!tool || !apToolAvailable(tool)) return false;
    }
    if (t.needsTool) {
        const tool = AP_TOOL_BY_KEY[t.needsTool];
        if (!tool || !apToolAvailable(tool)) return false;
    }
    return true;
}

function apmVisibleTabs() {
    return APM_TABS.filter(apmTabAvailable);
}

/**
 * The mobile tab currently lit, or null when she is off the phone shell
 * entirely — inside one of the desktop-only tabs the escape hatch opens.
 *
 * apState.mTab is the single truth for this. It stays put when a screen
 * deep-links into a tool (so Today → Incident Reports still lights Today,
 * and the header offers the way back to Today rather than to nowhere), and
 * goes null only when a `data-ap-tab` navigation leaves the five behind.
 */
function apmCurrentTab() {
    if (!apState.mTab) return null;
    const visible = apmVisibleTabs();
    if (!visible.length) return null;
    return visible.find(t => t.key === apState.mTab) || visible[0];
}

/**
 * Make apState agree with the lit mobile tab before apRender() reads it.
 *
 * ⚠️ The two tab models are stored separately (apState.mTab / apState.tab)
 * and a restored session carries BOTH — a director who was last on Finance
 * at her desk, and last on Inbox on her phone. Without this, a fresh phone
 * load lit Inbox in the tab bar and rendered the Director dashboard under
 * it, because apState.tab still said `director`. Called at the top of
 * apRender() on a phone, before anything reads apState.tab.
 *
 * A tool that is already open wins over both: she deep-linked into it from
 * a screen, and the tab bar follows her there rather than pulling her back.
 */
function apmSyncState() {
    // A null mTab means she deliberately left the phone shell for Planning
    // or Settings; syncing would drag her straight back out of it.
    if (apState.view || !apState.mTab) return;
    const t = apmCurrentTab();
    // Setting the tab is enough for a tool tab too — Inbox's AP_TABS entry
    // names `messages` as its defaultTool, and apRender() opens it from
    // there a few lines later. Naming the tool again here would be a second
    // place that has to agree with AP_TABS about what Messages lands on.
    if (t && apState.tab !== t.tab && apTabAvailable(t.tab)) apState.tab = t.tab;
}

function apmGoTab(key) {
    const t = APM_TAB_BY_KEY[key];
    if (!t || !apmTabAvailable(t)) return;
    apState.mTab = _apmLastTab = key;
    apmSavePrefs();
    if (t.tool) {
        // Inbox is the Messages tool itself; apGo() sets tab + view together.
        apGo(t.tool);
        return;
    }
    apState.tab  = t.tab;
    apState.view = null;
    apSavePrefs();
    apRender();
    window.scrollTo(0, 0);
}

function apmLoadPrefs() {
    // Every model in the handoff opens on messages — that is the whole point
    // of "inbox first", so a first run lands there rather than on Today.
    try { apState.mTab = localStorage.getItem('apmTab') || 'inbox'; }
    catch (_) { apState.mTab = 'inbox'; }
    if (!APM_TAB_BY_KEY[apState.mTab]) apState.mTab = 'inbox';
    _apmLastTab = apState.mTab;
}

// Only ever stores a real tab: a reload should put her back on the phone
// shell, not back inside the desktop-only tab she had wandered into.
function apmSavePrefs() {
    try { localStorage.setItem('apmTab', _apmLastTab); } catch (_) { /* private mode */ }
}

function apmTabbarHtml() {
    const live    = apState.live;
    const current = apmCurrentTab();
    return apmVisibleTabs().map(t => {
        let badge = 0;
        if (live && t.key === 'inbox') badge = live.unread || 0;
        if (live && t.key === 'today') badge = apmNeedsYou(live).length;
        return `<button type="button" class="tabbar-item${current && t.key === current.key ? ' is-active' : ''}"
                    data-apm-tab="${t.key}" role="tab" aria-selected="${!!current && t.key === current.key}">
            <span class="tabbar-icon apm-tabbar-icon" aria-hidden="true">${t.icon}</span>
            <span class="tabbar-label">${escHtml(t.label)}</span>
            ${badge ? `<span class="tabbar-badge">${badge > 99 ? '99+' : badge}</span>` : ''}
        </button>`;
    }).join('');
}

// ── Screen header ────────────────────────────────────────────
// The mint header with the gold rule under it, from the handoff. It is the
// one piece of chrome every screen shares, so it renders from apRender()
// whether a screen or a tool is on — which is also where the way back out of
// a deep-linked tool lives, since the phone has no sidebar to keep her place.

function apmRenderHead() {
    const el = document.getElementById('apmHead');
    if (!el) return;
    if (!apmActive()) {
        el.innerHTML = ''; el.classList.add('hidden');
        document.body.classList.remove('apm-screen');
        return;
    }
    el.classList.remove('hidden');
    // `apm-screen` means one of the four handoff screens is on, and only
    // then does #apPage give up its gutter — a desktop-only tab reached
    // through the escape hatch renders its ordinary dashboard in there and
    // still needs it. Set here because this runs on every render.
    document.body.classList.toggle('apm-screen', apmOwnsDashboard());

    const t    = apmCurrentTab();
    const live = apState.live;
    const tool = apState.view ? AP_TOOL_BY_KEY[apState.view] : null;

    // Off the phone shell entirely (a desktop-only tab from the escape
    // hatch). The tab bar lights nothing, so this bar is the only way back
    // in — without it the hatch is a trapdoor.
    if (!t) {
        const back = APM_TAB_BY_KEY[_apmLastTab] || APM_TABS[0];
        el.innerHTML = `
            <header class="apm-head">
                <button type="button" class="apm-back" data-apm-tab="${escHtml(back.key)}">
                    <span aria-hidden="true">‹</span> ${escHtml(back.label)}
                </button>
                <div class="apm-head-top">
                    <h1>${escHtml(tool ? tool.name : (AP_TABS[apState.tab] || {}).label || '')}</h1>
                </div>
            </header>`;
        return;
    }

    // A tool that is not this tab's own landing screen gets a way back.
    const isOwnTool = !!(t.tool && tool && tool.key === t.tool);
    if (tool && !isOwnTool) {
        el.innerHTML = `
            <header class="apm-head">
                <button type="button" class="apm-back" data-apm-tab="${escHtml(t.key)}">
                    <span aria-hidden="true">‹</span> ${escHtml(t.label)}
                </button>
                <div class="apm-head-top"><h1>${escHtml(tool.name)}</h1></div>
            </header>`;
        return;
    }

    el.innerHTML = apmHeadFor(t, live);
}

function apmHeadFor(t, live) {
    const head = (title, meta, sub, acts) => `
        <header class="apm-head">
            <div class="apm-head-top">
                <h1>${escHtml(title)}</h1>
                ${meta ? `<span class="apm-head-meta">${escHtml(meta)}</span>` : ''}
            </div>
            ${sub ? `<p class="apm-head-sub">${escHtml(sub)}</p>` : ''}
            ${acts || ''}
        </header>`;

    const today = new Date();
    const dayLabel = today.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });

    switch (t.key) {
        case 'inbox':
            return head('Inbox', dayLabel, live && live.unread
                ? `${live.unread} waiting on you`
                : 'nothing waiting on you');

        case 'today': {
            if (!live) return head('Today', dayLabel, '');
            const sf    = live.staffing;
            const ix    = apmDayIndex(live);
            const here  = sf.rows.reduce((a, r) => a + r.cells[ix].kids, 0);
            const kids  = live.families.reduce((a, f) => a + (f.students || []).length, 0);
            const edge  = sf.rows.filter(r => r.cells[ix].atEdge);
            return head('Today', dayLabel,
                `${here} of ${kids} children booked · ${edge.length ? `${edge.length} room${edge.length === 1 ? '' : 's'} at ratio` : 'all rooms have headroom'}`);
        }

        case 'rooms': {
            const timeLabel = today.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).toLowerCase();
            let sub = '';
            if (live) {
                const sf  = live.staffing;
                const ix  = apmDayIndex(live);
                const here = sf.rows.reduce((a, r) => a + r.cells[ix].kids, 0);
                const need = sf.classroom[ix] || 0;
                sub = `${here} children in · ${need} staff the ratios ask for`;
            }
            // Both actions are things she starts from a hallway, so they sit
            // in the header where they are reachable from any room rather
            // than at the bottom of whichever room card she scrolled to.
            const acts = `
                <div class="apm-head-acts">
                    <button type="button" class="apm-btn apm-btn-alert" data-ap-go="drills">🔔 Fire drill</button>
                    <button type="button" class="apm-btn apm-btn-ghost" data-ap-go="incidents">📝 New incident</button>
                </div>`;
            return head('Rooms', timeLabel, sub, acts);
        }

        case 'families': {
            const acts = `
                <div class="apm-search">
                    <span aria-hidden="true">🔍</span>
                    <input type="search" id="apmFamSearch" class="apm-search-input"
                        placeholder="Search a child or family…" autocomplete="off"
                        value="${escHtml(apmState.famQuery)}">
                </div>`;
            return head('Families', '', '', acts);
        }

        case 'money': {
            const monthLabel = today.toLocaleDateString('en-US', { month: 'long' });
            return head('Money', monthLabel, 'Billing only — payroll and reports stay on desktop.');
        }
    }
    return '';
}

// ── Screens ──────────────────────────────────────────────────

/** True when apRender() should hand the page to this module. */
function apmOwnsDashboard() {
    if (!apmActive()) return false;
    const t = apmCurrentTab();
    return !!t && !t.tool;
}

function apmRenderDashboard(page) {
    const live = apState.live;
    if (!live) {
        page.innerHTML = `<p class="apm-loading">Loading today's figures…</p>`;
        apLoadLive().then(() => { if (!apState.view) apRender(); })
                    .catch(err => {
                        console.error('apLoadLive:', err);
                        page.innerHTML = `<p class="empty-hint">Could not load this screen — ${escHtml(err.message || 'unknown error')}.</p>`;
                    });
        return;
    }
    const t = apmCurrentTab();
    const body = {
        today:    apmScreenToday,
        rooms:    apmScreenRooms,
        families: apmScreenFamilies,
        money:    apmScreenMoney,
    }[t ? t.key : ''];
    page.innerHTML = `<div class="apm-body">${body ? body(live) : ''}${apmMoreHtml()}</div>`;
}

function apmDayIndex(live) {
    const i = live.weekDates.indexOf(live.today);
    return i >= 0 ? i : 0;
}

/**
 * The queue, borrowed whole from the desktop Director dashboard. Building a
 * second one for the phone would have given the director two answers to
 * "what is waiting on me" that could disagree — the ordering rules there
 * (a missing child first, then a family who has not been told their child
 * was hurt, then money and paperwork) are the product, not the layout.
 */
function apmNeedsYou(live) {
    if (!live) return [];
    // Memoized on the live payload itself: the tab bar asks for the count on
    // every render and the screen asks for the rows, and apDashDirector()
    // walks every registration to build them. A new apLoadLive() makes a new
    // object, so the cache cannot outlive the data it was built from.
    if (live._apmNeedsYou) return live._apmNeedsYou;
    try { live._apmNeedsYou = apDashDirector(live).needsYou || []; }
    catch (err) { console.warn('apmNeedsYou:', err); live._apmNeedsYou = []; }
    return live._apmNeedsYou;
}

// ── Today ────────────────────────────────────────────────────
function apmScreenToday(live) {
    const rows = apmNeedsYou(live);
    const sf   = live.staffing;
    const ix   = apmDayIndex(live);

    const queue = rows.length ? `
        <section class="apm-card apm-card-urgent">
            <header class="apm-card-head">
                <h3>Needs you</h3>
                <span class="apm-card-count">${rows.length} ${rows.length === 1 ? 'thing' : 'things'}</span>
            </header>
            <div class="apm-card-body">
                ${rows.map(r => `
                <div class="apm-queue${r.urgent ? ' is-urgent' : ''}">
                    <div class="apm-queue-top">
                        <span class="apm-queue-glyph" aria-hidden="true">${r.icon}</span>
                        <div class="apm-queue-main">
                            <div class="apm-queue-title">${escHtml(r.title)}</div>
                            <div class="apm-queue-ctx">${escHtml(r.context)}</div>
                        </div>
                    </div>
                    ${(r.actions || []).length ? `
                    <div class="apm-acts">
                        ${r.actions.map(a => `<button type="button" class="apm-btn${a.primary ? ' apm-btn-primary' : ' apm-btn-ghost'}" data-ap-go="${escHtml(a.key)}">${escHtml(a.label)}</button>`).join('')}
                    </div>` : ''}
                </div>`).join('')}
            </div>
        </section>` : `
        <section class="apm-card apm-card-clear">
            <div class="apm-card-body">
                <div class="apm-clear-glyph" aria-hidden="true">☕</div>
                <p class="apm-clear-title">Nothing is waiting on you.</p>
                <p class="apm-clear-sub">No incidents to sign, no days off to answer, no unread messages.</p>
            </div>
        </section>`;

    // The three busiest rooms today — the phone's version of "who is here
    // right now". A room at ratio is coral because the next arrival changes
    // what she has to do about it.
    const tiles = sf.rows
        .filter(r => r.cells[ix].kids > 0)
        .sort((a, b) => b.cells[ix].kids - a.cells[ix].kids)
        .slice(0, 3)
        .map(r => {
            const c = r.cells[ix];
            return `
            <div class="apm-tile${c.atEdge ? ' is-edge' : ''}">
                <div class="apm-tile-value">${c.kids}</div>
                <div class="apm-tile-label">${escHtml(apmRoomShort(r.label))}</div>
                <div class="apm-tile-note">${c.atEdge ? 'at ratio' : `${c.staff} staff · ok`}</div>
            </div>`;
        }).join('');

    const closure = live.nextClosure
        ? `Next closure — <strong>${escHtml(friendlyShort(live.nextClosure))}</strong>${live.closuresAhead > 1 ? ` · ${live.closuresAhead} on the calendar ahead` : ''}.`
        : 'No closures are on the calendar ahead.';

    const building = tiles ? `
        <section class="apm-card">
            <div class="apm-card-body">
                <div class="apm-eyebrow">In the building right now</div>
                <div class="apm-tiles">${tiles}</div>
                <p class="apm-foot-note">${closure}</p>
            </div>
        </section>` : '';

    return queue + building;
}

/** "🐝 Bee Room" → "Bee Room"; the emoji is already carried by the tile. */
function apmRoomShort(label) {
    return String(label || '').replace(/^\P{L}+/u, '').trim() || String(label || '');
}

// ── Rooms ────────────────────────────────────────────────────
function apmScreenRooms(live) {
    const sf  = live.staffing;
    const ix  = apmDayIndex(live);
    const open = sf.rows.filter(r => r.cells[ix].kids > 0);

    // At-ratio rooms are pulled to the top and opened up, because they are
    // the only rooms where the next thing that happens needs a decision.
    const edge  = open.filter(r => r.cells[ix].atEdge);
    const quiet = open.filter(r => !r.cells[ix].atEdge);

    const edgeCards = edge.map(r => {
        const c   = r.cells[ix];
        const cap = r.room.capacity || 0;
        return `
        <section class="apm-card apm-card-edge">
            <div class="apm-card-body">
                <div class="apm-room-top">
                    <h3 class="apm-room-name">${escHtml(apmRoomShort(r.label))}</h3>
                    <span class="apm-pill apm-pill-alert">At ratio</span>
                </div>
                <div class="apm-room-figs">
                    <span class="apm-room-count">${c.kids}<span class="apm-room-of"> ${cap ? `/ ${cap} in` : 'in'}</span></span>
                    <span class="apm-room-staff">${c.staff} staff · ${escHtml(r.ratioLabel)}</span>
                </div>
                <p class="apm-room-note">One more child in this room adds a staff member.</p>
                <div class="apm-acts">
                    <button type="button" class="apm-btn apm-btn-primary" data-ap-go="attBoard">See roster</button>
                    <button type="button" class="apm-btn apm-btn-ghost" data-ap-go="messages">Message staff</button>
                </div>
            </div>
        </section>`;
    }).join('');

    const quietRows = quiet.map(r => {
        const c   = r.cells[ix];
        const cap = r.room.capacity || 0;
        return `
        <button type="button" class="apm-row" data-ap-go="attBoard">
            <span class="apm-row-main">
                <span class="apm-row-title">${escHtml(apmRoomShort(r.label))}</span>
                <span class="apm-row-sub">${c.kids}${cap ? ` of ${cap}` : ''} in · ${c.staff} staff</span>
            </span>
            <span class="apm-pill apm-pill-ok">Ok</span>
            <span class="apm-chevron" aria-hidden="true">›</span>
        </button>`;
    }).join('');

    const empty = (!edge.length && !quiet.length)
        ? `<section class="apm-card"><div class="apm-card-body"><p class="apm-foot-note">No children are booked for today.</p></div></section>`
        : '';

    return edgeCards + quietRows + empty + apmStaffScheduleHtml(live, ix);
}

/**
 * Who is on today, and what the ratios say is missing. The uncovered row is
 * the point of the card: a room with children booked and nobody scheduled
 * against it is the one thing on this screen that cannot wait until she is
 * back at a desk.
 */
function apmStaffScheduleHtml(live, ix) {
    const today = live.weekDates[ix];
    const onToday = live.schedule.filter(r => r.work_date === today);

    const rows = onToday.slice(0, 5).map(r => {
        const room = (typeof ROOMS !== 'undefined' && ROOMS.find(x => x.id === r.room_id)) || null;
        return `
        <div class="apm-sched-row">
            <span class="apm-sched-name">${escHtml(r.staff_name || 'Staff member')}</span>
            <span class="apm-sched-room">${escHtml(room ? apmRoomShort(room.label) : 'Room not set')}</span>
            <span class="apm-sched-shift">${escHtml(String(r.shift || '').toUpperCase() || '—')}</span>
        </div>`;
    }).join('');

    // Scheduled heads per room today, against what the ratios ask for.
    const scheduledByRoom = {};
    onToday.forEach(r => {
        const k = r.room_id || '—';
        (scheduledByRoom[k] = scheduledByRoom[k] || new Set()).add(r.staff_id);
    });
    const short = live.staffing.rows.filter(r => {
        const need = r.cells[ix].staff;
        if (!need) return false;
        return (scheduledByRoom[r.room.id] ? scheduledByRoom[r.room.id].size : 0) < need;
    });

    const shortRows = short.map(r => {
        const have = scheduledByRoom[r.room.id] ? scheduledByRoom[r.room.id].size : 0;
        const need = r.cells[ix].staff;
        return `
        <button type="button" class="apm-sched-short" data-ap-go="schedule">
            <span class="apm-sched-short-room">${escHtml(apmRoomShort(r.label))}</span>
            <span class="apm-sched-short-note">${have ? `${have} of ${need} scheduled` : 'Uncovered'}</span>
            <span class="apm-chevron" aria-hidden="true">›</span>
        </button>`;
    }).join('');

    const body = (rows || shortRows)
        ? rows + shortRows
        : `<p class="apm-foot-note">Nothing is saved for today yet.</p>`;

    const more = onToday.length > 5
        ? `<p class="apm-foot-note">${onToday.length - 5} more on the schedule today.</p>` : '';

    return `
        <section class="apm-card apm-card-gold">
            <header class="apm-card-head">
                <h3>Staff schedule</h3>
                <button type="button" class="apm-btn apm-btn-mini" data-ap-go="schedule">Edit</button>
            </header>
            <div class="apm-card-body">${body}${more}</div>
        </section>`;
}

// ── Families ─────────────────────────────────────────────────
function apmScreenFamilies(live) {
    const counts = apmFamilyCounts(live);
    const chips = [
        { key: 'here',  label: `Here today${counts.here ? ' ' + counts.here : ''}` },
        { key: 'all',   label: `All ${counts.all}` },
        { key: 'owes',  label: `Owes${counts.owes ? ' ' + counts.owes : ''}` },
    ].map(c => `<button type="button" class="apm-chip${apmState.famFilter === c.key ? ' is-on' : ''}" data-apm-fam-filter="${c.key}">${escHtml(c.label)}</button>`).join('');

    return `
        <div class="apm-chips">${chips}</div>
        <div id="apmFamList">${apmFamilyListHtml(live)}</div>`;
}

function apmFamilyCounts(live) {
    const rows = apmFamilyRows(live);
    return {
        all:  rows.length,
        here: rows.filter(r => r.hereToday).length,
        owes: rows.filter(r => r.owes > 0).length,
    };
}

/**
 * One row per child, not per family — a hallway question is always about a
 * child ("whose is this one, and can Grandma take her home?"), and the
 * family is what the row answers with.
 */
function apmFamilyRows(live) {
    if (!live) return [];
    if (live._apmFamRows) return live._apmFamRows;

    // Children with an incident report actually waiting on HER signature —
    // the same parentSigned filter the Director queue uses, so a row never
    // advertises something she cannot clear.
    const toSign = new Set((live.incidents || [])
        .filter(r => r.parentSigned)
        .map(r => String(r.students && r.students.child_name || '').toLowerCase().trim())
        .filter(Boolean));

    const owedByFamily = new Map((live.whoOwesRows || [])
        .filter(r => r.outstanding > 0)
        .map(r => [String(r.familyId), r.outstanding]));

    const hereToday = new Set();
    (typeof allRegistrations !== 'undefined' ? allRegistrations || [] : []).forEach(reg => {
        if ((reg.registration_dates || []).some(d => !d.waitlisted && d.care_date === live.today))
            hereToday.add(String(reg.child_name || '').toLowerCase().trim());
    });

    const rows = [];
    live.families.forEach(f => {
        const owes = owedByFamily.get(String(f.id)) || 0;
        (f.students || []).forEach(st => {
            const name = st.child_name || 'Unnamed child';
            const key  = name.toLowerCase().trim();
            const parts = name.trim().split(/\s+/);
            const last  = parts.length > 1 ? parts[parts.length - 1] : parts[0] || '';
            rows.push({
                name, last,
                initials: typeof apInitials === 'function' ? apInitials(name) : '··',
                room: typeof _flRoomLabel === 'function' ? _flRoomLabel(st) : 'Room to be assigned',
                parent: f.parent_name || '',
                familyId: f.id,
                owes,
                toSign: toSign.has(key),
                hereToday: hereToday.has(key),
            });
        });
    });

    rows.sort((a, b) => (a.last || '').localeCompare(b.last || '') || a.name.localeCompare(b.name));
    live._apmFamRows = rows;
    return rows;
}

function apmFamilyListHtml(live) {
    const q = apmState.famQuery.trim().toLowerCase();
    let rows = apmFamilyRows(live);

    if (apmState.famFilter === 'here') rows = rows.filter(r => r.hereToday);
    if (apmState.famFilter === 'owes') rows = rows.filter(r => r.owes > 0);
    // A typed query searches everyone, filter chip or not — the chip is a
    // starting point for browsing, never a wall in front of a name she knows.
    if (q) rows = apmFamilyRows(live).filter(r =>
        r.name.toLowerCase().includes(q) || (r.parent || '').toLowerCase().includes(q));

    if (!rows.length) {
        return `<p class="apm-foot-note apm-empty">${q
            ? `Nobody matches “${escHtml(apmState.famQuery.trim())}”.`
            : apmState.famFilter === 'owes' ? 'Nobody owes anything this month.'
            : apmState.famFilter === 'here' ? 'No children are booked for today.'
            : 'No families on file.'}</p>`;
    }

    let letter = '';
    return rows.slice(0, 120).map(r => {
        const l = (r.last || r.name).charAt(0).toUpperCase();
        const head = l !== letter ? `<div class="apm-letter">${escHtml(l)}</div>` : '';
        letter = l;
        const badge = r.toSign
            ? `<span class="apm-pill apm-pill-alert">1 to sign</span>`
            : r.owes > 0
                ? `<span class="apm-pill apm-pill-gold">Owes ${escHtml(apMoney(r.owes))}</span>`
                : `<span class="apm-chevron" aria-hidden="true">›</span>`;
        return `${head}
        <button type="button" class="apm-row apm-row-person" data-ap-go="families">
            <span class="apm-avatar">${escHtml(r.initials)}</span>
            <span class="apm-row-main">
                <span class="apm-row-title">${escHtml(r.name)}</span>
                <span class="apm-row-sub">${escHtml([apmRoomShort(r.room), r.parent].filter(Boolean).join(' · '))}</span>
            </span>
            ${badge}
        </button>`;
    }).join('');
}

// ── Money ────────────────────────────────────────────────────
function apmScreenMoney(live) {
    const rows = live.whoOwesRows || [];
    // Only invoices that have actually been sent count as money owed — the
    // same rule _buildArRows() applies, restated nowhere: `outstanding` is
    // already gated on sent_at, so summing it here cannot disagree with the
    // Finance ledger.
    const collected = rows.reduce((a, r) => a + (r.collected || 0), 0);
    const owed      = rows.reduce((a, r) => a + (r.outstanding || 0), 0);
    const issued    = collected + owed;
    const paidCount = rows.filter(r => r.status === 'paid').length;
    const owedRows  = rows.filter(r => r.outstanding > 0).sort((a, b) => b.outstanding - a.outstanding);
    const pct       = issued > 0 ? Math.round((collected / issued) * 100) : 0;

    const summary = issued > 0 ? `
        <section class="apm-card">
            <div class="apm-card-body">
                <div class="apm-eyebrow">Collected this month</div>
                <div class="apm-money-top">
                    <span class="apm-money-big">${escHtml(apMoney(collected))}</span>
                    <span class="apm-money-of">of ${escHtml(apMoney(issued))}</span>
                </div>
                <div class="apm-bar"><span style="width:${Math.min(100, pct)}%"></span></div>
                <div class="apm-money-legend">
                    <strong class="apm-ok">${paidCount} paid</strong>
                    <strong class="apm-alert">${owedRows.length} outstanding</strong>
                </div>
            </div>
        </section>` : `
        <section class="apm-card">
            <div class="apm-card-body">
                <div class="apm-eyebrow">Billable this month</div>
                <div class="apm-money-top"><span class="apm-money-big">${escHtml(apMoney(live.billed))}</span></div>
                <p class="apm-foot-note">No invoices have been sent yet, so nothing is owed. Accounts receivable ages from the day you send.</p>
                <div class="apm-acts">
                    <button type="button" class="apm-btn apm-btn-primary" data-ap-go="financeHub">Review and send</button>
                </div>
            </div>
        </section>`;

    const owes = owedRows.length ? `
        <section class="apm-card apm-card-gold">
            <header class="apm-card-head">
                <h3>Who owes</h3>
                <span class="apm-card-count">${escHtml(apMoney(owed))} across ${owedRows.length} famil${owedRows.length === 1 ? 'y' : 'ies'}</span>
            </header>
            <div class="apm-card-body">
                ${owedRows.slice(0, 3).map(r => `
                <div class="apm-owe">
                    <div class="apm-owe-main">
                        <div class="apm-owe-name">${escHtml(r.familyName)}</div>
                        <div class="apm-owe-note ${r.daysSince != null && r.daysSince >= 15 ? 'apm-alert' : 'apm-warn'}">${escHtml(apmOweNote(r))}</div>
                    </div>
                    <div class="apm-owe-amt">${escHtml(apMoney(r.outstanding))}</div>
                </div>`).join('')}
                <div class="apm-acts">
                    <button type="button" class="apm-btn apm-btn-primary" data-ap-go="financeHub">Send reminders</button>
                    ${owedRows.length > 3 ? `<button type="button" class="apm-btn apm-btn-ghost" data-ap-go="financeHub">See all ${owedRows.length}</button>` : ''}
                </div>
            </div>
        </section>` : '';

    return summary + owes + apmLatestPaymentHtml(rows);
}

function apmOweNote(r) {
    if (r.daysSince == null) return 'Invoice not sent yet';
    const days = `${r.daysSince} day${r.daysSince === 1 ? '' : 's'} since you sent it`;
    return r.status === 'partial' ? `${days} · part paid` : days;
}

function apmLatestPaymentHtml(rows) {
    let best = null;
    rows.forEach(r => (r.payments || []).forEach(p => {
        const when = p.paid_at || p.payment_date || p.created_at;
        if (!when) return;
        if (!best || new Date(when) > new Date(best.when)) best = { when, amount: p.amount, name: r.familyName };
    }));
    if (!best) return '';
    return `
        <section class="apm-note apm-note-ok">
            <span aria-hidden="true">💵</span>
            <div>
                <div class="apm-note-title">${escHtml(best.name)} paid ${escHtml(apMoney(best.amount))}</div>
                <div class="apm-note-sub">${escHtml(friendlyShort(String(best.when).slice(0, 10)))} · the most recent payment in</div>
            </div>
        </section>`;
}

// ── The escape hatch ─────────────────────────────────────────
// Planning, Staff, Market Analysis and Settings have no phone tab — the
// brief cut them. Cutting the tab is not the same as cutting the road: a
// director who needs one of these from a parking lot should be one tap
// away, not told to go home and open a laptop. They open their ordinary
// desktop dashboard, which is honest about what the phone is doing rather
// than pretending a phone screen exists for them. Printed at the foot of
// the four screens; the Inbox is a tool and carries no screen footer.
function apmMoreHtml() {
    const tabs = APM_MORE_TABS.filter(k => AP_TABS[k] && apTabAvailable(k));
    if (!tabs.length) return '';
    return `
        <details class="apm-more">
            <summary>More — built for a desktop</summary>
            <div class="apm-more-body">
                <p class="apm-foot-note">These still work on a phone, but they were designed for a wider screen.</p>
                ${tabs.map(k => `
                <button type="button" class="apm-row" data-ap-tab="${k}">
                    <span class="apm-row-main">
                        <span class="apm-row-title">${AP_TABS[k].icon} ${escHtml(AP_TABS[k].label)}</span>
                    </span>
                    <span class="apm-chevron" aria-hidden="true">›</span>
                </button>`).join('')}
            </div>
        </details>`;
}

// ── Wiring ───────────────────────────────────────────────────
function apmSetup() {
    apmLoadPrefs();

    // ⚠️ Registered before the shell's own delegated handler (apmSetup() is
    // called at the top of setupAdminPortal), which is what lets the
    // data-ap-tab branch below run BEFORE apGoTab() does — apState.mTab has
    // to be null by the time apRender() calls apmSyncState(), or the sync
    // pulls her straight back to the phone tab she just left.
    document.addEventListener('click', e => {
        const tab = e.target.closest('[data-apm-tab]');
        if (tab) { apmGoTab(tab.dataset.apmTab); return; }
        // A desktop-only tab from the escape hatch. Not handled here — the
        // shell's own handler still calls apGoTab() — only recorded, so the
        // tab bar lights nothing and the header offers the way back.
        if (apmActive() && e.target.closest('[data-ap-tab]')) { apState.mTab = null; return; }
        const chip = e.target.closest('[data-apm-fam-filter]');
        if (chip) {
            apmState.famFilter = chip.dataset.apmFamFilter;
            apmState.famQuery  = '';
            apRender();
            return;
        }
    });

    // Re-rendering only the list keeps the caret in the search box; a full
    // apRender() would rebuild the header and drop focus on every keystroke.
    document.addEventListener('input', e => {
        if (e.target.id !== 'apmFamSearch') return;
        apmState.famQuery = e.target.value;
        const list = document.getElementById('apmFamList');
        if (list && apState.live) list.innerHTML = apmFamilyListHtml(apState.live);
    });

    // Rotating a phone, or dragging a desktop window past 900px, changes
    // which shell owns navigation — render the other one rather than leaving
    // the page in the layout the old breakpoint built.
    if (window.matchMedia) {
        const mql = window.matchMedia(`(max-width: ${APM_BREAKPOINT}px)`);
        const onChange = () => { document.body.classList.toggle('apm-on', apmActive()); apRender(); };
        if (mql.addEventListener) mql.addEventListener('change', onChange);
        else if (mql.addListener) mql.addListener(onChange);
    }
    document.body.classList.toggle('apm-on', apmActive());
}
