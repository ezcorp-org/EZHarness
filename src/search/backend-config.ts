// Backend key → provider env bridge (shared-search residual #1).
//
// The Settings → Search "Backend" UI persists the SearXNG base URL
// (`global:search:searxngUrl`, plain string) and the five BYOK search
// keys (`provider:apiKey:{tavily,brave,exa,serpapi,jina}`, encrypted)
// via `web/.../api/search/backend/+server.ts`. But `resolveProviders`
// (src/search/providers.ts) reads ONLY `process.env`, so UI-saved values
// were inert at runtime. This module bridges the persisted settings into
// the env object handed to `resolveProviders`.
//
// PRECEDENCE — mirrors the LLM precedent `getApiKey`
// (src/providers/credentials.ts): a persisted Settings value OVERRIDES
// the same-named base env var (UI wins); a key present only in env is
// still used (env is the fallback); a deleted UI key falls back to env.
// This bridge only makes persisted values AVAILABLE to the existing
// `resolveProviders` precedence order — provider SELECTION precedence
// (TAVILY > BRAVE > EXA > SERPAPI > JINA > SEARXNG > DuckDuckGo) is
// unchanged.
//
// SECURITY: decrypted keys live ONLY in the in-memory env object returned
// here and handed to `resolveProviders` HOST-side. They are NEVER returned
// by any GET endpoint (the backend route is presence-only) and NEVER
// passed to extension subprocesses — extensions reach search through
// `ctx.search`; the provider chain runs entirely host-side.

import { getSetting } from "../db/queries/settings";
import { decrypt } from "../providers/encryption";

/** SearXNG base URL setting key (plain, non-secret). */
const SEARXNG_URL_KEY = "global:search:searxngUrl";

/** BYOK search providers → their target env var. Mirrors `BYOK_PROVIDERS`
 *  in the backend route + the resolver's env reads in
 *  `src/search/providers.ts#resolveProviders`. */
const BYOK_ENV_MAP: Record<string, string> = {
  tavily: "TAVILY_API_KEY",
  brave: "BRAVE_API_KEY",
  exa: "EXA_API_KEY",
  serpapi: "SERPAPI_API_KEY",
  jina: "JINA_API_KEY",
};

/** Read one encrypted BYOK key from settings and decrypt it. Returns
 *  undefined on any failure (absent / corrupt / undecryptable) so the
 *  caller falls back to the base env — never throws. */
async function readByokKey(provider: string): Promise<string | undefined> {
  try {
    const stored = await getSetting(`provider:apiKey:${provider}`);
    if (typeof stored !== "string" || stored.length === 0) return undefined;
    try {
      const plain = decrypt(stored);
      return plain.length > 0 ? plain : undefined;
    } catch {
      // Corrupt / undecryptable key → skip, fall back to base env.
      return undefined;
    }
  } catch {
    // DB unavailable → skip, fall back to base env.
    return undefined;
  }
}

/** Read the SearXNG base URL from settings. Blank / whitespace → not
 *  bridged. Returns undefined on any failure. */
async function readSearxngUrl(): Promise<string | undefined> {
  try {
    const stored = await getSetting(SEARXNG_URL_KEY);
    if (typeof stored !== "string") return undefined;
    const trimmed = stored.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Build an env object that overlays persisted Settings → Search backend
 * config onto `base` (default `process.env`). Persisted values override
 * the same-named base env var; absent persisted values leave the base
 * untouched. The returned object is a shallow copy — `base` is not mutated.
 *
 * Read-only and fail-soft: any DB / decrypt failure for a single key
 * silently falls back to the base env for that key (never throws).
 */
export async function resolveSearchBackendEnv(
  base: NodeJS.ProcessEnv = process.env,
): Promise<NodeJS.ProcessEnv> {
  const overlay: NodeJS.ProcessEnv = { ...base };

  const [searxngUrl, ...byokKeys] = await Promise.all([
    readSearxngUrl(),
    ...Object.keys(BYOK_ENV_MAP).map((p) => readByokKey(p)),
  ]);

  if (searxngUrl !== undefined) {
    overlay.SEARXNG_BASE_URL = searxngUrl;
  }

  const providers = Object.keys(BYOK_ENV_MAP);
  for (let i = 0; i < providers.length; i++) {
    const key = byokKeys[i];
    if (key !== undefined) {
      overlay[BYOK_ENV_MAP[providers[i]!]!] = key;
    }
  }

  return overlay;
}
