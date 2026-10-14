/**
 * The process-spawn policy's pure parts: no validator and no schema engine, so
 * browser code can import them (`@ezcorp/extension-contract/spawn-policy`).
 * The release check that needs the manifest validator is in process-spawn.ts.
 */
import type { ProcessSpawnPolicy } from "@ezcorp/extension-contract/types";
import { ContractError } from "./json";

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

