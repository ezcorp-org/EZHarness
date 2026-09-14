/**
 * W04a's handover, wired: the archive writer becomes the release store's
 * archive, and publication readiness is a visible verdict rather than an error.
 *
 * W04a landed `FactoryArchiveWriter` and recorded that no production code
 * constructed `FactoryReleases`, so the archive-before-claim step existed and
 * was never composed. This file is that composition, and it keeps the two
 * facts W04a made explicit:
 *
 *   - The archive holds the archive credential set and nothing else. The
 *     product store's credentials reach the denial probe, never the writer.
 *   - On this host `publicationGrade` is false, because both stores live here.
 *     That is surfaced as a field on a successful readiness result, not raised
 *     as a failure: a same-host deployment is operationally ready and is not
 *     publication grade, and one boolean cannot say both.
 */
import { basename, dirname, resolve } from "node:path";
import {
  FactoryArchiveWriter,
  factoryArchiveFailureDomain,
  factoryArchivePublicationSet,
  S3FactoryArchiveInventory,
  type FactoryArchiveDenialAttempt,
  type FactoryArchiveDenialProbe,
  type FactoryArchiveMemberSources,
  type FactoryArchiveReadinessResult,
} from "./archive-writer";
import { S3FactoryReleaseArchive } from "./release-adapters";
import type { FactoryScopedArtifactReader } from "./artifact-materials";
import type { FactoryReleaseMaterial } from "./releases";
import { privateDirectory, readPrivateBounded } from "./private-files";
import type { FactoryStartupStorage } from "./startup-config";

const MAX_CREDENTIAL_BYTES = 64 * 1024;

export class FactoryStorageCredentialError extends Error {
  readonly code = "factory-storage-credentials-unusable";
  constructor(readonly credentialSet: string) {
    super(`Factory storage credential set '${credentialSet}' is missing or malformed.`);
    this.name = "FactoryStorageCredentialError";
  }
}

export interface FactoryStorageCredentials {
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
}

function credentialText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 512 && !value.includes("\0");
}

/**
 * Read one tenant's credentials out of a credential-set file.
 *
 * The shape is the one the provisioner writes and the storage proofs read:
 * `{ identities: [{ name, credentials: [{ accessKey, secretKey }] }] }`. It is
 * read through the private bounded reader, and no value from it is ever put in
 * an error, a log line, or a record — only the set's NAME travels, which is
 * what the failure-domain record is built from.
 */
export async function loadFactoryStorageCredentials(storage: FactoryStartupStorage, tenantId: string): Promise<FactoryStorageCredentials> {
  const absolute = resolve(storage.credentialsPath);
  let parsed: unknown;
  try {
    const directory = await privateDirectory(dirname(absolute));
    let bytes: Uint8Array;
    try {
      bytes = await readPrivateBounded(directory, basename(absolute), MAX_CREDENTIAL_BYTES);
    } finally {
      await directory.close();
    }
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new FactoryStorageCredentialError(storage.credentialSet);
  }
  const identities = (parsed as { identities?: unknown })?.identities;
  if (!Array.isArray(identities)) throw new FactoryStorageCredentialError(storage.credentialSet);
  const identity = identities.find((item) => (item as { name?: unknown })?.name === tenantId) as { credentials?: unknown } | undefined;
  const credential = Array.isArray(identity?.credentials) ? identity.credentials[0] as { accessKey?: unknown; secretKey?: unknown } : undefined;
  if (!credentialText(credential?.accessKey) || !credentialText(credential?.secretKey)) throw new FactoryStorageCredentialError(storage.credentialSet);
  return Object.freeze({ accessKeyId: credential.accessKey, secretAccessKey: credential.secretKey });
}

/** The non-archive credential sets the denial probe attempts with. */
export interface FactoryDenialCredentialSets {
  readonly product: FactoryStorageCredentials;
  readonly restore?: FactoryStorageCredentials;
}

/** One attempt against the archive with a credential set that must be refused. */
export interface FactoryArchiveDenialAttemptTarget {
  attempt(credentials: FactoryStorageCredentials, attempt: FactoryArchiveDenialAttempt, signal?: AbortSignal): Promise<"denied" | "permitted">;
}

/**
 * A denial probe that really attempts the operation with the wrong credentials.
 *
 * W04a's lesson holds: prove a denial with the status, not with the absence of
 * success. A probe that cannot reach the store at all must report `permitted`,
 * because an unreachable store has proved nothing about its permissions and a
 * readiness result that reads an outage as a passing denial is worse than one
 * that fails.
 */
export function factoryArchiveDenialProbe(
  credentials: FactoryDenialCredentialSets,
  target: FactoryArchiveDenialAttemptTarget,
): FactoryArchiveDenialProbe {
  return Object.freeze({
    async attempt(attempt: FactoryArchiveDenialAttempt, signal?: AbortSignal): Promise<"denied" | "permitted"> {
      const set = attempt.credentialSet === "product" ? credentials.product : credentials.restore;
      // A restore credential set that is not configured cannot be shown to be
      // refused, so the check does not pass on its absence.
      if (!set) return "permitted";
      return target.attempt(set, attempt, signal);
    },
  });
}

export interface FactoryArchiveCompositionOptions {
  readonly tenantId: string;
  readonly ordinary: FactoryStartupStorage;
  readonly archive: FactoryStartupStorage;
  /** W04's one scoped reader. Every archived member is read through it. */
  readonly reader: FactoryScopedArtifactReader;
  /** W07/W08 supply the pinned attempt scope a release operation archives from. */
  readonly resolveMembers: (tenantId: string, operationId: string, material: FactoryReleaseMaterial, signal?: AbortSignal) => FactoryArchiveMemberSources | Promise<FactoryArchiveMemberSources>;
  readonly denialProbe?: FactoryArchiveDenialProbe;
  /** An operator's verified replication statement. Absent on a development host. */
  readonly replicationEvidence?: string;
  readonly archiveCredentials: FactoryStorageCredentials;
  readonly archiveClient?: ConstructorParameters<typeof S3FactoryArchiveInventory>[0]["client"];
  readonly now?: () => number;
}

/**
 * Build the archive-writer role.
 *
 * The S3 client is built once from the archive credential set and shared by
 * the adapter and the inventory, which is the wiring the storage proofs use
 * and the reason the role can list an operation's members during a restore
 * that has only the archive.
 */
export function composeFactoryArchiveWriter(options: FactoryArchiveCompositionOptions): FactoryArchiveWriter {
  const failureDomain = factoryArchiveFailureDomain({
    productEndpoint: options.ordinary.endpoint,
    archiveEndpoint: options.archive.endpoint,
    productCredentialSet: options.ordinary.credentialSet,
    archiveCredentialSet: options.archive.credentialSet,
    ...(options.replicationEvidence === undefined ? {} : { independentReplicationEvidence: options.replicationEvidence }),
  });
  const archive = new S3FactoryReleaseArchive({
    endpoint: options.archive.endpoint,
    bucket: options.archive.bucket,
    prefix: options.archive.prefix,
    credentials: options.archiveCredentials,
    ...(options.archiveClient === undefined ? {} : { client: options.archiveClient }),
  });
  const inventory = new S3FactoryArchiveInventory({
    endpoint: options.archive.endpoint,
    bucket: options.archive.bucket,
    root: options.archive.prefix,
    credentials: options.archiveCredentials,
    ...(options.archiveClient === undefined ? {} : { client: options.archiveClient }),
  });
  return new FactoryArchiveWriter({
    archive,
    reader: options.reader,
    publicationSet: factoryArchivePublicationSet(options.resolveMembers),
    failureDomain,
    inventory,
    ...(options.denialProbe === undefined ? {} : { denialProbe: options.denialProbe }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
}

export interface FactoryPublicationReadiness extends FactoryArchiveReadinessResult {
  /** Why publication is withheld, in the operator's words. Empty when it is not. */
  readonly withheldBecause: readonly string[];
}

/**
 * Ask the writer, and report a same-host verdict as visible rather than failed.
 *
 * `checkReadiness` writes two real objects, so this is a live check and not an
 * inspection of configuration.
 */
export async function factoryPublicationReadiness(
  writer: Pick<FactoryArchiveWriter, "checkReadiness">,
  tenantId: string,
  operationId: string,
  signal?: AbortSignal,
): Promise<FactoryPublicationReadiness> {
  const result = await writer.checkReadiness(tenantId, operationId, signal);
  const withheldBecause = result.publicationGrade
    ? []
    : [...result.unmetCriteria, ...result.checks.filter((check) => !check.passed).map((check) => check.id)];
  return Object.freeze({ ...result, withheldBecause: Object.freeze([...new Set(withheldBecause)]) });
}
