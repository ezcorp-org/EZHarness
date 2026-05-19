/** Opt-in guard for the e2e suite. All e2e tests call `await ensureLiveServer()`
 *  inside a `beforeAll` — if the live server isn't reachable or the env vars
 *  aren't set, `describe.skipIf` will skip the whole block. */

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
