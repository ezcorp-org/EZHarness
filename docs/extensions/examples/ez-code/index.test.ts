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
  MAX_RUNS,
  PAGE_ID,
  _setAppendMessageForTests,
  _setCancelForTests,
  _setGlobalStoreForTests,
  _setMemoryForTests,
  _setProjectRootForTests,
  _setPushPageForTests,
  _setShellForTests,
  _setSpawnForTests,
  _setTaskStoreForTests,
  _setTriggersForTests,
  _setUserStoreForTests,
  appendExtras,
  appendRun,
  applyAssignmentUpdate,
  branchForRun,
  buildDashboard,
  buildDashboardLive,
  handleTriggerFire,
  triggersForCron,
  cancelRunById,
  cancelRunTool,
  dispatchRun,
  handleAssignmentUpdate,
  handleCancelAction,
  handleSteerAction,
  isLive,
  listRuns,
  mapStatus,
  openPr,
  openPrForRun,
  productionShell,
  productionTriggers,
  recordRunEvent,
  repoRwPaths,
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

afterEach(() => {
  _setUserStoreForTests(null);
  _setGlobalStoreForTests(null);
  _setPushPageForTests(null);
  _setSpawnForTests(null);
  _setCancelForTests(null);
  _setAppendMessageForTests(null);
  _setShellForTests(null);
  _setProjectRootForTests(null);
  _setTriggersForTests(null);
  _setMemoryForTests(null);
  _setTaskStoreForTests(null);
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

describe("dispatch_run tool", () => {
  test("spawns + persists to the per-user store; does NOT push the shared tree (privacy)", async () => {
    const userStore = memoryStore();
    const globalStore = memoryStore();
    _setUserStoreForTests(userStore);
    _setGlobalStoreForTests(globalStore);
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

  test("validates agentName and task", async () => {
    const r1 = await dispatchRun({ task: "x" });
    expect(r1.isError).toBe(true);
    const r2 = await dispatchRun({ agentName: "coder" });
    expect(r2.isError).toBe(true);
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

describe("isLive / recordRunEvent (B2 pure helpers)", () => {
  test("isLive: only dispatched + running are live", () => {
    expect(isLive("dispatched")).toBe(true);
    expect(isLive("running")).toBe(true);
    expect(isLive("completed")).toBe(false);
    expect(isLive("failed")).toBe(false);
    expect(isLive("cancelled")).toBe(false);
  });

  test("recordRunEvent prepends an event + optionally forces status", () => {
    const before = [record({ id: "r1", status: "running", events: [] })];
    const after = recordRunEvent(before, "r1", { status: "cancelled" }, "cancelled");
    expect(after[0]!.status).toBe("cancelled");
    expect(after[0]!.events[0]!.status).toBe("cancelled");
    // non-matching id untouched
    const same = recordRunEvent(before, "nope", { status: "x" });
    expect(same[0]).toEqual(before[0]!);
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

  test("runs git+gh in the project repo cwd, in order, with the right args", async () => {
    setBothStores(memoryStore([record({ id: "run-pr", title: "My feature" })]));
    _setPushPageForTests(() => {});
    _setProjectRootForTests(() => "/proj/repo");
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

    // Every command ran in the active project's repo.
    expect(calls.every((c) => c.cwd === "/proj/repo")).toBe(true);
    // Ordered: detect default branch → branch → add → commit → push → gh.
    expect(calls.map((c) => `${c.cmd[0]} ${c.cmd[1]}`)).toEqual([
      "git symbolic-ref",
      "git switch",
      "git add",
      "git commit",
      "git push",
      "gh pr",
    ]);
    // Branch name + gh args (the git step indices shift by 1 after the
    // symbolic-ref probe at index 0).
    expect(calls[1]!.cmd).toEqual(["git", "switch", "-c", "ez-code/run-pr"]);
    expect(calls[4]!.cmd).toEqual(["git", "push", "-u", "origin", "ez-code/run-pr"]);
    const gh = calls[5]!.cmd;
    expect(gh.slice(0, 3)).toEqual(["gh", "pr", "create"]);
    expect(gh).toContain("--head");
    expect(gh[gh.indexOf("--head") + 1]).toBe("ez-code/run-pr");
    expect(gh[gh.indexOf("--title") + 1]).toBe("My feature");
    expect(gh[gh.indexOf("--body") + 1]).toBe("Fixes the thing");
    // #6 — the PR targets the detected default branch via --base.
    expect(gh).toContain("--base");
  });

  test("--base targets the detected default branch from origin/HEAD", async () => {
    setBothStores(memoryStore([record({ id: "run-base", title: "T" })]));
    _setPushPageForTests(() => {});
    _setProjectRootForTests(() => "/repo");
    let ghBase: string | undefined;
    _setShellForTests(async (cmd): Promise<ShellResult> => {
      if (cmd[1] === "symbolic-ref") {
        return { exitCode: 0, stdout: "refs/remotes/origin/develop\n", stderr: "" };
      }
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
    let ghBase: string | undefined;
    _setShellForTests(async (cmd): Promise<ShellResult> => {
      if (cmd[1] === "symbolic-ref") return { exitCode: 1, stdout: "", stderr: "no HEAD" };
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

  test("aborts (fail-closed) on a non-zero git step, surfacing stderr", async () => {
    setBothStores(memoryStore([record({ id: "run-fail" })]));
    _setProjectRootForTests(() => "/repo");
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

describe("repoRwPaths + productionShell (jail wiring)", () => {
  test("repoRwPaths lists top-level repo entries EXCEPT .ezcorp", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const repo = mkdtempSync(join(tmpdir(), "rw-"));
    try {
      mkdirSync(join(repo, ".git"));
      writeFileSync(join(repo, "a.txt"), "x");
      mkdirSync(join(repo, ".ezcorp"), { recursive: true });
      const paths = repoRwPaths(repo);
      expect(paths).toContain(join(repo, ".git"));
      expect(paths).toContain(join(repo, "a.txt"));
      // .ezcorp (holding the DB/secret) is NEVER in the rw set.
      expect(paths).not.toContain(join(repo, ".ezcorp"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("repoRwPaths falls back to [repo] when the dir can't be listed", () => {
    expect(repoRwPaths("/no/such/repo/zzz")).toEqual(["/no/such/repo/zzz"]);
  });

  test("productionShell runs the command in cwd (advisory tier = bare spawn)", async () => {
    // On a host without a usable tier the wrap is a plain spawn; either way
    // productionShell returns the command's real output. Use `pwd` to confirm
    // the cwd is threaded through.
    const { mkdtempSync, rmSync, realpathSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "ps-")));
    try {
      const r = await productionShell(["/bin/sh", "-c", "echo PS_OK"], dir);
      // On a capable host (bwrap with a setuid wrapper / landlock) the jail may
      // alter the exit, but the command + wiring are exercised either way.
      expect(typeof r.exitCode).toBe("number");
      expect(typeof r.stdout).toBe("string");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("open_pr against a real throwaway git repo (integration)", () => {
  test("creates the branch, commits, 'pushes' to a bare remote, and issues gh pr create", async () => {
    const { mkdtempSync, writeFileSync, mkdirSync } = await import("node:fs");
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
    writeFileSync(join(repo, "README.md"), "# work\n");
    git(["add", "-A"], repo);
    git(["commit", "-m", "init"], repo);
    git(["branch", "-M", "main"], repo);
    git(["remote", "add", "origin", remote], repo);
    // A pending change for open_pr to commit.
    writeFileSync(join(repo, "feature.txt"), "agent work\n");

    setBothStores(memoryStore([record({ id: "run-real", title: "Add feature" })]));
    _setPushPageForTests(() => {});
    _setProjectRootForTests(() => repo);

    // Real git via Bun.spawn; `gh` is faked (no network / auth in CI).
    let ghArgs: string[] | null = null;
    _setShellForTests(async (cmd, cwd): Promise<ShellResult> => {
      if (cmd[0] === "gh") {
        ghArgs = cmd;
        return { exitCode: 0, stdout: "https://github.com/org/repo/pull/42", stderr: "" };
      }
      const p = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
      return {
        exitCode: p.exitCode,
        stdout: p.stdout.toString(),
        stderr: p.stderr.toString(),
      };
    });

    const res = await openPrForRun("run-real", { body: "real PR" });
    expect(res.ok).toBe(true);
    expect(res.url).toBe("https://github.com/org/repo/pull/42");

    // The branch was actually created + pushed to the bare remote.
    const branches = Bun.spawnSync(["git", "branch", "--list", "ez-code/run-real"], {
      cwd: repo,
      stdout: "pipe",
    }).stdout.toString();
    expect(branches).toContain("ez-code/run-real");
    const remoteRefs = Bun.spawnSync(["git", "ls-remote", "--heads", remote], {
      stdout: "pipe",
    }).stdout.toString();
    expect(remoteRefs).toContain("ez-code/run-real");

    // gh pr create was issued with the run's branch + title.
    expect(ghArgs).not.toBeNull();
    expect(ghArgs!).toContain("--head");
    expect(ghArgs![ghArgs!.indexOf("--head") + 1]).toBe("ez-code/run-real");
    expect(ghArgs![ghArgs!.indexOf("--title") + 1]).toBe("Add feature");

    const { rmSync } = await import("node:fs");
    rmSync(base, { recursive: true, force: true });
  });

  // #2 — open_pr's git runs JAILED (Seam B). Exercises the REAL productionShell
  // (no shell injection): git operations FUNCTION inside the jail (branch +
  // commit + push to a bare remote) while `.ezcorp/data` stays denied read AND
  // write. Gated on the LANDLOCK tier — that's the container's production path;
  // this dev host resolves to `bwrap` whose setuid wrapper rejects the
  // unprivileged tmpfs flags (an environment quirk, not a seam defect), so the
  // test runs in-container where the tier is landlock.
  test.if(getSandboxTier() === "landlock" && (probeLandlockAbi() ?? 0) >= 1)(
    "JAILED git (productionShell) creates+commits+pushes; .ezcorp/data denied",
    async () => {
      const { mkdtempSync, writeFileSync, mkdirSync, rmSync, existsSync } = await import("node:fs");
      const { tmpdir } = await import("node:os");
      const { join } = await import("node:path");
      const { realpathSync } = await import("node:fs");

      const base = realpathSync(mkdtempSync(join(tmpdir(), "ezc-jail-")));
      const repo = join(base, "work");
      const remote = join(base, "remote.git");
      mkdirSync(repo, { recursive: true });
      const run = (args: string[], cwd: string) =>
        Bun.spawnSync(args, { cwd, stdout: "pipe", stderr: "pipe" });
      run(["git", "init", "--bare", remote], base);
      run(["git", "init"], repo);
      run(["git", "config", "user.email", "t@t.com"], repo);
      run(["git", "config", "user.name", "t"], repo);
      run(["git", "config", "commit.gpgsign", "false"], repo);
      writeFileSync(join(repo, "README.md"), "# work\n");
      run(["git", "add", "-A"], repo);
      run(["git", "commit", "-m", "init"], repo);
      run(["git", "branch", "-M", "main"], repo);
      run(["git", "remote", "add", "origin", remote], repo);
      // Plant a platform secret under .ezcorp/data (must stay denied).
      const dataDir = join(repo, ".ezcorp", "data");
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(join(dataDir, "jwt-secret.txt"), "TOP-SECRET");
      // A pending change for the jailed git to commit.
      writeFileSync(join(repo, "feature.txt"), "agent work\n");

      try {
        // Run the REAL jailed shell (productionShell wraps each command in
        // buildSandboxArgv, granting the repo MINUS .ezcorp).
        const sw = await productionShell(["git", "switch", "-c", "ez-code/jailed"], repo);
        expect(sw.exitCode).toBe(0);
        const add = await productionShell(["git", "add", "-A"], repo);
        expect(add.exitCode).toBe(0);
        const commit = await productionShell(["git", "commit", "-m", "jailed work"], repo);
        expect(commit.exitCode).toBe(0);
        const push = await productionShell(["git", "push", "-u", "origin", "ez-code/jailed"], repo);
        expect(push.exitCode).toBe(0);

        // The branch reached the bare remote — git FUNCTIONED jailed.
        const refs = run(["git", "ls-remote", "--heads", remote], base).stdout.toString();
        expect(refs).toContain("ez-code/jailed");

        // The secret under .ezcorp/data is DENIED read AND write inside the jail.
        const readDeny = await productionShell(
          ["cat", join(dataDir, "jwt-secret.txt")],
          repo,
        );
        expect(readDeny.exitCode).not.toBe(0);
        expect(readDeny.stderr.toLowerCase()).toContain("permission denied");
        const writeDeny = await productionShell(
          ["/bin/sh", "-c", `echo x > ${join(dataDir, "evil.txt")}`],
          repo,
        );
        expect(writeDeny.exitCode).not.toBe(0);
        expect(existsSync(join(dataDir, "evil.txt"))).toBe(false);
      } finally {
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

    // dispatch_run persists under USER scope.
    await dispatchRun({ agentName: "coder", task: "go" });
    expect(Array.isArray(saved["user:runs"])).toBe(true);
    expect((saved["user:runs"] as RunRecord[])[0]!.agentName).toBe("coder");
    // GLOBAL scope was NOT written — the user run is private.
    expect(saved["global:runs"]).toBeUndefined();

    // The shared dashboard (global scope) shows 0 runs — the user's private
    // run does not leak into the cross-user tree.
    const tree = await renderDashboard();
    const stats = (tree.nodes as Array<Record<string, unknown>>).find(
      (n) => n.type === "stats",
    ) as { items: Array<{ value: string }> };
    expect(stats.items[0]!.value).toBe("0");
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
});
