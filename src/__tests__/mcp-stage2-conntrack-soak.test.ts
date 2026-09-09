import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { stage2Enabled } from "./helpers/stage2-proof";

function runSoak(seconds: number, workers: number, requests: number, killWorker = false) {
  const result = Bun.spawnSync({
    cmd: ["node", resolve(import.meta.dir, "../../scripts/stage2-conntrack-soak.mjs")],
    env: { ...process.env, EZCORP_STAGE2_SOAK_SECONDS: String(seconds),
      EZCORP_STAGE2_SOAK_WORKERS: String(workers), EZCORP_STAGE2_SOAK_REQUESTS: String(requests),
      EZCORP_STAGE2_KILL_WORKER: killWorker ? "1" : "0" },
    stdout: "pipe", stderr: "pipe",
  });
  const stdout = new TextDecoder().decode(result.stdout);
  const stderr = new TextDecoder().decode(result.stderr);
  return { exit: result.exitCode, stderr, stdout };
}

describe.skipIf(!stage2Enabled)("Stage2 measured connection tracking", () => {
  test("four workers complete 400 real proxy requests over five minutes and leave no owned containers", () => {
    const result = runSoak(300, 4, 100);
    expect(result.exit, result.stdout + result.stderr).toBe(0);
    expect(result.stderr).toBe("");
    const receipt = JSON.parse(result.stdout);
    console.info(result.stdout.trim());
    expect(receipt).toMatchObject({ workers: 4, requestsPerWorker: 100, expectedLoadRequests: 400,
      seconds: 300, tableFull: 0, finalOwnedContainers: 0, failures: [] });
    expect(receipt.results).toHaveLength(4);
    expect(receipt.elapsedMs).toBeGreaterThanOrEqual(300_000);
  }, 370_000);

  test("a killed worker fails the same controller despite low connection counts", () => {
    const result = runSoak(2, 1, 4, true);
    expect(result.exit, result.stdout + result.stderr).toBe(1);
    expect(result.stderr).toContain("CONNTRACK_SOAK_FAILED: worker 0: worker failed");
    expect(result.stderr).toContain("SIGKILL");
    const receipt = JSON.parse(result.stdout);
    expect(receipt.finalOwnedContainers).toBe(0);
    expect(receipt.failures).toHaveLength(1);
  }, 60_000);
});
