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

// ── poisoned-env guard-with-control (item C, W18 hygiene GC5) ──────────
//
// readGitHead/readCommitSubjects/readOriginUrl used to spawn with
// `env: { ...process.env, ...HERMETIC_GIT_ENV }`, and the old HERMETIC_GIT_ENV
// only disabled global/system git config — it never touched GIT_DIR and
// friends. A git hook (or anything invoked from inside one) that exports
// GIT_DIR overrides the explicit `-C repoPath` these functions pass: git
// prefers the env var over repository discovery, so the read would
// silently reflect the HOOK's repository instead of `repoPath`. Unlike
// `unlanded-branches.ts`'s bug (env omitted entirely), these three DO
// explicitly spread `process.env` at call time, so mutating it in-process
// (restored after) is a valid simulation here — confirmed, not assumed.
describe("git readers — ambient GIT_DIR poisoning is neutralized", () => {
  let scratchRoot: string;
  let scratch: ScratchRepository;
  let repo: string;
  let foreignRoot: string;
  let foreignScratch: ScratchRepository;
  let foreignRepo: string;

  beforeEach(() => {
    scratchRoot = join(tmpdir(), `du-git-poison-target-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    scratch = scratchRepository(scratchRoot, { name: "Probe", email: "probe@example.test" });
    repo = scratch.dir;
    writeFileSync(join(repo, "README.md"), "# probe\n");
    scratch.git("add", "README.md");
    scratch.git("commit", "-q", "-m", "feat: initial");

    foreignRoot = join(tmpdir(), `du-git-poison-foreign-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    foreignScratch = scratchRepository(foreignRoot, { name: "Foreign", email: "foreign@example.test" });
    foreignRepo = foreignScratch.dir;
    writeFileSync(join(foreignRepo, "unrelated.txt"), "nothing to do with repo\n");
    foreignScratch.git("add", "unrelated.txt");
    foreignScratch.git("commit", "-q", "-m", "FOREIGN commit — must never surface for repo");
  });

  afterEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
    rmSync(foreignRoot, { recursive: true, force: true });
  });

  function withPoisonedGitDir<T>(fn: () => T): T {
    const saved = {
      GIT_DIR: process.env.GIT_DIR,
      GIT_WORK_TREE: process.env.GIT_WORK_TREE,
      GIT_INDEX_FILE: process.env.GIT_INDEX_FILE,
    };
    process.env.GIT_DIR = join(foreignRepo, ".git");
    process.env.GIT_WORK_TREE = foreignRepo;
    process.env.GIT_INDEX_FILE = join(foreignRepo, ".git", "index");
    try {
      return fn();
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  }

  test("readGitHead(repo) ignores an ambient GIT_DIR pointing at a foreign repo", async () => {
    const head = await withPoisonedGitDir(() => readGitHead(repo));
    expect(head!.subject).toBe("feat: initial");
  });

  test("readCommitSubjects(repo) ignores an ambient GIT_DIR pointing at a foreign repo", async () => {
    const subjects = await withPoisonedGitDir(() => readCommitSubjects(repo, undefined));
    expect(subjects).toEqual(["feat: initial"]);
  });

  test("readOriginUrl(repo) ignores an ambient GIT_DIR pointing at a foreign repo", async () => {
    scratch.git("remote", "add", "origin", "git@github.com:real/repo.git");
    foreignScratch.git("remote", "add", "origin", "git@github.com:foreign/repo.git");
    const origin = await withPoisonedGitDir(() => readOriginUrl(repo));
    expect(origin).toBe("git@github.com:real/repo.git");
  });
});
