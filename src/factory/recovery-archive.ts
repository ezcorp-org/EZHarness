import { ListObjectVersionsCommand } from "@aws-sdk/client-s3";
import { canonicalJson } from "@ezcorp/extension-contract";
import { digestBytes } from "../extensions/v4/blobs";
import { factoryArchiveClient, factoryArchiveRoot, factoryArchiveSegment, readFactoryArchiveImmutable, writeFactoryArchiveImmutable, type ArchiveS3ClientLike, type FactoryS3ArchiveOptions } from "./release-adapters";
import type { FactoryArchiveObject } from "./releases";

/**
 * C06's recovery records in the independent archive: canonical audit streams
 * archived before expiry, sealed checkpoint manifests, and signed recovery
 * reports.
 *
 * They share the release archive's bucket, credentials, and write path
 * (`writeFactoryArchiveImmutable`), so the archive has one immutable-write
 * implementation and a restore that holds only archive credentials can read
 * both. Recovery records sit under a `.recovery` segment beside the
 * base64url operation segments; base64url never contains `.`, so no operation
 * id can collide with it.
 */

export type FactoryRecoveryRecordKind = "audit" | "checkpoint" | "report";
export const FACTORY_RECOVERY_RECORD_KINDS: readonly FactoryRecoveryRecordKind[] = Object.freeze(["audit", "checkpoint", "report"]);
const RECOVERY_SEGMENT = ".recovery";
const RELEASE_NAMES = new Set(["intent", "material", "receipt", "reconciliation"]);
const DIGEST = /^[a-f0-9]{64}$/;
/** One listing page. A tenant inventory reads pages until the store says it is complete. */
export const FACTORY_RECOVERY_LIST_PAGE = 1_000;
/** The most objects one tenant inventory reads before it refuses to guess. */
export const FACTORY_RECOVERY_LIST_LIMIT = 100_000;

export class FactoryRecoveryArchiveError extends Error {
  constructor(readonly code: "factory_recovery_archive_invalid" | "factory_recovery_archive_corrupt" | "factory_recovery_archive_foreign" | "factory_recovery_archive_too_large") {
    super(code);
    this.name = "FactoryRecoveryArchiveError";
  }
}

export interface FactoryRecoveryArchive {
  write(tenantId: string, kind: FactoryRecoveryRecordKind, recordId: string, bytes: Uint8Array, signal?: AbortSignal): Promise<FactoryArchiveObject>;
  read(reference: FactoryArchiveObject, signal?: AbortSignal): Promise<Uint8Array>;
  list(tenantId: string, kind: FactoryRecoveryRecordKind, recordId: string, signal?: AbortSignal): Promise<readonly FactoryArchiveObject[]>;
}

/** Every archived object one release operation holds, found from the archive alone. */
export interface FactoryArchivedReleaseObjects {
  readonly operationId: string;
  readonly intent: readonly FactoryArchiveObject[];
  readonly material: readonly FactoryArchiveObject[];
  readonly receipt: readonly FactoryArchiveObject[];
  readonly reconciliation: readonly FactoryArchiveObject[];
}

export interface FactoryArchivedReleaseCatalog {
  operations(tenantId: string, signal?: AbortSignal): Promise<readonly FactoryArchivedReleaseObjects[]>;
}

function requireKind(kind: FactoryRecoveryRecordKind): void {
  if (!FACTORY_RECOVERY_RECORD_KINDS.includes(kind)) throw new FactoryRecoveryArchiveError("factory_recovery_archive_invalid");
}

function decodeSegment(segment: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  const decoded = Buffer.from(segment, "base64url").toString("utf8");
  return factoryArchiveSegment(decoded) === segment ? decoded : null;
}

/** The independent archive's recovery surface and its release inventory, over S3 object versions. */
export class S3FactoryRecoveryArchive implements FactoryRecoveryArchive, FactoryArchivedReleaseCatalog {
  private readonly client: ArchiveS3ClientLike;
  private readonly root: string;
  constructor(private readonly options: FactoryS3ArchiveOptions) {
    this.root = factoryArchiveRoot(options.prefix);
    this.client = factoryArchiveClient(options);
  }

  private tenantPrefix(tenantId: string): string { return `${this.root}/${factoryArchiveSegment(tenantId)}`; }

  private recordPrefix(tenantId: string, kind: FactoryRecoveryRecordKind, recordId: string): string {
    requireKind(kind);
    return `${this.tenantPrefix(tenantId)}/${RECOVERY_SEGMENT}/${kind}/${factoryArchiveSegment(recordId)}`;
  }

  async write(tenantId: string, kind: FactoryRecoveryRecordKind, recordId: string, bytes: Uint8Array): Promise<FactoryArchiveObject> {
    return writeFactoryArchiveImmutable(this.options, this.client, this.recordPrefix(tenantId, kind, recordId), bytes);
  }

  async read(reference: FactoryArchiveObject): Promise<Uint8Array> {
    return readFactoryArchiveImmutable(this.options, this.client, this.root, reference);
  }

  async list(tenantId: string, kind: FactoryRecoveryRecordKind, recordId: string, signal?: AbortSignal): Promise<readonly FactoryArchiveObject[]> {
    const prefix = this.recordPrefix(tenantId, kind, recordId);
    return (await this.versions(`${prefix}/`, signal)).flatMap(object => object.key.slice(prefix.length + 1).includes("/") ? [] : [object]);
  }

  async operations(tenantId: string, signal?: AbortSignal): Promise<readonly FactoryArchivedReleaseObjects[]> {
    const prefix = `${this.tenantPrefix(tenantId)}/`;
    const operations = new Map<string, { intent: FactoryArchiveObject[]; material: FactoryArchiveObject[]; receipt: FactoryArchiveObject[]; reconciliation: FactoryArchiveObject[] }>();
    for (const object of await this.versions(prefix, signal)) {
      const parts = object.key.slice(prefix.length).split("/");
      if (parts.length !== 3 || !RELEASE_NAMES.has(parts[1]!)) continue;
      const operationId = decodeSegment(parts[0]!);
      if (operationId === null) continue;
      const entry = operations.get(operationId) ?? { intent: [], material: [], receipt: [], reconciliation: [] };
      entry[parts[1] as keyof typeof entry].push(object);
      operations.set(operationId, entry);
    }
    return [...operations.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([operationId, objects]) => Object.freeze({ operationId, ...objects }));
  }

  /** The current version of every content-addressed object under a prefix, across every listing page. */
  private async versions(prefix: string, signal?: AbortSignal): Promise<FactoryArchiveObject[]> {
    const objects: FactoryArchiveObject[] = [];
    let keyMarker: string | undefined;
    let versionMarker: string | undefined;
    for (let seen = 0; ;) {
      const page = await this.client.send(new ListObjectVersionsCommand({ Bucket: this.options.bucket, Prefix: prefix, MaxKeys: FACTORY_RECOVERY_LIST_PAGE, KeyMarker: keyMarker, VersionIdMarker: versionMarker }), signal ? { abortSignal: signal } : undefined) as {
        Versions?: ReadonlyArray<{ Key?: string; VersionId?: string; IsLatest?: boolean }>; IsTruncated?: boolean; NextKeyMarker?: string; NextVersionIdMarker?: string;
      };
      for (const version of page.Versions ?? []) {
        seen += 1;
        if (seen > FACTORY_RECOVERY_LIST_LIMIT) throw new FactoryRecoveryArchiveError("factory_recovery_archive_too_large");
        const key = version.Key;
        if (!key || !version.VersionId || version.IsLatest === false || !key.startsWith(prefix)) continue;
        const raw = key.slice(key.lastIndexOf("/") + 1);
        if (!DIGEST.test(raw)) continue;
        objects.push({ key, digest: `sha256:${raw}`, versionId: version.VersionId });
      }
      if (!page.IsTruncated) return objects;
      if (!page.NextKeyMarker) throw new FactoryRecoveryArchiveError("factory_recovery_archive_corrupt");
      keyMarker = page.NextKeyMarker;
      versionMarker = page.NextVersionIdMarker;
    }
  }
}

/** Canonical JSON write, read back byte for byte before the reference is returned. */
export async function writeFactoryRecoveryJson(archive: FactoryRecoveryArchive, tenantId: string, kind: FactoryRecoveryRecordKind, recordId: string, value: unknown, signal?: AbortSignal): Promise<FactoryArchiveObject> {
  const bytes = new TextEncoder().encode(canonicalJson(value));
  const reference = await archive.write(tenantId, kind, recordId, bytes, signal);
  if (reference.digest !== `sha256:${digestBytes(bytes)}`) throw new FactoryRecoveryArchiveError("factory_recovery_archive_corrupt");
  const restored = await archive.read(reference, signal);
  if (Buffer.compare(Buffer.from(restored), Buffer.from(bytes)) !== 0) throw new FactoryRecoveryArchiveError("factory_recovery_archive_corrupt");
  return reference;
}

/** Reads one archived JSON record. The archive already verified the bytes against the digest. */
export async function readFactoryRecoveryJson<Value>(archive: Pick<FactoryRecoveryArchive, "read">, reference: FactoryArchiveObject, signal?: AbortSignal): Promise<Value> {
  const bytes = await archive.read(reference, signal);
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as Value; }
  catch { throw new FactoryRecoveryArchiveError("factory_recovery_archive_corrupt"); }
}

/** An archive reference parsed from a stored column, validated before any read. */
export function parseFactoryArchiveReference(value: unknown): FactoryArchiveObject {
  const candidate = typeof value === "string" ? (() => { try { return JSON.parse(value) as unknown; } catch { return null; } })() : value;
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) throw new FactoryRecoveryArchiveError("factory_recovery_archive_invalid");
  const record = candidate as Record<string, unknown>;
  if (typeof record.key !== "string" || record.key.length === 0 || record.key.length > 2048 || typeof record.digest !== "string" || !/^sha256:[a-f0-9]{64}$/.test(record.digest)
    || typeof record.versionId !== "string" || record.versionId.length === 0 || record.versionId.length > 1024 || Object.keys(record).some(key => !["key", "digest", "versionId"].includes(key))) throw new FactoryRecoveryArchiveError("factory_recovery_archive_invalid");
  return Object.freeze({ key: record.key, digest: record.digest, versionId: record.versionId });
}
