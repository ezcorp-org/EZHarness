import { z } from "zod";

export const runAgentSchema = z.object({
  // uuid or 'self' — the seeded dev-workspace project (a real project row,
  // unlike the 'global' sentinel, which stays excluded here).
  projectId: z.union([z.literal("self"), z.string().uuid()]).optional(),
}).passthrough();

export type RunAgentInput = z.infer<typeof runAgentSchema>;
