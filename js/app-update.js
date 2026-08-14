// ============================================================
// app-update — pick up a deploy on resume
// ============================================================
// A PWA is not a compiled bundle: the home screen icon loads the live site, so
// a cold start always fetches current code. The gap is a WARM start. On iOS an
// installed app stays resident for days and tapping the icon RESUMES the frozen
// page rather than reloading it, so a parent can sit on a build from last week
// and nothing on screen looks wrong.
//
// So: when the app comes back to the foreground after being away, compare the
// build this page was loaded with against the one the server is serving now,
// and reload if they differ.
//
// ⚠️ Deliberately NOT a service-worker 'updatefound' listener. sw.js already
// calls skipWaiting() + clients.claim(), so a new worker takes over silently
// while the OLD page keeps running its old JS — the very state this fixes. The
// question here is "is this DOCUMENT stale", which only the document can answer.

(function () {
    'use strict';

    // Long enough that tab-switching to check a text message doesn't fire a
    // request every time, short enough that a genuine "opened it again later"
    // always does.
    const MIN_HIDDEN_MS = 60_000;

    // Never interrupt someone mid-sentence. A reload that discards a
    // half-completed registration form to install a CSS tweak is worse than
    // the staleness it fixes.
    const TEXT_ENTRY = new Set(['INPUT', 'TEXTAREA', 'SELECT']);

    let hiddenAt = 0;
    let checking = false;

    // The build this document is running. __BUILD_VERSION__ is the version of
    // record where build-version.js is bundled; where it isn't, fall back to
    // whatever the server was serving at load time, which by definition is the
    // code this page just received.
    let myVersion = (typeof window.__BUILD_VERSION__ === 'string')
        ? window.__BUILD_VERSION__
        : null;

    function unsafeToReload() {
        // Something focused and typable, an open <dialog>, or any form that has
        // been touched — all of them mean work in progress.
        const el = document.activeElement;
        if (el && TEXT_ENTRY.has(el.tagName) && !el.readOnly && !el.disabled) return true;
        if (document.querySelector('dialog[open]')) return true;
        for (const form of document.forms) {
            for (const field of form.elements) {
                if (!TEXT_ENTRY.has(field.tagName) || field.readOnly || field.disabled) continue;
                if (field.type === 'checkbox' || field.type === 'radio') {
                    if (field.checked !== field.defaultChecked) return true;
                } else if (field.value && field.value !== field.defaultValue) {
                    return true;
                }
            }
        }
        return false;
    }

    // The deployed version, read straight from the file the site already uses
    // as its version of record. cache: 'no-store' because the whole point is to
    // bypass whatever this page has been holding.
    async function deployedVersion() {
        const res = await fetch('/js/build-version.js?_=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) return null;
        const text = await res.text();
        const m = text.match(/__BUILD_VERSION__\s*=\s*["']([^"']+)["']/);
        return m ? m[1] : null;
    }

    async function checkForUpdate() {
        if (!myVersion || checking) return;
        checking = true;
        try {
            const live = await deployedVersion();
            if (!live || live === myVersion) return;
            if (unsafeToReload()) return;   // try again on the next resume
            console.info(`app-update: ${myVersion} → ${live}, reloading`);
            location.reload();
        } catch (_) {
            // Offline, or the request failed. Staying on the current build is
            // the correct outcome — this must never be able to break the app.
        } finally {
            checking = false;
        }
    }

    document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'hidden') {
            hiddenAt = Date.now();
            return;
        }
        if (hiddenAt && Date.now() - hiddenAt >= MIN_HIDDEN_MS) checkForUpdate();
        hiddenAt = 0;
    });

    // iOS fires pageshow with persisted=true when a page comes back from the
    // back/forward cache, which can skip visibilitychange entirely.
    window.addEventListener('pageshow', e => { if (e.persisted) checkForUpdate(); });

    // Establish the baseline when there is no bundled version global. Runs once,
    // at load, against a server that has just handed us this page.
    if (!myVersion) {
        deployedVersion().then(v => { myVersion = v; }).catch(() => {});
    }
})();
