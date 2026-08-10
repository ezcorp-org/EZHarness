/**
 * `CredentialStore` over EZCorp's encrypted settings table, plus the thin
 * `Models.getAuth()` wrapper that replaces pi-ai's removed `getOAuthApiKey`.
 *
 * WHY THIS EXISTS
 * ---------------
 * pi-ai 0.83.0 deleted `getOAuthApiKey` (and the whole OAuth registry) —
 * `@earendil-works/pi-ai/oauth` is now a TYPE-ONLY entrypoint. The
 * replacement is `Models.getAuth()`, which runs OAuth refresh inside
 * `CredentialStore.modify()` so the read-check-refresh-write sequence is one
 * serialized critical section per provider instead of three racy steps.
 *
 * The genuinely good idea in that design is the re-check of expiry INSIDE
 * `modify`: a second caller that queued behind the lock sees the
 * already-refreshed credential and returns `undefined` ("leave unchanged")
 * rather than burning a second refresh against the provider. EZCorp's old
 * `refreshLocks` Map deduplicated concurrent refreshes but could not do that,
 * because the expiry decision happened before the lock was taken.
 *
 * SCOPE OF THE LOCK (single-process assumption)
 * ---------------------------------------------
 * `modify` serializes through an in-memory promise chain — it serializes ops
 * within ONE process only, which is exactly the platform's stated deploy
 * model (single container). It does NOT span processes: two app instances
 * sharing one DATABASE_URL could refresh the same provider's token
 * concurrently, and for a provider that ROTATES its refresh token on use the
 * loser's stored credential would be stale (the user re-authenticates).
 * If horizontal scaling is ever supported, replace this chain with a Postgres
 * advisory lock keyed on the provider id.
 *
 * That wording is deliberate: it is the same constraint, in the same words,
 * that `withConvSessionLock` documents in src/db/session-sync.ts. Both are
 * in-process locks standing in for cross-process ones, and a deployment that
 * breaks one breaks the other — so they should be fixed together rather than
 * one subsystem quietly claiming a guarantee the platform does not offer.
 *
 * OAUTH-ONLY, DELIBERATELY
 * ------------------------
 * This store serves `provider:oauth:<provider>` and nothing else. API keys
 * stay on EZCorp's own precedence ladder in `credentials.ts` (BYOK setting →
 * `getEnvApiKey`), which encodes policy pi knows nothing about. An OAuth-only
 * store is a valid `CredentialStore`: it simply never holds an `api_key`
 * entry.
 */

import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type {
  Credential,
  CredentialInfo,
  CredentialStore,
  ModelAuth,
  OAuthCredential,
  OAuthCredentials,
} from "@earendil-works/pi-ai";
import { getSetting, upsertSetting, deleteSetting } from "../db/queries/settings";
import { decrypt, encrypt } from "./encryption";

/**
 * EZCorp provider name → the pi-ai provider id that owns its OAuth flow.
 *
 * `google-gemini-cli` is NOT a provider pi-ai has ever registered — not in
 * 0.80.6, not in 0.83.0 (where `google` is apiKey-only). Google OAuth has
 * therefore never worked; see {@link resolveOAuthAuth} for what happens now.
 */
export const OAUTH_PROVIDER_IDS: Record<string, string> = {
  openai: "openai-codex",
  google: "google-gemini-cli",
  anthropic: "anthropic",
};

/** Inverse of {@link OAUTH_PROVIDER_IDS}, derived so the two cannot drift. */
const EZ_PROVIDER_BY_PI_ID: Record<string, string> = Object.fromEntries(
  Object.entries(OAUTH_PROVIDER_IDS).map(([ez, pi]) => [pi, ez]),
);

/** The settings key holding a provider's encrypted OAuth credential. */
export function oauthSettingKey(ezProvider: string): string {
  return `provider:oauth:${ezProvider}`;
}

/**
 * Add pi's mandatory `type: "oauth"` tag to a stored blob.
 *
 * EZCorp's persisted credentials predate the tag and do not carry it. This is
 * a READ-TIME adaptation, not a data migration — nothing rewrites the stored
 * rows, and a credential written back by a refresh simply carries the tag
 * from then on (harmless: the reader adds it either way).
 */
export function tagOAuthCredential(creds: OAuthCredentials): OAuthCredential {
  return { ...creds, type: "oauth" };
}

/**
 * `CredentialStore` backed by the encrypted `settings` table.
 *
 * Keyed by **pi provider id** (that is what `Models` passes), translated to
 * EZCorp's provider name for the settings key. A pi provider EZCorp does not
 * map is simply absent — `read` resolves `undefined`, which is the interface's
 * "no credential" answer, never an error.
 */
export class SettingsCredentialStore implements CredentialStore {
  /** Per-provider serialization chain. See the SCOPE note in the header. */
  private readonly chains = new Map<string, Promise<unknown>>();

  async read(providerId: string): Promise<Credential | undefined> {
    const ezProvider = EZ_PROVIDER_BY_PI_ID[providerId];
    if (!ezProvider) return undefined;
    const stored = await getSetting(oauthSettingKey(ezProvider));
    if (typeof stored !== "string" || stored.length === 0) return undefined;
    try {
      return tagOAuthCredential(JSON.parse(decrypt(stored)) as OAuthCredentials);
    } catch {
      // Undecryptable or malformed (rotated encryption secret, hand-edited
      // row). Report "not configured" rather than throwing: the caller's
      // ladder then falls through to BYOK/env exactly as it would for a
      // provider that was never connected.
      return undefined;
    }
  }

  async list(): Promise<readonly CredentialInfo[]> {
    const out: CredentialInfo[] = [];
    for (const providerId of Object.keys(EZ_PROVIDER_BY_PI_ID)) {
      if (await this.read(providerId)) out.push({ providerId, type: "oauth" });
    }
    return out;
  }

  /**
   * The ONLY write path. Serialized per provider id: `fn` sees the credential
   * as of ITS turn in the queue, so a caller that waited behind a refresh
   * observes the refreshed token and can decline to refresh again by
   * returning `undefined`.
   *
   * A rejection from `fn` propagates to the caller AND leaves the stored
   * credential untouched — pi relies on that to preserve a credential for
   * retry when a refresh fails.
   */
  async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const prev = this.chains.get(providerId) ?? Promise.resolve();
    const run = prev.then(
      () => this.applyModify(providerId, fn),
      () => this.applyModify(providerId, fn),
    );
    // Park rejections on the CHAIN copy so a failed refresh cannot surface as
    // an unhandled rejection for the next waiter; the caller still sees it
    // through `run`.
    this.chains.set(
      providerId,
      run.catch(() => undefined),
    );
    try {
      return await run;
    } finally {
      if (this.chains.get(providerId) === run) this.chains.delete(providerId);
    }
  }

  private async applyModify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
  ): Promise<Credential | undefined> {
    const current = await this.read(providerId);
    const next = await fn(current);
    if (next === undefined) return current;
    const ezProvider = EZ_PROVIDER_BY_PI_ID[providerId];
    if (!ezProvider) return current;
    await upsertSetting(oauthSettingKey(ezProvider), encrypt(JSON.stringify(next)));
    return next;
  }

  async delete(providerId: string): Promise<void> {
    const ezProvider = EZ_PROVIDER_BY_PI_ID[providerId];
    if (!ezProvider) return;
    // Serialized against `modify` through the same chain, per the interface.
    await this.modify(providerId, async () => undefined);
    await deleteSetting(oauthSettingKey(ezProvider));
  }
}

/**
 * "This provider IS connected, but its stored credential cannot be turned
 * into a usable token" — as distinct from "nothing is connected".
 *
 * The distinction is the whole point: only the first is fixed by signing in
 * again, and only the first should out-rank a generic "no credentials"
 * message when the resolution ladder gives up. Raised for our own detectable
 * cases; pi's `ModelsError { code: "oauth" }` is the same category and both
 * are recognised by {@link isBrokenOAuth}.
 */
export class OAuthUnusableError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "OAuthUnusableError";
  }
}

/**
 * True when `err` means "connected but broken" rather than "not connected".
 *
 * Shape-checked, never message-matched: a credential path that decides
 * user-visible behaviour by substring is one upstream copy-edit away from
 * silently reclassifying every failure.
 */
export function isBrokenOAuth(err: unknown): boolean {
  if (err instanceof OAuthUnusableError) return true;
  // pi-ai's ModelsError. Structural check — the class is not exported in a
  // form worth importing just for an instanceof, and a cross-realm copy
  // would defeat it anyway.
  return typeof err === "object" && err !== null && (err as { code?: unknown }).code === "oauth";
}

let store: SettingsCredentialStore | undefined;

/** Process-wide store. One instance, so the per-provider chains are shared. */
export function getCredentialStore(): SettingsCredentialStore {
  store ??= new SettingsCredentialStore();
  return store;
}

/** Exported for testing: drop the singleton (and its in-flight chains). */
export function _resetCredentialStore(): void {
  store = undefined;
}

/**
 * EZCorp's expiry buffer. `getAuth` defaults to five minutes; this preserves
 * the 60s window `credentials.ts` has always used, so refresh timing is
 * byte-identical to the pre-0.83 behaviour rather than quietly widening.
 */
export const MIN_OAUTH_VALIDITY_MS = 60_000;

/**
 * Resolve request auth for a pi OAuth provider, refreshing under the store
 * lock when the token is inside {@link MIN_OAUTH_VALIDITY_MS} of expiry.
 *
 * Returns `undefined` when pi has no such provider (Google: `getProvider`
 * returns undefined for `google-gemini-cli`, so this is the arm that
 * replaces the old `Unknown OAuth provider` throw — same outcome for the
 * caller, which falls through to BYOK, but no longer disguised as an error).
 *
 * THROWS `ModelsError` with `code: "oauth"` when a refresh genuinely fails
 * (`invalid_grant`, a 401 from the token endpoint). The stored credential is
 * preserved for retry. That distinction — "not configured" vs "configured and
 * broken" — is the one the caller must not flatten.
 *
 * CALLERS MUST CONFIRM A STORED CREDENTIAL EXISTS FIRST. `getAuth` resolves
 * ambient env credentials when nothing is stored: measured, `getAuth("openai")`
 * with `OPENAI_API_KEY` set returns `{apiKey, source:"OPENAI_API_KEY"}`. It is
 * `undefined` for `openai-codex` today (that provider has no env-key path), but
 * relying on that would make an env API key returned as an OAuth token one
 * provider-map edit away.
 */
export async function resolveOAuthAuth(piProviderId: string): Promise<ModelAuth | undefined> {
  // No abort seam here on purpose: `AuthResolutionOverrides` is
  // `{apiKey?, env?, minOAuthValidityMs?}` — `getAuth` takes no signal, and
  // neither did `getOAuthApiKey`. Nothing is lost.
  const models = builtinModels({ credentials: getCredentialStore() });
  const result = await models.getAuth(piProviderId, { minOAuthValidityMs: MIN_OAUTH_VALIDITY_MS });
  return result?.auth;
}
