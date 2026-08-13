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
//   dist/app.min.js        — parent registration flow (index/calendar)
//   dist/lookup.min.js     — schedule lookup
//   dist/portal.min.js     — parent portal (portal.html)
//   dist/admin.min.js      — admin dashboard (all modules bundled)
//   dist/error-monitor.min.js
//
// HTML pages are automatically updated to reference dist/ files
// during the build (see patchHtml below). The source js/ files
// remain unmodified so development still works without building.
// ============================================================

const esbuild      = require('esbuild');
const fs           = require('fs');
const path         = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

// ── Build version ─────────────────────────────────────────────
// Version comes from package.json only — no git commit count — so the
// committed js/build-version.js is always the canonical source of truth
// regardless of whether the site serves bundled or unbundled JS.
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const BUILD_VERSION = `v${pkg.version}`;
fs.writeFileSync(path.join(ROOT, 'js/build-version.js'), `window.__BUILD_VERSION__ = ${JSON.stringify(BUILD_VERSION)};\n`);
console.log('[build] version:', BUILD_VERSION);

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
        outfile: 'dist/inquiry.min.js',
        stdin: {
            contents: fs.readFileSync(path.join(ROOT, 'js/inquiry.js'), 'utf8'),
            resolveDir: ROOT,
        },
    },
    {
        outfile: 'dist/confirm-interest.min.js',
        stdin: {
            contents: fs.readFileSync(path.join(ROOT, 'js/confirm-interest.js'), 'utf8'),
            resolveDir: ROOT,
        },
    },
    {
        outfile: 'dist/waitlist-status.min.js',
        stdin: {
            contents: fs.readFileSync(path.join(ROOT, 'js/waitlist-status.js'), 'utf8'),
            resolveDir: ROOT,
        },
    },
    {
        outfile: 'dist/menu.min.js',
        stdin: {
            contents: fs.readFileSync(path.join(ROOT, 'js/menu.js'), 'utf8'),
            resolveDir: ROOT,
        },
    },
    {
        // Staff phone app — quick log, room roster.
        outfile: 'dist/staff.min.js',
        stdin: {
            contents: [
                'js/staff/staff-nav.js',
        'js/staff/staff-log.js',
            ].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n'),
            resolveDir: ROOT,
        },
    },
    {
        // Parent portal. One file today (sign-in); Phase 1 adds the Today feed,
        // day report and photo grid as further js/portal/ modules concatenated
        // here in load order, the way the admin bundle does it.
        outfile: 'dist/portal.min.js',
        stdin: {
            contents: [
                // Load order matters: portal-auth calls ptLoadToday() once a
                // session exists, so the feed's functions must already exist.
                'js/portal/portal-nav.js',
        'js/portal/portal-account.js',
        'js/portal/portal-today.js',
                'js/portal/portal-messages.js',
                'js/portal/portal-auth.js',
            ].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n'),
            resolveDir: ROOT,
        },
    },
    {
        // Admin dashboard: concatenate all modules in dependency order
        outfile: 'dist/admin.min.js',
        stdin: {
            contents: [
                // Inline version so it's baked into the bundle at build time
                `window.__BUILD_VERSION__ = ${JSON.stringify(BUILD_VERSION)};`,
                'js/admin/admin-core.js',
                'js/admin/admin-init.js',
                'js/admin/admin-calendar.js',
                'js/admin/admin-classrooms.js',
                'js/admin/admin-families.js',
                'js/admin/admin-messages.js',
                'js/admin/admin-reports.js',
                'js/admin/admin-finance.js',
                'js/admin/admin-billing.js',
                'js/admin/admin-staffing.js',
                'js/admin/admin-settings.js',
                'js/admin/admin-waitlist.js',
                'js/admin/admin-incidents.js',
                'js/admin/admin-threads.js',
                'js/admin/admin-cacfp.js',
                'js/admin/admin-market.js',
                // Last: the portal shell indexes the sections the modules above
                // own, and calls into their loaders when a tool is opened.
                'js/admin/admin-portal.js',
            ].map((f, i) => i === 0 ? f : fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n'),
            resolveDir: ROOT,
        },
    },
];

// ── HTML patching ─────────────────────────────────────────────
// Replaces dev <script> tags with the production bundles so the
// built HTML loads minified files from dist/ instead of source js/.
const HTML_PATCHES = [
    {
        file: 'admin.html',
        // Remove individual admin script tags + build-version tag, replace with bundle
        remove: [
            /<script src="js\/build-version\.js"><\/script>\n/,
            /<script src="js\/supabase\.js[^"]*"><\/script>\n/,
            /<script src="js\/error-monitor\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-core\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-init\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-calendar\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-classrooms\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-families\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-reports\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-staffing\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-messages\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-settings\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-waitlist\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-finance\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-billing\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-cacfp\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-market\.js"><\/script>\n/,
            /<script src="js\/admin\/admin-portal\.js"><\/script>\n/,
        ],
        // Insert bundles before </body>
        insert: [
            `    <script src="dist/supabase.min.js"></script>`,
            `    <script src="dist/error-monitor.min.js"></script>`,
            `    <script src="dist/admin.min.js"></script>`,
        ],
    },
    {
        file: 'index.html',
        remove: [
            /<script src="js\/supabase\.js[^"]*"><\/script>\n/,
            /<script src="js\/error-monitor\.js"><\/script>\n/,
            /<script src="js\/app\.js[^"]*"><\/script>\n/,
        ],
        insert: [
            `    <script src="dist/supabase.min.js"></script>`,
            `    <script src="dist/error-monitor.min.js"></script>`,
            `    <script src="dist/app.min.js"></script>`,
        ],
    },
    {
        file: 'lookup.html',
        remove: [
            /<script src="js\/supabase\.js[^"]*"><\/script>\n/,
            /<script src="js\/error-monitor\.js"><\/script>\n/,
            /<script src="js\/lookup\.js[^"]*"><\/script>\n/,
        ],
        insert: [
            `    <script src="dist/supabase.min.js"></script>`,
            `    <script src="dist/error-monitor.min.js"></script>`,
            `    <script src="dist/lookup.min.js"></script>`,
        ],
    },
    {
        file: 'inquiry.html',
        remove: [
            /<script src="js\/supabase\.js[^"]*"><\/script>\n/,
            /<script src="js\/error-monitor\.js"><\/script>\n/,
            /<script src="js\/inquiry\.js[^"]*"><\/script>\n/,
        ],
        insert: [
            `    <script src="dist/supabase.min.js"></script>`,
            `    <script src="dist/error-monitor.min.js"></script>`,
            `    <script src="dist/inquiry.min.js"></script>`,
        ],
    },
    {
        file: 'confirm-interest.html',
        remove: [
            /<script src="js\/supabase\.js[^"]*"><\/script>\n/,
            /<script src="js\/error-monitor\.js"><\/script>\n/,
            /<script src="js\/confirm-interest\.js[^"]*"><\/script>\n/,
        ],
        insert: [
            `    <script src="dist/supabase.min.js"></script>`,
            `    <script src="dist/error-monitor.min.js"></script>`,
            `    <script src="dist/confirm-interest.min.js"></script>`,
        ],
    },
    {
        file: 'waitlist-status.html',
        remove: [
            /<script src="js\/supabase\.js[^"]*"><\/script>\n/,
            /<script src="js\/error-monitor\.js"><\/script>\n/,
            /<script src="js\/waitlist-status\.js[^"]*"><\/script>\n/,
        ],
        insert: [
            `    <script src="dist/supabase.min.js"></script>`,
            `    <script src="dist/error-monitor.min.js"></script>`,
            `    <script src="dist/waitlist-status.min.js"></script>`,
        ],
    },
    {
        file: 'staff.html',
        remove: [
            /<script src="js\/supabase\.js[^"]*"><\/script>\n/,
            /<script src="js\/error-monitor\.js"><\/script>\n/,
            /<script src="js\/staff\/staff-log\.js[^"]*"><\/script>\n/,
        ],
        insert: [
            `    <script src="dist/supabase.min.js"></script>`,
            `    <script src="dist/error-monitor.min.js"></script>`,
            `    <script src="dist/staff.min.js"></script>`,
        ],
    },
    {
        file: 'portal.html',
        remove: [
            /<script src="js\/supabase\.js[^"]*"><\/script>\n/,
            /<script src="js\/error-monitor\.js"><\/script>\n/,
            /<script src="js\/portal\/portal-auth\.js[^"]*"><\/script>\n/,
        ],
        insert: [
            `    <script src="dist/supabase.min.js"></script>`,
            `    <script src="dist/error-monitor.min.js"></script>`,
            `    <script src="dist/portal.min.js"></script>`,
        ],
    },
    {
        file: 'menu.html',
        remove: [
            /<script src="js\/supabase\.js[^"]*"><\/script>\n/,
            /<script src="js\/error-monitor\.js"><\/script>\n/,
            /<script src="js\/menu\.js[^"]*"><\/script>\n/,
        ],
        insert: [
            `    <script src="dist/supabase.min.js"></script>`,
            `    <script src="dist/error-monitor.min.js"></script>`,
            `    <script src="dist/menu.min.js"></script>`,
        ],
    },
];

function patchHtml() {
    HTML_PATCHES.forEach(({ file, remove, insert }) => {
        const filePath = path.join(ROOT, file);
        if (!fs.existsSync(filePath)) return;
        let html = fs.readFileSync(filePath, 'utf8');

        // Remove the source dev <script src="js/..."> tags.
        remove.forEach(re => { html = html.replace(re, ''); });

        // Idempotency guard: also strip ANY existing dist bundle tags we're about
        // to insert. Without this, re-running the build (e.g. Cloudflare on each
        // deploy, operating on already-patched committed HTML) appends a *second*
        // set of <script> tags every time — which is how this file accumulated
        // duplicate/triplicate bundle loads that broke the pages.
        insert.forEach(tag => {
            const src = tag.match(/src="([^"]+)"/)[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            html = html.replace(new RegExp(`[ \\t]*<script src="${src}"></script>\\n`, 'g'), '');
        });

        html = html.replace('</body>', insert.join('\n') + '\n</body>');
        fs.writeFileSync(filePath, html);
        console.log('[build] patched', file);
    });
}

// ── Build ─────────────────────────────────────────────────────
const BASE_OPTS = {
    bundle:    false,   // files are already written as plain globals, not modules
    minify:    true,
    sourcemap: false,
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
    if (!watch) patchHtml();
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
