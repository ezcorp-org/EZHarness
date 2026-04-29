import { z } from "zod";

/**
 * Phase 48 — Ez page-context payload.
 *
 * The Ez panel synthesizes this per-turn from `$page` (always-on Tier 1)
 * and the global `<EzContext>` registry (opt-in Tier 2). Server-side
 * we accept a permissive shape here — the field flows through to
 * `setup-tools.ts` which serializes the entire object into a compact
 * JSON `<page_context>` block appended to the system prompt for Ez turns
 * only. Schema here matches `EzContextPayload` (see
 * `web/src/lib/ez/context-serializer.ts`):
 *
 *   - `route`: synthesized from $page; required.
 *   - `data`: aggregated page-registered data (Tier 2); optional.
 *   - `formIds`: page-registered form ids; optional.
 *
 * Optional and silently dropped on a regular conversation. The
 * messages endpoint does NOT validate that the conversation is Ez here —
 * setup-tools.ts gates `<page_context>` emission on `convRecord.kind === 'ez'`,
 * so a leak from a regular client would still be filtered downstream.
 */
const ezContextSchema = z
  .object({
    route: z.object({
      url: z.string(),
      routeId: z.string().nullable(),
      params: z.record(z.string(), z.string()).optional(),
      projectId: z.string().nullable().optional(),
      conversationId: z.string().nullable().optional(),
      agentId: z.string().nullable().optional(),
    }),
    // `data` arrives as a flat object from the panel's serializer. Keep
    // the validation permissive (`unknown`) — the runtime serializes the
    // whole blob into a JSON string for the prompt; deeper validation
    // would inevitably reject legitimate page payloads. Token budget is
    // already enforced client-side at ~500 tokens.
    data: z.record(z.string(), z.unknown()).optional(),
    formIds: z.array(z.string()).optional(),
  })
  .strict()
  .optional();

export const createMessageSchema = z.object({
  content: z.string().min(1, "Content is required").max(100000),
  provider: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  parentMessageId: z.string().uuid().optional(),
  editOf: z.string().uuid().optional(),
  permissionMode: z.enum(["ask", "auto-edit", "yolo"]).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  ezContext: ezContextSchema,
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;
export type EzContextInput = z.infer<typeof ezContextSchema>;
