import { stat } from "node:fs/promises";
import { executionLimits } from "@ezcorp/extension-runner";
import type { Runner, RunnerExecution } from "@ezcorp/extension-contract";
import { validateFactoryRunnerResult, type FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { FactoryAttemptRuntimeError, type FactoryAttemptLaunchIntent } from "./attempt-wire";
import { FACTORY_GUEST_BROKER_METHOD, factoryGuestFrameInput } from "./guest-frames";
import type { FactoryGuestBroker } from "./guest-model-broker";
import type { FactoryHostAttemptHandle, FactoryHostLaunchSupervisor } from "./host-launch-service";

export interface FactoryHostLaunchSupervisorOptions {
  readonly runner: Runner;
  readonly hostId: string;
  /**
   * The guest's one reverse capability, forwarded under the attempt's own
   * short-lived token. The host never holds a tenant credential, so this
   * returns to the product process rather than being served here.
   *
   * It is the same {@link FactoryGuestBroker} the in-process isolated runtime
   * takes. It used to be a bare function over the launch intent, which meant
   * one broker could not serve both runtimes.
   */
  readonly broker: FactoryGuestBroker;
  readonly now?: () => number;
  /** Told once, when this host closes a guest's execution, whether the guest answered or died. */
  readonly onClosed?: (workerId: string) => void;
  /** How long a settled answer waits here to be collected. */
  readonly retentionMs?: number;
  /** Whether a granted device node exists on this host; {@link factoryHostDevicePresent} unless a test replaces it. */
  readonly devicePresent?: (path: string) => Promise<boolean>;
}

/**
 * Whether a device node is present on this host: a character or block device at that path (W02d R4). It reads
 * only `/dev` metadata, so the host's closure stays free of any store.
 */
export async function factoryHostDevicePresent(path: string): Promise<boolean> {
  try {
    const node = await stat(path);
    return node.isCharacterDevice() || node.isBlockDevice();
  } catch {
    return false;
  }
}

/**
 * How long a settled answer is kept for the product to collect.
 *
 * The product collects it with a bounded long poll, so the call that carries
 * the answer can be lost: a timeout, a restart, a dropped connection. The
 * answer therefore outlives any one call and is dropped only after this, which
 * is far longer than the product's own wait for it.
 */
export const FACTORY_HOST_RESULT_RETENTION_MS = 15 * 60 * 1_000;

const DIAGNOSTIC_LIMIT = 1_024;
/** How long a dead guest's exit code may take to arrive before its account goes without it. */
const EXIT_CODE_WAIT_MS = 3_000;

/** What a guest's one invocation came to: its answer, or the typed reason it has none. */
type HostOutcome = { readonly result: FactoryRunnerResult } | { readonly error: FactoryAttemptRuntimeError };

interface HostAttempt {
  readonly outcome: Promise<HostOutcome>;
  /** A reattached guest's connection, released when its absent answer is first read. */
  release?: () => Promise<void>;
}

/** Waits for `outcome`, or throws when `signal` ends the wait first. The outcome itself is untouched. */
function untilAborted<T>(outcome: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new Error("Factory host result wait ended before the guest answered."));
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error("Factory host result wait ended before the guest answered."));
    signal.addEventListener("abort", abort, { once: true });
    outcome.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

function startRequest(intent: FactoryAttemptLaunchIntent, now: () => number) {
  const deadline = Math.min(intent.request.authority.deadlineAtMs, now() + executionLimits.timeoutMs);
  return {
    workerId: intent.workerId,
    artifactDigest: intent.preparedPackage.artifactDigest,
    context: { invocationId: intent.invocationId, workerId: intent.workerId, releaseId: intent.preparedPackage.artifactDigest, principalId: intent.request.authority.tenantId, scopeId: intent.request.authority.projectId, token: intent.request.broker.attemptToken, deadline },
    limits: executionLimits,
    devices: intent.devices.devices,
  };
}

/**
 * The host's own half of an attempt, and all of it.
 *
 * It holds live guest handles and the container runner, and nothing else: no
 * tenant database, no journal, no host signing key. The product process keeps
 * every durable record and asks this for the one thing it cannot do itself.
 *
 * A launch is issued exactly once per worker. A second launch for a worker this
 * host is already running reports `attached` rather than starting a second
 * guest, which is the same one-winner rule the durable claim enforces on the
 * other side of the wire.
 */
export function createFactoryHostLaunchSupervisor(options: FactoryHostLaunchSupervisorOptions): FactoryHostLaunchSupervisor {
  const now = options.now ?? Date.now;
  const retentionMs = options.retentionMs ?? FACTORY_HOST_RESULT_RETENTION_MS;
  const devicePresent = options.devicePresent ?? factoryHostDevicePresent;

  /**
   * A grant that names a node this host does not have is refused by name before any container exists (W02d R4),
   * rather than failing inside `podman run` with no typed reason.
   */
  const assertDevices = async (intent: FactoryAttemptLaunchIntent): Promise<void> => {
    for (const device of intent.devices.devices) {
      if (!await devicePresent(device)) throw new FactoryAttemptRuntimeError("device_unavailable", `Device ${device} granted to worker ${intent.workerId} is not present on host ${options.hostId}.`);
    }
  };
  const live = new Map<string, HostAttempt>();
  // A start still in flight. A second launch or an attach for the same worker
  // joins it rather than inspecting a container that is half created.
  const starting = new Map<string, Promise<void>>();

  const reverse = (intent: FactoryAttemptLaunchIntent, context: ReturnType<typeof startRequest>["context"]) =>
    async (method: string, input: unknown) => options.broker.invoke(intent.request, factoryGuestFrameInput(method, input, context, FACTORY_GUEST_BROKER_METHOD));

  const invoke = async (intent: FactoryAttemptLaunchIntent, execution: RunnerExecution, context: ReturnType<typeof startRequest>["context"]): Promise<FactoryRunnerResult> => {
    const value = await execution.request("extension/invoke", { name: intent.request.runner.export, input: intent.request, context });
    if (!validateFactoryRunnerResult(value).ok) throw new FactoryAttemptRuntimeError("invalid_request", "Factory guest result is invalid.");
    return value as FactoryRunnerResult;
  };

  /** Drops a held answer after `retentionMs`, unless a newer attempt for the worker replaced it. */
  const evictLater = (workerId: string, attempt: HostAttempt): void => {
    const evict = setTimeout(() => { if (live.get(workerId) === attempt) live.delete(workerId); }, retentionMs);
    evict.unref?.();
  };

  /**
   * Names why a guest ended without an answer, with what the runner can still see of it.
   *
   * The worker's exit code arrives a moment after its invocation fails, so the
   * account waits for it, briefly, and says `exit code unavailable` rather than
   * waiting on a process that never reports. A guest stopped at its deadline
   * says so: that is a timeout, not a crash.
   */
  const exited = async (workerId: string, execution: RunnerExecution, deadline: number, error: unknown): Promise<FactoryAttemptRuntimeError> => {
    const code = execution.exited === undefined ? undefined : await Promise.race([
      execution.exited.catch(() => null),
      new Promise<undefined>(resolve => { const timer = setTimeout(() => resolve(undefined), EXIT_CODE_WAIT_MS); timer.unref?.(); }),
    ]);
    const inspection = await options.runner.inspect(workerId).catch(() => undefined);
    const detail = [
      error instanceof Error ? error.message : String(error),
      code === undefined || code === null ? "exit code unavailable" : `exit code ${code}`,
      inspection ? `state ${inspection.state}` : "state unavailable",
      ...(now() >= deadline ? [`stopped at its deadline ${new Date(deadline).toISOString()}`] : []),
      ...(inspection?.diagnostics ?? []).map(diagnostic => `${diagnostic.code}: ${diagnostic.message}`),
    ].join("; ").slice(0, DIAGNOSTIC_LIMIT);
    return new FactoryAttemptRuntimeError("guest_exited", detail);
  };

  /**
   * Holds one invocation's outcome until it is collected.
   *
   * The execution closes when the guest settles, not when somebody reads the
   * answer, and the answer stays for `retentionMs` so a read that was lost on
   * the wire can be repeated. Reading it no longer deletes it: that is what
   * used to turn a timed-out read into an answer nobody could ever collect.
   */
  const remember = (intent: FactoryAttemptLaunchIntent, execution: RunnerExecution, context: ReturnType<typeof startRequest>["context"]): void => {
    const settle = async (): Promise<HostOutcome> => {
      let outcome: HostOutcome;
      try {
        outcome = { result: await invoke(intent, execution, context) };
        await execution.close().catch(() => undefined);
      } catch (error) {
        // Closed before the account is written: removing the container is when
        // the runner reads the container's own exit code.
        await execution.close().catch(() => undefined);
        outcome = { error: await exited(intent.workerId, execution, context.deadline, error) };
      }
      options.onClosed?.(intent.workerId);
      evictLater(intent.workerId, attempt);
      return outcome;
    };
    const attempt: HostAttempt = { outcome: settle() };
    live.set(intent.workerId, attempt);
  };

  const handle = (disposition: FactoryHostAttemptHandle["disposition"], intent: FactoryAttemptLaunchIntent): FactoryHostAttemptHandle =>
    Object.freeze({ disposition, workerId: intent.workerId, invocationId: intent.invocationId });

  const assertHost = (intent: FactoryAttemptLaunchIntent) => {
    if (intent.lease.hostId !== options.hostId) throw new FactoryAttemptRuntimeError("invalid_launch", "Factory launch intent names another host.");
  };

  /** Reconnects to what the runner has for the worker. Only ever called with no start of it in flight. */
  const reconnect = async (intent: FactoryAttemptLaunchIntent): Promise<FactoryHostAttemptHandle> => {
    if (live.has(intent.workerId)) return handle("attached", intent);
    const inspection = await options.runner.inspect(intent.workerId);
    if (inspection.state !== "running") return handle(inspection.state === "unknown" ? "uncertain" : "terminal", intent);
    if (!options.runner.attach) throw new FactoryAttemptRuntimeError("launch_uncertain", "This host cannot reattach to a live guest.");
    const start = startRequest(intent, now);
    // A reattached guest never gets a second invocation: the result of the
    // first one is what a recovered caller reads.
    const execution = await options.runner.attach(start, async () => { throw new FactoryAttemptRuntimeError("invalid_launch", "Recovered factory guests cannot perform another effect."); });
    // The invocation that would have carried the answer belonged to an earlier
    // supervisor, so this host can never produce it. It says so by name.
    const recovered: HostAttempt = {
      outcome: Promise.resolve({ error: new FactoryAttemptRuntimeError("attempt_unknown", "This host reattached the guest after a restart; the answer of its invocation was lost with the earlier supervisor.") }),
      release: () => execution.close().catch(() => undefined),
    };
    live.set(intent.workerId, recovered);
    evictLater(intent.workerId, recovered);
    return handle("attached", intent);
  };

  const attachLive = async (intent: FactoryAttemptLaunchIntent): Promise<FactoryHostAttemptHandle> => {
    assertHost(intent);
    await starting.get(intent.workerId);
    return reconnect(intent);
  };

  return Object.freeze({
    async launch(intent: FactoryAttemptLaunchIntent): Promise<FactoryHostAttemptHandle> {
      assertHost(intent);
      if (starting.has(intent.workerId) || live.has(intent.workerId)) return attachLive(intent);
      // Registered before the first await, so a second launch that arrives
      // while this one is still inspecting joins it instead of starting again.
      const begun = (async (): Promise<FactoryHostAttemptHandle> => {
        const inspection = await options.runner.inspect(intent.workerId);
        if (inspection.state === "running") return reconnect(intent);
        if (inspection.state !== "unknown") return handle("terminal", intent);
        await assertDevices(intent);
        const start = startRequest(intent, now);
        remember(intent, await options.runner.start(start, reverse(intent, start.context)), start.context);
        return handle("started", intent);
      })();
      const joined = begun.then(() => undefined, () => undefined);
      starting.set(intent.workerId, joined);
      try { return await begun; }
      finally { if (starting.get(intent.workerId) === joined) starting.delete(intent.workerId); }
    },
    attach: attachLive,
    /**
     * The guest's answer, or its typed absence, for as long as `signal` allows.
     *
     * `signal` bounds only this wait. Ending it leaves the guest and its answer
     * exactly where they were, so the product's next poll collects what this
     * one could not.
     */
    async result(intent: FactoryAttemptLaunchIntent, signal: AbortSignal): Promise<FactoryRunnerResult> {
      assertHost(intent);
      await untilAborted(starting.get(intent.workerId) ?? Promise.resolve(), signal);
      const attempt = live.get(intent.workerId);
      if (!attempt) throw new FactoryAttemptRuntimeError("attempt_unknown", "This host is not running that attempt.");
      const outcome = await untilAborted(attempt.outcome, signal);
      const release = attempt.release;
      attempt.release = undefined;
      await release?.();
      if ("error" in outcome) throw outcome.error;
      return outcome.result;
    },
  });
}
