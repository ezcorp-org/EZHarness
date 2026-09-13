#!/usr/bin/env bun

interface GitHubRunner {
  id: number;
  name: string;
  status: string;
  busy: boolean;
  labels: Array<{ name: string }>;
}

interface GitHubRunnersResponse {
  total_count: number;
  runners: GitHubRunner[];
}

export interface FactoryRunnerReadiness {
  repository: string;
  tenantCount: number;
  runners: Array<{ id: number; name: string; status: string; busy: boolean; labels: string[] }>;
  missing: string[];
}

const REQUIRED_LABELS = ["factory-real", "factory-gpu"] as const;
export const CURRENT_FACTORY_TEST_TENANTS = 10;

function repositoryParts(repository: string): [string, string] {
  const [owner, name, extra] = repository.split("/");
  if (!owner || !name || extra) throw new Error(`Invalid GitHub repository '${repository}'; expected owner/name`);
  return [owner, name];
}

function isRunner(value: unknown): value is GitHubRunner {
  return Boolean(value && typeof value === "object"
    && "id" in value && typeof value.id === "number"
    && "name" in value && typeof value.name === "string"
    && "status" in value && typeof value.status === "string"
    && "busy" in value && typeof value.busy === "boolean"
    && "labels" in value && Array.isArray(value.labels)
    && value.labels.every((label) => label && typeof label === "object" && "name" in label && typeof label.name === "string"));
}

async function runnerPage(options: {
  repository: string;
  token: string;
  page: number;
  fetchImpl: typeof fetch;
  apiUrl: string;
}): Promise<GitHubRunnersResponse> {
  const [owner, name] = repositoryParts(options.repository);
  const response = await options.fetchImpl(
    `${options.apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/runners?per_page=100&page=${options.page}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) throw new Error(`GitHub runner readiness inspection failed: HTTP ${response.status}`);
  const body = await response.json() as Partial<GitHubRunnersResponse>;
  if (!Number.isInteger(body.total_count) || !Array.isArray(body.runners) || !body.runners.every(isRunner)) {
    throw new Error("GitHub runner response is malformed");
  }
  return body as GitHubRunnersResponse;
}

export function evaluateFactoryRunners(
  repository: string,
  tenantCount: number,
  runners: readonly GitHubRunner[],
): FactoryRunnerReadiness {
  const normalized = runners.map((runner) => ({
    id: runner.id,
    name: runner.name,
    status: runner.status,
    busy: runner.busy,
    labels: [...new Set(runner.labels.map((label) => label.name))].sort(),
  })).sort((left, right) => left.id - right.id);
  const missing: string[] = [];
  if (!Number.isInteger(tenantCount) || tenantCount < CURRENT_FACTORY_TEST_TENANTS) {
    missing.push(`FACTORY_TEST_TENANT_COUNT must be an integer >= ${CURRENT_FACTORY_TEST_TENANTS} for the current campaign`);
  }
  for (const label of REQUIRED_LABELS) {
    if (!normalized.some((runner) => runner.status === "online" && runner.labels.includes(label))) {
      missing.push(`no online runner has required label '${label}'`);
    }
  }
  return { repository, tenantCount, runners: normalized, missing };
}

export async function inspectFactoryRunners(options: {
  repository: string;
  token: string;
  tenantCount: number;
  fetchImpl?: typeof fetch;
  apiUrl?: string;
}): Promise<FactoryRunnerReadiness> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const apiUrl = options.apiUrl ?? process.env.GITHUB_API_URL ?? "https://api.github.com";
  const first = await runnerPage({ ...options, fetchImpl, apiUrl, page: 1 });
  const pages = Math.max(1, Math.ceil(first.total_count / 100));
  const runners = [...first.runners];
  for (let page = 2; page <= pages; page++) {
    runners.push(...(await runnerPage({ ...options, fetchImpl, apiUrl, page })).runners);
  }
  if (runners.length !== first.total_count) {
    throw new Error(`GitHub runner response count mismatch: expected ${first.total_count}, received ${runners.length}`);
  }
  return evaluateFactoryRunners(options.repository, options.tenantCount, runners);
}

export function formatFactoryRunnerReadiness(readiness: FactoryRunnerReadiness): string {
  return [
    `Factory runner readiness: ${readiness.repository}`,
    `test tenant count: ${readiness.tenantCount}`,
    `registered runners (${readiness.runners.length}): ${readiness.runners.map((runner) => `${runner.name}:${runner.status}[${runner.labels.join(",")}]`).join("; ") || "none"}`,
    `missing (${readiness.missing.length}): ${readiness.missing.join("; ") || "none"}`,
  ].join("\n");
}

export async function runFactoryRunnerCheck(options: {
  env?: Record<string, string | undefined>;
  inspect?: typeof inspectFactoryRunners;
  log?: Pick<Console, "log">;
} = {}): Promise<number> {
  const env = options.env ?? process.env;
  const token = env.FACTORY_RUNNER_READ_TOKEN;
  if (!token) throw new Error("FACTORY_RUNNER_READ_TOKEN is required; readiness cannot pass without reading registered runners");
  const tenantCount = Number(env.FACTORY_TEST_TENANT_COUNT);
  const repository = env.GITHUB_REPOSITORY ?? "ezcorp-org/EZHarness";
  const readiness = await (options.inspect ?? inspectFactoryRunners)({ repository, token, tenantCount });
  (options.log ?? console).log(formatFactoryRunnerReadiness(readiness));
  return readiness.missing.length === 0 ? 0 : 1;
}

export const FACTORY_RUNNER_MAIN_RESULT = import.meta.main ? await runFactoryRunnerCheck() : undefined;
if (FACTORY_RUNNER_MAIN_RESULT !== undefined) process.exitCode = FACTORY_RUNNER_MAIN_RESULT;
