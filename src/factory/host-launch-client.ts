import { createGatewayTransport, type GatewayTransportOptions } from "@ezcorp/factory-transport";
import { validateFactoryRunnerResult, type FactoryRunnerResult } from "@ezcorp/factory-sdk";
import { FactoryAttemptRuntimeError, factoryAttemptLaunchIntentToWire, type FactoryAttemptLaunchIntent, type FactoryAttemptOpenDisposition } from "./runner/attempt-runtime";
import { FACTORY_HOST_ATTACH_PATH, FACTORY_HOST_LAUNCH_PATH, FACTORY_HOST_RESULT_PATH, type FactoryHostAttemptHandle } from "./runner/host-launch-service";

export interface FactoryHostLaunchClientOptions extends GatewayTransportOptions {
  /** The host this endpoint speaks for. An intent for another host never leaves. */
  readonly hostId: string;
}

/** The physical half of an attempt, reached over mutual TLS. */
export interface FactoryHostLaunchTransport {
  launch(intent: FactoryAttemptLaunchIntent, signal?: AbortSignal): Promise<FactoryHostAttemptHandle>;
  attach(intent: FactoryAttemptLaunchIntent, signal?: AbortSignal): Promise<FactoryHostAttemptHandle>;
  result(intent: FactoryAttemptLaunchIntent, signal?: AbortSignal): Promise<FactoryRunnerResult>;
}

const HANDLE_LIMIT_BYTES = 8 * 1024;
const RESULT_LIMIT_BYTES = 64 * 1024;
const DISPOSITIONS = new Set<FactoryAttemptOpenDisposition>(["started", "attached", "terminal", "uncertain"]);

function invalid(): never {
  throw new FactoryAttemptRuntimeError("launch_uncertain", "Factory host reply is not a launch outcome.");
}

function decode(body: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body)); }
  catch { invalid(); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) invalid();
  return parsed as Record<string, unknown>;
}

function opaque(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > 512) invalid();
  return value;
}

/** Decodes a handle without ever inventing one; a transport fault is not an outcome. */
export function parseFactoryHostAttemptHandle(value: unknown): FactoryHostAttemptHandle {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const body = value as Record<string, unknown>;
  if (typeof body.disposition !== "string" || !DISPOSITIONS.has(body.disposition as FactoryAttemptOpenDisposition)) invalid();
  return Object.freeze({
    disposition: body.disposition as FactoryAttemptOpenDisposition,
    workerId: opaque(body.workerId),
    invocationId: opaque(body.invocationId),
  });
}

/**
 * The concrete authenticated host launch transport.
 *
 * Mutual TLS is the authentication and the host is the only party that touches a
 * container. The intent carries the attempt's own short-lived token, which is
 * the authority the guest runs under, so a host holds attempt-scoped authority
 * and never a tenant credential.
 */
export async function createFactoryHostLaunchClient(options: FactoryHostLaunchClientOptions): Promise<FactoryHostLaunchTransport> {
  const hostId = opaque(options.hostId);
  const transport = await createGatewayTransport(options);
  const call = async (path: string, body: unknown, limit: number, signal?: AbortSignal) => {
    const response = await transport.request("POST", path, body, limit, signal ?? new AbortController().signal);
    return decode(response.body);
  };
  return Object.freeze({
    async launch(intent: FactoryAttemptLaunchIntent, signal?: AbortSignal): Promise<FactoryHostAttemptHandle> {
      if (intent.lease.hostId !== hostId) throw new FactoryAttemptRuntimeError("invalid_launch", "Factory launch intent names another host.");
      const handle = parseFactoryHostAttemptHandle(await call(FACTORY_HOST_LAUNCH_PATH, { intent: factoryAttemptLaunchIntentToWire(intent) }, HANDLE_LIMIT_BYTES, signal));
      if (handle.workerId !== intent.workerId || handle.invocationId !== intent.invocationId) throw new FactoryAttemptRuntimeError("launch_uncertain", "Factory host answered for another worker or invocation.");
      return handle;
    },
    async attach(intent: FactoryAttemptLaunchIntent, signal?: AbortSignal): Promise<FactoryHostAttemptHandle> {
      if (intent.lease.hostId !== hostId) throw new FactoryAttemptRuntimeError("invalid_launch", "Factory launch intent names another host.");
      const handle = parseFactoryHostAttemptHandle(await call(FACTORY_HOST_ATTACH_PATH, { intent: factoryAttemptLaunchIntentToWire(intent) }, HANDLE_LIMIT_BYTES, signal));
      if (handle.workerId !== intent.workerId || handle.invocationId !== intent.invocationId) throw new FactoryAttemptRuntimeError("launch_uncertain", "Factory host answered for another worker or invocation.");
      return handle;
    },
    async result(intent: FactoryAttemptLaunchIntent, signal?: AbortSignal): Promise<FactoryRunnerResult> {
      if (intent.lease.hostId !== hostId) throw new FactoryAttemptRuntimeError("invalid_launch", "Factory launch intent names another host.");
      const body = await call(FACTORY_HOST_RESULT_PATH, { intent: factoryAttemptLaunchIntentToWire(intent) }, RESULT_LIMIT_BYTES, signal);
      if (!validateFactoryRunnerResult(body.result).ok) invalid();
      return body.result as FactoryRunnerResult;
    },
  });
}
