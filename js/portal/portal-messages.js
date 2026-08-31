// ============================================================
// portal-messages — the parent's side of the conversation (Phase 2)
// ============================================================
// ONE THREAD PER CHILD (per_child_message_threads.sql), which is what the
// design handoff asks for: "Each child has their own conversation history."
// The child switcher above the thread is the same control Today and Schedule
// use, and it swaps the whole conversation rather than filtering one.
//
// Why per child rather than per family: the office replies "she wouldn't nap"
// and the parent has two children. A family thread makes the reader work out
// who every message is about, and gets it wrong eventually.
//
// ⚠️ A family with NO children on file still needs to reach the office — that
// is the general thread (student_id IS NULL, myMessageThread()), and it is the
// only case where no switcher is rendered.

let pmThreadId = null;          // the thread currently open
let pmActiveId = null;          // which child it belongs to, null = general
let pmThreadByChild = {};       // studentId -> thread id, resolved once each
let pmUnreadByChild = {};       // studentId -> unread count, for the pills
let pmSending  = false;

function pmEl(id) { return document.getElementById(id); }

function pmEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

function pmTime(iso) {
    const d = new Date(iso);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const that  = d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const time  = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' });
    // A time alone is ambiguous once a message is a day old. Inside the last
    // week the weekday is what a person actually remembers ("Mon 2:14 PM");
    // past that it stops being a landmark and the date is clearer.
    if (that === today) return time;
    const ageDays = Math.round((new Date(today + 'T12:00:00') - new Date(that + 'T12:00:00')) / 86400000);
    const fmt = (ageDays >= 0 && ageDays < 7)
        ? { weekday: 'short' }
        : { month: 'short', day: 'numeric' };
    return d.toLocaleDateString('en-US', { ...fmt, timeZone: 'America/Chicago' }) + ' ' + time;
}

// Reuses ptChildren (portal-today.js loads it once on sign-in) rather than a
// second fetch — the pills must name the same children, in the same order, as
// Today and Schedule do.
function pmChildren() {
    return (typeof ptChildren !== 'undefined' && Array.isArray(ptChildren)) ? ptChildren : [];
}

function pmRenderSwitcher() {
    const wrap = pmEl('pmSwitcher');
    if (!wrap) return;
    const kids = pmChildren();
    if (kids.length < 2) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    wrap.innerHTML = kids.map(function (c) {
        const n = pmUnreadByChild[c.id] || 0;
        const on = String(c.id) === String(pmActiveId) ? 'active' : '';
        const first = pmEsc(String(c.child_name || '').split(' ')[0]);
        const dot = n ? '<span class="pm-pill-unread">' + (n > 9 ? '9+' : n) + '</span>' : '';
        return '<button type="button" class="pt-childbtn ' + on + '" data-child="' +
               pmEsc(c.id) + '">' + first + dot + '</button>';
    }).join('');
    wrap.querySelectorAll('.pt-childbtn').forEach(function (b) {
        b.addEventListener('click', function () { pmSelectChild(b.dataset.child); });
    });
}

async function pmSelectChild(childId) {
    if (String(childId) === String(pmActiveId)) return;
    pmActiveId = childId;
    pmRenderSwitcher();
    await pmOpenActiveThread();
}

function pmRender(items) {
    const wrap = pmEl('pmThread');
    if (!wrap) return;

    if (!items.length) {
        wrap.innerHTML = `<div class="pm-empty ui-empty-state">
            <img class="ui-empty-illustration" src="/images/illustrations/empty-messages.svg" alt="">
            <p>No messages yet. Anything you send here goes to your child's teacher and the office.</p>
        </div>`;
        return;
    }

    wrap.innerHTML = items.map(m => {
        const mine = m.sender_type === 'parent';
        // The read receipt is only meaningful on the parent's OWN messages —
        // "read" on a message the parent received would just mean "you read it".
        const receipt = mine
            ? `<span class="pm-receipt">${m.read_at ? 'Read' : 'Sent'}</span>`
            : '';
        const who = mine ? 'You' : (m.sender_name || (m.sender_type === 'admin' ? 'The office' : 'Teacher'));
        return `<div class="pm-msg ${mine ? 'pm-mine' : 'pm-theirs'}">
            <div class="pm-msg-head">
                <span class="pm-who">${pmEsc(who)}</span>
                <span class="pm-when">${pmEsc(pmTime(m.created_at))}</span>
            </div>
            <div class="pm-body">${pmEsc(m.body)}</div>
            ${receipt}
        </div>`;
    }).join('');

    // Newest message in view without moving the rest of the page.
    wrap.scrollTop = wrap.scrollHeight;
}

/**
 * Unread for the tab badge AND for the per-child pills. Deliberately separate
 * from pmLoad: it counts WITHOUT marking anything read. Calling pmLoad to get
 * this number would clear the badge for a parent who never opened the tab —
 * the badge would be permanently zero and the feature pointless.
 *
 * It is now a sum across every child's thread, because there is one per child.
 */
async function pmThreadFor(childId) {
    if (pmThreadByChild[childId] !== undefined) return pmThreadByChild[childId];
    const id = await myChildMessageThread(childId);
    pmThreadByChild[childId] = id;
    return id;
}

async function pmRefreshUnread() {
    pmUnreadByChild = {};
    const kids = pmChildren();
    try {
        if (!kids.length) {
            const id = await myMessageThread();
            if (!id) return 0;
            const items = await fetchThreadMessages(id);
            return items.filter(function (m) { return m.sender_type !== 'parent' && !m.read_at; }).length;
        }
        // One round trip per child. For a roster of one or two that is cheaper
        // than a bespoke aggregate RPC; revisit only if a family ever has
        // enough children for it to matter.
        const counts = await Promise.all(kids.map(async function (c) {
            const id = await pmThreadFor(c.id);
            if (!id) return 0;
            const items = await fetchThreadMessages(id);
            const n = items.filter(function (m) { return m.sender_type !== 'parent' && !m.read_at; }).length;
            pmUnreadByChild[c.id] = n;
            return n;
        }));
        return counts.reduce(function (a, b) { return a + b; }, 0);
    } catch (_) {
        return 0;   // a badge is not worth an error state
    }
}

async function pmUnreadCount() {
    return pmRefreshUnread();
}

/** Loads and renders whichever child is selected, and marks THAT thread read. */
async function pmOpenActiveThread() {
    const wrap = pmEl('pmThread');
    if (!wrap) return;
    wrap.innerHTML = '<p class="pm-empty">Loading…</p>';
    try {
        pmThreadId = pmActiveId ? await pmThreadFor(pmActiveId) : await myMessageThread();
        if (!pmThreadId) {
            wrap.innerHTML = '<p class="pm-empty">Messages are unavailable right now.</p>';
            return;
        }

        const items = await fetchThreadMessages(pmThreadId);
        pmRender(items);

        // Opening a thread is reading it — but only THIS child's. A sibling's
        // unread messages stay unread, which is the point of splitting the
        // threads at all: the badge has to keep pointing at what is unread.
        if (items.some(function (m) { return m.sender_type !== 'parent' && !m.read_at; })) {
            await markThreadRead(pmThreadId);
            if (pmActiveId) pmUnreadByChild[pmActiveId] = 0;
            pmRenderSwitcher();
            if (typeof ptSetBadge === 'function') {
                ptSetBadge('messages', Object.keys(pmUnreadByChild)
                    .reduce(function (a, k) { return a + pmUnreadByChild[k]; }, 0));
            }
        }
    } catch (e) {
        console.warn('messages:', e);
        wrap.innerHTML = '<p class="pm-empty">Messages are unavailable right now.</p>';
    }
}

async function pmLoad() {
    const wrap = pmEl('pmThread');
    if (!wrap) return;
    pmEl('pmSection')?.classList.remove('hidden');

    const kids = pmChildren();
    // Start on whichever child the rest of the app has open, so moving to
    // Messages does not silently change who you were looking at.
    if (kids.length) {
        pmActiveId = (typeof ptActiveId !== 'undefined' &&
                      kids.some(function (c) { return String(c.id) === String(ptActiveId); }))
            ? ptActiveId : kids[0].id;
    } else {
        pmActiveId = null;   // no children on file — the general thread
    }

    await pmRefreshUnread();
    pmRenderSwitcher();
    await pmOpenActiveThread();
}

async function pmSend() {
    if (pmSending || !pmThreadId) return;
    const input = pmEl('pmInput');
    const body  = (input?.value || '').trim();
    if (!body) return;

    const btn = pmEl('pmSendBtn');
    pmSending = true;
    if (btn) { btn.disabled = true; btn.textContent = 'Sending…'; }
    try {
        await sendParentMessage(pmThreadId, body, portalContext?.parent_name || null);
        input.value = '';
        // Only the open thread. pmLoad() would re-resolve every child's thread
        // and re-count unread for siblings this send never touched.
        await pmOpenActiveThread();
    } catch (e) {
        console.warn('send message:', e);
        // Deliberately does NOT clear the box on failure — retyping a message
        // you already wrote is the most annoying way to lose work.
        alert('That did not send. Please try again.');
    } finally {
        pmSending = false;
        if (btn) { btn.disabled = false; btn.textContent = 'Send'; }
    }
}

function pmInit() {
    pmEl('pmSendBtn')?.addEventListener('click', pmSend);
    pmEl('pmInput')?.addEventListener('keydown', e => {
        // Enter sends; Shift+Enter is a newline. On a phone the on-screen
        // return key inserts a newline, which is why Send exists too.
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); pmSend(); }
    });
}
