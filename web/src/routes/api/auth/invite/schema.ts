import { z } from "zod";

export const createInviteSchema = z.object({
  email: z.string().email("Valid email is required"),
  role: z.enum(["admin", "member"]).default("member"),
});

export type CreateInviteInput = z.infer<typeof createInviteSchema>;
