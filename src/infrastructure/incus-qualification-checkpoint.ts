import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { sql } from "drizzle-orm";
import type { Database } from "../db/connection";
import { releaseRows } from "../db/queries/extension-releases";
import type { LiveFixtureHandle } from "./incus-live-cases";
import { observeFixtureAcrossRestart, type RecoveryObservation } from "./incus-live-recovery-probes";
import type { IncusQualificationScope } from "./incus-qualification";

const identifier = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const sha256 = /^[a-f0-9]{64}$/;
const zeroDigest = "0".repeat(64);

export interface ProcessIdentity { pid: number; startTicks: string }

/** Linux's process start tick distinguishes a recycled PID from a restart. */
export function currentProcessIdentity(): ProcessIdentity {
  return identityFromProcStat(readFileSync("/proc/self/stat", "utf8"), process.pid);
}

function identityFromProcStat(stat: string, pid: number): ProcessIdentity {
  const end = stat.lastIndexOf(")");
  const fields = stat.slice(end + 2).trim().split(/\s+/);
  const startTicks = fields[19]; // field 22; fields here begin at field 3
  if (end < 0 || !startTicks || !/^\d+$/.test(startTicks)) {
    throw new Error("Cannot read controller process start identity");
  }
  return { pid, startTicks };
}

function processIdentityIsAlive(identity: ProcessIdentity): boolean {
  try {
    const stat = readFileSync(`/proc/${identity.pid}/stat`, "utf8");
    return identityFromProcStat(stat, identity.pid).startTicks === identity.startTicks;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

export function processIdentityKey(value: ProcessIdentity): string {
  return `${value.pid}:${value.startTicks}`;
}

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
}

export function observationDigest(value: RecoveryObservation): string {
  return createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value)))).digest("hex");
}

export interface RestartHandoffPayload {
  version: 1;
  runId: string;
  nonce: string;
  deadlineMs: number;
  scope: IncusQualificationScope;
  fixtureOperationId: string;
  bindingId: string;
  generation: number;
  connectionRevision: number;
  lastOperationId: string;
  oldProcess: ProcessIdentity;
  newProcess: ProcessIdentity;
  beforeDigest: string;
  afterDigest: string;
}

export interface SignedRestartHandoff {
  payload: RestartHandoffPayload;
  signature: string;
}

export function restartHandoffSigningBytes(payload: RestartHandoffPayload): Buffer {
  return Buffer.from(canonical(payload));
}

/** The private key stays with the operator supervisor. This accepts only its pinned public key. */
export function verifyRestartHandoff(receipt: SignedRestartHandoff, publicKeyPem: string): void {
  if (!receipt || typeof receipt.signature !== "string"
    || !/^[A-Za-z0-9+/]+={0,2}$/.test(receipt.signature)
    || !receipt.payload || receipt.payload.version !== 1
    || !verify(null, restartHandoffSigningBytes(receipt.payload), createPublicKey(publicKeyPem),
      Buffer.from(receipt.signature, "base64"))) {
    throw new Error("Incus restart handoff signature is invalid");
  }
}

interface FixtureIdentityRow {
  operationId: string;
  projectPurpose: string;
  bindingId: string;
  installationId: string;
  releaseId: string;
  connectionId: string;
  connectionRevision: number;
  presetId: string;
  generation: number;
  desiredState: string;
  observedState: string;
  bindingInstallationId: string;
  bindingReleaseId: string;
  bindingConnectionId: string;
  bindingConnectionRevision: number;
  bindingPresetId: string;
  lastOperationId: string | null;
  lastOperationState: string | null;
  lastOperationGeneration: number | null;
}

interface RunRow {
  runId: string;
  fixtureOperationId: string;
  scope: IncusQualificationScope;
  bindingId: string;
  generation: number;
  connectionRevision: number;
  lastOperationId: string;
  nonce: string;
  deadlineAt: Date | string;
  beforeObservation: RecoveryObservation;
  beforeDigest: string;
  oldProcessIdentity: ProcessIdentity;
  state: string;
}

const runColumns = sql`run_id AS "runId", fixture_operation_id AS "fixtureOperationId",
  scope, binding_id AS "bindingId", generation, connection_revision AS "connectionRevision",
  last_operation_id AS "lastOperationId", nonce, deadline_at AS "deadlineAt",
  before_observation AS "beforeObservation", before_digest AS "beforeDigest",
  old_process_identity AS "oldProcessIdentity", state`;

function sameScope(left: IncusQualificationScope, right: IncusQualificationScope): boolean {
  return left.installationId === right.installationId && left.releaseId === right.releaseId
    && left.connectionId === right.connectionId && left.presetId === right.presetId;
}

function requireIdentity(row: FixtureIdentityRow | undefined, scope: IncusQualificationScope,
  handle: LiveFixtureHandle, observation: RecoveryObservation): asserts row is FixtureIdentityRow {
  if (!row || !fixtureMatchesRequest(row, scope, handle)
    || !bindingMatchesFixture(row, observation)
    || !observationMatchesFixture(observation, scope, handle)) {
    throw new Error("Incus restart checkpoint fixture is not the exact stopped qualification binding");
  }
}

function fixtureMatchesRequest(row: FixtureIdentityRow, scope: IncusQualificationScope,
  handle: LiveFixtureHandle): boolean {
  return row.projectPurpose === "incus-qualification" && row.operationId === handle.operationId
    && row.bindingId === handle.sandboxId && row.installationId === scope.installationId
    && row.releaseId === scope.releaseId && row.connectionId === scope.connectionId
    && row.presetId === scope.presetId && row.desiredState === "STOPPED"
    && row.observedState === "STOPPED" && row.lastOperationState === "SUCCEEDED";
}

function bindingMatchesFixture(row: FixtureIdentityRow, observation: RecoveryObservation): boolean {
  return row.lastOperationId === observation.durable.operation?.id
    && row.lastOperationGeneration === row.generation
    && row.bindingInstallationId === row.installationId
    && row.bindingReleaseId === row.releaseId
    && row.bindingConnectionId === row.connectionId
    && row.bindingConnectionRevision === row.connectionRevision
    && row.bindingPresetId === row.presetId
    && row.connectionRevision === observation.durable.fixture.connectionRevision
    && row.generation === observation.durable.binding.generation;
}

function observationMatchesFixture(observation: RecoveryObservation, scope: IncusQualificationScope,
  handle: LiveFixtureHandle): boolean {
  return observation.durable.fixture.installationId === scope.installationId
    && observation.durable.fixture.releaseId === scope.releaseId
    && observation.durable.fixture.connectionId === scope.connectionId
    && observation.durable.fixture.presetId === scope.presetId
    && observation.durable.fixture.operationId === handle.operationId
    && observation.durable.fixture.bindingId === handle.sandboxId
    && observation.durable.binding.id === handle.sandboxId
    && observation.durable.binding.desiredState === "STOPPED"
    && observation.durable.binding.observedState === "STOPPED"
    && observation.backend.sandboxId === handle.sandboxId
    && observation.backend.state === "stopped" && observation.backend.bootId === null
    && sha256.test(observation.backend.imageDigest ?? "")
    && sha256.test(observation.backend.helperDigest ?? "")
    && observation.backend.imageDigest !== zeroDigest
    && observation.backend.helperDigest !== zeroDigest;
}

async function fixtureIdentity(db: Database, fixtureOperationId: string): Promise<FixtureIdentityRow | undefined> {
  const [row] = releaseRows<FixtureIdentityRow>(await db.execute(sql`SELECT
    f.operation_id AS "operationId", p.purpose AS "projectPurpose", f.binding_id AS "bindingId",
    f.installation_id AS "installationId", f.release_id AS "releaseId",
    f.connection_id AS "connectionId", f.connection_revision AS "connectionRevision",
    f.preset_id AS "presetId", b.generation, b.desired_state AS "desiredState",
    b.observed_state AS "observedState", b.provider_installation_id AS "bindingInstallationId",
    b.provider_release_id AS "bindingReleaseId", b.connection_id AS "bindingConnectionId",
    b.connection_revision AS "bindingConnectionRevision", b.preset_id AS "bindingPresetId",
    o.id AS "lastOperationId", o.state AS "lastOperationState",
    o.generation AS "lastOperationGeneration"
    FROM incus_qualification_fixtures f
    JOIN projects p ON p.id = f.project_id
    JOIN sandbox_bindings b ON b.id = f.binding_id AND b.project_id = f.project_id
    LEFT JOIN provider_sandbox_operations o ON o.id = b.current_operation_id AND o.binding_id = b.id
    WHERE f.operation_id = ${fixtureOperationId}`));
  return row;
}

export class IncusQualificationCheckpointStore {
  constructor(private readonly db: Database,
    private readonly publicKeyPem: string | undefined = process.env.EZCORP_INCUS_SUPERVISOR_PUBLIC_KEY,
    private readonly now: () => number = Date.now) {}

  async begin(input: { runId: string; nonce: string; deadlineMs: number;
    scope: IncusQualificationScope; handle: LiveFixtureHandle;
    before: RecoveryObservation }): Promise<void> {
    if (!identifier.test(input.runId) || !identifier.test(input.nonce)
      || !identifier.test(input.handle.operationId) || !identifier.test(input.handle.sandboxId)
      || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= this.now()
      || input.deadlineMs > this.now() + 120_000) {
      throw new Error("Incus restart checkpoint request is invalid or expired");
    }
    const oldProcess = currentProcessIdentity();
    if (input.before.processId !== processIdentityKey(oldProcess)) {
      throw new Error("Incus restart observation did not come from this process");
    }
    const row = await fixtureIdentity(this.db, input.handle.operationId);
    requireIdentity(row, input.scope, input.handle, input.before);
    const beforeDigest = observationDigest(input.before);
    await this.db.execute(sql`INSERT INTO incus_qualification_runs (
      run_id, fixture_operation_id, scope, binding_id, generation, connection_revision,
      last_operation_id, nonce, deadline_at, before_observation, before_digest, old_process_identity
    ) VALUES (${input.runId}, ${input.handle.operationId}, ${JSON.stringify(input.scope)}::jsonb,
      ${input.handle.sandboxId}, ${row.generation}, ${row.connectionRevision}, ${row.lastOperationId},
      ${input.nonce}, ${new Date(input.deadlineMs)}, ${JSON.stringify(input.before)}::jsonb,
      ${beforeDigest}, ${JSON.stringify(oldProcess)}::jsonb)`);
  }

  async get(runId: string): Promise<RunRow | null> {
    if (!identifier.test(runId)) return null;
    const [row] = releaseRows<RunRow>(await this.db.execute(sql`SELECT ${runColumns}
      FROM incus_qualification_runs WHERE run_id = ${runId}`));
    return row ?? null;
  }

  /** Startup may resume one live handoff. Expired rows fail closed and multiple live runs require operator review. */
  async pending(): Promise<RunRow | null> {
    const now = new Date(this.now());
    await this.db.execute(sql`UPDATE incus_qualification_runs
      SET state = 'FAILED', failure_reason = 'restart deadline expired'
      WHERE state = 'AWAITING_RESTART' AND deadline_at <= ${now}`);
    const rows = releaseRows<RunRow>(await this.db.execute(sql`SELECT ${runColumns}
      FROM incus_qualification_runs WHERE state = 'AWAITING_RESTART' AND deadline_at > ${now}
      ORDER BY deadline_at ASC, run_id ASC LIMIT 2`));
    if (rows.length > 1) throw new Error("Multiple Incus restart checkpoints require operator review");
    return rows[0] ?? null;
  }

  /** Used by the private operator control boundary before arming a fault. */
  async authorizeOwnedRun(input: { runId: string; nonce: string; scope: IncusQualificationScope;
    fixtureOperationId: string; bindingId: string; generation: number;
    connectionRevision: number; deadlineMs: number }): Promise<void> {
    const row = await this.get(input.runId);
    const now = this.now();
    const runDeadlineMs = row ? new Date(row.deadlineAt).getTime() : Number.NaN;
    if (row?.state !== "CLAIMED" || row.nonce !== input.nonce
      || row.fixtureOperationId !== input.fixtureOperationId || row.bindingId !== input.bindingId
      || row.generation !== input.generation || row.connectionRevision !== input.connectionRevision
      || !sameScope(row.scope, input.scope) || !Number.isSafeInteger(input.deadlineMs)
      || !Number.isSafeInteger(runDeadlineMs) || now >= runDeadlineMs
      || now >= input.deadlineMs || input.deadlineMs > runDeadlineMs
      || input.deadlineMs > now + 30_000) {
      throw new Error("Incus operator run authority is unavailable");
    }
    const fixture = await fixtureIdentity(this.db, input.fixtureOperationId);
    if (fixture?.projectPurpose !== "incus-qualification"
      || fixture.bindingId !== row.bindingId || fixture.generation !== row.generation
      || fixture.connectionRevision !== row.connectionRevision) {
      throw new Error("Incus operator fixture changed");
    }
  }

  async claim(input: { runId: string; nonce: string; receipt: SignedRestartHandoff;
    after: RecoveryObservation }): Promise<void> {
    const row = await this.get(input.runId);
    if (row?.state !== "AWAITING_RESTART") throw new Error("Incus restart checkpoint is unavailable");
    const fail = async (reason: string): Promise<never> => {
      await this.db.execute(sql`UPDATE incus_qualification_runs SET state = 'FAILED', failure_reason = ${reason}
        WHERE run_id = ${input.runId} AND state = 'AWAITING_RESTART'`);
      throw new Error(reason);
    };
    try {
      if (!this.publicKeyPem) throw new Error("Incus operator supervisor public key is not pinned");
      verifyRestartHandoff(input.receipt, this.publicKeyPem);
      const newProcess = currentProcessIdentity();
      const payload = input.receipt.payload;
      if (this.now() >= new Date(row.deadlineAt).getTime() || payload.deadlineMs !== new Date(row.deadlineAt).getTime()
        || input.nonce !== row.nonce || payload.runId !== row.runId || payload.nonce !== row.nonce
        || !sameScope(payload.scope, row.scope) || payload.fixtureOperationId !== row.fixtureOperationId
        || payload.bindingId !== row.bindingId || payload.generation !== row.generation
        || payload.connectionRevision !== row.connectionRevision
        || payload.lastOperationId !== row.lastOperationId
        || canonical(payload.oldProcess) !== canonical(row.oldProcessIdentity)
        || canonical(payload.newProcess) !== canonical(newProcess)
        || processIdentityKey(payload.oldProcess) === processIdentityKey(newProcess)
        || processIdentityIsAlive(payload.oldProcess)
        || input.after.processId !== processIdentityKey(newProcess)
        || payload.beforeDigest !== row.beforeDigest
        || payload.afterDigest !== observationDigest(input.after)) {
        throw new Error("Incus restart handoff identity or observation changed");
      }
      const handle = { operationId: row.fixtureOperationId, sandboxId: row.bindingId };
      await observeFixtureAcrossRestart(row.scope, handle, {
        readBefore: async () => row.beforeObservation,
        restartAndRead: async () => input.after,
      });
      const fixture = await fixtureIdentity(this.db, row.fixtureOperationId);
      requireIdentity(fixture, row.scope, handle, input.after);
    } catch (error) {
      return fail(error instanceof Error ? error.message : "Incus restart handoff failed");
    }
    const updated = releaseRows<{ runId: string }>(await this.db.execute(sql`UPDATE incus_qualification_runs
      SET state = 'CLAIMED', receipt = ${JSON.stringify(input.receipt)}::jsonb,
        after_observation = ${JSON.stringify(input.after)}::jsonb, claimed_at = NOW()
      WHERE run_id = ${input.runId} AND state = 'AWAITING_RESTART' AND nonce = ${input.nonce}
        AND deadline_at > ${new Date(this.now())} RETURNING run_id AS "runId"`));
    if (updated.length !== 1) throw new Error("Incus restart checkpoint was already claimed or expired");
  }
}
