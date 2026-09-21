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
 * **The declaration composes PROVIDERS, and deliberately composes no profile.**
 * A provider publishes an operation somebody else prepared, and building one
 * needs only a destination and its credentials — which is exactly what the
 * declaration carries. A PROFILE is the other half: it turns a definition's
 * release node into the request the provider will publish, and for an S3
 * manifest destination W08 already publishes the real one,
 * `S3FactoryManifestReleaseProfile`, which reads the verified attempt and the
 * sealed materials so the bytes that reach S3 are the bytes the acceptance
 * decision froze.
 *
 * This file does NOT invent a substitute for it. An identity profile — pass
 * the accepted candidate through as the request — composes and then fails at
 * the wrong moment: `requestRelease` would create the operation, the running
 * role would CLAIM it, and `S3FactoryManifestReleaseProvider.publish` would
 * refuse the request as invalid, leaving a claimed operation that can never
 * succeed. Refusing at prepare time is the smaller failure and the honest one,
 * so `requestRelease` keeps answering `factory_protected_effect_untrusted`
 * until the owner's profile can be built.
 *
 * What blocks building it here is named rather than guessed:
 * `S3FactoryManifestReleaseProfile` takes `Pick<FactoryMaterialService,
 * "list">`, and the only implementation of that surface is
 * `FactoryAttemptMaterials`, which is bound to ONE attempt's authority
 * (`assertOwnScopeOnly` plus `authorizeMaterialReadInTransaction`). A release
 * profile resolves for whichever attempt the decision names, so one instance
 * cannot serve it. **Interface question for W04 and W08** in the gate file.
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
import { FactoryReleaseError, type FactoryReleaseOperation, type FactoryReleaseProvider, type FactoryReleases } from "./releases";
import type { FactoryReleaseCommandProfile } from "./protected-command-effects";
import type { FactoryReleaseProviderResolver } from "./release-application";
import type { FactoryStartupConfig, FactoryStartupReleaseDestination } from "./startup-config";
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
  /**
   * The adapter profiles `FactoryProtectedCommandEffects` will trust.
   *
   * Empty today, and that is a refusal rather than a gap: see this file's
   * header. `requestRelease` answers `factory_protected_effect_untrusted`
   * until an owner's profile can be built, which is a refusal at prepare time
   * instead of a claimed operation that can never publish.
   */
  readonly profiles: readonly FactoryReleaseCommandProfile[];
  /** The declared destination names, for the readiness report. */
  readonly destinations: readonly string[];
  /** Each declared profile that could not be composed, and why. */
  readonly uncomposedProfiles: readonly FactoryUncomposedReleaseProfile[];
}

/** Why a declared profile could not be composed, so the gap is readable. */
export interface FactoryUncomposedReleaseProfile {
  /** The declared profile's destination name. */
  readonly destination: string;
  readonly kind: "s3" | "github";
  readonly reason: string;
}

/**
 * The profile a declared destination WOULD need, and why it is not built.
 *
 * Kept as data rather than as a comment so the readiness report can carry it:
 * an operator who declared a destination and sees `requestRelease` refuse is
 * otherwise looking for a bug that is really a missing collaborator.
 */
function uncomposedProfile(declared: FactoryStartupReleaseDestination): FactoryUncomposedReleaseProfile {
  return Object.freeze({
    destination: declared.name,
    kind: declared.kind,
    reason: declared.kind === "s3"
      ? "W08's S3FactoryManifestReleaseProfile is the real profile for this destination, and it takes Pick<FactoryMaterialService,\"list\">; the only implementation, FactoryAttemptMaterials, is bound to one attempt's authority, so this composition cannot build one that serves whichever attempt a decision names (W04 owns the material service; W08 owns the profile)"
      : "no owner has published a release profile for a git destination; FactoryGitHubReleaseProvider publishes a plan it does not build, and inventing the plan here would publish a shape no adapter agreed to (W07 owns the adapter)",
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

  return Object.freeze({
    providers,
    profiles: Object.freeze([]),
    destinations: Object.freeze(declaration.destinations.map((destination) => destination.name)),
    uncomposedProfiles: Object.freeze(declaration.profiles.map((profile) => uncomposedProfile(byName.get(profile.destination)!))),
  });
}
