/**
 * Unit tests for `src/search/backend-config.ts#resolveSearchBackendEnv` —
 * the bridge that overlays persisted Settings → Search backend config
 * (SearXNG URL + the 5 encrypted BYOK keys) onto a base env object for
 * `resolveProviders`.
 *
 * `getSetting` (db/queries/settings) and `decrypt` (providers/encryption)
 * are mock.module'd (≥2 mocks → in-file snapshot via restoreModuleMocks in
 * afterAll, per the bun freeze pattern). Each test configures the stub
 * behavior through mutable maps.
 */
import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

// Mutable per-test stub state.
let settingValues: Map<string, unknown>;
let getSettingThrows: boolean;
let decryptThrowsFor: Set<string>;

beforeEach(() => {
  settingValues = new Map();
  getSettingThrows = false;
  decryptThrowsFor = new Set();
});

mock.module("../db/queries/settings", () => ({
  getSetting: async (key: string) => {
    if (getSettingThrows) throw new Error("DB down");
    return settingValues.get(key);
  },
}));

// `decrypt` is the identity-with-prefix stub: a stored ciphertext is
// `enc:<plain>`; decrypt strips the prefix. Keys in `decryptThrowsFor`
// throw (corrupt/undecryptable simulation).
mock.module("../providers/encryption", () => ({
  decrypt: (ciphertext: string) => {
    if (decryptThrowsFor.has(ciphertext)) throw new Error("bad ciphertext");
    if (ciphertext.startsWith("enc:")) return ciphertext.slice("enc:".length);
    return ciphertext;
  },
}));

const { resolveSearchBackendEnv } = await import("../search/backend-config");

const BYOK = [
  { provider: "tavily", env: "TAVILY_API_KEY" },
  { provider: "brave", env: "BRAVE_API_KEY" },
  { provider: "exa", env: "EXA_API_KEY" },
  { provider: "serpapi", env: "SERPAPI_API_KEY" },
  { provider: "jina", env: "JINA_API_KEY" },
] as const;

describe("resolveSearchBackendEnv", () => {
  test("bridges the SearXNG URL to SEARXNG_BASE_URL", async () => {
    settingValues.set("global:search:searxngUrl", "https://searx.example");
    const out = await resolveSearchBackendEnv({} as NodeJS.ProcessEnv);
    expect(out.SEARXNG_BASE_URL).toBe("https://searx.example");
  });

  test("does not bridge a blank/whitespace SearXNG URL", async () => {
    settingValues.set("global:search:searxngUrl", "   ");
    const out = await resolveSearchBackendEnv({} as NodeJS.ProcessEnv);
    expect(out.SEARXNG_BASE_URL).toBeUndefined();
  });

  test("ignores a non-string SearXNG URL setting", async () => {
    settingValues.set("global:search:searxngUrl", 42);
    const out = await resolveSearchBackendEnv({} as NodeJS.ProcessEnv);
    expect(out.SEARXNG_BASE_URL).toBeUndefined();
  });

  for (const { provider, env } of BYOK) {
    test(`decrypts the ${provider} BYOK key into ${env}`, async () => {
      settingValues.set(`provider:apiKey:${provider}`, "enc:secret-" + provider);
      const out = await resolveSearchBackendEnv({} as NodeJS.ProcessEnv);
      expect(out[env]).toBe("secret-" + provider);
    });
  }

  test("a corrupt key falls back to base env without throwing; others still bridge", async () => {
    // tavily key is corrupt; brave key is fine.
    settingValues.set("provider:apiKey:tavily", "enc:corrupt");
    decryptThrowsFor.add("enc:corrupt");
    settingValues.set("provider:apiKey:brave", "enc:brave-ok");
    const base = { TAVILY_API_KEY: "env-tavily" } as NodeJS.ProcessEnv;
    const out = await resolveSearchBackendEnv(base);
    // tavily falls back to the base env value (not overwritten).
    expect(out.TAVILY_API_KEY).toBe("env-tavily");
    // brave still bridges.
    expect(out.BRAVE_API_KEY).toBe("brave-ok");
  });

  test("an empty-string decrypted key is skipped (falls back to base)", async () => {
    settingValues.set("provider:apiKey:tavily", "enc:");
    const base = { TAVILY_API_KEY: "env-tavily" } as NodeJS.ProcessEnv;
    const out = await resolveSearchBackendEnv(base);
    expect(out.TAVILY_API_KEY).toBe("env-tavily");
  });

  test("an empty-string stored ciphertext is skipped", async () => {
    settingValues.set("provider:apiKey:tavily", "");
    const out = await resolveSearchBackendEnv({} as NodeJS.ProcessEnv);
    expect(out.TAVILY_API_KEY).toBeUndefined();
  });

  test("a non-string stored ciphertext is skipped", async () => {
    settingValues.set("provider:apiKey:tavily", { not: "a string" });
    const out = await resolveSearchBackendEnv({} as NodeJS.ProcessEnv);
    expect(out.TAVILY_API_KEY).toBeUndefined();
  });

  test("DB unavailable (getSetting throws) returns base unchanged, no throw", async () => {
    getSettingThrows = true;
    const base = { TAVILY_API_KEY: "env-tavily", SEARXNG_BASE_URL: "https://env" } as NodeJS.ProcessEnv;
    const out = await resolveSearchBackendEnv(base);
    expect(out.TAVILY_API_KEY).toBe("env-tavily");
    expect(out.SEARXNG_BASE_URL).toBe("https://env");
  });

  test("a persisted key overrides a same-named base env var (UI wins)", async () => {
    settingValues.set("provider:apiKey:tavily", "enc:ui-key");
    const base = { TAVILY_API_KEY: "env-key" } as NodeJS.ProcessEnv;
    const out = await resolveSearchBackendEnv(base);
    expect(out.TAVILY_API_KEY).toBe("ui-key");
  });

  test("absent settings return the base env untouched (shallow copy, not mutated)", async () => {
    const base = { TAVILY_API_KEY: "env-key", FOO: "bar" } as NodeJS.ProcessEnv;
    const out = await resolveSearchBackendEnv(base);
    expect(out).toEqual(base);
    expect(out).not.toBe(base); // shallow copy
    expect(base.SEARXNG_BASE_URL).toBeUndefined(); // base not mutated
  });

  test("defaults base to process.env when omitted", async () => {
    // No settings → overlay is a copy of process.env. Assert a known
    // process.env key round-trips (covers the default-parameter branch).
    process.env.__SEARCH_BRIDGE_PROBE__ = "probe-value";
    const out = await resolveSearchBackendEnv();
    expect(out.__SEARCH_BRIDGE_PROBE__).toBe("probe-value");
    delete process.env.__SEARCH_BRIDGE_PROBE__;
  });
});
