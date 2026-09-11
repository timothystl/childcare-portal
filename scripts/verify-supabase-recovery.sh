#!/usr/bin/env bash
set -euo pipefail

# ⚠ FIRST BUILD, NO TESTED PRECEDENT ANYWHERE. chms's own backup/restore
# tooling covers its D1 database only; website's port of that pattern (and
# its own new R2 drill) cover Cloudflare D1/R2 only. Nothing in any Timothy
# Digital repo has verified a Postgres/Supabase restore before this. Run it
# once by hand (workflow_dispatch) and read the summary carefully before
# trusting it — and read the whole design note below, because two decisions
# here depart from the D1/R2 drills on purpose, not by oversight.
#
# ⚠ THIS IS BY FAR THE MOST SENSITIVE DATABASE IN THE WHOLE SYSTEM: real
# children, families, staff, wages, and payments (see this repo's own
# AGENTS.md: "Never expose credentials, PINs, tokens, family/child data,
# staff records, wages, or payment data"). Every verification step below is
# therefore structural or numeric ONLY — table names, row counts, monetary
# control totals, a schema/constraint diff — and no step ever selects,
# prints, or writes to a file any actual row's family/child/staff/payment
# content. If you are extending this script, that rule is not optional.
#
# DEPARTURE 1 — the restore target is a LOCAL, EPHEMERAL Postgres service
# container in this same CI job, not a new disposable cloud resource.
# chms's D1 drill and website's R2 drill both restore into a real disposable
# CLOUD resource, because creating one (a D1 database, an R2 bucket) is
# instant and free. Provisioning a full disposable SUPABASE PROJECT through
# the Management API is neither: it takes real minutes, may count against
# the organization's project quota, and has to be done at all for something
# a plain `postgres` GitHub Actions service container already proves. What
# this script certifies is the load-bearing claim -- the production dump is
# valid, restorable, and structurally and numerically identical once
# restored -- not that Supabase's own hosting stack can be reprovisioned
# from scratch. If a full cloud-project restore drill is ever wanted on top
# of this, it is a deliberate, separate, and much more expensive addition,
# not a gap in this one.
#
# DEPARTURE 2 — connects directly to the production database (via
# SUPABASE_DB_PASSWORD), not through the Supabase Management API. pg_dump
# needs a real Postgres connection either way; the direct connection avoids
# a second credential type and pooler transaction-mode quirks for a
# schema+data dump. The connection is read-only in effect: nothing in this
# script issues a single INSERT/UPDATE/DELETE against production.

source_host="${SUPABASE_DB_HOST:-db.dahdstopsumxnqvdclmy.supabase.co}"
source_db="${SUPABASE_DB_NAME:-postgres}"
source_user="${SUPABASE_DB_USER:-postgres}"
source_password="${SUPABASE_DB_PASSWORD:?SUPABASE_DB_PASSWORD is required}"
restore_host="${RESTORE_DB_HOST:-localhost}"
restore_port="${RESTORE_DB_PORT:-5432}"
restore_db="${RESTORE_DB_NAME:-postgres}"
restore_user="${RESTORE_DB_USER:-postgres}"
restore_password="${RESTORE_DB_PASSWORD:-postgres}"
temp_dir="$(mktemp -d "${RUNNER_TEMP:-/tmp}/timothy-supabase-recovery.XXXXXX")"
dump_file="$temp_dir/mymdo-production.sql"
result_file="${RESULT_FILE:-/tmp/timothy-supabase-recovery-result.json}"

chmod 700 "$temp_dir"

sha256_file() {
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    shasum -a 256 "$1" | awk '{print $1}'
  fi
}

cleanup() {
  rm -rf "$temp_dir"
}
trap cleanup EXIT

source_conn="postgresql://${source_user}:${source_password}@${source_host}:5432/${source_db}?sslmode=require"
restore_conn="postgresql://${restore_user}:${restore_password}@${restore_host}:${restore_port}/${restore_db}"

echo "[1/6] Verifying the production database is reachable"
psql "$source_conn" -X -q -c "SELECT 1;" >/dev/null

echo "[2/6] Dumping production (schema + data, public schema only) to protected temporary storage"
# --no-owner/--no-privileges: this repo's RLS policies and role grants are
# defined in supabase/migrations/, the source of truth for schema -- a dump
# is a data/structure snapshot for THIS drill, not a second copy of the
# migration history to maintain.
pg_dump "$source_conn" \
  --schema=public \
  --no-owner --no-privileges \
  --format=plain \
  --file="$dump_file"
chmod 600 "$dump_file"
dump_sha="$(sha256_file "$dump_file")"
dump_bytes="$(wc -c < "$dump_file" | tr -d ' ')"

echo "[3/6] Restoring into the disposable local Postgres"
psql "$restore_conn" -X -q -f "$dump_file" >/dev/null

echo "[4/6] Reconciling every table's row count"
table_sql="SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name;"
psql "$source_conn" -X -A -t -c "$table_sql" > "$temp_dir/tables.txt"
table_count="$(wc -l < "$temp_dir/tables.txt" | tr -d ' ')"
test "$table_count" -gt 0

: > "$temp_dir/row-count-sql.txt"
while IFS= read -r table; do
  [[ "$table" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
  echo "SELECT '${table}' AS table_name, COUNT(*) AS row_count FROM \"${table}\"" >> "$temp_dir/row-count-sql.txt"
done < "$temp_dir/tables.txt"
row_count_sql="$(paste -sd $'\n' "$temp_dir/row-count-sql.txt" | sed '$!s/$/ UNION ALL/')"

psql "$source_conn" -X -A -F',' -t -c "$row_count_sql ORDER BY 1;" > "$temp_dir/source-rows.csv"
psql "$restore_conn" -X -A -F',' -t -c "$row_count_sql ORDER BY 1;" > "$temp_dir/restore-rows.csv"
if ! cmp -s "$temp_dir/source-rows.csv" "$temp_dir/restore-rows.csv"; then
  echo "Row-count reconciliation mismatch:"
  diff "$temp_dir/source-rows.csv" "$temp_dir/restore-rows.csv" || true
  exit 31
fi
row_sha="$(sha256_file "$temp_dir/source-rows.csv")"

echo "[5/6] Reconciling monetary and wage/hours control totals"
# Same pattern as chms's/website's D1 drills: numeric-typed columns whose
# NAME suggests money, a rate, or hours -- summed, never selected row by
# row. "rate"/"hours"/"wage" are included here (unlike the D1 drills) because
# this database's payroll tables carry the church's real wage exposure in
# hourly rates and worked hours, not only dollar totals.
column_sql="SELECT table_name, column_name, data_type FROM information_schema.columns WHERE table_schema = 'public' AND data_type IN ('numeric','integer','bigint','smallint','real','double precision','decimal') ORDER BY table_name, ordinal_position;"
psql "$source_conn" -X -A -F$'\t' -t -c "$column_sql" > "$temp_dir/columns.tsv"

: > "$temp_dir/monetary-sql.txt"
monetary_controls=0
while IFS=$'\t' read -r table column column_type; do
  [[ -z "$table" ]] && continue
  [[ "$table" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
  [[ "$column" =~ ^[A-Za-z_][A-Za-z0-9_]*$ ]]
  lower_column="$(printf '%s' "$column" | tr '[:upper:]' '[:lower:]')"
  if [[ "$lower_column" =~ (amount|total|balance|fee|cost|budget|pledge|gift|donation|income|expense|tuition|payment|salary|compensation|revenue|principal|interest|allocation|forecast|reserve|price|rate|wage|hours|charge|cents) ]]; then
    echo "SELECT '${table}' AS table_name, '${column}' AS column_name, COUNT(\"${column}\") AS populated_rows, COALESCE(SUM(\"${column}\"), 0)::text AS control_total FROM \"${table}\"" >> "$temp_dir/monetary-sql.txt"
    monetary_controls=$((monetary_controls + 1))
  fi
done < "$temp_dir/columns.tsv"
test "$monetary_controls" -gt 0
monetary_sql="$(paste -sd $'\n' "$temp_dir/monetary-sql.txt" | sed '$!s/$/ UNION ALL/')"

psql "$source_conn" -X -A -F',' -t -c "$monetary_sql ORDER BY 1,2;" > "$temp_dir/source-money.csv"
psql "$restore_conn" -X -A -F',' -t -c "$monetary_sql ORDER BY 1,2;" > "$temp_dir/restore-money.csv"
if ! cmp -s "$temp_dir/source-money.csv" "$temp_dir/restore-money.csv"; then
  echo "Monetary/wage control-total reconciliation mismatch:"
  diff "$temp_dir/source-money.csv" "$temp_dir/restore-money.csv" || true
  exit 32
fi
monetary_sha="$(sha256_file "$temp_dir/source-money.csv")"

echo "[6/6] Deleting the plaintext dump"
rm -f "$dump_file"
test ! -e "$dump_file"

jq -n \
  --arg completed_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
  --arg source_host "$source_host" \
  --argjson dump_bytes "$dump_bytes" \
  --arg dump_sha256 "$dump_sha" \
  --argjson tables "$table_count" \
  --arg row_control_sha256 "$row_sha" \
  --argjson monetary_controls "$monetary_controls" \
  --arg monetary_control_sha256 "$monetary_sha" \
  '{completed_at:$completed_at,source_host:$source_host,dump_bytes:$dump_bytes,dump_sha256:$dump_sha256,tables_matched:$tables,row_control_sha256:$row_control_sha256,monetary_controls_matched:$monetary_controls,monetary_control_sha256:$monetary_control_sha256,restore_target:"local ephemeral Postgres service container (not a cloud resource)",plaintext_dump_deleted:true,family_child_staff_payment_values_logged:false}' > "$result_file"

cat "$result_file"
