import { z } from "zod";

export const createModeSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z.string().min(1).max(50).regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  icon: z.string().max(10).optional(),
  description: z.string().max(500).optional(),
  systemPromptInstruction: z.string().min(1).max(10000),
  instructionPosition: z.enum(["prepend", "append", "replace"]).optional(),
  preferredModel: z.string().max(100).nullable().optional(),
  preferredProvider: z.string().max(100).nullable().optional(),
  preferredThinkingLevel: z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]).nullable().optional(),
  temperature: z.number().int().min(0).max(100).nullable().optional(),
  toolRestriction: z.enum(["all", "read-only", "none"]).optional(),
});

export const updateModeSchema = createModeSchema.partial();
