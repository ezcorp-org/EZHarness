import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  McpServerDefinition,
  McpServerStdio,
} from "./types";
import { buildAllowedEnv } from "./registry";
import { parseMemoryLimit, DEFAULT_MEMORY_LIMIT_MB } from "./subprocess";

/**
 * Audit finding #1 fix: MCP stdio extensions must run under the same
 * sandbox envelope as regular subprocess extensions — `prlimit` for
 * resource bounds + `buildAllowedEnv` so the child never inherits the
 * web server's `process.env` (which would otherwise leak secrets like
 * `EZCORP_PERMITTED_HOSTS`, `EZCORP_SHELL_ALLOWED`, or operator vars).
 *
 * The wrap is non-gating: the original binary still runs. Only the
 * execution envelope is tightened. Existing enabled MCP extensions keep
 * working after upgrade — callers who were passing `spec.env` (literal
 * manifest-declared values, admin-approved at install) still see those
 * keys in the child.
 *
 * Not applicable to http/sse transports: those transports are network
 * clients, not subprocess spawns, so there is nothing to sandbox.
 */
export function buildSandboxedMcpSpec(
  spec: McpServerDefinition,
  manifest: ExtensionManifestV2,
  grantedPermissions: ExtensionPermissions,
  extensionId: string,
): McpServerDefinition {
  if (spec.transport !== "stdio") return spec;

  const memBytes = manifest.resources?.memory
    ? parseMemoryLimit(manifest.resources.memory)
    : DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024;

  const baseEnv = buildAllowedEnv(manifest, grantedPermissions, extensionId);
  const env: Record<string, string> = { ...baseEnv, ...(spec.env ?? {}) };

  const wrapped: McpServerStdio = {
    transport: "stdio",
    name: spec.name,
    description: spec.description,
    command: "prlimit",
    args: [
      `--rss=${memBytes}`,
      `--as=${memBytes}`,
      spec.command,
      ...(spec.args ?? []),
    ],
    env,
  };
  return wrapped;
}
