/**
 * MCP capability derivation — the ONE place that answers "what does this
 * MCP server actually reach, and therefore what must its manifest DECLARE
 * and its install GRANT carry?".
 *
 * ── The defect this closes ──────────────────────────────────────────
 *
 * `installMcpExtension` used to synthesize `permissions: {}` and store the
 * live `tools/list` verbatim, so every MCP tool reached the PDP with NO
 * `capabilities` declaration. `capabilityDeclarationToSet(undefined, …)`
 * returns `[]`, `firstMissingCapability([], granted)` is always `null`, and
 * `engine.authorize(ctx, [])` therefore ALLOWED unconditionally — the single
 * chokepoint for extension tool authorization was inert for every MCP tool
 * ever installed. Two follow-on effects:
 *
 *   • `permissions.network` was undefined, and `clampExtensionPermissions`
 *     gates on `if (submitted.network && manifest.network)`. With no manifest
 *     ceiling an admin's `PUT /api/extensions/<id>/permissions` network grant
 *     was silently dropped, so a stdio MCP server could NEVER be granted a
 *     host — and `mcp-proxy.ts` re-authorizes EVERY CONNECT against exactly
 *     that grant. The proxy denied all egress with no way to allow any.
 *   • A remote (`http`/`sse`) MCP server is never sandboxed at all
 *     (`buildSandboxedMcpSpec` returns those specs untouched), so the
 *     per-dispatch PDP gate is its ONLY governance — and it was inert.
 *
 * ── The derivation rule ─────────────────────────────────────────────
 *
 * The hosts are read off the operator's OWN server definition; nothing is
 * invented and nothing is asked for that the definition doesn't already name:
 *
 *   • `http` / `sse` — the target `url`'s hostname. Calling any tool on such
 *     a server makes the HOST process open an HTTPS connection to exactly
 *     that host, so `network:<host>` is a literal description of the call.
 *   • `stdio` — every `://` URL the operator typed into `command` / `args`.
 *     This is what makes the stdio grant non-vacuous: `npx mcp-remote
 *     https://mcp.example.com/mcp` declares (and grants) `mcp.example.com`,
 *     which is precisely the host the proxy will be asked to CONNECT to.
 *     A command line that names no host derives NOTHING and stays
 *     DENY-BY-DEFAULT — the proxy refuses every CONNECT, which is the
 *     current behavior, now explicit rather than accidental.
 *
 * Hosts are NOT filtered against `isInternalHost`. A remote MCP server on
 * `http://localhost:3000/mcp` is a legitimate deployment; dropping it here
 * would hand that server an EMPTY needed set and re-open the exact inertness
 * this module exists to close. The proxy keeps its own unconditional
 * internal-host deny for stdio egress (`mcp-proxy.ts`), which is the layer
 * where that decision belongs.
 *
 * Hostnames are normalized with the SAME `normalizeHostname` the proxy uses
 * to build its `network` capability value. Exact-match is the comparison
 * semantic for `network` caps (`capabilityCovers`), so any divergence in
 * normalization would deny a grant that reads as correct.
 *
 * Everything here is PURE (no DB, no fs, no env) so the install path
 * (`src/db/queries/extensions.ts`), the read-time normalizer
 * (`src/extensions/registry.ts`) and the tests share one implementation.
 */

import { deriveCapsFromExtensionPerms } from "./manifest";
import { normalizeHostname } from "./runtime/internal-host";
import type {
  ExtensionManifestV2,
  ExtensionPermissions,
  McpServerDefinition,
  ToolDefinition,
} from "./types";

/**
 * The hostname a single token names, or `null` when the token is not a URL.
 * Deliberately strict: the token must parse as a whole URL and carry a
 * non-empty host. A bare flag (`--verbose`), a package name
 * (`@modelcontextprotocol/server-github`) or a path never yields a host.
 */
function hostOfToken(token: unknown): string | null {
  if (typeof token !== "string" || !token.includes("://")) return null;
  let parsed: URL;
  try {
    parsed = new URL(token);
  } catch {
    return null;
  }
  if (parsed.hostname.length === 0) return null;
  return normalizeHostname(parsed.hostname);
}

/**
 * Every host an MCP server definition names, deduped, in declaration order.
 * `[]` is a legal (and common) answer for a stdio server whose command line
 * names no host — see the module comment on deny-by-default.
 */
export function mcpNetworkHosts(server: McpServerDefinition): string[] {
  const tokens: unknown[] =
    server.transport === "stdio"
      ? [server.command, ...(server.args ?? [])]
      : [server.url];
  const hosts: string[] = [];
  const seen = new Set<string>();
  for (const token of tokens) {
    const host = hostOfToken(token);
    if (host === null || seen.has(host)) continue;
    seen.add(host);
    hosts.push(host);
  }
  return hosts;
}

/**
 * The `permissions` block a synthesized MCP manifest declares — the CEILING
 * an admin's grant is clamped to, never a grant itself. `network` is always
 * present (possibly empty) so the ceiling field exists: the extension detail
 * page renders its checkbox row off `manifest.permissions.network`, and
 * `clampExtensionPermissions` needs the key to admit any submitted host.
 */
export function mcpManifestPermissions(
  server: McpServerDefinition,
): ExtensionManifestV2["permissions"] {
  return { network: mcpNetworkHosts(server) };
}

/**
 * The install-time GRANT for an MCP extension: the derived hosts, stamped.
 *
 * Recorded as BOTH `grantedPermissions` and `installedPermissions` by the
 * caller — the same pairing `activateExtension` uses — so the reapprove flow
 * clamps against the consent actually collected at install rather than the
 * full manifest.
 *
 * Auto-granting at install matches every other install path (a local
 * `ext install --yes` grants the full declared set via
 * `buildFullGrantFromManifest`); the consent event is the admin-gated
 * install itself, which already carries the command line / URL these hosts
 * were read from. An empty derivation grants NOTHING.
 */
export function mcpInstallGrant(
  server: McpServerDefinition,
  now: number = Date.now(),
): ExtensionPermissions {
  const network = mcpNetworkHosts(server);
  if (network.length === 0) return { grantedAt: {} };
  return { network, grantedAt: { network: now } };
}

/**
 * Attach the per-tool `capabilities` declaration the PDP reads at dispatch.
 *
 * The declaration is derived from the manifest-level `permissions` through
 * the SAME `deriveCapsFromExtensionPerms` the v2→v3 loader migration uses,
 * so an MCP tool and a subprocess tool describe an identical grant with an
 * identical cap set. An authored declaration is never widened (`??`), which
 * also makes this idempotent — re-running it on an already-normalized
 * manifest is a no-op.
 */
export function withMcpToolCapabilities(
  tools: readonly ToolDefinition[],
  permissions: ExtensionManifestV2["permissions"],
): ToolDefinition[] {
  const declared = deriveCapsFromExtensionPerms(permissions);
  return tools.map((t) => ({ ...t, capabilities: t.capabilities ?? declared }));
}

/**
 * READ-TIME normalization for a stored MCP manifest — the registry runs this
 * on every `loadFromDb` and after `refreshMcpTools`.
 *
 * Why read-time and not install-time only: `refreshMcpTools` rewrites the
 * manifest as `{...manifest, tools}` with a FRESH `tools/list` that carries
 * no `capabilities`, so an install-time-only fix would be silently erased the
 * first time an admin clicked "Refresh tools" — the PDP would go inert again
 * with nothing to show for it. Deriving on read makes the in-memory manifest
 * correct no matter what is at rest, including rows written by an older
 * build.
 *
 * The `permissions` ceiling is derived only when the stored manifest does not
 * declare `network` at all (a legacy row). A stored declaration is
 * AUTHORITATIVE — `installMcpExtension` / `updateMcpExtension` keep it in
 * sync with the server definition, and honoring it leaves room for an
 * operator-supplied host allowlist to be added later without this function
 * silently reverting it.
 *
 * Non-MCP manifests are returned by reference, untouched.
 */
export function normalizeMcpManifest(
  manifest: ExtensionManifestV2,
): ExtensionManifestV2 {
  if (manifest.kind !== "mcp") return manifest;
  const server = manifest.mcpServers?.[0];
  if (!server) return manifest;
  const permissions =
    manifest.permissions?.network === undefined
      ? { ...(manifest.permissions ?? {}), ...mcpManifestPermissions(server) }
      : manifest.permissions;
  return {
    ...manifest,
    permissions,
    tools: withMcpToolCapabilities(manifest.tools ?? [], permissions),
  };
}
