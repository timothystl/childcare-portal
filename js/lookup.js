// ============================================================
// PARENT PORTAL — My Schedule Lookup
// ============================================================

// Module state (populated after a successful lookup)
let _currentFamily        = null;
let _currentRegistrations = [];

// MONTH_NAMES is defined in supabase.js (loaded first) and shared globally.

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('lookupBtn').addEventListener('click', doLookup);
    document.getElementById('lookupEmail')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') doLookup();
    });
    document.getElementById('lookupPin')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') doLookup();
    });

    document.getElementById('lookupBackBtn')?.addEventListener('click', resetToLookup);
    document.getElementById('lookupPrintBtn')?.addEventListener('click', printSchedule);

    // GDPR / CCPA data controls
    document.getElementById('downloadDataBtn')?.addEventListener('click', downloadMyData);
    document.getElementById('requestDeletionBtn')?.addEventListener('click', () => {
        document.getElementById('deletionRequestForm').classList.remove('hidden');
    });
    document.getElementById('cancelDeletionBtn')?.addEventListener('click', () => {
        document.getElementById('deletionRequestForm').classList.add('hidden');
    });
    document.getElementById('submitDeletionBtn')?.addEventListener('click', submitDeletionRequest);
});

function resetToLookup() {
    document.getElementById('lookupResults').classList.add('hidden');
    document.getElementById('lookupScreen').classList.remove('hidden');
    document.getElementById('lookupError').classList.add('hidden');
    document.getElementById('lookupEmail').value = '';
    document.getElementById('lookupPin').value   = '';
    document.getElementById('lookupEmail').focus();
}

// ============================================================
// LOOKUP  — requires BOTH email AND PIN
// ============================================================
async function doLookup() {
    const email   = document.getElementById('lookupEmail').value.trim();
    const pin     = document.getElementById('lookupPin').value.trim();
    const errorEl = document.getElementById('lookupError');
    const btn     = document.getElementById('lookupBtn');

    errorEl.classList.add('hidden');

    if (!email) {
        showError('Please enter your email address.');
        return;
    }
    if (!/^\d{4}$/.test(pin)) {
        showError('Please enter your 4-digit PIN.');
        return;
    }
    btn.disabled    = true;
    btn.textContent = 'Looking up…';

    try {
        // Verify BOTH email AND PIN match — neither alone is sufficient
        const family = await lookupFamilyByEmailAndPin(email, pin);
        if (!family) {
            showError('Email and PIN do not match. Please contact the office if you need help.');
            return;
        }

        if (family.login_locked) {
            showError('This account has been locked. Please contact the office to regain access.');
            return;
        }

        const registrations = await fetchRegistrationsByEmail(family.parent_email);
        if (!registrations.length) {
            showError('No registrations found for your account.');
            return;
        }

        _currentFamily        = family;
        _currentRegistrations = registrations;
        showResults(registrations, family.parent_email);

    } catch (err) {
        console.error('Lookup error:', err);
        showError('There was an error looking up your schedule. Please try again.');
    } finally {
        btn.disabled    = false;
        btn.textContent = 'Look Up My Schedule';
    }
}

function showError(msg) {
    const errorEl = document.getElementById('lookupError');
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
}

// ============================================================
// RENDER RESULTS
// ============================================================
function showResults(registrations, parentEmail) {
    document.getElementById('lookupScreen').classList.add('hidden');
    document.getElementById('lookupResults').classList.remove('hidden');

    document.getElementById('lookupParentEmail').textContent = parentEmail;

    // Only show current month and next month
    const now   = new Date();
    const thisMonth = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
    const nextDate  = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    const nextMonth = `${nextDate.getFullYear()}-${String(nextDate.getMonth() + 1).padStart(2, '0')}`;
    const visibleMonths = new Set([thisMonth, nextMonth]);

    // Group all registrations by child_name
    const byChild = {};
    registrations.forEach(reg => {
        const key = reg.child_name || 'Unknown Child';
        if (!byChild[key]) {
            byChild[key] = {
                childName: key,
                roomId:    reg.room_id,
                dates:     [],
            };
        }
        (reg.registration_dates || []).forEach(d => {
            if (!d.waitlisted && visibleMonths.has((d.care_date || '').substring(0, 7))) {
                byChild[key].dates.push(d);
            }
        });
    });

    const html = Object.values(byChild).map(child => renderChildCard(child)).join('');
    document.getElementById('lookupContent').innerHTML = html || '<p class="lookup-empty-state">No confirmed care days found.</p>';
}

function renderChildCard({ childName, roomId, dates }) {
    const room = ROOMS.find(r => r.id === roomId);

    // Sort all dates ascending
    dates.sort((a, b) => a.care_date.localeCompare(b.care_date));

    // Group by month
    const byMonth = {};
    dates.forEach(d => {
        const month = d.care_date.substring(0, 7);
        if (!byMonth[month]) byMonth[month] = [];
        byMonth[month].push(d);
    });

    // Compute grand totals
    const grandTotal = dates.reduce((sum, d) => {
        const rate = d.day_type === 'half' ? (room?.halfDayRate || 0) : (room?.fullDayRate || 0);
        return sum + rate;
    }, 0);
    const grandFull = dates.filter(d => d.day_type !== 'half').length;
    const grandHalf = dates.filter(d => d.day_type === 'half').length;

    const monthBlocks = Object.entries(byMonth).sort().map(([monthKey, monthDates]) => {
        const [y, m]    = monthKey.split('-').map(Number);
        const monthLabel = MONTH_NAMES[m - 1] + ' ' + y;

        const monthFull = monthDates.filter(d => d.day_type !== 'half').length;
        const monthHalf = monthDates.filter(d => d.day_type === 'half').length;
        const monthBill = monthDates.reduce((sum, d) => {
            const rate = d.day_type === 'half' ? (room?.halfDayRate || 0) : (room?.fullDayRate || 0);
            return sum + rate;
        }, 0);

        const chips = monthDates.map(d => {
            const isHalf = d.day_type === 'half';
            const dow    = new Date(d.care_date + 'T00:00:00')
                .toLocaleDateString('en-US', { weekday: 'short' });
            const label  = new Date(d.care_date + 'T00:00:00')
                .toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
            return `<span class="lookup-date-chip${isHalf ? ' lookup-half' : ''}">
                        <span class="lookup-chip-dow">${dow}</span>
                        <span class="lookup-chip-date">${label}</span>
                        <span class="lookup-chip-type">${isHalf ? '½' : 'Full'}</span>
                    </span>`;
        }).join('');

        const tallyParts = [];
        if (monthFull) tallyParts.push(`<span class="lookup-tally-full">${monthFull} Full${monthFull !== 1 ? '' : ''}</span>`);
        if (monthHalf) tallyParts.push(`<span class="lookup-tally-half">${monthHalf} Half</span>`);

        return `
            <div class="lookup-month-block">
                <div class="lookup-month-row">
                    <span class="lookup-month-label">${monthLabel}</span>
                    <div class="lookup-month-meta">
                        <span class="lookup-tally">${tallyParts.join(' + ')}</span>
                        <span class="lookup-month-bill">$${monthBill.toFixed(2)}</span>
                    </div>
                </div>
                <div class="lookup-chips">${chips}</div>
            </div>`;
    }).join('');

    const totalTallyParts = [];
    if (grandFull) totalTallyParts.push(`${grandFull} full day${grandFull !== 1 ? 's' : ''}`);
    if (grandHalf) totalTallyParts.push(`${grandHalf} half day${grandHalf !== 1 ? 's' : ''}`);

    return `
        <div class="lookup-child-card">
            <div class="lookup-child-header">
                <div class="lookup-child-info">
                    <span class="lookup-child-name">${escHtml(childName.split(' ')[0])}</span>
                    <span class="lookup-child-room">${room?.label || roomId}</span>
                </div>
                <span class="lookup-child-total">$${grandTotal.toFixed(2)}</span>
            </div>

            ${!dates.length
                ? '<p class="lookup-no-dates">No confirmed care days on record.</p>'
                : `${monthBlocks}
                   <div class="lookup-grand-total">
                       <span class="lookup-grand-label">Total · ${totalTallyParts.join(', ')}</span>
                       <span class="lookup-grand-amount">$${grandTotal.toFixed(2)}</span>
                   </div>`
            }
        </div>`;
}

// ============================================================
// PRINT
// ============================================================
function printSchedule() {
    window.print();
}

// ============================================================
// GDPR / CCPA DATA CONTROLS
// ============================================================

// Download My Data — exports all family data as a JSON file (CCPA/GDPR access right)
function downloadMyData() {
    if (!_currentFamily) return;

    const exportData = {
        exported_at:  new Date().toISOString(),
        family: {
            parent_name:   _currentFamily.parent_name   || null,
            parent_email:  _currentFamily.parent_email  || null,
            parent_phone:  _currentFamily.parent_phone  || null,
            parent2_name:  _currentFamily.parent2_name  || null,
            parent2_email: _currentFamily.parent2_email || null,
            parent2_phone: _currentFamily.parent2_phone || null,
        },
        children: (_currentFamily.students || []).map(s => ({
            id:             s.id,
            child_name:     s.child_name,
            child_dob:      s.child_dob      || null,
            room_override:  s.room_override  || null,
            discount_type:  s.discount_type  || null,
            discount_value: s.discount_value ?? null,
            discount_note:  s.discount_note  || null,
            recurring_days: s.recurring_days || null,
        })),
        registrations: _currentRegistrations.map(reg => ({
            id:           reg.id,
            submitted_at: reg.created_at,
            child_name:   reg.child_name,
            room_id:      reg.room_id,
            status:       reg.status,
            dates: (reg.registration_dates || []).map(d => ({
                care_date:  d.care_date,
                day_type:   d.day_type,
                waitlisted: d.waitlisted,
            })),
        })),
    };

    const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `mdo-schedule-data-${new Date().toISOString().substring(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
}

// Request Account Deletion — inserts into deletion_requests table for structured tracking
async function submitDeletionRequest() {
    const note      = (document.getElementById('deletionNote')?.value || '').trim();
    const statusEl  = document.getElementById('deletionStatus');
    const btn       = document.getElementById('submitDeletionBtn');

    if (!_currentFamily) return;

    btn.disabled    = true;
    btn.textContent = 'Sending…';
    statusEl.classList.add('hidden');

    try {
        await submitFamilyDeletionRequest({
            familyId:    _currentFamily.id,
            parentEmail: _currentFamily.parent_email,
            parentName:  _currentFamily.parent_name || null,
            reason:      note || null,
        });
        statusEl.textContent = '✅ Your deletion request has been received. We will process it within 30 days and send a confirmation to ' + _currentFamily.parent_email + '.';
        statusEl.style.color = '#2e7d32';
        statusEl.classList.remove('hidden');
        document.getElementById('deletionNote').value = '';
        btn.textContent = 'Sent';
    } catch (err) {
        statusEl.textContent = '⚠️ Could not send request: ' + err.message + '. Please email mdo@timothystl.org directly.';
        statusEl.style.color = '#c62828';
        statusEl.classList.remove('hidden');
        btn.disabled    = false;
        btn.textContent = 'Send Deletion Request';
    }
}

// ============================================================
// HELPER
// ============================================================
