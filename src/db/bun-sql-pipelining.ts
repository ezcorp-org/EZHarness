/**
 * The Bun.SQL pipelining guard (W12e).
 *
 * Bun 1.4.0–1.4.2's Postgres client, with auto-pipelining on, can deliver one pipelined request's reply to another
 * (a SELECT rejected with a concurrent INSERT's duplicate-key error), fail a whole connection with "Failed to read
 * data", or stall; 1.3.14 deadlocks outright under the same load. The fixes (oven-sh/bun#32088, #43187) merged after
 * 1.4.2. With BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING the defect is gone (0 of 3000 trials) at a cost of 1%.
 *
 * Bun reads that flag once, from the environment the process STARTED with; a later `process.env` write is ignored
 * (measured on the wire, W12e option 3). So nothing here sets it. On an affected Bun every Bun.SQL client is opened
 * through `openBunSql` (or checks with `assertBunSqlPipeliningOff`), which refuses by name unless the flag was in the
 * start environment. On Linux that is read from /proc/self/environ, so a late `process.env` write cannot satisfy the
 * guard any more than it satisfies Bun; elsewhere `process.env` is the best available answer.
 */
import { readFileSync } from "node:fs";
import defect from "./bun-sql-pipelining-defect.json" with { type: "json" };

export const BUN_SQL_PIPELINING_FLAG = "BUN_FEATURE_FLAG_DISABLE_SQL_AUTO_PIPELINING";
export const BUN_SQL_PIPELINING_DEFECT: { readonly affected: readonly string[]; readonly fixedIn: string | null } = defect;

export class BunSqlPipeliningGuardError extends Error {
  override readonly name = "BunSqlPipeliningGuardError";
}

/** Bun's own reading of a boolean feature flag: set and not "", "0", "false", "no" or "off" (any case). */
export function flagIsOn(value: string | undefined): boolean {
  return value !== undefined && !["", "0", "false", "no", "off"].includes(value.toLowerCase());
}

/** The environment the process started with: /proc/self/environ on Linux, else `process.env`. */
export function startEnvironment(read: () => Buffer = () => readFileSync("/proc/self/environ")): Readonly<Record<string, string | undefined>> {
  let raw: Buffer;
  try { raw = read(); } catch { return process.env; }
  const entries = raw.toString("utf8").split("\0").filter(Boolean).map((entry) => {
    const at = entry.indexOf("=");
    return [entry.slice(0, at), entry.slice(at + 1)] as const;
  });
  return Object.fromEntries(entries);
}

/** Refuses, by name, to use Bun.SQL on an affected Bun unless auto-pipelining was switched off at process start. */
export function assertBunSqlPipeliningOff(bunVersion: string = Bun.version, environment: Readonly<Record<string, string | undefined>> = startEnvironment()): void {
  if (!BUN_SQL_PIPELINING_DEFECT.affected.includes(bunVersion)) return;
  if (flagIsOn(environment[BUN_SQL_PIPELINING_FLAG])) return;
  throw new BunSqlPipeliningGuardError(
    `bun_sql_pipelining_guard: Bun ${bunVersion} needs ${BUN_SQL_PIPELINING_FLAG}=1 in the process environment at start ` +
      "(its Postgres pipelining mixes replies under load; oven-sh/bun#32088, #43187). Set it where the process is launched; " +
      "setting process.env inside the process has no effect.",
  );
}

/**
 * The guard for code that resolves the Bun.SQL class itself (src/db/connection.ts takes it from the runtime so Vite
 * never sees a bare "bun" import): checks, then hands the class back.
 */
export function guardedBunSqlClass<SqlClass>(sqlClass: SqlClass): SqlClass {
  assertBunSqlPipeliningOff();
  return sqlClass;
}

type BunSqlOptions = Bun.SQL.Options;
/** Bun.SQL's own form for (url, options): the options without url/filename, omitted per union member. */
type BunSqlUrlOptions = BunSqlOptions extends infer Member ? (Member extends unknown ? Omit<Member, "url" | "filename"> : never) : never;

/** Opens a Bun.SQL client after the guard, with Bun.SQL's own three call forms. Every product client goes through here. */
export function openBunSql(connectionString: string | URL, options?: BunSqlUrlOptions): InstanceType<typeof Bun.SQL>;
export function openBunSql(options?: BunSqlOptions): InstanceType<typeof Bun.SQL>;
export function openBunSql(first?: string | URL | BunSqlOptions, options?: BunSqlUrlOptions): InstanceType<typeof Bun.SQL> {
  assertBunSqlPipeliningOff();
  return options === undefined ? new Bun.SQL(first as never) : new Bun.SQL(first as string | URL, options as never);
}
