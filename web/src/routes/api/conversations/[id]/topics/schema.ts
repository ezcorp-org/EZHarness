import { z } from "zod";

/**
 * POST /api/conversations/[id]/topics body.
 *
 * `force` re-runs detection even when the client believes the cache is
 * fresh; the server always detects on POST (explicit Analyze/Refresh), so
 * the flag is advisory. `.strict()` rejects unknown keys with a 400.
 */
export const detectTopicsSchema = z
  .object({
    force: z.boolean().optional(),
  })
  .strict();

export type DetectTopicsBody = z.infer<typeof detectTopicsSchema>;
