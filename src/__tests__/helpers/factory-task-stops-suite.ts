import { afterAll, beforeAll, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { sql } from "drizzle-orm";
import { advanceKernel, type FactoryRunnerResult, type KernelEvent } from "@ezcorp/factory-sdk";
import type { TransactionalDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { digestObject } from "../../extensions/v4/blobs";
import type { BlobStore } from "../../extensions/v4/types";
import { FactoryAttemptQueue } from "../../factory/attempt-queue";
import type { FactoryBudgets } from "../../factory/budgets";
import { FactoryComputeAdmissions } from "../../factory/compute-admissions";
import { FactoryExecutionJournal } from "../../factory/executions";
import type { FactoryPrincipal } from "../../factory/grants";
import { FactoryInbox } from "../../factory/inbox";
import type { PoolAdmissionClient } from "../../factory/pool/client";
import type { PoolLeaseStatus } from "../../factory/pool/ledger";
import type { FactoryRunLifecycle } from "../../factory/run-lifecycle";
import type { FactoryPhysicalStopReceipt, } from "../../factory/runner/attempt-runtime";
import { FactoryTaskAdmission, type FactoryTaskResourceProfile } from "../../factory/task-admission";
import { FactoryTaskOutcomes } from "../../factory/task-outcomes";
import { FactoryTaskStops, FactoryTaskStopError, FACTORY_STOP_SCAN_MAX_LIMIT, type FactoryPhysicalStopper, type FactoryPoolStopAcknowledger, type FactoryStopHostKey, type FactoryTaskStopRequest } from "../../factory/task-stops";
import { FACTORY_USAGE_OPERATIONS_BASIS, FACTORY_USAGE_PROVIDER_ERROR_BASIS, FactoryUsageReconciliation, FactoryUsageSettlements } from "../../factory/usage-settlement";
import type { FactoryModelFailure } from "../../factory/runner/guest-model-broker";
import { createFactoryJournalGuestModelJournal, factoryGuestModelFailure } from "../../factory/runner/guest-model-journal";
import { readAttemptSupersessionInTransaction, supersedeEpochAttemptsInTransaction } from "../../factory/attempt-supersessions";
import { persistTransition } from "../../../packages/@ezcorp/factory-orchestrator/src/transition-pages";
import { createFactoryLiveAttemptWorld, type FactoryLiveAttempt, type FactoryLiveAttemptWorld } from "./factory-live-attempt-world";

const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const rotatedKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const foreignKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });

export interface FactoryTaskStopsFixture { db: TransactionalDb; blobs?: BlobStore; close(): Promise<void> }

/** Every C02 stop and C03 settlement behaviour, against one isolated database. */
export function factoryTaskStopsConformance(create: () => Promise<FactoryTaskStopsFixture>): void {
  let fixture: FactoryTaskStopsFixture;
  let world: FactoryLiveAttemptWorld;
  let lifecycle: FactoryRunLifecycle;
  const now = Date.UTC(2030, 0, 1);
  const tenantId = "stop-tenant";
  const projectId = "stop-project";
  const hostId = "stop-host";
  const principal: FactoryPrincipal = { kind: "user", id: "stop-owner", authentication: "session" };
  const key = { projectId, factoryId: "stop-factory" };
  const service = { tenantId, subject: "orchestration" };
  const profile: FactoryTaskResourceProfile = { resources: { cpu: 1 }, memoryBytes: 128, budget: { costMicros: "5", tokens: 6, computeMs: 7 } };
  const runKey = (runId: string) => ({ projectId, runId });

  const signed = (request: FactoryTaskStopRequest, overrides: Partial<FactoryPhysicalStopReceipt> = {}, key = hostKeys.privateKey, keyId = "stop-host-key-1") => world.signedStop(request, overrides, key, keyId);
  const acknowledger = (overrides: Partial<PoolLeaseStatus> = {}, onCall?: () => void) => world.settlingPool(overrides, onCall);
  const stopper = (sign: (request: FactoryTaskStopRequest) => Promise<FactoryPhysicalStopReceipt>, calls?: { count: number }) => world.countingStopper(sign, calls);
  const harness = (attempt: Attempt, physical: FactoryPhysicalStopper, pool: FactoryPoolStopAcknowledger, keys?: readonly FactoryStopHostKey[], timeoutMs?: number) => world.stopHarness(attempt, physical, pool, keys, timeoutMs);

  type Attempt = FactoryLiveAttempt;

  /** Drives one run to a live, launched attempt through the real kernel and stores. */
  function launchedAttempt(poolPinsHost = true): Promise<Attempt> { return world.launchedAttempt(poolPinsHost); }

  /** Cancels the run and commits the transition that carries the live `cancel-node` command. */
  function cancelled(attempt: Attempt) { return world.cancelled(attempt); }

  /** The sealed attempt authority as the durable execution row holds it. */
  async function sealedAuthority(attempt: Attempt) {
    const authority = await fixture.db.transaction(transaction => attempt.journal.readAuthorityInTransaction(transaction, { tenantId, projectId, runId: attempt.run.runId, attemptId: attempt.attemptId }));
    if (!authority) throw new Error("fixture attempt authority is missing");
    return authority;
  }

  /** One prepared and dispatched journal operation, ready to settle or reconcile. */
  async function dispatchedOperation(attempt: Attempt) {
    const authority = await sealedAuthority(attempt);
    const operation = { operationId: `${attempt.run.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:0`, operationIndex: 0, kind: "model" as const, requestDigest: "a".repeat(64) };
    await attempt.journal.prepare(authority, operation);
    await attempt.journal.dispatch(authority, operation.operationId);
    return { authority, operation };
  }

  /**
   * Records a non-success outcome whose settled journal evidence really sums to
   * its terminal usage, then commits the transition that cancels the node.
   */
  async function failedOutcome(attempt: Attempt, mode: "measured" | "held"): Promise<{ reference: typeof attempt.dispatchReference; advanced: ReturnType<typeof advanceKernel> }> {
    let result: FactoryRunnerResult;
    if (mode === "measured") {
      const { authority, operation } = await dispatchedOperation(attempt);
      const checkpoint = { artifactId: `stop-checkpoint-${attempt.run.runId}`, digest: `sha256:${"b".repeat(64)}`, encodedBytes: 1, journalCursor: 0 };
      const usage = { kind: "measured" as const, inputTokens: 1, outputTokens: 2, computeMs: 3, costMicros: "4" };
      await attempt.journal.settle(authority, operation.operationId, "completed", { result: { done: true }, resultDigest: "d".repeat(64), usage, workspaceCheckpoint: checkpoint });
      result = { schemaVersion: "factory.runner.result.v1", status: "failed", resultDigest: "c".repeat(64), error: { code: "RUNNER_FAILED", message: "runner failed", retryable: false }, journalCursor: 0, operations: [{ ...operation, state: "completed", resultDigest: "d".repeat(64), usage, workspaceCheckpoint: checkpoint }], usage };
    } else {
      // A provider whose cost is not yet known reports an uncertain terminal,
      // which is the shape that carries a held cost and no settled operation.
      result = { schemaVersion: "factory.runner.result.v1", status: "uncertain", journalCursor: -1, operations: [], providerReceiptDigest: "e".repeat(64), usage: { kind: "unknown", reason: "provider receipt pending", heldCostMicros: "900" } };
    }
    return recordedOutcome(attempt, result);
  }

  /**
   * W03f: an infer node whose one model call a provider refused, exactly as the
   * product's broker settles it (`factoryGuestModelFailure`) and as the guest
   * mirrors it from the refusal. With no failure given, the broker refused
   * before the claim (a pin mismatch): nothing was journaled, and the guest
   * claims a measured zero, compute included.
   */
  async function providerFailedOutcome(attempt: Attempt, failure: FactoryModelFailure | "model_pin_mismatch"): Promise<{ reference: typeof attempt.dispatchReference; advanced: ReturnType<typeof advanceKernel> }> {
    const error = (code: string) => ({ code, message: "the model call was refused", retryable: false });
    if (failure === "model_pin_mismatch") {
      const zero = { kind: "measured" as const, inputTokens: 0, outputTokens: 0, computeMs: 0, costMicros: "0" };
      return recordedOutcome(attempt, { schemaVersion: "factory.runner.result.v1", status: "failed", resultDigest: "c".repeat(64), error: error(failure), journalCursor: -1, operations: [], usage: zero });
    }
    const authority = await sealedAuthority(attempt);
    const request = {
      schemaVersion: "factory.guest-model-request.v1" as const, operationId: `${attempt.run.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:0`, operationIndex: 0,
      model: { provider: "ollama", model: "qwen3:1.7b", configurationDigest: `sha256:${"a".repeat(64)}`, configuration: {}, policyDigest: `sha256:${"a".repeat(64)}`, policy: {} },
      messages: [{ role: "user" as const, text: "the primary colours of light" }], maxOutputTokens: 64,
    };
    const { result: stored, operation } = factoryGuestModelFailure(request, failure);
    await attempt.journal.prepare(authority, { operationId: operation.operationId, operationIndex: operation.operationIndex, kind: operation.kind, requestDigest: operation.requestDigest });
    await attempt.journal.dispatch(authority, operation.operationId);
    await attempt.journal.settle(authority, operation.operationId, "failed", { resultDigest: operation.resultDigest, result: stored, ...(operation.usage === undefined ? {} : { usage: operation.usage, providerReceiptDigest: operation.providerReceiptDigest! }) });
    return recordedOutcome(attempt, {
      schemaVersion: "factory.runner.result.v1", status: "failed", resultDigest: "c".repeat(64), error: error(failure.code), journalCursor: 0,
      operations: [operation], ...(operation.usage?.kind === "measured" ? { usage: operation.usage } : {}),
    });
  }

  /** Records a non-success outcome through the real outcome store and commits the transition that cancels the node. */
  async function recordedOutcome(attempt: Attempt, result: FactoryRunnerResult): Promise<{ reference: typeof attempt.dispatchReference; advanced: ReturnType<typeof advanceKernel> }> {
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const outcomes = new FactoryTaskOutcomes(fixture.db, attempt.authority, attempt.admissions, attempt.journal, attempt.queue, lifecycle.budgets, inbox, () => now);
    const receipt = await fixture.db.transaction(transaction => outcomes.recordInTransaction(transaction, service, attempt.dispatchReference, result));
    const advanced = advanceKernel(attempt.compiled, attempt.state.nextState, receipt.event);
    const cancelCommand = advanced.commands.find(command => command.kind === "cancel-node");
    if (!cancelCommand) throw new Error("fixture outcome produced no cancel-node command");
    await persistTransition(attempt.identity, 3, receipt.event, advanced.nextState, advanced.commands, undefined, attempt.activities);
    return { reference: { ...attempt.identity, commandId: cancelCommand.id }, advanced };
  }

  const reservationState = async (reservationId: string) => rows<{ state: string; actual: string | null }>(await fixture.db.execute(sql`SELECT state,actual FROM factory_budget_reservations WHERE reservation_id=${reservationId}`))[0];
  const executionStatus = async (attemptId: string) => rows<{ status: string }>(await fixture.db.execute(sql`SELECT status FROM factory_executions WHERE attempt_id=${attemptId}`))[0]?.status;
  const inboxKinds = async (runId: string) => rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${runId} ORDER BY sequence`)).map(row => (JSON.parse(row.payload) as KernelEvent).kind);
  /** Folds every stop and usage event the stop enqueued through the real kernel, from the cancelled state. */
  async function foldedState(attempt: Attempt, cancelledState: ReturnType<typeof advanceKernel>) {
    const events = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${attempt.run.runId} ORDER BY sequence`))
      .map(row => JSON.parse(row.payload) as KernelEvent).filter(event => event.kind === "usage-settled" || event.kind === "attempt-stopped");
    return events.reduce((state, event) => advanceKernel(attempt.compiled, state.nextState, event), cancelledState).nextState;
  }
  const foldedStatus = async (attempt: Attempt, cancelledState: ReturnType<typeof advanceKernel>): Promise<string> => (await foldedState(attempt, cancelledState)).status;
  /** What the kernel holds for the failed node once every stop and usage event is folded. */
  async function foldedNode(attempt: Attempt, advanced: ReturnType<typeof advanceKernel>) {
    const state = await foldedState(attempt, advanced);
    const nodeId = (await sealedAuthority(attempt)).nodeInstanceId;
    const node = state.nodes[nodeId]!;
    return { unresolved: state.unresolvedUncertainNodeIds, error: node.error, status: node.status, attempt: node.attempts.find(entry => entry.commandId === attempt.attemptId) };
  }
  /** Stored settlement revisions, normalized: PostgreSQL returns a BIGINT as a string, PGlite as a number. */
  const settlementRows = async (runId: string) => rows<{ revision: number | string; source: string }>(await fixture.db.execute(sql`SELECT revision, source FROM factory_usage_settlements WHERE run_id=${runId} ORDER BY revision`)).map(row => ({ revision: Number(row.revision), source: row.source }));
  const settlementOf = (settlements: FactoryUsageSettlements, attempt: Attempt) => fixture.db.transaction(transaction => settlements.readLatestInTransaction(transaction, { projectId, runId: attempt.run.runId, reservationId: attempt.reservationId }));
  const stopRow = async (runId: string) => rows<{ state: string; source: string; attempt_command_id: string | null }>(await fixture.db.execute(sql`SELECT state,source,attempt_command_id FROM factory_task_stops WHERE run_id=${runId}`))[0];

  beforeAll(async () => {
    fixture = await create();
    world = await createFactoryLiveAttemptWorld(fixture, { label: "stop", tenantId, projectId, principal, factoryId: key.factoryId, hostId, now, profile, service, hostKeys });
    lifecycle = world.lifecycle;
  });
  afterAll(async () => { await fixture?.close(); });

  test("stops an ordinary CPU attempt, whose pool lease pins no host at all", async () => {
    // C03 pins a machine only for an allocation that binds a whole one, so an
    // ordinary CPU reservation has none — and the host a stop addresses comes
    // from the durable launch record, which sealed it when the attempt was
    // prepared. Requiring the LEASE to name one made every CPU attempt
    // unstoppable: the guest ran, its result became durable, the kernel issued
    // `cancel-node`, and the stop refused it `factory_task_stop_stale` on every
    // pass while the run sat in `stopping`. `confirm` below already applies the
    // opposite rule to the same fact: having no opinion is not a contradiction.
    const attempt = await launchedAttempt(false);
    const { reference } = await cancelled(attempt);
    const { stops } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const receipt = await stops.stop(service, reference);
    expect(receipt.state).toBe("stopped");
    expect(receipt.stopReceipt).toMatchObject({ processGroupAbsent: true, hostId, reason: "cancelled" });
    expect(await executionStatus(attempt.attemptId)).toBe("stopped");
  });

  test("stops a still-running attempt from its sealed launch, and an empty journal settles a typed zero", async () => {
    const attempt = await launchedAttempt();
    const { reference, advanced } = await cancelled(attempt);
    expect(rows(await fixture.db.execute(sql`SELECT command_id FROM factory_task_outcomes WHERE run_id=${attempt.run.runId}`))).toEqual([]);
    const calls = { count: 0 };
    const { stops, settlements } = harness(attempt, stopper(async request => signed(request), calls), acknowledger());
    const receipt = await stops.stop(service, reference);
    expect(receipt.state).toBe("stopped");
    expect(receipt.stopReceipt).toMatchObject({ processGroupAbsent: true, hostId, reason: "cancelled", workerId: receipt.stopReceipt!.workerId });
    expect(await stopRow(attempt.run.runId)).toEqual({ state: "stopped", source: "sealed-launch", attempt_command_id: null });
    expect(await executionStatus(attempt.attemptId)).toBe("stopped");
    // The attempt journaled no operation, so no provider was ever charged: the
    // stop is certain and settles a typed zero proven by its signed receipt.
    expect(receipt.event).toMatchObject({ kind: "attempt-stopped", commandId: attempt.attemptId });
    expect(receipt.event.uncertain).toBeUndefined();
    const settlement = await settlementOf(settlements, attempt);
    expect(settlement).toMatchObject({ revision: 1, source: "no-operations", knownCostMicros: "0", stopReceiptDigest: receipt.stopReceipt!.receiptDigest, attemptId: attempt.attemptId, basis: "no-operations: compute at reserved bound" });
    // The stored record names its basis, so an operator can read it off the row.
    expect(rows<{ basis: string | null }>(await fixture.db.execute(sql`SELECT basis FROM factory_usage_settlements WHERE run_id=${attempt.run.runId}`))).toEqual([{ basis: "no-operations: compute at reserved bound" }]);
    expect(settlement!.unknownCostMicros).toBeUndefined();
    expect(settlement!.event).toMatchObject({ kind: "usage-settled", revision: 1, knownCostMicros: "0" });
    // Cost and tokens are facts; unmeasured compute is charged at its reserved bound.
    const reservation = await reservationState(attempt.reservationId);
    expect(reservation?.state).toBe("settled");
    expect(JSON.parse(reservation!.actual!)).toEqual({ costMicros: "0", tokens: "0", computeMs: String(profile.budget.computeMs) });
    expect(await inboxKinds(attempt.run.runId)).toEqual(["admission-result", "cancel", "usage-settled", "attempt-stopped"]);
    // Folded through the real kernel, the operator's cancel reaches its terminal.
    expect(await foldedStatus(attempt, advanced)).toBe("cancelled");
    // A replay is the same sealed fact, never calls the host twice, and never settles twice.
    expect(await stops.stop(service, reference)).toEqual(receipt);
    expect(calls.count).toBe(1);
    expect(await inboxKinds(attempt.run.runId)).toEqual(["admission-result", "cancel", "usage-settled", "attempt-stopped"]);
  });

  test("any journaled operation keeps the hold uncertain: only an empty journal proves a zero", async () => {
    // A prepared operation may already have reached its provider (the crash
    // window between commit and dispatch), so its cost is genuinely unknown.
    const attempt = await launchedAttempt();
    const authority = await sealedAuthority(attempt);
    await attempt.journal.prepare(authority, { operationId: `${attempt.run.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:0`, operationIndex: 0, kind: "model", requestDigest: "a".repeat(64) });
    const { reference, advanced } = await cancelled(attempt);
    const { stops, settlements } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const receipt = await stops.stop(service, reference);
    expect(receipt.state).toBe("stopped");
    expect(receipt.event).toMatchObject({ kind: "attempt-stopped", uncertain: true });
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "uncertain", actual: null });
    expect(await settlementOf(settlements, attempt)).toBeUndefined();
    expect(await inboxKinds(attempt.run.runId)).toEqual(["admission-result", "cancel", "attempt-stopped"]);
    expect(await foldedStatus(attempt, advanced)).toBe("stopping");
  });

  test("settles a failed attempt's measured operations once, from its journal, and emits one usage-settled event", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await failedOutcome(attempt, "measured");
    const { stops, settlements } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const receipt = await stops.stop(service, reference);
    expect(receipt.state).toBe("stopped");
    expect(receipt.event.uncertain).toBeUndefined();
    expect(await stopRow(attempt.run.runId)).toMatchObject({ state: "stopped", source: "terminal-outcome", attempt_command_id: attempt.dispatchReference.commandId });
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "settled" });
    const settlement = await fixture.db.transaction(transaction => settlements.readLatestInTransaction(transaction, { projectId, runId: attempt.run.runId, reservationId: attempt.reservationId }));
    // W03f: a failed attempt settles from its journal, never from its guest's
    // claimed total: the model cost is the measured operation, and compute is
    // the reserved bound, not the 3 ms the result reported.
    expect(settlement).toMatchObject({ revision: 1, source: "operations", knownCostMicros: "4", attemptId: attempt.attemptId, basis: FACTORY_USAGE_OPERATIONS_BASIS, stopReceiptDigest: receipt.stopReceipt!.receiptDigest });
    expect(settlement!.unknownCostMicros).toBeUndefined();
    expect(JSON.parse((await reservationState(attempt.reservationId))!.actual!)).toEqual({ costMicros: "4", tokens: "3", computeMs: String(profile.budget.computeMs) });
    expect(await inboxKinds(attempt.run.runId)).toEqual(["admission-result", "node-failed", "usage-settled", "attempt-stopped"]);
    expect(await stops.stop(service, reference)).toEqual(receipt);
    expect(await inboxKinds(attempt.run.runId)).toEqual(["admission-result", "node-failed", "usage-settled", "attempt-stopped"]);
  });

  test("keeps an unknown provider cost visible instead of settling it as zero", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await failedOutcome(attempt, "held");
    const { stops, settlements } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const receipt = await stops.stop(service, reference);
    expect(receipt.event.uncertain).toBe(true);
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "uncertain", actual: null });
    const settlement = await fixture.db.transaction(transaction => settlements.readLatestInTransaction(transaction, { projectId, runId: attempt.run.runId, reservationId: attempt.reservationId }));
    expect(settlement).toMatchObject({ revision: 1, source: "stop", knownCostMicros: "0", unknownCostMicros: "900" });
  });

  // W03f: one lifecycle case per provider error class. Each drives the broker's
  // own settled row through the real outcome store, kernel, stop, pool and
  // budget, and ends with the run failed by its typed reason.
  const reserved = () => String(profile.budget.computeMs);
  const zero = { kind: "measured" as const, inputTokens: 0, outputTokens: 0, computeMs: 41, costMicros: "0" };
  // The fixture's reference graph leaves this node attempts to spare, so the node status also shows
  // the retry rule: a refused credential ends the attempt sequence, the others keep their retry.
  for (const [label, failure, cost, tokens, nodeStatus] of [
    ["unavailable (Ollama's missing model, 404)", { code: "provider_unavailable", message: "The provider did not complete the call: error (404: model 'qwen3:w19a-missing' not found).", evidence: { usage: zero, providerReceiptDigest: "1".repeat(64) } }, "0", "0", "retry_wait"],
    ["auth (a refused credential, 401)", { code: "provider_auth_failed", message: "The provider did not complete the call: error (401 invalid x-api-key).", evidence: { usage: zero, providerReceiptDigest: "2".repeat(64) } }, "0", "0", "failed"],
    ["rate limit after partial consumption (429 mid-stream)", { code: "provider_rate_limited", message: "The provider did not complete the call: error (429 rate limited).", evidence: { usage: { kind: "measured", inputTokens: 11, outputTokens: 7, computeMs: 90, costMicros: "1200" }, providerReceiptDigest: "3".repeat(64) } }, "1200", "18", "retry_wait"],
  ] as const) {
    test(`W03f: a provider error, ${label}, settles its measured model usage with compute at the reserved bound, and the run ends failed with its typed reason`, async () => {
      const attempt = await launchedAttempt();
      const { reference, advanced } = await providerFailedOutcome(attempt, failure);
      const { stops, settlements } = harness(attempt, stopper(async request => signed(request)), acknowledger());
      const receipt = await stops.stop(service, reference);
      expect(receipt.state).toBe("stopped");
      expect(receipt.event.uncertain).toBeUndefined();
      const settlement = await settlementOf(settlements, attempt);
      expect(settlement).toMatchObject({ revision: 1, source: "operations", knownCostMicros: cost, basis: FACTORY_USAGE_PROVIDER_ERROR_BASIS, stopReceiptDigest: receipt.stopReceipt!.receiptDigest });
      expect(settlement!.unknownCostMicros).toBeUndefined();
      // Partial consumption is the measured amount, never zero; compute is never the provider's 41 or 90 ms.
      expect(JSON.parse((await reservationState(attempt.reservationId))!.actual!)).toEqual({ costMicros: cost, tokens, computeMs: reserved() });
      expect(await inboxKinds(attempt.run.runId)).toEqual(["admission-result", "node-failed", "usage-settled", "attempt-stopped"]);
      // The kernel holds nothing unresolved: the node carries its typed reason and its attempt stopped certain.
      expect(await foldedNode(attempt, advanced)).toMatchObject({ unresolved: [], error: failure.code, attempt: { stopped: true } });
      expect((await foldedNode(attempt, advanced)).attempt?.uncertain).not.toBe(true);
      expect((await foldedNode(attempt, advanced)).status).toBe(nodeStatus);
      // Nothing is left for reconciliation to wait on, and a replay settles nothing twice.
      expect((await fixture.db.transaction(transaction => lifecycle.budgets.listUncertainWithCostInTransaction(transaction))).filter(hold => hold.reservationId === attempt.reservationId)).toEqual([]);
      expect(await stops.stop(service, reference)).toEqual(receipt);
      expect(await settlementRows(attempt.run.runId)).toEqual([{ revision: 1, source: "operations" }]);
    });
  }

  test("W03f: a pin mismatch journals nothing, so its stop settles the no-operations zero with compute at the bound, never the guest's claimed 0 ms", async () => {
    const attempt = await launchedAttempt();
    const { reference, advanced } = await providerFailedOutcome(attempt, "model_pin_mismatch");
    const { stops, settlements } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const receipt = await stops.stop(service, reference);
    expect(receipt.event.uncertain).toBeUndefined();
    expect(await settlementOf(settlements, attempt)).toMatchObject({ revision: 1, source: "no-operations", knownCostMicros: "0", basis: "no-operations: compute at reserved bound" });
    expect(JSON.parse((await reservationState(attempt.reservationId))!.actual!)).toEqual({ costMicros: "0", tokens: "0", computeMs: reserved() });
    expect(await foldedNode(attempt, advanced)).toMatchObject({ unresolved: [], error: "model_pin_mismatch", attempt: { stopped: true } });
  });

  test("W03f control: a provider failure with no usage evidence, as the broker settled it before W03f, keeps the hold and the run waits", async () => {
    const attempt = await launchedAttempt();
    const { reference, advanced } = await providerFailedOutcome(attempt, { code: "provider_unavailable", message: "socket hang up" });
    const { stops, settlements } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const receipt = await stops.stop(service, reference);
    expect(receipt.event).toMatchObject({ kind: "attempt-stopped", uncertain: true });
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "uncertain", actual: null });
    expect(await settlementOf(settlements, attempt)).toBeUndefined();
    // The kernel keeps the node unresolved: this is the hold W19a's missing-model control met.
    expect(await foldedNode(attempt, advanced)).toMatchObject({ unresolved: [(await sealedAuthority(attempt)).nodeInstanceId], attempt: { stopped: true, uncertain: true } });
    // The hold names the call whose cost nothing measured, never an absent receipt (a provider
    // that threw without an answer, such as a dropped connection or a transport timeout).
    const reconciler = new FactoryUsageReconciliation(fixture.db, tenantId, stops, attempt.journal, lifecycle.budgets, settlements);
    const [operation] = await attempt.journal.operations(await sealedAuthority(attempt));
    expect(await reconciler.resolve(await heldFor(attempt))).toEqual({ kind: "unknown", reservationId: attempt.reservationId, reason: "operation-cost-unknown", operationIds: [operation!.operationId] });
  });

  // W03f finding (b): an operator cancel confirmed while a model call is still in flight. The
  // product's guest-model journal, the one the broker writes through, meets a stop it cannot see.
  async function inFlightModelCall(attempt: Attempt) {
    const authority = await sealedAuthority(attempt);
    const journal = createFactoryJournalGuestModelJournal({
      journal: attempt.journal,
      workspace: { checkpoint: async ({ operationIndex }) => ({ artifactId: `w03f-checkpoint-${attempt.run.runId}`, digest: `sha256:${"b".repeat(64)}`, encodedBytes: 1, journalCursor: operationIndex }) },
    });
    const request = {
      schemaVersion: "factory.guest-model-request.v1" as const, operationId: `${attempt.run.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:0`, operationIndex: 0,
      model: { provider: "ollama", model: "qwen3:1.7b", configurationDigest: `sha256:${"a".repeat(64)}`, configuration: {}, policyDigest: `sha256:${"a".repeat(64)}`, policy: {} },
      messages: [{ role: "user" as const, text: "the primary colours of light" }], maxOutputTokens: 64,
    };
    expect(await journal.claim(attempt.request, request)).toEqual({ claimed: true });
    return { journal, request };
  }
  const heldFor = async (attempt: Attempt) => (await fixture.db.transaction(transaction => lifecycle.budgets.listUncertainWithCostInTransaction(transaction))).find(hold => hold.reservationId === attempt.reservationId)!;

  test("W03f (b): a cancel confirmed while a model call is in flight holds by naming it, and the call's late answer settles through reconciliation and clears the kernel", async () => {
    const attempt = await launchedAttempt();
    const { journal, request } = await inFlightModelCall(attempt);
    const { reference, advanced } = await cancelled(attempt);
    const held = harness(attempt, stopper(async stopRequest => signed(stopRequest)), acknowledger());
    expect((await held.stops.stop(service, reference)).event).toMatchObject({ kind: "attempt-stopped", uncertain: true });
    const reconciler = new FactoryUsageReconciliation(fixture.db, tenantId, held.stops, attempt.journal, lifecycle.budgets, held.settlements);
    const hold = await heldFor(attempt);
    // The hold names the operation it waits on, not an absent receipt.
    expect(await reconciler.resolve(hold)).toEqual({ kind: "unknown", reservationId: attempt.reservationId, reason: "operation-not-settled", operationIds: [request.operationId] });
    // The provider answers after the stop. The attempt is no longer live, so the completed
    // settlement is refused; the broker's hold keeps the receipt and the cost instead.
    const answer = { text: "red, green and blue", providerReceiptDigest: "f".repeat(64), usage: { kind: "measured" as const, inputTokens: 12, outputTokens: 5, computeMs: 30, costMicros: "17" } };
    await expect(journal.record(attempt.request, request, answer)).rejects.toThrow();
    await journal.hold(attempt.request, request, answer);
    const resolution = await reconciler.resolve(hold);
    expect(resolution).toMatchObject({ kind: "resolved", operationId: request.operationId, providerReceiptDigest: answer.providerReceiptDigest, usage: answer.usage });
    const settled = await reconciler.reconcile(resolution as Extract<typeof resolution, { kind: "resolved" }>);
    expect(settled).toMatchObject({ source: "reconciliation", knownCostMicros: "17" });
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "settled" });
    expect(await foldedNode(attempt, advanced)).toMatchObject({ unresolved: [] });
    expect(await foldedStatus(attempt, advanced)).toBe("cancelled");
  });

  test("W03f (b): a provider's late error answer settles its measured zero the same way; a late failure with no evidence stays held and named", async () => {
    const attempt = await launchedAttempt();
    const { journal, request } = await inFlightModelCall(attempt);
    const { reference, advanced } = await cancelled(attempt);
    const held = harness(attempt, stopper(async stopRequest => signed(stopRequest)), acknowledger());
    await held.stops.stop(service, reference);
    const reconciler = new FactoryUsageReconciliation(fixture.db, tenantId, held.stops, attempt.journal, lifecycle.budgets, held.settlements);
    const hold = await heldFor(attempt);
    // Without evidence the late failure cannot be recorded, and the hold keeps naming the call.
    await expect(journal.fail(attempt.request, request, { code: "provider_unavailable", message: "socket hang up" })).rejects.toThrow();
    expect(await reconciler.resolve(hold)).toMatchObject({ kind: "unknown", reason: "operation-not-settled", operationIds: [request.operationId] });
    // The provider's own error answer carries its measured zero, which settles the hold.
    const zero = { kind: "measured" as const, inputTokens: 0, outputTokens: 0, computeMs: 9, costMicros: "0" };
    // Parked, not settled: the late failure names that, so the broker hands the stopped guest no row.
    await expect(journal.fail(attempt.request, request, { code: "provider_unavailable", message: "The provider did not complete the call: error (404: model not found).", evidence: { usage: zero, providerReceiptDigest: "9".repeat(64) } })).rejects.toThrow("factory_guest_model_evidence_parked");
    const resolution = await reconciler.resolve(hold);
    expect(resolution).toMatchObject({ kind: "resolved", providerReceiptDigest: "9".repeat(64), usage: zero });
    expect(await reconciler.reconcile(resolution as Extract<typeof resolution, { kind: "resolved" }>)).toMatchObject({ source: "reconciliation", knownCostMicros: "0" });
    expect(await foldedNode(attempt, advanced)).toMatchObject({ unresolved: [] });
  });

  // W03f ruling B: once the stop is confirmed and the attempt's signed deadline has passed, a hold
  // whose operations nothing priced is charged the reserved bound, named, and cleared.
  const reconcilerAt = (attempt: Attempt, held: ReturnType<typeof harness>, nowMs: number) => new FactoryUsageReconciliation(fixture.db, tenantId, held.stops, attempt.journal, lifecycle.budgets, held.settlements, () => nowMs);
  const reservedBound = { costMicros: profile.budget.costMicros, tokens: String(profile.budget.tokens), computeMs: String(profile.budget.computeMs) };

  test("W03f B: a named hold stays unsettled before the deadline, is charged the reserved bound after it, and W05b clears the kernel; a later answer never settles twice", async () => {
    const attempt = await launchedAttempt();
    const { journal, request } = await inFlightModelCall(attempt);
    const { reference, advanced } = await cancelled(attempt);
    const held = harness(attempt, stopper(async stopRequest => signed(stopRequest)), acknowledger());
    const stopped = await held.stops.stop(service, reference);
    const deadline = (await sealedAuthority(attempt)).deadlineAt.getTime();
    const hold = await heldFor(attempt);
    // Before the attempt's deadline: named, and nothing settles.
    expect(await reconcilerAt(attempt, held, deadline - 1).resolve(hold)).toEqual({ kind: "unknown", reservationId: attempt.reservationId, reason: "operation-not-settled", operationIds: [request.operationId] });
    // Nor can a caller force the bound early, or on a reservation with no sealed stop.
    await expect(reconcilerAt(attempt, held, deadline - 1).settleAtBound({ reservationId: attempt.reservationId, attemptId: attempt.attemptId })).rejects.toMatchObject({ code: "factory_usage_settlement_state" });
    await expect(reconcilerAt(attempt, held, deadline + 1).settleAtBound({ reservationId: "factory-reservation:none", attemptId: attempt.attemptId })).rejects.toMatchObject({ code: "factory_usage_settlement_not_found" });
    expect(await settlementRows(attempt.run.runId)).toEqual([]);
    // After it, with the stop confirmed: the reserved bound, named by its basis.
    const late = reconcilerAt(attempt, held, deadline + 1);
    const bound = await late.resolve(hold);
    expect(bound).toEqual({ kind: "bound", reservationId: attempt.reservationId, attemptId: attempt.attemptId, reason: "operation-not-settled", operationIds: [request.operationId] });
    const settled = await late.settleAtBound(bound as Extract<typeof bound, { kind: "bound" }>);
    expect(settled).toMatchObject({ revision: 1, source: "reserved-bound", basis: "unknown: charged at reserved bound; ended by stop", knownCostMicros: profile.budget.costMicros, stopReceiptDigest: stopped.stopReceipt!.receiptDigest });
    expect(settled.restoreDigest).toBeUndefined();
    expect(settled.unknownCostMicros).toBeUndefined();
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "settled" });
    expect(JSON.parse((await reservationState(attempt.reservationId))!.actual!)).toEqual(reservedBound);
    expect(await foldedNode(attempt, advanced)).toMatchObject({ unresolved: [] });
    expect(await foldedStatus(attempt, advanced)).toBe("cancelled");
    // A replay is the same settlement, and the reservation is no longer listed as a hold.
    expect(await late.settleAtBound(bound as Extract<typeof bound, { kind: "bound" }>)).toEqual(settled);
    expect(await heldFor(attempt)).toBeUndefined();
    // The provider answers after all: its evidence is kept in the journal, and its settlement is refused.
    const answer = { text: "red, green and blue", providerReceiptDigest: "f".repeat(64), usage: { kind: "measured" as const, inputTokens: 12, outputTokens: 5, computeMs: 30, costMicros: "17" } };
    await journal.hold(attempt.request, request, answer);
    await expect(late.reconcile({ reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: request.operationId, providerReceiptDigest: answer.providerReceiptDigest, usage: answer.usage })).rejects.toMatchObject({ code: "factory_usage_settlement_state" });
    expect(await settlementRows(attempt.run.runId)).toEqual([{ revision: 1, source: "reserved-bound" }]);
    expect(JSON.parse((await reservationState(attempt.reservationId))!.actual!)).toEqual(reservedBound);
  });

  test("W03f C and B: a provider call aborted at the attempt's deadline leaves a cost-unknown hold that the bound settles, and the run's node keeps its typed reason", async () => {
    const attempt = await launchedAttempt();
    // What the provider's deadline abort settles: a failed call with no evidence.
    const { reference, advanced } = await providerFailedOutcome(attempt, { code: "provider_unavailable", message: "The provider did not answer before the attempt's deadline." });
    const held = harness(attempt, stopper(async stopRequest => signed(stopRequest)), acknowledger());
    await held.stops.stop(service, reference);
    const deadline = (await sealedAuthority(attempt)).deadlineAt.getTime();
    const late = reconcilerAt(attempt, held, deadline + 1);
    const bound = await late.resolve(await heldFor(attempt));
    const [operation] = await attempt.journal.operations(await sealedAuthority(attempt));
    expect(bound).toEqual({ kind: "bound", reservationId: attempt.reservationId, attemptId: attempt.attemptId, reason: "operation-cost-unknown", operationIds: [operation!.operationId] });
    expect(await late.settleAtBound(bound as Extract<typeof bound, { kind: "bound" }>)).toMatchObject({ source: "reserved-bound", knownCostMicros: profile.budget.costMicros });
    expect(await foldedNode(attempt, advanced)).toMatchObject({ unresolved: [], error: "provider_unavailable" });
  });

  test("a bounded stop timeout leaves durable uncertainty and a later receipt settles the same operation", async () => {
    const attempt = await launchedAttempt();
    const { reference, advanced } = await cancelled(attempt);
    let request: FactoryTaskStopRequest | undefined;
    const slow = { async stop(value: FactoryTaskStopRequest, signal: AbortSignal) { request = value; return new Promise<FactoryPhysicalStopReceipt>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("host stop aborted"))); }); } };
    let acknowledgements = 0;
    const { stops } = harness(attempt, slow, acknowledger({}, () => { acknowledgements++; }), undefined, 5);
    const uncertain = await stops.stop(service, reference);
    expect(uncertain.state).toBe("uncertain");
    expect(uncertain.event).toMatchObject({ kind: "attempt-stopped", uncertain: true });
    expect(uncertain.stopReceipt).toBeUndefined();
    // The hold and the allocation are retained; the pool was never told to release.
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "uncertain" });
    expect(acknowledgements).toBe(0);
    expect(await executionStatus(attempt.attemptId)).toBe("cancel_accepted");
    expect(await stopRow(attempt.run.runId)).toMatchObject({ state: "uncertain" });
    const late = harness(attempt, stopper(async value => signed(value)), acknowledger({}, () => { acknowledgements++; }));
    const settled = await late.stops.confirm(service, reference, signed(request!));
    expect(settled.state).toBe("stopped");
    expect(acknowledgements).toBe(1);
    expect(await executionStatus(attempt.attemptId)).toBe("stopped");
    // The late receipt settles the typed zero, and its stop event clears the
    // uncertainty the timeout left, which the kernel only folds when told so.
    expect(settled.event).toMatchObject({ kind: "attempt-stopped", uncertain: false });
    expect(await settlementOf(late.settlements, attempt)).toMatchObject({ revision: 1, source: "no-operations", knownCostMicros: "0" });
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "settled" });
    expect(await inboxKinds(attempt.run.runId)).toEqual(["admission-result", "cancel", "attempt-stopped", "usage-settled", "attempt-stopped"]);
    expect(await foldedStatus(attempt, advanced)).toBe("cancelled");
    expect(await late.stops.confirm(service, reference, signed(request!))).toEqual(settled);
  });

  test("a retried stop that fails again reports the reason this pass learned", async () => {
    // The durable row already says `uncertain`, and a durable read carries no
    // cause. Returning that read unchanged is how a retry loses the reason it
    // just learned: the operator's stream then says only that the stop is
    // still open, however many passes it takes and whatever they each found.
    const attempt = await launchedAttempt();
    const { reference } = await cancelled(attempt);
    const unreachable = new Error("the host could not be reached");
    const refused = new Error("the host declined to confirm");
    let raise: Error = unreachable;
    let request: FactoryTaskStopRequest | undefined;
    const { stops } = harness(attempt, stopper(async value => { request = value; throw raise; }), acknowledger({}));
    const once = await stops.stop(service, reference);
    expect(once.state).toBe("uncertain");
    expect(once.cause).toBe(unreachable);
    raise = refused;
    const twice = await stops.stop(service, reference);
    expect(twice.state).toBe("uncertain");
    // One uncertainty, not two: the sealed event is the same one.
    expect(twice.event).toEqual(once.event);
    expect(twice.cause).toBe(refused);
    expect(await stopRow(attempt.run.runId)).toMatchObject({ state: "uncertain" });
    // Settled before this test ends, so the uncertainty it created does not
    // outlive it and become another test's unexplained backlog.
    const late = harness(attempt, stopper(async value => signed(value)), acknowledger({}));
    expect((await late.stops.confirm(service, reference, signed(request!))).state).toBe("stopped");
  });

  test("only a configured supervisor key can assert a stop, and the pool must agree first", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await cancelled(attempt);
    const rejected = harness(attempt, stopper(async request => signed(request, {}, foreignKeys.privateKey)), acknowledger());
    expect((await rejected.stops.stop(service, reference)).state).toBe("uncertain");
    const unknownKey = harness(attempt, stopper(async request => signed(request, {}, hostKeys.privateKey, "unconfigured-key")), acknowledger());
    expect((await unknownKey.stops.stop(service, reference)).state).toBe("uncertain");
    const forged = harness(attempt, stopper(async request => signed(request, { processGroupAbsent: false as never })), acknowledger());
    expect((await forged.stops.stop(service, reference)).state).toBe("uncertain");
    const mismatched = harness(attempt, stopper(async request => signed(request)), acknowledger({ state: "running" }));
    expect((await mismatched.stops.stop(service, reference)).state).toBe("uncertain");
    const staleGeneration = harness(attempt, stopper(async request => signed(request)), acknowledger({ allocationGeneration: 9 }));
    expect((await staleGeneration.stops.stop(service, reference)).state).toBe("uncertain");
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "uncertain" });
    expect(await executionStatus(attempt.attemptId)).toBe("cancel_accepted");
    const accepted = harness(attempt, stopper(async request => signed(request)), acknowledger());
    expect((await accepted.stops.stop(service, reference)).state).toBe("stopped");
  });

  test("a rotated host key signs new stops while the retired key is refused", async () => {
    const first = await launchedAttempt();
    const firstReference = (await cancelled(first)).reference;
    const rotated: readonly FactoryStopHostKey[] = [{ hostId, hostKeyId: "stop-host-key-2", publicKey: rotatedKeys.publicKey }];
    // The retired key cannot assert a stop once it leaves the configured map.
    const retired = harness(first, stopper(async request => signed(request)), acknowledger(), rotated);
    expect((await retired.stops.stop(service, firstReference)).state).toBe("uncertain");
    const current = harness(first, stopper(async request => signed(request, {}, rotatedKeys.privateKey, "stop-host-key-2")), acknowledger(), rotated);
    expect((await current.stops.stop(service, firstReference)).state).toBe("stopped");
    // While both keys are configured, a receipt from either is admissible.
    const second = await launchedAttempt();
    const secondReference = (await cancelled(second)).reference;
    const both = harness(second, stopper(async request => signed(request)), acknowledger(), [{ hostId, hostKeyId: "stop-host-key-1", publicKey: hostKeys.publicKey }, ...rotated]);
    expect((await both.stops.stop(service, secondReference)).state).toBe("stopped");
  });

  test("rejects malformed host key material and an empty key set", () => {
    const attempt = { authority: undefined } as never;
    expect(() => harness(attempt, stopper(async request => signed(request)), acknowledger(), [])).toThrow();
    expect(() => harness(attempt, stopper(async request => signed(request)), acknowledger(), [{ hostId, hostKeyId: "bad", publicKey: "not a key" }])).toThrow();
  });

  test("reconciles a trusted later receipt into one idempotent settlement", async () => {
    const attempt = await launchedAttempt();
    // A lost provider response leaves the operation dispatched, which is the
    // only state a later receipt may reconcile, so the live stop path is the
    // one that reaches reconciliation.
    const { operation } = await dispatchedOperation(attempt);
    const { reference } = await cancelled(attempt);
    const held = harness(attempt, stopper(async request => signed(request)), acknowledger());
    expect((await held.stops.stop(service, reference)).state).toBe("stopped");
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "uncertain" });
    const providerReceiptDigest = "d".repeat(64);
    const usage = { kind: "measured" as const, inputTokens: 2, outputTokens: 3, computeMs: 4, costMicros: "5" };
    const reconciler = new FactoryUsageReconciliation(fixture.db, tenantId, held.stops, attempt.journal, lifecycle.budgets, held.settlements);
    const settled = await reconciler.reconcile({ reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest, usage });
    expect(settled).toMatchObject({ revision: 1, source: "reconciliation", knownCostMicros: "5", providerReceiptDigest });
    expect(settled.unknownCostMicros).toBeUndefined();
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "settled" });
    const replay = await reconciler.reconcile({ reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest, usage });
    expect(replay).toEqual(settled);
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "usage-settled")).toHaveLength(1);
    await expect(reconciler.reconcile({ reservationId: attempt.reservationId, attemptId: "another-attempt", operationId: operation.operationId, providerReceiptDigest, usage })).rejects.toMatchObject({ code: "factory_usage_settlement_conflict" });
    await expect(reconciler.reconcile({ reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest, usage: { ...usage, costMicros: "1" } })).rejects.toMatchObject({ code: "factory_usage_settlement_conflict" });
    await expect(reconciler.reconcile({ reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest: "unverified", usage })).rejects.toMatchObject({ code: "factory_usage_settlement_receipt_invalid" });
    // The `sha256:`-prefixed form is the collision the C02 ruling removed: the
    // SDK result validator and the generated schema can never carry it, so a
    // settlement that accepted it could never be mirrored by a terminal
    // result. Refused here, not normalized.
    await expect(reconciler.reconcile({ reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest: `sha256:${providerReceiptDigest}`, usage })).rejects.toMatchObject({ code: "factory_usage_settlement_receipt_invalid" });
    await expect(reconciler.reconcile({ reservationId: "missing-reservation", attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest, usage })).rejects.toMatchObject({ code: "factory_usage_settlement_not_found" });
  });

  test("a reconciled hold clears the kernel's uncertain attempt once, and the cancelled run reaches its terminal", async () => {
    const attempt = await launchedAttempt();
    const { operation } = await dispatchedOperation(attempt);
    const { reference, advanced } = await cancelled(attempt);
    const held = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const stopped = await held.stops.stop(service, reference);
    expect(stopped.event).toMatchObject({ kind: "attempt-stopped", uncertain: true });
    // Before reconciliation the kernel holds the attempt stopped-and-uncertain.
    expect(await foldedStatus(attempt, advanced)).toBe("stopping");
    const usage = { kind: "measured" as const, inputTokens: 2, outputTokens: 3, computeMs: 4, costMicros: "5" };
    const reconciler = new FactoryUsageReconciliation(fixture.db, tenantId, held.stops, attempt.journal, lifecycle.budgets, held.settlements);
    const settled = await reconciler.reconcile({ reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest: "e".repeat(64), usage });
    expect(settled).toMatchObject({ source: "reconciliation", knownCostMicros: "5" });
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "settled" });
    // The settlement tells the kernel the attempt is no longer uncertain, with the stop's own identity.
    const events = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${attempt.run.runId} ORDER BY sequence`)).map(row => JSON.parse(row.payload) as KernelEvent);
    expect(events.map(event => event.kind)).toEqual(["admission-result", "cancel", "attempt-stopped", "usage-settled", "attempt-stopped"]);
    expect(events.at(-1)).toEqual({ ...stopped.event, id: `${reference.commandId}:usage-resolved`, atMs: settled.settledAtMs, uncertain: false });
    expect(await foldedStatus(attempt, advanced)).toBe("cancelled");
    // Exactly once: a replayed reconciliation and a replayed stop add nothing.
    expect(await reconciler.reconcile({ reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest: "e".repeat(64), usage })).toEqual(settled);
    expect(await held.stops.stop(service, reference)).toEqual(stopped);
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "attempt-stopped")).toHaveLength(2);
    expect(await foldedStatus(attempt, advanced)).toBe("cancelled");
  });

  test("two reconcilers racing on one reservation settle it once and clear the kernel once", async () => {
    const attempt = await launchedAttempt();
    const { operation } = await dispatchedOperation(attempt);
    const { reference, advanced } = await cancelled(attempt);
    const held = harness(attempt, stopper(async request => signed(request)), acknowledger());
    expect((await held.stops.stop(service, reference)).state).toBe("stopped");
    // Two role processes, each with its own stop store, pick up the same hold.
    const other = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const facts = { reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest: "b".repeat(64), usage: { kind: "measured" as const, inputTokens: 2, outputTokens: 3, computeMs: 4, costMicros: "5" } };
    const [first, second] = await Promise.all([
      new FactoryUsageReconciliation(fixture.db, tenantId, held.stops, attempt.journal, lifecycle.budgets, held.settlements).reconcile(facts),
      new FactoryUsageReconciliation(fixture.db, tenantId, other.stops, attempt.journal, lifecycle.budgets, other.settlements).reconcile(facts),
    ]);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ source: "reconciliation", knownCostMicros: "5" });
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "settled" });
    expect((await settlementRows(attempt.run.runId)).map(row => row.source)).toEqual(["reconciliation"]);
    const clearing = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${attempt.run.runId} AND payload::jsonb->>'id' = ${`${reference.commandId}:usage-resolved`}`));
    expect(clearing).toHaveLength(1);
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "usage-settled")).toHaveLength(1);
    expect(await foldedStatus(attempt, advanced)).toBe("cancelled");
  });

  test("a hold whose usage is still unknown is not reconciled, and the kernel keeps the attempt uncertain", async () => {
    const attempt = await launchedAttempt();
    const { authority, operation } = await dispatchedOperation(attempt);
    await attempt.journal.settle(authority, operation.operationId, "uncertain", { providerReceiptDigest: "f".repeat(64), usage: { kind: "unknown", reason: "provider receipt pending", heldCostMicros: "9" } } as never);
    const { reference, advanced } = await cancelled(attempt);
    const held = harness(attempt, stopper(async request => signed(request)), acknowledger());
    expect((await held.stops.stop(service, reference)).state).toBe("stopped");
    const reconciler = new FactoryUsageReconciliation(fixture.db, tenantId, held.stops, attempt.journal, lifecycle.budgets, held.settlements);
    const [hold] = await fixture.db.transaction(transaction => lifecycle.budgets.listUncertainWithCostInTransaction(transaction)).then(holds => holds.filter(entry => entry.reservationId === attempt.reservationId));
    expect(await reconciler.resolve(hold!)).toMatchObject({ kind: "unknown", reason: "usage-still-unknown" });
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "uncertain" });
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "attempt-stopped")).toHaveLength(1);
    expect(await foldedStatus(attempt, advanced)).toBe("stopping");
  });

  test("reconciling a hold whose physical stop is still unconfirmed settles the cost but clears nothing", async () => {
    const attempt = await launchedAttempt();
    const { operation } = await dispatchedOperation(attempt);
    const { reference, advanced } = await cancelled(attempt);
    // The host never answers, so the stop stays uncertain: the process may still be running.
    const hung = harness(attempt, { async stop(_request, signal) { return new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("host unreachable"))); }); } }, acknowledger(), undefined, 1);
    expect((await hung.stops.stop(service, reference)).state).toBe("uncertain");
    const reconciler = new FactoryUsageReconciliation(fixture.db, tenantId, hung.stops, attempt.journal, lifecycle.budgets, hung.settlements);
    const usage = { kind: "measured" as const, inputTokens: 1, outputTokens: 1, computeMs: 1, costMicros: "2" };
    expect(await reconciler.reconcile({ reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest: "c".repeat(64), usage })).toMatchObject({ source: "reconciliation" });
    // Cost is settled; the physical stop is not proven, so no clearing event is sent.
    expect(rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${attempt.run.runId} AND payload::jsonb->>'id' LIKE '%:usage-resolved'`))).toEqual([]);
    expect(await foldedStatus(attempt, advanced)).toBe("stopping");
    // The host confirms later. The cost is already settled, so this stop is
    // certain: it keeps the reconciled budget and clears the uncertainty itself.
    const confirmed = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const stopped = await confirmed.stops.stop(service, reference);
    expect(stopped.state).toBe("stopped");
    expect(stopped.event).toMatchObject({ kind: "attempt-stopped", uncertain: false });
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "settled" });
    expect((await settlementRows(attempt.run.runId)).map(row => row.source)).toEqual(["reconciliation"]);
    expect(await foldedStatus(attempt, advanced)).toBe("cancelled");
    // Re-reading the sealed stop accepts the shape, and nothing is sent twice.
    expect(await confirmed.stops.stop(service, reference)).toEqual(stopped);
    // One stop-uncertain event and one certain stopped event: nothing is sent twice.
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "attempt-stopped")).toHaveLength(2);
  });

  test("a listed hold resolves to the sealed facts reconciliation needs, or stays unknown", async () => {
    const attempt = await launchedAttempt();
    const { operation } = await dispatchedOperation(attempt);
    // A second operation that settles with its own receipt before the run is
    // cancelled. It is not this hold's evidence and must never be borrowed.
    const authority = await sealedAuthority(attempt);
    const second = { operationId: `${attempt.run.runId}:${authority.nodeInstanceId}:${authority.candidateGeneration}:1`, operationIndex: 1, kind: "model" as const, requestDigest: "a".repeat(64) };
    await attempt.journal.prepare(authority, second);
    await attempt.journal.dispatch(authority, second.operationId);
    await attempt.journal.settle(authority, second.operationId, "failed", { resultDigest: "f".repeat(64), providerReceiptDigest: "9".repeat(64), usage: { kind: "measured", inputTokens: 9, outputTokens: 9, computeMs: 9, costMicros: "99" } });

    const { reference } = await cancelled(attempt);
    const held = harness(attempt, stopper(async request => signed(request)), acknowledger());
    expect((await held.stops.stop(service, reference)).state).toBe("stopped");
    const reconciler = new FactoryUsageReconciliation(fixture.db, tenantId, held.stops, attempt.journal, lifecycle.budgets, held.settlements);
    const holds = await fixture.db.transaction(transaction => lifecycle.budgets.listUncertainWithCostInTransaction(transaction));
    const hold = holds.find(entry => entry.reservationId === attempt.reservationId)!;
    expect(hold).toBeDefined();

    // No receipt has landed on the operation that caused the hold, so the hold
    // stays held rather than settling as zero, and the settled operation's own
    // receipt is not borrowed for it.
    // W03f: the hold names the call it waits on.
    expect(await reconciler.resolve(hold)).toEqual({ kind: "unknown", reservationId: attempt.reservationId, reason: "operation-not-settled", operationIds: [expect.any(String)] });

    // The operation that caused the hold now carries a receipt but no measured
    // usage, which is still unknown, not zero.
    const providerReceiptDigest = "7".repeat(64);
    await fixture.db.execute(sql`UPDATE factory_execution_operations SET state='uncertain', provider_receipt_digest=${providerReceiptDigest}, usage_json=${JSON.stringify({ kind: "unknown", reason: "provider receipt pending", heldCostMicros: "900" })}::jsonb WHERE attempt_id=${attempt.attemptId} AND operation_id=${operation.operationId}`);
    expect(await reconciler.resolve(hold)).toEqual({ kind: "unknown", reservationId: attempt.reservationId, reason: "usage-still-unknown" });

    // A tampered digest is refused rather than handed on to the reconciler,
    // and so is the retired `sha256:` form, which the C02 surfaces cannot read.
    for (const tampered of ["not-a-digest", `sha256:${providerReceiptDigest}`, "A".repeat(64), providerReceiptDigest.slice(1)]) {
      await fixture.db.execute(sql`UPDATE factory_execution_operations SET usage_json=${JSON.stringify({ kind: "measured", inputTokens: 2, outputTokens: 3, computeMs: 4, costMicros: "5" })}::jsonb, provider_receipt_digest=${tampered} WHERE attempt_id=${attempt.attemptId} AND operation_id=${operation.operationId}`);
      await expect(reconciler.resolve(hold)).rejects.toMatchObject({ code: "factory_usage_settlement_receipt_invalid" });
    }
    // A tampered usage is corrupt, never rounded to something usable.
    await fixture.db.execute(sql`UPDATE factory_execution_operations SET usage_json=${JSON.stringify({ kind: "measured", inputTokens: 2, outputTokens: 3, computeMs: 4, costMicros: "-5" })}::jsonb, provider_receipt_digest=${providerReceiptDigest} WHERE attempt_id=${attempt.attemptId} AND operation_id=${operation.operationId}`);
    await expect(reconciler.resolve(hold)).rejects.toMatchObject({ code: "factory_usage_settlement_corrupt" });

    // With the sealed facts present, the hold resolves to exactly the four the
    // reconciler needs, and resolving twice gives the same answer.
    await fixture.db.execute(sql`UPDATE factory_execution_operations SET usage_json=${JSON.stringify({ kind: "measured", inputTokens: 2, outputTokens: 3, computeMs: 4, costMicros: "5" })}::jsonb WHERE attempt_id=${attempt.attemptId} AND operation_id=${operation.operationId}`);
    const resolved = await reconciler.resolve(hold);
    expect(resolved).toEqual({ kind: "resolved", reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: operation.operationId, providerReceiptDigest, usage: { kind: "measured", inputTokens: 2, outputTokens: 3, computeMs: 4, costMicros: "5" } });
    expect(await reconciler.resolve(hold)).toEqual(resolved);

    // Those facts settle the hold exactly once, and the hold leaves the list.
    if (resolved.kind !== "resolved") throw new Error("expected resolved facts");
    const settled = await reconciler.reconcile({ reservationId: resolved.reservationId, attemptId: resolved.attemptId, operationId: resolved.operationId, providerReceiptDigest: resolved.providerReceiptDigest, usage: resolved.usage });
    expect(settled).toMatchObject({ source: "reconciliation", knownCostMicros: "5", providerReceiptDigest });
    expect(await reconciler.reconcile({ reservationId: resolved.reservationId, attemptId: resolved.attemptId, operationId: resolved.operationId, providerReceiptDigest: resolved.providerReceiptDigest, usage: resolved.usage })).toEqual(settled);
    expect(rows(await fixture.db.execute(sql`SELECT revision FROM factory_usage_settlements WHERE run_id=${attempt.run.runId} AND reservation_id=${attempt.reservationId}`))).toHaveLength(1);
    const remaining = await fixture.db.transaction(transaction => lifecycle.budgets.listUncertainWithCostInTransaction(transaction));
    expect(remaining.map(entry => entry.reservationId)).not.toContain(attempt.reservationId);

    // A hold naming a different run than its sealed stop funds nothing.
    await expect(reconciler.resolve({ ...hold, runId: "other-run" })).rejects.toMatchObject({ code: "factory_usage_settlement_conflict" });
    // A hold with no sealed stop at all is unknown, not an error.
    expect(await reconciler.resolve({ ...hold, reservationId: "reservation-without-a-stop" })).toEqual({ kind: "unknown", reservationId: "reservation-without-a-stop", reason: "no-sealed-attempt" });
  });

  test("a corrupt sealed stop is refused rather than replayed", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await cancelled(attempt);
    const { stops } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    await stops.stop(service, reference);
    for (const mutation of [
      sql`UPDATE factory_task_stops SET request_digest=${`sha256:${"0".repeat(64)}`} WHERE run_id=${attempt.run.runId}`,
      sql`UPDATE factory_task_stops SET source='terminal-outcome' WHERE run_id=${attempt.run.runId}`,
      sql`UPDATE factory_task_stops SET stopped_event_digest=${`sha256:${"0".repeat(64)}`} WHERE run_id=${attempt.run.runId}`,
      sql`UPDATE factory_task_stops SET accepted_at_ms=-1 WHERE run_id=${attempt.run.runId}`,
    ]) {
      const before = rows<Record<string, unknown>>(await fixture.db.execute(sql`SELECT * FROM factory_task_stops WHERE run_id=${attempt.run.runId}`))[0]!;
      const applied = await fixture.db.execute(mutation).then(() => true, () => false);
      if (!applied) continue;
      await expect(stops.stop(service, reference)).rejects.toBeInstanceOf(FactoryTaskStopError);
      await fixture.db.execute(sql`UPDATE factory_task_stops SET request_digest=${before.request_digest as string},source=${before.source as string},stopped_event_digest=${before.stopped_event_digest as string},accepted_at_ms=${Number(before.accepted_at_ms)} WHERE run_id=${attempt.run.runId}`);
    }
    expect((await stops.stop(service, reference)).state).toBe("stopped");
  });

  test("refuses a stop outside its tenant, its service, or its sealed generations", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await cancelled(attempt);
    const { stops } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    await expect(stops.stop({ ...service, subject: "foreign" }, reference)).rejects.toBeInstanceOf(Error);
    await expect(stops.stop(service, { ...reference, tenantId: "foreign-tenant" })).rejects.toMatchObject({ code: "factory_task_stop_scope" });
    await expect(stops.confirm(service, { ...reference, commandId: "missing-command" }, signed({ ...attempt, cancelReference: reference, attemptId: attempt.attemptId, reservationId: attempt.reservationId, workerId: "w", holderGeneration: 1, allocationGeneration: 1, hostId, reason: "cancelled", source: "sealed-launch" } as FactoryTaskStopRequest))).rejects.toMatchObject({ code: "factory_task_stop_not_found" });
    const wrongGeneration = harness(attempt, stopper(async request => signed(request, { holderGeneration: 7 })), acknowledger());
    expect((await wrongGeneration.stops.stop(service, reference)).state).toBe("uncertain");
    expect((await stops.stop(service, reference)).state).toBe("stopped");
  });

  test("one signed receipt settles one attempt and cannot be replayed onto another", async () => {
    const first = await launchedAttempt();
    const firstReference = (await cancelled(first)).reference;
    const firstHarness = harness(first, stopper(async request => signed(request)), acknowledger());
    const settled = await firstHarness.stops.stop(service, firstReference);
    const second = await launchedAttempt();
    const secondReference = (await cancelled(second)).reference;
    // The first attempt's signed receipt names another attempt, so presenting
    // it here leaves durable uncertainty rather than a second settlement.
    const replayed = harness(second, stopper(async () => settled.stopReceipt!), acknowledger());
    expect((await replayed.stops.stop(service, secondReference)).state).toBe("uncertain");
    await expect(replayed.stops.confirm(service, secondReference, settled.stopReceipt!)).rejects.toMatchObject({ code: "factory_task_stop_proof_invalid" });
    const secondHarness = harness(second, stopper(async request => signed(request)), acknowledger());
    expect((await secondHarness.stops.stop(service, secondReference)).state).toBe("stopped");
    expect(rows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_task_stops WHERE stop_receipt_digest=${settled.stopReceipt!.receiptDigest}`))).toEqual([{ attempt_id: first.attemptId }]);
  });

  test("a pool acknowledgement that outlives a failed product transaction settles once on retry", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await failedOutcome(attempt, "measured");
    let acknowledgements = 0;
    const base = harness(attempt, stopper(async request => signed(request)), acknowledger({}, () => { acknowledgements++; }));
    // The pool releases capacity, then the product transaction fails. Nothing
    // durable may be left behind, and the retry must not settle twice.
    let failures = 1;
    const brittle = Object.create(base.settlements, { recordInTransaction: { value: async (...args: Parameters<FactoryUsageSettlements["recordInTransaction"]>) => {
      if (failures-- > 0) throw new Error("product settlement transaction lost");
      return base.settlements.recordInTransaction(...args);
    } } }) as FactoryUsageSettlements;
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const outcomes = new FactoryTaskOutcomes(fixture.db, attempt.authority, attempt.admissions, attempt.journal, attempt.queue, lifecycle.budgets, inbox, () => now);
    const interrupted = new FactoryTaskStops(fixture.db, attempt.authority, attempt.admissions, attempt.journal, outcomes, attempt.queue, lifecycle.budgets, inbox, brittle, stopper(async request => signed(request)), acknowledger({}, () => { acknowledgements++; }), [{ hostId, hostKeyId: "stop-host-key-1", publicKey: hostKeys.publicKey }], () => now, 20_000);
    // The pool has released, but nothing the product owns may be settled: the
    // stop degrades to durable uncertainty and keeps its hold.
    expect((await interrupted.stop(service, reference)).state).toBe("uncertain");
    expect(acknowledgements).toBe(1);
    expect(await stopRow(attempt.run.runId)).toMatchObject({ state: "uncertain" });
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "uncertain", actual: null });
    expect(await executionStatus(attempt.attemptId)).toBe("cancel_accepted");
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "usage-settled")).toHaveLength(0);
    const settled = await base.stops.stop(service, reference);
    expect(settled.state).toBe("stopped");
    expect(acknowledgements).toBe(2);
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "settled" });
    // One uncertain event and one stopped event, and exactly one settlement.
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "attempt-stopped")).toHaveLength(2);
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "usage-settled")).toHaveLength(1);
    expect(rows(await fixture.db.execute(sql`SELECT revision FROM factory_usage_settlements WHERE run_id=${attempt.run.runId}`))).toHaveLength(1);
  });

  test("cancelling during admission claims no capacity and leaves no stop to settle", async () => {
    // The run is cancelled while the compute request is still queued, so no
    // attempt was ever dispatched and there is nothing physical to stop.
    const { run, identity, compiled, authority, first, activities, admissionCommandId } = await world.startRun();
    const admissionCommand = { id: admissionCommandId };
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const unavailable = async (): Promise<never> => { throw new Error("A cancelled admission never reaches the pool."); };
    const requestPool = { request: unavailable, status: unavailable, cancel: unavailable, acknowledgeStart: unavailable, renew: unavailable, confirmStopped: unavailable } satisfies PoolAdmissionClient;
    const admissions = new FactoryComputeAdmissions(fixture.db, tenantId, authority, lifecycle.budgets, inbox, requestPool, () => now);
    const reserved = await new FactoryTaskAdmission(fixture.db, authority, lifecycle.budgets, { cpu: profile }, admissions, () => now).request(service, { ...identity, commandId: admissionCommand.id });
    expect(await reservationState(reserved.reservationId)).toMatchObject({ state: "held" });

    await lifecycle.cancel(principal, runKey(run.runId), run.revision, `admitting-cancel-${run.runId}`);
    const stored = rows<{ payload: string }>(await fixture.db.execute(sql`SELECT payload FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${run.runId} AND payload::jsonb->>'kind'='cancel'`));
    const cancelEvent = JSON.parse(stored[0]!.payload) as KernelEvent;
    const advanced = advanceKernel(compiled, first.nextState, cancelEvent);
    // The kernel does ask to cancel the node, and its `attemptCommandId` is the
    // admission command, because no dispatch command was ever issued.
    const cancelCommand = advanced.commands.find(command => command.kind === "cancel-node");
    expect(cancelCommand).toMatchObject({ attemptCommandId: admissionCommand.id });
    await persistTransition(identity, 2, cancelEvent, advanced.nextState, advanced.commands, undefined, activities);

    // The physical stop refuses it: there is no sealed launch, so there is no
    // holder to fence and nothing to sign. It never fabricates a stop fact.
    const stopped = new FactoryTaskStops(fixture.db, authority, admissions, new FactoryExecutionJournal(fixture.db, lifecycle.authorizeAttemptInTransaction), new FactoryTaskOutcomes(fixture.db, authority, admissions, new FactoryExecutionJournal(fixture.db, lifecycle.authorizeAttemptInTransaction), new FactoryAttemptQueue(fixture.db, new FactoryExecutionJournal(fixture.db, lifecycle.authorizeAttemptInTransaction), tenantId, () => now), lifecycle.budgets, inbox, () => now), new FactoryAttemptQueue(fixture.db, new FactoryExecutionJournal(fixture.db, lifecycle.authorizeAttemptInTransaction), tenantId, () => now), lifecycle.budgets, inbox, new FactoryUsageSettlements(fixture.db, tenantId, inbox, () => now), stopper(async () => { throw new Error("an unadmitted attempt has no host to stop"); }), acknowledger({}, () => { throw new Error("an unadmitted attempt never released capacity"); }), [{ hostId, hostKeyId: "stop-host-key-1", publicKey: hostKeys.publicKey }], () => now, 20_000);
    await expect(stopped.stop(service, { ...identity, commandId: cancelCommand!.id })).rejects.toMatchObject({ code: "factory_task_stop_stale" });
    expect(rows(await fixture.db.execute(sql`SELECT cancel_command_id FROM factory_task_stops WHERE run_id=${run.runId}`))).toEqual([]);
    expect(rows(await fixture.db.execute(sql`SELECT attempt_id FROM factory_attempt_launches WHERE run_id=${run.runId}`))).toEqual([]);
    // No capacity was ever claimed, and the unused hold is still the admission
    // path's to release: `factory_budget_reservations` never left `held`.
    expect(await reservationState(reserved.reservationId)).toMatchObject({ state: "held" });
  });

  test("lists exactly the accepted cancellations a stop worker must still drive", async () => {
    const list = (stops: FactoryTaskStops, options?: { limit?: number; after?: { acceptedAtMs: number; cancelCommandId: string } }) =>
      fixture.db.transaction(transaction => stops.listStoppableInTransaction(transaction, options));

    // An empty scan on a tenant with no accepted cancellation.
    const first = await launchedAttempt();
    const empty = harness(first, stopper(async request => signed(request)), acknowledger());
    expect(await list(empty.stops)).toEqual([]);

    // One accepted-but-unsettled stop appears, with the exact cancel reference
    // `stop` takes and the sealed identities beside it.
    const firstReference = (await cancelled(first)).reference;
    const uncertainHarness = harness(first, { async stop(_request, signal) { return new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("host unreachable"))); }); } }, acknowledger(), undefined, 5);
    expect((await uncertainHarness.stops.stop(service, firstReference)).state).toBe("uncertain");
    const pending = await list(empty.stops);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ reference: firstReference, attemptId: first.attemptId, reservationId: first.reservationId, source: "sealed-launch", state: "uncertain" });
    expect(pending[0]!.cursor).toEqual({ acceptedAtMs: pending[0]!.acceptedAtMs, cancelCommandId: firstReference.commandId });

    // A second and third accepted cancellation page deterministically, and the
    // pages partition the work with no repeat and no gap.
    const second = await launchedAttempt();
    const secondReference = (await cancelled(second)).reference;
    const third = await launchedAttempt();
    const thirdReference = (await cancelled(third)).reference;
    for (const [attempt, reference] of [[second, secondReference], [third, thirdReference]] as const) {
      const accepting = harness(attempt, { async stop(_request, signal) { return new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("host unreachable"))); }); } }, acknowledger(), undefined, 5);
      expect((await accepting.stops.stop(service, reference)).state).toBe("uncertain");
    }
    const all = await list(empty.stops);
    expect(all.map(entry => entry.reference.commandId)).toEqual([firstReference.commandId, secondReference.commandId, thirdReference.commandId].sort((left, right) => left < right ? -1 : left > right ? 1 : 0));
    // Oldest first: the acceptance clock never decreases across the page.
    expect(all.map(entry => entry.acceptedAtMs)).toEqual([...all.map(entry => entry.acceptedAtMs)].sort((left, right) => left - right));
    const pageOne = await list(empty.stops, { limit: 2 });
    expect(pageOne).toHaveLength(2);
    const pageTwo = await list(empty.stops, { limit: 2, after: pageOne[1]!.cursor });
    expect(pageTwo.map(entry => entry.reference.commandId)).toEqual(all.slice(2).map(entry => entry.reference.commandId));
    expect(await list(empty.stops, { limit: 2, after: all[all.length - 1]!.cursor })).toEqual([]);
    expect([...pageOne, ...pageTwo].map(entry => entry.reference.commandId)).toEqual(all.map(entry => entry.reference.commandId));

    // Concurrent scans take no locks and agree, so two workers see the same
    // work; only one of them can settle it.
    expect(await Promise.all([list(empty.stops), list(empty.stops)])).toEqual([all, all]);
    const settled = harness(third, stopper(async request => signed(request)), acknowledger());
    const racing = await Promise.allSettled([settled.stops.stop(service, thirdReference), settled.stops.stop(service, thirdReference)]);
    for (const outcome of racing) expect(outcome.status === "fulfilled" ? outcome.value.state : "rejected").toBe("stopped");
    // A settled stop is terminal and leaves the work list.
    expect((await list(empty.stops)).map(entry => entry.reference.commandId)).not.toContain(thirdReference.commandId);

    // Bounds and a malformed cursor are refused rather than scanned.
    for (const limit of [0, -1, 1.5, FACTORY_STOP_SCAN_MAX_LIMIT + 1]) await expect(list(empty.stops, { limit })).rejects.toMatchObject({ code: "factory_task_stop_invalid" });
    await expect(list(empty.stops, { after: { acceptedAtMs: -1, cancelCommandId: firstReference.commandId } })).rejects.toMatchObject({ code: "factory_task_stop_invalid" });
    await expect(list(empty.stops, { after: { acceptedAtMs: 1, cancelCommandId: "" } })).rejects.toBeInstanceOf(Error);
    // A corrupt source is refused rather than handed to a worker. The durable
    // CHECK normally makes this unreachable, so it is lifted to prove the scan
    // does not trust the column, then restored.
    await fixture.db.execute(sql`ALTER TABLE factory_task_stops DROP CONSTRAINT factory_task_stops_source_check`);
    try {
      await fixture.db.execute(sql`UPDATE factory_task_stops SET source='forged' WHERE cancel_command_id=${firstReference.commandId}`);
      await expect(list(empty.stops)).rejects.toMatchObject({ code: "factory_task_stop_corrupt" });
    } finally {
      await fixture.db.execute(sql`UPDATE factory_task_stops SET source='sealed-launch' WHERE cancel_command_id=${firstReference.commandId}`);
      await fixture.db.execute(sql`ALTER TABLE factory_task_stops ADD CONSTRAINT factory_task_stops_source_check CHECK (source IN ('terminal-outcome','sealed-launch'))`);
    }
    expect((await list(empty.stops)).length).toBeGreaterThan(0);
  });

  test("concurrent stop and confirm commit one settlement", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await cancelled(attempt);
    let sealed: FactoryTaskStopRequest | undefined;
    const { stops } = harness(attempt, stopper(async request => { sealed = request; return signed(request); }), acknowledger());
    const first = await stops.stop(service, reference);
    const results = await Promise.allSettled([stops.stop(service, reference), stops.confirm(service, reference, signed(sealed!)), stops.stop(service, reference)]);
    for (const result of results) expect(result.status === "fulfilled" ? result.value : result.reason).toEqual(first);
    expect(rows(await fixture.db.execute(sql`SELECT cancel_command_id FROM factory_task_stops WHERE run_id=${attempt.run.runId}`))).toHaveLength(1);
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "attempt-stopped")).toHaveLength(1);
  });

  test("concurrent stops of an attempt with no operations commit one typed zero and one usage event", async () => {
    const attempt = await launchedAttempt();
    const { reference, advanced } = await cancelled(attempt);
    const racers = [0, 1, 2].map(() => harness(attempt, stopper(async request => signed(request)), acknowledger()));
    const results = await Promise.allSettled(racers.map(racer => racer.stops.stop(service, reference)));
    const stopped = results.flatMap(result => result.status === "fulfilled" && result.value.state === "stopped" ? [result.value] : []);
    expect(stopped.length).toBeGreaterThan(0);
    for (const receipt of stopped) expect(receipt).toEqual(stopped[0]!);
    // A racer that lost the row may have recorded uncertainty first; a retry converges on the one settled stop.
    expect(await racers[0]!.stops.stop(service, reference)).toEqual(stopped[0]!);
    expect(await settlementRows(attempt.run.runId)).toEqual([{ revision: 1, source: "no-operations" }]);
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "usage-settled")).toHaveLength(1);
    expect(await foldedStatus(attempt, advanced)).toBe("cancelled");
  });

  test("a lost settlement transaction after the pool released settles the typed zero once on restart", async () => {
    const attempt = await launchedAttempt();
    const { reference, advanced } = await cancelled(attempt);
    const base = harness(attempt, stopper(async request => signed(request)), acknowledger());
    let failures = 1;
    const brittle = Object.create(lifecycle.budgets, { settleWithoutOperationsInTransaction: { value: async (...args: Parameters<FactoryBudgets["settleWithoutOperationsInTransaction"]>) => {
      if (failures-- > 0) throw new Error("product settlement transaction lost");
      return lifecycle.budgets.settleWithoutOperationsInTransaction(...args);
    } } }) as FactoryBudgets;
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const outcomes = new FactoryTaskOutcomes(fixture.db, attempt.authority, attempt.admissions, attempt.journal, attempt.queue, lifecycle.budgets, inbox, () => now);
    const interrupted = new FactoryTaskStops(fixture.db, attempt.authority, attempt.admissions, attempt.journal, outcomes, attempt.queue, brittle, inbox, base.settlements, stopper(async request => signed(request)), acknowledger(), [{ hostId, hostKeyId: "stop-host-key-1", publicKey: hostKeys.publicKey }], () => now, 20_000);
    // Nothing the product owns may be settled by the failed transaction.
    expect((await interrupted.stop(service, reference)).state).toBe("uncertain");
    expect(await settlementOf(base.settlements, attempt)).toBeUndefined();
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "usage-settled")).toHaveLength(0);
    // A fresh process (a restarted stop worker) settles it exactly once.
    const restarted = harness(attempt, stopper(async request => signed(request)), acknowledger());
    expect((await restarted.stops.stop(service, reference)).event).toMatchObject({ kind: "attempt-stopped", uncertain: false });
    expect(await restarted.stops.stop(service, reference)).toMatchObject({ state: "stopped" });
    expect(await settlementRows(attempt.run.runId)).toEqual([{ revision: 1, source: "no-operations" }]);
    expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "usage-settled")).toHaveLength(1);
    expect(await reservationState(attempt.reservationId)).toMatchObject({ state: "settled" });
    expect(await foldedStatus(attempt, advanced)).toBe("cancelled");
  });

  test("a stale execution epoch settles nothing until the sealed epoch is current again", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await cancelled(attempt);
    const { stops, settlements } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const current = rows<{ execution_epoch: number | string }>(await fixture.db.execute(sql`SELECT execution_epoch FROM factory_runs WHERE run_id=${attempt.run.runId}`))[0]!.execution_epoch;
    await fixture.db.execute(sql`UPDATE factory_runs SET execution_epoch=${Number(current) + 1} WHERE run_id=${attempt.run.runId}`);
    try {
      await stops.stop(service, reference).catch(error => error);
      expect(await settlementOf(settlements, attempt)).toBeUndefined();
      expect((await reservationState(attempt.reservationId))?.state).not.toBe("settled");
      expect((await inboxKinds(attempt.run.runId)).filter(kind => kind === "usage-settled")).toHaveLength(0);
    } finally {
      await fixture.db.execute(sql`UPDATE factory_runs SET execution_epoch=${Number(current)} WHERE run_id=${attempt.run.runId}`);
    }
    expect((await stops.stop(service, reference)).state).toBe("stopped");
    expect(await settlementOf(settlements, attempt)).toMatchObject({ source: "no-operations", knownCostMicros: "0" });
  });

  test("another tenant can neither settle nor read a typed zero it does not own", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await cancelled(attempt);
    const { stops, settlements } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const receipt = await stops.stop(service, reference);
    const foreign = new FactoryUsageSettlements(fixture.db, "foreign-tenant", new FactoryInbox(fixture.db, "foreign-tenant", () => now), () => now);
    const authority = await sealedAuthority(attempt);
    const scope = { projectId, runId: attempt.run.runId, interpreterId: "root", reservationId: attempt.reservationId, authority };
    await expect(fixture.db.transaction(transaction => foreign.recordInTransaction(transaction, scope, { source: "no-operations", knownCostMicros: "0", stopReceiptDigest: receipt.stopReceipt!.receiptDigest }))).rejects.toMatchObject({ code: "factory_usage_settlement_scope" });
    expect(await fixture.db.transaction(transaction => foreign.readLatestInTransaction(transaction, { projectId, runId: attempt.run.runId, reservationId: attempt.reservationId }))).toBeUndefined();
    expect(await settlementOf(settlements, attempt)).toMatchObject({ revision: 1, source: "no-operations" });
  });

  test("a stored certain stop whose typed zero has gone missing is refused as corrupt", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await cancelled(attempt);
    const { stops } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const receipt = await stops.stop(service, reference);
    // The stop's certainty is re-derived from the settlement it sealed, so a
    // certain stop event with no no-operations zero behind it is not replayed.
    const saved = rows<Record<string, unknown>>(await fixture.db.execute(sql`SELECT * FROM factory_usage_settlements WHERE run_id=${attempt.run.runId}`))[0]!;
    await fixture.db.execute(sql`DELETE FROM factory_usage_settlements WHERE run_id=${attempt.run.runId}`);
    try {
      await expect(stops.stop(service, reference)).rejects.toMatchObject({ code: "factory_task_stop_corrupt" });
    } finally {
      await fixture.db.execute(sql`INSERT INTO factory_usage_settlements (tenant_id,project_id,run_id,reservation_id,revision,attempt_id,source,known_cost_micros,unknown_cost_micros,provider_receipt_digest,stop_receipt_digest,basis,settled_at_ms,settlement_digest,event_json,event_digest) VALUES (${saved.tenant_id as string},${saved.project_id as string},${saved.run_id as string},${saved.reservation_id as string},${Number(saved.revision)},${saved.attempt_id as string},${saved.source as string},${saved.known_cost_micros as string},${null},${null},${saved.stop_receipt_digest as string},${saved.basis as string},${Number(saved.settled_at_ms)},${saved.settlement_digest as string},${saved.event_json as string},${saved.event_digest as string})`);
    }
    expect(await stops.stop(service, reference)).toEqual(receipt);
  });

  test("a measured stop sealed after an uncertain one by pre-W03e code stays readable, and a forged shape does not", async () => {
    const attempt = await launchedAttempt();
    const { reference } = await failedOutcome(attempt, "measured");
    // The first pass leaves durable uncertainty; the second seals the measured stop after it.
    const failing = harness(attempt, stopper(async () => { throw new Error("host unreachable"); }), acknowledger());
    expect((await failing.stops.stop(service, reference)).state).toBe("uncertain");
    const { stops } = harness(attempt, stopper(async request => signed(request)), acknowledger());
    const sealed = await stops.stop(service, reference);
    expect(sealed.event).toMatchObject({ kind: "attempt-stopped", uncertain: false });
    const stored = rows<{ stopped_event_json: string; stopped_event_digest: string }>(await fixture.db.execute(sql`SELECT stopped_event_json, stopped_event_digest FROM factory_task_stops WHERE run_id=${attempt.run.runId}`))[0]!;
    const reseal = (event: KernelEvent) => fixture.db.execute(sql`UPDATE factory_task_stops SET stopped_event_json=${JSON.stringify(event)}, stopped_event_digest=${`sha256:${digestObject(event)}`} WHERE run_id=${attempt.run.runId}`);
    try {
      // The shape pre-W03e code wrote: a certain stop with no \`uncertain\` field.
      const { uncertain: _cleared, ...preW03e } = sealed.event;
      await reseal(preW03e as KernelEvent);
      expect(await stops.stop(service, reference)).toEqual({ ...sealed, event: preW03e });
      // A shape no version ever wrote is still corrupt.
      await reseal({ ...sealed.event, uncertain: true } as KernelEvent);
      await expect(stops.stop(service, reference)).rejects.toMatchObject({ code: "factory_task_stop_corrupt" });
    } finally {
      await fixture.db.execute(sql`UPDATE factory_task_stops SET stopped_event_json=${stored.stopped_event_json}, stopped_event_digest=${stored.stopped_event_digest} WHERE run_id=${attempt.run.runId}`);
    }
    expect(await stops.stop(service, reference)).toEqual(sealed);
  });

  // Last on purpose: supersession ends every live attempt of the epoch in this shared store.
  test("a stop left accepted, before its host was ever asked, also ends with the attempt's supersession (W15f M1)", async () => {
    const attempt = await launchedAttempt(false);
    const { reference } = await cancelled(attempt);
    const { stops } = harness(attempt, { async stop(_request, signal) { return new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("host unreachable"))); }); } }, acknowledger(), undefined, 5);
    await stops.stop(service, reference);
    // The process ended between acceptance and the host call: the stop is only accepted.
    await fixture.db.execute(sql`UPDATE factory_task_stops SET state='accepted', uncertain_event_json=NULL, uncertain_event_digest=NULL WHERE attempt_id=${attempt.attemptId}`);
    const epoch = Number(rows<{ execution_epoch: number | string }>(await fixture.db.execute(sql`SELECT execution_epoch FROM factory_executions WHERE attempt_id=${attempt.attemptId}`))[0]!.execution_epoch);
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    await fixture.db.transaction(transaction => supersedeEpochAttemptsInTransaction(transaction, inbox, { tenantId, previousEpoch: epoch, executionEpoch: epoch + 1, restoreId: "restore-m1-accepted", restoreDigest: `sha256:${"d".repeat(64)}`, atMs: now }));
    expect(rows<{ state: string; superseded_restore_id: string | null }>(await fixture.db.execute(sql`SELECT state, superseded_restore_id FROM factory_task_stops WHERE attempt_id=${attempt.attemptId}`))).toEqual([{ state: "superseded", superseded_restore_id: "restore-m1-accepted" }]);
    expect((await fixture.db.transaction(transaction => stops.listStoppableInTransaction(transaction))).map(item => item.attemptId)).not.toContain(attempt.attemptId);
  });

  test("a stop accepted before a restore and never confirmed ends with the attempt's supersession: not listed again, and the clear sends the supersession's end (W15f M1)", async () => {
    const attempt = await launchedAttempt(false);
    const { reference } = await cancelled(attempt);
    // The host never answers, so the stop stays uncertain.
    const { stops } = harness(attempt, { async stop(_request, signal) { return new Promise<never>((_resolve, reject) => { signal.addEventListener("abort", () => reject(new Error("host unreachable"))); }); } }, acknowledger(), undefined, 5);
    expect((await stops.stop(service, reference)).state).toBe("uncertain");
    const epoch = Number(rows<{ execution_epoch: number | string }>(await fixture.db.execute(sql`SELECT execution_epoch FROM factory_executions WHERE attempt_id=${attempt.attemptId}`))[0]!.execution_epoch);
    // A restore opens and is signed: the installation moves on and the attempt is superseded.
    await fixture.db.execute(sql`UPDATE factory_installation SET execution_epoch=${epoch + 1} WHERE tenant_id=${tenantId}`);
    try {
      const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
      await fixture.db.transaction(transaction => supersedeEpochAttemptsInTransaction(transaction, inbox, { tenantId, previousEpoch: epoch, executionEpoch: epoch + 1, restoreId: "restore-m1", restoreDigest: `sha256:${"e".repeat(64)}`, atMs: now }));
      expect(await executionStatus(attempt.attemptId)).toBe("superseded");
      // The stop ends with the supersession, by state: the stop role never lists it again.
      expect(rows<{ state: string; superseded_restore_id: string | null }>(await fixture.db.execute(sql`SELECT state, superseded_restore_id FROM factory_task_stops WHERE attempt_id=${attempt.attemptId}`))).toEqual([{ state: "superseded", superseded_restore_id: "restore-m1" }]);
      const listed = await fixture.db.transaction(transaction => stops.listStoppableInTransaction(transaction));
      expect(listed.map(item => item.attemptId)).not.toContain(attempt.attemptId);
      // Once its cost is settled, the clear sends the supersession's end, so the kernel releases the attempt.
      const event = await fixture.db.transaction(transaction => stops.clearResolvedStopInTransaction(transaction, attempt.reservationId, now + 1));
      expect(event).toMatchObject({ kind: "attempt-stopped", id: `restore-m1:${attempt.attemptId}:usage-resolved`, commandId: attempt.attemptId, uncertain: false });
      const delivered = rows<{ event_id: string }>(await fixture.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${attempt.run.runId} AND event_id LIKE 'restore-m1:%' ORDER BY sequence`));
      expect(delivered.map(row => row.event_id)).toEqual([`restore-m1:${attempt.attemptId}:superseded`, `restore-m1:${attempt.attemptId}:usage-resolved`]);
    } finally {
      await fixture.db.execute(sql`UPDATE factory_installation SET execution_epoch=${epoch} WHERE tenant_id=${tenantId}`);
    }
  });

  test("with no sealed stop, the clear re-sends a signed restore's supersession event with its uncertainty cleared (W15f)", async () => {
    const attempt = await launchedAttempt(false);
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const epoch = Number(rows<{ execution_epoch: number | string }>(await fixture.db.execute(sql`SELECT execution_epoch FROM factory_executions WHERE attempt_id=${attempt.attemptId}`))[0]!.execution_epoch);
    const restoreDigest = `sha256:${"f".repeat(64)}`;
    const superseded = await fixture.db.transaction(transaction => supersedeEpochAttemptsInTransaction(transaction, inbox, { tenantId, previousEpoch: epoch, executionEpoch: epoch + 1, restoreId: "restore-w15f", restoreDigest, atMs: now }));
    expect(superseded).toBeGreaterThanOrEqual(1);
    expect(await executionStatus(attempt.attemptId)).toBe("superseded");
    // What a bound settlement reads as the attempt's proven end.
    expect(await fixture.db.transaction(transaction => readAttemptSupersessionInTransaction(transaction, tenantId, attempt.reservationId))).toMatchObject({
      projectId: attempt.dispatchReference.projectId, runId: attempt.run.runId, attemptId: attempt.attemptId, interpreterId: attempt.dispatchReference.interpreterId, restoreId: "restore-w15f", restoreDigest,
      event: { kind: "attempt-stopped", id: `restore-w15f:${attempt.attemptId}:superseded`, commandId: attempt.attemptId, uncertain: true },
    });
    const { stops } = harness(attempt, stopper(async () => { throw new Error("a superseded attempt is not stopped again"); }), acknowledger());
    const event = await fixture.db.transaction(transaction => stops.clearResolvedStopInTransaction(transaction, attempt.reservationId, now + 1));
    expect(event).toMatchObject({ kind: "attempt-stopped", id: `restore-w15f:${attempt.attemptId}:usage-resolved`, commandId: attempt.attemptId, atMs: now + 1, uncertain: false });
    const delivered = rows<{ event_id: string }>(await fixture.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${attempt.run.runId} AND interpreter_id=${attempt.dispatchReference.interpreterId} AND event_id LIKE 'restore-w15f:%' ORDER BY sequence`));
    expect(delivered.map(row => row.event_id)).toEqual([`restore-w15f:${attempt.attemptId}:superseded`, `restore-w15f:${attempt.attemptId}:usage-resolved`]);
    // A reservation with neither a stop nor a supersession still clears nothing.
    expect(await fixture.db.transaction(transaction => stops.clearResolvedStopInTransaction(transaction, "no-such-reservation", now + 2))).toBeUndefined();
  });

  // Joint W03f and W15f test, also last: it supersedes the epoch's live attempts in this shared store.
  test("W03f ruling B with W15f: an attempt a signed restore superseded settles at the reserved bound with the supersession as its proof, and W05b clears through it", async () => {
    const attempt = await launchedAttempt();
    const { journal, request } = await inFlightModelCall(attempt);
    const authority = await sealedAuthority(attempt);
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const held = harness(attempt, stopper(async () => { throw new Error("a superseded attempt is not stopped again"); }), acknowledger());
    await lifecycle.budgets.markUncertain({ projectId, runId: attempt.run.runId, reservationId: attempt.reservationId }, "execution_epoch_superseded");
    const hold = await heldFor(attempt);
    // Before the restore: no proof of the attempt's end, so the hold stays named and unsettled.
    expect(await reconcilerAt(attempt, held, authority.deadlineAt.getTime() + 1).resolve(hold)).toMatchObject({ kind: "unknown", reason: "no-sealed-attempt" });
    // The signed restore supersedes the epoch's live attempts, this one included, in one transaction.
    const restoreDigest = `sha256:${"7".repeat(64)}`;
    await fixture.db.transaction(transaction => supersedeEpochAttemptsInTransaction(transaction, inbox, { tenantId, previousEpoch: authority.executionEpoch, executionEpoch: authority.executionEpoch + 1, restoreId: "restore-w03f", restoreDigest, atMs: now }));
    expect(await executionStatus(attempt.attemptId)).toBe("superseded");
    // Before the deadline: named, and nothing settles.
    expect(await reconcilerAt(attempt, held, authority.deadlineAt.getTime() - 1).resolve(hold)).toEqual({ kind: "unknown", reservationId: attempt.reservationId, reason: "operation-not-settled", operationIds: [request.operationId] });
    // After it: bound, read through W15f's proof-gated read, and settled with the restore as proof.
    const late = reconcilerAt(attempt, held, authority.deadlineAt.getTime() + 1);
    const bound = await late.resolve(hold);
    expect(bound).toEqual({ kind: "bound", reservationId: attempt.reservationId, attemptId: attempt.attemptId, reason: "operation-not-settled", operationIds: [request.operationId] });
    const settled = await late.settleAtBound(bound as Extract<typeof bound, { kind: "bound" }>);
    expect(settled).toMatchObject({ source: "reserved-bound", basis: "unknown: charged at reserved bound; ended by restore supersession", restoreDigest, knownCostMicros: profile.budget.costMicros });
    expect(settled.stopReceiptDigest).toBeUndefined();
    // The budget carries the reserved bound; the settlement claims no measured token count.
    expect(JSON.parse((await reservationState(attempt.reservationId))!.actual!)).toEqual(reservedBound);
    expect(Object.keys(settled)).not.toContain("tokens");
    // W05b clears the kernel through the supersession's event, re-sent with its uncertainty cleared.
    const delivered = rows<{ event_id: string }>(await fixture.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE tenant_id=${tenantId} AND run_id=${attempt.run.runId} ORDER BY sequence`)).map(row => row.event_id);
    expect(delivered).toContain(`restore-w03f:${attempt.attemptId}:usage-resolved`);
    // A provider answer after the bound never settles again.
    const answer = { text: "late", providerReceiptDigest: "e".repeat(64), usage: { kind: "measured" as const, inputTokens: 1, outputTokens: 1, computeMs: 1, costMicros: "2" } };
    await journal.hold(attempt.request, request, answer).catch(() => undefined);
    await expect(late.reconcile({ reservationId: attempt.reservationId, attemptId: attempt.attemptId, operationId: request.operationId, providerReceiptDigest: answer.providerReceiptDigest, usage: answer.usage })).rejects.toMatchObject({ code: "factory_usage_settlement_state" });
    expect(await settlementRows(attempt.run.runId)).toEqual([{ revision: 1, source: "reserved-bound" }]);
  });

  test("W03f with W15f M1: a stop the restore left unconfirmed ends as superseded, and the bound rests on the restore, not a stop receipt", async () => {
    const attempt = await launchedAttempt();
    const { request } = await inFlightModelCall(attempt);
    const authority = await sealedAuthority(attempt);
    const { reference } = await cancelled(attempt);
    // The host never confirms: the stop stays uncertain and the reservation stays held.
    const held = harness(attempt, stopper(async () => { throw new Error("host unreachable"); }), acknowledger());
    expect((await held.stops.stop(service, reference)).state).toBe("uncertain");
    const inbox = new FactoryInbox(fixture.db, tenantId, () => now);
    const restoreDigest = `sha256:${"6".repeat(64)}`;
    await fixture.db.transaction(transaction => supersedeEpochAttemptsInTransaction(transaction, inbox, { tenantId, previousEpoch: authority.executionEpoch, executionEpoch: authority.executionEpoch + 1, restoreId: "restore-w03f-m1", restoreDigest, atMs: now }));
    expect(await stopRow(attempt.run.runId)).toMatchObject({ state: "superseded" });
    const late = reconcilerAt(attempt, held, authority.deadlineAt.getTime() + 1);
    const bound = await late.resolve(await heldFor(attempt));
    expect(bound).toEqual({ kind: "bound", reservationId: attempt.reservationId, attemptId: attempt.attemptId, reason: "operation-not-settled", operationIds: [request.operationId] });
    const settled = await late.settleAtBound(bound as Extract<typeof bound, { kind: "bound" }>);
    expect(settled).toMatchObject({ source: "reserved-bound", basis: "unknown: charged at reserved bound; ended by restore supersession", restoreDigest });
    expect(settled.stopReceiptDigest).toBeUndefined();
  });
}
