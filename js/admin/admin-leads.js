// ============================================================
// MODULE: Leads & Tours  (design handoff — Capacity & Fill, turn 2a)
// ============================================================
// Planning → Getting In → Leads & Tours. Every family who has contacted us
// and not yet started, from first contact to first paid day, with the tour
// in the middle.
//
// ── The board is a view, not a second table ─────────────────
// Nothing new is stored. Each of the five columns is a predicate over
// `waitlist_applications` columns that already exist (status, tour_status,
// tour_scheduled_at, tour_completed_at, confirmation_sent_at,
// reminder_count, still_interested_confirmed_at — see migration
// waitlist_inquiry_tour_reminders.sql), and moving a card writes exactly
// the fields that define the column it lands in, through the existing
// updateWaitlistTourStatus()/updateWaitlistApplication() helpers the
// Waitlist Planner already uses. So a family's position here and their row
// in the Planner are the same record read two ways; they cannot drift.
//
//     New          status pending · no tour · nothing sent yet
//     Contacted    something has gone out (confirmation, reminder) or they
//                  confirmed interest — but no tour is booked
//     Tour booked  tour_status = 'scheduled'
//     Toured       tour_status = 'completed'
//     Offered      status offered / accepted / enrolled
//
// ⚠️ CONTACTED IS DERIVED-ONLY, and this is the one real gap in the
// handoff's model. The other four columns each have a field that MEANS
// that state, so a card can be dragged into them. "We rang them" has no
// column — confirmation_sent_at is set by the confirmation email, not by a
// human picking up a phone. Rather than overload an existing timestamp to
// mean two different things, cards land in Contacted on their own when
// something has actually gone out, and the column says so. A real
// `contacted_at` (plus `lead_source`, see below) is the migration this
// screen wants next.
//
// ── Log a call ──────────────────────────────────────────────
// This DOES write a real row. The waitlist_applications RLS policy is
// "Auth all" for authenticated users, so an admin inserts directly — the
// public submit_waitlist_application() RPC is deliberately not used here,
// because its allow-list exists to constrain the public internet and an
// office-entered lead is not that.
//
// ── Where leads come from ───────────────────────────────────
// Not built. There is no `lead_source` column, and the difference between
// "website form" and "she asked after church" is not derivable from
// anything stored — the inquiry form and the office write the same row.
// The panel says what it would need rather than charting a guess.
//
// ── Tour times ──────────────────────────────────────────────
// This week's tours are real (tour_scheduled_at). The handoff's "open
// slot · nobody booked · offer it" rows are not: publishing bookable tour
// windows needs a table of them, and whether those are fixed weekly times
// or ad-hoc is an open design decision the handoff itself flags. The panel
// lists what is booked and names the gap.

const LD_COLUMNS = [
    { key: 'new',       label: 'New',         accent: 'var(--navy)' },
    { key: 'contacted', label: 'Contacted',   accent: 'var(--navy)', derivedOnly: true },
    { key: 'tour',      label: 'Tour booked', accent: 'var(--sun)' },
    { key: 'toured',    label: 'Toured',      accent: 'var(--sun)' },
    { key: 'offered',   label: 'Offered',     accent: 'var(--green)' },
];

// A lead is "waiting on us" after this many days with no reply — the same
// stall threshold Fill the Rooms uses, so the two screens agree about who
// has gone quiet.
const LD_STALL_DAYS = (typeof FR_STALL_DAYS !== 'undefined') ? FR_STALL_DAYS : 5;

let _ldBound = false;

function _ldEl(id) { return document.getElementById(id); }

function _ldDaysSince(iso) {
    if (!iso) return null;
    const t = new Date(iso);
    if (isNaN(t)) return null;
    return Math.max(0, Math.floor((Date.now() - t.getTime()) / 86400000));
}

function _ldSurname(a) {
    const parts = String(a.parent_name || a.child_name || '').trim().split(/\s+/);
    return parts.length > 1 ? parts[parts.length - 1] : (parts[0] || '—');
}

function _ldWhen(iso, withTime = false) {
    if (!iso) return '';
    const d = new Date(String(iso).length <= 10 ? iso + 'T00:00:00' : iso);
    if (isNaN(d)) return '';
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const day = new Date(d); day.setHours(0, 0, 0, 0);
    const diff = Math.round((day - today) / 86400000);
    const time = withTime
        ? ' ' + d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase()
        : '';
    if (diff === 0)  return 'Today' + time;
    if (diff === 1)  return 'Tomorrow' + time;
    if (diff === -1) return 'Yesterday' + time;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + time;
}

/** Which board column an application belongs in. One place, so the counts,
 *  the cards and the move targets can never disagree. */
function ldColumnFor(a) {
    if (['offered', 'accepted', 'enrolled'].includes(a.status)) return 'offered';
    if (a.tour_status === 'completed' || a.tour_completed_at)   return 'toured';
    if (a.tour_status === 'scheduled' || a.tour_scheduled_at)   return 'tour';
    if (a.confirmation_sent_at || (a.reminder_count || 0) > 0 || a.still_interested_confirmed_at) return 'contacted';
    return 'new';
}

/** Active leads only — a declined, expired or archived family is not on the board. */
function ldActive(apps) {
    return (apps || []).filter(a =>
        !a.archived_at && !['declined', 'expired', 'archived'].includes(a.status));
}

function ldBuckets(apps) {
    const out = {};
    LD_COLUMNS.forEach(c => { out[c.key] = []; });
    ldActive(apps).forEach(a => { out[ldColumnFor(a)].push(a); });
    // Longest-waiting first inside every column: the card at the top is the
    // one that has been there longest, which is the one to work.
    Object.values(out).forEach(list =>
        list.sort((x, y) => new Date(x.applied_at || 0) - new Date(y.applied_at || 0)));
    return out;
}

// ── Metrics ─────────────────────────────────────────────────
function ldMetrics(apps, buckets) {
    const active = ldActive(apps);
    const weekAgo = Date.now() - 7 * 86400000;
    const newThisWeek = active.filter(a => new Date(a.applied_at || 0).getTime() >= weekAgo).length;

    // Waiting on us: sitting in New or Contacted with nothing sent for
    // LD_STALL_DAYS, or an offer out that long with no reply.
    const waiting = active.filter(a => {
        const col = ldColumnFor(a);
        if (col === 'new' || col === 'contacted') {
            return (_ldDaysSince(a.applied_at) ?? 0) >= LD_STALL_DAYS;
        }
        if (a.status === 'offered' && !a.still_interested_confirmed_at) {
            return (_ldDaysSince(a.offered_at) ?? 0) >= LD_STALL_DAYS;
        }
        return false;
    });
    const oldest = waiting.reduce((m, a) => Math.max(m, _ldDaysSince(a.applied_at) ?? 0), 0);

    const toursBooked = buckets.tour;
    const thisWeekEnd = Date.now() + 7 * 86400000;
    const toursSoon = toursBooked.filter(a =>
        a.tour_scheduled_at && new Date(a.tour_scheduled_at).getTime() <= thisWeekEnd).length;

    // Tour → enrolled, over every family who has ever toured: the honest
    // denominator, including the ones who toured and went elsewhere.
    const everToured = (apps || []).filter(a => a.tour_status === 'completed' || a.tour_completed_at);
    const touredEnrolled = everToured.filter(a => ['accepted', 'enrolled'].includes(a.status)).length;
    const convPct = everToured.length ? Math.round((touredEnrolled / everToured.length) * 100) : null;

    return { newThisWeek, waiting, oldest, toursBooked, toursSoon, everToured, touredEnrolled, convPct };
}

// ── Cards ───────────────────────────────────────────────────
function _ldCardHtml(a, col) {
    const room = typeof wlDeriveRoom === 'function' ? wlDeriveRoom(a) : null;
    const roomLabel = room && typeof wlRoomLabel === 'function' ? wlRoomLabel(room) : '';
    const age = a.child_dob && typeof calcAgeMonths === 'function'
        ? (() => { const m = calcAgeMonths(a.child_dob); return m == null ? '' : `${Math.floor(m / 12)}y ${m % 12}m`; })()
        : (a.expected_due_date ? `expecting, due ${_ldWhen(a.expected_due_date)}` : '');

    const days = typeof wlDaysLabel === 'function' ? wlDaysLabel(a) : '';
    const waited = _ldDaysSince(a.applied_at);
    const stalled = (col === 'new' || col === 'contacted') && waited != null && waited >= LD_STALL_DAYS;

    // The one line that says why this card needs attention, or when it is next due.
    let line = '', tone = '';
    if (col === 'tour' && a.tour_scheduled_at) {
        line = _ldWhen(a.tour_scheduled_at, true);
        tone = new Date(a.tour_scheduled_at) < new Date() ? 'is-warn' : 'is-gold';
        if (tone === 'is-warn') line = `${line} — mark it toured or rebook`;
    } else if (col === 'offered') {
        if (a.status === 'accepted') {
            line = a.paperwork_received ? 'Accepted · all forms in' : 'Accepted · paperwork outstanding';
            tone = a.paperwork_received ? 'is-ok' : 'is-warn';
        } else if (a.status === 'enrolled') {
            line = 'Enrolled';
            tone = 'is-ok';
        } else if (a.offer_deadline) {
            const expired = a.offer_deadline < new Date().toLocaleDateString('en-CA');
            line = `Offer ${expired ? 'expired' : 'expires'} ${_ldWhen(a.offer_deadline)}`;
            tone = 'is-warn';
        }
    } else if (stalled) {
        line = `${waited} days with no reply`;
        tone = 'is-warn';
    } else if (a.notes) {
        line = a.notes.length > 64 ? a.notes.slice(0, 63) + '…' : a.notes;
    }

    const sib = a.has_sibling ? '<span class="ld-card-sib">👨‍👩‍👧 sibling here</span>' : '';

    return `
        <div class="ld-card${stalled ? ' is-stalled' : ''}${tone === 'is-ok' ? ' is-ok' : ''}"
             data-ld-card="${a.id}" tabindex="0" role="button"
             aria-label="Open ${escHtml(a.child_name || 'lead')}">
            <div class="ld-card-name">${escHtml(_ldSurname(a))} · ${escHtml(a.child_name || '')}</div>
            <div class="ld-card-meta">${escHtml([age, roomLabel].filter(Boolean).join(' → '))}</div>
            ${days ? `<div class="ld-card-days">${escHtml(days)}</div>` : ''}
            ${line ? `<div class="ld-card-line ${tone}">${escHtml(line)}</div>` : ''}
            ${sib}
        </div>`;
}

function _ldColumnHtml(col, list) {
    const cards = list.length
        ? list.map(a => _ldCardHtml(a, col.key)).join('')
        : `<p class="ld-col-empty">${col.key === 'new' ? 'Nothing new.' : 'Empty.'}</p>`;
    const add = col.key === 'new'
        ? `<button type="button" class="ld-col-add" data-ld-log>+ Log a call</button>` : '';
    // Contacted is derived — say so where someone would otherwise try to drag
    // a card into it. See the module header.
    const note = col.derivedOnly
        ? `<p class="ld-col-note">Cards arrive here on their own once a confirmation or reminder has gone out. There is no field yet for “I rang them”.</p>`
        : '';
    return `
        <div class="ld-col" data-ld-col="${col.key}">
            <div class="ld-col-head" style="border-bottom-color:${col.accent}">
                <span class="ld-col-label">${escHtml(col.label)}</span>
                <span class="ld-col-n">${list.length}</span>
            </div>
            ${note}
            ${cards}
            ${add}
        </div>`;
}

// ── Tours this week ─────────────────────────────────────────
function _ldToursHtml(buckets) {
    const now = Date.now();
    const soon = buckets.tour
        .filter(a => a.tour_scheduled_at)
        .sort((x, y) => new Date(x.tour_scheduled_at) - new Date(y.tour_scheduled_at));

    const rows = soon.length ? soon.slice(0, 6).map(a => {
        const d = new Date(a.tour_scheduled_at);
        const past = d.getTime() < now;
        const room = typeof wlDeriveRoom === 'function' ? wlDeriveRoom(a) : null;
        return `
            <div class="ld-tour">
                <div class="ld-tour-date">
                    <span class="ld-tour-dow">${d.toLocaleDateString('en-US', { weekday: 'short' })}</span>
                    <span class="ld-tour-num">${d.getDate()}</span>
                </div>
                <div class="ld-tour-main">
                    <div class="ld-tour-title">${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase()} · ${escHtml(_ldSurname(a))} family</div>
                    <div class="ld-tour-meta">${escHtml(room && typeof wlRoomLabel === 'function' ? wlRoomLabel(room) : '')}${a.has_sibling ? ' · sibling here' : ''}${a.still_interested_confirmed_at ? ' · confirmed' : ''}</div>
                </div>
                ${past
                    ? `<button type="button" class="ld-btn is-primary" data-ld-toured="${a.id}">Mark toured</button>`
                    : `<span class="ld-pill${a.still_interested_confirmed_at ? ' is-ok' : ''}">${a.still_interested_confirmed_at ? 'CONFIRMED' : 'BOOKED'}</span>`}
            </div>`;
    }).join('') : `<p class="empty-hint">No tours are booked.</p>`;

    return `
        <div class="ap-panel">
            <div class="ap-panel-head">
                <h3>Tours booked</h3>
                <p>Every tour with a time on it, soonest first. A tour whose time has passed asks to be marked toured, so a family never sits in the wrong column.</p>
            </div>
            <div class="ld-tours">${rows}</div>
            <div class="ld-foot">
                <span class="ld-foot-note">Publishing bookable tour windows — the "3 open slots this week, offer one" half of this panel — needs a table of tour slots. Whether those are fixed weekly times or ad-hoc is still open.</span>
            </div>
        </div>`;
}

// ── Automations ─────────────────────────────────────────────
// Real switches, over the real settings key the Waitlist Signup Link tool
// already reads and writes, plus the real scheduled function behind it.
function _ldAutomationHtml(settings) {
    const on = (v) => v ? `<span class="ld-pill is-ok">ON</span>` : `<span class="ld-pill">OFF</span>`;
    return `
        <div class="ap-panel tone-green">
            <div class="ap-panel-head">
                <h3>What sends itself</h3>
                <p>These are the live settings behind Waitlist Signup Link and the weekly <code>send-waitlist-reminders</code> job — changed there, shown here so the board says what a family is already being told.</p>
            </div>
            <div class="ld-autos">
                <div class="ld-auto">
                    <div>
                        <div class="ld-auto-title">Someone applies</div>
                        <div class="ld-auto-sub">A confirmation email, and a copy to ${settings.notifyEmail ? escHtml(settings.notifyEmail) : 'nobody — no address is set'}</div>
                    </div>
                    ${on(!!settings.notifyEmail)}
                </div>
                <div class="ld-auto">
                    <div>
                        <div class="ld-auto-title">Nobody replied</div>
                        <div class="ld-auto-sub">A weekly "still interested?" with a one-tap answer</div>
                    </div>
                    ${on(settings.remindersEnabled === true)}
                </div>
                <div class="ld-auto">
                    <div>
                        <div class="ld-auto-title">Seat offered</div>
                        <div class="ld-auto-sub">You write this one — it's the important one</div>
                    </div>
                    <span class="ld-pill">MANUAL</span>
                </div>
            </div>
            <div class="ld-foot">
                <button type="button" class="ap-pill" data-ap-go="wlNotify">Change these →</button>
            </div>
        </div>`;
}

// ── Lead sources ────────────────────────────────────────────
function _ldSourcesHtml(apps) {
    const active = ldActive(apps);
    const sibs = active.filter(a => a.has_sibling).length;
    return `
        <div class="ap-panel">
            <div class="ap-panel-head">
                <h3>Where leads come from</h3>
                <p>Not built, deliberately. The inquiry form and an office-entered lead write the same row, so "website" and "she asked after church" are not distinguishable from anything stored.</p>
            </div>
            <div class="ld-foot">
                <p>The one split that <em>is</em> recorded: <strong>${sibs}</strong> of ${active.length} active ${active.length === 1 ? 'lead' : 'leads'} already ${sibs === 1 ? 'has' : 'have'} a sibling here. A <code>lead_source</code> column on <code>waitlist_applications</code>, set by the inquiry form and by Log a call, is what this panel needs — it is one column and a dropdown, not a table.</p>
            </div>
        </div>`;
}

// ── Render ──────────────────────────────────────────────────
async function renderLeadsTool() {
    const body = _ldEl('ldBody');
    if (!body) return;
    body.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        if (typeof _allWaitlistApps !== 'undefined' && !_allWaitlistApps.length &&
            typeof loadWaitlistApplications === 'function') {
            await loadWaitlistApplications();
        }
        const apps = (typeof _allWaitlistApps !== 'undefined' && _allWaitlistApps) || [];
        const buckets = ldBuckets(apps);
        const m = ldMetrics(apps, buckets);
        const settings = typeof loadWaitlistNotifySettings === 'function'
            ? await loadWaitlistNotifySettings().catch(() => ({})) : {};

        body.innerHTML = `
            <div class="ld-metrics">
                <div class="ld-metric" style="border-top-color:var(--navy)">
                    <span class="ld-metric-label">New this week</span>
                    <div class="ld-metric-n">${m.newThisWeek}</div>
                    <span class="ld-metric-sub">${ldActive(apps).length} active in total</span>
                </div>
                <div class="ld-metric" style="border-top-color:var(--tang)">
                    <span class="ld-metric-label">Waiting on us</span>
                    <div class="ld-metric-n">${m.waiting.length}</div>
                    <span class="ld-metric-sub${m.waiting.length ? ' is-warn' : ''}">${m.waiting.length
                        ? `Oldest asked ${m.oldest} days ago` : 'Nobody is waiting'}</span>
                </div>
                <div class="ld-metric" style="border-top-color:var(--sun)">
                    <span class="ld-metric-label">Tours booked</span>
                    <div class="ld-metric-n">${m.toursBooked.length}</div>
                    <span class="ld-metric-sub is-gold">${m.toursSoon} in the next seven days</span>
                </div>
                <div class="ld-metric" style="border-top-color:var(--green)">
                    <span class="ld-metric-label">Tour → enrolled</span>
                    <div class="ld-metric-n">${m.convPct == null ? '—' : m.convPct + '%'}</div>
                    <span class="ld-metric-sub is-ok">${m.everToured.length
                        ? `${m.touredEnrolled} of ${m.everToured.length} who toured`
                        : 'Nobody has toured yet'}</span>
                </div>
            </div>

            <div class="ap-panel ld-board-panel">
                <div class="ap-panel-head">
                    <h3>The board</h3>
                    <p>Every family who has contacted us and not yet started. A card sits in the column its own record puts it in — open one to move it, which writes the fields that define where it lands.</p>
                </div>
                <div class="ld-board">
                    ${LD_COLUMNS.map(c => _ldColumnHtml(c, buckets[c.key])).join('')}
                </div>
            </div>

            <div class="ld-cols">
                <div class="ld-col-wide">${_ldToursHtml(buckets)}</div>
                <div class="ld-col-narrow">
                    ${_ldAutomationHtml(settings || {})}
                    ${_ldSourcesHtml(apps)}
                </div>
            </div>`;
    } catch (e) {
        console.warn('renderLeadsTool:', e);
        body.innerHTML = `<p class="empty-hint">Could not load: ${escHtml(e.message || String(e))}</p>`;
    }
}

// ── Actions ─────────────────────────────────────────────────
// Every one of these writes a field that DEFINES a column, through the same
// helper the Waitlist Planner uses — so a card cannot end up somewhere its
// own record does not put it.
async function ldMarkToured(id) {
    const app = (_allWaitlistApps || []).find(a => String(a.id) === String(id));
    if (!app) return;
    const at = new Date().toISOString();
    try {
        await updateWaitlistTourStatus(id, { tour_status: 'completed', tour_completed_at: at });
        app.tour_status = 'completed';
        app.tour_completed_at = at;
        renderLeadsTool();
    } catch (e) {
        alert('Could not save that: ' + (e.message || e));
    }
}

// "Log a call" — a family who rang and never filled anything in. This is
// the whole point of the board: today that call leaves no trace at all.
//
// It writes a real row (authenticated INSERT under waitlist_applications'
// own "Auth all" policy), so the lead is on the board, in the Planner and
// in Fill the Rooms' funnel from the moment the phone goes down. The
// public submit_waitlist_application() RPC is deliberately NOT used — its
// allow-list exists to constrain the public internet, and an
// office-entered lead is not that.
//
// A form rather than a chain of prompt() dialogs: six prompts cannot be
// reviewed before submitting, cannot be corrected once past, and lose
// everything typed if the last one is cancelled.
function _ldLogFormHtml() {
    const next = new Date();
    next.setMonth(next.getMonth() + 1, 1);
    return `
        <div class="ld-scrim" data-ld-cancel></div>
        <div class="ld-modal" role="dialog" aria-modal="true" aria-labelledby="ldLogTitle">
            <div class="ld-modal-head">
                <div>
                    <div class="ld-modal-title" id="ldLogTitle">Log a call</div>
                    <div class="ld-modal-sub">A family who rang and hasn't filled anything in. Two fields are enough — the rest can follow.</div>
                </div>
                <button type="button" class="ld-modal-close" data-ld-cancel aria-label="Close">✕</button>
            </div>
            <form id="ldLogForm" class="ld-form" novalidate>
                <div class="ld-form-row">
                    <label>Who called <span class="req">*</span>
                        <input type="text" id="ldParent" required autocomplete="off" placeholder="Sarah Kovalenko">
                    </label>
                    <label>Child's name <span class="req">*</span>
                        <input type="text" id="ldChild" required autocomplete="off" placeholder="Mila">
                    </label>
                </div>
                <div class="ld-form-row">
                    <label>Email
                        <input type="email" id="ldEmail" autocomplete="off" placeholder="optional">
                    </label>
                    <label>Phone
                        <input type="tel" id="ldPhone" autocomplete="off" placeholder="optional">
                    </label>
                </div>
                <div class="ld-form-row">
                    <label>Child's birthday
                        <input type="date" id="ldDob">
                        <small>Sets the room. Leave blank if they didn't say.</small>
                    </label>
                    <label>Hoping to start
                        <input type="date" id="ldStart" value="${next.toLocaleDateString('en-CA')}">
                        <small>Defaults to the 1st of next month.</small>
                    </label>
                </div>
                <label class="ld-form-full">What did they say?
                    <textarea id="ldNote" rows="3" placeholder="Wants Tue/Thu from October. Comparing us with two others."></textarea>
                </label>
                <p class="ld-form-msg" id="ldLogMsg"></p>
                <div class="ld-form-actions">
                    <button type="submit" class="ld-btn is-primary" id="ldLogSave">Save the lead</button>
                    <button type="button" class="ld-btn" data-ld-cancel>Cancel</button>
                </div>
            </form>
        </div>`;
}

function ldOpenLogForm() {
    const host = _ldEl('ldModalHost');
    if (!host) return;
    host.innerHTML = _ldLogFormHtml();
    host.classList.remove('hidden');
    _ldEl('ldParent')?.focus();
    _ldEl('ldLogForm')?.addEventListener('submit', ldSubmitLog);
}

function ldCloseLogForm() {
    const host = _ldEl('ldModalHost');
    if (!host) return;
    host.classList.add('hidden');
    host.innerHTML = '';
}

async function ldSubmitLog(ev) {
    ev.preventDefault();
    const msg = _ldEl('ldLogMsg');
    const btn = _ldEl('ldLogSave');
    const val = id => (_ldEl(id)?.value || '').trim();

    const parentName = val('ldParent');
    const childName  = val('ldChild');
    if (!parentName || !childName) {
        if (msg) msg.textContent = 'A name for the caller and for the child, at least.';
        return;
    }

    // desired_start_date is NOT NULL on the table, so an unknown start falls
    // back to the 1st of next month rather than failing the insert.
    const fallback = new Date();
    fallback.setMonth(fallback.getMonth() + 1, 1);

    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const { error } = await sbClient.from('waitlist_applications').insert({
            parent_name:        parentName,
            parent_email:       val('ldEmail').toLowerCase() || null,
            parent_phone:       val('ldPhone') || null,
            child_name:         childName,
            child_dob:          val('ldDob') || null,
            desired_start_date: val('ldStart') || fallback.toLocaleDateString('en-CA'),
            start_flexibility:  'flexible',
            status:             'pending',
            notes:              ['Logged by the office from a phone call.', val('ldNote')]
                                    .filter(Boolean).join(' '),
        });
        if (error) throw error;
        if (typeof loadWaitlistApplications === 'function') await loadWaitlistApplications();
        ldCloseLogForm();
        renderLeadsTool();
    } catch (e) {
        if (msg) msg.textContent = 'Could not save that lead: ' + (e.message || e);
        if (btn) { btn.disabled = false; btn.textContent = 'Save the lead'; }
    }
}

// Opening a card hands off to the Waitlist Planner's own per-family editor,
// which already owns every action on a lead (offer, edit days, schedule a
// tour, enroll). A second editor here would be a second place those writes
// could diverge from the Planner's.
function ldOpenCard(id) {
    const app = (_allWaitlistApps || []).find(a => String(a.id) === String(id));
    if (!app) return;
    if (typeof _openAdminWlModalForEdit === 'function') { _openAdminWlModalForEdit(app); return; }
    if (typeof apGo === 'function') apGo('wlPlanner');
}

function setupLeadsTool() {
    if (_ldBound) return;
    const section = _ldEl('leadsToursSection');
    if (!section) return;
    _ldBound = true;

    section.addEventListener('click', (ev) => {
        const toured = ev.target.closest('[data-ld-toured]');
        if (toured) { ldMarkToured(toured.dataset.ldToured); return; }
        if (ev.target.closest('[data-ld-cancel]')) { ldCloseLogForm(); return; }
        if (ev.target.closest('[data-ld-log]'))    { ldOpenLogForm();  return; }
        const card = ev.target.closest('[data-ld-card]');
        if (card) ldOpenCard(card.dataset.ldCard);
    });
    section.addEventListener('keydown', (ev) => {
        if (ev.key === 'Escape' && !_ldEl('ldModalHost')?.classList.contains('hidden')) {
            ldCloseLogForm();
            return;
        }
        if (ev.key !== 'Enter' && ev.key !== ' ') return;
        const card = ev.target.closest('[data-ld-card]');
        if (card) { ev.preventDefault(); ldOpenCard(card.dataset.ldCard); }
    });
}
