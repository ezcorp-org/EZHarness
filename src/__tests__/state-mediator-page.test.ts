/**
 * ExtensionStateMediator — `ezcorp/page-state` handling (Extension
 * Pages Hub §2.5).
 *
 * The invalidation-signal contract under test:
 *   - method/params/size/rate gates shared with `ezcorp/state`
 *   - page must be DECLARED in manifest.pages (pageIds)
 *   - tree passes validatePageTree with the GRANTED eventSubscriptions
 *   - validated tree lands in the page cache
 *   - the bus event carries NO tree content
 */
import { test, expect, describe, beforeEach } from "bun:test";
import {
  ExtensionStateMediator,
  MAX_STATE_SIZE_BYTES,
  type MediatorManifest,
} from "../extensions/state-mediator";
import { getPageCache } from "../extensions/page-cache";
import { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import type { JsonRpcNotification } from "../extensions/types";

const EXT_ID = "ext-cron";

function makeMediator(manifest?: MediatorManifest) {
  const bus = new EventBus<AgentEvents>();
  const pageEvents: AgentEvents["ext:page-state"][] = [];
  const stateEvents: AgentEvents["ext:state"][] = [];
  bus.on("ext:page-state", (e) => pageEvents.push(e));
  bus.on("ext:state", (e) => stateEvents.push(e));
  const mediator = new ExtensionStateMediator(bus, () => manifest);
  return { mediator, pageEvents, stateEvents };
}

function notification(params: Record<string, unknown> | undefined, method = "ezcorp/page-state"): JsonRpcNotification {
  return { jsonrpc: "2.0", method, ...(params !== undefined ? { params } : {}) };
}

const MANIFEST: MediatorManifest = {
  name: "cron-dashboard",
  pageIds: ["dashboard"],
  eventSubscriptions: ["cron-dashboard:clear-log"],
};

const VALID_TREE = {
  title: "Cron Dashboard",
  nodes: [
    { type: "heading", level: 2, text: "Runs" },
    { type: "button", label: "Clear", action: { event: "cron-dashboard:clear-log" } },
  ],
};

beforeEach(() => {
  getPageCache().clear();
});

describe("ezcorp/page-state", () => {
  test("valid push: caches the validated tree + emits content-free signal", () => {
    const { mediator, pageEvents } = makeMediator(MANIFEST);
    mediator.handleNotification(EXT_ID, notification({ pageId: "dashboard", page: VALID_TREE }));

    expect(pageEvents).toHaveLength(1);
    const event = pageEvents[0]!;
    expect(event.extensionId).toBe(EXT_ID);
    expect(event.extensionName).toBe("cron-dashboard");
    expect(event.pageId).toBe("dashboard");
    expect(event.timestamp).toBeGreaterThan(0);
    // INVARIANT: no tree content on the bus event.
    expect(Object.keys(event).sort()).toEqual(["extensionId", "extensionName", "pageId", "timestamp"]);

    const cached = getPageCache().get(EXT_ID, "dashboard");
    expect(cached).not.toBeNull();
    expect(cached!.tree.title).toBe("Cron Dashboard");
    expect(cached!.tree.nodes).toHaveLength(2);
  });

  test("action nodes with un-granted events are stripped before caching", () => {
    const { mediator, pageEvents } = makeMediator(MANIFEST);
    mediator.handleNotification(
      EXT_ID,
      notification({
        pageId: "dashboard",
        page: {
          title: "T",
          nodes: [{ type: "button", label: "Forged", action: { event: "other:event" } }],
        },
      }),
    );
    expect(pageEvents).toHaveLength(1);
    expect(getPageCache().get(EXT_ID, "dashboard")!.tree.nodes).toHaveLength(0);
  });

  test("undeclared pageId is dropped (no cache, no emit)", () => {
    const { mediator, pageEvents } = makeMediator(MANIFEST);
    mediator.handleNotification(EXT_ID, notification({ pageId: "other-page", page: VALID_TREE }));
    expect(pageEvents).toHaveLength(0);
    expect(getPageCache().get(EXT_ID, "other-page")).toBeNull();
  });

  test("manifest without pageIds (no pages declared) drops the push", () => {
    const { mediator, pageEvents } = makeMediator({ name: "no-pages" });
    mediator.handleNotification(EXT_ID, notification({ pageId: "dashboard", page: VALID_TREE }));
    expect(pageEvents).toHaveLength(0);
  });

  test("unknown extension (no manifest) drops the push", () => {
    const { mediator, pageEvents } = makeMediator(undefined);
    mediator.handleNotification(EXT_ID, notification({ pageId: "dashboard", page: VALID_TREE }));
    expect(pageEvents).toHaveLength(0);
  });

  test("invalid tree envelope drops the push", () => {
    const { mediator, pageEvents } = makeMediator(MANIFEST);
    for (const page of [null, "string", { nodes: [] }, { title: 42, nodes: [] }]) {
      mediator.handleNotification(EXT_ID, notification({ pageId: "dashboard", page }));
    }
    expect(pageEvents).toHaveLength(0);
    expect(getPageCache().get(EXT_ID, "dashboard")).toBeNull();
  });

  test("invalid tree does NOT masquerade as an invalidation (cached variants survive)", () => {
    const { mediator, pageEvents } = makeMediator(MANIFEST);
    getPageCache().set(EXT_ID, "dashboard", VALID_TREE as never, "proj-1");
    mediator.handleNotification(
      EXT_ID,
      notification({ pageId: "dashboard", page: { title: 42, nodes: [] } }),
    );
    expect(pageEvents).toHaveLength(0);
    expect(getPageCache().get(EXT_ID, "dashboard", "proj-1")).not.toBeNull();
  });

  test("tree-less push = invalidate-only: drops every cached variant + emits the signal", () => {
    const { mediator, pageEvents } = makeMediator(MANIFEST);
    getPageCache().set(EXT_ID, "dashboard", VALID_TREE as never);
    getPageCache().set(EXT_ID, "dashboard", VALID_TREE as never, "proj-1");
    mediator.handleNotification(EXT_ID, notification({ pageId: "dashboard" }));
    expect(pageEvents).toHaveLength(1);
    expect(pageEvents[0]!.pageId).toBe("dashboard");
    expect(getPageCache().get(EXT_ID, "dashboard")).toBeNull();
    expect(getPageCache().get(EXT_ID, "dashboard", "proj-1")).toBeNull();
  });

  test("tree-less push still gates on a DECLARED pageId", () => {
    const { mediator, pageEvents } = makeMediator(MANIFEST);
    mediator.handleNotification(EXT_ID, notification({ pageId: "not-declared" }));
    expect(pageEvents).toHaveLength(0);
  });

  test("tree push refreshes the global entry and drops stale project variants", () => {
    const { mediator, pageEvents } = makeMediator(MANIFEST);
    getPageCache().set(EXT_ID, "dashboard", VALID_TREE as never, "proj-1");
    mediator.handleNotification(EXT_ID, notification({ pageId: "dashboard", page: VALID_TREE }));
    expect(pageEvents).toHaveLength(1);
    expect(getPageCache().get(EXT_ID, "dashboard")).not.toBeNull();
    expect(getPageCache().get(EXT_ID, "dashboard", "proj-1")).toBeNull();
  });

  test("perProject page: a TREE push is downgraded to invalidate-only (never cached as the home)", () => {
    const { mediator, pageEvents } = makeMediator({
      ...MANIFEST,
      perProjectPageIds: ["dashboard"],
    });
    getPageCache().set(EXT_ID, "dashboard", VALID_TREE as never, "proj-1");
    mediator.handleNotification(EXT_ID, notification({ pageId: "dashboard", page: VALID_TREE }));
    // Signal still fires so every open view re-pulls its own variant...
    expect(pageEvents).toHaveLength(1);
    // ...but the single-context tree is NOT cached as the global variant,
    // and the stale project variant is dropped.
    expect(getPageCache().get(EXT_ID, "dashboard")).toBeNull();
    expect(getPageCache().get(EXT_ID, "dashboard", "proj-1")).toBeNull();
  });

  test("non-string pageId / missing params dropped", () => {
    const { mediator, pageEvents } = makeMediator(MANIFEST);
    mediator.handleNotification(EXT_ID, notification({ pageId: 42 as never, page: VALID_TREE }));
    mediator.handleNotification(EXT_ID, notification(undefined));
    expect(pageEvents).toHaveLength(0);
  });

  test("size gate: >64KB params dropped before any work", () => {
    const { mediator, pageEvents } = makeMediator(MANIFEST);
    mediator.handleNotification(
      EXT_ID,
      notification({
        pageId: "dashboard",
        page: { title: "T", nodes: [{ type: "markdown", content: "x".repeat(MAX_STATE_SIZE_BYTES) }] },
      }),
    );
    expect(pageEvents).toHaveLength(0);
  });

  test("rate bucket is SHARED with ezcorp/state (10/s total)", () => {
    const { mediator, pageEvents, stateEvents } = makeMediator({
      ...MANIFEST,
      panel: {},
    });
    // 5 panel updates + 5 page pushes = bucket exhausted.
    for (let i = 0; i < 5; i++) {
      mediator.handleNotification(EXT_ID, notification({ state: { i } }, "ezcorp/state"));
      mediator.handleNotification(EXT_ID, notification({ pageId: "dashboard", page: VALID_TREE }));
    }
    // 11th update within the same instant is rate-limited.
    mediator.handleNotification(EXT_ID, notification({ pageId: "dashboard", page: VALID_TREE }));
    expect(stateEvents).toHaveLength(5);
    expect(pageEvents).toHaveLength(5);
  });

  test("eventSubscriptions absent → empty allowlist (action nodes dropped, push still lands)", () => {
    const { mediator, pageEvents } = makeMediator({ name: "cron-dashboard", pageIds: ["dashboard"] });
    mediator.handleNotification(EXT_ID, notification({ pageId: "dashboard", page: VALID_TREE }));
    expect(pageEvents).toHaveLength(1);
    // heading survives; button (action) was dropped.
    expect(getPageCache().get(EXT_ID, "dashboard")!.tree.nodes).toEqual([
      { type: "heading", level: 2, text: "Runs" },
    ]);
  });

  test("ezcorp/state path is unchanged (panel gate, no page side-effects)", () => {
    const { mediator, stateEvents, pageEvents } = makeMediator({
      ...MANIFEST,
      panel: {},
    });
    mediator.handleNotification(EXT_ID, notification({ state: { a: 1 } }, "ezcorp/state"));
    expect(stateEvents).toHaveLength(1);
    expect(pageEvents).toHaveLength(0);
    expect(getPageCache().get(EXT_ID, "dashboard")).toBeNull();
  });

  test("unrelated methods are ignored", () => {
    const { mediator, pageEvents, stateEvents } = makeMediator({ ...MANIFEST, panel: {} });
    mediator.handleNotification(EXT_ID, notification({ pageId: "dashboard", page: VALID_TREE }, "ezcorp/other"));
    expect(pageEvents).toHaveLength(0);
    expect(stateEvents).toHaveLength(0);
  });
});
