import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

function registrationIssues(workflow: string, thresholds: string): string[] {
  const issues: string[] = [];
  if (!workflow.includes("./tests/postgres/factory-run-lifecycle-s3.test.ts")) issues.push("real PostgreSQL and S3 task execution admission test");
  if (!thresholds.includes('"src/factory/task-execution-admission.ts": 100')) issues.push("task execution admission source 100% floor");
  if (!thresholds.includes('"src/factory/native-runner-policy.ts": 100')) issues.push("native runner policy source 100% floor");
  return issues;
}

describe("factory task execution admission registration", () => {
  test("keeps task execution admission in its real product coverage lane", async () => {
    const workflow = await readFile(".github/workflows/db-postgres.yml", "utf8");
    const thresholds = await readFile("scripts/coverage-thresholds.json", "utf8");
    expect(registrationIssues(workflow, thresholds)).toEqual([]);
  });

  test("fails closed when the product proof or source floor is removed", async () => {
    const workflow = await readFile(".github/workflows/db-postgres.yml", "utf8");
    const thresholds = await readFile("scripts/coverage-thresholds.json", "utf8");
    expect(registrationIssues(workflow.replace("./tests/postgres/factory-run-lifecycle-s3.test.ts", "./tests/postgres/missing.test.ts"), thresholds)).toContain("real PostgreSQL and S3 task execution admission test");
    expect(registrationIssues(workflow, thresholds.replace('"src/factory/task-execution-admission.ts": 100', '"src/factory/task-execution-admission.ts": 99'))).toContain("task execution admission source 100% floor");
    expect(registrationIssues(workflow, thresholds.replace('"src/factory/native-runner-policy.ts": 100', '"src/factory/native-runner-policy.ts": 99'))).toContain("native runner policy source 100% floor");
  });
});
