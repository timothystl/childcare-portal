// ============================================================
// CONSTANTS
// ============================================================
const MONTH_NAMES    = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
const DAY_HEADERS_MF = ['Mon','Tue','Wed','Thu','Fri'];

// ============================================================
// STATE
// ============================================================
let currentDate         = new Date();
let selectedFamily      = null;     // { id, parent_name, parent_email, parent_phone, pin, students:[] }
let _isParent2          = false;   // whether the logged-in parent is parent 2
let _familySessionToken = null;    // short-lived HMAC token issued at login, passed to push-subscribe
let selectedChildren    = [];       // [{ name, dob, room: ROOMS[i], isNew: bool, studentId: string|null }]
let selectedDates       = new Map();  // 'YYYY-MM-DD' -> { dayType: 'full'|'half' }
let capacityCache       = {};         // { roomId: { 'YYYY-MM-DD': count } }
let closureMap          = new Map();  // 'YYYY-MM-DD' -> reason string
let calendarLoading     = false;
let pickerOpenDate      = null;
let regWindowOverride   = 'auto';     // 'auto' | 'open' | 'closed'
const studentDataMap    = new Map();  // studentId -> { dob, roomOverride } — kept in JS, not DOM

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
    // hour12:false can return 24 for midnight in some environments; normalise to 0.
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
    // Load room rates and summer camp visibility from admin settings
    await loadRateSettings();
    await loadSummerCampSetting();

    regWindowOverride = (await fetchSetting('reg_window_override')) || 'auto';

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

    const closures = await fetchClosures();
    closureMap = new Map(closures.map(c => [c.close_date, c.reason || '']));
});

// ============================================================
// AGE / DOB HELPERS
// ============================================================
function calcAgeMonths(dobStr) {
    if (!dobStr) return null;
    const today = new Date();
    const birth = new Date(dobStr + 'T00:00:00');
    return (today.getFullYear() - birth.getFullYear()) * 12
         + (today.getMonth() - birth.getMonth());
}

function getRoomIdFromDob(dobStr) {
    if (!dobStr) return null;
    const months = calcAgeMonths(dobStr);
    if (months < 0) return null;
    // Use ROOMS age ranges dynamically — only active rooms with age bounds
    const ageable = ROOMS
        .filter(r => r.status === 'active' && r.ageMinMonths != null)
        .sort((a, b) => a.ageMinMonths - b.ageMinMonths);
    for (const room of ageable) {
        if (months >= room.ageMinMonths && (room.ageMaxMonths == null || months <= room.ageMaxMonths)) {
            return room.id;
        }
    }
    return null;
}

function getRoomFromDob(dobStr) {
    const roomId = getRoomIdFromDob(dobStr);
    return roomId ? (ROOMS.find(r => r.id === roomId) || null) : null;
}

// Returns room: checks admin-set override first, falls back to age-based
function getRoomForStudent(student) {
    if (student.room_override) {
        const room = ROOMS.find(r => r.id === student.room_override);
        if (room) return room;
    }
    return getRoomFromDob(student.child_dob || student.dob || null);
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
    selectedDates    = new Map();
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
    selectedDates = new Map();
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
function renderChildSection() {
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
            dob:          s.child_dob || '',
            roomOverride: s.room_override || '',
        });
    });

    section.innerHTML = `
        <div class="child-cards-row">
            ${students.map(s => {
                const room       = getRoomForStudent(s);
                const isSelected = selectedChildren.some(c => c.studentId === s.id);
                const recurDays = Array.isArray(s.recurring_days) ? s.recurring_days.join(',') : '';
                return `<label class="child-card-label${isSelected ? ' selected' : ''}" data-student-id="${s.id}">
                    <input type="checkbox" class="child-card-checkbox"
                           data-student-id="${s.id}"
                           data-name="${escStr(s.child_name)}"
                           data-discount-type="${escStr(s.discount_type || 'none')}"
                           data-discount-value="${escStr(String(s.discount_value || 0))}"
                           data-recurring-days="${escStr(recurDays)}"
                           ${isSelected ? 'checked' : ''}>
                    <span class="child-card-name">${escStr(s.child_name.split(' ')[0])}</span>
                    ${recurDays ? `<span class="child-card-recurring" title="Recurring days: ${escStr(recurDays.replace(/,/g,', '))}">🔁 ${escStr(recurDays.replace(/,/g,', '))}</span>` : ''}
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
            const room = getRoomForStudent({ child_dob: childDob, room_override: roomOverride });
            if (!room) {
                cb.checked = false;
                showToast(`Could not assign a room for ${childName} — please check their date of birth.`);
                return;
            }
            cb.closest('.child-card-label').classList.toggle('selected', cb.checked);
            if (cb.checked) {
                if (!selectedChildren.some(c => c.studentId === studentId)) {
                    const rdRaw = cb.dataset.recurringDays || '';
                    selectedChildren.push({
                        name: childName, dob: childDob, room, isNew: false, studentId,
                        discountType:  cb.dataset.discountType  || 'none',
                        discountValue: parseFloat(cb.dataset.discountValue || '0'),
                        recurringDays: rdRaw ? rdRaw.split(',').filter(Boolean) : [],
                    });
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
                if (idx !== -1) { selectedChildren.splice(idx, 1); onChildrenChanged(); }
            }
        });
    });
}

async function onChildrenChanged() {
    selectedDates = new Map();
    capacityCache = {};
    if (!selectedChildren.length) {
        hideCalendar();
        renderSelectedDates();
        return;
    }

    // Pre-populate recurring days for selected children who have them set
    const DOW_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    const { targetDate } = getRegistrationWindow();
    const yr = targetDate.getFullYear(), mo = targetDate.getMonth();
    const daysInMonth = new Date(yr, mo + 1, 0).getDate();
    const allRecurring = new Set(selectedChildren.flatMap(c => c.recurringDays || []));
    if (allRecurring.size) {
        for (let day = 1; day <= daysInMonth; day++) {
            const d   = new Date(yr, mo, day);
            const dow = DOW_NAMES[d.getDay()];
            if (allRecurring.has(dow)) {
                const dateStr = `${yr}-${String(mo+1).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
                selectedDates.set(dateStr, { dayType: 'full', locked: true });
            }
        }
    }

    document.getElementById('calendarWrapper')?.classList.remove('hidden');
    document.getElementById('calendarHint')?.classList.add('hidden');
    await loadMonthCapacity();
    renderCalendar();
    renderSelectedDates();
}

function hideCalendar() {
    document.getElementById('calendarWrapper')?.classList.add('hidden');
    document.getElementById('calendarHint')?.classList.remove('hidden');
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

function getDateStatus(dateStr) {
    if (!selectedChildren.length) return 'disabled';
    // Count how many selected children share each room (siblings each need a spot)
    const spotsNeeded = {};
    for (const child of selectedChildren) {
        spotsNeeded[child.room.id] = (spotsNeeded[child.room.id] || 0) + 1;
    }
    let worstStatus = 'available';
    for (const [roomId, needed] of Object.entries(spotsNeeded)) {
        const room      = ROOMS.find(r => r.id === roomId);
        const booked    = (capacityCache[roomId] || {})[dateStr] || 0;
        const available = (room?.capacity || 0) - booked;
        if (available < needed)           return 'full';
        if (available - needed < 3)       worstStatus = 'limited';
    }
    return worstStatus;
}

function spotsLeft(dateStr) {
    if (!selectedChildren.length) return 0;
    const spotsNeeded = {};
    for (const child of selectedChildren) {
        spotsNeeded[child.room.id] = (spotsNeeded[child.room.id] || 0) + 1;
    }
    let minEffective = Infinity;
    for (const [roomId, needed] of Object.entries(spotsNeeded)) {
        const room      = ROOMS.find(r => r.id === roomId);
        const booked    = (capacityCache[roomId] || {})[dateStr] || 0;
        const available = Math.max(0, (room?.capacity || 0) - booked);
        minEffective    = Math.min(minEffective, Math.max(0, available - needed + 1));
    }
    return minEffective === Infinity ? 0 : minEffective;
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

        const dateStr      = formatDate(date);
        const isPast       = date < today;
        const isClosed     = closureMap.has(dateStr);
        const entry        = selectedDates.get(dateStr);
        const isSelected   = !!entry;
        const isPickerOpen = pickerOpenDate === dateStr;

        let status;
        if (isPast)        status = 'past';
        else if (isClosed) status = 'closed';
        else               status = getDateStatus(dateStr);

        const cell = document.createElement('div');
        const isLocked = isSelected && entry?.locked;
        cell.className = `cal-day ${status}${isSelected ? ' selected' : ''}${isLocked ? ' recurring-locked' : ''}${isPickerOpen ? ' picker-active' : ''}`;
        cell.setAttribute('data-date', dateStr);

        let badge = '';
        if (isSelected && entry) {
            badge = isLocked
                ? '<span class="selected-type-badge recurring-badge">🔁 Recurring</span>'
                : (entry.dayType === 'half'
                    ? '<span class="selected-type-badge">½ day</span>'
                    : '<span class="selected-type-badge">Full</span>');
        } else if (isClosed) {
            const reason = closureMap.get(dateStr);
            badge = `<span class="spot-badge closed-badge">Closed</span>${reason ? `<span class="closed-reason">${escStr(reason)}</span>` : ''}`;
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
        }

        cal.appendChild(cell);
    }
}

// ============================================================
// DAY PICKER POPUP
// ============================================================
function handleDayClick(dateStr, status, cellEl) {
    if (!selectedChildren.length) return;

    if (selectedDates.has(dateStr)) {
        if (selectedDates.get(dateStr)?.locked) return; // cannot remove a recurring day
        selectedDates.delete(dateStr);
        closeDayPicker();
        renderCalendar();
        renderSelectedDates();
        return;
    }

    const allFullDayOnly = selectedChildren.every(c => c.room.fullDayOnly);
    if (allFullDayOnly) {
        closeDayPicker();
        selectedDates.set(dateStr, { dayType: 'full' });
        renderCalendar();
        renderSelectedDates();
        return;
    }

    showDayPicker(dateStr, cellEl);
}

function showDayPicker(dateStr, cellEl) {
    closeDayPicker();
    pickerOpenDate = dateStr;
    renderCalendar();

    const backdrop = document.createElement('div');
    backdrop.id        = 'dayPickerBackdrop';
    backdrop.className = 'day-picker-backdrop';
    backdrop.addEventListener('click', e => {
        e.stopPropagation();
        closeDayPicker();
        renderCalendar();
    });
    document.body.appendChild(backdrop);

    const fullTotal = selectedChildren.reduce((s, c) => s + (c.room.fullDayRate || 0), 0);
    const halfTotal = selectedChildren.reduce((s, c) => s + (c.room.halfDayRate || 0), 0);
    const hasHalf   = selectedChildren.some(c => !c.room.fullDayOnly);

    const childCountNote = selectedChildren.length > 1
        ? `<p class="picker-subtitle">${selectedChildren.length} children · rates combined</p>`
        : '';

    const popup = document.createElement('div');
    popup.id        = 'dayPickerPopup';
    popup.className = 'day-picker-popup';
    popup.innerHTML = `
        <p class="picker-title">${friendlyDate(dateStr)}</p>
        ${childCountNote}
        <div class="picker-buttons">
            <button type="button" class="picker-btn" data-date="${dateStr}" data-type="full">
                <span class="picker-label">Full Day</span>
                <span class="picker-rate">$${fullTotal}</span>
            </button>
            ${hasHalf ? `<button type="button" class="picker-btn" data-date="${dateStr}" data-type="half">
                <span class="picker-label">Half Day</span>
                <span class="picker-rate">$${halfTotal}</span>
            </button>` : ''}
        </div>
        <button type="button" class="picker-cancel">✕ Cancel</button>
    `;

    document.body.appendChild(popup);

    popup.style.position  = 'fixed';
    popup.style.top       = '50%';
    popup.style.left      = '50%';
    popup.style.transform = 'translate(-50%, -50%)';

    popup.querySelectorAll('.picker-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            selectedDates.set(btn.getAttribute('data-date'), {
                dayType: btn.getAttribute('data-type'),
            });
            closeDayPicker();
            renderCalendar();
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
    const base = dayType === 'half' ? (child.room.halfDayRate || 0) : (child.room.fullDayRate || 0);
    const rate = effectiveRate(base, child.discountType, child.discountValue);
    if (child.discountType === 'staff')
        return `$0<span class="disc-note"> (staff)</span>`;
    if (child.discountType === 'custom' && child.discountValue > 0)
        return `$${rate}<span class="disc-note"> (${child.discountValue}% off)</span>`;
    return `$${rate}`;
}

// ============================================================
// SELECTED DATES + BILLING TOTAL (multi-child aware)
// ============================================================

// Returns per-child amounts for a given day type, applying:
//   1. Per-child individual discount (staff / custom %)
//   2. Multi-child discount: 2nd+ children get $10 off (sorted highest-rate first)
function getChildDayAmounts(dayType) {
    const entries = selectedChildren.map(c => {
        const base = dayType === 'half' ? (c.room.halfDayRate || 0) : (c.room.fullDayRate || 0);
        return { child: c, eff: effectiveRate(base, c.discountType, c.discountValue) };
    }).sort((a, b) => b.eff - a.eff);   // highest payer first

    return entries.map((entry, i) => ({
        child:         entry.child,
        preMulti:      entry.eff,               // rate after individual discount
        multiDiscount: i > 0 ? Math.min(10, entry.eff) : 0,
        finalAmount:   Math.max(0, entry.eff - (i > 0 ? 10 : 0)),
    }));
}

function calcDayTotal(dayType) {
    return getChildDayAmounts(dayType).reduce((s, e) => s + e.finalAmount, 0);
}

// Returns the ISO date string for the Monday of the week containing dateStr
function getWeekMonday(dateStr) {
    const d = new Date(dateStr + 'T00:00:00');
    const dow = d.getDay(); // 0=Sun … 6=Sat
    const toMon = dow === 0 ? -6 : 1 - dow;
    const mon = new Date(d);
    mon.setDate(d.getDate() + toMon);
    return mon.toISOString().slice(0, 10);
}

function calcTotal() {
    if (!selectedChildren.length) return 0;

    // Group dates by calendar week (Mon–Fri)
    const byWeek = new Map();
    for (const [dateStr, entry] of selectedDates) {
        const wk = getWeekMonday(dateStr);
        if (!byWeek.has(wk)) byWeek.set(wk, []);
        byWeek.get(wk).push({ dateStr, dayType: entry.dayType });
    }

    let total = 0;
    for (const [, days] of byWeek) {
        const isFullWeek = days.length === 5;
        const allFull    = isFullWeek && days.every(d => d.dayType === 'full');
        const allHalf    = isFullWeek && days.every(d => d.dayType === 'half');

        // Weekly rate applies only when all 5 weekdays are booked with the same day type
        if (allFull || allHalf) {
            const weeklyChildren = selectedChildren.map(c => {
                const weeklyRate = allFull ? c.room.weeklyFullRate : c.room.weeklyHalfRate;
                if (weeklyRate != null) {
                    return effectiveRate(weeklyRate, c.discountType, c.discountValue);
                }
                return null; // no weekly rate for this room
            });

            if (weeklyChildren.every(v => v !== null)) {
                // All children have a weekly rate — apply it
                const sorted = [...weeklyChildren].sort((a, b) => b - a);
                total += sorted.reduce((s, v, i) => s + Math.max(0, v - (i > 0 ? 10 : 0)), 0);
                continue;
            }
        }

        // Partial week or mixed types — sum individual days
        for (const { dayType } of days) {
            total += calcDayTotal(dayType);
        }
    }
    return total;
}

function renderSelectedDates() {
    const container = document.getElementById('selectedDates');
    if (selectedDates.size === 0) {
        container.innerHTML = '<p class="empty-state">No dates selected yet.</p>';
        return;
    }

    const hasIndivDiscount  = selectedChildren.some(c => c.discountType && c.discountType !== 'none');
    const hasMultiDiscount  = selectedChildren.length > 1;
    const hasAnyDiscount    = hasIndivDiscount || hasMultiDiscount;

    const sorted = [...selectedDates.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const rows = sorted.map(([dateStr, entry]) => {
        let dayTypeLabel = '';
        if (selectedChildren.length) {
            const typeText   = entry.dayType === 'half' ? 'Half Day' : 'Full Day';
            const dayAmounts = getChildDayAmounts(entry.dayType);
            const lineTotal  = dayAmounts.reduce((s, e) => s + e.finalAmount, 0);

            if (selectedChildren.length === 1) {
                const amt = dayAmounts[0];
                dayTypeLabel = `<span class="day-type-label">${typeText} — ${formatChildRate(amt.child, entry.dayType)}</span>`;
            } else {
                const breakdown = dayAmounts.map(amt => {
                    const multiNote = amt.multiDiscount > 0
                        ? `<span class="disc-note"> (−$${amt.multiDiscount} sibling)</span>` : '';
                    return `${escStr(amt.child.name)}: $${amt.finalAmount.toFixed(2)}${multiNote}`;
                }).join(' · ');
                dayTypeLabel = `<span class="day-type-label">${typeText} — $${lineTotal.toFixed(2)}</span><span class="rate-breakdown">${breakdown}</span>`;
            }
        }

        return `
            <li class="date-list-item">
                <div class="date-row">
                    <div class="date-info">
                        <span class="date-label">${friendlyDate(dateStr)}</span>
                        ${dayTypeLabel}
                    </div>
                    <button type="button" class="remove-btn" data-date="${dateStr}">&times;</button>
                </div>
            </li>`;
    }).join('');

    const total      = calcTotal();
    const totalLabel = hasAnyDiscount ? 'Total' : 'Estimated total';
    const discountNote = hasAnyDiscount
        ? `<span class="billing-note">Discount(s) applied.</span>`
        : '';

    // Day count summary
    let fullDayCount = 0, halfDayCount = 0;
    for (const [, entry] of selectedDates) {
        if (entry.dayType === 'half') halfDayCount++;
        else fullDayCount++;
    }
    const totalDayCount = fullDayCount + halfDayCount;
    const daySummaryParts = [];
    if (fullDayCount > 0) daySummaryParts.push(`${fullDayCount} full day${fullDayCount !== 1 ? 's' : ''}`);
    if (halfDayCount > 0) daySummaryParts.push(`${halfDayCount} half day${halfDayCount !== 1 ? 's' : ''}`);
    const daySummary = `<div class="billing-day-counts">${totalDayCount} day${totalDayCount !== 1 ? 's' : ''} total (${daySummaryParts.join(', ')})</div>`;

    container.innerHTML = `
        <ul class="date-list">${rows}</ul>
        ${daySummary}
        <div class="billing-total">
            ${totalLabel}: <strong>$${total.toFixed(2)}</strong>${discountNote}
        </div>`;

    container.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            selectedDates.delete(e.currentTarget.getAttribute('data-date'));
            renderCalendar();
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
    document.getElementById('registrationForm').addEventListener('submit', handleSubmit);

    // Closing the success modal fully resets for the next family
    document.getElementById('closeModal').addEventListener('click', resetForNextFamily);
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
    if (selectedDates.size === 0) {
        showToast('Please select at least one care date.');
        return;
    }

    const btn = document.getElementById('submitBtn');
    btn.disabled    = true;
    btn.textContent = 'Submitting…';

    try {
        // All selected dates are confirmed
        const confirmedDates = [...selectedDates.entries()]
            .map(([d, en]) => ({ date: d, dayType: en.dayType }));

        const results = [];
        const errors  = [];

        // Build list of student IDs that actually belong to this family
        const familyStudentIds = (selectedFamily?.students || []).map(s => String(s.id));

        for (const child of selectedChildren) {
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

        // Build itemized receipt (uses multi-child + individual discounts)
        const sortedDates = confirmedDates.slice().sort((a, b) => a.date.localeCompare(b.date));
        let receiptHtml = '';
        let emailDatesWithAmounts = [];
        let emailGrandTotal = 0;
        if (sortedDates.length) {
            // Build per-day amounts using same logic as renderSelectedDates
            // results[].child mirrors selectedChildren at submit time
            const submitChildren = results.map(r => r.child);
            const calcSubmitDayAmounts = (dayType) => {
                const entries = submitChildren.map(c => {
                    const base = dayType === 'half' ? (c.room.halfDayRate || 0) : (c.room.fullDayRate || 0);
                    return { child: c, eff: effectiveRate(base, c.discountType, c.discountValue) };
                }).sort((a, b) => b.eff - a.eff);
                return entries.map((entry, i) => ({
                    child:       entry.child,
                    finalAmount: Math.max(0, entry.eff - (i > 0 ? 10 : 0)),
                }));
            };

            const receiptRows = sortedDates.map(({ date, dayType }) => {
                const typeLabel  = dayType === 'half' ? 'Half Day' : 'Full Day';
                const dayAmts    = calcSubmitDayAmounts(dayType);
                const lineTotal  = dayAmts.reduce((s, e) => s + e.finalAmount, 0);
                return `<tr>
                    <td>${friendlyDate(date)}</td>
                    <td>${typeLabel}</td>
                    <td class="receipt-amount">$${lineTotal.toFixed(2)}</td>
                </tr>`;
            }).join('');

            const grandTotal = sortedDates.reduce((s, { dayType }) =>
                s + calcSubmitDayAmounts(dayType).reduce((ss, e) => ss + e.finalAmount, 0), 0);

            // Pre-compute for email (must happen here while calcSubmitDayAmounts is in scope)
            emailGrandTotal = grandTotal;
            emailDatesWithAmounts = sortedDates.map(({ date, dayType }) => ({
                date,
                dayType,
                amount: calcSubmitDayAmounts(dayType).reduce((s, e) => s + e.finalAmount, 0),
            }));

            // Create billing invoice — non-blocking, never delays the confirmation
            createInvoiceByEmail(parentEmail, targetMonthKey, emailGrandTotal).catch(() => {});

            // Day count summary for receipt
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
                    <thead><tr><th>Date</th><th>Type</th><th>Amount</th></tr></thead>
                    <tbody>${receiptRows}</tbody>
                    <tfoot>
                        <tr class="receipt-total-row">
                            <td colspan="2"><strong>Total</strong></td>
                            <td class="receipt-amount"><strong>$${grandTotal.toFixed(2)}</strong></td>
                        </tr>
                    </tfoot>
                </table>`;
        }

        const childList = results
            .map(({ child }) => `<strong>${escStr(child.name)}</strong> (${child.room.label})`)
            .join(', ');

        let details = `<p>Registration for ${childList}.</p>`;
        details += receiptHtml;
        if (errors.length) {
            details += `<p class="receipt-error-note">⚠️ Note: ${escStr(errors.join('; '))}</p>`;
        }

        // Action buttons: Print, iCal, and Email
        details += `<div style="margin-top:18px;text-align:center;display:flex;gap:10px;justify-content:center;flex-wrap:wrap;">
            <button type="button" id="printScheduleBtn" class="btn-print-schedule">🖨️ Print / Save Schedule</button>
            <button type="button" id="icalDownloadBtn" class="btn-print-schedule" style="background:#f0f4ff;color:#667eea;border:1px solid #c7d2fe;">📅 Download iCal (.ics)</button>
            <button type="button" id="emailScheduleBtn" class="btn-print-schedule" style="background:#f0fdf4;color:#166534;border:1px solid #86efac;">📧 Email Schedule</button>
        </div>`;

        document.getElementById('successDetails').innerHTML = details;

        // Wire up the print button now that the HTML is in the DOM
        document.getElementById('printScheduleBtn')?.addEventListener('click', () => {
            openPrintSchedule({
                sortedDates,
                childNames: results.map(r => r.child.name),
                monthLabel: win.targetLabel,
                parentName,
            });
        });

        // Wire up the iCal download button
        document.getElementById('icalDownloadBtn')?.addEventListener('click', () => {
            downloadIcal(sortedDates, results.map(r => r.child.name), parentName, win.targetLabel);
        });

        // Wire up the email schedule button
        document.getElementById('emailScheduleBtn')?.addEventListener('click', async () => {
            const btn = document.getElementById('emailScheduleBtn');
            btn.disabled = true;
            btn.textContent = 'Sending…';
            try {
                await sendScheduleEmail({
                    parentName,
                    parentEmail,
                    monthLabel: win.targetLabel,
                    childNames: results.map(r => r.child.name),
                    dates: emailDatesWithAmounts,
                    grandTotal: emailGrandTotal,
                });
                btn.textContent = '✓ Email Sent!';
            } catch (err) {
                btn.disabled = false;
                btn.textContent = '📧 Email Schedule';
                showToast('Email failed: ' + err.message);
            }
        });

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
// escStr: alias for escHtml() defined in supabase.js (loaded before this file).
const escStr = escHtml;
function setupListeners() {}   // kept for compatibility

// ============================================================
// PRINT SCHEDULE POPUP
// ============================================================
function openPrintSchedule({ sortedDates, childNames, monthLabel, parentName }) {
    const rows = sortedDates.map(({ date, dayType }) => {
        const label = dayType === 'half' ? 'Half Day' : 'Full Day';
        const d = new Date(date + 'T00:00:00').toLocaleDateString('en-US',
            { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
        return `<tr><td>${d}</td><td class="dt">${label}</td></tr>`;
    }).join('');

    const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>${monthLabel} Care Schedule — ${parentName}</title>
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
  <p class="sub">Family: <strong>${parentName}</strong> &nbsp;·&nbsp; Children: ${childNames.join(', ')}</p>
  <table>
    <thead><tr><th>Date</th><th>Type</th></tr></thead>
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
function generateIcal(sortedDates, childNames, parentName) {
    const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
    const uid = () => `childcare-${Date.now()}-${Math.random().toString(36).slice(2,7)}@tlcmdo`;
    const desc = `Timothy Lutheran Church Mother's Day Out (${parentName})`;

    // One calendar event per child per date
    const events = [];
    sortedDates.forEach(({ date, dayType }) => {
        const dtStart  = date.replace(/-/g, '');
        const [y, m, d] = date.split('-').map(Number);
        const nextDay  = new Date(y, m - 1, d + 1);
        const dtEnd    = `${nextDay.getFullYear()}${String(nextDay.getMonth() + 1).padStart(2, '0')}${String(nextDay.getDate()).padStart(2, '0')}`;
        const dayLabel = dayType === 'half' ? 'Half Day' : 'Full Day';
        childNames.forEach(childName => {
            events.push([
                'BEGIN:VEVENT',
                `UID:${uid()}`,
                `DTSTAMP:${now}`,
                `DTSTART;VALUE=DATE:${dtStart}`,
                `DTEND;VALUE=DATE:${dtEnd}`,
                `SUMMARY:MDO \u2014 ${childName} \u2014 ${dayLabel}`,
                `DESCRIPTION:${desc}`,
                'END:VEVENT',
            ].join('\r\n'));
        });
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

function downloadIcal(sortedDates, childNames, parentName) {
    if (!sortedDates.length) { showToast('No dates to export.'); return; }
    const ical     = generateIcal(sortedDates, childNames, parentName);
    const blob     = new Blob([ical], { type: 'text/calendar;charset=utf-8' });
    const url      = URL.createObjectURL(blob);
    const a        = document.createElement('a');
    const safeName = childNames.join('-').replace(/\s+/g, '').slice(0, 24);
    a.href         = url;
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

    if (!openBtn) return; // guard

    openBtn.addEventListener('click', () => { modal.style.display = 'flex'; });
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

    successCl.addEventListener('click', () => { successM.style.display = 'none'; });

    form.addEventListener('submit', async e => {
        e.preventDefault();
        const btn = document.getElementById('wlSubmitBtn');

        // Validate days
        const days = [...document.querySelectorAll('.wlDay:checked')].map(cb => cb.value);
        if (!days.length) { showToast('Please select at least one day.'); return; }

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
            days_of_week:       days.join(','),
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
