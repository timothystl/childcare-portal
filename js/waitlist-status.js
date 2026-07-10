// ============================================================
// PARENT PORTAL — Waitlist Status (email-only lookup, no PIN)
// ============================================================

let _wlsResult = null;

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('wlsCheckBtn').addEventListener('click', runLookup);
    document.getElementById('wlsEmail').addEventListener('keydown', e => { if (e.key === 'Enter') runLookup(); });
    document.querySelectorAll('[data-open-message]').forEach(btn => btn.addEventListener('click', openMessageForm));
    document.getElementById('wlsCancelMsgBtn').addEventListener('click', closeMessageForm);
    document.getElementById('wlsSendMsgBtn').addEventListener('click', sendMessage);
});

function showState(state) {
    document.getElementById('wlsEmpty').classList.toggle('hidden', state !== 'empty');
    document.getElementById('wlsNotFound').classList.toggle('hidden', state !== 'notfound');
    document.getElementById('wlsFound').classList.toggle('hidden', state !== 'found');
}

async function runLookup() {
    const email = document.getElementById('wlsEmail').value.trim();
    if (!email) return;

    closeMessageForm();
    hideToast();

    const btn = document.getElementById('wlsCheckBtn');
    btn.disabled = true;
    btn.textContent = 'Checking…';
    try {
        const result = await lookupWaitlistStatus(email);
        if (result && result.found) {
            _wlsResult = result;
            renderFound(result);
            showState('found');
        } else {
            _wlsResult = null;
            showState('notfound');
        }
    } catch (_) {
        _wlsResult = null;
        showState('notfound');
    } finally {
        btn.disabled = false;
        btn.textContent = 'Check Status';
    }
}

function renderFound(r) {
    document.getElementById('wlsChildName').textContent = r.childName;
    document.getElementById('wlsRoomLabel').textContent = r.roomLabel;

    // Derived, not stored — recomputed from position/total every render so it
    // can never drift from the numbers actually shown (see design handoff).
    const pill = document.getElementById('wlsStatusPill');
    let label, cls;
    if (r.position === 1) { label = 'Next in line!'; cls = 'wls-status-green'; }
    else if (r.position <= Math.ceil(r.totalInLine / 2)) { label = 'Almost there!'; cls = 'wls-status-green'; }
    else { label = 'Waiting'; cls = 'wls-status-amber'; }
    pill.textContent = label;
    pill.className = `wls-status-pill ${cls}`;

    document.getElementById('wlsPositionLabel').textContent = `#${r.position} of ${r.totalInLine}`;
    const pct = Math.round(((r.totalInLine - r.position + 1) / r.totalInLine) * 100);
    document.getElementById('wlsProgressFill').style.width = `${pct}%`;
    document.getElementById('wlsWaitRange').textContent = r.waitRange;

    document.getElementById('wlsSiblingNote').classList.toggle('hidden', !r.hasSibling);

    document.getElementById('wlsDesiredStart').textContent = r.desiredStart;
    document.getElementById('wlsDays').textContent = r.days;
    document.getElementById('wlsSchedule').textContent = r.schedule;
}

function openMessageForm() {
    hideToast();
    document.getElementById('wlsMessageForm').classList.remove('hidden');
}
function closeMessageForm() {
    document.getElementById('wlsMessageForm').classList.add('hidden');
    document.getElementById('wlsMsgText').value = '';
}
function hideToast() {
    document.getElementById('wlsToast').classList.add('hidden');
}

// Reuses the same "Contact Us" pipeline as calendar.html (addMessage() ->
// the `messages` table), tagged so office staff can tell it came from this
// page, rather than standing up a second inbox for waitlist questions.
async function sendMessage() {
    const msgText = document.getElementById('wlsMsgText').value.trim();
    if (!msgText) { closeMessageForm(); return; }
    const email = document.getElementById('wlsEmail').value.trim();

    const btn = document.getElementById('wlsSendMsgBtn');
    btn.disabled = true;
    btn.textContent = 'Sending…';
    try {
        await addMessage({
            parentName: _wlsResult ? `${_wlsResult.childName}'s family` : '',
            parentEmail: email,
            message: `[Waitlist Status] ${msgText}`,
        });
    } catch (_) {
        // Fallback: open mailto if the DB insert fails, matching the existing
        // Contact Us modal's behavior in js/app.js.
        const subject = encodeURIComponent('Waitlist Status Question');
        const body = encodeURIComponent(`Email: ${email}\n\n${msgText}`);
        window.location.href = `mailto:?subject=${subject}&body=${body}`;
    } finally {
        btn.disabled = false;
        btn.textContent = 'Send';
    }
    closeMessageForm();
    document.getElementById('wlsToast').classList.remove('hidden');
}
