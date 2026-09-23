import { afterAll, expect, mock, spyOn, test } from "bun:test";
import type { CandidateVerificationReport, ReleaseRecord, RunnerExecution } from "@ezcorp/extension-contract";
import { closeTestDb, mockDbConnection, setupTestDb } from "../__tests__/helpers/test-pglite";
import { incusManifest, INCUS_PRESETS, INCUS_CAPABILITIES, INCUS_PROFILES } from "../../extensions/incus-sandbox/manifest";
import { digestObject } from "./v4/blobs";
import { getExtensionLifecycle, getExtensionRunner, recoverInstallation, recoverInstallations, recoveryDeadline, } from "./extension-lifecycle-service";
import type { InstallationRecord, InstallationState } from "./v4";
import type { RecoveryServices } from "./extension-lifecycle-service";

import { installation, } from "../__tests__/helpers/lifecycle-policy-fixture";

mockDbConnection();
afterAll(closeTestDb);

type DeferredTimer = () => Promise<void>;

function recoveryFixture(completeOnSecondRecovery = true) {
  const operation = { id: "build", kind: "build" as const, state: "building" as const, idempotencyKey: "build", inputDigest: "build", diagnostics: [], events: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), lease: { holder: "first-holder", fence: 1, until: Date.now() + 60_000 } };
  const state: InstallationState = { installation: { ...installation }, workspaces: {}, revisions: {}, releases: {}, approvals: {}, operations: { [operation.id]: operation } };
  const timers: DeferredTimer[] = [];
  const setTimer = spyOn(globalThis, "setTimeout").mockImplementation(((callback: () => void) => {
    timers.push(callback as DeferredTimer);
    return { unref() {} } as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout);
  const clearTimer = spyOn(globalThis, "clearTimeout");
  let recoverCalls = 0;
  const services: RecoveryServices = {
    repository: { async read() { return state; } },
    migrations: { async recover() {} },
    lifecycle: { async reconcile() {}, async recover() {
      recoverCalls++;
      if (completeOnSecondRecovery && recoverCalls === 2) state.operations[operation.id] = { ...operation, state: "verified", lease: undefined };
    } },
  };
  return { clearTimer, operation, recoverCalls: () => recoverCalls, services, setTimer, state, timers };
}

test("deferred recovery re-enters after an unexpired lease and clears its timer", async () => {
  const fixture = recoveryFixture();
  try {
    await recoverInstallation(fixture.services, installation.id);
    expect(fixture.recoverCalls()).toBe(1);
    expect(fixture.timers).toHaveLength(1);
    await fixture.timers[0]!();
    expect(fixture.recoverCalls()).toBe(2);
    expect(fixture.setTimer).toHaveBeenCalledTimes(1);
  } finally {
    fixture.setTimer.mockRestore();
    fixture.clearTimer.mockRestore();
  }
});

test("deferred recovery stops when the installation is uninstalled before its lease ends", async () => {
  const fixture = recoveryFixture();
  try {
    await recoverInstallation(fixture.services, installation.id);
    fixture.state.installation.uninstalled = true;
    await fixture.timers[0]!();
    expect(fixture.recoverCalls()).toBe(1);
    expect(fixture.setTimer).toHaveBeenCalledTimes(1);
  } finally {
    fixture.setTimer.mockRestore();
    fixture.clearTimer.mockRestore();
  }
});

test("a repeated recovery entry replaces its prior wake-up timer", async () => {
  const fixture = recoveryFixture(false);
  try {
    await recoverInstallation(fixture.services, installation.id);
    await recoverInstallation(fixture.services, installation.id);
    expect(fixture.setTimer).toHaveBeenCalledTimes(2);
    expect(fixture.clearTimer).toHaveBeenCalledTimes(1);
    fixture.state.installation.uninstalled = true;
    await fixture.timers[1]!();
    expect(fixture.recoverCalls()).toBe(2);
  } finally {
    fixture.setTimer.mockRestore();
    fixture.clearTimer.mockRestore();
  }
});

test("recovery reports and rejects an immediate lifecycle failure", async () => {
  const fixture = recoveryFixture(false);
  const failure = new Error("recover failed");
  fixture.services.lifecycle.recover = async () => { throw failure; };
  try {
    await expect(recoverInstallation(fixture.services, installation.id)).rejects.toBe(failure);
    expect(fixture.setTimer).not.toHaveBeenCalled();
  } finally {
    fixture.setTimer.mockRestore();
    fixture.clearTimer.mockRestore();
  }
});

test("deferred recovery contains a later lifecycle failure", async () => {
  const fixture = recoveryFixture(false);
  const deferredFailure = mock(async () => { throw new Error("deferred recover failed"); });
  try {
    await recoverInstallation(fixture.services, installation.id);
    fixture.services.lifecycle.recover = deferredFailure;
    await expect(fixture.timers[0]!()).resolves.toBeUndefined();
    expect(deferredFailure).toHaveBeenCalledTimes(1);
    expect(deferredFailure).toHaveBeenCalledWith(
      { principalId: installation.ownerId, scope: installation.scope, kind: "service" },
      installation.id,
    );
  } finally {
    fixture.setTimer.mockRestore();
    fixture.clearTimer.mockRestore();
  }
});

test("a failed installation recovery does not strand another queued build", async () => {
  const blocked = { ...installation, id: "a-blocked" };
  const ready = { ...installation, id: "b-ready" };
  const state = (installation: InstallationRecord, operationState: "queued" | "failed"): InstallationState => ({ installation, workspaces: {}, revisions: {}, releases: {}, approvals: {}, operations: { build: { id: "build", kind: "build", state: operationState, idempotencyKey: "build", inputDigest: "build", diagnostics: [], events: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() } } });
  const states = new Map([[blocked.id, state(blocked, "failed")], [ready.id, state(ready, "queued")]]);
  const recovered: string[] = [];
  const services: RecoveryServices = {
    repository: { async read(id) { return states.get(id) ?? null; } },
    migrations: { async recover(id) { if (id === blocked.id) throw new Error("owner unavailable"); } },
    lifecycle: { async reconcile() {}, async recover(_actor, id) { recovered.push(id); } },
  };
  await recoverInstallations(services, [blocked, ready]);
  expect(recovered).toEqual([ready.id]);
});

test("global recovery drains expired builds before queued and non-build operations", async () => {
  const queued = { ...installation, id: "a-queued" };
  const expired = { ...installation, id: "b-expired" };
  const activation = { ...installation, id: "c-activation" };
  const state = (installation: InstallationRecord, operation: Record<string, unknown>): InstallationState => ({ installation, workspaces: {}, revisions: {}, releases: {}, approvals: {}, operations: { operation: operation as never } });
  const states = new Map([
    [queued.id, state(queued, { id: "operation", kind: "build", state: "queued", idempotencyKey: "queued", inputDigest: "queued", diagnostics: [], events: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() })],
    [expired.id, state(expired, { id: "operation", kind: "build", state: "building", idempotencyKey: "expired", inputDigest: "expired", diagnostics: [], events: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), lease: { holder: "expired", fence: 1, until: Date.now() - 1 } })],
    [activation.id, state(activation, { id: "operation", kind: "activate", state: "awaiting_approval", idempotencyKey: "activation", inputDigest: "activation", diagnostics: [], events: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString() })],
  ]);
  const order: string[] = [];
  const services: RecoveryServices = { repository: { async read(id) { return states.get(id) ?? null; } }, migrations: { async recover() {} }, lifecycle: { async reconcile() {}, async recover(_actor, id) { order.push(id); } } };
  await recoverInstallations(services, [activation, queued, expired]);
  expect(order).toEqual([expired.id, queued.id, activation.id]);
});

test("a lifecycle recovery failure leaves other reconciled installations recoverable", async () => {
  const blocked = { ...installation, id: "a-recover-fails" };
  const ready = { ...installation, id: "b-recoverable" };
  const state = (installation: InstallationRecord): InstallationState => ({ installation, workspaces: {}, revisions: {}, releases: {}, approvals: {}, operations: {} });
  const states = new Map([[blocked.id, state(blocked)], [ready.id, state(ready)]]);
  const recovered: string[] = [];
  const services: RecoveryServices = {
    repository: { async read(id) { return states.get(id) ?? null; } },
    migrations: { async recover() {} },
    lifecycle: { async reconcile() {}, async recover(_actor, id) { if (id === blocked.id) throw new Error("recovery failed"); recovered.push(id); } },
  };
  await recoverInstallations(services, [blocked, ready]);
  expect(recovered).toEqual([ready.id]);
});

test("recovery wake-up selects the earliest live recoverable lease only", () => {
  const operation = (id: string, state: "building" | "verified" | "activating", until: number) => ({ id, kind: state === "activating" ? "activate" as const : "build" as const, state, idempotencyKey: id, inputDigest: id, diagnostics: [], events: [], createdAt: new Date(0).toISOString(), updatedAt: new Date(0).toISOString(), lease: { holder: id, fence: 1, until } });
  const state = {
    installation,
    workspaces: {}, revisions: {}, releases: {}, approvals: {},
    operations: {
      later: operation("later", "building", 400),
      earliest: operation("earliest", "activating", 200),
      terminal: operation("terminal", "verified", 100),
    },
  };
  expect(recoveryDeadline(state, 100)).toBe(200);
  expect(recoveryDeadline(state, 400)).toBeUndefined();
  expect(recoveryDeadline({ ...state, installation: { ...installation, uninstalled: true } }, 100)).toBeUndefined();
});

test("recovery sweeps installations one at a time so a wide install cannot deadlock the pool", async () => {
  // Each step opens a transaction and takes further pool connections while
  // holding it, so a sweep wider than DB_POOL_MAX (20) deadlocks the pool and
  // wedges the boot that awaits it. Peak concurrency is the invariant, not
  // elapsed time — measure it directly rather than racing a clock.
  let active = 0;
  let peak = 0;
  const step = async () => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    await Promise.resolve();
    active--;
  };
  const records = ["a", "b", "c", "d"].map((id) => ({ ...installation, id }));
  const services: RecoveryServices = {
    repository: { async read() { await step(); return null; } },
    migrations: { async recover() {} },
    lifecycle: { async recover() {}, async reconcile() { await step(); } },
  };

  await recoverInstallations(services, records);

  expect(peak).toBe(1);
});

test("service candidate verification executes the host workspace-routing proof", async () => {
  await setupTestDb();
  const lifecycle = await getExtensionLifecycle();
  const runner = await getExtensionRunner();
  const originalStart = runner.start;
  const input = {
    installationId: "sandbox-installation", workspaceId: "sandbox-workspace", workspaceRevision: 1,
    sourceDigest: "a".repeat(64), artifactDigest: "b".repeat(64), imageDigest: "c".repeat(64),
    manifest: incusManifest,
    evidence: { protocolVersion: 4 as const, validatorVersion: "runner-v4.1",
      discoveryDigest: digestObject(incusManifest), tests: [{ name: "host-protocol", passed: true }] },
    runnerProfile: "isolated", policyDigest: "d".repeat(64),
  };
  const release = { id: "sandbox-release", createdAt: new Date().toISOString(),
    ...input, releaseDigest: digestObject(input) } as ReleaseRecord;
  const dispatched: string[] = [];
  runner.start = async request => ({
    workerId: request.workerId,
    onNotification: () => () => {},
    close: async () => {},
    request: async (method: string, payload: unknown) => {
      if (method === "extension/discover") return incusManifest;
      const exchange = payload as { method: string; input: { presetId?: string } };
      dispatched.push(exchange.method);
      if (exchange.method === "incus/describe") return {
        providerId: "incus", protocolMajor: 1, profiles: INCUS_PROFILES,
        presetIds: INCUS_PRESETS.map(preset => preset.id), capabilities: INCUS_CAPABILITIES,
      };
      const preset = INCUS_PRESETS.find(item => item.id === exchange.input.presetId)!;
      return { observation: {
        backendApi: preset.requirements.backendApis[0]!, backendVersion: "host-conformance-v1",
        architecture: preset.requirements.architectures[0]!,
        storageDriver: preset.requirements.storageDrivers[0]!,
        isolation: preset.requirements.isolation[0]!, nestedCompose: preset.requirements.nestedCompose,
      } };
    },
  }) as RunnerExecution;
  try {
    const verifier = (lifecycle as unknown as { dependencies: {
      verifyCandidate: (release: ReleaseRecord) => Promise<CandidateVerificationReport>,
    } }).dependencies.verifyCandidate;
    const report = await verifier(release);
    expect(dispatched).toEqual(["incus/describe", "incus/preflight", "incus/preflight", "incus/preflight", "incus/preflight"]);
    expect(report.sandboxPresetQualifications).toHaveLength(INCUS_PRESETS.length);
    for (const qualification of report.sandboxPresetQualifications ?? []) {
      expect(qualification.cases).toContainEqual({ caseId: "SP05", status: "passed" });
    }
  } finally {
    runner.start = originalStart;
  }
});
