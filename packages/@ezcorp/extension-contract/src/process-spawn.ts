import type { ProcessSpawnPolicy, WorkspaceFiles } from "@ezcorp/extension-contract/types";
import { ContractError } from "./json";
import { validateManifest } from "./validation";

/**
 * The sealed SDK MCP bridge: the exact source that `stageMcpExtension` writes
 * for an MCP connection. Its bundle holds SDK code and the manifest data only,
 * so a release made of these files runs no code of its own author.
 */
export const MCP_BRIDGE_ENTRYPOINT = "extension.ts";
export const MCP_BRIDGE_MANIFEST = "mcp.manifest.json";
export const MCP_BRIDGE_TEST = "metadata.test.ts";
export const MCP_BRIDGE_SOURCE = "import {createMcpExtension,serve} from '@ezcorp/sdk/v4';import manifest from './mcp.manifest.json';await serve(await createMcpExtension({manifest}));\n";
export const MCP_BRIDGE_TEST_SOURCE = "import {test,expect} from 'bun:test';import {validateManifest} from '@ezcorp/sdk/v4';import manifest from './mcp.manifest.json';test('MCP metadata',()=>expect(validateManifest(manifest).kind).toBe('mcp'));\n";

/** The policy a start request carries. A request without one is denied. */
export function processSpawnPolicy(value: unknown): ProcessSpawnPolicy {
  if (value === undefined || value === "deny") return "deny";
  if (value === "allow") return value;
  throw new ContractError("INVALID_PROCESS_SPAWN", "processSpawn must be \"allow\" or \"deny\"", "$.processSpawn");
}

/** One declared MCP server, reached over stdio: the worker must start it as a process. */
export function declaresStdioMcpServer(manifest: { kind?: string; mcpServers?: readonly { transport?: string }[] }): boolean {
  return manifest.kind === "mcp" && manifest.mcpServers?.length === 1 && manifest.mcpServers[0]?.transport === "stdio";
}

function bridgeManifestDeclaresStdio(text: WorkspaceFiles[string] | undefined): boolean {
  if (typeof text !== "string") return false;
  try { return declaresStdioMcpServer(validateManifest(JSON.parse(text))); } catch { return false; }
}

/**
 * True only for a release whose code is the sealed SDK MCP bridge for one stdio
 * server: the bridge entrypoint byte for byte, its manifest, and optionally its
 * metadata test, and no other source file. Any other file could change what the
 * bundle loads (a `package.json`, `tsconfig.json` or `bunfig.toml`) or carry the
 * author's own code, so it makes the release an ordinary extension that needs
 * the shell grant to start a process. Runner-made `.runner/` files are ignored:
 * the runner wrote them from these sources.
 */
export function isPureStdioMcpSource(files: WorkspaceFiles, entrypoint: string): boolean {
  if (entrypoint !== MCP_BRIDGE_ENTRYPOINT || files[MCP_BRIDGE_ENTRYPOINT] !== MCP_BRIDGE_SOURCE) return false;
  if (MCP_BRIDGE_TEST in files && files[MCP_BRIDGE_TEST] !== MCP_BRIDGE_TEST_SOURCE) return false;
  const allowed = new Set([MCP_BRIDGE_ENTRYPOINT, MCP_BRIDGE_MANIFEST, MCP_BRIDGE_TEST]);
  if (Object.keys(files).some(path => !path.startsWith(".runner/") && !allowed.has(path))) return false;
  return bridgeManifestDeclaresStdio(files[MCP_BRIDGE_MANIFEST]);
}
