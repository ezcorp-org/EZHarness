import { z } from "zod";
import { passwordSchema } from "$lib/server/security/validation";

export const setupSchema = z.object({
  name: z.string().min(1, "Name is required").max(100),
  email: z.string().email("Valid email is required"),
  password: passwordSchema,
});

export type SetupInput = z.infer<typeof setupSchema>;
