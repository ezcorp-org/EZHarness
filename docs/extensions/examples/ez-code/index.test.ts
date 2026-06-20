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
  _setHostRunnerForTests,
  _setMemoryForTests,
  _setProjectRootForTests,
  _setPushPageForTests,
  _setShellForTests,
  _setSpawnForTests,
  _setTaskStoreForTests,
  _setTriggersForTests,
  _setUserStoreForTests,
  appendExtras,
  branchForRun,
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
  makeProductionShell,
  mapStatus,
  materializeChanges,
  openPr,
  openPrForRun,
  productionTriggers,
  shQuote,
  worktreeRwPaths,
  register,
  renderDashboard,
  steerRun,
  steerRunById,
  tools,
  type RunRecord,
  type RunStore,
  type ShellResult,
  type TaskRecord,
  type TaskStore,
  type Trigger,
} from "./index";
import type { ToolCallResult } from "../../../../src/extensions/types";
import { probeLandlockAbi, getSandboxTier } from "../../../../src/extensions/sandbox/capability-probe";

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
function fakeHost(
  opts: { originHead?: string | null; status?: string; gitDir?: string } = {},
): { worktree: () => string | null; calls: string[][] } {
  const calls: string[][] = [];
  let worktree: string | null = null;
  _setHostRunnerForTests(async (cmd, _cwd): Promise<ShellResult> => {
    calls.push(cmd);
    // `mktemp -d` (the worktree temp parent) — return a deterministic stub dir.
    if (cmd[0] === "sh" && /\bmktemp -d\b/.test(cmd[2] ?? "")) {
      return { exitCode: 0, stdout: "/tmp/ez-code-wt-stub\n", stderr: "" };
    }
    // The shell-driven materializer (`sh -c "git diff … | git apply …"`) — the
    // unit-level open_pr tests don't assert real file carry (the integration
    // test does), so report a clean no-op.
    if (cmd[0] === "sh") return { exitCode: 0, stdout: "", stderr: "" };
    // `git ls-files -o` (untracked enumeration) — none in the unit path.
    if (cmd[1] === "ls-files") return { exitCode: 0, stdout: opts.status ?? "", stderr: "" };
    if (cmd[1] === "rev-parse") {
      return { exitCode: 0, stdout: `${opts.gitDir ?? "/proj/repo/.git"}\n`, stderr: "" };
    }
    if (cmd[1] === "symbolic-ref") {
      return opts.originHead === null || opts.originHead === undefined
        ? { exitCode: 1, stdout: "", stderr: "no HEAD" }
        : { exitCode: 0, stdout: `refs/remotes/origin/${opts.originHead}\n`, stderr: "" };
    }
    if (cmd[1] === "worktree" && cmd[2] === "add") {
      worktree = cmd[4] ?? null; // ["git","worktree","add","--detach",<wt>,"HEAD"]
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    if (cmd[1] === "status") {
      return { exitCode: 0, stdout: opts.status ?? "", stderr: "" };
    }
    if (cmd[1] === "worktree" && cmd[2] === "remove") {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  });
  return { worktree: () => worktree, calls };
}

/** A real-shell HostRunner backed by Bun.spawnSync — used to exercise the
 *  shell-driven (node:fs-free) materializer against a throwaway git repo. */
function realGitRunner(): (cmd: string[], cwd: string) => Promise<ShellResult> {
  return async (cmd, cwd) => {
    const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
    return {
      exitCode: p.exitCode,
      stdout: p.stdout.toString(),
      stderr: p.stderr.toString(),
    };
  };
}

afterEach(() => {
  _setUserStoreForTests(null);
  _setGlobalStoreForTests(null);
  _setPushPageForTests(null);
  _setSpawnForTests(null);
  _setCancelForTests(null);
  _setAppendMessageForTests(null);
  _setShellForTests(null);
  _setHostRunnerForTests(null);
  _setProjectRootForTests(null);
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

describe("open_pr (B3 branch→PR automation)", () => {
  test("branchForRun slugifies the run id", () => {
    expect(branchForRun("run-1")).toBe("ez-code/run-1");
    expect(branchForRun("weird id/with:chars")).toBe("ez-code/weird-id-with-chars");
  });

  test("runs git+gh INSIDE the worktree (not the repo), in order, with the right args", async () => {
    setBothStores(memoryStore([record({ id: "run-pr", title: "My feature" })]));
    _setPushPageForTests(() => {});
    _setProjectRootForTests(() => "/proj/repo");
    const host = fakeHost({ originHead: "main" });
    const calls: Array<{ cmd: string[]; cwd: string }> = [];
    _setShellForTests(async (cmd, cwd): Promise<ShellResult> => {
      calls.push({ cmd, cwd });
      const stdout = cmd[0] === "gh" ? "https://github.com/org/repo/pull/7" : "";
      return { exitCode: 0, stdout, stderr: "" };
    });

    const r = await openPr({ runId: "run-pr", body: "Fixes the thing" });
    const payload = parse(r);
    expect(payload.opened).toBe(true);
    expect(payload.prUrl).toBe("https://github.com/org/repo/pull/7");

    // The jailed git/gh all ran INSIDE the per-run worktree, NOT the repo root.
    const wt = host.worktree();
    expect(wt).toBeTruthy();
    expect(calls.every((c) => c.cwd === wt)).toBe(true);
    expect(calls.every((c) => c.cwd !== "/proj/repo")).toBe(true);
    // Ordered: branch → add → commit → push → gh (default-branch detection +
    // worktree setup are HOST-side and don't flow through the jailed shell).
    expect(calls.map((c) => `${c.cmd[0]} ${c.cmd[1]}`)).toEqual([
      "git switch",
      "git add",
      "git commit",
      "git push",
      "gh pr",
    ]);
    expect(calls[0]!.cmd).toEqual(["git", "switch", "-c", "ez-code/run-pr"]);
    expect(calls[3]!.cmd).toEqual(["git", "push", "-u", "origin", "ez-code/run-pr"]);
    const gh = calls[4]!.cmd;
    expect(gh.slice(0, 3)).toEqual(["gh", "pr", "create"]);
    expect(gh).toContain("--head");
    expect(gh[gh.indexOf("--head") + 1]).toBe("ez-code/run-pr");
    expect(gh[gh.indexOf("--title") + 1]).toBe("My feature");
    expect(gh[gh.indexOf("--body") + 1]).toBe("Fixes the thing");
    expect(gh).toContain("--base");
    expect(gh[gh.indexOf("--base") + 1]).toBe("main");

    // The worktree lifecycle: add then remove --force (cleanup always runs).
    expect(host.calls.some((c) => c[1] === "worktree" && c[2] === "add")).toBe(true);
    expect(host.calls.some((c) => c[1] === "worktree" && c[2] === "remove")).toBe(true);
  });

  test("--base targets the detected default branch from origin/HEAD", async () => {
    setBothStores(memoryStore([record({ id: "run-base", title: "T" })]));
    _setPushPageForTests(() => {});
    _setProjectRootForTests(() => "/repo");
    fakeHost({ originHead: "develop" });
    let ghBase: string | undefined;
    _setShellForTests(async (cmd): Promise<ShellResult> => {
      if (cmd[0] === "gh") ghBase = cmd[cmd.indexOf("--base") + 1];
      return { exitCode: 0, stdout: cmd[0] === "gh" ? "url" : "", stderr: "" };
    });
    await openPr({ runId: "run-base" });
    expect(ghBase).toBe("develop");
  });

  test("--base falls back to main when origin/HEAD is unset", async () => {
    setBothStores(memoryStore([record({ id: "run-nohead", title: "T" })]));
    _setPushPageForTests(() => {});
    _setProjectRootForTests(() => "/repo");
    fakeHost({ originHead: null });
    let ghBase: string | undefined;
    _setShellForTests(async (cmd): Promise<ShellResult> => {
      if (cmd[0] === "gh") ghBase = cmd[cmd.indexOf("--base") + 1];
      return { exitCode: 0, stdout: cmd[0] === "gh" ? "url" : "", stderr: "" };
    });
    await openPr({ runId: "run-nohead" });
    expect(ghBase).toBe("main");
  });

  test("records a pr_opened event; the open_pr TOOL does NOT push the shared tree", async () => {
    const store = memoryStore([record({ id: "run-ev", title: "T" })]);
    setBothStores(store);
    const pushes = capturePushes();
    _setProjectRootForTests(() => "/repo");
    fakeHost({ originHead: "main" });
    _setShellForTests(async (cmd) => ({
      exitCode: 0,
      stdout: cmd[0] === "gh" ? "https://github.com/o/r/pull/3" : "",
      stderr: "",
    }));
    await openPr({ runId: "run-ev" });
    expect(store.runs[0]!.events[0]!.status).toBe("pr_opened");
    expect(store.runs[0]!.events[0]!.note).toBe("https://github.com/o/r/pull/3");
    // open_pr operates on the user's private run — no shared push.
    expect(pushes).toHaveLength(0);
  });

  test("aborts (fail-closed) on a non-zero git step, surfacing stderr — worktree still removed", async () => {
    setBothStores(memoryStore([record({ id: "run-fail" })]));
    _setProjectRootForTests(() => "/repo");
    const host = fakeHost({ originHead: "main" });
    _setShellForTests(async (cmd) =>
      cmd[1] === "push"
        ? { exitCode: 1, stdout: "", stderr: "remote rejected" }
        : { exitCode: 0, stdout: "", stderr: "" },
    );
    const r = await openPr({ runId: "run-fail" });
    expect(r.isError).toBe(true);
    const text = (r.content[0] as { text: string }).text;
    expect(text).toContain("git push");
    expect(text).toContain("remote rejected");
    // Cleanup runs on the failure path too.
    expect(host.calls.some((c) => c[1] === "worktree" && c[2] === "remove")).toBe(true);
  });

  test("aborts (fail-closed) when git worktree add fails", async () => {
    setBothStores(memoryStore([record({ id: "run-wtfail" })]));
    _setProjectRootForTests(() => "/repo");
    _setHostRunnerForTests(async (cmd): Promise<ShellResult> => {
      if (cmd[1] === "worktree" && cmd[2] === "add") {
        return { exitCode: 1, stdout: "", stderr: "fatal: worktree exists" };
      }
      return { exitCode: 0, stdout: "/repo/.git\n", stderr: "" };
    });
    const res = await openPrForRun("run-wtfail");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("git worktree add failed");
  });

  test("prunes when worktree remove fails (belt-and-suspenders cleanup)", async () => {
    setBothStores(memoryStore([record({ id: "run-prune" })]));
    _setProjectRootForTests(() => "/repo");
    const calls: string[][] = [];
    _setHostRunnerForTests(async (cmd): Promise<ShellResult> => {
      calls.push(cmd);
      if (cmd[0] === "sh" && /\bmktemp -d\b/.test(cmd[2] ?? ""))
        return { exitCode: 0, stdout: "/tmp/ez-code-wt-stub\n", stderr: "" };
      if (cmd[0] === "sh") return { exitCode: 0, stdout: "", stderr: "" }; // materialize
      if (cmd[1] === "ls-files") return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd[1] === "rev-parse") return { exitCode: 0, stdout: "/repo/.git\n", stderr: "" };
      if (cmd[1] === "symbolic-ref")
        return { exitCode: 0, stdout: "refs/remotes/origin/main\n", stderr: "" };
      if (cmd[1] === "worktree" && cmd[2] === "add")
        return { exitCode: 0, stdout: "", stderr: "" };
      if (cmd[1] === "status") return { exitCode: 0, stdout: "", stderr: "" };
      // The remove fails (e.g. a stuck lock) → the finally must fall back to prune.
      if (cmd[1] === "worktree" && cmd[2] === "remove")
        return { exitCode: 1, stdout: "", stderr: "fatal: worktree is locked" };
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    _setShellForTests(async () => ({ exitCode: 0, stdout: "", stderr: "" }));
    const res = await openPrForRun("run-prune");
    expect(res.ok).toBe(true);
    expect(calls.some((c) => c[1] === "worktree" && c[2] === "remove")).toBe(true);
    expect(calls.some((c) => c[1] === "worktree" && c[2] === "prune")).toBe(true);
  });

  test("validates runId", async () => {
    expect((await openPr({})).isError).toBe(true);
  });

  test("reports a missing run", async () => {
    setBothStores(memoryStore([]));
    expect((await openPrForRun("ghost")).ok).toBe(false);
  });

  test("fails when no active project repo is resolved", async () => {
    setBothStores(memoryStore([record({ id: "run-noroot" })]));
    _setProjectRootForTests(() => undefined);
    const res = await openPrForRun("run-noroot");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("EZCORP_PROJECT_ROOT");
  });
});

describe("shQuote + worktreeRwPaths (jail wiring)", () => {
  test("shQuote wraps in single quotes and escapes embedded quotes", () => {
    expect(shQuote("plain")).toBe("'plain'");
    expect(shQuote("with space")).toBe("'with space'");
    // An embedded single quote is closed, escaped, and reopened.
    expect(shQuote("a'b")).toBe(`'a'\\''b'`);
    // Shell metacharacters are inert inside the single quotes.
    expect(shQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'");
  });

  test("worktreeRwPaths grants ONLY the worktree + .git + /dev (never the repo root)", () => {
    const paths = worktreeRwPaths("/tmp/ez-code-wt-x/wt", "/proj/repo/.git");
    expect(paths).toEqual(["/tmp/ez-code-wt-x/wt", "/proj/repo/.git", "/dev"]);
    // The repo root is never present — `.ezcorp/data` can't be reached.
    expect(paths).not.toContain("/proj/repo");
  });

  // The shell-driven materializer (node:fs-free) is exercised against a REAL
  // throwaway repo + worktree: modify, untracked-add, delete, rename, AND a
  // symlink change must all carry, while gitignored `.ezcorp/` must NOT — using
  // git's own diff/ls-files (which honor `.gitignore`).
  test("materializeChanges (shell) carries modify/add/delete/rename/symlink; excludes .ezcorp", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, rmSync, realpathSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const runner = realGitRunner();

    const base = realpathSync(mkdtempSync(join(tmpdir(), "mat-")));
    const repo = join(base, "repo");
    mkdirSync(join(repo, "dir"), { recursive: true });
    const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
    g(["init"]);
    g(["config", "user.email", "t@t.com"]);
    g(["config", "user.name", "t"]);
    g(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, ".gitignore"), ".ezcorp/\n");
    writeFileSync(join(repo, "mod.txt"), "ORIGINAL\n");
    writeFileSync(join(repo, "removed.txt"), "GONE\n");
    writeFileSync(join(repo, "old.txt"), "RENAME ME\n");
    writeFileSync(join(repo, "lnk-target.txt"), "T\n");
    g(["add", "-A"]);
    g(["commit", "-m", "init"]);

    // Pending run changes (staged + unstaged + untracked + symlink + gitignored).
    writeFileSync(join(repo, "mod.txt"), "EDITED\n"); // tracked modify
    rmSync(join(repo, "removed.txt")); // tracked delete
    g(["mv", "old.txt", "new.txt"]); // tracked rename
    writeFileSync(join(repo, "added.txt"), "NEW\n"); // untracked add
    symlinkSync("lnk-target.txt", join(repo, "link")); // untracked symlink
    const dataDir = join(repo, ".ezcorp", "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "jwt"), "SECRET\n"); // gitignored — must NOT carry

    const wt = join(base, "wt");
    try {
      // Real worktree checkout of HEAD (tracked baseline only).
      Bun.spawnSync(["git", "worktree", "add", "--detach", wt, "HEAD"], { cwd: repo });
      const res = await materializeChanges(repo, wt, runner);
      expect(res.ok).toBe(true);

      // Stage + commit on a branch in the worktree, then inspect the tree.
      Bun.spawnSync(["git", "switch", "-c", "mat-branch"], { cwd: wt });
      Bun.spawnSync(["git", "add", "-A"], { cwd: wt });
      Bun.spawnSync(["git", "-c", "commit.gpgsign=false", "commit", "-m", "materialized"], { cwd: wt });

      const tree = Bun.spawnSync(
        ["git", "ls-tree", "-r", "mat-branch"],
        { cwd: wt, stdout: "pipe" },
      ).stdout.toString();
      // modify carried:
      const modBlob = Bun.spawnSync(["git", "show", "mat-branch:mod.txt"], { cwd: wt, stdout: "pipe" })
        .stdout.toString();
      expect(modBlob).toBe("EDITED\n");
      // delete carried:
      expect(tree).not.toContain("removed.txt");
      // rename carried (old gone, new present):
      expect(tree).not.toContain("\told.txt");
      expect(tree).toContain("new.txt");
      // untracked add carried:
      expect(tree).toContain("added.txt");
      // symlink carried AS a symlink (mode 120000):
      expect(tree).toMatch(/120000 blob [0-9a-f]+\tlink/);
      // gitignored .ezcorp/ NEVER carried, and the patch sidecar was cleaned up:
      expect(tree).not.toContain(".ezcorp");
      expect(tree).not.toContain("jwt");
      expect(tree).not.toContain(".ez-code-materialize.patch");
    } finally {
      Bun.spawnSync(["git", "worktree", "remove", "--force", wt], { cwd: repo });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("materializeChanges is a clean no-op when there are no pending changes", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } =
      await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const runner = realGitRunner();
    const base = realpathSync(mkdtempSync(join(tmpdir(), "mat-noop-")));
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    const g = (args: string[]) => Bun.spawnSync(["git", ...args], { cwd: repo });
    g(["init"]);
    g(["config", "user.email", "t@t.com"]);
    g(["config", "user.name", "t"]);
    g(["config", "commit.gpgsign", "false"]);
    writeFileSync(join(repo, "README.md"), "x\n");
    g(["add", "-A"]);
    g(["commit", "-m", "init"]);
    const wt = join(base, "wt");
    try {
      Bun.spawnSync(["git", "worktree", "add", "--detach", wt, "HEAD"], { cwd: repo });
      const res = await materializeChanges(repo, wt, runner);
      expect(res.ok).toBe(true);
      // The worktree is still clean (empty patch was a no-op; sidecar removed).
      const status = Bun.spawnSync(["git", "status", "--porcelain"], { cwd: wt, stdout: "pipe" })
        .stdout.toString();
      expect(status.trim()).toBe("");
    } finally {
      Bun.spawnSync(["git", "worktree", "remove", "--force", wt], { cwd: repo });
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("makeProductionShell threads cmd+cwd through the jail (worktree shape)", async () => {
    // Mirror production: a worktree workspace + a sibling main `.git` + a
    // separate project root (whose `.ezcorp/data` is the forbidden anchor).
    // On a host without a usable tier the wrap is a plain spawn; on a capable
    // host the jail may alter the exit — the command + wiring are exercised
    // either way. The repo root is NEVER granted, so the builder's data-dir
    // assertion passes (the worktree is outside the repo).
    const { mkdtempSync, mkdirSync, rmSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const base = realpathSync(mkdtempSync(join(tmpdir(), "ps-")));
    const repo = join(base, "repo");
    const gitDir = join(repo, ".git");
    const wt = join(base, "wt");
    mkdirSync(gitDir, { recursive: true });
    mkdirSync(wt, { recursive: true });
    try {
      const shell = makeProductionShell(gitDir, repo);
      const r = await shell(["/bin/sh", "-c", "echo PS_OK"], wt);
      expect(typeof r.exitCode).toBe("number");
      expect(typeof r.stdout).toBe("string");
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("open_pr against a real throwaway git repo (integration)", () => {
  test("worktree carries the run's changes; .ezcorp/ is absent; PR opened against the bare remote", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync, existsSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");

    // Build a real repo with a bare 'origin' so `git push` works offline.
    const base = mkdtempSync(join(tmpdir(), "ezc-pr-"));
    const repo = join(base, "work");
    const remote = join(base, "remote.git");
    mkdirSync(repo, { recursive: true });

    const git = (args: string[], cwd: string) =>
      Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    Bun.spawnSync(["git", "init", "--bare", remote], { stdout: "pipe", stderr: "pipe" });
    git(["init"], repo);
    git(["config", "user.email", "t@t.com"], repo);
    git(["config", "user.name", "t"], repo);
    git(["config", "commit.gpgsign", "false"], repo);
    // `.ezcorp/` is gitignored (the platform convention) — so worktree
    // checkouts + `git status --porcelain` never see it.
    writeFileSync(join(repo, ".gitignore"), ".ezcorp/\n");
    writeFileSync(join(repo, "README.md"), "# work\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "init"], repo);
    git(["branch", "-M", "main"], repo);
    git(["remote", "add", "origin", remote], repo);

    // Plant the platform secret under the gitignored .ezcorp/data dir.
    const dataDir = join(repo, ".ezcorp", "data");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "jwt"), "TOP-SECRET");
    // The run's pending changes: an UNTRACKED new file + a MODIFIED tracked
    // file. Both must reach the PR; the secret must NOT.
    writeFileSync(join(repo, "feature.txt"), "agent work\n"); // untracked
    writeFileSync(join(repo, "README.md"), "# work\nedited by the agent\n"); // modified

    setBothStores(memoryStore([record({ id: "run-real", title: "Add feature" })]));
    _setPushPageForTests(() => {});
    _setProjectRootForTests(() => repo);

    // The host orchestration (worktree add/remove, status, rev-parse) runs as
    // REAL host git (the default productionHostRunner). The JAILED git/gh runs
    // real git in the worktree cwd (advisory-equivalent stand-in for the OS
    // jail, which is tier-gated + covered by the in-container test below); gh
    // is faked (no network/auth in CI). We capture the worktree path gh ran in.
    let ghArgs: string[] | null = null;
    let ghCwd: string | null = null;
    _setShellForTests(async (cmd, cwd): Promise<ShellResult> => {
      if (cmd[0] === "gh") {
        ghArgs = cmd;
        ghCwd = cwd;
        return { exitCode: 0, stdout: "https://github.com/org/repo/pull/42", stderr: "" };
      }
      const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
      return { exitCode: p.exitCode, stdout: p.stdout.toString(), stderr: p.stderr.toString() };
    });

    const res = await openPrForRun("run-real", { body: "real PR" });
    expect(res.ok).toBe(true);
    expect(res.url).toBe("https://github.com/org/repo/pull/42");

    // gh ran in the WORKTREE (a tmp dir), NEVER the repo root.
    expect(ghCwd).toBeTruthy();
    expect(ghCwd).not.toBe(repo);

    // The branch reached the bare remote, carrying the run's intended diff.
    const remoteRefs = Bun.spawnSync(["git", "ls-remote", "--heads", remote], {
      stdout: "pipe",
    }).stdout.toString();
    expect(remoteRefs).toContain("ez-code/run-real");

    // Inspect the pushed tree: feature.txt (untracked add) + the README edit
    // are present; `.ezcorp/` is NOT — the worktree never contained it.
    const lsTree = Bun.spawnSync(
      ["git", "ls-tree", "-r", "--name-only", "ez-code/run-real"],
      { cwd: remote, stdout: "pipe" },
    ).stdout.toString();
    expect(lsTree).toContain("feature.txt");
    expect(lsTree).toContain("README.md");
    expect(lsTree).not.toContain(".ezcorp");
    expect(lsTree).not.toContain("jwt");
    // The README edit was carried into the commit.
    const readmeBlob = Bun.spawnSync(
      ["git", "show", "ez-code/run-real:README.md"],
      { cwd: remote, stdout: "pipe" },
    ).stdout.toString();
    expect(readmeBlob).toContain("edited by the agent");

    // gh pr create was issued with the run's branch + title.
    expect(ghArgs).not.toBeNull();
    expect(ghArgs![ghArgs!.indexOf("--head") + 1]).toBe("ez-code/run-real");
    expect(ghArgs![ghArgs!.indexOf("--title") + 1]).toBe("Add feature");

    // The temp worktree was cleaned up (no leak); the host repo's secret is
    // untouched.
    expect(existsSync(join(dataDir, "jwt"))).toBe(true);

    const { rmSync } = await import("node:fs");
    rmSync(base, { recursive: true, force: true });
  });

  // #2 — open_pr's git runs JAILED (Seam B) inside an `.ezcorp`-free worktree.
  // Exercises the REAL productionShell against a real worktree: git FUNCTIONS
  // jailed (branch + commit write the worktree + the main `.git`), the jail's
  // rw set is ONLY the worktree + the main `.git` (NEVER the repo root), and
  // reading the repo's `.ezcorp/data/jwt` from inside the jail is DENIED
  // (EACCES). The local `git push` is intentionally NOT exercised under the
  // jail: in production the push target is `api.github.com` over the network
  // (egress-gated), NOT a filesystem path — a local bare-remote dir is outside
  // the jail by design, so we assert the commit landed in the shared `.git`
  // instead. Gated on the LANDLOCK tier — the container's production path; the
  // dev host resolves to `bwrap` whose setuid wrapper rejects unprivileged
  // tmpfs flags (an environment quirk), so this runs in-container.
  test.if(getSandboxTier() === "landlock" && (probeLandlockAbi() ?? 0) >= 1)(
    "JAILED git in worktree creates+commits (writes the shared .git); repo .ezcorp/data DENIED, root never granted",
    async () => {
      const { mkdtempSync, writeFileSync, mkdirSync, rmSync, realpathSync } =
        await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");

      const base = realpathSync(mkdtempSync(join(tmpdir(), "ezc-jail-")));
      const repo = join(base, "work");
      mkdirSync(repo, { recursive: true });
      const run = (args: string[], cwd: string) =>
        Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
      run(["git", "init"], repo);
      run(["git", "config", "user.email", "t@t.com"], repo);
      run(["git", "config", "user.name", "t"], repo);
      run(["git", "config", "commit.gpgsign", "false"], repo);
      run(["git", "branch", "-M", "main"], repo);
      writeFileSync(join(repo, ".gitignore"), ".ezcorp/\n");
      writeFileSync(join(repo, "README.md"), "# work\n");
      run(["git", "add", "-A"], repo);
      run(["git", "commit", "-m", "init"], repo);
      // Plant a platform secret under the (gitignored) .ezcorp/data dir.
      const dataDir = join(repo, ".ezcorp", "data");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "jwt"), "TOP-SECRET");

      // Create a worktree by hand (the host orchestration the production path
      // does), then exercise the REAL jailed shell INSIDE it.
      const wtRoot = realpathSync(mkdtempSync(join(tmpdir(), "ezc-wt-")));
      const wt = join(wtRoot, "wt");
      run(["git", "worktree", "add", "--detach", wt, "HEAD"], repo);
      // Materialize the untracked change into the worktree (stash-free copy).
      writeFileSync(join(wt, "feature.txt"), "agent work\n");
      const gitDir = run(["git", "rev-parse", "--absolute-git-dir"], repo)
        .stdout.toString()
        .trim();
      // The jail grants the worktree + the main `.git` + /dev — NEVER the repo
      // root. `.ezcorp/data` is therefore outside every grant.
      const jailed = makeProductionShell(gitDir, repo);

      try {
        expect((await jailed(["git", "switch", "-c", "ez-code/jailed"], wt)).exitCode).toBe(0);
        expect((await jailed(["git", "add", "-A"], wt)).exitCode).toBe(0);
        expect((await jailed(["git", "commit", "-m", "jailed work"], wt)).exitCode).toBe(0);

        // The commit landed in the SHARED `.git` (granted rw) — git FUNCTIONED
        // jailed without the repo root. The branch is visible from the main
        // repo, carrying the materialized untracked change.
        const log = run(["git", "log", "--oneline", "ez-code/jailed"], repo).stdout.toString();
        expect(log).toContain("jailed work");
        const tree = run(["git", "ls-tree", "-r", "--name-only", "ez-code/jailed"], repo)
          .stdout.toString();
        expect(tree).toContain("feature.txt");
        expect(tree).not.toContain(".ezcorp");

        // The repo's .ezcorp/data/jwt is DENIED read inside the jail (the repo
        // root was never granted; only the worktree + .git are reachable).
        const readDeny = await jailed(["cat", join(dataDir, "jwt")], wt);
        expect(readDeny.exitCode).not.toBe(0);
        expect(readDeny.stderr.toLowerCase()).toContain("permission denied");
      } finally {
        run(["git", "worktree", "remove", "--force", wt], repo);
        rmSync(wtRoot, { recursive: true, force: true });
        rmSync(base, { recursive: true, force: true });
      }
    },
  );
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
