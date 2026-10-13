/**
 * Readable permission lines: the one source of the text the CLI, the install
 * prompt and the extension author page's approval card show. Pure (no node
 * builtins, no database), so the browser can import it too.
 */
import type { ExtensionManifest } from "./types";
import { declaresStdioMcpServer, type ProcessSpawnPolicy } from "@ezcorp/extension-contract";

export interface PermissionItem {
  type: string;
  value: string | boolean;
  description: string;
}

const PERMISSION_DESCRIPTIONS: Record<string, (v: string | boolean) => string> = {
  network: (v) => `Network access to ${v}`,
  filesystem: (v) => `Filesystem access to ${v}`,
  shell: () => "Start other programs or processes (enforced in the extension's worker; without it, process creation is blocked)",
  env: (v) => `Read environment variable ${v}`,
  storage: () => "Persistent key-value storage",
  // The manifest alone cannot say whether the server may start: that is the
  // host's spawn policy (process-spawn-policy.ts), so the default is neutral.
  mcpProcess: () => "Has a stdio MCP server: it can start its server only if the release is a plain MCP bridge or has the shell permission",
  mcpProcessAllowed: () => "Starts its MCP server process (process spawning allowed)",
  mcpProcessBlocked: () => "Cannot start its MCP server process: starting processes needs the shell permission",
};

export function getRequiredPermissions(manifest: ExtensionManifest): PermissionItem[] {
  const items: PermissionItem[] = [];
  const perms = manifest.permissions;

  if (perms.network) {
    for (const domain of perms.network) {
      items.push({ type: "network", value: domain, description: PERMISSION_DESCRIPTIONS.network!(domain) });
    }
  }
  if (perms.filesystem) {
    for (const path of perms.filesystem) {
      items.push({ type: "filesystem", value: path, description: PERMISSION_DESCRIPTIONS.filesystem!(path) });
    }
  }
  if (perms.shell) {
    items.push({ type: "shell", value: true, description: PERMISSION_DESCRIPTIONS.shell!(true) });
  }
  // A stdio MCP server is a process the worker starts. Only the sealed SDK
  // bridge may start it without the shell grant (see process-spawn-policy.ts).
  if (declaresStdioMcpServer(manifest)) {
    items.push({ type: "mcpProcess", value: true, description: PERMISSION_DESCRIPTIONS.mcpProcess!(true) });
  }
  if (perms.env) {
    for (const varName of perms.env) {
      items.push({ type: "env", value: varName, description: PERMISSION_DESCRIPTIONS.env!(varName) });
    }
  }
  if (perms.storage) {
    items.push({ type: "storage", value: true, description: PERMISSION_DESCRIPTIONS.storage!(true) });
  }

  return items;
}

/** The manifest fields the lines read: the permissions, and whether it runs a stdio MCP server. */
type GrantManifest = Pick<ExtensionManifest, "kind" | "mcpServers">;

/**
 * Readable lines for an approval's grants. Each grant is the canonical JSON
 * pair `[name, value]`. A grant this text does not describe still gets a
 * line, `name: value`, so nothing an approval covers is hidden.
 *
 * The stdio MCP line follows `processSpawn`, the host's verdict for this
 * release and these grants (process-spawn-policy.ts), not the manifest alone;
 * without a verdict it keeps the neutral line and never claims a start.
 */
export function describeGrants(grants: readonly string[], manifest: GrantManifest, processSpawn?: ProcessSpawnPolicy): string[] {
  const pairs = grants.map((grant) => JSON.parse(grant) as [string, unknown]);
  const permissions = Object.fromEntries(pairs) as ExtensionManifest["permissions"];
  const described = getRequiredPermissions({ ...manifest, permissions } as ExtensionManifest);
  const covered = new Set(described.map((item) => item.type));
  const other = pairs.filter(([name]) => !covered.has(name)).map(([name, value]) => `${name}: ${JSON.stringify(value)}`);
  const lines = described.map((item) => {
    if (item.type !== "mcpProcess" || !processSpawn) return item.description;
    return PERMISSION_DESCRIPTIONS[processSpawn === "allow" ? "mcpProcessAllowed" : "mcpProcessBlocked"]!(true);
  });
  return [...lines, ...other];
}
