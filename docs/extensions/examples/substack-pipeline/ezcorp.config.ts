import { defineExtension } from "../../../../src/extensions/sdk/define";

// ── substack-pipeline ────────────────────────────────────────────
//
// Turns one URL into a polished Substack-style article + cover image,
// with a bounded human approve/revise loop. Sibling to `substack-pilot`
// (one-shot, no iteration, no image). REUSES substack-pilot's proven
// URL fetch + summarize logic instead of duplicating it.
//
// Each "agent" is a distinct role-prompted LLM stage in `lib/pipeline.ts`
// (summarizer → writer → reviser → illustrator). The flow is a 3-tool
// surface the LLM sequences per `skills/substack-pipeline/SKILL.md`:
//
//   draft_substack_post   — summarize (cross-ext) + WRITER → scratch
//   revise_substack_post  — WRITER(prevDraft+feedback) → scratch
//   finalize_substack_post— ILLUSTRATOR + IMAGE (cross-ext)
//
// The human turn is the platform's `ask_user_question` (bundled
// `ask-user`), called BY THE LLM via its wired path — NOT cross-ext
// invoked. Reason (see README "Host limitation"): the host's
// `ezcorp/invoke` path does not thread `invocationMetadata.toolCallId`
// /`conversationId` into the target subprocess (tool-executor.ts:1180),
// and `ask-user-registry` is only populated by the LLM-facing
// `wireAskUserToolForTurn` — so a cross-ext-invoked `ask_user_question`
// can neither open a resolvable gate nor be answered by a real click.
// `src/__tests__/substack-pipeline.integration.test.ts` pins this.
//
// Permission contract:
//  - `llm.providers` — WRITER + ILLUSTRATOR stages call ctx.llm
//  - `storage`       — conversation-scoped scratch state between the
//                      three tools (no large blobs through the LLM)
//  - `dependencies`  — the two NON-requiresUserInput cross-ext targets
//  - NO network (URL fetch happens inside substack-pilot's subprocess),
//    NO shell, NO env. `ask-user` is NOT a dependency — the LLM calls it.

export default defineExtension({
  schemaVersion: 2,
  name: "substack-pipeline",
  version: "1.0.0",
  description:
    "Summarize a URL, draft a Substack article with a bounded user approve/revise loop, then generate a cover image. Deterministic role-prompted stages; the LLM sequences the human turn.",
  author: { name: "EZCorp" },
  entrypoint: "./index.ts",
  tools: [
    {
      name: "draft_substack_post",
      description:
        "Step 1. Summarize the given URL and write the first Substack-style article draft. Returns the draft. After calling this, show the draft to the user and call ask_user_question to get approval or change requests.",
      inputSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "The http(s) URL of the source article to summarize and rewrite.",
          },
          styleNote: {
            type: "string",
            description:
              "Optional one-line steer for the writer (tone, audience, angle).",
          },
        },
        required: ["url"],
      },
    },
    {
      name: "revise_substack_post",
      description:
        "Step 2 (loop). Rewrite the in-progress draft per the user's feedback. Call this after the user requested changes (pass their verbatim feedback). Returns the revised draft; then ask the user again.",
      inputSchema: {
        type: "object",
        properties: {
          feedback: {
            type: "string",
            description: "The user's verbatim description of the changes they want.",
          },
        },
        required: ["feedback"],
      },
    },
    {
      name: "finalize_substack_post",
      description:
        "Step 3. Call once the user approves the draft. Derives a cover-image prompt and generates the cover image, then returns the final article with the image embedded.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  skills: [
    {
      name: "substack-pipeline",
      description:
        "How to drive draft → ask_user_question → revise/finalize to produce a Substack post + cover image from a URL.",
      files: ["skills/substack-pipeline/SKILL.md"],
    },
  ],
  permissions: {
    llm: {
      providers: ["anthropic", "openai"],
      maxCallsPerHour: 120,
      maxCallsPerDay: 600,
      maxTokensPerCall: 4096,
    },
    storage: true,
  },
  dependencies: {
    "substack-pilot": {
      source: "github:ezcorp/substack-pilot",
      version: "^1.0.0",
    },
    "openai-image-gen-2": {
      source: "github:ezcorp/openai-image-gen-2",
      version: "^1.2.0",
    },
  },
});
