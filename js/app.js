// ============================================================
// STATE
// ============================================================
let currentDate    = new Date();
let selectedRoom   = null;           // room object from ROOMS array
let selectedDates  = new Map();      // 'YYYY-MM-DD' -> 'confirmed' | 'waitlist'
let capacityCache  = {};             // 'YYYY-MM-DD' -> confirmed count (for current room/month)
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
    grid.innerHTML = ROOMS.map(room => `
        <label class="room-option" data-room="${room.id}">
            <input type="radio" name="room" value="${room.id}">
            <div class="room-card">
                <h3>${room.label}</h3>
                <p class="room-ages">${room.ages}</p>
                <span class="cap-badge">Max ${room.capacity} children</span>
            </div>
        </label>
    `).join('');

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

    const dates = [];
    for (let d = 1; d <= days; d++) {
        dates.push(formatDate(new Date(year, month, d)));
    }

    capacityCache = await fetchCapacityForDates(selectedRoom.id, dates);
    calendarLoading = false;
}

function getDateStatus(dateStr) {
    if (!selectedRoom) return 'disabled';
    const booked   = capacityCache[dateStr] || 0;
    const capacity = selectedRoom.capacity;
    if (booked >= capacity)          return 'full';
    if (booked >= capacity - 3)      return 'limited';
    return 'available';
}

function spotsLeft(dateStr) {
    if (!selectedRoom) return 0;
    return Math.max(0, selectedRoom.capacity - (capacityCache[dateStr] || 0));
}

// ============================================================
// CALENDAR
// ============================================================
const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];
const DAY_HEADERS = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

function renderCalendar() {
    const year      = currentDate.getFullYear();
    const month     = currentDate.getMonth();
    const firstDay  = new Date(year, month, 1).getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today     = new Date(); today.setHours(0,0,0,0);

    document.getElementById('currentMonthLabel').textContent = `${MONTH_NAMES[month]} ${year}`;

    const cal = document.getElementById('calendar');
    cal.innerHTML = '';

    // Day headers
    DAY_HEADERS.forEach(h => {
        const el = document.createElement('div');
        el.className = 'cal-header';
        el.textContent = h;
        cal.appendChild(el);
    });

    // Empty leading cells
    for (let i = 0; i < firstDay; i++) {
        const el = document.createElement('div');
        el.className = 'cal-day empty';
        cal.appendChild(el);
    }

    // Day cells
    for (let d = 1; d <= daysInMonth; d++) {
        const date    = new Date(year, month, d);
        const dateStr = formatDate(date);
        const isPast  = date < today;
        const status  = isPast ? 'past' : getDateStatus(dateStr);
        const isSelected = selectedDates.has(dateStr);

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
        // Deselect
        selectedDates.delete(dateStr);
    } else if (status === 'full') {
        // Offer waitlist
        const join = confirm(`This day is full (${selectedRoom.label}).\n\nAdd yourself to the waitlist for this date?`);
        if (join) selectedDates.set(dateStr, 'waitlist');
    } else {
        selectedDates.set(dateStr, 'confirmed');
    }

    renderCalendar();
    renderSelectedDates();
}

// ============================================================
// SELECTED DATES LIST
// ============================================================
function renderSelectedDates() {
    const container = document.getElementById('selectedDates');

    if (selectedDates.size === 0) {
        container.innerHTML = '<p class="empty-state">No dates selected yet.</p>';
        return;
    }

    const sorted = [...selectedDates.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    const rows = sorted.map(([dateStr, type]) => {
        const label = friendlyDate(dateStr);
        const badge = type === 'waitlist'
            ? '<span class="waitlist-badge">Waitlist</span>'
            : '<span class="confirmed-badge">Confirmed</span>';
        return `
            <li>
                <span>${label} ${badge}</span>
                <button type="button" class="remove-btn" data-date="${dateStr}" aria-label="Remove ${label}">&times;</button>
            </li>`;
    }).join('');

    container.innerHTML = `<ul class="date-list">${rows}</ul>`;

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
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    const confirmedDates = [...selectedDates.entries()].filter(([,t]) => t === 'confirmed').map(([d]) => d);
    const waitlistDates  = [...selectedDates.entries()].filter(([,t]) => t === 'waitlist').map(([d]) => d);

    try {
        await submitRegistration({
            parent: { name: parentName, email: parentEmail, phone: parentPhone },
            child:  { name: childName, age: parseInt(childAge) },
            roomId: selectedRoom.id,
            confirmedDates,
            waitlistDates,
        });

        // Show success modal
        let details = `<p>We've received your request for <strong>${childName}</strong> in <strong>${selectedRoom.label}</strong>.</p>`;
        if (confirmedDates.length) details += `<p><strong>${confirmedDates.length}</strong> date(s) confirmed.</p>`;
        if (waitlistDates.length)  details += `<p><strong>${waitlistDates.length}</strong> date(s) on waitlist — we'll email you at <strong>${parentEmail}</strong> if a spot opens.</p>`;
        document.getElementById('successDetails').innerHTML = details;
        document.getElementById('successModal').style.display = 'flex';

        // Reset
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
            showToast('Something went wrong. Please try again or contact us directly.');
        }
    } finally {
        btn.disabled = false;
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
