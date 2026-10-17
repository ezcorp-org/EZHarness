import { expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";

test("offline verifier accepts only the exact stopped qualification checkpoint", async () => {
  const directory = await mkdtemp(join(tmpdir(), "incus-supervisor-db-"));
  try {
    const db = new PGlite(directory);
    await db.waitReady;
    const deadlineMs = Date.now() + 60_000;
    await db.exec(`
      CREATE TABLE incus_qualification_runs (run_id TEXT, nonce TEXT, deadline_at TIMESTAMPTZ,
        scope JSONB, fixture_operation_id TEXT, binding_id TEXT, generation INTEGER,
        connection_revision INTEGER, last_operation_id TEXT, before_digest TEXT,
        old_process_identity JSONB, state TEXT);
      CREATE TABLE incus_qualification_fixtures (operation_id TEXT, project_id TEXT,
        binding_id TEXT, connection_revision INTEGER, installation_id TEXT, release_id TEXT,
        connection_id TEXT, preset_id TEXT);
      CREATE TABLE projects (id TEXT, purpose TEXT);
      CREATE TABLE sandbox_bindings (id TEXT, project_id TEXT, current_operation_id TEXT,
        desired_state TEXT, observed_state TEXT, generation INTEGER,
        provider_installation_id TEXT, provider_release_id TEXT, connection_id TEXT,
        connection_revision INTEGER, preset_id TEXT);
      CREATE TABLE provider_sandbox_operations (id TEXT, binding_id TEXT, state TEXT,
        generation INTEGER);
      INSERT INTO projects VALUES ('project', 'incus-qualification');
      INSERT INTO sandbox_bindings VALUES ('binding', 'project', 'operation', 'STOPPED', 'STOPPED',
        3, 'installation', 'release', 'connection', 2, 'preset');
      INSERT INTO provider_sandbox_operations VALUES ('operation', 'binding', 'SUCCEEDED', 3);
      INSERT INTO incus_qualification_fixtures VALUES ('fixture', 'project', 'binding', 2,
        'installation', 'release', 'connection', 'preset');
    `);
    const scope = { installationId: "installation", releaseId: "release",
      connectionId: "connection", presetId: "preset" };
    const oldProcess = { pid: 123, startTicks: "456" };
    await db.query(`INSERT INTO incus_qualification_runs VALUES
      ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`, ["run", "nonce", new Date(deadlineMs),
      JSON.stringify(scope), "fixture", "binding", 3, 2, "operation", "a".repeat(64),
      JSON.stringify(oldProcess), "AWAITING_RESTART"]);
    await db.close();
    const request = { runId: "run", nonce: "nonce", deadlineMs, scope,
      fixtureOperationId: "fixture", bindingId: "binding", generation: 3,
      connectionRevision: 2, lastOperationId: "operation", beforeDigest: "a".repeat(64) };
    const invoke = (input: object) => spawnSync(process.execPath,
      [join(import.meta.dir, "incus-qualification-supervisor-authorize.ts")], {
        input: JSON.stringify(input), encoding: "utf8",
        env: { ...process.env, EZCORP_INCUS_SUPERVISOR_DB_PATH: directory, DATABASE_URL: "" },
      });
    const accepted = invoke(request);
    expect(accepted.status).toBe(0);
    expect(JSON.parse(accepted.stdout)).toEqual({ authorized: true, oldProcess });
    for (const changed of [{ ...request, bindingId: "user-binding" },
      { ...request, beforeDigest: "b".repeat(64) }, { ...request, nonce: "replay" }]) {
      expect(invoke(changed).status).not.toBe(0);
    }
    const changedDb = new PGlite(directory);
    await changedDb.waitReady;
    await changedDb.exec(`
      INSERT INTO provider_sandbox_operations VALUES ('replacement-operation', 'binding', 'SUCCEEDED', 3);
      UPDATE sandbox_bindings SET current_operation_id = 'replacement-operation' WHERE id = 'binding';
    `);
    await changedDb.close();
    expect(invoke(request).status).not.toBe(0);
    const changedPurposeDb = new PGlite(directory);
    await changedPurposeDb.waitReady;
    await changedPurposeDb.exec("UPDATE sandbox_bindings SET current_operation_id = 'operation' WHERE id = 'binding'");
    await changedPurposeDb.exec("UPDATE projects SET purpose = 'user' WHERE id = 'project'");
    await changedPurposeDb.close();
    expect(invoke(request).status).not.toBe(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
