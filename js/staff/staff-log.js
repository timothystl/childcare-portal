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

async function slSignIn() {
    const pin = (slEl('slPinInput')?.value || '').trim();
    if (!/^\d{4,8}$/.test(pin)) {
        slToast('Enter your PIN.', 'err');
        return;
    }
    const btn = slEl('slPinBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
    try {
        const staff = await fetchStaffByPin(pin);
        if (!staff) {
            slToast('That PIN was not recognised.', 'err');
            return;
        }
        slPin   = pin;
        slStaff = staff;
        slEl('slPinInput').value = '';
        slEl('slWhoami').textContent = staff.name || 'Signed in';
        slRenderRooms();
        // A staff member assigned to a room goes straight there — the room
        // picker is a fallback for floaters and the director, not a toll gate.
        if (staff.room_id) { slOpenRoom(staff.room_id); } else { slShow('slRoomScreen'); }
        slFlushQueue();
    } catch (e) {
        console.warn('staff sign-in:', e);
        slToast('Could not reach the server.', 'err');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Sign In'; }
    }
}

function slSignOut() {
    slPin = null; slStaff = null; slRoomId = null; slChildren = [];
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
    const room = ROOMS.find(r => r.id === roomId);
    slEl('slRoomTitle').textContent = room ? room.label : 'Room';
    slShow('slRosterScreen');
    slEl('slRoster').innerHTML = '<p class="sl-empty">Loading…</p>';
    await slLoadRoster();
}

async function slLoadRoster() {
    try {
        slChildren = await listRoomChildren(slPin, slRoomId);
        slRenderRoster();
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
        return `<button type="button" class="sl-child" data-student="${slEsc(c.student_id)}">
            <span class="sl-child-top">
                <span class="sl-child-name">${slEsc(c.child_name)}</span>
                <span class="sl-child-state ${c.checked_in ? 'in' : ''}">${c.checked_in ? 'In' : 'Not in'}</span>
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
    slEl('slSheetSafety').innerHTML = (chips || notes)
        ? `${chips ? `<div class="sl-safety-chips">${chips}</div>` : ''}
           ${notes ? `<div class="sl-safety-note">${slEsc(notes)}</div>` : ''}`
        : '<div class="sl-safety-none">No allergies or care notes on file.</div>';
    slEl('slSheetSafety').className = (chips || notes) ? 'sl-safety' : 'sl-safety sl-safety-empty';

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
        await uploadChildPhoto(slPin, {
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

    // Reflect check-in on the roster straight away so the sheet and the list
    // never disagree while the write is still in flight.
    if (eventType === 'check_in') {
        slOpenChild.checked_in = true;
        slRenderRoster();
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
                id = await logChildEvent(slPin, entry);
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
    slEl('slChangeRoomBtn')?.addEventListener('click', () => slShow('slRoomScreen'));
    slEl('slSheetClose')?.addEventListener('click', slCloseSheet);
    slEl('slSheet')?.addEventListener('click', e => { if (e.target.id === 'slSheet') slCloseSheet(); });
    slEl('slRefreshBtn')?.addEventListener('click', slLoadRoster);
    slEl('slPostBtn')?.addEventListener('click', slFlushQueue);
    slEl('slPhotoBtn')?.addEventListener('click', () => slEl('slPhotoInput')?.click());
    slEl('slPhotoInput')?.addEventListener('change', e => slPhotoPicked(e.target.files?.[0]));

    window.addEventListener('online', slFlushQueue);

    slShow('slPinScreen');
});
