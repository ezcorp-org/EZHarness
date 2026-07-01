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
  const piAi = (await import("@earendil-works/pi-ai")) as {
    complete: (...args: unknown[]) => Promise<unknown>;
  };
  const piOpts: Record<string, unknown> = { apiKey: opts.apiKey };
  if (opts.maxTokens !== undefined) piOpts.maxTokens = opts.maxTokens;
  if (opts.temperature !== undefined) piOpts.temperature = opts.temperature;
  if (opts.timeoutMs !== undefined && typeof AbortSignal?.timeout === "function") {
    piOpts.signal = AbortSignal.timeout(opts.timeoutMs);
  }
  const result = await piAi.complete(piModel, body, piOpts);
  return result as PiCompleteResult;
};
