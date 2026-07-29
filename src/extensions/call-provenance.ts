/**
 * Per-call reverse-RPC provenance registry.
 *
 * **Why this exists:** extension capability calls (`ctx.llm`,
 * `ctx.memory`, `ctx.lessons`, `ctx.schedule`, `ctx.drafts`, …) come
 * back into the host as *reverse* JSON-RPC. The host must know which
 * user the call is on behalf of. The previous implementation read this
 * off process-wide mutable singleton state on `ToolExecutor`
 * (`currentUserId` / `currentConversationId`), which is wrong under two
 * conditions:
 *
 *   1. **Background fires** (scheduled / `run:complete` event) have no
 *      chat turn — the singleton is unset, so `deriveHandlerContext`
 *      threw `missing onBehalfOf` and the capability call failed.
 *   2. **Concurrency** — many conversations share one mutable field, so
 *      a slow tool's reverse-RPC observed another conversation's (or no)
 *      scope.
 *
 * The fix: the host mints an opaque `ezCallId` per forward tool-call /
 * per fire and snapshots the *correct* provenance at that instant here.
 * The subprocess SDK echoes only that opaque token back on every
 * reverse-RPC. The host resolves provenance from this registry — never
 * from singleton state, never trusting subprocess-supplied identity.
 * The spoofing defense is preserved: the token is host-issued and
 * host-resolved, and `actorExtensionId` still comes from the registered
 * tool record, never the wire.
 *
 * Lifecycle: a token is registered immediately before the forward
 * dispatch and released in the `finally` the moment it returns. The TTL
 * sweep + hard cap below are ONLY defensive backstops against a missing
 * release (a regression) — under correct operation the live set stays
 * tiny. Both backstops log loudly so a leak is never silent.
 */

import { logger } from "../logger";

const log = logger.child("ext.call-provenance");

export type CallProvenanceKind = "tool" | "schedule" | "event" | "render";

export interface CallProvenance {
  /** User the call is on behalf of. `null` only when `ownerless` —
   *  capability handlers soft-fail rather than throw in that case. */
  onBehalfOf: string | null;
  conversationId: string | null;
  runId: string | null;
  parentCallId: string | null;
  /** Host-owned — sourced from the registered-tool record, NOT the
   *  wire. The structural anti-spoofing anchor. */
  actorExtensionId: string;
  kind: CallProvenanceKind;
  /** True when no user scope could be resolved (e.g. a pure cron fire
   *  with no conversation). Reverse-RPC handlers return a clean
   *  soft-fail for these instead of throwing `missing onBehalfOf`. */
  ownerless: boolean;
}

interface Entry {
  prov: CallProvenance;
  createdAt: number;
  /**
   * Absolute-ms sweep expiry. Set ONLY for opt-in fire tokens that chose a
   * custom auto-release window (`registerFireCallProvenance(prov,
   * {autoReleaseMs})`). When present the TTL sweep honors THIS instant instead
   * of the kind-based default TTL — so a long-lived fire token (a 4 h hub
   * event fire, or a schedule fire sized to the grant's `maxRunDurationMs`)
   * is NOT evicted by the short 10-min fire TTL before its own auto-release
   * timer fires. That premature eviction is exactly what dropped reverse-RPC
   * mid-run on push pipelines / long sweeps (`-32602`). Absent → the token
   * keeps the kind-based backstop (2-min-timer / 10-min-sweep for fires).
   */
  expiresAt?: number;
}

/**
 * TTL is kind-aware (D2 hardening). The sweep is ONLY a leaked-token
 * backstop — the normal path releases deterministically in a `finally`
 * (tool calls) or via a bounded auto-release timer (fires). It must
 * never evict a token out from under a still-in-flight call:
 *
 *   - **tool** tokens: released in the `executeToolCall` `finally`. The
 *     only way one survives is a code-bug leak. A `requiresUserInput`
 *     tool can legitimately stay open for a very long human interaction
 *     (`skipTimeout`), so we'd MUCH rather let a leaked tool token
 *     linger 6h (the hard cap still bounds memory) than evict a healthy
 *     long-running call's provenance and break its reverse-RPC.
 *   - **schedule/event (fire)** tokens: auto-released after
 *     `FIRE_TOKEN_AUTO_RELEASE_MS` (2 min). 10 min is ample backstop
 *     headroom; no human is ever in this loop.
 *   - **render** tokens: minted around a single `ezcorp/page.render`
 *     forward call and released in its `finally` (like tool tokens), but
 *     a render is always fast and never blocks on human input, so it
 *     takes the tighter fire-tier backstop rather than the 6h one.
 */
export const CALL_PROVENANCE_TTL_MS = 6 * 60 * 60_000; // 6 h — tool tokens
export const FIRE_TOKEN_TTL_MS = 10 * 60_000; // 10 min — schedule/event tokens

function ttlForKind(kind: CallProvenanceKind): number {
  return kind === "tool" ? CALL_PROVENANCE_TTL_MS : FIRE_TOKEN_TTL_MS;
}

/** Hard OOM guard — a runaway leak can't grow the map without bound. */
let maxEntries = 10_000;

const registry = new Map<string, Entry>();

function sweep(now: number): void {
  if (registry.size === 0) return;
  let evicted = 0;
  for (const [id, e] of registry) {
    // A per-token `expiresAt` (opt-in long fire window) overrides the
    // kind-based default so the sweep never evicts a healthy long-lived
    // token before its own auto-release timer fires.
    const expiry = e.expiresAt ?? e.createdAt + ttlForKind(e.prov.kind);
    if (now > expiry) {
      registry.delete(id);
      evicted++;
    }
  }
  if (evicted > 0) {
    log.warn(
      "call-provenance TTL sweep evicted stale entries — a token was never released (leak / regression)",
      {
        evicted,
        remaining: registry.size,
        toolTtlMs: CALL_PROVENANCE_TTL_MS,
        fireTtlMs: FIRE_TOKEN_TTL_MS,
      },
    );
  }
}

/**
 * Snapshot `prov` and return the opaque `ezCallId` to stamp onto the
 * forward `_meta`. Caller MUST `releaseCallProvenance` in a `finally`.
 */
export function registerCallProvenance(
  prov: CallProvenance,
  opts?: { expiresAt?: number },
): string {
  const now = Date.now();
  sweep(now);
  if (registry.size >= maxEntries) {
    let oldestId: string | undefined;
    let oldestAt = Infinity;
    for (const [id, e] of registry) {
      if (e.createdAt < oldestAt) {
        oldestAt = e.createdAt;
        oldestId = id;
      }
    }
    if (oldestId !== undefined) {
      registry.delete(oldestId);
      // Reaching the hard cap means tokens are genuinely leaking (the
      // kind-aware TTL sweep already ran above and reaped anything
      // legitimately stale) — escalate to ERROR, not warn. Evicting the
      // oldest is a pure last-resort OOM guard.
      log.error(
        "call-provenance registry hit hard cap — evicted oldest entry (TOKEN LEAK: a forward call/fire is not releasing)",
        { cap: maxEntries, evictedId: oldestId, liveEntries: registry.size },
      );
    }
  }
  const id = crypto.randomUUID();
  registry.set(id, {
    prov,
    createdAt: now,
    ...(opts?.expiresAt !== undefined ? { expiresAt: opts.expiresAt } : {}),
  });
  log.debug("registered call provenance", {
    ezCallId: id,
    kind: prov.kind,
    actorExtensionId: prov.actorExtensionId,
    onBehalfOf: prov.onBehalfOf,
    conversationId: prov.conversationId,
    runId: prov.runId,
    ownerless: prov.ownerless,
    liveEntries: registry.size,
  });
  return id;
}

/**
 * Resolve a previously-registered `ezCallId`. Returns `undefined` for
 * an unknown / already-released token (logged at warn — it means a
 * reverse-RPC arrived without a valid host-issued correlation token,
 * which the caller surfaces as a fast hard error instead of a hang).
 */
export function resolveCallProvenance(
  ezCallId: string | undefined | null,
): CallProvenance | undefined {
  if (typeof ezCallId !== "string" || ezCallId.length === 0) {
    log.warn("call-provenance resolve called with no ezCallId on the reverse-RPC", {});
    return undefined;
  }
  const e = registry.get(ezCallId);
  if (!e) {
    log.warn("call-provenance resolve miss — token unknown or already released", {
      ezCallId,
      liveEntries: registry.size,
    });
    return undefined;
  }
  // Return a shallow copy, never the live registry entry. A handler
  // that mutated the result (or a buggy/hostile caller) must not be
  // able to poison the in-flight provenance observed by any other
  // resolver of the same token. CallProvenance is a flat record of
  // primitives, so a spread is a complete defensive copy.
  return { ...e.prov };
}

/** Drop a token. Idempotent. Always call in a `finally`. */
export function releaseCallProvenance(ezCallId: string | undefined | null): void {
  if (typeof ezCallId !== "string" || ezCallId.length === 0) return;
  const had = registry.delete(ezCallId);
  log.debug("released call provenance", { ezCallId, had, liveEntries: registry.size });
}

/**
 * Auto-release window for fire-and-forget dispatches (schedule /
 * lifecycle / event). Those paths have NO completion callback to
 * release on, so the token is dropped after a bounded window that
 * comfortably exceeds the extension handler's reverse-RPC (e.g. an
 * extractor's `ctx.llm.complete`). The 60-min registry TTL sweep is
 * the final backstop if even this is somehow missed.
 */
export const FIRE_TOKEN_AUTO_RELEASE_MS = 120_000; // 2 min

/**
 * Register a provenance snapshot for a fire-and-forget dispatch and
 * schedule its auto-release. Use this (not `registerCallProvenance`)
 * for schedule / lifecycle / event fires — there is no forward call to
 * release the token in a `finally`. The timer is `unref`'d so it never
 * keeps the process alive.
 *
 * `opts.autoReleaseMs` opts a SINGLE dispatch into a longer (or shorter)
 * release window than the 2-min default. This is the fix for long-running
 * dispatches whose reverse-RPC outlives 2 min:
 *   - hub event fires pass **4 h** (a full pipeline segment can run that
 *     long between reverse-RPCs — see the events route);
 *   - schedule fires pass the grant's **`maxRunDurationMs`** (default 5 min)
 *     so a reconcile sweep's storage writes still resolve provenance.
 * When a custom window is chosen we ALSO pin the sweep-expiry to it, so the
 * kind-based TTL sweep can't reap the token before the timer fires. Callers
 * that don't pass `opts` keep the exact 2-min default (and the 10-min sweep
 * backstop) — no behavior change.
 */
export function registerFireCallProvenance(
  prov: CallProvenance,
  opts?: { autoReleaseMs?: number },
): string {
  const autoReleaseMs = opts?.autoReleaseMs ?? FIRE_TOKEN_AUTO_RELEASE_MS;
  const id = opts?.autoReleaseMs !== undefined
    ? registerCallProvenance(prov, { expiresAt: Date.now() + autoReleaseMs })
    : registerCallProvenance(prov);
  const t = setTimeout(() => releaseCallProvenance(id), autoReleaseMs);
  (t as { unref?: () => void }).unref?.();
  return id;
}

/** Diagnostic / leak-watch — current live entry count. */
export function callProvenanceSize(): number {
  return registry.size;
}

// ── Test-only hooks ─────────────────────────────────────────────────

/** Clear the registry so suites don't leak across cases. */
export function _resetCallProvenanceForTests(): void {
  registry.clear();
  maxEntries = 10_000;
}

/** Drive the TTL sweep at a controlled clock so the eviction path is
 *  testable without real-time flake. */
export function __sweepForTests(now: number): void {
  sweep(now);
}

/** Shrink the hard cap so the eviction path is testable without
 *  inserting 10k entries. */
export function __setMaxEntriesForTests(n: number): void {
  maxEntries = n;
}
