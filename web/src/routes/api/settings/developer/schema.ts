import { z } from "zod";

const apiKeyScopes = ["read", "chat", "extensions", "admin"] as const;

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(apiKeyScopes)).min(1),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export const deleteApiKeySchema = z.object({
  keyId: z.string().uuid(),
});

export type DeleteApiKeyInput = z.infer<typeof deleteApiKeySchema>;
