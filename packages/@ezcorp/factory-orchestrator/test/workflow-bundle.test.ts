import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { promisify } from "node:util";
import { Worker } from "@temporalio/worker";
import { factoryOrchestratorProductionDependencies } from "../src/process.ts";
import { buildFactoryWorkflowBundle } from "../src/workflow-bundle-build.ts";
import {
  FACTORY_WORKFLOW_BUNDLE_DIRECTORY,
  FACTORY_WORKFLOW_BUNDLE_FILE,
  FACTORY_WORKFLOW_BUNDLE_RECORD_FILE,
  FACTORY_WORKFLOW_BUNDLE_SCHEMA,
  factoryWorkflowBundleDigest,
  loadFactoryWorkflowBundle,
  writeFactoryWorkflowBundle,
} from "../src/workflow-bundle.ts";

const HISTORY = new URL("./fixtures/factory-workflow-history.json", import.meta.url);
let scratch = "";

async function rejectsWith(promise: Promise<unknown>, code: string): Promise<void> {
  await assert.rejects(promise, (error: unknown) => {
    assert.equal((error as { code?: string }).code, code);
    assert.match((error as Error).message, new RegExp(`^${code}: `));
    return true;
  });
}

async function written(code = "globalThis.factory = 1;\n"): Promise<string> {
  const directory = await mkdtemp(join(scratch, "bundle-"));
  const seen: string[] = [];
  const record = await writeFactoryWorkflowBundle(directory, async ({ workflowsPath }) => { seen.push(workflowsPath); return { code }; });
  assert.deepEqual(record, { schemaVersion: FACTORY_WORKFLOW_BUNDLE_SCHEMA, sha256: factoryWorkflowBundleDigest(code), bytes: Buffer.byteLength(code) });
  assert.match(seen[0]!, /\/src\/workflow\.ts$/);
  return directory;
}

before(async () => { scratch = await mkdtemp(join(tmpdir(), "factory-workflow-bundle-")); });
after(async () => { if (scratch) await rm(scratch, { recursive: true, force: true }); });

describe("the build-time factory workflow bundle", () => {
  it("the canonical package build creates a loadable workflow bundle, including forced builds", { timeout: 60_000 }, async () => {
    const directory = await mkdtemp(join(scratch, "package-build-"));
    const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
    // Isolate the build lifecycle from tsc outputs shared by parallel test files.
    // Keep the package's actual lifecycle hooks and run its real producer.
    manifest.scripts.build = "node ./build.mjs";
    manifest.scripts["build:workflow-bundle"] = "node --experimental-strip-types ./bundle.mjs";
    await writeFile(join(directory, "package.json"), JSON.stringify(manifest));
    await writeFile(join(directory, "build.mjs"), 'import { writeFile } from "node:fs/promises"; await writeFile("build-args.json", JSON.stringify(process.argv.slice(2)));');
    await writeFile(join(directory, "bundle.mjs"), `const { buildFactoryWorkflowBundle } = await import(${JSON.stringify(new URL("../src/workflow-bundle-build.ts", import.meta.url).href)}); await buildFactoryWorkflowBundle("./bundle");`);
    await rejectsWith(loadFactoryWorkflowBundle(join(directory, "bundle")), "factory_workflow_bundle_missing");
    await promisify(execFile)("bun", ["run", "build", "--force"], { cwd: directory, timeout: 60_000, maxBuffer: 4 * 1024 * 1024 });
    assert.deepEqual(JSON.parse(await readFile(join(directory, "build-args.json"), "utf8")), ["--force"]);
    const bundle = await loadFactoryWorkflowBundle(join(directory, "bundle"));
    assert.equal(bundle.sha256, factoryWorkflowBundleDigest(bundle.code));
    const history = JSON.parse(await readFile(HISTORY, "utf8"));
    await Worker.runReplayHistory({ workflowBundle: { code: bundle.code } }, history);
  });
  it("loads a bundle whose bytes match the build's digest record", async () => {
    const directory = await written("export const é = 1;\n");
    const bundle = await loadFactoryWorkflowBundle(directory);
    assert.equal(bundle.code, "export const é = 1;\n");
    assert.equal(bundle.sha256, factoryWorkflowBundleDigest(bundle.code));
    assert.equal(Object.isFrozen(bundle), true);
  });

  it("refuses a one-byte change by name", async () => {
    const directory = await written();
    const path = join(directory, FACTORY_WORKFLOW_BUNDLE_FILE);
    const bytes = await readFile(path);
    bytes[0] = bytes[0]! ^ 1;
    await writeFile(path, bytes);
    await rejectsWith(loadFactoryWorkflowBundle(directory), "factory_workflow_bundle_digest_mismatch");
  });

  it("refuses a bundle whose length differs from the record even when the digest field matches", async () => {
    const directory = await written("abc");
    const record = JSON.parse(await readFile(join(directory, FACTORY_WORKFLOW_BUNDLE_RECORD_FILE), "utf8"));
    await writeFile(join(directory, FACTORY_WORKFLOW_BUNDLE_RECORD_FILE), JSON.stringify({ ...record, bytes: 4 }));
    await rejectsWith(loadFactoryWorkflowBundle(directory), "factory_workflow_bundle_digest_mismatch");
  });

  it("refuses a missing bundle or a missing record", async () => {
    const directory = await written();
    await rm(join(directory, FACTORY_WORKFLOW_BUNDLE_FILE));
    await rejectsWith(loadFactoryWorkflowBundle(directory), "factory_workflow_bundle_missing");
    await rejectsWith(loadFactoryWorkflowBundle(join(scratch, "absent")), "factory_workflow_bundle_missing");
  });

  it("refuses a malformed record", async () => {
    const directory = await written();
    const record = join(directory, FACTORY_WORKFLOW_BUNDLE_RECORD_FILE);
    const valid = JSON.parse(await readFile(record, "utf8"));
    for (const text of ["not json", "null", "[]", JSON.stringify({ ...valid, extra: 1 }), JSON.stringify({ ...valid, schemaVersion: "v0" }),
      JSON.stringify({ ...valid, sha256: "sha256:XYZ" }), JSON.stringify({ ...valid, sha256: 1 }), JSON.stringify({ ...valid, bytes: 0 }), JSON.stringify({ ...valid, bytes: 1.5 })]) {
      await writeFile(record, text);
      await rejectsWith(loadFactoryWorkflowBundle(directory), "factory_workflow_bundle_record_invalid");
    }
  });

  it("is what the image build writes, and the production worker start loads it and replays a committed history", async () => {
    const record = await buildFactoryWorkflowBundle();
    const bundle = await factoryOrchestratorProductionDependencies.loadWorkflowBundle();
    assert.equal(bundle.sha256, record.sha256);
    assert.deepEqual(await loadFactoryWorkflowBundle(FACTORY_WORKFLOW_BUNDLE_DIRECTORY), bundle);
    const history = JSON.parse(await readFile(HISTORY, "utf8"));
    await Worker.runReplayHistory({ workflowBundle: { code: bundle.code } }, history);
  });

  it("keeps the bundler out of every module the orchestrator process loads", async () => {
    for (const module of ["process.ts", "worker.ts", "workflow-bundle.ts"]) {
      const source = await readFile(new URL(`../src/${module}`, import.meta.url), "utf8");
      assert.doesNotMatch(source, /bundleWorkflowCode|workflow-bundle-build/, module);
    }
  });
});
