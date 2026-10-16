/** Optional deployed-service suites select themselves from the URL/key flags.
 * Once configured, requireE2eReady fails if the target is unavailable. */

export const E2E_BASE_URL = process.env.EZCORP_E2E_BASE_URL;
export const E2E_API_KEY = process.env.EZCORP_E2E_API_KEY;

export async function isServerUp(baseUrl: string | undefined): Promise<boolean> {
  if (!baseUrl) return false;
  try {
    const res = await fetch(new URL("/api/health", baseUrl), {
      signal: AbortSignal.timeout(2000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Lazily computed — cached to avoid re-pinging per test. */
let cached: boolean | null = null;
export async function e2eReady(): Promise<boolean> {
  if (cached !== null) return cached;
  cached = await isServerUp(E2E_BASE_URL);
  return cached;
}

/** A configured E2E lane must fail when its target is unavailable. */
export async function requireE2eReady(): Promise<void> {
  if (!E2E_BASE_URL) throw new Error("EZCORP_E2E_BASE_URL is required");
  if (!(await e2eReady())) {
    throw new Error(`AI-kit E2E server is not healthy: ${E2E_BASE_URL}`);
  }
}

/**
 * A deployed-service suite whose lane lacks one of its preconditions SKIPS, by name, never passes silently and never
 * fails on the missing precondition (team-lead's ruling, W4H-33). `reason` is one literal in each suite, in the form
 * "skip: precondition <name> missing; tracked: <id>", which scripts/test-skip-inventory.ts checks against
 * scripts/test-skip-registry.json. Prints the reason when it skips; returns whether to skip. With the precondition present the
 * suite runs, and wrong behaviour fails.
 */
export function skipUnless(present: boolean, reason: string): boolean {
  if (!present) console.log(reason);
  return !present;
}
