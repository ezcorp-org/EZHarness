import { z } from "zod";

export const publishListingSchema = z.object({
  agentConfigId: z.string().uuid("Invalid agentConfigId"),
  version: z.string().regex(/^\d+\.\d+\.\d+$/, "Version must be semver (e.g. 1.0.0)").optional(),
  changelog: z.string().max(5000).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
});

export type PublishListingInput = z.infer<typeof publishListingSchema>;
