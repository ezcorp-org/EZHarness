import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldExtension, EXT_TYPES } from "@ezcorp/sdk";
import { PodmanRunner, buildLimits, executionLimits, filesDigest } from "../../packages/@ezcorp/extension-runner/src";
import { provisionToolchain } from "../../packages/@ezcorp/extension-runner/src/provision";

let root: string;
let runner: PodmanRunner;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "v4-scaffold-"));
  runner = new PodmanRunner({ root, ...await provisionToolchain() });
  await runner.initialize();
}, 60_000);
afterAll(async () => { await runner?.close(); if (root) await rm(root, { recursive: true, force: true }); });

for (const type of EXT_TYPES) {
  test(`${type} scaffold passes isolated typecheck, feature tests, discovery and declared smoke`, async () => {
    const { files } = scaffoldExtension({ name: `gate-${type}`, type, description: "Quotes '\\\" and a newline\\nremain data." });
    expect(files["extension.test.ts"]).not.toContain("test.todo");
    expect(files["extension.test.ts"]).toContain('from "./extension"');
    const build = await runner.build({ operationId: crypto.randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
    expect(build.diagnostics).toEqual([]);
    expect(build.state).toBe("succeeded");
    expect(build.evidence.tests.map(entry => entry.name)).toEqual(["typecheck", "compile", "feature:extension.test.ts", "metadata-discovery"]);
    expect(build.manifest?.schemaVersion).toBe(4);
    expect(build.manifest?.permissions).toEqual({});
    const workerId = crypto.randomUUID();
    const context = { workerId, invocationId: crypto.randomUUID(), releaseId: build.artifactDigest!, principalId: "scaffold-owner", scopeId: "test", token: "scaffold-test", deadline: Date.now() + 30_000 };
    const worker = await runner.start({ workerId, artifactDigest: build.artifactDigest!, context, limits: executionLimits }, async () => { throw new Error("Scaffold must not use undeclared host capabilities"); });
    try {
      expect(await worker.request("extension/discover", {})).toEqual(build.manifest);
      if (build.manifest?.smokeTest) {
        const smoke = build.manifest.smokeTest;
        expect(await worker.request("extension/invoke", { name: smoke.tool, input: smoke.input, context })).toEqual({ content: [{ type: "text", text: "Received: smoke" }], isError: false });
        await expect(worker.request("extension/invoke", { name: smoke.tool, input: { input: 42 }, context })).rejects.toThrow();
      }
    } finally { await worker.close(); }
  }, 120_000);
}
