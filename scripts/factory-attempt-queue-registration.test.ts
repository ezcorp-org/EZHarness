import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

function registrationIssues(workflow: string, thresholds: string): string[] {
  const issues: string[] = [];
  if (!workflow.includes("./tests/postgres/factory-attempt-queue.test.ts")) issues.push("real PostgreSQL attempt queue test");
  if (!thresholds.includes('"src/factory/attempt-queue.ts": 100')) issues.push("attempt queue source 100% floor");
  if (!thresholds.includes('"src/db/migrations/add-factory-attempt-queue.ts": 100')) issues.push("attempt queue migration 100% floor");
  return issues;
}

describe("factory attempt queue registration", () => {
  test("keeps the durable attempt queue in the real PostgreSQL coverage lane", async () => {
    const workflow = await readFile(".github/workflows/db-postgres.yml", "utf8");
    const thresholds = await readFile("scripts/coverage-thresholds.json", "utf8");
    expect(registrationIssues(workflow, thresholds)).toEqual([]);
  });

  test("fails closed when the real test or either source floor is removed", async () => {
    const workflow = await readFile(".github/workflows/db-postgres.yml", "utf8");
    const thresholds = await readFile("scripts/coverage-thresholds.json", "utf8");
    expect(registrationIssues(workflow.replace("./tests/postgres/factory-attempt-queue.test.ts", "./tests/postgres/missing.test.ts"), thresholds)).toContain("real PostgreSQL attempt queue test");
    expect(registrationIssues(workflow, thresholds.replace('"src/factory/attempt-queue.ts": 100', '"src/factory/attempt-queue.ts": 99'))).toContain("attempt queue source 100% floor");
    expect(registrationIssues(workflow, thresholds.replace('"src/db/migrations/add-factory-attempt-queue.ts": 100', '"src/db/migrations/add-factory-attempt-queue.ts": 99'))).toContain("attempt queue migration 100% floor");
  });
});
