import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodmanRunner, buildLimits, filesDigest, provisionToolchain } from "@ezcorp/extension-runner";
import { sealPublishedRelease } from "@ezcorp/extension-contract";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mockDbConnection();

test.skipIf(process.env.EZCORP_RUN_PODMAN_TESTS !== "1")("isolated publish artifacts persist and rebuild from immutable marketplace source", async () => {
  const root = await mkdtemp(join(tmpdir(), "marketplace-runner-"));
  let runner: PodmanRunner | undefined;
  try {
    await setupTestDb();
    runner = new PodmanRunner({ root, ...await provisionToolchain() });
    await runner.initialize();
    const manifest = { schemaVersion: 4, name: "marketplace-isolation", version: "1.0.0", description: "Isolated marketplace fixture", author: { name: "Tests" }, permissions: {}, tools: [{ name: "echo", description: "Echo", inputSchema: { type: "string" }, outputSchema: { type: "string" } }] };
    const files = {
      "extension.ts": `import {defineExtension,serve} from '@ezcorp/sdk/v4';await serve(defineExtension({manifest:${JSON.stringify(manifest)},tools:{echo:async input=>input}}));`,
      "feature.test.ts": "import {test,expect} from 'bun:test';test('feature',()=>expect(2+2).toBe(4));",
      "ezcorp.config.ts": "throw new Error('Host config execution is forbidden');",
    };
    const build = await runner.build({ operationId: crypto.randomUUID(), sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
    expect(build.diagnostics).toEqual([]);
    expect(build.state).toBe("succeeded");
    const release = await sealPublishedRelease(build, await runner.collectArtifacts(build.artifactDigest!));
    const { createUser } = await import("../db/queries/users");
    const { createListing } = await import("../db/queries/marketplace");
    const { createVersion } = await import("../db/queries/marketplace-versions");
    const { collectMarketplaceSource } = await import("../extensions/source-import");
    const author = await createUser({ email: "isolated-publisher@example.com", name: "Publisher", passwordHash: "hash" });
    const listing = await createListing({ authorId: author.id, name: manifest.name, description: manifest.description, category: "tools", tags: [], latestVersion: "1.0.0" });
    const version = await createVersion(listing.id, "1.0.0", build.manifest!, undefined, release);
    const source = await collectMarketplaceSource(version.id);
    expect(source).toEqual(files);
    const rebuilt = await runner.build({ operationId: crypto.randomUUID(), sourceDigest: filesDigest(source), files: source, entrypoint: "extension.ts", limits: buildLimits });
    expect(rebuilt.diagnostics).toEqual([]);
    expect(rebuilt.artifactDigest).toBe(build.artifactDigest);
  } finally {
    await runner?.close();
    await closeTestDb();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
