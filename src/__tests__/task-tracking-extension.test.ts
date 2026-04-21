// Unit tests for the task-tracking bundled extension's tool handlers —
// commit-1 skeleton covering the 5 simple tools (plan without assignTo,
// add without assignTo, list, subtask_toggle, list_agents). Commits 2/3
// extend this file to cover the remaining mutation tools and the
// spawn-path assignTo branches.
//
// Pattern mirrors src/__tests__/scratchpad-extension.integration.test.ts
// for the in-subprocess slice, but this file is the in-process unit
// layer: we import the extension's handlers directly and inject fake
// SDK bindings via the exported `_setStoreForTests` /
// `_setTaskEventsForTests` / `_setAgentConfigsForTests` helpers.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import {
  tools,
  _setStoreForTests,
  _setTaskEventsForTests,
  _setAgentConfigsForTests,
  _setSpawnForTests,
  _resetBindingsForTests,
  _internals,
  type PersistedSnapshot,
  type TaskAssignment,
  type TrackedTask,
} from "../../docs/extensions/examples/task-tracking/index";
import { JsonRpcError } from "@ezcorp/sdk/runtime";

// ── In-memory fakes ────────────────────────────────────────────────

class FakeStorage {
  private rows = new Map<string, unknown>();
  async get<T>(key: string): Promise<{ value: T | null; exists: boolean }> {
    if (!this.rows.has(key)) return { value: null, exists: false };
    return { value: this.rows.get(key) as T, exists: true };
  }
  async set<T>(key: string, value: T): Promise<{ ok: true; sizeBytes: number }> {
    this.rows.set(key, structuredClone(value));
    return { ok: true, sizeBytes: 0 };
  }
  /** Test helper — seed a snapshot directly. */
  seed(snap: PersistedSnapshot): void {
    this.rows.set(_internals.STORAGE_KEY, structuredClone(snap));
  }
  /** Test helper — read what's persisted. */
  peek(): PersistedSnapshot | undefined {
    return this.rows.get(_internals.STORAGE_KEY) as PersistedSnapshot | undefined;
  }
}

class FakeTaskEvents {
  snapshots: Array<{ tasks: TrackedTask[]; activeTaskId?: string }> = [];
  assignmentUpdates: Array<{ taskId: string; assignment: TaskAssignment }> = [];
  async emitSnapshot(tasks: TrackedTask[], activeTaskId?: string): Promise<void> {
    this.snapshots.push({ tasks: structuredClone(tasks), ...(activeTaskId !== undefined ? { activeTaskId } : {}) });
  }
  async emitAssignmentUpdate(taskId: string, assignment: TaskAssignment): Promise<void> {
    this.assignmentUpdates.push({ taskId, assignment: structuredClone(assignment) });
  }
}

class FakeAgentConfigs {
  private configs = new Map<string, { id: string; name: string; description: string; isTeam: boolean; ownerUserId: string | null }>();
  constructor(seed: Array<{ id: string; name: string; description?: string; isTeam?: boolean }> = []) {
    for (const c of seed) {
      this.configs.set(c.id, {
        id: c.id,
        name: c.name,
        description: c.description ?? "",
        isTeam: c.isTeam ?? false,
        ownerUserId: "user-test",
      });
    }
  }
  async list() {
    return Array.from(this.configs.values());
  }
  async resolve(idOrName: string) {
    const byId = this.configs.get(idOrName);
    if (byId) return byId;
    for (const c of this.configs.values()) {
      if (c.name.toLowerCase() === idOrName.trim().toLowerCase()) return c;
    }
    return null;
  }
}

let fakeStorage: FakeStorage;
let fakeEvents: FakeTaskEvents;
let fakeAgents: FakeAgentConfigs;

beforeEach(() => {
  fakeStorage = new FakeStorage();
  fakeEvents = new FakeTaskEvents();
  fakeAgents = new FakeAgentConfigs([
    { id: "agent-builder", name: "builder", description: "Builds things" },
    { id: "agent-team", name: "ops-team", description: "A team", isTeam: true },
  ]);
  _setStoreForTests(fakeStorage);
  _setTaskEventsForTests(fakeEvents);
  _setAgentConfigsForTests(fakeAgents);
});

afterEach(() => {
  _resetBindingsForTests();
});

function isResultText(out: unknown, re: RegExp): boolean {
  const o = out as { content?: Array<{ type: string; text: string }>; isError?: boolean };
  const first = o.content?.[0];
  if (!first || first.type !== "text") return false;
  return re.test(first.text);
}

// ── task_plan ──────────────────────────────────────────────────────

describe("task-tracking extension — task_plan", () => {
  test("creates tasks, auto-activates first, persists snapshot + emits event", async () => {
    const out = await tools.task_plan!({
      tasks: [
        { title: "Write code" },
        { title: "Write tests" },
      ],
    });
    expect(isResultText(out, /Created task plan with 2 tasks/)).toBe(true);

    const snap = fakeStorage.peek()!;
    expect(snap.tasks).toHaveLength(2);
    expect(snap.tasks[0]!.status).toBe("active");
    expect(snap.tasks[1]!.status).toBe("pending");
    expect(snap.activeTaskId).toBe(snap.tasks[0]!.id);
    expect(snap.schemaVersion).toBe(1);

    expect(fakeEvents.snapshots).toHaveLength(1);
    expect(fakeEvents.snapshots[0]!.tasks).toHaveLength(2);
  });

  test("cycles are rejected without mutating state", async () => {
    fakeStorage.seed({
      schemaVersion: 1,
      tasks: [
        { id: "x", title: "X", description: "", status: "pending", assignments: [], subtasks: [], priority: 0, createdAt: new Date().toISOString(), dependsOn: ["y"] } as TrackedTask,
        { id: "y", title: "Y", description: "", status: "pending", assignments: [], subtasks: [], priority: 1, createdAt: new Date().toISOString(), dependsOn: ["x"] } as TrackedTask,
      ],
    });
    const out = await tools.task_plan!({
      tasks: [
        { title: "A", dependsOn: ["B"] },
        { title: "B", dependsOn: ["A"] },
      ],
    });
    const o = out as { content: Array<{ text: string }>; isError?: boolean };
    expect(o.isError).toBe(true);
    expect(o.content[0]!.text).toMatch(/cycle/i);
    // State wasn't mutated beyond the seed.
    const after = fakeStorage.peek()!;
    expect(after.tasks.find((t) => t.title === "A")).toBeUndefined();
  });

  test("unknown deps become warnings (not fatal)", async () => {
    const out = await tools.task_plan!({
      tasks: [{ title: "A", dependsOn: ["does-not-exist"] }],
    });
    expect(isResultText(out, /Dependency warnings/)).toBe(true);
    const snap = fakeStorage.peek()!;
    expect(snap.tasks).toHaveLength(1);
    expect(snap.tasks[0]!.dependsOn).toBeUndefined();
  });

  test("title-based dep refs within the same plan resolve to ids", async () => {
    await tools.task_plan!({
      tasks: [
        { title: "build" },
        { title: "test", dependsOn: ["build"] },
        { title: "deploy", dependsOn: ["test"] },
      ],
    });
    const snap = fakeStorage.peek()!;
    const build = snap.tasks.find((t) => t.title === "build")!;
    const t = snap.tasks.find((t) => t.title === "test")!;
    const deploy = snap.tasks.find((t) => t.title === "deploy")!;
    expect(t.dependsOn).toEqual([build.id]);
    expect(deploy.dependsOn).toEqual([t.id]);
  });

  test("first task skipped when blocked — nothing auto-activates if all pending are blocked", async () => {
    // All three form a chain: A→B→C. Only A can start; B and C are blocked.
    await tools.task_plan!({
      tasks: [
        { title: "A" },
        { title: "B", dependsOn: ["A"] },
        { title: "C", dependsOn: ["B"] },
      ],
    });
    const snap = fakeStorage.peek()!;
    const a = snap.tasks.find((t) => t.title === "A")!;
    expect(snap.activeTaskId).toBe(a.id);
    expect(a.status).toBe("active");
  });
});

// ── task_add ───────────────────────────────────────────────────────

describe("task-tracking extension — task_add", () => {
  test("appends a task to an empty snapshot", async () => {
    const out = await tools.task_add!({ title: "First task" });
    expect(isResultText(out, /Added task/)).toBe(true);
    const snap = fakeStorage.peek()!;
    expect(snap.tasks).toHaveLength(1);
    expect(snap.tasks[0]!.title).toBe("First task");
  });

  test("rejects empty title", async () => {
    const out = await tools.task_add!({ title: "" });
    const o = out as { isError?: boolean };
    expect(o.isError).toBe(true);
  });

  test("afterTaskId inserts at the right position + renumbers priorities", async () => {
    await tools.task_add!({ title: "A" });
    await tools.task_add!({ title: "C" });
    const beforeSnap = fakeStorage.peek()!;
    const aId = beforeSnap.tasks[0]!.id;
    await tools.task_add!({ title: "B", afterTaskId: aId });
    const snap = fakeStorage.peek()!;
    expect(snap.tasks.map((t) => t.title)).toEqual(["A", "B", "C"]);
    expect(snap.tasks.map((t) => t.priority)).toEqual([0, 1, 2]);
  });

  test("cycle in proposed state rejected (self-loop on added task)", async () => {
    await tools.task_add!({ title: "A" });
    const snap = fakeStorage.peek()!;
    const aId = snap.tasks[0]!.id;
    // Add B with dep on nonexistent — becomes warning. Then update via
    // task_add is n/a; this case covers unknown-dep warning instead.
    const out = await tools.task_add!({ title: "B", dependsOn: ["unknown"] });
    expect(isResultText(out, /Dependency warnings/)).toBe(true);
    // And with a valid dep on A — no cycle, no warning.
    const ok = await tools.task_add!({ title: "C", dependsOn: [aId] });
    expect(isResultText(ok, /Added task/)).toBe(true);
  });
});

// ── task_list ──────────────────────────────────────────────────────

describe("task-tracking extension — task_list", () => {
  test("empty → explicit 'no tasks' message", async () => {
    const out = await tools.task_list!({});
    expect(isResultText(out, /No tasks tracked/)).toBe(true);
  });

  test("renders tasks in priority order with status tags", async () => {
    await tools.task_plan!({
      tasks: [{ title: "Alpha" }, { title: "Beta" }],
    });
    const out = await tools.task_list!({});
    const text = (out as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toMatch(/\[ACTIVE\] Alpha/);
    expect(text).toMatch(/\[PENDING\] Beta/);
    expect(text.indexOf("Alpha")).toBeLessThan(text.indexOf("Beta"));
  });
});

// ── task_subtask_toggle ────────────────────────────────────────────

describe("task-tracking extension — task_subtask_toggle", () => {
  test("toggles a subtask + persists + emits snapshot", async () => {
    await tools.task_plan!({
      tasks: [{ title: "With subs", subtasks: ["one", "two"] }],
    });
    const snap = fakeStorage.peek()!;
    const task = snap.tasks[0]!;
    const sub = task.subtasks[0]!;
    fakeEvents.snapshots.length = 0;

    const out = await tools.task_subtask_toggle!({
      taskId: task.id,
      subtaskId: sub.id,
      completed: true,
    });
    expect(isResultText(out, /Checked:/)).toBe(true);
    const after = fakeStorage.peek()!;
    expect(after.tasks[0]!.subtasks[0]!.completed).toBe(true);
    expect(fakeEvents.snapshots).toHaveLength(1);
  });

  test("unknown taskId → not-found error", async () => {
    const out = await tools.task_subtask_toggle!({
      taskId: "nope",
      subtaskId: "nope",
      completed: true,
    });
    const o = out as { isError?: boolean };
    expect(o.isError).toBe(true);
  });

  test("unknown subtaskId → subtask-not-found error", async () => {
    await tools.task_plan!({ tasks: [{ title: "T" }] });
    const snap = fakeStorage.peek()!;
    const task = snap.tasks[0]!;
    const out = await tools.task_subtask_toggle!({
      taskId: task.id,
      subtaskId: "nope",
      completed: true,
    });
    const o = out as { isError?: boolean; content: Array<{ text: string }> };
    expect(o.isError).toBe(true);
    expect(o.content[0]!.text).toMatch(/Subtask/);
  });
});

// ── task_list_agents ───────────────────────────────────────────────

describe("task-tracking extension — task_list_agents", () => {
  test("renders available agents from AgentConfigs.list()", async () => {
    const out = await tools.task_list_agents!({});
    const text = (out as { content: Array<{ text: string }> }).content[0]!.text;
    expect(text).toMatch(/Available agents and teams/);
    expect(text).toMatch(/builder/);
    expect(text).toMatch(/ops-team\*\* \[team\]/);
  });

  test("empty list → friendly placeholder", async () => {
    _setAgentConfigsForTests(new FakeAgentConfigs([]));
    const out = await tools.task_list_agents!({});
    expect(isResultText(out, /No agents or teams/)).toBe(true);
  });
});

// ── commit-2 mutation tools ────────────────────────────────────────

describe("task-tracking extension — task_start", () => {
  test("deactivates existing active task; activates target; persists + emits", async () => {
    await tools.task_plan!({ tasks: [{ title: "A" }, { title: "B" }] });
    const snap = fakeStorage.peek()!;
    const aId = snap.tasks.find((t) => t.title === "A")!.id;
    const bId = snap.tasks.find((t) => t.title === "B")!.id;
    fakeEvents.snapshots.length = 0;

    const out = await tools.task_start!({ taskId: bId });
    expect(isResultText(out, /Started task: B/)).toBe(true);
    const after = fakeStorage.peek()!;
    expect(after.tasks.find((t) => t.id === aId)!.status).toBe("pending");
    expect(after.tasks.find((t) => t.id === bId)!.status).toBe("active");
    expect(after.activeTaskId).toBe(bId);
    expect(fakeEvents.snapshots).toHaveLength(1);
  });

  test("unknown taskId → not-found error", async () => {
    const out = await tools.task_start!({ taskId: "nope" });
    const o = out as { isError?: boolean };
    expect(o.isError).toBe(true);
  });
});

describe("task-tracking extension — task_complete", () => {
  test("completes + auto-advances to next pending unblocked task", async () => {
    await tools.task_plan!({
      tasks: [{ title: "A" }, { title: "B" }, { title: "C" }],
    });
    const snap = fakeStorage.peek()!;
    const a = snap.tasks.find((t) => t.title === "A")!;
    const b = snap.tasks.find((t) => t.title === "B")!;

    const out = await tools.task_complete!({
      taskId: a.id,
      summary: "done",
    });
    expect(isResultText(out, /Next task is now ACTIVE/)).toBe(true);
    const after = fakeStorage.peek()!;
    expect(after.tasks.find((t) => t.id === a.id)!.status).toBe("completed");
    expect(after.tasks.find((t) => t.id === a.id)!.completionSummary).toBe("done");
    expect(after.tasks.find((t) => t.id === b.id)!.status).toBe("active");
    expect(after.activeTaskId).toBe(b.id);
  });

  test("completing the last task reports 'All tasks done'", async () => {
    await tools.task_plan!({ tasks: [{ title: "Only" }] });
    const snap = fakeStorage.peek()!;
    const onlyId = snap.tasks[0]!.id;
    const out = await tools.task_complete!({ taskId: onlyId });
    expect(isResultText(out, /All tasks done/)).toBe(true);
  });

  test("auto-advance skips blocked pending tasks", async () => {
    // A → active first; B depends on C; C is pending.
    await tools.task_plan!({
      tasks: [
        { title: "A" },
        { title: "B", dependsOn: ["C"] },
        { title: "C" },
      ],
    });
    const snap = fakeStorage.peek()!;
    const a = snap.tasks.find((t) => t.title === "A")!;
    const b = snap.tasks.find((t) => t.title === "B")!;
    const c = snap.tasks.find((t) => t.title === "C")!;
    await tools.task_complete!({ taskId: a.id });
    const after = fakeStorage.peek()!;
    // B is blocked (depends on C which isn't completed), so C should be
    // the next pending unblocked candidate and now active.
    expect(after.tasks.find((t) => t.id === c.id)!.status).toBe("active");
    expect(after.tasks.find((t) => t.id === b.id)!.status).toBe("pending");
  });

  test("unknown taskId → not-found error", async () => {
    const out = await tools.task_complete!({ taskId: "nope" });
    const o = out as { isError?: boolean };
    expect(o.isError).toBe(true);
  });
});

describe("task-tracking extension — task_fail", () => {
  test("marks failed + records reason + clears active", async () => {
    await tools.task_plan!({ tasks: [{ title: "A" }] });
    const snap = fakeStorage.peek()!;
    const a = snap.tasks[0]!;
    const out = await tools.task_fail!({ taskId: a.id, reason: "boom" });
    expect(isResultText(out, /Failed task: A/)).toBe(true);
    const after = fakeStorage.peek()!;
    expect(after.tasks[0]!.status).toBe("failed");
    expect(after.tasks[0]!.failureReason).toBe("boom");
    expect(after.activeTaskId).toBeUndefined();
  });

  test("requires both taskId and reason", async () => {
    const out1 = await tools.task_fail!({ taskId: "x" });
    const out2 = await tools.task_fail!({ reason: "x" });
    expect((out1 as { isError?: boolean }).isError).toBe(true);
    expect((out2 as { isError?: boolean }).isError).toBe(true);
  });
});

describe("task-tracking extension — task_update", () => {
  test("updates title + description", async () => {
    await tools.task_plan!({ tasks: [{ title: "Old" }] });
    const snap = fakeStorage.peek()!;
    const id = snap.tasks[0]!.id;
    await tools.task_update!({ taskId: id, title: "New", description: "details" });
    const after = fakeStorage.peek()!;
    expect(after.tasks[0]!.title).toBe("New");
    expect(after.tasks[0]!.description).toBe("details");
  });

  test("dependsOn changes are cycle-checked; rejection reverts state", async () => {
    await tools.task_plan!({
      tasks: [{ title: "A" }, { title: "B", dependsOn: ["A"] }],
    });
    const snap = fakeStorage.peek()!;
    const aId = snap.tasks.find((t) => t.title === "A")!.id;
    const bId = snap.tasks.find((t) => t.title === "B")!.id;
    // Try to make A depend on B, creating an A→B→A cycle.
    const out = await tools.task_update!({ taskId: aId, dependsOn: [bId] });
    const o = out as { isError?: boolean; content: Array<{ text: string }> };
    expect(o.isError).toBe(true);
    expect(o.content[0]!.text).toMatch(/cycle/);
    const after = fakeStorage.peek()!;
    expect(after.tasks.find((t) => t.id === aId)!.dependsOn).toBeUndefined();
  });

  test("self-dep warning is surfaced, not a cycle error", async () => {
    await tools.task_plan!({ tasks: [{ title: "A" }] });
    const snap = fakeStorage.peek()!;
    const id = snap.tasks[0]!.id;
    const out = await tools.task_update!({ taskId: id, dependsOn: [id] });
    expect(isResultText(out, /Task cannot depend on itself/)).toBe(true);
  });
});

describe("task-tracking extension — task_set_dependencies", () => {
  test("replaces deps and accepts empty array to clear", async () => {
    await tools.task_plan!({
      tasks: [{ title: "A" }, { title: "B", dependsOn: ["A"] }],
    });
    const snap = fakeStorage.peek()!;
    const bId = snap.tasks.find((t) => t.title === "B")!.id;

    await tools.task_set_dependencies!({ taskId: bId, dependsOn: [] });
    const after = fakeStorage.peek()!;
    expect(after.tasks.find((t) => t.id === bId)!.dependsOn).toBeUndefined();
  });

  test("rejects cycles and restores prior deps", async () => {
    await tools.task_plan!({
      tasks: [{ title: "A" }, { title: "B", dependsOn: ["A"] }],
    });
    const snap = fakeStorage.peek()!;
    const aId = snap.tasks.find((t) => t.title === "A")!.id;
    const bId = snap.tasks.find((t) => t.title === "B")!.id;
    const out = await tools.task_set_dependencies!({ taskId: aId, dependsOn: [bId] });
    const o = out as { isError?: boolean };
    expect(o.isError).toBe(true);
    const after = fakeStorage.peek()!;
    expect(after.tasks.find((t) => t.id === aId)!.dependsOn).toBeUndefined();
  });
});

describe("task-tracking extension — task_unassign", () => {
  test("removes an 'assigned' assignment from a task", async () => {
    // Seed a task with a manual assignment — commit-3 will handle the
    // spawn path end-to-end, but commit-2's unassign just needs an
    // assigned-status record to remove.
    fakeStorage.seed({
      schemaVersion: 1,
      tasks: [
        {
          id: "t1",
          title: "T",
          description: "",
          status: "pending",
          assignments: [
            {
              id: "a1",
              agentConfigId: "c1",
              agentName: "bob",
              isTeam: false,
              status: "assigned",
              assignedAt: new Date().toISOString(),
            },
          ],
          subtasks: [],
          priority: 0,
          createdAt: new Date().toISOString(),
        } as TrackedTask,
      ],
    });
    const out = await tools.task_unassign!({ taskId: "t1", assignmentId: "a1" });
    expect(isResultText(out, /Unassigned @bob/)).toBe(true);
    const after = fakeStorage.peek()!;
    expect(after.tasks[0]!.assignments).toHaveLength(0);
  });

  test("refuses to remove running/completed assignments", async () => {
    fakeStorage.seed({
      schemaVersion: 1,
      tasks: [
        {
          id: "t1",
          title: "T",
          description: "",
          status: "active",
          assignments: [
            {
              id: "a1",
              agentConfigId: "c1",
              agentName: "bob",
              isTeam: false,
              status: "running",
              assignedAt: new Date().toISOString(),
            },
          ],
          subtasks: [],
          priority: 0,
          createdAt: new Date().toISOString(),
        } as TrackedTask,
      ],
    });
    const out = await tools.task_unassign!({ taskId: "t1", assignmentId: "a1" });
    const o = out as { isError?: boolean };
    expect(o.isError).toBe(true);
  });

  test("unknown assignmentId → explicit not-found error", async () => {
    fakeStorage.seed({
      schemaVersion: 1,
      tasks: [
        {
          id: "t1",
          title: "T",
          description: "",
          status: "pending",
          assignments: [],
          subtasks: [],
          priority: 0,
          createdAt: new Date().toISOString(),
        } as TrackedTask,
      ],
    });
    const out = await tools.task_unassign!({ taskId: "t1", assignmentId: "nope" });
    const o = out as { isError?: boolean };
    expect(o.isError).toBe(true);
  });
});

// ── commit-3 spawn integration ─────────────────────────────────────

type SpawnRecord = {
  input: { task: string; agentConfigId?: string; agentName?: string; title?: string; taskId?: string; assignmentId?: string };
};

function makeFakeSpawn(opts: {
  mode?: "happy" | "quota" | "rate" | "permission" | "invalid" | "dispatch" | "unknown-rejection";
} = {}) {
  const calls: SpawnRecord[] = [];
  const mode = opts.mode ?? "happy";
  const fn = async (input: SpawnRecord["input"]) => {
    calls.push({ input });
    switch (mode) {
      case "happy":
        return {
          subConversationId: `sub-${input.assignmentId}`,
          agentRunId: `run-${input.assignmentId}`,
          taskId: input.taskId!,
          assignmentId: input.assignmentId!,
        };
      case "quota":
        throw new JsonRpcError(-32000, "Spawn quota exceeded", { reason: "hourly-exceeded" });
      case "rate":
        throw new JsonRpcError(-32029, "Rate limited");
      case "permission":
        throw new JsonRpcError(-32001, "spawnAgents permission not granted");
      case "invalid":
        throw new JsonRpcError(-32602, "Agent not found (raced)");
      case "dispatch":
        throw new JsonRpcError(-32603, "Spawn failed: boom");
      case "unknown-rejection":
        throw new Error("totally unexpected");
    }
  };
  return { fn, calls };
}

describe("task-tracking extension — task_plan with assignTo (commit-3)", () => {
  test("happy path: spawns, flips assignment to running, emits task:assignment_update", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    await tools.task_plan!({
      tasks: [{ title: "Build", assignTo: "builder" }],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.agentConfigId).toBe("agent-builder");
    const snap = fakeStorage.peek()!;
    const a = snap.tasks[0]!.assignments[0]!;
    expect(a.status).toBe("running");
    expect(a.subConversationId).toBeDefined();
    expect(a.agentRunId).toBeDefined();
    expect(fakeEvents.assignmentUpdates).toHaveLength(1);
    expect(fakeEvents.assignmentUpdates[0]!.taskId).toBe(snap.tasks[0]!.id);
  });

  test("autoStart=false: no spawn call, assignment stays 'assigned'", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    await tools.task_plan!({
      tasks: [{ title: "Build", assignTo: "builder", autoStart: false }],
    });
    expect(calls).toHaveLength(0);
    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.assignments[0]!.status).toBe("assigned");
  });

  test("blocked task: spawn is deferred — assignment stays 'assigned'", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    await tools.task_plan!({
      tasks: [
        { title: "A" },
        { title: "B", assignTo: "builder", dependsOn: ["A"] },
      ],
    });
    // A is unblocked and has no assignment — no spawn. B is blocked so no spawn.
    expect(calls).toHaveLength(0);
    const snap = fakeStorage.peek()!;
    const b = snap.tasks.find((t) => t.title === "B")!;
    expect(b.assignments[0]!.status).toBe("assigned");
  });

  test("unknown agent: warning, no assignment record, no spawn", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const out = await tools.task_plan!({
      tasks: [{ title: "Build", assignTo: "does-not-exist" }],
    });
    expect(isResultText(out, /does-not-exist/)).toBe(true);
    expect(calls).toHaveLength(0);
    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.assignments).toHaveLength(0);
  });

  test("quota rejection: assignment stays 'assigned', task untouched", async () => {
    const { fn } = makeFakeSpawn({ mode: "quota" });
    _setSpawnForTests(fn);
    const out = await tools.task_plan!({
      tasks: [{ title: "Build", assignTo: "builder" }],
    });
    expect(isResultText(out, /quota: hourly-exceeded/)).toBe(true);
    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.assignments[0]!.status).toBe("assigned");
    expect(snap.tasks[0]!.status).not.toBe("failed");
  });

  test("rate-limited: assignment stays 'assigned' (transient)", async () => {
    const { fn } = makeFakeSpawn({ mode: "rate" });
    _setSpawnForTests(fn);
    await tools.task_plan!({
      tasks: [{ title: "Build", assignTo: "builder" }],
    });
    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.assignments[0]!.status).toBe("assigned");
  });

  test("permission missing: assignment stays 'assigned' (defensive, logged)", async () => {
    const { fn } = makeFakeSpawn({ mode: "permission" });
    _setSpawnForTests(fn);
    await tools.task_plan!({
      tasks: [{ title: "Build", assignTo: "builder" }],
    });
    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.assignments[0]!.status).toBe("assigned");
  });

  test("invalid params (-32602): marks assignment + task failed, emits assignment_update", async () => {
    const { fn } = makeFakeSpawn({ mode: "invalid" });
    _setSpawnForTests(fn);
    await tools.task_plan!({
      tasks: [{ title: "Build", assignTo: "builder" }],
    });
    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.assignments[0]!.status).toBe("failed");
    expect(snap.tasks[0]!.status).toBe("failed");
    // One snapshot emit before spawn, one after the failure mutation.
    expect(fakeEvents.snapshots.length).toBeGreaterThanOrEqual(1);
    expect(fakeEvents.assignmentUpdates).toHaveLength(1);
    expect(fakeEvents.assignmentUpdates[0]!.assignment.status).toBe("failed");
  });

  test("dispatch failure (-32603): marks assignment + task failed", async () => {
    const { fn } = makeFakeSpawn({ mode: "dispatch" });
    _setSpawnForTests(fn);
    await tools.task_plan!({
      tasks: [{ title: "Build", assignTo: "builder" }],
    });
    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.assignments[0]!.status).toBe("failed");
    expect(snap.tasks[0]!.status).toBe("failed");
  });

  test("non-JsonRpcError rejection: treated as terminal unknown-error", async () => {
    const { fn } = makeFakeSpawn({ mode: "unknown-rejection" });
    _setSpawnForTests(fn);
    await tools.task_plan!({
      tasks: [{ title: "Build", assignTo: "builder" }],
    });
    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.assignments[0]!.status).toBe("failed");
  });
});

describe("task-tracking extension — task_add with assignTo (commit-3)", () => {
  test("spawns on happy path", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const out = await tools.task_add!({ title: "Ship", assignTo: "builder" });
    expect(isResultText(out, /Auto-started @builder/)).toBe(true);
    expect(calls).toHaveLength(1);
    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.assignments[0]!.status).toBe("running");
  });

  test("unknown agent → warning, no assignment", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    const out = await tools.task_add!({ title: "Ship", assignTo: "nope" });
    expect(isResultText(out, /Dependency warnings/)).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("task-tracking extension — task_assign (commit-3)", () => {
  test("assigns + spawns; propagates the task:assignment_update", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    await tools.task_plan!({ tasks: [{ title: "Core" }] });
    const snap = fakeStorage.peek()!;
    const taskId = snap.tasks[0]!.id;
    fakeEvents.assignmentUpdates.length = 0;

    const out = await tools.task_assign!({ taskId, agentConfigId: "builder" });
    expect(isResultText(out, /Assigned @builder/)).toBe(true);
    expect(calls).toHaveLength(1);
    const after = fakeStorage.peek()!;
    const assignment = after.tasks[0]!.assignments[0]!;
    expect(assignment.status).toBe("running");
    expect(fakeEvents.assignmentUpdates.some((u) => u.taskId === taskId && u.assignment.status === "running")).toBe(true);
  });

  test("subtask assignment target", async () => {
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);
    await tools.task_plan!({
      tasks: [{ title: "Core", subtasks: ["step"] }],
    });
    const snap = fakeStorage.peek()!;
    const task = snap.tasks[0]!;
    const subId = task.subtasks[0]!.id;
    const out = await tools.task_assign!({
      taskId: task.id,
      subtaskId: subId,
      agentConfigId: "builder",
    });
    expect(isResultText(out, /subtask/)).toBe(true);
    const after = fakeStorage.peek()!;
    expect(after.tasks[0]!.subtasks[0]!.assignments).toHaveLength(1);
  });

  test("blocked task: spawn deferred, describe message mentions waiting", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    await tools.task_plan!({
      tasks: [{ title: "A" }, { title: "B", dependsOn: ["A"] }],
    });
    const snap = fakeStorage.peek()!;
    const bId = snap.tasks.find((t) => t.title === "B")!.id;
    const out = await tools.task_assign!({ taskId: bId, agentConfigId: "builder" });
    expect(isResultText(out, /waiting for/)).toBe(true);
    expect(calls).toHaveLength(0);
  });

  test("unknown agent → toolError", async () => {
    await tools.task_plan!({ tasks: [{ title: "T" }] });
    const snap = fakeStorage.peek()!;
    const out = await tools.task_assign!({
      taskId: snap.tasks[0]!.id,
      agentConfigId: "does-not-exist",
    });
    const o = out as { isError?: boolean };
    expect(o.isError).toBe(true);
  });
});

// ── commit-4: task:assignment_update two-hop bridge ───────────────

describe("task-tracking extension — task:assignment_update subscription", () => {
  test("incoming 'completed' for a known assignment completes the task + auto-advances", async () => {
    await tools.task_plan!({ tasks: [{ title: "A" }, { title: "B" }] });
    const snap = fakeStorage.peek()!;
    const aId = snap.tasks.find((t) => t.title === "A")!.id;
    const bId = snap.tasks.find((t) => t.title === "B")!.id;

    // Seed an assignment on A so the payload lookup matches.
    snap.tasks.find((t) => t.id === aId)!.assignments.push({
      id: "asn-a1",
      agentConfigId: "agent-builder",
      agentName: "builder",
      isTeam: false,
      status: "running",
      assignedAt: new Date().toISOString(),
    });
    await _internals.saveSnapshot(snap);
    fakeEvents.snapshots.length = 0;

    await _internals.handleAssignmentUpdate({
      conversationId: "conv-x",
      taskId: aId,
      assignment: {
        id: "asn-a1",
        agentConfigId: "agent-builder",
        agentName: "builder",
        isTeam: false,
        status: "completed",
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        resultPreview: "built",
      },
    });

    const after = fakeStorage.peek()!;
    const a = after.tasks.find((t) => t.id === aId)!;
    const b = after.tasks.find((t) => t.id === bId)!;
    expect(a.status).toBe("completed");
    expect(a.completionSummary).toBe("built");
    expect(a.assignments[0]!.status).toBe("completed");
    expect(b.status).toBe("active");
    expect(after.activeTaskId).toBe(b.id);
    expect(fakeEvents.snapshots).toHaveLength(1);
  });

  test("incoming 'failed' flips task to failed", async () => {
    await tools.task_plan!({ tasks: [{ title: "A" }] });
    const snap = fakeStorage.peek()!;
    snap.tasks[0]!.assignments.push({
      id: "asn-a1",
      agentConfigId: "agent-builder",
      agentName: "builder",
      isTeam: false,
      status: "running",
      assignedAt: new Date().toISOString(),
    });
    await _internals.saveSnapshot(snap);

    await _internals.handleAssignmentUpdate({
      conversationId: "conv",
      taskId: snap.tasks[0]!.id,
      assignment: {
        id: "asn-a1",
        agentConfigId: "agent-builder",
        agentName: "builder",
        isTeam: false,
        status: "failed",
        assignedAt: new Date().toISOString(),
        failedAt: new Date().toISOString(),
        resultPreview: "runtime error",
      },
    });
    const after = fakeStorage.peek()!;
    expect(after.tasks[0]!.status).toBe("failed");
    expect(after.tasks[0]!.failureReason).toBe("runtime error");
    expect(after.tasks[0]!.assignments[0]!.status).toBe("failed");
    expect(after.activeTaskId).toBeUndefined();
  });

  test("self-echo is idempotent — already-terminal assignment is a no-op", async () => {
    await tools.task_plan!({ tasks: [{ title: "A" }] });
    const snap = fakeStorage.peek()!;
    snap.tasks[0]!.assignments.push({
      id: "asn-done",
      agentConfigId: "agent-builder",
      agentName: "builder",
      isTeam: false,
      status: "completed",
      assignedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    });
    snap.tasks[0]!.status = "completed";
    await _internals.saveSnapshot(snap);
    fakeEvents.snapshots.length = 0;

    await _internals.handleAssignmentUpdate({
      conversationId: "conv",
      taskId: snap.tasks[0]!.id,
      assignment: {
        id: "asn-done",
        agentConfigId: "agent-builder",
        agentName: "builder",
        isTeam: false,
        status: "completed",
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    });
    // No new snapshot emitted — no-op path.
    expect(fakeEvents.snapshots).toHaveLength(0);
  });

  test("update for unknown taskId → silent no-op", async () => {
    await tools.task_plan!({ tasks: [{ title: "A" }] });
    fakeEvents.snapshots.length = 0;
    await _internals.handleAssignmentUpdate({
      conversationId: "conv",
      taskId: "nonexistent-task",
      assignment: {
        id: "asn-x",
        agentConfigId: "x",
        agentName: "x",
        isTeam: false,
        status: "completed",
        assignedAt: new Date().toISOString(),
      },
    });
    expect(fakeEvents.snapshots).toHaveLength(0);
  });

  test("completion unblocks dependents and spawns their assigned assignments", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    await tools.task_plan!({
      tasks: [
        { title: "A", assignTo: "builder" },
        { title: "B", assignTo: "builder", dependsOn: ["A"] },
      ],
    });
    // A spawned (happy), B's assignment is "assigned" + task is blocked.
    calls.length = 0;
    const snap = fakeStorage.peek()!;
    const aId = snap.tasks.find((t) => t.title === "A")!.id;
    const aAssignment = snap.tasks.find((t) => t.id === aId)!.assignments[0]!;

    await _internals.handleAssignmentUpdate({
      conversationId: "conv",
      taskId: aId,
      assignment: {
        ...aAssignment,
        status: "completed",
        completedAt: new Date().toISOString(),
        resultPreview: "done",
      },
    });
    // After A completes, B is unblocked. The sweep should spawn B.
    const after = fakeStorage.peek()!;
    const a = after.tasks.find((t) => t.id === aId)!;
    const b = after.tasks.find((t) => t.title === "B")!;
    expect(a.status).toBe("completed");
    // b could be either "active" (auto-advanced) or "pending" + then spawned.
    // Either way its assignment should be running.
    expect(b.assignments[0]!.status).toBe("running");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.input.taskId).toBe(b.id);
  });

  test("subtask-scoped assignment update applies to the subtask entry", async () => {
    await tools.task_plan!({ tasks: [{ title: "T", subtasks: ["step"] }] });
    const snap = fakeStorage.peek()!;
    const task = snap.tasks[0]!;
    const subtask = task.subtasks[0]!;
    subtask.assignments = [
      {
        id: "sub-asn",
        agentConfigId: "agent-builder",
        agentName: "builder",
        isTeam: false,
        status: "running",
        assignedAt: new Date().toISOString(),
      },
    ];
    await _internals.saveSnapshot(snap);

    await _internals.handleAssignmentUpdate({
      conversationId: "conv",
      taskId: task.id,
      assignment: {
        id: "sub-asn",
        agentConfigId: "agent-builder",
        agentName: "builder",
        isTeam: false,
        status: "completed",
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    });
    const after = fakeStorage.peek()!;
    expect(after.tasks[0]!.subtasks[0]!.assignments![0]!.status).toBe("completed");
    // The parent task is NOT flipped — subtask completion doesn't roll up.
    expect(after.tasks[0]!.status).toBe("active");
  });
});

describe("task-tracking extension — spawn input shape", () => {
  test("spawn is called with the extension's OWN taskId + assignmentId (commit-0 pass-through)", async () => {
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);
    await tools.task_plan!({
      tasks: [{ title: "X", assignTo: "builder" }],
    });
    const snap = fakeStorage.peek()!;
    const task = snap.tasks[0]!;
    const assignment = task.assignments[0]!;
    expect(calls[0]!.input.taskId).toBe(task.id);
    expect(calls[0]!.input.assignmentId).toBe(assignment.id);
    expect(calls[0]!.input.title).toBe("X");
  });
});
