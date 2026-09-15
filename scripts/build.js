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
//   dist/parent.min.js     — parent portal (parent.html)
//   dist/admin.min.js      — admin dashboard (all modules bundled)
//   dist/error-monitor.min.js
//
// HTML pages are automatically updated to reference dist/ files
// during the build (see patchHtml below). The source js/ files
// remain unmodified so development still works without building.
//
// Also copies the self-hosted TinyMCE/DOMPurify files the newsletter's
// Text block needs into vendor/ (see vendorAssets below) — same
// generated-but-committed treatment as dist/, since production serves
// both directly with no npm install step of its own.
// ============================================================

const esbuild      = require('esbuild');
const fs           = require('fs');
const path         = require('path');

const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');

if (!fs.existsSync(DIST)) fs.mkdirSync(DIST, { recursive: true });

// ── Vendored third-party assets ─────────────────────────────────
// Self-hosted (never a cloud CDN or an API key): the newsletter's rich
// text block needs a WYSIWYG editor and something to sanitize the HTML
// it produces before that HTML is ever re-rendered. Only the pieces
// actually used are copied — not all of node_modules/tinymce's plugins
// and languages — so vendor/ stays small.
const VENDOR_FILES = [
    ['tinymce/tinymce.min.js',                 'tinymce/tinymce.min.js'],
    ['tinymce/models/dom/model.min.js',        'tinymce/models/dom/model.min.js'],
    ['tinymce/themes/silver/theme.min.js',     'tinymce/themes/silver/theme.min.js'],
    ['tinymce/icons/default/icons.min.js',     'tinymce/icons/default/icons.min.js'],
    ['tinymce/skins/ui/oxide/skin.min.css',    'tinymce/skins/ui/oxide/skin.min.css'],
    ['tinymce/skins/ui/oxide/content.min.css', 'tinymce/skins/ui/oxide/content.min.css'],
    ['tinymce/skins/content/default/content.min.css', 'tinymce/skins/content/default/content.min.css'],
    ['tinymce/plugins/lists/plugin.min.js',    'tinymce/plugins/lists/plugin.min.js'],
    ['tinymce/plugins/link/plugin.min.js',     'tinymce/plugins/link/plugin.min.js'],
    ['tinymce/plugins/autolink/plugin.min.js', 'tinymce/plugins/autolink/plugin.min.js'],
    ['dompurify/dist/purify.min.js',           'dompurify/purify.min.js'],
];

function vendorAssets() {
    const nodeModules = path.join(ROOT, 'node_modules');
    const vendorDir = path.join(ROOT, 'vendor');
    VENDOR_FILES.forEach(([from, to]) => {
        const src = path.join(nodeModules, from);
        const dest = path.join(vendorDir, to);
        if (!fs.existsSync(src)) {
            throw new Error(`[build] vendor source missing: ${from} — run npm install`);
        }
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(src, dest);
    });
    console.log('[build] vendored', VENDOR_FILES.length, 'files →', vendorDir);
}

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
        outfile: 'dist/app-update.min.js',
        stdin: {
            contents: fs.readFileSync(path.join(ROOT, 'js/app-update.js'), 'utf8'),
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
        // The tablet at the door (design handoff: Capacity & Fill, 4a/5b/5d).
        // Standalone: it authenticates a family with family_login and holds
        // no app state of its own.
        outfile: 'dist/kiosk.min.js',
        stdin: {
            contents: fs.readFileSync(path.join(ROOT, 'js/kiosk.js'), 'utf8'),
            resolveDir: ROOT,
        },
    },
    {
        // Public tour booking (design handoff: Capacity & Fill, 2b). Same
        // shape as inquiry: one standalone page, no app state.
        outfile: 'dist/tour.min.js',
        stdin: {
            contents: fs.readFileSync(path.join(ROOT, 'js/tour.js'), 'utf8'),
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
        // The signed incident report. Standalone page: it is opened in a new
        // tab from both the admin drawer and the parent's Documents tab, and it
        // must not depend on either app's state — everything it draws comes
        // from incident_print_record().
        outfile: 'dist/incident-print.min.js',
        stdin: {
            contents: fs.readFileSync(path.join(ROOT, 'js/incident-print.js'), 'utf8'),
            resolveDir: ROOT,
        },
    },
    {
        // The childcare statement. Standalone for the same reason the incident
        // report is: opened in a new tab from both the parent's Documents tab
        // and the admin portal, and every figure comes from
        // family_care_statement() rather than either app's state.
        outfile: 'dist/statement-print.min.js',
        stdin: {
            contents: fs.readFileSync(path.join(ROOT, 'js/statement-print.js'), 'utf8'),
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
                // After staff-log: reads slStaffId/slPin/slOpenChild/slChildren
                // and the toast helper from it.
                'js/staff/staff-incident.js',
                // After staff-log: reads slChildren/slRoomId/slQueue and
                // slEsc, and staff-log calls srhRender() when either changes.
                'js/staff/staff-room-head.js',
                'js/staff/staff-schedule.js',
                // Reads slStaffId/slPin/slToast and compressImageToDataUrl;
                // slOpenAccountTab is called by staff-nav.
                'js/staff/staff-credentials.js',
                // Last: the head count reads slStaffId/slPin/slRoomId and the
                // toast helper from staff-log, and staff-nav calls into it.
                'js/staff/staff-headcount.js',
                // Last: reads hcRoomLabel/hcSplit from the head count, and
                // slToast/slStaffId from staff-log.
                'js/staff/staff-missing.js',
                // Reads slStaffId/slPin/slToast; slBroadcastMissing is called
                // by staff-missing, so it only has to exist by the time a
                // teacher taps, not at parse time.
                'js/staff/staff-push.js',
            ].map(f => fs.readFileSync(path.join(ROOT, f), 'utf8')).join('\n'),
            resolveDir: ROOT,
        },
    },
    {
        // Parent portal. One file today (sign-in); Phase 1 adds the Today feed,
        // day report and photo grid as further js/parent/ modules concatenated
        // here in load order, the way the admin bundle does it.
        outfile: 'dist/parent.min.js',
        stdin: {
            contents: [
                // Load order matters: parent-auth calls ptLoadToday() once a
                // session exists, so the feed's functions must already exist.
                'js/parent/parent-nav.js',
        'js/parent/parent-account.js',
        'js/parent/parent-schedule.js',
        'js/parent/parent-billing.js',
                // After parent-schedule.js: the drop-in card reads psSchedule()
                // for closures and the child's already-booked dates, and
                // psDayRate() for the rate it quotes. Before parent-today.js,
                // which calls pdiSetup()/pdiRender() as it builds the feed.
                'js/parent/parent-dropin.js',
                // After parent-schedule.js, which calls ppSetup()/ppLoad()
                // once it knows which child is showing. Reads
                // loadProgramSettings() from js/supabase.js.
                'js/parent/parent-programs.js',
        'js/parent/parent-today.js',
                // After parent-today: reuses its PT_EVENT label map, ptEsc/ptTime/
                // ptToday helpers, and ptChildren/ptActiveId.
                'js/parent/parent-recap.js',
                'js/parent/parent-messages.js',
                // After parent-today: reads ptChildren for the child's name on
                // an incident row and for singular/plural wording.
                'js/parent/parent-documents.js',
                'js/parent/parent-auth.js',
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
                // Reads getRosterForDate()/getSortedRooms() from admin-classrooms.js
                // above and centerHeadcountAdmin() from admin-attendance.js below —
                // load order doesn't gate calls in one concatenated script, but
                // keeping it after both is the honest place to read it.
                'js/admin/admin-print-attendance.js',
                // Next to Print Attendance, which it is the digital half of.
                // Reads centerHeadcountAdmin() and the day's child_day_events;
                // writes nothing.
                'js/admin/admin-signature-record.js',
                // Reads PM_COMBINED_ROOM_IDS/PM_COMBINED_RATIO and
                // loadProgramSettings() from js/supabase.js, and the same
                // registrations every capacity screen reads. Writes nothing.
                'js/admin/admin-before-after-care.js',
                // After admin-calendar.js: reuses showDayRosterDetail(),
                // renderCapacityOverview() and renderRoomSchedule() as the
                // Enrollment & Capacity tool's Day/Month/Week sub-views.
                'js/admin/admin-enrollment-capacity.js',
                'js/admin/admin-families.js',
                // After admin-families.js (openFamilyModal, allFamiliesData) and
                // admin-calendar.js above (openEditDaysModal, allRegistrations):
                // the Director dashboard's Family Lookup panel reuses all four.
                'js/admin/admin-family-lookup.js',
                'js/admin/admin-reports.js',
                'js/admin/admin-finance.js',
                'js/admin/admin-billing.js',
                // Finance handoff screens — after admin-billing.js (reads
                // _buildArRows) and admin-reports.js (reads
                // _buildFamilyBillingData). Load order doesn't gate function
                // calls in one concatenated script (hoisting), but matching
                // the real dependency keeps the list honest to read.
                'js/admin/admin-bill-month.js',
                'js/admin/admin-billing-report.js',
                'js/admin/admin-who-owes.js',
                'js/admin/admin-finance-home.js',
                'js/admin/admin-finance-hub.js',
                // After admin-finance-hub.js (uses its _fhMonthLabel) and
                // admin-reports.js (calls _buildFamilyBillingData) — the
                // drawer's per-child breakdown. It computes nothing of its
                // own; see its header.
                'js/admin/admin-family-transactions.js',
                'js/admin/admin-finance-bookkeeper.js',
                'js/admin/admin-staffing.js',
                // After admin-reports.js (reads _buildPayrollPeriodList,
                // _payrollPeriodLabel and generatePayrollReport) — the
                // Overview tab reuses the period report's own calendar rather
                // than deriving a second one. Before admin-portal.js, whose
                // apSwitchPayrollTab() calls renderPayrollHomeTool().
                'js/admin/admin-payroll-home.js',
                'js/admin/admin-settings.js',
                'js/admin/admin-settings-unified.js',
                // After admin-settings-unified.js, which calls
                // renderProgramsTable() as it builds the Settings page.
                // Reads PROGRAMS/loadProgramSettings and PM_COMBINED_RATIO
                // from js/supabase.js.
                'js/admin/admin-programs.js',
                'js/admin/admin-waitlist.js',
                // After admin-waitlist.js: Fill the Rooms calls that module's
                // wlpRunAllocation()/wlpRankedKids()/wlRoomLabel() rather than
                // recomputing the queue, and reads TREND_DAYS from
                // admin-reports.js above. Before admin-portal.js, which
                // registers it as a tool and calls renderFillRoomsTool().
                'js/admin/admin-fill-rooms.js',
                // After admin-waitlist.js and admin-fill-rooms.js: the board
                // reuses wlDeriveRoom/wlRoomLabel/wlDaysLabel, hands a card
                // off to _openAdminWlModalForEdit(), and reads FR_STALL_DAYS
                // so "gone quiet" means the same thing on both screens.
                'js/admin/admin-leads.js',
                // After admin-leads.js and admin-calendar.js: reads closures,
                // the waitlist's tours, announcements, cacfp_menus and the
                // programs document, and writes none of them.
                'js/admin/admin-program-calendar.js',
                'js/admin/admin-attendance.js',
                'js/admin/admin-announcements.js',
                'js/admin/admin-incidents.js',
                'js/admin/admin-safety.js',
                'js/admin/admin-push.js',
                'js/admin/admin-messages-unified.js',
                // After admin-messages-unified.js (its tab neighbour) and
                // admin-calendar.js/admin-cacfp.js, whose fetches its live
                // blocks read. Writes only settings.newsletter_draft.
                'js/admin/admin-newsletter.js',
                'js/admin/admin-cacfp.js',
                'js/admin/admin-mdo-website.js',
                'js/admin/admin-market.js',
                // Last: the portal shell indexes the sections the modules above
                // own, and calls into their loaders when a tool is opened.
                'js/admin/admin-portal.js',
                // After the shell it extends: below 900px it takes over the
                // tab bar and four of the five dashboards (design handoff
                // "Admin Mobile Redesigns.dc.html", model 1a). Reads the same
                // apState.live the desktop dashboards read.
                'js/admin/admin-portal-mobile.js',
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
        file: 'kiosk.html',
        remove: [
            /<script src="js\/supabase\.js[^"]*"><\/script>\n/,
            /<script src="js\/error-monitor\.js"><\/script>\n/,
            /<script src="js\/kiosk\.js[^"]*"><\/script>\n/,
        ],
        insert: [
            `  <script src="dist/supabase.min.js"></script>`,
            `  <script src="dist/error-monitor.min.js"></script>`,
            `  <script src="dist/kiosk.min.js"></script>`,
        ],
    },
    {
        file: 'tour.html',
        remove: [
            /<script src="js\/supabase\.js[^"]*"><\/script>\n/,
            /<script src="js\/error-monitor\.js"><\/script>\n/,
            /<script src="js\/tour\.js[^"]*"><\/script>\n/,
        ],
        insert: [
            `    <script src="dist/supabase.min.js"></script>`,
            `    <script src="dist/error-monitor.min.js"></script>`,
            `    <script src="dist/tour.min.js"></script>`,
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
        file: 'incident-print.html',
        remove: [
            /<script src="js\/supabase\.js[^"]*"><\/script>\n/,
            /<script src="js\/incident-print\.js[^"]*"><\/script>\n/,
        ],
        insert: [
            `    <script src="dist/supabase.min.js"></script>`,
            `    <script src="dist/incident-print.min.js"></script>`,
        ],
    },
    {
        file: 'statement-print.html',
        remove: [
            /<script src="js\/supabase\.js[^"]*"><\/script>\n/,
            /<script src="js\/statement-print\.js[^"]*"><\/script>\n/,
        ],
        insert: [
            `    <script src="dist/supabase.min.js"></script>`,
            `    <script src="dist/statement-print.min.js"></script>`,
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
            `    <script src="dist/app-update.min.js"></script>`,
        ],
    },
    {
        file: 'parent.html',
        remove: [
            /<script src="js\/supabase\.js[^"]*"><\/script>\n/,
            /<script src="js\/error-monitor\.js"><\/script>\n/,
            /<script src="js\/parent\/parent-auth\.js[^"]*"><\/script>\n/,
        ],
        insert: [
            `    <script src="dist/supabase.min.js"></script>`,
            `    <script src="dist/error-monitor.min.js"></script>`,
            `    <script src="dist/parent.min.js"></script>`,
            `    <script src="dist/app-update.min.js"></script>`,
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
    vendorAssets();
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
    vendorAssets();
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
