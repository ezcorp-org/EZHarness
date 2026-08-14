/**
 * The `fetch` every MCP network transport is given, so the target guard
 * survives an HTTP redirect.
 *
 * ## The hole this closes
 *
 * Validating the configured URL once at connect time is NOT enough. The MCP
 * SDK owns the socket, and its `fetch` used default (`follow`) redirect
 * semantics, so a server we were allowed to reach could simply answer:
 *
 *     307 Location: http://169.254.169.254/latest/meta-data/…
 *
 * and the platform dialed it. Reproduced against a real local server on both
 * transports: with `302` the method downgrades to GET and the request still
 * lands on the blocked address; with `307` the method and body are preserved
 * and a FULL bidirectional MCP session runs against it — the internal
 * server's `tools/list` flows back into the platform, and therefore into the
 * LLM turn. The attacker is the operator of any configured remote MCP
 * server, i.e. exactly the party the guard exists to distrust. It also
 * re-opened the port-scan oracle, through redirect-target timing.
 *
 * So: `redirect: "manual"`, and `assertMcpTargetUrlAllowed` runs again on
 * every `Location` hop, with a hop cap.
 *
 * ## Why this is not a third copy of the guard
 *
 * The address POLICY is not reimplemented — every hop goes through
 * `assertMcpTargetUrlAllowed`, which is the same `isBlockedIp` block-list
 * from `src/search/egress.ts` that the rest of the repo uses.
 *
 * What is NOT reused is `guardedFetch`'s transfer loop, for two concrete
 * reasons:
 *
 *   1. **It buffers the whole body.** `enforceBodyCap` reads the response to
 *      completion before returning. An MCP `text/event-stream` is a
 *      long-lived stream that never completes, so routing MCP through it
 *      would hang the connection forever rather than secure it.
 *   2. **It IP-pins by rewriting the URL host.** That is right for the
 *      search reader, but it breaks TLS SNI for a vendor MCP endpoint on
 *      https.
 *
 * This wrapper therefore re-validates and streams: the terminal `Response`
 * is handed back untouched, body unread.
 *
 * ## Cross-origin credential stripping
 *
 * An MCP spec carries auth headers (`Authorization: Bearer …`). Following a
 * redirect to a different origin with those headers attached would hand the
 * vendor's token to whatever host the vendor names. Browsers strip
 * credentials on a cross-origin redirect; so do we.
 */

import {
  assertMcpTargetUrlAllowed,
  McpTargetBlockedError,
  type McpTargetGuardDeps,
} from "./target-guard";

/**
 * Maximum `Location` hops followed before the request is refused.
 *
 * Matches `guardedFetch`'s `DEFAULT_MAX_REDIRECTS`. Real MCP endpoints
 * redirect at most once or twice (http→https, or a path canonicalization).
 */
export const MCP_MAX_REDIRECTS = 3;

/** Headers dropped when a redirect crosses to a different origin. */
const CREDENTIAL_HEADERS = ["authorization", "cookie", "proxy-authorization"];

/** Status codes that carry a `Location` we should follow. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

/** The URL string from whatever shape the SDK passed as `input`. */
function urlFromInput(input: URL | RequestInfo): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/**
 * Apply the standard method/body downgrade. `301`/`302`/`303` turn a
 * non-HEAD request into a GET and drop the body; `307`/`308` preserve both.
 * Mirroring the platform semantics keeps a legitimate redirect working —
 * the security property is the re-validation, not the downgrade.
 */
function applyRedirectSemantics(init: RequestInit, status: number): RequestInit {
  if (status === 307 || status === 308) return init;
  const method = (init.method ?? "GET").toUpperCase();
  if (method === "HEAD") return init;
  const next: RequestInit = { ...init, method: "GET" };
  delete next.body;
  return next;
}

/** Strip credential headers when the hop changes origin. */
function stripCredentialsIfCrossOrigin(
  init: RequestInit,
  fromUrl: string,
  toUrl: string,
): RequestInit {
  if (new URL(fromUrl).origin === new URL(toUrl).origin) return init;
  const headers = new Headers(init.headers ?? {});
  for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  return { ...init, headers };
}

export interface McpGuardedFetchDeps extends McpTargetGuardDeps {
  /** Injected transport, so tests drive redirect chains without a socket.
   *  Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Build the `fetch` handed to `StreamableHTTPClientTransport` /
 * `SSEClientTransport` via their `opts.fetch` seam. Both transports route
 * EVERY request through it — the streamable POST/GET/DELETE, the SSE stream,
 * and the SSE endpoint POST — so this is the complete network surface of an
 * MCP network transport.
 *
 * Validating here rather than only in `connect()` also makes the check
 * per-REQUEST: a hostname rebound to an internal address after the client
 * was constructed is refused on the next request, not merely on the next
 * client.
 */
export function createMcpGuardedFetch(deps: McpGuardedFetchDeps = {}): typeof fetch {
  const { fetchImpl, ...guardDeps } = deps;
  const transport = fetchImpl ?? ((globalThis as { fetch: typeof fetch }).fetch);

  return async function mcpGuardedFetch(
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> {
    let url = urlFromInput(input);
    let currentInit: RequestInit = { ...(init ?? {}) };

    for (let hop = 0; ; hop++) {
      // Runs on hop 0 too, so the very first request is guarded even if the
      // caller never went through `McpClient.connect()`.
      await assertMcpTargetUrlAllowed(url, guardDeps);

      const response = await transport(url, { ...currentInit, redirect: "manual" });

      const location = response.headers.get("location");
      if (!isRedirectStatus(response.status) || location === null) {
        // Terminal response — returned with its body UNREAD so an SSE
        // stream keeps streaming.
        return response;
      }

      if (hop >= MCP_MAX_REDIRECTS) {
        throw new McpTargetBlockedError("redirect-limit", `${MCP_MAX_REDIRECTS} hops`);
      }

      // Relative `Location` values resolve against the CURRENT url, which is
      // also what makes a same-origin path redirect keep working.
      let nextUrl: string;
      try {
        nextUrl = new URL(location, url).href;
      } catch {
        throw new McpTargetBlockedError("malformed-url", "<unparseable redirect>");
      }

      currentInit = stripCredentialsIfCrossOrigin(
        applyRedirectSemantics(currentInit, response.status),
        url,
        nextUrl,
      );
      url = nextUrl;

      // Free the redirect body before the next hop.
      try {
        await response.arrayBuffer();
      } catch {
        // Best-effort drain; a redirect body we cannot read is not fatal.
      }
    }
  };
}
