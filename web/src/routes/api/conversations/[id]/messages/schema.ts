import { z } from "zod";

export const createMessageSchema = z.object({
  content: z.string().min(1, "Content is required").max(100000),
  // Explicit `null` is the Auto (smart routing) sentinel — deliberate and
  // distinguishable from an ABSENT field (which keeps the legacy
  // conv.provider/conv.model fallback). See the POST handler.
  provider: z.string().max(100).nullable().optional(),
  model: z.string().max(100).nullable().optional(),
  parentMessageId: z.string().uuid().optional(),
  editOf: z.string().uuid().optional(),
  permissionMode: z.enum(["ask", "auto-edit", "yolo"]).optional(),
  thinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).optional(),
});

export type CreateMessageInput = z.infer<typeof createMessageSchema>;
