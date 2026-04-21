import { z } from "zod";

// Agent run schema - flexible input with optional projectId
export const runAgentSchema = z.object({
  projectId: z.string().uuid().optional(),
}).passthrough();

export type RunAgentInput = z.infer<typeof runAgentSchema>;
