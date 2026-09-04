// ============================================================
// MDO WEBSITE — public home page content
// ============================================================
// Edits the copy a visitor reads on mdo.timothystl.org. Everything here is
// marketing text; nothing here is read by the care system.
//
// ⚠️ CLASSROOMS, RATES, FEES AND STAFF ARE NOT EDITED HERE, ON PURPOSE.
// They already live in `settings` (room_rates / room_capacity / staff_ratios /
// registration_fee / new_family_fee / staff_directory), are already edited on
// the Settings screen, and are already server-rendered into the home page by
// worker.js's HTMLRewriter pass. A second editor for them would be a second
// source of truth for numbers the billing path reads. Point at Settings
// instead of rebuilding them here.
//
// ⚠️ DRAFT AND PUBLISHED ARE SEPARATE. Saving changes nothing a visitor sees.
// Only Publish does, and only a `full` admin may press it — `restricted` may
// draft. That split is enforced in the database (admin_mdo_publish), not by
// hiding the button; the button is hidden as a courtesy so nobody presses a
// control that would be refused.

const MDO_SECTIONS = [
    {
        key: 'hero', icon: '🏡', label: 'Top of the page',
        blurb: 'The first screen a parent sees — the headline, the two buttons, the hours card, and the announcement strip under it.',
        fields: [
            { k: 'eyebrow',        kind: 'text',     label: 'Small line above the headline', hint: 'e.g. the neighborhood and city' },
            { k: 'heading',        kind: 'textarea', label: 'Headline', rows: 2,
              hint: 'This is the page’s main heading and the first thing a search engine reads. Leading with what the program is, and where, is deliberate.' },
            { k: 'headingEmphasis', kind: 'text',    label: 'Last word, in italics', hint: 'Shown italic at the end of the headline. Leave blank for none.' },
            { k: 'body',           kind: 'textarea', label: 'Paragraph under the headline', rows: 4 },
            { k: 'primaryLabel',   kind: 'text',     label: 'First button — wording' },
            { k: 'primaryHref',    kind: 'link',     label: 'First button — where it goes' },
            { k: 'secondaryLabel', kind: 'text',     label: 'Second button — wording' },
            { k: 'secondaryHref',  kind: 'link',     label: 'Second button — where it goes' },
            { k: 'cardHoursLabel', kind: 'text',     label: 'Hours card — heading' },
            { k: 'cardHours',      kind: 'text',     label: 'Hours card — the hours' },
            { k: 'cardDays',       kind: 'text',     label: 'Hours card — the days' },
            { k: 'cardFullDayUntil', kind: 'text',   label: 'Full day ends' },
            { k: 'cardHalfDayUntil', kind: 'text',   label: 'Half day ends' },
            { k: 'cardAddress',    kind: 'text',     label: 'Hours card — address line' },
            { k: 'bannerVisible',  kind: 'toggle',   label: 'Show the announcement strip',
              hint: 'Switched off, the strip is removed rather than left empty — an empty strip still paints a band across the page.' },
            { k: 'bannerText',     kind: 'textarea', label: 'Announcement strip — wording', rows: 2 },
            { k: 'bannerLinkLabel', kind: 'text',    label: 'Announcement strip — link wording' },
            { k: 'bannerHref',     kind: 'link',     label: 'Announcement strip — where the link goes' },
        ]
    },
    {
        key: 'faqs', icon: '❓', label: 'Questions families ask',
        blurb: 'The FAQ list, and the infant-program section under it.',
        fields: [
            { k: 'label', kind: 'text', label: 'Small line above the heading' },
            { k: 'title', kind: 'text', label: 'Heading' },
            { k: 'items', kind: 'qalist', label: 'Questions' },
            { k: 'infantVisible', kind: 'toggle', label: 'Show the infant program section' },
            { k: 'infantLabel', kind: 'text', label: 'Infant section — small line above' },
            { k: 'infantTitle', kind: 'text', label: 'Infant section — heading' },
            { k: 'infantIntro', kind: 'paras', label: 'Infant section — the two opening paragraphs', count: 2 },
            { k: 'infantItems', kind: 'qalist', label: 'Infant section — questions' },
        ]
    },
    {
        key: 'contact', icon: '✉️', label: 'How to reach us',
        blurb: 'The contact cards and the line under the map.',
        fields: [
            { k: 'label', kind: 'text', label: 'Small line above the heading' },
            { k: 'title', kind: 'text', label: 'Heading' },
            { k: 'subtitle', kind: 'textarea', label: 'Paragraph under the heading', rows: 3 },
            { k: 'email', kind: 'text', label: 'Email address' },
            { k: 'phone', kind: 'text', label: 'Phone number',
              hint: 'Shown as typed. The tap-to-call link is built from the digits, so punctuation here is safe.' },
            { k: 'addressLine1', kind: 'text', label: 'Address — first line' },
            { k: 'addressLine2', kind: 'text', label: 'Address — second line' },
            { k: 'mapNote', kind: 'textarea', label: 'Line under the map', rows: 3 },
        ]
    },
];

// section -> { draft, published, published_at, updated_at, updated_by }
let _mdoRows = {};
let _mdoOpen = 'hero';
let _mdoDirty = false;

function _mdoDef(key) { return MDO_SECTIONS.find(s => s.key === key); }
function _mdoRow(key) { return _mdoRows[key] || { draft: {}, published: null }; }

/** A draft differs from what is live. Compared by value, not by a dirty flag,
 *  so reloading the screen still reports it honestly. */
function mdoHasUnpublishedChanges(row) {
    if (!row) return false;
    if (row.published === null || row.published === undefined) return true;
    return JSON.stringify(row.draft || {}) !== JSON.stringify(row.published);
}

function _mdoStatus(row) {
    if (!row || row.published == null) {
        return { tone: 'warn', text: 'Not on the website yet — the page still shows its built-in wording.' };
    }
    if (mdoHasUnpublishedChanges(row)) {
        return { tone: 'warn', text: 'Saved, but not published — the website still shows the previous version.' };
    }
    const when = row.published_at ? new Date(row.published_at).toLocaleString('en-US', {
        month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
    }) : '';
    return { tone: 'ok', text: `On the website${when ? ` since ${when}` : ''}${row.published_by ? ` · published by ${row.published_by}` : ''}.` };
}

async function renderMdoWebsiteTool() {
    const host = document.getElementById('mdoWebsiteContent');
    if (!host) return;
    host.innerHTML = '<p class="muted">Loading…</p>';
    const rows = await fetchMdoAdminContent();
    _mdoRows = {};
    rows.forEach(r => {
        // jsonb arrives parsed; the same string-vs-object defensiveness the
        // settings reads need applies if that ever changes.
        const parse = v => (typeof v === 'string' ? parseJsonOr(v, {}) : v);
        _mdoRows[r.section] = { ...r, draft: parse(r.draft) || {}, published: r.published == null ? null : parse(r.published) };
    });
    _mdoDirty = false;
    _mdoRender();
}

function _mdoRender() {
    const host = document.getElementById('mdoWebsiteContent');
    if (!host) return;

    const canPublish = currentAdminRole === 'full';
    const def = _mdoDef(_mdoOpen);
    const row = _mdoRow(_mdoOpen);
    const status = _mdoStatus(row);

    const pills = MDO_SECTIONS.map(s => {
        const r = _mdoRow(s.key);
        const dot = mdoHasUnpublishedChanges(r) ? ' <span class="mdo-dot" title="Not published yet">●</span>' : '';
        return `<button type="button" class="mdo-pill${s.key === _mdoOpen ? ' is-on' : ''}" data-mdo-section="${escHtml(s.key)}">${s.icon} ${escHtml(s.label)}${dot}</button>`;
    }).join('');

    host.innerHTML = `
      <div class="mdo-note">
        This is the public <strong>mdo.timothystl.org</strong> home page. Saving keeps a draft;
        the website does not change until you publish.
        <br><span class="muted">Classroom rates, capacity, ratios and the staff photos on that page are
        edited under <strong>Settings</strong>, not here — they are shared with billing and scheduling.</span>
      </div>
      <div class="mdo-pills">${pills}</div>
      <div class="mdo-head">
        <div>
          <h3 class="mdo-h3">${def.icon} ${escHtml(def.label)}</h3>
          <p class="muted mdo-blurb">${escHtml(def.blurb)}</p>
        </div>
        <a class="btn btn-secondary btn-sm" href="https://mdo.timothystl.org/" target="_blank" rel="noopener">View the live page</a>
      </div>
      <div class="mdo-status mdo-status--${status.tone}">${escHtml(status.text)}</div>
      <div class="mdo-fields">${def.fields.map(f => _mdoField(f, row.draft || {})).join('')}</div>
      <div class="mdo-actions">
        <button type="button" class="btn btn-primary" id="mdoSaveBtn">Save draft</button>
        ${canPublish
            ? `<button type="button" class="btn btn-primary" id="mdoPublishBtn">Publish to the website</button>`
            : `<span class="muted mdo-cant">Publishing is limited to full-access admins. Your draft is saved and someone with full access can publish it.</span>`}
        <button type="button" class="btn btn-secondary" id="mdoDiscardBtn">Discard my changes</button>
        <button type="button" class="btn btn-secondary" id="mdoHistoryBtn">History</button>
      </div>
      <div id="mdoHistory" class="mdo-history" hidden></div>
    `;
    _mdoWire();
}

function _mdoField(f, draft) {
    const v = draft[f.k];
    const id = `mdo_${f.k}`;
    const hint = f.hint ? `<p class="mdo-hint">${escHtml(f.hint)}</p>` : '';

    if (f.kind === 'toggle') {
        return `<div class="mdo-f mdo-f--toggle">
            <label><input type="checkbox" id="${id}" data-mdo-k="${escHtml(f.k)}" ${v === false ? '' : 'checked'}> ${escHtml(f.label)}</label>${hint}
        </div>`;
    }
    if (f.kind === 'textarea') {
        return `<div class="mdo-f"><label for="${id}">${escHtml(f.label)}</label>
            <textarea id="${id}" data-mdo-k="${escHtml(f.k)}" rows="${f.rows || 3}">${escHtml(v == null ? '' : String(v))}</textarea>${hint}</div>`;
    }
    if (f.kind === 'link') {
        return `<div class="mdo-f"><label for="${id}">${escHtml(f.label)}</label>
            <input type="text" id="${id}" data-mdo-k="${escHtml(f.k)}" value="${escHtml(v == null ? '' : String(v))}" placeholder="/calendar or #enroll">
            <p class="mdo-hint">A page on this site (<code>/calendar</code>) or a place further down this page (<code>#enroll</code>). Links to other websites are not accepted here.</p></div>`;
    }
    if (f.kind === 'paras') {
        const arr = Array.isArray(v) ? v : [];
        const boxes = Array.from({ length: f.count || 2 }, (_, i) =>
            `<textarea data-mdo-k="${escHtml(f.k)}" data-mdo-i="${i}" rows="4" placeholder="Paragraph ${i + 1}">${escHtml(arr[i] || '')}</textarea>`
        ).join('');
        return `<div class="mdo-f"><label>${escHtml(f.label)}</label>${boxes}${hint}</div>`;
    }
    if (f.kind === 'qalist') {
        const arr = Array.isArray(v) ? v : [];
        const rows = arr.map((it, i) => `
          <div class="mdo-qa" data-mdo-qa="${escHtml(f.k)}" data-mdo-i="${i}">
            <div class="mdo-qa-head">
              <span class="mdo-qa-n">${i + 1}</span>
              <input type="text" class="mdo-qa-q" data-mdo-k="${escHtml(f.k)}" data-mdo-i="${i}" data-mdo-sub="q"
                     value="${escHtml(it && it.q || '')}" placeholder="The question a parent asks">
              <button type="button" class="mdo-mini" data-mdo-move="up"   data-mdo-k="${escHtml(f.k)}" data-mdo-i="${i}" title="Move up"${i === 0 ? ' disabled' : ''}>↑</button>
              <button type="button" class="mdo-mini" data-mdo-move="down" data-mdo-k="${escHtml(f.k)}" data-mdo-i="${i}" title="Move down"${i === arr.length - 1 ? ' disabled' : ''}>↓</button>
              <button type="button" class="mdo-mini mdo-mini--del" data-mdo-del="${escHtml(f.k)}" data-mdo-i="${i}" title="Remove">✕</button>
            </div>
            <textarea class="mdo-qa-a" data-mdo-k="${escHtml(f.k)}" data-mdo-i="${i}" data-mdo-sub="a" rows="4"
                      placeholder="The answer">${escHtml(it && it.a || '')}</textarea>
            <label class="mdo-qa-show"><input type="checkbox" data-mdo-k="${escHtml(f.k)}" data-mdo-i="${i}" data-mdo-sub="visible" ${it && it.visible === false ? '' : 'checked'}> Show on the website</label>
          </div>`).join('');
        return `<div class="mdo-f mdo-f--list"><label>${escHtml(f.label)} <span class="muted">(${arr.length})</span></label>
            <p class="mdo-hint">Answers may use <strong>bold</strong> and <em>italics</em> by typing
               <code>&lt;strong&gt;…&lt;/strong&gt;</code> or <code>&lt;em&gt;…&lt;/em&gt;</code>, and a link to a page on this
               site as <code>&lt;a href="/waitlist-status"&gt;…&lt;/a&gt;</code>. Anything else is shown as plain text rather than run.</p>
            ${rows || '<p class="muted">No questions yet.</p>'}
            <button type="button" class="btn btn-secondary btn-sm" data-mdo-add="${escHtml(f.k)}">+ Add a question</button></div>`;
    }
    // plain text
    return `<div class="mdo-f"><label for="${id}">${escHtml(f.label)}</label>
        <input type="text" id="${id}" data-mdo-k="${escHtml(f.k)}" value="${escHtml(v == null ? '' : String(v))}">${hint}</div>`;
}

/** Reads the whole form back out of the DOM into the draft object.
 *  ⚠️ Reading the DOM rather than tracking each keystroke means what gets
 *  saved is exactly what the person is looking at. */
function _mdoCollect() {
    const host = document.getElementById('mdoWebsiteContent');
    const def = _mdoDef(_mdoOpen);
    if (!host || !def) return null;
    const out = {};

    def.fields.forEach(f => {
        if (f.kind === 'qalist') {
            const items = [];
            host.querySelectorAll(`[data-mdo-qa="${f.k}"]`).forEach(el => {
                const q = el.querySelector('.mdo-qa-q')?.value ?? '';
                const a = el.querySelector('.mdo-qa-a')?.value ?? '';
                const visible = el.querySelector('[data-mdo-sub="visible"]')?.checked !== false;
                items.push({ q, a, visible });
            });
            out[f.k] = items;
            return;
        }
        if (f.kind === 'paras') {
            const arr = [];
            host.querySelectorAll(`[data-mdo-k="${f.k}"][data-mdo-i]`).forEach(el => arr.push(el.value ?? ''));
            out[f.k] = arr;
            return;
        }
        const el = host.querySelector(`#mdo_${f.k}`);
        if (!el) return;
        out[f.k] = (f.kind === 'toggle') ? el.checked : el.value;
    });
    return out;
}

function _mdoWire() {
    const host = document.getElementById('mdoWebsiteContent');
    if (!host) return;

    // Delegated, because the panel is rebuilt on every section switch and
    // every list change — handlers bound to the controls themselves would be
    // thrown away by the first edit.
    host.addEventListener('input', () => { _mdoDirty = true; }, { once: true });

    host.querySelectorAll('[data-mdo-section]').forEach(btn => {
        btn.addEventListener('click', () => {
            const next = btn.getAttribute('data-mdo-section');
            if (next === _mdoOpen) return;
            if (_mdoDirty && !confirm('You have unsaved changes on this section. Leave them?')) return;
            // Keep what was typed on the section being left, so switching back
            // and forth does not silently discard an edit in progress.
            const cur = _mdoCollect();
            if (cur && _mdoRows[_mdoOpen]) _mdoRows[_mdoOpen].draft = cur;
            _mdoOpen = next; _mdoDirty = false; _mdoRender();
        });
    });

    const save = document.getElementById('mdoSaveBtn');
    if (save) save.addEventListener('click', async () => {
        const content = _mdoCollect();
        if (!content) return;
        save.disabled = true;
        const ok = await saveMdoDraft(_mdoOpen, content);
        save.disabled = false;
        if (!ok) { showToast('Could not save. Your changes are still on screen — try again.', 'error'); return; }
        if (_mdoRows[_mdoOpen]) _mdoRows[_mdoOpen].draft = content;
        _mdoDirty = false;
        showToast('Draft saved. The website is unchanged until you publish.', 'ok');
        _mdoRender();
    });

    const pub = document.getElementById('mdoPublishBtn');
    if (pub) pub.addEventListener('click', async () => {
        const content = _mdoCollect();
        if (!content) return;
        if (!confirm('Publish this section to mdo.timothystl.org? Families will see it straight away.')) return;
        pub.disabled = true;
        // Save first, so publishing always puts what is on screen live rather
        // than whatever was last saved.
        const saved = await saveMdoDraft(_mdoOpen, content);
        if (!saved) { pub.disabled = false; showToast('Could not save, so nothing was published.', 'error'); return; }
        const ok = await publishMdoSection(_mdoOpen);
        pub.disabled = false;
        if (!ok) { showToast('Saved, but publishing was refused. Publishing needs full access.', 'error'); return; }
        showToast('Published. It is on the website now.', 'ok');
        renderMdoWebsiteTool();
    });

    const dis = document.getElementById('mdoDiscardBtn');
    if (dis) dis.addEventListener('click', async () => {
        const row = _mdoRow(_mdoOpen);
        if (row.published == null) {
            showToast('Nothing has been published for this section yet, so there is no earlier version to go back to.', 'error');
            return;
        }
        if (!confirm('Throw away your changes and go back to what is on the website now?')) return;
        const ok = await discardMdoDraft(_mdoOpen);
        if (!ok) { showToast('Could not discard the draft.', 'error'); return; }
        _mdoDirty = false;
        showToast('Your changes were discarded.', 'ok');
        renderMdoWebsiteTool();
    });

    const hist = document.getElementById('mdoHistoryBtn');
    if (hist) hist.addEventListener('click', async () => {
        const box = document.getElementById('mdoHistory');
        if (!box) return;
        if (!box.hidden) { box.hidden = true; return; }
        box.hidden = false;
        box.innerHTML = '<p class="muted">Loading…</p>';
        const revs = await fetchMdoRevisions(_mdoOpen);
        if (!revs.length) { box.innerHTML = '<p class="muted">This section has never been published, so there is no history yet.</p>'; return; }
        box.innerHTML = `<h4 class="mdo-h4">Previously published</h4>` + revs.map(r => {
            const when = new Date(r.published_at).toLocaleString('en-US', {
                month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit'
            });
            return `<div class="mdo-rev"><span>${escHtml(when)}${r.published_by ? ` · ${escHtml(r.published_by)}` : ''}</span>
              <button type="button" class="btn btn-secondary btn-sm" data-mdo-restore="${r.id}">Load this version</button></div>`;
        }).join('') +
        `<p class="mdo-hint">Loading an older version puts it back in the editor for you to read. It does not go on the website until you publish it.</p>`;
        box.querySelectorAll('[data-mdo-restore]').forEach(b => b.addEventListener('click', async () => {
            if (!confirm('Load this version into the editor? Your current unsaved changes will be replaced.')) return;
            const ok = await restoreMdoRevision(Number(b.getAttribute('data-mdo-restore')));
            if (!ok) { showToast('Could not load that version.', 'error'); return; }
            _mdoDirty = false;
            showToast('Loaded. Read it over, then publish if it looks right.', 'ok');
            renderMdoWebsiteTool();
        }));
    });

    // Repeatable question lists — add / remove / reorder. Each rewrites the
    // draft from the DOM first so nothing typed is lost to a re-render.
    const mutate = (fn) => {
        const cur = _mdoCollect();
        if (!cur) return;
        fn(cur);
        if (_mdoRows[_mdoOpen]) _mdoRows[_mdoOpen].draft = cur;
        else _mdoRows[_mdoOpen] = { draft: cur, published: null };
        _mdoDirty = true;
        _mdoRender();
    };

    host.querySelectorAll('[data-mdo-add]').forEach(b => b.addEventListener('click', () => {
        const k = b.getAttribute('data-mdo-add');
        mutate(cur => { cur[k] = (cur[k] || []).concat([{ q: '', a: '', visible: true }]); });
    }));
    host.querySelectorAll('[data-mdo-del]').forEach(b => b.addEventListener('click', () => {
        const k = b.getAttribute('data-mdo-del'), i = Number(b.getAttribute('data-mdo-i'));
        if (!confirm('Remove this question?')) return;
        mutate(cur => { (cur[k] || []).splice(i, 1); });
    }));
    host.querySelectorAll('[data-mdo-move]').forEach(b => b.addEventListener('click', () => {
        const k = b.getAttribute('data-mdo-k'), i = Number(b.getAttribute('data-mdo-i'));
        const dir = b.getAttribute('data-mdo-move') === 'up' ? -1 : 1;
        mutate(cur => {
            const a = cur[k] || []; const j = i + dir;
            if (j < 0 || j >= a.length) return;
            [a[i], a[j]] = [a[j], a[i]];
        });
    }));
}
