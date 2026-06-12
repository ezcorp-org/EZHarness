import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import type { JsonRpcNotification } from "./types";
import { validatePageTree } from "./page-schema";
import { getPageCache } from "./page-cache";

// ── Constants ────────────────────────────────────────────────────────

export const MAX_STATE_SIZE_BYTES = 65_536; // 64 KB
export const MAX_UPDATES_PER_SECOND = 10;

const MAX_STRIP_DEPTH = 10;

// ── Manifest shape the mediator needs (subset of real manifest) ─────

export interface MediatorManifest {
  name: string;
  panel?: { stateSchema?: Record<string, unknown> };
  /** Declared Hub page ids (`manifest.pages[].id`) — gates
   *  `ezcorp/page-state` pushes. */
  pageIds?: string[];
  /** Granted event subscriptions — `allowedEvents` for page-tree
   *  validation (action nodes naming undeclared events are dropped). */
  eventSubscriptions?: string[];
}

// ── Token-bucket rate limiter (per extension) ───────────────────────

interface Bucket {
  tokens: number;
  lastRefill: number;
}

// ── HTML-strip helper ───────────────────────────────────────────────

function stripHtmlTags(value: unknown, depth: number): unknown {
  if (depth > MAX_STRIP_DEPTH) return value;

  if (typeof value === "string") {
    return value.replace(/[<>]/g, "");
  }

  if (Array.isArray(value)) {
    return value.map((v) => stripHtmlTags(v, depth + 1));
  }

  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      out[key] = stripHtmlTags((value as Record<string, unknown>)[key], depth + 1);
    }
    return out;
  }

  return value;
}

// ── ExtensionStateMediator ──────────────────────────────────────────

export class ExtensionStateMediator {
  private buckets = new Map<string, Bucket>();
  /**
   * Per-extension reentrancy guard for refill+consume. JS is single-threaded,
   * but this catches any future async regression: if a call for `extensionId`
   * is already inside `consumeToken` when another arrives (e.g. because a
   * later caller adds an `await`), the reentrant call is treated as a rate
   * limit miss instead of racing on shared bucket state.
   */
  private consumingLocks = new Set<string>();

  constructor(
    private bus: EventBus<AgentEvents>,
    private getManifest: (extensionId: string) => MediatorManifest | undefined,
  ) {}

  handleNotification(extensionId: string, notification: JsonRpcNotification): void {
    // Method gate — panel state and Hub page pushes share the size /
    // rate-limit / manifest ladder but diverge after the gates.
    const isPanelState = notification.method === "ezcorp/state";
    const isPageState = notification.method === "ezcorp/page-state";
    if (!isPanelState && !isPageState) return;

    // Params must be a non-null object
    if (!notification.params || typeof notification.params !== "object") return;

    // Size gate
    if (JSON.stringify(notification.params).length > MAX_STATE_SIZE_BYTES) return;

    // Rate limit — critical section is serialized per-extension to prevent
    // concurrent callers from double-consuming a single token. SHARED
    // bucket across panel + page pushes: an extension gets 10 UI
    // updates/second total, not 10 of each.
    if (!this.consumeToken(extensionId)) return;

    const manifest = this.getManifest(extensionId);

    if (isPageState) {
      this.handlePageState(extensionId, manifest, notification.params);
      return;
    }

    // ── ezcorp/state (bottom panel) ───────────────────────────────
    if (!manifest?.panel) return;

    // Sanitise string values
    const sanitised = stripHtmlTags(notification.params, 0) as Record<string, unknown>;

    // Emit on the bus
    this.bus.emit("ext:state", {
      extensionId,
      extensionName: manifest.name,
      state: (sanitised.state ?? sanitised) as Record<string, unknown>,
      timestamp: Date.now(),
    });
  }

  /**
   * `ezcorp/page-state` — extension pushes a fresh Hub page tree
   * (Extension Pages Hub §2.5, invalidation-signal design).
   *
   *   1. Gate on a DECLARED page id (`manifest.pages`).
   *   2. Run the full `validatePageTree` ladder (same validator the
   *      render-pull uses; `allowedEvents` = granted
   *      eventSubscriptions).
   *   3. Cache the validated tree so the viewers' re-pull is instant.
   *   4. Emit `ext:page-state` WITHOUT the tree — only
   *      {extensionId, extensionName, pageId}. The signal leaks
   *      nothing but "page X changed", so the SSE layer may deliver
   *      it to every authenticated subscriber.
   */
  private handlePageState(
    extensionId: string,
    manifest: MediatorManifest | undefined,
    params: Record<string, unknown>,
  ): void {
    if (!manifest) return;
    const pageId = params.pageId;
    if (typeof pageId !== "string") return;
    if (!manifest.pageIds?.includes(pageId)) return;

    const tree = validatePageTree(params.page, {
      allowedEvents: manifest.eventSubscriptions ?? [],
    });
    if (!tree) return;

    getPageCache().set(extensionId, pageId, tree);

    this.bus.emit("ext:page-state", {
      extensionId,
      extensionName: manifest.name,
      pageId,
      timestamp: Date.now(),
    });
  }

  // ── Token bucket implementation ─────────────────────────────────

  /**
   * Atomically refill the extension's bucket based on elapsed time and consume
   * one token if available.
   *
   * **Concurrency invariant:** this method MUST remain a single synchronous
   * block with no `await` points. The entire read-modify-write on
   * `this.buckets` happens inside one JS event-loop turn, which JavaScript's
   * single-threaded model guarantees is atomic across callers. Adding an
   * `await` here would let two callers race on shared bucket state and both
   * observe ≥1 tokens before either decrements, bypassing the rate limit.
   *
   * The `consumingLocks` reentrancy guard is defense-in-depth: if a future
   * refactor introduces an async call into this critical section, a reentrant
   * caller for the same extension will be treated as rate-limited rather than
   * being allowed to double-spend.
   */
  private consumeToken(extensionId: string): boolean {
    if (this.consumingLocks.has(extensionId)) {
      // Reentrant call while a prior refill+consume is still in-flight for
      // this extension — deny rather than race on shared state.
      return false;
    }
    this.consumingLocks.add(extensionId);
    try {
      const now = Date.now();
      const prev = this.buckets.get(extensionId);
      // Start from a full bucket when the extension first appears.
      const startingTokens = prev?.tokens ?? MAX_UPDATES_PER_SECOND;
      const lastRefill = prev?.lastRefill ?? now;
      // Monotonic guard: never allow negative elapsed (clock-skew / backwards
      // jump) to subtract tokens.
      const elapsed = Math.max(0, (now - lastRefill) / 1000);
      const refilled = Math.min(
        MAX_UPDATES_PER_SECOND,
        startingTokens + elapsed * MAX_UPDATES_PER_SECOND,
      );

      if (refilled < 1) {
        // Still commit the refilled bucket so the next call sees the updated
        // lastRefill timestamp even though we're rate-limiting this one.
        this.buckets.set(extensionId, { tokens: refilled, lastRefill: now });
        return false;
      }

      // Atomic write: replace the bucket object rather than mutating the
      // existing one in-place. Combined with the sync-only invariant above,
      // this means each caller either sees the fully-committed bucket from
      // the prior call or computes its own refill from the last committed
      // state, never an intermediate value.
      this.buckets.set(extensionId, { tokens: refilled - 1, lastRefill: now });
      return true;
    } finally {
      this.consumingLocks.delete(extensionId);
    }
  }
}
