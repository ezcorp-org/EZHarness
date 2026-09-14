#!/usr/bin/env bun
/**
 * The reference code factory's product journey, end to end, against real systems.
 *
 * One run takes the C10 golden fixture from a pinned commit to a remote draft pull request:
 * it builds the launch repository as a real git commit, creates the identical commit on the
 * private test repository through the Git Data API and checks that both agree on the SHA,
 * snapshots it with real git, generates or replays a candidate, freezes the complete tree,
 * runs the nine deterministic protected claims against the real Bun and TypeScript toolchain,
 * asks the supervised reviewer, evaluates the contract, and publishes only if every mandatory
 * claim passed.
 *
 * Two things it deliberately will not do. It will not substitute a canned model answer when the
 * provider is unavailable: that is recorded as a readiness failure and the affected claim is a
 * VALIDATOR_ERROR. And it will not publish a candidate whose contract was not satisfied unless
 * `--publish-adapter-only` is passed, which records `contractSatisfied: false` in the evidence so
 * the narrower claim can never be read as a full acceptance.
 *
 * Credential: the local GitHub CLI's, read at run time, held in memory, never recorded.
 *
 * Usage: bun scripts/verify-factory-reference-code-journey.ts [--repository owner/name]
 *        [--evidence path] [--keep] [--publish-adapter-only]
 */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { digestObject } from "../src/extensions/v4/blobs";
import { ProjectGitHubHttpError, requestProjectGitHub } from "../src/extensions/project-github-transport";
import { factoryGitBlobId, factoryGitCommitId, factoryGitTreeId, type FactoryGitFile, type FactoryGitIdentity } from "../src/factory/git-objects";
import { FACTORY_GITHUB_OPERATION_MARKER, FactoryGitHubReleaseProvider, type FactoryGitHubPublicationRequest } from "../src/factory/release-github";
import { factoryGitBranchBinding } from "../src/factory/release-git-refs";
import type { FactoryReleaseClaim } from "../src/factory/releases";
import { referenceCodeProtectedChecks } from "../src/factory/reference-code/checks";
import { freezeReferenceCodeCandidate } from "../src/factory/reference-code/freeze";
import { generateReferenceCodeCandidate } from "../src/factory/reference-code/generate";
import { referenceCodeFixtureCandidate, referenceCodeLaunchRepository, REFERENCE_CODE_FIXTURE_REQUEST } from "../src/factory/reference-code/fixtures";
import { ReferenceCodeGitReader } from "../src/factory/reference-code/git-reader";
import { referenceCodeReviewClaim, referenceCodeSupervisedReview } from "../src/factory/reference-code/review";
import { snapshotReferenceCodeRepository, type ReferenceCodeFile } from "../src/factory/reference-code/snapshot";
import { createFactoryProviderBroker, factoryProviderReadiness, factoryProviderReadinessRecord } from "../src/providers/factory-broker";
import { REFERENCE_CODE_MODEL_PIN } from "./verify-factory-reference-code-provider.ts";

const argv = process.argv.slice(2);
const option = (name: string, fallback: string): string => {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 && argv[index + 1] ? argv[index + 1]! : fallback;
};
const REPOSITORY = option("repository", "ezcorp-org/factory-platform-publication-tests");
const EVIDENCE = option("evidence", "/tmp/factory-platform-evidence/w10/reference-code-journey.json");
const KEEP = argv.includes("--keep");
const ADAPTER_ONLY = argv.includes("--publish-adapter-only");
const BASE_BRANCH = "reference-code-base";
const AUTHORED_AT = 1_760_000_000;
const IDENTITY: FactoryGitIdentity = { name: "EZCorp Factory", email: "factory@ezcorp.invalid", atSeconds: AUTHORED_AT, timezone: "+0000" };

let token = "";
const calls: { method: string; path: string }[] = [];

/** The credential the local CLI holds. Read once, kept in memory, never recorded. */
async function readCliToken(): Promise<string> {
  const child = Bun.spawn(["gh", "auth", "token"], { stdout: "pipe", stderr: "ignore" });
  const [value, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
  const value2 = value.trim();
  if (code !== 0 || !value2) throw new Error("No local GitHub CLI credential is available for this run.");
  return value2;
}

async function send(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<unknown> {
  calls.push({ method, path });
  return requestProjectGitHub({
    projectId: "reference-code-journey", path, method, ...(body === undefined ? {} : { body }),
    authorize: async () => {}, readToken: async () => token, maxBodyBytes: 16 * 1024 * 1024, timeoutMs: 60_000,
  });
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("GitHub returned a value that is not an object.");
  return value as Record<string, unknown>;
}

function gitFiles(files: readonly ReferenceCodeFile[]): readonly FactoryGitFile[] {
  return files.map(file => ({ path: file.path, mode: file.mode, content: file.content }));
}

/** A real local repository holding the launch fixture at one deterministic commit. */
async function localBaseRepository(): Promise<{ path: string; baseSha: string }> {
  const path = await mkdtemp(join(tmpdir(), "ezcorp-w10-journey-"));
  const environment = {
    PATH: process.env.PATH ?? "", HOME: path,
    GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_AUTHOR_NAME: IDENTITY.name, GIT_AUTHOR_EMAIL: IDENTITY.email, GIT_AUTHOR_DATE: `${AUTHORED_AT} +0000`,
    GIT_COMMITTER_NAME: IDENTITY.name, GIT_COMMITTER_EMAIL: IDENTITY.email, GIT_COMMITTER_DATE: `${AUTHORED_AT} +0000`,
  };
  const git = (...args: string[]): string => {
    const result = spawnSync("git", args, { cwd: path, encoding: "utf8", env: environment });
    if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
    return result.stdout.trim();
  };
  git("init", "--quiet", "--initial-branch", "main");
  for (const file of referenceCodeLaunchRepository()) {
    const absolute = join(path, file.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content);
  }
  git("add", "-A");
  git("commit", "--quiet", "-m", "Reference code launch fixture\n");
  return { path, baseSha: git("rev-parse", "HEAD") };
}

/** Creates the same objects on the remote and refuses any identity the server disagrees with. */
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

/**
 * Publishes the local base commit to the remote, unchanged.
 *
 * The commit is created with no parent and the same fixed identity the local repository used, so
 * the two SHAs must match. They are content-addressed, so a mismatch would mean the bytes differ,
 * and everything downstream names a base that is not the one that was tested.
 */
async function ensureRemoteBase(localBaseSha: string): Promise<{ baseSha: string; created: boolean }> {
  const treeSha = await materialize(gitFiles(referenceCodeLaunchRepository()));
  const message = "Reference code launch fixture\n";
  const baseSha = factoryGitCommitId({ treeId: treeSha, parents: [], author: IDENTITY, committer: IDENTITY, message });
  if (baseSha !== localBaseSha) throw new Error(`The remote base commit ${baseSha} is not the local one ${localBaseSha}.`);
  try {
    const existing = record(await send("GET", `/repos/${REPOSITORY}/git/ref/heads/${BASE_BRANCH}`));
    if (record(existing.object).sha === baseSha) return { baseSha, created: false };
    throw new Error("The reference-code base branch exists at a different commit; delete it and re-run.");
  } catch (error) {
    if (!(error instanceof ProjectGitHubHttpError) || error.status !== 404) throw error;
  }
  const date = new Date(AUTHORED_AT * 1000).toISOString().replace(".000Z", "Z");
  const commit = record(await send("POST", `/repos/${REPOSITORY}/git/commits`, {
    message, tree: treeSha, parents: [],
    author: { name: IDENTITY.name, email: IDENTITY.email, date },
    committer: { name: IDENTITY.name, email: IDENTITY.email, date },
  }));
  if (commit.sha !== baseSha) throw new Error("The remote base commit is not the one that was computed.");
  await send("POST", `/repos/${REPOSITORY}/git/refs`, { ref: `refs/heads/${BASE_BRANCH}`, sha: baseSha });
  return { baseSha, created: true };
}

function operationId(label: string): string {
  return `factory-release:${digestObject({ label, repository: REPOSITORY, at: Date.now(), nonce: crypto.randomUUID() })}`;
}

/** The release claim the accepted candidate is published under. */
function claimFor(request: FactoryGitHubPublicationRequest, id: string, candidateDigest: string): FactoryReleaseClaim {
  const binding = factoryGitBranchBinding(id);
  const fill = (value: string) => `sha256:${value.repeat(64).slice(0, 64)}`;
  return {
    tenantId: "reference-code-tenant", projectId: "reference-code-journey", operationId: id,
    runId: "reference-code-run", nodeInstanceId: "github-pr-release", candidateGeneration: 0,
    candidateDigest, decisionId: "reference-code-decision", contractDigest: fill("b"),
    executionEpoch: 1, cancellationEpoch: 0, releaseEnableEpoch: 1, action: "publish",
    destination: { provider: "github", account: REPOSITORY, object: `pull-request/${request.baseBranch}/${request.commitSha}` },
    request, destinationDigest: fill("c"), requestDigest: fill("d"),
    material: { decisionId: "reference-code-decision", evidence: [{ contract: "reference.code.v1.contract" }], packageTrustDigest: fill("e"), validatorTrustDigest: fill("f") },
    materialDigest: fill("0"), estimatedSpendMicros: 0, deadlineMs: Date.now() + 3_600_000,
    state: "executing", dispatchGeneration: 1, dispatchStarted: true, senderToken: `sender-${id.slice(-8)}`,
    archiveReady: true, destinationRef: binding.ref, destinationBranch: binding.branch,
    authority: { kind: "approval", id: "reference-code-approval" },
  };
}

async function main(): Promise<void> {
  const startedAt = new Date().toISOString();
  token = await readCliToken();
  const result: Record<string, unknown> = {
    startedAt, repository: REPOSITORY, baseBranch: BASE_BRANCH,
    credentialKind: "github-cli", credentialScope: "narrower-smoke-test",
    selectedRepositoryAppVerified: false, brokerOnlyNamespaceVerified: false,
  };
  const repository = record(await send("GET", `/repos/${REPOSITORY}`));
  const repositoryId = Number(repository.id);
  result.repositoryId = repositoryId;
  result.visibility = repository.visibility;

  const local = await localBaseRepository();
  const created: { branch: string; pull?: number }[] = [];
  try {
    // 1. The pinned base, identical locally and on the remote.
    const base = await ensureRemoteBase(local.baseSha);
    result.baseSha = base.baseSha;
    result.baseBranchCreatedThisRun = base.created;
    result.localAndRemoteBaseAgree = true;

    // 2. The snapshot, read from the real repository at that exact commit.
    const snapshot = await snapshotReferenceCodeRepository(new ReferenceCodeGitReader({ repositoryPath: local.path }), base.baseSha);
    result.snapshot = { baseSha: snapshot.baseSha, treeSha: snapshot.treeSha, files: snapshot.files.length, digest: snapshot.digest, dependencyLockPath: snapshot.dependencyLockPath, scripts: snapshot.scripts };

    // 3. The provider, resolved by reference. An unavailable one is a recorded failure.
    const readiness = await factoryProviderReadiness(REFERENCE_CODE_MODEL_PIN);
    result.providerReadiness = factoryProviderReadinessRecord(readiness);

    // 4. Generation. Real when the provider is ready; otherwise the recorded accepted tree,
    //    labelled so nobody can read it as a model result.
    let files: readonly ReferenceCodeFile[];
    if (readiness.ready) {
      const broker = createFactoryProviderBroker({ pin: REFERENCE_CODE_MODEL_PIN });
      const generation = await generateReferenceCodeCandidate({
        snapshot, issue: REFERENCE_CODE_FIXTURE_REQUEST.issue,
        allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
        protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
        remediation: "", candidateGeneration: 0, broker, attemptToken: "journey-attempt",
        model: REFERENCE_CODE_MODEL_PIN,
      });
      files = generation.files;
      result.generation = { source: "provider", model: generation.model, iterations: generation.iterations, stopReason: generation.stopReason, toolCalls: generation.toolCalls, usage: generation.usage, transcriptDigest: generation.transcriptDigest, filesDigest: generation.filesDigest };
    } else {
      files = referenceCodeFixtureCandidate("accepted");
      result.generation = { source: "recorded-fixture", reason: "provider readiness failure; no model was called and no model answer was substituted", failures: [...readiness.failures] };
    }

    // 5. The freeze: one complete tree, one commit, the pinned base as its only parent.
    const candidate = freezeReferenceCodeCandidate({
      snapshot, files, repositoryId, baseBranch: BASE_BRANCH,
      issue: REFERENCE_CODE_FIXTURE_REQUEST.issue, title: REFERENCE_CODE_FIXTURE_REQUEST.title,
      allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
      protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
      authoredAtSeconds: AUTHORED_AT, candidateGeneration: 0,
    });
    result.candidate = { treeSha: candidate.treeSha, commitSha: candidate.commitSha, baseSha: candidate.baseSha, filesDigest: candidate.filesDigest, changedPaths: candidate.changedPaths, files: candidate.publication.files.length };

    // 6. The nine deterministic claims, against the real toolchain.
    const checks = await referenceCodeProtectedChecks({
      candidate, snapshot, files,
      allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
      protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
      protectedTestPaths: ["test/slugify.protected.test.ts"],
      workspacePrefix: "ezcorp-w10-journey-checks-",
    });
    result.deterministicClaims = checks.report.claims.map(claim => ({ id: claim.id, verdict: claim.verdict, reasonCode: claim.reasonCode }));
    result.checkCommands = checks.commands.map(command => ({ command: command.command, exitCode: command.exitCode, durationMs: command.durationMs }));
    result.verifiedWorkspaceDigest = checks.verifiedWorkspaceDigest;

    // 7. The tenth claim, in its own validator context.
    const reviewClaim = readiness.ready
      ? (await referenceCodeSupervisedReview({
          candidate, snapshot, files, issue: REFERENCE_CODE_FIXTURE_REQUEST.issue,
          broker: createFactoryProviderBroker({ pin: REFERENCE_CODE_MODEL_PIN }),
          attemptToken: "journey-review", model: REFERENCE_CODE_MODEL_PIN,
        })).report.claims[0]!
      : referenceCodeReviewClaim({ kind: "error", code: "review_provider_not_ready", message: `The supervised reviewer's provider is not ready: ${readiness.failures.join(", ")}.` }, Date.now());
    result.reviewClaim = { id: reviewClaim.id, verdict: reviewClaim.verdict, reasonCode: reviewClaim.reasonCode, summary: reviewClaim.summary };

    // 8. The contract: ten mandatory claims, and only PASS satisfies one.
    const mandatory = [...checks.report.claims, reviewClaim];
    const unsatisfied = mandatory.filter(claim => claim.verdict !== "PASS");
    const contractSatisfied = unsatisfied.length === 0;
    result.contractSatisfied = contractSatisfied;
    result.unsatisfiedClaims = unsatisfied.map(claim => ({ id: claim.id, verdict: claim.verdict, reasonCode: claim.reasonCode }));

    // 9. Publication. Blocked unless the contract was satisfied, or the adapter-only leg was asked for.
    if (!contractSatisfied && !ADAPTER_ONLY) {
      result.publication = { attempted: false, blockedBy: unsatisfied.map(claim => claim.id) };
    } else {
      result.publicationScope = contractSatisfied ? "accepted-candidate" : "adapter-and-identity-only";
      const provider = new FactoryGitHubReleaseProvider({ repository: REPOSITORY, projectId: "reference-code-journey", authorize: async () => {}, readToken: async () => token });
      const id = operationId("reference-code");
      const publication: FactoryGitHubPublicationRequest = {
        ...candidate.publication,
        body: `${candidate.publication.body}\n\n${FACTORY_GITHUB_OPERATION_MARKER} ${id}\n`,
      };
      const withDigest = { ...publication, titleBodyDigest: `sha256:${digestObject({ title: publication.title, body: publication.body })}` };
      const claim = claimFor(withDigest, id, candidate.filesDigest);
      const receipt = await provider.publish(claim);
      const pullNumber = Number(String(receipt.providerReceiptId).split(":").pop());
      created.push({ branch: claim.destinationBranch!, pull: pullNumber });
      result.publication = { attempted: true, operationId: id, receipt, branch: claim.destinationBranch, pullNumber };

      // 10. The remote holds exactly the accepted tree, and the commit's parent is the tested base.
      const remoteTree = record(await send("GET", `/repos/${REPOSITORY}/git/trees/${candidate.treeSha}?recursive=1`));
      const remote = new Map((remoteTree.tree as { path: string; sha: string; type: string }[]).filter(entry => entry.type === "blob").map(entry => [entry.path, entry.sha]));
      const mismatched = files.filter(file => remote.get(file.path) !== factoryGitBlobId(file.content));
      const remoteCommit = record(await send("GET", `/repos/${REPOSITORY}/git/commits/${candidate.commitSha}`));
      const parents = (remoteCommit.parents as { sha: string }[]).map(parent => parent.sha);
      const pull = record(await send("GET", `/repos/${REPOSITORY}/pulls/${pullNumber}`));
      result.remoteVerification = {
        treeFiles: remote.size,
        candidateFiles: files.length,
        mismatchedFiles: mismatched.map(file => file.path),
        treeMatchesExactly: mismatched.length === 0 && remote.size === files.length,
        commitParents: parents,
        parentIsTestedBase: parents.length === 1 && parents[0] === base.baseSha,
        pullDraft: pull.draft,
        pullMerged: pull.merged,
        pullHead: record(pull.head).sha,
        pullBase: record(pull.base).ref,
        pullUrl: pull.html_url,
        headIsAcceptedCommit: record(pull.head).sha === candidate.commitSha,
        lockDigestMatchesSnapshot: candidate.publication.dependencyLockDigest === snapshot.dependencyLockDigest,
      };
    }

    result.apiCalls = calls.map(call => `${call.method} ${call.path.split("?")[0]}`);
    result.finishedAt = new Date().toISOString();
    result.outcome = "completed";
  } catch (error) {
    result.outcome = "failed";
    result.error = `${(error as Error).name}: ${(error as Error).message}`;
    result.finishedAt = new Date().toISOString();
  } finally {
    // Evidence is written BEFORE cleanup, so a failed cleanup cannot cost the proof.
    await mkdir(dirname(EVIDENCE), { recursive: true });
    await writeFile(EVIDENCE, `${JSON.stringify(result, null, 2)}\n`);
    await rm(local.path, { recursive: true, force: true });
    if (!KEEP) {
      const cleaned: string[] = [];
      for (const entry of created) {
        try {
          if (entry.pull !== undefined) await send("PATCH", `/repos/${REPOSITORY}/pulls/${entry.pull}`, { state: "closed" });
          await send("DELETE", `/repos/${REPOSITORY}/git/refs/heads/${entry.branch.split("/").map(encodeURIComponent).join("/")}`);
          cleaned.push(entry.branch);
        } catch { cleaned.push(`${entry.branch} (cleanup failed)`); }
      }
      result.cleanedUp = cleaned;
      await writeFile(EVIDENCE, `${JSON.stringify(result, null, 2)}\n`);
    }
  }
  console.log(JSON.stringify(result, null, 2));
  if (result.outcome !== "completed") process.exitCode = 1;
}

if (import.meta.main) await main();
