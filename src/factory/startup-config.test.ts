import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, writeFile, chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  FACTORY_RELEASE_ENTITLED_S3_ROOT,
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
    orphanSweepIntervalMs: 30_000,
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

describe("the host launch transport and the host stop keys", () => {
  const transport = {
    baseUrl: "https://127.0.0.1:9443",
    serverName: "localhost",
    attemptTokenSecretPath: "/run/secrets/attempt-token",
    tls: { caPath: "/run/secrets/ca.pem", certificatePath: "/run/secrets/client.pem", privateKeyPath: "/run/secrets/client.key", serviceTokenPath: "/run/secrets/service.token" },
  };

  test("the transport is every part or none", () => {
    // An installation whose runner lives in the product process needs none.
    expect(parseFactoryStartupConfig(valid()).hostLaunch).toBeUndefined();
    expect(parseFactoryStartupConfig({ ...valid(), hostLaunch: transport }).hostLaunch).toEqual(transport);

    // Half a transport would fail at the first dispatch rather than at boot.
    try {
      parseFactoryStartupConfig({ ...valid(), hostLaunch: { baseUrl: transport.baseUrl } });
      throw new Error("half a host launch transport was accepted");
    } catch (error) {
      const missing = (error as { missing?: readonly string[] }).missing ?? [];
      expect(missing).toContain("hostLaunch.serverName");
      expect(missing).toContain("hostLaunch.attemptTokenSecretPath");
      expect(missing).toContain("hostLaunch.tls.caPath");
    }
  });

  test("host stop keys are public, by reference, and never an empty list", () => {
    const keys = [{ hostId: "host-1", hostKeyId: "host-key-1", publicKeyPath: "/run/secrets/host-1.pub" }];
    expect(parseFactoryStartupConfig({ ...valid(), hostStopKeys: keys }).hostStopKeys).toEqual(keys);

    for (const bad of [
      [],
      [{ hostId: "host-1", hostKeyId: "host-key-1" }],
      // A private key must never appear in this document, so an unknown key is
      // refused rather than ignored.
      [{ hostId: "host-1", hostKeyId: "host-key-1", publicKeyPath: "/p", privateKeyPath: "/secret" }],
      [{ hostId: "", hostKeyId: "host-key-1", publicKeyPath: "/p" }],
    ]) {
      expect(() => parseFactoryStartupConfig({ ...valid(), hostStopKeys: bad })).toThrow();
    }
  });
});

describe("the private service token verifier", () => {
  const tokens = { issuer: "https://factory.example.test", audience: "factory-private-service", publicKeyPaths: { proof: "/run/secrets/token.pem" } };
  const withTokens = (value: unknown) => valid({ privateService: { ...(valid().privateService as Record<string, unknown>), tokens: value } });

  test("accepts a complete verifier and an absent one", () => {
    expect(parseFactoryStartupConfig(withTokens(tokens)).privateService.tokens).toEqual(tokens);
    expect(parseFactoryStartupConfig(valid()).privateService.tokens).toBeUndefined();
  });

  test("a partial verifier names every missing half at once", () => {
    const { publicKeyPaths: _omitted, ...half } = tokens;
    const error = reject(withTokens(half));
    expect(error.missing).toContain("privateService.tokens.publicKeyPaths");
    expect(error.code).toBe("factory-configuration-invalid");
  });

  test("a key map that verifies nothing, or names a path that is not one, is invalid", () => {
    for (const publicKeyPaths of [{}, { "": "/run/secrets/token.pem" }, { proof: "" }, [], "keys"]) {
      expect(reject(withTokens({ ...tokens, publicKeyPaths })).invalid).toContain("privateService.tokens.publicKeyPaths");
    }
  });
});

describe("the runner profiles this installation dispatches to", () => {
  const profile = {
    runner: { package: "@ezcorp/minimal", manifestName: "minimal", version: "1.0.0", digest: `sha256:${"a".repeat(64)}`, export: "run" },
    resourceClass: "cpu",
    allocation: { resources: { cpu: 1 }, memoryBytes: 1_073_741_824, budget: { costMicros: "1000000", tokens: 1_000, computeMs: 600_000 } },
    allowedCapabilities: [],
  };
  const section = { brokerAudience: "factory-gateway", profiles: [profile] };

  test("accepts a complete section and an absent one", () => {
    expect(parseFactoryStartupConfig(valid({ runnerProfiles: section })).runnerProfiles).toEqual(section);
    expect(parseFactoryStartupConfig(valid()).runnerProfiles).toBeUndefined();
  });

  test("refuses a section that declares no runner, or an unknown field", () => {
    expect(reject(valid({ runnerProfiles: { ...section, profiles: [] } })).invalid).toContain("runnerProfiles");
    expect(reject(valid({ runnerProfiles: { ...section, extra: 1 } })).invalid).toContain("runnerProfiles");
    expect(reject(valid({ runnerProfiles: { ...section, brokerAudience: "" } })).invalid).toContain("runnerProfiles");
    expect(reject(valid({ runnerProfiles: "profiles" })).invalid).toContain("runnerProfiles");
  });

  test("names the exact profile that is malformed, by index", () => {
    for (const broken of [
      { ...profile, runner: { ...profile.runner, digest: "not-a-digest" } },
      { ...profile, runner: { ...profile.runner, export: "" } },
      { ...profile, runner: { package: "p" } },
      { ...profile, resourceClass: "" },
      { ...profile, allocation: { ...profile.allocation, memoryBytes: 0 } },
      { ...profile, allocation: { ...profile.allocation, resources: {} } },
      { ...profile, allocation: { ...profile.allocation, resources: { cpu: -1 } } },
      { ...profile, allocation: { ...profile.allocation, budget: { ...profile.allocation.budget, costMicros: "1.5" } } },
      { ...profile, allocation: { ...profile.allocation, budget: { ...profile.allocation.budget, tokens: -1 } } },
      { ...profile, allowedCapabilities: ["a", "a"] },
      { ...profile, extra: 1 },
      "a profile",
    ]) {
      expect(reject(valid({ runnerProfiles: { ...section, profiles: [broken] } })).invalid).toContain("runnerProfiles.profiles[0]");
    }
  });

  test("refuses a resource class declared twice, because the map would depend on order", () => {
    expect(reject(valid({ runnerProfiles: { ...section, profiles: [profile, { ...profile, runner: { ...profile.runner, export: "other" } }] } })).invalid)
      .toContain("runnerProfiles.profiles");
  });
});

describe("where a release may publish", () => {
  const s3 = { name: "ordinary", kind: "s3", endpoint: "https://127.0.0.1:8443/ordinary", bucket: "tenant-01-published", account: "tenant-01", prefix: "ordinary/releases", credentialsPath: "/run/secrets/publish.json" };
  const github = { name: "upstream", kind: "github", repository: "ezcorp-org/factory-platform-publication-tests", tokenPath: "/run/secrets/github.token" };
  const profile = {
    adapter: { package: "@ezcorp/release", manifestName: "release", version: "1.0.0", digest: `sha256:${"b".repeat(64)}`, export: "publish" },
    action: "factory.release.publish",
    destination: "ordinary",
    estimatedSpendMicros: 1_000,
  };
  const release = { destinations: [s3, github], profiles: [profile] };

  test("accepts a complete section, and an absent one", () => {
    expect(parseFactoryStartupConfig(valid({ release })).release).toEqual(release as never);
    expect(parseFactoryStartupConfig(valid()).release).toBeUndefined();
    // The S3 prefix is the one optional field, because a destination may be a
    // whole bucket.
    const { prefix: _dropped, ...withoutPrefix } = s3;
    expect(parseFactoryStartupConfig(valid({ release: { ...release, destinations: [withoutPrefix, github] } })).release?.destinations).toHaveLength(2);
  });

  test("a section is both halves or neither, because either alone publishes nothing", () => {
    expect(reject(valid({ release: { destinations: [s3] } })).missing).toContain("release.profiles");
    expect(reject(valid({ release: { profiles: [profile] } })).missing).toContain("release.destinations");
    expect(reject(valid({ release: { destinations: [], profiles: [profile] } })).invalid).toContain("release.destinations");
    expect(reject(valid({ release: { destinations: [s3], profiles: [] } })).invalid).toContain("release.profiles");
  });

  test("names the exact destination that is malformed, by index", () => {
    for (const broken of [
      { ...s3, kind: "ftp" },
      { ...s3, account: "" },
      { ...s3, endpoint: "not-a-url" },
      { ...s3, credentialsPath: "" },
      { ...s3, tokenPath: "/run/secrets/x" },
      { ...github, repository: "no-owner" },
      { ...github, repository: "owner/name/extra" },
      { ...github, tokenPath: 7 },
      { ...github, bucket: "b" },
      { name: "nameless" },
      "ordinary",
    ]) {
      expect(reject(valid({ release: { destinations: [broken], profiles: [{ ...profile, destination: "ordinary" }] } })).invalid)
        .toContain("release.destinations[0]");
    }
  });

  test("an S3 prefix is a key path, not an identity", () => {
    // Found by a real startup: validating the prefix as an identity refused
    // every realistic one, because an identity has no `/`.
    for (const prefix of ["ordinary", "ordinary/w09b-release", "ordinary/a/b/c", "ordinary/releases.v2/2026"]) {
      expect(parseFactoryStartupConfig(valid({ release: { ...release, destinations: [{ ...s3, prefix }, github] } })).release?.destinations[0])
        .toMatchObject({ prefix });
    }
    // And it refuses exactly what `factoryS3PublicationDirectory` would refuse,
    // so a prefix this document accepts is one the provider also accepts.
    for (const prefix of ["", "/leading", "ordinary/trailing/", "ordinary//double", "ordinary/./b", "ordinary/../b", 7]) {
      expect(reject(valid({ release: { ...release, destinations: [{ ...s3, prefix }, github] } })).invalid).toContain("release.destinations[0]");
    }
  });

  test("a prefix outside the tenant's entitled root is refused, because 403 is not 404", () => {
    // Measured against the live store: inside `ordinary/` an absent object
    // answers 404, outside it the same HEAD answers 403. A declaration that
    // leaves the root cannot tell absent from denied, so it is refused here
    // rather than at the first release.
    for (const prefix of ["archive", "releases", "a/b/c", "ordinary-two", "ordinaryish/x"]) {
      expect(reject(valid({ release: { ...release, destinations: [{ ...s3, prefix }, github] } })).invalid).toContain("release.destinations[0]");
    }
    // The root itself and anything under it are accepted.
    for (const prefix of [FACTORY_RELEASE_ENTITLED_S3_ROOT, `${FACTORY_RELEASE_ENTITLED_S3_ROOT}/nested/deep`]) {
      expect(parseFactoryStartupConfig(valid({ release: { ...release, destinations: [{ ...s3, prefix }, github] } })).release?.destinations[0]).toMatchObject({ prefix });
    }
  });

  test("a destination name declared twice would make a profile depend on order", () => {
    expect(reject(valid({ release: { ...release, destinations: [s3, { ...github, name: "ordinary" }] } })).invalid).toContain("release.destinations");
  });

  test("names the exact profile that is malformed, by index", () => {
    for (const broken of [
      { ...profile, adapter: { ...profile.adapter, digest: "not-a-digest" } },
      { ...profile, adapter: { ...profile.adapter, export: "" } },
      { ...profile, adapter: { package: "p" } },
      { ...profile, action: "" },
      { ...profile, estimatedSpendMicros: -1 },
      { ...profile, estimatedSpendMicros: 1.5 },
      { ...profile, estimatedSpendMicros: 1_000_000_000_001 },
      { ...profile, extra: true },
    ]) {
      expect(reject(valid({ release: { ...release, profiles: [broken] } })).invalid).toContain("release.profiles[0]");
    }
  });

  test("a profile naming an undeclared destination is refused at boot, not at the first release", () => {
    // `requestRelease` would answer `factory_protected_effect_untrusted` on the
    // first release instead, which is a refusal an operator reads long after
    // they wrote the typo.
    expect(reject(valid({ release: { ...release, profiles: [{ ...profile, destination: "nowhere" }] } })).invalid)
      .toContain("release.profiles[0].destination");
    // The destination itself is still well formed, so only the pairing is named.
    expect(reject(valid({ release: { ...release, profiles: [{ ...profile, destination: "nowhere" }] } })).invalid)
      .not.toContain("release.destinations[0]");
  });

  test("one adapter may be declared once, because the trusted set refuses the second", () => {
    // `FactoryProtectedCommandEffects` throws `factory_protected_effect_invalid`
    // on a duplicate adapter, so a document that declared two would compose
    // nothing at all rather than pick one.
    expect(reject(valid({ release: { ...release, profiles: [profile, { ...profile, destination: "upstream" }] } })).invalid)
      .toContain("release.profiles");
    // Two profiles for two different adapters are ordinary.
    expect(parseFactoryStartupConfig(valid({ release: { ...release, profiles: [profile, { ...profile, adapter: { ...profile.adapter, export: "publish-other" }, destination: "upstream" }] } })).release?.profiles)
      .toHaveLength(2);
  });

  test("an unknown field inside the section is named rather than ignored", () => {
    expect(reject(valid({ release: { ...release, extra: 1 } })).invalid).toContain("release.extra");
  });
});
