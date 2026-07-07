import { z } from "zod";

// Inlined (not imported from $server/auth/api-key) so this boundary-validation
// schema stays free of server-only imports — mirrors the existing pattern.
// Kept in lock-step with API_KEY_SCOPES / API_KEY_ROLES there.
const apiKeyScopes = ["read", "chat", "extensions", "admin"] as const;
const apiKeyRoles = ["member", "admin"] as const;

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(apiKeyScopes)).min(1),
  // Optional, defaults to the unchanged posture. Anti-escalation for
  // role:"admin" is enforced in the route (canMintRole), not the schema.
  role: z.enum(apiKeyRoles).optional().default("member"),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export const deleteApiKeySchema = z.object({
  keyId: z.string().uuid(),
});

export type DeleteApiKeyInput = z.infer<typeof deleteApiKeySchema>;
