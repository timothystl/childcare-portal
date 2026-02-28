// ============================================================
// PARENT PORTAL — My Schedule Lookup
// ============================================================

const MONTH_NAMES_LOOKUP = [
    'January','February','March','April','May','June',
    'July','August','September','October','November','December'
];

// ============================================================
// INIT
// ============================================================
document.addEventListener('DOMContentLoaded', () => {
    // Tab switching
    document.querySelectorAll('.lookup-tab').forEach(tab => {
        tab.addEventListener('click', () => {
            document.querySelectorAll('.lookup-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');
            const which = tab.dataset.tab;
            document.getElementById('lookupByEmail').classList.toggle('hidden', which !== 'email');
            document.getElementById('lookupByPin').classList.toggle('hidden', which !== 'pin');
        });
    });

    document.getElementById('lookupBtn').addEventListener('click', doLookup);
    document.getElementById('lookupEmail')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') doLookup();
    });
    document.getElementById('lookupPin')?.addEventListener('keydown', e => {
        if (e.key === 'Enter') doLookup();
    });

    document.getElementById('lookupBackBtn')?.addEventListener('click', resetToLookup);
    document.getElementById('lookupPrintBtn')?.addEventListener('click', printSchedule);
});

function resetToLookup() {
    document.getElementById('lookupResults').classList.add('hidden');
    document.getElementById('lookupScreen').classList.remove('hidden');
    document.getElementById('lookupError').classList.add('hidden');
    document.getElementById('lookupEmail').value = '';
    document.getElementById('lookupPin').value   = '';
}

// ============================================================
// LOOKUP
// ============================================================
async function doLookup() {
    const activeTab = document.querySelector('.lookup-tab.active')?.dataset.tab;
    const errorEl   = document.getElementById('lookupError');
    const btn       = document.getElementById('lookupBtn');

    errorEl.classList.add('hidden');
    btn.disabled    = true;
    btn.textContent = 'Looking up…';

    try {
        let registrations = [];
        let parentInfo    = { name: '', email: '' };

        if (activeTab === 'email') {
            const email = document.getElementById('lookupEmail').value.trim();
            if (!email) {
                showError('Please enter your email address.');
                return;
            }
            registrations = await fetchRegistrationsByEmail(email);
            if (registrations.length) {
                parentInfo = { name: registrations[0].parent_name, email };
            }
        } else {
            const pin = document.getElementById('lookupPin').value.trim();
            if (!pin || !/^\d{4}$/.test(pin)) {
                showError('Please enter your 4-digit PIN.');
                return;
            }
            const family = await lookupFamilyByPin(pin);
            if (family && family.parent_email) {
                registrations = await fetchRegistrationsByEmail(family.parent_email);
                parentInfo    = { name: family.parent_name, email: family.parent_email };
            }
        }

        if (!registrations.length) {
            showError('No registrations found. Please check your email address or PIN and try again.');
            return;
        }

        showResults(registrations, parentInfo);

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
function showResults(registrations, parentInfo) {
    document.getElementById('lookupScreen').classList.add('hidden');
    document.getElementById('lookupResults').classList.remove('hidden');

    document.getElementById('lookupParentName').textContent  = parentInfo.name || 'Your Schedule';
    document.getElementById('lookupParentEmail').textContent = parentInfo.email;

    // Group all registrations by child_name
    // A parent may have multiple registrations for the same child (different months)
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
            if (!d.waitlisted) byChild[key].dates.push(d);
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
        const monthLabel = MONTH_NAMES_LOOKUP[m - 1] + ' ' + y;

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
                    <span class="lookup-child-name">${escLookup(childName)}</span>
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
// HELPER
// ============================================================
function escLookup(str) {
    return String(str ?? '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
