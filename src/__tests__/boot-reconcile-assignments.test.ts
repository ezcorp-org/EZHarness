/**
 * Tests for src/runtime/boot-reconcile-assignments.ts — the boot pass that
 * transitions task-tracking assignments a restart left `running` (behind a
 * now-terminalized run) to `failed`, emitting the reconciling bus events so
 * the panel + waiting extension state converge on next load.
 *
 * Runs against a real PGlite (mirrors task-tracking-host.test.ts) so the
 * host-side extension_storage read + the runs-status batch read are exercised
 * end-to-end. A real EventBus captures the emitted events.
 */

import {
  test,
  expect,
  describe,
  beforeAll,
  afterAll,
  beforeEach,
  mock,
} from "bun:test";
import { setupTestDb, closeTestDb, getTestPglite } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mock.module("../db/connection", () => ({
  getDb: () => {
    const pg = getTestPglite();
    if (!pg) throw new Error("Test DB not initialized");
    const { drizzle } = require("drizzle-orm/pglite");
    const schema = require("../db/schema");
    return drizzle(pg, { schema });
  },
  getPglite: () => getTestPglite(),
  getDbPath: () => ":memory:",
  initDb: async () => {},
  closeDb: async () => {},
}));

const { reconcileInterruptedAssignments, INTERRUPT_PREVIEW } = await import(
  "../runtime/boot-reconcile-assignments"
);
const { getTaskSnapshotForConversation, _resetTaskTrackingExtensionIdCache } =
  await import("../runtime/task-tracking-host");
const { EventBus } = await import("../runtime/events");
const { getDb } = await import("../db/connection");
const {
  extensions: extensionsTable,
  conversations,
  projects,
  extensionStorage,
  runs,
} = await import("../db/schema");

const EXT_ID = "ext-tt-real";

async function seedFixtures(): Promise<void> {
  await getDb()
    .insert(projects)
    .values({ id: "proj-r", name: "proj-r", path: "/tmp/proj-r" } as any)
    .onConflictDoNothing();
}

async function seedExtension(): Promise<void> {
  await getDb()
    .insert(extensionsTable)
    .values({
      id: EXT_ID,
      name: "task-tracking",
      version: "1.0.0",
      description: "t",
      manifest: {
        schemaVersion: 2,
        name: "task-tracking",
        version: "1.0.0",
        description: "t",
        author: { name: "t" },
        permissions: {},
      },
      source: "test:tt",
      installPath: "/tmp/tt",
      enabled: true,
    } as any)
    .onConflictDoNothing();
}

async function seedConversation(id: string): Promise<void> {
  await getDb()
    .insert(conversations)
    .values({ id, projectId: "proj-r", title: id } as any)
    .onConflictDoNothing();
}

function assignment(over: Record<string, unknown>): Record<string, unknown> {
  return {
    id: "a1",
    agentConfigId: "cfg1",
    agentName: "Worker",
    isTeam: false,
    status: "running",
    assignedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    ...over,
  };
}

async function seedSnapshot(
  conversationId: string,
  tasks: unknown[],
  scopeId: string | null = conversationId,
): Promise<void> {
  const value = { tasks, schemaVersion: 1 };
  await getDb()
    .insert(extensionStorage)
    .values({
      extensionId: EXT_ID,
      scope: "conversation",
      scopeId,
      key: "tasks",
      value,
      encrypted: false,
      sizeBytes: Buffer.byteLength(JSON.stringify(value), "utf-8"),
    } as any);
}

async function seedRun(id: string, status: string): Promise<void> {
  await getDb()
    .insert(runs)
    .values({
      id,
      agentName: "chat",
      status,
      startedAt: new Date(),
      createdAt: new Date(),
    } as any)
    .onConflictDoNothing();
}

/** Capture every bus event of the given types. */
function capturingBus() {
  const bus = new EventBus<any>();
  const events: Array<{ type: string; data: any }> = [];
  for (const t of ["task:assignment_update", "agent:complete"] as const) {
    bus.on(t, (data: any) => events.push({ type: t, data }));
  }
  return { bus, events };
}

beforeAll(async () => {
  await setupTestDb();
  await seedFixtures();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

beforeEach(async () => {
  _resetTaskTrackingExtensionIdCache();
  // Isolate each test: reconcile scans ALL conversations, so stale rows would
  // cross-contaminate the global return count.
  await getDb().delete(extensionStorage);
  await getDb().delete(runs);
});

describe("reconcileInterruptedAssignments", () => {
  test("returns 0 (quiet no-op) when the task-tracking extension is not installed", async () => {
    // No extension row seeded yet — getTaskTrackingExtensionId throws.
    const { bus, events } = capturingBus();
    const n = await reconcileInterruptedAssignments(bus);
    expect(n).toBe(0);
    expect(events).toHaveLength(0);
  });

  test("fails a dangling assignment (terminalized run) and leaves a genuinely-running one untouched", async () => {
    await seedExtension();
    await seedConversation("conv-dead");
    await seedConversation("conv-live");
    await seedSnapshot("conv-dead", [
      {
        id: "t-dead",
        title: "Dead",
        description: "",
        status: "active",
        assignments: [
          assignment({ id: "a-dead", agentRunId: "run-dead", subConversationId: "sub-dead" }),
        ],
        subtasks: [],
        priority: 0,
        createdAt: new Date().toISOString(),
      },
    ]);
    await seedSnapshot("conv-live", [
      {
        id: "t-live",
        title: "Live",
        description: "",
        status: "active",
        assignments: [assignment({ id: "a-live", agentRunId: "run-live" })],
        subtasks: [],
        priority: 0,
        createdAt: new Date().toISOString(),
      },
    ]);
    await seedRun("run-dead", "error"); // terminalized by boot
    await seedRun("run-live", "running"); // still genuinely live

    const { bus, events } = capturingBus();
    const n = await reconcileInterruptedAssignments(bus);
    expect(n).toBe(1);

    // conv-dead assignment persisted as failed with the actionable preview.
    const dead = await getTaskSnapshotForConversation("conv-dead");
    const deadAssignment = dead!.tasks[0]!.assignments[0]!;
    expect(deadAssignment.status).toBe("failed");
    expect(deadAssignment.resultPreview).toBe(INTERRUPT_PREVIEW);
    expect(deadAssignment.failedAt).toBeDefined();

    // conv-live untouched (run still running).
    const live = await getTaskSnapshotForConversation("conv-live");
    expect(live!.tasks[0]!.assignments[0]!.status).toBe("running");

    // Events fired only for the reconciled assignment.
    const updates = events.filter((e) => e.type === "task:assignment_update");
    const completes = events.filter((e) => e.type === "agent:complete");
    expect(updates).toHaveLength(1);
    expect(updates[0]!.data.taskId).toBe("t-dead");
    expect(updates[0]!.data.assignment.status).toBe("failed");
    expect(updates[0]!.data.resultFull).toBe(INTERRUPT_PREVIEW);
    expect(completes).toHaveLength(1);
    expect(completes[0]!.data.agentRunId).toBe("run-dead");
    expect(completes[0]!.data.success).toBe(false);
    expect(completes[0]!.data.parentConversationId).toBe("conv-dead");
    expect(completes[0]!.data.subConversationId).toBe("sub-dead");
  });

  test("treats a missing run row as terminal (fails the assignment)", async () => {
    await seedExtension();
    await seedConversation("conv-gone");
    await seedSnapshot("conv-gone", [
      {
        id: "t-gone",
        title: "Gone",
        description: "",
        status: "active",
        assignments: [assignment({ id: "a-gone", agentRunId: "run-gone" })],
        subtasks: [],
        priority: 0,
        createdAt: new Date().toISOString(),
      },
    ]);
    // No runs row for run-gone.

    const { bus } = capturingBus();
    const n = await reconcileInterruptedAssignments(bus);
    expect(n).toBe(1);
    const snap = await getTaskSnapshotForConversation("conv-gone");
    expect(snap!.tasks[0]!.assignments[0]!.status).toBe("failed");
  });

  test("fails a running assignment that never materialized a run (no agentRunId)", async () => {
    await seedExtension();
    await seedConversation("conv-noid");
    await seedSnapshot("conv-noid", [
      {
        id: "t-noid",
        title: "NoId",
        description: "",
        status: "active",
        assignments: [assignment({ id: "a-noid" })], // no agentRunId
        subtasks: [],
        priority: 0,
        createdAt: new Date().toISOString(),
      },
    ]);

    const { bus, events } = capturingBus();
    const n = await reconcileInterruptedAssignments(bus);
    expect(n).toBe(1);
    const snap = await getTaskSnapshotForConversation("conv-noid");
    expect(snap!.tasks[0]!.assignments[0]!.status).toBe("failed");
    // agent:complete falls back to an empty run id when none was recorded.
    const complete = events.find((e) => e.type === "agent:complete");
    expect(complete!.data.runId).toBe("");
  });

  test("reconciles a subtask-scoped running assignment", async () => {
    await seedExtension();
    await seedConversation("conv-sub");
    await seedSnapshot("conv-sub", [
      {
        id: "t-sub",
        title: "Sub",
        description: "",
        status: "active",
        assignments: [],
        subtasks: [
          {
            id: "st-1",
            title: "subtask",
            completed: false,
            position: 0,
            assignments: [
              assignment({ id: "a-sub", agentRunId: "run-sub" }),
            ],
          },
        ],
        priority: 0,
        createdAt: new Date().toISOString(),
      },
    ]);
    await seedRun("run-sub", "cancelled");

    const { bus } = capturingBus();
    const n = await reconcileInterruptedAssignments(bus);
    expect(n).toBe(1);
    const snap = await getTaskSnapshotForConversation("conv-sub");
    expect(snap!.tasks[0]!.subtasks[0]!.assignments![0]!.status).toBe("failed");
  });

  test("no running assignments → nothing reconciled", async () => {
    await seedExtension();
    await seedConversation("conv-done");
    await seedSnapshot("conv-done", [
      {
        id: "t-done",
        title: "Done",
        description: "",
        status: "completed",
        assignments: [assignment({ id: "a-done", status: "completed", agentRunId: "run-done" })],
        subtasks: [],
        priority: 0,
        createdAt: new Date().toISOString(),
      },
    ]);
    await seedRun("run-done", "success");

    const { bus, events } = capturingBus();
    const n = await reconcileInterruptedAssignments(bus);
    expect(n).toBe(0);
    expect(events).toHaveLength(0);
  });

  test("skips a malformed conversation row with a null scope id and a row with no tasks", async () => {
    await seedExtension();
    // scopeId null: conversation-scoped row with no owning id — skipped.
    await seedSnapshot(
      "ignored",
      [
        {
          id: "t-null",
          title: "Null",
          description: "",
          status: "active",
          assignments: [assignment({ id: "a-null", agentRunId: "run-null" })],
          subtasks: [],
          priority: 0,
          createdAt: new Date().toISOString(),
        },
      ],
      null,
    );
    // A row whose value carries no tasks array.
    await getDb()
      .insert(extensionStorage)
      .values({
        extensionId: EXT_ID,
        scope: "conversation",
        scopeId: "conv-empty-val",
        key: "tasks",
        value: { schemaVersion: 1 },
        encrypted: false,
        sizeBytes: 10,
      } as any);

    const { bus, events } = capturingBus();
    const n = await reconcileInterruptedAssignments(bus);
    expect(n).toBe(0);
    expect(events).toHaveLength(0);
  });
});
