import { verifyJWT } from "../auth/jwt";
import type { JWTPayload } from "../auth/types";
import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import type { FactoryExecutionJournal, FactoryAttemptAuthority } from "./executions";

export interface FactoryGatewayOptions {
  journal: FactoryExecutionJournal;
  /** Confirms current grant revision before the gateway creates any durable work. */
  authorizeAttempt(authority: FactoryAttemptAuthority): Promise<void>;
  jwtSecret: string;
  installationId: string;
  tls: { key: string; cert: string; ca: string };
  hostname?: string;
  port?: number;
}

type Claims = JWTPayload & Record<string, unknown>;
type Connection = { input: Buffer; authorized: boolean; tenantId?: string; processing: boolean; closed: boolean; timer?: ReturnType<typeof setTimeout> };
const MAX_REQUEST_BYTES = 1_048_576;
const MAX_HEADER_BYTES = 16 * 1024;
const READ_TIMEOUT_MS = 15_000;

function identity(value: Claims, attemptId: string): FactoryAttemptAuthority | null {
  const strings = ["attemptId", "tenantId", "projectId", "runId", "nodeInstanceId", "requestDigest"].map(key => value[key]);
  const numbers = ["candidateGeneration", "attemptNumber", "grantRevision", "reservationGeneration", "executionEpoch", "cancellationEpoch"].map(key => value[key]);
  const deadline = value.deadlineAt;
  if (strings.some(value => typeof value !== "string" || !value) || numbers.some(value => !Number.isSafeInteger(value) || (value as number) < 0) || !Number.isSafeInteger(deadline) || (strings[0] as string) !== attemptId) return null;
  if (!/^[a-f0-9]{64}$/.test(strings[5] as string)) return null;
  return { attemptId, tenantId: strings[1] as string, projectId: strings[2] as string, runId: strings[3] as string, nodeInstanceId: strings[4] as string, requestDigest: strings[5] as string, candidateGeneration: numbers[0] as number, attemptNumber: numbers[1] as number, grantRevision: numbers[2] as number, reservationGeneration: numbers[3] as number, executionEpoch: numbers[4] as number, cancellationEpoch: numbers[5] as number, deadlineAt: new Date(deadline as number) };
}

function reply(status: number, value: unknown): string {
  const body = JSON.stringify(value);
  const reason = status === 201 ? "Created" : status === 200 ? "OK" : status === 202 ? "Accepted" : status === 400 ? "Bad Request" : status === 401 ? "Unauthorized" : status === 405 ? "Method Not Allowed" : status === 409 ? "Conflict" : "Payload Too Large";
  return `HTTP/1.1 ${status} ${reason}\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`;
}

function send(socket: Bun.Socket<Connection>, status: number, value: unknown): void {
  if (socket.data.closed) return;
  socket.data.closed = true;
  clearTimeout(socket.data.timer);
  socket.write(reply(status, value));
  socket.end();
}

/** Private Bun TLS socket gateway. The handshake supplies the authenticated tenant certificate. */
export function startFactoryExecutionGateway(options: FactoryGatewayOptions): { url: string; stop(): void } {
  const listener = Bun.listen<Connection>({
    hostname: options.hostname ?? "127.0.0.1", port: options.port ?? 0,
    tls: { key: options.tls.key, cert: options.tls.cert, ca: options.tls.ca, requestCert: true, rejectUnauthorized: true },
    socket: {
      open(socket) { socket.data = { input: Buffer.alloc(0), authorized: false, processing: false, closed: false, timer: setTimeout(() => send(socket, 400, { error: "request_timeout" }), READ_TIMEOUT_MS) }; },
      handshake(socket, authorized) { const commonName = socket.getPeerCertificate()?.subject?.CN; socket.data.authorized = authorized; socket.data.tenantId = typeof commonName === "string" ? commonName : undefined; },
      async data(socket, chunk) {
        if (socket.data.closed) return;
        if (socket.data.processing) { socket.data.closed = true; clearTimeout(socket.data.timer); socket.end(); return; }
        socket.data.input = Buffer.concat([socket.data.input, Buffer.from(chunk)]);
        if (socket.data.input.byteLength > MAX_REQUEST_BYTES) return send(socket, 413, { error: "request_too_large" });
        const split = socket.data.input.indexOf("\r\n\r\n");
        if (split < 0 && socket.data.input.byteLength > MAX_HEADER_BYTES) return send(socket, 413, { error: "header_too_large" });
        if (split < 0) return;
        if (split > MAX_HEADER_BYTES) return send(socket, 413, { error: "header_too_large" });
        try {
          const [first, ...lines] = socket.data.input.subarray(0, split).toString().split("\r\n");
          const [method, path, protocol] = first!.split(" ");
          const headers: Record<string, string> = {};
          for (const line of lines) { const index = line.indexOf(":"); const name = line.slice(0, index).toLowerCase(); if (index < 1 || headers[name] !== undefined) throw new Error("Malformed or duplicate HTTP header."); headers[name] = line.slice(index + 1).trim(); }
          const match = new URL(path!, "https://factory.invalid").pathname.match(/^\/internal\/factory\/v1\/executions\/([^/]+)(\/cancel)?$/);
          const length = Number(headers["content-length"] ?? 0);
          if (protocol !== "HTTP/1.1" || headers["transfer-encoding"] !== undefined || !Number.isSafeInteger(length) || length < 0 || length > MAX_REQUEST_BYTES - split - 4) throw new Error("Malformed request length.");
          if (socket.data.input.byteLength < split + 4 + length) return;
          if (socket.data.input.byteLength !== split + 4 + length) throw new Error("Only one request is accepted per connection.");
          if (headers["x-ezcorp-factory-version"] !== "1" || (method !== "GET" && headers["content-type"] !== "application/json")) throw new Error("Gateway version or content type is invalid.");
          socket.data.processing = true;
          const request = length ? JSON.parse(socket.data.input.subarray(split + 4, split + 4 + length).toString("utf8")) : {};
          const token = headers.authorization;
          const claims = socket.data.authorized && token?.startsWith("Bearer ") ? await verifyJWT(token.slice(7), options.jwtSecret, options.installationId) as Claims | null : null;
          const attempt = match && claims ? identity(claims, decodeURIComponent(match[1]!)) : null;
          if (!attempt || socket.data.tenantId !== attempt.tenantId) send(socket, 401, { error: "unauthorized" });
          else if (method === "PUT" && !match![2]) {
            const runnerRequest = request as FactoryRunnerRequest;
            if (factoryRunnerRequestDigest(runnerRequest) !== attempt.requestDigest) throw new Error("Factory runner request does not match signed attempt.");
            await options.authorizeAttempt(attempt);
            const admitted = await options.journal.admit({ ...attempt, request: runnerRequest });
            send(socket, admitted.reused ? 200 : 201, { attemptId: attempt.attemptId, ...admitted });
          }
          else if (method === "GET" && !match![2]) send(socket, 200, await options.journal.status(attempt));
          else if (method === "POST" && match![2] === "/cancel") send(socket, 202, { accepted: await options.journal.cancel(attempt) });
          else send(socket, 405, { error: "method_not_allowed" });
        } catch (error) { send(socket, error instanceof Error && error.message.includes("conflicts") ? 409 : 400, { error: "invalid_request" }); }
      },
    },
  });
  return { url: `https://${options.hostname ?? "127.0.0.1"}:${listener.port}`, stop: () => listener.stop(true) };
}
