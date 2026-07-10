// ============================================================
// SHARED CONSTANTS
// ============================================================
// Loaded before app.js / lookup.js on every page, so these globals are
// available to all page scripts (build runs with bundle:false — top-level
// declarations stay global across the separate <script> tags).
const MONTH_NAMES = ['January','February','March','April','May','June',
                     'July','August','September','October','November','December'];

// ============================================================
// ROOM CONFIG
// ============================================================
// ROOMS — base config. Rates, staff ratios, and capacity can be overridden by
// admin via the Settings section (stored in Supabase `settings` table, keys
// 'room_rates', 'staff_ratios', 'room_capacity').
// To enable the settings table, run in Supabase SQL Editor:
//   CREATE TABLE IF NOT EXISTS settings (key text PRIMARY KEY, value jsonb NOT NULL);
//   ALTER TABLE settings ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "Public read"  ON settings FOR SELECT USING (true);
//   CREATE POLICY "Auth write"   ON settings FOR ALL USING (auth.role() = 'authenticated');
// status values:
//   'active'      — open year-round, enrollable
//   'coming_soon' — not yet open; capacity null until state inspection clears
//   'seasonal'    — only open during certain periods (admin toggles visibility)
const ROOMS = [
    {
        id:             'bear',
        label:          '🐻 Bear Room',
        ages:           'Birth – 12 months',
        ageMinMonths:   0,
        ageMaxMonths:   12,
        capacity:       8,
        status:         'active',
        fullDayOnly:    true,
        fullDayRate:    80,
        halfDayRate:    null,
        weeklyFullRate: null,   // set in admin → overrides 5×fullDayRate when all 5 weekdays booked
        weeklyHalfRate: null,
        staffRatio:     4,      // max children per 1 staff member
    },
    {
        id:             'bee',
        label:          '🐝 Bee Room',
        ages:           '12 – 24 months',
        ageMinMonths:   12,
        ageMaxMonths:   24,
        capacity:       16,
        status:         'active',
        fullDayOnly:    false,
        fullDayRate:    75,
        halfDayRate:    55,
        weeklyFullRate: null,
        weeklyHalfRate: null,
        staffRatio:     4,
    },
    {
        id:             'turtle',
        label:          '🐢 Turtle Room',
        ages:           '24 – 30 months',
        ageMinMonths:   24,
        ageMaxMonths:   30,
        capacity:       11,
        status:         'active',
        fullDayOnly:    false,
        fullDayRate:    75,
        halfDayRate:    45,
        weeklyFullRate: null,
        weeklyHalfRate: null,
        staffRatio:     8,
    },
    {
        id:             'goose',
        label:          '🪿 Goose Room',
        ages:           '30 – 36 months',
        ageMinMonths:   30,
        ageMaxMonths:   36,
        capacity:       12,
        status:         'active',
        fullDayOnly:    false,
        fullDayRate:    75,
        halfDayRate:    45,
        weeklyFullRate: null,
        weeklyHalfRate: null,
        staffRatio:     8,
    },
    {
        id:             'owl',
        label:          '🦉 Owl Room',
        ages:           '36+ months',
        ageMinMonths:   36,
        ageMaxMonths:   null,
        capacity:       11,
        status:         'active',
        fullDayOnly:    false,
        fullDayRate:    75,
        halfDayRate:    45,
        weeklyFullRate: null,
        weeklyHalfRate: null,
        staffRatio:     8,
    },
    {
        id:             'summer',
        label:          '☀️ Summer Camp',
        ages:           '4–9 years',
        ageMinMonths:   null,
        ageMaxMonths:   null,
        capacity:       25,
        status:         'seasonal',
        seasons:        ['summer', 'spring_break', 'winter_break'],
        fullDayOnly:    true,
        fullDayRate:    75,
        halfDayRate:    null,
        weeklyFullRate: null,
        weeklyHalfRate: null,
        staffRatio:     11,
        hidden:         false,  // toggled by admin via Settings → Hide Summer Camp
    },
];

// Returns ROOMS sorted by age (ageMinMonths ascending). Rooms with no
// ageMinMonths (e.g. Summer Camp) sort last, in their original relative order.
// Age ranges are admin-editable (Settings → Rates), so display order must be
// derived at render time rather than assumed from the ROOMS declaration order.
function getSortedRooms(rooms = ROOMS) {
    return rooms
        .map((room, i) => ({ room, i }))
        .sort((a, b) => {
            const aMin = a.room.ageMinMonths;
            const bMin = b.room.ageMinMonths;
            if (aMin == null && bMin == null) return a.i - b.i;
            if (aMin == null) return 1;
            if (bMin == null) return -1;
            if (aMin !== bMin) return aMin - bMin;
            return a.i - b.i;
        })
        .map(({ room }) => room);
}

// Populates a "which room is your sibling in" <select> with all non-hidden
// rooms, age-sorted, keeping any existing placeholder option (e.g. "— Not
// sure —") already in the markup. Shared by the parent, inquiry, and admin
// waitlist forms so a new/renamed room never needs a hardcoded HTML update.
function populateSiblingRoomSelect(sel) {
    if (!sel) return;
    getSortedRooms().filter(r => !r.hidden).forEach(r => {
        const opt = document.createElement('option');
        opt.value       = r.id;
        opt.textContent = `${r.label} (${r.ages})`;
        sel.appendChild(opt);
    });
}

// ============================================================
// TYPE DEFINITIONS  (JSDoc — no build step required)
// Provides IDE autocomplete and catches field-name typos at development time.
// ============================================================

/**
 * A room configuration object (static config + admin-overridable rates).
 * @typedef {Object} Room
 * @property {string}      id             - Unique room identifier ('bear', 'bee', etc.)
 * @property {string}      label          - Display label with emoji
 * @property {string}      ages           - Human-readable age range
 * @property {number|null} ageMinMonths   - Minimum age in months (null = no lower bound)
 * @property {number|null} ageMaxMonths   - Exact age in months a child ages OUT of this room at (exclusive; null = no upper bound)
 * @property {number}      capacity       - Maximum enrolled children
 * @property {boolean}     fullDayOnly    - Whether half-day option is disabled
 * @property {number}      fullDayRate    - Full-day base rate in dollars
 * @property {number|null} halfDayRate    - Half-day base rate in dollars (null if fullDayOnly)
 * @property {number|null} weeklyFullRate - Weekly rate when all 5 weekdays are booked full-day
 * @property {number|null} weeklyHalfRate - Weekly rate when all 5 weekdays are booked half-day
 * @property {number}      staffRatio     - Max children per staff member
 * @property {boolean}     [hidden]       - If true, room is hidden from the parent portal
 */

/**
 * A single date entry used when building a registration.
 * @typedef {Object} DateEntry
 * @property {string} date    - ISO 8601 date string (YYYY-MM-DD)
 * @property {string} dayType - 'full' or 'half'
 */

/**
 * A registration_dates row as returned by Supabase.
 * @typedef {Object} RegistrationDate
 * @property {number}  id              - PK
 * @property {number}  registration_id - FK → registrations.id
 * @property {string}  room_id         - FK → room id string
 * @property {string}  care_date       - ISO 8601 date (YYYY-MM-DD)
 * @property {boolean} waitlisted      - Whether this date is waitlisted
 * @property {string}  day_type        - 'full' or 'half'
 * @property {number}  [change_fee]    - Admin-applied change fee for post-submission adds
 */

/**
 * A registration row as returned by Supabase (may include nested registration_dates).
 * @typedef {Object} Registration
 * @property {number}              id                 - PK
 * @property {string}              created_at         - ISO 8601 timestamp
 * @property {string}              status             - 'confirmed' | 'waitlist' | 'cancelled'
 * @property {string}              parent_name
 * @property {string}              parent_email
 * @property {string}              parent_phone
 * @property {string}              child_name
 * @property {number}              child_age          - Age in months at time of registration
 * @property {string|null}         child_dob          - ISO 8601 date or null
 * @property {string}              room_id
 * @property {RegistrationDate[]}  [registration_dates] - Present when fetched with a join
 */

/**
 * A student row as returned by Supabase (nested inside a Family).
 * @typedef {Object} Student
 * @property {number}      id
 * @property {string}      child_name
 * @property {string|null} child_dob         - ISO 8601 date or null
 * @property {string|null} room_override     - Override room id, or null to use auto-assignment
 * @property {string|null} discount_type     - 'percent' | 'flat' | 'custom' | null
 * @property {number|null} discount_value    - Discount amount or percentage
 * @property {string|null} discount_note     - Free-text note shown on billing
 * @property {string|null} recurring_days    - Comma-separated weekday abbreviations, or null
 */

/**
 * A family row as returned by Supabase (may include nested students).
 * @typedef {Object} Family
 * @property {number}      id
 * @property {string}      parent_name
 * @property {string}      parent_email
 * @property {string}      parent_phone
 * @property {boolean}     [has_pin]             - True if a primary-parent PIN is set
 * @property {string|null} parent2_name
 * @property {string|null} parent2_email
 * @property {string|null} parent2_phone
 * @property {boolean}     [has_parent2_pin]     - True if a parent-2 PIN is set
 * @property {boolean}     [registration_locked] - Blocks new registrations when true
 * @property {boolean}     [login_locked]        - Blocks PIN login when true
 * @property {Student[]}   [students]            - Present when fetched with a join
 */

/**
 * Result returned by the family_login RPC.
 * @typedef {Object} FamilyLoginResult
 * @property {Family}  family    - The matched family record with nested students
 * @property {boolean} isParent2 - Whether login matched the second parent's PIN
 */

/**
 * A facility closure record.
 * @typedef {Object} ClosureRecord
 * @property {string} close_date - ISO 8601 date (YYYY-MM-DD)
 * @property {string} reason     - Human-readable reason (may be empty string)
 */

/**
 * A staff member record.
 * @typedef {Object} StaffRecord
 * @property {number}      id
 * @property {string}      name
 * @property {string|null} email
 * @property {string|null} role         - Job title / role label
 * @property {boolean}     active
 * @property {number|null} pin          - Clock-in PIN
 * @property {number}      [hours_week] - Contracted hours per week
 */

/**
 * A staff clock event (individual clock-in / clock-out punch).
 * @typedef {Object} ClockEvent
 * @property {number}      id
 * @property {number}      staff_id
 * @property {string}      event_type  - 'in' or 'out'
 * @property {string}      event_time  - ISO 8601 timestamp
 */

/**
 * A staff hours record (manually entered or computed pay period summary).
 * @typedef {Object} StaffHours
 * @property {number}      id
 * @property {number}      staff_id
 * @property {string}      week_start  - ISO 8601 date (Monday of pay week)
 * @property {number}      hours       - Total hours for the week
 * @property {number}      [rate]      - Hourly rate at time of entry
 */

/**
 * A waitlist entry.
 * @typedef {Object} WaitlistEntry
 * @property {number}      id
 * @property {string}      created_at
 * @property {string}      parent_name
 * @property {string}      parent_email
 * @property {string}      parent_phone
 * @property {string}      child_name
 * @property {string|null} child_dob
 * @property {string}      room_id
 * @property {string}      status      - 'waiting' | 'offered' | 'accepted' | 'declined'
 * @property {string|null} offer_sent_at
 * @property {string|null} notes
 */

/**
 * An admin roles map keyed by lowercase email → role string.
 * @typedef {Object<string, string>} AdminRolesMap
 */

// ============================================================
// SUPABASE CONFIGURATION
// ============================================================
// Requests proxied through Cloudflare Worker (/sb/*) to avoid CORS issues.
const SUPABASE_URL      = (typeof window !== 'undefined' ? window.location.origin : '') + '/sb';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRhaGRzdG9wc3VteG5xdmRjbG15Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxMzM3NDYsImV4cCI6MjA4NzcwOTc0Nn0.PGuSZcnwGaG0Tes6li04JeNBAKDP4oJ6eGwhuYYXO_E';

let sbClient = null;
const SUPABASE_CONFIGURED = SUPABASE_URL !== 'YOUR_SUPABASE_URL';
try {
    sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (e) {
    console.warn('Supabase not yet configured — running in preview mode.');
}

// Converts raw Supabase/Cloudflare errors into readable messages.
function friendlyError(err) {
    const msg = err?.message || String(err);
    if (msg.includes('<!DOCTYPE') || msg.includes('522') || msg.toLowerCase().includes('timed out') || msg.toLowerCase().includes('connection timed')) {
        // Preserve the original error for diagnosis — the UI shows the friendly
        // message but the real cause (HTML error page, 522, timeout) is logged.
        console.warn('friendlyError: database unreachable —', msg);
        return new Error('Cannot reach the database (Supabase may be paused — visit supabase.com/dashboard to restore your project).');
    }
    return err instanceof Error ? err : new Error(msg);
}

// ============================================================
// CAPACITY
// ============================================================
/**
 * Returns a map of care_date → confirmed-booking count for the given room and dates.
 * @param {string}   roomId      - Room id to check
 * @param {string[]} dateStrings - ISO 8601 dates to check (YYYY-MM-DD)
 * @returns {Promise<Object<string, number>>} Map of date string to booking count
 */
async function fetchCapacityForDates(roomId, dateStrings) {
    if (!dateStrings.length || !sbClient) return {};
    const { data, error } = await sbClient
        .from('registration_dates')
        .select('care_date')
        .eq('room_id', roomId)
        .eq('waitlisted', false)
        .in('care_date', dateStrings);
    if (error) { console.error('fetchCapacityForDates:', error); return {}; }
    const counts = {};
    (data || []).forEach(row => {
        counts[row.care_date] = (counts[row.care_date] || 0) + 1;
    });
    return counts;
}

// ============================================================
// CLOSURES
// ============================================================
/**
 * Fetches all facility closure dates ordered ascending.
 * @returns {Promise<ClosureRecord[]>}
 */
async function fetchClosures() {
    if (!sbClient) return [];
    const { data, error } = await sbClient
        .from('closures')
        .select('close_date, reason')
        .order('close_date', { ascending: true });
    if (error) { console.error('fetchClosures:', error); return []; }
    return data || [];
}

/**
 * Adds a facility closure date.
 * @param {string} closeDate - ISO 8601 date (YYYY-MM-DD)
 * @param {string} [reason]  - Optional reason string
 * @returns {Promise<void>}
 */
async function addClosure(closeDate, reason) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('closures')
        .insert({ close_date: closeDate, reason: reason || '' });
    if (error) throw error;
}

/**
 * Removes a facility closure date.
 * @param {string} closeDate - ISO 8601 date (YYYY-MM-DD)
 * @returns {Promise<void>}
 */
async function deleteClosure(closeDate) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('closures')
        .delete()
        .eq('close_date', closeDate);
    if (error) throw error;
}

// ============================================================
// REGISTRATION SUBMIT
// ============================================================
/**
 * Inserts a new registration row and its associated date rows.
 * The server-side `enforce_registration_window` trigger will reject the insert
 * if the registration window is closed (unless an admin override is active).
 * @param {Object}      params
 * @param {{name:string, email:string, phone:string}} params.parent
 * @param {{name:string, ageMonths:number, dob:string|null}}  params.child
 * @param {string}      params.roomId          - Room id string
 * @param {DateEntry[]} params.confirmedDates  - Dates to book as confirmed
 * @param {DateEntry[]} [params.waitlistDates] - Dates to book as waitlisted
 * @param {string}      [params.status]        - Registration status (default: 'confirmed')
 * @returns {Promise<Registration>} The created registration row
 */
async function submitRegistration({ parent, child, roomId, confirmedDates, waitlistDates = [], status = 'confirmed', submittedBy = 'parent1' }) {
    if (!sbClient) throw new Error('Supabase is not configured yet.');

    const { data: reg, error: regError } = await sbClient
        .from('registrations')
        .insert({
            parent_name:  parent.name,
            parent_email: parent.email,
            parent_phone: parent.phone,
            child_name:   child.name,
            child_age:    child.ageMonths,
            child_dob:    child.dob || null,
            room_id:      roomId,
            status:       status,
            submitted_by: submittedBy,
        })
        .select()
        .single();

    if (regError) {
        if (regError.code === '23505') {
            throw Object.assign(new Error(`${child.name} is already registered for this month. Please contact the office if you need to make changes.`), { code: '23505' });
        }
        throw regError;
    }

    const dateRows = [
        ...confirmedDates.map(({ date, dayType }) => ({
            registration_id: reg.id,
            room_id:         roomId,
            care_date:       date,
            waitlisted:      false,
            day_type:        dayType,
        })),
        ...(waitlistDates || []).map(({ date, dayType }) => ({
            registration_id: reg.id,
            room_id:         roomId,
            care_date:       date,
            waitlisted:      true,
            day_type:        dayType,
        })),
    ];

    if (dateRows.length) {
        const { error: datesError } = await sbClient
            .from('registration_dates')
            .insert(dateRows);
        if (datesError) {
            // Rollback: remove the registration row we just created so it doesn't
            // show as a ghost/orphan (no dates) on future duplicate checks.
            await sbClient.from('registrations').delete().eq('id', reg.id);
            throw datesError;
        }
    }

    return reg;
}

// ============================================================
// ADMIN HELPERS
// ============================================================
/**
 * Fetches registrations with nested registration_dates.
 * Defaults to the current month + next month; pass explicit dates for reports.
 * @param {Object}      [opts]
 * @param {string|null} [opts.sinceDate] - ISO 8601 timestamp lower bound (inclusive)
 * @param {string|null} [opts.untilDate] - ISO 8601 timestamp upper bound (inclusive)
 * @returns {Promise<Registration[]>}
 */
async function fetchAllRegistrations({ sinceDate = null, untilDate = null } = {}) {
    if (!sbClient) throw new Error('Supabase not configured.');
    let query = sbClient
        .from('registrations')
        .select(`
            id, created_at, status, submitted_by,
            parent_name, parent_email, parent_phone,
            child_name, child_age, child_dob, room_id,
            registration_dates ( id, care_date, waitlisted, day_type, room_id, change_fee )
        `)
        .order('created_at', { ascending: false });
    if (sinceDate) query = query.gte('created_at', sinceDate);
    if (untilDate) query = query.lte('created_at', untilDate);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

/**
 * Moves a waitlisted registration to confirmed status.
 * @param {number} id - Registration id
 * @returns {Promise<void>}
 */
async function approveRegistration(id) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error: regErr } = await sbClient
        .from('registrations')
        .update({ status: 'confirmed' })
        .eq('id', id);
    if (regErr) throw regErr;
    const { error: datesErr } = await sbClient
        .from('registration_dates')
        .update({ waitlisted: false })
        .eq('registration_id', id);
    if (datesErr) throw datesErr;
}

/**
 * Permanently deletes a registration and all its date rows.
 * @param {number} id - Registration id
 * @returns {Promise<void>}
 */
async function deleteRegistration(id) {
    if (!sbClient) throw new Error('Supabase not configured.');
    // Delete registration_dates first (no cascade in DB), then the registration
    const { error: datesErr } = await sbClient
        .from('registration_dates')
        .delete()
        .eq('registration_id', id);
    if (datesErr) throw datesErr;
    const { error } = await sbClient
        .from('registrations')
        .delete()
        .eq('id', id);
    if (error) throw error;
}

async function updateRegistrationDateRoom(dateId, newRoomId) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('registration_dates')
        .update({ room_id: newRoomId })
        .eq('id', dateId);
    if (error) throw error;
}

/**
 * Adds a single date to an existing registration.
 * @param {number}  regId      - Registration id
 * @param {string}  roomId     - Room id string
 * @param {string}  careDate   - ISO 8601 date (YYYY-MM-DD)
 * @param {string}  dayType    - 'full' or 'half'
 * @param {boolean} waitlisted - Whether to mark the date as waitlisted
 * @param {number}  [changeFee=0] - Admin change fee to apply to this date
 * @returns {Promise<void>}
 */
async function addRegistrationDate(regId, roomId, careDate, dayType, waitlisted, changeFee = 0) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('registration_dates')
        .insert({ registration_id: regId, room_id: roomId, care_date: careDate, day_type: dayType, waitlisted: !!waitlisted, change_fee: changeFee || 0 });
    if (error) throw error;
}

async function deleteRegistrationDate(dateId) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('registration_dates')
        .delete()
        .eq('id', dateId);
    if (error) throw error;
}

// ============================================================
// SETTINGS  (key/value table for admin overrides)
// ============================================================
/**
 * Reads a single setting from the settings key/value table.
 * @param {string} key - Setting key (e.g. 'reg_window_override', 'room_rates')
 * @returns {Promise<*>} The JSONB value, or null if not found
 */
async function fetchSetting(key) {
    if (!sbClient) return null;
    // Use limit(1) array-style instead of maybeSingle() so that duplicate rows
    // (possible if the unique constraint on key is missing) don't cause a silent
    // PGRST116 error that makes the whole fetch return null.
    const { data, error } = await sbClient
        .from('settings')
        .select('value')
        .eq('key', key)
        .limit(1);
    if (error) { console.error('fetchSetting:', error); return null; }
    const raw = data?.[0]?.value ?? null;
    // The settings.value column can come back as a JSON *string* (not a parsed
    // object) depending on how the row was written — loadRateSettings() does the
    // same defensive parse. Without this, callers like fetchGeofenceSettings()
    // get a string and every field read (s.lat, s.enabled, …) is undefined.
    return typeof raw === 'string' ? parseJsonOr(raw, raw) : raw;
}

/**
 * Creates or updates a setting in the settings key/value table.
 * UPDATE first; if nothing was updated (row didn't exist), INSERT.
 * This avoids duplicate rows regardless of whether the key column has
 * a unique constraint.
 * @param {string} key   - Setting key
 * @param {*}      value - Any JSON-serializable value
 * @returns {Promise<void>}
 */
async function upsertSetting(key, value) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data: upd, error: updErr } = await sbClient
        .from('settings')
        .update({ value })
        .eq('key', key)
        .select('key');
    if (updErr) throw updErr;
    if (upd && upd.length > 0) return; // Updated existing row — done
    // Row doesn't exist yet — insert it
    const { data: ins, error: insErr } = await sbClient
        .from('settings')
        .insert({ key, value })
        .select('key');
    if (insErr) throw insErr;
    if (!ins || ins.length === 0) throw new Error('Settings write was blocked — check database RLS policies for the settings table.');
}

async function fetchGeofenceSettings() { return (await fetchSetting('geofence')) || {}; }
async function saveGeofenceSettings(v) { await upsertSetting('geofence', v); }

// ============================================================
// DUPLICATE / CONFLICT CHECK
// Returns an array of care_date strings that already have a confirmed
// registration for this parent+child — so the caller can show specifics.
// ============================================================
/**
 * Returns the subset of dateStrings that are already confirmed-booked for this child.
 * Used to show the parent exactly which dates conflict before allowing submission.
 * @param {string}   email       - Parent email (case-insensitive)
 * @param {string}   childName   - Child name (case-insensitive)
 * @param {string[]} dateStrings - ISO 8601 dates to check
 * @returns {Promise<string[]>} Already-booked dates from the input list
 */
async function checkDateConflicts(email, childName, dateStrings) {
    if (!sbClient || !dateStrings.length) return [];
    try {
        // Find every registration row for this parent+child
        const { data: regs, error: regErr } = await sbClient
            .from('registrations')
            .select('id')
            .ilike('parent_email', email)
            .ilike('child_name', childName);
        if (regErr || !regs?.length) return [];

        const ids = regs.map(r => r.id);
        // Return which of the requested dates are already booked (non-waitlisted)
        const { data: dates, error: datesErr } = await sbClient
            .from('registration_dates')
            .select('care_date')
            .in('registration_id', ids)
            .in('care_date', dateStrings)
            .eq('waitlisted', false);
        if (datesErr) return [];
        return (dates || []).map(d => d.care_date);
    } catch {
        return [];
    }
}

// Legacy month-level check kept for any callers outside handleSubmit
/**
 * Month-level duplicate check: returns the first existing registration for this
 * parent+child in the given month, or null if none exists.
 * @param {string}      email     - Parent email (case-insensitive)
 * @param {string}      monthKey  - 'YYYY-MM' month string
 * @param {string|null} [childName] - Child name filter (case-insensitive)
 * @returns {Promise<Registration|null>}
 */
async function checkExistingRegistration(email, monthKey, childName = null) {
    if (!sbClient) return null;
    try {
        let regsQuery = sbClient
            .from('registrations')
            .select('id, created_at, child_name, parent_email')
            .ilike('parent_email', email);
        if (childName) regsQuery = regsQuery.ilike('child_name', childName);
        const { data: regs, error: regErr } = await regsQuery;
        if (regErr || !regs || !regs.length) return null;

        const ids = regs.map(r => r.id);
        const [yr, mo] = monthKey.split('-');
        const nextMo = mo === '12'
            ? `${parseInt(yr) + 1}-01`
            : `${yr}-${String(parseInt(mo) + 1).padStart(2, '0')}`;
        const { data: dates, error: datesErr } = await sbClient
            .from('registration_dates')
            .select('registration_id')
            .in('registration_id', ids)
            .gte('care_date', monthKey + '-01')
            .lt('care_date', nextMo + '-01')
            .eq('waitlisted', false)
            .limit(1);
        if (datesErr) return null;
        if (!(dates && dates.length > 0)) return null;
        // Return the specific registration that has dates in this month — a parent
        // can have multiple registrations for the same child across different
        // months, and regs[0] (arbitrary query order) may not be the one that
        // actually conflicts, showing the wrong "submitted on" date to the parent.
        return regs.find(r => r.id === dates[0].registration_id) || regs[0];
    } catch {
        return null;
    }
}

// Check if ANY registration exists for this child name in the given month, regardless of which parent submitted it.
// Used to prevent a second parent from re-registering a child that the first parent already scheduled.
async function checkExistingRegistrationByChild(monthKey, childName) {
    if (!sbClient || !childName) return null;
    try {
        const { data: regs, error: regErr } = await sbClient
            .from('registrations')
            .select('id, created_at, child_name, parent_email, parent_name')
            .ilike('child_name', childName);
        if (regErr || !regs || !regs.length) return null;

        const ids = regs.map(r => r.id);
        const [yr, mo] = monthKey.split('-');
        const nextMo = mo === '12'
            ? `${parseInt(yr) + 1}-01`
            : `${yr}-${String(parseInt(mo) + 1).padStart(2, '0')}`;
        const { data: dates, error: datesErr } = await sbClient
            .from('registration_dates')
            .select('registration_id')
            .in('registration_id', ids)
            .gte('care_date', monthKey + '-01')
            .lt('care_date', nextMo + '-01')
            .eq('waitlisted', false)
            .limit(1);
        if (datesErr) return null;
        if (!(dates && dates.length > 0)) return null;
        // Return the specific registration that has dates in this month so
        // the created_at shown in the error message matches the actual conflict.
        return regs.find(r => r.id === dates[0].registration_id) || regs[0];
    } catch {
        return null;
    }
}

// ============================================================
// FAMILIES & STUDENTS
// ============================================================
// SQL migration — run once to add registration lock column:
//   ALTER TABLE families ADD COLUMN IF NOT EXISTS registration_locked BOOLEAN DEFAULT FALSE;

// Try the families table first (ProCare import); fall back to searching registrations
/**
 * Searches families by parent name or email.
 * Tries the families table first; falls back to building family-like records
 * from the registrations table if the families table is empty or unavailable.
 * @param {string} query - Search term
 * @returns {Promise<Family[]>}
 */
async function searchFamilies(query) {
    if (!sbClient || !query) return [];
    try {
        const { data, error } = await sbClient
            .from('families')
            .select('id, parent_name, parent_email, parent_phone, has_pin, students(id, child_name, child_dob, room_override, discount_type, discount_value, discount_note, recurring_days)')
            .or(`parent_name.ilike.%${query}%,parent_email.ilike.%${query}%`)
            .order('parent_name')
            .limit(8);
        if (!error && data?.length) return data;
    } catch (_) { /* families table may not exist yet */ }
    // Fall back to building family-like records from existing registrations
    return searchFamiliesFromRegistrations(query);
}

// Build family-like objects from the registrations table (works before ProCare import)
async function searchFamiliesFromRegistrations(query) {
    if (!sbClient || !query) return [];
    try {
        const { data, error } = await sbClient
            .from('registrations')
            .select('parent_name, parent_email, parent_phone, child_name, child_dob')
            .or(`parent_name.ilike.%${query}%,parent_email.ilike.%${query}%`)
            .order('created_at', { ascending: false });
        if (error || !data?.length) return [];

        const map = new Map();
        for (const r of data) {
            const key = (r.parent_email || r.parent_name || '').toLowerCase().trim();
            if (!key) continue;
            if (!map.has(key)) {
                map.set(key, {
                    id:           'reg_' + key,
                    parent_name:  r.parent_name,
                    parent_email: r.parent_email,
                    parent_phone: r.parent_phone,
                    has_pin:      false,
                    students:     [],
                });
            }
            const fam = map.get(key);
            if (r.child_name && !fam.students.some(s => s.child_name === r.child_name)) {
                fam.students.push({
                    id:            `reg_${key}_${r.child_name}`,
                    child_name:    r.child_name,
                    child_dob:     r.child_dob,
                    room_override: null,
                });
            }
        }
        return [...map.values()];
    } catch (_) {
        return [];
    }
}

/**
 * Calls the server-side family_login RPC.
 * Validates the PIN, tracks failures, and auto-locks after 5 attempts.
 * @param {string} email - Parent email
 * @param {string|number} pin - 4-digit PIN
 * @returns {Promise<FamilyLoginResult|{error:string}>}
 */
async function familyLogin(email, pin) {
    if (!sbClient) return { data: null, error: 'not_configured' };
    // PIN passed as TEXT so leading zeros (e.g. "0123") survive — family_login
    // now takes a text PIN (see ss2_family_login_text_pin.sql).
    const pinStr = String(pin ?? '').trim();
    if (!/^\d{4,8}$/.test(pinStr)) return { data: null, error: 'invalid_pin' };
    const { data, error } = await sbClient.rpc('family_login', { p_email: email, p_pin: pinStr });
    if (error) throw error;
    return data; // { error: '...' } or { family: {...}, isParent2: bool }
}

/**
 * Authenticates via the family-lookup Edge Function (same logic as the RPC but
 * also returns a short-lived sessionToken for securing push subscriptions).
 * Returns { family, isParent2, sessionToken } on success, { error } on locked, null otherwise.
 * @param {string}        email - Parent email
 * @param {string|number} pin   - 4-digit PIN
 * @returns {Promise<{family:object,isParent2:boolean,sessionToken:string}|{error:string}|null>}
 */
/**
 * Triggers the self-service "forgot PIN" flow. Always resolves true once
 * the request is sent — the server intentionally returns the same
 * response whether or not the email is registered, so we don't expose
 * registration status to anyone calling this.
 * @param {string} email
 * @returns {Promise<boolean>}
 */
async function requestPinReset(email) {
    if (!sbClient || !email) return false;
    try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/request-pin-reset`, {
            method:  'POST',
            headers: {
                'Content-Type': 'application/json',
                apikey:         SUPABASE_ANON_KEY,
                Authorization:  `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({ email }),
        });
        // A non-OK status means the request was not accepted (e.g. server/email
        // failure). The edge function returns 200 even for unknown emails to avoid
        // account enumeration, so res.ok still preserves that privacy behaviour.
        return res.ok;
    } catch (_) {
        return false;
    }
}

async function lookupFamilyForRegistration(email, pin) {
    if (!sbClient) return null;
    try {
        // Call the Edge Function via raw fetch through our same-origin /sb proxy.
        // We avoid sbClient.functions.invoke() because it (a) auto-attaches the
        // current auth session token — which the function gateway rejected with
        // UNAUTHORIZED_UNSUPPORTED_TOKEN_ALGORITHM under ES256 keys — and
        // (b) was observed to send an empty body in this environment, causing
        // the function to throw "Unexpected end of JSON input".
        const res = await fetch(`${SUPABASE_URL}/functions/v1/family-lookup`, {
            method:  'POST',
            headers: {
                'Content-Type':  'application/json',
                apikey:          SUPABASE_ANON_KEY,
                Authorization:  `Bearer ${SUPABASE_ANON_KEY}`,
            },
            body: JSON.stringify({ email, pin: String(pin) }),
        });
        const data = await res.json().catch(() => null);
        if (!data) return null;
        if (data.error === 'login_locked') return { error: 'login_locked' };
        if (data.error) return null;
        return { family: data.family, isParent2: data.isParent2, sessionToken: data.sessionToken ?? null };
    } catch (_) {
        return null;
    }
}

/**
 * Creates a new family, or updates the existing one if the email already exists.
 * Auto-generates a 4-digit PIN if none is provided. PINs are written via the
 * set_family_pin RPC, which bcrypt-hashes them server-side.
 * @param {Object}             params
 * @param {string}             params.parentName
 * @param {string}             params.parentEmail
 * @param {string}             [params.parentPhone]
 * @param {string|number|null} [params.pin]          - Explicit PIN; auto-generated if omitted
 * @param {string|null}        [params.parent2Name]
 * @param {string|null}        [params.parent2Email]
 * @param {string|null}        [params.parent2Phone]
 * @param {string|number|null} [params.parent2Pin]
 * @returns {Promise<Family>}
 */
async function createFamily({ parentName, parentEmail, parentPhone, pin: providedPin = null,
                              parent2Name = null, parent2Email = null, parent2Phone = null, parent2Pin = null }) {
    if (!sbClient) throw new Error('Supabase not configured.');

    // PINs are stored as bcrypt hashes; route every write through the RPC so
    // plaintext never lands in a column.
    async function applyPin(familyId, newPin, isParent2) {
        if (newPin === null || newPin === '' || newPin === undefined) return;
        const { error } = await sbClient.rpc('set_family_pin', {
            p_family_id:  familyId,
            p_new_pin:    String(newPin),
            p_is_parent2: isParent2,
        });
        if (error) throw error;
    }

    if (parentEmail) {
        const { data: existing } = await sbClient
            .from('families').select('id')
            .eq('parent_email', parentEmail).maybeSingle();
        if (existing) {
            const updateData = { parent_name: parentName, parent_phone: parentPhone || '' };
            if (parent2Name !== null) updateData.parent2_name = parent2Name || null;
            if (parent2Email !== null) updateData.parent2_email = parent2Email || null;
            if (parent2Phone !== null) updateData.parent2_phone = parent2Phone || null;
            await sbClient.from('families').update(updateData).eq('id', existing.id);
            await applyPin(existing.id, providedPin,  false);
            await applyPin(existing.id, parent2Pin,   true);
            const { data: updated } = await sbClient
                .from('families')
                .select('id, parent_name, parent_email, parent_phone, has_pin, parent2_name, parent2_email, parent2_phone, has_parent2_pin, students(id, child_name, child_dob, room_override, recurring_days)')
                .eq('id', existing.id).single();
            return updated;
        }
    }

    const pin = providedPin || Math.floor(1000 + Math.random() * 9000);

    const { data, error } = await sbClient
        .from('families')
        .insert({ parent_name: parentName, parent_email: parentEmail || '', parent_phone: parentPhone || '',
                  parent2_name: parent2Name || null, parent2_email: parent2Email || null,
                  parent2_phone: parent2Phone || null })
        .select('id, parent_name, parent_email, parent_phone, has_pin, parent2_name, parent2_email, parent2_phone, has_parent2_pin')
        .single();
    if (error) throw error;
    await applyPin(data.id, pin,        false);
    await applyPin(data.id, parent2Pin, true);
    // Refresh so has_pin reflects the just-set hash
    const { data: refreshed } = await sbClient
        .from('families')
        .select('id, parent_name, parent_email, parent_phone, has_pin, parent2_name, parent2_email, parent2_phone, has_parent2_pin')
        .eq('id', data.id).single();
    return refreshed || data;
}

/**
 * Adds a student to a family. Returns the existing student record if already present.
 * @param {Object}      params
 * @param {number}      params.familyId  - Family id
 * @param {string}      params.childName
 * @param {string|null} [params.childDob] - ISO 8601 date or null
 * @returns {Promise<Student>}
 */
async function addStudent({ familyId, childName, childDob, roomOverride = null, discountType = null, discountValue = null, discountNote = null, recurringDays = null }) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data: existing } = await sbClient
        .from('students').select('id')
        .eq('family_id', familyId).eq('child_name', childName).maybeSingle();
    if (existing) return existing;
    const { data, error } = await sbClient
        .from('students')
        .insert({
            family_id:      familyId,
            child_name:     childName,
            child_dob:      childDob || null,
            room_override:  roomOverride || null,
            discount_type:  discountType || null,
            discount_value: discountValue ?? null,
            discount_note:  discountNote || null,
            recurring_days: recurringDays || null,
        })
        .select().single();
    if (error) throw error;
    return data;
}

/**
 * Fetches all active families with nested students (admin use).
 * @param {Object}  [opts]
 * @param {boolean} [opts.includeArchived=false] - If true, includes inactive families
 * @returns {Promise<Family[]>}
 */
async function fetchAllFamilies({ includeArchived = false } = {}) {
    if (!sbClient) throw new Error('Supabase not configured.');
    let query = sbClient
        .from('families')
        .select('id, parent_name, parent_email, parent_phone, has_pin, parent2_name, parent2_email, parent2_phone, has_parent2_pin, created_at, active, group, registration_locked, registration_lock_reason, login_locked, students(id, child_name, child_dob, room_override, discount_type, discount_value, discount_note, recurring_days)')
        .order('parent_name');
    if (!includeArchived) query = query.eq('active', true);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

// ---- Family CRUD ----
/**
 * Updates arbitrary columns on a family row.
 * @param {number}  id      - Family id
 * @param {Partial<Family>} updates - Columns to update
 * @returns {Promise<void>}
 */
async function updateFamily(id, updates) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.from('families').update(updates).eq('id', id);
    if (error) throw error;
}

async function archiveFamily(id) {
    return updateFamily(id, { active: false });
}

// Fetch a single student's recurring_days by parent email + child name.
// Returns a string like "Mon,Tue,Fri" or null.
async function fetchStudentRecurringDays(parentEmail, childName) {
    if (!sbClient) return null;
    const { data, error } = await sbClient
        .from('families')
        .select('students(child_name, recurring_days)')
        .eq('parent_email', parentEmail)
        .maybeSingle();
    if (error || !data) return null;
    const student = (data.students || []).find(s =>
        (s.child_name || '').toLowerCase() === (childName || '').toLowerCase());
    return student?.recurring_days || null;
}

// The annual enrollment fee's "cycle year" label, given the renewal date
// ("MM-DD", month/day only — year is irrelevant and ignored). A student's
// reg_fee_paid_year is compared against this to decide whether they still
// owe the fee: once today's month/day reaches the renewal date, everyone's
// fee becomes due again for the new cycle, regardless of calendar year.
// Falls back to "01-01" (matches plain calendar-year behavior) if unset.
function currentFeeCycleYear(renewalMonthDay) {
    const renewalMD = /^\d{2}-\d{2}$/.test(renewalMonthDay || '') ? renewalMonthDay : '01-01';
    const now   = new Date();
    const todayMD = `${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    const year  = now.getFullYear();
    return todayMD >= renewalMD ? year : year - 1;
}

async function restoreFamily(id) {
    return updateFamily(id, { active: true });
}

async function setFamilyRegistrationLock(id, locked, reason = null) {
    const updates = { registration_locked: locked, registration_lock_reason: reason };
    return updateFamily(id, updates);
}

async function setFamilyLoginLock(id, locked) {
    const updates = { login_locked: locked };
    if (!locked) updates.login_attempts = 0;  // reset counter when admin unlocks
    return updateFamily(id, updates);
}

// Set a family PIN via the server-side RPC so the plaintext PIN is
// hashed with bcrypt (pgcrypto) and never stored in plain text.
// p_is_parent2: pass true to update the second parent's PIN.
async function setFamilyPin(familyId, newPin, isParent2 = false) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.rpc('set_family_pin', {
        p_family_id:  familyId,
        p_new_pin:    String(newPin),
        p_is_parent2: isParent2,
    });
    if (error) throw error;
}

// ---- Student CRUD ----
async function updateStudent(id, updates) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.from('students').update(updates).eq('id', id);
    if (error) throw error;
}

async function deleteStudent(id) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.from('students').delete().eq('id', id);
    if (error) throw error;
}

async function deleteFamily(id) {
    if (!sbClient) throw new Error('Supabase not configured.');
    // Delete children first, then the family record
    const { error: sErr } = await sbClient.from('students').delete().eq('family_id', id);
    if (sErr) throw sErr;
    const { error } = await sbClient.from('families').delete().eq('id', id);
    if (error) throw error;
}

async function mergeFamilies(fromId, toId) {
    if (!sbClient) throw new Error('Supabase not configured.');
    // Reassign all students from the source family to the target family
    const { error: sErr } = await sbClient
        .from('students').update({ family_id: toId }).eq('family_id', fromId);
    if (sErr) throw sErr;
    // Delete the now-empty source family record
    const { error } = await sbClient.from('families').delete().eq('id', fromId);
    if (error) throw error;
}

// ---- Bulk summer archive ----
async function archiveSummerFamilies() {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('families')
        .update({ active: false })
        .eq('group', 'summer')
        .eq('active', true)
        .select('id');
    if (error) throw error;
    return (data || []).length;
}

let _cachedAdminEmail = null;
async function getAdminEmail() {
    if (_cachedAdminEmail) return _cachedAdminEmail;
    const { data } = await sbClient.auth.getUser();
    _cachedAdminEmail = data?.user?.email || 'admin';
    return _cachedAdminEmail;
}

async function fetchStudents() {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('students')
        .select('id, child_name, child_dob, family_id, room_override, reg_fee_paid_year')
        .order('child_name');
    if (error) throw error;
    return data || [];
}

async function updateStudentRegFee(studentId, paidYear) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('students')
        .update({ reg_fee_paid_year: paidYear })
        .eq('id', studentId);
    if (error) throw error;
}

async function updateStudentRoomOverride(studentId, roomOverride) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('students')
        .update({ room_override: roomOverride || null })
        .eq('id', studentId);
    if (error) throw error;
}

async function importFamiliesData(rows) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const byKey = {};
    rows.forEach(r => {
        if (!r.parentName) return;
        const key = (r.parentEmail || r.parentName).toLowerCase().trim();
        if (!byKey[key]) {
            byKey[key] = { parentName: r.parentName, parentEmail: r.parentEmail || '', parentPhone: r.parentPhone || '', pin: r.parentPin || null,
                           parent2Name: r.parent2Name || null, parent2Email: r.parent2Email || null,
                           parent2Phone: r.parent2Phone || null, parent2Pin: r.parent2Pin || null,
                           children: [] };
        }
        if (r.childName) byKey[key].children.push({ childName: r.childName, childDob: r.childDob || null });
    });

    let familiesImported = 0, studentsImported = 0;
    for (const group of Object.values(byKey)) {
        try {
            const fam = await createFamily({ parentName: group.parentName, parentEmail: group.parentEmail, parentPhone: group.parentPhone, pin: group.pin,
                                             parent2Name: group.parent2Name, parent2Email: group.parent2Email,
                                             parent2Phone: group.parent2Phone, parent2Pin: group.parent2Pin });
            familiesImported++;
            for (const child of group.children) {
                await addStudent({ familyId: fam.id, childName: child.childName, childDob: child.childDob });
                studentsImported++;
            }
        } catch (e) { console.warn('Import row failed:', e); }
    }
    return { familiesImported, studentsImported };
}

// ============================================================
// MESSAGES  (Contact Us from parent portal)
// ============================================================
async function addMessage({ parentName, parentEmail, message }) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('messages')
        .insert({ parent_name: parentName, parent_email: parentEmail, message });
    if (error) throw error;
}

async function submitFamilyDeletionRequest({ familyId, parentEmail, parentName, reason }) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('deletion_requests')
        .insert({ family_id: familyId, parent_email: parentEmail, parent_name: parentName, reason });
    if (error) throw error;
}

// fetchRegistrationsByEmail — used by parent lookup portal
async function fetchRegistrationsByEmail(email) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('registrations')
        .select(`
            id, created_at, status,
            parent_name, parent_email, parent_phone,
            child_name, room_id,
            registration_dates ( care_date, waitlisted, day_type )
        `)
        .ilike('parent_email', email)
        .order('created_at', { ascending: false })
        .limit(50);
    if (error) throw error;
    return data || [];
}

// ============================================================
// ADMIN AUTH  (Supabase Auth — server-validated)
// ============================================================
/**
 * Signs in an admin user via Supabase Auth.
 * @param {string} email
 * @param {string} password
 * @returns {Promise<import('@supabase/supabase-js').AuthResponse['data']>}
 */
async function loginAdmin(email, password) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
}

/**
 * Signs out the current admin session.
 * @returns {Promise<void>}
 */
async function logoutAdmin() {
    if (!sbClient) return;
    await sbClient.auth.signOut();
}

/**
 * Returns the active Supabase Auth session, or null if not authenticated.
 * @returns {Promise<import('@supabase/supabase-js').Session|null>}
 */
async function getAdminSession() {
    if (!sbClient) return null;
    const { data: { session } } = await sbClient.auth.getSession();
    return session;
}

// ============================================================
// LOOKUP — requires BOTH email AND PIN (from families table)
// ============================================================
async function lookupFamilyByEmailAndPin(email, pin) {
    if (!sbClient) return null;
    try {
        const result = await familyLogin(email, pin);
        if (!result || result.error === 'not_found' || result.error === 'invalid_pin' || result.error === 'invalid_credentials') return null;
        if (result.error === 'login_locked') return { login_locked: true };
        // Return the full family object so callers have all fields for display and export.
        // Override parent_email with the login email so the portal shows the right address.
        const loginEmail = result.isParent2 ? result.family.parent2_email : result.family.parent_email;
        return { ...result.family, parent_email: loginEmail, login_locked: false };
    } catch (_) {
        return null;
    }
}

// ============================================================
// SETTINGS — room rates, weekly rates (stored in `settings` table)
// ============================================================

// Load room rates (and age ranges) from Supabase and merge into ROOMS array.
// Returns true if settings were loaded, false if table doesn't exist yet.
async function loadRateSettings() {
    if (!sbClient) return false;
    try {
        const { data, error } = await sbClient
            .from('settings')
            .select('value')
            .eq('key', 'room_rates')
            .maybeSingle();
        if (error || !data) return false;
        const raw   = data.value;
        const rates = typeof raw === 'string' ? parseJsonOr(raw, null) : raw;
        if (!rates || typeof rates !== 'object' || Array.isArray(rates)) return false;
        // Merge fetched rates into ROOMS array
        ROOMS.forEach(room => {
            const r = rates[room.id];
            if (!r) return;
            if (r.fullDayRate    != null) room.fullDayRate    = r.fullDayRate;
            if (r.halfDayRate    != null) room.halfDayRate    = r.halfDayRate;
            if (r.weeklyFullRate != null) room.weeklyFullRate = r.weeklyFullRate;
            if (r.weeklyHalfRate != null) room.weeklyHalfRate = r.weeklyHalfRate;
            if ('ageMinMonths'   in r)    room.ageMinMonths   = r.ageMinMonths; // allow null
            if ('ageMaxMonths'   in r)    room.ageMaxMonths   = r.ageMaxMonths; // allow null
            if (r.ages           != null) room.ages           = r.ages;
        });
        return true;
    } catch (_) {
        return false;
    }
}

// Save room rates (and age ranges) to Supabase.
async function saveRateSettings(rates) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('settings')
        .upsert({ key: 'room_rates', value: rates }, { onConflict: 'key' });
    if (error) throw error;
}

// Load summer camp hidden flag from Supabase and apply to ROOMS.
async function loadSummerCampSetting() {
    const val = await fetchSetting('hide_summer_camp');
    const summerRoom = ROOMS.find(r => r.id === 'summer');
    if (summerRoom) summerRoom.hidden = val === true || val === 'true';
    return summerRoom?.hidden || false;
}

// Save summer camp hidden flag to Supabase.
async function saveSummerCampSetting(hidden) {
    await upsertSetting('hide_summer_camp', hidden);
}

// Load enrollment-at-capacity flag from Supabase.
async function loadEnrollmentCapacitySetting() {
    const val = await fetchSetting('enrollment_at_capacity');
    return val === true || val === 'true';
}

// Save enrollment-at-capacity flag to Supabase.
async function saveEnrollmentCapacitySetting(atCapacity) {
    await upsertSetting('enrollment_at_capacity', atCapacity);
}

// Load enrollment forms metadata (array of {id, name, description, filename, url}).
async function loadEnrollmentForms() {
    const val = await fetchSetting('enrollment_forms');
    if (!Array.isArray(val)) return [];
    return val;
}

// Save enrollment forms metadata array to settings.
async function saveEnrollmentForms(forms) {
    await upsertSetting('enrollment_forms', forms);
}

// Upload a file to the enrollment-forms storage bucket and return its public URL.
async function uploadEnrollmentFormFile(file, filename) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.storage.from('enrollment-forms').upload(filename, file, {
        contentType: file.type || 'application/pdf',
        upsert: false,
    });
    if (error) throw error;
    const { data } = sbClient.storage.from('enrollment-forms').getPublicUrl(filename);
    return data.publicUrl;
}

// Delete a file from the enrollment-forms storage bucket.
async function deleteEnrollmentFormFile(filename) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.storage.from('enrollment-forms').remove([filename]);
    if (error) throw error;
}

// Upload a staff headshot to the staff-photos storage bucket and return its public URL.
async function uploadStaffPhoto(file, filename) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.storage.from('staff-photos').upload(filename, file, {
        contentType: file.type || 'image/jpeg',
        upsert: false,
    });
    if (error) throw error;
    const { data } = sbClient.storage.from('staff-photos').getPublicUrl(filename);
    return data.publicUrl;
}

// Load staff-to-child ratios from Supabase and merge into ROOMS array.
async function loadRatioSettings() {
    if (!sbClient) return false;
    try {
        const { data, error } = await sbClient
            .from('settings')
            .select('value')
            .eq('key', 'staff_ratios')
            .maybeSingle();
        if (error || !data) return false;
        const raw    = data.value;
        const ratios = typeof raw === 'string' ? parseJsonOr(raw, null) : raw;
        if (!ratios || typeof ratios !== 'object' || Array.isArray(ratios)) return false;
        ROOMS.forEach(room => {
            if (ratios[room.id] != null) room.staffRatio = ratios[room.id];
        });
        return true;
    } catch (_) {
        return false;
    }
}

// Save staff-to-child ratios to Supabase.
async function saveRatioSettings(ratios) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('settings')
        .upsert({ key: 'staff_ratios', value: ratios }, { onConflict: 'key' });
    if (error) throw error;
}

// Load room capacities from Supabase and merge into ROOMS array.
async function loadCapacitySettings() {
    if (!sbClient) return false;
    try {
        const { data, error } = await sbClient
            .from('settings')
            .select('value')
            .eq('key', 'room_capacity')
            .maybeSingle();
        if (error || !data) return false;
        const raw       = data.value;
        const capacities = typeof raw === 'string' ? parseJsonOr(raw, null) : raw;
        if (!capacities || typeof capacities !== 'object' || Array.isArray(capacities)) return false;
        ROOMS.forEach(room => {
            if (capacities[room.id] != null) room.capacity = capacities[room.id];
        });
        return true;
    } catch (_) {
        return false;
    }
}

// Save room capacities to Supabase.
async function saveCapacitySettings(capacities) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('settings')
        .upsert({ key: 'room_capacity', value: capacities }, { onConflict: 'key' });
    if (error) throw error;
}

// Load global offer email links from Supabase.
async function loadOfferLinks() {
    if (!sbClient) return { procareLink: null, paperworkLinks: [] };
    try {
        const { data, error } = await sbClient
            .from('settings')
            .select('value')
            .eq('key', 'offer_links')
            .maybeSingle();
        if (error || !data) return { procareLink: null, paperworkLinks: [] };
        // Guard: value column may be text instead of jsonb — parse if so.
        const raw = data.value;
        if (typeof raw === 'string') return parseJsonOr(raw, { procareLink: null, paperworkLinks: [] });
        return (raw && typeof raw === 'object' && !Array.isArray(raw))
            ? raw
            : { procareLink: null, paperworkLinks: [] };
    } catch (_) {
        return { procareLink: null, paperworkLinks: [] };
    }
}

// Save global offer email links to Supabase.
async function saveOfferLinks(links) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('settings')
        .upsert({ key: 'offer_links', value: links }, { onConflict: 'key' });
    if (error) throw error;
}

// Delete a waitlist application permanently.
async function deleteWaitlistApplication(id) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('waitlist_applications')
        .delete()
        .eq('id', id);
    if (error) throw error;
}

// ============================================================
// STAFF  (payroll)
// ============================================================
async function fetchAllStaff({ includeInactive = false } = {}) {
    if (!sbClient) throw new Error('Supabase not configured.');
    let query = sbClient
        .from('staff')
        .select('id, name, email, role, hourly_rate, pay_type, salary_biweekly, room_id, active, hire_date, has_staff_pin, created_at')
        .order('name');
    if (!includeInactive) query = query.eq('active', true);
    const { data, error } = await query;
    if (error) throw friendlyError(error);
    return data || [];
}

async function upsertStaffMember({ id = null, name, email, role, payType, hourlyRate, salaryBiweekly, roomId, hireDate, staffPin }) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const record = {
        name,
        email:            email || null,
        role:             role || null,
        pay_type:         payType || 'hourly',
        hourly_rate:      payType === 'salary' ? 0 : (hourlyRate || 0),
        salary_biweekly:  payType === 'salary' ? (salaryBiweekly || 0) : 0,
        room_id:          roomId || null,
        hire_date:        hireDate || null,
    };
    let staffId = id;
    if (id) {
        const { error } = await sbClient.from('staff').update(record).eq('id', id);
        if (error) throw error;
    } else {
        const { data, error } = await sbClient.from('staff').insert(record).select('id').single();
        if (error) throw error;
        staffId = data?.id || null;
    }
    if (staffPin && staffId) {
        const { error } = await sbClient.rpc('set_staff_pin', {
            p_staff_id: staffId,
            p_new_pin:  parseInt(staffPin, 10),
        });
        if (error) throw error;
    }
    return staffId;
}

async function deleteStaff(id) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.from('staff').delete().eq('id', id);
    if (error) throw error;
}

async function setStaffActive(id, active) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.from('staff').update({ active }).eq('id', id);
    if (error) throw error;
}

// ============================================================
// STAFF HOURS  (payroll)
// ============================================================
/**
 * Fetches staff hours records for a date range.
 * @param {string} startDate - ISO 8601 date (YYYY-MM-DD), inclusive
 * @param {string} endDate   - ISO 8601 date (YYYY-MM-DD), inclusive
 * @returns {Promise<StaffHours[]>}
 */
async function fetchStaffHours(startDate, endDate) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('staff_hours')
        .select('id, staff_id, work_date, hours_worked, notes, time_in, time_out, room_id')
        .gte('work_date', startDate)
        .lte('work_date', endDate)
        .order('work_date');
    if (error) throw error;
    return data || [];
}

/**
 * Creates or updates a staff hours row for a given staff member and date.
 * @param {number} staffId     - Staff id
 * @param {string} workDate    - ISO 8601 date (YYYY-MM-DD)
 * @param {number} hoursWorked - Total hours worked
 * @param {string} [notes]     - Optional notes
 * @returns {Promise<void>}
 */
async function upsertStaffHours(staffId, workDate, hoursWorked, notes, timeIn = null, timeOut = null, roomId = null) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const payload = { staff_id: staffId, work_date: workDate, hours_worked: hoursWorked, notes: notes || '' };
    if (timeIn  !== null) payload.time_in  = timeIn;
    if (timeOut !== null) payload.time_out = timeOut;
    if (roomId  !== null) payload.room_id  = roomId;
    const { error } = await sbClient
        .from('staff_hours')
        .upsert(payload, { onConflict: 'staff_id,work_date' });
    if (error) throw error;
}

/**
 * Fetches staff hours joined with staff pay info for a date range.
 * Used by the Room P&L fallback when no schedule data exists.
 * @returns {Promise<Array<{staff_id, staff_name, work_date, hours_worked, pay_type, hourly_rate, salary_biweekly}>>}
 */
async function fetchStaffHoursWithPay(startDate, endDate) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('staff_hours')
        .select(`
            staff_id,
            work_date,
            hours_worked,
            staff:staff_id(name, pay_type, hourly_rate, salary_biweekly)
        `)
        .gte('work_date', startDate)
        .lte('work_date', endDate)
        .order('work_date');
    if (error) throw error;
    return (data || []).map(r => ({
        staff_id:        r.staff_id,
        staff_name:      r.staff?.name ?? '(unknown)',
        work_date:       r.work_date,
        hours_worked:    parseFloat(r.hours_worked) || 0,
        pay_type:        r.staff?.pay_type ?? 'hourly',
        hourly_rate:     parseFloat(r.staff?.hourly_rate) || 0,
        salary_biweekly: parseFloat(r.staff?.salary_biweekly) || 0,
    }));
}

// ============================================================
// STAFF SCHEDULES  (auto-fill planner persistence)
// ============================================================

/**
 * Persists a full week of auto-fill schedule assignments.
 * Deletes existing rows for the given dates first, then bulk-inserts
 * the new ones (replace-on-save semantics).
 *
 * @param {string[]} weekDates   - Array of ISO dates (YYYY-MM-DD) for the week
 * @param {Object}   assignments - { date: { roomId: { am: [names], pm: [names] } } }
 * @param {Object[]} staffList   - Array of staff records with { id, name }
 * @returns {Promise<number>}    - Count of rows inserted
 */
async function saveStaffScheduleWeek(weekDates, assignments, staffList) {
    if (!sbClient) throw new Error('Supabase not configured.');
    if (!weekDates?.length) throw new Error('No dates provided.');

    // Build name → id lookup (case-insensitive)
    const nameToId = new Map(
        staffList.map(s => [s.name.trim().toLowerCase(), s.id])
    );

    // Flatten the nested assignments structure into DB rows
    const rows = [];
    for (const date of weekDates) {
        const dayAssign = assignments[date];
        if (!dayAssign) continue;
        for (const [roomId, shifts] of Object.entries(dayAssign)) {
            for (const shift of ['am', 'pm']) {
                for (const name of (shifts[shift] || [])) {
                    const staffId = nameToId.get(name.trim().toLowerCase());
                    if (!staffId) {
                        console.warn(`saveStaffScheduleWeek: no staff ID for "${name}" — skipping`);
                        continue;
                    }
                    rows.push({ staff_id: staffId, work_date: date, room_id: roomId, shift });
                }
            }
        }
    }

    // Delete the whole week first, then reinsert (clean replace)
    const { error: delError } = await sbClient
        .from('staff_schedules')
        .delete()
        .gte('work_date', weekDates[0])
        .lte('work_date', weekDates[weekDates.length - 1]);
    if (delError) throw friendlyError(delError);

    if (!rows.length) return 0;

    const { error: insError } = await sbClient
        .from('staff_schedules')
        .insert(rows);
    if (insError) throw friendlyError(insError);

    return rows.length;
}

/**
 * Fetches saved schedule assignments for a date range, with staff names.
 * Used to reload a saved week in the schedule planner.
 *
 * @param {string} startDate - ISO date, inclusive
 * @param {string} endDate   - ISO date, inclusive
 * @returns {Promise<Array<{staff_id, staff_name, work_date, room_id, shift}>>}
 */
async function fetchStaffScheduleWeek(startDate, endDate) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('staff_schedules')
        .select('staff_id, work_date, room_id, shift, staff:staff_id(name)')
        .gte('work_date', startDate)
        .lte('work_date', endDate)
        .order('work_date')
        .order('room_id')
        .order('shift');
    if (error) throw friendlyError(error);
    return (data || []).map(r => ({
        staff_id:   r.staff_id,
        staff_name: r.staff?.name ?? '',
        work_date:  r.work_date,
        room_id:    r.room_id,
        shift:      r.shift,
    }));
}

/**
 * Fetches schedule assignments with pay rate data for Room P&L cost allocation.
 * Returns one record per staff-member per shift per day, enriched with pay
 * fields so the caller can compute per-room labor cost.
 *
 * @param {string} startDate - ISO date, inclusive
 * @param {string} endDate   - ISO date, inclusive
 * @returns {Promise<Array<{
 *   staff_id, staff_name, work_date, room_id, shift,
 *   pay_type, hourly_rate, salary_biweekly
 * }>>}
 */
async function fetchStaffScheduleRange(startDate, endDate) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('staff_schedules')
        .select(`
            staff_id,
            work_date,
            room_id,
            shift,
            staff:staff_id(name, pay_type, hourly_rate, salary_biweekly)
        `)
        .gte('work_date', startDate)
        .lte('work_date', endDate)
        .order('work_date')
        .order('room_id');
    if (error) throw friendlyError(error);
    return (data || []).map(r => ({
        staff_id:        r.staff_id,
        staff_name:      r.staff?.name ?? '',
        work_date:       r.work_date,
        room_id:         r.room_id,
        shift:           r.shift,
        pay_type:        r.staff?.pay_type ?? 'hourly',
        hourly_rate:     parseFloat(r.staff?.hourly_rate) || 0,
        salary_biweekly: parseFloat(r.staff?.salary_biweekly) || 0,
    }));
}

// ============================================================
// STAFF CLOCK EVENTS  (teacher clock-in/out)
// ============================================================
/**
 * Looks up an active staff member by their clock-in PIN.
 * @param {string|number} pin - Staff clock-in PIN
 * @returns {Promise<StaffRecord|null>} Matching staff row, or null if not found
 */
async function fetchStaffByPin(pin) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient.rpc('lookup_staff_by_pin', { p_pin: parseInt(pin, 10) });
    if (error) throw error;
    return data; // null if not found
}

/**
 * Returns the most recent open (clocked-in, not yet clocked-out) event for the given date,
 * or null if the staff member is not currently clocked in.
 * @param {number} staffId  - Staff id
 * @param {string} workDate - ISO 8601 date (YYYY-MM-DD)
 * @returns {Promise<{id:number, clock_in:string, clock_out:null}|null>}
 */
async function getClockStatus(staffId, workDate) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('staff_clock_events')
        .select('id, clock_in, clock_out')
        .eq('staff_id', staffId)
        .eq('work_date', workDate)
        .is('clock_out', null)
        .order('clock_in', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (error) throw error;
    return data; // null = not currently clocked in
}

/**
 * Records a clock-in event. Each call inserts a new row, supporting multiple shifts per day.
 * @param {number} staffId  - Staff id
 * @param {string} workDate - ISO 8601 date (YYYY-MM-DD)
 * @returns {Promise<void>}
 */
async function clockIn(staffId, workDate, roomId = null, { lat = null, lon = null, outsideFence = false } = {}) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const now = new Date().toISOString();
    const row = { staff_id: staffId, work_date: workDate, clock_in: now, clock_out: null, room_id: roomId || null };
    if (lat != null) { row.clock_in_lat = lat; row.clock_in_lon = lon; }
    row.clock_in_outside_fence = outsideFence || false;
    const { error } = await sbClient.from('staff_clock_events').insert(row);
    if (error) throw error;
}

/**
 * Records a clock-out by closing the most recent open event for the given staff/day.
 * @param {number} staffId  - Staff id
 * @param {string} workDate - ISO 8601 date (YYYY-MM-DD)
 * @returns {Promise<void>}
 */
async function clockOut(staffId, workDate, { lat = null, lon = null, outsideFence = false } = {}) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const now = new Date().toISOString();
    const { data: open } = await sbClient
        .from('staff_clock_events')
        .select('id')
        .eq('staff_id', staffId)
        .eq('work_date', workDate)
        .is('clock_out', null)
        .order('clock_in', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (!open) throw new Error('No clock-in record found. Please clock in first.');
    const update = { clock_out: now };
    if (lat != null) { update.clock_out_lat = lat; update.clock_out_lon = lon; }
    update.clock_out_outside_fence = outsideFence || false;
    const { error } = await sbClient.from('staff_clock_events').update(update).eq('id', open.id);
    if (error) throw error;
}

async function fetchClockEventsForDate(workDate) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('staff_clock_events')
        .select('id, staff_id, clock_in, clock_out, work_date, room_id')
        .eq('work_date', workDate);
    if (error) throw error;
    return data || [];
}

async function fetchClockEventsForRange(startDate, endDate) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('staff_clock_events')
        .select('id, staff_id, clock_in, clock_out, work_date, room_id')
        .gte('work_date', startDate)
        .lte('work_date', endDate);
    if (error) throw error;
    return data || [];
}

async function insertManualClockEvent(staffId, workDate, clockInISO, clockOutISO) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('staff_clock_events')
        .insert({ staff_id: staffId, work_date: workDate, clock_in: clockInISO, clock_out: clockOutISO || null });
    if (error) throw error;
}

async function updateClockEventOut(eventId, clockOutISO) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('staff_clock_events')
        .update({ clock_out: clockOutISO })
        .eq('id', eventId);
    if (error) throw error;
}

async function updateClockEvent(eventId, clockInISO, clockOutISO) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('staff_clock_events')
        .update({ clock_in: clockInISO, clock_out: clockOutISO || null })
        .eq('id', eventId);
    if (error) throw error;
}

async function updateClockEventsRoom(staffId, workDate, roomId) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('staff_clock_events')
        .update({ room_id: roomId || null })
        .eq('staff_id', staffId)
        .eq('work_date', workDate);
    if (error) throw error;
}

async function updateClockEventRoom(eventId, roomId) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('staff_clock_events')
        .update({ room_id: roomId || null })
        .eq('id', eventId);
    if (error) throw error;
}

async function deleteClockEvent(eventId) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('staff_clock_events')
        .delete()
        .eq('id', eventId);
    if (error) throw error;
}

async function fetchStaffPtoEntries(periodStart) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('staff_pto_entries')
        .select('staff_id, pto_hours_used, pto_hours_earned')
        .eq('period_start', periodStart);
    if (error) throw error;
    return data || [];
}

async function upsertStaffPtoEntry(staffId, periodStart, ptoUsed, ptoEarned) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('staff_pto_entries')
        .upsert({ staff_id: staffId, period_start: periodStart, pto_hours_used: ptoUsed, pto_hours_earned: ptoEarned },
                { onConflict: 'staff_id,period_start' });
    if (error) throw error;
}

// ============================================================
// STAFF AVAILABILITY  (stored in settings table as JSON blob)
// ============================================================
// Shape: { "<staff_id>": { days: ["Mon","Tue","Wed","Thu","Fri"], maxHours: 40 }, ... }
async function fetchStaffAvailability() {
    if (!sbClient) return {};
    const { data } = await sbClient
        .from('settings')
        .select('value')
        .eq('key', 'staff_availability')
        .maybeSingle();
    // Guard: value column may be text instead of jsonb, in which case data.value
    // is a JSON string. Parse it so callers always receive a plain object.
    const raw = data?.value;
    if (!raw) return {};
    if (typeof raw === 'string') return parseJsonOr(raw, {});
    return (typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
}

async function saveStaffAvailability(availMap) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('settings')
        .upsert({ key: 'staff_availability', value: availMap }, { onConflict: 'key' });
    if (error) throw error;
}

// ============================================================
// ADMIN ROLES  (access control)
// ============================================================
/**
 * Loads the admin roles map from the settings table.
 * @returns {Promise<AdminRolesMap>} Map of lowercase email → role string (empty object if none)
 */
async function loadAdminRoles() {
    if (!sbClient) return {};
    try {
        const { data, error } = await sbClient
            .from('settings')
            .select('value')
            .eq('key', 'admin_roles')
            .maybeSingle();
        if (error || !data) return {};
        const raw = data.value;
        if (typeof raw === 'string') return parseJsonOr(raw, {});
        return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {};
    } catch (_) {
        return {};
    }
}

/**
 * Persists the admin roles map to the settings table.
 * @param {AdminRolesMap} rolesMap - Map of lowercase email → role string
 * @returns {Promise<void>}
 */
async function saveAdminRoles(rolesMap) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('settings')
        .upsert({ key: 'admin_roles', value: rolesMap }, { onConflict: 'key' });
    if (error) throw error;
}

// ============================================================
// HISTORICAL PAYROLL RECORDS  (stored in settings table as JSON blob)
// ============================================================
// Shape: [{ id, label, total_paid, notes }, ...]
async function fetchHistoricalPayroll() {
    if (!sbClient) return [];
    const { data } = await sbClient
        .from('settings')
        .select('value')
        .eq('key', 'historical_payroll')
        .maybeSingle();
    const raw = data?.value;
    if (!raw) return [];
    if (typeof raw === 'string') return parseJsonOr(raw, []);
    return Array.isArray(raw) ? raw : [];
}

async function saveHistoricalPayroll(records) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('settings')
        .upsert({ key: 'historical_payroll', value: records }, { onConflict: 'key' });
    if (error) throw error;
}

// ── Expense Config (Finance tab) ─────────────────────────────
// Shape: { items: [{ id, label, type:'monthly'|'annual', amount, month:1-12|null, notes }] }
async function fetchExpenseConfig() {
    if (!sbClient) return { items: [] };
    const { data } = await sbClient.from('settings').select('value')
        .eq('key', 'expense_config').maybeSingle();
    const raw = data?.value;
    if (!raw) return { items: [] };
    if (typeof raw === 'string') return parseJsonOr(raw, { items: [] });
    return (raw && typeof raw === 'object') ? raw : { items: [] };
}

async function saveExpenseConfig(config) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.from('settings')
        .upsert({ key: 'expense_config', value: config }, { onConflict: 'key' });
    if (error) throw error;
}

async function fetchAnnualBudget(year) {
    if (!sbClient) return null;
    const { data } = await sbClient.from('settings').select('value')
        .eq('key', `annual_budget_${year}`).maybeSingle();
    const raw = data?.value;
    if (!raw) return null;
    if (typeof raw === 'string') return parseJsonOr(raw, null);
    return (raw && typeof raw === 'object') ? raw : null;
}

async function saveAnnualBudget(year, budget) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.from('settings')
        .upsert({ key: `annual_budget_${year}`, value: budget }, { onConflict: 'key' });
    if (error) throw error;
}

async function sendPasswordReset(email) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.auth.resetPasswordForEmail(email, {
        redirectTo: window.location.href,
    });
    if (error) throw error;
}

async function callAdminUsers(action, payload = {}) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data: { session } } = await sbClient.auth.getSession();
    const token = session?.access_token;
    if (!token) throw new Error('Not authenticated.');
    const { data, error } = await sbClient.functions.invoke('admin-users', {
        body: { action, ...payload },
        headers: { Authorization: `Bearer ${token}` },
    });
    if (error) throw error;
    return data;
}

// ============================================================
// WAITLIST APPLICATIONS
// ============================================================
// SQL — run once in Supabase SQL Editor to create the table:
//
//   CREATE TABLE IF NOT EXISTS waitlist_applications (
//       id                 BIGSERIAL PRIMARY KEY,
//       applied_at         TIMESTAMPTZ DEFAULT NOW(),
//       status             TEXT        DEFAULT 'pending',
//       parent_name        TEXT        NOT NULL,
//       parent_email       TEXT        NOT NULL,
//       parent_phone       TEXT,
//       child_name         TEXT        NOT NULL,
//       child_dob          DATE,
//       expected_due_date  DATE,
//       desired_start_date DATE        NOT NULL,
//       start_flexibility  TEXT        DEFAULT 'flexible',
//       days_of_week       TEXT,
//       day_type           TEXT        DEFAULT 'full',
//       has_sibling        BOOLEAN     DEFAULT FALSE,
//       sibling_child_name TEXT,
//       sibling_room_id    TEXT,
//       notes              TEXT,
//       offered_at         TIMESTAMPTZ,
//       offer_deadline     DATE,
//       offer_notes        TEXT,
//       paperwork_received BOOLEAN     DEFAULT FALSE,
//       deposit_paid       BOOLEAN     DEFAULT FALSE,
//       archived_at        TIMESTAMPTZ,
//       archive_reason     TEXT
//   );
//   ALTER TABLE waitlist_applications ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "Public insert" ON waitlist_applications FOR INSERT WITH CHECK (true);
//   CREATE POLICY "Auth all"     ON waitlist_applications FOR ALL  USING (auth.role() = 'authenticated');

async function submitWaitlistApplication(data) {
    if (!sbClient) throw new Error('Supabase is not configured yet.');
    const { data: result, error } = await sbClient
        .from('waitlist_applications')
        .insert(data)
        .select()
        .single();
    if (error) throw error;
    return result;
}

/**
 * Fetches all waitlist applications ordered by application date (oldest first).
 * @returns {Promise<WaitlistEntry[]>}
 */
async function fetchWaitlistApplications() {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('waitlist_applications')
        .select('*')
        .order('applied_at', { ascending: true });
    if (error) throw error;
    return data || [];
}

/**
 * Updates a waitlist application (e.g. to change status or record offer_sent_at).
 * @param {number}                   id     - Waitlist application id
 * @param {Partial<WaitlistEntry>}   fields - Fields to update
 * @returns {Promise<void>}
 */
async function updateWaitlistApplication(id, fields) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('waitlist_applications')
        .update(fields)
        .eq('id', id);
    if (error) throw error;
}

async function sendWaitlistOfferEmail({ parentName, parentEmail, childName, offerDeadline, offerNotes, papeworkLinks, procareLink }) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data: { session } } = await sbClient.auth.getSession();
    const token = session?.access_token || SUPABASE_ANON_KEY;
    const { data, error } = await sbClient.functions.invoke('send-waitlist-offer', {
        body: { parentName, parentEmail, childName, offerDeadline, offerNotes, papeworkLinks, procareLink },
        headers: { Authorization: `Bearer ${token}` },
    });
    if (error) throw error;
    return data;
}

/**
 * Sends the "we received your inquiry" auto-reply to the applicant plus a
 * new-inquiry heads-up to the configured admin notify address. Called by the
 * public inquiry form right after a successful insert. The edge function looks
 * up the email addresses itself from the applicationId (service role), so no
 * PII needs to travel back through this anonymous call.
 */
async function sendWaitlistConfirmationEmail(applicationId) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient.functions.invoke('send-waitlist-confirmation', {
        body: { applicationId },
        headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (error) throw error;
    return data;
}

/**
 * Parent-facing response to a "still interested?" tour reminder email.
 * @param {string}  token       - The application's interest_token (from the emailed link)
 * @param {boolean} interested  - true = still interested, false = no longer needed
 */
async function confirmWaitlistInterest(token, interested) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient.functions.invoke('confirm-waitlist-interest', {
        body: { token, interested },
        headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (error) throw error;
    return data;
}

/**
 * Updates tour-scheduling fields on a waitlist application (admin action).
 */
async function updateWaitlistTourStatus(id, fields) {
    return updateWaitlistApplication(id, fields);
}

// Load/save the address that gets notified whenever a new inquiry comes in.
async function loadWaitlistNotifySettings() {
    if (!sbClient) return { notifyEmail: null };
    try {
        const { data, error } = await sbClient
            .from('settings')
            .select('value')
            .eq('key', 'waitlist_notify')
            .maybeSingle();
        if (error || !data) return { notifyEmail: null };
        const raw = data.value;
        if (typeof raw === 'string') return parseJsonOr(raw, { notifyEmail: null });
        return (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : { notifyEmail: null };
    } catch (_) {
        return { notifyEmail: null };
    }
}

async function saveWaitlistNotifySettings(settings) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('settings')
        .upsert({ key: 'waitlist_notify', value: settings }, { onConflict: 'key' });
    if (error) throw error;
}

/**
 * Sends the registration confirmation email to a parent via Edge Function.
 * @param {Object}   params
 * @param {string}   params.parentName
 * @param {string}   params.parentEmail
 * @param {string}   params.monthLabel   - e.g. 'April 2026'
 * @param {string[]} params.childNames
 * @param {Array}    params.dates        - Formatted date objects for the email body
 * @param {number}   params.grandTotal   - Total billed amount in dollars
 * @returns {Promise<Object>} Edge function response data
 */
async function sendScheduleEmail({ parentName, parentEmail, monthLabel, childNames, dates, grandTotal }) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient.functions.invoke('send-schedule-confirmation', {
        body: { parentName, parentEmail, monthLabel, childNames, dates, grandTotal },
        headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
    if (error) throw error;
    return data;
}

async function sendScheduleChangeEmail({ parentName, parentEmail, childName, monthLabel, existingDates, addedDate, changeFee }) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient.functions.invoke('send-schedule-change', {
        body: { parentName, parentEmail, childName, monthLabel, existingDates, addedDate, changeFee },
    });
    if (error) throw error;
    return data;
}

async function sendStaffScheduleEmail({ staffName, staffEmail, weekStart, shifts }) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data: { session } } = await sbClient.auth.getSession();
    const token = session?.access_token || SUPABASE_ANON_KEY;
    const { data, error } = await sbClient.functions.invoke('send-staff-schedule', {
        body: { staffName, staffEmail, weekStart, shifts },
        headers: { Authorization: `Bearer ${token}` },
    });
    if (error) throw error;
    return data;
}

// ── Historical Attendance Summary ──────────────────────────────

async function fetchBillingSummary() {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_summary')
        .select('*')
        .order('month')
        .order('room_id');
    if (error) throw error;
    return data || [];
}

async function fetchAttendanceSummary({ month, roomId } = {}) {
    if (!sbClient) throw new Error('Supabase not configured.');
    let q = sbClient
        .from('attendance_summary')
        .select('*')
        .order('summary_date')
        .order('room_id');
    if (month) {
        // Use next-month boundary to avoid invalid dates like "2026-02-31"
        const [y, m] = month.split('-').map(Number);
        const nextMonth = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
        q = q.gte('summary_date', `${month}-01`).lt('summary_date', `${nextMonth}-01`);
    }
    if (roomId) {
        q = q.eq('room_id', roomId);
    }
    const { data, error } = await q;
    if (error) throw error;
    return data || [];
}


// Count currently confirmed registrations per room.
// Returns { roomId: { total, full, half } } — used by finance modeling tool.
async function fetchConfirmedEnrollmentByRoom() {
    if (!sbClient) return {};
    const { data, error } = await sbClient
        .from('registrations')
        .select('id, room_id')
        .eq('status', 'confirmed');
    if (error) throw error;
    const out = {};
    for (const reg of (data || [])) {
        if (!out[reg.room_id]) out[reg.room_id] = 0;
        out[reg.room_id]++;
    }
    return out;
}

async function fetchEnrollmentByRoomForMonths(monthKeys) {
    if (!sbClient || !monthKeys.length) return {};

    // Fetch confirmed registration IDs and their rooms
    const { data: regs, error: regErr } = await sbClient
        .from('registrations')
        .select('id, room_id')
        .eq('status', 'confirmed');
    if (regErr) throw regErr;
    if (!regs || !regs.length) return {};

    const regRoomMap = Object.fromEntries(regs.map(r => [r.id, r.room_id]));

    // Build date range spanning all requested months
    const sorted = [...monthKeys].sort();
    const [lastYr, lastMo] = sorted[sorted.length - 1].split('-');
    const afterLast = lastMo === '12'
        ? `${parseInt(lastYr) + 1}-01-01`
        : `${lastYr}-${String(parseInt(lastMo) + 1).padStart(2, '0')}-01`;

    const { data: dates, error: datesErr } = await sbClient
        .from('registration_dates')
        .select('registration_id, care_date')
        .in('registration_id', regs.map(r => r.id))
        .gte('care_date', sorted[0] + '-01')
        .lt('care_date', afterLast)
        .eq('waitlisted', false);
    if (datesErr) throw datesErr;

    // Count unique registrations per room per month (one registration = one child for that month)
    const seen = new Set();
    const countsByRoomMonth = {};
    for (const d of (dates || [])) {
        const mk = d.care_date.slice(0, 7);
        if (!monthKeys.includes(mk)) continue;
        const dedupeKey = `${d.registration_id}-${mk}`;
        if (seen.has(dedupeKey)) continue;
        seen.add(dedupeKey);
        const roomId = regRoomMap[d.registration_id];
        if (!roomId) continue;
        if (!countsByRoomMonth[roomId]) countsByRoomMonth[roomId] = {};
        countsByRoomMonth[roomId][mk] = (countsByRoomMonth[roomId][mk] || 0) + 1;
    }

    const avg = {};
    for (const [roomId, monthCounts] of Object.entries(countsByRoomMonth)) {
        const counts = Object.values(monthCounts);
        // Divide by months where THIS room had data, not the full query window —
        // so a new room with 1 month of data out of 6 shows its real enrollment, not 1/6 of it.
        avg[roomId] = Math.round(counts.reduce((s, c) => s + c, 0) / counts.length * 10) / 10;
    }
    return avg;
}

async function upsertBillingSummary(row) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_summary')
        .upsert({
            month:       row.month,
            room_id:     row.room_id,
            half_days:   row.half_days ?? null,
            full_days:   row.full_days ?? null,
            subtotal:    row.subtotal ?? null,
            discount:    row.discount ?? null,
            net_billed:  row.net_billed,
            data_source: row.data_source || 'admin_entry',
        }, { onConflict: 'month,room_id' })
        .select();
    if (error) throw error;
    return data;
}

// Delete a billing_summary row by month and room_id
async function deleteBillingSummary(month, roomId) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('billing_summary')
        .delete()
        .eq('month', month)
        .eq('room_id', roomId);
    if (error) throw error;
}

// ============================================================
// BILLING OVERRIDES
// Per-child per-month manual billing amount overrides.
// ============================================================

// Fetch a single billing override for one child/month, or null if none.
async function fetchBillingOverride(month, parentEmail, childName) {
    if (!sbClient) return null;
    const { data, error } = await sbClient
        .from('billing_overrides')
        .select('override_amount')
        .eq('month', month)
        .eq('parent_email', parentEmail)
        .eq('child_name', childName)
        .maybeSingle();
    if (error) { console.warn('fetchBillingOverride:', error); return null; }
    return data;
}

// Fetch all billing overrides for a given month ('YYYY-MM')
async function fetchBillingOverrides(month) {
    if (!sbClient) return [];
    const { data, error } = await sbClient
        .from('billing_overrides')
        .select('*')
        .eq('month', month);
    if (error) { console.warn('fetchBillingOverrides:', error); return []; }
    return data || [];
}

// Insert or update a billing override (unique by month + parent_email + child_name)
async function upsertBillingOverride(row) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_overrides')
        .upsert({
            month:           row.month,
            parent_email:    row.parent_email,
            child_name:      row.child_name,
            override_amount: row.override_amount,
            updated_at:      new Date().toISOString(),
        }, { onConflict: 'month,parent_email,child_name' })
        .select();
    if (error) throw error;
    return data;
}

// Delete a billing override, restoring the calculated amount
async function deleteBillingOverride(month, parentEmail, childName) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('billing_overrides')
        .delete()
        .eq('month', month)
        .eq('parent_email', parentEmail)
        .eq('child_name', childName);
    if (error) throw error;
}

// ============================================================
// HTML SANITIZATION UTILITY
// Shared by admin, app, and lookup pages (and any future ones).
// Escapes characters that could be used for XSS when injecting
// user-supplied data into innerHTML template literals. This canonical
// version lives in supabase.js (loaded first on every page) so all
// page scripts call the same escHtml() automatically.
// ============================================================
const _ESC_HTML_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escHtml(str) {
    return String(str ?? '').replace(/[&<>"']/g, c => _ESC_HTML_MAP[c]);
}

// Parse a JSON string, returning `fallback` if parsing throws. Used for the
// settings `value` column, which may arrive as a JSON string or already-parsed
// jsonb depending on the column type.
function parseJsonOr(str, fallback) {
    try { return JSON.parse(str); } catch { return fallback; }
}

// ============================================================
// AUDIT LOGGING
// Calls the server-side log_admin_action() RPC so each action is
// recorded with the authenticated admin's email (captured by the DB,
// not the client, so it cannot be spoofed).
//
// Usage:
//   await logAdminAction('delete', 'registration', reg.id, { child_name: 'Alice' });
//   await logAdminAction('update', 'rate_settings', null, { room: 'bee', newRate: 75 });
// ============================================================
async function logAdminAction(action, entity, entityId = null, details = null) {
    if (!sbClient) return;
    try {
        await sbClient.rpc('log_admin_action', {
            p_action:    action,
            p_entity:    entity,
            p_entity_id: entityId != null ? String(entityId) : null,
            p_details:   details,
        });
    } catch (err) {
        // Non-fatal: log to console but never let audit failure break the UI action
        console.warn('logAdminAction failed:', err.message);
    }
}

async function fetchAuditLog() {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('admin_audit_log_recent')
        .select('*');
    if (error) throw error;
    return data || [];
}

// ============================================================
// BILLING MODULE HELPERS
// ============================================================

async function fetchBillingCycles() {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_cycles')
        .select('*')
        .order('month', { ascending: false });
    if (error) throw error;
    return data || [];
}

async function insertBillingCycle(month) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_cycles')
        .insert({ month })
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function getOrCreateBillingCycle(month) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data: existing, error: findErr } = await sbClient
        .from('billing_cycles')
        .select('*')
        .eq('month', month)
        .maybeSingle();
    if (findErr) throw findErr;
    if (existing) return existing;
    const { data, error } = await sbClient
        .from('billing_cycles')
        .insert({ month })
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function updateBillingCycle(id, fields) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_cycles')
        .update(fields)
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function fetchInvoicesForCycle(cycleId) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_invoices')
        .select('*, families(parent_name, parent_email)')
        .eq('cycle_id', cycleId)
        .order('family_id');
    if (error) throw error;
    return data || [];
}

async function fetchInvoicesForFamily(familyId) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_invoices')
        .select('*, billing_cycles(month)')
        .eq('family_id', familyId)
        .order('generated_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

async function upsertBillingInvoice(row) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_invoices')
        .upsert(row, { onConflict: 'cycle_id,family_id' })
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function updateBillingInvoice(id, fields) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_invoices')
        .update(fields)
        .eq('id', id)
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function fetchPaymentsForFamily(familyId) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_payments')
        .select('*')
        .eq('family_id', familyId)
        .order('payment_date', { ascending: false });
    if (error) throw error;
    return data || [];
}

async function fetchPaymentsForInvoice(invoiceId) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_payments')
        .select('*')
        .eq('invoice_id', invoiceId)
        .order('payment_date', { ascending: false });
    if (error) throw error;
    return data || [];
}

async function insertBillingPayment(row) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_payments')
        .insert(row)
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function insertImportBatch(row) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_import_batches')
        .insert(row)
        .select()
        .single();
    if (error) throw error;
    return data;
}

async function fetchAllBillingInvoices() {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_invoices')
        .select('*, billing_cycles(month)')
        .order('generated_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

async function fetchAllBillingPayments() {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('billing_payments')
        .select('*')
        .order('payment_date', { ascending: false });
    if (error) throw error;
    return data || [];
}

async function fetchARSummary(monthKey) {
    if (!sbClient) return [];
    const { data, error } = await sbClient
        .from('billing_payments')
        .select('family_id, amount, payment_date, payment_method, note, families(parent_name, parent_email)')
        .order('payment_date', { ascending: false });
    if (error || !data) return [];
    return data;
}

// Fetch all payments whose payment_date falls within a given YYYY-MM month
async function fetchPaymentsForMonth(month) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const y = parseInt(month.slice(0, 4), 10);
    const m = parseInt(month.slice(5, 7), 10);
    const nextY = m === 12 ? y + 1 : y;
    const nextM = m === 12 ? 1 : m + 1;
    const start = `${month}-01`;
    const end   = `${nextY}-${String(nextM).padStart(2, '0')}-01`;
    const { data, error } = await sbClient
        .from('billing_payments')
        .select('*')
        .gte('payment_date', start)
        .lt('payment_date', end)
        .order('payment_date', { ascending: false });
    if (error) throw error;
    return data || [];
}

// ── Billing RPC wrappers ──────────────────────────────────────────────────────
// These call SECURITY DEFINER functions that look up the family UUID server-side,
// so the parent-facing app (anon key) can create invoices without direct table access.

async function createInvoiceByEmail(email, month, amount) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient.rpc('create_billing_invoice_by_email', {
        p_email: email, p_month: month, p_amount: amount,
    });
    if (error) throw error;
    return data;
}

async function addDayToInvoiceByEmail(email, month, dayAmount, changeFee = 0) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient.rpc('add_day_to_invoice_by_email', {
        p_email: email, p_month: month, p_day_amount: dayAmount, p_change_fee: changeFee,
    });
    if (error) throw error;
    return data;
}

async function getOutstandingBalanceByEmail(email) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient.rpc('get_outstanding_balance_by_email', {
        p_email: email,
    });
    if (error) throw error;
    return data || [];
}
