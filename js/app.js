// ============================================================
// STATE
// ============================================================
let currentDate     = new Date();
let selectedRoom    = null;          // room object from ROOMS array
let selectedDates   = new Map();     // 'YYYY-MM-DD' -> { status: 'confirmed'|'waitlist', dayType: 'full'|'half' }
let capacityCache   = {};            // 'YYYY-MM-DD' -> confirmed count
let calendarLoading = false;
let pickerOpenDate  = null;          // date string of currently open picker popup

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    renderRooms();
    setupListeners();
});

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
// CALENDAR  — Monday–Friday only (5-column grid)
// ============================================================
const MONTH_NAMES    = ['January','February','March','April','May','June',
                        'July','August','September','October','November','December'];
const DAY_HEADERS_MF = ['Mon','Tue','Wed','Thu','Fri'];

function renderCalendar() {
    const year        = currentDate.getFullYear();
    const month       = currentDate.getMonth();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today       = new Date(); today.setHours(0, 0, 0, 0);
    const firstDow    = new Date(year, month, 1).getDay(); // 0=Sun … 6=Sat

    document.getElementById('currentMonthLabel').textContent = `${MONTH_NAMES[month]} ${year}`;

    const cal = document.getElementById('calendar');
    cal.innerHTML = '';

    // Mon–Fri header row
    DAY_HEADERS_MF.forEach(h => {
        const el = document.createElement('div');
        el.className   = 'cal-header';
        el.textContent = h;
        cal.appendChild(el);
    });

    // Leading blank cells: Mon=1→0, Tue=2→1, Wed=3→2, Thu=4→3, Fri=5→4, Sat/Sun→0
    const leadingBlanks = (firstDow >= 1 && firstDow <= 5) ? firstDow - 1 : 0;
    for (let i = 0; i < leadingBlanks; i++) {
        const el = document.createElement('div');
        el.className = 'cal-day empty';
        cal.appendChild(el);
    }

    // Day cells — skip weekends
    for (let d = 1; d <= daysInMonth; d++) {
        const date    = new Date(year, month, d);
        const dow     = date.getDay();
        if (dow === 0 || dow === 6) continue;

        const dateStr    = formatDate(date);
        const isPast     = date < today;
        const status     = isPast ? 'past' : getDateStatus(dateStr);
        const entry      = selectedDates.get(dateStr);
        const isSelected = !!entry;
        const isPickerOpen = pickerOpenDate === dateStr;

        const cell = document.createElement('div');
        cell.className = `cal-day ${status}${isSelected ? ' selected' : ''}${isPickerOpen ? ' picker-active' : ''}`;
        cell.setAttribute('data-date', dateStr);

        // Badge: capacity status OR selected day type
        let badge = '';
        if (isSelected && entry) {
            badge = entry.dayType === 'half'
                ? '<span class="selected-type-badge">½ day</span>'
                : '<span class="selected-type-badge">Full</span>';
        } else if (!isPast && status === 'full') {
            badge = '<span class="spot-badge full-badge">Full</span>';
        } else if (!isPast && status === 'limited') {
            badge = `<span class="spot-badge limited-badge">${spotsLeft(dateStr)} left</span>`;
        }

        cell.innerHTML = `<span class="day-num">${d}</span>${badge}`;

        if (!isPast) {
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

    // Clicking a selected date deselects it
    if (selectedDates.has(dateStr)) {
        selectedDates.delete(dateStr);
        closeDayPicker();
        renderCalendar();
        renderSelectedDates();
        return;
    }

    // Full day — offer waitlist
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

    // Bear Room — full day only, no picker needed
    if (selectedRoom.fullDayOnly) {
        closeDayPicker();
        selectedDates.set(dateStr, { status: 'confirmed', dayType: 'full' });
        renderCalendar();
        renderSelectedDates();
        return;
    }

    // All other rooms — show Full/Half picker
    showDayPicker(dateStr, cellEl);
}

function showDayPicker(dateStr, cellEl) {
    closeDayPicker();
    pickerOpenDate = dateStr;
    renderCalendar(); // highlight the cell as picker-active

    const popup = document.createElement('div');
    popup.id        = 'dayPickerPopup';
    popup.className = 'day-picker-popup';
    popup.innerHTML = `
        <div class="picker-arrow"></div>
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

    // Position centered over the calendar grid so it's always visible
    const calRect = document.getElementById('calendar').getBoundingClientRect();

    popup.style.position  = 'fixed';
    popup.style.top       = (calRect.top + calRect.height / 2) + 'px';
    popup.style.left      = (calRect.left + calRect.width / 2) + 'px';
    popup.style.transform = 'translate(-50%, -50%)';

    // Button handlers
    popup.querySelectorAll('.picker-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            const ds    = btn.getAttribute('data-date');
            const dtype = btn.getAttribute('data-type');
            selectedDates.set(ds, { status: 'confirmed', dayType: dtype });
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

    // Close on outside click (deferred so this click doesn't immediately close it)
    setTimeout(() => {
        document.addEventListener('click', outsideClickHandler);
    }, 0);
}

function closeDayPicker() {
    const el = document.getElementById('dayPickerPopup');
    if (el) el.remove();
    if (pickerOpenDate) {
        pickerOpenDate = null;
    }
    document.removeEventListener('click', outsideClickHandler);
}

function outsideClickHandler(e) {
    const popup = document.getElementById('dayPickerPopup');
    if (popup && !popup.contains(e.target)) {
        pickerOpenDate = null;
        closeDayPicker();
        renderCalendar();
    }
}

// ============================================================
// SELECTED DATES LIST + BILLING TOTAL
// ============================================================
function calcTotal() {
    if (!selectedRoom) return 0;
    let total = 0;
    for (const [, entry] of selectedDates) {
        if (entry.status === 'waitlist') continue;
        const rate = (entry.dayType === 'half') ? selectedRoom.halfDayRate : selectedRoom.fullDayRate;
        total += rate || 0;
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
        const label      = friendlyDate(dateStr);
        const isWaitlist = entry.status === 'waitlist';
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
                        <span class="date-label">${label}</span>
                        ${statusBadge}
                        ${dayTypeLabel}
                    </div>
                    <button type="button" class="remove-btn" data-date="${dateStr}" aria-label="Remove ${label}">&times;</button>
                </div>
            </li>`;
    }).join('');

    const total    = calcTotal();
    const totalHtml = `
        <div class="billing-total">
            Estimated total: <strong>$${total.toFixed(2)}</strong>
            <span class="billing-note">(waitlisted days not included)</span>
        </div>`;

    container.innerHTML = `<ul class="date-list">${rows}</ul>${totalHtml}`;

    container.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            selectedDates.delete(e.currentTarget.getAttribute('data-date'));
            renderCalendar();
            renderSelectedDates();
        });
    });
}

// ============================================================
// FORM SUBMISSION
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('registrationForm').addEventListener('submit', handleSubmit);
    document.getElementById('closeModal').addEventListener('click', () => {
        document.getElementById('successModal').style.display = 'none';
    });
    document.getElementById('prevMonth').addEventListener('click', async () => {
        closeDayPicker();
        currentDate.setMonth(currentDate.getMonth() - 1);
        await loadMonthCapacity();
        renderCalendar();
    });
    document.getElementById('nextMonth').addEventListener('click', async () => {
        closeDayPicker();
        currentDate.setMonth(currentDate.getMonth() + 1);
        await loadMonthCapacity();
        renderCalendar();
    });
});

async function handleSubmit(e) {
    e.preventDefault();
    closeDayPicker();

    const parentName  = document.getElementById('parentName').value.trim();
    const parentEmail = document.getElementById('parentEmail').value.trim();
    const parentPhone = document.getElementById('parentPhone').value.trim();
    const childName   = document.getElementById('childName').value.trim();
    const childAge    = document.getElementById('childAge').value;

    if (!parentName || !parentEmail || !parentPhone || !childName || !childAge) {
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

    const confirmedDates = [...selectedDates.entries()]
        .filter(([, en]) => en.status === 'confirmed')
        .map(([d, en]) => ({ date: d, dayType: en.dayType }));
    const waitlistDates = [...selectedDates.entries()]
        .filter(([, en]) => en.status === 'waitlist')
        .map(([d, en]) => ({ date: d, dayType: en.dayType }));

    const total = calcTotal();

    try {
        await submitRegistration({
            parent: { name: parentName, email: parentEmail, phone: parentPhone },
            child:  { name: childName, age: parseInt(childAge) },
            roomId: selectedRoom.id,
            confirmedDates,
            waitlistDates,
        });

        let details = `<p>We've received the registration for <strong>${childName}</strong> in <strong>${selectedRoom.label}</strong>.</p>`;
        if (confirmedDates.length) details += `<p><strong>${confirmedDates.length}</strong> day(s) confirmed.</p>`;
        if (waitlistDates.length)  details += `<p><strong>${waitlistDates.length}</strong> day(s) on waitlist — we'll be in touch at <strong>${parentEmail}</strong> if a spot opens.</p>`;
        details += `<p class="total-line">Estimated total: <strong>$${total.toFixed(2)}</strong></p>`;

        document.getElementById('successDetails').innerHTML = details;
        document.getElementById('successModal').style.display = 'flex';

        document.getElementById('registrationForm').reset();
        selectedRoom  = null;
        selectedDates = new Map();
        capacityCache = {};
        document.getElementById('calendarWrapper').classList.add('hidden');
        document.getElementById('calendarHint').classList.remove('hidden');
        renderSelectedDates();

    } catch (err) {
        console.error(err);
        if (!SUPABASE_CONFIGURED) {
            showToast('⚙️ Database not connected yet. Follow the setup steps in README.md to link Supabase.');
        } else {
            const msg = err?.message || err?.error_description || JSON.stringify(err);
            showToast('❌ Error: ' + msg);
        }
    } finally {
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
    const d = new Date(dateStr + 'T00:00:00');
    return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function showToast(msg) {
    const t = document.getElementById('errorToast');
    t.textContent = msg;
    t.classList.remove('hidden');
    setTimeout(() => t.classList.add('hidden'), 4000);
}

function setupListeners() {}
