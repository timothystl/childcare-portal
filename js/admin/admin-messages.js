// ============================================================
// MODULE: Admin Messages (parent contact form inbox)
// ============================================================

// MESSAGES
// ============================================================
let showArchivedMessages = false;
let _messagesLoaded      = false;

function setupMessages() {
    document.getElementById('refreshMessagesBtn')?.addEventListener('click', loadMessages);
    document.getElementById('toggleArchivedBtn')?.addEventListener('click', () => {
        showArchivedMessages = !showArchivedMessages;
        const btn = document.getElementById('toggleArchivedBtn');
        btn.textContent = showArchivedMessages ? 'Hide Archived' : 'Show Archived';
        btn.classList.toggle('btn-active', showArchivedMessages);
        loadMessages();
    });
}

async function loadMessages() {
    const container = document.getElementById('messagesList');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const messages = await fetchMessages(showArchivedMessages);
        renderMessagesList(messages);
    } catch (err) {
        container.innerHTML = `<p class="import-error">Failed to load messages: ${escHtml(err.message)}</p>`;
    }
}

function renderMessagesList(messages) {
    const container    = document.getElementById('messagesList');
    const unreadBadge  = document.getElementById('unreadBadge');
    const unreadCount  = messages.filter(m => !m.is_read && !m.is_archived).length;

    if (unreadBadge) {
        if (unreadCount > 0) {
            unreadBadge.textContent = `${unreadCount} unread`;
            unreadBadge.classList.remove('hidden');
        } else {
            unreadBadge.classList.add('hidden');
        }
    }

    if (!messages.length) {
        container.innerHTML = showArchivedMessages
            ? '<p class="empty-hint">No archived messages.</p>'
            : '<p class="empty-hint">No messages yet.</p>';
        return;
    }

    container.innerHTML = `
        <ul class="messages-list">
            ${messages.map(m => {
                const ts = new Date(m.created_at).toLocaleString('en-US',
                    { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
                const isArchived = !!m.is_archived;
                return `
                    <li class="message-item${m.is_read ? '' : ' message-unread'}${isArchived ? ' message-archived' : ''}" data-id="${m.id}">
                        <div class="message-header">
                            <span class="message-from">${escHtml(m.parent_name || 'Unknown')}</span>
                            ${m.parent_email ? `<a href="mailto:${escHtml(m.parent_email)}" class="message-email">${escHtml(m.parent_email)}</a>` : ''}
                            <span class="message-time">${ts}</span>
                            ${!m.is_read && !isArchived ? '<span class="message-new-badge">New</span>' : ''}
                            ${isArchived ? '<span class="message-archived-badge">Archived</span>' : ''}
                        </div>
                        <div class="message-body">${escHtml(m.message)}</div>
                        <div class="message-actions">
                            ${!m.is_read && !isArchived ? `<button class="btn-mark-read" data-id="${m.id}">Mark as Read</button>` : ''}
                            ${isArchived
                                ? `<button class="btn-restore-msg" data-id="${m.id}">↩ Restore</button>`
                                : `<button class="btn-archive-msg" data-id="${m.id}" title="Archive message">📥 Archive</button>`
                            }
                            <button class="btn-delete-msg" data-id="${m.id}" title="Delete message permanently">🗑 Delete</button>
                        </div>
                    </li>`;
            }).join('')}
        </ul>`;

    container.querySelectorAll('.btn-mark-read').forEach(btn => {
        btn.addEventListener('click', async e => {
            const id = e.currentTarget.getAttribute('data-id');
            try {
                await markMessageRead(id);
                await loadMessages();
            } catch (err) {
                alert('Failed to mark read: ' + err.message);
            }
        });
    });

    container.querySelectorAll('.btn-archive-msg').forEach(btn => {
        btn.addEventListener('click', async e => {
            const id = e.currentTarget.getAttribute('data-id');
            try {
                await archiveMessage(id, true);
                await loadMessages();
            } catch (err) {
                alert('Failed to archive: ' + err.message);
            }
        });
    });

    container.querySelectorAll('.btn-restore-msg').forEach(btn => {
        btn.addEventListener('click', async e => {
            const id = e.currentTarget.getAttribute('data-id');
            try {
                await archiveMessage(id, false);
                await loadMessages();
            } catch (err) {
                alert('Failed to restore: ' + err.message);
            }
        });
    });

    container.querySelectorAll('.btn-delete-msg').forEach(btn => {
        btn.addEventListener('click', async e => {
            const id = e.currentTarget.getAttribute('data-id');
            if (!confirm('Permanently delete this message? This cannot be undone.')) return;
            try {
                await deleteMessage(id);
                await loadMessages();
            } catch (err) {
                alert('Failed to delete: ' + err.message);
            }
        });
    });
}

// ============================================================
