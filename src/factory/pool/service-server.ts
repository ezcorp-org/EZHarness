import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { startFactoryPrivateHttps, type FactoryPrivateHttpsOptions, type FactoryPrivateResponse } from "../private-https";
import { createPoolAdmissionRouteHandler, POOL_HTTP_BYTES_LIMIT, type PoolAdmissionRouteOptions } from "./service-routes";

export interface PoolAdmissionHttpsOptions extends PoolAdmissionRouteOptions {
  readonly host: string;
  readonly port: number;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly certificateAuthorityPath: string;
}

export interface BunPoolAdmissionHttpsOptions extends PoolAdmissionRouteOptions, Pick<FactoryPrivateHttpsOptions, "tls" | "hostname" | "port"> {}
export interface PoolAdmissionHttpsServer { readonly port: number; close(): Promise<void> }

async function body(request: IncomingMessage): Promise<Buffer> {
  let size = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const value = Buffer.from(chunk);
    size += value.byteLength;
    if (size > POOL_HTTP_BYTES_LIMIT) throw new Error("request_too_large");
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

function peerIdentity(request: IncomingMessage): string {
  const value = (request.socket as TLSSocket).getPeerCertificate()?.subject?.CN;
  return typeof value === "string" ? value : "";
}

function headers(request: IncomingMessage): Readonly<Record<string, string>> {
  const result: Record<string, string> = Object.create(null);
  for (const name of ["authorization", "content-type", "x-ezcorp-factory-version"] as const) {
    const value = request.headers[name];
    if (typeof value === "string") result[name] = value;
  }
  return Object.freeze(result);
}

function write(response: ServerResponse, result: FactoryPrivateResponse): void {
  response.writeHead(result.status, { "content-type": result.contentType ?? "application/json", "content-length": result.body.byteLength, "cache-control": "no-store", connection: "close" });
  response.end(result.body);
}

/** Node HTTPS wrapper retained for the standalone pool-service process. */
export async function startPoolAdmissionHttps(options: PoolAdmissionHttpsOptions): Promise<PoolAdmissionHttpsServer> {
  const handle = createPoolAdmissionRouteHandler(options);
  const snapshot = { host: options.host, port: options.port, certificatePath: options.certificatePath, privateKeyPath: options.privateKeyPath, certificateAuthorityPath: options.certificateAuthorityPath };
  await options.service.setup();
  const server = createServer({ key: await readFile(snapshot.privateKeyPath), cert: await readFile(snapshot.certificatePath), ca: await readFile(snapshot.certificateAuthorityPath), requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3", maxHeaderSize: POOL_HTTP_BYTES_LIMIT }, async (request, response) => {
    try {
      write(response, await handle({ peerIdentity: peerIdentity(request), method: request.method ?? "", path: request.url ?? "/", headers: headers(request), body: await body(request) }));
    } catch (error) {
      write(response, { status: error instanceof Error && error.message === "request_too_large" ? 413 : 400, body: Buffer.from('{"error":"invalid_request"}') });
    }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(snapshot.port, snapshot.host, () => { server.off("error", reject); resolve(); }); });
  const address = server.address();
  if (!address || typeof address === "string") { server.close(); throw new Error("Pool HTTPS server did not bind a TCP port."); }
  return { port: address.port, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}

/** Bun TLS wrapper used by the in-installation private service. */
export async function startBunPoolAdmissionHttps(options: BunPoolAdmissionHttpsOptions): Promise<{ readonly url: string; stop(): void }> {
  const handle = createPoolAdmissionRouteHandler(options);
  const snapshot = { tls: { ...options.tls }, hostname: options.hostname, port: options.port };
  await options.service.setup();
  return startFactoryPrivateHttps({
    tls: snapshot.tls,
    hostname: snapshot.hostname,
    port: snapshot.port,
    maxBodyBytes: POOL_HTTP_BYTES_LIMIT,
    maxResponseBytes: POOL_HTTP_BYTES_LIMIT,
    handle,
  });
}
