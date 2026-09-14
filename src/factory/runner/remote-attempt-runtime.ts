import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryRunnerRequest, FactoryRunnerResult } from "@ezcorp/factory-sdk";
import type { FactoryHostLaunchTransport } from "../host-launch-client";
import type { FactoryPreparedPackageReceipt, FactoryRunnerDispatchReadiness } from "../package-preparation";
import type { PoolAdmissionClient } from "../pool/client";
import { FactoryAttemptRuntimeError, type FactoryAttemptDeviceAuthorization, type FactoryAttemptLaunchIntent, type FactoryAttemptLaunchStore, type FactoryAttemptLease, type FactoryAttemptOpen, type FactoryAttemptRuntime, type FactoryPhysicalStopReason, type FactoryPhysicalStopReceipt } from "./attempt-runtime";

export interface FactoryRemoteAttemptRuntimeOptions {
  /** Every durable record stays here, in the product process. */
  readonly launches: FactoryAttemptLaunchStore;
  /** The one thing this process cannot do: touch a container. */
  readonly transport: FactoryHostLaunchTransport;
  readonly readiness: FactoryRunnerDispatchReadiness;
  readonly mintAttemptToken: (request: FactoryRunnerRequest) => Promise<string>;
  readonly pool: Pick<PoolAdmissionClient, "acknowledgeStart">;
  /** W03's signed physical stop. The product never signs a host observation itself. */
  readonly stop: (intent: FactoryAttemptLaunchIntent, reason: FactoryPhysicalStopReason) => Promise<FactoryPhysicalStopReceipt>;
}

/**
 * The same durable attempt runtime, with the guest running somewhere else.
 *
 * Every record this makes is local: the launch intent, its one-winner claim, and
 * the terminal result all live in the product database exactly as the in-process
 * runtime writes them. Only the physical launch, reconnect, and result cross the
 * wire, which is why a host holds no tenant record and the deployment choice is
 * invisible to the dispatcher above it.
 */
export class FactoryRemoteAttemptRuntime implements FactoryAttemptRuntime {
  constructor(private readonly options: FactoryRemoteAttemptRuntimeOptions) {}

  async open(request: FactoryRunnerRequest, lease: FactoryAttemptLease, preparedPackage: FactoryPreparedPackageReceipt, devices?: FactoryAttemptDeviceAuthorization): Promise<FactoryAttemptOpen> {
    const persisted = await this.options.launches.prepare(request, lease, preparedPackage, devices);
    const attemptId = persisted.request.authority.attemptId;
    const recovered = await this.options.launches.terminalResult(attemptId);
    if (recovered) return this.settled(persisted, "terminal", async () => recovered);

    const claim = await this.options.launches.claimStart(attemptId);
    if (!claim.claimed) return this.reconnect(claim.intent);

    const claimed = claim.intent;
    let tokened: FactoryAttemptLaunchIntent;
    try {
      await this.assertReady(claimed);
      tokened = this.withToken(claimed, await this.options.mintAttemptToken(claimed.request));
    } catch (error) {
      // No guest exists and no token reached one, so the claim is released.
      await this.options.launches.state(attemptId, "prepared");
      throw error;
    }

    const handle = await this.options.transport.launch(tokened).catch(async error => {
      // A lost launch response is not an absent guest. Ask the host what it has.
      const attached = await this.options.transport.attach(tokened).catch(() => undefined);
      if (attached?.disposition === "attached") return attached;
      await this.options.launches.state(attemptId, "uncertain");
      throw error;
    });
    await this.options.pool.acknowledgeStart({ reservationId: claimed.lease.reservationId, grantRevision: claimed.lease.grantRevision, allocationGeneration: claimed.lease.allocationGeneration, allocationToken: claimed.lease.allocationToken });
    await this.options.launches.state(attemptId, "launched");
    if (handle.disposition === "started") return this.settled(tokened, "started", () => this.awaitResult(tokened));
    return this.settled(tokened, handle.disposition, () => this.durable(attemptId, "Factory attempt outcome is uncertain after a reconnect."));
  }

  private withToken(intent: FactoryAttemptLaunchIntent, token: string): FactoryAttemptLaunchIntent {
    const request = JSON.parse(canonicalJson({ ...intent.request, broker: { ...intent.request.broker, attemptToken: token } })) as FactoryRunnerRequest;
    return Object.freeze({ ...intent, request });
  }

  private async assertReady(intent: FactoryAttemptLaunchIntent): Promise<void> {
    const receipt = await this.options.readiness.assertDispatchReady(intent.request);
    if (receipt.receiptDigest !== intent.preparedPackage.receiptDigest || receipt.artifactDigest !== intent.preparedPackage.artifactDigest) throw new FactoryAttemptRuntimeError("invalid_launch", "Prepared package changed before the attempt token was minted.");
  }

  /**
   * Rejoins an attempt another gateway already claimed.
   *
   * The durable claim says a launch happened, so this must never issue a second
   * one; it reconnects over the same attach path the in-process runtime uses. A
   * host that is still running the guest still holds its in-flight result, so a
   * gateway that restarted mid-launch collects that result and records it rather
   * than abandoning the attempt. A host that also restarted holds nothing, and
   * the attempt stays uncertain rather than being guessed at.
   */
  private async reconnect(intent: FactoryAttemptLaunchIntent): Promise<FactoryAttemptOpen> {
    const attemptId = intent.request.authority.attemptId;
    let tokened: FactoryAttemptLaunchIntent;
    try {
      await this.assertReady(intent);
      tokened = this.withToken(intent, await this.options.mintAttemptToken(intent.request));
    } catch (error) {
      // A live guest already holds authority, so nothing is released here.
      await this.options.launches.state(attemptId, "uncertain");
      throw error;
    }
    const handle = await this.options.transport.attach(tokened);
    return this.settled(tokened, handle.disposition === "terminal" ? "terminal" : "attached", async () => {
      const recorded = await this.options.launches.terminalResult(attemptId);
      if (recorded) return recorded;
      try { return await this.awaitResult(tokened); }
      catch { throw new FactoryAttemptRuntimeError("launch_uncertain", "Recovered factory workers require a durable terminal result before another invocation."); }
    });
  }

  /** The host's answer becomes durable before it is acknowledged, exactly as in process. */
  private async awaitResult(intent: FactoryAttemptLaunchIntent): Promise<FactoryRunnerResult> {
    const result = await this.options.transport.result(intent);
    const durable = await this.options.launches.recordTerminal(intent.request.authority.attemptId, result);
    await this.options.stop(intent, durable.status === "completed" ? "completed" : durable.status === "failed" ? "failed" : "cancelled");
    return durable;
  }

  private async durable(attemptId: string, absent: string): Promise<FactoryRunnerResult> {
    const recorded = await this.options.launches.terminalResult(attemptId);
    if (!recorded) throw new FactoryAttemptRuntimeError("launch_uncertain", absent);
    return recorded;
  }

  private settled(intent: FactoryAttemptLaunchIntent, disposition: FactoryAttemptOpen["disposition"], wait: () => Promise<FactoryRunnerResult>): FactoryAttemptOpen {
    return Object.freeze({
      disposition,
      workerId: intent.workerId,
      invocationId: intent.invocationId,
      wait,
      stop: async (reason: FactoryPhysicalStopReason) => this.options.stop(intent, reason),
    });
  }
}
