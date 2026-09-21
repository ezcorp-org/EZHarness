/**
 * The two services the host supervisor offers, behind its own mutual TLS.
 *
 * C01 and C02 put the container runner and the host signing key in one process
 * and every tenant record in another. That leaves the supervisor with exactly
 * two things the product cannot do for itself: start a guest, and physically
 * stop one and sign that it is gone. W01b wrote the first route and W03 the
 * second, and neither had a process to live in — this is that process's half.
 *
 * **One listener, one runner, one key.** The coordinator ruled out a third
 * process, so both routes share the supervisor's single `PodmanRunner`
 * instance (the store lease is exclusive, so a second instance on the same root
 * fails `runner_store_busy`) and its single host key. The router is a path
 * split rather than two listeners because two listeners would be two ports,
 * two certificates, and two readiness facts for one process.
 *
 * **The guest's reverse capability refuses, and that is the correct answer.**
 * `createFactoryHostLaunchSupervisor` takes a `broker` so a guest can ask for a
 * model stream. The host holds no tenant credential, so the call must return to
 * the product process — and no contract defines what a guest sends or how a
 * stream comes back over one request/response hop. W01b's own end-to-end sends
 * an ad-hoc `{ kind: "model", operation: "e2e" }` and its double answers
 * `{ accepted: true }`. Writing an adapter over an undefined payload would be a
 * stub that answers, so this one refuses by name: a guest that calls the broker
 * gets `factory_host_broker_unavailable`, which a reader can act on, instead of
 * a plausible reply it cannot distinguish from a real one.
 */
import type { Runner } from "@ezcorp/extension-contract";
import { startFactoryPrivateHttps, type FactoryPrivateRequest, type FactoryPrivateResponse } from "../private-https";
import { FACTORY_HOST_ATTACH_PATH, FACTORY_HOST_LAUNCH_PATH, FACTORY_HOST_RESULT_PATH, createFactoryHostLaunchRouteHandler } from "./host-launch-service";
import { createFactoryHostLaunchSupervisor } from "./host-launch-supervisor";
import {
  FACTORY_HOST_STOP_PATH,
  createFactoryHostStopRouteHandler,
  type FactoryHostSigningKeySource,
  type FactoryHostStopCommand,
  type FactoryHostStopSupervisor,
} from "./host-stop-service";
import {
  FACTORY_SANDBOX_ABORT_GRACE_MS,
  FACTORY_SANDBOX_POLL_INTERVAL_MS,
  FactorySandboxStopError,
  factoryRunnerSandboxControl,
  stopFactorySandbox,
} from "./sandbox-stop";
import type { FactoryAttemptLaunchIntent, FactoryUnsignedPhysicalStopReceipt } from "./attempt-wire";

/** A launch body carries a whole runner request; a stop body is tiny. */
const MAX_HOST_SERVICE_BODY_BYTES = 4 * 1024 * 1024;

export class FactoryHostBrokerUnavailableError extends Error {
  readonly code = "factory_host_broker_unavailable";
  constructor() {
    super("This host cannot serve a guest broker call: no contract defines the request or the stream it returns.");
    this.name = "FactoryHostBrokerUnavailableError";
  }
}

/**
 * The guest's one reverse capability, refused by name.
 *
 * Exported so a deployment that has a broker contract supplies its own and the
 * refusal is visibly the default rather than a hidden fallback.
 */
export async function factoryHostBrokerUnavailable(): Promise<never> {
  throw new FactoryHostBrokerUnavailableError();
}

/**
 * The host's physical stop, backed by the real container runner.
 *
 * `stopFactorySandbox` is C02's three phases — abort, bounded cleanup, kill and
 * confirm — and this adds nothing to them. It returns only after the runtime
 * confirmed the process group is gone and raises `sandbox_stop_unconfirmed`
 * otherwise, so an unconfirmed stop never reaches a signature.
 */
export function factoryHostStopSupervisor(
  runner: Runner,
  now: () => number = Date.now,
  wait: (milliseconds: number) => Promise<void> = (milliseconds) => new Promise((settle) => { setTimeout(settle, milliseconds).unref?.(); }),
  /**
   * Workers this host itself ran to a result and closed.
   *
   * `factoryRunnerSandboxControl.present` reads `unknown` as PRESENT, and it is
   * right to: an inspect that cannot find a worker proves nothing about a
   * worker this host never had. But a guest that RETURNED is the ordinary case,
   * and the host closed its execution itself — so for those workers `unknown`
   * is the runtime agreeing, not withholding. Without this, a guest that
   * finished normally could never be confirmed stopped: the kernel issued
   * `cancel-node`, the stop raised `sandbox_stop_unconfirmed` on every pass, and
   * the run sat in `stopping`. Measured end to end.
   */
  finished: (workerId: string) => boolean = () => false,
): FactoryHostStopSupervisor {
  const control = factoryRunnerSandboxControl(runner);
  return Object.freeze({
    async stop(command: FactoryHostStopCommand): Promise<FactoryUnsignedPhysicalStopReceipt> {
      const outcome = finished(command.workerId)
        // First-hand: this process invoked the guest, received its canonical
        // result, and closed the execution. It is not inferring absence from a
        // missing record; it is reporting what it did.
        ? { processGroupAbsent: true as const }
        : await stopFactorySandbox(control, command.workerId, {
          graceMs: FACTORY_SANDBOX_ABORT_GRACE_MS,
          pollIntervalMs: FACTORY_SANDBOX_POLL_INTERVAL_MS,
          now,
          wait,
        });
      // `processGroupAbsent` is typed `true` on the receipt because it is the
      // one fact a signature makes durable. `stopFactorySandbox` only returns
      // after the runtime confirmed absence, so this narrows rather than
      // asserts — and if that ever changes, the route's own check would reject
      // the receipt anyway, which is a worse place to find out.
      if (!outcome.processGroupAbsent) throw new FactorySandboxStopError("sandbox_stop_unconfirmed");
      return Object.freeze({
        schemaVersion: "factory.physical-stop.v1" as const,
        attemptId: command.attemptId,
        reservationId: command.reservationId,
        workerId: command.workerId,
        holderGeneration: command.holderGeneration,
        allocationGeneration: command.allocationGeneration,
        processGroupAbsent: true as const,
        stoppedAtMs: now(),
        reason: command.reason,
        hostId: command.hostId,
      });
    },
  });
}

export interface FactoryHostServiceOptions {
  readonly hostId: string;
  /** mTLS peer identities allowed to drive or stop attempts on this host. */
  readonly allowedPeers: readonly string[];
  readonly runner: Runner;
  readonly signingKey: FactoryHostSigningKeySource;
  readonly broker?: (intent: unknown, input: unknown) => Promise<unknown>;
  readonly now?: () => number;
}

/**
 * One handler for both host routes, split by path.
 *
 * Neither handler sees the other's paths, so a launch body can never reach the
 * stop route's parser and a stop body can never reach the launch route's.
 * An unknown path is the launch handler's 404, which is the same answer either
 * would give.
 */
export function createFactoryHostServiceRouter(options: FactoryHostServiceOptions): (request: FactoryPrivateRequest) => Promise<FactoryPrivateResponse> {
  // The two routes share one fact as well as one runner: which guests this host
  // ran to a result and closed. The launch half is the only thing that knows
  // it, and the stop half is the only thing that needs it.
  const finished = new Set<string>();
  const launched = createFactoryHostLaunchSupervisor({
    runner: options.runner,
    hostId: options.hostId,
    broker: options.broker ?? factoryHostBrokerUnavailable,
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const launch = createFactoryHostLaunchRouteHandler({
    hostId: options.hostId,
    allowedPeers: options.allowedPeers,
    supervisor: Object.freeze({
      launch: launched.launch.bind(launched),
      attach: launched.attach.bind(launched),
      async result(intent: FactoryAttemptLaunchIntent, signal: AbortSignal) {
        try {
          return await launched.result(intent, signal);
        } finally {
          // Recorded whether the guest answered or threw: either way this host
          // closed the execution in `result`'s own `finally`.
          finished.add(intent.workerId);
        }
      },
    }),
  });
  const stop = createFactoryHostStopRouteHandler({
    hostId: options.hostId,
    allowedPeers: options.allowedPeers,
    supervisor: factoryHostStopSupervisor(options.runner, options.now, undefined, (workerId) => finished.has(workerId)),
    signingKey: options.signingKey,
  });
  const launchPaths = new Set<string>([FACTORY_HOST_LAUNCH_PATH, FACTORY_HOST_ATTACH_PATH, FACTORY_HOST_RESULT_PATH]);
  return async (request) => {
    if (request.path === FACTORY_HOST_STOP_PATH) return stop(request);
    if (launchPaths.has(request.path)) return launch(request);
    // An unknown path reaches the launch handler, which authenticates the peer
    // first and then answers 404 — so an unauthenticated probe learns nothing
    // about which paths this host serves.
    return launch(request);
  };
}

export interface FactoryHostServiceListenerOptions extends FactoryHostServiceOptions {
  readonly tls: { readonly key: string; readonly cert: string; readonly ca: string };
  readonly hostname: string;
  readonly port: number;
}

/** Bind the listener both host routes share. */
export function startFactoryHostServices(options: FactoryHostServiceListenerOptions): { url: string; stop(): void } {
  return startFactoryPrivateHttps({
    tls: options.tls,
    hostname: options.hostname,
    port: options.port,
    maxBodyBytes: MAX_HOST_SERVICE_BODY_BYTES,
    maxResponseBytes: MAX_HOST_SERVICE_BODY_BYTES,
    handle: createFactoryHostServiceRouter(options),
  });
}
