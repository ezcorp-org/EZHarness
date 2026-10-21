/**
 * Every C11 alert, its operator action, and the cases that prove it (W4H-34).
 *
 * One source. The self-hosted profile's rule file and the hosted profile's
 * `PrometheusRule` are both rendered from `FACTORY_ALERT_RULES`, and a drift
 * test pins the shipped file to this render, so the two profiles cannot
 * disagree about a threshold. Each rule carries the C11 operator action as an
 * annotation, word for word, so the page an operator reads is the contract.
 *
 * `FACTORY_ALERT_CASES` is how a rule is verified: by forcing its condition
 * in a real evaluator (promtool's rule unit tests, and a live Prometheus over
 * a real installation), never by reading this file. Each rule has a firing
 * case, a quiet case, and a case at its threshold that must stay quiet.
 */
import { stringify } from "yaml";

export const FACTORY_ALERT_GROUP = "factory-c11";
/** The runbook section every alert links to. */
export const FACTORY_ALERT_RUNBOOK = "docs/factory-deployment.md#c11-alerts-and-operator-actions";

export interface FactoryAlertRule {
  readonly alert: string;
  readonly expr: string;
  /** How long the condition must hold before the alert fires. */
  readonly for: string;
  readonly severity: "page" | "ticket";
  /** The C11 condition, as an operator reads it. */
  readonly condition: string;
  /** The C11 operator action, verbatim. */
  readonly action: string;
}

export const FACTORY_ALERT_RULES: readonly FactoryAlertRule[] = Object.freeze([
  {
    alert: "FactoryReadyWorkStalled", for: "0s", severity: "page",
    expr: "factory_ready_work_oldest_age_seconds > 30 or factory_runs_without_progress > 0",
    condition: "Ready work age over 30 seconds or no progress for 60 seconds with no declared wait",
    action: "Inspect blocking resource/lease, queue fairness, and healthy spare capacity; never force-release an uncertain holder",
  },
  {
    alert: "FactoryProjectionLagging", for: "1m", severity: "page",
    expr: "factory_projection_lag_seconds > 10 or factory_projection_gap_runs > 0",
    condition: "Projection gap/lag over 10 seconds for 60 seconds",
    action: "Check audit/outbox consumer, recover missing sequence, rebuild from a verified cursor",
  },
  {
    alert: "FactoryValidatorDigestErroring", for: "0s", severity: "page",
    expr: "factory_validator_digests_erroring > 0",
    condition: "Three consecutive validator errors for one digest",
    action: "Quarantine that evaluator for new acceptance; repair/revalidate explicitly",
  },
  {
    alert: "FactoryUsageUnknownOrBudgetExhausted", for: "0s", severity: "page",
    expr: "factory_usage_unknown_reservations > 0 or factory_budget_exhausted_envelopes > 0",
    condition: "Unknown spend or exhausted budget",
    action: "Stop paid dispatch; reconcile usage or obtain a new explicit allocation within authority",
  },
  {
    alert: "FactoryReleaseUncertain", for: "0s", severity: "page",
    expr: "factory_release_uncertain_oldest_age_seconds > 60",
    condition: "Uncertain release for over 60 seconds",
    action: "Open the operator inbox with the exact request/receipt lookup; do not auto-retry",
  },
  {
    alert: "FactoryRequiredRunnerUnavailable", for: "1m", severity: "page",
    expr: "factory_interpreter_builds_unavailable > 0 or factory_runner_package_not_ready_attempts > 0",
    condition: "Referenced interpreter/package runner unavailable for 60 seconds",
    action: "Restore the pinned compatible deployment or fail/hold affected runs; never route to incompatible code",
  },
  {
    alert: "FactoryCheckpointStale", for: "0s", severity: "page",
    expr: "factory_checkpoint_sealed == 0 or factory_checkpoint_verified_age_seconds > 900",
    condition: "Verified recovery checkpoint older than 15 minutes",
    action: "Stop new external effect claims; repair backup/barrier/archive before enabling them",
  },
  {
    alert: "FactorySecurityDenial", for: "0s", severity: "page",
    expr: "increase(factory_security_denials_total[5m]) > 0",
    condition: "Any denied cross-tenant broker attempt or detected sandbox escape",
    action: "Revoke affected attempt/host credentials, fence the host, investigate and recertify before reuse",
  },
  {
    alert: "FactoryNotificationSendStuck", for: "0s", severity: "ticket",
    // On growth, not on presence: an old dead letter has no acknowledgement path, so the alert resolves by itself
    // 15 minutes after the last new one (F4).
    expr: "delta(factory_notification_sends{state=~\"dead_letter|outcome_unknown\"}[15m]) > 0 or factory_notification_send_oldest_queued_age_seconds > 300",
    condition: "A send entered dead letter or an unknown outcome in the last 15 minutes, or a queued send is older than 5 minutes",
    action: "Inspect the destination and its receiver; never re-drive a destination that does not deduplicate on the idempotency key",
  },
  {
    alert: "FactoryMetricsTargetDown", for: "1m", severity: "page",
    expr: "up{job=~\"factory-.+\"} == 0 or factory_service_ready == 0",
    condition: "A factory service's /metrics cannot be scraped, or the service reports itself not ready",
    action: "Restore the service or its metrics endpoint; until then every alert above is blind for that service",
  },
]);

/** The Prometheus rule file, as an object. */
export function factoryAlertRuleGroups(): { readonly groups: readonly unknown[] } {
  return {
    groups: [{
      name: FACTORY_ALERT_GROUP,
      rules: FACTORY_ALERT_RULES.map((rule) => ({
        alert: rule.alert,
        expr: rule.expr,
        for: rule.for,
        labels: { severity: rule.severity },
        annotations: factoryAlertAnnotations(rule),
      })),
    }],
  };
}

export function factoryAlertAnnotations(rule: FactoryAlertRule): Readonly<Record<string, string>> {
  return { summary: rule.condition, action: rule.action, runbook: FACTORY_ALERT_RUNBOOK };
}

const GENERATED = "# Generated from src/factory/observability/alert-rules.ts (W4H-34, C11). Do not edit; the drift test pins it.\n";

/** The self-hosted profile's rule file. */
export function renderFactoryAlertRuleFile(): string {
  return GENERATED + stringify(factoryAlertRuleGroups(), { lineWidth: 0 });
}

/** The hosted profile's rule resource, for the platform's Prometheus operator. */
export function factoryPrometheusRuleResource(namespace: string, labels: Readonly<Record<string, string>>): Record<string, unknown> {
  return {
    apiVersion: "monitoring.coreos.com/v1",
    kind: "PrometheusRule",
    metadata: { name: "factory-c11-alerts", namespace, labels: { ...labels } },
    spec: factoryAlertRuleGroups(),
  };
}

/** One input series in the evaluator's expanding notation, for example `0+0x8` or `31x8`. */
export interface FactoryAlertSeries {
  readonly series: string;
  readonly values: string;
}

export interface FactoryAlertCase {
  readonly alert: string;
  readonly name: string;
  readonly series: readonly FactoryAlertSeries[];
  readonly evalTime: string;
  /** The labels each firing alert carries, without `alertname` and `severity`; empty means it must not fire. */
  readonly firing: readonly Readonly<Record<string, string>>[];
}

const HARNESS = 'job="factory-harness",instance="harness:9464"';
const harness = (metric: string, values: string, extra = ""): FactoryAlertSeries => ({ series: `${metric}{${HARNESS}${extra}}`, values });
const harnessLabels = { job: "factory-harness", instance: "harness:9464" };

export const FACTORY_ALERT_CASES: readonly FactoryAlertCase[] = Object.freeze([
  { alert: "FactoryReadyWorkStalled", name: "ready work waiting 31 s", series: [harness("factory_ready_work_oldest_age_seconds", "31x8"), harness("factory_runs_without_progress", "0x8")], evalTime: "1m", firing: [harnessLabels] },
  { alert: "FactoryReadyWorkStalled", name: "a run with no progress", series: [harness("factory_ready_work_oldest_age_seconds", "0x8"), harness("factory_runs_without_progress", "1x8")], evalTime: "1m", firing: [harnessLabels] },
  { alert: "FactoryReadyWorkStalled", name: "at the 30 s threshold", series: [harness("factory_ready_work_oldest_age_seconds", "30x8"), harness("factory_runs_without_progress", "0x8")], evalTime: "1m", firing: [] },
  { alert: "FactoryProjectionLagging", name: "lag 11 s held for 2 minutes", series: [harness("factory_projection_lag_seconds", "11x12")], evalTime: "2m", firing: [harnessLabels] },
  { alert: "FactoryProjectionLagging", name: "lag 11 s held for 45 s only", series: [harness("factory_projection_lag_seconds", "11x3")], evalTime: "45s", firing: [] },
  { alert: "FactoryProjectionLagging", name: "at the 10 s threshold", series: [harness("factory_projection_lag_seconds", "10x12")], evalTime: "2m", firing: [] },
  { alert: "FactoryProjectionLagging", name: "a missing batch held for 2 minutes", series: [harness("factory_projection_lag_seconds", "2x12"), harness("factory_projection_gap_runs", "1x12")], evalTime: "2m", firing: [harnessLabels] },
  { alert: "FactoryValidatorDigestErroring", name: "one digest erroring", series: [harness("factory_validator_digests_erroring", "1x8")], evalTime: "1m", firing: [harnessLabels] },
  { alert: "FactoryValidatorDigestErroring", name: "none erroring", series: [harness("factory_validator_digests_erroring", "0x8")], evalTime: "1m", firing: [] },
  { alert: "FactoryUsageUnknownOrBudgetExhausted", name: "unknown usage", series: [harness("factory_usage_unknown_reservations", "1x8"), harness("factory_budget_exhausted_envelopes", "0x8")], evalTime: "1m", firing: [harnessLabels] },
  { alert: "FactoryUsageUnknownOrBudgetExhausted", name: "exhausted budget", series: [harness("factory_usage_unknown_reservations", "0x8"), harness("factory_budget_exhausted_envelopes", "1x8")], evalTime: "1m", firing: [harnessLabels] },
  { alert: "FactoryUsageUnknownOrBudgetExhausted", name: "neither", series: [harness("factory_usage_unknown_reservations", "0x8"), harness("factory_budget_exhausted_envelopes", "0x8")], evalTime: "1m", firing: [] },
  { alert: "FactoryReleaseUncertain", name: "uncertain for 61 s", series: [harness("factory_release_uncertain_oldest_age_seconds", "61x8")], evalTime: "1m", firing: [harnessLabels] },
  { alert: "FactoryReleaseUncertain", name: "at the 60 s threshold", series: [harness("factory_release_uncertain_oldest_age_seconds", "60x8")], evalTime: "1m", firing: [] },
  { alert: "FactoryRequiredRunnerUnavailable", name: "an interpreter build unavailable for 2 minutes", series: [harness("factory_interpreter_builds_unavailable", "1x12"), harness("factory_runner_package_not_ready_attempts", "0x12")], evalTime: "2m", firing: [harnessLabels] },
  { alert: "FactoryRequiredRunnerUnavailable", name: "a package not ready for 2 minutes", series: [harness("factory_interpreter_builds_unavailable", "0x12"), harness("factory_runner_package_not_ready_attempts", "2x12")], evalTime: "2m", firing: [harnessLabels] },
  { alert: "FactoryRequiredRunnerUnavailable", name: "unavailable for 30 s only", series: [harness("factory_interpreter_builds_unavailable", "1x2"), harness("factory_runner_package_not_ready_attempts", "0x2")], evalTime: "30s", firing: [] },
  { alert: "FactoryCheckpointStale", name: "no sealed checkpoint", series: [harness("factory_checkpoint_sealed", "0x8"), harness("factory_checkpoint_verified_age_seconds", "0x8")], evalTime: "1m", firing: [harnessLabels] },
  { alert: "FactoryCheckpointStale", name: "sealed 901 s ago", series: [harness("factory_checkpoint_sealed", "1x8"), harness("factory_checkpoint_verified_age_seconds", "901x8")], evalTime: "1m", firing: [harnessLabels] },
  { alert: "FactoryCheckpointStale", name: "sealed exactly 900 s ago", series: [harness("factory_checkpoint_sealed", "1x8"), harness("factory_checkpoint_verified_age_seconds", "900x8")], evalTime: "1m", firing: [] },
  { alert: "FactorySecurityDenial", name: "one denial counted", series: [harness("factory_security_denials_total", "0 0 0 1 1 1 1 1 1", ',kind="cross_tenant_broker"')], evalTime: "2m", firing: [{ ...harnessLabels, kind: "cross_tenant_broker" }] },
  { alert: "FactorySecurityDenial", name: "no denial", series: [harness("factory_security_denials_total", "0x8", ',kind="cross_tenant_broker"')], evalTime: "2m", firing: [] },
  { alert: "FactoryNotificationSendStuck", name: "a new dead letter", series: [harness("factory_notification_sends", "0 0 0 0 1 1 1 1 1", ',state="dead_letter"'), harness("factory_notification_send_oldest_queued_age_seconds", "0x8")], evalTime: "2m", firing: [{ ...harnessLabels, state: "dead_letter" }] },
  { alert: "FactoryNotificationSendStuck", name: "an old dead letter, none new", series: [harness("factory_notification_sends", "1x80", ',state="dead_letter"'), harness("factory_notification_send_oldest_queued_age_seconds", "0x80")], evalTime: "20m", firing: [] },
  { alert: "FactoryNotificationSendStuck", name: "a send queued 301 s", series: [harness("factory_notification_sends", "0x8", ',state="dead_letter"'), harness("factory_notification_send_oldest_queued_age_seconds", "301x8")], evalTime: "1m", firing: [harnessLabels] },
  { alert: "FactoryNotificationSendStuck", name: "a send queued exactly 300 s, and delivered ones", series: [harness("factory_notification_sends", "5x8", ',state="delivered"'), harness("factory_notification_send_oldest_queued_age_seconds", "300x8")], evalTime: "1m", firing: [] },
  { alert: "FactoryMetricsTargetDown", name: "a target that cannot be scraped", series: [{ series: 'up{job="factory-pool",instance="pool:9465"}', values: "0x12" }], evalTime: "2m", firing: [{ job: "factory-pool", instance: "pool:9465" }] },
  { alert: "FactoryMetricsTargetDown", name: "a service not ready", series: [{ series: 'up{job="factory-gateway",instance="gateway:9466"}', values: "1x12" }, { series: 'factory_service_ready{job="factory-gateway",instance="gateway:9466"}', values: "0x12" }], evalTime: "2m", firing: [{ job: "factory-gateway", instance: "gateway:9466" }] },
  { alert: "FactoryMetricsTargetDown", name: "a target up and ready", series: [{ series: 'up{job="factory-gateway",instance="gateway:9466"}', values: "1x12" }, { series: 'factory_service_ready{job="factory-gateway",instance="gateway:9466"}', values: "1x12" }], evalTime: "2m", firing: [] },
]);

function rule(alert: string): FactoryAlertRule {
  const found = FACTORY_ALERT_RULES.find((candidate) => candidate.alert === alert);
  if (!found) throw new Error(`no factory alert named ${alert}`);
  return found;
}

/** The promtool rule unit tests for `ruleFile`, one test group per case. */
export function renderFactoryAlertUnitTests(ruleFile: string): string {
  return GENERATED + stringify({
    rule_files: [ruleFile],
    evaluation_interval: "15s",
    tests: FACTORY_ALERT_CASES.map((each) => ({
      name: `${each.alert}: ${each.name}`,
      interval: "15s",
      input_series: each.series.map((series) => ({ series: series.series, values: series.values })),
      alert_rule_test: [{
        eval_time: each.evalTime,
        alertname: each.alert,
        exp_alerts: each.firing.map((labels) => ({ exp_labels: { ...labels, severity: rule(each.alert).severity }, exp_annotations: factoryAlertAnnotations(rule(each.alert)) })),
      }],
    })),
  }, { lineWidth: 0 });
}
