import { executionLimits } from "@ezcorp/extension-runner";
import type { Runner, RunnerExecution } from "@ezcorp/extension-contract";
import { validateFactoryRunnerResult, type FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { FactoryAttemptRuntimeError, type FactoryAttemptLaunchIntent } from "./attempt-wire";
import { FACTORY_GUEST_BROKER_METHOD, factoryGuestFrameInput } from "./guest-frames";
import type { FactoryHostAttemptHandle, FactoryHostLaunchSupervisor } from "./host-launch-service";

export interface FactoryHostLaunchSupervisorOptions {
  readonly runner: Runner;
  readonly hostId: string;
  /**
   * The guest's one reverse capability, forwarded under the attempt's own
   * short-lived token. The host never holds a tenant credential, so this
   * returns to the product process rather than being served here.
   */
  readonly broker: (intent: FactoryAttemptLaunchIntent, input: unknown) => Promise<unknown>;
  readonly now?: () => number;
}

interface HostAttempt {
  readonly execution: RunnerExecution;
  readonly result: Promise<FactoryRunnerResult>;
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
  const live = new Map<string, HostAttempt>();

  const reverse = (intent: FactoryAttemptLaunchIntent, context: ReturnType<typeof startRequest>["context"]) =>
    async (method: string, input: unknown) => options.broker(intent, factoryGuestFrameInput(method, input, context, FACTORY_GUEST_BROKER_METHOD));

  const invoke = async (intent: FactoryAttemptLaunchIntent, execution: RunnerExecution, context: ReturnType<typeof startRequest>["context"]): Promise<FactoryRunnerResult> => {
    const value = await execution.request("extension/invoke", { name: intent.request.runner.export, input: intent.request, context });
    if (!validateFactoryRunnerResult(value).ok) throw new FactoryAttemptRuntimeError("invalid_request", "Factory guest result is invalid.");
    return value as FactoryRunnerResult;
  };

  const remember = (intent: FactoryAttemptLaunchIntent, execution: RunnerExecution, context: ReturnType<typeof startRequest>["context"]): HostAttempt => {
    const attempt: HostAttempt = { execution, result: invoke(intent, execution, context) };
    // A rejection is delivered when `result` is awaited; holding it here must not
    // raise an unhandled rejection in the meantime.
    attempt.result.catch(() => undefined);
    live.set(intent.workerId, attempt);
    return attempt;
  };

  const handle = (disposition: FactoryHostAttemptHandle["disposition"], intent: FactoryAttemptLaunchIntent): FactoryHostAttemptHandle =>
    Object.freeze({ disposition, workerId: intent.workerId, invocationId: intent.invocationId });

  const assertHost = (intent: FactoryAttemptLaunchIntent) => {
    if (intent.lease.hostId !== options.hostId) throw new FactoryAttemptRuntimeError("invalid_launch", "Factory launch intent names another host.");
  };

  const attachLive = async (intent: FactoryAttemptLaunchIntent): Promise<FactoryHostAttemptHandle> => {
    assertHost(intent);
    if (live.has(intent.workerId)) return handle("attached", intent);
    const inspection = await options.runner.inspect(intent.workerId);
    if (inspection.state !== "running") return handle(inspection.state === "unknown" ? "uncertain" : "terminal", intent);
    if (!options.runner.attach) throw new FactoryAttemptRuntimeError("launch_uncertain", "This host cannot reattach to a live guest.");
    const start = startRequest(intent, now);
    // A reattached guest never gets a second invocation: the result of the
    // first one is what a recovered caller reads.
    const execution = await options.runner.attach(start, async () => { throw new FactoryAttemptRuntimeError("invalid_launch", "Recovered factory guests cannot perform another effect."); });
    const recovered: HostAttempt = { execution, result: Promise.reject(new FactoryAttemptRuntimeError("launch_uncertain", "Recovered factory guests require a durable terminal result.")) };
    recovered.result.catch(() => undefined);
    live.set(intent.workerId, recovered);
    return handle("attached", intent);
  };

  return Object.freeze({
    async launch(intent: FactoryAttemptLaunchIntent): Promise<FactoryHostAttemptHandle> {
      assertHost(intent);
      if (live.has(intent.workerId)) return handle("attached", intent);
      const inspection = await options.runner.inspect(intent.workerId);
      if (inspection.state === "running") return attachLive(intent);
      if (inspection.state !== "unknown") return handle("terminal", intent);
      const start = startRequest(intent, now);
      const execution = await options.runner.start(start, reverse(intent, start.context));
      remember(intent, execution, start.context);
      return handle("started", intent);
    },
    attach: attachLive,
    async result(intent: FactoryAttemptLaunchIntent): Promise<FactoryRunnerResult> {
      assertHost(intent);
      const attempt = live.get(intent.workerId);
      if (!attempt) throw new FactoryAttemptRuntimeError("launch_uncertain", "This host is not running that attempt.");
      try { return await attempt.result; }
      finally { live.delete(intent.workerId); await attempt.execution.close().catch(() => undefined); }
    },
  });
}
