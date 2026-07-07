/**
 * Sandbox-spawn capability probe — the NODE half (Playwright runs specs
 * under Node, see `bunx playwright test`'s `#!/usr/bin/env node` launcher).
 *
 * `sandboxSpawnAvailable()` answers a single question: can THIS host spawn a
 * sandboxed extension subprocess the way `src/extensions/subprocess.ts` does?
 * The two extension-spawn specs (extension-author-flow, extension-control-flow)
 * gate on it with a conditional `test.skip(() => !sandboxSpawnAvailable(), …)`
 * so they RUN on a capable runner (proving the install + control seams) and
 * SKIP cleanly on a capless one (e.g. GitHub hosted runners, where the
 * landlock jail denies exec of the setup-bun `bun` under `~/.bun/bin`). The
 * auth-fixture, harness-client-flow and role-carrying-key-flow specs never
 * touch an extension subprocess and always run.
 *
 * The real capability check lives in the sibling `_sandbox-spawn-probe.bun.ts`
 * and MUST run under Bun (it imports the sandbox machinery, which reaches
 * `bun:ffi` — unloadable under Node). We shell out to `bun` (the same runtime
 * the preview server uses to spawn extensions, resolved off the same PATH) and
 * read the exit code. This is not a proxy signal: the bun half runs the real
 * tier probe + real jail wrap around the real `prlimit + bun` chain, so its
 * verdict is exactly what the server would get.
 */
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
// web/e2e/real-auth → repo root (up three). Passed to the bun probe so the
// landlock-shim + node_modules/packages grants resolve at the worktree root,
// exactly as the harness sets EZCORP_PROJECT_ROOT for the preview server.
const PROJECT_ROOT = resolve(HERE, "..", "..", "..");
const PROBE_SCRIPT = resolve(HERE, "_sandbox-spawn-probe.bun.ts");

// Escape hatch to exercise the SKIP path on a capable box (and to prove the
// job stays green when the two specs are skipped): force the probe false.
const FORCED_OFF = process.env.EZCORP_E2E_FORCE_NO_SANDBOX === "1";

let cached: boolean | undefined;

/**
 * True when the extension sandbox can spawn a subprocess on this host.
 * Probed once per process (the spawn is cheap but not free).
 */
export function sandboxSpawnAvailable(): boolean {
  if (FORCED_OFF) return false;
  if (cached !== undefined) return cached;
  try {
    const res = spawnSync("bun", [PROBE_SCRIPT], {
      cwd: PROJECT_ROOT,
      env: { ...process.env, EZCORP_PROJECT_ROOT: PROJECT_ROOT },
      stdio: "ignore",
      timeout: 30_000,
    });
    // `status === 0` only when the bun probe ran the (possibly jailed) spawn
    // to a clean exit. A non-zero status, a null status (timeout/signal), or a
    // spawn error (`bun` missing) all mean "cannot spawn a sandboxed subprocess".
    cached = res.status === 0;
  } catch {
    cached = false;
  }
  return cached;
}
