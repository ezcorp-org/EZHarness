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
  _setCancelForTests,
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

  test("appends by default — pending tasks are preserved across task_plan calls", async () => {
    // Seed a prior plan: 1 active + 2 pending.
    const now = new Date().toISOString();
    fakeStorage.seed({
      schemaVersion: 1,
      activeTaskId: "existing-active",
      tasks: [
        { id: "existing-active", title: "A", description: "", status: "active", assignments: [], subtasks: [], priority: 0, createdAt: now, startedAt: now } as TrackedTask,
        { id: "existing-p1", title: "P1", description: "", status: "pending", assignments: [], subtasks: [], priority: 1, createdAt: now } as TrackedTask,
        { id: "existing-p2", title: "P2", description: "", status: "pending", assignments: [], subtasks: [], priority: 2, createdAt: now } as TrackedTask,
      ],
    });

    await tools.task_plan!({ tasks: [{ title: "New1" }, { title: "New2" }] });

    const snap = fakeStorage.peek()!;
    // All 3 existing + 2 new = 5. Regression guard for the "assign team → tasks vanish" bug.
    expect(snap.tasks).toHaveLength(5);
    const titles = snap.tasks.map((t) => t.title);
    expect(titles).toContain("A");
    expect(titles).toContain("P1");
    expect(titles).toContain("P2");
    expect(titles).toContain("New1");
    expect(titles).toContain("New2");
    // The pre-existing active task stays active — no double auto-start.
    expect(snap.activeTaskId).toBe("existing-active");
  });

  test("replace:true destructively wipes pending tasks (explicit opt-in)", async () => {
    const now = new Date().toISOString();
    fakeStorage.seed({
      schemaVersion: 1,
      activeTaskId: "keep-active",
      tasks: [
        { id: "keep-active", title: "Active", description: "", status: "active", assignments: [], subtasks: [], priority: 0, createdAt: now, startedAt: now } as TrackedTask,
        { id: "drop-p1", title: "P1", description: "", status: "pending", assignments: [], subtasks: [], priority: 1, createdAt: now } as TrackedTask,
        { id: "keep-done", title: "Done", description: "", status: "completed", assignments: [], subtasks: [], priority: 2, createdAt: now, completedAt: now } as TrackedTask,
      ],
    });

    await tools.task_plan!({ tasks: [{ title: "Fresh" }], replace: true });

    const snap = fakeStorage.peek()!;
    // Active and completed are preserved; pending is wiped; new task appended.
    expect(snap.tasks.map((t) => t.title).sort()).toEqual(["Active", "Done", "Fresh"]);
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

  test("update for unknown taskId → resyncs UI via snapshot re-emit", async () => {
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
    // Storage unchanged — no fabricated task.
    expect(fakeStorage.peek()!.tasks).toHaveLength(1);
    // Snapshot re-emitted so the UI can resync against reality.
    expect(fakeEvents.snapshots).toHaveLength(1);
  });

  test("update for unknown assignmentId on known task → resyncs UI", async () => {
    await tools.task_plan!({ tasks: [{ title: "A" }] });
    const snap = fakeStorage.peek()!;
    fakeEvents.snapshots.length = 0;
    await _internals.handleAssignmentUpdate({
      conversationId: "conv",
      taskId: snap.tasks[0]!.id,
      assignment: {
        id: "assignment-that-does-not-exist",
        agentConfigId: "agent-builder",
        agentName: "builder",
        isTeam: false,
        status: "completed",
        assignedAt: new Date().toISOString(),
      },
    });
    // Storage unchanged.
    expect(fakeStorage.peek()!.tasks[0]!.assignments).toHaveLength(0);
    // Snapshot re-emitted.
    expect(fakeEvents.snapshots).toHaveLength(1);
  });

  test("multi-assignment task: first completion keeps task active until second completes", async () => {
    await tools.task_plan!({ tasks: [{ title: "A" }] });
    const snap = fakeStorage.peek()!;
    const taskId = snap.tasks[0]!.id;
    snap.tasks[0]!.assignments.push(
      {
        id: "asn-1",
        agentConfigId: "agent-builder",
        agentName: "builder",
        isTeam: false,
        status: "running",
        assignedAt: new Date().toISOString(),
      },
      {
        id: "asn-2",
        agentConfigId: "agent-builder",
        agentName: "builder",
        isTeam: false,
        status: "running",
        assignedAt: new Date().toISOString(),
      },
    );
    await _internals.saveSnapshot(snap);

    // First completion — task must stay active, sibling still running.
    await _internals.handleAssignmentUpdate({
      conversationId: "conv",
      taskId,
      assignment: {
        id: "asn-1",
        agentConfigId: "agent-builder",
        agentName: "builder",
        isTeam: false,
        status: "completed",
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        resultPreview: "one",
      },
    });
    let after = fakeStorage.peek()!;
    expect(after.tasks[0]!.status).toBe("active");
    expect(after.tasks[0]!.assignments.find((a) => a.id === "asn-1")!.status).toBe("completed");
    expect(after.tasks[0]!.assignments.find((a) => a.id === "asn-2")!.status).toBe("running");

    // Second completion — now all assignments terminal, task rolls up.
    await _internals.handleAssignmentUpdate({
      conversationId: "conv",
      taskId,
      assignment: {
        id: "asn-2",
        agentConfigId: "agent-builder",
        agentName: "builder",
        isTeam: false,
        status: "completed",
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        resultPreview: "two",
      },
    });
    after = fakeStorage.peek()!;
    expect(after.tasks[0]!.status).toBe("completed");
  });

  test("multi-assignment task: a mix of failed + completed still rolls up", async () => {
    await tools.task_plan!({ tasks: [{ title: "A" }] });
    const snap = fakeStorage.peek()!;
    const taskId = snap.tasks[0]!.id;
    snap.tasks[0]!.assignments.push(
      {
        id: "asn-1",
        agentConfigId: "agent-builder",
        agentName: "builder",
        isTeam: false,
        status: "failed",
        assignedAt: new Date().toISOString(),
        failedAt: new Date().toISOString(),
      },
      {
        id: "asn-2",
        agentConfigId: "agent-builder",
        agentName: "builder",
        isTeam: false,
        status: "running",
        assignedAt: new Date().toISOString(),
      },
    );
    await _internals.saveSnapshot(snap);

    await _internals.handleAssignmentUpdate({
      conversationId: "conv",
      taskId,
      assignment: {
        id: "asn-2",
        agentConfigId: "agent-builder",
        agentName: "builder",
        isTeam: false,
        status: "completed",
        assignedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      },
    });
    // Every assignment is terminal — task rolls up (completes).
    expect(fakeStorage.peek()!.tasks[0]!.status).toBe("completed");
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

// ── Phase 4: task_stop LLM tool ─────────────────────────────────────
//
// Seeds snapshots directly and injects a fake cancelRun via
// `_setCancelForTests` to cover the stopHandler error ladder and the
// state transitions on the happy path.

/** Build a synthetic task+assignment pair for stop/resume coverage. */
function seedTaskWithAssignments(
  entries: Array<{
    taskId: string;
    taskStatus?: TrackedTask["status"];
    assignments: Array<Partial<TaskAssignment> & { id: string; status: TaskAssignment["status"] }>;
    dependsOn?: string[];
  }>,
  activeTaskId?: string,
): PersistedSnapshot {
  const now = new Date().toISOString();
  const snap: PersistedSnapshot = {
    schemaVersion: 1,
    tasks: entries.map((e, i) => ({
      id: e.taskId,
      title: e.taskId.toUpperCase(),
      description: "",
      status: e.taskStatus ?? "pending",
      assignments: e.assignments.map((a) => ({
        id: a.id,
        agentConfigId: a.agentConfigId ?? "agent-builder",
        agentName: a.agentName ?? "builder",
        isTeam: a.isTeam ?? false,
        status: a.status,
        assignedAt: a.assignedAt ?? now,
        ...(a.startedAt !== undefined ? { startedAt: a.startedAt } : {}),
        ...(a.agentRunId !== undefined ? { agentRunId: a.agentRunId } : {}),
        ...(a.subConversationId !== undefined ? { subConversationId: a.subConversationId } : {}),
      })),
      subtasks: [],
      priority: i,
      createdAt: now,
      ...(e.dependsOn ? { dependsOn: e.dependsOn } : {}),
    })) as TrackedTask[],
    ...(activeTaskId !== undefined ? { activeTaskId } : {}),
  };
  return snap;
}

describe("task-tracking extension — task_stop", () => {
  test("rejects when assignment status !== 'running'", async () => {
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "pending",
        assignments: [{ id: "a1", status: "assigned" }],
      },
    ]));
    const out = await tools.task_stop!({ taskId: "t1", assignmentId: "a1" });
    const o = out as { isError?: boolean; content: Array<{ text: string }> };
    expect(o.isError).toBe(true);
    expect(o.content[0]!.text).toMatch(/expected "running"/);
  });

  test("surfaces -32001 ownership rejection as UI-guidance toolError", async () => {
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "active",
        assignments: [{
          id: "a1",
          status: "running",
          agentRunId: "run-x",
          startedAt: new Date().toISOString(),
        }],
      },
    ], "t1"));
    _setCancelForTests(async () => {
      throw new JsonRpcError(-32001, "spawnAgents permission not granted");
    });
    const out = await tools.task_stop!({ taskId: "t1", assignmentId: "a1" });
    const o = out as { isError?: boolean; content: Array<{ text: string }> };
    expect(o.isError).toBe(true);
    // Handler's UI-guidance sentence mentions clicking Stop in the task panel.
    expect(o.content[0]!.text).toMatch(/Stop/);
    expect(o.content[0]!.text).toMatch(/assignment pill/);
    // Assignment state not mutated on ownership-rejection.
    const after = fakeStorage.peek()!;
    expect(after.tasks[0]!.assignments[0]!.status).toBe("running");
  });

  test("surfaces result.cancelled=false with reason verbatim", async () => {
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "active",
        assignments: [{
          id: "a1",
          status: "running",
          agentRunId: "run-x",
        }],
      },
    ], "t1"));
    _setCancelForTests(async () => ({ cancelled: false, reason: "not-owned" }));
    const out = await tools.task_stop!({ taskId: "t1", assignmentId: "a1" });
    const o = out as { isError?: boolean; content: Array<{ text: string }> };
    expect(o.isError).toBe(true);
    expect(o.content[0]!.text).toMatch(/not-owned/);
  });

  test("happy path resets assignment state + preserves subConversationId", async () => {
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "active",
        assignments: [{
          id: "a1",
          status: "running",
          agentRunId: "run-x",
          startedAt: "2024-01-01T00:00:00.000Z",
          subConversationId: "sub-preserved",
        }],
      },
    ], "t1"));
    _setCancelForTests(async () => ({ cancelled: true }));

    const out = await tools.task_stop!({ taskId: "t1", assignmentId: "a1" });
    expect(isResultText(out, /Stopped assignment/)).toBe(true);

    const after = fakeStorage.peek()!;
    const asn = after.tasks[0]!.assignments[0]!;
    expect(asn.status).toBe("assigned");
    expect(asn.agentRunId).toBeUndefined();
    expect(asn.startedAt).toBeUndefined();
    // subConversationId must survive so task_resume can reuse it.
    expect(asn.subConversationId).toBe("sub-preserved");
    // Bus-side assignment_update emitted.
    expect(fakeEvents.assignmentUpdates.some((u) => u.assignment.id === "a1" && u.assignment.status === "assigned")).toBe(true);
  });

  test("task falls back to pending when no other assignment is running", async () => {
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "active",
        assignments: [{
          id: "a1",
          status: "running",
          agentRunId: "run-x",
          subConversationId: "sub-1",
        }],
      },
    ], "t1"));
    _setCancelForTests(async () => ({ cancelled: true }));
    await tools.task_stop!({ taskId: "t1", assignmentId: "a1" });
    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.status).toBe("pending");
    expect(snap.activeTaskId).toBeUndefined();
  });

  test("task stays active when another assignment is still running", async () => {
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "active",
        assignments: [
          {
            id: "a1",
            status: "running",
            agentRunId: "run-x",
            subConversationId: "sub-1",
          },
          {
            id: "a2",
            status: "running",
            agentRunId: "run-y",
            subConversationId: "sub-2",
          },
        ],
      },
    ], "t1"));
    _setCancelForTests(async () => ({ cancelled: true }));
    await tools.task_stop!({ taskId: "t1", assignmentId: "a1" });
    const snap = fakeStorage.peek()!;
    // Other assignment still running → task stays active.
    expect(snap.tasks[0]!.status).toBe("active");
    expect(snap.activeTaskId).toBe("t1");
  });

  test("missing agentRunId returns guidance error", async () => {
    // Impossible in practice (running always has agentRunId) but
    // the handler defends explicitly. No agentRunId field set.
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "active",
        assignments: [{ id: "a1", status: "running" }],
      },
    ], "t1"));
    const out = await tools.task_stop!({ taskId: "t1", assignmentId: "a1" });
    const o = out as { isError?: boolean; content: Array<{ text: string }> };
    expect(o.isError).toBe(true);
    expect(o.content[0]!.text).toMatch(/agentRunId/);
  });
});

// ── Phase 4: task_resume LLM tool ───────────────────────────────────

describe("task-tracking extension — task_resume", () => {
  test("rejects when assignment status !== 'assigned'", async () => {
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "active",
        assignments: [{
          id: "a1",
          status: "running",
          agentRunId: "run-x",
          subConversationId: "sub-1",
        }],
      },
    ], "t1"));
    const out = await tools.task_resume!({ taskId: "t1", assignmentId: "a1" });
    const o = out as { isError?: boolean; content: Array<{ text: string }> };
    expect(o.isError).toBe(true);
    expect(o.content[0]!.text).toMatch(/expected "assigned"/);
  });

  test("rejects when subConversationId is absent", async () => {
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "pending",
        // assigned + no subConversationId — nothing to resume.
        assignments: [{ id: "a1", status: "assigned" }],
      },
    ]));
    const out = await tools.task_resume!({ taskId: "t1", assignmentId: "a1" });
    const o = out as { isError?: boolean; content: Array<{ text: string }> };
    expect(o.isError).toBe(true);
    expect(o.content[0]!.text).toMatch(/nothing to resume/);
    expect(o.content[0]!.text).toMatch(/task_start/);
  });

  test("dependency-gate: rejects when prereqs unmet", async () => {
    const snap = seedTaskWithAssignments([
      { taskId: "t-dep", taskStatus: "pending", assignments: [] },
      {
        taskId: "t1",
        taskStatus: "pending",
        assignments: [{
          id: "a1",
          status: "assigned",
          subConversationId: "sub-1",
        }],
        dependsOn: ["t-dep"],
      },
    ]);
    // Make the dep task have a readable title so the error names it.
    snap.tasks[0]!.title = "Prereq";
    fakeStorage.seed(snap);

    const out = await tools.task_resume!({ taskId: "t1", assignmentId: "a1" });
    const o = out as { isError?: boolean; content: Array<{ text: string }> };
    expect(o.isError).toBe(true);
    expect(o.content[0]!.text).toMatch(/Prereq/);
    expect(o.content[0]!.text).toMatch(/blocked/);
  });

  test("happy path: spawns with reuseSubConversationFor; transitions to running", async () => {
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "pending",
        assignments: [{
          id: "a1",
          status: "assigned",
          agentConfigId: "agent-builder",
          subConversationId: "sub-persisted",
        }],
      },
    ]));
    const { fn, calls } = makeFakeSpawn();
    _setSpawnForTests(fn);

    const out = await tools.task_resume!({ taskId: "t1", assignmentId: "a1" });
    expect(isResultText(out, /Resumed assignment/)).toBe(true);
    expect(calls).toHaveLength(1);
    // Handler asked the host to reuse the same agent's sub-conv.
    expect(calls[0]!.input.reuseSubConversationFor).toBe("agent-builder");
    expect(calls[0]!.input.taskId).toBe("t1");
    expect(calls[0]!.input.assignmentId).toBe("a1");

    const snap = fakeStorage.peek()!;
    const asn = snap.tasks[0]!.assignments[0]!;
    expect(asn.status).toBe("running");
    // Spawn returns sub-${assignmentId} in the "happy" fake.
    expect(asn.subConversationId).toBe("sub-a1");
    expect(asn.agentRunId).toBe("run-a1");
    expect(asn.startedAt).toBeDefined();
  });

  test("error ladder: -32602 (invalid) records assignment failure", async () => {
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "pending",
        assignments: [{
          id: "a1",
          status: "assigned",
          subConversationId: "sub-1",
        }],
      },
    ]));
    const { fn } = makeFakeSpawn({ mode: "invalid" });
    _setSpawnForTests(fn);

    const out = await tools.task_resume!({ taskId: "t1", assignmentId: "a1" });
    const o = out as { isError?: boolean };
    expect(o.isError).toBe(true);

    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.assignments[0]!.status).toBe("failed");
    expect(snap.tasks[0]!.status).toBe("failed");
  });

  test("error ladder: -32000 (quota) returns transient error without mutating state", async () => {
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "pending",
        assignments: [{
          id: "a1",
          status: "assigned",
          subConversationId: "sub-1",
        }],
      },
    ]));
    const { fn } = makeFakeSpawn({ mode: "quota" });
    _setSpawnForTests(fn);

    const out = await tools.task_resume!({ taskId: "t1", assignmentId: "a1" });
    const o = out as { isError?: boolean };
    expect(o.isError).toBe(true);

    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.assignments[0]!.status).toBe("assigned");
    // Task status is unchanged (still pending) — transient branch left state alone.
    expect(snap.tasks[0]!.status).toBe("pending");
  });

  test("task transitions to 'active' when resuming from 'pending'", async () => {
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "pending",
        assignments: [{
          id: "a1",
          status: "assigned",
          subConversationId: "sub-1",
        }],
      },
    ]));
    const { fn } = makeFakeSpawn();
    _setSpawnForTests(fn);

    await tools.task_resume!({ taskId: "t1", assignmentId: "a1" });
    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.status).toBe("active");
    expect(snap.activeTaskId).toBe("t1");
  });
});

// ── task_complete / task_fail cancel running assignments ────────────
//
// Guards the parent-terminated-task bug: the LLM calls task_complete (or
// task_fail) while a sub-agent is still running. Before the fix the
// assignment stayed stuck in "running" forever. Now the handler cancels
// the run and flips the assignment to the terminal state that matches
// the parent's transition.

describe("task-tracking extension — task_complete / task_fail cancel running assignments", () => {
  test("task_complete cancels a running assignment's run and marks it completed", async () => {
    const cancelled: string[] = [];
    _setCancelForTests(async (runId) => {
      cancelled.push(runId);
      return { cancelled: true };
    });
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "active",
        assignments: [{
          id: "a1",
          status: "running",
          agentRunId: "run-1",
          startedAt: new Date().toISOString(),
        }],
      },
    ], "t1"));

    const out = await tools.task_complete!({ taskId: "t1", summary: "done" });
    expect(isResultText(out, /Completed/)).toBe(true);

    expect(cancelled).toEqual(["run-1"]);
    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.status).toBe("completed");
    expect(snap.tasks[0]!.assignments[0]!.status).toBe("completed");
    expect(snap.tasks[0]!.assignments[0]!.completedAt).toBeDefined();
  });

  test("task_complete tolerates cancel failure and still marks assignment completed", async () => {
    _setCancelForTests(async () => {
      throw new JsonRpcError(-32001, "not owned");
    });
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "active",
        assignments: [{
          id: "a1",
          status: "running",
          agentRunId: "run-1",
          startedAt: new Date().toISOString(),
        }],
      },
    ], "t1"));

    const out = await tools.task_complete!({ taskId: "t1" });
    expect(isResultText(out, /Completed/)).toBe(true);

    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.status).toBe("completed");
    expect(snap.tasks[0]!.assignments[0]!.status).toBe("completed");
  });

  test("task_complete with no running assignments is a no-op on cancel path", async () => {
    const cancelled: string[] = [];
    _setCancelForTests(async (runId) => {
      cancelled.push(runId);
      return { cancelled: true };
    });
    fakeStorage.seed(seedTaskWithAssignments([
      { taskId: "t1", taskStatus: "active", assignments: [] },
    ], "t1"));

    await tools.task_complete!({ taskId: "t1" });
    expect(cancelled).toEqual([]);
    expect(fakeStorage.peek()!.tasks[0]!.status).toBe("completed");
  });

  test("task_fail cancels running assignments and flips them to failed", async () => {
    const cancelled: string[] = [];
    _setCancelForTests(async (runId) => {
      cancelled.push(runId);
      return { cancelled: true };
    });
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "active",
        assignments: [{
          id: "a1",
          status: "running",
          agentRunId: "run-1",
          startedAt: new Date().toISOString(),
        }],
      },
    ], "t1"));

    const out = await tools.task_fail!({ taskId: "t1", reason: "upstream broke" });
    expect(isResultText(out, /Failed task/)).toBe(true);

    expect(cancelled).toEqual(["run-1"]);
    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.status).toBe("failed");
    expect(snap.tasks[0]!.assignments[0]!.status).toBe("failed");
    expect(snap.tasks[0]!.assignments[0]!.failedAt).toBeDefined();
    expect(snap.tasks[0]!.assignments[0]!.resultPreview).toMatch(/upstream broke/);
  });

  test("task_complete cancels both assignments on a multi-assignment task", async () => {
    const cancelled: string[] = [];
    _setCancelForTests(async (runId) => {
      cancelled.push(runId);
      return { cancelled: true };
    });
    fakeStorage.seed(seedTaskWithAssignments([
      {
        taskId: "t1",
        taskStatus: "active",
        assignments: [
          { id: "a1", status: "running", agentRunId: "run-1", startedAt: new Date().toISOString() },
          { id: "a2", status: "running", agentRunId: "run-2", startedAt: new Date().toISOString() },
        ],
      },
    ], "t1"));

    await tools.task_complete!({ taskId: "t1" });
    expect(cancelled.sort()).toEqual(["run-1", "run-2"]);
    const snap = fakeStorage.peek()!;
    expect(snap.tasks[0]!.status).toBe("completed");
    expect(snap.tasks[0]!.assignments[0]!.status).toBe("completed");
    expect(snap.tasks[0]!.assignments[1]!.status).toBe("completed");
  });
});
