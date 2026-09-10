/**
 * Shared pi-ai `complete()` wrapper.
 *
 * Both {@link import("../extensions/llm-handler")}'s extension LLM bridge and
 * {@link import("../runtime/goal-host")}'s goal evaluator need to call
 * `@earendil-works/pi-ai`'s `complete(piModel, body, opts)` with identical
 * option-threading (apiKey, optional maxTokens / temperature, and a
 * timeout-derived AbortSignal). The dynamic `import()` keeps this module safe
 * to import everywhere — an environment without API keys never trips on
 * module load.
 */

/** Request body handed to pi-ai's `complete`. */
export interface PiCompleteBody {
  systemPrompt?: string;
  messages: Array<{
    role: "system" | "user" | "assistant";
    content: string;
    timestamp: number;
  }>;
}

/** Per-call options. `timeoutMs`, when set and supported, becomes an
 *  `AbortSignal.timeout(...)` that pi-ai respects. */
export interface PiCompleteOpts {
  apiKey: string;
  maxTokens?: number;
  temperature?: number;
  timeoutMs?: number;
}

/** Normalized pi-ai completion result. */
export interface PiCompleteResult {
  content: Array<{ type: string; text?: string }>;
  usage?: { input?: number; output?: number; cost?: number };
  stopReason?: string;
  model?: string;
}

/** The wrapper signature — used as the host-injectable swap-in type for
 *  tests in both call sites. */
export type PiCompleteFn = (
  piModel: unknown,
  body: PiCompleteBody,
  opts: PiCompleteOpts,
) => Promise<PiCompleteResult>;

/** Default implementation: dynamic-import pi-ai and forward the call. */
export const piComplete: PiCompleteFn = async (piModel, body, opts) => {
  const piAi = (await import("@earendil-works/pi-ai/compat")) as {
    complete: (...args: unknown[]) => Promise<unknown>;
  };
  const piOpts: Record<string, unknown> = { apiKey: opts.apiKey };
  if (opts.maxTokens !== undefined) piOpts.maxTokens = opts.maxTokens;
  if (opts.temperature !== undefined) piOpts.temperature = opts.temperature;
  if (opts.timeoutMs !== undefined && typeof AbortSignal?.timeout === "function") {
    piOpts.signal = AbortSignal.timeout(opts.timeoutMs);
  }
  // pi-ai accepts string content for system/user input, but assistant
  // history is an AgentMessage and therefore must contain content blocks.
  // Database-backed callers store assistant text as a string, so normalize at
  // the shared boundary before pi-ai builds its request. Without this, pi-ai
  // returns a local stopReason:error before it reaches the configured provider.
  const messages = body.messages.map((message) =>
    message.role === "assistant" && typeof message.content === "string"
      ? { ...message, content: [{ type: "text", text: message.content }] }
      : message,
  );
  const result = await piAi.complete(piModel, { ...body, messages }, piOpts);
  return result as PiCompleteResult;
};
