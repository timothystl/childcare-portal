// ============================================================
// staff-credentials — CPR/first-aid and TB test records
// ============================================================
// The Account tab's "Your details and training" screen, asked for directly
// 2026-09-02: let staff upload their own certification documents, and track
// the center's biannual TB tests the same way. Reads slStaffId/slPin/slToast
// from staff-log.js; loaded after it in scripts/build.js for that reason.
//
// One row per credential TYPE in the summary — the latest record on file,
// read from staff_list_credentials(), which itself reads every row this
// staff member has ever logged (see add_staff_credentials.sql). The office
// gets the same "latest per type" view for every staff member in HR &
// Handbook → Credentials (admin-safety.js), so the two screens can't
// disagree about what "current" means.

// Suggested validity is a UI convenience only — the actual expiry date is
// always typed in and can be changed. TB test "biannual" is read as every 6
// months (the common non-technical meaning); CPR/first-aid cards are
// typically good 2 years. Neither is enforced server-side, since a
// certifying body's real expiry can differ from either default.
const SC_TYPES = [
    { key: 'cpr_first_aid', label: 'CPR / First Aid', validityMonths: 24 },
    { key: 'tb_test',       label: 'TB Test',          validityMonths: 6 },
];

let scData = [];
let scLoaded = false;
let scPendingDoc = null;   // { dataUrl, name } for the sheet currently open

function scEl(id) { return document.getElementById(id); }

// ── Load + render the summary ──────────────────────────────

async function slOpenAccountTab() {
    if (scLoaded) return;   // same lazy-once rule as Messages — a stale list
                             // here is low-stakes, and re-fetching every tap
                             // of the Account tab is not worth a round trip.
    scLoaded = true;
    await scLoad();
}

async function scLoad() {
    const wrap = scEl('slCredentialsBody');
    if (wrap) wrap.innerHTML = '<p class="sl-empty">Loading…</p>';
    try {
        scData = await fetchMyStaffCredentials(slStaffId, slPin);
    } catch (e) {
        console.warn('credentials:', e);
        if (wrap) wrap.innerHTML = '<p class="sl-empty">Could not load your records. Pull to retry.</p>';
        return;
    }
    scRender();
}

// today/soon/expired/none — same four-state language the rest of the app
// already uses for "something needs attention" (e.g. the Attendance Board's
// ratio pill), read off whichever row is latest for this type.
//
// ⚠️ expires_at is a plain DATE, not a timestamp. `new Date().toISOString()`
// reads the CLOCK's UTC date, which in the evening in Central time is already
// tomorrow — comparing that against a plain date string would call something
// expired or due a day early. `toLocaleDateString('en-CA', {timeZone:
// 'America/Chicago'})` reads the actual Central-time date instead, same
// pattern the edge functions use for `careDate`.
function scStatus(entry) {
    if (!entry) return { cls: 'is-none', text: 'None on file' };
    if (!entry.expires_at) return { cls: 'is-current', text: 'On file' };

    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    const soonBy = new Date(); soonBy.setDate(soonBy.getDate() + 30);
    const soon = soonBy.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

    if (entry.expires_at < today) return { cls: 'is-expired', text: 'Expired' };
    if (entry.expires_at <= soon) return { cls: 'is-soon', text: 'Due soon' };
    return { cls: 'is-current', text: 'Current' };
}

function scDate(iso) {
    if (!iso) return '';
    return new Date(iso + 'T00:00:00').toLocaleDateString('en-US',
        { month: 'short', day: 'numeric', year: 'numeric' });
}

function scRender() {
    const wrap = scEl('slCredentialsBody');
    if (!wrap) return;

    wrap.innerHTML = SC_TYPES.map(t => {
        // Rows are already sorted newest-first per type by the RPC, so the
        // first match is the latest one.
        const latest = scData.find(c => c.credential_type === t.key);
        const status = scStatus(latest);
        const detail = latest
            ? `Completed ${scEsc(scDate(latest.completed_at))}${
                latest.expires_at ? ` · good until ${scEsc(scDate(latest.expires_at))}` : ''}${
                latest.has_document ? ' · document on file' : ''}`
            : 'Nothing logged yet.';

        return `<div class="sl-cred-card">
            <div class="sl-cred-top">
                <span class="sl-cred-label">${scEsc(t.label)}</span>
                <span class="sl-cred-status ${status.cls}">${scEsc(status.text)}</span>
            </div>
            <p class="sl-cred-detail">${detail}</p>
            <button type="button" class="sl-cred-add" data-cred-type="${t.key}">+ Log a new one</button>
        </div>`;
    }).join('');

    wrap.querySelectorAll('[data-cred-type]').forEach(b => {
        b.addEventListener('click', () => scOpenSheet(b.dataset.credType));
    });
}

function scEsc(s) {
    return String(s ?? '').replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
}

// ── Add-a-record sheet ──────────────────────────────────────

function scOpenSheet(typeKey) {
    const type = SC_TYPES.find(t => t.key === typeKey);
    if (!type) return;

    scPendingDoc = null;
    scEl('slCredentialForm')?.reset();
    scEl('slCredType').value = typeKey;
    scEl('slCredSheetTitle').textContent = `Log a ${type.label} record`;
    scEl('slCredDocStatus').textContent = '';
    scEl('slCredDocStatus').className = 'sl-doc-status';

    // Suggest today as the completion date and a validity-based expiry —
    // both are plain inputs the person can change before saving. Central
    // time, not the device's UTC date — see the note on scStatus() above.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });
    scEl('slCredCompleted').value = today;
    const suggested = new Date();
    suggested.setMonth(suggested.getMonth() + type.validityMonths);
    scEl('slCredExpires').value = suggested.toLocaleDateString('en-CA', { timeZone: 'America/Chicago' });

    // Only 'other' (not offered from this screen today, but the field stays
    // wired for when it is) needs the free-text label; CPR/TB rows already
    // say what they are from their own card.
    scEl('slCredLabelField').classList.toggle('hidden', typeKey !== 'other');

    scEl('slCredentialSheet')?.classList.remove('hidden');
}

function scCloseSheet() {
    scEl('slCredentialSheet')?.classList.add('hidden');
    scPendingDoc = null;
}

async function scPickDoc(input) {
    const file = input.files?.[0];
    input.value = '';   // allow picking the exact same file again
    if (!file) return;

    const status = scEl('slCredDocStatus');
    if (status) { status.textContent = 'Reading…'; status.className = 'sl-doc-status'; }
    try {
        const dataUrl = file.type === 'application/pdf'
            ? await scFileToDataUrl(file)
            : await compressImageToDataUrl(file);
        scPendingDoc = { dataUrl, name: file.name };
        if (status) {
            status.textContent = `Attached: ${file.name}`;
            status.className = 'sl-doc-status is-ok';
        }
    } catch (e) {
        scPendingDoc = null;
        if (status) {
            status.textContent = 'Could not read that file. Try again.';
            status.className = 'sl-doc-status is-err';
        }
    }
}

function scFileToDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload  = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.readAsDataURL(file);
    });
}

async function scSubmit(e) {
    e.preventDefault();

    const credentialType = scEl('slCredType').value;
    const completedAt    = scEl('slCredCompleted').value;
    const expiresAt       = scEl('slCredExpires').value;
    const label            = scEl('slCredLabel').value.trim();

    if (!completedAt) { slToast('Enter the date it was completed.', 'err'); return; }

    const btn = scEl('slCredSubmitBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
        const id = await submitStaffCredential(slStaffId, slPin, {
            credentialType, label, completedAt, expiresAt,
            documentDataUrl: scPendingDoc?.dataUrl || null,
        });
        if (!id) { slToast('That did not save. Check your PIN.', 'err'); return; }
        scCloseSheet();
        scLoaded = false;   // force a real reload rather than trusting a
                             // client-built row to match what the RPC saved
        await scLoad();
        slToast('Saved.');
    } catch (err) {
        console.warn('credential submit:', err);
        slToast('Could not save that. Try again.', 'err');
    } finally {
        btn.disabled = false; btn.textContent = 'Save';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    scEl('slCredCancel')?.addEventListener('click', scCloseSheet);
    scEl('slCredentialSheet')?.addEventListener('click', e => {
        if (e.target.id === 'slCredentialSheet') scCloseSheet();
    });
    scEl('slCredentialForm')?.addEventListener('submit', scSubmit);
    scEl('slCredPhotoInput')?.addEventListener('change', e => scPickDoc(e.target));
    scEl('slCredFileInput')?.addEventListener('change', e => scPickDoc(e.target));
});
