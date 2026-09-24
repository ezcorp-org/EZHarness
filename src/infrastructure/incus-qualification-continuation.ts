import { type IncusQualificationCheckpointStore, currentProcessIdentity, observationDigest,
  processIdentityKey, type RestartHandoffPayload, type SignedRestartHandoff }
  from "./incus-qualification-checkpoint";
import type { IncusQualificationFixtureService, IncusQualificationScope } from "./incus-qualification";
import type { LiveFixtureHandle, LiveFixtureInspection } from "./incus-live-cases";
import type { RecoveryObservation } from "./incus-live-recovery-probes";
import type { HostIncusLiveReadback, LiveReadbackContext } from "./incus-transport/live-readback";

type FixtureReader = Pick<IncusQualificationFixtureService, "status">;
type BackendReader = Pick<HostIncusLiveReadback, "instance">;

export interface IncusContinuationDependencies {
  checkpoints: IncusQualificationCheckpointStore;
  fixtures: FixtureReader;
  readback: BackendReader;
  /** Must be rebuilt from the current authorized release and verified operator setup in each process. */
  context: LiveReadbackContext;
}

/** This is restart evidence only. The caller must still execute the remaining live cases. */
export interface ClaimedIncusRestart {
  runId: string;
  scope: IncusQualificationScope;
  handle: LiveFixtureHandle;
  before: RecoveryObservation;
  after: RecoveryObservation;
}

export type PreparedIncusRestart = Omit<RestartHandoffPayload, "version" | "newProcess" | "afterDigest">;

function requireStopped(value: boolean): void {
  if (!value) throw new Error("Incus qualification continuation requires the exact stopped fixture");
}

/** A small entrypoint for the app process on either side of an operator restart. */
export class IncusQualificationContinuation {
  constructor(private readonly deps: IncusContinuationDependencies) {}

  private async observe(scope: IncusQualificationScope, handle: LiveFixtureHandle): Promise<RecoveryObservation> {
    const { context, fixtures, readback } = this.deps;
    const image = context.recipe.guestImage;
    if (!image) throw new Error("Incus qualification continuation requires the exact stopped fixture");
    requireStopped(context.scope.installationId === scope.installationId
      && context.scope.releaseId === scope.releaseId
      && context.scope.connectionId === scope.connectionId
      && context.preset.id === scope.presetId
      && image.fingerprint === context.preset.imageDigest
      && context.preset.helperDigests.includes(image.helperSha256));
    const durable = await fixtures.status(scope, handle.operationId);
    requireStopped(durable.fixture.bindingId === handle.sandboxId
      && durable.fixture.operationId === handle.operationId
      && durable.fixture.connectionRevision === context.connection.revision
      && durable.binding.id === handle.sandboxId
      && durable.binding.desiredState === "STOPPED"
      && durable.binding.observedState === "STOPPED"
      && durable.operation?.state === "SUCCEEDED"
      && durable.operation.generation === durable.binding.generation);
    const instance = await readback.instance(context, handle.sandboxId);
    requireStopped(instance.state === "stopped" && instance.imageDigest === context.preset.imageDigest
      && instance.profile === context.preset.profile
      && instance.memoryBytes !== undefined && instance.cpuMillis !== undefined
      && instance.pids !== undefined && instance.diskBytes !== undefined
      && instance.storageDriver !== undefined && instance.privateNetwork === true
      && instance.restrictedProject === true && instance.unprivileged === true);
    const backend: LiveFixtureInspection = {
      sandboxId: handle.sandboxId, state: "stopped", imageDigest: instance.imageDigest!,
      helperDigest: image.helperSha256, profile: instance.profile!,
      workspaceRoot: "/workspace", guestUser: context.connection.configuration.guestUser,
      memoryBytes: instance.memoryBytes!, cpuMillis: instance.cpuMillis!, pids: instance.pids!,
      diskBytes: instance.diskBytes!, storageDriver: instance.storageDriver!,
      privateNetwork: true, restrictedProject: true, unprivileged: true, bootId: null,
    };
    return { processId: processIdentityKey(currentProcessIdentity()), durable, backend };
  }

  async prepare(input: { runId: string; nonce: string; deadlineMs: number;
    scope: IncusQualificationScope; handle: LiveFixtureHandle }): Promise<PreparedIncusRestart> {
    const before = await this.observe(input.scope, input.handle);
    await this.deps.checkpoints.begin({ ...input, before });
    const run = await this.deps.checkpoints.get(input.runId);
    if (!run) throw new Error("Incus restart checkpoint is unavailable");
    return { runId: input.runId, nonce: input.nonce, deadlineMs: input.deadlineMs,
      scope: input.scope, fixtureOperationId: input.handle.operationId,
      bindingId: input.handle.sandboxId, generation: run.generation,
      connectionRevision: run.connectionRevision, lastOperationId: run.lastOperationId,
      oldProcess: currentProcessIdentity(), beforeDigest: observationDigest(before) };
  }

  async resume(runId: string, nonce: string,
    requestReceipt: (payload: RestartHandoffPayload) => Promise<SignedRestartHandoff>): Promise<ClaimedIncusRestart> {
    const run = await this.deps.checkpoints.get(runId);
    if (run?.state !== "AWAITING_RESTART" || run.nonce !== nonce) {
      throw new Error("Incus restart checkpoint is unavailable");
    }
    const handle = { operationId: run.fixtureOperationId, sandboxId: run.bindingId };
    const after = await this.observe(run.scope, handle);
    const payload: RestartHandoffPayload = {
      version: 1, runId, nonce, deadlineMs: new Date(run.deadlineAt).getTime(),
      scope: run.scope, fixtureOperationId: handle.operationId, bindingId: handle.sandboxId,
      generation: run.generation, connectionRevision: run.connectionRevision,
      lastOperationId: run.lastOperationId, oldProcess: run.oldProcessIdentity,
      newProcess: currentProcessIdentity(), beforeDigest: run.beforeDigest,
      afterDigest: observationDigest(after),
    };
    const receipt = await requestReceipt(payload);
    const confirmed = await this.observe(run.scope, handle);
    requireStopped(observationDigest(confirmed) === payload.afterDigest);
    await this.deps.checkpoints.claim({ runId, nonce, receipt, after: confirmed });
    return { runId, scope: run.scope, handle, before: run.beforeObservation, after: confirmed };
  }
}
