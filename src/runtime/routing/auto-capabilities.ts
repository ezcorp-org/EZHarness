/**
 * Attachment capabilities for an "Auto (smart routing)" turn.
 *
 * ── The problem ──
 * Auto has no concrete model until the first turn is served, so the composer
 * cannot ask "what does THIS model accept?". Before the Auto-default flip that
 * only affected users who deliberately chose Auto; once Auto is the default for
 * unset users it would hide the paperclip on EVERY new conversation until turn
 * 2, which is a real regression.
 *
 * ── Why an intersection, and not a guess ──
 * A hardcoded "text + PDF is probably fine" baseline is unsafe in the other
 * direction: it lets a user stage a file that the model actually served then
 * rejects, turning a hidden button into a failed send. The only answer that
 * cannot over-promise is the INTERSECTION of the capabilities of every model
 * the router could plausibly serve this turn — i.e. every rung of the
 * configured tier ladder, across all tiers, since tier selection happens later
 * (at send time) from signals the composer does not have yet.
 *
 * Intersection semantics, all deliberately conservative:
 *   - `kinds` / `acceptedMimeTypes` — present only if EVERY candidate accepts
 *     them. In practice this lands on text+PDF for a mixed ladder, and widens
 *     by itself to images when every rung is vision-capable.
 *   - `maxBytesPerFile` / `maxFilesPerMessage` — the MINIMUM across candidates,
 *     so the limit shown is one no candidate can violate.
 *   - No candidates (empty/unconfigured ladder) → `undefined`, and the caller
 *     keeps today's hide-the-paperclip behaviour rather than inventing limits.
 *
 * Pure: candidates are passed in. Lives under `src/runtime/**` (coverage
 * enforced) rather than `src/providers/**` (a coverage-gate EXCLUDE), same
 * reason `tier-classifier.ts` does.
 */

/** The capability shape this module intersects — structurally the subset of
 *  `src/providers/model-capabilities.ts`'s entry that the composer consumes.
 *  Kept structural so this module stays import-free and pure. */
export interface IntersectableCapabilities {
  kinds: readonly string[];
  acceptedMimeTypes: readonly string[];
  maxBytesPerFile: number;
  maxFilesPerMessage: number;
}

export interface AutoCapabilities {
  kinds: string[];
  acceptedMimeTypes: string[];
  maxBytesPerFile: number;
  maxFilesPerMessage: number;
}

/** One ladder rung — the shape `ladderCandidates` yields. */
export interface LadderRung {
  provider: string;
  model: string;
}

/**
 * Rungs the deployment could ACTUALLY be served, given the providers it holds
 * credentials for.
 *
 * This exists because the intersection is only conservative in the useful
 * direction if its inputs are reachable. A rung on an unconfigured provider can
 * never answer a turn, so folding its capabilities in narrows what the composer
 * offers for no reason — an install with vision-capable models everywhere it
 * can actually route would still lose images to one unreachable text-only rung.
 *
 * Falls back to the FULL set when nothing matches, rather than returning
 * empty. An empty result would 404 the endpoint and hide the paperclip
 * entirely; a deployment with no credentials at all cannot chat anyway, and
 * this way the answer degrades to exactly the pre-filter behaviour instead of
 * to a broken composer.
 */
export function routableRungs(
  rungs: readonly LadderRung[],
  availableProviders: ReadonlySet<string>,
): LadderRung[] {
  const routable = rungs.filter((r) => availableProviders.has(r.provider));
  return routable.length > 0 ? routable : [...rungs];
}

/**
 * Every DISTINCT rung across the tiers given, in tier then ladder order.
 * Deduped on `provider::model` because a rung repeated across tiers (the
 * built-in ladder lists `openrouter/auto` in all three) must not be probed —
 * or weighted — more than once.
 */
export function uniqueRungs(perTier: ReadonlyArray<readonly LadderRung[]>): LadderRung[] {
  const seen = new Set<string>();
  const out: LadderRung[] = [];
  for (const tier of perTier) {
    for (const rung of tier) {
      const key = `${rung.provider}::${rung.model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(rung);
    }
  }
  return out;
}

/** Values every candidate agrees on, or undefined when there are none. */
function intersectStrings(lists: ReadonlyArray<readonly string[]>): string[] {
  const [first, ...rest] = lists;
  if (!first) return [];
  // Preserve the first candidate's ordering — the picker renders the accept
  // list, and a stable order keeps the UI (and its evidence screenshots)
  // deterministic across requests.
  return first.filter((v) => rest.every((other) => other.includes(v)));
}

/**
 * Intersect the capabilities of every model the router could serve.
 * Returns `undefined` for an empty candidate set so the caller can fall back
 * to today's behaviour instead of fabricating a permissive default.
 */
export function intersectCapabilities(
  candidates: ReadonlyArray<IntersectableCapabilities>,
): AutoCapabilities | undefined {
  if (candidates.length === 0) return undefined;
  return {
    kinds: intersectStrings(candidates.map((c) => c.kinds)),
    acceptedMimeTypes: intersectStrings(candidates.map((c) => c.acceptedMimeTypes)),
    // Math.min over a non-empty list — a candidate reporting 0 legitimately
    // clamps the whole set to 0 (nothing can be attached), which the composer
    // then renders as "no attachments", not as an error.
    maxBytesPerFile: Math.min(...candidates.map((c) => c.maxBytesPerFile)),
    maxFilesPerMessage: Math.min(...candidates.map((c) => c.maxFilesPerMessage)),
  };
}
