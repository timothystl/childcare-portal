// ============================================================
// staff-log — the staff phone app (Phase 1)
// ============================================================
// Replaces the ProCare logging staff do all day. Design: PARENT_PORTAL_PLAN §5.
//
// Two constraints shape everything here:
//
//   1. IF IT TAKES MORE THAN ABOUT A MINUTE, STAFF WON'T DO IT and the parent
//      feed is empty. So logging is one tap from the roster, commits
//      optimistically, and never blocks on the network.
//   2. Staff have no Supabase account. Their credential is the kiosk PIN, and
//      every write goes through log_child_event — a PIN-gated SECURITY DEFINER
//      RPC. There are no table grants behind this page.
//
// THE PIN IS HELD IN MEMORY ONLY. Not localStorage, not sessionStorage. It is a
// credential that unlocks writes for every child in the building, and a phone
// left on a changing table should not carry it across a reload. The cost is
// re-entry after a refresh, which is rare once installed as a PWA.

const SL_QUEUE_KEY = 'mdo_staff_log_queue';

let slPin       = null;   // memory only — see above
let slStaff     = null;
let slStaffId   = null;   // chosen on the picker, sent with every write
let slRoomId    = null;
let slChildren  = [];
let slOpenChild = null;
let slQueue     = [];     // pending events; persisted WITHOUT the pin

function slEl(id) { return document.getElementById(id); }

function slEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function slToast(msg, kind = 'ok') {
    const t = slEl('slToast');
    if (!t) return;
    t.textContent = msg;
    t.className = `sl-toast sl-toast-${kind}`;
    t.classList.remove('hidden');
    clearTimeout(slToast._t);
    slToast._t = setTimeout(() => t.classList.add('hidden'), 2600);
}

// ── Screens ─────────────────────────────────────────────────

function slShow(screen) {
    ['slPinScreen', 'slRoomScreen', 'slRosterScreen'].forEach(id => {
        slEl(id)?.classList.toggle('hidden', id !== screen);
    });
}

// ── Sign in ─────────────────────────────────────────────────

async function slLoadStaffPicker() {
    const sel = slEl('slStaffSelect');
    if (!sel) return;
    try {
        const staff = await listStaffForSignin();
        sel.innerHTML = '<option value="">Choose your name…</option>' +
            staff.map(s => `<option value="${slEsc(s.id)}">${slEsc(s.name)}</option>`).join('');
    } catch (e) {
        console.warn('staff list:', e);
        slToast('Could not load the staff list.', 'err');
    }
}

async function slSignIn() {
    const staffId = slEl('slStaffSelect')?.value || '';
    const pin     = (slEl('slPinInput')?.value || '').trim();

    // Identity first. A PIN with no name was the whole weakness: it was tested
    // against every staff hash, so one guess had ~33 chances to land and there
    // was no account to lock.
    if (!staffId)             { slToast('Choose your name first.', 'err'); return; }
    if (!/^\d{4,8}$/.test(pin)) { slToast('Enter your PIN.', 'err'); return; }

    const btn = slEl('slPinBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
        const res = await verifyStaffPin(staffId, pin);

        if (res?.error === 'locked') {
            // Say why. Someone locked out by another person's guessing should
            // not think their own PIN has stopped working.
            const until = res.until ? new Date(res.until).toLocaleTimeString('en-US',
                { hour: 'numeric', minute: '2-digit' }) : 'shortly';
            slToast(`Too many wrong tries — locked until ${until}. Ask the office.`, 'err');
            return;
        }
        if (res?.error === 'throttled') {
            slToast('Too many attempts on this device. Wait a few minutes.', 'err');
            return;
        }
        if (!res) { slToast('That PIN was not recognized.', 'err'); return; }

        slPin     = pin;
        slStaffId = res.id;
        slStaff   = res;
        slEl('slPinInput').value = '';
        slEl('slWhoami').textContent = res.name || 'Signed in';
        const acct = slEl('slAccountName');
        if (acct) acct.textContent = res.name || '';
        slRenderRooms();
        // Someone assigned to a room goes straight there — the picker is a
        // fallback for floaters and the director, not a toll gate.
        if (res.room_id) { slOpenRoom(res.room_id); } else { slShow('slRoomScreen'); }
        slFlushQueue();
        // A drill recorded on the lawn with no signal is stashed rather than
        // lost; this is the first moment there is a PIN to send it with.
        if (typeof hcFlushPending === 'function') hcFlushPending();
        // Start listening for a missing-child broadcast the moment there is a
        // PIN to poll with. It runs on every tab, not just the head count —
        // whoever is standing next to the child is not necessarily the person
        // looking at the count screen.
        if (typeof mcStartPolling === 'function') mcStartPolling();
        // Ask this phone to register for the missing-child alert. Passing the
        // PIN explicitly: slPin is cleared on a screen change, and by the time
        // somebody taps Allow the global is often already empty.
        if (typeof slInitPush === 'function') slInitPush(res.id, pin);
    } catch (e) {
        console.warn('staff sign-in:', e);
        slToast('Could not reach the server.', 'err');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
    }
}

function slSignOut() {
    slPin = null; slStaff = null; slStaffId = null; slRoomId = null; slChildren = [];
    // Stop polling before clearing the screen: the alert RPC is PIN-gated and
    // would start failing on every tick otherwise.
    if (typeof mcStopPolling === 'function') mcStopPolling();
    slShow('slPinScreen');
}

// ── Rooms ───────────────────────────────────────────────────

function slRenderRooms() {
    const wrap = slEl('slRoomList');
    if (!wrap) return;
    wrap.innerHTML = ROOMS
        .filter(r => r.status === 'active' || r.status === 'seasonal')
        .map(r => `<button type="button" class="sl-room-btn" data-room="${slEsc(r.id)}">
                       <span class="sl-room-label">${slEsc(r.label)}</span>
                       <span class="sl-room-ages">${slEsc(r.ages)}</span>
                   </button>`).join('');
    wrap.querySelectorAll('.sl-room-btn').forEach(b => {
        b.addEventListener('click', () => slOpenRoom(b.dataset.room));
    });
}

async function slOpenRoom(roomId) {
    slRoomId = roomId;
    const room = (typeof getStaffRoomOptions === 'function' ? getStaffRoomOptions() : ROOMS)
        .find(r => r.id === roomId);
    slEl('slRoomTitle').textContent = room ? room.label : 'Room';
    slShow('slRosterScreen');
    if (typeof slInitTabs === 'function') slInitTabs();
    slEl('slRoster').innerHTML = '<p class="sl-empty">Loading…</p>';
    await slLoadRoster();
}

async function slLoadRoster() {
    try {
        slChildren = await listRoomChildren(slStaffId, slPin, slRoomId);
        slRenderRoster();
        slLoadThreads();          // fire-and-forget: the badge fills in as it lands
    } catch (e) {
        console.warn('roster:', e);
        slEl('slRoster').innerHTML = '<p class="sl-empty">Could not load the roster. Pull to retry.</p>';
    }
}

// ── Allergy chips ───────────────────────────────────────────
// Severe is solid --tang on white; sensitivities and care notes are outlined.
// Same visual language as the admin family editor, so a chip means the same
// thing wherever staff see it.
const SL_SEV_STYLE = {
    severe:      'background:var(--tang);color:#fff;border:1.5px solid var(--tang)',
    sensitivity: 'background:#fff;color:var(--tang-dark);border:1.5px solid var(--tang-soft)',
    note:        'background:#fff;color:#5a6673;border:1.5px solid #d7dee5',
};

function slAllergyChips(allergies) {
    const list = Array.isArray(allergies) ? allergies : [];
    if (!list.length) return '';
    return list.map(a => {
        const style = SL_SEV_STYLE[a.severity] || SL_SEV_STYLE.note;
        return `<span class="sl-chip" style="${style}">${slEsc(a.label)}</span>`;
    }).join('');
}

function slRenderRoster() {
    const wrap = slEl('slRoster');
    if (!wrap) return;
    if (!slChildren.length) {
        wrap.innerHTML = '<p class="sl-empty">Nobody is booked into this room today.</p>';
        return;
    }
    wrap.innerHTML = slChildren.map(c => {
        const chips = slAllergyChips(c.allergies);
        // ⚠️ attendance_status, NOT checked_in. `checked_in` is EXISTS(check_in)
        // and stays true all afternoon after a child goes home; it is kept in
        // the RPC only so an old cached bundle does not break. Three states,
        // because "Out" and "Not in" are different facts and the head count
        // screen distinguishes them — two screens must not disagree.
        const st = c.attendance_status
            || (c.checked_in ? 'present' : 'not_arrived');   // pre-upgrade payload
        const state = st === 'present' ? { cls: 'in',   text: 'In' }
                    : st === 'left'    ? { cls: 'out',  text: 'Out' }
                    :                    { cls: '',     text: 'Not in' };
        return `<button type="button" class="sl-child" data-student="${slEsc(c.student_id)}">
            <span class="sl-child-top">
                <span class="sl-child-name">${slEsc(c.child_name)}</span>
                <span class="sl-child-state ${state.cls}">${state.text}</span>
            </span>
            ${chips ? `<span class="sl-child-chips">${chips}</span>` : ''}
        </button>`;
    }).join('');
    wrap.querySelectorAll('.sl-child').forEach(b => {
        b.addEventListener('click', () => slOpenSheet(b.dataset.student));
    });
}

// ── Quick-log sheet ─────────────────────────────────────────

// event_type, label, and the detail the chip commits. Kept as data so the
// sheet's contents are one list to read rather than markup to trace.
const SL_ACTIONS = [
    { type: 'check_in',   label: 'Check in',  group: 'attendance' },
    { type: 'check_out',  label: 'Check out', group: 'attendance' },
    { type: 'nap_start',  label: 'Nap start', group: 'nap' },
    { type: 'nap_end',    label: 'Nap end',   group: 'nap' },
    { type: 'diaper', label: 'Wet',   group: 'diaper', detail: { kind: 'wet' } },
    { type: 'diaper', label: 'BM',    group: 'diaper', detail: { kind: 'bm' } },
    { type: 'diaper', label: 'Dry',   group: 'diaper', detail: { kind: 'dry' } },
    { type: 'meal', label: 'Ate none', group: 'meal', detail: { amount: 'none' } },
    { type: 'meal', label: 'Some',     group: 'meal', detail: { amount: 'some' } },
    { type: 'meal', label: 'Most',     group: 'meal', detail: { amount: 'most' } },
    { type: 'meal', label: 'All',      group: 'meal', detail: { amount: 'all' } },
    { type: 'supplies', label: 'Needs supplies', group: 'other' },
];

const SL_GROUP_LABEL = {
    attendance: 'Attendance', nap: 'Nap', diaper: 'Diaper',
    meal: 'Meal', bottle: 'Bottle', other: 'Other',
};

function slOpenSheet(studentId) {
    const child = slChildren.find(c => String(c.student_id) === String(studentId));
    if (!child) return;
    slOpenChild = child;

    slEl('slSheetName').textContent = child.child_name || 'Child';

    // ⚠️ The allergy panel renders ABOVE every input, always, even when empty.
    // A member of staff reaching for the bottle chip should not have to
    // remember to scroll up to find out this child cannot have dairy.
    const chips = slAllergyChips(child.allergies);
    const notes = (child.care_notes || '').trim();

    // ⚠️ "Nothing recorded" is NOT the same as "no allergies", and the panel
    // must never let one read as the other. An empty list used to print "No
    // allergies or care notes on file" — an affirmative all-clear — for a child
    // nobody had reviewed. allergies_reviewed says which of the two this is.
    let panel, cls;
    if (chips || notes) {
        panel = `${chips ? `<div class="sl-safety-chips">${chips}</div>` : ''}
                 ${notes ? `<div class="sl-safety-note">${slEsc(notes)}</div>` : ''}`;
        cls   = 'sl-safety';
    } else if (child.allergies_reviewed) {
        panel = '<div class="sl-safety-none">No allergies or care notes on file.</div>';
        cls   = 'sl-safety sl-safety-empty';
    } else {
        panel = '<div class="sl-safety-unknown">⚠️ Allergies not yet recorded for '
              + slEsc((child.child_name || 'this child').split(' ')[0])
              + '. Check the paper file before any food or bottle.</div>';
        cls   = 'sl-safety sl-safety-warn';
    }
    slEl('slSheetSafety').innerHTML = panel;
    slEl('slSheetSafety').className = cls;

    // Bottle gets its own row because it carries an amount. Infants only in
    // practice, but the plan says show diapering everywhere and simply ignore
    // it for the oldest, so the same applies here — staff judge, not the UI.
    const groups = ['attendance', 'nap', 'diaper', 'bottle', 'meal', 'other'];
    slEl('slSheetActions').innerHTML = groups.map(g => {
        if (g === 'bottle') {
            return `<div class="sl-group"><div class="sl-group-label">${SL_GROUP_LABEL.bottle}</div>
                <div class="sl-bottle-row">
                    ${[2, 4, 6, 8].map(oz =>
                        `<button type="button" class="sl-act" data-bottle="${oz}">${oz} oz</button>`).join('')}
                </div></div>`;
        }
        const acts = SL_ACTIONS.filter(a => a.group === g);
        if (!acts.length) return '';
        return `<div class="sl-group"><div class="sl-group-label">${SL_GROUP_LABEL[g]}</div>
            <div class="sl-act-row">
                ${acts.map((a, i) => `<button type="button" class="sl-act" data-act="${g}:${i}">${slEsc(a.label)}</button>`).join('')}
            </div></div>`;
    }).join('');

    slEl('slSheetActions').querySelectorAll('[data-act]').forEach(b => {
        const [g, i] = b.dataset.act.split(':');
        const act = SL_ACTIONS.filter(a => a.group === g)[Number(i)];
        b.addEventListener('click', () => slCommit(act.type, act.detail || {}, b));
    });
    slEl('slSheetActions').querySelectorAll('[data-bottle]').forEach(b => {
        b.addEventListener('click', () => slCommit('bottle', { oz: Number(b.dataset.bottle) }, b));
    });

    // The photo control reflects consent rather than failing after the fact.
    const photoBtn = slEl('slPhotoBtn');
    if (photoBtn) {
        const released = child.photo_release === true;
        photoBtn.disabled = !released;
        photoBtn.textContent = released ? '📷 Add a photo' : 'Not photo-released';
    }

    slEl('slSheet').classList.remove('hidden');
}

function slCloseSheet() {
    slEl('slSheet').classList.add('hidden');
    slOpenChild = null;
}

// ── Messages ────────────────────────────────────────────────
// ⚠️ Threads are PER CHILD now (per_child_message_threads.sql), and the room
// scope follows the THREAD'S OWN child rather than the family. A Bee Room
// teacher used to see a family's single thread because any child of that
// family was in her room today — including a conversation about a sibling in
// another room. staff_can_see_thread() and staff_list_threads() both test the
// thread's student now; a general thread (student_id IS NULL) still falls back
// to the family-wide rule.
//
// A teacher only sees threads for families with a child on THEIR room's roster
// today — the scoping is enforced in the RPC, not here. Messages can be about
// custody, health or money, and a Bee Room teacher has no business reading the
// Owl Room's.

let slThreads  = [];
let slOpenThread = null;

async function slLoadThreads() {
    try {
        slThreads = await staffListThreads(slStaffId, slPin, slRoomId);
    } catch (e) {
        // ⚠️ Do NOT clear slThreads here. Zeroing it repaints the badge to 0,
        // so one dropped request makes a real "3 families are waiting on you"
        // silently vanish. A stale count is far better than a wrong one.
        console.warn('threads:', e);
        return;
    }
    slRenderThreadBadge();
    // Re-render the list if the tab is already open, so a background refresh
    // from slLoadRoster does not leave a stale list on screen.
    if (typeof slRoute !== 'undefined' && slRoute === 'messages') slRenderThreadList();
}

// What the Messages TAB calls. Renders immediately so the pane is never blank
// — the sheet used to render on open, and removing it took that with it.
async function slOpenMessagesTab() {
    const wrap = slEl('slThreadList');
    if (wrap && !slThreads.length) wrap.innerHTML = '<p class="sl-empty">Loading…</p>';
    if (!slThreads.length) await slLoadThreads();
    // slLoadThreads returns early on failure, so an empty list here can mean
    // "nothing to show" OR "the request died". Render either way — a pane stuck
    // on "Loading…" forever is the worst of the three.
    slRenderThreadList();
}

// The count now rides on the Messages TAB rather than a button on the roster.
// Staff are logging, not reading an inbox — the badge says "someone is waiting
// on you" and nothing more.
function slRenderThreadBadge() {
    const unread = slThreads.reduce((n, t) => n + (t.unread || 0), 0);
    if (typeof slSetBadge === 'function') slSetBadge('messages', unread);
}

function slRenderThreadList() {
    const wrap = slEl('slThreadList');
    if (!wrap) return;
    slOpenThread = null;
    slEl('slThreadView')?.classList.add('hidden');
    wrap.classList.remove('hidden');

    if (!slThreads.length) {
        wrap.innerHTML = '<p class="sl-empty">No messages from families in this room today.</p>';
        return;
    }
    wrap.innerHTML = slThreads.map(t => `
        <button type="button" class="sl-thread" data-thread="${t.thread_id}">
            <span class="sl-thread-top">
                <span class="sl-thread-name">${slEsc(t.child_name || t.family_name || 'Family')}</span>
                ${t.unread ? `<span class="sl-thread-unread">${t.unread}</span>` : ''}
            </span>
            <span class="sl-thread-sub">${slEsc(t.child_name ? (t.family_name || 'Family') : 'Family conversation')}</span>
            <span class="sl-thread-last">${slEsc(t.last_body || 'No messages yet')}</span>
        </button>`).join('');
    wrap.querySelectorAll('.sl-thread').forEach(b => {
        b.addEventListener('click', () => slOpenThreadView(Number(b.dataset.thread)));
    });
}

async function slOpenThreadView(threadId) {
    slOpenThread = threadId;
    slEl('slThreadList')?.classList.add('hidden');
    const view = slEl('slThreadView');
    view?.classList.remove('hidden');
    slEl('slThreadMessages').innerHTML = '<p class="sl-empty">Loading…</p>';

    const t = slThreads.find(x => Number(x.thread_id) === threadId);
    slEl('slThreadWho').textContent = t?.family_name || 'Family';

    try {
        // Opening marks the parent's messages read server-side, which is what
        // drives the receipt they see.
        const items = await staffThreadMessages(slStaffId, slPin, threadId);
        slEl('slThreadMessages').innerHTML = items.length
            ? items.map(m => `<div class="sl-msg ${m.sender_type === 'parent' ? 'sl-msg-them' : 'sl-msg-us'}">
                    <span class="sl-msg-who">${slEsc(m.sender_type === 'parent' ? (m.sender_name || 'Parent') : (m.sender_name || 'You'))}</span>
                    <span class="sl-msg-body">${slEsc(m.body)}</span>
                </div>`).join('')
            : '<p class="sl-empty">No messages yet.</p>';
        if (t) { t.unread = 0; slRenderThreadBadge(); }
    } catch (e) {
        console.warn('thread:', e);
        slEl('slThreadMessages').innerHTML = '<p class="sl-empty">Could not load this conversation.</p>';
    }
}

async function slSendThreadMessage() {
    if (!slOpenThread) return;
    const input = slEl('slThreadInput');
    const body = (input?.value || '').trim();
    if (!body) return;

    const btn = slEl('slThreadSendBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
        const id = await staffSendMessage(slStaffId, slPin, slOpenThread, body);
        if (!id) { slToast('That did not send.', 'err'); return; }
        input.value = '';
        await slOpenThreadView(slOpenThread);
    } catch (e) {
        console.warn('send:', e);
        // The box is NOT cleared on failure — retyping a message you already
        // wrote is the most annoying way to lose work.
        slToast('That did not send. Try again.', 'err');
    } finally {
        btn.disabled = false; btn.textContent = 'Send';
    }
}

// ── Incident report ─────────────────────────────────────────
// Moved to js/staff/staff-incident.js — the form grew a time stepper, a body
// map, chip groups and the three-signature flow, and it is the longest screen
// in the app. slOpenIncident / slSubmitIncident live there; this file still
// owns slOpenChild and slToast, which that module reads.

// ── Staff injury report (workers' comp) ─────────────────────
// ⚠️ THIS IS NOT AN INCIDENT REPORT AND DOES NOT GO NEAR ONE. An incident
// report is about a child and ends up in front of that child's family. This is
// about an employee, it is workers' compensation paperwork, and no parent ever
// sees it — separate table, separate RPC, separate queue. See the migration
// header for why merging the two was rejected.
//
// ⚠️ Filing this IS the written notification of injury. Missouri gives an
// employee 30 days to notify the employer in writing and the employer 30 days
// to report to the carrier. The form says so, because someone who thinks
// "I'll mention it Monday" has started a clock they do not know about.
//
// It lives in Account, not on a child's sheet, because it is about the person
// holding the phone rather than anyone on the roster.

async function slOpenInjury() {
    const sel = slEl('slInjWho');
    if (sel) {
        // Who was hurt defaults to the signed-in person but must be
        // changeable: someone with a hurt wrist cannot type, and someone who
        // has left for urgent care is not going to file their own report.
        sel.innerHTML = '<option value="">Me</option>';
        try {
            const staff = await listStaffForSignin();
            sel.innerHTML += staff
                .filter(s => String(s.id) !== String(slStaffId))
                .map(s => `<option value="${slEsc(s.id)}">${slEsc(s.name)}</option>`).join('');
        } catch (e) {
            console.warn('staff list:', e);   // "Me" still works
        }
    }
    slEl('slInjuryForm')?.reset();
    slInjTreatmentChanged();
    slEl('slInjurySheet')?.classList.remove('hidden');
}

function slCloseInjury() {
    slEl('slInjurySheet')?.classList.add('hidden');
}

// Where they were treated only makes sense once they went somewhere.
function slInjTreatmentChanged() {
    const v = slEl('slInjTreatment')?.value;
    slEl('slInjFacilityField')?.classList.toggle('hidden', v !== 'clinic_er');
}

async function slSubmitInjury(e) {
    e.preventDefault();

    const description = slEl('slInjDescription').value.trim();
    const actionTaken = slEl('slInjAction').value.trim();
    if (!description || !actionTaken) {
        slToast('Describe what happened and what was done.', 'err');
        return;
    }

    // A date-time the person types in, so an injury reported the next morning
    // carries the time it actually happened. The RPC clamps a future value.
    const whenRaw = slEl('slInjWhen').value;

    const btn = slEl('slInjSubmitBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
        const id = await submitStaffInjuryReport(slStaffId, slPin, {
            injuredStaffId:    slEl('slInjWho').value || null,
            description,
            actionTaken,
            occurredAt:        whenRaw ? new Date(whenRaw).toISOString() : null,
            location:          slEl('slInjLocation').value.trim(),
            bodyArea:          slEl('slInjBodyArea').value.trim(),
            witness:           slEl('slInjWitness').value.trim(),
            soughtTreatment:   slEl('slInjTreatment').value,
            treatmentFacility: slEl('slInjFacility').value.trim(),
            lostTime:          slEl('slInjLostTime').checked,
        });
        if (!id) { slToast('The report was not accepted. Check your PIN.', 'err'); return; }

        slCloseInjury();
        slToast('Reported. The director has it, date-stamped.', 'ok');
    } catch (err) {
        console.warn('injury:', err);
        // ⚠️ Deliberately NOT queued offline. A queued injury report would sit
        // on a phone with a legal clock running against a date-stamp nobody
        // has. Better to fail visibly and be re-typed than to look filed.
        slToast('Could not send it. Try again — it has not been saved.', 'err');
    } finally {
        btn.disabled = false; btn.textContent = 'Report the injury';
    }
}

// ── Photos ──────────────────────────────────────────────────
// Deliberately NOT part of the offline queue. A queued photo would mean holding
// megabytes of a child's image in localStorage on a personal phone until the
// signal comes back — the storage limit would break it and the privacy cost is
// not worth it. Photos upload now or tell you they didn't.

async function slPhotoPicked(file) {
    if (!file || !slOpenChild) return;

    // Photo release is per child and staff must not have to remember who opted
    // out. A photo of a child who has not been released is simply not offered.
    if (slOpenChild.photo_release !== true) {
        slToast(`${slOpenChild.child_name} is not photo-released.`, 'err');
        return;
    }

    const btn = slEl('slPhotoBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
        const dataUrl = await compressImageToDataUrl(file);
        await uploadChildPhoto(slStaffId, slPin, {
            studentIds: [slOpenChild.student_id],
            dataUrl,
            kind: 'daily',
        });
        slToast(`Photo posted for ${slOpenChild.child_name}.`, 'ok');
    } catch (e) {
        console.warn('photo upload:', e);
        slToast('Photo did not send. Try again.', 'err');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '📷 Add a photo'; }
        const input = slEl('slPhotoInput');
        if (input) input.value = '';   // so the same file can be picked again
    }
}

// ── Optimistic commit + offline queue ───────────────────────
// The tap is acknowledged immediately and the write is queued. Staff are
// holding a child; waiting on a spinner is not an option, and a dropped signal
// in a cinderblock hallway must not lose the entry.

function slLoadQueue() {
    try { slQueue = JSON.parse(localStorage.getItem(SL_QUEUE_KEY) || '[]'); }
    catch { slQueue = []; }
    slRenderPending();
}

function slSaveQueue() {
    // The PIN is deliberately NOT part of a queued entry — the queue survives
    // in localStorage and the credential must not.
    try { localStorage.setItem(SL_QUEUE_KEY, JSON.stringify(slQueue)); } catch { /* full or private mode */ }
    slRenderPending();
}

function slRenderPending() {
    const btn = slEl('slPostBtn');
    if (!btn) return;
    btn.classList.toggle('hidden', slQueue.length === 0);
    btn.textContent = `Post ${slQueue.length}`;
}

function slCommit(eventType, detail, btnEl) {
    if (!slOpenChild) return;
    slQueue.push({
        student_id: slOpenChild.student_id,
        child_name: slOpenChild.child_name,
        event_type: eventType,
        detail,
        occurred_at: new Date().toISOString(),
    });
    slSaveQueue();

    if (btnEl) {
        btnEl.classList.add('sl-act-done');
        setTimeout(() => btnEl.classList.remove('sl-act-done'), 700);
    }

    // Reflect check-in/check-out on the roster straight away so the sheet and
    // the list never disagree while the write is still in flight.
    // ⚠️ slRenderRoster reads `attendance_status` first and only falls back to
    // `checked_in` when it's missing — but list_room_children() always returns
    // a non-null attendance_status, so that fallback never fires. Setting only
    // `checked_in` here left the roster pill stuck on "Not in" until the room
    // was reloaded from the server, even though the event had really been
    // recorded — which is exactly why it looked like tapping did nothing.
    if (eventType === 'check_in' || eventType === 'check_out') {
        slOpenChild.checked_in = eventType === 'check_in';
        slOpenChild.attendance_status = eventType === 'check_in' ? 'present' : 'left';
        slRenderRoster();
        slToast(`${slOpenChild.child_name} checked ${eventType === 'check_in' ? 'in' : 'out'}.`);
    }

    slFlushQueue();
}

let slFlushing = false;

async function slFlushQueue() {
    if (slFlushing || !slPin || !slQueue.length || !navigator.onLine) return;
    slFlushing = true;
    try {
        // Drain from the front, one at a time, so a single rejected entry does
        // not discard the rest of the batch.
        while (slQueue.length) {
            const entry = slQueue[0];
            let id;
            try {
                id = await logChildEvent(slStaffId, slPin, entry);
            } catch (e) {
                console.warn('flush failed, will retry:', e);
                break;                      // network — keep the queue intact
            }
            if (id === null || id === undefined) {
                // The RPC rejected it: bad PIN or an event_type the database
                // will never accept. Retrying forever would wedge the queue, so
                // drop it and say so rather than failing silently.
                slQueue.shift();
                slSaveQueue();
                slToast(`Could not save ${entry.child_name}'s ${entry.event_type.replace('_', ' ')}.`, 'err');
                continue;
            }
            slQueue.shift();
            slSaveQueue();
        }
    } finally {
        slFlushing = false;
    }
}

// ── Init ────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', () => {
    slLoadQueue();

    slEl('slPinBtn')?.addEventListener('click', slSignIn);
    slEl('slPinInput')?.addEventListener('keydown', e => { if (e.key === 'Enter') slSignIn(); });
    slEl('slSignOutBtn')?.addEventListener('click', slSignOut);
    // Second sign-out, in the Account tab. The room-picker one is only
    // reachable before a room is chosen; once a teacher is on the roster the
    // tab bar is the only navigation they have.
    slEl('slSignOutBtn2')?.addEventListener('click', slSignOut);
    slEl('slChangeRoomBtn')?.addEventListener('click', () => slShow('slRoomScreen'));
    slEl('slSheetClose')?.addEventListener('click', slCloseSheet);
    slEl('slSheet')?.addEventListener('click', e => { if (e.target.id === 'slSheet') slCloseSheet(); });
    slEl('slRefreshBtn')?.addEventListener('click', slLoadRoster);
    slEl('slPostBtn')?.addEventListener('click', slFlushQueue);
    slEl('slPhotoBtn')?.addEventListener('click', () => slEl('slPhotoInput')?.click());
    slEl('slPhotoInput')?.addEventListener('change', e => slPhotoPicked(e.target.files?.[0]));
    slEl('slThreadBack')?.addEventListener('click', slRenderThreadList);
    slEl('slThreadSendBtn')?.addEventListener('click', slSendThreadMessage);
    // The incident form wires itself — it owns a dozen controls of its own.
    if (typeof slSetupIncident === 'function') slSetupIncident();
    if (typeof slSetupSchedule === 'function') slSetupSchedule();
    if (typeof mcSetupMissing === 'function') mcSetupMissing();
    slEl('slInjuryBtn')?.addEventListener('click', slOpenInjury);
    slEl('slInjuryCancel')?.addEventListener('click', slCloseInjury);
    slEl('slInjuryForm')?.addEventListener('submit', slSubmitInjury);
    slEl('slInjTreatment')?.addEventListener('change', slInjTreatmentChanged);

    window.addEventListener('online', slFlushQueue);

    slShow('slPinScreen');
    slLoadStaffPicker();
});
