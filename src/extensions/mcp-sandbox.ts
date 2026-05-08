import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  McpServerDefinition,
  McpServerStdio,
} from "./types";
import { buildAllowedEnv } from "./registry";
import { parseMemoryLimit, DEFAULT_MEMORY_LIMIT_MB } from "./subprocess";
import {
  probeNetnsAvailability,
  buildNetnsSpawnArgs,
  getDefaultLauncherPath,
} from "./mcp-netns";
import { createMcpProxy, type McpProxyHandle } from "./mcp-proxy";
import type { PermissionEngine } from "./permission-engine";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";

/**
 * Audit finding #1 fix: MCP stdio extensions must run under the same
 * sandbox envelope as regular subprocess extensions — `prlimit` for
 * resource bounds + `buildAllowedEnv` so the child never inherits the
 * web server's `process.env` (which would otherwise leak secrets like
 * `EZCORP_PERMITTED_HOSTS`, `EZCORP_SHELL_ALLOWED`, or operator vars).
 *
 * Phase 7 extension: when a `ctx` (PermissionEngine + audit context)
 * is supplied, we additionally:
 *   - On Linux with userns enabled: wrap the spawn in `unshare -U -n -m`
 *     and a launcher script that applies an OUTPUT-DROP iptables ruleset.
 *   - Always: start a per-MCP forward proxy on a UDS (Linux) or
 *     loopback port (fallback) and inject `HTTPS_PROXY` env so the
 *     MCP's outbound HTTPS traffic routes through the proxy. The
 *     proxy gates each CONNECT against the manifest's network grant.
 *
 * `ctx` is optional. Unit tests that exercise `buildSandboxedMcpSpec`
 * without a real PDP omit it; the function returns the prlimit-only
 * spec from before Phase 7 in that case. The production caller
 * (`registry.getMcpClient`) always provides `ctx`.
 *
 * Not applicable to http/sse transports: those transports are network
 * clients, not subprocess spawns, so there is nothing to sandbox.
 */

export interface BuildSandboxedMcpCtx {
  engine: PermissionEngine;
  conversationId: string | null;
  userId: string | null;
}

export interface BuildSandboxedMcpResult {
  spec: McpServerDefinition;
  /** Proxy handle, or null when `ctx` was omitted (test path) or the
   *  transport isn't stdio. The caller is responsible for `proxyHandle.stop()`
   *  on extension unload. */
  proxyHandle: McpProxyHandle | null;
}

/**
 * Build the sandboxed spawn spec for an MCP server. Phase 7 made this
 * async because the proxy listener must be bound before we hand the
 * URL to the child via env. Sync callers (the existing unit tests for
 * pre-Phase-7 invariants) drop into a back-compat branch when `ctx` is
 * omitted and never await proxy startup.
 */
export async function buildSandboxedMcpSpec(
  spec: McpServerDefinition,
  manifest: ExtensionManifestV2,
  grantedPermissions: ExtensionPermissions,
  extensionId: string,
  ctx?: BuildSandboxedMcpCtx,
): Promise<BuildSandboxedMcpResult> {
  if (spec.transport !== "stdio") return { spec, proxyHandle: null };

  const memBytes = manifest.resources?.memory
    ? parseMemoryLimit(manifest.resources.memory)
    : DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024;

  const baseEnv = buildAllowedEnv(manifest, grantedPermissions, extensionId);
  const env: Record<string, string> = { ...baseEnv, ...(spec.env ?? {}) };

  // The pre-Phase-7 spec shape: command="prlimit", args=[--rss, --as,
  // <orig-cmd>, ...orig-args]. Build it once; the netns wrap (if any)
  // takes the entire array as its inner exec target.
  const prlimitCommand = "prlimit";
  const prlimitArgs: string[] = [
    `--rss=${memBytes}`,
    `--as=${memBytes}`,
    spec.command,
    ...(spec.args ?? []),
  ];

  // Back-compat path: when `ctx` is omitted, skip Phase-7 wrap. Existing
  // unit tests covering only the prlimit + bounded-env invariants land
  // here and behave identically to their pre-Phase-7 expectations.
  if (!ctx) {
    const wrapped: McpServerStdio = {
      transport: "stdio",
      name: spec.name,
      description: spec.description,
      command: prlimitCommand,
      args: prlimitArgs,
      env,
    };
    return { spec: wrapped, proxyHandle: null };
  }

  // Phase 7 — production wiring path.
  const netns = probeNetnsAvailability();

  // Where the proxy listens. UDS on Linux netns; loopback otherwise.
  // The UDS path goes through the namespace's inherited mount table —
  // when unshare(-m) creates a new mount-ns it copies the parent's
  // entries, so `/tmp/ezcorp-mcp-<id>.sock` is reachable inside.
  const socketPath = netns.available
    ? `/tmp/ezcorp-mcp-${extensionId}.sock`
    : "127.0.0.1:0"; // OS-assigned port

  const proxyHandle = createMcpProxy({
    extensionId,
    extensionName: manifest.name,
    conversationId: ctx.conversationId,
    userId: ctx.userId,
    permittedHosts: grantedPermissions.network ?? [],
    engine: ctx.engine,
    isUds: netns.available,
    socketPath,
  });
  await proxyHandle.start();

  // Inject HTTPS_PROXY / HTTP_PROXY. The URL embeds the per-instance
  // bearer token so only this MCP can pass the proxy's auth gate.
  const proxyUrl = proxyHandle.proxyUrl();
  env.HTTPS_PROXY = proxyUrl;
  env.HTTP_PROXY = proxyUrl;
  env.https_proxy = proxyUrl;
  env.http_proxy = proxyUrl;

  // Audit either MCP_NETNS_CREATED or MCP_NETNS_FALLBACK exactly once
  // per spawn so fleet operators can quantify the netns-vs-fallback
  // ratio and chase down hosts running in less-strict mode.
  const auditAction = netns.available
    ? EXT_AUDIT_ACTIONS.MCP_NETNS_CREATED
    : EXT_AUDIT_ACTIONS.MCP_NETNS_FALLBACK;
  void insertAuditEntry(
    ctx.userId,
    auditAction,
    extensionId,
    {
      permission: "network",
      oldValue: null,
      newValue: null,
      actor: "system",
      extensionName: manifest.name,
      reason: netns.reason ?? null,
      socketPath,
      platform: process.platform,
    },
  ).catch(() => {
    // DB blip — never fail-open the spawn on a logging error. The
    // namespace + proxy are already in place; the audit row is just a
    // signal.
  });

  // Build the final command/args. On Linux netns, prepend `unshare -U
  // -n -m -- <launcher.sh> ...`. Otherwise leave the prlimit chain
  // unchanged.
  const finalSpawn = buildNetnsSpawnArgs({
    origCommand: prlimitCommand,
    origArgs: prlimitArgs,
    launcherPath: getDefaultLauncherPath(),
  });

  const wrapped: McpServerStdio = {
    transport: "stdio",
    name: spec.name,
    description: spec.description,
    command: finalSpawn.command,
    args: finalSpawn.args,
    env,
  };
  return { spec: wrapped, proxyHandle };
}
