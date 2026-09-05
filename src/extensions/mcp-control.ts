import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { readMcpCatalog } from "@ezcorp/sdk/v4";
import { validateManifest, valueSchemaValidator } from "@ezcorp/extension-contract";
import { guardedStreamingFetch } from "../search/egress";
import { getUserById } from "../db/queries/users";
import { insertAuditEntry } from "../db/queries/audit-log";
import { getExtension, persistMcpSecret, rehydrateMcpServerSecrets } from "../db/queries/extensions";
import { getExtensionLifecycle } from "./extension-lifecycle-service";
import { mcpManifestPermissions, mcpNetworkHosts, withMcpToolCapabilities } from "./mcp-capabilities";
import { mcpReleaseSecretScope, mcpServerHasPlaintextSecret, mergeMcpServerSecrets, redactMcpServer } from "./mcp-secret-redaction";
import { LifecycleError, type LifecycleActor } from "./v4/types";
import type { McpServerDefinition } from "./types";

async function requireAdministrator(actor: LifecycleActor): Promise<void> {
  const user = await getUserById(actor.principalId);
  if (actor.kind !== "human" || user?.status !== "active" || user.role !== "admin") throw new LifecycleError("forbidden", "A human administrator must stage an MCP source release");
}

export async function probeRemoteMcp(server: Exclude<McpServerDefinition, { transport: "stdio" }>, authorize: () => Promise<void>, fetcher = guardedStreamingFetch) {
  const target = new URL(server.url);
  if (!["http:", "https:"].includes(target.protocol) || target.username || target.password || target.hash) throw new LifecycleError("invalid_source", "MCP requires an HTTP URL without user info or fragments");
  const deadline = Date.now() + 30_000;
  const transportFetch = ((input: Request | string | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : new Request(String(input), init);
    return fetcher(request.url, { ...init, method: init?.method ?? request.method, headers: init?.headers ?? request.headers, body: init?.body ?? request.body, signal: init?.signal ?? request.signal }, { mode: "read", maxBodyBytes: 2 * 1024 * 1024, timeoutMs: Math.max(1, deadline - Date.now()), maxRedirects: 3, retryConnectionFailures: false, authorizeUrl: async url => {
      if (Date.now() >= deadline || url.origin !== target.origin) throw new LifecycleError("forbidden", "MCP probe cannot leave its approved origin");
      await authorize();
    } });
  }) as typeof fetch;
  const client = new Client({ name: "ezcorp-mcp-probe", version: "4.0.0" }, { capabilities: {}, jsonSchemaValidator: valueSchemaValidator });
  const options = { fetch: transportFetch, requestInit: { headers: server.headers ?? {} } };
  const transport = server.transport === "sse" ? new SSEClientTransport(target, options) : new StreamableHTTPClientTransport(target, options);
  try {
    await authorize();
    await client.connect(transport, { timeout: 30_000 });
    return await readMcpCatalog(client);
  } finally { await client.close(); }
}

export async function stageMcpExtension(actor: LifecycleActor, input: { name: string; description?: string; server: McpServerDefinition; installationId?: string }) {
  await requireAdministrator(actor);
  const permissions = mcpManifestPermissions(input.server);
  let manifest = validateManifest({ schemaVersion: 4, name: input.name, version: "1.0.0", description: input.description ?? "MCP extension", author: { name: actor.principalId }, kind: "mcp", permissions, mcpServers: [redactMcpServer(input.server)], tools: [] });
  if (input.server.transport === "stdio") {
    if (mcpNetworkHosts(input.server).length || mcpServerHasPlaintextSecret(input.server)) throw new LifecycleError("unsupported_mcp_profile", "The offline stdio profile cannot use network or credentials. Use HTTP/SSE, or package an offline server in an approved image.");
    if (["npx", "npm", "bunx"].includes(input.server.command)) throw new LifecycleError("unsupported_mcp_profile", "Package a pinned offline executable before building. Runtime package installation is not supported.");
  } else {
    try {
      const tools = await probeRemoteMcp(input.server, () => requireAdministrator(actor));
      manifest = validateManifest({ ...manifest, tools: withMcpToolCapabilities(tools, permissions) });
    } catch { throw new LifecycleError("mcp_probe_failed", "MCP catalog probe failed. Check the public endpoint and credentials; no release was activated."); }
  }
  const files = {
    "mcp.manifest.json": JSON.stringify(manifest, null, 2),
    "extension.ts": "import {createMcpExtension,serve} from '@ezcorp/sdk/v4';import manifest from './mcp.manifest.json';await serve(await createMcpExtension({manifest}));\n",
    "metadata.test.ts": "import {test,expect} from 'bun:test';import {validateManifest} from '@ezcorp/sdk/v4';import manifest from './mcp.manifest.json';test('MCP metadata',()=>expect(validateManifest(manifest).kind).toBe('mcp'));\n",
  };
  const lifecycle = await getExtensionLifecycle();
  const created = await lifecycle.createWorkspace(actor, { files, ...(input.installationId ? { installationId: input.installationId } : {}) });
  await persistMcpSecret(mcpReleaseSecretScope(created.workspace.id), input.server);
  const operation = await lifecycle.build(actor, { installationId: created.installation.id, workspaceId: created.workspace.id, expectedRevision: created.workspace.revision, idempotencyKey: `mcp-stage:${created.workspace.sourceDigest}` });
  void lifecycle.runBuild(actor, created.installation.id, operation.id).catch(() => undefined);
  await insertAuditEntry(actor.principalId, "extension.mcp.release_staged", created.installation.id, { workspaceId: created.workspace.id, operationId: operation.id, transport: input.server.transport });
  return { ...created, operation, openUrl: `/extensions/author?installation=${encodeURIComponent(created.installation.id)}&workspace=${encodeURIComponent(created.workspace.id)}` };
}

export async function restageMcpExtension(actor: LifecycleActor, id: string, update?: { server: McpServerDefinition; description?: string }) {
  await requireAdministrator(actor);
  const existing = await getExtension(id);
  const manifest = existing?.manifest;
  const server = manifest?.mcpServers?.[0];
  if (!existing || manifest?.kind !== "mcp" || !server) throw new LifecycleError("not_found", "MCP extension not found");
  if (manifest.schemaVersion !== 4) throw new LifecycleError("migration_required", "Legacy MCP connections must be staged as a new v4 source release");
  const state = await (await getExtensionLifecycle()).inspect(actor, id);
  const release = state.installation.activeReleaseId ? state.releases[state.installation.activeReleaseId] : undefined;
  if (!release) throw new LifecycleError("release_required", "An active release is required before editing this connection");
  const previous = await rehydrateMcpServerSecrets(mcpReleaseSecretScope(release.workspaceId), server);
  return stageMcpExtension(actor, { name: existing.name, description: update?.description ?? manifest.description, server: update ? mergeMcpServerSecrets(update.server, previous) : previous, installationId: id });
}
