import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { PodmanRunner, buildLimits, executionLimits, filesDigest, provisionToolchain } from "@ezcorp/extension-runner";
import type { BuildResult } from "@ezcorp/extension-contract";
import { snapshotFirstPartyExtension } from "../../scripts/migrate-extension-v4";
import { getProjectRoot } from "../extensions/project-root";

let root: string;
let runner: PodmanRunner;
let build: BuildResult;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "author-own-gate-"));
  runner = new PodmanRunner({ root, ...await provisionToolchain() });
  await runner.initialize();
  const { files } = await snapshotFirstPartyExtension(getProjectRoot(), "extension-author");
  build = await runner.build({ operationId: crypto.randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
}, 120000);
afterAll(async () => { await runner?.close(); if (root) await rm(root, { recursive: true, force: true }); });

describe("extension-author passes isolated acceptance", () => {
  test("the diagnostic manifest declares a served smoke tool and no authoring authority", () => {
    expect(build.diagnostics).toEqual([]);
    expect(build.state).toBe("succeeded");
    expect(build.manifest?.name).toBe("extension-author");
    expect(build.manifest?.permissions).toEqual({});
    expect(build.manifest?.tools?.map(tool => tool.name)).toEqual(["migration_status"]);
    expect(build.manifest?.smokeTest?.tool).toBe("migration_status");
    expect(build.evidence.tests.every(check => check.passed)).toBe(true);
  });

  test("its declared smoke runs in a rootless worker without host capabilities", async () => {
    const workerId = crypto.randomUUID();
    const context = { workerId, invocationId: crypto.randomUUID(), releaseId: build.artifactDigest!, principalId: "test-owner", scopeId: "test", token: "author-gate", deadline: Date.now() + 30000 };
    const calls: string[] = [];
    const worker = await runner.start({ workerId, artifactDigest: build.artifactDigest!, context, limits: executionLimits }, async method => { calls.push(method); throw new Error("Diagnostic must not request host capabilities"); });
    try {
      expect(await worker.request("extension/discover", {})).toEqual(build.manifest);
      const smoke = build.manifest!.smokeTest!;
      const result = await worker.request("extension/invoke", { name: smoke.tool, input: smoke.input, context });
      expect(JSON.stringify(result)).toContain("EXTENSION_AUTHOR_MOVED_TO_HOST");
      expect(calls).toEqual([]);
    } finally { await worker.close(); }
  }, 120000);
});
