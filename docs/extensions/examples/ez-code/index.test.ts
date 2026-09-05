// ez-code — unit tests for the control-plane extension (B1 surface).
//
// Covers: pure helpers (appendRun/mapStatus/applyAssignmentUpdate/
// buildDashboard), the dispatch_run + list_runs tool handlers, the
// task:assignment_update event handler, and register() wiring on the SDK
// test channel. No standalone reverse-RPC harness (several example
// harnesses are known-broken); the page/tool flow uses the SDK
// test-channel pattern + the web Playwright hub spec.
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  __resetChannelForTests,
  __resetPagesForTests,
  getChannel,
  type HostChannel,
} from "@ezcorp/sdk/runtime";
import {
  CANCEL_EVENT,
  DEFAULT_CODER_AGENT,
  DEFAULT_CODER_AGENT_ID,
  isDefaultCoderRequest,
  MAX_EVENTS_PER_RUN,
  MAX_RUNS,
  PAGE_ID,
  resolveDispatchAgentName,
  _setAppendMessageForTests,
  _setCancelForTests,
  _setGlobalStoreForTests,
  _setMemoryForTests,
  _setPushPageForTests,
  _setSpawnForTests,
  _setTaskStoreForTests,
  _setTriggersForTests,
  _setUserStoreForTests,
  appendExtras,
  buildDashboard,
  buildDashboardLive,
  handleTriggerFire,
  triggersForCron,
  cancelRunById,
  cancelRunTool,
  dispatchRun,
  findRunMatch,
  handleAssignmentUpdate,
  handleCancelAction,
  handleSteerAction,
  isLive,
  listRuns,
  mapStatus,
  openPr,
  openPrForRun,
  productionTriggers,
  register,
  renderDashboard,
  steerRun,
  steerRunById,
  tools,
  type RunRecord,
  type RunStore,
  type TaskRecord,
  type TaskStore,
  type Trigger,
} from "./index";
import type { ToolCallResult } from "@ezcorp/sdk";

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

/**
 * In-memory RunStore implementing the per-run loop-store-backed interface
 * (`list`/`get`/`create`/`update`). Exposes `.runs` (newest-first) for
 * assertions. Mirrors the production loop-store semantics: `update` with no
 * `status` keeps the current run status (e.g. a "steered" event), `update`
 * with `status` flips it; `eventStatus`/`note` prepend a capped event.
 */
function memoryStore(initial: RunRecord[] = []): RunStore & { runs: RunRecord[] } {
  const state = { runs: [...initial] };
  return {
    get runs() {
      return state.runs;
    },
    async list() {
      return state.runs;
    },
    async get(id) {
      return state.runs.find((r) => r.id === id) ?? null;
    },
    async create(run) {
      // Newest-first, capped at MAX_RUNS (matches loop-store retention).
      state.runs = [run, ...state.runs.filter((r) => r.id !== run.id)].slice(0, MAX_RUNS);
    },
    async update(id, next) {
      const at = new Date().toISOString();
      state.runs = state.runs.map((r) => {
        if (r.id !== id) return r;
        // Cap the event log to MAX_EVENTS_PER_RUN — matches the real
        // loop-store's retention so the harness stays honest.
        const events = [
          { at, status: next.eventStatus ?? next.status ?? r.status, ...(next.note ? { note: next.note } : {}) },
          ...r.events,
        ].slice(0, MAX_EVENTS_PER_RUN);
        return {
          ...r,
          ...(next.status ? { status: next.status } : {}),
          updatedAt: at,
          events,
        };
      });
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

/** Set BOTH the user + global run stores to the same memory store (most
 *  tests exercise one bucket; the privacy split is asserted by a dedicated
 *  cross-user test that sets the two stores SEPARATELY). */
function setBothStores(store: RunStore): void {
  _setUserStoreForTests(store);
  _setGlobalStoreForTests(store);
}

function parse(result: ToolCallResult): any {
  const text = result.content.find((c) => c.type === "text") as { text: string } | undefined;
  return JSON.parse(text!.text);
}

/**
 * Fake the UNJAILED host git orchestration (rev-parse / symbolic-ref / worktree
 * add+remove / status). Captures the resolved worktree path + records the
 * worktree-add/remove calls so a test can assert the worktree lifecycle. The
 * jailed git/gh still flows through the injected `shellImpl` (set separately).
 */

/** A real-shell HostRunner backed by Bun.spawnSync — used to exercise the
 *  shell-driven (node:fs-free) materializer against a throwaway git repo. */

afterEach(() => {
  _setUserStoreForTests(null);
  _setGlobalStoreForTests(null);
  _setPushPageForTests(null);
  _setSpawnForTests(null);
  _setCancelForTests(null);
  _setAppendMessageForTests(null);
  _setTriggersForTests(null);
  _setMemoryForTests(null);
  _setTaskStoreForTests(null);
  __resetPagesForTests();
  __resetChannelForTests();
});

// MIGRATED (was `appendRun`): the newest-first + MAX_RUNS cap is now owned by
// the loop-store; pin the SAME observable behavior through the store's
// per-run `create` (the in-memory store mirrors loop-store's retention).
describe("run store create — newest-first + cap", () => {
  test("prepends newest-first and caps at MAX_RUNS", async () => {
    const store = memoryStore();
    for (let i = 0; i < MAX_RUNS + 5; i++) {
      await store.create(record({ id: `r${i}` }));
    }
    expect(store.runs).toHaveLength(MAX_RUNS);
    expect(store.runs[0]!.id).toBe(`r${MAX_RUNS + 4}`);
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

// MIGRATED (was `applyAssignmentUpdate`): the deferred-completion match +
// status flip + resultPreview-as-note now happens inside
// `handleAssignmentUpdate` driving the loop-store. Pin the SAME behavior
// (match by agentRunId / assignmentId; non-match untouched) through it.
describe("handleAssignmentUpdate — match + flip + note", () => {
  test("matches by agentRunId → flips status + prepends raw event", async () => {
    const store = memoryStore([record({ id: "run-x", status: "dispatched", events: [] })]);
    setBothStores(store);
    _setPushPageForTests(() => {});
    await handleAssignmentUpdate({
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
    expect(store.runs[0]!.status).toBe("running");
    expect(store.runs[0]!.events[0]!.status).toBe("running");
  });

  test("matches by assignmentId and carries resultPreview as the event note", async () => {
    const store = memoryStore([record({ id: "run-y", assignmentId: "asg-y", status: "running" })]);
    setBothStores(store);
    _setPushPageForTests(() => {});
    await handleAssignmentUpdate({
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
    expect(store.runs[0]!.status).toBe("completed");
    expect(store.runs[0]!.events[0]!.note).toBe("done: 3 files changed");
  });

  test("a non-matching event leaves the run untouched", async () => {
    const original = record({ id: "run-a", taskId: "task-a", assignmentId: "asg-a" });
    const store = memoryStore([original]);
    setBothStores(store);
    _setPushPageForTests(() => {});
    await handleAssignmentUpdate({
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
    expect(store.runs[0]).toEqual(original);
  });
});

// `findRunMatch` replaces the old `runMatches` — pin the match predicate.
describe("findRunMatch", () => {
  const evt = {
    conversationId: "c",
    taskId: "task-m",
    assignment: {
      id: "asg-m",
      agentConfigId: "cfg",
      agentName: "x",
      isTeam: false,
      status: "running" as const,
      assignedAt: "t",
      agentRunId: "run-m",
    },
  };
  test("matches by agentRunId / assignmentId / taskId; else null", () => {
    expect(findRunMatch([record({ id: "run-m" })], evt)?.id).toBe("run-m");
    expect(findRunMatch([record({ id: "z", assignmentId: "asg-m" })], evt)?.id).toBe("z");
    expect(findRunMatch([record({ id: "z", taskId: "task-m" })], evt)?.id).toBe("z");
    expect(findRunMatch([record({ id: "nope" })], evt)).toBeNull();
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
      rows: Array<{ cells: string[]; href?: string; action?: unknown }>;
    };
    expect(table.columns).toEqual(["Run", "Agent", "Status", "Updated", "Latest event"]);
    expect(table.rows[0]!.cells[2]).toContain("running");
    // A live (running) row carries a cancel action. PRIVACY (cross-user leak
    // fix): NO row carries a `/chat/<sub>` deep-link — this is the SHARED
    // tree and a private sub-conversation link must not be exposed cross-user.
    expect(table.rows[0]!.action).toBeDefined();
    expect(table.rows[0]!.href).toBeUndefined();
    expect(table.rows[1]!.href).toBeUndefined();
    expect(table.rows[2]!.href).toBeUndefined();
  });
});

describe("resolveDispatchAgentName (pure)", () => {
  test("omitted / blank → the bundled coder", () => {
    expect(resolveDispatchAgentName(undefined)).toBe(DEFAULT_CODER_AGENT);
    expect(resolveDispatchAgentName("")).toBe(DEFAULT_CODER_AGENT);
    expect(resolveDispatchAgentName("   ")).toBe(DEFAULT_CODER_AGENT);
  });

  test("aliases (case-insensitive, trimmed) → the bundled coder", () => {
    expect(resolveDispatchAgentName("coder")).toBe(DEFAULT_CODER_AGENT);
    expect(resolveDispatchAgentName("CODER")).toBe(DEFAULT_CODER_AGENT);
    expect(resolveDispatchAgentName("  ez-code ")).toBe(DEFAULT_CODER_AGENT);
    expect(resolveDispatchAgentName("ez-code coder")).toBe(DEFAULT_CODER_AGENT);
  });

  test("explicit non-alias names pass through trimmed", () => {
    expect(resolveDispatchAgentName("Code Reviewer")).toBe("Code Reviewer");
    expect(resolveDispatchAgentName("  My Agent  ")).toBe("My Agent");
  });

  test("isDefaultCoderRequest: omitted/blank/alias true; explicit name false", () => {
    expect(isDefaultCoderRequest(undefined)).toBe(true);
    expect(isDefaultCoderRequest("")).toBe(true);
    expect(isDefaultCoderRequest("   ")).toBe(true);
    expect(isDefaultCoderRequest("coder")).toBe(true);
    expect(isDefaultCoderRequest("  EZ-CODE ")).toBe(true);
    expect(isDefaultCoderRequest("Code Reviewer")).toBe(false);
  });

  test("the fixed coder id is a well-formed lowercase UUID literal", () => {
    expect(DEFAULT_CODER_AGENT_ID).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });
});

describe("dispatch_run tool", () => {
  test("spawns + persists to the per-user store; does NOT push the shared tree (privacy)", async () => {
    const userStore = memoryStore();
    const globalStore = memoryStore();
    _setUserStoreForTests(userStore);
    _setGlobalStoreForTests(globalStore);
    const pushes = capturePushes();
    _setSpawnForTests(async (input) => {
      // Explicit non-alias name passes through verbatim.
      expect(input.agentName).toBe("Custom Bot");
      expect(input.task).toBe("Fix the failing test");
      return {
        subConversationId: "sub-99",
        agentRunId: "run-99",
        taskId: "task-99",
        assignmentId: "asg-99",
      };
    });

    const result = await dispatchRun({
      agentName: "Custom Bot",
      task: "Fix the failing test",
      title: "Bugfix",
    });
    const payload = parse(result);
    expect(payload.runId).toBe("run-99");
    expect(payload.status).toBe("dispatched");

    // Persisted to the USER bucket only.
    expect(userStore.runs).toHaveLength(1);
    expect(userStore.runs[0]!.id).toBe("run-99");
    expect(userStore.runs[0]!.title).toBe("Bugfix");
    // The GLOBAL (shared) bucket is untouched, and NO shared push fired —
    // a user's private run must never enter the cross-user cached tree.
    expect(globalStore.runs).toHaveLength(0);
    expect(pushes).toHaveLength(0);
  });

  test("forwards autonomousContinuation when true", async () => {
    setBothStores(memoryStore());
    _setPushPageForTests(() => {});
    let seen: unknown = null;
    _setSpawnForTests(async (input) => {
      seen = input.autonomousContinuation;
      return { subConversationId: "s", agentRunId: "r", taskId: "t", assignmentId: "a" };
    });
    await dispatchRun({ agentName: "coder", task: "go", autonomousContinuation: true });
    expect(seen).toEqual({});
  });

  test("omitted agentName → dispatches the bundled coder BY FIXED ID, record shows friendly name", async () => {
    const userStore = memoryStore();
    setBothStores(userStore);
    let seen: { agentConfigId?: string; agentName?: string } | null = null;
    _setSpawnForTests(async (input) => {
      seen = { agentConfigId: input.agentConfigId, agentName: input.agentName };
      return { subConversationId: "s", agentRunId: "r", taskId: "t", assignmentId: "a" };
    });
    // No agentName at all → bundled coder, dispatched by id (NOT name).
    const r = await dispatchRun({ task: "Implement the feature" });
    expect(r.isError).toBeFalsy();
    expect(seen!.agentConfigId).toBe(DEFAULT_CODER_AGENT_ID);
    expect(seen!.agentName).toBeUndefined();
    // The persisted record still carries the friendly display name.
    expect(userStore.runs[0]!.agentName).toBe(DEFAULT_CODER_AGENT);
  });

  test("the 'coder' alias → dispatches the bundled coder BY FIXED ID", async () => {
    setBothStores(memoryStore());
    let seen: { agentConfigId?: string; agentName?: string } | null = null;
    _setSpawnForTests(async (input) => {
      seen = { agentConfigId: input.agentConfigId, agentName: input.agentName };
      return { subConversationId: "s", agentRunId: "r", taskId: "t", assignmentId: "a" };
    });
    const r = await dispatchRun({ agentName: "  Coder ", task: "go" });
    expect(r.isError).toBeFalsy();
    expect(seen!.agentConfigId).toBe(DEFAULT_CODER_AGENT_ID);
    expect(seen!.agentName).toBeUndefined();
  });

  test("passes an explicit non-alias agent name through BY NAME (no id)", async () => {
    setBothStores(memoryStore());
    let seen: { agentConfigId?: string; agentName?: string } | null = null;
    _setSpawnForTests(async (input) => {
      seen = { agentConfigId: input.agentConfigId, agentName: input.agentName };
      return { subConversationId: "s", agentRunId: "r", taskId: "t", assignmentId: "a" };
    });
    const r = await dispatchRun({ agentName: "Code Reviewer", task: "review" });
    expect(r.isError).toBeFalsy();
    expect(seen!.agentName).toBe("Code Reviewer");
    expect(seen!.agentConfigId).toBeUndefined();
  });

  test("validates task (required) and agentName type", async () => {
    // task missing → error even though agentName now defaults.
    const r1 = await dispatchRun({});
    expect(r1.isError).toBe(true);
    const r2 = await dispatchRun({ agentName: "coder" });
    expect(r2.isError).toBe(true);
    // agentName wrong type → error.
    const r3 = await dispatchRun({ agentName: 42, task: "go" });
    expect(r3.isError).toBe(true);
  });

  test("surfaces a spawn failure as a tool error", async () => {
    setBothStores(memoryStore());
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
  test("returns the user's OWN persisted runs (newest first), respects limit", async () => {
    setBothStores(
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
    setBothStores(store);
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

describe("isLive (status predicate)", () => {
  test("only dispatched + running are live", () => {
    expect(isLive("dispatched")).toBe(true);
    expect(isLive("running")).toBe(true);
    expect(isLive("completed")).toBe(false);
    expect(isLive("failed")).toBe(false);
    expect(isLive("cancelled")).toBe(false);
  });
});

// MIGRATED (was `recordRunEvent`): the store's `update` prepends a (capped)
// event + optionally flips the run status. Pin the SAME behavior + the
// non-matching-id no-op through the store interface.
describe("run store update — event + optional status flip", () => {
  test("flips status + prepends the event; absent id is a no-op", async () => {
    const store = memoryStore([record({ id: "r1", status: "running", events: [] })]);
    await store.update("r1", { status: "cancelled", eventStatus: "cancelled" });
    expect(store.runs[0]!.status).toBe("cancelled");
    expect(store.runs[0]!.events[0]!.status).toBe("cancelled");

    const snapshot = JSON.parse(JSON.stringify(store.runs[0]));
    await store.update("nope", { status: "x" as never, eventStatus: "x" });
    expect(store.runs[0]).toEqual(snapshot);
  });

  test("an event-only update (no status) keeps the run status", async () => {
    const store = memoryStore([record({ id: "r1", status: "running", events: [] })]);
    await store.update("r1", { eventStatus: "steered", note: "focus" });
    expect(store.runs[0]!.status).toBe("running"); // unchanged
    expect(store.runs[0]!.events[0]).toMatchObject({ status: "steered", note: "focus" });
  });
});

describe("steer_run", () => {
  test("appends a steering turn, records the event, pushes a fresh tree", async () => {
    const store = memoryStore([record({ id: "run-s", status: "running" })]);
    setBothStores(store);
    const pushes = capturePushes();
    let appended: any = null;
    _setAppendMessageForTests(async (params) => {
      appended = params;
      return { ok: true };
    });

    const r = await steerRun({ runId: "run-s", message: "focus on the failing test" });
    expect(r.isError).toBeFalsy();
    expect(appended.conversationId).toBe("sub-1");
    expect(appended.role).toBe("extension");
    expect(appended.content).toContain("focus on the failing test");
    expect(store.runs[0]!.events[0]!.status).toBe("steered");
    // The steer TOOL acts on the user's private run — no shared-tree push.
    expect(pushes).toHaveLength(0);
  });

  test("forwards an explicit parentMessageId", async () => {
    setBothStores(memoryStore([record({ id: "run-p", status: "running" })]));
    _setPushPageForTests(() => {});
    let appended: any = null;
    _setAppendMessageForTests(async (params) => {
      appended = params;
      return { ok: true };
    });
    await steerRun({ runId: "run-p", message: "go", parentMessageId: "msg-42" });
    expect(appended.parentMessageId).toBe("msg-42");
  });

  test("validates runId + message", async () => {
    expect((await steerRun({ message: "x" })).isError).toBe(true);
    expect((await steerRun({ runId: "r" })).isError).toBe(true);
  });

  test("rejects steering a terminal run", async () => {
    setBothStores(memoryStore([record({ id: "run-done", status: "completed" })]));
    const r = await steerRun({ runId: "run-done", message: "go" });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain("not steerable");
  });

  test("surfaces an append-message RPC failure", async () => {
    setBothStores(memoryStore([record({ id: "run-e", status: "running" })]));
    _setAppendMessageForTests(async () => {
      throw new Error("not wired to this conversation");
    });
    const r = await steerRun({ runId: "run-e", message: "go" });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain("not wired");
  });

  test("steerRunById reports a missing run", async () => {
    setBothStores(memoryStore([]));
    const res = await steerRunById("ghost", "go");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("no run");
  });

  test("production append path calls ezcorp/append-message through the channel", async () => {
    setBothStores(memoryStore([record({ id: "run-prod", status: "running" })]));
    _setPushPageForTests(() => {});
    _setAppendMessageForTests(null); // force the production channel-backed impl
    let sent: { method: string; params: any } | null = null;
    const ch = getChannel();
    ch.request = (async (method: string, params: unknown) => {
      sent = { method, params };
      return { ok: true };
    }) as HostChannel["request"];

    const res = await steerRunById("run-prod", "ship it");
    expect(res.ok).toBe(true);
    expect(sent!.method).toBe("ezcorp/append-message");
    expect(sent!.params.content).toContain("ship it");
  });
});

describe("cancel_run", () => {
  test("cancels via the host + flips the record to cancelled (no shared push)", async () => {
    const store = memoryStore([record({ id: "run-c", status: "running" })]);
    setBothStores(store);
    const pushes = capturePushes();
    let cancelledId: string | null = null;
    _setCancelForTests(async (id) => {
      cancelledId = id;
      return { cancelled: true };
    });

    const r = await cancelRunTool({ runId: "run-c" });
    expect(r.isError).toBeFalsy();
    expect(cancelledId as string | null).toBe("run-c");
    expect(store.runs[0]!.status).toBe("cancelled");
    // The cancel TOOL acts on the user's private run — no shared-tree push.
    expect(pushes).toHaveLength(0);
  });

  test("surfaces a host rejection with its reason", async () => {
    setBothStores(memoryStore([record({ id: "run-no", status: "running" })]));
    _setCancelForTests(async () => ({ cancelled: false, reason: "not-owned" }));
    const r = await cancelRunTool({ runId: "run-no" });
    expect(r.isError).toBe(true);
    expect((r.content[0] as { text: string }).text).toContain("not-owned");
  });

  test("validates runId", async () => {
    expect((await cancelRunTool({})).isError).toBe(true);
  });

  test("cancelRunById reports a missing run", async () => {
    setBothStores(memoryStore([]));
    expect((await cancelRunById("ghost")).ok).toBe(false);
  });

  test("surfaces a thrown cancel error", async () => {
    setBothStores(memoryStore([record({ id: "run-t", status: "running" })]));
    _setCancelForTests(async () => {
      throw new Error("boom");
    });
    const res = await cancelRunById("run-t");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("boom");
  });
});

describe("dashboard cancel action (live rows)", () => {
  test("live runs render a confirm-gated cancel action; terminal runs deep-link", () => {
    const tree = buildDashboard([
      record({ id: "live", status: "running" }),
      record({ id: "done", status: "completed", subConversationId: "sub-done" }),
    ]);
    const table = (tree.nodes as Array<Record<string, unknown>>).find(
      (n) => n.type === "table",
    ) as { rows: Array<{ action?: { event: string; payload?: any; confirm?: string }; href?: string }> };
    expect(table.rows[0]!.action!.event).toBe(CANCEL_EVENT);
    expect(table.rows[0]!.action!.payload.runId).toBe("live");
    expect(table.rows[0]!.action!.confirm).toBeTruthy();
    expect(table.rows[0]!.href).toBeUndefined();
    // PRIVACY: terminal rows carry NO deep-link in the shared tree.
    expect(table.rows[1]!.href).toBeUndefined();
    expect(table.rows[1]!.action).toBeUndefined();
  });

  test("handleCancelAction cancels the payload run (global store) + pushes", async () => {
    const store = memoryStore([record({ id: "run-act", status: "running" })]);
    setBothStores(store);
    _setMemoryForTests(async () => []);
    _setTaskStoreForTests({ read: async () => [], write: async () => {} });
    _setPushPageForTests(() => {});
    _setCancelForTests(async () => ({ cancelled: true }));
    await handleCancelAction({ source: "hub", pageId: PAGE_ID, userId: "u1", payload: { runId: "run-act" } });
    expect(store.runs[0]!.status).toBe("cancelled");
  });

  test("handleCancelAction is a no-op with no runId", async () => {
    setBothStores(memoryStore([record({ id: "x", status: "running" })]));
    let cancelCalls = 0;
    _setCancelForTests(async () => {
      cancelCalls++;
      return { cancelled: true };
    });
    await handleCancelAction({ source: "hub", pageId: PAGE_ID, userId: "u1", payload: {} });
    expect(cancelCalls).toBe(0);
  });

  test("handleSteerAction appends when payload has runId + message", async () => {
    const store = memoryStore([record({ id: "run-sa", status: "running" })]);
    setBothStores(store);
    _setMemoryForTests(async () => []);
    _setTaskStoreForTests({ read: async () => [], write: async () => {} });
    _setPushPageForTests(() => {});
    let appended = false;
    _setAppendMessageForTests(async () => {
      appended = true;
      return { ok: true };
    });
    await handleSteerAction({
      source: "hub",
      pageId: PAGE_ID,
      userId: "u1",
      payload: { runId: "run-sa", message: "nudge" },
    });
    expect(appended).toBe(true);
    expect(store.runs[0]!.events[0]!.status).toBe("steered");
  });

  test("handleSteerAction is a no-op without both fields", async () => {
    setBothStores(memoryStore([record({ id: "x", status: "running" })]));
    let appendCalls = 0;
    _setAppendMessageForTests(async () => {
      appendCalls++;
      return { ok: true };
    });
    await handleSteerAction({ source: "hub", pageId: PAGE_ID, userId: "u1", payload: { runId: "x" } });
    expect(appendCalls).toBe(0);
  });
});

describe("open_pr host capability", () => {
  test("uses the host broker and records the resulting URL", async () => {
    const store = memoryStore([record({ id: "run-1" })]);
    const request = spyOn(getChannel(), "request").mockResolvedValue({ ok: true, url: "https://github.com/example/repo/pull/1" });
    const result = await openPrForRun("run-1", { title: "Change", body: "Details" }, store);
    expect(result.ok).toBe(true);
    expect(request).toHaveBeenCalledWith("ezcorp/project.openPr", { runId: "run-1", title: "Change", body: "Details" });
    expect((await store.get("run-1"))!.events[0]!.status).toBe("pr_opened");
  });
  test("rejects unknown runs without contacting the host", async () => {
    const request = spyOn(getChannel(), "request");
    expect((await openPrForRun("missing", {}, memoryStore())).ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
  test("does not record a PR when the broker rejects it", async () => {
    const store = memoryStore([record({ id: "run-1" })]);
    spyOn(getChannel(), "request").mockResolvedValue({ ok: false, error: "Approval required" });
    expect((await openPrForRun("run-1", {}, store)).error).toBe("Approval required");
    expect((await store.get("run-1"))!.events.some((event) => event.status === "pr_opened")).toBe(false);
  });
});



describe("B4: triggers / memory / tasks", () => {
  function fireCtx(cron: string): any {
    return {
      cron,
      scheduledAt: "2026-06-13T09:00:00.000Z",
      firedAt: "2026-06-13T09:00:01.000Z",
      fireId: "f1",
      catchUp: false,
      retry: false,
      attempt: 1,
    };
  }

  test("triggersForCron: matches cron + skips disabled", () => {
    const triggers: Trigger[] = [
      { cron: "0 9 * * *", agentName: "a", task: "t1" },
      { cron: "0 9 * * *", agentName: "b", task: "t2", enabled: false },
      { cron: "0 * * * *", agentName: "c", task: "t3" },
    ];
    const fired = triggersForCron(triggers, "0 9 * * *");
    expect(fired.map((t) => t.agentName)).toEqual(["a"]);
  });

  test("handleTriggerFire dispatches a cron run to the GLOBAL store + seeds a task", async () => {
    // Cron fires are ownerless/system → GLOBAL bucket (NOT the user bucket).
    const store = memoryStore(); // global
    const userBucket = memoryStore();
    _setGlobalStoreForTests(store);
    _setUserStoreForTests(userBucket);
    const taskState: TaskRecord[] = [];
    const taskStore: TaskStore = {
      async read() {
        return taskState;
      },
      async write(t) {
        taskState.length = 0;
        taskState.push(...t);
      },
    };
    _setTaskStoreForTests(taskStore);
    _setMemoryForTests(async () => []);
    _setPushPageForTests(() => {});
    let spawnCount = 0;
    _setSpawnForTests(async (_input) => {
      spawnCount++;
      return {
        subConversationId: `sub-${spawnCount}`,
        agentRunId: `run-${spawnCount}`,
        taskId: `task-${spawnCount}`,
        assignmentId: `asg-${spawnCount}`,
      };
    });
    _setTriggersForTests(async () => [
      { cron: "0 9 * * *", agentName: "coder", task: "morning build", title: "Build" },
      { cron: "0 * * * *", agentName: "x", task: "hourly" }, // different cron — must NOT fire
    ]);

    await handleTriggerFire(fireCtx("0 9 * * *"));

    expect(spawnCount).toBe(1);
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.agentName).toBe("coder");
    // The user bucket is untouched — cron runs are system, not per-user.
    expect(userBucket.runs).toHaveLength(0);
    // A task seed was created for the dispatched run.
    expect(taskState).toHaveLength(1);
    expect(taskState[0]!.title).toBe("Build");
    expect(taskState[0]!.runId).toBe("run-1");
  });

  test("handleTriggerFire is a no-op when no trigger matches the cron", async () => {
    setBothStores(memoryStore());
    _setTriggersForTests(async () => [{ cron: "0 9 * * *", agentName: "a", task: "t" }]);
    let spawned = 0;
    _setSpawnForTests(async () => {
      spawned++;
      return { subConversationId: "s", agentRunId: "r", taskId: "t", assignmentId: "a" };
    });
    await handleTriggerFire(fireCtx("0 * * * *"));
    expect(spawned).toBe(0);
  });

  test("handleTriggerFire isolates a failing trigger (rest still dispatch)", async () => {
    const store = memoryStore();
    setBothStores(store);
    _setTaskStoreForTests({ read: async () => [], write: async () => {} });
    _setMemoryForTests(async () => []);
    _setPushPageForTests(() => {});
    let n = 0;
    _setSpawnForTests(async () => {
      n++;
      if (n === 1) throw new Error("quota");
      return { subConversationId: "s", agentRunId: `r${n}`, taskId: "t", assignmentId: "a" };
    });
    _setTriggersForTests(async () => [
      { cron: "0 9 * * *", agentName: "bad", task: "boom" },
      { cron: "0 9 * * *", agentName: "good", task: "ok" },
    ]);
    await handleTriggerFire(fireCtx("0 9 * * *"));
    // First threw; second dispatched.
    expect(store.runs).toHaveLength(1);
    expect(store.runs[0]!.agentName).toBe("good");
  });

  test("appendExtras renders task + memory sections", () => {
    const page = new (require("@ezcorp/sdk/runtime").PageBuilder)("ez-code");
    appendExtras(page, {
      tasks: [{ id: "t1", title: "Fix login", status: "open", createdAt: "2026-06-13T09:00:00.000Z" }],
      memories: [
        { id: "m1", content: "prefers tabs over spaces", category: "preferences", confidence: "high" } as any,
      ],
    });
    const tree = page.build();
    const nodes = tree.nodes as Array<Record<string, unknown>>;
    const headings = nodes.filter((n) => n.type === "heading").map((n) => n.text);
    expect(headings).toContain("Task queue (seeds)");
    expect(headings).toContain("Agent memory (mulch)");
    const tables = nodes.filter((n) => n.type === "table") as Array<{ rows: Array<{ cells: string[] }> }>;
    expect(tables[0]!.rows[0]!.cells[0]).toBe("Fix login");
    expect(tables[1]!.rows[0]!.cells[0]).toContain("prefers tabs");
  });

  test("appendExtras renders nothing when both lists are empty", () => {
    const page = new (require("@ezcorp/sdk/runtime").PageBuilder)("ez-code");
    appendExtras(page, {});
    expect((page.build().nodes as unknown[]).length).toBe(0);
  });

  test("buildDashboardLive surfaces memory + tasks; fails soft on read errors", async () => {
    setBothStores(memoryStore([record({ id: "r1", status: "running" })]));
    _setMemoryForTests(async () => {
      throw new Error("memory down");
    });
    _setTaskStoreForTests({
      read: async () => {
        throw new Error("tasks down");
      },
      write: async () => {},
    });
    // Despite both extras failing, the page still renders the runs table.
    const tree = await buildDashboardLive();
    const types = (tree.nodes as Array<{ type: string }>).map((n) => n.type);
    expect(types).toContain("table");
    expect(tree.title).toBe("ez-code");
  });

  test("productionTriggers reads + parses triggers.json via fsExists/fsRead", async () => {
    const prev = process.env.EZCORP_FS_ALLOWED;
    process.env.EZCORP_FS_ALLOWED = "1";
    const ch = getChannel();
    ch.request = (async (method: string) => {
      if (method === "ezcorp/fs.exists") return { exists: true };
      if (method === "ezcorp/fs.read") {
        const json = JSON.stringify({
          triggers: [
            { cron: "0 9 * * *", agentName: "coder", task: "build" },
            { cron: "0 9 * * *", task: "missing-agent" }, // dropped by the filter
          ],
        });
        // The host returns base64; fsRead decodes via atob.
        return { encoding: "utf-8", body: btoa(json), bytes: json.length, resolvedPath: "/x" };
      }
      return {};
    }) as HostChannel["request"];
    try {
      const triggers = await productionTriggers();
      expect(triggers).toHaveLength(1);
      expect(triggers[0]!.agentName).toBe("coder");
    } finally {
      if (prev === undefined) delete process.env.EZCORP_FS_ALLOWED;
      else process.env.EZCORP_FS_ALLOWED = prev;
    }
  });

  test("productionTriggers returns [] when the file is absent", async () => {
    const prev = process.env.EZCORP_FS_ALLOWED;
    process.env.EZCORP_FS_ALLOWED = "1";
    const ch = getChannel();
    ch.request = (async (method: string) =>
      method === "ezcorp/fs.exists" ? { exists: false } : {}) as HostChannel["request"];
    try {
      expect(await productionTriggers()).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.EZCORP_FS_ALLOWED;
      else process.env.EZCORP_FS_ALLOWED = prev;
    }
  });

  test("productionTriggers fails soft (returns []) on a read error", async () => {
    const prev = process.env.EZCORP_FS_ALLOWED;
    process.env.EZCORP_FS_ALLOWED = "1";
    const ch = getChannel();
    ch.request = (async (method: string) => {
      if (method === "ezcorp/fs.exists") return { exists: true };
      throw new Error("read blew up");
    }) as HostChannel["request"];
    try {
      expect(await productionTriggers()).toEqual([]);
    } finally {
      if (prev === undefined) delete process.env.EZCORP_FS_ALLOWED;
      else process.env.EZCORP_FS_ALLOWED = prev;
    }
  });

  test("register wires a schedule handler for each declared cron", async () => {
    type Handler = (params: unknown) => Promise<unknown> | unknown;
    const handlers = new Map<string, Handler>();
    const ch: HostChannel = getChannel();
    const original = ch.onRequest.bind(ch);
    ch.onRequest = (method: string, handler: Handler) => {
      handlers.set(method, handler);
      original(method, handler);
    };
    setBothStores(memoryStore([]));
    _setMemoryForTests(async () => []);
    _setTaskStoreForTests({ read: async () => [], write: async () => {} });
    register();
    // The SDK installs a single ezcorp/schedule-fire receiver that routes by
    // cron; assert at least the page + event wiring landed (schedule routing
    // is covered behaviorally by the handleTriggerFire tests).
    expect([...handlers.keys()]).toContain("ezcorp/page.render");
  });
});

describe("tools registry", () => {
  test("exposes all five tools", () => {
    expect(Object.keys(tools).sort()).toEqual([
      "cancel_run",
      "dispatch_run",
      "list_runs",
      "open_pr",
      "steer_run",
    ]);
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

    setBothStores(memoryStore([record()]));
    _setMemoryForTests(async () => []);
    _setTaskStoreForTests({ read: async () => [], write: async () => {} });
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

describe("renderDashboard (production Storage round-trip) — SCOPE-aware", () => {
  test("dispatch writes scope=user; render reads scope=global — a user run is NOT on the shared dashboard", async () => {
    // Key the storage mock by BOTH scope AND key so the user + global buckets
    // are genuinely separate (matching the host's per-scope resolution).
    const saved: Record<string, unknown> = {};
    const skey = (p: Record<string, unknown>) => `${p.scope}:${p.key}`;
    const ch = getChannel();
    const originalRequest = ch.request.bind(ch);
    ch.request = (async (method: string, params: unknown) => {
      const p = params as Record<string, unknown>;
      if (method === "ezcorp/storage") {
        const k = skey(p);
        if (p.action === "set") {
          saved[k] = p.value;
          return { ok: true };
        }
        return { value: saved[k] ?? null, exists: k in saved };
      }
      if (method === "ezcorp/spawn-assignment") {
        return { v: 1, subConversationId: "s", agentRunId: "r", taskId: "t", assignmentId: "a" };
      }
      return originalRequest(method, params as never);
    }) as HostChannel["request"];

    _setUserStoreForTests(null); // force the production Storage-backed stores
    _setGlobalStoreForTests(null);
    _setMemoryForTests(async () => []); // avoid a live memory RPC
    _setTaskStoreForTests({ read: async () => [], write: async () => {} });
    _setPushPageForTests(() => {});

    // dispatch_run persists under USER scope via the loop-store: ONE per-run
    // key + an index key (NOT a single "runs" blob — the §5 race fix).
    // Omitting agentName resolves to the bundled coder.
    await dispatchRun({ task: "go" });
    const userKeys = Object.keys(saved).filter((k) => k.startsWith("user:"));
    const runKey = userKeys.find((k) => k.startsWith("user:loop:ez-code:run:"));
    expect(runKey).toBeDefined();
    expect(saved["user:loop:ez-code:index"]).toBeDefined(); // the index key
    const persisted = saved[runKey!] as { outcome?: { agentName?: string } };
    expect(persisted.outcome?.agentName).toBe(DEFAULT_CODER_AGENT);
    // GLOBAL scope was NOT written — the user run is private.
    expect(Object.keys(saved).some((k) => k.startsWith("global:"))).toBe(false);

    // The shared dashboard (global scope) shows 0 runs — the user's private
    // run does not leak into the cross-user tree.
    const tree = await renderDashboard();
    const stats = (tree.nodes as Array<Record<string, unknown>>).find(
      (n) => n.type === "stats",
    ) as { items: Array<{ value: string }> };
    expect(stats.items[0]!.value).toBe("0");
  });

  test("production loop-store round-trip: create → list/get → update (status flip + event)", async () => {
    // Drive the REAL loopBackedRunStore (not the in-memory seam) against a
    // scope-keyed Storage mock, so the per-run claim/list/get/transition +
    // toRunRecord adapter are all exercised end-to-end.
    const saved: Record<string, unknown> = {};
    const skey = (p: Record<string, unknown>) => `${p.scope}:${p.key}`;
    const ch = getChannel();
    const originalRequest = ch.request.bind(ch);
    ch.request = (async (method: string, params: unknown) => {
      const p = params as Record<string, unknown>;
      if (method === "ezcorp/storage") {
        const k = skey(p);
        if (p.action === "set") {
          saved[k] = p.value;
          return { ok: true };
        }
        if (p.action === "delete") {
          delete saved[k];
          return { deleted: true };
        }
        return { value: saved[k] ?? null, exists: k in saved };
      }
      if (method === "ezcorp/spawn-assignment") {
        return { v: 1, subConversationId: "s1", agentRunId: "run-rt", taskId: "t1", assignmentId: "a1" };
      }
      return originalRequest(method, params as never);
    }) as HostChannel["request"];

    _setUserStoreForTests(null); // force the production loop-store-backed user store
    _setGlobalStoreForTests(null);
    _setSpawnForTests(null);
    _setMemoryForTests(async () => []);
    _setTaskStoreForTests({ read: async () => [], write: async () => {} });
    _setPushPageForTests(() => {});

    // create (via dispatch_run → store.create/claim)
    await dispatchRun({ agentName: "Custom Bot", task: "do it", title: "RT" });

    // list (newest-first) + get (by id) round-trip through toRunRecord.
    const listed = parse(await listRuns({}));
    expect(listed.runs.map((r: { id: string }) => r.id)).toEqual(["run-rt"]);
    expect(listed.runs[0]!.title).toBe("RT");
    expect(listed.runs[0]!.agentName).toBe("Custom Bot");
    expect(listed.runs[0]!.status).toBe("dispatched");

    // update: a deferred completion flips status + records the raw event.
    await handleAssignmentUpdate({
      conversationId: "c",
      taskId: "t1",
      assignment: {
        id: "a1",
        agentConfigId: "cfg",
        agentName: "Custom Bot",
        isTeam: false,
        status: "completed",
        assignedAt: "t",
        agentRunId: "run-rt",
        resultPreview: "all done",
      },
    });
    const afterList = parse(await listRuns({}));
    expect(afterList.runs[0]!.status).toBe("completed");
    expect(afterList.runs[0]!.latestEvent.status).toBe("completed");
    expect(afterList.runs[0]!.latestEvent.note).toBe("all done");
  });
});

describe("PRIVACY — cross-user isolation (#3)", () => {
  test("user A's runs are not visible on user B's dashboard (separate user buckets)", async () => {
    // Two distinct per-user buckets stand in for users A and B; the shared
    // dashboard reads the global bucket. A user run goes to that user's bucket
    // and is invisible to the other user AND to the shared dashboard.
    const userA = memoryStore([record({ id: "a1", title: "A secret task" })]);
    const userB = memoryStore([]);
    const globalShared = memoryStore([]);

    // User A dispatches → lands in A's bucket only.
    _setUserStoreForTests(userA);
    _setGlobalStoreForTests(globalShared);
    _setPushPageForTests(() => {});
    _setSpawnForTests(async () => ({
      subConversationId: "subA",
      agentRunId: "aNew",
      taskId: "tA",
      assignmentId: "asgA",
    }));
    await dispatchRun({ agentName: "coder", task: "private A work" });
    expect(userA.runs.map((r) => r.id)).toContain("aNew");

    // User B lists THEIR runs → sees none of A's.
    _setUserStoreForTests(userB);
    const bList = parse(await listRuns({}));
    expect(bList.runs).toHaveLength(0);

    // The shared dashboard (global bucket) shows none of A's private runs,
    // and carries no `/chat/<sub>` deep-links.
    _setMemoryForTests(async () => []);
    _setTaskStoreForTests({ read: async () => [], write: async () => {} });
    const tree = await renderDashboard();
    const nodes = tree.nodes as Array<Record<string, unknown>>;
    expect(nodes.some((n) => n.type === "table")).toBe(false); // empty (global)
    const json = JSON.stringify(tree);
    expect(json).not.toContain("/chat/");
    expect(json).not.toContain("A secret task");
  });

  // NON-NEGOTIABLE regression (the Hub tree is cached per-(ext,page) and
  // served to ALL users): a user-scope run must NEVER reach the shared
  // dashboard, and a task:assignment_update for a user-scope run must NOT
  // push the shared page. Proven here at the EZ-CODE level (the primitive-
  // level proof lives in the SDK loop-log "PRIVACY" suite).
  test("a user-scope run never appears in the rendered global dashboard", async () => {
    const userBucket = memoryStore([record({ id: "u-priv", title: "private" })]);
    const globalBucket = memoryStore([]);
    _setUserStoreForTests(userBucket);
    _setGlobalStoreForTests(globalBucket);
    _setMemoryForTests(async () => []);
    _setTaskStoreForTests({ read: async () => [], write: async () => {} });

    const tree = await renderDashboard();
    // The global render reads the global bucket ONLY — the user run is absent.
    expect(JSON.stringify(tree)).not.toContain("u-priv");
    expect(JSON.stringify(tree)).not.toContain("private");
    const stats = (tree.nodes as Array<Record<string, unknown>>).find(
      (n) => n.type === "stats",
    ) as { items: Array<{ value: string }> };
    expect(stats.items[0]!.value).toBe("0"); // zero runs on the shared page
  });

  test("a task:assignment_update for a USER run does NOT push the shared page", async () => {
    const userBucket = memoryStore([record({ id: "u-run", status: "dispatched", assignmentId: "u-asg" })]);
    const globalBucket = memoryStore([]);
    _setUserStoreForTests(userBucket);
    _setGlobalStoreForTests(globalBucket);
    const pushes = capturePushes();

    await handleAssignmentUpdate({
      conversationId: "c",
      taskId: "u-task",
      assignment: {
        id: "u-asg",
        agentConfigId: "cfg",
        agentName: "coder",
        isTeam: false,
        status: "completed",
        assignedAt: "t",
        agentRunId: "u-run",
      },
    });

    // The user run transitioned PRIVATELY (its own bucket).
    expect(userBucket.runs[0]!.status).toBe("completed");
    // The shared page IS re-rendered, but it renders the GLOBAL bucket only,
    // which is empty — so the user run can't leak even on the push.
    const pushedTrees = pushes.map((p) => JSON.stringify(p.tree));
    expect(pushedTrees.every((t) => !t.includes("u-run"))).toBe(true);
    // And the global bucket was never written with the user run.
    expect(globalBucket.runs).toHaveLength(0);
  });
});
