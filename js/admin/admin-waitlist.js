// ============================================================
// MODULE: Admin Waitlist (management, planning, import)
// Sections: Waitlist Management, Waitlist Planning Panel, Waitlist Import
// ============================================================

// WAITLIST MANAGEMENT (admin)
// ============================================================

// Derive room from a waitlist application record
function wlDeriveRoom(app) {
    const dobStr = app.child_dob || app.expected_due_date;
    if (!dobStr || !app.desired_start_date) return null;
    const dob   = new Date(dobStr + 'T00:00:00');
    const start = new Date(app.desired_start_date + 'T00:00:00');
    const months = (start.getFullYear() - dob.getFullYear()) * 12 +
                   (start.getMonth() - dob.getMonth());
    if (months < 12)  return 'bear';
    if (months < 24)  return 'bee';
    if (months < 36)  return 'turtle';
    return 'owl';
}

function wlRoomLabel(roomId) {
    const map = { bear: '🐻 Bear', bee: '🐝 Bee', turtle: '🐢 Turtle', owl: '🦉 Owl' };
    return map[roomId] || '—';
}

function wlStatusBadge(app) {
    const today = new Date().toISOString().split('T')[0];
    if (app.status === 'offered' && app.offer_deadline && app.offer_deadline < today) {
        return '<span class="wl-badge wl-badge-expired">Offer Expired</span>';
    }
    const map = {
        pending:  '<span class="wl-badge wl-badge-pending">Pending</span>',
        offered:  '<span class="wl-badge wl-badge-offered">Spot Offered</span>',
        accepted: '<span class="wl-badge wl-badge-accepted">Accepted</span>',
        enrolled: '<span class="wl-badge wl-badge-enrolled">Enrolled</span>',
        declined: '<span class="wl-badge wl-badge-archived">Declined</span>',
        expired:  '<span class="wl-badge wl-badge-archived">Expired</span>',
        archived: '<span class="wl-badge wl-badge-archived">Archived</span>',
    };
    return map[app.status] || `<span class="wl-badge">${escHtml(app.status)}</span>`;
}

function wlFlexLabel(f) {
    return { exact: 'Exact date', within_month: 'Within a month', within_quarter: 'Within a few months', flexible: 'Very flexible' }[f] || f;
}

function wlTourBadge(app) {
    const status = app.tour_status || 'not_scheduled';
    if (status === 'completed') {
        return '<span class="wl-badge wl-badge-enrolled">✓ Toured</span>';
    }
    if (status === 'scheduled' && app.tour_scheduled_at) {
        const d = new Date(app.tour_scheduled_at);
        return `<span class="wl-badge wl-badge-offered">📅 ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>`;
    }
    return '<span class="wl-badge wl-badge-pending">Not Scheduled</span>';
}

function wlInterestTag(app) {
    if (!app.still_interested_confirmed_at) return '';
    const d = new Date(app.still_interested_confirmed_at);
    return `<br><span class="wl-sib-tag" title="Confirmed via reminder email">👍 confirmed ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>`;
}

function wlDaysWaiting(appliedAt) {
    const ms = Date.now() - new Date(appliedAt).getTime();
    const d  = Math.floor(ms / 86400000);
    if (d === 0) return 'today';
    if (d === 1) return '1 day ago';
    if (d < 7)   return `${d} days ago`;
    const w = Math.floor(d / 7);
    return w === 1 ? '1 week ago' : `${w} weeks ago`;
}

let _allWaitlistApps = [];
let _wlSortCol = 'start';   // 'pos'|'child'|'start'|'age'|'room'|'status'|'parent'|'waiting'
let _wlSortDir = 1;          // 1 = asc, -1 = desc

async function loadWaitlistApplications() {
    const container = document.getElementById('wlQuickListContent');
    container.innerHTML = '<p class="empty-hint">Loading…</p>';
    try {
        _allWaitlistApps = await fetchWaitlistApplications();
        renderWaitlistAdmin();
        renderWaitlistQuickList();
    } catch (err) {
        document.getElementById('wlQuickListContent').innerHTML = `<p class="empty-hint">Error: ${escHtml(err.message)}</p>`;
    }
}

function renderWaitlistQuickList() {
    const container = document.getElementById('wlQuickListContent');
    if (!container) return;

    const searchQ      = (document.getElementById('wlSearchInput')?.value || '').toLowerCase().trim();
    const statusFilter = document.getElementById('wlStatusFilter')?.value || 'active';
    const roomFilter   = document.getElementById('wlRoomFilter')?.value   || '';

    let apps = (_allWaitlistApps || []).slice();

    if (statusFilter === 'active') {
        apps = apps.filter(a => ['pending','offered','accepted'].includes(a.status));
    } else if (statusFilter === 'enrolled') {
        apps = apps.filter(a => a.status === 'enrolled');
    } else if (statusFilter === 'archived') {
        apps = apps.filter(a => ['declined','expired','archived'].includes(a.status));
    }

    if (roomFilter) {
        apps = apps.filter(a => {
            if (roomFilter === 'tbd') return !a.child_dob && !a.expected_due_date;
            return wlDeriveRoom(a) === roomFilter;
        });
    }

    if (searchQ) {
        apps = apps.filter(a =>
            (a.child_name   || '').toLowerCase().includes(searchQ) ||
            (a.parent_name  || '').toLowerCase().includes(searchQ) ||
            (a.parent_email || '').toLowerCase().includes(searchQ)
        );
    }

    // Priority sort baseline (sibling priority stays as tiebreaker for position)
    apps.sort((a, b) => {
        const sibA = a.has_sibling ? 0 : 1, sibB = b.has_sibling ? 0 : 1;
        if (sibA !== sibB) return sibA - sibB;
        return new Date(a.applied_at) - new Date(b.applied_at);
    });

    // Numbered position before user sort
    apps.forEach((a, i) => { a._pos = i + 1; });

    // User-selected sort
    apps.sort((a, b) => {
        let va, vb;
        switch (_wlSortCol) {
            case 'pos':     va = a._pos; vb = b._pos; break;
            case 'child':   va = a.child_name || ''; vb = b.child_name || ''; break;
            case 'start':   va = a.desired_start_date || ''; vb = b.desired_start_date || ''; break;
            case 'age': {
                const ageMonths = x => {
                    const dob = x.child_dob || x.expected_due_date;
                    if (!dob || !x.desired_start_date) return 9999;
                    return Math.round((new Date(x.desired_start_date+'T00:00:00') - new Date(dob+'T00:00:00')) / (1000*60*60*24*30.44));
                };
                va = ageMonths(a); vb = ageMonths(b); break;
            }
            case 'room':    va = wlDeriveRoom(a) || 'zzz'; vb = wlDeriveRoom(b) || 'zzz'; break;
            case 'status':  va = a.status || ''; vb = b.status || ''; break;
            case 'parent':  va = a.parent_name || ''; vb = b.parent_name || ''; break;
            case 'waiting': va = a.applied_at || ''; vb = b.applied_at || ''; break;
            default:        va = 0; vb = 0;
        }
        if (va < vb) return -1 * _wlSortDir;
        if (va > vb) return  1 * _wlSortDir;
        return 0;
    });

    document.getElementById('wlCount').textContent = `${apps.length} application${apps.length !== 1 ? 's' : ''}`;

    if (!apps.length) {
        container.innerHTML = '<p class="empty-hint">No applications match the current filter.</p>';
        return;
    }

    const allRooms = [...ROOMS, { id: 'tbd', label: 'TBD / Unborn' }];

    const sortArrow = col => {
        if (_wlSortCol !== col) return ' <span class="sort-arrow sort-arrow-none">⇅</span>';
        return _wlSortDir === 1 ? ' <span class="sort-arrow">▲</span>' : ' <span class="sort-arrow">▼</span>';
    };

    const rows = apps.map((a, idx) => {
        const roomId    = wlDeriveRoom(a) || 'tbd';
        const roomObj   = allRooms.find(r => r.id === roomId);
        const roomLabel = roomObj?.label || 'TBD';

        const startStr = a.desired_start_date
            ? new Date(a.desired_start_date + 'T00:00:00').toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' })
            : '—';

        let ageLabel = '—';
        const dobStr = a.child_dob || a.expected_due_date;
        if (dobStr && a.desired_start_date) {
            const months = Math.round((new Date(a.desired_start_date+'T00:00:00') - new Date(dobStr+'T00:00:00')) / (1000*60*60*24*30.44));
            if (months < 0)       ageLabel = 'Unborn';
            else if (months < 24) ageLabel = `${months} mo`;
            else                  ageLabel = `${Math.floor(months/12)} yr ${months%12} mo`;
        }

        const canOffer  = ['pending','offered'].includes(a.status);
        const tourStatus = a.tour_status || 'not_scheduled';
        const tourBtn = tourStatus === 'not_scheduled'
            ? `<button class="btn-wl-tour-quick" data-id="${a.id}" data-name="${escHtml(a.parent_name)}" data-child="${escHtml(a.child_name)}">📅 Schedule Tour</button>`
            : tourStatus === 'scheduled'
                ? `<button class="btn-wl-tour-complete-quick" data-id="${a.id}">✓ Mark Toured</button>`
                : '';

        return `<tr>
            <td class="wl-td-pos">${a._pos}</td>
            <td class="wl-td-child"><strong>${escHtml(a.child_name)}</strong>${a.has_sibling ? `<br><span class="wl-sib-tag">👨‍👩‍👧 sibling</span>` : ''}</td>
            <td class="wl-td-start">${startStr}</td>
            <td class="wl-td-age">${escHtml(ageLabel)}</td>
            <td class="wl-td-room">${escHtml(roomLabel)}</td>
            <td class="wl-td-status">${wlStatusBadge(a)}</td>
            <td class="wl-td-tour">${wlTourBadge(a)}${wlInterestTag(a)}</td>
            <td class="wl-td-parent">${escHtml(a.parent_name)}<br><a href="mailto:${escHtml(a.parent_email)}" class="wl-email-link">${escHtml(a.parent_email)}</a>${a.parent_phone ? `<br><span class="wl-phone">${escHtml(a.parent_phone)}</span>` : ''}</td>
            <td class="wl-td-waiting">${wlDaysWaiting(a.applied_at)}</td>
            <td class="wl-td-actions">
                ${canOffer ? `<button class="btn-wl-offer-quick" data-id="${a.id}" data-name="${escHtml(a.parent_name)}" data-email="${escHtml(a.parent_email)}" data-child="${escHtml(a.child_name)}">Make Offer</button>` : ''}
                ${tourBtn}
                <button class="btn-wl-remove-quick" data-id="${a.id}" data-child="${escHtml(a.child_name)}" title="Permanently remove from the waitlist">🗑 Remove</button>
            </td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div class="table-wrapper">
            <table class="report-table wl-quick-table">
                <thead>
                    <tr>
                        <th class="wl-th" data-col="pos"   style="width:36px">#${sortArrow('pos')}</th>
                        <th class="wl-th" data-col="child" style="width:13%">Child${sortArrow('child')}</th>
                        <th class="wl-th" data-col="start" style="width:108px">Desired Start${sortArrow('start')}</th>
                        <th class="wl-th" data-col="age"   style="width:90px">Age at Start${sortArrow('age')}</th>
                        <th class="wl-th" data-col="room"  style="width:13%">Room${sortArrow('room')}</th>
                        <th class="wl-th" data-col="status" style="width:88px">Status${sortArrow('status')}</th>
                        <th style="width:100px">Tour</th>
                        <th class="wl-th" data-col="parent">Parent / Contact${sortArrow('parent')}</th>
                        <th class="wl-th" data-col="waiting" style="width:90px">Waiting Since${sortArrow('waiting')}</th>
                        <th style="width:190px">Actions</th>
                    </tr>
                </thead>
                <tbody>${rows}</tbody>
            </table>
        </div>`;

    // Sort header clicks
    container.querySelectorAll('.wl-th').forEach(th => {
        th.style.cursor = 'pointer';
        th.addEventListener('click', () => {
            const col = th.dataset.col;
            if (_wlSortCol === col) _wlSortDir *= -1;
            else { _wlSortCol = col; _wlSortDir = 1; }
            renderWaitlistQuickList();
        });
    });

    // Make Offer buttons
    container.querySelectorAll('.btn-wl-offer-quick').forEach(btn => {
        btn.addEventListener('click', () => {
            const modal = document.getElementById('wlOfferModal');
            modal.dataset.appId      = btn.dataset.id;
            modal.dataset.parentName = btn.dataset.name;
            modal.dataset.parentEmail= btn.dataset.email;
            modal.dataset.childName  = btn.dataset.child;
            document.getElementById('wlOfferModalDesc').textContent = `Offering a spot to ${btn.dataset.child} — parent: ${btn.dataset.name} (${btn.dataset.email})`;
            document.getElementById('wlOfferErr').textContent = '';
            document.getElementById('wlOfferSendBtn').disabled = false;
            document.getElementById('wlOfferSendBtn').textContent = 'Send & Email Parent';
            // Pre-fill global links
            fetchGlobalOfferLinks().then(g => {
                const procareEl  = document.getElementById('wlOfferProcare');
                const paperwkEl  = document.getElementById('wlOfferPaperwork');
                if (procareEl && !procareEl.value) procareEl.value = g.procareLink || '';
                if (paperwkEl && !paperwkEl.value) paperwkEl.value = (g.paperworkLinks || []).join(', ');
            }).catch(() => {});
            modal.classList.remove('hidden');
        });
    });

    // Schedule Tour buttons
    container.querySelectorAll('.btn-wl-tour-quick').forEach(btn => {
        btn.addEventListener('click', () => {
            const modal = document.getElementById('wlTourModal');
            modal.dataset.appId = btn.dataset.id;
            document.getElementById('wlTourModalDesc').textContent = `Scheduling a tour for ${btn.dataset.child} (parent: ${btn.dataset.name})`;
            document.getElementById('wlTourDateTime').value = '';
            document.getElementById('wlTourNotes').value = '';
            document.getElementById('wlTourErr').textContent = '';
            modal.classList.remove('hidden');
        });
    });

    // Mark Toured buttons
    container.querySelectorAll('.btn-wl-tour-complete-quick').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id = Number(btn.dataset.id);
            btn.disabled = true;
            try {
                await updateWaitlistTourStatus(id, { tour_status: 'completed', tour_completed_at: new Date().toISOString() });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) { app.tour_status = 'completed'; app.tour_completed_at = new Date().toISOString(); }
                renderWaitlistQuickList();
            } catch (err) { alert('Error: ' + err.message); btn.disabled = false; }
        });
    });

    // Remove buttons — permanently deletes the application (no archive step required)
    container.querySelectorAll('.btn-wl-remove-quick').forEach(btn => {
        btn.addEventListener('click', async () => {
            const id    = Number(btn.dataset.id);
            const child = btn.dataset.child || 'this entry';
            if (!confirm(`Permanently remove ${child} from the waitlist? This cannot be undone.`)) return;
            btn.disabled = true;
            try {
                await deleteWaitlistApplication(id);
                _allWaitlistApps = _allWaitlistApps.filter(a => a.id !== id);
                renderWaitlistQuickList();
            } catch (err) {
                alert('Error: ' + err.message);
                btn.disabled = false;
            }
        });
    });
}

function renderWaitlistAdmin() {
    const statusFilter = document.getElementById('wlStatusFilter').value;
    const roomFilter   = document.getElementById('wlRoomFilter').value;
    const container    = document.getElementById('waitlistAdminContent');
    const today        = new Date().toISOString().split('T')[0];

    let apps = _allWaitlistApps.slice();

    // Status filter
    if (statusFilter === 'active') {
        apps = apps.filter(a => ['pending','offered','accepted'].includes(a.status));
    } else if (statusFilter === 'enrolled') {
        apps = apps.filter(a => a.status === 'enrolled');
    } else if (statusFilter === 'archived') {
        apps = apps.filter(a => ['declined','expired','archived'].includes(a.status));
    }

    // Room filter
    if (roomFilter) {
        apps = apps.filter(a => {
            if (roomFilter === 'tbd') return !a.child_dob && !a.expected_due_date;
            return wlDeriveRoom(a) === roomFilter;
        });
    }

    // Priority sort: sibling first (tier 1 vs 2), then desired_start_date, then applied_at
    apps.sort((a, b) => {
        const sibA = a.has_sibling ? 0 : 1;
        const sibB = b.has_sibling ? 0 : 1;
        if (sibA !== sibB) return sibA - sibB;
        const startA = a.desired_start_date || '';
        const startB = b.desired_start_date || '';
        if (startA !== startB) return startA < startB ? -1 : 1;
        return new Date(a.applied_at) - new Date(b.applied_at);
    });

    document.getElementById('wlCount').textContent = `${apps.length} application${apps.length !== 1 ? 's' : ''}`;

    if (!apps.length) {
        container.innerHTML = '<p class="empty-hint">No applications match the current filter.</p>';
        return;
    }

    const cards = apps.map(app => {
        const room     = wlDeriveRoom(app);
        const isUnborn = !!app.expected_due_date && !app.child_dob;
        const dobInfo  = isUnborn
            ? `Due ${app.expected_due_date}`
            : app.child_dob ? `DOB ${app.child_dob}` : '';
        const daysStr  = (app.days_of_week || '').split(',').filter(Boolean).join(', ');
        const offerExpired = app.status === 'offered' && app.offer_deadline && app.offer_deadline < today;

        const priorityBadges = [
            app.has_sibling ? '<span class="wl-pri-badge wl-sib">👨‍👩‍👧 Sibling</span>' : '',
            isUnborn        ? '<span class="wl-pri-badge wl-prenatal">👶 Prenatal</span>' : '',
            offerExpired    ? '<span class="wl-pri-badge wl-expired-warn">⚠️ Offer Expired</span>' : '',
        ].filter(Boolean).join(' ');

        // Checklist (shown once accepted)
        const checklistHtml = ['accepted','enrolled'].includes(app.status) ? `
            <div class="wl-checklist">
                <label class="wl-check-item">
                    <input type="checkbox" class="wl-paperwork" data-id="${app.id}" ${app.paperwork_received ? 'checked' : ''}>
                    Paperwork received
                </label>
                <label class="wl-check-item">
                    <input type="checkbox" class="wl-deposit" data-id="${app.id}" ${app.deposit_paid ? 'checked' : ''}>
                    Deposit paid
                </label>
                ${(app.paperwork_received && app.deposit_paid && app.status !== 'enrolled') ? `
                    <button class="btn-primary wl-action wl-enroll" data-id="${app.id}" style="margin-left:10px;">✓ Mark Enrolled</button>
                ` : ''}
            </div>` : '';

        // Action buttons
        const actionBtns = (() => {
            const id = app.id;
            if (['declined','expired','archived','enrolled'].includes(app.status)) {
                return `<button class="btn-ghost wl-action wl-unarchive" data-id="${id}">↩ Restore</button>
                        <button class="btn-danger wl-action wl-delete" data-id="${id}" data-child="${escHtml(app.child_name)}">🗑 Delete</button>`;
            }
            const offer = app.status === 'pending' || offerExpired
                ? `<button class="btn-secondary wl-action wl-offer" data-id="${id}">🎉 Offer a Spot</button>`
                : '';
            const accept = app.status === 'offered'
                ? `<button class="btn-secondary wl-action wl-accept" data-id="${id}">✓ Mark Accepted</button>`
                : '';
            const archive = `<button class="btn-ghost wl-action wl-archive" data-id="${id}">Archive ▾</button>`;
            const remove  = `<button class="btn-danger wl-action wl-delete" data-id="${id}" data-child="${escHtml(app.child_name)}" title="Permanently remove without archiving">🗑 Remove</button>`;
            return [offer, accept, archive, remove].filter(Boolean).join(' ');
        })();

        // Offer details row
        const offerRow = app.status === 'offered' && app.offer_deadline ? `
            <div class="wl-offer-row">
                Spot offered ${app.offered_at ? new Date(app.offered_at).toLocaleDateString() : ''}
                · Deadline: <strong>${app.offer_deadline}</strong>
                ${app.offer_notes ? `· <em>${escHtml(app.offer_notes)}</em>` : ''}
            </div>` : '';

        return `
        <div class="wl-card" data-id="${app.id}">
            <div class="wl-card-header">
                <div class="wl-card-title">
                    <strong>${escHtml(app.child_name)}</strong>
                    ${dobInfo ? `<span class="wl-dob">${escHtml(dobInfo)}</span>` : ''}
                    ${room ? `<span class="wl-room">${wlRoomLabel(room)}</span>` : '<span class="wl-room">Room TBD</span>'}
                    ${priorityBadges}
                </div>
                <div class="wl-card-status">${wlStatusBadge(app)}</div>
            </div>
            <div class="wl-card-body">
                <div class="wl-detail-row">
                    <span class="wl-detail-label">Start:</span>
                    ${escHtml(app.desired_start_date)} <em class="wl-flex">(${wlFlexLabel(app.start_flexibility)})</em>
                </div>
                <div class="wl-detail-row">
                    <span class="wl-detail-label">Days:</span>
                    ${escHtml(daysStr)} · ${app.day_type === 'half' ? 'Half Day' : 'Full Day'}
                </div>
                <div class="wl-detail-row">
                    <span class="wl-detail-label">Parent:</span>
                    ${escHtml(app.parent_name)}
                    · <a href="mailto:${escHtml(app.parent_email)}">${escHtml(app.parent_email)}</a>
                    ${app.parent_phone ? `· ${escHtml(app.parent_phone)}` : ''}
                </div>
                ${app.has_sibling ? `<div class="wl-detail-row"><span class="wl-detail-label">Sibling:</span> ${escHtml(app.sibling_child_name || '—')} ${app.sibling_room_id ? `(${wlRoomLabel(app.sibling_room_id)})` : ''}</div>` : ''}
                ${app.notes ? `<div class="wl-detail-row"><span class="wl-detail-label">Notes:</span> <em>${escHtml(app.notes)}</em></div>` : ''}
                <div class="wl-detail-row wl-applied">Applied ${wlDaysWaiting(app.applied_at)} (${new Date(app.applied_at).toLocaleDateString()})</div>
            </div>
            ${offerRow}
            ${checklistHtml}
            <div class="wl-card-actions">${actionBtns}</div>

            <!-- Offer form (hidden by default) -->
            <div class="wl-offer-form hidden" id="wl-offer-form-${app.id}">
                <div class="wl-offer-fields">
                    <label>Offer deadline: <input type="date" class="wl-deadline-input" id="wl-deadline-${app.id}"
                        value="${new Date(Date.now() + 14*86400000).toISOString().split('T')[0]}"></label>
                    <label style="flex:1">Notes (optional): <input type="text" class="wl-notes-input" id="wl-ofnotes-${app.id}" placeholder="e.g. Bear room opening Sept 1"></label>
                </div>
                <div class="wl-offer-fields" style="margin-top:8px;">
                    <label style="flex:1">Paperwork link(s) (optional, comma-separated URLs):
                        <input type="text" class="wl-paperwork-links" id="wl-paperwk-${app.id}" placeholder="https://docs.google.com/..."></label>
                    <label style="flex:1">Procare enrollment link (optional):
                        <input type="text" class="wl-procare-link" id="wl-procare-${app.id}" placeholder="https://app.procaresoftware.com/..."></label>
                </div>
                <div class="wl-offer-fields" style="margin-top:8px;">
                    <button class="btn-primary wl-offer-send" data-id="${app.id}" data-name="${escHtml(app.parent_name)}" data-email="${escHtml(app.parent_email)}" data-child="${escHtml(app.child_name)}">🎉 Send Spot Offer</button>
                    <button class="btn-ghost wl-offer-cancel" data-id="${app.id}">Cancel</button>
                </div>
            </div>

            <!-- Archive dropdown (hidden by default) -->
            <div class="wl-archive-form hidden" id="wl-archive-form-${app.id}">
                <div class="wl-offer-fields">
                    <span>Archive reason:</span>
                    <select id="wl-archive-reason-${app.id}">
                        <option value="declined">Family declined</option>
                        <option value="no_response">No response to offer</option>
                        <option value="enrolled_elsewhere">Enrolled elsewhere</option>
                        <option value="other">Other</option>
                    </select>
                    <button class="btn-warning wl-archive-confirm" data-id="${app.id}">Archive</button>
                    <button class="btn-ghost wl-archive-cancel" data-id="${app.id}">Cancel</button>
                </div>
            </div>
        </div>`;
    }).join('');

    container.innerHTML = `<div class="wl-list">${cards}</div>`;

    // Wire up all event handlers
    container.querySelectorAll('.wl-offer').forEach(btn =>
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            const g = window._globalOfferLinks || {};
            const procareEl   = document.getElementById(`wl-procare-${id}`);
            const paperwkEl   = document.getElementById(`wl-paperwk-${id}`);
            if (procareEl && !procareEl.value)   procareEl.value   = g.procareLink   || '';
            if (paperwkEl && !paperwkEl.value)   paperwkEl.value   = (g.paperworkLinks || []).join(', ');
            document.getElementById(`wl-offer-form-${id}`)?.classList.remove('hidden');
        }));

    container.querySelectorAll('.wl-offer-cancel').forEach(btn =>
        btn.addEventListener('click', () => {
            document.getElementById(`wl-offer-form-${btn.dataset.id}`)?.classList.add('hidden');
        }));

    container.querySelectorAll('.wl-offer-send').forEach(btn =>
        btn.addEventListener('click', async () => {
            const id          = btn.dataset.id;
            const deadline    = document.getElementById(`wl-deadline-${id}`)?.value;
            const notes       = document.getElementById(`wl-ofnotes-${id}`)?.value || '';
            const parentName  = btn.dataset.name;
            const parentEmail = btn.dataset.email;
            const childName   = btn.dataset.child;
            const paperwkRaw  = document.getElementById(`wl-paperwk-${id}`)?.value || '';
            const procareLink = document.getElementById(`wl-procare-${id}`)?.value.trim() || null;
            const papeworkLinks = paperwkRaw.split(',').map(s => s.trim()).filter(Boolean);
            if (!deadline) { alert('Please set an offer deadline.'); return; }
            btn.disabled    = true;
            btn.textContent = 'Sending…';
            try {
                // Save status first
                await updateWaitlistApplication(Number(id), {
                    status:         'offered',
                    offered_at:     new Date().toISOString(),
                    offer_deadline: deadline,
                    offer_notes:    notes || null,
                });
                // Send email
                await sendWaitlistOfferEmail({ parentName, parentEmail, childName, offerDeadline: deadline, offerNotes: notes || null, papeworkLinks, procareLink });
                const app = _allWaitlistApps.find(a => a.id === Number(id));
                if (app) { app.status = 'offered'; app.offered_at = new Date().toISOString(); app.offer_deadline = deadline; app.offer_notes = notes || null; }
                renderWaitlistAdmin();
            } catch (err) {
                // If only the email failed, status was already saved — note this in the alert
                let detail = err.message;
                try { const ctx = await err.context?.json(); detail += '\n' + JSON.stringify(ctx); } catch {}
                console.error('Email error full detail:', err);
                alert('Offer saved, but email failed: ' + detail + '\n\nYou can email the parent manually at ' + parentEmail);
                const app = _allWaitlistApps.find(a => a.id === Number(id));
                if (app && app.status !== 'offered') { btn.disabled = false; btn.textContent = 'Send & Email Parent'; }
                else renderWaitlistAdmin();
            }
        }));

    container.querySelectorAll('.wl-accept').forEach(btn =>
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                const id = Number(btn.dataset.id);
                await updateWaitlistApplication(id, { status: 'accepted' });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) app.status = 'accepted';
                renderWaitlistAdmin();
            } catch (err) { alert('Error: ' + err.message); btn.disabled = false; }
        }));

    container.querySelectorAll('.wl-enroll').forEach(btn =>
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                const id = Number(btn.dataset.id);
                await updateWaitlistApplication(id, { status: 'enrolled' });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) app.status = 'enrolled';
                renderWaitlistAdmin();
            } catch (err) { alert('Error: ' + err.message); btn.disabled = false; }
        }));

    container.querySelectorAll('.wl-paperwork').forEach(cb =>
        cb.addEventListener('change', async () => {
            const id = Number(cb.dataset.id);
            try {
                await updateWaitlistApplication(id, { paperwork_received: cb.checked });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) app.paperwork_received = cb.checked;
                renderWaitlistAdmin();
            } catch (err) { alert('Error: ' + err.message); cb.checked = !cb.checked; }
        }));

    container.querySelectorAll('.wl-deposit').forEach(cb =>
        cb.addEventListener('change', async () => {
            const id = Number(cb.dataset.id);
            try {
                await updateWaitlistApplication(id, { deposit_paid: cb.checked });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) app.deposit_paid = cb.checked;
                renderWaitlistAdmin();
            } catch (err) { alert('Error: ' + err.message); cb.checked = !cb.checked; }
        }));

    container.querySelectorAll('.wl-archive').forEach(btn =>
        btn.addEventListener('click', () => {
            const id = btn.dataset.id;
            document.getElementById(`wl-archive-form-${id}`)?.classList.remove('hidden');
        }));

    container.querySelectorAll('.wl-archive-cancel').forEach(btn =>
        btn.addEventListener('click', () => {
            document.getElementById(`wl-archive-form-${btn.dataset.id}`)?.classList.add('hidden');
        }));

    container.querySelectorAll('.wl-archive-confirm').forEach(btn =>
        btn.addEventListener('click', async () => {
            const id     = Number(btn.dataset.id);
            const reason = document.getElementById(`wl-archive-reason-${id}`)?.value || 'other';
            btn.disabled = true;
            try {
                await updateWaitlistApplication(id, {
                    status:         'archived',
                    archive_reason: reason,
                    archived_at:    new Date().toISOString(),
                });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) { app.status = 'archived'; app.archive_reason = reason; }
                renderWaitlistAdmin();
            } catch (err) { alert('Error: ' + err.message); btn.disabled = false; }
        }));

    container.querySelectorAll('.wl-unarchive').forEach(btn =>
        btn.addEventListener('click', async () => {
            btn.disabled = true;
            try {
                const id = Number(btn.dataset.id);
                await updateWaitlistApplication(id, { status: 'pending', archived_at: null, archive_reason: null });
                const app = _allWaitlistApps.find(a => a.id === id);
                if (app) { app.status = 'pending'; app.archived_at = null; app.archive_reason = null; }
                renderWaitlistAdmin();
            } catch (err) { alert('Error: ' + err.message); btn.disabled = false; }
        }));

    container.querySelectorAll('.wl-delete').forEach(btn =>
        btn.addEventListener('click', async () => {
            const id    = Number(btn.dataset.id);
            const child = btn.dataset.child || 'this entry';
            if (!confirm(`Permanently delete the waitlist entry for ${child}? This cannot be undone.`)) return;
            btn.disabled = true;
            try {
                await deleteWaitlistApplication(id);
                _allWaitlistApps = _allWaitlistApps.filter(a => a.id !== id);
                renderWaitlistAdmin();
            } catch (err) { alert('Error: ' + err.message); btn.disabled = false; }
        }));
}

// ============================================================
// WAITLIST PLANNING PANEL
// ============================================================
async function renderWaitlistPlanning() {
    const container = document.getElementById('wlPlanContent');
    if (!container) return;
    container.innerHTML = '<p class="empty-hint">Loading…</p>';

    // Show next 4 months starting from current month
    const today = new Date();
    const months = Array.from({ length: 4 }, (_, i) => {
        const d = new Date(today.getFullYear(), today.getMonth() + i, 1);
        return { year: d.getFullYear(), month: d.getMonth(), key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`, label: MONTH_NAMES[d.getMonth()] + ' ' + d.getFullYear() };
    });

    // Shares _buildTrendMap()/_trendCell() with Enrollment Trends (Reports tab)
    // so the two never disagree about what "typical" enrollment looks like —
    // previously this section computed its own average from a different,
    // possibly-stale cached registrations list, and used a different
    // denominator (all weekdays in the month vs. only days with bookings),
    // so the two reports showed different numbers for the same room/month.
    let trendMap;
    try {
        trendMap = await _buildTrendMap();
    } catch (err) {
        container.innerHTML = `<p class="import-error">Error loading planning data: ${escHtml(err.message)}</p>`;
        return;
    }

    // Aging-out: for each enrolled child, calculate when they graduate to next room
    // Bear → Bee at 12mo, Bee → Turtle at 24mo, Turtle → Owl at 36mo, Owl → out at 60mo
    const ageOutThresholds = { bear: 12, bee: 24, turtle: 36, owl: 60 };
    const agingOut = {}; // 'YYYY-MM' → { roomId: [childName, ...] }
    const seenChildren = new Set();
    allRegistrations.forEach(reg => {
        if (!reg.child_dob || !reg.room_id || !ageOutThresholds[reg.room_id]) return;
        const key = `${reg.child_name}:${reg.room_id}`;
        if (seenChildren.has(key)) return;
        seenChildren.add(key);
        const dob        = new Date(reg.child_dob);
        const monthsOld  = ageOutThresholds[reg.room_id];
        const graduates  = new Date(dob.getFullYear(), dob.getMonth() + monthsOld, 1);
        const gradKey    = `${graduates.getFullYear()}-${String(graduates.getMonth()+1).padStart(2,'0')}`;
        if (!agingOut[gradKey]) agingOut[gradKey] = {};
        if (!agingOut[gradKey][reg.room_id]) agingOut[gradKey][reg.room_id] = [];
        agingOut[gradKey][reg.room_id].push(reg.child_name);
    });

    // Build the planning grid
    const waitlistByRoom = {};
    (_allWaitlistApps || []).filter(a => ['pending','offered','accepted'].includes(a.status)).forEach(a => {
        const rid = a.sibling_room_id || 'tbd';
        if (!waitlistByRoom[rid]) waitlistByRoom[rid] = [];
        waitlistByRoom[rid].push(a);
    });

    // Families submit a month's schedule by the 15th of the month before it starts,
    // with a few days' buffer for late changes/admin cleanup — so a given month's
    // registrations aren't dependable ("final") until we're 20+ days into the month
    // before it. Right now that means: the current month is already final (its own
    // window closed last month), and the very next month only becomes final once
    // we're 20+ days into the current month. Uses the same cutoff as Enrollment
    // Trends' _isTrendMonthComplete so the two reports agree.
    const WEEKDAY_INIT = { 1: 'M', 2: 'T', 3: 'W', 4: 'Th', 5: 'F' };
    const DOW_TO_TRENDDAY = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri' };
    function isMonthFinal(year, month0) {
        return _isTrendMonthComplete(`${year}-${String(month0 + 1).padStart(2, '0')}`, false, today);
    }

    // A specific finalized month's own actual weekday pattern.
    function actualWeekdayPattern(roomId, moKey) {
        const avg = {};
        [1, 2, 3, 4, 5].forEach(dow => {
            const c = _trendCell(trendMap[moKey] || {}, roomId, DOW_TO_TRENDDAY[dow]);
            const count = c.dates.size;
            avg[dow] = count ? (c.halfSum + c.fullSum) / count : 0;
        });
        return avg;
    }

    // For months whose own registrations haven't closed/stabilized yet, project
    // using what's typical for the past few finalized months (blended), rather
    // than any single month's snapshot.
    const RECENT_MONTHS_FOR_TYPICAL = 3;
    function typicalBlendedPattern(roomId, throughMoKey) {
        const [ty, tm] = throughMoKey.split('-').map(Number);
        const avg = {};
        [1, 2, 3, 4, 5].forEach(dow => {
            let halfSum = 0, fullSum = 0, dateCount = 0;
            for (let i = 0; i < RECENT_MONTHS_FOR_TYPICAL; i++) {
                const d = new Date(ty, tm - 1 - i, 1);
                const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
                const c = _trendCell(trendMap[k] || {}, roomId, DOW_TO_TRENDDAY[dow]);
                halfSum += c.halfSum;
                fullSum += c.fullSum;
                dateCount += c.dates.size;
            }
            avg[dow] = dateCount ? (halfSum + fullSum) / dateCount : 0;
        });
        return avg;
    }

    // Latest month in the displayed window whose data is finalized — the base
    // that projected months blend backward from.
    let lastFinalMoKey = months[0].key;
    months.forEach(({ year, month, key }) => {
        if (isMonthFinal(year, month)) lastFinalMoKey = key;
    });

    const roomRows = ROOMS.filter(r => r.id !== 'summer').map(room => {
        const waitlistCount = (waitlistByRoom[room.id] || []).length;
        const blendedPattern = typicalBlendedPattern(room.id, lastFinalMoKey);

        const monthCells = months.map(({ key, year, month }) => {
            const isFinal  = isMonthFinal(year, month);
            const pattern  = isFinal ? actualWeekdayPattern(room.id, key) : blendedPattern;

            const weekdayChips = [1, 2, 3, 4, 5].map(dow => {
                const avgBooked = pattern[dow];
                let avgOpen = Math.max(0, room.capacity - avgBooked);
                // Projected months: net out kids already on the waitlist for this
                // room — they'd fill these slots before any new family would, so
                // this reflects what's truly available to offer someone new.
                if (!isFinal) avgOpen = Math.max(0, avgOpen - waitlistCount);
                avgOpen = avgOpen.toFixed(1);
                const pct       = room.capacity > 0 ? avgBooked / room.capacity : 0;
                const color     = pct >= 0.9 ? '#fff5f5' : pct >= 0.7 ? '#fffaf0' : '#f0fff4';
                const textColor = pct >= 0.9 ? '#9b2c2c' : pct >= 0.7 ? '#b45309' : '#276749';
                return `<div style="background:${color};color:${textColor};border-radius:4px;padding:3px 2px;text-align:center;min-width:26px">
                    <div style="font-size:.7em;font-weight:600">${WEEKDAY_INIT[dow]}</div>
                    <div style="font-size:.82em;font-weight:700">${avgOpen}</div>
                </div>`;
            }).join('');

            // Aging-out events this month
            const outs    = (agingOut[key]?.[room.id] || []);
            const outHtml = outs.length ? `<div style="font-size:.75em;color:#667eea;margin-top:4px">→ ${outs.length} graduate${outs.length>1?'s':''} out</div>` : '';
            const projectedNote = isFinal
                ? ''
                : '<div style="font-size:.7em;color:#aaa;margin-top:3px">(projected)</div>';

            return `<td style="text-align:center;padding:8px 6px;white-space:nowrap">
                <div style="display:flex;gap:3px;justify-content:center">${weekdayChips}</div>
                ${outHtml}${projectedNote}
            </td>`;
        }).join('');

        const wl = (waitlistByRoom[room.id] || []).slice(0,5);
        const wlHtml = wl.length
            ? wl.map(a => `<div style="font-size:.8em;color:#555;padding:2px 0">${escHtml(a.child_name)} <span style="color:#aaa">(${a.desired_start_date || '?'})</span></div>`).join('')
            : '<div style="font-size:.8em;color:#aaa">No waitlist</div>';

        return `<tr>
            <td style="font-weight:600;white-space:nowrap;padding:8px 10px">${room.label}<br><span style="font-weight:400;font-size:.8em;color:#888">Cap ${room.capacity}/day</span></td>
            ${monthCells}
            <td style="padding:8px 10px;max-width:200px">${wlHtml}</td>
        </tr>`;
    }).join('');

    container.innerHTML = `
        <div style="overflow-x:auto">
        <table class="report-table" style="min-width:1080px">
            <thead><tr>
                <th>Room</th>
                ${months.map(m => `<th style="text-align:center">${m.label}</th>`).join('')}
                <th>Waitlisted (next up)</th>
            </tr></thead>
            <tbody>${roomRows}</tbody>
        </table></div>
        <p style="font-size:.8em;color:#888;margin-top:8px">Each weekday chip shows avg open slots for that day (M/T/W/Th/F). Months already finalized (registrations lock in on the 15th of the prior month) show their own actual bookings; months marked "projected" show what's typical for the past few finalized months, minus kids already on that room's waitlist. → Graduates = children aging out of this room that month, freeing a permanent spot.</p>`;
}

// ============================================================
// WAITLIST IMPORT
// ============================================================
async function previewWaitlistImport() {
    const fileInput = document.getElementById('wlImportFile');
    const preview   = document.getElementById('wlImportPreview');
    if (!fileInput?.files?.length) { preview.innerHTML = '<p class="import-error">Please choose a file first.</p>'; return; }

    const file = fileInput.files[0];
    let rows;
    try {
        rows = await parseUploadedFile(file);
    } catch (err) {
        preview.innerHTML = `<p class="import-error">Could not read file: ${escHtml(err.message)}</p>`;
        return;
    }

    if (!rows.length) { preview.innerHTML = '<p class="import-error">No data rows found in file.</p>'; return; }

    // Detect columns (case-insensitive fuzzy match)
    const headers  = Object.keys(rows[0]).map(h => h.trim());
    const col = (keywords) => headers.find(h => keywords.some(k => h.toLowerCase().includes(k))) || null;

    const colParent  = col(['parent name','guardian name','parent']);
    const colEmail   = col(['email','e-mail']);
    const colPhone   = col(['phone','cell','mobile']);
    const colChild   = col(['child name','student name','child first','first name']);
    const colDob     = col(['dob','birth date','birthdate','date of birth','birthday']);
    const colStart   = col(['start date','desired start','start']);
    const colDays    = col(['days requested','days of week','days','weekdays']);
    const colType    = col(['day type','full or half','half or full','type']);
    const colNotes   = col(['notes','comments','note']);

    if (!colParent || !colEmail || !colChild) {
        preview.innerHTML = `<p class="import-error">Missing required columns. Need at least: Parent Name, Email, Child Name. Detected columns: ${escHtml(headers.join(', '))}</p>`;
        return;
    }

    // Normalize rows into waitlist records
    const records = rows.map(r => {
        const parentName  = (r[colParent] || '').trim();
        const parentEmail = (r[colEmail]  || '').trim().toLowerCase();
        const parentPhone = colPhone  ? (r[colPhone]  || '').trim() : '';
        const childName   = (r[colChild]  || '').trim();
        const childDob    = colDob    ? _normDateStr(r[colDob])   : null;
        const startDate   = colStart  ? _normDateStr(r[colStart]) : null;
        const daysOfWeek  = colDays   ? (r[colDays]  || '').trim() : '';
        const dayType     = colType   ? ((r[colType] || '').toLowerCase().includes('half') ? 'half' : 'full') : 'full';
        const notes       = colNotes  ? (r[colNotes] || '').trim() : '';
        return { parentName, parentEmail, parentPhone, childName, childDob, startDate, daysOfWeek, dayType, notes };
    }).filter(r => r.parentName && r.parentEmail && r.childName);

    if (!records.length) { preview.innerHTML = '<p class="import-error">No valid rows after normalization.</p>'; return; }

    preview.innerHTML = `
        <p style="margin-bottom:8px;font-size:.9em;color:#555">${records.length} record(s) ready to import. Review below, then click <strong>Import</strong>.</p>
        <div style="overflow-x:auto;margin-bottom:12px">
        <table class="report-table" style="font-size:.82em">
            <thead><tr>
                <th>Parent</th><th>Email</th><th>Child</th><th>Child DOB</th>
                <th>Desired Start</th><th>Days</th><th>Type</th><th>Notes</th>
            </tr></thead>
            <tbody>
                ${records.map(r => `<tr>
                    <td>${escHtml(r.parentName)}</td>
                    <td>${escHtml(r.parentEmail)}</td>
                    <td>${escHtml(r.childName)}</td>
                    <td>${r.childDob || '—'}</td>
                    <td>${r.startDate || '—'}</td>
                    <td>${escHtml(r.daysOfWeek) || '—'}</td>
                    <td>${r.dayType}</td>
                    <td>${escHtml(r.notes) || '—'}</td>
                </tr>`).join('')}
            </tbody>
        </table></div>
        <button id="wlImportConfirmBtn" class="btn-primary">Import ${records.length} Record(s)</button>
        <span id="wlImportStatus" style="margin-left:12px;font-size:.88em;color:#555"></span>`;

    document.getElementById('wlImportConfirmBtn').addEventListener('click', async () => {
        const btn    = document.getElementById('wlImportConfirmBtn');
        const status = document.getElementById('wlImportStatus');
        btn.disabled = true; btn.textContent = 'Importing…';
        let imported = 0, failed = 0;
        for (const r of records) {
            try {
                await submitWaitlistApplication({
                    parent_name:          r.parentName,
                    parent_email:         r.parentEmail,
                    parent_phone:         r.parentPhone || null,
                    child_name:           r.childName,
                    child_dob:            r.childDob || null,
                    desired_start_date:   r.startDate || new Date().toISOString().split('T')[0],
                    days_of_week:         r.daysOfWeek || null,
                    day_type:             r.dayType,
                    notes:                r.notes || null,
                    status:               'pending',
                });
                imported++;
            } catch { failed++; }
        }
        status.textContent = `✓ ${imported} imported${failed ? `, ${failed} failed` : ''}`;
        btn.textContent = 'Done';
        if (imported > 0) await loadWaitlistApplications();
    });
}

function _normDateStr(val) {
    if (!val) return null;
    const s = String(val).trim();
    // Already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
    // MM/DD/YYYY or M/D/YYYY
    const mdy = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mdy) return `${mdy[3]}-${mdy[1].padStart(2,'0')}-${mdy[2].padStart(2,'0')}`;
    // Try native parse
    const d = new Date(s);
    if (!isNaN(d)) return d.toLocaleDateString('en-CA');
    return null;
}

function setupWaitlistAdmin() {
    document.getElementById('refreshWaitlistBtn')?.addEventListener('click', loadWaitlistApplications);
    document.getElementById('wlSearchInput')?.addEventListener('input', renderWaitlistQuickList);
    document.getElementById('wlStatusFilter')?.addEventListener('change', () => { renderWaitlistAdmin(); renderWaitlistQuickList(); });
    document.getElementById('wlRoomFilter')?.addEventListener('change', () => { renderWaitlistAdmin(); renderWaitlistQuickList(); });

    setupWaitlistNotifications();

    // Tour modal
    document.getElementById('wlTourCancelBtn')?.addEventListener('click', () => document.getElementById('wlTourModal').classList.add('hidden'));
    document.getElementById('wlTourModal')?.addEventListener('click', e => { if (e.target === document.getElementById('wlTourModal')) document.getElementById('wlTourModal').classList.add('hidden'); });
    document.getElementById('wlTourSaveBtn')?.addEventListener('click', async () => {
        const modal    = document.getElementById('wlTourModal');
        const id       = Number(modal.dataset.appId);
        const dateTime = document.getElementById('wlTourDateTime').value;
        const notes    = document.getElementById('wlTourNotes').value.trim() || null;
        const errEl    = document.getElementById('wlTourErr');
        if (!dateTime) { errEl.textContent = 'Please choose a tour date and time.'; return; }
        const btn = document.getElementById('wlTourSaveBtn');
        btn.disabled = true; btn.textContent = 'Saving…'; errEl.textContent = '';
        try {
            const iso = new Date(dateTime).toISOString();
            await updateWaitlistTourStatus(id, { tour_status: 'scheduled', tour_scheduled_at: iso, tour_notes: notes });
            const app = _allWaitlistApps.find(a => a.id === id);
            if (app) { app.tour_status = 'scheduled'; app.tour_scheduled_at = iso; app.tour_notes = notes; }
            modal.classList.add('hidden');
            renderWaitlistQuickList();
            renderWaitlistAdmin();
        } catch (err) {
            errEl.textContent = 'Error: ' + err.message;
        } finally {
            btn.disabled = false; btn.textContent = 'Save Tour';
        }
    });

    // Offer modal
    document.getElementById('wlOfferCancelBtn')?.addEventListener('click', () => document.getElementById('wlOfferModal').classList.add('hidden'));
    document.getElementById('wlOfferModal')?.addEventListener('click', e => { if (e.target === document.getElementById('wlOfferModal')) document.getElementById('wlOfferModal').classList.add('hidden'); });
    document.getElementById('wlOfferSendBtn')?.addEventListener('click', async () => {
        const modal     = document.getElementById('wlOfferModal');
        const id        = Number(modal.dataset.appId);
        const deadline  = document.getElementById('wlOfferDeadline').value;
        const notes     = document.getElementById('wlOfferNotes').value || '';
        const procareLink   = document.getElementById('wlOfferProcare').value.trim() || null;
        const paperwkRaw    = document.getElementById('wlOfferPaperwork').value || '';
        const papeworkLinks = paperwkRaw.split(',').map(s => s.trim()).filter(Boolean);
        const parentName    = modal.dataset.parentName;
        const parentEmail   = modal.dataset.parentEmail;
        const childName     = modal.dataset.childName;
        const errEl = document.getElementById('wlOfferErr');
        if (!deadline) { errEl.textContent = 'Please set an offer deadline.'; return; }
        const btn = document.getElementById('wlOfferSendBtn');
        btn.disabled = true; btn.textContent = 'Sending…'; errEl.textContent = '';
        try {
            await updateWaitlistApplication(id, { status: 'offered', offered_at: new Date().toISOString(), offer_deadline: deadline, offer_notes: notes || null });
            await sendWaitlistOfferEmail({ parentName, parentEmail, childName, offerDeadline: deadline, offerNotes: notes || null, papeworkLinks, procareLink });
            const app = _allWaitlistApps.find(a => a.id === id);
            if (app) { app.status = 'offered'; app.offered_at = new Date().toISOString(); app.offer_deadline = deadline; app.offer_notes = notes || null; }
            modal.classList.add('hidden');
            document.getElementById('wlOfferDeadline').value = '';
            document.getElementById('wlOfferNotes').value = '';
            renderWaitlistQuickList();
            renderWaitlistAdmin();
        } catch (err) {
            errEl.textContent = 'Offer saved, but email failed: ' + err.message + '. Email parent manually at ' + parentEmail;
            btn.disabled = false; btn.textContent = 'Send & Email Parent';
            const app = _allWaitlistApps.find(a => a.id === id);
            if (app) { app.status = 'offered'; renderWaitlistQuickList(); renderWaitlistAdmin(); }
        }
    });
    document.getElementById('addToWaitlistBtn')?.addEventListener('click', _openAdminWlModal);
    document.getElementById('generateWaitlistBtn')?.addEventListener('click', generateWaitlistReport);
    document.getElementById('generateWlPlanBtn')?.addEventListener('click', renderWaitlistPlanning);
    initEnrollmentPlannerSelectors();

    // Waitlist import
    document.getElementById('wlImportParseBtn')?.addEventListener('click', previewWaitlistImport);

    // Modal controls
    document.getElementById('adminWlCancelBtn')?.addEventListener('click', _closeAdminWlModal);
    document.getElementById('adminWlSubmitBtn')?.addEventListener('click', _submitAdminWlEntry);
    document.getElementById('adminWlOverlay')?.addEventListener('click', e => {
        if (e.target === document.getElementById('adminWlOverlay')) _closeAdminWlModal();
    });
    document.getElementById('adminWlIsUnborn')?.addEventListener('change', e => {
        document.getElementById('adminWlDobRow').classList.toggle('hidden',  e.target.checked);
        document.getElementById('adminWlDueRow').classList.toggle('hidden', !e.target.checked);
    });
    document.getElementById('adminWlHasSibling')?.addEventListener('change', e => {
        document.getElementById('adminWlSibRow').classList.toggle('hidden', !e.target.checked);
    });
}

// ============================================================
// WAITLIST NOTIFICATIONS  (shareable inquiry link + notify email)
// ============================================================
async function setupWaitlistNotifications() {
    const linkEl = document.getElementById('wlInquiryLink');
    if (linkEl) linkEl.value = `${window.location.origin}/inquiry`;

    document.getElementById('wlCopyInquiryLinkBtn')?.addEventListener('click', async () => {
        const btn = document.getElementById('wlCopyInquiryLinkBtn');
        try {
            await navigator.clipboard.writeText(linkEl.value);
            const orig = btn.textContent;
            btn.textContent = '✓ Copied!';
            setTimeout(() => { btn.textContent = orig; }, 2000);
        } catch (_) {
            linkEl.select();
            document.execCommand('copy');
        }
    });

    const emailEl = document.getElementById('wlNotifyEmail');
    try {
        const settings = await loadWaitlistNotifySettings();
        if (emailEl) emailEl.value = settings.notifyEmail || '';
    } catch (_) {}

    document.getElementById('wlSaveNotifyEmailBtn')?.addEventListener('click', async () => {
        const btn      = document.getElementById('wlSaveNotifyEmailBtn');
        const statusEl = document.getElementById('wlNotifyEmailStatus');
        btn.disabled = true; btn.textContent = 'Saving…';
        try {
            await saveWaitlistNotifySettings({ notifyEmail: emailEl.value.trim() || null });
            if (statusEl) {
                statusEl.textContent = '✓ Saved!';
                statusEl.style.color = '#2e7d32';
                setTimeout(() => { statusEl.textContent = ''; }, 3000);
            }
        } catch (err) {
            if (statusEl) { statusEl.textContent = '⚠️ ' + err.message; statusEl.style.color = '#c62828'; }
        } finally {
            btn.disabled = false; btn.textContent = '💾 Save';
        }
    });
}

function _openAdminWlModal() {
    document.getElementById('adminWlForm').reset();
    document.getElementById('adminWlDobRow').classList.remove('hidden');
    document.getElementById('adminWlDueRow').classList.add('hidden');
    document.getElementById('adminWlSibRow').classList.add('hidden');
    document.getElementById('adminWlErr').textContent = '';
    document.getElementById('adminWlSubmitBtn').disabled = false;
    document.getElementById('adminWlSubmitBtn').textContent = 'Add to Waitlist';
    document.getElementById('adminWlOverlay').classList.remove('hidden');
    document.getElementById('adminWlParentName').focus();
}

function _closeAdminWlModal() {
    document.getElementById('adminWlOverlay').classList.add('hidden');
}

async function _submitAdminWlEntry() {
    const err = document.getElementById('adminWlErr');
    err.textContent = '';

    const unborn   = document.getElementById('adminWlIsUnborn').checked;
    const hasSib   = document.getElementById('adminWlHasSibling').checked;
    const days     = [...document.querySelectorAll('#adminWlForm .adminWlDay:checked')].map(c => c.value);
    const dayType  = document.querySelector('#adminWlForm input[name="adminWlDayType"]:checked')?.value || 'full';

    const payload = {
        parent_name:        document.getElementById('adminWlParentName').value.trim(),
        parent_email:       document.getElementById('adminWlParentEmail').value.trim(),
        parent_phone:       document.getElementById('adminWlParentPhone').value.trim() || null,
        child_name:         document.getElementById('adminWlChildName').value.trim(),
        child_dob:          !unborn ? (document.getElementById('adminWlDob').value || null) : null,
        expected_due_date:  unborn  ? (document.getElementById('adminWlDueDate').value || null) : null,
        desired_start_date: document.getElementById('adminWlStartDate').value,
        start_flexibility:  document.getElementById('adminWlFlexibility').value,
        days_of_week:       days.length ? days.join(', ') : null,
        day_type:           dayType,
        has_sibling:        hasSib,
        sibling_child_name: hasSib ? (document.getElementById('adminWlSibName').value.trim() || null) : null,
        sibling_room_id:    hasSib ? (document.getElementById('adminWlSibRoom').value || null) : null,
        notes:              document.getElementById('adminWlNotes').value.trim() || null,
        status:             'pending',
    };

    if (!payload.parent_name || !payload.parent_email || !payload.child_name || !payload.desired_start_date) {
        err.textContent = 'Please fill in the required fields: parent name, email, child name, and desired start date.';
        return;
    }

    const btn = document.getElementById('adminWlSubmitBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        await submitWaitlistApplication(payload);
        _closeAdminWlModal();
        await loadWaitlistApplications();
    } catch (e) {
        err.textContent = 'Error: ' + e.message;
        btn.disabled = false; btn.textContent = 'Add to Waitlist';
    }
}

// ============================================================
