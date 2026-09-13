import { startFactoryPrivateHttps, type FactoryPrivateResponse } from "./private-https";
import { verifyFactoryAttemptToken } from "./attempt-token";
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
        const attempt = token?.startsWith("Bearer ") ? await verifyFactoryAttemptToken(token.slice(7), options.jwtSecret, options.installationId) : null;
        if (!match || !attempt || attempt.attemptId !== decodeURIComponent(match[1]!) || peerIdentity !== attempt.tenantId) return response(401, { error: "unauthorized" });
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
