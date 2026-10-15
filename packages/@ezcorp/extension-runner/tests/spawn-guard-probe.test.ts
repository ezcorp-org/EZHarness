/**
 * The startup probe measures the spawn guard, and capabilities() reports it.
 *
 * A fake `podman` answers the isolation probe as secure and runs the runner's
 * REAL guard program on this host, in the guest's language, so the guard
 * really installs its filter and really proves a spawn fails. A second fake
 * makes the guard program fail, as on a host where the filter cannot be
 * installed: the runner still starts, and reports no enforcement.
 */
import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodmanRunner, PythonPodmanRunner } from "../src";

const dir = mkdtempSync(join(tmpdir(), "runner-guard-probe-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fakePodman(name: string, guardWorks: boolean): string {
  const path = join(dir, `podman-${name}`);
  writeFileSync(path, `#!/usr/bin/env bun
const args = process.argv.slice(2);
if (args[0] === "info") {
  console.log(JSON.stringify({ host: { security: { rootless: true, seccompEnabled: true }, cgroupVersion: "v2", cgroupControllers: ["cpu", "memory", "pids"] } }));
} else if (args[0] === "run") {
  const program = args.at(-1);
  if (!program.includes("spawn guard")) {
    console.log(JSON.stringify({ uid: 65534, writable: false, memory: "134217728", swap: "0", cpu: "50000 100000", pids: "32", status: "CapEff:\\t0000000000000000\\nNoNewPrivs:\\t1\\nSeccomp:\\t2", routes: "Iface\\tDestination", ipv6: "" }));
  } else {
    if (!${guardWorks}) process.exit(70);
    const python = args.includes("-I");
    const run = Bun.spawnSync({ cmd: python ? ["python3", "-I", "-c", program] : [process.execPath, "--config=/dev/null", "-e", program], stdout: "inherit", stderr: "inherit" });
    process.exit(run.exitCode ?? 1);
  }
}
process.exit(0);
`);
  chmodSync(path, 0o755);
  return path;
}

const closure = { pythonVersion: "3.12.0", lockDigest: `sha256:${"a".repeat(64)}`, distributions: [], models: [], resourceClass: "cpu" };
const runners = {
  bun: (root: string, podman: string) => new PodmanRunner({ root, podman }),
  python: (root: string, podman: string) => new PythonPodmanRunner({ root, podman, closure }),
};

test.each(["bun", "python"] as const)("%s: a guard that installs and blocks a spawn is reported as enforcement", async language => {
  const runner = runners[language](join(dir, `${language}-works`), fakePodman(`${language}-works`, true));
  try {
    await runner.initialize();
    expect(await runner.capabilities()).toEqual({ processSpawnEnforcement: true });
  } finally { await runner.close(); }
});

test.each(["bun", "python"] as const)("%s: a guard that fails leaves the runner up and reports no enforcement", async language => {
  const runner = runners[language](join(dir, `${language}-fails`), fakePodman(`${language}-fails`, false));
  try {
    await runner.initialize();
    expect(await runner.capabilities()).toEqual({ processSpawnEnforcement: false });
  } finally { await runner.close(); }
});
