import { expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import { pg_trgm } from "@electric-sql/pglite/contrib/pg_trgm";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { PodmanRunner, buildLimits, filesDigest } from "@ezcorp/extension-runner";
import { provision } from "../../../packages/@ezcorp/extension-runner/tests/helpers";
import type { FactoryModelPin, FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import { migrate } from "../../db/migrate";
import * as schema from "../../db/schema";
import { releaseRows } from "../../db/queries/extension-releases";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../executions";
import type { FactoryPreparedPackageReceipt } from "../package-preparation";
import type { PoolLease } from "../pool/ledger";
import {
  FactoryDatabaseAttemptLaunchStore,
  IsolatedFactoryAttemptRuntime,
  IsolatedFactoryTrustedRunner,
  signFactoryPhysicalStopReceipt,
  type FactoryAttemptLease,
  type FactoryUnsignedPhysicalStopReceipt,
} from "./attempt-runtime";
import { createFactoryGuestModelBroker } from "./guest-model-broker";
import { createFactoryJournalGuestModelJournal } from "./guest-model-journal";
import { createFactoryOneHopProvider } from "./provider-one-hop";
import { createFactoryTranscriptBroker, factoryTranscriptModel, loadFactoryRecordedTranscript } from "../../__tests__/helpers/factory-guest-model-transcript";

const raw = "b".repeat(64);
const digest = `sha256:${raw}`;
const tenantId = "tenant-model-guest", projectId = "project-model-guest", runId = "run-model-guest";
const attemptId = "factory-model-attempt:guest";
const nodeInstanceId = "factory-model-node:guest";
const deadlineAtMs = Date.now() + 600_000;

const pin: FactoryModelPin = { provider: "anthropic", model: "claude-opus-5", configurationDigest: digest, configuration: { temperature: 0 }, policyDigest: digest, policy: { tools: false } };

const request: FactoryRunnerRequest = {
  schemaVersion: "factory.runner.request.v1",
  authority: { attemptId, tenantId, projectId, runId, nodeInstanceId, candidateGeneration: 0, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, deadlineAtMs, nextOperationIndex: 0 },
  runner: { package: "model-guest", manifestName: "model-guest", version: "1.0.0", digest, export: "run", configurationDigest: digest },
  input: { kind: "inline", value: { task: "summarise" } },
  grants: [], resources: {}, model: pin, tools: [],
  broker: { audience: "gateway", attemptToken: "durable-model-admission" },
};
const authority: FactoryAttemptAuthority = { attemptId, tenantId, projectId, runId, nodeInstanceId, candidateGeneration: 0, attemptNumber: 1, grantRevision: 1, reservationGeneration: 1, executionEpoch: 1, cancellationEpoch: 0, requestDigest: factoryRunnerRequestDigest(request), deadlineAt: new Date(deadlineAtMs) };
const lease: FactoryAttemptLease = { reservationId: "factory-reservation:model", grantRevision: 1, allocationGeneration: 1, holderGeneration: 1, allocationToken: "model-allocation", hostId: "host-model-guest" };
const renewedLease: PoolLease = { ...lease, tenantId, fence: "model-fence", deadlineAt: new Date(deadlineAtMs), resources: {} };
const prepared: FactoryPreparedPackageReceipt = { projectId, reference: request.runner, trustRevision: 1, packageTrustDigest: digest, releaseDigest: digest, sourceDigest: digest, artifactDigest: raw, imageDigest: digest, manifestDigest: digest, evidenceDigest: digest, buildIdentity: "build-model-guest", receiptDigest: digest };
const hostKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const signStopReceipt = async (receipt: FactoryUnsignedPhysicalStopReceipt) => signFactoryPhysicalStopReceipt(receipt, "model-host-key", hostKeys.privateKey);

/**
 * The guest program shape W10's generator and reviewer and W11's evaluator
 * implement, as a real program rather than a description.
 *
 * It reads its pin and its journalled operation identity off the request it was
 * handed, sends one `FactoryGuestModelRequest` over the one reverse capability,
 * and reads back one `FactoryGuestModelResponse`. It never names a model of its
 * own, never retries, and treats a refusal as an outcome rather than an error.
 */
const GUEST_PROGRAM = `import { defineExtension, serve } from '@ezcorp/sdk/v4';

interface ModelPin { provider: string; model: string; configurationDigest: string; configuration: Record<string, unknown>; policyDigest: string; policy: Record<string, unknown> }
interface Authority { runId: string; nodeInstanceId: string; candidateGeneration: number; nextOperationIndex: number }
interface AttemptRequest { authority: Authority; model?: ModelPin }
interface GuestMessage { role: 'system' | 'user' | 'assistant'; text: string }
interface GuestAnswer { status: string; operationId: string; text?: string; providerReceiptDigest?: string; refusal?: { code: string; message: string } }

const manifest = {
  schemaVersion: 4 as const, name: 'factory-model-guest', version: '1.0.0', author: { name: 'factory' },
  description: 'isolated guest that reaches its pinned model through the one broker seam', permissions: {},
  tools: [{ name: 'run', description: 'call the pinned model', inputSchema: { type: 'object' }, outputSchema: { type: 'object' } }],
};

await serve(defineExtension({ manifest, tools: { run: async (input, context) => {
  const attempt = input as unknown as AttemptRequest;
  const pin = attempt.model;
  if (!pin) throw new Error('This attempt has no model pin, so it may not call a model.');
  const operationId = (at: number) => attempt.authority.runId + ':' + attempt.authority.nodeInstanceId + ':' + attempt.authority.candidateGeneration + ':' + at;
  const ask = async (model: ModelPin, messages: GuestMessage[], at: number): Promise<GuestAnswer> =>
    await context.call('factory.broker', {
      schemaVersion: 'factory.guest-model-request.v1',
      operationId: operationId(at), operationIndex: at, model, messages, maxOutputTokens: 1024,
    }) as unknown as GuestAnswer;

  const messages: GuestMessage[] = [
    { role: 'system', text: 'Answer exactly what was asked.' },
    { role: 'user', text: 'Summarise the staged diff.' },
  ];
  const at = attempt.authority.nextOperationIndex;
  const answered = await ask(pin, messages, at);
  const repeated = await ask(pin, messages, at);
  const foreign = await ask({ ...pin, model: 'some-other-model' }, messages, at + 1);
  await context.call('factory.broker', { kind: 'guest-model-report', outcomes: [
    { name: 'answered', status: answered.status, text: answered.text ?? null, receipt: answered.providerReceiptDigest ?? null, code: answered.refusal ? answered.refusal.code : null },
    { name: 'repeated', status: repeated.status, text: repeated.text ?? null, receipt: repeated.providerReceiptDigest ?? null, code: repeated.refusal ? repeated.refusal.code : null },
    { name: 'foreign', status: foreign.status, text: foreign.text ?? null, receipt: foreign.providerReceiptDigest ?? null, code: foreign.refusal ? foreign.refusal.code : null },
  ] });
  return { schemaVersion: 'factory.runner.result.v1', status: 'cancelled', journalCursor: 0, operations: [] };
} } }));`;

type Outcome = { name: string; status: string; text: string | null; receipt: string | null; code: string | null };

/**
 * A real sandboxed guest reaches its pinned model and the cost lands on the journal.
 *
 * Everything either side of the provider is real: rootless Podman in the
 * shipped isolation profile, the FIFO control channel, the one broker seam,
 * the stream-to-one-hop adapter, and `FactoryExecutionJournal` on a migrated
 * store. Only the provider is a double, and it replays a transcript that
 * declares itself a fixture rather than inventing an answer.
 */
test("a real isolated guest calls its pinned model once, is refused twice, and leaves one settled cost", async () => {
  const root = await mkdtemp(join(tmpdir(), "factory-model-guest-"));
  const database = new PGlite({ extensions: { vector, pg_trgm } });
  const runner = new PodmanRunner({ root, ...await provision() });
  try {
    await database.waitReady;
    const db = drizzle(database, { schema });
    await migrate(db);
    await db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId},'Model guest','/tmp/model-guest')`);
    await db.execute(sql`INSERT INTO factory_installation(singleton,tenant_id,execution_epoch) VALUES (1,${tenantId},1)`);
    await db.execute(sql`INSERT INTO factory_projects(tenant_id,project_id) VALUES (${tenantId},${projectId})`);
    await db.execute(sql`INSERT INTO factory_runs(tenant_id,project_id,run_id,definition_digest,interpreter_build,execution_epoch,request_digest,request_payload) VALUES (${tenantId},${projectId},${runId},${digest},'model-guest',1,${digest},'{}')`);

    const journal = new FactoryExecutionJournal(db, async () => {});
    expect(await journal.admit({ ...authority, request })).toMatchObject({ reused: false });

    const files = {
      "extension.ts": GUEST_PROGRAM,
      "feature.test.ts": "import {expect,test} from 'bun:test';test('model guest source',()=>expect(true).toBe(true));",
    };
    const build = await runner.build({ operationId: "model-guest-build", sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
    if (build.state !== "succeeded") throw new Error(`isolated model guest build failed: ${build.diagnostics.map(diagnostic => diagnostic.code).join(",")}`);
    if (!build.artifactDigest) throw new Error("isolated model guest artifact was not built");
    const guestPrepared = { ...prepared, artifactDigest: build.artifactDigest };

    const transcript = await loadFactoryRecordedTranscript(join(import.meta.dir, "fixtures"));
    const provider = createFactoryTranscriptBroker(transcript);
    const reports: { kind: string; outcomes: Outcome[] }[] = [];
    const checkpoints: string[] = [];
    const broker = createFactoryGuestModelBroker({
      provider: createFactoryOneHopProvider({ broker: provider, resolveModel: factoryTranscriptModel }),
      journal: createFactoryJournalGuestModelJournal({
        journal,
        workspace: { checkpoint: async (input) => { checkpoints.push(input.operationId); return { artifactId: `model-checkpoint-${input.operationIndex}`, digest, encodedBytes: 4, journalCursor: input.operationIndex }; } },
      }),
      delegate: { invoke: async (_attempt, payload) => { reports.push(payload as (typeof reports)[number]); return { accepted: true }; } },
    });

    const tokens: string[] = [];
    const runtime = new IsolatedFactoryAttemptRuntime({
      runner,
      launches: new FactoryDatabaseAttemptLaunchStore(db),
      pool: { acknowledgeStart: async () => renewedLease, renew: async () => renewedLease },
      broker,
      signStopReceipt,
      readiness: { assertDispatchReady: async () => guestPrepared },
      presentStopReceipt: async () => {},
      mintAttemptToken: async () => { const token = `minted-model-token-${tokens.length + 1}`; tokens.push(token); return token; },
    });
    const trusted = new IsolatedFactoryTrustedRunner(runtime, { lease: async () => lease, preparedPackage: async () => guestPrepared }, { assertDispatchReady: async () => guestPrepared });

    expect(await trusted.run(request)).toEqual({ schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: 0, operations: [] });

    // The guest reported three outcomes over the same one reverse capability.
    expect(reports).toHaveLength(1);
    expect(reports[0]!.kind).toBe("guest-model-report");
    const outcomes = new Map(reports[0]!.outcomes.map(outcome => [outcome.name, outcome]));

    // One real call, answered from the recorded turn.
    expect(outcomes.get("answered")).toMatchObject({ status: "completed", text: "One export was renamed and one test was added." });
    expect(outcomes.get("answered")!.receipt).toMatch(/^[a-f0-9]{64}$/);
    expect(provider.replayed).toEqual(["summarise-the-staged-diff"]);

    // The same operation cannot be called twice, and a model other than the pin
    // is refused before the provider is reached.
    expect(outcomes.get("repeated")).toMatchObject({ status: "refused", code: "operation_settled", text: null, receipt: null });
    expect(outcomes.get("foreign")).toMatchObject({ status: "refused", code: "model_pin_mismatch", text: null, receipt: null });

    // Exactly one operation exists on the journal, and it carries the cost.
    const rows = releaseRows<{ operation_id: string; state: string; kind: string; provider_receipt_digest: string; usage_json: unknown }>(await db.execute(sql`SELECT operation_id, state, kind, provider_receipt_digest, usage_json FROM factory_execution_operations WHERE attempt_id=${attemptId} ORDER BY operation_index`));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ operation_id: `${runId}:${nodeInstanceId}:0:0`, state: "completed", kind: "model" });
    expect(rows[0]!.provider_receipt_digest).toBe(outcomes.get("answered")!.receipt!);
    const usage = typeof rows[0]!.usage_json === "string" ? JSON.parse(rows[0]!.usage_json as string) : rows[0]!.usage_json;
    // The provider's own counters, and its cost carried in micros rather than a float.
    expect(usage).toMatchObject({ kind: "measured", inputTokens: 137, outputTokens: 42, costMicros: "2100" });
    expect(checkpoints).toEqual([`${runId}:${nodeInstanceId}:0:0`]);

    // The guest ran under a freshly minted token, never the durable placeholder.
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).not.toBe(request.broker.attemptToken);
  } finally {
    await runner.close().catch(() => undefined);
    await database.close().catch(() => undefined);
    await rm(root, { recursive: true, force: true }).catch(() => undefined);
  }
}, 900_000);
