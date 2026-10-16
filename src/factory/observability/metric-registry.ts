/**
 * Every factory metric, declared once (C11 M1, M2; W4H-34).
 *
 * A family names its type, its help text, the services that serve it, and a
 * CLOSED value set for each label. A value outside the set is never rendered:
 * a test fails on it, and production drops the series and counts it in
 * `factory_metrics_label_refused_total`. That is the whole cardinality
 * defence, and it is why no label below can hold a run, attempt, operation,
 * approval or notification identifier, a digest, a URL, or a credential.
 *
 * One label is bounded by a set the service reads at each scrape rather than
 * by a literal here: `tenant`, only on pool families, from the pool's
 * registered tenants, at most 100 (the C12 plan limit).
 */
import { DELIVERY_STATES } from "../../delivery-queue/delivery-states.ts";
import { POOL_LEASE_STATES, POOL_RESOURCE_CLASSES } from "../pool/pool-states.ts";
import type { FactoryReleaseState } from "../releases.ts";
import type { FactoryAttemptLaunchState } from "../runner/attempt-wire.ts";

export const FACTORY_METRIC_SERVICES = Object.freeze(["harness", "pool", "gateway", "orchestrator", "supervisor"] as const);
export type FactoryMetricService = (typeof FACTORY_METRIC_SERVICES)[number];

/** The most series one family may render. */
export const FACTORY_METRIC_SERIES_MAX = 1_024;
/** Bounds on the registered sets, so a registered label is bounded too. */
const REGISTERED_MAX = Object.freeze({ tenant: 100 });
export type FactoryRegisteredLabel = keyof typeof REGISTERED_MAX;

export interface FactoryMetricFamily {
  readonly name: string;
  readonly type: "gauge" | "counter";
  readonly help: string;
  readonly services: readonly FactoryMetricService[];
  readonly labels: Readonly<Record<string, readonly string[] | FactoryRegisteredLabel>>;
}

export interface FactoryMetricSample {
  readonly name: string;
  readonly labels?: Readonly<Record<string, string>>;
  readonly value: number;
}

// Fields, not parameter properties: the Node orchestrator loads this file with type stripping only.
export class FactoryMetricRefusedError extends Error {
  readonly code = "factory_metric_refused";
  readonly metric: string;
  constructor(metric: string, reason: string) {
    super(`Factory metric '${metric}' refused: ${reason}.`);
    this.name = "FactoryMetricRefusedError";
    this.metric = metric;
  }
}

/** A state list that must name every member of its union, so a new state cannot go unlabelled. */
function states<State extends string>() {
  return <const Listed extends readonly State[]>(listed: Listed & ([Exclude<State, Listed[number]>] extends [never] ? unknown : never)): Listed => listed;
}

const ATTEMPT_STATES = states<FactoryAttemptLaunchState>()(["prepared", "launching", "launched", "terminal", "uncertain"]);
const RELEASE_STATES = states<FactoryReleaseState>()(["pending", "executing", "succeeded", "failed", "uncertain"]);
// The CHECK constraint of factory_compute_admissions; the collector test reads every one back.
const ADMISSION_STATES = ["pending", "queued", "admitted", "rejected", "cancelling", "cancelled"] as const;

const INSTALLATION: readonly FactoryMetricService[] = ["harness"];

export const FACTORY_METRIC_FAMILIES: readonly FactoryMetricFamily[] = Object.freeze<FactoryMetricFamily[]>([
  { name: "factory_ready_work_oldest_age_seconds", type: "gauge", services: INSTALLATION, labels: {},
    help: "Age of the oldest ready attempt waiting in the dispatch queue, 0 when none waits." },
  { name: "factory_compute_admissions", type: "gauge", services: INSTALLATION, labels: { state: ADMISSION_STATES },
    help: "Compute admission reservations by state." },
  { name: "factory_runs_without_progress", type: "gauge", services: INSTALLATION, labels: {},
    help: "Running runs with no declared wait and no recorded progress for 60 seconds." },
  { name: "factory_attempts", type: "gauge", services: INSTALLATION, labels: { state: ATTEMPT_STATES },
    help: "Attempt launches by state." },
  { name: "factory_usage_unknown_reservations", type: "gauge", services: INSTALLATION, labels: {},
    help: "Budget reservations whose usage is unknown and not yet reconciled." },
  { name: "factory_budget_exhausted_envelopes", type: "gauge", services: INSTALLATION, labels: {},
    help: "Open budget envelopes whose admission is blocked because the budget is exhausted." },
  { name: "factory_projection_lag_seconds", type: "gauge", services: INSTALLATION, labels: {},
    help: "Age of the oldest audit batch the run projector has not applied, 0 when none." },
  { name: "factory_validator_digests_erroring", type: "gauge", services: INSTALLATION, labels: {},
    help: "Validator runner digests whose last three validator attempts all failed or ended uncertain." },
  { name: "factory_release_operations", type: "gauge", services: INSTALLATION, labels: { state: RELEASE_STATES },
    help: "Release operations by state." },
  { name: "factory_release_uncertain_oldest_age_seconds", type: "gauge", services: INSTALLATION, labels: {},
    help: "Age of the oldest uncertain release operation, 0 when none." },
  { name: "factory_checkpoint_sealed", type: "gauge", services: INSTALLATION, labels: {},
    help: "1 when a sealed recovery checkpoint exists, else 0." },
  { name: "factory_checkpoint_verified_age_seconds", type: "gauge", services: INSTALLATION, labels: {},
    help: "Age of the newest sealed recovery checkpoint, 0 when none exists (see factory_checkpoint_sealed)." },
  { name: "factory_interpreter_builds_unavailable", type: "gauge", services: INSTALLATION, labels: {},
    help: "Interpreter builds referenced by unfinished runs that this installation does not run." },
  { name: "factory_runner_package_not_ready_attempts", type: "gauge", services: INSTALLATION, labels: {},
    help: "Ready attempts held because their runner package is not prepared." },
  { name: "factory_security_denials_total", type: "counter", services: INSTALLATION, labels: { kind: ["cross_tenant_broker"] },
    help: "Guest broker requests refused because the token or host belongs to another tenant or attempt." },
  { name: "factory_notification_sends", type: "gauge", services: INSTALLATION, labels: { state: DELIVERY_STATES },
    help: "Outbound notification sends by state." },
  { name: "factory_notification_send_oldest_queued_age_seconds", type: "gauge", services: INSTALLATION, labels: {},
    help: "Age of the oldest queued outbound notification send, 0 when none." },
  { name: "factory_pool_requests", type: "gauge", services: ["pool"], labels: { state: POOL_LEASE_STATES, resource_class: POOL_RESOURCE_CLASSES },
    help: "Pool reservation requests by state and resource class." },
  { name: "factory_pool_tenant_holds", type: "gauge", services: ["pool"], labels: { tenant: "tenant" },
    help: "Pool reservations holding or running capacity, by registered tenant." },
  { name: "factory_service_ready", type: "gauge", services: ["gateway", "orchestrator", "supervisor"], labels: {},
    help: "1 when the service reports itself ready, else 0." },
  { name: "factory_metrics_label_refused_total", type: "counter", services: FACTORY_METRIC_SERVICES, labels: {},
    help: "Series this service dropped because a label value was outside its declared set." },
]);

const BY_NAME: ReadonlyMap<string, FactoryMetricFamily> = new Map(FACTORY_METRIC_FAMILIES.map((family) => [family.name, family]));

export function factoryMetricFamily(name: string): FactoryMetricFamily {
  const family = BY_NAME.get(name);
  if (!family) throw new FactoryMetricRefusedError(name, "no such family");
  return family;
}

function escapeLabelValue(value: string): string {
  return value.replaceAll("\\", "\\\\").replaceAll("\"", "\\\"").replaceAll("\n", "\\n");
}

export type FactoryRegisteredValues = Partial<Readonly<Record<FactoryRegisteredLabel, readonly string[]>>>;

export interface FactoryMetricRenderer {
  /**
   * One scrape's text. Families render in registry order; the refusal counter
   * always renders. `registered` is read per scrape, because the pool's tenants
   * change while it runs.
   */
  render(samples: readonly FactoryMetricSample[], registered?: FactoryRegisteredValues): string;
}

/**
 * The exposition for one service. `strict` throws on a refused series (tests);
 * otherwise it is dropped and counted for the life of the process.
 */
export function factoryMetricRenderer(
  service: FactoryMetricService,
  options: { readonly strict: boolean; readonly registered?: FactoryRegisteredValues },
): FactoryMetricRenderer {
  let refusedTotal = 0;
  const line = (sample: FactoryMetricSample, registered: FactoryRegisteredValues): { family: FactoryMetricFamily; text: string } => {
    const allowed = (family: FactoryMetricFamily, label: string): ReadonlySet<string> => {
      const values = family.labels[label]!;
      return new Set(Array.isArray(values) ? values : registered[values as FactoryRegisteredLabel] ?? []);
    };
    const family = factoryMetricFamily(sample.name);
    if (!family.services.includes(service)) throw new FactoryMetricRefusedError(sample.name, `not served by ${service}`);
    if (!Number.isFinite(sample.value)) throw new FactoryMetricRefusedError(sample.name, "value is not finite");
    const labels = sample.labels ?? {};
    const declared = Object.keys(family.labels);
    if (Object.keys(labels).length !== declared.length || declared.some((label) => !(label in labels))) throw new FactoryMetricRefusedError(sample.name, "labels do not match the family");
    for (const label of declared) {
      if (!allowed(family, label).has(labels[label]!)) throw new FactoryMetricRefusedError(sample.name, `value outside the set of '${label}'`);
    }
    const rendered = declared.map((label) => `${label}="${escapeLabelValue(labels[label]!)}"`).join(",");
    return { family, text: `${sample.name}${rendered === "" ? "" : `{${rendered}}`} ${sample.value}` };
  };
  return {
    render(samples, registered = options.registered ?? {}) {
      // A registered set past its bound is a fault of the whole scrape, not of one series.
      for (const [label, values] of Object.entries(registered) as Array<[FactoryRegisteredLabel, readonly string[]]>) {
        if (values.length > REGISTERED_MAX[label]) throw new FactoryMetricRefusedError(label, `more than ${REGISTERED_MAX[label]} registered values`);
      }
      const lines = new Map<FactoryMetricFamily, string[]>();
      for (const sample of samples) {
        let rendered: { family: FactoryMetricFamily; text: string };
        try {
          rendered = line(sample, registered);
        } catch (error) {
          if (options.strict) throw error;
          refusedTotal += 1;
          continue;
        }
        lines.set(rendered.family, [...(lines.get(rendered.family) ?? []), rendered.text]);
      }
      const refused = factoryMetricFamily("factory_metrics_label_refused_total");
      lines.set(refused, [`${refused.name} ${refusedTotal}`]);
      const out: string[] = [];
      for (const family of FACTORY_METRIC_FAMILIES) {
        const body = lines.get(family);
        if (!body) continue;
        out.push(`# HELP ${family.name} ${family.help}`, `# TYPE ${family.name} ${family.type}`, ...body);
      }
      return `${out.join("\n")}\n`;
    },
  };
}
