// ============================================================
// MODULE: Newsletter  (design handoff: Capacity & Fill, 4e)
// ============================================================
// Messages → Newsletter. A drag-and-drop builder for the monthly letter,
// with the blocks that matter pulled live out of myMDO rather than retyped
// into an email every month.
//
// ── The "pulled from myMDO" blocks are the point ────────────
// Anyone can drag a text box around. What this does that a generic email
// tool cannot is fill three of the blocks from the data the letter is
// ABOUT, so the newsletter cannot contradict the app:
//
//   Closures            `closures`, for the month being written about
//   Registration window the real 1st–15th window, honoured by the server
//   Open days           the same seat/at-ratio rule Fill the Rooms uses
//
// No CACFP/meal-menu block — Timothy MDO does not run that program.
//
// A dynamic block stores only its TYPE, never its rendered text. The
// preview resolves it at render time, and the note under each one says so:
// change a closure the day before this sends and the letter changes with
// it. Freezing the text at drag time is the bug this design avoids.
//
// ── Storage ─────────────────────────────────────────────────
// The draft is a JSON document in `settings.newsletter_draft` — the same
// key/value pattern room_rates and programs use. One draft at a time,
// which is what a monthly letter needs; a real archive of past issues
// would be a table, and is not pretended at here.
//
// ── ⚠️ SENDING IS NOT WIRED ─────────────────────────────────
// There is no bulk-send path. Every existing email in this app goes
// through a specific Edge Function (send-invoice, send-waitlist-offer,
// send-day-summary…) that owns its own recipient list, its own
// authentication and its own idempotency. A newsletter needs the same:
// an Edge Function that resolves the audience server-side, throttles, and
// records what went to whom so a double-click cannot send twice to 112
// families. That is not something to fake with a disabled button and a
// hopeful comment — the screen composes and saves, and says plainly that
// the send button needs building. "Copy for email" is offered instead, so
// the letter is usable today by pasting it into whatever actually sends
// mail now.

const NL_BLOCKS = [
    { type: 'heading', icon: '✍️', label: 'Heading',   dynamic: false },
    { type: 'text',    icon: '📝', label: 'Text',      dynamic: false },
    { type: 'button',  icon: '🔘', label: 'Button',    dynamic: false },
    { type: 'image',   icon: '🖼️', label: 'Picture',   dynamic: false },
    { type: 'divider', icon: '➖', label: 'Divider',   dynamic: false },
    { type: 'closures',  icon: '🚪', label: 'Closures',            dynamic: true, from: 'From the calendar' },
    { type: 'regwindow', icon: '🗓️', label: 'Registration window', dynamic: true, from: 'The real window' },
    { type: 'opendays',  icon: '🎟️', label: 'Open days',           dynamic: true, from: 'Live availability' },
];

const NL_DEFAULT = [
    { id: 'b1', type: 'heading', text: 'Hello from MDO' },
    { id: 'b2', type: 'text', text: 'A few things for the month ahead.' },
    { id: 'b3', type: 'closures' },
];

// Which fields the inspector shows for each editable block type. 'button'
// and 'image' need more than one field, so this is a list per type rather
// than the old one-field-fits-all assumption.
const NL_EDITABLE_FIELDS = {
    heading: [{ key: 'text', label: 'Heading', kind: 'text' }],
    text:    [{ key: 'text', label: 'Text', kind: 'textarea' }],
    button:  [
        { key: 'text', label: 'Button label', kind: 'text' },
        { key: 'url',  label: 'Link — where the button goes', kind: 'text', placeholder: 'https://… (a page, or a file link)' },
    ],
    image: [
        { key: 'url', label: 'Image URL', kind: 'text', placeholder: 'https://…' },
        { key: 'alt', label: 'Alt text (what the picture shows)', kind: 'text' },
    ],
};

let _nlDraft = null;      // { blocks:[...], subject, audience:{...} }
let _nlBound = false;
let _nlSel   = null;      // selected block id
let _nlDrag  = null;      // { kind:'new'|'move', type?, id? }
let _nlLive  = null;      // resolved dynamic content for the preview

function _nlEl(id) { return document.getElementById(id); }

function _nlNewId() { return 'b' + Math.random().toString(36).slice(2, 9); }

function _nlMonthKey(offset = 1) {
    const d = new Date();
    d.setMonth(d.getMonth() + offset, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

function _nlMonthLabel(key) {
    const [y, m] = key.split('-').map(Number);
    return `${MONTH_NAMES[m - 1]} ${y}`;
}

// ── Live content for the dynamic blocks ─────────────────────
// Resolved once per render, shared by every dynamic block. Each piece is
// best-effort: a source that cannot be read renders as "nothing to show"
// inside its own block rather than failing the whole preview.
async function _nlResolveLive(monthKey) {
    const [y, m] = monthKey.split('-').map(Number);
    const start = `${monthKey}-01`;
    const end = new Date(y, m, 0).toLocaleDateString('en-CA');

    const out = { monthKey, closures: [], openDays: [], regWindow: null };

    try {
        const all = typeof fetchClosures === 'function' ? await fetchClosures() : [];
        out.closures = (all || []).filter(c => c.close_date >= start && c.close_date <= end);
    } catch (_) { /* block renders its own empty state */ }

    // The registration window is the app's real rule: a month's days are
    // chosen between the 1st and the 15th of the month before.
    const openOn = new Date(y, m - 2, 1);
    const closeOn = new Date(y, m - 2, 15);
    out.regWindow = {
        opens: openOn.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
        closes: closeOn.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric' }),
        month: _nlMonthLabel(monthKey),
    };

    // Open days: the same capacity − booked, minus ratio edges, that Fill
    // the Rooms and the parent card use — kept as the actual dates, not
    // just a seat-day total, so the letter can say which days to bring a
    // child rather than a number a parent cannot act on.
    try {
        const rooms = getSortedRooms().filter(r => !r.hidden && r.status === 'active');
        const closedSet = new Set(out.closures.filter(c => !c.half_day).map(c => c.close_date));
        out.openDays = rooms.map(room => {
            const dates = [];
            const ratio = Number(room.staffRatio) || 0;
            for (let d = 1; d <= new Date(y, m, 0).getDate(); d++) {
                const date = `${monthKey}-${String(d).padStart(2, '0')}`;
                const dow = new Date(date + 'T00:00:00').getDay();
                if (dow === 0 || dow === 6 || closedSet.has(date)) continue;
                let booked = 0;
                (allRegistrations || []).forEach(reg => {
                    if (reg.room_id !== room.id) return;
                    (reg.registration_dates || []).forEach(x => {
                        if (!x.waitlisted && x.care_date === date) booked++;
                    });
                });
                const free = Math.max(0, (Number(room.capacity) || 0) - booked);
                const atRatio = ratio > 0 && booked > 0 && booked % ratio === 0;
                if (free > 0 && !atRatio) dates.push({ date, free });
            }
            return { label: room.label, dates };
        }).filter(r => r.dates.length > 0);
    } catch (_) { /* as above */ }

    return out;
}

// ── Preview ─────────────────────────────────────────────────
function _nlBlockPreviewHtml(b) {
    const live = _nlLive || {};
    switch (b.type) {
        case 'heading':
            return `<h2 class="nl-p-heading">${escHtml(b.text || 'Heading')}</h2>`;
        case 'text':
            return `<p class="nl-p-text">${escHtml(b.text || 'Write something here.')}</p>`;
        case 'button':
            return b.url
                ? `<div class="nl-p-btnwrap"><a class="nl-p-btn" href="${escHtml(b.url)}" target="_blank" rel="noopener">${escHtml(b.text || 'Register')}</a></div>`
                : `<div class="nl-p-btnwrap"><span class="nl-p-btn">${escHtml(b.text || 'Register')}</span><div class="nl-p-btn-hint">No link set — add one in the panel on the right.</div></div>`;
        case 'image':
            return b.url
                ? `<div class="nl-p-imgwrap"><img class="nl-p-img" src="${escHtml(b.url)}" alt="${escHtml(b.alt || '')}"></div>`
                : `<div class="nl-p-dyn-none">Paste an image URL in the panel on the right.</div>`;
        case 'divider':
            return `<hr class="nl-p-divider">`;
        case 'closures': {
            const list = live.closures || [];
            return `<div class="nl-p-dyn">
                <div class="nl-p-dyn-kicker">Closed days in ${escHtml(_nlMonthLabel(live.monthKey || ''))}</div>
                ${list.length ? list.map(c => `
                    <div class="nl-p-dyn-row">
                        <span>${escHtml(new Date(c.close_date + 'T00:00:00')
                            .toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }))}</span>
                        <span>${escHtml(c.half_day ? (c.reason || 'Closing early') + ' · half day' : (c.reason || 'Closed'))}</span>
                    </div>`).join('')
                : '<div class="nl-p-dyn-none">Nothing closed this month.</div>'}
                <div class="nl-p-dyn-note">Updates itself if the calendar changes before this sends.</div>
            </div>`;
        }
        case 'regwindow': {
            const w = live.regWindow;
            return `<div class="nl-p-dyn">
                <div class="nl-p-dyn-kicker">Registration</div>
                ${w ? `<div class="nl-p-dyn-row"><span>${escHtml(w.month)} opens</span><span>${escHtml(w.opens)}</span></div>
                       <div class="nl-p-dyn-row"><span>and closes</span><span>${escHtml(w.closes)}</span></div>`
                    : '<div class="nl-p-dyn-none">—</div>'}
                <div class="nl-p-dyn-note">The real window the server enforces, not a typed date.</div>
            </div>`;
        }
        case 'opendays': {
            const list = live.openDays || [];
            const fmt = (d) => new Date(d + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
            const maxDates = 8;
            return `<div class="nl-p-dyn">
                <div class="nl-p-dyn-kicker">Room for more</div>
                ${list.length ? list.map(r => `
                    <div class="nl-p-dyn-room">${escHtml(r.label)}</div>
                    ${r.dates.slice(0, maxDates).map(x => `
                        <div class="nl-p-dyn-row"><span>${escHtml(fmt(x.date))}</span><span>${x.free} ${x.free === 1 ? 'spot' : 'spots'} open</span></div>`).join('')}
                    ${r.dates.length > maxDates ? `<div class="nl-p-dyn-note">+${r.dates.length - maxDates} more day${r.dates.length - maxDates === 1 ? '' : 's'} this month.</div>` : ''}
                `).join('')
                : '<div class="nl-p-dyn-none">Every room is full this month.</div>'}
                <div class="nl-p-dyn-note">Counts a day as open only when one more child would not need another adult.</div>
            </div>`;
        }
        default:
            return '';
    }
}

function _nlCanvasHtml() {
    const blocks = _nlDraft?.blocks || [];
    const meta = (t) => NL_BLOCKS.find(b => b.type === t) || {};
    return `
        <div class="nl-paper">
            <div class="nl-paper-head">
                <span class="nl-wordmark"><em>my</em>MDO</span>
                <span class="nl-paper-sub">Timothy Lutheran · Mother's Day Out</span>
            </div>
            <div class="nl-drop" data-nl-drop="0"></div>
            ${blocks.map((b, i) => `
                <div class="nl-block${b.id === _nlSel ? ' is-sel' : ''}${meta(b.type).dynamic ? ' is-dyn' : ''}"
                     draggable="true" data-nl-block="${escHtml(b.id)}">
                    <div class="nl-block-tag">${escHtml((meta(b.type).label || b.type).toUpperCase())}${
                        meta(b.type).dynamic ? ' · LIVE' : ''}</div>
                    <button type="button" class="nl-block-x" data-nl-remove="${escHtml(b.id)}" aria-label="Remove">✕</button>
                    ${_nlBlockPreviewHtml(b)}
                </div>
                <div class="nl-drop" data-nl-drop="${i + 1}"></div>`).join('')}
            ${blocks.length ? '' : '<p class="nl-empty">Drag a block in from the left to start.</p>'}
            <div class="nl-paper-foot">
                Timothy Lutheran Church · 6704 Fyler Ave., St. Louis, MO 63139<br>
                You're getting this because your family is enrolled at MDO.
            </div>
        </div>`;
}

function _nlPaletteHtml() {
    const statics = NL_BLOCKS.filter(b => !b.dynamic);
    const dyn = NL_BLOCKS.filter(b => b.dynamic);
    const row = b => `
        <div class="nl-pal${b.dynamic ? ' is-dyn' : ''}" draggable="true" data-nl-new="${b.type}">
            <span class="nl-pal-grip">⠿</span>
            <span class="nl-pal-icon">${b.icon}</span>
            <span class="nl-pal-main">
                <span class="nl-pal-label">${escHtml(b.label)}</span>
                ${b.from ? `<span class="nl-pal-from">${escHtml(b.from)}</span>` : ''}
            </span>
        </div>`;
    return `
        <div class="ap-panel">
            <div class="ap-panel-head"><h3>Drag in a block</h3></div>
            <div class="nl-pal-list">${statics.map(row).join('')}</div>
            <div class="nl-pal-title">Pulled from myMDO</div>
            <div class="nl-pal-list">${dyn.map(row).join('')}</div>
            <div class="nl-foot">
                <p>A live block stores only which kind it is. It resolves when the letter is previewed or sent, so a closure changed the day before still reaches families correctly.</p>
            </div>
        </div>`;
}

function _nlInspectorHtml() {
    const b = (_nlDraft?.blocks || []).find(x => x.id === _nlSel);
    const fields = b ? NL_EDITABLE_FIELDS[b.type] : null;
    return `
        <div class="ap-panel">
            <div class="ap-panel-head"><h3>${b ? 'Selected block' : 'Nothing selected'}</h3></div>
            <div class="nl-inspector">
                ${fields ? fields.map(f => `
                    <label class="nl-field">
                        <span>${escHtml(f.label)}</span>
                        ${f.kind === 'textarea'
                            ? `<textarea data-nl-field="${f.key}" rows="10" placeholder="${escHtml(f.placeholder || '')}">${escHtml(b[f.key] || '')}</textarea>`
                            : `<input type="text" data-nl-field="${f.key}" placeholder="${escHtml(f.placeholder || '')}" value="${escHtml(b[f.key] || '')}">`}
                    </label>`).join('')
                : b ? `<p class="nl-hint">This block fills itself from myMDO — there is nothing to type. Remove it with the ✕ if you don't want it.</p>`
                    : `<p class="nl-hint">Click a block in the letter to edit it.</p>`}
            </div>
        </div>

        <div class="ap-panel">
            <div class="ap-panel-head"><h3>Sending</h3></div>
            <div class="nl-send">
                <div class="nl-send-note">
                    <strong>The send button isn't built.</strong>
                    Every email this app sends goes through an Edge Function that owns its own recipient list, authentication and idempotency — a newsletter needs the same, so a double-click cannot send twice to every family. Composing and saving work now; sending is the next piece.
                </div>
                <button type="button" class="ap-pill" id="nlCopyBtn">Copy the letter for email</button>
                <button type="button" class="ap-pill" id="nlSaveBtn">Save draft</button>
                <span class="nl-status" id="nlStatus"></span>
            </div>
        </div>`;
}

async function renderNewsletterTool() {
    const body = _nlEl('nlBody');
    if (!body) return;
    body.innerHTML = '<p class="empty-hint">Loading…</p>';

    try {
        if (!_nlDraft) {
            const saved = typeof fetchSetting === 'function' ? await fetchSetting('newsletter_draft') : null;
            _nlDraft = (saved && Array.isArray(saved.blocks) && saved.blocks.length)
                ? saved
                : { month: _nlMonthKey(1), blocks: NL_DEFAULT.map(b => ({ ...b })) };
        }
        if (typeof allRegistrations !== 'undefined' && !allRegistrations.length) {
            allRegistrations = await fetchAllRegistrations().catch(() => []);
        }
        _nlLive = await _nlResolveLive(_nlDraft.month || _nlMonthKey(1));

        body.innerHTML = `
            <div class="nl-toolbar">
                <div>
                    <h3 class="nl-title">${escHtml(_nlMonthLabel(_nlDraft.month || _nlMonthKey(1)))} newsletter</h3>
                    <p class="nl-sub">Draft. Live blocks resolve when it is previewed or sent.</p>
                </div>
            </div>
            <div class="nl-cols">
                <div class="nl-col-pal">${_nlPaletteHtml()}</div>
                <div class="nl-col-canvas">${_nlCanvasHtml()}</div>
                <div class="nl-col-insp">${_nlInspectorHtml()}</div>
            </div>`;
        _nlBindLive();
    } catch (e) {
        console.warn('renderNewsletterTool:', e);
        body.innerHTML = `<p class="empty-hint">Could not load: ${escHtml(e.message || String(e))}</p>`;
    }
}

// Re-render only the canvas and inspector, so an edit does not re-resolve
// every dynamic block (and does not steal focus from the text field).
function _nlRepaint({ keepFocus = false } = {}) {
    const canvas = document.querySelector('#nlBody .nl-col-canvas');
    const insp = document.querySelector('#nlBody .nl-col-insp');
    if (canvas) canvas.innerHTML = _nlCanvasHtml();
    if (insp && !keepFocus) insp.innerHTML = _nlInspectorHtml();
    _nlBindLive();
}

function _nlBindLive() {
    document.querySelectorAll('#nlBody .nl-col-insp [data-nl-field]').forEach(el => {
        el.addEventListener('input', () => {
            const b = (_nlDraft?.blocks || []).find(x => x.id === _nlSel);
            if (!b) return;
            b[el.dataset.nlField] = el.value;
            const canvas = document.querySelector('#nlBody .nl-col-canvas');
            if (canvas) canvas.innerHTML = _nlCanvasHtml();
        });
    });
    _nlEl('nlSaveBtn')?.addEventListener('click', _nlSave);
    _nlEl('nlCopyBtn')?.addEventListener('click', _nlCopy);
}

async function _nlSave() {
    const status = _nlEl('nlStatus');
    try {
        await upsertSetting('newsletter_draft', _nlDraft);
        if (status) status.textContent = 'Draft saved.';
    } catch (e) {
        if (status) status.textContent = 'Could not save: ' + (e.message || e);
    }
}

/** Plain text of the letter as it currently resolves, for pasting elsewhere. */
function _nlPlainText() {
    const live = _nlLive || {};
    const lines = [];
    (_nlDraft?.blocks || []).forEach(b => {
        if (b.type === 'heading') lines.push('', (b.text || '').toUpperCase(), '');
        else if (b.type === 'text') lines.push(b.text || '');
        else if (b.type === 'button') lines.push(`[ ${b.text || 'Register'} ]${b.url ? ' — ' + b.url : ''}`);
        else if (b.type === 'image') { if (b.url) lines.push(`[picture: ${b.alt || b.url}]`); }
        else if (b.type === 'divider') lines.push('—————');
        else if (b.type === 'closures') {
            lines.push('', `CLOSED DAYS IN ${_nlMonthLabel(live.monthKey || '').toUpperCase()}`);
            (live.closures || []).forEach(c => lines.push(
                `  ${new Date(c.close_date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} — ${c.half_day ? (c.reason || 'Closing early') + ' (half day)' : (c.reason || 'Closed')}`));
            if (!(live.closures || []).length) lines.push('  Nothing closed this month.');
        } else if (b.type === 'regwindow' && live.regWindow) {
            lines.push('', 'REGISTRATION',
                `  ${live.regWindow.month} opens ${live.regWindow.opens} and closes ${live.regWindow.closes}.`);
        } else if (b.type === 'opendays') {
            lines.push('', 'ROOM FOR MORE');
            (live.openDays || []).forEach(r => {
                lines.push(`  ${r.label}:`);
                r.dates.forEach(x => lines.push(
                    `    ${new Date(x.date + 'T00:00:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} — ${x.free} ${x.free === 1 ? 'spot' : 'spots'} open`));
            });
            if (!(live.openDays || []).length) lines.push('  Every room is full this month.');
        }
    });
    return lines.join('\n').trim();
}

async function _nlCopy() {
    const status = _nlEl('nlStatus');
    const text = _nlPlainText();
    try {
        await navigator.clipboard.writeText(text);
        if (status) status.textContent = 'Copied. Paste it into whatever sends your mail today.';
    } catch (_) {
        // Clipboard is permission-gated; a window the office can select from
        // is a better failure than a silent one.
        const w = window.open('', '_blank');
        if (w) { w.document.write(`<pre>${escHtml(text)}</pre>`); w.document.close(); }
        else if (status) status.textContent = 'Could not copy — allow clipboard access or pop-ups.';
    }
}

// ── Drag and drop ───────────────────────────────────────────
function setupNewsletterTool() {
    if (_nlBound) return;
    const section = _nlEl('newsletterSection');
    if (!section) return;
    _nlBound = true;

    section.addEventListener('dragstart', (ev) => {
        const pal = ev.target.closest('[data-nl-new]');
        if (pal) { _nlDrag = { kind: 'new', type: pal.dataset.nlNew }; ev.dataTransfer.effectAllowed = 'copy'; return; }
        const blk = ev.target.closest('[data-nl-block]');
        if (blk) { _nlDrag = { kind: 'move', id: blk.dataset.nlBlock }; ev.dataTransfer.effectAllowed = 'move'; }
    });

    section.addEventListener('dragover', (ev) => {
        const drop = ev.target.closest('[data-nl-drop]');
        if (!drop || !_nlDrag) return;
        ev.preventDefault();
        drop.classList.add('is-over');
    });

    section.addEventListener('dragleave', (ev) => {
        ev.target.closest('[data-nl-drop]')?.classList.remove('is-over');
    });

    section.addEventListener('drop', (ev) => {
        const drop = ev.target.closest('[data-nl-drop]');
        if (!drop || !_nlDrag) return;
        ev.preventDefault();
        drop.classList.remove('is-over');
        let index = Number(drop.dataset.nlDrop);
        const blocks = _nlDraft.blocks;

        if (_nlDrag.kind === 'new') {
            blocks.splice(index, 0, { id: _nlNewId(), type: _nlDrag.type, text: '' });
        } else {
            const from = blocks.findIndex(b => b.id === _nlDrag.id);
            if (from < 0) { _nlDrag = null; return; }
            // Removing the block first shifts every later index down by one.
            if (from < index) index--;
            const [moved] = blocks.splice(from, 1);
            blocks.splice(index, 0, moved);
        }
        _nlDrag = null;
        _nlRepaint();
    });

    section.addEventListener('dragend', () => { _nlDrag = null; });

    section.addEventListener('click', (ev) => {
        const rm = ev.target.closest('[data-nl-remove]');
        if (rm) {
            _nlDraft.blocks = _nlDraft.blocks.filter(b => b.id !== rm.dataset.nlRemove);
            if (_nlSel === rm.dataset.nlRemove) _nlSel = null;
            _nlRepaint();
            return;
        }
        const blk = ev.target.closest('[data-nl-block]');
        if (blk) { _nlSel = blk.dataset.nlBlock; _nlRepaint(); }
    });
}
