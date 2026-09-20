import { afterAll, beforeAll, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import type { FactoryGuestModelRequest, FactoryModelPin, FactoryRunnerRequest, JsonValue } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
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

const pin: FactoryModelPin = { provider: "anthropic", model: "claude-opus-5", configurationDigest: DIGEST, configuration: {}, policyDigest: DIGEST, policy: {} };

function authority(): FactoryAttemptAuthority {
  return { attemptId: "guest-model-attempt", tenantId: TENANT, projectId: PROJECT, runId: RUN, nodeInstanceId: NODE, candidateGeneration: 0, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, requestDigest: "a".repeat(64), deadlineAt: new Date(Date.now() + 600_000) };
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
  return { text: `answer ${index}`, providerReceiptDigest: `${index}`.padStart(64, "d"), usage: { kind: "measured", inputTokens: 3 + index, outputTokens: 5, computeMs: 7, costMicros: `${100 + index}` } };
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
  });

  afterAll(async () => { await fixture?.close(); });

  test("a guest model call settles on the journal before the guest is answered, and cannot be repeated", async () => {
    const db = fixture.db;
    const authorized: string[] = [];
    const journal = new FactoryExecutionJournal(db, async (_transaction, current) => { authorized.push(current.attemptId); });
    const attempt = authority();
    const request = runnerRequest(attempt);
    await journal.admit({ ...attempt, requestDigest: factoryRunnerRequestDigest(request), request });

    const checkpoints: string[] = [];
    let held: Promise<void> | undefined;
    let answers = 0;
    const instance = createFactoryGuestModelBroker({
      provider: { complete: async (guest) => { answers += 1; await held; return completionFor(guest.operationIndex); } },
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
    let release: (() => void) | undefined;
    held = new Promise<void>(resolve => { release = resolve; });
    const pending = instance.call(request, guestRequest(1));
    while (answers === 1) await Promise.resolve();
    expect(await instance.call(request, guestRequest(1))).toMatchObject({ status: "refused", refusal: { code: "operation_busy" } });
    release?.();
    expect((await pending).status).toBe("completed");
    held = undefined;

    // A provider failure settles the claim as failed rather than stranding it.
    const failing = createFactoryGuestModelBroker({
      provider: { complete: async () => { throw new Error("provider_not_configured"); } },
      journal: createFactoryJournalGuestModelJournal({ journal, workspace: { checkpoint: async () => { throw new Error("a refused call never checkpoints"); } } }),
    });
    expect(await failing.call(request, guestRequest(2))).toMatchObject({ status: "refused", refusal: { code: "provider_unavailable" } });
    const [failed] = releaseRows<{ state: string; usage_json: unknown }>(await db.execute(sql`SELECT state, usage_json FROM factory_execution_operations WHERE attempt_id=${attempt.attemptId} AND operation_id=${`${RUN}:${NODE}:0:2`}`));
    expect(failed?.state).toBe("failed");
    expect(failed?.usage_json).toBeNull();
  });
}
