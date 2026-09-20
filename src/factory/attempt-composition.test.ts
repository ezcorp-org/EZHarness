import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import type { MigrationDb } from "../db/migrations/types";
import { verifyFactoryAttemptToken } from "./attempt-token";
import { FactoryAttemptQueue } from "./attempt-queue";
import { FactoryExecutionJournal } from "./executions";
import { FactoryGrants } from "./grants";
import { FactoryPackagePreparations } from "./package-preparation";
import { FACTORY_STARTUP_CONFIG_SCHEMA, type FactoryStartupConfig } from "./startup-config";
import type { TrustedFactoryServiceIdentity } from "./trusted-command-gateway";
import type { BlobStore } from "../extensions/v4/types";
import type { TransactionalDb } from "../db/migrations/types";
import type { FactoryPhysicalStopExpectation } from "./journal-validation";
import type { FactoryAttemptLaunchIntent, FactoryPhysicalStopReceipt } from "./runner/attempt-runtime";
import { certificates } from "../__tests__/helpers/factory-certificates";
import { createFactoryLaunchFixture, factoryLaunchLease, factoryLaunchPackage, factoryLaunchRequest } from "../__tests__/helpers/factory-attempt-launch-fixture";
import {
  FACTORY_ATTEMPT_TOKEN_LIFETIME_SECONDS,
  composeFactoryAttemptDispatch,
  factoryAttemptTokenMinter,
  factoryIntentPhysicalStop,
  factoryPackageReadiness,
  loadFactoryAttemptTokenSecret,
} from "./attempt-composition";

const directories: string[] = [];
afterAll(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(process.env.HOME!, ".w09b-attempt-"));
  directories.push(root);
  await chmod(root, 0o700);
  return root;
}

const SECRET = "s".repeat(48);

async function secretFile(root: string, value = SECRET, mode = 0o600): Promise<string> {
  const path = join(root, "attempt-token");
  await writeFile(path, value, { mode });
  await chmod(path, mode);
  return path;
}

function fakeDatabase(): TransactionalDb {
  const execute = async () => [];
  return {
    execute,
    async transaction<Result>(work: (transaction: { execute: typeof execute }) => Promise<Result>): Promise<Result> { return work({ execute }); },
  } as unknown as TransactionalDb;
}

describe("loadFactoryAttemptTokenSecret", () => {
  test("reads the installation's own secret through the private bounded reader", async () => {
    const root = await privateRoot();
    expect(await loadFactoryAttemptTokenSecret(await secretFile(root))).toBe(SECRET);
  });

  test("trims the file rather than minting with a trailing newline", async () => {
    const root = await privateRoot();
    expect(await loadFactoryAttemptTokenSecret(await secretFile(root, `${SECRET}\n`))).toBe(SECRET);
  });

  test("refuses a secret too short to sign with, by name", async () => {
    const root = await privateRoot();
    await expect(loadFactoryAttemptTokenSecret(await secretFile(root, "short"))).rejects.toMatchObject({ code: "factory_attempt_token_secret_invalid" });
  });

  test("refuses a world-readable secret, because the reader refuses the mode", async () => {
    const root = await privateRoot();
    await expect(loadFactoryAttemptTokenSecret(await secretFile(root, SECRET, 0o644))).rejects.toBeDefined();
  });
});

describe("factoryAttemptTokenMinter", () => {
  test("mints a token that verifies back to this attempt and this request", async () => {
    const request = factoryLaunchRequest({ attemptId: "attempt-mint" });
    const token = await factoryAttemptTokenMinter(SECRET, "installation-mint")(request);
    const verified = await verifyFactoryAttemptToken(token, SECRET, "installation-mint");
    expect(verified).toMatchObject({
      attemptId: "attempt-mint",
      tenantId: request.authority.tenantId,
      projectId: request.authority.projectId,
      runId: request.authority.runId,
      nodeInstanceId: request.authority.nodeInstanceId,
      candidateGeneration: request.authority.candidateGeneration,
      attemptNumber: request.authority.attemptNumber,
      grantRevision: request.authority.grantRevision,
      reservationGeneration: request.authority.reservationGeneration,
      executionEpoch: request.authority.executionEpoch,
      cancellationEpoch: request.authority.cancellationEpoch,
    });
    // The digest is recomputed rather than carried, which is what stops a token
    // minted over one request from admitting another.
    expect(verified!.requestDigest).toBe(factoryRunnerRequestDigest(request));
    expect(verified!.deadlineAt.getTime()).toBe(request.authority.deadlineAtMs);
  });

  test("a token minted for one request does not verify against another installation", async () => {
    const token = await factoryAttemptTokenMinter(SECRET, "installation-mint")(factoryLaunchRequest());
    expect(await verifyFactoryAttemptToken(token, SECRET, "installation-other")).toBeNull();
  });

  test("a changed request changes the digest the token carries", async () => {
    const mint = factoryAttemptTokenMinter(SECRET, "installation-mint");
    const first = await verifyFactoryAttemptToken(await mint(factoryLaunchRequest({ model: "a" })), SECRET, "installation-mint");
    const second = await verifyFactoryAttemptToken(await mint(factoryLaunchRequest({ model: "b" })), SECRET, "installation-mint");
    expect(first!.requestDigest).not.toBe(second!.requestDigest);
  });

  test("the configured lifetime is the one the composition uses", () => {
    expect(FACTORY_ATTEMPT_TOKEN_LIFETIME_SECONDS).toBe(900);
  });
});

describe("factoryIntentPhysicalStop", () => {
  const intent = (hostId: string | undefined): FactoryAttemptLaunchIntent => Object.freeze({
    request: factoryLaunchRequest({ attemptId: "attempt-stop" }),
    // `hostId` is dropped rather than overwritten, because the pool leaves it
    // unset for an ordinary CPU allocation and that is the case under test.
    lease: { ...factoryLaunchLease, hostId } as typeof factoryLaunchLease,
    preparedPackage: factoryLaunchPackage(factoryLaunchRequest({ attemptId: "attempt-stop" })),
    workerId: "worker-stop",
    invocationId: "invocation-stop",
    devices: { devices: [] },
  }) as unknown as FactoryAttemptLaunchIntent;

  test("sends exactly the physical coordinates the wire carries, and nothing else", async () => {
    const seen: FactoryPhysicalStopExpectation[] = [];
    const stop = factoryIntentPhysicalStop(async (expectation) => {
      seen.push(expectation);
      return { receiptDigest: "sha256:x" } as unknown as FactoryPhysicalStopReceipt;
    }, "host-configured");

    await stop(intent("host-pinned"), "completed");

    expect(seen).toHaveLength(1);
    // The seven fields of `FactoryPhysicalStopExpectation`, and no cancel
    // reference or stop source: this caller has neither and does not invent one.
    expect(Object.keys(seen[0]!).sort()).toEqual([
      "allocationGeneration", "attemptId", "holderGeneration", "hostId", "reason", "reservationId", "workerId",
    ]);
    expect(seen[0]).toMatchObject({
      attemptId: "attempt-stop",
      reservationId: factoryLaunchLease.reservationId,
      workerId: "worker-stop",
      holderGeneration: factoryLaunchLease.holderGeneration,
      allocationGeneration: factoryLaunchLease.allocationGeneration,
      hostId: "host-pinned",
      reason: "completed",
    });
  });

  test("falls back to the configured host only when the lease pinned none", async () => {
    const seen: FactoryPhysicalStopExpectation[] = [];
    const stop = factoryIntentPhysicalStop(async (expectation) => {
      seen.push(expectation);
      return {} as unknown as FactoryPhysicalStopReceipt;
    }, "host-configured");
    await stop(intent(undefined), "cancelled");
    expect(seen[0]!.hostId).toBe("host-configured");
    expect(seen[0]!.reason).toBe("cancelled");
  });

  test("the transport's failure reaches the caller rather than a receipt", async () => {
    const stop = factoryIntentPhysicalStop(async () => { throw new Error("host unreachable"); }, "host-configured");
    await expect(stop(intent("host-pinned"), "failed")).rejects.toThrow("host unreachable");
  });
});

describe("factoryPackageReadiness", () => {
  test("composes over the shared configured runner client rather than a local stub", () => {
    const db = fakeDatabase();
    const readiness = factoryPackageReadiness(db, "tenant-readiness", new FactoryGrants(db, "tenant-readiness"), { async put() { return "d"; }, async get() { return new Uint8Array(); } } as unknown as BlobStore);
    expect(readiness).toBeInstanceOf(FactoryPackagePreparations);
    expect(readiness.tenantId).toBe("tenant-readiness");
    // `assertDispatchReady` is the only method the dispatch path calls and it is
    // a database read, which is why this process composes it at all.
    expect(typeof readiness.assertDispatchReady).toBe("function");
  });
});

describe("composeFactoryAttemptDispatch", () => {
  async function transportMaterial(root: string) {
    const certs = await certificates(directories, "tenant-a");
    const secrets = join(root, "tls");
    await mkdir(secrets, { mode: 0o700 });
    const paths = {
      caPath: join(secrets, "ca.pem"),
      certificatePath: join(secrets, "client.pem"),
      privateKeyPath: join(secrets, "client.key"),
      serviceTokenPath: join(secrets, "token"),
    };
    await writeFile(paths.caPath, certs.ca, { mode: 0o600 });
    await writeFile(paths.certificatePath, certs.clientCert, { mode: 0o600 });
    await writeFile(paths.privateKeyPath, certs.clientKey, { mode: 0o600 });
    await writeFile(paths.serviceTokenPath, "unused-by-the-host-launch-route", { mode: 0o600 });
    return paths;
  }

  function config(tls: Awaited<ReturnType<typeof transportMaterial>>, secretPath: string): FactoryStartupConfig & { readonly hostLaunch: NonNullable<FactoryStartupConfig["hostLaunch"]> } {
    return {
      schemaVersion: FACTORY_STARTUP_CONFIG_SCHEMA,
      installationId: "installation-compose",
      tenantId: "tenant-recovery",
      hostId: "host-recovery",
      hostLaunch: { baseUrl: "https://127.0.0.1:1", serverName: "localhost", attemptTokenSecretPath: secretPath, tls },
      // The composition reads only the fields above; the rest of the document
      // is the startup parser's concern and has its own suite.
    } as unknown as FactoryStartupConfig & { readonly hostLaunch: NonNullable<FactoryStartupConfig["hostLaunch"]> };
  }

  test("produces a driver that claims from the real queue and reports idle when there is none", async () => {
    const root = await privateRoot();
    const request = factoryLaunchRequest({ attemptId: "attempt-compose" });
    const fixture = await createFactoryLaunchFixture(request);
    try {
      const tls = await transportMaterial(root);
      const journal = new FactoryExecutionJournal(fixture.db, async () => {});
      const driver = await composeFactoryAttemptDispatch({
        database: fixture.db,
        config: config(tls, await secretFile(root)),
        service: { subject: "factory-private", tenantId: request.authority.tenantId } as TrustedFactoryServiceIdentity,
        queue: new FactoryAttemptQueue(fixture.db, journal, request.authority.tenantId),
        completions: { completeInTransaction: async () => ({} as never), readInTransaction: async (_t: MigrationDb) => undefined } as never,
        outcomes: { recordInTransaction: async () => ({} as never), readInTransaction: async (_t: MigrationDb) => undefined } as never,
        admissions: { readRetainedAdmittedInTransaction: async () => { throw new Error("no admitted reservation in this test"); } } as never,
        readiness: { assertDispatchReady: async () => factoryLaunchPackage(request) },
        pool: { acknowledgeStart: async () => ({}) as never },
        stopper: async () => ({}) as unknown as FactoryPhysicalStopReceipt,
      });

      // Nothing is queued, so the composed dispatcher claims nothing. That is
      // the whole composition exercised: the host launch client built from real
      // material, the secret read, the preflight and the remote runtime wired,
      // and W01b's driver returning its own `idle`.
      expect(await driver.dispatchOne()).toEqual({ kind: "idle" });
    } finally {
      await fixture.close();
    }
  });

  test("refuses to compose when the attempt token secret is unreadable", async () => {
    const root = await privateRoot();
    const fixture = await createFactoryLaunchFixture(factoryLaunchRequest({ attemptId: "attempt-no-secret" }));
    try {
      const tls = await transportMaterial(root);
      const journal = new FactoryExecutionJournal(fixture.db, async () => {});
      await expect(composeFactoryAttemptDispatch({
        database: fixture.db,
        config: config(tls, join(root, "absent-secret")),
        service: { subject: "factory-private", tenantId: "tenant-recovery" } as TrustedFactoryServiceIdentity,
        queue: new FactoryAttemptQueue(fixture.db, journal, "tenant-recovery"),
        completions: {} as never,
        outcomes: {} as never,
        admissions: {} as never,
        readiness: { assertDispatchReady: async () => factoryLaunchPackage(factoryLaunchRequest()) },
        pool: { acknowledgeStart: async () => ({}) as never },
        stopper: async () => ({}) as unknown as FactoryPhysicalStopReceipt,
      })).rejects.toBeDefined();
    } finally {
      await fixture.close();
    }
  });
});
