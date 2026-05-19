// ── invoke-helpers — typed cross-extension invoke wrappers ──────
//
// The pipeline delegates two NON-`requiresUserInput` tools over the
// `ezcorp/invoke` reverse RPC (host routes via `resolveDepTool`,
// splitting the tool name on the first `__`). The human turn is NOT
// here: `ask_user_question` is `requiresUserInput:true`, and the host's
// cross-ext invoke path does not thread `invocationMetadata.toolCallId`
// /`conversationId` into the target subprocess (see README "Host
// limitation") — so the LLM calls `ask_user_question` itself via the
// platform's wired path. These two wrappers go through a single
// swappable `_invoke` seam so `lib/pipeline.ts` is unit-testable with
// zero network / LLM / subprocess.
//
// Timeout notes (the SDK `invoke()` applies a CHANNEL-level request
// timeout independent of the target subprocess's own limits):
//  - image gen: 600_000 — generation routinely takes 30–120s, far past
//    the 30s default (matches openai-image-gen-2's own callTimeoutMs).
//  - summarize: 120_000 — fetch + per-URL LLM call.

import { invoke as sdkInvoke } from "@ezcorp/sdk/runtime";

export type InvokeFn = <T = unknown>(
  tool: string,
  args: Record<string, unknown>,
  opts?: { timeoutMs?: number },
) => Promise<T>;

let _invoke: InvokeFn = sdkInvoke as InvokeFn;

/** Test-only: inject a fake cross-ext invoke. Pass null to restore the
 *  real SDK binding. */
export function _setInvokeForTests(fake: InvokeFn | null): void {
  _invoke = fake ?? (sdkInvoke as InvokeFn);
}

interface ToolCallResultLike {
  content?: Array<{ type?: string; text?: string }>;
  isError?: boolean;
}

/** Pull the first text block out of a ToolCallResult-shaped value.
 *  Defensive: cross-ext invoke passes through whatever the target
 *  resolves, so a non-conforming shape yields "" rather than throwing. */
export function extractText(result: unknown): string {
  const r = result as ToolCallResultLike | undefined;
  return r?.content?.[0]?.text ?? "";
}

function isErrorResult(result: unknown): boolean {
  return (result as ToolCallResultLike | undefined)?.isError === true;
}

export interface SummaryResult {
  title: string;
  summary: string;
  error?: string;
}

/** Stage 1 — reuse substack-pilot's fetch + LLM summarize. Returns the
 *  single URL's summary or a structured error (never throws). */
export async function summarizeUrl(url: string): Promise<SummaryResult> {
  let raw: unknown;
  try {
    raw = await _invoke(
      "substack-pilot__summarize_urls",
      { urls: [url] },
      { timeoutMs: 120_000 },
    );
  } catch (err) {
    return { title: "", summary: "", error: `summarize invoke failed: ${(err as Error).message}` };
  }
  if (isErrorResult(raw)) {
    return { title: "", summary: "", error: extractText(raw) || "summarize returned an error" };
  }
  const text = extractText(raw);
  let parsed: { summaries?: Array<{ title?: string; summary?: string; error?: string }> };
  try {
    parsed = JSON.parse(text);
  } catch {
    return { title: "", summary: "", error: `summarize returned non-JSON: ${text.slice(0, 200)}` };
  }
  const first = parsed.summaries?.[0];
  if (!first || first.error || !first.summary) {
    return {
      title: first?.title ?? "",
      summary: "",
      error: first?.error ?? "no usable summary produced",
    };
  }
  return { title: first.title ?? "", summary: first.summary };
}

export interface ImageResult {
  /** Markdown emitted by openai-image-gen-2 — contains the
   *  `![](/api/ext-files/openai-image-gen-2/…)` reference that renders
   *  inline in the assistant message. Empty on failure. */
  markdown: string;
  error?: string;
}

/** Final stage — generate one wide cover image. Never throws; surfaces a
 *  structured error so the pipeline can still ship the article. */
export async function generateCoverImage(prompt: string): Promise<ImageResult> {
  let raw: unknown;
  try {
    raw = await _invoke(
      "openai-image-gen-2__generate",
      { prompt, size: "1536x1024", n: 1 },
      { timeoutMs: 600_000 },
    );
  } catch (err) {
    return { markdown: "", error: `image invoke failed: ${(err as Error).message}` };
  }
  const text = extractText(raw);
  if (isErrorResult(raw)) {
    return { markdown: "", error: text || "image generation returned an error" };
  }
  return { markdown: text };
}
