/**
 * Live model discovery against the public models.dev catalog.
 *
 * Unlike provider-native /v1/models endpoints, models.dev is unauth'd and
 * ships full metadata (pricing, context window, modalities, reasoning).
 * Sidesteps scope-restricted API keys entirely.
 *
 * Catalog: https://models.dev/api.json — top-level keyed by provider slug
 * ("openai", "anthropic", "google", …), each with a `models` map.
 */

import type { Model } from "@mariozechner/pi-ai";

export interface DiscoveredModel extends Model<any> {}

const CATALOG_URL = "https://models.dev/api.json";

// Provider slug on models.dev → pi-ai api + baseUrl for runtime calls
const PROVIDER_DEFAULTS: Record<
  string,
  { api: string; baseUrl: string }
> = {
  openai: {
    api: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
  },
  anthropic: {
    api: "anthropic-messages",
    baseUrl: "https://api.anthropic.com",
  },
  google: {
    api: "google-generative-ai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
  },
};

// ── models.dev schema (just what we consume) ─────────────────────────

interface CatalogModel {
  id: string;
  name?: string;
  reasoning?: boolean;
  modalities?: { input?: string[]; output?: string[] };
  cost?: { input?: number; output?: number; cache_read?: number; cache_write?: number };
  limit?: { context?: number; output?: number };
}

interface CatalogProvider {
  id: string;
  name?: string;
  models?: Record<string, CatalogModel>;
}

type Catalog = Record<string, CatalogProvider>;

// ── In-memory cache (5 min TTL) ──────────────────────────────────────
// models.dev serves the whole catalog (~100 providers) in one JSON blob,
// so we fetch once and slice per provider on repeat clicks.

let cache: { at: number; data: Catalog } | null = null;
const CACHE_TTL_MS = 5 * 60 * 1000;

async function getCatalog(): Promise<Catalog> {
  if (cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  const res = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) {
    throw new Error(`models.dev returned ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as Catalog;
  cache = { at: Date.now(), data };
  return data;
}

/** Exported for tests. */
export function _resetCatalogCache(): void {
  cache = null;
}

// ── Chat-capability filter ───────────────────────────────────────────
// models.dev includes embeddings, TTS, image gen, moderation, etc. We only
// want chat-shaped models whose output can be text.

function isChatCapable(m: CatalogModel): boolean {
  const outputs = m.modalities?.output ?? [];
  if (!outputs.includes("text")) return false;
  const id = m.id.toLowerCase();
  if (/embedding|whisper|tts|moderation|dall-e|image-gen|audio-preview/.test(id)) {
    return false;
  }
  return true;
}

// ── Catalog entry → pi-ai Model<any> ─────────────────────────────────

function toModel(providerSlug: string, m: CatalogModel): DiscoveredModel {
  const defaults = PROVIDER_DEFAULTS[providerSlug];
  if (!defaults) throw new Error(`Unknown provider slug: ${providerSlug}`);

  const inputs = m.modalities?.input ?? ["text"];
  // pi-ai's Model.input only understands "text" | "image"
  const input = inputs.filter((x): x is "text" | "image" => x === "text" || x === "image");
  if (!input.includes("text")) input.unshift("text");

  return {
    id: m.id,
    name: m.name ?? m.id,
    api: defaults.api as any,
    provider: providerSlug as any,
    baseUrl: defaults.baseUrl,
    reasoning: m.reasoning ?? false,
    input,
    cost: {
      input: m.cost?.input ?? 0,
      output: m.cost?.output ?? 0,
      cacheRead: m.cost?.cache_read ?? 0,
      cacheWrite: m.cost?.cache_write ?? 0,
    },
    contextWindow: m.limit?.context ?? 128_000,
    maxTokens: m.limit?.output ?? 8_192,
  };
}

// ── Public dispatcher ────────────────────────────────────────────────

export async function fetchProviderModels(provider: string): Promise<DiscoveredModel[]> {
  if (!PROVIDER_DEFAULTS[provider]) {
    throw new Error(`Model discovery not supported for provider: ${provider}`);
  }

  const catalog = await getCatalog();
  const entry = catalog[provider];
  if (!entry?.models) {
    throw new Error(`models.dev has no "${provider}" entry or it's empty`);
  }

  const out: DiscoveredModel[] = [];
  for (const m of Object.values(entry.models)) {
    if (!isChatCapable(m)) continue;
    out.push(toModel(provider, m));
  }
  return out;
}
