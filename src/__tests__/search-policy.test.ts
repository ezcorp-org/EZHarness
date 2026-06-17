/**
 * The 3-layer capability policy resolver (`src/search/policy.ts`).
 *
 * Drives `getSetting` via a mutable in-memory map so the suite exercises
 * every layer interaction without a DB: the hard-default fallback (no
 * instance setting), instance defaults overriding the hard default, and
 * grant overrides field-level-merging over the instance defaults. Inherit
 * propagation is proven by mutating an instance default and re-resolving
 * an `"inherit"` grant (sees the change) vs an explicit override (does
 * not).
 *
 * `mergeSearchPolicy` is pure (no DB) and exercised directly for the
 * field-level merge matrix; `resolveSearchPolicy` is exercised through
 * the mocked `getSetting` for the live read path.
 */
import { test, expect, describe, beforeEach, afterAll, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

/** Mutable settings backing store the mocked `getSetting` reads. */
const settingsStore = new Map<string, unknown>();

mock.module("../db/queries/settings", () => ({
  async getSetting(key: string) {
    return settingsStore.get(key);
  },
  async getAllSettings() {
    return Object.fromEntries(settingsStore);
  },
  async upsertSetting(key: string, value: unknown) {
    settingsStore.set(key, value);
  },
  async deleteSetting(key: string) {
    return settingsStore.delete(key);
  },
  async isListingInstalled() {
    return false;
  },
}));

import {
  HARD_SEARCH_DEFAULTS,
  SEARCH_SETTING_KEYS,
  mergeSearchPolicy,
  resolveSearchPolicy,
  resolveCapabilityPolicy,
  getSearchInstanceDefaults,
  getSearchAllowedByDefault,
  providerAllowed,
  type SearchPolicy,
} from "../search/policy";
import type { ExtensionPermissions } from "../extensions/types";

beforeEach(() => {
  settingsStore.clear();
});

afterAll(() => {
  restoreModuleMocks();
});

const INSTANCE: SearchPolicy = { quota: 50, maxResults: 8, providers: ["searxng", "duckduckgo"] };

describe("mergeSearchPolicy (pure field-level merge)", () => {
  test("grant false → denied", () => {
    expect(mergeSearchPolicy(false, INSTANCE)).toEqual({ denied: true });
  });

  test("grant 'inherit' → the instance defaults verbatim", () => {
    expect(mergeSearchPolicy("inherit", INSTANCE)).toEqual({ denied: false, ...INSTANCE });
  });

  test("grant undefined → treated as inherit (instance defaults)", () => {
    expect(mergeSearchPolicy(undefined, INSTANCE)).toEqual({ denied: false, ...INSTANCE });
  });

  test("object override: only DEFINED fields win; undefined fall through", () => {
    const merged = mergeSearchPolicy({ quota: 500 }, INSTANCE);
    expect(merged).toEqual({
      denied: false,
      quota: 500, // overridden
      maxResults: 8, // inherited
      providers: ["searxng", "duckduckgo"], // inherited
    });
  });

  test("object override: providers:'inherit' tracks the instance default for that field only", () => {
    const merged = mergeSearchPolicy({ maxResults: 2, providers: "inherit" }, INSTANCE);
    expect(merged).toEqual({
      denied: false,
      quota: 50, // inherited
      maxResults: 2, // overridden
      providers: ["searxng", "duckduckgo"], // tracks instance via "inherit"
    });
  });

  test("object override: explicit provider list replaces the instance allowlist", () => {
    const merged = mergeSearchPolicy({ providers: ["tavily"] }, INSTANCE);
    expect(merged).toEqual({ denied: false, quota: 50, maxResults: 8, providers: ["tavily"] });
  });

  test("empty object override → all fields inherited", () => {
    expect(mergeSearchPolicy({}, INSTANCE)).toEqual({ denied: false, ...INSTANCE });
  });
});

describe("getSearchInstanceDefaults (instance layer)", () => {
  test("no settings → the hard defaults per field", async () => {
    expect(await getSearchInstanceDefaults()).toEqual(HARD_SEARCH_DEFAULTS);
  });

  test("partial settings → set fields override, unset fall back to hard default", async () => {
    settingsStore.set(SEARCH_SETTING_KEYS.defaultQuota, 25);
    const def = await getSearchInstanceDefaults();
    expect(def.quota).toBe(25);
    expect(def.maxResults).toBe(HARD_SEARCH_DEFAULTS.maxResults);
    expect(def.providers).toBe("all");
  });

  test("'all' providers setting normalizes to 'all'", async () => {
    settingsStore.set(SEARCH_SETTING_KEYS.defaultProviders, "all");
    expect((await getSearchInstanceDefaults()).providers).toBe("all");
  });

  test("array providers setting passes through; non-string entries dropped", async () => {
    settingsStore.set(SEARCH_SETTING_KEYS.defaultProviders, ["searxng", 7, "", "brave"]);
    expect((await getSearchInstanceDefaults()).providers).toEqual(["searxng", "brave"]);
  });

  test("empty array providers → falls back to hard default ('all')", async () => {
    settingsStore.set(SEARCH_SETTING_KEYS.defaultProviders, []);
    expect((await getSearchInstanceDefaults()).providers).toBe("all");
  });

  test("malformed numeric setting (NaN / <1 / string) → hard default for that field", async () => {
    settingsStore.set(SEARCH_SETTING_KEYS.defaultQuota, "lots");
    settingsStore.set(SEARCH_SETTING_KEYS.defaultMaxResults, 0);
    const def = await getSearchInstanceDefaults();
    expect(def.quota).toBe(HARD_SEARCH_DEFAULTS.quota);
    expect(def.maxResults).toBe(HARD_SEARCH_DEFAULTS.maxResults);
  });

  test("malformed providers setting (object) → hard default", async () => {
    settingsStore.set(SEARCH_SETTING_KEYS.defaultProviders, { nope: true });
    expect((await getSearchInstanceDefaults()).providers).toBe("all");
  });
});

describe("getSearchAllowedByDefault", () => {
  test("unset → true (default ON)", async () => {
    expect(await getSearchAllowedByDefault()).toBe(true);
  });
  test("explicit false → false", async () => {
    settingsStore.set(SEARCH_SETTING_KEYS.allowedByDefault, false);
    expect(await getSearchAllowedByDefault()).toBe(false);
  });
  test("explicit true → true", async () => {
    settingsStore.set(SEARCH_SETTING_KEYS.allowedByDefault, true);
    expect(await getSearchAllowedByDefault()).toBe(true);
  });
});

describe("resolveSearchPolicy (live read path through getSetting)", () => {
  test("hard-default fallback: no instance setting + inherit grant → hard defaults", async () => {
    expect(await resolveSearchPolicy("inherit")).toEqual({ denied: false, ...HARD_SEARCH_DEFAULTS });
  });

  test("false grant → denied (instance settings irrelevant)", async () => {
    settingsStore.set(SEARCH_SETTING_KEYS.defaultQuota, 999);
    expect(await resolveSearchPolicy(false)).toEqual({ denied: true });
  });

  test("inherit grant reflects the live instance defaults", async () => {
    settingsStore.set(SEARCH_SETTING_KEYS.defaultQuota, 42);
    settingsStore.set(SEARCH_SETTING_KEYS.defaultMaxResults, 11);
    const resolved = await resolveSearchPolicy("inherit");
    expect(resolved).toEqual({ denied: false, quota: 42, maxResults: 11, providers: "all" });
  });

  test("inherit PROPAGATION: changing a default re-resolves for an inheriter; an explicit override is unaffected", async () => {
    const inheriter: ExtensionPermissions["search"] = "inherit";
    const overrider: ExtensionPermissions["search"] = { quota: 7 };

    settingsStore.set(SEARCH_SETTING_KEYS.defaultQuota, 100);
    expect((await resolveSearchPolicy(inheriter) as SearchPolicy).quota).toBe(100);
    expect((await resolveSearchPolicy(overrider) as SearchPolicy).quota).toBe(7);

    // Admin raises the instance default.
    settingsStore.set(SEARCH_SETTING_KEYS.defaultQuota, 250);
    expect((await resolveSearchPolicy(inheriter) as SearchPolicy).quota).toBe(250); // propagated
    expect((await resolveSearchPolicy(overrider) as SearchPolicy).quota).toBe(7); // sticks
  });

  test("field-level override over instance defaults via the live path", async () => {
    settingsStore.set(SEARCH_SETTING_KEYS.defaultQuota, 80);
    settingsStore.set(SEARCH_SETTING_KEYS.defaultMaxResults, 9);
    settingsStore.set(SEARCH_SETTING_KEYS.defaultProviders, ["searxng"]);
    const resolved = await resolveSearchPolicy({ maxResults: 3 });
    expect(resolved).toEqual({ denied: false, quota: 80, maxResults: 3, providers: ["searxng"] });
  });

  test("resolveCapabilityPolicy('search', …) is the generic entry behind resolveSearchPolicy", async () => {
    settingsStore.set(SEARCH_SETTING_KEYS.defaultQuota, 33);
    expect(await resolveCapabilityPolicy("search", "inherit")).toEqual(
      await resolveSearchPolicy("inherit"),
    );
    expect((await resolveCapabilityPolicy("search", "inherit") as SearchPolicy).quota).toBe(33);
  });
});

describe("providerAllowed", () => {
  test("'all' allows any provider", () => {
    expect(providerAllowed({ ...HARD_SEARCH_DEFAULTS }, "tavily")).toBe(true);
  });
  test("explicit list allows members, denies non-members", () => {
    const p: SearchPolicy = { quota: 1, maxResults: 1, providers: ["searxng"] };
    expect(providerAllowed(p, "searxng")).toBe(true);
    expect(providerAllowed(p, "tavily")).toBe(false);
  });
});
