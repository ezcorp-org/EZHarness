import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { FactoryGuestModelRequest, FactoryModelPin, FactoryRunnerRequest, FactoryRunnerResult, JsonValue } from "@ezcorp/factory-sdk";
import { validateFactoryRunnerResult } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { isFactoryProviderReceiptDigest, validateFactoryTerminalUsage } from "../../factory/journal-validation";
import { FactoryInbox } from "../../factory/inbox";
import { FactoryUsageReconciliation, FactoryUsageSettlements } from "../../factory/usage-settlement";
import type { MigrateDb, TransactionalDb } from "../../db/migrations/types";
import { releaseRows } from "../../db/queries/extension-releases";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import { createFactoryGuestModelBroker, type FactoryModelCompletion } from "../../factory/runner/guest-model-broker";
import { createFactoryJournalGuestModelJournal } from "../../factory/runner/guest-model-journal";

/**
 * The durable half of the guest model contract, proved on a real store.
 *
 * The refusals a guest sees for a busy or a settled operation are only as good
 * as the journal row behind them: an in-memory guard cannot refuse a caller in
 * another process, and the host supervisor and the product process are two
 * processes. So this runs the broker over `FactoryExecutionJournal` and reads
 * the rows back rather than trusting the answer the guest got.
 */

const DIGEST = `sha256:${"a".repeat(64)}`;
const TENANT = "guest-model-tenant";
const PROJECT = "guest-model-project";
const RUN = "guest-model-run";
const NODE = "guest-model-node";
const RESERVATION = "guest-model-reservation";
const ENVELOPE = "guest-model-envelope";
const TERMINAL_NODE = "guest-model-node-terminal";

const pin: FactoryModelPin = { provider: "anthropic", model: "claude-opus-5", configurationDigest: DIGEST, configuration: {}, policyDigest: DIGEST, policy: {} };

function authority(overrides: Partial<FactoryAttemptAuthority> = {}): FactoryAttemptAuthority {
  return { attemptId: "guest-model-attempt", tenantId: TENANT, projectId: PROJECT, runId: RUN, nodeInstanceId: NODE, candidateGeneration: 0, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAt: new Date(Date.now() + 600_000), ...overrides };
}

function runnerRequest(attempt: FactoryAttemptAuthority): FactoryRunnerRequest {
  return {
    schemaVersion: "factory.runner.request.v1",
    authority: { attemptId: attempt.attemptId, tenantId: attempt.tenantId, projectId: attempt.projectId, runId: attempt.runId, nodeInstanceId: attempt.nodeInstanceId, candidateGeneration: attempt.candidateGeneration, attemptNumber: attempt.attemptNumber, grantRevision: attempt.grantRevision, reservationGeneration: attempt.reservationGeneration, executionEpoch: attempt.executionEpoch, cancellationEpoch: attempt.cancellationEpoch, deadlineAtMs: attempt.deadlineAt.getTime(), nextOperationIndex: 0 },
    runner: { package: "runner", manifestName: "runner", version: "1", digest: DIGEST, export: "run" },
    input: { kind: "inline", value: { task: "answer" } },
    grants: [], resources: {}, model: pin, tools: [],
    broker: { attemptToken: "ephemeral-guest-model-token", audience: "gateway" },
  };
}

function guestRequest(index: number, overrides: Partial<FactoryGuestModelRequest> = {}): FactoryGuestModelRequest {
  return {
    schemaVersion: "factory.guest-model-request.v1",
    operationId: `${RUN}:${NODE}:0:${index}`,
    operationIndex: index,
    model: pin,
    messages: [{ role: "user", text: `turn ${index}` }],
    maxOutputTokens: 256,
    ...overrides,
  } as FactoryGuestModelRequest;
}

function completionFor(index: number): FactoryModelCompletion {
  // Bare 64-hex, exactly as `factoryProviderReceiptDigest` emits it and exactly
  // what a terminal result must mirror.
  return { text: `answer ${index}`, providerReceiptDigest: `${index}`.padStart(64, "d"), usage: { kind: "measured", inputTokens: 3 + index, outputTokens: 5, computeMs: 7, costMicros: `${100 + index}` } };
}

/** A promise plus the function that settles it, so a test awaits an OBSERVED event. */
function signal(): { readonly reached: Promise<void>; arrive: () => void } {
  let arrive: (() => void) | undefined;
  const reached = new Promise<void>(resolve => { arrive = resolve; });
  return { reached, arrive: () => arrive?.() };
}

export interface FactoryGuestModelJournalFixture {
  db: MigrateDb & TransactionalDb;
  close(): Promise<void>;
}

export function factoryGuestModelJournalConformance(createFixture: () => Promise<FactoryGuestModelJournalFixture>): void {
  let fixture: FactoryGuestModelJournalFixture;

  beforeAll(async () => {
    fixture = await createFixture();
    const db = fixture.db;
    await db.execute(sql`INSERT INTO projects(id, name, path) VALUES (${PROJECT}, 'Guest Model', '/tmp/guest-model')`);
    await db.execute(sql`INSERT INTO factory_installation(singleton, tenant_id, execution_epoch) VALUES (1, ${TENANT}, 1)`);
    await db.execute(sql`INSERT INTO factory_projects(tenant_id, project_id) VALUES (${TENANT}, ${PROJECT})`);
    await db.execute(sql`INSERT INTO factory_runs(tenant_id, project_id, run_id, definition_digest, interpreter_build, execution_epoch, request_digest, request_payload) VALUES (${TENANT}, ${PROJECT}, ${RUN}, ${DIGEST}, 'test', 1, 'request', '{}')`);
    // A real reservation in a settleable state, because the reconciliation path
    // settles the budget hold and refuses an unknown reservation.
    await db.execute(sql`INSERT INTO factory_budget_envelopes(tenant_id, project_id, run_id, envelope_id, request_digest, limits, allocated, spent, deadline_ms, state) VALUES (${TENANT}, ${PROJECT}, ${RUN}, ${ENVELOPE}, ${DIGEST}, '{}', '{}', '{}', 2000000000000, 'open')`);
    await db.execute(sql`INSERT INTO factory_budget_reservations(tenant_id, project_id, run_id, reservation_id, envelope_id, request_digest, amount, state) VALUES (${TENANT}, ${PROJECT}, ${RUN}, ${RESERVATION}, ${ENVELOPE}, ${DIGEST}, '{"costMicros":"1000"}', 'uncertain')`);
  });

  afterAll(async () => { await fixture?.close(); });

  test("a guest model call settles on the journal before the guest is answered, and cannot be repeated", async () => {
    const db = fixture.db;
    const authorized: string[] = [];
    const journal = new FactoryExecutionJournal(db, async (_transaction, current) => { authorized.push(current.attemptId); });
    const attempt = authority();
    const request = runnerRequest(attempt);
    // The durable authority carries the canonical request digest, which is what
    // every journal read fences on. The placeholder on `attempt` is not it.
    const sealed: FactoryAttemptAuthority = { ...attempt, requestDigest: factoryRunnerRequestDigest(request) };
    await journal.admit({ ...sealed, request });

    const checkpoints: string[] = [];
    let held: Promise<void> | undefined;
    let reachedProvider: { readonly reached: Promise<void>; arrive: () => void } | undefined;
    let answers = 0;
    const instance = createFactoryGuestModelBroker({
      provider: { complete: async (guest) => { answers += 1; reachedProvider?.arrive(); await held; return completionFor(guest.operationIndex); } },
      journal: createFactoryJournalGuestModelJournal({
        journal,
        workspace: { checkpoint: async (input) => { checkpoints.push(input.operationId); return { artifactId: `checkpoint-${input.operationIndex}`, digest: `sha256:${"c".repeat(64)}`, encodedBytes: 4, journalCursor: input.operationIndex }; } },
        authorizeAttempt: async () => { authorized.push("guard"); },
      }),
    });

    const first = await instance.call(request, guestRequest(0));
    expect(first).toMatchObject({ status: "completed", text: "answer 0", providerReceiptDigest: completionFor(0).providerReceiptDigest });
    expect(checkpoints).toEqual([`${RUN}:${NODE}:0:0`]);
    expect(authorized).toContain("guard");

    // The row is what W03c settles from, so it is read back rather than assumed.
    const [settled] = releaseRows<{ state: string; provider_receipt_digest: string; usage_json: unknown; kind: string }>(await db.execute(sql`SELECT state, kind, provider_receipt_digest, usage_json FROM factory_execution_operations WHERE attempt_id=${attempt.attemptId} AND operation_id=${`${RUN}:${NODE}:0:0`}`));
    expect(settled?.state).toBe("completed");
    expect(settled?.kind).toBe("model");
    expect(settled?.provider_receipt_digest).toBe(completionFor(0).providerReceiptDigest);
    const usage = typeof settled?.usage_json === "string" ? JSON.parse(settled.usage_json) as JsonValue : settled?.usage_json;
    expect(usage).toEqual(completionFor(0).usage as unknown as JsonValue);

    // A settled operation never calls a model again, in this process or any other.
    expect(await instance.call(request, guestRequest(0))).toMatchObject({ status: "refused", refusal: { code: "operation_settled" } });
    expect(answers).toBe(1);

    // A second caller while the first holds the claim is refused as busy.
    //
    // The arrival at the provider is AWAITED, never spun on. `journal.claim` is
    // a socket round trip on a real server, and a `while (…) await
    // Promise.resolve()` loop enqueues a fresh microtask every turn, so the
    // event loop never reaches its I/O phase and the query result can never
    // arrive. That spins at full CPU forever; it passed on PGlite only because
    // PGlite settles through microtasks.
    let release: (() => void) | undefined;
    held = new Promise<void>(resolve => { release = resolve; });
    reachedProvider = signal();
    const pending = instance.call(request, guestRequest(1));
    await reachedProvider.reached;
    expect(await instance.call(request, guestRequest(1))).toMatchObject({ status: "refused", refusal: { code: "operation_busy" } });
    release?.();
    expect((await pending).status).toBe("completed");
    held = undefined;

    // A completed call settles the ordinary way: the terminal result's usage is
    // the sum of its operations' measured usage, which is what the budget hold
    // settles on at stop. No receipt digest is involved in that path.
    // Read here, before the refusal cases below add operations with no measured
    // usage: a completed terminal requires EVERY journal operation to carry one.
    const evidence = await journal.operations(sealed);
    const completedModel = evidence.filter(operation => operation.state === "completed");
    expect(completedModel.map(operation => operation.operationId)).toEqual([`${RUN}:${NODE}:0:0`, `${RUN}:${NODE}:0:1`]);
    const summed = { kind: "measured" as const, inputTokens: 3 + 4, outputTokens: 10, computeMs: 14, costMicros: "201" };
    const terminal = {
      schemaVersion: "factory.runner.result.v1", status: "completed", journalCursor: 1,
      operations: completedModel.map(operation => ({ operationId: operation.operationId, operationIndex: operation.operationIndex, kind: operation.kind, requestDigest: operation.requestDigest, state: "completed", resultDigest: operation.resultDigest, usage: operation.usage, workspaceCheckpoint: operation.workspaceCheckpoint })),
      resultDigest: "e".repeat(64), output: { artifactId: "guest-model-output", digest: `sha256:${"e".repeat(64)}`, encodedBytes: 8 },
      usage: summed, workspaceCheckpoint: { artifactId: "checkpoint-1", digest: `sha256:${"c".repeat(64)}`, encodedBytes: 4, journalCursor: 1 },
    } as unknown as FactoryRunnerResult;
    expect(validateFactoryTerminalUsage(terminal, evidence)).toEqual({ ok: true });
    // A terminal usage that does not equal the sum of what the model calls cost
    // is refused, so the completed path cannot quietly under-report.
    expect(validateFactoryTerminalUsage({ ...terminal, usage: { ...summed, costMicros: "1" } } as unknown as FactoryRunnerResult, evidence).ok).toBe(false);


    // A provider failure settles the claim as failed rather than stranding it.
    const failing = createFactoryGuestModelBroker({
      provider: { complete: async () => { throw new Error("provider_not_configured"); } },
      journal: createFactoryJournalGuestModelJournal({ journal, workspace: { checkpoint: async () => { throw new Error("a refused call never checkpoints"); } } }),
    });
    expect(await failing.call(request, guestRequest(2))).toMatchObject({ status: "refused", refusal: { code: "provider_unavailable" } });
    const [failed] = releaseRows<{ state: string; usage_json: unknown }>(await db.execute(sql`SELECT state, usage_json FROM factory_execution_operations WHERE attempt_id=${attempt.attemptId} AND operation_id=${`${RUN}:${NODE}:0:2`}`));
    expect(failed?.state).toBe("failed");
    expect(failed?.usage_json).toBeNull();

    // A call whose provider outcome is lost leaves the operation UNCERTAIN with
    // the receipt and the cost retained, which is the only state the resolver
    // will consider.
    const lost = createFactoryGuestModelBroker({
      provider: { complete: async () => completionFor(3) },
      journal: createFactoryJournalGuestModelJournal({ journal, workspace: { checkpoint: async () => { throw new Error("the completed settlement was lost"); } } }),
    });
    const refused = await lost.call(request, guestRequest(3));
    expect(refused).toMatchObject({ status: "refused", refusal: { code: "provider_unavailable" } });
    expect((refused as { refusal: { message: string } }).refusal.message).toContain("held as uncertain for reconciliation");
    const [uncertain] = releaseRows<{ state: string; provider_receipt_digest: string; usage_json: unknown; result_digest: string | null; workspace_checkpoint: unknown }>(await db.execute(sql`SELECT state, provider_receipt_digest, usage_json, result_digest, workspace_checkpoint FROM factory_execution_operations WHERE attempt_id=${attempt.attemptId} AND operation_id=${`${RUN}:${NODE}:0:3`}`));
    expect(uncertain?.state).toBe("uncertain");
    expect(uncertain?.provider_receipt_digest).toBe(completionFor(3).providerReceiptDigest);
    // Nothing but the receipt and the cost, so `reconcileLate` matches it later.
    expect(uncertain?.result_digest).toBeNull();
    expect(uncertain?.workspace_checkpoint).toBeNull();

    // The real resolver settles it. The scope seam is the one the reconciliation
    // class declares so it need not depend on the stop store; everything else
    // here — the journal, the settlements, the reconciliation itself — is real.
    const settlements = new FactoryUsageSettlements(db, TENANT, new FactoryInbox(db, TENANT));
    const budgetSettlements: { costMicros: string; tokens: number; computeMs: number; receipt: string }[] = [];
    const reconciler = new FactoryUsageReconciliation(db, TENANT, {
      readSettlementScopeInTransaction: async () => ({ projectId: PROJECT, runId: RUN, interpreterId: "root", reservationId: RESERVATION, authority: sealed }),
    }, journal, {
      settleInTransaction: async (_transaction, _key, actual, receiptDigest) => { budgetSettlements.push({ ...actual, receipt: receiptDigest }); },
    }, settlements);

    const hold = { projectId: PROJECT, runId: RUN, reservationId: RESERVATION, envelopeId: ENVELOPE, heldCostMicros: "1000", uncertainty: "provider outcome lost", cursor: { createdAtMs: 1, runId: RUN, reservationId: RESERVATION } };
    const resolved = await reconciler.resolve(hold);
    expect(resolved).toEqual({
      kind: "resolved", reservationId: RESERVATION, attemptId: attempt.attemptId,
      operationId: `${RUN}:${NODE}:0:3`, providerReceiptDigest: completionFor(3).providerReceiptDigest,
      usage: completionFor(3).usage,
    });
    if (resolved.kind !== "resolved") throw new Error("the resolver did not settle the held operation");
    const facts = { reservationId: resolved.reservationId, attemptId: resolved.attemptId, operationId: resolved.operationId, providerReceiptDigest: resolved.providerReceiptDigest, usage: resolved.usage };
    const reconciled = await reconciler.reconcile(facts);
    expect(reconciled).toMatchObject({ source: "reconciliation", knownCostMicros: completionFor(3).usage.costMicros, providerReceiptDigest: completionFor(3).providerReceiptDigest });
    // W03d: the budget row records the SETTLEMENT digest, not the provider's.
    // The provider's is the C02 bare form and is not a digest of anything this
    // process computed, so it is carried inside the sealed settlement instead.
    expect(budgetSettlements).toHaveLength(1);
    expect(budgetSettlements[0]).toMatchObject({ costMicros: "103", tokens: 11, computeMs: 7 });
    expect(budgetSettlements[0]!.receipt).toBe(reconciled.settlementDigest);
    expect(reconciled.providerReceiptDigest).toBe(completionFor(3).providerReceiptDigest);
    // One receipt, one settlement: reconciling again returns the same row.
    expect(await reconciler.reconcile(facts)).toEqual(reconciled);
    expect(budgetSettlements).toHaveLength(1);
  });

  /**
   * An attempt that called a model can BOTH settle and complete.
   *
   * This is the check that broke when the receipt digest was prefixed, and it
   * broke silently in the two places that never meet in one test:
   * `verifyRunnerResultInTransaction` runs `validateFactoryRunnerResult`, which
   * requires an operation's receipt to be bare 64-hex, AND it requires the
   * terminal result's operations to MIRROR the journal evidence exactly. A
   * prefixed digest therefore made the row unsettleable or the attempt
   * uncompletable, and no test that looked at only one side could see it.
   */
  test("a terminal result for an attempt that called a model verifies against the journal", async () => {
    const db = fixture.db;
    const journal = new FactoryExecutionJournal(db, async () => {});
    const attempt = authority({ attemptId: "guest-model-attempt-terminal", nodeInstanceId: TERMINAL_NODE });
    const request = { ...runnerRequest(attempt) };
    const sealed: FactoryAttemptAuthority = { ...attempt, requestDigest: factoryRunnerRequestDigest(request) };
    await journal.admit({ ...sealed, request });

    const completion = completionFor(7);
    const instance = createFactoryGuestModelBroker({
      provider: { complete: async () => completion },
      journal: createFactoryJournalGuestModelJournal({
        journal,
        workspace: { checkpoint: async (input) => ({ artifactId: `terminal-checkpoint-${input.operationIndex}`, digest: `sha256:${"c".repeat(64)}`, encodedBytes: 4, journalCursor: input.operationIndex }) },
      }),
    });
    const answered = await instance.call(request, guestRequest(0, { operationId: `${RUN}:${TERMINAL_NODE}:0:0` }));
    expect(answered).toMatchObject({ status: "completed", providerReceiptDigest: completion.providerReceiptDigest });
    // The one definition of the form, not a regex written twice.
    expect(isFactoryProviderReceiptDigest(completion.providerReceiptDigest)).toBe(true);

    // The terminal result mirrors the journal evidence, which is the rule.
    const { operations, journalCursor } = await journal.evidence(sealed);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ state: "completed", kind: "model", providerReceiptDigest: completion.providerReceiptDigest });
    const output = { artifactId: "guest-model-terminal-output", digest: `sha256:${"e".repeat(64)}`, encodedBytes: 8 };
    const terminal = {
      schemaVersion: "factory.runner.result.v1", status: "completed", journalCursor,
      operations, resultDigest: "e".repeat(64), output,
      usage: completion.usage,
      workspaceCheckpoint: { artifactId: "terminal-checkpoint-0", digest: `sha256:${"c".repeat(64)}`, encodedBytes: 4, journalCursor },
    } as unknown as FactoryRunnerResult;

    // The SDK contract admits it, and so does the journal. Both, or neither.
    expect(validateFactoryRunnerResult(terminal)).toEqual({ ok: true });
    const verified = await db.transaction(transaction => journal.verifyRunnerResultInTransaction(transaction, sealed, terminal));
    expect(verified.journalCursor).toBe(journalCursor);
    expect(verified.operations).toHaveLength(1);
    expect(verified.terminalResultDigest).toMatch(/^sha256:[a-f0-9]{64}$/);

    // The controlled fault: the SAME result with the receipt prefixed, which is
    // what this leaf used to write, is refused. That is the round-2 break.
    const prefixed = { ...terminal, operations: [{ ...operations[0], providerReceiptDigest: `sha256:${completion.providerReceiptDigest}` }] } as unknown as FactoryRunnerResult;
    expect(validateFactoryRunnerResult(prefixed).ok).toBe(false);
    await expect(db.transaction(transaction => journal.verifyRunnerResultInTransaction(transaction, sealed, prefixed))).rejects.toThrow("RUNNER_OPERATION");
  });
}
