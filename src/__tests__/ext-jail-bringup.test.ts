import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { PodmanRunner, buildLimits, executionLimits, filesDigest, provisionToolchain } from "@ezcorp/extension-runner";
import { snapshotFirstPartyExtension } from "../../scripts/migrate-extension-v4";

let root: string;
let runner: PodmanRunner;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "extension-sealed-bringup-"));
  runner = new PodmanRunner({ root: join(root, "runner"), ...await provisionToolchain() });
  await runner.initialize();
}, 30_000);
afterAll(async () => { await runner?.close(); if (root) await rm(root, { recursive: true, force: true }); });

for (const name of ["github-projects", "task-tracking", "graded-card-scanner"]) {
  test(`${name} builds and discovers through the sealed production runner`, async () => {
    const snapshot = await snapshotFirstPartyExtension(resolve(import.meta.dir, "../.."), name);
    const result = await runner.build({ operationId: crypto.randomUUID(), files: snapshot.files, sourceDigest: filesDigest(snapshot.files), entrypoint: snapshot.source.entrypoint, limits: buildLimits });
    expect(result.diagnostics).toEqual([]);
    expect(result.state).toBe("succeeded");
    expect(result.manifest?.name).toBe(name);
    expect(result.evidence.tests.every(check => check.passed)).toBe(true);
    const context = { invocationId: crypto.randomUUID(), workerId: crypto.randomUUID(), releaseId: crypto.randomUUID(), principalId: "owner", scopeId: "global", token: crypto.randomUUID(), deadline: Date.now() + 10_000 };
    const worker = await runner.start({ workerId: context.workerId, artifactDigest: result.artifactDigest!, context, limits: executionLimits }, async () => { throw new Error("Discovery must not use host capabilities"); });
    try { expect(await worker.request("extension/discover", {})).toEqual(result.manifest); }
    finally { await worker.close(); }
  }, 120_000);
}

test("containment intact: the worker cannot read a host data canary", async () => {
  const directory = join(root, ".ezcorp", "data");
  await mkdir(directory, { recursive: true });
  const secret = join(directory, "jwt-secret.txt");
  await writeFile(secret, "TOP-SECRET");
  const manifest = { schemaVersion: 4, name: "read-canary", version: "1.0.0", description: "Containment", author: { name: "Test" }, permissions: {}, methods: [{ name: "read", inputSchema: {}, outputSchema: { type: "boolean" } }] };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "extension.ts": `import {defineExtension,serve,validateManifest} from '@ezcorp/sdk/v4';import manifest from './manifest.json';await serve(defineExtension({manifest:validateManifest(manifest),methods:{read:{inputSchema:{},outputSchema:{type:'boolean'},handle:async()=>Bun.file(${JSON.stringify(secret)}).exists()}}}));`,
    "canary.test.ts": `import {test,expect} from 'bun:test';import manifest from './manifest.json';test('build cannot read host data',async()=>{expect(manifest.permissions).toEqual({});expect(await Bun.file(${JSON.stringify(secret)}).exists()).toBe(false);});`,
  };
  const result = await runner.build({ operationId: crypto.randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
  expect(result.diagnostics).toEqual([]);
  expect(result.state).toBe("succeeded");
  const context = { invocationId: crypto.randomUUID(), workerId: crypto.randomUUID(), releaseId: crypto.randomUUID(), principalId: "owner", scopeId: "global", token: crypto.randomUUID(), deadline: Date.now() + 10_000 };
  const worker = await runner.start({ workerId: context.workerId, artifactDigest: result.artifactDigest!, context, limits: executionLimits }, async () => { throw new Error("Host filesystem access denied"); });
  try { expect(await worker.request("extension/dispatch", { method: "read", input: {}, context })).toBe(false); }
  finally { await worker.close(); }
  expect(await Bun.file(secret).text()).toBe("TOP-SECRET");
}, 120_000);
