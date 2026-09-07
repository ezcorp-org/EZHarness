import { dirname, join } from "node:path";

type DataPathEnv = { DATABASE_URL?: string; EZCORP_DB_PATH?: string; HOME?: string };

/**
 * Resolve the embedded database path without importing the connection module.
 * Runtime services that need durable sibling storage use this same source of
 * truth, while the connection module remains the only place that opens it.
 * If HOME is absent, use the current working directory instead of creating a
 * literal `undefined/...` path.
 */
export function embeddedDatabasePath(
  env: DataPathEnv = { EZCORP_DB_PATH: process.env.EZCORP_DB_PATH, HOME: process.env.HOME },
): string {
  return env.EZCORP_DB_PATH ?? join(env.HOME ?? process.cwd(), "ez-corp", ".data", "ez-corp-db");
}

/**
 * Parent directory used for durable local state. It remains an on-disk path
 * even with external Postgres, because model assets do not belong in the
 * installation directory or in the relational database connection string.
 */
export function embeddedStateDir(
  env: DataPathEnv = { EZCORP_DB_PATH: process.env.EZCORP_DB_PATH, HOME: process.env.HOME },
): string {
  const databasePath = embeddedDatabasePath(env);
  return dirname(databasePath === ":memory:" ? embeddedDatabasePath({ HOME: env.HOME }) : databasePath);
}
