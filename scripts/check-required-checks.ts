#!/usr/bin/env bun

export const DESIRED_REQUIRED_CHECKS = [
  "Typecheck",
  "Svelte check",
  "Backend tests",
  "Backend critical (strict pass/fail)",
  "Web tests (vitest)",
  "Web tests (bun-leg orphans)",
  "E2E (mock, no Docker)",
  "E2E (real auth + real DB)",
  "Lint (biome)",
  "Manifest lockfile drift check",
  "Per-file coverage gate",
  "Gate integrity",
  "Visual evidence",
  "Web security coverage",
  // The seven exact C11 verification lanes. scripts/check-factory-lanes.ts
  // proves each name belongs to a job with real producers; this list is what
  // branch protection must REQUIRE. Registering a required check is an admin
  // action, not a code change, so the five added here report as `missing`
  // until the repository administrator applies
  // docs/validation/factory/stage-2b/required-check-registration.md.
  "Factory schema and kernel",
  "Factory runner contracts",
  "Factory Temporal integration",
  "Factory assurance and release",
  "Factory isolation",
  "Factory product and domain E2E",
  "Factory deployment and operations",
] as const;

interface RequiredStatusChecksResponse {
  strict?: unknown;
  contexts?: unknown;
  checks?: unknown;
}

export interface RequiredChecksInspection {
  repository: string;
  branch: string;
  strict: boolean;
  desired: string[];
  existing: string[];
  missing: string[];
  unexpected: string[];
}

export function existingRequiredChecks(response: RequiredStatusChecksResponse): string[] {
  const names: string[] = [];
  if (Array.isArray(response.contexts)) {
    for (const context of response.contexts) if (typeof context === "string") names.push(context);
  }
  if (Array.isArray(response.checks)) {
    for (const check of response.checks) {
      if (check && typeof check === "object" && "context" in check && typeof check.context === "string") names.push(check.context);
    }
  }
  return [...new Set(names)].sort();
}

export function compareRequiredChecks(
  repository: string,
  branch: string,
  strict: boolean,
  existing: readonly string[],
  desired: readonly string[] = DESIRED_REQUIRED_CHECKS,
): RequiredChecksInspection {
  const desiredSorted = [...new Set(desired)].sort();
  const existingSorted = [...new Set(existing)].sort();
  const desiredSet = new Set(desiredSorted);
  const existingSet = new Set(existingSorted);
  return {
    repository,
    branch,
    strict,
    desired: desiredSorted,
    existing: existingSorted,
    missing: desiredSorted.filter((name) => !existingSet.has(name)),
    unexpected: existingSorted.filter((name) => !desiredSet.has(name)),
  };
}

export async function inspectRequiredChecks(options: {
  repository: string;
  branch: string;
  token: string;
  fetchImpl?: typeof fetch;
}): Promise<RequiredChecksInspection> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const [owner, repositoryName, extra] = options.repository.split("/");
  if (!owner || !repositoryName || extra) throw new Error(`Invalid GitHub repository '${options.repository}'; expected owner/name`);
  const apiUrl = process.env.GITHUB_API_URL ?? "https://api.github.com";
  const response = await fetchImpl(
    `${apiUrl}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repositoryName)}/branches/${encodeURIComponent(options.branch)}/protection/required_status_checks`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${options.token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
    },
  );
  if (!response.ok) throw new Error(`GitHub required-check inspection failed: HTTP ${response.status}`);
  const body = await response.json() as RequiredStatusChecksResponse;
  const strict = body.strict;
  if (typeof strict !== "boolean") throw new Error("GitHub response is missing boolean 'strict'");
  return compareRequiredChecks(options.repository, options.branch, strict, existingRequiredChecks(body));
}

export function inspectionPassed(inspection: RequiredChecksInspection): boolean {
  return inspection.strict && inspection.missing.length === 0 && inspection.unexpected.length === 0;
}

export function formatInspection(inspection: RequiredChecksInspection): string {
  const lines = [
    `Required-check inspection: ${inspection.repository} branch ${inspection.branch}`,
    `strict: ${inspection.strict}`,
    `desired (${inspection.desired.length}): ${inspection.desired.join(", ")}`,
    `existing (${inspection.existing.length}): ${inspection.existing.join(", ")}`,
    `missing (${inspection.missing.length}): ${inspection.missing.join(", ") || "none"}`,
    `unexpected (${inspection.unexpected.length}): ${inspection.unexpected.join(", ") || "none"}`,
  ];
  return lines.join("\n");
}

export async function runRequiredCheck(options: {
  env?: Record<string, string | undefined>;
  inspect?: typeof inspectRequiredChecks;
  log?: Pick<Console, "log">;
} = {}): Promise<number> {
  const env = options.env ?? process.env;
  const repository = env.GITHUB_REPOSITORY ?? "ezcorp-org/EZHarness";
  const branch = env.REQUIRED_CHECKS_BRANCH ?? "main";
  const token = env.GITHUB_TOKEN ?? env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required for read-only branch-protection inspection");
  const inspection = await (options.inspect ?? inspectRequiredChecks)({ repository, branch, token });
  (options.log ?? console).log(formatInspection(inspection));
  return inspectionPassed(inspection) ? 0 : 1;
}

export const REQUIRED_CHECKS_MAIN_RESULT = import.meta.main ? await runRequiredCheck() : undefined;
if (REQUIRED_CHECKS_MAIN_RESULT !== undefined) process.exitCode = REQUIRED_CHECKS_MAIN_RESULT;
