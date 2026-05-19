import { z } from "zod";

const messageSchema = z.object({
  role: z.string().min(1),
  content: z.string().min(1),
});

export const generateAgentConfigSchema = z.object({
  messages: z.array(messageSchema).min(1, "At least one message is required"),
  provider: z.string().min(1).optional(),
  model: z.string().min(1).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
  modeId: z.string().min(1).optional(),
});

export type GenerateAgentConfigInput = z.infer<typeof generateAgentConfigSchema>;
