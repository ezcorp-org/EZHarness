import { isIP } from "node:net";
import { guardedFetch, type GuardedFetchOptions } from "../search/egress";
import type { RpcHandlerDeps } from "./tool-executor/rpc-handlers";
import type { JsonRpcRequest, JsonRpcResponse } from "./types";
import { resolveReverseRpcMeta } from "./tool-executor/provenance";
import { LifecycleError } from "./v4/types";

const CHUNK_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
const bodies = new Map<string, { token: string; extensionId: string; bytes: Uint8Array; expires: number }>();
let bufferedBytes = 0;

function removeBody(id: string): void {
  const value = bodies.get(id);
  if (value) bufferedBytes -= value.bytes.byteLength;
  bodies.delete(id);
}

export function clearExpiredNetworkBodies(now = Date.now()): void {
  for (const [id, value] of bodies) if (value.expires <= now) removeBody(id);
}

export async function handleNetworkBroker(deps: RpcHandlerDeps, extensionId: string, request: JsonRpcRequest, options: Pick<GuardedFetchOptions, "fetchImpl" | "resolveHost"> = {}): Promise<JsonRpcResponse> {
  const resolved = resolveReverseRpcMeta(extensionId, request);
  if (!resolved.ok) return resolved.errorResponse;
  try {
    clearExpiredNetworkBodies();
    const input = request.params as Record<string, unknown> | undefined;
    const token = (input?._meta as Record<string, unknown> | undefined)?.ezCallId;
    if (typeof token !== "string") throw new LifecycleError("invalid_token", "A current call token is required.");
    if (request.method === "ezcorp/network.read") {
      const body = typeof input?.bodyId === "string" ? bodies.get(input.bodyId) : undefined;
      if (!body || body.token !== token || body.extensionId !== extensionId) throw new LifecycleError("body_unavailable", "Response body is unavailable in this invocation.");
      const offset = input?.offset;
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 0 || offset >= body.bytes.byteLength || offset % CHUNK_BYTES !== 0) throw new LifecycleError("invalid_offset", "Use the next response chunk offset.");
      const chunk = body.bytes.subarray(offset, offset + CHUNK_BYTES);
      const done = offset + chunk.byteLength === body.bytes.byteLength;
      if (done) removeBody(input!.bodyId as string);
      return { jsonrpc: "2.0", id: request.id, result: { body: Buffer.from(chunk).toString("base64"), done } };
    }
    if (typeof input?.url !== "string" || input.url.length > 8192) throw new LifecycleError("invalid_url", "Provide a bounded HTTP URL.");
    const url = new URL(input.url);
    if (url.username || url.password || url.hash) throw new LifecycleError("invalid_url", "URL credentials and fragments are not allowed.");
    const init = input.init as { method?: unknown; headers?: unknown; body?: unknown } | undefined;
    const method = init?.method ?? "GET";
    if (typeof method !== "string" || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) throw new LifecycleError("invalid_method", "Unsupported HTTP method.");
    if (init?.headers !== undefined && (!init.headers || typeof init.headers !== "object" || Array.isArray(init.headers) || Object.values(init.headers).some((value) => typeof value !== "string"))) throw new LifecycleError("invalid_headers", "Headers must be text pairs.");
    const headers = new Headers(init?.headers as Record<string, string> | undefined);
    for (const key of headers.keys()) if (["host", "connection", "proxy-authorization", "proxy-connection", "transfer-encoding", "content-length"].includes(key)) throw new LifecycleError("invalid_headers", "Transport headers cannot be supplied by extensions.");
    if (init?.body !== undefined && (typeof init.body !== "string" || init.body.length > 700000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(init.body))) throw new LifecycleError("invalid_body", "Request body must be bounded base64.");
    const internalOrigins: unknown = JSON.parse(process.env.EZCORP_EXTENSION_INTERNAL_ORIGINS ?? "[]");
    if (!Array.isArray(internalOrigins) || internalOrigins.some((origin) => typeof origin !== "string" || !isIP(new URL(origin).hostname.replace(/^\[|\]$/g, "")))) throw new LifecycleError("invalid_configuration", "Internal origins must use explicit IP addresses.");
    const internal = internalOrigins.includes(url.origin);
    const response = await guardedFetch(url.toString(), { method, headers, ...(init?.body === undefined ? {} : { body: Buffer.from(init.body as string, "base64") }) }, {
      ...options, mode: internal ? "backend" : "read", allowedHosts: internal ? [url.hostname] : undefined, maxBodyBytes: MAX_BODY_BYTES, timeoutMs: 60000,
      authorizeUrl: async (target) => {
        if (target.username || target.password || target.origin !== url.origin && (headers.has("authorization") || headers.has("cookie")) || internal && target.origin !== url.origin) throw new LifecycleError("redirect_denied", "Credentialed or internal requests cannot redirect to another origin.");
        const decision = await deps.engine.authorize({ extensionId, userId: resolved.onBehalfOf, conversationId: resolved.conversationId, toolName: "network.fetch" }, [{ kind: "network", value: target.hostname.replace(/^\[|\]$/g, "").toLowerCase() }]);
        if (decision.decision !== "allow") throw new LifecycleError("network_denied", "Network access was not approved for this host.");
      },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const metadata = { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()) };
    if (bytes.byteLength <= CHUNK_BYTES) return { jsonrpc: "2.0", id: request.id, result: { ...metadata, body: Buffer.from(bytes).toString("base64") } };
    if (bufferedBytes + bytes.byteLength > MAX_BUFFERED_BYTES) throw new LifecycleError("response_capacity", "Network response capacity is full. Retry after active calls finish.");
    const bodyId = crypto.randomUUID();
    bodies.set(bodyId, { token, extensionId, bytes, expires: Date.now() + 60000 });
    bufferedBytes += bytes.byteLength;
    setTimeout(() => removeBody(bodyId), 60000).unref();
    return { jsonrpc: "2.0", id: request.id, result: { ...metadata, bodyId, bodyBytes: bytes.byteLength } };
  } catch (cause) {
    return { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: cause instanceof LifecycleError ? cause.message : "Network request failed or was blocked by host policy." } };
  }
}
