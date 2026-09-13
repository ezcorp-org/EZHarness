import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

function registrationIssues(workflow: string, thresholds: string): string[] {
  const required = [
    ["PostgreSQL and S3 command proof", "./tests/postgres/factory-run-lifecycle-s3.test.ts"],
    ["coverage artifact", "name: lcov-cov-factory-storage"],
    ["coverage receipt", "path: coverage-factory-storage/lcov.info"],
    ["missing-report failure", "if-no-files-found: error"],
  ] as const;
  const sources = [
    "src/factory/protected-command-effects.ts",
    "src/factory/protected-command-provenance.ts",
    "src/db/migrations/add-factory-protected-command-effects.ts",
  ] as const;
  return [
    ...required.filter(([, value]) => !workflow.includes(value)).map(([label]) => label),
    ...sources.filter(source => !thresholds.includes(`"${source}": 100`)).map(source => `${source} threshold`),
  ];
}

describe("factory protected command effect registration", () => {
  test("runs the PostgreSQL and S3 proof and gates every new source", async () => {
    const [workflow, thresholds] = await Promise.all([
      readFile(".github/workflows/db-postgres.yml", "utf8"),
      readFile("scripts/coverage-thresholds.json", "utf8"),
    ]);
    expect(registrationIssues(workflow, thresholds)).toEqual([]);
  });

  test("fails closed if its producer or source floor disappears", async () => {
    const [workflow, thresholds] = await Promise.all([
      readFile(".github/workflows/db-postgres.yml", "utf8"),
      readFile("scripts/coverage-thresholds.json", "utf8"),
    ]);
    expect(registrationIssues(workflow.replace("./tests/postgres/factory-run-lifecycle-s3.test.ts", "./tests/postgres/missing.test.ts"), thresholds)).toContain("PostgreSQL and S3 command proof");
    expect(registrationIssues(workflow, thresholds.replace('"src/factory/protected-command-effects.ts": 100', '"src/factory/protected-command-effects.ts": 99'))).toContain("src/factory/protected-command-effects.ts threshold");
  });
});
