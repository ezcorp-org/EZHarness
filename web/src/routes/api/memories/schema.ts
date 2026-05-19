import { z } from "zod";

// Memories endpoint currently only has GET (query params).
// This schema documents the expected query parameters for reference.
export const searchMemoriesQuerySchema = z.object({
  projectId: z.string().uuid().optional(),
  search: z.string().max(500).optional(),
  status: z.string().optional(),
  category: z.string().max(100).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  offset: z.coerce.number().int().min(0).optional(),
});

export type SearchMemoriesQuery = z.infer<typeof searchMemoriesQuerySchema>;

/**
 * v1.4 PATCH /api/memories/[id] body shape.
 *
 * Single-field for now: `{ injectionEligible: boolean }`. Future
 * fields land in their own PATCH calls or a future generalized
 * endpoint — see `tasks/v1.4-memory-injection-eligibility-ui.md`
 * § Decisions locked in.
 *
 * `.strict()` rejects unknown keys with a 400 so a typo'd field
 * doesn't silently no-op (defense in depth — the handler also
 * skips fields it doesn't recognize, but the early reject keeps
 * the contract honest).
 */
export const patchMemorySchema = z
  .object({
    injectionEligible: z.boolean(),
  })
  .strict();

export type PatchMemoryBody = z.infer<typeof patchMemorySchema>;
