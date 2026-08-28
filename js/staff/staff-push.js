// ============================================================
// staff-push — get this phone registered for the missing-child alert
// ============================================================
// ⚠️ WHY THIS FILE EXISTS. The push plumbing has been built and working for
// months (worker.js: /staff-push-subscribe, /send-staff-broadcast, VAPID JWT +
// RFC 8291 encryption) — but the ONLY place that ever asked a staff member to
// subscribe was clockin.html. The staff app never did. The result, measured:
// 3 subscriptions against 31 active staff. A broadcast to "every phone in the
// building" would have reached three of them.
//
// So the alert was not blocked on writing a push function. It was blocked on
// nobody having a subscription to push to.
//
// ⚠️ THE ASK IS FRAMED AS THE ALERT, NOT AS "notifications". clockin.html asks
// about shift reminders, which is a fair thing to decline; this one says what
// it is actually for. Somebody who turns down shift reminders on the kiosk
// should still be asked about the alert that gets a child found.

const SL_VAPID_PUBLIC_KEY =
    'BBIxNz5wAh3wt5Rb3OXdirHU8_25JKle9pTDtWRHmFNkv5gLuTOX5lckdNdV0pNPaXx-qj6N9lFwrdW8auBnAhk';

function slPushKey(staffId) { return `mdo_staff_push_${staffId}`; }

function slB64ToU8(b64url) {
    const pad = '='.repeat((4 - b64url.length % 4) % 4);
    const raw = atob((b64url + pad).replace(/-/g, '+').replace(/_/g, '/'));
    return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

/**
 * Called right after sign-in. The PIN is passed in rather than read from the
 * module global at tap time — slPin is cleared when the screen changes, and by
 * the time somebody taps Allow it is often already empty. Same bug clockin.html
 * documents having hit.
 */
async function slInitPush(staffId, pin) {
    if (!('Notification' in window) || !('serviceWorker' in navigator) || !('PushManager' in window)) return;
    if (Notification.permission === 'denied') return;
    if (!staffId || !pin) return;

    let reg;
    try { reg = await navigator.serviceWorker.ready; } catch { return; }

    // Already subscribed on this device: re-post it anyway. Endpoints rotate,
    // and a stale row means a phone that looks registered and receives nothing.
    const existing = await reg.pushManager.getSubscription().catch(() => null);
    if (existing) { slSavePush(existing, staffId, pin); return; }

    if (sessionStorage.getItem('mdo_staff_push_dismissed')) return;
    if (localStorage.getItem(slPushKey(staffId))) return;

    slShowPushPrompt(reg, staffId, pin);
}

function slShowPushPrompt(reg, staffId, pin) {
    if (document.getElementById('slPushPrompt')) return;

    const el = document.createElement('div');
    el.id = 'slPushPrompt';
    el.className = 'sl-push-prompt';
    el.innerHTML = `
        <span class="sl-push-icon" aria-hidden="true">🚨</span>
        <span class="sl-push-text">
            <strong>Turn on alerts for this phone?</strong>
            If a child goes missing, every staff phone gets it at once — including
            when the app is closed.
        </span>
        <span class="sl-push-btns">
            <button type="button" class="sl-push-allow" id="slPushAllow">Turn on</button>
            <button type="button" class="sl-push-no" id="slPushNo" aria-label="Not now">✕</button>
        </span>`;
    document.body.appendChild(el);

    document.getElementById('slPushAllow').onclick = async () => {
        el.remove();
        try {
            const sub = await reg.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: slB64ToU8(SL_VAPID_PUBLIC_KEY),
            });
            const ok = await slSavePush(sub, staffId, pin);
            slToast(ok ? 'Alerts on for this phone.' : 'Could not turn alerts on.', ok ? 'ok' : 'err');
        } catch (err) {
            console.warn('staff push subscribe:', err);
            slToast('Could not turn alerts on.', 'err');
        }
    };
    document.getElementById('slPushNo').onclick = () => {
        el.remove();
        // Session-scoped, not permanent. This is the one notification worth
        // asking about again tomorrow.
        sessionStorage.setItem('mdo_staff_push_dismissed', '1');
    };
}

async function slSavePush(sub, staffId, pin) {
    const { endpoint, keys: { p256dh, auth } } = sub.toJSON();
    try {
        // staff_id is derived server-side from the PIN; the endpoint ignores a
        // caller-supplied id, because it used to accept one with no auth at all.
        const res = await fetch('/staff-push-subscribe', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ staff_id: staffId, pin, endpoint, p256dh, auth }),
        });
        if (res.ok) { localStorage.setItem(slPushKey(staffId), '1'); return true; }
        return false;
    } catch (err) {
        console.warn('staff push save:', err);
        return false;
    }
}

/**
 * Fire the broadcast. Sends an alert id and nothing else — the worker reads the
 * alert and writes the message, so no wording or recipient travels from here.
 *
 * Best-effort by design: the in-app banner is the reliable channel and it is
 * already up by the time this runs. A phone with no signal must not make the
 * raise fail.
 */
async function slBroadcastMissing(alertId, cleared = false) {
    if (!slStaffId || !slPin || !alertId) return 0;
    try {
        const res = await fetch('/send-staff-broadcast', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({
                staff_id: slStaffId,
                pin:      slPin,
                kind:     cleared ? 'missing_child_cleared' : 'missing_child',
                alert_id: alertId,
            }),
        });
        if (!res.ok) { console.warn('staff broadcast:', res.status); return 0; }
        const { sent } = await res.json().catch(() => ({ sent: 0 }));
        return sent || 0;
    } catch (err) {
        console.warn('staff broadcast:', err);
        return 0;
    }
}

/**
 * Push the admins subscribed to "Notify me" the moment an incident is filed —
 * independent of whether the parent has signed yet. Sends an incident id and
 * nothing else; worker.js re-reads the report and writes the notification
 * itself, same posture as slBroadcastMissing() above.
 *
 * Best-effort, same rule as the rest of this file's push calls: a report that
 * filed successfully must not read as failed because a push didn't land.
 */
async function slNotifyAdminsOfIncident(incidentId) {
    if (!slStaffId || !slPin || !incidentId) return 0;
    try {
        const res = await fetch('/notify-admin-incident', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ staff_id: slStaffId, pin: slPin, incident_id: incidentId }),
        });
        if (!res.ok) { console.warn('admin incident notify:', res.status); return 0; }
        const { sent } = await res.json().catch(() => ({ sent: 0 }));
        return sent || 0;
    } catch (err) {
        console.warn('admin incident notify:', err);
        return 0;
    }
}
