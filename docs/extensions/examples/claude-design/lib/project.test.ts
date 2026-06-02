// Unit tests for the claude-design project/path helpers.
//
// `findProjectRoot`'s env fast-path is exercised incidentally by the
// other suites, but its `.git` walk-up (the test/CLI fallback) and
// `handoffsDir` are not — this file pins them. `handoffsDir` routes
// through `@ezcorp/sdk/runtime`'s host-mediated `fsMkdir`, so we stub
// `getChannel().request` for `ezcorp/fs.mkdir` → real tmp-dir IO, the
// same pattern handoff.test.ts uses.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getChannel } from "@ezcorp/sdk/runtime";
import { spyOn } from "bun:test";
import { findProjectRoot, handoffsDir, defaultProjectSlug } from "./project";

const ORIG_ROOT = process.env.EZCORP_PROJECT_ROOT;

function installFsStub(): void {
  const ch = getChannel();
  spyOn(ch, "request").mockImplementation((async (
    method: string,
    params: unknown,
  ): Promise<unknown> => {
    const p = (params ?? {}) as Record<string, unknown>;
    const path = p.path as string;
    if (method === "ezcorp/fs.mkdir") {
      mkdirSync(path, { recursive: p.recursive === true });
      return { resolvedPath: path };
    }
    throw new Error(`project test stub: unexpected RPC method ${method}`);
  }) as ReturnType<typeof getChannel>["request"]);
}

describe("findProjectRoot", () => {
  beforeEach(() => {
    delete process.env.EZCORP_PROJECT_ROOT;
  });
  afterEach(() => {
    if (ORIG_ROOT === undefined) delete process.env.EZCORP_PROJECT_ROOT;
    else process.env.EZCORP_PROJECT_ROOT = ORIG_ROOT;
  });

  test("env fast-path wins when EZCORP_PROJECT_ROOT is set", () => {
    process.env.EZCORP_PROJECT_ROOT = "/host/injected/root";
    expect(findProjectRoot("/anything")).toBe("/host/injected/root");
  });

  test("walks UP from a nested dir to the nearest ancestor that has a .git", () => {
    const repo = mkdtempSync(join(tmpdir(), "cd-proj-"));
    mkdirSync(join(repo, ".git"));
    const nested = join(repo, "a", "b", "c");
    mkdirSync(nested, { recursive: true });
    try {
      // No .git in a/b/c → loop ascends a→b→c→repo until it finds repo/.git.
      expect(findProjectRoot(nested)).toBe(repo);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("returns the starting dir when no .git exists up to the filesystem root", () => {
    const lonely = mkdtempSync(join(tmpdir(), "cd-nogit-"));
    try {
      // Ascends to `/` without finding `.git` → `parent === dir` → returns
      // the original `from`.
      expect(findProjectRoot(lonely)).toBe(lonely);
    } finally {
      rmSync(lonely, { recursive: true, force: true });
    }
  });

  test("defaultProjectSlug is the basename of the resolved root", () => {
    process.env.EZCORP_PROJECT_ROOT = "/home/dev/my-cool-project";
    expect(defaultProjectSlug()).toBe("my-cool-project");
  });
});

describe("handoffsDir", () => {
  const ORIG_FS_ALLOWED = process.env.EZCORP_FS_ALLOWED;
  beforeEach(() => {
    // The SDK fsMkdir pre-flight requires this grant flag set.
    process.env.EZCORP_FS_ALLOWED = "1";
    installFsStub();
  });
  afterEach(() => {
    if (ORIG_FS_ALLOWED === undefined) delete process.env.EZCORP_FS_ALLOWED;
    else process.env.EZCORP_FS_ALLOWED = ORIG_FS_ALLOWED;
  });

  test("creates and returns the handoffs subdir under the data dir", async () => {
    const root = mkdtempSync(join(tmpdir(), "cd-handoff-"));
    try {
      const dir = await handoffsDir(root);
      expect(dir).toBe(
        join(root, ".ezcorp", "extension-data", "claude-design", "handoffs"),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
