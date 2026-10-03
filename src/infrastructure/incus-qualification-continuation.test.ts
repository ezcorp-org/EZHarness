import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, sign } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { up } from "../db/migrations/add-incus-qualification-runs";
import { IncusQualificationCheckpointStore, restartHandoffSigningBytes } from "./incus-qualification-checkpoint";
import { IncusQualificationContinuation } from "./incus-qualification-continuation";
import { checkpointTestHandle as handle, checkpointTestObservation as observation,
  checkpointTestScope as scope } from "./__tests__/incus-qualification-checkpoint-test-observation";
import type { IncusQualificationFixtureService } from "./incus-qualification";
import type { HostIncusLiveReadback, LiveReadbackContext } from "./incus-transport/live-readback";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

test("a stopped fixture continuation survives process exit, verifies a signed handoff, and claims once", async () => {
  expect(IncusQualificationContinuation).toBeDefined();
  const directory = await mkdtemp(join(tmpdir(), "incus-continuation-"));
  directories.push(directory);
  const client = new PGlite(directory);
  await client.waitReady;
  await client.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, purpose TEXT NOT NULL);
    CREATE TABLE sandbox_bindings (id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      generation INTEGER NOT NULL, desired_state TEXT NOT NULL, observed_state TEXT NOT NULL,
      current_operation_id TEXT, provider_installation_id TEXT NOT NULL, provider_release_id TEXT NOT NULL,
      connection_id TEXT NOT NULL, connection_revision INTEGER NOT NULL, preset_id TEXT NOT NULL);
    CREATE TABLE provider_sandbox_operations (id TEXT PRIMARY KEY, binding_id TEXT NOT NULL,
      state TEXT NOT NULL, generation INTEGER NOT NULL);
    CREATE TABLE incus_qualification_fixtures (operation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      binding_id TEXT NOT NULL, installation_id TEXT NOT NULL, release_id TEXT NOT NULL,
      connection_id TEXT NOT NULL, connection_revision INTEGER NOT NULL, preset_id TEXT NOT NULL);
    INSERT INTO projects VALUES ('project', 'incus-qualification');
    INSERT INTO sandbox_bindings VALUES ('binding', 'project', 3, 'STOPPED', 'STOPPED',
      'stop-operation', 'installation', 'release', 'connection', 2, 'preset');
    INSERT INTO provider_sandbox_operations VALUES ('stop-operation', 'binding', 'SUCCEEDED', 3);
    INSERT INTO incus_qualification_fixtures VALUES
      ('fixture', 'project', 'binding', 'installation', 'release', 'connection', 2, 'preset');
  `);
  await up(drizzle(client));
  await client.close();
  const runId = "continuation-run";
  const nonce = "continuation-nonce";
  const deadlineMs = Date.now() + 110_000;
  const worker = join(import.meta.dir, "__tests__/incus-qualification-continuation.worker.ts");
  const begin = spawn(process.execPath, [worker, "begin", directory, runId, nonce, String(deadlineMs)],
    { stdio: ["ignore", "pipe", "pipe"] });
  const beginExit = new Promise<number | null>(resolve => begin.once("exit", resolve));
  let beginError = "";
  begin.stderr.on("data", chunk => { beginError += String(chunk); });
  const beforeLine = await new Promise<string>((resolve, reject) => {
    createInterface({ input: begin.stdout }).once("line", resolve);
    begin.once("error", reject);
    begin.once("exit", code => { if (code !== 0) reject(new Error(beginError)); });
  });
  expect(await beginExit).toBe(0);
  const before = JSON.parse(beforeLine);
  const pendingClient = new PGlite(directory);
  await pendingClient.waitReady;
  const pending = await new IncusQualificationCheckpointStore(drizzle(pendingClient)).pending();
  expect(pending?.runId).toBe(runId);
  expect(pending?.nonce).toBe(nonce);
  await pendingClient.close();
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const resume = spawn(process.execPath, [worker, "resume", directory, runId, nonce],
    { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY: publicKey } });
  const resumeExit = new Promise<number | null>(resolve => resume.once("exit", resolve));
  let resumeError = "";
  resume.stderr.on("data", chunk => { resumeError += String(chunk); });
  const lines = createInterface({ input: resume.stdout });
  const request = JSON.parse(await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    resume.once("exit", code => { if (code !== 0) reject(new Error(resumeError)); });
  }));
  const payload = { version: 1, ...before, ...request };
  const receipt = { payload, signature: sign(null, restartHandoffSigningBytes(payload), keys.privateKey).toString("base64") };
  resume.stdin.end(`${JSON.stringify(receipt)}\n`);
  expect(await new Promise<string>((resolve, reject) => {
    lines.once("line", resolve);
    resume.once("exit", code => { if (code !== 0) reject(new Error(resumeError)); });
  })).toBe("claimed-once");
  expect(await resumeExit).toBe(0);
  const reopened = new PGlite(directory);
  await reopened.waitReady;
  expect((await new IncusQualificationCheckpointStore(drizzle(reopened)).get(runId))?.state).toBe("CLAIMED");
  await reopened.close();
}, 90_000);

test("continuation reads the exact stopped fixture and refuses changed or unverified observations", async () => {
  const context = { scope, connection: { revision: 2, configuration: { guestUser: "sandbox" } },
    preset: { id: scope.presetId, imageDigest: "a".repeat(64), profile: "profile",
      helperDigests: ["b".repeat(64)] },
    recipe: { guestImage: { fingerprint: "a".repeat(64), helperSha256: "b".repeat(64) } } } as unknown as LiveReadbackContext;
  const durable = observation("unused").durable;
  let backendState = "stopped";
  let reads = 0;
  const fixtures = { status: async (receivedScope: typeof scope, operationId: string) => {
    expect(receivedScope).toEqual(scope);
    expect(operationId).toBe(handle.operationId);
    return durable;
  } } as unknown as IncusQualificationFixtureService;
  const readback = { instance: async (_context: LiveReadbackContext, sandboxId: string) => {
    expect(sandboxId).toBe(handle.sandboxId);
    reads++;
    return { state: backendState, imageDigest: "a".repeat(64), profile: "profile",
      memoryBytes: 1024, cpuMillis: 1000, pids: 4, diskBytes: 1024, storageDriver: "zfs",
      privateNetwork: true, restrictedProject: true, unprivileged: true };
  } } as unknown as HostIncusLiveReadback;
  let begun = false;
  let claimed = false;
  const row = { runId: "run", nonce: "nonce", state: "AWAITING_RESTART", scope,
    fixtureOperationId: handle.operationId, bindingId: handle.sandboxId, generation: 3,
    connectionRevision: 2, lastOperationId: "stop-operation", deadlineAt: new Date(Date.now() + 60_000),
    oldProcessIdentity: { pid: 1, startTicks: "1" }, beforeDigest: "a".repeat(64),
    beforeObservation: observation("1:1") };
  const checkpoints = { begin: async () => { begun = true; }, get: async () => row,
    claim: async () => { claimed = true; } } as unknown as IncusQualificationCheckpointStore;
  const continuation = new IncusQualificationContinuation({ checkpoints, fixtures, readback, context });
  backendState = "running";
  await expect(continuation.prepare({ runId: "run", nonce: "nonce", deadlineMs: Date.now() + 60_000,
    scope, handle })).rejects.toThrow("exact stopped fixture");
  expect(begun).toBe(false);
  backendState = "stopped";
  expect((await continuation.prepare({ runId: "run", nonce: "nonce", deadlineMs: Date.now() + 60_000,
    scope, handle })).bindingId).toBe(handle.sandboxId);
  expect(begun).toBe(true);
  await expect(continuation.resume("run", "nonce", async () => {
    throw new Error("operator verifier rejected stale observation");
  })).rejects.toThrow("operator verifier rejected stale observation");
  expect(claimed).toBe(false);
  await expect(continuation.resume("run", "nonce", async payload => {
    expect(payload.afterDigest).toMatch(/^[a-f0-9]{64}$/);
    backendState = "running";
    return {} as never;
  })).rejects.toThrow("exact stopped fixture");
  expect(claimed).toBe(false);
  expect(reads).toBeGreaterThanOrEqual(4);
});
