/**
 * Catalog gaps — a model id that is PINNED somewhere in the database but that
 * the installed pi-ai catalog no longer lists.
 *
 * WHY THIS EXISTS
 * ---------------
 * A pi-ai upgrade can retire model ids. The 0.80.6 → 0.83.0 bump retired 18
 * across the four providers EZCorp ships (8 openai + 10 openrouter). The
 * failure mode is NOT "the conversation stops resolving" — that would at
 * least be loud. Measured on 0.83.0, `resolveModelObject("openai",
 * "gpt-5.1-codex")` happily returns a SYNTHESIZED model:
 *
 *   - correct provider api + baseUrl (borrowed from a catalog sibling), so
 *     the request still goes to the right endpoint and a still-servable id
 *     keeps working — which is exactly why this must not hard-fail;
 *   - `contextWindow: 128_000`, a GUESS. The real `gpt-5.1-codex` window was
 *     far larger, and `computeInputBudget` derives the compaction budget from
 *     this field: measured 101_760 input tokens against 904_000 for a live
 *     model. The thread is therefore trimmed harder than before — silent
 *     history loss, with no error anywhere;
 *   - all-zero `cost`, which `priceSegment` reports as UNPRICED, so the
 *     conversation's spend telemetry silently becomes NULL.
 *
 * So the damage is a silent capability downgrade that PRECEDES any provider
 * error. This module makes that condition nameable and detectable. It is
 * deliberately pure — no DB, no catalog import — so the decision is testable
 * in isolation and lives inside the coverage gate (see the note in
 * src/providers/registry.ts about why `src/providers/**` is not).
 */

/** A model id pinned by a stored row (conversation, agent config, mode, …). */
export interface PinnedModelRef {
  provider: string;
  modelId: string;
  /** Where the pin lives, for the operator report. e.g. "conversations.model". */
  source?: string;
}

export interface CatalogGap extends PinnedModelRef {
  reason: "not-in-catalog";
}

/**
 * The providers whose catalog is authoritative. A pin on anything else — a
 * custom/local provider (ollama, llama.cpp, an OpenAI-compatible box) — is
 * SUPPOSED to be absent from pi's catalog and is not a gap.
 */
export const CATALOG_PROVIDERS: ReadonlySet<string> = new Set([
  "openai",
  "anthropic",
  "google",
  "openrouter",
]);

/**
 * True when this pin should be reported as a catalog gap.
 *
 * `hasBaseUrl` marks a pin that carries its own endpoint (a custom model).
 * Those are synthesized BY DESIGN and must never be reported, or every
 * local-model deployment would drown in false positives.
 */
/** Dedup key for a pin. A provider id never contains a space, so this is
 *  unambiguous — and it keeps `findCatalogGaps` and `reportCatalogGapOnce`
 *  agreeing on what "the same pin" means. */
function gapKey(ref: PinnedModelRef): string {
  return `${ref.provider} ${ref.modelId}`;
}

export function isCatalogGap(
  ref: PinnedModelRef,
  isKnown: (provider: string, modelId: string) => boolean,
  hasBaseUrl = false,
): boolean {
  if (hasBaseUrl) return false;
  if (!CATALOG_PROVIDERS.has(ref.provider)) return false;
  return !isKnown(ref.provider, ref.modelId);
}

/**
 * Every pinned ref the catalog no longer knows. Order is preserved and
 * duplicates are collapsed per provider+model, so a report over ten thousand
 * conversations pinned to one retired id is a single actionable row.
 */
export function findCatalogGaps(
  refs: readonly PinnedModelRef[],
  isKnown: (provider: string, modelId: string) => boolean,
): CatalogGap[] {
  const seen = new Set<string>();
  const gaps: CatalogGap[] = [];
  for (const ref of refs) {
    if (!isCatalogGap(ref, isKnown)) continue;
    const key = gapKey(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    gaps.push({ ...ref, reason: "not-in-catalog" });
  }
  return gaps;
}

/**
 * Decide whether to report this pin, and remember that we did.
 *
 * Returns the message to log, or `null` for "nothing to say". `seen` is the
 * caller's dedup memo: a pinned conversation resolves its model on EVERY
 * turn, so without this a single retired pin would emit a warning per turn
 * forever. Kept here (and pure — no logger, no clock) so both the decision
 * and the once-only property are inside the coverage gate; the caller owns
 * the Set and the actual logging.
 */
export function reportCatalogGapOnce(
  ref: PinnedModelRef,
  isKnown: (provider: string, modelId: string) => boolean,
  seen: Set<string>,
  hasBaseUrl = false,
): string | null {
  if (!isCatalogGap(ref, isKnown, hasBaseUrl)) return null;
  const key = gapKey(ref);
  if (seen.has(key)) return null;
  seen.add(key);
  return describeCatalogGap(ref);
}

/**
 * The operator-facing sentence. Names the id and the provider — the whole
 * requirement is that this never degrades anonymously — and says what the
 * consequence is, because "not in the catalog" alone does not tell anyone
 * why their long thread started forgetting things.
 */
export function describeCatalogGap(gap: PinnedModelRef): string {
  const where = gap.source ? ` (pinned by ${gap.source})` : "";
  return (
    `Model "${gap.modelId}" is pinned for provider "${gap.provider}"${where} but is not in the ` +
    `installed pi-ai catalog. The request still goes to ${gap.provider}, but the context window ` +
    `and per-token pricing are ESTIMATES (128k, unpriced), so long threads may be compacted more ` +
    `aggressively and spend will report as unmeasured. Re-pin the conversation to a listed model, ` +
    `or run refresh-models if the provider still serves this id.`
  );
}
