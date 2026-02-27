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
let selectedDates       = new Map();  // 'YYYY-MM-DD' -> { status: 'confirmed'|'waitlist', dayType: 'full'|'half' }
let capacityCache       = {};         // { roomId: { 'YYYY-MM-DD': count } }
let closureMap          = new Map();  // 'YYYY-MM-DD' -> reason string
let calendarLoading     = false;
let pickerOpenDate      = null;
let regWindowOverride   = 'auto';     // 'auto' | 'open' | 'closed' — loaded from Supabase settings

// ============================================================
// REGISTRATION WINDOW  (Items 6 & 7)
// - mode 'confirmed' : day 1–20  → form enabled, dates saved as confirmed
// - mode 'waitlist'  : day 21+   → form enabled, ALL dates saved as waitlisted
// - mode 'closed'    : admin override only — hard disables form
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

    let mode = day <= 20 ? 'confirmed' : 'waitlist';
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

    const alreadySubmitted = localStorage.getItem(`childcare_submitted_${targetMonthKey}`) === 'true';

    const banner = document.getElementById('regWindowBanner');
    if (banner) {
        if (alreadySubmitted) {
            banner.className = 'reg-window-banner submitted';
            banner.innerHTML = `✅ Your registration for <strong>${win.targetLabel}</strong> has been submitted. Please contact us to make any changes.`;
        } else if (win.mode === 'closed') {
            banner.className = 'reg-window-banner locked';
            banner.innerHTML = `🔒 Registration is currently closed by admin.`;
        } else if (win.mode === 'waitlist') {
            banner.className = 'reg-window-banner waitlist';
            banner.innerHTML = `⚠️ The deadline has passed for <strong>${win.targetLabel}</strong>. You can still submit — your registration will be placed on the <strong>waitlist</strong> for admin review.`;
        } else {
            banner.className = 'reg-window-banner open';
            banner.innerHTML = `📅 Now accepting registrations for <strong>${win.targetLabel}</strong>. Deadline: <strong>${win.deadlineLabel}</strong>.`;
        }
    }

    const btn = document.getElementById('submitBtn');
    if (btn) {
        if (alreadySubmitted) {
            btn.disabled    = true;
            btn.textContent = 'Already Submitted';
        } else if (win.mode === 'closed') {
            btn.disabled    = true;
            btn.textContent = 'Registration Closed';
        } else if (win.mode === 'waitlist') {
            btn.disabled    = false;
            btn.textContent = 'Submit to Waitlist';
        } else {
            btn.disabled    = false;
            btn.textContent = 'Submit Registration';
        }
    }

    setupFamilyLookup();
    setupFormListeners();

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

    // Pre-fill parent fields (read-only)
    setPrefilled('parentName',  family.parent_name);
    setPrefilled('parentEmail', family.parent_email);
    setPrefilled('parentPhone', family.parent_phone);

    // Show selected bar
    const bar = document.getElementById('familySelectedBar');
    if (bar) bar.classList.remove('hidden');
    const nameEl = document.getElementById('selectedFamilyName');
    if (nameEl) nameEl.textContent = family.parent_name;
    const pinEl = document.getElementById('selectedFamilyPin');
    if (pinEl) {
        pinEl.textContent = family.pin ? `PIN: ${family.pin}` : '';
        pinEl.style.display = family.pin ? '' : 'none';
    }

    // Unlock registration steps
    document.getElementById('lookupRequiredMsg')?.classList.add('hidden');
    document.getElementById('registrationSteps')?.classList.remove('hidden');

    // Render child section with family's existing children
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

    // Lock registration steps again
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
// CHILD SECTION  (Item 8 — multi-child same dates)
// ============================================================
function addChild(child) {
    if (selectedChildren.some(c => c.name === child.name && c.dob === child.dob)) {
        showToast(`${child.name} is already added.`);
        return;
    }
    selectedChildren.push(child);
    renderChildSection();
    onChildrenChanged();
}

function removeChild(index) {
    selectedChildren.splice(index, 1);
    renderChildSection();
    onChildrenChanged();
}

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
                const room       = getRoomFromDob(s.child_dob);
                const isSelected = selectedChildren.some(c => c.studentId === s.id);
                const dobLabel   = s.child_dob
                    ? new Date(s.child_dob + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
                    : '';
                return `<label class="child-card-label${isSelected ? ' selected' : ''}" data-student-id="${s.id}">
                    <input type="checkbox" class="child-card-checkbox"
                           data-student-id="${s.id}"
                           data-name="${escStr(s.child_name)}"
                           data-dob="${escStr(s.child_dob || '')}"
                           ${isSelected ? 'checked' : ''}>
                    <span class="child-card-name">${escStr(s.child_name)}</span>
                    ${dobLabel ? `<span class="child-card-dob">${dobLabel}</span>` : ''}
                    ${room ? `<span class="child-card-room">${room.label}</span>` : '<span class="child-card-room" style="background:#fff5f5;color:#e53e3e;">Age not set</span>'}
                </label>`;
            }).join('')}
        </div>`;

    // Bind checkboxes
    section.querySelectorAll('.child-card-checkbox').forEach(cb => {
        cb.addEventListener('change', () => {
            const studentId = cb.dataset.studentId;
            const childName = cb.dataset.name;
            const childDob  = cb.dataset.dob;
            const room      = getRoomFromDob(childDob);
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
// CALENDAR — Mon–Fri only, closed days blocked (Item 3)
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
        } else if (!isPast && status === 'limited') {
            badge = `<span class="spot-badge limited-badge">${spotsLeft(dateStr)} left</span>`;
        }

        cell.innerHTML = `<span class="day-num">${d}</span>${badge}`;

        if (!isPast && !isClosed) {
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

    if (status === 'full') {
        closeDayPicker();
        const childNames = selectedChildren.map(c => c.name).join(' & ');
        const join = confirm(`This day is full for one or more rooms.\n\nAdd ${childNames} to the waitlist for this date?`);
        if (join) {
            selectedDates.set(dateStr, { status: 'waitlist', dayType: 'full' });
            renderCalendar();
            renderSelectedDates();
        }
        return;
    }

    const allFullDayOnly = selectedChildren.every(c => c.room.fullDayOnly);
    if (allFullDayOnly) {
        closeDayPicker();
        selectedDates.set(dateStr, { status: 'confirmed', dayType: 'full' });
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

    // Calculate combined rates across all children
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
                status:  'confirmed',
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
        if (entry.status === 'waitlist') continue;
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
        const isWaitlist  = entry.status === 'waitlist';
        const statusBadge = isWaitlist
            ? '<span class="waitlist-badge">Waitlist</span>'
            : '<span class="confirmed-badge">Confirmed</span>';

        let dayTypeLabel = '';
        if (!isWaitlist && selectedChildren.length) {
            const typeText   = entry.dayType === 'half' ? 'Half Day' : 'Full Day';
            const lineTotal  = selectedChildren.reduce((s, c) =>
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
                        ${statusBadge}
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
            <span class="billing-note">(waitlisted days not included)</span>
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
function setupFormListeners() {
    document.getElementById('registrationForm').addEventListener('submit', handleSubmit);

    document.getElementById('closeModal').addEventListener('click', () => {
        document.getElementById('successModal').style.display = 'none';
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
// FORM SUBMISSION (Items 4, 7, 8)
// ============================================================
async function handleSubmit(e) {
    e.preventDefault();
    closeDayPicker();

    const win            = getRegistrationWindow();
    const targetMonthKey = getTargetMonthKey();

    if (win.mode === 'closed') {
        showToast('🔒 Registration is currently closed by admin.');
        return;
    }

    if (!selectedFamily) {
        showToast('Please find your family using the lookup above to continue.');
        return;
    }

    if (localStorage.getItem(`childcare_submitted_${targetMonthKey}`) === 'true') {
        showToast(`✅ You've already registered for ${win.targetLabel}. Contact us to make changes.`);
        return;
    }

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
        // Build shared date lists (same for all children)
        let confirmedDates, waitlistDates, regStatus;
        if (win.mode === 'waitlist') {
            confirmedDates = [];
            waitlistDates  = [...selectedDates.entries()].map(([d, en]) => ({ date: d, dayType: en.dayType }));
            regStatus = 'pending_approval';
        } else {
            confirmedDates = [...selectedDates.entries()]
                .filter(([, en]) => en.status === 'confirmed')
                .map(([d, en]) => ({ date: d, dayType: en.dayType }));
            waitlistDates = [...selectedDates.entries()]
                .filter(([, en]) => en.status === 'waitlist')
                .map(([d, en]) => ({ date: d, dayType: en.dayType }));
            regStatus = 'confirmed';
        }

        // Submit one registration per child
        const results = [];
        const errors  = [];

        for (const child of selectedChildren) {
            // Check for duplicate (per child, not per family)
            const alreadyReg = await checkExistingRegistration(parentEmail, targetMonthKey, child.name);
            if (alreadyReg) {
                errors.push(`${child.name} is already registered for ${win.targetLabel}.`);
                continue;
            }
            try {
                const reg = await submitRegistration({
                    parent: { name: parentName, email: parentEmail, phone: parentPhone },
                    child:  { name: child.name, ageMonths: calcAgeMonths(child.dob), dob: child.dob },
                    roomId: child.room.id,
                    confirmedDates,
                    waitlistDates,
                    status: regStatus,
                });
                results.push({ child, reg });
            } catch (childErr) {
                errors.push(`${child.name}: ${childErr.message}`);
            }
        }

        if (!results.length) {
            errors.forEach(err => showToast('⚠️ ' + err));
            btn.disabled    = false;
            btn.textContent = win.mode === 'waitlist' ? 'Submit to Waitlist' : 'Submit Registration';
            return;
        }

        // Mark as submitted in localStorage
        localStorage.setItem(`childcare_submitted_${targetMonthKey}`, 'true');

        // Build itemized receipt
        const confirmedSorted = confirmedDates.slice().sort((a, b) => a.date.localeCompare(b.date));
        let receiptHtml = '';
        if (confirmedSorted.length) {
            const receiptRows = confirmedSorted.map(({ date, dayType }) => {
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
                confirmedSorted.reduce((ss, { dayType }) =>
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
        if (win.mode === 'waitlist') {
            details += `<p class="receipt-waitlist-note">⏳ <strong>Waitlist submission</strong> — all ${waitlistDates.length} day(s) are pending admin approval. We'll contact you at <strong>${parentEmail}</strong> once approved.</p>`;
        } else if (waitlistDates.length) {
            details += `<p class="receipt-waitlist-note"><strong>${waitlistDates.length}</strong> day(s) on waitlist — we'll contact you at <strong>${parentEmail}</strong> if a spot opens.</p>`;
        }
        if (errors.length) {
            details += `<p class="receipt-error-note">⚠️ Note: ${escStr(errors.join('; '))}</p>`;
        }

        document.getElementById('successDetails').innerHTML = details;
        document.getElementById('successModal').style.display = 'flex';

        // Reset form (keep family selected so parent can re-register next period)
        document.getElementById('registrationForm').reset();
        // Re-prefill parent fields since form.reset() clears them
        setPrefilled('parentName',  selectedFamily.parent_name);
        setPrefilled('parentEmail', selectedFamily.parent_email);
        setPrefilled('parentPhone', selectedFamily.parent_phone);
        selectedChildren = [];
        selectedDates    = new Map();
        capacityCache    = {};
        hideCalendar();
        renderChildSection();   // Re-render family's child cards (unchecked)
        renderSelectedDates();

        // Update banner/button
        const postBanner = document.getElementById('regWindowBanner');
        if (postBanner) {
            postBanner.className = 'reg-window-banner submitted';
            postBanner.innerHTML = win.mode === 'waitlist'
                ? `✅ Your waitlist request for <strong>${win.targetLabel}</strong> has been submitted. We'll be in touch soon.`
                : `✅ Your registration for <strong>${win.targetLabel}</strong> has been submitted. Contact us to make any changes.`;
        }
        btn.disabled    = true;
        btn.textContent = 'Already Submitted';

    } catch (err) {
        console.error(err);
        if (!SUPABASE_CONFIGURED) {
            showToast('⚙️ Database not connected yet.');
        } else {
            showToast('❌ Error: ' + (err?.message || JSON.stringify(err)));
        }
        btn.disabled    = false;
        btn.textContent = win.mode === 'waitlist' ? 'Submit to Waitlist' : 'Submit Registration';
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
