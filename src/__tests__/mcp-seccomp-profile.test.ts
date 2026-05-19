/**
 * Profile-shape + Dockerfile-shape tests — Phase 55 Plan 03 (MCP-03).
 *
 * Two describe blocks:
 *
 *   1. "seccomp profile shape" — asserts the source-of-truth JSON has
 *      the expected shape (defaultAction === SCMP_ACT_ERRNO post-Phase-58,
 *      ≥250 syscall entries, every entry's action === SCMP_ACT_LOG —
 *      kept as the documented explicit-allow-list-mirror per
 *      RESEARCH §Code Examples), and (when the .bpf artifact is
 *      present — i.e. after `docker build` or a CI regenerate) that
 *      `openSeccompBpfFd()` returns a usable FD.
 *
 *   2. "Dockerfile shape" — text-only assertions on Dockerfile that
 *      `bubblewrap` + `libseccomp2` are apt-installed and a build-stage
 *      `gcc ... -lseccomp` compile step produces mcp-seccomp.bpf. These
 *      cases are the W2-checker automated gate for Success Criterion #4
 *      — they GREEN as soon as the Dockerfile edits land, without
 *      needing a full `docker build` to run in the test suite.
 *
 * Test seam:
 *   - The .bpf-presence test SKIPs cleanly on non-Linux dev hosts where
 *     the artifact wasn't compiled (most macOS / NixOS hosts).
 *   - All other tests are platform-agnostic — they read text files.
 */

import { test, expect, describe } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { openSeccompBpfFd, getSeccompBpfPath } from "../extensions/runtime/seccomp-loader";

const PROFILE_PATH = resolve(import.meta.dir, "..", "extensions", "mcp-seccomp.json");
const BPF_PATH = resolve(import.meta.dir, "..", "extensions", "mcp-seccomp.bpf");
const DOCKERFILE_PATH = resolve(import.meta.dir, "..", "..", "Dockerfile");

// `.bpf` is only generated inside `docker build`. On dev hosts without
// the artifact (macOS, NixOS without docker), the FD-open tests SKIP.
const BPF_PRESENT = existsSync(BPF_PATH);

describe("seccomp profile shape", () => {
  test("mcp-seccomp.json: defaultAction is SCMP_ACT_ERRNO (post-Phase-58 enforce flip)", async () => {
    // Phase 55 shipped SCMP_ACT_LOG (observability mode). Phase 58 /
    // MCP-04 flipped to SCMP_ACT_ERRNO with defaultErrnoRet=38 (ENOSYS)
    // — kernel enforces instead of just logging. See
    // mcp-seccomp-enforce-flip.test.ts for the full Phase 58 contract.
    const profile = await Bun.file(PROFILE_PATH).json();
    expect(profile.defaultAction).toBe("SCMP_ACT_ERRNO");
  });

  test("mcp-seccomp.json: every syscalls[].action is SCMP_ACT_LOG", async () => {
    const profile = await Bun.file(PROFILE_PATH).json();
    expect(Array.isArray(profile.syscalls)).toBe(true);
    for (const entry of profile.syscalls) {
      expect(entry.action).toBe("SCMP_ACT_LOG");
    }
  });

  test("mcp-seccomp.json: syscalls array has >=250 entries", async () => {
    // Docker default has ~300 syscall names. Phase 55 flattens to one
    // name per entry. >=250 is a generous floor — drops below this
    // mean the profile got gutted.
    const profile = await Bun.file(PROFILE_PATH).json();
    expect(profile.syscalls.length).toBeGreaterThanOrEqual(250);
  });

  test.skipIf(!BPF_PRESENT)(
    "mcp-seccomp.bpf exists and is non-empty",
    async () => {
      const file = Bun.file(BPF_PATH);
      const size = file.size;
      expect(size).toBeGreaterThan(0);
    },
  );

  test.skipIf(!BPF_PRESENT)(
    "openSeccompBpfFd returns a usable FD when the .bpf is present (Linux)",
    () => {
      const fd = openSeccompBpfFd();
      if (process.platform !== "linux") {
        // Even on a host where the file exists, openSeccompBpfFd is a
        // no-op on non-Linux platforms (kernel seccomp is Linux-only).
        expect(fd).toBeNull();
        return;
      }
      expect(typeof fd).toBe("number");
      expect(fd).toBeGreaterThan(2);  // not stdin/stdout/stderr
      // Best-effort close so we don't leak the FD into other tests.
      try {
        const { closeSync } = require("node:fs");
        if (fd !== null) closeSync(fd);
      } catch {
        /* test cleanup is best-effort */
      }
    },
  );

  test("openSeccompBpfFd returns null on non-Linux platforms (loader contract)", () => {
    // We can't easily flip process.platform inside this test without
    // breaking other tests, so we sanity-check the contract: on non-
    // Linux hosts the function returns null (kernel seccomp is Linux-
    // only). On Linux hosts WITHOUT the .bpf this is also null (the
    // BPF_PRESENT-gated test above covers the present case).
    if (process.platform !== "linux" || !BPF_PRESENT) {
      const fd = openSeccompBpfFd();
      expect(fd).toBeNull();
    }
  });

  test("getSeccompBpfPath returns an absolute path ending in /mcp-seccomp.bpf", () => {
    const p = getSeccompBpfPath();
    expect(p.startsWith("/")).toBe(true);
    expect(p.endsWith("/mcp-seccomp.bpf")).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────
// Dockerfile shape (W2 checker — automated gate for SC#4)
//
// Text-only assertions on `Dockerfile`. These GREEN as soon as Task 1
// step 3 lands the Dockerfile edits — independent of whether a real
// `docker build` has run. Cheap, deterministic, and they catch the
// most common regression class: an editor accidentally drops the
// `bubblewrap` token or breaks the compile-stage RUN.
// ─────────────────────────────────────────────────────────────────────

describe("Dockerfile shape", () => {
  test("Dockerfile apt-installs bubblewrap", async () => {
    const content = await Bun.file(DOCKERFILE_PATH).text();
    expect(/\bbubblewrap\b/.test(content)).toBe(true);
  });

  test("Dockerfile apt-installs libseccomp2", async () => {
    const content = await Bun.file(DOCKERFILE_PATH).text();
    expect(/\blibseccomp2\b/.test(content)).toBe(true);
  });

  test("Dockerfile builds the BPF blob via gcc + libseccomp", async () => {
    const content = await Bun.file(DOCKERFILE_PATH).text();
    // Build-stage line invokes gcc against compile-seccomp.c with -lseccomp.
    expect(/gcc[^\n]*compile-seccomp\.c[^\n]*-lseccomp/.test(content)).toBe(true);
    // Build-stage invocation references both the JSON profile and the BPF
    // output, proving the JSON→BPF transformation is wired up.
    expect(
      /compile-seccomp[^\n]*mcp-seccomp\.json[^\n]*mcp-seccomp\.bpf/.test(content),
    ).toBe(true);
  });
});
