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
            await logAdminAction('update', 'summer_camp_setting', null, { hidden });
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
            await logAdminAction('create', 'closure', null, { date, reason: reason || null });
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
                    await logAdminAction('delete', 'closure', null, { date: d });
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
const TAB_META = {
    daily:         { icon: '🏫', label: 'Classrooms' },
    registrations: { icon: '📅', label: 'Care Calendar' },
    waitlist:      { icon: '🗓️', label: 'Planning' },
    cacfp:         { icon: '🍎', label: 'Food Program' },
    market:        { icon: '📈', label: 'Market Analysis' },
    families:      { icon: '👨‍👩‍👧', label: 'Families' },
    staffing:      { icon: '👷', label: 'Staffing' },
    messages:      { icon: '💬', label: 'Messages' },
    finance:       { icon: '💰', label: 'Finance' },
    billing:       { icon: '💳', label: 'Billing' },
    reports:       { icon: '📊', label: 'Billing' },
    settings:      { icon: '⚙️', label: 'Settings' }
};

function setupTabs() {
    // The portal shell (js/admin/admin-portal.js) owns navigation: seven
    // role tabs, a permanent sidebar at 900px+, and the same bottom tab bar
    // pattern as the parent app below it. It decides which pane/section is
    // visible and rebuilds both nav surfaces on every render.
    setupAdminPortal();
}

// ============================================================
// AUDIT LOG  (R5 — read-only viewer for admin_audit_log_recent)
// ============================================================
let _auditLogEntries = [];

function setupAuditLog() {
    document.getElementById('auditLogRefreshBtn')?.addEventListener('click', loadAuditLogTab);
    document.getElementById('auditLogSearch')?.addEventListener('input', e => {
        const q = e.target.value.toLowerCase().trim();
        renderAuditLogTable(!q ? _auditLogEntries : _auditLogEntries.filter(entry =>
            (entry.admin_email || '').toLowerCase().includes(q) ||
            (entry.action      || '').toLowerCase().includes(q) ||
            (entry.entity      || '').toLowerCase().includes(q)
        ));
    });
}

// Reloads on every visit to the tab (not just once) — an admin switching back
// after taking an action elsewhere should see it show up, and the query is a
// single capped SELECT, cheap enough to not need a "loaded once" guard.
async function loadAuditLogTab() {
    const tbody = document.getElementById('auditLogTbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="5" class="loading-cell">Loading…</td></tr>';
    try {
        _auditLogEntries = await fetchAuditLog();
        const searchEl = document.getElementById('auditLogSearch');
        if (searchEl) searchEl.value = '';
        renderAuditLogTable(_auditLogEntries);
    } catch (err) {
        console.error('loadAuditLogTab:', err);
        tbody.innerHTML = `<tr><td colspan="5" class="loading-cell error">Failed to load — ${escHtml(err.message || 'unknown error')}</td></tr>`;
    }
}

function renderAuditLogTable(entries) {
    const tbody = document.getElementById('auditLogTbody');
    if (!tbody) return;
    if (!entries.length) {
        tbody.innerHTML = '<tr><td colspan="5" class="loading-cell">No matching entries.</td></tr>';
        return;
    }
    tbody.innerHTML = entries.map(entry => {
        // entry.ts is a full timestamp, not a calendar date — format directly
        // from the Date object (not via friendlyShort, which assumes a plain
        // YYYY-MM-DD and reconstructs local midnight; feeding it a UTC-derived
        // date string here could display the wrong calendar day near midnight).
        const when = new Date(entry.ts).toLocaleString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
        });
        const idBadge = entry.entity_id
            ? ` <span style="color:var(--text-muted);font-size:.85em">#${escHtml(String(entry.entity_id))}</span>`
            : '';
        // details is arbitrary admin-supplied JSON (e.g. { child_name, oldRate,
        // newRate }) — never render it as anything but escaped text.
        let detailsText = '';
        if (entry.details != null) {
            try { detailsText = JSON.stringify(entry.details); }
            catch { detailsText = String(entry.details); }
        }
        return `<tr>
            <td style="white-space:nowrap;">${escHtml(when)}</td>
            <td>${escHtml(entry.admin_email || '')}</td>
            <td>${escHtml(entry.action || '')}</td>
            <td>${escHtml(entry.entity || '')}${idBadge}</td>
            <td style="max-width:360px;font-size:.85em;color:var(--text-muted);word-break:break-word;">${escHtml(detailsText)}</td>
        </tr>`;
    }).join('');
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
// STAFF DIRECTORY (public "Our Staff" section — photos + room assignment)
// ============================================================
let _staffDirectory = null; // loaded once, edited in the DOM, synced back before save

// Lowercased names the public site is currently NOT showing, because the
// person's staff-roster row is inactive. Kept in a SEPARATE structure from
// _staffDirectory on purpose: that array is written straight back to the
// settings row on save, so anything stashed on its entries would be persisted.
let _staffDirectoryHidden = new Set();

// The list comes from staff_directory_hidden_names(), which shares its rule with
// the public_staff_directory() RPC that actually hides them. Do NOT re-derive
// "is this entry hidden" here — a second copy of the rule that drifts would
// label the wrong people as off-site, which is worse than no badge at all.
async function loadStaffDirectoryHidden() {
    _staffDirectoryHidden = new Set();
    try {
        const { data, error } = await sbClient.rpc('staff_directory_hidden_names');
        if (error) { console.error('staff_directory_hidden_names:', error); return; }
        const names = typeof data === 'string' ? parseJsonOr(data, null) : data;
        if (Array.isArray(names)) {
            names.forEach(n => _staffDirectoryHidden.add(String(n || '').trim().toLowerCase()));
        }
    } catch (err) {
        // No badge is a fine degradation; a broken Staff Directory screen is not.
        console.error('loadStaffDirectoryHidden:', err);
    }
}

async function setupStaffDirectory() {
    const [raw] = await Promise.all([
        fetchSetting('staff_directory'),
        loadStaffDirectoryHidden(),
    ]);
    _staffDirectory = Array.isArray(raw) ? raw : [];
    renderStaffDirectory();
    document.getElementById('addStaffDirectoryBtn')?.addEventListener('click', () => {
        syncStaffDirectoryFromDom();
        _staffDirectory.push({ id: `staff-${Date.now()}`, name: '', role: 'Lead Teacher', section: 'lead_teacher', roomId: null, photoUrl: null });
        renderStaffDirectory();
    });
    document.getElementById('saveStaffDirectoryBtn')?.addEventListener('click', onSaveStaffDirectory);
}

// Reads whatever is currently in the row inputs back into _staffDirectory,
// so in-progress edits in other rows survive an add/remove/upload re-render.
function syncStaffDirectoryFromDom() {
    document.querySelectorAll('#staffDirectoryWrap .staff-dir-row').forEach((row, i) => {
        if (!_staffDirectory[i]) return;
        const role = row.querySelector('.staff-dir-role').value;
        _staffDirectory[i].name    = row.querySelector('.staff-dir-name').value.trim();
        _staffDirectory[i].role    = role;
        _staffDirectory[i].section = role === 'Lead Teacher' ? 'lead_teacher' : 'leadership';
        _staffDirectory[i].roomId  = role === 'Lead Teacher' ? (row.querySelector('.staff-dir-room').value || null) : null;
    });
}

function renderStaffDirectory() {
    const wrap = document.getElementById('staffDirectoryWrap');
    if (!wrap) return;
    const roomOptions = getSortedRooms().filter(r => r.id !== 'summer')
        .map(r => `<option value="${r.id}">${escHtml(r.label)}</option>`).join('');

    wrap.innerHTML = _staffDirectory.length ? _staffDirectory.map(s => {
        // Badge, not a filter: the row stays fully editable. Someone marked
        // inactive by mistake needs to be findable here, and the fix is in the
        // Staff Roster, so the tag says where to go rather than just "hidden".
        const offSite = _staffDirectoryHidden.has(String(s.name || '').trim().toLowerCase());
        return `
        <div class="staff-dir-row${offSite ? ' is-off-site' : ''}">
            <div class="staff-dir-photo">
                ${s.photoUrl ? `<img src="${escHtml(s.photoUrl)}" alt="">` : '<span class="staff-dir-photo-empty">No photo</span>'}
                <input type="file" accept="image/jpeg,image/png,image/webp" class="staff-dir-file-input" title="Click to upload a photo">
            </div>
            <div class="staff-dir-fields">
                <input type="text" class="staff-dir-name" placeholder="Name" value="${escHtml(s.name || '')}">
                ${offSite ? '<span class="tag off-site" title="Inactive in Staff Roster, so the public site does not show this card. Reactivate them in Staff → Staff Roster to put it back.">Not on website</span>' : ''}
                <select class="staff-dir-role">
                    <option value="Director" ${s.role === 'Director' ? 'selected' : ''}>Director</option>
                    <option value="Assistant Director" ${s.role === 'Assistant Director' ? 'selected' : ''}>Assistant Director</option>
                    <option value="Lead Teacher" ${s.role === 'Lead Teacher' ? 'selected' : ''}>Lead Teacher</option>
                </select>
                <select class="staff-dir-room" ${s.role !== 'Lead Teacher' ? 'disabled' : ''}>
                    <option value="">— No room —</option>
                    ${roomOptions}
                </select>
            </div>
            <button type="button" class="staff-dir-remove" title="Remove">✕</button>
        </div>`;
    }).join('') : '<p class="empty-hint">No staff added yet — click "Add Staff Member" below.</p>';

    wrap.querySelectorAll('.staff-dir-row').forEach((row, i) => {
        const roomSel = row.querySelector('.staff-dir-room');
        if (roomSel && _staffDirectory[i].roomId) roomSel.value = _staffDirectory[i].roomId;

        row.querySelector('.staff-dir-role').addEventListener('change', (e) => {
            const isTeacher = e.target.value === 'Lead Teacher';
            roomSel.disabled = !isTeacher;
            if (!isTeacher) roomSel.value = '';
        });

        row.querySelector('.staff-dir-remove').addEventListener('click', () => {
            syncStaffDirectoryFromDom();
            _staffDirectory.splice(i, 1);
            renderStaffDirectory();
        });

        row.querySelector('.staff-dir-file-input').addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            syncStaffDirectoryFromDom();
            try {
                const ext      = (file.name.split('.').pop() || 'jpg').toLowerCase();
                const filename = `${Date.now()}-${i}.${ext}`;
                const url      = await uploadStaffPhoto(file, filename);
                _staffDirectory[i].photoUrl = url;
            } catch (err) {
                alert('Photo upload failed: ' + err.message);
            }
            renderStaffDirectory();
        });
    });
}

async function onSaveStaffDirectory() {
    const btn      = document.getElementById('saveStaffDirectoryBtn');
    const statusEl = document.getElementById('staffDirectoryStatus');
    if (!btn) return;
    btn.disabled    = true;
    btn.textContent = 'Saving…';
    if (statusEl) statusEl.textContent = '';

    try {
        syncStaffDirectoryFromDom();
        await upsertSetting('staff_directory', _staffDirectory);
        await logAdminAction('update', 'staff_directory', null, { count: _staffDirectory.length });

        // Re-check after saving: the badge is keyed on the name, so correcting a
        // typo ("Amy" -> "Aimee") can change whether a row matches the roster.
        // Without this the tag would keep describing the pre-save names.
        await loadStaffDirectoryHidden();
        renderStaffDirectory();

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
        console.error('onSaveStaffDirectory:', err);
    } finally {
        btn.disabled    = false;
        btn.textContent = '💾 Save Staff Directory';
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

    const newFamilyVal = await fetchSetting('new_family_fee');
    window._newFamilyFee = (typeof newFamilyVal === 'number' && newFamilyVal >= 0) ? newFamilyVal : 0;
    const newFamilyInp = document.getElementById('newFamilyFeeInput');
    if (newFamilyInp) newFamilyInp.value = window._newFamilyFee > 0 ? window._newFamilyFee.toFixed(2) : '';

    const familyMaxVal = await fetchSetting('supply_fee_family_max');
    window._supplyFeeFamilyMax = (typeof familyMaxVal === 'number' && familyMaxVal >= 0) ? familyMaxVal : 0;
    const familyMaxInp = document.getElementById('supplyFeeFamilyMaxInput');
    if (familyMaxInp) familyMaxInp.value = window._supplyFeeFamilyMax > 0 ? window._supplyFeeFamilyMax.toFixed(2) : '';

    const renewalMD = await fetchSetting('registration_fee_renewal_date');
    window._regFeeRenewalDate = /^\d{2}-\d{2}$/.test(renewalMD) ? renewalMD : '01-01';
    const dateInp = document.getElementById('regFeeRenewalDate');
    // <input type="date"> needs a full date — the year is a throwaway
    // placeholder (2000, a leap year so 02-29 round-trips) since only the
    // month/day portion is ever read or stored.
    if (dateInp) dateInp.value = `2000-${window._regFeeRenewalDate}`;
}

async function setupRegFee() {
    await loadRegFeeSetting();
    document.getElementById('saveRegFeeBtn')?.addEventListener('click', async () => {
        const btn           = document.getElementById('saveRegFeeBtn');
        const statusEl      = document.getElementById('regFeeStatus');
        const inp           = document.getElementById('regFeeInput');
        const newFamilyInp  = document.getElementById('newFamilyFeeInput');
        const familyMaxInp  = document.getElementById('supplyFeeFamilyMaxInput');
        const dateInp       = document.getElementById('regFeeRenewalDate');
        if (!btn || !inp) return;
        btn.disabled    = true;
        btn.textContent = 'Saving…';
        if (statusEl) statusEl.textContent = '';
        try {
            const fee = parseFloat(inp.value) || 0;
            await upsertSetting('registration_fee', fee);
            window._regFeeAmount = fee;

            const newFamilyFee = parseFloat(newFamilyInp?.value) || 0;
            await upsertSetting('new_family_fee', newFamilyFee);
            window._newFamilyFee = newFamilyFee;

            const familyMax = parseFloat(familyMaxInp?.value) || 0;
            await upsertSetting('supply_fee_family_max', familyMax);
            window._supplyFeeFamilyMax = familyMax;

            const renewalMD = (dateInp?.value || '').slice(5); // "YYYY-MM-DD" → "MM-DD"
            if (/^\d{2}-\d{2}$/.test(renewalMD)) {
                await upsertSetting('registration_fee_renewal_date', renewalMD);
                window._regFeeRenewalDate = renewalMD;
            }

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
            btn.textContent = '💾 Save Fees';
        }
    });
}

// ============================================================
// PTO ACCRUAL RATE HISTORY  (global setting — used by the Payroll report
// to auto-compute "PTO Accrued" and each staff member's running balance)
// ============================================================
let _ptoRateHistory = [];

function _renderPtoRateHistory() {
    const wrap = document.getElementById('ptoRateHistoryWrap');
    if (!wrap) return;
    if (!_ptoRateHistory.length) {
        wrap.innerHTML = '<p class="empty-hint">No rate set yet — add one below.</p>';
        return;
    }
    const today = _todayStr();
    wrap.innerHTML = `
        <table style="width:100%;max-width:480px;border-collapse:collapse;font-size:.88rem">
            <thead>
                <tr style="text-align:left;font-size:.78rem;color:#6b7280;text-transform:uppercase;letter-spacing:.03em">
                    <th style="padding:4px 8px 4px 0">Effective Date</th>
                    <th style="padding:4px 8px">Rate</th>
                    <th></th>
                </tr>
            </thead>
            <tbody>
                ${_ptoRateHistory.map((e, i) => {
                    const isFuture  = e.effective_date > today;
                    const isCurrent = !isFuture && (i === _ptoRateHistory.length - 1 || _ptoRateHistory[i + 1].effective_date > today);
                    return `<tr style="border-top:1px solid #e5e7eb">
                        <td style="padding:5px 8px 5px 0">${escHtml(e.effective_date)}</td>
                        <td style="padding:5px 8px">${e.rate}</td>
                        <td style="padding:5px 8px">${
                            isCurrent ? '<span style="color:#2e7d32;font-weight:600;font-size:.8rem">current</span>' :
                            isFuture  ? `<span style="color:#9a6800;font-size:.8rem">scheduled</span> <button type="button" class="btn-ghost pto-rate-remove-btn" data-idx="${i}" style="color:#c62828;font-size:.8rem;padding:0 0 0 6px">Remove</button>` :
                            ''
                        }</td>
                    </tr>`;
                }).join('')}
            </tbody>
        </table>`;
    wrap.querySelectorAll('.pto-rate-remove-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
            const idx = parseInt(btn.dataset.idx, 10);
            const removed = _ptoRateHistory[idx];
            if (!confirm(`Remove the scheduled ${removed.rate} rate effective ${removed.effective_date}?`)) return;
            const prevHistory = _ptoRateHistory;
            _ptoRateHistory = _ptoRateHistory.filter((_, i) => i !== idx);
            try {
                await savePtoRateHistory(_ptoRateHistory);
                _renderPtoRateHistory();
            } catch (err) {
                _ptoRateHistory = prevHistory;
                alert('Failed to remove: ' + err.message);
            }
        });
    });
}

async function loadPtoRateSetting() {
    _ptoRateHistory = await fetchPtoRateHistory();
    _renderPtoRateHistory();
}

async function setupPtoSettings() {
    await loadPtoRateSetting();
    document.getElementById('addPtoRateBtn')?.addEventListener('click', async () => {
        const btn      = document.getElementById('addPtoRateBtn');
        const statusEl = document.getElementById('ptoRateStatus');
        const rateInp  = document.getElementById('newPtoRateInput');
        const dateInp  = document.getElementById('newPtoRateDate');
        if (!btn || !rateInp || !dateInp) return;

        const rate = parseFloat(rateInp.value);
        const date = dateInp.value;
        if (!(rate >= 0) || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
            alert('Enter a valid rate and effective date.');
            return;
        }
        // Past rates are locked once any rate has ever been set — a new entry can only
        // schedule a change from today forward. The one exception is first-time setup
        // (empty history), where a past effective date just backfills "this rate has
        // always applied."
        const today = _todayStr();
        if (_ptoRateHistory.length > 0 && date < today) {
            alert('Effective date must be today or in the future — past rates are locked and can\'t be edited.');
            return;
        }

        btn.disabled    = true;
        btn.textContent = 'Saving…';
        if (statusEl) statusEl.textContent = '';
        try {
            const idx = _ptoRateHistory.findIndex(e => e.effective_date === date);
            const nextHistory = [...(idx >= 0 ? _ptoRateHistory.slice(0, idx).concat(_ptoRateHistory.slice(idx + 1)) : _ptoRateHistory), { rate, effective_date: date }]
                .sort((a, b) => a.effective_date.localeCompare(b.effective_date));
            await savePtoRateHistory(nextHistory);
            _ptoRateHistory = nextHistory;
            _renderPtoRateHistory();
            rateInp.value = '';
            dateInp.value = '';
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
            btn.textContent = '➕ Add Rate';
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

    // Finance, CACFP, and Market Analysis tabs (financial/PII/competitive data) are full-access only
    document.querySelectorAll('[data-tab="finance"]').forEach(el => { el.style.display = 'none'; });
    document.querySelectorAll('[data-tab="cacfp"]').forEach(el => { el.style.display = 'none'; });
    document.querySelectorAll('[data-tab="market"]').forEach(el => { el.style.display = 'none'; });
    // Access & oversight (admin users + audit log) is account-oversight
    // material — who can do what, and every admin's actions across every
    // tab (rate changes, PIN resets, lock/unlock) — not something a
    // restricted or classroom-staff account should browse.
    _hide('setAccessCard');
    // ChMS Finance API test tool — moved into Settings from its own
    // Finance/Bookkeeper sidebar entry (full-only there via
    // AP_FULL_ONLY_TABS); same gate here now that it sits on a tab
    // `restricted` can otherwise open.
    _hide('financeApiCard');
    // HR & Handbook's Injury Reports tab is the one part of that tool that
    // needs `full` — same reasoning `staffInjury` carried as its own
    // AP_FULL_ONLY_KEYS entry before the Staff tab consolidation (the report
    // names an employee, the part of their body, and where they were
    // treated). Policies and Write-ups stay open to `restricted`, so the
    // whole tool can't be gated the way Payroll is — only this one tab.
    _hide('apHrTabInjury');
    _hide('apHrPillInjury');

    if (currentAdminRole === 'restricted') {
        // Staffing tab: hide everything except the schedule planner
        _hide('logHoursSection');
        _hide('payrollSection');
        _hide('staffRosterToggleWrap');
        _hide('staffRosterSection');
        // Settings tab: show only Registration Window Override
        ['setClosedDaysBlock', 'setSummerCampBlock', 'setRoomsCard', 'offerLinksSection']
            .forEach(id => _hide(id));
    }

    if (currentAdminRole === 'staff') {
        // Hide all tabs except Classrooms and force it active. The portal
        // shell's own apTabAvailable() re-derives this from section
        // visibility on every render, so the sidebar and bottom tab bar
        // stay correct without any nav-element bookkeeping here.
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.add('hidden'));
        document.getElementById('tab-daily')?.classList.remove('hidden');
        const chipIcon  = document.getElementById('currentTabIcon');
        const chipLabel = document.getElementById('currentTabLabel');
        if (chipIcon && chipLabel) { chipIcon.textContent = TAB_META.daily.icon; chipLabel.textContent = TAB_META.daily.label; }
        localStorage.setItem('adminActiveTab', 'daily');
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
            await logAdminAction('create', 'admin_role', null, { email, role: level });
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

    // Stacked rows instead of a fixed-column <table> — email, the role
    // select and the two action buttons together are wider than this card's
    // half-width column, so a literal table forced a horizontal scrollbar
    // that hid "Reset Password"/"Delete" off the right edge unless you
    // noticed and scrolled.
    // ⚠️ The first cut put email, Access Level, Last Login and the two
    // buttons as flex-wrap siblings on one row. It looked broken: flex-wrap
    // breaks wherever the next item stops fitting, so at this card's actual
    // width the buttons ended up wrapping onto the Access Level select's
    // line while Last Login got stranded alone below the email — nothing
    // to do with any of them belonging together, just where the wrap
    // happened to fall. Fixed with a deterministic stack instead: email is
    // its own full-width row, Access Level + Last Login sit in a
    // `.au-fields` grid below it, and the two buttons are their own row —
    // the same three groups every time, at every width, rather than
    // whichever grouping flex-wrap produced.
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
            <div class="au-row">
                <div class="au-email">${escHtml(email)}</div>
                <div class="au-fields">
                    <div class="au-field">
                        <span class="rf-label">Access Level</span>
                        <select class="admin-role-select family-search-input btn-sm" data-email="${escHtml(email)}">${options}</select>
                    </div>
                    <div class="au-field">
                        <span class="rf-label">Last Login</span>
                        <span class="au-last-value">${lastSeen}</span>
                    </div>
                </div>
                <div class="au-actions">
                    <button class="btn-ghost btn-sm reset-pw-btn" data-email="${escHtml(email)}">Reset Password</button>
                    <button class="btn-ghost btn-sm delete-user-btn" style="color:#c62828" data-userid="${u.id}" data-email="${escHtml(email)}">Delete</button>
                </div>
            </div>`;
    }).join('');

    wrap.innerHTML = `<div class="au-rows">${rows}</div>`;

    // Inline role change — save immediately on select change
    wrap.querySelectorAll('.admin-role-select').forEach(sel => {
        sel.addEventListener('change', async () => {
            window._adminRoles = window._adminRoles || {};
            window._adminRoles[sel.dataset.email] = sel.value;
            try {
                await saveAdminRoles(window._adminRoles);
                await logAdminAction('update', 'admin_role', null, { email: sel.dataset.email, role: sel.value });
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
                await logAdminAction('delete', 'admin_role', null, { email });
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
