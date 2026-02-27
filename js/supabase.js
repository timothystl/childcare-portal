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
// childName is optional — when provided, only checks that specific child's registrations
async function checkExistingRegistration(email, monthKey, childName = null) {
    if (!sbClient) return false;
    try {
        let regsQuery = sbClient
            .from('registrations')
            .select('id')
            .eq('parent_email', email);
        if (childName) regsQuery = regsQuery.eq('child_name', childName);
        const { data: regs, error: regErr } = await regsQuery;
        if (regErr || !regs || !regs.length) return false;

        const ids = regs.map(r => r.id);
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

// ============================================================
// FAMILIES & STUDENTS  (Items 1, 8, 9)
// ============================================================
async function searchFamilies(query) {
    if (!sbClient || !query) return [];
    const { data, error } = await sbClient
        .from('families')
        .select('id, parent_name, parent_email, parent_phone, pin, students(id, child_name, child_dob)')
        .or(`parent_name.ilike.%${query}%,parent_email.ilike.%${query}%`)
        .order('parent_name')
        .limit(8);
    if (error) { console.error('searchFamilies:', error); return []; }
    return data || [];
}

async function lookupFamilyByPin(pin) {
    if (!sbClient) return null;
    const { data, error } = await sbClient
        .from('families')
        .select('id, parent_name, parent_email, parent_phone, pin, students(id, child_name, child_dob)')
        .eq('pin', parseInt(pin, 10))
        .maybeSingle();
    if (error) { console.error('lookupFamilyByPin:', error); return null; }
    return data || null;
}

async function createFamily({ parentName, parentEmail, parentPhone }) {
    if (!sbClient) throw new Error('Supabase not configured.');

    // If email provided, upsert by email
    if (parentEmail) {
        const { data: existing } = await sbClient
            .from('families').select('id, pin')
            .eq('parent_email', parentEmail).maybeSingle();
        if (existing) {
            await sbClient.from('families')
                .update({ parent_name: parentName, parent_phone: parentPhone || '' })
                .eq('id', existing.id);
            const { data: updated } = await sbClient
                .from('families')
                .select('id, parent_name, parent_email, parent_phone, pin, students(id, child_name, child_dob)')
                .eq('id', existing.id).single();
            return updated;
        }
    }

    // Generate unique 4-digit PIN
    let pin = null;
    for (let i = 0; i < 10; i++) {
        const candidate = Math.floor(1000 + Math.random() * 9000);
        const { data: exists } = await sbClient
            .from('families').select('id').eq('pin', candidate).maybeSingle();
        if (!exists) { pin = candidate; break; }
    }

    const { data, error } = await sbClient
        .from('families')
        .insert({ parent_name: parentName, parent_email: parentEmail || '', parent_phone: parentPhone || '', pin })
        .select('id, parent_name, parent_email, parent_phone, pin')
        .single();
    if (error) throw error;
    return data;
}

async function addStudent({ familyId, childName, childDob }) {
    if (!sbClient) throw new Error('Supabase not configured.');
    // Skip if already exists
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

async function fetchAllFamilies() {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('families')
        .select('id, parent_name, parent_email, parent_phone, pin, created_at, students(id, child_name, child_dob)')
        .order('parent_name');
    if (error) throw error;
    return data || [];
}

async function importFamiliesData(rows) {
    if (!sbClient) throw new Error('Supabase not configured.');
    // Group rows by email (or name if no email)
    const byKey = {};
    rows.forEach(r => {
        if (!r.parentName) return;
        const key = (r.parentEmail || r.parentName).toLowerCase().trim();
        if (!byKey[key]) {
            byKey[key] = { parentName: r.parentName, parentEmail: r.parentEmail || '', parentPhone: r.parentPhone || '', children: [] };
        }
        if (r.childName) byKey[key].children.push({ childName: r.childName, childDob: r.childDob || null });
    });

    let familiesImported = 0, studentsImported = 0;
    for (const group of Object.values(byKey)) {
        try {
            const fam = await createFamily({ parentName: group.parentName, parentEmail: group.parentEmail, parentPhone: group.parentPhone });
            familiesImported++;
            for (const child of group.children) {
                await addStudent({ familyId: fam.id, childName: child.childName, childDob: child.childDob });
                studentsImported++;
            }
        } catch (e) { console.warn('Import row failed:', e); }
    }
    return { familiesImported, studentsImported };
}
