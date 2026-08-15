import { z } from "zod";

// Inlined (not imported from $server/auth/api-key) so this boundary-validation
// schema stays free of server-only imports — mirrors the existing pattern.
// Kept in lock-step with API_KEY_SCOPES / API_KEY_ROLES there.
const apiKeyScopes = ["read", "write", "chat", "extensions", "admin"] as const;
const apiKeyRoles = ["member", "admin"] as const;

/**
 * Per-key tool policy. SHAPE ONLY — this schema says the fields are the right
 * TYPES; it says nothing about whether they are legal. Semantics (every route
 * resolves against `src/api-registry.ts`, the mode is visible to the owner,
 * the names are spellable caller-tool names, the lock is enforceable on every
 * run-start route in the list) belong to `validateToolPolicy`, which the CLI
 * mint path runs too. Duplicating any of it here would create a second, quietly
 * divergent definition of a valid policy.
 *
 * `routeBundle` is the sanctioned way to write `routeAllowlist`: the route
 * expands the named bundle and rejects the pair, so a caller states a reviewed
 * set by NAME instead of retyping fourteen strings.
 */
const toolPolicySchema = z.object({
  routeAllowlist: z.array(z.string().min(1).max(200)).optional(),
  routeBundle: z.string().min(1).max(64).optional(),
  allowedCallerTools: z.array(z.string().min(1).max(64)).optional(),
  maxCallerTools: z.number().int().optional(),
  lockedModeId: z.string().min(1).max(100).optional(),
});

export const createApiKeySchema = z.object({
  name: z.string().min(1).max(100),
  scopes: z.array(z.enum(apiKeyScopes)).min(1),
  // Optional, defaults to the unchanged posture. Anti-escalation for
  // role:"admin" is enforced in the route (canMintRole), not the schema.
  role: z.enum(apiKeyRoles).optional().default("member"),
  // Absent ⇒ an unpolicied key, exactly as before policies existed.
  toolPolicy: toolPolicySchema.optional(),
});

export type CreateApiKeyInput = z.infer<typeof createApiKeySchema>;

export const deleteApiKeySchema = z.object({
  keyId: z.string().uuid(),
});

export type DeleteApiKeyInput = z.infer<typeof deleteApiKeySchema>;
