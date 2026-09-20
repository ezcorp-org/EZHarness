import { afterAll, expect } from "bun:test";
import { sql } from "drizzle-orm";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodmanRunner, buildLimits, filesDigest } from "@ezcorp/extension-runner";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import type { MigrationDb } from "../../db/migrations/types";
import { startFactoryPrivateHttps } from "../../factory/private-https";
import { createFactoryHostLaunchClient } from "../../factory/host-launch-client";
import { createFactoryHostLaunchRouteHandler } from "../../factory/runner/host-launch-service";
import { createFactoryHostLaunchSupervisor } from "../../factory/runner/host-launch-supervisor";
import { FactoryRemoteAttemptRuntime } from "../../factory/runner/remote-attempt-runtime";
import { createFactoryAttemptDispatchDriver } from "../../factory/runner/attempt-dispatch-driver";
import { FactoryDatabaseAttemptLaunchStore, type FactoryAttemptLaunchIntent, type FactoryPhysicalStopReceipt } from "../../factory/runner/attempt-runtime";
import { FactoryAttemptQueue } from "../../factory/attempt-queue";
import { FactoryExecutionJournal, type FactoryAttemptAuthority } from "../../factory/executions";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "../../factory/trusted-command-gateway";
import { certificates, type Certificates } from "./factory-certificates";
import { createFactoryLaunchFixture, factoryLaunchLease, factoryLaunchPackage, factoryLaunchRequest, type FactoryLaunchFixtureSource } from "./factory-attempt-launch-fixture";
import { provision } from "../../../packages/@ezcorp/extension-runner/tests/helpers";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.map(directory => rm(directory, { recursive: true, force: true }))); });

const hostId = factoryLaunchLease.hostId;
const canonical = { schemaVersion: "factory.runner.result.v1", status: "cancelled", journalCursor: 0, operations: [] } as const;

async function clientSecrets(root: string, certs: Certificates) {
  const paths = { caPath: join(root, "ca.pem"), certificatePath: join(root, "client.pem"), privateKeyPath: join(root, "client.key"), serviceTokenPath: join(root, "token") };
  await writeFile(paths.caPath, certs.ca);
  await writeFile(paths.certificatePath, certs.clientCert);
  await writeFile(paths.privateKeyPath, certs.clientKey);
  await writeFile(paths.serviceTokenPath, "unused-by-the-host-launch-route");
  return paths;
}

const stopReceipt = (intent: FactoryAttemptLaunchIntent): FactoryPhysicalStopReceipt => Object.freeze({
  schemaVersion: "factory.physical-stop.v1", attemptId: intent.request.authority.attemptId, reservationId: intent.lease.reservationId,
  workerId: intent.workerId, holderGeneration: intent.lease.holderGeneration, allocationGeneration: intent.lease.allocationGeneration,
  processGroupAbsent: true, stoppedAtMs: 1_700_000_000_000, reason: "cancelled", hostId, hostKeyId: "e2e", hostSignature: "e2e", receiptDigest: `sha256:${"c".repeat(64)}`,
});

/**
 * The complete attempt-dispatch path, on whichever engine the caller supplies.
 *
 * A queued attempt is claimed, its token minted, its readiness revalidated, and
 * it is launched across a real mutual-TLS host boundary into a real Podman guest
 * whose result becomes durable before anything acknowledges it.
 */
export async function verifyFactoryHostLaunchEndToEnd(source?: FactoryLaunchFixtureSource): Promise<void> {

  const root = await mkdtemp(join(tmpdir(), "factory-e2e-runner-"));
  const secrets = await mkdtemp(join(tmpdir(), "factory-e2e-secrets-"));
  directories.push(root, secrets);
  const certs = await certificates(directories, "tenant-a");
  const request = factoryLaunchRequest({ attemptId: "attempt-e2e" });
  const fixture = await createFactoryLaunchFixture(request, source);
  const runner = new PodmanRunner({ root, ...await provision() });
  const brokerCalls: unknown[] = [];
  let service: { url: string; stop(): void } | undefined;
  try {
    // The guest is a real v4 extension: it calls the broker once and returns the
    // canonical C02 result over the isolated framed channel.
    const files = {
      "extension.ts": `import {defineExtension,serve} from '@ezcorp/sdk/v4';const manifest={schemaVersion:4 as const,name:'factory-e2e',version:'1.0.0',author:{name:'factory'},description:'end to end attempt',permissions:{},tools:[{name:'run',description:'return the canonical result',inputSchema:{type:'object'},outputSchema:{type:'object'}}]};await serve(defineExtension({manifest,tools:{run:async(_input,context)=>{await context.call('factory.broker',{kind:'model',operation:'e2e'});return ${JSON.stringify(canonical)}}}}));`,
      "feature.test.ts": "import {expect,test} from 'bun:test';test('guest source',()=>expect(true).toBe(true));",
    };
    const build = await runner.build({ operationId: "attempt-e2e-build", sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
    if (build.state !== "succeeded" || !build.artifactDigest) throw new Error(`guest build failed: ${build.diagnostics.map(d => d.code).join(",")}`);
    const prepared = { ...factoryLaunchPackage(request), artifactDigest: build.artifactDigest };

    // The supervisor process: the container runner and host identity only.
    const supervisor = createFactoryHostLaunchSupervisor({ runner, hostId, broker: { invoke: async (_request, input) => { brokerCalls.push(input); return { accepted: true }; } } });
    service = startFactoryPrivateHttps({ tls: { key: certs.serverKey, cert: certs.serverCert, ca: certs.ca }, handle: createFactoryHostLaunchRouteHandler({ hostId, allowedPeers: ["tenant-a"], supervisor }) });
    const transport = await createFactoryHostLaunchClient({ baseUrl: service.url, tls: await clientSecrets(secrets, certs), serverName: "localhost", hostId });

    // The product process: every durable record, and no container.
    const now = Date.now();
    const journal = new FactoryExecutionJournal(fixture.db as never, async () => {}, () => new Date(now));
    const queue = new FactoryAttemptQueue(fixture.db as never, journal, request.authority.tenantId, () => now);
    const settled: string[] = [];
    const driver = createFactoryAttemptDispatchDriver({
      database: fixture.db,
      service: { subject: "e2e-service", tenantId: request.authority.tenantId } as TrustedFactoryServiceIdentity,
      installationId: "installation-e2e",
      attemptTokenSecret: "s".repeat(48),
      queue,
      completions: { completeInTransaction: async (_t: MigrationDb, _s: unknown, reference: TrustedFactoryCommandReference) => { settled.push(`completed:${reference.commandId}`); return {} as never; }, readInTransaction: async () => undefined } as never,
      outcomes: { recordInTransaction: async (_t: MigrationDb, _s: unknown, reference: TrustedFactoryCommandReference) => { settled.push(`outcome:${reference.commandId}`); return {} as never; }, readInTransaction: async () => undefined } as never,
      readiness: { assertDispatchReady: async () => prepared },
      runtime: new FactoryRemoteAttemptRuntime({
        launches: new FactoryDatabaseAttemptLaunchStore(fixture.db),
        transport,
        readiness: { assertDispatchReady: async () => prepared },
        mintAttemptToken: async () => "minted-e2e-token",
        pool: { acknowledgeStart: async () => ({}) as never },
        stop: async (intent) => stopReceipt(intent),
      }),
      preflight: { lease: async () => factoryLaunchLease, preparedPackage: async () => prepared },
    });

    // The shared fixture pre-admits an attempt with a placeholder request so the
    // launch-store suites can use it. Here the queue must admit the attempt
    // itself from the real canonical request, which is the product path, so the
    // placeholder row is removed first.
    await fixture.db.execute(sql`DELETE FROM factory_executions WHERE attempt_id=${request.authority.attemptId}`);

    // A queued attempt, exactly as a product run leaves one behind.
    const authority: FactoryAttemptAuthority = { attemptId: request.authority.attemptId, tenantId: request.authority.tenantId, projectId: request.authority.projectId, runId: request.authority.runId, nodeInstanceId: request.authority.nodeInstanceId, candidateGeneration: request.authority.candidateGeneration, attemptNumber: request.authority.attemptNumber, grantRevision: request.authority.grantRevision, reservationGeneration: request.authority.reservationGeneration, executionEpoch: request.authority.executionEpoch, cancellationEpoch: request.authority.cancellationEpoch, requestDigest: factoryRunnerRequestDigest(request), deadlineAt: new Date(request.authority.deadlineAtMs) };
    await queue.enqueue({ ...authority, request }, { tenantId: authority.tenantId, projectId: authority.projectId, logicalRunId: authority.runId, interpreterId: "partition-1", commandId: authority.attemptId }, factoryLaunchLease.reservationId);

    const result = await driver.dispatchOne();

    // The guest really ran: one broker effect crossed back from the container.
    expect(brokerCalls).toEqual([{ kind: "model", operation: "e2e" }]);
    expect(result.kind).not.toBe("idle");
    // Its canonical result is durable in the product database before anything
    // acknowledged it, and it is exactly what the guest returned.
    expect(await new FactoryDatabaseAttemptLaunchStore(fixture.db).terminalResult(authority.attemptId)).toEqual(canonical);
    expect(settled.some(entry => entry.endsWith(authority.attemptId))).toBe(true);

    // A second pass has nothing to claim, so the attempt ran exactly once.
    expect(await driver.dispatchOne()).toEqual({ kind: "idle" });
  } finally {
    service?.stop();
    await runner.close();
    await fixture.close();
  }
}
