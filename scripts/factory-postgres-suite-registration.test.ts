import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { missingProducers } from "./lib/ci-registration.ts";

/**
 * W00 audit discrepancy 12: `factory-budgets`, `factory-encryption-s3`,
 * `factory-inbox`, `factory-project-creation`, and `factory-records` existed on
 * disk and ran in NO CI producer. A hand-kept list of registered suites is what
 * allowed that, so this gate derives the requirement from the filesystem: every
 * real-PostgreSQL suite present must be named by db-postgres.yml or by one of
 * the `scripts/factory-*-coverage.sh` producers it invokes.
 */
const POSTGRES_WORKFLOW = ".github/workflows/db-postgres.yml";

export async function postgresSuiteFiles(): Promise<string[]> {
  return [...new Glob("*.test.ts").scanSync({ cwd: "tests/postgres" })].map((name) => `./tests/postgres/${name}`).sort();
}

async function producerText(): Promise<string> {
  const workflow = await readFile(POSTGRES_WORKFLOW, "utf8");
  const shellProducers = [...new Glob("factory-*-coverage.sh").scanSync({ cwd: "scripts" })].sort();
  const shells = await Promise.all(shellProducers.map((name) => readFile(`scripts/${name}`, "utf8")));
  return [workflow, ...shells].join("\n");
}

/** Suites on disk that no producer runs. */
export function unregisteredSuites(producers: string, suites: readonly string[]): string[] {
  return missingProducers(producers, suites.map((suite) => [suite, suite] as const));
}

describe("factory PostgreSQL suite registration", () => {
  test("finds the real suite set on disk rather than trusting a written list", async () => {
    const suites = await postgresSuiteFiles();
    expect(suites.length).toBeGreaterThan(20);
    for (const named of [
      "./tests/postgres/factory-budgets.test.ts",
      "./tests/postgres/factory-encryption-s3.test.ts",
      "./tests/postgres/factory-inbox.test.ts",
      "./tests/postgres/factory-project-creation.test.ts",
      "./tests/postgres/factory-records.test.ts",
    ]) {
      expect(suites, `${named} disappeared from tests/postgres`).toContain(named);
    }
  });

  test("every real-PostgreSQL suite on disk is run by a registered producer", async () => {
    expect(unregisteredSuites(await producerText(), await postgresSuiteFiles())).toEqual([]);
  });

  test("a suite dropped from the workflow is reported, and a comment does not re-register it", async () => {
    const suites = await postgresSuiteFiles();
    const producers = await producerText();
    const dropped = producers.replace("./tests/postgres/factory-records.test.ts", "./tests/postgres/missing.test.ts");
    expect(unregisteredSuites(dropped, suites)).toEqual(["./tests/postgres/factory-records.test.ts"]);
    const commentedOut = `${dropped}\n      # ./tests/postgres/factory-records.test.ts is covered elsewhere`;
    expect(unregisteredSuites(commentedOut, suites)).toEqual(["./tests/postgres/factory-records.test.ts"]);
  });

  test("a newly added suite that nobody registered fails closed", async () => {
    const producers = await producerText();
    expect(unregisteredSuites(producers, ["./tests/postgres/factory-not-yet-registered.test.ts"])).toEqual([
      "./tests/postgres/factory-not-yet-registered.test.ts",
    ]);
  });

  test("the five previously unregistered suites run against the real engine and real storage", async () => {
    const workflow = await readFile(POSTGRES_WORKFLOW, "utf8");
    // They are placed in the storage step, after setup-factory-storage.sh has
    // exported EZCORP_FACTORY_STORAGE_SECRETS_DIR, because factory-encryption-s3
    // writes real objects. Running them before it would measure PGlite-free
    // PostgreSQL but no object store.
    const storageStep = workflow.split("- name: Run factory storage and private services on Postgres and S3")[1] ?? "";
    for (const suite of [
      "./tests/postgres/factory-budgets.test.ts",
      "./tests/postgres/factory-encryption-s3.test.ts",
      "./tests/postgres/factory-inbox.test.ts",
      "./tests/postgres/factory-project-creation.test.ts",
      "./tests/postgres/factory-records.test.ts",
    ]) {
      expect(storageStep, `${suite} is not in the real storage producer step`).toContain(suite);
    }
    expect(workflow).toContain('FACTORY_TEST_POSTGRES_URL="$DATABASE_URL"');
    expect(workflow).toContain("scripts/setup-factory-storage.sh up");
  });
});
