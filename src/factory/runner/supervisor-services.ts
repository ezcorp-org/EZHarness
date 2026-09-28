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
 * **The guest's reverse capability is forwarded or refused, never answered
 * here.** `createFactoryHostLaunchSupervisor` takes a {@link FactoryGuestBroker}
 * so a guest can stage an output or ask for a model call. This process holds
 * the container runner and the host signing key and no tenant credential; the
 * material service and the provider live in the product process. Answering
 * from here would be answering a model call with no model.
 *
 * A supervisor whose configuration names `services.guestBrokers` passes a
 * broker that picks the forwarding client from `guest-broker-client.ts` for the
 * attempt's own tenant: it carries a staging frame or a
 * `FactoryGuestModelRequest` to that tenant's product route under the guest's
 * own attempt token. Everything else, and every call on a host with no
 * such section, gets `factory_host_broker_unavailable`, which a reader can act
 * on, instead of a plausible reply it cannot distinguish from a real one.
 */
import type { Runner } from "@ezcorp/extension-contract";
import { startFactoryPrivateHttps, type FactoryPrivateRequest, type FactoryPrivateResponse } from "../private-https";
import { FACTORY_HOST_ATTACH_PATH, FACTORY_HOST_LAUNCH_PATH, FACTORY_HOST_RESULT_PATH, createFactoryHostLaunchRouteHandler } from "./host-launch-service";
import { createFactoryHostLaunchSupervisor } from "./host-launch-supervisor";
import { FactoryHostGuestTenants, type FactoryHostPeerTenants } from "./host-peer-tenants";
import type { FactoryGuestBroker } from "./guest-model-broker";
import type { FactorySupervisorPoolClient } from "./supervisor-pool-client";
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
import type { FactoryPhysicalStopReceipt, FactoryUnsignedPhysicalStopReceipt } from "./attempt-wire";

/** A launch body carries a whole runner request; a stop body is tiny. */
const MAX_HOST_SERVICE_BODY_BYTES = 4 * 1024 * 1024;

export class FactoryHostBrokerUnavailableError extends Error {
  readonly code = "factory_host_broker_unavailable";
  constructor(message = "This host cannot serve a guest broker call: no contract defines the request or the stream it returns.") {
    super(message);
    this.name = "FactoryHostBrokerUnavailableError";
  }
}

/**
 * The guest's one reverse capability, refused by name.
 *
 * Exported so a deployment that can reach a provider from its hosts supplies
 * its own and the refusal is visibly the default rather than a hidden fallback.
 */
export const factoryHostBrokerUnavailable: FactoryGuestBroker = Object.freeze({
  async invoke(): Promise<never> {
    throw new FactoryHostBrokerUnavailableError();
  },
});

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
  /** Each mTLS peer allowed to drive or stop attempts on this host, bound to the one tenant it acts for. */
  readonly peerTenants: FactoryHostPeerTenants;
  readonly runner: Runner;
  readonly signingKey: FactoryHostSigningKeySource;
  readonly broker?: FactoryGuestBroker;
  /** Whether a granted device node exists on this host; the launch supervisor's own check unless a test replaces it. */
  readonly devicePresent?: (path: string) => Promise<boolean>;
  /**
   * The pool, as the only process allowed to tell it a guest is gone.
   *
   * C03 does not release a host's capacity on a tenant's word: the product's
   * own confirmation READS the ledger and fails closed until a trusted
   * supervisor has settled it. So a signed receipt that never leaves this
   * process is a receipt the pool will never honour, and the attempt's stop
   * stays durably uncertain however correct every other party was.
   *
   * Absent for an installation whose supervisor is not configured to reach the
   * pool. That is a named degradation rather than a silent one: the route still
   * signs, and the product still reports its own refusal by name.
   */
  readonly pool?: FactorySupervisorPoolClient;
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
  // And which tenant each guest belongs to: the launch half records it once the
  // peer's tenant matched the intent's, and the stop half checks a stop against it.
  const guestTenants = new FactoryHostGuestTenants();
  const launch = createFactoryHostLaunchRouteHandler({
    hostId: options.hostId,
    peerTenants: options.peerTenants,
    guestTenants,
    supervisor: createFactoryHostLaunchSupervisor({
      runner: options.runner,
      hostId: options.hostId,
      broker: options.broker ?? factoryHostBrokerUnavailable,
      // Recorded when the guest settles, whether it answered or died: that is
      // when this host closes the execution, and a read of the answer may
      // come later or never.
      onClosed: (workerId) => { finished.add(workerId); },
      // A guest this host refused before any container existed (W02d R4) is as first-hand an absence as one it
      // closed: nothing was created, so its stop is signed without asking the runtime to prove it.
      onRefused: (workerId) => { finished.add(workerId); },
      ...(options.devicePresent === undefined ? {} : { devicePresent: options.devicePresent }),
      ...(options.now === undefined ? {} : { now: options.now }),
    }),
  });
  const stop = createFactoryHostStopRouteHandler({
    hostId: options.hostId,
    peerTenants: options.peerTenants,
    guestTenants,
    supervisor: factoryHostStopSupervisor(options.runner, options.now, undefined, (workerId) => finished.has(workerId)),
    signingKey: options.signingKey,
  });
  const launchPaths = new Set<string>([FACTORY_HOST_LAUNCH_PATH, FACTORY_HOST_ATTACH_PATH, FACTORY_HOST_RESULT_PATH]);
  return async (request) => {
    if (request.path === FACTORY_HOST_STOP_PATH) return presentStop(await stop(request), options.pool);
    if (launchPaths.has(request.path)) return launch(request);
    // An unknown path reaches the launch handler, which authenticates the peer
    // first and then answers 404 — so an unauthenticated probe learns nothing
    // about which paths this host serves.
    return launch(request);
  };
}

/**
 * Tell the pool the process group is gone, before telling the caller it is.
 *
 * The order matters and is the whole point. The product's own confirmation
 * reads the pool's ledger, so a 200 returned before the pool knows is a 200 the
 * product cannot act on: it settles nothing, marks the stop uncertain, and
 * retries. Answering 502 instead keeps the retry and makes it say why — and the
 * retry costs nothing, because a stop for a worker this host already finished
 * is answered from first-hand knowledge rather than by stopping it again.
 */
async function presentStop(response: FactoryPrivateResponse, pool: FactorySupervisorPoolClient | undefined): Promise<FactoryPrivateResponse> {
  if (response.status !== 200 || pool === undefined) return response;
  let receipt: FactoryPhysicalStopReceipt;
  try { receipt = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(response.body)) as FactoryPhysicalStopReceipt; }
  catch { return response; }
  try {
    await pool.presentStopReceipt(receipt);
    return response;
  } catch {
    return Object.freeze({
      status: 502,
      headers: { "content-type": "application/json" },
      body: new TextEncoder().encode(JSON.stringify({ error: "pool_unconfirmed" })),
    });
  }
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
