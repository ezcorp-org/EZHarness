/**
 * Dual-lane LLM runner for topic contexts.
 *
 *  - SIDECAR lane: a raw `fetch` to a local model endpoint, ENDPOINT-AWARE
 *    (see `sidecar-endpoint.ts`). An Ollama daemon is driven through its NATIVE
 *    `/api/chat` with `options.num_ctx` so long transcripts aren't truncated at
 *    the server's 4096 default — critical for host-network daemons the compose
 *    `OLLAMA_CONTEXT_LENGTH` env can't reach. Generic OpenAI-compatible servers
 *    (llama.cpp, …) keep the `/v1/chat/completions` path. A JSON schema is sent
 *    as grammar-constrained decoding either way (`format` on Ollama,
 *    `response_format` on `/v1`), with a no-schema retry for servers that reject
 *    it. pi-ai does NOT pass grammar through, which is why detection cannot use
 *    the pi lane for its constrained pass.
 *  - PI lane: `completeLLM` (credentials + OAuth model swap). pi-ai reports
 *    provider failures as RESULT FIELDS (`stopReason: "error"` +
 *    `errorMessage`), not throws — without that check a failed call has an
 *    empty content array and would look like a blank success (the exact bug
 *    `summarize_conversation`'s `defaultSummarize` guards against).
 *
 * The runner returns the raw model text; JSON parsing / `<think>` stripping
 * live in detect.ts / extract.ts. `fetchFn` / `completeFn` / `detectFn` are
 * injectable so every branch is unit-testable with no network.
 */

import type { ContextsTarget } from "./config";
import {
  type SidecarChatParams,
  type SidecarEndpointKind,
  detectSidecarEndpoint,
  readSidecarContent,
  sendSidecarChat,
} from "./sidecar-endpoint";

/** Default completion timeout — a slow local model on a long transcript can
 *  legitimately run well past a chat turn's watchdog. */
export const DEFAULT_CONTEXTS_TIMEOUT_MS = 120_000;

export interface ContextsCompletionRequest {
  target: ContextsTarget;
  systemPrompt: string;
  userPrompt: string;
  /** JSON schema for grammar-constrained decoding (detection). Omit for the
   *  plain-markdown extraction pass. Only the sidecar lane enforces it. */
  schema?: Record<string, unknown>;
  schemaName?: string;
  temperature?: number;
  maxTokens?: number;
  timeoutMs?: number;
  /** Threaded into completeLLM so credential resolution honors the
   *  conversation's access-mode override (pi lane only). */
  conversationId?: string;
}

export interface ContextsCompletionDeps {
  fetchFn?: typeof fetch;
  // Single line: a multi-line arrow-type signature makes Bun's coverage
  // instrumenter attribute the wrapping lines as uncovered "statements"
  // (they carry no runtime code), dropping this file below its 100% line
  // threshold on the merged host-pool run.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  completeFn?: (piModel: any, context: any, opts?: { conversationId?: string }) => Promise<any>;
  /** Resolve the sidecar endpoint kind (ollama vs openai-compatible). Injected
   *  so the wire shape is asserted without a network probe. */
  detectFn?: (baseUrl: string) => Promise<SidecarEndpointKind>;
}

async function runSidecar(
  target: Extract<ContextsTarget, { kind: "sidecar" }>,
  req: ContextsCompletionRequest,
  fetchFn: typeof fetch,
  detectFn: (baseUrl: string) => Promise<SidecarEndpointKind>,
): Promise<string> {
  const kind = await detectFn(target.baseUrl);
  const params: SidecarChatParams = {
    baseUrl: target.baseUrl,
    model: target.model,
    system: req.systemPrompt,
    user: req.userPrompt,
    schema: req.schema,
    schemaName: req.schemaName ?? "contexts_output",
    temperature: req.temperature ?? 0.2,
    maxTokens: req.maxTokens ?? 2_000,
    timeoutMs: req.timeoutMs ?? DEFAULT_CONTEXTS_TIMEOUT_MS,
  };

  let res = await sendSidecarChat(kind, params, !!req.schema, fetchFn);
  // Some servers reject the grammar constraint — retry once without the
  // schema (it is also described in the system prompt, and the parser
  // tolerates free-form JSON).
  if (!res.ok && req.schema) {
    res = await sendSidecarChat(kind, params, false, fetchFn);
  }
  if (!res.ok) {
    throw new Error(`contexts sidecar completion failed (HTTP ${res.status})`);
  }
  const content = readSidecarContent(kind, await res.json());
  if (typeof content !== "string" || !content.trim()) {
    throw new Error("contexts sidecar returned empty content");
  }
  return content;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractText(content: any): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p) => p?.type === "text" && typeof p.text === "string")
      .map((p) => p.text)
      .join("");
  }
  return String(content ?? "");
}

async function runPi(
  target: Extract<ContextsTarget, { kind: "pi" }>,
  req: ContextsCompletionRequest,
  completeFn: NonNullable<ContextsCompletionDeps["completeFn"]>,
): Promise<string> {
  const result = await completeFn(
    target.piModel,
    {
      systemPrompt: req.systemPrompt,
      messages: [{ role: "user", content: req.userPrompt }],
    },
    { conversationId: req.conversationId },
  );
  // pi-ai reports provider failures as result fields, not throws.
  if (result?.stopReason === "error") {
    throw new Error(result.errorMessage || "contexts model call failed with no error message");
  }
  const text = extractText(result?.content);
  if (!text.trim()) {
    throw new Error(`contexts model returned no text (stopReason: ${String(result?.stopReason ?? "unknown")})`);
  }
  return text;
}

/** Default pi-lane completer — routes through the project's credential-aware
 *  `completeLLM` (which applies the OAuth model swap). */
const defaultCompleteFn: NonNullable<ContextsCompletionDeps["completeFn"]> = async (
  piModel,
  context,
  opts,
) => {
  const { completeLLM } = await import("../providers/llm");
  return completeLLM(piModel, context, opts);
};

/**
 * Run a contexts completion on whichever lane the resolved target selects.
 * Returns the raw model text (caller parses). Throws on transport failure,
 * an empty response, or a pi-lane provider error surfaced as result fields.
 */
export async function runContextsCompletion(
  req: ContextsCompletionRequest,
  deps: ContextsCompletionDeps = {},
): Promise<string> {
  if (req.target.kind === "sidecar") {
    return runSidecar(req.target, req, deps.fetchFn ?? fetch, deps.detectFn ?? detectSidecarEndpoint);
  }
  return runPi(req.target, req, deps.completeFn ?? defaultCompleteFn);
}
