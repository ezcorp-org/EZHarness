import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { readMcpCatalog } from "@ezcorp/sdk/v4";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { ContractError, canonicalJson, compileValueSchema, normalizeMcpCatalog, valueSchemaValidator } from "@ezcorp/extension-contract";
import { McpClient } from "../mcp/client";
import { guardedStreamingFetch } from "../search/egress";
import { rehydrateMcpWorkspaceCredentials } from "./mcp-workspace-credentials";
import { resolveCallProvenance } from "./call-provenance";
import { getPermissionEngine } from "./permission-engine";
import { getReleaseRuntime, releaseBinding, resolveActiveRelease } from "./release-process";
import type { ReleaseRuntimeDependencies } from "./release-process";
import type { ExtensionProcess } from "./subprocess";
import type { ToolCallResult, ToolDefinition } from "./types";

export interface ReleaseMcpServices {
  client(): Client;
  secrets: typeof rehydrateMcpWorkspaceCredentials;
  fetch: typeof guardedStreamingFetch;
  permissionEngine: typeof getPermissionEngine;
}
const services: ReleaseMcpServices = {
  client: () => new Client({ name: "ezcorp-release", version: "4.0.0" }, { capabilities: {}, jsonSchemaValidator: valueSchemaValidator }),
  secrets: rehydrateMcpWorkspaceCredentials,
  fetch: guardedStreamingFetch,
  permissionEngine: getPermissionEngine,
};

export class ReleaseMcpClient extends McpClient {
  private ready = false;
  private readonly remote: ReleaseMcpServices;
  constructor(private readonly extensionId: string, private readonly process: () => Promise<ExtensionProcess>, private readonly runtime: ReleaseRuntimeDependencies = getReleaseRuntime(), remote: Partial<ReleaseMcpServices> = {}) {
    super({ name: "release", transport: "http", url: "https://invalid.invalid" });
    this.remote = { ...services, ...remote };
  }
  override get isConnected(): boolean { return this.ready; }
  override async connect(): Promise<void> { await resolveActiveRelease(this.extensionId, this.runtime); this.ready = true; }
  override async close(): Promise<void> { this.ready = false; }
  override getChildProcess(): null { return null; }
  override async listTools(): Promise<ToolDefinition[]> { return (await resolveActiveRelease(this.extensionId, this.runtime)).release.manifest.tools ?? []; }
  override async callTool(name: string, args: Record<string, unknown>, meta?: Record<string, unknown>): Promise<ToolCallResult> {
    if (!this.ready) throw new ContractError("CLOSED", "MCP release client is closed");
    const snapshot = await resolveActiveRelease(this.extensionId, this.runtime);
    const manifest = snapshot.release.manifest;
    const server = manifest.mcpServers?.[0];
    if (manifest.kind !== "mcp" || manifest.mcpServers?.length !== 1 || !server) throw new ContractError("INVALID_MCP", "Approved MCP release must declare one server");
    const token = typeof meta?.ezCallId === "string" ? meta.ezCallId : undefined;
    const provenance = token ? resolveCallProvenance(token) : undefined;
    if (!token || !provenance || provenance.actorExtensionId !== this.extensionId || provenance.ownerless || !provenance.onBehalfOf) throw new ContractError("INVALID_CALL_TOKEN", "MCP calls require an active extension invocation");
    const tool = manifest.tools?.find(tool => tool.name === name);
    if (!tool) throw new ContractError("UNDECLARED_CONTRIBUTION", "MCP tool is not approved");
    compileValueSchema(tool.inputSchema)(args);
    if (manifest.permissions.mcpInvoke !== true || !snapshot.installation.grants.includes(canonicalJson(["mcpInvoke", true]))) throw new ContractError("CAPABILITY_DENIED", "MCP invocation requires an approved invocation grant");
    const invocationDecision = await this.remote.permissionEngine().authorize({ extensionId: this.extensionId, userId: provenance.onBehalfOf, conversationId: provenance.conversationId, toolName: name }, [{ kind: "ezcorp:mcp:invoke" }]);
    if (invocationDecision.decision !== "allow") throw new ContractError("CAPABILITY_DENIED", "MCP invocation was not approved");
    if (server.transport === "stdio") return (await this.process()).callTool(name, args, meta);
    const binding = releaseBinding(snapshot);
    const deadline = Date.now() + snapshot.limits.timeoutMs;
    const origin = new URL(server.url).origin;
    const network = manifest.permissions.network ?? [];
    const approved = snapshot.installation.grants.includes(canonicalJson(["network", network]));
    const authorize = async (url: URL) => {
      const live = resolveCallProvenance(token);
      if (!this.ready || Date.now() >= deadline || !live || live.actorExtensionId !== this.extensionId || live.onBehalfOf !== provenance.onBehalfOf || live.conversationId !== provenance.conversationId || releaseBinding(await resolveActiveRelease(this.extensionId, this.runtime)) !== binding) throw new ContractError("RELEASE_CHANGED", "MCP invocation is no longer active");
      if (!approved || url.origin !== origin) throw new ContractError("CAPABILITY_DENIED", "MCP origin requires an exact approved network grant");
      const decision = await this.remote.permissionEngine().authorize({ extensionId: this.extensionId, userId: provenance.onBehalfOf, conversationId: provenance.conversationId, toolName: name }, [{ kind: "network", value: url.hostname.toLowerCase() }, { kind: "ezcorp:mcp:invoke" }]);
      if (decision.decision !== "allow") throw new ContractError("CAPABILITY_DENIED", "MCP network access is not approved");
    };
    await authorize(new URL(server.url));
    const hydrated = await this.remote.secrets(this.extensionId, snapshot.release.workspaceId, server);
    if (hydrated.transport === "stdio") throw new ContractError("INVALID_MCP", "MCP transport changed");
    const fetcher = ((input: string | URL | Request, init?: RequestInit) => {
      const request = input instanceof Request ? input : new Request(String(input), init);
      return this.remote.fetch(request.url, { ...init, method: init?.method ?? request.method, headers: init?.headers ?? request.headers, body: init?.body ?? request.body, signal: init?.signal ?? request.signal }, { mode: "read", authorizeUrl: authorize, timeoutMs: Math.max(1, deadline - Date.now()), maxBodyBytes: 32 * 1024 * 1024, maxRedirects: 3, retryConnectionFailures: false });
    }) as typeof fetch;
    const client = this.remote.client();
    const options = { fetch: fetcher, requestInit: { headers: hydrated.headers ?? {} } };
    const transport = hydrated.transport === "sse" ? new SSEClientTransport(new URL(hydrated.url), options) : new StreamableHTTPClientTransport(new URL(hydrated.url), options);
    try {
      await client.connect(transport, { timeout: Math.max(1, deadline - Date.now()) });
      const tools = await readMcpCatalog(client);
      const declared = normalizeMcpCatalog((manifest.tools ?? []).map(tool => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema, ...(tool.mcpOutputSchema ? { outputSchema: tool.mcpOutputSchema } : {}) })));
      if (canonicalJson(tools) !== canonicalJson(declared)) throw new ContractError("CATALOG_MISMATCH", "MCP catalog changed; build and approve a new release");
      await authorize(new URL(server.url));
      const result = await client.callTool({ name, arguments: args }, undefined, { timeout: Math.max(1, deadline - Date.now()) });
      await authorize(new URL(server.url));
      if (tool.mcpOutputSchema && !result.isError) compileValueSchema(tool.mcpOutputSchema)(result.structuredContent);
      const output = { ...result, isError: result.isError === true };
      compileValueSchema(tool.outputSchema)(output);
      return output as ToolCallResult;
    } finally { await client.close(); }
  }
}
