import { canonicalJson, normalizeMcpCatalog, validateManifest } from "@ezcorp/extension-contract";
import type { Runner, ToolDefinitionV4 } from "@ezcorp/extension-contract";
import { configureReleaseRuntime } from "../../extensions/release-process";
import type { ActiveExtensionRelease } from "../../extensions/release-process";
import { ExtensionRegistry } from "../../extensions/registry";
import { registerCallProvenance, releaseCallProvenance } from "../../extensions/call-provenance";
import { _setPermissionEngineForTests } from "../../extensions/permission-engine";
import { createStubPermissionEngine } from "./permission-engine-stub";

export function mcpReleaseFixture(options: { id?: string; name?: string; tools?: ToolDefinitionV4[]; runner?: Runner } = {}) {
  const id = options.id ?? "mcp-release";
  const manifest = validateManifest({ schemaVersion: 4, name: options.name ?? "mcp-release", version: "1.0.0", description: "MCP release fixture", author: { name: "Tests" }, kind: "mcp", mcpServers: [{ name: "packaged", transport: "stdio", command: "/packaged/mcp" }], permissions: {}, tools: options.tools ?? normalizeMcpCatalog([{ name: "echo", description: "Echo", inputSchema: { type: "object" } }]) });
  const snapshot: ActiveExtensionRelease = {
    installation: { id, ownerId: "owner", scope: "global", activeReleaseId: "release", generation: 1, enabled: true, uninstalled: false, status: "active", grants: [], acknowledgedGeneration: 1 },
    release: { id: "release", installationId: id, workspaceId: "workspace", workspaceRevision: 1, sourceDigest: "source", artifactDigest: "artifact", imageDigest: "image", runnerProfile: "secure", releaseDigest: "digest", policyDigest: "policy", createdAt: "2026-09-05", evidence: { protocolVersion: 4, validatorVersion: "v4", tests: [{ name: "fixture", passed: true }], discoveryDigest: "discovery" }, manifest },
    limits: { memoryBytes: 512 * 1024 * 1024, cpuMillis: 1000, pids: 64, tmpBytes: 64 * 1024 * 1024, outputBytes: 1024 * 1024, timeoutMs: 60_000 },
  };
  snapshot.installation.grants.push(canonicalJson(["mcpInvoke", true]));
  manifest.permissions.mcpInvoke = true;
  _setPermissionEngineForTests(createStubPermissionEngine());
  let starts = 0;
  let closed = 0;
  let invoke: (input: Record<string, unknown>) => Promise<unknown> = async input => ({ content: [{ type: "text", text: canonicalJson(input) }], isError: false });
  let discover = () => structuredClone(snapshot.release.manifest);
  const runner: Runner = {
    build: async () => { throw new Error("Unexpected build"); }, cancel: async () => {}, inspect: async workerId => ({ id: workerId, state: "running", diagnostics: [] }), collectArtifacts: async () => ({}),
    start: async input => {
      starts++;
      return { workerId: input.workerId, request: async (method, params) => method === "extension/discover" ? discover() : invoke(params as Record<string, unknown>), close: async () => { closed++; }, onNotification: () => () => {} };
    },
  };
  configureReleaseRuntime({ runner: async () => options.runner ?? runner, resolve: async installationId => installationId === id ? structuredClone(snapshot) : null });
  const registry = ExtensionRegistry.getInstance();
  registry.setManifestForTest(id, manifest);
  const token = registerCallProvenance({ actorExtensionId: id, onBehalfOf: "owner", conversationId: "conversation", ownerless: false, runId: null, parentCallId: null, kind: "tool" });
  return { id, manifest, snapshot, registry, token, meta: { ezCallId: token }, starts: () => starts, closed: () => closed, invoke: (handler: typeof invoke) => { invoke = handler; }, discover: (handler: typeof discover) => { discover = handler; }, cleanup: () => { registry.killAll(); releaseCallProvenance(token); } };
}
