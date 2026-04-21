/**
 * Routes a `Bearer` token to the correct verifier (internal vs user-issued)
 * and, on success, mutates the event's `locals` so downstream handlers see
 * an authenticated principal. Extracted from `hooks.server.ts` so the
 * routing logic can be unit-tested in isolation.
 */

import type { ApiKeyScope } from "$lib/server/security/api-keys";
import { verifyApiKey } from "$lib/server/security/api-keys";
import {
  INTERNAL_KEY_PREFIX,
  verifyInternalKey,
} from "$lib/server/security/internal-auth";
import { getUserById } from "$server/db/queries/users";
import { logger } from "$server/logger";

const log = logger.child("bearer-auth");

/** HTTP header an internal-auth (bundled-extension) caller uses to indicate
 *  the human user whose session triggered the call. The server trusts this
 *  header ONLY when the caller has already authenticated as a system
 *  principal AND is on loopback. LLM-visible tool args can NOT reach this
 *  header — it's set by the executor via a `_meta.ezOnBehalfOf` side
 *  channel in the subprocess JSON-RPC request (see ToolExecutor + ai-kit's
 *  MCP server for the full propagation chain). */
export const ON_BEHALF_OF_HEADER = "X-Ezcorp-On-Behalf-Of";

export interface BearerAuthEvent {
  locals: {
    user?: { id: string; email: string; name: string; role: string };
    apiKeyScopes?: ApiKeyScope[];
  };
  /** Remote IP as reported by the adapter; SvelteKit's `getClientAddress()`
   *  on the Bun adapter returns the direct socket peer. Critically: when
   *  the server sits behind a reverse proxy (nginx, Caddy, Traefik), this
   *  is ALWAYS the loopback address because the proxy terminates the
   *  connection. That's why the caller must also pass
   *  `proxyForwardedHeadersPresent` — if any hop added forwarding headers
   *  we cannot treat the peer as a trusted loopback subprocess. */
  remoteAddress: string | undefined;
  /** True if ANY proxy-forwarded header was observed on the request
   *  (x-forwarded-for, x-real-ip, forwarded). Set by hooks.server.ts at
   *  the top of the auth pipeline; derived, not user-supplied. */
  proxyForwardedHeadersPresent?: boolean;
  /** Value of the X-Ezcorp-On-Behalf-Of header, if present. Only honored
   *  when the Authorization header carries an internal-auth token — see
   *  attachBearerAuth for the gating rules. */
  onBehalfOfHeader?: string | null;
}

/** Attempts to authenticate a request by its `Authorization: Bearer …`
 *  header. No-ops when the header is missing, malformed, or points at a
 *  key that doesn't verify. Returns `true` when `event.locals.user` was
 *  populated by this call — the caller uses the flag only for diagnostics
 *  today, but exposing it makes testing the routing decisions trivial. */
export async function attachBearerAuth(
  event: BearerAuthEvent,
  authHeader: string | null | undefined,
): Promise<boolean> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) return false;
  const raw = authHeader.slice(7);

  // Internal, bundled-extension keys route exclusively through
  // verifyInternalKey. On prefix-match we NEVER fall through to
  // verifyApiKey even if verification fails, because:
  //   - a non-loopback request carrying an internal-prefixed token must
  //     be indistinguishable from an unauth'd request (no DB probe, no
  //     timing signal about whether the prefix is special);
  //   - an internal key that fails verification is a client-side bug or
  //     an attack — we don't want it accidentally matching against the
  //     user-key hash table.
  if (raw.startsWith(INTERNAL_KEY_PREFIX)) {
    // Reverse-proxy defense: if ANY forwarding header was present on the
    // request, the peer address cannot be trusted as "truly local" —
    // nginx/Caddy/Traefik all terminate the remote connection and
    // reopen to 127.0.0.1, which would otherwise let a public-internet
    // attacker present an `ezkint_*` token and pass the loopback gate.
    // A genuine bundled-subprocess call loops back directly without any
    // HTTP proxy, so this header set is ALWAYS empty — rejecting on any
    // presence is fail-closed.
    if (event.proxyForwardedHeadersPresent) return false;
    const principal = verifyInternalKey(raw, event.remoteAddress);
    if (!principal) return false;

    // On-behalf-of override: the internal-auth principal (e.g. `sys-ai-kit`)
    // can request that a call execute AS a different, real user — but only
    // if every check below passes:
    //   1. The X-Ezcorp-On-Behalf-Of header is present.
    //   2. The header value is a non-empty string.
    //   3. It does NOT itself start with `sys-` (no chaining; only human
    //      users are targetable, so a compromised extension can't pivot
    //      across other system identities).
    //   4. A user row with that id exists in the DB (validates the target
    //      and keeps the conversations.user_id FK happy).
    //   5. The loopback check already ran inside verifyInternalKey; an
    //      external request can't even reach this branch.
    // On any failure, we fall back to the system principal's own userId —
    // the call still authenticates, but anything it writes is owned by
    // `sys-*`, preserving the invariant that unauthorized impersonation
    // attempts are a no-op rather than a privilege escalation.
    let effectiveUserId = principal.userId;
    let effectiveName = principal.name;
    // Trim first so a whitespace-only header is treated as absent — the
    // raw header comes straight from an HTTP request and could contain
    // stray whitespace from a proxy/rewrite.
    const obo = typeof event.onBehalfOfHeader === "string"
      ? event.onBehalfOfHeader.trim()
      : "";
    if (obo.length > 0 && !obo.startsWith("sys-")) {
      try {
        const target = await getUserById(obo);
        // Reject inactive (soft-banned) users — an admin who disabled a
        // user MUST continue to keep them out, even when a bundled
        // extension's call presents their id as an OBO target. A live
        // row with status !== "active" is treated as "no such user".
        if (target && target.status === "active") {
          effectiveUserId = target.id;
          // Keep the audit breadcrumb: the principal name records BOTH the
          // originating system identity AND the user being acted for.
          effectiveName = `${principal.name} on-behalf-of ${target.id}`;
          // Structured audit entry at the moment of elevation. No raw
          // key material is logged — only the metadata an operator
          // would need during incident response: which extension, which
          // target user, which keyId, and that it came from loopback
          // (implicit, since verifyInternalKey already gated that).
          log.info("internal-auth: on-behalf-of elevation", {
            extensionName: principal.extensionName,
            keyId: principal.keyId,
            targetUserId: target.id,
          });
        }
      } catch {
        // DB not available (shouldn't happen post-boot, but be defensive):
        // fall back to the system principal. No 401 — an internal call
        // that the server can't validate against the user table simply
        // runs as itself, which is safe.
      }
    }

    event.locals.user = {
      id: effectiveUserId,
      email: "",
      name: effectiveName,
      role: "member",
    };
    event.locals.apiKeyScopes = [...principal.scopes];
    return true;
  }

  try {
    const keyData = await verifyApiKey(raw);
    if (!keyData) return false;
    event.locals.user = {
      id: keyData.userId,
      email: "",
      name: keyData.name,
      role: "member",
    };
    event.locals.apiKeyScopes = keyData.scopes;
    return true;
  } catch {
    // DB not available (e.g., PI_SKIP_INIT for unit tests) — fall through.
    return false;
  }
}
