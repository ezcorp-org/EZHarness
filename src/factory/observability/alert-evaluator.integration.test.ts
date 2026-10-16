/**
 * Every C11 alert, verified by forcing its condition in a real evaluator (W4H-34).
 *
 * Bound to the `Factory deployment and operations` lane (scripts/check-factory-lanes.ts):
 * it needs Podman, the pinned Prometheus image (scripts/test-images.json) and a
 * real PostgreSQL. It never skips: a missing precondition fails by name.
 *
 * 1. promtool, the evaluator Prometheus ships, runs the shipped rule unit tests:
 *    each rule's firing case, quiet case and threshold edge.
 * 2. For each rule, the same tests against a rule file whose condition is
 *    inverted must fail, so the cases really constrain the rule.
 * 3. A live Prometheus scrapes a real installation metrics listener over a real
 *    database. With the database quiet nothing fires; with every condition
 *    forced, every alert fires with its C11 action.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { setupFactoryPostgres } from "../../../tests/postgres/helpers/factory-test-database";
import {
  METRIC_BUILD, METRIC_TENANT, forceBudget, forceCheckpoint, forceProjection, forceReadyWork, forceRelease, forceRun, forceSend,
  forceValidatorOutcomes, seedMetricInstallation,
} from "../../__tests__/helpers/factory-metric-conditions";
import { FACTORY_RUN_STATUS_CONSUMER_ID } from "../run-transition-projector";
import { FACTORY_ALERT_RULES, factoryAlertAnnotations, renderFactoryAlertRuleFile } from "./alert-rules";
import { FactoryMetricCounters, collectFactoryInstallationMetrics } from "./installation-metrics";
import { serveFactoryMetrics, serveFactoryReadyMetrics, type FactoryMetricsListener } from "./metrics-listener";
import { factoryPrometheusTargetFiles, renderFactoryPrometheusConfig } from "./prometheus-config";

const ROOT = join(import.meta.dir, "..", "..", "..");
const RULES_DIR = join(ROOT, "deploy/factory/prometheus");
const IMAGE = (JSON.parse(await readFile(join(ROOT, "scripts/test-images.json"), "utf8")) as { prometheus?: string }).prometheus;

async function podman(args: readonly string[]): Promise<{ code: number; out: string }> {
  const child = Bun.spawn(["podman", ...args], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { code: await child.exited, out: out + err };
}

/** As the host's own user, as the self-hosted evaluator runs (keep-id), so private files are readable. */
const AS_HOST_USER = ["--userns=keep-id", "--user", `${process.getuid!()}:${process.getgid!()}`] as const;

function promtool(directory: string, args: readonly string[]): Promise<{ code: number; out: string }> {
  return podman(["run", "--rm", "--network=none", ...AS_HOST_USER, "-v", `${directory}:/rules:ro,Z`, "--entrypoint", "/bin/promtool", IMAGE!, ...args]);
}

beforeAll(() => {
  // A precondition is named, never skipped.
  if (!IMAGE || !/^docker\.io\/prom\/prometheus@sha256:[a-f0-9]{64}$/.test(IMAGE)) throw new Error("scripts/test-images.json has no pinned prometheus image");
});

describe("promtool evaluates every forced case (C11 A1-A10)", () => {
  test("the shipped rule file is valid and every case passes", async () => {
    expect(await promtool(RULES_DIR, ["check", "rules", "/rules/factory-alerts.yml"])).toMatchObject({ code: 0 });
    const tested = await promtool(RULES_DIR, ["test", "rules", "/rules/factory-alerts.test.yml"]);
    expect(tested.out).toContain("SUCCESS");
    expect(tested.code).toBe(0);
  }, 120_000);

  test("inverting any one rule's condition makes its cases fail", async () => {
    const shipped = await readFile(join(RULES_DIR, "factory-alerts.yml"), "utf8");
    const tests = await readFile(join(RULES_DIR, "factory-alerts.test.yml"), "utf8");
    for (const rule of FACTORY_ALERT_RULES) {
      const directory = await mkdtemp(join(tmpdir(), "w4h-34-mutant-"));
      try {
        await chmod(directory, 0o755);
        // `unless` keeps the expression's labels and inverts which series survive.
        const mutant = shipped.replace(`expr: ${rule.expr}`, `expr: vector(1) unless (${rule.expr})`);
        expect(mutant).not.toBe(shipped);
        await writeFile(join(directory, "factory-alerts.yml"), mutant);
        await writeFile(join(directory, "factory-alerts.test.yml"), tests);
        const result = await promtool(directory, ["test", "rules", "/rules/factory-alerts.test.yml"]);
        expect({ rule: rule.alert, code: result.code }).toEqual({ rule: rule.alert, code: 1 });
        expect(result.out).toContain(rule.alert);
      } finally { await rm(directory, { recursive: true, force: true }); }
    }
  }, 600_000);
});

describe("a live Prometheus over a real installation (C11 A1-A10)", () => {
  type Fixture = Awaited<ReturnType<typeof setupFactoryPostgres>>;
  let fixture: Fixture;
  let directory: string;
  let harness: FactoryMetricsListener;
  let gateway: FactoryMetricsListener | undefined;
  const counters = new FactoryMetricCounters();
  const container = `w4h-34-prometheus-${randomBytes(4).toString("hex")}`;
  let api = "";

  async function alerts(): Promise<Array<{ labels: Record<string, string>; annotations: Record<string, string>; state: string }>> {
    const body = await (await fetch(`${api}/api/v1/alerts`)).json() as { data: { alerts: Array<{ labels: Record<string, string>; annotations: Record<string, string>; state: string }> } };
    return body.data.alerts;
  }

  beforeAll(async () => {
    fixture = await setupFactoryPostgres();
    await seedMetricInstallation(fixture.db as never);
    // An old dead letter, present before the first scrape: the stuck-send alert fires on a new one only (F4).
    await forceSend(fixture.db as never, Date.now(), "dead_letter", 3_600_000);
    directory = await mkdtemp(join(tmpdir(), "w4h-34-prometheus-"));
    await chmod(directory, 0o755);
    const token = randomBytes(24).toString("hex");
    const tokenPath = join(directory, "token");
    await writeFile(tokenPath, token, { mode: 0o644 });
    const privateToken = join(await mkdtemp(join(process.env.XDG_RUNTIME_DIR ?? tmpdir(), "w4h-34-token-")), "token");
    await writeFile(privateToken, token, { mode: 0o600 });
    harness = await serveFactoryMetrics({ hostname: "127.0.0.1", port: await freePort(), scrapeTokenPath: privateToken }, "harness",
      () => collectFactoryInstallationMetrics({ database: fixture.db as never, tenantId: METRIC_TENANT, interpreterBuild: METRIC_BUILD, counters }));
    gateway = await serveFactoryReadyMetrics({ hostname: "127.0.0.1", port: await freePort(), scrapeTokenPath: privateToken }, "gateway", () => true);
    const target = (url: string) => url.replace("http://", "");
    // The self-hosted profile's own config and target lists, only with one-second intervals.
    await writeFile(join(directory, "factory-alerts.yml"), renderFactoryAlertRuleFile());
    await writeFile(join(directory, "prometheus.yml"), renderFactoryPrometheusConfig({
      ruleFile: "/etc/prometheus/factory-alerts.yml", tokenFile: "/etc/prometheus/token", targetsDirectory: "/etc/prometheus/targets", scrapeInterval: "1s", evaluationInterval: "1s",
    }));
    await mkdir(join(directory, "targets"), { mode: 0o755 });
    await chmod(join(directory, "targets"), 0o755);
    for (const [name, text] of Object.entries(factoryPrometheusTargetFiles([
      { service: "harness", address: target(harness.url), tenant: METRIC_TENANT },
      { service: "gateway", address: target(gateway.url), tenant: METRIC_TENANT },
    ]))) await writeFile(join(directory, "targets", name), text, { mode: 0o644 });
    const port = await freePort();
    api = `http://127.0.0.1:${port}`;
    const started = await podman(["run", "-d", "--name", container, "--network=host", ...AS_HOST_USER, "-v", `${directory}:/etc/prometheus:ro,Z`, "--tmpfs", "/prometheus:rw,mode=1777", IMAGE!,
      "--config.file=/etc/prometheus/prometheus.yml", `--web.listen-address=127.0.0.1:${port}`, "--storage.tsdb.path=/prometheus"]);
    if (started.code !== 0) throw new Error(`prometheus did not start: ${started.out}`);
    for (let tries = 0; tries < 60; tries += 1) {
      try { if ((await fetch(`${api}/-/ready`)).ok) break; } catch { /* starting */ }
      await Bun.sleep(500);
    }
  }, 120_000);

  afterAll(async () => {
    await podman(["rm", "-f", "-v", "-t", "0", container]);
    await harness?.stop();
    await gateway?.stop();
    await fixture?.close();
    await rm(directory, { recursive: true, force: true });
  }, 60_000);

  test("a quiet installation fires nothing", async () => {
    await forceCheckpoint(fixture.db as never, Date.now(), 0);
    await Bun.sleep(8_000);
    expect(await alerts()).toEqual([]);
  }, 60_000);

  test("every forced condition fires its alert, carrying the C11 operator action", async () => {
    const now = Date.now();
    const db = fixture.db as never;
    await forceReadyWork(db, now, 45_000);
    await forceRun(db, now, { status: "running", updatedAgeMs: 61_000 });
    await forceBudget(db, { exhausted: false, reservationState: "uncertain" });
    const lagging = await forceRun(db, now, { status: "running" });
    await forceProjection(db, now, lagging, { sequence: 2, projected: 1, ageMs: 20_000, consumerId: FACTORY_RUN_STATUS_CONSUMER_ID });
    await forceValidatorOutcomes(db, now, "1".repeat(64), ["failed", "failed", "failed"]);
    await forceRelease(db, now, "uncertain", 75_000);
    await forceRun(db, now, { status: "waiting", build: "interpreter-old" });
    await fixture.db.transaction(async (transaction) => { await transaction.execute(sql`SET LOCAL session_replication_role = replica`); await transaction.execute(sql`DELETE FROM factory_checkpoints`); });
    await forceSend(db, now, "dead_letter", 1_000);
    counters.securityDenial("cross_tenant_broker");
    await gateway!.stop();
    gateway = undefined;

    const expected = new Set(FACTORY_ALERT_RULES.map((rule) => rule.alert));
    let firing: Awaited<ReturnType<typeof alerts>> = [];
    for (let waited = 0; waited < 150_000; waited += 2_000) {
      firing = (await alerts()).filter((alert) => alert.state === "firing");
      if ([...expected].every((name) => firing.some((alert) => alert.labels.alertname === name))) break;
      await Bun.sleep(2_000);
    }
    expect([...new Set(firing.map((alert) => alert.labels.alertname))].sort()).toEqual([...expected].sort());
    for (const rule of FACTORY_ALERT_RULES) {
      const alert = firing.find((candidate) => candidate.labels.alertname === rule.alert)!;
      expect(alert.labels.severity).toBe(rule.severity);
      // The target list's installation label reaches every alert, so the page names the installation.
      expect(alert.labels.tenant).toBe(METRIC_TENANT);
      expect(alert.annotations).toEqual(factoryAlertAnnotations(rule) as Record<string, string>);
    }
    await writeFile(join(process.env.W4H34_EVIDENCE_DIR ?? directory, "live-alerts.json"), JSON.stringify(firing, null, 2));
  }, 200_000);
});

async function freePort(): Promise<number> {
  const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = probe.port!;
  probe.stop(true);
  return port;
}
