// ============================================================
// MODULE: Enrollment & Capacity (Classroom Tab Redesign, 2026-08-27)
// ============================================================
// Replaces three screens that read the same registrations at different
// grains — Capacity Overview's month grid, Room Schedule Planner's weekly
// AM/PM view, and Planning's FTE/seat-day Room Capacity Overview — with one
// Day/Week/Month/FTE view switcher. The director confirmed she uses all
// three original screens, so this is a merge with a view switcher, not a
// pick-a-winner.
//
// Week, Month and FTE sub-views are the original tools' own markup relocated
// into #enrollmentCapacitySection — renderRoomSchedule() (admin-calendar.js),
// renderCapacityOverview() (admin-calendar.js) and renderCapacityOverviewTool()
// (admin-reports.js) are UNCHANGED except that the FTE one now takes an
// optional target month, because this screen gives it its own independent
// month picker (per the design handoff) rather than sharing Month's.
//
// Day is new: it did not exist as its own screen before. Its "Move a child"
// action reuses showDayRosterDetail() (admin-calendar.js) exactly the way the
// Month view's day-cell click already does — same panel, same room-move
// dropdown, same updateRegistrationDateRoom() write.

let _ecView         = 'day';
let _ecDate         = null;
let _ecFteMonthDate = null;
let _ecOverviewMonthDate = null;

function setupEnrollCapTool() {
    _ecDate = new Date().toISOString().split('T')[0];
    const dateInput = document.getElementById('ecDayDate');
    if (dateInput) dateInput.value = _ecDate;

    document.querySelectorAll('#enrollmentCapacitySection .ec-pill[data-ec-view]').forEach(btn => {
        btn.addEventListener('click', () => _ecSwitchView(btn.dataset.ecView));
    });

    document.getElementById('ecDayPrev')?.addEventListener('click', () => _ecShiftDay(-1));
    document.getElementById('ecDayNext')?.addEventListener('click', () => _ecShiftDay(1));
    document.getElementById('ecDayDate')?.addEventListener('change', (e) => {
        _ecDate = e.target.value;
        _ecRenderDay();
    });

    _ecSetupFteMonthNav();
    _ecSetupOverviewMonthNav();
}

/** Called each time the Enrollment & Capacity tool is opened from the nav. */
async function renderEnrollCapTool() {
    if (typeof allRegistrations !== 'undefined' && !allRegistrations.length) {
        try { allRegistrations = await fetchAllRegistrations(); } catch (err) { console.warn('renderEnrollCapTool:', err); }
    }
    if (_ecView === 'day') _ecRenderDay();
    else if (_ecView === 'fte') _ecRenderFte();
    else if (_ecView === 'overview') _ecRenderOverview();
    // Week starts on its own "select a week and click View Week" hint, same
    // as before the merge. Month's grid is kept fresh by the unconditional
    // renderCapacityOverview() call at dashboard init, same as before.
}

function _ecShiftDay(delta) {
    const d = new Date(_ecDate + 'T00:00:00');
    d.setDate(d.getDate() + delta);
    _ecDate = d.toISOString().split('T')[0];
    const dateInput = document.getElementById('ecDayDate');
    if (dateInput) dateInput.value = _ecDate;
    _ecRenderDay();
}

const _EC_VIEW_ID = { day: 'ecDayView', week: 'ecWeekView', month: 'ecMonthView', fte: 'ecFteView', overview: 'ecOverviewView' };

function _ecSwitchView(view) {
    if (!_EC_VIEW_ID[view]) return;
    _ecView = view;
    document.querySelectorAll('#enrollmentCapacitySection .ec-pill[data-ec-view]').forEach(btn => {
        const on = btn.dataset.ecView === view;
        btn.classList.toggle('is-active', on);
        btn.setAttribute('aria-selected', String(on));
    });
    Object.entries(_EC_VIEW_ID).forEach(([v, id]) => {
        document.getElementById(id)?.classList.toggle('hidden', v !== view);
    });
    if (view === 'day') _ecRenderDay();
    if (view === 'fte') _ecRenderFte();
    if (view === 'overview') _ecRenderOverview();
}

// ── Day view ─────────────────────────────────────────────────
// Every room for one date: enrolled/cap, staff needed (booked registrations
// only — same "clock-in room data is deliberately never read" rule as the
// Daily Staffing Requirement tool), a capacity flag, and Move a child.
async function _ecRenderDay() {
    const container = document.getElementById('ecDayContent');
    if (!container || !_ecDate) return;

    if (typeof allRegistrations !== 'undefined' && !allRegistrations.length) {
        container.innerHTML = '<p class="empty-hint">Loading…</p>';
        try { allRegistrations = await fetchAllRegistrations(); }
        catch (err) { container.innerHTML = `<p class="import-error">Error: ${escHtml(err.message)}</p>`; return; }
    }

    if (typeof allClosureDates !== 'undefined' && allClosureDates.has(_ecDate)) {
        container.innerHTML = '<p class="empty-hint">The center is closed this day.</p>';
        return;
    }

    const rows = getSortedRooms().filter(r => r.status !== 'coming_soon').map(room => {
        const enrolled     = _ecDayRoomChildren(_ecDate, room.id);
        const count        = enrolled.length;
        const cap          = room.capacity || 0;
        const ratio        = Number(room.staffRatio) || null;
        const staffNeeded  = ratio ? Math.ceil(count / ratio) : null;
        // Matches the design source's capDayRows exactly: the flag is silent
        // unless the room is over its own capacity or just crossed a ratio
        // boundary (one more child needs one more staff member) — there is no
        // "near capacity" state here.
        const over  = !!cap && count >= cap;
        const edge  = !over && !!ratio && count > 0 && count % ratio === 0;
        return { room, enrolled, cap, staffNeeded, over, edge };
    });

    if (!rows.length) { container.innerHTML = '<p class="empty-hint">No active rooms found.</p>'; return; }

    container.innerHTML = `<div class="ec-day-rows">${rows.map(r => `
        <div class="ec-day-row">
            <div class="ec-day-room-name">${escHtml(r.room.label)}${r.room.staffRatio ? `<span class="ec-day-ratio">1 : ${r.room.staffRatio}</span>` : ''}</div>
            <div class="ec-day-stat"><strong>${r.enrolled.length}${r.cap ? ' / ' + r.cap : ''}</strong><span>enrolled</span></div>
            <div class="ec-day-stat"><strong>${r.staffNeeded ?? '—'}</strong><span>staff needed</span></div>
            <span class="ec-day-flag${r.over ? ' is-over' : r.edge ? ' is-edge' : ' is-hidden'}">${r.over ? 'AT CAPACITY' : r.edge ? 'AT RATIO STEP' : ''}</span>
            <button type="button" class="ec-move-btn" data-room="${r.room.id}">Move a child &rarr;</button>
        </div>`).join('')}</div>`;

    container.querySelectorAll('.ec-move-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const row = rows.find(r => r.room.id === btn.dataset.room);
            if (row) showDayRosterDetail(_ecDate, row.room.id, row.enrolled, row.cap, container);
        });
    });
}

// { childName, dayType, dateId } per child booked into one room on one date —
// same shape drawRoomCalendar() builds, and what showDayRosterDetail()'s move
// dropdown needs (dateId is registration_dates.id, for updateRegistrationDateRoom).
function _ecDayRoomChildren(dateStr, roomId) {
    const out = [];
    allRegistrations.forEach(reg => {
        (reg.registration_dates || []).forEach(d => {
            if (d.waitlisted || d.care_date !== dateStr) return;
            if ((d.room_id || reg.room_id) !== roomId) return;
            out.push({ childName: reg.child_name, dayType: d.day_type, dateId: d.id });
        });
    });
    return out.sort((a, b) => a.childName.localeCompare(b.childName));
}

// ── FTE / Seat-Day view — its own month picker ──────────────
// Deliberately not shared with the Month sub-view's picker (design handoff:
// "its own month picker, independent of Week's or Day's"). Same shape as
// admin-calendar.js's initCapacityMonthNav()/_syncCapSelect(), mirrored
// rather than shared since it targets a different select/button set.
function _ecSetupFteMonthNav() {
    const today = new Date();
    _ecFteMonthDate = new Date(today.getFullYear(), today.getMonth(), 1);

    const sel = document.getElementById('ecFteMonthSelect');
    if (sel) {
        sel.innerHTML = '';
        for (let offset = -6; offset <= 12; offset++) {
            const d   = new Date(today.getFullYear(), today.getMonth() + offset, 1);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
            if (offset === 0) opt.selected = true;
            sel.appendChild(opt);
        }
        sel.addEventListener('change', () => {
            const [y, m] = sel.value.split('-').map(Number);
            _ecFteMonthDate = new Date(y, m - 1, 1);
            _ecRenderFte();
        });
    }

    document.getElementById('ecFtePrevMonth')?.addEventListener('click', () => {
        _ecFteMonthDate = new Date(_ecFteMonthDate.getFullYear(), _ecFteMonthDate.getMonth() - 1, 1);
        _ecSyncFteSelect();
        _ecRenderFte();
    });
    document.getElementById('ecFteNextMonth')?.addEventListener('click', () => {
        _ecFteMonthDate = new Date(_ecFteMonthDate.getFullYear(), _ecFteMonthDate.getMonth() + 1, 1);
        _ecSyncFteSelect();
        _ecRenderFte();
    });
}

function _ecSyncFteSelect() {
    const sel = document.getElementById('ecFteMonthSelect');
    if (!sel || !_ecFteMonthDate) return;
    const key = `${_ecFteMonthDate.getFullYear()}-${String(_ecFteMonthDate.getMonth() + 1).padStart(2, '0')}`;
    let opt = [...sel.options].find(o => o.value === key);
    if (!opt) {
        opt = document.createElement('option');
        opt.value = key;
        opt.textContent = MONTH_NAMES[_ecFteMonthDate.getMonth()] + ' ' + _ecFteMonthDate.getFullYear();
        sel.appendChild(opt);
    }
    sel.value = key;
}

function _ecRenderFte() {
    if (typeof renderCapacityOverviewTool === 'function') renderCapacityOverviewTool(_ecFteMonthDate);
}

// ── Overview — per-room % utilization cards ─────────────────
// The original Capacity Overview: one card per room, whole-month booked-day
// utilization against capacity × working days, click a card to open that
// room's own calendar (openRoomCalendar()/drawRoomCalendar(), unchanged) and
// from there click a day to move a child (showDayRosterDetail(), now an
// inline panel — see admin-calendar.js). Retired when Month became a
// room-tabs + day-grid, restored as its own view at the director's request:
// the day-grid answers "what does one room's month look like," this answers
// "which rooms need attention this month" at a glance. Same own-month-picker
// pattern as FTE, independent of Month's and FTE's.
function _ecSetupOverviewMonthNav() {
    const today = new Date();
    _ecOverviewMonthDate = new Date(today.getFullYear(), today.getMonth(), 1);

    const sel = document.getElementById('ecOverviewMonthSelect');
    if (sel) {
        sel.innerHTML = '';
        for (let offset = -6; offset <= 12; offset++) {
            const d   = new Date(today.getFullYear(), today.getMonth() + offset, 1);
            const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
            const opt = document.createElement('option');
            opt.value = key;
            opt.textContent = MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear();
            if (offset === 0) opt.selected = true;
            sel.appendChild(opt);
        }
        sel.addEventListener('change', () => {
            const [y, m] = sel.value.split('-').map(Number);
            _ecOverviewMonthDate = new Date(y, m - 1, 1);
            _ecRenderOverview();
        });
    }

    document.getElementById('ecOverviewPrevMonth')?.addEventListener('click', () => {
        _ecOverviewMonthDate = new Date(_ecOverviewMonthDate.getFullYear(), _ecOverviewMonthDate.getMonth() - 1, 1);
        _ecSyncOverviewSelect();
        _ecRenderOverview();
    });
    document.getElementById('ecOverviewNextMonth')?.addEventListener('click', () => {
        _ecOverviewMonthDate = new Date(_ecOverviewMonthDate.getFullYear(), _ecOverviewMonthDate.getMonth() + 1, 1);
        _ecSyncOverviewSelect();
        _ecRenderOverview();
    });
}

function _ecSyncOverviewSelect() {
    const sel = document.getElementById('ecOverviewMonthSelect');
    if (!sel || !_ecOverviewMonthDate) return;
    const key = `${_ecOverviewMonthDate.getFullYear()}-${String(_ecOverviewMonthDate.getMonth() + 1).padStart(2, '0')}`;
    let opt = [...sel.options].find(o => o.value === key);
    if (!opt) {
        opt = document.createElement('option');
        opt.value = key;
        opt.textContent = MONTH_NAMES[_ecOverviewMonthDate.getMonth()] + ' ' + _ecOverviewMonthDate.getFullYear();
        sel.appendChild(opt);
    }
    sel.value = key;
}

function _ecRenderOverview() {
    const grid = document.getElementById('ecOverviewContent');
    if (!grid) return;
    if (!_ecOverviewMonthDate) _ecOverviewMonthDate = new Date(new Date().getFullYear(), new Date().getMonth(), 1);

    const y   = _ecOverviewMonthDate.getFullYear();
    const m   = _ecOverviewMonthDate.getMonth();
    const key = `${y}-${String(m + 1).padStart(2, '0')}`;

    // Count Mon–Fri working days in the month
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    let workingDays = 0;
    for (let day = 1; day <= daysInMonth; day++) {
        const dow = new Date(y, m, day).getDay();
        if (dow !== 0 && dow !== 6) workingDays++;
    }

    // Count confirmed bookings per room for this month
    const counts = {};
    ROOMS.forEach(r => { counts[r.id] = 0; });
    allRegistrations.forEach(reg => {
        (reg.registration_dates || []).forEach(d => {
            if (d.waitlisted || !d.care_date) return;
            if (d.care_date.startsWith(key)) {
                const roomKey = d.room_id || reg.room_id;
                counts[roomKey] = (counts[roomKey] || 0) + 1;
            }
        });
    });

    const cards = getSortedRooms().map(room => {
        const used    = counts[room.id] || 0;
        const hasCap  = room.capacity != null && room.capacity > 0;
        const cap     = hasCap ? room.capacity * workingDays : 0;
        const pct     = cap > 0 ? Math.min(100, Math.round((used / cap) * 100)) : 0;
        const color   = pct >= 90 ? 'bar-red' : pct >= 70 ? 'bar-orange' : 'bar-green';
        const metaTxt = hasCap
            ? `Max ${room.capacity}/day &middot; ${used} booking${used !== 1 ? 's' : ''}`
            : `Capacity TBD &middot; ${used} booking${used !== 1 ? 's' : ''}`;
        const pctTxt  = hasCap ? `${pct}% utilization` : 'Utilization pending capacity';
        return `
            <div class="cap-card" data-room-id="${room.id}" data-month-key="${key}" role="button" tabindex="0" title="View ${room.label} calendar">
                <h3>${room.label}</h3>
                <p class="cap-meta">${metaTxt}</p>
                <div class="progress-bar"><div class="progress-fill ${color}" style="width:${pct}%"></div></div>
                <p class="cap-pct">${pctTxt}</p>
                <p class="cap-card-hint">Click to view calendar →</p>
            </div>`;
    }).join('');

    grid.innerHTML = `<div class="capacity-grid">${cards}</div>`;
}
