// ============================================================
// admin-push — director/admin push subscription for new parent messages
// ============================================================
// Push plumbing (worker.js VAPID signing + RFC 8291 encryption) has existed
// for parents and named staff for months, but nothing ever subscribed an
// admin login — a new message in the Messages inbox just sat there until
// someone happened to open that tab. This is the "Notify me" toggle that
// closes that gap — it lives in the Messages tab header now (moved there
// from Settings in the Messages & Settings consolidation, 2026-08-26; see
// admin-messages-unified.js), the markup and this logic unchanged.
//
// ⚠️ Gated to 'full' admins only, both here and server-side
// (/admin-push-subscribe checks admin_role() itself — never trust this
// client-side check alone). A 'restricted' or 'staff' login never sees the
// office-wide Messages inbox, so pushing them would alert someone who has
// nowhere to act on it.

const AP_PUSH_VAPID_PUBLIC_KEY =
    'BBIxNz5wAh3wt5Rb3OXdirHU8_25JKle9pTDtWRHmFNkv5gLuTOX5lckdNdV0pNPaXx-qj6N9lFwrdW8auBnAhk';

function _apPushB64ToU8(b64url) {
    const pad = '='.repeat((4 - b64url.length % 4) % 4);
    const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

/** Reflects the toggle to match whatever this browser is actually subscribed to. */
async function apPushRefreshToggle() {
    const wrap = document.getElementById('apPushToggleWrap');
    const box  = document.getElementById('apPushToggle');
    const note = document.getElementById('apPushStatus');
    if (!wrap || !box) return;

    // Only a full admin reads the unscoped Parent Messages inbox — see the
    // file header. Hide the whole control for anyone else rather than offer a
    // toggle that would silently do nothing useful for them.
    if (typeof currentAdminRole !== 'undefined' && currentAdminRole !== 'full') {
        wrap.style.display = 'none';
        return;
    }
    wrap.style.display = '';

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
        box.disabled = true;
        if (note) note.textContent = 'Push notifications are not supported in this browser.';
        return;
    }

    try {
        const reg = await navigator.serviceWorker.ready;
        const sub = await reg.pushManager.getSubscription();
        box.checked = !!sub;
    } catch (err) {
        console.warn('apPushRefreshToggle:', err);
    }
}

async function apPushOnToggle(checked) {
    const note = document.getElementById('apPushStatus');
    const box  = document.getElementById('apPushToggle');
    if (note) note.textContent = '';

    if (!('serviceWorker' in navigator) || !('PushManager' in window)) return;
    const reg = await navigator.serviceWorker.ready;

    if (checked) {
        try {
            const sub = await reg.pushManager.subscribe({
                userVisibleOnly:      true,
                applicationServerKey: _apPushB64ToU8(AP_PUSH_VAPID_PUBLIC_KEY),
            });
            const { endpoint, keys: { p256dh, auth } } = sub.toJSON();
            const session = await getAdminSession();
            const res = await fetch('/admin-push-subscribe', {
                method:  'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${session?.access_token || ''}`,
                },
                body: JSON.stringify({ endpoint, p256dh, auth }),
            });
            if (!res.ok) throw new Error(`subscribe failed (${res.status})`);
            if (note) note.textContent = "You'll be notified here when a parent sends a message.";
        } catch (err) {
            console.warn('admin push subscribe:', err);
            if (box) box.checked = false;
            if (note) note.textContent = 'Could not turn notifications on: ' + (err.message || err);
        }
    } else {
        try {
            const sub = await reg.pushManager.getSubscription();
            if (sub) await sub.unsubscribe();
            if (note) note.textContent = 'Notifications turned off for this browser.';
        } catch (err) {
            console.warn('admin push unsubscribe:', err);
        }
    }
}

function apPushInit() {
    const box = document.getElementById('apPushToggle');
    if (box) box.addEventListener('change', e => apPushOnToggle(e.target.checked));
    apPushRefreshToggle();
}
