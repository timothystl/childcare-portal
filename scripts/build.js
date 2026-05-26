#!/usr/bin/env node
// ============================================================
// Build script — minifies JS files for production deployment.
//
// Usage:
//   npm run build          (one-shot, used by Cloudflare Pages CI)
//   npm run build:watch    (watch mode for local development)
//
// Output:
//   dist/supabase.min.js   — shared data layer
//   dist/app.min.js        — parent portal
//   dist/lookup.min.js     — schedule lookup
//   dist/admin.min.js      — admin dashboard (all 10 modules bundled)
//   dist/error-monitor.min.js
//
// HTML pages are automatically updated to reference dist/ files
// during the build (see patchHtml below). The source js/ files
// remain unmodified so development still works without building.
// ============================================================

const esbuild      = require('esbuild');
const fs           = require('fs');
const path         = require('path');
const { execSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

// ── Build version (short SHA + date) ──────────────────────────
// Cloudflare Pages sets CF_PAGES_COMMIT_SHA; locally we fall back to `git rev-parse`.
function writeBuildVersion() {
    let sha = process.env.CF_PAGES_COMMIT_SHA || '';
    if (!sha) {
        try { sha = execSync('git rev-parse HEAD', { cwd: ROOT }).toString().trim(); }
        catch { sha = ''; }
    }
    const shortSha = sha ? sha.slice(0, 7) : 'dev';
    const date     = new Date().toISOString().slice(0, 10);
    const contents = `window.__BUILD_VERSION__ = ${JSON.stringify(`${shortSha} · ${date}`)};\n`;
    fs.writeFileSync(path.join(ROOT, 'js/build-version.js'), contents);
    console.log('[build] version:', `${shortSha} · ${date}`);
}
writeBuildVersion();

const watch = process.argv.includes('--watch');

// ── Bundle definitions ────────────────────────────────────────
// Each entry bundles one logical unit into a single minified file.
// The admin modules are listed in load order so globals declared
// in earlier modules are available to later ones after bundling.
const ENTRIES = [
    {
        outfile: 'dist/supabase.min.js',
        stdin: {
            contents: fs.readFileSync(path.join(ROOT, 'js/supabase.js'), 'utf8'),
            resolveDir: ROOT,
        },
    },
    {
        outfile: 'dist/error-monitor.min.js',
        stdin: {
            contents: fs.readFileSync(path.join(ROOT, 'js/error-monitor.js'), 'utf8'),
            resolveDir: ROOT,
        },
    },
    {
        outfile: 'dist/app.min.js',
        stdin: {
            contents: fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8'),
            resolveDir: ROOT,
        },
    },
    {
        outfile: 'dist/lookup.min.js',
        stdin: {
            contents: fs.readFileSync(path.join(ROOT, 'js/lookup.js'), 'utf8'),
            resolveDir: ROOT,
        },
    },
    {
        // Admin dashboard: concatenate all modules in dependency order
        outfile: 'dist/admin.min.js',
        stdin: {
            contents: [
                'js/admin/admin-core.js',
                'js/admin/admin-init.js',
                'js/admin/admin-calendar.js',
                'js/admin/admin-classrooms.js',
                'js/admin/admin-families.js',
                'js/admin/admin-reports.js',
                'js/admin/admin-staffing.js',
                'js/admin/admin-messages.js',
                'js/admin/admin-settings.js',
                'js/admin/admin-waitlist.js',
            ].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n'),
            resolveDir: ROOT,
        },
    },
];

// ── Build ─────────────────────────────────────────────────────
const BASE_OPTS = {
    bundle:    false,   // files are already written as plain globals, not modules
    minify:    true,
    sourcemap: true,    // source maps for debugging minified output
    target:    ['es2017'],
    logLevel:  'info',
};

async function build() {
    for (const entry of ENTRIES) {
        await esbuild.build({
            ...BASE_OPTS,
            stdin:   entry.stdin,
            outfile: path.join(ROOT, entry.outfile),
        });
    }
    console.log('\n✓ Build complete →', DIST);
}

if (watch) {
    // Watch mode: rebuild whenever source files change
    (async () => {
        const contexts = await Promise.all(
            ENTRIES.map(entry =>
                esbuild.context({
                    ...BASE_OPTS,
                    stdin:   entry.stdin,
                    outfile: path.join(ROOT, entry.outfile),
                })
            )
        );
        await Promise.all(contexts.map(ctx => ctx.watch()));
        console.log('[esbuild] watching for changes…');
    })();
} else {
    build().catch(err => { console.error(err); process.exit(1); });
}
