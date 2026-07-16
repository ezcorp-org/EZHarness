// ── gh runner + GitHub-token resolution ─────────────────────────────
//
// The production `GhRunner` the pr/ci steps drive: `gh <args>` in the worktree
// with the GitHub token injected as `GH_TOKEN`. It is a thin wrapper over the
// injectable host `ShellRunner` (lib/shell.ts) so the argv/env assembly is unit-
// tested with a fake, while the real subprocess spawn is the same covered seam
// as every other git call. The token is resolved per call (env override, then
// the `type:"secret"` setting stored — encrypted — in user Storage), so a
// rotated token takes effect without a restart and no plaintext is ever logged.

import type { GhRunner } from "./github";
import type { ShellRunner } from "./shell";

/** The storage key the `githubToken` secret setting writes to (must match the
 *  manifest field's `storageKey`). The host's secret-settings write path stores
 *  the value encrypted at (extensionId, user, userId, storageKey). */
export const GH_TOKEN_STORAGE_KEY = "github-token";

/** Env vars honored as a token override (local-dev / CI parity), highest first.
 *  The manifest does NOT grant `permissions.env` (a `/_TOKEN$/i` env name is
 *  install-refused), so at runtime these are only honored when the process
 *  already carries them. */
export const GH_TOKEN_ENV_VARS = ["GH_TOKEN", "GITHUB_TOKEN"] as const;

/** The one Storage method the token reader needs (a plain fake satisfies it;
 *  the SDK `Storage` matches structurally). A one-line type alias, not an
 *  interface, so bun's coverage never source-maps the runtime `.get(...)` call
 *  onto a standalone signature line. */
export type TokenStorage = { get<T = unknown>(key: string): Promise<{ value: T | null; exists: boolean }> };

/**
 * Resolve the GitHub token: an env override wins, then the encrypted secret
 * setting from user Storage, else null (→ gh uses its own ambient auth, and an
 * unauthenticated host makes pr/ci skip). Blank/whitespace values count as absent.
 */
export async function resolveGhToken(
  env: Record<string, string | undefined>,
  storage: TokenStorage,
): Promise<string | null> {
  for (const key of GH_TOKEN_ENV_VARS) {
    const v = env[key];
    if (typeof v === "string" && v.trim() !== "") return v.trim();
  }
  const stored = await storage.get<string>(GH_TOKEN_STORAGE_KEY);
  if (stored.exists && typeof stored.value === "string" && stored.value.trim() !== "") {
    return stored.value.trim();
  }
  return null;
}

/**
 * Build a production `GhRunner` bound to a host runner + worktree. Each call
 * resolves the token and runs `gh <args>` with `GH_TOKEN` set (omitted when no
 * token is available, so gh falls back to its own configured auth). Pure over
 * `runner` + `resolveToken` — tests inject fakes; production passes
 * `productionHostRunner` + a `resolveGhToken` closure.
 */
export function makeGhRunner(
  runner: ShellRunner,
  worktree: string,
  resolveToken: () => Promise<string | null>,
): GhRunner {
  return async (args, opts) => {
    const token = await resolveToken();
    const env = token !== null ? { GH_TOKEN: token } : undefined;
    return runner(["gh", ...args], worktree, { ...(opts?.stdin !== undefined ? { stdin: opts.stdin } : {}), ...(env ? { env } : {}) });
  };
}
