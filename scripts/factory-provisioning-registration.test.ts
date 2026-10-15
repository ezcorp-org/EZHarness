import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

function registrationIssues(workflow: string, producer: string): string[] {
  const required = [
    ["real PostgreSQL producer invocation", 'FACTORY_TEST_POSTGRES_URL="$DATABASE_URL" COV_OUT=coverage-factory-provisioning bash scripts/factory-provisioning-coverage.sh'],
    ["real factory assurance test", 'FACTORY_TEST_POSTGRES_URL="$DATABASE_URL" bun test --timeout 30000 ./tests/postgres/factory-assurance.test.ts'],
    ["coverage artifact", "name: lcov-cov-factory-provisioning"],
    ["coverage receipt", "path: coverage-factory-provisioning/lcov_factory_provisioning.info"],
    ["missing-report failure", "if-no-files-found: error"],
  ] as const;
  const producerRequired = [
    ["real provisioning test", "./tests/postgres/factory-provisioning.test.ts"],
    ["real gateway process test", "./tests/postgres/factory-gateway-process.test.ts"],
    ["provisioner source", "src/factory/provisioning/local.ts"],
    ["ledger source", "src/factory/provisioning/ledger.ts"],
    ["database step source", "src/factory/provisioning/database.ts"],
    ["upgrade ledger source", "src/factory/provisioning/fleet-upgrade.ts"],
    ["operator entry source", "src/factory/provisioning/fleet-cli.ts"],
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
    expect(registrationIssues(workflow.replace("./tests/postgres/factory-assurance.test.ts", "./tests/postgres/missing-assurance.test.ts"), producer)).toContain("real factory assurance test");
    expect(registrationIssues(workflow, producer.replace("src/factory/provisioning/local.ts", "src/factory/provisioning/other.ts"))).toContain("provisioner source");
    expect(registrationIssues(workflow, producer.replace("./tests/postgres/factory-gateway-process.test.ts", ""))).toContain("real gateway process test");
  });
});
