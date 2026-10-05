import { IncusLimitLoadFailure, incusLimitResource, IncusCpuLoadProofError, incusCpuLoadDiagnostic, type IncusCpuLoadDiagnostic } from "./incus-live-limit-probe";
import { randomUUID } from "node:crypto";
import {
  sandboxPresetDigest,
  sandboxProviderMethodSchemas,
  type SandboxCompatibilityObservation,
  type SandboxPreset,
  type SandboxProtocolOperation,
} from "@ezcorp/extension-contract";
import { GUEST_HELPER_SHA256 } from "./incus-guest/protocol";
import { IncusQualificationOperationUnsettledError, type IncusLiveCaseEvidence, type IncusQualificationScope } from "./incus-qualification";

const CASE_IDS = ["SP01", "SP02", "SP03", "SP04", "SP05", "SP06", "SP07", "SP08"] as const;
const QUALIFICATION_PHASE_MS = 20 * 60_000;
const RESTART_HANDOFF_MS = 110_000;
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
  /** Prove reviewed network-control capability before allocating any fixture. */
  preflightNetwork(scope: IncusQualificationScope, preset: SandboxPreset): Promise<void>;
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
  /** Must restart the host controller process and reopen this exact stopped fixture. */
  restartController(handle: LiveFixtureHandle): Promise<{ beforeProcessId: string; afterProcessId: string }>;
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

/** The process that claims a run must construct a new witness and database connection. */
export interface DurableIncusLiveWitness extends HostIncusLiveWitness {
  findFixture(scope: IncusQualificationScope, operationId: string): Promise<LiveFixtureHandle>;
  beginRestart(scope: IncusQualificationScope, preset: SandboxPreset, handle: LiveFixtureHandle,
    runId: string, nonce: string, deadlineMs: number): Promise<void>;
  claimRestart(scope: IncusQualificationScope, preset: SandboxPreset,
    runId: string, nonce: string): Promise<LiveFixtureHandle>;
}

function requireFact(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Incus live qualification failed: ${message}`);
}

function stableId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);
}

function validDurableRun(runId: string, nonce: string): boolean {
  return stableId(runId) && stableId(nonce)
    && ["primary", "unrelated", "recovery"].every(kind => stableId(`qual-${kind}-${runId}`));
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

interface FixtureRunState {
  primary: LiveFixtureHandle | null;
  unrelated: LiveFixtureHandle | null;
  recovery: LiveFixtureHandle | null;
  primaryDestroyed: boolean;
  unrelatedDestroyed: boolean;
  recoveryDestroyed: boolean;
}

export type IncusQualificationPreparationStage = "fixtures" | "enforcement" | "limit_loads" | "guest_preparation" | "restart_handoff";
const preparationAssertions = new Map<string, string>();
const diagnosticAssertions: Record<string, readonly string[]> = {
  "Incus live network probe unavailable: ": ["reviewed neighbor control transport is unavailable", "reviewed neighbor control response is invalid", "pinned management peer address is unavailable", "pinned management connection changed", "pinned management connection deadline expired", "protected guest call failed", "invalid neighbor identity", "neighbor fixture ownership changed", "neighbor binding changed or stopped", "backend neighbor identity changed", "backend neighbor state changed", "exact neighbor bridge address is unavailable", "neighbor listener identity missing", "neighbor listener output has a gap", "neighbor listener output changed", "neighbor listener port is invalid", "neighbor listener ended before it was ready", "neighbor listener did not become ready"],
  "Incus resource probe unavailable: ": ["distinct IP-literal targets are required", "management control target is not reachable from the host", "otherSandbox control target is not reachable from the host", "guest control readout failed or exceeded its bound", "guest control readout is invalid JSON", "guest control readout is invalid", "exact fixture root quota is unavailable", "observed controls exceed the reviewed preset", "guest reached a forbidden network target", "guest UID map is not isolated from host root", "CPU cgroup quota is missing", "CPU cgroup quota has an invalid format", "CPU quota cannot be expressed exactly"],
  "Incus live qualification failed: ": ["guest cgroup, storage or network enforcement is unavailable", "controlled limit loads are incomplete", "qualification preparation deadline expired"],
  "Incus live witness unavailable: ": ["running fixture, root quota, or neighbor network identity changed", "resource probe fixtures have different reviewed scopes", "limit probe needs two distinct running fixtures", "limit probe fixture scopes differ", "guest action failed"],
  "Incus limit probe unavailable: ": ["host storage pool has insufficient independent free space for the quota probe", "host storage pool did not recover after the quota probe"],
};
for (const [prefix, messages] of Object.entries(diagnosticAssertions)) {
  for (const message of messages) preparationAssertions.set(prefix + message, message.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase());
}
for (const label of ["memory cgroup limit", "PID cgroup limit", "CPU quota", "CPU period"]) {
  for (const suffix of ["is not a finite limit", "is outside safe integer range"]) {
    const message = `${label} ${suffix}`;
    preparationAssertions.set(`Incus resource probe unavailable: ${message}`, message.replace(/[^A-Za-z0-9]+/g, "_").toLowerCase());
  }
}
for (const resource of ["memory", "cpu", "pids", "disk"]) {
  for (const suffix of ["request is unsafe", "observed limit or requested load is invalid", "load did not finish cleanly", "load returned invalid JSON", "load did not prove containment", "load affected host or neighbor"]) {
    preparationAssertions.set(`Incus limit probe unavailable: ${resource} ${suffix}`, `${resource}_${suffix.replaceAll(" ", "_")}`);
  }
  preparationAssertions.set(`Incus limit probe unavailable: host or neighbor was unhealthy before ${resource} load`, `${resource}_host_or_neighbor_unhealthy_before_load`);
  preparationAssertions.set(`Incus live qualification failed: controlled ${resource} load escaped its sandbox or affected a neighbor`, `${resource}_containment_or_neighbor_assertion_failed`);
}
const preparationProviderCodes = new Set(["SCOPE_INVALID", "PERMISSION_DENIED", "TIMEOUT", "INVALID_INPUT", "REVISION_CONFLICT", "NOT_FOUND", "INTERNAL", "UNAVAILABLE"]);
export const INCUS_WITNESS_GUEST_OPERATIONS = [
  "files.stat", "files.readRange", "files.writeAtomic", "processes.start", "processes.inspect", "processes.readOutput",
] as const satisfies readonly SandboxProtocolOperation[];
// Read the finite canonical enum; do not maintain a second provider-code list.
const guestErrorDefinitions = sandboxProviderMethodSchemas("processes.start", 1).outputSchema.$defs as
  Record<string, { enum: readonly string[] }>;
const guestProviderCodes = guestErrorDefinitions.SandboxProviderErrorCode!.enum;
const guestFailureCodes = new Map<string, string>(INCUS_WITNESS_GUEST_OPERATIONS.flatMap(operation =>
  guestProviderCodes.map(code => [`${operation}:${code}`, `guest_${operation.replace(".", "_")}_${code.toLowerCase()}`])));
const guestFailureCauseCodes = new Set(guestFailureCodes.values());
/** Only finite method/code pairs can cross the diagnostic boundary. */
export function incusGuestFailureCauseCode(operation: unknown, code: unknown): string {
  return typeof operation === "string" && typeof code === "string"
    ? guestFailureCodes.get(`${operation}:${code}`) ?? "guest_action_failed" : "guest_action_failed";
}
export const INCUS_PREPARATION_CAUSE_CODES: ReadonlySet<string> = new Set(["unclassified", ...preparationAssertions.values(), ...preparationProviderCodes, ...guestFailureCodes.values()]);
function originalPreparationFailure(error: unknown): unknown {
  return error instanceof IncusLimitLoadFailure ? error.failure() : error;
}
function preservedPreparationFailure(error: unknown): IncusQualificationOperationUnsettledError | null {
  const original = originalPreparationFailure(error);
  return original instanceof IncusQualificationOperationUnsettledError ? original : null;
}
export function incusPreparationCauseCode(error: unknown): string {
  error = originalPreparationFailure(error);
  if (!(error instanceof Error)) return "unclassified";
  const diagnosticCode = (error as Error & { code?: unknown }).code;
  if (typeof diagnosticCode === "string" && guestFailureCauseCodes.has(diagnosticCode)) return diagnosticCode;
  const assertion = preparationAssertions.get(error.message);
  if (assertion) return assertion;
  return typeof diagnosticCode === "string" && preparationProviderCodes.has(diagnosticCode) ? diagnosticCode : "unclassified";
}
/** Safe diagnostic fields only. The original provider exception is not projected. */
export class IncusQualificationPreparationError extends Error {
  constructor(readonly stage: IncusQualificationPreparationStage, readonly cleanup: "confirmed" | "unverified", readonly causeCode = "unclassified", readonly cpuLoad: IncusCpuLoadDiagnostic | null = null, readonly limitResource: LiveLimitLoadFact["resource"] | null = null) {
    super("Incus qualification preparation failed");
  }
}

async function createLiveFixtures(witness: HostIncusLiveWitness, scope: IncusQualificationScope,
  preset: SandboxPreset, token: string, state: FixtureRunState,
  stage: (value: IncusQualificationPreparationStage) => void = () => {}): Promise<void> {
  await witness.preflightNetwork(scope, preset);
  const primaryId = `qual-primary-${token}`;
  state.primary = await witness.createFixture(scope, preset, primaryId, true);
  const primary = state.primary;
  requireFact(stableId(primary.sandboxId) && primary.operationId === primaryId,
    "created fixture lacks a stable operation identity");
  const replay = await witness.createFixture(scope, preset, primaryId, false);
  requireFact(replay.sandboxId === primary.sandboxId && replay.operationId === primary.operationId,
    "lost create reply allocated another sandbox");
  assertInspection(await witness.inspectFixture(primary), primary, preset, "stopped");
  await witness.setPower(primary, "running");
  assertInspection(await witness.inspectFixture(primary), primary, preset, "running");

  state.unrelated = await witness.createFixture(scope, preset, `qual-unrelated-${token}`, false);
  const unrelated = state.unrelated;
  requireFact(stableId(unrelated.sandboxId) && unrelated.sandboxId !== primary.sandboxId,
    "unrelated fixture was adopted");
  assertInspection(await witness.inspectFixture(unrelated), unrelated, preset, "stopped");
  await witness.setPower(unrelated, "running");
  assertInspection(await witness.inspectFixture(unrelated), unrelated, preset, "running");
  stage("enforcement");
  assertEnforcement(await witness.observeEnforcement(primary, unrelated), preset);
  stage("limit_loads");
  assertLoadFacts(await witness.exerciseLimits(primary, unrelated), preset);
  await witness.setPower(unrelated, "stopped");
  assertInspection(await witness.inspectFixture(unrelated), unrelated, preset, "stopped");
}

async function prepareGuestForRestart(witness: HostIncusLiveWitness, preset: SandboxPreset,
  primary: LiveFixtureHandle, token: string, composeFixtureImageRef?: string): Promise<void> {
  const marker = `ezh-${token}`;
  assertCommand(await witness.run(primary, ["sh", "-c", "printf %s \"$1\"", "sh", marker], 30_000), marker);
  await witness.writeFile(primary, MARKER_PATH, new TextEncoder().encode(marker));
  if (preset.requirements.nestedCompose) {
    requireFact(immutableImageRef(composeFixtureImageRef), "reviewed Compose fixture image is unavailable");
    const yaml = `services:\n  proof:\n    image: ${composeFixtureImageRef}\n    command: ["sh", "-c", "printf ezh-compose-ok"]\n`;
    await witness.writeFile(primary, COMPOSE_PATH, new TextEncoder().encode(yaml));
    assertCommand(await witness.run(primary, ["docker", "compose", "-f", COMPOSE_PATH,
      "run", "--rm", "proof"], 120_000), "ezh-compose-ok");
  }

  await witness.setPower(primary, "stopped");
  assertInspection(await witness.inspectFixture(primary), primary, preset, "stopped");
}

async function finishGuestAfterRestart(witness: HostIncusLiveWitness, preset: SandboxPreset,
  primary: LiveFixtureHandle, token: string): Promise<void> {
  const marker = `ezh-${token}`;
  assertInspection(await witness.inspectFixture(primary), primary, preset, "stopped");
  await witness.setPower(primary, "running");
  assertInspection(await witness.inspectFixture(primary), primary, preset, "running");
  if (preset.storage.workspace === "persistent") {
    requireFact(new TextDecoder().decode(await witness.readFile(primary, MARKER_PATH)) === marker,
      "retained workspace changed after restart");
  }
  await witness.setPower(primary, "stopped");
}

async function exerciseGuestAndRestart(witness: HostIncusLiveWitness, preset: SandboxPreset,
  primary: LiveFixtureHandle, token: string, composeFixtureImageRef?: string): Promise<void> {
  await prepareGuestForRestart(witness, preset, primary, token, composeFixtureImageRef);
  const restart = await witness.restartController(primary);
  requireFact(stableId(restart.beforeProcessId) && stableId(restart.afterProcessId)
    && restart.beforeProcessId !== restart.afterProcessId,
  "controller did not restart and reconnect");
  await finishGuestAfterRestart(witness, preset, primary, token);
}

async function destroyAndRecoverFixtures(witness: HostIncusLiveWitness, scope: IncusQualificationScope,
  preset: SandboxPreset, token: string, state: FixtureRunState): Promise<void> {
  const { primary, unrelated } = state;
  requireFact(primary && unrelated, "live fixtures were not created");
  await witness.destroyFixture(primary);
  state.primaryDestroyed = true;
  assertInspection(await witness.inspectFixture(primary), primary, preset, "absent");
  assertInspection(await witness.inspectFixture(unrelated), unrelated, preset, "stopped");
  state.recovery = await witness.createFixture(scope, preset, `qual-recovery-${token}`, false);
  const recovery = state.recovery;
  requireFact(stableId(recovery.sandboxId) && recovery.sandboxId !== primary.sandboxId
    && recovery.sandboxId !== unrelated.sandboxId,
  "cleanup recovery fixture was adopted");
  assertInspection(await witness.inspectFixture(recovery), recovery, preset, "stopped");
  assertCleanupRecovery(await witness.exerciseFailedCleanupRecovery(recovery, unrelated));
  state.recoveryDestroyed = true;
  assertInspection(await witness.inspectFixture(recovery), recovery, preset, "absent");
  assertInspection(await witness.inspectFixture(unrelated), unrelated, preset, "stopped");
  await witness.destroyFixture(unrelated);
  state.unrelatedDestroyed = true;
  assertInspection(await witness.inspectFixture(unrelated), unrelated, preset, "absent");
}

async function cleanupLiveFixtures(witness: HostIncusLiveWitness, state: FixtureRunState): Promise<unknown[]> {
  const cleanupErrors: unknown[] = [];
  for (const [fixture, destroyed] of [
    [state.primary, state.primaryDestroyed],
    [state.unrelated, state.unrelatedDestroyed],
    [state.recovery, state.recoveryDestroyed],
  ] as const) {
    if (fixture && !destroyed) {
      try { await witness.destroyFixture(fixture); } catch (error) { cleanupErrors.push(error); }
    }
  }
  return cleanupErrors;
}

async function observeLiveStart(witness: HostIncusLiveWitness, scope: IncusQualificationScope,
  preset: SandboxPreset) {
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
  return observed;
}

function caseEvidence(observed: Awaited<ReturnType<HostIncusLiveWitness["observe"]>>,
  now: () => number): IncusLiveCaseEvidence {
  const verifiedAt = new Date(now()).toISOString();
  const validUntil = new Date(now() + 60 * 60 * 1000).toISOString();
  return { observation: observed.observation, observedProfile: observed.profile,
    observedImageDigest: observed.imageDigest, observedHelperDigest: observed.helperDigest,
    verifiedAt, validUntil, cases: CASE_IDS.map(caseId => ({ caseId, status: "passed" as const })) };
}

/** Start one run. The supervisor terminates this process after accepting the saved checkpoint. */
export async function beginDurableIncusLiveCases(options: IncusLiveRunnerOptions & { witness: DurableIncusLiveWitness },
  scope: IncusQualificationScope, preset: SandboxPreset,
  run: { runId: string; nonce: string; deadlineMs: number }): Promise<{ runId: string; state: "AWAITING_RESTART" }> {
  const { witness } = options;
  const now = options.now ?? Date.now;
  requireFact(validDurableRun(run.runId, run.nonce), "run identity is invalid");
  requireFact(Number.isSafeInteger(run.deadlineMs) && run.deadlineMs > now()
    && run.deadlineMs <= now() + QUALIFICATION_PHASE_MS,
  "qualification preparation deadline is invalid");
  await observeLiveStart(witness, scope, preset);
  const state: FixtureRunState = { primary: null, unrelated: null, recovery: null,
    primaryDestroyed: false, unrelatedDestroyed: false, recoveryDestroyed: false };
  let failure: unknown;
  let stage: IncusQualificationPreparationStage = "fixtures";
  try {
    await createLiveFixtures(witness, scope, preset, run.runId, state, value => { stage = value; });
    requireFact(now() < run.deadlineMs, "qualification preparation deadline expired");
    requireFact(state.primary, "primary fixture was not created");
    stage = "guest_preparation";
    await prepareGuestForRestart(witness, preset, state.primary, run.runId, options.composeFixtureImageRef);
    requireFact(now() < run.deadlineMs, "qualification preparation deadline expired");
    // The handoff clock starts after guest setup and controlled loads, not at HTTP admission.
    stage = "restart_handoff";
    await witness.beginRestart(scope, preset, state.primary, run.runId, run.nonce,
      now() + RESTART_HANDOFF_MS);
    return { runId: run.runId, state: "AWAITING_RESTART" };
  } catch (error) {
    failure = error;
  }
  const preservedFailure = preservedPreparationFailure(failure);
  const errors = preservedFailure ? [] : await cleanupLiveFixtures(witness, state);
  if (preservedFailure) throw preservedFailure;
  throw new IncusQualificationPreparationError(stage, errors.length ? "unverified" : "confirmed", incusPreparationCauseCode(failure), failure instanceof IncusCpuLoadProofError ? incusCpuLoadDiagnostic(failure.diagnostic) : null,
    failure instanceof IncusLimitLoadFailure ? incusLimitResource(failure.resource) : null);
}

/** Called only in the replacement app process, with a fresh witness and database connection. */
export async function resumeDurableIncusLiveCases(options: IncusLiveRunnerOptions & { witness: DurableIncusLiveWitness },
  scope: IncusQualificationScope, preset: SandboxPreset,
  run: { runId: string; nonce: string }): Promise<IncusLiveCaseEvidence> {
  const { witness } = options;
  const now = options.now ?? Date.now;
  requireFact(validDurableRun(run.runId, run.nonce), "run identity is invalid");
  const primary = await witness.claimRestart(scope, preset, run.runId, run.nonce);
  const continuationDeadlineMs = now() + QUALIFICATION_PHASE_MS;
  requireFact(primary.operationId === `qual-primary-${run.runId}`, "claimed primary fixture changed");
  const state: FixtureRunState = { primary, unrelated: null, recovery: null,
    primaryDestroyed: false, unrelatedDestroyed: false, recoveryDestroyed: false };
  let failure: unknown;
  let observed: Awaited<ReturnType<HostIncusLiveWitness["observe"]>> | undefined;
  try {
    const unrelated = await witness.findFixture(scope, `qual-unrelated-${run.runId}`);
    requireFact(unrelated.sandboxId !== primary.sandboxId, "unrelated fixture was adopted");
    state.unrelated = unrelated;
    observed = await observeLiveStart(witness, scope, preset);
    assertInspection(await witness.inspectFixture(unrelated), unrelated, preset, "stopped");
    await finishGuestAfterRestart(witness, preset, primary, run.runId);
    requireFact(now() < continuationDeadlineMs, "qualification continuation deadline expired");
    await destroyAndRecoverFixtures(witness, scope, preset, run.runId, state);
    requireFact(now() < continuationDeadlineMs, "qualification continuation deadline expired");
  } catch (error) {
    failure = error;
  }
  const cleanupErrors = failure instanceof IncusQualificationOperationUnsettledError ? [] : await cleanupLiveFixtures(witness, state);
  if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors],
    "Incus live fixture cleanup is unverified");
  if (failure) throw failure;
  requireFact(observed, "live observation is unavailable");
  return caseEvidence(observed, options.now ?? Date.now);
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
    const observed = await observeLiveStart(witness, scope, preset);

    const fixtureToken = randomUUID();
    // The witness must reconcile or clean a create that throws before it can
    // return a handle. Once a handle exists, all later failures clean it here.
    const state: FixtureRunState = { primary: null, unrelated: null, recovery: null,
      primaryDestroyed: false, unrelatedDestroyed: false, recoveryDestroyed: false };
    let failure: unknown;
    let cleanupErrors: unknown[] = [];
    try {
      await createLiveFixtures(witness, scope, preset, fixtureToken, state);
      requireFact(state.primary, "primary fixture was not created");
      await exerciseGuestAndRestart(witness, preset, state.primary, fixtureToken, options.composeFixtureImageRef);
      await destroyAndRecoverFixtures(witness, scope, preset, fixtureToken, state);
    } catch (error) {
      failure = error;
    } finally {
      const preservedFailure = preservedPreparationFailure(failure);
      if (preservedFailure) failure = preservedFailure;
      cleanupErrors = preservedFailure ? [] : await cleanupLiveFixtures(witness, state);
    }
    if (cleanupErrors.length) throw new AggregateError([...(failure ? [failure] : []), ...cleanupErrors],
      "Incus live fixture cleanup is unverified");
    if (failure) throw failure;

    return caseEvidence(observed, now);
  };
}
