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
import { performSearch, performRead, ProviderNotAllowedError } from "../search/index";
import type { EgressBlockedHook } from "../search/index";
import { resolveSearchPolicy, type SearchPolicy } from "../search/policy";
import { consumeSearchQuota } from "../search/search-quota";
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
  /** Test seam — inject the policy resolver so handler tests drive the
   *  effective quota / providers / maxResults without seeding the
   *  `settings` table. Default: the live `resolveSearchPolicy`. */
  resolvePolicy?: typeof resolveSearchPolicy;
  /** Test seam — inject the day-quota consumer. Default:
   *  `consumeSearchQuota` (durable per-extension/day counter). */
  consumeQuota?: typeof consumeSearchQuota;
}

function softFail(req: JsonRpcRequest, reason: string, code = -32001): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code, message: reason, data: { reason } },
  };
}

/** Absent grant denies (the extension never requested search). The §3.1
 *  `false` state also denies, but that's surfaced via the resolved policy
 *  (`denied: true`) so the deny path is a single source of truth. */
function isSearchGrantAbsent(granted: ExtensionPermissions["search"]): boolean {
  return granted === undefined;
}

export async function handlePiSearch(
  req: JsonRpcRequest,
  ctx: SearchHandlerContext,
  rpcMeta?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const startedAt = Date.now();
  const handlerCtx = deriveHandlerContext(rpcMeta, ctx.registeredTool);
  const params = (req.params ?? {}) as unknown as SearchParams;

  if (isSearchGrantAbsent(ctx.granted.search)) {
    // -32101 → the SDK maps this to SearchDisabledError.
    return softFail(req, "search disabled for this extension", -32101);
  }

  // ── Phase 2: resolve the 3-layer effective policy (grant override ??
  //    instance default ?? hard default) BEFORE running the search. ──
  const resolvePolicy = ctx.resolvePolicy ?? resolveSearchPolicy;
  const policyResult = await resolvePolicy(ctx.granted.search);
  if (policyResult.denied) {
    return softFail(req, "search disabled for this extension", -32101);
  }
  const policy: SearchPolicy = policyResult;

  /** Soft-governance audit row when policy denies a call (quota / provider).
   *  Fire-and-forget; the call already soft-fails to the subprocess. */
  const auditQuotaExceeded = (
    reason: "quota-per-day" | "provider-not-allowed",
    extra: Record<string, unknown> = {},
  ): void => {
    void insertAuditEntry(
      handlerCtx.onBehalfOf,
      EXT_AUDIT_ACTIONS.SDK_SEARCH_QUOTA_EXCEEDED,
      handlerCtx.actorExtensionId,
      { capability: "search", actor: "system", oldValue: undefined, reason, ...extra },
    ).catch(() => {});
  };

  // Per-extension/day call quota — counted for BOTH web and read (a URL
  // read is a host-side fetch that costs the same budget). Mirrors the
  // LLM `maxCallsPerDay` accounting.
  const consumeQuota = ctx.consumeQuota ?? consumeSearchQuota;
  const quota = consumeQuota(handlerCtx.actorExtensionId, policy.quota);
  if (!quota.ok) {
    auditQuotaExceeded("quota-per-day", { retryAfterMs: quota.retryAfterMs });
    return {
      jsonrpc: "2.0",
      id: req.id,
      error: {
        code: -32103,
        message: "search quota exceeded",
        data: { reason: "quota-per-day", retryAfterMs: quota.retryAfterMs },
      },
    };
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
      // maxResults: the request may ask for FEWER than the policy ceiling
      // but never more — clamp to `min(requested, policy.maxResults)`.
      const requested = typeof params.maxResults === "number" ? params.maxResults : policy.maxResults;
      const result = await doSearch(params.query, {
        maxResults: Math.min(requested, policy.maxResults),
        allowedProviders: policy.providers,
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
    // Policy provider-allowlist denial — pre-fetch, so no network call
    // happened. Soft-fail (-32101 disabled tier) + a quota-governance
    // audit row (reason `provider-not-allowed`). NOT a provider error.
    if (err instanceof ProviderNotAllowedError) {
      auditQuotaExceeded("provider-not-allowed", { provider: err.providerName });
      await recordCapabilityCall({
        ctx: handlerCtx,
        capability: "search",
        action: params.action === "read" ? "read" : "web",
        durationMs: Date.now() - startedAt,
        success: false,
        errorMessage: err.message,
        insertChatPill: false,
      }).catch(() => {});
      return softFail(req, err.message, -32101);
    }
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
