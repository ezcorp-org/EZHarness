import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  FACTORY_STARTUP_CONFIG_SCHEMA,
  FACTORY_STARTUP_FIELDS,
  FactoryStartupConfigError,
  loadFactoryStartupConfig,
  parseFactoryStartupConfig,
} from "./startup-config";

function storage(kind: string) {
  return {
    endpoint: `https://127.0.0.1:8443/${kind}`,
    bucket: `tenant-01-${kind}`,
    prefix: `factory-${kind}`,
    credentialSet: `${kind}-set`,
    credentialsPath: `/run/secrets/${kind}.json`,
  };
}

function valid(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: FACTORY_STARTUP_CONFIG_SCHEMA,
    installationId: "installation-01",
    tenantId: "tenant-01",
    poolId: "pool-01",
    temporalNamespace: "tenant-01.factory",
    orchestrationReadinessFilePath: "/run/factory/orchestration.json",
    poolReadinessFilePath: "/run/factory/pool.json",
    supervisorReadinessFilePath: "/run/factory/supervisor.json",
    hostId: "host-01",
    gateway: { hostname: "127.0.0.1", port: 8443, tls: { caPath: "/run/tls/ca.pem", certificatePath: "/run/tls/cert.pem", privateKeyPath: "/run/tls/key.pem" } },
    privateService: { hostname: "127.0.0.1", port: 8444, certificateIdentity: "factory-private", tls: { caPath: "/run/tls/ca.pem", certificatePath: "/run/tls/cert.pem", privateKeyPath: "/run/tls/key.pem" } },
    pool: { baseUrl: "https://127.0.0.1:8445", serviceTokenPath: "/run/secrets/pool-token", tls: { caPath: "/run/tls/ca.pem", certificatePath: "/run/tls/cert.pem", privateKeyPath: "/run/tls/key.pem" } },
    storage: { ordinary: storage("ordinary"), archive: storage("archive") },
    keys: { masterKeyFilePath: "/run/secrets/master.key", masterKeyId: "master-1", wrappedKeyFilePath: "/run/secrets/wraps.json", grantableRoots: ["/srv/project"] },
    ...overrides,
  };
}

function reject(document: unknown): FactoryStartupConfigError {
  try {
    parseFactoryStartupConfig(document);
  } catch (error) {
    if (error instanceof FactoryStartupConfigError) return error;
    throw error;
  }
  throw new Error("the document was accepted");
}

describe("parseFactoryStartupConfig", () => {
  test("accepts a complete document and freezes it", () => {
    const config = parseFactoryStartupConfig(valid());
    expect(config.tenantId).toBe("tenant-01");
    expect(config.storage.archive.credentialSet).toBe("archive-set");
    expect(Object.isFrozen(config)).toBe(true);
  });

  test("names every missing dependency at once, not just the first", () => {
    const document = valid();
    delete (document as Record<string, unknown>).poolReadinessFilePath;
    delete ((document as { storage: { archive: Record<string, unknown> } }).storage.archive).bucket;
    delete ((document as { keys: Record<string, unknown> }).keys).masterKeyId;

    const error = reject(document);
    expect(error.code).toBe("factory-configuration-invalid");
    expect([...error.missing].sort()).toEqual(["keys.masterKeyId", "poolReadinessFilePath", "storage.archive.bucket"]);
    // An operator restarting once must see all three, so all three are in the message.
    for (const field of error.missing) expect(error.message).toContain(field);
  });

  test("treats an explicit undefined as missing so a templating hole is named", () => {
    const error = reject(valid({ tenantId: undefined }));
    expect(error.missing).toContain("tenantId");
  });

  test("refuses a document that is not an object and one with the wrong schema", () => {
    expect(reject(null).missing).toEqual(["schemaVersion"]);
    expect(reject("text").missing).toEqual(["schemaVersion"]);
    expect(reject([]).missing).toEqual(["schemaVersion"]);
    expect(reject(valid({ schemaVersion: "factory.startup.v2" })).invalid).toContain("schemaVersion");
  });

  test("refuses a malformed value of every field kind", () => {
    expect(reject(valid({ tenantId: "has space" })).invalid).toContain("tenantId");
    expect(reject(valid({ orchestrationReadinessFilePath: "with\0null" })).invalid).toContain("orchestrationReadinessFilePath");
    expect(reject(valid({ gateway: { ...valid().gateway as object, port: 0 } })).invalid).toContain("gateway.port");
    expect(reject(valid({ gateway: { ...valid().gateway as object, port: 65_536 } })).invalid).toContain("gateway.port");
    expect(reject(valid({ readinessHeartbeatMs: 9 })).invalid).toContain("readinessHeartbeatMs");
    expect(reject(valid({ workers: { batch: 0 } })).invalid).toContain("workers.batch");
    expect(reject(valid({ archiveReplicationEvidence: "" })).invalid).toContain("archiveReplicationEvidence");
    expect(reject(valid({ pool: { ...valid().pool as object, baseUrl: "not a url" } })).invalid).toContain("pool.baseUrl");
    expect(reject(valid({ pool: { ...valid().pool as object, baseUrl: "ftp://host/x" } })).invalid).toContain("pool.baseUrl");
    expect(reject(valid({ keys: { ...valid().keys as object, grantableRoots: [] } })).invalid).toContain("keys.grantableRoots");
    expect(reject(valid({ keys: { ...valid().keys as object, grantableRoots: ["ok", 7] } })).invalid).toContain("keys.grantableRoots");
    expect(reject(valid({ keys: { ...valid().keys as object, grantableRoots: "not-an-array" } })).invalid).toContain("keys.grantableRoots");
  });

  test("refuses an unknown field rather than ignoring a rename", () => {
    const error = reject(valid({ gatewayPort: 8443 }));
    expect(error.invalid).toContain("gatewayPort");
    const nested = reject(valid({ storage: { ordinary: { ...storage("ordinary"), extra: 1 }, archive: storage("archive") } }));
    expect(nested.invalid).toContain("storage.ordinary.extra");
  });

  test("refuses a backoff cap below the delay it caps", () => {
    const error = reject(valid({ workers: { errorDelayMs: 5_000, maxErrorDelayMs: 1_000 } }));
    expect(error.invalid).toEqual(["workers.maxErrorDelayMs"]);
    expect(parseFactoryStartupConfig(valid({ workers: { errorDelayMs: 1_000, maxErrorDelayMs: 5_000 } })).workers?.maxErrorDelayMs).toBe(5_000);
  });

  test("refuses key material inside a grantable root", () => {
    const error = reject(valid({ keys: { masterKeyFilePath: "/srv/project/secrets/master.key", masterKeyId: "master-1", wrappedKeyFilePath: "/run/secrets/wraps.json", grantableRoots: ["/srv/project"] } }));
    expect(error.invalid).toEqual(["keys.masterKeyFilePath"]);
  });

  test("accepts the optional fields when they are well formed", () => {
    const config = parseFactoryStartupConfig(valid({
      readinessHeartbeatMs: 5_000,
      archiveReplicationEvidence: "verified cross-region replication, ticket OPS-91",
      workers: { batch: 16, idleDelayMs: 100, errorDelayMs: 500, maxErrorDelayMs: 30_000 },
    }));
    expect(config.readinessHeartbeatMs).toBe(5_000);
    expect(config.workers?.batch).toBe(16);
    expect(config.archiveReplicationEvidence).toContain("OPS-91");
  });

  test("every required dependency in the table is actually required", () => {
    const required = FACTORY_STARTUP_FIELDS.filter((spec) => !spec.optional).map((spec) => spec.field);
    expect(required.length).toBeGreaterThan(20);
    for (const field of required) {
      const document = valid() as Record<string, unknown>;
      const segments = field.split(".");
      let cursor = document;
      for (const segment of segments.slice(0, -1)) cursor = cursor[segment] as Record<string, unknown>;
      delete cursor[segments.at(-1)!];
      expect(reject(document).missing).toContain(field);
    }
  });
});

describe("loadFactoryStartupConfig", () => {
  // The private reader refuses any world-writable ancestor, so the temporary
  // root lives under the user's own home rather than under /tmp.
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

  async function privateDir(): Promise<string> {
    const directory = await mkdtemp(join(process.env.HOME!, ".w09-config-"));
    roots.push(directory);
    await chmod(directory, 0o700);
    return directory;
  }

  test("reads and validates a document from a private directory", async () => {
    const directory = await privateDir();
    const path = join(directory, "factory.json");
    await writeFile(path, JSON.stringify(valid()), { mode: 0o600 });
    await chmod(path, 0o600);
    expect((await loadFactoryStartupConfig(path)).installationId).toBe("installation-01");
  });

  test("refuses bytes that are not JSON", async () => {
    const directory = await privateDir();
    const path = join(directory, "factory.json");
    await writeFile(path, "{not json", { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(loadFactoryStartupConfig(path)).rejects.toThrow(FactoryStartupConfigError);
  });

  test("refuses a document that parses and does not validate", async () => {
    const directory = await privateDir();
    const path = join(directory, "factory.json");
    await writeFile(path, JSON.stringify({ schemaVersion: FACTORY_STARTUP_CONFIG_SCHEMA }), { mode: 0o600 });
    await chmod(path, 0o600);
    await expect(loadFactoryStartupConfig(path)).rejects.toThrow(/Missing: installationId/);
  });

  test("refuses a world-writable directory the private reader will not accept", async () => {
    const parent = await privateDir();
    const directory = join(parent, "open");
    await mkdir(directory);
    await chmod(directory, 0o777);
    const path = join(directory, "factory.json");
    await writeFile(path, JSON.stringify(valid()), { mode: 0o600 });
    await expect(loadFactoryStartupConfig(path)).rejects.toThrow();
  });
});

describe("the model provider pin", () => {
  test("is optional, but half a pin is refused at parse", () => {
    // No pin at all is an installation that runs no model-calling guest.
    expect(parseFactoryStartupConfig(valid()).modelProvider).toBeUndefined();

    const pinned = parseFactoryStartupConfig({ ...valid(), modelProvider: { provider: "anthropic", model: "claude-sonnet-5" } });
    expect(pinned.modelProvider).toEqual({ provider: "anthropic", model: "claude-sonnet-5" });

    // Half a pin would otherwise be resolved at the first guest call, which is
    // exactly where a missing provider turns into a substitute.
    for (const half of [{ provider: "anthropic" }, { model: "claude-sonnet-5" }]) {
      try {
        parseFactoryStartupConfig({ ...valid(), modelProvider: half });
        throw new Error("half a model pin was accepted");
      } catch (error) {
        expect((error as { invalid?: readonly string[] }).invalid).toContain(Object.keys(half)[0] === "provider" ? "modelProvider.model" : "modelProvider.provider");
      }
    }
  });
});
