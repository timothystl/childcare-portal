# Administrator User Manual
## Timothy Lutheran Church — Mother's Day Out

---

## Overview

The admin dashboard is your central control panel for managing all aspects of the MDO program. It is accessible at `admin.html` and requires a Supabase email/password login.

**Dashboard tabs:**

| Tab | Purpose |
|-----|---------|
| 🏫 Classrooms | Daily rosters, capacity overview, room schedule planner |
| 📅 Care Calendar | All registrations — view, search, edit, add days |
| 👨‍👩‍👧 Families | Family directory, add/edit families, import from ProCare |
| 💬 Messages | Parent contact-us messages |
| ⏳ Waitlist | Enrollment waitlist, offers, planning, import |
| ⚙️ Settings | Registration window, closed days, room rates, ratios |
| 📊 Reports | Monthly roster, attendance, revenue, billing, trends |
| 👷 Staffing | Staff schedule, hours, payroll, staff roster |

---

## Logging In

1. Go to `admin.html`.
2. Enter your admin email and password.
3. Click **Login**.

Your session is saved in the browser — if you leave and come back on the same device, you will be returned directly to the dashboard. Click **Logout** in the top-right header to end your session.

**Header:** the current logged-in admin and role are shown top-right, next to **Logout**.

---

## Tab: 🏫 Classrooms

### Classroom Roster

Shows enrolled children organized by room, for a day, a week, or a whole month.

1. Choose a **View**: Day, Week, or Month.
2. Fill in the matching field — **Date**, **Week of (Monday)**, or **Month**.
3. Optionally filter by a specific **room**.
4. Click **View Roster** to see it on screen.
5. Click **🖨️ Print / PDF**:
   - **Day** — prints that day's roster, organized by room.
   - **Week** — prints one full daily roster page per weekday in the week (Monday–Friday), day by day, in a single print job.
   - **Month** — prints one continuous list per room, showing every day of the month in one table (best used after the registration window closes, to capture the complete month).
6. **📅 Print All Rooms** (Day view only) — a compact one-page landscape grid showing every room at once, for handoff to staff.

Use Day view as your daily attendance sheet.

### Capacity Overview

A color-coded calendar grid showing how full each room is each day across the month.

- Use the **← →** arrows or the month dropdown to navigate between months.
- Click any room's day cell to open a detailed **Room Capacity Calendar** modal showing enrollment vs. capacity for the full month.
  - Green = open, Yellow = near full (75%+), Red = full, Gray = program closed.

### Room Schedule Planner

Shows weekly enrollment counts per room and per day (AM = all children, PM = full-day only).

1. Select the **Week of (Monday)** date.
2. Click **View Week**.

---

## Tab: 📅 Care Calendar

### Viewing All Registrations

The Care Calendar tab shows every registration in the system.

**Filtering and searching:**
- Type in the **search box** to filter by parent name, child name, or email.
- Use the **Room** dropdown to filter by classroom.
- Use the **Care Month** dropdown to filter by month.
- Click any column header (Submitted, Parent, Child, Room, Full/Half, Bill) to sort.

**Each row shows:**
Submission date · Parent name & email · Phone · Child name · Room · Care dates · Full/Half day counts · Calculated bill · Any discount applied

### Editing a Registration's Days

Click **Edit Days** next to any registration. A modal opens showing all registered dates.

- **Remove a day:** Click the remove button (✕) next to any date.
- **Add a day:** Use the date picker at the bottom of the modal. Select the date, choose Full Day or Half Day, optionally check **Waitlisted**, and click **Add Day**.

Changes are saved immediately.

### Adding a Child to a Specific Day (From the Roster)

From the **Classroom Roster** (Day view) in the Classrooms tab, an admin can add a child to a day who was not previously registered:

1. Click the **+ Add Child** button on a specific date in the roster.
2. Search for the child by name.
3. Select the child from the results.
4. Choose **Full Day** or **Half Day**.
5. The **Apply $5 change fee** checkbox is pre-checked — uncheck it if you want to waive the fee.
6. Click **Add to Day**.

### Applying a Discount

Discounts can be set per child in the **Families** tab (see below). They are automatically applied to the bill calculation shown in the Care Calendar.

---

## Tab: 👨‍👩‍👧 Families

### Viewing the Family Directory

Click **↻ Refresh** to load all families. The list shows each family with their children, room assignments, and contact information.

**Sorting:** Use the **Sort** dropdown to sort by family name, child name, room, discount, or age.

**Searching:** Type in the search box to filter by child or parent name.

### Adding a New Family

1. Click **+ Add Family**.
2. Fill in the family modal:
   - **Parent 1:** Name, email, phone, and 4-digit PIN. The PIN button (↻) auto-generates a random PIN.
   - **Parent 2:** Optional second parent with their own name, email, phone, and PIN.
   - **Program Group:** Regular or Summer Program.
   - **Children:** Click **+ Add Child** for each child. Enter the child's name, date of birth, room assignment, and any per-child discount amount.
3. Click **Save Family**.

> Each parent gets their own PIN. Both parents can log in to the registration portal using their own email and PIN combination.

### Editing a Family

Each family card in the directory has an **Edit** button. This opens the same modal as Add Family, pre-filled with the existing data.

**To reset a PIN:** Open the family for editing, click the ↻ button next to the PIN field to generate a new one, and save.

**To change a child's room:** Edit the family and update the room dropdown for that child.

**To add a discount:** Edit the family, find the child's row, and enter a discount dollar amount. This is applied automatically to all billing calculations for that child.

### Archiving and Restoring Families

- **Archive Summer:** Archives all families enrolled in the Summer Program group at end of season, removing them from the active directory.
- **Show Archived / Hide Archived:** Toggle visibility of archived families.
- Archived families can be restored by editing them and re-activating.

### Merging Families

If the same family has duplicate records, click **Merge** on the record you want to remove. Select the family to merge into from the dropdown, then click **Merge & Delete**. All children move to the surviving record and the duplicate is permanently deleted.

### Importing Families from Excel / CSV

This is useful for bulk-loading from ProCare or a spreadsheet:

1. Click **📂 Choose File** and select your `.xlsx`, `.xls`, or `.csv` file.
2. A preview of the imported data appears.
3. Click **⬆ Import**.

Existing families matched by email are **updated**; new emails are **added**. No records are ever deleted during import.

The importer supports ProCare export format as well as custom spreadsheets.

---

## Tab: 💬 Messages

Displays all messages sent by parents via the **Contact Us** button on the registration page.

- **New/unread messages** are highlighted with a badge count in the tab.
- Click **↻ Refresh** to check for new messages.
- Click **Archive** on a message to move it out of the active view.
- Click **Show Archived / Hide Archived** to toggle archived messages.

Reply to parents by email outside the portal — there is no reply function built in.

---

## Tab: ⏳ Waitlist

### Viewing the Waitlist

The active waitlist is shown by default. Each row shows the applicant's name, child, room preference, desired start date, and current status.

**Filtering:**
- **Status filter:** Active (pending / offered / accepted), Enrolled, Archived, or All.
- **Room filter:** Filter by the room the applicant is waiting for.
- Click any column header to sort.

**Statuses:**
- **Pending** — application received, no action taken yet.
- **Offered** — a spot offer email has been sent.
- **Accepted** — the family accepted the offer.
- **Enrolled** — the family has been moved to the active family directory.
- **Archived** — no longer active (declined, withdrew, etc.).

### Adding to the Waitlist Manually

For families who called or stopped by in person:

1. Click **+ Add to Waitlist**.
2. Fill in the form: parent name, email, phone, child name and date of birth, desired start date, start date flexibility, days needed, full or half day, sibling status, and any notes.
3. Click **Add to Waitlist**.

### Making an Enrollment Offer

When a spot opens up for a waitlisted child:

1. Click **Make Offer** next to the applicant.
2. Set the **Offer Deadline** date.
3. Optionally add a **ProCare link** and **paperwork links** (pre-filled from Settings if configured).
4. Add any personal notes for the parent.
5. Click **Send & Email Parent**.

An offer email is automatically sent to the parent. The applicant's status changes to "Offered."

### Waitlist Planning Panel

Click **Generate Plan** to see a forward-looking projection:
- Average open spots per room per day for upcoming months.
- Aging-out events — children who will soon graduate to the next room.
- The waitlist queue matched against projected availability.

### Waitlist Demand by Month

Click **Generate Report** to see how many active waitlist applications are targeting each room and each month. Use this to guide capacity decisions.

### Enrollment Planner

Select a room and a month, then click **Generate Planner** to see a cross-reference of open capacity versus waitlist demand, with recommendations for filling spots efficiently.

### Importing the Waitlist from a File

Upload a CSV or Excel file to bulk-import applications:
1. Click **Choose File** and select your file.
2. Click **Preview** to review the parsed data.
3. Confirm the import.

Required columns: Parent Name, Email, Child Name, Desired Start Date.
Optional columns: Phone, Child DOB, Days Requested, Day Type, Notes.

---

## Tab: ⚙️ Settings

### Registration Window Override

Controls whether parents can currently register for care days.

| Setting | Effect |
|---------|--------|
| **Auto** | Registration is open from 9 AM Central on the 1st through 11:59 PM Central on the 15th |
| **Force Open** | Registration is open regardless of the date |
| **Force Closed** | Registration is blocked regardless of the date |

Select the desired option and click **Save**. Use Force Open to extend registration, or Force Closed to block registrations while making large changes.

### Closed Days

Dates blocked here appear as unavailable on the parent registration calendar.

**To add a closure:**
1. Select the date to block.
2. Enter an optional reason (e.g., "Thanksgiving," "Snow Day," "Professional Development").
3. Click **Block Date**.

**To remove a closure:** Click the remove button next to it in the list.

### Room Rates & Settings

Set the daily and weekly rates for each room:

- **Full Day Rate** — charged per confirmed full-day registration.
- **Half Day Rate** — charged per confirmed half-day registration.
- **Weekly Full Rate** — optional; when set, applies a discounted rate for families who book all 5 weekdays in a week (full day). Leave blank to disable the weekly discount for that room.
- **Weekly Half Rate** — same for half days.

Click **💾 Save Rates** when done. Changes take effect immediately for new registrations.

### Staff-to-Child Ratios

Sets the maximum number of children per staff member for each room. These ratios are used by the **Staff Schedule Planner** in the Staffing tab to calculate minimum staff required each day.

Adjust the number for each room and click **💾 Save Ratios**.

### Offer Email Links

Pre-fill the ProCare enrollment link and paperwork document links that are automatically inserted into every spot offer email. These can still be overridden per individual offer.

- **ProCare Enrollment Link** — the parent-facing ProCare enrollment URL.
- **Paperwork Links** — comma-separated document URLs (Google Docs, PDF links, etc.).

Click **💾 Save Links** when done.

---

## Tab: 📊 Reports

### Attendance & Revenue

Monthly attendance counts and net revenue for any date range.

1. Set **From** and **To** dates.
2. Optionally filter by **Room**.
3. Click **Generate**.
4. Click any month row to drill down into daily detail.
5. Click **↓ Export Excel** to download.

Historical months use imported historical data; current and future months use live registrations.

### Family Billing Summary

Per-family billing totals for a selected month, with discounts automatically applied.

1. Select a **month**.
2. Click **Generate**.
3. Click **↓ Export Excel** to download for invoicing.

Each row shows the parent name, children, total full days, total half days, any discounts, and the final billed amount.

### Enrollment Trends

Month-by-month enrollment count per room across the program's history.

Click **Generate Trends** to view, or **↓ Export Excel** to download the data.

---

## Tab: 👷 Staffing

### Staff Schedule Planner

Calculates the minimum number of staff required per room per day based on confirmed enrollment and your configured staff-to-child ratios.

1. Select the **Week of (Monday)** date.
2. Click **Generate Schedule**.

The planner shows each room for each weekday, the number of children enrolled, and the staff count needed.

**Auto-Fill Names:** Click **🪄 Auto-Fill Names** to have the system automatically suggest staff assignments based on each staff member's availability, room assignment, and maximum hours/days per week.

**Manually assigning staff:** Click any cell in the schedule to pick a staff member from a dropdown. Click a name to remove them.

Click **↓ Export Excel** to download the week's schedule.

### Log Hours

Manually records actual hours worked by each staff member for a specific day. This feeds into the Payroll Report.

1. Select a **date**.
2. Click **Load** — a row appears for each active staff member.
3. Enter hours worked for each person.
4. Click **💾 Save Hours**.

**Sync from Clock-In:** Click **⟳ Sync from Clock-In** to automatically populate hours from clock-in/clock-out records for that date, saving manual data entry. You can still adjust the imported values before saving.

### Payroll Report

A bi-weekly gross pay summary for all staff.

1. Select a **pay period** from the dropdown (periods are pre-built as bi-weekly windows).
2. Click **Generate Report**.

The report shows each staff member's name, role, room, pay type, hours worked, gross pay for the period, and year-to-date gross pay.

- **Hourly staff** — pay is calculated from logged hours × hourly rate.
- **Salaried staff** — pay is the fixed bi-weekly salary amount; hours are shown as "—".

Click **↓ Export Excel** to download for payroll processing.

### Staff Roster

The staff roster is hidden by default to keep the Staffing tab uncluttered. Click **👥 Show Staff Roster** to expand it.

#### Adding a Staff Member

1. Click **+ Add Staff Member**.
2. Fill in the form:
   - **Name** (required)
   - **Role** — Director, Asst. Director, Lead Teacher, Assistant Teacher, Float / Sub, Administrator, or Other
   - **Pay Type** — Hourly or Salary (bi-weekly)
   - **Hourly Rate** (if hourly) or **Bi-weekly Salary** (if salaried)
   - **Room** — primary room assignment, or "Float / All Rooms"
   - **Hire Date**
   - **Clock-In PIN** — 4-digit PIN the staff member uses at the clock-in kiosk
   - **Available Days** — which weekdays this person is available
   - **Available Shifts** — AM, PM, or both
   - **Max Hrs/Week** — maximum weekly hours (used by Auto-Fill)
   - **Max Days/Week** — maximum days per week (used by Auto-Fill)
3. Click **Save**.

#### Editing a Staff Member

Click **Edit** next to any staff member in the roster. The same form opens pre-filled. Make your changes and click **Save**.

#### Deactivating / Reactivating

Click **Deactivate** to mark a staff member as inactive. They will no longer appear in the clock-in system or be available for scheduling. Click **Restore** to reactivate them.

Click **Show Inactive / Hide Inactive** to toggle visibility of deactivated staff.

#### Deleting a Staff Member

Click the 🗑 **Delete** button to permanently remove a staff member. This cannot be undone. Only delete records that were created in error — use Deactivate for staff who have left.

---

## Common Tasks — Quick Reference

| Task | Where |
|------|-------|
| Print today's classroom list | Classrooms → Classroom Roster (Day view) |
| Print a week's rosters, day by day | Classrooms → Classroom Roster (Week view) |
| Print the full month's roster | Classrooms → Classroom Roster (Month view) |
| See how full rooms are this month | Classrooms → Capacity Overview |
| Find a parent's registration | Care Calendar → search bar |
| Add or remove a child's days | Care Calendar → Edit Days |
| Reset a parent's PIN | Families → Edit family |
| Add a new family | Families → + Add Family |
| Import families from ProCare | Families → Import section |
| Add someone to the waitlist | Waitlist → + Add to Waitlist |
| Offer a spot to a waitlisted family | Waitlist → Make Offer |
| Block a holiday or snow day | Settings → Closed Days |
| Change room rates | Settings → Room Rates |
| Force registration open or closed | Settings → Registration Window Override |
| Generate monthly billing | Reports → Family Billing Summary |
| Run payroll | Staffing → Payroll Report |
| Enter daily hours | Staffing → Log Hours |
| Add or edit a staff member | Staffing → Staff Roster |

---

## Managing Rooms & Classrooms

### The single source of truth

All room definitions live in one place: the `ROOMS` array at the top of `js/supabase.js`. Every part of the system — the parent portal, admin dropdowns, capacity overview, rates table, waitlist filter — reads from this array automatically. **To add a new room, edit only this file.** Nothing else needs to change.

### Room status values

Each room has a `status` field that controls how it behaves throughout the system:

| Status | What it means |
|--------|--------------|
| `active` | Open and enrollable year-round. Children are auto-assigned by age. Appears everywhere. |
| `coming_soon` | Not yet open. Excluded from parent booking and age-based auto-assignment. Shows as "Coming Soon" in the admin capacity overview and rates table, and as a greyed-out card on the public website. |
| `seasonal` | Only open during certain times (e.g. summer camp). Admin controls visibility via the Summer Camp toggle in Settings. Excluded from the rates table (has its own section). |

### Adding a new room

1. Open `js/supabase.js`.
2. Add a new object to the `ROOMS` array following the pattern of existing rooms.
3. Set `status: 'coming_soon'` if the room is not yet open, or `status: 'active'` if it is ready immediately.
4. Set `capacity: null` if the licensed capacity is not yet known (e.g. pending state inspection). Update it to the actual number once inspection clears.
5. Deploy. The new room appears automatically in all admin dropdowns, the capacity overview, rates table, and waitlist filter.

Minimum required fields for a new room:

```js
{
    id:             'robin',        // lowercase, no spaces — used in the database
    label:          '🐦 Robin Room',
    ages:           '3½ – 4 years',
    ageMinMonths:   42,
    ageMaxMonths:   47,             // null = no upper limit
    capacity:       12,             // null if unknown (coming_soon)
    status:         'active',       // 'active' | 'coming_soon' | 'seasonal'
    fullDayOnly:    false,
    fullDayRate:    75,
    halfDayRate:    45,
    weeklyFullRate: null,
    weeklyHalfRate: null,
    staffRatio:     8,
}
```

### Opening a "coming soon" room

When the state inspection clears and a room is ready to enroll:

1. In `js/supabase.js`, find the room and change:
   - `status: 'coming_soon'` → `status: 'active'`
   - `capacity: null` → `capacity: <licensed number>`
2. Deploy. The room is immediately enrollable, the capacity overview shows real utilisation, and the website card loses the "Coming Soon" badge.

### The Goose Room (current status: Coming Soon)

The Goose Room (🪿, ages 2½–3 years) is not yet open pending the state licensing inspection. Once the inspection is complete:

- Update `status` to `'active'` and set `capacity` to the approved number in `js/supabase.js`.
- Remove the dashed "Coming Soon" card from the public website (`index.html` classrooms section) and replace it with a standard room card showing the confirmed capacity.

### Summer Camp and break sessions

Summer Camp (`id: 'summer'`) serves summer, spring break, and winter break. This is documented in the `seasons` array on the room definition:

```js
seasons: ['summer', 'spring_break', 'winter_break']
```

Visibility for parents is controlled by the **Hide Summer Camp** toggle in **Settings → Summer Camp**. Turn it on to hide the room from the parent portal (e.g. after summer ends), and turn it off to show it again before the next session opens. Existing summer registrations are never affected by this toggle — it only controls whether new bookings can be made.
