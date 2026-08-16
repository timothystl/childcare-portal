// ============================================================
// staff-headcount — every person in the building, and the drill sheet
// ============================================================
// Asked for on 2026-08-14: "when we run fire drills we need a full center
// count." ProCare answers that with a Center Dashboard — room name, students,
// staff, All Rooms total. This is that, plus the half ProCare does not do:
// ticking each child off as you see them, and keeping the result.
//
// ⚠️ THREE THINGS THIS SCREEN MUST NEVER GET WRONG.
//
// 1. "Present" is the LATEST attendance event, not "has a check-in". A child
//    who went home at noon still has a check-in event all afternoon. Counting
//    that as present sends a teacher back into a building for a child who is
//    sitting in her mother's car. Read `attendance_status`, never `checked_in`.
//
// 2. A count of zero is never quietly displayed as fact. As of 2026-08-14 the
//    center has recorded zero check-ins ever — the staff app shipped two days
//    ago and the habit does not exist yet — so a literal "who is checked in"
//    count would say the building is empty during a fire drill. When nobody
//    has checked in, this screen falls back to who is BOOKED today and says so
//    in the loudest banner on the page. It is better to hand someone a list of
//    56 names to walk than a confident 0.
//
// 3. The tick-off is the record, not the check-in data. Staff tap each child
//    they can physically see. That works identically whether or not anyone
//    checked in this morning, which is why it — and not the pre-fill — is what
//    the drill log stores.
//
// It is a fifth tab, against the four in the design handoff. An evacuation
// count cannot be two taps deep behind a menu, and there is no other surface
// in this app that is reachable while standing on the lawn.

const HC_DRILL_KEY = 'mdo_pending_drill';

let hcData      = null;   // last center_headcount() payload
let hcScope     = 'all';  // 'all' | the signed-in teacher's room id
let hcDrill     = null;   // { startedAt, type, kids:Set, staff:Set }
let hcTimer     = null;
let hcLoading   = false;

const HC_DRILL_LABEL = {
    fire: 'Fire drill', tornado: 'Tornado drill', lockdown: 'Lockdown drill',
    earthquake: 'Earthquake drill', other: 'Drill',
};

function hcEl(id) { return document.getElementById(id); }

function hcRoomLabel(id) {
    const r = (typeof ROOMS !== 'undefined' ? ROOMS : []).find(x => x.id === id);
    if (r) return r.label;
    return id === 'unassigned' ? '❓ Room not known' : (id || '❓ Room not known');
}

// ── Who counts as "in the building" ─────────────────────────
// See note 2 above. `hasCheckins` is what the banner and the labels key off,
// and it is deliberately computed from the data rather than assumed.

function hcSplit(children) {
    const kids = Array.isArray(children) ? children : [];
    const hasCheckins = kids.some(c => c.attendance_status === 'present');
    return {
        hasCheckins,
        // The list to walk. With check-in data it is who is actually here;
        // without it, everyone booked who has not already been signed out.
        expected: hasCheckins
            ? kids.filter(c => c.attendance_status === 'present')
            : kids.filter(c => c.attendance_status !== 'left'),
        notArrived: hasCheckins ? kids.filter(c => c.attendance_status === 'not_arrived') : [],
        left:       kids.filter(c => c.attendance_status === 'left'),
    };
}

function hcByRoom(list) {
    const map = new Map();
    list.forEach(c => {
        const k = c.room_id || 'unassigned';
        if (!map.has(k)) map.set(k, []);
        map.get(k).push(c);
    });
    return map;
}

// ── Load ────────────────────────────────────────────────────

async function hcLoad() {
    if (hcLoading) return;
    hcLoading = true;
    const wrap = hcEl('hcBody');
    if (wrap && !hcData) wrap.innerHTML = '<p class="sl-empty">Counting…</p>';
    try {
        hcData = await centerHeadcount(slStaffId, slPin);
        if (!hcData) {
            if (wrap) wrap.innerHTML = '<p class="sl-empty">Your PIN was not accepted. Sign out and back in.</p>';
            return;
        }
        hcRender();
    } catch (e) {
        console.warn('headcount:', e);
        // ⚠️ Do NOT blank hcData on a failed refresh. A teacher standing
        // outside on a patchy signal must keep the list she already has —
        // losing it mid-drill is worse than showing one that is a minute old.
        if (wrap && !hcData) {
            wrap.innerHTML = '<p class="sl-empty">Could not get the count. Tap Refresh to try again.</p>';
        } else {
            slToast('Could not refresh the count — showing the last one.', 'err');
        }
    } finally {
        hcLoading = false;
    }
}

// ── Render ──────────────────────────────────────────────────

function hcRender() {
    const wrap = hcEl('hcBody');
    if (!wrap || !hcData) return;

    const { hasCheckins, expected, notArrived, left } = hcSplit(hcData.children);
    const staff = Array.isArray(hcData.staff) ? hcData.staff : [];

    const scoped = hcScope === 'all' ? expected : expected.filter(c => (c.room_id || 'unassigned') === hcScope);
    const scopedStaff = hcScope === 'all' ? staff : staff.filter(s => (s.room_id || 'unassigned') === hcScope);

    const asOf = hcData.as_of
        ? new Date(hcData.as_of).toLocaleTimeString('en-US',
            { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })
        : '';

    wrap.innerHTML = [
        hcBanner(hasCheckins, expected.length),
        hcTotals(scoped, scopedStaff, asOf, hasCheckins),
        hcScopeSwitch(),
        hcDrill ? hcDrillBar(scoped, scopedStaff) : hcStartBar(),
        hcRooms(scoped, scopedStaff),
        hcDrill ? '' : hcAside('Not arrived yet', notArrived),
        hcDrill ? '' : hcAside('Already signed out', left),
        hcMissingBar(),
    ].join('');

    hcBind();
}

function hcBanner(hasCheckins, expectedCount) {
    if (hasCheckins) return '';
    // The single most important sentence on the page. See note 2 at the top.
    return `<div class="hc-banner">
        <strong>Nobody has been checked in today.</strong>
        This is the ${expectedCount} ${expectedCount === 1 ? 'child' : 'children'}
        <em>booked</em> for today, not a count of who is here. Walk the list and
        tick off the ones you can see.
    </div>`;
}

function hcTotals(kids, staff, asOf, hasCheckins) {
    const kidLabel = hasCheckins ? 'Children here' : 'Children booked';
    return `<div class="hc-totals">
        <div class="hc-total">
            <span class="hc-num">${kids.length}</span>
            <span class="hc-lab">${kidLabel}</span>
        </div>
        <div class="hc-total">
            <span class="hc-num">${staff.length}</span>
            <span class="hc-lab">Staff clocked in</span>
        </div>
        <div class="hc-total hc-total-sum">
            <span class="hc-num">${kids.length + staff.length}</span>
            <span class="hc-lab">People to account for</span>
        </div>
    </div>
    <p class="hc-asof">Counted at ${slEsc(asOf)} · <button type="button" id="hcRefresh" class="sl-link-btn">Refresh</button></p>`;
}

function hcScopeSwitch() {
    // A teacher wants her own room; the director wants the building. Both, one
    // tap apart, because during a drill neither should be hunting for a filter.
    const mine = slRoomId ? `<button type="button" class="hc-scope ${hcScope !== 'all' ? 'active' : ''}"
                                data-scope="${slEsc(slRoomId)}">My room</button>` : '';
    return `<div class="hc-scopes">
        <button type="button" class="hc-scope ${hcScope === 'all' ? 'active' : ''}" data-scope="all">Whole center</button>
        ${mine}
    </div>`;
}

function hcStartBar() {
    return `<div class="hc-start">
        <label class="sl-field">
            <span>Start a drill</span>
            <select id="hcDrillType">
                <option value="fire">Fire drill</option>
                <option value="tornado">Tornado drill</option>
                <option value="lockdown">Lockdown drill</option>
                <option value="earthquake">Earthquake drill</option>
                <option value="other">Other drill</option>
            </select>
        </label>
        <button type="button" id="hcStartBtn" class="btn-primary sl-btn">Start the clock</button>
        <p class="hc-hint">The clock starts now. Tick each person as you see them,
           then finish — the time, the count and the names are all recorded.</p>
    </div>`;
}

function hcDrillBar(kids, staff) {
    const done = kids.filter(c => hcDrill.kids.has(c.student_id)).length
               + staff.filter(s => hcDrill.staff.has(s.staff_id)).length;
    const total = kids.length + staff.length;
    const all = total > 0 && done === total;
    return `<div class="hc-drillbar ${all ? 'hc-all' : ''}">
        <div class="hc-drill-top">
            <span class="hc-drill-name">${slEsc(HC_DRILL_LABEL[hcDrill.type] || 'Drill')}</span>
            <span class="hc-clock" id="hcClock">0:00</span>
        </div>
        <div class="hc-progress">
            <strong>${done} of ${total}</strong> accounted for
            ${all ? '<span class="hc-allclear">✓ Everyone</span>' : ''}
        </div>
        <div class="hc-drill-actions">
            <button type="button" id="hcFinishBtn" class="btn-primary sl-btn">Finish &amp; record</button>
            <button type="button" id="hcAbandonBtn" class="sl-link-btn">Cancel drill</button>
        </div>
    </div>`;
}

function hcRooms(kids, staff) {
    const kidRooms = hcByRoom(kids);
    const staffRooms = hcByRoom(staff.map(s => ({ ...s, room_id: s.room_id || 'unassigned' })));
    const roomIds = [...new Set([...kidRooms.keys(), ...staffRooms.keys()])].sort();

    if (!roomIds.length) {
        return '<p class="sl-empty">Nobody is booked or clocked in today.</p>';
    }

    return roomIds.map(rid => {
        const rk = kidRooms.get(rid) || [];
        const rs = staffRooms.get(rid) || [];
        return `<section class="hc-room">
            <header class="hc-room-head">
                <span class="hc-room-name">${slEsc(hcRoomLabel(rid))}</span>
                <span class="hc-room-counts">
                    <span title="Children">👶 ${rk.length}</span>
                    <span title="Staff">🧑‍🏫 ${rs.length}</span>
                </span>
            </header>
            <div class="hc-people">
                ${rk.map(c => hcPerson('kid', c.student_id, c.child_name, c.dropin ? 'drop-in' : '')).join('')}
                ${rs.map(s => hcPerson('staff', s.staff_id, s.staff_name, 'staff')).join('')}
            </div>
        </section>`;
    }).join('');
}

function hcPerson(kind, id, name, tag) {
    const ticked = hcDrill && (kind === 'kid' ? hcDrill.kids.has(id) : hcDrill.staff.has(id));
    // Outside a drill these are plain rows, not buttons — there is nothing to
    // tap and a tappable name invites a tap that does nothing.
    if (!hcDrill) {
        return `<div class="hc-person hc-person-static ${kind === 'staff' ? 'hc-is-staff' : ''}">
            <span class="hc-person-name">${slEsc(name || 'Unnamed')}</span>
            ${tag ? `<span class="hc-tag">${slEsc(tag)}</span>` : ''}
        </div>`;
    }
    return `<button type="button" class="hc-person hc-person-tap ${ticked ? 'hc-ticked' : ''} ${kind === 'staff' ? 'hc-is-staff' : ''}"
                data-kind="${kind}" data-id="${slEsc(id)}">
        <span class="hc-check">${ticked ? '✓' : ''}</span>
        <span class="hc-person-name">${slEsc(name || 'Unnamed')}</span>
        ${tag ? `<span class="hc-tag">${slEsc(tag)}</span>` : ''}
    </button>`;
}

function hcAside(title, list) {
    if (!list.length) return '';
    return `<section class="hc-aside">
        <h3>${slEsc(title)} <span class="hc-aside-n">${list.length}</span></h3>
        <p>${list.map(c => slEsc(c.child_name)).join(' · ')}</p>
    </section>`;
}

// ── Drill ───────────────────────────────────────────────────

function hcStartDrill() {
    const type = hcEl('hcDrillType')?.value || 'fire';
    hcDrill = { startedAt: Date.now(), type, kids: new Set(), staff: new Set() };
    hcTick();
    clearInterval(hcTimer);
    hcTimer = setInterval(hcTick, 1000);
    hcRender();
}

function hcTick() {
    if (!hcDrill) return;
    const s = Math.floor((Date.now() - hcDrill.startedAt) / 1000);
    const el = hcEl('hcClock');
    if (el) el.textContent = `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function hcToggle(kind, id) {
    if (!hcDrill) return;
    const set = kind === 'staff' ? hcDrill.staff : hcDrill.kids;
    if (set.has(id)) set.delete(id); else set.add(id);
    hcRender();
}

function hcAbandonDrill() {
    // No confirm() — a mis-tap here costs a re-start, and a modal on a phone
    // held one-handed outside is worse than the mistake it prevents.
    clearInterval(hcTimer);
    hcTimer = null;
    hcDrill = null;
    hcRender();
    slToast('Drill cancelled — nothing was recorded.');
}

async function hcFinishDrill() {
    if (!hcDrill || !hcData) return;

    const { expected } = hcSplit(hcData.children);
    const staff = Array.isArray(hcData.staff) ? hcData.staff : [];
    const seconds = Math.floor((Date.now() - hcDrill.startedAt) / 1000);

    const missingKids  = expected.filter(c => !hcDrill.kids.has(c.student_id));
    const missingStaff = staff.filter(s => !hcDrill.staff.has(s.staff_id));

    const notes = prompt(
        missingKids.length || missingStaff.length
            ? `Not ticked off: ${[...missingKids.map(c => c.child_name), ...missingStaff.map(s => s.staff_name)].join(', ')}.\n\nAnything to note about the drill?`
            : 'Everyone was accounted for. Anything to note about the drill?',
        '') ?? '';

    const payload = {
        drill_type:         hcDrill.type,
        evacuation_seconds: seconds,
        children_present:   expected.length,
        children_accounted: expected.length - missingKids.length,
        staff_present:      staff.length,
        staff_accounted:    staff.length - missingStaff.length,
        notes,
        // ⚠️ The whole roster, as it stood at the moment of the drill. Counts
        // alone cannot answer "who was in the building", and re-deriving it
        // later gives a different answer the first time somebody edits that
        // day's registrations.
        snapshot: {
            source: hcSplit(hcData.children).hasCheckins ? 'checked_in' : 'booked',
            children: expected.map(c => ({
                name: c.child_name, room: c.room_id,
                accounted: hcDrill.kids.has(c.student_id),
            })),
            staff: staff.map(s => ({
                name: s.staff_name, room: s.room_id,
                accounted: hcDrill.staff.has(s.staff_id),
            })),
        },
    };

    const btn = hcEl('hcFinishBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Recording…'; }
    try {
        const id = await logFireDrill(slStaffId, slPin, payload);
        if (!id) { slToast('The drill was not recorded. Check your PIN.', 'err'); return; }
        hcClearPending();
        clearInterval(hcTimer); hcTimer = null; hcDrill = null;
        slToast(`Drill recorded — ${Math.floor(seconds / 60)}m ${seconds % 60}s.`);
        hcRender();
    } catch (e) {
        // Outside, on a phone, with no signal. The drill happened; losing the
        // record because the lawn has one bar is not acceptable, so it is
        // stashed and retried when the connection returns.
        console.warn('drill log:', e);
        hcStashPending(payload);
        slToast('No signal — the drill is saved and will send when you are back online.', 'err');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Finish & record'; }
    }
}

// ── Pending drill (offline) ─────────────────────────────────
// Deliberately NOT part of the child-event queue in staff-log: that queue
// drops an entry the RPC rejects, which is right for a nap start and wrong for
// a licensing record. This one is a single payload, kept until it lands.

function hcStashPending(payload) {
    try { localStorage.setItem(HC_DRILL_KEY, JSON.stringify(payload)); } catch { /* full or blocked */ }
}
function hcClearPending() {
    try { localStorage.removeItem(HC_DRILL_KEY); } catch { /* ignore */ }
}
async function hcFlushPending() {
    if (!slPin || !slStaffId || !navigator.onLine) return;
    let payload;
    try { payload = JSON.parse(localStorage.getItem(HC_DRILL_KEY) || 'null'); } catch { payload = null; }
    if (!payload) return;
    try {
        const id = await logFireDrill(slStaffId, slPin, payload);
        if (id) { hcClearPending(); slToast('The drill from earlier has been recorded.'); }
    } catch { /* still offline — keep it */ }
}

// The handoff puts this on the head count footer, and that placement is the
// point: this screen is where somebody discovers a child is not there. Solid
// coral, full width, and it sits below the room list so a thumb reaching for
// "tick everyone off" cannot catch it by accident.
function hcMissingBar() {
    return `<div class="hc-missing">
        <button type="button" id="hcMissingBtn" class="hc-missing-btn">🚨 Missing child</button>
        <p class="hc-hint">Alerts every staff phone in the building at once, and the
           office. Not a message to the director — everyone searches.</p>
    </div>`;
}

// ── Wiring ──────────────────────────────────────────────────

function hcBind() {
    hcEl('hcMissingBtn')?.addEventListener('click', () => {
        // Offer the children expected today, whatever the room filter is set
        // to: a child who has wandered is by definition not where they should
        // be, and a filtered list is the one that leaves them out.
        const { expected } = hcSplit(hcData?.children || []);
        mcOpenRaise(expected);
    });
    hcEl('hcRefresh')?.addEventListener('click', hcLoad);
    hcEl('hcStartBtn')?.addEventListener('click', hcStartDrill);
    hcEl('hcFinishBtn')?.addEventListener('click', hcFinishDrill);
    hcEl('hcAbandonBtn')?.addEventListener('click', hcAbandonDrill);
    document.querySelectorAll('.hc-scope').forEach(b => {
        b.addEventListener('click', () => { hcScope = b.dataset.scope; hcRender(); });
    });
    document.querySelectorAll('.hc-person-tap').forEach(b => {
        b.addEventListener('click', () => hcToggle(b.dataset.kind, b.dataset.id));
    });
    hcTick();
}

/** Called by staff-nav the first time the tab is opened, and on every reopen. */
function slOpenHeadcountTab() {
    // Always re-count on open. A stale count is the failure mode this screen
    // exists to prevent, and the call is one round trip.
    hcLoad();
}

window.addEventListener('online', hcFlushPending);
