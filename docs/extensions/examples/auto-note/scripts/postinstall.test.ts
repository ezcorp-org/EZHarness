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
  repo = mkdtempSync(join(tmpdir(), "auto-note-postinstall-"));
  markGitRepository(repo);
  mkdirSync(join(repo, "sub", ".git"), { recursive: true });
  const nested = join(repo, "sub", "deep");
  mkdirSync(nested);
  const vault = join(repo, ".ezcorp", "extension-data", "auto-note", "vault");
  const log = spyOn(console, "log").mockImplementation(() => {});
  let messages: unknown[][] = [];
  try {
    await runInDirectory(nested, () => import("./postinstall"));
  } finally {
    messages = [...log.mock.calls];
    log.mockRestore();
  }
  for (const category of ["ideas", "tasks", "decisions", "references", "journal", "meetings"]) {
    expect(existsSync(join(vault, category))).toBe(true);
  }
  expect(readFileSync(join(vault, "_index.md"), "utf8")).toContain("# Vault Index");
  expect(existsSync(join(repo, "sub", ".ezcorp"))).toBe(false);
  expect(existsSync(join(nested, ".ezcorp"))).toBe(false);
  expect(messages).toContainEqual([`Auto Note vault initialized at ${vault}`]);
});
