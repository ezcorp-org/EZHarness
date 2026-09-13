import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { request as httpsRequest, type RequestOptions } from "node:https";
import type { IncomingHttpHeaders } from "node:http";
import type { CompiledExecutionManifest, CompiledPartitionArtifact } from "@ezcorp/factory-sdk/types";
import type { KernelEvent } from "@ezcorp/factory-sdk/kernel-types";
import { Context } from "@temporalio/activity";
import {
  MAX_ACTIVITY_PAYLOAD_BYTES,
  MAX_PAGE_BYTES,
  type CommandExecution,
  type FactoryActivities,
  type FactoryDefinitionPage,
  type FactoryDefinitionSource,
  type FactoryManifestPage,
  type ImmutableObjectReference,
  type FinalizedTransitionArtifact,
  type TransitionPageReference,
  type TransitionRecord,
} from "./contracts.ts";
import { validateDefinitionSource, validateInboxEvent, validateManifestPage, validateObjectReference } from "./validation.ts";

export interface GatewayTlsSecretPaths {
  readonly caPath: string;
  readonly certificatePath: string;
  readonly privateKeyPath: string;
  readonly serviceTokenPath: string;
}

export interface GatewayActivitiesOptions {
  readonly baseUrl: string;
  readonly tls: GatewayTlsSecretPaths;
  readonly serverName?: string;
  readonly requestTimeoutMs?: number;
  readonly heartbeatIntervalMs?: number;
}

interface GatewayResponse {
  readonly statusCode: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

interface GatewayTransport {
  request(method: "GET" | "POST" | "PUT", path: string, body: unknown, responseLimit: number, signal: AbortSignal): Promise<GatewayResponse>;
}

function encoded(value: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(value));
  if (body.byteLength > MAX_ACTIVITY_PAYLOAD_BYTES) throw new Error(`factory gateway request exceeds ${MAX_ACTIVITY_PAYLOAD_BYTES} bytes`);
  return body;
}

function sha256(bytes: Buffer): string {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function assertObjectBytes(bytes: Buffer, reference: ImmutableObjectReference): void {
  if (bytes.byteLength !== reference.encodedBytes || sha256(bytes) !== reference.digest) throw new Error("factory gateway object bytes do not match their immutable reference");
}

function parseJson<T>(response: GatewayResponse): T {
  try {
    return JSON.parse(response.body.toString("utf8")) as T;
  } catch {
    throw new Error("factory gateway returned invalid JSON");
  }
}

function requireSuccess(response: GatewayResponse): GatewayResponse {
  if (response.statusCode < 200 || response.statusCode >= 300) throw new Error(`factory gateway returned HTTP ${response.statusCode}`);
  return response;
}

function commandPath(execution: CommandExecution): { method: "POST" | "PUT"; path: string } {
  const command = execution.command;
  if (command.kind === "dispatch-node") return { method: "PUT", path: `/internal/factory/v1/executions/${encodeURIComponent(command.id)}` };
  if (command.kind === "cancel-node") return { method: "POST", path: `/internal/factory/v1/executions/${encodeURIComponent(command.attemptCommandId)}/cancel` };
  return { method: "POST", path: `/internal/factory/v1/commands/${encodeURIComponent(command.id)}` };
}

function createTransport(
  endpoint: URL,
  credentials: { ca: Buffer; certificate: Buffer; privateKey: Buffer; token: string },
  serverName: string,
  timeoutMs: number,
): GatewayTransport {
  return {
    request(method, path, value, responseLimit, signal) {
      const body = value === undefined ? undefined : encoded(value);
      return new Promise((resolve, reject) => {
        const url = new URL(path, endpoint);
        const options: RequestOptions = {
          method,
          ca: credentials.ca,
          cert: credentials.certificate,
          key: credentials.privateKey,
          rejectUnauthorized: true,
          servername: serverName,
          signal,
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
        request.setTimeout(timeoutMs, () => request.destroy(new Error("factory gateway request timed out")));
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

export async function createGatewayFactoryActivities(options: GatewayActivitiesOptions): Promise<FactoryActivities> {
  const endpoint = new URL(options.baseUrl);
  if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("factory gateway requires a plain private HTTPS origin");
  await loadCredentials(options.tls);
  const request = async (method: "GET" | "POST" | "PUT", path: string, body?: unknown, limit = MAX_ACTIVITY_PAYLOAD_BYTES): Promise<GatewayResponse> => {
    const context = Context.current();
    const heartbeat = setInterval(() => context.heartbeat(), options.heartbeatIntervalMs ?? 5_000);
    try {
      const credentials = await loadCredentials(options.tls);
      const transport = createTransport(endpoint, credentials, options.serverName ?? endpoint.hostname, options.requestTimeoutMs ?? 30_000);
      return requireSuccess(await transport.request(method, path, body, limit, context.cancellationSignal));
    } finally {
      clearInterval(heartbeat);
    }
  };

  return {
    async stageTransitionPage(value): Promise<TransitionPageReference> {
      const response = await request("PUT", `/internal/factory/v1/transitions/${value.sourceSequence}/pages/${value.index}`, value);
      const reference = parseJson<TransitionPageReference>(response);
      validateObjectReference(reference, "factory transition page");
      if (reference.index !== value.index || reference.encodedBytes !== value.encodedBytes) throw new Error("factory gateway returned a mismatched transition page reference");
      return reference;
    },
    async finalizeTransitionArtifact(value): Promise<FinalizedTransitionArtifact> {
      const response = await request("POST", `/internal/factory/v1/transitions/${value.sourceSequence}/finalize`, value);
      const finalized = parseJson<FinalizedTransitionArtifact>(response);
      validateObjectReference(finalized.manifest, "factory transition manifest");
      if (!/^sha256:[0-9a-f]{64}$/.test(finalized.eventHash)) throw new Error("factory gateway returned an invalid transition event digest");
      return finalized;
    },
    async recordTransition(record: TransitionRecord): Promise<void> {
      await request("POST", "/internal/factory/v1/transitions", record);
    },
    async executeCommand(execution: CommandExecution): Promise<KernelEvent | null> {
      const target = commandPath(execution);
      const response = await request(target.method, target.path, execution);
      if (response.statusCode === 204 || response.body.byteLength === 0) return null;
      const event = parseJson<KernelEvent>(response);
      validateInboxEvent(event as never);
      return event;
    },
    async resolveFactory(value): Promise<FactoryDefinitionSource> {
      const response = await request("POST", "/internal/factory/v1/definitions/resolve", value);
      const source = parseJson<FactoryDefinitionSource>(response);
      validateDefinitionSource(source);
      if (source.definitionDigest !== value.factory.digest) throw new Error("resolved factory digest does not match the pinned child reference");
      return source;
    },
    async loadManifestPage(value): Promise<FactoryManifestPage> {
      const response = await request("POST", "/internal/factory/v1/definitions/manifest", value, MAX_PAGE_BYTES);
      assertObjectBytes(response.body, value.page);
      const content = parseJson<Omit<FactoryManifestPage, "self">>(response);
      const manifest = { ...content, self: value.page };
      validateManifestPage(manifest);
      return manifest;
    },
    async loadDefinitionPage(value): Promise<FactoryDefinitionPage> {
      const response = await request("POST", "/internal/factory/v1/definitions/page", value, MAX_PAGE_BYTES);
      assertObjectBytes(response.body, value.page);
      return { index: value.page.index, objectId: value.page.objectId, digest: value.page.digest, content: response.body.toString("utf8") };
    },
    async loadExecutionManifest(value): Promise<CompiledExecutionManifest> {
      const response = await request("POST", "/internal/factory/v1/definitions/execution-manifest", value, MAX_PAGE_BYTES);
      assertObjectBytes(response.body, value.manifest);
      return parseJson<CompiledExecutionManifest>(response);
    },
    async loadPartitionArtifact(value): Promise<CompiledPartitionArtifact> {
      const response = await request("POST", "/internal/factory/v1/definitions/partition", value, MAX_PAGE_BYTES);
      assertObjectBytes(response.body, value.partition);
      return parseJson<CompiledPartitionArtifact>(response);
    },
  };
}
