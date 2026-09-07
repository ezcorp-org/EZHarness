/**
 * Real-auth Playwright globalTeardown.
 *
 * Best-effort cleanup of the per-run PGlite directory + storage-state
 * file. `playwright.real.config.ts` publishes its generated directory through
 * Playwright config metadata, so this teardown owns the same directory that
 * booted the webServer child.
 *
 * We intentionally do NOT rm the `.ezcorp/extensions/<name>/` install
 * dirs that the extension-author-flow spec creates — `afterEach` in
 * the spec hits `/api/__test/cleanup-extension`, and a per-test
 * cleanup is more reliable than a global one (a spec mid-write would
 * race with teardown otherwise).
 */
import { existsSync } from "node:fs";
import { rm, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { FullConfig } from "@playwright/test";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STORAGE_STATE_PATH = path.join(__dirname, ".real-auth.json");

export default async function globalTeardown(config: FullConfig): Promise<void> {
  const configuredDbDir = config.metadata.e2eDbDir;
  const dbDir = typeof configuredDbDir === "string" ? configuredDbDir : undefined;
  const ownsDbDir = config.metadata.e2eDbOwned === true;
  const isGeneratedDbDir = dbDir
    && path.dirname(path.resolve(dbDir)) === path.resolve(tmpdir())
    && path.basename(dbDir).startsWith("ezcorp-e2e-");
  if (ownsDbDir && isGeneratedDbDir && existsSync(dbDir)) {
    // This process created the exact tmpdir. A caller-supplied
    // PI_E2E_REAL_DB_PATH is never teardown-owned.
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
