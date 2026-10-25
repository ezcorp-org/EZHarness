import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { postgresSuiteFiles, producerText, repoStorageSuites, withoutStorageShards, withRepoStorageSuites } from "./factory-storage-shard.ts";
import { readRunnerLegs } from "./lib/combined-runner-legs.ts";
import { STORAGE_SHARD_COMMAND, missingProducers, withStorageSuites } from "./lib/ci-registration.ts";

/**
 * W00 audit discrepancy 12: `factory-budgets`, `factory-encryption-s3`,
 * `factory-inbox`, `factory-project-creation`, and `factory-records` existed on
 * disk and ran in NO CI producer. A hand-kept list of registered suites is what
 * allowed that, so this gate derives the requirement from the filesystem: every
 * real-PostgreSQL suite present must be named by a workflow's commands or by a
 * shell script those commands invoke. A producer script no workflow invokes
 * registers nothing. The storage shard command (scripts/factory-storage-shard.ts)
 * runs every suite no other producer names, so it registers those suites.
 */
const POSTGRES_WORKFLOW = ".github/workflows/db-postgres.yml";

/** Suites on disk that no producer runs. */
export function unregisteredSuites(producers: string, suites: readonly string[]): string[] {
  return missingProducers(producers, suites.map((suite) => [suite, suite] as const));
}

describe("factory PostgreSQL suite registration", () => {
  test("finds the real suite set on disk rather than trusting a written list", () => {
    const suites = postgresSuiteFiles();
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

  // The ONE record of a suite no workflow runs yet: scripts/combined-runner-legs.json's localOnlyProducers
  // (coordinator ruling 2026-09-27 16:36Z). This test keeps no list of its own.
  const localOnly = () =>
    readRunnerLegs().localOnlyProducers.flatMap((producer) => producer.runs.map((run) => ({ id: producer.id, suite: `./${run}` })));

  test("every real-PostgreSQL suite on disk is run by a workflow or recorded as a local-only CI gap", async () => {
    const recorded = new Set(localOnly().map((entry) => entry.suite));
    expect(unregisteredSuites(withRepoStorageSuites(producerText()), postgresSuiteFiles()).filter((suite) => !recorded.has(suite))).toEqual([]);
  });

  test("a recorded local-only suite is still run by no workflow", async () => {
    const producers = withRepoStorageSuites(producerText());
    const adopted = localOnly().filter((entry) => unregisteredSuites(producers, [entry.suite]).length === 0);
    expect(adopted.map((entry) => `${entry.id}: ${entry.suite} is now run by a workflow; move it to producers`)).toEqual([]);
  });

  test("without the storage shard command the storage suites are reported, and a comment does not re-register them", () => {
    const recorded = new Set(localOnly().map((entry) => entry.suite));
    const suites = postgresSuiteFiles().filter((suite) => !recorded.has(suite));
    const storage = repoStorageSuites();
    expect(storage).toContain("./tests/postgres/factory-records.test.ts");
    const dropped = withoutStorageShards(producerText());
    expect(unregisteredSuites(withStorageSuites(dropped, storage), suites)).toEqual(storage);
    const commentedOut = `${dropped}\n      # ${STORAGE_SHARD_COMMAND} "$SHARD_INDEX" "$SHARD_TOTAL"`;
    expect(unregisteredSuites(withStorageSuites(commentedOut, storage), suites)).toEqual(storage);
  });

  test("a newly added suite that no producer names fails closed", () => {
    expect(unregisteredSuites(producerText(), ["./tests/postgres/factory-not-yet-registered.test.ts"])).toEqual([
      "./tests/postgres/factory-not-yet-registered.test.ts",
    ]);
  });

  test("the five previously unregistered suites run against the real engine and real storage", async () => {
    const workflow = await readFile(POSTGRES_WORKFLOW, "utf8");
    // They run in the storage shards, after the factory-storage action has
    // exported EZCORP_FACTORY_STORAGE_SECRETS_DIR, because factory-encryption-s3
    // writes real objects. Running them before it would measure PGlite-free
    // PostgreSQL but no object store.
    const storageStep = workflow.split("- name: Run factory storage and private services on Postgres and S3")[1] ?? "";
    expect(workflow.split("- name: Run factory storage and private services on Postgres and S3")[0]).toContain("uses: ./.github/actions/factory-storage");
    expect(storageStep).toContain(STORAGE_SHARD_COMMAND);
    for (const suite of [
      "./tests/postgres/factory-budgets.test.ts",
      "./tests/postgres/factory-encryption-s3.test.ts",
      "./tests/postgres/factory-inbox.test.ts",
      "./tests/postgres/factory-project-creation.test.ts",
      "./tests/postgres/factory-records.test.ts",
    ]) {
      expect(repoStorageSuites(), `${suite} is not a storage suite`).toContain(suite);
    }
    expect(workflow).toContain('FACTORY_TEST_POSTGRES_URL="$DATABASE_URL"');
    expect(workflow).toContain("uses: ./.github/actions/factory-storage");
  });
});
