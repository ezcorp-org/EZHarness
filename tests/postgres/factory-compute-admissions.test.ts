import { createSign, generateKeyPairSync, randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, test } from "bun:test";
import type { SQL } from "bun";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { certificates } from "../../src/__tests__/helpers/factory-certificates";
import type { MigrationDb, TransactionalDb } from "../../src/db/migrations/types";
import { releaseRows as rows } from "../../src/db/queries/extension-releases";
import { FactoryBudgets } from "../../src/factory/budgets";
import { type FactoryAuthorizedCommand, type FactoryCommandAuthority, FactoryCommandAuthorityError } from "../../src/factory/command-authority";
import { FactoryComputeAdmissions } from "../../src/factory/compute-admissions";
import { FactoryInbox } from "../../src/factory/inbox";
import { FactoryCommandOutbox } from "../../src/factory/outbox";
import { createPoolAdmissionClient, type PoolAdmissionClient } from "../../src/factory/pool/client";
import { PoolAdmissionService } from "../../src/factory/pool/service";
import { startBunPoolAdmissionHttps } from "../../src/factory/pool/service-server";
import { FactoryRecords } from "../../src/factory/records";
import { factoryTaskReservationId, type FactoryComputeAdmissionRequest } from "../../src/factory/task-admission";
import { factoryReservationIdForOrigin, type FactoryAdmissionOrigin, type FactoryProtectedValidatorOrigin } from "../../src/factory/admission-origin";
import type { FactoryAuthorizedAcceptanceCommand, FactoryAuthorizedAdmissionCommand } from "../../src/factory/command-authority";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "../../src/factory/trusted-command-gateway";
import { setupFactoryPoolPostgres } from "./helpers/factory-pool-database";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

const tenantId = "compute-http-tenant";
const projectId = "compute-http-project";
const serviceIdentity = { tenantId, subject: "orchestration" } as const;
const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");

function serviceToken(): string {
  const input = `${encode({ alg: "RS256", kid: "compute-test" })}.${encode({ sub: tenantId, iss: "factory-test", aud: "factory-pool", exp: Math.floor(Date.now() / 1_000) + 300, scope: [`pool:tenant:${tenantId}`, `pool:grant:${tenantId}:factory`] })}`;
  const signer = createSign("RSA-SHA256"); signer.update(input); signer.end();
  return `${input}.${signer.sign(keys.privateKey).toString("base64url")}`;
}

class ProductAuthority {
  readonly contexts = new Map<string, FactoryAuthorizedCommand>();
  readonly acceptances = new Map<string, FactoryAuthorizedAcceptanceCommand>();
  readonly inactive = new Set<string>();
  constructor(readonly database: TransactionalDb, readonly tenantId: string) {}
  assertService(value: TrustedFactoryServiceIdentity): void {
    if (value.tenantId !== tenantId || value.subject !== serviceIdentity.subject) throw new FactoryCommandAuthorityError("factory_command_forbidden");
  }
  async withCurrent<Result>(value: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference, work: (transaction: MigrationDb, context: FactoryAuthorizedCommand) => Promise<Result>): Promise<Result> {
    this.assertService(value);
    const context = this.contexts.get(reference.commandId);
    if (!context || this.inactive.has(reference.commandId)) throw new FactoryCommandAuthorityError("factory_command_stale");
    return this.database.transaction(transaction => work(transaction, context));
  }
  /** Mirrors the real router: a validator origin is authorized by its acceptance command. */
  async withCurrentAdmission<Result>(value: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference, origin: FactoryAdmissionOrigin | undefined, work: (transaction: MigrationDb, context: FactoryAuthorizedAdmissionCommand) => Promise<Result>): Promise<Result> {
    if (origin?.kind !== "protected-validator") return this.withCurrent(value, reference, work);
    this.assertService(value);
    const acceptance = this.acceptances.get(reference.commandId);
    if (!acceptance || this.inactive.has(reference.commandId)) throw new FactoryCommandAuthorityError("factory_command_stale");
    return this.database.transaction(transaction => work(transaction, acceptance));
  }
}

let product: Awaited<ReturnType<typeof setupFactoryPostgres>>;
let poolDatabase: SQL;
let closePool: () => Promise<void>;
let server: Awaited<ReturnType<typeof startBunPoolAdmissionHttps>>;
let poolClient: PoolAdmissionClient;
let authority: ProductAuthority;
let now: number;
let directory: string;

beforeAll(async () => {
  product = await setupFactoryPostgres();
  const records = new FactoryRecords(product.db, tenantId);
  await records.bindInstallation();
  await product.db.execute(sql`INSERT INTO projects(id,name,path) VALUES (${projectId}, 'Compute HTTP project', '/tmp/compute-http-project')`);
  await product.db.execute(sql`INSERT INTO users(id,email,password_hash,name) VALUES ('compute-http-user', 'compute-http@example.test', 'not-a-login', 'Compute HTTP user')`);
  await records.bindProject(projectId);
  authority = new ProductAuthority(product.db, tenantId);
  const poolFixture = await setupFactoryPoolPostgres();
  poolDatabase = poolFixture.client; closePool = poolFixture.close;
  const poolService = new PoolAdmissionService(poolDatabase);
  const directories: string[] = [];
  const certs = await certificates(directories); directory = directories[0]!;
  const tokenPath = join(directory, "compute.token");
  await writeFile(tokenPath, serviceToken(), { mode: 0o600 });
  server = await startBunPoolAdmissionHttps({
    tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca },
    identities: { tenants: { "tenant-a": { tenantId, tokenSubject: tenantId } }, supervisors: {} },
    tokens: { issuer: "factory-test", audience: "factory-pool", publicKeys: { "compute-test": keys.publicKey.export({ type: "pkcs1", format: "pem" }).toString() } },
    service: poolService,
  });
  // Four units for the dispatch-node cases, which hold theirs for the whole
  // file, plus headroom for the validator case. No assertion here depends on
  // scarcity; the queued results come from scheduling order, not exhaustion.
  await poolService.ledger.configureCapacity("cpu", 6);
  poolClient = await createPoolAdmissionClient({ baseUrl: server.url, serverName: "localhost", requestTimeoutMs: 5_000, tenantId, tls: { caPath: join(directory, "ca.pem"), certificatePath: join(directory, "client.pem"), privateKeyPath: join(directory, "client.key"), serviceTokenPath: tokenPath } });
});

afterAll(async () => {
  server?.stop();
  await Promise.allSettled([product?.close(), closePool?.(), directory ? rm(directory, { recursive: true, force: true }) : Promise.resolve()]);
});

async function enlisted(label: string, client: PoolAdmissionClient = poolClient) {
  const runId = `compute-http-${label}-${randomUUID()}`;
  now = Date.now();
  const records = new FactoryRecords(product.db, tenantId);
  await records.createRun({ projectId, runId, definitionDigest: `sha256:${"a".repeat(64)}`, interpreterBuild: "compute-http-build", executionEpoch: 1, principalId: "compute-http-user", input: {} }, async () => {});
  const fence = { tenantId, projectId, runId, executionEpoch: 1, cancellationEpoch: 0, grantRevision: 1, revision: 1, deadlineAtMs: now + 120_000, definitionDigest: `sha256:${"a".repeat(64)}`, status: "queued" } as const;
  const command = { kind: "request-admission", id: `admit-${runId}`, nodeId: "task-node", candidateGeneration: 0, deadlineAtMs: now + 60_000 } as const;
  const context = { command, node: { id: "task-node", kind: "task", runner: { package: "runner", manifestName: "runner", version: "1", export: "run", digest: `sha256:${"b".repeat(64)}` } }, state: { nodes: { "task-node": { attempts: [{ attempt: 1 }] } } }, fence } as unknown as FactoryAuthorizedCommand;
  const reference = { tenantId, projectId, logicalRunId: runId, interpreterId: "root", commandId: command.id };
  authority.contexts.set(command.id, context);
  const reservationId = factoryTaskReservationId(reference, context);
  const input: FactoryComputeAdmissionRequest = { schemaVersion: "factory.compute-admission.v1", reference, fence, budget: { costMicros: "5", tokens: 6, computeMs: 7 }, memoryBytes: 128, request: { reservationId, grantRevision: 1, grantScope: `${tenantId}:factory`, resources: { cpu: 1 }, admissionDeadline: new Date(command.deadlineAtMs).toISOString() } };
  const budgets = new FactoryBudgets(product.db, tenantId, async () => {}, () => now);
  await budgets.openEnvelope({ projectId, runId, envelopeId: "root", limits: { maxCostMicros: "10", maxTokens: 10, maxComputeMs: 10 }, deadlineAtMs: now + 120_000 });
  const admissions = new FactoryComputeAdmissions(product.db, tenantId, authority as unknown as FactoryCommandAuthority, budgets, new FactoryInbox(product.db, tenantId, () => now), client, () => now);
  await budgets.reserve({ projectId, runId, envelopeId: "root", reservationId, amount: input.budget, computeRequest: input }, async (transaction, request) => {
    await admissions.enlistInTransaction(transaction, request.computeRequest as FactoryComputeAdmissionRequest);
    await new FactoryCommandOutbox(product.db, tenantId, projectId, () => now, "pool").enqueueInTransaction(transaction, { kind: "compute_admission", projectId, logicalRunId: runId, reservationId, body: request.computeRequest });
  });
  return { runId, commandId: command.id, reservationId, input, admissions };
}

test("product dispatcher recovers exact pool HTTPS leases across queueing, lost responses, races, and authority loss", async () => {
  const queued = await enlisted("queued");
  await poolClient.status(queued.reservationId);
  expect(await queued.admissions.dispatchNext(serviceIdentity)).toMatchObject({ status: "queued", reservationId: queued.reservationId });
  now += 1_001;
  const admitted = await queued.admissions.pollNext(serviceIdentity);
  expect(admitted).toMatchObject({ status: "admitted", receipt: { lease: { reservationId: queued.reservationId, tenantId, allocationGeneration: 1 }, event: { commandId: queued.commandId, granted: true } } });
  expect(await product.db.transaction(transaction => queued.admissions.readAdmittedInTransaction(transaction, { projectId, runId: queued.runId, reservationId: queued.reservationId }))).toEqual({ request: queued.input, receipt: (admitted as Extract<typeof admitted, { status: "admitted" }>).receipt });
  expect(await poolClient.status(queued.reservationId)).toMatchObject({ state: "held", allocationGeneration: 1 });

  let lose = true;
  const lossy = { ...poolClient, async request(input: FactoryComputeAdmissionRequest["request"], signal?: AbortSignal) { const result = await poolClient.request(input, signal); if (lose) { lose = false; throw new Error("simulated lost response"); } return result; } };
  const lost = await enlisted("lost", lossy);
  expect(await lost.admissions.dispatchNext(serviceIdentity)).toMatchObject({ status: "retry" });
  now += 1_001;
  expect(await lost.admissions.recover(serviceIdentity, { projectId, runId: lost.runId, reservationId: lost.reservationId })).toMatchObject({ status: "admitted", receipt: { lease: { reservationId: lost.reservationId, allocationToken: expect.any(String) } } });

  const raced = await enlisted("raced");
  expect(await raced.admissions.dispatchNext(serviceIdentity)).toMatchObject({ status: "queued" });
  now += 1_001;
  const competing = await Promise.all([raced.admissions.pollNext(serviceIdentity), raced.admissions.pollNext(serviceIdentity)]);
  expect(competing.filter(result => result.status === "admitted")).toHaveLength(1);
  expect(competing.filter(result => result.status === "idle")).toHaveLength(1);

  let revokeCommand = "";
  const revoking = { ...poolClient, async request(input: FactoryComputeAdmissionRequest["request"], signal?: AbortSignal) { const result = await poolClient.request(input, signal); if (result.status === "admitted") authority.inactive.add(revokeCommand); return result; } };
  const revoked = await enlisted("revoked", revoking); revokeCommand = revoked.commandId;
  expect(await revoked.admissions.dispatchNext(serviceIdentity)).toMatchObject({ status: "queued" });
  now += 1_001;
  expect(await revoked.admissions.pollNext(serviceIdentity)).toMatchObject({ status: "cancelling", reservationId: revoked.reservationId });
  expect(await poolClient.status(revoked.reservationId)).toMatchObject({ state: "revoking" });
  expect(rows<{ state: string }>(await product.db.execute(sql`SELECT state FROM factory_budget_reservations WHERE run_id=${revoked.runId} AND reservation_id=${revoked.reservationId}`))).toEqual([{ state: "held" }]);

  const persisted = await queued.admissions.recover(serviceIdentity, { projectId, runId: queued.runId, reservationId: queued.reservationId });
  expect(persisted).toEqual(admitted);
  expect(rows(await product.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${queued.runId}`))).toHaveLength(1);
});

test("a protected validator reaches a real pool lease through its acceptance command and tells no kernel node", async () => {
  const runId = `compute-http-validator-${randomUUID()}`;
  now = Date.now();
  const records = new FactoryRecords(product.db, tenantId);
  await records.createRun({ projectId, runId, definitionDigest: `sha256:${"a".repeat(64)}`, interpreterBuild: "compute-http-build", executionEpoch: 1, principalId: "compute-http-user", input: {} }, async () => {});
  const fence = { tenantId, projectId, runId, executionEpoch: 1, cancellationEpoch: 0, grantRevision: 1, revision: 1, deadlineAtMs: now + 120_000, definitionDigest: `sha256:${"a".repeat(64)}`, status: "queued" } as const;
  const acceptanceCommandId = `accept-${runId}`;
  const reference = { tenantId, projectId, logicalRunId: runId, interpreterId: "root", commandId: acceptanceCommandId };
  const command = { kind: "request-acceptance", id: acceptanceCommandId, nodeId: "acceptance-node", candidateGeneration: 0, deadlineAtMs: now + 60_000 } as const;
  authority.acceptances.set(acceptanceCommandId, { command, fence } as unknown as FactoryAuthorizedAcceptanceCommand);
  const origin: FactoryProtectedValidatorOrigin = {
    schemaVersion: "factory.admission-origin.v1", kind: "protected-validator", acceptanceCommandId,
    candidate: { projectId, runId, nodeInstanceId: "task-node", candidateGeneration: 0 },
    validatorIds: ["claim-one", "claim-two"], validatorLockDigest: `sha256:${"c".repeat(64)}`, executionProfileDigest: `sha256:${"d".repeat(64)}`,
  };
  const reservationId = factoryReservationIdForOrigin(reference, origin);
  const input: FactoryComputeAdmissionRequest = { schemaVersion: "factory.compute-admission.v1", reference, fence, budget: { costMicros: "1", tokens: 1, computeMs: 1 }, memoryBytes: 128, origin, request: { reservationId, grantRevision: 1, grantScope: `${tenantId}:factory`, resources: { cpu: 1 }, admissionDeadline: new Date(command.deadlineAtMs).toISOString() } };
  const budgets = new FactoryBudgets(product.db, tenantId, async () => {}, () => now);
  await budgets.openEnvelope({ projectId, runId, envelopeId: "root", limits: { maxCostMicros: "10", maxTokens: 10, maxComputeMs: 10 }, deadlineAtMs: now + 120_000 });
  const admissions = new FactoryComputeAdmissions(product.db, tenantId, authority as unknown as FactoryCommandAuthority, budgets, new FactoryInbox(product.db, tenantId, () => now), poolClient, () => now);
  await budgets.reserve({ projectId, runId, envelopeId: "root", reservationId, amount: input.budget, computeRequest: input }, async (transaction, request) => {
    await admissions.enlistInTransaction(transaction, request.computeRequest as FactoryComputeAdmissionRequest);
    await new FactoryCommandOutbox(product.db, tenantId, projectId, () => now, "pool").enqueueInTransaction(transaction, { kind: "compute_admission", projectId, logicalRunId: runId, reservationId, body: request.computeRequest });
  });

  // The identity is the claim set, so a repeat enlists onto the same row.
  expect(await product.db.transaction(transaction => admissions.enlistInTransaction(transaction, input))).toEqual({ created: false });
  expect(rows(await product.db.execute(sql`SELECT reservation_id FROM factory_compute_admissions WHERE run_id=${runId} AND origin_kind='protected-validator'`))).toHaveLength(1);

  await poolClient.status(reservationId);
  expect(await admissions.dispatchNext(serviceIdentity)).toMatchObject({ status: "queued", reservationId });
  // The pool schedules between polls, so count polls rather than waiting on a
  // clock: the admission must land within a small bounded number of rounds.
  let result = await admissions.pollNext(serviceIdentity);
  for (let round = 0; round < 5 && result.status !== "admitted"; round += 1) {
    now += 1_001;
    result = await admissions.pollNext(serviceIdentity);
  }
  expect(result).toMatchObject({ status: "admitted", reservationId });
  if (result.status !== "admitted") throw new Error("expected an admitted validator reservation");
  expect(result.receipt.event).toBeUndefined();
  expect(result.receipt.lease).toMatchObject({ reservationId, tenantId, allocationGeneration: 1 });
  // No kernel node exists, so nothing was told and nothing was stored.
  expect(rows(await product.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${runId}`))).toEqual([]);
  expect(rows(await product.db.execute(sql`SELECT event_json FROM factory_compute_admissions WHERE run_id=${runId} AND reservation_id=${reservationId}`))).toEqual([{ event_json: null }]);
  expect(rows(await product.db.execute(sql`SELECT state FROM factory_budget_reservations WHERE run_id=${runId} AND reservation_id=${reservationId}`))).toEqual([{ state: "running" }]);
  expect(await poolClient.status(reservationId)).toMatchObject({ state: "held", allocationGeneration: 1 });

  // A restart recovers the same sealed result and still emits nothing.
  const restarted = new FactoryComputeAdmissions(product.db, tenantId, authority as unknown as FactoryCommandAuthority, budgets, new FactoryInbox(product.db, tenantId, () => now), poolClient, () => now);
  expect(await restarted.recover(serviceIdentity, { projectId, runId, reservationId })).toEqual(result);
  expect(rows(await product.db.execute(sql`SELECT event_id FROM factory_inbox_events WHERE run_id=${runId}`))).toEqual([]);
  const material = await product.db.transaction(transaction => restarted.readAdmittedInTransaction(transaction, { projectId, runId, reservationId }));
  expect(material.receipt.event).toBeUndefined();
  expect(material.request.origin).toEqual(origin);
});
