import { describe, expect, test } from "bun:test";
import {
  CURRENT_FACTORY_TEST_TENANTS,
  evaluateFactoryRunners,
  formatFactoryRunnerReadiness,
  inspectFactoryRunners,
  runFactoryRunnerCheck,
} from "./check-factory-runners.ts";
import { resolve } from "node:path";

function fakeFetch(impl: (url: string | URL | Request, init?: RequestInit) => Promise<Response>): typeof fetch {
  return Object.assign(impl, { preconnect: fetch.preconnect });
}

const readyRunners = [
  { id: 2, name: "gpu", status: "online", busy: true, labels: [{ name: "factory-gpu" }] },
  { id: 1, name: "real", status: "online", busy: false, labels: [{ name: "factory-real" }, { name: "factory-real" }] },
];

describe("factory runner readiness", () => {
  test("accepts online labelled runners and the 10-tenant campaign", () => {
    const result = evaluateFactoryRunners("owner/repo", CURRENT_FACTORY_TEST_TENANTS, readyRunners);
    expect(result.missing).toEqual([]);
    expect(result.runners.map((runner) => runner.id)).toEqual([1, 2]);
    expect(result.runners[0]!.labels).toEqual(["factory-real"]);
    expect(formatFactoryRunnerReadiness(result)).toContain("missing (0): none");
  });

  test("fails closed on missing/offline labels and bad campaign capacity", () => {
    const result = evaluateFactoryRunners("owner/repo", 9, [
      { id: 1, name: "offline", status: "offline", busy: false, labels: [{ name: "factory-real" }, { name: "factory-gpu" }] },
    ]);
    expect(result.missing).toEqual([
      "FACTORY_TEST_TENANT_COUNT must be an integer >= 10 for the current campaign",
      "no online runner has required label 'factory-real'",
      "no online runner has required label 'factory-gpu'",
    ]);
    expect(formatFactoryRunnerReadiness(result)).toContain("offline:offline[factory-gpu,factory-real]");
  });

  test("reads every runner page with GET requests", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const firstPage = Array.from({ length: 100 }, (_, index) => ({
      id: index + 1,
      name: `runner-${index + 1}`,
      status: "offline",
      busy: false,
      labels: [],
    }));
    const fetchImpl = fakeFetch(async (url, init) => {
      requests.push({ url: String(url), init });
      return Response.json({ total_count: 102, runners: String(url).endsWith("page=1") ? firstPage : readyRunners });
    });
    const result = await inspectFactoryRunners({ repository: "owner/repo", token: "secret", tenantCount: 10, fetchImpl, apiUrl: "https://github.invalid" });
    expect(requests.map((request) => request.url)).toEqual([
      "https://github.invalid/repos/owner/repo/actions/runners?per_page=100&page=1",
      "https://github.invalid/repos/owner/repo/actions/runners?per_page=100&page=2",
    ]);
    expect(requests.every((request) => request.init?.method === undefined)).toBe(true);
    expect(requests[0]!.init?.headers).toMatchObject({ Authorization: "Bearer secret" });
    expect(result.missing).toEqual([]);
  });

  test("rejects API errors, malformed payloads, count drift, and bad repositories", async () => {
    const http = fakeFetch(async () => new Response("denied", { status: 403 }));
    await expect(inspectFactoryRunners({ repository: "owner/repo", token: "x", tenantCount: 10, fetchImpl: http })).rejects.toThrow("HTTP 403");
    const malformed = fakeFetch(async () => Response.json({ total_count: 1, runners: [{ id: "bad" }] }));
    await expect(inspectFactoryRunners({ repository: "owner/repo", token: "x", tenantCount: 10, fetchImpl: malformed })).rejects.toThrow("malformed");
    const countDrift = fakeFetch(async () => Response.json({ total_count: 1, runners: [] }));
    await expect(inspectFactoryRunners({ repository: "owner/repo", token: "x", tenantCount: 10, fetchImpl: countDrift })).rejects.toThrow("count mismatch");
    await expect(inspectFactoryRunners({ repository: "bad", token: "x", tenantCount: 10, fetchImpl: countDrift })).rejects.toThrow("owner/name");
  });

  test("CLI seam refuses a missing inspection token and returns real verdicts", async () => {
    await expect(runFactoryRunnerCheck({ env: {} })).rejects.toThrow("FACTORY_RUNNER_READ_TOKEN");
    const output: string[] = [];
    const ready = evaluateFactoryRunners("owner/repo", 10, readyRunners);
    expect(await runFactoryRunnerCheck({
      env: { FACTORY_RUNNER_READ_TOKEN: "secret", FACTORY_TEST_TENANT_COUNT: "10", GITHUB_REPOSITORY: "owner/repo" },
      inspect: async () => ready,
      log: { log: (value) => output.push(String(value)) },
    })).toBe(0);
    expect(output.at(-1)).toContain("registered runners (2)");
    expect(await runFactoryRunnerCheck({
      env: { FACTORY_RUNNER_READ_TOKEN: "secret", FACTORY_TEST_TENANT_COUNT: "not-a-number" },
      inspect: async (options) => evaluateFactoryRunners(options.repository, options.tenantCount, []),
      log: { log() {} },
    })).toBe(1);
  });

  test("CI runs the precheck on GitHub hosting before any labelled runner can queue", async () => {
    const root = resolve(import.meta.dir, "..");
    const workflow = Bun.YAML.parse(await Bun.file(resolve(root, ".github/workflows/ci.yml")).text()) as {
      jobs: Record<string, { name?: string; "runs-on"?: string; "timeout-minutes"?: number; steps?: Array<{ run?: string; env?: Record<string, string>; "continue-on-error"?: boolean }> }>;
    };
    const job = workflow.jobs["factory-runner-readiness"];
    expect(job).toMatchObject({ name: "Factory runner readiness precheck", "runs-on": "ubuntu-latest", "timeout-minutes": 5 });
    const step = job?.steps?.find((candidate) => candidate.run?.includes("check-factory-runners.ts"));
    expect(step?.env).toMatchObject({ FACTORY_TEST_TENANT_COUNT: "10" });
    expect(step?.["continue-on-error"]).not.toBe(true);
  });
});
