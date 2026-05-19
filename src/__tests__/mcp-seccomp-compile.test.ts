/**
 * Source-text contract tests for build/compile-seccomp.c — Phase 58 / MCP-04.
 *
 * Why source-text grep over runtime gcc:
 *   - libseccomp-dev is absent on most dev hosts (macOS, NixOS without nix-
 *     shell). Runtime compilation would force every contributor to install
 *     it just to run unit tests.
 *   - The CI build stage compiles for real (Dockerfile RUN), which is the
 *     canonical correctness gate; this file catches refactor regressions
 *     between local edits and the build.
 *   - Token-level assertions are stable across formatter passes (the
 *     `parse_default_action` function name is load-bearing in the contract,
 *     not its layout).
 *
 * RED state on creation: build/compile-seccomp.c is the Phase-55 shape
 * (hardcoded SCMP_ACT_LOG at lines 111 + 148, no parse_default_action
 * helper, no SCMP_FLTATR_ACT_BADARCH set). Task 2 rewrites the file and
 * this whole describe block flips GREEN.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const COMPILE_C_PATH = resolve(
  import.meta.dir,
  "..",
  "..",
  "build",
  "compile-seccomp.c",
);

function loadSource(): string {
  return readFileSync(COMPILE_C_PATH, "utf8");
}

describe("Phase 58 compile-seccomp.c parses defaultAction from JSON", () => {
  test("parse_default_action helper exists (declaration + call site)", () => {
    const src = loadSource();
    // Function name must appear at least twice: one definition + one call.
    const matches = src.match(/parse_default_action/g) ?? [];
    expect(matches.length).toBeGreaterThanOrEqual(2);
  });

  test("parse_default_action recognizes SCMP_ACT_ERRNO + LOG + ALLOW + KILL strings", () => {
    const src = loadSource();
    // Each of the four action strings must appear in the source so the
    // helper can strncmp against them.
    expect(src).toMatch(/SCMP_ACT_ERRNO/);
    expect(src).toMatch(/SCMP_ACT_LOG/);
    expect(src).toMatch(/SCMP_ACT_ALLOW/);
    expect(src).toMatch(/SCMP_ACT_KILL/);
  });

  test("seccomp_init is NOT called with the literal SCMP_ACT_LOG hardcode (Phase 55 leftover)", () => {
    const src = loadSource();
    // The Phase 55 hardcode was `seccomp_init(SCMP_ACT_LOG)`. Post-flip
    // it reads `seccomp_init(parse_default_action(...))` or via a local
    // variable. The literal `seccomp_init(SCMP_ACT_LOG)` MUST NOT
    // appear anywhere in the source.
    expect(src).not.toMatch(/seccomp_init\(\s*SCMP_ACT_LOG\s*\)/);
  });

  test("SCMP_FLTATR_ACT_BADARCH set to SCMP_ACT_ERRNO(ENOSYS) on the ctx", () => {
    const src = loadSource();
    // The seccomp_attr_set call site must reference SCMP_FLTATR_ACT_BADARCH
    // — that's the libseccomp attribute name for the unknown-arch action.
    expect(src).toMatch(/SCMP_FLTATR_ACT_BADARCH/);
    // And the value passed must be SCMP_ACT_ERRNO(ENOSYS) somewhere in
    // the source (we don't pin exact whitespace).
    expect(src).toMatch(/SCMP_ACT_ERRNO\s*\(\s*ENOSYS\s*\)/);
  });

  test("per-syscall seccomp_rule_add no longer uses hardcoded SCMP_ACT_LOG literal", () => {
    const src = loadSource();
    // The Phase 55 hardcode was `seccomp_rule_add(ctx, SCMP_ACT_LOG, n, 0)`.
    // Post-flip it reads from a parsed local. The literal arg-2
    // `SCMP_ACT_LOG` to seccomp_rule_add MUST be gone.
    expect(src).not.toMatch(/seccomp_rule_add\(\s*ctx\s*,\s*SCMP_ACT_LOG\s*,/);
  });
});
