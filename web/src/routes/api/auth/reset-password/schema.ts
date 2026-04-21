import { z } from "zod";
import { passwordSchema } from "$lib/server/security/validation";

export const generateResetSchema = z.object({
  userId: z.string().min(1),
});

export const consumeResetSchema = z.object({
  email: z.string().email(),
  password: passwordSchema,
});
