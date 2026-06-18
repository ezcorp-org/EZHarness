// loop-log.test.ts — artifact mirror + dashboard helper.
//
// Exercises Phase 3 of the primitive WITHOUT a live channel by injecting
// the host-mediated fs writers (`_setLogFsForTests`) and the page
// register/push seams (`_setLogPageForTests`). Asserts:
//   - dashboard registration via definePage + pushDashboard wiring
//   - artifact written under .ezcorp/extension-data/<loop>/ on terminal
//   - artifact failure is FAIL-SOFT (run already durable in Storage)
//   - dashboard pushed on a state change
//   - loops with no log block are no-ops

import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import {
  defineLoop,
  dispatchAssignmentUpdate,
  getLoopTools,
  _getRegisteredLoop,
  __resetLoopsForTests,
  _setSettingsResolverForTests,
  _setSpawnForTests,
  _setStoreFactoryForTests,
} from "../src/runtime/loop";
import { Schedule } from "../src/runtime/schedule";
import {
  loopDataDir,
  runTerminalLog,
  wireLog,
  _setLogFsForTests,
  _setLogPageForTests,
} from "../src/runtime/loop-log";
import { createLoopRunStore } from "../src/runtime/loop-store";
import { PageBuilder } from "../src/runtime/page";
import {
  __resetChannelForTests,
  getChannel,
  type HostChannel,
} from "../src/runtime/channel";
import { spyOn } from "bun:test";
import type { StorageScope } from "../src/runtime/storage";
import type { LoopRunState } from "../src/runtime/loop-types";
import type { PageDefinition } from "../src/runtime/page";

function makeKv() {
  const map = new Map<string, unknown>();
  return (_scope: StorageScope) => ({
    async get<T>(key: string) {
      return map.has(key)
        ? { value: map.get(key) as T, exists: true }
        : { value: null, exists: false };
    },
    async set<T>(key: string, value: T) {
      map.set(key, JSON.parse(JSON.stringify(value)));
      return { ok: true as const, sizeBytes: 0 };
    },
    async delete(key: string) {
      return { deleted: map.delete(key) };
    },
    async list() {
      return { keys: [...map.keys()] };
    },
  });
}

interface FsWrites {
  mkdirs: string[];
  writes: { path: string; body: string }[];
}
interface PageRecord {
  defined: PageDefinition[];
  pushes: { pageId: string }[];
}

let fs: FsWrites;
let pages: PageRecord;
let captured: Map<string, (p: unknown) => Promise<unknown> | unknown>;

// Capture cron handlers via a `Schedule.prototype.on` spy — the
// schedule-fire receiver latches process-wide, so a per-test onRequest spy
// can't see it once a sibling file installed it. (Same trick as loop.test.ts.)
const cronHandlers = new Map<string, (ctx: unknown) => Promise<void> | void>();
beforeAll(() => {
  spyOn(Schedule.prototype, "on").mockImplementation(function (
    this: Schedule,
    cron: string,
    handler: (ctx: unknown) => Promise<void> | void,
  ) {
    cronHandlers.set(cron, handler);
  } as Schedule["on"]);
});

beforeEach(() => {
  cronHandlers.clear();
  __resetLoopsForTests();
  __resetChannelForTests();
  captured = new Map();
  const ch: HostChannel = getChannel();
  spyOn(ch, "onRequest").mockImplementation(((m: string, h: (p: unknown) => unknown) => {
    captured.set(m, h);
  }) as HostChannel["onRequest"]);
  _setSettingsResolverForTests(async () => ({}));
  _setStoreFactoryForTests((<O,>(loopId: string, contract: unknown) =>
    createLoopRunStore<O>(loopId, contract as never, makeKv())) as never);

  fs = { mkdirs: [], writes: [] };
  pages = { defined: [], pushes: [] };
  _setLogFsForTests(
    (async (path: string, content: string | Uint8Array) => {
      fs.writes.push({ path, body: String(content) });
      return { bytes: String(content).length, resolvedPath: path };
    }) as never,
    (async (path: string) => {
      fs.mkdirs.push(path);
      return { resolvedPath: path };
    }) as never,
  );
  _setLogPageForTests(
    ((def: PageDefinition) => {
      pages.defined.push(def);
    }) as never,
    ((pageId: string) => {
      pages.pushes.push({ pageId });
    }) as never,
  );
});

afterEach(() => {
  __resetLoopsForTests();
  __resetChannelForTests();
  _setSettingsResolverForTests(null);
  _setSpawnForTests(null);
  _setStoreFactoryForTests(null);
  _setLogFsForTests(null, null);
  _setLogPageForTests(null, null);
});

async function fireEvent(event: string, payload: unknown): Promise<void> {
  const handler = captured.get(`ezcorp/event/${event}`);
  if (!handler) throw new Error(`no handler for ${event}`);
  await handler(payload);
}

// ── loopDataDir ─────────────────────────────────────────────────────

describe("loopDataDir", () => {
  test("resolves under EZCORP_PROJECT_ROOT/.ezcorp/extension-data/<loop>", () => {
    const prev = process.env.EZCORP_PROJECT_ROOT;
    process.env.EZCORP_PROJECT_ROOT = "/proj";
    try {
      expect(loopDataDir("distill")).toBe("/proj/.ezcorp/extension-data/distill");
    } finally {
      if (prev === undefined) delete process.env.EZCORP_PROJECT_ROOT;
      else process.env.EZCORP_PROJECT_ROOT = prev;
    }
  });

  test("falls back to cwd when EZCORP_PROJECT_ROOT is unset", () => {
    const prev = process.env.EZCORP_PROJECT_ROOT;
    delete process.env.EZCORP_PROJECT_ROOT;
    try {
      expect(loopDataDir("x")).toContain("/.ezcorp/extension-data/x");
    } finally {
      if (prev !== undefined) process.env.EZCORP_PROJECT_ROOT = prev;
    }
  });
});

// ── artifact mirror ─────────────────────────────────────────────────

describe("artifact mirror", () => {
  test("terminal outcome writes the artifact (mkdir parent first)", async () => {
    process.env.EZCORP_PROJECT_ROOT = "/proj";
    defineLoop<{ slug: string }, { body: string }>({
      id: "distill",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      act: async () => ({
        kind: "terminal",
        status: "done",
        outcome: { body: "the lesson" },
      }),
      log: {
        artifact: (_run, outcome) => ({
          path: `lessons/note.md`,
          body: outcome.body,
        }),
      },
    });
    await fireEvent("run:complete", { slug: "s" });

    expect(fs.writes).toHaveLength(1);
    expect(fs.writes[0]!.path).toBe("/proj/.ezcorp/extension-data/distill/lessons/note.md");
    expect(fs.writes[0]!.body).toBe("the lesson");
    // Parent dir created before the write.
    expect(fs.mkdirs).toContain("/proj/.ezcorp/extension-data/distill/lessons");
  });

  test("a null artifact writes nothing", async () => {
    defineLoop({
      id: "noart",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
      log: { artifact: () => null },
    });
    await fireEvent("run:complete", {});
    expect(fs.writes).toHaveLength(0);
  });

  test("artifact write failure is FAIL-SOFT (run still persisted)", async () => {
    _setLogFsForTests(
      (async () => {
        throw new Error("disk full");
      }) as never,
      (async (p: string) => ({ resolvedPath: p })) as never,
    );
    defineLoop({
      id: "softfail",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      act: async () => ({ kind: "terminal", status: "done", outcome: { x: 1 } }),
      log: { artifact: () => ({ path: "a.md", body: "b" }) },
    });
    // Must not throw despite the write error.
    await fireEvent("run:complete", {});
    // The durable run still landed.
    const runs = await _getRegisteredLoop("softfail")!.store.list();
    expect(runs).toHaveLength(1);
    expect(runs[0]!.status).toBe("done");
  });

  test("a loop with no log block writes nothing + does not throw", async () => {
    defineLoop({
      id: "nolog",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
    });
    await fireEvent("run:complete", {});
    expect(fs.writes).toHaveLength(0);
  });
});

// ── dashboard ───────────────────────────────────────────────────────

describe("dashboard", () => {
  test("wireLog registers the page + a row action handler", async () => {
    const cancel = async () => {};
    defineLoop({
      id: "dash",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
      log: {
        dashboard: {
          pageId: "board",
          render: (runs) =>
            new PageBuilder("dash").markdownBlock(`${runs.length} runs`),
          rowActions: { "dash:cancel": cancel },
        },
      },
    });
    expect(pages.defined).toHaveLength(1);
    expect(pages.defined[0]!.id).toBe("board");
    expect(pages.defined[0]!.actions?.["dash:cancel"]).toBe(cancel);
  });

  test("a row action's input prompt (with format) survives the render", async () => {
    // The dashboard helper renders the tree verbatim, so an input-collecting
    // row action — built with `action.prompt.format` — reaches the host
    // unchanged (e.g. ez-code's steer message). Proves the primitive does
    // NOT strip the page-prompt `format` field.
    defineLoop({
      id: "steerable",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
      log: {
        dashboard: {
          pageId: "board-steer",
          render: () =>
            new PageBuilder("steerable").table(
              ["Run", "Status"],
              [
                {
                  cells: ["r1", "running"],
                  action: {
                    event: "steerable:steer",
                    payload: { runId: "r1" },
                    prompt: { label: "Steer message", field: "message", format: "text" },
                  },
                },
              ],
            ),
          rowActions: { "steerable:steer": async () => {} },
        },
      },
    });
    const tree = await pages.defined[0]!.render();
    const table = (tree as { nodes: Array<Record<string, unknown>> }).nodes.find(
      (n) => n.type === "table",
    ) as { rows: Array<{ action?: { prompt?: { format?: string } } }> };
    expect(table.rows[0]!.action?.prompt?.format).toBe("text");
  });

  test("dashboard is pushed on a terminal outcome", async () => {
    defineLoop({
      id: "dash2",
      trigger: { kind: "event", event: "run:complete" },
      contract: { states: ["done"] },
      act: async () => ({ kind: "terminal", status: "done", outcome: null }),
      log: {
        dashboard: {
          pageId: "board2",
          render: (runs) => ({ title: "x", nodes: [{ count: runs.length }] }),
        },
      },
    });
    await fireEvent("run:complete", {});
    expect(pages.pushes.map((p) => p.pageId)).toContain("board2");
  });

  test("dashboard is pushed on a deferred dispatch + on its completion", async () => {
    _setSpawnForTests(async () => ({
      subConversationId: "s",
      agentRunId: "RUN-1",
      taskId: "T-1",
      assignmentId: "A-1",
    }));
    defineLoop({
      id: "dash3",
      trigger: { kind: "event", event: "run:complete" },
      contract: {
        states: ["dispatched", "completed"],
        terminal: ["completed"],
      },
      act: async (ctx) => {
        const h = await ctx.spawn({ agentName: "x", task: "t" });
        return {
          kind: "deferred",
          runId: h.agentRunId,
          status: "dispatched",
          awaitEvent: "task:assignment_update",
          assignmentId: h.assignmentId,
          taskId: h.taskId,
        };
      },
      log: {
        dashboard: {
          pageId: "board3",
          render: () => ({ title: "x", nodes: [] }),
        },
      },
    });
    await fireEvent("run:complete", {});
    const afterDispatch = pages.pushes.length;
    expect(afterDispatch).toBeGreaterThanOrEqual(1);

    await dispatchAssignmentUpdate({
      conversationId: "c",
      taskId: "T-1",
      assignment: {
        id: "A-1",
        agentConfigId: "a",
        agentName: "x",
        isTeam: false,
        status: "completed",
        assignedAt: "t",
        agentRunId: "RUN-1",
      },
    });
    expect(pages.pushes.length).toBeGreaterThan(afterDispatch);
  });

  test("render accepts a finished tree (not just a PageBuilder)", async () => {
    const tree = { title: "fixed", nodes: [] };
    const reg = { def: { log: { dashboard: { pageId: "p", render: () => tree } } }, store: { list: async () => [] as LoopRunState[] } } as never;
    wireLog(reg);
    // Invoke the registered render to assert the finished-tree branch.
    const def = pages.defined[0]!;
    const rendered = await def.render();
    expect(rendered).toEqual(tree);
  });
});

// ── PRIVACY by construction (the ez-code two-loop topology) ─────────
//
// ez-code is migrated as TWO loops: a user-scope `dispatch` loop (private
// runs, NO dashboard) + a global-scope `cron` loop (shared runs, WITH a
// dashboard). The Hub tree is cached per-(ext,page) and served to ALL
// users, so a user-dispatched run leaking into the shared dashboard would
// expose one user's runs to everyone — the worst failure in this feature.
// These tests PROVE the leak cannot happen, because:
//   - the user loop declares no `log.dashboard`, so it sets no
//     `pushDashboard` and its render is never asked for;
//   - the two loops use SEPARATE scope-keyed stores, so the global
//     dashboard's `render(runs)` only ever sees the global loop's runs.
describe("PRIVACY — user-scope runs never reach the shared dashboard", () => {
  // Per-scope KV: user and global runs live in physically separate maps,
  // mirroring the host's scope partitioning. The store factory routes on
  // the resolved contract's scope.
  function scopedStoreFactory() {
    const maps: Record<string, Map<string, unknown>> = {
      user: new Map(),
      global: new Map(),
      conversation: new Map(),
    };
    return <O,>(loopId: string, contract: { scope?: StorageScope }) => {
      const scope = contract.scope ?? "global";
      const map = maps[scope]!;
      const kv = (_s: StorageScope) => ({
        async get<T>(key: string) {
          return map.has(key)
            ? { value: map.get(key) as T, exists: true }
            : { value: null, exists: false };
        },
        async set<T>(key: string, value: T) {
          map.set(key, JSON.parse(JSON.stringify(value)));
          return { ok: true as const, sizeBytes: 0 };
        },
        async delete(key: string) {
          return { deleted: map.delete(key) };
        },
        async list() {
          return { keys: [...map.keys()] };
        },
      });
      return createLoopRunStore<O>(loopId, contract as never, kv);
    };
  }

  function defineEzCodeTwoLoops(): void {
    let n = 0;
    _setSpawnForTests(async () => {
      n += 1;
      return {
        subConversationId: `sub-${n}`,
        agentRunId: `run-${n}`,
        taskId: `task-${n}`,
        assignmentId: `asg-${n}`,
      };
    });
    // USER loop — private dispatch runs, NO dashboard.
    defineLoop({
      id: "ez-dispatch",
      trigger: { kind: "manual", tool: "dispatch_run" },
      contract: {
        states: ["dispatched", "running", "completed", "failed", "cancelled"],
        terminal: ["completed", "failed", "cancelled"],
        scope: "user",
      },
      act: async (ctx) => {
        const h = await ctx.spawn({ agentName: "coder", task: "user task" });
        return {
          kind: "deferred",
          runId: h.agentRunId,
          status: "dispatched",
          awaitEvent: "task:assignment_update",
          assignmentId: h.assignmentId,
          taskId: h.taskId,
        };
      },
      // No log.dashboard — private.
    });
    // GLOBAL loop — shared cron runs, WITH the dashboard.
    defineLoop({
      id: "ez-cron",
      trigger: { kind: "cron", cron: "0 * * * *" },
      contract: {
        states: ["dispatched", "running", "completed", "failed", "cancelled"],
        terminal: ["completed", "failed", "cancelled"],
        scope: "global",
      },
      act: async (ctx) => {
        const h = await ctx.spawn({ agentName: "coder", task: "cron task" });
        return {
          kind: "deferred",
          runId: h.agentRunId,
          status: "dispatched",
          awaitEvent: "task:assignment_update",
          assignmentId: h.assignmentId,
          taskId: h.taskId,
        };
      },
      log: {
        dashboard: {
          // render exposes EVERY run it's handed — so if a user run ever
          // reached here, this test would see it. It never does, because
          // the global loop's store only holds global runs.
          pageId: "dashboard",
          render: (runs) => ({
            title: "ez-code",
            nodes: [{ type: "runs", ids: runs.map((r) => r.id) }],
          }),
        },
      },
    });
  }

  test("a user-dispatched run NEVER appears in the rendered global dashboard tree", async () => {
    _setStoreFactoryForTests(scopedStoreFactory() as never);
    defineEzCodeTwoLoops();

    // Fire the USER dispatch tool (private run) — run-1, user scope. Use
    // getLoopTools() (not the channel dispatcher) to dodge the process-wide
    // tools/call dispatcher latch a sibling SDK test file may have disarmed.
    await getLoopTools().dispatch_run!({});

    // Render the GLOBAL dashboard. It must show ZERO runs — the user run
    // lives in a different store the global render never reads.
    const dashDef = pages.defined.find((d) => d.id === "dashboard")!;
    const tree = (await dashDef.render()) as { nodes: Array<{ ids: string[] }> };
    expect(tree.nodes[0]!.ids).toEqual([]);

    // Sanity: the user loop DID persist its run (privacy ≠ data loss).
    const userRuns = await _getRegisteredLoop("ez-dispatch")!.store.list();
    expect(userRuns.map((r) => r.id)).toEqual(["run-1"]);
  });

  test("a task:assignment_update for a USER run does NOT push the shared page", async () => {
    _setStoreFactoryForTests(scopedStoreFactory() as never);
    defineEzCodeTwoLoops();

    await getLoopTools().dispatch_run!({});
    const pushesBefore = pages.pushes.length;

    // The user run completes. The shared dashboard must NOT be pushed —
    // the owning (user) loop has no dashboard, so no push fires.
    await dispatchAssignmentUpdate({
      conversationId: "c",
      taskId: "task-1",
      assignment: {
        id: "asg-1",
        agentConfigId: "a",
        agentName: "coder",
        isTeam: false,
        status: "completed",
        assignedAt: "t",
        agentRunId: "run-1",
      },
    });
    expect(pages.pushes.length).toBe(pushesBefore);
    // The user run still transitioned (privately).
    const userRuns = await _getRegisteredLoop("ez-dispatch")!.store.list();
    expect(userRuns[0]!.status).toBe("completed");
  });

  test("a GLOBAL (cron) run DOES appear in the dashboard + DOES push on completion", async () => {
    _setStoreFactoryForTests(scopedStoreFactory() as never);
    defineEzCodeTwoLoops();

    // Fire the cron (global) loop via the captured Schedule handler.
    const cronHandler = cronHandlers.get("0 * * * *");
    await cronHandler!({
      cron: "0 * * * *",
      scheduledAt: "t",
      firedAt: "t",
      fireId: "f1",
      catchUp: false,
      retry: false,
      attempt: 1,
    });

    const dashDef = pages.defined.find((d) => d.id === "dashboard")!;
    const tree = (await dashDef.render()) as { nodes: Array<{ ids: string[] }> };
    expect(tree.nodes[0]!.ids).toEqual(["run-1"]); // the global run shows

    const pushesBefore = pages.pushes.length;
    await dispatchAssignmentUpdate({
      conversationId: "c",
      taskId: "task-1",
      assignment: {
        id: "asg-1",
        agentConfigId: "a",
        agentName: "coder",
        isTeam: false,
        status: "completed",
        assignedAt: "t",
        agentRunId: "run-1",
      },
    });
    // A global run's completion DOES refresh the shared dashboard.
    expect(pages.pushes.length).toBeGreaterThan(pushesBefore);
  });
});

// ── runTerminalLog direct (no-dashboard, no-artifact no-op) ─────────

describe("runTerminalLog direct", () => {
  test("no log block → no writes, no pushes, no throw", async () => {
    const run: LoopRunState = {
      id: "r",
      loopId: "l",
      scope: "global",
      status: "done",
      events: [],
      createdAt: "t",
      updatedAt: "t",
    };
    const reg = { id: "l", def: {}, store: { list: async () => [] } } as never;
    await runTerminalLog(reg, run, null);
    expect(fs.writes).toHaveLength(0);
    expect(pages.pushes).toHaveLength(0);
  });
});
