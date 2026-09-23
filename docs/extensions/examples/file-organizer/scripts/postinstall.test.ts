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
  repo = mkdtempSync(join(tmpdir(), "file-organizer-postinstall-"));
  markGitRepository(repo);
  mkdirSync(join(repo, "sub", ".git"), { recursive: true });
  const nested = join(repo, "sub", "deep");
  mkdirSync(nested);
  const dataDir = join(repo, ".ezcorp", "extension-data", "file-organizer");
  const log = spyOn(console, "log").mockImplementation(() => {});
  let messages: unknown[][] = [];
  try {
    await runInDirectory(nested, () => import("./postinstall"));
  } finally {
    messages = [...log.mock.calls];
    log.mockRestore();
  }
  expect(existsSync(join(dataDir, ".trash"))).toBe(true);
  expect(existsSync(join(repo, "watched"))).toBe(true);
  expect(JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"))).toEqual({ folders: [], globalIgnore: [".ezcorp/data", ".git", "node_modules"], schemaVersion: 1 });
  expect(readFileSync(join(repo, "docker-compose.override.yml.example"), "utf8")).toContain("EZCORP_WATCH_DIR");
  expect(existsSync(join(repo, "sub", ".ezcorp"))).toBe(false);
  expect(messages).toContainEqual([`file-organizer scaffolded: ${dataDir} (+ ${join(repo, "watched")})`]);
});
