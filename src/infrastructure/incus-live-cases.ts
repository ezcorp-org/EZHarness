import { randomUUID } from "node:crypto";
import {
  sandboxPresetDigest,
  type SandboxCompatibilityObservation,
  type SandboxPreset,
} from "@ezcorp/extension-contract";
import { GUEST_HELPER_SHA256 } from "./incus-guest/protocol";
import type { IncusLiveCaseEvidence, IncusQualificationScope } from "./incus-qualification";

const CASE_IDS = ["SP01", "SP02", "SP03", "SP04", "SP05", "SP06", "SP07", "SP08"] as const;
const MARKER_PATH = "ezh-qualification-marker";
const COMPOSE_PATH = "ezh-qualification-compose.yaml";

export interface LiveFixtureHandle {
  sandboxId: string;
  operationId: string;
}

export interface LiveFixtureInspection {
  sandboxId: string;
  state: "stopped" | "running" | "absent";
  imageDigest: string;
  helperDigest: string;
  profile: string;
  workspaceRoot: "/workspace";
  guestUser: string;
  memoryBytes: number;
  cpuMillis: number;
  pids: number;
  diskBytes: number;
  storageDriver: string;
  privateNetwork: boolean;
  restrictedProject: boolean;
  unprivileged: boolean;
  bootId: string | null;
}

export interface LiveCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LiveEnforcementFacts {
  /** Values read from the running guest cgroup and Incus root volume, not configuration intent. */
  memoryMaxBytes: number;
  cpuQuotaMillis: number;
  pidsMax: number;
  rootQuotaBytes: number;
  privateNetworkProbeBlocked: boolean;
  unprivilegedUidMap: boolean;
}

export interface LiveLimitLoadFact {
  resource: "memory" | "cpu" | "pids" | "disk";
  attempted: number;
  observedLimit: number;
  contained: boolean;
  neighborHealthy: boolean;
  hostHealthy: boolean;
}

export interface LiveCleanupRecoveryFact {
  firstDestroyOperationId: string;
  recordedState: "RECONCILE_REQUIRED" | "FAILED";
  readinessErrorCode: string;
  reconciledOperationId: string;
  finalState: "absent" | "running" | "stopped";
  unrelatedState: "stopped" | "running" | "absent";
}

/** This authority must be supplied by the host, never the extension worker.
 * Its implementation must use the durable controller and protected guest RPC.
 * There is deliberately no production default or synthetic receipt path. */
export interface HostIncusLiveWitness {
  observe(scope: IncusQualificationScope, preset: SandboxPreset): Promise<{
    observation: SandboxCompatibilityObservation;
    profile: string;
    imageDigest: string;
    helperDigest: string;
  }>;
  /** Returns raw admission/readback facts, not SP case verdicts. */
  controlFacts(scope: IncusQualificationScope, preset: SandboxPreset): Promise<{
    baselinePlanDigest: string;
    repeatedPlanDigest: string;
    changedPlanDigest: string;
    unsupportedAdmissionCode: string;
    unsupportedAllocationDelta: number;
    missingControlAdmissionCode: string;
    missingControlAllocationDelta: number;
    driftAdmissionCode: string;
    driftAllocationDelta: number;
    unqualifiedAdmissionCode: string;
    unqualifiedAllocationDelta: number;
    localCanaryBefore: string;
    localCanaryAfter: string;
  }>;
  /** The same operation ID must replay one resource after an intentionally lost reply. */
  createFixture(scope: IncusQualificationScope, preset: SandboxPreset,
    operationId: string, dropFirstReply: boolean): Promise<LiveFixtureHandle>;
  inspectFixture(handle: LiveFixtureHandle): Promise<LiveFixtureInspection>;
  observeEnforcement(handle: LiveFixtureHandle, unrelated: LiveFixtureHandle): Promise<LiveEnforcementFacts>;
  /** Attempts over-limit guest loads and measures containment plus neighbor/host health. */
  exerciseLimits(handle: LiveFixtureHandle, unrelated: LiveFixtureHandle): Promise<LiveLimitLoadFact[]>;
  setPower(handle: LiveFixtureHandle, state: "running" | "stopped"): Promise<void>;
  run(handle: LiveFixtureHandle, argv: readonly string[], timeoutMs: number): Promise<LiveCommandResult>;
  writeFile(handle: LiveFixtureHandle, path: string, bytes: Uint8Array): Promise<void>;
  readFile(handle: LiveFixtureHandle, path: string): Promise<Uint8Array>;
  /** Must restart the host controller process, then reconnect through its durable store. */
  restartController(): Promise<{ beforeProcessId: string; afterProcessId: string }>;
  /** Deliberately loses one fixture destroy effect, records failed cleanup,
   * denies Ready, then reconciles using the original operation identity. */
  exerciseFailedCleanupRecovery(handle: LiveFixtureHandle,
    unrelated: LiveFixtureHandle): Promise<LiveCleanupRecoveryFact>;
  destroyFixture(handle: LiveFixtureHandle): Promise<void>;
}

export interface IncusLiveRunnerOptions {
  witness: HostIncusLiveWitness;
  /** Reviewed full immutable registry reference. Required for Compose presets. */
  composeFixtureImageRef?: string;
  now?: () => number;
}

function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Incus live qualification failed: ${message}`);
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function sha(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
}

function immutableImageRef(value: unknown): value is string {
  return typeof value === "string"
    && /^[a-z0-9][a-z0-9.-]+(?::[1-9][0-9]{0,4})?\/[a-z0-9][a-z0-9._/-]*@sha256:[a-f0-9]{64}$/.test(value);
}

function compatible(preset: SandboxPreset, observed: SandboxCompatibilityObservation): boolean {
  const required = preset.requirements;
  return required.backendApis.includes(observed.backendApi)
    && required.architectures.includes(observed.architecture)
    && required.storageDrivers.includes(observed.storageDriver)
    && required.isolation.includes(observed.isolation)
    && (!required.nestedCompose || observed.nestedCompose);
}

function assertInspection(value: LiveFixtureInspection, handle: LiveFixtureHandle,
  preset: SandboxPreset, state: LiveFixtureInspection["state"]): void {
  requireFact(value.sandboxId === handle.sandboxId && value.state === state, "fixture state or identity changed");
  if (state === "absent") return;
  requireFact(value.imageDigest === preset.imageDigest && preset.helperDigests.includes(value.helperDigest)
    && value.helperDigest === GUEST_HELPER_SHA256 && value.profile === preset.profile,
  "fixture artifact identity changed");
  requireFact(value.workspaceRoot === "/workspace" && value.guestUser === "sandbox"
    && value.privateNetwork && value.restrictedProject && value.unprivileged,
  "fixture isolation or workspace control is unavailable");
  requireFact(value.memoryBytes > 0 && value.memoryBytes <= preset.limits.memoryBytes
    && value.cpuMillis > 0 && value.cpuMillis <= preset.limits.cpuMillis
    && value.pids > 0 && value.pids <= preset.limits.pids
    && value.diskBytes > 0 && value.diskBytes <= preset.limits.diskBytes
    && preset.requirements.storageDrivers.includes(value.storageDriver),
  "fixture resource limits are not enforced");
  if (state === "running") requireFact(stableId(value.bootId), "running guest boot is unavailable");
}

function assertEnforcement(value: LiveEnforcementFacts, preset: SandboxPreset): void {
  requireFact(Number.isSafeInteger(value.memoryMaxBytes) && value.memoryMaxBytes > 0
    && value.memoryMaxBytes <= preset.limits.memoryBytes
    && Number.isSafeInteger(value.cpuQuotaMillis) && value.cpuQuotaMillis > 0
    && value.cpuQuotaMillis <= preset.limits.cpuMillis
    && Number.isSafeInteger(value.pidsMax) && value.pidsMax > 0
    && value.pidsMax <= preset.limits.pids
    && Number.isSafeInteger(value.rootQuotaBytes) && value.rootQuotaBytes > 0
    && value.rootQuotaBytes <= preset.limits.diskBytes
    && value.privateNetworkProbeBlocked === true && value.unprivilegedUidMap === true,
  "guest cgroup, storage or network enforcement is unavailable");
}

function assertLoadFacts(values: LiveLimitLoadFact[], preset: SandboxPreset): void {
  const limits = { memory: preset.limits.memoryBytes, cpu: preset.limits.cpuMillis,
    pids: preset.limits.pids, disk: preset.limits.diskBytes };
  requireFact(Array.isArray(values) && values.length === 4
    && new Set(values.map(value => value.resource)).size === 4,
  "controlled limit loads are incomplete");
  for (const value of values) {
    const bound = limits[value.resource];
    requireFact(Number.isSafeInteger(value.attempted) && value.attempted > bound
      && Number.isSafeInteger(value.observedLimit) && value.observedLimit > 0
      && value.observedLimit <= bound && value.contained === true
      && value.neighborHealthy === true && value.hostHealthy === true,
    `controlled ${value.resource} load escaped its sandbox or affected a neighbor`);
  }
}

function assertCleanupRecovery(value: LiveCleanupRecoveryFact): void {
  requireFact(stableId(value.firstDestroyOperationId)
    && value.reconciledOperationId === value.firstDestroyOperationId
    && value.recordedState === "RECONCILE_REQUIRED"
    && value.readinessErrorCode === "QUALIFICATION_CLEANUP_UNVERIFIED"
    && value.finalState === "absent" && value.unrelatedState === "stopped",
  "failed cleanup was not recorded, denied, and reconciled");
}

function assertControls(value: Awaited<ReturnType<HostIncusLiveWitness["controlFacts"]>>): void {
  requireFact(sha(value.baselinePlanDigest) && value.repeatedPlanDigest === value.baselinePlanDigest
    && sha(value.changedPlanDigest) && value.changedPlanDigest !== value.baselinePlanDigest,
  "effective settings are not deterministic");
  for (const [code, delta] of [
    [value.unsupportedAdmissionCode, value.unsupportedAllocationDelta],
    [value.missingControlAdmissionCode, value.missingControlAllocationDelta],
    [value.driftAdmissionCode, value.driftAllocationDelta],
    [value.unqualifiedAdmissionCode, value.unqualifiedAllocationDelta],
  ] as const) {
    requireFact(typeof code === "string" && code.startsWith("DENIED_") && delta === 0,
      "unsupported or unqualified work was admitted");
  }
  requireFact(sha(value.localCanaryBefore) && value.localCanaryBefore === value.localCanaryAfter,
    "a denied request touched the local workspace");
}

function assertCommand(value: LiveCommandResult, expected: string): void {
  requireFact(value.exitCode === 0 && value.stdout.includes(expected) && value.stderr.length <= 64 * 1024,
    "real guest command did not complete");
}

/** Produces SP01–SP08 only from ordered host actions and concrete observations.
 * The factory is intentionally not installed by startup while no published
 * image and controller qualification authority exist. */
export function createIncusLiveCaseRunner(options: IncusLiveRunnerOptions):
  (scope: IncusQualificationScope, preset: SandboxPreset) => Promise<IncusLiveCaseEvidence> {
  requireFact(options?.witness, "host qualification authority is unavailable");
  const { witness } = options;
  const now = options.now ?? Date.now;
  return async (scope, preset) => {
    requireFact(scope.presetId === preset.id && stableId(scope.connectionId) && stableId(scope.releaseId),
      "qualification scope changed");
    const presetDigest = await sandboxPresetDigest(preset);
    requireFact(sha(presetDigest) && sha(preset.imageDigest) && preset.imageDigest !== "0".repeat(64)
      && preset.helperDigests.includes(GUEST_HELPER_SHA256),
      "reviewed preset or helper is unavailable");
    const observed = await witness.observe(scope, preset);
    requireFact(observed.profile === preset.profile && observed.imageDigest === preset.imageDigest
      && observed.helperDigest === GUEST_HELPER_SHA256 && compatible(preset, observed.observation),
    "backend or artifact observation is incompatible");
    assertControls(await witness.controlFacts(scope, preset));

    const fixtureToken = randomUUID();
    const primaryId = `qual-primary-${fixtureToken}`;
    const unrelatedId = `qual-unrelated-${fixtureToken}`;
    const recoveryId = `qual-recovery-${fixtureToken}`;
    // The witness must reconcile or clean a create that throws before it can
    // return a handle. Once a handle exists, all later failures clean it here.
    let primary: LiveFixtureHandle | null = null;
    let unrelated: LiveFixtureHandle | null = null;
    let recovery: LiveFixtureHandle | null = null;
    let primaryDestroyed = false;
    let unrelatedDestroyed = false;
    let recoveryDestroyed = false;
    let failure: unknown;
    const cleanupErrors: unknown[] = [];
    try {
      primary = await witness.createFixture(scope, preset, primaryId, true);
      requireFact(stableId(primary.sandboxId) && primary.operationId === primaryId,
        "created fixture lacks a stable operation identity");
      const replay = await witness.createFixture(scope, preset, primaryId, false);
      requireFact(replay.sandboxId === primary.sandboxId && replay.operationId === primary.operationId,
        "lost create reply allocated another sandbox");
      assertInspection(await witness.inspectFixture(primary), primary, preset, "stopped");
      await witness.setPower(primary, "running");
      assertInspection(await witness.inspectFixture(primary), primary, preset, "running");
      unrelated = await witness.createFixture(scope, preset, unrelatedId, false);
      requireFact(stableId(unrelated.sandboxId) && unrelated.sandboxId !== primary.sandboxId,
        "unrelated fixture was adopted");
      assertInspection(await witness.inspectFixture(unrelated), unrelated, preset, "stopped");
      await witness.setPower(unrelated, "running");
      assertInspection(await witness.inspectFixture(unrelated), unrelated, preset, "running");
      assertEnforcement(await witness.observeEnforcement(primary, unrelated), preset);
      assertLoadFacts(await witness.exerciseLimits(primary, unrelated), preset);
      await witness.setPower(unrelated, "stopped");
      assertInspection(await witness.inspectFixture(unrelated), unrelated, preset, "stopped");

      const marker = `ezh-${fixtureToken}`;
      assertCommand(await witness.run(primary, ["sh", "-c", "printf %s \"$1\"", "sh", marker], 30_000), marker);
      await witness.writeFile(primary, MARKER_PATH, new TextEncoder().encode(marker));
      if (preset.requirements.nestedCompose) {
        requireFact(immutableImageRef(options.composeFixtureImageRef), "reviewed Compose fixture image is unavailable");
        const yaml = `services:\n  proof:\n    image: ${options.composeFixtureImageRef}\n    command: ["sh", "-c", "printf ezh-compose-ok"]\n`;
        await witness.writeFile(primary, COMPOSE_PATH, new TextEncoder().encode(yaml));
        assertCommand(await witness.run(primary, ["docker", "compose", "-f", COMPOSE_PATH,
          "run", "--rm", "proof"], 120_000), "ezh-compose-ok");
      }

      await witness.setPower(primary, "stopped");
      assertInspection(await witness.inspectFixture(primary), primary, preset, "stopped");
      const restart = await witness.restartController();
      requireFact(stableId(restart.beforeProcessId) && stableId(restart.afterProcessId)
        && restart.beforeProcessId !== restart.afterProcessId,
      "controller did not restart and reconnect");
      await witness.setPower(primary, "running");
      assertInspection(await witness.inspectFixture(primary), primary, preset, "running");
      if (preset.storage.workspace === "persistent") {
        requireFact(new TextDecoder().decode(await witness.readFile(primary, MARKER_PATH)) === marker,
          "retained workspace changed after restart");
      }
      await witness.setPower(primary, "stopped");
      await witness.destroyFixture(primary);
      primaryDestroyed = true;
      assertInspection(await witness.inspectFixture(primary), primary, preset, "absent");
      assertInspection(await witness.inspectFixture(unrelated), unrelated, preset, "stopped");
      recovery = await witness.createFixture(scope, preset, recoveryId, false);
      requireFact(stableId(recovery.sandboxId) && recovery.sandboxId !== primary.sandboxId
        && recovery.sandboxId !== unrelated.sandboxId,
      "cleanup recovery fixture was adopted");
      assertInspection(await witness.inspectFixture(recovery), recovery, preset, "stopped");
      assertCleanupRecovery(await witness.exerciseFailedCleanupRecovery(recovery, unrelated));
      recoveryDestroyed = true;
      assertInspection(await witness.inspectFixture(recovery), recovery, preset, "absent");
      assertInspection(await witness.inspectFixture(unrelated), unrelated, preset, "stopped");
      await witness.destroyFixture(unrelated);
      unrelatedDestroyed = true;
      assertInspection(await witness.inspectFixture(unrelated), unrelated, preset, "absent");
    } catch (error) {
      failure = error;
    } finally {
      if (primary && !primaryDestroyed) {
        try { await witness.destroyFixture(primary); } catch (error) { cleanupErrors.push(error); }
      }
      if (unrelated && !unrelatedDestroyed) {
        try { await witness.destroyFixture(unrelated); } catch (error) { cleanupErrors.push(error); }
      }
      if (recovery && !recoveryDestroyed) {
        try { await witness.destroyFixture(recovery); } catch (error) { cleanupErrors.push(error); }
      }
    }
    if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors],
      "Incus live fixture cleanup is unverified");
    if (failure) throw failure;

    const verifiedAt = new Date(now()).toISOString();
    const validUntil = new Date(now() + 60 * 60 * 1000).toISOString();
    return {
      observation: observed.observation,
      observedProfile: observed.profile,
      observedImageDigest: observed.imageDigest,
      observedHelperDigest: observed.helperDigest,
      verifiedAt, validUntil,
      cases: CASE_IDS.map(caseId => ({ caseId, status: "passed" as const })),
    };
  };
}
