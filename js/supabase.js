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
const ROOMS = [
    {
        id:             'bear',
        label:          '🐻 Bear Room',
        ages:           'Birth – 12 months',
        capacity:       8,
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
        capacity:       16,
        fullDayOnly:    false,
        fullDayRate:    75,
        halfDayRate:    55,
        weeklyFullRate: null,
        weeklyHalfRate: null,
        staffRatio:     5,
    },
    {
        id:             'turtle',
        label:          '🐢 Turtle Room',
        ages:           '2 years',
        capacity:       11,
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
        ages:           '3+ years',
        capacity:       11,
        fullDayOnly:    false,
        fullDayRate:    75,
        halfDayRate:    45,
        weeklyFullRate: null,
        weeklyHalfRate: null,
        staffRatio:     10,
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
// DUPLICATE / CONFLICT CHECK
// Returns an array of care_date strings that already have a confirmed
// registration for this parent+child — so the caller can show specifics.
// ============================================================
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

// Try the families table first (ProCare import); fall back to searching registrations
async function searchFamilies(query) {
    if (!sbClient || !query) return [];
    try {
        const { data, error } = await sbClient
            .from('families')
            .select('id, parent_name, parent_email, parent_phone, pin, students(id, child_name, child_dob, room_override, discount_type, discount_value, discount_note)')
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
            .select('id, parent_name, parent_email, parent_phone, pin, parent2_name, parent2_email, parent2_phone, parent2_pin, students(id, child_name, child_dob, room_override, discount_type, discount_value, discount_note)')
            .or(`pin.eq.${parsedPin},parent2_pin.eq.${parsedPin}`)
            .maybeSingle();
        if (error) { console.error('lookupFamilyByPin:', error); return null; }
        return data || null;
    } catch (_) {
        return null;
    }
}

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
                .select('id, parent_name, parent_email, parent_phone, pin, parent2_name, parent2_email, parent2_phone, parent2_pin, students(id, child_name, child_dob, room_override)')
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

async function fetchAllFamilies({ includeArchived = false } = {}) {
    if (!sbClient) throw new Error('Supabase not configured.');
    let query = sbClient
        .from('families')
        .select('id, parent_name, parent_email, parent_phone, pin, parent2_name, parent2_email, parent2_phone, parent2_pin, created_at, active, group, students(id, child_name, child_dob, room_override, discount_type, discount_value, discount_note)')
        .order('parent_name');
    if (!includeArchived) query = query.eq('active', true);
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
}

// ---- Family CRUD ----
async function updateFamily(id, updates) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.from('families').update(updates).eq('id', id);
    if (error) throw error;
}

async function archiveFamily(id) {
    return updateFamily(id, { active: false });
}

async function restoreFamily(id) {
    return updateFamily(id, { active: true });
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
        .order('created_at', { ascending: false });
    if (!showArchived) query = query.eq('is_archived', false);
    const { data, error } = await query;
    if (error) {
        // Column doesn't exist yet — fetch without it and default is_archived to false
        if (error.message && error.message.includes('is_archived')) {
            const fallback = await sbClient
                .from('messages')
                .select('id, parent_name, parent_email, message, created_at, is_read')
                .order('created_at', { ascending: false });
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
        .order('created_at', { ascending: false });
    if (error) throw error;
    return data || [];
}

// ============================================================
// ADMIN AUTH  (Supabase Auth — server-validated)
// ============================================================
async function loginAdmin(email, password) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient.auth.signInWithPassword({ email, password });
    if (error) throw error;
    return data;
}

async function logoutAdmin() {
    if (!sbClient) return;
    await sbClient.auth.signOut();
}

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
        const { data, error } = await sbClient
            .from('families')
            .select('id, parent_name, parent_email, parent_phone, pin')
            .ilike('parent_email', email)
            .eq('pin', parseInt(pin, 10))
            .maybeSingle();
        if (error) { console.error('lookupFamilyByEmailAndPin:', error); return null; }
        return data || null;
    } catch (_) {
        return null;
    }
}

// ============================================================
// SETTINGS — room rates, weekly rates (stored in `settings` table)
// ============================================================

// Load room rates from Supabase and merge into ROOMS array.
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
        const rates = data.value;
        // Merge fetched rates into ROOMS array
        ROOMS.forEach(room => {
            const r = rates[room.id];
            if (!r) return;
            if (r.fullDayRate   != null) room.fullDayRate   = r.fullDayRate;
            if (r.halfDayRate   != null) room.halfDayRate   = r.halfDayRate;
            if (r.weeklyFullRate != null) room.weeklyFullRate = r.weeklyFullRate;
            if (r.weeklyHalfRate != null) room.weeklyHalfRate = r.weeklyHalfRate;
        });
        return true;
    } catch (_) {
        return false;
    }
}

// Save room rates to Supabase.
async function saveRateSettings(rates) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient
        .from('settings')
        .upsert({ key: 'room_rates', value: rates }, { onConflict: 'key' });
    if (error) throw error;
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
    if (error) throw error;
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
    } else {
        const { error } = await sbClient.from('staff').insert(record);
        if (error) throw error;
    }
}

async function setStaffActive(id, active) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { error } = await sbClient.from('staff').update({ active }).eq('id', id);
    if (error) throw error;
}

// ============================================================
// STAFF HOURS  (payroll)
// ============================================================
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

// ============================================================
// STAFF CLOCK EVENTS  (teacher clock-in/out)
// ============================================================
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

async function getClockStatus(staffId, workDate) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const { data, error } = await sbClient
        .from('staff_clock_events')
        .select('id, clock_in, clock_out')
        .eq('staff_id', staffId)
        .eq('work_date', workDate)
        .maybeSingle();
    if (error) throw error;
    return data;
}

async function clockIn(staffId, workDate) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const now = new Date().toISOString();
    const { error } = await sbClient
        .from('staff_clock_events')
        .upsert(
            { staff_id: staffId, work_date: workDate, clock_in: now, clock_out: null },
            { onConflict: 'staff_id,work_date' }
        );
    if (error) throw error;
}

async function clockOut(staffId, workDate) {
    if (!sbClient) throw new Error('Supabase not configured.');
    const now = new Date().toISOString();
    const { data: existing } = await sbClient
        .from('staff_clock_events')
        .select('id')
        .eq('staff_id', staffId)
        .eq('work_date', workDate)
        .maybeSingle();
    if (!existing) throw new Error('No clock-in record found. Please clock in first.');
    const { error } = await sbClient
        .from('staff_clock_events')
        .update({ clock_out: now })
        .eq('staff_id', staffId)
        .eq('work_date', workDate);
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
