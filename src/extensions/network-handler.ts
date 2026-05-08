/**
 * Host-side `ezcorp/network.internal` reverse-RPC handler.
 *
 * The in-sandbox fetch wrapper (sandbox-preload.ts) routes requests to
 * `localhost`, RFC-1918, link-local, and other internal hosts here so
 * the host PDP can SSRF-gate them. The wrapper itself can't enforce on
 * internal hosts — its env-var allowlist is for external hosts; an
 * extension that smuggles `localhost:5432` past the wrapper would
 * otherwise reach the host's Postgres.
 *
 * Phase 2 contract:
 *   - PDP gate via `engine.authorize` with a `network` capability whose
 *     `value` is the lowercased hostname. Manifests must declare the
 *     specific internal host (e.g. `localhost`) to reach it.
 *   - Host performs the fetch. The body is base64-encoded, capped at
 *     10MB. Headers are flattened to `Record<string,string>`. Streaming
 *     is Phase 3 (chunked-frame transport in json-rpc.ts).
 *   - Errors are returned as JSON-RPC error envelopes with stable codes:
 *       -32602  invalid params (missing/invalid url)
 *       -32001  permission denied (PDP returned `deny`)
 *       -32000  upstream / size-cap / unexpected
 */

import type { JsonRpcRequest, JsonRpcResponse } from "./types";
import type { PermissionEngine } from "./permission-engine";
import type { ExtensionRegistry } from "./registry";

const INTERNAL_HOSTS = new Set(["localhost", "::1"]);
const RFC1918_RANGES: RegExp[] = [
  /^127\./, // loopback IPv4 (matches all of 127.0.0.0/8)
  /^10\./,
  /^192\.168\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^169\.254\./, // link-local IPv4
  /^fc00:/i,
  /^fd00:/i, // unique local IPv6
  /^fe80:/i, // link-local IPv6
];

const TEN_MB = 10 * 1024 * 1024;

export interface NetworkInternalContext {
  extensionId: string;
  conversationId: string;
  userId: string;
  engine: PermissionEngine;
  registry: ExtensionRegistry;
}

/**
 * Test-only seam: the test file injects a stub fetch so we don't have
 * to spin a real localhost server for every assertion. Production
 * leaves this `undefined` and the handler uses the global `fetch`.
 */
export interface NetworkInternalDeps {
  fetchImpl?: typeof fetch;
}

interface InternalRpcParams {
  url?: unknown;
  init?: {
    method?: unknown;
    headers?: unknown;
    body?: unknown;
  };
}

interface InternalRpcResult {
  status: number;
  statusText: string;
  headers: Record<string, string>;
  body: string;
}

export async function handleNetworkInternalRpc(
  req: JsonRpcRequest,
  ctx: NetworkInternalContext,
  deps: NetworkInternalDeps = {},
): Promise<JsonRpcResponse> {
  const params = (req.params ?? {}) as InternalRpcParams;

  if (typeof params.url !== "string") {
    return jsonRpcError(req.id, -32602, "Missing url");
  }

  let parsed: URL;
  try {
    parsed = new URL(params.url);
  } catch {
    return jsonRpcError(req.id, -32602, "Invalid url");
  }

  // PDP gate. The wrapper-level call is currently `toolName: undefined`
  // (Phase 4 may revisit to attribute by tool). The engine reads the
  // extension's manifest network grant via `getGrantedPermissions`.
  const decision = await ctx.engine.authorize(
    {
      extensionId: ctx.extensionId,
      userId: ctx.userId,
      conversationId: ctx.conversationId,
    },
    [{ kind: "network", value: parsed.hostname.toLowerCase() }],
  );

  if (decision.decision === "deny") {
    return jsonRpcError(
      req.id,
      -32001,
      `Network denied: ${decision.reason}`,
    );
  }

  // Perform fetch host-side.
  const fetchImpl = deps.fetchImpl ?? fetch;
  let resp: Response;
  try {
    resp = await fetchImpl(params.url, normalizeInit(params.init));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRpcError(req.id, -32000, `Upstream error: ${msg}`);
  }

  // Read body up to the size cap. We materialize the full ArrayBuffer
  // here — Phase 3 will replace this with a chunked-frame transport so
  // a 10MB ceiling isn't a hard ceiling on response size.
  let buf: ArrayBuffer;
  try {
    buf = await resp.arrayBuffer();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return jsonRpcError(req.id, -32000, `Body read error: ${msg}`);
  }

  if (buf.byteLength > TEN_MB) {
    return jsonRpcError(
      req.id,
      -32000,
      "Response exceeds 10MB internal-fetch cap",
    );
  }

  const headers: Record<string, string> = {};
  resp.headers.forEach((v, k) => {
    headers[k] = v;
  });

  const result: InternalRpcResult = {
    status: resp.status,
    statusText: resp.statusText,
    headers,
    body: Buffer.from(buf).toString("base64"),
  };

  return { jsonrpc: "2.0", id: req.id, result };
}

/**
 * `isInternalHost(host)` — host-side classification mirror of the
 * sandbox's `INTERNAL_HOST_RE` (network-wrapper.ts). Used for sanity
 * checks (e.g. an extension calling `ezcorp/network.internal` for a
 * public host should be rejected — only the wrapper should route via
 * this RPC, and only for internal hosts).
 *
 * Phase 2 doesn't yet enforce that — the PDP gate alone is enough.
 * Exposed for tests + future enforcement.
 */
export function isInternalHost(hostname: string): boolean {
  const h = hostname.toLowerCase();
  if (INTERNAL_HOSTS.has(h)) return true;
  return RFC1918_RANGES.some((re) => re.test(h));
}

// ── Helpers ──────────────────────────────────────────────────────

function jsonRpcError(
  id: JsonRpcRequest["id"],
  code: number,
  message: string,
): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

/**
 * The wrapper sends a JSON-RPC-friendly `init` shape (string method,
 * plain-record headers, string body). Translate to a `RequestInit`
 * the host's `fetch` accepts. Anything we don't recognize is dropped.
 */
function normalizeInit(init: InternalRpcParams["init"]): RequestInit | undefined {
  if (!init || typeof init !== "object") return undefined;
  const out: RequestInit = {};
  if (typeof init.method === "string") out.method = init.method;
  if (init.headers && typeof init.headers === "object" && !Array.isArray(init.headers)) {
    out.headers = init.headers as Record<string, string>;
  }
  if (typeof init.body === "string") out.body = init.body;
  return out;
}
