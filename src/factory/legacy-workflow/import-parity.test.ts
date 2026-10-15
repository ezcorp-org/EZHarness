import { expect, test } from "bun:test";
import {
  EZ_FACTORY_JOB_STORE_EXACT_KEYS,
  EZ_FACTORY_JOB_STORE_PREFIXES,
  EZ_FACTORY_JOB_STORE_SCOPE,
  isEzFactoryJobStoreKey,
} from "./import";

/**
 * The exclusion rule is only as good as the key layout it mirrors.
 *
 * `extensions/ez-factory` is a bundled v4 extension built into an immutable
 * release; importing it here would pull the whole extension into the host
 * process to read five string literals. So the file is read as TEXT, which is
 * also what the repository's own coverage note prescribes for a cross-tree
 * constant. If the extension ever renames a key, this fails instead of the
 * exclusion silently stopping at nothing.
 */
const JOBS_MODULE = "extensions/ez-factory/lib/jobs.ts";

async function declarations(): Promise<Map<string, string>> {
  const source = await Bun.file(JOBS_MODULE).text();
  const found = new Map<string, string>();
  for (const match of source.matchAll(/^(?:export )?const (META_KEY|JOB_KEY_PREFIX|JOB_INDEX_KEY|RUN_KEY_PREFIX|RUN_INDEX_PREFIX|JOB_STORAGE_SCOPE) = "([^"]*)"/gmu)) {
    found.set(match[1]!, match[2]!);
  }
  return found;
}

test("the mirrored ez-factory job-store key layout still matches the extension's own", async () => {
  const declared = await declarations();
  expect([...declared.keys()].sort()).toEqual([
    "JOB_INDEX_KEY", "JOB_KEY_PREFIX", "JOB_STORAGE_SCOPE", "META_KEY", "RUN_INDEX_PREFIX", "RUN_KEY_PREFIX",
  ]);
  expect(EZ_FACTORY_JOB_STORE_SCOPE).toBe(declared.get("JOB_STORAGE_SCOPE")!);
  expect([...EZ_FACTORY_JOB_STORE_EXACT_KEYS].sort()).toEqual([declared.get("JOB_INDEX_KEY")!, declared.get("META_KEY")!].sort());
  expect([...EZ_FACTORY_JOB_STORE_PREFIXES].sort()).toEqual(
    [declared.get("JOB_KEY_PREFIX")!, declared.get("RUN_KEY_PREFIX")!, declared.get("RUN_INDEX_PREFIX")!].sort(),
  );
});

test("every real job-store key is recognised, and an ordinary output name is not", async () => {
  const declared = await declarations();
  const real = [
    declared.get("META_KEY")!,
    declared.get("JOB_INDEX_KEY")!,
    `${declared.get("JOB_KEY_PREFIX")!}nightly-docs`,
    `${declared.get("RUN_KEY_PREFIX")!}nightly-docs:run-1`,
    `${declared.get("RUN_INDEX_PREFIX")!}nightly-docs`,
  ];
  for (const key of real) expect(isEzFactoryJobStoreKey(key)).toBe(true);
  for (const name of ["report.md", "metadata", "jobs.json", "runner.log", "meta.json"]) {
    expect(isEzFactoryJobStoreKey(name)).toBe(false);
  }
});

test("the job store has no project dimension, which is why nothing under it may be surfaced", async () => {
  const source = await Bun.file(JOBS_MODULE).text();
  expect(source).toContain("There is no per-job owner check anywhere below.");
  expect(EZ_FACTORY_JOB_STORE_SCOPE).toBe("global");
});
