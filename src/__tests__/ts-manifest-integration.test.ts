import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scaffoldExtension, type ExtType } from "@ezcorp/sdk/scaffold";
import { assertJson, sealPublishedRelease, validatePublishedRelease, type BuildResult, type WorkspaceFiles } from "@ezcorp/extension-contract";
import { PodmanRunner, buildLimits, executionLimits, filesDigest, provisionToolchain } from "@ezcorp/extension-runner";
import { snapshotExtensionSource } from "../../scripts/migrate-extension-v4";
import { initExtension } from "../extensions/sdk/init";

let root: string;
let runner: PodmanRunner;
const builds = new Map<ExtType, Promise<{ build: BuildResult; files: WorkspaceFiles }>>();
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "manifest-integration-"));
  runner = new PodmanRunner({ root: join(root, "runner"), ...await provisionToolchain() });
  await runner.initialize();
}, 60000);
afterAll(async () => { await runner?.close(); if (root) await rm(root, { recursive: true, force: true }); });

function candidate(type: ExtType) {
  let promise = builds.get(type);
  if (!promise) {
    promise = (async () => {
      const name = `manifest-${type}`;
      await initExtension({ extName: name, type, description: "Roundtrip metadata", cwd: root });
      const { files } = await snapshotExtensionSource(root, { name, directory: name, entrypoint: "extension.ts" });
      expect(files).toEqual(scaffoldExtension({ name, type, description: "Roundtrip metadata" }).files);
      const build = await runner.build({ operationId: crypto.randomUUID(), sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
      expect(build.diagnostics).toEqual([]);
      expect(build.state).toBe("succeeded");
      return { build, files };
    })();
    builds.set(type, promise);
  }
  return promise;
}

describe("source import and immutable artifact roundtrip", () => {
  test("local source builds without producing installation authority", async () => {
    const { build } = await candidate("tool");
    expect(build.manifest?.name).toBe("manifest-tool");
    expect(build.manifest?.schemaVersion).toBe(4);
    expect(Object.hasOwn(build, "approvalId")).toBe(false);
  }, 120000);
  test("missing entrypoint fails source collection before a build", async () => {
    await expect(snapshotExtensionSource(root, { name: "missing", directory: "missing", entrypoint: "extension.ts" })).rejects.toThrow();
  });
  test("isolated discovery contains data only, never handler functions", async () => {
    const { build } = await candidate("multi");
    expect(() => assertJson(build.manifest)).not.toThrow();
    expect(build.manifest?.tools).toHaveLength(1);
    expect(build.manifest?.skills).toHaveLength(1);
    expect(build.manifest?.agent).toBeDefined();
  }, 120000);
  test("sealed publication binds source and artifact checksums", async () => {
    const { build, files } = await candidate("tool");
    const artifacts = await runner.collectArtifacts(build.artifactDigest!);
    const published = await sealPublishedRelease(build, artifacts);
    expect(build.sourceDigest).toBe(filesDigest(files));
    expect(build.artifactDigest).toBe(filesDigest(artifacts));
    expect(await validatePublishedRelease(JSON.parse(JSON.stringify(published)))).toEqual(published);
    const changed = { ...files, "README.md": "changed after build" };
    expect(filesDigest(changed)).not.toBe(build.sourceDigest);
  });
});

for (const type of ["tool", "skill", "agent", "multi"] as const) {
  describe(`${type} template`, () => {
    test("generated config uses the v4 validator and preserves contribution shape", async () => {
      const { files, build } = await candidate(type);
      expect(files["ezcorp.config.ts"]).toContain('from "@ezcorp/sdk/v4"');
      expect(files["ezcorp.config.ts"]).toContain("validateManifest");
      expect(build.manifest?.tools?.length ?? 0).toBe(type === "tool" || type === "multi" ? 1 : 0);
      expect(build.manifest?.skills?.length ?? 0).toBe(type === "skill" || type === "multi" ? 1 : 0);
      expect(Boolean(build.manifest?.agent)).toBe(type === "agent" || type === "multi");
    }, 120000);
    test("generated TypeScript and feature tests pass the actual isolated compiler", async () => {
      const { build } = await candidate(type);
      expect(build.evidence.tests.map(check => check.name)).toEqual(["typecheck", "compile", "feature:extension.test.ts", "metadata-discovery"]);
      expect(build.evidence.tests.every(check => check.passed)).toBe(true);
    }, 120000);
    test("its entrypoint serves sealed metadata and declared tool behavior", async () => {
      const { build } = await candidate(type);
      expect(build.manifest?.entrypoint).toBe("./extension.ts");
      const workerId = crypto.randomUUID();
      const context = { workerId, invocationId: crypto.randomUUID(), releaseId: build.artifactDigest!, principalId: "owner", scopeId: "test", token: "roundtrip", deadline: Date.now() + 30000 };
      const worker = await runner.start({ workerId, artifactDigest: build.artifactDigest!, context, limits: executionLimits }, async () => { throw new Error("Undeclared host call"); });
      try {
        expect(await worker.request("extension/discover", {})).toEqual(build.manifest);
        if (build.manifest?.smokeTest) {
          const smoke = build.manifest.smokeTest;
          expect(await worker.request("extension/invoke", { name: smoke.tool, input: smoke.input, context })).toEqual({ content: [{ type: "text", text: "Received: smoke" }], isError: false });
        }
      } finally { await worker.close(); }
    }, 120000);
  });
}

describe("host entrypoints never evaluate extension configuration", () => {
  test("the central loader rejects all paths before filesystem evaluation", async () => {
    const { loadManifest } = await import("../extensions/loader");
    const directory = join(root, "blocked");
    const marker = join(root, "host-executed");
    await Bun.write(join(directory, "ezcorp.config.ts"), `await Bun.write(${JSON.stringify(marker)}, "executed"); export default {};`);
    await expect(loadManifest(directory)).rejects.toThrow("Host configuration evaluation is disabled");
    expect(await Bun.file(marker).exists()).toBe(false);
  });
  test("publication builds through the isolated runner rather than a host loader", async () => {
    const source = await Bun.file(join(import.meta.dir, "../extensions/sdk/publish.ts")).text();
    expect(source).toContain("verifyCliExtension");
    expect(source).toContain("sealPublishedRelease");
    expect(source).not.toContain("loadManifest");
  });
  test("deprecated host execution helpers cannot bypass the required lifecycle", async () => {
    const { runExtensionTests } = await import("../extensions/sdk/test-runner");
    const { createTestExtension } = await import("../extensions/sdk/test-helpers");
    await expect(runExtensionTests({ extDir: root })).rejects.toThrow("Host configuration evaluation is disabled");
    await expect(createTestExtension(root, { sandbox: false })).rejects.toThrow("Host configuration evaluation is disabled");
  });
});
