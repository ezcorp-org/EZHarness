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
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { S3FactoryManifestReleaseProvider } from "./release-s3-publication";
import { FactoryGitHubReleaseProvider } from "./release-github";
import type { FactoryReleaseOperation } from "./releases";
import type { FactoryStartupConfig } from "./startup-config";
import { composeFactoryReleaseDestinations, factoryGitHubReleaseOptions, FactoryReleaseDestinationError } from "./release-declaration";
import type { FactoryReleaseCommandProfileInput } from "./protected-command-effects";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function privateRoot(): Promise<string> {
  const root = await mkdtemp(join(process.env.HOME!, ".w09b-release-"));
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
    endpoint: "https://127.0.0.1:8443/ordinary", bucket: "tenant-01-published", account: "tenant-01", prefix: "releases",
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
    expect(composed?.profiles).toHaveLength(1);
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

describe("the profile a declaration composes", () => {
  async function built(root: string, destination?: Record<string, unknown>) {
    const declared = destination ?? await s3Declaration(root);
    const composed = await composeFactoryReleaseDestinations(
      config({ destinations: [declared], profiles: [profile(declared.name as string)] }),
      collaborators(),
    );
    return composed!.profiles[0]!;
  }

  const input = (destination: unknown): FactoryReleaseCommandProfileInput => ({
    acceptedCandidate: { schemaVersion: "factory.s3-publication-request.v1", members: [] },
    destination,
    decision: {} as never,
    material: {} as never,
  } as unknown as FactoryReleaseCommandProfileInput);

  test("the deployment names the account and the definition names the object", async () => {
    const root = await privateRoot();
    const result = (await built(root)).build(input({ object: "artifacts/one.tar" }));
    expect(result.destination).toEqual({ provider: "s3", account: "tenant-01", object: "artifacts/one.tar" });
    // The payload is the accepted candidate, unchanged: a profile that rewrote
    // it would publish bytes the acceptance decision never sealed.
    expect(result.request).toEqual(input({}).acceptedCandidate);
    expect(result.estimatedSpendMicros).toBe(1_000);
  });

  test("a release node may pin the version it expects to replace", async () => {
    const root = await privateRoot();
    const result = (await built(root)).build(input({ object: "artifacts/one.tar", expectedVersion: "v7" }));
    expect(result.destination).toEqual({ provider: "s3", account: "tenant-01", object: "artifacts/one.tar", expectedVersion: "v7" });
  });

  test("a release node that restates the provider and account is checked against the declaration", async () => {
    const root = await privateRoot();
    const composed = await built(root);
    // Agreeing is ordinary.
    expect(composed.build(input({ object: "one", provider: "s3", account: "tenant-01" })).destination.object).toBe("one");
    // Disagreeing is a refusal, not a silent override: an author who moved the
    // release elsewhere must not publish into the deployment's own account.
    for (const asked of [
      { object: "one", provider: "github" },
      { object: "one", account: "another-tenant" },
    ]) {
      expect(() => composed.build(input(asked))).toThrow(FactoryReleaseDestinationError);
    }
  });

  test("a release node that names no usable object, or a field the deployment owns, is refused", async () => {
    const root = await privateRoot();
    const composed = await built(root);
    for (const asked of [
      undefined, null, "artifacts/one.tar", [], {},
      { object: "" }, { object: 7 }, { object: "a\0b" }, { object: "x".repeat(1_025) },
      { object: "one", bucket: "somewhere" },
      { object: "one", expectedVersion: "" },
      { object: "one", expectedVersion: 7 },
    ]) {
      expect(() => composed.build(input(asked))).toThrow(FactoryReleaseDestinationError);
    }
  });

  test("a GitHub destination publishes under its repository, which is the account on the wire", async () => {
    const root = await privateRoot();
    const declared = await githubDeclaration(root);
    const composed = await built(root, declared as unknown as Record<string, unknown>);
    expect(composed.build(input({ object: "v1.0.0" })).destination)
      .toEqual({ provider: "github", account: "ezcorp-org/factory-platform-publication-tests", object: "v1.0.0" });
  });

  test("the profile carries the adapter the definition's release node names", async () => {
    const root = await privateRoot();
    const composed = await built(root);
    // `FactoryProtectedCommandEffects` keys its trusted set by a digest of this
    // reference, so it is the definition's own five fields and not a copy.
    expect(composed.adapter).toEqual(ADAPTER);
    expect(composed.action).toBe("factory.release.publish");
    expect(typeof composed.resolve).toBe("function");
  });
});
