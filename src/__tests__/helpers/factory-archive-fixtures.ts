import { digestBytes } from "../../extensions/v4/blobs";
import type { FactoryArchiveInventory } from "../../factory/archive-writer";
import type { FactoryArchiveObject, FactoryReleaseArchive } from "../../factory/releases";

export type FactoryArchiveStore = FactoryReleaseArchive & FactoryArchiveInventory;

/**
 * An in-memory stand-in for the S3 release archive that keeps the real key
 * layout and the real conditional-create behaviour. Its two switches model
 * adapter-level faults a decorator cannot reach: a store without versioning,
 * and an adapter that reports a digest its bytes do not have.
 */
export class MemoryFactoryReleaseArchive implements FactoryArchiveStore {
  readonly objects = new Map<string, Uint8Array>();
  readonly versions = new Map<string, string>();
  readonly writes: string[] = [];
  omitVersion = false;
  wrongDigestFor?: string;

  constructor(readonly root = "recovery") {}

  private static segment(value: string): string { return Buffer.from(value).toString("base64url"); }

  key(tenantId: string, operationId: string, name: string, bytes: Uint8Array): string {
    return `${this.root}/${MemoryFactoryReleaseArchive.segment(tenantId)}/${MemoryFactoryReleaseArchive.segment(operationId)}/${name}/${digestBytes(bytes)}`;
  }

  async writeImmutable(tenantId: string, operationId: string, name: string, bytes: Uint8Array): Promise<FactoryArchiveObject> {
    const key = this.key(tenantId, operationId, name, bytes);
    // Conditional create: identical bytes keep the first object and its version.
    if (!this.objects.has(key)) { this.objects.set(key, bytes.slice()); this.versions.set(key, `version-${this.objects.size}`); }
    this.writes.push(key);
    return {
      key,
      digest: this.wrongDigestFor && new TextDecoder().decode(bytes).includes(this.wrongDigestFor) ? `sha256:${"0".repeat(64)}` : `sha256:${digestBytes(bytes)}`,
      ...(this.omitVersion ? {} : { versionId: this.versions.get(key)! }),
    };
  }

  async read(object: FactoryArchiveObject): Promise<Uint8Array> {
    const value = this.objects.get(object.key);
    if (!value) throw new Error("archive missing");
    return value.slice();
  }

  async list(prefix: string): Promise<readonly FactoryArchiveObject[]> {
    if (typeof prefix !== "string" || !prefix.startsWith(`${this.root}/`)) throw new Error("factory_archive_foreign_prefix");
    return [...this.objects.keys()]
      .filter(key => key.startsWith(`${prefix}/`) && /^[a-f0-9]{64}$/.test(key.slice(prefix.length + 1)))
      .map(key => ({ key, digest: `sha256:${key.slice(prefix.length + 1)}`, versionId: this.versions.get(key)! }));
  }
}

/**
 * Injects an archive outage and a corrupt read into any archive, so the same
 * crash-boundary cases run over the memory store and over the real service.
 * Corrupting a real object is not something a test may do to a store that
 * forbids overwrite, and it is not what the case is about: what is under test
 * is the writer's own verification of what came back.
 */
export class FaultInjectingArchive implements FactoryArchiveStore {
  /** Write fails when the written bytes contain this substring. */
  failWriteFor?: string;
  /** Read returns different bytes when the written bytes contain this substring. */
  corruptReadFor?: string;
  readonly writes: string[] = [];
  readonly reads: string[] = [];

  constructor(private readonly inner: FactoryArchiveStore) {}

  async writeImmutable(tenantId: string, operationId: string, name: "intent" | "material" | "receipt" | "reconciliation", bytes: Uint8Array): Promise<FactoryArchiveObject> {
    if (this.failWriteFor && new TextDecoder().decode(bytes).includes(this.failWriteFor)) throw new Error("archive unavailable");
    const object = await this.inner.writeImmutable(tenantId, operationId, name, bytes);
    this.writes.push(object.key);
    return object;
  }

  async read(object: FactoryArchiveObject): Promise<Uint8Array> {
    const bytes = await this.inner.read(object);
    this.reads.push(object.key);
    return this.corruptReadFor && new TextDecoder().decode(bytes).includes(this.corruptReadFor) ? new Uint8Array([0]) : bytes;
  }

  async list(prefix: string, signal?: AbortSignal): Promise<readonly FactoryArchiveObject[]> {
    return this.inner.list(prefix, signal);
  }
}
