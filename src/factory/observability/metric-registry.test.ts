import { describe, expect, test } from "bun:test";
import {
  FACTORY_METRIC_FAMILIES, FACTORY_METRIC_SERIES_MAX, FACTORY_METRIC_SERVICES, FactoryMetricRefusedError,
  factoryMetricFamily, factoryMetricRenderer, type FactoryMetricSample,
} from "./metric-registry";

const UUID_SHAPE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

describe("the metric registry (C11 M1, M2)", () => {
  test("every family is uniquely named, typed, documented, and served by a declared service", () => {
    const names = FACTORY_METRIC_FAMILIES.map((family) => family.name);
    expect(new Set(names).size).toBe(names.length);
    for (const family of FACTORY_METRIC_FAMILIES) {
      expect(family.name).toMatch(/^factory_[a-z0-9_]+$/);
      expect(["gauge", "counter"]).toContain(family.type);
      if (family.type === "counter") expect(family.name).toEndWith("_total");
      expect(family.help.length).toBeGreaterThan(10);
      expect(family.services.length).toBeGreaterThan(0);
      for (const service of family.services) expect(FACTORY_METRIC_SERVICES).toContain(service);
    }
  });

  test("no label can carry an identifier, a digest, a URL or a credential", () => {
    const forbidden = /(^|_)(run|attempt|operation|approval|notification|send|project|reservation|digest|url|token|secret|key|id)(_|$)/;
    for (const family of FACTORY_METRIC_FAMILIES) {
      for (const [label, values] of Object.entries(family.labels)) {
        expect(label).not.toMatch(forbidden);
        if (Array.isArray(values)) {
          expect(values.length).toBeGreaterThan(0);
          for (const value of values) expect(value).toMatch(/^[a-z0-9_-]{1,40}$/);
        } else {
          // A registered label is bounded by a set the service reads per scrape: the pool's tenants.
          expect(values).toBe("tenant");
        }
      }
    }
  });

  test("the tenant label appears only on pool families", () => {
    for (const family of FACTORY_METRIC_FAMILIES) {
      if ("tenant" in family.labels) expect(family.services).toEqual(["pool"]);
    }
  });

  test("every family's worst-case series count is within the bound", () => {
    for (const family of FACTORY_METRIC_FAMILIES) {
      const series = Object.values(family.labels).reduce<number>((product, values) => product * (Array.isArray(values) ? values.length : 100), 1);
      expect(series).toBeLessThanOrEqual(FACTORY_METRIC_SERIES_MAX);
    }
  });

  test("covers each family the plan names", () => {
    const names = new Set(FACTORY_METRIC_FAMILIES.map((family) => family.name));
    for (const name of [
      "factory_ready_work_oldest_age_seconds", "factory_compute_admissions", "factory_runs_without_progress", "factory_attempts",
      "factory_pool_requests", "factory_usage_unknown_reservations", "factory_budget_exhausted_envelopes", "factory_projection_lag_seconds",
      "factory_validator_digests_erroring", "factory_release_operations", "factory_release_uncertain_oldest_age_seconds",
      "factory_checkpoint_sealed", "factory_checkpoint_verified_age_seconds", "factory_interpreter_builds_unavailable",
      "factory_runner_package_not_ready_attempts", "factory_security_denials_total", "factory_notification_sends",
      "factory_notification_send_oldest_queued_age_seconds", "factory_service_ready", "factory_metrics_label_refused_total",
    ]) expect(names.has(name)).toBe(true);
  });
});

describe("the exposition", () => {
  const strict = (service: (typeof FACTORY_METRIC_SERVICES)[number] = "harness", registered = {}) => factoryMetricRenderer(service, { strict: true, registered });

  test("renders HELP, TYPE and one line per sample in the Prometheus text format", () => {
    const text = strict().render([
      { name: "factory_attempts", labels: { state: "launched" }, value: 2 },
      { name: "factory_attempts", labels: { state: "terminal" }, value: 5 },
      { name: "factory_ready_work_oldest_age_seconds", value: 1.5 },
    ]);
    // Families render in registry order, whatever order the samples came in.
    expect(text).toBe([
      `# HELP factory_ready_work_oldest_age_seconds ${factoryMetricFamily("factory_ready_work_oldest_age_seconds").help}`,
      "# TYPE factory_ready_work_oldest_age_seconds gauge",
      "factory_ready_work_oldest_age_seconds 1.5",
      `# HELP factory_attempts ${factoryMetricFamily("factory_attempts").help}`,
      "# TYPE factory_attempts gauge",
      'factory_attempts{state="launched"} 2',
      'factory_attempts{state="terminal"} 5',
      `# HELP factory_metrics_label_refused_total ${factoryMetricFamily("factory_metrics_label_refused_total").help}`,
      "# TYPE factory_metrics_label_refused_total counter",
      "factory_metrics_label_refused_total 0",
      "",
    ].join("\n"));
  });

  test("refuses, in strict mode, a value outside a label's set, an unknown or missing label, an unknown family, another service's family, and a non-finite value", () => {
    const refused: FactoryMetricSample[] = [
      { name: "factory_attempts", labels: { state: "run-7d3f1c2a-0000-4000-8000-000000000001" }, value: 1 },
      { name: "factory_attempts", labels: { state: "launched", run: "x" }, value: 1 },
      { name: "factory_attempts", value: 1 },
      { name: "factory_unknown", value: 1 },
      { name: "factory_pool_requests", labels: { state: "held", resource_class: "cpu" }, value: 1 },
      { name: "factory_ready_work_oldest_age_seconds", value: Number.NaN },
      { name: "factory_ready_work_oldest_age_seconds", value: Number.POSITIVE_INFINITY },
    ];
    for (const sample of refused) expect(() => strict().render([sample])).toThrow(FactoryMetricRefusedError);
  });

  test("a registered label accepts only the values the service declared", () => {
    const pool = strict("pool", { tenant: ["tenant-01", "tenant-02"] });
    expect(pool.render([{ name: "factory_pool_requests", labels: { state: "held", resource_class: "gpu-host" }, value: 1 }])).toContain('resource_class="gpu-host"');
    expect(pool.render([{ name: "factory_pool_tenant_holds", labels: { tenant: "tenant-01" }, value: 1 }])).toContain('factory_pool_tenant_holds{tenant="tenant-01"} 1');
    expect(() => pool.render([{ name: "factory_pool_tenant_holds", labels: { tenant: "tenant-99" }, value: 1 }])).toThrow(FactoryMetricRefusedError);
    expect(() => pool.render([{ name: "factory_pool_requests", labels: { state: "held", resource_class: "tpu" }, value: 1 }])).toThrow(FactoryMetricRefusedError);
    expect(() => pool.render([], { tenant: Array.from({ length: 101 }, (_, index) => `t${index}`) })).toThrow(FactoryMetricRefusedError);
    // Read per scrape: a tenant registered after start is accepted on the next one.
    expect(pool.render([{ name: "factory_pool_tenant_holds", labels: { tenant: "tenant-99" }, value: 1 }], { tenant: ["tenant-99"] })).toContain('tenant="tenant-99"');
    expect(() => factoryMetricRenderer("pool", { strict: false }).render([], { tenant: Array.from({ length: 101 }, (_, index) => `t${index}`) })).toThrow(FactoryMetricRefusedError);
  });

  test("in production a refused series is dropped and counted, never rendered", () => {
    const renderer = factoryMetricRenderer("harness", { strict: false, registered: {} });
    const text = renderer.render([
      { name: "factory_attempts", labels: { state: "7d3f1c2a-0000-4000-8000-000000000001" }, value: 1 },
      { name: "factory_attempts", labels: { state: "launched" }, value: 1 },
    ]);
    expect(text).not.toMatch(UUID_SHAPE);
    expect(text).toContain('factory_attempts{state="launched"} 1');
    expect(text).toContain("factory_metrics_label_refused_total 1");
    expect(renderer.render([])).toContain("factory_metrics_label_refused_total 1");
  });

  test("a label value is escaped as the text format requires", () => {
    const renderer = factoryMetricRenderer("pool", { strict: true, registered: { tenant: ['a"b\\c'] } });
    expect(renderer.render([{ name: "factory_pool_tenant_holds", labels: { tenant: 'a"b\\c' }, value: 1 }])).toContain('factory_pool_tenant_holds{tenant="a\\"b\\\\c"} 1');
  });

  test("a render of 1,024 series builds each family's allowed set once per label (F10)", () => {
    const requests = factoryMetricFamily("factory_pool_requests");
    const [state, resourceClass] = [requests.labels.state as readonly string[], requests.labels.resource_class as readonly string[]];
    const tenants = Array.from({ length: 100 }, (_, index) => `tenant-${index}`);
    const samples: FactoryMetricSample[] = Array.from({ length: 1_024 }, (_, index): FactoryMetricSample => index % 2 === 0
      ? { name: "factory_pool_tenant_holds", labels: { tenant: tenants[index % tenants.length]! }, value: index }
      : { name: "factory_pool_requests", labels: { state: state[index % state.length]!, resource_class: resourceClass[index % resourceClass.length]! }, value: index });
    const renderer = factoryMetricRenderer("pool", { strict: true, registered: { tenant: tenants } });
    const NativeSet = globalThis.Set;
    let built = 0;
    globalThis.Set = class extends NativeSet<unknown> { constructor(values?: Iterable<unknown> | null) { super(values); built += 1; } } as SetConstructor;
    let text: string;
    try { text = renderer.render(samples); }
    finally { globalThis.Set = NativeSet; }
    // One set for the holds' tenant label, two for the requests' state and resource class.
    expect(built).toBe(3);
    expect(text.split("\n").filter((each) => each.startsWith("factory_pool_")).length).toBe(1_024);
  });

  test("an unknown family name has no definition", () => {
    expect(() => factoryMetricFamily("factory_unknown")).toThrow(FactoryMetricRefusedError);
  });
});
