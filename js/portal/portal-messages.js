// ============================================================
// portal-messages — the parent's side of the conversation (Phase 2)
// ============================================================
// One thread per family. The plan allowed subjects; for 121 families "message
// the office" is a single ongoing conversation, and a thread list where every
// family has exactly one row is a list nobody needs to read.
//
// It lives BELOW the day on the Today card rather than behind a tab, because a
// parent who opens the app is looking at today — and a reply they have not seen
// should be in front of them, not one navigation away.

let pmThreadId = null;
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

function pmRender(items) {
    const wrap = pmEl('pmThread');
    if (!wrap) return;

    if (!items.length) {
        wrap.innerHTML = `<p class="pm-empty">No messages yet. Anything you send here goes to your
            child's teacher and the office.</p>`;
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
        // ⚠️ There is no per-child message thread. The design shows the child
        // switcher on this screen, but a thread is per FAMILY (one row per
        // family in message_threads) — rendering pills that filter nothing, or
        // that silently show the same conversation twice, would be worse than
        // not showing them. Splitting threads by child is its own piece of work.
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
 * Unread count for the Messages tab badge. Deliberately separate from pmLoad:
 * it counts WITHOUT marking anything read. Calling pmLoad to get this number
 * would clear the badge for a parent who never opened the tab — the badge would
 * be permanently zero and the feature pointless.
 */
async function pmUnreadCount() {
    try {
        const id = await myMessageThread();
        if (!id) return 0;
        const items = await fetchThreadMessages(id);
        return items.filter(m => m.sender_type !== 'parent' && !m.read_at).length;
    } catch (_) {
        return 0;   // a badge is not worth an error state
    }
}

async function pmLoad() {
    const wrap = pmEl('pmThread');
    if (!wrap) return;
    try {
        pmThreadId = await myMessageThread();
        if (!pmThreadId) { pmEl('pmSection')?.classList.add('hidden'); return; }
        pmEl('pmSection')?.classList.remove('hidden');

        const items = await fetchThreadMessages(pmThreadId);
        pmRender(items);

        // Opening the thread is reading it — clears staff/office messages so
        // the unread badge does not persist after the parent has plainly seen it.
        if (items.some(m => m.sender_type !== 'parent' && !m.read_at)) {
            await markThreadRead(pmThreadId);
            // The badge must clear at the same moment, or it contradicts the
            // thread the parent is looking at.
            if (typeof ptSetBadge === 'function') ptSetBadge('messages', 0);
        }
    } catch (e) {
        console.warn('messages:', e);
        wrap.innerHTML = '<p class="pm-empty">Messages are unavailable right now.</p>';
    }
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
        await pmLoad();
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
