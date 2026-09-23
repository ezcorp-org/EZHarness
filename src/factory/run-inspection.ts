import { sql } from "drizzle-orm";
import type {
  FactoryAcceptanceResource, FactoryApiPage, FactoryArtifactResource, FactoryAttemptResource, FactoryBlockerResource, FactoryChildRunResource,
  FactoryInspectionPage, FactoryInspectionQuery, FactoryInspectionSection, FactoryRunCostResource, FactoryRunInspection, FactoryRunReleaseResource, FactoryRunStatus,
  FactoryValidatorMaterialQuery,
  FactoryValidatorMaterialResource,
} from "@ezcorp/factory-sdk";
import type { MigrationDb, TransactionalDb } from "../db/migrations/types";
import { releaseRows as rows } from "../db/queries/extension-releases";
import { FactoryConsoleError, type FactoryEventCursors } from "./console-tokens";
import type { FactoryGrants, FactoryPrincipal } from "./grants";
import { assertFactoryIdentity, encodeFactoryPayload, type FactoryRunKey } from "./records";
import { FactoryRunLifecycleError, type FactoryRunLifecycle } from "./run-lifecycle";
import { FACTORY_RUN_STATUS_CONSUMER_ID } from "./run-transition-projector";
import { FactoryTrustedValidatorError, readFactoryValidatorMaterialInTransaction, type FactoryValidatorMaterialSelector } from "./validator-materials";

const DEFAULT_LIMIT = 50;
const SECTION_CAP = 200;
const SMALL_SECTION = 50;
const MS = sql.raw("(EXTRACT(EPOCH FROM created_at) * 1000)::bigint");

type Row = Record<string, unknown>;
type Keyset = readonly (string | number)[];

function text(value: unknown): string { return String(value); }
function count(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new FactoryRunLifecycleError("factory_run_corrupt");
  return parsed;
}
function optional<T>(value: T | null | undefined): T | undefined { return value === null || value === undefined ? undefined : value; }

/** An opaque keyset position. It carries only the ordering columns of the last row served. */
function encodeKeyset(values: Keyset): string { return Buffer.from(JSON.stringify(values)).toString("base64url"); }
function parseKeyset(cursor: string): unknown {
  try { return JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as unknown; } catch { return null; }
}
/** A malformed position is refused, never partially honoured. */
function decodeKeyset(cursor: string | undefined, arity: number): Keyset | null {
  if (cursor === undefined) return null;
  const parsed = parseKeyset(cursor);
  if (Array.isArray(parsed) && parsed.length === arity && parsed.every(item => typeof item === "string" || Number.isSafeInteger(item))) return parsed as Keyset;
  throw new FactoryConsoleError("factory_page_invalid");
}

function page<T>(items: readonly T[], limit: number, position: (item: T) => Keyset): FactoryApiPage<T> {
  const served = items.slice(0, limit);
  return items.length > limit ? { items: served, nextCursor: encodeKeyset(position(served.at(-1)!)) } : { items: served };
}

function micros(value: unknown): bigint {
  const parsed = typeof value === "string" ? JSON.parse(value) as { costMicros?: unknown } : null;
  return typeof parsed?.costMicros === "string" && /^(0|[1-9][0-9]{0,77})$/.test(parsed.costMicros) ? BigInt(parsed.costMicros) : 0n;
}

/**
 * One bounded, authorized view of a run for the live console (C09). It is read
 * inside one transaction after the caller's current read authority is checked,
 * and every section is scoped to the installation's tenant, the project, and
 * the run, so two installations with overlapping identifiers cannot see each
 * other's rows.
 */
export class FactoryRunInspections {
  constructor(
    private readonly database: TransactionalDb,
    readonly tenantId: string,
    private readonly grants: FactoryGrants,
    private readonly runs: FactoryRunLifecycle,
    private readonly cursors: FactoryEventCursors,
  ) { assertFactoryIdentity(tenantId); if (grants.tenantId !== tenantId) throw new Error("factory_scope_mismatch"); }

  async inspect(principal: FactoryPrincipal, key: FactoryRunKey, query: FactoryInspectionQuery = {}): Promise<FactoryRunInspection | FactoryInspectionPage> {
    const input = JSON.parse(encodeFactoryPayload({ principal, key, query })) as { principal: FactoryPrincipal; key: FactoryRunKey; query: FactoryInspectionQuery };
    assertFactoryIdentity(input.key.projectId, input.key.runId);
    const limit = input.query.limit ?? DEFAULT_LIMIT;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SECTION_CAP) throw new FactoryConsoleError("factory_page_invalid");
    if (input.query.section === undefined && input.query.cursor !== undefined) throw new FactoryConsoleError("factory_page_invalid");
    if (input.query.section !== undefined) {
      const section = input.query.section;
      return this.database.transaction(async transaction => {
        await this.authorize(transaction, input.principal, input.key);
        return this.section(transaction, input.key, section, limit, input.query.cursor, input.query.search);
      });
    }
    // The cursor is taken BEFORE the run is read. Events after it can only be
    // ones the status already reflects, which a client dedupes; the reverse
    // order could hand out a cursor past a transition the snapshot never saw.
    const partial = await this.database.transaction(async transaction => {
      await this.authorize(transaction, input.principal, input.key);
      const progress = await this.progress(transaction, input.key);
      // Sequential on purpose: one transaction holds one connection.
      const children = await this.children(transaction, input.key, limit, undefined);
      const attempts = await this.attempts(transaction, input.key, limit, undefined, input.query.search);
      const artifacts = await this.artifacts(transaction, input.key, limit, undefined);
      return {
        cursor: this.cursors.issue(this.tenantId, input.key, progress.sequence),
        projectionLag: progress.lag,
        ...(await this.parent(transaction, input.key)),
        children, attempts, artifacts,
        blockers: await this.blockers(transaction, input.key),
        costs: await this.costs(transaction, input.key),
        acceptance: await this.acceptance(transaction, input.key),
        releases: await this.releases(transaction, input.key),
        ...(await this.runMaterial(transaction, input.key)),
      };
    });
    return { run: await this.runs.read(input.principal, input.key), ...partial };
  }

  /**
   * The registered validator material a published version or a validator lock
   * names, for any principal that may read the project (W09d O2).
   */
  async material(principal: FactoryPrincipal, projectId: string, query: FactoryValidatorMaterialQuery): Promise<FactoryValidatorMaterialResource> {
    const input = JSON.parse(encodeFactoryPayload({ principal, projectId, query })) as { principal: FactoryPrincipal; projectId: string; query: FactoryValidatorMaterialQuery };
    assertFactoryIdentity(input.projectId);
    const { factoryId, factoryVersion, validatorLockDigest } = input.query;
    const byVersion = factoryId !== undefined && factoryVersion !== undefined && validatorLockDigest === undefined;
    const byLock = validatorLockDigest !== undefined && factoryId === undefined && factoryVersion === undefined;
    if (!byVersion && !byLock) throw new FactoryConsoleError("factory_material_query_invalid");
    return this.database.transaction(async transaction => {
      await this.grants.authorizeInTransaction(transaction, input.principal, input.projectId, "read");
      const found = await this.readMaterial(transaction, input.projectId, byLock ? { validatorLockDigest: validatorLockDigest! } : { factoryId: factoryId!, factoryVersion: factoryVersion! });
      if (!found) throw new FactoryConsoleError("factory_material_not_found");
      return found;
    });
  }

  private async runMaterial(transaction: MigrationDb, key: FactoryRunKey): Promise<{ validatorMaterial?: FactoryValidatorMaterialResource }> {
    const [row] = rows<Row>(await transaction.execute(sql`SELECT factory_id, factory_version FROM factory_run_lifecycle WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId}`));
    const found = await this.readMaterial(transaction, key.projectId, { factoryId: text(row!.factory_id), factoryVersion: text(row!.factory_version) });
    return found ? { validatorMaterial: found } : {};
  }

  /** The public material, or undefined when none is registered. */
  private async readMaterial(transaction: MigrationDb, projectId: string, selector: FactoryValidatorMaterialSelector): Promise<FactoryValidatorMaterialResource | undefined> {
    try {
      const { projectId: _projectId, ...material } = await readFactoryValidatorMaterialInTransaction(transaction, this.tenantId, projectId, selector);
      return material;
    } catch (error) {
      if (error instanceof FactoryTrustedValidatorError && error.code === "factory_validator_material_missing") return undefined;
      throw error;
    }
  }

  private async authorize(transaction: MigrationDb, principal: FactoryPrincipal, key: FactoryRunKey): Promise<void> {
    await this.grants.authorizeInTransaction(transaction, principal, key.projectId, "read");
    const found = rows<Row>(await transaction.execute(sql`SELECT 1 FROM factory_run_lifecycle WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId}`));
    if (found.length === 0) throw new FactoryRunLifecycleError("factory_run_not_found");
  }

  private async progress(transaction: MigrationDb, key: FactoryRunKey): Promise<{ sequence: number; lag: number }> {
    const [row] = rows<Row>(await transaction.execute(sql`SELECT
      COALESCE((SELECT sequence FROM factory_run_projections WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND consumer_id=${FACTORY_RUN_STATUS_CONSUMER_ID}), 0) AS projected,
      COALESCE((SELECT MAX(sequence) FROM factory_audit_batches WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId}), 0) AS committed`));
    const projected = count(row!.projected), committed = count(row!.committed);
    if (committed < projected) throw new FactoryRunLifecycleError("factory_run_corrupt");
    return { sequence: projected, lag: committed - projected };
  }

  private section(transaction: MigrationDb, key: FactoryRunKey, section: FactoryInspectionSection, limit: number, cursor: string | undefined, search: string | undefined): Promise<FactoryInspectionPage> {
    if (section === "children") return this.children(transaction, key, limit, cursor).then(value => ({ section, page: value }));
    if (section === "attempts") return this.attempts(transaction, key, limit, cursor, search).then(value => ({ section, page: value }));
    return this.artifacts(transaction, key, limit, cursor).then(value => ({ section, page: value }));
  }

  private async parent(transaction: MigrationDb, key: FactoryRunKey): Promise<{ parentRunId?: string }> {
    const [row] = rows<Row>(await transaction.execute(sql`SELECT parent_run_id FROM factory_child_runs WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND child_run_id=${key.runId} LIMIT 1`));
    return row ? { parentRunId: text(row.parent_run_id) } : {};
  }

  private async children(transaction: MigrationDb, key: FactoryRunKey, limit: number, cursor: string | undefined): Promise<FactoryApiPage<FactoryChildRunResource>> {
    const after = decodeKeyset(cursor, 1);
    const found = rows<Row>(await transaction.execute(sql`SELECT c.child_run_id, c.child_factory_id, c.child_factory_version, c.state, c.deadline_ms, l.status
      FROM factory_child_runs c LEFT JOIN factory_run_lifecycle l ON l.tenant_id=c.tenant_id AND l.project_id=c.project_id AND l.run_id=c.child_run_id
      WHERE c.tenant_id=${this.tenantId} AND c.project_id=${key.projectId} AND c.parent_run_id=${key.runId} ${after ? sql`AND c.child_run_id > ${after[0]}` : sql``}
      ORDER BY c.child_run_id LIMIT ${limit + 1}`));
    return page(found.map(row => ({
      runId: text(row.child_run_id), factoryId: text(row.child_factory_id), factoryVersion: text(row.child_factory_version), state: text(row.state),
      ...(row.status === null || row.status === undefined ? {} : { status: row.status as FactoryRunStatus }), deadlineMs: count(row.deadline_ms),
    })), limit, item => [item.runId]);
  }

  private async attempts(transaction: MigrationDb, key: FactoryRunKey, limit: number, cursor: string | undefined, search: string | undefined): Promise<FactoryApiPage<FactoryAttemptResource>> {
    const after = decodeKeyset(cursor, 3);
    const found = rows<Row>(await transaction.execute(sql`SELECT e.attempt_id, e.node_instance_id, e.attempt_number, e.candidate_generation, e.status,
        (EXTRACT(EPOCH FROM e.created_at) * 1000)::bigint AS started_ms, (EXTRACT(EPOCH FROM e.updated_at) * 1000)::bigint AS updated_ms,
        (EXTRACT(EPOCH FROM e.stopped_at) * 1000)::bigint AS stopped_ms, t.result_digest, t.output_artifact_id
      FROM factory_executions e LEFT JOIN factory_execution_terminals t ON t.tenant_id=e.tenant_id AND t.project_id=e.project_id AND t.run_id=e.run_id AND t.attempt_id=e.attempt_id
      WHERE e.tenant_id=${this.tenantId} AND e.project_id=${key.projectId} AND e.run_id=${key.runId}
        ${search === undefined ? sql`` : sql`AND strpos(e.node_instance_id, ${search}) > 0`}
        ${after ? sql`AND (e.node_instance_id, e.attempt_number, e.attempt_id) > (${after[0]}, ${after[1]}, ${after[2]})` : sql``}
      ORDER BY e.node_instance_id, e.attempt_number, e.attempt_id LIMIT ${limit + 1}`));
    return page(found.map(row => ({
      attemptId: text(row.attempt_id), nodeInstanceId: text(row.node_instance_id), attemptNumber: count(row.attempt_number),
      candidateGeneration: count(row.candidate_generation), status: text(row.status), startedAtMs: count(row.started_ms), updatedAtMs: count(row.updated_ms),
      ...(row.stopped_ms === null ? {} : { stoppedAtMs: count(row.stopped_ms) }),
      ...(optional(row.result_digest as string | null) === undefined ? {} : { resultDigest: text(row.result_digest) }),
      ...(optional(row.output_artifact_id as string | null) === undefined ? {} : { outputArtifactId: text(row.output_artifact_id) }),
    })), limit, item => [item.nodeInstanceId, item.attemptNumber, item.attemptId]);
  }

  private async artifacts(transaction: MigrationDb, key: FactoryRunKey, limit: number, cursor: string | undefined): Promise<FactoryApiPage<FactoryArtifactResource>> {
    const after = decodeKeyset(cursor, 1);
    const found = rows<Row>(await transaction.execute(sql`SELECT object_id, kind, digest, encoded_bytes, candidate_node_instance_id, ${MS} AS created_ms FROM factory_artifacts
      WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} ${after ? sql`AND object_id > ${after[0]}` : sql``}
      ORDER BY object_id LIMIT ${limit + 1}`));
    return page(found.map(row => ({
      artifactId: text(row.object_id), kind: text(row.kind), digest: text(row.digest), encodedBytes: count(row.encoded_bytes),
      ...(row.candidate_node_instance_id === null ? {} : { nodeInstanceId: text(row.candidate_node_instance_id) }), createdAtMs: count(row.created_ms),
    })), limit, item => [item.artifactId]);
  }

  /** What holds the run now. Reasons are fixed text: a blocker never echoes a stored payload. */
  private async blockers(transaction: MigrationDb, key: FactoryRunKey): Promise<readonly FactoryBlockerResource[]> {
    const scope = sql`tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId}`;
    const found = rows<Row>(await transaction.execute(sql`
      (SELECT 'approval' AS kind, approval_id AS id, node_instance_id AS node, 'Waiting for an approval decision' AS reason, ${MS} AS since FROM factory_command_approvals WHERE ${scope} AND status='pending' ORDER BY created_at LIMIT ${SMALL_SECTION})
      UNION ALL (SELECT 'budget', envelope_id, NULL, 'Budget admission is blocked', 0 FROM factory_budget_envelopes WHERE ${scope} AND state='open' AND admission_blocked ORDER BY envelope_id LIMIT ${SMALL_SECTION})
      UNION ALL (SELECT 'compute', reservation_id, NULL, 'Waiting for compute admission', ${MS} FROM factory_compute_admissions WHERE ${scope} AND state IN ('pending','queued') ORDER BY created_at LIMIT ${SMALL_SECTION})
      UNION ALL (SELECT 'release', operation_id, node_instance_id, CASE WHEN state='uncertain' THEN 'Release outcome is uncertain and needs reconciliation' ELSE 'Release waits for approval or dispatch' END, ${MS} FROM factory_release_operations WHERE ${scope} AND state IN ('pending','uncertain') ORDER BY created_at LIMIT ${SMALL_SECTION})
      UNION ALL (SELECT 'stop', attempt_id, NULL, 'Attempt stop is uncertain', ${MS} FROM factory_task_stops WHERE ${scope} AND state='uncertain' ORDER BY created_at LIMIT ${SMALL_SECTION})`));
    return found.map(row => ({
      kind: row.kind as FactoryBlockerResource["kind"], id: text(row.id), ...(row.node === null ? {} : { nodeInstanceId: text(row.node) }),
      reason: text(row.reason), sinceMs: count(row.since),
    }));
  }

  private async costs(transaction: MigrationDb, key: FactoryRunKey): Promise<FactoryRunCostResource> {
    const scope = sql`tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId}`;
    const [envelope] = rows<Row>(await transaction.execute(sql`SELECT limits, allocated, spent, admission_blocked FROM factory_budget_envelopes WHERE ${scope} AND parent_id IS NULL ORDER BY envelope_id LIMIT 1`));
    const settlements = rows<Row>(await transaction.execute(sql`SELECT DISTINCT ON (reservation_id) known_cost_micros, unknown_cost_micros FROM factory_usage_settlements WHERE ${scope} ORDER BY reservation_id, revision DESC`));
    const [uncertain] = rows<Row>(await transaction.execute(sql`SELECT EXISTS (SELECT 1 FROM factory_budget_reservations WHERE ${scope} AND (state='uncertain' OR uncertainty IS NOT NULL)) AS uncertain`));
    let known = 0n, unknown = 0n;
    for (const row of settlements) {
      known += BigInt(text(row.known_cost_micros));
      if (row.unknown_cost_micros !== null) unknown += BigInt(text(row.unknown_cost_micros));
    }
    return {
      limitMicros: String(micros(envelope?.limits)), allocatedMicros: String(micros(envelope?.allocated)), spentMicros: String(micros(envelope?.spent)),
      knownCostMicros: String(known), unknownCostMicros: String(unknown), admissionBlocked: envelope?.admission_blocked === true,
      uncertain: uncertain?.uncertain === true || unknown > 0n,
    };
  }

  private async acceptance(transaction: MigrationDb, key: FactoryRunKey): Promise<readonly FactoryAcceptanceResource[]> {
    const found = rows<Row>(await transaction.execute(sql`SELECT command_id, decision, receipt_json, ${MS} AS created_ms FROM factory_protected_command_effects
      WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} AND kind='request-acceptance' ORDER BY created_at, command_id LIMIT ${SECTION_CAP}`));
    return found.map(row => {
      const receipt = JSON.parse(text(row.receipt_json)) as { outcome?: string; candidateDigest?: string; decision?: { candidateDigest?: string }; failures?: FactoryAcceptanceResource["reasons"]; groupFailures?: FactoryAcceptanceResource["groupFailures"] };
      const rejected = (row.decision ?? receipt.outcome) === "rejected";
      return {
        commandId: text(row.command_id), decision: rejected ? "rejected" : "accepted",
        candidateDigest: text(rejected ? receipt.candidateDigest : receipt.decision?.candidateDigest),
        reasons: (rejected ? receipt.failures ?? [] : []).slice(0, SECTION_CAP).map(item => ({ claimId: item.claimId, validatorId: item.validatorId, verdict: item.verdict, reasonCode: item.reasonCode })),
        groupFailures: (rejected ? receipt.groupFailures ?? [] : []).slice(0, SECTION_CAP).map(item => ({ groupId: item.groupId, passes: item.passes, minimumPasses: item.minimumPasses })),
        decidedAtMs: count(row.created_ms),
      };
    });
  }

  private async releases(transaction: MigrationDb, key: FactoryRunKey): Promise<readonly FactoryRunReleaseResource[]> {
    const found = rows<Row>(await transaction.execute(sql`SELECT operation_id, node_instance_id, state, action, dispatch_generation, outcome_code FROM factory_release_operations
      WHERE tenant_id=${this.tenantId} AND project_id=${key.projectId} AND run_id=${key.runId} ORDER BY created_at, operation_id LIMIT ${SECTION_CAP}`));
    return found.map(row => ({
      operationId: text(row.operation_id), nodeInstanceId: text(row.node_instance_id), state: text(row.state), action: text(row.action),
      dispatchGeneration: count(row.dispatch_generation), ...(row.outcome_code === null ? {} : { outcomeCode: text(row.outcome_code) }),
    }));
  }
}

