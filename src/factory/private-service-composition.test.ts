import { afterAll, describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TransactionalDb } from "../db/migrations/types";
import type { BlobStore } from "../extensions/v4/types";
import { certificates } from "../__tests__/helpers/factory-certificates";
import { createFactoryApplication } from "./application";
import { FactoryArtifacts } from "./artifacts";
import type { FactoryAssurance } from "./assurance";
import { factoryInstallationStores, type FactoryInstallationStores } from "./installation-stores";
import type { PoolAdmissionClient } from "./pool/client";
import type { FactoryReleases } from "./releases";
import { FACTORY_STARTUP_CONFIG_SCHEMA, type FactoryStartupConfig } from "./startup-config";
import type { FactoryTaskStops, FactoryTaskStopReceipt } from "./task-stops";
import { FactoryTransitionArtifacts } from "./transition-artifacts";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";
import {
  FACTORY_PRIVATE_SERVICE_REQUEST_TIMEOUT_MS,
  composeFactoryPrivateService,
  factoryCancelNodeEffect,
  factoryRunnerProfiles,
} from "./private-service-composition";

const tenantId = "tenant-private";
const subject = "factory-private";
const directories: string[] = [];
const listeners: Array<{ stop(): void }> = [];

afterAll(async () => {
  for (const listener of listeners.splice(0)) listener.stop();
  await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

const SERVICE: TrustedFactoryServiceIdentity = { subject, tenantId };
const REFERENCE: TrustedFactoryCommandReference = { tenantId, projectId: "project-1", logicalRunId: "run-1", interpreterId: "root", commandId: "cancel-1" };

const STOPPED_EVENT = { kind: "attempt-stopped", id: "event-1", atMs: 1, attemptId: "attempt-1" } as unknown as FactoryTaskStopReceipt["event"];

describe("factoryCancelNodeEffect", () => {
  test("returns the attempt-stopped event only once a host confirmed the stop", async () => {
    const effect = factoryCancelNodeEffect({ stop: async () => ({ state: "stopped", event: STOPPED_EVENT }) as FactoryTaskStopReceipt });
    expect(await effect(SERVICE, REFERENCE)).toBe(STOPPED_EVENT);
  });

  test("answers null for durable uncertainty rather than making a false stop durable", async () => {
    // The uncertain receipt carries the same event. Returning it would record
    // "this attempt stopped" on the strength of a request nobody answered.
    const effect = factoryCancelNodeEffect({ stop: async () => ({ state: "uncertain", event: STOPPED_EVENT }) as FactoryTaskStopReceipt });
    expect(await effect(SERVICE, REFERENCE)).toBeNull();
  });

  test("passes the caller's own service and reference through unchanged", async () => {
    const seen: Array<{ service: unknown; reference: unknown }> = [];
    const effect = factoryCancelNodeEffect({
      stop: async (service, reference) => {
        seen.push({ service, reference });
        return { state: "stopped", event: STOPPED_EVENT } as FactoryTaskStopReceipt;
      },
    });
    await effect(SERVICE, REFERENCE);
    expect(seen).toEqual([{ service: SERVICE, reference: REFERENCE }]);
  });

  test("a stop that throws reaches the caller rather than becoming a null", async () => {
    const effect = factoryCancelNodeEffect({ stop: async () => { throw Object.assign(new Error("stale"), { code: "factory_task_stop_stale" }); } });
    await expect(effect(SERVICE, REFERENCE)).rejects.toMatchObject({ code: "factory_task_stop_stale" });
  });
});

const RUNNER_PROFILES = {
  brokerAudience: "factory-gateway",
  profiles: [{
    runner: { package: "@ezcorp/minimal", manifestName: "minimal", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, export: "run" },
    resourceClass: "cpu",
    allocation: { resources: { cpu: 1 }, memoryBytes: 1_073_741_824, budget: { costMicros: "1000000", tokens: 1_000, computeMs: 600_000 } },
    allowedCapabilities: [],
  }],
};

describe("factoryRunnerProfiles", () => {
  test("derives the admission map and the runner list from one declaration", () => {
    const derived = factoryRunnerProfiles({ runnerProfiles: RUNNER_PROFILES } as unknown as FactoryStartupConfig);
    expect(derived.brokerAudience).toBe("factory-gateway");
    // Both shapes read the SAME allocation, which is what stops an admission
    // that reserves a CPU second and a dispatch that spends it from disagreeing.
    expect(derived.admission.cpu).toEqual(derived.runners[0]!.allocation);
    expect(derived.runners[0]!.runner.export).toBe("run");
    expect(derived.runners[0]!.tools).toEqual([]);
    expect(Object.isFrozen(derived.admission)).toBe(true);
  });

  test("refuses by name when the installation declares none", () => {
    for (const runnerProfiles of [undefined, { brokerAudience: "a", profiles: [] }]) {
      expect(() => factoryRunnerProfiles({ runnerProfiles } as unknown as FactoryStartupConfig))
        .toThrow("Admitting and dispatching a task needs at least one configured runner profile.");
    }
  });
});

describe("composeFactoryPrivateService", () => {
  function database(): TransactionalDb {
    const execute = async () => [];
    return {
      execute,
      async transaction<Result>(work: (transaction: { execute: typeof execute }) => Promise<Result>): Promise<Result> { return work({ execute }); },
    } as unknown as TransactionalDb;
  }

  function blobs(): BlobStore {
    return { async put() { return "sha256-x"; }, async get() { return new Uint8Array(); } } as unknown as BlobStore;
  }

  function stores(db: TransactionalDb, withPool = true): { stores: FactoryInstallationStores; application: ReturnType<typeof createFactoryApplication>; transitions: FactoryTransitionArtifacts } {
    const store = blobs();
    const application = createFactoryApplication({
      database: db, tenantId, blobs: store,
      runOptions: { interpreterBuild: "build-1", interpreterCompatibility: "1", limits: { maxCostMicros: "100", maxTokens: 100, maxComputeMs: 100 }, resolveParameters: async () => ({}) },
      availableResourceClasses: ["cpu"],
    });
    const transitions = new FactoryTransitionArtifacts(new FactoryArtifacts(db, store, tenantId));
    const pool = {
      async request() { throw new Error("unused"); }, async status() { throw new Error("unused"); },
      async acknowledgeStart() { throw new Error("unused"); }, async renew() { throw new Error("unused"); },
      async cancel() { throw new Error("unused"); }, async confirmStopped() { throw new Error("unused"); },
    } as unknown as PoolAdmissionClient;
    return {
      application,
      transitions,
      stores: factoryInstallationStores({
        database: db, tenantId, blobs: store, application, transitions, serviceSubject: subject,
        ...(withPool ? { pool } : {}),
      }),
    };
  }

  /** The other packages' objects, at the scope their constructors check. */
  const releases = { tenantId, async enqueueCommandApprovalInTransaction() { return {}; } } as unknown as FactoryReleases;
  const assurance = { tenantId } as unknown as FactoryAssurance;
  const stops = { async stop() { return { state: "stopped", event: STOPPED_EVENT } as FactoryTaskStopReceipt; } } as unknown as FactoryTaskStops;

  async function material(): Promise<{ root: string; config: FactoryStartupConfig }> {
    const root = await mkdtemp(join(process.env.HOME!, ".w09b-private-"));
    directories.push(root);
    await chmod(root, 0o700);
    const certs = await certificates(directories, subject);
    const write = async (name: string, value: string) => {
      const path = join(root, name);
      await writeFile(path, value, { mode: 0o600 });
      await chmod(path, 0o600);
      return path;
    };
    const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const probe = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
    const port = probe.port;
    probe.stop(true);
    return {
      root,
      config: {
        schemaVersion: FACTORY_STARTUP_CONFIG_SCHEMA,
        installationId: "installation-private",
        tenantId,
        privateService: {
          hostname: "127.0.0.1",
          port,
          certificateIdentity: subject,
          tls: {
            caPath: await write("ca.pem", certs.ca),
            certificatePath: await write("server.pem", certs.serverCert),
            privateKeyPath: await write("server.key", certs.serverKey),
          },
          tokens: {
            issuer: "https://factory.example.test",
            audience: "factory-private-service",
            publicKeyPaths: { proof: await write("token.pem", publicKey.export({ type: "spki", format: "pem" }).toString()) },
          },
        },
        runnerProfiles: RUNNER_PROFILES,
      } as unknown as FactoryStartupConfig,
    };
  }

  test("binds the listener the orchestrator calls back on", async () => {
    const { config } = await material();
    const db = database();
    const composed = stores(db);
    const listener = await composeFactoryPrivateService({
      database: db, config, application: composed.application, stores: composed.stores,
      transitions: composed.transitions, releases, assurance, stops,
    });
    listeners.push(listener);
    expect(listener.url).toMatch(/^https:\/\/127\.0\.0\.1:\d+$/);
  });

  test("refuses by name when the installation configures no token verifier", async () => {
    const { config } = await material();
    const { tokens: _omitted, ...privateService } = config.privateService as unknown as Record<string, unknown>;
    const db = database();
    const composed = stores(db);
    await expect(composeFactoryPrivateService({
      database: db, config: { ...config, privateService } as unknown as FactoryStartupConfig,
      application: composed.application, stores: composed.stores, transitions: composed.transitions,
      releases, assurance, stops,
    })).rejects.toMatchObject({ code: "factory_private_service_tokens_missing" });
  });

  test("refuses by name when the stores it commands through could not be built", async () => {
    const { config } = await material();
    const db = database();
    const composed = stores(db, false);
    await expect(composeFactoryPrivateService({
      database: db, config, application: composed.application, stores: composed.stores,
      transitions: composed.transitions, releases, assurance, stops,
    })).rejects.toMatchObject({ code: "factory_private_service_stores_missing" });
  });

  test("refuses by name when the release store or the stop store is absent", async () => {
    const { config } = await material();
    const db = database();
    const composed = stores(db);
    for (const missing of [{ assurance, stops }, { releases, stops }, { releases, assurance }]) {
      await expect(composeFactoryPrivateService({
        database: db, config, application: composed.application, stores: composed.stores,
        transitions: composed.transitions, ...missing,
      } as never)).rejects.toMatchObject({ code: "factory_private_service_stores_missing" });
    }
  });

  test("refuses by name when no runner profile is declared", async () => {
    const { config } = await material();
    const { runnerProfiles: _omitted, ...withoutProfiles } = config as unknown as Record<string, unknown>;
    const db = database();
    const composed = stores(db);
    await expect(composeFactoryPrivateService({
      database: db, config: withoutProfiles as unknown as FactoryStartupConfig,
      application: composed.application, stores: composed.stores, transitions: composed.transitions,
      releases, assurance, stops,
    })).rejects.toMatchObject({ code: "factory_private_service_profiles_missing" });
  });
});

describe("the private service's request timeout", () => {
  test("outlives the longest effect it serves", async () => {
    // Not a number chosen for comfort. `cancel-node` asks a host to stop a
    // guest, and that is bounded by C02's ten seconds of cleanup grace plus ten
    // of kill-and-confirm. The transport's own default is fifteen seconds, so it
    // cut the socket mid-stop: the caller read `socket hang up` and retried the
    // command against a host already stopping the same guest.
    const { FACTORY_PHYSICAL_STOP_TIMEOUT_MS } = await import("./task-stops");
    expect(FACTORY_PRIVATE_SERVICE_REQUEST_TIMEOUT_MS).toBeGreaterThan(FACTORY_PHYSICAL_STOP_TIMEOUT_MS);
    // And inside the transport's own ceiling, or the listener would refuse to
    // bind at all.
    const { FACTORY_PRIVATE_MAX_ENVELOPE_BYTES } = await import("./private-https");
    expect(FACTORY_PRIVATE_MAX_ENVELOPE_BYTES).toBeGreaterThan(0);
    expect(FACTORY_PRIVATE_SERVICE_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("a refusal the private service could not classify", () => {
  test("reaches the host's reporter while the wire answer stays opaque", async () => {
    const { startFactoryPrivateService } = await import("./private-service");
    const { nodeHttpsRequest, signedServiceToken } = await import("../__tests__/helpers/factory-certificates");
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const certs = await certificates(directories, "tenant-a");
    const reported: Array<{ method: string; path: string; error: unknown }> = [];
    const boom = Object.assign(new Error("the stored command's effect refused"), { code: "effect_refused" });
    const listener = startFactoryPrivateService({
      tenantId, certificateIdentity: "tenant-a",
      hostname: "127.0.0.1", port: 0,
      tls: { ca: certs.ca, cert: certs.serverCert, key: certs.serverKey },
      tokens: async () => ({ issuer: "https://factory.example.test", audience: "factory-private-service", publicKeys: { test: keys.publicKey.export({ type: "spki", format: "pem" }).toString() } }),
      queue: { async claim() { throw boom; }, async settle() {}, async confirmInboxIdentity() { return false; } } as never,
      artifacts: {} as never,
      commands: { async execute() { throw boom; }, async resolveFactory() { throw boom; } },
      report: (context) => { reported.push(context); },
    });
    listeners.push(listener);

    const token = signedServiceToken(keys.privateKey, {
      sub: "tenant-a", iss: "https://factory.example.test", aud: "factory-private-service",
      exp: Math.floor(Date.now() / 1_000) + 60, scope: ["factory:orchestrate"],
    });
    const response = await nodeHttpsRequest(`${listener.url}/internal/factory/v1/outbox/claim`, certs, { body: {}, token });

    // The caller learns nothing beyond "it failed", which is the point.
    expect(response.status).toBe(500);
    expect(JSON.parse(response.body.toString())).toEqual({ error: "request_failed" });
    // The operator learns which route and which error, which is also the point.
    expect(reported).toEqual([{ method: "POST", path: "/internal/factory/v1/outbox/claim", error: boom }]);
  });

  test("an ordinary classified refusal is answered, not reported", async () => {
    const { startFactoryPrivateService } = await import("./private-service");
    const { nodeHttpsRequest, signedServiceToken } = await import("../__tests__/helpers/factory-certificates");
    const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const certs = await certificates(directories, "tenant-a");
    const reported: unknown[] = [];
    const listener = startFactoryPrivateService({
      tenantId, certificateIdentity: "tenant-a",
      hostname: "127.0.0.1", port: 0,
      tls: { ca: certs.ca, cert: certs.serverCert, key: certs.serverKey },
      tokens: async () => ({ issuer: "https://factory.example.test", audience: "factory-private-service", publicKeys: { test: keys.publicKey.export({ type: "spki", format: "pem" }).toString() } }),
      queue: { async claim() { return null; }, async settle() {}, async confirmInboxIdentity() { return false; } } as never,
      artifacts: {} as never,
      commands: { async execute() { return null; }, async resolveFactory() { throw new Error("unused"); } },
      report: (context) => { reported.push(context); },
    });
    listeners.push(listener);

    const token = signedServiceToken(keys.privateKey, {
      sub: "tenant-a", iss: "https://factory.example.test", aud: "factory-private-service",
      exp: Math.floor(Date.now() / 1_000) + 60, scope: ["factory:orchestrate"],
    });
    // A malformed body is a 400 the service already explains; reporting it too
    // would bury the unclassified case this seam exists for.
    const response = await nodeHttpsRequest(`${listener.url}/internal/factory/v1/outbox/claim`, certs, { body: { tenantId: "foreign" }, token });
    expect(response.status).toBe(400);
    expect(reported).toEqual([]);
  });
});
