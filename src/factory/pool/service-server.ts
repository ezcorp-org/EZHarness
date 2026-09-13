import { readFile } from "node:fs/promises";
import { createServer } from "node:https";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { TLSSocket } from "node:tls";
import { authenticatePoolPrincipal, type PoolAdmissionIdentityConfig, type PoolAdmissionRequest, type PoolAdmissionService, type PoolLeaseFenceInput, type PoolReimageInput, type PoolStopInput } from "./service";
import type { PoolTokenVerifierOptions } from "./service-token";

export interface PoolAdmissionHttpsOptions { host: string; port: number; certificatePath: string; privateKeyPath: string; certificateAuthorityPath: string; identities: PoolAdmissionIdentityConfig; tokens: PoolTokenVerifierOptions; service: PoolAdmissionService }
export interface PoolAdmissionHttpsServer { port: number; close(): Promise<void> }
const maxBodyBytes = 16 * 1024;
function json(response: ServerResponse, status: number, value: unknown): void { response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" }); response.end(JSON.stringify(value)); }
async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  let size = 0; const chunks: Buffer[] = [];
  for await (const chunk of request) { const value = Buffer.from(chunk); size += value.length; if (size > maxBodyBytes) throw new Error("Pool request body is too large."); chunks.push(value); }
  const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Pool request body is malformed."); return parsed as Record<string, unknown>;
}
function text(value: unknown, field: string): string { if (typeof value !== "string") throw new Error(`Pool ${field} is malformed.`); return value; }
function number(value: unknown, field: string): number { if (typeof value !== "number") throw new Error(`Pool ${field} is malformed.`); return value; }
function certificate(request: IncomingMessage): string {
  const peer = (request.socket as TLSSocket).getPeerCertificate(); const commonName = peer?.subject?.CN;
  if (typeof commonName !== "string" || commonName.length === 0) throw new Error("Pool client certificate is required."); return commonName;
}
function bearer(request: IncomingMessage): string { const authorization = request.headers.authorization; if (!authorization?.startsWith("Bearer ")) throw new Error("Pool bearer token is required."); return authorization.slice("Bearer ".length); }
function fence(payload: Record<string, unknown>, reservationId: string): PoolLeaseFenceInput { return { reservationId, grantRevision: number(payload.grantRevision, "grant revision"), allocationGeneration: number(payload.allocationGeneration, "allocation generation"), allocationToken: text(payload.allocationToken, "allocation token") }; }
function requestInput(payload: Record<string, unknown>): PoolAdmissionRequest { return { reservationId: text(payload.reservationId, "reservation id"), grantRevision: number(payload.grantRevision, "grant revision"), grantScope: text(payload.grantScope, "grant scope"), resources: payload.resources as PoolAdmissionRequest["resources"], admissionDeadline: text(payload.admissionDeadline, "admission deadline"), ...(payload.priority === undefined ? {} : { priority: number(payload.priority, "priority") }), ...(payload.readySequence === undefined ? {} : { readySequence: number(payload.readySequence, "ready sequence") }), ...(payload.nodeId === undefined ? {} : { nodeId: text(payload.nodeId, "node id") }) }; }

/** Private HTTPS surface. Capacity and tenant policy are deliberately absent from this route table. */
export async function startPoolAdmissionHttps(options: PoolAdmissionHttpsOptions): Promise<PoolAdmissionHttpsServer> {
  await options.service.setup();
  const server = createServer({ key: await readFile(options.privateKeyPath), cert: await readFile(options.certificatePath), ca: await readFile(options.certificateAuthorityPath), requestCert: true, rejectUnauthorized: true, minVersion: "TLSv1.3" }, async (request, response) => {
    try {
      const principal = authenticatePoolPrincipal(certificate(request), bearer(request), options.identities, options.tokens);
      const url = new URL(request.url ?? "/", `https://${request.headers.host ?? "pool.local"}`); const parts = url.pathname.split("/").filter(Boolean);
      if (request.method === "POST" && url.pathname === "/v1/pool/requests") return json(response, 200, await options.service.request(principal, requestInput(await body(request))));
      if (parts.length === 4 && parts[0] === "v1" && parts[1] === "pool" && parts[2] === "requests" && request.method === "GET") return json(response, 200, await options.service.status(principal, parts[3]!));
      if (parts.length === 5 && parts.slice(0, 3).join("/") === "v1/pool/requests" && request.method === "POST") {
        const reservationId = parts[3]!; const action = parts[4]!; const payload = await body(request);
        if (action === "acknowledge-start") return json(response, 200, await options.service.acknowledgeStart(principal, fence(payload, reservationId)));
        if (action === "renew") return json(response, 200, await options.service.renew(principal, fence(payload, reservationId)));
        if (action === "cancel") return json(response, 200, await options.service.cancel(principal, reservationId, number(payload.allocationGeneration, "allocation generation")));
      }
      if (request.method === "POST" && (url.pathname === "/v1/pool/supervisor/stop" || url.pathname === "/v1/pool/supervisor/reimage")) {
        const payload = await body(request); const stop: PoolStopInput = { reservationId: text(payload.reservationId, "reservation id"), holderGeneration: number(payload.holderGeneration, "holder generation"), hostId: text(payload.hostId, "host id") };
        if (url.pathname.endsWith("/stop")) return json(response, 200, await options.service.confirmStopped(principal, stop));
        return json(response, 200, await options.service.confirmReimage(principal, { ...stop, receipt: text(payload.receipt, "reimage receipt") } satisfies PoolReimageInput));
      }
      return json(response, 404, { error: "not-found" });
    } catch { return json(response, 403, { error: "forbidden" }); }
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(options.port, options.host, () => { server.off("error", reject); resolve(); }); });
  const address = server.address(); if (!address || typeof address === "string") { server.close(); throw new Error("Pool HTTPS server did not bind a TCP port."); }
  return { port: address.port, close: () => new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())) };
}
