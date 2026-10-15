import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { rmSync, writeFileSync } from "node:fs";
import { readGitHead } from "../../../../docs/extensions/examples/repo-activity-notify/index";
import { scratchRepository, type ScratchRepository } from "../../../__tests__/helpers/scratch-git";

describe("readGitHead", () => {
  let scratch: ScratchRepository;
  let scratchRoot: string;
  let repo: string;

  beforeEach(() => {
    scratchRoot = join(tmpdir(), `ran-git-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    scratch = scratchRepository(scratchRoot, { name: "Probe", email: "probe@example.test" });
    repo = scratch.dir;
    writeFileSync(join(repo, "a.txt"), "hello\n");
    scratch.git("add", "a.txt");
    scratch.git("commit", "-q", "-m", "feat: initial commit");
  });

  afterEach(() => {
    rmSync(scratchRoot, { recursive: true, force: true });
  });

  test("reads HEAD hash + subject from a real repo", async () => {
    const head = await readGitHead(repo);
    expect(head).not.toBeNull();
    expect(head!.hash).toMatch(/^[0-9a-f]{40}$/);
    expect(head!.subject).toBe("feat: initial commit");
  });

  test("a non-repo path → null (git exits non-zero)", async () => {
    const missing = join(tmpdir(), `ran-nope-${Date.now()}`);
    expect(await readGitHead(missing)).toBeNull();
  });
});
