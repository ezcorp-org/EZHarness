import { createHash } from "node:crypto";
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
  type FactoryTransitionManifest,
  type FactoryTransitionPage,
  type ImmutableObjectReference,
  type FinalizedTransitionArtifact,
  type TransitionPageReference,
  type TransitionRecord,
} from "./contracts.ts";
import { validateDefinitionSource, validateInboxEvent, validateManifestPage, validateObjectReference } from "./validation.ts";

import { createGatewayTransport, type GatewayResponse, type GatewayTransportOptions } from "@ezcorp/factory-transport";
export { createGatewayTransport, type GatewayTlsSecretPaths, type GatewayTransportOptions, type GatewayTransport, type GatewayResponse } from "@ezcorp/factory-transport";

export interface GatewayActivitiesOptions extends GatewayTransportOptions {
  readonly heartbeatIntervalMs?: number;
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

function commandPath(execution: CommandExecution): { method: "POST" | "PUT"; path: string } {
  const command = execution.command;
  if (command.kind === "dispatch-node") return { method: "PUT", path: `/internal/factory/v1/executions/${encodeURIComponent(command.id)}` };
  if (command.kind === "cancel-node") return { method: "POST", path: `/internal/factory/v1/executions/${encodeURIComponent(command.attemptCommandId)}/cancel` };
  return { method: "POST", path: `/internal/factory/v1/commands/${encodeURIComponent(command.id)}` };
}

export async function createGatewayFactoryActivities(options: GatewayActivitiesOptions): Promise<FactoryActivities> {
  const transport = await createGatewayTransport(options);
  const request = async (method: "GET" | "POST" | "PUT", path: string, body?: unknown, limit = MAX_ACTIVITY_PAYLOAD_BYTES): Promise<GatewayResponse> => {
    const context = Context.current();
    const heartbeat = setInterval(() => context.heartbeat(), options.heartbeatIntervalMs ?? 5_000);
    try {
      return await transport.request(method, path, body, limit, context.cancellationSignal);
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
      return { index: value.page.index, objectId: value.page.objectId, digest: value.page.digest, contentBase64: response.body.toString("base64") };
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
    async loadTransitionManifest(value): Promise<FactoryTransitionManifest> {
      const response = await request("POST", `/internal/factory/v1/transitions/${value.sourceSequence}/manifest`, value, MAX_PAGE_BYTES);
      assertObjectBytes(response.body, value.manifest);
      return { ...parseJson<Omit<FactoryTransitionManifest, "self">>(response), self: value.manifest };
    },
    async loadTransitionPage(value): Promise<FactoryTransitionPage> {
      const response = await request("POST", `/internal/factory/v1/transitions/${value.sourceSequence}/page`, value, MAX_PAGE_BYTES);
      assertObjectBytes(response.body, value.page);
      return { ...value.page, contentBase64: response.body.toString("base64") };
    },
  };
}
