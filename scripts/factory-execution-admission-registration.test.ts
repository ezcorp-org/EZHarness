import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

function registrationIssues(workflow: string, thresholds: string): string[] {
  const issues: string[] = [];
  if (!workflow.includes("./tests/postgres/factory-executions.test.ts")) issues.push("real PostgreSQL journal test");
  if (!thresholds.includes('"src/factory/executions.ts": 100')) issues.push("journal source 100% floor");
  return issues;
}

describe("factory execution admission registration", () => {
  test("keeps the transactional journal in the real PostgreSQL coverage lane", async () => {
    const workflow = await readFile(".github/workflows/db-postgres.yml", "utf8");
    const thresholds = await readFile("scripts/coverage-thresholds.json", "utf8");
    expect(registrationIssues(workflow, thresholds)).toEqual([]);
  });

  test("fails closed when the real test or source floor is removed", async () => {
    const workflow = await readFile(".github/workflows/db-postgres.yml", "utf8");
    const thresholds = await readFile("scripts/coverage-thresholds.json", "utf8");
    expect(registrationIssues(workflow.replace("./tests/postgres/factory-executions.test.ts", "./tests/postgres/missing.test.ts"), thresholds)).toContain("real PostgreSQL journal test");
    expect(registrationIssues(workflow, thresholds.replace('"src/factory/executions.ts": 100', '"src/factory/executions.ts": 99'))).toContain("journal source 100% floor");
  });
});
