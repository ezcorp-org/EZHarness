/**
 * The installation's metric samples, from its own product database (C11 M3).
 *
 * Every family is one bounded aggregate scoped to this tenant: counts, the
 * age of an oldest row, a maximum. None returns a row, so no identifier can
 * reach a label, and the label values are the closed sets the registry
 * declares, filled with zeros so a state that empties reads 0 rather than
 * vanishing from the scrape (an alert on a vanished series never resolves).
 *
 * The one in-process family is the security denial counter, which the guest
 * broker route increments when it refuses another tenant's token or host.
 */
import { sql } from "drizzle-orm";
import type { MigrationDb } from "../../db/migrations/types";
import { releaseRows as rows } from "../../db/queries/extension-releases";
import { FACTORY_RUN_STATUS_CONSUMER_ID } from "../run-transition-projector";
import { factoryMetricFamily, type FactoryMetricSample } from "./metric-registry";
import { serveFactoryMetrics, startDeclaredFactoryMetrics, type FactoryMetricsEndpoint, type FactoryMetricsListener } from "./metrics-listener";

/** The runtime's in-process counters; one instance per process. */
export class FactoryMetricCounters {
  private readonly denials = new Map<string, number>();

  securityDenial(kind: "cross_tenant_broker"): void {
    this.denials.set(kind, (this.denials.get(kind) ?? 0) + 1);
  }

  securityDenials(kind: "cross_tenant_broker"): number {
    return this.denials.get(kind) ?? 0;
  }
}

export interface FactoryInstallationMetricSources {
  readonly database: MigrationDb;
  readonly tenantId: string;
  /** The interpreter build this installation runs; any other one an unfinished run needs is unavailable. */
  readonly interpreterBuild: string;
  readonly counters: FactoryMetricCounters;
  readonly now?: () => number;
}

/** Runs that are not finished and so still need their interpreter. */
const UNFINISHED_RUNS = sql.raw("('queued','running','waiting','cancelling')");

function scalar(result: unknown): number {
  const row = rows<{ value: number | string | null }>(result)[0];
  return Number(row?.value ?? 0);
}

/** One sample per declared state, zero where the database holds none. */
async function byState(database: MigrationDb, name: string, query: ReturnType<typeof sql>): Promise<FactoryMetricSample[]> {
  const counted = new Map(rows<{ state: string; value: number | string }>(await database.execute(query)).map((row) => [row.state, Number(row.value)]));
  return (factoryMetricFamily(name).labels.state as readonly string[]).map((state) => ({ name, labels: { state }, value: counted.get(state) ?? 0 }));
}

export async function collectFactoryInstallationMetrics(sources: FactoryInstallationMetricSources): Promise<FactoryMetricSample[]> {
  const { database, tenantId } = sources;
  const now = (sources.now ?? Date.now)();
  const at = sql`to_timestamp(${now / 1000})`;
  const seconds = (milliseconds: number) => Math.max(0, milliseconds) / 1000;
  const age = async (query: ReturnType<typeof sql>) => seconds(scalar(await database.execute(query)));
  const count = async (query: ReturnType<typeof sql>) => scalar(await database.execute(query));

  const sealedAt = rows<{ value: number | string | null }>(await database.execute(sql`SELECT (EXTRACT(EPOCH FROM ${at} - max(sealed_at)) * 1000) AS value FROM factory_checkpoints WHERE tenant_id=${tenantId} AND state='sealed'`))[0]?.value ?? null;

  return [
    { name: "factory_ready_work_oldest_age_seconds", value: await age(sql`SELECT max(${now} - available_at) AS value FROM factory_attempt_queue WHERE tenant_id=${tenantId} AND state='queued' AND available_at <= ${now}`) },
    ...await byState(database, "factory_compute_admissions", sql`SELECT state, count(*) AS value FROM factory_compute_admissions WHERE tenant_id=${tenantId} GROUP BY state`),
    // Running, with no declared wait, nothing executing, and no audit batch,
    // lifecycle change or attempt change for 60 seconds.
    { name: "factory_runs_without_progress", value: await count(sql`SELECT count(*) AS value FROM factory_run_lifecycle l
      WHERE l.tenant_id=${tenantId} AND l.status='running'
        AND NOT EXISTS (SELECT 1 FROM factory_attempt_launches a WHERE a.tenant_id=l.tenant_id AND a.project_id=l.project_id AND a.run_id=l.run_id AND a.state IN ('launching','launched'))
        AND GREATEST(l.updated_at,
          COALESCE((SELECT max(b.created_at) FROM factory_audit_batches b WHERE b.tenant_id=l.tenant_id AND b.project_id=l.project_id AND b.run_id=l.run_id), l.updated_at),
          COALESCE((SELECT max(a.updated_at) FROM factory_attempt_launches a WHERE a.tenant_id=l.tenant_id AND a.project_id=l.project_id AND a.run_id=l.run_id), l.updated_at)
        ) <= ${at} - interval '60 seconds'`) },
    ...await byState(database, "factory_attempts", sql`SELECT state, count(*) AS value FROM factory_attempt_launches WHERE tenant_id=${tenantId} GROUP BY state`),
    { name: "factory_usage_unknown_reservations", value: await count(sql`SELECT count(*) AS value FROM factory_budget_reservations WHERE tenant_id=${tenantId} AND state='uncertain'`) },
    { name: "factory_budget_exhausted_envelopes", value: await count(sql`SELECT count(*) AS value FROM factory_budget_envelopes WHERE tenant_id=${tenantId} AND state='open' AND admission_blocked`) },
    { name: "factory_projection_lag_seconds", value: await age(sql`SELECT EXTRACT(EPOCH FROM ${at} - min(b.created_at)) * 1000 AS value FROM factory_audit_batches b
      LEFT JOIN factory_run_projections p ON p.tenant_id=b.tenant_id AND p.project_id=b.project_id AND p.run_id=b.run_id AND p.consumer_id=${FACTORY_RUN_STATUS_CONSUMER_ID}
      WHERE b.tenant_id=${tenantId} AND b.sequence > COALESCE(p.sequence, 0)`) },
    // Per runner digest, its three most recent finished validator attempts, all failed or uncertain.
    { name: "factory_validator_digests_erroring", value: await count(sql`SELECT count(*) AS value FROM (
        SELECT runner_digest FROM (
          SELECT a.runner_digest, (l.state='uncertain' OR l.terminal_result_json->>'status' IN ('failed','uncertain')) AS errored,
            row_number() OVER (PARTITION BY a.runner_digest ORDER BY l.updated_at DESC, l.attempt_id DESC) AS position
          FROM factory_validator_assignments a JOIN factory_attempt_launches l ON l.tenant_id=a.tenant_id AND l.attempt_id=a.validator_attempt_id
          WHERE a.tenant_id=${tenantId} AND l.state IN ('terminal','uncertain')
        ) recent WHERE position <= 3 GROUP BY runner_digest HAVING count(*) = 3 AND bool_and(errored)
      ) erroring`) },
    ...await byState(database, "factory_release_operations", sql`SELECT state, count(*) AS value FROM factory_release_operations WHERE tenant_id=${tenantId} GROUP BY state`),
    { name: "factory_release_uncertain_oldest_age_seconds", value: await age(sql`SELECT EXTRACT(EPOCH FROM ${at} - min(updated_at)) * 1000 AS value FROM factory_release_operations WHERE tenant_id=${tenantId} AND state='uncertain'`) },
    { name: "factory_checkpoint_sealed", value: sealedAt === null ? 0 : 1 },
    { name: "factory_checkpoint_verified_age_seconds", value: seconds(Number(sealedAt ?? 0)) },
    { name: "factory_interpreter_builds_unavailable", value: await count(sql`SELECT count(DISTINCT r.interpreter_build) AS value FROM factory_runs r
      JOIN factory_run_lifecycle l ON l.tenant_id=r.tenant_id AND l.project_id=r.project_id AND l.run_id=r.run_id
      WHERE r.tenant_id=${tenantId} AND l.status IN ${UNFINISHED_RUNS} AND r.interpreter_build <> ${sources.interpreterBuild}`) },
    { name: "factory_runner_package_not_ready_attempts", value: await count(sql`SELECT count(*) AS value FROM factory_attempt_queue WHERE tenant_id=${tenantId} AND state='queued' AND failure_code='runner_package_not_ready'`) },
    { name: "factory_security_denials_total", labels: { kind: "cross_tenant_broker" }, value: sources.counters.securityDenials("cross_tenant_broker") },
    ...await byState(database, "factory_notification_sends", sql`SELECT state, count(*) AS value FROM factory_notification_sends WHERE tenant_id=${tenantId} GROUP BY state`),
    { name: "factory_notification_send_oldest_queued_age_seconds", value: await age(sql`SELECT max(${now} - created_at) AS value FROM factory_notification_sends WHERE tenant_id=${tenantId} AND state='queued'`) },
  ];
}

/**
 * The installation's `/metrics` listener, or nothing: undeclared binds nothing,
 * and an endpoint whose token cannot be read is reported and binds nothing,
 * so the evaluator's target-down alert names it rather than a scrape that
 * would be refused for ever.
 */
export function composeFactoryInstallationMetrics(
  endpoint: FactoryMetricsEndpoint | undefined,
  sources: FactoryInstallationMetricSources,
  report: (role: string, error: unknown) => void,
): Promise<FactoryMetricsListener | undefined> {
  return startDeclaredFactoryMetrics(endpoint, (declared) => serveFactoryMetrics(declared, "harness", () => collectFactoryInstallationMetrics(sources)),
    (code) => { report("metrics", new Error(code)); });
}
