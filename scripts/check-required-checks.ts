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
  "Factory schema and kernel",
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
  const response = await fetchImpl(
    `https://api.github.com/repos/${encodeURIComponent(options.repository.split("/")[0] ?? "")}/${encodeURIComponent(options.repository.split("/")[1] ?? "")}/branches/${encodeURIComponent(options.branch)}/protection/required_status_checks`,
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

if (import.meta.main) {
  const repository = process.env.GITHUB_REPOSITORY ?? "ezcorp-org/EZHarness";
  const branch = process.env.REQUIRED_CHECKS_BRANCH ?? "main";
  const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN;
  if (!token) throw new Error("GITHUB_TOKEN or GH_TOKEN is required for read-only branch-protection inspection");
  const inspection = await inspectRequiredChecks({ repository, branch, token });
  console.log(formatInspection(inspection));
  if (!inspectionPassed(inspection)) process.exit(1);
}
