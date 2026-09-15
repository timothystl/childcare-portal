#!/usr/bin/env node
// ============================================================
// check-migrations — the guard that keeps the ledger honest
// ============================================================
// THE BUG THIS EXISTS TO PREVENT
//
// Migrations reach this database through the Supabase dashboard, the CLI, or
// the MCP `apply_migration` tool. Every one of those stamps its OWN version
// from the clock at the moment it runs. A file committed as
// `20260915120000_track_stax_card_funding_type.sql` was recorded by the
// database as version `20260915002107` — same migration, same name, two
// different version numbers, because a human picked one and the server picked
// the other.
//
// Nothing complained at the time. It surfaced months later as
// "Remote migration versions not found in local migrations directory" on the
// Supabase Preview check, failing every single commit to main, by which point
// 114 versions had drifted and the failure had become background noise that
// nobody read.
//
// THE RULE, therefore: never invent a timestamp. Apply the migration first,
// ask the database what version it recorded, and name the file THAT. Then
// refresh the snapshot. See supabase/migrations/README.md.
//
// This script enforces the rule with no database access at all, so it can run
// in CI and in `npm test`: it diffs the migration filenames against
// APPLIED_LEDGER.tsv, a committed snapshot of what production actually has.
// If the two disagree, the drift is caught in the pull request that caused it
// rather than a quarter later.
// ============================================================

const fs = require('fs');
const path = require('path');

const repoRoot = path.resolve(__dirname, '..');
const MIG = path.join(repoRoot, 'supabase', 'migrations');
const LEDGER = path.join(MIG, 'APPLIED_LEDGER.tsv');

// Prefixes that are deliberately NOT part of the applied sequence. A file
// carrying one of these is source material — a proposal, a rollback, a
// verification query, or pre-ledger history — and must never be given a
// version prefix, because a version prefix is what makes the CLI try to run it.
const NON_MIGRATION = /^(PROPOSED|ROLLBACK|VERIFY|HISTORICAL)_/;

function readLedger() {
    if (!fs.existsSync(LEDGER)) {
        return { error: `Missing ${path.relative(repoRoot, LEDGER)} — run: npm run migrations:snapshot` };
    }
    const versions = new Map();
    for (const line of fs.readFileSync(LEDGER, 'utf8').split('\n')) {
        if (!line.trim() || line.startsWith('#')) continue;
        const [version, name] = line.split('\t');
        if (!/^\d{14}$/.test(version || '')) {
            return { error: `Bad ledger row (version must be 14 digits): ${line}` };
        }
        versions.set(version, name || '');
    }
    return { versions };
}

function checkMigrations() {
    const problems = [];
    const { versions, error } = readLedger();
    if (error) return [error];

    const files = fs.readdirSync(MIG).filter(f => f.endsWith('.sql'));
    const localVersions = new Map();

    for (const file of files) {
        if (NON_MIGRATION.test(file)) continue;
        const m = /^(\d+)_(.+)\.sql$/.exec(file);
        if (!m) {
            problems.push(
                `${file}: not a migration filename. Either name it ` +
                `<14-digit-version>_<name>.sql using the version the database ` +
                `recorded, or give it a PROPOSED_/ROLLBACK_/VERIFY_/HISTORICAL_ ` +
                `prefix so the CLI leaves it alone.`);
            continue;
        }
        const [, version] = m;
        if (version.length !== 14) {
            problems.push(
                `${file}: version "${version}" is ${version.length} digits, not 14. ` +
                `A short version sorts BEFORE every real migration, so \`supabase db push\` ` +
                `would try to run this file first.`);
            continue;
        }
        if (localVersions.has(version)) {
            problems.push(`Two files share version ${version}: ${localVersions.get(version)} and ${file}`);
            continue;
        }
        localVersions.set(version, file);
    }

    // Applied in production, missing here — the failure that started all this.
    for (const version of versions.keys()) {
        if (!localVersions.has(version)) {
            problems.push(
                `Version ${version} (${versions.get(version)}) is applied in production ` +
                `but has no file here. The Supabase check fails on exactly this.`);
        }
    }

    // Here but never applied — the more dangerous direction, because
    // `supabase db push` would run it, possibly out of order.
    for (const [version, file] of localVersions) {
        if (!versions.has(version)) {
            problems.push(
                `${file} carries version ${version}, which production has never applied. ` +
                `Either apply it and refresh the snapshot, or rename it with a ` +
                `PROPOSED_/HISTORICAL_ prefix so nothing tries to run it.`);
        }
    }

    return problems;
}

if (require.main === module) {
    const problems = checkMigrations();
    if (problems.length) {
        console.error(`\n✗ Migration ledger drift (${problems.length}):\n`);
        problems.forEach(p => console.error('  • ' + p));
        console.error('\n  See supabase/migrations/README.md for the rule.\n');
        process.exit(1);
    }
    console.log('✓ Migration ledger matches APPLIED_LEDGER.tsv');
}

module.exports = { checkMigrations };
