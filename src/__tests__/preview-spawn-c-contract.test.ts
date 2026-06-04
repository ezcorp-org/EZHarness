/**
 * Source-text contract tests for build/preview-spawn.c — Secure User-Site
 * Preview / Port Exposure, Phase 3a (the setuid-root spawn helper; see
 * tasks/preview-port-exposure.md "Phase 3 REDESIGN — portable uid-based
 * isolation", item 1).
 *
 * Why source-text grep over runtime gcc (mirrors
 * src/__tests__/mcp-seccomp-compile.test.ts):
 *   - A C toolchain isn't guaranteed on every dev host (macOS without Xcode
 *     CLT, NixOS outside a nix-shell). Runtime compilation + execution of a
 *     setuid drop also needs root + a real preview uid, which is only
 *     available in the Docker build/runtime — the live privilege-drop test
 *     is therefore Docker-gated.
 *   - The CI Docker build compiles + installs the helper 4755 for real (the
 *     canonical correctness gate); this file is the host-side backstop that
 *     catches a refactor silently deleting one of the keystone invariants
 *     before it ever reaches the build.
 *   - Token-level assertions are stable across formatter passes — the
 *     ORDER (setgroups → setgid → setuid), the range refusal, the
 *     drop-did-not-stick abort, clearenv, and no-shell exec are load-bearing
 *     security properties, not layout.
 *
 * This is the ONLY practical host coverage of the C keystone.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const SPAWN_C_PATH = resolve(
  import.meta.dir,
  "..",
  "..",
  "build",
  "preview-spawn.c",
);

function loadSource(): string {
  return readFileSync(SPAWN_C_PATH, "utf8");
}

/**
 * Strip C comments (block + line) so the contract asserts on actual CODE,
 * not the file's own documentation. The header comment legitimately
 * mentions `system()`, `sh -c`, and lists the drop sequence in prose — none
 * of which should satisfy (or violate) a code-property assertion.
 */
function loadCode(): string {
  return loadSource()
    .replace(/\/\*[\s\S]*?\*\//g, " ") // block comments
    .replace(/\/\/[^\n]*/g, " "); // line comments
}

/** Index of the first match of `re` in `src`, or -1 if absent. Used for the
 *  ORDER assertions (a security property: groups dropped before gid before
 *  uid). */
function firstIndex(src: string, re: RegExp): number {
  const m = re.exec(src);
  return m ? m.index : -1;
}

describe("preview-spawn.c source contract — uid range allowlist (keystone)", () => {
  test("refuses a target uid outside [PREVIEW_UID_MIN, PREVIEW_UID_MAX]", () => {
    const code = loadCode();
    // The keystone refusal: the helper may ONLY ever drop to a preview uid,
    // never escalate to / stay root, never become the app uid. The guard is
    // `if (uid < PREVIEW_UID_MIN || uid > PREVIEW_UID_MAX) { ... fail ... }`.
    expect(code).toMatch(/uid\s*<\s*PREVIEW_UID_MIN\s*\|\|\s*uid\s*>\s*PREVIEW_UID_MAX/);
  });

  test("defines the allowlisted range constants", () => {
    const src = loadSource();
    expect(src).toMatch(/#define\s+PREVIEW_UID_MIN\s+\d+/);
    expect(src).toMatch(/#define\s+PREVIEW_UID_MAX\s+\d+/);
  });
});

describe("preview-spawn.c source contract — privilege-drop ordering", () => {
  test("drops ALL supplementary groups via setgroups(0, NULL)", () => {
    const code = loadCode();
    expect(code).toMatch(/setgroups\s*\(\s*0\s*,\s*NULL\s*\)/);
  });

  test("calls setgroups BEFORE setgid BEFORE setuid (order is load-bearing)", () => {
    const code = loadCode();
    const setgroupsAt = firstIndex(code, /setgroups\s*\(\s*0\s*,\s*NULL\s*\)/);
    const setgidAt = firstIndex(code, /setgid\s*\(/);
    const setuidAt = firstIndex(code, /setuid\s*\(\s*\(uid_t\)/);

    expect(setgroupsAt).toBeGreaterThanOrEqual(0);
    expect(setgidAt).toBeGreaterThanOrEqual(0);
    expect(setuidAt).toBeGreaterThanOrEqual(0);

    // setgroups(0) must precede setgid (you cannot drop supplementary
    // groups after dropping the privilege that lets you), and setgid must
    // precede setuid (you cannot setgid after you've dropped uid).
    expect(setgroupsAt).toBeLessThan(setgidAt);
    expect(setgidAt).toBeLessThan(setuidAt);
  });

  test("verifies the drop STUCK — refuses to exec if setuid(0) succeeds", () => {
    const code = loadCode();
    // The "drop did not stick" backstop: after dropping, attempt to regain
    // root; if that succeeds the drop silently no-op'd → abort, never exec.
    expect(code).toMatch(/setuid\s*\(\s*0\s*\)\s*==\s*0/);
    // The refusal message lives in a string literal (survives comment strip).
    expect(code).toMatch(/did not stick/i);
  });
});

describe("preview-spawn.c source contract — environment + exec", () => {
  test("clears the parent environment via clearenv() before exec", () => {
    const code = loadCode();
    expect(code).toMatch(/clearenv\s*\(\s*\)/);
    // clearenv must come before execvp — the secret-bearing parent env must
    // never reach the untrusted child.
    const clearenvAt = firstIndex(code, /clearenv\s*\(\s*\)/);
    const execAt = firstIndex(code, /execvp\s*\(/);
    expect(clearenvAt).toBeGreaterThanOrEqual(0);
    expect(execAt).toBeGreaterThanOrEqual(0);
    expect(clearenvAt).toBeLessThan(execAt);
  });

  test("execs via execvp — NOT a shell (no system()/sh -c injection surface)", () => {
    // Assert on CODE (comments legitimately mention `system()`/`sh -c`).
    const code = loadCode();
    // execvp passes argv verbatim — nothing is re-interpreted by a shell.
    expect(code).toMatch(/execvp\s*\(/);
    // Hard refuse the shell-injection forms: system() and an `sh -c` /
    // `/bin/sh` exec are both forbidden in this helper.
    expect(code).not.toMatch(/\bsystem\s*\(/);
    expect(code).not.toMatch(/sh\s+-c/);
    expect(code).not.toMatch(/\/bin\/sh/);
  });
});
