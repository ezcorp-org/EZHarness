#!/usr/bin/env bash
# drop-retained-db.sh <name>: drop ONE database that a failed W19a pass kept, by name, on the shared proof PostgreSQL.
# Credentials from the 0600 env file into the environment only (never argv). Only w19a_product_* names are accepted.
set -euo pipefail
name=$1; [[ "$name" =~ ^w19a_product_[0-9]+_[0-9a-f]+$ ]] || { echo "refused: $name"; exit 2; }
set -a; . evidence/postgres.env; set +a
PGPORT=$(podman port factory-platform-proof-postgres 5432 | head -1 | sed 's/.*://')
export DROP_URL="postgres://${POSTGRES_USER}:${POSTGRES_PASSWORD}@127.0.0.1:${PGPORT}/${POSTGRES_DB}" DROP_NAME="$name"; unset POSTGRES_PASSWORD
/tmp/factory-tools/bun-1.4.2/bun-linux-x64/bun -e '
const sql = new Bun.SQL(process.env.DROP_URL, { max: 1 }); const n = process.env.DROP_NAME;
const before = (await sql`select count(*)::int as c from pg_database where datname = ${n}`)[0].c;
await sql.unsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`);
const after = (await sql`select count(*)::int as c from pg_database where datname = ${n}`)[0].c;
console.log(`${n}: present before ${before}, after ${after}`); await sql.close();'
