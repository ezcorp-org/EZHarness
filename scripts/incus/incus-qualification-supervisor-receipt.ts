/** Independent operator receipt check. stdin: {phase:"snapshot",request} or
 * {phase:"verify",payload,snapshot}. The snapshot phase runs as the app UID
 * after the old process exits; verify runs as the operator before signing. */
import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import type { RestartHandoffPayload } from "../../src/infrastructure/incus-qualification-checkpoint";
import { HostIncusLiveReadback, type LiveReadbackContext } from "../../src/infrastructure/incus-transport/live-readback";
import type { ResolvedIncusConnection } from "../../src/infrastructure/incus-transport/transport";
import type { RecoveryObservation } from "../../src/infrastructure/incus-live-recovery-probes";

const digest = /^[a-f0-9]{64}$/;
const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
type Request = Omit<RestartHandoffPayload, "version" | "oldProcess" | "newProcess" | "afterDigest">;
type Snapshot = { request: Request; durable: RecoveryObservation["durable"];
  before: RecoveryObservation; oldProcess: RestartHandoffPayload["oldProcess"];
  presetDigest: string; effectiveSettingsDigest: string };

function requireFact(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`operator receipt denied: ${message}`);
}

function same(left: unknown, right: unknown): boolean {
  return canonical(left) === canonical(right);
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

function observationDigest(value: RecoveryObservation): string {
  return createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value)))).digest("hex");
}

function requireRequest(value: Request): void {
  requireFact(value && typeof value === "object" && identifier.test(value.runId)
    && identifier.test(value.nonce) && identifier.test(value.fixtureOperationId)
    && identifier.test(value.bindingId) && identifier.test(value.lastOperationId)
    && Object.keys(value.scope ?? {}).sort().join() === "connectionId,installationId,presetId,releaseId"
    && Object.values(value.scope).every(item => typeof item === "string" && identifier.test(item))
    && Number.isSafeInteger(value.generation) && value.generation > 0
    && Number.isSafeInteger(value.connectionRevision) && value.connectionRevision > 0
    && Number.isSafeInteger(value.deadlineMs) && Date.now() < value.deadlineMs
    && value.deadlineMs <= Date.now() + 120_000 && digest.test(value.beforeDigest), "invalid request");
}

async function snapshot(request: Request): Promise<Snapshot> {
  requireRequest(request);
  const normalizedRequest: Request = { runId: request.runId, nonce: request.nonce,
    deadlineMs: request.deadlineMs, scope: request.scope,
    fixtureOperationId: request.fixtureOperationId, bindingId: request.bindingId,
    generation: request.generation, connectionRevision: request.connectionRevision,
    lastOperationId: request.lastOperationId, beforeDigest: request.beforeDigest };
  const directory = process.env.EZCORP_INCUS_SUPERVISOR_DB_PATH;
  requireFact(directory?.startsWith("/") && !process.env.DATABASE_URL, "isolated PGlite path required");
  const { PGlite } = await import("@electric-sql/pglite");
  const db = new PGlite(directory);
  try {
    await db.waitReady;
    const result = await db.query<Record<string, unknown>>(`SELECT
      r.run_id AS "runId", r.nonce, r.deadline_at AS "deadlineAt", r.scope,
      r.fixture_operation_id AS "fixtureOperationId", r.binding_id AS "bindingId",
      r.generation, r.connection_revision AS "connectionRevision",
      r.last_operation_id AS "lastOperationId", r.before_digest AS "beforeDigest",
      r.before_observation AS "before", r.old_process_identity AS "oldProcess", r.state,
      f.project_id AS "projectId", f.preset_digest AS "fixturePresetDigest",
      f.effective_settings_digest AS "fixtureSettingsDigest",
      f.installation_id AS "installationId", f.release_id AS "releaseId",
      f.connection_id AS "connectionId", f.preset_id AS "presetId",
      f.connection_revision AS "fixtureRevision", f.binding_id AS "fixtureBindingId",
      p.purpose AS "projectPurpose", b.resource_key AS "resourceKey",
      b.provider_installation_id AS "bindingInstallationId",
      b.provider_release_id AS "bindingReleaseId",
      b.connection_id AS "bindingConnectionId", b.connection_revision AS "bindingRevision",
      b.preset_id AS "bindingPresetId", b.preset_digest AS "bindingPresetDigest",
      b.effective_settings_digest AS "bindingSettingsDigest",
      b.generation AS "bindingGeneration", b.desired_state AS "desiredState",
      b.observed_state AS "observedState", b.current_operation_id AS "currentOperationId",
      o.id AS "operationId", o.kind AS "operationKind", o.state AS "operationState",
      o.generation AS "operationGeneration", o.provider_operation_id AS "providerOperationId",
      o.error_code AS "errorCode", o.created_at AS "createdAt", o.updated_at AS "updatedAt"
      FROM incus_qualification_runs r
      JOIN incus_qualification_fixtures f ON f.operation_id = r.fixture_operation_id
      JOIN projects p ON p.id = f.project_id
      JOIN sandbox_bindings b ON b.id = f.binding_id AND b.project_id = f.project_id
      LEFT JOIN LATERAL (SELECT * FROM provider_sandbox_operations
        WHERE binding_id = b.id ORDER BY reconcile_order DESC, created_at DESC, id DESC LIMIT 1) o ON TRUE
      WHERE r.run_id = $1`, [request.runId]);
    requireFact(result.rows.length === 1, "checkpoint missing or ambiguous");
    const row = result.rows[0]!;
    const scope = request.scope;
    requireFact(row.state === "AWAITING_RESTART" && row.nonce === request.nonce
      && new Date(row.deadlineAt as string).getTime() === request.deadlineMs
      && same(row.scope, scope) && row.fixtureOperationId === request.fixtureOperationId
      && row.bindingId === request.bindingId && row.fixtureBindingId === request.bindingId
      && row.generation === request.generation && row.bindingGeneration === request.generation
      && row.connectionRevision === request.connectionRevision
      && row.fixtureRevision === request.connectionRevision && row.bindingRevision === request.connectionRevision
      && row.lastOperationId === request.lastOperationId && row.currentOperationId === request.lastOperationId
      && row.operationId === request.lastOperationId && row.operationState === "SUCCEEDED"
      && row.operationKind === "STOP"
      && row.operationGeneration === request.generation && row.beforeDigest === request.beforeDigest
      && row.projectPurpose === "incus-qualification" && row.resourceKey === request.bindingId
      && row.desiredState === "STOPPED" && row.observedState === "STOPPED"
      && row.installationId === scope.installationId && row.releaseId === scope.releaseId
      && row.connectionId === scope.connectionId && row.presetId === scope.presetId
      && row.bindingInstallationId === scope.installationId && row.bindingReleaseId === scope.releaseId
      && row.bindingConnectionId === scope.connectionId && row.bindingPresetId === scope.presetId
      && row.bindingPresetDigest === row.fixturePresetDigest
      && row.bindingSettingsDigest === row.fixtureSettingsDigest, "durable fixture changed");
    const before = row.before as RecoveryObservation;
    const oldProcess = row.oldProcess as Snapshot["oldProcess"];
    const durable: Snapshot["durable"] = {
      fixture: { operationId: request.fixtureOperationId, installationId: scope.installationId,
        releaseId: scope.releaseId, connectionId: scope.connectionId,
        connectionRevision: request.connectionRevision, presetId: scope.presetId,
        projectId: row.projectId as string, bindingId: request.bindingId },
      binding: { id: request.bindingId, generation: request.generation,
        desiredState: "STOPPED", observedState: "STOPPED" },
      operation: { id: row.operationId as string, kind: row.operationKind as "STOP",
        state: "SUCCEEDED", generation: request.generation,
        providerOperationId: row.providerOperationId as string | null,
        errorCode: row.errorCode as string | null,
        createdAt: row.createdAt as Date, updatedAt: row.updatedAt as Date },
    };
    requireFact(before && typeof before === "object"
      && same(before.durable, JSON.parse(JSON.stringify(durable)))
      && before.processId === `${oldProcess.pid}:${oldProcess.startTicks}`
      && before.backend?.sandboxId === request.bindingId
      && before.backend.state === "stopped" && before.backend.bootId === null
      && digest.test(before.backend.imageDigest) && digest.test(before.backend.helperDigest)
      && observationDigest(before) === request.beforeDigest, "before observation changed");
    return { request: normalizedRequest, durable: JSON.parse(JSON.stringify(durable)), before, oldProcess,
      presetDigest: row.fixturePresetDigest as string,
      effectiveSettingsDigest: row.fixtureSettingsDigest as string };
  } finally {
    await db.close();
  }
}

async function verify(payload: Omit<RestartHandoffPayload, "afterDigest">, value: Snapshot): Promise<string> {
  const { version, oldProcess, newProcess, ...request } = payload;
  requireFact(version === 1 && value && same(value.request, request)
    && same(value.oldProcess, oldProcess) && Number.isSafeInteger(newProcess?.pid)
    && newProcess.pid > 0 && /^\d+$/.test(newProcess.startTicks)
    && newProcess.pid !== oldProcess.pid && Date.now() < payload.deadlineMs, "handoff changed");
  const path = process.env.EZCORP_INCUS_RECEIPT_CONFIG;
  if (!path?.startsWith("/")) throw new Error("operator connection file required");
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  let raw: string;
  try {
    const file = fstatSync(descriptor);
    requireFact(file.isFile() && file.uid === process.geteuid!() && (file.mode & 0o077) === 0,
      "operator connection file must be private");
    requireFact(file.size > 0 && file.size <= 128 * 1024, "operator connection file size invalid");
    raw = readFileSync(descriptor, "utf8");
  } finally {
    closeSync(descriptor);
  }
  const config = JSON.parse(raw) as { context: LiveReadbackContext;
    transportConnection: ResolvedIncusConnection };
  const { context, transportConnection } = config;
  const image = context?.recipe?.guestImage;
  requireFact(image, "operator image pin required");
  requireFact(context && transportConnection
    && same(context.scope, { installationId: request.scope.installationId,
      releaseId: request.scope.releaseId, connectionId: request.scope.connectionId })
    && context.preset.id === request.scope.presetId
    && context.presetDigest === value.presetDigest
    && context.effectiveSettingsDigest === value.effectiveSettingsDigest
    && context.connection.revision === request.connectionRevision
    && context.connection.serverCertificatePem === transportConnection.serverCertificatePem
    && context.connection.project === transportConnection.project
    && image?.fingerprint === context.preset.imageDigest
    && context.preset.helperDigests.includes(image.helperSha256),
  "operator pin does not match fixture");
  const reader = new HostIncusLiveReadback({ resolveForHost: async input => {
    requireFact(input.connectionId === request.scope.connectionId
      && input.providerInstallationId === request.scope.installationId
      && input.providerReleaseId === request.scope.releaseId
      && input.revision === request.connectionRevision, "connection scope changed");
    return transportConnection;
  } });
  const instance = await reader.instance(context, request.bindingId);
  requireFact(instance.state === "stopped" && instance.imageDigest === context.preset.imageDigest
    && instance.profile === context.preset.profile && instance.memoryBytes !== undefined
    && instance.cpuMillis !== undefined && instance.pids !== undefined
    && instance.diskBytes !== undefined && instance.storageDriver !== undefined
    && instance.privateNetwork === true && instance.restrictedProject === true
    && instance.unprivileged === true, "pinned Incus fixture changed");
  const backend: RecoveryObservation["backend"] = {
    sandboxId: request.bindingId, state: "stopped", imageDigest: instance.imageDigest!,
    helperDigest: image.helperSha256, profile: instance.profile!,
    workspaceRoot: "/workspace", guestUser: context.connection.configuration.guestUser,
    memoryBytes: instance.memoryBytes, cpuMillis: instance.cpuMillis, pids: instance.pids,
    diskBytes: instance.diskBytes, storageDriver: instance.storageDriver,
    privateNetwork: true, restrictedProject: true, unprivileged: true, bootId: null,
  };
  requireFact(same(backend, value.before.backend), "backend changed across restart");
  return observationDigest({ processId: `${newProcess.pid}:${newProcess.startTicks}`,
    durable: value.durable, backend });
}

const input = JSON.parse(await Bun.stdin.text());
if (input.phase === "snapshot") {
  process.stdout.write(JSON.stringify({ snapshot: await snapshot(input.request) }) + "\n");
} else if (input.phase === "verify") {
  process.stdout.write(JSON.stringify({ afterDigest: await verify(input.payload, input.snapshot) }) + "\n");
} else {
  throw new Error("operator receipt phase is invalid");
}
