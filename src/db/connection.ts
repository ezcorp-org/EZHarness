import * as schema from "./schema";
import { migrate } from "./migrate";
import { mkdirSync, renameSync, existsSync } from "node:fs";
import { logger } from "../logger";
const log = logger.child("db");

const DEFAULT_DB_DIR = `${process.env.HOME}/ez-corp/.data`;
const DB_PATH = process.env.EZCORP_DB_PATH ?? `${DEFAULT_DB_DIR}/ez-corp-db`;
const IS_MEMORY = DB_PATH === ":memory:";
const DATABASE_URL = process.env.DATABASE_URL;

let _db: any = null;
let _pglite: import("@electric-sql/pglite").PGlite | null = null;
let _initPromise: Promise<void> | null = null;

async function initPglite(): Promise<void> {
  const { PGlite } = await import("@electric-sql/pglite");
  const { vector } = await import("@electric-sql/pglite/vector");
  const { drizzle } = await import("drizzle-orm/pglite");

  if (!IS_MEMORY) mkdirSync(DB_PATH, { recursive: true });
  const dbArg = IS_MEMORY ? undefined : DB_PATH;

  const openPglite = async (path: string | undefined) => {
    const pg = new PGlite(path, { extensions: { vector } });
    await pg.waitReady;
    return pg;
  };

  try {
    _pglite = await openPglite(dbArg);
  } catch (e) {
    if (IS_MEMORY || !existsSync(DB_PATH)) throw e;
    // Data directory is corrupted -- back it up and start fresh
    const backup = `${DB_PATH}.corrupted.${Date.now()}`;
    log.error("PGlite failed to open — backing up corrupted data", { backup });
    renameSync(DB_PATH, backup);
    mkdirSync(DB_PATH, { recursive: true });
    _pglite = await openPglite(dbArg);
  }

  _db = drizzle(_pglite, { schema });
  log.info("Database mode: embedded PGlite", { path: DB_PATH });
  await migrate(_db);
}

async function initPostgres(): Promise<void> {
  const { drizzle } = await import("drizzle-orm/bun-sql");
  const { sql } = await import("drizzle-orm");

  // Drizzle's default jsonb/json `mapToDriverValue = JSON.stringify` double-encodes
  // under Bun.sql: drizzle stringifies the object → Bun.sql sees a JS string and
  // binds it as a text value, which Postgres then stores as a jsonb STRING scalar
  // ({"x":1} becomes "{\"x\":1}"). That breaks every `col->>'key'` access and
  // produces the empty Token Usage chart. Bun.sql serializes JS objects to jsonb
  // correctly on its own, so we swap drizzle's mapper for identity and let the
  // driver handle it. This only matters under bun-sql; PGlite is unaffected.
  const [{ PgJsonb }, { PgJson }] = await Promise.all([
    import("drizzle-orm/pg-core/columns/jsonb"),
    import("drizzle-orm/pg-core/columns/json"),
  ]);
  const identity = function (value: unknown) { return value; };
  (PgJsonb.prototype as any).mapToDriverValue = identity;
  (PgJson.prototype as any).mapToDriverValue = identity;

  const db = drizzle(DATABASE_URL!, { schema });
  _pglite = null;

  // Wrap execute() so raw SQL results always return { rows: [...] }
  // bun-sql returns arrays directly, but PGlite returns { rows: [...] }.
  // All query code expects the { rows } shape.
  const origExecute = db.execute.bind(db) as (...a: any[]) => Promise<any>;
  (db as any).execute = async (...args: any[]) => {
    const result = await origExecute(...args);
    if (Array.isArray(result)) return { rows: result };
    return result;
  };
  _db = db;

  // Ensure pgvector extension is available
  await _db.execute(sql`CREATE EXTENSION IF NOT EXISTS vector`);

  log.info("Database mode: external Postgres");
  await migrate(_db);
  await repairDoubleEncodedJsonb(sql);
}

// Historical rows written before the jsonb-double-encoding fix are stored as
// JSON string scalars ({"x":1} → "{\"x\":1}"). Converting `jsonb::text::jsonb`
// unwraps the string back into its original object form. Idempotent — once
// every row is an object/array, subsequent runs are a no-op.
async function repairDoubleEncodedJsonb(sqlTag: typeof import("drizzle-orm")["sql"]): Promise<void> {
  const cols = await _db.execute(sqlTag`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public' AND data_type = 'jsonb'
  `);
  const rows = (cols as any).rows ?? cols;
  for (const row of rows as Array<{ table_name: string; column_name: string }>) {
    const table = row.table_name;
    const column = row.column_name;
    if (!/^[a-z_][a-z0-9_]*$/i.test(table) || !/^[a-z_][a-z0-9_]*$/i.test(column)) continue;
    const qTable = `"${table}"`;
    const qColumn = `"${column}"`;
    try {
      // Only unwrap rows whose inner text is a JSON object or array — scalar
      // JSON strings ("yolo", ISO timestamps, encrypted blobs stored in
      // settings.value) are legitimate and must not be touched.
      const result: any = await _db.execute(sqlTag.raw(
        `UPDATE ${qTable} SET ${qColumn} = (${qColumn} #>> '{}')::jsonb
         WHERE ${qColumn} IS NOT NULL
           AND jsonb_typeof(${qColumn}) = 'string'
           AND LEFT(LTRIM(${qColumn} #>> '{}'), 1) IN ('{', '[')`,
      ));
      const affected = result?.count ?? result?.rowCount ?? 0;
      if (affected > 0) log.info("Repaired double-encoded jsonb", { table, column, rows: affected });
    } catch (err) {
      log.warn("jsonb repair skipped", { table, column, error: String(err).slice(0, 200) });
    }
  }
}

async function init(): Promise<void> {
  if (DATABASE_URL) {
    await initPostgres();
  } else {
    await initPglite();
  }
}

export async function initDb(): Promise<void> {
  if (!_initPromise) {
    _initPromise = init();
  }
  await _initPromise;
}

export function getDb() {
  if (!_db) throw new Error("Database not initialized — call initDb() first");
  return _db;
}

export function getPglite(): import("@electric-sql/pglite").PGlite | null {
  return _pglite;
}

/** Execute a raw SQL string with positional $1/$2 params. Works with both PGlite and external Postgres. */
export async function rawQuery(sql: string, params: (string | null)[] = []): Promise<{ rows: any[] }> {
  if (_pglite) return _pglite.query(sql, params);
  // External Postgres via Bun.sql — use tagged template with raw interpolation
  const { sql: sqlTag } = await import("drizzle-orm");
  const result = await getDb().execute(sqlTag.raw(sql.replace(/\$(\d+)/g, (_, i: string) => {
    const val = params[parseInt(i) - 1] ?? null;
    return val === null ? "NULL" : `'${val.replace(/'/g, "''")}'`;
  })));
  return Array.isArray(result) ? { rows: result } : result as any;
}

export function getDbPath(): string {
  if (DATABASE_URL) return "external";
  return DB_PATH;
}

export async function closeDb(): Promise<void> {
  if (_pglite) {
    await _pglite.close();
  }
  _pglite = null;
  _db = null;
  _initPromise = null;
}
