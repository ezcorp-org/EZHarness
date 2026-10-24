import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../..");

/** The backend pool's per-test budget in ms, read from its one definition, EZ_POOL_TEST_TIMEOUT_MS in
 *  scripts/lib/watchdog.sh (the file scripts/test.sh runs every pool file through). A test that spawns its own
 *  `bun test`, or that checks a command which passes the budget, reads it here instead of writing the number. */
function readPoolTestTimeoutMs(): string {
  const proc = Bun.spawnSync(["bash", "-c", '. scripts/lib/watchdog.sh && printf %s "$EZ_POOL_TEST_TIMEOUT_MS"'], { cwd: REPO_ROOT });
  const value = proc.stdout.toString();
  if (proc.exitCode !== 0 || !/^[1-9][0-9]*$/.test(value)) throw new Error(`scripts/lib/watchdog.sh did not give EZ_POOL_TEST_TIMEOUT_MS: "${value}"`);
  return value;
}

export const POOL_TEST_TIMEOUT_MS = readPoolTestTimeoutMs();
