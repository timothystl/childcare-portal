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
}

/** Called each time the Enrollment & Capacity tool is opened from the nav. */
async function renderEnrollCapTool() {
    if (typeof allRegistrations !== 'undefined' && !allRegistrations.length) {
        try { allRegistrations = await fetchAllRegistrations(); } catch (err) { console.warn('renderEnrollCapTool:', err); }
    }
    if (_ecView === 'day') _ecRenderDay();
    else if (_ecView === 'fte') _ecRenderFte();
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

const _EC_VIEW_ID = { day: 'ecDayView', week: 'ecWeekView', month: 'ecMonthView', fte: 'ecFteView' };

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
            if (row) showDayRosterDetail(_ecDate, row.room.id, row.enrolled, row.cap);
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
