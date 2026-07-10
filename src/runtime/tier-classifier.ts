/**
 * WS3 — Heuristic quality-tier routing (pi-caching/routing integration).
 *
 * Maps a chat turn to a routing tier (`fast`/`balanced`/`powerful`) from
 * cheap, synchronous HEURISTIC signals ONLY — deliberately NO LLM
 * pre-classification call, because a pre-call re-adds exactly the latency
 * quality-tier routing exists to cut. Every function here is a pure
 * function of its inputs (no DB, no registry, no imports) so it is
 * trivially unit-testable to 100% and adds zero routing latency.
 *
 * Signals (in precedence order):
 *   1. `declaredTier` — a tier need declared by an extension (manifest
 *      `routing.tier`) or an EZ-action (`EzAction.tier`) wired into the
 *      turn. This is a correctness requirement, not a preference, so it
 *      wins over the heuristic and the caller hint.
 *   2. `tierHint`    — an explicit tier hint threaded from the caller
 *      (UI / agent-config / internal caller).
 *   3. Heuristic     — approximate prompt+context token length (chars/4)
 *      plus the presence + kind of tools available this turn.
 *
 * ── Cache interaction (why the WIRING, not this module, owns stability) ──
 * WS1 gives the assembled prompt a byte-stable cache-able prefix; the
 * Anthropic cache is prefix-matched, so SWITCHING MODELS mid-conversation
 * discards it (guaranteed miss + a 25% cache-write surcharge on the next
 * turn). The routing wiring therefore only ever *consults* this classifier
 * when the thread has NO established model yet (see
 * `stream-chat/setup-tools.ts`): once a conversation has a model, that
 * model is honored verbatim (tier-stability by construction). This module
 * stays a pure prompt→tier mapper; the per-turn cache tradeoff lives at
 * the decision point it protects.
 */

/**
 * Routing tier vocabulary. Structurally identical to the provider
 * router's `TierName` (`src/providers/router.ts`) — the router imports
 * this as the single source of truth so the two never drift.
 */
export type RoutingTier = "fast" | "balanced" | "powerful";

/** chars→tokens is a well-known ~4:1 approximation; good enough for a
 *  routing heuristic that must not spend a tokenizer pass on the hot path. */
export const CHARS_PER_TOKEN = 4;

/** At/under this many estimated tokens with NO tools, a turn is cheap
 *  enough to route to the fast/cheap tier. (~2k characters.) */
export const FAST_MAX_TOKENS = 500;

/** At/over this many estimated tokens, a turn carries enough context that
 *  a powerful model earns its cost. (~32k characters.) */
export const POWERFUL_MIN_TOKENS = 8000;

const TIER_RANK: Record<RoutingTier, number> = {
  fast: 0,
  balanced: 1,
  powerful: 2,
};

const VALID_TIERS: readonly RoutingTier[] = ["fast", "balanced", "powerful"];

/** True for one of the three routing tiers (narrows `unknown`). */
export function isRoutingTier(value: unknown): value is RoutingTier {
  return typeof value === "string" && (VALID_TIERS as readonly string[]).includes(value);
}

/** Signals derived from the request that shape the heuristic tier. */
export interface TierClassifierInput {
  /** Approximate prompt + context length in characters (prompt, history,
   *  attachments — whatever the caller counts). Negative values are
   *  clamped to 0. */
  promptChars: number;
  /** How many tool SOURCES are wired this turn (0 = tool-less). */
  toolCount?: number;
  /** Whether any write/shell/orchestration-class tool is available — a
   *  multi-step "do work" turn, not a plain read. */
  hasComplexTools?: boolean;
  /** Explicit caller/user tier hint. Honored over the heuristic. */
  tierHint?: RoutingTier;
  /** Extension/EZ-action-declared tier need. Strongest signal — honored
   *  over both the hint and the heuristic. */
  declaredTier?: RoutingTier;
}

/**
 * Classify a turn into a routing tier from heuristic signals only.
 * Pure + total — always returns a tier, never throws.
 */
export function classifyTier(input: TierClassifierInput): RoutingTier {
  // 1. A declared tier need (extension manifest / EZ-action) is a
  //    correctness requirement — honor it above everything else.
  if (input.declaredTier) return input.declaredTier;
  // 2. An explicit caller/user hint.
  if (input.tierHint) return input.tierHint;

  // 3. Heuristic. Complex (write/shell/orchestration) tools imply a
  //    multi-step reasoning turn → the powerful tier.
  if (input.hasComplexTools) return "powerful";

  const estTokens = Math.ceil(Math.max(0, input.promptChars) / CHARS_PER_TOKEN);
  // Large context → a powerful model earns its cost.
  if (estTokens >= POWERFUL_MIN_TOKENS) return "powerful";
  // Any (read-class) tool use → at least balanced; tools rarely pair well
  // with the cheapest models.
  if ((input.toolCount ?? 0) > 0) return "balanced";
  // Short, tool-less turn → cheap/fast.
  if (estTokens <= FAST_MAX_TOKENS) return "fast";
  // Everything in between.
  return "balanced";
}

/**
 * Pick the strongest (highest-rank) tier from a set of declared tiers,
 * skipping null/undefined. Returns undefined when nothing is declared.
 * Used to combine tier declarations across multiple extensions/EZ-actions
 * wired into a single turn.
 */
export function strongestTier(
  tiers: ReadonlyArray<RoutingTier | undefined | null>,
): RoutingTier | undefined {
  let best: RoutingTier | undefined;
  for (const t of tiers) {
    if (!t) continue;
    if (best === undefined || TIER_RANK[t] > TIER_RANK[best]) best = t;
  }
  return best;
}

/** Minimal structural view of a manifest's optional routing declaration —
 *  kept structural (not an import of `ExtensionManifestV2`) so this module
 *  stays dependency-free and pure. */
export interface ExtensionRoutingManifest {
  routing?: { tier?: unknown };
}

/**
 * Extract + validate an extension manifest's declared routing tier.
 * Tolerant of a missing/malformed field (returns undefined) — routing is
 * an OPTIONAL manifest capability, never a hard error.
 */
export function manifestRoutingTier(
  manifest: ExtensionRoutingManifest | undefined | null,
): RoutingTier | undefined {
  const tier = manifest?.routing?.tier;
  return isRoutingTier(tier) ? tier : undefined;
}

/**
 * Resolve the strongest tier declared by the extensions wired into a
 * conversation. `convExtensionTools` is the conversation row's
 * extension-tool toggle map (keyed by extension ID); a subset that is an
 * empty array means the extension is toggled OFF for this conversation and
 * is skipped. `resolveManifest` is injected (the in-memory registry
 * lookup) so this stays a pure function.
 */
export function declaredTierForConversation(
  convExtensionTools: Record<string, string[]> | null | undefined,
  resolveManifest: (extId: string) => ExtensionRoutingManifest | undefined,
): RoutingTier | undefined {
  if (!convExtensionTools) return undefined;
  const tiers: (RoutingTier | undefined)[] = [];
  for (const [extId, subset] of Object.entries(convExtensionTools)) {
    // Empty subset = master toggle OFF for this conversation → the
    // extension contributes nothing this turn (its declared tier included).
    if (Array.isArray(subset) && subset.length === 0) continue;
    tiers.push(manifestRoutingTier(resolveManifest(extId)));
  }
  return strongestTier(tiers);
}

/** Options subset the tool-signal heuristic reads. */
export interface RoutingSignalsOptions {
  toolRestriction?: "all" | "read-only" | "none";
  projectId?: string;
  agentConfigId?: string;
  orchestrationDepth?: number;
}

/**
 * Derive `{ toolCount, hasComplexTools }` from the turn options WITHOUT
 * waiting for the (parallel, racing) tool-loading phase to finish — the
 * whole point is a zero-latency routing decision. A project attaches the
 * built-in file/shell/edit tools; an agent config attaches extension
 * tools; a read-only restriction keeps tools present but non-complex; a
 * `none` restriction means no tools at all.
 */
export function estimateToolSignals(
  o: RoutingSignalsOptions,
): { toolCount: number; hasComplexTools: boolean } {
  if (o.toolRestriction === "none") return { toolCount: 0, hasComplexTools: false };
  const readOnly = o.toolRestriction === "read-only";
  const toolCount = (o.projectId ? 1 : 0) + (o.agentConfigId ? 1 : 0);
  // Complex = a write/shell-capable project surface OR multi-step
  // sub-agent orchestration. A read-only turn never routes up on
  // tool-kind alone.
  const hasComplexTools =
    !readOnly && (o.projectId !== undefined || o.orchestrationDepth !== undefined);
  return { toolCount, hasComplexTools };
}

/** Everything `chooseTurnTier` needs from the turn, minus the injected
 *  manifest resolver. */
export interface TurnTierInput {
  userMessage: string;
  options: RoutingSignalsOptions & { tier?: RoutingTier };
  convExtensionTools: Record<string, string[]> | null | undefined;
}

/**
 * One-call orchestrator the routing wiring uses: gather the declared +
 * heuristic signals for a turn and classify. Pure (the registry lookup is
 * injected as `resolveManifest`), so the wiring at the decision point
 * stays a single thin call.
 */
export function chooseTurnTier(
  input: TurnTierInput,
  resolveManifest: (extId: string) => ExtensionRoutingManifest | undefined,
): RoutingTier {
  const declaredTier = declaredTierForConversation(input.convExtensionTools, resolveManifest);
  const { toolCount, hasComplexTools } = estimateToolSignals(input.options);
  return classifyTier({
    promptChars: input.userMessage.length,
    toolCount,
    hasComplexTools,
    tierHint: input.options.tier,
    declaredTier,
  });
}
