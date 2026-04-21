import { z } from "zod";

export const createConversationSchema = z.object({
  projectId: z.union([z.literal("global"), z.string().uuid("Invalid projectId")]),
  title: z.string().max(500).optional(),
  model: z.string().max(100).optional(),
  provider: z.string().max(100).optional(),
  agentConfigId: z.string().uuid().optional(),
  test: z.boolean().optional(),
  parentConversationId: z.string().uuid().optional(),
  parentMessageId: z.string().uuid().optional(),
});

export const updateConversationSchema = z.object({
  title: z.string().max(500).optional(),
  model: z.string().max(100).optional(),
  provider: z.string().max(100).optional(),
  systemPrompt: z.string().max(50000).optional(),
  modeId: z.string().uuid().nullable().optional(),
});

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
