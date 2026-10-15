import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
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
  serverName: string | undefined,
  timeoutMs: number,
): GatewayTransport {
  return {
    request(method, path, value, responseLimit = DEFAULT_PRIVATE_HTTP_LIMIT, signal) {
      const body = value as Buffer | undefined;
      return new Promise((resolve, reject) => {
        let responded = false;
        const url = new URL(path, endpoint);
        const options: RequestOptions = {
          method,
          ca: credentials.ca,
          cert: credentials.certificate,
          key: credentials.privateKey,
          rejectUnauthorized: true,
          ...(serverName === undefined ? {} : { servername: serverName }),
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
            if (received <= responseLimit) { chunks.push(chunk); return; }
            const error = new Error(`factory gateway response exceeds ${responseLimit} bytes`);
            reject(error);
            response.destroy(error);
          });
          responded = true;
          let ended = false;
          response.once("end", () => { ended = true; });
          response.once("close", () => { if (!ended) reject(new Error("factory gateway response closed before it ended")); });
          response.on("end", () => resolve({ statusCode: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
          response.on("error", reject);
        });
        const deadline = setTimeout(() => {
          const error = new Error("factory gateway request timed out");
          // Settled here, not left to the `error` event: Bun destroys the
          // request and emits only `close`, so a request whose peer never
          // answered would otherwise stay pending forever. Node emits `error`
          // as well, and the second rejection is a no-op.
          reject(error);
          request.destroy(error);
        }, timeoutMs);
        request.once("close", () => clearTimeout(deadline));
        request.on("error", reject);
        // An abort is settled here for the same reason as the deadline: under
        // Bun an aborted request also emits only `close`, and a caller waiting
        // on it would wait for ever.
        const aborted = () => {
          const reason: unknown = signal?.reason;
          return reason instanceof Error ? reason : new Error("factory gateway request aborted");
        };
        const abort = () => {
          const error = aborted();
          reject(error);
          request.destroy(error);
        };
        signal?.addEventListener("abort", abort, { once: true });
        request.once("close", () => {
          signal?.removeEventListener("abort", abort);
          // Bun can close the request without ever emitting `error` — its own
          // abort handling runs first and closes it synchronously — so a close
          // before any response settles the request here.
          if (!responded) reject(signal?.aborted ? aborted() : new Error("factory gateway connection closed before a response"));
        });
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

/**
 * The TLS server name to send: the configured name, else the endpoint host. An IP literal is never sent (RFC 6066;
 * Bun 1.4 and Node refuse it with ERR_INVALID_ARG_VALUE): for the endpoint's own IP, node:https then verifies the
 * certificate against that IP, the identity the name stood for. An IP name that differs from the endpoint host would
 * verify a different identity, so it fails by name.
 */
function tlsServerName(endpoint: URL, configured: string | undefined): string | undefined {
  const host = endpoint.hostname.replace(/^\[(.*)\]$/, "$1");
  const name = configured ?? host;
  if (isIP(name) === 0) return name;
  if (name !== host) throw new Error(`factory_transport_server_name_ip_mismatch: server name ${name} is an IP address that is not the endpoint host ${host}`);
  return undefined;
}

/** Shared private HTTPS client. It reloads every credential before each request. */
export async function createGatewayTransport(options: GatewayTransportOptions): Promise<GatewayTransport> {
  const snapshot = Object.freeze({ ...options, tls: Object.freeze({ ...options.tls }) });
  const endpoint = new URL(snapshot.baseUrl);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.pathname !== "/" || endpoint.search || endpoint.hash) throw new Error("factory gateway requires a plain private HTTPS origin");
  const timeoutMs = snapshot.requestTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) throw new Error("factory gateway timeout is invalid");
  const serverName = tlsServerName(endpoint, snapshot.serverName);
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
      const transport = createTransport(endpoint, credentials, serverName, timeoutMs);
      return requireSuccess(await transport.request(method, path, requestBody, responseLimit, signal));
    },
  } satisfies GatewayTransport);
}
