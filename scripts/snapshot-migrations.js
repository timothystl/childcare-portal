#!/usr/bin/env node
// ============================================================
// snapshot-migrations — refresh supabase/migrations/APPLIED_LEDGER.tsv
// ============================================================
// Reads the production migration ledger on STDIN and writes the committed
// snapshot that scripts/check-migrations.js diffs against.
//
// It takes the ledger on stdin rather than connecting to the database itself,
// on purpose: this script then needs no credentials, runs anywhere, and the
// person refreshing the snapshot has to have actually looked at production to
// do it. A snapshot generated from a guess is worse than no snapshot.
//
// HOW TO REFRESH — run this in the Supabase SQL Editor:
//
//   select version || E'\t' || coalesce(name, '')
//     from supabase_migrations.schema_migrations
//    order by version;
//
// then pipe the rows in:
//
//   npm run migrations:snapshot < rows.tsv
//
// Accepts either bare "version<TAB>name" lines or the JSON array the Supabase
// SQL Editor and MCP tools hand back, so you can paste whichever you have.
// ============================================================

const fs = require('fs');
const path = require('path');

const LEDGER = path.join(__dirname, '..', 'supabase', 'migrations', 'APPLIED_LEDGER.tsv');

function parse(raw) {
    const text = raw.trim();
    if (!text) throw new Error('Nothing on stdin. See the header of this file for how to get the rows.');

    const rows = [];
    const push = (version, name) => {
        version = String(version || '').trim();
        if (!/^\d{14}$/.test(version)) throw new Error(`Not a 14-digit version: "${version}"`);
        rows.push([version, String(name == null ? '' : name).trim()]);
    };

    if (text.startsWith('[') || text.startsWith('{')) {
        const data = JSON.parse(text);
        for (const row of Array.isArray(data) ? data : [data]) {
            if (typeof row === 'string') {
                const [v, n] = row.split('\t');
                push(v, n);
            } else {
                push(row.version, row.name);
            }
        }
    } else {
        for (const line of text.split('\n')) {
            if (!line.trim() || line.startsWith('#')) continue;
            // Tolerate tabs, or the "version|name" shape a string_agg produces.
            const [v, n] = line.includes('\t') ? line.split('\t') : line.split('|');
            push(v, n);
        }
    }

    rows.sort((a, b) => a[0].localeCompare(b[0]));
    const seen = new Set();
    for (const [v] of rows) {
        if (seen.has(v)) throw new Error(`Duplicate version in input: ${v}`);
        seen.add(v);
    }
    return rows;
}

const rows = parse(fs.readFileSync(0, 'utf8'));
const out = [
    '# Applied migration ledger — snapshot of supabase_migrations.schema_migrations',
    '# Production project dahdstopsumxnqvdclmy. Regenerate with: npm run migrations:snapshot',
    '# One row per applied version, oldest first.  version<TAB>name',
    ...rows.map(([v, n]) => `${v}\t${n}`),
    '',
].join('\n');

fs.writeFileSync(LEDGER, out);
console.log(`✓ Wrote ${rows.length} versions to ${path.relative(process.cwd(), LEDGER)}`);
console.log('  Now run: npm run migrations:check');
