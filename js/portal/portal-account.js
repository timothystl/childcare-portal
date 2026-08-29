// ============================================================
// portal-account — the parent's Account tab (design §10b)
// ============================================================
// "Everything a family maintains itself." The handoff's split is the whole
// shape of this screen and it is load-bearing:
//
//   parents write directly ...... phone, PIN, pickup list, notification prefs
//   routed to the office ........ allergies, immunizations, room changes
//
// ⚠️ Email is shown but NOT editable here, which departs from the design. Under
// Option B the address IS the sign-in — it keys parent_accounts to auth.users.
// Editing families.parent_email from the portal would leave the auth user on
// the old address and lock the parent out of the app they just used to change
// it. So it says so, and points at the office.

// Absent key = on, except quiet hours. Stated once, here, because the toggles
// and the eventual push sender must agree about what "unset" means.
const PT_NOTIF_DEFAULTS = {
    moments:       true,
    messages:      true,
    billing:       true,
    announcements: true,
    quiet_hours:   false,
};

const PT_NOTIF_ROWS = [
    { key: 'moments',       label: 'Daily moments',        hint: 'Photos and the day as it happens' },
    { key: 'messages',      label: 'Messages from staff',  hint: '' },
    { key: 'billing',       label: 'Billing reminders',    hint: '' },
    { key: 'announcements', label: 'Center announcements', hint: 'Closures and news' },
    { key: 'quiet_hours',   label: 'Quiet hours',          hint: 'Hold notifications 7pm–7am' },
];

let paData = null;
let _paPhotoUrlCache = new Map(); // profile_photo_path -> signed URL

function paEl(id) { return document.getElementById(id); }
function paEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function paPref(key) {
    const v = paData?.prefs?.[key];
    return v === undefined || v === null ? PT_NOTIF_DEFAULTS[key] : !!v;
}

// A monogram fallback for anyone without a photo on file (always true for
// parents/guardians — only children have a profile picture).
function paMonogram(name, cls = '') {
    const letter = (String(name || '?').trim()[0] || '?').toUpperCase();
    return `<span class="pa-mono ${cls}">${paEsc(letter)}</span>`;
}

// A child's profile picture if one is on file and signed, else the monogram
// fallback. The bucket is private, so a bare path is never enough — paLoad()
// signs every child's photo up front via fetchChildProfilePhotoUrls(), which
// itself goes through the "Parent read own child profile photo" storage
// policy (parent_owns_student()): this parent gets a URL only for their own
// children, same as every other child-photo path in this app.
function paChildAvatar(c, cls = '') {
    const url = c.profile_photo_path ? _paPhotoUrlCache.get(c.profile_photo_path) : null;
    return url
        ? `<img src="${paEsc(url)}" alt="" class="pa-mono pa-mono-photo ${cls}">`
        : paMonogram(c.child_name, cls);
}

function paAge(dob) {
    if (!dob) return '';
    const b = new Date(dob), n = new Date();
    let m = (n.getFullYear() - b.getFullYear()) * 12 + (n.getMonth() - b.getMonth());
    if (n.getDate() < b.getDate()) m--;
    if (m < 24) return `${m} months`;
    return `${Math.floor(m / 12)} years`;
}

function paRoomLabel(child) {
    const id = child.room_override || (typeof getRoomIdFromDob === 'function'
        ? getRoomIdFromDob(child.child_dob) : null);
    return (typeof ROOMS !== 'undefined' && ROOMS.find(r => r.id === id)?.label) || 'Room to be assigned';
}

// ── Render ──────────────────────────────────────────────────

function paRender() {
    const wrap = paEl('ptAccountBody');
    if (!wrap) return;
    if (!paData) {
        wrap.innerHTML = '<p class="pa-empty">Could not load your account. Pull down to retry.</p>';
        return;
    }

    const mySlot  = paData.my_slot || 1;
    const parents = (paData.parents || []).filter(p => p.name || p.email);

    wrap.innerHTML = `
        ${paCard('Children', (paData.children || []).map(c => `
            <div class="pa-row pa-child-row">
                <span class="pa-avatar-wrap">
                    ${paChildAvatar(c)}
                    <button type="button" class="pa-avatar-edit" data-child="${paEsc(c.id)}" title="Change photo">📷</button>
                </span>
                <button type="button" class="pa-row-tap pa-child-open" data-child="${paEsc(c.id)}">
                    <span class="pa-row-main">
                        <span class="pa-row-name">${paEsc(c.child_name)}</span>
                        <span class="pa-row-sub">${paEsc(paRoomLabel(c))}</span>
                    </span>
                    ${paAllergyBadge(c)}
                    <span class="pa-chev" aria-hidden="true">›</span>
                </button>
            </div>`).join('') || '<p class="pa-empty">No children on file yet.</p>')}
        <input type="file" id="paChildPhotoInput" accept="image/jpeg,image/png,image/webp" class="pa-hidden-file-input">
        <p class="pa-photo-status" id="paPhotoStatus" aria-live="polite"></p>

        ${paCard('Contact info', `
            <div class="pa-field">
                <span class="pa-field-label">Phone</span>
                <span class="pa-field-value" id="paPhoneValue">${paEsc(parents.find(p => p.slot === mySlot)?.phone || 'Not set')}</span>
                <button type="button" class="pa-edit" id="paPhoneEdit">Edit</button>
            </div>
            <div class="pa-field">
                <span class="pa-field-label">Emergency contact</span>
                ${paEmergencyValue(parents, mySlot)}
            </div>
            <div class="pa-field">
                <span class="pa-field-label">Email</span>
                <span class="pa-field-value">${paEsc(parents.find(p => p.slot === mySlot)?.email || '')}</span>
                <span class="pa-field-note">This is your sign-in — the office changes it</span>
            </div>
            <div class="pa-field">
                <span class="pa-field-label">PIN</span>
                <span class="pa-field-value">••••</span>
                <a class="pa-edit" href="reset-pin.html">Change</a>
            </div>`)}

        ${paCard('Parents &amp; guardians', parents.map(p => `
            <div class="pa-row">
                ${paMonogram(p.name)}
                <span class="pa-row-main">
                    <span class="pa-row-name">${paEsc(p.name || 'Parent ' + p.slot)}
                        ${p.slot === mySlot ? '<span class="pa-you">you</span>' : ''}</span>
                    <span class="pa-row-sub">${p.has_pin ? 'Has a PIN' : 'No PIN set'}</span>
                </span>
            </div>`).join(''))}

        ${paCard('Approved for pickup', `
            <div id="paPickupList">${paPickupRows()}</div>
            <div class="pa-caution">Anyone new shows ID at the desk, and the office
                reviews additions. Add someone here before they come.</div>
            <div class="pa-add-row">
                <input type="text" id="paPickupName" placeholder="Name" maxlength="60" autocomplete="off">
                <input type="text" id="paPickupRel" placeholder="Relationship" maxlength="40">
            </div>
            <div class="pa-add-row">
                <input type="text" id="paPickupNote" placeholder="Any limits — e.g. Thursdays only" maxlength="80">
                <button type="button" id="paPickupAdd" class="pa-add-btn">Add</button>
            </div>
            <p id="paPickupMsg" class="pa-msg"></p>`)}

        ${paCard('Notifications', PT_NOTIF_ROWS.map(r => `
            <div class="pa-field pa-toggle-row">
                <span class="pa-row-main">
                    <span class="pa-row-name">${r.label}</span>
                    ${r.hint ? `<span class="pa-row-sub">${paEsc(r.hint)}</span>` : ''}
                </span>
                <button type="button" role="switch" class="pa-toggle ${paPref(r.key) ? 'is-on' : ''}"
                    data-pref="${r.key}" aria-checked="${paPref(r.key)}" aria-label="${r.label}">
                    <span class="pa-knob"></span>
                </button>
            </div>`).join('') + '<p id="paPrefMsg" class="pa-msg"></p>')}
    `;

    paWire();
}

function paCard(title, inner) {
    return `<section class="pa-card">
        <h2 class="pa-card-head">${title}</h2>
        <div class="pa-card-body">${inner}</div>
    </section>`;
}

// Three states, three badges — and the middle one is why this is not a
// boolean. "Nobody has ever checked" is not "there are none", and rendering it
// as silence (or as NONE ON FILE) would tell a parent their child's allergy
// record is settled when it has never been looked at.
//
// The labels themselves are deliberately NOT listed here any more: the design
// shows one word, and the actual chips ("Peanuts", "Dairy") are on the Today
// card next to the child's name, which is where a teacher-facing fact belongs.
// Tapping the row opens that same record.
function paAllergyBadge(c) {
    const list = Array.isArray(c.allergies) ? c.allergies : [];
    if (list.length) {
        const severe = list.some(a => a.severity === 'severe');
        return `<span class="pa-allergy ${severe ? 'pa-allergy-severe' : ''}">ALLERGIES</span>`;
    }
    if (!c.allergies_reviewed_at) return '<span class="pa-allergy pa-allergy-unknown">NOT CHECKED</span>';
    return '<span class="pa-allergy pa-allergy-none">NONE ON FILE</span>';
}

// ⚠️ THERE IS NO EMERGENCY-CONTACT FIELD IN THIS DATABASE. The design shows one;
// families/parent_accounts hold parent 1 and parent 2 and nothing else, and the
// real emergency contact lives on the paper enrollment form in the office.
//
// So this shows the OTHER parent on the record when there is one — which is who
// the center actually calls second — and otherwise says plainly where the answer
// is kept. It does not invent a field, and it does not reuse a pickup contact:
// "may collect your child" and "call this person in an emergency" are different
// permissions, and quietly treating one as the other is the kind of thing that
// only shows up on the day it matters.
function paEmergencyValue(parents, mySlot) {
    const other = parents.find(p => p.slot !== mySlot && (p.name || p.phone));
    if (other) {
        return `<span class="pa-field-value">${paEsc(other.name || 'Second parent')}${
            other.phone ? ' — ' + paEsc(other.phone) : ''}</span>
            <span class="pa-field-note">Second parent on your record</span>`;
    }
    return `<span class="pa-field-value pa-field-empty">Not in the app</span>
        <span class="pa-field-note">Held on your enrollment form — call the office to change it</span>`;
}

function paPickupRows() {
    const list = paData?.pickup || [];
    if (!list.length) return '<p class="pa-empty">Nobody added yet — only parents on file may collect.</p>';
    return list.map(p => `
        <div class="pa-row">
            ${paMonogram(p.name, 'pa-mono-sm')}
            <span class="pa-row-main">
                <span class="pa-row-name">${paEsc(p.name)}</span>
                <span class="pa-row-sub">${paEsc([p.relationship, p.note].filter(Boolean).join(' · '))}</span>
            </span>
            <button type="button" class="pa-remove" data-pickup="${paEsc(p.id)}"
                aria-label="Remove ${paEsc(p.name)}">Remove</button>
        </div>`).join('');
}

// ── Behavior ────────────────────────────────────────────────

function paWire() {
    paEl('paPhoneEdit')?.addEventListener('click', paEditPhone);
    paEl('paPickupAdd')?.addEventListener('click', paAddPickup);

    document.querySelectorAll('#ptAccountBody .pa-toggle').forEach(t => {
        t.addEventListener('click', () => paTogglePref(t));
    });
    document.querySelectorAll('#ptAccountBody .pa-remove').forEach(b => {
        b.addEventListener('click', () => paRemovePickup(Number(b.dataset.pickup), b));
    });
    // A child row opens the same allergy record the Today tab shows. One
    // editor, not two that can disagree.
    document.querySelectorAll('#ptAccountBody .pa-row-tap').forEach(b => {
        b.addEventListener('click', () => {
            if (typeof ptGoTab === 'function') ptGoTab('today');
            if (typeof ptSelectChild === 'function') ptSelectChild(b.dataset.child);
        });
    });
    document.querySelectorAll('#ptAccountBody .pa-avatar-edit').forEach(b => {
        b.addEventListener('click', () => {
            _paEditingChildId = b.dataset.child;
            paEl('paChildPhotoInput')?.click();
        });
    });
    paEl('paChildPhotoInput')?.addEventListener('change', paChangeChildPhoto);
}

let _paEditingChildId = null;

// Uploads the picked file into that child's own storage folder, then points
// the record at it via set_child_profile_photo() — the students table has
// no parent-facing UPDATE policy, so this RPC is the only door.
async function paChangeChildPhoto(e) {
    const file = e.target.files[0];
    const childId = _paEditingChildId;
    e.target.value = ''; // let picking the same file twice re-fire change
    if (!file || !childId) return;
    const statusEl = paEl('paPhotoStatus');
    if (statusEl) statusEl.textContent = 'Uploading…';
    try {
        const path = await uploadChildProfilePhotoAsParent(childId, file);
        const ok = await setChildProfilePhoto(childId, path);
        if (!ok) throw new Error('That photo could not be saved to this child’s record.');
        const child = (paData?.children || []).find(c => String(c.id) === String(childId));
        if (child) child.profile_photo_path = path;
        _paPhotoUrlCache.set(path, URL.createObjectURL(file));
        if (statusEl) statusEl.textContent = '';
        paRender(); // re-wires internally
    } catch (err) {
        if (statusEl) statusEl.textContent = 'Could not update that photo: ' + (err.message || err);
    }
}

async function paEditPhone() {
    const current = paEl('paPhoneValue')?.textContent.trim();
    const next = prompt('Mobile number', current === 'Not set' ? '' : current);
    if (next === null) return;
    try {
        const res = await updateMyPhone(next.trim());
        paEl('paPhoneValue').textContent = res?.phone || 'Not set';
    } catch (e) {
        alert('Could not save that: ' + (e.message || e));
    }
}

async function paTogglePref(btn) {
    const key  = btn.dataset.pref;
    const next = !btn.classList.contains('is-on');
    // Optimistic: the switch moves under the thumb immediately and rolls back
    // if the write fails. A toggle that waits on the network feels broken.
    btn.classList.toggle('is-on', next);
    btn.setAttribute('aria-checked', String(next));
    const prefs = { ...(paData.prefs || {}), [key]: next };
    try {
        await setMyNotificationPrefs(prefs);
        paData.prefs = prefs;
    } catch (e) {
        btn.classList.toggle('is-on', !next);
        btn.setAttribute('aria-checked', String(!next));
        const msg = paEl('paPrefMsg');
        if (msg) msg.textContent = 'That did not save. Try again.';
    }
}

async function paAddPickup() {
    const name = (paEl('paPickupName')?.value || '').trim();
    const msg  = paEl('paPickupMsg');
    if (!name) { if (msg) msg.textContent = 'A name is needed.'; return; }
    const btn = paEl('paPickupAdd');
    if (btn) { btn.disabled = true; btn.textContent = 'Adding…'; }
    try {
        const row = await addPickupContact(
            name, paEl('paPickupRel')?.value, paEl('paPickupNote')?.value);
        paData.pickup = [...(paData.pickup || []), row];
        paEl('paPickupList').innerHTML = paPickupRows();
        ['paPickupName', 'paPickupRel', 'paPickupNote'].forEach(id => { paEl(id).value = ''; });
        if (msg) msg.textContent = '';
        paWire();
    } catch (e) {
        if (msg) msg.textContent = e.message || String(e);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Add'; }
    }
}

async function paRemovePickup(id, btn) {
    const row = (paData.pickup || []).find(p => Number(p.id) === id);
    if (!confirm(`Remove ${row?.name || 'this person'} from the pickup list?`)) return;
    if (btn) btn.disabled = true;
    try {
        await removePickupContact(id);
        paData.pickup = (paData.pickup || []).filter(p => Number(p.id) !== id);
        paEl('paPickupList').innerHTML = paPickupRows();
        paWire();
    } catch (e) {
        if (btn) btn.disabled = false;
        alert('Could not remove that: ' + (e.message || e));
    }
}

async function paLoad() {
    const wrap = paEl('ptAccountBody');
    if (wrap) wrap.innerHTML = '<p class="pa-empty">Loading…</p>';
    try {
        paData = await fetchMyAccount();
        const paths = (paData?.children || []).map(c => c.profile_photo_path).filter(Boolean);
        _paPhotoUrlCache = paths.length ? await fetchChildProfilePhotoUrls(paths).catch(() => new Map()) : new Map();
    } catch (e) {
        console.warn('account:', e);
        paData = null;
    }
    paRender();
}
