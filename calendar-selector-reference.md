# Childcare Portal Calendar Selector — Technical Reference for Gym Rental Implementation

## Architecture Overview

Vanilla JS + CSS Grid. No date libraries. All state in JS globals. Month rendered as a 5-col (Mon–Fri) grid of `<div class="cal-day">` elements, each dynamically generated. Key file: `js/app.js` (renderCalendar, handleDayClick, showDayPicker) and `css/styles.css`.

---

## Core HTML Structure

```html
<div id="calendarWrapper" class="calendar-wrapper hidden">
    <h3 id="currentMonthLabel"></h3>
    <div id="calendar" class="calendar"></div>
    <!-- Legend, selected-dates list, billing total go below -->
</div>
```

### Dynamically Rendered Day Cells

```html
<!-- Available, not selected -->
<div class="cal-day available" data-date="2025-05-08">
    <span class="day-num">8</span>
    <span class="spot-badge available-badge">5 left</span>
</div>

<!-- User-selected -->
<div class="cal-day selected" data-date="2025-05-08">
    <span class="day-num">8</span>
    <span class="selected-type-badge">Full</span>
</div>

<!-- Closed -->
<div class="cal-day closed" data-date="2025-05-19">
    <span class="day-num">19</span>
    <span class="spot-badge closed-badge">Closed</span>
    <span class="closed-reason">Memorial Day</span>
</div>

<!-- Full (no spots) -->
<div class="cal-day full" data-date="2025-05-07">
    <span class="day-num">7</span>
    <span class="spot-badge full-badge">Full</span>
</div>
```

---

## State Variables

```javascript
let currentDate    = new Date();      // month being viewed
let selectedDates  = new Map();       // 'YYYY-MM-DD' → { dayType: 'full'|'half', locked: bool }
let capacityCache  = {};              // { roomId: { 'YYYY-MM-DD': bookedCount } }
let closureMap     = new Map();       // 'YYYY-MM-DD' → reason string
let pickerOpenDate = null;            // which date's popup is open
```

---

## CSS Grid Layout

```css
.calendar {
    display: grid;
    grid-template-columns: repeat(5, minmax(0, 1fr));  /* Mon–Fri, shrinks on mobile */
    gap: 6px;
}

/* Mobile */
@media (max-width: 600px) {
    .calendar   { gap: 3px; }
    .cal-day    { border-radius: 4px; }
    .day-num    { font-size: .85em; }
    .spot-badge { font-size: .58em; }
}
```

### Key Cell Styles

```css
.cal-day {
    height: 72px;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    border: 1.5px solid #E8E0CC;
    border-radius: 7px;
    cursor: pointer;
    transition: transform .15s, box-shadow .15s;
    position: relative;
    min-width: 0;
    overflow: hidden;
}
.cal-day.available      { background: #FFF8E1; border-color: #F5B731; }
.cal-day.available:hover { background: #FDE598; transform: scale(1.06); }
.cal-day.limited        { background: #FFF8E1; border-color: #F5B731; }
.cal-day.limited:hover  { background: #FDE598; transform: scale(1.06); }
.cal-day.full           { opacity: 0.4; cursor: not-allowed; }
.cal-day.closed         { opacity: 0.65; cursor: not-allowed; }
.cal-day.past           { opacity: 0.3; cursor: default; }
.cal-day.selected       { background: #01294A !important; border-color: #01294A !important; color: #F5B731; }

.day-num            { font-size: 1em; font-weight: 600; }
.spot-badge         { font-size: .65em; font-weight: 600; margin-top: 2px; }
.full-badge         { color: #E97D55; }
.limited-badge      { color: #7a5a00; }
.available-badge    { color: #1a5c3e; }
.selected-type-badge { font-size: .65em; font-weight: 700; color: #F5B731; margin-top: 2px; }

.closed-reason {
    font-size: .58em;
    color: #7A6E5A;
    display: block;
    max-width: 96%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    text-align: center;
}

/* Day-picker popup */
.day-picker-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(0,0,0,.30);
    z-index: 499;
}
.day-picker-popup {
    position: fixed;
    z-index: 500;
    background: #fff;
    border: 2px solid #01294A;
    border-radius: 12px;
    padding: 16px;
    width: 240px;
    box-shadow: 0 12px 48px rgba(0,0,0,.25);
    text-align: center;
    /* positioned via inline style: top:50%;left:50%;transform:translate(-50%,-50%) */
}
.picker-title    { font-weight: 700; margin-bottom: 12px; color: #01294A; }
.picker-subtitle { font-size: .85em; color: #7A6E5A; margin-bottom: 10px; }
.picker-buttons  { display: flex; gap: 10px; justify-content: center; margin-bottom: 10px; }
.picker-btn {
    display: flex;
    flex-direction: column;
    align-items: center;
    border: 2px solid #01294A;
    border-radius: 8px;
    padding: 10px 16px;
    cursor: pointer;
    background: #FFF8E1;
    flex: 1;
}
.picker-btn:hover { background: #FDE598; }
.picker-label    { font-weight: 600; color: #01294A; }
.picker-rate     { font-size: 1.1em; font-weight: 700; color: #01294A; margin-top: 4px; }
.picker-cancel   { background: none; border: none; color: #7A6E5A; cursor: pointer; font-size: .9em; }
```

---

## Core JavaScript Functions

```javascript
// ── Helpers ────────────────────────────────────────────────────────────────

function formatDate(d) {
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

function friendlyDate(s) {
    return new Date(s + 'T12:00:00').toLocaleDateString('en-US', {
        weekday: 'short', month: 'long', day: 'numeric', year: 'numeric'
    });
}

function spotsLeft(dateStr) {
    const capacity = ROOM.capacity;                // your gym/court capacity
    const booked   = capacityCache[dateStr] || 0;
    return Math.max(0, capacity - booked);
}

// ── Availability ───────────────────────────────────────────────────────────

function getDateStatus(dateStr) {
    const capacity  = ROOM.capacity;
    const booked    = capacityCache[dateStr] || 0;
    const available = capacity - booked;
    if (available <= 0) return 'full';
    if (available <= 3) return 'limited';          // adjust threshold as needed
    return 'available';
}

// ── Render Calendar ────────────────────────────────────────────────────────

function renderCalendar() {
    const year  = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const grid  = document.getElementById('calendar');
    grid.innerHTML = '';

    document.getElementById('currentMonthLabel').textContent =
        new Date(year, month, 1).toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

    // Day-of-week headers (Mon–Fri only)
    ['Mon','Tue','Wed','Thu','Fri'].forEach(d => {
        const h = document.createElement('div');
        h.className = 'cal-header';
        h.textContent = d;
        grid.appendChild(h);
    });

    // Leading empty cells so day 1 lines up correctly
    const firstDow = new Date(year, month, 1).getDay();  // 0=Sun
    const offset   = firstDow === 0 ? 4 : firstDow - 1; // shift so Mon=col0
    for (let i = 0; i < offset; i++) {
        const e = document.createElement('div');
        e.className = 'cal-day empty';
        grid.appendChild(e);
    }

    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const today       = new Date(new Date().setHours(0,0,0,0));

    for (let day = 1; day <= daysInMonth; day++) {
        const d   = new Date(year, month, day);
        const dow = d.getDay();
        if (dow === 0 || dow === 6) continue;  // skip weekends

        const dateStr    = formatDate(d);
        const isPast     = d < today;
        const isClosed   = closureMap.has(dateStr);
        const isSelected = selectedDates.has(dateStr);
        const status     = isPast ? 'past' : isClosed ? 'closed' : getDateStatus(dateStr);

        const cell = document.createElement('div');
        cell.className = `cal-day ${status}${isSelected ? ' selected' : ''}`;
        cell.dataset.date = dateStr;

        let badge = '';
        if (isClosed) {
            const reason = closureMap.get(dateStr);
            badge = `<span class="spot-badge closed-badge">Closed</span>` +
                    (reason ? `<span class="closed-reason">${reason}</span>` : '');
        } else if (isSelected) {
            const entry = selectedDates.get(dateStr);
            badge = `<span class="selected-type-badge">${entry.slotType === 'half' ? '½ Day' : 'Full Day'}</span>`;
        } else if (!isPast && status !== 'full') {
            const left = spotsLeft(dateStr);
            badge = status === 'limited'
                ? `<span class="spot-badge limited-badge">${left} left</span>`
                : `<span class="spot-badge available-badge">${left} left</span>`;
        } else if (status === 'full') {
            badge = `<span class="spot-badge full-badge">Full</span>`;
        }

        cell.innerHTML = `<span class="day-num">${day}</span>${badge}`;

        if (!isPast && !isClosed && status !== 'full') {
            cell.addEventListener('click', (e) => {
                e.stopPropagation();
                handleDayClick(dateStr, status, cell);
            });
        }
        grid.appendChild(cell);
    }
}

// ── Click Handler ──────────────────────────────────────────────────────────

function handleDayClick(dateStr, status, cellEl) {
    // Toggle off if already selected
    if (selectedDates.has(dateStr)) {
        selectedDates.delete(dateStr);
        renderCalendar();
        renderSelectedDates();
        return;
    }

    // If only one slot type (e.g., exclusive full-day only) → skip popup
    // selectedDates.set(dateStr, { slotType: 'full' });
    // renderCalendar(); renderSelectedDates(); return;

    // Otherwise show slot-type picker
    showDayPicker(dateStr, cellEl);
}

// ── Day / Slot Picker Popup ────────────────────────────────────────────────

function showDayPicker(dateStr, anchorEl) {
    closeDayPicker();

    const backdrop = document.createElement('div');
    backdrop.id = 'dayPickerBackdrop';
    backdrop.className = 'day-picker-backdrop';

    const popup = document.createElement('div');
    popup.id = 'dayPickerPopup';
    popup.className = 'day-picker-popup';
    popup.style.cssText = 'position:fixed;top:50%;left:50%;transform:translate(-50%,-50%)';

    // Adapt slot labels and rates for your use case
    popup.innerHTML = `
        <p class="picker-title">${friendlyDate(dateStr)}</p>
        <div class="picker-buttons">
            <button type="button" class="picker-btn" data-date="${dateStr}" data-type="half">
                <span class="picker-label">Half Day</span>
                <span class="picker-rate">$80</span>
            </button>
            <button type="button" class="picker-btn" data-date="${dateStr}" data-type="full">
                <span class="picker-label">Full Day</span>
                <span class="picker-rate">$140</span>
            </button>
        </div>
        <button type="button" class="picker-cancel">&#10005; Cancel</button>
    `;

    popup.querySelectorAll('.picker-btn').forEach(btn => {
        btn.addEventListener('click', e => {
            e.stopPropagation();
            selectedDates.set(btn.dataset.date, { slotType: btn.dataset.type });
            closeDayPicker();
            renderCalendar();
            renderSelectedDates();
        });
    });

    popup.querySelector('.picker-cancel').addEventListener('click', closeDayPicker);
    backdrop.addEventListener('click', closeDayPicker);

    document.body.append(backdrop, popup);
}

function closeDayPicker() {
    document.getElementById('dayPickerBackdrop')?.remove();
    document.getElementById('dayPickerPopup')?.remove();
}

// ── Selected Dates Review List ─────────────────────────────────────────────

function renderSelectedDates() {
    const container = document.getElementById('selectedDates');
    if (!selectedDates.size) {
        container.innerHTML = '<p class="empty-state">No dates selected yet.</p>';
        return;
    }

    const RATES = { full: 140, half: 80 };  // adapt to your rates
    let total = 0;
    let html  = '<ul class="date-list">';

    [...selectedDates.entries()].sort().forEach(([dateStr, entry]) => {
        const rate  = RATES[entry.slotType] || 0;
        total += rate;
        html += `
            <li class="date-list-item">
                <div class="date-row">
                    <div class="date-info">
                        <span class="date-label">${friendlyDate(dateStr)}</span>
                        <span class="day-type-label">${entry.slotType === 'half' ? 'Half Day' : 'Full Day'} — $${rate}</span>
                    </div>
                    <button type="button" class="remove-btn" data-date="${dateStr}">&times;</button>
                </div>
            </li>`;
    });

    html += `</ul><div class="billing-total">Total: <strong>$${total.toFixed(2)}</strong></div>`;
    container.innerHTML = html;

    container.querySelectorAll('.remove-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            selectedDates.delete(btn.dataset.date);
            renderCalendar();
            renderSelectedDates();
        });
    });
}

// ── Month Navigation ───────────────────────────────────────────────────────

document.getElementById('prevMonth')?.addEventListener('click', async () => {
    closeDayPicker();
    // Add guard here if you have a minimum bookable month
    currentDate.setMonth(currentDate.getMonth() - 1);
    await loadMonthCapacity();
    renderCalendar();
});

document.getElementById('nextMonth')?.addEventListener('click', async () => {
    closeDayPicker();
    // Add guard here if you have a maximum bookable month
    currentDate.setMonth(currentDate.getMonth() + 1);
    await loadMonthCapacity();
    renderCalendar();
});

// ── Capacity Loading (replace with your DB call) ───────────────────────────

async function loadMonthCapacity() {
    const year  = currentDate.getFullYear();
    const month = currentDate.getMonth();
    const days  = new Date(year, month + 1, 0).getDate();
    const dates = [];

    for (let d = 1; d <= days; d++) {
        const date = new Date(year, month, d);
        const dow  = date.getDay();
        if (dow !== 0 && dow !== 6) dates.push(formatDate(date));
    }

    // Replace this with your actual DB query
    // e.g., fetch bookings from Supabase for `dates` and your resource ID
    capacityCache = {};  // { 'YYYY-MM-DD': bookedCount }
}
```

---

## Concept Mapping: Childcare → Gym Rental

| Childcare concept | Gym rental equivalent |
|---|---|
| `selectedChildren` (per-child rooms) | `selectedCourt` / `selectedResource` |
| `dayType: 'full' / 'half'` | `slotType: 'morning' / 'afternoon' / 'fullday'` |
| `ROOMS[].capacity` | Court capacity (usually 1 — exclusive booking) |
| `recurring_days` on student | Recurring weekly booking on an account |
| `registration_dates` table | `gym_bookings` table (date, slot_type, resource_id) |
| Sibling discount | Group / membership discount |
| `fullDayOnly` flag | Spaces that don't allow partial-day rental |

---

## Key Design Decisions to Carry Over

1. **`Map` of ISO date strings** (`'YYYY-MM-DD'`) is the single source of truth for selection — fast lookup, easy to serialize.
2. **Fixed-position popup** for slot/type choice — works perfectly on mobile without any scroll issues.
3. **Standard `click` events only** — browsers synthesize click from touch automatically; no separate touch handlers needed.
4. **`minmax(0, 1fr)` columns** — lets the grid shrink below natural content width on narrow screens without horizontal scroll.
5. **`transform: scale(1.06)` on hover** — subtle zoom gives good tactile feedback on desktop without being distracting.
6. **`min-width: 0; overflow: hidden`** on `.cal-day` — critical for preventing text from breaking the grid on small phones.
