// ============================================================
// migrationFile — find a migration by NAME, not by version
// ============================================================
// Tests assert on the SQL of specific migrations. They used to hard-code the
// filename, version prefix and all, which meant that correcting a version —
// the very thing that fixes ledger drift — broke a dozen unrelated tests and
// made the correction look more dangerous than it was.
//
// A migration's identity is its name. Its version is bookkeeping, assigned by
// whichever tool ran it. So look it up by name and let the version be whatever
// production recorded.
//
//   migrationFile('billing_invoice_integrity')
//     → supabase/migrations/20260825223846_billing_invoice_integrity.sql
//
// Throws when the name matches nothing or matches more than one file, because
// both mean the caller is asserting on something other than what it thinks.
// ============================================================

const fs = require('fs');
const path = require('path');

const MIG = path.resolve(__dirname, '..', 'supabase', 'migrations');

function migrationFile(name) {
    const wanted = name.replace(/\.sql$/, '');
    const matches = fs.readdirSync(MIG).filter(f => {
        if (!f.endsWith('.sql')) return false;
        const base = f.slice(0, -4)
            .replace(/^\d{8,14}_/, '')
            .replace(/_APPLIED$/, '')
            .replace(/^(PROPOSED|ROLLBACK|VERIFY|HISTORICAL)_/, '')
            .replace(/^\d{8,14}_/, '');
        return base === wanted;
    });

    if (matches.length === 0) {
        throw new Error(
            `No migration named "${wanted}" in supabase/migrations/. ` +
            `If it was renamed, look it up by its name part — not its version.`);
    }
    if (matches.length > 1) {
        throw new Error(`"${wanted}" matches ${matches.length} files: ${matches.join(', ')}`);
    }
    return path.join(MIG, matches[0]);
}

function readMigration(name) {
    return fs.readFileSync(migrationFile(name), 'utf8');
}

module.exports = { migrationFile, readMigration, MIGRATIONS_DIR: MIG };
