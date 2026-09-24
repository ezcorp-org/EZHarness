import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TransactionalDb } from "../db/migrations/types";
import type { FactoryRestore, FactoryRestoreReport } from "./restore";
import { FACTORY_RESTORE_USAGE, runFactoryRestoreCommand } from "./restore-command";
import { factoryAttestedRestoreFence } from "./restore-composition";
import { FACTORY_STARTUP_CONFIG_SCHEMA } from "./startup-config";

let directory: string;
let configPath: string;
const tls = { caPath: "/run/tls/ca.pem", certificatePath: "/run/tls/cert.pem", privateKeyPath: "/run/tls/key.pem" };
const storage = (kind: string) => ({ endpoint: `https://127.0.0.1:8443/${kind}`, bucket: "tenant-r", prefix: kind, credentialSet: `${kind}-set`, credentialsPath: `/run/secrets/${kind}.json` });

beforeAll(async () => {
  directory = await mkdtemp(join(process.env.HOME!, ".w15-restore-command-"));
  configPath = join(directory, "startup.json");
  await writeFile(configPath, JSON.stringify({
    schemaVersion: FACTORY_STARTUP_CONFIG_SCHEMA, installationId: "installation-r", tenantId: "tenant-r", poolId: "pool-r", temporalNamespace: "tenant-r.factory",
    orchestrationReadinessFilePath: "/run/o.json", poolReadinessFilePath: "/run/p.json", supervisorReadinessFilePath: "/run/s.json", hostId: "host-r", orphanSweepIntervalMs: 30_000,
    gateway: { hostname: "127.0.0.1", port: 8443, tls }, privateService: { hostname: "127.0.0.1", port: 8444, certificateIdentity: "factory-private", tls },
    pool: { baseUrl: "https://127.0.0.1:8445", serviceTokenPath: "/run/secrets/pool-token", tls },
    storage: { ordinary: storage("ordinary"), archive: storage("archive") },
    keys: { masterKeyFilePath: "/run/secrets/master.key", masterKeyId: "master-1", wrappedKeyFilePath: "/run/secrets/wraps.json", grantableRoots: ["/srv/project"] },
  }), { mode: 0o600 });
});
afterAll(async () => { await rm(directory, { recursive: true, force: true }); });

function report(blockedChecks: string[]): FactoryRestoreReport {
  return { schemaVersion: "factory.recovery-report.v1", tenantId: "tenant-r", installationId: "installation-r", restoreId: "restore-1", mode: "tenant", checkpointId: "c", manifestDigest: "d", previousEpoch: 1, executionEpoch: 2, findings: [], blockedChecks, blockedRuns: ["run"], blockedSubjects: [], releaseIdentities: { archived: 1, recovered: 1, blocked: 0 }, measured: { checkpointStartedAtMs: 0, failureAtMs: null, internalProgressLossMs: null, recoveryMs: 1 }, reportedAtMs: 1 };
}

function harness(rows: unknown[] = [], blockedChecks: string[] = []) {
  const lines: string[] = [], calls: string[] = [];
  let closed = 0;
  const restore = {
    begin: async (input: { restoreId: string; mode: string }) => { calls.push(`begin:${input.restoreId}:${input.mode}`); return report(blockedChecks); },
    resume: async (restoreId: string) => { calls.push(`resume:${restoreId}`); return { restoreId } as never; },
    verify: async () => { calls.push("verify"); return report(blockedChecks); },
  } as unknown as FactoryRestore;
  const io = {
    env: { EZCORP_FACTORY_STARTUP_CONFIG: configPath },
    out: (line: string) => { lines.push(line); },
    database: async () => ({ db: { execute: async () => rows } as unknown as TransactionalDb, close: async () => { closed += 1; } }),
    compose: async (input: { host: { report: (part: string, error: unknown) => void } }) => { input.host.report("restore-pool", new Error("no pool")); return restore; },
  };
  return { io: io as never, lines, calls, closed: () => closed };
}

describe("the operator's restore command", () => {
  test("refuses a malformed command line with the usage", async () => {
    for (const argv of [[], ["sign", "--restore-id", "r"], ["begin"], ["begin", "--restore-id", "r"], ["begin", "--restore-id", "r", "--fence"], ["status", "--restore-id", "r", "--restore-id", "s"], ["status", "--restore-id", "r", "--bogus", "x"], ["begin", "--restore-id", "r", "--fence", "f", "--mode", "sideways"]]) {
      const { io, lines } = harness();
      expect(await runFactoryRestoreCommand(argv, io)).toBe(64);
      expect(lines).toEqual([FACTORY_RESTORE_USAGE]);
    }
  });

  test("begin opens the epoch, prints the digest and what remains, and exits 2 while a check blocks", async () => {
    const { io, lines, calls, closed } = harness([], ["pool:ledger:pool_unavailable"]);
    expect(await runFactoryRestoreCommand(["begin", "--restore-id", "restore-1", "--fence", join(directory, "fence.json"), "--mode", "cluster"], io)).toBe(2);
    expect(calls).toEqual(["begin:restore-1:cluster"]);
    expect(JSON.parse(lines[0]!)).toMatchObject({ restoreId: "restore-1", mode: "tenant", executionEpoch: 2, blockedChecks: ["pool:ledger:pool_unavailable"], blockedRuns: 1, uncomposed: ["restore-pool"], next: "resolve every blocked check, then run verify" });
    expect(JSON.parse(lines[0]!).reportDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(closed()).toBe(1);
  });

  test("verify re-runs every check for the open epoch and exits 0 once nothing blocks", async () => {
    const { io, lines, calls } = harness();
    expect(await runFactoryRestoreCommand(["verify", "--restore-id", "restore-1", "--fence", join(directory, "fence.json"), "--config", configPath], io)).toBe(0);
    expect(calls).toEqual(["resume:restore-1", "verify"]);
    expect(JSON.parse(lines[0]!).next).toBe("a human administrator signs this report digest in the console");
  });

  test("status reads the epoch, or names it missing", async () => {
    const found = harness([{ state: "awaiting_signature", report_digest: "sha256:abc", execution_epoch: "2" }]);
    expect(await runFactoryRestoreCommand(["status", "--restore-id", "restore-1"], found.io)).toBe(0);
    expect(JSON.parse(found.lines[0]!)).toEqual({ restoreId: "restore-1", state: "awaiting_signature", executionEpoch: 2, reportDigest: "sha256:abc" });
    const missing = harness([]);
    expect(await runFactoryRestoreCommand(["status", "--restore-id", "restore-9"], missing.io)).toBe(1);
    expect(JSON.parse(missing.lines[0]!)).toEqual({ restoreId: "restore-9", state: "not_found" });
    expect(missing.closed()).toBe(1);
  });
});

describe("the attested fence", () => {
  test("returns each statement only for its own restore, and refuses a missing one", async () => {
    const path = join(directory, "fence.json");
    await writeFile(path, JSON.stringify({ restoreId: "restore-1", ingress: "old ingress route withdrawn", credentials: "old service credential generation revoked" }), { mode: 0o600 });
    const fence = factoryAttestedRestoreFence(path);
    expect(await fence.closeIngress("restore-1")).toBe("old ingress route withdrawn");
    expect(await fence.revokeCredentials("restore-1")).toBe("old service credential generation revoked");
    await expect(fence.closeIngress("restore-2")).rejects.toThrow("the fence attestation is for another restore");
    await writeFile(path, JSON.stringify({ restoreId: "restore-1", ingress: "" }), { mode: 0o600 });
    await expect(fence.closeIngress("restore-1")).rejects.toThrow("the fence attestation names no ingress fence");
    await expect(fence.revokeCredentials("restore-1")).rejects.toThrow("the fence attestation names no credentials fence");
  });
});
