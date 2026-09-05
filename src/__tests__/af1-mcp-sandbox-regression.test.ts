import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PodmanRunner, provisionToolchain, buildLimits, filesDigest } from "@ezcorp/extension-runner";
import { mcpReleaseFixture } from "./helpers/mcp-release-fixture";

let root: string;
let runner: PodmanRunner;
let fixture: ReturnType<typeof mcpReleaseFixture>;
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-runner-envelope-"));
  runner = new PodmanRunner({ root, ...await provisionToolchain() });
  await runner.initialize();
  const manifest = { schemaVersion: 4, name: "mcp-envelope", version: "1.0.0", description: "Isolated MCP probe", author: { name: "Tests" }, kind: "mcp", permissions: {}, mcpServers: [{ name: "probe", transport: "stdio", command: "/usr/local/bin/bun", args: ["/workspace/server.js"] }] };
  const files = {
    "extension.ts": `import {createMcpExtension,serve} from '@ezcorp/sdk/v4';await serve(await createMcpExtension({manifest:${JSON.stringify(manifest)}}));`,
    "metadata.test.ts": "import {test,expect} from 'bun:test';test('source',()=>expect(true).toBe(true));",
    "server.js": `const fs=require('node:fs');const os=require('node:os');const readline=require('node:readline');const lines=readline.createInterface({input:process.stdin});for await(const line of lines){const message=JSON.parse(line);if(!Object.hasOwn(message,'id'))continue;const result=message.method==='initialize'?{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'probe',version:'1'}}:message.method==='tools/list'?{tools:[{name:'probe',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:JSON.stringify({env:process.env,uid:process.getuid(),status:fs.readFileSync('/proc/self/status','utf8'),memory:fs.readFileSync('/sys/fs/cgroup/memory.max','utf8').trim(),interfaces:os.networkInterfaces(),pid:process.pid})}],isError:false};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\\n');}`,
  };
  const build = await runner.build({ operationId: crypto.randomUUID(), sourceDigest: filesDigest(files), files, entrypoint: "extension.ts", limits: buildLimits });
  expect(build.state, JSON.stringify(build.diagnostics)).toBe("succeeded");
  fixture = mcpReleaseFixture({ name: "mcp-envelope", tools: build.manifest!.tools, runner });
  fixture.snapshot.release.manifest = build.manifest!;
  fixture.snapshot.release.artifactDigest = build.artifactDigest!;
  fixture.registry.setManifestForTest(fixture.id, build.manifest!);
}, 120_000);
afterAll(async () => { fixture?.cleanup(); await runner?.close(); if (root) await rm(root, { recursive: true, force: true }); });

async function probe() {
  const client = await fixture.registry.getMcpClient(fixture.id);
  const result = await client.callTool("probe", {}, fixture.meta);
  expect(result.isError).toBe(false);
  return JSON.parse(result.content[0]!.text!) as { env: Record<string, string>; uid: number; status: string; memory: string; interfaces: Record<string, unknown>; pid: number };
}

test("isolated MCP child never inherits host network flags, shell flags or secrets", async () => {
  const keys = ["EZCORP_PERMITTED_HOSTS", "EZCORP_SHELL_ALLOWED", "AF1_SECRET_LEAK"];
  const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
  try {
    for (const key of keys) process.env[key] = "secret-host-value";
    const value = await probe();
    for (const key of keys) expect(value.env[key]).toBeUndefined();
    expect(value.env.PATH).toBeDefined();
  } finally { for (const key of keys) if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});

test("offline MCP networking remains isolated even if host projection grants network", async () => {
  fixture.registry.setGrantedPermsForTest(fixture.id, { grantedAt: { network: Date.now() }, network: ["api.example.com"] });
  const value = await probe();
  expect(value.env.EZCORP_PERMITTED_HOSTS).toBeUndefined();
  expect(Object.keys(value.interfaces)).toEqual(["lo"]);
});

test("MCP children retain non-root, cgroup memory, seccomp and no-new-privileges controls", async () => {
  const value = await probe();
  expect(value.uid).toBe(65534);
  expect(Number(value.memory)).toBe(fixture.snapshot.limits.memoryBytes);
  expect(value.status).toMatch(/NoNewPrivs:\s+1/);
  expect(value.status).toMatch(/Seccomp:\s+2/);
  expect(value.status).toMatch(/CapEff:\s+0+/);
});

test("MCP initialize, sealed catalog and tool invocation work through the actual runner", async () => {
  const client = await fixture.registry.getMcpClient(fixture.id);
  expect((await client.listTools()).map(tool => tool.name)).toEqual(["probe"]);
  expect((await probe()).pid).toBeGreaterThan(0);
  expect(client.getChildProcess()).toBeNull();
});
