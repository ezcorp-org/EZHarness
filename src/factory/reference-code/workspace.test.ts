import { describe, expect, test } from "bun:test";
import { chmod, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { referenceCodeFixtureCandidate, referenceCodeLaunchRepository } from "./fixtures";
import { referenceCodeFilesDigest, type ReferenceCodeFile } from "./snapshot";
import {
  materializeReferenceCodeWorkspace,
  ReferenceCodeProcessRunner,
  ReferenceCodeWorkspaceError,
  REFERENCE_CODE_OUTPUT_LIMIT,
} from "./workspace";

const PROTECTED = ["test/slugify.protected.test.ts", "package.json"];

async function workspaceFor(files: readonly ReferenceCodeFile[], digest = referenceCodeFilesDigest(files)) {
  return materializeReferenceCodeWorkspace({ files, expectedDigest: digest, protectedPaths: PROTECTED, prefix: "ezcorp-w10-test-" });
}

describe("the disposable validation copy", () => {
  test("writes the complete tree and verifies its digest by reading it back", async () => {
    const files = referenceCodeFixtureCandidate("accepted");
    const workspace = await workspaceFor(files);
    try {
      expect(workspace.verifiedDigest).toBe(referenceCodeFilesDigest(files));
      const written = await readFile(join(workspace.root, "src/slugify.ts"), "utf8");
      expect(written).toContain("words.join(\"-\")");
    } finally { await workspace.dispose(); }
  });

  test("refuses a tree whose bytes do not match the digest it was frozen under, and leaves nothing behind", async () => {
    const files = referenceCodeLaunchRepository();
    let root: string | undefined;
    await expect((async () => {
      const workspace = await materializeReferenceCodeWorkspace({ files, expectedDigest: "sha256:" + "0".repeat(64), protectedPaths: [], prefix: "ezcorp-w10-test-" });
      root = workspace.root;
    })()).rejects.toThrow(/reference_code_workspace_digest_mismatch/);
    expect(root).toBeUndefined();
  });

  test("refuses a path that escapes the copy", async () => {
    await expect(materializeReferenceCodeWorkspace({
      files: [{ path: "../escape.ts", mode: "100644", content: new TextEncoder().encode("x") }],
      expectedDigest: "sha256:" + "0".repeat(64),
      protectedPaths: [],
    })).rejects.toThrow(/reference_code_workspace_path_escape: \.\.\/escape\.ts/);
  });

  test("marks protected assets read-only and preserves an executable mode", async () => {
    const files = referenceCodeFixtureCandidate("accepted").map(file => (file.path === "src/slugify.ts" ? { ...file, mode: "100755" as const } : file));
    const workspace = await workspaceFor(files);
    try {
      expect((await stat(join(workspace.root, "package.json"))).mode & 0o777).toBe(0o444);
      expect((await stat(join(workspace.root, "src/slugify.ts"))).mode & 0o777).toBe(0o755);
    } finally { await workspace.dispose(); }
  });

  test("catches a protected asset that a command rewrote", async () => {
    const workspace = await workspaceFor(referenceCodeFixtureCandidate("accepted"));
    try {
      await workspace.assertProtectedUnchanged();
      const target = join(workspace.root, "test/slugify.protected.test.ts");
      await chmod(target, 0o644);
      await writeFile(target, "// deleted every assertion\n");
      await expect(workspace.assertProtectedUnchanged()).rejects.toThrow(/reference_code_workspace_protected_modified: test\/slugify\.protected\.test\.ts/);
    } finally { await workspace.dispose(); }
  });

  test("ignores a protected path the candidate does not contain, leaving that to the static claim", async () => {
    const files = referenceCodeLaunchRepository();
    const workspace = await materializeReferenceCodeWorkspace({
      files,
      expectedDigest: referenceCodeFilesDigest(files),
      protectedPaths: ["docs/absent.md"],
    });
    try {
      // The absent path is simply not sealed, so the check passes and the copy still holds the tree.
      await workspace.assertProtectedUnchanged();
      expect(await readFile(join(workspace.root, "package.json"), "utf8")).toContain("slugify-launch");
    } finally { await workspace.dispose(); }
  });

  test("dispose removes the copy and is safe to repeat", async () => {
    const workspace = await workspaceFor(referenceCodeLaunchRepository());
    const { root } = workspace;
    await workspace.dispose();
    await workspace.dispose();
    await expect(stat(root)).rejects.toThrow();
  });

  test("carries the workspace error class so a caller can classify it", () => {
    const error = new ReferenceCodeWorkspaceError("reference_code_workspace_digest_mismatch");
    expect(error.name).toBe("ReferenceCodeWorkspaceError");
    expect(error.message).toBe("reference_code_workspace_digest_mismatch");
  });
});

describe("the check command runner", () => {
  test("reports a real exit code rather than a pipeline's", async () => {
    const runner = new ReferenceCodeProcessRunner();
    const failure = await runner.run(["sh", "-c", "echo out; echo err 1>&2; exit 3"], { cwd: process.cwd(), timeoutMs: 30_000 });
    expect(failure.exitCode).toBe(3);
    expect(failure.output).toContain("out");
    expect(failure.output).toContain("err");
    expect(failure.timedOut).toBe(false);
    expect(failure.truncated).toBe(false);
    expect(failure.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("kills a command that outruns its budget and says so", async () => {
    const result = await new ReferenceCodeProcessRunner().run(["sh", "-c", "sleep 30"], { cwd: process.cwd(), timeoutMs: 250 });
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
  });

  test("truncates a flood of output instead of holding all of it", async () => {
    const result = await new ReferenceCodeProcessRunner().run(["sh", "-c", `yes abcdefghij | head -c ${REFERENCE_CODE_OUTPUT_LIMIT * 4}`], { cwd: process.cwd(), timeoutMs: 30_000 });
    expect(result.truncated).toBe(true);
    expect(result.output.length).toBeLessThanOrEqual(REFERENCE_CODE_OUTPUT_LIMIT);
  });

  test("reports a command that could not start rather than pretending it passed", async () => {
    const result = await new ReferenceCodeProcessRunner().run(["ezcorp-w10-not-a-command"], { cwd: process.cwd(), timeoutMs: 5_000 });
    expect(result.exitCode).toBe(-1);
    expect(result.output).toContain("ezcorp-w10-not-a-command");
  });

  test("passes the pinned environment through and refuses an empty command", async () => {
    const runner = new ReferenceCodeProcessRunner({ EZCORP_W10_PROBE: "pinned" });
    const result = await runner.run(["sh", "-c", "echo $EZCORP_W10_PROBE"], { cwd: process.cwd(), timeoutMs: 30_000 });
    expect(result.output.trim()).toBe("pinned");
    expect(() => runner.run([], { cwd: process.cwd(), timeoutMs: 1_000 })).toThrow(/executable/);
  });
});
