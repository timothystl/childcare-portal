// ============================================================
// MODULE: Admin Waitlist (management, planning, import)
// Sections: Waitlist Management, Waitlist Planning Panel, Waitlist Import
// ============================================================

// WAITLIST MANAGEMENT (admin)
// ============================================================

// Derive room from a waitlist application record — age at desired_start_date,
// bucketed against the live ROOMS age ranges (admin-editable via Settings →
// Rates) via the shared calcAgeMonths()/roomIdForAgeMonths() in supabase.js,
// same logic every other room-assignment path in the app uses. Uses
// wlpRooms() (all non-summer rooms, including 'coming_soon' ones like a not-
// yet-open Goose Room) rather than getRoomIdFromDob()'s active-only list,
// since the Planner needs to bucket demand for rooms that aren't open yet.
function wlDeriveRoom(app) {
    const dobStr = app.child_dob || app.expected_due_date;
    if (!dobStr || !app.desired_start_date) return null;
    const start = new Date(app.desired_start_date + 'T00:00:00');
    const months = calcAgeMonths(dobStr, start);
    return roomIdForAgeMonths(months, wlpRooms());
}

function wlRoomLabel(roomId) {
    const map = { bear: '🐻 Bear', bee: '🐝 Bee', turtle: '🐢 Turtle', goose: '🪿 Goose', owl: '🦉 Owl' };
    return map[roomId] || '—';
}

function wlStatusBadge(app) {
    const today = new Date().toISOString().split('T')[0];
    if (app.status === 'offered' && app.offer_deadline && app.offer_deadline < today) {
        return '<span class="wl-badge wl-badge-expired">Offer Expired</span>';
    }
    const map = {
        pending:  '<span class="wl-badge wl-badge-pending">Pending</span>',
        offered:  '<span class="wl-badge wl-badge-offered">Spot Offered</span>',
        accepted: '<span class="wl-badge wl-badge-accepted">Accepted</span>',
        enrolled: '<span class="wl-badge wl-badge-enrolled">Enrolled</span>',
        declined: '<span class="wl-badge wl-badge-archived">Declined</span>',
        expired:  '<span class="wl-badge wl-badge-archived">Expired</span>',
        archived: '<span class="wl-badge wl-badge-archived">Archived</span>',
    };
    return map[app.status] || `<span class="wl-badge">${escHtml(app.status)}</span>`;
}

function wlFlexLabel(f) {
    return { exact: 'Exact date', within_month: 'Within a month', within_quarter: 'Within a few months', flexible: 'Very flexible' }[f] || f;
}

function wlTourBadge(app) {
    const status = app.tour_status || 'not_scheduled';
    if (status === 'completed') {
        return '<span class="wl-badge wl-badge-enrolled">✓ Toured</span>';
    }
    if (status === 'scheduled' && app.tour_scheduled_at) {
        const d = new Date(app.tour_scheduled_at);
        return `<span class="wl-badge wl-badge-offered">📅 ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>`;
    }
    return '<span class="wl-badge wl-badge-pending">Not Scheduled</span>';
}

function wlInterestTag(app) {
    if (!app.still_interested_confirmed_at) return '';
    const d = new Date(app.still_interested_confirmed_at);
    return `<br><span class="wl-sib-tag" title="Confirmed via reminder email">👍 confirmed ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>`;
}

// Human-readable "days needed" label — mirrors how an empty/null days_of_week
// is interpreted everywhere else in the planning logic (defaults to all 5).
function wlDaysLabel(app) {
    const days = (app.days_of_week || '').split(',').map(s => s.trim()).filter(Boolean);
    return days.length ? days.join(', ') : 'Any (M–F)';
}

function wlDaysWaiting(appliedAt) {
    const ms = Date.now() - new Date(appliedAt).getTime();
    const d  = Math.floor(ms / 86400000);
    if (d === 0) return 'today';
    if (d === 1) return '1 day ago';
    if (d < 7)   return `${d} days ago`;
    const w = Math.floor(d / 7);
    return w === 1 ? '1 week ago' : `${w} weeks ago`;
}

let _allWaitlistApps = [];
let _wlSortCol = 'start';   // 'pos'|'child'|'start'|'age'|'room'|'status'|'parent'|'waiting'
let _wlSortDir = 1;          // 1 = asc, -1 = desc

async function loadWaitlistApplications() {
    const root = document.getElementById('wlpRoot');
    if (root) root.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        _allWaitlistApps = await fetchWaitlistApplications();
        renderWaitlistPlanner();
    } catch (err) {
        if (root) root.innerHTML = `<p class="empty-hint">Error: ${escHtml(err.message)}</p>`;
    }
}

// ============================================================
// WAITLIST & CAPACITY PLANNER  (Queue / Grid / Board)
// ============================================================
// One priority-ordered capacity allocation drives all three views so they can
// never disagree — see wlpRunAllocation(). Reuses PROMOTION_CHAIN and
// _buildGraduationIndex() below (graduation events are domain knowledge
// already computed for the Enrollment Trends forecast — not something this
// tool should derive a second, possibly-divergent way).
//
// Render pattern matches the rest of this file: state → render function →
// container.innerHTML → re-attach listeners. The whole tool is rebuilt from
// scratch on every interaction (cheap: 5 rooms × dozens of kids × 12 months)
// EXCEPT the Queue search box, which gets a lighter partial re-render
// (wlpRerenderQueueRows) so typing doesn't steal focus from the input.

let _wlp = {
    activeTab: 'queue',       // 'queue' | 'capacity'
    capacityView: 'grid',     // 'grid' | 'board'
    selCellA: null,           // Grid: {roomId, monthIdx}
    expandedKidB: null,       // Queue: waitlist_applications.id
    selStripB: null,          // Queue: {kidId, monthIdx}
    archivingKidId: null,     // Queue: id whose inline archive-reason form is open
    boardMonthIdx: 0,         // Board: 0-11
    selSlotC: null,           // Board: {roomId, day}
    highlightKidC: null,      // Board: waitlist_applications.id
    search: '',
    roomFilter: '',
    toastText: null,
};
let _wlpAlloc = null; // last computed allocation — see wlpRunAllocation()

function wlpRooms() {
    return getSortedRooms().filter(r => r.id !== 'summer');
}

function wlpMonths() {
    const today = new Date();
    return Array.from({ length: 12 }, (_, i) => {
        const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
        return { idx: i, key: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`, label: `${MONTH_NAMES[d.getMonth()].slice(0, 3)} ${d.getFullYear()}` };
    });
}

// This week's Mon–Fri dates (YYYY-MM-DD) — the "today's real bookings"
// baseline for month 0 of the allocation.
function wlpCurrentWeekDates() {
    const today = new Date();
    const diffToMon = (today.getDay() + 6) % 7; // 0=Sun..6=Sat -> days since Monday
    const monday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - diffToMon);
    const out = {};
    TREND_DAYS.forEach((day, i) => {
        const d = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + i);
        out[day] = d.toLocaleDateString('en-CA'); // YYYY-MM-DD, local time
    });
    return out;
}

// { [roomId]: { Mon:count, ... } } — live bookings for this week, straight
// from the already-loaded allRegistrations (same source of truth
// _buildTrendMap() uses) — no separate query. Rooms grouped by the parent
// registration's room_id, matching _buildTrendMap()'s convention.
function wlpBaseBooked() {
    const weekDates = wlpCurrentWeekDates();
    const dateToDay = {};
    Object.entries(weekDates).forEach(([day, date]) => { dateToDay[date] = day; });

    const booked = {};
    wlpRooms().forEach(r => { booked[r.id] = { Mon: 0, Tue: 0, Wed: 0, Thu: 0, Fri: 0 }; });

    (allRegistrations || []).forEach(reg => {
        if (!booked[reg.room_id]) return;
        (reg.registration_dates || []).forEach(d => {
            if (d.waitlisted || !d.care_date) return;
            const day = dateToDay[d.care_date];
            if (day) booked[reg.room_id][day]++;
        });
    });
    return booked;
}

// Reuses _buildGraduationIndex() (below) as-is, reshaping its 'YYYY-MM'-keyed
// output into { [roomId]: { [monthIdx]: [{name, days}] } } for the 12-month
// window this tool plans against.
function wlpGradEvents(months) {
    const { gradOut, gradIn } = _buildGraduationIndex();
    const keyToIdx = {};
    months.forEach(m => { keyToIdx[m.key] = m.idx; });

    const out = {}, into = {};
    wlpRooms().forEach(r => { out[r.id] = {}; into[r.id] = {}; });

    Object.entries(gradOut).forEach(([moKey, byRoom]) => {
        const idx = keyToIdx[moKey];
        if (idx == null) return;
        Object.entries(byRoom).forEach(([roomId, kidsArr]) => {
            if (!out[roomId]) return;
            out[roomId][idx] = kidsArr.map(k => ({ name: k.childName, days: Object.keys(k.weekdays) }));
        });
    });
    Object.entries(gradIn).forEach(([moKey, byRoom]) => {
        const idx = keyToIdx[moKey];
        if (idx == null) return;
        Object.entries(byRoom).forEach(([roomId, kidsArr]) => {
            if (!into[roomId]) return;
            into[roomId][idx] = kidsArr.map(k => ({ name: k.childName, days: Object.keys(k.weekdays) }));
        });
    });
    return { gradOut: out, gradIn: into };
}

// Per-room, 12-month grid of open slots per weekday, BEFORE any waitlist
// seating — this week's live bookings carried forward through every known
// graduation (both the room a child leaves, which gains a slot, and the room
// they move into, which loses one).
//
// openDay is intentionally allowed to go NEGATIVE: if graduations moving in
// push a room's own already-enrolled kids past capacity, that's a real
// overbooking the admin needs to see and act on (move a kid, bump capacity,
// etc.) — flooring it at 0 would make "exactly full" and "3 over capacity"
// look identical. Only the waitlist-matching step downstream (which checks
// `>= 1` before seating anyone) treats negative the same as 0 — it just
// won't offer a spot there, which is correct either way.
function wlpComputeGradGrid(room, gradOutForRoom, gradInForRoom, baseBookedForRoom) {
    const cap = room.capacity ?? 0;
    const booked = { ...baseBookedForRoom };
    const grid = [];
    for (let m = 0; m < 12; m++) {
        (gradOutForRoom[m] || []).forEach(ev => ev.days.forEach(d => { booked[d] = Math.max(0, booked[d] - 1); }));
        (gradInForRoom[m] || []).forEach(ev => ev.days.forEach(d => { booked[d] = booked[d] + 1; }));
        const openDay = {};
        TREND_DAYS.forEach(d => { openDay[d] = cap - booked[d]; });
        grid.push(openDay);
    }
    return grid;
}

// Requested weekdays for a waitlist row — empty days_of_week defaults to all
// 5, same convention _buildWaitlistPriorityQueues() already uses.
function wlpAppDays(app) {
    const named = (app.days_of_week || '').split(',').map(s => s.trim()).filter(Boolean);
    return named.length ? named.filter(d => TREND_DAYS.includes(d)) : TREND_DAYS.slice();
}

// desired_start_date -> month index (0-11) within the planning window,
// clamped to the window (a past-due or far-future date lands on the nearest
// edge rather than being excluded).
function wlpDesiredMonthIdx(app) {
    if (!app.desired_start_date) return 0;
    const [y, m] = app.desired_start_date.split('-').map(Number);
    const today = new Date();
    const diff = (y - today.getFullYear()) * 12 + (m - 1 - today.getMonth());
    return Math.max(0, Math.min(11, diff));
}

// Sibling-priority first, then longest-waiting first — the single ordering
// every view in this tool uses (matches the app's existing convention).
function wlpSortByPriority(list) {
    return list.slice().sort((a, b) => {
        const sibA = a.sibling ? 0 : 1, sibB = b.sibling ? 0 : 1;
        if (sibA !== sibB) return sibA - sibB;
        return new Date(a.appliedAt) - new Date(b.appliedAt);
    });
}

function wlpDayChips(kid, dayMap) {
    return TREND_DAYS.map(d => {
        if (!kid.days.includes(d)) return { day: d, cls: 'wlp-chip-off' };
        return dayMap[d] >= 1 ? { day: d, cls: 'wlp-chip-open' } : { day: d, cls: 'wlp-chip-full' };
    });
}
function wlpChipHtml(c) { return `<span class="wlp-chip ${c.cls}">${c.day}</span>`; }
function wlpDayTypeTag(k) { return k.dayType === 'half' ? ' <span class="wlp-row-room">(half day)</span>' : ''; }
function wlpPriorityLabel(k) { return k.sibling ? '👨‍👩‍👧 Sibling priority' : 'Standard priority'; }

function wlpAvailClass(open, capacity) {
    const cap = capacity || 0;
    const frac = cap > 0 ? open / cap : 0;
    if (open < 0) return 'wlp-avail-over';
    if (open === 0) return 'wlp-avail-red';
    if (frac < 0.2) return 'wlp-avail-amber';
    return 'wlp-avail-green';
}

// Every graduation-out and waitlist-start event for one room across the
// 12-month window, in month order — the "who's moving" narrative. Only the
// leaving side is ever narrated as a card (matches the design); the arriving
// side's capacity is still applied under the hood by wlpComputeGradGrid().
function wlpMovementEvents(roomId, alloc) {
    const nextId = PROMOTION_CHAIN[roomId]?.nextRoom;
    const nextLabel = nextId ? alloc.roomMeta[nextId]?.room.label.replace(/^\S+\s/, '') : null;
    const out = [];
    alloc.months.forEach(mo => {
        (alloc.gradOut[roomId][mo.idx] || []).forEach(ev => {
            out.push({
                monthLabel: mo.label, name: ev.name, days: ev.days,
                iconCls: 'wlp-event-icon-grad', icon: '↑',
                actionLabel: nextId ? `moves up to ${nextLabel}` : 'graduates the program',
            });
        });
        (alloc.incoming[roomId][mo.idx] || []).forEach(k => {
            out.push(k.promised
                ? { monthLabel: mo.label, name: k.name, days: k.days, iconCls: 'wlp-event-icon-promised', icon: '🎯', actionLabel: 'promised a spot (offer accepted)' }
                : { monthLabel: mo.label, name: k.name, days: k.days, iconCls: 'wlp-event-icon-start', icon: '+', actionLabel: 'starts from the waitlist' });
        });
    });
    return out;
}

function wlpEventChipClass(iconCls) {
    if (iconCls === 'wlp-event-icon-grad') return 'wlp-chip-grad';
    if (iconCls === 'wlp-event-icon-promised') return 'wlp-chip-promised';
    return 'wlp-chip-start';
}
function wlpEventCardHtml(ev) {
    const chips = TREND_DAYS.map(d => ev.days.includes(d)
        ? `<span class="wlp-chip ${wlpEventChipClass(ev.iconCls)}">${d}</span>`
        : `<span class="wlp-chip wlp-chip-off">${d}</span>`).join('');
    return `
        <div class="wlp-event-card">
            <div class="wlp-event-icon ${ev.iconCls}">${ev.icon}</div>
            <div class="wlp-event-body">
                <div class="wlp-event-top"><span class="wlp-event-name">${escHtml(ev.name)}</span><span class="wlp-event-month">${escHtml(ev.monthLabel)}</span></div>
                <div class="wlp-event-action">${escHtml(ev.actionLabel)}</div>
                <div class="wlp-chip-row" style="margin:0">${chips}</div>
            </div>
        </div>`;
}

// Compact one-line note (Board view — not the card format Grid uses).
function wlpBoardNoteFor(roomId, monthIdx, alloc) {
    const grads = alloc.gradOut[roomId][monthIdx] || [];
    const incoming = alloc.incoming[roomId][monthIdx] || [];
    const parts = [];
    if (grads.length) {
        const nextId = PROMOTION_CHAIN[roomId]?.nextRoom;
        const nextLabel = nextId ? alloc.roomMeta[nextId]?.room.label.replace(/^\S+\s/, '') : 'graduates the program';
        parts.push(grads.map(g => `↑ ${g.name} → ${nextLabel} (${g.days.join(',')})`).join('; '));
    }
    if (incoming.length) parts.push(incoming.map(k => `+ ${k.name} starts (${k.days.join(',')})`).join('; '));
    if (!parts.length) return null;
    return { text: parts.join(' · '), color: grads.length ? 'var(--wlp-grad-fg)' : 'var(--wlp-start-fg)' };
}

// ── Core allocation ──────────────────────────────────────────
// Recomputed from scratch on every render — see the header comment above for
// why (cheap, and guarantees the three views can never disagree).
function wlpRunAllocation() {
    const rooms = wlpRooms();
    const months = wlpMonths();
    const baseBooked = wlpBaseBooked();
    const { gradOut, gradIn } = wlpGradEvents(months);

    const roomMeta = {};
    rooms.forEach(r => {
        roomMeta[r.id] = { room: r, gradGrid: wlpComputeGradGrid(r, gradOut[r.id], gradIn[r.id], baseBooked[r.id]) };
    });

    const activeApps = (_allWaitlistApps || []).filter(a => ['pending', 'offered', 'accepted'].includes(a.status));
    const kids = activeApps.map(a => {
        // 'accepted' = admin offered a spot and the family said yes — a real
        // commitment, not a queue position. Reserve exactly what was offered
        // (offered_days, for a partial offer) rather than the original full
        // request, when that's on record.
        const promised = a.status === 'accepted';
        const offeredDays = (a.offered_days || '').split(',').map(s => s.trim()).filter(Boolean);
        return {
            app: a,
            id: a.id,
            name: a.child_name,
            room: wlDeriveRoom(a),
            days: (promised && offeredDays.length) ? offeredDays.filter(d => TREND_DAYS.includes(d)) : wlpAppDays(a),
            desiredStartM: wlpDesiredMonthIdx(a),
            sibling: !!a.has_sibling,
            appliedAt: a.applied_at,
            dayType: a.day_type === 'half' ? 'half' : 'full',
            parentName: a.parent_name,
            parentEmail: a.parent_email,
            promised,
        };
    }).filter(k => k.room && roomMeta[k.room]);

    const working = {};
    rooms.forEach(r => { working[r.id] = roomMeta[r.id].gradGrid.map(day => ({ ...day })); });

    // Promised kids are seated FIRST and unconditionally — same treatment as
    // a graduation event, not a queue candidate. A real commitment reserves
    // its seat regardless of remaining capacity or priority order; if that
    // pushes a room negative, that's exactly the "we've promised more spots
    // than we have" signal the grid should surface (see wlpComputeGradGrid).
    const preGridByKid = {}, fitMonthByKid = {};
    rooms.forEach(r => {
        kids.filter(k => k.room === r.id && k.promised).forEach(k => {
            preGridByKid[k.id] = working[r.id].map(day => ({ ...day }));
            fitMonthByKid[k.id] = k.desiredStartM;
            for (let mm = k.desiredStartM; mm < 12; mm++) {
                k.days.forEach(d => { working[r.id][mm][d] -= 1; });
            }
        });
    });

    // Everyone else (pending / offered-but-not-yet-accepted) still competes
    // for whatever capacity is left, in priority order, same as before.
    rooms.forEach(r => {
        const roomKids = wlpSortByPriority(kids.filter(k => k.room === r.id && !k.promised));
        roomKids.forEach(k => {
            const preGrid = working[r.id].map(day => ({ ...day }));
            preGridByKid[k.id] = preGrid;
            let fitMonth = null;
            for (let m = k.desiredStartM; m < 12; m++) {
                if (k.days.every(d => preGrid[m][d] >= 1)) { fitMonth = m; break; }
            }
            fitMonthByKid[k.id] = fitMonth;
            if (fitMonth !== null) {
                for (let mm = fitMonth; mm < 12; mm++) {
                    k.days.forEach(d => { working[r.id][mm][d] = Math.max(0, working[r.id][mm][d] - 1); });
                }
            }
        });
    });

    const incoming = {};
    rooms.forEach(r => { incoming[r.id] = {}; });
    kids.forEach(k => {
        const fm = fitMonthByKid[k.id];
        if (fm != null) {
            if (!incoming[k.room][fm]) incoming[k.room][fm] = [];
            incoming[k.room][fm].push(k);
        }
    });

    return { rooms, months, roomMeta, finalGrid: working, kids, preGridByKid, fitMonthByKid, incoming, gradOut, gradIn };
}

// ── Top-level render ─────────────────────────────────────────
function renderWaitlistPlanner() {
    const root = document.getElementById('wlpRoot');
    if (!root) return;
    const alloc = wlpRunAllocation();
    _wlpAlloc = alloc;

    const isQueue = _wlp.activeTab === 'queue';
    const isCapacity = _wlp.activeTab === 'capacity';
    const isGrid = isCapacity && _wlp.capacityView === 'grid';
    const isBoard = isCapacity && _wlp.capacityView === 'board';

    root.innerHTML = `
        <div class="wlp-card">
            ${wlpRenderHeader()}
            ${isCapacity ? wlpRenderToolbar(alloc) : ''}
            ${isQueue ? wlpRenderQueue(alloc) : ''}
            ${isGrid ? wlpRenderGrid(alloc) : ''}
            ${isBoard ? wlpRenderBoard(alloc) : ''}
        </div>`;

    wlpAttachHeaderListeners();
    if (isQueue) wlpAttachQueueListeners();
    if (isGrid) wlpAttachGridListeners();
    if (isBoard) wlpAttachBoardListeners();
}

function wlpRenderHeader() {
    const isQueue = _wlp.activeTab === 'queue';
    const sub = isQueue
        ? "Every waitlisted child, ranked by priority — expand any row for their 12-month outlook."
        : (_wlp.capacityView === 'grid'
            ? 'Open slots per room, 12 months out — click a month to see who fits.'
            : 'One month at a time — click an open slot to see who to offer it to.');
    return `
        <div class="wlp-header">
            <div>
                <div class="wlp-header-title">Waitlist &amp; Capacity Planner</div>
                <div class="wlp-header-sub">${escHtml(sub)}</div>
            </div>
            <div class="wlp-header-actions">
                <div class="wlp-pill-group">
                    <button type="button" class="wlp-pill-btn ${isQueue ? 'active' : ''}" data-wlp-tab="queue">Waitlist Queue</button>
                    <button type="button" class="wlp-pill-btn ${!isQueue ? 'active' : ''}" data-wlp-tab="capacity">Capacity Planner</button>
                </div>
                <button type="button" class="btn-secondary" id="wlpAddBtn">+ Add to Waitlist</button>
            </div>
        </div>`;
}

function wlpRenderToolbar(alloc) {
    const isGrid = _wlp.capacityView === 'grid';
    const mi = _wlp.boardMonthIdx;
    return `
        <div class="wlp-toolbar">
            <div class="wlp-pill-group">
                <button type="button" class="wlp-pill-btn ${isGrid ? 'active' : ''}" data-wlp-view="grid">📅 Grid — 12 months</button>
                <button type="button" class="wlp-pill-btn ${!isGrid ? 'active' : ''}" data-wlp-view="board">🎯 Board — 1 month, match &amp; assign</button>
            </div>
            ${!isGrid ? `
            <div class="wlp-month-nav">
                <button type="button" class="wlp-month-nav-btn" id="wlpPrevMonth" ${mi === 0 ? 'disabled' : ''}>‹</button>
                <span class="wlp-month-nav-label">${escHtml(alloc.months[mi].label)}</span>
                <button type="button" class="wlp-month-nav-btn" id="wlpNextMonth" ${mi === 11 ? 'disabled' : ''}>›</button>
            </div>` : ''}
        </div>`;
}

function wlpAttachHeaderListeners() {
    document.querySelectorAll('[data-wlp-tab]').forEach(btn => {
        btn.addEventListener('click', () => { _wlp.activeTab = btn.dataset.wlpTab; renderWaitlistPlanner(); });
    });
    document.querySelectorAll('[data-wlp-view]').forEach(btn => {
        btn.addEventListener('click', () => { _wlp.capacityView = btn.dataset.wlpView; renderWaitlistPlanner(); });
    });
    document.getElementById('wlpAddBtn')?.addEventListener('click', _openAdminWlModal);
    document.getElementById('wlpPrevMonth')?.addEventListener('click', () => {
        _wlp.boardMonthIdx = Math.max(0, _wlp.boardMonthIdx - 1);
        _wlp.selSlotC = null; _wlp.highlightKidC = null;
        renderWaitlistPlanner();
    });
    document.getElementById('wlpNextMonth')?.addEventListener('click', () => {
        _wlp.boardMonthIdx = Math.min(11, _wlp.boardMonthIdx + 1);
        _wlp.selSlotC = null; _wlp.highlightKidC = null;
        renderWaitlistPlanner();
    });
}

// ── Queue view ───────────────────────────────────────────────
function wlpQueueFilteredKids(alloc) {
    const search = _wlp.search.toLowerCase().trim();
    const roomFilter = _wlp.roomFilter;
    let kids = wlpSortByPriority(alloc.kids);
    kids.forEach((k, i) => { k._pos = i + 1; }); // true priority position, before filtering
    if (roomFilter) kids = kids.filter(k => k.room === roomFilter);
    if (search) {
        kids = kids.filter(k =>
            k.name.toLowerCase().includes(search) ||
            (k.parentName || '').toLowerCase().includes(search) ||
            (k.parentEmail || '').toLowerCase().includes(search));
    }
    return kids;
}

function wlpRenderQueue(alloc) {
    const kids = wlpQueueFilteredKids(alloc);
    const roomOptions = alloc.rooms.map(r => `<option value="${r.id}" ${_wlp.roomFilter === r.id ? 'selected' : ''}>${escHtml(r.label)}</option>`).join('');
    return `
        <div>
            <div class="wlp-filter-bar">
                <input type="search" id="wlpSearch" class="family-search-input" placeholder="Search by child or parent name…" value="${escHtml(_wlp.search)}" style="min-width:220px">
                <select id="wlpRoomFilterSel" class="family-search-input" style="width:auto;">
                    <option value="">All Rooms</option>
                    ${roomOptions}
                </select>
                <span class="rates-status" id="wlpQueueCount">${kids.length} on the waitlist</span>
            </div>
            <div class="wlp-queue-hint">Day chips show their exact request at desired start: green = open, red = taken, dim = not requested. Click a month in the strip for that month's breakdown.</div>
            <div id="wlpQueueRows">${wlpQueueRowsHtml(kids, alloc)}</div>
            ${_wlp.toastText ? `<div class="wlp-toast">${escHtml(_wlp.toastText)}</div>` : ''}
        </div>`;
}

function wlpQueueRowsHtml(kids, alloc) {
    return kids.map(k => wlpRenderQueueRow(k, alloc)).join('') || '<p class="empty-hint">No applications match the current filter.</p>';
}

function wlpRenderQueueRow(k, alloc) {
    const preGrid = alloc.preGridByKid[k.id];
    const fitM = alloc.fitMonthByKid[k.id];
    const fitNow = fitM === k.desiredStartM;
    let fitCls, fitLabel;
    if (k.promised) { fitCls = 'wlp-status-promised'; fitLabel = '🎯 Promised'; }
    else if (fitM === null) { fitCls = 'wlp-status-red'; fitLabel = 'No fit in 12 mo'; }
    else if (fitNow) { fitCls = 'wlp-status-green'; fitLabel = 'Fits now'; }
    else { fitCls = 'wlp-status-amber'; fitLabel = `Fits ${alloc.months[fitM].label}`; }

    const startDayMap = preGrid[k.desiredStartM];
    const chips = wlpDayChips(k, startDayMap).map(wlpChipHtml).join('');
    const expanded = _wlp.expandedKidB === k.id;
    const room = alloc.roomMeta[k.room].room;

    return `
        <div class="wlp-row" data-kid-id="${k.id}">
            <div class="wlp-row-main" data-wlp-toggle="${k.id}">
                <div class="wlp-pos ${k.sibling ? 'wlp-pos-sib' : 'wlp-pos-std'}">${k._pos}</div>
                <div class="wlp-row-body">
                    <div class="wlp-row-name">${escHtml(k.name)}${wlpDayTypeTag(k)} <span class="wlp-row-room">· ${escHtml(room.label.replace(/^\S+\s/, ''))}</span></div>
                    <div class="wlp-chip-row">${chips}</div>
                    <div class="wlp-row-meta">${k.sibling ? '👨‍👩‍👧 sibling · ' : ''}waiting ${escHtml(wlDaysWaiting(k.appliedAt))} · desired start ${escHtml(alloc.months[k.desiredStartM].label)}</div>
                </div>
                <div class="wlp-status-pill ${fitCls}">${fitLabel}</div>
                <button type="button" class="wlp-edit-btn" data-wlp-edit="${k.id}" title="Edit child">✎ Edit</button>
                <div class="wlp-chevron">${expanded ? '▲' : '▼'}</div>
            </div>
            ${expanded ? wlpRenderQueueExpand(k, alloc) : ''}
        </div>`;
}

function wlpRenderQueueExpand(k, alloc) {
    const preGrid = alloc.preGridByKid[k.id];
    const stripSel = _wlp.selStripB;
    const stripTiles = alloc.months.map(mo => {
        const dayMap = preGrid[mo.idx];
        const before = mo.idx < k.desiredStartM;
        let cls = 'wlp-strip-before', sub = '—';
        if (!before) {
            const all = k.days.every(d => dayMap[d] >= 1);
            const some = k.days.some(d => dayMap[d] >= 1);
            if (all) { cls = 'wlp-strip-fits'; sub = 'fits'; }
            else if (some) { cls = 'wlp-strip-partial'; sub = 'partial'; }
            else { cls = 'wlp-strip-full'; sub = 'full'; }
        }
        const isSel = stripSel && stripSel.kidId === k.id && stripSel.monthIdx === mo.idx;
        return `<div class="wlp-month-tile ${cls} ${isSel ? 'selected' : ''}" data-wlp-strip="${k.id}:${mo.idx}" title="${escHtml(mo.label)}${before ? ' (before desired start)' : ''}">
            <div class="wlp-month-tile-label">${mo.label.split(' ')[0]}</div>
            <div class="wlp-month-tile-sub">${sub}</div>
        </div>`;
    }).join('');

    let stripDetail = '';
    if (stripSel && stripSel.kidId === k.id) {
        const chips = wlpDayChips(k, preGrid[stripSel.monthIdx]).map(wlpChipHtml).join('');
        stripDetail = `<div class="wlp-strip-detail"><span class="wlp-strip-detail-label">${escHtml(alloc.months[stripSel.monthIdx].label)}:</span><div class="wlp-chip-row" style="margin:0">${chips}</div></div>`;
    }

    const startDayMap = preGrid[k.desiredStartM];
    const avail = k.days.filter(d => startDayMap[d] >= 1);
    const missing = k.days.filter(d => !avail.includes(d));
    const hasPartial = avail.length > 0 && missing.length > 0;
    const fitM = alloc.fitMonthByKid[k.id];
    const fitNow = fitM === k.desiredStartM;

    return `
        <div class="wlp-expand">
            <div class="wlp-month-strip">${stripTiles}</div>
            ${stripDetail}
            <div class="wlp-expand-footer">
                <div class="wlp-parent-line">${escHtml(k.parentName)} · ${escHtml(k.parentEmail)}</div>
                <div class="wlp-offer-actions">
                    ${hasPartial ? `<button type="button" class="wlp-btn-partial-offer" data-wlp-partial-offer="${k.id}">Offer ${avail.length} of ${k.days.length} days (${escHtml(avail.join(', '))})</button>` : ''}
                    <button type="button" class="wlp-btn-offer" data-wlp-offer="${k.id}" ${!fitNow ? 'disabled' : ''}>${fitNow ? '🎉 Offer a Spot' : 'Not open yet'}</button>
                </div>
            </div>
            ${wlpRenderSecondaryActions(k)}
        </div>`;
}

function wlpRenderSecondaryActions(k) {
    const app = k.app;
    if (_wlp.archivingKidId === k.id) {
        return `
            <div class="wlp-secondary-actions">
                <span style="font-size:11px;color:var(--text-muted)">Archive reason:</span>
                <select id="wlpArchiveReason" style="font-size:11px;padding:3px 6px;">
                    <option value="declined">Family declined</option>
                    <option value="no_response">No response to offer</option>
                    <option value="enrolled_elsewhere">Enrolled elsewhere</option>
                    <option value="other">Other</option>
                </select>
                <button type="button" class="btn-warning" data-wlp-archive-confirm="${k.id}">Archive</button>
                <button type="button" class="btn-ghost" data-wlp-archive-cancel="${k.id}">Cancel</button>
            </div>`;
    }
    const tourStatus = app.tour_status || 'not_scheduled';
    const tourBtn = tourStatus === 'not_scheduled'
        ? `<button type="button" class="btn-ghost" data-wlp-tour="${k.id}">📅 Schedule Tour</button>`
        : tourStatus === 'scheduled'
            ? `<button type="button" class="btn-ghost" data-wlp-tour-complete="${k.id}">✓ Mark Toured</button>`
            : `<span class="wl-badge wl-badge-enrolled">✓ Toured</span>`;
    const acceptBtn = app.status === 'offered' ? `<button type="button" class="btn-ghost" data-wlp-accept="${k.id}">✓ Mark Accepted</button>` : '';
    const enrollBtn = app.status === 'accepted' ? `<button type="button" class="btn-ghost" data-wlp-enroll="${k.id}">✓ Mark Enrolled</button>` : '';
    return `
        <div class="wlp-secondary-actions">
            ${tourBtn}
            ${acceptBtn}
            ${enrollBtn}
            <button type="button" class="btn-ghost" data-wlp-archive="${k.id}">Archive ▾</button>
            <button type="button" class="btn-danger" data-wlp-delete="${k.id}" data-child="${escHtml(k.name)}">🗑 Delete</button>
        </div>`;
}

// Lightweight re-render — swaps only the rows list (and count), leaving the
// search input untouched so typing doesn't lose focus.
function wlpRerenderQueueRows() {
    const alloc = _wlpAlloc;
    if (!alloc) return;
    const kids = wlpQueueFilteredKids(alloc);
    const rowsEl = document.getElementById('wlpQueueRows');
    const countEl = document.getElementById('wlpQueueCount');
    if (countEl) countEl.textContent = `${kids.length} on the waitlist`;
    if (rowsEl) rowsEl.innerHTML = wlpQueueRowsHtml(kids, alloc);
    wlpWireQueueRowActions();
}

function wlpAttachQueueListeners() {
    const searchEl = document.getElementById('wlpSearch');
    searchEl?.addEventListener('input', () => { _wlp.search = searchEl.value; wlpRerenderQueueRows(); });
    document.getElementById('wlpRoomFilterSel')?.addEventListener('change', e => { _wlp.roomFilter = e.target.value; wlpRerenderQueueRows(); });
    wlpWireQueueRowActions();
}

function wlpWireQueueRowActions() {
    document.querySelectorAll('[data-wlp-toggle]').forEach(el => {
        el.addEventListener('click', () => {
            const id = Number(el.dataset.wlpToggle);
            _wlp.expandedKidB = _wlp.expandedKidB === id ? null : id;
            _wlp.selStripB = null;
            _wlp.archivingKidId = null;
            wlpRerenderQueueRows();
        });
    });
    document.querySelectorAll('[data-wlp-strip]').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            const [kidId, monthIdx] = el.dataset.wlpStrip.split(':').map(Number);
            const cur = _wlp.selStripB;
            _wlp.selStripB = (cur && cur.kidId === kidId && cur.monthIdx === monthIdx) ? null : { kidId, monthIdx };
            wlpRerenderQueueRows();
        });
    });
    document.querySelectorAll('[data-wlp-edit]').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            const app = _allWaitlistApps.find(a => a.id === Number(el.dataset.wlpEdit));
            if (app) _openAdminWlModalForEdit(app);
        });
    });
    document.querySelectorAll('[data-wlp-offer]').forEach(el => {
        el.addEventListener('click', e => {
            e.stopPropagation();
            if (el.disabled) return;
            wlpOpenOfferModal(Number(el.dataset.wlpOffer), 'full');
        });
    });
    document.querySelectorAll('[data-wlp-partial-offer]').forEach(el => {
        el.addEventListener('click', e => { e.stopPropagation(); wlpOpenOfferModal(Number(el.dataset.wlpPartialOffer), 'partial'); });
    });
    document.querySelectorAll('[data-wlp-tour]').forEach(el => {
        el.addEventListener('click', e => { e.stopPropagation(); wlpOpenTourModal(Number(el.dataset.wlpTour)); });
    });
    document.querySelectorAll('[data-wlp-tour-complete]').forEach(el => {
        el.addEventListener('click', async e => {
            e.stopPropagation();
            const id = Number(el.dataset.wlpTourComplete);
            el.disabled = true;
            try {
                await updateWaitlistTourStatus(id, { tour_status: 'completed', tour_completed_at: new Date().toISOString() });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) { app.tour_status = 'completed'; app.tour_completed_at = new Date().toISOString(); }
                renderWaitlistPlanner();
            } catch (err) { alert('Error: ' + err.message); el.disabled = false; }
        });
    });
    document.querySelectorAll('[data-wlp-accept]').forEach(el => {
        el.addEventListener('click', async e => {
            e.stopPropagation();
            const id = Number(el.dataset.wlpAccept);
            el.disabled = true;
            try {
                await updateWaitlistApplication(id, { status: 'accepted' });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) app.status = 'accepted';
                renderWaitlistPlanner();
            } catch (err) { alert('Error: ' + err.message); el.disabled = false; }
        });
    });
    document.querySelectorAll('[data-wlp-enroll]').forEach(el => {
        el.addEventListener('click', async e => {
            e.stopPropagation();
            const id = Number(el.dataset.wlpEnroll);
            el.disabled = true;
            try {
                await updateWaitlistApplication(id, { status: 'enrolled' });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) app.status = 'enrolled';
                renderWaitlistPlanner();
            } catch (err) { alert('Error: ' + err.message); el.disabled = false; }
        });
    });
    document.querySelectorAll('[data-wlp-archive]').forEach(el => {
        el.addEventListener('click', e => { e.stopPropagation(); _wlp.archivingKidId = Number(el.dataset.wlpArchive); wlpRerenderQueueRows(); });
    });
    document.querySelectorAll('[data-wlp-archive-cancel]').forEach(el => {
        el.addEventListener('click', e => { e.stopPropagation(); _wlp.archivingKidId = null; wlpRerenderQueueRows(); });
    });
    document.querySelectorAll('[data-wlp-archive-confirm]').forEach(el => {
        el.addEventListener('click', async e => {
            e.stopPropagation();
            const id = Number(el.dataset.wlpArchiveConfirm);
            const reason = document.getElementById('wlpArchiveReason')?.value || 'other';
            el.disabled = true;
            try {
                await updateWaitlistApplication(id, { status: 'archived', archive_reason: reason, archived_at: new Date().toISOString() });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) { app.status = 'archived'; app.archive_reason = reason; }
                _wlp.archivingKidId = null;
                renderWaitlistPlanner();
            } catch (err) { alert('Error: ' + err.message); el.disabled = false; }
        });
    });
    document.querySelectorAll('[data-wlp-delete]').forEach(el => {
        el.addEventListener('click', async e => {
            e.stopPropagation();
            const id = Number(el.dataset.wlpDelete);
            const child = el.dataset.child || 'this entry';
            if (!confirm(`Permanently remove ${child} from the waitlist? This cannot be undone.`)) return;
            el.disabled = true;
            try {
                await deleteWaitlistApplication(id);
                _allWaitlistApps = _allWaitlistApps.filter(a => a.id !== id);
                renderWaitlistPlanner();
            } catch (err) { alert('Error: ' + err.message); el.disabled = false; }
        });
    });
}

// ── Capacity Planner — Grid view ────────────────────────────
function wlpRenderGrid(alloc) {
    const movementCols = alloc.rooms.map(room => ({ room, events: wlpMovementEvents(room.id, alloc) })).filter(x => x.events.length);
    const movementHtml = movementCols.map(({ room, events }) => `
        <div style="min-width:0;">
            <div class="wlp-movement-col-title">${escHtml(room.label)}</div>
            <div class="wlp-movement-events">${events.map(wlpEventCardHtml).join('')}</div>
        </div>`).join('');

    const monthHeads = alloc.months.map(m => `<th class="wlp-month-head">${escHtml(m.label)}</th>`).join('');
    const roomRows = alloc.rooms.map(room => {
        const cells = alloc.months.map(mo => {
            const dayMap = alloc.finalGrid[room.id][mo.idx];
            const sel = _wlp.selCellA;
            const isSel = sel && sel.roomId === room.id && sel.monthIdx === mo.idx;
            const chips = TREND_DAYS.map(d => {
                const open = dayMap[d];
                const desc = open < 0
                    ? `${-open} OVER capacity — ${escHtml(d)}, ${escHtml(mo.label)}`
                    : `${open} open seat${open === 1 ? '' : 's'} — ${escHtml(d)}, ${escHtml(mo.label)}`;
                return `<div class="wlp-cap-chip ${wlpAvailClass(open, room.capacity)}" title="${desc}"><div class="wlp-cap-chip-day">${d}</div><div class="wlp-cap-chip-open">${open}</div></div>`;
            }).join('');
            return `<td class="wlp-month-cell ${isSel ? 'selected' : ''}" data-wlp-cell="${room.id}:${mo.idx}"><div class="wlp-cap-chip-row">${chips}</div></td>`;
        }).join('');
        return `<tr><td class="wlp-room-cell">${escHtml(room.label)}<br><span class="wlp-room-cell-cap">Cap ${room.capacity ?? '—'}/day</span></td>${cells}</tr>`;
    }).join('');

    let matchPanel = '';
    if (_wlp.selCellA) {
        const { roomId, monthIdx } = _wlp.selCellA;
        const room = alloc.roomMeta[roomId].room;
        const candidates = alloc.kids.filter(k => k.room === roomId && k.desiredStartM <= monthIdx);
        const ranked = wlpSortByPriority(candidates);
        const matchesHtml = ranked.map((k, i) => {
            const dayMap = alloc.preGridByKid[k.id][monthIdx];
            const allFit = k.days.every(d => dayMap[d] >= 1);
            const someFit = k.days.some(d => dayMap[d] >= 1);
            const status = allFit ? { label: 'Fits now', cls: 'wlp-status-green' }
                : someFit ? { label: 'Partial fit', cls: 'wlp-status-amber' }
                : { label: 'No room', cls: 'wlp-status-red' };
            const fm = alloc.fitMonthByKid[k.id];
            const seatedNote = fm == null ? 'no fit found in the 12-month window'
                : fm === monthIdx ? 'this is their turn in queue order'
                : `queue turn: ${alloc.months[fm].label}`;
            const chips = wlpDayChips(k, dayMap).map(wlpChipHtml).join('');
            return `
                <div class="wlp-match-card">
                    <div class="wlp-match-rank ${allFit ? 'wlp-match-rank-fit' : 'wlp-match-rank-nofit'}">${i + 1}</div>
                    <div class="wlp-match-body">
                        <div class="wlp-match-top">
                            <span class="wlp-match-name">${escHtml(k.name)}${wlpDayTypeTag(k)}</span>
                            <span class="wlp-status-pill ${status.cls}">${status.label}</span>
                        </div>
                        <div class="wlp-chip-row">${chips}</div>
                        <div class="wlp-match-note">${wlpPriorityLabel(k)} · waiting ${escHtml(wlDaysWaiting(k.appliedAt))} · ${escHtml(seatedNote)}</div>
                    </div>
                </div>`;
        }).join('');
        matchPanel = `
            <div class="wlp-match-panel">
                <div class="wlp-match-head">
                    <div class="wlp-match-title">${escHtml(room.label)} · ${escHtml(alloc.months[monthIdx].label)} — who fits?</div>
                    <button type="button" class="wlp-match-close" id="wlpMatchClose">✕ close</button>
                </div>
                ${ranked.length ? `<div class="wlp-match-list">${matchesHtml}</div>` : '<div class="wlp-empty-note">No one on the waitlist is asking for this room.</div>'}
            </div>`;
    }

    return `
        <div class="wlp-grid-panel">
            <div class="wlp-section-label">Open seats per weekday — next 12 months</div>
            <div class="wlp-section-hint">Number shown = unfilled seats that day, after known graduations and already-matched waitlist admits (not enrolled headcount, not waitlist demand). A negative number (dark red) means already-enrolled kids overbook that room that month — before any waitlist offers. Click a month to see who fits.</div>
            <div style="overflow-x:auto;">
                <table class="wlp-cap-table">
                    <thead><tr><th class="wlp-room-head">Room</th>${monthHeads}</tr></thead>
                    <tbody>${roomRows}</tbody>
                </table>
            </div>
        </div>
        ${matchPanel}
        <div class="wlp-movement-panel">
            <div class="wlp-section-label">Who's moving — next 12 months</div>
            <div class="wlp-section-hint">↑ graduating up to the next room · 🎯 promised a spot (offer accepted, reserved regardless of capacity) · + projected to start from the waitlist (simulated, not guaranteed)</div>
            <div class="wlp-movement-grid">${movementHtml || '<div class="wlp-empty-note">No graduations or waitlist starts in the next 12 months.</div>'}</div>
        </div>`;
}

function wlpAttachGridListeners() {
    document.querySelectorAll('[data-wlp-cell]').forEach(el => {
        el.addEventListener('click', () => {
            const [roomId, monthIdx] = el.dataset.wlpCell.split(':');
            _wlp.selCellA = { roomId, monthIdx: Number(monthIdx) };
            renderWaitlistPlanner();
        });
    });
    document.getElementById('wlpMatchClose')?.addEventListener('click', () => { _wlp.selCellA = null; renderWaitlistPlanner(); });
}

// ── Capacity Planner — Board view ───────────────────────────
function wlpRenderBoard(alloc) {
    const mi = _wlp.boardMonthIdx;
    const sel = _wlp.selSlotC;
    const hlKid = _wlp.highlightKidC != null ? alloc.kids.find(k => k.id === _wlp.highlightKidC) : null;

    const roomsHtml = alloc.rooms.map(room => {
        const note = wlpBoardNoteFor(room.id, mi, alloc);
        const slots = TREND_DAYS.map(d => {
            const open = alloc.finalGrid[room.id][mi][d];
            const availCls = wlpAvailClass(open, room.capacity);
            const isSel = sel && sel.roomId === room.id && sel.day === d;
            const isHl = hlKid && hlKid.room === room.id && hlKid.days.includes(d);
            return `<div class="wlp-slot ${availCls} ${isSel ? 'selected' : ''} ${isHl && !isSel ? 'highlight' : ''}" data-wlp-slot="${room.id}:${d}">
                <div class="wlp-slot-day">${d}</div>
                <div class="wlp-slot-open">${open}</div>
            </div>`;
        }).join('');
        return `
            <div class="wlp-board-room">
                <div class="wlp-board-room-title">${escHtml(room.label)} <span class="wlp-board-room-cap">Cap ${room.capacity ?? '—'}/day</span></div>
                <div class="wlp-board-slots">${slots}</div>
                ${note ? `<div class="wlp-board-note" style="color:${note.color}">${escHtml(note.text)}</div>` : ''}
            </div>`;
    }).join('');

    const right = sel ? wlpRenderBoardSidebar(sel, mi, alloc) : '';
    const below = sel ? '' : wlpRenderBoardDefaultPanels(mi, alloc);

    return `
        <div class="wlp-board-wrap">
            <div class="wlp-board-rooms">${roomsHtml}</div>
            ${right}
        </div>
        ${below}`;
}

function wlpMovingCardHtml(ev) {
    return `
        <div class="wlp-moving-card">
            <div class="wlp-moving-icon ${ev.iconCls}">${ev.icon}</div>
            <div style="font-size:11.5px;line-height:1.4;"><strong>${escHtml(ev.name)}</strong><br><span style="color:var(--text-muted);font-size:10.5px;">${escHtml(ev.actionLabel)} (${escHtml(ev.days.join(', '))})</span></div>
        </div>`;
}
function wlpTopRowHtml(k) {
    return `<div class="wlp-top-row"><strong>${escHtml(k.name)}</strong><span style="color:var(--text-muted)">${escHtml(wlDaysWaiting(k.appliedAt))}</span></div>`;
}

function wlpRenderBoardSidebar(sel, mi, alloc) {
    const room = alloc.roomMeta[sel.roomId].room;
    const candidates = alloc.kids.filter(k => k.room === sel.roomId && k.days.includes(sel.day) && k.desiredStartM <= mi);
    const ranked = wlpSortByPriority(candidates);
    const suggestionsHtml = ranked.map(k => {
        const dayMap = alloc.preGridByKid[k.id][mi];
        const avail = k.days.filter(d => dayMap[d] >= 1);
        const missing = k.days.filter(d => !avail.includes(d));
        const isHl = _wlp.highlightKidC === k.id;
        const chips = wlpDayChips(k, dayMap).map(wlpChipHtml).join('');
        const offerLabel = missing.length ? `Offer ${avail.length} of ${k.days.length} days` : `Offer all ${k.days.length} days`;
        const offerCls = missing.length ? 'wlp-suggestion-offer-partial' : 'wlp-suggestion-offer-full';
        return `
            <div class="wlp-suggestion-card ${isHl ? 'highlight' : ''}" data-wlp-suggest="${k.id}">
                <div class="wlp-suggestion-top"><span class="wlp-suggestion-name">${escHtml(k.name)}${wlpDayTypeTag(k)}</span><span class="wlp-suggestion-waiting">${escHtml(wlDaysWaiting(k.appliedAt))}</span></div>
                <div class="wlp-suggestion-priority">${wlpPriorityLabel(k)}</div>
                <div class="wlp-chip-row">${chips}</div>
                <button type="button" class="wlp-suggestion-offer ${offerCls}" data-wlp-board-offer="${k.id}">${offerLabel}</button>
            </div>`;
    }).join('');

    const roomLabel = room.label.replace(/^\S+\s/, '');
    const roomMoving = wlpMovementEvents(sel.roomId, alloc).filter(ev => ev.monthLabel === alloc.months[mi].label);
    const movingHtml = roomMoving.length ? roomMoving.map(wlpMovingCardHtml).join('') : '<div class="wlp-empty-note" style="margin-bottom:18px">No graduations or waitlist starts land here this month.</div>';

    const topWl = wlpSortByPriority(alloc.kids.filter(k => k.room === sel.roomId)).slice(0, 4);
    const topHtml = topWl.length ? topWl.map(wlpTopRowHtml).join('') : '<div class="wlp-empty-note">No one waiting for this room.</div>';

    return `
        <div class="wlp-sidebar">
            <div class="wlp-sidebar-head">
                <div class="wlp-sidebar-title">${escHtml(room.label)} · ${sel.day} · ${escHtml(alloc.months[mi].label)}</div>
                <button type="button" class="wlp-sidebar-close" id="wlpSlotClose">✕</button>
            </div>
            <div class="wlp-sidebar-hint">Suggested, best fit first — click a card to see their full pattern on the board:</div>
            <div style="margin-bottom:18px">${suggestionsHtml || '<div class="wlp-empty-note">No one waiting needs this day.</div>'}</div>
            <div class="wlp-section-label" style="margin-bottom:8px">Moving this month — ${escHtml(roomLabel)}</div>
            ${movingHtml}
            <div class="wlp-section-label" style="margin-bottom:4px">Top of the waitlist — ${escHtml(roomLabel)}</div>
            <div class="wlp-section-hint">Ranked by sibling priority, then longest wait — regardless of whether this room has an opening yet.</div>
            ${topHtml}
            ${_wlp.toastText ? `<div class="wlp-toast" style="margin-top:14px;border-radius:7px;">${escHtml(_wlp.toastText)}</div>` : ''}
        </div>`;
}

function wlpRenderBoardDefaultPanels(mi, alloc) {
    const allRoomsMoving = alloc.rooms.map(room => ({
        room, events: wlpMovementEvents(room.id, alloc).filter(ev => ev.monthLabel === alloc.months[mi].label),
    })).filter(r => r.events.length);
    const movingCols = allRoomsMoving.map(({ room, events }) => `
        <div class="wlp-default-group">
            <div class="wlp-movement-col-title">${escHtml(room.label)}</div>
            <div class="wlp-movement-events">${events.map(wlpEventCardHtml).join('')}</div>
        </div>`).join('');

    const allRoomsTop = alloc.rooms.map(room => ({
        room, kids: wlpSortByPriority(alloc.kids.filter(k => k.room === room.id)).slice(0, 3),
    })).filter(r => r.kids.length);
    const topCols = allRoomsTop.map(({ room, kids }) => `
        <div class="wlp-default-group">
            <div class="wlp-movement-col-title">${escHtml(room.label)}</div>
            ${kids.map(wlpTopRowHtml).join('')}
        </div>`).join('');

    return `
        <div class="wlp-default-panels">
            <div class="wlp-default-cols">
                <div class="wlp-default-col">
                    <div class="wlp-section-label" style="margin-bottom:2px">Moving this month, all rooms</div>
                    <div class="wlp-section-hint">Click a slot above to focus this on one room.</div>
                    <div class="wlp-default-groups">${movingCols || '<div class="wlp-empty-note">No graduations or waitlist starts land anywhere this month.</div>'}</div>
                </div>
                <div class="wlp-default-col">
                    <div class="wlp-section-label" style="margin-bottom:2px">Top of the waitlist, by room</div>
                    <div class="wlp-section-hint">Ranked by sibling priority, then longest wait.</div>
                    <div class="wlp-default-groups">${topCols || '<div class="wlp-empty-note">No one on the waitlist.</div>'}</div>
                </div>
            </div>
        </div>`;
}

function wlpAttachBoardListeners() {
    document.querySelectorAll('[data-wlp-slot]').forEach(el => {
        el.addEventListener('click', () => {
            const [roomId, day] = el.dataset.wlpSlot.split(':');
            _wlp.selSlotC = { roomId, day };
            _wlp.highlightKidC = null;
            renderWaitlistPlanner();
        });
    });
    document.getElementById('wlpSlotClose')?.addEventListener('click', () => { _wlp.selSlotC = null; _wlp.highlightKidC = null; renderWaitlistPlanner(); });
    document.querySelectorAll('[data-wlp-suggest]').forEach(el => {
        el.addEventListener('click', e => {
            if (e.target.closest('[data-wlp-board-offer]')) return;
            const id = Number(el.dataset.wlpSuggest);
            _wlp.highlightKidC = _wlp.highlightKidC === id ? null : id;
            renderWaitlistPlanner();
        });
    });
    document.querySelectorAll('[data-wlp-board-offer]').forEach(el => {
        el.addEventListener('click', e => { e.stopPropagation(); wlpOpenOfferModal(Number(el.dataset.wlpBoardOffer), null, _wlp.boardMonthIdx); });
    });
}

// ── Offer / Tour modal bridges (reuses the existing #wlOfferModal /
// #wlTourModal — see setupWaitlistAdmin() for the Send/Save handlers) ──────
function wlpOfferDaysForKid(k, monthIdx) {
    const dayMap = _wlpAlloc.preGridByKid[k.id][monthIdx];
    const avail = k.days.filter(d => dayMap[d] >= 1);
    const missing = k.days.filter(d => !avail.includes(d));
    return { avail, missing };
}

function wlpOpenOfferModal(kidId, forceType, monthIdx) {
    const alloc = _wlpAlloc;
    if (!alloc) return;
    const k = alloc.kids.find(x => x.id === kidId);
    if (!k) return;
    const mi = monthIdx != null ? monthIdx : k.desiredStartM;
    const { avail, missing } = wlpOfferDaysForKid(k, mi);
    const offerType = forceType || (missing.length ? 'partial' : 'full');
    const offeredDays = offerType === 'partial' ? avail : k.days;
    if (!offeredDays.length) { alert(`${k.name} has no open days this month to offer.`); return; }

    const modal = document.getElementById('wlOfferModal');
    if (!modal) return;
    modal.dataset.appId = k.id;
    modal.dataset.parentName = k.parentName || '';
    modal.dataset.parentEmail = k.parentEmail || '';
    modal.dataset.childName = k.name;
    modal.dataset.offerType = offerType;
    modal.dataset.offeredDays = offeredDays.join(', ');
    document.getElementById('wlOfferModalDesc').textContent = offerType === 'partial'
        ? `Offering ${k.name} ${offeredDays.length} of ${k.days.length} requested days (${offeredDays.join(', ')}) — parent: ${k.parentName} (${k.parentEmail})`
        : `Offering a spot to ${k.name} for all ${k.days.length} requested days (${offeredDays.join(', ')}) — parent: ${k.parentName} (${k.parentEmail})`;
    document.getElementById('wlOfferErr').textContent = '';
    document.getElementById('wlOfferSendBtn').disabled = false;
    document.getElementById('wlOfferSendBtn').textContent = 'Send & Email Parent';
    document.getElementById('wlOfferDeadline').value = new Date(Date.now() + 14 * 86400000).toISOString().split('T')[0];
    document.getElementById('wlOfferNotes').value = '';
    const g = window._globalOfferLinks || {};
    const procareEl = document.getElementById('wlOfferProcare');
    const paperwkEl = document.getElementById('wlOfferPaperwork');
    if (procareEl) procareEl.value = g.procareLink || '';
    if (paperwkEl) paperwkEl.value = (g.paperworkLinks || []).join(', ');
    modal.classList.remove('hidden');
}

function wlpOpenTourModal(kidId) {
    const k = _wlpAlloc?.kids.find(x => x.id === kidId);
    if (!k) return;
    const modal = document.getElementById('wlTourModal');
    if (!modal) return;
    modal.dataset.appId = kidId;
    document.getElementById('wlTourModalDesc').textContent = `Scheduling a tour for ${k.name} (parent: ${k.parentName})`;
    document.getElementById('wlTourDateTime').value = '';
    document.getElementById('wlTourNotes').value = '';
    document.getElementById('wlTourErr').textContent = '';
    modal.classList.remove('hidden');
}

function wlpFlashToast(text) {
    _wlp.toastText = text;
    setTimeout(() => { _wlp.toastText = null; renderWaitlistPlanner(); }, 3200);
}


// ============================================================
// WAITLIST PLANNING PANEL
// ============================================================

// Which room a child moves into when they age out of their current room, and
// at what age. Owl has no destination — aging out of Owl means leaving the
// program (e.g. off to kindergarten), not moving to another MDO room.
const PROMOTION_CHAIN = {
    bear:   { ageOutMonths: 12, nextRoom: 'bee' },
    bee:    { ageOutMonths: 24, nextRoom: 'turtle' },
    turtle: { ageOutMonths: 30, nextRoom: 'goose' },
    goose:  { ageOutMonths: 36, nextRoom: 'owl' },
    owl:    { ageOutMonths: 60, nextRoom: null },
};

function _nextMoKey(moKey) {
    const [y, m] = moKey.split('-').map(Number);
    const d = new Date(y, m, 1); // m is 1-based, so this already lands on next month
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// Which weekdays a registration actually attends, and whether each is a half
// or full day — read straight from its own registration_dates rather than
// assumed, so a graduating/moving child's real schedule carries with them.
function _weekdayDayTypeMap(reg) {
    const map = {};
    (reg.registration_dates || []).forEach(d => {
        if (d.waitlisted || !d.care_date) return;
        const day = _trendDayName(d.care_date);
        if (day) map[day] = d.day_type === 'half' ? 'half' : 'full';
    });
    return map;
}

// For each child aging out of a room this month: who's leaving (gradOut, keyed
// by the room they're leaving) and who's arriving (gradIn, keyed by the room
// they're moving into) — each with the weekday/day-type pattern they actually
// keep from their current registration.
function _buildGraduationIndex() {
    const gradOut = {}, gradIn = {};
    const seen = new Set();
    (allRegistrations || []).forEach(reg => {
        const chain = PROMOTION_CHAIN[reg.room_id];
        if (!chain || !reg.child_dob) return;
        const key = `${reg.child_name}:${reg.room_id}`;
        if (seen.has(key)) return;
        seen.add(key);

        const weekdays = _weekdayDayTypeMap(reg);
        if (!Object.keys(weekdays).length) return; // no known schedule to carry forward

        const dob       = new Date(reg.child_dob);
        const graduates = new Date(dob.getFullYear(), dob.getMonth() + chain.ageOutMonths, 1);
        const moKey     = `${graduates.getFullYear()}-${String(graduates.getMonth() + 1).padStart(2, '0')}`;

        if (!gradOut[moKey]) gradOut[moKey] = {};
        if (!gradOut[moKey][reg.room_id]) gradOut[moKey][reg.room_id] = [];
        gradOut[moKey][reg.room_id].push({ childName: reg.child_name, weekdays });

        if (chain.nextRoom) {
            if (!gradIn[moKey]) gradIn[moKey] = {};
            if (!gradIn[moKey][chain.nextRoom]) gradIn[moKey][chain.nextRoom] = [];
            gradIn[moKey][chain.nextRoom].push({ childName: reg.child_name, weekdays });
        }
    });
    return { gradOut, gradIn };
}

// One priority-ordered admission queue per room — same tier order the Quick
// List already shows as "position" (siblings first, then applied_at asc.),
// so "who's next" always agrees between the Quick List and the Planning
// panel's admission simulation below.
function _buildWaitlistPriorityQueues() {
    const byRoom = {};
    (_allWaitlistApps || [])
        .filter(a => ['pending', 'offered', 'accepted'].includes(a.status))
        .forEach(a => {
            if (!a.desired_start_date) return;
            const roomId = wlDeriveRoom(a);
            if (!roomId) return;
            const named = (a.days_of_week || '').split(',').map(s => s.trim()).filter(Boolean);
            const days  = named.length ? named : TREND_DAYS;
            const type  = a.day_type === 'half' ? 'half' : 'full';
            const weekdays = {};
            days.forEach(d => { if (TREND_DAYS.includes(d)) weekdays[d] = type; });
            if (!Object.keys(weekdays).length) return; // no valid requested days — nothing to simulate

            if (!byRoom[roomId]) byRoom[roomId] = [];
            byRoom[roomId].push({
                id: a.id,
                childName: a.child_name,
                weekdays,
                desiredMoKey:     a.desired_start_date.slice(0, 7),
                desiredStartDate: a.desired_start_date,
                appliedAt:        a.applied_at,
                hasSibling:       !!a.has_sibling,
            });
        });
    Object.values(byRoom).forEach(list => list.sort((x, y) => {
        const sibX = x.hasSibling ? 0 : 1, sibY = y.hasSibling ? 0 : 1;
        if (sibX !== sibY) return sibX - sibY;
        return new Date(x.appliedAt) - new Date(y.appliedAt);
    }));
    return byRoom;
}

/**
 * Forecast for a non-final month: start from the last real, locked-in month
 * for this room, then carry it forward month by month through every known
 * graduation (in and out) and waitlist admission up to (and including)
 * targetMoKey. Graduations apply unconditionally (an aging-out child always
 * gets a spot in the next room, regardless of that room's capacity — they're
 * already-enrolled, not new signups). Waitlist admissions are capacity-gated
 * and priority-ordered: a queued child is admitted in a given cursor month
 * only if EVERY one of their requested weekdays still has room under
 * room.capacity that month (no partial-week admission); otherwise they stay
 * queued and are retried the next cursor month. Once admitted they occupy
 * capacity in every month from then on, since `pattern` accumulates across
 * the whole walk without ever un-applying a prior admission.
 *
 * Pure function of (trendMap, roomId, targetMoKey, today) — recomputed from
 * scratch on every call, same contract this forecast has always had.
 */
function _simulateRoomAdmissions(trendMap, roomId, targetMoKey, today) {
    const pattern = {};
    TREND_DAYS.forEach(day => { pattern[day] = { half: 0, full: 0 }; });

    const lastFinalMoKey = _lastFinalTrendMonthKey(trendMap, today);
    if (!lastFinalMoKey) return { pattern, admittedThisMonth: [], stillWaiting: [] };

    const base = _trendMonthOwnPattern(trendMap, roomId, lastFinalMoKey);
    TREND_DAYS.forEach(day => { pattern[day] = { half: base[day].half, full: base[day].full }; });

    const { gradOut, gradIn } = _buildGraduationIndex();
    const queue = (_buildWaitlistPriorityQueues()[roomId] || []).slice();
    const room  = getSortedRooms().find(r => r.id === roomId);
    // A room without a known capacity (e.g. still 'coming_soon') can't admit
    // anyone — treat missing capacity as zero, not unlimited.
    const roomCapacity = room && room.capacity != null ? room.capacity : 0;

    const admitted = new Set();
    let admittedThisMonth = [];

    // Start at lastFinalMoKey itself, not the month after: a child who ages out
    // partway through the last real month is still counted for that whole month
    // in its own real data (families don't split a month's registration), so
    // their departure/arrival only actually shows up starting the next month —
    // applying lastFinalMoKey's own events here is what carries that forward.
    let cursor = lastFinalMoKey;
    while (cursor <= targetMoKey) {
        admittedThisMonth = []; // only the targetMoKey iteration's value survives

        TREND_DAYS.forEach(day => {
            (gradOut[cursor]?.[roomId] || []).forEach(child => {
                const type = child.weekdays[day];
                if (type) pattern[day][type] = Math.max(0, pattern[day][type] - 1);
            });
            (gradIn[cursor]?.[roomId] || []).forEach(child => {
                const type = child.weekdays[day];
                if (type) pattern[day][type] += 1;
            });
        });

        // Waitlist admissions: priority order, all-requested-days-or-nothing.
        queue.forEach(entry => {
            if (admitted.has(entry.id)) return;
            if (entry.desiredMoKey > cursor) return; // not eligible before their desired month
            const fits = TREND_DAYS.every(day => {
                const type = entry.weekdays[day];
                if (!type) return true; // day not requested — irrelevant to this child
                return pattern[day].half + pattern[day].full + 1 <= roomCapacity;
            });
            if (!fits) return; // stays queued, retried next cursor month

            TREND_DAYS.forEach(day => {
                const type = entry.weekdays[day];
                if (type) pattern[day][type] += 1;
            });
            admitted.add(entry.id);
            admittedThisMonth.push(entry);
        });

        if (cursor === targetMoKey) break;
        cursor = _nextMoKey(cursor);
    }

    const stillWaiting = queue.filter(e => !admitted.has(e.id) && e.desiredMoKey <= targetMoKey);
    return { pattern, admittedThisMonth, stillWaiting };
}

// Thin wrapper preserving the pre-existing contract for admin-reports.js's
// _weekdayPatternForMonth (shared with Enrollment Trends) — same signature,
// same return shape as before. Enrollment Trends' projected-month numbers
// become capacity-gated as a result, which is intentional: capacity is a
// hard ceiling on projected occupancy, not just a display-time clamp.
function _projectedWeekdayPattern(trendMap, roomId, moKey, today) {
    return _simulateRoomAdmissions(trendMap, roomId, moKey, today).pattern;
}


// ============================================================
// WAITLIST IMPORT
// ============================================================
async function previewWaitlistImport() {
    const fileInput = document.getElementById('wlImportFile');
    const preview   = document.getElementById('wlImportPreview');
    if (!fileInput?.files?.length) { preview.innerHTML = '<p class="import-error">Please choose a file first.</p>'; return; }

    const file = fileInput.files[0];
    let rows;
    try {
        // range=0: this importer expects a plain file with headers on row 1,
        // unlike the Families importer (parseUploadedFile's default range=2,
        // tuned for ProCare-style exports with leading title rows).
        rows = await parseUploadedFile(file, 0);
    } catch (err) {
        preview.innerHTML = `<p class="import-error">Could not read file: ${escHtml(err.message)}</p>`;
        return;
    }

    if (!rows.length) { preview.innerHTML = '<p class="import-error">No data rows found in file.</p>'; return; }

    // Detect columns (case-insensitive fuzzy match)
    const headers  = Object.keys(rows[0]).map(h => h.trim());
    const col = (keywords) => headers.find(h => keywords.some(k => h.toLowerCase().includes(k))) || null;

    const colParent  = col(['parent name','guardian name','parent']);
    const colEmail   = col(['email','e-mail']);
    const colPhone   = col(['phone','cell','mobile']);
    const colChild   = col(['child name','student name','child first','first name']);
    const colDob     = col(['dob','birth date','birthdate','date of birth','birthday']);
    const colStart   = col(['start date','desired start','start']);
    const colDays    = col(['days requested','days of week','days','weekdays']);
    const colType    = col(['day type','full or half','half or full','type']);
    const colNotes   = col(['notes','comments','note']);

    if (!colParent || !colChild) {
        preview.innerHTML = `<p class="import-error">Missing required columns. Need at least: Parent Name, Child Name. Detected columns: ${escHtml(headers.join(', '))}</p>`;
        return;
    }

    // Normalize rows into waitlist records. Email is picked up when present but
    // isn't required — plenty of real waitlist entries only have a phone number,
    // or no contact info yet at all, and shouldn't be silently dropped from import.
    const records = rows.map(r => {
        const parentName  = (r[colParent] || '').trim();
        const parentEmail = colEmail  ? (r[colEmail]  || '').trim().toLowerCase() : '';
        const parentPhone = colPhone  ? (r[colPhone]  || '').trim() : '';
        const childName   = (r[colChild]  || '').trim();
        const childDob    = colDob    ? _normDateStr(r[colDob])   : null;
        const startDate   = colStart  ? _normDateStr(r[colStart]) : null;
        const daysOfWeek  = colDays   ? (r[colDays]  || '').trim() : '';
        const dayType     = colType   ? ((r[colType] || '').toLowerCase().includes('half') ? 'half' : 'full') : 'full';
        const notes       = colNotes  ? (r[colNotes] || '').trim() : '';
        return { parentName, parentEmail, parentPhone, childName, childDob, startDate, daysOfWeek, dayType, notes };
    }).filter(r => r.parentName && r.childName);

    if (!records.length) { preview.innerHTML = '<p class="import-error">No valid rows after normalization.</p>'; return; }

    preview.innerHTML = `
        <p style="margin-bottom:8px;font-size:.9em;color:#555">${records.length} record(s) ready to import. Review below, then click <strong>Import</strong>.</p>
        <div style="overflow-x:auto;margin-bottom:12px">
        <table class="report-table" style="font-size:.82em">
            <thead><tr>
                <th>Parent</th><th>Email</th><th>Child</th><th>Child DOB</th>
                <th>Desired Start</th><th>Days</th><th>Type</th><th>Notes</th>
            </tr></thead>
            <tbody>
                ${records.map(r => `<tr>
                    <td>${escHtml(r.parentName)}</td>
                    <td>${escHtml(r.parentEmail) || '—'}</td>
                    <td>${escHtml(r.childName)}</td>
                    <td>${r.childDob || '—'}</td>
                    <td>${r.startDate || '—'}</td>
                    <td>${escHtml(r.daysOfWeek) || '—'}</td>
                    <td>${r.dayType}</td>
                    <td>${escHtml(r.notes) || '—'}</td>
                </tr>`).join('')}
            </tbody>
        </table></div>
        <button id="wlImportConfirmBtn" class="btn-primary">Import ${records.length} Record(s)</button>
        <span id="wlImportStatus" style="margin-left:12px;font-size:.88em;color:#555"></span>`;

    document.getElementById('wlImportConfirmBtn').addEventListener('click', async () => {
        const btn    = document.getElementById('wlImportConfirmBtn');
        const status = document.getElementById('wlImportStatus');
        btn.disabled = true; btn.textContent = 'Importing…';
        let imported = 0, failed = 0;
        for (const r of records) {
            try {
                await submitWaitlistApplication({
                    parent_name:          r.parentName,
                    parent_email:         r.parentEmail,
                    parent_phone:         r.parentPhone || null,
                    child_name:           r.childName,
                    child_dob:            r.childDob || null,
                    desired_start_date:   r.startDate || new Date().toISOString().split('T')[0],
                    days_of_week:         r.daysOfWeek || null,
                    day_type:             r.dayType,
                    notes:                r.notes || null,
                    status:               'pending',
                });
                imported++;
            } catch { failed++; }
        }
        status.textContent = `✓ ${imported} imported${failed ? `, ${failed} failed` : ''}`;
        btn.textContent = 'Done';
        if (imported > 0) await loadWaitlistApplications();
    });
}

function _normDateStr(val) {
    if (!val) return null;
    const s = String(val).trim();
    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // MM/DD/YYYY or M/D/YYYY
    const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`;
    // Try native parse
    const d = new Date(s);
    if (!isNaN(d)) return d.toLocaleDateString('en-CA');
    return null;
}

function setupWaitlistAdmin() {
    populateSiblingRoomSelect(document.getElementById('adminWlSibRoom'));

    setupWaitlistNotifications();

    // Tour modal
    document.getElementById('wlTourCancelBtn')?.addEventListener('click', () => document.getElementById('wlTourModal').classList.add('hidden'));
    document.getElementById('wlTourModal')?.addEventListener('click', e => { if (e.target === document.getElementById('wlTourModal')) document.getElementById('wlTourModal').classList.add('hidden'); });
    document.getElementById('wlTourSaveBtn')?.addEventListener('click', async () => {
        const modal    = document.getElementById('wlTourModal');
        const id       = Number(modal.dataset.appId);
        const dateTime = document.getElementById('wlTourDateTime').value;
        const notes    = document.getElementById('wlTourNotes').value.trim() || null;
        const errEl    = document.getElementById('wlTourErr');
        if (!dateTime) { errEl.textContent = 'Please choose a tour date and time.'; return; }
        const btn = document.getElementById('wlTourSaveBtn');
        btn.disabled = true; btn.textContent = 'Saving…'; errEl.textContent = '';
        try {
            const iso = new Date(dateTime).toISOString();
            await updateWaitlistTourStatus(id, { tour_status: 'scheduled', tour_scheduled_at: iso, tour_notes: notes });
            const app = _allWaitlistApps.find(a => a.id === id);
            if (app) { app.tour_status = 'scheduled'; app.tour_scheduled_at = iso; app.tour_notes = notes; }
            modal.classList.add('hidden');
            renderWaitlistPlanner();
        } catch (err) {
            errEl.textContent = 'Error: ' + err.message;
        } finally {
            btn.disabled = false; btn.textContent = 'Save Tour';
        }
    });

    // Offer modal — opened via wlpOpenOfferModal() from the Waitlist &
    // Capacity Planner's Queue/Board views, which pre-fill dataset.offerType
    // ('full'|'partial') and dataset.offeredDays (which exact weekdays are
    // being offered — may be a subset of the child's full request).
    document.getElementById('wlOfferCancelBtn')?.addEventListener('click', () => document.getElementById('wlOfferModal').classList.add('hidden'));
    document.getElementById('wlOfferModal')?.addEventListener('click', e => { if (e.target === document.getElementById('wlOfferModal')) document.getElementById('wlOfferModal').classList.add('hidden'); });
    document.getElementById('wlOfferSendBtn')?.addEventListener('click', async () => {
        const modal     = document.getElementById('wlOfferModal');
        const id        = Number(modal.dataset.appId);
        const deadline  = document.getElementById('wlOfferDeadline').value;
        const notes     = document.getElementById('wlOfferNotes').value || '';
        const procareLink   = document.getElementById('wlOfferProcare').value.trim() || null;
        const paperwkRaw    = document.getElementById('wlOfferPaperwork').value || '';
        const papeworkLinks = paperwkRaw.split(',').map(s => s.trim()).filter(Boolean);
        const parentName    = modal.dataset.parentName;
        const parentEmail   = modal.dataset.parentEmail;
        const childName     = modal.dataset.childName;
        const offerType     = modal.dataset.offerType || 'full';
        const offeredDays   = modal.dataset.offeredDays || '';
        const errEl = document.getElementById('wlOfferErr');
        if (!deadline) { errEl.textContent = 'Please set an offer deadline.'; return; }
        const btn = document.getElementById('wlOfferSendBtn');
        btn.disabled = true; btn.textContent = 'Sending…'; errEl.textContent = '';
        try {
            await updateWaitlistApplication(id, {
                status: 'offered', offered_at: new Date().toISOString(), offer_deadline: deadline, offer_notes: notes || null,
                offer_type: offerType, offered_days: offeredDays || null,
            });
            await sendWaitlistOfferEmail({ parentName, parentEmail, childName, offerDeadline: deadline, offerNotes: notes || null, papeworkLinks, procareLink });
            const app = _allWaitlistApps.find(a => a.id === id);
            if (app) { app.status = 'offered'; app.offered_at = new Date().toISOString(); app.offer_deadline = deadline; app.offer_notes = notes || null; app.offer_type = offerType; app.offered_days = offeredDays || null; }
            modal.classList.add('hidden');
            document.getElementById('wlOfferDeadline').value = '';
            document.getElementById('wlOfferNotes').value = '';
            wlpFlashToast(offerType === 'partial'
                ? `Partial offer sent to ${parentName}: ${offeredDays} now.`
                : `Offer sent to ${parentName} for all requested days (${offeredDays}).`);
            renderWaitlistPlanner();
        } catch (err) {
            errEl.textContent = 'Offer saved, but email failed: ' + err.message + '. Email parent manually at ' + parentEmail;
            btn.disabled = false; btn.textContent = 'Send & Email Parent';
            const app = _allWaitlistApps.find(a => a.id === id);
            if (app) { app.status = 'offered'; renderWaitlistPlanner(); }
        }
    });
    document.getElementById('generateWaitlistBtn')?.addEventListener('click', generateWaitlistReport);
    initEnrollmentPlannerSelectors();

    // Waitlist import
    document.getElementById('wlImportParseBtn')?.addEventListener('click', previewWaitlistImport);

    // Add/Edit modal controls — backdrop click intentionally does NOT close
    // this modal (must use Cancel or Save), so unsaved edits are never lost
    // to a stray click.
    document.getElementById('adminWlCancelBtn')?.addEventListener('click', _closeAdminWlModal);
    document.getElementById('adminWlSubmitBtn')?.addEventListener('click', _submitAdminWlEntry);
    document.getElementById('adminWlIsUnborn')?.addEventListener('change', e => {
        document.getElementById('adminWlDobRow').classList.toggle('hidden',  e.target.checked);
        document.getElementById('adminWlDueRow').classList.toggle('hidden', !e.target.checked);
    });
    document.getElementById('adminWlHasSibling')?.addEventListener('change', e => {
        document.getElementById('adminWlSibRow').classList.toggle('hidden', !e.target.checked);
    });

    loadWaitlistApplications();
}

// ============================================================
// WAITLIST NOTIFICATIONS  (shareable inquiry link + notify email)
// ============================================================
async function setupWaitlistNotifications() {
    const linkEl = document.getElementById('wlInquiryLink');
    if (linkEl) linkEl.value = `${window.location.origin}/inquiry`;

    document.getElementById('wlCopyInquiryLinkBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('wlCopyInquiryLinkBtn');
        try {
            await navigator.clipboard.writeText(linkEl.value);
            const orig = btn.textContent;
            btn.textContent = '✓ Copied!';
            setTimeout(() => { btn.textContent = orig; }, 2000);
        } catch (_) {
            linkEl.select();
            document.execCommand('copy');
        }
    });

    const emailEl     = document.getElementById('wlNotifyEmail');
    const remindersEl = document.getElementById('wlRemindersEnabled');
    try {
        const settings = await loadWaitlistNotifySettings();
        if (emailEl) emailEl.value = settings.notifyEmail || '';
        // Off unless explicitly turned on — a missing/undefined value must
        // never be read as "on", since that's the default for every waitlist
        // row that predates this setting existing at all.
        if (remindersEl) remindersEl.checked = settings.remindersEnabled === true;
    } catch (_) {}

    document.getElementById('wlSaveNotifyEmailBtn')?.addEventListener('click', async () => {
        const btn      = document.getElementById('wlSaveNotifyEmailBtn');
        const statusEl = document.getElementById('wlNotifyEmailStatus');
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
            await saveWaitlistNotifySettings({
                notifyEmail:      emailEl.value.trim() || null,
                remindersEnabled: !!remindersEl?.checked,
            });
            if (statusEl) {
                statusEl.textContent = '✓ Saved!';
                statusEl.style.color = '#2e7d32';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }
        } catch (err) {
            if (statusEl) { statusEl.textContent = '⚠️ ' + err.message; statusEl.style.color = '#c62828'; }
        } finally {
            btn.disabled = false; btn.textContent = '💾 Save';
        }
    });
}

// Set when the modal is editing an existing entry (rather than adding a new
// one) — id of the application being edited, or null for the Add flow.
let _adminWlEditingId = null;

function _openAdminWlModal() {
    _adminWlEditingId = null;
    document.getElementById('adminWlForm').reset();
    document.getElementById('adminWlDobRow').classList.remove('hidden');
    document.getElementById('adminWlDueRow').classList.add('hidden');
    document.getElementById('adminWlSibRow').classList.add('hidden');
    document.getElementById('adminWlErr').textContent = '';
    document.getElementById('adminWlModalTitle').textContent = 'Add Child to Waitlist';
    document.getElementById('adminWlSubmitBtn').disabled = false;
    document.getElementById('adminWlSubmitBtn').textContent = 'Add to Waitlist';
    document.getElementById('adminWlOverlay').classList.remove('hidden');
    document.getElementById('adminWlParentName').focus();
}

// Opens the same modal pre-filled with an existing waitlist application's
// data; _submitAdminWlEntry() detects _adminWlEditingId and updates instead
// of inserting.
function _openAdminWlModalForEdit(app) {
    _adminWlEditingId = app.id;
    document.getElementById('adminWlForm').reset();
    document.getElementById('adminWlErr').textContent = '';

    document.getElementById('adminWlParentName').value  = app.parent_name || '';
    document.getElementById('adminWlParentEmail').value = app.parent_email || '';
    document.getElementById('adminWlParentPhone').value = app.parent_phone || '';
    document.getElementById('adminWlChildName').value   = app.child_name || '';

    const unborn = !!app.expected_due_date && !app.child_dob;
    document.getElementById('adminWlIsUnborn').checked = unborn;
    document.getElementById('adminWlDobRow').classList.toggle('hidden', unborn);
    document.getElementById('adminWlDueRow').classList.toggle('hidden', !unborn);
    document.getElementById('adminWlDob').value     = app.child_dob || '';
    document.getElementById('adminWlDueDate').value = app.expected_due_date || '';

    document.getElementById('adminWlStartDate').value  = app.desired_start_date || '';
    document.getElementById('adminWlFlexibility').value = app.start_flexibility || 'within_quarter';

    const namedDays = (app.days_of_week || '').split(',').map(s => s.trim()).filter(Boolean);
    document.querySelectorAll('#adminWlForm .adminWlDay').forEach(cb => {
        cb.checked = namedDays.length ? namedDays.includes(cb.value) : true;
    });
    const dayTypeRadio = document.querySelector(`#adminWlForm input[name="adminWlDayType"][value="${app.day_type === 'half' ? 'half' : 'full'}"]`);
    if (dayTypeRadio) dayTypeRadio.checked = true;

    document.getElementById('adminWlHasSibling').checked = !!app.has_sibling;
    document.getElementById('adminWlSibRow').classList.toggle('hidden', !app.has_sibling);
    document.getElementById('adminWlSibName').value = app.sibling_child_name || '';
    document.getElementById('adminWlSibRoom').value = app.sibling_room_id || '';

    document.getElementById('adminWlNotes').value = app.notes || '';

    document.getElementById('adminWlModalTitle').textContent = `Edit Waitlist Entry — ${app.child_name}`;
    document.getElementById('adminWlSubmitBtn').disabled = false;
    document.getElementById('adminWlSubmitBtn').textContent = 'Save Changes';
    document.getElementById('adminWlOverlay').classList.remove('hidden');
    document.getElementById('adminWlParentName').focus();
}

function _closeAdminWlModal() {
    document.getElementById('adminWlOverlay').classList.add('hidden');
}

async function _submitAdminWlEntry() {
    const err = document.getElementById('adminWlErr');
    err.textContent = '';

    const isEdit   = !!_adminWlEditingId;
    const unborn   = document.getElementById('adminWlIsUnborn').checked;
    const hasSib   = document.getElementById('adminWlHasSibling').checked;
    const days     = [...document.querySelectorAll('#adminWlForm .adminWlDay:checked')].map(c => c.value);
    const dayType  = document.querySelector('#adminWlForm input[name="adminWlDayType"]:checked')?.value || 'full';

    const payload = {
        parent_name:        document.getElementById('adminWlParentName').value.trim(),
        parent_email:       document.getElementById('adminWlParentEmail').value.trim(),
        parent_phone:       document.getElementById('adminWlParentPhone').value.trim() || null,
        child_name:         document.getElementById('adminWlChildName').value.trim(),
        child_dob:          !unborn ? (document.getElementById('adminWlDob').value || null) : null,
        expected_due_date:  unborn  ? (document.getElementById('adminWlDueDate').value || null) : null,
        desired_start_date: document.getElementById('adminWlStartDate').value,
        start_flexibility:  document.getElementById('adminWlFlexibility').value,
        days_of_week:       days.length ? days.join(', ') : null,
        day_type:           dayType,
        has_sibling:        hasSib,
        sibling_child_name: hasSib ? (document.getElementById('adminWlSibName').value.trim() || null) : null,
        sibling_room_id:    hasSib ? (document.getElementById('adminWlSibRoom').value || null) : null,
        notes:              document.getElementById('adminWlNotes').value.trim() || null,
    };
    // Only a brand-new entry starts as 'pending' — editing must never reset
    // an in-progress application's status (offered/accepted/etc.) back to it.
    if (!isEdit) payload.status = 'pending';

    if (!payload.parent_name || !payload.parent_email || !payload.child_name || !payload.desired_start_date) {
        err.textContent = 'Please fill in the required fields: parent name, email, child name, and desired start date.';
        return;
    }

    const btn = document.getElementById('adminWlSubmitBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        if (isEdit) {
            await updateWaitlistApplication(_adminWlEditingId, payload);
        } else {
            await submitWaitlistApplication(payload);
        }
        _adminWlEditingId = null;
        _closeAdminWlModal();
        await loadWaitlistApplications();
    } catch (e) {
        err.textContent = 'Error: ' + e.message;
        btn.disabled = false; btn.textContent = isEdit ? 'Save Changes' : 'Add to Waitlist';
    }
}

// ============================================================
