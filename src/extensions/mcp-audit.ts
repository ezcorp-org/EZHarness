/**
 * Audit metadata for the three MCP-server admin mutations (install, edit,
 * refresh) — the pure shaping layer between an `McpServerDefinition` and the
 * `audit_log` row `insertAuditEntry` writes.
 *
 * It exists as its own module for one reason: an MCP server definition is the
 * single richest credential carrier in the extension surface (stdio `env`,
 * http/sse `headers`, and a URL that can hold a token in its query string).
 * "Audit the mutation" and "never persist the credential" pull in opposite
 * directions, so the projection from definition → metadata is written once,
 * here, and unit-tested exhaustively rather than re-derived at three routes.
 *
 * What crosses into the audit row:
 *   - `transport`, and a `target` that is the executable (stdio) or the
 *     URL's ORIGIN + PATH only (http/sse — query and fragment are dropped
 *     whole, because `?api_key=…` is a real MCP convention).
 *   - `authKeys`: the NAMES of the transport auth entries (stdio `env`,
 *     http/sse `headers`). Names are the forensically useful half ("which
 *     credential was rotated"); values never appear.
 *   - `argCount` for stdio rather than the argv itself — a token passed as
 *     `--token=…` is an argv VALUE, so the values cannot be logged, while
 *     the count still shows an invocation changing shape.
 *   - `toolCount` / `toolNames` — what the server exposed. Not secret, and
 *     the whole point of the refresh action.
 *
 * `insertAuditEntry` routes everything through `redactForAudit` as a second
 * net; this module is the first, and the one that does not depend on a
 * pattern matching the secret.
 */
import type { ExtensionAuditMetadata } from "./audit-actions";
import type { McpServerDefinition, ToolDefinition } from "./types";

/** The credential-free projection of an MCP server definition. */
export type McpServerFacts = {
  transport: "stdio" | "http" | "sse";
  /** stdio: the executable. http/sse: `origin + pathname`, query + fragment
   *  stripped. `"<unparseable-url>"` when the URL will not parse — the raw
   *  string is deliberately NOT echoed, since that is the case where it is
   *  most likely to be a malformed credential blob. */
  target: string;
  /** stdio only: number of argv entries. Values are never recorded. */
  argCount?: number;
  /** Sorted NAMES of the transport auth entries. Never the values. */
  authKeys: string[];
  toolCount: number;
  toolNames: string[];
};

/** Strip everything after the path so a `?token=…` style URL cannot ride
 *  into the audit row. */
function safeUrlTarget(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.origin}${parsed.pathname}`;
  } catch {
    return "<unparseable-url>";
  }
}

/**
 * Project an MCP server definition + its tool snapshot onto the
 * credential-free {@link McpServerFacts}.
 *
 * `tools` may be undefined (the edit route's "before" side reads a stored
 * manifest whose `tools` array is optional), in which case the counts read
 * as zero rather than throwing.
 */
export function describeMcpServerForAudit(
  server: McpServerDefinition,
  tools?: readonly ToolDefinition[],
): McpServerFacts {
  const toolNames = (tools ?? []).map((t) => t.name);
  if (server.transport === "stdio") {
    return {
      transport: "stdio",
      target: server.command,
      argCount: server.args?.length ?? 0,
      authKeys: Object.keys(server.env ?? {}).sort(),
      toolCount: toolNames.length,
      toolNames,
    };
  }
  return {
    transport: server.transport,
    target: safeUrlTarget(server.url),
    authKeys: Object.keys(server.headers ?? {}).sort(),
    toolCount: toolNames.length,
    toolNames,
  };
}

/** Why the row was written. Mirrors the action constant one-for-one so a
 *  SIEM query can filter on either column. */
export type McpAuditReason = "mcp-install" | "mcp-update" | "mcp-refresh";

/**
 * Build the `audit_log.metadata` payload for one MCP mutation.
 *
 * Conforms to {@link ExtensionAuditMetadata}: `oldValue` / `newValue` carry
 * the before/after {@link McpServerFacts} (install has no before, so `null`),
 * `actor` is the admin's user id, and `permission: "network"` matches the
 * scope field the sibling `ext:mcp:*` rows already use so MCP dashboards do
 * not need a special case.
 */
export function buildMcpAuditMetadata(input: {
  extensionName: string;
  actorUserId: string;
  reason: McpAuditReason;
  before: McpServerFacts | null;
  after: McpServerFacts;
}): ExtensionAuditMetadata {
  return {
    permission: "network",
    oldValue: input.before,
    newValue: input.after,
    actor: input.actorUserId,
    reason: input.reason,
    extensionName: input.extensionName,
  };
}
