/**
 * Phase 48 Wave 2 — summarize_conversation Ez tool.
 *
 * Reads a conversation's full message history from the DB and runs a
 * single-shot summarization pass via the model resolver. The `style`
 * parameter ("brief" | "standup" | "tweet") tunes the system prompt.
 *
 * Cross-user safety: the tool only loads messages — the conversation
 * lookup is by id and we cannot enforce "must be owned by ctx.userId"
 * from inside the tool without a query change. The runtime calls this
 * tool only inside Ez-mode conversations (allowlist gate), and Ez
 * conversations are user-owned, so the LLM only ever sees a
 * conversationId pulled from page context where the user is already
 * authenticated. A future hardening pass can add an ownership check
 * inside the tool body if `getConversation()` becomes routinely callable
 * from broader contexts.
 *
 * Determinism for tests: the LLM call is injected via `summarize` in
 * the context object so unit tests can stub it without spinning up a
 * model. Production wiring uses `defaultSummarize` which routes through
 * `resolveModel` + `completeLLM`.
 */
import { Type } from "@mariozechner/pi-ai";
import type { BuiltinToolDef } from "../types";
import { getConversation, getMessages } from "../../../db/queries/conversations";

export type SummaryStyle = "brief" | "standup" | "tweet";

const STYLE_PROMPTS: Record<SummaryStyle, string> = {
  brief: "Summarize the following conversation in 2-3 sentences. Capture the core outcome, not the back-and-forth.",
  standup: "Summarize the following conversation as a daily-standup update: what was discussed, what was decided, what's next. 3-5 bullet points.",
  tweet: "Summarize the following conversation as a single tweet under 280 characters. Capture the gist, no fluff.",
};

export interface SummarizeContext {
  /** Pluggable summarizer — replaced in tests with a deterministic stub.
   *  Receives the system prompt + the joined conversation transcript
   *  and returns the summary text. */
  summarize?: (systemPrompt: string, transcript: string) => Promise<string>;
  /** Phase 48 fix: provider/model the user picked for THIS Ez turn.
   *  Threaded through from `streamChat` options so the summarizer uses
   *  the same model as the surrounding conversation. When absent (or
   *  when resolution against the picked pair fails), the default
   *  summarizer falls back to `resolveModel(undefined)` — preserving
   *  the legacy default-tier behavior. */
  provider?: string | null;
  model?: string | null;
}

/** Default summarizer: routes the request through the project's
 *  resolveModel + completeLLM. Prefers the per-turn provider/model
 *  picked by the user (passed via SummarizeContext) so the summarizer
 *  uses the SAME model as the surrounding Ez conversation. Falls back
 *  to default-tier resolution if the picked pair fails to resolve.
 *  Errors propagate as tool errors. */
async function defaultSummarize(
  systemPrompt: string,
  transcript: string,
  provider?: string | null,
  model?: string | null,
): Promise<string> {
  const { resolveModel } = await import("../../../providers/router");
  const { completeLLM } = await import("../../../providers/llm");
  let resolved: Awaited<ReturnType<typeof resolveModel>> | null = null;
  // Prefer the user-picked provider+model (matches the chat page's
  // resolveModel(options.provider, options.model) call). If both are
  // present we try them first; on any failure we fall through to the
  // legacy default-tier path so misconfigurations of the picked model
  // don't make summarize unusable.
  if (provider && model) {
    try {
      resolved = await resolveModel(provider, model);
    } catch {
      resolved = null;
    }
  }
  if (!resolved) {
    resolved = await resolveModel(undefined);
  }
  if (!resolved) {
    throw new Error("no model available — connect a provider in Settings");
  }
  const result = await completeLLM(resolved.piModel, {
    systemPrompt,
    messages: [{ role: "user", content: transcript }],
  } as any);
  // pi-ai AssistantMessage has a `content` array. Join text parts.
  const content = (result as any).content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter((p: any) => p?.type === "text" && typeof p.text === "string")
      .map((p: any) => p.text)
      .join("");
  }
  return String(content ?? "");
}

const MAX_TRANSCRIPT_CHARS = 60_000; // ~15k tokens. Truncates from the start (oldest) so the recent context survives.

export function createSummarizeConversationTool(ctx: SummarizeContext = {}): BuiltinToolDef {
  // Bind the per-turn provider/model into the default summarizer so the
  // tool's `summarize(system, transcript)` call site (below) doesn't need
  // to know about model resolution. Test-injected stubs ignore this
  // entirely — they receive `(systemPrompt, transcript)` and short-circuit
  // before defaultSummarize runs.
  const summarize = ctx.summarize ?? ((sys: string, t: string) => defaultSummarize(sys, t, ctx.provider, ctx.model));
  return {
    name: "summarize_conversation",
    label: "summarize_conversation",
    description:
      "Summarize a conversation's message history. Style: 'brief' (default, 2-3 sentences), 'standup' (bulleted update), or 'tweet' (under 280 chars).",
    category: "ez",
    cardType: "default",
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        conversationId: { type: "string", description: "The conversation to summarize. Usually filled from page context." },
        style: { type: "string", enum: ["brief", "standup", "tweet"], description: "Summary style." },
      },
      required: ["conversationId"],
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const conversationId = typeof params?.conversationId === "string" ? params.conversationId.trim() : "";
        if (!conversationId) {
          return { content: [{ type: "text" as const, text: "Error: conversationId is required" }], details: { isError: true } };
        }
        const style: SummaryStyle = params?.style && STYLE_PROMPTS[params.style as SummaryStyle] ? params.style : "brief";

        const conv = await getConversation(conversationId);
        if (!conv) {
          return {
            content: [{ type: "text" as const, text: `Error: conversation ${conversationId} not found` }],
            details: { isError: true },
          };
        }
        const messages = await getMessages(conversationId);
        if (messages.length === 0) {
          return {
            content: [{ type: "text" as const, text: "(empty conversation — nothing to summarize)" }],
            details: { messageCount: 0, style },
          };
        }

        // Build the transcript. Strip tool-call noise that doesn't help a
        // human-facing summary; keep role + content. Truncate from the
        // start (oldest) so recent context survives the cap.
        let transcript = messages
          .map((m) => `${m.role}: ${m.content}`.trim())
          .join("\n\n");
        if (transcript.length > MAX_TRANSCRIPT_CHARS) {
          transcript = `…[truncated]…\n${transcript.slice(transcript.length - MAX_TRANSCRIPT_CHARS)}`;
        }

        const summary = await summarize(STYLE_PROMPTS[style], transcript);
        return {
          content: [{ type: "text" as const, text: summary }],
          details: { conversationId, style, messageCount: messages.length },
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { isError: true } };
      }
    },
  };
}
