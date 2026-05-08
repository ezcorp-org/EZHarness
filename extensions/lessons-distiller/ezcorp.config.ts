// Lessons-distiller — bundled extension manifest (Phase 53 Stage 1).
//
// Ports the legacy host-side distiller (src/runtime/lessons/distiller.ts)
// onto the SDK capability surfaces. Trigger heuristics stay host-side
// (called via `ctx.invoke("runtime.lessons.triggerGate", …)`); the
// per-conversation message slice is fetched via
// `ctx.invoke("runtime.conversations.getMessages", …)`. Lesson writes
// flow through `ctx.lessons.write` (audited, slug-collision soft).
//
// Stage 1 ships alongside the legacy implementation; the parity test in
// `src/__tests__/distiller-port-parity.test.ts` proves both code paths
// agree across every `DistillationOutcome` variant before Stage 2
// deletes the legacy code.
//
// `permissions.lessons.maxVisibility = "user"` mirrors the legacy
// pipeline's `visibility: "user"` write (promotion ladder is v1.5+).
// `permissions.llm` mirrors `DISTILLATION_MODELS` from the legacy file
// (claude-haiku, gpt-4o-mini, gemini-2.0-flash-lite).

import { defineExtension } from "../../src/extensions/sdk/define";

export default defineExtension({
  schemaVersion: 2,
  name: "lessons-distiller",
  version: "1.0.0",
  description:
    "Distills durable lessons from completed runs (auto on run:complete and via the manual !EZ:distill action).",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  persistent: false,

  permissions: {
    llm: {
      providers: ["google", "openai", "anthropic", "ollama"],
      maxCallsPerHour: 30,
      maxCallsPerDay: 200,
      maxTokensPerCall: 1024,
      allowedModels: {
        google: ["gemini-2.0-flash-lite"],
        openai: ["gpt-4o-mini"],
        anthropic: ["claude-haiku-4-5-20250514"],
        // Ollama models are user-installed and listed by `ollama pull`,
        // so this list is just the host-provided defaults shown to the
        // distiller settings UI. Custom models work via the
        // `model` text override.
        ollama: ["gemma4:e2b", "gemma4:latest", "qwen3.6:35b"],
      },
    },
    lessons: {
      access: "write",
      maxWritesPerDay: 50,
      maxVisibility: "user",
    },
    eventSubscriptions: ["run:complete"],
    storage: true,
  },

  tools: [
    {
      name: "distill_now",
      description:
        "Manually distill a lesson from this conversation, bypassing the trigger gate. Used by the !EZ:distill chat action.",
      inputSchema: {
        type: "object",
        properties: {
          conversationId: {
            type: "string",
            description:
              "The conversation to distill. Caller (host route forwarder) supplies the active conversation id.",
          },
        },
        required: ["conversationId"],
      },
    },
  ],

  settings: {
    enabled: {
      type: "boolean",
      label: "Enabled",
      description: "Auto-distill lessons when a chat run completes.",
      default: true,
    },
    provider: {
      type: "select",
      label: "Model provider",
      description:
        "Which provider to call for the distillation LLM. Falls back to Google if no preference.",
      options: [
        { value: "google", label: "Google" },
        { value: "openai", label: "OpenAI" },
        { value: "anthropic", label: "Anthropic" },
        { value: "ollama", label: "Ollama (local)" },
      ],
      default: "google",
    },
    model: {
      type: "text",
      label: "Model id (override)",
      description:
        "Leave blank to use the provider default (gemini-2.0-flash-lite / gpt-4o-mini / claude-haiku-4-5 / gemma4:e2b for Ollama).",
      default: "",
    },
  },
});
