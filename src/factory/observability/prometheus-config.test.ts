import { describe, expect, test } from "bun:test";
import { parse } from "yaml";
import { FACTORY_ALERT_RULES } from "./alert-rules";
import { FACTORY_METRIC_SERVICES } from "./metric-registry";
import { FACTORY_PROMETHEUS_JOBS, factoryPrometheusTargetFiles, renderFactoryPrometheusConfig } from "./prometheus-config";

describe("the self-hosted evaluator's configuration (C11 A1-A10)", () => {
  test("one job per factory service, each scraping with the bearer token file from its own target list", () => {
    const config = parse(renderFactoryPrometheusConfig({ ruleFile: "/rules/factory-alerts.yml", tokenFile: "/etc/prometheus/scrape-token", targetsDirectory: "/etc/prometheus/targets" })) as {
      global: Record<string, string>; rule_files: string[];
      scrape_configs: Array<{ job_name: string; authorization: { credentials_file: string }; file_sd_configs: Array<{ files: string[] }> }>;
    };
    expect(config.global).toEqual({ scrape_interval: "15s", evaluation_interval: "15s" });
    expect(config.rule_files).toEqual(["/rules/factory-alerts.yml"]);
    expect(config.scrape_configs.map((job) => job.job_name)).toEqual(FACTORY_METRIC_SERVICES.map((service) => `factory-${service}`));
    expect(FACTORY_PROMETHEUS_JOBS).toEqual(config.scrape_configs.map((job) => job.job_name) as never);
    for (const job of config.scrape_configs) {
      expect(job.authorization).toEqual({ credentials_file: "/etc/prometheus/scrape-token" });
      expect(job.file_sd_configs).toEqual([{ files: [`/etc/prometheus/targets/${job.job_name}.json`] }]);
    }
    // The target-down rule watches exactly these job names.
    expect(FACTORY_ALERT_RULES.find((rule) => rule.alert === "FactoryMetricsTargetDown")!.expr).toContain('job=~"factory-.+"');
  });

  test("intervals may be shortened for a proof, never left unset", () => {
    const config = parse(renderFactoryPrometheusConfig({ ruleFile: "r", tokenFile: "t", targetsDirectory: "d", scrapeInterval: "1s", evaluationInterval: "1s" })) as { global: Record<string, string> };
    expect(config.global).toEqual({ scrape_interval: "1s", evaluation_interval: "1s" });
  });

  test("every job gets a target file, empty when nothing serves it, each target labelled with its installation", () => {
    const files = factoryPrometheusTargetFiles([
      { service: "harness", address: "127.0.0.1:40014", tenant: "tenant-01" },
      { service: "harness", address: "127.0.0.1:40024", tenant: "tenant-02" },
      { service: "pool", address: "127.0.0.1:41004" },
    ]);
    expect(Object.keys(files).sort()).toEqual(FACTORY_PROMETHEUS_JOBS.map((job) => `${job}.json`).sort());
    expect(JSON.parse(files["factory-harness.json"]!)).toEqual([
      { targets: ["127.0.0.1:40014"], labels: { tenant: "tenant-01" } },
      { targets: ["127.0.0.1:40024"], labels: { tenant: "tenant-02" } },
    ]);
    expect(JSON.parse(files["factory-pool.json"]!)).toEqual([{ targets: ["127.0.0.1:41004"], labels: {} }]);
    expect(JSON.parse(files["factory-gateway.json"]!)).toEqual([]);
  });
});
