/** The ordering columns of the last row a page served. */
export type FactoryKeyset = readonly (string | number)[];

const MAXIMUM_CURSOR_LENGTH = 2_048;

/** An opaque page position: the keyset as base64url JSON. */
export function encodeFactoryKeyset(values: FactoryKeyset): string {
  return Buffer.from(JSON.stringify(values), "utf8").toString("base64url");
}

/**
 * The keyset of a well-formed cursor with exactly `arity` positions, each a
 * string or a safe integer, or null. Only the canonical encoding is accepted,
 * so a position is refused rather than partially honoured; each caller raises
 * its own page error.
 */
export function decodeFactoryKeyset(cursor: string, arity: number): FactoryKeyset | null {
  if (cursor.length < 1 || cursor.length > MAXIMUM_CURSOR_LENGTH) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")); } catch { return null; }
  if (!Array.isArray(parsed) || parsed.length !== arity || !parsed.every(item => typeof item === "string" || Number.isSafeInteger(item))) return null;
  return encodeFactoryKeyset(parsed) === cursor ? parsed : null;
}
