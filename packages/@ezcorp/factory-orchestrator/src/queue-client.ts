import {
  type ClaimedFactoryCommand,
  type FactoryCommandQueue,
  FACTORY_TRANSPORT_COMMAND_BYTES_LIMIT,
  MAX_TRANSPORT_ENVELOPE_BYTES,
  type FactoryTransportCommand,
} from "@ezcorp/factory-sdk/transport-types";
import { createGatewayTransport, type GatewayTransportOptions } from "./gateway-activities.ts";

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error(`factory gateway returned an invalid ${label}`);
  return value as Record<string, unknown>;
}

function boundedText(value: unknown, label: string, maximum = 512): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new Error(`factory gateway returned an invalid ${label}`);
  return value;
}

function encodedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value));
}

function parseCommand(value: unknown): FactoryTransportCommand {
  const command = record(value, "factory command");
  for (const name of ["commandId", "requestId", "tenantId", "projectId", "logicalRunId", "workflowId"] as const) boundedText(command[name], `factory command ${name}`);
  if (!(["start_run", "decision", "partition_notification"] as const).includes(command.kind as never)) throw new Error("factory gateway returned an invalid factory command kind");
  if (command.interpreterId !== undefined) boundedText(command.interpreterId, "factory command interpreterId");
  if (!("body" in command)) throw new Error("factory gateway returned an invalid factory command body");
  if (encodedBytes(command) > FACTORY_TRANSPORT_COMMAND_BYTES_LIMIT) throw new Error(`claimed factory command exceeds ${FACTORY_TRANSPORT_COMMAND_BYTES_LIMIT} bytes`);
  return command as unknown as FactoryTransportCommand;
}

function parseClaim(value: unknown): ClaimedFactoryCommand {
  const claim = record(value, "factory command claim");
  return { claimToken: boundedText(claim.claimToken, "factory claim token"), command: parseCommand(claim.command) };
}

function json(response: { readonly body: Buffer }, label: string): unknown {
  try { return JSON.parse(response.body.toString("utf8")); }
  catch { throw new Error(`factory gateway returned invalid ${label} JSON`); }
}

/** Installation-scoped durable outbox client. Tenant selection remains server-owned. */
export async function createGatewayFactoryCommandQueue(options: GatewayTransportOptions): Promise<FactoryCommandQueue> {
  const transport = await createGatewayTransport(options);
  return {
    async claim(): Promise<ClaimedFactoryCommand | null> {
      const response = await transport.request("POST", "/internal/factory/v1/outbox/claim", {}, MAX_TRANSPORT_ENVELOPE_BYTES);
      if (response.statusCode === 204 || response.body.byteLength === 0) return null;
      const claim = json(response, "factory claim");
      return claim === null ? null : parseClaim(claim);
    },
    async settle(claim, outcome, errorCode): Promise<void> {
      if (errorCode !== undefined) boundedText(errorCode, "factory settlement error code");
      const body = { claim, outcome, ...(errorCode ? { errorCode } : {}) };
      if (encodedBytes(body) > MAX_TRANSPORT_ENVELOPE_BYTES) throw new Error(`factory settlement exceeds ${MAX_TRANSPORT_ENVELOPE_BYTES} bytes`);
      await transport.request("POST", "/internal/factory/v1/outbox/settle", body, MAX_TRANSPORT_ENVELOPE_BYTES);
    },
    async confirmInboxIdentity(command): Promise<boolean> {
      const response = await transport.request("POST", "/internal/factory/v1/outbox/confirm-inbox", { command }, MAX_TRANSPORT_ENVELOPE_BYTES);
      const result = json(response, "inbox confirmation");
      if (typeof result !== "boolean") throw new Error("factory gateway returned an invalid inbox confirmation");
      return result;
    },
  };
}
