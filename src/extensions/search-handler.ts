/**
 * `ezcorp/search` reverse-RPC handler — `ctx.search.{web,read}`.
 *
 * Mirrors the `ctx.lessons` / `ctx.memory` handler shape:
 *   - Caller identity (`actorExtensionId`) + `onBehalfOf` are stamped
 *     HOST-SIDE via `deriveHandlerContext` (never RPC meta — spoofing
 *     defense), threaded by `tool-executor.ts#resolveReverseRpcMeta`
 *     from the host-issued `ezCallId` provenance token.
 *   - Gating: `granted.search === false` (or absent) → soft-fail (-32101
 *     "search disabled"). Phase 1 treats everything else (`"inherit"` or
 *     an override object) as allow-with-code-defaults. The full
 *     instance↔extension field-level POLICY RESOLVER + per-day QUOTA
 *     enforcement are Phase 2 (this handler only gates on presence +
 *     runs the search).
 *   - The provider chain runs HOST-SIDE behind the SSRF egress guard
 *     (`src/search/egress.ts`). Every blocked egress writes a
 *     `SDK_SEARCH_EGRESS_BLOCKED` audit row; every successful call writes
 *     `SDK_SEARCH_QUERY` + an `sdk_capability_calls` governance row.
 *   - RPC errors (provider failure, SSRF block surfacing as a thrown
 *     error) soft-fail (-32105) so a search hiccup never crashes the
 *     extension subprocess.
 */
import { logger } from "../logger";
import { deriveHandlerContext, type RegisteredToolStub } from "./handler-context";
import { recordCapabilityCall } from "./recordCapabilityCall";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";
import { performSearch, performRead } from "../search/index";
import type { EgressBlockedHook } from "../search/index";
import type { ExtensionPermissions, JsonRpcRequest, JsonRpcResponse } from "./types";

const log = logger.child("ext.search-handler");

interface SearchParams {
  action: "web" | "read";
  query?: string;
  url?: string;
  maxResults?: number;
  maxChars?: number;
}

export interface SearchHandlerContext {
  granted: ExtensionPermissions;
  registeredTool: RegisteredToolStub;
  /** Test seam — inject the search module entry points so handler tests
   *  run over a stub instead of the live provider chain. */
  search?: typeof performSearch;
  read?: typeof performRead;
}

function softFail(req: JsonRpcRequest, reason: string, code = -32001): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code, message: reason, data: { reason } },
  };
}

/** Phase-1 gate: the §3.1 `false` state (or an absent grant) denies;
 *  `"inherit"` and override objects allow. */
function isSearchDenied(granted: ExtensionPermissions["search"]): boolean {
  return granted === undefined || granted === false;
}

export async function handlePiSearch(
  req: JsonRpcRequest,
  ctx: SearchHandlerContext,
  rpcMeta?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const startedAt = Date.now();
  const handlerCtx = deriveHandlerContext(rpcMeta, ctx.registeredTool);
  const params = (req.params ?? {}) as unknown as SearchParams;

  if (isSearchDenied(ctx.granted.search)) {
    // -32101 → the SDK maps this to SearchDisabledError.
    return softFail(req, "search disabled for this extension", -32101);
  }

  const doSearch = ctx.search ?? performSearch;
  const doRead = ctx.read ?? performRead;

  // Audit hook — every SSRF-guard block writes a row attributed to the
  // calling extension. Fire-and-forget; an audit hiccup never blocks the
  // search response.
  const onEgressBlocked: EgressBlockedHook = (info) => {
    void insertAuditEntry(
      handlerCtx.onBehalfOf,
      EXT_AUDIT_ACTIONS.SDK_SEARCH_EGRESS_BLOCKED,
      handlerCtx.actorExtensionId,
      {
        capability: "search",
        actor: "system",
        oldValue: undefined,
        newValue: info.target,
        reason: `egress-blocked:${info.reason}`,
        egressReason: info.reason,
        egressMode: info.mode,
        target: info.target,
      },
    ).catch(() => {});
  };

  try {
    if (params.action === "web") {
      if (typeof params.query !== "string" || params.query.trim().length === 0) {
        return softFail(req, "query required");
      }
      const result = await doSearch(params.query, {
        ...(typeof params.maxResults === "number" ? { maxResults: params.maxResults } : {}),
        onEgressBlocked,
      });
      await recordCapabilityCall({
        ctx: handlerCtx,
        // `capability` is the SDK bucket — search joins the SDK_* tier.
        capability: "search",
        action: "web",
        durationMs: Date.now() - startedAt,
        success: true,
        provider: result.providerName,
        after: { provider: result.providerName, cached: result.cached },
        insertChatPill: handlerCtx.conversationId !== null,
      });
      void insertAuditEntry(
        handlerCtx.onBehalfOf,
        EXT_AUDIT_ACTIONS.SDK_SEARCH_QUERY,
        handlerCtx.actorExtensionId,
        {
          capability: "search",
          actor: "system",
          oldValue: undefined,
          newValue: { action: "web", provider: result.providerName, cached: result.cached },
          reason: "search-web",
        },
      ).catch(() => {});
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: { markdown: result.markdown, provider: result.providerName, cached: result.cached },
      };
    }

    if (params.action === "read") {
      if (typeof params.url !== "string" || params.url.trim().length === 0) {
        return softFail(req, "url required");
      }
      const result = await doRead(params.url, {
        ...(typeof params.maxChars === "number" ? { maxChars: params.maxChars } : {}),
        onEgressBlocked,
      });
      await recordCapabilityCall({
        ctx: handlerCtx,
        capability: "search",
        action: "read",
        durationMs: Date.now() - startedAt,
        success: true,
        provider: result.providerName,
        after: { provider: result.providerName, cached: result.cached },
        insertChatPill: handlerCtx.conversationId !== null,
      });
      void insertAuditEntry(
        handlerCtx.onBehalfOf,
        EXT_AUDIT_ACTIONS.SDK_SEARCH_QUERY,
        handlerCtx.actorExtensionId,
        {
          capability: "search",
          actor: "system",
          oldValue: undefined,
          newValue: { action: "read", provider: result.providerName, cached: result.cached },
          reason: "search-read",
        },
      ).catch(() => {});
      return {
        jsonrpc: "2.0",
        id: req.id,
        result: { markdown: result.markdown, provider: result.providerName, cached: result.cached },
      };
    }

    return softFail(req, "unknown-action");
  } catch (err) {
    // Provider failure / SSRF block surfacing as a thrown error — soft
    // fail (-32105 → SearchError) so the subprocess gets a clean error
    // instead of a crash. The egress-block audit row (if any) was
    // already written via `onEgressBlocked`.
    log.info("search call failed", {
      extensionId: handlerCtx.actorExtensionId,
      action: params.action,
      error: String(err),
    });
    await recordCapabilityCall({
      ctx: handlerCtx,
      capability: "search",
      action: params.action === "read" ? "read" : "web",
      durationMs: Date.now() - startedAt,
      success: false,
      errorMessage: (err as Error).message,
      insertChatPill: false,
    }).catch(() => {});
    return softFail(req, (err as Error).message, -32105);
  }
}
