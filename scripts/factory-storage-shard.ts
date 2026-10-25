#!/usr/bin/env bun
/**
 * The suites of one factory storage shard (db-postgres.yml factory-storage).
 *
 * The storage suites are not a written list: they are every tests/postgres suite that no other producer names and
 * that is not a recorded local-only gap (scripts/combined-runner-legs.json). A new suite therefore runs in a shard
 * on the day it lands. scripts/shard-plan.ts splits them by the hosted timings in scripts/factory-storage-timings.json
 * (a suite absent there weighs the median). Before it prints a shard, the command checks that the shards hold every
 * storage suite exactly once, and it refuses an empty shard, because `bun test` with no file runs the whole tree.
 *
 * CLI: `bun scripts/factory-storage-shard.ts INDEX TOTAL` (INDEX from 0, as `strategy.job-index`).
 */
import { Glob } from "bun";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT } from "./coverage-config.ts";
import { STORAGE_SHARD_COMMAND, shardFindings, storageSuites, withStorageSuites, workflowCommands } from "./lib/ci-registration.ts";
import { readRunnerLegs } from "./lib/combined-runner-legs.ts";
import { parseManifest, planShards } from "./shard-plan.ts";

export const STORAGE_TIMINGS = "scripts/factory-storage-timings.json";

/** Every real-PostgreSQL suite on disk, as `./tests/postgres/<name>`, sorted. */
export function postgresSuiteFiles(root = REPO_ROOT): string[] {
  return [...new Glob("*.test.ts").scanSync({ cwd: join(root, "tests/postgres") })].map((name) => `./tests/postgres/${name}`).sort();
}

/**
 * What the repository's workflows name: every workflow's commands plus the body of each shell script those commands
 * invoke. A producer script that exists but that no workflow invokes names nothing (W18c).
 */
export function producerText(root = REPO_ROOT): string {
  const dir = join(root, ".github/workflows");
  const commands = readdirSync(dir).filter((file) => file.endsWith(".yml")).sort().map((file) => workflowCommands(readFileSync(join(dir, file), "utf8")));
  const invoked = [...new Set(commands.flatMap((text) => [...text.matchAll(/\bscripts\/[\w./-]+\.sh\b/g)].map((match) => match[0])))].sort();
  const shells = invoked.map((path) => { try { return workflowCommands(readFileSync(join(root, path), "utf8")); } catch { return ""; } });
  return [...commands, ...shells].join("\n");
}

/** The suites every recorded local-only producer runs, as `./<path>`. */
export function localOnlySuites(root = REPO_ROOT): string[] {
  return readRunnerLegs(root).localOnlyProducers.flatMap((producer) => producer.runs.map((run) => `./${run}`));
}

/** The repository's storage suites. */
export function repoStorageSuites(root = REPO_ROOT): string[] {
  return storageSuites(producerText(root), postgresSuiteFiles(root), localOnlySuites(root));
}

/** The repository's storage suites, read once per process (the registration tests ask for them per step). */
let repoStorage: string[] | undefined;

/** `text` plus the repository's storage suites when it runs the storage shard command: what the text really runs. */
export function withRepoStorageSuites(text: string): string {
  repoStorage ??= repoStorageSuites();
  return withStorageSuites(text, repoStorage);
}

/** `workflow` with the storage shard command taken out, for a registration test's fail-closed case. */
export function withoutStorageShards(workflow: string): string {
  return workflow.replaceAll(STORAGE_SHARD_COMMAND, "bun scripts/missing.ts");
}

/** The storage suites in `total` shards, balanced by the hosted timings. */
export function storagePlan(suites: readonly string[], total: number, root = REPO_ROOT): string[][] {
  let timings: Record<string, number> = {};
  try { timings = parseManifest(readFileSync(join(root, STORAGE_TIMINGS), "utf8"))?.timingsMs ?? {}; } catch { /* no manifest: equal weights */ }
  return planShards(suites.map((suite) => suite.slice(2)), timings, total).map((shard) => shard.map((path) => `./${path}`));
}

/** Shard `index` of `total`, or the reason it cannot run. */
export function storageShard(index: number, total: number, root = REPO_ROOT): { suites: string[] } | { error: string } {
  if (!Number.isInteger(index) || !Number.isInteger(total) || index < 0 || index >= total) return { error: `bad shard ${index} of ${total}` };
  const suites = repoStorageSuites(root);
  const plan = storagePlan(suites, total, root);
  const findings = shardFindings(suites, plan);
  if (findings.length > 0) return { error: findings.join("\n") };
  if (plan[index]!.length === 0) return { error: `storage shard ${index} of ${total} is empty` };
  return { suites: plan[index]! };
}

if (import.meta.main) {
  const result = storageShard(Number(process.argv[2]), Number(process.argv[3]));
  if ("error" in result) {
    console.error(`factory-storage-shard: ${result.error}`);
    process.exit(1);
  }
  console.log(result.suites.join("\n"));
}
