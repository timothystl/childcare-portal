// ============================================================
// admin-attendance — the live attendance board (design handoff `1d`)
// ============================================================
// "Live center-wide view: every room, who is in, who is expected, staff
// present, ratio status per room. This is the office mirror of the teachers'
// head count — including a missing-child alert state, which lights up here at
// the same moment it hits every staff phone."
//
// ⚠️ IT IS THE SAME QUERY AS THE TEACHERS' HEAD COUNT, DELIBERATELY.
// center_headcount_admin() and center_headcount() both call
// center_headcount_rows() — one body, two authorization wrappers. The
// temptation is to write a nicer admin-side query here; do not. The office and
// the lawn disagreeing about who is in the building, during a fire drill, is
// the worst failure this screen has.
//
// ⚠️ 'present' MEANS THE LATEST ATTENDANCE EVENT, NOT `checked_in`.
// `checked_in` is EXISTS(check_in) and stays true after a child goes home. Every
// count on this page reads attendance_status.
//
// ⚠️ NOBODY HAS EVER CHECKED IN. child_day_events was empty when this was
// built — the staff app shipped 2026-08-12 and the habit does not exist yet —
// so a literal "who is checked in" board says the building is empty. This board
// therefore falls back to who is BOOKED today and says so in a banner. That
// fallback cannot be deleted once check-ins start: a day where nobody happened
// to tap Check in looks exactly the same as a day before the habit existed.

let _abData    = null;
let _abAlerts  = [];
let _abTimer   = null;
let _abActionsBound = false;

function _abEl(id) { return document.getElementById(id); }

// Max children per one staff member. The field is `staffRatio` on ROOMS —
// merged from the 'staff_ratios' setting at runtime, so this reads whatever the
// office last saved rather than the declaration default.
function _abRatio(roomId) {
    const room = (typeof ROOMS !== 'undefined' ? ROOMS : []).find(r => r.id === roomId);
    return Number(room?.staffRatio) || null;
}

function _abRoomLabel(id) {
    const room = (typeof ROOMS !== 'undefined' ? ROOMS : []).find(r => r.id === id);
    return room ? room.label : (id === 'unassigned' ? 'Room not set' : id || '—');
}

function _abTime(iso) {
    return iso ? new Date(iso).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
    }).replace(/\s?([AP])M/i, (_, p) => p.toLowerCase()) : '';
}

function _abInitials(name) {
    return String(name || '').split(/\s+/).filter(Boolean)
        .slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
}

async function renderAttendanceBoard() {
    const wrap = _abEl('attendanceBoardBody');
    if (!wrap) return;
    if (!_abData) wrap.innerHTML = '<p class="muted">Loading…</p>';

    try {
        const [board, alerts] = await Promise.all([
            centerHeadcountAdmin(),
            fetchActiveMissingChildAdmin().catch(() => []),
        ]);
        _abData   = board;
        _abAlerts = alerts || [];
        // In/Out/Absent/Move need each child's registration for today (id for
        // the room move, registration_id for the attendance_records mark) —
        // the head-count RPC doesn't carry either. Same lazy-load guard used
        // throughout the admin app; a no-op after the first load.
        if (typeof allRegistrations !== 'undefined' && !allRegistrations.length) {
            allRegistrations = await fetchAllRegistrations().catch(() => []);
        }
    } catch (e) {
        wrap.innerHTML = `<p class="muted">Could not load the board: ${escHtml(e.message || e)}</p>`;
        return;
    }
    if (!_abData) {
        wrap.innerHTML = '<p class="muted">Only the office can open this board.</p>';
        return;
    }
    _abRender();
    _abBindActions();
    _abStartRefresh();
}

// 'staff'-role admin logins get a read-only board — CLAUDE.md documents that
// role as "Classrooms tab only (read-only roster view)", and the server-side
// gate on admin_log_child_event/saveAttendanceRecord's underlying RPCs
// already refuses that role; hiding the controls keeps the UI honest about it
// instead of showing buttons that fail.
function _abCanAct() {
    return !(typeof currentAdminRole !== 'undefined' && currentAdminRole === 'staff');
}

// Resolve the registration behind one child's TODAY, for the Absent mark
// (needs registration_id) and the Move dropdown (needs registration_dates.id).
// The head-count RPC returns student_id/child_name/room_id, not either of
// those, so this reads them from the same allRegistrations array every other
// admin day-view tool already uses.
function _abResolveReg(childName) {
    if (typeof allRegistrations === 'undefined' || !_abData?.care_date) return null;
    const dateStr = _abData.care_date;
    const lower   = String(childName || '').toLowerCase();
    for (const reg of allRegistrations) {
        if (String(reg.child_name || '').toLowerCase() !== lower) continue;
        const d = (reg.registration_dates || []).find(x => x.care_date === dateStr && !x.waitlisted);
        if (d) return { registrationId: reg.id, dateId: d.id, roomId: d.room_id || reg.room_id };
    }
    return null;
}

function _abBindActions() {
    if (_abActionsBound) return;
    _abActionsBound = true;
    const wrap = _abEl('attendanceBoardBody');
    if (!wrap) return;

    wrap.addEventListener('click', async (e) => {
        const btn = e.target.closest('.ab-act-btn');
        if (!btn) return;
        const actions   = btn.closest('.ab-actions');
        const studentId = actions?.dataset.student;
        const childName = actions?.dataset.name;
        const act       = btn.dataset.act;
        if (!studentId || !act) return;

        btn.disabled = true;
        try {
            if (act === 'in' || act === 'out') {
                const id = await adminLogChildEvent(studentId, act === 'in' ? 'check_in' : 'check_out');
                if (id == null) throw new Error("couldn't record — check your admin role or today's booking");
            } else if (act === 'absent') {
                const wasAbsent = btn.classList.contains('is-on');
                const reg = _abResolveReg(childName);
                if (wasAbsent) {
                    if (reg) await clearAttendanceRecord(reg.registrationId, _abData.care_date);
                } else {
                    if (!reg) throw new Error('no booking found for today');
                    await saveAttendanceRecord({
                        registrationId: reg.registrationId, careDate: _abData.care_date,
                        roomId: reg.roomId, childName, status: 'absent',
                    });
                }
            }
            await renderAttendanceBoard();
        } catch (err) {
            alert(`Couldn't update attendance: ${err.message}`);
            btn.disabled = false;
        }
    });

    wrap.addEventListener('change', async (e) => {
        const sel = e.target.closest('.ab-move-select');
        if (!sel || !sel.value) return;
        const actions   = sel.closest('.ab-actions');
        const childName = actions?.dataset.name;
        const fromRoomId = actions?.dataset.room;
        const toRoomId   = sel.value;
        const reg = _abResolveReg(childName);
        if (!reg) { alert('No booking found for today.'); sel.value = ''; return; }

        const fromLabel = _abRoomLabel(fromRoomId);
        const toLabel   = _abRoomLabel(toRoomId);
        if (!confirm(`Move ${childName} from ${fromLabel} to ${toLabel} for today only?`)) {
            sel.value = '';
            return;
        }
        sel.disabled = true;
        try {
            await updateRegistrationDateRoom(reg.dateId, toRoomId);
            await renderAttendanceBoard();
        } catch (err) {
            alert('Move failed: ' + err.message);
            sel.disabled = false;
            sel.value = '';
        }
    });
}

function _abActionsHtml(c, roomId) {
    const otherRooms = (typeof ROOMS !== 'undefined' ? ROOMS : [])
        .filter(r => r.id !== roomId && r.status !== 'coming_soon');
    const moveOptions = otherRooms.map(r => `<option value="${r.id}">${escHtml(r.label)}</option>`).join('');
    return `<span class="ab-actions" data-student="${escHtml(c.student_id)}"
                  data-name="${escHtml(c.child_name)}" data-room="${escHtml(roomId)}">
        <button type="button" class="ab-act-btn${c.attendance_status === 'present' ? ' is-on' : ''}"
                data-act="in" title="Mark ${escHtml(c.child_name)} checked in">In</button>
        <button type="button" class="ab-act-btn${c.attendance_status === 'left' ? ' is-on' : ''}"
                data-act="out" title="Mark ${escHtml(c.child_name)} checked out">Out</button>
        <button type="button" class="ab-act-btn ab-act-absent${c.marked === 'absent' ? ' is-on' : ''}"
                data-act="absent" title="Mark ${escHtml(c.child_name)} absent">Absent</button>
        <select class="ab-move-select" title="Move ${escHtml(c.child_name)} to another room today">
            <option value="">Move &rarr;</option>
            ${moveOptions}
        </select>
    </span>`;
}

// A board titled "Live" that is five minutes stale is worse than one that says
// nothing. 30s while the tool is open, stopped as soon as it is not.
function _abStartRefresh() {
    if (_abTimer) return;
    _abTimer = setInterval(() => {
        if (!document.getElementById('attendanceBoardBody')?.offsetParent) { _abStopRefresh(); return; }
        renderAttendanceBoard();
    }, 30000);
}

function _abStopRefresh() {
    if (_abTimer) { clearInterval(_abTimer); _abTimer = null; }
}

function _abRender() {
    const wrap = _abEl('attendanceBoardBody');
    const kids  = _abData.children || [];
    const staff = _abData.staff || [];

    const present    = kids.filter(c => c.attendance_status === 'present');
    const left       = kids.filter(c => c.attendance_status === 'left');
    const notIn      = kids.filter(c => c.attendance_status === 'not_arrived' && c.marked !== 'absent');
    const absent     = kids.filter(c => c.marked === 'absent');
    const expected   = kids.filter(c => c.marked !== 'absent');
    const hasCheckins = kids.some(c => c.attendance_status !== 'not_arrived');
    const allergyKids = kids.filter(c => _abAllergySummary(c.allergies));

    // Rooms in ROOMS order, plus anything unexpected the data threw up.
    const roomIds = [...new Set([
        ...(typeof ROOMS !== 'undefined' ? ROOMS : []).map(r => r.id),
        ...kids.map(c => c.room_id || 'unassigned'),
    ])].filter(id => kids.some(c => (c.room_id || 'unassigned') === id)
                  || staff.some(s => (s.room_id || 'unassigned') === id));

    const atLimit = roomIds.filter(id => _abRoomRatio(id, present, staff, hasCheckins).state === 'limit');
    const over    = roomIds.filter(id => _abRoomRatio(id, present, staff, hasCheckins).state === 'over');

    wrap.innerHTML = `
        ${_abAlerts.length ? _abAlertBar() : ''}
        ${!hasCheckins ? `<div class="ab-fallback">
            <strong>Nobody has checked in today.</strong> This board is showing who is
            <em>booked</em> for ${escHtml(_abData.care_date)} — not who is in the building.
            Counts become live the moment teachers start tapping Check in.
        </div>` : ''}

        <div class="ab-head">
            <p class="ab-live">Live · ${escHtml(_abTime(_abData.as_of))} ·
               updates as teachers check children in on the floor</p>
            <button class="btn-ghost ab-refresh" id="abRefresh">Refresh</button>
        </div>

        <div class="ab-tiles">
            ${_abTile('Here now', hasCheckins ? present.length : '—',
                      hasCheckins ? `of ${expected.length} expected` : `${expected.length} booked today`,
                      hasCheckins && present.length ? 'ok' : '')}
            ${_abTile('Not in yet', hasCheckins ? notIn.length : expected.length,
                      left.length ? `${left.length} already signed out` : 'none signed out yet',
                      hasCheckins && notIn.length ? 'warn' : '')}
            ${_abTile('Marked absent', absent.length,
                      absent.length ? 'recorded by the office' : 'none recorded', '')}
            ${_abTile('Ratio watch', over.length ? `${over.length} room${over.length > 1 ? 's' : ''}`
                                    : atLimit.length ? `${atLimit.length} room${atLimit.length > 1 ? 's' : ''}` : 'Clear',
                      over.length ? 'over ratio' : atLimit.length ? 'at the limit' : 'every room inside ratio',
                      over.length ? 'bad' : atLimit.length ? 'warn' : 'ok')}
            ${_abTile('Allergies present', allergyKids.length,
                      allergyKids.length ? _abAllergyWords(allergyKids) : 'none on today’s list',
                      allergyKids.length ? 'warn' : '')}
        </div>

        <div class="ab-rooms">
            ${roomIds.map(id => _abRoom(id, kids, staff, hasCheckins)).join('')
              || '<p class="muted">Nobody is booked or clocked in today.</p>'}
        </div>`;

    _abEl('abRefresh')?.addEventListener('click', renderAttendanceBoard);
}

function _abTile(label, value, sub, tone) {
    return `<div class="ab-tile${tone ? ' is-' + tone : ''}">
        <div class="ab-tile-label">${escHtml(label)}</div>
        <div class="ab-tile-value">${escHtml(String(value))}</div>
        <div class="ab-tile-sub">${escHtml(sub)}</div>
    </div>`;
}

// center_headcount_rows() returns allergies as an array of {label, severity}
// chips (the same shape admin-families.js's allergy editor writes), not a
// string — this flattens it to one displayable line. Defensive against a
// bare string too, in case a caller somewhere still has the older shape.
function _abAllergySummary(allergies) {
    if (Array.isArray(allergies)) {
        return allergies.map(a => (a && a.label) || '').filter(Boolean).join(', ');
    }
    return String(allergies || '').trim();
}

// The three or four distinct allergens, not a list of children — the tile
// answers "what is in the building today", which is what a kitchen needs.
function _abAllergyWords(kids) {
    const words = new Set();
    for (const k of kids) {
        for (const part of _abAllergySummary(k.allergies).split(/[,;\n]/)) {
            const w = part.trim().split(/\s+/)[0];
            if (w) words.add(w.replace(/[^a-zA-Z-]/g, '').toLowerCase());
        }
    }
    return [...words].slice(0, 4).join(' · ') || 'on file';
}

function _abRoomRatio(roomId, present, staff, hasCheckins) {
    const inRoom    = present.filter(c => (c.room_id || 'unassigned') === roomId).length;
    const staffHere = staff.filter(s => (s.room_id || 'unassigned') === roomId).length;
    const ratio     = _abRatio(roomId);

    // With no check-ins and no clock-ins there is nothing to judge, and a red
    // "OVER RATIO" on an empty building teaches the director to ignore the tile.
    if (!ratio || !hasCheckins || !staffHere) return { state: 'unknown', inRoom, staffHere, ratio };

    const allowed = staffHere * ratio;
    if (inRoom > allowed)      return { state: 'over',  inRoom, staffHere, ratio, allowed };
    if (inRoom === allowed)    return { state: 'limit', inRoom, staffHere, ratio, allowed };
    return { state: 'ok', inRoom, staffHere, ratio, allowed };
}

function _abRoom(roomId, kids, staff, hasCheckins) {
    const roomKids  = kids.filter(c => (c.room_id || 'unassigned') === roomId);
    const roomStaff = staff.filter(s => (s.room_id || 'unassigned') === roomId);
    const present   = roomKids.filter(c => c.attendance_status === 'present');
    const expected  = roomKids.filter(c => c.marked !== 'absent');
    const r = _abRoomRatio(roomId, kids.filter(c => c.attendance_status === 'present'),
                           staff, hasCheckins);

    const pill = {
        over:  `<span class="ab-pill bad">1:${r.ratio} OVER RATIO</span>`,
        limit: `<span class="ab-pill warn">1:${r.ratio} AT LIMIT</span>`,
        ok:    `<span class="ab-pill ok">1:${r.ratio}</span>`,
        unknown: r.ratio ? `<span class="ab-pill">1:${r.ratio} required</span>` : '',
    }[r.state];

    const canAct = _abCanAct();
    const rows = roomKids.map(c => {
        const allergy = _abAllergySummary(c.allergies);
        let mark, cls;
        if (c.marked === 'absent')                  { mark = 'ABSENT'; cls = 'is-absent'; }
        else if (c.attendance_status === 'present') { mark = _abTime(c.last_event_at); cls = 'is-in'; }
        else if (c.attendance_status === 'left')    { mark = `out ${_abTime(c.last_event_at)}`; cls = 'is-out'; }
        else                                        { mark = hasCheckins ? 'not in' : 'booked'; cls = 'is-waiting'; }

        return `<div class="ab-kid ${cls}">
            <span class="ab-av">${escHtml(_abInitials(c.child_name))}</span>
            <span class="ab-kid-name">${escHtml(c.child_name)}${
                c.dropin ? '<span class="ab-dropin">drop-in</span>' : ''}</span>
            <span class="ab-kid-mark">${allergy ? `<span title="${escHtml(allergy)}">⚠️</span> ` : ''}${escHtml(mark)}</span>
            ${canAct ? _abActionsHtml(c, roomId) : ''}
        </div>`;
    }).join('');

    return `<section class="ab-room${r.state === 'over' ? ' is-over' : ''}">
        <header class="ab-room-head">
            <div class="ab-room-name">${escHtml(_abRoomLabel(roomId))}</div>
            <div class="ab-room-staff">${roomStaff.length
                ? escHtml(roomStaff.map(s => s.staff_name).join(' · '))
                : '<em>nobody clocked in</em>'}</div>
            <div class="ab-room-count">
                <span>${hasCheckins ? `${present.length} of ${expected.length}` : `${expected.length} booked`}</span>
                ${pill}
            </div>
        </header>
        <div class="ab-kids">${rows || '<p class="ab-empty">Nobody booked.</p>'}</div>
        ${r.state === 'over' ? `<p class="ab-warn">This room is over its licensed ratio.
            Move a child or add staff now.</p>` : ''}
        ${r.state === 'limit' ? `<p class="ab-warn">One more child puts this room over ratio.
            Add staff before accepting a drop-in.</p>` : ''}
    </section>`;
}

// The same alert the teachers see, at the same moment. Not a summary of it —
// the searchers list is what tells the office who is already looking where.
function _abAlertBar() {
    return _abAlerts.map(a => `
        <div class="ab-alert" role="alert">
            <div class="ab-alert-top">
                <span class="ab-siren" aria-hidden="true">🚨</span>
                <div>
                    <div class="ab-alert-name">${escHtml(a.child_name)} is missing</div>
                    <div class="ab-alert-meta">${escHtml([
                        _abRoomLabel(a.room_id),
                        a.wearing ? `wearing ${a.wearing}` : '',
                        a.last_seen ? `last seen ${a.last_seen}` : '',
                        `raised by ${a.raised_by_name || 'staff'} at ${_abTime(a.raised_at)}`,
                    ].filter(Boolean).join(' · '))}</div>
                </div>
            </div>
            <div class="ab-alert-searchers">${
                (a.searchers || []).length
                    ? `<strong>${a.searchers.length} searching:</strong> ` +
                      a.searchers.map(s => escHtml(s.name + (s.searching ? ` (${s.searching})` : ''))).join(', ')
                    : '<strong>Nobody has answered yet.</strong> Get on the floor.'}
            </div>
        </div>`).join('');
}
