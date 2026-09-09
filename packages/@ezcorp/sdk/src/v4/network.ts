import { ContractError, assertJson } from "@ezcorp/extension-contract";
import { getExtensionContext } from "./context";

const CHUNK_BYTES = 256 * 1024;
const MAX_BODY_BYTES = 32 * 1024 * 1024;

function record(value: unknown): Record<string, unknown> {
  assertJson(value);
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractError("INVALID_NETWORK_RESPONSE", "Invalid network broker response");
  return value as Record<string, unknown>;
}

function decode(value: unknown): Uint8Array {
  if (typeof value !== "string" || value.length > Math.ceil(CHUNK_BYTES / 3) * 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) throw new ContractError("INVALID_NETWORK_RESPONSE", "Invalid network body chunk");
  const bytes = Buffer.from(value, "base64");
  if (bytes.byteLength > CHUNK_BYTES) throw new ContractError("DATA_LIMIT", "Network chunk exceeds limit");
  return bytes;
}

export async function brokeredFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const context = getExtensionContext();
  if (!context) throw new ContractError("NO_INVOCATION", "Network access requires an active invocation");
  context.signal.throwIfAborted();
  const request = input instanceof Request ? new Request(input, init) : new Request(String(input), init);
  const signal = AbortSignal.any([request.signal, context.signal]);
  signal.throwIfAborted();
  let body: string | undefined;
  if (request.body) {
    const reader = request.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        signal.throwIfAborted();
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > CHUNK_BYTES) throw new ContractError("DATA_LIMIT", "Network request body exceeds 256 KiB");
        chunks.push(chunk.value);
      }
      body = Buffer.concat(chunks).toString("base64");
    } finally { await reader.cancel(); }
  }
  const response = record(await context.call("ezcorp/network.fetch", { url: request.url, init: { method: request.method, headers: Object.fromEntries(request.headers.entries()), ...(body !== undefined ? { body } : {}) } }));
  signal.throwIfAborted();
  if (!Number.isInteger(response.status) || Number(response.status) < 200 || Number(response.status) > 599 || typeof response.statusText !== "string") throw new ContractError("INVALID_NETWORK_RESPONSE", "Invalid network status");
  const headerData = record(response.headers);
  if (Object.values(headerData).some(value => typeof value !== "string")) throw new ContractError("INVALID_NETWORK_RESPONSE", "Invalid network headers");
  let bytes: Uint8Array;
  if (Object.hasOwn(response, "body")) {
    if (Object.hasOwn(response, "bodyId")) throw new ContractError("INVALID_NETWORK_RESPONSE", "Ambiguous network body");
    bytes = decode(response.body);
  } else {
    if (typeof response.bodyId !== "string" || !response.bodyId || !Number.isSafeInteger(response.bodyBytes) || Number(response.bodyBytes) < 0 || Number(response.bodyBytes) > MAX_BODY_BYTES) throw new ContractError("INVALID_NETWORK_RESPONSE", "Invalid network body handle");
    bytes = new Uint8Array(Number(response.bodyBytes));
    let offset = 0;
    for (;;) {
      signal.throwIfAborted();
      const chunk = record(await context.call("ezcorp/network.read", { bodyId: response.bodyId, offset }));
      const part = decode(chunk.body);
      if (typeof chunk.done !== "boolean" || offset + part.length > bytes.length || (!chunk.done && part.length === 0)) throw new ContractError("INVALID_NETWORK_RESPONSE", "Invalid network stream length");
      bytes.set(part, offset);
      offset += part.length;
      if (chunk.done) {
        if (offset !== bytes.length) throw new ContractError("INVALID_NETWORK_RESPONSE", "Truncated network stream");
        break;
      }
    }
  }
  signal.throwIfAborted();
  const status = Number(response.status);
  return new Response([204, 205, 304].includes(status) ? null : new Uint8Array(bytes).buffer, { status, statusText: response.statusText, headers: headerData as Record<string, string> });
}

export function installNetworkShim(): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = Object.assign(brokeredFetch, { preconnect: () => { throw new ContractError("UNSUPPORTED_NETWORK", "Network preconnect is not supported"); } }) as typeof fetch;
  return () => { globalThis.fetch = previous; };
}
