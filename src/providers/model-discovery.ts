/**
 * Hybrid live model discovery.
 *
 * Primary source: the provider's own model list endpoint (OpenAI &
 * Anthropic both expose an OpenAI-shaped GET /v1/models). This is
 * authoritative, scoped to what the connected key can actually use, and
 * reflects new models the moment the provider ships them. The fetch is
 * the shared `listModels()` helper (reused from local-model-check) with
 * the provider's auth header attached.
 *
 * Enrichment + fallback: the public models.dev catalog
 * (https://models.dev/api.json — unauth'd, keyed by provider slug) supplies
 * rich metadata (pricing, context window, modalities, reasoning) that the
 * provider endpoints omit. When a provider-direct fetch isn't possible
 * (no credential, OAuth-only token that can't call /v1/models, Google's
 * differently-shaped API, or a network error) we fall back to the catalog
 * alone.
 */

import type { Model } from "@earendil-works/pi-ai";
import { listModels } from "./local-model-check";
import type { ProviderCredential } from "./credentials";

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
  openrouter: {
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
  },
};

// Providers whose model list we can pull directly via the OpenAI-shaped
// GET /v1/models. `host` is the API root WITHOUT the version suffix —
// listModels() appends `/v1/models` itself. `authHeaders` builds the
// provider-specific auth header from a resolved credential token.
// Google is intentionally absent: its model list lives at a different
// path/shape, so it discovers via the catalog only.
const DIRECT_PROVIDERS: Record<
  string,
  { host: string; authHeaders: (token: string) => Record<string, string> }
> = {
  openai: {
    host: "https://api.openai.com",
    authHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
  },
  anthropic: {
    host: "https://api.anthropic.com",
    authHeaders: (token) => ({
      "x-api-key": token,
      "anthropic-version": "2023-06-01",
    }),
  },
  openrouter: {
    host: "https://openrouter.ai/api",
    authHeaders: (token) => ({ Authorization: `Bearer ${token}` }),
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

/** Best-effort catalog load — returns null instead of throwing so a
 *  provider-direct fetch can still succeed when models.dev is down. */
async function tryGetCatalog(): Promise<Catalog | null> {
  try {
    return await getCatalog();
  } catch {
    return null;
  }
}

/** Exported for tests. */
export function _resetCatalogCache(): void {
  cache = null;
}

// ── Chat-capability filter ───────────────────────────────────────────
// models.dev (and provider /v1/models) include embeddings, TTS, image
// gen, moderation, etc. We only want chat-shaped models.

/** Negative id filter — works for provider-direct ids (no metadata). */
function isExcludedById(id: string): boolean {
  return /embedding|whisper|tts|moderation|dall-e|image-gen|audio-preview/.test(
    id.toLowerCase(),
  );
}

/** Catalog-path filter: must emit text AND not be an excluded id. */
function isChatCapable(m: CatalogModel): boolean {
  const outputs = m.modalities?.output ?? [];
  if (!outputs.includes("text")) return false;
  return !isExcludedById(m.id);
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

// ── Discovery sources ────────────────────────────────────────────────

function fetchFromCatalog(provider: string, catalog: Catalog): DiscoveredModel[] {
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

/** Pull the authoritative id list from the provider, enriching each id
 *  with catalog metadata when available. Returns null when the direct
 *  fetch can't be used so the caller can fall back to the catalog. */
async function fetchDirect(
  provider: string,
  credential: ProviderCredential,
  catalog: Catalog | null,
): Promise<DiscoveredModel[] | null> {
  const direct = DIRECT_PROVIDERS[provider];
  if (!direct) return null;

  const { models, error } = await listModels(direct.host, {
    headers: direct.authHeaders(credential.token),
  });
  if (error || models.length === 0) return null;

  const catalogModels = catalog?.[provider]?.models;
  const out: DiscoveredModel[] = [];
  for (const { id } of models) {
    if (isExcludedById(id)) continue;
    const meta =
      catalogModels?.[id] ??
      (catalogModels
        ? Object.values(catalogModels).find((c) => c.id === id)
        : undefined);
    out.push(toModel(provider, meta ?? { id }));
  }
  return out.length > 0 ? out : null;
}

// ── Public dispatcher ────────────────────────────────────────────────

/**
 * Discover models for a provider. When a usable credential is supplied
 * and the provider exposes an OpenAI-shaped /v1/models, the list comes
 * straight from the provider (enriched with models.dev metadata).
 * Otherwise — or if the direct call fails — the models.dev catalog is
 * used on its own.
 */
export async function fetchProviderModels(
  provider: string,
  credential?: ProviderCredential,
): Promise<DiscoveredModel[]> {
  if (!PROVIDER_DEFAULTS[provider]) {
    throw new Error(`Model discovery not supported for provider: ${provider}`);
  }

  const catalog = await tryGetCatalog();

  if (credential) {
    const direct = await fetchDirect(provider, credential, catalog);
    if (direct) return direct;
  }

  if (!catalog) {
    throw new Error(
      `Could not reach ${provider} directly and models.dev is unavailable`,
    );
  }
  return fetchFromCatalog(provider, catalog);
}
