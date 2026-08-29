// ============================================================
// admin-messages-unified — Messages screen (design handoff:
// design_handoff_messages_settings/Messages.dc.html)
// ============================================================
// Replaces three scattered surfaces (Family Conversations, Contact Us
// Messages, Announcements) plus the Settings "My Notifications" toggle with
// one working inbox: one feed merging all three sources, in-place
// reply/flag/archive, two inline compose panels, no link-outs.
//
// Deliberately still THREE tables underneath (message_threads/message_items,
// messages, announcements) — different senders, different lifecycles, same
// reasoning as the file this replaces (admin-threads.js). This file is a
// presentation layer over fetchAllThreads() / fetchMessages() /
// fetchAllAnnouncements(); it does not change what any of those own.
//
// The "needs an email" tracker is scoped to Contact Us rows ONLY (the
// `messages` table's needs_email_followup/replied_by_email columns) — a
// family thread is two-way in-app already and doesn't need an email escape
// hatch. See supabase/migrations/add_message_email_followup.sql.

let _msgThreads   = [];
let _msgMessages  = [];
let _msgAnnounce  = [];
let _msgFilter    = 'all';
let _msgSearch    = '';
let _msgExpanded  = null;
let _msgDrafts    = {};   // threadId -> in-progress reply text
let _msgComposeFamily = '';
let _msgComposeBody   = '';
let _msgShowCompose   = null; // null | 'message' | 'announce'

function _msgEl(id) { return document.getElementById(id); }

function _msgWhen(iso) {
    const d = new Date(iso);
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const that  = d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    return that === today
        ? d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago' })
        : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Chicago' });
}

function _msgInitials(name) {
    return String(name || '?').trim().split(/\s+/).map(w => w[0]).slice(0, 2).join('').toUpperCase();
}

// Mirrors _thrUnread from the retired admin-threads.js — a thread is
// "waiting on us" when the last parent message has not been read.
function _msgThreadUnread(t) {
    return (t.message_items || []).filter(m => m.sender_type === 'parent' && !m.read_at).length;
}

async function renderMessagesUnifiedTool() {
    _msgBindOnce();
    const feed = _msgEl('msgFeed');
    if (feed) feed.innerHTML = '<p class="muted">Loading…</p>';
    try {
        [_msgThreads, _msgMessages, _msgAnnounce] = await Promise.all([
            fetchAllThreads(),
            fetchMessages(false),
            fetchAllAnnouncements(),
        ]);
    } catch (e) {
        if (feed) feed.innerHTML = `<p class="muted">Could not load messages: ${escHtml(e.message || e)}</p>`;
        return;
    }
    _msgRender();
    if (typeof apPushRefreshToggle === 'function') apPushRefreshToggle();
}

function _msgBindOnce() {
    if (window._msgBound) return;
    window._msgBound = true;

    _msgEl('msgSearch')?.addEventListener('input', e => { _msgSearch = e.target.value; _msgRenderFeed(); });
    _msgEl('msgKpis')?.addEventListener('click', e => {
        const b = e.target.closest('[data-msg-kpi]');
        if (!b) return;
        _msgFilter = b.dataset.msgKpi;
        _msgRender();
    });
    _msgEl('msgOpenComposeBtn')?.addEventListener('click', () => {
        _msgShowCompose = _msgShowCompose === 'message' ? null : 'message';
        _msgRenderComposers();
    });
    _msgEl('msgOpenAnnounceBtn')?.addEventListener('click', async () => {
        _msgShowCompose = _msgShowCompose === 'announce' ? null : 'announce';
        _msgRenderComposers();
        if (_msgShowCompose === 'announce' && typeof renderAnnouncementsTool === 'function') {
            await renderAnnouncementsTool();
        }
    });
    _msgEl('msgComposeCloseBtn')?.addEventListener('click', () => { _msgShowCompose = null; _msgRenderComposers(); });
    _msgEl('msgAnnounceCloseBtn')?.addEventListener('click', () => { _msgShowCompose = null; _msgRenderComposers(); });

    _msgEl('msgComposeFamily')?.addEventListener('change', e => { _msgComposeFamily = e.target.value; });
    _msgEl('msgComposeBody')?.addEventListener('input', e => { _msgComposeBody = e.target.value; });
    _msgEl('msgComposeSendBtn')?.addEventListener('click', _msgSendCompose);
}

function _msgRender() {
    _msgRenderKpis();
    _msgRenderFilterSeg();
    _msgRenderComposers();
    _msgRenderFeed();
}

function _msgRenderKpis() {
    const el = _msgEl('msgKpis');
    if (!el) return;
    const waitingCount     = _msgThreads.filter(t => _msgThreadUnread(t) > 0).length;
    const newInquiriesCount = _msgMessages.filter(m => !m.is_read && !m.is_archived).length;
    const needsEmailCount  = _msgMessages.filter(m => m.needs_email_followup && !m.replied_by_email).length;
    const card = (kpi, tone, label, count, sub) => `
        <button type="button" class="msg-kpi tone-${tone}${_msgFilter === kpi ? ' is-on' : ''}" data-msg-kpi="${kpi}">
            <span class="msg-kpi-label">${escHtml(label)}</span>
            <span class="msg-kpi-count">${count}</span>
            <span class="msg-kpi-sub">${escHtml(sub)}</span>
        </button>`;
    el.innerHTML =
        card('waiting', 'tang', 'Waiting on us', waitingCount, 'enrolled families with no reply yet') +
        card('inquiries', 'gold', 'New inquiries', newInquiriesCount, 'unread from the Contact Us form') +
        card('email', 'green', 'Needs an email', needsEmailCount, 'flagged, no email logged yet');
}

function _msgRenderFilterSeg() {
    const seg = _msgEl('msgFilterSeg');
    if (!seg) return;
    const opts = [['all', 'All'], ['family', 'Family threads'], ['contact', 'Contact form'], ['sent', 'Announcements']];
    seg.innerHTML = opts.map(([key, label]) =>
        `<button type="button" class="ap-seg-btn${_msgFilter === key ? ' is-on' : ''}" data-msg-filter="${key}">${escHtml(label)}</button>`
    ).join('');
    seg.querySelectorAll('[data-msg-filter]').forEach(b => {
        b.addEventListener('click', () => { _msgFilter = b.dataset.msgFilter; _msgRender(); });
    });
}

function _msgRenderComposers() {
    const msgWrap = _msgEl('msgComposeWrap');
    const anWrap  = _msgEl('msgAnnounceWrap');
    if (msgWrap) msgWrap.classList.toggle('hidden', _msgShowCompose !== 'message');
    if (anWrap)  anWrap.classList.toggle('hidden', _msgShowCompose !== 'announce');
    if (_msgShowCompose === 'message') {
        const sel = _msgEl('msgComposeFamily');
        if (sel) {
            sel.innerHTML = '<option value="">Choose a family…</option>' + _msgThreads.map(t =>
                `<option value="${t.id}"${String(t.id) === String(_msgComposeFamily) ? ' selected' : ''}>${escHtml(t.families?.parent_name || 'Family')}</option>`
            ).join('');
        }
        const body = _msgEl('msgComposeBody');
        if (body) body.value = _msgComposeBody;
    }
}

async function _msgSendCompose() {
    if (!_msgComposeFamily || !_msgComposeBody.trim()) { showToast('Pick a family and write a message.', 'error'); return; }
    const btn = _msgEl('msgComposeSendBtn');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
        await sendAdminMessage(_msgComposeFamily, _msgComposeBody.trim(), 'The office');
        _msgComposeBody = ''; _msgComposeFamily = ''; _msgShowCompose = null;
        showToast('Message sent.');
        await renderMessagesUnifiedTool();
    } catch (e) {
        showToast('Could not send: ' + (e.message || e), 'error');
    } finally {
        btn.disabled = false; btn.textContent = 'Send';
    }
}

// ── Feed ─────────────────────────────────────────────────────
function _msgBuildFeed() {
    const items = [];

    _msgThreads.forEach(t => {
        const key   = 'thread-' + t.id;
        const msgs  = (t.message_items || []).slice().sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        const last  = msgs[msgs.length - 1];
        const waiting = _msgThreadUnread(t) > 0;
        items.push({
            // ⚠️ Threads are PER CHILD now (per_child_message_threads.sql), so
            // the row has to say which one — the office replies "she wouldn't
            // nap" and a parent with two children cannot tell who that was
            // about. A thread with no student_id is the family's general one.
            key, kind: 'thread',
            name: t.students?.child_name
                ? `${t.families?.parent_name || 'Family'} · ${t.students.child_name}`
                : (t.families?.parent_name || 'Family'),
            metaLine: (t.students?.child_name ? 'About ' + t.students.child_name : 'Family conversation')
                + ' · ' + (t.families?.parent_email || ''),
            preview: last?.body || 'No messages yet', sortTs: t.last_message_at || last?.created_at || 0,
            priority: waiting ? 0 : 1, icon: _msgInitials(t.families?.parent_name), iconBg: '#C9E6DC',
            accent: waiting ? 'var(--tang)' : 'var(--green-text)',
            statusText: waiting ? 'Waiting on you' : 'Replied',
            statusTone: waiting ? 'tang' : 'sand',
            raw: t, msgs,
        });
    });

    _msgMessages.forEach(m => {
        const key = 'inquiry-' + m.id;
        const needsEmail = m.needs_email_followup && !m.replied_by_email;
        const statusText = !m.is_read ? 'New' : (needsEmail ? 'Needs an email' : 'Read');
        items.push({
            key, kind: 'inquiry', name: m.parent_name || 'Unknown',
            metaLine: 'Contact form · prospective family', preview: m.message,
            sortTs: m.created_at, priority: !m.is_read ? 0 : 1,
            icon: '📮', iconBg: 'var(--sun-pale)', accent: 'var(--sun)',
            statusText, statusTone: !m.is_read ? 'gold' : (needsEmail ? 'green' : 'sand'),
            raw: m,
        });
    });

    _msgAnnounce.filter(a => a.published_at).forEach(a => {
        const key = 'announce-' + a.id;
        items.push({
            key, kind: 'sent', name: a.title,
            metaLine: (a.kind === 'closure' ? '🚨 Closure' : '📣 Announcement') + ' · sent',
            preview: a.body, sortTs: a.published_at, priority: 2,
            icon: a.kind === 'closure' ? '🚨' : '📣', iconBg: 'var(--sun-pale)', accent: 'var(--sun)',
            statusText: 'Sent', statusTone: 'sand',
            raw: a,
        });
    });

    const q = _msgSearch.trim().toLowerCase();
    let filtered = items.filter(it => {
        if (q && !it.name.toLowerCase().includes(q)) return false;
        if (_msgFilter === 'waiting')   return it.kind === 'thread' && it.statusText === 'Waiting on you';
        if (_msgFilter === 'inquiries') return it.kind === 'inquiry';
        if (_msgFilter === 'email')     return it.kind === 'inquiry' && it.raw.needs_email_followup && !it.raw.replied_by_email;
        if (_msgFilter === 'family')    return it.kind === 'thread';
        if (_msgFilter === 'contact')   return it.kind === 'inquiry';
        if (_msgFilter === 'sent')      return it.kind === 'sent';
        return true;
    });
    filtered.sort((a, b) => a.priority - b.priority || new Date(b.sortTs) - new Date(a.sortTs));
    return filtered;
}

function _msgRenderFeed() {
    const wrap = _msgEl('msgFeed');
    if (!wrap) return;
    const feed = _msgBuildFeed();

    if (!feed.length) {
        wrap.innerHTML = '<p class="muted" style="padding:18px 2px">Nothing matches this filter.</p>';
        return;
    }

    wrap.innerHTML = feed.map(item => `
        <div class="msg-row" style="border-left-color:${item.accent}">
            <div class="msg-row-head">
                <button type="button" class="msg-row-clickable" data-msg-toggle="${item.key}">
                    <span class="msg-row-icon" style="background:${item.iconBg}">${item.icon}</span>
                    <span class="msg-row-main">
                        <span class="msg-row-top">
                            <span class="msg-row-name">${escHtml(item.name)}</span>
                            <span class="msg-row-when">${escHtml(_msgWhen(item.sortTs))}</span>
                        </span>
                        <span class="msg-row-meta">${escHtml(item.metaLine)}</span>
                        <span class="msg-row-preview">${escHtml(item.preview || '')}</span>
                    </span>
                </button>
                ${item.kind === 'inquiry' ? `
                <span class="msg-row-actions">
                    <label class="msg-row-check" title="Mark read or unread">
                        <input type="checkbox" data-msg-read="${item.raw.id}" ${item.raw.is_read ? 'checked' : ''}> Read
                    </label>
                    <label class="msg-row-check" title="Archive — removes it from this list">
                        <input type="checkbox" data-msg-archive-check="${item.raw.id}"> Archive
                    </label>
                </span>`
                : `<span class="msg-status-pill tone-${item.statusTone}">${escHtml(item.statusText)}</span>`}
            </div>
            <div class="msg-row-body${_msgExpanded === item.key ? '' : ' hidden'}" data-msg-body="${item.key}"></div>
        </div>`).join('');

    wrap.querySelectorAll('[data-msg-toggle]').forEach(b => {
        b.addEventListener('click', () => _msgToggle(b.dataset.msgToggle, feed));
    });
    wrap.querySelectorAll('[data-msg-read]').forEach(box => {
        box.addEventListener('change', e => _msgSetInquiryRead(Number(box.dataset.msgRead), e.target.checked, feed));
    });
    wrap.querySelectorAll('[data-msg-archive-check]').forEach(box => {
        box.addEventListener('change', e => _msgSetInquiryArchived(Number(box.dataset.msgArchiveCheck), e.target.checked));
    });

    if (_msgExpanded) {
        const item = feed.find(i => i.key === _msgExpanded);
        if (item) _msgRenderExpanded(item);
    }
}

function _msgToggle(key, feed) {
    const wasOpen = _msgExpanded === key;
    _msgExpanded = wasOpen ? null : key;
    const item = feed.find(i => i.key === key);
    if (!wasOpen && item?.kind === 'thread') _msgMarkThreadRead(item);
    if (!wasOpen && item?.kind === 'inquiry' && !item.raw.is_read) _msgSetInquiryRead(item.raw.id, true, feed);
    _msgRenderFeed();
}

async function _msgMarkThreadRead(item) {
    try { await markThreadRead(item.raw.id); } catch (e) { console.warn('mark thread read:', e); }
}

// The Read checkbox on a Contact form row — works both ways (mark read,
// or mark back unread), independent of expanding the row.
async function _msgSetInquiryRead(id, isRead, feed) {
    const item = (feed || []).find(i => i.kind === 'inquiry' && i.raw.id === id);
    try {
        await markMessageRead(id, isRead);
        if (item) item.raw.is_read = isRead;
        const raw = _msgMessages.find(m => m.id === id);
        if (raw) raw.is_read = isRead;
        _msgRenderKpis();
        // Only the pill/preview need updating, not a full feed rebuild —
        // re-render the one row's collapsed status without losing scroll
        // position or another row's expanded state.
        if (item && _msgExpanded !== item.key) _msgRenderFeed();
        else if (item) _msgRenderExpanded(item);
    } catch (err) {
        showToast('Could not update: ' + (err.message || err), 'error');
        _msgRenderFeed();
    }
}

// The Archive checkbox — checking it archives the message and drops the
// row from the feed immediately (fetchMessages(false) never returns
// archived rows, so there is no "unarchive" checkbox to show here; that
// stays in the expanded detail panel via the existing Archive/Restore
// pattern elsewhere in the app).
async function _msgSetInquiryArchived(id, archived) {
    if (!archived) return;
    try {
        await archiveMessage(id, true);
        _msgMessages = _msgMessages.filter(m => m.id !== id);
        if (_msgExpanded === 'inquiry-' + id) _msgExpanded = null;
        showToast('Archived.');
        _msgRender();
    } catch (err) {
        showToast('Could not archive: ' + (err.message || err), 'error');
        _msgRenderFeed();
    }
}

function _msgRenderExpanded(item) {
    const body = document.querySelector(`[data-msg-body="${item.key}"]`);
    if (!body) return;

    if (item.kind === 'thread') {
        body.innerHTML = `
            <div class="thr-messages" style="max-height:260px;overflow:auto;margin-bottom:10px">
                ${item.msgs.map(m => `<div class="thr-msg thr-${m.sender_type === 'parent' ? 'them' : 'us'}">
                    <span class="thr-msg-who">${escHtml(m.sender_name || (m.sender_type === 'parent' ? 'Parent' : 'Office'))}
                        · ${escHtml(_msgWhen(m.created_at))}</span>
                    <span class="thr-msg-body">${escHtml(m.body)}</span>
                </div>`).join('') || '<p class="muted">No messages yet.</p>'}
            </div>
            <div class="thr-composer">
                <textarea rows="2" placeholder="Reply to this family…" id="msgReplyInput-${item.raw.id}">${escHtml(_msgDrafts[item.raw.id] || '')}</textarea>
                <button class="btn-primary" id="msgReplyBtn-${item.raw.id}">Send reply</button>
            </div>`;
        const input = _msgEl(`msgReplyInput-${item.raw.id}`);
        input?.addEventListener('input', e => { _msgDrafts[item.raw.id] = e.target.value; });
        _msgEl(`msgReplyBtn-${item.raw.id}`)?.addEventListener('click', () => _msgSendReply(item.raw.id));
        return;
    }

    if (item.kind === 'inquiry') {
        const m = item.raw;
        body.innerHTML = `
            <p style="font-size:.92em;line-height:1.5;margin:0 0 10px">${escHtml(m.message)}</p>
            <p style="font-size:.85em;margin:0 0 12px">
                <a href="mailto:${escHtml(m.parent_email || '')}" style="color:var(--green-text);font-weight:700;text-decoration:none">✉ ${escHtml(m.parent_email || 'no email on file')}</a>
                — no in-app reply for this form; replies go out by email.
            </p>
            <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px">
                <button class="btn-ghost" data-msg-archive="${m.id}">📥 Archive</button>
                <button class="btn-ghost" style="color:var(--tang-dark,#7a2a18)" data-msg-delete="${m.id}">🗑 Delete</button>
            </div>
            <div class="msg-email-tracker">
                <label><input type="checkbox" data-msg-flag="${m.id}" ${m.needs_email_followup ? 'checked' : ''}> Needs an email, not just this</label>
                ${m.needs_email_followup ? `<label class="is-green"><input type="checkbox" data-msg-replied="${m.id}" ${m.replied_by_email ? 'checked' : ''}> ✓ Replied by email</label>` : ''}
            </div>`;
        body.querySelector('[data-msg-archive]')?.addEventListener('click', async () => {
            try { await archiveMessage(m.id, true); showToast('Archived.'); await renderMessagesUnifiedTool(); }
            catch (e) { showToast('Could not archive: ' + (e.message || e), 'error'); }
        });
        body.querySelector('[data-msg-delete]')?.addEventListener('click', async () => {
            if (!confirm('Permanently delete this message? This cannot be undone.')) return;
            try { await deleteMessage(m.id); showToast('Deleted.'); await renderMessagesUnifiedTool(); }
            catch (e) { showToast('Could not delete: ' + (e.message || e), 'error'); }
        });
        body.querySelector('[data-msg-flag]')?.addEventListener('change', async e => {
            const on = e.target.checked;
            try {
                await setMessageEmailFollowup(m.id, { needsEmail: on, repliedByEmail: on ? m.replied_by_email : false });
                m.needs_email_followup = on;
                if (!on) m.replied_by_email = false;
                _msgRenderExpanded(item); _msgRenderKpis();
            } catch (err) { showToast('Could not update: ' + (err.message || err), 'error'); }
        });
        body.querySelector('[data-msg-replied]')?.addEventListener('change', async e => {
            const on = e.target.checked;
            try {
                await setMessageEmailFollowup(m.id, { repliedByEmail: on });
                m.replied_by_email = on;
                _msgRenderExpanded(item); _msgRenderKpis();
            } catch (err) { showToast('Could not update: ' + (err.message || err), 'error'); }
        });
        return;
    }

    // Announcement — read-only detail, not replyable.
    const a = item.raw;
    const audience = a.audience === 'staff' ? 'Staff only' : a.audience === 'everyone' ? 'Families and staff'
        : a.audience === 'room' ? 'Selected rooms' : 'All families';
    body.innerHTML = `
        <p style="font-size:.92em;line-height:1.5;margin:0 0 10px">${escHtml(a.body)}</p>
        <p style="font-size:.85em;color:var(--text-muted);margin:0">${escHtml(audience)}. Not replyable — a family who wants to respond will start a family conversation instead.</p>`;
}

async function _msgSendReply(threadId) {
    const input = _msgEl(`msgReplyInput-${threadId}`);
    const body  = (input?.value || '').trim();
    if (!body) return;
    const btn = _msgEl(`msgReplyBtn-${threadId}`);
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
        await sendAdminMessage(threadId, body, 'The office');
        delete _msgDrafts[threadId];
        showToast('Reply sent.');
        await renderMessagesUnifiedTool();
        _msgExpanded = 'thread-' + threadId;
        _msgRenderFeed();
    } catch (e) {
        // Box keeps its text — the retyping-a-reply failure mode this app
        // already avoids everywhere else (see admin-threads.js's old _thrSend).
        showToast('Could not send: ' + (e.message || e), 'error');
        btn.disabled = false; btn.textContent = 'Send reply';
    }
}
