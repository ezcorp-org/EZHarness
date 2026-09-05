import { isIP } from "node:net";
import { guardedFetch, type GuardedFetchOptions } from "../search/egress";
import type { RpcHandlerDeps } from "./tool-executor/rpc-handlers";
import type { JsonRpcRequest, JsonRpcResponse } from "./types";
import { resolveReverseRpcMeta } from "./tool-executor/provenance";
import { BrokerError as LifecycleError, injectCredentialHeaders } from "./credential-broker";

const CHUNK_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024;
const bodies = new Map<string, { token: string; extensionId: string; bytes: Uint8Array; expires: number; nextOffset: number }>();
let bufferedBytes = 0;
let reservedBytes = 0;

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
  let reserved = false;
  let dispatchedMutation = false;
  try {
    if (resolved.prov.actorExtensionId !== extensionId) throw new LifecycleError("invalid_token", "Invocation belongs to another extension.");
    clearExpiredNetworkBodies();
    const input = request.params as Record<string, unknown> | undefined;
    const token = (input?._meta as Record<string, unknown> | undefined)?.ezCallId;
    if (typeof token !== "string") throw new LifecycleError("invalid_token", "A current call token is required.");
    if (request.method === "ezcorp/network.read") {
      const body = typeof input?.bodyId === "string" ? bodies.get(input.bodyId) : undefined;
      if (!body || body.token !== token || body.extensionId !== extensionId) throw new LifecycleError("body_unavailable", "Response body is unavailable in this invocation.");
      const offset = input?.offset;
      if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset !== body.nextOffset || offset >= body.bytes.byteLength) throw new LifecycleError("invalid_offset", "Use the next response chunk offset.");
      const chunk = body.bytes.subarray(offset, offset + CHUNK_BYTES);
      const done = offset + chunk.byteLength === body.bytes.byteLength;
      body.nextOffset += chunk.byteLength;
      if (done) removeBody(input!.bodyId as string);
      return { jsonrpc: "2.0", id: request.id, result: { body: Buffer.from(chunk).toString("base64"), done } };
    }
    if (request.method !== "ezcorp/network.fetch") throw new LifecycleError("unknown_method", "Unknown network operation.");
    if (typeof input?.url !== "string" || input.url.length > 8192) throw new LifecycleError("invalid_url", "Provide a bounded HTTP URL.");
    const url = new URL(input.url);
    if (url.username || url.password || url.hash) throw new LifecycleError("invalid_url", "URL credentials and fragments are not allowed.");
    const init = input.init as { method?: unknown; headers?: unknown; body?: unknown } | undefined;
    const method = init?.method ?? "GET";
    if (typeof method !== "string" || !["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"].includes(method)) throw new LifecycleError("invalid_method", "Unsupported HTTP method.");
    if (init?.headers !== undefined && (!init.headers || typeof init.headers !== "object" || Array.isArray(init.headers) || Object.values(init.headers).some((value) => typeof value !== "string"))) throw new LifecycleError("invalid_headers", "Headers must be text pairs.");
    const headers = new Headers(init?.headers as Record<string, string> | undefined);
    for (const key of headers.keys()) if (["host", "connection", "proxy-authorization", "proxy-authenticate", "proxy-connection", "transfer-encoding", "content-length", "upgrade", "te", "trailer", "keep-alive"].includes(key)) throw new LifecycleError("invalid_headers", "Transport headers cannot be supplied by extensions.");
    if (init?.body !== undefined && (typeof init.body !== "string" || init.body.length > 700000 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(init.body))) throw new LifecycleError("invalid_body", "Request body must be bounded base64.");
    const internalOrigins: unknown = JSON.parse(process.env.EZCORP_EXTENSION_INTERNAL_ORIGINS ?? "[]");
    if (!Array.isArray(internalOrigins) || internalOrigins.some((origin) => typeof origin !== "string" || !isIP(new URL(origin).hostname.replace(/^\[|\]$/g, "")) || new URL(origin).origin !== origin)) throw new LifecycleError("invalid_configuration", "Internal origins must use exact origins with explicit IP addresses.");
    const internal = internalOrigins.includes(url.origin);
    const validatePort = (target: URL) => { if (target.port && target.port !== (target.protocol === "https:" ? "443" : "80") && !internalOrigins.includes(target.origin)) throw new LifecycleError("port_denied", "Nonstandard ports require an exact configured origin."); };
    validatePort(url);
    const sensitiveHeaders = [...headers.keys()].some(name => !["accept", "accept-language", "user-agent", "content-type"].includes(name));
    if (bufferedBytes + reservedBytes + MAX_BODY_BYTES > MAX_BUFFERED_BYTES) throw new LifecycleError("response_capacity", "Network response capacity is full. Retry after active calls finish.");
    reservedBytes += MAX_BODY_BYTES;
    reserved = true;
    const credentialHeaders = await injectCredentialHeaders(deps, extensionId, request, url, headers);
    const response = await guardedFetch(url.toString(), { method, headers: credentialHeaders, ...(init?.body === undefined ? {} : { body: Buffer.from(init.body as string, "base64") }) }, {
      ...options, mode: internal ? "backend" : "read", allowedHosts: internal ? [url.hostname] : undefined, maxBodyBytes: MAX_BODY_BYTES, timeoutMs: 60000, retryConnectionFailures: ["GET", "HEAD", "OPTIONS"].includes(method), maxRedirects: ["GET", "HEAD", "OPTIONS"].includes(method) ? 3 : 0,
      fetchImpl: async (target, init) => { dispatchedMutation = !["GET", "HEAD", "OPTIONS"].includes(method); return (options.fetchImpl ?? globalThis.fetch)(target, init); },
      authorizeUrl: async (target) => {
        validatePort(target);
        if (target.username || target.password || target.origin !== url.origin && sensitiveHeaders || internal && target.origin !== url.origin) throw new LifecycleError("redirect_denied", "Credentialed or internal requests cannot redirect to another origin.");
        await injectCredentialHeaders(deps, extensionId, request, target, headers);
        const decision = await deps.engine.authorize({ extensionId, userId: resolved.onBehalfOf, conversationId: resolved.conversationId, toolName: "network.fetch" }, [{ kind: "network", value: target.hostname.replace(/^\[|\]$/g, "").toLowerCase() }]);
        if (decision.decision !== "allow") throw new LifecycleError("network_denied", "Network access was not approved for this host.");
      },
    });
    const bytes = new Uint8Array(await response.arrayBuffer());
    const protectedCredential = headers.get("authorization")?.startsWith("Bearer ezcred_v4_") ? credentialHeaders.get("authorization")?.slice("Bearer ".length) : undefined;
    if (protectedCredential && (Buffer.from(bytes).includes(Buffer.from(protectedCredential)) || [...response.headers.values()].some(value => value.includes(protectedCredential)))) throw new LifecycleError("credential_response", "Provider response contained protected credential material.");
    const metadata = { status: response.status, statusText: response.statusText, headers: Object.fromEntries(response.headers.entries()) };
    if (bytes.byteLength <= CHUNK_BYTES) return { jsonrpc: "2.0", id: request.id, result: { ...metadata, body: Buffer.from(bytes).toString("base64") } };
    if (bufferedBytes + bytes.byteLength > MAX_BUFFERED_BYTES) throw new LifecycleError("response_capacity", "Network response capacity is full. Retry after active calls finish.");
    const bodyId = crypto.randomUUID();
    bodies.set(bodyId, { token, extensionId, bytes, expires: Date.now() + 60000, nextOffset: 0 });
    bufferedBytes += bytes.byteLength;
    setTimeout(() => removeBody(bodyId), 60000).unref();
    return { jsonrpc: "2.0", id: request.id, result: { ...metadata, bodyId, bodyBytes: bytes.byteLength } };
  } catch (cause) {
    if (dispatchedMutation) return { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: "outcome_unknown: The request may have reached the provider. Do not automatically retry.", data: { code: "outcome_unknown", retryable: false } } };
    return { jsonrpc: "2.0", id: request.id, error: { code: -32603, message: cause instanceof LifecycleError ? cause.message : "Network request failed or was blocked by host policy." } };
  } finally {
    if (reserved) reservedBytes -= MAX_BODY_BYTES;
  }
}
