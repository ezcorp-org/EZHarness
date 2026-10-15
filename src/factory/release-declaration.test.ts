/**
 * The declared release destinations, composed.
 *
 * Every test here asserts the same property from a different side: the
 * composition reads the declaration and refuses anything it did not declare.
 * A destination nobody named, a credential file anyone can read, a release node
 * that names another account — each is a named refusal rather than a default,
 * because the one substitute that cannot be walked back is publishing to a
 * place nobody chose.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { chmod, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { S3FactoryManifestReleaseProvider } from "./release-s3-publication";
import { FactoryGitHubReleaseProvider } from "./release-github";
import type { FactoryReleaseOperation } from "./releases";
import type { FactoryAcceptanceDecision } from "./assurance";
import type { FactoryMaterialRecord, FactoryMaterialScope } from "./artifact-materials";
import { FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION } from "./release-s3-scope";
import { assertFactoryReleaseProfileResult, factoryReleaseProfileInputDigest } from "./release-profile";
import { FactoryProtectedCommandEffects } from "./protected-command-effects";
import { factoryGitBranchBinding } from "./release-git-refs";
import { digestBytes } from "../extensions/v4/blobs";
import { FACTORY_GITHUB_BASE_FILES, FACTORY_GITHUB_IDENTITY, FactoryGitHubFake, factoryGitHubPublicationFixture } from "../__tests__/helpers/factory-github-fake";
import type { FactoryStartupConfig } from "./startup-config";
import { composeFactoryReleaseDestinations, factoryGitHubReleaseOptions, type FactoryReleaseDestinationError } from "./release-declaration";
import { makeFactoryTempPrivateRoot } from "../__tests__/helpers/factory-private-root";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function privateRoot(): Promise<string> {
  const root = await makeFactoryTempPrivateRoot("w09b-release-");
  roots.push(root);
  await chmod(root, 0o700);
  return root;
}

async function secret(root: string, name: string, value: string, mode = 0o600): Promise<string> {
  const path = join(root, name);
  await writeFile(path, value, { mode });
  await chmod(path, mode);
  return path;
}

const CREDENTIAL_SET = JSON.stringify({ identities: [{ name: "tenant-01", credentials: [{ accessKey: "publish-key", secretKey: "publish-secret" }] }] });

function collaborators(overrides: Record<string, unknown> = {}) {
  return {
    database: {} as never,
    tenantId: "tenant-01",
    reader: {} as never,
    attempts: {} as never,
    materials: {} as never,
    releases: { async inspect() { return null; } } as never,
    ...overrides,
  };
}

function operation(over: Record<string, unknown> = {}): FactoryReleaseOperation {
  return {
    projectId: "project-1", operationId: "factory-release:op-1", dispatchGeneration: 1, senderToken: "sender-1",
    state: "executing", destination: { provider: "s3", account: "tenant-01", object: "artifacts/one.tar" },
    ...over,
  } as unknown as FactoryReleaseOperation;
}

const ADAPTER = { package: "@ezcorp/release", manifestName: "release", version: "1.0.0", digest: `sha256:${"b".repeat(64)}`, export: "publish" };

async function s3Declaration(root: string, over: Record<string, unknown> = {}) {
  return {
    name: "ordinary", kind: "s3" as const,
    endpoint: "https://127.0.0.1:8443/ordinary", bucket: "tenant-01-published", account: "tenant-01", prefix: "ordinary/releases",
    credentialsPath: await secret(root, "publish.json", CREDENTIAL_SET),
    ...over,
  };
}

async function githubDeclaration(root: string, token = "gh-token-value", mode = 0o600) {
  return {
    name: "upstream", kind: "github" as const,
    repository: "ezcorp-org/factory-platform-publication-tests",
    tokenPath: await secret(root, "github.token", token, mode),
  };
}

const profile = (destination: string, over: Record<string, unknown> = {}) =>
  ({ adapter: ADAPTER, action: "factory.release.publish", destination, estimatedSpendMicros: 1_000, ...over });

function config(release: unknown): Pick<FactoryStartupConfig, "release"> {
  return { release: release as FactoryStartupConfig["release"] };
}

describe("composeFactoryReleaseDestinations", () => {
  test("an installation that declares nothing composes nothing, and says so by absence", async () => {
    // Not an empty resolver: `factoryReleaseProviderResolver` refuses an empty
    // set at construction precisely so this cannot read as "configured".
    expect(await composeFactoryReleaseDestinations(config(undefined), collaborators())).toBeUndefined();
  });

  test("a declared S3 destination composes the publisher the wire account names", async () => {
    const root = await privateRoot();
    const composed = await composeFactoryReleaseDestinations(
      config({ destinations: [await s3Declaration(root)], profiles: [profile("ordinary")] }),
      collaborators(),
    );
    expect(composed?.destinations).toEqual(["ordinary"]);
    // One declared profile, one trusted adapter.
    expect(composed?.profiles.map((entry) => entry.adapter)).toEqual([ADAPTER]);
    expect(await composed!.providers.resolve(operation())).toBeInstanceOf(S3FactoryManifestReleaseProvider);
  });

  test("an account nobody declared is refused, never served by the one that is", async () => {
    const root = await privateRoot();
    const composed = await composeFactoryReleaseDestinations(
      config({ destinations: [await s3Declaration(root)], profiles: [profile("ordinary")] }),
      collaborators(),
    );
    const foreign = operation({ destination: { provider: "s3", account: "another-tenant", object: "x" } });
    await expect(composed!.providers.resolve(foreign)).rejects.toMatchObject({ code: "factory_release_destination_unknown" });
    const foreignRepository = operation({ destination: { provider: "github", account: "someone/else", object: "v1" } });
    await expect(composed!.providers.resolve(foreignRepository)).rejects.toMatchObject({ code: "factory_release_destination_unknown" });
  });

  test("a credential file anyone can read is refused, and the message never carries the bytes", async () => {
    const root = await privateRoot();
    const shared = await s3Declaration(root, { credentialsPath: await secret(root, "shared.json", CREDENTIAL_SET, 0o644) });
    const failure = await composeFactoryReleaseDestinations(config({ destinations: [shared], profiles: [profile("ordinary")] }), collaborators())
      .then(() => undefined, (error: unknown) => error as FactoryReleaseDestinationError);
    expect(failure?.code).toBe("factory_release_destination_unreadable");
    expect(failure?.destination).toBe("ordinary");
    expect(String(failure)).not.toContain("publish-secret");
    expect(String(failure)).not.toContain("publish-key");
  });

  test("a credential file that is not there is refused by name rather than deferred", async () => {
    const root = await privateRoot();
    const missing = await s3Declaration(root, { credentialsPath: join(root, "absent.json") });
    await expect(composeFactoryReleaseDestinations(config({ destinations: [missing], profiles: [profile("ordinary")] }), collaborators()))
      .rejects.toMatchObject({ code: "factory_release_destination_unreadable", destination: "ordinary" });

    const token = await githubDeclaration(root, "gh", 0o644);
    await expect(composeFactoryReleaseDestinations(config({ destinations: [token], profiles: [profile("upstream")] }), collaborators()))
      .rejects.toMatchObject({ code: "factory_release_destination_unreadable", destination: "upstream" });
  });

  test("a credential directory that is not private is refused before the file is opened", async () => {
    const root = await privateRoot();
    const open = join(root, "open");
    await writeFile(join(root, "placeholder"), "x", { mode: 0o600 });
    await Bun.$`mkdir -p ${open}`.quiet();
    await chmod(open, 0o755);
    const declared = await githubDeclaration(root);
    const failure = await composeFactoryReleaseDestinations(
      config({ destinations: [{ ...declared, tokenPath: join(open, "github.token") }], profiles: [profile("upstream")] }),
      collaborators(),
    ).then(() => undefined, (error: unknown) => error as FactoryReleaseDestinationError);
    expect(failure?.code).toBe("factory_release_destination_unreadable");
  });

  test("a GitHub provider is built per operation, and reads its token per call", async () => {
    const root = await privateRoot();
    const declared = await githubDeclaration(root, "first-token\n");
    const composed = await composeFactoryReleaseDestinations(
      config({ destinations: [declared], profiles: [profile("upstream")] }),
      collaborators(),
    );
    const target = operation({ destination: { provider: "github", account: declared.repository, object: "v1.0.0" } });
    const provider = await composed!.providers.resolve(target);
    expect(provider).toBeInstanceOf(FactoryGitHubReleaseProvider);
    // A second resolve is a second instance, because each one is bound to the
    // operation whose claim it rechecks.
    expect(await composed!.providers.resolve(target)).not.toBe(provider);

    const { readToken, repository, projectId } = factoryGitHubReleaseOptions(declared, target, collaborators().releases);
    expect(repository).toBe(declared.repository);
    expect(projectId).toBe("project-1");
    expect(await readToken()).toBe("first-token");
    // Rotating the file rotates what the next call sends, with nothing
    // restarted and nothing re-composed.
    await secret(root, "github.token", "second-token");
    expect(await readToken()).toBe("second-token");
    // An emptied token file is an absent credential, not an empty one.
    await secret(root, "github.token", "   ");
    expect(await readToken()).toBeNull();
  });

  test("the authority recheck refuses a claim this worker no longer holds", async () => {
    const root = await privateRoot();
    const declared = await githubDeclaration(root);
    let current: unknown = { state: "executing", dispatchGeneration: 1, senderToken: "sender-1" };
    const target = operation({ destination: { provider: "github", account: declared.repository, object: "v1.0.0" } });
    const releases = { async inspect() { return current; } } as never;
    // The resolver really builds a provider over these options; the recheck is
    // asserted directly because once the provider holds it, it is private.
    expect(await (await composeFactoryReleaseDestinations(
      config({ destinations: [declared], profiles: [profile("upstream")] }),
      collaborators({ releases }),
    ))!.providers.resolve(target)).toBeInstanceOf(FactoryGitHubReleaseProvider);
    const { authorize } = factoryGitHubReleaseOptions(declared, target, releases);

    // The claim is current, so the send proceeds.
    await authorize();
    // Another worker re-claimed it at the next generation.
    current = { state: "executing", dispatchGeneration: 2, senderToken: "sender-2" };
    await expect(authorize()).rejects.toMatchObject({ code: "factory_release_sender_fenced" });
    // The sender token moved, which is the same fence from the other side.
    current = { state: "executing", dispatchGeneration: 1, senderToken: "sender-2" };
    await expect(authorize()).rejects.toMatchObject({ code: "factory_release_sender_fenced" });
    // It already settled.
    current = { state: "succeeded", dispatchGeneration: 1, senderToken: "sender-1" };
    await expect(authorize()).rejects.toMatchObject({ code: "factory_release_sender_fenced" });
    // It is gone.
    current = null;
    await expect(authorize()).rejects.toMatchObject({ code: "factory_release_sender_fenced" });
  });
});

describe("the profiles a declaration composes", () => {
  const S3_ADAPTER = ADAPTER;
  const GITHUB_ADAPTER = { ...ADAPTER, export: "open-pull-request" };
  const decision = { decisionId: "decision-1", nodeInstanceId: "candidate", candidateGeneration: 1, candidateDigest: `sha256:${"c".repeat(64)}` } as unknown as FactoryAcceptanceDecision;
  const material = { decisionId: "decision-1", evidence: [], packageTrustDigest: `sha256:${"a".repeat(64)}`, validatorTrustDigest: `sha256:${"b".repeat(64)}` };
  const sealedRecord = (objectName: string, text: string, mediaType: string): FactoryMaterialRecord => {
    const bytes = new TextEncoder().encode(text);
    const digest = `sha256:${digestBytes(bytes)}`;
    return {
      schemaVersion: "factory.material.v1", tenantId: "tenant-01", projectId: "project-1", runId: "run-1", attemptId: "attempt-1", operationId: "materials-1",
      objectName, version: 1, mediaType, digest, totalBytes: bytes.byteLength, chunkCount: 1, storageVersion: "v1", sealed: true, createdAtMs: 1,
      artifact: { artifactId: `artifact-${objectName}`, digest, encodedBytes: bytes.byteLength },
    };
  };
  const records = [sealedRecord("candidate.json", "{}", "application/json"), sealedRecord("part-0.csv", "id\n1\n", "text/csv")];
  const accepted = {
    schemaVersion: FACTORY_S3_ACCEPTED_PUBLICATION_SCHEMA_VERSION, materialOperationId: "materials-1", candidateObjectName: "candidate.json", candidateVersion: 1,
    files: [{ name: "data/part-0.csv", objectName: "part-0.csv", version: 1 }],
  };
  const listed: FactoryMaterialScope[] = [];
  const s3Collaborators = () => collaborators({
    attempts: { async attemptFor() { return "attempt-1"; }, async attemptForDecision() { return { attemptId: "attempt-1", projectId: "project-1", runId: "run-1", nodeInstanceId: "candidate", candidateGeneration: 1, decisionId: "decision-1", candidateDigest: decision.candidateDigest }; } },
    materials: { async list(scope: FactoryMaterialScope) { listed.push(scope); return records; } },
  });
  const s3Input = (requestedDestination: unknown = { provider: "s3", account: "tenant-01", object: "releases/one" }) => ({
    tenantId: "tenant-01", projectId: "project-1", runId: "run-1", acceptedManifest: accepted as never, requestedDestination: requestedDestination as never, decision, material,
  });

  test("an S3 profile is W08's manifest profile over the verified attempt, at the declared cost", async () => {
    const root = await privateRoot();
    const composed = await composeFactoryReleaseDestinations(
      config({ destinations: [await s3Declaration(root)], profiles: [profile("ordinary", { estimatedSpendMicros: 1_234 })] }),
      s3Collaborators(),
    );
    const [s3] = composed!.profiles;
    expect(s3).toMatchObject({ adapter: S3_ADAPTER, action: "factory.release.publish" });
    const input = s3Input();
    const resolved = await s3!.resolve(input, new AbortController().signal);
    expect(resolved).toMatchObject({ destination: { provider: "s3", account: "tenant-01", object: "releases/one" }, estimatedSpendMicros: 1_234, inputDigest: factoryReleaseProfileInputDigest(input) });
    // The members are the sealed records of the attempt the decision names, pinned by digest.
    expect(listed.at(-1)).toMatchObject({ attemptId: "attempt-1", operationId: "materials-1" });
    expect((resolved.request as { members: Array<{ name: string; digest: string }> }).members).toEqual([expect.objectContaining({ name: "data/part-0.csv", digest: records[1]!.digest })]);
    // The seal covers the declared cost, so the cost cannot be edited after resolve.
    expect(() => assertFactoryReleaseProfileResult({ ...resolved, estimatedSpendMicros: 0 }, resolved.inputDigest, resolved.resolvedAtMs)).toThrow("factory_release_profile_invalid");
    expect(assertFactoryReleaseProfileResult(resolved, resolved.inputDigest, resolved.resolvedAtMs)).toEqual(resolved);
    // The synchronous surface refuses by name instead of answering without the materials.
    expect(() => s3!.build({ acceptedCandidate: accepted as never, destination: {}, decision, material })).toThrow("factory_release_profile_asynchronous");
  });

  test("an S3 profile refuses a release node that names an account nobody declared", async () => {
    const root = await privateRoot();
    const composed = await composeFactoryReleaseDestinations(
      config({ destinations: [await s3Declaration(root)], profiles: [profile("ordinary")] }),
      s3Collaborators(),
    );
    await expect(composed!.profiles[0]!.resolve(s3Input({ provider: "s3", account: "another-tenant", object: "releases/one" }), new AbortController().signal))
      .rejects.toMatchObject({ code: "factory_s3_profile_invalid" });
    const aborted = new AbortController();
    aborted.abort();
    await expect(composed!.profiles[0]!.resolve(s3Input(), aborted.signal)).rejects.toThrow();
  });

  test("a GitHub profile passes W07's approved request through, and the declared provider publishes it", async () => {
    const root = await privateRoot();
    const declared = await githubDeclaration(root);
    const server = new FactoryGitHubFake({ repository: declared.repository, repositoryId: 1_368_432_892, baseBranch: "main", baseFiles: FACTORY_GITHUB_BASE_FILES, identity: FACTORY_GITHUB_IDENTITY });
    const operationId = `factory-release:${"a1b2c3d4e5f6".repeat(6).slice(0, 64)}`;
    const request = factoryGitHubPublicationFixture(server, operationId, { repositoryId: 1_368_432_892, baseBranch: "main" });
    let current: unknown = null;
    const composed = await composeFactoryReleaseDestinations(
      config({ destinations: [declared], profiles: [profile("upstream", { adapter: GITHUB_ADAPTER, estimatedSpendMicros: 77 })] }),
      collaborators({ githubRequest: server.request, releases: { async inspect() { return current; } } }),
    );
    const [github] = composed!.profiles;
    expect(github).toMatchObject({ adapter: GITHUB_ADAPTER, action: "factory.release.publish" });
    const built = github!.build({ acceptedCandidate: request as never, destination: { provider: "github", account: declared.repository }, decision, material });
    expect(built).toEqual({ destination: { provider: "github", account: declared.repository, object: `pull-request/main/${request.commitSha}` }, request: request as never, estimatedSpendMicros: 77 });
    // Lifted through W05's adapter, so `resolve` is the same answer, sealed.
    const input = { ...s3Input({ provider: "github", account: declared.repository }), acceptedManifest: request as never };
    expect(await github!.resolve(input, new AbortController().signal)).toMatchObject({ destination: built.destination, request, estimatedSpendMicros: 77 });

    const binding = factoryGitBranchBinding(operationId);
    const claim = operation({
      operationId, destination: built.destination, request, action: "factory.release.publish", destinationRef: binding.ref, destinationBranch: binding.branch,
    });
    current = { state: "executing", dispatchGeneration: 1, senderToken: "sender-1" };
    const receipt = await (await composed!.providers.resolve(claim)).publish(claim as never);
    expect(receipt).toMatchObject({ provider: "github", account: declared.repository, object: built.destination.object, version: request.commitSha });
    expect(server.pulls).toHaveLength(1);
  });

  test("a GitHub profile refuses a candidate W07 would refuse and a repository nobody declared", async () => {
    const root = await privateRoot();
    const declared = await githubDeclaration(root);
    const server = new FactoryGitHubFake({ repository: declared.repository, repositoryId: 1_368_432_892, baseBranch: "main", baseFiles: FACTORY_GITHUB_BASE_FILES, identity: FACTORY_GITHUB_IDENTITY });
    const request = factoryGitHubPublicationFixture(server, "factory-release:op", { repositoryId: 1_368_432_892, baseBranch: "main" });
    const composed = await composeFactoryReleaseDestinations(config({ destinations: [declared], profiles: [profile("upstream")] }), collaborators());
    const [github] = composed!.profiles;
    const build = (acceptedCandidate: unknown, destination: unknown) => () => github!.build({ acceptedCandidate: acceptedCandidate as never, destination: destination as never, decision, material });
    expect(build({ ...request, schemaVersion: "factory.github-publication.v0" }, { provider: "github", account: declared.repository })).toThrow("factory_github_request_invalid");
    expect(build({ ...request, commitSha: "0".repeat(40) }, { provider: "github", account: declared.repository })).toThrow("factory_github_identity_mismatch");
    for (const destination of [{ provider: "github", account: "someone/else" }, { provider: "s3", account: declared.repository }, null, [declared.repository]]) {
      expect(build(request, destination)).toThrow("factory_github_foreign_target");
    }
  });

  test("both kinds compose into one set the protected effects accept, and an unknown kind is refused by name", async () => {
    const root = await privateRoot();
    const composed = await composeFactoryReleaseDestinations(config({
      destinations: [await s3Declaration(root), await githubDeclaration(root)],
      profiles: [profile("ordinary"), profile("upstream", { adapter: GITHUB_ADAPTER })],
    }), s3Collaborators());
    expect(composed!.profiles.map(entry => entry.adapter)).toEqual([S3_ADAPTER, GITHUB_ADAPTER]);
    const tenant = { tenantId: "tenant-01" };
    expect(() => new FactoryProtectedCommandEffects({} as never, "tenant-01", tenant as never, {} as never, tenant as never, tenant as never, tenant as never, composed!.profiles)).not.toThrow();

    const future = { name: "future", kind: "ftp", host: "ftp.example.invalid" };
    const failure = await composeFactoryReleaseDestinations(config({ destinations: [await s3Declaration(root), future], profiles: [profile("future")] }), s3Collaborators())
      .then(() => undefined, (error: unknown) => error as FactoryReleaseDestinationError);
    expect(failure).toMatchObject({ code: "factory_release_profile_unbuildable", destination: "future" });
    expect(failure!.message).toContain('"ftp"');
  });
});
