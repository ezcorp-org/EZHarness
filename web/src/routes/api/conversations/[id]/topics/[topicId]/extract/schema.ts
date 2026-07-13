import { z } from "zod";

/**
 * POST /api/conversations/[id]/topics/[topicId]/extract body.
 *
 * No inputs — the topic id (path) fully determines the extraction. `.strict()`
 * rejects unknown keys with a 400 so a typo'd field never silently no-ops.
 */
export const extractContextSchema = z.object({}).strict();

export type ExtractContextBody = z.infer<typeof extractContextSchema>;
