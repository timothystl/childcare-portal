// ============================================================
// MODULE: Payroll — overview  (design handoff: Capacity & Fill, 3a)
// ============================================================
// Staff → Pay & Policy → Payroll, as a landing view in front of the pay
// period report rather than beside it. The report itself is unchanged; this
// is the screen that answers "what's owed, when is it due, and what is
// stopping me approving it" before a director picks a period out of a
// dropdown.
//
// ── Adapted, not copied ─────────────────────────────────────
// The reference material this came from is a payroll product's own landing
// page. Three things are deliberately different because MDO is not that:
//
//   * Bi-weekly, not bimonthly — _buildPayrollPeriodList() (admin-reports.js)
//     already defines the real period boundaries off PAYROLL_ANCHOR_END, and
//     this reads that list rather than deriving a second calendar.
//   * The blocking exceptions are the middle panel, not a footnote. They are
//     the actual reason a period is not ready, and `check-missed-clocks`
//     already flags the first kind nightly.
//   * Benefits enrolment is NOT here. The church office administers health,
//     retirement and workers' comp; myMDO produces hours and an approval.
//     The panel links out and says so rather than pretending otherwise.
//
// ── Every figure, and where it comes from ───────────────────
//   periods        _buildPayrollPeriodList() — the same list the report's
//                  own dropdown is built from
//   approved       mdo_payroll_approvals, via fetchMdoPayrollApproval()
//   staff, rates   admin_staff_roster() (fetchAllStaff)
//   hours          staff_clock_events + staff_hours, summed the same way
//                  _buildPayrollData() does it — clock pairs under ten
//                  minutes discarded, manual entries winning over clock
//   exceptions     staff_clock_events × staff_schedules
//   PTO            staff_time_off_requests
//
// Estimated gross is explicitly an ESTIMATE and labelled as one: it values
// clocked hours at each person's current rate and adds salaried staff's
// per-period figure. The authoritative number is the period report's own,
// after corrections. Showing a rounded estimate here is the point — it is
// what gives the approval deadline stakes — but it must never be mistaken
// for the figure that gets exported.

const PH_MIN_CLOCK_MS = 10 * 60 * 1000;   // same floor _buildPayrollData uses

let _phBound = false;
let _phCache = null;

function _phEl(id) { return document.getElementById(id); }

function _phMoney(n) { return '$' + Math.round(Number(n) || 0).toLocaleString(); }

function _phDate(iso, opts) {
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US',
        opts || { weekday: 'long', month: 'short', day: 'numeric' });
}

function _phToday() { return new Date().toLocaleDateString('en-CA'); }

function _phAddDays(dateStr, n) {
    const d = new Date(dateStr + 'T00:00:00');
    d.setDate(d.getDate() + n);
    return d.toLocaleDateString('en-CA');
}

/**
 * Pay day and the approval cut-off for a period.
 *
 * ⚠️ These are a CONVENTION, not a stored schedule: there is no
 * pay_calendar table, so pay day is derived as the Friday after the period
 * ends and the cut-off as the Tuesday before that. The panel labels them as
 * derived. If the church office's real calendar ever differs, that is a
 * settings row, not a guess to keep making here.
 */
function _phPayDay(periodEnd) {
    const d = new Date(periodEnd + 'T00:00:00');
    // The Friday on or after the day after the period closes.
    d.setDate(d.getDate() + 1);
    while (d.getDay() !== 5) d.setDate(d.getDate() + 1);
    return d.toLocaleDateString('en-CA');
}

function _phCutoff(periodEnd) {
    const pay = new Date(_phPayDay(periodEnd) + 'T00:00:00');
    pay.setDate(pay.getDate() - 3);   // Friday → Tuesday
    return pay.toLocaleDateString('en-CA');
}

// ── Hours and gross ─────────────────────────────────────────
function _phClockHours(ev) {
    if (!ev.clock_in || !ev.clock_out) return 0;
    const ms = new Date(ev.clock_out) - new Date(ev.clock_in);
    if (ms < PH_MIN_CLOCK_MS) return 0;
    return Math.round(ms / 3600000 * 100) / 100;
}

/**
 * Hours per staff member for a period, with manual entries taking precedence
 * over clock pairs for the same person on the same day — the same rule
 * _buildPayrollData() applies, so the estimate here and the report's own
 * figure start from the same hours.
 */
function _phHoursByStaff(clockEvents, manualHours) {
    const manualKeys = new Set((manualHours || []).map(h => `${h.staff_id}|${h.work_date}`));
    const out = new Map();
    (manualHours || []).forEach(h => {
        out.set(h.staff_id, (out.get(h.staff_id) || 0) + (parseFloat(h.hours_worked) || 0));
    });
    (clockEvents || []).forEach(ev => {
        if (manualKeys.has(`${ev.staff_id}|${ev.work_date}`)) return;
        out.set(ev.staff_id, (out.get(ev.staff_id) || 0) + _phClockHours(ev));
    });
    return out;
}

function _phEstimatedGross(staff, hoursByStaff) {
    let gross = 0;
    (staff || []).forEach(s => {
        if (s.pay_type === 'salary') {
            gross += Number(s.salary_biweekly) || 0;
        } else {
            gross += (hoursByStaff.get(s.id) || 0) * (Number(s.hourly_rate) || 0);
        }
    });
    return gross;
}

// ── Blocking exceptions ─────────────────────────────────────
// The three kinds a period actually stalls on. Each names the staff member,
// the day, and what the correction would be — the design's point is that the
// director should not have to open the report to find out why it is not
// ready.
function _phExceptions(clockEvents, schedules, staffById, periodStart, periodEnd) {
    const out = [];
    const today = _phToday();

    // 1 · Clocked in, never clocked out, and the day is over.
    (clockEvents || []).forEach(ev => {
        if (!ev.clock_in || ev.clock_out) return;
        if (ev.work_date >= today) return;          // still on shift today
        const sched = (schedules || []).find(s =>
            s.staff_id === ev.staff_id && s.work_date === ev.work_date);
        out.push({
            kind: 'open',
            staffId: ev.staff_id,
            name: staffById.get(ev.staff_id)?.name || 'Unknown',
            date: ev.work_date,
            detail: `Clocked in ${new Date(ev.clock_in).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase()}, never clocked out.`
                + (sched ? ` Scheduled ${sched.shift || 'that day'}.` : ' No shift on the schedule that day either.'),
        });
    });

    // 2 · Two shifts on one day whose windows overlap.
    const byStaffDay = new Map();
    (clockEvents || []).forEach(ev => {
        if (!ev.clock_in || !ev.clock_out) return;
        const k = `${ev.staff_id}|${ev.work_date}`;
        if (!byStaffDay.has(k)) byStaffDay.set(k, []);
        byStaffDay.get(k).push(ev);
    });
    byStaffDay.forEach((list, k) => {
        if (list.length < 2) return;
        const sorted = list.slice().sort((a, b) => new Date(a.clock_in) - new Date(b.clock_in));
        for (let i = 1; i < sorted.length; i++) {
            if (new Date(sorted[i].clock_in) >= new Date(sorted[i - 1].clock_out)) continue;
            const [staffId, date] = k.split('|');
            const fmt = iso => new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }).replace(' ', '').toLowerCase();
            out.push({
                kind: 'overlap',
                staffId: Number(staffId),
                name: staffById.get(Number(staffId))?.name || 'Unknown',
                date,
                detail: `Two overlapping shifts — ${fmt(sorted[i - 1].clock_in)}–${fmt(sorted[i - 1].clock_out)} and ${fmt(sorted[i].clock_in)}–${fmt(sorted[i].clock_out)}.`,
            });
            break;   // one row per person per day, not one per pair
        }
    });

    // 3 · Real hours on a day with no shift on the schedule. Only flagged
    //     when the WEEK has a schedule at all — a week nobody built is not
    //     seventeen exceptions, it is one missing schedule.
    const scheduledDays = new Set((schedules || []).map(s => s.work_date));
    const scheduledKeys = new Set((schedules || []).map(s => `${s.staff_id}|${s.work_date}`));
    (clockEvents || []).forEach(ev => {
        if (!ev.clock_in || !ev.clock_out) return;
        if (!scheduledDays.has(ev.work_date)) return;
        if (scheduledKeys.has(`${ev.staff_id}|${ev.work_date}`)) return;
        const hrs = _phClockHours(ev);
        if (hrs < 1) return;                       // a short cover is not an exception
        out.push({
            kind: 'unscheduled',
            staffId: ev.staff_id,
            name: staffById.get(ev.staff_id)?.name || 'Unknown',
            date: ev.work_date,
            detail: `Worked ${hrs.toFixed(1)} hours with no shift on the schedule. Covering for someone?`,
        });
    });

    return out
        .filter(e => e.date >= periodStart && e.date <= periodEnd)
        .sort((a, b) => a.date.localeCompare(b.date));
}

// ── Load ────────────────────────────────────────────────────
async function _phLoad() {
    const periods = _buildPayrollPeriodList();
    const today = _phToday();

    // The period being worked on now: the most recent one that has closed.
    // Plus the one still running, and the one before — three rows, newest
    // first, which is what the design shows.
    let currentIdx = 0;
    periods.forEach((p, i) => { if (p.end <= today) currentIdx = i; });
    const shown = [
        periods[currentIdx],                       // just closed — the one to approve
        periods[currentIdx + 1],                   // still running
    ].filter(Boolean);

    const span = {
        start: shown[shown.length - 1].start,
        end:   shown[0].end,
    };

    const [staff, clockEvents, manualHours, schedules, timeOff, approvals] = await Promise.all([
        fetchAllStaff({ includeInactive: true }).catch(() => []),
        fetchClockEventsForRange(span.start, span.end).catch(() => []),
        fetchStaffHours(span.start, span.end).catch(() => []),
        fetchStaffScheduleRange(span.start, span.end).catch(() => []),
        fetchTimeOffRequests({ sinceDate: span.start }).catch(() => []),
        Promise.all(shown.map(p =>
            fetchMdoPayrollApproval(p.start).then(a => [p.start, a]).catch(() => [p.start, null]))),
    ]);

    const staffById = new Map(staff.map(s => [s.id, s]));
    const approvedBy = new Map(approvals);

    const rows = shown.map(p => {
        const inPeriod = (d) => d >= p.start && d <= p.end;
        const ev  = clockEvents.filter(e => inPeriod(e.work_date));
        const mh  = manualHours.filter(h => inPeriod(h.work_date));
        const sch = schedules.filter(s => inPeriod(s.work_date));

        const hoursByStaff = _phHoursByStaff(ev, mh);
        const hours = [...hoursByStaff.values()].reduce((s, h) => s + h, 0);
        const people = new Set([...hoursByStaff.keys()]).size;
        const exceptions = _phExceptions(ev, sch, staffById, p.start, p.end);

        return {
            ...p,
            payDay: _phPayDay(p.end),
            cutoff: _phCutoff(p.end),
            open: p.end > today,
            approved: approvedBy.get(p.start) || null,
            hours: Math.round(hours * 10) / 10,
            people,
            gross: _phEstimatedGross(staff.filter(s => s.active), hoursByStaff),
            exceptions,
        };
    });

    const active = staff.filter(s => s.active);
    return {
        rows,
        staff: active,
        hourly: active.filter(s => s.pay_type !== 'salary').length,
        salaried: active.filter(s => s.pay_type === 'salary').length,
        pendingTimeOff: (timeOff || []).filter(r => r.status === 'pending'),
        approvedTimeOff: (timeOff || []).filter(r => r.status === 'approved'),
    };
}

// ── Render ──────────────────────────────────────────────────
function _phRunRowHtml(r) {
    const today = _phToday();
    const status = r.approved
        ? { cls: 'is-ok',   label: 'Approved' }
        : r.open
            ? { cls: 'is-muted', label: 'Open' }
            : { cls: 'is-warn',  label: 'Not started' };

    const late = !r.approved && !r.open && r.cutoff < today;
    const deadline = r.approved
        ? `<div class="ph-run-done">Approved ${new Date(r.approved.approved_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}${r.approved.approved_by ? ` by ${escHtml(r.approved.approved_by)}` : ''}. Nothing left to do here.</div>`
        : r.open
            ? `<div class="ph-run-note">Still running — it closes ${escHtml(_phDate(r.end, { month: 'short', day: 'numeric' }))}.</div>`
            : `<div class="ph-run-alert${late ? ' is-late' : ''}">
                   <span>${late ? '⏰' : '⚠️'}</span>
                   <span>Approve by ${escHtml(_phDate(r.cutoff))} at 3:00 p.m.${late ? ' — that has passed' : ''}${r.exceptions.length ? ` — ${r.exceptions.length} clock ${r.exceptions.length === 1 ? 'exception' : 'exceptions'} first` : ''}</span>
               </div>`;

    const actions = r.approved || r.open ? '' : `
        <div class="ph-run-btns">
            <button type="button" class="ph-btn is-primary" data-ph-review="${escHtml(r.start)}|${escHtml(r.end)}">Start review</button>
            ${r.exceptions.length
                ? `<button type="button" class="ph-btn" data-ph-scroll-exceptions>Fix the ${r.exceptions.length}</button>` : ''}
        </div>`;

    return `
        <div class="ph-run${r.open ? ' is-open' : ''}">
            <div class="ph-run-icon">${r.approved ? '✓' : '🏦'}</div>
            <div class="ph-run-main">
                <div class="ph-run-title">Pay period of ${escHtml(_payrollPeriodLabel(r.start, r.end))}</div>
                <div class="ph-run-sub">${escHtml(_phDate(r.payDay, { weekday: 'long', month: 'long', day: 'numeric' }))} pay day · ${r.people} on the clock · ${r.hours.toFixed(1)} hours${r.open ? ' so far' : ''}</div>
                ${deadline}
                ${actions}
            </div>
            <div class="ph-run-right">
                <span class="ph-status ${status.cls}">${status.label}</span>
                ${r.open ? '' : `
                    <div class="ph-run-gross">${_phMoney(r.gross)}</div>
                    <div class="ph-run-grosslab">estimated gross</div>`}
            </div>
        </div>`;
}

function _phExceptionsHtml(rows) {
    // Only the closed period's exceptions block an approval; a period still
    // running has all week to fix itself.
    const target = rows.find(r => !r.open && !r.approved);
    const list = target ? target.exceptions : [];

    if (!target) {
        return `
            <div class="ap-panel">
                <div class="ap-panel-head">
                    <h3>Nothing waiting on you</h3>
                    <p>Every closed period is approved. The next one is still running.</p>
                </div>
            </div>`;
    }

    const body = list.length ? list.map(e => `
        <div class="ph-exc">
            <div class="ph-exc-who">${escHtml(apInitials(e.name))}</div>
            <div class="ph-exc-main">
                <div class="ph-exc-name">${escHtml(e.name)} · ${escHtml(_phDate(e.date))}</div>
                <div class="ph-exc-detail">${escHtml(e.detail)}</div>
            </div>
            <button type="button" class="ph-btn" data-ph-open-clock>Open the time clock</button>
        </div>`).join('')
        : `<p class="empty-hint">No open clock-outs, no overlapping shifts, and nobody worked a day they weren't scheduled. This period is ready to approve.</p>`;

    return `
        <div class="ap-panel ph-exceptions" id="phExceptions">
            <div class="ap-panel-head">
                <h3>${list.length ? 'Fix before you can approve' : 'Nothing blocking this period'}</h3>
                <p>${list.length
                    ? 'Shifts the clock flagged. Each one is a real punch that has to be settled before the hours behind it mean anything — corrections are made in the Time Clock tab, where they are logged against the original punch.'
                    : 'Checked against every punch and every scheduled shift in the period.'}</p>
            </div>
            <div class="ph-excs">${body}</div>
        </div>`;
}

function _phSideHtml(d) {
    const next = d.rows.find(r => !r.approved) || d.rows[0];
    const pendingN = d.pendingTimeOff.length;
    const approvedHrs = d.approvedTimeOff.reduce((s, r) => s + (r.off_dates?.length || 0) * 8, 0);

    return `
        <div class="ap-panel">
            <div class="ap-panel-head"><h3>🗓️ Pay schedule</h3></div>
            <div class="ph-rows">
                <div class="ph-row">
                    <div>
                        <div class="ph-row-title">Bi-weekly</div>
                        <div class="ph-row-sub">${d.staff.length} staff on the payroll</div>
                    </div>
                </div>
                <div class="ph-row is-split">
                    <span>Next pay day</span>
                    <strong>${next ? escHtml(_phDate(next.payDay)) : '—'}</strong>
                </div>
                <div class="ph-row is-split">
                    <span>Approval cut-off</span>
                    <strong class="is-warn">${next ? escHtml(_phDate(next.cutoff)) : '—'}, 3:00 p.m.</strong>
                </div>
                <div class="ph-row is-split">
                    <span>Hourly · salaried</span>
                    <strong>${d.hourly} · ${d.salaried}</strong>
                </div>
            </div>
            <div class="ph-foot">
                <span class="ph-foot-note">Pay day and the cut-off are derived — the Friday after a period closes, and the Tuesday before that. There is no stored pay calendar yet.</span>
            </div>
        </div>

        <div class="ap-panel">
            <div class="ap-panel-head"><h3>⛱️ Time off this period</h3></div>
            <div class="ph-rows">
                <div class="ph-row is-split">
                    <div><div class="ph-row-title">Approved days off</div><div class="ph-row-sub">${d.approvedTimeOff.length} ${d.approvedTimeOff.length === 1 ? 'request' : 'requests'}</div></div>
                    <strong>${approvedHrs} hrs</strong>
                </div>
                <div class="ph-row is-split">
                    <div><div class="ph-row-title">Requests still pending</div>
                        <div class="ph-row-sub${pendingN ? ' is-warn' : ''}">${pendingN ? 'Decide before you approve the period' : 'Nothing waiting'}</div></div>
                    <strong class="${pendingN ? 'is-warn' : ''}">${pendingN}</strong>
                </div>
            </div>
            ${pendingN ? `<div class="ph-foot">
                <button type="button" class="ph-btn is-primary" data-ap-go="schedule">Review the ${pendingN} ${pendingN === 1 ? 'request' : 'requests'}</button>
            </div>` : ''}
        </div>

        <div class="ap-panel ph-church">
            <div class="ap-panel-head">
                <h3>⛪ Handled by the church office</h3>
                <p>myMDO produces hours and an approval. Tax filing, benefits and the payment run itself stay in the church's system — none of it is administered here.</p>
            </div>
            <div class="ph-church-list">
                <div class="ph-church-row"><span>Health and retirement benefits</span></div>
                <div class="ph-church-row"><span>Workers' comp coverage</span></div>
                <div class="ph-church-row"><span>W-2s and tax documents</span></div>
            </div>
        </div>`;
}

async function renderPayrollHomeTool() {
    const body = _phEl('phBody');
    if (!body) return;
    body.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        const d = await _phLoad();
        _phCache = d;
        body.innerHTML = `
            <div class="ap-panel ph-runs">
                <div class="ph-runs-head">
                    <span class="ph-runs-icon">🕐</span>
                    <h3>Upcoming pay runs</h3>
                    <span class="ph-runs-meta">Bi-weekly · ${d.staff.length} on the clock</span>
                </div>
                ${d.rows.map(_phRunRowHtml).join('')}
            </div>
            <div class="ph-cols">
                <div class="ph-col">${_phExceptionsHtml(d.rows)}</div>
                <div class="ph-col">${_phSideHtml(d)}</div>
            </div>`;
    } catch (e) {
        console.warn('renderPayrollHomeTool:', e);
        body.innerHTML = `<p class="empty-hint">Could not load: ${escHtml(e.message || String(e))}</p>`;
    }
}

// ── Wiring ──────────────────────────────────────────────────
// "Start review" hands off to the period report that already exists: it
// selects the period and runs the report's own loader, rather than this
// screen growing a second way to compute a period.
function _phStartReview(value) {
    const sel = _phEl('payrollPeriod');
    if (sel) {
        sel.value = value;
        if (sel.value !== value) return;           // period not in the list
    }
    // The shell owns the tab switcher (apSwitchPayrollTab, admin-portal.js);
    // a second one here would be two places the same four panes get hidden.
    if (typeof apSwitchPayrollTab === 'function') apSwitchPayrollTab('period');
    if (typeof generatePayrollReport === 'function') generatePayrollReport();
}

function setupPayrollHomeTool() {
    if (_phBound) return;
    const section = _phEl('payrollSection');
    if (!section) return;
    _phBound = true;

    section.addEventListener('click', (ev) => {
        const review = ev.target.closest('[data-ph-review]');
        if (review) { _phStartReview(review.dataset.phReview); return; }
        if (ev.target.closest('[data-ph-open-clock]')) {
            if (typeof apSwitchPayrollTab === 'function') apSwitchPayrollTab('clock');
            return;
        }
        const scroll = ev.target.closest('[data-ph-scroll-exceptions]');
        if (scroll) { _phEl('phExceptions')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
    });
}
