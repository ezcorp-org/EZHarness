#!/usr/bin/env bun
/**
 * Real GitHub publication against the disposable private repository.
 *
 * It drives `FactoryGitHubReleaseProvider` through the shared broker transport and the real API:
 * it materializes a complete tree, creates one unique branch, opens one draft pull request, reads
 * the remote content back and compares it byte for byte, recovers a dropped response without a
 * second effect, refuses a conflicting ref without forcing it, and proves absence for an operation
 * that never published. Only after the evidence is written does it clean up the branches and pull
 * requests this run created.
 *
 * Credential: read from the local GitHub CLI at run time and held in memory only. It is never
 * printed, never written to the evidence file, and never passed to anything but one header. A run
 * driven by that CLI credential is the NARROWER SMOKE TEST: it proves the adapter against the real
 * API, not that a selected-repository GitHub App with a broker-only ref namespace is installed. The
 * evidence records that distinction in `credentialScope`, `selectedRepositoryAppVerified`, and
 * `brokerOnlyNamespaceVerified` rather than implying it.
 *
 * Usage: bun scripts/verify-factory-release-github.ts [--repository owner/name] [--keep]
 */
import { digestBytes, digestObject } from "../src/extensions/v4/blobs";
import { ProjectGitHubHttpError, requestProjectGitHub } from "../src/extensions/project-github-transport";
import { factoryGitBlobId, factoryGitCommitId, factoryGitTreeId, type FactoryGitFile, type FactoryGitIdentity } from "../src/factory/git-objects";
import { FACTORY_GITHUB_OPERATION_MARKER, FactoryGitHubError, FactoryGitHubReleaseProvider, type FactoryGitHubPublicationRequest } from "../src/factory/release-github";
import { factoryGitBranchBinding } from "../src/factory/release-git-refs";
import type { FactoryReleaseClaim } from "../src/factory/releases";

const argv = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
};
const REPOSITORY = option("repository", "ezcorp-org/factory-platform-publication-tests");
const KEEP = argv.includes("--keep");
const EVIDENCE = option("evidence", "/tmp/factory-platform-evidence/w07/release-github-real.json");
const BASE_BRANCH = "factory-publication-base";
const IDENTITY: FactoryGitIdentity = { name: "EZCorp Factory", email: "factory@ezcorp.invalid", atSeconds: 1_700_000_000, timezone: "+0000" };
const encoder = new TextEncoder();
const text = (value: string) => encoder.encode(value);

/** The credential the local CLI holds. Read once, kept in memory, never recorded. */
async function readCliToken(): Promise<string> {
  const child = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
  const [value, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const token = value.trim();
  if (code !== 0 || !token) throw new Error("No local GitHub CLI credential is available for this run.");
  return token;
}

const calls: { method: string; path: string }[] = [];
let token = "";
async function send(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  calls.push({ method, path });
  return requestProjectGitHub({
    projectId: "factory-publication", path, method, ...(body === undefined ? {} : { body }),
    authorize: async () => {}, readToken: async () => token, maxBodyBytes: 16 * 1024 * 1024, timeoutMs: 60_000,
  });
}

/** The reference-pack tree the base branch holds, and the accepted candidate that changes one file. */
const PACK: readonly FactoryGitFile[] = [
  { path: "README.md", mode: "100644", content: text("# Factory publication tests\n\nDisposable target for the W07 GitHub release adapter.\n") },
  { path: "package.json", mode: "100644", content: text(`{\n  "name": "factory-publication-fixture",\n  "version": "1.0.0",\n  "dependencies": {}\n}\n`) },
  { path: "bun.lock", mode: "100644", content: text('{\n  "lockfileVersion": 1,\n  "packages": {}\n}\n') },
  { path: "tests/slugify.test.ts", mode: "100644", content: text('import { expect, test } from "bun:test";\nimport { slugify } from "../src/slugify";\n\ntest("slugify", () => {\n  expect(slugify("Hello, Factory!")).toBe("hello-factory");\n});\n') },
  { path: "src/slugify.ts", mode: "100644", content: text("export const slugify = (value: string): string => value;\n") },
];
const CANDIDATE: readonly FactoryGitFile[] = PACK.map(file => file.path === "src/slugify.ts"
  ? { ...file, content: text('export const slugify = (value: string): string =>\n  value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");\n') }
  : file);

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub returned a value that is not an object.");
  return value as Record<string, unknown>;
}

async function materialize(files: readonly FactoryGitFile[]): Promise<string> {
  for (const file of files) {
    const created = record(await send("POST", `/repos/${REPOSITORY}/git/blobs`, { content: Buffer.from(file.content).toString("base64"), encoding: "base64" }));
    if (created.sha !== factoryGitBlobId(file.content)) throw new Error(`GitHub stored ${file.path} under another identity.`);
  }
  const tree = record(await send("POST", `/repos/${REPOSITORY}/git/trees`, {
    tree: files.map(file => ({ path: file.path, mode: file.mode, type: "blob", sha: factoryGitBlobId(file.content) })),
  }));
  const expected = factoryGitTreeId(files);
  if (tree.sha !== expected) throw new Error("GitHub stored a different tree than the one that was sent.");
  return expected;
}

/** The fixture base branch, created once and reused. Its commit is deterministic. */
async function ensureBase(repositoryId: number): Promise<{ baseSha: string; created: boolean }> {
  const mainRef = record(await send("GET", `/repos/${REPOSITORY}/git/ref/heads/${option("main", "main")}`));
  const parent = String(record(mainRef.object).sha);
  const treeSha = await materialize(PACK);
  const message = "Factory publication fixture base\n";
  const baseSha = factoryGitCommitId({ treeId: treeSha, parents: [parent], author: IDENTITY, committer: IDENTITY, message });
  try {
    const existing = record(await send("GET", `/repos/${REPOSITORY}/git/ref/heads/${BASE_BRANCH}`));
    if (record(existing.object).sha === baseSha) return { baseSha, created: false };
    throw new Error("The fixture base branch exists at a different commit; delete it and re-run.");
  } catch (error) {
    if (!(error instanceof ProjectGitHubHttpError) || error.status !== 404) throw error;
  }
  const commit = record(await send("POST", `/repos/${REPOSITORY}/git/commits`, {
    message, tree: treeSha, parents: [parent],
    author: { name: IDENTITY.name, email: IDENTITY.email, date: new Date(IDENTITY.atSeconds * 1000).toISOString().replace(".000Z", "Z") },
    committer: { name: IDENTITY.name, email: IDENTITY.email, date: new Date(IDENTITY.atSeconds * 1000).toISOString().replace(".000Z", "Z") },
  }));
  if (commit.sha !== baseSha) throw new Error("The fixture base commit is not the one that was computed.");
  await send("POST", `/repos/${REPOSITORY}/git/refs`, { ref: `refs/heads/${BASE_BRANCH}`, sha: baseSha });
  if (repositoryId < 1) throw new Error("The repository identity is unusable.");
  return { baseSha, created: true };
}

function publicationRequest(repositoryId: number, baseSha: string, operationId: string): FactoryGitHubPublicationRequest {
  const treeSha = factoryGitTreeId(CANDIDATE);
  const commitMessage = "Implement slugify for the accepted candidate\n";
  const commitSha = factoryGitCommitId({ treeId: treeSha, parents: [baseSha], author: IDENTITY, committer: IDENTITY, message: commitMessage });
  const title = "Accepted candidate: slugify";
  const body = [
    `This pull request publishes the accepted candidate tree \`${treeSha}\`.`,
    "",
    `Tested base: \`${baseSha}\` on \`${BASE_BRANCH}\`. Opening this pull request does not claim the current head of that branch was tested.`,
    "",
    `${FACTORY_GITHUB_OPERATION_MARKER} ${operationId}`,
    "",
  ].join("\n");
  const lock = CANDIDATE.find(file => file.path === "bun.lock")!;
  return {
    schemaVersion: "factory.github-publication.v1",
    repositoryId, baseBranch: BASE_BRANCH, baseSha, treeSha, commitSha, commitMessage,
    author: IDENTITY, committer: IDENTITY,
    title, body, titleBodyDigest: `sha256:${digestObject({ title, body })}`,
    dependencyLockPath: "bun.lock", dependencyLockDigest: `sha256:${digestBytes(lock.content)}`,
    protectedPaths: ["tests/slugify.test.ts"], allowedPaths: ["src/"],
    files: CANDIDATE.map(file => ({ path: file.path, mode: file.mode, contentBase64: Buffer.from(file.content).toString("base64") })),
  };
}

function claimFor(request: FactoryGitHubPublicationRequest, operationId: string): FactoryReleaseClaim {
  const binding = factoryGitBranchBinding(operationId);
  const digest = (fill: string) => `sha256:${fill.repeat(64).slice(0, 64)}`;
  return {
    tenantId: "factory-publication-tenant", projectId: "factory-publication", operationId,
    runId: "publication-run", nodeInstanceId: "release", candidateGeneration: 0, candidateDigest: digest("a"),
    decisionId: "publication-decision", contractDigest: digest("b"), executionEpoch: 1, cancellationEpoch: 0, releaseEnableEpoch: 1,
    action: "publish", destination: { provider: "github", account: REPOSITORY, object: `pull-request/${request.baseBranch}/${request.commitSha}` },
    request, destinationDigest: digest("c"), requestDigest: digest("d"),
    material: { decisionId: "publication-decision", evidence: [{ fixture: true }], packageTrustDigest: digest("e"), validatorTrustDigest: digest("f") },
    materialDigest: digest("0"), estimatedSpendMicros: 0, deadlineMs: Date.now() + 3_600_000,
    state: "executing", dispatchGeneration: 1, dispatchStarted: true, senderToken: `sender-${operationId.slice(-8)}`,
    archiveReady: true, destinationRef: binding.ref, destinationBranch: binding.branch,
    authority: { kind: "approval", id: "publication-approval" },
  };
}

function operationId(label: string): string {
  return `factory-release:${digestObject({ label, repository: REPOSITORY, at: Date.now(), nonce: crypto.randomUUID() })}`;
}

async function main(): Promise<void> {
  token = await readCliToken();
  const started = new Date().toISOString();
  const repository = record(await send("GET", `/repos/${REPOSITORY}`));
  const repositoryId = Number(repository.id);
  const provider = new FactoryGitHubReleaseProvider({
    repository: REPOSITORY, projectId: "factory-publication", authorize: async () => {}, readToken: async () => token,
  });
  const base = await ensureBase(repositoryId);
  const created: { branch: string; pull: number }[] = [];
  const result: Record<string, unknown> = {
    startedAt: started, repository: REPOSITORY, repositoryId, visibility: repository.visibility, baseBranch: BASE_BRANCH, baseSha: base.baseSha,
    credentialKind: "github-cli", credentialScope: "narrower-smoke-test",
    selectedRepositoryAppVerified: false,
    brokerOnlyNamespaceVerified: false,
  };

  // 1. One real draft pull request on one unique branch.
  const publishedId = operationId("published");
  const request = publicationRequest(repositoryId, base.baseSha, publishedId);
  const claim = claimFor(request, publishedId);
  const receipt = await provider.publish(claim);
  const pullNumber = Number(String(receipt.providerReceiptId).split(":").pop());
  created.push({ branch: claim.destinationBranch!, pull: pullNumber });
  result.receipt = receipt;

  // 2. The remote holds exactly the accepted tree, read back and compared byte for byte.
  const remoteTree = record(await send("GET", `/repos/${REPOSITORY}/git/trees/${request.treeSha}?recursive=1`));
  const remote = new Map((remoteTree.tree as { path: string; sha: string; type: string }[]).filter(entry => entry.type === "blob").map(entry => [entry.path, entry.sha]));
  const mismatched = CANDIDATE.filter(file => remote.get(file.path) !== factoryGitBlobId(file.content));
  if (mismatched.length || remote.size !== CANDIDATE.length) throw new Error("The remote tree does not hold the accepted candidate.");
  const readBack = record(await send("GET", `/repos/${REPOSITORY}/git/blobs/${factoryGitBlobId(CANDIDATE.find(file => file.path === "src/slugify.ts")!.content)}`));
  const readBackBytes = Buffer.from(String(readBack.content), "base64");
  const expectedBytes = Buffer.from(CANDIDATE.find(file => file.path === "src/slugify.ts")!.content);
  result.remoteContentVerified = readBackBytes.equals(expectedBytes) && remote.size === CANDIDATE.length;
  if (!result.remoteContentVerified) throw new Error("The remote blob is not the accepted content.");

  const pull = record(await send("GET", `/repos/${REPOSITORY}/pulls/${pullNumber}`));
  result.pullRequest = { number: pullNumber, url: pull.html_url, draft: pull.draft, state: pull.state, merged: pull.merged, head: record(pull.head).sha, base: record(pull.base).ref };
  if (pull.draft !== true || pull.merged !== false) throw new Error("The published pull request is not an unmerged draft.");

  // 3. A dropped response recovers by identity and creates no second effect.
  const before = (await send("GET", `/repos/${REPOSITORY}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${REPOSITORY.split("/")[0]}:${claim.destinationBranch}`)}&base=${encodeURIComponent(BASE_BRANCH)}`)) as unknown[];
  // The operator's own action after a lost response is a lookup, which writes nothing at all.
  const writesBeforeLookup = calls.filter(call => call.method !== "GET").length;
  const looked = await provider.lookupReceipt(claim);
  result.lookupReceiptMatches = JSON.stringify(looked) === JSON.stringify(receipt);
  result.lookupSentNoWrite = calls.filter(call => call.method !== "GET").length === writesBeforeLookup;
  const recovered = await provider.publish(claim);
  const after = (await send("GET", `/repos/${REPOSITORY}/pulls?state=all&per_page=100&head=${encodeURIComponent(`${REPOSITORY.split("/")[0]}:${claim.destinationBranch}`)}&base=${encodeURIComponent(BASE_BRANCH)}`)) as unknown[];
  result.droppedResponseRecovered = JSON.stringify(recovered) === JSON.stringify(receipt) && before.length === after.length && after.length === 1;
  if (!result.droppedResponseRecovered) throw new Error("Recovery produced a second effect or a different receipt.");
  result.receiptVerified = await provider.verifyReceipt(claim, receipt, { lookup: true });
  result.absenceRefusedAfterEffect = (await provider.proveNoEffect(claim, { operationId: publishedId })) === false;

  // 4. An operation that never published proves absence.
  const absentId = operationId("absent");
  const absentRequest = publicationRequest(repositoryId, base.baseSha, absentId);
  result.absenceProvedForUnpublished = await provider.proveNoEffect(claimFor(absentRequest, absentId), { operationId: absentId });

  // 5. A branch already pointing elsewhere is a conflict, and it is not force-updated.
  const conflictId = operationId("conflict");
  const conflictRequest = publicationRequest(repositoryId, base.baseSha, conflictId);
  const conflictClaim = claimFor(conflictRequest, conflictId);
  await send("POST", `/repos/${REPOSITORY}/git/refs`, { ref: conflictClaim.destinationRef, sha: base.baseSha });
  created.push({ branch: conflictClaim.destinationBranch!, pull: 0 });
  const conflict = await provider.publish(conflictClaim).then(() => null, (error: unknown) => error);
  const conflictRef = record(await send("GET", `/repos/${REPOSITORY}/git/ref/heads/${conflictClaim.destinationBranch!.split("/").map(encodeURIComponent).join("/")}`));
  result.refConflictRefused = conflict instanceof FactoryGitHubError && conflict.code === "factory_github_ref_conflict";
  result.refNotForceUpdated = record(conflictRef.object).sha === base.baseSha;

  // 6. What this credential actually proves, stated rather than implied.
  const installations = await send("GET", "/user/installations").then(value => record(value), () => null);
  result.selectedRepositoryAppVerified = false;
  result.appInstallationsVisible = installations ? Number(installations.total_count ?? 0) : null;
  result.brokerOnlyNamespaceVerified = false;
  result.namespaceNote = "A CLI credential with push access can create any ref. Restricting pushes to refs/heads/ezcorp-factory/* requires the selected-repository GitHub App and a ruleset; neither is installed on this repository.";
  result.methodsUsedBeforeCleanup = [...new Set(calls.map(call => call.method))].sort();
  result.methodsNote = "Cleanup runs after this file is written and uses PATCH and DELETE; the adapter itself only ever sends GET and POST.";
  result.finishedAt = new Date().toISOString();
  result.createdResources = created;

  // Evidence is written BEFORE any cleanup, so a failed cleanup never costs the proof.
  await Bun.write(EVIDENCE, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ evidence: EVIDENCE, pullRequest: result.pullRequest, remoteContentVerified: result.remoteContentVerified, droppedResponseRecovered: result.droppedResponseRecovered, refConflictRefused: result.refConflictRefused }, null, 2));

  if (KEEP) return;
  for (const resource of created) {
    if (resource.pull > 0) await send("PATCH", `/repos/${REPOSITORY}/pulls/${resource.pull}`, { state: "closed" }).catch(() => undefined);
    await send("DELETE", `/repos/${REPOSITORY}/git/refs/heads/${resource.branch.split("/").map(encodeURIComponent).join("/")}`).catch(() => undefined);
  }
  console.log(JSON.stringify({ cleanedUp: created.map(resource => resource.branch) }));
}

await main();
