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
 * conversations are user-owned. A future hardening pass can add an
 * ownership check inside the tool body if `getConversation()` becomes
 * routinely callable from broader contexts.
 *
 * Determinism for tests: the LLM call is injected via `summarize` in
 * the context object so unit tests can stub it without spinning up a
 * model. Production wiring uses `defaultSummarize` which routes through
 * `resolveModel` + `completeLLM`.
 */
import { Type } from "@earendil-works/pi-ai";
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
  /** The Ez conversation this tool runs inside. Threaded into completeLLM
   *  so credential resolution honors the conversation's access-mode
   *  override — the same scoping the surrounding chat turn uses. */
  conversationId?: string;
}

/** Default summarizer: routes the request through the project's
 *  resolveModel + completeLLM. Prefers the per-turn provider/model
 *  picked by the user (passed via SummarizeContext) so the summarizer
 *  uses the SAME model as the surrounding Ez conversation. Falls back
 *  to default-tier resolution if the picked pair fails to resolve.
 *  Errors propagate as tool errors — including provider errors that
 *  pi-ai reports as fields on the result (`stopReason: "error"` +
 *  `errorMessage`) rather than throws: without that check a failed call
 *  has an EMPTY content array and the tool would return a blank summary
 *  that looks like a success. */
async function defaultSummarize(
  systemPrompt: string,
  transcript: string,
  provider?: string | null,
  model?: string | null,
  conversationId?: string,
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
  const result = await completeLLM(
    resolved.piModel,
    {
      systemPrompt,
      messages: [{ role: "user", content: transcript }],
    } as any,
    { conversationId },
  );
  // pi-ai reports provider failures as result fields, not throws.
  if ((result as any).stopReason === "error") {
    throw new Error((result as any).errorMessage || "model call failed with no error message");
  }
  // pi-ai AssistantMessage has a `content` array. Join text parts.
  const content = (result as any).content;
  const text =
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .filter((p: any) => p?.type === "text" && typeof p.text === "string")
            .map((p: any) => p.text)
            .join("")
        : String(content ?? "");
  // A summary is never legitimately empty — surface the anomaly instead
  // of returning a blank the panel renders as a silent no-op.
  if (!text.trim()) {
    throw new Error(
      `model returned no text (stopReason: ${String((result as any).stopReason ?? "unknown")})`,
    );
  }
  return text;
}

const MAX_TRANSCRIPT_CHARS = 60_000; // ~15k tokens. Truncates from the start (oldest) so the recent context survives.

export function createSummarizeConversationTool(ctx: SummarizeContext = {}): BuiltinToolDef {
  // Bind the per-turn provider/model into the default summarizer so the
  // tool's `summarize(system, transcript)` call site (below) doesn't need
  // to know about model resolution. Test-injected stubs ignore this
  // entirely — they receive `(systemPrompt, transcript)` and short-circuit
  // before defaultSummarize runs.
  const summarize = ctx.summarize ?? ((sys: string, t: string) => defaultSummarize(sys, t, ctx.provider, ctx.model, ctx.conversationId));
  return {
    name: "summarize_conversation",
    label: "summarize_conversation",
    description:
      "Summarize a conversation's message history, OR answer a specific question about it. The LLM MUST supply the conversationId. Pass an optional `question` to get a precise answer (counts, lists, extraction) computed over the FULL transcript — use this to escalate when a `read_page` page excerpt is truncated or doesn't contain the answer. Without a `question` it produces a `style`-tuned summary (brief | standup | tweet).",
    category: "ez",
    cardType: "default",
    // Server-side LLM call. Slow models on long transcripts (transcript
    // is capped at MAX_TRANSCRIPT_CHARS ≈ 15k tokens) can comfortably
    // exceed the default 90s watchdog deferral. 5 minutes covers the
    // worst legitimate case without papering over a wedged provider.
    // See `.planning/watchdog-builtins-hotfix.md`.
    callTimeoutMs: 300_000,
    parameters: Type.Unsafe({
      type: "object",
      properties: {
        conversationId: {
          type: "string",
          description: "Conversation to summarize. Required.",
        },
        style: { type: "string", enum: ["brief", "standup", "tweet"], description: "Summary style (ignored when `question` is set)." },
        question: {
          type: "string",
          description:
            "Optional. A specific question to answer over the FULL transcript (e.g. \"how many limited editions were listed?\", \"list every decision made\"). When set, the tool answers it precisely instead of producing a style summary — the escalation path when a read_page excerpt is truncated.",
        },
      },
      required: ["conversationId"],
    }),
    execute: async (_toolCallId, params: any) => {
      try {
        const explicit = typeof params?.conversationId === "string" ? params.conversationId.trim() : "";
        const conversationId = explicit;
        if (!conversationId) {
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "Error: conversationId is required. Pass the id explicitly.",
              },
            ],
            details: { isError: true },
          };
        }
        const style: SummaryStyle = params?.style && STYLE_PROMPTS[params.style as SummaryStyle] ? params.style : "brief";
        // A non-empty `question` turns this into a targeted-answer pass over
        // the transcript instead of a style summary (the escalation path when
        // a read_page excerpt is truncated). Whitespace-only falls back to
        // the style behavior.
        const question = typeof params?.question === "string" ? params.question.trim() : "";

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

        const systemPrompt = question
          ? `Answer the following question about the conversation transcript below. Be precise and quote/count from the transcript; if the transcript does not contain the answer, say so plainly. Question: ${question}`
          : STYLE_PROMPTS[style];
        const summary = await summarize(systemPrompt, transcript);
        const details: { conversationId: string; style: SummaryStyle; messageCount: number; question?: string } = {
          conversationId,
          style,
          messageCount: messages.length,
        };
        if (question) details.question = question;
        return {
          content: [{ type: "text" as const, text: summary }],
          details,
        };
      } catch (e: any) {
        return { content: [{ type: "text" as const, text: `Error: ${e.message}` }], details: { isError: true } };
      }
    },
  };
}
