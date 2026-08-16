// ============================================================
// staff-schedule — "My schedule" on the teacher's phone
// ============================================================
// ⚠️ YOUR SHIFTS ONLY, AND THAT IS A DESIGN DECISION, NOT AN OVERSIGHT. The
// handoff: "staff see only their own schedule. No center-wide roster on the
// teacher device. Scope the query by staff id; do not ship an 'everyone' view
// behind a tab." staff_my_schedule() resolves the caller from their own PIN and
// filters every sub-select on that id, so there is no client change that can
// widen it — the only cross-staff data it returns is id + name of active
// coworkers, which the swap picker cannot work without.
//
// ⚠️ THE SCHEDULE IS THE RECORD FOR SWAPS. A shift you gave away stays visible
// on the week you left it, struck through; the week that gained it shows it
// normally. Two teachers reading their own phones see mirror images of the same
// move, and neither has to be told about it. That is why an accepted swap row
// is never deleted — deleting it erases the strikethrough and, with it, the
// only trace of who was originally down for that room.

let slSched      = null;   // last payload from staff_my_schedule()
let slSwapTarget = null;   // { work_date, shift, room_id } while the sheet is open

const SL_DAYOFF_REASONS = ['Paid time off', 'Sick', 'Appointment', 'Family', 'Unpaid', 'Other'];
let slDayOffReason = SL_DAYOFF_REASONS[0];

function slSchedEl(id) { return document.getElementById(id); }

// ── Dates ───────────────────────────────────────────────────
// Everything is done in local parts. new Date('2026-08-16') parses as UTC and
// renders as the 15th in Missouri, which would put a shift on the wrong day.

function slSchedISO(d) {
    const p = n => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function slSchedFromISO(iso) {
    const [y, m, d] = String(iso).slice(0, 10).split('-').map(Number);
    return new Date(y, m - 1, d);
}

// Monday of the week containing d. The center runs Monday–Friday and the
// director's build view is indexed 0=Mon..4=Fri, so the phone matches it.
function slSchedMonday(d) {
    const out = new Date(d);
    const dow = (out.getDay() + 6) % 7;      // Sun=6, Mon=0
    out.setDate(out.getDate() - dow);
    out.setHours(0, 0, 0, 0);
    return out;
}

const SL_DAY_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

// ── Load ────────────────────────────────────────────────────

async function slLoadSchedule() {
    const body = slSchedEl('slSchedBody');
    if (!body) return;
    if (!slStaffId || !slPin) { body.innerHTML = '<p class="sl-empty">Sign in to see your shifts.</p>'; return; }

    body.innerHTML = '<p class="sl-empty">Loading…</p>';

    const from = slSchedMonday(new Date());
    const to   = new Date(from);
    to.setDate(to.getDate() + 13);           // this week and next

    try {
        slSched = await fetchMyStaffSchedule(slStaffId, slPin, slSchedISO(from), slSchedISO(to));
    } catch (err) {
        console.warn('schedule:', err);
        body.innerHTML = '<p class="sl-empty">Could not load your schedule. Pull to retry.</p>';
        return;
    }
    if (!slSched) {
        body.innerHTML = '<p class="sl-empty">Could not confirm your PIN. Sign in again.</p>';
        return;
    }
    slRenderSchedule(from);
}

function slRenderSchedule(monday) {
    const body = slSchedEl('slSchedBody');
    const { shifts = [], given_away = [], incoming = [], outgoing = [],
            time_off = [], staff = {}, pto_used = 0, coworkers = [] } = slSched;

    slSchedEl('slSchedName').textContent = staff.name || 'My schedule';
    slSchedEl('slSchedRoom').textContent = staff.room_id ? slRoomLabel(staff.room_id) : '';

    // Hours this week: half a day per shift slot. The center runs am/pm halves,
    // so a full day is two rows, and this is the same arithmetic the payroll
    // planner uses — it is a planned figure, not a clocked one.
    const weekEnd = new Date(monday); weekEnd.setDate(weekEnd.getDate() + 4);
    const thisWeek = shifts.filter(s => {
        const d = slSchedFromISO(s.work_date);
        return d >= monday && d <= weekEnd;
    });
    slSchedEl('slSchedHours').textContent = `${(thisWeek.length * 3.5).toFixed(1)} hrs this week`;

    const weeks = [0, 1].map(w => {
        const start = new Date(monday);
        start.setDate(start.getDate() + w * 7);
        return slRenderWeek(start, shifts, given_away, w === 0);
    }).join('');

    body.innerHTML = `
        ${incoming.length ? slRenderIncoming(incoming) : ''}
        ${weeks}
        ${slRenderSwapReceipts(given_away, outgoing)}
        <p class="sl-sched-foot">
            This is your schedule only. Other teachers' hours, days off and pay
            aren't on your phone.
        </p>
        ${slRenderTimeOff(time_off, staff, pto_used)}`;

    slBindSchedule(coworkers);
}

function slRenderWeek(start, shifts, givenAway, isThisWeek) {
    const end = new Date(start); end.setDate(end.getDate() + 4);
    const label = isThisWeek ? 'This week' : 'Next week';
    const range = `${start.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ` +
                  `${end.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;

    const days = SL_DAY_LABELS.map((lab, i) => {
        const d   = new Date(start); d.setDate(d.getDate() + i);
        const iso = slSchedISO(d);

        const mine = shifts.filter(s => String(s.work_date).slice(0, 10) === iso);
        const gone = givenAway.filter(s => String(s.work_date).slice(0, 10) === iso);

        const rows = [
            ...mine.map(s => `
                <button type="button" class="sl-shift${s.gained ? ' is-gained' : ''}"
                        data-swap="${escHtml(iso)}|${escHtml(s.shift)}|${escHtml(s.room_id)}">
                    <span class="sl-shift-when">${s.shift === 'am' ? 'Morning' : 'Afternoon'}</span>
                    <span class="sl-shift-room">${escHtml(slRoomLabel(s.room_id))}</span>
                    ${s.gained ? '<span class="sl-shift-tag">picked up</span>' : ''}
                </button>`),
            // Struck through in place — the handoff's rule. It is not removed,
            // because "I gave Tuesday away" is information the teacher needs
            // more than a tidy empty cell.
            ...gone.map(s => `
                <div class="sl-shift is-gone">
                    <span class="sl-shift-when">${s.shift === 'am' ? 'Morning' : 'Afternoon'}</span>
                    <span class="sl-shift-room">${escHtml(slRoomLabel(s.room_id))}</span>
                    <span class="sl-shift-tag">${escHtml(s.to_name || 'swapped')}</span>
                </div>`),
        ].join('');

        const today = slSchedISO(new Date()) === iso;
        return `<div class="sl-day${today ? ' is-today' : ''}">
            <div class="sl-day-label">${lab} <span>${d.getDate()}</span></div>
            ${rows || '<div class="sl-day-off">Off</div>'}
        </div>`;
    }).join('');

    return `<section class="sl-week">
        <div class="sl-week-head"><strong>${label}</strong><span>${escHtml(range)}</span></div>
        <div class="sl-week-grid">${days}</div>
    </section>`;
}

function slRenderIncoming(incoming) {
    return `<section class="sl-swap-ask">
        <div class="sl-swap-ask-head">Somebody's asking you to cover</div>
        ${incoming.map(s => `
        <div class="sl-swap-ask-row">
            <div>
                <div class="sl-swap-ask-who">${escHtml(s.from_name)} — ${escHtml(slShiftLabel(s))}</div>
                <div class="sl-swap-ask-sub">${escHtml(slRoomLabel(s.room_id))}${
                    s.note ? ' · ' + escHtml(s.note) : ''}</div>
            </div>
            <div class="sl-swap-ask-btns">
                <button type="button" class="sl-swap-yes" data-answer="${s.id}|yes">Take it</button>
                <button type="button" class="sl-swap-no"  data-answer="${s.id}|no">No</button>
            </div>
        </div>`).join('')}
    </section>`;
}

// The "Swap — done" receipt from the handoff: green header, ON THE SCHEDULE
// pill, and a line saying the other teacher and the director already know.
function slRenderSwapReceipts(givenAway, outgoing) {
    const done    = givenAway.slice(0, 3);
    const waiting = outgoing.filter(s => s.status === 'proposed');
    if (!done.length && !waiting.length) return '';

    return `
    ${done.map(s => `
    <section class="sl-receipt">
        <div class="sl-receipt-head">
            <span>Swap — done</span>
            <span class="sl-receipt-pill">ON THE SCHEDULE</span>
        </div>
        <div class="sl-receipt-body">
            <strong>${escHtml(slShiftLabel(s))}</strong> in
            ${escHtml(slRoomLabel(s.room_id))} is ${escHtml(s.to_name)}'s now.
            <p>${escHtml(s.to_name)} sees the mirror of this on their phone, and the
               director sees the change in Build Staff Schedule. Nobody has to
               remember to tell anyone.</p>
        </div>
    </section>`).join('')}
    ${waiting.length ? `
    <section class="sl-receipt is-waiting">
        <div class="sl-receipt-head">
            <span>Waiting on an answer</span>
            <span class="sl-receipt-pill">PENDING</span>
        </div>
        <div class="sl-receipt-body">
            ${waiting.map(s => `<div>${escHtml(slShiftLabel(s))} — asked ${escHtml(s.to_name)}</div>`).join('')}
            <p>Still yours until they accept.</p>
        </div>
    </section>` : ''}`;
}

function slRenderTimeOff(rows, staff, used) {
    const left = Math.max(0, (staff.pto_starting_balance || 0) - (used || 0));

    const list = rows.length ? rows.map(r => {
        const dates = (r.off_dates || []).map(d =>
            slSchedFromISO(d).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }));
        const when = r.recurring
            ? 'Every week'
            : dates.length > 2 ? `${dates[0]} – ${dates[dates.length - 1]} (${dates.length} days)`
                               : dates.join(', ');
        const cls = r.status === 'approved' ? 'is-ok' : r.status === 'declined' ? 'is-no' : 'is-pending';
        const say = r.status === 'approved' ? 'Approved'
                  : r.status === 'declined' ? 'Not approved' : 'Waiting on the director';
        return `<div class="sl-off-row ${cls}">
            <div>
                <div class="sl-off-when">${escHtml(when)}</div>
                <div class="sl-off-why">${escHtml(r.reason || 'Time off')}</div>
            </div>
            <span class="sl-off-status">${say}</span>
        </div>`;
    }).join('') : '<p class="sl-empty">No requests in.</p>';

    return `<section class="sl-off">
        <div class="sl-week-head">
            <strong>Time off</strong>
            <span>${left} paid ${left === 1 ? 'day' : 'days'} left</span>
        </div>
        ${list}
        <button type="button" class="btn-primary sl-btn" id="slDayOffBtn">Request a day off</button>
    </section>`;
}

function slShiftLabel(s) {
    const d = slSchedFromISO(s.work_date);
    return `${d.toLocaleDateString('en-US', { weekday: 'long', month: 'short', day: 'numeric' })} ` +
           `${s.shift === 'am' ? 'morning' : 'afternoon'}`;
}

function slRoomLabel(id) {
    const room = (typeof ROOMS !== 'undefined' ? ROOMS : []).find(r => r.id === id);
    return room ? room.label : (id || '');
}

// ── Binding ─────────────────────────────────────────────────

function slBindSchedule(coworkers) {
    document.querySelectorAll('[data-swap]').forEach(b => {
        b.onclick = () => {
            const [work_date, shift, room_id] = b.dataset.swap.split('|');
            slOpenSwap({ work_date, shift, room_id }, coworkers);
        };
    });
    document.querySelectorAll('[data-answer]').forEach(b => {
        b.onclick = () => {
            const [id, yes] = b.dataset.answer.split('|');
            slAnswerSwap(Number(id), yes === 'yes', b);
        };
    });
    slSchedEl('slDayOffBtn')?.addEventListener('click', slOpenDayOff);
}

// ── Swap ────────────────────────────────────────────────────

function slOpenSwap(target, coworkers) {
    slSwapTarget = target;
    slSchedEl('slSwapWhich').textContent =
        `${slShiftLabel(target)} · ${slRoomLabel(target.room_id)}`;
    slSchedEl('slSwapWho').innerHTML = (coworkers || [])
        .map(c => `<option value="${escHtml(c.id)}">${escHtml(c.name)}</option>`).join('');
    slSchedEl('slSwapNote').value = '';
    slSchedEl('slSwapSheet').classList.remove('hidden');
}

async function slSubmitSwap() {
    if (!slSwapTarget) return;
    const to = slSchedEl('slSwapWho').value;
    if (!to) { slToast('Pick who you’re asking.', 'err'); return; }

    const btn = slSchedEl('slSwapSubmit');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
        const id = await proposeShiftSwap(slStaffId, slPin, {
            workDate: slSwapTarget.work_date,
            shift:    slSwapTarget.shift,
            toStaffId: to,
            note:     slSchedEl('slSwapNote').value.trim(),
        });
        if (!id) { slToast('That request was not accepted — you may have asked already.', 'err'); return; }
        slSchedEl('slSwapSheet').classList.add('hidden');
        slToast('Asked. Nothing moves until they accept.', 'ok');
        await slLoadSchedule();
    } catch (err) {
        console.warn('swap:', err);
        slToast('Could not send that request.', 'err');
    } finally {
        btn.disabled = false; btn.textContent = 'Send the request';
    }
}

async function slAnswerSwap(id, accept, btn) {
    btn.disabled = true;
    try {
        const ok = await answerShiftSwap(slStaffId, slPin, id, accept);
        if (!ok) {
            // The most likely cause by far: already working that shift.
            slToast(accept ? 'Could not take that one — check you’re not already on.'
                           : 'Could not answer that.', 'err');
            return;
        }
        slToast(accept ? 'Taken. It’s on your week now.' : 'Declined.', 'ok');
        await slLoadSchedule();
    } catch (err) {
        console.warn('swap answer:', err);
        slToast('Could not answer that.', 'err');
    } finally {
        btn.disabled = false;
    }
}

// ── Day off ─────────────────────────────────────────────────

function slOpenDayOff() {
    const staff = slSched?.staff || {};
    const left  = Math.max(0, (staff.pto_starting_balance || 0) - (slSched?.pto_used || 0));
    slSchedEl('slDayOffPto').textContent =
        `You have ${left} paid ${left === 1 ? 'day' : 'days'} left this year.`;

    const today = slSchedISO(new Date());
    slSchedEl('slDayOffFrom').value = '';
    slSchedEl('slDayOffTo').value   = '';
    slSchedEl('slDayOffFrom').min   = today;
    slSchedEl('slDayOffTo').min     = today;
    slSchedEl('slDayOffNote').value = '';
    slDayOffReason = SL_DAYOFF_REASONS[0];

    slSchedEl('slDayOffReasons').innerHTML = SL_DAYOFF_REASONS.map(r =>
        `<button type="button" class="sl-inc-chip${r === slDayOffReason ? ' is-on' : ''}"
                 data-reason="${escHtml(r)}">${escHtml(r)}</button>`).join('');
    slSchedEl('slDayOffReasons').querySelectorAll('[data-reason]').forEach(b => {
        b.onclick = () => {
            slDayOffReason = b.dataset.reason;
            slSchedEl('slDayOffReasons').querySelectorAll('[data-reason]').forEach(x =>
                x.classList.toggle('is-on', x.dataset.reason === slDayOffReason));
        };
    });

    slDayOffCount();
    slSchedEl('slDayOffSheet').classList.remove('hidden');
}

// Weekdays only, and it says so. The center is closed at weekends and
// staff_time_off_requests.weekday is CHECK-constrained to 0..4, so a Saturday
// in the range would be silently dropped on the way in.
function slDayOffDates() {
    const from = slSchedEl('slDayOffFrom').value;
    const to   = slSchedEl('slDayOffTo').value || from;
    if (!from) return [];

    const out = [];
    const d   = slSchedFromISO(from);
    const end = slSchedFromISO(to);
    if (end < d) return [];

    while (d <= end && out.length < 60) {
        const dow = d.getDay();
        if (dow >= 1 && dow <= 5) out.push(slSchedISO(d));
        d.setDate(d.getDate() + 1);
    }
    return out;
}

function slDayOffCount() {
    const dates = slDayOffDates();
    const el = slSchedEl('slDayOffCount');
    if (!dates.length) { el.textContent = 'Pick a start day.'; return; }
    const weekend = slSchedEl('slDayOffTo').value &&
        (slSchedFromISO(slSchedEl('slDayOffTo').value) - slSchedFromISO(slSchedEl('slDayOffFrom').value))
            / 86400000 + 1 > dates.length;
    el.textContent = `${dates.length} ${dates.length === 1 ? 'day' : 'days'}` +
        (weekend ? ' — weekends skipped, the center is closed.' : '.');
}

async function slSubmitDayOff() {
    const dates = slDayOffDates();
    if (!dates.length) { slToast('Pick which days.', 'err'); return; }

    const btn = slSchedEl('slDayOffSubmit');
    btn.disabled = true; btn.textContent = 'Sending…';
    try {
        const ok = await submitTimeOffRequestByPin({
            pin:    slPin,
            dates,
            reason: slDayOffReason,
            note:   slSchedEl('slDayOffNote').value.trim(),
        });
        if (!ok) { slToast('That request was not accepted. Check your PIN.', 'err'); return; }
        slSchedEl('slDayOffSheet').classList.add('hidden');
        slToast('Sent. You’ll get a push when the director answers.', 'ok');
        await slLoadSchedule();
    } catch (err) {
        console.warn('day off:', err);
        slToast('Could not send that request.', 'err');
    } finally {
        btn.disabled = false; btn.textContent = 'Send the request';
    }
}

// ── Wiring ──────────────────────────────────────────────────

function slSetupSchedule() {
    slSchedEl('slDayOffCancel')?.addEventListener('click',
        () => slSchedEl('slDayOffSheet').classList.add('hidden'));
    slSchedEl('slDayOffSubmit')?.addEventListener('click', slSubmitDayOff);
    slSchedEl('slDayOffFrom')?.addEventListener('change', slDayOffCount);
    slSchedEl('slDayOffTo')?.addEventListener('change', slDayOffCount);

    slSchedEl('slSwapCancel')?.addEventListener('click',
        () => slSchedEl('slSwapSheet').classList.add('hidden'));
    slSchedEl('slSwapSubmit')?.addEventListener('click', slSubmitSwap);
}
