import { expect, test } from "bun:test";
import { createMcpExtension, readMcpCatalog } from "./mcp";
import { normalizeMcpCatalog, valueSchemaValidator } from "@ezcorp/extension-contract";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("remote descriptors never execute network calls inside the worker", async () => {
  const extension = await createMcpExtension({ manifest: { schemaVersion: 4, name: "remote", version: "1.0.0", description: "Remote", author: { name: "Tests" }, permissions: {}, kind: "mcp", mcpServers: [{ name: "remote", transport: "http", url: "https://example.com/mcp" }], tools: normalizeMcpCatalog([{ name: "echo", inputSchema: { type: "object" } }]) } });
  expect(extension.manifest.permissions.mcpInvoke).toBe(true);
  const context = { invocation: { invocationId: "test", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "scope", token: "token", deadline: Date.now() + 30_000 }, signal: new AbortController().signal, call: async () => null };
  await expect(extension.invoke("echo", {}, context)).rejects.toThrow("host release broker");
});

test("catalog pagination is bounded and rejects repeated cursors", async () => {
  let calls = 0;
  const client = { listTools: async () => ({ tools: [{ name: `tool${calls++}`, inputSchema: { type: "object" as const } }], nextCursor: calls === 1 ? "next" : undefined }) };
  expect(await readMcpCatalog(client)).toHaveLength(2);
  await expect(readMcpCatalog({ listTools: async () => ({ tools: [], nextCursor: "again" }) })).rejects.toThrow("repeats");
  await expect(readMcpCatalog({ listTools: async () => ({ tools: Array.from({ length: 129 }, (_, index) => ({ name: `tool${index}`, inputSchema: { type: "object" as const } })) }) })).rejects.toThrow("bounds");
});

test("empty catalog pages and cursor bytes have independent limits", async () => {
  let pages = 0;
  await expect(readMcpCatalog({ listTools: async () => ({ tools: [], nextCursor: String(++pages) }) })).rejects.toThrow("page bounds");
  expect(pages).toBe(128);
  await expect(readMcpCatalog({ listTools: async () => ({ tools: [], nextCursor: "é".repeat(513) }) })).rejects.toThrow("cursor exceeds bounds");
  let calls = 0;
  expect(await readMcpCatalog({ listTools: async () => ({ tools: [], nextCursor: ++calls === 1 ? "é".repeat(512) : undefined }) })).toEqual([]);
});

test("stdio MCP discovery and invocation use a fresh protocol client and checked schemas", async () => {
  const extension = await createMcpExtension({ manifest: { schemaVersion: 4, name: "mcp-test", version: "1.0.0", description: "Fixture", author: { name: "Tests" }, permissions: {}, kind: "mcp", mcpServers: [{ name: "fixture", transport: "stdio", command: process.execPath, args: [new URL("./__tests__/mcp-fixture.ts", import.meta.url).pathname] }] } });
  expect(extension.manifest.tools?.map(tool => tool.name)).toEqual(["echo"]);
  const context = { invocation: { invocationId: "test", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "scope", token: "token", deadline: Date.now() + 30_000 }, signal: new AbortController().signal, call: async () => { throw new Error("Host calls forbidden"); } };
  expect(await extension.invoke("echo", { text: "hello" }, context)).toMatchObject({ content: [{ type: "text", text: "hello" }], structuredContent: { text: "hello" }, isError: false });
  await expect(extension.invoke("echo", { text: 1 }, context)).rejects.toThrow();
  await expect(createMcpExtension({ manifest: { ...extension.manifest, kind: "tool" } })).rejects.toThrow();
});

test("MCP catalogs reject unsafe schemas, duplicates and invalid data", () => {
  const tool = { name: "echo", inputSchema: { type: "object" } };
  expect(normalizeMcpCatalog([tool])[0]?.description).toBe("echo");
  for (const value of [null, [tool, tool], [{ ...tool, name: "../unsafe" }], [{ ...tool, inputSchema: { pattern: "(a)\\1" } }]]) expect(() => normalizeMcpCatalog(value)).toThrow();
  const validator = valueSchemaValidator.getValidator<{ value: string }>({ type: "object", required: ["value"], properties: { value: { type: "string" } } });
  expect(validator({ value: "yes" })).toMatchObject({ valid: true });
  expect(validator({ value: 1 })).toMatchObject({ valid: false });
});

test.skipIf(process.env.EZCORP_RUN_PODMAN_TESTS !== "1")("MCP executable discovers and invokes in a networkless rootless container", async () => {
  const directory = await mkdtemp(join(tmpdir(), "sdk-mcp-isolated-"));
  await chmod(directory, 0o755);
  let child: ReturnType<typeof Bun.spawn> | undefined;
  try {
    const info = Bun.spawn(["podman", "info", "--format", "{{.Host.Security.Rootless}}"], { stdout: "pipe", stderr: "pipe" });
    expect((await new Response(info.stdout).text()).trim()).toBe("true");
    expect(await info.exited).toBe(0);
    for (const [source, target] of [["mcp-fixture.ts", "server.js"], ["mcp-isolated-fixture.ts", "extension.js"]]) {
      const build = Bun.spawn([process.execPath, "build", new URL(`./__tests__/${source}`, import.meta.url).pathname, "--target=bun", `--outfile=${join(directory, target!)}`], { stdout: "ignore", stderr: "pipe" });
      const diagnostics = await new Response(build.stderr).text();
      expect(await build.exited, diagnostics).toBe(0);
      await chmod(join(directory, target!), 0o644);
    }
    child = Bun.spawn(["podman", "run", "--rm", "--pull=never", "-i", "--network=none", "--read-only", "--user=65534:65534", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--pids-limit=64", "--memory=512m", "--cpus=1", "--tmpfs=/tmp:rw,noexec,nosuid,size=16m", "-v", `${directory}:/workspace:ro`, "--workdir=/workspace", "--entrypoint=/usr/local/bin/bun", "docker.io/oven/bun@sha256:50317d83cd5a5ae1d8b35b3379c69f57ce1a0dbf4def91f0965653d767851834", "/workspace/extension.js"], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
    let buffered = "";
    async function frame(): Promise<Record<string, any>> {
      while (!buffered.includes("\n")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error(`Container exited: ${await new Response(child!.stderr as ReadableStream).text()}`);
        buffered += new TextDecoder().decode(chunk.value);
      }
      const end = buffered.indexOf("\n");
      const value = JSON.parse(buffered.slice(0, end));
      buffered = buffered.slice(end + 1);
      return value;
    }
    const stdin = child.stdin as import("bun").FileSink;
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "discover", method: "extension/discover", params: {} })}\n`);
    await stdin.flush();
    const discovery = await frame();
    expect(discovery.result.tools[0].name).toBe("echo");
    const context = { invocationId: "isolated", workerId: "worker", releaseId: "release", principalId: "user", scopeId: "scope", token: "token", deadline: Date.now() + 20_000 };
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: "invoke", method: "extension/invoke", params: { name: "echo", input: { text: "isolated" }, context } })}\n`);
    await stdin.flush();
    expect((await frame()).result).toMatchObject({ content: [{ type: "text", text: "isolated" }], isError: false });
    stdin.end();
    await reader.cancel();
    expect(await child.exited).toBe(0);
  } finally {
    child?.kill();
    await rm(directory, { recursive: true, force: true });
  }
}, 45_000);
