/**
 * The factory storage shards hold every storage suite exactly once, and a new suite lands in a shard with no list
 * to edit. A written per-shard list missed a suite until a person added it; scripts/factory-storage-shard.ts derives
 * the suites from tests/postgres instead, and refuses to print a shard when the plan is not an exact partition.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { postgresSuiteFiles, producerText, repoStorageSuites, STORAGE_TIMINGS, storagePlan, storageShard, withoutStorageShards, withRepoStorageSuites } from "./factory-storage-shard.ts";
import { STORAGE_SHARD_COMMAND, ghExpr, readWorkflows, shardFindings } from "./lib/ci-registration.ts";
import { MANIFEST_PATH } from "./lib/combined-runner-legs.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const NEW_SUITE = "./tests/postgres/factory-zz-new-suite.test.ts";

/** The matrix size of db-postgres.yml factory-storage: the TOTAL its steps pass. */
function shardTotal(): number {
  const job = readWorkflows(join(REPO_ROOT, ".github/workflows")).find(({ file }) => file === "db-postgres.yml")!.jobs["factory-storage"]!;
  return (job.strategy!.matrix!.shard as unknown[]).length;
}

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A copy of the inputs the shard command reads: workflows, invoked scripts, the runner legs, the timings, suite names. */
function copyRepo(extraSuites: readonly string[] = [], options: { timings?: boolean } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "storage-shard-"));
  roots.push(root);
  cpSync(join(REPO_ROOT, ".github/workflows"), join(root, ".github/workflows"), { recursive: true });
  mkdirSync(join(root, "scripts"), { recursive: true });
  for (const path of [...producerText().matchAll(/\bscripts\/[\w./-]+\.sh\b/g)].map((match) => match[0])) cpSync(join(REPO_ROOT, path), join(root, path));
  cpSync(join(REPO_ROOT, MANIFEST_PATH), join(root, MANIFEST_PATH));
  if (options.timings !== false) cpSync(join(REPO_ROOT, STORAGE_TIMINGS), join(root, STORAGE_TIMINGS));
  mkdirSync(join(root, "tests/postgres"), { recursive: true });
  for (const suite of [...postgresSuiteFiles(), ...extraSuites]) writeFileSync(join(root, suite), "");
  return root;
}

/** Every shard of the plan, through the command's own entry point. */
function allShards(total: number, root?: string): string[][] {
  return Array.from({ length: total }, (_, index) => {
    const result = storageShard(index, total, root);
    if ("error" in result) throw new Error(result.error);
    return result.suites;
  });
}

describe("factory storage shards", () => {
  test("the workflow runs the shard command once per matrix entry, by job index and total", () => {
    const job = readWorkflows(join(REPO_ROOT, ".github/workflows")).find(({ file }) => file === "db-postgres.yml")!.jobs["factory-storage"]!;
    const step = job.steps!.find((candidate) => candidate.run?.includes(STORAGE_SHARD_COMMAND))!;
    expect(step.env).toEqual({ SHARD_INDEX: ghExpr("strategy.job-index"), SHARD_TOTAL: ghExpr("strategy.job-total") });
    expect(step.run).toContain(`${STORAGE_SHARD_COMMAND} "$SHARD_INDEX" "$SHARD_TOTAL"`);
    expect(shardTotal()).toBe(2);
  });

  test("the repository's shards hold every storage suite exactly once, and none is empty", () => {
    const suites = repoStorageSuites();
    expect(suites.length).toBeGreaterThan(40);
    expect(suites).toContain("./tests/postgres/factory-host-launch.test.ts");
    expect(suites).not.toContain("./tests/postgres/pool-one.test.ts");
    const shards = allShards(shardTotal());
    expect(shardFindings(suites, shards)).toEqual([]);
    expect(shards.flat().sort()).toEqual(suites);
    for (const shard of shards) expect(shard.length).toBeGreaterThan(0);
  });

  test("the hosted timings balance the shards within the longest suite", () => {
    const timings = (JSON.parse(readFileSync(join(REPO_ROOT, STORAGE_TIMINGS), "utf8")) as { timingsMs: Record<string, number> }).timingsMs;
    const loads = storagePlan(repoStorageSuites(), 2).map((shard) => shard.reduce((sum, suite) => sum + (timings[suite.slice(2)] ?? 0), 0));
    expect(Math.abs(loads[0]! - loads[1]!)).toBeLessThanOrEqual(Math.max(...Object.values(timings)));
  });

  test("a new suite is in exactly one shard; a plan written before it existed has it in none", () => {
    const base = copyRepo();
    const before = storagePlan(repoStorageSuites(base), 2, base);
    const root = copyRepo([NEW_SUITE]);
    const suites = repoStorageSuites(root);
    expect(suites).toContain(NEW_SUITE);
    expect(shardFindings(suites, before)).toEqual([`${NEW_SUITE} is in no shard`]);
    const shards = allShards(2, root);
    expect(shardFindings(suites, shards)).toEqual([]);
    expect(shards.filter((shard) => shard.includes(NEW_SUITE))).toHaveLength(1);
  });

  test("a suite put in both shards, or a shard plan that drops one, is named", () => {
    const [first, second] = allShards(2);
    const moved = first![0]!;
    expect(shardFindings(repoStorageSuites(), [first!, [...second!, moved]])).toEqual([`${moved} is in shards 1, 2`]);
    expect(shardFindings(repoStorageSuites(), [first!.slice(1), second!])).toEqual([`${moved} is in no shard`]);
  });

  test("a suite another producer names leaves the shards; the workflow without the command runs none", () => {
    const root = copyRepo();
    const named = "./tests/postgres/factory-records.test.ts";
    writeFileSync(join(root, ".github/workflows/extra.yml"), `jobs:\n  other:\n    steps:\n      - run: bun test ${named}\n`);
    expect(repoStorageSuites(root)).not.toContain(named);
    expect(withoutStorageShards(`- run: ${STORAGE_SHARD_COMMAND} 0 2`)).not.toContain(STORAGE_SHARD_COMMAND);
    expect(withRepoStorageSuites(`- run: ${STORAGE_SHARD_COMMAND} 0 2`).split("\n").slice(1)).toEqual(repoStorageSuites());
    expect(withRepoStorageSuites(withoutStorageShards(`- run: ${STORAGE_SHARD_COMMAND} 0 2`))).toBe("- run: bun scripts/missing.ts 0 2");
  });

  test("without the timings the shards still partition the suites by count", () => {
    const root = copyRepo([], { timings: false });
    const shards = allShards(2, root);
    expect(shardFindings(repoStorageSuites(root), shards)).toEqual([]);
    expect(Math.abs(shards[0]!.length - shards[1]!.length)).toBeLessThanOrEqual(1);
  });

  test("a bad index or an empty shard is refused, so `bun test` never runs with no file", () => {
    expect(storageShard(2, 2)).toEqual({ error: "bad shard 2 of 2" });
    expect(storageShard(-1, 2)).toEqual({ error: "bad shard -1 of 2" });
    expect(storageShard(Number.NaN, 2)).toEqual({ error: "bad shard NaN of 2" });
    const total = repoStorageSuites().length + 1;
    expect(storageShard(total - 1, total)).toEqual({ error: `storage shard ${total - 1} of ${total} is empty` });
  });

  test("a workflow that invokes a missing script names nothing through it", () => {
    const root = copyRepo();
    writeFileSync(join(root, ".github/workflows/extra.yml"), "jobs:\n  x:\n    steps:\n      - run: bash scripts/absent-producer.sh\n");
    expect(producerText(root)).toContain("bash scripts/absent-producer.sh");
    expect(repoStorageSuites(root)).toEqual(repoStorageSuites());
  });

  test("the command prints its shard, and exits 1 with the reason for a bad one", () => {
    const ok = Bun.spawnSync(["bun", "scripts/factory-storage-shard.ts", "0", "2"], { cwd: REPO_ROOT });
    expect(ok.exitCode).toBe(0);
    expect(ok.stdout.toString().trim().split("\n")).toEqual(allShards(2)[0]!);
    const bad = Bun.spawnSync(["bun", "scripts/factory-storage-shard.ts", "2", "2"], { cwd: REPO_ROOT });
    expect(bad.exitCode).toBe(1);
    expect(bad.stderr.toString()).toContain("factory-storage-shard: bad shard 2 of 2");
  });
});
