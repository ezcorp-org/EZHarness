import { test, expect, describe, afterEach, beforeEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, writeFileSync } from "node:fs";
import { readGitHead, readCommitSubjects, readOriginUrl, parseOriginUrl } from "../../../../docs/extensions/examples/docs-updater/index";
import { scratchRepository, type ScratchRepository } from "../../../__tests__/helpers/scratch-git";

// ── readGitHead / readCommitSubjects (real throwaway repo) ───────────

describe("git readers (real repo)", () => {
  let scratch: ScratchRepository;
  let scratchRoot: string;
  let repo: string;
  beforeEach(() => {
    scratchRoot = join(tmpdir(), `du-git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    scratch = scratchRepository(scratchRoot, { name: "Probe", email: "probe@example.test" });
    repo = scratch.dir;
    writeFileSync(join(repo, "README.md"), "# probe\n");
    scratch.git("add", "README.md");
    scratch.git("commit", "-q", "-m", "feat: initial");
  });
  afterEach(() => rmSync(scratchRoot, { recursive: true, force: true }));

  test("readGitHead reads HEAD hash + subject", async () => {
    const head = await readGitHead(repo);
    expect(head!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(head!.subject).toBe("feat: initial");
  });
  test("readGitHead on a non-repo → null", async () => {
    expect(await readGitHead(join(tmpdir(), `du-nope-${Date.now()}`))).toBeNull();
  });
  test("readCommitSubjects with no since → just HEAD subject", async () => {
    expect(await readCommitSubjects(repo, undefined)).toEqual(["feat: initial"]);
  });
  test("readCommitSubjects over a range returns the new subjects", async () => {
    const first = (await readGitHead(repo))!.hash;
    writeFileSync(join(repo, "docs.md"), "docs\n");
    scratch.git("add", "docs.md");
    scratch.git("commit", "-q", "-m", "docs: add");
    expect(await readCommitSubjects(repo, first)).toEqual(["docs: add"]);
  });
  test("readOriginUrl → null with no origin remote", async () => {
    expect(await readOriginUrl(repo)).toBeNull();
  });
  test("readOriginUrl reads the configured origin remote", async () => {
    scratch.git("remote", "add", "origin", "git@github.com:o/r.git");
    expect(await readOriginUrl(repo)).toBe("git@github.com:o/r.git");
    expect(parseOriginUrl((await readOriginUrl(repo))!)).toEqual({ owner: "o", repo: "r" });
  });
});
