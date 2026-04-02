// ============================================================
// ROOM CONFIG
// ============================================================
// ROOMS — base config. Rates can be overridden by admin via the Settings section
// (stored in Supabase `settings` table, key = 'room_rates').
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
        ageMaxMonths:   11,
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
        ageMaxMonths:   23,
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
        ageMaxMonths:   29,
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
        ageMaxMonths:   35,
        capacity:       null,   // pending state inspection — set once licensed
        status:         'coming_soon',
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
 * @property {number|null} ageMaxMonths   - Maximum age in months (null = no upper bound)
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
 * @property {number|null} pin                   - Hashed PIN (plaintext pre-migration)
 * @property {string|null} parent2_name
 * @property {string|null} parent2_email
 * @property {string|null} parent2_phone
 * @property {number|null} parent2_pin
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
async function submitRegistration({ parent, child, roomId, confirmedDates, waitlistDates = [], status = 'confirmed' }) {
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
        })
        .select()
        .single();

    if (regError) throw regError;

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
            id, created_at, status,
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
    const { data, error } = await sbClient
        .from('settings')
        .select('value')
        .eq('key', key)
        .maybeSingle();
    if (error) { console.error('fetchSetting:', error); return null; }
    return data?.value ?? null;
}

/**
 * Creates or updates a setting in the settings key/value table.
 * @param {string} key   - Setting key
 * @param {*}      value - Any JSON-serializable value
 * @returns {Promise<void>}
 */
async function upsertSetting(key, value) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('settings')
        .upsert({ key, value, updated_at: new Date().toISOString() },
                 { onConflict: 'key' });
    if (error) throw error;
}

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
            .select('id')
            .in('registration_id', ids)
            .gte('care_date', monthKey + '-01')
            .lt('care_date', nextMo + '-01')
            .eq('waitlisted', false)
            .limit(1);
        if (datesErr) return null;
        if (!(dates && dates.length > 0)) return null;
        return regs[0];
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
            .select('id, parent_name, parent_email, parent_phone, pin, students(id, child_name, child_dob, room_override, discount_type, discount_value, discount_note, recurring_days)')
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
                    pin:          null,
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

async function lookupFamilyByPin(pin) {
    if (!sbClient) return null;
    try {
        const parsedPin = parseInt(pin, 10);
        const { data, error } = await sbClient
            .from('families')
            .select('id, parent_name, parent_email, parent_phone, pin, parent2_name, parent2_email, parent2_phone, parent2_pin, registration_locked, students(id, child_name, child_dob, room_override, discount_type, discount_value, discount_note, recurring_days)')
            .or(`pin.eq.${parsedPin},parent2_pin.eq.${parsedPin}`)
            .maybeSingle();
        if (error) { console.error('lookupFamilyByPin:', error); return null; }
        return data || null;
    } catch (_) {
        return null;
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
    const parsedPin = parseInt(pin, 10);
    if (isNaN(parsedPin)) return { data: null, error: 'invalid_pin' };
    const { data, error } = await sbClient.rpc('family_login', { p_email: email, p_pin: parsedPin });
    if (error) throw error;
    return data; // { error: '...' } or { family: {...}, isParent2: bool }
}

/**
 * Convenience wrapper around familyLogin for the parent portal.
 * Returns { family, isParent2 } on success, null on wrong credentials, throws on locked.
 * @param {string}        email - Parent email
 * @param {string|number} pin   - 4-digit PIN
 * @returns {Promise<FamilyLoginResult|null>}
 */
async function lookupFamilyForRegistration(email, pin) {
    if (!sbClient) return null;
    try {
        const result = await familyLogin(email, pin);
        if (!result || result.error === 'not_found' || result.error === 'invalid_pin') return null;
        return result; // { family, isParent2 }
    } catch (_) {
        return null;
    }
}

/**
 * Creates a new family, or updates the existing one if the email already exists.
 * Auto-generates a unique 4-digit PIN if none is provided.
 * @param {Object}      params
 * @param {string}      params.parentName
 * @param {string}      params.parentEmail
 * @param {string}      [params.parentPhone]
 * @param {number|null} [params.pin]          - Explicit PIN; auto-generated if omitted
 * @param {string|null} [params.parent2Name]
 * @param {string|null} [params.parent2Email]
 * @param {string|null} [params.parent2Phone]
 * @param {number|null} [params.parent2Pin]
 * @returns {Promise<Family>}
 */
async function createFamily({ parentName, parentEmail, parentPhone, pin: providedPin = null,
                              parent2Name = null, parent2Email = null, parent2Phone = null, parent2Pin = null }) {
    if (!sbClient) throw new Error('Supabase not configured.');

    if (parentEmail) {
        const { data: existing } = await sbClient
            .from('families').select('id, pin')
            .eq('parent_email', parentEmail).maybeSingle();
        if (existing) {
            const updateData = { parent_name: parentName, parent_phone: parentPhone || '' };
            if (providedPin !== null) updateData.pin = providedPin;
            if (parent2Name !== null) updateData.parent2_name = parent2Name || null;
            if (parent2Email !== null) updateData.parent2_email = parent2Email || null;
            if (parent2Phone !== null) updateData.parent2_phone = parent2Phone || null;
            if (parent2Pin !== null) updateData.parent2_pin = parent2Pin || null;
            await sbClient.from('families').update(updateData).eq('id', existing.id);
            const { data: updated } = await sbClient
                .from('families')
                .select('id, parent_name, parent_email, parent_phone, pin, parent2_name, parent2_email, parent2_phone, parent2_pin, students(id, child_name, child_dob, room_override, recurring_days)')
                .eq('id', existing.id).single();
            return updated;
        }
    }

    let pin = providedPin;
    if (!pin) {
        for (let i = 0; i < 10; i++) {
            const candidate = Math.floor(1000 + Math.random() * 9000);
            const { data: exists } = await sbClient
                .from('families').select('id').eq('pin', candidate).maybeSingle();
            if (!exists) { pin = candidate; break; }
        }
    }

    const { data, error } = await sbClient
        .from('families')
        .insert({ parent_name: parentName, parent_email: parentEmail || '', parent_phone: parentPhone || '', pin,
                  parent2_name: parent2Name || null, parent2_email: parent2Email || null,
                  parent2_phone: parent2Phone || null, parent2_pin: parent2Pin || null })
        .select('id, parent_name, parent_email, parent_phone, pin, parent2_name, parent2_email, parent2_phone, parent2_pin')
        .single();
    if (error) throw error;
    return data;
}

/**
 * Adds a student to a family. Returns the existing student record if already present.
 * @param {Object}      params
 * @param {number}      params.familyId  - Family id
 * @param {string}      params.childName
 * @param {string|null} [params.childDob] - ISO 8601 date or null
 * @returns {Promise<Student>}
 */
async function addStudent({ familyId, childName, childDob }) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data: existing } = await sbClient
        .from('students').select('id')
        .eq('family_id', familyId).eq('child_name', childName).maybeSingle();
    if (existing) return existing;
    const { data, error } = await sbClient
        .from('students')
        .insert({ family_id: familyId, child_name: childName, child_dob: childDob || null })
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
        .select('id, parent_name, parent_email, parent_phone, pin, parent2_name, parent2_email, parent2_phone, parent2_pin, created_at, active, group, registration_locked, login_locked, students(id, child_name, child_dob, room_override, discount_type, discount_value, discount_note, recurring_days)')
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

async function restoreFamily(id) {
    return updateFamily(id, { active: true });
}

async function setFamilyRegistrationLock(id, locked) {
    return updateFamily(id, { registration_locked: locked });
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

async function fetchMessages(showArchived = false) {
    if (!sbClient) throw new Error('Supabase not configured.');
    // Try with is_archived column; fall back gracefully if it hasn't been added yet
    let query = sbClient
        .from('messages')
        .select('id, parent_name, parent_email, message, created_at, is_read, is_archived')
        .order('created_at', { ascending: false })
        .limit(75);
    if (!showArchived) query = query.eq('is_archived', false);
    const { data, error } = await query;
    if (error) {
        // Column doesn't exist yet — fetch without it and default is_archived to false
        if (error.message && error.message.includes('is_archived')) {
            const fallback = await sbClient
                .from('messages')
                .select('id, parent_name, parent_email, message, created_at, is_read')
                .order('created_at', { ascending: false })
                .limit(75);
            if (fallback.error) throw fallback.error;
            return (fallback.data || []).map(m => ({ ...m, is_archived: false }));
        }
        throw error;
    }
    return data || [];
}

async function markMessageRead(id, isRead = true) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('messages')
        .update({ is_read: isRead })
        .eq('id', id);
    if (error) throw error;
}

async function archiveMessage(id, archived = true) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('messages')
        .update({ is_archived: archived })
        .eq('id', id);
    if (error) throw error;
}

async function deleteMessage(id) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('messages')
        .delete()
        .eq('id', id);
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
        if (!result || result.error === 'not_found' || result.error === 'invalid_pin') return null;
        if (result.error === 'login_locked') return { login_locked: true };
        // Return shape expected by callers: id, parent_email (login email), login_locked
        const loginEmail = result.isParent2 ? result.family.parent2_email : result.family.parent_email;
        return { id: result.family.id, parent_email: loginEmail, login_locked: false };
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
        const rates = typeof raw === 'string'
            ? (() => { try { return JSON.parse(raw); } catch { return null; } })()
            : raw;
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
        const ratios = data.value;
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
        if (typeof raw === 'string') {
            try { return JSON.parse(raw); } catch { return { procareLink: null, paperworkLinks: [] }; }
        }
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
        .select('id, name, role, hourly_rate, pay_type, salary_biweekly, room_id, active, hire_date, staff_pin, created_at')
        .order('name');
    if (!includeInactive) query = query.eq('active', true);
    const { data, error } = await query;
    if (error) throw friendlyError(error);
    return data || [];
}

async function upsertStaffMember({ id = null, name, role, payType, hourlyRate, salaryBiweekly, roomId, hireDate, staffPin }) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const record = {
        name,
        role:             role || null,
        pay_type:         payType || 'hourly',
        hourly_rate:      payType === 'salary' ? 0 : (hourlyRate || 0),
        salary_biweekly:  payType === 'salary' ? (salaryBiweekly || 0) : 0,
        room_id:          roomId || null,
        hire_date:        hireDate || null,
        staff_pin:        staffPin ? parseInt(staffPin, 10) : null,
    };
    if (id) {
        const { error } = await sbClient.from('staff').update(record).eq('id', id);
        if (error) throw error;
        return id;
    } else {
        const { data, error } = await sbClient.from('staff').insert(record).select('id').single();
        if (error) throw error;
        return data?.id || null;
    }
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
        .select('id, staff_id, work_date, hours_worked, notes')
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
async function upsertStaffHours(staffId, workDate, hoursWorked, notes) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('staff_hours')
        .upsert(
            { staff_id: staffId, work_date: workDate, hours_worked: hoursWorked, notes: notes || '' },
            { onConflict: 'staff_id,work_date' }
        );
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
    const { data, error } = await sbClient
        .from('staff')
        .select('id, name, role, room_id, pay_type')
        .eq('staff_pin', parseInt(pin, 10))
        .eq('active', true)
        .maybeSingle();
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
async function clockIn(staffId, workDate) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const now = new Date().toISOString();
    const { error } = await sbClient
        .from('staff_clock_events')
        .insert({ staff_id: staffId, work_date: workDate, clock_in: now, clock_out: null });
    if (error) throw error;
}

/**
 * Records a clock-out by closing the most recent open event for the given staff/day.
 * @param {number} staffId  - Staff id
 * @param {string} workDate - ISO 8601 date (YYYY-MM-DD)
 * @returns {Promise<void>}
 */
async function clockOut(staffId, workDate) {
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
    const { error } = await sbClient
        .from('staff_clock_events')
        .update({ clock_out: now })
        .eq('id', open.id);
    if (error) throw error;
}

async function fetchClockEventsForDate(workDate) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('staff_clock_events')
        .select('id, staff_id, clock_in, clock_out, work_date')
        .eq('work_date', workDate);
    if (error) throw error;
    return data || [];
}

async function fetchClockEventsForRange(startDate, endDate) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('staff_clock_events')
        .select('id, staff_id, clock_in, clock_out, work_date')
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

async function deleteClockEvent(eventId) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('staff_clock_events')
        .delete()
        .eq('id', eventId);
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
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return {}; }
    }
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
        if (typeof raw === 'string') {
            try { return JSON.parse(raw); } catch (_) { return {}; }
        }
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
    if (typeof raw === 'string') {
        try { return JSON.parse(raw); } catch { return []; }
    }
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
    if (typeof raw === 'string') { try { return JSON.parse(raw); } catch { return { items: [] }; } }
    return (raw && typeof raw === 'object') ? raw : { items: [] };
}

async function saveExpenseConfig(config) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.from('settings')
        .upsert({ key: 'expense_config', value: config }, { onConflict: 'key' });
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
        headers: { Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
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

// Fetch confirmed, non-waitlisted care dates in a date range.
// Returns flat array of { registration_id, care_date, day_type, room_id }.
// Used by the Finance modeling tool to count actual enrollment and avg days/child.
async function fetchRegistrationDatesForRange(fromDate, toDate) {
    if (!sbClient) throw new Error('Supabase not configured.');

    // Step 1: Fetch all non-waitlisted care dates in the range (no join needed)
    const { data: dates, error: datesErr } = await sbClient
        .from('registration_dates')
        .select('registration_id, care_date, day_type, room_id, waitlisted')
        .gte('care_date', fromDate)
        .lte('care_date', toDate)
        .neq('waitlisted', true)
        .limit(5000);
    if (datesErr) throw datesErr;
    if (!dates?.length) return [];

    // Step 2: From those registration IDs, find which are 'confirmed'
    const regIds = [...new Set(dates.map(d => d.registration_id).filter(Boolean))];
    const { data: regs, error: regsErr } = await sbClient
        .from('registrations')
        .select('id')
        .in('id', regIds)
        .eq('status', 'confirmed');
    if (regsErr) throw regsErr;

    const confirmedIds = new Set((regs || []).map(r => r.id));

    return dates
        .filter(rd => confirmedIds.has(rd.registration_id))
        .map(rd => ({
            registration_id: rd.registration_id,
            care_date:       rd.care_date,
            day_type:        rd.day_type,
            room_id:         rd.room_id,
        }));
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
// Shared by admin.js, app.js, and any future pages.
// Escapes characters that could be used for XSS when injecting
// user-supplied data into innerHTML template literals.
// app.js uses the local alias escStr(); admin.js previously
// defined its own escHtml(). This canonical version in
// supabase.js (loaded first on every page) means both pages
// get the same function automatically.
// ============================================================
function escHtml(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
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
