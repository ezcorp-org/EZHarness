import { z } from "zod";

/**
 * Body for `POST /api/conversations/:id/messages/:mid/retry` (Sessions P5, the
 * clean A/B retry). Every field is optional — an empty `{}` (or no body) retries
 * with the conversation's own pinned provider/model. The optional overrides let
 * the composer retry the SAME user turn against a different model without
 * touching the conversation's pin. `.strict()` so an unknown field fails loud;
 * the surface is small enough that any drift would be intentional.
 */
export const retryMessageSchema = z
  .object({
    provider: z.string().min(1).max(200).optional(),
    model: z.string().min(1).max(200).optional(),
    thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  })
  .strict();

export type RetryMessageBody = z.infer<typeof retryMessageSchema>;
