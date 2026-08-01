/**
 * WS3a — the user-definable tier ladder.
 *
 * A ladder is an ORDERED preference list of `{provider, model}` entries per
 * routing tier. It answers the one question every routing decision needs and
 * that a heuristic can only guess at: *when a turn needs the `fast` tier, WHICH
 * model do we actually call?*
 *
 * Before this module the answer came from two hand-maintained maps plus an
 * alphabetical accident:
 *   - `PREFERRED_TIER_MODELS` (`src/providers/registry.ts`) — one entry,
 *     `openrouter → openrouter/auto`, applied to every tier because pi-ai
 *     lists openrouter's 300+ models alphabetically and the plain scan
 *     therefore picked `ai21/jamba-large-1.7`.
 *   - `CHEAP_MODEL_BY_PROVIDER` (`src/lib/cheap-models.ts`) — the per-provider
 *     cheap pick for host-internal calls (the `/goal` evaluator, the memory
 *     compaction merge).
 * Both encoded the same knowledge ("model M is provider P's rung at tier T"),
 * so both are now seeded into {@link DEFAULT_TIER_LADDER} and this module is
 * the single source of that knowledge.
 *
 * ── Purity (why this lives in src/runtime, not src/providers) ──
 * `src/providers/**` is excluded from the coverage gate
 * (`scripts/coverage-config.ts`), and a routing decision this load-bearing
 * must be coverage-enforced. So the module is pure — no DB, no registry, no
 * pi-ai import — exactly like its sibling `../tier-classifier`, and every
 * input (the stored setting, the available-model list) is passed in by the
 * caller. The tier vocabulary is imported from `../tier-classifier`, which
 * stays the single source of tier truth.
 *
 * ── Failure posture ──
 * Routing must never break a turn. A malformed ladder is rejected at WRITE
 * time ({@link validateTierLadder}, called by the settings PUT route) and
 * merely IGNORED at read time ({@link parseTierLadder} returns undefined, and
 * every consumer falls through to its pre-ladder behaviour).
 */

import { type RoutingTier, VALID_TIERS } from "../tier-classifier";

/** Settings key holding the operator-configured ladder. */
export const TIER_LADDER_SETTING_KEY = "provider:tierModels";

/** One rung: run `model` on `provider`. */
export interface TierLadderEntry {
  provider: string;
  model: string;
}

/** The full ladder — an ordered candidate list per tier. Every tier key is
 *  always present (an unconfigured tier is an empty list, never absent), so
 *  consumers never branch on missing keys. */
export type TierLadder = Record<RoutingTier, TierLadderEntry[]>;

/**
 * Per-tier cap on stored entries. A ladder is a human-curated preference
 * list, not a catalog: a handful of rungs per tier covers every real
 * deployment, and the cap keeps a fat/hostile settings row from turning every
 * routing decision into a long scan.
 */
export const MAX_LADDER_ENTRIES_PER_TIER = 20;

/**
 * The built-in ladder, seeded verbatim from the two maps this module
 * replaces. It is deliberately NOT a wish-list of "good" models per tier —
 * inventing rungs here would silently change which model existing
 * deployments call.
 *
 * `fast` carries the host-internal cheap picks (was `CHEAP_MODEL_BY_PROVIDER`,
 * whose provider ORDER — anthropic, openai, google, ollama — was also the
 * `/goal` evaluator's credential fallback chain, so it is preserved exactly).
 * Every tier carries openrouter's own auto-router (was
 * `PREFERRED_TIER_MODELS`).
 */
export const DEFAULT_TIER_LADDER: TierLadder = {
  fast: [
    // Must be an id the catalog actually lists. An unresolvable id does NOT
    // fail loudly — `resolveModelObject` synthesizes a text-only, zero-cost
    // stand-in, which would silently strip image support from Auto's capability
    // intersection AND make every turn it served report as "unpriced".
    { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    { provider: "openai", model: "gpt-4o-mini" },
    { provider: "google", model: "gemini-2.0-flash-lite" },
    { provider: "ollama", model: "gemma4:e2b" },
    { provider: "openrouter", model: "openrouter/auto" },
  ],
  balanced: [{ provider: "openrouter", model: "openrouter/auto" }],
  powerful: [{ provider: "openrouter", model: "openrouter/auto" }],
};

/**
 * Providers whose {@link DEFAULT_TIER_LADDER} rungs the MODEL REGISTRY applies
 * ahead of its catalog scan.
 *
 * Strictly one provider, and the restriction is the point: with no ladder
 * configured, `findModelForProviderInTier` must answer exactly what it
 * answered before this setting existed. openrouter is the only provider whose
 * built-in rung was already in force (`PREFERRED_TIER_MODELS`), because its
 * alphabetical catalog makes the scan meaningless. Every other provider keeps
 * the scan verbatim; their `fast` rungs above stay what they have always been
 * — host-internal picks (evaluator / compaction), never a silent re-route of
 * user traffic. A user-CONFIGURED ladder is subject to no such restriction:
 * configuring a rung is the explicit request to use it.
 */
export const BUILTIN_ROUTER_PROVIDERS: readonly string[] = ["openrouter"];

/** True when {@link DEFAULT_TIER_LADDER} may answer registry routing for this
 *  provider absent a configured ladder. */
export function isBuiltinRouterProvider(provider: string): boolean {
  return BUILTIN_ROUTER_PROVIDERS.includes(provider);
}

/** An empty ladder — every tier present, no rungs. Behaviourally identical to
 *  an unset setting. */
export function emptyTierLadder(): TierLadder {
  return { fast: [], balanced: [], powerful: [] };
}

/** {@link validateTierLadder}'s result: the normalized ladder, or the reason
 *  the value is not one. */
export type TierLadderValidation =
  | { ok: true; ladder: TierLadder }
  | { ok: false; error: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ENTRY_FIELDS = ["provider", "model"] as const;

/** Validate one rung. Returns the normalized entry, or an error string. */
function validateEntry(raw: unknown, where: string): TierLadderEntry | string {
  if (!isPlainObject(raw)) return `${where} must be an object with "provider" and "model"`;
  for (const key of Object.keys(raw)) {
    if (!(ENTRY_FIELDS as readonly string[]).includes(key)) {
      return `${where} has unknown field "${key}"`;
    }
  }
  const provider = raw.provider;
  const model = raw.model;
  if (typeof provider !== "string" || provider.trim() === "") {
    return `${where} needs a non-empty "provider"`;
  }
  if (typeof model !== "string" || model.trim() === "") {
    return `${where} needs a non-empty "model"`;
  }
  return { provider: provider.trim(), model: model.trim() };
}

/**
 * Validate + normalize a stored/submitted ladder. Strict on purpose — this is
 * the WRITE-time gate, so an unknown tier key or a typo'd field is reported
 * rather than silently dropped, and the row that lands is always canonical
 * (trimmed strings, all three tiers present, ordered as submitted).
 *
 * Accepts a partial object: a tier the caller omits is stored as an empty
 * rung list, which routing treats exactly like "not configured".
 */
export function validateTierLadder(value: unknown): TierLadderValidation {
  if (!isPlainObject(value)) return { ok: false, error: "tier ladder must be an object" };
  const ladder = emptyTierLadder();
  for (const [key, rungs] of Object.entries(value)) {
    if (!(VALID_TIERS as readonly string[]).includes(key)) {
      return { ok: false, error: `unknown tier "${key}" (expected fast/balanced/powerful)` };
    }
    if (!Array.isArray(rungs)) return { ok: false, error: `tier "${key}" must be an array` };
    if (rungs.length > MAX_LADDER_ENTRIES_PER_TIER) {
      return {
        ok: false,
        error: `tier "${key}" has ${rungs.length} entries (max ${MAX_LADDER_ENTRIES_PER_TIER})`,
      };
    }
    const out: TierLadderEntry[] = [];
    for (let i = 0; i < rungs.length; i++) {
      const entry = validateEntry(rungs[i], `${key}[${i}]`);
      if (typeof entry === "string") return { ok: false, error: entry };
      out.push(entry);
    }
    ladder[key as RoutingTier] = out;
  }
  return { ok: true, ladder };
}

/**
 * Tolerant READ of a stored ladder: the normalized ladder, or `undefined` when
 * the row is absent or malformed. Never throws — a bad settings row degrades
 * routing to its pre-ladder behaviour instead of failing a turn.
 */
export function parseTierLadder(value: unknown): TierLadder | undefined {
  if (value === undefined || value === null) return undefined;
  const result = validateTierLadder(value);
  return result.ok ? result.ladder : undefined;
}

/**
 * The model the ladder names for `provider` at `tier`, restricted to models
 * that are ACTUALLY AVAILABLE right now.
 *
 * Walks `ladder[tier]` in declared order, skipping entries for other providers
 * and entries naming a model the provider's current catalog does not list (a
 * retired id, or a model behind a credential the deployment lacks), and
 * returns the first available match — the `availableModels` member itself, so
 * the caller keeps the resolved model object without a second lookup.
 *
 * `undefined` means "the ladder has no answer here": unset ladder, nothing
 * declared for this provider+tier, or every declared entry unavailable. Every
 * caller MUST treat that as "fall through to my own default", which is what
 * makes an unset or stale ladder harmless.
 */
export function resolveLadderEntry<T extends { id: string }>(
  ladder: TierLadder | undefined,
  tier: RoutingTier,
  provider: string,
  availableModels: readonly T[],
): T | undefined {
  for (const entry of ladder?.[tier] ?? []) {
    if (entry.provider !== provider) continue;
    const found = availableModels.find((m) => m.id === entry.model);
    if (found) return found;
  }
  return undefined;
}

/**
 * The tier's rungs as a candidate CHAIN, with `preferredProvider`'s rungs
 * hoisted to the front (relative order preserved on both sides).
 *
 * For host-internal callers that walk providers until one has a usable
 * credential (the `/goal` evaluator): they cannot pre-filter on availability
 * the way {@link resolveLadderEntry} does, because "available" for them means
 * "resolveModel + getCredential both succeeded", which is only knowable by
 * trying. So this deliberately does NO availability filtering — it just orders
 * the attempts.
 */
export function ladderCandidates(
  ladder: TierLadder | undefined,
  tier: RoutingTier,
  preferredProvider?: string,
): TierLadderEntry[] {
  const rungs = ladder?.[tier] ?? [];
  if (!preferredProvider) return [...rungs];
  const preferred = rungs.filter((e) => e.provider === preferredProvider);
  const rest = rungs.filter((e) => e.provider !== preferredProvider);
  return [...preferred, ...rest];
}

/**
 * First model the ladder names for `provider` at `tier`, ignoring
 * availability. The projection that lets a legacy provider→model map be
 * derived from the ladder instead of re-declared (see
 * `src/lib/cheap-models.ts`).
 */
export function ladderModelFor(
  ladder: TierLadder,
  tier: RoutingTier,
  provider: string,
): string | undefined {
  return ladder[tier].find((e) => e.provider === provider)?.model;
}
