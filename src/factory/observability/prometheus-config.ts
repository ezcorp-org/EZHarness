/**
 * The self-hosted evaluator's configuration (C11, W4H-34).
 *
 * One scrape job per factory service, named `factory-<service>`, which is what
 * `FactoryMetricsTargetDown` watches. Targets come from one file per job, so
 * the fleet host rewrites a list when it admits or releases an installation and
 * Prometheus picks it up without a restart. Every job presents the fleet's
 * scrape token from a file; the token never appears in this configuration.
 */
import { stringify } from "yaml";
import { FACTORY_METRIC_SERVICES, type FactoryMetricService } from "./metric-registry";

export const FACTORY_PROMETHEUS_JOBS = Object.freeze(FACTORY_METRIC_SERVICES.map((service) => `factory-${service}`));

/** Where the self-hosted evaluator container mounts its config directory and the shipped rule directory. */
export const FACTORY_PROMETHEUS_CONTAINER_CONFIG = "/etc/ezcorp-prometheus";
export const FACTORY_PROMETHEUS_CONTAINER_RULES = "/etc/ezcorp-prometheus-rules";

export interface FactoryPrometheusConfigOptions {
  readonly ruleFile: string;
  readonly tokenFile: string;
  readonly targetsDirectory: string;
  readonly scrapeInterval?: string;
  readonly evaluationInterval?: string;
}

export function renderFactoryPrometheusConfig(options: FactoryPrometheusConfigOptions): string {
  return stringify({
    global: { scrape_interval: options.scrapeInterval ?? "15s", evaluation_interval: options.evaluationInterval ?? "15s" },
    rule_files: [options.ruleFile],
    scrape_configs: FACTORY_PROMETHEUS_JOBS.map((job) => ({
      job_name: job,
      authorization: { credentials_file: options.tokenFile },
      file_sd_configs: [{ files: [`${options.targetsDirectory}/${job}.json`] }],
    })),
  }, { lineWidth: 0 });
}

export interface FactoryPrometheusTarget {
  readonly service: FactoryMetricService;
  /** `host:port` as the evaluator reaches it. */
  readonly address: string;
  /** The installation a target belongs to; absent for the fleet host's shared services. */
  readonly tenant?: string;
}

/** One file-discovery list per job, by file name; a job nothing serves gets an empty list. */
export function factoryPrometheusTargetFiles(targets: readonly FactoryPrometheusTarget[]): Readonly<Record<string, string>> {
  return Object.fromEntries(FACTORY_METRIC_SERVICES.map((service) => [
    `factory-${service}.json`,
    `${JSON.stringify(targets.filter((target) => target.service === service).map((target) => ({ targets: [target.address], labels: target.tenant === undefined ? {} : { tenant: target.tenant } })), null, 2)}\n`,
  ]));
}
