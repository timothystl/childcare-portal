// ============================================================
// ROOM CONFIG
// Edit capacity limits here to match your rooms.
// This is defined first so the UI always loads, even before
// Supabase is configured.
// ============================================================
const ROOMS = [
    { id: 'infants',    label: 'Infants',    ages: '0–12 months', capacity: 6  },
    { id: 'toddlers',   label: 'Toddlers',   ages: '1–3 years',   capacity: 10 },
    { id: 'preschool',  label: 'Preschool',  ages: '3–5 years',   capacity: 15 },
    { id: 'school_age', label: 'School Age', ages: '5+ years',    capacity: 20 },
];

// ============================================================
// SUPABASE CONFIGURATION
// Replace these two values after you create your Supabase project
// (see README.md for instructions)
// ============================================================
const SUPABASE_URL     = 'https://dahdstopsumxnqvdclmy.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImRhaGRzdG9wc3VteG5xdmRjbG15Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzIxMzM3NDYsImV4cCI6MjA4NzcwOTc0Nn0.PGuSZcnwGaG0Tes6li04JeNBAKDP4oJ6eGwhuYYXO_E';

// Initialize the Supabase client — wrapped in try/catch so the
// UI still works for browsing/selecting before Supabase is set up.
let sbClient = null;
const SUPABASE_CONFIGURED = SUPABASE_URL !== 'YOUR_SUPABASE_URL';
try {
    sbClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
} catch (e) {
    console.warn('Supabase not yet configured — running in preview mode. Registrations will not be saved.');
}

// ============================================================
// API HELPERS
// ============================================================

// Fetch how many confirmed (non-waitlist) registrations exist
// for a given room across a list of date strings ['YYYY-MM-DD', ...]
async function fetchCapacityForDates(roomId, dateStrings) {
    if (!dateStrings.length) return {};
    if (!sbClient) return {};   // not configured yet — treat all days as empty

    const { data, error } = await sbClient
        .from('registration_dates')
        .select('care_date, waitlisted')
        .eq('room_id', roomId)
        .eq('waitlisted', false)
        .in('care_date', dateStrings);

    if (error) { console.error('fetchCapacityForDates error:', error); return {}; }

    // Return a map: { 'YYYY-MM-DD': count }
    const counts = {};
    (data || []).forEach(row => {
        counts[row.care_date] = (counts[row.care_date] || 0) + 1;
    });
    return counts;
}

// Submit a full registration (parent info + all selected dates)
async function submitRegistration({ parent, child, roomId, confirmedDates, waitlistDates }) {
    if (!sbClient) throw new Error('Supabase is not configured yet. Please follow the setup steps in README.md to connect your database.');

    // 1. Insert parent/child record
    const { data: reg, error: regError } = await sbClient
        .from('registrations')
        .insert({
            parent_name:  parent.name,
            parent_email: parent.email,
            parent_phone: parent.phone,
            child_name:   child.name,
            child_age:    child.age,
            room_id:      roomId,
        })
        .select()
        .single();

    if (regError) throw regError;

    // 2. Build date rows
    const dateRows = [
        ...confirmedDates.map(d => ({ registration_id: reg.id, room_id: roomId, care_date: d, waitlisted: false })),
        ...waitlistDates.map(d  => ({ registration_id: reg.id, room_id: roomId, care_date: d, waitlisted: true  })),
    ];

    if (dateRows.length) {
        const { error: datesError } = await sbClient
            .from('registration_dates')
            .insert(dateRows);
        if (datesError) throw datesError;
    }

    return reg;
}

// Admin: fetch all registrations with their dates
async function fetchAllRegistrations() {
    if (!sbClient) throw new Error('Supabase is not configured yet.');
    const { data, error } = await sbClient
        .from('registrations')
        .select(`
            id, created_at,
            parent_name, parent_email, parent_phone,
            child_name, child_age, room_id,
            registration_dates ( care_date, waitlisted )
        `)
        .order('created_at', { ascending: false });

    if (error) throw error;
    return data || [];
}

// Admin: delete a registration and its dates (cascade set in DB)
async function deleteRegistration(id) {
    if (!sbClient) throw new Error('Supabase is not configured yet.');
    const { error } = await sbClient
        .from('registrations')
        .delete()
        .eq('id', id);
    if (error) throw error;
}
