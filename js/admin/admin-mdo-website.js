// ============================================================
// MDO WEBSITE — what the public home page shows
// ============================================================
// Switches, not an editor. The words on mdo.timothystl.org are hardcoded in
// index.html and change through a developer; what this screen owns is the
// handful of blocks that come and go with the season.
//
// ⚠️ THIS REPLACED A THREE-SECTION CONTENT EDITOR, AND THE REASON IS WORTH
// KEEPING. That editor (hero / FAQs / contact, drafts in `mdo_site_content`)
// was built because the church site's block editor lives in another app with
// no shared credential. But the church admin's own `/api/pages` is public by
// design — a separate worker is meant to read it — so "add the MDO page to
// the editor we already have" was a real option that was never weighed. It
// was still the wrong build for a page nobody edits twice a year, and the
// director's call was to keep the page hardcoded and narrow this screen to
// the switches. Nothing was ever published from the old editor; all three
// drafts were untouched seed rows, so nothing a person wrote was lost.
//
// ⚠️ NOTHING HERE WRITES A KEY ANOTHER SCREEN ALSO WRITES. Two of the three
// switches below already had a control on the Settings screen, and this one
// shows their live state and links there rather than offering a second form
// over the same key — that is how the two come to disagree.

// A switch this screen OWNS: it exists for the website and nothing else reads
// it. `hide` semantics throughout, so an unreadable setting leaves the page
// as it is rather than stripping a block out of it.
const MDO_SITE_TOGGLES = [
    {
        key: 'mdo_hide_banner',
        label: 'Announcement strip',
        onText: 'Hidden',
        offText: 'Showing',
        blurb: 'The gold strip under the hero. Switch it off out of season; ask for new wording any time.',
        // The live copy, so the screen says what is actually being shown
        // rather than describing a strip in the abstract.
        quote: '✨ New this year: Request your care days online — no paper forms needed.',
    },
];

// Switches OWNED ELSEWHERE that this page obeys. Read-only here, on purpose.
const MDO_SITE_MIRRORS = [
    {
        key: 'hide_summer_camp',
        label: 'Summer Camp block',
        onText: 'Hidden',
        offText: 'Showing',
        blurb: 'The same switch that hides the Summer room from registration. It now hides the block on the home page too — before this, the site went on advertising summer camp after the office had switched it off.',
        where: 'Settings → Registration',
    },
    {
        key: 'enrollment_at_capacity',
        label: 'At capacity for new enrollments',
        onText: 'Showing the notice',
        offText: 'Not shown',
        blurb: 'Grays out “View Enrollment Forms” and shows the at-capacity note in the Get Started band.',
        where: 'Settings → Registration',
    },
];

function _mdoIsOn(value) {
    return value === true || value === 'true';
}

// ⚠️ NOT `.ap-pill` — that is a clickable chip with a hover state, and this
// is a status word. Its own class, scoped to this screen.
function _mdoStatusPill(on, onText, offText) {
    const tone = on ? 'is-off' : 'is-on';
    return `<span class="mdo-state ${tone}">${escHtml(on ? onText : offText)}</span>`;
}

async function renderMdoWebsiteTool() {
    const host = document.getElementById('mdoWebsiteContent');
    if (!host) return;
    host.innerHTML = '<p class="muted">Loading…</p>';

    const keys = [...MDO_SITE_TOGGLES, ...MDO_SITE_MIRRORS].map(t => t.key);
    let values = {};
    try {
        const read = await Promise.all(keys.map(k => fetchSetting(k)));
        keys.forEach((k, i) => { values[k] = read[i]; });
    } catch (e) {
        host.innerHTML = `<div class="ap-panel"><div class="ap-panel-body">
            <p><strong>Could not read the website switches.</strong></p>
            <p class="muted">${escHtml(e.message || String(e))}</p>
            <p class="muted">The public page is unaffected — it renders whatever it was already showing.</p>
        </div></div>`;
        return;
    }

    const ownRows = MDO_SITE_TOGGLES.map(t => {
        const on = _mdoIsOn(values[t.key]);
        return `<div class="mdo-row">
            <div class="mdo-row-main">
                <div class="mdo-row-head">
                    <strong>${escHtml(t.label)}</strong>
                    ${_mdoStatusPill(on, t.onText, t.offText)}
                </div>
                <p class="muted">${escHtml(t.blurb)}</p>
                ${t.quote ? `<p class="mdo-quote">${escHtml(t.quote)}</p>` : ''}
            </div>
            <label class="mdo-switch">
                <input type="checkbox" data-mdo-toggle="${escHtml(t.key)}"${on ? ' checked' : ''}>
                <span>Hide it</span>
            </label>
        </div>`;
    }).join('');

    const mirrorRows = MDO_SITE_MIRRORS.map(t => {
        const on = _mdoIsOn(values[t.key]);
        return `<div class="mdo-row">
            <div class="mdo-row-main">
                <div class="mdo-row-head">
                    <strong>${escHtml(t.label)}</strong>
                    ${_mdoStatusPill(on, t.onText, t.offText)}
                </div>
                <p class="muted">${escHtml(t.blurb)}</p>
            </div>
            <div class="mdo-row-where">
                <span class="muted">Changed in</span><br>
                <button type="button" class="ap-pill" data-ap-go="settingsHub">${escHtml(t.where)}</button>
            </div>
        </div>`;
    }).join('');

    host.innerHTML = `
        <div class="ap-panel tone-green">
            <div class="ap-panel-head"><h3>Seasonal blocks</h3></div>
            <div class="ap-panel-body">
                <p class="muted">Switches for the parts of <a href="https://mdo.timothystl.org" target="_blank" rel="noopener">mdo.timothystl.org</a> that come and go. A change takes effect on the next page load — there is no draft and nothing to publish.</p>
                ${ownRows}
                <p id="mdoToggleStatus" class="muted" aria-live="polite"></p>
            </div>
        </div>

        <div class="ap-panel">
            <div class="ap-panel-head"><h3>Switches that live on another screen</h3></div>
            <div class="ap-panel-body">
                <p class="muted">These change what the home page shows, but they are not this screen's to write — one key, one control, so the two can never disagree.</p>
                ${mirrorRows}
            </div>
        </div>

        <div class="ap-panel">
            <div class="ap-panel-head"><h3>Everything else on the page</h3></div>
            <div class="ap-panel-body">
                <p class="muted">The wording, photographs and layout are part of the site itself and change through a developer. The classrooms, ages, rates, capacity, ratios, fees and staff list are not written here either — they come straight from Settings, which is what keeps the figures on the website and the figures the billing runs on the same figures.</p>
                <p><button type="button" class="ap-pill" data-ap-go="settingsHub">Open Settings</button></p>
            </div>
        </div>`;

    host.querySelectorAll('[data-mdo-toggle]').forEach((input) => {
        input.addEventListener('change', () => _mdoSaveToggle(input));
    });
}

// ⚠️ Saves on the switch itself — there is no Save button, because a toggle
// with a separate Save is a toggle somebody flips and walks away from. On a
// failure the checkbox is put back to what the database still says, so the
// screen never shows a state that was not stored.
async function _mdoSaveToggle(input) {
    const key = input.getAttribute('data-mdo-toggle');
    const want = input.checked;
    const statusEl = document.getElementById('mdoToggleStatus');
    input.disabled = true;
    if (statusEl) statusEl.textContent = 'Saving…';
    try {
        await upsertSetting(key, want);
        await logAdminAction('update', 'mdo_site_toggle', null, { key, hidden: want });
        if (statusEl) statusEl.textContent = '✓ Saved — the public page follows on its next load.';
        setTimeout(() => { if (statusEl && statusEl.textContent.startsWith('✓')) statusEl.textContent = ''; }, 4000);
        renderMdoWebsiteTool();
    } catch (e) {
        input.checked = !want;
        if (statusEl) statusEl.textContent = 'Could not save: ' + (e.message || String(e));
    } finally {
        input.disabled = false;
    }
}
