/**
 * Daily Briefing Phase 3 — web-search extension resolution + agent
 * reference sync (src/runtime/briefing/web-search.ts).
 *
 * Pure-mock suite (no DB): both DB query modules are stubbed so every
 * branch — missing/disabled extension, manifest pathologies, sync
 * no-op / append / drift / removal, throw seams — is drivable
 * deterministically. Mocked modules (≥2-mocks rule: in-file snapshot
 * + literal re-register in afterAll; both paths are in MODULE_PATHS):
 *   - ../db/queries/extensions     (getExtensionByName)
 *   - ../db/queries/agent-configs  (updateAgentConfig)
 */
import { test, expect, describe, afterAll, beforeEach, mock } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

const realExtensions = { ...(await import("../db/queries/extensions")) };
const realAgentConfigs = { ...(await import("../db/queries/agent-configs")) };

type ExtRow = {
  id: string;
  enabled: boolean;
  manifest: { name?: string; tools?: Array<{ name?: unknown }> };
} | null;

let extRow: ExtRow = null;
let extThrow: Error | null = null;
let updateCalls: Array<{ id: string; data: Record<string, unknown> }> = [];
let updateThrow: Error | null = null;

mock.module("../db/queries/extensions", () => ({
  ...realExtensions,
  getExtensionByName: async (name: string) => {
    if (extThrow) throw extThrow;
    expect(name).toBe("web-search");
    return extRow;
  },
}));

mock.module("../db/queries/agent-configs", () => ({
  ...realAgentConfigs,
  updateAgentConfig: async (id: string, data: Record<string, unknown>) => {
    if (updateThrow) throw updateThrow;
    updateCalls.push({ id, data });
    return { id } as unknown;
  },
}));

import {
  resolveBriefingWebSearch,
  syncBriefingAgentWebSearch,
  READ_SAFE_TOOL_NAMES,
  WEB_SEARCH_EXTENSION_NAME,
  type BriefingWebSearch,
} from "../runtime/briefing/web-search";
import type { DbAgentConfig } from "../db/queries/agent-configs";

afterAll(() => {
  mock.module("../db/queries/extensions", () => realExtensions);
  mock.module("../db/queries/agent-configs", () => realAgentConfigs);
  restoreModuleMocks();
});

beforeEach(() => {
  extRow = null;
  extThrow = null;
  updateCalls = [];
  updateThrow = null;
});

const ENABLED_EXT: NonNullable<ExtRow> = {
  id: "ext-ws-1",
  enabled: true,
  manifest: {
    name: "web-search",
    tools: [{ name: "search-web" }, { name: "read-url" }],
  },
};

function agent(overrides: Partial<DbAgentConfig> = {}): DbAgentConfig {
  return {
    id: "agent-briefing-1",
    extensions: [],
    extensionTools: null,
    ...overrides,
  } as unknown as DbAgentConfig;
}

describe("resolveBriefingWebSearch", () => {
  test("constant pins the bundled example extension's name", () => {
    expect(WEB_SEARCH_EXTENSION_NAME).toBe("web-search");
  });

  test("installed + enabled → available with namespaced manifest tool names", async () => {
    extRow = ENABLED_EXT;
    const ws = await resolveBriefingWebSearch();
    expect(ws).toEqual({
      available: true,
      extensionId: "ext-ws-1",
      toolNames: ["web-search__search-web", "web-search__read-url"],
    });
  });

  test("not installed → unavailable", async () => {
    extRow = null;
    expect(await resolveBriefingWebSearch()).toEqual({
      available: false,
      extensionId: null,
      toolNames: [],
    });
  });

  test("installed but disabled → unavailable", async () => {
    extRow = { ...ENABLED_EXT, enabled: false };
    expect((await resolveBriefingWebSearch()).available).toBe(false);
  });

  test("manifest with no tools → unavailable (nothing to vouch for)", async () => {
    extRow = { ...ENABLED_EXT, manifest: { name: "web-search", tools: [] } };
    expect((await resolveBriefingWebSearch()).available).toBe(false);
  });

  test("malformed tool entries are skipped; missing manifest name falls back", async () => {
    extRow = {
      id: "ext-ws-1",
      enabled: true,
      manifest: { tools: [{ name: "search-web" }, { name: "" }, {}] },
    };
    const ws = await resolveBriefingWebSearch();
    expect(ws.toolNames).toEqual(["web-search__search-web"]);
  });

  test("capability gate: the read-safe allowlist pins exactly the bundled search + read tools", () => {
    expect([...READ_SAFE_TOOL_NAMES].sort()).toEqual(["read-url", "search-web"]);
  });

  test("capability gate: a manifest with an extra write-capable tool gets ONLY the read-safe subset vouched", async () => {
    extRow = {
      id: "ext-ws-1",
      enabled: true,
      manifest: {
        name: "web-search",
        tools: [{ name: "search-web" }, { name: "save-page" }, { name: "read-url" }],
      },
    };
    const ws = await resolveBriefingWebSearch();
    expect(ws.available).toBe(true);
    expect(ws.toolNames).toEqual(["web-search__search-web", "web-search__read-url"]);
  });

  test("capability gate: a manifest with ONLY unknown tools → unavailable (nothing safe to vouch)", async () => {
    extRow = {
      id: "ext-ws-1",
      enabled: true,
      manifest: { name: "web-search", tools: [{ name: "save-page" }, { name: "post-form" }] },
    };
    expect(await resolveBriefingWebSearch()).toEqual({
      available: false,
      extensionId: null,
      toolNames: [],
    });
  });

  test("DB throw degrades to unavailable — never throws", async () => {
    extThrow = new Error("db exploded");
    expect(await resolveBriefingWebSearch()).toEqual({
      available: false,
      extensionId: null,
      toolNames: [],
    });
  });
});

describe("syncBriefingAgentWebSearch", () => {
  const AVAILABLE: BriefingWebSearch = {
    available: true,
    extensionId: "ext-ws-1",
    toolNames: ["web-search__search-web", "web-search__read-url"],
  };
  const UNAVAILABLE: BriefingWebSearch = {
    available: false,
    extensionId: null,
    toolNames: [],
  };

  test("available + unreferenced → appends id + exact tool subset", async () => {
    await syncBriefingAgentWebSearch(agent({ extensions: ["ext-other"] } as Partial<DbAgentConfig>), AVAILABLE);
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.id).toBe("agent-briefing-1");
    expect(updateCalls[0]!.data.extensions).toEqual(["ext-other", "ext-ws-1"]);
    expect(updateCalls[0]!.data.extensionTools).toEqual({
      "ext-ws-1": ["web-search__search-web", "web-search__read-url"],
    });
  });

  test("available + already in sync → no write (idempotent fast path)", async () => {
    await syncBriefingAgentWebSearch(
      agent({
        extensions: ["ext-ws-1"],
        extensionTools: { "ext-ws-1": ["web-search__search-web", "web-search__read-url"] },
      } as Partial<DbAgentConfig>),
      AVAILABLE,
    );
    expect(updateCalls).toHaveLength(0);
  });

  test("available + subset drift (new tool in manifest) → re-syncs the subset", async () => {
    await syncBriefingAgentWebSearch(
      agent({
        extensions: ["ext-ws-1"],
        extensionTools: { "ext-ws-1": ["web-search__search-web"] },
      } as Partial<DbAgentConfig>),
      AVAILABLE,
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.data.extensions).toEqual(["ext-ws-1"]);
    expect(updateCalls[0]!.data.extensionTools).toEqual({
      "ext-ws-1": ["web-search__search-web", "web-search__read-url"],
    });
  });

  test("unavailable + stale reference (ext row disabled) → removes ONLY the web-search reference", async () => {
    extRow = { ...ENABLED_EXT, enabled: false };
    await syncBriefingAgentWebSearch(
      agent({
        extensions: ["ext-other", "ext-ws-1"],
        extensionTools: { "ext-ws-1": ["web-search__search-web"], "ext-other": ["x__y"] },
      } as Partial<DbAgentConfig>),
      UNAVAILABLE,
    );
    expect(updateCalls).toHaveLength(1);
    expect(updateCalls[0]!.data.extensions).toEqual(["ext-other"]);
    expect(updateCalls[0]!.data.extensionTools).toEqual({ "ext-other": ["x__y"] });
  });

  test("unavailable + no reference → no write", async () => {
    extRow = { ...ENABLED_EXT, enabled: false };
    await syncBriefingAgentWebSearch(agent(), UNAVAILABLE);
    expect(updateCalls).toHaveLength(0);
  });

  test("unavailable + extension row gone → no write (nothing to key off; dangling ids are inert)", async () => {
    extRow = null;
    await syncBriefingAgentWebSearch(
      agent({ extensions: ["ext-ws-1"] } as Partial<DbAgentConfig>),
      UNAVAILABLE,
    );
    expect(updateCalls).toHaveLength(0);
  });

  test("update throw is swallowed — a sync failure never fails the run", async () => {
    updateThrow = new Error("write exploded");
    await expect(
      syncBriefingAgentWebSearch(agent(), AVAILABLE),
    ).resolves.toBeUndefined();
  });

  test("lookup throw on the removal path is swallowed too", async () => {
    extThrow = new Error("read exploded");
    await expect(
      syncBriefingAgentWebSearch(agent({ extensions: ["ext-ws-1"] } as Partial<DbAgentConfig>), UNAVAILABLE),
    ).resolves.toBeUndefined();
  });
});
