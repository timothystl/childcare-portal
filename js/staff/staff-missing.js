// ============================================================
// staff-missing — the missing-child broadcast
// ============================================================
// Handoff, Surface 1 §2, footer: "🚨 Missing child — solid coral. Decided
// behavior: this alerts every staff phone in the building at once (name, photo,
// room, what the child was last wearing) and rings in the office. It is not a
// message to the director. Every adult searches. Build it as a broadcast push
// to all staff devices with an acknowledge-and-see-who's-searching state."
//
// ⚠️ IT IS NOT A MESSAGE TO THE DIRECTOR, AND THE UI MUST NOT LET IT BECOME
// ONE. There is no recipient picker, no "notify the office" checkbox, no draft
// step. Raising it puts the same banner on every signed-in staff phone and on
// the director's attendance board simultaneously. The one decision the person
// raising it makes is which child.
//
// ⚠️ THE BANNER OUTRANKS EVERY OTHER SCREEN. It is rendered above the route,
// on all five tabs, and it does not have a dismiss control — only "I'm
// searching" and "Found". A missing-child alert you can swipe away is a
// missing-child alert somebody swipes away.
//
// ⚠️ WHAT IS NOT BUILT YET, AND WHY IT MATTERS: the actual push notification.
// The handoff says "broadcast push to all staff devices", and this ships the
// broadcast as an in-app banner that every phone picks up within HC_POLL_MS.
// That covers a phone with the app open, which during a drill or a search is
// most of them — but NOT a phone in a pocket with the screen off.
//   The blocker is real and pre-existing: three places in this codebase already
//   POST to `/send-push` (admin-calendar.js, admin-settings.js,
//   admin-incidents.js) and no such edge function exists — those calls have been
//   failing silently into a catch block. Wiring push here would mean writing
//   that function and provisioning VAPID keys, which is its own piece of work.
//   Until it exists, do not describe this alert to staff as a push.

const HC_POLL_MS = 15000;

let mcAlerts   = [];
let mcPollId   = null;
let mcLastSeen = new Set();   // alert ids this device has already announced

function mcEl(id) { return document.getElementById(id); }

// ── Polling ─────────────────────────────────────────────────
// Every 15 seconds, on every tab, for as long as somebody is signed in. This is
// one small RPC and it is the cheapest thing in the app to get wrong in the
// other direction — a two-minute-stale "no alerts" during a search is useless.

function mcStartPolling() {
    if (mcPollId) return;
    mcPoll();
    mcPollId = setInterval(mcPoll, HC_POLL_MS);
    // A phone that was asleep in a pocket comes back stale; re-read the moment
    // it wakes rather than waiting out the rest of the interval.
    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') mcPoll();
    });
}

function mcStopPolling() {
    if (mcPollId) { clearInterval(mcPollId); mcPollId = null; }
    mcAlerts = [];
    mcRenderBanner();
}

async function mcPoll() {
    if (!slStaffId || !slPin) return;
    try {
        mcAlerts = await fetchActiveMissingChild(slStaffId, slPin) || [];
    } catch (err) {
        // A failed poll must never blank an alert that is already on screen —
        // losing the banner because the wifi dipped is the worst outcome here.
        console.warn('missing-child poll (keeping last known):', err);
        return;
    }
    mcAnnounce();
    mcRenderBanner();
}

// Vibrate once per new alert, if the device allows it. Deliberately not a
// sound: the phone may be in a room of sleeping infants, and a teacher who
// silences the app to protect a nap must not thereby silence this.
function mcAnnounce() {
    for (const a of mcAlerts) {
        if (mcLastSeen.has(a.id)) continue;
        mcLastSeen.add(a.id);
        try { navigator.vibrate?.([200, 100, 200, 100, 400]); } catch { /* not supported */ }
    }
}

// ── The banner ──────────────────────────────────────────────

function mcRenderBanner() {
    let host = mcEl('mcBanner');
    if (!mcAlerts.length) { host?.remove(); return; }

    if (!host) {
        host = document.createElement('div');
        host.id = 'mcBanner';
        host.className = 'mc-banner';
        host.setAttribute('role', 'alert');
        // Before the route, so it is the first thing on every tab and pushes
        // the rest of the app down rather than floating over it.
        const shell = document.getElementById('slRosterScreen');
        shell?.insertBefore(host, shell.firstChild);
    }

    host.innerHTML = mcAlerts.map(a => {
        const searchers = a.searchers || [];
        const mins = Math.max(0, Math.round((Date.now() - new Date(a.raised_at).getTime()) / 60000));
        return `<div class="mc-alert" data-alert="${a.id}">
            <div class="mc-alert-top">
                <span class="mc-siren" aria-hidden="true">🚨</span>
                <div class="mc-alert-who">
                    <div class="mc-alert-name">${slEsc(a.child_name)} is missing</div>
                    <div class="mc-alert-meta">${slEsc([
                        hcRoomLabel(a.room_id),
                        a.wearing ? `wearing ${a.wearing}` : '',
                        a.last_seen ? `last seen ${a.last_seen}` : '',
                    ].filter(Boolean).join(' · '))}</div>
                    <div class="mc-alert-meta">Raised by ${slEsc(a.raised_by_name || 'staff')} ·
                        ${mins === 0 ? 'just now' : `${mins} min ago`}</div>
                </div>
            </div>
            <div class="mc-searchers">
                ${searchers.length
                    ? `<strong>${searchers.length} searching:</strong> ` +
                      searchers.map(s => slEsc(s.name + (s.searching ? ` (${s.searching})` : ''))).join(', ')
                    : '<strong>Nobody has answered yet.</strong>'}
            </div>
            <div class="mc-alert-btns">
                ${a.i_acked
                    ? '<span class="mc-acked">✓ You’re searching</span>'
                    : `<button type="button" class="mc-ack" data-ack="${a.id}">I’m searching</button>`}
                <button type="button" class="mc-found" data-found="${a.id}">Found — all clear</button>
            </div>
        </div>`;
    }).join('');

    host.querySelectorAll('[data-ack]').forEach(b => {
        b.onclick = () => mcAck(Number(b.dataset.ack), b);
    });
    host.querySelectorAll('[data-found]').forEach(b => {
        b.onclick = () => mcResolve(Number(b.dataset.found), b);
    });
}

async function mcAck(id, btn) {
    const where = prompt('Where are you searching? (optional)') || '';
    btn.disabled = true;
    try {
        await ackMissingChild(slStaffId, slPin, id, where.trim());
        await mcPoll();
    } catch (err) {
        console.warn('ack:', err);
        slToast('Could not register that. Keep searching — tell the office.', 'err');
        btn.disabled = false;
    }
}

async function mcResolve(id, btn) {
    const alert = mcAlerts.find(a => a.id === id);
    if (!confirm(`Confirm ${alert?.child_name || 'the child'} has been found and is safe?`)) return;

    btn.disabled = true;
    try {
        const ok = await resolveMissingChild(slStaffId, slPin, id,
            prompt('Where were they? (optional — this goes on the record)') || '');
        if (!ok) { slToast('That did not clear. Try again.', 'err'); btn.disabled = false; return; }
        mcLastSeen.delete(id);
        await mcPoll();
        slToast('All clear. Everyone else’s phone has cleared too.', 'ok');
    } catch (err) {
        console.warn('resolve:', err);
        slToast('Could not clear the alert.', 'err');
        btn.disabled = false;
    }
}

// ── Raising one ─────────────────────────────────────────────
// Two taps, and the second is a confirm. Deliberately short: the handoff puts
// this button on the head count screen because that is where someone realizes a
// child is not there, and a form at that moment is a form nobody fills in.

function mcOpenRaise(children) {
    const list = (children || []).filter(c => c.student_id && c.child_name);
    if (!list.length) { slToast('No children on today’s list to raise.', 'err'); return; }

    mcEl('mcRaiseList').innerHTML = list.map(c =>
        `<button type="button" class="mc-pick" data-pick="${slEsc(c.student_id)}">
            ${slEsc(c.child_name)}
            <span>${slEsc(hcRoomLabel(c.room_id))}</span>
        </button>`).join('');

    mcEl('mcRaiseList').querySelectorAll('[data-pick]').forEach(b => {
        b.onclick = () => mcRaise(b.dataset.pick, b.textContent.trim());
    });
    mcEl('mcRaiseWearing').value = '';
    mcEl('mcRaiseLastSeen').value = '';
    mcEl('mcRaiseSheet').classList.remove('hidden');
}

async function mcRaise(studentId, name) {
    if (!confirm(`Alert every staff phone in the building that ${name.split('\n')[0]} is missing?\n\n` +
                 `Everyone stops and searches. Only do this if you cannot find them.`)) return;

    try {
        const res = await raiseMissingChild(slStaffId, slPin, studentId, {
            lastSeen: mcEl('mcRaiseLastSeen').value.trim(),
            wearing:  mcEl('mcRaiseWearing').value.trim(),
        });
        if (!res) { slToast('That did not go out. Check your PIN and shout for help.', 'err'); return; }

        mcEl('mcRaiseSheet').classList.add('hidden');
        // The raiser is searching by definition — they are the one who noticed.
        if (res.id) { try { await ackMissingChild(slStaffId, slPin, res.id, 'raised it'); } catch { /* non-fatal */ } }
        await mcPoll();
        slToast(res.already ? 'Already raised — everyone has it.' : 'Sent to every phone in the building.', 'ok');
    } catch (err) {
        console.warn('raise:', err);
        slToast('That did not go out. Shout for help and try again.', 'err');
    }
}

function mcSetupMissing() {
    mcEl('mcRaiseCancel')?.addEventListener('click',
        () => mcEl('mcRaiseSheet').classList.add('hidden'));
}
