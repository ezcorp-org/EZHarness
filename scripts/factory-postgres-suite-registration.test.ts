import { describe, expect, test } from "bun:test";
import { Glob } from "bun";
import { readFile } from "node:fs/promises";
import { readRunnerLegs } from "./lib/combined-runner-legs.ts";
import { missingProducers, workflowCommands } from "./lib/ci-registration.ts";

/**
 * W00 audit discrepancy 12: `factory-budgets`, `factory-encryption-s3`,
 * `factory-inbox`, `factory-project-creation`, and `factory-records` existed on
 * disk and ran in NO CI producer. A hand-kept list of registered suites is what
 * allowed that, so this gate derives the requirement from the filesystem: every
 * real-PostgreSQL suite present must be named by a workflow's commands or by a
 * shell script those commands invoke. A producer script no workflow invokes
 * registers nothing.
 */
const POSTGRES_WORKFLOW = ".github/workflows/db-postgres.yml";

export async function postgresSuiteFiles(): Promise<string[]> {
  return [...new Glob("*.test.ts").scanSync({ cwd: "tests/postgres" })].map((name) => `./tests/postgres/${name}`).sort();
}

/**
 * What the repository's workflows actually run: every workflow's commands plus
 * the body of each shell script those commands invoke. A producer script that
 * exists but that no workflow invokes registers nothing (W18c: the
 * reference-data producer existed and ran in no CI job).
 */
async function producerText(): Promise<string> {
  const workflows = await Promise.all(
    [...new Glob("*.yml").scanSync({ cwd: ".github/workflows" })].sort().map((name) => readFile(`.github/workflows/${name}`, "utf8")),
  );
  const commands = workflows.map(workflowCommands);
  const invoked = [...new Set(commands.flatMap((text) => [...text.matchAll(/\bscripts\/[\w./-]+\.sh\b/g)].map((m) => m[0])))].sort();
  const shells = await Promise.all(invoked.map((path) => readFile(path, "utf8").catch(() => "")));
  return [...commands, ...shells.map(workflowCommands)].join("\n");
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

  // The ONE record of a suite no workflow runs yet: scripts/combined-runner-legs.json's localOnlyProducers
  // (coordinator ruling 2026-09-27 16:36Z). This test keeps no list of its own.
  const localOnly = () =>
    readRunnerLegs().localOnlyProducers.flatMap((producer) => producer.runs.map((run) => ({ id: producer.id, suite: `./${run}` })));

  test("every real-PostgreSQL suite on disk is run by a workflow or recorded as a local-only CI gap", async () => {
    const recorded = new Set(localOnly().map((entry) => entry.suite));
    expect((unregisteredSuites(await producerText(), await postgresSuiteFiles())).filter((suite) => !recorded.has(suite))).toEqual([]);
  });

  test("a recorded local-only suite is still run by no workflow", async () => {
    const producers = await producerText();
    const adopted = localOnly().filter((entry) => unregisteredSuites(producers, [entry.suite]).length === 0);
    expect(adopted.map((entry) => `${entry.id}: ${entry.suite} is now run by a workflow; move it to producers`)).toEqual([]);
  });

  test("a suite dropped from the workflow is reported, and a comment does not re-register it", async () => {
    const recorded = new Set(localOnly().map((entry) => entry.suite));
    const suites = (await postgresSuiteFiles()).filter((suite) => !recorded.has(suite));
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
    // They are placed in the storage step, after the factory-storage action has
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
    expect(workflow).toContain("uses: ./.github/actions/factory-storage");
  });
});
