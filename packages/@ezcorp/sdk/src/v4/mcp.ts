import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ContractError, canonicalJson, compileValueSchema, normalizeMcpCatalog, valueSchemaValidator } from "@ezcorp/extension-contract";
import type { ToolDefinitionV4 } from "@ezcorp/extension-contract";
import { defineExtension } from "./index";
import type { DefinedExtension, ExtensionHandler } from "./index";
import { defineRuntimeManifest } from "./runtime";
import { startNativeProxy } from "./native-proxy";
import { readGrantedCredential, withExtensionContext } from "./context";

export async function readMcpCatalog(instance: Pick<Client, "listTools">): Promise<ToolDefinitionV4[]> {
  const tools: unknown[] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  let pages = 0;
  do {
    if (++pages > 128) throw new ContractError("DATA_LIMIT", "MCP catalog exceeds page bounds");
    const list = await instance.listTools(cursor ? { cursor } : undefined);
    if (list.nextCursor && new TextEncoder().encode(list.nextCursor).byteLength > 1024) throw new ContractError("DATA_LIMIT", "MCP catalog cursor exceeds bounds");
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
  function client(proxyEnvironment: Record<string, string> = {}) {
    const instance = new Client({ name: "ezcorp-extension-v4", version: "4.0.0" }, {
      capabilities: {},
      jsonSchemaValidator: valueSchemaValidator,
    });
    const transport = new StdioClientTransport({ command, args: args ?? [], env: { PATH: process.env.PATH ?? "/usr/bin:/bin", ...env, ...proxyEnvironment }, stderr: "ignore" });
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
    const proxy = await startNativeProxy(context);
    const credentials: Record<string, string> = {};
    let execution: ReturnType<typeof client> | undefined;
    try {
      for (const name of manifest.permissions.secretRead ?? []) {
        const value = await withExtensionContext(context, () => readGrantedCredential(name));
        if (value === null) throw new ContractError("CREDENTIAL_DENIED", "The current caller cannot read a required provider credential");
        credentials[name] = value;
      }
      execution = client({ ...credentials, ...proxy.environment });
      await execution.instance.connect(execution.transport, { timeout: Math.max(1, context.invocation.deadline - Date.now()) });
      if (canonicalJson(await readMcpCatalog(execution.instance)) !== approvedCatalog) throw new ContractError("CATALOG_MISMATCH", "MCP tool catalog changed after release discovery");
      const result = await execution.instance.callTool({ name: tool.name, arguments: input as Record<string, unknown> }, undefined, { signal: context.signal, timeout: Math.max(1, context.invocation.deadline - Date.now()) });
      if (tool.mcpOutputSchema && !result.isError) compileValueSchema(tool.mcpOutputSchema)(result.structuredContent);
      return { ...result, isError: result.isError === true };
    } finally {
      try { await execution?.instance.close(); }
      finally { for (const name of Object.keys(credentials)) delete credentials[name]; await proxy.close(); }
    }
  };
  const declaredTools = tools.map(tool => ({ ...tool, capabilities: { ...(manifest.permissions.network?.length ? { network: { hosts: manifest.permissions.network } } : {}), custom: { "ezcorp:mcp:invoke": true, ...(manifest.permissions.networkTcp?.length ? { "ezcorp:network:tcp": manifest.permissions.networkTcp } : {}), ...(manifest.permissions.secretRead?.length ? { "ezcorp:credentials:read": manifest.permissions.secretRead } : {}) } } }));
  return defineExtension({ manifest: { ...manifest, tools: declaredTools }, tools: handlers });
}
