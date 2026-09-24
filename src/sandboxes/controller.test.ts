import { afterEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { up as addSandboxController } from "../db/migrations/add-sandbox-controller";
import * as schema from "../db/schema";
import {
  SandboxController,
  type SandboxProviderDispatcher,
  type SandboxProviderOutcome,
  type SandboxProviderRequest,
} from "./controller";

class FakeProvider implements SandboxProviderDispatcher {
  readonly dispatches: SandboxProviderRequest[] = [];
  readonly inspections: Array<SandboxProviderRequest & { providerOperationId: string | null }> = [];
  dispatchHandler: (request: SandboxProviderRequest) => Promise<SandboxProviderOutcome> = async () => ({
    outcome: "SUCCEEDED",
    observedState: "RUNNING",
  });
  inspectHandler: (
    request: SandboxProviderRequest & { providerOperationId: string | null },
  ) => Promise<SandboxProviderOutcome> = async () => ({ outcome: "UNKNOWN" });

  async dispatch(request: SandboxProviderRequest): Promise<SandboxProviderOutcome> {
    this.dispatches.push(request);
    return this.dispatchHandler(request);
  }

  async inspectOperation(
    request: SandboxProviderRequest & { providerOperationId: string | null },
  ): Promise<SandboxProviderOutcome> {
    this.inspections.push(request);
    return this.inspectHandler(request);
  }
}

const databases: PGlite[] = [];

async function setup(projectId: string) {
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
  await db.insert(schema.projects).values({ id: projectId, name: projectId, path: `/work/${projectId}` });
  return { pglite, db };
}

async function binding(controller: SandboxController, projectId: string, id = `binding-${projectId}`) {
  return controller.createBinding({
    id,
    projectId,
    providerInstallationId: "provider-installation",
    providerReleaseId: "provider-release",
    connectionId: "connection",
    resourceKey: `resource-${projectId}`,
  });
}

afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close().catch(() => {})));
});

describe("SandboxController durable dispatch", () => {
  test("a reserved UUID is journaled exactly and replay keeps the first receipt", async () => {
    const { db } = await setup("reserved-id");
    const controller = new SandboxController(db, new FakeProvider());
    const createdBinding = await binding(controller, "reserved-id");
    const request = { bindingId: createdBinding.id, kind: "DESTROY" as const,
      generation: 1, idempotencyScope: "incus-qualification",
      idempotencyKey: "fixture:destroy", payload: { expectedGeneration: 1 } };
    const reservedId = "11111111-1111-4111-8111-111111111111";
    await expect(controller.journalOperation(request, "not-a-uuid")).rejects.toThrow("canonical UUID v4");
    expect(await db.select().from(schema.sandboxOperations)).toEqual([]);
    const first = await controller.journalOperation(request, reservedId);
    expect(first.id).toBe(reservedId);
    const replay = await controller.journalOperation(request, "22222222-2222-4222-8222-222222222222");
    expect(replay.id).toBe(reservedId);
    expect(await db.select().from(schema.sandboxOperations)).toHaveLength(1);
  });

  test("journals before dispatch and enforces scoped payload idempotency", async () => {
    const { db } = await setup("journal");
    const provider = new FakeProvider();
    const controller = new SandboxController(db, provider);
    const createdBinding = await binding(controller, "journal");
    provider.dispatchHandler = async (request) => {
      expect((await controller.getOperation(request.operationId))?.state).toBe("DISPATCHING");
      return { outcome: "SUCCEEDED", observedState: "RUNNING" };
    };
    const request = {
      bindingId: createdBinding.id,
      kind: "START" as const,
      generation: 1,
      idempotencyScope: "lifecycle",
      idempotencyKey: "request-1",
      payload: { cpu: 2, labels: { owner: "project" } },
    };

    const first = await controller.requestAndDispatch(request);
    const replay = await controller.requestAndDispatch({
      ...request,
      payload: { labels: { owner: "project" }, cpu: 2 },
    });

    expect(first.state).toBe("SUCCEEDED");
    expect(replay.id).toBe(first.id);
    expect(provider.dispatches).toHaveLength(1);
    expect((await controller.getBinding(createdBinding.id))?.observedState).toBe("RUNNING");

    await expect(controller.journalOperation({ ...request, payload: { cpu: 4 } }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });

    const otherScope = await controller.requestAndDispatch({ ...request, idempotencyScope: "maintenance" });
    expect(otherScope.id).not.toBe(first.id);
    expect(provider.dispatches).toHaveLength(2);
  });

  test("returns the original idempotency receipt after the binding generation advances", async () => {
    const { db } = await setup("generation-replay");
    const provider = new FakeProvider();
    const controller = new SandboxController(db, provider);
    const createdBinding = await binding(controller, "generation-replay");
    const request = {
      bindingId: createdBinding.id,
      kind: "START" as const,
      generation: 1,
      idempotencyScope: "lifecycle",
      idempotencyKey: "start-generation-1",
      payload: { reason: "initial" },
    };
    const original = await controller.requestAndDispatch(request);
    await controller.advanceGeneration(createdBinding.id, 1);

    const replay = await controller.requestAndDispatch(request);

    expect(replay.id).toBe(original.id);
    expect(replay.state).toBe("SUCCEEDED");
    expect(provider.dispatches).toHaveLength(1);
    await expect(controller.journalOperation({ ...request, payload: { reason: "changed" } }))
      .rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
  });

  test("preserves a lost response as OUTCOME_UNKNOWN and restart reconciliation does not redispatch", async () => {
    const { db } = await setup("lost-response");
    const firstProvider = new FakeProvider();
    const firstController = new SandboxController(db, firstProvider);
    const createdBinding = await binding(firstController, "lost-response");
    firstProvider.dispatchHandler = async () => {
      throw new Error("connection closed after provider accepted request");
    };

    const uncertain = await firstController.requestAndDispatch({
      bindingId: createdBinding.id,
      kind: "CREATE",
      generation: 1,
      idempotencyScope: "lifecycle",
      idempotencyKey: "create-1",
      payload: { image: "fixture" },
    });
    expect(uncertain.state).toBe("OUTCOME_UNKNOWN");
    expect(firstProvider.dispatches).toHaveLength(1);

    const restartedProvider = new FakeProvider();
    restartedProvider.inspectHandler = async () => {
      throw new Error("provider unavailable during inspection");
    };
    const restartedController = new SandboxController(db, restartedProvider);
    const result = await restartedController.reconcile();

    expect(result).toEqual(expect.objectContaining({ examined: 1, dispatched: 0, inspected: 1, preservedUnknown: 1 }));
    expect(restartedProvider.dispatches).toHaveLength(0);
    expect(restartedProvider.inspections).toHaveLength(1);
    expect((await restartedController.getOperation(uncertain.id))?.state).toBe("OUTCOME_UNKNOWN");
  });

  test("fails a stale journal without provider dispatch", async () => {
    const { db } = await setup("stale");
    const provider = new FakeProvider();
    const controller = new SandboxController(db, provider);
    const createdBinding = await binding(controller, "stale");
    const operation = await controller.journalOperation({
      bindingId: createdBinding.id,
      kind: "START",
      generation: 1,
      idempotencyScope: "lifecycle",
      idempotencyKey: "start-old-generation",
      payload: {},
    });
    await controller.advanceGeneration(createdBinding.id, 1);

    await expect(controller.executeOperation(operation.id))
      .rejects.toMatchObject({ code: "STALE_GENERATION" });

    expect(provider.dispatches).toHaveLength(0);
    expect((await controller.getOperation(operation.id))?.state).toBe("FAILED");
    expect((await controller.getBinding(createdBinding.id))?.observedState).toBe("UNKNOWN");
  });

  test("inspects an interrupted dispatch and fences its observation after generation advances", async () => {
    const { db } = await setup("interrupted-dispatch");
    const initialProvider = new FakeProvider();
    const initialController = new SandboxController(db, initialProvider);
    const createdBinding = await binding(initialController, "interrupted-dispatch");
    const operation = await initialController.journalOperation({
      bindingId: createdBinding.id,
      kind: "START",
      generation: 1,
      idempotencyScope: "lifecycle",
      idempotencyKey: "interrupted-start",
      payload: {},
    });
    // Simulate process death after the durable claim and possible provider call,
    // but before the provider response can be recorded.
    await db.update(schema.sandboxOperations).set({ state: "DISPATCHING" })
      .where(eq(schema.sandboxOperations.id, operation.id));
    await initialController.advanceGeneration(createdBinding.id, 1);

    const restartedProvider = new FakeProvider();
    restartedProvider.inspectHandler = async () => ({ outcome: "SUCCEEDED", observedState: "RUNNING" });
    const restartedController = new SandboxController(db, restartedProvider);
    const result = await restartedController.reconcile();

    expect(result).toEqual(expect.objectContaining({ examined: 1, dispatched: 0, inspected: 1, completed: 1 }));
    expect(restartedProvider.dispatches).toHaveLength(0);
    expect(restartedProvider.inspections[0]?.generation).toBe(1);
    expect((await restartedController.getOperation(operation.id))?.state).toBe("SUCCEEDED");
    expect(await restartedController.getBinding(createdBinding.id)).toEqual(expect.objectContaining({
      generation: 2,
      observedState: "UNKNOWN",
    }));
  });

  test("does not let a late dispatch result replace a terminal recovered outcome", async () => {
    const { db } = await setup("late-dispatch-result");
    const dispatchProvider = new FakeProvider();
    const controller = new SandboxController(db, dispatchProvider);
    const createdBinding = await binding(controller, "late-dispatch-result");
    let signalDispatchStarted!: () => void;
    const dispatchStarted = new Promise<void>((resolve) => {
      signalDispatchStarted = resolve;
    });
    let releaseDispatch!: () => void;
    const dispatchCanFinish = new Promise<void>((resolve) => {
      releaseDispatch = resolve;
    });
    dispatchProvider.dispatchHandler = async () => {
      signalDispatchStarted();
      await dispatchCanFinish;
      return { outcome: "SUCCEEDED", observedState: "STOPPED" };
    };

    const dispatch = controller.requestAndDispatch({
      bindingId: createdBinding.id,
      kind: "START",
      generation: 1,
      idempotencyScope: "lifecycle",
      idempotencyKey: "concurrent-recovery",
      payload: {},
    });
    await dispatchStarted;

    const recoveryProvider = new FakeProvider();
    recoveryProvider.inspectHandler = async () => ({ outcome: "SUCCEEDED", observedState: "RUNNING" });
    const recoveryController = new SandboxController(db, recoveryProvider);
    const recovery = await recoveryController.reconcile();
    releaseDispatch();
    const completed = await dispatch;

    expect(recovery).toEqual(expect.objectContaining({ examined: 1, inspected: 1, completed: 1 }));
    expect(completed.state).toBe("SUCCEEDED");
    expect((await controller.getOperation(completed.id))?.state).toBe("SUCCEEDED");
    expect((await controller.getBinding(createdBinding.id))?.observedState).toBe("RUNNING");
  });

  test("bounds each reconciliation batch", async () => {
    const { db } = await setup("bounded");
    const initialProvider = new FakeProvider();
    initialProvider.dispatchHandler = async () => {
      throw new Error("lost response");
    };
    const initialController = new SandboxController(db, initialProvider);
    const createdBinding = await binding(initialController, "bounded");
    for (let index = 0; index < 3; index++) {
      await initialController.requestAndDispatch({
        bindingId: createdBinding.id,
        kind: "START",
        generation: 1,
        idempotencyScope: "bounded",
        idempotencyKey: `request-${index}`,
        payload: { index },
      });
    }

    const restartedProvider = new FakeProvider();
    const restartedController = new SandboxController(db, restartedProvider, { maxReconcileBatch: 2 });
    const result = await restartedController.reconcile(1000);

    expect(result.examined).toBe(2);
    expect(result.inspected).toBe(1);
    expect(restartedProvider.inspections).toHaveLength(1);
    expect(restartedProvider.dispatches).toHaveLength(0);
    expect(initialProvider.dispatches).toHaveLength(1);
  });

  test("rotates an unresolved operation so a later journal is dispatched", async () => {
    const { db } = await setup("reconcile-fairness");
    const provider = new FakeProvider();
    const controller = new SandboxController(db, provider, { maxReconcileBatch: 1 });
    const createdBinding = await binding(controller, "reconcile-fairness");
    await db.insert(schema.projects).values({
      id: "reconcile-fairness-other",
      name: "reconcile-fairness-other",
      path: "/work/reconcile-fairness-other",
    });
    const otherBinding = await binding(controller, "reconcile-fairness-other");
    provider.dispatchHandler = async () => { throw new Error("lost response"); };
    const unresolved = await controller.requestAndDispatch({
      bindingId: createdBinding.id,
      kind: "START",
      generation: 1,
      idempotencyScope: "fairness",
      idempotencyKey: "first",
      payload: {},
    });
    const later = await controller.journalOperation({
      bindingId: otherBinding.id,
      kind: "START",
      generation: 1,
      idempotencyScope: "fairness",
      idempotencyKey: "second",
      payload: {},
    });
    provider.dispatchHandler = async () => ({ outcome: "SUCCEEDED", observedState: "RUNNING" });

    const first = await controller.reconcile();
    const restartedController = new SandboxController(db, provider, { maxReconcileBatch: 1 });
    const second = await restartedController.reconcile();

    expect(first.examined).toBe(1);
    expect(second.examined).toBe(1);
    expect((await controller.getOperation(unresolved.id))?.state).toBe("OUTCOME_UNKNOWN");
    expect((await controller.getOperation(later.id))?.state).toBe("SUCCEEDED");
    expect(provider.dispatches).toHaveLength(2);
  });

  test("does not apply a late STOP observation after same-generation START", async () => {
    const { db } = await setup("late-stop");
    const provider = new FakeProvider();
    const controller = new SandboxController(db, provider);
    const createdBinding = await binding(controller, "late-stop");
    provider.dispatchHandler = async (request) => request.kind === "STOP"
      ? { outcome: "UNKNOWN" }
      : { outcome: "SUCCEEDED", observedState: "RUNNING" };
    const stop = await controller.requestAndDispatch({
      bindingId: createdBinding.id,
      kind: "STOP",
      generation: 1,
      idempotencyScope: "lifecycle",
      idempotencyKey: "stop",
      payload: {},
    });
    await controller.requestAndDispatch({
      bindingId: createdBinding.id,
      kind: "START",
      generation: 1,
      idempotencyScope: "lifecycle",
      idempotencyKey: "restart",
      payload: {},
    });
    provider.inspectHandler = async () => ({ outcome: "SUCCEEDED", observedState: "STOPPED" });

    await controller.reconcile();

    expect((await controller.getOperation(stop.id))?.state).toBe("SUCCEEDED");
    expect((await controller.getBinding(createdBinding.id))?.observedState).toBe("RUNNING");
  });

  test("does not dispatch an old START journal after confirmed cleanup", async () => {
    const { db } = await setup("cleanup-supersedes-start");
    const provider = new FakeProvider();
    const controller = new SandboxController(db, provider);
    const createdBinding = await binding(controller, "cleanup-supersedes-start");
    const oldStart = await controller.journalOperation({
      bindingId: createdBinding.id,
      kind: "START",
      generation: 1,
      idempotencyScope: "lifecycle",
      idempotencyKey: "old-start",
      payload: {},
    });
    provider.dispatchHandler = async () => ({ outcome: "SUCCEEDED", observedState: "ABSENT" });
    const destroyInput = {
      bindingId: createdBinding.id,
      kind: "DESTROY" as const,
      generation: 1,
      idempotencyScope: "cleanup",
      idempotencyKey: "destroy",
      payload: {},
    };
    const destroy = await controller.requestAndDispatch(destroyInput);
    const replay = await controller.requestAndDispatch(destroyInput);

    await expect(controller.executeOperation(oldStart.id)).rejects.toMatchObject({
      code: "SUPERSEDED_OPERATION",
    });

    expect(destroy.state).toBe("SUCCEEDED");
    expect(replay.id).toBe(destroy.id);
    expect(provider.dispatches).toHaveLength(1);
    expect((await controller.getOperation(oldStart.id))?.state).toBe("FAILED");
    expect(await controller.getBinding(createdBinding.id)).toEqual(expect.objectContaining({
      desiredState: "ABSENT",
      observedState: "ABSENT",
      cleanupConfirmedAt: expect.any(Date),
    }));
  });

  test("waits for an in-flight CREATE before confirming DESTROY", async () => {
    const { db } = await setup("inflight-create-cleanup");
    const provider = new FakeProvider();
    const controller = new SandboxController(db, provider);
    const createdBinding = await binding(controller, "inflight-create-cleanup");
    let backendState = "ABSENT";
    let signalCreateStarted!: () => void;
    const createStarted = new Promise<void>((resolve) => { signalCreateStarted = resolve; });
    let releaseCreate!: () => void;
    const createCanFinish = new Promise<void>((resolve) => { releaseCreate = resolve; });
    provider.dispatchHandler = async (request) => {
      if (request.kind === "CREATE") {
        signalCreateStarted();
        await createCanFinish;
        backendState = "RUNNING";
        return { outcome: "SUCCEEDED", observedState: "RUNNING" };
      }
      backendState = "ABSENT";
      return { outcome: "SUCCEEDED", observedState: "ABSENT" };
    };
    const create = controller.requestAndDispatch({
      bindingId: createdBinding.id,
      kind: "CREATE",
      generation: 1,
      idempotencyScope: "lifecycle",
      idempotencyKey: "create",
      payload: {},
    });
    await createStarted;
    const destroy = await controller.requestAndDispatch({
      bindingId: createdBinding.id,
      kind: "DESTROY",
      generation: 1,
      idempotencyScope: "cleanup",
      idempotencyKey: "destroy",
      payload: {},
    });
    const beforeCreateSettles = await controller.getBinding(createdBinding.id);
    releaseCreate();
    await create;
    const afterCreateSettles = await controller.getBinding(createdBinding.id);
    const restartedController = new SandboxController(db, provider);
    await restartedController.reconcile();

    expect(destroy.state).toBe("JOURNALED");
    expect(beforeCreateSettles?.cleanupConfirmedAt).toBeNull();
    expect(afterCreateSettles?.cleanupConfirmedAt).toBeNull();
    expect(backendState).toBe("ABSENT");
    expect((await controller.getBinding(createdBinding.id))?.cleanupConfirmedAt).toBeInstanceOf(Date);
    expect(provider.dispatches.map((request) => request.kind)).toEqual(["CREATE", "DESTROY"]);
  });

  test("reapplied migration recovers a pending legacy DESTROY intent", async () => {
    const { db, pglite } = await setup("legacy-cleanup-recovery");
    const provider = new FakeProvider();
    const controller = new SandboxController(db, provider);
    const createdBinding = await binding(controller, "legacy-cleanup-recovery");
    const destroy = await controller.journalOperation({
      bindingId: createdBinding.id,
      kind: "DESTROY",
      generation: 1,
      idempotencyScope: "cleanup",
      idempotencyKey: "legacy-destroy",
      payload: {},
    });
    await pglite.exec("ALTER TABLE sandbox_bindings DROP COLUMN current_operation_id");
    await pglite.exec("ALTER TABLE provider_sandbox_operations DROP COLUMN reconcile_order CASCADE");
    await addSandboxController(db);
    provider.dispatchHandler = async () => ({ outcome: "SUCCEEDED", observedState: "ABSENT" });

    await controller.reconcile();

    expect((await controller.getBinding(createdBinding.id))?.currentOperationId).toBe(destroy.id);
    expect((await controller.getOperation(destroy.id))?.state).toBe("SUCCEEDED");
    expect((await controller.getBinding(createdBinding.id))?.cleanupConfirmedAt).toBeInstanceOf(Date);
  });

  test("keeps cleanup pending while an earlier provider outcome is unknown", async () => {
    const { db } = await setup("unknown-create-cleanup");
    const provider = new FakeProvider();
    const controller = new SandboxController(db, provider);
    const createdBinding = await binding(controller, "unknown-create-cleanup");
    provider.dispatchHandler = async (request) => request.kind === "CREATE"
      ? { outcome: "UNKNOWN" }
      : { outcome: "SUCCEEDED", observedState: "ABSENT" };
    const create = await controller.requestAndDispatch({
      bindingId: createdBinding.id,
      kind: "CREATE",
      generation: 1,
      idempotencyScope: "lifecycle",
      idempotencyKey: "unknown-create",
      payload: {},
    });
    const destroy = await controller.requestAndDispatch({
      bindingId: createdBinding.id,
      kind: "DESTROY",
      generation: 1,
      idempotencyScope: "cleanup",
      idempotencyKey: "destroy-after-unknown",
      payload: {},
    });

    await controller.reconcile();
    expect((await controller.getOperation(create.id))?.state).toBe("OUTCOME_UNKNOWN");
    expect((await controller.getOperation(destroy.id))?.state).toBe("JOURNALED");
    expect((await controller.getBinding(createdBinding.id))?.cleanupConfirmedAt).toBeNull();
    expect(provider.dispatches.map((request) => request.kind)).toEqual(["CREATE"]);

    provider.inspectHandler = async () => ({ outcome: "SUCCEEDED", observedState: "RUNNING" });
    await controller.reconcile();
    expect((await controller.getOperation(destroy.id))?.state).toBe("SUCCEEDED");
    expect((await controller.getBinding(createdBinding.id))?.cleanupConfirmedAt).toBeInstanceOf(Date);
    expect(provider.dispatches.map((request) => request.kind)).toEqual(["CREATE", "DESTROY"]);
  });

  test("keeps a cleanup tombstone after provider absence is confirmed", async () => {
    const { db } = await setup("cleanup");
    const firstProvider = new FakeProvider();
    firstProvider.dispatchHandler = async () => {
      throw new Error("destroy response lost");
    };
    const firstController = new SandboxController(db, firstProvider);
    const createdBinding = await binding(firstController, "cleanup");
    await firstController.requestAndDispatch({
      bindingId: createdBinding.id,
      kind: "DESTROY",
      generation: 1,
      idempotencyScope: "cleanup",
      idempotencyKey: "destroy-1",
      payload: {},
    });
    expect((await firstController.getBinding(createdBinding.id))?.tombstonedAt).toBeInstanceOf(Date);

    const restartedProvider = new FakeProvider();
    restartedProvider.inspectHandler = async () => ({ outcome: "SUCCEEDED", observedState: "ABSENT" });
    const restartedController = new SandboxController(db, restartedProvider);
    await restartedController.reconcile();
    const cleaned = await restartedController.getBinding(createdBinding.id);

    expect(cleaned?.observedState).toBe("ABSENT");
    expect(cleaned?.tombstonedAt).toBeInstanceOf(Date);
    expect(cleaned?.cleanupConfirmedAt).toBeInstanceOf(Date);
    await expect(restartedController.requestAndDispatch({
      bindingId: createdBinding.id,
      kind: "START",
      generation: 1,
      idempotencyScope: "lifecycle",
      idempotencyKey: "start-after-cleanup",
      payload: {},
    })).rejects.toMatchObject({ code: "BINDING_TOMBSTONED" });
    await expect(restartedController.requestAndDispatch({
      bindingId: createdBinding.id,
      kind: "DESTROY",
      generation: 1,
      idempotencyScope: "cleanup",
      idempotencyKey: "destroy-again",
      payload: {},
    })).rejects.toMatchObject({ code: "BINDING_TOMBSTONED" });
    expect(restartedProvider.dispatches).toHaveLength(0);
    expect((await restartedController.getBinding(createdBinding.id))?.cleanupConfirmedAt).toEqual(
      cleaned?.cleanupConfirmedAt,
    );
  });
});
