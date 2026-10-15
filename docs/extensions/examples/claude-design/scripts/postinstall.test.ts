// The postinstall script scaffolds at import time from the working directory.
// Run it from inside a nested directory of a temp git repository, below a
// stray empty `.git` that is not a repository, and check it lands at the root.

import { afterEach, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { markGitRepository, runInDirectory } from "@ezcorp/sdk/test";

let repo = "";
afterEach(() => {
  if (repo) rmSync(repo, { recursive: true, force: true });
});

test("scaffolds under the enclosing git repository root, not a stray .git or the cwd", async () => {
  repo = mkdtempSync(join(tmpdir(), "claude-design-postinstall-"));
  markGitRepository(repo);
  mkdirSync(join(repo, "sub", ".git"), { recursive: true });
  const nested = join(repo, "sub", "deep");
  mkdirSync(nested);
  const dataDir = join(repo, ".ezcorp", "extension-data", "claude-design");
  // An existing config is the user's and must survive a re-run.
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "config.json"), "{\"version\":1,\"defaultMode\":\"custom\"}\n");
  const log = spyOn(console, "log").mockImplementation(() => {});
  let messages: unknown[][] = [];
  try {
    await runInDirectory(nested, () => import("./postinstall"));
  } finally {
    messages = [...log.mock.calls];
    log.mockRestore();
  }
  expect(existsSync(join(dataDir, "projects"))).toBe(true);
  expect(existsSync(join(dataDir, "handoffs"))).toBe(true);
  expect(readFileSync(join(dataDir, "config.json"), "utf8")).toBe("{\"version\":1,\"defaultMode\":\"custom\"}\n");
  expect(existsSync(join(repo, "sub", ".ezcorp"))).toBe(false);
  expect(messages).toContainEqual([`[claude-design] data dir scaffolded at ${dataDir}`]);
});
