/**
 * WS7 — TRAINING LABELS for a future learned router.
 *
 * ── What this is, and what it is NOT ──
 * This module turns a conversation's message tree into labelled samples:
 * "given these classifier inputs, did the model we picked SUFFICE?" It trains
 * nothing and ships no model. There is no production traffic yet, so a router
 * fitted today would fit noise. What is cheap now and impossible to retrofit
 * later is the LABEL DEFINITION — the judgement about which observed user
 * behaviour counts as evidence — so that is what ships.
 *
 * Every sample carries the `routingSignals` already stamped on the turn
 * (WS5), so features and label live in one row with no join and no replay.
 *
 * ── The three classes ──
 *   NEGATIVE — the cheaper model was INSUFFICIENT. The user moved up: a
 *     mid-conversation switch to a strictly stronger tier, an A/B retry whose
 *     continued branch was served by the stronger model, or a regeneration.
 *   POSITIVE — it SUFFICED. The thread ran on for at least
 *     {@link POSITIVE_MIN_FOLLOWING_TURNS} more assistant turns on the same
 *     model, with no retry and no regeneration at this turn.
 *   EXCLUDED — counted as NEITHER. Emitted anyway (with a reason) so the
 *     exclusions are auditable rather than invisible.
 *
 * ── Why the exclusions are the highest-stakes part of this file ──
 * A capability-driven switch misread as a quality escalation would teach a
 * router to escalate on every image attachment, forever — and a poisoned label
 * is strictly worse than no label, because it survives every later fix to the
 * model, the features, and the thresholds. So this module refuses to guess:
 *
 *   - A LATERAL switch (same tier) is not evidence about tier at all.
 *   - A switch the FROM-model could not have served — the prompt carried an
 *     attachment MIME it does not accept, or the turn's own estimated input no
 *     longer fit its context window — is a CAPABILITY switch, not a quality
 *     escalation. Both checks additionally require the TO-model to actually
 *     fix the deficit, so "context window" cannot become a catch-all excuse.
 *   - A turn we cannot resolve model facts for is excluded rather than guessed
 *     at (fail-closed: no facts, no label).
 *   - A single-turn abandonment is unreadable — the user leaving says nothing
 *     about the model.
 *   - A turn whose `usage` predates the provenance keys (a legacy row, or a
 *     PINNED turn, where the router never decided) has no classifier inputs to
 *     learn from.
 *
 * ── Purity ──
 * No DB and no registry imports: messages are passed in, and the model facts
 * the capability checks need arrive through an injected
 * {@link ModelFactsResolver} — the same discipline `resolveManifest` follows in
 * `../tier-classifier`. `scripts/routing-export.ts` supplies the real resolver
 * (`getCapabilities` from `src/providers/model-capabilities.ts` plus the
 * registry's `contextWindow`); tests supply fakes. The tier vocabulary and the
 * tier ORDERING are imported, never re-declared.
 */

import {
  type RoutingConfig,
  type RoutingSignals,
  type RoutingTier,
  strongestTier,
} from "../tier-classifier";

/** The pi-ai/DB role of an answer turn — the only role that carries a routing
 *  decision, and therefore the only role that can be labelled. */
const ASSISTANT_ROLE = "assistant";
const USER_ROLE = "user";

/**
 * How many further assistant turns on the SAME model a thread must run for
 * before "no complaint" counts as positive evidence. Two is one full extra
 * exchange past the turn in question: enough that the user read the answer and
 * kept going, few enough that most real threads qualify.
 */
export const POSITIVE_MIN_FOLLOWING_TURNS = 2;

/**
 * Fraction of a model's context window that counts as CONTEXT PRESSURE. At or
 * above this, a switch to a larger-window model is read as capability-driven
 * rather than quality-driven — the turn was running out of room, and the
 * remaining headroom would not have held the answer.
 */
export const CONTEXT_PRESSURE_RATIO = 0.9;

export type LabelClass = "positive" | "negative" | "excluded";

/**
 * WHY a sample got its class. Every value is stable and machine-countable so a
 * consumer can filter a class it does not trust (e.g. drop `regenerated`, which
 * conflates "the answer was bad" with "I asked the wrong question" — see
 * {@link labelConversation}) without re-deriving the taxonomy.
 */
export type LabelReason =
  // ── negative: the user moved UP ──
  /** The next turn on this branch switched to a strictly stronger tier. */
  | "switch-escalated"
  /** An A/B sibling of this turn was served by a stronger tier, and the thread
   *  continued through THAT sibling. The prompt is held constant, so this is
   *  the cleanest paired comparison the product produces. */
  | "retry-escalated"
  /** The user re-asked this turn's prompt (a regenerate / re-run fork). */
  | "regenerated"
  // ── positive: it sufficed ──
  /** The thread ran on, on the same model, with no retry or regeneration. */
  | "continued"
  // ── excluded: counted as neither ──
  /** No `routingSignals` on the row: a legacy (pre-provenance) turn, or a
   *  PINNED turn, where the router made no decision to learn from. */
  | "no-routing-signals"
  /** Model facts unavailable for this turn or its comparison turn — the
   *  capability checks could not be run, so no label is safe. */
  | "model-facts-unknown"
  /** The switch was forced by an attachment the FROM-model does not accept. */
  | "capability-attachment"
  /** The switch was forced by the FROM-model's context window. */
  | "capability-context"
  /** The switch stayed inside the same tier — no evidence about tier. */
  | "switch-lateral"
  /** The switch moved DOWN a tier. Not an escalation; deliberately not counted
   *  as positive either (the spec's positive class requires no switch at all). */
  | "switch-downgrade"
  /** An A/B retry whose continued sibling is the same tier as this one. */
  | "retry-lateral"
  /** An A/B retry whose continued sibling is WEAKER than this one. */
  | "retry-downgrade"
  /** An A/B retry where no sibling was continued through — nothing was chosen,
   *  so nothing was preferred. */
  | "retry-unresolved"
  /** This turn IS the sibling the thread continued through. It won the
   *  comparison, which says nothing about whether a cheaper model would also
   *  have sufficed. */
  | "retry-winner"
  /** The thread stopped here (fewer than {@link POSITIVE_MIN_FOLLOWING_TURNS}
   *  further turns) with no escalation signal. Unreadable. */
  | "abandoned"
  /** The thread ran on but changed model inside the positive window, so
   *  "continued without complaint" is not true of the full window. */
  | "switched-downstream";

/**
 * The stamped classifier inputs AS STORED. Identical to `RoutingSignals` except
 * `reason`, which the `messages.usage` jsonb widens to `string` on purpose: a
 * row written by an older build can name a reason this build no longer has, and
 * a read must not fail over that. The labeller therefore reads the widened
 * shape and never narrows it back.
 */
export type StoredRoutingSignals = Omit<RoutingSignals, "reason"> & { reason: string };

/** The `usage` keys the labeller reads. A structural subset of the canonical
 *  `messages.usage` jsonb (see `src/db/schema.ts`), so this module needs no db
 *  import. */
export interface LabelUsage {
  routingSignals?: StoredRoutingSignals;
  routingConfig?: RoutingConfig;
}

/**
 * One message as the labeller needs it. A structural subset of the `messages`
 * row plus its attachment MIMEs — deliberately not the Drizzle row type, so
 * this module stays free of db imports and tests can build fixtures by hand.
 */
export interface LabelMessage {
  id: string;
  role: string;
  parentMessageId?: string | null;
  /** Ordering key among siblings. Compared as a number/string/Date via
   *  {@link orderKey}; ties break on `id` so ordering is total. */
  createdAt?: string | number | Date | null;
  /** SERVED provider/model (the message row's own columns). */
  provider?: string | null;
  model?: string | null;
  usage?: LabelUsage | null;
  /** MIME types of the files staged on THIS message. Only user turns carry
   *  them; an assistant turn's list is empty. */
  attachmentMimeTypes?: readonly string[];
}

/**
 * What the labeller must know about a model to tell a CAPABILITY switch from a
 * QUALITY escalation. Injected, never imported — see the module header.
 */
export interface ModelFacts {
  /** The model's routing tier (the registry's `tierForModel`). */
  tier: RoutingTier;
  /** Context window in tokens. `0` (or absent) means unknown, which disables
   *  the context-pressure check rather than guessing at it. */
  contextWindow: number;
  /** Every MIME the model accepts — `getCapabilities().acceptedMimeTypes`. */
  acceptedMimeTypes: ReadonlySet<string>;
}

/** Resolve a served `provider`+`model` to its facts, or `undefined` when the
 *  deployment cannot say. `undefined` excludes the sample; it never guesses. */
export type ModelFactsResolver = (provider: string, model: string) => ModelFacts | undefined;

/** One labelled turn: the features (`signals`), the label, and enough context
 *  to audit the label without re-running the labeller. */
export interface LabelledSample {
  conversationId: string;
  messageId: string;
  label: LabelClass;
  reason: LabelReason;
  /** Served identity of the turn this sample describes. */
  servedProvider: string;
  servedModel: string;
  /** Tier of the served model. Absent only when facts were unavailable. */
  servedTier?: RoutingTier;
  /** The classifier inputs stamped on the turn — the FEATURES. Absent only on
   *  a `no-routing-signals` exclusion. */
  signals?: StoredRoutingSignals;
  /** The effective routing config the turn was decided under, when stamped. */
  config?: RoutingConfig;
  /** For a negative sample: the stronger model the user moved to. */
  comparedToModel?: string;
  comparedToTier?: RoutingTier;
}

/** True when `b` is a STRICTLY stronger tier than `a`. Uses the classifier's
 *  own ranking (via `strongestTier`) so the tier order lives in exactly one
 *  place. */
function isStronger(a: RoutingTier, b: RoutingTier): boolean {
  return a !== b && strongestTier([a, b]) === b;
}

/** Total, comparable ordering key for a message's `createdAt`. Unparseable and
 *  absent values sort first (0) — a fixture or a legacy row with no timestamp
 *  must not throw on the label path. */
function orderKey(m: LabelMessage): number {
  const raw = m.createdAt;
  if (raw === null || raw === undefined) return 0;
  const t = raw instanceof Date ? raw.getTime() : new Date(raw).getTime();
  return Number.isFinite(t) ? t : 0;
}

/** Ascending by (createdAt, id) — the same total order the analytics window
 *  uses, so "which sibling is newest" means the same thing in both. */
function bySeq(a: LabelMessage, b: LabelMessage): number {
  const d = orderKey(a) - orderKey(b);
  return d !== 0 ? d : a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/** Parent→children index over one conversation's messages. */
interface TreeIndex {
  byId: Map<string, LabelMessage>;
  /** Children of a NON-NULL parent id, ascending by {@link bySeq}. Root-level
   *  rows (`parentMessageId` null) are deliberately absent: a pre-tree legacy
   *  conversation has every row at null, and treating those as siblings would
   *  manufacture retries and regenerations out of an ordinary thread. */
  children: Map<string, LabelMessage[]>;
}

function indexTree(messages: readonly LabelMessage[]): TreeIndex {
  const byId = new Map<string, LabelMessage>();
  const children = new Map<string, LabelMessage[]>();
  for (const m of messages) byId.set(m.id, m);
  for (const m of messages) {
    const parent = m.parentMessageId;
    if (!parent) continue;
    const list = children.get(parent);
    if (list) list.push(m);
    else children.set(parent, [m]);
  }
  for (const list of children.values()) list.sort(bySeq);
  return { byId, children };
}

function childrenOf(idx: TreeIndex, id: string): readonly LabelMessage[] {
  return idx.children.get(id) ?? [];
}

/**
 * The child the thread CONTINUED through: the newest child that itself has
 * children, else simply the newest child. Mirrors the "continued through"
 * definition `getRoutingStats` already uses for A/B groups, so the two agree
 * on which branch was chosen.
 */
function continuationChild(idx: TreeIndex, id: string): LabelMessage | undefined {
  const kids = childrenOf(idx, id);
  for (let i = kids.length - 1; i >= 0; i--) {
    const kid = kids[i];
    if (kid && childrenOf(idx, kid.id).length > 0) return kid;
  }
  return kids[kids.length - 1];
}

/**
 * The next `max` ASSISTANT turns down the continuation branch, nearest first.
 * Walks the tree only (no I/O); the visited set makes it total even against a
 * corrupt parent link that points back up.
 */
function assistantChainAfter(
  idx: TreeIndex,
  from: LabelMessage,
  max: number,
): LabelMessage[] {
  const out: LabelMessage[] = [];
  const seen = new Set<string>([from.id]);
  let cur: LabelMessage = from;
  while (out.length < max) {
    const next = continuationChild(idx, cur.id);
    if (!next || seen.has(next.id)) break;
    seen.add(next.id);
    cur = next;
    if (next.role === ASSISTANT_ROLE) out.push(next);
  }
  return out;
}

/** Assistant siblings of `m` (INCLUDING `m`) under its user parent, ascending.
 *  Empty for a root-level row — see {@link TreeIndex.children}. */
function assistantSiblings(idx: TreeIndex, m: LabelMessage): readonly LabelMessage[] {
  if (!m.parentMessageId) return [];
  return childrenOf(idx, m.parentMessageId).filter((s) => s.role === ASSISTANT_ROLE);
}

/** MIME types staged on the USER turn `m` answers, or none. */
function promptMimeTypes(idx: TreeIndex, m: LabelMessage): readonly string[] {
  const parent = m.parentMessageId ? idx.byId.get(m.parentMessageId) : undefined;
  if (!parent || parent.role !== USER_ROLE) return [];
  return parent.attachmentMimeTypes ?? [];
}

/**
 * Did a CAPABILITY deficit force this switch? Returns the exclusion reason, or
 * `undefined` when the switch is a genuine quality escalation.
 *
 * Both checks require the TO-model to actually REMOVE the deficit. Without
 * that, every escalation to a bigger model would look "context-driven" and the
 * negative class would empty itself out.
 */
function capabilityDrivenReason(args: {
  from: ModelFacts;
  to: ModelFacts;
  /** MIMEs on the prompt the escalated answer had to handle. */
  mimeTypes: readonly string[];
  /** Best available estimate of the input the turn had to carry. */
  estTokens: number;
}): "capability-attachment" | "capability-context" | undefined {
  const { from, to } = args;
  // 1. An attachment the old model does not take and the new one does — "I
  //    attached an image so I switched to a vision model". The most common
  //    poisoning case, and the most specific, so it is checked first.
  for (const mime of args.mimeTypes) {
    if (!from.acceptedMimeTypes.has(mime) && to.acceptedMimeTypes.has(mime)) {
      return "capability-attachment";
    }
  }
  // 2. The turn no longer fits: the old window was under pressure AND the new
  //    model's window is genuinely larger. An unknown window (0) disables the
  //    check rather than inventing a limit.
  if (
    from.contextWindow > 0 &&
    to.contextWindow > from.contextWindow &&
    args.estTokens >= from.contextWindow * CONTEXT_PRESSURE_RATIO
  ) {
    return "capability-context";
  }
  return undefined;
}

/** The input estimate to judge context pressure with: the larger of the two
 *  turns' stamped estimates. A pinned switch-target stamps no signals, so the
 *  FROM turn's own estimate is the floor — context only grows. */
function comparisonEstTokens(from: LabelMessage, to: LabelMessage): number {
  return Math.max(
    from.usage?.routingSignals?.estTokens ?? 0,
    to.usage?.routingSignals?.estTokens ?? 0,
  );
}

/** Was this turn's prompt re-asked? True when the USER turn it answers gained a
 *  NEWER user sibling (a regenerate / re-run fork writes one).
 *
 *  Requires the user turn to have a non-null parent, so a pre-tree
 *  conversation — every row at root, hence every user turn a "sibling" of every
 *  other — can never be read as a thread full of regenerations. */
function wasReasked(idx: TreeIndex, m: LabelMessage): boolean {
  const parent = m.parentMessageId ? idx.byId.get(m.parentMessageId) : undefined;
  if (!parent || parent.role !== USER_ROLE || !parent.parentMessageId) return false;
  return childrenOf(idx, parent.parentMessageId).some(
    (s) => s.role === USER_ROLE && s.id !== parent.id && bySeq(parent, s) < 0,
  );
}

/**
 * Label every assistant turn in ONE conversation.
 *
 * Non-assistant rows produce no sample at all (they carry no routing
 * decision). Every assistant row produces exactly one sample, so
 * `positive + negative + excluded` always equals the conversation's assistant
 * turn count and no turn can vanish unaccounted for.
 *
 * Decision order, most-specific first — the ordering IS part of the label
 * definition:
 *   1. no `routingSignals`      → excluded (nothing to learn from)
 *   2. facts unavailable        → excluded (fail-closed)
 *   3. this turn's A/B group    → the paired comparison, when there is one
 *   4. switch on the next turn  → the mid-conversation comparison
 *   5. the prompt was re-asked  → regeneration
 *   6. the thread ran on        → positive
 *   7. otherwise                → excluded (abandoned)
 *
 * A CAVEAT worth carrying: the `regenerated` negative conflates "the answer was
 * not good enough" with "I asked the wrong question", and a re-ask does not
 * establish that a STRONGER model would have helped. It is the weakest of the
 * three negatives, which is why it gets its own reason — a consumer that only
 * trusts model-change evidence can drop it with one filter.
 */
export function labelConversation(
  conversationId: string,
  messages: readonly LabelMessage[],
  resolveModelFacts: ModelFactsResolver,
): LabelledSample[] {
  const idx = indexTree(messages);
  const out: LabelledSample[] = [];
  for (const m of messages) {
    if (m.role !== ASSISTANT_ROLE) continue;
    out.push(labelTurn(conversationId, idx, m, resolveModelFacts));
  }
  return out;
}

function labelTurn(
  conversationId: string,
  idx: TreeIndex,
  m: LabelMessage,
  resolveModelFacts: ModelFactsResolver,
): LabelledSample {
  const servedProvider = m.provider ?? "";
  const servedModel = m.model ?? "";
  const base = { conversationId, messageId: m.id, servedProvider, servedModel };
  const excluded = (reason: LabelReason, extra: Partial<LabelledSample> = {}): LabelledSample => ({
    ...base,
    label: "excluded",
    reason,
    ...extra,
  });

  // 1. No classifier inputs → no features. Covers legacy rows AND pinned turns
  //    (a pin means the router never decided, so there is no decision to grade).
  const signals = m.usage?.routingSignals;
  if (!signals) return excluded("no-routing-signals");
  const config = m.usage?.routingConfig;
  const carried: Partial<LabelledSample> = { signals, ...(config ? { config } : {}) };

  // 2. Fail-closed on unresolvable facts: without them neither capability check
  //    can run, and an unchecked switch is exactly the label that poisons.
  const facts = servedProvider && servedModel
    ? resolveModelFacts(servedProvider, servedModel)
    : undefined;
  if (!facts) return excluded("model-facts-unknown", carried);
  const withTier: Partial<LabelledSample> = { ...carried, servedTier: facts.tier };

  /** Shared escalation adjudication for both comparison shapes. */
  const adjudicate = (
    other: LabelMessage,
    kind: "switch" | "retry",
  ): LabelledSample => {
    const otherProvider = other.provider ?? "";
    const otherModel = other.model ?? "";
    const otherFacts = otherProvider && otherModel
      ? resolveModelFacts(otherProvider, otherModel)
      : undefined;
    if (!otherFacts) return excluded("model-facts-unknown", withTier);
    const compared: Partial<LabelledSample> = {
      ...withTier,
      comparedToModel: otherModel,
      comparedToTier: otherFacts.tier,
    };
    if (facts.tier === otherFacts.tier) {
      return excluded(kind === "switch" ? "switch-lateral" : "retry-lateral", compared);
    }
    if (!isStronger(facts.tier, otherFacts.tier)) {
      return excluded(kind === "switch" ? "switch-downgrade" : "retry-downgrade", compared);
    }
    // A genuine move UP — unless a capability the old model lacks explains it.
    const capability = capabilityDrivenReason({
      from: facts,
      to: otherFacts,
      mimeTypes: promptMimeTypes(idx, other),
      estTokens: comparisonEstTokens(m, other),
    });
    if (capability) return excluded(capability, compared);
    return {
      ...base,
      label: "negative",
      reason: kind === "switch" ? "switch-escalated" : "retry-escalated",
      ...compared,
    };
  };

  // 3. A/B retry: same-role assistant siblings under one user turn. The prompt
  //    is held constant, which makes this the cleanest comparison available.
  const siblings = assistantSiblings(idx, m);
  if (siblings.length > 1) {
    const continued = continuedSibling(idx, siblings);
    if (!continued) return excluded("retry-unresolved", withTier);
    if (continued.id === m.id) return excluded("retry-winner", withTier);
    return adjudicate(continued, "retry");
  }

  // 4. Mid-conversation switch: the next assistant turn down this branch.
  const [next] = assistantChainAfter(idx, m, 1);
  if (next && !sameServedModel(m, next)) return adjudicate(next, "switch");

  // 5. The user re-asked the prompt.
  if (wasReasked(idx, m)) {
    return { ...base, label: "negative", reason: "regenerated", ...withTier };
  }

  // 6. The thread ran on, on the same model, for the full positive window.
  const following = assistantChainAfter(idx, m, POSITIVE_MIN_FOLLOWING_TURNS);
  if (following.length < POSITIVE_MIN_FOLLOWING_TURNS) return excluded("abandoned", withTier);
  if (!following.every((t) => sameServedModel(m, t))) {
    return excluded("switched-downstream", withTier);
  }
  return { ...base, label: "positive", reason: "continued", ...withTier };
}

/** Same SERVED provider+model. Compares both halves: two providers can list the
 *  same model id, and switching provider is a real switch. */
function sameServedModel(a: LabelMessage, b: LabelMessage): boolean {
  return (a.provider ?? "") === (b.provider ?? "") && (a.model ?? "") === (b.model ?? "");
}

/** The sibling the thread continued through: the newest one with children.
 *  `undefined` when the user chose none of them. */
function continuedSibling(
  idx: TreeIndex,
  siblings: readonly LabelMessage[],
): LabelMessage | undefined {
  for (let i = siblings.length - 1; i >= 0; i--) {
    const s = siblings[i];
    if (s && childrenOf(idx, s.id).length > 0) return s;
  }
  return undefined;
}

/** Class + per-reason tallies over a sample list. */
export interface LabelCounts {
  positive: number;
  negative: number;
  excluded: number;
  byReason: Record<string, number>;
}

/**
 * Tally a sample list. The per-reason breakdown is the point: an export whose
 * negatives are 90% `capability-*` exclusions is telling you the labels are
 * dominated by capability churn, which is only visible if the exclusions are
 * counted rather than dropped.
 */
export function countLabels(samples: readonly LabelledSample[]): LabelCounts {
  const counts: LabelCounts = { positive: 0, negative: 0, excluded: 0, byReason: {} };
  for (const s of samples) {
    counts[s.label] += 1;
    counts.byReason[s.reason] = (counts.byReason[s.reason] ?? 0) + 1;
  }
  return counts;
}
