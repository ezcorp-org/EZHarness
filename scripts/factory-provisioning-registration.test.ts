import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

function registrationIssues(workflow: string, producer: string): string[] {
  const required = [
    ["real PostgreSQL producer invocation", 'FACTORY_TEST_POSTGRES_URL="$DATABASE_URL" COV_OUT=coverage-factory-provisioning bash scripts/factory-provisioning-coverage.sh'],
    ["coverage artifact", "name: lcov-cov-factory-provisioning"],
    ["coverage receipt", "path: coverage-factory-provisioning/lcov.info"],
    ["missing-report failure", "if-no-files-found: error"],
  ] as const;
  const producerRequired = [
    ["real provisioning test", "./tests/postgres/factory-provisioning.test.ts"],
    ["single owned source", "src/factory/provisioning/local.ts"],
    ["caller-selected output", "COV_OUT:?COV_OUT is required"],
  ] as const;
  return [
    ...required.filter(([, value]) => !workflow.includes(value)).map(([label]) => label),
    ...producerRequired.filter(([, value]) => !producer.includes(value)).map(([label]) => label),
  ];
}

describe("factory provisioning coverage registration", () => {
  test("runs the real PostgreSQL producer and uploads its sole source receipt", async () => {
    const workflow = await readFile(".github/workflows/db-postgres.yml", "utf8");
    const producer = await readFile("scripts/factory-provisioning-coverage.sh", "utf8");
    expect(registrationIssues(workflow, producer)).toEqual([]);
  });

  test("fails closed when the producer invocation or source filter is removed", async () => {
    const workflow = await readFile(".github/workflows/db-postgres.yml", "utf8");
    const producer = await readFile("scripts/factory-provisioning-coverage.sh", "utf8");
    expect(registrationIssues(workflow.replace("bash scripts/factory-provisioning-coverage.sh", "true"), producer)).toContain("real PostgreSQL producer invocation");
    expect(registrationIssues(workflow, producer.replace("src/factory/provisioning/local.ts", "src/factory/provisioning/other.ts"))).toContain("single owned source");
  });
});
