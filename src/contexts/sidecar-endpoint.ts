/**
 * Endpoint-aware wire shapes for the Topic Contexts SIDECAR lane.
 *
 * The compose `OLLAMA_CONTEXT_LENGTH` env fix (see docker-compose.yml) only
 * reaches the BUNDLED ollama container — it cannot configure a HOST ollama
 * daemon the app talks to over host-network (the common real-world runtime).
 * The OpenAI-compat `/v1/chat/completions` surface has no per-request context
 * control, so on such a daemon our long transcripts silently truncate at the
 * server default (4096). The fix must therefore live in CODE: when the endpoint
 * is Ollama, call the NATIVE `/api/chat` with `options.num_ctx` so every request
 * gets an adequate window regardless of how the daemon was launched. Generic
 * OpenAI-compatible servers (llama.cpp, etc.) keep the `/v1` path unchanged.
 *
 * Detection note: `local-model-check`'s `detectEndpointType` probes `/v1/models`
 * FIRST, which Ollama's compat layer ALSO serves — so it reports Ollama as
 * "openai-compatible" and can't drive this routing. We instead probe the
 * Ollama-native `/api/tags` (which generic `/v1` servers do NOT serve); an OK
 * response means "ollama". Cached per-baseUrl with a TTL; any failure falls back
 * to "openai-compatible" (the safe current path).
 *
 * The probe (`model-support.ts`) runs its tiny load-check through the SAME wire
 * shape, so the RAM it measures (KV cache sized by `num_ctx`) matches what real
 * calls will allocate.
 */

import { logger } from "../logger";

const log = logger.child("contexts.sidecar-endpoint");

export type SidecarEndpointKind = "ollama" | "openai-compatible";

/** Default Ollama context window when the env override is unset/invalid. */
export const DEFAULT_CONTEXTS_NUM_CTX = 16_384;

/** Parse the `EZCORP_OLLAMA_CONTEXT_LENGTH` override (same var the compose
 *  service uses); a missing / non-positive / non-numeric value → the default. */
export function resolveNumCtx(env: Record<string, string | undefined> = process.env): number {
  const raw = env.EZCORP_OLLAMA_CONTEXT_LENGTH;
  const n = raw ? Math.floor(Number(raw)) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CONTEXTS_NUM_CTX;
}

/** Context window for the Ollama native lane (`options.num_ctx`). Mirrors the
 *  compose `OLLAMA_CONTEXT_LENGTH` so a host-network / BYO Ollama daemon gets
 *  the same window the compose env can't configure. */
export const CONTEXTS_NUM_CTX = resolveNumCtx();

/** Strip a trailing `/v1`, slashes, or colons so a bare or `/v1`-suffixed
 *  baseUrl both resolve to the daemon root. */
export function normalizeSidecarUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/v1\/?$/, "").replace(/[/:]+$/, "");
}

export interface SidecarEndpointDeps {
  fetchFn?: typeof fetch;
  nowFn?: () => number;
}

const ENDPOINT_PROBE_TIMEOUT_MS = 2_000;
export const SIDECAR_ENDPOINT_TTL_MS = 5 * 60_000;

const endpointCache = new Map<string, { kind: SidecarEndpointKind; at: number }>();

/**
 * Detect whether `baseUrl` is an Ollama daemon (native lane) or a generic
 * OpenAI-compatible server. Cached per-baseUrl for {@link SIDECAR_ENDPOINT_TTL_MS};
 * any error → "openai-compatible" (keep the safe path).
 */
export async function detectSidecarEndpoint(
  baseUrl: string,
  deps: SidecarEndpointDeps = {},
): Promise<SidecarEndpointKind> {
  const now = (deps.nowFn ?? Date.now)();
  const key = normalizeSidecarUrl(baseUrl);
  const hit = endpointCache.get(key);
  if (hit && now - hit.at < SIDECAR_ENDPOINT_TTL_MS) return hit.kind;

  const fetchFn = deps.fetchFn ?? fetch;
  let kind: SidecarEndpointKind = "openai-compatible";
  try {
    const res = await fetchFn(`${key}/api/tags`, { signal: AbortSignal.timeout(ENDPOINT_PROBE_TIMEOUT_MS) });
    if (res.ok) kind = "ollama";
  } catch {
    kind = "openai-compatible";
  }
  endpointCache.set(key, { kind, at: now });
  log.debug("resolved sidecar endpoint kind", { baseUrl: key, kind });
  return kind;
}

/** Test-only: clear the endpoint-kind cache between cases. */
export function _resetSidecarEndpointCacheForTests(): void {
  endpointCache.clear();
}

export interface SidecarChatParams {
  baseUrl: string;
  model: string;
  system: string;
  user: string;
  /** JSON schema for grammar-constrained decoding (detection). */
  schema?: Record<string, unknown>;
  schemaName?: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
}

/**
 * Build the URL + body for one chat request in the endpoint's native shape.
 * Pure (no fetch) so the wire shape is asserted directly in tests.
 *   - ollama → `/api/chat` with `options.num_ctx` (+ `format: schema` for
 *     grammar-constrained detection, `num_predict` as the output cap);
 *   - openai-compatible → `/v1/chat/completions` with `response_format`.
 */
export function buildSidecarRequest(
  kind: SidecarEndpointKind,
  p: SidecarChatParams,
  withSchema: boolean,
): { url: string; body: Record<string, unknown> } {
  const base = normalizeSidecarUrl(p.baseUrl);
  const messages = [
    { role: "system", content: p.system },
    { role: "user", content: p.user },
  ];

  if (kind === "ollama") {
    const body: Record<string, unknown> = {
      model: p.model,
      stream: false,
      messages,
      options: { num_ctx: CONTEXTS_NUM_CTX, temperature: p.temperature, num_predict: p.maxTokens },
    };
    if (withSchema && p.schema) body.format = p.schema;
    return { url: `${base}/api/chat`, body };
  }

  const body: Record<string, unknown> = {
    model: p.model,
    stream: false,
    temperature: p.temperature,
    max_tokens: p.maxTokens,
    messages,
  };
  if (withSchema && p.schema) {
    body.response_format = {
      type: "json_schema",
      json_schema: { name: p.schemaName ?? "contexts_output", strict: true, schema: p.schema },
    };
  }
  return { url: `${base}/v1/chat/completions`, body };
}

/** Send one chat request in the endpoint's native shape. */
export function sendSidecarChat(
  kind: SidecarEndpointKind,
  p: SidecarChatParams,
  withSchema: boolean,
  fetchFn: typeof fetch,
): Promise<Response> {
  const { url, body } = buildSidecarRequest(kind, p, withSchema);
  return fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(p.timeoutMs),
  });
}

interface OllamaChatResponse {
  message?: { content?: unknown };
}
interface OpenAIChatResponse {
  choices?: Array<{ message?: { content?: unknown } }>;
}

/** Extract the assistant text from either response shape (Ollama native
 *  `message.content` vs OpenAI-compat `choices[0].message.content`). */
export function readSidecarContent(kind: SidecarEndpointKind, payload: unknown): string | undefined {
  if (kind === "ollama") {
    const c = (payload as OllamaChatResponse)?.message?.content;
    return typeof c === "string" ? c : undefined;
  }
  const c = (payload as OpenAIChatResponse)?.choices?.[0]?.message?.content;
  return typeof c === "string" ? c : undefined;
}
