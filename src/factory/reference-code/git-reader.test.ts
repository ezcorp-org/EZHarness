import { afterAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { freezeReferenceCodeCandidate } from "./freeze";
import { referenceCodeFixtureCandidate, referenceCodeLaunchRepository, REFERENCE_CODE_FIXTURE_REQUEST } from "./fixtures";
import { ReferenceCodeGitReader } from "./git-reader";
import { snapshotReferenceCodeRepository } from "./snapshot";

/**
 * Real git is the oracle here, twice over: it produces the base commit the snapshot pins, and it
 * recomputes the tree and commit the freeze claims. A locally derived identity that real git
 * disagrees with would publish an object the operation never approved.
 */

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "",
      HOME: cwd,
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_AUTHOR_NAME: "Fixture",
      GIT_AUTHOR_EMAIL: "fixture@ezcorp.invalid",
      GIT_AUTHOR_DATE: "1700000000 +0000",
      GIT_COMMITTER_NAME: "Fixture",
      GIT_COMMITTER_EMAIL: "fixture@ezcorp.invalid",
      GIT_COMMITTER_DATE: "1700000000 +0000",
    },
  });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

/** A real repository holding the launch fixture at one deterministic commit. */
async function launchRepository(extra: ReadonlyArray<{ path: string; mode: string; content: string }> = []): Promise<{ path: string; baseSha: string }> {
  const path = await mkdtemp(join(tmpdir(), "ezcorp-w10-git-"));
  roots.push(path);
  git(path, "init", "--quiet", "--initial-branch", "main");
  for (const file of referenceCodeLaunchRepository()) {
    const absolute = join(path, file.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content);
  }
  for (const file of extra) {
    const absolute = join(path, file.path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, file.content);
  }
  git(path, "add", "-A");
  if (extra.some(file => file.mode === "100755")) {
    for (const file of extra.filter(entry => entry.mode === "100755")) git(path, "update-index", "--chmod=+x", file.path);
  }
  git(path, "commit", "--quiet", "-m", "base");
  return { path, baseSha: git(path, "rev-parse", "HEAD") };
}

afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

describe("snapshotting a real repository at a pinned commit", () => {
  test("reads the complete tree and matches the repository's own tree id", async () => {
    const repository = await launchRepository();
    const reader = new ReferenceCodeGitReader({ repositoryPath: repository.path });
    const snapshot = await snapshotReferenceCodeRepository(reader, repository.baseSha);
    expect(snapshot.baseSha).toBe(repository.baseSha);
    expect(snapshot.treeSha).toBe(git(repository.path, "rev-parse", "HEAD^{tree}"));
    expect(snapshot.files.map(file => file.path)).toEqual(referenceCodeLaunchRepository().map(file => file.path));
    const lock = snapshot.files.find(file => file.path === "bun.lock")!;
    expect(new TextDecoder().decode(lock.content)).toContain("typescript@5.9.3");
  });

  test("reads an executable file with its mode preserved", async () => {
    const repository = await launchRepository([{ path: "src/tool.ts", mode: "100755", content: "export const tool = 1;\n" }]);
    const snapshot = await snapshotReferenceCodeRepository(new ReferenceCodeGitReader({ repositoryPath: repository.path }), repository.baseSha);
    expect(snapshot.files.find(file => file.path === "src/tool.ts")!.mode).toBe("100755");
  });

  test("refuses a branch name, a short prefix, and an unknown commit", async () => {
    const repository = await launchRepository();
    const reader = new ReferenceCodeGitReader({ repositoryPath: repository.path });
    await expect(snapshotReferenceCodeRepository(reader, "main")).rejects.toThrow();
    await expect(snapshotReferenceCodeRepository(reader, repository.baseSha.slice(0, 8))).rejects.toThrow();
    await expect(reader.resolveCommit("0".repeat(40))).rejects.toThrow(/reference_code_(base_commit_unknown|repository_unreadable)/);
  });

  test("refuses a repository it cannot read", async () => {
    const reader = new ReferenceCodeGitReader({ repositoryPath: join(tmpdir(), "ezcorp-w10-absent") });
    await expect(reader.resolveCommit("0".repeat(40))).rejects.toThrow(/reference_code_repository_unreadable/);
  });

  test("refuses a tree containing a submodule, by name", async () => {
    const repository = await launchRepository();
    // A gitlink entry written directly into the index, which is what a submodule is on disk.
    git(repository.path, "update-index", "--add", "--cacheinfo", `160000,${"0".repeat(39)}1,vendor`);
    const treeSha = git(repository.path, "write-tree");
    const commitSha = git(repository.path, "commit-tree", treeSha, "-p", repository.baseSha, "-m", "submodule");
    const reader = new ReferenceCodeGitReader({ repositoryPath: repository.path });
    await expect(snapshotReferenceCodeRepository(reader, commitSha)).rejects.toThrow(/reference_code_tree_unsupported: submodule at vendor/);
  });

  test("refuses a tree containing a symlink, by name", async () => {
    const repository = await launchRepository();
    const blob = git(repository.path, "hash-object", "-w", "--stdin", "--path", "link");
    git(repository.path, "update-index", "--add", "--cacheinfo", `120000,${blob || "0".repeat(40)},src/link`);
    const treeSha = git(repository.path, "write-tree");
    const commitSha = git(repository.path, "commit-tree", treeSha, "-p", repository.baseSha, "-m", "symlink");
    const reader = new ReferenceCodeGitReader({ repositoryPath: repository.path });
    await expect(snapshotReferenceCodeRepository(reader, commitSha)).rejects.toThrow(/reference_code_tree_unsupported: symlink at src\/link/);
  });
});

describe("the frozen candidate's identity, checked against real git", () => {
  test("real git writes the tree and commit the freeze named", async () => {
    const repository = await launchRepository();
    const snapshot = await snapshotReferenceCodeRepository(new ReferenceCodeGitReader({ repositoryPath: repository.path }), repository.baseSha);
    const candidate = freezeReferenceCodeCandidate({
      snapshot,
      files: referenceCodeFixtureCandidate("accepted"),
      repositoryId: 1,
      baseBranch: REFERENCE_CODE_FIXTURE_REQUEST.baseBranch,
      issue: REFERENCE_CODE_FIXTURE_REQUEST.issue,
      title: REFERENCE_CODE_FIXTURE_REQUEST.title,
      allowedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.allowedPaths],
      protectedPaths: [...REFERENCE_CODE_FIXTURE_REQUEST.protectedPaths],
      authoredAtSeconds: 1_760_000_000,
      candidateGeneration: 0,
    });

    // Write the candidate's own bytes into the repository and let git name the resulting objects.
    for (const file of candidate.publication.files) {
      const absolute = join(repository.path, file.path);
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, Buffer.from(file.contentBase64, "base64"));
    }
    git(repository.path, "add", "-A");
    const treeSha = git(repository.path, "write-tree");
    expect(treeSha).toBe(candidate.treeSha);

    const commitSha = spawnSync("git", ["commit-tree", treeSha, "-p", snapshot.baseSha, "-m", candidate.publication.commitMessage], {
      cwd: repository.path,
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "",
        HOME: repository.path,
        GIT_CONFIG_GLOBAL: "/dev/null",
        GIT_CONFIG_SYSTEM: "/dev/null",
        GIT_AUTHOR_NAME: candidate.publication.author.name,
        GIT_AUTHOR_EMAIL: candidate.publication.author.email,
        GIT_AUTHOR_DATE: `${candidate.publication.author.atSeconds} +0000`,
        GIT_COMMITTER_NAME: candidate.publication.committer.name,
        GIT_COMMITTER_EMAIL: candidate.publication.committer.email,
        GIT_COMMITTER_DATE: `${candidate.publication.committer.atSeconds} +0000`,
      },
    }).stdout.trim();
    expect(commitSha).toBe(candidate.commitSha);
    expect(git(repository.path, "rev-list", "--parents", "-n", "1", commitSha).split(" ")[1]).toBe(snapshot.baseSha);
  });
});
