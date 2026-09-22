/**
 * The host supervisor's runner probe, against the REAL container runner.
 *
 * Every other test for this file injects a fake probe, which is why the defect
 * this file exists for survived two reviews: `PodmanRunner.prepareStore` ends in
 * `acquireLease()`, an exclusive `flock --nonblock` child held for the
 * instance's life, so a SECOND instance on the same root fails
 * `runner_store_busy` deterministically and every successful construction
 * leaks one `flock` child. A supervisor that built a runner per heartbeat
 * therefore degraded on its second beat and leaked a process per beat before
 * that. No fake can show either fact.
 *
 * These assertions need a working rootless Podman with seccomp and cgroup v2,
 * the same environment `probeSecurity` requires. Run under the heavy lock: the
 * probe creates a container.
 */
import { afterAll, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { factoryHostRunnerProbe, parseFactorySupervisorProcessConfig, type FactorySupervisorProcessConfig } from "./supervisor-process";

const roots: string[] = [];
afterAll(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

async function runnerRoot(): Promise<string> {
  const directory = await mkdtemp(join(process.env.HOME!, ".w09-podman-"));
  roots.push(directory);
  await chmod(directory, 0o700);
  return join(directory, "runner");
}

function config(root: string): FactorySupervisorProcessConfig {
  return parseFactorySupervisorProcessConfig({
    schemaVersion: "factory.supervisor-process.v1",
    installationId: "installation-podman",
    hostId: "host-podman",
    hostKeyPath: join(root, "..", "host.key"),
    hostKeyId: "host-key-1",
    runnerRoot: root,
    readinessFilePath: join(root, "..", "supervisor.json"),
    readinessHeartbeatMs: 2_000,
  });
}

/** `flock` children this process owns, which is what a leaked lease looks like. */
function leaseChildren(): string[] {
  try {
    return execFileSync("pgrep", ["-P", String(process.pid), "-x", "flock"], { encoding: "utf8" })
      .split("\n").map((value) => value.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

test("the real runner probe is safe to repeat on the same root, and leaves no lease behind", async () => {
  const root = await runnerRoot();
  const scope = config(root);
  const probe = factoryHostRunnerProbe();
  const before = leaseChildren().length;

  // Two consecutive probes on one root. The first does the real work — store
  // preparation, the exclusive lease, and the fail-closed kernel probe. The
  // second must be a no-op rather than a second lease attempt.
  await probe.probe(scope);
  const afterFirst = leaseChildren().length;
  await probe.probe(scope);
  await probe.probe(scope);
  const afterThird = leaseChildren().length;

  // One lease, held across all three, not one per call and not a failure on the
  // second. Before the fix the second call threw `runner_store_busy`.
  expect(afterFirst).toBe(before + 1);
  expect(afterThird).toBe(afterFirst);

  await probe.close();
  expect(leaseChildren().length).toBe(before);
}, 240_000);

test("a fresh probe can take the store again once the first has closed", async () => {
  const root = await runnerRoot();
  const scope = config(root);

  const first = factoryHostRunnerProbe();
  await first.probe(scope);
  await first.close();

  // The lease is released on close, so the next supervisor start on this host
  // is not blocked by the previous one. A restart must not need a new root.
  const second = factoryHostRunnerProbe();
  await second.probe(scope);
  await second.close();
  expect(leaseChildren()).toEqual([]);
}, 240_000);

test("a second holder refuses while the first still holds the store", async () => {
  const root = await runnerRoot();
  const scope = config(root);

  const holder = factoryHostRunnerProbe();
  await holder.probe(scope);
  try {
    // Two supervisors configured against one root is a misconfiguration, and it
    // must fail loudly rather than have the second silently share the store.
    const rival = factoryHostRunnerProbe();
    await expect(rival.probe(scope)).rejects.toMatchObject({ code: "runner_store_busy" });
  } finally {
    await holder.close();
  }
}, 240_000);
