import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodmanRunner, buildLimits, filesDigest } from "@ezcorp/extension-runner";
import { provisionToolchain } from "../../packages/@ezcorp/extension-runner/src/provision";
import { verifyExtensionCandidate } from "../extensions/extension-lifecycle-service";
import { releaseRuntimeFixture } from "./helpers/release-runtime";
import type { ExtensionManifestV4 } from "@ezcorp/extension-contract";

test("rootless candidate smoke uses SDK locks with isolated scoped storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "ez-candidate-lock-"));
  const runner = new PodmanRunner({ root, ...await provisionToolchain() });
  const manifest: ExtensionManifestV4 = {
    schemaVersion: 4, name: "candidate-lock", version: "1.0.0", description: "Isolated coordination", author: { name: "Tests" }, permissions: { storage: true },
    tools: [{ name: "increment", description: "Increment test state", inputSchema: { type: "object" }, outputSchema: { type: "object" } }],
    smokeTest: { tool: "increment", input: {}, expect: { textIncludes: "counter=2" } },
  };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "extension.ts": `import {defineExtension,serve,validateManifest} from '@ezcorp/sdk/v4'; import {Storage,withLock} from '@ezcorp/sdk/runtime'; import manifest from './manifest.json'; const storage=new Storage('user'); await serve(defineExtension({manifest:validateManifest(manifest),tools:{increment:async()=>{const increment=()=>withLock('counter',async()=>{const previous=(await storage.get<number>('counter')).value??0;await storage.set('counter',previous+1);});await Promise.all([increment(),increment()]);return {text:'counter='+(await storage.get<number>('counter')).value};}}}));`,
    "source.test.ts": "import {expect,test} from 'bun:test'; import manifest from './manifest.json'; test('storage is explicit',()=>expect(manifest.permissions.storage).toBe(true));",
  };
  try {
    await runner.initialize();
    const build = await runner.build({ operationId: crypto.randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
    expect(build.diagnostics).toEqual([]);
    expect(build.state).toBe("succeeded");
    const { snapshot } = releaseRuntimeFixture(crypto.randomUUID(), manifest, { artifactDigest: build.artifactDigest! });
    for (let attempt = 0; attempt < 2; attempt++) {
      const report = await verifyExtensionCandidate(runner, snapshot.release);
      expect(report.smoke).toBe("passed");
      expect(report.capabilities).toContainEqual({ capability: "storage", state: "tested", calls: 5 });
      expect(report.capabilities).toContainEqual({ capability: "ezcorp/lock.acquire", state: "tested", calls: 2 });
      expect(report.capabilities).toContainEqual({ capability: "ezcorp/lock.release", state: "tested", calls: 2 });
    }
  } finally { await runner.close(); await rm(root, { recursive: true, force: true }); }
}, 60_000);
