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
import { getModelSupport, peekModelSupport, type ModelSupportReason, type ModelSupportResult } from "./model-support";
import { logger } from "../logger";

const log = logger.child("contexts.config");

/** Which lane a contexts completion actually runs on — surfaced to the UI so
 *  it can distinguish "local works" from "local unavailable, using a fallback"
 *  from "nothing available". */
export type ContextsActiveLane = "local" | "cloud" | "turn-model";

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

/** Human phrasing for each unsupported reason, used in the actionable 503 and
 *  the popover notice. */
const REASON_TEXT: Record<ModelSupportReason, string> = {
  "endpoint-down": "the local model endpoint is unreachable",
  "model-missing": "the model isn't installed",
  "load-failed": "your machine couldn't load it",
  timeout: "it took too long to load",
};

/** The actionable message when the local model is unsupported AND no fallback
 *  lane could serve — carries the model name + why. */
export function unsupportedModelMessage(model: string, reason?: ModelSupportReason): string {
  const why = reason ? REASON_TEXT[reason] : "it is unavailable";
  return `Your machine can't run the local model ${model} (${why}). Pick a smaller model in Settings → Topic Contexts, or connect a provider.`;
}

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
  /** Consulted before returning a SIDECAR target. On the write path (detect /
   *  extract) this probes-or-caches; on the read path (capability) it is the
   *  cached-only peek that returns null when not yet probed (treated as
   *  supported so a cold cache never blocks the feature). */
  getModelSupport: (baseUrl: string, model: string) => Promise<ModelSupportResult | null>;
}

const DEFAULT_DEPS: ResolveContextsDeps = {
  getSetting,
  getSuggestConfig,
  isEnhanceAvailable,
  resolveModel,
  getConversation,
  getModelSupport,
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

/** The resolved target plus which lane it represents. */
export interface ContextsResolution {
  target: ContextsTarget;
  activeLane: ContextsActiveLane;
}

/**
 * Walk the fallback ladder, consulting the resource-aware support gate before
 * committing to any SIDECAR target. An unsupported sidecar rung is SKIPPED (its
 * model + reason remembered), and the ladder continues — so an unsupported
 * local default keeps the feature working via the turn/default-tier lane. Only
 * when every rung fails do we throw: with the specific unsupported reason when
 * the sidecar was the blocker, else the generic no-model message.
 */
async function resolveContextsResolution(
  conversationId: string,
  deps: ResolveContextsDeps,
): Promise<ContextsResolution> {
  let unsupported: { model: string; reason?: ModelSupportReason } | null = null;

  // ── Rung 1: explicit `contexts:model` setting ──────────────────────
  // The settings UI writes "" when the user clears the picker or selects the
  // "Current Chat Model" sentinel — that (and any whitespace / non-string)
  // means UNSET, so fall silently to the default-local sidecar. A NON-empty
  // value that isn't a valid "provider/modelId" is a genuine misconfiguration:
  // warn (so an operator sees why the pin is ignored) but still fall through.
  const rawModelSetting = await deps.getSetting(CONTEXTS_MODEL_KEY);
  const parsed = parseModelSetting(rawModelSetting);
  if (!parsed && typeof rawModelSetting === "string" && rawModelSetting.trim().length > 0) {
    log.warn('contexts:model is set but is not a valid "provider/modelId"; ignoring', {
      value: rawModelSetting,
    });
  }
  if (parsed) {
    // A user-defined local/custom endpoint keeps the grammar-constrained
    // sidecar lane (the accuracy backbone on small models). We read the
    // baseUrl straight from `provider:customModels` — the same source
    // resolveModel() consults — so a local pin never loses its grammar.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customModels = ((await deps.getSetting("provider:customModels")) as any[]) ?? [];
    const custom = findCustomModel(customModels, parsed.provider, parsed.modelId);
    if (custom?.baseUrl) {
      const support = await deps.getModelSupport(custom.baseUrl, parsed.modelId);
      if (!support || support.supported) {
        return { target: { kind: "sidecar", baseUrl: custom.baseUrl, model: parsed.modelId }, activeLane: "local" };
      }
      unsupported = { model: parsed.modelId, reason: support.reason };
    } else {
      try {
        return { target: piTarget(await deps.resolveModel(parsed.provider, parsed.modelId)), activeLane: "cloud" };
      } catch (err) {
        log.warn("contexts:model pin failed to resolve; falling through ladder", {
          pick: `${parsed.provider}/${parsed.modelId}`,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  // ── Rung 2: default local sidecar ──────────────────────────────────
  const suggest = await deps.getSuggestConfig();
  if (suggest.baseUrl && (await deps.isEnhanceAvailable(suggest.baseUrl))) {
    const support = await deps.getModelSupport(suggest.baseUrl, suggest.model);
    if (!support || support.supported) {
      return { target: { kind: "sidecar", baseUrl: suggest.baseUrl, model: suggest.model }, activeLane: "local" };
    }
    unsupported = unsupported ?? { model: suggest.model, reason: support.reason };
  }

  // ── Rung 3: conversation turn model, then default tier (pi lane) ────
  const conv = conversationId ? await deps.getConversation(conversationId) : null;
  if (conv?.provider && conv?.model) {
    try {
      return { target: piTarget(await deps.resolveModel(conv.provider, conv.model)), activeLane: "turn-model" };
    } catch (err) {
      log.warn("contexts turn-model resolve failed; trying default tier", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  try {
    return { target: piTarget(await deps.resolveModel(undefined)), activeLane: "turn-model" };
  } catch (err) {
    log.warn("contexts default-tier resolve failed; no model available", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // ── Rung 4: nothing ────────────────────────────────────────────────
  if (unsupported) {
    throw new ContextsUnavailableError(unsupportedModelMessage(unsupported.model, unsupported.reason));
  }
  throw new ContextsUnavailableError(NO_MODEL_MESSAGE);
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
  return (await resolveContextsResolution(conversationId, deps)).target;
}

/** Human-readable provenance string stored on saved_contexts / the topic
 *  watermark (`local/<model>` for the sidecar lane, `<provider>/<model>`
 *  for the pi lane). */
export function describeTarget(target: ContextsTarget): string {
  return target.kind === "sidecar"
    ? `local/${target.model}`
    : `${target.provider}/${target.modelId}`;
}

/** The support/lane summary surfaced ADDITIVELY on GET topics so the chat UI
 *  can render the right notice (subtle fallback vs prominent unsupported). */
export interface ContextsCapability {
  /** The effective default-local model (the sidecar candidate). */
  localModel: string;
  /** Whether the machine can run that local model (peek — unprobed = true). */
  supported: boolean;
  /** Why not, when unsupported. */
  reason?: ModelSupportReason;
  /** Which lane a completion would actually run on right now. */
  activeLane: ContextsActiveLane;
}

/** The effective local (sidecar-candidate) model: a rung-1 local pin when set,
 *  else the default-local suggest config. `baseUrl` null = no local endpoint. */
async function effectiveLocalModel(
  deps: ResolveContextsDeps,
): Promise<{ baseUrl: string | null; model: string }> {
  const raw = await deps.getSetting(CONTEXTS_MODEL_KEY);
  const parsed = parseModelSetting(raw);
  if (parsed) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const customModels = ((await deps.getSetting("provider:customModels")) as any[]) ?? [];
    const custom = findCustomModel(customModels, parsed.provider, parsed.modelId);
    if (custom?.baseUrl) return { baseUrl: custom.baseUrl, model: parsed.modelId };
  }
  const suggest = await deps.getSuggestConfig();
  return { baseUrl: suggest.baseUrl, model: suggest.model };
}

/** Cached-only support adapter for the READ path — never probes. */
const peekSupport = async (baseUrl: string, model: string): Promise<ModelSupportResult | null> =>
  peekModelSupport(baseUrl, model);

/**
 * Describe the current local-model capability + active lane WITHOUT running any
 * LLM or a blocking probe (GET topics must stay instant). Support is read from
 * the cached-only peek: a not-yet-probed model is reported supported
 * (optimistic — boot warmup usually primes it) so a cold cache never scares the
 * user. When the whole ladder is exhausted, `activeLane` stays `local` (the
 * intended default) with `supported:false` — the chat UI reads that as
 * "prominent unsupported notice".
 */
export async function describeCapability(
  conversationId: string,
  overrides: Partial<ResolveContextsDeps> = {},
): Promise<ContextsCapability> {
  const deps = { ...DEFAULT_DEPS, getModelSupport: peekSupport, ...overrides };

  const local = await effectiveLocalModel(deps);
  let supported = false;
  let reason: ModelSupportReason | undefined = "endpoint-down";
  if (local.baseUrl) {
    const support = await deps.getModelSupport(local.baseUrl, local.model);
    if (support === null) {
      supported = true;
      reason = undefined;
    } else {
      supported = support.supported;
      reason = support.supported ? undefined : support.reason;
    }
  }

  let activeLane: ContextsActiveLane = "local";
  try {
    activeLane = (await resolveContextsResolution(conversationId, deps)).activeLane;
  } catch {
    // Ladder exhausted → keep the intended `local` lane; supported:false above
    // tells the UI to show the prominent unsupported notice.
  }

  return { localModel: local.model, supported, reason, activeLane };
}
