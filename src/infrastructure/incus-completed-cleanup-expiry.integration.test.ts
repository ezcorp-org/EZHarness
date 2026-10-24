import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { generateKeyPairSync, sign } from "node:crypto";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import type { Database, DbTransaction } from "../db/connection";
import * as schema from "../db/schema";
import { up as sandboxMigration } from "../db/migrations/add-sandbox-controller";
import { up as fixtureMigration } from "../db/migrations/add-incus-qualification-fixtures";
import { up as checkpointMigration } from "../db/migrations/add-incus-qualification-runs";
import { currentProcessIdentity, restartHandoffSigningBytes, type RestartHandoffPayload } from "./incus-qualification-checkpoint";
import { completedCleanupComponents } from "./__tests__/incus-completed-cleanup-expiry.fixture";

const clients: PGlite[] = [];
const evidenceDirectory = process.env.EZCORP_COMPLETED_CLEANUP_EVIDENCE_DIR;
async function saveEvidence(name: string, value: string) {
  if (evidenceDirectory) await writeFile(join(evidenceDirectory, name), value, { mode: 0o600, flag: "wx" });
}
const directories: string[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) await client.close();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
const scope = { installationId: "installation", releaseId: "release", connectionId: "connection", presetId: "preset" };
const runId = "expired-run";
const handle = { operationId: `qual-recovery-${runId}`, sandboxId: "recovery-binding" };
const operationId = "recovery-destroy";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "incus-completed-expiry-"));
  directories.push(root);
  const directory = join(root, "database");
  const client = new PGlite(directory);
  clients.push(client);
  await client.exec("CREATE TABLE projects (id TEXT PRIMARY KEY)");
  const db = drizzle(client, { schema });
  await sandboxMigration(db);
  await fixtureMigration(db);
  await checkpointMigration(db);
  await client.exec(`INSERT INTO projects (id,purpose) VALUES ('primary','incus-qualification'),('recovery','incus-qualification');
    INSERT INTO sandbox_bindings (id,project_id,provider_installation_id,provider_release_id,connection_id,
      connection_revision,preset_id,preset_digest,effective_settings_digest,resource_key,desired_state,observed_state,
      current_operation_id,cleanup_confirmed_at) VALUES
      ('primary-binding','primary','installation','release','connection',2,'preset','preset-digest','settings','primary-binding','ABSENT','ABSENT','primary-destroy',NOW()),
      ('recovery-binding','recovery','installation','release','connection',2,'preset','preset-digest','settings','recovery-binding','ABSENT','ABSENT','recovery-destroy',NOW());
    INSERT INTO incus_qualification_fixtures (operation_id,project_id,binding_id,installation_id,release_id,connection_id,
      connection_revision,preset_id,preset_digest,effective_settings_digest) VALUES
      ('qual-primary-expired-run','primary','primary-binding','installation','release','connection',2,'preset','preset-digest','settings'),
      ('qual-recovery-expired-run','recovery','recovery-binding','installation','release','connection',2,'preset','preset-digest','settings');
    INSERT INTO provider_sandbox_operations (id,binding_id,kind,generation,idempotency_scope,idempotency_key,payload_hash,request_payload,state) VALUES
      ('primary-destroy','primary-binding','DESTROY',1,'incus-qualification','qual-primary-expired-run:destroy','hash','{}','SUCCEEDED'),
      ('recovery-destroy','recovery-binding','DESTROY',1,'incus-qualification','qual-recovery-expired-run:destroy','hash','{}','SUCCEEDED');
    INSERT INTO sandbox_host_capacities (provider_installation_id,connection_id,allocatable_memory_bytes,allocatable_cpu_millicores,
      allocatable_pids,allocatable_disk_bytes,allocatable_execution_slots,safety_memory_bytes,safety_cpu_millicores,safety_pids,safety_disk_bytes,safety_execution_slots)
      VALUES ('installation','connection',10,10,10,10,10,0,0,0,0,0);
    INSERT INTO sandbox_reservations (binding_id,project_id,provider_installation_id,connection_id,generation,memory_bytes,cpu_millicores,
      pids,disk_bytes,execution_slots,compute_state,disk_state,cleanup_intent_id) VALUES
      ('recovery-binding','recovery','installation','connection',1,1,1,1,1,1,'RELEASED','RELEASED','incus-qualification-destroy-qual-recovery-expired-run');`);
  await client.exec(`
    INSERT INTO projects (id,purpose) VALUES ('unrelated','incus-qualification');
    INSERT INTO sandbox_bindings (id,project_id,provider_installation_id,provider_release_id,connection_id,
      connection_revision,preset_id,preset_digest,effective_settings_digest,resource_key,desired_state,observed_state,
      current_operation_id,cleanup_confirmed_at,tombstoned_at)
      SELECT 'unrelated-binding','unrelated',provider_installation_id,provider_release_id,connection_id,
      connection_revision,preset_id,preset_digest,effective_settings_digest,'unrelated-binding',desired_state,observed_state,
      'unrelated-destroy',cleanup_confirmed_at,NOW() FROM sandbox_bindings WHERE id='primary-binding';
    INSERT INTO incus_qualification_fixtures SELECT 'qual-unrelated-expired-run',NULL,'unrelated','unrelated-binding',
      installation_id,release_id,connection_id,connection_revision,preset_id,preset_digest,effective_settings_digest,NOW()
      FROM incus_qualification_fixtures WHERE operation_id='qual-primary-expired-run';
    INSERT INTO provider_sandbox_operations (id,binding_id,kind,generation,idempotency_scope,idempotency_key,payload_hash,request_payload,state)
      VALUES ('unrelated-destroy','unrelated-binding','DESTROY',1,'incus-qualification','qual-unrelated-expired-run:destroy','hash','{}','SUCCEEDED');
    INSERT INTO sandbox_reservations (binding_id,project_id,provider_installation_id,connection_id,generation,memory_bytes,cpu_millicores,
      pids,disk_bytes,execution_slots,compute_state,disk_state,cleanup_intent_id,cleanup_requested_at)
      SELECT 'primary-binding','primary',provider_installation_id,connection_id,generation,memory_bytes,cpu_millicores,
      pids,disk_bytes,execution_slots,compute_state,disk_state,'incus-qualification-destroy-qual-primary-expired-run',NOW()
      FROM sandbox_reservations WHERE binding_id='recovery-binding';
    INSERT INTO sandbox_reservations (binding_id,project_id,provider_installation_id,connection_id,generation,memory_bytes,cpu_millicores,
      pids,disk_bytes,execution_slots,compute_state,disk_state,cleanup_intent_id,cleanup_requested_at)
      SELECT 'unrelated-binding','unrelated',provider_installation_id,connection_id,generation,memory_bytes,cpu_millicores,
      pids,disk_bytes,execution_slots,compute_state,disk_state,'incus-qualification-destroy-qual-unrelated-expired-run',NOW()
      FROM sandbox_reservations WHERE binding_id='recovery-binding';
    UPDATE sandbox_bindings SET tombstoned_at=NOW();
    UPDATE sandbox_reservations SET cleanup_requested_at=NOW();`);
  const keys = generateKeyPairSync("ed25519");
  const publicKey = keys.publicKey.export({ type: "spki", format: "pem" }).toString();
  const now = Date.now();
  const payload: RestartHandoffPayload = { version: 1, runId, nonce: "nonce", scope,
    fixtureOperationId: `qual-primary-${runId}`, bindingId: "primary-binding", generation: 1, connectionRevision: 2,
    lastOperationId: "primary-stop", deadlineMs: now - 21 * 60_000,
    oldProcess: { pid: 2147483646, startTicks: "1" }, newProcess: { pid: 2147483647, startTicks: "1" },
    beforeDigest: "a".repeat(64), afterDigest: "b".repeat(64) };
  const receipt = { payload, signature: sign(null, restartHandoffSigningBytes(payload), keys.privateKey).toString("base64") };
  await client.query(`INSERT INTO incus_qualification_runs (run_id,fixture_operation_id,scope,binding_id,generation,connection_revision,last_operation_id,
    nonce,deadline_at,before_observation,before_digest,old_process_identity,state,receipt,claimed_at)
    VALUES ($1,$2,$3,'primary-binding',1,2,'primary-stop','nonce',$4,'{}',$5,$6,'CLAIMED',$7,$8)`,
  [runId, payload.fixtureOperationId, JSON.stringify(scope), new Date(payload.deadlineMs), payload.beforeDigest,
    JSON.stringify(payload.oldProcess), JSON.stringify(receipt), new Date(now - 21 * 60_000)]);
  let effects = 0;
  const forDatabase = (database: Database) => completedCleanupComponents(database, publicKey, () => { effects++; }, now);
  return { root, directory, publicKey, receipt, privateKey: keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    client, db: db as Database, ...forDatabase(db), forDatabase, effects: () => effects };

}

test("expired claimed run with exact settled destroy closes FAILED without dispatch", async () => {
  const f = await fixture();
  expect(await f.checkpoints.pending()).toBeNull();
  expect(await f.checkpoints.pendingCleanup()).toMatchObject({ runId, operationState: "SUCCEEDED", originProcessCurrent: false });
  await f.reconcile();
  expect((await f.checkpoints.get(runId))?.state).toBe("FAILED");
  expect(f.effects()).toBe(0);
  expect((await f.client.query("SELECT id FROM provider_sandbox_operations")).rows).toHaveLength(3);
}, 30_000);


test("expired runs cannot dispatch or reconcile uncertain provider effects", async () => {
  const f = await fixture();
  for (const state of ["JOURNALED", "DISPATCHING", "PROVIDER_PENDING", "OUTCOME_UNKNOWN", "FAILED"]) {
    await f.client.query("UPDATE provider_sandbox_operations SET state=$1 WHERE id=$2", [state, operationId]);
    await expect(f.controller.settleAlreadyCompletedDestroy(scope, handle, operationId)).rejects.toThrow();
    await expect(f.controller.verifySettledDestroy(scope, handle, operationId)).rejects.toThrow();
    await expect(f.controller.reconcileFromReopenedController(scope, handle)).rejects.toThrow();
    await expect(f.controller.attemptReadiness(scope, handle)).rejects.toThrow();
    expect((await f.checkpoints.get(runId))?.state).toBe("CLAIMED");
    expect(f.effects()).toBe(0);
  }
  await expect(f.controller.injectLostDestroyReply(scope, handle)).rejects.toMatchObject({ stage: "authority" });
  expect(f.effects()).toBe(0);
}, 30_000);

test("expired completed settlement denies changed identity, resources and extra pending work", async () => {
  const f = await fixture();
  const mutations = [
    "UPDATE sandbox_bindings SET generation=2 WHERE id='recovery-binding'",
    "UPDATE provider_sandbox_operations SET generation=2 WHERE id='recovery-destroy'",
    "UPDATE provider_sandbox_operations SET kind='STOP' WHERE id='recovery-destroy'",
    "UPDATE provider_sandbox_operations SET idempotency_scope='foreign' WHERE id='recovery-destroy'",
    "UPDATE sandbox_reservations SET generation=2 WHERE binding_id='recovery-binding'",
    "UPDATE sandbox_bindings SET connection_revision=3 WHERE id='recovery-binding'",
    "UPDATE sandbox_bindings SET observed_state='UNKNOWN' WHERE id='recovery-binding'",
    "UPDATE sandbox_bindings SET cleanup_confirmed_at=NULL WHERE id='recovery-binding'",
    "UPDATE sandbox_reservations SET cleanup_intent_id='foreign' WHERE binding_id='recovery-binding'",
    "UPDATE sandbox_reservations SET disk_state='RESERVED' WHERE binding_id='recovery-binding'",
    "UPDATE sandbox_reservations SET compute_state='RELEASE_REQUESTED' WHERE binding_id='recovery-binding'",
    "UPDATE incus_qualification_fixtures SET release_id='foreign' WHERE binding_id='recovery-binding'",
    "UPDATE provider_sandbox_operations SET idempotency_key='foreign:destroy' WHERE id='recovery-destroy'",
    "UPDATE incus_qualification_runs SET receipt=jsonb_set(receipt,'{signature}',to_jsonb('bad-signature'::text))",
    "INSERT INTO provider_sandbox_operations (id,binding_id,kind,generation,idempotency_scope,idempotency_key,payload_hash,request_payload,state) VALUES ('other-pending','primary-binding','STOP',1,'other','other','hash','{}','JOURNALED')",
  ];
  for (const mutation of mutations) {
    await expect(f.db.transaction(async (tx: DbTransaction) => {
      await tx.execute((await import("drizzle-orm")).sql.raw(mutation));
      await expect(f.forDatabase(tx as Database).controller.settleAlreadyCompletedDestroy(scope, handle, operationId)).rejects.toThrow();
      throw new Error("restore fixture");
    })).rejects.toThrow("restore fixture");
    expect((await f.checkpoints.get(runId))?.state).toBe("CLAIMED");
    expect(f.effects()).toBe(0);
  }
}, 30_000);

test("failed enclosing transaction preserves CLAIMED checkpoint and exact completed journals", async () => {
  const f = await fixture();
  await expect(f.db.transaction(async (tx: DbTransaction) => {
    const reopened = f.forDatabase(tx as Database);
    await reopened.reconcile();
    expect((await reopened.checkpoints.get(runId))?.state).toBe("FAILED");
    throw new Error("simulated terminal persistence failure");
  })).rejects.toThrow("simulated terminal persistence failure");
  expect((await f.checkpoints.get(runId))?.state).toBe("CLAIMED");
  expect((await f.client.query("SELECT state FROM provider_sandbox_operations")).rows).toEqual([
    { state: "SUCCEEDED" }, { state: "SUCCEEDED" }, { state: "SUCCEEDED" },
  ]);
  expect(f.effects()).toBe(0);
}, 30_000);


test("new actionable work after FAILED still blocks independent terminal attestation", async () => {
  const f = await fixture();
  await f.reconcile();
  expect(await f.checkpoints.terminalAttestation()).toMatchObject({ runId, state: "FAILED" });
  await f.client.exec("INSERT INTO provider_sandbox_operations (id,binding_id,kind,generation,idempotency_scope,idempotency_key,payload_hash,request_payload,state) VALUES ('raced-pending','primary-binding','STOP',1,'other','other','hash','{}','JOURNALED')");
  await expect(f.checkpoints.terminalAttestation()).rejects.toThrow();
  expect((await f.checkpoints.get(runId))?.state).toBe("FAILED");
  expect(f.effects()).toBe(0);
}, 30_000);

test("held same-source two-stage supervisor reopen settles then consumes actual FAILED handoff", async () => {
  const f = await fixture();
  await writeFile(join(f.root, "key.pem"), f.privateKey, { mode: 0o600 });
  await writeFile(join(f.root, "public.pem"), f.publicKey, { mode: 0o600 });
  await writeFile(join(f.root, "PUBLIC_HOLD"), "held", { mode: 0o600 });
  await f.client.close();
  clients.splice(clients.indexOf(f.client), 1);
  const stage = async (phase: string) => {
    const runner = spawn("python3", [join(import.meta.dir, "__tests__/incus-completed-cleanup-expiry-supervisor.py"),
      f.root, phase, process.execPath], { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    let stdout = "";
    runner.stderr.on("data", data => { stderr += data.toString(); });
    runner.stdout.on("data", data => { stdout += data.toString(); });
    const exited = new Promise<number | null>(resolve => runner.once("exit", resolve));
    try {
      const deadline = Date.now() + 25_000;
      while (Date.now() < deadline) {
        try { return JSON.parse(await readFile(join(f.root, `result-${phase}.json`), "utf8")); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (runner.exitCode !== null) throw new Error(`supervisor exited ${runner.exitCode}: ${stderr}`);
        await Bun.sleep(25);
      }
      throw new Error(`supervisor stage timed out: ${stderr}`);
    } finally {
      runner.kill("SIGTERM");
      const timer = setTimeout(() => runner.kill("SIGKILL"), 12_000);
      const exitCode = await exited;
      clearTimeout(timer);
      await saveEvidence(`${phase}.stdout.log`, stdout);
      await saveEvidence(`${phase}.stderr.log`, stderr);
      await saveEvidence(`${phase}.exit-code`, `${exitCode}\n`);
    }
  };
  const first = await stage("first");
  await saveEvidence("first-result.json", await readFile(join(f.root, "result-first.json"), "utf8"));
  expect(first).toMatchObject({ effects: 0, hold: "held", terminalReleased: false,
    beforeTerminal: { runId, state: "FAILED" } });
  const detached = new PGlite(f.directory);
  await detached.waitReady;
  const saved = await completedCleanupComponents(drizzle(detached, { schema }), f.publicKey).checkpoints.get(runId);
  expect(saved?.state).toBe("FAILED");
  await detached.close();
  if (!saved?.receipt) throw new Error("actual signed receipt is absent");
  await writeFile(join(f.root, "handoff.json"), JSON.stringify({ version: 1,
    terminalRow: { runId: saved.runId, nonce: saved.nonce, scope: saved.scope,
      connectionRevision: saved.connectionRevision, state: saved.state }, receipt: saved.receipt }), { mode: 0o600 });
  await saveEvidence("actual-failed-handoff.json", await readFile(join(f.root, "handoff.json"), "utf8"));
  const second = await stage("second");
  await saveEvidence("second-result.json", await readFile(join(f.root, "result-second.json"), "utf8"));
  await saveEvidence("handoff-consumed.json", await readFile(join(f.root, "handoff.json.consumed"), "utf8"));
  expect(second).toMatchObject({ effects: 0, hold: "held", terminalReleased: true, ready: true,
    beforeTerminal: { runId, state: "FAILED" } });
  const consumed = JSON.parse(await readFile(join(f.root, "handoff.json.consumed"), "utf8"));
  expect(consumed).toMatchObject({ runId, terminal: { runId, state: "FAILED" } });
}, 60_000);


test("live signed owner and terminal checkpoints cannot use expired completion verification", async () => {
  const f = await fixture();
  const payload = { ...f.receipt.payload, newProcess: currentProcessIdentity() };
  const liveReceipt = { payload, signature: sign(null, restartHandoffSigningBytes(payload), f.privateKey).toString("base64") };
  await f.client.query("UPDATE incus_qualification_runs SET receipt=$1", [JSON.stringify(liveReceipt)]);
  await expect(f.controller.settleAlreadyCompletedDestroy(scope, handle, operationId)).rejects.toThrow("stopped signed owner");
  await f.reconcile();
  expect((await f.checkpoints.get(runId))?.state).toBe("CLAIMED");
  await f.client.exec("UPDATE incus_qualification_runs SET state='FAILED'");
  await expect(f.controller.settleAlreadyCompletedDestroy(scope, handle, operationId)).rejects.toThrow("claimed recovery run changed");
  expect(f.effects()).toBe(0);
}, 30_000);
