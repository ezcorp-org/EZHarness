import { z } from "zod";
import { passwordSchema } from "$lib/server/security/validation";

export const generateResetSchema = z.object({
  userId: z.string().min(1),
});

// Token already binds the userId via `claimPasswordResetToken`, so the
// caller does not re-assert the email — adding it would only leak which
// address owns the token. See SEC F-H4 in [token]/+server.ts for the
// rationale.
export const consumeResetSchema = z.object({
  password: passwordSchema,
});
