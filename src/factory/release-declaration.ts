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
 * **Each declared profile is the owner's profile, built once.** A provider
 * publishes an operation somebody else prepared; a PROFILE is the other half,
 * turning a definition's release node into the request the provider will
 * publish. Neither is invented here:
 *
 * - An `s3` destination gets W08's `S3FactoryManifestReleaseProfile`, over
 *   W08b's `FactoryVerifiedAttemptMaterials`. That reader is attempt-agnostic
 *   at construction and re-derives the NAMED attempt's own authority on every
 *   call, so one instance built at startup serves whichever attempt an
 *   acceptance decision names. The bytes that reach S3 are the sealed records
 *   the acceptance decision froze.
 * - A `github` destination gets a synchronous profile lifted through W05's
 *   `factorySynchronousReleaseProfile`. The accepted candidate IS W07's
 *   publication request, so the profile validates it with W07's own
 *   `assertFactoryGitHubPublicationRequest` and names the one destination
 *   object `FactoryGitHubReleaseProvider` accepts for it. Nothing is rebuilt:
 *   the approved bytes are the published bytes.
 *
 * The declared cost is the budgeted cost of one release, so both profiles carry
 * it as the estimated spend. A destination kind with no buildable profile is a
 * named refusal at composition, never an empty set that refuses later.
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
import { assertFactoryGitHubPublicationRequest, FactoryGitHubError, FactoryGitHubReleaseProvider } from "./release-github";
import { FactoryReleaseError, type FactoryReleaseOperation, type FactoryReleaseProvider, type FactoryReleases } from "./releases";
import { factorySynchronousReleaseProfile, type FactoryReleaseCommandProfile, type FactoryReleaseCommandProfileInput } from "./protected-command-effects";
import type { FactoryReleaseProviderResolver } from "./release-application";
import type { FactoryStartupConfig, FactoryStartupReleaseDestination, FactoryStartupReleaseProfile } from "./startup-config";
import type { FactoryS3PublicationAttempts } from "./release-s3-publication";
import { S3FactoryManifestReleaseProfile, type FactoryS3PublicationProvenance } from "./release-s3-scope";
import { sealFactoryReleaseProfileResult } from "./release-profile";
import type { FactoryMaterialService, FactoryScopedArtifactReader } from "./artifact-materials";

/** A token file is a credential, so it is bounded like every other one. */
const MAX_RELEASE_TOKEN_BYTES = 16 * 1024;

export class FactoryReleaseDestinationError extends Error {
  readonly code: string;
  constructor(code: "factory_release_destination_unreadable" | "factory_release_destination_unknown" | "factory_release_destination_foreign" | "factory_release_profile_unbuildable" | "factory_release_profile_asynchronous",
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
  /**
   * The verified protected provenance, in both of its roles: the attempt a
   * publication reads its members under, and the attempt an S3 profile lists
   * the sealed materials of. One object, so the attempt has one derivation.
   */
  readonly attempts: FactoryS3PublicationAttempts & Pick<FactoryS3PublicationProvenance, "attemptForDecision">;
  /** W08b's attempt-agnostic reader of one named attempt's sealed materials. */
  readonly materials: Pick<FactoryMaterialService, "list">;
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
  /** The adapter profiles `FactoryProtectedCommandEffects` will trust, one per declared profile. */
  readonly profiles: readonly FactoryReleaseCommandProfile[];
  /** The declared destination names, for the readiness report. */
  readonly destinations: readonly string[];
}

/**
 * The GitHub half: the accepted candidate is W07's publication request.
 *
 * Validated by W07's own rule set, so a candidate the provider would refuse is
 * refused here, before an operation exists. The destination object is the one
 * shape `FactoryGitHubReleaseProvider` accepts for that request, and the
 * release node may name the repository but never a different one.
 */
function githubReleaseRequest(repository: string, estimatedSpendMicros: number) {
  return (input: FactoryReleaseCommandProfileInput) => {
    const { request } = assertFactoryGitHubPublicationRequest(input.acceptedCandidate);
    const requested = input.destination as { provider?: unknown; account?: unknown } | null;
    if (!requested || typeof requested !== "object" || Array.isArray(requested) || requested.provider !== "github" || requested.account !== repository) {
      throw new FactoryGitHubError("factory_github_foreign_target");
    }
    return { destination: { provider: "github", account: repository, object: `pull-request/${request.baseBranch}/${request.commitSha}` }, request: input.acceptedCandidate, estimatedSpendMicros };
  };
}

/**
 * The S3 half: W08's manifest profile, carrying the declared cost.
 *
 * `S3FactoryManifestReleaseProfile` implements only `resolve`, because listing
 * the sealed materials is I/O and a synchronous `build` cannot do it. The
 * trusted-profile surface still requires `build`, so it refuses by name rather
 * than answering something `resolve` did not produce.
 */
function s3ReleaseProfile(profile: FactoryStartupReleaseProfile, account: string, collaborators: FactoryReleaseDestinationCollaborators): FactoryReleaseCommandProfile {
  const manifest = new S3FactoryManifestReleaseProfile({ adapter: profile.adapter, action: profile.action, account, provenance: collaborators.attempts, materials: collaborators.materials });
  return Object.freeze({
    adapter: manifest.adapter,
    action: manifest.action,
    build(): never {
      throw new FactoryReleaseDestinationError("factory_release_profile_asynchronous", profile.destination, "an S3 manifest profile reads sealed materials and resolves only asynchronously");
    },
    async resolve(input, signal) {
      const resolved = await manifest.resolve(input, signal);
      return sealFactoryReleaseProfileResult(input, { destination: resolved.destination, request: resolved.request, estimatedSpendMicros: profile.estimatedSpendMicros }, resolved.resolvedAtMs);
    },
  } satisfies FactoryReleaseCommandProfile);
}

/** One declared profile, over the destination it names, or a refusal by name. */
function declaredReleaseProfile(profile: FactoryStartupReleaseProfile, destination: FactoryStartupReleaseDestination, collaborators: FactoryReleaseDestinationCollaborators): FactoryReleaseCommandProfile {
  switch (destination.kind) {
    case "s3":
      return s3ReleaseProfile(profile, destination.account, collaborators);
    case "github":
      return factorySynchronousReleaseProfile({ adapter: profile.adapter, action: profile.action, build: githubReleaseRequest(destination.repository, profile.estimatedSpendMicros) });
    default:
      throw new FactoryReleaseDestinationError("factory_release_profile_unbuildable", profile.destination, `no release profile can be built for destination kind ${JSON.stringify((destination as { kind?: unknown }).kind)}`);
  }
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
    } else if (destination.kind === "github") {
      // Proved readable at composition so a misconfigured token is a startup
      // refusal, and re-read per call so a rotation does not need a restart.
      await readPrivateCredential(destination.name, destination.tokenPath, MAX_RELEASE_TOKEN_BYTES);
    }
    // Any other kind has nothing to read here. The document validator refuses
    // it first; a profile that names one is refused by name below.
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
    profiles: Object.freeze(declaration.profiles.map((profile) => declaredReleaseProfile(profile, byName.get(profile.destination)!, collaborators))),
    destinations: Object.freeze(declaration.destinations.map((destination) => destination.name)),
  });
}
