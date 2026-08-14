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
 *     URL's ORIGIN only (http/sse — path, query and fragment are all
 *     dropped; `?api_key=…` AND `/services/<opaque-token>` are both real
 *     MCP conventions).
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
  /** stdio: the executable. http/sse: the URL's ORIGIN only — path, query
   *  and fragment are all dropped (see `safeUrlTarget`; a webhook-style MCP
   *  endpoint carries its credential in the PATH). `"<unparseable-url>"`
   *  when the URL will not parse — the raw string is deliberately NOT
   *  echoed, since that is the case where it is most likely to be a
   *  malformed credential blob. */
  target: string;
  /** http/sse only: how many path segments the endpoint had. Enough shape to
   *  tell two endpoints on one host apart; carries no path bytes. */
  pathDepth?: number;
  /** stdio only: number of argv entries. Values are never recorded. */
  argCount?: number;
  /** Sorted NAMES of the transport auth entries. Never the values. */
  authKeys: string[];
  toolCount: number;
  toolNames: string[];
};

/**
 * Reduce an http/sse URL to its ORIGIN. Query, fragment, userinfo and — as
 * of the F7 fix — the PATH are all dropped.
 *
 * The path went too. A webhook-style MCP endpoint carries its credential as
 * opaque path SEGMENTS (`/services/T0001/B0002/QQQQopaqueTOKEN99` is the
 * Slack/Zapier shape), and `redactForAudit`'s pattern set does not match an
 * opaque path token — it has no `key=` to anchor on. Keeping `origin +
 * pathname` therefore wrote a live credential into `audit_log.metadata`
 * verbatim.
 *
 * A "does this segment look like a route word or a token?" heuristic was
 * considered and rejected: `T0001` and `B0002` pass any lax rule, and a
 * heuristic at a credential boundary fails silently in the direction that
 * costs the most. The origin answers the question an operator actually asks
 * of this row — *which host does this MCP talk to* — and {@link
 * McpServerFacts.pathDepth} preserves enough shape to tell two endpoints on
 * one host apart without carrying a single path byte.
 */
function safeUrlTarget(url: string): { target: string; pathDepth: number } {
  try {
    const parsed = new URL(url);
    // "/a/b" → 2; "/" and "" → 0.
    const pathDepth = parsed.pathname.split("/").filter(Boolean).length;
    return { target: parsed.origin, pathDepth };
  } catch {
    return { target: "<unparseable-url>", pathDepth: 0 };
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
  const { target, pathDepth } = safeUrlTarget(server.url);
  return {
    transport: server.transport,
    target,
    pathDepth,
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
