import { FACTORY_PRIVATE_MAX_ENVELOPE_BYTES, startFactoryPrivateHttps, type FactoryPrivateResponse } from "./private-https";
import { verifyFactoryAttemptToken } from "./attempt-token";
import type { FactoryRunnerRequest } from "@ezcorp/factory-sdk";
import { factoryRunnerRequestDigest } from "@ezcorp/factory-sdk/compiler";
import type { FactoryExecutionJournal, FactoryAttemptAuthority } from "./executions";
import { FACTORY_MATERIAL_LIMITS, FactoryArtifactAccessError, FactoryMaterialError, type FactoryAttemptMaterials } from "./artifact-materials";

/** One material chunk plus its private envelope headroom. */
export const FACTORY_GATEWAY_MATERIAL_ENVELOPE_BYTES = FACTORY_MATERIAL_LIMITS.maxChunkBytes + 64 * 1024;
/** Every other gateway operation stays on the small JSON envelope it always had. */
export const FACTORY_GATEWAY_CONTROL_ENVELOPE_BYTES = 1024 * 1024;

export interface FactoryGatewayOptions {
  journal: FactoryExecutionJournal;
  /** Confirms current grant revision before the gateway creates any durable work. */
  authorizeAttempt(authority: FactoryAttemptAuthority): Promise<void>;
  /**
   * Builds the attempt-scoped auxiliary material service from verified authority.
   * Omit it to serve only the four execution operations.
   */
  materials?(authority: FactoryAttemptAuthority): FactoryAttemptMaterials;
  jwtSecret: string;
  installationId: string;
  tls: { key: string; cert: string; ca: string };
  hostname?: string;
  port?: number;
}

const EXECUTION_PATH = /^\/internal\/factory\/v1\/executions\/([^/?#]+)(\/cancel)?$/;
const MATERIAL_LIST_PATH = /^\/internal\/factory\/v1\/executions\/([^/?#]+)\/materials\/([^/?#]+)$/;
const MATERIAL_PATH = /^\/internal\/factory\/v1\/executions\/([^/?#]+)\/materials\/([^/?#]+)\/([^/?#]+)\/(\d+)$/;
const MATERIAL_SEAL_PATH = /^\/internal\/factory\/v1\/executions\/([^/?#]+)\/materials\/([^/?#]+)\/([^/?#]+)\/(\d+)\/seal$/;
const MATERIAL_CHUNK_PATH = /^\/internal\/factory\/v1\/executions\/([^/?#]+)\/materials\/([^/?#]+)\/([^/?#]+)\/(\d+)\/chunks\/(\d+)$/;

function response(status: number, value: unknown): FactoryPrivateResponse {
  return { status, body: Buffer.from(JSON.stringify(value)) };
}

function bytes(status: number, value: Uint8Array): FactoryPrivateResponse {
  return { status, body: value, contentType: "application/octet-stream" };
}

/** A path segment carries one percent-encoded identity, never a raw separator. */
function segment(value: string): string {
  const decoded = decodeURIComponent(value);
  if (!decoded || decoded.length > FACTORY_MATERIAL_LIMITS.maxNameLength) throw new Error("Gateway path identity is invalid.");
  return decoded;
}

function count(value: string, maximum: number): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > maximum) throw new Error("Gateway path counter is invalid.");
  return parsed;
}

const MATERIAL_STATUS: Readonly<Record<string, number>> = Object.freeze({
  factory_material_not_found: 404, factory_material_chunk_not_found: 404,
  factory_material_scope_denied: 403,
  factory_material_conflict: 409, factory_material_version_conflict: 409, factory_material_chunk_conflict: 409,
  factory_material_sealed: 409, factory_material_operation_full: 409,
});

/** The owning attempt learns why its own write failed; every other denial stays opaque. */
function failure(error: unknown): FactoryPrivateResponse {
  const code = error instanceof FactoryMaterialError ? error.code : undefined;
  if (code !== undefined) return response(MATERIAL_STATUS[code] ?? 400, { error: code });
  if (error instanceof FactoryArtifactAccessError) return response(404, { error: error.code });
  return response(error instanceof Error && error.message.includes("conflicts") ? 409 : 400, { error: "invalid_request" });
}

/** The shared private transport supplies the verified client certificate identity. */
export function startFactoryExecutionGateway(options: FactoryGatewayOptions): { url: string; stop(): void } {
  const envelope = options.materials ? FACTORY_GATEWAY_MATERIAL_ENVELOPE_BYTES : FACTORY_GATEWAY_CONTROL_ENVELOPE_BYTES;
  if (envelope > FACTORY_PRIVATE_MAX_ENVELOPE_BYTES) throw new Error("Factory gateway envelope exceeds the private transport limit.");
  return startFactoryPrivateHttps({
    tls: options.tls, hostname: options.hostname, port: options.port, maxBodyBytes: envelope, maxResponseBytes: envelope,
    async handle({ peerIdentity, method, path, headers, body }) {
      try {
        const match = path.match(EXECUTION_PATH);
        const chunkMatch = path.match(MATERIAL_CHUNK_PATH);
        const sealMatch = path.match(MATERIAL_SEAL_PATH);
        const materialMatch = path.match(MATERIAL_PATH);
        const listMatch = path.match(MATERIAL_LIST_PATH);
        const route = match ?? chunkMatch ?? sealMatch ?? materialMatch ?? listMatch;
        const raw = method !== "GET" && headers["content-type"] === "application/octet-stream";
        if (headers["x-ezcorp-factory-version"] !== "1" || (method !== "GET" && !raw && headers["content-type"] !== "application/json")) throw new Error("Gateway version or content type is invalid.");
        // Only a material chunk may use the large envelope; every other route keeps its original bound.
        if (!chunkMatch && body.byteLength > FACTORY_GATEWAY_CONTROL_ENVELOPE_BYTES) return response(413, { error: "request_too_large" });
        const request = !raw && body.byteLength ? JSON.parse(body.toString("utf8")) : {};
        const token = headers.authorization;
        const attempt = token?.startsWith("Bearer ") ? await verifyFactoryAttemptToken(token.slice(7), options.jwtSecret, options.installationId) : null;
        if (!route || !attempt || attempt.attemptId !== decodeURIComponent(route[1]!) || peerIdentity !== attempt.tenantId) return response(401, { error: "unauthorized" });

        if (match) {
          if (raw) throw new Error("Gateway version or content type is invalid.");
          if (method === "PUT" && !match[2]) {
            const runnerRequest = request as FactoryRunnerRequest;
            if (factoryRunnerRequestDigest(runnerRequest) !== attempt.requestDigest) throw new Error("Factory runner request does not match signed attempt.");
            await options.authorizeAttempt(attempt);
            const admitted = await options.journal.admit({ ...attempt, request: runnerRequest });
            return response(admitted.reused ? 200 : 201, { attemptId: attempt.attemptId, ...admitted });
          }
          if (method === "GET" && !match[2]) return response(200, await options.journal.status(attempt));
          if (method === "POST" && match[2] === "/cancel") return response(202, { accepted: await options.journal.cancel(attempt) });
          return response(405, { error: "method_not_allowed" });
        }

        if (!options.materials) return response(404, { error: "not_found" });
        const materials = options.materials(attempt);
        const scope = materials.scope(segment(route[2]!));

        if (listMatch) {
          if (method !== "GET") return response(405, { error: "method_not_allowed" });
          return response(200, { materials: await materials.list(scope) });
        }

        const identity = { ...scope, objectName: segment(route[3]!), version: count(route[4]!, Number.MAX_SAFE_INTEGER) };
        if (chunkMatch) {
          const index = count(chunkMatch[5]!, FACTORY_MATERIAL_LIMITS.maxChunks - 1);
          if (method === "PUT") {
            if (!raw) throw new Error("Gateway version or content type is invalid.");
            const digest = headers["x-ezcorp-factory-chunk-digest"];
            if (typeof digest !== "string") throw new Error("Gateway chunk digest header is missing.");
            const record = await materials.writeChunk(identity, { index, digest, encodedBytes: body.byteLength }, body);
            return response(200, { material: record });
          }
          if (method === "GET") return bytes(200, await materials.readChunk(identity, index));
          return response(405, { error: "method_not_allowed" });
        }

        if (sealMatch) {
          if (method !== "POST") return response(405, { error: "method_not_allowed" });
          const artifact = await materials.seal(identity, String((request as { digest?: unknown }).digest));
          return response(200, { artifact });
        }

        if (method === "PUT") {
          const input = request as { mediaType?: unknown; totalBytes?: unknown; chunkCount?: unknown };
          const record = await materials.begin(identity, String(input.mediaType), Number(input.totalBytes), Number(input.chunkCount));
          return response(record.sealed ? 200 : 201, { material: record });
        }
        if (method === "GET") return response(200, { chunks: await materials.chunks(identity) });
        return response(405, { error: "method_not_allowed" });
      } catch (error) { return failure(error); }
    },
  });
}
