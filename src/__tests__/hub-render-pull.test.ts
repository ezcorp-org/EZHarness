/**
 * Extension Pages Hub — render-pull tests (`$lib/server/hub-render-pull`).
 *
 * The production subprocess collaborators are injected (`callPage`,
 * `findPage`, `cache`) so every branch — fresh/stale/miss, timeout,
 * error envelope, invalid tree, grant-fed allowlist — runs without a
 * real extension process.
 */
import { test, expect, describe, mock, afterAll } from "bun:test";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

// $lib/server/context pulls the whole server boot — stub the one
// accessor the module needs (the PRODUCTION callPage path reads it).
mock.module("$lib/server/context", () => ({ getBus: () => null }));
// Fake the subprocess collaborators so the DEFAULT (non-injected)
// callPage path is coverable without spawning anything. The fakes
// record the wiring sequence; `__fakeProcResponse` drives the result.
const fakeRegistryCalls: string[] = [];
let __fakeProcResponse: unknown = null;
mock.module("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getProcess: async (id: string) => {
        fakeRegistryCalls.push(`getProcess:${id}`);
        return {
          call: async (method: string, params: Record<string, unknown>) => {
            fakeRegistryCalls.push(`call:${method}:${String(params.pageId)}`);
            return { jsonrpc: "2.0", id: 1, result: __fakeProcResponse };
          },
        };
      },
    }),
  },
}));
mock.module("$server/extensions/tool-executor", () => ({
  ToolExecutor: class {
    async ensureSubprocessRpcWired(id: string) {
      fakeRegistryCalls.push(`wire:${id}`);
    }
  },
}));
mock.module("$server/extensions/permission-engine", () => ({
  getPermissionEngine: () => ({}),
}));
mock.module("$server/extensions/page-schema", () => require("../extensions/page-schema"));
mock.module("$server/extensions/page-cache", () => require("../extensions/page-cache"));
mock.module("$server/extensions/types", () => require("../extensions/types"));
mock.module("$server/db/queries/extensions", () => require("../db/queries/extensions"));
mock.module("$server/db/schema", () => require("../db/schema"));
const realLogger = require("../logger");
mock.module("$server/logger", () => realLogger);
mock.module("$lib/hub", () => require("../../web/src/lib/hub"));
mock.module("$lib/server/hub-extension-pages", () => require("../../web/src/lib/server/hub-extension-pages"));

// Dynamic import AFTER the mocks above — the fake registry/tool-executor
// factories must be registered before this module binds its imports
// (same pattern as extension-events-hub-branch.test.ts).
const { renderExtensionPage } = await import("../../web/src/lib/server/hub-render-pull");
import type { RenderPullDeps } from "../../web/src/lib/server/hub-render-pull";
import { ExtensionPageCache } from "../extensions/page-cache";
import type { Extension } from "../db/schema";
import type { JsonRpcResponse } from "../extensions/types";

afterAll(() => {
  // In-file ≥2-registration pattern (mock-cleanup meta-test): the
  // factories already point at the real modules.
  mock.module("$lib/hub", () => require("../../web/src/lib/hub"));
  mock.module("$lib/server/hub-extension-pages", () => require("../../web/src/lib/server/hub-extension-pages"));
  mock.module("$server/logger", () => realLogger);
  restoreModuleMocks();
});

const PAGE = { id: "dashboard", title: "Dash" };

function makeExtension(overrides: Partial<Extension> = {}): Extension {
  return {
    id: "ext-1",
    name: "cron-dashboard",
    enabled: true,
    manifest: { pages: [PAGE] },
    grantedPermissions: {
      eventSubscriptions: ["cron-dashboard:clear-log"],
      grantedAt: {},
    },
    ...overrides,
  } as unknown as Extension;
}

const VALID_RESULT = {
  title: "Cron Dashboard",
  nodes: [
    { type: "heading", level: 2, text: "Runs" },
    { type: "button", label: "Clear", action: { event: "cron-dashboard:clear-log" } },
    { type: "button", label: "Forged", action: { event: "other:event" } },
  ],
};

function okResponse(result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: 1, result };
}

function makeDeps(overrides: Partial<RenderPullDeps> = {}): RenderPullDeps & { calls: string[] } {
  const calls: string[] = [];
  const extension = makeExtension();
  return {
    calls,
    findPage: async () => ({ extension, page: PAGE }),
    callPage: async (_ext, pageId) => {
      calls.push(pageId);
      return okResponse(VALID_RESULT);
    },
    cache: new ExtensionPageCache(),
    timeoutMs: 200,
    ...overrides,
  };
}

describe("renderExtensionPage", () => {
  test("notFound when the page/extension can't be resolved", async () => {
    const deps = makeDeps({ findPage: async () => null });
    const result = await renderExtensionPage("nope", "dashboard", "u1", deps);
    expect(result).toEqual({ notFound: true });
    expect(deps.calls).toHaveLength(0);
  });

  test("miss: pulls, validates with GRANTED events, caches, returns", async () => {
    const deps = makeDeps();
    const result = await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    expect(result.page).toBeDefined();
    expect(result.page!.title).toBe("Cron Dashboard");
    // Granted action kept, un-granted action dropped by validation.
    const labels = result.page!.nodes
      .filter((n: { type: string }) => n.type === "button")
      .map((n: { label?: string }) => n.label);
    expect(labels).toEqual(["Clear"]);
    expect(deps.calls).toEqual(["dashboard"]);
    // Cached for the next caller.
    expect(deps.cache.get("ext-1", "dashboard")).not.toBeNull();
  });

  test("a >64KB subprocess result → {error} envelope, nothing cached (size cap pin)", async () => {
    // Pin the size ladder end-to-end through the pull path: an
    // oversized tree must fold into the standard error envelope (it
    // fails validatePageTree's MAX_PAGE_TREE_BYTES gate), never get
    // cached, and never throw.
    const huge = {
      title: "Huge",
      nodes: [{ type: "text", content: "x".repeat(70_000) }],
    };
    const deps = makeDeps({ callPage: async () => okResponse(huge) });
    const result = await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    expect(result.error).toBe("This page produced invalid content.");
    expect(result.page).toBeUndefined();
    expect(deps.cache.get("ext-1", "dashboard")).toBeNull();
  });

  test("fresh cache hit short-circuits the subprocess", async () => {
    const deps = makeDeps();
    await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    const second = await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    expect(second.page).toBeDefined();
    expect(second.stale).toBeUndefined();
    expect(deps.calls).toHaveLength(1); // only the first pull
  });

  test("stale cache serves immediately with stale:true and refreshes in the background", async () => {
    let now = 1_000;
    const cache = new ExtensionPageCache(60_000, () => now);
    const deps = makeDeps({ cache });
    await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    now += 60_001; // entry is now stale

    const result = await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    expect(result.stale).toBe(true);
    expect(result.page!.title).toBe("Cron Dashboard");

    // Background refresh lands on a later tick and re-stamps the entry.
    await new Promise((r) => setTimeout(r, 10));
    expect(deps.calls).toHaveLength(2);
    expect(cache.get("ext-1", "dashboard")!.stale).toBe(false);
  });

  test("background refresh failures are swallowed (stale content still served)", async () => {
    let now = 1_000;
    const cache = new ExtensionPageCache(60_000, () => now);
    let pulls = 0;
    const deps = makeDeps({
      cache,
      callPage: async () => {
        pulls++;
        if (pulls > 1) throw new Error("subprocess gone");
        return okResponse(VALID_RESULT);
      },
    });
    await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    now += 60_001;
    const result = await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    expect(result.stale).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(pulls).toBe(2); // refresh attempted, failure folded
  });

  test("subprocess JSON-RPC error envelope → {error}", async () => {
    const deps = makeDeps({
      callPage: async () => ({ jsonrpc: "2.0", id: 1, error: { code: -32602, message: "Unknown page" } }),
    });
    const result = await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    expect(result.error).toContain("failed to render");
    expect(deps.cache.get("ext-1", "dashboard")).toBeNull();
  });

  test("subprocess rejection → {error}", async () => {
    const deps = makeDeps({
      callPage: async () => {
        throw new Error("spawn failed");
      },
    });
    const result = await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    expect(result.error).toContain("failed to render");
  });

  test("hung subprocess hits the NON-LETHAL timeout race", async () => {
    const deps = makeDeps({
      timeoutMs: 30,
      callPage: () => new Promise(() => {}), // never settles
    });
    const result = await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    expect(result.error).toContain("failed to render");
  });

  test("invalid tree from the subprocess → {error}, nothing cached", async () => {
    const deps = makeDeps({ callPage: async () => okResponse({ bogus: true }) });
    const result = await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    expect(result.error).toContain("invalid content");
    expect(deps.cache.get("ext-1", "dashboard")).toBeNull();
  });

  test("missing grantedPermissions → empty allowlist (action nodes dropped)", async () => {
    const extension = makeExtension({ grantedPermissions: null as never });
    const deps = makeDeps({ findPage: async () => ({ extension, page: PAGE }) });
    const result = await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    expect(result.page!.nodes.filter((n: { type: string }) => n.type === "button")).toHaveLength(0);
  });

  test("default (non-injected) callPage spawns, wires, and requests ezcorp/page.render", async () => {
    fakeRegistryCalls.length = 0;
    __fakeProcResponse = VALID_RESULT;
    const extension = makeExtension();
    // Inject only the page lookup + a fresh cache — callPage defaults
    // to the production subprocess path (faked module collaborators).
    const result = await renderExtensionPage("cron-dashboard", "dashboard", "u1", {
      findPage: async () => ({ extension, page: PAGE }),
      cache: new ExtensionPageCache(),
    });
    expect(result.page!.title).toBe("Cron Dashboard");
    expect(fakeRegistryCalls).toEqual([
      "getProcess:ext-1",
      "wire:ext-1",
      "call:ezcorp/page.render:dashboard",
    ]);
  });

  test("a cache.set failure in the background refresh is folded by the outer catch", async () => {
    let now = 1_000;
    const inner = new ExtensionPageCache(60_000, () => now);
    let sets = 0;
    const throwingCache = {
      get: inner.get.bind(inner),
      invalidate: inner.invalidate.bind(inner),
      invalidateExtension: inner.invalidateExtension.bind(inner),
      clear: inner.clear.bind(inner),
      set: (extId: string, pageId: string, tree: never) => {
        sets++;
        if (sets > 1) throw new Error("cache exploded");
        inner.set(extId, pageId, tree);
      },
    } as unknown as ExtensionPageCache;
    const deps = makeDeps({ cache: throwingCache });
    await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    now += 60_001;
    const result = await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    expect(result.stale).toBe(true);
    await new Promise((r) => setTimeout(r, 10));
    expect(sets).toBe(2); // refresh attempted; its throw was folded, not unhandled
  });
});
