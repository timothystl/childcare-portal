// ============================================================
// STATE
// ============================================================
let currentDate     = new Date();
let selectedRoom    = null;          // room object from ROOMS array
let selectedDates   = new Map();     // 'YYYY-MM-DD' -> { status: 'confirmed'|'waitlist', dayType: 'full'|'half' }
let capacityCache   = {};            // 'YYYY-MM-DD' -> confirmed count
let calendarLoading = false;

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

    // Only fetch weekdays (Mon–Fri)
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
const MONTH_NAMES = ['January','February','March','April','May','June',
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

    // Leading blank cells so the first day lands in the right column
    // Mon=1→0 blanks, Tue=2→1, Wed=3→2, Thu=4→3, Fri=5→4, Sat/Sun→0
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
        if (dow === 0 || dow === 6) continue;   // skip Sat & Sun

        const dateStr    = formatDate(date);
        const isPast     = date < today;
        const status     = isPast ? 'past' : getDateStatus(dateStr);
        const entry      = selectedDates.get(dateStr);
        const isSelected = !!entry;

        const cell = document.createElement('div');
        cell.className = `cal-day ${status}${isSelected ? ' selected' : ''}`;
        cell.setAttribute('data-date', dateStr);

        const left = spotsLeft(dateStr);
        let badge = '';
        if (!isPast && status === 'full')    badge = '<span class="spot-badge full-badge">Full</span>';
        else if (!isPast && status === 'limited') badge = `<span class="spot-badge limited-badge">${left} left</span>`;

        cell.innerHTML = `<span class="day-num">${d}</span>${badge}`;

        if (!isPast) {
            cell.addEventListener('click', () => handleDayClick(dateStr, status));
        }

        cal.appendChild(cell);
    }
}

async function handleDayClick(dateStr, status) {
    if (!selectedRoom) return;

    if (selectedDates.has(dateStr)) {
        selectedDates.delete(dateStr);
    } else if (status === 'full') {
        const join = confirm(`This day is full (${selectedRoom.label}).\n\nAdd yourself to the waitlist for this date?`);
        if (join) selectedDates.set(dateStr, { status: 'waitlist', dayType: 'full' });
    } else {
        selectedDates.set(dateStr, { status: 'confirmed', dayType: 'full' });
    }

    renderCalendar();
    renderSelectedDates();
}

// ============================================================
// SELECTED DATES + BILLING TOTAL
// ============================================================
function calcTotal() {
    if (!selectedRoom) return 0;
    let total = 0;
    for (const [, entry] of selectedDates) {
        if (entry.status === 'waitlist') continue;  // waitlist = no charge yet
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
        const label     = friendlyDate(dateStr);
        const isWaitlist = entry.status === 'waitlist';
        const badge      = isWaitlist
            ? '<span class="waitlist-badge">Waitlist</span>'
            : '<span class="confirmed-badge">Confirmed</span>';

        let dayTypeHtml = '';
        if (!isWaitlist && selectedRoom) {
            if (selectedRoom.fullDayOnly) {
                dayTypeHtml = `<span class="day-type-fixed">Full Day — $${selectedRoom.fullDayRate}</span>`;
            } else {
                const isHalf = entry.dayType === 'half';
                dayTypeHtml = `
                    <div class="day-type-toggle">
                        <button type="button" class="day-type-btn${!isHalf ? ' active' : ''}"
                            data-date="${dateStr}" data-type="full">
                            Full&nbsp;$${selectedRoom.fullDayRate}
                        </button>
                        <button type="button" class="day-type-btn${isHalf ? ' active' : ''}"
                            data-date="${dateStr}" data-type="half">
                            Half&nbsp;$${selectedRoom.halfDayRate}
                        </button>
                    </div>`;
            }
        }

        return `
            <li class="date-list-item">
                <div class="date-row">
                    <div class="date-info">
                        <span class="date-label">${label}</span>
                        ${badge}
                    </div>
                    <div class="date-controls">
                        ${dayTypeHtml}
                        <button type="button" class="remove-btn" data-date="${dateStr}" aria-label="Remove ${label}">&times;</button>
                    </div>
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

    // Remove-date buttons
    container.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            selectedDates.delete(e.currentTarget.getAttribute('data-date'));
            renderCalendar();
            renderSelectedDates();
        });
    });

    // Full / Half day toggle buttons
    container.querySelectorAll('.day-type-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            const ds    = e.currentTarget.getAttribute('data-date');
            const dtype = e.currentTarget.getAttribute('data-type');
            const entry = selectedDates.get(ds);
            if (entry) {
                entry.dayType = dtype;
                selectedDates.set(ds, entry);
                renderSelectedDates();
            }
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
        currentDate.setMonth(currentDate.getMonth() - 1);
        await loadMonthCapacity();
        renderCalendar();
    });
    document.getElementById('nextMonth').addEventListener('click', async () => {
        currentDate.setMonth(currentDate.getMonth() + 1);
        await loadMonthCapacity();
        renderCalendar();
    });
});

async function handleSubmit(e) {
    e.preventDefault();

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

    // Build arrays of { date, dayType } objects
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

        // Success modal
        let details = `<p>We've received the registration for <strong>${childName}</strong> in <strong>${selectedRoom.label}</strong>.</p>`;
        if (confirmedDates.length) details += `<p><strong>${confirmedDates.length}</strong> day(s) confirmed.</p>`;
        if (waitlistDates.length)  details += `<p><strong>${waitlistDates.length}</strong> day(s) on waitlist — we'll be in touch at <strong>${parentEmail}</strong> if a spot opens.</p>`;
        details += `<p class="total-line">Estimated total: <strong>$${total.toFixed(2)}</strong></p>`;

        document.getElementById('successDetails').innerHTML = details;
        document.getElementById('successModal').style.display = 'flex';

        // Reset form
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
            showToast('⚙️ Database not connected yet. Follow the setup steps in README.md to link Supabase, then registrations will save.');
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

function setupListeners() {}  // called in DOMContentLoaded above; kept for clarity
