/**
 * Kilo AI Gateway — the I/O half.
 *
 * All the decisions (free vs paid, tier assignment, payload parsing) live in
 * the pure, coverage-gated `../runtime/routing/kilo-catalog`. This module is
 * the part that cannot be pure: the built-in seed as pi-ai `AnyModel`s, the
 * network fetch, and the projections into the two shapes the rest of
 * `src/providers` speaks (`ModelEntry` for the picker/router, `AnyModel` for
 * the wire).
 *
 * ── Why a seed exists at all ──
 * pi-ai has no `kilo` provider, so without a built-in list a fresh deployment
 * shows zero Kilo models until an admin presses "Refresh models". That would
 * defeat the point: Kilo's free tier is the one provider a deployment can use
 * with NOTHING configured, and requiring an admin action first puts a
 * configuration step in front of the zero-configuration path.
 *
 * The seed is deliberately only the five `kilo-auto/*` routers. Their ids are
 * stable and their backing models are chosen server-side, so the seed cannot go
 * stale the way a hardcoded `vendor/model:free` list would — Kilo rotates the
 * free pool, and `kilo-auto/free` follows it without a release here.
 *
 * ── Wire compatibility ──
 * Measured against the live gateway: it accepts `store`, the `developer` role,
 * strict-mode tool definitions, SSE streaming with
 * `stream_options.include_usage`, and BOTH `max_tokens` and
 * `max_completion_tokens`.
 *
 * REASONING IS THE EXCEPTION, and it needs an override. Kilo is an
 * **OpenRouter-compatible** gateway — its catalog advertises `reasoning` /
 * `include_reasoning` in `supported_parameters` and never `reasoning_effort`
 * — but pi-ai's `detectCompat` only recognises OpenRouter by
 * `provider === "openrouter"` or `baseUrl.includes("openrouter.ai")`, neither
 * of which matches Kilo. It therefore fell through to the OpenAI branch and
 * sent `reasoning_effort`, which Kilo normalises into its own
 * `reasoning.effort` for the upstream and then rejects as a conflict:
 *
 *     400 "reasoning_effort" and "reasoning.effort" are both provided
 *         with conflicting values
 *
 * Measured across the 12 free models: `reasoning_effort` + `reasoning.effort`
 * together is a **400 on 10 of 12**; the OpenRouter form (`reasoning: {effort}`,
 * including `effort: "none"` for off) is **200 on all 12**. Declaring
 * `thinkingFormat: "openrouter"` makes pi-ai emit only the nested form — the
 * branches in `buildParams` are mutually exclusive, so the conflicting pair
 * becomes structurally impossible from our side rather than merely unlikely.
 *
 * Nothing else is overridden. The `developer` role in particular was probed
 * across all 12 and accepted, so it is left on pi-ai's detection rather than
 * defensively disabled.
 */

import type { AnyModel } from "./model-types";
import type { ModelEntry } from "./registry";
import { getSetting, upsertSetting } from "../db/queries/settings";
import {
  KILO_BASE_URL,
  KILO_FREE_AUTO_MODEL,
  KILO_MODELS_URL,
  kiloAccessForKey,
  kiloModelsForAccess,
  kiloRoutingFill,
  mergeKiloCatalog,
  parseKiloCatalog,
  type KiloAccess,
  type KiloModel,
} from "../runtime/routing/kilo-catalog";
import { KILO_PROVIDER, PROVIDER_ENV_KEYS } from "../runtime/routing/llm-providers";
import type { RoutingTier } from "../runtime/tier-classifier";

export { KILO_BASE_URL, KILO_FREE_AUTO_MODEL, KILO_PROVIDER };

/** Settings row the admin "Refresh models" button writes, shared with the
 *  other providers' discovery cache. */
export const KILO_DISCOVERED_SETTING = `provider:discoveredModels:${KILO_PROVIDER}`;

/** Settings row holding the encrypted BYOK key. */
const KILO_API_KEY_SETTING = `provider:apiKey:${KILO_PROVIDER}`;

/**
 * The built-in seed — the five `kilo-auto/*` routers, with metadata read off
 * the live catalog rather than invented.
 *
 * `cost` is USD per 1M tokens (the repo convention); the gateway quotes USD per
 * token, so these are its numbers × 1e6.
 */
export const KILO_SEED_MODELS: readonly KiloModel[] = [
  {
    id: "kilo-auto/frontier",
    name: "Kilo Auto — Frontier",
    contextWindow: 1_000_000,
    maxTokens: 128_000,
    vision: true,
    reasoning: true,
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    free: false,
    declaredTier: "powerful",
  },
  {
    id: "kilo-auto/balanced",
    name: "Kilo Auto — Balanced",
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    vision: true,
    reasoning: true,
    cost: { input: 0.325, output: 1.95, cacheRead: 0.0325, cacheWrite: 0.40625 },
    free: false,
    declaredTier: "balanced",
  },
  {
    id: "kilo-auto/efficient",
    name: "Kilo Auto — Efficient",
    contextWindow: 1_000_000,
    maxTokens: 65_536,
    vision: true,
    reasoning: true,
    cost: { input: 0.325, output: 1.95, cacheRead: 0.0325, cacheWrite: 0.40625 },
    free: false,
    declaredTier: "balanced",
  },
  {
    id: "kilo-auto/small",
    name: "Kilo Auto — Small",
    contextWindow: 262_144,
    maxTokens: 32_768,
    vision: true,
    reasoning: true,
    cost: { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 },
    free: false,
    declaredTier: "fast",
  },
  {
    id: KILO_FREE_AUTO_MODEL,
    name: "Kilo Auto — Free",
    contextWindow: 256_000,
    maxTokens: 10_000,
    vision: false,
    reasoning: true,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    free: true,
    declaredTier: "balanced",
  },
];

// ── Projections ──────────────────────────────────────────────────────

/**
 * Cost tier for a Kilo model, using the same USD-per-1M thresholds
 * `registry.ts#inferTier` applies to every other provider — restated rather
 * than imported to keep this module out of an import cycle with `registry.ts`
 * (which imports this one for `resolveModelObject`). The thresholds are pinned
 * by `kilo-catalog.test.ts` against `tierForModel` so they cannot drift apart
 * silently.
 */
function kiloCostTier(model: KiloModel): ModelEntry["costTier"] {
  const blended = model.cost.input + model.cost.output;
  if (blended <= 3) return "low";
  if (blended <= 30) return "medium";
  return "high";
}

/**
 * Routing tier for a model with no declared one — the ordinary
 * `vendor/model` rows discovery returns.
 *
 * Free models all price at $0, which the cost heuristic alone would file as
 * `fast`; that is wrong for something like `nvidia/nemotron-3-ultra-550b-a55b:free`
 * (a 1M-context frontier model that merely costs nothing). So name hints are
 * consulted FIRST for the zero-priced rows, exactly as `inferTier` does when a
 * provider reports no pricing.
 */
function kiloRoutingTier(model: KiloModel): RoutingTier {
  if (model.declaredTier) return model.declaredTier;
  const lower = model.id.toLowerCase();
  if (/\bmini\b|nano|tiny|flash|lite|small|haiku/.test(lower)) return "fast";
  if (/ultra|opus|frontier|\bmax\b|\bpro\b|405b|480b|550b/.test(lower)) return "powerful";
  const costTier = kiloCostTier(model);
  if (costTier === "high") return "powerful";
  if (costTier === "low" && model.cost.input + model.cost.output > 0) return "fast";
  return "balanced";
}

/**
 * The one wire override Kilo needs — see the header. `openrouter` makes pi-ai
 * emit `reasoning: { effort }` and never the `reasoning_effort` that the
 * gateway rejects as a conflict.
 */
export const KILO_COMPAT = { thinkingFormat: "openrouter" } as const;

/** Picker/router row for a Kilo model. */
export function kiloModelToEntry(model: KiloModel): ModelEntry {
  return {
    id: model.id,
    provider: KILO_PROVIDER,
    tier: kiloRoutingTier(model),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    vision: model.vision,
    reasoning: model.reasoning,
    costTier: kiloCostTier(model),
    displayName: model.name,
    // Carrying the gateway root here is what makes a tier-ROUTED Kilo model
    // dial Kilo instead of api.openai.com — `resolveModel` forwards
    // `entry.baseUrl` into `resolveModelObject` for exactly this reason.
    baseUrl: KILO_BASE_URL,
  };
}

/**
 * pi-ai wire model for a Kilo model, PLUS the `free` flag.
 *
 * `free` is not a pi-ai field, and carrying it here is deliberate: this is the
 * shape `POST /api/providers/kilo/refresh-models` persists to
 * `provider:discoveredModels:kilo`, and `parseKiloCatalog` reads that row back.
 * Without the flag the reader falls to the id-shape heuristic, which marks
 * `openrouter/free` PAID and hides it from every keyless deployment. The extra
 * property is inert to pi-ai (it reads the fields it knows).
 */
export function kiloModelToAnyModel(model: KiloModel): AnyModel & { free: boolean } {
  return {
    free: model.free,
    id: model.id,
    name: model.name,
    api: "openai-completions",
    provider: KILO_PROVIDER,
    baseUrl: KILO_BASE_URL,
    compat: KILO_COMPAT,
    reasoning: model.reasoning,
    input: model.vision ? (["text", "image"] as ("text" | "image")[]) : (["text"] as ("text" | "image")[]),
    cost: model.cost,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
  };
}

// ── Catalog loading ──────────────────────────────────────────────────

/**
 * Is a Kilo key configured?
 *
 * Deliberately a settings/env presence check rather than `getCredential`:
 * `getCredential("kilo")` always succeeds (it falls back to the keyless
 * sentinel), so it cannot answer "may this deployment call PAID models". Reads
 * the encrypted row's presence only — it never decrypts, because an
 * undecryptable key is still a key someone tried to configure, and the gateway
 * is the right place to reject it.
 */
export async function hasKiloApiKey(): Promise<boolean> {
  const envKey = PROVIDER_ENV_KEYS[KILO_PROVIDER];
  if (envKey && process.env[envKey]) return true;
  try {
    return !!(await getSetting(KILO_API_KEY_SETTING));
  } catch {
    // Settings DB unavailable — assume free-only, the conservative answer.
    return false;
  }
}

/** The deployment's current Kilo access level. */
export async function kiloAccess(): Promise<KiloAccess> {
  return kiloAccessForKey(await hasKiloApiKey());
}

/** Models cached by the last "Refresh models" run, or `[]`. */
async function loadDiscoveredKiloModels(): Promise<KiloModel[]> {
  try {
    const stored = await getSetting(KILO_DISCOVERED_SETTING);
    return parseKiloCatalog(stored);
  } catch {
    return [];
  }
}

/**
 * The full merged catalog (seed ∪ discovered), filtered to what this
 * deployment may call.
 */
export async function kiloCatalogForAccess(access: KiloAccess): Promise<KiloModel[]> {
  const merged = mergeKiloCatalog(KILO_SEED_MODELS, await loadDiscoveredKiloModels());
  return kiloModelsForAccess(merged, access);
}

/**
 * Kilo rows for the model PICKER — one per model, deduped.
 * Returns `[]` on any failure: a broken Kilo catalog must not empty the picker.
 */
export async function kiloPickerEntries(): Promise<ModelEntry[]> {
  try {
    return (await kiloCatalogForAccess(await kiloAccess())).map(kiloModelToEntry);
  } catch {
    return [];
  }
}

/**
 * Kilo rows for ROUTING — the picker rows plus the free-router fill that keeps
 * every tier answerable (see `kiloRoutingFill`). May repeat
 * `kilo-auto/free` across tiers; routing tolerates that, the picker must not
 * see it.
 */
export async function kiloRoutingEntries(): Promise<ModelEntry[]> {
  try {
    const models = await kiloCatalogForAccess(await kiloAccess());
    const entries = models.map(kiloModelToEntry);
    const fill = kiloRoutingFill(models, entries.map((e) => e.tier)).map(kiloModelToEntry);
    return [...entries, ...fill];
  } catch {
    return [];
  }
}

/**
 * Wire model for a Kilo id — the catalog row when we have one, otherwise a
 * stand-in carrying the correct api + baseUrl.
 *
 * The stand-in matters: without it `resolveModelObject` falls through to its
 * generic branch and points a Kilo pin at `https://api.openai.com/v1`, which
 * fails as a wrong-provider auth error instead of a model-not-found. Sync
 * because `resolveModelObject` is, so it consults only the SEED — a discovered
 * id resolves through `resolveDiscoveredModel` on the async path first.
 */
export function resolveKiloModel(modelId: string): AnyModel {
  const seeded = KILO_SEED_MODELS.find((m) => m.id === modelId);
  if (seeded) return kiloModelToAnyModel(seeded);
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: KILO_PROVIDER,
    baseUrl: KILO_BASE_URL,
    compat: KILO_COMPAT,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 16_384,
  };
}

// ── Live discovery ───────────────────────────────────────────────────

/**
 * Fetch the live catalog.
 *
 * Unauthenticated on purpose — the endpoint needs no key, and a keyless
 * deployment must still be able to learn which free models exist. A key is
 * attached when present so the response reflects anything account-scoped.
 *
 * Returns the parsed rows for `refresh-models` to cache. Throws on a transport
 * or HTTP failure so that route can report it, exactly as the other providers'
 * discovery does.
 */
/**
 * How long a warmed catalog is considered current. A restart inside this window
 * skips the fetch, so a crash-looping or frequently-redeployed instance cannot
 * hammer the endpoint.
 */
export const KILO_CATALOG_TTL_MS = 6 * 60 * 60 * 1000;

/** Timestamp row for {@link warmKiloCatalog}'s staleness check. */
export const KILO_DISCOVERED_AT_SETTING = `provider:discoveredModelsAt:${KILO_PROVIDER}`;

/**
 * Populate the Kilo catalog at boot, so the picker lists **every** free model
 * rather than just the seed's `kilo-auto/free`.
 *
 * Without this, the full free pool (12 models today) appeared only after an
 * admin pressed "Refresh models" — an admin action standing in front of the one
 * provider that is supposed to need no setup, and one a non-admin user cannot
 * take. The endpoint needs no credential, which is what makes warming it at
 * boot possible at all.
 *
 * Deliberately fire-and-forget and OFF the request path: `getModelRegistry()`
 * runs on every `/api/models` call and must not make a network round trip.
 * Writes the same settings row the admin button writes, so the two paths agree
 * and the manual refresh still works as an override.
 *
 * Never throws — a gateway outage at boot must cost the extra models, not the
 * boot.
 */
export async function warmKiloCatalog(): Promise<"fresh" | "skipped" | "failed"> {
  try {
    const at = await getSetting(KILO_DISCOVERED_AT_SETTING);
    const existing = await getSetting(KILO_DISCOVERED_SETTING);
    // Only skip when a PREVIOUS warm actually left models behind — a stale
    // timestamp with an empty row would otherwise pin the deployment to the
    // seed for six hours.
    if (
      typeof at === "number" &&
      Date.now() - at < KILO_CATALOG_TTL_MS &&
      Array.isArray(existing) &&
      existing.length > 0
    ) {
      return "skipped";
    }
    const models = (await fetchKiloCatalog()).map(kiloModelToAnyModel);
    await upsertSetting(KILO_DISCOVERED_SETTING, models);
    await upsertSetting(KILO_DISCOVERED_AT_SETTING, Date.now());
    return "fresh";
  } catch {
    return "failed";
  }
}

export async function fetchKiloCatalog(apiKey?: string): Promise<KiloModel[]> {
  const res = await fetch(KILO_MODELS_URL, {
    headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
    signal: AbortSignal.timeout(20_000),
  });
  if (!res.ok) {
    throw new Error(`Kilo gateway returned ${res.status}: ${await res.text()}`);
  }
  const models = parseKiloCatalog(await res.json());
  if (models.length === 0) {
    throw new Error("Kilo gateway returned no usable models");
  }
  return models;
}
