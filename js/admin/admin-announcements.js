// ============================================================
// admin-announcements — the composer (design handoff `1h`)
// ============================================================
// "Write once, see exactly who gets it and where it lands."
//
// The whole point of the screen is the right-hand column: before she sends
// anything, the director can see the audience count and what else the send is
// going to do. A composer that only shows a text box makes "post to 38
// families" feel identical to "close the building on Thursday".
//
// ⚠️ A CLOSURE IS NOT JUST A DIFFERENT COLORED ANNOUNCEMENT. Picking Closure
// changes three things: it asks for a date, it offers to block that day on the
// care calendar, and — per the handoff — it is the only kind that ignores quiet
// hours. Everything else waits until 7am. Those are stated as behavior, so the
// kind chip is a real branch and not a label.
//
// ⚠️ WHAT ACTUALLY SENDS TODAY: the row is written and published, and the
// parent portal reads published announcements on its Today tab. The push
// notification does NOT go out, for the same reason as the missing-child alert
// — `/send-push` is called in three places in this codebase and no such edge
// function exists. The composer says so on the send panel rather than implying
// a phone will buzz. Do not remove that line until the function is deployed.

let _anList  = [];
let _anDraft = null;

function _anEl(id) { return document.getElementById(id); }

const AN_KINDS = [
    { key: 'closure', icon: '🚨', label: 'Closure',       tone: 'tang' },
    { key: 'general', icon: '📣', label: 'General news',  tone: 'navy' },
    { key: 'event',   icon: '🎉', label: 'Event',         tone: 'green' },
    { key: 'billing', icon: '🧾', label: 'Billing notice', tone: 'sun' },
];

const AN_AUDIENCES = [
    { key: 'all_families', label: 'All families' },
    { key: 'room',         label: 'Particular rooms' },
    { key: 'staff',        label: 'Staff only' },
    { key: 'everyone',     label: 'Families and staff' },
];

function _anFreshDraft() {
    return {
        kind: 'general', audience: 'all_families', rooms: new Set(),
        title: '', body: '', closureDate: '', expiresAt: '',
        blockCalendar: true, creditTuition: false,
    };
}

async function renderAnnouncementsTool() {
    const wrap = _anEl('announcementsBody');
    if (!wrap) return;
    if (!_anDraft) _anDraft = _anFreshDraft();

    wrap.innerHTML = '<p class="muted">Loading…</p>';
    try {
        _anList = await fetchAllAnnouncements();
    } catch (e) {
        _anList = [];
        console.warn('announcements:', e);
    }
    _anRender();
}

function _anRender() {
    const wrap = _anEl('announcementsBody');
    const d = _anDraft;
    const isClosure = d.kind === 'closure';

    wrap.innerHTML = `
    <div class="an-grid">
      <div class="an-compose">
        <div class="an-field">
            <div class="an-label">Kind of announcement</div>
            <div class="an-chips" role="radiogroup" aria-label="Kind of announcement">
                ${AN_KINDS.map(k => `
                <button type="button" class="an-chip tone-${k.tone}${d.kind === k.key ? ' is-on' : ''}"
                        data-kind="${k.key}" role="radio" aria-checked="${d.kind === k.key}">
                    ${k.icon} ${escHtml(k.label)}
                </button>`).join('')}
            </div>
        </div>

        <div class="an-field">
            <div class="an-label">Headline</div>
            <input type="text" id="anTitle" class="an-input" maxlength="120"
                   value="${escHtml(d.title)}"
                   placeholder="${isClosure ? 'Closed Thursday — building water main repair'
                                            : 'What is this about?'}">
        </div>

        <div class="an-field">
            <div class="an-label">What ${d.audience === 'staff' ? 'staff' : 'parents'} need to know</div>
            <textarea id="anBody" class="an-input" rows="7"
                      placeholder="Plain language. What is happening, what they need to do, and when things are normal again."
                      >${escHtml(d.body)}</textarea>
        </div>

        <div class="an-row">
            ${isClosure ? `
            <div class="an-field">
                <div class="an-label">Closure date</div>
                <input type="date" id="anClosureDate" class="an-input" value="${escHtml(d.closureDate)}">
            </div>` : ''}
            <div class="an-field">
                <div class="an-label">Stop showing it</div>
                <input type="date" id="anExpires" class="an-input" value="${escHtml(d.expiresAt)}">
            </div>
            <div class="an-field">
                <div class="an-label">Who gets it</div>
                <select id="anAudience" class="an-input">
                    ${AN_AUDIENCES.map(a =>
                        `<option value="${a.key}"${d.audience === a.key ? ' selected' : ''}>${escHtml(a.label)}</option>`
                     ).join('')}
                </select>
            </div>
        </div>

        ${d.audience === 'room' ? `
        <div class="an-field">
            <div class="an-label">Which rooms</div>
            <div class="an-chips">
                ${(typeof ROOMS !== 'undefined' ? ROOMS : []).filter(r => r.status !== 'retired').map(r => `
                <button type="button" class="an-chip${d.rooms.has(r.id) ? ' is-on' : ''}"
                        data-room="${escHtml(r.id)}">${escHtml(r.label)}</button>`).join('')}
            </div>
        </div>` : ''}

        ${isClosure ? `
        <div class="an-field">
            <div class="an-label">Also do this</div>
            <label class="an-check"><input type="checkbox" id="anBlockCal"${d.blockCalendar ? ' checked' : ''}>
                <span>Block that day on the care calendar</span></label>
            <label class="an-check"><input type="checkbox" id="anCredit"${d.creditTuition ? ' checked' : ''}>
                <span>Credit that day's tuition to next month</span></label>
            <p class="an-fine">
                ⚠️ These two are not wired up yet — ticking them records the
                intent on the announcement, it does not change the calendar or
                any invoice. Do both by hand in Care Calendar and Invoices until
                they are.
            </p>
        </div>` : ''}
      </div>

      <aside class="an-side">
        <div class="an-side-card">
            <div class="an-label">Where this lands</div>
            <p class="an-audience">${escHtml(_anAudienceLine())}</p>
            <ul class="an-lands">
                <li>The Today tab of the parent app, until it expires.</li>
                ${d.audience === 'staff' || d.audience === 'everyone'
                    ? '<li>The staff app’s Messages tab.</li>' : ''}
                ${isClosure ? '<li class="is-alert">A closure ignores quiet hours. Everything else waits until 7am.</li>' : ''}
            </ul>
            <p class="an-fine">
                ⚠️ It will <strong>not</strong> push to anyone's phone yet — the
                push function this app calls has never been deployed. Parents see
                it next time they open the portal.
            </p>
            <button class="btn-primary an-send" id="anSend">Post it</button>
            <button class="btn-ghost an-draft" id="anSaveDraft">Save as a draft</button>
        </div>
      </aside>
    </div>

    <div class="an-history">
        <div class="an-label">Posted</div>
        ${_anList.length ? _anList.map(_anHistoryRow).join('')
                         : '<p class="muted">Nothing posted yet.</p>'}
    </div>`;

    _anBind();
}

function _anAudienceLine() {
    const d = _anDraft;
    if (d.audience === 'staff')    return 'Every active staff member.';
    if (d.audience === 'everyone') return 'Every family with a child enrolled, and every active staff member.';
    if (d.audience === 'room') {
        const names = [...d.rooms].map(id =>
            (typeof ROOMS !== 'undefined' ? ROOMS : []).find(r => r.id === id)?.label || id);
        return names.length ? `Families with a child in ${names.join(', ')}.`
                            : 'No rooms picked yet — nobody will get this.';
    }
    return 'Every family with a child enrolled.';
}

function _anHistoryRow(a) {
    const kind = AN_KINDS.find(k => k.key === a.kind) || AN_KINDS[1];
    const when = a.published_at
        ? new Date(a.published_at).toLocaleDateString('en-US',
            { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'America/Chicago' })
        : 'Draft';
    const expired = a.expires_at && new Date(a.expires_at) < new Date();
    return `<div class="an-hist-row">
        <span class="an-hist-icon">${kind.icon}</span>
        <span class="an-hist-main">
            <span class="an-hist-title">${escHtml(a.title)}</span>
            <span class="an-hist-sub">${escHtml(when)}${
                a.created_by ? ' · ' + a.created_by : ''}${expired ? ' · expired' : ''}</span>
        </span>
        ${a.published_at ? '' : '<span class="an-hist-draft">Draft</span>'}
    </div>`;
}

function _anBind() {
    document.querySelectorAll('[data-kind]').forEach(b => {
        b.onclick = () => { _anCapture(); _anDraft.kind = b.dataset.kind; _anRender(); };
    });
    document.querySelectorAll('[data-room]').forEach(b => {
        b.onclick = () => {
            _anCapture();
            const id = b.dataset.room;
            if (_anDraft.rooms.has(id)) _anDraft.rooms.delete(id); else _anDraft.rooms.add(id);
            _anRender();
        };
    });
    _anEl('anAudience')?.addEventListener('change', e => {
        _anCapture(); _anDraft.audience = e.target.value; _anRender();
    });
    _anEl('anSend')?.addEventListener('click', () => _anSave(true));
    _anEl('anSaveDraft')?.addEventListener('click', () => _anSave(false));
}

// Read the form back into the draft before any re-render — the chip groups
// rebuild the whole panel, and a director who has typed three paragraphs and
// then changed the kind should not lose them.
function _anCapture() {
    const d = _anDraft;
    d.title       = _anEl('anTitle')?.value ?? d.title;
    d.body        = _anEl('anBody')?.value ?? d.body;
    d.closureDate = _anEl('anClosureDate')?.value ?? d.closureDate;
    d.expiresAt   = _anEl('anExpires')?.value ?? d.expiresAt;
    if (_anEl('anBlockCal')) d.blockCalendar = _anEl('anBlockCal').checked;
    if (_anEl('anCredit'))   d.creditTuition = _anEl('anCredit').checked;
}

async function _anSave(publish) {
    _anCapture();
    const d = _anDraft;

    if (!d.title.trim()) { showToast('Give it a headline.', 'error'); return; }
    if (!d.body.trim())  { showToast('Say what is happening.', 'error'); return; }
    if (d.audience === 'room' && !d.rooms.size) {
        showToast('Pick at least one room, or change who gets it.', 'error'); return;
    }
    if (d.kind === 'closure' && !d.closureDate) {
        showToast('A closure needs the date it applies to.', 'error'); return;
    }
    if (publish && !confirm(`Post this to ${_anAudienceLine().toLowerCase().replace(/\.$/, '')}?`)) return;

    const btn = _anEl(publish ? 'anSend' : 'anSaveDraft');
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = publish ? 'Posting…' : 'Saving…';
    try {
        await saveAnnouncement({
            title:     d.title.trim(),
            body:      d.body.trim(),
            kind:      d.kind,
            audience:  d.audience,
            rooms:     [...d.rooms],
            expiresAt: d.expiresAt || null,
            publish,
        });
        await logAdminAction(publish ? 'publish' : 'create', 'announcement', null,
                             { kind: d.kind, audience: d.audience });
        showToast(publish ? 'Posted.' : 'Saved as a draft.');
        _anDraft = _anFreshDraft();
        await renderAnnouncementsTool();
    } catch (e) {
        showToast('Error: ' + (e.message || e), 'error');
    } finally {
        btn.disabled = false; btn.textContent = label;
    }
}
