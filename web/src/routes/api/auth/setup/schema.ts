import { z } from "zod";
import { passwordSchema } from "$lib/server/security/validation";

export const setupSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email("Valid email is required"),
  password: passwordSchema,
  // Required only on a provisioned installation, where first-run setup is
  // gated by the operator's first-administrator invitation (C12 step 7).
  invitationToken: z.string().min(1).max(128).optional(),
});

export type SetupInput = z.infer<typeof setupSchema>;
