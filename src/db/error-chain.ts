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
}

export const ERROR_CHAIN_MAX_LINKS = 8;

const FACTS = ["code", "errno", "routine", "severity"] as const;

function chainLink(value: unknown): ErrorChainLink {
  if (typeof value !== "object" || value === null) return { message: String(value) };
  const fields = value as Record<string, unknown>;
  const link: Record<string, string> = { message: typeof fields.message === "string" ? fields.message : String(value) };
  for (const fact of FACTS) {
    if (fields[fact] !== undefined && fields[fact] !== null) link[fact] = String(fields[fact]);
  }
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
