import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { PodmanRunner, buildLimits, executionLimits, filesDigest, resolveDependencies } from "../src";
import { manifest, provision, source } from "./helpers";
import { command } from "../src/core";
import { createExtensionFiles } from "../../../../src/extensions/extension-control";

let root: string;
let runner: PodmanRunner;
let artifactDigest: string;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ez-runner-test-"));
  runner = new PodmanRunner({ root, ...await provision() });
  await runner.initialize();
}, 60_000);
afterAll(async () => { await runner.close(); await rm(root, { recursive: true, force: true }); });

test("authoring scaffold builds with private service umask", async () => {
  const previous = process.umask(0o077);
  try {
    const files = createExtensionFiles("private-scaffold");
    files["src/union.ts"] = "type Outcome={ok:true;value:string}|{ok:false;error:string};export function read(outcome:Outcome){if(!outcome.ok)return outcome.error;return outcome.value}";
    files["src/import.ts"] = "import {read} from './union.ts'; export const value=read({ok:true,value:'typed-import'});";
    files["contract.test.ts"] = "import {test,expect} from 'bun:test';import {canonicalJson,validateManifest} from '@ezcorp/extension-contract';test('sealed contract runtime',()=>expect(canonicalJson({b:1,a:2})).toBe('{\"a\":2,\"b\":1}'));";
    const result = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
    expect(result.diagnostics).toEqual([]);
    expect(result.state).toBe("succeeded");
  } finally { process.umask(previous); }
}, 120_000);

test("real isolated build, typecheck, feature tests, discovery, invocation and restart", async () => {
  const files = source("async (input,ctx) => ({...(input as Record<string,unknown>), broker: await ctx.call('storage.get',{key:'fixture'})})");
  const build = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
  expect(build.diagnostics).toEqual([]);
  expect(build.state).toBe("succeeded");
  expect(build.evidence.tests.map(test => test.name)).toEqual(["typecheck", "compile", "feature:feature.test.ts", "metadata-discovery"]);
  artifactDigest = build.artifactDigest!;
  expect(filesDigest(await runner.collectArtifacts(artifactDigest))).toBe(artifactDigest);
  const workerId = randomUUID();
  const context = { workerId, invocationId: randomUUID(), releaseId: artifactDigest, principalId: "user-a", scopeId: "scope-a", token: "test-token", deadline: Date.now() + 30_000 };
  const worker = await runner.start({ workerId, artifactDigest, context, limits: executionLimits }, async (method, params) => { expect(method).toBe("storage.get"); expect(params).toEqual({ context, input: { key: "fixture" } }); return "value"; });
  try { expect(await worker.request("extension/invoke", { name: "echo", input: { text: "hello" }, context })).toEqual({ text: "hello", broker: "value" }); } finally { await worker.close(); }
  const restarted = new PodmanRunner({ root });
  expect(await restarted.collectArtifacts(artifactDigest)).toEqual(await runner.collectArtifacts(artifactDigest));
}, 120_000);

test("public SDK subpaths share runtime registration and ship checked declarations", async () => {
  const files = source();
  files["extension.ts"] = `import {serve} from '@ezcorp/sdk/v4'; import {createRuntimeExtension} from '@ezcorp/sdk/v4/runtime'; import {createToolDispatcher,toolResult} from '@ezcorp/sdk/runtime'; await serve(await createRuntimeExtension({manifest:${JSON.stringify(manifest)},register:()=>createToolDispatcher({echo:()=>toolResult('shared runtime')})}));`;
  const result = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
  expect(result.diagnostics).toEqual([]);
  expect(result.state).toBe("succeeded");
  const workerId = randomUUID();
  const context = { workerId, invocationId: randomUUID(), releaseId: result.artifactDigest!, principalId: "owner", scopeId: "global", token: "runtime-test", deadline: Date.now() + 30_000 };
  const execution = await runner.start({ workerId, artifactDigest: result.artifactDigest!, context, limits: executionLimits }, async () => { throw new Error("Unexpected reverse request"); });
  try { expect(await execution.request("extension/invoke", { name: "echo", input: {}, context })).toMatchObject({ content: [{ type: "text", text: "shared runtime" }] }); }
  finally { await execution.close(); }
}, 120_000);

test("same frozen input produces identical artifacts", async () => {
  const files = source();
  const first = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
  const second = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
  expect(first.diagnostics).toEqual([]);
  expect(second.diagnostics).toEqual([]);
  expect(first.artifactDigest).toBe(second.artifactDigest);
}, 120_000);

test("type errors, absent, skipped and failing tests cannot produce a release", async () => {
  for (const files of [ { ...source(), "broken.ts": "const count:number='bad';" }, { "extension.ts": source()["extension.ts"]! }, { ...source(), "feature.test.ts": "import {test,expect} from 'bun:test';test('fail',()=>expect(1).toBe(2));" }, { ...source(), "feature.test.ts": "import {test} from 'bun:test';test.skip('skip',()=>{});" }, { ...source(), "feature.test.ts": "console.log('PASS');process.exit(0);" } ]) {
    const result = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
    expect(result.state).toBe("failed");
    expect(result.artifactDigest).toBeUndefined();
    expect(result.diagnostics.length).toBeGreaterThan(0);
  }
}, 120_000);

test("malicious build source cannot change a host file or obtain host environment", async () => {
  const files = source(`async () => {const fs=await import('node:fs');let host=false;try{host=fs.existsSync(${JSON.stringify(root)})}catch{};let writable=true;try{fs.writeFileSync('/workspace/assets/greeting.txt','changed')}catch{writable=false};let network=true;try{await fetch('http://169.254.169.254/latest/meta-data/',{signal:AbortSignal.timeout(1000)})}catch{network=false};return {host,writable,network,uid:process.getuid!(),secret:process.env.EZ_RUNNER_HOST_SECRET??null}}`);
  process.env.EZ_RUNNER_HOST_SECRET = "not-for-extension";
  const result = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
  expect(result.diagnostics).toEqual([]);
  const workerId = randomUUID();
  const context = { workerId, invocationId: randomUUID(), releaseId: result.artifactDigest!, principalId: "user-a", scopeId: "scope-a", token: "test-token", deadline: Date.now() + 20_000 };
  const worker = await runner.start({ workerId, artifactDigest: result.artifactDigest!, context, limits: executionLimits }, async () => null);
  try { expect(await worker.request("extension/invoke", { name: "echo", input: {}, context })).toEqual({ host: false, writable: false, network: false, uid: 65534, secret: null }); } finally { delete process.env.EZ_RUNNER_HOST_SECRET; await worker.close(); }
}, 120_000);

test("runner rejects mutable image tags and never falls back", async () => {
  expect(() => new PodmanRunner({ root, image: "oven/bun:latest" })).toThrow("immutable");
  await expect(new PodmanRunner({ root, podman: "/no/such/podman" }).initialize()).rejects.toThrow("Another runner");
  const unavailableRoot = await mkdtemp(join(tmpdir(), "ez-no-podman-"));
  try { await expect(new PodmanRunner({ root: unavailableRoot, podman: "/no/such/podman" }).initialize()).rejects.toThrow(); } finally { await rm(unavailableRoot, { recursive: true, force: true }); }
});

test("locked dependency is bundled offline and retained in immutable release", async () => {
  const files = await resolveDependencies({ ...source("async input=>({numeric:(await import('is-number')).default((input as {value:unknown}).value)})"), "package.json": JSON.stringify({ dependencies: { "is-number": "7.0.0" } }) });
  const result = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
  expect(result.diagnostics).toEqual([]);
  const artifacts = await runner.collectArtifacts(result.artifactDigest!);
  expect(JSON.parse(artifacts[".runner/dependencies.json"]!)["node_modules/is-number/index.js"]).toBeDefined();
}, 60_000);

test("kernel PID, temporary storage, memory and descendant cancellation limits hold", async () => {
  const files = source(`async (value) => {
    const input = value as {action:string};
    if(input.action==='oom'){const values:Uint8Array[]=[];while(true){values.push(new Uint8Array(8*1024*1024).fill(123));await Bun.sleep(1)}}
    if(input.action==='disk'){try{await Bun.write('/tmp/full',new Uint8Array(20*1024*1024));return {limited:false}}catch{return {limited:true}}}
    const children:{kill:()=>void}[]=[];let spawnFailure:string|null=null;try{for(let index=0;index<100;index++)children.push(Bun.spawn(['/bin/sleep','60'],{stdout:'ignore',stderr:'ignore'}))}catch(error){spawnFailure=String((error as NodeJS.ErrnoException).code)};
    if(input.action==='pids'){for(const child of children)child.kill();return {children:children.length,spawnFailure}}
    await new Promise(()=>{});return {};
  }`);
  const result = await runner.build({ operationId: randomUUID(), files, sourceDigest: filesDigest(files), entrypoint: "extension.ts", limits: buildLimits });
  expect(result.diagnostics).toEqual([]);
  for (const action of ["disk", "pids", "cancel", "oom"]) {
    const workerId = randomUUID();
    const context = { workerId, invocationId: randomUUID(), releaseId: result.artifactDigest!, principalId: "user-a", scopeId: "scope-a", token: "test-token", deadline: Date.now() + 20_000 };
    const limits = { ...executionLimits, memoryBytes: 128 * 1024 ** 2, pids: 32, tmpBytes: 8 * 1024 ** 2 };
    const worker = await runner.start({ workerId, artifactDigest: result.artifactDigest!, context, limits }, async () => null);
    const pending = worker.request("extension/invoke", { name: "echo", input: { action }, context });
    if (action === "disk") expect(await pending).toEqual({ limited: true });
    else if (action === "pids") { const output = await pending as { children: number; spawnFailure: string | null }; expect(output.children).toBeLessThan(32); expect(output.children).toBeGreaterThan(0); expect(output.spawnFailure).toBe("EAGAIN"); }
    else if (action === "cancel") { const rejected = expect(pending).rejects.toThrow(); await Bun.sleep(300); await runner.cancel(workerId); await rejected; }
    else { await expect(pending).rejects.toThrow(); await worker.exited; await Bun.sleep(100); expect((await runner.inspect(workerId)).diagnostics.some(diagnostic => diagnostic.code === "memory_limit")).toBe(true); }
    await worker.close();
    expect(await command("podman", ["ps", "-a", "--filter", `name=ez-v4-${(await import('../src/core')).sha256(`${root}:${workerId}`).slice(0,32)}`, "--format={{.Names}}"])).toBe("");
  }
}, 120_000);
