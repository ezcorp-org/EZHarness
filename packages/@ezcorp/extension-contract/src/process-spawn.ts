import type { WorkspaceFiles } from "@ezcorp/extension-contract/types";
import { validateManifest } from "./validation";
import { declaresStdioMcpServer, MCP_BRIDGE_ENTRYPOINT, MCP_BRIDGE_MANIFEST, MCP_BRIDGE_SOURCE, MCP_BRIDGE_TEST, MCP_BRIDGE_TEST_SOURCE } from "./spawn-policy";
export * from "./spawn-policy";

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
