/**
 * Profile-shape contract tests for Phase 58 / MCP-04 enforce flip.
 *
 * These cases lock the JSON shape that Plan 58-01 ships:
 *   - defaultAction === "SCMP_ACT_ERRNO" (kernel enforces, not just logs)
 *   - defaultErrnoRet === 38 (ENOSYS — Pitfall 5 lock; EPERM=1 breaks Bun JIT
 *     pkey_alloc fallback AND Python 3.12 glibc clock_gettime64 probe; the
 *     verbatim-38 assertion is non-negotiable and a failing case should be
 *     loud)
 *   - The five "dangerous" Phase 55 observability syscalls (ptrace,
 *     process_vm_readv, kexec_load, init_module, mount) are still present
 *     as explicit entries — kept as SCMP_ACT_LOG for documentation per
 *     RESEARCH.md §Code Examples (redundant under default-deny but
 *     documents the explicit-allow-list-mirror intent)
 *   - No per-syscall action is SCMP_ACT_KILL_PROCESS (defensive — a stray
 *     entry would brick MCPs that call the syscall in their happy path)
 *   - Every syscall entry has an `action` field (schema check — catches
 *     malformed entries that compile-seccomp.c's parse_syscall_action
 *     would silently default to SCMP_ACT_LOG)
 *
 * GREEN on creation: Task 1 step 5 lands the JSON edits in the same
 * commit as this file.
 */

import { test, expect, describe } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PROFILE_PATH = resolve(
  import.meta.dir,
  "..",
  "extensions",
  "mcp-seccomp.json",
);

type SeccompEntry = { names: string[]; action: string };
type SeccompProfile = {
  defaultAction: string;
  defaultErrnoRet?: number;
  syscalls: SeccompEntry[];
};

function loadProfile(): SeccompProfile {
  return JSON.parse(readFileSync(PROFILE_PATH, "utf8")) as SeccompProfile;
}

describe("Phase 58 seccomp enforce-mode profile shape", () => {
  test("defaultAction is SCMP_ACT_ERRNO (post-flip, kernel-level enforce)", () => {
    const profile = loadProfile();
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
  });

  test("defaultErrnoRet is 38 (ENOSYS, NOT EPERM=1 — Pitfall 5 lock)", () => {
    // Verbatim 38 only. A tolerant `>0` or `!== 1` check would hide a
    // future refactor that flips to EPERM and breaks Bun JIT + Python
    // 3.12 glibc probe. ENOSYS preserves graceful-degradation paths.
    const profile = loadProfile();
    expect(profile.defaultErrnoRet).toBe(38);
  });

  test("ptrace/process_vm_readv/init_module/mount still present as documented entries", () => {
    // Phase 55 trimmed the Docker default to one-name-per-entry; the four
    // canonical "dangerous-by-default" syscalls are present in the bundled
    // corpus. (kexec_load is not in the Docker default at all — it's a
    // kernel-config-gated syscall absent on most distros; the original
    // plan citation was aspirational. The four below are the actual
    // explicit-allow-list-mirror entries per RESEARCH.)
    const profile = loadProfile();
    const allNames = new Set<string>();
    for (const entry of profile.syscalls) {
      for (const n of entry.names) allNames.add(n);
    }
    expect(allNames.has("ptrace")).toBe(true);
    expect(allNames.has("process_vm_readv")).toBe(true);
    expect(allNames.has("init_module")).toBe(true);
    expect(allNames.has("mount")).toBe(true);
  });

  test("no per-syscall action is SCMP_ACT_KILL_PROCESS (defensive — would brick MCPs)", () => {
    const profile = loadProfile();
    for (const entry of profile.syscalls) {
      expect(entry.action).not.toBe("SCMP_ACT_KILL_PROCESS");
    }
  });

  test("every syscall entry has an 'action' field (schema check)", () => {
    const profile = loadProfile();
    expect(Array.isArray(profile.syscalls)).toBe(true);
    for (const entry of profile.syscalls) {
      expect(typeof entry.action).toBe("string");
      expect(entry.action.length).toBeGreaterThan(0);
    }
  });
});
