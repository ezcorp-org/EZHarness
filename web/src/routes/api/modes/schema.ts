import { z } from "zod";
// The tier vocabulary is owned by the routing classifier — derived here, not
// re-typed, so a new tier can never be accepted by routing and rejected by
// this validator (or the reverse). That module is dependency-free.
import { VALID_TIERS, type RoutingTier } from "$server/runtime/tier-classifier";

// The cast is a tuple-arity assertion only (zod wants a non-empty tuple; the
// module exports a readonly array) — the MEMBERS still come from VALID_TIERS,
// so the parsed value narrows to RoutingTier and cannot drift from it.
const routingTierEnum = z.enum(VALID_TIERS as readonly [RoutingTier, ...RoutingTier[]]);

export const createModeSchema = z.object({
  name: z.string().min(1).max(100),
  slug: z
    .string()
    .min(1)
    .max(50)
    .regex(/^[a-z0-9-]+$/, "Slug must be lowercase alphanumeric with hyphens"),
  icon: z.string().max(10).optional(),
  description: z.string().max(500).optional(),
  systemPromptInstruction: z.string().min(1).max(10000),
  instructionPosition: z.enum(["prepend", "append", "replace"]).optional(),
  preferredModel: z.string().max(100).nullable().optional(),
  preferredProvider: z.string().max(100).nullable().optional(),
  /** WS3b: routing tier for this kind of task, when the mode names no model. */
  preferredTier: routingTierEnum.nullable().optional(),
  preferredThinkingLevel: z
    .enum(["off", "minimal", "low", "medium", "high", "xhigh"])
    .nullable()
    .optional(),
  temperature: z.number().int().min(0).max(100).nullable().optional(),
  toolRestriction: z.enum(["all", "read-only", "none"]).optional(),
  extensionIds: z.array(z.string().max(200)).max(100).optional(),
  /** Per-extension tool subset (extension id → selected tool names). Keys not
   *  present (or empty arrays) mean "all tools" for that extension. */
  extensionTools: z.record(z.string().max(200), z.array(z.string().max(200)).max(500)).optional(),
});

export const updateModeSchema = createModeSchema.partial();
