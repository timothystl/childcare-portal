// ============================================================
// portal-recap — the parent's day-by-day record
// ============================================================
// "How did today go?" is Today's job for the current day; Recap is the same
// question for a day that already happened — the browsable record behind it.
// Same three sections as Today (daily-sheet events, photos, incidents), same
// RLS-owns-the-rule stance (no family or child filter here — the database
// already scopes every read to the signed-in parent's own children), just for
// a date the parent picks instead of always "now".
//
// Deliberately reuses portal-today's vocabulary rather than a second copy:
// PT_EVENT (how an event reads), ptEsc/ptTime/ptToday (escaping, formatting,
// "what day is it in the center's timezone"), and ptChildren/ptActiveId (the
// child list and whichever child Today has selected). portal-today.js loads
// first in the bundle (scripts/build.js), so all of that is in scope here.
//
// ⚠️ Photos are NOT kept forever (see the retention note on Today's photo
// section) — an old date simply shows no photos even if some were once
// posted. That's the bucket sweep working as designed, not a bug here.

let prActiveId = null;
let prDate     = null;   // YYYY-MM-DD, center timezone
let prIncidentsByChild = {};   // studentId -> all approved incident reports for that child

function prEl(id) { return document.getElementById(id); }

// Date math done at noon local time, same trick ptDate uses elsewhere in this
// bundle — it sidesteps DST/timezone boundary issues when the string is later
// reinterpreted with a fixed timeZone.
function prShiftDate(dateStr, days) {
    const d = new Date(dateStr + 'T12:00:00');
    d.setDate(d.getDate() + days);
    return d.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function prRenderSwitcher() {
    const wrap = prEl('prSwitcher');
    if (!wrap) return;
    if (ptChildren.length < 2) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    wrap.innerHTML = ptChildren.map(c =>
        `<button type="button" class="pt-childbtn ${c.id === prActiveId ? 'active' : ''}"
                 data-child="${ptEsc(c.id)}">${ptEsc((c.child_name || '').split(' ')[0])}</button>`
    ).join('');
    wrap.querySelectorAll('.pt-childbtn').forEach(b => {
        b.addEventListener('click', () => prSelectChild(b.dataset.child));
    });
}

// A window AROUND the selected day, oldest first, rather than the last N days
// counting backwards. Stepping with ‹ / › then reads as moving along a strip
// that stays put, instead of the whole strip re-anchoring on every press.
const PR_STRIP_BACK = 3;
const PR_STRIP_FWD  = 3;

function prQuickDays() {
    const days = [];
    let d = prShiftDate(prDate, -PR_STRIP_BACK);
    for (let i = 0; i <= PR_STRIP_BACK + PR_STRIP_FWD; i++) { days.push(d); d = prShiftDate(d, 1); }
    return days;
}

function prRenderQuickDays() {
    const wrap = prEl('prQuickDays');
    if (!wrap) return;
    const today = ptToday();
    wrap.innerHTML = prQuickDays().map(d => {
        const dt  = new Date(d + 'T12:00:00');
        const dow = dt.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Chicago' });
        const num = dt.toLocaleDateString('en-US', { day: 'numeric',   timeZone: 'America/Chicago' });
        // A future day is drawn, not hidden — the strip keeps its shape as you
        // walk it — but it cannot be opened: there is no day there yet.
        const future = d > today;
        return `<button type="button" class="pr-quick-day ${d === prDate ? 'active' : ''}"
                    data-date="${d}"${future ? ' disabled' : ''}>
                    <span class="pr-quick-dow">${ptEsc(dow)}</span>
                    <span class="pr-quick-num">${ptEsc(num)}</span>
                </button>`;
    }).join('');
    wrap.querySelectorAll('.pr-quick-day').forEach(b => {
        b.addEventListener('click', () => prGoToDate(b.dataset.date));
    });
}

function prGoToDate(dateStr) {
    if (dateStr > ptToday()) return;   // no peeking at a day that hasn't happened
    prDate = dateStr;
    prRenderDay();
}

function prRenderTimeline(events) {
    const wrap = prEl('prTimeline');
    if (!wrap) return;
    if (!events.length) {
        wrap.innerHTML = `<div class="pt-empty ui-empty-state">
            <img class="ui-empty-illustration" src="/images/illustrations/empty-recap.svg" alt="">
            <p>Nothing logged for this day.</p>
            <p class="pt-empty-sub">Either it wasn't a care day, or nothing was recorded — try another date above.</p>
        </div>`;
        return;
    }
    wrap.innerHTML = events.map(e => {
        const spec  = PT_EVENT[e.event_type] || { icon: '/images/icons/document-generic.svg', label: () => e.event_type };
        const label = typeof spec.label === 'function' ? spec.label(e.detail) : spec.label;
        return `<li class="pt-event">
            <img class="pt-event-icon" src="${spec.icon}" alt="" aria-hidden="true">
            <span class="pt-event-body">
                <span class="pt-event-label">${ptEsc(label)}</span>
                <span class="pt-event-time">${ptEsc(ptTime(e.occurred_at))}</span>
            </span>
        </li>`;
    }).join('');
}

function prRenderPhotos(photos) {
    const wrap = prEl('prPhotos');
    if (!wrap) return;
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    if (!photos.length) return;
    wrap.classList.remove('hidden');
    wrap.innerHTML = `
        <div class="pt-photos-head"><span>Photos from this day</span></div>
        <div class="pt-photo-strip">
            ${photos.map(p => `<a class="pt-photo" href="${ptEsc(p.url)}" target="_blank" rel="noopener"
                   download><img src="${ptEsc(p.url)}" alt="${ptEsc(p.caption || 'Photo')}" loading="lazy"></a>`).join('')}
        </div>`;
}

function prRenderIncidents(reports) {
    const wrap = prEl('prIncidents');
    if (!wrap) return;
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    if (!reports.length) return;
    wrap.classList.remove('hidden');
    wrap.innerHTML = reports.map(r => {
        const when = new Date(r.occurred_at).toLocaleString('en-US', {
            hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
        });
        const label = { injury: 'Injury', illness: 'Illness',
                        behavior: 'Behavior', other: 'Note' }[r.incident_type] || 'Report';
        return `<div class="pt-incident">
            <div class="pt-incident-head">
                <span class="pt-incident-type">${ptEsc(label)}</span>
                <span class="pt-incident-when">${ptEsc(when)}</span>
            </div>
            <p class="pt-incident-what">${ptEsc(r.description)}</p>
            <p class="pt-incident-did"><strong>What we did:</strong> ${ptEsc(r.action_taken)}</p>
            ${r.body_area ? `<p class="pt-incident-meta">Area: ${ptEsc(r.body_area)}</p>` : ''}
            ${r.location  ? `<p class="pt-incident-meta">Where: ${ptEsc(r.location)}</p>` : ''}
            <p class="pt-incident-meta">Reported by ${ptEsc(r.reported_by_name || 'staff')}${
                r.reviewed_at ? ', reviewed by the director' : ''}.</p>
        </div>`;
    }).join('');
}

async function prIncidentsForChild(childId) {
    // Fetched once per child and cached — RLS already returns only that
    // child's approved reports (see fetchMyIncidentReports), and re-fetching
    // per date navigated to would be a round trip for data already in hand.
    if (!prIncidentsByChild[childId]) {
        try {
            prIncidentsByChild[childId] = await fetchMyIncidentReports(childId);
        } catch (e) {
            console.warn('recap incidents:', e);
            prIncidentsByChild[childId] = [];
        }
    }
    return prIncidentsByChild[childId];
}

async function prRenderDay() {
    const dayLabel  = prEl('prDayLabel');
    const dateLabel = prEl('prDateLabel');
    const dateInput = prEl('prDateInput');
    const isToday   = prDate === ptToday();
    const when      = new Date(prDate + 'T12:00:00');
    // Weekday and date on separate lines, per the design. "(today)" stays —
    // it is the one thing the two lines cannot say on their own.
    if (dayLabel) {
        dayLabel.textContent = when.toLocaleDateString('en-US', { weekday: 'long' })
            + (isToday ? ' (today)' : '');
    }
    if (dateLabel) {
        dateLabel.textContent = when.toLocaleDateString('en-US', {
            month: 'long', day: 'numeric', year: 'numeric',
        });
    }
    if (dateInput) { dateInput.value = prDate; dateInput.max = ptToday(); }
    const nextBtn = prEl('prNextBtn');
    if (nextBtn) nextBtn.disabled = isToday;

    prRenderQuickDays();

    const timeline = prEl('prTimeline');
    if (timeline) timeline.innerHTML = '<li class="pt-loading">Loading…</li>';
    prEl('prPhotos')?.classList.add('hidden');
    prEl('prIncidents')?.classList.add('hidden');

    if (!prActiveId) return;

    try {
        const [events, photos, incidents] = await Promise.all([
            fetchChildDay(prActiveId, prDate),
            fetchChildPhotos(prActiveId, prDate).catch(e => { console.warn('recap photos:', e); return []; }),
            prIncidentsForChild(prActiveId),
        ]);
        prRenderTimeline(events);
        prRenderPhotos(photos);
        prRenderIncidents(incidents.filter(r => r.care_date === prDate));
    } catch (e) {
        console.warn('recap day:', e);
        if (timeline) timeline.innerHTML = '<li class="pt-loading">Could not load this day.</li>';
    }
}

async function prSelectChild(childId) {
    prActiveId = childId;
    prRenderSwitcher();
    await prRenderDay();
}

// Called by portal-nav the first time a parent opens the Recap tab.
async function prLoad() {
    if (!ptChildren.length) {
        prEl('prBody')?.classList.add('hidden');
        prEl('prNoChildren')?.classList.remove('hidden');
        return;
    }
    prEl('prNoChildren')?.classList.add('hidden');
    prEl('prBody')?.classList.remove('hidden');

    // Yesterday, not today — Recap is the record of a day that already
    // finished; Today already owns "right now".
    prDate = prShiftDate(ptToday(), -1);

    prEl('prPrevBtn')?.addEventListener('click', () => prGoToDate(prShiftDate(prDate, -1)));
    prEl('prNextBtn')?.addEventListener('click', () => prGoToDate(prShiftDate(prDate, 1)));
    prEl('prDateInput')?.addEventListener('change', (e) => { if (e.target.value) prGoToDate(e.target.value); });

    // Start on whichever child Today has active, so switching tabs doesn't
    // reset which child a parent was just looking at.
    const startId = ptActiveId && ptChildren.some(c => String(c.id) === String(ptActiveId))
        ? ptActiveId : ptChildren[0].id;
    await prSelectChild(startId);
}
