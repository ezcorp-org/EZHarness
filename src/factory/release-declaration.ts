/**
 * The declared release destinations, turned into the two things a release needs.
 *
 * `FactoryProtectedCommandEffects` needs a PROFILE set to turn a definition's
 * release node into an operation, and `release-outcome` needs a PROVIDER
 * resolver to publish the claimed operation. Both were empty because the
 * startup document had nowhere to say where a release publishes; both are
 * built here from `config.release`.
 *
 * Three rules shape this file, and each one is a refusal rather than a default.
 *
 * **A credential is a reference until the moment it is read.** Every path in
 * the declaration is read through `readPrivateBounded`, which refuses a file
 * that is missing, not a regular file, not owned by this process, or readable
 * by anyone else. A value never enters the document, an error message, or a
 * report line — a failure names the destination and the field, never the
 * bytes.
 *
 * **A profile names where it publishes and nothing else about the payload.**
 * The definition's release node supplies the object and the accepted candidate;
 * the deployment supplies the account, the credentials, and the cost. So
 * `build` combines the two and refuses a requested destination that disagrees
 * with the declaration. It never transforms the payload: a profile that
 * rewrote what a factory produced would publish bytes the acceptance decision
 * never sealed.
 *
 * **A GitHub provider is built per operation, not per installation.**
 * `FactoryGitHubReleaseProvider` binds a project for the shared transport's
 * audit, and takes an `authorize` that runs immediately before every network
 * call. The resolver already holds the operation, so binding both to it is
 * exact: the recheck re-reads THAT operation and refuses unless it is still
 * executing at the generation the claim took.
 */
import type { TransactionalDb } from "../db/migrations/types";
import { basename, dirname, resolve as resolvePath } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { privateDirectory, readPrivateBounded } from "./private-files";
import { loadFactoryStorageCredentials, type FactoryStorageCredentials } from "./release-composition";
import { S3FactoryManifestReleaseProvider } from "./release-s3-publication";
import { FactoryGitHubReleaseProvider } from "./release-github";
import { FactoryReleaseError, type FactoryReleaseDestination, type FactoryReleaseOperation, type FactoryReleaseProvider, type FactoryReleases } from "./releases";
import { factorySynchronousReleaseProfile, type FactoryReleaseCommandProfile, type FactoryReleaseCommandProfileInput, type FactoryReleaseCommandProfileResult } from "./protected-command-effects";
import type { FactoryReleaseProviderResolver } from "./release-application";
import type { FactoryStartupConfig, FactoryStartupReleaseDestination, FactoryStartupReleaseProfile } from "./startup-config";
import type { FactoryS3PublicationAttempts } from "./release-s3-publication";
import type { FactoryScopedArtifactReader } from "./artifact-materials";

/** A token file is a credential, so it is bounded like every other one. */
const MAX_RELEASE_TOKEN_BYTES = 16 * 1024;

export class FactoryReleaseDestinationError extends Error {
  readonly code: string;
  constructor(code: "factory_release_destination_unreadable" | "factory_release_destination_unknown" | "factory_release_destination_foreign",
    readonly destination: string, message: string) {
    super(`${code}: ${destination}: ${message}`);
    this.code = code;
    this.name = "FactoryReleaseDestinationError";
  }
}

/** Read one private file, naming the destination rather than the bytes. */
async function readPrivateCredential(destination: string, path: string, maximumBytes: number): Promise<Uint8Array> {
  const absolute = resolvePath(path);
  let directory: FileHandle;
  try {
    directory = await privateDirectory(dirname(absolute));
  } catch (error) {
    throw new FactoryReleaseDestinationError("factory_release_destination_unreadable", destination, `its credential directory is not private (${(error as Error).message})`);
  }
  try {
    return await readPrivateBounded(directory, basename(absolute), maximumBytes);
  } catch (error) {
    // The message says what is wrong with the FILE — missing, shared, too
    // large — and never what is in it.
    throw new FactoryReleaseDestinationError("factory_release_destination_unreadable", destination, `its credential file is not readable and private (${(error as Error).message})`);
  } finally {
    await directory.close();
  }
}

/**
 * The four things a GitHub publication needs, bound to ONE operation.
 *
 * Exported because both halves are this file's own behaviour and neither is
 * reachable once the provider owns them: `readToken` is what makes a rotated
 * token file take effect without a restart, and `authorize` is the only thing
 * standing between a claim this worker has lost and a release it sends anyway.
 * Testing them through the provider would mean reaching into its private
 * options, which is somebody else's field.
 */
export function factoryGitHubReleaseOptions(
  declared: FactoryStartupReleaseDestination & { readonly kind: "github" },
  operation: FactoryReleaseOperation,
  releases: Pick<FactoryReleases, "inspect">,
): Pick<ConstructorParameters<typeof FactoryGitHubReleaseProvider>[0], "repository" | "projectId" | "authorize" | "readToken"> {
  const generation = operation.dispatchGeneration;
  return {
    repository: declared.repository,
    projectId: operation.projectId,
    // The one authority recheck the transport asks for, against the one durable
    // fact that can have moved: a claim this worker no longer holds must not
    // send, and a settled release must not be re-sent.
    authorize: async () => {
      const current = await releases.inspect(operation.projectId, operation.operationId);
      if (current?.state !== "executing" || current.dispatchGeneration !== generation || current.senderToken !== operation.senderToken) {
        throw new FactoryReleaseError("factory_release_sender_fenced");
      }
    },
    // Read per call, so rotating the file rotates what the next release sends.
    // An emptied file is an ABSENT credential rather than an empty one, which
    // is what the transport's `string | null` distinguishes.
    readToken: async () => {
      const bytes = await readPrivateCredential(declared.name, declared.tokenPath, MAX_RELEASE_TOKEN_BYTES);
      const token = new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim();
      return token.length === 0 ? null : token;
    },
  };
}

export interface FactoryReleaseDestinationCollaborators {
  readonly database: TransactionalDb;
  readonly tenantId: string;
  /** W04's one scoped reader. Every published member's bytes come from it. */
  readonly reader: FactoryScopedArtifactReader;
  /** The pinned attempt scope a publication reads its members under. */
  readonly attempts: FactoryS3PublicationAttempts;
  /** Re-read immediately before a network call, so a lost claim stops a send. */
  readonly releases: Pick<FactoryReleases, "inspect">;
  /** Overridden in tests so a publication is not a real network dependency. */
  readonly s3Client?: ConstructorParameters<typeof S3FactoryManifestReleaseProvider>[0]["client"];
  /** Overridden in tests so a GitHub call is not a real network dependency. */
  readonly githubRequest?: ConstructorParameters<typeof FactoryGitHubReleaseProvider>[0]["request"];
}

export interface FactoryComposedReleaseDestinations {
  /** Which provider publishes one operation, by its persisted destination. */
  readonly providers: FactoryReleaseProviderResolver;
  /** The adapter profiles `FactoryProtectedCommandEffects` will trust. */
  readonly profiles: readonly FactoryReleaseCommandProfile[];
  /** The declared destination names, for the readiness report. */
  readonly destinations: readonly string[];
}

/**
 * The destination a profile publishes to, as the wire will carry it.
 *
 * The declaration fixes the provider and the account. The definition's release
 * node supplies the object, and may pin the version it expects to replace.
 * Anything else in the requested destination is an operator or an author
 * disagreeing about which field is theirs, and reading past it would publish to
 * a place one of them did not choose.
 */
function exactDestination(declared: FactoryStartupReleaseDestination, requested: unknown): FactoryReleaseDestination {
  const account = declared.kind === "s3" ? declared.account : declared.repository;
  if (typeof requested !== "object" || requested === null || Array.isArray(requested)) {
    throw new FactoryReleaseDestinationError("factory_release_destination_foreign", declared.name, "the release node named no destination object");
  }
  const asked = requested as Record<string, unknown>;
  const allowed = ["object", "expectedVersion", "provider", "account"];
  if (Object.keys(asked).some((key) => !allowed.includes(key))) {
    throw new FactoryReleaseDestinationError("factory_release_destination_foreign", declared.name, "the release node named a destination field the deployment owns");
  }
  if (typeof asked.object !== "string" || asked.object.length === 0 || asked.object.length > 1_024 || asked.object.includes("\0")) {
    throw new FactoryReleaseDestinationError("factory_release_destination_foreign", declared.name, "the release node named no usable destination object");
  }
  // A definition may RESTATE the provider and account it expects, and that is
  // worth honouring as a check: an author who moved a release to another
  // repository should get a refusal here rather than a publication to the
  // deployment's own account.
  if (asked.provider !== undefined && asked.provider !== declared.kind) {
    throw new FactoryReleaseDestinationError("factory_release_destination_foreign", declared.name, "the release node expects another provider");
  }
  if (asked.account !== undefined && asked.account !== account) {
    throw new FactoryReleaseDestinationError("factory_release_destination_foreign", declared.name, "the release node expects another account");
  }
  if (asked.expectedVersion !== undefined && (typeof asked.expectedVersion !== "string" || asked.expectedVersion.length === 0 || asked.expectedVersion.length > 512)) {
    throw new FactoryReleaseDestinationError("factory_release_destination_foreign", declared.name, "the release node named an unusable expected version");
  }
  return Object.freeze({
    provider: declared.kind,
    account,
    object: asked.object,
    ...(asked.expectedVersion === undefined ? {} : { expectedVersion: asked.expectedVersion as string }),
  });
}

/**
 * One declared profile, lifted onto the asynchronous surface W05 published.
 *
 * `build` is deliberately the identity on the payload: the request IS the
 * accepted candidate the decision sealed, and `sealFactoryReleaseProfileResult`
 * binds it to that decision and the pinned material. What the profile adds is
 * the destination and the declared cost.
 */
function composeProfile(declared: FactoryStartupReleaseProfile, destination: FactoryStartupReleaseDestination): FactoryReleaseCommandProfile {
  return factorySynchronousReleaseProfile({
    adapter: declared.adapter,
    action: declared.action,
    build(input: FactoryReleaseCommandProfileInput): FactoryReleaseCommandProfileResult {
      return {
        destination: exactDestination(destination, input.destination),
        request: input.acceptedCandidate,
        estimatedSpendMicros: declared.estimatedSpendMicros,
      };
    },
  });
}

/**
 * Compose every declared destination, or answer `undefined` when none is.
 *
 * A declaration that cannot be read is NOT a silent absence. It raises, and the
 * caller reports it under its own role, because an installation that declared a
 * destination and got none would hold `release-outcome` with a reason that says
 * "nothing declared" while the operator is looking at their declaration.
 */
export async function composeFactoryReleaseDestinations(
  config: Pick<FactoryStartupConfig, "release">,
  collaborators: FactoryReleaseDestinationCollaborators,
): Promise<FactoryComposedReleaseDestinations | undefined> {
  const declaration = config.release;
  if (declaration === undefined) return undefined;

  const byName = new Map<string, FactoryStartupReleaseDestination>();
  const credentials = new Map<string, FactoryStorageCredentials>();
  for (const destination of declaration.destinations) {
    byName.set(destination.name, destination);
    if (destination.kind === "s3") {
      // Read once at composition. The publisher holds the destination's own
      // credential set and nothing else — never the archive's, never the
      // product store's.
      credentials.set(destination.name, await loadFactoryStorageCredentials(
        { endpoint: destination.endpoint, bucket: destination.bucket, prefix: destination.prefix ?? "", credentialSet: destination.name, credentialsPath: destination.credentialsPath },
        collaborators.tenantId,
      ).catch((error: unknown) => {
        throw new FactoryReleaseDestinationError("factory_release_destination_unreadable", destination.name, `its credential set did not load (${(error as Error).message})`);
      }));
    } else {
      // Proved readable at composition so a misconfigured token is a startup
      // refusal, and re-read per call so a rotation does not need a restart.
      await readPrivateCredential(destination.name, destination.tokenPath, MAX_RELEASE_TOKEN_BYTES);
    }
  }

  // One publisher per declared S3 destination, keyed by the account the wire
  // carries, because that is what an operation's destination names.
  const s3 = new Map<string, FactoryReleaseProvider>();
  for (const destination of declaration.destinations) {
    if (destination.kind !== "s3") continue;
    s3.set(destination.account, new S3FactoryManifestReleaseProvider({
      endpoint: destination.endpoint,
      bucket: destination.bucket,
      account: destination.account,
      ...(destination.prefix === undefined ? {} : { prefix: destination.prefix }),
      credentials: { ...credentials.get(destination.name)! },
      reader: collaborators.reader,
      attempts: collaborators.attempts,
      ...(collaborators.s3Client === undefined ? {} : { client: collaborators.s3Client }),
    }));
  }
  const github = new Map<string, FactoryStartupReleaseDestination & { readonly kind: "github" }>();
  for (const destination of declaration.destinations) {
    if (destination.kind === "github") github.set(destination.repository, destination);
  }

  const providers: FactoryReleaseProviderResolver = Object.freeze({
    async resolve(operation: FactoryReleaseOperation): Promise<FactoryReleaseProvider> {
      if (operation.destination.provider === "s3") {
        const provider = s3.get(operation.destination.account);
        if (!provider) throw new FactoryReleaseDestinationError("factory_release_destination_unknown", operation.destination.account, "no S3 destination is declared for this account");
        return provider;
      }
      const declared = github.get(operation.destination.account);
      if (!declared) throw new FactoryReleaseDestinationError("factory_release_destination_unknown", operation.destination.account, "no GitHub destination is declared for this repository");
      return new FactoryGitHubReleaseProvider({
        ...factoryGitHubReleaseOptions(declared, operation, collaborators.releases),
        ...(collaborators.githubRequest === undefined ? {} : { request: collaborators.githubRequest }),
      });
    },
  });

  const profiles = declaration.profiles.map((profile) => composeProfile(profile, byName.get(profile.destination)!));
  return Object.freeze({
    providers,
    profiles: Object.freeze(profiles),
    destinations: Object.freeze(declaration.destinations.map((destination) => destination.name)),
  });
}
