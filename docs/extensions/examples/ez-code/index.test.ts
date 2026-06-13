// ez-code — unit tests for the control-plane extension (B1 surface).
//
// Covers: pure helpers (appendRun/mapStatus/applyAssignmentUpdate/
// buildDashboard), the dispatch_run + list_runs tool handlers, the
// task:assignment_update event handler, and register() wiring on the SDK
// test channel. No standalone reverse-RPC harness (several example
// harnesses are known-broken); the page/tool flow uses the SDK
// test-channel pattern + the web Playwright hub spec.
import { afterEach, describe, expect, test } from "bun:test";
import {
  __resetChannelForTests,
  __resetPagesForTests,
  getChannel,
  type HostChannel,
} from "@ezcorp/sdk/runtime";
import {
  MAX_RUNS,
  PAGE_ID,
  _setPushPageForTests,
  _setSpawnForTests,
  _setStoreForTests,
  appendRun,
  applyAssignmentUpdate,
  buildDashboard,
  dispatchRun,
  handleAssignmentUpdate,
  listRuns,
  mapStatus,
  register,
  renderDashboard,
  tools,
  type RunRecord,
  type RunStore,
} from "./index";
import type { ToolCallResult } from "../../../../src/extensions/types";

function record(overrides: Partial<RunRecord> = {}): RunRecord {
  const now = "2026-06-13T08:00:00.000Z";
  return {
    id: "run-1",
    taskId: "task-1",
    assignmentId: "asg-1",
    subConversationId: "sub-1",
    agentName: "coder",
    title: "Fix the bug",
    task: "Fix the failing test",
    status: "dispatched",
    createdAt: now,
    updatedAt: now,
    events: [{ at: now, status: "dispatched" }],
    ...overrides,
  };
}

function memoryStore(initial: RunRecord[] = []): RunStore & { runs: RunRecord[] } {
  const state = { runs: initial };
  return {
    get runs() {
      return state.runs;
    },
    async read() {
      return state.runs;
    },
    async write(next) {
      state.runs = next;
    },
  };
}

function capturePushes(): Array<{ pageId: string; tree: unknown }> {
  const pushes: Array<{ pageId: string; tree: unknown }> = [];
  _setPushPageForTests((pageId, tree) => {
    pushes.push({ pageId, tree });
  });
  return pushes;
}

function parse(result: ToolCallResult): any {
  const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return JSON.parse(text!.text);
}

afterEach(() => {
  _setStoreForTests(null);
  _setPushPageForTests(null);
  _setSpawnForTests(null);
  __resetPagesForTests();
  __resetChannelForTests();
});

describe("appendRun", () => {
  test("prepends newest-first and caps at MAX_RUNS", () => {
    let runs: RunRecord[] = [];
    for (let i = 0; i < MAX_RUNS + 5; i++) {
      runs = appendRun(runs, record({ id: `r${i}` }));
    }
    expect(runs).toHaveLength(MAX_RUNS);
    expect(runs[0]!.id).toBe(`r${MAX_RUNS + 4}`);
  });
});

describe("mapStatus", () => {
  test("maps host assignment statuses; unknown → dispatched", () => {
    expect(mapStatus("running")).toBe("running");
    expect(mapStatus("completed")).toBe("completed");
    expect(mapStatus("failed")).toBe("failed");
    expect(mapStatus("cancelled")).toBe("cancelled");
    expect(mapStatus("assigned")).toBe("dispatched");
    expect(mapStatus("weird")).toBe("dispatched");
  });
});

describe("applyAssignmentUpdate", () => {
  test("matches by agentRunId → flips status + prepends event", () => {
    const before = [record({ id: "run-x", status: "dispatched", events: [] })];
    const after = applyAssignmentUpdate(before, {
      conversationId: "c",
      taskId: "task-x",
      assignment: {
        id: "asg-x",
        agentConfigId: "cfg",
        agentName: "coder",
        isTeam: false,
        status: "running",
        assignedAt: "t",
        agentRunId: "run-x",
      },
    });
    expect(after[0]!.status).toBe("running");
    expect(after[0]!.events[0]!.status).toBe("running");
  });

  test("matches by assignmentId and carries resultPreview as note", () => {
    const before = [record({ id: "run-y", assignmentId: "asg-y", status: "running" })];
    const after = applyAssignmentUpdate(before, {
      conversationId: "c",
      taskId: "task-y",
      assignment: {
        id: "asg-y",
        agentConfigId: "cfg",
        agentName: "coder",
        isTeam: false,
        status: "completed",
        assignedAt: "t",
        resultPreview: "done: 3 files changed",
      },
    });
    expect(after[0]!.status).toBe("completed");
    expect(after[0]!.events[0]!.note).toBe("done: 3 files changed");
  });

  test("non-matching runs pass through unchanged", () => {
    const before = [record({ id: "run-a", taskId: "task-a", assignmentId: "asg-a" })];
    const after = applyAssignmentUpdate(before, {
      conversationId: "c",
      taskId: "other-task",
      assignment: {
        id: "other-asg",
        agentConfigId: "cfg",
        agentName: "x",
        isTeam: false,
        status: "failed",
        assignedAt: "t",
        agentRunId: "other-run",
      },
    });
    expect(after[0]).toEqual(before[0]!);
  });
});

describe("buildDashboard", () => {
  test("empty: stats + empty-state, no table", () => {
    const tree = buildDashboard([]);
    expect(tree.title).toBe("ez-code");
    const types = (tree.nodes as Array<{ type: string }>).map((n) => n.type);
    expect(types).toContain("stats");
    expect(types).toContain("empty-state");
    expect(types).not.toContain("table");
  });

  test("populated: table rows with status badges + stat counts", () => {
    const tree = buildDashboard([
      record({ id: "r1", status: "running" }),
      record({ id: "r2", status: "completed" }),
      record({ id: "r3", status: "failed" }),
    ]);
    const nodes = tree.nodes as Array<Record<string, unknown>>;
    const stats = nodes.find((n) => n.type === "stats") as {
      items: Array<{ label: string; value: string }>;
    };
    expect(stats.items.find((i) => i.label === "Total runs")!.value).toBe("3");
    expect(stats.items.find((i) => i.label === "Active")!.value).toBe("1");
    expect(stats.items.find((i) => i.label === "Completed")!.value).toBe("1");
    expect(stats.items.find((i) => i.label === "Failed")!.value).toBe("1");
    const table = nodes.find((n) => n.type === "table") as {
      columns: string[];
      rows: Array<{ cells: string[]; href?: string }>;
    };
    expect(table.columns).toEqual(["Run", "Agent", "Status", "Updated", "Latest event"]);
    expect(table.rows[0]!.cells[2]).toContain("running");
    // sub-conversation deep-link.
    expect(table.rows[0]!.href).toBe("/chat/sub-1");
  });
});

describe("dispatch_run tool", () => {
  test("spawns, persists a run record, and pushes a fresh dashboard", async () => {
    const store = memoryStore();
    _setStoreForTests(store);
    const pushes = capturePushes();
    _setSpawnForTests(async (input) => {
      expect(input.agentName).toBe("coder");
      expect(input.task).toBe("Fix the failing test");
      return {
        subConversationId: "sub-99",
        agentRunId: "run-99",
        taskId: "task-99",
        assignmentId: "asg-99",
      };
    });

    const result = await dispatchRun({
      agentName: "coder",
      task: "Fix the failing test",
      title: "Bugfix",
    });
    const payload = parse(result);
    expect(payload.runId).toBe("run-99");
    expect(payload.status).toBe("dispatched");

    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.id).toBe("run-99");
    expect(store.runs[0]!.title).toBe("Bugfix");
    expect(store.runs[0]!.status).toBe("dispatched");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.pageId).toBe(PAGE_ID);
  });

  test("forwards autonomousContinuation when true", async () => {
    _setStoreForTests(memoryStore());
    _setPushPageForTests(() => {});
    let seen: unknown = null;
    _setSpawnForTests(async (input) => {
      seen = input.autonomousContinuation;
      return { subConversationId: "s", agentRunId: "r", taskId: "t", assignmentId: "a" };
    });
    await dispatchRun({ agentName: "coder", task: "go", autonomousContinuation: true });
    expect(seen).toEqual({});
  });

  test("validates agentName and task", async () => {
    const r1 = await dispatchRun({ task: "x" });
    expect(r1.isError).toBe(true);
    const r2 = await dispatchRun({ agentName: "coder" });
    expect(r2.isError).toBe(true);
  });

  test("surfaces a spawn failure as a tool error", async () => {
    _setStoreForTests(memoryStore());
    _setSpawnForTests(async () => {
      throw new Error("quota exceeded");
    });
    const r = await dispatchRun({ agentName: "coder", task: "go" });
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("quota exceeded");
  });
});

describe("list_runs tool", () => {
  test("returns persisted runs (newest first), respects limit", async () => {
    _setStoreForTests(
      memoryStore([
        record({ id: "r1", title: "one" }),
        record({ id: "r2", title: "two" }),
        record({ id: "r3", title: "three" }),
      ]),
    );
    const all = parse(await listRuns({}));
    expect(all.runs.map((r: any) => r.id)).toEqual(["r1", "r2", "r3"]);
    const limited = parse(await listRuns({ limit: 2 }));
    expect(limited.runs).toHaveLength(2);
    expect(limited.runs[0]!.latestEvent.status).toBe("dispatched");
  });
});

describe("handleAssignmentUpdate", () => {
  test("updates the matching run + pushes the fresh tree", async () => {
    const store = memoryStore([record({ id: "run-7", status: "dispatched" })]);
    _setStoreForTests(store);
    const pushes = capturePushes();

    await handleAssignmentUpdate({
      conversationId: "c",
      taskId: "task-1",
      assignment: {
        id: "asg-1",
        agentConfigId: "cfg",
        agentName: "coder",
        isTeam: false,
        status: "completed",
        assignedAt: "t",
        agentRunId: "run-7",
      },
    });

    expect(store.runs[0]!.status).toBe("completed");
    expect(pushes).toHaveLength(1);
    const tree = pushes[0]!.tree as { nodes: Array<{ type: string }> };
    expect(tree.nodes.some((n) => n.type === "table")).toBe(true);
  });
});

describe("tools registry", () => {
  test("exposes dispatch_run + list_runs", () => {
    expect(Object.keys(tools).sort()).toEqual(["dispatch_run", "list_runs"]);
  });
});

describe("register", () => {
  test("wires page render + the assignment_update event handler", async () => {
    type Handler = (params: unknown) => Promise<unknown> | unknown;
    const handlers = new Map<string, Handler>();
    const ch: HostChannel = getChannel();
    const originalOnRequest = ch.onRequest.bind(ch);
    ch.onRequest = (method: string, handler: Handler) => {
      handlers.set(method, handler);
      originalOnRequest(method, handler);
    };

    _setStoreForTests(memoryStore([record()]));
    register();

    const keys = [...handlers.keys()];
    expect(keys).toContain("ezcorp/page.render");
    expect(keys).toContain("ezcorp/event/task:assignment_update");

    const rendered = (await handlers.get("ezcorp/page.render")!({ pageId: PAGE_ID })) as {
      title: string;
    };
    expect(rendered.title).toBe("ez-code");
  });
});

describe("renderDashboard (production store round-trip)", () => {
  test("reads through SDK Storage when no store injected", async () => {
    let saved: unknown = null;
    const ch = getChannel();
    const originalRequest = ch.request.bind(ch);
    ch.request = (async (method: string, params: unknown) => {
      const p = params as Record<string, unknown>;
      if (method === "ezcorp/storage") {
        if (p.action === "set") {
          saved = p.value;
          return { ok: true };
        }
        return { value: saved, exists: saved !== null };
      }
      if (method === "ezcorp/spawn-assignment") {
        return {
          v: 1,
          subConversationId: "s",
          agentRunId: "r",
          taskId: "t",
          assignmentId: "a",
        };
      }
      return originalRequest(method, params as never);
    }) as HostChannel["request"];

    _setStoreForTests(null); // force the production Storage-backed store
    _setPushPageForTests(() => {});

    const before = await renderDashboard();
    const statsBefore = (before.nodes as Array<Record<string, unknown>>).find(
      (n) => n.type === "stats",
    ) as { items: Array<{ value: string }> };
    expect(statsBefore.items[0]!.value).toBe("0");

    await dispatchRun({ agentName: "coder", task: "go" });
    expect(Array.isArray(saved)).toBe(true);
    expect((saved as RunRecord[])[0]!.agentName).toBe("coder");

    const after = await renderDashboard();
    const statsAfter = (after.nodes as Array<Record<string, unknown>>).find(
      (n) => n.type === "stats",
    ) as { items: Array<{ value: string }> };
    expect(statsAfter.items[0]!.value).toBe("1");
  });
});
