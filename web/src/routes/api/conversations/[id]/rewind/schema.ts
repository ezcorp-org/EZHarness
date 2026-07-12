import { z } from "zod";

/**
 * Body for `POST /api/conversations/:id/rewind` (Sessions P4 rewind/checkpoint).
 *
 * `targetMessageId` is the message to make the conversation's new durable leaf
 * (a `messages` row id — always a UUID in this system). `summary` optionally
 * records a `branch_summary` annotation for the branch being abandoned. `.strict()`
 * so an unknown field fails loud rather than silently — this route is small
 * enough that any drift would be intentional.
 */
export const rewindConversationSchema = z
  .object({
    targetMessageId: z.string().uuid(),
    summary: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

export type RewindConversationBody = z.infer<typeof rewindConversationSchema>;
