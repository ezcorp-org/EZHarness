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
