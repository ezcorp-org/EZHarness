/**
 * An error and every cause behind it, each with the database facts it carries.
 *
 * Drizzle wraps a driver error in a `DrizzleQueryError` whose message is the
 * QUERY and whose own `code` is undefined; the server's words live on
 * `.cause`. Where they live on the cause differs by driver: Bun.sql sets
 * `code = "ERR_POSTGRES_SERVER_ERROR"` and carries the SQLSTATE on `errno`,
 * the server function on `routine`, and the level on `severity`; PGlite puts
 * the SQLSTATE on `code`. `String(error)` prints only the top message, so a
 * log that uses it drops exactly the part that names the failure (W09f: an
 * 08P01 from `exec_bind_message` was logged as a bare "Failed query").
 *
 * The walk stops at a repeated object (a cause cycle) and after
 * `ERROR_CHAIN_MAX_LINKS` links, so a hostile or circular error cannot make a
 * logger loop. Every fact is string-normalized.
 */
export interface ErrorChainLink {
  readonly message: string;
  readonly code?: string;
  readonly errno?: string;
  readonly routine?: string;
  readonly severity?: string;
  /** The prepared statement the server named in its message, when it named one. */
  readonly statement?: string;
}

export const ERROR_CHAIN_MAX_LINKS = 8;

const FACTS = ["code", "errno", "routine", "severity"] as const;

function chainLink(value: unknown): ErrorChainLink {
  if (typeof value !== "object" || value === null) return { message: String(value) };
  const fields = value as Record<string, unknown>;
  const message = typeof fields.message === "string" ? fields.message : String(value);
  const link: Record<string, string> = { message };
  for (const fact of FACTS) {
    if (fields[fact] !== undefined && fields[fact] !== null) link[fact] = String(fields[fact]);
  }
  // A driver-generated statement name may itself contain quotes
  // (`Pselect "id", …$5`), so the match runs to the last quote.
  const statement = /prepared statement "(.*)"/s.exec(message)?.[1];
  if (statement !== undefined) link.statement = statement;
  return link as unknown as ErrorChainLink;
}

/** The error itself first, then each `.cause` in order. */
export function errorChain(error: unknown): readonly ErrorChainLink[] {
  const links: ErrorChainLink[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (links.length < ERROR_CHAIN_MAX_LINKS && current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    links.push(chainLink(current));
    current = typeof current === "object" ? (current as { cause?: unknown }).cause : undefined;
  }
  return links;
}

/**
 * SQLSTATEs that only a driver's own prepared-statement bookkeeping can cause:
 * this codebase never names, prepares or deallocates a statement itself.
 * 08P01 protocol_violation (a Bind that does not fit its statement),
 * 26000 invalid_sql_statement_name (a statement the session does not have),
 * 42P05 duplicate_prepared_statement (a name the session already holds).
 */
export const DRIVER_STATEMENT_DESYNC_STATES: readonly string[] = ["08P01", "26000", "42P05"];

/** True when the error, or any cause behind it, is a driver statement desync. */
export function isDriverStatementDesync(error: unknown): boolean {
  return errorChain(error).some((link) => DRIVER_STATEMENT_DESYNC_STATES.includes(link.errno ?? link.code ?? ""));
}
