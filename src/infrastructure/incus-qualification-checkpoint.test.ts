import { afterEach, expect, test } from "bun:test";
import { generateKeyPairSync, randomUUID, sign, type KeyObject } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { up } from "../db/migrations/add-incus-qualification-runs";
import { IncusQualificationCheckpointStore, currentProcessIdentity, observationDigest,
  processIdentityKey, restartHandoffSigningBytes, type ProcessIdentity,
  type RestartHandoffPayload } from "./incus-qualification-checkpoint";
import { checkpointTestHandle as handle, checkpointTestObservation as observation,
  checkpointTestScope as scope } from "./__tests__/incus-qualification-checkpoint-test-observation";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(dir => rm(dir, { recursive: true, force: true }))); });

async function database() {
  const directory = await mkdtemp(join(tmpdir(), "incus-checkpoint-"));
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
  const db = drizzle(client);
  await up(db);
  return { directory, client, db };
}

function childIdentity(lines: ReturnType<typeof createInterface>): Promise<ProcessIdentity> {
  return new Promise((resolve, reject) => {
    const onClose = () => reject(new Error("Child exited before identity"));
    lines.once("line", line => {
      lines.off("close", onClose);
      try { resolve(JSON.parse(line) as ProcessIdentity); } catch (error) { reject(error); }
    });
    lines.once("close", onClose);
  });
}

async function beginInExitedProcess(directory: string, runId: string, nonce: string,
  deadlineMs: number): Promise<ProcessIdentity> {
  const writer = spawn(process.execPath, [join(import.meta.dir, "__tests__/incus-qualification-checkpoint.worker.ts"),
    "begin", directory, runId, nonce, String(deadlineMs)], { stdio: ["ignore", "pipe", "pipe"] });
  const writerExit = new Promise<number | null>(resolve => writer.once("exit", resolve));
  const timer = setTimeout(() => writer.kill("SIGKILL"), 75_000);
  try {
    const oldProcess = await childIdentity(createInterface({ input: writer.stdout }));
    expect(await writerExit).toBe(0);
    return oldProcess;
  } finally {
    clearTimeout(timer);
    if (writer.exitCode === null) writer.kill("SIGKILL");
  }
}

function handoff(privateKey: KeyObject, runId: string, nonce: string, deadlineMs: number,
  oldProcess: ProcessIdentity, newProcess: ProcessIdentity) {
  const payload: RestartHandoffPayload = { version: 1, runId, nonce, deadlineMs, scope,
    fixtureOperationId: handle.operationId, bindingId: handle.sandboxId,
    generation: 3, connectionRevision: 2, lastOperationId: "stop-operation",
    oldProcess, newProcess,
    beforeDigest: observationDigest(observation(processIdentityKey(oldProcess))),
    afterDigest: observationDigest(observation(processIdentityKey(newProcess))) };
  return { payload, signature: sign(null, restartHandoffSigningBytes(payload), privateKey).toString("base64") };
}

test("a new process opens the same database and claims a signed restart checkpoint once", async () => {
  const { directory, client } = await database();
  const runId = `run-${randomUUID()}`;
  const nonce = `nonce-${randomUUID()}`;
  const deadlineMs = Date.now() + 110_000;
  await client.close();
  const oldProcess = await beginInExitedProcess(directory, runId, nonce, deadlineMs);

  const keys = generateKeyPairSync("ed25519");
  const publicKeyPem = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const child = spawn(process.execPath, [join(import.meta.dir, "__tests__/incus-qualification-checkpoint.worker.ts"),
    "claim", directory, runId, nonce], { stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env, EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY: publicKeyPem } });
  const childExit = new Promise<number | null>(resolve => child.once("exit", resolve));
  const timer = setTimeout(() => child.kill("SIGKILL"), 75_000);
  try {
    const lines = createInterface({ input: child.stdout });
    const newProcess = await childIdentity(lines);
    expect(newProcess.pid).not.toBe(oldProcess.pid);
    const receipt = handoff(keys.privateKey, runId, nonce, deadlineMs, oldProcess, newProcess);
    const completion = new Promise<string>((resolve, reject) => {
      lines.once("line", resolve);
      child.once("error", reject);
      child.once("exit", code => { if (code !== 0) reject(new Error(`Child exit ${code}`)); });
    });
    child.stdin.write(`${JSON.stringify({ receipt })}\n`);
    child.stdin.end();
    expect(await completion).toBe("claimed-once");
    expect(await childExit).toBe(0);
  } finally {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill("SIGKILL");
  }

  const reopened = new PGlite(directory);
  await reopened.waitReady;
  expect((await new IncusQualificationCheckpointStore(drizzle(reopened)).get(runId))?.state).toBe("CLAIMED");
  await reopened.close();
}, 90_000);

test("the new process claims an exited writer and authorizes only its exact live fixture", async () => {
  const { directory, client } = await database();
  const runId = `run-${randomUUID()}`;
  const nonce = `nonce-${randomUUID()}`;
  const deadlineMs = Date.now() + 110_000;
  await client.close();
  const oldProcess = await beginInExitedProcess(directory, runId, nonce, deadlineMs);
  const keys = generateKeyPairSync("ed25519");
  const reopened = new PGlite(directory);
  await reopened.waitReady;
  const store = new IncusQualificationCheckpointStore(drizzle(reopened),
    keys.publicKey.export({ type: "spki", format: "pem" }).toString());
  const newProcess = currentProcessIdentity();
  const after = observation(processIdentityKey(newProcess));
  await store.claim({ runId, nonce, after,
    receipt: handoff(keys.privateKey, runId, nonce, deadlineMs, oldProcess, newProcess) });
  const authority = { runId, nonce, scope, fixtureOperationId: handle.operationId,
    bindingId: handle.sandboxId, generation: 3, connectionRevision: 2,
    deadlineMs: Date.now() + 20_000 };
  await store.authorizeOwnedRun(authority);
  await expect(store.authorizeOwnedRun({ ...authority, bindingId: "user-binding" }))
    .rejects.toThrow("run authority is unavailable");
  const expired = new IncusQualificationCheckpointStore(drizzle(reopened), undefined,
    () => deadlineMs + 1);
  await expect(expired.authorizeOwnedRun({ ...authority, deadlineMs: deadlineMs + 20_000 }))
    .rejects.toThrow("run authority is unavailable");
  const nearExpiry = new IncusQualificationCheckpointStore(drizzle(reopened), undefined,
    () => deadlineMs - 10_000);
  await expect(nearExpiry.authorizeOwnedRun({ ...authority, deadlineMs: deadlineMs + 5_000 }))
    .rejects.toThrow("run authority is unavailable");
  await reopened.exec("UPDATE projects SET purpose = 'user' WHERE id = 'project'");
  await expect(store.authorizeOwnedRun(authority)).rejects.toThrow("operator fixture changed");
  await reopened.close();
}, 90_000);

test("a forged process handoff fails closed and preserves the failure", async () => {
  const { client, db } = await database();
  const keys = generateKeyPairSync("ed25519");
  const store = new IncusQualificationCheckpointStore(db,
    keys.publicKey.export({ type: "spki", format: "pem" }).toString());
  const oldProcess = currentProcessIdentity();
  const before = observation(processIdentityKey(oldProcess));
  const runId = `run-${randomUUID()}`;
  const nonce = `nonce-${randomUUID()}`;
  const deadlineMs = Date.now() + 60_000;
  await store.begin({ runId, nonce, deadlineMs, scope, handle, before });
  const payload: RestartHandoffPayload = { version: 1, runId, nonce, deadlineMs, scope,
    fixtureOperationId: handle.operationId, bindingId: handle.sandboxId,
    generation: 3, connectionRevision: 2, lastOperationId: "stop-operation",
    oldProcess, newProcess: oldProcess, beforeDigest: observationDigest(before),
    afterDigest: observationDigest(before) };
  const receipt = { payload, signature: sign(null, restartHandoffSigningBytes(payload), keys.privateKey).toString("base64") };
  await expect(store.claim({ runId, nonce, receipt, after: before }))
    .rejects.toThrow("identity or observation changed");
  expect((await store.get(runId))?.state).toBe("FAILED");
  await client.close();
});

test("a user project binding cannot create a qualification restart checkpoint", async () => {
  const { client, db } = await database();
  await client.exec("UPDATE projects SET purpose = 'user' WHERE id = 'project'");
  const store = new IncusQualificationCheckpointStore(db);
  await expect(store.begin({ runId: `run-${randomUUID()}`, nonce: `nonce-${randomUUID()}`,
    deadlineMs: Date.now() + 60_000, scope, handle,
    before: observation(processIdentityKey(currentProcessIdentity())) }))
    .rejects.toThrow("exact stopped qualification binding");
  expect((await client.query("SELECT run_id FROM incus_qualification_runs")).rows).toEqual([]);
  await client.close();
});

test("a changed binding or unpinned guest cannot create a restart checkpoint", async () => {
  const { client, db } = await database();
  try {
    const store = new IncusQualificationCheckpointStore(db);
    const before = observation(processIdentityKey(currentProcessIdentity()));
    const begin = (candidate: typeof before) => store.begin({ runId: `run-${randomUUID()}`,
      nonce: `nonce-${randomUUID()}`, deadlineMs: Date.now() + 60_000,
      scope, handle, before: candidate });

    await client.exec("UPDATE sandbox_bindings SET provider_release_id = 'other' WHERE id = 'binding'");
    await expect(begin(before)).rejects.toThrow("exact stopped qualification binding");
    await client.exec("UPDATE sandbox_bindings SET provider_release_id = 'release' WHERE id = 'binding'");

    await expect(begin({ ...before, durable: { ...before.durable,
      operation: { ...before.durable.operation!, id: "other-operation" } } }))
      .rejects.toThrow("exact stopped qualification binding");
    await expect(begin({ ...before, backend: { ...before.backend, imageDigest: "0".repeat(64) } }))
      .rejects.toThrow("exact stopped qualification binding");
    expect((await client.query("SELECT run_id FROM incus_qualification_runs")).rows).toEqual([]);
  } finally { await client.close(); }
});
