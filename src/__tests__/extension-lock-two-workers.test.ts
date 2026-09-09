import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PodmanRunner, buildLimits, filesDigest, provisionToolchain } from "@ezcorp/extension-runner";
import { validateManifest } from "@ezcorp/extension-contract";
import { closeTestDb, getTestDb, mockDbConnection, setupTestDb } from "./helpers/test-pglite";
import { releaseRuntimeFixture } from "./helpers/release-runtime";
import { ReleaseProcess } from "../extensions/release-process";
import { createExtension } from "../db/queries/extensions";
import { getStorageValue } from "../db/queries/extension-storage";
import { users } from "../db/schema";
import { registerCallProvenance, releaseCallProvenance } from "../extensions/call-provenance";
import { handleStorageRpc } from "../extensions/storage-handler";
import { buildFullGrantFromManifest } from "../extensions/install-grant";

mockDbConnection();
beforeEach(setupTestDb);
afterAll(closeTestDb);

test("two fresh workers preserve both increments inside the same SDK lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "ez-worker-lock-"));
  const runner = new PodmanRunner({ root, ...await provisionToolchain() });
  const manifest = validateManifest({ schemaVersion: 4, name: "worker-lock", version: "1.0.0", description: "Cross-worker storage lock", author: { name: "Test" }, permissions: { storage: true }, methods: [{ name: "increment", inputSchema: { type: "object" }, outputSchema: { type: "integer" } }] });
  const grants = buildFullGrantFromManifest(manifest);
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "extension.ts": `import {defineExtension,serve,validateManifest} from '@ezcorp/sdk/v4'; import {withLock,Storage} from '@ezcorp/sdk/runtime'; import manifest from './manifest.json'; const storage=new Storage('global'); await serve(defineExtension({manifest:validateManifest(manifest),methods:{increment:{inputSchema:{type:'object'},outputSchema:{type:'integer'},handle:async()=>withLock('counter',async()=>{const current=await storage.get<number>('counter'); const next=Number(current.value??0)+1; await storage.set('counter',next); return next;})}}}));`,
    "contract.test.ts": "import {test,expect} from 'bun:test'; import manifest from './manifest.json'; test('declares storage',()=>expect(manifest.permissions.storage).toBe(true));",
  };
  let process: ReleaseProcess | undefined;
  const tokens: string[] = [];
  let barrierTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    await runner.initialize();
    const build = await runner.build({ operationId: crypto.randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
    expect(build.diagnostics).toEqual([]);
    expect(build.state).toBe("succeeded");
    const [owner] = await getTestDb().insert(users).values({ email: `${crypto.randomUUID()}@lock.test`, name: "Owner", passwordHash: "fixture" }).returning();
    const extensionId = crypto.randomUUID();
    await createExtension({ id: extensionId, name: manifest.name, version: manifest.version, manifest, grantedPermissions: grants, enabled: true, source: "release-v4", creatorUserId: owner!.id });
    const fixture = releaseRuntimeFixture(extensionId, manifest, { ownerId: owner!.id, artifactDigest: build.artifactDigest! });
    process = new ReleaseProcess(extensionId, { runner: async () => runner, resolve: async () => fixture.snapshot });
    let reads = 0;
    let releaseReads!: () => void;
    const simultaneousReads = new Promise<void>((resolve) => { releaseReads = resolve; });
    process.setRequestHandler(async (request) => {
      if (request.method !== "ezcorp/storage") throw new Error(`Unexpected method ${request.method}`);
      const response = await handleStorageRpc(extensionId, request, { conversationId: "", userId: owner!.id, manifest, grantedPermissions: grants });
      if (request.params?.action === "get") {
        reads++;
        if (reads === 1) barrierTimer = setTimeout(releaseReads, 2000);
        if (reads === 2) releaseReads();
        await simultaneousReads;
      }
      return response;
    });
    const invoke = () => {
      const token = registerCallProvenance({ onBehalfOf: owner!.id, conversationId: null, runId: null, parentCallId: null, actorExtensionId: extensionId, kind: "tool", ownerless: false });
      tokens.push(token);
      return process!.call("increment", { _meta: { ezCallId: token } });
    };
    await Promise.all([invoke(), invoke()]);
    expect(reads).toBe(2);
    expect((await getStorageValue(extensionId, "global", null, "counter"))?.value).toBe(2);
  } finally {
    if (barrierTimer) clearTimeout(barrierTimer);
    for (const token of tokens) releaseCallProvenance(token);
    process?.kill();
    await process?.whenCallsSettled();
    await runner.close();
    await rm(root, { recursive: true, force: true });
  }
}, 120_000);
