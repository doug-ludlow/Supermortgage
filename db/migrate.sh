#!/usr/bin/env bash
# Apply db/migrations/*.sql in order, tracking what has run in schema_migrations.
#   DATABASE_URL=postgresql://sm:sm@localhost/supermortgage db/migrate.sh
set -euo pipefail
: "${DATABASE_URL:?set DATABASE_URL}"
cd "$(dirname "$0")"
psql -v ON_ERROR_STOP=1 -q "$DATABASE_URL" -c "CREATE TABLE IF NOT EXISTS schema_migrations (version text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now());"
for f in migrations/*.sql; do
  v="$(basename "$f" .sql)"
  if psql -tA "$DATABASE_URL" -c "SELECT 1 FROM schema_migrations WHERE version='$v'" | grep -q 1; then
    echo "skip  $v"; continue
  fi
  echo "apply $v"
  psql -v ON_ERROR_STOP=1 -q "$DATABASE_URL" -f "$f"
  psql -q "$DATABASE_URL" -c "INSERT INTO schema_migrations(version) VALUES ('$v');"
done
