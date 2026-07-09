// ── token.ts — resolve the PSA API token ────────────────────────────
//
// Identity + population come only from the official PSA API, which needs
// a free user-supplied token (spec invariant #3). The token is NEVER in
// code — it is resolved at call time from, in order:
//
//   1. env `PSA_API_TOKEN` — a LOCAL-DEV / CLI-sanity-check fallback only.
//      The manifest does NOT grant `permissions.env` (a credential-shaped
//      env grant would fail the install gate), so at runtime the host does
//      not pass this through; it is honored only when the process already
//      has it set (e.g. the `scripts/sanity-check.ts` live run).
//   2. extension Storage key `psa-token` (written by the `set_psa_token`
//      tool into an owner-bound, encrypted scope) — the supported runtime
//      credential path.
//   3. null — no token → the caller degrades identity/pop to null and
//      stamps `psa-api:no-token` (honest, never a guess).
//
// This module never logs or returns the token anywhere but to its direct
// caller (spec invariant #4).

export const TOKEN_ENV_VAR = "PSA_API_TOKEN";
export const TOKEN_STORAGE_KEY = "psa-token";

/** The one Storage method this module needs — kept minimal so tests pass
 *  a plain fake and the real SDK `Storage` satisfies it structurally.
 *  A one-line `type` alias (not a multi-line `interface`) so bun's
 *  coverage instrumenter never source-maps the runtime `storage.get(...)`
 *  calls onto a standalone method-signature line, which zeroed out under
 *  the sharded lcov merge. */
export type TokenStorage = { get<T = unknown>(key: string): Promise<{ value: T | null; exists: boolean }> };

/**
 * Resolve the PSA API token: env wins, then Storage, else null. Blank /
 * whitespace-only values at either source are treated as absent.
 */
export async function resolveToken(
  env: Record<string, string | undefined>,
  storage: TokenStorage,
): Promise<string | null> {
  const fromEnv = env[TOKEN_ENV_VAR];
  if (typeof fromEnv === "string" && fromEnv.trim() !== "") {
    return fromEnv.trim();
  }
  const stored = await storage.get<string>(TOKEN_STORAGE_KEY);
  if (stored.exists && typeof stored.value === "string" && stored.value.trim() !== "") {
    return stored.value.trim();
  }
  return null;
}
