// ============================================================
// MODULE: Admin Settings (rates, closures, roles, tabs, collapsibles)
// Sections: Summer Camp Visibility, Offer Links, Closures,
//           Tabs, Collapsibles, Rates & Settings, Admin Roles
// ============================================================

// SUMMER CAMP VISIBILITY SETTING
// ============================================================
async function setupSummerCamp() {
    const toggle   = document.getElementById('hideSummerCampToggle');
    const btn      = document.getElementById('saveSummerCampBtn');
    const statusEl = document.getElementById('summerCampStatus');
    if (!toggle || !btn) return;

    // Load current value
    const summerRoom = ROOMS.find(r => r.id === 'summer');
    toggle.checked = summerRoom?.hidden || false;

    btn.addEventListener('click', async () => {
        btn.disabled    = true;
        btn.textContent = 'Saving…';
        if (statusEl) statusEl.textContent = '';
        try {
            const hidden = toggle.checked;
            await saveSummerCampSetting(hidden);
            if (summerRoom) summerRoom.hidden = hidden;
            if (statusEl) {
                statusEl.textContent = '✓ Saved!';
                statusEl.style.color = '#2e7d32';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }
        } catch (err) {
            if (statusEl) {
                statusEl.textContent = '⚠️ ' + err.message;
                statusEl.style.color = '#c62828';
            }
            console.error('setupSummerCamp:', err);
        } finally {
            btn.disabled    = false;
            btn.textContent = '💾 Save';
        }
    });
}

// ============================================================
// NEW FAMILY ENROLLMENT CAPACITY SETTING
// ============================================================
async function setupEnrollmentCapacity() {
    const toggle   = document.getElementById('enrollmentAtCapacityToggle');
    const btn      = document.getElementById('saveEnrollmentCapacityBtn');
    const statusEl = document.getElementById('enrollmentCapacityStatus');
    if (!toggle || !btn) return;

    toggle.checked = await loadEnrollmentCapacitySetting();

    btn.addEventListener('click', async () => {
        btn.disabled    = true;
        btn.textContent = 'Saving…';
        if (statusEl) statusEl.textContent = '';
        try {
            await saveEnrollmentCapacitySetting(toggle.checked);
            if (statusEl) {
                statusEl.textContent = '✓ Saved!';
                statusEl.style.color = '#2e7d32';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }
        } catch (err) {
            if (statusEl) {
                statusEl.textContent = '⚠️ ' + err.message;
                statusEl.style.color = '#c62828';
            }
            console.error('setupEnrollmentCapacity:', err);
        } finally {
            btn.disabled    = false;
            btn.textContent = '💾 Save';
        }
    });
}

// ============================================================
// ENROLLMENT FORMS MANAGEMENT
// ============================================================
const _esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function renderEnrollmentFormsList(forms) {
    const container = document.getElementById('enrollmentFormsList');
    if (!container) return;
    if (!forms.length) {
        container.innerHTML = '<p style="color:var(--text-muted,#888);font-size:.9em;">No forms uploaded yet.</p>';
        return;
    }
    container.innerHTML = forms.map(f => `
        <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 12px;background:var(--linen,#faf7ed);border:1px solid var(--border,#e0d8c8);border-radius:8px;margin-bottom:8px;">
            <div style="min-width:0;">
                <div style="font-weight:600;font-size:.93em;">${_esc(f.name)}</div>
                ${f.description ? `<div style="font-size:.83em;color:var(--text-muted,#888);margin-top:2px;">${_esc(f.description)}</div>` : ''}
            </div>
            <div style="display:flex;align-items:center;gap:8px;flex-shrink:0;">
                <a href="${_esc(f.url)}" target="_blank" style="font-size:.83em;color:var(--navy,#01294a);font-weight:700;">📄 Preview</a>
                <button class="btn-danger-sm" data-delete-form-id="${_esc(f.id)}">🗑️ Delete</button>
            </div>
        </div>
    `).join('');

    container.querySelectorAll('[data-delete-form-id]').forEach(btn => {
        btn.addEventListener('click', () => deleteEnrollmentForm(btn.dataset.deleteFormId));
    });
}

async function setupEnrollmentForms() {
    const uploadBtn = document.getElementById('uploadEnrollFormBtn');
    if (!uploadBtn) return;

    const forms = await loadEnrollmentForms();
    renderEnrollmentFormsList(forms);

    uploadBtn.addEventListener('click', async () => {
        const nameEl   = document.getElementById('newEnrollFormName');
        const descEl   = document.getElementById('newEnrollFormDesc');
        const fileEl   = document.getElementById('newEnrollFormFile');
        const statusEl = document.getElementById('uploadEnrollFormStatus');
        const name = nameEl?.value.trim();
        const file = fileEl?.files[0];

        if (!name) { alert('Please enter a form name.'); return; }
        if (!file) { alert('Please select a file to upload.'); return; }

        uploadBtn.disabled    = true;
        uploadBtn.textContent = 'Uploading…';
        if (statusEl) statusEl.textContent = '';

        try {
            const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
            const filename = `${Date.now()}-${safeName}`;
            const publicUrl = await uploadEnrollmentFormFile(file, filename);

            const current = await loadEnrollmentForms();
            current.push({
                id:          crypto.randomUUID(),
                name,
                description: descEl?.value.trim() || '',
                filename,
                url:         publicUrl,
            });
            await saveEnrollmentForms(current);
            renderEnrollmentFormsList(current);

            if (nameEl)   nameEl.value   = '';
            if (descEl)   descEl.value   = '';
            if (fileEl)   fileEl.value   = '';

            if (statusEl) {
                statusEl.textContent = '✓ Uploaded!';
                statusEl.style.color = '#2e7d32';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }
        } catch (err) {
            if (statusEl) { statusEl.textContent = '⚠️ ' + err.message; statusEl.style.color = '#c62828'; }
            console.error('uploadEnrollForm:', err);
        } finally {
            uploadBtn.disabled    = false;
            uploadBtn.textContent = '⬆️ Upload';
        }
    });
}

async function deleteEnrollmentForm(id) {
    if (!confirm('Delete this form? It will be removed from the /enroll page immediately.')) return;
    try {
        let forms = await loadEnrollmentForms();
        const form = forms.find(f => f.id === id);
        if (!form) return;
        // Remove metadata first — if storage delete fails the entry is already gone
        // from the page, and the orphaned file is harmless.
        const updated = forms.filter(f => f.id !== id);
        await saveEnrollmentForms(updated);
        renderEnrollmentFormsList(updated);
        await deleteEnrollmentFormFile(form.filename);
    } catch (err) {
        alert('Failed to delete form: ' + err.message);
        console.error('deleteEnrollmentForm:', err);
    }
}

// ============================================================
// OFFER EMAIL LINKS (global settings)
// ============================================================
function setupOfferLinks() {
    const g = window._globalOfferLinks || {};
    const procareEl   = document.getElementById('globalProcareLink');
    const paperworkEl = document.getElementById('globalPaperworkLinks');
    if (procareEl)   procareEl.value   = g.procareLink   || '';
    if (paperworkEl) paperworkEl.value = (g.paperworkLinks || []).join(', ');

    document.getElementById('saveOfferLinksBtn')?.addEventListener('click', async () => {
        const btn      = document.getElementById('saveOfferLinksBtn');
        const statusEl = document.getElementById('offerLinksStatus');
        btn.disabled    = true;
        btn.textContent = 'Saving…';
        if (statusEl) statusEl.textContent = '';
        try {
            const procareLink   = procareEl?.value.trim() || null;
            const paperworkLinks = (paperworkEl?.value || '').split(',').map(s => s.trim()).filter(Boolean);
            const payload = { procareLink, paperworkLinks };
            await saveOfferLinks(payload);
            window._globalOfferLinks = payload;
            if (statusEl) {
                statusEl.textContent = '✓ Saved!';
                statusEl.style.color = '#2e7d32';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }
        } catch (err) {
            if (statusEl) { statusEl.textContent = '⚠️ ' + err.message; statusEl.style.color = '#c62828'; }
            console.error('saveOfferLinks:', err);
        } finally {
            btn.disabled    = false;
            btn.textContent = '💾 Save Links';
        }
    });
}

// ============================================================
// CLOSURES
// ============================================================
function setupClosures() {
    document.getElementById('addClosureBtn').addEventListener('click', async () => {
        const date   = document.getElementById('closureDate').value;
        const reason = document.getElementById('closureReason').value.trim();
        if (!date) { alert('Please select a date to block.'); return; }
        try {
            await addClosure(date, reason);
            document.getElementById('closureDate').value   = '';
            document.getElementById('closureReason').value = '';
            await loadClosureList();
        } catch (err) {
            alert('Error: ' + err.message);
        }
    });

    document.getElementById('notifyClosureBtn').addEventListener('click', async () => {
        const date   = document.getElementById('closureDate').value;
        const reason = document.getElementById('closureReason').value.trim();
        const label  = reason || 'School closure';
        const title  = 'MDO Closed' + (date ? ` – ${new Date(date + 'T00:00:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : '');
        const body   = reason || 'A school closure has been scheduled. Please check the calendar for details.';

        const btn = document.getElementById('notifyClosureBtn');
        btn.disabled = true;
        btn.textContent = '📤 Sending…';
        try {
            const session = await getAdminSession();
            const res = await fetch('/send-push', {
                method:  'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': `Bearer ${session.access_token}`,
                },
                body: JSON.stringify({ broadcast: true, title, body }),
            });
            const { sent } = await res.json();
            btn.textContent = `✅ Sent to ${sent} device${sent !== 1 ? 's' : ''}`;
            setTimeout(() => { btn.disabled = false; btn.textContent = '🔔 Notify Parents'; }, 3000);
        } catch (err) {
            alert('Failed to send notification: ' + err.message);
            btn.disabled = false;
            btn.textContent = '🔔 Notify Parents';
        }
    });
}

async function loadClosureList() {
    try {
        const closures  = await fetchClosures();
        allClosureDates = new Set(closures.map(c => c.close_date));
        const container = document.getElementById('closureList');
        if (!closures.length) {
            container.innerHTML = '<p class="empty-hint">No closures set.</p>';
            return;
        }
        container.innerHTML = `
            <ul class="closure-list">
                ${closures.map(c => `
                    <li class="closure-item">
                        <span class="closure-date-lbl">${friendlyShort(c.close_date)}</span>
                        <span class="closure-reason-lbl">${escHtml(c.reason || '—')}</span>
                        <button class="btn-remove-closure" data-date="${c.close_date}">Remove</button>
                    </li>`).join('')}
            </ul>`;
        container.querySelectorAll('.btn-remove-closure').forEach(btn => {
            btn.addEventListener('click', async e => {
                const d = e.currentTarget.getAttribute('data-date');
                if (!confirm(`Remove closure for ${friendlyShort(d)}?`)) return;
                try {
                    await deleteClosure(d);
                    await loadClosureList();
                } catch (err) {
                    alert('Error: ' + err.message);
                }
            });
        });
    } catch (err) {
        console.error('loadClosureList:', err);
    }
}

// ============================================================

// TABS
// ============================================================
function setupTabs() {
    const btns     = document.querySelectorAll('#adminTabs .admin-tab-btn');
    const panes    = document.querySelectorAll('.tab-pane');
    const menuBtn  = document.getElementById('mobileMenuBtn');
    const overlay  = document.getElementById('mobileNavOverlay');
    const closeBtn = document.getElementById('mobileNavClose');
    const navItems = document.querySelectorAll('.mobile-nav-item');

    // Move overlay to <body> so position:fixed is relative to the viewport,
    // not to any transformed/stacking-context ancestor.
    if (overlay && overlay.parentNode !== document.body) {
        document.body.appendChild(overlay);
    }

    function openMenu()  { if (overlay) overlay.classList.add('open'); if (menuBtn) menuBtn.setAttribute('aria-expanded', 'true'); }
    function closeMenu() { if (overlay) overlay.classList.remove('open'); if (menuBtn) menuBtn.setAttribute('aria-expanded', 'false'); }

    function activate(tab) {
        btns.forEach(b     => b.classList.toggle('active', b.dataset.tab === tab));
        navItems.forEach(i => i.classList.toggle('active', i.dataset.tab === tab));
        panes.forEach(p    => p.classList.toggle('hidden', p.id !== 'tab-' + tab));
        localStorage.setItem('adminActiveTab', tab);
        closeMenu();

        const activeBtn = [...btns].find(b => b.dataset.tab === tab);
        if (activeBtn) activeBtn.scrollIntoView({ block: 'nearest', inline: 'nearest' });

        if (tab === 'families'  && allFamiliesData.length === 0) loadFamilies();
        if (tab === 'staffing'  && allStaffData.length === 0)    loadStaffList();
        if (tab === 'messages'  && !_messagesLoaded)             { _messagesLoaded = true; loadMessages(); }
        if (tab === 'billing'   && !_arLoaded)                   { setupBillingDashYear(); }
        if (tab === 'settings')                                  loadGeofenceSettings();
    }

    btns.forEach(btn => btn.addEventListener('click', () => activate(btn.dataset.tab)));
    navItems.forEach(item => item.addEventListener('click', () => activate(item.dataset.tab)));

    if (menuBtn)  menuBtn.addEventListener('click', openMenu);
    if (closeBtn) closeBtn.addEventListener('click', closeMenu);
    // Tap the dark backdrop (not the drawer) to close
    if (overlay)  overlay.addEventListener('click', e => { if (e.target === overlay) closeMenu(); });
    document.getElementById('mobileNavLogout')?.addEventListener('click', () => document.getElementById('logoutBtn').click());

    const saved = localStorage.getItem('adminActiveTab') || 'daily';
    activate(saved);
}

// ============================================================
// COLLAPSIBLES  (Settings tab sections)
// ============================================================
function setupCollapsibles() {
    document.querySelectorAll('.collapsible-section').forEach(section => {
        const id = section.id;
        const h2 = section.querySelector('h2');
        if (!h2 || !id) return;
        // Skip if already processed (guards against double-init)
        if (section.querySelector(':scope > .collapsible-body')) return;

        // Wrap all content after h2 in a collapsible body div
        const body = document.createElement('div');
        body.className = 'collapsible-body';
        while (h2.nextSibling) body.appendChild(h2.nextSibling);
        section.appendChild(body);

        // Add toggle button inside h2
        const btn = document.createElement('button');
        btn.type      = 'button';
        btn.className = 'collapse-toggle';
        btn.setAttribute('aria-expanded', 'true');
        btn.title     = 'Collapse / expand';
        btn.innerHTML = '<span class="collapse-chevron" aria-hidden="true"></span>';
        h2.appendChild(btn);

        function setCollapsed(collapsed) {
            body.hidden = collapsed;
            section.classList.toggle('is-collapsed', collapsed);
            btn.setAttribute('aria-expanded', String(!collapsed));
            localStorage.setItem('adminCollapse_' + id, collapsed ? '1' : '0');
        }

        btn.addEventListener('click', () => setCollapsed(!section.classList.contains('is-collapsed')));

        // Restore saved state (default: open)
        if (localStorage.getItem('adminCollapse_' + id) === '1') setCollapsed(true);
    });
}

// ============================================================
// RATES & SETTINGS
// ============================================================
function setupRates() {
    renderRatesTable();
    document.getElementById('saveRatesBtn')?.addEventListener('click', onSaveRates);
}

function renderRatesTable() {
    const wrap = document.getElementById('ratesTableWrap');
    if (!wrap) return;
    wrap.innerHTML = `
        <table class="rates-table">
            <thead>
                <tr>
                    <th>Room</th>
                    <th>Age Range (months)<br><small>Min – Max (blank = no limit)</small></th>
                    <th>Full Day Rate ($)</th>
                    <th>Half Day Rate ($)</th>
                    <th>Weekly Full ($)<br><small>All 5 weekdays full</small></th>
                    <th>Weekly Half ($)<br><small>All 5 weekdays half</small></th>
                </tr>
            </thead>
            <tbody>
                ${ROOMS.map(room => `
                    <tr data-room-id="${room.id}">
                        <td class="rates-room-label">
                            <strong>${escHtml(room.label)}</strong>
                            ${room.status === 'coming_soon' ? '<span class="rates-badge-soon">Coming Soon</span>' : ''}
                            ${room.status === 'seasonal' ? '<span class="rates-badge-soon" style="background:#e0f2fe;color:#0369a1">Seasonal</span>' : ''}
                            <span class="rates-ages">${escHtml(room.ages)}</span>
                        </td>
                        <td>
                            <div style="display:flex;gap:4px;align-items:center;">
                                <input type="number" class="rate-input" data-field="ageMinMonths"
                                    value="${room.ageMinMonths ?? ''}" min="0" step="1" placeholder="min"
                                    style="width:58px;" title="Minimum age in months">
                                <span>–</span>
                                <input type="number" class="rate-input" data-field="ageMaxMonths"
                                    value="${room.ageMaxMonths ?? ''}" min="0" step="1" placeholder="∞"
                                    style="width:58px;" title="Max age in months (blank = no upper limit)">
                            </div>
                        </td>
                        <td>
                            <input type="number" class="rate-input" data-field="fullDayRate"
                                value="${room.fullDayRate ?? ''}" min="0" step="0.01" placeholder="0.00">
                        </td>
                        <td>
                            ${room.fullDayOnly
                                ? '<span class="rates-na">Full day only</span>'
                                : `<input type="number" class="rate-input" data-field="halfDayRate"
                                    value="${room.halfDayRate ?? ''}" min="0" step="0.01" placeholder="0.00">`
                            }
                        </td>
                        <td>
                            <input type="number" class="rate-input" data-field="weeklyFullRate"
                                value="${room.weeklyFullRate ?? ''}" min="0" step="0.01" placeholder="— disabled">
                        </td>
                        <td>
                            ${room.fullDayOnly
                                ? '<span class="rates-na">—</span>'
                                : `<input type="number" class="rate-input" data-field="weeklyHalfRate"
                                    value="${room.weeklyHalfRate ?? ''}" min="0" step="0.01" placeholder="— disabled">`
                            }
                        </td>
                    </tr>
                `).join('')}
            </tbody>
        </table>
        <p class="rates-hint">💡 Age Range: changing these values updates which room children are auto-assigned to based on their date of birth. Weekly rates apply when a child books all 5 Mon–Fri days in a single week with the same day type.</p>`;
}

async function onSaveRates() {
    const btn      = document.getElementById('saveRatesBtn');
    const statusEl = document.getElementById('ratesStatus');
    if (!btn) return;
    btn.disabled    = true;
    btn.textContent = 'Saving…';
    if (statusEl) { statusEl.textContent = ''; }

    try {
        const rates = {};
        document.querySelectorAll('#ratesTableWrap tbody tr[data-room-id]').forEach(row => {
            const id = row.dataset.roomId;
            rates[id] = {};
            row.querySelectorAll('.rate-input[data-field]').forEach(input => {
                const val   = input.value.trim();
                const field = input.dataset.field;
                // Age fields are integers; rate fields are floats
                if (field === 'ageMinMonths' || field === 'ageMaxMonths') {
                    rates[id][field] = val === '' ? null : parseInt(val, 10);
                } else {
                    rates[id][field] = val === '' ? null : parseFloat(val);
                }
            });
            // Regenerate the human-readable ages label from the saved range
            const r = rates[id];
            {
                const min = r.ageMinMonths ?? 0;
                const max = r.ageMaxMonths ?? null;
                rates[id].ages = max == null
                    ? (min > 0 ? `${min}+ months` : '')
                    : `${min} – ${max + 1} months`;
            }
        });

        await saveRateSettings(rates);
        await logAdminAction('update', 'rate_settings', null, { rooms: Object.keys(rates) });
        // Merge saved values directly into ROOMS (avoids a DB round-trip that can
        // silently fail and revert the display back to hardcoded defaults).
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
        renderRatesTable();

        if (statusEl) {
            statusEl.textContent   = '✓ Saved!';
            statusEl.style.color   = '#2e7d32';
            setTimeout(() => { statusEl.textContent = ''; }, 3000);
        }
    } catch (err) {
        if (statusEl) {
            statusEl.textContent = '⚠️ ' + err.message;
            statusEl.style.color = '#c62828';
        }
        console.error('onSaveRates:', err);
    } finally {
        btn.disabled    = false;
        btn.textContent = '💾 Save Rates';
    }
}

// ============================================================
// REGISTRATION FEE SETTING
// ============================================================
async function loadRegFeeSetting() {
    const val = await fetchSetting('registration_fee');
    window._regFeeAmount = (typeof val === 'number' && val >= 0) ? val : 0;
    const inp = document.getElementById('regFeeInput');
    if (inp) inp.value = window._regFeeAmount > 0 ? window._regFeeAmount.toFixed(2) : '';
}

async function setupRegFee() {
    await loadRegFeeSetting();
    document.getElementById('saveRegFeeBtn')?.addEventListener('click', async () => {
        const btn      = document.getElementById('saveRegFeeBtn');
        const statusEl = document.getElementById('regFeeStatus');
        const inp      = document.getElementById('regFeeInput');
        if (!btn || !inp) return;
        btn.disabled    = true;
        btn.textContent = 'Saving…';
        if (statusEl) statusEl.textContent = '';
        try {
            const fee = parseFloat(inp.value) || 0;
            await upsertSetting('registration_fee', fee);
            window._regFeeAmount = fee;
            if (statusEl) {
                statusEl.textContent = '✓ Saved!';
                statusEl.style.color = '#2e7d32';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }
        } catch (err) {
            if (statusEl) {
                statusEl.textContent = '⚠️ ' + err.message;
                statusEl.style.color = '#c62828';
            }
        } finally {
            btn.disabled    = false;
            btn.textContent = '💾 Save Fee';
        }
    });
}

// ============================================================

// ADMIN ROLES  (access control)
// ============================================================

const ROLE_LABELS = {
    full:       'Full Access',
    restricted: 'Restricted — Schedule Planner only',
    staff:      'Staff — Classroom Roster (read-only)',
};

function _hide(id) {
    const el = document.getElementById(id);
    if (el) el.style.display = 'none';
}

function applyRoleRestrictions() {
    if (currentAdminRole === 'full') return;

    // Finance tab is full-access only
    const finBtn = document.querySelector('[data-tab="finance"]');
    if (finBtn) finBtn.style.display = 'none';

    if (currentAdminRole === 'restricted') {
        // Staffing tab: hide everything except the schedule planner
        _hide('logHoursSection');
        _hide('payrollSection');
        _hide('staffRosterToggleWrap');
        _hide('staffRosterSection');
        // Settings tab: show only Registration Window Override
        ['closedDaysSection', 'ratesSection', 'ratiosSection',
         'offerLinksSection', 'adminRolesSection', 'summerCampSection']
            .forEach(id => _hide(id));
    }

    if (currentAdminRole === 'staff') {
        // Hide all tabs except Classrooms and force it active
        document.querySelectorAll('#adminTabs .admin-tab-btn').forEach(btn => {
            if (btn.dataset.tab !== 'daily') btn.style.display = 'none';
        });
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
        document.getElementById('tab-daily')?.classList.remove('hidden');
        document.querySelectorAll('#adminTabs .admin-tab-btn').forEach(b => {
            b.classList.toggle('active', b.dataset.tab === 'daily');
        });
        localStorage.setItem('adminActiveTab', 'daily');
        _hide('exportXlsxBtn');
    }
}

function setupAdminRoles() {
    _loadAdminUsersTable();

    document.getElementById('addAdminRoleBtn')?.addEventListener('click', async () => {
        const emailInput    = document.getElementById('newRoleEmail');
        const passwordInput = document.getElementById('newRolePassword');
        const email    = emailInput.value.trim().toLowerCase();
        const password = passwordInput.value;
        const level    = document.getElementById('newRoleLevel').value;

        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            alert('Please enter a valid email address.'); return;
        }
        if (!password || password.length < 6) {
            alert('Password must be at least 6 characters.'); return;
        }

        const btn = document.getElementById('addAdminRoleBtn');
        btn.disabled = true; btn.textContent = 'Creating…';
        try {
            await callAdminUsers('create', { email, password });
            window._adminRoles = window._adminRoles || {};
            window._adminRoles[email] = level;
            await saveAdminRoles(window._adminRoles);
            emailInput.value = ''; passwordInput.value = '';
            _showAdminRolesStatus('✓ User created!', '#2e7d32');
            _loadAdminUsersTable();
        } catch (err) {
            _showAdminRolesStatus('⚠️ ' + err.message, '#c62828');
        } finally {
            btn.disabled = false; btn.textContent = 'Add User';
        }
    });
}

async function _loadAdminUsersTable() {
    const wrap = document.getElementById('adminRolesTableWrap');
    if (!wrap) return;
    wrap.innerHTML = '<p class="empty-hint">Loading users…</p>';
    try {
        // Load both auth users and current roles together so the table
        // always reflects the saved state regardless of timing
        const [result, roles] = await Promise.all([
            callAdminUsers('list', {}),
            loadAdminRoles(),
        ]);
        window._adminRoles = roles;
        _renderAdminUsersTable(result.users || []);
    } catch (err) {
        wrap.innerHTML = `<p class="empty-hint">⚠️ Could not load users: ${escHtml(err.message)}</p>`;
    }
}

function _renderAdminUsersTable(authUsers) {
    const wrap = document.getElementById('adminRolesTableWrap');
    if (!wrap) return;
    const rolesMap = window._adminRoles || {};

    if (!authUsers.length) {
        wrap.innerHTML = '<p class="empty-hint">No admin users found.</p>';
        return;
    }

    const rows = authUsers.map(u => {
        const email   = u.email || '';
        const role    = rolesMap[email] || 'full';
        const options = Object.entries(ROLE_LABELS).map(([val, label]) =>
            `<option value="${val}" ${val === role ? 'selected' : ''}>${label}</option>`
        ).join('');
        const lastSeen = u.last_sign_in_at
            ? new Date(u.last_sign_in_at).toLocaleDateString()
            : 'Never';
        return `
            <tr>
                <td>${escHtml(email)}</td>
                <td><select class="admin-role-select family-search-input btn-sm" data-email="${escHtml(email)}">${options}</select></td>
                <td style="color:#888;font-size:.85em;white-space:nowrap">${lastSeen}</td>
                <td style="white-space:nowrap">
                    <button class="btn-ghost btn-sm reset-pw-btn" data-email="${escHtml(email)}">Reset Password</button>
                    <button class="btn-ghost btn-sm delete-user-btn" style="color:#c62828" data-userid="${u.id}" data-email="${escHtml(email)}">Delete</button>
                </td>
            </tr>`;
    }).join('');

    wrap.innerHTML = `
        <table class="rates-table" style="width:100%">
            <thead><tr><th>Email</th><th>Access Level</th><th>Last Login</th><th></th></tr></thead>
            <tbody>${rows}</tbody>
        </table>`;

    // Inline role change — save immediately on select change
    wrap.querySelectorAll('.admin-role-select').forEach(sel => {
        sel.addEventListener('change', async () => {
            window._adminRoles = window._adminRoles || {};
            window._adminRoles[sel.dataset.email] = sel.value;
            try {
                await saveAdminRoles(window._adminRoles);
                _showAdminRolesStatus('✓ Saved!', '#2e7d32');
            } catch (err) {
                _showAdminRolesStatus('⚠️ ' + err.message, '#c62828');
            }
        });
    });

    // Reset password — sends email via Supabase Auth
    wrap.querySelectorAll('.reset-pw-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const { email } = btn.dataset;
            if (!confirm(`Send a password reset email to ${email}?`)) return;
            btn.disabled = true;
            try {
                await sendPasswordReset(email);
                _showAdminRolesStatus(`✓ Reset email sent to ${email}`, '#2e7d32');
            } catch (err) {
                _showAdminRolesStatus('⚠️ ' + err.message, '#c62828');
            } finally {
                btn.disabled = false;
            }
        });
    });

    // Delete — removes from Supabase Auth AND portal roles map
    wrap.querySelectorAll('.delete-user-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const { userid, email } = btn.dataset;
            if (!confirm(`Permanently delete the admin account for ${email}? This cannot be undone.`)) return;
            btn.disabled = true;
            try {
                await callAdminUsers('delete', { userId: userid });
                if (window._adminRoles) delete window._adminRoles[email];
                await saveAdminRoles(window._adminRoles || {});
                _showAdminRolesStatus(`✓ Deleted ${email}`, '#2e7d32');
                _loadAdminUsersTable();
            } catch (err) {
                _showAdminRolesStatus('⚠️ ' + err.message, '#c62828');
                btn.disabled = false;
            }
        });
    });
}

function _showAdminRolesStatus(msg, color) {
    const el = document.getElementById('adminRolesStatus');
    if (!el) return;
    el.textContent = msg;
    el.style.color  = color;
    setTimeout(() => { el.textContent = ''; }, 4000);
}

// ============================================================
// GEOFENCE & CLOCK REMINDERS
// ============================================================
async function loadGeofenceSettings() {
    const statusEl = document.getElementById('geofenceStatus');
    try {
        const s = await fetchGeofenceSettings();
        if (s.enabled       != null) { const el = document.getElementById('geofenceEnabled');    if (el) el.checked    = !!s.enabled; }
        if (s.lat           != null) { const el = document.getElementById('geofenceLat');        if (el) el.value      = String(s.lat); }
        if (s.lng           != null) { const el = document.getElementById('geofenceLng');        if (el) el.value      = String(s.lng); }
        if (s.radius_ft     != null) { const el = document.getElementById('geofenceRadius');     if (el) el.value      = String(s.radius_ft); }
        if (s.grace_minutes != null) { const el = document.getElementById('geofenceGrace');      if (el) el.value      = String(s.grace_minutes); }
        if (s.notify_email)          { const el = document.getElementById('geofenceNotifyEmail'); if (el) el.value     = s.notify_email; }
    } catch (err) {
        if (statusEl) { statusEl.textContent = '⚠️ Load error: ' + err.message; statusEl.style.color = '#c62828'; }
        console.error('loadGeofenceSettings error:', err);
    }
}

function setupGeofence() {
    const btn      = document.getElementById('saveGeofenceBtn');
    const statusEl = document.getElementById('geofenceStatus');
    if (!btn) return;

    // Load saved settings now (belt-and-suspenders alongside Promise.all load)
    loadGeofenceSettings();

    // "Use My Location" button
    const locBtn = document.getElementById('geofenceUseMyLocation');
    if (locBtn) {
        locBtn.addEventListener('click', () => {
            if (!navigator.geolocation) {
                if (statusEl) { statusEl.textContent = '⚠️ Geolocation not supported by this browser.'; statusEl.style.color = '#c62828'; }
                return;
            }
            const orig = locBtn.textContent;
            locBtn.textContent = '⏳ Getting location…';
            locBtn.disabled    = true;
            if (statusEl) { statusEl.textContent = ''; }
            navigator.geolocation.getCurrentPosition(
                pos => {
                    document.getElementById('geofenceLat').value = pos.coords.latitude.toFixed(6);
                    document.getElementById('geofenceLng').value = pos.coords.longitude.toFixed(6);
                    locBtn.textContent = '✓ Got location';
                    locBtn.disabled    = false;
                    setTimeout(() => { locBtn.textContent = orig; }, 3000);
                },
                err => {
                    locBtn.textContent = orig;
                    locBtn.disabled    = false;
                    const msg = err.code === 1
                        ? '⚠️ Location permission denied — allow location access in your browser settings and try again.'
                        : err.code === 2
                        ? '⚠️ Location unavailable — check your device\'s location services.'
                        : '⚠️ Location request timed out — please try again.';
                    if (statusEl) { statusEl.textContent = msg; statusEl.style.color = '#c62828'; }
                },
                { timeout: 10000, enableHighAccuracy: false }
            );
        });
    }

    btn.addEventListener('click', async () => {
        btn.disabled    = true;
        btn.textContent = 'Saving…';
        if (statusEl) statusEl.textContent = '';
        try {
            const normDec = s => s.trim().replace(',', '.');
            const lat   = parseFloat(normDec(document.getElementById('geofenceLat').value))   || null;
            const lng   = parseFloat(normDec(document.getElementById('geofenceLng').value))   || null;
            const rad   = parseInt(document.getElementById('geofenceRadius').value, 10)       || null;
            const grace = parseInt(document.getElementById('geofenceGrace').value, 10)        || null;
            const email = document.getElementById('geofenceNotifyEmail').value.trim()  || null;

            await saveGeofenceSettings({
                enabled:       document.getElementById('geofenceEnabled').checked,
                lat,
                lng,
                radius_ft:     rad,
                grace_minutes: grace,
                notify_email:  email,
            });

            if (statusEl) {
                statusEl.textContent = '✓ Saved!';
                statusEl.style.color = '#2e7d32';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }
        } catch (err) {
            if (statusEl) {
                statusEl.textContent = '⚠️ ' + err.message;
                statusEl.style.color = '#c62828';
            }
            console.error('saveGeofenceSettings:', err);
        } finally {
            btn.disabled    = false;
            btn.textContent = '💾 Save';
        }
    });
}
