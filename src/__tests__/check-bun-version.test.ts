/**
 * Unit + CLI tests for scripts/check-bun-version.ts — the bun version-skew
 * detector wired into scripts/test.sh, scripts/test-coverage.sh,
 * scripts/test-web.sh, .githooks/pre-commit and .githooks/pre-push (see
 * scripts/lib/bun-version-check.sh).
 *
 * Two layers:
 *   1. Pure-function tests on parseBunVersion/compareBunVersions/skewAction —
 *      this is exactly the code the task exists because of: a naive STRING
 *      compare reads "1.3.9" as newer than "1.3.14" (it isn't — 9 < 14),
 *      which is the specific gap that let a patch-level Bun skew masquerade
 *      as "pre-existing, ignore it" instead of the actual root cause.
 *   2. A spawn-not-import CLI layer (same pattern/ruling as
 *      src/__tests__/coverage-gate.test.ts: check-bun-version.ts resolves
 *      REPO_ROOT via `import.meta.dir`, so the sandbox copies the script and
 *      gives it its own `.bun-version`). The "actual" side is always
 *      whatever bun is really running the test — there is no way to fake
 *      Bun.version — so mismatches are constructed BY OFFSET from the real
 *      running version, which makes these tests correct on any bun (the dev
 *      box's 1.3.9, CI's 1.3.14, or anything else the pin moves to next).
 */
import { test, expect, describe } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, copyFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseBunVersion, compareBunVersions, skewAction } from "../../scripts/check-bun-version.ts";

const REPO_ROOT = resolve(import.meta.dir, "..", "..");
const CHECK_SCRIPT_SRC = join(REPO_ROOT, "scripts/check-bun-version.ts");

describe("parseBunVersion", () => {
  test("parses a plain major.minor.patch string", () => {
    expect(parseBunVersion("1.3.14")).toEqual({ major: 1, minor: 3, patch: 14 });
  });

  test("tolerates a leading v and trailing pre-release/build suffix", () => {
    expect(parseBunVersion("v1.3.9")).toEqual({ major: 1, minor: 3, patch: 9 });
    expect(parseBunVersion("1.3.9-canary.20240101")).toEqual({ major: 1, minor: 3, patch: 9 });
  });

  test("trims surrounding whitespace (as read from a file with a trailing newline)", () => {
    expect(parseBunVersion("1.3.14\n")).toEqual({ major: 1, minor: 3, patch: 14 });
    expect(parseBunVersion("  1.3.14  ")).toEqual({ major: 1, minor: 3, patch: 14 });
  });

  test("returns null for an incomplete or non-numeric version", () => {
    expect(parseBunVersion("1.3")).toBeNull();
    expect(parseBunVersion("not-a-version")).toBeNull();
    expect(parseBunVersion("")).toBeNull();
  });
});

describe("compareBunVersions", () => {
  test("identical versions match", () => {
    expect(compareBunVersions("1.3.14", "1.3.14").level).toBe("match");
  });

  test("whitespace differences alone still match (pin files end in a newline)", () => {
    expect(compareBunVersions("1.3.14\n", "1.3.14").level).toBe("match");
  });

  // THE IRONIC BUG this task is about: a naive string compare treats "1.3.9"
  // as GREATER than "1.3.14" (lexically, "9" > "1"), so a string-based check
  // could reach the wrong conclusion about which version is "ahead" and could
  // easily be miswired into comparing for equality incorrectly too. Assert
  // the numeric behaviour directly, and prove the string trap is real so this
  // test would catch a regression to string comparison.
  test("compares patch numbers numerically, not lexically (1.3.9 vs 1.3.14)", () => {
    // Sanity-check the trap exists at all: lexical "9" sorts after "1".
    expect("1.3.9" > "1.3.14").toBe(true);

    const result = compareBunVersions("1.3.14", "1.3.9");
    expect(result.level).toBe("patch");
    expect(result.pinned).toBe("1.3.14");
    expect(result.actual).toBe("1.3.9");

    // And the reverse direction is still just "patch" — a skew is a skew
    // regardless of which side is numerically larger.
    expect(compareBunVersions("1.3.9", "1.3.14").level).toBe("patch");
  });

  test("a patch-only difference is level=patch", () => {
    expect(compareBunVersions("1.3.14", "1.3.15").level).toBe("patch");
  });

  test("a minor difference is level=minor even when patch also differs", () => {
    expect(compareBunVersions("1.3.14", "1.4.0").level).toBe("minor");
    expect(compareBunVersions("1.3.14", "1.4.2").level).toBe("minor");
  });

  test("a major difference is level=major even when minor/patch also differ", () => {
    expect(compareBunVersions("1.3.14", "2.0.0").level).toBe("major");
    expect(compareBunVersions("1.3.14", "2.5.9").level).toBe("major");
  });

  test("major takes precedence over minor when both differ", () => {
    const result = compareBunVersions("1.9.9", "2.0.0");
    expect(result.level).toBe("major");
  });

  test("an unparseable pinned or actual version reports level=unparseable, not a crash", () => {
    expect(compareBunVersions("garbage", "1.3.14").level).toBe("unparseable");
    expect(compareBunVersions("1.3.14", "garbage").level).toBe("unparseable");
    expect(compareBunVersions("", "").level).toBe("unparseable");
  });
});

describe("skewAction", () => {
  test("match is completely silent and non-blocking", () => {
    const action = skewAction(compareBunVersions("1.3.14", "1.3.14"));
    expect(action).toEqual({ blocking: false, message: null });
  });

  test("patch skew warns but does not block, and names the exact fix command", () => {
    const action = skewAction(compareBunVersions("1.3.14", "1.3.9"));
    expect(action.blocking).toBe(false);
    expect(action.message).not.toBeNull();
    expect(action.message).toContain("patch");
    expect(action.message).toContain("bun upgrade --to 1.3.14");
  });

  test("minor skew blocks and names the fix + the bypass escape hatch", () => {
    const action = skewAction(compareBunVersions("1.3.14", "1.4.0"));
    expect(action.blocking).toBe(true);
    expect(action.message).toContain("minor");
    expect(action.message).toContain("bun upgrade --to 1.3.14");
    expect(action.message).toContain("EZ_SKIP_BUN_VERSION_CHECK=1");
  });

  test("major skew blocks and names the fix + the bypass escape hatch", () => {
    const action = skewAction(compareBunVersions("1.3.14", "2.0.0"));
    expect(action.blocking).toBe(true);
    expect(action.message).toContain("major");
    expect(action.message).toContain("bun upgrade --to 1.3.14");
    expect(action.message).toContain("EZ_SKIP_BUN_VERSION_CHECK=1");
  });

  test("an unparseable version warns but does not block", () => {
    const action = skewAction(compareBunVersions("garbage", "1.3.14"));
    expect(action.blocking).toBe(false);
    expect(action.message).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CLI layer: spawn the real script against a sandboxed `.bun-version`, with
// the mismatch sizes computed as an OFFSET from whatever bun is actually
// running this test — so the assertions hold on the 1.3.9 dev box, on CI's
// pinned 1.3.14, and after the next bump.
// ---------------------------------------------------------------------------

type Sandbox = { root: string; cleanup: () => void };

function makeSandbox(pinnedVersion: string): Sandbox {
  const root = mkdtempSync(join(tmpdir(), "bunverchk-"));
  mkdirSync(join(root, "scripts"), { recursive: true });
  copyFileSync(CHECK_SCRIPT_SRC, join(root, "scripts/check-bun-version.ts"));
  writeFileSync(join(root, ".bun-version"), `${pinnedVersion}\n`);
  return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

type RunResult = { exitCode: number; stdout: string; stderr: string };

async function runCheck(root: string, env?: Record<string, string>): Promise<RunResult> {
  const proc = Bun.spawn(["bun", join(root, "scripts/check-bun-version.ts")], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { exitCode, stdout, stderr };
}

const RUNNING = parseBunVersion(Bun.version);
if (!RUNNING) {
  throw new Error(`could not parse the running Bun.version="${Bun.version}" — test setup is broken`);
}

describe("check-bun-version.ts CLI (spawned against the real running bun)", () => {
  test("silent (no stdout/stderr, exit 0) when the pin matches the running bun", async () => {
    const sandbox = makeSandbox(Bun.version);
    try {
      const result = await runCheck(sandbox.root);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    } finally {
      sandbox.cleanup();
    }
  });

  test("warns to stderr but exits 0 on a patch-level pin mismatch", async () => {
    const pinned = `${RUNNING.major}.${RUNNING.minor}.${RUNNING.patch + 1}`;
    const sandbox = makeSandbox(pinned);
    try {
      const result = await runCheck(sandbox.root);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toContain("patch");
      expect(result.stderr).toContain(`bun upgrade --to ${pinned}`);
    } finally {
      sandbox.cleanup();
    }
  });

  test("fails (exit 1) with an error on a minor-level pin mismatch", async () => {
    const pinned = `${RUNNING.major}.${RUNNING.minor + 1}.0`;
    const sandbox = makeSandbox(pinned);
    try {
      const result = await runCheck(sandbox.root);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("minor");
      expect(result.stderr).toContain(`bun upgrade --to ${pinned}`);
    } finally {
      sandbox.cleanup();
    }
  });

  test("fails (exit 1) with an error on a major-level pin mismatch", async () => {
    const pinned = `${RUNNING.major + 1}.0.0`;
    const sandbox = makeSandbox(pinned);
    try {
      const result = await runCheck(sandbox.root);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("major");
    } finally {
      sandbox.cleanup();
    }
  });

  test("EZ_SKIP_BUN_VERSION_CHECK=1 bypasses a blocking (major) mismatch", async () => {
    const pinned = `${RUNNING.major + 1}.0.0`;
    const sandbox = makeSandbox(pinned);
    try {
      const result = await runCheck(sandbox.root, { EZ_SKIP_BUN_VERSION_CHECK: "1" });
      expect(result.exitCode).toBe(0);
      // Still warns — the bypass skips the EXIT, not the visibility.
      expect(result.stderr).toContain("major");
    } finally {
      sandbox.cleanup();
    }
  });

  test("missing .bun-version is a silent no-op, never a crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "bunverchk-nopin-"));
    mkdirSync(join(root, "scripts"), { recursive: true });
    copyFileSync(CHECK_SCRIPT_SRC, join(root, "scripts/check-bun-version.ts"));
    try {
      const result = await runCheck(root);
      expect(result.exitCode).toBe(0);
      expect(result.stderr).toBe("");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
