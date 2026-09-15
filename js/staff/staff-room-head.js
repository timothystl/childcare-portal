// ============================================================
// staff-room-head — the ratio bar above a room's roster
// ============================================================
// Design handoff: Capacity & Fill, 1d. The teacher's half of the drop-in
// work, whose stated point is that "drop-ins can't surprise the room".
//
// The part of that which is deliverable today, and genuinely useful on its
// own, is the ratio headroom: how many children are actually in the room
// right now, how many adults that requires, and how close the room is to
// the child who costs another one. A teacher currently has to hold all
// three in her head. Every figure comes from data the roster screen has
// already loaded:
//
//     present      — attendance_status === 'present' in listRoomChildren()
//     capacity     — the room's own ROOMS entry
//     adultsNeeded — ceil(present / staffRatio)
//     headroom     — how many more children before ceil() steps up
//
// `adultsNeeded` is deliberately the same ceil(children / ratio) the
// director's Daily Staffing Requirement uses (apStaffing, admin-portal.js).
// Two screens telling a teacher different numbers about her own room is
// worse than neither screen existing.
//
// ⚠️ The "extra today" band is the drop-in half, and it renders nothing
// until there are drop-ins to render. There is no released-day table and
// no drop_in flag on the roster payload yet, so srhExtras() returns [] and
// the band stays hidden — rather than the screen showing an empty "0
// drop-ins" state that a teacher would learn to ignore before it ever
// carried anything. When list_room_children starts returning a per-child
// drop_in marker, srhExtras() is the one function that needs to read it.

function srhEl(id) { return document.getElementById(id); }

function srhRoom() {
    const id = typeof slRoomId !== 'undefined' ? slRoomId : null;
    if (!id || typeof ROOMS === 'undefined') return null;
    return ROOMS.find(r => r.id === id) || null;
}

/**
 * Children on today's roster who are not part of the room's own enrollment
 * — drop-ins, and visiting children from another room. Empty until the
 * roster payload carries a marker for them; see the header note.
 */
function srhExtras(children) {
    return (children || []).filter(c => c.drop_in === true || c.is_drop_in === true);
}

function srhCounts(children) {
    const list = children || [];
    const present = list.filter(c => {
        // Same three-state rule slRenderRoster uses — 'present' only. "Out"
        // means the child has gone home and is not in the ratio any more,
        // which is exactly the distinction a blended count would lose.
        const st = c.attendance_status || (c.checked_in ? 'present' : 'not_arrived');
        return st === 'present';
    }).length;

    const room  = srhRoom();
    const ratio = Number(room?.staffRatio) || 0;
    const cap   = Number(room?.capacity) || 0;
    const adults = ratio > 0 && present > 0 ? Math.ceil(present / ratio) : 0;
    // Children who can still join before another adult is required.
    const headroom = ratio > 0 ? (adults * ratio) - present : null;

    return { present, cap, ratio, adults, headroom, extras: srhExtras(list) };
}

function srhRender() {
    const wrap = srhEl('slRoomHead');
    if (!wrap) return;
    const children = typeof slChildren !== 'undefined' ? slChildren : [];
    if (!children.length) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }

    const c = srhCounts(children);
    const pending = typeof slQueue !== 'undefined' ? slQueue.length : 0;

    // The line that does the actual work: it names the next child, not a
    // percentage. "3 more before you need a third adult" is something a
    // teacher can act on at the door.
    let note = '';
    if (c.ratio > 0) {
        if (c.headroom === 0) {
            note = `One more child needs another adult.`;
        } else if (c.headroom != null && c.headroom <= 3) {
            note = `${c.headroom} more before you'd need another adult.`;
        } else if (c.cap) {
            note = `${Math.max(0, c.cap - c.present)} of ${c.cap} seats free.`;
        }
    }

    const extras = c.extras.length ? `
        <div class="sl-room-extra">
            <div class="sl-room-extra-kicker">Extra today</div>
            <div class="sl-room-extra-title">${c.extras.length === 1
                ? 'One child joining who is not usually here'
                : `${c.extras.length} children joining who are not usually here`}</div>
            <div class="sl-room-extra-body">${c.extras.map(x => slEsc(x.child_name)).join(' · ')}</div>
        </div>` : '';

    wrap.classList.remove('hidden');
    wrap.innerHTML = `
        <div class="sl-room-stats">
            <div class="sl-room-stat">
                <span class="sl-room-stat-label">In room</span>
                <span class="sl-room-stat-n">${c.present}${c.cap ? ` of ${c.cap}` : ''}</span>
            </div>
            <div class="sl-room-stat">
                <span class="sl-room-stat-label">Adults needed</span>
                <span class="sl-room-stat-n${c.headroom === 0 ? ' is-edge' : ''}">${c.adults || '—'}</span>
            </div>
            <div class="sl-room-stat">
                <span class="sl-room-stat-label">Unposted</span>
                <span class="sl-room-stat-n">${pending}</span>
            </div>
        </div>
        ${note ? `<p class="sl-room-note${c.headroom === 0 ? ' is-edge' : ''}">${slEsc(note)}</p>` : ''}
        ${extras}`;
}
