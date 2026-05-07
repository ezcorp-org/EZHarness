import { defineExtension } from "../../../../src/extensions/sdk/define";

// `ask_user_question` schema. v1 is single-question (`{ question, options? }`)
// for simplicity. The forward path to a multi-question variant — same as
// Claude Code's AskUserQuestion harness — is a non-breaking JSON-Schema
// `oneOf` extension that accepts EITHER the v1 shape OR `{ questions: [...] }`.
// Avoid renaming `question` / `options` so v1 callers don't break when v2 ships.
const ASK_USER_QUESTION_SCHEMA = {
  type: "object",
  properties: {
    question: {
      type: "string",
      description: "The question to present to the user.",
    },
    options: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional list of answer choices. When provided, the UI renders one button per option and the user picks one. When omitted, the UI renders a free-text input.",
    },
  },
  required: ["question"],
} as const;

export default defineExtension({
  schemaVersion: 2,
  name: "ask-user",
  version: "1.0.0",
  description:
    "Pause execution and ask the user a question. Renders inline in the assistant message bubble — supports clickable options or free-text. Replaces orchestration's `ask_human` for general-purpose human-in-the-loop.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  // The pending-answer gate lives in a process-local Map keyed on
  // `toolCallId`; the subprocess must survive across calls so the map
  // persists. Same posture as `orchestration` and `task-tracking`.
  persistent: true,
  tools: [
    {
      name: "ask_user_question",
      description:
        "Ask the user a question and wait for their answer. Use this whenever you need clarification, a decision, or information that only the user can provide. Prefer providing `options` when the answer space is finite (yes/no, a small list of choices) — the UI renders clickable buttons and the user can answer in one click. Omit `options` for open-ended questions; the UI renders a text input. The tool returns the user's answer verbatim.",
      inputSchema: ASK_USER_QUESTION_SCHEMA as Record<string, unknown>,
      // Inline tool-card rendering — `web/src/lib/components/tool-cards/
      // AskUserQuestionCard.svelte` reads `toolCall.input.question` and
      // `toolCall.input.options` and renders buttons or a textarea. The
      // user's click POSTs to `/api/ask-user/answer` with the toolCallId.
      cardType: "ask-user-question",
      // Human-in-the-loop: the wait is bounded by user behavior, not by
      // a server-side timer. Opts the call out of the subprocess
      // JSON-RPC timeout race AND the watchdog idle-kill — both layers
      // would otherwise fire at the manifest's `callTimeoutMs` and surface
      // as `Tool call timed out after Xms`. Cancellation still flows
      // through the normal AbortSignal path on run interruption.
      requiresUserInput: true,
    },
  ],
  permissions: {
    // Subscribed to so the extension's gate-resolution handler receives
    // `ask-user:answer` from the host bus. The host POST endpoint
    // validates the toolCallId against the `tool_calls` DB table to
    // resolve `conversationId`, then emits with conversation scope —
    // `src/runtime/sse-conversation-filter.ts` clamps delivery to wired
    // extensions in the matching conversation.
    eventSubscriptions: ["ask-user:answer"],
  },
});
