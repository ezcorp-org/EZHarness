/**
 * Real-auth Playwright globalTeardown.
 *
 * Cleanup of the real-auth storage-state file.
 *
 * The outer `scripts/run-real-e2e.ts` owns generated PGlite cleanup only after
 * Playwright's webServer plugin has stopped the preview process. Playwright
 * runs this hook before that plugin teardown, so it must never remove DB data.
 *
 * We intentionally do NOT rm the `.ezcorp/extensions/<name>/` install
 * dirs that the extension-author-flow spec creates — `afterEach` in
 * the spec hits `/api/__test/cleanup-extension`, and a per-test
 * cleanup is more reliable than a global one (a spec mid-write would
 * race with teardown otherwise).
 */
import { existsSync } from "node:fs";
import { unlink } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE_PATH = path.join(__dirname, ".real-auth.json");

export default async function globalTeardown(): Promise<void> {
  if (existsSync(STORAGE_STATE_PATH)) {
    try {
      await unlink(STORAGE_STATE_PATH);
    } catch {
      // best-effort
    }
  }
}
