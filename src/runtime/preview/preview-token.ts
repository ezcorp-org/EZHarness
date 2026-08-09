import { signJWT, verifyJWT, getJwtSecret } from "../../auth/jwt";

/**
 * Token / cookie handoff for the secure-preview reverse proxy
 * (Secure User-Site Preview / Port Exposure, Phase 1 — see
 * tasks/preview-port-exposure.md §3.5).
 *
 * The app origin's `ezcorp_session` cookie is host-only (no `Domain=`),
 * so it is NEVER sent to a `*.preview.<host>` subdomain. That isolation
 * is what makes a separate preview origin safe — but it also means the
 * preview origin has no ambient auth. So access uses a dedicated,
 * short-lived signed token bound to BOTH the preview id and the user:
 *
 *   1. The authenticated app origin calls `POST /api/preview/:id/token`,
 *      which mints a ONE-TIME CODE (`mintOneTimeCode`) — an opaque
 *      random string stored process-side with a short TTL + single-use.
 *   2. The browser opens `https://<id>.preview.<host>/__open?c=<code>`.
 *      The proxy redeems the code (`redeemOneTimeCode`), mints the
 *      `__ezpreview` JWT (`signPreviewToken`), sets it host-only on the
 *      subdomain, and 302s to `/` with `Referrer-Policy: no-referrer`.
 *   3. Every subsequent request validates the cookie
 *      (`verifyPreviewToken`) and the registry asserts
 *      token.userId === row.userId, not expired/revoked.
 *
 * The one-time code (vs. minting the JWT directly into the URL) shrinks
 * the token-leak window: a code is single-use and expires in seconds, so
 * a leaked `?c=...` in a referer/history is inert after first redemption.
 *
 * Single-container note (resolves spec open-question #4 scope): the
 * code store is in-process. EZCorp is a single shared container, so a
 * module-scoped Map is correct + simplest for Phase 1; a multi-instance
 * deploy would swap this for a shared store behind the same interface.
 */

export const PREVIEW_COOKIE_NAME = "__ezpreview";

/** One-time code lifetime — seconds. Deliberately tiny: the code is
 *  redeemed immediately by the browser following the `/__open` redirect. */
export const ONE_TIME_CODE_TTL_SECONDS = 60;

/** `__ezpreview` JWT lifetime — seconds. Short by design; the proxy
 *  re-mints via a fresh handoff when it lapses. Bounds the blast radius
 *  of a stolen cookie. */
export const PREVIEW_TOKEN_TTL_SECONDS = 15 * 60;

export interface PreviewTokenClaims {
  /** The preview id (subdomain label) this token authorizes. */
  previewId: string;
  /** The owning user. Asserted === registry row.userId on every request. */
  userId: string;
}

interface StoredCode extends PreviewTokenClaims {
  /** Unix epoch seconds when the code expires. */
  exp: number;
}

// Module-scoped, in-process one-time-code store. Single-use: redemption
// deletes the entry. Lazily swept on each access so an abandoned code
// can't linger.
const codeStore = new Map<string, StoredCode>();

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

/** Drop every expired code. Cheap O(n) sweep run on mint + redeem so the
 *  map never accumulates dead entries even without a background timer. */
function sweepExpiredCodes(now: number = nowSeconds()): void {
  for (const [code, stored] of codeStore) {
    if (stored.exp <= now) codeStore.delete(code);
  }
}

/**
 * Mint an opaque one-time code that maps to `{previewId, userId}` for a
 * short window. The code is 256 bits of CSPRNG hex — unguessable + single
 * use. The CALLER must already have authenticated the user (this is
 * invoked from the app origin's authed `POST /api/preview/:id/token`).
 */
export function mintOneTimeCode(claims: PreviewTokenClaims): string {
  const now = nowSeconds();
  sweepExpiredCodes(now);
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const code = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  codeStore.set(code, {
    previewId: claims.previewId,
    userId: claims.userId,
    exp: now + ONE_TIME_CODE_TTL_SECONDS,
  });
  return code;
}

/**
 * Redeem a one-time code. Returns the claims and DELETES the code
 * (single-use) on success. Returns null when the code is unknown,
 * already redeemed, or expired. A replayed code therefore fails closed.
 */
export function redeemOneTimeCode(code: string): PreviewTokenClaims | null {
  if (!code) return null;
  const now = nowSeconds();
  sweepExpiredCodes(now);
  const stored = codeStore.get(code);
  if (!stored) return null;
  // Single-use: remove regardless of expiry so a replay can never hit.
  codeStore.delete(code);
  if (stored.exp <= now) return null;
  return { previewId: stored.previewId, userId: stored.userId };
}

/** Test-only: clear the one-time-code store. */
export function _resetCodeStoreForTests(): void {
  codeStore.clear();
}

/**
 * Sign the `__ezpreview` JWT (HS256, same instance secret as the session
 * JWT). Reuses `signJWT` so there is ONE signing implementation — the
 * preview claims ride alongside a minimal AuthUser-shaped payload (the
 * preview proxy only ever reads `previewId` + `userId`).
 */
export async function signPreviewToken(
  claims: PreviewTokenClaims,
  secret?: string,
  ttlSeconds: number = PREVIEW_TOKEN_TTL_SECONDS,
): Promise<string> {
  const key = secret ?? (await getJwtSecret());
  // signJWT spreads the payload into the JWT body; the extra preview
  // fields survive verbatim. The AuthUser fields are placeholders — the
  // proxy never trusts them, only `previewId`/`userId`.
  const payload = {
    id: claims.userId,
    email: "",
    name: "",
    role: "member" as const,
    previewId: claims.previewId,
    userId: claims.userId,
  };
  return signJWT(payload, key, ttlSeconds);
}

/**
 * Verify a `__ezpreview` JWT. Returns the preview claims when the
 * signature is valid AND the token is unexpired (expiry is enforced
 * inside `verifyJWT`), otherwise null. Also rejects a structurally-valid
 * token that is missing the preview claims (e.g. a stray session JWT).
 */
export async function verifyPreviewToken(
  token: string,
  secret?: string,
): Promise<PreviewTokenClaims | null> {
  if (!token) return null;
  const key = secret ?? (await getJwtSecret());
  const payload = await verifyJWT(token, key);
  if (!payload) return null;
  const previewId = (payload as Record<string, unknown>).previewId;
  const userId = (payload as Record<string, unknown>).userId;
  if (typeof previewId !== "string" || typeof userId !== "string") return null;
  if (!previewId || !userId) return null;
  return { previewId, userId };
}
