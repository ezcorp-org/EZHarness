import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

function registrationIssues(workflow: string, producer: string, thresholds: string): string[] {
  const required = [
    ["coverage producer", "bash scripts/factory-compute-admissions-coverage.sh"],
    ["coverage artifact", "name: lcov-cov-factory-compute-admissions"],
    ["coverage receipt", "path: coverage-factory-compute-admissions/lcov.info"],
    ["missing-report failure", "if-no-files-found: error"],
  ] as const;
  const producerRequired = [
    ["focused product test", "./src/__tests__/factory-compute-admissions.test.ts"],
    ["real PostgreSQL and HTTPS test", "./tests/postgres/factory-compute-admissions.test.ts"],
    ["actual authority test", "./tests/postgres/factory-run-lifecycle.test.ts"],
    ["dispatcher source", "src/factory/compute-admissions.ts"],
    ["migration source", "src/db/migrations/add-factory-compute-admissions.ts"],
  ] as const;
  return [
    ...required.filter(([, value]) => !workflow.includes(value)).map(([label]) => label),
    ...producerRequired.filter(([, value]) => !producer.includes(value)).map(([label]) => label),
    ...["src/factory/compute-admissions.ts", "src/db/migrations/add-factory-compute-admissions.ts"].filter(source => !thresholds.includes(`"${source}": 100`)).map(source => `${source} threshold`),
  ];
}

describe("factory compute admission coverage registration", () => {
  test("runs product, PostgreSQL, HTTPS, and authority proofs with full owned-source floors", async () => {
    const [workflow, producer, thresholds] = await Promise.all([
      readFile(".github/workflows/db-postgres.yml", "utf8"),
      readFile("scripts/factory-compute-admissions-coverage.sh", "utf8"),
      readFile("scripts/coverage-thresholds.json", "utf8"),
    ]);
    expect(registrationIssues(workflow, producer, thresholds)).toEqual([]);
  });

  test("fails closed when a real proof or owned-source floor is removed", async () => {
    const [workflow, producer, thresholds] = await Promise.all([
      readFile(".github/workflows/db-postgres.yml", "utf8"),
      readFile("scripts/factory-compute-admissions-coverage.sh", "utf8"),
      readFile("scripts/coverage-thresholds.json", "utf8"),
    ]);
    expect(registrationIssues(workflow.replace("bash scripts/factory-compute-admissions-coverage.sh", "true"), producer, thresholds)).toContain("coverage producer");
    expect(registrationIssues(workflow, producer.replace("./tests/postgres/factory-compute-admissions.test.ts", "./tests/postgres/missing.test.ts"), thresholds)).toContain("real PostgreSQL and HTTPS test");
    expect(registrationIssues(workflow, producer, thresholds.replace('"src/factory/compute-admissions.ts": 100', '"src/factory/compute-admissions.ts": 99'))).toContain("src/factory/compute-admissions.ts threshold");
  });
});
