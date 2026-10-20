import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import {
  FACTORY_ALERT_CASES, FACTORY_ALERT_GROUP, FACTORY_ALERT_RULES, FACTORY_HOST_METRIC_SERVICES, FACTORY_HOST_SCOPED_ALERT_RULES, factoryAlertRuleGroups, factoryPrometheusRuleResource,
  renderFactoryAlertRuleFile, renderFactoryAlertUnitTests,
} from "./alert-rules";
import { FACTORY_METRIC_FAMILIES } from "./metric-registry";

const ROOT = join(import.meta.dir, "..", "..", "..");
const CONTRACTS = readFileSync(join(ROOT, "docs/plans/2026-09-12-composable-factory-platform-contracts.md"), "utf8");

describe("the C11 alert rules (W4H-34)", () => {
  test("every C11 alert row has exactly one rule, whose condition and action are the contract's words", () => {
    const table = CONTRACTS.slice(CONTRACTS.indexOf("| Alert condition | Required operator action |"));
    const lines = table.split("\n").slice(2);
    const rows = lines.slice(0, lines.indexOf("")).map((line) => line.split("|").map((cell) => cell.trim()).filter(Boolean));
    expect(rows).toHaveLength(8);
    for (const [condition, action] of rows as Array<[string, string]>) {
      const matching = FACTORY_ALERT_RULES.filter((rule) => rule.condition === condition);
      expect(matching).toHaveLength(1);
      expect(matching[0]!.action).toBe(action);
    }
    // And every shipped rule is named in the contract's own rule table.
    for (const rule of FACTORY_ALERT_RULES) expect(CONTRACTS).toContain(`| \`${rule.alert}\` |`);
  });

  // C11 scope (W4H-35, w4h-34's conditions 1 and 2): one source, the rule's own `scope`; the host-scoped list is derived from it.
  test("the host-scoped list is derived from each rule's scope, and today names only FactoryServiceRoleHeld (W4H-35)", () => {
    expect([...FACTORY_HOST_SCOPED_ALERT_RULES]).toEqual(FACTORY_ALERT_RULES.filter((rule) => rule.scope === "host").map((rule) => rule.alert));
    expect([...FACTORY_HOST_SCOPED_ALERT_RULES]).toEqual(["FactoryServiceRoleHeld"]);
    for (const rule of FACTORY_ALERT_RULES) expect(["host", "installation"]).toContain(rule.scope);
  });

  // The guard: a rule cannot move to host scope to drop its tenant assertion. A host-scoped rule reads only families whose registry
  // services are host services; every other rule reads none of them.
  test("a host-scoped rule reads only host-service families, and an installation rule reads none of them (W4H-35)", () => {
    const families = (expr: string) => FACTORY_METRIC_FAMILIES.filter((family) => new RegExp(`\\b${family.name}\\b`).test(expr));
    const hostOnly = (family: (typeof FACTORY_METRIC_FAMILIES)[number]) => family.services.every((service) => FACTORY_HOST_METRIC_SERVICES.includes(service));
    expect([...FACTORY_HOST_METRIC_SERVICES]).toEqual(["supervisor"]);
    for (const rule of FACTORY_ALERT_RULES) {
      const read = families(rule.expr);
      if (rule.scope === "host") {
        expect(read.length).toBeGreaterThan(0);
        expect(read.filter((family) => !hostOnly(family)).map((family) => family.name)).toEqual([]);
      } else {
        expect(read.filter(hostOnly).map((family) => family.name)).toEqual([]);
      }
    }
  });

  test("the runbook each alert links to exists and lists every alert with its action", () => {
    const runbook = readFileSync(join(ROOT, "docs/factory-deployment.md"), "utf8");
    expect(runbook).toContain("\n## C11 alerts and operator actions\n");
    for (const rule of FACTORY_ALERT_RULES) expect(runbook).toContain(`| \`${rule.alert}\` | ${rule.condition} | ${rule.action} |`);
  });

  test("a stuck send alerts on a new dead letter and resolves by itself; an old one stays quiet (F4)", () => {
    const rule = FACTORY_ALERT_RULES.find((candidate) => candidate.alert === "FactoryNotificationSendStuck")!;
    expect(rule.expr).toContain("delta(factory_notification_sends{state=~\"dead_letter|outcome_unknown\"}[15m]) > 0");
    const cases = FACTORY_ALERT_CASES.filter((each) => each.alert === rule.alert);
    expect(cases.find((each) => each.name === "an old dead letter, none new")?.firing).toEqual([]);
    expect(cases.find((each) => each.name === "a new dead letter")?.firing.length).toBe(1);
  });

  test("a projection gap alerts even when the lag reads low (F6)", () => {
    const rule = FACTORY_ALERT_RULES.find((candidate) => candidate.alert === "FactoryProjectionLagging")!;
    expect(rule.expr).toBe("factory_projection_lag_seconds > 10 or factory_projection_gap_runs > 0");
    expect(FACTORY_ALERT_CASES.find((each) => each.alert === rule.alert && each.name === "a missing batch held for 2 minutes")?.firing.length).toBe(1);
  });

  test("names are unique and every expression reads only registered families", () => {
    const names = FACTORY_ALERT_RULES.map((rule) => rule.alert);
    expect(new Set(names).size).toBe(names.length);
    const families = new Set(FACTORY_METRIC_FAMILIES.map((family) => family.name));
    for (const rule of FACTORY_ALERT_RULES) {
      const metrics = [...rule.expr.matchAll(/\b(factory_[a-z0-9_]+|up)\b/g)].map((match) => match[1]!);
      expect(metrics.length).toBeGreaterThan(0);
      for (const metric of metrics) if (metric !== "up") expect(families.has(metric)).toBe(true);
    }
  });

  test("every rule has a forced firing case and a quiet case, and every case names a rule", () => {
    for (const rule of FACTORY_ALERT_RULES) {
      const cases = FACTORY_ALERT_CASES.filter((each) => each.alert === rule.alert);
      expect(cases.some((each) => each.firing.length > 0)).toBe(true);
      expect(cases.some((each) => each.firing.length === 0)).toBe(true);
    }
    for (const each of FACTORY_ALERT_CASES) expect(FACTORY_ALERT_RULES.map((rule) => rule.alert)).toContain(each.alert);
  });

  test("the rule file is one group carrying each rule's severity and annotations", () => {
    const parsed = parse(renderFactoryAlertRuleFile()) as { groups: Array<{ name: string; rules: Array<{ alert: string; labels: Record<string, string>; annotations: Record<string, string> }> }> };
    expect(parsed).toEqual(factoryAlertRuleGroups() as never);
    expect(parsed.groups.map((group) => group.name)).toEqual([FACTORY_ALERT_GROUP]);
    for (const rendered of parsed.groups[0]!.rules) {
      expect(["page", "ticket"]).toContain(rendered.labels.severity!);
      expect(rendered.annotations.runbook).toBe("docs/factory-deployment.md#c11-alerts-and-operator-actions");
    }
  });

  test("the hosted resource carries the same groups", () => {
    const resource = factoryPrometheusRuleResource("factory-system", { "app.kubernetes.io/part-of": "ezcorp-factory" });
    expect(resource).toMatchObject({ apiVersion: "monitoring.coreos.com/v1", kind: "PrometheusRule", metadata: { name: "factory-c11-alerts", namespace: "factory-system" } });
    expect(resource.spec).toEqual(factoryAlertRuleGroups());
  });

  test("the unit tests expect each firing case's labels and annotations, and nothing for a quiet one", () => {
    const parsed = parse(renderFactoryAlertUnitTests("factory-alerts.yml")) as { rule_files: string[]; tests: Array<{ alert_rule_test: Array<{ alertname: string; exp_alerts: Array<{ exp_labels: Record<string, string> }> }> }> };
    expect(parsed.rule_files).toEqual(["factory-alerts.yml"]);
    expect(parsed.tests).toHaveLength(FACTORY_ALERT_CASES.length);
    const firing = parsed.tests.find((each) => each.alert_rule_test[0]!.alertname === "FactorySecurityDenial" && each.alert_rule_test[0]!.exp_alerts.length > 0)!;
    expect(firing.alert_rule_test[0]!.exp_alerts[0]!.exp_labels).toEqual({ job: "factory-harness", instance: "harness:9464", kind: "cross_tenant_broker", severity: "page" });
    expect(() => renderFactoryAlertUnitTests.call(null, "x")).not.toThrow();
  });

  test("the shipped self-hosted files are exactly the render", () => {
    expect(readFileSync(join(ROOT, "deploy/factory/prometheus/factory-alerts.yml"), "utf8")).toBe(renderFactoryAlertRuleFile());
    expect(readFileSync(join(ROOT, "deploy/factory/prometheus/factory-alerts.test.yml"), "utf8")).toBe(renderFactoryAlertUnitTests("factory-alerts.yml"));
  });
});
