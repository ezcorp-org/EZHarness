/**
 * Real-auth Playwright globalTeardown.
 *
 * Best-effort cleanup of the per-run PGlite directory + storage-state
 * file. Failures are non-fatal: the next run uses a fresh `mkdtemp`
 * dir anyway, so a stranded directory from a crashed run only costs
 * a few KB of /tmp until the OS reaps it.
 *
 * We intentionally do NOT rm the `.ezcorp/extensions/<name>/` install
 * dirs that the extension-author-flow spec creates — `afterEach` in
 * the spec hits `/api/__test/cleanup-extension`, and a per-test
 * cleanup is more reliable than a global one (a spec mid-write would
 * race with teardown otherwise).
 */
import { existsSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE_PATH = path.join(__dirname, ".real-auth.json");

export default async function globalTeardown(): Promise<void> {
  const dbDir = process.env.EZCORP_DB_PATH;
  if (dbDir && existsSync(dbDir) && dbDir.includes("ezcorp-e2e-")) {
    // Defensive substring check: never `rm -rf` a path that doesn't
    // look like a mkdtemp from our config. Belt-and-braces against a
    // future change that accidentally wires a real path here.
    try {
      await rm(dbDir, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
  if (existsSync(STORAGE_STATE_PATH)) {
    try {
      await unlink(STORAGE_STATE_PATH);
    } catch {
      // best-effort
    }
  }
}
