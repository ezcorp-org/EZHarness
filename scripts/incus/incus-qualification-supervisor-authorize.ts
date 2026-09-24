/** Offline, read-only authority check for an embedded qualification checkpoint.
 * Run only after the old app has exited and before its replacement starts.
 */
import { PGlite } from "@electric-sql/pglite";

interface Request {
  runId: string; nonce: string; deadlineMs: number; scope: Record<string, string>;
  fixtureOperationId: string; bindingId: string; generation: number;
  connectionRevision: number; lastOperationId: string; beforeDigest: string;
}

async function main() {
  const directory = process.env.EZCORP_INCUS_SUPERVISOR_DB_PATH;
  if (!directory || process.env.DATABASE_URL) throw new Error("isolated PGlite path is required");
  const line = await Bun.stdin.text();
  const input = JSON.parse(line) as Request;
  const db = new PGlite(directory);
  try {
    await db.waitReady;
    const result = await db.query<{
      runId: string; nonce: string; deadlineMs: Date | string; scope: Record<string, string>;
      fixtureOperationId: string; bindingId: string; generation: number;
      connectionRevision: number; lastOperationId: string; beforeDigest: string;
      oldProcess: { pid: number; startTicks: string }; state: string;
      projectPurpose: string; desiredState: string; observedState: string;
      currentOperationId: string; operationState: string; operationGeneration: number; fixtureBindingId: string;
      fixtureConnectionRevision: number; fixtureInstallationId: string;
      fixtureReleaseId: string; fixtureConnectionId: string; fixturePresetId: string;
      bindingGeneration: number; bindingInstallationId: string;
      bindingReleaseId: string; bindingConnectionId: string;
      bindingConnectionRevision: number; bindingPresetId: string;
    }>(`SELECT r.run_id AS "runId", r.nonce, r.deadline_at AS "deadlineMs",
      r.scope, r.fixture_operation_id AS "fixtureOperationId", r.binding_id AS "bindingId",
      r.generation, r.connection_revision AS "connectionRevision",
      r.last_operation_id AS "lastOperationId", r.before_digest AS "beforeDigest",
      r.old_process_identity AS "oldProcess", r.state,
      p.purpose AS "projectPurpose", b.desired_state AS "desiredState",
      b.observed_state AS "observedState", o.id AS "currentOperationId", o.state AS "operationState",
      o.generation AS "operationGeneration", f.binding_id AS "fixtureBindingId",
      f.connection_revision AS "fixtureConnectionRevision",
      f.installation_id AS "fixtureInstallationId", f.release_id AS "fixtureReleaseId",
      f.connection_id AS "fixtureConnectionId", f.preset_id AS "fixturePresetId",
      b.generation AS "bindingGeneration",
      b.provider_installation_id AS "bindingInstallationId",
      b.provider_release_id AS "bindingReleaseId",
      b.connection_id AS "bindingConnectionId",
      b.connection_revision AS "bindingConnectionRevision",
      b.preset_id AS "bindingPresetId"
      FROM incus_qualification_runs r
      JOIN incus_qualification_fixtures f ON f.operation_id = r.fixture_operation_id
      JOIN projects p ON p.id = f.project_id
      JOIN sandbox_bindings b ON b.id = f.binding_id AND b.project_id = f.project_id
      JOIN provider_sandbox_operations o ON o.id = b.current_operation_id AND o.binding_id = b.id
      WHERE r.run_id = $1`, [input.runId]);
    const row = result.rows[0];
    const deadlineMs = row ? new Date(row.deadlineMs).getTime() : 0;
    const scope = row?.scope;
    const matches = row?.state === "AWAITING_RESTART" && row.nonce === input.nonce
      && deadlineMs === input.deadlineMs && Date.now() < deadlineMs
      && row.fixtureOperationId === input.fixtureOperationId
      && row.bindingId === input.bindingId && row.fixtureBindingId === input.bindingId
      && row.generation === input.generation
      && row.bindingGeneration === input.generation
      && row.connectionRevision === input.connectionRevision
      && row.fixtureConnectionRevision === input.connectionRevision
      && row.bindingConnectionRevision === input.connectionRevision
      && row.lastOperationId === input.lastOperationId
      && row.currentOperationId === row.lastOperationId
      && row.beforeDigest === input.beforeDigest
      && row.projectPurpose === "incus-qualification"
      && row.desiredState === "STOPPED" && row.observedState === "STOPPED"
      && row.operationState === "SUCCEEDED" && row.operationGeneration === row.generation
      && scope && Object.keys(input.scope).length === 4
      && Object.keys(scope).length === 4
      && Object.entries(input.scope).every(([key, value]) => scope[key] === value)
      && row.fixtureInstallationId === input.scope.installationId
      && row.fixtureReleaseId === input.scope.releaseId
      && row.fixtureConnectionId === input.scope.connectionId
      && row.fixturePresetId === input.scope.presetId
      && row.bindingInstallationId === input.scope.installationId
      && row.bindingReleaseId === input.scope.releaseId
      && row.bindingConnectionId === input.scope.connectionId
      && row.bindingPresetId === input.scope.presetId;
    if (!matches) throw new Error("checkpoint or fixture mismatch");
    process.stdout.write(JSON.stringify({ authorized: true, oldProcess: row.oldProcess }) + "\n");
  } finally {
    await db.close();
  }
}

await main();
