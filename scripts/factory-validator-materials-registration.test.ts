import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

function registrationIssues(workflow: string, thresholds: string): string[] {
  const required = [
    ["PostgreSQL and S3 conformance", "./tests/postgres/factory-validator-materials.test.ts"],
    ["coverage artifact", "name: lcov-cov-factory-storage"],
    ["coverage receipt", "path: coverage-factory-storage/lcov.info"],
    ["missing-report failure", "if-no-files-found: error"],
  ] as const;
  const sources = [
    "src/factory/validator-materials.ts",
    "src/db/migrations/add-factory-validator-materials.ts",
  ] as const;
  return [
    ...required.filter(([, value]) => !workflow.includes(value)).map(([label]) => label),
    ...sources.filter((source) => !thresholds.includes(`"${source}": 100`)).map((source) => `${source} threshold`),
  ];
}

describe("factory validator material coverage registration", () => {
  test("runs the real storage proof and gates every new source at 100 percent", async () => {
    const [workflow, thresholds] = await Promise.all([
      readFile(".github/workflows/db-postgres.yml", "utf8"),
      readFile("scripts/coverage-thresholds.json", "utf8"),
    ]);
    expect(registrationIssues(workflow, thresholds)).toEqual([]);
  });

  test("fails closed if the producer or an owned source floor disappears", async () => {
    const [workflow, thresholds] = await Promise.all([
      readFile(".github/workflows/db-postgres.yml", "utf8"),
      readFile("scripts/coverage-thresholds.json", "utf8"),
    ]);
    expect(registrationIssues(workflow.replace("./tests/postgres/factory-validator-materials.test.ts", "./tests/postgres/missing.test.ts"), thresholds)).toContain("PostgreSQL and S3 conformance");
    expect(registrationIssues(workflow, thresholds.replace('"src/factory/validator-materials.ts": 100', '"src/factory/validator-materials.ts": 99'))).toContain("src/factory/validator-materials.ts threshold");
  });
});
