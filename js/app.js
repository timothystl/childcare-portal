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
let selectedRoom        = null;
let selectedDates       = new Map();   // 'YYYY-MM-DD' -> { status: 'confirmed'|'waitlist', dayType: 'full'|'half' }
let capacityCache       = {};
let closureMap          = new Map();   // 'YYYY-MM-DD' -> reason string
let calendarLoading     = false;
let pickerOpenDate      = null;
let regWindowOverride   = 'auto';      // 'auto' | 'open' | 'closed' — loaded from Supabase settings

// ============================================================
// REGISTRATION WINDOW  (Items 6 & 7)
// - Target: always the NEXT calendar month
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

    // Target: always the NEXT calendar month
    const targetDate  = new Date(year, month + 1, 1);
    const targetLabel = MONTH_NAMES[targetDate.getMonth()] + ' ' + targetDate.getFullYear();

    // Deadline label: "February 20" (20th of the current month)
    const deadlineDate  = new Date(year, month, 20);
    const deadlineLabel = deadlineDate.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });

    // mode: confirmed (1-20), waitlist (21+)
    let mode = day <= 20 ? 'confirmed' : 'waitlist';

    // Admin override takes precedence
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
    // Load admin override before computing the window state
    regWindowOverride = (await fetchSetting('reg_window_override')) || 'auto';

    const win            = getRegistrationWindow();
    const targetMonthKey = getTargetMonthKey();

    // Set calendar to show the target month
    currentDate = new Date(win.targetDate.getFullYear(), win.targetDate.getMonth(), 1);

    // Check localStorage for already-submitted flag
    const alreadySubmitted = localStorage.getItem(`childcare_submitted_${targetMonthKey}`) === 'true';

    // Update the registration window banner
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

    // Update submit button based on mode
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

    renderRooms();
    setupFormListeners();

    // Load closures and build map (date -> reason) for Item 3
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

// ============================================================
// ROOM CARDS
// ============================================================
function renderRooms() {
    const grid = document.getElementById('roomGrid');
    grid.innerHTML = ROOMS.map(room => {
        const rateStr = room.fullDayOnly
            ? `$${room.fullDayRate} / day &nbsp;·&nbsp; Full day only`
            : `Full day $${room.fullDayRate} &nbsp;·&nbsp; Half day $${room.halfDayRate}`;
        return `
        <label class="room-option" data-room="${room.id}">
            <input type="radio" name="room" value="${room.id}">
            <div class="room-card">
                <h3>${room.label}</h3>
                <p class="room-ages">${room.ages}</p>
                <span class="cap-badge">Max ${room.capacity} children</span>
                <p class="room-rate">${rateStr}</p>
            </div>
        </label>`;
    }).join('');

    grid.querySelectorAll('input[name="room"]').forEach(radio => {
        radio.addEventListener('change', onRoomChange);
    });
}

// Called when the DOB field changes — auto-selects the right room
function onDobChange() {
    const dob    = document.getElementById('childDob').value;
    const roomId = getRoomIdFromDob(dob);

    document.querySelectorAll('.room-option').forEach(label => {
        const radio = label.querySelector('input[type="radio"]');
        const rid   = radio.value;

        if (!roomId) {
            label.classList.remove('locked');
            radio.disabled = false;
            label.querySelector('.age-lock-msg')?.remove();
            return;
        }

        if (rid !== roomId) {
            label.classList.add('locked');
            radio.disabled = true;
            if (!label.querySelector('.age-lock-msg')) {
                const msg = document.createElement('p');
                msg.className   = 'age-lock-msg';
                msg.textContent = 'Not this age group';
                label.querySelector('.room-card').appendChild(msg);
            }
        } else {
            label.classList.remove('locked');
            radio.disabled = false;
            label.querySelector('.age-lock-msg')?.remove();
            if (!radio.checked) {
                radio.checked = true;
                radio.dispatchEvent(new Event('change'));
            }
        }
    });
}

async function onRoomChange(e) {
    selectedRoom  = ROOMS.find(r => r.id === e.target.value);
    selectedDates = new Map();
    capacityCache = {};
    closeDayPicker();

    document.getElementById('calendarWrapper').classList.remove('hidden');
    document.getElementById('calendarHint').classList.add('hidden');

    await loadMonthCapacity();
    renderCalendar();
    renderSelectedDates();
}

// ============================================================
// CAPACITY
// ============================================================
async function loadMonthCapacity() {
    if (!selectedRoom) return;
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
    capacityCache   = await fetchCapacityForDates(selectedRoom.id, dates);
    calendarLoading = false;
}

function getDateStatus(dateStr) {
    if (!selectedRoom) return 'disabled';
    const booked   = capacityCache[dateStr] || 0;
    const capacity = selectedRoom.capacity;
    if (booked >= capacity)     return 'full';
    if (booked >= capacity - 3) return 'limited';
    return 'available';
}

function spotsLeft(dateStr) {
    if (!selectedRoom) return 0;
    return Math.max(0, selectedRoom.capacity - (capacityCache[dateStr] || 0));
}

// ============================================================
// CALENDAR — Mon–Fri only, closed days blocked (Item 3: reason shown)
// ============================================================
function renderCalendar() {
    const year        = currentDate.getFullYear();
    const month       = currentDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today       = new Date(); today.setHours(0, 0, 0, 0);
    const firstDow    = new Date(year, month, 1).getDay();

    document.getElementById('currentMonthLabel').textContent = `${MONTH_NAMES[month]} ${year}`;

    // Update nav button states — only the target month is navigable
    const win     = getRegistrationWindow();
    const target  = win.targetDate;
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
            // Item 3: show the reason for the closure if available
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
    if (!selectedRoom) return;

    if (selectedDates.has(dateStr)) {
        selectedDates.delete(dateStr);
        closeDayPicker();
        renderCalendar();
        renderSelectedDates();
        return;
    }

    if (status === 'full') {
        closeDayPicker();
        const join = confirm(`This day is full (${selectedRoom.label}).\n\nJoin the waitlist for this date?`);
        if (join) {
            selectedDates.set(dateStr, { status: 'waitlist', dayType: 'full' });
            renderCalendar();
            renderSelectedDates();
        }
        return;
    }

    if (selectedRoom.fullDayOnly) {
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

    // Translucent backdrop so popup always reads clearly
    const backdrop = document.createElement('div');
    backdrop.id        = 'dayPickerBackdrop';
    backdrop.className = 'day-picker-backdrop';
    backdrop.addEventListener('click', e => {
        e.stopPropagation();
        closeDayPicker();
        renderCalendar();
    });
    document.body.appendChild(backdrop);

    const popup = document.createElement('div');
    popup.id        = 'dayPickerPopup';
    popup.className = 'day-picker-popup';
    popup.innerHTML = `
        <p class="picker-title">${friendlyDate(dateStr)}</p>
        <div class="picker-buttons">
            <button type="button" class="picker-btn" data-date="${dateStr}" data-type="full">
                <span class="picker-label">Full Day</span>
                <span class="picker-rate">$${selectedRoom.fullDayRate}</span>
            </button>
            <button type="button" class="picker-btn" data-date="${dateStr}" data-type="half">
                <span class="picker-label">Half Day</span>
                <span class="picker-rate">$${selectedRoom.halfDayRate}</span>
            </button>
        </div>
        <button type="button" class="picker-cancel">✕ Cancel</button>
    `;

    document.body.appendChild(popup);

    // Always anchor to viewport center so it's visible regardless of scroll position
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
// SELECTED DATES + BILLING TOTAL
// ============================================================
function calcTotal() {
    if (!selectedRoom) return 0;
    let total = 0;
    for (const [, entry] of selectedDates) {
        if (entry.status === 'waitlist') continue;
        total += (entry.dayType === 'half' ? selectedRoom.halfDayRate : selectedRoom.fullDayRate) || 0;
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
        if (!isWaitlist) {
            const typeText = entry.dayType === 'half' ? 'Half Day' : 'Full Day';
            const rate     = entry.dayType === 'half' ? selectedRoom.halfDayRate : selectedRoom.fullDayRate;
            dayTypeLabel   = `<span class="day-type-label">${typeText} — $${rate}</span>`;
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

    document.getElementById('childDob').addEventListener('change', onDobChange);

    // Navigation: restricted to target month only
    document.getElementById('prevMonth').addEventListener('click', async () => {
        closeDayPicker();
        const target = getRegistrationWindow().targetDate;
        const atTarget = currentDate.getFullYear() === target.getFullYear() &&
                         currentDate.getMonth()    === target.getMonth();
        if (atTarget) return;   // Can't go below target month
        currentDate.setMonth(currentDate.getMonth() - 1);
        await loadMonthCapacity();
        renderCalendar();
    });

    document.getElementById('nextMonth').addEventListener('click', async () => {
        closeDayPicker();
        const target = getRegistrationWindow().targetDate;
        const atTarget = currentDate.getFullYear() === target.getFullYear() &&
                         currentDate.getMonth()    === target.getMonth();
        if (atTarget) return;   // Can't go above target month
        currentDate.setMonth(currentDate.getMonth() + 1);
        await loadMonthCapacity();
        renderCalendar();
    });
}

// ============================================================
// FORM SUBMISSION (Items 4 & 7)
// ============================================================
async function handleSubmit(e) {
    e.preventDefault();
    closeDayPicker();

    const win            = getRegistrationWindow();
    const targetMonthKey = getTargetMonthKey();

    // Guard: registration window closed by admin?
    if (win.mode === 'closed') {
        showToast(`🔒 Registration is currently closed by admin.`);
        return;
    }

    // Guard: already submitted (localStorage)?
    if (localStorage.getItem(`childcare_submitted_${targetMonthKey}`) === 'true') {
        showToast(`✅ You've already registered for ${win.targetLabel}. Contact us to make changes.`);
        return;
    }

    const parentName  = document.getElementById('parentName').value.trim();
    const parentEmail = document.getElementById('parentEmail').value.trim();
    const parentPhone = document.getElementById('parentPhone').value.trim();
    const childName   = document.getElementById('childName').value.trim();
    const childDob    = document.getElementById('childDob').value;

    if (!parentName || !parentEmail || !parentPhone || !childName || !childDob) {
        showToast('Please fill in all required fields.');
        return;
    }
    if (!selectedRoom) {
        showToast('Please select a room / age group.');
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
        // Guard: server-side duplicate check (Item 7)
        const alreadyReg = await checkExistingRegistration(parentEmail, targetMonthKey);
        if (alreadyReg) {
            showToast(`⚠️ A registration for ${win.targetLabel} already exists for this email. Please contact us to make changes.`);
            btn.disabled    = false;
            btn.textContent = 'Submit Registration';
            return;
        }

        // In waitlist mode ALL dates go on the waitlist regardless of room availability
        let confirmedDates, waitlistDates, regStatus;
        if (win.mode === 'waitlist') {
            confirmedDates = [];
            waitlistDates  = [...selectedDates.entries()]
                .map(([d, en]) => ({ date: d, dayType: en.dayType }));
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

        const total     = calcTotal();
        const ageMonths = calcAgeMonths(childDob);

        await submitRegistration({
            parent: { name: parentName, email: parentEmail, phone: parentPhone },
            child:  { name: childName, ageMonths, dob: childDob },
            roomId: selectedRoom.id,
            confirmedDates,
            waitlistDates,
            status: regStatus,
        });

        // Mark as submitted in localStorage (Item 7)
        localStorage.setItem(`childcare_submitted_${targetMonthKey}`, 'true');

        // Build itemized receipt (Item 4)
        const confirmedSorted = confirmedDates
            .slice()
            .sort((a, b) => a.date.localeCompare(b.date));

        let receiptHtml = '';
        if (confirmedSorted.length) {
            const receiptRows = confirmedSorted.map(({ date, dayType }) => {
                const typeLabel = dayType === 'half' ? 'Half Day' : 'Full Day';
                const rate      = dayType === 'half' ? selectedRoom.halfDayRate : selectedRoom.fullDayRate;
                return `<tr>
                    <td>${friendlyDate(date)}</td>
                    <td>${typeLabel}</td>
                    <td class="receipt-amount">$${rate}</td>
                </tr>`;
            }).join('');

            receiptHtml = `
                <table class="receipt-table">
                    <thead>
                        <tr><th>Date</th><th>Type</th><th>Amount</th></tr>
                    </thead>
                    <tbody>${receiptRows}</tbody>
                    <tfoot>
                        <tr class="receipt-total-row">
                            <td colspan="2"><strong>Total</strong></td>
                            <td class="receipt-amount"><strong>$${total.toFixed(2)}</strong></td>
                        </tr>
                    </tfoot>
                </table>`;
        }

        let details = `<p>Registration for <strong>${childName}</strong> in <strong>${selectedRoom.label}</strong>.</p>`;
        details += receiptHtml;
        if (win.mode === 'waitlist') {
            details += `<p class="receipt-waitlist-note">⏳ <strong>Waitlist submission</strong> — all ${waitlistDates.length} day(s) are pending admin approval. We'll contact you at <strong>${parentEmail}</strong> once approved.</p>`;
        } else if (waitlistDates.length) {
            details += `<p class="receipt-waitlist-note"><strong>${waitlistDates.length}</strong> day(s) on waitlist — we'll contact you at <strong>${parentEmail}</strong> if a spot opens.</p>`;
        }

        document.getElementById('successDetails').innerHTML = details;
        document.getElementById('successModal').style.display = 'flex';

        // Reset form
        document.getElementById('registrationForm').reset();
        selectedRoom  = null;
        selectedDates = new Map();
        capacityCache = {};
        document.getElementById('calendarWrapper').classList.add('hidden');
        document.getElementById('calendarHint').classList.remove('hidden');
        document.querySelectorAll('.room-option').forEach(label => {
            label.classList.remove('locked');
            label.querySelector('input').disabled = false;
            label.querySelector('.age-lock-msg')?.remove();
        });
        renderSelectedDates();

        // Update UI to show submitted state (Item 7)
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
