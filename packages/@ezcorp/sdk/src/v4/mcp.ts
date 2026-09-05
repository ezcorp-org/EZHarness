import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ContractError, canonicalJson, compileValueSchema, normalizeMcpCatalog, valueSchemaValidator } from "@ezcorp/extension-contract";
import type { ToolDefinitionV4 } from "@ezcorp/extension-contract";
import { defineExtension } from "./index";
import type { DefinedExtension, ExtensionHandler } from "./index";
import { defineRuntimeManifest } from "./runtime";

export async function readMcpCatalog(instance: Pick<Client, "listTools">): Promise<ToolDefinitionV4[]> {
  const tools: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const list = await instance.listTools(cursor ? { cursor } : undefined);
    tools.push(...list.tools);
    if (tools.length > 128 || (list.nextCursor && cursors.has(list.nextCursor))) throw new ContractError("DATA_LIMIT", "MCP catalog exceeds bounds or repeats a cursor");
    cursor = list.nextCursor;
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return normalizeMcpCatalog(tools);
}

export async function createMcpExtension(options: { manifest: unknown }): Promise<DefinedExtension> {
  const manifest = structuredClone(defineRuntimeManifest(options.manifest));
  manifest.permissions.mcpInvoke = true;
  const server = manifest.mcpServers?.[0];
  if (manifest.kind !== "mcp" || manifest.mcpServers?.length !== 1 || !server) throw new ContractError("INVALID_MCP", "The MCP adapter requires one declared server");
  if (server.transport !== "stdio") {
    const tools = Object.fromEntries((manifest.tools ?? []).map(tool => [tool.name, () => { throw new ContractError("HOST_MEDIATED_MCP", "Remote MCP calls require the host release broker"); }]));
    return defineExtension({ manifest, tools });
  }
  if (!server.command || server.command.length > 240 || server.command.includes("\0")) throw new ContractError("INVALID_MCP", "Invalid packaged MCP command");
  const { command, args, env } = server;
  function client() {
    const instance = new Client({ name: "ezcorp-extension-v4", version: "4.0.0" }, {
      capabilities: {},
      jsonSchemaValidator: valueSchemaValidator,
    });
    const transport = new StdioClientTransport({ command, args: args ?? [], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env }, stderr: "ignore" });
    return { instance, transport };
  }
  const discovery = client();
  let tools: ToolDefinitionV4[];
  try {
    await discovery.instance.connect(discovery.transport, { timeout: 30_000 });
    tools = await readMcpCatalog(discovery.instance);
  } finally { await discovery.instance.close(); }
  const approvedCatalog = canonicalJson(tools);
  const handlers: Record<string, ExtensionHandler> = {};
  for (const tool of tools) handlers[tool.name] = async (input, context) => {
    const execution = client();
    try {
      await execution.instance.connect(execution.transport, { timeout: Math.max(1, context.invocation.deadline - Date.now()) });
      if (canonicalJson(await readMcpCatalog(execution.instance)) !== approvedCatalog) throw new ContractError("CATALOG_MISMATCH", "MCP tool catalog changed after release discovery");
      const result = await execution.instance.callTool({ name: tool.name, arguments: input as Record<string, unknown> }, undefined, { signal: context.signal, timeout: Math.max(1, context.invocation.deadline - Date.now()) });
      if (tool.mcpOutputSchema && !result.isError) compileValueSchema(tool.mcpOutputSchema)(result.structuredContent);
      return { ...result, isError: result.isError === true };
    } finally { await execution.instance.close(); }
  };
  const declaredTools = tools.map(tool => ({ ...tool, capabilities: { ...(manifest.permissions.network?.length ? { network: { hosts: manifest.permissions.network } } : {}), custom: { "ezcorp:mcp:invoke": true } } }));
  return defineExtension({ manifest: { ...manifest, tools: declaredTools }, tools: handlers });
}
