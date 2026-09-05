/**
 * The ONE failure contract for every MCP connect attempt an API caller can
 * trigger — install (`POST /api/mcp-servers`), edit
 * (`PUT /api/mcp-servers/[id]`) and refresh
 * (`POST /api/mcp-servers/[id]/refresh`).
 *
 * ## Why a constant body
 *
 * All three routes used to echo the raw transport error:
 * `` errorJson(502, `MCP connect failed: ${message}`) ``. That turns an
 * admin-scoped credential into a network-mapping oracle: `ECONNREFUSED`
 * (port closed), a connect timeout (filtered / no host), and a protocol
 * error (port OPEN, speaking something that isn't MCP) are three
 * distinguishable answers, so an attacker sweeps
 * `http://10.0.0.x:<port>` and reads the internal topology off the
 * response bodies.
 *
 * So every failure — SSRF guard rejection, DNS failure, refused
 * connection, timeout, protocol error, `tools/list` rejection, unknown
 * extension id — collapses to ONE status and ONE body. A rejection by the
 * target guard MUST be indistinguishable from a plain connect failure:
 * if "blocked by policy" were its own response, the caller could still
 * separate private from public targets and the oracle would be rebuilt
 * across exactly the boundary the guard defends.
 *
 * The message names the escape-hatch env var. That text is CONSTANT — it
 * is returned verbatim for a refused connection to a PUBLIC host too — so
 * it carries zero bits about the target while still telling a self-hosting
 * admin why their LAN MCP server won't install.
 *
 * ## Diagnosis is not lost
 *
 * `reportMcpConnectFailure` writes the real cause server-side: a
 * structured log line, plus an `error_logs` row via `persistError` so an
 * admin can read the actual reason from the observability surface instead
 * of the HTTP response.
 *
 * ## Status choice: one uniform 502
 *
 * Not "400 for an invalid URL, 502 for unreachable". Splitting the status
 * by failure class is the same oracle in a different field — the caller
 * learns which bucket its input fell into. Zod validation errors keep
 * their 400: those are computed purely from the request body, with no DNS
 * and no socket, so they leak nothing about the internal network.
 */

import { logger } from "../logger";
import { persistError } from "../db/queries/error-logs";
import { McpTargetBlockedError, MCP_TARGET_ALLOW_ENV } from "./target-guard";

const log = logger.child("mcp-connect");

/** The uniform 502 status every MCP connect failure returns. */
export const MCP_CONNECT_FAILED_STATUS = 502;

export const MCP_CATALOG_PROBE_FAILED_MESSAGE = "MCP catalog probe failed. Check the public endpoint and credentials; no release was activated.";

/** The uniform, target-independent 502 body every MCP connect failure returns. */
export const MCP_CONNECT_FAILED_MESSAGE =
  "MCP server unreachable or invalid. If the target is on a private network, " +
  `allow it with ${MCP_TARGET_ALLOW_ENV}.`;

export interface McpConnectFailureContext {
  /** Which handler failed, e.g. `POST /api/mcp-servers`. */
  route: string;
  /** Extension name or id, when the handler knows it. */
  extension?: string;
  /** Transport discriminant of the attempted target. */
  transport?: string;
}

/**
 * Record the REAL reason an MCP connect failed. Best-effort and never
 * throws — a diagnostics failure must not change what the caller sees.
 *
 * Callers then return the uniform response themselves; this function
 * deliberately does not build it, so `src/` never has to import the web
 * tree's `errorJson`.
 */
export async function reportMcpConnectFailure(
  error: unknown,
  ctx: McpConnectFailureContext,
): Promise<void> {
  const blocked = error instanceof McpTargetBlockedError;
  const message = error instanceof Error ? error.message : String(error);
  const metadata: Record<string, unknown> = {
    route: ctx.route,
    extension: ctx.extension ?? null,
    transport: ctx.transport ?? null,
    // `blocked` + `reason` are what makes an SSRF attempt greppable in the
    // error log even though the HTTP response cannot say so.
    blocked,
    reason: blocked ? (error as McpTargetBlockedError).reason : "connect-error",
    target: blocked ? (error as McpTargetBlockedError).target : null,
  };

  if (blocked) {
    log.warn(
      `Refused MCP target (${metadata.reason}) for ${ctx.extension ?? "unknown"} ` +
        `at ${ctx.route}: ${(error as McpTargetBlockedError).target}`,
    );
  } else {
    log.warn(`MCP connect failed for ${ctx.extension ?? "unknown"} at ${ctx.route}: ${message}`);
  }

  await persistError({
    level: blocked ? "warn" : "error",
    message: `MCP connect failed: ${message}`,
    stack: error instanceof Error ? (error.stack ?? null) : null,
    metadata,
  });
}
