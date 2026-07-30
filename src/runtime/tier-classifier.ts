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
 *   3. Heuristic     — STRUCTURAL agentic predicates (a tool-result turn in
 *      history, a deep history, a huge system prompt) first, then the
 *      approximate prompt+context token length (chars/4) plus the presence
 *      + kind of tools available this turn.
 *
 * ── Why the heuristic reads the WHOLE turn, not just the user message ──
 * WS5. Scoring `userMessage.length` alone mis-reads the single most
 * context-heavy kind of turn there is: a short follow-up inside an agentic
 * tool loop ("now fix it") arrives with a four-word prompt but drags a full
 * tool transcript, a long history, and a big system prompt behind it — and
 * classified as `fast`. So the heuristic scores prompt + history + system +
 * attachments, and treats the STRUCTURE of the turn (does history contain a
 * tool result? how deep is it? how big is the system prompt?) as sufficient
 * on its own to force `powerful`, independent of length. Every one of those
 * signals is already in memory at the decision point — the classifier adds
 * no I/O and no await to get them.
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

/**
 * The two SIZE thresholds as a parameter bundle.
 *
 * They exist so `scripts/routing-sweep.ts` can replay stored `routingSignals`
 * against CANDIDATE thresholds through THIS function rather than through a
 * second copy of the heuristic that would drift from it. Today's values are
 * {@link DEFAULT_TIER_THRESHOLDS}; omitting the field classifies exactly as
 * before, which is what makes the sweep's baseline point honest — it is not a
 * reimplementation of today's behaviour, it IS today's behaviour.
 */
export interface TierThresholds {
  /** At/under this many estimated tokens (tool-less) → the fast tier. */
  fastMaxTokens: number;
  /** At/over this many estimated tokens → the powerful tier. */
  powerfulMinTokens: number;
}

/** The shipped thresholds. Both numbers are educated GUESSES — they were never
 *  fitted to traffic, which is exactly why the sweep exists. */
export const DEFAULT_TIER_THRESHOLDS: TierThresholds = {
  fastMaxTokens: FAST_MAX_TOKENS,
  powerfulMinTokens: POWERFUL_MIN_TOKENS,
};

/**
 * OVER this many messages in the turn's LLM-visible history, the turn is an
 * established multi-step interaction rather than a fresh question — route it
 * up regardless of how short the latest prompt is. 8 messages is ~4
 * exchanges: past the point where a one-line follow-up is self-contained.
 * Structural, not length-based, on purpose (see the header): the whole
 * failure this closes is a short prompt hiding a deep turn.
 */
export const AGENTIC_MIN_HISTORY_MESSAGES = 8;

/**
 * OVER this many estimated tokens of SYSTEM prompt, the turn is carrying a
 * heavily tooled / agent-configured / project-instructed context. That is a
 * "do work" turn even when the user's message is trivially short.
 * (~8k characters.)
 */
export const AGENTIC_MIN_SYSTEM_TOKENS = 2000;

/**
 * Flat token surcharge per attachment staged on the turn. Attachments cost
 * far more than their handle text implies (an image is ~750–1500 tokens once
 * encoded) and that cost is invisible to a chars/4 count, so bill each one a
 * fixed estimate rather than under-reading the turn.
 */
export const ATTACHMENT_TOKEN_ESTIMATE = 750;

/** The pi-ai message role that carries a tool's output. Its presence in a
 *  turn's history is the strongest structural "this is an agentic loop"
 *  signal available without any I/O. */
export const TOOL_RESULT_ROLE = "toolResult";

const TIER_RANK: Record<RoutingTier, number> = {
  fast: 0,
  balanced: 1,
  powerful: 2,
};

/** The three tiers as a value list, in ascending strength order. Exported so
 *  modules that must enumerate tiers (the tier ladder's validator + editor)
 *  never re-declare the vocabulary this module owns. */
export const VALID_TIERS: readonly RoutingTier[] = ["fast", "balanced", "powerful"];

/** True for one of the three routing tiers (narrows `unknown`). */
export function isRoutingTier(value: unknown): value is RoutingTier {
  return typeof value === "string" && (VALID_TIERS as readonly string[]).includes(value);
}

/** Signals derived from the request that shape the heuristic tier.
 *
 *  EVERY field beyond `promptChars` is optional and defaults to a
 *  zero/false that contributes nothing, so a legacy caller that passes only
 *  `promptChars` gets byte-identical classification to the pre-WS5 module.
 */
export interface TierClassifierInput {
  /** The user's message for THIS turn, in characters. Negative values are
   *  clamped to 0. */
  promptChars: number;
  /** Text length of the turn's LLM-visible history, in characters. */
  historyChars?: number;
  /** How many messages the turn's LLM-visible history holds. */
  historyMessageCount?: number;
  /** Whether history contains any tool-result message — i.e. this turn is a
   *  continuation of an agentic tool loop. */
  hasToolMessages?: boolean;
  /** Resolved system-prompt length in characters. */
  systemChars?: number;
  /** How many attachments are staged on this turn. */
  attachmentCount?: number;
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
  /** Override the two SIZE thresholds. Absent ⇒ {@link DEFAULT_TIER_THRESHOLDS},
   *  i.e. today's classification. Only the retroactive threshold sweep sets
   *  this; no runtime caller does. */
  thresholds?: TierThresholds;
}

/** Which predicate actually decided the tier. Provenance only — the routing
 *  decision is the tier alone — but logging it is what lets a later sweep
 *  re-derive "would threshold X have changed this turn?" from stored rows
 *  instead of replaying traffic. */
export type TierReason =
  | "declared"
  | "hint"
  | "scorer"
  | "tool-messages"
  | "history-depth"
  | "system-size"
  | "complex-tools"
  | "context-size"
  | "tool-count"
  | "short-turn"
  | "midsize-turn";

/** The classifier's full raw verdict: the tier it acts on, plus WHY and the
 *  size it scored. */
export interface TierVerdict {
  tier: RoutingTier;
  reason: TierReason;
  estTokens: number;
  /** Only present when an injected {@link TierScorer} decided the tier — the
   *  score it reported alongside the tier. Absent on every heuristic verdict,
   *  so a no-scorer verdict serializes byte-identically to the pre-seam one. */
  confidence?: number;
}

/**
 * WS7 — the INFERENCE SEAM for a future learned router, shipped UNUSED.
 *
 * No router model is trained or wired by this work: nothing in the codebase
 * passes a scorer today, and with no scorer the classifier's output is
 * byte-identical to the pure-heuristic version (proved in
 * `src/__tests__/tier-scorer-seam.test.ts` against a verbatim reimplementation
 * of the pre-seam function). What ships is the shape a learned scorer would
 * plug into, because retrofitting a decision point this load-bearing after the
 * fact is exactly the kind of change that quietly alters routing for every
 * existing deployment.
 *
 * The score is consulted BELOW `declaredTier` and `tierHint` and ABOVE the
 * heuristic. That ordering is not a preference: a declared tier is a
 * CORRECTNESS requirement (an extension that needs `powerful` breaks on
 * `fast`) and a hint is explicit user intent. A model may only ever replace
 * the guess, never either of those.
 *
 * Returning `undefined` ABSTAINS — the heuristic then decides, so a scorer
 * that is unsure (or a model that failed to load) degrades to today's
 * behaviour instead of guessing.
 */
export interface TierScore {
  tier: RoutingTier;
  /** The scorer's own confidence, 0–1. Provenance only: the classifier does
   *  NOT threshold on it (a scorer that wants a floor abstains instead), it is
   *  stamped so a later sweep can measure calibration on real traffic. */
  confidence: number;
}

/** The scoring call itself. Spelled as a standalone function type rather than a
 *  call signature INSIDE `TierScorer` on purpose: a call-signature member is
 *  type-only, but some coverage shards still emit a phantom zero-hit lcov line
 *  for it, which no test can ever cover and which fails the 100% gate on this
 *  file. A plain arrow type erases cleanly on every shard. */
export type TierScoreFn = (input: TierClassifierInput) => TierScore | undefined;

/** A pluggable tier scorer. Callable, plus an optional `version` that is
 *  stamped into `usage.routingConfig.scorerVersion` so "why did this cost more
 *  yesterday" stays answerable across scorer rollouts. */
export type TierScorer = TierScoreFn & {
  /** Stable identifier for the scorer build (e.g. `"router-v3"`). */
  version?: string;
};

/**
 * Estimated total input tokens for the turn: prompt + history + system text
 * at the chars/4 approximation, plus a flat per-attachment surcharge.
 * Each component is clamped at 0 so a bogus negative can only ever
 * under-count, never route a turn up.
 */
export function estimateTurnTokens(input: TierClassifierInput): number {
  const chars =
    Math.max(0, input.promptChars) +
    Math.max(0, input.historyChars ?? 0) +
    Math.max(0, input.systemChars ?? 0);
  const attachmentTokens = Math.max(0, input.attachmentCount ?? 0) * ATTACHMENT_TOKEN_ESTIMATE;
  return Math.ceil(chars / CHARS_PER_TOKEN) + attachmentTokens;
}

/**
 * Classify a turn AND report why. Pure + total — always returns a verdict,
 * never throws. {@link classifyTier} is this function's `.tier`; the extra
 * `reason`/`estTokens` exist so the wiring can stamp provenance without
 * re-deriving (or drifting from) the decision it actually acted on.
 */
export function classifyTierVerdict(
  input: TierClassifierInput,
  scorer?: TierScorer,
): TierVerdict {
  const estTokens = estimateTurnTokens(input);
  // 1. A declared tier need (extension manifest / EZ-action) is a
  //    correctness requirement — honor it above everything else.
  if (input.declaredTier) return { tier: input.declaredTier, reason: "declared", estTokens };
  // 2. An explicit caller/user hint.
  if (input.tierHint) return { tier: input.tierHint, reason: "hint", estTokens };
  // 2b. WS7 inference seam — a learned scorer, when one is injected. Below
  //     both signals above (correctness + explicit intent always win) and
  //     above the heuristic (a model exists to replace the guess). Nothing
  //     injects one today; an abstaining (undefined) scorer falls through, so
  //     both no-scorer paths are the pre-seam heuristic verbatim.
  if (scorer) {
    const score = scorer(input);
    if (score) {
      return { tier: score.tier, reason: "scorer", estTokens, confidence: score.confidence };
    }
  }

  // 3a. Heuristic, STRUCTURAL half. These fire on the SHAPE of the turn, so
  //     they catch the case the length heuristic below cannot: a short
  //     prompt continuing a long, tool-driven piece of work.
  //     A tool result in history means the model is mid-loop, reasoning over
  //     output it just produced — the most context-heavy turn there is.
  if (input.hasToolMessages) return { tier: "powerful", reason: "tool-messages", estTokens };
  //     A deep history means an established multi-step interaction.
  if ((input.historyMessageCount ?? 0) > AGENTIC_MIN_HISTORY_MESSAGES) {
    return { tier: "powerful", reason: "history-depth", estTokens };
  }
  //     A huge system prompt means heavy tooling/instructions to reason over.
  if (
    Math.ceil(Math.max(0, input.systemChars ?? 0) / CHARS_PER_TOKEN) > AGENTIC_MIN_SYSTEM_TOKENS
  ) {
    return { tier: "powerful", reason: "system-size", estTokens };
  }

  // 3b. Heuristic, SIZE half (unchanged order + thresholds).
  //     Complex (write/shell/orchestration) tools imply a multi-step
  //     reasoning turn → the powerful tier.
  if (input.hasComplexTools) return { tier: "powerful", reason: "complex-tools", estTokens };
  // Large context → a powerful model earns its cost.
  const thresholds = input.thresholds ?? DEFAULT_TIER_THRESHOLDS;
  if (estTokens >= thresholds.powerfulMinTokens) {
    return { tier: "powerful", reason: "context-size", estTokens };
  }
  // Any (read-class) tool use → at least balanced; tools rarely pair well
  // with the cheapest models.
  if ((input.toolCount ?? 0) > 0) return { tier: "balanced", reason: "tool-count", estTokens };
  // Short, tool-less turn → cheap/fast.
  if (estTokens <= thresholds.fastMaxTokens) return { tier: "fast", reason: "short-turn", estTokens };
  // Everything in between.
  return { tier: "balanced", reason: "midsize-turn", estTokens };
}

/**
 * Classify a turn into a routing tier from heuristic signals only.
 * Pure + total — always returns a tier, never throws.
 */
export function classifyTier(input: TierClassifierInput, scorer?: TierScorer): RoutingTier {
  return classifyTierVerdict(input, scorer).tier;
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

/**
 * The rung one step WEAKER than `tier`, or `undefined` at the bottom of the
 * ladder. Lives here because this module owns `TIER_RANK` — the tier order is
 * declared exactly once (see also {@link strongestTier}), so bounded
 * exploration (`routing/exploration.ts`) walks the ladder down without
 * re-declaring it.
 */
export function tierBelow(tier: RoutingTier): RoutingTier | undefined {
  const rank = TIER_RANK[tier];
  return VALID_TIERS.find((t) => TIER_RANK[t] === rank - 1);
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

/** Structural view of ONE already-loaded history message. Kept structural
 *  (not an import of pi-ai's `Message`) so this module stays
 *  dependency-free and pure. */
export interface TierHistoryMessage {
  role: string;
  content?: unknown;
}

/** The three history-derived signals, measured in one pass. */
export interface HistorySignals {
  historyChars: number;
  historyMessageCount: number;
  hasToolMessages: boolean;
}

/**
 * Text length of one message's `content`. pi-ai content is either a plain
 * string or an array of parts; only text parts have a length worth counting
 * here (an image part's real cost is billed via `attachmentCount` /
 * {@link ATTACHMENT_TOKEN_ESTIMATE}, not by measuring its base64).
 * Tolerant of any shape — an unrecognized content payload counts 0 rather
 * than throwing, because this runs on the routing hot path.
 */
export function contentChars(content: unknown): number {
  if (typeof content === "string") return content.length;
  if (!Array.isArray(content)) return 0;
  let chars = 0;
  for (const part of content) {
    const text = (part as { text?: unknown } | null)?.text;
    if (typeof text === "string") chars += text.length;
  }
  return chars;
}

/**
 * Measure an already-loaded history array in one synchronous pass. Reads
 * only what is already in memory — no I/O, no await, and (critically) no
 * dependency on the racing tool-load phase (see {@link estimateToolSignals}).
 */
export function summarizeHistory(
  history: readonly TierHistoryMessage[] | null | undefined,
): HistorySignals {
  let historyChars = 0;
  let hasToolMessages = false;
  for (const m of history ?? []) {
    historyChars += contentChars(m.content);
    if (m.role === TOOL_RESULT_ROLE) hasToolMessages = true;
  }
  return { historyChars, historyMessageCount: history?.length ?? 0, hasToolMessages };
}

/** Everything `chooseTurnTier` needs from the turn, minus the injected
 *  manifest resolver. The WS5 fields are all optional: omitting them
 *  reproduces the pre-WS5 classification exactly. */
export interface TurnTierInput {
  userMessage: string;
  options: RoutingSignalsOptions & { tier?: RoutingTier };
  convExtensionTools: Record<string, string[]> | null | undefined;
  /** The turn's already-loaded LLM-visible history (the `loadHistory`
   *  result). Passed as the array — measuring it is a synchronous pass, and
   *  keeping the measurement here means the wiring can't drift from it. */
  history?: readonly TierHistoryMessage[] | null;
  /** Resolved system-prompt length in characters. Snapshot by the caller
   *  BEFORE the parallel setup phase can mutate the prompt, so the value
   *  scored is deterministic. */
  systemChars?: number;
  /** Attachments staged on THIS turn. */
  attachmentCount?: number;
}

/**
 * The raw classifier inputs for a turn PLUS the verdict they produced.
 * Stamped onto `messages.usage.routingSignals` so thresholds can be swept
 * retroactively against real traffic: we act on the tier binarily, but the
 * row keeps every number the decision was made from.
 */
export interface RoutingSignals extends HistorySignals {
  promptChars: number;
  systemChars: number;
  attachmentCount: number;
  toolCount: number;
  hasComplexTools: boolean;
  estTokens: number;
  /**
   * The tier the CLASSIFIER decided on — NOT necessarily the tier that served
   * the turn. When `exploration` is true the wiring deliberately routed one
   * rung below this, and the served tier is `usage.routedTier`. Keeping both
   * is the whole point: the counterfactual ("the heuristic wanted `powerful`,
   * `balanced` was served, the thread continued") is the unbiased comparison
   * exploration exists to produce, and collapsing the two would destroy it.
   */
  tier: RoutingTier;
  reason: TierReason;
  /** Only present (and always `true`) when bounded exploration moved this turn
   *  one rung below `tier`. Absent on every ordinary turn — see
   *  `routing/exploration.ts`. */
  exploration?: boolean;
  /** The scorer's confidence, when an injected scorer decided the tier.
   *  Absent on every heuristic verdict — nothing injects a scorer today. */
  confidence?: number;
}

/** {@link chooseTurnVerdict}'s result: the tier to route on + the full
 *  signal record to stamp as provenance. */
export interface TurnTierVerdict {
  tier: RoutingTier;
  signals: RoutingSignals;
  /** Version of the injected scorer that decided this turn's tier, when one
   *  did. Folded into `usage.routingConfig` by {@link withScorerVersion}.
   *  Always absent today (no scorer is wired). */
  scorerVersion?: string;
}

/**
 * One-call orchestrator the routing wiring uses: gather the declared +
 * heuristic signals for a turn, classify, and hand back BOTH the tier and
 * the raw signal record. Pure (the registry lookup is injected as
 * `resolveManifest`), so the wiring at the decision point stays a single
 * thin call.
 */
export function chooseTurnVerdict(
  input: TurnTierInput,
  resolveManifest: (extId: string) => ExtensionRoutingManifest | undefined,
  scorer?: TierScorer,
): TurnTierVerdict {
  const declaredTier = declaredTierForConversation(input.convExtensionTools, resolveManifest);
  const { toolCount, hasComplexTools } = estimateToolSignals(input.options);
  const history = summarizeHistory(input.history);
  const promptChars = input.userMessage.length;
  const systemChars = Math.max(0, input.systemChars ?? 0);
  const attachmentCount = Math.max(0, input.attachmentCount ?? 0);
  const verdict = classifyTierVerdict(
    {
      promptChars,
      ...history,
      systemChars,
      attachmentCount,
      toolCount,
      hasComplexTools,
      tierHint: input.options.tier,
      declaredTier,
    },
    scorer,
  );
  return {
    tier: verdict.tier,
    signals: {
      promptChars,
      ...history,
      systemChars,
      attachmentCount,
      toolCount,
      hasComplexTools,
      estTokens: verdict.estTokens,
      tier: verdict.tier,
      reason: verdict.reason,
      // Conditional spreads, never `undefined` keys: a heuristic turn must
      // stamp the same jsonb shape it always has.
      ...(verdict.confidence !== undefined ? { confidence: verdict.confidence } : {}),
    },
    // Only reported when a scorer ACTUALLY decided — a scorer that abstained
    // did not shape this row, so naming its version would be misleading.
    ...(verdict.reason === "scorer" && scorer?.version ? { scorerVersion: scorer.version } : {}),
  };
}

/**
 * Tier-only view of {@link chooseTurnVerdict}, for callers that don't stamp
 * provenance.
 */
export function chooseTurnTier(
  input: TurnTierInput,
  resolveManifest: (extId: string) => ExtensionRoutingManifest | undefined,
  scorer?: TierScorer,
): RoutingTier {
  return chooseTurnVerdict(input, resolveManifest, scorer).tier;
}

/**
 * The effective routing CONFIG a turn was decided under. Stamped alongside
 * {@link RoutingSignals} so a sweep can tell "the thresholds changed" apart
 * from "the deployment's provider config changed" when comparing rows across
 * time. The preference order is hashed rather than stored: the sweep only
 * needs to group rows by identical config, and a hash keeps provider names
 * out of per-message rows.
 */
export interface RoutingConfig {
  defaultTier: RoutingTier;
  /** 8-hex-char FNV-1a digest of the effective `provider:preferenceOrder`. */
  preferenceOrderHash: string;
  /**
   * WS7 — version of the injected {@link TierScorer} that decided the turn.
   * ABSENT means the heuristic decided (which is every row today: no scorer is
   * wired). Recorded because a scorer rollout changes cost the same way a
   * threshold change does, and "why did this cost more yesterday" must stay
   * answerable from the row alone rather than from a deploy log.
   */
  scorerVersion?: string;
}

/**
 * Fold a scorer version into the effective routing config for stamping.
 * Returns the config UNCHANGED (same object identity) when there is no version
 * to fold — which is the shipped path, since nothing injects a scorer. Lives
 * here, in the pure module, so the conditional is unit-tested both ways
 * instead of sitting as an unexercised branch at the wiring site.
 */
export function withScorerVersion(
  config: RoutingConfig | undefined,
  scorerVersion: string | undefined,
): RoutingConfig | undefined {
  if (!config || !scorerVersion) return config;
  return { ...config, scorerVersion };
}

/**
 * Stable 32-bit FNV-1a digest of a provider preference order, as 8 hex
 * chars. Order-sensitive (a reorder yields a different digest — the point)
 * and dependency-free: FNV-1a is the repo's idiom for a non-crypto grouping
 * hash (`extensions/llm-handler.ts`, `stream-chat/context-summarize.ts`),
 * and it keeps this module import-free so it stays pure and portable to the
 * `worker/` target, where `node:crypto` is not a given.
 */
export function preferenceOrderHash(order: readonly string[] | null | undefined): string {
  const joined = (order ?? []).join(",");
  let h = 0x811c9dc5;
  for (let i = 0; i < joined.length; i++) {
    h ^= joined.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
