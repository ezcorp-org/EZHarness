import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { FACTORY_RUN_STATUS_CONSUMER_ID } from "../../src/factory/run-transition-projector";
import { FACTORY_METRIC_FAMILIES, factoryMetricRenderer, type FactoryMetricSample } from "../../src/factory/observability/metric-registry";
import { FactoryMetricCounters, collectFactoryInstallationMetrics } from "../../src/factory/observability/installation-metrics";
import {
  METRIC_BUILD, METRIC_TENANT, forceAdmission, forceAttempt, forceBudget, forceCheckpoint, forceProjection, forceReadyWork, forceRelease,
  forceRun, forceSend, forceValidatorOutcomes, seedMetricInstallation,
} from "../../src/__tests__/helpers/factory-metric-conditions";
import { setupFactoryPostgres } from "./helpers/factory-test-database";

type Fixture = Awaited<ReturnType<typeof setupFactoryPostgres>>;
const NOW = Date.UTC(2026, 9, 16, 0, 0, 0);
let fixture: Fixture;
let counters: FactoryMetricCounters;

beforeAll(async () => {
  fixture = await setupFactoryPostgres();
  await seedMetricInstallation(fixture.db as never);
}, 60_000);
afterAll(async () => { await fixture.close(); });

const TABLES = ["factory_attempt_queue", "factory_compute_admissions", "factory_validator_assignments", "factory_attempt_launches", "factory_run_projections", "factory_audit_batches",
  "factory_run_lifecycle", "factory_runs", "factory_budget_reservations", "factory_budget_envelopes", "factory_release_operations", "factory_checkpoints", "factory_notification_sends"];

beforeEach(async () => {
  counters = new FactoryMetricCounters();
  await fixture.db.transaction(async (transaction) => {
    await transaction.execute(sql`SET LOCAL session_replication_role = replica`);
    for (const table of TABLES) await transaction.execute(sql.raw(`DELETE FROM ${table}`));
  });
});

async function collect(): Promise<FactoryMetricSample[]> {
  return collectFactoryInstallationMetrics({ database: fixture.db as never, tenantId: METRIC_TENANT, interpreterBuild: METRIC_BUILD, now: () => NOW, counters });
}

function value(samples: readonly FactoryMetricSample[], name: string, labels: Record<string, string> = {}): number | undefined {
  return samples.find((sample) => sample.name === name && JSON.stringify(sample.labels ?? {}) === JSON.stringify(labels))?.value;
}

describe("the installation collector (C11 M3)", () => {
  test("an idle installation renders every installation family, every state at zero, and passes the strict exposition", async () => {
    const samples = await collect();
    for (const family of FACTORY_METRIC_FAMILIES.filter((candidate) => candidate.services.includes("harness") && candidate.name !== "factory_metrics_label_refused_total")) {
      expect(samples.some((sample) => sample.name === family.name)).toBe(true);
      const state = family.labels.state;
      if (Array.isArray(state)) for (const each of state) expect(value(samples, family.name, { state: each })).toBe(0);
    }
    expect(value(samples, "factory_checkpoint_sealed")).toBe(0);
    expect(value(samples, "factory_security_denials_total", { kind: "cross_tenant_broker" })).toBe(0);
    expect(() => factoryMetricRenderer("harness", { strict: true, registered: {} }).render(samples)).not.toThrow();
  });

  test("ready work, admission, attempts and a package held unprepared", async () => {
    await forceReadyWork(fixture.db as never, NOW, 45_000);
    await forceReadyWork(fixture.db as never, NOW, 5_000, "runner_package_not_ready");
    await forceReadyWork(fixture.db as never, NOW, -10_000);
    await forceAdmission(fixture.db as never, "pending");
    const run = await forceRun(fixture.db as never, NOW, { status: "running" });
    await forceAttempt(fixture.db as never, NOW, run, "launched");
    const samples = await collect();
    expect(value(samples, "factory_ready_work_oldest_age_seconds")).toBe(45);
    expect(value(samples, "factory_runner_package_not_ready_attempts")).toBe(1);
    expect(value(samples, "factory_compute_admissions", { state: "pending" })).toBe(1);
    expect(value(samples, "factory_attempts", { state: "launched" })).toBe(1);
  });

  test("a running run with no progress for 60 seconds, but not one waiting, executing, or recently moved", async () => {
    await forceRun(fixture.db as never, NOW, { status: "running", updatedAgeMs: 61_000 });
    await forceRun(fixture.db as never, NOW, { status: "waiting", updatedAgeMs: 600_000 });
    await forceRun(fixture.db as never, NOW, { status: "running", updatedAgeMs: 30_000 });
    const executing = await forceRun(fixture.db as never, NOW, { status: "running", updatedAgeMs: 600_000 });
    await forceAttempt(fixture.db as never, NOW, executing, "launched", { ageMs: 600_000 });
    const batched = await forceRun(fixture.db as never, NOW, { status: "running", updatedAgeMs: 600_000 });
    await forceProjection(fixture.db as never, NOW, batched, { sequence: 1, projected: 1, ageMs: 10_000, consumerId: FACTORY_RUN_STATUS_CONSUMER_ID });
    expect(value(await collect(), "factory_runs_without_progress")).toBe(1);
  });

  test("unknown usage and an exhausted budget", async () => {
    await forceBudget(fixture.db as never, { exhausted: true, reservationState: "uncertain" });
    await forceBudget(fixture.db as never, { exhausted: false, reservationState: "settled" });
    const samples = await collect();
    expect(value(samples, "factory_usage_unknown_reservations")).toBe(1);
    expect(value(samples, "factory_budget_exhausted_envelopes")).toBe(1);
  });

  test("projection lag is the age of the oldest batch past the projector's cursor", async () => {
    const lagging = await forceRun(fixture.db as never, NOW, { status: "running" });
    await forceProjection(fixture.db as never, NOW, lagging, { sequence: 3, projected: 1, ageMs: 20_000, consumerId: FACTORY_RUN_STATUS_CONSUMER_ID });
    const neverProjected = await forceRun(fixture.db as never, NOW, { status: "running" });
    await forceProjection(fixture.db as never, NOW, neverProjected, { sequence: 1, projected: 0, ageMs: 12_000, consumerId: FACTORY_RUN_STATUS_CONSUMER_ID });
    const caughtUp = await forceRun(fixture.db as never, NOW, { status: "running" });
    await forceProjection(fixture.db as never, NOW, caughtUp, { sequence: 2, projected: 2, ageMs: 90_000, consumerId: FACTORY_RUN_STATUS_CONSUMER_ID });
    // Batch 2 of the lagging run is the oldest unapplied one: 20 s minus 1 ms.
    expect(value(await collect(), "factory_projection_lag_seconds")).toBeCloseTo(19.999, 3);
  });

  test("a validator digest erroring three times in a row, but not one that recovered or ran fewer times", async () => {
    await forceValidatorOutcomes(fixture.db as never, NOW, "1".repeat(64), ["completed", "failed", "uncertain", "failed"]);
    // Three plain failures count too; a streak broken by a completion does not.
    await forceValidatorOutcomes(fixture.db as never, NOW, "5".repeat(64), ["failed", "failed", "failed"]);
    await forceValidatorOutcomes(fixture.db as never, NOW, "6".repeat(64), ["failed", "completed", "failed"]);
    await forceValidatorOutcomes(fixture.db as never, NOW, "2".repeat(64), ["failed", "failed", "completed"]);
    await forceValidatorOutcomes(fixture.db as never, NOW, "3".repeat(64), ["failed", "failed"]);
    // Three failures more than 7 days old are history, not a digest erroring now.
    await forceValidatorOutcomes(fixture.db as never, NOW, "4".repeat(64), ["failed", "failed", "failed"], 8 * 86_400_000);
    expect(value(await collect(), "factory_validator_digests_erroring")).toBe(2);
  });

  test("release operations by state and the oldest uncertain age", async () => {
    await forceRelease(fixture.db as never, NOW, "uncertain", 75_000);
    await forceRelease(fixture.db as never, NOW, "uncertain", 5_000);
    await forceRelease(fixture.db as never, NOW, "succeeded", 900_000);
    const samples = await collect();
    expect(value(samples, "factory_release_operations", { state: "uncertain" })).toBe(2);
    expect(value(samples, "factory_release_operations", { state: "succeeded" })).toBe(1);
    expect(value(samples, "factory_release_uncertain_oldest_age_seconds")).toBe(75);
  });

  test("the newest sealed checkpoint's age", async () => {
    await forceCheckpoint(fixture.db as never, NOW, 1_200_000);
    await forceCheckpoint(fixture.db as never, NOW, 960_000);
    const samples = await collect();
    expect(value(samples, "factory_checkpoint_sealed")).toBe(1);
    expect(value(samples, "factory_checkpoint_verified_age_seconds")).toBe(960);
  });

  test("interpreter builds referenced by unfinished runs that this installation does not run", async () => {
    await forceRun(fixture.db as never, NOW, { status: "waiting", build: "interpreter-old" });
    await forceRun(fixture.db as never, NOW, { status: "queued", build: "interpreter-old" });
    await forceRun(fixture.db as never, NOW, { status: "running", build: "interpreter-older" });
    await forceRun(fixture.db as never, NOW, { status: "succeeded", build: "interpreter-oldest" });
    await forceRun(fixture.db as never, NOW, { status: "running" });
    expect(value(await collect(), "factory_interpreter_builds_unavailable")).toBe(2);
  });

  test("notification sends by state and the oldest queued age", async () => {
    await forceSend(fixture.db as never, NOW, "queued", 400_000);
    await forceSend(fixture.db as never, NOW, "dead_letter", 10_000);
    const samples = await collect();
    expect(value(samples, "factory_notification_sends", { state: "queued" })).toBe(1);
    expect(value(samples, "factory_notification_sends", { state: "dead_letter" })).toBe(1);
    expect(value(samples, "factory_notification_send_oldest_queued_age_seconds")).toBe(400);
  });

  test("counts a security denial in process, by kind", async () => {
    counters.securityDenial("cross_tenant_broker");
    counters.securityDenial("cross_tenant_broker");
    expect(value(await collect(), "factory_security_denials_total", { kind: "cross_tenant_broker" })).toBe(2);
  });

  test("another tenant's rows are never counted, and no identifier reaches the text", async () => {
    await forceReadyWork(fixture.db as never, NOW, 45_000);
    await forceRelease(fixture.db as never, NOW, "uncertain", 75_000);
    const runId = await forceRun(fixture.db as never, NOW, { status: "running", updatedAgeMs: 61_000 });
    const other = await collectFactoryInstallationMetrics({ database: fixture.db as never, tenantId: "another-tenant", interpreterBuild: METRIC_BUILD, now: () => NOW, counters });
    expect(value(other, "factory_ready_work_oldest_age_seconds")).toBe(0);
    expect(value(other, "factory_release_operations", { state: "uncertain" })).toBe(0);
    const text = factoryMetricRenderer("harness", { strict: true, registered: {} }).render(await collect());
    expect(text).not.toContain(runId);
    expect(text).not.toContain(METRIC_TENANT);
  });
});
