import { z } from "zod";

/**
 * POST /api/composer/suggest — rank the active mode/toolset's tools against
 * a draft prompt and optionally generate a prompt-enhancement rewrite.
 *
 * `modeId` mirrors /api/tools' presence semantics: a PRESENT field (even
 * null) is authoritative over the conversation's persisted mode, so the
 * composer can reflect a just-picked mode without racing the PATCH that
 * persists it.
 *
 * `include` lets the client split the fast half (tools ≈ tens of ms) from
 * the slow half (enhance ≈ seconds on CPU) into parallel requests so tool
 * chips never wait on the local LLM.
 */
export const suggestRequestSchema = z
  .object({
    draft: z.string().min(1).max(4000),
    conversationId: z.string().min(1).optional(),
    /** Fallback for the per-project toggle when no conversation scopes the
     *  call; a resolved conversation's own project always wins over this. */
    projectId: z.string().min(1).optional(),
    modeId: z.string().nullable().optional(),
    include: z.array(z.enum(["tools", "enhance", "extensions"])).nonempty().default(["tools"]),
  })
  .strict();

export type SuggestRequest = z.infer<typeof suggestRequestSchema>;

/**
 * POST /api/composer/suggest/feedback — suggestion telemetry. Deliberately
 * carries NO draft text: tool names, action, and latency only. This is the
 * signal that answers "are suggestions useful?" (and specifically whether
 * the enhancement half earns its sidecar).
 */
export const suggestFeedbackSchema = z
  .object({
    kind: z.enum(["tool", "enhance", "extension"]),
    action: z.enum(["shown", "accepted", "dismissed"]),
    toolName: z.string().max(200).optional(),
    conversationId: z.string().optional(),
    latencyMs: z.number().int().min(0).max(600_000).optional(),
  })
  .strict();

export type SuggestFeedback = z.infer<typeof suggestFeedbackSchema>;
