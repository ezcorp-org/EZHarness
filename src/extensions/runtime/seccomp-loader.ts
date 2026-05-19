/**
 * Seccomp BPF blob loader — Phase 55 Plan 03 (MCP-03).
 *
 * `mcp-sandbox.ts` calls `openSeccompBpfFd()` before spawning the MCP
 * child. The returned raw FD is threaded into Bun.spawn's `stdio` array
 * at index 3 (FD-passthrough); the launcher script reads
 * `$EZCORP_MCP_BWRAP_SECCOMP_FD` and appends `--seccomp <fd>` to its
 * inner `bwrap` exec line.
 *
 * Why a separate module:
 *   1. Test seam — tests `mock.module("../runtime/seccomp-loader", ...)`
 *      to drive the "file missing" branch deterministically without
 *      filesystem manipulation.
 *   2. Single chokepoint — Phase 58 will extend this with a per-spawn
 *      cBPF re-load if/when arch-aware profile selection lands.
 *
 * The BPF blob is produced at Docker image build time by the
 * `build/compile-seccomp.c` helper (Dockerfile compile-stage RUN). On
 * dev hosts (macOS / NixOS without `docker build`) the file is absent
 * → openSeccompBpfFd() returns null → the launcher silently skips the
 * `--seccomp` flag and the MCP runs without the log-mode profile.
 *
 * Tied to:
 *   - `src/extensions/mcp-seccomp.json`  — source-of-truth profile.
 *   - `src/extensions/mcp-seccomp.bpf`   — build artifact opened here.
 *   - `build/compile-seccomp.c`          — JSON→BPF transformer.
 *   - `src/extensions/mcp-sandbox.ts`    — sole production caller.
 *   - `src/extensions/mcp-launcher.sh`   — consumer of FD 3.
 */

import { existsSync, openSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

/**
 * Absolute path of the compiled BPF blob. The file lives next to
 * `seccomp-loader.ts` on disk (sibling of `mcp-seccomp.json`); we
 * resolve it via `import.meta.url` so the path works in both the
 * Bun source tree (`/app/src/extensions/...`) and any future bundled
 * layout.
 *
 * Exported for the profile-shape tests which assert the file is in
 * the expected location.
 */
export function getSeccompBpfPath(): string {
  // import.meta.url points at this module's compiled location
  // (.../src/extensions/runtime/seccomp-loader.ts in dev,
  //  /app/src/extensions/runtime/seccomp-loader.ts in the image).
  // The .bpf sits one directory up, next to mcp-seccomp.json.
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "mcp-seccomp.bpf");
}

/**
 * Open the pre-compiled cBPF blob and return a raw FD suitable for
 * passing to Bun.spawn's stdio array (FD-passthrough).
 *
 * Returns null when:
 *   - the host is not Linux (the kernel seccomp filter only applies
 *     on Linux; on macOS / Windows there is nothing to load).
 *   - the BPF file does not exist (most commonly: a dev host that
 *     never ran `docker build`).
 *   - the BPF file is empty (compile-stage failed; treat as absent).
 *   - opening the file throws for any other reason.
 *
 * Callers MUST close the parent's reference to the FD after Bun.spawn
 * returns (Bun copies the FD into the child's descriptor table; the
 * parent's reference is no longer needed and would leak otherwise).
 */
export function openSeccompBpfFd(): number | null {
  if (process.platform !== "linux") return null;
  const path = getSeccompBpfPath();
  try {
    if (!existsSync(path)) return null;
    const st = statSync(path);
    if (!st || st.size === 0) return null;
    // O_RDONLY — bwrap reads the BPF program from the FD; no write.
    return openSync(path, "r");
  } catch {
    // Permission denied, EMFILE, etc. — treat as "unavailable" rather
    // than fail-stop so the MCP can still spawn (degraded mode).
    return null;
  }
}
