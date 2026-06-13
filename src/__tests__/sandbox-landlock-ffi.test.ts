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
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  landlockAbiVersion,
  errno,
  createRuleset,
  addPathBeneathRule,
  closeFd,
  setNoNewPrivs,
  handledAccessForAbi,
  LANDLOCK_ACCESS_FS,
  READ_ACCESS,
  WRITE_ACCESS,
  FILE_ACCESS_MASK,
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

  test("WRITE_ACCESS is read-inclusive + mutating rights (write/make/remove/…)", () => {
    expect(WRITE_ACCESS & READ_ACCESS).toBe(READ_ACCESS); // superset of read
    expect(WRITE_ACCESS & LANDLOCK_ACCESS_FS.WRITE_FILE).toBe(LANDLOCK_ACCESS_FS.WRITE_FILE);
    expect(WRITE_ACCESS & LANDLOCK_ACCESS_FS.MAKE_DIR).toBe(LANDLOCK_ACCESS_FS.MAKE_DIR);
    expect(WRITE_ACCESS & LANDLOCK_ACCESS_FS.REMOVE_FILE).toBe(LANDLOCK_ACCESS_FS.REMOVE_FILE);
  });

  test("FILE_ACCESS_MASK is the file-applicable subset (no dir-only rights)", () => {
    expect(FILE_ACCESS_MASK & LANDLOCK_ACCESS_FS.READ_DIR).toBe(0n);
    expect(FILE_ACCESS_MASK & LANDLOCK_ACCESS_FS.MAKE_DIR).toBe(0n);
    expect(FILE_ACCESS_MASK & LANDLOCK_ACCESS_FS.WRITE_FILE).toBe(LANDLOCK_ACCESS_FS.WRITE_FILE);
    expect(FILE_ACCESS_MASK & LANDLOCK_ACCESS_FS.READ_FILE).toBe(LANDLOCK_ACCESS_FS.READ_FILE);
  });

  test("handledAccessForAbi grows REFER (v2+) + TRUNCATE (v3+) with the ABI", () => {
    const v1 = handledAccessForAbi(1);
    expect(v1 & LANDLOCK_ACCESS_FS.REFER).toBe(0n);
    expect(v1 & LANDLOCK_ACCESS_FS.TRUNCATE).toBe(0n);
    const v2 = handledAccessForAbi(2);
    expect(v2 & LANDLOCK_ACCESS_FS.REFER).toBe(LANDLOCK_ACCESS_FS.REFER);
    const v3 = handledAccessForAbi(3);
    expect(v3 & LANDLOCK_ACCESS_FS.TRUNCATE).toBe(LANDLOCK_ACCESS_FS.TRUNCATE);
    // v1 always handles the core write set.
    expect(v1 & LANDLOCK_ACCESS_FS.WRITE_FILE).toBe(LANDLOCK_ACCESS_FS.WRITE_FILE);
  });

  test.if(LANDLOCK_OK)(
    "addPathBeneathRule grants a write rule on a FILE path (file-mask kept valid)",
    async () => {
      // Granting the file-applicable WRITE subset on a regular file must NOT
      // EINVAL (it would if dir-only bits leaked through).
      const handled = handledAccessForAbi(ABI);
      const fd = createRuleset(handled);
      expect(fd).toBeGreaterThanOrEqual(0);
      const file = join(DIR, "wfile.txt");
      await writeFile(file, "x");
      const rc = addPathBeneathRule(fd, file, WRITE_ACCESS & FILE_ACCESS_MASK & handled);
      expect(rc).toBe(0);
      closeFd(fd);
    },
  );

  // NOTE: setNoNewPrivs() + restrictSelf() + applyReadOnlyJail() are NOT
  // called here on purpose — PR_SET_NO_NEW_PRIVS and restrict_self mutate
  // the runner process irreversibly. They are exercised in a spawned CHILD
  // by sandbox-landlock-shim-integration.test.ts and the A1 self-test.
  test("setNoNewPrivs is exported (exercised live in the shim child)", () => {
    expect(typeof setNoNewPrivs).toBe("function");
  });
});
