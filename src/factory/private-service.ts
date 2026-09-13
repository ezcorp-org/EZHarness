import { decodeFactoryPageBase64 } from "@ezcorp/factory-sdk/page-bytes";
import { artifactJson, FactoryArtifactError } from "./artifacts";
import { FactoryDefinitionError } from "./definitions";
import { FactoryInboxError } from "./inbox";
import { FactoryOutboxError } from "./outbox";
import { MAX_TRANSPORT_ENVELOPE_BYTES, type ClaimedFactoryCommand, type FactoryCommandQueue, type FactoryTransportCommand } from "@ezcorp/factory-sdk/transport-types";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import type { FactoryActivities, FactoryDefinitionSource, FactoryIdentity } from "../../packages/@ezcorp/factory-orchestrator/src/contracts";
import type { createFactoryArtifactActivities } from "./artifact-activities";
import { verifyPoolToken, type PoolTokenVerifierOptions } from "./pool/service-token";
import { startFactoryPrivateHttps, type FactoryPrivateHttpsOptions, type FactoryPrivateResponse } from "./private-https";
import { assertFactoryIdentity, FactoryRecordError } from "./records";
import type { TrustedFactoryCommandReference, TrustedFactoryServiceIdentity } from "./trusted-command-gateway";

export interface FactoryPrivateServiceCommands {
  execute(service: TrustedFactoryServiceIdentity, reference: TrustedFactoryCommandReference): Promise<KernelEvent | null>;
  resolveFactory(service: TrustedFactoryServiceIdentity, request: Parameters<FactoryActivities["resolveFactory"]>[0]): Promise<FactoryDefinitionSource>;
}
export interface FactoryPrivateServiceOptions extends Pick<FactoryPrivateHttpsOptions, "tls" | "hostname" | "port"> {
  readonly tenantId: string;
  readonly certificateIdentity: string;
  tokens(): Promise<PoolTokenVerifierOptions>;
  readonly queue: FactoryCommandQueue & Required<Pick<FactoryCommandQueue, "confirmInboxIdentity">>;
  readonly artifacts: ReturnType<typeof createFactoryArtifactActivities>;
  readonly commands: FactoryPrivateServiceCommands;
}

class PrivateRequestError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
function invalid(): never { throw new PrivateRequestError(400, "invalid_request"); }
function object(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value)) invalid(); return value as Record<string, unknown>; }
function json(status: number, value: unknown): FactoryPrivateResponse { return { status, body: Buffer.from(JSON.stringify(value)) }; }
function bytes(value: Uint8Array): FactoryPrivateResponse { return { status: 200, body: value, contentType: "application/octet-stream" }; }
function manifestBytes(value: { self: unknown }): FactoryPrivateResponse { const { self: _self, ...stored } = value; return bytes(artifactJson.canonical(stored)); }
function errorResponse(error: unknown): FactoryPrivateResponse {
  if (error instanceof PrivateRequestError) return json(error.status, { error: error.code });
  if (error instanceof FactoryArtifactError || error instanceof FactoryDefinitionError || error instanceof FactoryInboxError || error instanceof FactoryOutboxError || error instanceof FactoryRecordError) {
    const code = error.code;
    const status = code.includes("conflict") || code === "delivery_lease_lost" ? 409 : code.includes("scope") || code.includes("tenant_denied") ? 403 : code.includes("not_found") ? 404 : 400;
    return json(status, { error: code });
  }
  return json(error instanceof SyntaxError || error instanceof TypeError ? 400 : 500, { error: "request_failed" });
}

function scopedIdentity(body: Record<string, unknown>, tenantId: string): FactoryIdentity {
  if (body.tenantId !== tenantId) throw new PrivateRequestError(403, "tenant_denied");
  assertFactoryIdentity(body.projectId as string, body.logicalRunId as string, body.interpreterId as string);
  return { tenantId, projectId: body.projectId as string, logicalRunId: body.logicalRunId as string, interpreterId: body.interpreterId as string };
}

/** Installation-scoped private worker API; mTLS and a separate RS256 audience gate every route. */
export function startFactoryPrivateService(options: FactoryPrivateServiceOptions): { url: string; stop(): void } {
  const { tenantId, certificateIdentity } = options;
  assertFactoryIdentity(tenantId, certificateIdentity);
  const service = Object.freeze({ subject: certificateIdentity, tenantId });
  return startFactoryPrivateHttps({
    tls: options.tls, hostname: options.hostname, port: options.port, maxBodyBytes: MAX_TRANSPORT_ENVELOPE_BYTES, maxResponseBytes: MAX_TRANSPORT_ENVELOPE_BYTES,
    async handle(request) {
      try {
        const bearer = request.headers.authorization;
        if (!bearer?.startsWith("Bearer ") || request.peerIdentity !== certificateIdentity) throw new Error("Unauthorized certificate.");
        const claims = verifyPoolToken(bearer.slice(7), await options.tokens());
        if (claims.sub !== request.peerIdentity || !claims.scope.includes("factory:orchestrate")) throw new Error("Unauthorized service.");
      } catch { return json(401, { error: "unauthorized" }); }
      try {
        if (request.headers["x-ezcorp-factory-version"] !== "1" || (request.method !== "GET" && request.headers["content-type"] !== "application/json")) invalid();
        const path = request.path;
        if (request.method === "GET" && path === "/internal/factory/v1/health" && request.body.byteLength === 0) return json(200, { schemaVersion: "factory.private-service.v1", tenantId });
        const body = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(request.body)));
        if (request.method === "POST" && path === "/internal/factory/v1/outbox/claim") {
          if (Object.keys(body).length !== 0) invalid();
          return json(200, await options.queue.claim());
        }
        if (request.method === "POST" && path === "/internal/factory/v1/outbox/settle") {
          if (!["delivered", "retry", "outcome_unknown"].includes(body.outcome as string) || (body.errorCode !== undefined && (typeof body.errorCode !== "string" || !/^[A-Za-z0-9_.:-]{1,128}$/.test(body.errorCode)))) invalid();
          const claim = object(body.claim);
          if (typeof claim.claimToken !== "string" || claim.claimToken.length > 512) invalid();
          object(claim.command);
          await options.queue.settle(claim as unknown as ClaimedFactoryCommand, body.outcome as "delivered" | "retry" | "outcome_unknown", body.errorCode as string | undefined);
          return { status: 204, body: Buffer.alloc(0) };
        }
        if (request.method === "POST" && path === "/internal/factory/v1/outbox/confirm-inbox") return json(200, await options.queue.confirmInboxIdentity(object(body.command) as unknown as FactoryTransportCommand));
        if (request.method === "POST" && path.startsWith("/internal/factory/v1/definitions/")) {
          const scoped = { ...body, ...scopedIdentity(body, tenantId) };
          if (path === "/internal/factory/v1/definitions/resolve") return json(200, await options.commands.resolveFactory(service, { ...scopedIdentity(body, tenantId), factory: body.factory as Parameters<FactoryActivities["resolveFactory"]>[0]["factory"] }));
          if (path === "/internal/factory/v1/definitions/manifest") return manifestBytes(await options.artifacts.loadManifestPage(scoped as Parameters<FactoryActivities["loadManifestPage"]>[0]));
          if (path === "/internal/factory/v1/definitions/page") return bytes(decodeFactoryPageBase64((await options.artifacts.loadDefinitionPage(scoped as Parameters<FactoryActivities["loadDefinitionPage"]>[0])).contentBase64));
          if (path === "/internal/factory/v1/definitions/execution-manifest") return bytes(artifactJson.canonical(await options.artifacts.loadExecutionManifest(scoped as Parameters<FactoryActivities["loadExecutionManifest"]>[0])));
          if (path === "/internal/factory/v1/definitions/partition") return bytes(artifactJson.canonical(await options.artifacts.loadPartitionArtifact(scoped as Parameters<FactoryActivities["loadPartitionArtifact"]>[0])));
          return json(404, { error: "not_found" });
        }
        const transition = /^\/internal\/factory\/v1\/transitions\/(\d+)\/(pages\/(\d+)|finalize|manifest|page)$/.exec(path);
        if (transition) {
          const sequence = Number(transition[1]);
          const action = transition[2];
          if (!Number.isSafeInteger(sequence) || sequence < 1 || body.sourceSequence !== sequence) invalid();
          const scoped = { ...body, ...scopedIdentity(body, tenantId) };
          if (transition[3] !== undefined) {
            if (request.method !== "PUT" || body.index !== Number(transition[3])) invalid();
            return json(200, await options.artifacts.stageTransitionPage(scoped as Parameters<FactoryActivities["stageTransitionPage"]>[0]));
          }
          if (request.method !== "POST") invalid();
          if (action === "finalize") return json(200, await options.artifacts.finalizeTransitionArtifact(scoped as Parameters<FactoryActivities["finalizeTransitionArtifact"]>[0]));
          if (action === "manifest") return manifestBytes(await options.artifacts.loadTransitionManifest(scoped as Parameters<FactoryActivities["loadTransitionManifest"]>[0]));
          return bytes(decodeFactoryPageBase64((await options.artifacts.loadTransitionPage(scoped as Parameters<FactoryActivities["loadTransitionPage"]>[0])).contentBase64));
        }
        if (request.method === "POST" && path === "/internal/factory/v1/transitions") {
          await options.artifacts.recordTransition({ ...body, ...scopedIdentity(body, tenantId) } as Parameters<FactoryActivities["recordTransition"]>[0]);
          return { status: 204, body: Buffer.alloc(0) };
        }
        const execution = /^\/internal\/factory\/v1\/executions\/([^/?#]+)(\/cancel)?$/.exec(path);
        const effect = /^\/internal\/factory\/v1\/commands\/([^/?#]+)$/.exec(path);
        if (execution || effect) {
          const identity = scopedIdentity(body, tenantId);
          const command = object(body.command);
          assertFactoryIdentity(command.id as string);
          if (execution) {
            const target = decodeURIComponent(execution[1]!);
            if (execution[2] ? request.method !== "POST" || command.kind !== "cancel-node" || target !== command.attemptCommandId : request.method !== "PUT" || command.kind !== "dispatch-node" || target !== command.id) invalid();
          } else if (request.method !== "POST" || decodeURIComponent(effect![1]!) !== command.id || command.kind === "dispatch-node" || command.kind === "cancel-node") invalid();
          const event = await options.commands.execute(service, { ...identity, commandId: command.id as string });
          return event === null ? { status: 204, body: Buffer.alloc(0) } : json(200, event);
        }
        return json(404, { error: "not_found" });
      } catch (error) { return errorResponse(error); }
    },
  });
}
