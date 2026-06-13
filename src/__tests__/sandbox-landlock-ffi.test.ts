/**
 * Phase A1/A2 — landlock-ffi.ts coverage for the syscall wrappers that are
 * SAFE to call in-process (they do NOT jail the runner).
 *
 * `restrict_self` is the point of no return — calling it would irreversibly
 * jail this test process — so it (and `applyReadOnlyJail`, which ends in
 * restrict_self) are exercised only in the spawned-child integration tests
 * (sandbox-landlock-shim-integration.test.ts) and the A1 self-test, never
 * here. Everything UP TO restrict_self is safe: create_ruleset just returns
 * an fd, add_rule attaches a rule to that fd, close_fd frees it.
 *
 * Skips cleanly where Landlock is unavailable.
 */
import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import {
  landlockAbiVersion,
  errno,
  createRuleset,
  addPathBeneathRule,
  closeFd,
  setNoNewPrivs,
  LANDLOCK_ACCESS_FS,
  READ_ACCESS,
} from "../extensions/sandbox/landlock-ffi";

const ABI = landlockAbiVersion();
const LANDLOCK_OK = ABI >= 1;

let DIR: string;
beforeAll(async () => {
  DIR = realpathSync(await mkdtemp(`${tmpdir()}/llffi-`));
});
afterAll(async () => {
  await rm(DIR, { recursive: true, force: true });
});

describe("landlock-ffi — safe syscall wrappers (no restrict_self)", () => {
  test("landlockAbiVersion returns a positive ABI on a Landlock kernel", () => {
    expect(typeof ABI).toBe("number");
    if (LANDLOCK_OK) expect(ABI).toBeGreaterThanOrEqual(1);
  });

  test("errno reads a number", () => {
    expect(typeof errno()).toBe("number");
  });

  test.if(LANDLOCK_OK)("createRuleset returns a valid fd, then closeFd frees it", () => {
    const handled =
      LANDLOCK_ACCESS_FS.EXECUTE |
      LANDLOCK_ACCESS_FS.READ_FILE |
      LANDLOCK_ACCESS_FS.READ_DIR;
    const fd = createRuleset(handled);
    expect(fd).toBeGreaterThanOrEqual(0);
    closeFd(fd);
  });

  test.if(LANDLOCK_OK)("addPathBeneathRule attaches a rule for an existing dir", () => {
    const handled =
      LANDLOCK_ACCESS_FS.EXECUTE |
      LANDLOCK_ACCESS_FS.READ_FILE |
      LANDLOCK_ACCESS_FS.READ_DIR;
    const fd = createRuleset(handled);
    expect(fd).toBeGreaterThanOrEqual(0);
    const rc = addPathBeneathRule(fd, DIR, READ_ACCESS & handled);
    expect(rc).toBe(0);
    closeFd(fd);
  });

  test.if(LANDLOCK_OK)("addPathBeneathRule returns -1 for a non-existent path", () => {
    const handled = LANDLOCK_ACCESS_FS.READ_FILE;
    const fd = createRuleset(handled);
    const rc = addPathBeneathRule(fd, "/no/such/path/zzz", READ_ACCESS & handled);
    expect(rc).toBe(-1);
    closeFd(fd);
  });

  test("READ_ACCESS is the exec+read_file+read_dir subset", () => {
    expect(READ_ACCESS).toBe(
      LANDLOCK_ACCESS_FS.EXECUTE |
        LANDLOCK_ACCESS_FS.READ_FILE |
        LANDLOCK_ACCESS_FS.READ_DIR,
    );
  });

  // NOTE: setNoNewPrivs() + restrictSelf() + applyReadOnlyJail() are NOT
  // called here on purpose — PR_SET_NO_NEW_PRIVS and restrict_self mutate
  // the runner process irreversibly. They are exercised in a spawned CHILD
  // by sandbox-landlock-shim-integration.test.ts and the A1 self-test.
  test("setNoNewPrivs is exported (exercised live in the shim child)", () => {
    expect(typeof setNoNewPrivs).toBe("function");
  });
});
