import { expect, test } from "bun:test";
import { createMcpExtension } from "./mcp";
import { normalizeMcpCatalog, valueSchemaValidator } from "@ezcorp/extension-contract";

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
