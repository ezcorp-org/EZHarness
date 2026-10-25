import { z } from "zod";
import { concreteProjectIdSchema } from "$lib/server/security/validation";

export const runAgentSchema = z.object({
  // uuid or 'self' — the seeded dev-workspace project (a real project row,
  // unlike the 'global' sentinel, which stays excluded here).
  projectId: z.union([z.literal("self"), concreteProjectIdSchema]).optional(),
}).passthrough();

export type RunAgentInput = z.infer<typeof runAgentSchema>;
