import type { JsonRpcRequest, JsonRpcResponse } from "../types";
import { resolveCallProvenance, type CallProvenance } from "../call-provenance";
import { logger } from "../../logger";

const log = logger.child("ext.tool-executor");

/**
 * Shared first step of every reverse-RPC provenance resolution: read the
 * host-issued `_meta.ezCallId` the subprocess echoed back and resolve it
 * to the per-call snapshot. An UNRESOLVED token fail-fasts (`-32602`) for
 * ALL callers — a reverse-RPC with no valid host token is a regression /
 * orphaned subprocess, never trust the wire. Callers then apply their own
 * owner-scope policy to the returned `prov` (`resolveReverseRpcMeta`
 * rejects ownerless fires; `resolveStorageProvenance` allows them for the
 * install-wide global scope).
 */
export function resolveCallToken(
  extensionId: string,
  req: JsonRpcRequest,
):
  | { ok: true; prov: CallProvenance }
  | { ok: false; errorResponse: JsonRpcResponse } {
  const rawMeta = (req.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const ezCallId = typeof rawMeta?.ezCallId === "string" ? rawMeta.ezCallId : undefined;
  const prov = resolveCallProvenance(ezCallId);
  if (!prov) {
    log.error(
      "reverse-RPC provenance unresolved — no valid host-issued ezCallId; failing fast",
      { method: req.method, extensionId, ezCallId: ezCallId ?? null },
    );
    return {
      ok: false,
      errorResponse: {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32602, message: "Reverse-RPC provenance unresolved (no valid call token)" },
      },
    };
  }
  return { ok: true, prov };
}

/**
 * Resolve reverse-RPC provenance from the host-issued correlation
 * token the subprocess echoed back on `req.params._meta.ezCallId`.
 *
 * This REPLACES the old `buildHandlerRpcMeta()` which read
 * process-wide mutable singleton state (`currentUserId` /
 * `currentConversationId`) — wrong under concurrency and for
 * background fires. Provenance now comes from the per-call snapshot
 * registered at forward-dispatch time, keyed by an opaque host-issued
 * token. The subprocess can only echo the token back; it cannot
 * manufacture identity. `actorExtensionId` still comes from the
 * registered-tool record (the spoofing anchor), never the wire.
 *
 * Returns either `{ ok:true, prov, rpcMeta }` (rpcMeta feeds
 * `deriveHandlerContext`) or `{ ok:false, errorResponse }` the caller
 * MUST return verbatim:
 *   - unresolved token → `-32602`, logged at ERROR (a regression /
 *     orphaned subprocess — fail fast, never hang)
 *   - ownerless background fire → `-32106`, logged at INFO (a clean,
 *     expected soft-fail; never the `missing onBehalfOf` throw)
 */
export function resolveReverseRpcMeta(
  extensionId: string,
  req: JsonRpcRequest,
):
  | {
      ok: true;
      prov: CallProvenance;
      onBehalfOf: string;
      conversationId: string | null;
      rpcMeta: Record<string, unknown>;
    }
  | { ok: false; errorResponse: JsonRpcResponse } {
  const token = resolveCallToken(extensionId, req);
  if (!token.ok) return token;
  const prov = token.prov;
  if (prov.ownerless || !prov.onBehalfOf) {
    log.info(
      "reverse-RPC from a background fire with no resolvable owner — capability call skipped",
      { method: req.method, extensionId, kind: prov.kind },
    );
    return {
      ok: false,
      errorResponse: {
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32106, message: "No owner scope for this background fire — capability unavailable" },
      },
    };
  }
  // Defense-in-depth tripwire (NOT a hard gate). The token is opaque,
  // single-use, host-issued, and only ever delivered to the one
  // subprocess it was minted for — a different extension cannot
  // observe or guess it (independent reviewer confirmed: 122-bit
  // UUID, per-subprocess stdin). In correct operation the resolving
  // extension always equals the token's `actorExtensionId`. We do NOT
  // hard-reject a mismatch because the cross-extension `ezcorp/invoke`
  // path's exact token/extension correspondence is subtle and a false
  // reject would break legitimate chained calls. Instead we log loud
  // so any real divergence (a regression, or an actual confusion
  // attempt) is caught in observability without functional risk.
  if (prov.actorExtensionId !== extensionId) {
    log.warn(
      "reverse-RPC token actorExtensionId != resolving extension — unexpected; proceeding (tripwire, not enforced)",
      {
        method: req.method,
        resolvingExtensionId: extensionId,
        tokenActorExtensionId: prov.actorExtensionId,
        kind: prov.kind,
      },
    );
  }
  const rpcMeta: Record<string, unknown> = { ezOnBehalfOf: prov.onBehalfOf };
  if (prov.conversationId) rpcMeta.ezConversationId = prov.conversationId;
  const invocationMetadata: Record<string, unknown> = {};
  if (prov.runId) invocationMetadata.runId = prov.runId;
  if (prov.parentCallId) invocationMetadata.parentCallId = prov.parentCallId;
  if (Object.keys(invocationMetadata).length > 0) {
    rpcMeta.invocationMetadata = invocationMetadata;
  }
  return {
    ok: true,
    prov,
    onBehalfOf: prov.onBehalfOf,
    conversationId: prov.conversationId,
    rpcMeta,
  };
}

/**
 * TOKEN-WINS scope resolution, soft variant — the shared core behind
 * `resolveHandlerScope` (legacy reverse-RPC handlers) and the
 * `runtime.*` invoke path (`handlePiInvoke`).
 *
 * WHY the per-call token beats the executor's `currentUserId` /
 * `currentConversationId`: those are PROCESS-WIDE MUTABLE fields on the
 * `ToolExecutor` instance. They're only right for a per-turn executor
 * that just set them, and they are wrong in exactly the two ways
 * `call-provenance.ts`'s header calls out —
 *
 *   1. **Background fires** — the boot executor (`{bus,
 *      eventDriven: true}` in `web/src/lib/server/context.ts`) never
 *      calls `setCurrentUserId`, so every `run:complete`-driven call
 *      observes "no user" and silently resolves to system defaults.
 *   2. **Concurrency** — one mutable field is shared by every
 *      conversation, so a slow reverse-RPC observes whichever turn
 *      dispatched last.
 *
 * The per-call snapshot registered at forward-dispatch / fire time is
 * neither: the `EventSubscriptionDispatcher` stamps the conversation
 * OWNER onto the fire token (`registerFireCallProvenance`), and the
 * subprocess can only echo the opaque token back — it cannot
 * manufacture identity.
 *
 * Returns `null` (not a sentinel) for an unresolvable field so each
 * caller applies its own default. Only consults the registry when a
 * token is actually on the wire — `resolveCallProvenance(undefined)`
 * warn-logs, and the tokenless fallback is an expected (legacy) path
 * for both callers, not an anomaly.
 */
export function resolveTokenPreferredScope(
  req: JsonRpcRequest,
  currentUserId: string | undefined,
  currentConversationId: string | undefined,
): { userId: string | null; conversationId: string | null } {
  const rawMeta = (req.params as { _meta?: Record<string, unknown> } | undefined)?._meta;
  const ezCallId = typeof rawMeta?.ezCallId === "string" ? rawMeta.ezCallId : undefined;
  const prov = ezCallId ? resolveCallProvenance(ezCallId) : undefined;
  if (prov && !prov.ownerless && prov.onBehalfOf) {
    return { userId: prov.onBehalfOf, conversationId: prov.conversationId };
  }
  return {
    userId: currentUserId ?? null,
    conversationId: currentConversationId ?? null,
  };
}

/**
 * Per-call provenance for the LEGACY singleton-reading reverse-RPC
 * handlers (emit-task-event, spawn-assignment, cancel-run,
 * network-internal, finalize-tool-call, agent-configs). TOKEN WINS:
 * when the request carries a resolvable host-issued `ezCallId` whose
 * snapshot has an owner, identity comes from that per-call snapshot —
 * correct under concurrency and for long-running tools. Otherwise
 * (no token, unresolved token, or an ownerless snapshot) fall back to
 * the instance singletons — EXACTLY the pre-migration behavior, so
 * background paths and legacy callers are unaffected.
 *
 * Deliberately softer than `resolveReverseRpcMeta` (which fail-fasts
 * on a missing token): these six handlers predate the token plumbing
 * and their downstream contracts already handle the "unknown"
 * sentinel. Tightening to fail-fast is a follow-up, not this change.
 */
export function resolveHandlerScope(
  req: JsonRpcRequest,
  currentUserId: string | undefined,
  currentConversationId: string | undefined,
): { userId: string; conversationId: string } {
  const scope = resolveTokenPreferredScope(req, currentUserId, currentConversationId);
  return {
    userId: scope.userId ?? "unknown",
    conversationId: scope.conversationId ?? "unknown",
  };
}

/** What an ownerless-TOLERANT resolver hands back: the same trust-boundary
 *  guarantees as `resolveReverseRpcMeta`, minus its blanket refusal — so
 *  `onBehalfOf` is nullable and the CALLER owns the ownerless policy. */
export type OwnerlessTolerantProvenance =
  | { ok: true; onBehalfOf: string | null; conversationId: string | null }
  | { ok: false; errorResponse: JsonRpcResponse };

/**
 * Shared core of the ownerless-TOLERANT resolvers
 * (`resolveStorageProvenance`, `resolveDelegatedProvenance`).
 *
 * Identical trust boundary to `resolveReverseRpcMeta` — identity comes
 * from the per-call snapshot the host minted, resolved from the opaque
 * host-issued `ezCallId` the subprocess echoed back, never the wire —
 * but WITHOUT its blanket ownerless refusal. An UNRESOLVED token still
 * fail-fasts (`-32602`) for every caller; an OWNERLESS snapshot passes
 * through with `onBehalfOf: null` and the caller decides what that means.
 *
 * Deliberately NOT exported. Each public resolver keeps its own name and
 * its own doc so the two policies can diverge later without either one
 * silently inheriting the other's rules. That they agree today is a fact
 * about today, not a contract between them.
 */
function resolveOwnerlessTolerantProvenance(
  extensionId: string,
  req: JsonRpcRequest,
): OwnerlessTolerantProvenance {
  const token = resolveCallToken(extensionId, req);
  if (!token.ok) return token;
  const prov = token.prov;
  // Defense-in-depth tripwire (log, not enforced) — parity with
  // `resolveReverseRpcMeta`. See its comment for why a mismatch is logged
  // rather than rejected (the cross-ext `ezcorp/invoke` correspondence is
  // subtle and a false reject would break legitimate chained calls).
  if (prov.actorExtensionId !== extensionId) {
    log.warn(
      "reverse-RPC token actorExtensionId != resolving extension — unexpected; proceeding (tripwire, not enforced)",
      {
        method: req.method,
        resolvingExtensionId: extensionId,
        tokenActorExtensionId: prov.actorExtensionId,
        kind: prov.kind,
      },
    );
  }
  return {
    ok: true,
    onBehalfOf: prov.ownerless ? null : prov.onBehalfOf,
    conversationId: prov.conversationId,
  };
}

/**
 * Resolve reverse-RPC provenance for `ezcorp/storage` (parity with
 * `handlePiFs`/`resolveReverseRpcMeta`). Sources the acting user +
 * conversation from the per-call snapshot the subprocess echoed back —
 * NOT the racy process-wide `currentUserId`/`currentConversationId`
 * singletons, which observe the wrong (or another conversation's) scope
 * under concurrency and are unset for background fires.
 *
 * UNLIKE `resolveReverseRpcMeta`, an OWNERLESS background fire is NOT an
 * error here: storage's `global` scope is deliberately ownerless-reachable
 * (cron fires write install-wide state — see `storage-handler.ts`
 * `resolveScopeId`). An ownerless fire is passed through with a `null`
 * user; `handleStorageRpc` then enforces the per-scope rules itself
 * (rejecting `user`/`conversation` scope when no scopeId resolves). An
 * UNRESOLVED token still fail-fasts (`-32602`), exactly like fs.
 */
export function resolveStorageProvenance(
  extensionId: string,
  req: JsonRpcRequest,
): OwnerlessTolerantProvenance {
  return resolveOwnerlessTolerantProvenance(extensionId, req);
}

/**
 * Resolve reverse-RPC provenance for `ezcorp/workflows-delegated` — the
 * seam a DELEGATED workflow fire needs, and nothing more.
 *
 * ── Why a third resolver exists ────────────────────────────────────────
 *
 * `resolveReverseRpcMeta` refuses EVERY ownerless fire outright
 * (`-32106`) before its caller builds a handler context. A cron / webhook
 * fire IS ownerless (`event-subscription-dispatcher.ts` stamps
 * `ownerless: true` when owner resolution finds nobody), so a background
 * trigger asking to run a workflow dies at rung 0 of
 * `workflows-handler.ts`'s ladder and never reaches a single one of its
 * authorization rungs. That refusal is a REAL control for
 * `ezcorp/workflows` and it is left byte-identical — this resolver is
 * additive, reached only by the distinct `ezcorp/workflows-delegated`
 * method, and `resolveReverseRpcMeta` is not loosened by so much as a
 * character.
 *
 * ── What this DOES NOT do ──────────────────────────────────────────────
 *
 * Passing ownerless through is NOT authorizing it. It moves the ownerless
 * decision from rung 0 (pre-handler, unaudited, un-appealable) to rung 7
 * of `handleWorkflowsRpc`, which refuses an ownerless fire with the same
 * `-32106` and, unlike rung 0, writes an `audit_log` row for it. There is
 * no delegation model in the tree yet — no `workflow_delegations` table,
 * no consent record, no owner to act as — so today an ownerless delegated
 * call is still REFUSED, just visibly. This resolver is the door frame;
 * the door stays shut until a delegation grant exists to open it.
 *
 * Same trust boundary as every sibling: an UNRESOLVED token fail-fasts
 * (`-32602`), identity comes from the host-issued token, never the wire.
 */
export function resolveDelegatedProvenance(
  extensionId: string,
  req: JsonRpcRequest,
): OwnerlessTolerantProvenance {
  return resolveOwnerlessTolerantProvenance(extensionId, req);
}
