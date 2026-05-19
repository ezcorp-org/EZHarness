import { z } from "zod";

// Phase 48: `modeId` is accepted on POST so callers can opt into a custom
// mode at creation time. It cannot point at the Ez mode (slug='ez'); the
// API rejects that combination so the Ez harness stays the only producer
// of ez-kind conversations. The Ez panel itself uses the dedicated
// getOrCreateEzConversation path, never POST. Validation is a UUID OR the
// well-known seeded id 'builtin-ez' (which the guard then explicitly
// rejects when paired with kind='regular' implicit in this endpoint).
export const createConversationSchema = z.object({
  projectId: z.union([z.literal("global"), z.string().uuid("Invalid projectId")]),
  title: z.string().max(500).optional(),
  model: z.string().max(100).optional(),
  provider: z.string().max(100).optional(),
  agentConfigId: z.string().uuid().optional(),
  test: z.boolean().optional(),
  parentConversationId: z.string().uuid().optional(),
  parentMessageId: z.string().uuid().optional(),
  modeId: z.string().min(1).max(100).optional(),
});

export const updateConversationSchema = z.object({
  title: z.string().max(500).optional(),
  model: z.string().max(100).optional(),
  provider: z.string().max(100).optional(),
  systemPrompt: z.string().max(50000).optional(),
  modeId: z.string().uuid().nullable().optional(),
});

export const cloneTurnsSchema = z.object({
  messageIds: z.array(z.string().uuid("Invalid messageId")).min(1, "Select at least one turn").max(500),
  title: z.string().max(500).optional(),
});

export type CreateConversationInput = z.infer<typeof createConversationSchema>;
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;
export type CloneTurnsInput = z.infer<typeof cloneTurnsSchema>;
