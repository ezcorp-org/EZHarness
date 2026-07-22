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

// $lib/server/context pulls the whole server boot — stub the accessors
// the module needs (the PRODUCTION callPage path reads them). getExecutor
// MUST be present even though this file never wants an executor: a
// partial mock that omits a named export fails EVERY import of the
// module for the rest of the process (see the identical note in
// extension-events-hub-branch.test.ts). Throwing keeps the guarded
// executor-less path exercised.
mock.module("$lib/server/context", () => ({
  getBus: () => null,
  getExecutor: () => {
    throw new Error("executor not booted (test context)");
  },
}));
// Fake the subprocess collaborators so the DEFAULT (non-injected)
// callPage path is coverable without spawning anything. The fakes
// record the wiring sequence; `__fakeProcResponse` drives the result.
const fakeRegistryCalls: string[] = [];
let __fakeProcResponse: unknown = null;
// Lets a test observe the params (incl. `_meta.ezCallId`) the production
// path stamps on the `ezcorp/page.render` forward call — and resolve the
// live provenance token mid-call.
let __fakeProcInspect: ((method: string, params: Record<string, unknown>) => void) | null = null;
mock.module("$server/extensions/registry", () => ({
  ExtensionRegistry: {
    getInstance: () => ({
      getProcess: async (id: string) => {
        fakeRegistryCalls.push(`getProcess:${id}`);
        return {
          call: async (method: string, params: Record<string, unknown>) => {
            fakeRegistryCalls.push(`call:${method}:${String(params.pageId)}`);
            __fakeProcInspect?.(method, params);
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
// The production path late-imports listProjects for the GLOBAL render of
// a perProject page — controllable fake, no DB. DELEGATE every other
// export to the real module (same partial-mock rule as the context stub
// above: hub-api.test.ts's route needs getProject from this module id
// when the two files share a process).
let __fakeProjects: Array<{ id: string; name: string; path: string }> = [];
mock.module("$server/db/queries/projects", () => ({
  ...require("../db/queries/projects"),
  listProjects: async () => __fakeProjects,
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
import { resolveCallProvenance } from "../extensions/call-provenance";
import { ExtensionPageCache } from "../extensions/page-cache";
import type { Extension } from "../db/schema";
import type { JsonRpcResponse } from "../extensions/types";

afterAll(() => {
  // In-file ≥2-registration pattern (mock-cleanup meta-test): the
  // factories already point at the real modules.
  mock.module("$lib/hub", () => require("../../web/src/lib/hub"));
  mock.module("$lib/server/hub-extension-pages", () => require("../../web/src/lib/server/hub-extension-pages"));
  mock.module("$server/db/queries/projects", () => require("../db/queries/projects"));
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

  test("production callPage mints a render-scoped provenance token, stamps _meta.ezCallId, and releases it after", async () => {
    __fakeProcResponse = VALID_RESULT;
    let observed: { ezCallId: unknown; prov: ReturnType<typeof resolveCallProvenance> } | null = null;
    // Snapshot the token + resolve it WHILE the render call is in flight —
    // this is exactly when the subprocess's reverse-RPC `fs.read` would
    // resolve the same token, so it proves the read would be authorized.
    __fakeProcInspect = (_method, params) => {
      const ezCallId = (params._meta as Record<string, unknown> | undefined)?.ezCallId;
      observed = { ezCallId, prov: resolveCallProvenance(ezCallId as string) };
    };
    try {
      const extension = makeExtension();
      await renderExtensionPage("cron-dashboard", "dashboard", "user-42", {
        findPage: async () => ({ extension, page: PAGE }),
        cache: new ExtensionPageCache(),
      });
    } finally {
      __fakeProcInspect = null;
    }

    expect(observed).not.toBeNull();
    const seen = observed!;
    // A real host-issued token rode on `_meta.ezCallId`...
    expect(typeof seen.ezCallId).toBe("string");
    expect((seen.ezCallId as string).length).toBeGreaterThan(0);
    // ...and it resolved DURING the call to the viewing user + this
    // extension, with kind "render" (so fs.read's owner gate passes).
    expect(seen.prov).toBeDefined();
    expect(seen.prov!.onBehalfOf).toBe("user-42");
    expect(seen.prov!.actorExtensionId).toBe("ext-1");
    expect(seen.prov!.kind).toBe("render");
    expect(seen.prov!.ownerless).toBe(false);
    // ...and it was released in the `finally` once render returned (no leak).
    expect(resolveCallProvenance(seen.ezCallId as string)).toBeUndefined();
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

// ── perProject scope (project-aware renders) ─────────────────────────

describe("perProject scope", () => {
  const PER_PROJECT_PAGE = { id: "dashboard", title: "Dash", perProject: true };
  const PROJECT = { id: "proj-1", name: "My App", path: "/home/dev/my-app" };

  function makeScopedDeps(overrides: Partial<RenderPullDeps> = {}) {
    const scopes: unknown[] = [];
    const extension = makeExtension();
    const deps: RenderPullDeps & { scopes: unknown[] } = {
      scopes,
      findPage: async () => ({ extension, page: PER_PROJECT_PAGE }),
      callPage: async (_ext, _pageId, _userId, scope) => {
        scopes.push(scope);
        return okResponse(VALID_RESULT);
      },
      cache: new ExtensionPageCache(),
      timeoutMs: 200,
      ...overrides,
    };
    return deps;
  }

  test("project render: callPage gets {project}, result caches under the project variant", async () => {
    const deps = makeScopedDeps();
    const result = await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps, PROJECT);
    expect(result.page!.title).toBe("Cron Dashboard");
    expect(deps.scopes).toEqual([{ project: PROJECT }]);
    expect(deps.cache.get("ext-1", "dashboard", PROJECT.id)).not.toBeNull();
    expect(deps.cache.get("ext-1", "dashboard")).toBeNull();
  });

  test("global render of a perProject page requests the project LIST", async () => {
    const deps = makeScopedDeps();
    const result = await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    expect(result.page).toBeDefined();
    expect(deps.scopes).toEqual([{ listProjects: true }]);
    expect(deps.cache.get("ext-1", "dashboard")).not.toBeNull();
  });

  test("variants are cached independently — a project render never serves the global tree", async () => {
    const deps = makeScopedDeps();
    await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    const second = await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps, PROJECT);
    expect(second.page).toBeDefined();
    // Two real pulls (no cross-variant cache hit), one per scope.
    expect(deps.scopes).toEqual([{ listProjects: true }, { project: PROJECT }]);
  });

  test("non-perProject page IGNORES a provided project (global scope + global cache)", async () => {
    const extension = makeExtension();
    const deps = makeScopedDeps({
      findPage: async () => ({ extension, page: PAGE }),
    });
    await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps, PROJECT);
    expect(deps.scopes).toEqual([undefined]);
    expect(deps.cache.get("ext-1", "dashboard")).not.toBeNull();
    expect(deps.cache.get("ext-1", "dashboard", PROJECT.id)).toBeNull();
  });

  test("run + step render variants cache under distinct keys (step isolated from the run detail)", async () => {
    const deps = makeScopedDeps();
    await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps, undefined, "run_a"); // run detail
    await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps, undefined, "run_a", "review"); // step detail
    // Two real pulls, distinct scopes (step rides alongside the run + listProjects).
    expect(deps.scopes).toEqual([
      { listProjects: true, run: "run_a" },
      { listProjects: true, run: "run_a", step: "review" },
    ]);
    // The run detail caches under `run:run_a`; the step detail under
    // `run:run_a:step:review` — independent slots, no collision.
    expect(deps.cache.get("ext-1", "dashboard", "run:run_a")).not.toBeNull();
    expect(deps.cache.get("ext-1", "dashboard", "run:run_a:step:review")).not.toBeNull();
    expect(deps.cache.get("ext-1", "dashboard", "run:run_a:step:test")).toBeNull();
  });

  test("a stray step WITHOUT run does not fork a step cache variant", async () => {
    const deps = makeScopedDeps();
    // perProject page, no run, stray step → the dashboard (listProjects) scope,
    // no step; hub-render-pull drops the meaningless step.
    await renderExtensionPage("cron-dashboard", "dashboard", "u1", deps, undefined, undefined, "review");
    expect(deps.scopes).toEqual([{ listProjects: true }]);
    expect(deps.cache.get("ext-1", "dashboard")).not.toBeNull();
  });

  test("production callPage forwards {project} on the render RPC", async () => {
    __fakeProcResponse = VALID_RESULT;
    const seen: Record<string, unknown>[] = [];
    __fakeProcInspect = (_method, params) => seen.push(params);
    try {
      const extension = makeExtension();
      await renderExtensionPage("cron-dashboard", "dashboard", "u1", {
        findPage: async () => ({ extension, page: PER_PROJECT_PAGE }),
        cache: new ExtensionPageCache(),
      }, PROJECT);
    } finally {
      __fakeProcInspect = null;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.project).toEqual(PROJECT);
    expect(seen[0]!.projects).toBeUndefined();
  });

  test("production callPage forwards the {projects} list on a global render", async () => {
    __fakeProcResponse = VALID_RESULT;
    __fakeProjects = [
      { id: "p-a", name: "A", path: "/a" },
      { id: "p-b", name: "B", path: "/b" },
    ];
    const seen: Record<string, unknown>[] = [];
    __fakeProcInspect = (_method, params) => seen.push(params);
    try {
      const extension = makeExtension();
      await renderExtensionPage("cron-dashboard", "dashboard", "u1", {
        findPage: async () => ({ extension, page: PER_PROJECT_PAGE }),
        cache: new ExtensionPageCache(),
      });
    } finally {
      __fakeProcInspect = null;
      __fakeProjects = [];
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.projects).toEqual([
      { id: "p-a", name: "A", path: "/a" },
      { id: "p-b", name: "B", path: "/b" },
    ]);
    expect(seen[0]!.project).toBeUndefined();
  });

  test("production callPage forwards {view} on the render RPC (independent of run/project)", async () => {
    __fakeProcResponse = VALID_RESULT;
    const seen: Record<string, unknown>[] = [];
    __fakeProcInspect = (_method, params) => seen.push(params);
    try {
      const extension = makeExtension();
      // A non-perProject page, no run — view still forwards (independent).
      await renderExtensionPage(
        "cron-dashboard",
        "dashboard",
        "u1",
        { findPage: async () => ({ extension, page: PAGE }), cache: new ExtensionPageCache() },
        undefined,
        undefined,
        undefined,
        "config",
      );
    } finally {
      __fakeProcInspect = null;
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]!.view).toBe("config");
    expect(seen[0]!.run).toBeUndefined();
    expect(seen[0]!.step).toBeUndefined();
  });
});

// ── single-flight dedup ──────────────────────────────────────────────

describe("single-flight pull dedup", () => {
  test("concurrent renders of the SAME variant share one subprocess pull", async () => {
    let resolvePull: ((r: JsonRpcResponse) => void) | null = null;
    let pulls = 0;
    const deps = makeDeps({
      callPage: () => {
        pulls++;
        return new Promise<JsonRpcResponse>((resolve) => {
          resolvePull = resolve;
        });
      },
    });
    const first = renderExtensionPage("cron-dashboard", "dashboard", "u1", deps);
    const second = renderExtensionPage("cron-dashboard", "dashboard", "u2", deps);
    await new Promise((r) => setTimeout(r, 5));
    resolvePull!(okResponse(VALID_RESULT));
    const [a, b] = await Promise.all([first, second]);
    expect(a.page).toBeDefined();
    expect(b.page).toBeDefined();
    expect(pulls).toBe(1); // the herd collapsed to one render
  });

  test("different variants of one page pull independently", async () => {
    const seen: Array<string | undefined> = [];
    const perProjectPage = { id: "dashboard", title: "Dash", perProject: true };
    const extension = makeExtension();
    const deps = makeDeps({
      findPage: async () => ({ extension, page: perProjectPage }),
      callPage: async (_e, _p, _u, scope) => {
        seen.push(scope?.project?.id);
        return okResponse(VALID_RESULT);
      },
    });
    await Promise.all([
      renderExtensionPage("cron-dashboard", "dashboard", "u1", deps, {
        id: "p-1",
        name: "A",
        path: "/a",
      }),
      renderExtensionPage("cron-dashboard", "dashboard", "u1", deps, {
        id: "p-2",
        name: "B",
        path: "/b",
      }),
    ]);
    expect(seen.sort()).toEqual(["p-1", "p-2"]); // two variants, two pulls
  });
});
