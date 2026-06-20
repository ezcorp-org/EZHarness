/**
 * Web-side test/determinism surface helpers.
 *
 * The core gate predicate lives in `src/test-surface.ts` (backend, shared
 * with the provider layer) and is re-exported here so web routes import it
 * from one place. This module adds the loopback auth-bypass used by
 * `hooks.server.ts`, which needs web-side loopback detection.
 */
import { isLoopbackAddress } from "./security/internal-auth";

export { isTestSurfaceEnabled, MOCK_PROVIDER, mockLlmBaseUrl } from "$server/test-surface";
import { isTestSurfaceEnabled } from "$server/test-surface";

/**
 * Path prefixes reachable WITHOUT session/bearer auth — but ONLY when the
 * test surface is enabled AND the request is genuine loopback with no
 * proxy-forwarding headers. The mock-LLM completions endpoint is the sole
 * member: it is called server-internally by pi-ai's HTTP client (from
 * inside this same process) with a dummy bearer token, so it can't satisfy
 * normal auth. The `/script` seed sub-path is deliberately NOT here — it is
 * called by the external harness and must go through normal API-key auth.
 */
export const LOOPBACK_TEST_BYPASS_PREFIXES = ["/api/__test/mock-llm/v1"] as const;

export function isLoopbackTestBypass(
  pathname: string,
  remoteAddress: string | undefined,
  proxyForwardedHeadersPresent: boolean,
): boolean {
  if (!isTestSurfaceEnabled()) return false;
  // A proxied request's socket peer is not a trustworthy loopback signal.
  if (proxyForwardedHeadersPresent) return false;
  // Fail CLOSED on an unknown peer. `isLoopbackAddress` treats an
  // empty/undefined address as loopback (a Unix-domain-socket signal that
  // internal-auth pairs with a secret key), but this bypass grants
  // UNAUTHENTICATED access, so an indeterminate peer must NOT pass.
  if (!remoteAddress) return false;
  if (!isLoopbackAddress(remoteAddress)) return false;
  return LOOPBACK_TEST_BYPASS_PREFIXES.some(
    (p) => pathname === p || pathname.startsWith(p + "/"),
  );
}
