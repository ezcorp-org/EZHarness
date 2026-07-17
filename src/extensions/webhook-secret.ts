/**
 * Per-hook webhook secret — mint / read / rotate, wrapping the AEAD-bound
 * `extension_secrets` store (Loops EZ Mode Phase 4).
 *
 * The secret authenticates an inbound `POST /api/hooks/:extensionId/:slug`.
 * It is stored ENCRYPTED (AES-256-GCM, scope-bound AAD — see secrets-store.ts)
 * under name `webhook:<slug>`, scoped `(extensionId, projectId: null,
 * userId: null)` so the ownerless, session-less route handler can read it with
 * no user context (mirrors how the poll daemon reads a project-scoped token).
 *
 * SECURITY:
 *   - The plaintext is returned ONLY at mint/rotate time (shown-once). After
 *     that it is unreadable except via `getWebhookSecret` (HOST ONLY — never
 *     wired to the extension sandbox), which the route uses to verify.
 *   - The token is 32 bytes of CSPRNG entropy, base64url — 256 bits, no
 *     enumeration. The `ezhook_` prefix is a human-facing type tag only.
 *   - NEVER logged. Callers audit `{slug}` metadata via the secrets-store, never
 *     the value.
 */
import { randomBytes } from "node:crypto";
import { setSecret, getSecret, hasSecret, deleteSecret } from "./secrets-store";

/** Human-facing token prefix (type tag; not a secret component). */
export const WEBHOOK_TOKEN_PREFIX = "ezhook_";

/** The `extension_secrets` row name a hook's secret lives under. */
export function webhookSecretName(slug: string): string {
  return `webhook:${slug}`;
}

/** Generate a fresh 256-bit webhook token. Pure CSPRNG; the caller stores it. */
export function generateWebhookToken(): string {
  return WEBHOOK_TOKEN_PREFIX + randomBytes(32).toString("base64url");
}

/**
 * Mint (or rotate) the secret for `(extensionId, slug)` and return the
 * plaintext ONCE. Overwrites any existing secret for the slug — rotation
 * invalidates the previous token immediately. `actorUserId` attributes the
 * SECRET_SET audit row to the rotating user while the secret itself stays
 * project/global-scoped (userId null) so the route can read it session-lessly.
 */
export async function mintWebhookSecret(
  extensionId: string,
  slug: string,
  actorUserId?: string | null,
): Promise<string> {
  const token = generateWebhookToken();
  await setSecret(extensionId, null, webhookSecretName(slug), token, {
    userId: null,
    ...(actorUserId !== undefined ? { actorUserId } : {}),
  });
  return token;
}

/**
 * HOST-ONLY plaintext read of a hook's secret (used by the route to verify an
 * inbound token / HMAC). Returns `null` when absent or undecryptable. DO NOT
 * expose to the extension sandbox.
 */
export async function getWebhookSecret(
  extensionId: string,
  slug: string,
): Promise<string | null> {
  return getSecret(extensionId, null, webhookSecretName(slug), { userId: null });
}

/** True iff a decryptable secret exists for the slug (mint-if-absent guard). */
export async function hasWebhookSecret(
  extensionId: string,
  slug: string,
): Promise<boolean> {
  return hasSecret(extensionId, null, webhookSecretName(slug), { userId: null });
}

/**
 * Ensure a secret exists for the slug WITHOUT rotating an existing one — the
 * install-reconcile path calls this so a freshly-declared hook has a working
 * secret immediately, but a re-install never silently invalidates a live token.
 * Returns the newly-minted plaintext when it created one, else `null`.
 */
export async function ensureWebhookSecret(
  extensionId: string,
  slug: string,
  actorUserId?: string | null,
): Promise<string | null> {
  if (await hasWebhookSecret(extensionId, slug)) return null;
  return mintWebhookSecret(extensionId, slug, actorUserId);
}

/** Delete a hook's secret (slug removal cleanup). Returns true on a real
 *  deletion. */
export async function deleteWebhookSecret(
  extensionId: string,
  slug: string,
): Promise<boolean> {
  return deleteSecret(extensionId, null, webhookSecretName(slug), { userId: null });
}
