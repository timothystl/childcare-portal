// ============================================================
// portal-today — the parent's Today feed (Phase 1)
// ============================================================
// What a parent opens the app for. Design: PARENT_PORTAL_PLAN §5.
//
// The child switcher swaps content IN PLACE — no navigation, no page change.
// A parent with two children checks both in the same three seconds it takes to
// check one, and losing scroll position between them would undo that.
//
// Everything here reads through RLS. There is no family filter in any query on
// this page: the database decides what a parent can see, and adding a
// belt-and-braces filter in JS would suggest to the next reader that it does
// not.

let ptChildren  = [];
let ptActiveId  = null;
let ptDate      = null;   // YYYY-MM-DD in the center's timezone

function ptEl(id) { return document.getElementById(id); }

function ptEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// The center is in America/Chicago. Using the device's local date would show a
// parent in another timezone the wrong day — which for a traveling parent is
// exactly when they most want to look.
function ptToday() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
}

function ptTime(iso) {
    return new Date(iso).toLocaleTimeString('en-US', {
        hour: 'numeric', minute: '2-digit', timeZone: 'America/Chicago',
    });
}

// ── How each event reads ────────────────────────────────────
// Written as a parent would say it, not as the database stores it. "Nap
// 12:40 – 2:05pm" is what someone wants at pickup; "nap_end" is not.
const PT_EVENT = {
    check_in:   { icon: '👋', label: () => 'Checked in' },
    check_out:  { icon: '🏡', label: () => 'Checked out' },
    nap_start:  { icon: '😴', label: () => 'Fell asleep' },
    nap_end:    { icon: '🌤️', label: () => 'Woke up' },
    diaper:     { icon: '🧷', label: d => ({ wet: 'Diaper — wet', bm: 'Diaper — BM', dry: 'Diaper — dry' }[d?.kind] || 'Diaper change') },
    bottle:     { icon: '🍼', label: d => d?.oz ? `Bottle — ${d.oz} oz` : 'Bottle' },
    meal:       { icon: '🍎', label: d => ({ none: 'Meal — did not eat', some: 'Meal — ate some',
                                             most: 'Meal — ate most', all: 'Meal — ate it all' }[d?.amount] || 'Meal') },
    note:       { icon: '📝', label: d => d?.text || 'Note from the teacher' },
    supplies:   { icon: '📦', label: () => 'Supplies needed' },
};

function ptRenderTimeline(events) {
    const wrap = ptEl('ptTimeline');
    if (!wrap) return;

    if (!events.length) {
        // Distinguish "nothing logged yet" from "not a care day". A parent
        // seeing an empty feed on a Tuesday their child does not attend should
        // not think the teacher forgot.
        wrap.innerHTML = `<div class="pt-empty">
            <p>Nothing logged yet today.</p>
            <p class="pt-empty-sub">Teachers log the day as it happens — check back this afternoon.</p>
        </div>`;
        return;
    }

    wrap.innerHTML = events.map(e => {
        const spec  = PT_EVENT[e.event_type] || { icon: '•', label: () => e.event_type };
        const label = typeof spec.label === 'function' ? spec.label(e.detail) : spec.label;
        return `<li class="pt-event">
            <span class="pt-event-icon" aria-hidden="true">${spec.icon}</span>
            <span class="pt-event-body">
                <span class="pt-event-label">${ptEsc(label)}</span>
                <span class="pt-event-time">${ptEsc(ptTime(e.occurred_at))}</span>
            </span>
        </li>`;
    }).join('');
}

function ptRenderSwitcher() {
    const wrap = ptEl('ptSwitcher');
    if (!wrap) return;
    // One child needs no switcher — a row of one tab is noise.
    if (ptChildren.length < 2) { wrap.classList.add('hidden'); return; }
    wrap.classList.remove('hidden');
    wrap.innerHTML = ptChildren.map(c =>
        `<button type="button" class="pt-tab ${c.id === ptActiveId ? 'active' : ''}"
                 data-child="${ptEsc(c.id)}">${ptEsc((c.child_name || '').split(' ')[0])}</button>`
    ).join('');
    wrap.querySelectorAll('.pt-tab').forEach(b => {
        b.addEventListener('click', () => ptSelectChild(b.dataset.child));
    });
}

function ptSafetyChips(list) {
    return list.map(a => {
        const cls = a.severity === 'severe' ? 'pt-chip-severe'
                  : a.severity === 'sensitivity' ? 'pt-chip-sens' : 'pt-chip-note';
        return `<span class="pt-chip ${cls}">${ptEsc(a.label)}</span>`;
    }).join('');
}

function ptRenderSafety(child) {
    const wrap = ptEl('ptSafety');
    if (!wrap) return;
    // No child at all (family with no students yet, or a render race). The old
    // version survived this by accident — an empty allergy list fell through to
    // its early return. The ask branch below dereferences child.id, so guard it
    // properly rather than relying on that.
    if (!child) { wrap.classList.add('hidden'); wrap.innerHTML = ''; return; }
    const list  = Array.isArray(child?.allergies) ? child.allergies : [];
    const notes = (child?.care_notes || '').trim();
    const first = ptEsc((child?.child_name || '').split(' ')[0]);

    // Never confirmed by anyone: ASK, rather than showing nothing. The parent
    // knows this better than any export does, and their answer counts on its
    // own — no office sign-off, which would just rebuild the bottleneck.
    if (!child?.allergies_reviewed_at) {
        wrap.classList.remove('hidden');
        wrap.className = 'pt-safety pt-safety-ask';
        wrap.innerHTML = `
            <div class="pt-safety-title">Does ${first} have any allergies?</div>
            <p class="pt-ask-copy">Please confirm — teachers see this before every
               snack, bottle and meal. If there are none, say so and we'll stop asking.</p>
            <button type="button" class="pt-ask-btn" data-child="${ptEsc(child.id)}">Add allergies &amp; care notes</button>
            <button type="button" class="pt-ask-none" data-child="${ptEsc(child.id)}">${first} has no allergies</button>`;
        wrap.querySelector('.pt-ask-btn').onclick  = () => ptOpenAllergyEditor(child.id);
        wrap.querySelector('.pt-ask-none').onclick = (e) => ptConfirmNoAllergies(child.id, e.currentTarget);
        return;
    }

    wrap.className = 'pt-safety';
    if (!list.length && !notes) {
        // Confirmed, and genuinely none. Say that rather than hiding the block —
        // a parent who told us "no allergies" should see it stuck.
        wrap.classList.remove('hidden');
        wrap.innerHTML = `<div class="pt-safety-title">On file for ${first}</div>
            <p class="pt-safety-none">No allergies. <button type="button" class="pt-ask-link"
               data-child="${ptEsc(child.id)}">Update</button></p>`;
        wrap.querySelector('.pt-ask-link').onclick = () => ptOpenAllergyEditor(child.id);
        return;
    }
    wrap.classList.remove('hidden');
    wrap.innerHTML = `<div class="pt-safety-title">On file for ${first}</div>
        ${list.length ? `<div class="pt-safety-chips">${ptSafetyChips(list)}</div>` : ''}
        ${notes ? `<div class="pt-safety-note">${ptEsc(notes)}</div>` : ''}
        <p class="pt-safety-none"><button type="button" class="pt-ask-link"
           data-child="${ptEsc(child.id)}">Update</button></p>`;
    wrap.querySelector('.pt-ask-link').onclick = () => ptOpenAllergyEditor(child.id);
}

// ── Allergy editor ──────────────────────────────────────────
// Deliberately not a modal library: a list of chips you add to, plus a notes
// box. Severity matters more than the label being tidy, so it is a radio the
// parent cannot skip rather than a dropdown defaulting to something mild.
let ptDraftAllergies = [];

function ptOpenAllergyEditor(childId) {
    const child = ptChildren.find(c => String(c.id) === String(childId));
    if (!child) return;
    ptDraftAllergies = Array.isArray(child.allergies) ? child.allergies.map(a => ({ ...a })) : [];
    const first = ptEsc((child.child_name || '').split(' ')[0]);
    const wrap = ptEl('ptSafety');
    wrap.classList.remove('hidden');
    wrap.className = 'pt-safety pt-safety-edit';
    wrap.innerHTML = `
        <div class="pt-safety-title">${first}'s allergies</div>
        <div id="ptDraftChips" class="pt-safety-chips"></div>
        <div class="pt-ask-row">
            <input type="text" id="ptAllergyLabel" placeholder="Peanuts, dairy, pollen…" maxlength="60">
            <select id="ptAllergySeverity">
                <option value="severe">Severe</option>
                <option value="sensitivity">Sensitivity</option>
                <option value="note">Note</option>
            </select>
            <button type="button" id="ptAllergyAdd">Add</button>
        </div>
        <label class="pt-ask-notes">
            <span>Anything else the teachers should know?</span>
            <textarea id="ptCareNotes" rows="3" maxlength="500"
                placeholder="Inhaler in the front pocket, needs it before outside play…">${ptEsc(child.care_notes || '')}</textarea>
        </label>
        <div class="pt-ask-actions">
            <button type="button" id="ptAllergySave" class="pt-ask-btn">Save</button>
            <button type="button" id="ptAllergyCancel" class="pt-ask-link">Cancel</button>
        </div>
        <p id="ptAllergyMsg" class="pt-ask-msg"></p>`;

    const redraw = () => {
        ptEl('ptDraftChips').innerHTML = ptDraftAllergies.length
            ? ptDraftAllergies.map((a, i) => {
                const cls = a.severity === 'severe' ? 'pt-chip-severe'
                          : a.severity === 'sensitivity' ? 'pt-chip-sens' : 'pt-chip-note';
                return `<span class="pt-chip ${cls}">${ptEsc(a.label)}
                    <button type="button" class="pt-chip-x" data-i="${i}" aria-label="Remove ${ptEsc(a.label)}">×</button></span>`;
            }).join('')
            : '<span class="pt-ask-empty">Nothing added yet.</span>';
        ptEl('ptDraftChips').querySelectorAll('.pt-chip-x').forEach(b => {
            b.onclick = () => { ptDraftAllergies.splice(Number(b.dataset.i), 1); redraw(); };
        });
    };
    redraw();

    const add = () => {
        const label = (ptEl('ptAllergyLabel').value || '').trim();
        if (!label) return;
        // Same label twice is a slip, not two allergies — mirrors the admin editor.
        if (ptDraftAllergies.some(a => a.label.toLowerCase() === label.toLowerCase())) {
            ptEl('ptAllergyMsg').textContent = `${label} is already on the list.`;
            return;
        }
        ptDraftAllergies.push({ label, severity: ptEl('ptAllergySeverity').value });
        ptEl('ptAllergyLabel').value = '';
        ptEl('ptAllergyMsg').textContent = '';
        redraw();
    };
    ptEl('ptAllergyAdd').onclick = add;
    ptEl('ptAllergyLabel').addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); add(); }
    });
    ptEl('ptAllergyCancel').onclick = () => ptRenderSafety(child);
    ptEl('ptAllergySave').onclick = async (e) => {
        // A typed-but-not-added allergy is the obvious trap here: the parent
        // fills the box, hits Save, and their peanut allergy is silently gone.
        if ((ptEl('ptAllergyLabel').value || '').trim()) add();
        await ptSaveAllergies(child, ptDraftAllergies, ptEl('ptCareNotes').value, e.currentTarget);
    };
}

async function ptConfirmNoAllergies(childId, btn) {
    const child = ptChildren.find(c => String(c.id) === String(childId));
    if (!child) return;
    await ptSaveAllergies(child, [], '', btn);
}

async function ptSaveAllergies(child, allergies, careNotes, btn) {
    const label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    try {
        const saved = await confirmChildAllergies(child.id, allergies, careNotes);
        // Update the local copy so the panel re-renders as confirmed without a
        // round trip — and so switching children and back does not un-confirm it.
        child.allergies = saved.allergies || [];
        child.care_notes = saved.care_notes || '';
        child.allergies_reviewed_at = saved.reviewed_at;
        ptRenderSafety(child);
    } catch (err) {
        const msg = ptEl('ptAllergyMsg');
        if (msg) msg.textContent = 'Could not save: ' + (err.message || err);
        if (btn) { btn.disabled = false; btn.textContent = label; }
    }
}

async function ptSelectChild(childId) {
    ptActiveId = childId;
    const child = ptChildren.find(c => String(c.id) === String(childId));
    ptRenderSwitcher();
    ptRenderSafety(child);

    ptEl('ptChildName').textContent = child ? child.child_name : '';
    ptEl('ptTimeline').innerHTML = '<li class="pt-loading">Loading…</li>';

    try {
        const events = await fetchChildDay(childId, ptDate);
        ptRenderTimeline(events);
    } catch (e) {
        console.warn('day feed:', e);
        ptEl('ptTimeline').innerHTML = '<li class="pt-loading">Could not load today.</li>';
    }

    ptRenderPhotos(childId);
    ptRenderIncidents(childId);

    // The print header carries the identifying detail the screen shows in page
    // chrome. On paper the chrome is gone, and an undated sheet about an
    // unnamed child is worthless in a file.
    const meta = ptEl('ptPrintMeta');
    if (meta && child) {
        meta.textContent = `${child.child_name} — ${new Date(ptDate + 'T12:00:00')
            .toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' })}`;
    }
}

// ── Incident reports ────────────────────────────────────────
// Only ever approved ones: RLS will not return a submitted report, and there is
// no filter here because the database owns that rule.
//
// These sit ABOVE the timeline, not inside it. An injury is not one entry among
// the diapers — a parent scanning the feed must not have to find it.
async function ptRenderIncidents(childId) {
    const wrap = ptEl('ptIncidents');
    if (!wrap) return;
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    try {
        const reports = await fetchMyIncidentReports(childId);
        if (!reports.length) return;
        wrap.classList.remove('hidden');
        wrap.innerHTML = reports.map(r => {
            const when = new Date(r.occurred_at).toLocaleString('en-US', {
                month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit',
                timeZone: 'America/Chicago',
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
    } catch (e) {
        console.warn('incidents:', e);
    }
}

// ── Photos ──────────────────────────────────────────────────
// Loaded separately from the timeline so a slow or failed photo fetch never
// costs a parent the day's log, which is the part that actually matters.
async function ptRenderPhotos(childId) {
    const wrap = ptEl('ptPhotos');
    if (!wrap) return;
    wrap.classList.add('hidden');
    wrap.innerHTML = '';
    try {
        const photos = await fetchChildPhotos(childId, ptDate);
        if (!photos.length) return;
        wrap.classList.remove('hidden');
        wrap.innerHTML = `
            <div class="pt-photos-head">
                <span>Today's photos</span>
                <span class="pt-photos-note">Saved for about a week — download any you'd like to keep.</span>
            </div>
            <div class="pt-photo-strip">
                ${photos.map(p => `<a class="pt-photo" href="${ptEsc(p.url)}" target="_blank" rel="noopener"
                       download><img src="${ptEsc(p.url)}" alt="${ptEsc(p.caption || 'Photo from today')}" loading="lazy"></a>`).join('')}
            </div>`;
    } catch (e) {
        // Silent: a parent who cannot load photos should still see the day.
        console.warn('photos:', e);
    }
}

async function ptRenderAnnouncements() {
    const wrap = ptEl('ptAnnouncements');
    if (!wrap) return;
    try {
        const list = await fetchAnnouncements();
        if (!list.length) { wrap.classList.add('hidden'); return; }
        wrap.classList.remove('hidden');
        wrap.innerHTML = list.slice(0, 3).map(a => `<div class="pt-ann">
            <div class="pt-ann-title">${ptEsc(a.title)}</div>
            <div class="pt-ann-body">${ptEsc(a.body)}</div>
        </div>`).join('');
    } catch (e) {
        console.warn('announcements:', e);
        wrap.classList.add('hidden');
    }
}

// Called by portal-auth once a session exists.
async function ptLoadToday() {
    ptDate = ptToday();
    const dateEl = ptEl('ptDate');
    if (dateEl) {
        dateEl.textContent = new Date(ptDate + 'T12:00:00').toLocaleDateString('en-US', {
            weekday: 'long', month: 'long', day: 'numeric',
        });
    }

    try {
        ptChildren = await fetchMyChildren();
    } catch (e) {
        console.warn('children:', e);
        ptChildren = [];
    }

    if (!ptChildren.length) {
        ptEl('ptFeed')?.classList.add('hidden');
        ptEl('ptNoChildren')?.classList.remove('hidden');
        return;
    }

    ptEl('ptPrintBtn')?.addEventListener('click', () => window.print());

    ptEl('ptNoChildren')?.classList.add('hidden');
    ptEl('ptFeed')?.classList.remove('hidden');
    await ptSelectChild(ptChildren[0].id);
    ptRenderAnnouncements();
}
