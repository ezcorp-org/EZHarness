/**
 * Custom (BYOK / local) models as ROUTING candidates.
 *
 * `provider:customModels` is the settings row the "add a custom model" and
 * "add a local provider" UIs write. Before this module it was consulted by
 * exactly two things: `getModelRegistry()` (so the model appears in the
 * picker) and `resolveModel()`'s Level-1 pinned passthrough (so an explicitly
 * pinned custom id gets its baseUrl). TIER routing never saw it —
 * `findModelForProviderInTier` answers only out of pi-ai's catalog, and
 * `getModels("ollama")` is `[]` because ollama is not a pi-ai provider at all.
 *
 * Consequence, and the reason this module exists: on a local-only install
 * every tier-routed request was unanswerable. That is not a corner — a
 * workflow `agent` step carries the `__current__` inherit sentinel, which
 * `resolveModel` collapses to "no pin", so EVERY workflow agent step is
 * tier-routed. A local-only deployment could add an Ollama model, see it in
 * the picker, and still have nothing to run.
 *
 * ── How a custom model gets its tier ──
 * It does NOT get one inferred. The operator picks it in the add-model form
 * and it is stored on the row (`tier: "fast" | "balanced" | "powerful"`);
 * this module only reads it, and drops any row whose tier is not one of the
 * three. `getModelRegistry()` has always defaulted a missing tier to
 * "balanced" for display, and {@link parseCustomModelEntries} keeps that
 * exact default so the picker and the router never disagree about which tier
 * a row is in. Nothing here guesses from the model NAME: the id of a local
 * model is arbitrary (`qwen3:1.7b`, `my-finetune`), so the cost/name
 * heuristics that tier the pi-ai catalog would be pure noise applied to it.
 *
 * ── Purity (why this lives in src/runtime, not src/providers) ──
 * Same rationale as the sibling `./tier-ladder`: `src/providers/**` is
 * excluded from the coverage gate (`scripts/coverage-config.ts`), and a
 * routing decision that can change which model a turn calls must be
 * coverage-enforced. So this module is pure — no DB, no pi-ai, no registry
 * import — and the caller passes the stored settings value in.
 *
 * ── Failure posture ──
 * Identical to the ladder's: a malformed row is IGNORED, never thrown on.
 * `provider:customModels` is user data of long standing and has held loose
 * shapes (`modelId` vs `id`); routing must not break a turn over it.
 */

import { type RoutingTier, isRoutingTier } from "../tier-classifier";
import { resolveContextWindow } from "./model-context-windows";

/**
 * A custom model as routing sees it. Field-for-field a `ModelEntry`
 * (`src/providers/registry.ts`) so `findModelForProviderInTier` can return one
 * directly — structural, not a type import, to keep this module free of any
 * `src/providers` dependency.
 */
export interface CustomModelEntry {
  id: string;
  provider: string;
  tier: RoutingTier;
  contextWindow: number;
  /** Output cap, when the operator declared one. Used only to derive the
   *  enforced input budget shown in the UI. */
  maxTokens?: number;
  vision: boolean;
  reasoning: boolean;
  costTier: "low" | "medium" | "high";
  displayName?: string;
  baseUrl?: string;
  /** True when the operator declared no window and the fallback supplied one. */
  estimated?: boolean;
}

/** Tier stored on a row that omits one — matches `getModelRegistry()`'s
 *  long-standing display default, so picker and router agree. */
export const DEFAULT_CUSTOM_MODEL_TIER: RoutingTier = "balanced";

/** Provider assumed for a row that omits one. Not a guess of ours: it is
 *  `getModelRegistry()`'s shipped display default (`cm.provider ?? "ollama"`),
 *  kept verbatim so a row does not appear under one provider in the picker
 *  and route under another. */
export const DEFAULT_CUSTOM_MODEL_PROVIDER = "ollama";

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

/**
 * Normalize ONE stored row, or `null` if it cannot be routed to.
 *
 * Silently drops only a row with no usable id — there is nothing to call.
 * Everything else takes a default rather than being dropped, and every
 * default here is `getModelRegistry()`'s existing display default, so a row
 * can never show one way in the picker and route another: a missing/typo'd
 * `tier` takes {@link DEFAULT_CUSTOM_MODEL_TIER}, a missing `provider` takes
 * {@link DEFAULT_CUSTOM_MODEL_PROVIDER}.
 *
 * `modelId` and `id` are both accepted because both are in the wild: the
 * settings UI writes `modelId`, `getModelRegistry()` reads `cm.id ?? cm.modelId`.
 */
export function normalizeCustomModel(raw: unknown): CustomModelEntry | null {
  if (!isPlainObject(raw)) return null;
  const id = optionalString(raw.id) ?? optionalString(raw.modelId);
  if (!id) return null;
  const provider = optionalString(raw.provider) ?? DEFAULT_CUSTOM_MODEL_PROVIDER;

  const tier = isRoutingTier(raw.tier) ? raw.tier : DEFAULT_CUSTOM_MODEL_TIER;
  const costTier =
    raw.costTier === "low" || raw.costTier === "medium" || raw.costTier === "high"
      ? raw.costTier
      : "low";

  // An operator who declared a window gets exactly that number, uncapped-by-id
  // (a local model's id says nothing about its window). One who declared none
  // gets the fallback, MARKED — so the picker can say "estimated" instead of
  // presenting an invented 128k as though it were measured.
  const { contextWindow, estimated } = resolveContextWindow(
    provider,
    id,
    typeof raw.contextWindow === "number" ? raw.contextWindow : undefined,
  );

  return {
    id,
    provider,
    tier,
    contextWindow,
    maxTokens: typeof raw.maxTokens === "number" ? raw.maxTokens : undefined,
    vision: raw.vision === true,
    reasoning: raw.reasoning === true,
    costTier,
    displayName: optionalString(raw.displayName) ?? id,
    baseUrl: optionalString(raw.baseUrl),
    estimated,
  };
}

/**
 * Tolerant READ of the whole `provider:customModels` setting. A non-array
 * value (unset, or a row someone hand-edited into the wrong shape) yields an
 * empty list, which every consumer treats exactly like "no custom models".
 */
export function parseCustomModelEntries(value: unknown): CustomModelEntry[] {
  if (!Array.isArray(value)) return [];
  const out: CustomModelEntry[] = [];
  for (const raw of value) {
    const entry = normalizeCustomModel(raw);
    if (entry) out.push(entry);
  }
  return out;
}

/**
 * The custom models registered for `provider`, in stored order.
 *
 * Callers use this AFTER exhausting the pi-ai catalog, which is what keeps a
 * custom model from ever displacing or shadowing a built-in one.
 */
export function customModelsForProvider(
  entries: readonly CustomModelEntry[],
  provider: string,
): CustomModelEntry[] {
  return entries.filter((e) => e.provider === provider);
}

/**
 * Every provider that has at least one custom model, in first-appearance
 * order.
 *
 * `resolveModel`'s Level 3 walks a preference order that lists only the four
 * catalog providers, so a local-only deployment never even reached "ollama"
 * to ask it for a model. Appending these to the END of that order — never
 * the front — makes them reachable exactly when every configured cloud
 * provider has already been skipped for a missing credential.
 */
export function providersWithCustomModels(entries: readonly CustomModelEntry[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const entry of entries) {
    if (seen.has(entry.provider)) continue;
    seen.add(entry.provider);
    out.push(entry.provider);
  }
  return out;
}
