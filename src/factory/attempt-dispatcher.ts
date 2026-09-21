import { validateFactoryRunnerRequest, validateFactoryRunnerResult, type FactoryRunnerRequest, type FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { canonicalJson } from "@ezcorp/extension-contract";
import type { TransactionalDb } from "../db/migrations/types";
import { factoryAttemptAuthority, FactoryAttemptQueueError, type ClaimedFactoryAttempt, type FactoryAttemptQueue } from "./attempt-queue";
import { FACTORY_ATTEMPT_TOKEN_MAX_SECONDS, signFactoryAttemptToken } from "./attempt-token";
import type { FactoryTaskCompletionReceipt, FactoryTaskCompletions } from "./task-completions";
import type { FactoryTaskOutcomeReceipt, FactoryTaskOutcomes } from "./task-outcomes";
import type { TrustedFactoryRunner, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

export interface FactoryAttemptDispatcherOptions {
  readonly service: TrustedFactoryServiceIdentity;
  readonly installationId: string;
  readonly attemptTokenSecret: string;
  readonly attemptTokenLifetimeSeconds?: number;
  readonly leaseMs?: number;
}

export type FactoryAttemptDispatchResult =
  | { readonly kind: "idle" }
  | { readonly kind: "completed"; readonly attemptId: string; readonly recovered: boolean; readonly receipt: FactoryTaskCompletionReceipt }
  | { readonly kind: "failed" | "cancelled" | "outcome_unknown"; readonly attemptId: string; readonly recovered: boolean; readonly receipt: FactoryTaskOutcomeReceipt }
  /**
   * A pass that moved the attempt without producing a receipt.
   *
   * `cause` rides along on the unknown outcomes, and it is the difference
   * between an operator who can act and one who cannot: before it, a result the
   * product refused to record settled the attempt `outcome_unknown` and the
   * reason existed only inside a `catch {}`. It is never a substitute for the
   * receipt — the attempt is still unknown — it is the one line that says why.
   */
  | { readonly kind: "failed" | "cancelled" | "outcome_unknown" | "retry"; readonly attemptId: string; readonly cause?: unknown };

type FactoryAttemptTokenSigner = typeof signFactoryAttemptToken;
type FactoryDispatchReadiness = {
  assertDispatchReady(request: Pick<FactoryRunnerRequest, "authority" | "runner">): Promise<unknown>;
};
type FactoryReadinessDisposition = (error: unknown) => "retry" | "deny";

function snapshot<T>(value: T): T {
  return JSON.parse(canonicalJson(value)) as T;
}

/** Claims exact durable attempts, mints an ephemeral token, and dispatches outside every database lock. */
export class FactoryAttemptDispatcher {
  private readonly service: TrustedFactoryServiceIdentity;
  private readonly installationId: string;
  private readonly attemptTokenSecret: string;
  private readonly tokenLifetime: number;
  private readonly leaseMs: number;

  constructor(
    private readonly database: TransactionalDb,
    private readonly queue: FactoryAttemptQueue,
    private readonly runner: TrustedFactoryRunner,
    private readonly completions: Pick<FactoryTaskCompletions, "completeInTransaction" | "readInTransaction">,
    private readonly outcomes: Pick<FactoryTaskOutcomes, "recordInTransaction" | "readInTransaction">,
    private readonly readiness: FactoryDispatchReadiness,
    private readonly readinessDisposition: FactoryReadinessDisposition,
    options: FactoryAttemptDispatcherOptions,
    private readonly signer: FactoryAttemptTokenSigner = signFactoryAttemptToken,
  ) {
    const captured = snapshot(options);
    this.service = Object.freeze(captured.service);
    this.installationId = captured.installationId;
    this.attemptTokenSecret = captured.attemptTokenSecret;
    this.tokenLifetime = captured.attemptTokenLifetimeSeconds ?? 60;
    this.leaseMs = captured.leaseMs ?? 60_000;
    if (!this.service.subject || !this.service.tenantId || this.service.tenantId !== queue.tenantId || queue.transactionalDatabase !== database
      || typeof readiness?.assertDispatchReady !== "function" || typeof readinessDisposition !== "function"
      || !this.installationId || !this.attemptTokenSecret || !Number.isSafeInteger(this.tokenLifetime) || this.tokenLifetime < 1 || this.tokenLifetime > FACTORY_ATTEMPT_TOKEN_MAX_SECONDS
      || !Number.isSafeInteger(this.leaseMs) || this.leaseMs < 1 || this.leaseMs > 300_000) throw new Error("Factory attempt dispatcher configuration is invalid.");
  }

  async dispatchOne(): Promise<FactoryAttemptDispatchResult> {
    const historical = await this.recoverTerminal();
    if (historical) return historical;
    const claim = await this.queue.claim(this.leaseMs);
    if (!claim) return await this.recoverTerminal() ?? { kind: "idle" };

    try {
      const prior = await this.recoverClaim(claim);
      if (prior) return prior;
    } catch {
      await this.queue.settle(claim, "retry", "completion_read_unavailable");
      return { kind: "retry", attemptId: claim.delivery.id };
    }

    try {
      await this.readiness.assertDispatchReady(snapshot({ authority: claim.request.authority, runner: claim.request.runner }));
    } catch (error) {
      const disposition = this.readinessDisposition(error);
      await this.queue.settle(claim, disposition === "retry" ? "retry" : "cancelled", disposition === "retry" ? "runner_package_not_ready" : "runner_package_denied");
      return { kind: disposition === "retry" ? "retry" : "cancelled", attemptId: claim.delivery.id };
    }

    let attemptToken: string;
    try {
      attemptToken = await this.signer(factoryAttemptAuthority(claim.delivery.reference), this.attemptTokenSecret, this.installationId, this.tokenLifetime);
    } catch {
      await this.queue.settle(claim, "retry", "attempt_token_unavailable");
      return { kind: "retry", attemptId: claim.delivery.id };
    }
    const request = snapshot({ ...claim.request, broker: { ...claim.request.broker, attemptToken } }) as FactoryRunnerRequest;
    if (!validateFactoryRunnerRequest(request).ok || factoryRunnerRequestDigest(request) !== claim.delivery.reference.requestDigest) {
      return this.markUnknown(claim, "runner_request_invalid");
    }

    let result: FactoryRunnerResult;
    try {
      result = snapshot(await this.runner.run(request));
    } catch {
      return this.markUnknown(claim, "runner_outcome_unknown");
    }
    if (!validateFactoryRunnerResult(result).ok) return this.markUnknown(claim, "runner_result_invalid");
    if (result.status !== "completed") return this.persistOutcome(claim, result);

    try {
      const receipt = await this.database.transaction(async transaction => {
        const completed = await this.completions.completeInTransaction(transaction, this.service, claim.delivery.reference.command, result);
        await this.queue.settleInTransaction(transaction, claim, "delivered");
        return completed;
      });
      return { kind: "completed", attemptId: claim.delivery.id, recovered: false, receipt };
    } catch (error) {
      const recovered = await this.recoverClaim(claim).catch(() => undefined);
      if (recovered) return recovered;
      return this.markUnknown(claim, "completion_outcome_unknown", "outcome_unknown", error);
    }
  }

  private async recoverClaim(claim: ClaimedFactoryAttempt): Promise<Exclude<FactoryAttemptDispatchResult, { kind: "idle" | "retry" } | { kind: "outcome_unknown"; receipt?: never }> | undefined> {
    return this.database.transaction(async transaction => {
      const receipt = await this.completions.readInTransaction(transaction, this.service, claim.delivery.reference.command);
      const outcome = receipt ? undefined : await this.outcomes.readInTransaction(transaction, this.service, claim.delivery.reference.command);
      if (!receipt && !outcome) return undefined;
      const current = await this.queue.readInTransaction(transaction, claim.delivery.projectId, claim.delivery.id);
      if (!current) throw new FactoryAttemptQueueError("factory_attempt_not_found");
      if (current.state === "leased") await this.queue.settleInTransaction(transaction, claim, "delivered");
      else if (current.state === "outcome_unknown") await this.queue.recoverDeliveredInTransaction(transaction, current);
      else if (current.state !== "delivered") throw new FactoryAttemptQueueError("factory_attempt_recovery_invalid");
      return receipt
        ? { kind: "completed", attemptId: claim.delivery.id, recovered: true, receipt }
        : { kind: outcome!.resultStatus === "uncertain" ? "outcome_unknown" : outcome!.resultStatus, attemptId: claim.delivery.id, recovered: true, receipt: outcome! };
    });
  }

  private async recoverTerminal(): Promise<Exclude<FactoryAttemptDispatchResult, { kind: "idle" | "retry" } | { kind: "outcome_unknown"; receipt?: never }> | undefined> {
    for (const delivery of [...await this.queue.completionCandidates(), ...await this.queue.outcomeCandidates()]) {
      const recovered = await this.database.transaction(async transaction => {
        const receipt = await this.completions.readInTransaction(transaction, this.service, delivery.reference.command);
        const outcome = receipt ? undefined : await this.outcomes.readInTransaction(transaction, this.service, delivery.reference.command);
        if (!receipt && !outcome) return undefined;
        await this.queue.recoverDeliveredInTransaction(transaction, delivery);
        return receipt
          ? { kind: "completed" as const, attemptId: delivery.id, recovered: true, receipt }
          : { kind: outcome!.resultStatus === "uncertain" ? "outcome_unknown" as const : outcome!.resultStatus, attemptId: delivery.id, recovered: true, receipt: outcome! };
      });
      if (recovered) return recovered;
    }
    return undefined;
  }

  private async persistOutcome(claim: ClaimedFactoryAttempt, result: Exclude<FactoryRunnerResult, { status: "completed" }>): Promise<FactoryAttemptDispatchResult> {
    try {
      const receipt = await this.database.transaction(async transaction => {
        const recorded = await this.outcomes.recordInTransaction(transaction, this.service, claim.delivery.reference.command, result);
        const current = await this.queue.readInTransaction(transaction, claim.delivery.projectId, claim.delivery.id);
        if (current?.state === "leased" && current.leaseToken === claim.delivery.leaseToken) await this.queue.settleInTransaction(transaction, claim, "delivered");
        else if (current?.state === "outcome_unknown") await this.queue.recoverDeliveredInTransaction(transaction, current);
        else throw new FactoryAttemptQueueError("factory_attempt_recovery_invalid");
        return recorded;
      });
      return { kind: result.status === "uncertain" ? "outcome_unknown" : result.status, attemptId: claim.delivery.id, recovered: false, receipt };
    } catch (error) {
      const recovered = await this.recoverClaim(claim).catch(() => undefined);
      if (recovered) return recovered;
      return this.markUnknown(claim, "outcome_commit_unknown", "outcome_unknown", error);
    }
  }

  private async markUnknown(claim: ClaimedFactoryAttempt, failureCode: string, kind: "failed" | "cancelled" | "outcome_unknown" = "outcome_unknown", cause?: unknown): Promise<FactoryAttemptDispatchResult> {
    const recovered = await this.recoverClaim(claim).catch(() => undefined);
    if (recovered) return recovered;
    try {
      await this.queue.settle(claim, "outcome_unknown", failureCode);
    } catch (error) {
      if (!(error instanceof FactoryAttemptQueueError) || error.code !== "delivery_lease_lost") throw error;
      const current = await this.queue.read(claim.delivery.projectId, claim.delivery.id);
      if (current?.state !== "outcome_unknown") throw error;
    }
    return { kind, attemptId: claim.delivery.id, ...(cause === undefined ? {} : { cause }) };
  }
}
