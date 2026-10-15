import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(withCoverage: boolean) {
  const root = await mkdtemp(join(tmpdir(), "factory-v8-lcov-"));
  roots.push(root);
  const coverage = join(root, "v8");
  await mkdir(coverage);
  const map = {
    version: 3,
    sources: ["webpack:///./packages/@ezcorp/factory-orchestrator/src/workflow.ts"],
    names: [],
    mappings: "AAAA",
  };
  const bundle = `x;\n//# sourceMappingURL=data:application/json;charset=utf-8;base64,${Buffer.from(JSON.stringify(map)).toString("base64")}`;
  const bundlePath = join(root, "bundle.js");
  const mapPath = join(root, "map.json");
  const outputPath = join(root, "lcov.info");
  await writeFile(bundlePath, bundle);
  await writeFile(mapPath, JSON.stringify(map));
  if (withCoverage) {
    await writeFile(join(coverage, "coverage.json"), JSON.stringify({ result: [{ url: "file:///repo/workflow-bundle-test.js", functions: [{ ranges: [{ startOffset: 0, endOffset: bundle.length, count: 1 }] }] }] }));
  }
  return { coverage, bundlePath, mapPath, outputPath };
}

describe("factory workflow V8 converter", () => {
  test("maps an executed workflow bundle range to canonical source LCOV", async () => {
    const item = await fixture(true);
    const process = Bun.spawn(["node", "scripts/factory-orchestrator-v8-to-lcov.mjs", item.coverage, item.bundlePath, item.mapPath, item.outputPath], { stdout: "pipe", stderr: "pipe" });
    expect(await process.exited).toBe(0);
    expect(await Bun.file(item.outputPath).text()).toContain("SF:packages/@ezcorp/factory-orchestrator/src/workflow.ts\nDA:1,1\nLF:1\nLH:1");
  });

  test("fails when the Temporal isolate emits no V8 receipt", async () => {
    const item = await fixture(false);
    const process = Bun.spawn(["node", "scripts/factory-orchestrator-v8-to-lcov.mjs", item.coverage, item.bundlePath, item.mapPath, item.outputPath], { stdout: "pipe", stderr: "pipe" });
    expect(await process.exited).toBe(1);
    expect(await new Response(process.stderr).text()).toContain("no V8 coverage receipt");
  });
});
