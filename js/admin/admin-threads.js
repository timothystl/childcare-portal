// ============================================================
// admin-threads — the office's side of parent messaging (Phase 2)
// ============================================================
// The director is NOT room-scoped the way teachers are: she is an admin and
// reads every thread through the ordinary is_admin() policy. A teacher only
// sees families with a child on their roster today, which is why the office
// needs this view at all — somebody has to be able to see the whole picture.
//
// Separate from admin-messages.js, which owns the `messages` table: that is the
// PUBLIC contact form, the only way a non-family reaches the office. Different
// senders, different lifecycle, deliberately not merged.

let _thrData = [];
let _thrOpen = null;

function _thrEl(id) { return document.getElementById(id); }

function _thrWhen(iso) {
    const d = new Date(iso);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const that  = d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    return that === today
        ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
}

async function renderThreadsTool() {
    const wrap = _thrEl('threadsBody');
    if (!wrap) return;
    wrap.innerHTML = '<p class="muted">Loading…</p>';
    try {
        _thrData = await fetchAllThreads();
    } catch (e) {
        wrap.innerHTML = `<p class="muted">Could not load messages: ${escHtml(e.message || e)}</p>`;
        return;
    }
    _thrRenderList();
}

function _thrUnread(t) {
    return (t.message_items || []).filter(m => m.sender_type === 'parent' && !m.read_at).length;
}

function _thrRenderList() {
    const wrap = _thrEl('threadsBody');
    if (!wrap) return;
    _thrOpen = null;

    if (!_thrData.length) {
        wrap.innerHTML = '<p class="muted" style="padding:18px 2px">No parent messages yet.</p>';
        return;
    }

    // Waiting-on-you first, then most recent. A list ordered purely by time
    // buries an unanswered question under this morning's chatter.
    const sorted = [..._thrData].sort((a, b) => {
        const ua = _thrUnread(a), ub = _thrUnread(b);
        if ((ua > 0) !== (ub > 0)) return ub - ua;
        return new Date(b.last_message_at) - new Date(a.last_message_at);
    });

    wrap.innerHTML = sorted.map(t => {
        const items = (t.message_items || []).slice().sort((x, y) =>
            new Date(x.created_at) - new Date(y.created_at));
        const last = items[items.length - 1];
        const unread = _thrUnread(t);
        return `<button class="thr-row ${unread ? 'thr-unread' : ''}" data-thread="${t.id}">
            <span class="thr-top">
                <span class="thr-name">${escHtml(t.families?.parent_name || 'Family')}</span>
                ${unread ? `<span class="thr-badge">${unread}</span>` : ''}
                <span class="thr-when">${escHtml(_thrWhen(t.last_message_at))}</span>
            </span>
            <span class="thr-last">${escHtml(last?.body || 'No messages yet')}</span>
        </button>`;
    }).join('');

    wrap.querySelectorAll('.thr-row').forEach(b => {
        b.onclick = () => _thrOpenThread(Number(b.dataset.thread));
    });
}

async function _thrOpenThread(threadId) {
    const t = _thrData.find(x => Number(x.id) === threadId);
    if (!t) return;
    _thrOpen = threadId;

    const items = (t.message_items || []).slice().sort((x, y) =>
        new Date(x.created_at) - new Date(y.created_at));

    _thrEl('threadsBody').innerHTML = `
        <button class="btn-ghost thr-back">← All conversations</button>
        <div class="thr-head">
            <strong>${escHtml(t.families?.parent_name || 'Family')}</strong>
            <span class="muted">${escHtml(t.families?.parent_email || '')}</span>
        </div>
        <div class="thr-messages">
            ${items.map(m => `<div class="thr-msg thr-${m.sender_type === 'parent' ? 'them' : 'us'}">
                <span class="thr-msg-who">${escHtml(m.sender_name || (m.sender_type === 'parent' ? 'Parent' : 'Office'))}
                    · ${escHtml(_thrWhen(m.created_at))}</span>
                <span class="thr-msg-body">${escHtml(m.body)}</span>
            </div>`).join('') || '<p class="muted">No messages yet.</p>'}
        </div>
        <div class="thr-composer">
            <textarea id="thrInput" rows="3" placeholder="Reply to this family…"></textarea>
            <button class="btn-primary" id="thrSendBtn">Send reply</button>
        </div>`;

    _thrEl('threadsBody').querySelector('.thr-back').onclick = _thrRenderList;
    _thrEl('thrSendBtn').onclick = () => _thrSend(threadId);

    // Opening it is reading it.
    try { await markThreadRead(threadId); } catch (e) { console.warn('mark read:', e); }
}

async function _thrSend(threadId) {
    const input = _thrEl('thrInput');
    const body  = (input?.value || '').trim();
    if (!body) return;

    const btn = _thrEl('thrSendBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
        await sendAdminMessage(threadId, body, 'The office');
        await renderThreadsTool();
        await _thrOpenThread(threadId);
        showToast('Reply sent.');
    } catch (e) {
        // The box keeps its text — retyping a reply you already wrote is the
        // most annoying way to lose work.
        showToast('Could not send: ' + (e.message || e), 'error');
        btn.disabled = false; btn.textContent = 'Send reply';
    }
}
