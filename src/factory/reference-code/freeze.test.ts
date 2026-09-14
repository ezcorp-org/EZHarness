import { describe, expect, test } from "bun:test";
import { digestObject } from "../../extensions/v4/blobs";
import { assertFactoryGitHubPublicationRequest } from "../release-github";
import {
  freezeReferenceCodeCandidate,
  referenceCodeChangedPaths,
  referenceCodePullRequestBody,
  ReferenceCodeFreezeError,
  REFERENCE_CODE_COMMIT_AUTHOR,
  REFERENCE_CODE_FREEZE_SCHEMA_VERSION,
  type ReferenceCodeFreezeInput,
} from "./freeze";
import { referenceCodeFixtureCandidate, referenceCodeLaunchRepository, withoutReferenceCodeFile, withReferenceCodeFile, REFERENCE_CODE_FIXTURE_REQUEST } from "./fixtures";
import { sealReferenceCodeSnapshot, type ReferenceCodeFile } from "./snapshot";

const BASE = "a".repeat(39) + "1";
const TREE = "b".repeat(39) + "2";
const REPOSITORY_ID = 987_654;
const AUTHORED_AT = 1_760_000_000;

const snapshot = sealReferenceCodeSnapshot({
  baseSha: BASE,
  treeSha: TREE,
  entries: referenceCodeLaunchRepository().map(file => ({ path: file.path, mode: file.mode as string, content: file.content })),
});

function freezeInput(files: readonly ReferenceCodeFile[], overrides: Partial<ReferenceCodeFreezeInput> = {}): ReferenceCodeFreezeInput {
  return {
    snapshot,
    files,
    repositoryId: REPOSITORY_ID,
    baseBranch: REFERENCE_CODE_FIXTURE_REQUEST.baseBranch,
    issue: REFERENCE_CODE_FIXTURE_REQUEST.issue,
    title: REFERENCE_CODE_FIXTURE_REQUEST.title,
    allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
    protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
    authoredAtSeconds: AUTHORED_AT,
    candidateGeneration: 0,
    ...overrides,
  };
}

describe("freezing a candidate into one complete tree and commit", () => {
  test("names the pinned base as the only parent and carries the whole tree", () => {
    const files = referenceCodeFixtureCandidate("accepted");
    const candidate = freezeReferenceCodeCandidate(freezeInput(files));
    expect(candidate.schemaVersion).toBe(REFERENCE_CODE_FREEZE_SCHEMA_VERSION);
    expect(candidate.baseSha).toBe(BASE);
    expect(candidate.treeSha).toMatch(/^[0-9a-f]{40}$/);
    expect(candidate.commitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(candidate.publication.baseSha).toBe(BASE);
    expect(candidate.publication.files).toHaveLength(files.length);
    expect(candidate.publication.files.map(file => file.path).sort()).toEqual(files.map(file => file.path).sort());
    expect(candidate.changedPaths).toEqual(["src/slugify.ts"]);
  });

  test("produces the same identity twice and a different one for a different generation", () => {
    const files = referenceCodeFixtureCandidate("accepted");
    const first = freezeReferenceCodeCandidate(freezeInput(files));
    const again = freezeReferenceCodeCandidate(freezeInput(files));
    expect(again.commitSha).toBe(first.commitSha);
    expect(again.treeSha).toBe(first.treeSha);
    const second = freezeReferenceCodeCandidate(freezeInput(files, { candidateGeneration: 1 }));
    expect(second.treeSha).toBe(first.treeSha);
    expect(second.commitSha).not.toBe(first.commitSha);
  });

  test("the frozen request is exactly what the release adapter accepts", () => {
    const candidate = freezeReferenceCodeCandidate(freezeInput(referenceCodeFixtureCandidate("accepted")));
    const plan = assertFactoryGitHubPublicationRequest(candidate.publication);
    expect(plan.request.commitSha).toBe(candidate.commitSha);
    expect(plan.blobs.size).toBe(candidate.publication.files.length);
    expect(candidate.publication.titleBodyDigest).toBe(`sha256:${digestObject({ title: candidate.publication.title, body: candidate.publication.body })}`);
    expect(candidate.publication.author).toEqual({ ...REFERENCE_CODE_COMMIT_AUTHOR, atSeconds: AUTHORED_AT });
    expect(candidate.publication.committer).toEqual(candidate.publication.author);
  });

  test("the pull-request body names the tested base and claims nothing about the moving head", () => {
    const candidate = freezeReferenceCodeCandidate(freezeInput(referenceCodeFixtureCandidate("accepted")));
    expect(candidate.publication.body).toContain(BASE);
    expect(candidate.publication.body).toContain("Candidate generation: 0.");
    expect(candidate.publication.body).toContain("They say nothing about the current head of the base branch");
    expect(referenceCodePullRequestBody({ issue: "i", baseSha: BASE, baseBranch: "main", candidateGeneration: 2 })).toContain("Candidate generation: 2.");
  });

  test("refuses a candidate that changed nothing", () => {
    expect(() => freezeReferenceCodeCandidate(freezeInput(referenceCodeLaunchRepository())))
      .toThrow(/reference_code_candidate_unchanged/);
  });

  test("refuses an empty tree and a tree with no dependency lock", () => {
    expect(() => freezeReferenceCodeCandidate(freezeInput([]))).toThrow(/reference_code_candidate_incomplete: empty tree/);
    const withoutLock = withoutReferenceCodeFile(referenceCodeFixtureCandidate("accepted"), "bun.lock");
    expect(() => freezeReferenceCodeCandidate(freezeInput(withoutLock))).toThrow(/reference_code_candidate_incomplete: bun\.lock/);
  });

  test("refuses the removed-protected-test candidate, in the release adapter's own vocabulary", () => {
    expect(() => freezeReferenceCodeCandidate(freezeInput(referenceCodeFixtureCandidate("removed-protected-test"))))
      .toThrow(/reference_code_candidate_invalid: factory_github_protected_asset_changed/);
  });

  test("refuses a submodule marker, a network install, and an LFS pointer through the same rules", () => {
    const accepted = referenceCodeFixtureCandidate("accepted");
    expect(() => freezeReferenceCodeCandidate(freezeInput(withReferenceCodeFile(accepted, ".gitmodules", "[submodule \"x\"]\n"))))
      .toThrow(/factory_github_submodule_rejected/);
    expect(() => freezeReferenceCodeCandidate(freezeInput(withReferenceCodeFile(accepted, "bunfig.toml", "[install]\n"))))
      .toThrow(/factory_github_network_install_rejected/);
    expect(() => freezeReferenceCodeCandidate(freezeInput(withReferenceCodeFile(accepted, "src/big.bin", "version https://git-lfs.github.com/spec/v1\noid sha256:0\n"))))
      .toThrow(/factory_github_lfs_rejected/);
  });

  test("refuses an escaping path before any identity is computed", () => {
    const escaping = [...referenceCodeFixtureCandidate("accepted"), { path: "../escape.ts", mode: "100644" as const, content: new TextEncoder().encode("x") }];
    expect(() => freezeReferenceCodeCandidate(freezeInput(escaping))).toThrow(/reference_code_candidate_invalid/);
  });

  test("carries the freeze error class so a caller can classify it", () => {
    const error = new ReferenceCodeFreezeError("reference_code_candidate_base_mismatch");
    expect(error.name).toBe("ReferenceCodeFreezeError");
    expect(error.code).toBe("reference_code_candidate_base_mismatch");
  });
});

describe("changed paths between two complete trees", () => {
  test("reports an edit, an addition, and a removal, sorted", () => {
    const base = referenceCodeLaunchRepository();
    const edited = withReferenceCodeFile(base, "src/slugify.ts", "export const x = 1;\n");
    const added = withReferenceCodeFile(edited, "src/extra.ts", "export const y = 2;\n");
    const removed = withoutReferenceCodeFile(added, "tsconfig.json");
    expect(referenceCodeChangedPaths(base, removed)).toEqual(["src/extra.ts", "src/slugify.ts", "tsconfig.json"]);
  });

  test("reports nothing for two identical trees", () => {
    expect(referenceCodeChangedPaths(referenceCodeLaunchRepository(), referenceCodeLaunchRepository())).toEqual([]);
  });

  test("reports a mode change as a change even when the bytes match", () => {
    const base = referenceCodeLaunchRepository();
    const executable = base.map(file => (file.path === "src/slugify.ts" ? { ...file, mode: "100755" as const } : file));
    expect(referenceCodeChangedPaths(base, executable)).toEqual(["src/slugify.ts"]);
  });
});
