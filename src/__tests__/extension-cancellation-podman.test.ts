import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodmanRunner, buildLimits, filesDigest, provisionToolchain } from "@ezcorp/extension-runner";
import type { ExtensionManifestV4 } from "@ezcorp/extension-contract";
import { ReleaseProcess } from "../extensions/release-process";
import { releaseRuntimeFixture } from "./helpers/release-runtime";
import { registerCallProvenance, releaseCallProvenance } from "../extensions/call-provenance";

test("caller cancellation stops only its isolated worker and permits later calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "ez-cancel-worker-"));
  const runner = new PodmanRunner({ root, ...await provisionToolchain() });
  const manifest: ExtensionManifestV4 = { schemaVersion: 4, name: "cancel-worker", version: "1.0.0", description: "Cancellation fixture", author: { name: "Tests" }, permissions: {}, tools: [{ name: "hold", description: "Wait for cancellation", inputSchema: { type: "object" }, outputSchema: { type: "object" } }, { name: "echo", description: "Return normally", inputSchema: { type: "object" }, outputSchema: { type: "object" } }] };
  const files = {
    "manifest.json": JSON.stringify(manifest),
    "extension.ts": `import {defineExtension,serve,validateManifest} from '@ezcorp/sdk/v4';import manifest from './manifest.json';await serve(defineExtension({manifest:validateManifest(manifest),tools:{hold:async(_input,context)=>{await context.call('ezcorp/test.ready',{});await new Promise<void>(resolve=>context.signal.addEventListener('abort',()=>resolve(),{once:true}));return {text:'stopped'};},echo:async(_input,context)=>{await context.call('ezcorp/test.echo',{});return {text:'still available'};}}}));`,
    "source.test.ts": "import {expect,test} from 'bun:test';import manifest from './manifest.json';test('two declared tools',()=>expect(manifest.tools).toHaveLength(2));",
  };
  let process: ReleaseProcess | undefined;
  let token: string | undefined;
  const resumeEcho = Promise.withResolvers<void>();
  try {
    const build = await runner.build({ operationId: crypto.randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
    expect(build.diagnostics).toEqual([]);
    const fixture = releaseRuntimeFixture(crypto.randomUUID(), manifest, { artifactDigest: build.artifactDigest! });
    fixture.snapshot.limits.timeoutMs = 10_000;
    process = new ReleaseProcess(fixture.snapshot.installation.id, { runner: async () => runner, resolve: async () => fixture.snapshot });
    const started = Promise.withResolvers<void>();
    const echoStarted = Promise.withResolvers<void>();
    process.setRequestHandler(async request => {
      if (request.method === "ezcorp/test.echo") { echoStarted.resolve(); await resumeEcho.promise; }
      else { expect(request.method).toBe("ezcorp/test.ready"); started.resolve(); }
      return { jsonrpc: "2.0", id: request.id, result: {} };
    });
    token = registerCallProvenance({ actorExtensionId: fixture.snapshot.installation.id, onBehalfOf: "owner", conversationId: null, runId: null, parentCallId: null, kind: "tool", ownerless: false });
    const controller = new AbortController();
    const call = process.callTool("hold", {}, { ezCallId: token }, { signal: controller.signal });
    void call.catch(() => undefined);
    await started.promise;
    const echo = process.callTool("echo", {}, { ezCallId: token });
    void echo.catch(() => undefined);
    await echoStarted.promise;
    controller.abort();
    await expect(call).rejects.toMatchObject({ code: "CANCELLED" });
    expect(process.inFlightCallCount).toBe(1);
    resumeEcho.resolve();
    expect(await echo).toMatchObject({ content: [{ type: "text", text: '{"text":"still available"}' }], isError: false });
    expect(process.inFlightCallCount).toBe(0);
    expect(process.isRunning).toBe(true);
    expect(await process.callTool("echo", {}, { ezCallId: token })).toMatchObject({ content: [{ type: "text", text: '{"text":"still available"}' }], isError: false });
  } finally { resumeEcho.resolve(); process?.kill(); if (token) releaseCallProvenance(token); await runner.close(); await rm(root, { recursive: true, force: true }); }
}, 30_000);
