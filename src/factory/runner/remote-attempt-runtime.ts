import { canonicalJson } from "@ezcorp/extension-contract";
import type { FactoryRunnerRequest, FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { FactoryHostLaunchRefusal, type FactoryHostLaunchTransport } from "../host-launch-client";
import type { FactoryPreparedPackageReceipt, FactoryRunnerDispatchReadiness } from "../package-preparation";
import type { PoolAdmissionClient } from "../pool/client";
import { failedFactoryRunnerResult, type NativeFactoryJournal } from "./native";
import { FACTORY_ATTEMPT_LEASE_RENEW_INTERVAL_MS, FactoryAttemptRuntimeError, type FactoryAttemptDeviceAuthorization, type FactoryAttemptLaunchIntent, type FactoryAttemptLaunchStore, type FactoryAttemptLease, type FactoryAttemptOpen, type FactoryAttemptRuntime, type FactoryPhysicalStopReason, type FactoryPhysicalStopReceipt } from "./attempt-runtime";

export interface FactoryRemoteAttemptRuntimeOptions {
  /** Every durable record stays here, in the product process. */
  readonly launches: FactoryAttemptLaunchStore;
  /** The one thing this process cannot do: touch a container. */
  readonly transport: FactoryHostLaunchTransport;
  readonly readiness: FactoryRunnerDispatchReadiness;
  readonly mintAttemptToken: (request: FactoryRunnerRequest) => Promise<string>;
  /** `renew` keeps the lease alive while the guest lives; the lease is liveness, not the task's timeout. */
  readonly pool: Pick<PoolAdmissionClient, "acknowledgeStart" | "renew">;
  /** W03's signed physical stop. The product never signs a host observation itself. */
  readonly stop: (intent: FactoryAttemptLaunchIntent, reason: FactoryPhysicalStopReason) => Promise<FactoryPhysicalStopReceipt>;
  /** The attempt's own durable journal, which a result recorded without the guest must repeat. */
  readonly journal: NativeFactoryJournal;
  /** Where the product says why an attempt ended without its guest's answer. */
  readonly report: (source: string, error: unknown) => void;
  readonly now?: () => number;
  readonly delay?: (ms: number) => Promise<void>;
  /** How long the host may stay silent before it counts as lost. */
  readonly supervisorSilenceMs?: number;
  /** How long a lost attempt's journal may keep an operation in flight before the record gives up. */
  readonly journalSettleMs?: number;
  /** How often the pool lease is renewed while the guest lives. */
  readonly leaseRenewIntervalMs?: number;
  /** Runs `task` after `ms` and returns its cancel. Replaceable so a test drives renewals itself. */
  readonly schedule?: (task: () => void, ms: number) => () => void;
}

/** Why an attempt ended without its guest's answer. Each is the `error.code` of the recorded result. */
export const FACTORY_LOST_RESULT_CODES = Object.freeze({
  /** The attempt's deadline passed and the host still had no answer. */
  timeout: "RUNNER_TIMEOUT",
  /** The host ran the guest and it ended without an answer. */
  container_exit: "RUNNER_CONTAINER_EXIT",
  /** The host holds no record of the attempt, or has not answered for too long. */
  supervisor_lost: "RUNNER_SUPERVISOR_LOST",
  /** The pool lease that holds the guest's capacity could not be kept alive. */
  lease_lost: "RUNNER_LEASE_LOST",
} as const);
export type FactoryLostResultReason = keyof typeof FACTORY_LOST_RESULT_CODES;

/** After the attempt's own deadline, how long the product still waits for the host's answer. */
export const FACTORY_RESULT_DEADLINE_GRACE_MS = 30_000;
/** How long a host may leave every result request unanswered before it counts as lost. */
export const FACTORY_SUPERVISOR_SILENCE_MS = 120_000;
/**
 * How long a lost attempt waits for its journal to settle.
 *
 * A guest that dies mid-call leaves the call itself running in this process:
 * the broker still settles it when the provider answers, bounded by the model
 * request's own timeout. A result must repeat settled operations exactly, so
 * the record waits for them, as long as that timeout and no longer.
 */
export const FACTORY_JOURNAL_SETTLE_MS = 300_000;
const RESULT_RETRY_DELAY_MS = 1_000;

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
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
  private readonly now: () => number;
  private readonly delay: (ms: number) => Promise<void>;
  private readonly silenceMs: number;
  private readonly journalSettleMs: number;
  private readonly renewIntervalMs: number;
  private readonly schedule: (task: () => void, ms: number) => () => void;

  constructor(private readonly options: FactoryRemoteAttemptRuntimeOptions) {
    this.now = options.now ?? Date.now;
    this.delay = options.delay ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
    this.silenceMs = options.supervisorSilenceMs ?? FACTORY_SUPERVISOR_SILENCE_MS;
    this.journalSettleMs = options.journalSettleMs ?? FACTORY_JOURNAL_SETTLE_MS;
    this.renewIntervalMs = options.leaseRenewIntervalMs ?? FACTORY_ATTEMPT_LEASE_RENEW_INTERVAL_MS;
    this.schedule = options.schedule ?? ((task, ms) => { const timer = setTimeout(task, ms); return () => clearTimeout(timer); });
  }

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

    let handle: Awaited<ReturnType<FactoryHostLaunchTransport["launch"]>>;
    try {
      handle = await this.options.transport.launch(tokened);
    } catch (error) {
      // An intent for another host never left this process, so no guest exists.
      if (error instanceof FactoryAttemptRuntimeError && error.code === "invalid_launch") {
        await this.options.launches.state(attemptId, "uncertain");
        throw error;
      }
      // A lost launch response is not an absent guest. Ask the host what it has.
      const attached = await this.options.transport.attach(tokened).catch(() => undefined);
      if (attached?.disposition !== "attached") {
        // Whether a guest started is unknown, so the start is not acknowledged.
        // The attempt still ends in a durable result: the host hands over an
        // answer it holds, or says it has none and the attempt is recorded lost.
        this.options.report(`attempt-launch-unconfirmed:${attemptId}`, error);
        await this.options.launches.state(attemptId, "uncertain");
        return this.settled(tokened, "uncertain", () => this.collect(tokened));
      }
      handle = attached;
    }
    await this.options.pool.acknowledgeStart({ reservationId: claimed.lease.reservationId, grantRevision: claimed.lease.grantRevision, allocationGeneration: claimed.lease.allocationGeneration, allocationToken: claimed.lease.allocationToken });
    await this.options.launches.state(attemptId, "launched");
    return this.settled(tokened, handle.disposition, () => this.collect(tokened));
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
   * host that is still running the guest, or ran it and still holds its answer,
   * hands that answer over, so a gateway that restarted mid-launch collects it
   * and records it rather than abandoning the attempt. A host that also
   * restarted holds nothing, and says so by name: the attempt ends
   * `RUNNER_SUPERVISOR_LOST` with a durable terminal result, never guessed at.
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
    // The host's own disposition passes through unchanged. Collapsing an
    // `uncertain` attach into `attached` would report a live guest where the
    // host said it had none.
    return this.settled(tokened, handle.disposition, () => this.collect(tokened));
  }

  /**
   * The attempt's terminal result, which this always ends with.
   *
   * One result request is one long-poll window on the host: a host that is
   * still running the guest answers `host_timeout` and is asked again, and
   * the host keeps a settled answer until it is collected, so a request lost on
   * the wire is simply repeated. What ends the loop is an answer, or a named
   * reason there will never be one — the guest exited without one, the host
   * holds no record of the attempt, the host stayed silent too long, or the
   * attempt's deadline passed. Each of those is recorded as a typed `failed`
   * result, so the kernel hears `node-failed` and retries the node or fails the
   * run, instead of the attempt waiting for ever with nothing to read.
   */
  private async collect(intent: FactoryAttemptLaunchIntent): Promise<FactoryRunnerResult> {
    const recorded = await this.options.launches.terminalResult(intent.request.authority.attemptId);
    if (recorded) return recorded;
    const lease = this.keepLeaseAlive(intent);
    try { return await this.collectWhileLeased(intent, lease); }
    finally { lease.stop(); }
  }

  /**
   * Renews the pool lease while the guest lives (option 2, W01h).
   *
   * The attempt's deadline is the node command's; the pool lease is only the
   * proof that this runtime is still there, so it is renewed now and then on
   * every interval, and stops with the collection. A renewal that fails is
   * tolerated while the last renewed deadline still holds; once it has passed,
   * the lease is lost and the read in flight is ended so the loop can say so.
   */
  private keepLeaseAlive(intent: FactoryAttemptLaunchIntent): { readonly signal: AbortSignal; lost(): string | undefined; stop(): void } {
    const controller = new AbortController();
    const fence = { reservationId: intent.lease.reservationId, grantRevision: intent.lease.grantRevision, allocationGeneration: intent.lease.allocationGeneration, allocationToken: intent.lease.allocationToken };
    let validUntil = this.now() + this.renewIntervalMs;
    let lostDetail: string | undefined;
    let cancel: () => void = () => {};
    let stopped = false;
    const renew = async () => {
      try { validUntil = Math.max(validUntil, (await this.options.pool.renew(fence)).deadlineAt.getTime()); }
      catch (error) {
        this.options.report(`attempt-lease-renewal-failed:${intent.request.authority.attemptId}`, error);
        if (this.now() >= validUntil) {
          lostDetail = `the pool lease could not be renewed: ${describe(error)}`;
          controller.abort(new Error(lostDetail));
        }
      }
      if (!stopped && lostDetail === undefined) cancel = this.schedule(() => { void renew(); }, this.renewIntervalMs);
    };
    void renew();
    return { signal: controller.signal, lost: () => lostDetail, stop: () => { stopped = true; cancel(); } };
  }

  private async collectWhileLeased(intent: FactoryAttemptLaunchIntent, lease: { readonly signal: AbortSignal; lost(): string | undefined }): Promise<FactoryRunnerResult> {
    const deadline = intent.request.authority.deadlineAtMs + FACTORY_RESULT_DEADLINE_GRACE_MS;
    let silentSince: number | undefined;
    for (;;) {
      const leaseLost = lease.lost();
      if (leaseLost !== undefined) return this.lost(intent, "lease_lost", leaseLost);
      if (this.now() >= deadline) return this.lost(intent, "timeout", "the attempt deadline passed before the host answered");
      let result: FactoryRunnerResult;
      try {
        result = await this.options.transport.result(intent, lease.signal);
      } catch (error) {
        if (lease.lost() !== undefined) continue;
        if (error instanceof FactoryHostLaunchRefusal && error.code === "host_timeout") { silentSince = undefined; continue; }
        if (error instanceof FactoryHostLaunchRefusal && error.code === "guest_exited") return this.lost(intent, "container_exit", error.detail);
        if (error instanceof FactoryHostLaunchRefusal && error.code === "attempt_uncertain") return this.lost(intent, "supervisor_lost", "the host holds no record of this attempt");
        silentSince ??= this.now();
        if (this.now() - silentSince >= this.silenceMs) return this.lost(intent, "supervisor_lost", `the host did not answer for ${this.silenceMs} ms: ${describe(error)}`);
        this.options.report(`attempt-result-retry:${intent.request.authority.attemptId}`, error);
        await this.delay(RESULT_RETRY_DELAY_MS);
        continue;
      }
      // The host's answer becomes durable before it is acknowledged, exactly as in process.
      const durable = await this.options.launches.recordTerminal(intent.request.authority.attemptId, result);
      await this.options.stop(intent, durable.status === "completed" ? "completed" : durable.status === "failed" ? "failed" : "cancelled");
      return durable;
    }
  }

  /**
   * Ends an attempt whose guest's answer will never arrive, and says why.
   *
   * The guest is stopped first, as any failed attempt is. That stop may itself
   * fail — the host may be the thing that is gone — and it does not decide
   * anything here: the kernel answers the `node-failed` this result produces
   * with its own `cancel-node`, and retries only once that stop is physically
   * confirmed. The result repeats the journal exactly, so it is verified like a
   * guest's own report.
   */
  private async lost(intent: FactoryAttemptLaunchIntent, reason: FactoryLostResultReason, detail: string): Promise<FactoryRunnerResult> {
    const attemptId = intent.request.authority.attemptId;
    const message = `Factory attempt ended without its guest's answer (${reason}): ${detail}`.slice(0, 4_096);
    this.options.report(`attempt-result-lost:${attemptId}`, new FactoryAttemptRuntimeError("launch_uncertain", message));
    await this.options.stop(intent, "failed").catch(error => { this.options.report(`attempt-stop-unconfirmed:${attemptId}`, error); });
    const result = failedFactoryRunnerResult(await this.settledJournal(intent), { code: FACTORY_LOST_RESULT_CODES[reason], message, retryable: true });
    return this.options.launches.recordTerminal(attemptId, result);
  }

  /** The journal's facts once no operation is in flight, or its own error once the settle bound has passed. */
  private async settledJournal(intent: FactoryAttemptLaunchIntent): ReturnType<NativeFactoryJournal["snapshot"]> {
    const giveUpAt = this.now() + this.journalSettleMs;
    for (;;) {
      try { return await this.options.journal.snapshot(intent.request); }
      catch (error) {
        if (this.now() >= giveUpAt) throw error;
        this.options.report(`attempt-journal-unsettled:${intent.request.authority.attemptId}`, error);
        await this.delay(RESULT_RETRY_DELAY_MS);
      }
    }
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
