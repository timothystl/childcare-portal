// ============================================================
// CONSTANTS
// ============================================================
// MONTH_NAMES is defined in supabase.js (loaded first) and shared globally.
const DAY_HEADERS_MF = ['Mon','Tue','Wed','Thu','Fri'];

// ============================================================
// STATE
// ============================================================
let currentDate         = new Date();
let selectedFamily      = null;     // { id, parent_name, parent_email, parent_phone, pin, students:[] }
let _isParent2          = false;   // whether the logged-in parent is parent 2
let _familySessionToken = null;    // short-lived HMAC token issued at login, passed to push-subscribe
let selectedChildren    = [];       // [{ name, dob, room: ROOMS[i], isNew: bool, studentId: string|null }] — every child being registered this session
let childSchedules      = new Map();   // studentId -> Map('YYYY-MM-DD' -> { dayType: 'full'|'half', locked?: bool }) — each child's own care days
let activeChildId       = null;        // studentId of the child currently shown on the calendar
let capacityCache       = {};         // { roomId: { 'YYYY-MM-DD': count } }
let closureMap          = new Map();  // 'YYYY-MM-DD' -> { reason, half } — half=true means a partial-day closure (morning still bookable)
let calendarLoading     = false;
let pickerOpenDate      = null;
let regWindowOverride   = 'auto';     // 'auto' | 'open' | 'closed'
const studentDataMap    = new Map();  // studentId -> { dob, roomOverride, discountType, discountValue } — kept in JS, not DOM

function activeChild() {
    return selectedChildren.find(c => c.studentId === activeChildId) || null;
}
function activeSchedule() {
    return childSchedules.get(activeChildId) || new Map();
}

// ============================================================
// REGISTRATION WINDOW
// - mode 'confirmed' : 9 AM Central on the 1st through 11:59 PM Central on the 15th
// - mode 'closed'    : all other times (no waitlist)
// Uses America/Chicago so DST adjustments (CST/CDT) are handled automatically.
// ============================================================
function getCentralTimeNow() {
    const now   = new Date();
    const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'America/Chicago',
        year: 'numeric', month: 'numeric', day: 'numeric',
        hour: 'numeric', hour12: false,
    }).formatToParts(now);
    const get = (type) => parseInt(parts.find(p => p.type === type).value, 10);
    // hour12:false can return 24 for midnight in some environments; normalize to 0.
    return { year: get('year'), month: get('month') - 1, day: get('day'), hour: get('hour') % 24 };
}

function getRegistrationWindow() {
    const { year, month, day, hour } = getCentralTimeNow();

    const targetDate  = new Date(year, month + 1, 1);
    const targetLabel = MONTH_NAMES[targetDate.getMonth()] + ' ' + targetDate.getFullYear();

    const deadlineDate  = new Date(year, month, 15);
    const deadlineLabel = deadlineDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

    // Open: from 9 AM Central on the 1st through end of the 15th (midnight → closed)
    const opensToday = (day === 1 && hour < 9);
    let mode;
    if (day > 15 || opensToday) {
        mode = 'closed';
    } else {
        mode = 'confirmed';
    }

    if (regWindowOverride === 'open')   mode = 'confirmed';
    if (regWindowOverride === 'closed') mode = 'closed';

    return { mode, opensToday, targetDate, targetLabel, deadlineLabel };
}

function getTargetMonthKey() {
    const { year, month } = getCentralTimeNow();
    const target = new Date(year, month + 1, 1);
    return `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}`;
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    // Fetch the independent admin settings in parallel. Using allSettled so a
    // single failed request degrades gracefully instead of aborting the whole
    // init (e.g. a missing room_rates row shouldn't stop the form rendering).
    const [rateRes, capRes, ratioRes, campRes, overrideRes, closuresRes, regFeeRes, newFamilyFeeRes, staffRes] = await Promise.allSettled([
        loadRateSettings(),
        loadCapacitySettings(),
        loadRatioSettings(),
        loadSummerCampSetting(),
        fetchSetting('reg_window_override'),
        fetchClosures(),
        fetchSetting('registration_fee'),
        fetchSetting('new_family_fee'),
        fetchPublicStaffDirectory(),
    ]);
    if (rateRes.status     === 'rejected') console.error('loadRateSettings failed:', rateRes.reason);
    if (capRes.status      === 'rejected') console.error('loadCapacitySettings failed:', capRes.reason);
    if (ratioRes.status    === 'rejected') console.error('loadRatioSettings failed:', ratioRes.reason);
    if (campRes.status     === 'rejected') console.error('loadSummerCampSetting failed:', campRes.reason);
    if (closuresRes.status === 'rejected') console.error('fetchClosures failed:', closuresRes.reason);
    if (regFeeRes.status   === 'rejected') console.error('fetchSetting(registration_fee) failed:', regFeeRes.reason);
    if (newFamilyFeeRes.status === 'rejected') console.error('fetchSetting(new_family_fee) failed:', newFamilyFeeRes.reason);
    if (staffRes.status    === 'rejected') console.error('fetchPublicStaffDirectory failed:', staffRes.reason);

    renderPublicRoomCards();
    renderFeeNotes(
        regFeeRes.status === 'fulfilled' ? regFeeRes.value : null,
        newFamilyFeeRes.status === 'fulfilled' ? newFamilyFeeRes.value : null
    );
    renderPublicStaffDirectory(staffRes.status === 'fulfilled' ? staffRes.value : null);

    regWindowOverride = (overrideRes.status === 'fulfilled' ? overrideRes.value : null) || 'auto';

    const closures = closuresRes.status === 'fulfilled' ? (closuresRes.value || []) : [];
    closureMap = new Map(closures.map(c => [c.close_date, { reason: c.reason || '', half: !!c.half_day }]));

    const win            = getRegistrationWindow();
    const targetMonthKey = getTargetMonthKey();

    currentDate = new Date(win.targetDate.getFullYear(), win.targetDate.getMonth(), 1);

    // Show window open/closed status — no "already submitted" check on load
    const banner = document.getElementById('regWindowBanner');
    if (banner) {
        if (win.mode === 'closed') {
            banner.className = 'reg-window-banner locked';
            if (regWindowOverride === 'closed') {
                banner.innerHTML = `🔒 Registration for <strong>${win.targetLabel}</strong> is currently closed — this month's space is full. To inquire about availability, <a href="mailto:mdo@timothystl.org">contact the office</a>.`;
            } else if (win.opensToday) {
                banner.innerHTML = `🕘 Registration for <strong>${win.targetLabel}</strong> opens today at <strong>9 AM Central time</strong>. Come back then!`;
            } else {
                banner.innerHTML = `🔒 Registration for <strong>${win.targetLabel}</strong> is currently closed. Deadline was <strong>${win.deadlineLabel}</strong>.`;
            }
        } else {
            banner.className = 'reg-window-banner open';
            if (regWindowOverride === 'open') {
                banner.innerHTML = `✅ Registration is still open for <strong>${win.targetLabel}</strong> — space is still available. Deadline: <strong>${win.deadlineLabel}</strong>.`;
            } else {
                banner.innerHTML = `📅 Now accepting registrations for <strong>${win.targetLabel}</strong>. Deadline: <strong>${win.deadlineLabel}</strong>.`;
            }
        }
    }

    const btn = document.getElementById('submitBtn');
    if (btn) {
        if (win.mode === 'closed') {
            btn.disabled    = true;
            btn.textContent = 'Registration Closed';
        } else {
            btn.disabled    = false;
            btn.textContent = 'Submit Registration';
        }
    }

    setupFamilyLookup();
    setupFormListeners();
    setupContactModal();
    setupForgotPinModal();

    // After the listeners are wired, so "Change" works the moment the bar
    // appears. Awaited rather than fired and forgotten: renderChildSection()
    // runs inside it, and letting it race the rest of init was how the child
    // list could paint before ROOMS had its admin rates merged in.
    await tryPortalSessionFamily();
});

// ============================================================
// PUBLIC ROOM INFO CARDS (classrooms section on the public page)
// ============================================================
// Capacity wording varies by room ("infants" / "toddlers" / "children").
// Everything else in the card (ages, rates, capacity, ratio) comes straight
// off ROOMS, which loadRateSettings()/loadCapacitySettings()/loadRatioSettings()
// merge admin-configured overrides into — so the cards always reflect what's
// actually saved in Settings, not a snapshot baked into the HTML.
const ROOM_CAPACITY_NOUNS = { bear: 'infants', bee: 'toddlers' };

// ⚠️ worker.js holds a byte-identical copy of this function so the classroom
// cards can be rendered server-side — see "SERVER-SIDE ROOM CARDS" there and the
// cross-file drift guard in js/tests/business-logic.test.js, which fails CI if
// the two stop matching. It is split out from the DOM write below precisely so
// the copy can be a pure string builder. Edit both, or edit neither.
function buildPublicRoomCardsHtml(rooms) {
    return rooms.map(room => {
        const spaceIdx = room.label.indexOf(' ');
        const emoji    = spaceIdx === -1 ? room.label : room.label.slice(0, spaceIdx);
        const name     = spaceIdx === -1 ? room.label : room.label.slice(spaceIdx + 1);
        const noun     = ROOM_CAPACITY_NOUNS[room.id] || 'children';
        const halfDayRow = (room.fullDayOnly || room.halfDayRate == null)
            ? `<div class="room-rate-row room-rate-note">Full Day Only</div>`
            : `<div class="room-rate-row"><span>Half Day</span><strong>$${room.halfDayRate}</strong></div>`;
        return `<div class="room-card"><div class="room-header"><span class="room-emoji">${escHtml(emoji)}</span><div class="room-name">${escHtml(name)}</div><div class="room-ages">${escHtml(room.ages || '')}</div></div><div class="room-body"><div class="room-rate-row"><span>Full Day</span><strong>$${room.fullDayRate}</strong></div>${halfDayRow}<div class="room-capacity">Max ${room.capacity ?? '—'} ${noun} · 1:${room.staffRatio ?? '—'} ratio</div></div></div>`;
    }).join('');
}

// Re-renders over whatever the worker already server-rendered into this grid.
// That is intentional and not wasted work: the server copy is what a crawler
// indexes, and this pass is what keeps a long-open tab honest if the director
// changes a rate mid-session.
function renderPublicRoomCards() {
    const grid = document.getElementById('roomInfoGrid');
    if (!grid) return;
    const rooms = getSortedRooms().filter(r => r.id !== 'summer' && !r.hidden);
    grid.innerHTML = buildPublicRoomCardsHtml(rooms);
}

// Fills in the annual registration fee note under the room cards and the
// summer camp daily fee mentioned in its promo box, both pulled from
// Settings so they stay in sync with what admin actually charges.
function renderFeeNotes(regFeeAmount, newFamilyFeeAmount) {
    const regEl = document.getElementById('regFeeNote');
    if (regEl) {
        const parts = [];
        if (typeof newFamilyFeeAmount === 'number' && newFamilyFeeAmount > 0) {
            parts.push(`a one-time new family fee of $${newFamilyFeeAmount.toFixed(2)}`);
        }
        if (typeof regFeeAmount === 'number' && regFeeAmount > 0) {
            parts.push(`an annual supply fee of $${regFeeAmount.toFixed(2)} per child`);
        }
        regEl.textContent = parts.length ? `Registration includes ${parts.join(' and ')}.` : '';
    }
    const summerEl = document.getElementById('summerDailyFeeNote');
    if (summerEl) {
        const summerRoom = ROOMS.find(r => r.id === 'summer');
        summerEl.innerHTML = summerRoom?.fullDayRate != null
            ? ` (<strong>$${summerRoom.fullDayRate}/day</strong>)`
            : '';
    }
}

// Renders the "Our Staff" section from the admin-managed staff_directory
// setting. Any active, non-hidden room with no assigned Lead Teacher gets
// an auto-generated "Coming Soon" placeholder card instead of being left
// out, so the lineup never silently goes stale (e.g. after a reassignment).
function renderPublicStaffDirectory(staffRaw) {
    const leadershipGrid = document.getElementById('staffLeadershipGrid');
    const teachersGrid   = document.getElementById('staffTeachersGrid');
    if (!leadershipGrid && !teachersGrid) return;

    const staff = Array.isArray(staffRaw) ? staffRaw : [];

    const staffCardHtml = (s, roomTag) => `<div class="staff-card${roomTag ? '' : ' staff-card--leadership'}">
        <div class="staff-card-photo">${s.photoUrl ? `<img src="${escHtml(s.photoUrl)}" alt="${escHtml(s.name || '')}">` : ''}</div>
        <div class="staff-card-name">${escHtml(s.name || '')}</div>
        <div class="staff-card-role">${escHtml(s.role || '')}</div>
        ${roomTag ? `<div class="staff-card-room">${roomTag}</div>` : ''}
    </div>`;

    if (leadershipGrid) {
        leadershipGrid.innerHTML = staff
            .filter(s => s.section !== 'lead_teacher')
            .map(s => staffCardHtml(s, null)).join('');
    }

    if (teachersGrid) {
        const byRoom = new Map();
        staff.filter(s => s.section === 'lead_teacher' && s.roomId).forEach(s => {
            if (!byRoom.has(s.roomId)) byRoom.set(s.roomId, []);
            byRoom.get(s.roomId).push(s);
        });
        const rooms = getSortedRooms().filter(r => r.id !== 'summer' && !r.hidden && r.status !== 'seasonal');
        teachersGrid.innerHTML = rooms.map(room => {
            const roomTag = `${escHtml(room.label)} · ${escHtml(room.ages || '')}`;
            const teachers = byRoom.get(room.id);
            if (teachers && teachers.length) {
                return teachers.map(s => staffCardHtml(s, roomTag)).join('');
            }
            const emoji = room.label.split(' ')[0] || '👤';
            return `<div class="staff-card staff-card--placeholder">
                <div class="staff-card-photo staff-card-photo--empty"><span class="staff-card-photo-icon">${escHtml(emoji)}</span></div>
                <div class="staff-card-name">Coming Soon</div>
                <div class="staff-card-role">Lead Teacher</div>
                <div class="staff-card-room">${roomTag}</div>
            </div>`;
        }).join('');
    }

    positionStaffPhotos();
}

// ============================================================
// AGE / DOB HELPERS
// ============================================================
// calcAgeMonths(), getRoomIdFromDob(), getRoomsFromDob(),
// fetchMostRecentRoomForChild() and fetchRoomFillForMonth() live in
// supabase.js (shared — loaded before this file on every page).
function getRoomFromDob(dobStr) {
    const roomId = getRoomIdFromDob(dobStr);
    return roomId ? (ROOMS.find(r => r.id === roomId) || null) : null;
}

// Synchronous room lookup: admin override first, else the single active room
// whose age range matches. When Settings → Rates puts more than one active
// room in the same age band (Turtle and Owl currently both cover 24–36mo),
// this returns only the first by ageMinMonths — same behavior as before this
// function existed. Callers that need the overlap actually split between the
// two rooms must use the async resolveRoomForStudent() below instead. This
// synchronous version stays for call sites that only need a fast/offline
// fallback (see resolveRoomForStudent's catch block).
function getRoomForStudent(student) {
    if (student.room_override) {
        const room = ROOMS.find(r => r.id === student.room_override);
        if (room) return room;
    }
    const candidates = getRoomsFromDob(student.child_dob || student.dob || null);
    return candidates[0] || null;
}

// Room assignment used at registration time. Identical to getRoomForStudent()
// except when a child's age matches MORE THAN ONE active room — currently
// only Turtle/Owl, which share a 24–36mo band in Settings → Rates. In that
// case it splits the two rooms by:
//   1. Continuity — if this child (matched by name, same convention as
//      checkExistingRegistrationByChild) was most recently enrolled in one of
//      the candidate rooms, keep them there. A returning child or a sibling
//      who's already settled into Turtle shouldn't bounce to Owl next month
//      just because Owl happens to have more open seats that month.
//   2. Balance — if there's no history in either room (first time in this age
//      band), assign to whichever candidate has more open seats — measured as
//      distinct enrolled children vs. capacity — for `monthKey`, so the two
//      rooms fill up roughly evenly over time rather than one saturating
//      while the other sits empty.
// `monthKey` is 'YYYY-MM' for the month being registered — pass the current
// registration window's target month.
// A lookup failure (network, RLS, anything) falls back to the synchronous
// single-match result — the split is a nice-to-have; it must never be able to
// block a registration from going through.
async function resolveRoomForStudent(student, monthKey) {
    if (student.room_override) {
        const room = ROOMS.find(r => r.id === student.room_override);
        if (room) return room;
    }
    const candidates = getRoomsFromDob(student.child_dob || student.dob || null);
    if (candidates.length <= 1) return candidates[0] || null;

    try {
        const childName = student.child_name || student.name || '';
        const candidateIds = candidates.map(r => r.id);

        const priorRoomId = await fetchMostRecentRoomForChild(childName, candidateIds);
        if (priorRoomId) {
            const prior = candidates.find(r => r.id === priorRoomId);
            if (prior) return prior;
        }

        const fill = await fetchRoomFillForMonth(candidateIds, monthKey);
        let best = candidates[0], bestRatio = Infinity;
        for (const room of candidates) {
            const used  = fill[room.id] || 0;
            const ratio = room.capacity ? used / room.capacity : used;
            if (ratio < bestRatio) { bestRatio = ratio; best = room; }
        }
        return best;
    } catch (err) {
        console.warn('resolveRoomForStudent: overlap resolution failed, using default match —', err.message);
        return candidates[0];
    }
}


// ============================================================
// FAMILY LOOKUP  (Item 9)
// ============================================================
function setupFamilyLookup() {
    const emailInput = document.getElementById('familyEmailInput');
    const pinInput   = document.getElementById('familyPinInput');
    const pinBtn     = document.getElementById('familyPinBtn');

    emailInput?.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); runEmailPinLookup(); }
    });
    pinInput?.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); runEmailPinLookup(); }
    });
    pinBtn?.addEventListener('click', runEmailPinLookup);

    document.getElementById('changeFamilyBtn')?.addEventListener('click', resetFamilyLookup);
}

// Set on a successful family lookup, cleared when the family is reset.
// Null on the portal-session path — there is no PIN in the browser there, and
// loadSiblingBookedDays() reads _viaPortalSession instead.
let _familyAuth = null;

// True when the family came from a /parent session rather than email + PIN.
let _viaPortalSession = false;

// A parent who signed in at /parent already proved who they are. Rather than
// asking for the same email and PIN a second time, adopt that session: the
// family comes from parent_accounts via the JWT, exactly the way every parent
// RLS policy resolves it.
//
// Silent by design. No session, an expired one, or an admin who is not a parent
// all return null, and the email + PIN form stays exactly as it was — this is a
// shortcut for people who have one, never a gate for people who don't.
async function tryPortalSessionFamily() {
    if (typeof fetchFamilyForSession !== 'function') return false;

    const result = await fetchFamilyForSession();
    if (!result?.family) return false;

    // selectFamily() bails on a locked family with its own toast. Let it, but
    // don't claim the session path worked — the PIN form is no better here, so
    // the parent still needs to see why nothing happened.
    _viaPortalSession = true;
    _familySessionToken = await parentSessionToken();
    selectFamily(result.family, result.isParent2);

    if (!selectedFamily) { _viaPortalSession = false; return false; }

    // Say whose session this is. A shared phone is the case that matters: the
    // "Change" button beside it is how you get out, and it must not look like
    // the form simply skipped a step.
    // Hide the email and PIN inputs outright. Leaving an empty PIN box sitting
    // above "Signed in as ..." still reads as being asked, which is the whole
    // complaint — the bar alone is not enough.
    document.querySelector('.lookup-section')?.classList.add('lookup-via-session');

    const bar = document.querySelector('#familySelectedBar .family-selected-name');
    if (bar) {
        const who = result.isParent2
            ? (result.family.parent2_name || result.family.parent_name)
            : result.family.parent_name;
        bar.textContent = who ? `Signed in as ${who}` : 'Signed in from your portal';
    }
    return true;
}

async function runEmailPinLookup() {
    const email  = document.getElementById('familyEmailInput')?.value.trim();
    const pin    = document.getElementById('familyPinInput')?.value.trim();
    const pinBtn = document.getElementById('familyPinBtn');

    if (!email || !email.includes('@')) { showToast('Please enter your email address.'); return; }
    if (!pin || pin.length !== 4) { showToast('Please enter your 4-digit family PIN.'); return; }
    if (pinBtn) { pinBtn.textContent = 'Looking up…'; pinBtn.disabled = true; }
    try {
        const result = await lookupFamilyForRegistration(email, pin);
        if (result && result.error === 'login_locked') {
            showToast('This account has been locked. Please contact the office to regain access.');
            return;
        }
        if (!result) {
            showToast('No family found matching that email and PIN. Please contact the office if you need help.');
            return;
        }
        _familySessionToken = result.sessionToken ?? null;
        _viaPortalSession   = false;   // this family came from a PIN, not a session
        // R1: the sibling-booked-days read is PIN-gated server-side now. Hold
        // the credential the parent just authenticated with for this session
        // only — it is never persisted, and clearing the family clears it.
        _familyAuth = { email, pin };
        selectFamily(result.family, result.isParent2);
    } catch {
        showToast('Lookup failed. Please try again.');
    } finally {
        if (pinBtn) { pinBtn.textContent = 'Find My Family'; pinBtn.disabled = false; }
    }
}


function selectFamily(family, isParent2 = false) {
    _isParent2 = isParent2;

    // Check if registration is locked for nonpayment
    if (family.registration_locked) {
        showToast('Registration is currently unavailable for this family. Please contact the office to resolve your account balance.');
        return;
    }

    // Reset any state from a previous family lookup
    selectedChildren = [];
    childSchedules   = new Map();
    activeChildId    = null;
    capacityCache    = {};
    closeDayPicker();
    hideCalendar();

    selectedFamily = family;

    // Prefill with the authenticated parent's contact info
    const useParent2 = isParent2 && (family.parent2_name || family.parent2_email);
    const prefillName  = useParent2 ? (family.parent2_name  || family.parent_name)  : family.parent_name;
    const prefillEmail = useParent2 ? (family.parent2_email || family.parent_email) : family.parent_email;
    const prefillPhone = useParent2 ? (family.parent2_phone || family.parent_phone) : family.parent_phone;

    setPrefilled('parentName',  prefillName);
    setPrefilled('parentEmail', prefillEmail);
    setPrefilled('parentPhone', prefillPhone);

    document.getElementById('familySelectedBar')?.classList.remove('hidden');
    document.getElementById('lookupRequiredMsg')?.classList.add('hidden');
    document.getElementById('registrationSteps')?.classList.remove('hidden');

    // Offer push notifications now that we know the family's UUID
    if (typeof initPushNotifications === 'function') {
        initPushNotifications(family.id, _familySessionToken);
    }

    renderChildSection();
}

function resetFamilyLookup() {
    // "Change" on the portal path means "this is not my account" — most likely
    // on a shared phone. Ending the portal session too is the only honest
    // reading: leaving it alive would re-adopt the same family on the next
    // reload, and the button would look broken.
    if (_viaPortalSession && typeof parentPortalLogout === 'function') {
        parentPortalLogout().catch(() => {});
    }
    _viaPortalSession   = false;
    _familyAuth         = null;
    // Put the email and PIN inputs back — "Change" has to land on a form the
    // parent can actually use.
    document.querySelector('.lookup-section')?.classList.remove('lookup-via-session');
    selectedFamily      = null;
    _familySessionToken = null;
    _isParent2          = false;
    selectedChildren    = [];
    studentDataMap.clear();

    const emailInput = document.getElementById('familyEmailInput');
    const pinInput   = document.getElementById('familyPinInput');
    if (emailInput)  emailInput.value  = '';
    if (pinInput)    pinInput.value    = '';
    document.getElementById('familySelectedBar')?.classList.add('hidden');

    document.getElementById('lookupRequiredMsg')?.classList.remove('hidden');
    document.getElementById('registrationSteps')?.classList.add('hidden');

    clearPrefilled('parentName');
    clearPrefilled('parentEmail');
    clearPrefilled('parentPhone');

    hideCalendar();
    childSchedules = new Map();
    activeChildId  = null;
}

function setPrefilled(id, value) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value    = value || '';
    el.readOnly = true;
    el.classList.add('prefilled');
}

function clearPrefilled(id) {
    const el = document.getElementById(id);
    if (!el) return;
    el.value    = '';
    el.readOnly = false;
    el.classList.remove('prefilled');
}

// ============================================================
// CHILD SECTION  (existing family children only, with room override)
// ============================================================
async function renderChildSection() {
    const section = document.getElementById('childSection');
    if (!section) return;

    const students = (selectedFamily?.students || []);

    if (!students.length) {
        section.innerHTML = '<p class="child-empty-msg">No children found for this family. Please contact the office to update your records.</p>';
        return;
    }

    // Store sensitive fields in JS memory, not in DOM attributes
    students.forEach(s => {
        studentDataMap.set(String(s.id), {
            dob:           s.child_dob || '',
            roomOverride:  s.room_override || '',
            discountType:  s.discount_type  || 'none',
            discountValue: parseFloat(s.discount_value || 0),
        });
    });

    // Resolve each student's room up front. resolveRoomForStudent() is only
    // actually async for the rare Turtle/Owl-style overlap case (a DB lookup
    // to decide between them) — every other student resolves instantly. Doing
    // this here, once, keeps the checkbox handler below fully synchronous.
    const { targetDate } = getRegistrationWindow();
    const monthKey = `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}`;
    await Promise.all(students.map(async s => {
        const room = await resolveRoomForStudent(
            { child_dob: s.child_dob, room_override: s.room_override, child_name: s.child_name },
            monthKey
        );
        const sd = studentDataMap.get(String(s.id)) || {};
        sd.resolvedRoom = room;
        studentDataMap.set(String(s.id), sd);
    }));

    section.innerHTML = `
        <div class="child-cards-row">
            ${students.map(s => {
                const room       = studentDataMap.get(String(s.id))?.resolvedRoom || getRoomForStudent(s);
                const isSelected = selectedChildren.some(c => c.studentId === s.id);
                const recurDays = Array.isArray(s.recurring_days) ? s.recurring_days.join(',') : '';
                return `<label class="child-card-label${isSelected ? ' selected' : ''}" data-student-id="${s.id}">
                    <input type="checkbox" class="child-card-checkbox"
                           data-student-id="${s.id}"
                           data-name="${escHtml(s.child_name)}"
                           data-recurring-days="${escHtml(recurDays)}"
                           ${isSelected ? 'checked' : ''}>
                    <span class="child-card-name">${escHtml(s.child_name.split(' ')[0])}</span>
                    ${room ? `<span class="child-card-room">${escHtml(room.label)}</span>` : ''}
                    ${recurDays ? `<span class="child-card-recurring" title="Recurring days: ${escHtml(recurDays.replace(/,/g,', '))}">🔁 ${escHtml(recurDays.replace(/,/g,', '))}</span>` : ''}
                </label>`;
            }).join('')}
        </div>`;

    section.querySelectorAll('.child-card-checkbox').forEach(cb => {
        cb.addEventListener('change', () => {
            const studentId    = cb.dataset.studentId;
            const childName    = cb.dataset.name;
            const sd           = studentDataMap.get(studentId) || {};
            const childDob     = sd.dob || '';
            const roomOverride = sd.roomOverride || null;
            // Use the room already resolved in the precompute pass above (this
            // is what actually applies the Turtle/Owl continuity-then-balance
            // split) — fall back to the synchronous single-match lookup only
            // if the precompute is somehow missing (e.g. the map was cleared
            // between render and click).
            const room = sd.resolvedRoom || getRoomForStudent({ child_dob: childDob, room_override: roomOverride });
            if (!room) {
                cb.checked = false;
                showToast(`Could not assign a room for ${childName} — please check their date of birth.`);
                return;
            }
            cb.closest('.child-card-label').classList.toggle('selected', cb.checked);
            if (cb.checked) {
                // Multiple children can be added in one session — each keeps their own
                // independent care-day schedule (childSchedules, keyed per studentId), so
                // adding a second child never touches the first child's day picks.
                if (!selectedChildren.some(c => c.studentId === studentId)) {
                    const rdRaw = cb.dataset.recurringDays || '';
                    selectedChildren.push({
                        name: childName, dob: childDob, room, isNew: false, studentId,
                        discountType:  sd.discountType  || 'none',
                        discountValue: sd.discountValue || 0,
                        recurringDays: rdRaw ? rdRaw.split(',').filter(Boolean) : [],
                    });
                    activeChildId = studentId;
                    onChildrenChanged();
                    // Non-blocking: warn if already registered for the target month.
                    // Checks by this parent's email first, then by child name (catches parent 2).
                    const monthKey = getTargetMonthKey();
                    const email    = selectedFamily?.parent_email;
                    Promise.all([
                        email ? checkExistingRegistration(email, monthKey, childName) : Promise.resolve(null),
                        checkExistingRegistrationByChild(monthKey, childName),
                    ]).then(([byEmail, byChild]) => {
                        if (byEmail || byChild) {
                            const { targetLabel } = getRegistrationWindow();
                            showToast(`⚠️ ${childName} may already be registered for ${targetLabel}. Verify before submitting.`);
                        }
                    }).catch(() => {});
                }
            } else {
                const idx = selectedChildren.findIndex(c => c.studentId === studentId);
                if (idx !== -1) selectedChildren.splice(idx, 1);
                childSchedules.delete(studentId);
                if (activeChildId === studentId) {
                    activeChildId = selectedChildren[0]?.studentId || null;
                }
                onChildrenChanged();
            }
        });
    });
}

async function onChildrenChanged() {
    // A day-picker popup/backdrop left open from a previous selection would
    // otherwise stay stuck on screen (full-page dark overlay, intercepting
    // clicks) once the child selection changes and the calendar re-renders.
    closeDayPicker();
    capacityCache = {};

    // Refresh which siblings are already booked before anything prices a day —
    // the set changes as children are added to or removed from this session.
    await loadSiblingBookedDays();

    if (!selectedChildren.length) {
        activeChildId = null;
        hideCalendar();
        renderChildTabs();
        renderSelectedDates();
        return;
    }

    if (!activeChildId || !selectedChildren.some(c => c.studentId === activeChildId)) {
        activeChildId = selectedChildren[0].studentId;
    }

    // Pre-populate recurring days into each child's OWN schedule — only the first
    // time a child is added this session, so it never overwrites picks already made.
    const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const { targetDate } = getRegistrationWindow();
    const yr = targetDate.getFullYear(), mo = targetDate.getMonth();
    const daysInMonth = new Date(yr, mo + 1, 0).getDate();
    for (const child of selectedChildren) {
        if (childSchedules.has(child.studentId)) continue;
        const sched     = new Map();
        const recurring = new Set(child.recurringDays || []);
        if (recurring.size) {
            for (let day = 1; day <= daysInMonth; day++) {
                const d   = new Date(yr, mo, day);
                const dow = DOW_NAMES[d.getDay()];
                if (recurring.has(dow)) {
                    const dateStr = `${yr}-${String(mo+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
                    // A full closure on a recurring day means no care at all — don't
                    // lock the child into a day that can't happen. A half-day closure
                    // still happens, just morning-only, so lock it in as 'half' rather
                    // than the usual 'full' (which would silently over-book and over-bill).
                    const closureEntry = closureMap.get(dateStr);
                    if (closureEntry && !closureEntry.half) continue;
                    const dayType = closureEntry?.half ? 'half' : 'full';
                    sched.set(dateStr, { dayType, locked: true });
                }
            }
        }
        childSchedules.set(child.studentId, sched);
    }

    document.getElementById('calendarWrapper')?.classList.remove('hidden');
    document.getElementById('calendarHint')?.classList.add('hidden');
    renderChildTabs();
    await loadMonthCapacity();
    renderCalendar();
    renderSelectedDates();
}

function hideCalendar() {
    document.getElementById('calendarWrapper')?.classList.add('hidden');
    document.getElementById('calendarHint')?.classList.remove('hidden');
}

// Shows a tab per added child so the parent can switch whose calendar they're
// editing — only rendered once a second child is added.
function renderChildTabs() {
    const container = document.getElementById('childTabs');
    if (!container) return;
    if (selectedChildren.length <= 1) {
        container.innerHTML = '';
        container.classList.add('hidden');
        return;
    }
    container.classList.remove('hidden');
    container.innerHTML = selectedChildren.map(c => {
        const dayCount = childSchedules.get(c.studentId)?.size || 0;
        const isActive = c.studentId === activeChildId;
        return `<button type="button" class="child-tab${isActive ? ' active' : ''}" data-student-id="${c.studentId}">
            ${escHtml(c.name.split(' ')[0])}
            <span class="child-tab-count">${dayCount} day${dayCount !== 1 ? 's' : ''}</span>
        </button>`;
    }).join('');
    container.querySelectorAll('.child-tab').forEach(btn => {
        btn.addEventListener('click', () => {
            activeChildId = btn.getAttribute('data-student-id');
            closeDayPicker();
            renderChildTabs();
            renderCalendar();
            renderSelectedDates();
        });
    });
}

// ============================================================
// CAPACITY  (multi-room aware)
// ============================================================
async function loadMonthCapacity() {
    if (!selectedChildren.length) return;
    calendarLoading = true;
    const year  = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const days  = new Date(year, month + 1, 0).getDate();

    const dates = [];
    for (let d = 1; d <= days; d++) {
        const date = new Date(year, month, d);
        const dow  = date.getDay();
        if (dow !== 0 && dow !== 6) dates.push(formatDate(date));
    }

    const distinctRooms = [...new Set(selectedChildren.map(c => c.room.id))];
    capacityCache = {};
    for (const roomId of distinctRooms) {
        capacityCache[roomId] = await fetchCapacityForDates(roomId, dates);
    }
    calendarLoading = false;
}

// How many OTHER selected children already have this exact date booked in the
// same room (e.g. siblings sharing a room) — they occupy a spot too, on top of
// whatever the live capacityCache count (from already-submitted registrations) shows.
function othersScheduledSameRoom(dateStr, room) {
    let count = 0;
    for (const other of selectedChildren) {
        if (other.studentId === activeChildId) continue;
        if (other.room.id !== room.id) continue;
        if (childSchedules.get(other.studentId)?.has(dateStr)) count++;
    }
    return count;
}

function getDateStatus(dateStr) {
    const child = activeChild();
    if (!child) return 'disabled';
    const room      = child.room;
    const booked    = (capacityCache[room.id] || {})[dateStr] || 0;
    const available = (room.capacity || 0) - booked - othersScheduledSameRoom(dateStr, room);
    if (available < 1)     return 'full';
    if (available - 1 < 3) return 'limited';
    return 'available';
}

function spotsLeft(dateStr) {
    const child = activeChild();
    if (!child) return 0;
    const room      = child.room;
    const booked    = (capacityCache[room.id] || {})[dateStr] || 0;
    return Math.max(0, (room.capacity || 0) - booked - othersScheduledSameRoom(dateStr, room));
}

// ============================================================
// CALENDAR — Mon–Fri only; closed and full days are not clickable
// ============================================================
function renderCalendar() {
    const year        = currentDate.getFullYear();
    const month       = currentDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today       = new Date(); today.setHours(0, 0, 0, 0);
    const firstDow    = new Date(year, month, 1).getDay();

    document.getElementById('currentMonthLabel').textContent = `${MONTH_NAMES[month]} ${year}`;

    const win      = getRegistrationWindow();
    const target   = win.targetDate;
    const atTarget = (year === target.getFullYear() && month === target.getMonth());
    const prevBtn  = document.getElementById('prevMonth');
    const nextBtn  = document.getElementById('nextMonth');
    if (prevBtn) prevBtn.disabled = atTarget;
    if (nextBtn) nextBtn.disabled = atTarget;

    const cal = document.getElementById('calendar');
    cal.innerHTML = '';

    DAY_HEADERS_MF.forEach(h => {
        const el = document.createElement('div');
        el.className   = 'cal-header';
        el.textContent = h;
        cal.appendChild(el);
    });

    const leadingBlanks = (firstDow >= 1 && firstDow <= 5) ? firstDow - 1 : 0;
    for (let i = 0; i < leadingBlanks; i++) {
        const el = document.createElement('div');
        el.className = 'cal-day empty';
        cal.appendChild(el);
    }

    for (let d = 1; d <= daysInMonth; d++) {
        const date    = new Date(year, month, d);
        const dow     = date.getDay();
        if (dow === 0 || dow === 6) continue;

        const dateStr       = formatDate(date);
        const isPast        = date < today;
        const closureEntry  = closureMap.get(dateStr);
        // A half-day closure ("Close at 1 pm") isn't a blocked day — the center is
        // still open in the morning, so it's priced/selected like any other open day,
        // just forced to a half-day booking (see showDayPicker). Only a full closure
        // takes the day off the board entirely.
        const isClosed      = !!closureEntry && !closureEntry.half;
        const isHalfClosure = !!closureEntry && closureEntry.half;
        const entry        = activeSchedule().get(dateStr);
        const isSelected   = !!entry;
        const isPickerOpen = pickerOpenDate === dateStr;

        let status;
        if (isPast)        status = 'past';
        else if (isClosed) status = 'closed';
        else               status = getDateStatus(dateStr);

        const cell = document.createElement('div');
        const isLocked = isSelected && entry?.locked;
        // Half days get their own class so they read differently at a glance.
        // Both used to render identical navy, so a parent could only tell a half
        // day from a full one by reading the small badge — two parents got it
        // wrong and had to have their bookings redone by the office.
        const isHalf = isSelected && !isLocked && entry?.dayType === 'half';
        cell.className = `cal-day ${status}${isSelected ? ' selected' : ''}${isHalf ? ' selected-half' : ''}${isLocked ? ' recurring-locked' : ''}${isPickerOpen ? ' picker-active' : ''}`;
        cell.setAttribute('data-date', dateStr);

        let badge = '';
        if (isSelected && entry) {
            badge = isLocked
                ? '<span class="selected-type-badge recurring-badge">🔁 Recurring</span>'
                : (entry.dayType === 'half'
                    ? '<span class="selected-type-badge">½ day</span>'
                    : '<span class="selected-type-badge">Full</span>');
        } else if (isClosed) {
            const reason = closureEntry.reason;
            badge = `<span class="spot-badge closed-badge">Closed</span>${reason ? `<span class="closed-reason">${escHtml(reason)}</span>` : ''}`;
        } else if (isHalfClosure && !isPast && status !== 'full') {
            const reason = closureEntry.reason;
            badge = `<span class="spot-badge half-closure-badge">Half day only</span>${reason ? `<span class="closed-reason">${escHtml(reason)}</span>` : ''}`;
        } else if (!isPast && status === 'full') {
            badge = '<span class="spot-badge full-badge">Full</span>';
        } else if (!isPast && (status === 'limited' || status === 'available')) {
            // Show spots remaining on all open days so parents can plan ahead
            const spots = spotsLeft(dateStr);
            if (spots > 0) {
                const cls = status === 'limited' ? 'limited-badge' : 'available-badge';
                badge = `<span class="spot-badge ${cls}">${spots} left</span>`;
            }
        }

        cell.innerHTML = `<span class="day-num">${d}</span>${badge}`;

        // Only add click handler for available/limited dates (full treated same as closed)
        if (!isPast && !isClosed && status !== 'full') {
            cell.addEventListener('click', (e) => {
                e.stopPropagation();
                handleDayClick(dateStr, status, cell);
            });
        } else if (!isPast) {
            // Blocked days (closed/full) still get a tap handler so the tap isn't
            // silently ignored — parents on mobile reported taps "not working" when
            // really the day just isn't selectable.
            cell.addEventListener('click', (e) => {
                e.stopPropagation();
                showToast(isClosed ? 'This day is closed — no care available.' : 'This day is full — no spots remaining.');
            });
        }

        cal.appendChild(cell);
    }
}

// ============================================================
// DAY PICKER POPUP
// ============================================================
function handleDayClick(dateStr, status, cellEl) {
    const child = activeChild();
    if (!child) return;
    const sched = childSchedules.get(child.studentId);

    if (sched.has(dateStr)) {
        if (sched.get(dateStr)?.locked) {
            showToast('This is one of your recurring days and can\'t be removed here — contact the office to change your recurring schedule.');
            return;
        }
        sched.delete(dateStr);
        closeDayPicker();
        renderCalendar();
        renderChildTabs();
        renderSelectedDates();
        return;
    }

    showDayPicker(dateStr, cellEl);
}

function showDayPicker(dateStr, cellEl) {
    closeDayPicker();
    pickerOpenDate = dateStr;
    renderCalendar();

    const child = activeChild();
    if (!child) return;

    const backdrop = document.createElement('div');
    backdrop.id        = 'dayPickerBackdrop';
    backdrop.className = 'day-picker-backdrop';
    backdrop.addEventListener('click', e => {
        e.stopPropagation();
        closeDayPicker();
        renderCalendar();
    });
    document.body.appendChild(backdrop);

    const hasHalf = !child.room.fullDayOnly;
    // A half-day closure ("Close at 1 pm") means the center isn't open for a
    // full day at all — the picker should only ever offer Half Day, never let
    // a parent book (and get billed for) a full day that can't happen.
    const forcedHalf = !!closureMap.get(dateStr)?.half;

    const childNote = selectedChildren.length > 1
        ? `<p class="picker-subtitle">For ${escHtml(child.name.split(' ')[0])}</p>`
        : '';
    const closureNote = forcedHalf
        ? `<p class="picker-subtitle">${escHtml(closureMap.get(dateStr).reason || 'The center closes early this day')} — morning care only</p>`
        : '';

    const popup = document.createElement('div');
    popup.id        = 'dayPickerPopup';
    popup.className = 'day-picker-popup';
    popup.innerHTML = `
        <p class="picker-title">${friendlyDate(dateStr)}</p>
        ${childNote}
        ${closureNote}
        <div class="picker-buttons">
            ${forcedHalf ? '' : `<button type="button" class="picker-btn" data-date="${dateStr}" data-type="full">
                <span class="picker-label">Full Day</span>
                <span class="picker-rate">${formatChildRate(child, 'full')}</span>
            </button>`}
            ${hasHalf ? `<button type="button" class="picker-btn" data-date="${dateStr}" data-type="half">
                <span class="picker-label">Half Day</span>
                <span class="picker-rate">${formatChildRate(child, 'half')}</span>
            </button>` : `<div class="picker-btn picker-btn-disabled" title="This room is full-day only">
                <span class="picker-label">Half Day</span>
                <span class="picker-rate">Not available for this room</span>
            </div>`}
        </div>
        <button type="button" class="picker-cancel">✕ Cancel</button>
    `;

    document.body.appendChild(popup);
    // Positioning (fixed, viewport-centered) lives in .day-picker-popup CSS.

    popup.querySelectorAll('.picker-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            childSchedules.get(activeChildId).set(btn.getAttribute('data-date'), {
                dayType: btn.getAttribute('data-type'),
            });
            closeDayPicker();
            renderCalendar();
            renderChildTabs();
            renderSelectedDates();
        });
    });

    popup.querySelector('.picker-cancel').addEventListener('click', e => {
        e.stopPropagation();
        closeDayPicker();
        renderCalendar();
    });

    setTimeout(() => document.addEventListener('click', outsideClickHandler), 0);
}

function closeDayPicker() {
    document.getElementById('dayPickerPopup')?.remove();
    document.getElementById('dayPickerBackdrop')?.remove();
    pickerOpenDate = null;
    document.removeEventListener('click', outsideClickHandler);
}

function outsideClickHandler(e) {
    if (!document.getElementById('dayPickerPopup')?.contains(e.target)) {
        pickerOpenDate = null;
        closeDayPicker();
        renderCalendar();
    }
}

// ============================================================
// DISCOUNT HELPERS
// ============================================================
// Returns the discounted rate for one child on one day.
// discountType: 'none' | 'staff' | 'custom'
// discountValue: percentage (0–100)
function effectiveRate(baseRate, discountType, discountValue) {
    if (!baseRate) return 0;
    if (discountType === 'staff') return 0;
    if (discountType === 'custom' && discountValue > 0)
        return Math.round(baseRate * (1 - discountValue / 100) * 100) / 100;
    return baseRate;
}

// Returns an HTML string showing the discounted rate with an inline note.
function formatChildRate(child, dayType) {
    const effectiveDayType = child.room.fullDayOnly ? 'full' : dayType;
    const base = effectiveDayType === 'half' ? (child.room.halfDayRate || 0) : (child.room.fullDayRate || 0);
    const rate = effectiveRate(base, child.discountType, child.discountValue);
    if (child.discountType === 'staff')
        return `$0<span class="disc-note"> (staff)</span>`;
    if (child.discountType === 'custom' && child.discountValue > 0)
        return `$${rate}<span class="disc-note"> (${child.discountValue}% off)</span>`;
    return `$${rate}`;
}

// ============================================================
// SELECTED DATES + BILLING TOTAL (per-child schedules, combined into one invoice)
// ============================================================

// Returns the ISO date string for the Monday of the week containing dateStr
function getWeekMonday(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const dow = d.getDay(); // 0=Sun … 6=Sat
    const toMon = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(d);
    mon.setDate(d.getDate() + toMon);
    return mon.toISOString().slice(0, 10);
}

// Every child (from the given set) who has this specific date in their OWN schedule.
function childrenScheduledOn(dateStr, children = selectedChildren) {
    return children.filter(c => childSchedules.get(c.studentId)?.has(dateStr));
}

// ── Siblings already booked for the target month ─────────────
// The $10 sibling discount is a family-level, per-day perk, but this session
// only knows about children picked in THIS session. A parent registering a
// second child a week after the first therefore looked like a family of one
// and saw no discount, while the invoice — which computes per family in the
// database — applied it. The quote and the bill disagreed.
//
// dateStr → [{ childName, eff, hasIndividualDiscount }] for the family's other
// children whose days are already booked for the target month.
let siblingBookedDays = new Map();

async function loadSiblingBookedDays() {
    siblingBookedDays = new Map();
    const fam = selectedFamily;
    if (!fam || typeof fetchRegistrationsByEmail !== 'function') return;

    const monthKey  = getTargetMonthKey();
    const inSession = new Set(selectedChildren.map(c => (c.name || '').toLowerCase()));

    try {
        // One call either way: both RPCs return the whole family's
        // registrations, both parents included, in the same shape — so there is
        // nothing to merge or de-duplicate, and nothing below branches.
        //
        // The portal path has no PIN to pass; my_family_registrations() reads
        // the family off the session instead. Without this branch a parent who
        // came from /parent would silently lose the sibling discount from their
        // quote — the invoice is recomputed server-side and would still be
        // right, so the only symptom would be a quote higher than the bill.
        let results;
        if (_viaPortalSession && typeof fetchRegistrationsForSession === 'function') {
            results = await fetchRegistrationsForSession();
        } else if (_familyAuth) {
            results = await fetchRegistrationsByEmail(_familyAuth.email, _familyAuth.pin);
        } else {
            return;   // not authenticated — quote stays session-only
        }

        for (const reg of results) {
            if (reg.status && reg.status !== 'confirmed') continue;

            const nameKey = (reg.child_name || '').toLowerCase();
            if (inSession.has(nameKey)) continue;   // this child's days come from the picker, not here

            const room = ROOMS.find(r => r.id === reg.room_id);
            if (!room) continue;

            const student = (fam.students || []).find(s =>
                (s.child_name || '').toLowerCase() === nameKey);
            const dType = student?.discount_type  || 'none';
            const dVal  = parseFloat(student?.discount_value || 0);
            const hasIndividualDiscount = dType === 'staff' || (dType === 'custom' && dVal > 0);

            for (const d of reg.registration_dates || []) {
                if (d.waitlisted || !d.care_date) continue;
                if (!String(d.care_date).startsWith(monthKey)) continue;
                const base = (!room.fullDayOnly && d.day_type === 'half')
                    ? (room.halfDayRate || 0) : (room.fullDayRate || 0);
                if (!siblingBookedDays.has(d.care_date)) siblingBookedDays.set(d.care_date, []);
                siblingBookedDays.get(d.care_date).push({
                    childName: reg.child_name,
                    eff:       effectiveRate(base, dType, dVal),
                    hasIndividualDiscount,
                });
            }
        }
    } catch (err) {
        // Never block registration on this — worst case the quote reverts to
        // session-only pricing, which is what it did before.
        console.warn('loadSiblingBookedDays:', err);
    }
}

/**
 * Per-day billing breakdown for one calendar date, applying both discount layers:
 *   1. Each child's individual discount (staff = free, custom = % off).
 *   2. Sibling discount — $10/day off the lower-rate child, but this is a
 *      FAMILY-level "you have a sibling in care" perk, not a per-child one. If
 *      any child present that day already has their own individual discount,
 *      the family already has a discount that day — the sibling discount does
 *      not also apply on top of it, to that child OR to their sibling. It only
 *      applies among a group where nobody present has an individual discount.
 * @param {string} dateStr
 * @param {Array} [children=selectedChildren]
 * @param {Set<string>} [excludeStudentIds] — children already billed via weekly rate this date
 * @returns {Array<{child, dayType, preMulti, multiDiscount, finalAmount}>}
 */
function getChildDayAmounts(dateStr, children = selectedChildren, excludeStudentIds = new Set()) {
    const dayChildren = childrenScheduledOn(dateStr, children).filter(c => !excludeStudentIds.has(c.studentId));
    const entries = dayChildren.map(c => {
        const entry = childSchedules.get(c.studentId).get(dateStr);
        const effectiveDayType = c.room.fullDayOnly ? 'full' : entry.dayType;
        const base = effectiveDayType === 'half' ? (c.room.halfDayRate || 0) : (c.room.fullDayRate || 0);
        const hasIndividualDiscount = c.discountType === 'staff' || (c.discountType === 'custom' && c.discountValue > 0);
        return { child: c, dayType: entry.dayType, eff: effectiveRate(base, c.discountType, c.discountValue), hasIndividualDiscount };
    });

    // If anyone present has an individual discount, the sibling discount is off
    // for the whole group that day — otherwise the highest-rate child pays full
    // and everyone else gets $10 off, same as always.
    //
    // "Present that day" includes siblings whose days were booked in an EARLIER
    // session (see loadSiblingBookedDays), because the discount is a family
    // perk and the invoice computes it per family. Ranking against only this
    // session's children is what made the quote disagree with the bill.
    const booked = siblingBookedDays.get(dateStr) || [];
    const headcount = entries.length + booked.length;

    const anyIndividualDiscount = entries.some(e => e.hasIndividualDiscount)
                               || booked.some(b => b.hasIndividualDiscount);

    const ranked = [
        ...entries.map(e => ({ key: e.child.studentId, eff: e.eff })),
        ...booked.map((b, i) => ({ key: `booked:${b.childName}:${i}`, eff: b.eff })),
    ].sort((a, b) => b.eff - a.eff);

    const discountedIds = new Set(
        (headcount < 2 || anyIndividualDiscount) ? [] : ranked.slice(1).map(e => e.key)
    );

    return entries.map(entry => {
        const gets = discountedIds.has(entry.child.studentId);
        return {
            child:         entry.child,
            dayType:       entry.dayType,
            preMulti:      entry.eff,               // rate after individual discount
            multiDiscount: gets ? Math.min(10, entry.eff) : 0,
            finalAmount:   Math.max(0, entry.eff - (gets ? 10 : 0)),
        };
    });
}

/**
 * Finds the weeks (Mon–Fri) in ONE child's own schedule where all 5 weekdays are
 * booked with the same day type and their room has a weekly rate — those weeks bill
 * at the flat weekly rate (with the child's own discount) instead of per-day.
 * Weekly rate is evaluated per child individually: siblings may not share the exact
 * same full week, so the sibling discount doesn't stack on top of a weekly rate.
 * @returns {Map<string, {dayType, dates: string[], weeklyAmount: number}>} weekMonday -> info
 */
function getChildWeeklyWeeks(child) {
    const sched = childSchedules.get(child.studentId) || new Map();
    const byWeek = new Map();
    for (const [dateStr, entry] of sched) {
        const wk = getWeekMonday(dateStr);
        if (!byWeek.has(wk)) byWeek.set(wk, []);
        byWeek.get(wk).push({ dateStr, dayType: entry.dayType });
    }
    const weeks = new Map();
    for (const [wk, days] of byWeek) {
        if (days.length !== 5) continue;
        const allFull = days.every(d => d.dayType === 'full');
        const allHalf = days.every(d => d.dayType === 'half');
        if (!allFull && !allHalf) continue;
        const weeklyRate = allFull ? child.room.weeklyFullRate : child.room.weeklyHalfRate;
        if (weeklyRate == null) continue;
        weeks.set(wk, {
            dayType:      allFull ? 'full' : 'half',
            dates:        days.map(d => d.dateStr).sort(),
            weeklyAmount: effectiveRate(weeklyRate, child.discountType, child.discountValue),
        });
    }
    return weeks;
}

/**
 * Full itemized billing breakdown across every given child's own independent
 * schedule — this is the single source of truth used both for the live "Estimated
 * total" preview and the final invoice/receipt, so the two can never disagree.
 * @param {Array} [children=selectedChildren]
 * @returns {{ weeklyRows: Array<{child, dayType, dates, weeklyAmount}>, dailyRows: Array<{child, date, dayType, multiDiscount, amount}>, total: number }}
 */
function buildBillingBreakdown(children = selectedChildren) {
    const weeklyRows = [];
    const weeklyDatesByChild = new Map(); // studentId -> Set(dateStr) already billed via weekly rate
    let total = 0;

    for (const child of children) {
        const billedDates = new Set();
        for (const weekInfo of getChildWeeklyWeeks(child).values()) {
            weeklyRows.push({ child, ...weekInfo });
            total += weekInfo.weeklyAmount;
            weekInfo.dates.forEach(d => billedDates.add(d));
        }
        weeklyDatesByChild.set(child.studentId, billedDates);
    }

    const allDates = new Set();
    for (const child of children) {
        for (const dateStr of childSchedules.get(child.studentId)?.keys() || []) {
            if (!weeklyDatesByChild.get(child.studentId)?.has(dateStr)) allDates.add(dateStr);
        }
    }

    const dailyRows = [];
    for (const dateStr of [...allDates].sort()) {
        const excludeIds = new Set(
            children.filter(c => weeklyDatesByChild.get(c.studentId)?.has(dateStr)).map(c => c.studentId)
        );
        for (const amt of getChildDayAmounts(dateStr, children, excludeIds)) {
            dailyRows.push({ child: amt.child, date: dateStr, dayType: amt.dayType, multiDiscount: amt.multiDiscount, amount: amt.finalAmount });
            total += amt.finalAmount;
        }
    }

    return { weeklyRows, dailyRows, total };
}

function calcTotal(children = selectedChildren) {
    if (!children.length) return 0;
    return buildBillingBreakdown(children).total;
}

// Renders the ACTIVE child's own date list (Step 3 review) plus a running combined
// total across every child added to this session so far.
function renderSelectedDates() {
    const container = document.getElementById('selectedDates');
    const child      = activeChild();

    let activeSectionHtml;
    if (!child) {
        activeSectionHtml = '<p class="empty-state">Select a child above to begin.</p>';
    } else {
        const sched = childSchedules.get(child.studentId) || new Map();
        if (sched.size === 0) {
            activeSectionHtml = `<p class="empty-state">No dates selected yet for ${escHtml(child.name.split(' ')[0])}.</p>`;
        } else {
            const sorted = [...sched.entries()].sort((a, b) => a[0].localeCompare(b[0]));
            const rows = sorted.map(([dateStr, entry]) => {
                const typeText    = entry.dayType === 'half' ? 'Half Day' : 'Full Day';
                const dayAmounts  = getChildDayAmounts(dateStr);
                const own         = dayAmounts.find(a => a.child.studentId === child.studentId);
                const multiNote   = own && own.multiDiscount > 0
                    ? `<span class="disc-note"> (−$${own.multiDiscount} sibling)</span>` : '';
                const otherKids   = dayAmounts.filter(a => a.child.studentId !== child.studentId);
                const otherNote   = otherKids.length
                    ? `<span class="rate-breakdown">Also scheduled: ${otherKids.map(a => `${escHtml(a.child.name.split(' ')[0])} ($${a.finalAmount.toFixed(2)})`).join(', ')}</span>`
                    : '';
                const rateLabel = own ? formatChildRate(own.child, entry.dayType) : '';

                return `
                    <li class="date-list-item">
                        <div class="date-row">
                            <div class="date-info">
                                <span class="date-label">${friendlyDate(dateStr)}</span>
                                <span class="day-type-label">${typeText} — ${rateLabel}${multiNote}</span>
                                ${otherNote}
                            </div>
                            <button type="button" class="remove-btn" data-date="${dateStr}">&times;</button>
                        </div>
                    </li>`;
            }).join('');

            let fullDayCount = 0, halfDayCount = 0;
            for (const [, entry] of sched) {
                if (entry.dayType === 'half') halfDayCount++;
                else fullDayCount++;
            }
            const totalDayCount = fullDayCount + halfDayCount;
            const parts = [];
            if (fullDayCount > 0) parts.push(`${fullDayCount} full day${fullDayCount !== 1 ? 's' : ''}`);
            if (halfDayCount > 0) parts.push(`${halfDayCount} half day${halfDayCount !== 1 ? 's' : ''}`);

            activeSectionHtml = `
                <ul class="date-list">${rows}</ul>
                <div class="billing-day-counts">${escHtml(child.name.split(' ')[0])}: ${totalDayCount} day${totalDayCount !== 1 ? 's' : ''} total (${parts.join(', ')})</div>`;
        }
    }

    const showTotal        = selectedChildren.length > 0;
    const grandTotal        = calcTotal();
    const hasIndivDiscount  = selectedChildren.some(c => c.discountType && c.discountType !== 'none');
    const hasMultiDiscount  = selectedChildren.length > 1;
    const hasAnyDiscount    = hasIndivDiscount || hasMultiDiscount;
    const totalLabel        = hasAnyDiscount ? 'Total' : 'Estimated total';
    const discountNote      = hasAnyDiscount ? `<span class="billing-note">Discount(s) applied.</span>` : '';

    const summaryHtml = selectedChildren.length > 1
        ? `<div class="all-children-summary">${selectedChildren.map(c => {
              const s = childSchedules.get(c.studentId) || new Map();
              const isActive = c.studentId === activeChildId;
              return `<div class="child-summary-row${isActive ? ' active' : ''}">${escHtml(c.name.split(' ')[0])}: ${s.size} day${s.size !== 1 ? 's' : ''}</div>`;
          }).join('')}</div>`
        : '';

    container.innerHTML = `
        ${activeSectionHtml}
        ${summaryHtml}
        ${showTotal ? `<div class="billing-total">${totalLabel}: <strong>$${grandTotal.toFixed(2)}</strong>${discountNote}</div>` : ''}`;

    container.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            childSchedules.get(activeChildId)?.delete(e.currentTarget.getAttribute('data-date'));
            renderCalendar();
            renderChildTabs();
            renderSelectedDates();
        });
    });
}

// ============================================================
// FORM LISTENERS
// ============================================================
// Fully resets the page for the next family (called when success modal closes)
function resetForNextFamily() {
    document.getElementById('successModal').style.display = 'none';
    resetFamilyLookup();   // clears family, children, dates, calendar

    // Re-enable submit button
    const btn = document.getElementById('submitBtn');
    const win = getRegistrationWindow();
    if (btn) {
        btn.disabled    = win.mode === 'closed';
        btn.textContent = win.mode === 'closed' ? 'Registration Closed' : 'Submit Registration';
    }

    // Restore banner to open/closed state
    const banner = document.getElementById('regWindowBanner');
    if (banner) {
        if (win.mode === 'closed') {
            banner.className = 'reg-window-banner locked';
            if (regWindowOverride === 'closed') {
                banner.innerHTML = `🔒 Registration for <strong>${win.targetLabel}</strong> is currently closed — this month's space is full. To inquire about availability, <a href="mailto:mdo@timothystl.org">contact the office</a>.`;
            } else if (win.opensToday) {
                banner.innerHTML = `🕘 Registration for <strong>${win.targetLabel}</strong> opens today at <strong>9 AM Central time</strong>. Come back then!`;
            } else {
                banner.innerHTML = `🔒 Registration for <strong>${win.targetLabel}</strong> is currently closed. Deadline was <strong>${win.deadlineLabel}</strong>.`;
            }
        } else {
            banner.className = 'reg-window-banner open';
            if (regWindowOverride === 'open') {
                banner.innerHTML = `✅ Registration is still open for <strong>${win.targetLabel}</strong> — space is still available. Deadline: <strong>${win.deadlineLabel}</strong>.`;
            } else {
                banner.innerHTML = `📅 Now accepting registrations for <strong>${win.targetLabel}</strong>. Deadline: <strong>${win.deadlineLabel}</strong>.`;
            }
        }
    }
}

function setupFormListeners() {
    document.getElementById('registrationForm')?.addEventListener('submit', handleSubmit);

    // Closing the success modal fully resets for the next family
    document.getElementById('closeModal')?.addEventListener('click', resetForNextFamily);
    document.getElementById('successModal')?.addEventListener('click', e => {
        if (e.target === document.getElementById('successModal')) resetForNextFamily();
    });

    document.getElementById('prevMonth')?.addEventListener('click', async () => {
        closeDayPicker();
        const target   = getRegistrationWindow().targetDate;
        const atTarget = currentDate.getFullYear() === target.getFullYear() &&
                         currentDate.getMonth()    === target.getMonth();
        if (atTarget) return;
        currentDate.setMonth(currentDate.getMonth() - 1);
        await loadMonthCapacity();
        renderCalendar();
    });

    document.getElementById('nextMonth')?.addEventListener('click', async () => {
        closeDayPicker();
        const target   = getRegistrationWindow().targetDate;
        const atTarget = currentDate.getFullYear() === target.getFullYear() &&
                         currentDate.getMonth()    === target.getMonth();
        if (atTarget) return;
        currentDate.setMonth(currentDate.getMonth() + 1);
        await loadMonthCapacity();
        renderCalendar();
    });
}

// ============================================================
// CONTACT US MODAL
// ============================================================
function setupContactModal() {
    const contactBtn   = document.getElementById('contactUsBtn');
    const contactModal = document.getElementById('contactModal');
    const closeContact = document.getElementById('closeContactModal');
    const contactForm  = document.getElementById('contactForm');

    contactBtn?.addEventListener('click', () => {
        // Pre-fill name/email from selected family if available
        const nameEl  = document.getElementById('contactName');
        const emailEl = document.getElementById('contactEmail');
        if (nameEl  && selectedFamily) nameEl.value  = selectedFamily.parent_name  || '';
        if (emailEl && selectedFamily) emailEl.value = selectedFamily.parent_email || '';
        if (contactModal) contactModal.style.display = 'flex';
    });

    closeContact?.addEventListener('click', () => {
        if (contactModal) contactModal.style.display = 'none';
    });

    contactModal?.addEventListener('click', e => {
        if (e.target === contactModal) contactModal.style.display = 'none';
    });

    contactForm?.addEventListener('submit', async e => {
        e.preventDefault();
        const nameVal    = document.getElementById('contactName').value.trim();
        const emailVal   = document.getElementById('contactEmail').value.trim();
        const messageVal = document.getElementById('contactMessage').value.trim();
        if (!messageVal) { showToast('Please enter a message.'); return; }

        const submitBtn = contactForm.querySelector('button[type="submit"]');
        if (submitBtn) { submitBtn.disabled = true; submitBtn.textContent = 'Sending…'; }

        try {
            await addMessage({ parentName: nameVal, parentEmail: emailVal, message: messageVal });
            if (contactModal) contactModal.style.display = 'none';
            contactForm.reset();
            showToast('✅ Message sent! We\'ll be in touch soon.');
        } catch (err) {
            // Fallback: open mailto if DB fails
            const subject = encodeURIComponent('Registration Question');
            const body    = encodeURIComponent(`Name: ${nameVal}\n\n${messageVal}`);
            window.location.href = `mailto:?subject=${subject}&body=${body}`;
            if (contactModal) contactModal.style.display = 'none';
            contactForm.reset();
        } finally {
            if (submitBtn) { submitBtn.disabled = false; submitBtn.textContent = 'Send Message'; }
        }
    });
}

// ============================================================
// FORGOT PIN MODAL — self-service reset link
// ============================================================
function setupForgotPinModal() {
    const link        = document.getElementById('forgotPinLink');
    const modal       = document.getElementById('forgotPinModal');
    const closeBtn    = document.getElementById('closeForgotPinModal');
    const sendBtn     = document.getElementById('sendForgotPinBtn');
    const emailEl     = document.getElementById('forgotPinEmail');
    const statusEl    = document.getElementById('forgotPinStatus');

    if (!link || !modal) return;

    function open() {
        // Pre-fill from the email field on the calendar form, if any.
        const e = document.getElementById('familyEmailInput')?.value.trim() || '';
        emailEl.value = e;
        statusEl.classList.add('hidden');
        statusEl.textContent = '';
        modal.style.display = 'flex';
        emailEl.focus();
    }
    function close() {
        modal.style.display = 'none';
    }

    link.addEventListener('click', e => { e.preventDefault(); open(); });
    closeBtn?.addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });

    sendBtn.addEventListener('click', async () => {
        const email = emailEl.value.trim();
        if (!email || !email.includes('@')) {
            statusEl.textContent = 'Please enter a valid email address.';
            statusEl.classList.remove('hidden');
            return;
        }
        sendBtn.disabled    = true;
        sendBtn.textContent = 'Sending…';
        try {
            await requestPinReset(email);
        } catch (_) { /* server intentionally hides errors */ }
        // Always show the same message — never reveal whether the email is registered.
        statusEl.textContent = 'If we have an account with that email, a reset link is on its way. The link expires in 1 hour.';
        statusEl.classList.remove('hidden');
        sendBtn.disabled    = false;
        sendBtn.textContent = 'Send Reset Link';
    });
}

// ============================================================
// FORM SUBMISSION
// ============================================================
async function handleSubmit(e) {
    e.preventDefault();
    closeDayPicker();

    const win            = getRegistrationWindow();
    const targetMonthKey = getTargetMonthKey();

    if (win.mode === 'closed') {
        showToast('🔒 Registration is currently closed.');
        return;
    }

    if (!selectedFamily) {
        showToast('Please find your family using the lookup above to continue.');
        return;
    }

    // NOTE: no localStorage early-return here — the server-side checkExistingRegistration
    // handles actual duplicate prevention, and the localStorage guard was blocking
    // different families submitting from the same computer (e.g. office / shared device).

    const parentName  = document.getElementById('parentName').value.trim();
    const parentEmail = document.getElementById('parentEmail').value.trim();
    const parentPhone = document.getElementById('parentPhone').value.trim();

    if (!parentName || !parentEmail || !parentPhone) {
        showToast('Please fill in all parent information fields.');
        return;
    }
    if (!selectedChildren.length) {
        showToast('Please add at least one child.');
        return;
    }
    const emptyChildren = selectedChildren.filter(c => !(childSchedules.get(c.studentId)?.size));
    if (emptyChildren.length) {
        showToast(`Please select at least one care date for ${emptyChildren.map(c => c.name).join(', ')} (or remove them from this registration).`);
        return;
    }

    const btn = document.getElementById('submitBtn');
    btn.disabled    = true;
    btn.textContent = 'Submitting…';

    try {
        const results = [];
        const errors  = [];

        // Build list of student IDs that actually belong to this family
        const familyStudentIds = (selectedFamily?.students || []).map(s => String(s.id));

        for (const child of selectedChildren) {
            const confirmedDates = [...(childSchedules.get(child.studentId) || new Map()).entries()]
                .map(([d, en]) => ({ date: d, dayType: en.dayType }));

            // Guard: child must still belong to the currently selected family.
            // Catches the edge-case where a user switches families mid-session.
            if (child.studentId && !familyStudentIds.includes(String(child.studentId))) {
                errors.push(`${child.name} is not registered to this family. Please re-select your family and try again.`);
                continue;
            }

            // Hard block: one submission per child per month, across all devices.
            // Checks by this parent's email first, then by child name only (catches parent 2
            // trying to re-register a child that parent 1 already scheduled).
            const existingReg = await checkExistingRegistration(parentEmail, targetMonthKey, child.name)
                             || await checkExistingRegistrationByChild(targetMonthKey, child.name);
            if (existingReg) {
                const submittedOn = existingReg.created_at
                    ? ` on ${new Date(existingReg.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
                    : '';
                errors.push(`${child.name} is already registered for ${win.targetLabel} (submitted${submittedOn}). Please contact the office to make any changes.`);
                continue;
            }
            try {
                const reg = await submitRegistration({
                    parent: { name: parentName, email: parentEmail, phone: parentPhone },
                    child:  { name: child.name, ageMonths: calcAgeMonths(child.dob), dob: child.dob },
                    roomId: child.room.id,
                    confirmedDates,
                    waitlistDates: [],
                    status: 'confirmed',
                    submittedBy: _isParent2 ? 'parent2' : 'parent1',
                });
                results.push({ child, reg });
            } catch (childErr) {
                // Postgres trigger raises P0001 for window-closed; surface it cleanly.
                const msg = childErr.message || '';
                const isWindowClosed = msg.includes('Registration window is') ||
                                       msg.includes('window is closed');
                errors.push(isWindowClosed
                    ? msg.replace(/\s*HINT:.*$/s, '').trim()
                    : `${child.name}: ${msg}`);
            }
        }

        if (!results.length) {
            errors.forEach(err => showToast('⚠️ ' + err));
            btn.disabled    = false;
            btn.textContent = 'Submit Registration';
            return;
        }

        localStorage.setItem(`childcare_submitted_${targetMonthKey}`, 'true');

        // Build ONE combined itemized receipt/invoice across every successfully
        // registered child — this reuses buildBillingBreakdown, the exact same
        // calc that drives the live "Estimated total" preview, so the two can
        // never disagree.
        const submitChildren = results.map(r => r.child);
        const { weeklyRows, dailyRows, total: grandTotal } = buildBillingBreakdown(submitChildren);

        // Flattened list of {date, dayType, childName} rows — used for the receipt
        // table, the print schedule, the iCal export, and the confirmation email.
        const sortedDates = [
            ...weeklyRows.flatMap(w => w.dates.map(date => ({
                date, dayType: w.dayType, childName: w.child.name,
                amount: null, // per-day amount not meaningful inside a flat weekly rate
                weeklyAmount: w.weeklyAmount, isWeekly: true,
            }))),
            ...dailyRows.map(r => ({ date: r.date, dayType: r.dayType, childName: r.child.name, amount: r.amount, isWeekly: false })),
        ].sort((a, b) => a.date.localeCompare(b.date) || a.childName.localeCompare(b.childName));

        let receiptHtml = '';
        if (sortedDates.length) {
            const weeklyReceiptRows = weeklyRows.map(w => {
                const label      = w.dayType === 'half' ? 'Half Day (weekly rate)' : 'Full Day (weekly rate)';
                const rangeLabel = `${friendlyDate(w.dates[0])} – ${friendlyDate(w.dates[w.dates.length - 1])}`;
                return `<tr>
                    <td>${escHtml(w.child.name)} — ${rangeLabel}</td>
                    <td>${label}</td>
                    <td class="receipt-amount">$${w.weeklyAmount.toFixed(2)}</td>
                </tr>`;
            }).join('');

            const dailyReceiptRows = dailyRows.map(r => {
                const typeLabel = r.dayType === 'half' ? 'Half Day' : 'Full Day';
                return `<tr>
                    <td>${escHtml(r.child.name)} — ${friendlyDate(r.date)}</td>
                    <td>${typeLabel}</td>
                    <td class="receipt-amount">$${r.amount.toFixed(2)}</td>
                </tr>`;
            }).join('');

            // Create billing invoice — non-blocking, never delays the confirmation.
            // FS5: no amount is sent. The RPC recomputes the family's month from
            // the registration rows just written, so the browser cannot set what
            // a family is billed.
            createInvoiceByEmail(parentEmail, targetMonthKey).catch(err => {
                console.error('Invoice draft failed after registration:', err);
                window.reportClientError?.(
                    `Invoice draft failed after registration: ${err?.message || err}`,
                    err?.stack || null,
                    { type: 'billing_reconcile', month: targetMonthKey, source: 'parent_registration' },
                );
            });

            // Day count summary for receipt (unique child-day pairs; a weekly-rate
            // week still counts as 5 individual days for this summary)
            let rcptFull = 0, rcptHalf = 0;
            sortedDates.forEach(({ dayType }) => {
                if (dayType === 'half') rcptHalf++; else rcptFull++;
            });
            const rcptTotal = rcptFull + rcptHalf;
            const rcptParts = [];
            if (rcptFull > 0) rcptParts.push(`${rcptFull} full day${rcptFull !== 1 ? 's' : ''}`);
            if (rcptHalf > 0) rcptParts.push(`${rcptHalf} half day${rcptHalf !== 1 ? 's' : ''}`);

            receiptHtml = `
                <p class="receipt-day-summary">${rcptTotal} day${rcptTotal !== 1 ? 's' : ''} total &mdash; ${rcptParts.join(', ')}</p>
                <table class="receipt-table">
                    <thead><tr><th>Child — Date</th><th>Type</th><th>Amount</th></tr></thead>
                    <tbody>${weeklyReceiptRows}${dailyReceiptRows}</tbody>
                    <tfoot>
                        <tr class="receipt-total-row">
                            <td colspan="2"><strong>Estimated total</strong></td>
                            <td class="receipt-amount"><strong>$${grandTotal.toFixed(2)}</strong></td>
                        </tr>
                    </tfoot>
                </table>
                <p class="receipt-day-summary" style="margin-top:10px">
                    This confirms the days you booked. Your invoice for the month
                    will follow from the office.
                </p>`;
        }

        const childList = results
            .map(({ child }) => `<strong>${escHtml(child.name)}</strong> (${child.room.label})`)
            .join(', ');

        let details = `<p>Registration for ${childList}.</p>`;
        details += receiptHtml;
        if (errors.length) {
            details += `<p class="receipt-error-note">⚠️ Note: ${escHtml(errors.join('; '))}</p>`;
        }

        // The confirmation email is sent AUTOMATICALLY (see below). Print and iCal
        // remain optional buttons. A status line reflects the auto-send result.
        details += `<div style="margin-top:18px;text-align:center;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
            <button type="button" id="printScheduleBtn" class="btn-print-schedule">🖨️ Print / Save Schedule</button>
            <button type="button" id="icalDownloadBtn" class="btn-print-schedule" style="background:#f0f4ff;color:#667eea;border:1px solid #c7d2fe;">📅 Download iCal (.ics)</button>
        </div>
        <p id="emailScheduleStatus" style="margin-top:12px;text-align:center;font-size:.9em;color:#166534;">📧 Sending a confirmation email to ${escHtml(parentEmail)}…</p>`;

        document.getElementById('successDetails').innerHTML = details;

        // Wire up the print button now that the HTML is in the DOM
        document.getElementById('printScheduleBtn')?.addEventListener('click', () => {
            openPrintSchedule({
                sortedDates,
                monthLabel: win.targetLabel,
                parentName,
            });
        });

        // Wire up the iCal download button
        document.getElementById('icalDownloadBtn')?.addEventListener('click', () => {
            downloadIcal(sortedDates, parentName);
        });

        // Send the confirmation email automatically. Non-blocking: the success
        // modal is already shown; we just update the status line with the result.
        (async () => {
            const statusEl = document.getElementById('emailScheduleStatus');
            try {
                // T1: ids only — the server builds the whole email.
                await sendScheduleEmail(results.map(r => r.reg?.id).filter(Boolean));
                if (statusEl) statusEl.textContent = `✓ A confirmation email was sent to ${parentEmail}.`;
            } catch (err) {
                if (statusEl) {
                    statusEl.style.color = '#b91c1c';
                    statusEl.textContent = '⚠️ We couldn’t send the confirmation email automatically. You can still print or download your schedule above.';
                }
            }
        })();

        document.getElementById('successModal').style.display = 'flex';

    } catch (err) {
        console.error(err);
        if (!SUPABASE_CONFIGURED) {
            showToast('⚙️ Database not connected yet.');
        } else {
            showToast('❌ Error: ' + (err?.message || JSON.stringify(err)));
        }
        btn.disabled    = false;
        btn.textContent = 'Submit Registration';
    }
}

// ============================================================
// UTILITIES
// ============================================================
function formatDate(date) {
    return `${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
}
function friendlyDate(dateStr) {
    return new Date(dateStr + 'T00:00:00').toLocaleDateString('en-US',
        { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}
function showToast(msg) {
    const t = document.getElementById('errorToast');
    t.textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 5000);
}
function setupListeners() {}   // kept for compatibility

// ============================================================
// PRINT SCHEDULE POPUP
// ============================================================
function openPrintSchedule({ sortedDates, monthLabel, parentName }) {
    const rows = sortedDates.map(({ date, dayType, childName }) => {
        const label = dayType === 'half' ? 'Half Day' : 'Full Day';
        const d = new Date(date + 'T00:00:00').toLocaleDateString('en-US',
            { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        return `<tr><td>${d}</td><td>${escHtml(childName)}</td><td class="dt">${label}</td></tr>`;
    }).join('');
    const childNames = [...new Set(sortedDates.map(d => d.childName))];

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${escHtml(monthLabel)} Care Schedule — ${escHtml(parentName)}</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: Arial, Helvetica, sans-serif; padding: 48px; max-width: 600px; margin: 0 auto; color: #222; }
  h1 { font-size: 1.3em; font-weight: 700; margin-bottom: 4px; }
  .sub { font-size: .9em; color: #555; margin-bottom: 28px; }
  table { width: 100%; border-collapse: collapse; }
  thead th { background: #f0f0f0; padding: 9px 14px; text-align: left; font-size: .9em; font-weight: 600; }
  tbody td { padding: 9px 14px; border-bottom: 1px solid #eee; font-size: .95em; }
  td.dt { font-weight: 500; width: 120px; }
  .footer { margin-top: 36px; font-size: .75em; color: #aaa; text-align: center; }
  @media print { body { padding: 24px; } @page { margin: .75in; } }
</style>
</head>
<body>
  <h1>${monthLabel} — Confirmed Care Schedule</h1>
  <p class="sub">Family: <strong>${escHtml(parentName)}</strong> &nbsp;·&nbsp; Children: ${childNames.map(escHtml).join(', ')}</p>
  <table>
    <thead><tr><th>Date</th><th>Child</th><th>Type</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <div class="footer">Printed ${new Date().toLocaleString('en-US')}</div>
  <script>window.addEventListener('load', function(){ window.print(); });<\/script>
</body>
</html>`;

    const w = window.open('', '_blank');
    if (!w) { showToast('Pop-up blocked — please allow pop-ups and try again.'); return; }
    w.document.write(html);
    w.document.close();
}

// ============================================================
// iCAL DOWNLOAD
// ============================================================
function generateIcal(sortedDates, parentName) {
    const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
    const uid = () => `childcare-${Date.now()}-${Math.random().toString(36).slice(2,7)}@tlcmdo`;
    const desc = `Timothy Lutheran Church Mother's Day Out (${parentName})`;

    // One calendar event per (child, date) row \u2014 each child may have a different schedule.
    const events = sortedDates.map(({ date, dayType, childName }) => {
        const dtStart  = date.replace(/-/g, '');
        const [y, m, d] = date.split('-').map(Number);
        const nextDay  = new Date(y, m - 1, d + 1);
        const dtEnd    = `${nextDay.getFullYear()}${String(nextDay.getMonth() + 1).padStart(2, '0')}${String(nextDay.getDate()).padStart(2, '0')}`;
        const dayLabel = dayType === 'half' ? 'Half Day' : 'Full Day';
        return [
            'BEGIN:VEVENT',
            `UID:${uid()}`,
            `DTSTAMP:${now}`,
            `DTSTART;VALUE=DATE:${dtStart}`,
            `DTEND;VALUE=DATE:${dtEnd}`,
            `SUMMARY:MDO \u2014 ${childName} \u2014 ${dayLabel}`,
            `DESCRIPTION:${desc}`,
            'END:VEVENT',
        ].join('\r\n');
    });

    return [
        'BEGIN:VCALENDAR',
        'VERSION:2.0',
        'PRODID:-//Timothy Lutheran Church MDO//Childcare Registration//EN',
        'CALSCALE:GREGORIAN',
        'METHOD:PUBLISH',
        ...events,
        'END:VCALENDAR',
    ].join('\r\n');
}

function downloadIcal(sortedDates, parentName) {
    if (!sortedDates.length) { showToast('No dates to export.'); return; }
    const ical      = generateIcal(sortedDates, parentName);
    const blob      = new Blob([ical], { type: 'text/calendar;charset=utf-8' });
    const url       = URL.createObjectURL(blob);
    const a         = document.createElement('a');
    const childNames = [...new Set(sortedDates.map(d => d.childName))];
    const safeName  = childNames.join('-').replace(/\s+/g, '').slice(0, 24);
    a.href          = url;
    a.download     = `care-schedule-${safeName}.ics`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}

// ============================================================
// WAITLIST APPLICATION FORM
// ============================================================
(function setupWaitlistForm() {
    const openBtn   = document.getElementById('waitlistBtn');
    const modal     = document.getElementById('waitlistModal');
    const closeBtn  = document.getElementById('closeWaitlistModal');
    const form      = document.getElementById('waitlistForm');
    const successM  = document.getElementById('waitlistSuccessModal');
    const successCl = document.getElementById('closeWaitlistSuccessModal');
    const isUnborn  = document.getElementById('wlIsUnborn');
    const dobRow    = document.getElementById('wlDobRow');
    const dueRow    = document.getElementById('wlDueRow');
    const hasSib    = document.getElementById('wlHasSibling');
    const sibFields = document.getElementById('wlSiblingFields');

    populateSiblingRoomSelect(document.getElementById('wlSiblingRoom'));

    // Guard on the MODAL, not on one particular opener. This used to read
    // `if (!openBtn) return`, and #waitlistBtn does not exist on calendar.html —
    // so the whole setup bailed on the only page that has the form, taking
    // #waitlistCalloutBtn down with it. The modal and its form were fully built
    // and completely unreachable: the FAQ told parents to "join the online
    // waitlist through the care day portal", and the portal had no way in.
    if (!modal) return;

    openBtn?.addEventListener('click', () => { modal.style.display = 'flex'; });
    document.getElementById('waitlistCalloutBtn')?.addEventListener('click', () => { modal.style.display = 'flex'; });
    closeBtn.addEventListener('click', () => { modal.style.display = 'none'; });
    modal.addEventListener('click', e => { if (e.target === modal) modal.style.display = 'none'; });

    isUnborn.addEventListener('change', () => {
        const unborn = isUnborn.checked;
        dobRow.classList.toggle('hidden', unborn);
        dueRow.classList.toggle('hidden', !unborn);
        document.getElementById('wlChildDob').required = !unborn;
        document.getElementById('wlDueDate').required  = unborn;
    });

    hasSib.addEventListener('change', () => {
        sibFields.classList.toggle('hidden', !hasSib.checked);
    });

    const daysCheckboxes = document.getElementById('wlDaysCheckboxes');
    const flexCountSel   = document.getElementById('wlFlexCount');
    document.querySelectorAll('input[name="wlDaysMode"]').forEach(r => r.addEventListener('change', () => {
        const flexible = document.querySelector('input[name="wlDaysMode"]:checked').value === 'flexible';
        daysCheckboxes.style.display = flexible ? 'none' : '';
        flexCountSel.disabled = !flexible;
    }));

    successCl.addEventListener('click', () => { successM.style.display = 'none'; });

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const btn = document.getElementById('wlSubmitBtn');

        // Validate days
        const flexible = document.querySelector('input[name="wlDaysMode"]:checked').value === 'flexible';
        const days = [...document.querySelectorAll('.wlDay:checked')].map(cb => cb.value);
        if (!flexible && !days.length) { showToast('Please select at least one day, or choose "Any" days.'); return; }

        btn.disabled = true;
        btn.textContent = 'Submitting…';

        const isUnbornChecked = isUnborn.checked;
        const childDob  = isUnbornChecked ? null : (document.getElementById('wlChildDob').value || null);
        const dueDate   = isUnbornChecked ? (document.getElementById('wlDueDate').value || null) : null;
        const startDate = document.getElementById('wlStartDate').value;
        const dayType   = document.querySelector('input[name="wlDayType"]:checked').value;

        const payload = {
            parent_name:        document.getElementById('wlParentName').value.trim(),
            parent_email:       document.getElementById('wlParentEmail').value.trim(),
            parent_phone:       document.getElementById('wlParentPhone').value.trim() || null,
            child_name:         document.getElementById('wlChildName').value.trim(),
            child_dob:          childDob,
            expected_due_date:  dueDate,
            desired_start_date: startDate,
            start_flexibility:  document.getElementById('wlFlexibility').value,
            days_of_week:       flexible ? null : days.join(','),
            days_flexible:       flexible,
            days_flexible_count: flexible ? Number(flexCountSel.value) || 3 : null,
            day_type:           dayType,
            has_sibling:        hasSib.checked,
            sibling_child_name: hasSib.checked ? (document.getElementById('wlSiblingName').value.trim() || null) : null,
            sibling_room_id:    hasSib.checked ? (document.getElementById('wlSiblingRoom').value || null) : null,
            notes:              document.getElementById('wlNotes').value.trim() || null,
            status:             'pending',
        };

        try {
            await submitWaitlistApplication(payload);
            modal.style.display = 'none';
            form.reset();
            dobRow.classList.remove('hidden');
            dueRow.classList.add('hidden');
            sibFields.classList.add('hidden');

            document.getElementById('waitlistSuccessDetails').textContent =
                `${payload.child_name} has been added to the waitlist for a start around ${startDate}. We'll contact you at ${payload.parent_email}.`;
            successM.style.display = 'flex';
        } catch (err) {
            showToast('Submission failed: ' + err.message);
        } finally {
            btn.disabled = false;
            btn.textContent = 'Join Waitlist';
        }
    });
})();
