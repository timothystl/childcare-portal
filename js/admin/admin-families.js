// ============================================================
// MODULE: Admin Families (directory, student management, family modal)
// Sections: Data Health, Families & Students, Family Modal
// ============================================================

// DATA HEALTH — missing-field detection
// ============================================================

// Returns array of { level:'critical'|'warning', label, tip } for a family.
function getFamilyIssues(f) {
    const issues = [];
    if (!f.parent_email)  issues.push({ level: 'critical', label: 'No email',  tip: 'Primary parent has no email — cannot log in or receive confirmations.' });
    if (!f.has_pin)       issues.push({ level: 'critical', label: 'No PIN',    tip: 'Primary parent has no PIN — cannot log into the parent portal.' });
    if (!f.parent_phone)  issues.push({ level: 'warning',  label: 'No phone',  tip: 'Primary parent has no phone number on file.' });
    return issues;
}

// Returns array of { level, label, tip } for a single student.
function getStudentIssues(s) {
    const issues = [];
    if (!s.child_dob)   issues.push({ level: 'critical', label: 'No DOB',  tip: 'Missing date of birth — child cannot be auto-assigned a room and registration will fail.' });
    if (!s.child_name)  issues.push({ level: 'critical', label: 'No name', tip: 'Child record has no name.' });
    return issues;
}

// Renders a run of issue badge spans.
function issuesBadgeHtml(issues) {
    return issues.map(i =>
        `<span class="data-issue-badge data-issue-${i.level}" title="${escHtml(i.tip)}">${escHtml(i.label)}</span>`
    ).join('');
}

// Scans all loaded families and returns a summary { critical, warning }.
function scanDataHealth(families) {
    let critical = 0, warning = 0;
    (families || []).forEach(f => {
        getFamilyIssues(f).forEach(i => i.level === 'critical' ? critical++ : warning++);
        (f.students || []).forEach(s =>
            getStudentIssues(s).forEach(i => i.level === 'critical' ? critical++ : warning++));
    });
    return { critical, warning };
}

// ============================================================
// FAMILIES & STUDENTS
// ============================================================
let importRows        = [];
let allFamiliesData   = [];
let editingFamilyId   = null;   // null = adding new, string = editing existing
let familyModalChildren = [];   // working copy of children in the modal
let _fmPhotoUrlCache = new Map(); // profile_photo_path -> displayable URL (signed or blob:), modal-scoped
// Storage paths replaced/removed in the modal, deleted only once Save
// succeeds — deleting eagerly would orphan the DB's remaining path reference
// if the admin cancels instead of saving.
let _fmPhotosToDelete = [];
let showArchivedFamilies = false;
let showIssuesOnly = false;
let _familyListPhotoUrlCache = new Map(); // profile_photo_path -> signed URL, for the family list

function setupFamilies() {
    const fileInput  = document.getElementById('familiesFileInput');
    const importBtn  = document.getElementById('importFamiliesBtn');
    const refreshBtn = document.getElementById('refreshFamiliesBtn');

    fileInput?.addEventListener('change', onFamiliesFileChange);
    importBtn?.addEventListener('click', onImportFamilies);
    refreshBtn?.addEventListener('click', loadFamilies);
    document.getElementById('familyChildSearch')?.addEventListener('input', onFamilySearch);
    document.getElementById('familySortBy')?.addEventListener('change', e => {
        familiesSortBy = e.target.value;
        onFamilySearch(); // re-render with new sort
    });

    // New family management buttons
    document.getElementById('addFamilyBtn')?.addEventListener('click', () => openFamilyModal());
    document.getElementById('archiveSummerBtn')?.addEventListener('click', onArchiveSummerFamilies);
    document.getElementById('familiesToggleArchivedBtn')?.addEventListener('click', () => {
        showArchivedFamilies = !showArchivedFamilies;
        const btn = document.getElementById('familiesToggleArchivedBtn');
        btn.textContent = showArchivedFamilies ? 'Hide Archived' : 'Show Archived';
        btn.classList.toggle('btn-active', showArchivedFamilies);
        loadFamilies();
    });

    // Family modal buttons
    document.getElementById('fmCloseBtn')?.addEventListener('click', closeFamilyModal);
    document.getElementById('fmCancelBtn')?.addEventListener('click', closeFamilyModal);
    document.getElementById('fmSaveBtn')?.addEventListener('click', saveFamilyModal);
    document.getElementById('fmAddChildBtn')?.addEventListener('click', addModalChildRow);
    document.getElementById('fmNewPinBtn')?.addEventListener('click', () => {
        document.getElementById('fmPin').value = generateLocalPin();
    });
    document.getElementById('fmNewPin2Btn')?.addEventListener('click', () => {
        document.getElementById('fmParent2Pin').value = generateLocalPin();
    });
    document.getElementById('familyModal')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) closeFamilyModal();
    });

    // Merge modal
    document.getElementById('mergeCancelBtn')?.addEventListener('click', closeMergeModal);
    document.getElementById('mergeConfirmBtn')?.addEventListener('click', doMergeFamilies);
    document.getElementById('mergeModal')?.addEventListener('click', e => {
        if (e.target === e.currentTarget) closeMergeModal();
    });

    // Document-level delegation for Edit / Archive / Restore / Delete / Merge buttons in family rows
    document.addEventListener('click', e => {
        // Kebab ("more actions") menu: toggle on its own button, otherwise
        // close every open menu when the click lands outside all of them.
        // This runs first and never `return`s, so a click on one of the
        // buttons the menu contains still falls through to its own handler
        // below (only #fm-kebab-btn needs to stop here).
        const kebabBtn = e.target.closest('.fm-kebab-btn[data-family-id]');
        if (kebabBtn) {
            const menu = kebabBtn.nextElementSibling;
            const wasOpen = menu && !menu.classList.contains('hidden');
            document.querySelectorAll('.fm-kebab-menu').forEach(m => m.classList.add('hidden'));
            document.querySelectorAll('.fm-kebab-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
            if (menu && !wasOpen) {
                menu.classList.remove('hidden');
                kebabBtn.setAttribute('aria-expanded', 'true');
            }
            return;
        }
        if (!e.target.closest('.fm-kebab')) {
            document.querySelectorAll('.fm-kebab-menu').forEach(m => m.classList.add('hidden'));
            document.querySelectorAll('.fm-kebab-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
        } else if (e.target.closest('.fm-kebab-menu button')) {
            // Acting on a menu item closes the menu — the row re-renders
            // anyway once the action completes, but this avoids a stale open
            // menu flashing during that re-render.
            e.target.closest('.fm-kebab-menu')?.classList.add('hidden');
        }

        const editBtn = e.target.closest('.fm-edit-btn[data-family-id]');
        if (editBtn) {
            const fam = allFamiliesData.find(f => f.id === editBtn.dataset.familyId);
            if (fam) openFamilyModal(fam);
            return;
        }
        const archiveBtn = e.target.closest('.fm-archive-btn[data-family-id]');
        if (archiveBtn) {
            confirmArchiveFamily(archiveBtn.dataset.familyId, archiveBtn.dataset.familyName);
            return;
        }
        const restoreBtn = e.target.closest('.fm-restore-btn[data-family-id]');
        if (restoreBtn) { doRestoreFamily(restoreBtn.dataset.familyId); return; }

        const deleteBtn = e.target.closest('.fm-delete-btn[data-family-id]');
        if (deleteBtn) {
            confirmDeleteFamily(deleteBtn.dataset.familyId, deleteBtn.dataset.familyName);
            return;
        }

        const mergeBtn = e.target.closest('.fm-merge-btn[data-family-id]');
        if (mergeBtn) {
            openMergeModal(mergeBtn.dataset.familyId, mergeBtn.dataset.familyName);
            return;
        }

        const calBtn = e.target.closest('.fm-cal-btn[data-family-id]');
        if (calBtn) {
            const fam = allFamiliesData.find(f => f.id === calBtn.dataset.familyId);
            if (fam) openAdminRegModalForFamily(fam);
            return;
        }

        const lockBtn = e.target.closest('.fm-lock-btn[data-family-id]');
        if (lockBtn) {
            doSetFamilyLock(lockBtn.dataset.familyId, true);
            return;
        }
        const unlockBtn = e.target.closest('.fm-unlock-btn[data-family-id]');
        if (unlockBtn) {
            doSetFamilyLock(unlockBtn.dataset.familyId, false);
            return;
        }
        const loginUnlockBtn = e.target.closest('.fm-login-unlock-btn[data-family-id]');
        if (loginUnlockBtn) {
            doSetFamilyLoginLock(loginUnlockBtn.dataset.familyId, false);
            return;
        }
    });

    // Escape closes family modal (visibility-safe) and any open kebab menu
    document.addEventListener('keydown', e => {
        if (e.key === 'Escape') {
            const fm = document.getElementById('familyModal');
            if (fm && !fm.classList.contains('hidden')) { closeFamilyModal(); return; }
            document.querySelectorAll('.fm-kebab-menu').forEach(m => m.classList.add('hidden'));
            document.querySelectorAll('.fm-kebab-btn').forEach(b => b.setAttribute('aria-expanded', 'false'));
        }
    });
}

function onFamilySearch() {
    const q = (document.getElementById('familyChildSearch')?.value || '').toLowerCase().trim();
    familiesPage = 0;
    if (!q) {
        renderFamiliesList(allFamiliesData);
        return;
    }
    const filtered = allFamiliesData.filter(f =>
        (f.students || []).some(s => s.child_name && s.child_name.toLowerCase().includes(q)) ||
        (f.parent_name  && f.parent_name.toLowerCase().includes(q)) ||
        (f.parent2_name && f.parent2_name.toLowerCase().includes(q))
    );
    renderFamiliesList(filtered);
}

async function onFamiliesFileChange(e) {
    const file = e.target.files[0];
    if (!file) return;
    document.getElementById('familiesFileName').textContent = file.name;
    document.getElementById('importFamiliesBtn').disabled = true;
    document.getElementById('importPreview').innerHTML =
        '<p class="empty-hint">Parsing file…</p>';
    importRows = [];

    try {
        const rawRows = await parseUploadedFile(file);
        if (!rawRows.length) {
            document.getElementById('importPreview').innerHTML =
                '<p class="empty-hint">No data rows found in the file.</p>';
            return;
        }

        importRows = rawRows.map(normalizeImportRow).filter(r => r.parentName);

        if (!importRows.length) {
            document.getElementById('importPreview').innerHTML =
                '<p class="import-error">Could not detect parent name column. ' +
                'Expected headers like "Parent Name", "Guardian", or "First Name" + "Last Name".</p>';
            return;
        }

        renderImportPreview(importRows);
        document.getElementById('importFamiliesBtn').disabled = false;
    } catch (err) {
        document.getElementById('importPreview').innerHTML =
            `<p class="import-error">Error reading file: ${escHtml(err.message)}</p>`;
        console.error('File parse error:', err);
    }
}

// range=2 skips 2 leading rows before the header row — matches the Families
// importer's typical ProCare export (which has title/blank rows up top).
// Other importers with a plain header-on-row-1 file (e.g. Waitlist Import)
// should pass range=0.
function parseUploadedFile(file, range = 2) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = e => {
            try {
                const data = new Uint8Array(e.target.result);
                const wb   = XLSX.read(data, { type: 'array', cellDates: true });
                const ws   = wb.Sheets[wb.SheetNames[0]];
                const rows = XLSX.utils.sheet_to_json(ws, { raw: false, defval: '', range });
                resolve(rows);
            } catch (err) { reject(err); }
        };
        reader.onerror = () => reject(new Error('File read failed.'));
        reader.readAsArrayBuffer(file);
    });
}

// Auto-detect ProCare / custom column mapping
function normalizeImportRow(rawRow) {
    const keys   = Object.keys(rawRow);
    const get    = key => String(rawRow[key] ?? '').trim();
    const findCol = (...keywords) => {
        const key = keys.find(k =>
            keywords.some(kw => k.toLowerCase().replace(/[^a-z ]/g, ' ').includes(kw))
        );
        return key ? String(rawRow[key] ?? '').trim() : '';
    };

    // ProCare format: "Parent1 Name" is unique to ProCare exports
    // "First Name" / "Last Name" are the CHILD's names in ProCare
    const isProCare = keys.includes('Parent1 Name');

    if (isProCare) {
        const childFirst = get('First Name');
        const childLast  = get('Last Name');
        const childName  = [childFirst, childLast].filter(Boolean).join(' ').trim();
        const childDob   = normalizeDobStr(get('Birthdate'));

        const p1Name  = get('Parent1 Name');
        const p1Email = get('Parent1 Email');
        const p1Phone = get('Parent1 Phone');
        const p1Pin   = get('Parent1 Sign-In Code');

        const p2Name  = get('Parent2 Name');
        const p2Email = get('Parent2 Email');
        const p2Phone = get('Parent2 Phone');
        const p2Pin   = get('Parent2 Sign-In Code');

        // Primary parent must have an email for lookup; swap if Parent1 has none
        let parentName, parentEmail, parentPhone, parentPin;
        let parent2Name, parent2Email, parent2Phone, parent2Pin;

        if (p1Email || !p2Email) {
            parentName = p1Name;  parentEmail = p1Email;  parentPhone = p1Phone;  parentPin = p1Pin;
            parent2Name = p2Name; parent2Email = p2Email; parent2Phone = p2Phone; parent2Pin = p2Pin;
        } else {
            parentName = p2Name;  parentEmail = p2Email;  parentPhone = p2Phone;  parentPin = p2Pin;
            parent2Name = p1Name; parent2Email = p1Email; parent2Phone = p1Phone; parent2Pin = p1Pin;
        }

        return { parentName, parentEmail, parentPhone, parentPin,
                 parent2Name, parent2Email, parent2Phone, parent2Pin,
                 childName, childDob };
    }

    // Generic auto-detect (non-ProCare files)
    let parentName = findCol('parent name', 'guardian name', 'primary contact');
    if (!parentName) {
        const f = findCol('parent first', 'guardian first');
        const l = findCol('parent last',  'guardian last');
        if (f && l) parentName = `${f} ${l}`.trim();
        else if (f) parentName = f;
    }
    if (!parentName) {
        const f = findCol('first name', 'first');
        const l = findCol('last name',  'last');
        if (f && l) parentName = `${f} ${l}`.trim();
        else if (f) parentName = f;
    }

    const parentEmail = findCol('email', 'e-mail', 'e mail');
    const parentPhone = findCol('phone', 'cell', 'mobile', 'telephone');

    let childName = findCol('student name', 'child name', 'student first name');
    if (!childName) {
        const f = findCol('student first', 'child first');
        const l = findCol('student last',  'child last');
        if (f && l) childName = `${f} ${l}`.trim();
        else if (f) childName = f;
    }

    const childDobRaw = findCol('dob', 'birth date', 'birthday', 'date of birth', 'birthdate');
    const childDob    = normalizeDobStr(childDobRaw);

    return { parentName, parentEmail, parentPhone, childName, childDob };
}

function normalizeDobStr(raw) {
    if (!raw) return null;
    const str = String(raw).trim();
    if (!str) return null;
    if (/^\d{4}-\d{2}-\d{2}$/.test(str)) return str;
    // Excel serial date (e.g. 44289 → 2021-04-03)
    const num = Number(str);
    if (!isNaN(num) && num > 10000 && num < 60000) {
        const d = new Date(Math.round((num - 25569) * 86400000));
        return d.toISOString().split('T')[0];
    }
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d.toISOString().split('T')[0];
    return null;
}

function renderImportPreview(rows) {
    const preview   = rows.slice(0, 10);
    const remaining = rows.length - preview.length;

    const tableRows = preview.map(r => `
        <tr>
            <td>${escHtml(r.parentName)}</td>
            <td>${escHtml(r.parentEmail)}</td>
            <td>${escHtml(r.parentPhone)}</td>
            <td>${escHtml(r.parentPin || '')}</td>
            <td>${escHtml(r.childName)}</td>
            <td>${escHtml(r.childDob || '')}</td>
        </tr>`).join('');

    document.getElementById('importPreview').innerHTML = `
        <p class="import-preview-count">
            <strong>${rows.length}</strong> record${rows.length !== 1 ? 's' : ''} detected
            ${remaining > 0 ? ` (showing first 10)` : ''}
        </p>
        <div class="table-wrapper import-table-wrap">
            <table class="import-preview-table">
                <thead>
                    <tr>
                        <th>Parent Name</th><th>Email</th><th>Phone</th>
                        <th>PIN</th><th>Child Name</th><th>Child DOB</th>
                    </tr>
                </thead>
                <tbody>${tableRows}</tbody>
            </table>
        </div>`;
}

async function onImportFamilies() {
    if (!importRows.length) return;
    const btn = document.getElementById('importFamiliesBtn');
    btn.disabled    = true;
    btn.textContent = 'Importing…';
    try {
        const { familiesImported, studentsImported } = await importFamiliesData(importRows);
        document.getElementById('importPreview').innerHTML =
            `<p class="import-success">
                ✅ Import complete — <strong>${familiesImported}</strong> families,
                <strong>${studentsImported}</strong> students.
             </p>`;
        importRows = [];
        document.getElementById('familiesFileInput').value = '';
        document.getElementById('familiesFileName').textContent = 'No file chosen';
        await loadFamilies();
    } catch (err) {
        alert('Import failed: ' + err.message);
        btn.disabled    = false;
        btn.textContent = '⬆ Import';
    }
}

async function loadFamilies() {
    const container = document.getElementById('familiesList');
    if (container) container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        allFamiliesData = await fetchAllFamilies({ includeArchived: showArchivedFamilies });
        _discountMap = null; // invalidate cached discount map
        const photoPaths = allFamiliesData.flatMap(f => (f.students || []).map(s => s.profile_photo_path)).filter(Boolean);
        _familyListPhotoUrlCache = photoPaths.length
            ? await fetchChildProfilePhotoUrls(photoPaths).catch(() => new Map())
            : new Map();
        const searchEl = document.getElementById('familyChildSearch');
        if (searchEl) searchEl.value = '';
        familiesPage = 0;
        renderFamiliesList(allFamiliesData);
        updateDataHealthBanner(allFamiliesData);
    } catch (err) {
        if (container) container.innerHTML = `<p class="import-error">Failed to load families: ${escHtml(err.message)}</p>`;
    }
}

function updateDataHealthBanner(families) {
    const banner = document.getElementById('dataHealthBanner');
    if (!banner) return;
    const { critical, warning } = scanDataHealth(families);

    if (critical === 0 && warning === 0) {
        banner.style.display = 'none';
        return;
    }

    const parts = [];
    if (critical > 0) parts.push(`<strong>${critical}</strong> critical issue${critical !== 1 ? 's' : ''}`);
    if (warning  > 0) parts.push(`<strong>${warning}</strong> warning${warning  !== 1 ? 's' : ''}`);

    banner.style.display = '';
    banner.innerHTML = `
        <span class="dh-icon">⚠️</span>
        <span class="dh-text">Data issues found: ${parts.join(' &amp; ')} — missing emails, PINs, or dates of birth. Badges are shown on each affected record below.</span>
        <button class="dh-filter-btn${showIssuesOnly ? ' active' : ''}" id="dhFilterBtn">
            ${showIssuesOnly ? '✕ Show All' : '🔍 Show Issues Only'}
        </button>
        <button class="dh-dismiss-btn" id="dhDismissBtn" title="Dismiss">✕</button>`;

    document.getElementById('dhFilterBtn')?.addEventListener('click', () => {
        showIssuesOnly = !showIssuesOnly;
        renderFamiliesList(allFamiliesData);
        updateDataHealthBanner(allFamiliesData);
    });
    document.getElementById('dhDismissBtn')?.addEventListener('click', () => {
        banner.style.display = 'none';
    });
}

function sortFamilies(families) {
    const sorted = [...families];
    switch (familiesSortBy) {
        case 'room':
            sorted.sort((a, b) => {
                const roomA = ((a.students || [])[0]?.room_override || '') ;
                const roomB = ((b.students || [])[0]?.room_override || '') ;
                return roomA.localeCompare(roomB) || (a.parent_name || '').localeCompare(b.parent_name || '');
            });
            break;
        case 'discount':
            sorted.sort((a, b) => {
                const hasDisc = f => (f.students || []).some(s => s.discount_type && s.discount_type !== 'none');
                return (hasDisc(b) ? 1 : 0) - (hasDisc(a) ? 1 : 0)
                    || (a.parent_name || '').localeCompare(b.parent_name || '');
            });
            break;
        case 'age_asc': // youngest first = most recent DOB first
            sorted.sort((a, b) => {
                const newestDob = f => (f.students || [])
                    .map(s => s.child_dob || '').filter(Boolean).sort().reverse()[0] || '';
                return newestDob(b).localeCompare(newestDob(a));
            });
            break;
        case 'age_desc': // oldest first = earliest DOB first
            sorted.sort((a, b) => {
                const oldestDob = f => (f.students || [])
                    .map(s => s.child_dob || '').filter(Boolean).sort()[0] || '';
                return oldestDob(a).localeCompare(oldestDob(b));
            });
            break;
        case 'child_name':
            sorted.sort((a, b) => {
                const firstChild = f => (f.students || [])
                    .map(s => (s.child_name || '').toLowerCase())
                    .sort()[0] || '';
                return firstChild(a).localeCompare(firstChild(b))
                    || (a.parent_name || '').localeCompare(b.parent_name || '');
            });
            break;
        default: { // 'name' — sort by family last name (as shown in heading)
            const lname = n => (n || '').trim().split(/\s+/).pop()?.toLowerCase() || '';
            sorted.sort((a, b) =>
                lname(a.parent_name).localeCompare(lname(b.parent_name)) ||
                (a.parent_name || '').localeCompare(b.parent_name || ''));
            break;
        }
    }
    return sorted;
}

function renderFamiliesList(families) {
    const container = document.getElementById('familiesList');

    // Apply "issues only" filter before rendering
    const filtered = showIssuesOnly
        ? families.filter(f =>
            getFamilyIssues(f).length > 0 ||
            (f.students || []).some(s => getStudentIssues(s).length > 0))
        : families;

    if (!filtered.length) {
        container.innerHTML = showIssuesOnly
            ? '<p class="empty-hint">✅ No data issues found in the current family list.</p>'
            : showArchivedFamilies
                ? '<p class="empty-hint">No archived families.</p>'
                : '<p class="empty-hint">No families yet. Use + Add Family or import from Excel.</p>';
        return;
    }

    // Deduplicate by family ID in case the DB ever returns the same row twice
    const _seenIds = new Set();
    const unique   = filtered.filter(f => {
        if (_seenIds.has(f.id)) return false;
        _seenIds.add(f.id);
        return true;
    });

    const sorted      = sortFamilies(unique);
    const totalCount  = sorted.length;
    const totalPages  = Math.ceil(totalCount / FAMILIES_PAGE_SIZE);
    if (familiesPage >= totalPages) familiesPage = Math.max(0, totalPages - 1);
    const pageStart   = familiesPage * FAMILIES_PAGE_SIZE;
    const pageFamilies = sorted.slice(pageStart, pageStart + FAMILIES_PAGE_SIZE);
    const roomOptions = getSortedRooms().map(r =>
        `<option value="${r.id}">${r.label}</option>`
    ).join('');

    const parentRow = (name, email, phone, hasPin) => {
        if (!name && !email) return '';
        return `<div class="family-parent-row">
            <span class="family-row-name">${escHtml(name || '')}</span>
            <span class="family-pin-badge">${hasPin ? 'PIN set' : ''}</span>
            <span class="family-row-meta">${escHtml(email || '')}${email && phone ? ' &middot; ' : ''}${escHtml(phone || '')}</span>
            <span></span>
        </div>`;
    };

    const pageEnd = Math.min(pageStart + FAMILIES_PAGE_SIZE, totalCount);
    const paginationHtml = totalPages > 1 ? `
        <div class="families-pagination">
            <button class="btn-secondary families-prev-btn" ${familiesPage === 0 ? 'disabled' : ''}>&#8592; Prev</button>
            <span class="families-page-info">Page ${familiesPage + 1} of ${totalPages}</span>
            <button class="btn-secondary families-next-btn" ${familiesPage >= totalPages - 1 ? 'disabled' : ''}>Next &#8594;</button>
        </div>` : '';

    const totalKids = sorted.reduce((sum, f) => sum + (f.students || []).length, 0);

    container.innerHTML = `
        <p class="families-count">Showing ${pageStart + 1}–${pageEnd} of ${totalCount} famil${totalCount !== 1 ? 'ies' : 'y'}${showArchivedFamilies ? ' (including archived)' : ''} &middot; ${totalKids} child${totalKids !== 1 ? 'ren' : ''} total</p>
        ${paginationHtml}
        <ul class="families-list">
            ${pageFamilies.map(f => {
                const kids     = (f.students || []);
                const archived = f.active === false;
                const lastName = (f.parent_name || '').trim().split(/\s+/).pop() || '';
                const famIssues = getFamilyIssues(f);
                const anyIssues = famIssues.length > 0 || kids.some(s => getStudentIssues(s).length > 0);
                return `
                    <li class="family-row${archived ? ' family-row-archived' : ''}${anyIssues ? ' family-row-has-issues' : ''}">
                        <div class="family-heading">${escHtml(lastName)} Family</div>
                        <div class="family-row-top">
                            <div class="family-parent-row">
                                <span class="family-row-name">${escHtml(f.parent_name || '')}</span>
                                <span class="family-pin-badge">${f.has_pin ? 'PIN set' : ''}</span>
                                ${issuesBadgeHtml(famIssues)}
                                <span class="family-row-meta">${escHtml(f.parent_email || '')}${f.parent_email && f.parent_phone ? ' &middot; ' : ''}${escHtml(f.parent_phone || '')}</span>
                                <div class="family-row-actions">
                                    ${f.group === 'summer' ? '<span class="family-badge-summer">Summer</span>' : ''}
                                    ${archived ? '<span class="family-badge-archived">Archived</span>' : ''}
                                    ${f.registration_locked ? '<span class="family-badge-locked" title="Registration locked for nonpayment">🔒 Reg Locked</span>' : ''}
                                    ${f.login_locked ? '<span class="family-badge-login-locked" title="Login locked — too many failed attempts">🚫 Login Locked</span>' : ''}
                                    ${!archived
                                        ? `<button class="fm-edit-btn" data-family-id="${f.id}" title="Edit family">✏ Edit</button>
                                           <button class="fm-cal-btn btn-secondary" data-family-id="${f.id}" title="${allRegistrations.some(r => (r.parent_email||'').toLowerCase() === (f.parent_email||'').toLowerCase()) ? 'Edit care calendar for this family' : 'Enter care calendar for this family'}">&#128197; ${allRegistrations.some(r => (r.parent_email||'').toLowerCase() === (f.parent_email||'').toLowerCase()) ? 'Edit Calendar' : 'Enter Calendar'}</button>`
                                        : ''
                                    }
                                    <div class="fm-kebab">
                                        <button type="button" class="fm-kebab-btn" data-family-id="${f.id}" title="More actions" aria-haspopup="true" aria-expanded="false">&#8942;</button>
                                        <div class="fm-kebab-menu hidden" role="menu">
                                            ${archived
                                                ? `<button class="fm-restore-btn" data-family-id="${f.id}" role="menuitem">&#8617; Restore family</button>`
                                                : `<button class="fm-archive-btn" data-family-id="${f.id}" data-family-name="${escHtml(f.parent_name || 'this family')}" role="menuitem">Archive family</button>`
                                            }
                                            ${f.registration_locked
                                                ? `<button class="fm-unlock-btn" data-family-id="${f.id}" role="menuitem">🔓 Unlock registration</button>`
                                                : `<button class="fm-lock-btn" data-family-id="${f.id}" role="menuitem">🔒 Lock registration</button>`
                                            }
                                            ${f.login_locked
                                                ? `<button class="fm-login-unlock-btn" data-family-id="${f.id}" role="menuitem">🔓 Unlock login</button>`
                                                : ''
                                            }
                                            <button class="fm-delete-btn fm-kebab-danger" data-family-id="${f.id}" data-family-name="${escHtml(f.parent_name || 'this family')}" role="menuitem">🗑 Delete family</button>
                                        </div>
                                    </div>
                                </div>
                            </div>
                            ${(f.parent2_name || f.parent2_email) ? parentRow(f.parent2_name, f.parent2_email, f.parent2_phone, f.has_parent2_pin) : ''}
                        </div>
                        ${kids.length ? `
                            <ul class="family-students">
                                ${kids.map(s => {
                                    const dobStr = s.child_dob
                                        ? new Date(s.child_dob + 'T00:00:00').toLocaleDateString('en-US',
                                            { month: 'short', day: 'numeric', year: 'numeric' })
                                        : '';
                                    const dt = s.discount_type || 'none';
                                    const dv = s.discount_value || 0;
                                    const sIssues = getStudentIssues(s);
                                    const photoUrl = s.profile_photo_path ? _familyListPhotoUrlCache.get(s.profile_photo_path) : null;
                                    return `<li class="family-student-item${sIssues.length ? ' student-has-issues' : ''}" data-student-id="${s.id}">
                                        ${photoUrl
                                            ? `<img src="${escHtml(photoUrl)}" alt="" class="roster-photo-thumb">`
                                            : '<span class="roster-photo-thumb roster-photo-thumb-empty" aria-hidden="true"></span>'}
                                        <span class="student-bullet">Child</span>
                                        <span class="student-name">${escHtml(s.child_name)}</span>
                                        <span class="student-dob">${dobStr}</span>
                                        ${issuesBadgeHtml(sIssues)}
                                        <div class="room-override-wrap">
                                            <label class="room-override-label">Room:</label>
                                            <select class="room-override-select" data-student-id="${s.id}">
                                                <option value="">Auto (age-based)</option>
                                                ${roomOptions}
                                            </select>
                                        </div>
                                        <div class="discount-wrap">
                                            <label class="room-override-label">Discount:</label>
                                            <select class="discount-type-inline" data-student-id="${s.id}">
                                                <option value="none"   ${dt === 'none'   ? 'selected' : ''}>None</option>
                                                <option value="staff"  ${dt === 'staff'  ? 'selected' : ''}>Staff (free)</option>
                                                <option value="custom" ${dt === 'custom' ? 'selected' : ''}>Custom %</option>
                                            </select>
                                            <input type="number" class="discount-value-inline"
                                                   data-student-id="${s.id}"
                                                   value="${dv}" min="0" max="100" step="1"
                                                   placeholder="%" style="width:52px;${dt !== 'custom' ? 'display:none' : ''}">
                                        </div>
                                    </li>`;
                                }).join('')}
                            </ul>` : ''}
                    </li>`;
            }).join('')}
        </ul>
        ${paginationHtml}`;

    // Pagination button events
    container.querySelector('.families-prev-btn')?.addEventListener('click', () => {
        if (familiesPage > 0) { familiesPage--; renderFamiliesList(families); }
    });
    container.querySelector('.families-next-btn')?.addEventListener('click', () => {
        if (familiesPage < totalPages - 1) { familiesPage++; renderFamiliesList(families); }
    });

    // Bind room override + discount change events
    pageFamilies.forEach(f => {
        (f.students || []).forEach(s => {
            // Room override
            const roomSel = container.querySelector(`.room-override-select[data-student-id="${s.id}"]`);
            if (roomSel) {
                roomSel.value = s.room_override || '';
                roomSel.addEventListener('change', async () => {
                    try {
                        await updateStudentRoomOverride(s.id, roomSel.value || null);
                        roomSel.style.borderColor = '#68d391';
                        setTimeout(() => { roomSel.style.borderColor = ''; }, 2000);
                    } catch (err) {
                        alert('Failed to update room: ' + err.message);
                        roomSel.value = s.room_override || '';
                    }
                });
            }

            // Inline discount
            const discSel = container.querySelector(`.discount-type-inline[data-student-id="${s.id}"]`);
            const discVal = container.querySelector(`.discount-value-inline[data-student-id="${s.id}"]`);
            if (discSel) {
                discSel.addEventListener('change', async () => {
                    if (discVal) discVal.style.display = discSel.value === 'custom' ? '' : 'none';
                    if (discSel.value !== 'custom') {
                        try {
                            await updateStudent(s.id, { discount_type: discSel.value, discount_value: null });
                            _discountMap = null;
                            discSel.style.borderColor = '#68d391';
                            setTimeout(() => { discSel.style.borderColor = ''; }, 2000);
                        } catch (err) {
                            alert('Failed to update discount: ' + err.message);
                        }
                    }
                });
            }
            if (discVal) {
                discVal.addEventListener('change', async () => {
                    const val = parseFloat(discVal.value) || 0;
                    try {
                        await updateStudent(s.id, { discount_type: 'custom', discount_value: val });
                        _discountMap = null;
                        discVal.style.borderColor = '#68d391';
                        setTimeout(() => { discVal.style.borderColor = ''; }, 2000);
                    } catch (err) {
                        alert('Failed to update discount: ' + err.message);
                    }
                });
            }
        });
    });
}

// ============================================================
// FAMILY MODAL — Add / Edit
// ============================================================
function generateLocalPin() {
    return Math.floor(1000 + Math.random() * 9000);
}

async function openFamilyModal(family = null) {
    editingFamilyId = family ? family.id : null;

    // Set title
    document.getElementById('fmTitle').textContent = family ? 'Edit Family' : 'Add Family';

    if (family) {
        // Populate parent fields
        document.getElementById('fmParentName').value    = family.parent_name  || '';
        document.getElementById('fmParentEmail').value   = family.parent_email || '';
        document.getElementById('fmParentPhone').value   = family.parent_phone || '';
        // PINs are bcrypt-hashed; we can't show the existing PIN. Leave blank
        // — submitting blank keeps the current PIN, typing a new one replaces it.
        const pinInput  = document.getElementById('fmPin');
        const p2PinInput = document.getElementById('fmParent2Pin');
        pinInput.value = '';
        p2PinInput.value = '';
        pinInput.placeholder  = family.has_pin         ? 'Leave blank to keep current PIN' : '4-8 digits';
        p2PinInput.placeholder = family.has_parent2_pin ? 'Leave blank to keep current PIN' : '4-8 digits';
        document.getElementById('fmParent2Name').value   = family.parent2_name  || '';
        document.getElementById('fmParent2Email').value  = family.parent2_email || '';
        document.getElementById('fmParent2Phone').value  = family.parent2_phone || '';
        // Group radio
        const grp = family.group || 'regular';
        document.querySelectorAll('input[name="fmGroup"]').forEach(r => {
            r.checked = (r.value === grp);
        });
        // Children
        // allergies is an array — copy it, or editing chips and then cancelling
        // would still have mutated the loaded family record in place.
        familyModalChildren = (family.students || []).map(s => ({
            ...s,
            allergies: Array.isArray(s.allergies) ? s.allergies.map(a => ({ ...a })) : [],
        }));
        // Sign existing profile photos so the modal can preview them. The
        // bucket is private, so a path alone is not a displayable URL.
        const photoPaths = familyModalChildren.map(c => c.profile_photo_path).filter(Boolean);
        _fmPhotoUrlCache = photoPaths.length ? await fetchChildProfilePhotoUrls(photoPaths).catch(() => new Map()) : new Map();
        _fmPhotosToDelete = [];
    } else {
        // Clear all fields
        ['fmParentName','fmParentEmail','fmParentPhone',
         'fmParent2Name','fmParent2Email','fmParent2Phone','fmParent2Pin'].forEach(id => {
            const el = document.getElementById(id);
            el.value = '';
            if (id === 'fmParent2Pin') el.placeholder = '4-8 digits';
        });
        const pinInput = document.getElementById('fmPin');
        pinInput.value = generateLocalPin();
        pinInput.placeholder = '4-8 digits';
        document.querySelectorAll('input[name="fmGroup"]').forEach(r => {
            r.checked = (r.value === 'regular');
        });
        familyModalChildren = [];
        _fmPhotoUrlCache = new Map();
        _fmPhotosToDelete = [];
    }

    renderModalChildRows();

    const modal = document.getElementById('familyModal');
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden';
    document.getElementById('fmParentName').focus();
}

function closeFamilyModal() {
    const modal = document.getElementById('familyModal');
    if (!modal || modal.classList.contains('hidden')) return;
    modal.classList.add('hidden');
    document.body.style.overflow = '';
    editingFamilyId     = null;
    familyModalChildren = [];
    _fmPhotoUrlCache    = new Map();
    _fmPhotosToDelete   = []; // discard — nothing was actually deleted from storage yet
}

function renderModalChildRows() {
    const container = document.getElementById('fmChildRows');
    if (!container) return;

    if (!familyModalChildren.length) {
        container.innerHTML = '<p class="fm-no-children">No children added yet. Click + Add Child below.</p>';
        return;
    }

    const roomOptions = getSortedRooms().map(r => `<option value="${r.id}">${r.label}</option>`).join('');

    container.innerHTML = familyModalChildren.map((child, i) => {
        const dt = child.discount_type || 'none';
        const dv = (child.discount_value != null) ? child.discount_value : 0;
        const selectedRoom = child.room_override || '';
        const photoUrl = child.profile_photo_path ? _fmPhotoUrlCache.get(child.profile_photo_path) : null;
        return `
            <div class="fm-child-row" data-index="${i}">
                <div class="fm-child-main">
                    <div class="fm-field fm-child-photo-field">
                        <label>Photo</label>
                        <div class="fmc-photo">
                            ${photoUrl ? `<img src="${escHtml(photoUrl)}" alt="" class="fmc-photo-img">` : '<span class="fmc-photo-empty">No photo</span>'}
                            <input type="file" accept="image/jpeg,image/png,image/webp" class="fmc-photo-file" title="Upload a profile picture">
                            ${child.profile_photo_path ? '<button type="button" class="fmc-photo-remove btn-secondary btn-sm" title="Remove photo">✕</button>' : ''}
                        </div>
                    </div>
                    <div class="fm-field fm-field-grow">
                        <label>Name *</label>
                        <input type="text" class="fmc-name" value="${escHtml(child.child_name || '')}" placeholder="Child's full name">
                    </div>
                    <div class="fm-field">
                        <label>Date of Birth</label>
                        <input type="date" class="fmc-dob" value="${child.child_dob || ''}">
                    </div>
                    <div class="fm-field">
                        <label>Room</label>
                        <select class="fmc-room">
                            <option value="" ${!selectedRoom ? 'selected' : ''}>Auto (age-based)</option>
                            ${getSortedRooms().map(r => `<option value="${r.id}" ${selectedRoom === r.id ? 'selected' : ''}>${r.label}</option>`).join('')}
                        </select>
                    </div>
                </div>
                <div class="fm-child-discount">
                    <div class="fm-field">
                        <label>Discount</label>
                        <select class="fmc-discount-type">
                            <option value="none"       ${dt === 'none'       ? 'selected' : ''}>None</option>
                            <option value="staff"      ${dt === 'staff'      ? 'selected' : ''}>Staff (100% free)</option>
                            <option value="custom"     ${dt === 'custom'     ? 'selected' : ''}>Custom %</option>
                            <option value="scholarship" ${dt === 'scholarship' ? 'selected' : ''}>Scholarship</option>
                        </select>
                    </div>
                    <div class="fm-field discount-value-wrap" ${dt !== 'custom' ? 'style="display:none"' : ''}>
                        <label>% Off</label>
                        <input type="number" class="fmc-discount-value" value="${dv}" min="0" max="100" step="1" style="width:70px">
                    </div>
                    <!-- ⚠️ A scholarship's actual dollar reduction still comes from
                         a % (Custom) discount or a billing override — this label
                         alone charges nothing (effectiveAdminRate() only special-
                         cases 'staff' and 'custom'). It exists so "Bill the
                         month" and the billing report can flag it by name and
                         track when it expires. -->
                    <div class="fm-field discount-expires-wrap" ${dt === 'none' ? 'style="display:none"' : ''}>
                        <label>Expires</label>
                        <input type="date" class="fmc-discount-expires" value="${child.discount_expires_at || ''}" style="width:150px">
                    </div>
                    <div class="fm-field fm-field-grow">
                        <label>Note</label>
                        <input type="text" class="fmc-discount-note" value="${escHtml(child.discount_note || '')}" placeholder="Optional note">
                    </div>
                </div>
                ${dt === 'scholarship' ? `<p class="fm-scholarship-hint">A scholarship label alone charges nothing — set a Custom % above (or a billing override) for the actual reduction. This just tracks the name and the expiry.</p>` : ''}
                <div class="fm-child-safety">
                    <label style="font-size:.82em;color:#555;font-weight:600;display:block;margin-bottom:4px">
                        Allergies &amp; Care Notes
                        <span style="font-weight:400;color:#888">(shown to staff before they log a meal)</span>
                    </label>
                    <div class="fmc-allergy-chips" data-index="${i}" style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:6px">
                        ${_fmAllergyChipsHtml(child.allergies)}
                    </div>
                    <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center">
                        <input type="text" class="fmc-allergy-label" placeholder="e.g. Peanut"
                               style="flex:1;min-width:140px" maxlength="60">
                        <select class="fmc-allergy-severity" style="width:130px">
                            <option value="severe">Severe</option>
                            <option value="sensitivity">Sensitivity</option>
                            <option value="note">Care note</option>
                        </select>
                        <button type="button" class="btn-secondary btn-sm fmc-allergy-add" data-index="${i}">Add</button>
                    </div>
                    <div class="fm-field fm-field-grow" style="margin-top:6px">
                        <label>Other care notes</label>
                        <input type="text" class="fmc-care-notes" value="${escHtml(child.care_notes || '')}"
                               placeholder="e.g. inhaler in cubby">
                    </div>
                    <label style="font-size:.85em;display:flex;align-items:center;gap:6px;margin-top:8px">
                        <input type="checkbox" class="fmc-photo-release" ${child.photo_release === false ? '' : 'checked'}>
                        Photo release — may appear in photos shared with other families
                    </label>
                </div>
                <div class="fm-child-recurring">
                    <label style="font-size:.82em;color:#555;font-weight:600;display:block;margin-bottom:4px">Recurring Days <span style="font-weight:400;color:#888">(reminder shown when entering care days)</span></label>
                    <div style="display:flex;gap:8px;flex-wrap:wrap">
                        ${['Mon','Tue','Wed','Thu','Fri'].map(day => {
                            const rd = Array.isArray(child.recurring_days) ? child.recurring_days : [];
                            return `<label style="font-size:.85em;display:flex;align-items:center;gap:3px"><input type="checkbox" class="fmc-recurring-day" value="${day}" ${rd.includes(day) ? 'checked' : ''}> ${day}</label>`;
                        }).join('')}
                    </div>
                </div>
                <div class="fm-child-documents">
                    <label class="fm-doc-label">Documents</label>
                    ${child.id ? `
                        <div class="fmc-doc-list" data-index="${i}"><p class="fm-doc-loading">Loading…</p></div>
                        <div class="fmc-doc-actions">
                            <label class="btn-secondary btn-sm fmc-doc-pick">📷 Scan document
                                <input type="file" accept="image/*" capture="environment" class="fmc-doc-scan hidden-file-input" data-index="${i}">
                            </label>
                            <label class="btn-secondary btn-sm fmc-doc-pick">&#8593; Upload file
                                <input type="file" accept="image/jpeg,image/png,image/webp,application/pdf" class="fmc-doc-upload hidden-file-input" data-index="${i}">
                            </label>
                        </div>`
                        : '<p class="fm-doc-hint">Save this child first, then reopen Edit to attach documents.</p>'}
                </div>
                <button type="button" class="fmc-remove-btn" data-index="${i}" title="Remove child">✕</button>
            </div>`;
    }).join('');

    // Bind discount-type toggles. DOM-only, deliberately: renderModalChildRows()
    // rebuilds every row from familyModalChildren, and that array is only
    // synced from the inputs at Save time (see the allergy-chip comment above
    // for why) — calling it here would wipe whatever the director had half
    // typed into the name/DOB/room fields of every other row.
    container.querySelectorAll('.fmc-discount-type').forEach(sel => {
        sel.addEventListener('change', () => {
            const row = sel.closest('.fm-child-row');
            const discountBlock = sel.closest('.fm-child-discount');
            const valueWrap   = discountBlock.querySelector('.discount-value-wrap');
            const expiresWrap = discountBlock.querySelector('.discount-expires-wrap');
            if (valueWrap)   valueWrap.style.display   = sel.value === 'custom' ? '' : 'none';
            if (expiresWrap) expiresWrap.style.display = sel.value === 'none'   ? 'none' : '';

            let hint = row.querySelector('.fm-scholarship-hint');
            if (sel.value === 'scholarship') {
                if (!hint) {
                    hint = document.createElement('p');
                    hint.className = 'fm-scholarship-hint';
                    hint.textContent = 'A scholarship label alone charges nothing — set a Custom % above (or a billing override) for the actual reduction. This just tracks the name and the expiry.';
                    discountBlock.after(hint);
                }
            } else {
                hint?.remove();
            }
        });
    });

    // Allergy chips: add / remove operate on familyModalChildren directly and
    // repaint just that row's chip strip, so a full re-render never wipes
    // half-typed values in the other fields.
    container.querySelectorAll('.fmc-allergy-add').forEach(btn => {
        const row = btn.closest('.fm-child-row');
        const add = () => {
            const idx      = parseInt(btn.dataset.index);
            const labelEl  = row.querySelector('.fmc-allergy-label');
            const sevEl    = row.querySelector('.fmc-allergy-severity');
            const label    = (labelEl?.value || '').trim();
            if (!label) { labelEl?.focus(); return; }
            const child = familyModalChildren[idx];
            if (!child) return;
            if (!Array.isArray(child.allergies)) child.allergies = [];
            // Same label twice is a data-entry slip, not two allergies.
            if (child.allergies.some(a => (a.label || '').toLowerCase() === label.toLowerCase())) {
                labelEl.value = '';
                return;
            }
            child.allergies.push({ label, severity: sevEl?.value || 'severe' });
            labelEl.value = '';
            _fmRepaintAllergyChips(row, idx);
            labelEl.focus();
        };
        btn.addEventListener('click', add);
        // Enter in the label field should add, not submit the modal.
        row.querySelector('.fmc-allergy-label')?.addEventListener('keydown', e => {
            if (e.key === 'Enter') { e.preventDefault(); add(); }
        });
    });

    container.querySelectorAll('.fmc-allergy-chips').forEach(strip => {
        strip.addEventListener('click', e => {
            const btn = e.target.closest('.fmc-allergy-remove');
            if (!btn) return;
            const idx = parseInt(strip.dataset.index);
            const at  = parseInt(btn.dataset.at);
            const child = familyModalChildren[idx];
            if (!child || !Array.isArray(child.allergies)) return;
            child.allergies.splice(at, 1);
            _fmRepaintAllergyChips(strip.closest('.fm-child-row'), idx);
        });
    });

    // Bind remove buttons
    container.querySelectorAll('.fmc-remove-btn').forEach(btn => {
        btn.addEventListener('click', () => removeModalChildRow(parseInt(btn.dataset.index)));
    });

    container.querySelectorAll('.fm-child-row').forEach(row => _fmBindPhotoRow(row));
    container.querySelectorAll('.fm-child-row').forEach(row => _fmBindDocumentsRow(row));
}

// ── Documents (Family Directory modal — per-child paperwork) ────────────
// Storage-only, no metadata table (see add_child_documents_bucket.sql) — the
// list is read fresh from the bucket every time a row opens or changes,
// which is why this repaints just `.fmc-doc-list` rather than tracking state
// in familyModalChildren the way allergies/photo do.
function _fmDocSize(bytes) {
    if (bytes == null) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function _fmRenderDocList(listEl, docs) {
    if (!docs.length) {
        listEl.innerHTML = '<p class="fm-doc-empty">No documents attached.</p>';
        return;
    }
    listEl.innerHTML = docs.map(d => `
        <div class="fmc-doc-item" data-path="${escHtml(d.path)}">
            <span class="fmc-doc-name">${escHtml(d.name)}</span>
            <span class="fmc-doc-meta">${escHtml(_fmDocSize(d.size))}</span>
            <button type="button" class="fmc-doc-view" data-path="${escHtml(d.path)}" title="View / download">View</button>
            <button type="button" class="fmc-doc-remove" data-path="${escHtml(d.path)}" title="Remove">✕</button>
        </div>`).join('');
}

async function _fmLoadDocuments(row) {
    const idx = parseInt(row.dataset.index);
    const child = familyModalChildren[idx];
    const listEl = row.querySelector('.fmc-doc-list');
    if (!child?.id || !listEl) return;
    try {
        const docs = await listChildDocuments(child.id);
        _fmRenderDocList(listEl, docs);
    } catch (err) {
        listEl.innerHTML = `<p class="import-error">Couldn't load documents: ${escHtml(err.message)}</p>`;
    }
}

function _fmBindDocumentsRow(row) {
    const idx = parseInt(row.dataset.index);
    const child = familyModalChildren[idx];
    if (!child?.id) return; // unsaved child — no Documents controls rendered

    _fmLoadDocuments(row);

    const upload = async (file) => {
        if (!file) return;
        try {
            await uploadChildDocument(child.id, file);
            await _fmLoadDocuments(row);
        } catch (err) {
            alert("Couldn't attach that file: " + err.message);
        }
    };
    row.querySelector('.fmc-doc-scan')?.addEventListener('change', e => upload(e.target.files[0]));
    row.querySelector('.fmc-doc-upload')?.addEventListener('change', e => upload(e.target.files[0]));

    row.querySelector('.fmc-doc-list')?.addEventListener('click', async e => {
        const path = e.target.closest('[data-path]')?.dataset.path;
        if (!path) return;
        if (e.target.closest('.fmc-doc-view')) {
            try {
                const url = await fetchChildDocumentUrl(path);
                if (url) window.open(url, '_blank', 'noopener');
            } catch (err) {
                alert("Couldn't open that file: " + err.message);
            }
        } else if (e.target.closest('.fmc-doc-remove')) {
            const name = e.target.closest('.fmc-doc-item')?.querySelector('.fmc-doc-name')?.textContent || 'this document';
            if (!confirm(`Remove ${name}? This can't be undone.`)) return;
            try {
                await deleteChildDocument(path);
                await _fmLoadDocuments(row);
            } catch (err) {
                alert("Couldn't remove that file: " + err.message);
            }
        }
    });
}

// Uploads/removes a profile picture for the row's child. Repaints only the
// `.fmc-photo` cell — a full renderModalChildRows() would wipe whatever the
// admin has half-typed in the row's other fields (same reasoning as the
// allergy chips above).
function _fmBindPhotoRow(row) {
    const idx = parseInt(row.dataset.index);
    row.querySelector('.fmc-photo-file')?.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const child = familyModalChildren[idx];
        if (!child) return;
        try {
            const ext = (file.name.split('.').pop() || 'jpg').replace(/[^a-zA-Z0-9]/g, '') || 'jpg';
            const filename = `${editingFamilyId || 'new'}-${child.id || idx}-${Date.now()}.${ext}`;
            const oldPath = child.profile_photo_path;
            const newPath = await uploadChildProfilePhoto(file, filename);
            child.profile_photo_path = newPath;
            // We already hold the file, so preview it locally rather than
            // round-tripping to sign a URL for what we just uploaded.
            _fmPhotoUrlCache.set(newPath, URL.createObjectURL(file));
            if (oldPath && oldPath !== newPath) _fmPhotosToDelete.push(oldPath);
            _fmRepaintPhoto(row, idx);
        } catch (err) {
            alert('Photo upload failed: ' + err.message);
        }
    });
    row.querySelector('.fmc-photo-remove')?.addEventListener('click', () => {
        const child = familyModalChildren[idx];
        if (!child || !child.profile_photo_path) return;
        _fmPhotosToDelete.push(child.profile_photo_path);
        child.profile_photo_path = null;
        _fmRepaintPhoto(row, idx);
    });
}

function _fmRepaintPhoto(row, idx) {
    const wrap = row?.querySelector('.fmc-photo');
    if (!wrap) return;
    const child = familyModalChildren[idx];
    const photoUrl = child?.profile_photo_path ? _fmPhotoUrlCache.get(child.profile_photo_path) : null;
    wrap.innerHTML = `
        ${photoUrl ? `<img src="${escHtml(photoUrl)}" alt="" class="fmc-photo-img">` : '<span class="fmc-photo-empty">No photo</span>'}
        <input type="file" accept="image/jpeg,image/png,image/webp" class="fmc-photo-file" title="Upload a profile picture">
        ${child?.profile_photo_path ? '<button type="button" class="fmc-photo-remove btn-secondary btn-sm" title="Remove photo">✕</button>' : ''}
    `;
    _fmBindPhotoRow(row);
}

function addModalChildRow() {
    // Sync any values already typed in the DOM back to familyModalChildren
    // before re-rendering (prevents wiping unsaved inputs).
    document.querySelectorAll('#fmChildRows .fm-child-row').forEach(row => {
        const idx = parseInt(row.dataset.index);
        if (!isNaN(idx) && familyModalChildren[idx]) {
            familyModalChildren[idx].child_name     = row.querySelector('.fmc-name')?.value.trim() || '';
            familyModalChildren[idx].child_dob      = row.querySelector('.fmc-dob')?.value || null;
            familyModalChildren[idx].room_override  = row.querySelector('.fmc-room')?.value || null;
            familyModalChildren[idx].discount_type  = row.querySelector('.fmc-discount-type')?.value || 'none';
            familyModalChildren[idx].discount_value = parseFloat(row.querySelector('.fmc-discount-value')?.value) || 0;
            familyModalChildren[idx].discount_note  = row.querySelector('.fmc-discount-note')?.value.trim() || null;
            familyModalChildren[idx].discount_expires_at = row.querySelector('.fmc-discount-expires')?.value || null;
            familyModalChildren[idx].recurring_days = [...row.querySelectorAll('.fmc-recurring-day:checked')].map(cb => cb.value);
            familyModalChildren[idx].care_notes     = row.querySelector('.fmc-care-notes')?.value.trim() || null;
            familyModalChildren[idx].photo_release  = row.querySelector('.fmc-photo-release')?.checked !== false;
            // allergies are already on familyModalChildren — chips write there directly
        }
    });

    familyModalChildren.push({
        id: null, child_name: '', child_dob: null,
        room_override: null, discount_type: 'none', discount_value: 0, discount_note: null,
        discount_expires_at: null,
        recurring_days: [], allergies: [], care_notes: null, photo_release: true,
        profile_photo_path: null,
    });
    renderModalChildRows();
    // Focus the new name input
    const rows = document.querySelectorAll('#fmChildRows .fm-child-row');
    if (rows.length) rows[rows.length - 1].querySelector('.fmc-name')?.focus();
}

// Chip styling mirrors the staff quick-log sheet in the design: a severe
// allergy is solid --tang so it reads at a glance across a room; sensitivities
// and care notes are outlined.
const _FM_SEV_STYLE = {
    severe:      'background:var(--tang);color:#fff;border:1.5px solid var(--tang)',
    sensitivity: 'background:#fff;color:var(--tang-dark);border:1.5px solid var(--tang-soft)',
    note:        'background:#fff;color:var(--text-muted);border:1.5px solid var(--border)',
};

function _fmAllergyChipsHtml(allergies) {
    const list = Array.isArray(allergies) ? allergies : [];
    if (!list.length) {
        return '<span style="font-size:.82em;color:#888">None recorded</span>';
    }
    return list.map((a, at) => {
        const style = _FM_SEV_STYLE[a.severity] || _FM_SEV_STYLE.note;
        return `<span style="${style};border-radius:999px;padding:2px 10px;font-size:.78em;
                     font-weight:800;letter-spacing:.04em;display:inline-flex;align-items:center;gap:6px">
                    ${escHtml(a.label)}
                    <button type="button" class="fmc-allergy-remove" data-at="${at}"
                            title="Remove ${escHtml(a.label)}"
                            style="background:none;border:none;cursor:pointer;padding:0;font-size:1.1em;
                                   line-height:1;color:inherit;opacity:.75">&times;</button>
                </span>`;
    }).join('');
}

function _fmRepaintAllergyChips(row, idx) {
    const strip = row?.querySelector('.fmc-allergy-chips');
    if (strip) strip.innerHTML = _fmAllergyChipsHtml(familyModalChildren[idx]?.allergies);
}

function removeModalChildRow(index) {
    familyModalChildren.splice(index, 1);
    renderModalChildRows();
}

function readModalChildrenFromDom() {
    const children = [];
    document.querySelectorAll('#fmChildRows .fm-child-row').forEach(row => {
        const idx  = parseInt(row.dataset.index);
        const name = row.querySelector('.fmc-name').value.trim();
        if (!name) return;
        children.push({
            originalId:     familyModalChildren[idx]?.id || null,
            child_name:     name,
            child_dob:      row.querySelector('.fmc-dob').value || null,
            room_override:  row.querySelector('.fmc-room').value  || null,
            discount_type:  row.querySelector('.fmc-discount-type').value || 'none',
            discount_value: parseFloat(row.querySelector('.fmc-discount-value').value) || 0,
            discount_note:  row.querySelector('.fmc-discount-note').value.trim() || null,
            discount_expires_at: row.querySelector('.fmc-discount-expires')?.value || null,
            recurring_days: [...row.querySelectorAll('.fmc-recurring-day:checked')].map(cb => cb.value),
            // Allergies live on familyModalChildren rather than in the DOM —
            // they are chips, not inputs.
            allergies:      Array.isArray(familyModalChildren[idx]?.allergies)
                                ? familyModalChildren[idx].allergies : [],
            care_notes:     row.querySelector('.fmc-care-notes')?.value.trim() || null,
            photo_release:  row.querySelector('.fmc-photo-release')?.checked !== false,
            // Not a DOM input — set/cleared directly on familyModalChildren by
            // the photo upload/remove handlers.
            profile_photo_path: familyModalChildren[idx]?.profile_photo_path || null,
        });
    });
    return children;
}

async function saveFamilyModal() {
    const saveBtn = document.getElementById('fmSaveBtn');
    if (!saveBtn) return;
    saveBtn.disabled    = true;
    saveBtn.textContent = 'Saving…';

    try {
        const parentName  = document.getElementById('fmParentName').value.trim();
        const parentEmail = document.getElementById('fmParentEmail').value.trim();
        const parentPhone = document.getElementById('fmParentPhone').value.trim();
        const pinVal      = document.getElementById('fmPin').value.trim();
        const p2Name      = document.getElementById('fmParent2Name').value.trim()  || null;
        const p2Email     = document.getElementById('fmParent2Email').value.trim() || null;
        const p2Phone     = document.getElementById('fmParent2Phone').value.trim() || null;
        const p2PinVal    = document.getElementById('fmParent2Pin').value.trim();
        const group       = document.querySelector('input[name="fmGroup"]:checked')?.value || 'regular';

        // PINs go through the secure RPC (bcrypt-hashed server-side). Blank
        // means "leave the existing PIN unchanged" on edit.
        if (pinVal   && !/^\d{4,8}$/.test(pinVal))   { alert('Primary PIN must be 4–8 digits.'); return; }
        if (p2PinVal && !/^\d{4,8}$/.test(p2PinVal)) { alert('Parent 2 PIN must be 4–8 digits.'); return; }

        if (!parentName) { alert('Parent name is required.'); return; }

        const children = readModalChildrenFromDom();

        if (!editingFamilyId) {
            // ---- CREATE ----
            const fam = await createFamily({
                parentName, parentEmail, parentPhone,
                pin: pinVal || null,
                parent2Name: p2Name, parent2Email: p2Email,
                parent2Phone: p2Phone, parent2Pin: p2PinVal || null,
            });
            // Set group (createFamily doesn't set it)
            await updateFamily(fam.id, { group });

            for (const child of children) {
                await addStudent({
                    familyId:      fam.id,
                    childName:     child.child_name,
                    childDob:      child.child_dob,
                    roomOverride:  child.room_override,
                    discountType:  child.discount_type,
                    discountValue: child.discount_value,
                    discountNote:  child.discount_note,
                    discountExpiresAt: child.discount_expires_at,
                    profilePhotoPath: child.profile_photo_path,
                    // FS21: these four were dropped on the CREATE path only —
                    // a child added while creating a new family started with
                    // no allergy record and no recurring-days reminder, a
                    // silent divergence from the UPDATE branch just below.
                    // Allergies is a safety field, not a convenience one.
                    recurringDays: child.recurring_days?.length ? child.recurring_days : null,
                    allergies:     child.allergies || [],
                    careNotes:     child.care_notes,
                    photoRelease:  child.photo_release,
                });
            }
        } else {
            // ---- UPDATE ----
            await updateFamily(editingFamilyId, {
                parent_name:  parentName,
                parent_email: parentEmail,
                parent_phone: parentPhone,
                parent2_name:  p2Name,
                parent2_email: p2Email,
                parent2_phone: p2Phone,
                group,
            });
            if (pinVal)   await setFamilyPin(editingFamilyId, pinVal,   false);
            if (p2PinVal) await setFamilyPin(editingFamilyId, p2PinVal, true);

            // Reconcile children
            const origIds = familyModalChildren.map(c => c.id).filter(Boolean);
            const keptIds = children.map(c => c.originalId).filter(Boolean);

            // Delete removed children
            for (const origId of origIds) {
                if (!keptIds.includes(origId)) await deleteStudent(origId);
            }

            // Update existing / add new children
            for (const child of children) {
                if (child.originalId) {
                    await updateStudent(child.originalId, {
                        child_name:     child.child_name,
                        child_dob:      child.child_dob,
                        room_override:  child.room_override,
                        discount_type:  child.discount_type,
                        discount_value: child.discount_value,
                        discount_note:  child.discount_note,
                        discount_expires_at: child.discount_expires_at,
                        recurring_days: child.recurring_days?.length ? child.recurring_days : null,
                        allergies:      child.allergies || [],
                        care_notes:     child.care_notes,
                        photo_release:  child.photo_release,
                        profile_photo_path: child.profile_photo_path,
                        // Saving the child IS the review. An empty list stamped
                        // here means a real "no allergies"; unstamped means
                        // nobody has looked, and the staff app says exactly that
                        // rather than implying an all-clear.
                        allergies_reviewed_at: new Date().toISOString(),
                    });
                } else {
                    await addStudent({
                        familyId:      editingFamilyId,
                        childName:     child.child_name,
                        childDob:      child.child_dob,
                        roomOverride:  child.room_override,
                        discountType:  child.discount_type,
                        discountValue: child.discount_value,
                        discountNote:  child.discount_note,
                        discountExpiresAt: child.discount_expires_at,
                        recurringDays: child.recurring_days?.length ? child.recurring_days : null,
                        allergies:     child.allergies || [],
                        careNotes:     child.care_notes,
                        photoRelease:  child.photo_release,
                        profilePhotoPath: child.profile_photo_path,
                    });
                }
            }
        }

        // Only now, with the DB rows saved successfully, is it safe to drop
        // replaced/removed photo objects — deleting earlier would orphan a
        // path the DB still referenced if this save had failed or been
        // cancelled.
        if (_fmPhotosToDelete.length) {
            await Promise.all(_fmPhotosToDelete.map(p => deleteChildProfilePhoto(p).catch(() => {})));
            _fmPhotosToDelete = [];
        }

        closeFamilyModal();
        await loadFamilies();

    } catch (err) {
        alert('Save failed: ' + err.message);
        console.error('saveFamilyModal:', err);
    } finally {
        saveBtn.disabled    = false;
        saveBtn.textContent = 'Save Family';
    }
}

// ---- Archive / Restore ----
async function confirmArchiveFamily(id, name) {
    if (!confirm(`Archive ${name}?\n\nThey'll be hidden from the active roster. Their registration history is preserved and you can restore them at any time.`)) return;
    await doArchiveFamily(id);
}

async function doArchiveFamily(id) {
    try {
        await archiveFamily(id);
        const fam = allFamiliesData.find(f => f.id === id);
        await logAdminAction('archive', 'family', id, { parent_name: fam?.parent_name });
        await loadFamilies();
    } catch (err) {
        alert('Archive failed: ' + err.message);
    }
}

async function doRestoreFamily(id) {
    try {
        await restoreFamily(id);
        const fam = allFamiliesData.find(f => f.id === id);
        await logAdminAction('restore', 'family', id, { parent_name: fam?.parent_name });
        await loadFamilies();
    } catch (err) {
        alert('Restore failed: ' + err.message);
    }
}

// ---- Delete ----
async function doSetFamilyLock(id, locked) {
    try {
        await setFamilyRegistrationLock(id, locked);
        const fam = allFamiliesData.find(f => f.id === id);
        if (fam) fam.registration_locked = locked;
        await logAdminAction(locked ? 'lock_registration' : 'unlock_registration', 'family', id, { parent_name: fam?.parent_name });
        onFamilySearch();
    } catch (err) {
        alert((locked ? 'Lock' : 'Unlock') + ' failed: ' + err.message);
    }
}

async function doSetFamilyLoginLock(id, locked) {
    try {
        await setFamilyLoginLock(id, locked);
        const fam = allFamiliesData.find(f => f.id === id);
        if (fam) { fam.login_locked = locked; if (!locked) fam.login_attempts = 0; }
        await logAdminAction(locked ? 'lock_login' : 'unlock_login', 'family', id, { parent_name: fam?.parent_name });
        onFamilySearch();
    } catch (err) {
        alert('Unlock login failed: ' + err.message);
    }
}

function confirmDeleteFamily(id, name) {
    if (!confirm(`Permanently delete the ${name} family and ALL their children?\n\nThis cannot be undone.`)) return;
    doDeleteFamily(id, name);
}

async function doDeleteFamily(id, name) {
    try {
        await deleteFamily(id);
        await logAdminAction('delete', 'family', id, { parent_name: name });
        await loadFamilies();
    } catch (err) {
        alert('Delete failed: ' + err.message);
    }
}

// ---- Merge ----
let _mergingFamilyId = null;

function openMergeModal(familyId, familyName) {
    _mergingFamilyId = familyId;
    document.getElementById('mergeFromName').textContent = familyName;
    const select = document.getElementById('mergeIntoSelect');
    select.innerHTML = allFamiliesData
        .filter(f => f.id !== familyId)
        .map(f => {
            const ln = (f.parent_name || '').trim().split(/\s+/).pop() || '';
            return `<option value="${escHtml(f.id)}">${escHtml(ln)} Family — ${escHtml(f.parent_name || '')}</option>`;
        })
        .join('');
    document.getElementById('mergeModal').classList.remove('hidden');
}

function closeMergeModal() {
    _mergingFamilyId = null;
    document.getElementById('mergeModal').classList.add('hidden');
}

async function doMergeFamilies() {
    const toId = document.getElementById('mergeIntoSelect').value;
    if (!toId || !_mergingFamilyId) return;
    const btn = document.getElementById('mergeConfirmBtn');
    btn.disabled = true;
    btn.textContent = 'Merging…';
    try {
        await mergeFamilies(_mergingFamilyId, toId);
        closeMergeModal();
        await loadFamilies();
    } catch (err) {
        alert('Merge failed: ' + err.message);
        btn.disabled = false;
        btn.textContent = 'Merge & Delete';
    }
}

async function onArchiveSummerFamilies() {
    // Count summer families first
    const summerFamilies = allFamiliesData.filter(f => f.group === 'summer' && f.active !== false);
    if (!summerFamilies.length) {
        alert('No active summer families found.');
        return;
    }
    if (!confirm(`Archive all ${summerFamilies.length} summer program families?\n\nThey'll be hidden from the active roster but can be restored individually. Registration history is preserved.`)) return;
    try {
        const count = await archiveSummerFamilies();
        await loadFamilies();
        alert(`✅ ${count} summer famil${count !== 1 ? 'ies' : 'y'} archived.`);
    } catch (err) {
        alert('Archive failed: ' + err.message);
    }
}

// ============================================================
