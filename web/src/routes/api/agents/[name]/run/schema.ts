import { z } from "zod";

export const runAgentSchema = z.object({
  projectId: z.string().uuid().optional(),
}).passthrough();

export type RunAgentInput = z.infer<typeof runAgentSchema>;
