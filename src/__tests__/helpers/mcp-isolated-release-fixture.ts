import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodmanRunner, provisionToolchain, buildLimits, filesDigest } from "@ezcorp/extension-runner";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { mcpReleaseFixture } from "./mcp-release-fixture";

export async function isolatedMcpRelease(files: WorkspaceFiles, id?: string) {
  const root = await mkdtemp(join(tmpdir(), "mcp-isolated-release-"));
  let runner: PodmanRunner | undefined;
  let fixture: ReturnType<typeof mcpReleaseFixture> | undefined;
  const close = async () => { fixture?.cleanup(); await runner?.close(); await rm(root, { recursive: true, force: true }); };
  try {
    runner = new PodmanRunner({ root, ...await provisionToolchain() });
    await runner.initialize();
    const build = await runner.build({ operationId: crypto.randomUUID(), sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
    if (build.state !== "succeeded" || !build.manifest || !build.artifactDigest) throw new Error(JSON.stringify(build.diagnostics));
    fixture = mcpReleaseFixture({ id, name: build.manifest.name, tools: build.manifest.tools, runner });
    fixture.snapshot.release.manifest = build.manifest;
    fixture.snapshot.release.artifactDigest = build.artifactDigest;
    fixture.registry.setManifestForTest(fixture.id, build.manifest);
    return { fixture, build, close };
  } catch (error) { await close(); throw error; }
}
