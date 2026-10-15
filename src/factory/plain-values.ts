/**
 * Small shape guards shared by the factory modules that parse untrusted JSON
 * or classify thrown errors. One copy, so every caller agrees on the rules.
 */

/** True for a plain JSON object: not `null`, not an array. */
export function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The string `code` a thrown value carries, or `undefined` when it carries none. */
export function factoryErrorCode(error: unknown): string | undefined {
  const value = (error as { readonly code?: unknown } | null | undefined)?.code;
  return typeof value === "string" ? value : undefined;
}
