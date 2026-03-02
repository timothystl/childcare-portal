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
let selectedChildren    = [];       // [{ name, dob, room: ROOMS[i], isNew: bool, studentId: string|null }]
let selectedDates       = new Map();  // 'YYYY-MM-DD' -> { dayType: 'full'|'half' }
let capacityCache       = {};         // { roomId: { 'YYYY-MM-DD': count } }
let closureMap          = new Map();  // 'YYYY-MM-DD' -> reason string
let calendarLoading     = false;
let pickerOpenDate      = null;
let regWindowOverride   = 'auto';     // 'auto' | 'open' | 'closed'

// ============================================================
// REGISTRATION WINDOW
// - mode 'confirmed' : day 1–20  → form enabled, dates saved as confirmed
// - mode 'closed'    : day 21+   → registration closed (no waitlist)
// ============================================================
function getRegistrationWindow() {
    const today  = new Date();
    today.setHours(0, 0, 0, 0);
    const day    = today.getDate();
    const year   = today.getFullYear();
    const month  = today.getMonth();

    const targetDate  = new Date(year, month + 1, 1);
    const targetLabel = MONTH_NAMES[targetDate.getMonth()] + ' ' + targetDate.getFullYear();

    const deadlineDate  = new Date(year, month, 20);
    const deadlineLabel = deadlineDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

    let mode = day <= 20 ? 'confirmed' : 'closed';
    if (regWindowOverride === 'open')   mode = 'confirmed';
    if (regWindowOverride === 'closed') mode = 'closed';

    return { mode, targetDate, targetLabel, deadlineLabel };
}

function getTargetMonthKey() {
    const { targetDate } = getRegistrationWindow();
    return `${targetDate.getFullYear()}-${String(targetDate.getMonth() + 1).padStart(2, '0')}`;
}

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', async () => {
    regWindowOverride = (await fetchSetting('reg_window_override')) || 'auto';

    const win            = getRegistrationWindow();
    const targetMonthKey = getTargetMonthKey();

    currentDate = new Date(win.targetDate.getFullYear(), win.targetDate.getMonth(), 1);

    // Show window open/closed status — no "already submitted" check on load
    const banner = document.getElementById('regWindowBanner');
    if (banner) {
        if (win.mode === 'closed') {
            banner.className = 'reg-window-banner locked';
            banner.innerHTML = `🔒 Registration for <strong>${win.targetLabel}</strong> is currently closed. Deadline was <strong>${win.deadlineLabel}</strong>.`;
        } else {
            banner.className = 'reg-window-banner open';
            banner.innerHTML = `📅 Now accepting registrations for <strong>${win.targetLabel}</strong>. Deadline: <strong>${win.deadlineLabel}</strong>.`;
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

    const closures = await fetchClosures();
    closureMap = new Map(closures.map(c => [c.close_date, c.reason || '']));
});

// ============================================================
// AGE / DOB HELPERS
// ============================================================
function calcAgeMonths(dobStr) {
    const today = new Date();
    const birth = new Date(dobStr + 'T00:00:00');
    return (today.getFullYear() - birth.getFullYear()) * 12
         + (today.getMonth() - birth.getMonth());
}

function getRoomIdFromDob(dobStr) {
    if (!dobStr) return null;
    const months = calcAgeMonths(dobStr);
    if (months < 0)  return null;
    if (months < 12) return 'bear';
    if (months < 24) return 'bee';
    if (months < 36) return 'turtle';
    return 'owl';
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
    const searchInput = document.getElementById('familySearchInput');
    const searchBtn   = document.getElementById('familySearchBtn');
    const pinInput    = document.getElementById('familyPinInput');
    const pinBtn      = document.getElementById('familyPinBtn');

    let searchTimer;
    searchInput?.addEventListener('input', () => {
        clearTimeout(searchTimer);
        searchTimer = setTimeout(runFamilySearch, 380);
    });
    searchInput?.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); runFamilySearch(); }
    });
    searchBtn?.addEventListener('click', runFamilySearch);

    pinInput?.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); runPinLookup(); }
    });
    pinBtn?.addEventListener('click', runPinLookup);

    document.getElementById('changeFamilyBtn')?.addEventListener('click', resetFamilyLookup);
}

async function runFamilySearch() {
    const query     = document.getElementById('familySearchInput')?.value.trim();
    const resultsEl = document.getElementById('familySearchResults');
    if (!resultsEl) return;
    if (!query || query.length < 2) { resultsEl.innerHTML = ''; return; }

    resultsEl.innerHTML = '<div class="lookup-searching">Searching…</div>';
    try {
        const families = await searchFamilies(query);
        renderFamilySearchResults(families, query);
    } catch {
        resultsEl.innerHTML = '<div class="lookup-error">Search failed. Please try again.</div>';
    }
}

async function runPinLookup() {
    const pin    = document.getElementById('familyPinInput')?.value.trim();
    const pinBtn = document.getElementById('familyPinBtn');
    if (!pin || pin.length !== 4) { showToast('Please enter your 4-digit family PIN.'); return; }

    if (pinBtn) { pinBtn.textContent = 'Looking up…'; pinBtn.disabled = true; }
    try {
        const family = await lookupFamilyByPin(pin);
        if (family) {
            document.getElementById('familySearchResults').innerHTML = '';
            selectFamily(family);
        } else {
            showToast(`No family found for PIN ${pin}. Please check and try again.`);
        }
    } catch {
        showToast('PIN lookup failed. Please try again.');
    } finally {
        if (pinBtn) { pinBtn.textContent = 'Look Up'; pinBtn.disabled = false; }
    }
}

function renderFamilySearchResults(families, query) {
    const resultsEl = document.getElementById('familySearchResults');
    if (!families.length) {
        resultsEl.innerHTML = `<div class="lookup-no-results">No family found for "<strong>${escStr(query)}</strong>". Please contact the office to be added to the system.</div>`;
        return;
    }
    resultsEl.innerHTML = families.map(f => {
        const kids = (f.students || []).length;
        return `<div class="family-result-item" data-id="${f.id}">
            <span class="family-result-name">${escStr(f.parent_name)}</span>
            <span class="family-result-meta">${escStr(f.parent_email || '')}${kids ? ` &middot; ${kids} child${kids > 1 ? 'ren' : ''}` : ''}</span>
        </div>`;
    }).join('');

    resultsEl.querySelectorAll('.family-result-item').forEach(el => {
        el.addEventListener('click', () => {
            const fam = families.find(f => String(f.id) === el.dataset.id);
            if (fam) selectFamily(fam);
        });
    });
}

function selectFamily(family) {
    selectedFamily = family;
    document.getElementById('familySearchResults').innerHTML = '';

    setPrefilled('parentName',  family.parent_name);
    setPrefilled('parentEmail', family.parent_email);
    setPrefilled('parentPhone', family.parent_phone);

    const bar = document.getElementById('familySelectedBar');
    if (bar) bar.classList.remove('hidden');
    const nameEl = document.getElementById('selectedFamilyName');
    if (nameEl) nameEl.textContent = family.parent_name;
    const pinEl = document.getElementById('selectedFamilyPin');
    if (pinEl) {
        pinEl.textContent = family.pin ? `PIN: ${family.pin}` : '';
        pinEl.style.display = family.pin ? '' : 'none';
    }

    document.getElementById('lookupRequiredMsg')?.classList.add('hidden');
    document.getElementById('registrationSteps')?.classList.remove('hidden');

    renderChildSection();
}

function resetFamilyLookup() {
    selectedFamily   = null;
    selectedChildren = [];

    const searchInput = document.getElementById('familySearchInput');
    const pinInput    = document.getElementById('familyPinInput');
    if (searchInput) searchInput.value = '';
    if (pinInput)    pinInput.value    = '';
    const resultsEl = document.getElementById('familySearchResults');
    if (resultsEl) resultsEl.innerHTML = '';

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

    section.innerHTML = `
        <div class="child-cards-row">
            ${students.map(s => {
                const room       = getRoomForStudent(s);
                const isSelected = selectedChildren.some(c => c.studentId === s.id);
                const dobLabel   = s.child_dob
                    ? new Date(s.child_dob + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : '';
                const overrideNote = s.room_override
                    ? `<span class="child-card-override">Assigned by office</span>` : '';
                return `<label class="child-card-label${isSelected ? ' selected' : ''}" data-student-id="${s.id}">
                    <input type="checkbox" class="child-card-checkbox"
                           data-student-id="${s.id}"
                           data-name="${escStr(s.child_name)}"
                           data-dob="${escStr(s.child_dob || '')}"
                           data-room-override="${escStr(s.room_override || '')}"
                           ${isSelected ? 'checked' : ''}>
                    <span class="child-card-name">${escStr(s.child_name)}</span>
                    ${dobLabel ? `<span class="child-card-dob">${dobLabel}</span>` : ''}
                    ${room ? `<span class="child-card-room">${room.label}</span>` : '<span class="child-card-room" style="background:#fff5f5;color:#e53e3e;">Age not set</span>'}
                    ${overrideNote}
                </label>`;
            }).join('')}
        </div>`;

    section.querySelectorAll('.child-card-checkbox').forEach(cb => {
        cb.addEventListener('change', () => {
            const studentId    = cb.dataset.studentId;
            const childName    = cb.dataset.name;
            const childDob     = cb.dataset.dob;
            const roomOverride = cb.dataset.roomOverride || null;
            const room = getRoomForStudent({ child_dob: childDob, room_override: roomOverride });
            if (!room) {
                cb.checked = false;
                showToast(`Could not assign a room for ${childName} — please check their date of birth.`);
                return;
            }
            cb.closest('.child-card-label').classList.toggle('selected', cb.checked);
            if (cb.checked) {
                if (!selectedChildren.some(c => c.studentId === studentId)) {
                    selectedChildren.push({ name: childName, dob: childDob, room, isNew: false, studentId });
                    onChildrenChanged();
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
    let worstStatus = 'available';
    for (const child of selectedChildren) {
        const booked   = (capacityCache[child.room.id] || {})[dateStr] || 0;
        const capacity = child.room.capacity;
        if (booked >= capacity)     return 'full';
        if (booked >= capacity - 3) worstStatus = 'limited';
    }
    return worstStatus;
}

function spotsLeft(dateStr) {
    if (!selectedChildren.length) return 0;
    return Math.min(...selectedChildren.map(child => {
        const booked = (capacityCache[child.room.id] || {})[dateStr] || 0;
        return Math.max(0, child.room.capacity - booked);
    }));
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
        cell.className = `cal-day ${status}${isSelected ? ' selected' : ''}${isPickerOpen ? ' picker-active' : ''}`;
        cell.setAttribute('data-date', dateStr);

        let badge = '';
        if (isSelected && entry) {
            badge = entry.dayType === 'half'
                ? '<span class="selected-type-badge">½ day</span>'
                : '<span class="selected-type-badge">Full</span>';
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
// SELECTED DATES + BILLING TOTAL (multi-child aware)
// ============================================================
function calcTotal() {
    if (!selectedChildren.length) return 0;
    let total = 0;
    for (const [, entry] of selectedDates) {
        for (const child of selectedChildren) {
            total += entry.dayType === 'half'
                ? (child.room.halfDayRate || 0)
                : (child.room.fullDayRate || 0);
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

    const sorted = [...selectedDates.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const rows = sorted.map(([dateStr, entry]) => {
        let dayTypeLabel = '';
        if (selectedChildren.length) {
            const typeText  = entry.dayType === 'half' ? 'Half Day' : 'Full Day';
            const lineTotal = selectedChildren.reduce((s, c) =>
                s + (entry.dayType === 'half' ? (c.room.halfDayRate || 0) : (c.room.fullDayRate || 0)), 0);
            if (selectedChildren.length === 1) {
                dayTypeLabel = `<span class="day-type-label">${typeText} — $${lineTotal}</span>`;
            } else {
                const breakdown = selectedChildren
                    .map(c => `${escStr(c.name)}: $${entry.dayType === 'half' ? (c.room.halfDayRate || 0) : (c.room.fullDayRate || 0)}`)
                    .join(' · ');
                dayTypeLabel = `<span class="day-type-label">${typeText} — $${lineTotal}</span><span class="rate-breakdown">${breakdown}</span>`;
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

    const total = calcTotal();
    container.innerHTML = `
        <ul class="date-list">${rows}</ul>
        <div class="billing-total">
            Estimated total: <strong>$${total.toFixed(2)}</strong>
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
            banner.innerHTML = `🔒 Registration for <strong>${win.targetLabel}</strong> is currently closed.`;
        } else {
            banner.className = 'reg-window-banner open';
            banner.innerHTML = `📅 Now accepting registrations for <strong>${win.targetLabel}</strong>. Deadline: <strong>${win.deadlineLabel}</strong>.`;
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

    document.getElementById('prevMonth').addEventListener('click', async () => {
        closeDayPicker();
        const target   = getRegistrationWindow().targetDate;
        const atTarget = currentDate.getFullYear() === target.getFullYear() &&
                         currentDate.getMonth()    === target.getMonth();
        if (atTarget) return;
        currentDate.setMonth(currentDate.getMonth() - 1);
        await loadMonthCapacity();
        renderCalendar();
    });

    document.getElementById('nextMonth').addEventListener('click', async () => {
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

        for (const child of selectedChildren) {
            // Hard block: one submission per child per month, across all devices.
            // Checks Supabase directly so a different computer cannot bypass it.
            const existingReg = await checkExistingRegistration(parentEmail, targetMonthKey, child.name);
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
                });
                results.push({ child, reg });
            } catch (childErr) {
                errors.push(`${child.name}: ${childErr.message}`);
            }
        }

        if (!results.length) {
            errors.forEach(err => showToast('⚠️ ' + err));
            btn.disabled    = false;
            btn.textContent = 'Submit Registration';
            return;
        }

        localStorage.setItem(`childcare_submitted_${targetMonthKey}`, 'true');

        // Build itemized receipt
        const sortedDates = confirmedDates.slice().sort((a, b) => a.date.localeCompare(b.date));
        let receiptHtml = '';
        if (sortedDates.length) {
            const receiptRows = sortedDates.map(({ date, dayType }) => {
                const typeLabel  = dayType === 'half' ? 'Half Day' : 'Full Day';
                const lineTotal  = results.reduce((s, { child }) =>
                    s + (dayType === 'half' ? (child.room.halfDayRate || 0) : (child.room.fullDayRate || 0)), 0);
                return `<tr>
                    <td>${friendlyDate(date)}</td>
                    <td>${typeLabel}</td>
                    <td class="receipt-amount">$${lineTotal}</td>
                </tr>`;
            }).join('');

            const grandTotal = results.reduce((s, { child }) =>
                sortedDates.reduce((ss, { dayType }) =>
                    ss + (dayType === 'half' ? (child.room.halfDayRate || 0) : (child.room.fullDayRate || 0)), s), 0);

            receiptHtml = `
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

        // Print schedule button (no mailto — opens a print-friendly popup in-browser)
        details += `<div style="margin-top:18px;text-align:center;">
            <button type="button" id="printScheduleBtn" class="btn-print-schedule">🖨️ Print / Save Schedule</button>
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
function escStr(str) {
    return String(str ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
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
