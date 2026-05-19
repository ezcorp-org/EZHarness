/**
 * Local model capability checks.
 *
 * Pure functions using raw fetch() — no pi-ai, no DB dependencies.
 * Validates connectivity, model availability, and inference for
 * local model endpoints (Ollama, llama.cpp, any OpenAI-compatible server).
 */

export type EndpointType = "openai-compatible" | "ollama";

export interface LocalModelCheckResult {
  reachable: boolean;
  modelAvailable: boolean | null;
  inferenceOk: boolean | null;
  endpointType: EndpointType | null;
  error?: string;
  latencyMs?: number;
}

export interface ModelListEntry {
  id: string;
  name?: string;
}

/** Normalize base URL: strip trailing slashes, colons, and whitespace. */
function normalizeUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/[/:]+$/, "");
}

/**
 * Detect whether the endpoint speaks OpenAI-compatible or Ollama API.
 * Tries /v1/models first (covers both OpenAI-compat and Ollama's compat layer),
 * then falls back to /api/tags (native Ollama).
 */
export async function detectEndpointType(baseUrl: string): Promise<EndpointType | null> {
  const url = normalizeUrl(baseUrl);

  try {
    const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) return "openai-compatible";
  } catch {
    // fall through
  }

  try {
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (res.ok) return "ollama";
  } catch {
    // fall through
  }

  return null;
}

/**
 * Check if the local model endpoint is reachable.
 */
export async function checkEndpointReachability(
  baseUrl: string,
): Promise<{ reachable: boolean; endpointType: EndpointType | null; error?: string }> {
  try {
    const endpointType = await detectEndpointType(baseUrl);
    if (endpointType) {
      return { reachable: true, endpointType };
    }
    return { reachable: false, endpointType: null, error: "Endpoint did not respond on /v1/models or /api/tags" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { reachable: false, endpointType: null, error: message };
  }
}

/**
 * Check if a specific model is available on the endpoint.
 */
export async function checkModelAvailability(
  baseUrl: string,
  modelId: string,
  endpointType: EndpointType,
): Promise<{ available: boolean; models?: ModelListEntry[]; error?: string }> {
  const url = normalizeUrl(baseUrl);

  try {
    if (endpointType === "openai-compatible") {
      const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return { available: false, error: `GET /v1/models returned ${res.status}` };

      const body = await res.json() as { data?: Array<{ id: string }> };
      const models: ModelListEntry[] = (body.data ?? []).map((m) => ({ id: m.id }));
      const found = models.some((m) => m.id === modelId);
      return { available: found, models };
    }

    // Ollama native API
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { available: false, error: `GET /api/tags returned ${res.status}` };

    const body = await res.json() as { models?: Array<{ name: string }> };
    const models: ModelListEntry[] = (body.models ?? []).map((m) => ({
      id: m.name,
      name: m.name,
    }));
    // Match exact or with/without :latest suffix
    const found = models.some(
      (m) => m.id === modelId || m.id === `${modelId}:latest` || m.id.replace(/:latest$/, "") === modelId,
    );
    return { available: found, models };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { available: false, error: message };
  }
}

/**
 * Run a minimal inference test against the endpoint.
 */
export async function testInference(
  baseUrl: string,
  modelId: string,
  endpointType: EndpointType,
): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  const url = normalizeUrl(baseUrl);
  const start = performance.now();

  try {
    // Both OpenAI-compatible and Ollama support the /v1/chat/completions endpoint
    const endpoint = endpointType === "ollama"
      ? `${url}/v1/chat/completions`
      : `${url}/v1/chat/completions`;

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: modelId,
        messages: [{ role: "user", content: "Say ok" }],
        max_tokens: 1,
        stream: false,
      }),
      signal: AbortSignal.timeout(15_000),
    });

    const latencyMs = Math.round(performance.now() - start);

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return { success: false, latencyMs, error: `Inference returned ${res.status}: ${text}`.trim() };
    }

    // Validate we got a parseable response
    await res.json();
    return { success: true, latencyMs };
  } catch (err) {
    const latencyMs = Math.round(performance.now() - start);
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, latencyMs, error: message };
  }
}

/**
 * List all available models on a local endpoint (without checking a specific model).
 */
export async function listModels(
  baseUrl: string,
): Promise<{ models: ModelListEntry[]; endpointType: EndpointType | null; error?: string }> {
  const endpointType = await detectEndpointType(baseUrl);
  if (!endpointType) {
    return { models: [], endpointType: null, error: "Endpoint not reachable" };
  }

  const url = normalizeUrl(baseUrl);
  try {
    if (endpointType === "openai-compatible") {
      const res = await fetch(`${url}/v1/models`, { signal: AbortSignal.timeout(5_000) });
      if (!res.ok) return { models: [], endpointType, error: `GET /v1/models returned ${res.status}` };
      const body = await res.json() as { data?: Array<{ id: string }> };
      return { models: (body.data ?? []).map((m) => ({ id: m.id })), endpointType };
    }

    // Ollama native
    const res = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5_000) });
    if (!res.ok) return { models: [], endpointType, error: `GET /api/tags returned ${res.status}` };
    const body = await res.json() as { models?: Array<{ name: string }> };
    return {
      models: (body.models ?? []).map((m) => ({ id: m.name, name: m.name })),
      endpointType,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { models: [], endpointType, error: message };
  }
}

/**
 * Orchestrate all three checks: reachability → availability → inference.
 * Short-circuits on failure.
 */
export async function checkLocalModel(
  baseUrl: string,
  modelId: string,
): Promise<LocalModelCheckResult> {
  const start = performance.now();

  const reachability = await checkEndpointReachability(baseUrl);
  if (!reachability.reachable) {
    return {
      reachable: false,
      modelAvailable: null,
      inferenceOk: null,
      endpointType: null,
      error: reachability.error,
      latencyMs: Math.round(performance.now() - start),
    };
  }

  const availability = await checkModelAvailability(baseUrl, modelId, reachability.endpointType!);
  if (!availability.available) {
    return {
      reachable: true,
      modelAvailable: false,
      inferenceOk: null,
      endpointType: reachability.endpointType,
      error: availability.error ?? `Model "${modelId}" not found on endpoint`,
      latencyMs: Math.round(performance.now() - start),
    };
  }

  const inference = await testInference(baseUrl, modelId, reachability.endpointType!);
  return {
    reachable: true,
    modelAvailable: true,
    inferenceOk: inference.success,
    endpointType: reachability.endpointType,
    error: inference.error,
    latencyMs: Math.round(performance.now() - start),
  };
}
