// ============================================================
// ROOM CONFIG
// ============================================================
const ROOMS = [
    {
        id:           'bear',
        label:        '🐻 Bear Room',
        ages:         'Birth – 12 months',
        capacity:     8,
        fullDayOnly:  true,
        fullDayRate:  80,
        halfDayRate:  null,
    },
    {
        id:           'bee',
        label:        '🐝 Bee Room',
        ages:         '12 – 24 months',
        capacity:     16,
        fullDayOnly:  false,
        fullDayRate:  75,
        halfDayRate:  55,
    },
    {
        id:           'turtle',
        label:        '🐢 Turtle Room',
        ages:         '2 years',
        capacity:     11,
        fullDayOnly:  false,
        fullDayRate:  75,
        halfDayRate:  45,
    },
    {
        id:           'owl',
        label:        '🦉 Owl Room',
        ages:         '3+ years',
        capacity:     11,
        fullDayOnly:  false,
        fullDayRate:  75,
        halfDayRate:  45,
    },
];

// ============================================================
// SUPABASE CONFIGURATION
// ============================================================
const SUPABASE_URL      = 'https://dahdstopsumxnqvdclmy.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRhaGRzdG9wc3VteG5xdmRjbG15Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxMzM3NDYsImV4cCI6MjA4NzcwOTc0Nn0.PGuSZcnwGaG0Tes6li04JeNBAKDP4oJ6eGwhuYYXO_E';

let sbClient = null;
const SUPABASE_CONFIGURED = SUPABASE_URL !== 'YOUR_SUPABASE_URL';
try {
    sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (e) {
    console.warn('Supabase not yet configured — running in preview mode.');
}

// ============================================================
// CAPACITY
// ============================================================
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
async function fetchClosures() {
    if (!sbClient) return [];
    const { data, error } = await sbClient
        .from('closures')
        .select('close_date, reason')
        .order('close_date', { ascending: true });
    if (error) { console.error('fetchClosures:', error); return []; }
    return data || [];
}

async function addClosure(closeDate, reason) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('closures')
        .insert({ close_date: closeDate, reason: reason || '' });
    if (error) throw error;
}

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
async function submitRegistration({ parent, child, roomId, confirmedDates, waitlistDates, status = 'confirmed' }) {
    if (!sbClient) throw new Error('Supabase is not configured yet.');

    const { data: reg, error: regError } = await sbClient
        .from('registrations')
        .insert({
            parent_name:  parent.name,
            parent_email: parent.email,
            parent_phone: parent.phone,
            child_name:   child.name,
            child_age:    child.ageMonths,
            child_dob:    child.dob,
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
        ...waitlistDates.map(({ date, dayType }) => ({
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
        if (datesError) throw datesError;
    }

    return reg;
}

// ============================================================
// ADMIN HELPERS
// ============================================================
async function fetchAllRegistrations() {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('registrations')
        .select(`
            id, created_at, status,
            parent_name, parent_email, parent_phone,
            child_name, child_age, child_dob, room_id,
            registration_dates ( care_date, waitlisted, day_type )
        `)
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

async function approveRegistration(id) {
    if (!sbClient) throw new Error('Supabase not configured.');
    // Mark the registration as confirmed
    const { error: regErr } = await sbClient
        .from('registrations')
        .update({ status: 'confirmed' })
        .eq('id', id);
    if (regErr) throw regErr;
    // Unmark all its dates as waitlisted
    const { error: datesErr } = await sbClient
        .from('registration_dates')
        .update({ waitlisted: false })
        .eq('registration_id', id);
    if (datesErr) throw datesErr;
}

async function deleteRegistration(id) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('registrations')
        .delete()
        .eq('id', id);
    if (error) throw error;
}

// ============================================================
// SETTINGS  (key/value table for admin overrides)
// ============================================================
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

async function upsertSetting(key, value) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('settings')
        .upsert({ key, value, updated_at: new Date().toISOString() },
                 { onConflict: 'key' });
    if (error) throw error;
}

// ============================================================
// DUPLICATE REGISTRATION CHECK  (Item 7)
// Returns true if this email already has confirmed dates in the given month.
// monthKey format: 'YYYY-MM'
// ============================================================
async function checkExistingRegistration(email, monthKey) {
    if (!sbClient) return false;
    try {
        // Get all registration IDs for this email
        const { data: regs, error: regErr } = await sbClient
            .from('registrations')
            .select('id')
            .eq('parent_email', email);
        if (regErr || !regs || !regs.length) return false;

        const ids = regs.map(r => r.id);

        // Check if any confirmed dates in target month exist
        const { data: dates, error: datesErr } = await sbClient
            .from('registration_dates')
            .select('id')
            .in('registration_id', ids)
            .gte('care_date', monthKey + '-01')
            .lte('care_date', monthKey + '-31')
            .eq('waitlisted', false)
            .limit(1);
        if (datesErr) return false;
        return !!(dates && dates.length > 0);
    } catch {
        return false;
    }
}
