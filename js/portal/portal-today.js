// ============================================================
// portal-today — the parent's Today feed (Phase 1)
// ============================================================
// What a parent opens the app for. Design: PARENT_PORTAL_PLAN §5.
//
// The child switcher swaps content IN PLACE — no navigation, no page change.
// A parent with two children checks both in the same three seconds it takes to
// check one, and losing scroll position between them would undo that.
//
// Everything here reads through RLS. There is no family filter in any query on
// this page: the database decides what a parent can see, and adding a
// belt-and-braces filter in JS would suggest to the next reader that it does
// not.

let ptChildren  = [];
let ptActiveId  = null;
let ptDate      = null;   // YYYY-MM-DD in the centre's timezone

function ptEl(id) { return document.getElementById(id); }

function ptEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// The centre is in America/Chicago. Using the device's local date would show a
// parent in another timezone the wrong day — which for a travelling parent is
// exactly when they most want to look.
function ptToday() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function ptTime(iso) {
    return new Date(iso).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
    });
}

// ── How each event reads ────────────────────────────────────
// Written as a parent would say it, not as the database stores it. "Nap
// 12:40 – 2:05pm" is what someone wants at pickup; "nap_end" is not.
const PT_EVENT = {
    check_in:   { icon: '👋', label: () => 'Checked in' },
    check_out:  { icon: '🏡', label: () => 'Checked out' },
    nap_start:  { icon: '😴', label: () => 'Fell asleep' },
    nap_end:    { icon: '🌤️', label: () => 'Woke up' },
    diaper:     { icon: '🧷', label: d => ({ wet: 'Diaper — wet', bm: 'Diaper — BM', dry: 'Diaper — dry' }[d?.kind] || 'Diaper change') },
    bottle:     { icon: '🍼', label: d => d?.oz ? `Bottle — ${d.oz} oz` : 'Bottle' },
    meal:       { icon: '🍎', label: d => ({ none: 'Meal — did not eat', some: 'Meal — ate some',
                                             most: 'Meal — ate most', all: 'Meal — ate it all' }[d?.amount] || 'Meal') },
    note:       { icon: '📝', label: d => d?.text || 'Note from the teacher' },
    supplies:   { icon: '📦', label: () => 'Supplies needed' },
};

function ptRenderTimeline(events) {
    const wrap = ptEl('ptTimeline');
    if (!wrap) return;

    if (!events.length) {
        // Distinguish "nothing logged yet" from "not a care day". A parent
        // seeing an empty feed on a Tuesday their child does not attend should
        // not think the teacher forgot.
        wrap.innerHTML = `<div class="pt-empty">
            <p>Nothing logged yet today.</p>
            <p class="pt-empty-sub">Teachers log the day as it happens — check back this afternoon.</p>
        </div>`;
        return;
    }

    wrap.innerHTML = events.map(e => {
        const spec  = PT_EVENT[e.event_type] || { icon: '•', label: () => e.event_type };
        const label = typeof spec.label === 'function' ? spec.label(e.detail) : spec.label;
        return `<li class="pt-event">
            <span class="pt-event-icon" aria-hidden="true">${spec.icon}</span>
            <span class="pt-event-body">
                <span class="pt-event-label">${ptEsc(label)}</span>
                <span class="pt-event-time">${ptEsc(ptTime(e.occurred_at))}</span>
            </span>
        </li>`;
    }).join('');
}

function ptRenderSwitcher() {
    const wrap = ptEl('ptSwitcher');
    if (!wrap) return;
    // One child needs no switcher — a row of one tab is noise.
    if (ptChildren.length < 2) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    wrap.innerHTML = ptChildren.map(c =>
        `<button type="button" class="pt-tab ${c.id === ptActiveId ? 'active' : ''}"
                 data-child="${ptEsc(c.id)}">${ptEsc((c.child_name || '').split(' ')[0])}</button>`
    ).join('');
    wrap.querySelectorAll('.pt-tab').forEach(b => {
        b.addEventListener('click', () => ptSelectChild(b.dataset.child));
    });
}

function ptRenderSafety(child) {
    const wrap = ptEl('ptSafety');
    if (!wrap) return;
    const list = Array.isArray(child?.allergies) ? child.allergies : [];
    const notes = (child?.care_notes || '').trim();
    if (!list.length && !notes) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
    wrap.classList.remove('hidden');
    const chips = list.map(a => {
        const cls = a.severity === 'severe' ? 'pt-chip-severe'
                  : a.severity === 'sensitivity' ? 'pt-chip-sens' : 'pt-chip-note';
        return `<span class="pt-chip ${cls}">${ptEsc(a.label)}</span>`;
    }).join('');
    wrap.innerHTML = `<div class="pt-safety-title">On file for ${ptEsc((child.child_name || '').split(' ')[0])}</div>
        ${chips ? `<div class="pt-safety-chips">${chips}</div>` : ''}
        ${notes ? `<div class="pt-safety-note">${ptEsc(notes)}</div>` : ''}`;
}

async function ptSelectChild(childId) {
    ptActiveId = childId;
    const child = ptChildren.find(c => String(c.id) === String(childId));
    ptRenderSwitcher();
    ptRenderSafety(child);

    ptEl('ptChildName').textContent = child ? child.child_name : '';
    ptEl('ptTimeline').innerHTML = '<li class="pt-loading">Loading…</li>';

    try {
        const events = await fetchChildDay(childId, ptDate);
        ptRenderTimeline(events);
    } catch (e) {
        console.warn('day feed:', e);
        ptEl('ptTimeline').innerHTML = '<li class="pt-loading">Could not load today.</li>';
    }
}

async function ptRenderAnnouncements() {
    const wrap = ptEl('ptAnnouncements');
    if (!wrap) return;
    try {
        const list = await fetchAnnouncements();
        if (!list.length) { wrap.classList.add('hidden'); return; }
        wrap.classList.remove('hidden');
        wrap.innerHTML = list.slice(0, 3).map(a => `<div class="pt-ann">
            <div class="pt-ann-title">${ptEsc(a.title)}</div>
            <div class="pt-ann-body">${ptEsc(a.body)}</div>
        </div>`).join('');
    } catch (e) {
        console.warn('announcements:', e);
        wrap.classList.add('hidden');
    }
}

// Called by portal-auth once a session exists.
async function ptLoadToday() {
    ptDate = ptToday();
    const dateEl = ptEl('ptDate');
    if (dateEl) {
        dateEl.textContent = new Date(ptDate + 'T12:00:00').toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric',
        });
    }

    try {
        ptChildren = await fetchMyChildren();
    } catch (e) {
        console.warn('children:', e);
        ptChildren = [];
    }

    if (!ptChildren.length) {
        ptEl('ptFeed')?.classList.add('hidden');
        ptEl('ptNoChildren')?.classList.remove('hidden');
        return;
    }

    ptEl('ptNoChildren')?.classList.add('hidden');
    ptEl('ptFeed')?.classList.remove('hidden');
    await ptSelectChild(ptChildren[0].id);
    ptRenderAnnouncements();
}
