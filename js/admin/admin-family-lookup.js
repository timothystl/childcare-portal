// ============================================================
// MODULE: Director Dashboard — Family Lookup panel
// ============================================================
// A search-first panel embedded directly on the Director dashboard
// (design handoff screenshot, 2026-09-03): find a family by parent or
// child name, call or message them, and see a child's days of care for
// the month without leaving the dashboard.
//
// Deliberately NOT a new AP_TOOLS entry / sidebar tool — it is dashboard
// content, the same as the "Staff needed this week" grid or the waitlist
// queue apDashDirector() already renders. "Edit" reuses the real Family
// Directory edit modal (openFamilyModal(), admin-families.js) rather than
// building a second one; nothing about a family's record is computed or
// stored here.
//
// ⚠️ Search-first, not list-everything. The mockup shows every family
// (its own dataset only had 6) with no query typed. Doing that for real
// would mean eagerly fetching allRegistrations() — 923 kB of parent PII,
// per CLAUDE.md's own open R12 finding — on every single admin login just
// to show day counts, before the director has asked to look anyone up.
// Nothing renders (and allRegistrations is never touched) until she
// actually types something.
// ============================================================

let _flQuery      = '';
let _flLive       = null;             // last `live` the dashboard rendered with
let _flOpenKeys   = new Set();        // `${familyId}:${studentIndex}` currently expanded
let _flCalCursor  = {};               // same key -> {year, month} (0-indexed), calendar nav state
let _flRegsLoading = false;
let _flRegsLoaded  = false;           // allRegistrations has been fetched (or confirmed already loaded) at least once

const _FL_DOW    = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const _FL_MONTHS = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

function apFamilyLookupPanelHtml(live) {
    _flLive = live;
    return apPanel({
        title: 'Family Lookup',
        sub: "Find a family to call or message, and check a child's days of care for the month — right from the dashboard.",
        body: `
            <div class="fl-panel">
                <div class="fl-search-row">
                    <input type="text" id="flSearchInput" class="fl-search-input"
                        placeholder="Search by parent or child name…" autocomplete="off"
                        value="${escHtml(_flQuery)}">
                </div>
                <div id="flResults">${_flResultsBodyHtml()}</div>
            </div>`,
    });
}

function _flRenderResults() {
    const host = document.getElementById('flResults');
    if (!host) return;
    host.innerHTML = _flResultsBodyHtml();
}

function _flResultsBodyHtml() {
    const q = _flQuery.trim();
    if (!q) {
        return `<p class="fl-empty">Start typing a parent or child's name to find a family.</p>`;
    }
    const matches = _flMatches(q);
    if (!matches.length) {
        return `<p class="fl-empty">No family matches "${escHtml(q)}".</p>`;
    }
    // Day counts and calendars need allRegistrations. Lazy-loaded once, on
    // the first real search — same guarded, no-op-after-first-load pattern
    // fetchAllRegistrations() uses throughout the admin app (e.g. the
    // Attendance Board), not a new pattern invented for this panel.
    if (!_flRegsLoaded) _flEnsureRegistrationsLoaded();
    return `
        <p class="fl-count">${matches.length} famil${matches.length === 1 ? 'y' : 'ies'} found</p>
        <div class="fl-list">${matches.map(f => _flFamilyCardHtml(f)).join('')}</div>`;
}

async function _flEnsureRegistrationsLoaded() {
    if (_flRegsLoading || _flRegsLoaded) return;
    _flRegsLoading = true;
    try {
        if (typeof allRegistrations !== 'undefined' && !allRegistrations.length) {
            allRegistrations = await fetchAllRegistrations().catch(() => []);
        }
    } finally {
        _flRegsLoading = false;
        _flRegsLoaded  = true;
        _flRenderResults();
    }
}

// Same fields _arRunSearch()/_aadRunSearch() check (child name, both parent
// names, both parent emails) — a lookup tool is exactly the case where a
// director searching by email should work, unlike onFamilySearch() (the
// Family Directory's own list filter), which doesn't check email at all.
function _flMatches(q) {
    const lower = q.toLowerCase();
    const families = (_flLive && _flLive.families && _flLive.families.length)
        ? _flLive.families
        : (typeof allFamiliesData !== 'undefined' ? allFamiliesData : []);
    return families.filter(f =>
        (f.students || []).some(s => (s.child_name || '').toLowerCase().includes(lower)) ||
        (f.parent_name    || '').toLowerCase().includes(lower) ||
        (f.parent2_name   || '').toLowerCase().includes(lower) ||
        (f.parent_email   || '').toLowerCase().includes(lower) ||
        (f.parent2_email  || '').toLowerCase().includes(lower)
    );
}

function _flFindFamilyById(id) {
    const families = (_flLive && _flLive.families && _flLive.families.length)
        ? _flLive.families
        : (typeof allFamiliesData !== 'undefined' ? allFamiliesData : []);
    return families.find(f => String(f.id) === String(id)) || null;
}

function _flFamilyCardHtml(f) {
    const lastName = (f.parent_name || '').trim().split(/\s+/).pop() || '';
    const initials = (lastName.slice(0, 2) || 'FA').toUpperCase();
    const phone    = f.parent_phone || f.parent2_phone || '';
    const kids     = f.students || [];
    const openKids = kids
        .map((c, idx) => ({ c, idx }))
        .filter(({ idx }) => _flOpenKeys.has(`${f.id}:${idx}`));

    return `
    <div class="fl-family-card">
        <div class="fl-family-head">
            <div class="fl-avatar">${escHtml(initials)}</div>
            <div class="fl-family-main">
                <div class="fl-family-name">${escHtml(lastName)} Family</div>
                ${_flParentRowHtml(f.parent_name, f.parent_email, f.parent_phone)}
                ${f.parent2_name ? _flParentRowHtml(f.parent2_name, f.parent2_email, f.parent2_phone) : ''}
            </div>
            <div class="fl-actions">
                <button type="button" class="fl-btn" data-fl-edit="${escHtml(String(f.id))}">✎ Edit</button>
                ${phone
                    ? `<a class="fl-btn" href="tel:${escHtml(phone.replace(/[^\d+]/g, ''))}">📞 Call</a>`
                    : `<span class="fl-btn fl-btn-disabled" title="No phone on file">📞 Call</span>`}
                <button type="button" class="fl-btn fl-btn-primary" data-ap-go="messages">💬 Message</button>
            </div>
        </div>
        <div class="fl-children">
            ${kids.map((c, idx) => _flChildRowHtml(f, c, idx)).join('')}
        </div>
        ${openKids.length ? `<div class="fl-cal-row">
            ${openKids.map(({ c, idx }) => _flCalendarCardHtml(f, c, idx)).join('')}
        </div>` : ''}
    </div>`;
}

function _flParentRowHtml(name, email, phone) {
    if (!name) return '';
    return `<div class="fl-parent-row">
        <span class="fl-parent-name">${escHtml(name)}</span>
        <span class="fl-parent-meta">${escHtml(email || '')}${email && phone ? ' · ' : ''}${escHtml(phone || '')}</span>
    </div>`;
}

function _flChildRowHtml(f, c, idx) {
    const key      = `${f.id}:${idx}`;
    const isOpen   = _flOpenKeys.has(key);
    const roomLabel = _flRoomLabel(c);
    const monthKey  = _flTodayMonthKey();
    const reg       = _flFindRegistration(f, c, monthKey);
    const days      = reg ? _flCareDayCount(reg, monthKey) : 0;
    const daysLabel = !_flRegsLoaded ? 'loading…' : `${days} day${days === 1 ? '' : 's'} this month`;

    return `
    <div class="fl-child-row${isOpen ? ' is-open' : ''}" data-fl-toggle="${escHtml(key)}">
        <span class="fl-child-name">${escHtml(c.child_name || 'Unnamed child')}</span>
        <span class="fl-child-room">${escHtml(roomLabel)}</span>
        <span class="fl-child-days">${daysLabel}</span>
        <span class="fl-chevron" aria-hidden="true">${isOpen ? '▲' : '▼'}</span>
    </div>`;
}

function _flCalendarCardHtml(f, c, idx) {
    const key    = `${f.id}:${idx}`;
    const cursor = _flCalCursor[key] || (_flCalCursor[key] = _flDefaultCursor());
    const monthKey = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}`;
    const reg      = _flFindRegistration(f, c, monthKey);
    const roomLabel = _flRoomLabel(c);

    return `
    <div class="fl-cal-card">
        <div class="fl-cal-head">
            <span class="fl-eyebrow">Days of care</span>
            ${reg ? `<button type="button" class="fl-btn fl-btn-sm" data-fl-change-days="${escHtml(key)}">🗓️ Change days of care</button>` : ''}
        </div>
        <div class="fl-cal-nav">
            <button type="button" class="fl-cal-nav-btn" data-fl-nav-key="${escHtml(key)}" data-fl-nav-delta="-1" aria-label="Previous month">‹</button>
            <span class="fl-cal-nav-label">${_FL_MONTHS[cursor.month]} ${cursor.year}</span>
            <button type="button" class="fl-cal-nav-btn" data-fl-nav-key="${escHtml(key)}" data-fl-nav-delta="1" aria-label="Next month">›</button>
            <button type="button" class="fl-cal-close" data-fl-toggle="${escHtml(key)}" aria-label="Close">✕</button>
        </div>
        <div class="fl-cal-grid">${_flCalGridHtml(cursor, reg)}</div>
        ${!reg ? `<p class="fl-cal-empty">No care days on file for ${_FL_MONTHS[cursor.month]}.</p>` : ''}
        <div class="fl-info-block">
            <span class="fl-eyebrow">Child info</span>
            <div class="fl-info-row"><span class="fl-info-label">Date of birth</span><span class="fl-info-value">${c.child_dob ? friendlyShort(c.child_dob) : '—'}</span></div>
            <div class="fl-info-row"><span class="fl-info-label">Age</span><span class="fl-info-value">${_flAge(c.child_dob)}</span></div>
            <div class="fl-info-row"><span class="fl-info-label">Room</span><span class="fl-info-value">${escHtml(roomLabel)}</span></div>
        </div>
        <div class="fl-info-block">
            <span class="fl-eyebrow">Allergies &amp; care notes</span>
            ${_flAllergyNotesHtml(c)}
        </div>
    </div>`;
}

function _flCalGridHtml(cursor, reg) {
    const { year, month } = cursor;
    const existingMap = {};
    (reg?.registration_dates || []).forEach(d => { existingMap[d.care_date] = d; });

    const firstDow     = new Date(year, month, 1).getDay(); // 0 = Sun
    const daysInMonth  = new Date(year, month + 1, 0).getDate();

    let html = _FL_DOW.map(d => `<div class="fl-cal-hdr">${d}</div>`).join('');
    for (let i = 0; i < firstDow; i++) html += '<div class="fl-cal-cell other-month"></div>';

    for (let day = 1; day <= daysInMonth; day++) {
        const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
        const dow = new Date(year, month, day).getDay();
        const isWeekend = dow === 0 || dow === 6;
        const existing  = existingMap[dateStr];
        let cls = 'fl-cal-cell';
        let title = '';
        if (existing && !existing.waitlisted) {
            cls += existing.day_type === 'half' ? ' is-half' : ' is-full';
            title = existing.day_type === 'half' ? 'Half day' : 'Full day';
        } else if (isWeekend) {
            cls += ' weekend';
        }
        html += `<div class="${cls}"${title ? ` title="${title}"` : ''}>${day}</div>`;
    }

    const remainder = (firstDow + daysInMonth) % 7;
    if (remainder > 0) for (let i = remainder; i < 7; i++) html += '<div class="fl-cal-cell other-month"></div>';
    return html;
}

function _flAllergyNotesHtml(c) {
    const allergies = Array.isArray(c.allergies) ? c.allergies : [];
    const parts = [];
    if (allergies.length) {
        parts.push(`<p class="fl-allergy-line">${allergies.map(a =>
            `${escHtml(a.label)} — ${escHtml(a.severity || 'note')}`).join(', ')}</p>`);
    }
    if (c.care_notes) {
        parts.push(`<p class="fl-allergy-line fl-care-note">${escHtml(c.care_notes)}</p>`);
    }
    if (!parts.length) return `<p class="fl-allergy-line fl-none">None on file</p>`;
    return parts.join('');
}

function _flRoomLabel(c) {
    const id = c.room_override || (typeof getRoomIdFromDob === 'function' ? getRoomIdFromDob(c.child_dob) : null);
    return (typeof ROOMS !== 'undefined' && ROOMS.find(r => r.id === id)?.label) || 'Room to be assigned';
}

function _flAge(dob) {
    if (!dob) return '—';
    const b = new Date(dob + 'T00:00:00'), n = new Date();
    let months = (n.getFullYear() - b.getFullYear()) * 12 + (n.getMonth() - b.getMonth());
    if (n.getDate() < b.getDate()) months--;
    months = Math.max(0, months);
    const y = Math.floor(months / 12), m = months % 12;
    return y === 0 ? `${m}m` : `${y}y ${m}m`;
}

function _flTodayMonthKey() {
    return (_flLive && _flLive.monthKey) || new Date().toLocaleDateString('en-CA').slice(0, 7);
}

function _flDefaultCursor() {
    const now = new Date();
    return { year: now.getFullYear(), month: now.getMonth() };
}

// registrations are one row per child per month (no student_id column to
// join on — same reason checkExistingRegistrationByChild() matches by
// name), so month_key + child name + either parent's email is exactly how
// the rest of the admin app already resolves "this child's registration
// for this month" (see openEditDaysModal()'s own openMonth fallback).
function _flRegMonthKey(r) {
    return r.month_key || r.registration_dates?.[0]?.care_date?.substring(0, 7) || '';
}

function _flFindRegistration(f, c, monthKey) {
    if (typeof allRegistrations === 'undefined' || !allRegistrations.length) return null;
    const email  = (f.parent_email  || '').toLowerCase();
    const email2 = (f.parent2_email || '').toLowerCase();
    const name   = (c.child_name    || '').toLowerCase();
    return allRegistrations.find(r => {
        const rEmail = (r.parent_email || '').toLowerCase();
        return (r.child_name || '').toLowerCase() === name &&
               (rEmail === email || (email2 && rEmail === email2)) &&
               _flRegMonthKey(r) === monthKey;
    }) || null;
}

function _flCareDayCount(reg, monthKey) {
    return (reg.registration_dates || []).filter(d =>
        !d.waitlisted && (d.care_date || '').startsWith(monthKey)).length;
}

// ── Interactions ─────────────────────────────────────────────
// Wired from setupAdminPortal()'s existing delegated click/input handlers
// (admin-portal.js) — same data-attribute-delegation convention the rest
// of the shell uses (data-ap-off-*, data-ap-sched-*, etc.), so nothing has
// to re-bind listeners after a re-render.

function _flHandleSearchInput(value) {
    _flQuery = value;
    _flRenderResults();
}

function _flToggleChild(key) {
    if (_flOpenKeys.has(key)) _flOpenKeys.delete(key);
    else _flOpenKeys.add(key);
    _flRenderResults();
}

function _flNavCalendar(key, delta) {
    const cur = _flCalCursor[key] || _flDefaultCursor();
    let month = cur.month + delta;
    let year  = cur.year;
    if (month < 0)  { month = 11; year--; }
    if (month > 11) { month = 0;  year++; }
    _flCalCursor[key] = { year, month };
    _flRenderResults();
}

function _flEditFamily(id) {
    const family = _flFindFamilyById(id);
    if (!family) return;
    if (typeof openFamilyModal === 'function') openFamilyModal(family);
}

function _flChangeDays(key) {
    const sep = key.lastIndexOf(':');
    if (sep < 0) return;
    const familyId = key.slice(0, sep);
    const idx      = parseInt(key.slice(sep + 1), 10);
    const family   = _flFindFamilyById(familyId);
    const child    = family && (family.students || [])[idx];
    if (!family || !child) return;

    const cursor  = _flCalCursor[key] || _flDefaultCursor();
    const monthKey = `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}`;
    const reg = _flFindRegistration(family, child, monthKey);
    if (reg && typeof openEditDaysModal === 'function') openEditDaysModal(reg);
}
