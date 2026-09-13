import { startFactoryPrivateHttps, type FactoryPrivateResponse } from "./private-https";
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
function identity(value: Claims, attemptId: string): FactoryAttemptAuthority | null {
  const strings = ["attemptId", "tenantId", "projectId", "runId", "nodeInstanceId", "requestDigest"].map(key => value[key]);
  const numbers = ["candidateGeneration", "attemptNumber", "grantRevision", "reservationGeneration", "executionEpoch", "cancellationEpoch"].map(key => value[key]);
  const deadline = value.deadlineAt;
  if (strings.some(value => typeof value !== "string" || !value) || numbers.some(value => !Number.isSafeInteger(value) || (value as number) < 0) || !Number.isSafeInteger(deadline) || (strings[0] as string) !== attemptId) return null;
  if (!/^[a-f0-9]{64}$/.test(strings[5] as string)) return null;
  return { attemptId, tenantId: strings[1] as string, projectId: strings[2] as string, runId: strings[3] as string, nodeInstanceId: strings[4] as string, requestDigest: strings[5] as string, candidateGeneration: numbers[0] as number, attemptNumber: numbers[1] as number, grantRevision: numbers[2] as number, reservationGeneration: numbers[3] as number, executionEpoch: numbers[4] as number, cancellationEpoch: numbers[5] as number, deadlineAt: new Date(deadline as number) };
}

function response(status: number, value: unknown): FactoryPrivateResponse {
  return { status, body: Buffer.from(JSON.stringify(value)) };
}

/** The shared private transport supplies the verified client certificate identity. */
export function startFactoryExecutionGateway(options: FactoryGatewayOptions): { url: string; stop(): void } {
  return startFactoryPrivateHttps({
    tls: options.tls, hostname: options.hostname, port: options.port, maxBodyBytes: 1024 * 1024,
    async handle({ peerIdentity, method, path, headers, body }) {
      try {
        const match = path.match(/^\/internal\/factory\/v1\/executions\/([^/?#]+)(\/cancel)?$/);
        if (headers["x-ezcorp-factory-version"] !== "1" || (method !== "GET" && headers["content-type"] !== "application/json")) throw new Error("Gateway version or content type is invalid.");
        const request = body.byteLength ? JSON.parse(body.toString("utf8")) : {};
        const token = headers.authorization;
        const claims = token?.startsWith("Bearer ") ? await verifyJWT(token.slice(7), options.jwtSecret, options.installationId) as Claims | null : null;
        const attempt = match && claims ? identity(claims, decodeURIComponent(match[1]!)) : null;
        if (!attempt || peerIdentity !== attempt.tenantId) return response(401, { error: "unauthorized" });
        if (method === "PUT" && !match![2]) {
          const runnerRequest = request as FactoryRunnerRequest;
          if (factoryRunnerRequestDigest(runnerRequest) !== attempt.requestDigest) throw new Error("Factory runner request does not match signed attempt.");
          await options.authorizeAttempt(attempt);
          const admitted = await options.journal.admit({ ...attempt, request: runnerRequest });
          return response(admitted.reused ? 200 : 201, { attemptId: attempt.attemptId, ...admitted });
        }
        if (method === "GET" && !match![2]) return response(200, await options.journal.status(attempt));
        if (method === "POST" && match![2] === "/cancel") return response(202, { accepted: await options.journal.cancel(attempt) });
        return response(405, { error: "method_not_allowed" });
      } catch (error) { return response(error instanceof Error && error.message.includes("conflicts") ? 409 : 400, { error: "invalid_request" }); }
    },
  });
}
