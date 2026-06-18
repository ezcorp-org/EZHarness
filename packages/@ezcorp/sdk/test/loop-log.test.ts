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

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  defineLoop,
  dispatchAssignmentUpdate,
  _getRegisteredLoop,
  __resetLoopsForTests,
  _setSettingsResolverForTests,
  _setSpawnForTests,
  _setStoreFactoryForTests,
} from "../src/runtime/loop";
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

beforeEach(() => {
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
