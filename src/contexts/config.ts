/**
 * Topic-contexts model resolution.
 *
 * A fallback ladder picks WHERE the detection/extraction LLM runs. The
 * default is the local composer-suggestions sidecar (grammar-constrained,
 * keyless, always available) — accuracy is the top requirement and a small
 * grammar-constrained model beats a large free-form one for the JSON
 * detection pass.
 *
 * Ladder (see tasks/topic-contexts-spec.md § "Model resolution"):
 *   1. `contexts:model` setting ("provider/modelId") →
 *        - matches a `provider:customModels` entry with a baseUrl (local /
 *          custom OpenAI-compatible) → SIDECAR lane (keeps grammar);
 *        - otherwise resolveModel() → PI lane (cloud, credentialed).
 *      An unresolvable pin warns and falls through.
 *   2. Unset (DEFAULT = local): the suggest sidecar
 *      (`getSuggestConfig` + `isEnhanceAvailable` probe) → SIDECAR lane.
 *   3. Sidecar down → the conversation's turn model, then the default tier,
 *      via resolveModel() → PI lane.
 *   4. Nothing resolvable → typed 503 (`ContextsUnavailableError`).
 *
 * Deps are injected (defaulting to the real modules) so every rung is unit
 * testable without a network, DB, or model.
 */

import { getSetting } from "../db/queries/settings";
import { getSuggestConfig } from "../suggest/config";
import { isEnhanceAvailable } from "../suggest/enhance";
import { resolveModel } from "../providers/router";
import { getConversation } from "../db/queries/conversations";
import { logger } from "../logger";

const log = logger.child("contexts.config");

/** Admin-editable setting: `"provider/modelId"`, mirroring
 *  `compaction:summarizeModel`. Unset = default-local. */
export const CONTEXTS_MODEL_KEY = "contexts:model";

/** Where a contexts completion should run. */
export type ContextsTarget =
  | {
      /** Raw OpenAI-compatible /v1 endpoint (grammar-constrained decoding). */
      kind: "sidecar";
      baseUrl: string;
      model: string;
    }
  | {
      /** pi-ai `completeLLM` lane (cloud / credentialed models). */
      kind: "pi";
      provider: string;
      modelId: string;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      piModel: any;
    };

/** Thrown when the ladder is exhausted — the route maps this to a 503 with
 *  the actionable `message`. */
export class ContextsUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ContextsUnavailableError";
  }
}

const NO_MODEL_MESSAGE =
  "No model available for topic contexts. Set a model under Settings → Topic Contexts, start the local suggestions sidecar, or connect a provider.";

/**
 * Parse a `"provider/modelId"` setting. Splits on the FIRST slash (model
 * ids can themselves contain slashes, e.g. `openrouter/meta-llama/…`).
 * Returns null for a non-string, empty, or slash-less / empty-part value.
 */
export function parseModelSetting(
  value: unknown,
): { provider: string; modelId: string } | null {
  if (typeof value !== "string") return null;
  const slash = value.indexOf("/");
  if (slash <= 0) return null;
  const provider = value.slice(0, slash).trim();
  const modelId = value.slice(slash + 1).trim();
  if (!provider || !modelId) return null;
  return { provider, modelId };
}

export interface ResolveContextsDeps {
  getSetting: (key: string) => Promise<unknown>;
  getSuggestConfig: () => Promise<{ baseUrl: string | null; model: string }>;
  isEnhanceAvailable: (baseUrl: string) => Promise<boolean>;
  resolveModel: (
    provider?: string,
    modelId?: string,
  ) => Promise<{ provider: string; model: string; piModel: unknown }>;
  getConversation: (
    id: string,
  ) => Promise<{ provider: string | null; model: string | null } | null>;
}

const DEFAULT_DEPS: ResolveContextsDeps = {
  getSetting,
  getSuggestConfig,
  isEnhanceAvailable,
  resolveModel,
  getConversation,
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function piTarget(resolved: { provider: string; model: string; piModel: any }): ContextsTarget {
  return { kind: "pi", provider: resolved.provider, modelId: resolved.model, piModel: resolved.piModel };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findCustomModel(customModels: any[], provider: string, modelId: string) {
  return customModels.find(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (m: any) => (m?.id ?? m?.modelId) === modelId && (m?.provider ?? "ollama") === provider,
  );
}

/**
 * Resolve the contexts LLM target for a conversation, walking the fallback
 * ladder. Throws {@link ContextsUnavailableError} only when every rung
 * fails.
 */
export async function resolveContextsTarget(
  conversationId: string,
  overrides: Partial<ResolveContextsDeps> = {},
): Promise<ContextsTarget> {
  const deps = { ...DEFAULT_DEPS, ...overrides };

  // ── Rung 1: explicit `contexts:model` setting ──────────────────────
  const parsed = parseModelSetting(await deps.getSetting(CONTEXTS_MODEL_KEY));
  if (parsed) {
    // A user-defined local/custom endpoint keeps the grammar-constrained
    // sidecar lane (the accuracy backbone on small models). We read the
    // baseUrl straight from `provider:customModels` — the same source
    // resolveModel() consults — so a local pin never loses its grammar.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customModels = ((await deps.getSetting("provider:customModels")) as any[]) ?? [];
    const custom = findCustomModel(customModels, parsed.provider, parsed.modelId);
    if (custom?.baseUrl) {
      return { kind: "sidecar", baseUrl: custom.baseUrl, model: parsed.modelId };
    }
    try {
      return piTarget(await deps.resolveModel(parsed.provider, parsed.modelId));
    } catch (err) {
      log.warn("contexts:model pin failed to resolve; falling through ladder", {
        pick: `${parsed.provider}/${parsed.modelId}`,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // ── Rung 2: default local sidecar ──────────────────────────────────
  const suggest = await deps.getSuggestConfig();
  if (suggest.baseUrl && (await deps.isEnhanceAvailable(suggest.baseUrl))) {
    return { kind: "sidecar", baseUrl: suggest.baseUrl, model: suggest.model };
  }

  // ── Rung 3: conversation turn model, then default tier (pi lane) ────
  const conv = conversationId ? await deps.getConversation(conversationId) : null;
  if (conv?.provider && conv?.model) {
    try {
      return piTarget(await deps.resolveModel(conv.provider, conv.model));
    } catch (err) {
      log.warn("contexts turn-model resolve failed; trying default tier", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  try {
    return piTarget(await deps.resolveModel(undefined));
  } catch (err) {
    log.warn("contexts default-tier resolve failed; no model available", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Rung 4: nothing ────────────────────────────────────────────────
  throw new ContextsUnavailableError(NO_MODEL_MESSAGE);
}

/** Human-readable provenance string stored on saved_contexts / the topic
 *  watermark (`local/<model>` for the sidecar lane, `<provider>/<model>`
 *  for the pi lane). */
export function describeTarget(target: ContextsTarget): string {
  return target.kind === "sidecar"
    ? `local/${target.model}`
    : `${target.provider}/${target.modelId}`;
}
