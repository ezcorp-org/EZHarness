import { afterEach, describe, expect, test } from "bun:test";
import { GetObjectCommand, HeadObjectCommand, ListObjectsV2Command, PutObjectCommand } from "@aws-sdk/client-s3";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FactoryArtifactReference } from "@ezcorp/factory-sdk";
import type { FactoryArchiveDenialAttempt } from "./archive-writer";
import type { FactoryScopedArtifactReader } from "./artifact-materials";
import type { FactoryArchiveObject, FactoryReleaseMaterial } from "./releases";
import type { FactoryStartupStorage } from "./startup-config";
import {
  FactoryStorageCredentialError,
  composeFactoryArchiveWriter,
  factoryArchiveDenialProbe,
  factoryPublicationReadiness,
  loadFactoryStorageCredentials,
} from "./release-composition";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function privateRoot(): Promise<string> {
  const directory = await mkdtemp(join(process.env.HOME!, ".w09-release-"));
  roots.push(directory);
  await chmod(directory, 0o700);
  return directory;
}

async function credentialFile(root: string, content: unknown): Promise<string> {
  const path = join(root, "archive.json");
  await writeFile(path, typeof content === "string" ? content : JSON.stringify(content), { mode: 0o600 });
  await chmod(path, 0o600);
  return path;
}

function storage(path: string, overrides: Partial<FactoryStartupStorage> = {}): FactoryStartupStorage {
  return {
    endpoint: "http://127.0.0.1:18334",
    bucket: "tenant-01",
    prefix: "factory-archive",
    credentialSet: "archive-set",
    credentialsPath: path,
    ...overrides,
  };
}

/** Enough of S3 for the archive adapter and the inventory, with versions. */
class MemoryS3 {
  private sequence = 0;
  readonly current = new Map<string, { bytes: Uint8Array; version: string; etag: string; checksum?: string }>();
  readonly versions = new Map<string, Uint8Array>();

  async send(command: unknown): Promise<Record<string, unknown>> {
    if (command instanceof HeadObjectCommand) {
      const item = this.current.get(command.input.Key!);
      if (!item) throw { name: "NotFound", $metadata: { httpStatusCode: 404 } };
      return { VersionId: item.version, ETag: item.etag, ChecksumSHA256: item.checksum };
    }
    if (command instanceof PutObjectCommand) {
      const prior = this.current.get(command.input.Key!);
      if (command.input.IfNoneMatch === "*" && prior) throw { name: "PreconditionFailed", $metadata: { httpStatusCode: 412 } };
      const bytes = Uint8Array.from(command.input.Body as Uint8Array);
      const version = `version-${++this.sequence}`;
      const etag = `"etag-${this.sequence}"`;
      this.current.set(command.input.Key!, { bytes, version, etag, checksum: command.input.ChecksumSHA256 });
      this.versions.set(`${command.input.Key!}:${version}`, bytes);
      return { VersionId: version, ETag: etag };
    }
    if (command instanceof GetObjectCommand) {
      const version = command.input.VersionId ?? this.current.get(command.input.Key!)?.version;
      const bytes = this.versions.get(`${command.input.Key!}:${version}`);
      if (!bytes) throw { name: "NoSuchKey", $metadata: { httpStatusCode: 404 } };
      return { Body: { async transformToByteArray() { return bytes; } }, ContentLength: bytes.byteLength, VersionId: version };
    }
    if (command instanceof ListObjectsV2Command) {
      const prefix = command.input.Prefix ?? "";
      return {
        Contents: [...this.current.entries()].filter(([key]) => key.startsWith(prefix)).map(([key]) => ({ Key: key })),
        IsTruncated: false,
      };
    }
    throw new Error("unexpected S3 command");
  }
}

const reader: FactoryScopedArtifactReader = {
  async read() { return new Uint8Array([1, 2, 3]); },
  async readChunk() { return new Uint8Array([1]); },
};

const material: FactoryReleaseMaterial = {
  decisionId: "decision-a",
  evidence: [{}],
  packageTrustDigest: `sha256:${"a".repeat(64)}`,
  validatorTrustDigest: `sha256:${"b".repeat(64)}`,
};

function writer(client: MemoryS3, overrides: Partial<Parameters<typeof composeFactoryArchiveWriter>[0]> = {}) {
  return composeFactoryArchiveWriter({
    tenantId: "tenant-01",
    ordinary: storage("/unused", { endpoint: "http://127.0.0.1:18333", credentialSet: "ordinary-set" }),
    archive: storage("/unused"),
    reader,
    resolveMembers: () => ({ scope: { tenantId: "tenant-01", projectId: "project-1", runId: "run-1", attemptId: "attempt-1", operationId: "operation-1" } }),
    archiveCredentials: { accessKeyId: "key", secretAccessKey: "secret" },
    archiveClient: client,
    ...overrides,
  });
}

describe("loadFactoryStorageCredentials", () => {
  test("reads one tenant's credentials out of a credential-set file", async () => {
    const root = await privateRoot();
    const path = await credentialFile(root, {
      identities: [
        { name: "tenant-02", credentials: [{ accessKey: "other-key", secretKey: "other-secret" }] },
        { name: "tenant-01", credentials: [{ accessKey: "the-key", secretKey: "the-secret" }] },
      ],
    });
    expect(await loadFactoryStorageCredentials(storage(path), "tenant-01")).toEqual({ accessKeyId: "the-key", secretAccessKey: "the-secret" });
  });

  test("names the credential SET and never the value when it refuses", async () => {
    const root = await privateRoot();
    const path = await credentialFile(root, { identities: [{ name: "tenant-01", credentials: [{ accessKey: "", secretKey: "swordfish" }] }] });
    let error: FactoryStorageCredentialError | undefined;
    try {
      await loadFactoryStorageCredentials(storage(path), "tenant-01");
    } catch (caught) {
      error = caught as FactoryStorageCredentialError;
    }
    expect(error).toBeInstanceOf(FactoryStorageCredentialError);
    expect(error!.credentialSet).toBe("archive-set");
    expect(error!.message).toContain("archive-set");
    expect(error!.message).not.toContain("swordfish");
  });

  test("refuses a missing file, unreadable bytes, a foreign tenant, and a malformed entry", async () => {
    const root = await privateRoot();
    await expect(loadFactoryStorageCredentials(storage(join(root, "absent.json")), "tenant-01")).rejects.toBeInstanceOf(FactoryStorageCredentialError);
    await expect(loadFactoryStorageCredentials(storage(await credentialFile(root, "{not json")), "tenant-01")).rejects.toBeInstanceOf(FactoryStorageCredentialError);
    await expect(loadFactoryStorageCredentials(storage(await credentialFile(root, { identities: "wrong" })), "tenant-01")).rejects.toBeInstanceOf(FactoryStorageCredentialError);
    await expect(loadFactoryStorageCredentials(storage(await credentialFile(root, { identities: [{ name: "tenant-99", credentials: [{ accessKey: "k", secretKey: "s" }] }] })), "tenant-01"))
      .rejects.toBeInstanceOf(FactoryStorageCredentialError);
    await expect(loadFactoryStorageCredentials(storage(await credentialFile(root, { identities: [{ name: "tenant-01", credentials: [] }] })), "tenant-01"))
      .rejects.toBeInstanceOf(FactoryStorageCredentialError);
    await expect(loadFactoryStorageCredentials(storage(await credentialFile(root, { identities: [{ name: "tenant-01" }] })), "tenant-01"))
      .rejects.toBeInstanceOf(FactoryStorageCredentialError);
    await expect(loadFactoryStorageCredentials(storage(await credentialFile(root, { identities: [{ name: "tenant-01", credentials: [{ accessKey: "k", secretKey: 7 }] }] })), "tenant-01"))
      .rejects.toBeInstanceOf(FactoryStorageCredentialError);
  });
});

describe("factoryArchiveDenialProbe", () => {
  const attempt = (credentialSet: "product" | "restore"): FactoryArchiveDenialAttempt => ({
    credentialSet,
    operation: "read",
    object: { key: "factory-archive/x", digest: `sha256:${"a".repeat(64)}`, storageVersion: "v1" } as FactoryArchiveObject,
  });

  test("attempts with the named credential set and reports its verdict", async () => {
    const seen: Array<{ key: string; operation: string }> = [];
    const probe = factoryArchiveDenialProbe(
      { product: { accessKeyId: "p", secretAccessKey: "ps" }, restore: { accessKeyId: "r", secretAccessKey: "rs" } },
      { attempt: async (credentials, request) => { seen.push({ key: credentials.accessKeyId, operation: request.operation }); return "denied"; } },
    );
    expect(await probe.attempt(attempt("product"))).toBe("denied");
    expect(await probe.attempt(attempt("restore"))).toBe("denied");
    expect(seen).toEqual([{ key: "p", operation: "read" }, { key: "r", operation: "read" }]);
  });

  test("an unconfigured restore set cannot be shown to be refused, so it does not pass", async () => {
    const probe = factoryArchiveDenialProbe(
      { product: { accessKeyId: "p", secretAccessKey: "ps" } },
      { attempt: async () => "denied" },
    );
    expect(await probe.attempt(attempt("restore"))).toBe("permitted");
    expect(await probe.attempt(attempt("product"))).toBe("denied");
  });

  test("passes the caller's deadline to the attempt", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const probe = factoryArchiveDenialProbe(
      { product: { accessKeyId: "p", secretAccessKey: "ps" } },
      { attempt: async (_credentials, _request, signal) => { observed = signal; return "denied"; } },
    );
    await probe.attempt(attempt("product"), controller.signal);
    expect(observed).toBe(controller.signal);
  });
});

describe("composeFactoryArchiveWriter", () => {
  test("builds a writer that really writes and reads back through the archive credentials", async () => {
    const client = new MemoryS3();
    const archive = writer(client);
    const bytes = new TextEncoder().encode("recovery intent");
    const object = await archive.writeImmutable("tenant-01", "operation-1", "intent", bytes);
    expect(object.key).toContain("factory-archive/");
    expect(new TextDecoder().decode(await archive.read(object))).toBe("recovery intent");
  });

  test("records the same-host failure domain on a development configuration", () => {
    const archive = writer(new MemoryS3());
    expect(archive.failureDomain).toMatchObject({
      failureDomain: "same-host-not-independent",
      credentialsSeparated: true,
      deployedIndependenceProven: false,
    });
    expect(archive.failureDomain.unmetCriteria).toContain("deployed-independent-failure-domain");
  });

  test("an operator's replication statement plus separate hosts changes the verdict", () => {
    const archive = writer(new MemoryS3(), {
      ordinary: storage("/unused", { endpoint: "https://product.example", credentialSet: "ordinary-set" }),
      archive: storage("/unused", { endpoint: "https://archive.example" }),
      replicationEvidence: "verified cross-region replication, ticket OPS-91",
    });
    expect(archive.failureDomain).toMatchObject({ failureDomain: "separately-deployed-independent", deployedIndependenceProven: true });
    expect(archive.failureDomain.unmetCriteria).toEqual([]);
  });

  test("a separate host with no replication statement stays unproven", () => {
    const archive = writer(new MemoryS3(), {
      ordinary: storage("/unused", { endpoint: "https://product.example", credentialSet: "ordinary-set" }),
      archive: storage("/unused", { endpoint: "https://archive.example" }),
    });
    expect(archive.failureDomain.failureDomain).toBe("separate-host-replication-unproven");
  });

  test("accepts an injected clock and a denial probe", async () => {
    const client = new MemoryS3();
    const archive = writer(client, {
      now: () => 1_700_000_000_000,
      denialProbe: { attempt: async () => "denied" },
    });
    const readiness = await archive.checkReadiness("tenant-01", "operation-clock");
    expect(readiness.checkedAtMs).toBe(1_700_000_000_000);
  });
});

describe("factoryPublicationReadiness", () => {
  test("reports a same-host deployment as ready and NOT publication grade", async () => {
    const client = new MemoryS3();
    const archive = writer(client, { denialProbe: { attempt: async () => "denied" } });
    const readiness = await factoryPublicationReadiness(archive, "tenant-01", "operation-1");

    // Visible, not an error: a same-host deployment is operationally ready.
    expect(readiness.ready).toBe(true);
    expect(readiness.publicationGrade).toBe(false);
    expect(readiness.withheldBecause).toContain("deployed-independent-failure-domain");
    expect(readiness.failureDomain.failureDomain).toBe("same-host-not-independent");
  });

  test("names every failing check once when a denial is permitted", async () => {
    const client = new MemoryS3();
    const archive = writer(client, { denialProbe: { attempt: async () => "permitted" } });
    const readiness = await factoryPublicationReadiness(archive, "tenant-01", "operation-2");
    expect(readiness.ready).toBe(false);
    expect(readiness.publicationGrade).toBe(false);
    expect(readiness.withheldBecause).toContain("product_read_denied");
    expect(new Set(readiness.withheldBecause).size).toBe(readiness.withheldBecause.length);
  });

  test("withholds nothing when the deployment is publication grade", async () => {
    const client = new MemoryS3();
    const archive = writer(client, {
      ordinary: storage("/unused", { endpoint: "https://product.example", credentialSet: "ordinary-set" }),
      archive: storage("/unused", { endpoint: "https://archive.example" }),
      replicationEvidence: "verified cross-region replication, ticket OPS-91",
      denialProbe: { attempt: async () => "denied" },
    });
    const readiness = await factoryPublicationReadiness(archive, "tenant-01", "operation-3");
    expect(readiness.publicationGrade).toBe(true);
    expect(readiness.withheldBecause).toEqual([]);
  });

  test("passes the caller's deadline through to the writer", async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const stub = { checkReadiness: async (_tenant: string, _operation: string, signal?: AbortSignal) => {
      observed = signal;
      return {
        schemaVersion: "factory.archive-readiness.v1" as const, ready: true, publicationGrade: true, checks: [],
        failureDomain: writer(new MemoryS3()).failureDomain, unmetCriteria: [], checkedAtMs: 1,
      };
    } };
    await factoryPublicationReadiness(stub, "tenant-01", "operation-4", controller.signal);
    expect(observed).toBe(controller.signal);
  });
});

describe("the publication set resolver is the W07/W08 seam", () => {
  test("the composition passes the resolver through to the writer's plan", async () => {
    const client = new MemoryS3();
    const seen: Array<{ tenantId: string; operationId: string }> = [];
    const archive = writer(client, {
      resolveMembers: (tenantId, operationId) => {
        seen.push({ tenantId, operationId });
        return { scope: { tenantId, projectId: "project-1", runId: "run-1", attemptId: "attempt-1", operationId }, candidate: undefined as unknown as FactoryArtifactReference };
      },
    });
    await archive.writeImmutable("tenant-01", "operation-5", "material", new TextEncoder().encode(JSON.stringify(material)));
    // `writeImmutable` for a material archives the planned members, so the
    // resolver is reached through the real code path rather than called here.
    expect(seen).toEqual([{ tenantId: "tenant-01", operationId: "operation-5" }]);
  });
});
