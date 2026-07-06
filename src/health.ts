import { getPglite } from "./db/connection";
import { isEmbeddingReady } from "./memory/embeddings";
import { checkEndpointReachability } from "./providers/local-model-check";

export interface HealthResponse {
  status: "healthy" | "degraded";
  db?: { status: "up" | "down" };
  embeddings?: { status: "ready" | "not_initialized" };
  providers?: Record<string, { status: "configured" | "not_configured" }>;
  localModels?: Record<string, { status: "reachable" | "unreachable"; latencyMs?: number }>;
}

export async function buildHealthResponse(detail: boolean): Promise<HealthResponse> {
  // Check DB
  let dbUp = false;
  try {
    const pg = getPglite();
    if (pg) {
      await pg.query("SELECT 1");
      dbUp = true;
    }
  } catch {
    // DB is down
  }

  const overall: "healthy" | "degraded" = dbUp ? "healthy" : "degraded";

  if (!detail) {
    return { status: overall };
  }

  // Embedding status (don't trigger download)
  const embeddingStatus = isEmbeddingReady() ? "ready" : "not_initialized";

  // Provider status from settings
  const providers: Record<string, { status: "configured" | "not_configured" }> = {};
  let settings: Record<string, unknown> = {};
  try {
    const { getAllSettings } = await import("./db/queries/settings");
    settings = await getAllSettings();
    const providerNames = ["anthropic", "openai", "google", "openrouter"];
    for (const name of providerNames) {
      const apiKey = settings[`provider:apiKey:${name}`];
      const oauthToken = settings[`provider:oauth:${name}`];
      providers[name] = {
        status: apiKey || oauthToken ? "configured" : "not_configured",
      };
    }
  } catch {
    // Settings unavailable
  }

  // Local model reachability
  let localModels: Record<string, { status: "reachable" | "unreachable"; latencyMs?: number }> | undefined;
  try {
    const customModels = settings[`provider:customModels`] as Array<{ modelId: string; provider: string; tier: string; baseUrl?: string }> | undefined;
    const localEntries = (customModels ?? []).filter((m) => m.baseUrl);
    if (localEntries.length > 0) {
      const results = await Promise.allSettled(
        localEntries.map((m) => checkEndpointReachability(m.baseUrl!)),
      );
      localModels = {};
      for (let i = 0; i < localEntries.length; i++) {
        const r = results[i]!;
        if (r.status === "fulfilled" && r.value.reachable) {
          localModels[localEntries[i]!.modelId] = { status: "reachable" };
        } else {
          localModels[localEntries[i]!.modelId] = { status: "unreachable" };
        }
      }
    }
  } catch {
    // Local model checks unavailable
  }

  return {
    status: overall,
    db: { status: dbUp ? "up" : "down" },
    embeddings: { status: embeddingStatus },
    providers,
    ...(localModels ? { localModels } : {}),
  };
}
