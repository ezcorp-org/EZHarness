/**
 * Prompt-enhancement via a local OpenAI-compatible model (Ollama sidecar,
 * llama.cpp server, or any /v1 endpoint).
 *
 * Design constraints (see docs/features/composer/suggestions.md):
 *  - Strictly best-effort: every failure path returns null — the composer
 *    hides the enhancement row and tool suggestions keep working.
 *  - The availability probe is TTL-cached so a down sidecar costs one
 *    cheap fetch per minute, not one per keystroke pause.
 *  - Drafts are processed transiently — nothing typed here is persisted.
 *  - Thinking is suppressed (`/no_think` soft switch + defensive
 *    `<think>` stripping) — reasoning tokens would blow the latency
 *    budget on CPU (research: Qwen3-4B thinking-on ≈60s CPU).
 */

export interface EnhanceContext {
  modeName?: string | null;
  modeDescription?: string | null;
  tools: Array<{ name: string; description: string }>;
}

export interface EnhanceResult {
  enhanced: string;
  reason: string;
}

export interface EnhanceConfig {
  baseUrl: string;
  model: string;
  timeoutMs: number;
}

export interface EnhanceDeps {
  fetchFn?: typeof fetch;
  nowFn?: () => number;
}

export const ENHANCE_PROBE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 1_500;
const MAX_ENHANCED_LENGTH = 4_000;

/** Strip trailing slashes/colons — same normalization as local-model-check. */
function normalizeUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/[/:]+$/, "");
}

let probeState: { at: number; ok: boolean } | null = null;

/** Reset the cached probe — for tests. */
export function resetEnhanceProbe(): void {
  probeState = null;
}

/**
 * Is the local model endpoint reachable? Both success and failure are
 * cached for ENHANCE_PROBE_TTL_MS.
 */
export async function isEnhanceAvailable(baseUrl: string, deps?: EnhanceDeps): Promise<boolean> {
  const now = (deps?.nowFn ?? Date.now)();
  if (probeState && now - probeState.at < ENHANCE_PROBE_TTL_MS) return probeState.ok;
  const fetchFn = deps?.fetchFn ?? fetch;
  let ok = false;
  try {
    const res = await fetchFn(`${normalizeUrl(baseUrl)}/v1/models`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  probeState = { at: now, ok };
  return ok;
}

const SYSTEM_PROMPT = [
  "You improve a user's draft chat prompt. Keep the user's intent, language, and tone.",
  "Make the prompt specific and actionable. If tools are listed, phrase the prompt so the",
  "assistant can use the most relevant tool — but never invent capabilities that are not listed.",
  "If the draft is already clear, return it unchanged and say so in `reason`.",
  'Respond with ONLY a JSON object of the shape {"enhanced": string, "reason": string}',
  "— no markdown, no prose around it. Keep `reason` under 20 words. /no_think",
].join(" ");

function buildUserMessage(draft: string, ctx: EnhanceContext): string {
  const parts: string[] = [];
  if (ctx.modeName) {
    parts.push(`Active mode: ${ctx.modeName}${ctx.modeDescription ? ` — ${ctx.modeDescription}` : ""}`);
  }
  if (ctx.tools.length > 0) {
    parts.push(`Available tools:\n${ctx.tools.map((t) => `- ${t.name}: ${t.description}`).join("\n")}`);
  }
  parts.push(`Draft prompt:\n"""\n${draft}\n"""`);
  return parts.join("\n\n");
}

/**
 * Extract `{enhanced, reason}` from a model response, tolerating thinking
 * blocks and stray prose around the JSON object. Returns null on any shape
 * violation — callers treat that as "no suggestion".
 */
export function parseEnhanceResponse(content: string): EnhanceResult | null {
  const withoutThinking = content.replace(/<think>[\s\S]*?<\/think>/g, "");
  const start = withoutThinking.indexOf("{");
  const end = withoutThinking.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(withoutThinking.slice(start, end + 1)) as Record<string, unknown>;
    const enhanced = typeof parsed.enhanced === "string" ? parsed.enhanced.trim() : "";
    const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
    if (!enhanced || enhanced.length > MAX_ENHANCED_LENGTH) return null;
    return { enhanced, reason };
  } catch {
    return null;
  }
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
}

async function requestCompletion(
  draft: string,
  ctx: EnhanceContext,
  cfg: EnhanceConfig,
  fetchFn: typeof fetch,
  withSchema: boolean,
): Promise<Response> {
  const body: Record<string, unknown> = {
    model: cfg.model,
    stream: false,
    temperature: 0.3,
    max_tokens: 400,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(draft, ctx) },
    ],
  };
  if (withSchema) {
    // Grammar-constrained decoding (Ollama ≥0.5 / llama.cpp translate this
    // to GBNF). The schema is ALSO described in the system prompt — the
    // model can't see response_format, and some /v1 servers reject it
    // (handled by the no-schema retry in enhancePrompt).
    body.response_format = {
      type: "json_schema",
      json_schema: {
        name: "prompt_enhancement",
        strict: true,
        schema: {
          type: "object",
          properties: { enhanced: { type: "string" }, reason: { type: "string" } },
          required: ["enhanced", "reason"],
          additionalProperties: false,
        },
      },
    };
  }
  return fetchFn(`${normalizeUrl(cfg.baseUrl)}/v1/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(cfg.timeoutMs),
  });
}

/**
 * Generate a prompt-enhancement suggestion. Returns null when the endpoint
 * errors, times out, or produces an unusable shape.
 */
export async function enhancePrompt(
  draft: string,
  ctx: EnhanceContext,
  cfg: EnhanceConfig,
  deps?: EnhanceDeps,
): Promise<EnhanceResult | null> {
  const fetchFn = deps?.fetchFn ?? fetch;
  try {
    let res = await requestCompletion(draft, ctx, cfg, fetchFn, true);
    if (!res.ok) {
      res = await requestCompletion(draft, ctx, cfg, fetchFn, false);
      if (!res.ok) return null;
    }
    const payload = (await res.json()) as ChatCompletionResponse;
    const content = payload.choices?.[0]?.message?.content;
    if (typeof content !== "string") return null;
    return parseEnhanceResponse(content);
  } catch {
    return null;
  }
}
