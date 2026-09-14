import { readFile } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { IncomingHttpHeaders } from "node:http";

const DEFAULT_PRIVATE_HTTP_LIMIT = 64 * 1024;

export interface GatewayTlsSecretPaths {
  readonly caPath: string;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly serviceTokenPath: string;
}

export interface GatewayTransportOptions {
  readonly baseUrl: string;
  readonly tls: GatewayTlsSecretPaths;
  readonly serverName?: string;
  readonly requestTimeoutMs?: number;
}

export interface GatewayResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

export interface GatewayTransport {
  request(method: "GET" | "POST" | "PUT", path: string, body?: unknown, responseLimit?: number, signal?: AbortSignal): Promise<GatewayResponse>;
}

function encoded(value: unknown, limit: number): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.byteLength > limit) throw new Error(`factory gateway request exceeds ${limit} bytes`);
  return body;
}

/**
 * A non-2xx reply from a private gateway. Every non-2xx still throws, so the
 * transport stays fail-closed; the reply is carried on the error so a caller
 * that documents a rejection status can decode its body instead of losing it.
 * C03 answers a full admission queue with HTTP 429 and an admission decision.
 */
export class GatewayStatusError extends Error {
  // An explicit field, not a constructor parameter property: `node --test
  // --experimental-strip-types` runs this file and cannot strip one.
  readonly response: GatewayResponse;

  constructor(response: GatewayResponse) {
    super(`factory gateway returned HTTP ${response.statusCode}`);
    this.name = "GatewayStatusError";
    this.response = response;
  }
}

function requireSuccess(response: GatewayResponse): GatewayResponse {
  if (response.statusCode < 200 || response.statusCode >= 300) throw new GatewayStatusError(response);
  return response;
}

function createTransport(
  endpoint: URL,
  credentials: { ca: Buffer; certificate: Buffer; privateKey: Buffer; token: string },
  serverName: string,
  timeoutMs: number,
): GatewayTransport {
  return {
    request(method, path, value, responseLimit = DEFAULT_PRIVATE_HTTP_LIMIT, signal) {
      const body = value as Buffer | undefined;
      return new Promise((resolve, reject) => {
        const url = new URL(path, endpoint);
        const options: RequestOptions = {
          method,
          ca: credentials.ca,
          cert: credentials.certificate,
          key: credentials.privateKey,
          rejectUnauthorized: true,
          servername: serverName,
          ...(signal ? { signal } : {}),
          headers: {
            accept: "application/json",
            authorization: `Bearer ${credentials.token}`,
            "content-type": "application/json",
            "content-length": body?.byteLength ?? 0,
            "x-ezcorp-factory-version": "1",
          },
        };
        const request = httpsRequest(url, options, (response) => {
          const chunks: Buffer[] = [];
          let received = 0;
          response.on("data", (chunk: Buffer) => {
            received += chunk.byteLength;
            if (received > responseLimit) response.destroy(new Error(`factory gateway response exceeds ${responseLimit} bytes`));
            else chunks.push(chunk);
          });
          response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
          response.on("error", reject);
        });
        const deadline = setTimeout(() => request.destroy(new Error("factory gateway request timed out")), timeoutMs);
        request.once("close", () => clearTimeout(deadline));
        request.on("error", reject);
        if (body) request.write(body);
        request.end();
      });
    },
  };
}

async function loadCredentials(paths: GatewayTlsSecretPaths): Promise<{ ca: Buffer; certificate: Buffer; privateKey: Buffer; token: string }> {
  const [ca, certificate, privateKey, tokenBytes] = await Promise.all([
    readFile(paths.caPath), readFile(paths.certificatePath), readFile(paths.privateKeyPath), readFile(paths.serviceTokenPath),
  ]);
  const token = tokenBytes.toString("utf8").trim();
  if (!token) throw new Error("factory gateway service token is empty");
  return { ca, certificate, privateKey, token };
}

/** Shared private HTTPS client. It reloads every credential before each request. */
export async function createGatewayTransport(options: GatewayTransportOptions): Promise<GatewayTransport> {
  const snapshot = Object.freeze({ ...options, tls: Object.freeze({ ...options.tls }) });
  const endpoint = new URL(snapshot.baseUrl);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error("factory gateway requires a plain private HTTPS origin");
  const timeoutMs = snapshot.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("factory gateway timeout is invalid");
  await loadCredentials(snapshot.tls);
  return Object.freeze({
    async request(method, path, body, responseLimit = DEFAULT_PRIVATE_HTTP_LIMIT, signal): Promise<GatewayResponse> {
      if (typeof path !== "string" || !path.startsWith("/") || path.startsWith("//") || path.includes("\\") || path.includes("#") || [...path].some(character => character.charCodeAt(0) <= 32)) throw new Error("factory gateway request path is invalid");
      const target = new URL(path, endpoint);
      if (target.origin !== endpoint.origin) throw new Error("factory gateway request path is invalid");
      if (!Number.isSafeInteger(responseLimit) || responseLimit < 1 || responseLimit > 16 * 1024 * 1024) throw new Error("factory gateway byte limit is invalid");
      // Capture the caller's body before loading credentials or yielding.
      const requestBody = body === undefined ? undefined : encoded(body, responseLimit);
      signal?.throwIfAborted();
      const credentials = await loadCredentials(snapshot.tls);
      const transport = createTransport(endpoint, credentials, snapshot.serverName ?? endpoint.hostname, timeoutMs);
      return requireSuccess(await transport.request(method, path, requestBody, responseLimit, signal));
    },
  } satisfies GatewayTransport);
}
