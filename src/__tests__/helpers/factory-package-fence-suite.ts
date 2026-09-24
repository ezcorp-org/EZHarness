/**
 * The package quarantine fence (C05, W02c), against one isolated database per case.
 *
 * Every case drives a real run through the real kernel and stores to the state
 * it needs (compute admitted, attempt admitted, attempt launched), then takes a
 * trust decision through the production trust store composed with the
 * production fence, exactly as the product composes it.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import type { ResourceLimits, Runner, WorkspaceFiles } from "@ezcorp/extension-contract";
import { advanceKernel, referenceCodeV1, type FactoryRunnerRequest, type KernelEvent, type RunnerReference } from "@ezcorp/factory-sdk";
import { sql } from "drizzle-orm";
import type { TransactionalDb } from "../../db/migrations/types";
import { DatabaseLifecycleRepository, releaseRows as rows } from "../../db/queries/extension-releases";
import { digestObject } from "../../extensions/v4/blobs";
import type { BlobStore } from "../../extensions/v4/types";
import { FactoryAttemptDispatcher } from "../../factory/attempt-dispatcher";
import { FactoryGrants, type FactoryPrincipal } from "../../factory/grants";
import { FactoryNativeRunnerPolicy } from "../../factory/native-runner-policy";
import { createFactoryPackageTrusts, FACTORY_PACKAGE_FENCE_MAX_LIMIT, FactoryPackageFence } from "../../factory/package-fence";
import { FactoryPackageBlockedError, FactoryPackagePreparations, FactoryPackageTrusts, FactoryV4PackageCatalog, factoryPackageDispatchDisposition } from "../../factory/package-preparation";
import { factoryAttemptPreflight } from "../../factory/runner/attempt-preflight";
import type { FactoryTaskResourceProfile } from "../../factory/task-admission";
import { createFactoryLiveAttemptWorld, type FactoryDispatchableRun, type FactoryLiveAttemptWorld } from "./factory-live-attempt-world";
import { factoryPackageRelease } from "./factory-package-preparation-suite";

export interface FactoryPackageFenceFixture { db: TransactionalDb; blobs?: BlobStore; close(): Promise<void> }

const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

export function factoryPackageFenceConformance(create: () => Promise<FactoryPackageFenceFixture>): void {
  const now = Date.UTC(2030, 0, 1);
  const tenantId = "fence-tenant";
  const projectId = "fence-project";
  const hostId = "fence-host";
  const principal: FactoryPrincipal = { kind: "user", id: "fence-owner", authentication: "session" };
  const service = { tenantId, subject: "orchestration" };
  const profile: FactoryTaskResourceProfile = { resources: { cpu: 1 }, memoryBytes: 128, budget: { costMicros: "5", tokens: 6, computeMs: 7 } };
  const limits: ResourceLimits = { memoryBytes: 64 * 1024 * 1024, cpuMillis: 1000, pids: 16, tmpBytes: 1024 * 1024, outputBytes: 1024 * 1024, timeoutMs: 10_000 };
  const installationId = "fence-installation";
  // The reference factory's first task, which is the attempt every run below dispatches.
  const firstTask = referenceCodeV1.graph.nodes[0]!;
  if (firstTask.kind !== "task") throw new Error("the reference factory's first node is not a task");
  const reference: RunnerReference = firstTask.runner;
  // The package's built bytes, already in the runner's store, so a preparation
  // verifies them and never builds.
  const artifacts: WorkspaceFiles = { "extension.ts": "export {};", ".runner/recipe.json": "{}" };
  const cachedRunner: Pick<Runner, "build" | "collectArtifacts"> = {
    async build() { throw new Error("the fence suite never builds a package"); },
    async collectArtifacts() { return structuredClone(artifacts); },
  };

  let fixture: FactoryPackageFenceFixture;
  let world: FactoryLiveAttemptWorld;
  let repository: DatabaseLifecycleRepository;
  let trusts: FactoryPackageTrusts;
  let preparations: FactoryPackagePreparations;
  let fence: FactoryPackageFence;

  beforeEach(async () => {
    fixture = await create();
    world = await createFactoryLiveAttemptWorld(fixture, { label: "fence", tenantId, projectId, principal, factoryId: "fence-factory", hostId, now, profile, service, hostKeys });
    repository = new DatabaseLifecycleRepository(fixture.db);
    const release = factoryPackageRelease(reference, "c".repeat(64), digestObject(artifacts), installationId, "fence-release");
    await repository.create({
      installation: { id: installationId, ownerId: principal.id, scope: `project:${projectId}`, generation: 1, activeReleaseId: release.id, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 1 },
      workspaces: {}, revisions: {}, operations: {}, releases: { [release.id]: release }, approvals: {},
    });
    trusts = createFactoryPackageTrusts(fixture.db, tenantId, world.grants, () => now);
    preparations = new FactoryPackagePreparations(fixture.db, tenantId, world.grants, trusts, new FactoryV4PackageCatalog(repository, world.objectStore), cachedRunner, limits);
    fence = new FactoryPackageFence(fixture.db, tenantId, world.grants, () => now);
    await preparations.bind(principal, { projectId, reference, installationId, releaseId: release.id }, "fence-bind");
    await trusts.publish(principal, { projectId, reference, expectedRevision: 0 }, "fence-trust");
  });
  afterEach(async () => { await fixture?.close(); });

  const quarantine = (expectedRevision = 1, idempotencyKey = `fence-quarantine-${expectedRevision}`, store = trusts) =>
    store.quarantine(principal, { projectId, reference, expectedRevision }, idempotencyKey);
  const runStatus = async (runId: string) => rows<{ status: string }>(await fixture.db.execute(sql`SELECT status FROM factory_run_lifecycle WHERE tenant_id=${tenantId} AND run_id=${runId}`))[0]?.status;
  const cancelEvents = async (runId: string) => rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${runId} ORDER BY sequence`))
    .map(row => JSON.parse(row.payload) as KernelEvent).filter(event => event.kind === "cancel");
  const executions = async (runId: string) => rows<{ attempt_id: string; status: string }>(await fixture.db.execute(sql`SELECT attempt_id, status FROM factory_executions WHERE tenant_id=${tenantId} AND run_id=${runId} ORDER BY attempt_id`));
  const affected = (options?: Parameters<FactoryPackageFence["affectedRuns"]>[3]) => fence.affectedRuns(principal, projectId, reference, options);
  const blocked = (code: "factory_package_quarantined" | "factory_package_revoked", trustRevision: number, installationGeneration = 1) => ({ name: "FactoryPackageBlockedError", code, trustRevision, installationGeneration });
  /** Settles `promise` into an outcome without letting either branch escape the test. */
  const settle = <T>(promise: Promise<T>) => promise.then(value => ({ ok: true as const, value }), (error: unknown) => ({ ok: false as const, error }));

  test("quarantine stops a launched attempt through the ordinary cancel and W03's stop path, with the typed reason, and records the run", async () => {
    const attempt = await world.launchedAttempt();
    const runId = attempt.run.runId;
    const attemptStatus = (await executions(runId))[0]!.status;
    // The preview is the same query the fence acts on.
    expect(await fence.preview(principal, projectId, reference)).toEqual([{ runId, attemptId: attempt.attemptId, attemptStatus: attemptStatus as "admitted", launchState: "launched" }]);

    const decision = await quarantine();
    expect(decision).toMatchObject({ state: "quarantined", revision: 2, installationGeneration: 1 });
    expect(await runStatus(runId)).toBe("cancelling");
    const [cancel] = await cancelEvents(runId);
    expect(cancel).toMatchObject({ kind: "cancel", reason: "factory_package_quarantined" });
    // Attributed to the human who quarantined, under the operator cancel's own audit action.
    const audit = rows<{ user_id: string | null; metadata: unknown }>(await fixture.db.execute(sql`SELECT user_id, metadata FROM audit_log WHERE id=${cancel!.id}`))[0]!;
    expect(audit.user_id).toBe(principal.id);
    expect(typeof audit.metadata === "string" ? JSON.parse(audit.metadata) : audit.metadata).toMatchObject({ reason: "factory_package_quarantined", principalId: principal.id });

    // The kernel answers the cancel with a cancel-node, which W03's stop path settles unchanged.
    const { reference: cancelNode, advanced } = await world.commitCancel(attempt);
    const { stops } = world.stopHarness(attempt, world.countingStopper(async request => world.signedStop(request)), world.settlingPool());
    const receipt = await stops.stop(service, cancelNode);
    expect(receipt.state).toBe("stopped");
    expect(receipt.stopReceipt).toMatchObject({ processGroupAbsent: true, hostId, attemptId: attempt.attemptId });
    expect(await executions(runId)).toEqual([{ attempt_id: attempt.attemptId, status: "stopped" }]);

    // The kernel carries the typed reason as the run's stop reason; its closing
    // `cancel-run`, and so the run's public error, names it. The run finishes
    // once W03's usage reconciliation settles the stopped attempt's hold, which
    // the real-server proof measures end to end.
    expect(advanced.nextState).toMatchObject({ status: "stopping", stopKind: "cancelled", stopReason: "factory_package_quarantined" });
    expect(advanceKernel(attempt.compiled, advanced.nextState, receipt.event).nextState.stopReason).toBe("factory_package_quarantined");

    // The affected-run record names the run, the decision, and what the fence did.
    const page = await affected();
    expect(page.nextCursor).toBeUndefined();
    expect(page.items).toEqual([expect.objectContaining({
      projectId, reference, runId, attemptId: attempt.attemptId, attemptStatus, launchState: "launched", trustRevision: 2,
      state: "quarantined", reason: "factory_package_quarantined", disposition: "cancel-requested", cancellationEventId: cancel!.id, recordedAtMs: now,
    })]);
    expect(page.items[0]!.recordDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  test("an admitted attempt that has not launched is refused at launch by name, and its run is still cancelled", async () => {
    const run = await world.dispatchable();
    const request = await world.admitAttempt(run);
    // The launch window: the quarantine commits after the dispatcher's durable
    // claim and before its readiness read. The dispatcher refuses by name,
    // before any token is minted or any runner is called.
    let runnerCalls = 0;
    const racing = { async assertDispatchReady(value: Pick<FactoryRunnerRequest, "authority" | "runner">) { await quarantine(); return preparations.assertDispatchReady(value); } };
    const unread = { async readInTransaction() { return undefined; } };
    const dispatcher = new FactoryAttemptDispatcher(fixture.db, run.queue, { async run() { runnerCalls++; throw new Error("a blocked package never reaches a runner"); } },
      { ...unread, async completeInTransaction() { throw new Error("unreachable"); } } as never, { ...unread, async recordInTransaction() { throw new Error("unreachable"); } } as never,
      racing, factoryPackageDispatchDisposition, { service, installationId, attemptTokenSecret: "fence-secret" });
    const dispatched = await dispatcher.dispatchOne();
    expect(dispatched).toMatchObject({ kind: "cancelled", attemptId: request.authority.attemptId, cause: blocked("factory_package_quarantined", 2) });
    expect(runnerCalls).toBe(0);
    expect(await run.queue.read(projectId, request.authority.attemptId)).toMatchObject({ state: "cancelled", failureCode: "factory_package_quarantined" });
    // Once the run is cancelling, the queue hands the attempt to no dispatcher at all.
    expect(await dispatcher.dispatchOne()).toEqual({ kind: "idle" });
    // The preflight and the launch readiness read refuse with the same typed error.
    const preflight = factoryAttemptPreflight({ database: fixture.db, queue: run.queue, admissions: run.admissions, readiness: preparations, hostId });
    await expect(preflight.preparedPackage(request)).rejects.toMatchObject(blocked("factory_package_quarantined", 2));
    await expect(preparations.assertDispatchReady(request)).rejects.toBeInstanceOf(FactoryPackageBlockedError);
    // The run was cancelled with the reason, and the record says the attempt never launched.
    expect(await runStatus(run.run.runId)).toBe("cancelling");
    expect((await affected()).items).toEqual([expect.objectContaining({ runId: run.run.runId, attemptId: request.authority.attemptId, attemptStatus: "admitted", launchState: null, disposition: "cancel-requested" })]);
  });

  test("admission refuses a quarantined package by name; lifting it re-admits only new attempts and leaves stopped runs stopped", async () => {
    const stopped = await world.launchedAttempt();
    const waiting = await world.dispatchable();
    await quarantine();
    await expect(world.admitAttempt(waiting, trusts)).rejects.toMatchObject(blocked("factory_package_quarantined", 2));
    expect(await executions(waiting.run.runId)).toEqual([]);
    // A run with no live attempt is not cancelled; it waits at admission.
    expect(await runStatus(waiting.run.runId)).not.toBe("cancelling");

    const lifted = await trusts.publish(principal, { projectId, reference, expectedRevision: 2 }, "fence-lift");
    expect(lifted).toMatchObject({ state: "active", revision: 3 });
    const admitted = await world.admitAttempt(waiting, trusts);
    expect(admitted.runner).toEqual(reference);
    expect(await executions(waiting.run.runId)).toEqual([{ attempt_id: admitted.authority.attemptId, status: "admitted" }]);

    // The stopped run keeps its reason and its one cancel; the lift fenced nothing.
    expect(await runStatus(stopped.run.runId)).toBe("cancelling");
    expect((await cancelEvents(stopped.run.runId)).map(event => event.kind === "cancel" && event.reason)).toEqual(["factory_package_quarantined"]);
    expect((await affected()).items.map(item => [item.runId, item.trustRevision])).toEqual([[stopped.run.runId, 2]]);
    expect((await affected({ trustRevision: 3 })).items).toEqual([]);
  });

  test("a quarantine racing an admission has one winner: the attempt is refused, or it is admitted and fenced", async () => {
    const outcomes = new Set<string>();
    let revision = 1;
    for (let round = 0; round < 3; round++) {
      const run = await world.dispatchable();
      const [decided, admission] = await Promise.all([settle(quarantine(revision, `fence-race-${round}`)), settle(world.admitAttempt(run, trusts))]);
      expect(decided.ok).toBe(true);
      revision += 1;
      const recorded = (await affected({ trustRevision: revision })).items.filter(item => item.runId === run.run.runId);
      if (admission.ok) {
        // Admitted first: the quarantine saw the attempt and cancelled its run.
        expect(recorded.map(item => item.attemptId)).toEqual([(admission.value as FactoryRunnerRequest).authority.attemptId]);
        expect(await runStatus(run.run.runId)).toBe("cancelling");
        outcomes.add("admitted-then-fenced");
      } else {
        // Quarantined first: nothing was admitted, so there is nothing to fence.
        expect(admission.error).toMatchObject(blocked("factory_package_quarantined", revision));
        expect(await executions(run.run.runId)).toEqual([]);
        expect(recorded).toEqual([]);
        outcomes.add("refused");
      }
      await trusts.publish(principal, { projectId, reference, expectedRevision: revision }, `fence-race-lift-${round}`);
      revision += 1;
    }
    expect(outcomes.size).toBeGreaterThan(0);
  });

  test("a quarantine racing a launch has one winner: the launch is refused, or it proceeds on a run that is already being cancelled", async () => {
    // Prepared, so a launch that reads trust before the quarantine commits passes.
    await preparations.prepare(projectId, reference);
    const run = await world.dispatchable();
    const request = await world.admitAttempt(run);
    const [decided, launch] = await Promise.all([settle(quarantine()), settle(preparations.assertDispatchReady(request))]);
    expect(decided.ok).toBe(true);
    if (!launch.ok) expect(launch.error).toMatchObject(blocked("factory_package_quarantined", 2));
    else expect(launch.value).toMatchObject({ reference });
    // Either way the admitted attempt is fenced and its run cancelled in the quarantine's own commit.
    expect(await runStatus(run.run.runId)).toBe("cancelling");
    expect((await affected()).items.map(item => item.attemptId)).toEqual([request.authority.attemptId]);
    // After the quarantine commits, no launch passes.
    await expect(preparations.assertDispatchReady(request)).rejects.toMatchObject(blocked("factory_package_quarantined", 2));
  });

  test("two quarantines of one revision race: one commits and fences once, the other conflicts", async () => {
    const attempt = await world.launchedAttempt();
    const results = await Promise.all([settle(quarantine(1, "fence-first")), settle(quarantine(1, "fence-second"))]);
    expect(results.filter(result => result.ok)).toHaveLength(1);
    expect(results.find(result => !result.ok)).toMatchObject({ ok: false, error: { code: "factory_package_trust_conflict" } });
    expect(await cancelEvents(attempt.run.runId)).toHaveLength(1);
    expect((await affected()).items).toHaveLength(1);
  });

  test("a lost quarantine response is replayed by its idempotency key and fences nothing twice", async () => {
    const attempt = await world.launchedAttempt();
    const first = await quarantine(1, "fence-lost-response");
    const replay = await quarantine(1, "fence-lost-response");
    expect(replay).toEqual(first);
    expect(await cancelEvents(attempt.run.runId)).toHaveLength(1);
    expect((await affected()).items).toHaveLength(1);
  });

  test("a stop path that dies mid-fence rolls the whole decision back, and a restarted process fences cleanly", async () => {
    const attempt = await world.launchedAttempt();
    const dying = new FactoryPackageTrusts(fixture.db, tenantId, world.grants, {
      async fenceAttempts(transaction, decision) {
        await fence.fenceAttempts(transaction, decision);
        throw new Error("the process died mid-fence");
      },
    });
    await expect(quarantine(1, "fence-dies", dying)).rejects.toThrow("the process died mid-fence");
    // Nothing of the decision survives: trust is active, the run is live, no record exists.
    await expect(fixture.db.transaction(transaction => trusts.readActiveInTransaction(transaction, projectId, reference))).resolves.toMatchObject({ revision: 1, state: "active" });
    expect(await runStatus(attempt.run.runId)).not.toBe("cancelling");
    expect(await cancelEvents(attempt.run.runId)).toEqual([]);
    expect((await affected()).items).toEqual([]);
    // A fresh process composes the store again and the same decision commits once.
    const restarted = createFactoryPackageTrusts(fixture.db, tenantId, world.grants, () => now);
    expect(await quarantine(1, "fence-after-restart", restarted)).toMatchObject({ revision: 2, state: "quarantined" });
    expect(await cancelEvents(attempt.run.runId)).toHaveLength(1);
  });

  test("a crash in the middle of the stop leaves the decision and its record, and the restarted stop settles it", async () => {
    const attempt = await world.launchedAttempt();
    await quarantine();
    const before = await affected();
    const { reference: cancelNode } = await world.commitCancel(attempt);
    // The host never answers: the stop is left durably uncertain, as a crash leaves it.
    const hung = world.stopHarness(attempt, { async stop(_request, signal) { return new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("host unreachable"))); }); } }, world.settlingPool(), undefined, 1);
    expect((await hung.stops.stop(service, cancelNode)).state).toBe("uncertain");
    // Every collaborator is rebuilt from the database, as a restarted process builds them.
    const restartedFence = new FactoryPackageFence(fixture.db, tenantId, new FactoryGrants(fixture.db, tenantId, () => now), () => now);
    expect(await restartedFence.affectedRuns(principal, projectId, reference)).toEqual(before);
    const calls = { count: 0 };
    const settled = await world.stopHarness(attempt, world.countingStopper(async request => world.signedStop(request), calls), world.settlingPool()).stops.stop(service, cancelNode);
    expect(settled.state).toBe("stopped");
    expect(calls.count).toBe(1);
    expect(await runStatus(attempt.run.runId)).toBe("cancelling");
    expect((await cancelEvents(attempt.run.runId)).map(event => event.kind === "cancel" && event.reason)).toEqual(["factory_package_quarantined"]);
  });

  test("a stale revision fences nothing, and a later installation generation does not lift a quarantine", async () => {
    const attempt = await world.launchedAttempt();
    await expect(quarantine(4, "fence-stale")).rejects.toMatchObject({ code: "factory_package_trust_conflict" });
    expect(await cancelEvents(attempt.run.runId)).toEqual([]);
    expect((await affected()).items).toEqual([]);

    await quarantine();
    // The v4 installation moves on. The quarantine still refuses, and names the
    // generation it was decided against rather than the installation's new one.
    await repository.transact(installationId, state => { state.installation.generation += 1; });
    const waiting = await world.dispatchable();
    await expect(world.admitAttempt(waiting, trusts)).rejects.toMatchObject(blocked("factory_package_quarantined", 2, 1));
    // Lifting it is a new decision, fenced to the new generation.
    expect(await trusts.publish(principal, { projectId, reference, expectedRevision: 2 }, "fence-lift-generation")).toMatchObject({ revision: 3, installationGeneration: 2 });
    await expect(world.admitAttempt(waiting, trusts)).resolves.toMatchObject({ runner: reference });
  });

  test("revocation fences with its own typed reason and is terminal for the tuple", async () => {
    const attempt = await world.launchedAttempt();
    expect(await trusts.revoke(principal, { projectId, reference, expectedRevision: 1 }, "fence-revoke")).toMatchObject({ state: "revoked", revision: 2 });
    expect(await cancelEvents(attempt.run.runId)).toEqual([expect.objectContaining({ reason: "factory_package_revoked" })]);
    expect((await affected()).items).toEqual([expect.objectContaining({ runId: attempt.run.runId, state: "revoked", reason: "factory_package_revoked" })]);
    const waiting = await world.dispatchable();
    await expect(world.admitAttempt(waiting, trusts)).rejects.toMatchObject(blocked("factory_package_revoked", 2));
    await expect(trusts.publish(principal, { projectId, reference, expectedRevision: 2 }, "fence-reopen")).rejects.toMatchObject({ code: "factory_package_trust_conflict" });
  });

  test("a run already cancelling keeps its cancel, a finished run is recorded not reopened, and the record pages", async () => {
    const cancelling = await world.launchedAttempt();
    const operator = await world.cancelled(cancelling);
    const finished = await world.launchedAttempt();
    await fixture.db.execute(sql`UPDATE factory_run_lifecycle SET status='failed' WHERE tenant_id=${tenantId} AND run_id=${finished.run.runId}`);
    const operatorCancel = (await cancelEvents(cancelling.run.runId))[0]!;
    await quarantine();
    // No second cancel for the run an operator already stopped, and none for the finished run.
    expect(await cancelEvents(cancelling.run.runId)).toHaveLength(1);
    expect(await cancelEvents(finished.run.runId)).toEqual([]);
    expect(await runStatus(finished.run.runId)).toBe("failed");
    const all = (await affected()).items;
    expect(all.find(item => item.runId === cancelling.run.runId)).toMatchObject({ disposition: "already-cancelling", cancellationEventId: operatorCancel.id });
    expect(all.find(item => item.runId === finished.run.runId)).toMatchObject({ disposition: "run-terminal" });
    expect(all.find(item => item.runId === finished.run.runId)!.cancellationEventId).toBeUndefined();
    expect(operator.reference.commandId).toBeTruthy();
    // Keyset pages neither repeat nor skip.
    const first = await affected({ limit: 1 });
    expect(first.items).toEqual([all[0]]);
    const second = await affected({ limit: 1, after: first.nextCursor! });
    expect(second.items).toEqual([all[1]]);
    expect(second.nextCursor).toBeUndefined();
    expect((await affected({ after: second.items[0]! })).items).toEqual([]);
  });

  test("another tenant's fence, decision, or reader is refused before it reads anything", async () => {
    const attempt = await world.launchedAttempt();
    await quarantine();
    const otherGrants = new FactoryGrants(fixture.db, "fence-other", () => now);
    expect(() => new FactoryPackageFence(fixture.db, "fence-other", world.grants)).toThrow("factory_package_scope");
    await expect(fixture.db.transaction(transaction => fence.fenceAttempts(transaction, { tenantId: "fence-other", projectId, reference, state: "quarantined", trustRevision: 2, installationGeneration: 1, actor: principal })))
      .rejects.toMatchObject({ code: "factory_package_scope" });
    const other = new FactoryPackageFence(fixture.db, "fence-other", otherGrants, () => now);
    await expect(other.affectedRuns(principal, projectId, reference)).rejects.toThrow();
    await expect(other.preview(principal, projectId, reference)).rejects.toThrow();
    // A decision under the other tenant cannot reach this tenant's run.
    await expect(quarantine(2, "fence-other-tenant", createFactoryPackageTrusts(fixture.db, "fence-other", otherGrants, () => now))).rejects.toThrow();
    expect(await cancelEvents(attempt.run.runId)).toHaveLength(1);
    expect((await affected()).items).toHaveLength(1);
  });

  test("a tampered record is refused, and invalid page options are refused before any read", async () => {
    await world.launchedAttempt();
    await quarantine();
    for (const options of [{ limit: 0 }, { limit: FACTORY_PACKAGE_FENCE_MAX_LIMIT + 1 }, { limit: 1.5 }, { trustRevision: 0 }, { after: { trustRevision: 0, attemptId: "a" } }]) {
      await expect(affected(options)).rejects.toMatchObject({ code: "factory_package_fence_invalid" });
    }
    await expect(affected({ after: { trustRevision: 1, attemptId: "" } })).rejects.toThrow();
    await fixture.db.execute(sql`UPDATE factory_package_fence_runs SET recorded_at_ms=recorded_at_ms+1 WHERE tenant_id=${tenantId}`);
    await expect(affected()).rejects.toMatchObject({ code: "factory_package_fence_corrupt" });
  });

  test("a trust store composed without a fence refuses to quarantine or revoke, and changes nothing", async () => {
    const attempt = await world.launchedAttempt();
    const unfenced = new FactoryPackageTrusts(fixture.db, tenantId, world.grants);
    await expect(quarantine(1, "fence-unfenced", unfenced)).rejects.toMatchObject({ code: "factory_package_fence_unavailable" });
    await expect(unfenced.revoke(principal, { projectId, reference, expectedRevision: 1 }, "fence-unfenced-revoke")).rejects.toMatchObject({ code: "factory_package_fence_unavailable" });
    await expect(fixture.db.transaction(transaction => trusts.readActiveInTransaction(transaction, projectId, reference))).resolves.toMatchObject({ revision: 1, state: "active" });
    expect(await cancelEvents(attempt.run.runId)).toEqual([]);
    // Publishing blocks nothing, so it needs no fence.
    expect(await unfenced.publish(principal, { projectId, reference, expectedRevision: 1 }, "fence-unfenced-publish")).toMatchObject({ revision: 2, state: "active" });
  });

  test("a runner policy cannot be built without the package fence: omission is a type error and is refused at runtime", () => {
    const runners = [{ runner: reference, resourceClass: "cpu", allocation: profile, allowedCapabilities: [...(firstTask.capabilities ?? [])], tools: [] }];
    // @ts-expect-error The admission fence is a required argument.
    expect(() => new FactoryNativeRunnerPolicy(tenantId, world.grants, runners, "factory-broker")).toThrow("factory_native_policy_invalid");
    expect(() => new FactoryNativeRunnerPolicy(tenantId, world.grants, runners, "factory-broker", {} as never)).toThrow("factory_native_policy_invalid");
    expect(new FactoryNativeRunnerPolicy(tenantId, world.grants, runners, "factory-broker", trusts)).toBeInstanceOf(FactoryNativeRunnerPolicy);
  });

  test("a quarantine with no live attempt records nothing and cancels nothing", async () => {
    const waiting: FactoryDispatchableRun = await world.dispatchable();
    expect(await fence.preview(principal, projectId, reference)).toEqual([]);
    expect(await quarantine()).toMatchObject({ state: "quarantined" });
    expect((await affected()).items).toEqual([]);
    expect(await cancelEvents(waiting.run.runId)).toEqual([]);
  });
}
