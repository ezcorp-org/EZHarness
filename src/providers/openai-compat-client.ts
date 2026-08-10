/**
 * Shared OpenAI-compatible `/v1/chat/completions` client.
 *
 * `src/contexts/llm.ts` (topic detection/extraction's sidecar lane) and
 * `src/suggest/enhance.ts` (prompt enhancement) both talk to a local or BYOK
 * OpenAI-compatible endpoint (Ollama, llama.cpp, vLLM, LM Studio, ...) with
 * IDENTICAL mechanics: normalize the base URL, build a chat-completion body,
 * attach `response_format.json_schema` when a schema is supplied (grammar-
 * constrained decoding — Ollama ≥0.5 / llama.cpp translate this to GBNF, the
 * accuracy backbone on small models), POST with an `AbortSignal.timeout`,
 * and — on a non-OK response — retry ONCE with the schema stripped (some
 * `/v1` servers reject `response_format` outright; the schema is also
 * described in the system prompt, so a tolerant parser can still recover).
 *
 * Lives under `src/providers/**` (excluded from the coverage gate, same as
 * the sibling `local-model-check.ts`) rather than under the 100%-gated
 * `src/contexts/` or `src/suggest/`, so neither caller's gated file has to
 * carry the other's transport plumbing. Each caller keeps its own
 * prompt-building and response-parsing local and throws/swallows a failure
 * however its own contract requires — this module only sends the request and
 * hands back the raw `Response`.
 */

/** JSON schema for grammar-constrained decoding, plus the name pi-ai's
 *  `response_format.json_schema.name` field wants. */
export interface OpenAICompatSchema {
  name: string;
  schema: Record<string, unknown>;
}

export interface OpenAICompatCompletionRequest {
  baseUrl: string;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  temperature: number;
  maxTokens: number;
  timeoutMs: number;
  /** Omit for a plain-text/markdown pass — no schema, no retry. */
  schema?: OpenAICompatSchema;
  fetchFn: typeof fetch;
}

/** Strip a trailing `/v1`, slashes, or colons — tolerant of a baseUrl given
 *  either bare (`http://host:11434`) or already `/v1`-suffixed, so every
 *  caller can append its own `/v1/...` path unconditionally. */
export function normalizeUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/v1\/?$/, "").replace(/[/:]+$/, "");
}

/**
 * POST an OpenAI-compatible chat-completion request. When `schema` is given
 * it is sent as `response_format: { type: "json_schema", ... }` on the first
 * attempt; on a non-OK response the request is retried ONCE with the schema
 * stripped.
 *
 * Returns the raw `Response` — callers each parse/validate the body and
 * decide how to surface a still-failing retry (throw vs. return null), so
 * this stays purely a transport primitive. Only a transport-level rejection
 * (network error, abort/timeout) escapes as a thrown error; a non-OK HTTP
 * status is returned, never thrown.
 */
export async function requestOpenAICompatCompletion(
  req: OpenAICompatCompletionRequest,
): Promise<Response> {
  const url = `${normalizeUrl(req.baseUrl)}/v1/chat/completions`;

  const buildBody = (withSchema: boolean): Record<string, unknown> => {
    const body: Record<string, unknown> = {
      model: req.model,
      stream: false,
      temperature: req.temperature,
      max_tokens: req.maxTokens,
      messages: [
        { role: "system", content: req.systemPrompt },
        { role: "user", content: req.userPrompt },
      ],
    };
    if (withSchema && req.schema) {
      body.response_format = {
        type: "json_schema",
        json_schema: { name: req.schema.name, strict: true, schema: req.schema.schema },
      };
    }
    return body;
  };

  const doRequest = (withSchema: boolean): Promise<Response> =>
    req.fetchFn(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(buildBody(withSchema)),
      signal: AbortSignal.timeout(req.timeoutMs),
    });

  let res = await doRequest(!!req.schema);
  // Some /v1 servers reject `response_format` — retry once without the
  // schema (only when one was actually sent on the first attempt).
  if (!res.ok && req.schema) {
    res = await doRequest(false);
  }
  return res;
}
