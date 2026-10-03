import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import * as schema from "../db/schema";
import { SandboxController, type SandboxProviderDispatcher } from "./controller";
import {
  SandboxAdmissionStore,
  type SandboxHostCapacityInput,
  type SandboxResourceVector,
} from "./admission";

const provider: SandboxProviderDispatcher = {
  dispatch: async () => ({ outcome: "UNKNOWN" }),
  inspectOperation: async () => ({ outcome: "UNKNOWN" }),
};

const databases: PGlite[] = [];
const host = { providerInstallationId: "provider", connectionId: "connection" };
const resources: SandboxResourceVector = {
  memoryBytes: 100,
  cpuMillicores: 1_000,
  pids: 64,
  diskBytes: 1_000,
  executionSlots: 1,
};

async function setup(projectIds: string[]) {
  const pglite = new PGlite();
  databases.push(pglite);
  await pglite.waitReady;
  await pglite.exec(`CREATE TABLE projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    path TEXT NOT NULL,
    purpose TEXT NOT NULL DEFAULT 'user',
    icon TEXT,
    variables JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )`);
  const db = drizzle(pglite, { schema });
  await addSandboxController(db);
  const controller = new SandboxController(db, provider);
  for (const projectId of projectIds) {
    await db.insert(schema.projects).values({ id: projectId, name: projectId, path: `/work/${projectId}` });
    await controller.createBinding({
      id: `binding-${projectId}`,
      projectId,
      ...host,
      providerReleaseId: "release",
      resourceKey: `resource-${projectId}`,
    });
  }
  return { pglite, db, controller, admission: new SandboxAdmissionStore(db) };
}

async function configure(
  admission: SandboxAdmissionStore,
  projectIds: string[],
  input: Partial<SandboxHostCapacityInput> = {},
) {
  const capacity: SandboxHostCapacityInput = {
    ...host,
    allocatable: {
      memoryBytes: 1_000,
      cpuMillicores: 10_000,
      pids: 1_000,
      diskBytes: 10_000,
      executionSlots: 10,
    },
    safetyMargin: {
      memoryBytes: 100,
      cpuMillicores: 1_000,
      pids: 100,
      diskBytes: 1_000,
      executionSlots: 1,
    },
    ...input,
  };
  await admission.configureHostCapacity(capacity);
  for (const projectId of projectIds) {
    await admission.configureProjectQuota({
      projectId,
      ...host,
      limit: {
        memoryBytes: capacity.allocatable.memoryBytes - capacity.safetyMargin.memoryBytes,
        cpuMillicores: capacity.allocatable.cpuMillicores - capacity.safetyMargin.cpuMillicores,
        pids: capacity.allocatable.pids - capacity.safetyMargin.pids,
        diskBytes: capacity.allocatable.diskBytes - capacity.safetyMargin.diskBytes,
        executionSlots: capacity.allocatable.executionSlots - capacity.safetyMargin.executionSlots,
      },
    });
  }
}

function request(projectId: string, key: string, requested = resources) {
  return {
    bindingId: `binding-${projectId}`,
    generation: 1,
    kind: "CREATE" as const,
    idempotencyScope: "lifecycle",
    idempotencyKey: key,
    resources: requested,
  };
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close().catch(() => {})));
});

describe("SandboxAdmissionStore", () => {
  test("requires explicit capacity and quota and persists a reservation before admission returns", async () => {
    const { admission } = await setup(["one"]);
    const missingHost = await admission.requestAdmission(request("one", "missing-host"));
    expect(missingHost).toEqual(expect.objectContaining({
      state: "REJECTED",
      reason: "HOST_CAPACITY_NOT_CONFIGURED",
    }));
    expect(await admission.getReservation("binding-one")).toBeNull();

    await admission.configureHostCapacity({
      ...host,
      allocatable: { memoryBytes: 200, cpuMillicores: 2_000, pids: 128, diskBytes: 2_000, executionSlots: 2 },
      safetyMargin: { memoryBytes: 100, cpuMillicores: 1_000, pids: 64, diskBytes: 1_000, executionSlots: 1 },
    });
    const missingProject = await admission.requestAdmission(request("one", "missing-project"));
    expect(missingProject).toEqual(expect.objectContaining({
      state: "REJECTED",
      reason: "PROJECT_QUOTA_NOT_CONFIGURED",
    }));

    await admission.configureProjectQuota({ projectId: "one", ...host, limit: resources });
    const admitted = await admission.requestAdmission(request("one", "configured"));
    expect(admitted).toEqual(expect.objectContaining({ state: "ADMITTED", reason: null }));
    expect(await admission.getReservation("binding-one")).toEqual(expect.objectContaining({
      computeState: "RESERVED",
      diskState: "RESERVED",
      ...resources,
    }));
  });

  test("serializes simultaneous host admissions without overcommit", async () => {
    const { admission } = await setup(["one", "two"]);
    await configure(admission, ["one", "two"], {
      allocatable: { memoryBytes: 300, cpuMillicores: 3_000, pids: 192, diskBytes: 3_000, executionSlots: 2 },
      safetyMargin: { memoryBytes: 100, cpuMillicores: 1_000, pids: 64, diskBytes: 1_000, executionSlots: 1 },
    });

    const results = await Promise.all([
      admission.requestAdmission(request("one", "race-one")),
      admission.requestAdmission(request("two", "race-two")),
    ]);

    expect(results.map((result) => result.state).sort()).toEqual(["ADMITTED", "QUEUED"]);
    expect(results.find((result) => result.state === "QUEUED")?.reason).toBe("HOST_EXECUTION_SLOTS_CAPACITY");
    const reservations = await Promise.all([
      admission.getReservation("binding-one"),
      admission.getReservation("binding-two"),
    ]);
    expect(reservations.filter(Boolean)).toHaveLength(1);
  });

  test("enforces project quota, safety margin, integer bounds and scoped idempotency", async () => {
    const { admission, pglite } = await setup(["one"]);
    await configure(admission, ["one"]);
    await admission.configureProjectQuota({
      projectId: "one",
      ...host,
      limit: { ...resources, memoryBytes: 150 },
    });
    const tooLarge = await admission.requestAdmission(request("one", "too-large", { ...resources, memoryBytes: 151 }));
    expect(tooLarge).toEqual(expect.objectContaining({
      state: "REJECTED",
      reason: "PROJECT_MEMORY_REQUEST_EXCEEDS_QUOTA",
    }));

    const admitted = await admission.requestAdmission(request("one", "same"));
    const replay = await admission.requestAdmission(request("one", "same"));
    expect(replay.id).toBe(admitted.id);
    await expect(admission.requestAdmission(request("one", "same", { ...resources, memoryBytes: 101 })))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(admission.configureProjectQuota({
      projectId: "one",
      ...host,
      limit: { ...resources, memoryBytes: 99 },
    })).rejects.toMatchObject({ code: "PROJECT_QUOTA_BELOW_RESERVED" });
    await expect(admission.configureHostCapacity({
      ...host,
      allocatable: { memoryBytes: 1_000, cpuMillicores: 10_000, pids: 1_000, diskBytes: 10_000, executionSlots: 10 },
      safetyMargin: { memoryBytes: 901, cpuMillicores: 1_000, pids: 100, diskBytes: 1_000, executionSlots: 1 },
    })).rejects.toMatchObject({ code: "CAPACITY_BELOW_RESERVED" });
    await expect(admission.configureHostCapacity({
      ...host,
      allocatable: { ...resources, memoryBytes: Number.MAX_SAFE_INTEGER + 1 },
      safetyMargin: { memoryBytes: 0, cpuMillicores: 0, pids: 0, diskBytes: 0, executionSlots: 0 },
    })).rejects.toMatchObject({ code: "INVALID_CAPACITY" });
    await expect(pglite.exec(`UPDATE sandbox_reservations SET memory_bytes = 9007199254740992`)).rejects.toThrow();
  });

  test("keeps compute charged during stop uncertainty and retains disk after confirmed stop", async () => {
    const { admission } = await setup(["one", "two"]);
    await configure(admission, ["one", "two"], {
      allocatable: { memoryBytes: 300, cpuMillicores: 3_000, pids: 192, diskBytes: 3_000, executionSlots: 2 },
      safetyMargin: { memoryBytes: 100, cpuMillicores: 1_000, pids: 64, diskBytes: 1_000, executionSlots: 1 },
    });
    expect((await admission.requestAdmission(request("one", "create-one"))).state).toBe("ADMITTED");
    await admission.markStopIntent("binding-one", 1, "stop-one");

    const pendingStart = await admission.requestAdmission({
      ...request("one", "start-pending"),
      kind: "START",
    });
    expect(pendingStart).toEqual(expect.objectContaining({ state: "REJECTED", reason: "STOP_OUTCOME_PENDING" }));
    const blockedNeighbor = await admission.requestAdmission(request("two", "blocked-neighbor"));
    expect(blockedNeighbor).toEqual(expect.objectContaining({
      state: "QUEUED",
      reason: "HOST_EXECUTION_SLOTS_CAPACITY",
    }));

    const stopped = await admission.recordObservedState("binding-one", 1, "STOPPED", "stop-one");
    expect(stopped).toEqual(expect.objectContaining({ computeState: "RELEASED", diskState: "RESERVED" }));
    const resumed = await admission.requestAdmission({ ...request("one", "resume"), kind: "START" });
    expect(resumed.state).toBe("ADMITTED");
    expect((await admission.getReservation("binding-one"))?.diskBytes).toBe(resources.diskBytes);
  });

  test("releases retained disk only after confirmed absence and retries a durable queue receipt", async () => {
    const { admission } = await setup(["one", "two"]);
    await configure(admission, ["one", "two"], {
      allocatable: { memoryBytes: 300, cpuMillicores: 3_000, pids: 192, diskBytes: 3_000, executionSlots: 2 },
      safetyMargin: { memoryBytes: 100, cpuMillicores: 1_000, pids: 64, diskBytes: 1_000, executionSlots: 1 },
    });
    await admission.requestAdmission(request("one", "create-one"));
    const queued = await admission.requestAdmission(request("two", "create-two"));
    expect(queued.state).toBe("QUEUED");

    const cleanup = await admission.markCleanupIntent("binding-one", 1, "cleanup-one");
    expect(cleanup).toEqual(expect.objectContaining({
      computeState: "RELEASE_REQUESTED",
      diskState: "RELEASE_REQUESTED",
    }));
    expect((await admission.retryAdmission(queued.id)).state).toBe("QUEUED");
    await admission.recordObservedState("binding-one", 1, "ABSENT", "cleanup-one");
    const admitted = await admission.retryAdmission(queued.id);
    expect(admitted).toEqual(expect.objectContaining({ id: queued.id, state: "ADMITTED", reason: null }));
    expect(await admission.getReservation("binding-two")).toEqual(expect.objectContaining({
      computeState: "RESERVED",
      diskState: "RESERVED",
    }));
  });

  test("fences a start racing a stop intent", async () => {
    const { admission } = await setup(["one"]);
    await configure(admission, ["one"]);
    await admission.requestAdmission(request("one", "create"));

    const [stop, start] = await Promise.all([
      admission.markStopIntent("binding-one", 1, "stop-one"),
      admission.requestAdmission({ ...request("one", "racing-start"), kind: "START" }),
    ]);

    expect(stop.computeState).toBe("RELEASE_REQUESTED");
    expect(start).toEqual(expect.objectContaining({ state: "REJECTED" }));
    expect(start.reason === "COMPUTE_ALREADY_RESERVED" || start.reason === "STOP_OUTCOME_PENDING").toBe(true);
    expect((await admission.getReservation("binding-one"))?.computeState).toBe("RELEASE_REQUESTED");
  });

  test("does not release capacity from a stale observed-state result", async () => {
    const { admission, controller } = await setup(["one"]);
    await configure(admission, ["one"]);
    await admission.requestAdmission(request("one", "create"));
    await admission.markStopIntent("binding-one", 1, "stop-one");
    await controller.advanceGeneration("binding-one", 1);

    await expect(admission.recordObservedState("binding-one", 1, "STOPPED"))
      .rejects.toMatchObject({ code: "INVALID_ADMISSION_REQUEST" });
    expect((await admission.getReservation("binding-one"))?.computeState).toBe("RELEASE_REQUESTED");
  });

  test("cannot restore released compute without a new admission", async () => {
    const { admission } = await setup(["one", "two"]);
    await configure(admission, ["one", "two"], {
      allocatable: { memoryBytes: 300, cpuMillicores: 3_000, pids: 192, diskBytes: 3_000, executionSlots: 2 },
      safetyMargin: { memoryBytes: 100, cpuMillicores: 1_000, pids: 64, diskBytes: 1_000, executionSlots: 1 },
    });
    await admission.requestAdmission(request("one", "create-one"));
    await admission.markStopIntent("binding-one", 1, "stop-one");
    await admission.recordObservedState("binding-one", 1, "STOPPED", "stop-one");
    expect((await admission.requestAdmission(request("two", "create-two"))).state).toBe("ADMITTED");

    await expect(admission.recordObservedState("binding-one", 1, "RUNNING"))
      .rejects.toMatchObject({ code: "INVALID_ADMISSION_REQUEST" });
    expect((await admission.getReservation("binding-one"))?.computeState).toBe("RELEASED");
  });

  test("does not release restarted compute for a late stop observation from the same generation", async () => {
    const { admission } = await setup(["one", "two"]);
    await configure(admission, ["one", "two"], {
      allocatable: { memoryBytes: 300, cpuMillicores: 3_000, pids: 192, diskBytes: 3_000, executionSlots: 2 },
      safetyMargin: { memoryBytes: 100, cpuMillicores: 1_000, pids: 64, diskBytes: 1_000, executionSlots: 1 },
    });
    await admission.requestAdmission(request("one", "create-one"));
    await admission.markStopIntent("binding-one", 1, "stop-one");
    await admission.recordObservedState("binding-one", 1, "STOPPED", "stop-one");
    expect((await admission.requestAdmission({ ...request("one", "resume-one"), kind: "START" })).state)
      .toBe("ADMITTED");

    await expect(admission.recordObservedState("binding-one", 1, "STOPPED", "stop-one"))
      .rejects.toMatchObject({ code: "INVALID_ADMISSION_REQUEST" });
    expect((await admission.getReservation("binding-one"))?.computeState).toBe("RESERVED");
    expect(await admission.requestAdmission(request("two", "create-two"))).toEqual(expect.objectContaining({
      state: "QUEUED",
      reason: "HOST_EXECUTION_SLOTS_CAPACITY",
    }));
  });

  test("binds release observations to the exact intent across repeated same-generation stops", async () => {
    const { admission } = await setup(["one"]);
    await configure(admission, ["one"]);
    await admission.requestAdmission(request("one", "create"));
    await admission.markStopIntent("binding-one", 1, "stop-one");
    await admission.recordObservedState("binding-one", 1, "STOPPED", "stop-one");
    await admission.requestAdmission({ ...request("one", "resume"), kind: "START" });
    await admission.markStopIntent("binding-one", 1, "stop-two");

    await expect(admission.recordObservedState("binding-one", 1, "STOPPED", "stop-one"))
      .rejects.toMatchObject({ code: "INVALID_ADMISSION_REQUEST" });
    expect((await admission.getReservation("binding-one"))?.computeState).toBe("RELEASE_REQUESTED");
    expect(await admission.recordObservedState("binding-one", 1, "STOPPED", "stop-two"))
      .toEqual(expect.objectContaining({ computeState: "RELEASED" }));
  });

  test("requires cleanup intent before an absence observation can release retained disk", async () => {
    const { admission } = await setup(["one"]);
    await configure(admission, ["one"]);
    await admission.requestAdmission(request("one", "create"));

    await expect(admission.recordObservedState("binding-one", 1, "ABSENT"))
      .rejects.toMatchObject({ code: "INVALID_ADMISSION_REQUEST" });
    expect(await admission.getReservation("binding-one")).toEqual(expect.objectContaining({
      computeState: "RESERVED",
      diskState: "RESERVED",
    }));
  });

  test("rejects generations outside the PostgreSQL integer range at the API boundary", async () => {
    const { admission } = await setup(["one"]);
    await configure(admission, ["one"]);

    await expect(admission.requestAdmission({
      ...request("one", "oversized-generation"),
      generation: 2_147_483_648,
    })).rejects.toMatchObject({ code: "INVALID_ADMISSION_REQUEST" });
  });
});
