import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:net";
import { join } from "node:path";
import { factoryRejection, makeFactoryPrivateRoot, makeFactoryTestInstallation, removeFactoryPrivateRoot, writeModeFile } from "../../__tests__/helpers/factory-private-root";
import type { FactoryInstallationContext } from "./installation";
import { factoryPrivatePath } from "./secret-files";
import { FactoryProvisioningError } from "./steps";
import {
  FACTORY_STORAGE_DOMAINS,
  FactorySeededStorageIssuer,
  FactoryStorageRevocationUnsupported,
  FactoryStorageStep,
  factoryS3ScopeProbe,
  factoryStorageScope,
  verifyFactoryStorageScope,
  type FactoryStorageCredential,
  type FactoryStorageCredentialIssuer,
  type FactoryStorageDomainConfig,
  type FactoryStorageScope,
  type FactoryStorageScopeProbe,
} from "./storage";

const FILES = { ordinary: "ordinary-storage.json", archive: "archive-storage.json" } as const;

let root: string;
let installation: FactoryInstallationContext;

beforeEach(async () => {
  root = await makeFactoryPrivateRoot();
  installation = makeFactoryTestInstallation(root);
});
afterEach(async () => { await removeFactoryPrivateRoot(root); });

/**
 * A store that enforces scope the way a correct one does: a known key with its
 * own secret reaches only its own bucket and prefix; an absent key there is 404.
 */
class ScopedStore implements FactoryStorageScopeProbe {
  readonly identities = new Map<string, { secretKey: string; bucket: string; prefix: string }>();
  readonly calls: Array<{ endpoint: string; bucket: string; key: string }> = [];
  constructor(private readonly override: (bucket: string, key: string, credential: FactoryStorageCredential) => number | undefined = () => undefined) {}
  async status(endpoint: string, credential: FactoryStorageCredential, bucket: string, key: string): Promise<number> {
    this.calls.push({ endpoint, bucket, key });
    const forced = this.override(bucket, key, credential);
    if (forced !== undefined) return forced;
    const identity = this.identities.get(credential.accessKey);
    if (!identity || identity.secretKey !== credential.secretKey || identity.bucket !== bucket || !key.startsWith(`${identity.prefix}/`)) return 403;
    return 404;
  }
}

/** A "minted" issuer on a ScopedStore: fresh identity per issue, deleted on revoke. */
class MintedIssuer implements FactoryStorageCredentialIssuer {
  readonly kind = "minted" as const;
  readonly log: string[] = [];
  private serial = 0;
  constructor(private readonly store: ScopedStore, private readonly name: string, private readonly fixedKey?: string) {}
  async issue(installation_: FactoryInstallationContext, scope: FactoryStorageScope): Promise<FactoryStorageCredential> {
    this.serial += 1;
    const credential = { accessKey: this.fixedKey ?? `${this.name}-key-${this.serial}`, secretKey: `${this.name}-secret-${this.serial}` };
    this.store.identities.set(credential.accessKey, { secretKey: credential.secretKey, bucket: scope.bucket, prefix: scope.prefix });
    this.log.push(`issue:${installation_.tenantId}:${scope.domain}:${credential.accessKey}`);
    return credential;
  }
  async revoke(installation_: FactoryInstallationContext, scope: FactoryStorageScope): Promise<"revoked"> {
    for (const [key, identity] of this.store.identities) if (identity.bucket === scope.bucket && identity.prefix === scope.prefix) this.store.identities.delete(key);
    this.log.push(`revoke:${installation_.tenantId}:${scope.domain}`);
    return "revoked";
  }
}

function domainConfig(issuer: FactoryStorageCredentialIssuer, domain: "ordinary" | "archive"): FactoryStorageDomainConfig {
  return { endpoint: `http://127.0.0.1:1/${domain}`, prefix: `${domain}-prefix`, issuer, failureDomain: "same-host-not-independent" };
}

function mintedStep(store = new ScopedStore()) {
  const ordinary = new MintedIssuer(store, "ordinary");
  const archive = new MintedIssuer(store, "archive");
  const step = new FactoryStorageStep({ ordinary: domainConfig(ordinary, "ordinary"), archive: domainConfig(archive, "archive"), probe: store, foreignBucket: () => "tenant-99" });
  return { step, store, ordinary, archive };
}

function expectedResources(ordinaryKind = "minted", archiveKind = "minted") {
  return {
    ordinaryCredentialsPath: join(installation.secretDirectory, FILES.ordinary),
    ordinaryIssuer: ordinaryKind,
    ordinaryEndpoint: "http://127.0.0.1:1/ordinary",
    ordinaryBucket: "tenant-01",
    ordinaryPrefix: "ordinary-prefix",
    ordinaryFailureDomain: "same-host-not-independent",
    archiveCredentialsPath: join(installation.secretDirectory, FILES.archive),
    archiveIssuer: archiveKind,
    archiveEndpoint: "http://127.0.0.1:1/archive",
    archiveBucket: "tenant-01",
    archivePrefix: "archive-prefix",
    archiveFailureDomain: "same-host-not-independent",
  };
}

async function credentialFile(domain: "ordinary" | "archive"): Promise<unknown> {
  return JSON.parse(await readFile(join(installation.secretDirectory, FILES[domain]), "utf8"));
}

async function writeCredentialFile(domain: "ordinary" | "archive", value: unknown): Promise<void> {
  await mkdir(installation.secretDirectory, { recursive: true, mode: 0o700 });
  await writeModeFile(join(installation.secretDirectory, FILES[domain]), typeof value === "string" ? value : JSON.stringify(value));
}

describe("factoryStorageScope", () => {
  test("binds the domain's endpoint and prefix to the tenant's own bucket", () => {
    const scope = factoryStorageScope(installation, "archive", domainConfig(new MintedIssuer(new ScopedStore(), "x"), "archive"));
    expect(scope).toEqual({ domain: "archive", endpoint: "http://127.0.0.1:1/archive", bucket: "tenant-01", prefix: "archive-prefix" });
    expect(Object.isFrozen(scope)).toBe(true);
    expect(FACTORY_STORAGE_DOMAINS).toEqual(["ordinary", "archive"]);
  });
});

describe("verifyFactoryStorageScope", () => {
  const scope: FactoryStorageScope = { domain: "ordinary", endpoint: "http://store", bucket: "tenant-01", prefix: "p" };
  const credential = { accessKey: "AK", secretKey: "SK" };
  function storeWith(override?: ConstructorParameters<typeof ScopedStore>[0]): ScopedStore {
    const store = new ScopedStore(override);
    store.identities.set("AK", { secretKey: "SK", bucket: "tenant-01", prefix: "p" });
    return store;
  }

  test("accepts a credential that reaches exactly its own prefix, with four read-only probes", async () => {
    const store = storeWith();
    await verifyFactoryStorageScope(store, scope, credential, "tenant-99", "n1");
    expect(store.calls).toEqual([
      { endpoint: "http://store", bucket: "tenant-01", key: "p/.provisioning-scope-probe/n1" },
      { endpoint: "http://store", bucket: "tenant-01", key: ".provisioning-scope-probe/n1" },
      { endpoint: "http://store", bucket: "tenant-99", key: "p/.provisioning-scope-probe/n1" },
      { endpoint: "http://store", bucket: "tenant-01", key: "p/.provisioning-scope-probe/n1" },
    ]);
  });

  const refusals: Array<[string, ConstructorParameters<typeof ScopedStore>[0], string]> = [
    ["an unreachable inside probe (403 instead of 404)", (bucket, key, c) => bucket === "tenant-01" && key.startsWith("p/") && c.secretKey === "SK" ? 403 : undefined, "answered 403 inside the prefix; 404 was required"],
    ["an object readable outside the prefix", (_bucket, key) => key.startsWith(".provisioning") ? 404 : undefined, "answered 404 outside the prefix; 403 was required"],
    ["a foreign bucket that answers", (bucket) => bucket === "tenant-99" ? 404 : undefined, "answered 404 a foreign tenant's bucket; 403 was required"],
    ["a wrong secret that is accepted", (_bucket, _key, c) => c.secretKey.endsWith("-wrong") ? 404 : undefined, "answered 404 a wrong secret; 403 was required"],
    ["a store that serves the object (200)", (bucket, key, c) => bucket === "tenant-01" && key.startsWith("p/") && c.secretKey === "SK" ? 200 : undefined, "answered 200 inside the prefix"],
  ];
  for (const [name, override, message] of refusals) {
    test(`refuses ${name}`, async () => {
      const error = await factoryRejection(verifyFactoryStorageScope(storeWith(override), scope, credential, "tenant-99", "n1"));
      expect(error).toBeInstanceOf(FactoryProvisioningError);
      expect(error.code).toBe("storage_scope_unproven");
      expect(error.message).toContain(`The ordinary credential ${message}`);
    });
  }
});

describe("FactoryStorageStep.ensure", () => {
  test("issues one separate credential per domain, writes private copies, and proves their scope", async () => {
    const { step, ordinary, archive, store } = mintedStep();
    const resources = await step.ensure(installation);
    expect(resources).toEqual(expectedResources());
    expect(Object.isFrozen(resources)).toBe(true);
    expect(ordinary.log).toEqual(["issue:tenant-01:ordinary:ordinary-key-1"]);
    expect(archive.log).toEqual(["issue:tenant-01:archive:archive-key-1"]);
    expect(await credentialFile("ordinary")).toEqual({ identities: [{ name: "tenant-01", credentials: [{ accessKey: "ordinary-key-1", secretKey: "ordinary-secret-1" }] }] });
    expect(await credentialFile("archive")).toEqual({ identities: [{ name: "tenant-01", credentials: [{ accessKey: "archive-key-1", secretKey: "archive-secret-1" }] }] });
    for (const domain of FACTORY_STORAGE_DOMAINS) expect((await stat(join(installation.secretDirectory, FILES[domain]))).mode & 0o777).toBe(0o600);
    expect(store.calls).toHaveLength(8);
  });

  test("a rerun keeps the credential it already holds and issues nothing", async () => {
    const { step, ordinary, archive } = mintedStep();
    const first = await step.ensure(installation);
    const before = await readFile(join(installation.secretDirectory, FILES.ordinary));
    const second = await step.ensure(installation);
    expect(second).toEqual(first);
    expect(await readFile(join(installation.secretDirectory, FILES.ordinary))).toEqual(before);
    expect(ordinary.log).toHaveLength(1);
    expect(archive.log).toHaveLength(1);
  });

  test("after a crash between the two domains, a rerun issues only the missing one", async () => {
    const { step, ordinary, archive } = mintedStep();
    await step.ensure(installation);
    await rm(join(installation.secretDirectory, FILES.archive));
    await step.ensure(installation);
    expect(ordinary.log).toEqual(["issue:tenant-01:ordinary:ordinary-key-1"]);
    expect(archive.log).toEqual(["issue:tenant-01:archive:archive-key-1", "issue:tenant-01:archive:archive-key-2"]);
    expect(await credentialFile("archive")).toEqual({ identities: [{ name: "tenant-01", credentials: [{ accessKey: "archive-key-2", secretKey: "archive-secret-2" }] }] });
  });

  test("concurrent ensures for two tenants each get their own credentials, and neither reaches the other's bucket", async () => {
    const { step, store } = mintedStep();
    const other = makeFactoryTestInstallation(root, { tenantId: "tenant-02" });
    const [mine, theirs] = await Promise.all([step.ensure(installation), step.ensure(other)]);
    expect(mine.ordinaryBucket).toBe("tenant-01");
    expect(theirs.ordinaryBucket).toBe("tenant-02");
    const minePath = mine.ordinaryCredentialsPath!, theirsPath = theirs.ordinaryCredentialsPath!;
    expect(minePath).not.toBe(theirsPath);
    const mineCredential = (JSON.parse(await readFile(minePath, "utf8")) as { identities: [{ credentials: [FactoryStorageCredential] }] }).identities[0].credentials[0];
    expect(await store.status("e", mineCredential, "tenant-02", "ordinary-prefix/x")).toBe(403);
    expect(await store.status("e", mineCredential, "tenant-01", "ordinary-prefix/x")).toBe(404);
  });

  test("concurrent verifies of one installation both succeed (read-only)", async () => {
    const { step } = mintedStep();
    const resources = await step.ensure(installation);
    expect(await Promise.all([step.verify(installation, resources), step.verify(installation, resources)])).toEqual([undefined, undefined]);
  });

  test("a corrupt private copy is refused, never silently reissued", async () => {
    const { step, ordinary } = mintedStep();
    await writeCredentialFile("ordinary", "{not json");
    expect((await factoryRejection(step.ensure(installation))).code).toBe("provisioning_secret_corrupt");
    expect(ordinary.log).toEqual([]);
  });

  test("a failing issuer fails ensure and leaves no private copy", async () => {
    const store = new ScopedStore();
    const broken: FactoryStorageCredentialIssuer = { kind: "minted", issue: async () => { throw new FactoryProvisioningError("storage_issue_failed", "no"); }, revoke: async () => "revoked" };
    const step = new FactoryStorageStep({ ordinary: domainConfig(broken, "ordinary"), archive: domainConfig(new MintedIssuer(store, "archive"), "archive"), probe: store, foreignBucket: () => "tenant-99" });
    expect((await factoryRejection(step.ensure(installation))).code).toBe("storage_issue_failed");
    expect(await Bun.file(join(installation.secretDirectory, FILES.ordinary)).exists()).toBe(false);
  });

  test("one key serving both domains is refused as not separate", async () => {
    const store = new ScopedStore();
    const step = new FactoryStorageStep({
      ordinary: domainConfig(new MintedIssuer(store, "ordinary", "SHARED"), "ordinary"),
      archive: domainConfig(new MintedIssuer(store, "archive", "SHARED"), "archive"),
      probe: store, foreignBucket: () => "tenant-99",
    });
    expect((await factoryRejection(step.ensure(installation))).code).toBe("storage_archive_not_separate");
  });

  test("a store that does not enforce the prefix fails ensure by name", async () => {
    const { step } = mintedStep(new ScopedStore((_bucket, key) => key.startsWith(".provisioning") ? 404 : undefined));
    const error = await factoryRejection(step.ensure(installation));
    expect(error.code).toBe("storage_scope_unproven");
  });
});

describe("FactoryStorageStep.verify", () => {
  test("refuses a recorded path that names another installation's file", async () => {
    const { step } = mintedStep();
    const resources = await step.ensure(installation);
    const other = makeFactoryTestInstallation(root, { tenantId: "tenant-02" });
    const error = await factoryRejection(step.verify(installation, { ...resources, archiveCredentialsPath: factoryPrivatePath(other.secretDirectory, FILES.archive) }));
    expect(error.code).toBe("storage_resource_mismatch");
    expect(error.message).toContain("archive");
  });

  test("refuses when the private copies are missing", async () => {
    const { step } = mintedStep();
    expect((await factoryRejection(step.verify(installation, expectedResources()))).code).toBe("ENOENT");
  });

  const corrupt: Array<[string, unknown]> = [
    ["null", null],
    ["no identities", {}],
    ["two identities", { identities: [{ name: "tenant-01", credentials: [{ accessKey: "a", secretKey: "b" }] }, { name: "tenant-01", credentials: [{ accessKey: "c", secretKey: "d" }] }] }],
    ["another tenant's identity", { identities: [{ name: "tenant-02", credentials: [{ accessKey: "a", secretKey: "b" }] }] }],
    ["credentials not a list", { identities: [{ name: "tenant-01", credentials: "a:b" }] }],
    ["no credential", { identities: [{ name: "tenant-01", credentials: [] }] }],
    ["two credentials", { identities: [{ name: "tenant-01", credentials: [{ accessKey: "a", secretKey: "b" }, { accessKey: "c", secretKey: "d" }] }] }],
    ["a numeric access key", { identities: [{ name: "tenant-01", credentials: [{ accessKey: 1, secretKey: "b" }] }] }],
    ["a missing secret", { identities: [{ name: "tenant-01", credentials: [{ accessKey: "a" }] }] }],
    ["an empty access key", { identities: [{ name: "tenant-01", credentials: [{ accessKey: "", secretKey: "b" }] }] }],
    ["an empty secret", { identities: [{ name: "tenant-01", credentials: [{ accessKey: "a", secretKey: "" }] }] }],
  ];
  for (const [name, value] of corrupt) {
    test(`refuses a credential file with ${name}`, async () => {
      const { step } = mintedStep();
      await writeCredentialFile("ordinary", value);
      await writeCredentialFile("archive", { identities: [{ name: "tenant-01", credentials: [{ accessKey: "x", secretKey: "y" }] }] });
      const error = await factoryRejection(step.verify(installation, expectedResources()));
      expect(error.code).toBe("storage_credential_corrupt");
      expect(error.message).not.toContain("\"b\"");
    });
  }
});

describe("FactoryStorageStep.teardown", () => {
  test("a minted issuer revokes both credentials and the private copies go; a second run also succeeds", async () => {
    const { step, ordinary, archive, store } = mintedStep();
    await step.ensure(installation);
    await step.teardown(installation);
    expect(ordinary.log.at(-1)).toBe("revoke:tenant-01:ordinary");
    expect(archive.log.at(-1)).toBe("revoke:tenant-01:archive");
    expect(store.identities.size).toBe(0);
    for (const domain of FACTORY_STORAGE_DOMAINS) expect(await Bun.file(join(installation.secretDirectory, FILES[domain])).exists()).toBe(false);
    await step.teardown(installation);
    expect(ordinary.log.filter((entry) => entry.startsWith("revoke"))).toHaveLength(2);
  });

  test("a seeded issuer raises FactoryStorageRevocationUnsupported AFTER the private copies are destroyed", async () => {
    const store = new ScopedStore();
    const seeded = new FactorySeededStorageIssuer(join(root, "unused.json"));
    const step = new FactoryStorageStep({ ordinary: domainConfig(new MintedIssuer(store, "ordinary"), "ordinary"), archive: domainConfig(seeded, "archive"), probe: store, foreignBucket: () => "tenant-99" });
    await writeCredentialFile("ordinary", { identities: [] });
    await writeCredentialFile("archive", { identities: [] });
    const error = await factoryRejection(step.teardown(installation));
    expect(error).toBeInstanceOf(FactoryStorageRevocationUnsupported);
    expect(error).toBeInstanceOf(FactoryProvisioningError);
    expect(error.code).toBe("storage_revocation_unsupported");
    expect((error as FactoryStorageRevocationUnsupported).domains).toEqual(["archive"]);
    expect((error as FactoryStorageRevocationUnsupported).step).toBe("storage");
    for (const domain of FACTORY_STORAGE_DOMAINS) expect(await Bun.file(join(installation.secretDirectory, FILES[domain])).exists()).toBe(false);
  });

  test("two seeded domains name both, and a rerun says the same", async () => {
    const seeded = new FactorySeededStorageIssuer(join(root, "unused.json"));
    const step = new FactoryStorageStep({ ordinary: domainConfig(seeded, "ordinary"), archive: domainConfig(seeded, "archive"), probe: new ScopedStore(), foreignBucket: () => "tenant-99" });
    for (let run = 0; run < 2; run += 1) {
      const error = await factoryRejection(step.teardown(installation));
      expect((error as FactoryStorageRevocationUnsupported).domains).toEqual(["ordinary", "archive"]);
      expect(error.message).toContain("ordinary, archive");
    }
  });
});

describe("FactoryStorageStep.rotate", () => {
  test("a minted issuer revokes, reissues, replaces the private copies, and re-proves scope", async () => {
    const { step, ordinary, archive, store } = mintedStep();
    const resources = await step.ensure(installation);
    const rotated = await step.rotate(installation, resources);
    expect(rotated).toEqual(resources);
    expect(ordinary.log).toEqual(["issue:tenant-01:ordinary:ordinary-key-1", "revoke:tenant-01:ordinary", "issue:tenant-01:ordinary:ordinary-key-2"]);
    expect(archive.log).toEqual(["issue:tenant-01:archive:archive-key-1", "revoke:tenant-01:archive", "issue:tenant-01:archive:archive-key-2"]);
    expect(await credentialFile("ordinary")).toEqual({ identities: [{ name: "tenant-01", credentials: [{ accessKey: "ordinary-key-2", secretKey: "ordinary-secret-2" }] }] });
    expect(store.identities.has("ordinary-key-1")).toBe(false);
    expect((await stat(join(installation.secretDirectory, FILES.ordinary))).mode & 0o777).toBe(0o600);
  });

  test("a seeded store refuses rotation and leaves the private copies untouched", async () => {
    const store = new ScopedStore();
    const seededPath = join(root, "identities.json");
    await writeFile(seededPath, JSON.stringify({ identities: [{ name: "tenant-01", credentials: [{ accessKey: "seed-a", secretKey: "seed-s" }] }] }));
    store.identities.set("seed-a", { secretKey: "seed-s", bucket: "tenant-01", prefix: "ordinary-prefix" });
    const step = new FactoryStorageStep({ ordinary: domainConfig(new FactorySeededStorageIssuer(seededPath), "ordinary"), archive: domainConfig(new MintedIssuer(store, "archive"), "archive"), probe: store, foreignBucket: () => "tenant-99" });
    const resources = await step.ensure(installation);
    expect(resources.ordinaryIssuer).toBe("seeded");
    const before = await readFile(join(installation.secretDirectory, FILES.ordinary));
    const error = await factoryRejection(step.rotate(installation, resources));
    expect(error.code).toBe("storage_rotation_unsupported");
    expect(error.message).toContain("ordinary");
    expect(await readFile(join(installation.secretDirectory, FILES.ordinary))).toEqual(before);
  });
});

describe("FactorySeededStorageIssuer", () => {
  async function issuerFor(content: string): Promise<FactorySeededStorageIssuer> {
    const path = join(root, "identity.json");
    await writeFile(path, content);
    return new FactorySeededStorageIssuer(path);
  }

  test("adopts only the identity named for this tenant", async () => {
    const issuer = await issuerFor(JSON.stringify({ identities: [
      { name: "tenant-02", credentials: [{ accessKey: "other", secretKey: "other-secret" }] },
      { name: "tenant-01", credentials: [{ accessKey: "mine", secretKey: "mine-secret" }, { accessKey: "second", secretKey: "ignored" }] },
    ] }));
    expect(issuer.kind).toBe("seeded");
    expect(await issuer.issue(installation)).toEqual({ accessKey: "mine", secretKey: "mine-secret" });
    expect(await issuer.issue(makeFactoryTestInstallation(root, { tenantId: "tenant-02" }))).toEqual({ accessKey: "other", secretKey: "other-secret" });
  });

  test("never revokes", async () => {
    expect(await (await issuerFor("{}")).revoke()).toBe("unsupported");
  });

  const unavailable: Array<[string, string, string]> = [
    ["a file that is not JSON", "{oops", "not JSON"],
    ["no identities", "{}", "tenant-01 is unavailable"],
    ["a JSON null", "null", "tenant-01 is unavailable"],
    ["identities that are not a list", JSON.stringify({ identities: 5 }), "tenant-01 is unavailable"],
    ["a null identity entry", JSON.stringify({ identities: [null, { name: "tenant-02" }] }), "tenant-01 is unavailable"],
    ["no identity for this tenant", JSON.stringify({ identities: [{ name: "tenant-02", credentials: [{ accessKey: "a", secretKey: "b" }] }] }), "tenant-01 is unavailable"],
    ["an identity without credentials", JSON.stringify({ identities: [{ name: "tenant-01" }] }), "unavailable"],
    ["a numeric access key", JSON.stringify({ identities: [{ name: "tenant-01", credentials: [{ accessKey: 7, secretKey: "b" }] }] }), "unavailable"],
    ["a missing secret key", JSON.stringify({ identities: [{ name: "tenant-01", credentials: [{ accessKey: "a" }] }] }), "unavailable"],
    ["an empty access key", JSON.stringify({ identities: [{ name: "tenant-01", credentials: [{ accessKey: "", secretKey: "b" }] }] }), "unavailable"],
    ["an empty secret key", JSON.stringify({ identities: [{ name: "tenant-01", credentials: [{ accessKey: "a", secretKey: "" }] }] }), "unavailable"],
  ];
  for (const [name, content, message] of unavailable) {
    test(`refuses ${name}`, async () => {
      const error = await factoryRejection((await issuerFor(content)).issue(installation));
      expect(error.code).toBe("storage_identity_unavailable");
      expect(error.message).toContain(message);
    });
  }

  test("refuses an identity file over 1 MiB, but accepts one at exactly 1 MiB", async () => {
    const valid = JSON.stringify({ identities: [{ name: "tenant-01", credentials: [{ accessKey: "a", secretKey: "b" }] }] });
    const exact = valid + " ".repeat(1024 * 1024 - Buffer.byteLength(valid));
    expect(await (await issuerFor(exact)).issue(installation)).toEqual({ accessKey: "a", secretKey: "b" });
    const error = await factoryRejection((await issuerFor(`${exact} `)).issue(installation));
    expect(error.code).toBe("storage_identity_unavailable");
    expect(error.message).toBe("The store identity file is too large.");
  });

  test("a missing identity file fails with the filesystem's ENOENT", async () => {
    expect((await factoryRejection(new FactorySeededStorageIssuer(join(root, "absent.json")).issue(installation))).code).toBe("ENOENT");
  });
});

describe("factoryS3ScopeProbe", () => {
  let store: ReturnType<typeof Bun.serve>;
  let dead: Server;
  let deadPort = 0;
  const seen: Array<{ method: string; path: string; authorization: string }> = [];

  beforeAll(async () => {
    store = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        seen.push({ method: request.method, path: url.pathname, authorization: request.headers.get("authorization") ?? "" });
        const status = url.pathname.endsWith("/absent") ? 404 : url.pathname.endsWith("/present") ? 200 : 403;
        return new Response(null, { status, headers: { "content-length": "0" } });
      },
    });
    dead = createServer((socket) => socket.destroy());
    await new Promise<void>((resolve_) => dead.listen(0, "127.0.0.1", () => resolve_()));
    deadPort = (dead.address() as { port: number }).port;
  });
  afterAll(async () => {
    store.stop(true);
    await new Promise<void>((resolve_) => dead.close(() => resolve_()));
  });

  const credential = { accessKey: "AKTEST", secretKey: "SKTEST" };
  for (const [key, status] of [["absent", 404], ["denied", 403], ["present", 200]] as const) {
    test(`returns ${status} from a signed path-style HEAD`, async () => {
      seen.length = 0;
      expect(await factoryS3ScopeProbe.status(`http://127.0.0.1:${store.port}`, credential, "tenant-01", `p/${key}`)).toBe(status);
      expect(seen).toHaveLength(1);
      expect(seen[0]!.method).toBe("HEAD");
      expect(seen[0]!.path).toBe(`/tenant-01/p/${key}`);
      expect(seen[0]!.authorization).toContain("Credential=AKTEST/");
      expect(seen[0]!.authorization).not.toContain("SKTEST");
    });
  }

  test("a store that closes the connection is storage_unreachable, with no credential in the message", async () => {
    const endpoint = `http://127.0.0.1:${deadPort}`;
    const error = await factoryRejection(factoryS3ScopeProbe.status(endpoint, credential, "tenant-01", "p/absent"));
    expect(error.code).toBe("storage_unreachable");
    expect(error.message).toBe(`The object store at ${endpoint} did not answer.`);
  });
});
