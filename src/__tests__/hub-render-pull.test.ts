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
// accessor the module needs (only the PRODUCTION callPage path uses it,
// which these tests never invoke).
mock.module("$lib/server/context", () => ({ getBus: () => null }));
mock.module("$server/extensions/registry", () => require("../extensions/registry"));
mock.module("$server/extensions/tool-executor", () => require("../extensions/tool-executor"));
mock.module("$server/extensions/permission-engine", () => require("../extensions/permission-engine"));
mock.module("$server/extensions/page-schema", () => require("../extensions/page-schema"));
mock.module("$server/extensions/page-cache", () => require("../extensions/page-cache"));
mock.module("$server/extensions/types", () => require("../extensions/types"));
mock.module("$server/db/queries/extensions", () => require("../db/queries/extensions"));
mock.module("$server/db/schema", () => require("../db/schema"));
const realLogger = require("../logger");
mock.module("$server/logger", () => realLogger);
mock.module("$lib/hub", () => require("../../web/src/lib/hub"));
mock.module("$lib/server/hub-extension-pages", () => require("../../web/src/lib/server/hub-extension-pages"));

import { renderExtensionPage, type RenderPullDeps } from "../../web/src/lib/server/hub-render-pull";
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
      .filter((n) => n.type === "button")
      .map((n) => (n as { label: string }).label);
    expect(labels).toEqual(["Clear"]);
    expect(deps.calls).toEqual(["dashboard"]);
    // Cached for the next caller.
    expect(deps.cache.get("ext-1", "dashboard")).not.toBeNull();
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
    expect(result.page!.nodes.filter((n) => n.type === "button")).toHaveLength(0);
  });
});
