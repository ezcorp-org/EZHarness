#!/usr/bin/env bun
/**
 * `schema:generate` drift gate (freeze open question 32; default: yes, in W18).
 *
 * `packages/@ezcorp/factory-sdk/src/*.schema.json` is GENERATED ONLY — the
 * interface freeze lists it as "Generated only. Never hand-edit." Nothing
 * enforced that. A hand edit to a generated schema silently changes the wire
 * contract that the Python and Bun runners both validate against, and the
 * SDK build does not regenerate, so CI stayed green.
 *
 * The gate regenerates into the working tree exactly as an author would, byte-
 * compares, then RESTORES the committed bytes so a local run is never
 * destructive. Failure names each drifted file.
 *
 * The checked set is DERIVED from the `--out` arguments of the package's own
 * `schema:generate` script and cross-checked against the `*.schema.json` files
 * on disk, so neither a new generated schema nor a hand-written one can slip
 * outside the gate.
 */
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { REPO_ROOT } from "./coverage-config.ts";

export const SDK_PACKAGE = "packages/@ezcorp/factory-sdk";
export const SDK_SOURCE_DIR = `${SDK_PACKAGE}/src`;

/** Repo-relative outputs named by the `--out` arguments of a generate script. */
export function generatedSchemaOutputs(generateScript: string): string[] {
  const outputs = [...generateScript.matchAll(/--out\s+(\S+)/g)].map((match) => `${SDK_SOURCE_DIR}/${match[1]!.replace(/^src\//, "")}`);
  return [...new Set(outputs)].sort();
}

/** Schema files present on disk but produced by no `--out` argument. */
export function ungeneratedSchemaFiles(onDisk: readonly string[], generated: readonly string[]): string[] {
  const produced = new Set(generated);
  return onDisk
    .filter((file) => !produced.has(file))
    .map((file) => `${file}: a *.schema.json file that 'schema:generate' does not produce — generated schemas are the only kind allowed here`);
}

export function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Files whose bytes changed between two digest maps, as reviewable messages. */
export function driftedSchemas(before: ReadonlyMap<string, string>, after: ReadonlyMap<string, string>): string[] {
  const drifted: string[] = [];
  for (const [file, committed] of before) {
    const regenerated = after.get(file);
    if (regenerated === undefined) {
      drifted.push(`${file}: 'schema:generate' did not produce this committed schema`);
    } else if (regenerated !== committed) {
      drifted.push(`${file}: committed bytes (sha256 ${committed.slice(0, 12)}) differ from 'schema:generate' output (sha256 ${regenerated.slice(0, 12)}) — regenerate, never hand-edit`);
    }
  }
  for (const file of after.keys()) {
    if (!before.has(file)) drifted.push(`${file}: 'schema:generate' produced a schema that is not committed`);
  }
  return drifted;
}

async function digestFiles(files: readonly string[]): Promise<Map<string, string>> {
  const entries = await Promise.all(files.map(async (file) => {
    const handle = Bun.file(resolve(REPO_ROOT, file));
    return await handle.exists() ? [file, digest(new Uint8Array(await handle.arrayBuffer()))] as const : undefined;
  }));
  return new Map(entries.filter((entry): entry is readonly [string, string] => entry !== undefined));
}

/**
 * Everything that must be true BEFORE the generator runs, decided purely so it
 * is testable without a malformed repository on disk. Any issue aborts: there
 * is no point regenerating schemas when the manifest, the `--out` list, or the
 * committed set is already wrong, and not running a generator over a broken
 * tree is also the safer order.
 */
export function schemaGenerationPlan(
  manifest: { scripts?: Record<string, string> },
  onDisk: readonly string[],
): { expected: string[]; issues: string[] } {
  const generateScript = manifest.scripts?.["schema:generate"];
  if (!generateScript) return { expected: [], issues: [`${SDK_PACKAGE}/package.json has no 'schema:generate' script`] };
  const expected = generatedSchemaOutputs(generateScript);
  if (expected.length === 0) return { expected: [], issues: ["'schema:generate' names no --out target"] };
  const present = new Set(onDisk);
  return {
    expected,
    issues: [
      ...expected.filter((file) => !present.has(file)).map((file) => `${file} is declared by 'schema:generate' but absent from the repository`),
      ...ungeneratedSchemaFiles(onDisk, expected),
    ],
  };
}

/** Run the package's own `schema:generate`, returning its exit code. */
export async function spawnSchemaGenerate(packageDirectory: string, log: Pick<Console, "error">): Promise<number> {
  const proc = Bun.spawn(["bun", "run", "--cwd", packageDirectory, "schema:generate"], { cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe" });
  const [, stderr, exitCode] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exitCode !== 0) log.error(`schema:generate exited ${exitCode}: ${stderr.trim().slice(0, 2000)}`);
  return exitCode;
}

/** The package manifest and the committed schema set, read from the repository. */
export async function readSchemaPlanInputs(): Promise<PlanInputs> {
  const manifest = await Bun.file(resolve(REPO_ROOT, `${SDK_PACKAGE}/package.json`)).json() as { scripts?: Record<string, string> };
  const onDisk = (await readdir(resolve(REPO_ROOT, SDK_SOURCE_DIR)))
    .filter((name) => name.endsWith(".schema.json"))
    .map((name) => `${SDK_SOURCE_DIR}/${name}`)
    .sort();
  return { manifest, onDisk };
}

export interface PlanInputs {
  manifest: { scripts?: Record<string, string> };
  onDisk: string[];
}

export async function runSchemaDriftCheck(options: {
  generate?: (packageDirectory: string) => Promise<number>;
  readInputs?: () => Promise<PlanInputs>;
  log?: Pick<Console, "log" | "error">;
} = {}): Promise<number> {
  const log = options.log ?? console;
  const { manifest, onDisk } = await (options.readInputs ?? readSchemaPlanInputs)();
  const plan = schemaGenerationPlan(manifest, onDisk);
  if (plan.issues.length > 0) {
    log.error(`schema drift gate FAILED (${plan.issues.length} issue(s)):`);
    for (const issue of plan.issues) log.error(`  ${issue}`);
    return 1;
  }

  const before = await digestFiles(plan.expected);
  const backup = await mkdtemp(join(tmpdir(), "factory-schema-drift-"));
  try {
    for (const file of plan.expected) await cp(resolve(REPO_ROOT, file), join(backup, file.replaceAll("/", "_")));
    const exitCode = await (options.generate ?? ((directory: string) => spawnSchemaGenerate(directory, log)))(SDK_PACKAGE);
    const after = await digestFiles(plan.expected);
    const drifted = exitCode === 0 ? driftedSchemas(before, after) : [];
    // Always restore the committed bytes: the gate reports drift, it does not land it.
    for (const file of plan.expected) await cp(join(backup, file.replaceAll("/", "_")), resolve(REPO_ROOT, file));
    if (exitCode !== 0) {
      log.error("schema drift gate FAILED: 'schema:generate' did not complete, so drift cannot be ruled out");
      return 1;
    }
    if (drifted.length > 0) {
      log.error(`schema drift gate FAILED (${drifted.length} issue(s)):`);
      for (const issue of drifted) log.error(`  ${issue}`);
      return 1;
    }
    log.log(`schema drift gate passed: ${plan.expected.length} generated schema(s) match 'schema:generate' byte for byte.`);
    return 0;
  } finally {
    await rm(backup, { recursive: true, force: true });
  }
}

export const SCHEMA_DRIFT_MAIN_RESULT = import.meta.main ? await runSchemaDriftCheck() : undefined;
if (SCHEMA_DRIFT_MAIN_RESULT !== undefined) process.exitCode = SCHEMA_DRIFT_MAIN_RESULT;
