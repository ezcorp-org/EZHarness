/**
 * Coalescer for the PDP's repeated-decision audit rows — the step-4 ALLOW
 * and the step-2 subset-check DENY.
 *
 * ## The flood
 *
 * `PermissionEngine.authorize()` writes one `ext:perm:allowed` row per
 * decision. That is right for a decision a human would want to read one
 * at a time, and catastrophic for a filesystem walk: ez-factory's
 * `read_files` authorizes once per directory listed and TWICE per file
 * (`stat` then `read`), so a single tool call emits up to 500 + 100 + 100
 * = 700 rows within a second or two. `/api/audit` over-fetches 200 and
 * serves 100, ordered `created_at DESC` — so one walk pushed every other
 * governance event off page 1. The audit log stayed complete and became
 * unreadable, which for an audit log is the same thing as being lost.
 *
 * A *persistent* deny floods the same way, and it took #204 to make it
 * reachable: once an MCP tool's needed-capability set is non-empty, any
 * durable deny state — a conversation-scoped `effectiveGrantedPermissions`
 * override that omits `network`, an admin revoking the grant, a backfill
 * row whose UPDATE threw — denies EVERY call and writes a row for each
 * one, bounded only by `MAX_TOOL_CALLS_PER_TURN` (100) per turn per
 * conversation. A looping or scheduled agent against a revoked MCP server
 * is the realistic generator (issue #206).
 *
 * ## Why coalescing loses NOTHING here — check this before widening it
 *
 * Read `writeAuditRow` in `permission-engine.ts`. Two rows fold only when
 * every field that row would have carried is equal, which is exactly what
 * `PermAuditKey` enumerates: the decision, the extension, the user, the
 * conversation, the tool, the calling extension, and — for a deny — the
 * missing capability KIND, its VALUE and the deny reason. What is left
 * over is a random `auditId` and a timestamp, and this module preserves
 * both facts explicitly: `firstAuditId` joins the summary to its head row,
 * and `firstAt`/`lastAt` bracket the burst in wall-clock time.
 *
 * **The one field that is genuinely dropped is `parentAuditId`**, and it
 * is deliberate. For a top-level tool call it is constant across the whole
 * burst (undefined, or the conversation's spawn root), so nothing is lost.
 * For a nested cross-extension invoke it is the UPSTREAM call's audit id,
 * so it varies per call — the head row keeps its own, and the tail row
 * does not carry the other N. Keeping it in the key instead would mean a
 * cross-extension deny loop writes one row per call again, i.e. exactly
 * the flood this exists to stop, while `callerExtensionId` (which IS in
 * the key) already answers "who was calling". A reader chasing one
 * specific chain joins the tail's `headAuditId` back to the head row.
 *
 * So the coalesced form is strictly MORE informative than the flood: the
 * first decision is written verbatim, and the tail becomes one row that
 * says how many followed and over what span. Where 700 identical rows
 * told you "an allow happened" 700 times and buried everything else, the
 * summary tells you the volume — which is the only thing the repetition
 * ever encoded — and leaves the rest of the log readable.
 *
 * **A deny is forensic data, so nothing may be DROPPED.** Folding a deny
 * is only legitimate because the count and the two timestamps survive on
 * the summary row: `suppressed + 1` rows happened, the first at `firstAt`
 * and the last at `lastAt`. An operator can still answer "how many times
 * was this refused, and between when and when" from the folded pair. Any
 * future change that removes a field from the summary removes an answer.
 *
 * ## What is NEVER coalesced
 *
 * The step-4 allow and the step-2 subset-check deny route through here.
 * Everything else the engine writes stays verbatim, one per decision:
 *
 *   - the `override-lookup-failed` deny — the fail-closed refusal taken
 *     when the conversation-override read throws. Its metadata carries a
 *     per-row `underlyingError` string, so those rows are NOT identical,
 *     and the state it reports (an unhealthy DB) is one an operator must
 *     see every instance of.
 *   - `ext:perm:prompted` — a human was asked.
 *   - the `bundled-ceiling-auto-allow` allow — a SENSITIVE capability
 *     (`fs.write`, `shell`, …) that skipped a prompt it would otherwise
 *     have had to answer. Low volume, high consequence, exempt.
 *
 * The key deliberately includes `toolName` and the caller, so a burst that
 * changes what it is doing starts a NEW window and is written verbatim
 * again. Sameness is what gets folded; novelty always surfaces.
 *
 * ## Why not 1-in-N sampling
 *
 * `EventSubscriptionDispatcher` samples its delivery audit 1-in-100
 * (`event-subscription-dispatcher.ts`), and that is the right shape for
 * telemetry where any representative row will do. It is the wrong shape
 * here: sampling can drop the FIRST occurrence — the one that says a new
 * (extension, tool) pair started touching the filesystem at all — and it
 * reports no total. First-verbatim + counted-tail keeps both, and a
 * sampled deny would lose the count outright.
 */

/** How long one burst is folded into a single key. */
export const COALESCE_WINDOW_MS = 10_000;

/**
 * Suppressed-count ceiling before a summary is flushed early and a fresh
 * window opens. Bounds how stale the count can get during a very long
 * walk, so an operator watching the audit log sees progress rather than
 * silence. The decision that trips it becomes the next window's verbatim
 * head and is NOT also counted in the summary it flushes — so a burst of
 * N decisions is always reported as exactly N.
 */
export const COALESCE_FLUSH_AT = 250;

/**
 * Ceiling on live windows. A burst is per (extension, user, conversation,
 * tool), so the natural size is tiny; the cap is an OOM backstop against a
 * pathological caller, and evicting flushes rather than discards.
 */
export const COALESCE_MAX_KEYS = 512;

/** Which decision a burst is made of. A deny NEVER folds into an allow
 *  window (or the reverse) — the field is part of the key. */
export type PermAuditDecision = "allow" | "deny";

/** The identity of one burst. Everything a coalesced row would have said
 *  is in here, which is what makes folding the tail lossless. */
export interface PermAuditKey {
  decision: PermAuditDecision;
  extensionId: string;
  userId: string | null;
  conversationId: string | null;
  toolName: string | null;
  callerExtensionId: string | null;
  /** The missing capability's kind on a deny; `null` on an allow (the
   *  step-4 row carries no capability). */
  capabilityKind: string | null;
  /** The missing capability's value on a deny, when it has one. */
  capabilityValue: string | null;
  /** The deny reason as written to the row; `null` on an allow. */
  reason: string | null;
}

/** What the caller must write when a window closes with suppressed rows. */
export interface CoalescedPermSummary {
  key: PermAuditKey;
  /** How many rows were folded into this one. Always >= 1. Add 1 (the
   *  verbatim head) for the total number of decisions in the window. */
  suppressed: number;
  /** The `auditId` of the verbatim row that opened the window, so the
   *  summary and its head are joinable. */
  firstAuditId: string;
  /** Epoch ms of the FIRST decision in the window — the one written
   *  verbatim as the head row. */
  firstAt: number;
  /** Epoch ms of the LAST folded decision. With `firstAt` it brackets the
   *  burst, which is the fact a folded row would otherwise lose. */
  lastAt: number;
  windowMs: number;
}

interface Window {
  key: PermAuditKey;
  firstAuditId: string;
  suppressed: number;
  openedAt: number;
  lastAt: number;
  timer: ReturnType<typeof setTimeout> | null;
}

function keyOf(k: PermAuditKey): string {
  // `JSON.stringify` of a fixed-arity tuple, NOT a delimiter join. A join
  // has to pick a separator no component can contain AND has to map `null`
  // onto some string — and `null` mapped to `""` makes "no tool name" and
  // "an empty tool name" the same burst, folding two different facts into
  // one. Serialising keeps them distinct without anyone having to be right
  // about a separator.
  return JSON.stringify([
    k.decision,
    k.extensionId,
    k.userId,
    k.conversationId,
    k.toolName,
    k.callerExtensionId,
    k.capabilityKind,
    k.capabilityValue,
    k.reason,
  ]);
}

/**
 * A coalescer instance.
 *
 * Constructed rather than module-global so a test drives its own, and so
 * the engine owns exactly one per process alongside its other caches.
 */
export interface PermAuditCoalescer {
  /**
   * Decide whether THIS decision gets a verbatim row.
   *
   * `true` — write it (the window's head). `false` — it was folded; the
   * summary will be emitted by `emitSummary` when the window closes.
   *
   * Never throws: an audit bookkeeping fault must not change a permission
   * decision. Folding is an AUDIT-side decision only — the caller returns
   * its allow/deny verdict either way.
   */
  shouldWrite(key: PermAuditKey, auditId: string): boolean;
  /** Close every open window now, emitting any pending summaries. Used at
   *  shutdown and by tests; safe to call when nothing is open. */
  flushAll(): void;
  /** Drop every open window WITHOUT emitting a summary, and cancel its
   *  timer. For test isolation only: a leaked window makes the next
   *  test's first allow read as a folded tail, and a leaked timer writes
   *  an audit row into whatever suite runs after it. */
  dropAll(): void;
  /** Live window count — leak watch and test assertions. */
  size(): number;
}

/**
 * Build a coalescer.
 *
 * @param emitSummary Writes the tail row. Called with the burst's
 *   identity and its suppressed count. Invoked from a timer, so it must
 *   not throw — the caller wraps its own audit write, exactly as
 *   `writeAuditRow` already does.
 */
export function createPermAuditCoalescer(
  emitSummary: (summary: CoalescedPermSummary) => void,
  opts?: { windowMs?: number; flushAt?: number; maxKeys?: number },
): PermAuditCoalescer {
  const windowMs = opts?.windowMs ?? COALESCE_WINDOW_MS;
  const flushAt = opts?.flushAt ?? COALESCE_FLUSH_AT;
  const maxKeys = opts?.maxKeys ?? COALESCE_MAX_KEYS;
  const windows = new Map<string, Window>();

  /** Close one window, emitting its summary when anything was folded. */
  function close(id: string): void {
    const w = windows.get(id);
    if (w === undefined) return;
    windows.delete(id);
    if (w.timer !== null) clearTimeout(w.timer);
    if (w.suppressed === 0) return;
    try {
      emitSummary({
        key: w.key,
        suppressed: w.suppressed,
        firstAuditId: w.firstAuditId,
        firstAt: w.openedAt,
        lastAt: w.lastAt,
        windowMs,
      });
    } catch {
      // A summary that cannot be written must not take the process — or
      // the permission decision that scheduled it — down with it.
    }
  }

  function open(id: string, key: PermAuditKey, auditId: string): void {
    const timer = setTimeout(() => close(id), windowMs);
    // Never hold the process open for a bookkeeping timer.
    (timer as { unref?: () => void }).unref?.();
    const now = Date.now();
    windows.set(id, {
      key,
      firstAuditId: auditId,
      suppressed: 0,
      openedAt: now,
      // Seeded to the head's timestamp so a summary always reports a span
      // that CONTAINS every decision in the window, never an empty one.
      lastAt: now,
      timer,
    });
  }

  return {
    shouldWrite(key, auditId) {
      const id = keyOf(key);
      const existing = windows.get(id);
      if (existing === undefined) {
        // OOM backstop. Evicting the OLDEST window flushes its summary
        // rather than dropping the count, so the cap costs precision on
        // timing, never the record that a burst happened.
        if (windows.size >= maxKeys) {
          let oldestId: string | undefined;
          let oldestAt = Number.POSITIVE_INFINITY;
          for (const [candidateId, w] of windows) {
            if (w.openedAt < oldestAt) {
              oldestAt = w.openedAt;
              oldestId = candidateId;
            }
          }
          if (oldestId !== undefined) close(oldestId);
        }
        open(id, key, auditId);
        return true;
      }
      if (existing.suppressed >= flushAt) {
        // The window is full. Flush it and reopen with THIS call as the
        // new head, so a long walk produces a periodic summary instead of
        // one giant number at the very end.
        //
        // The check comes BEFORE the increment on purpose: this call is
        // written verbatim as the next window's head, so counting it as
        // suppressed too would report it twice. That off-by-one used to be
        // harmless bookkeeping on an allow burst; on a DENY the count is
        // the forensic content of the folded row, so `heads + suppressed`
        // must equal the number of decisions exactly (#206).
        close(id);
        open(id, key, auditId);
        return true;
      }
      existing.suppressed += 1;
      // The span ends at the last FOLDED decision — the one this summary
      // actually accounts for. The call that trips the flush above starts
      // the next window and is timestamped there.
      existing.lastAt = Date.now();
      return false;
    },

    flushAll() {
      for (const id of [...windows.keys()]) close(id);
    },

    dropAll() {
      for (const w of windows.values()) {
        if (w.timer !== null) clearTimeout(w.timer);
      }
      windows.clear();
    },

    size() {
      return windows.size;
    },
  };
}
