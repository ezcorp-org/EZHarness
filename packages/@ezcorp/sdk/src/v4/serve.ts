import { ContractError, MAX_FRAME_BYTES, assertJson, parseJson, validateInvocationContext } from "@ezcorp/extension-contract";
import type { InvocationContext } from "@ezcorp/extension-contract";
import type { DefinedExtension, ExtensionContext } from "./index";
import { installNetworkShim } from "./network";

type Envelope = Record<string, unknown>;
type Writer = (frame: string) => void | Promise<void>;
interface PendingCall {
  resolve(value: unknown): void;
  reject(error: Error): void;
  cleanup(): void;
}
export interface Session {
  receive(value: unknown): Promise<void>;
  close(): void;
}
export interface ServeOptions {
  input?: AsyncIterable<Uint8Array | string>;
  write?: Writer;
  maxFrameBytes?: number;
  maxConcurrentInvocations?: number;
}

function object(value: unknown): Envelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ContractError("INVALID_REQUEST", "Expected request object");
  return value as Envelope;
}

export function createSession(extension: DefinedExtension, write: Writer, options: Pick<ServeOptions, "maxFrameBytes" | "maxConcurrentInvocations"> = {}): Session {
  const maxFrameBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  const maxConcurrent = options.maxConcurrentInvocations ?? 16;
  const active = new Map<string, AbortController>();
  const requests = new Set<string | number>();
  const pending = new Map<string, PendingCall>();
  let sequence = 0;
  let closed = false;
  let principal: Pick<InvocationContext, "workerId" | "releaseId" | "principalId" | "scopeId"> | undefined;
  let writes = Promise.resolve();
  function send(value: unknown): Promise<void> {
    if (closed) return Promise.reject(new ContractError("CLOSED", "Session is closed"));
    assertJson(value, maxFrameBytes);
    const frame = `${JSON.stringify(value)}\n`;
    writes = writes.then(() => write(frame));
    return writes;
  }
  function close(): void {
    if (closed) return;
    closed = true;
    for (const controller of active.values()) controller.abort(new ContractError("CANCELLED", "Session closed"));
    pending.clear();
  }
  async function invoke(method: string, params: unknown): Promise<unknown> {
    if (method === "extension/discover") {
      if (params !== undefined && params !== null && Object.keys(object(params)).length) throw new ContractError("INVALID_REQUEST", "Discovery does not accept context");
      return extension.manifest;
    }
    const payload = object(params);
    if (method === "extension/cancel") {
      if (typeof payload.invocationId !== "string" || Object.keys(payload).some(key => key !== "invocationId")) throw new ContractError("INVALID_REQUEST", "Invalid cancellation");
      active.get(payload.invocationId)?.abort(new ContractError("CANCELLED", "Invocation cancelled"));
      return { cancelled: active.has(payload.invocationId) };
    }
    if (method !== "extension/invoke" && method !== "extension/dispatch") throw new ContractError("METHOD_NOT_FOUND", "Unknown protocol method");
    const nameKey = method === "extension/invoke" ? "name" : "method";
    if (typeof payload[nameKey] !== "string" || !Object.hasOwn(payload, "input") || Object.keys(payload).some(key => ![nameKey, "input", "context"].includes(key))) throw new ContractError("INVALID_REQUEST", "Invalid invocation envelope");
    const invocation = Object.freeze({ ...validateInvocationContext(payload.context) });
    if (invocation.deadline <= Date.now()) throw new ContractError("DEADLINE_EXCEEDED", "Invocation deadline has passed");
    if (invocation.deadline - Date.now() > 24 * 60 * 60 * 1000) throw new ContractError("INVALID_CONTEXT", "Invocation deadline exceeds one day");
    if (principal && ["workerId", "releaseId", "principalId", "scopeId"].some(key => principal![key as keyof typeof principal] !== invocation[key as keyof typeof principal])) throw new ContractError("CONTEXT_MISMATCH", "Worker cannot change its security context");
    principal ??= { workerId: invocation.workerId, releaseId: invocation.releaseId, principalId: invocation.principalId, scopeId: invocation.scopeId };
    if (active.has(invocation.invocationId)) throw new ContractError("DUPLICATE_INVOCATION", "Invocation is already running");
    if (active.size >= maxConcurrent) throw new ContractError("BUSY", "Invocation limit reached");
    const controller = new AbortController();
    active.set(invocation.invocationId, controller);
    const timer = setTimeout(() => controller.abort(new ContractError("DEADLINE_EXCEEDED", "Invocation deadline reached")), invocation.deadline - Date.now());
    let rejectCancellation: ((error: Error) => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => { rejectCancellation = reject; });
    const onAbort = () => rejectCancellation?.(controller.signal.reason);
    controller.signal.addEventListener("abort", onAbort, { once: true });
    const context: ExtensionContext = Object.freeze({
      invocation,
      signal: controller.signal,
      call: async (rpcMethod: string, input: unknown): Promise<unknown> => {
        controller.signal.throwIfAborted();
        if (!active.has(invocation.invocationId) || closed) throw new ContractError("EXPIRED_CONTEXT", "Invocation is no longer active");
        if (!/^[a-zA-Z][a-zA-Z0-9_./:-]{0,127}$/.test(rpcMethod) || rpcMethod.startsWith("extension/")) throw new ContractError("INVALID_METHOD", "Invalid host capability method");
        assertJson(input);
        if (pending.size >= 64) throw new ContractError("BUSY", "Host request limit reached");
        const id = `sdk:${++sequence}`;
        return new Promise((resolve, reject) => {
          const onCancel = () => {
            pending.delete(id);
            reject(controller.signal.reason);
          };
          const cleanup = () => controller.signal.removeEventListener("abort", onCancel);
          controller.signal.addEventListener("abort", onCancel, { once: true });
          pending.set(id, { resolve, reject, cleanup });
          send({ jsonrpc: "2.0", id, method: rpcMethod, params: { context: invocation, input } }).catch(error => {
            if (!pending.delete(id)) return;
            cleanup();
            reject(error);
          });
        });
      },
    });
    try {
      const result = method === "extension/invoke" ? extension.invoke(payload.name as string, payload.input, context) : extension.dispatch(payload.method as string, payload.input, context);
      return await Promise.race([result, cancelled]);
    } finally {
      clearTimeout(timer);
      controller.signal.removeEventListener("abort", onAbort);
      active.delete(invocation.invocationId);
      controller.abort(new ContractError("EXPIRED_CONTEXT", "Invocation completed"));
    }
  }
  async function receive(value: unknown): Promise<void> {
    if (closed) throw new ContractError("CLOSED", "Session is closed");
    assertJson(value, maxFrameBytes);
    const message = object(value);
    if (message.jsonrpc !== "2.0") throw new ContractError("INVALID_REQUEST", "Unsupported protocol");
    if (!Object.hasOwn(message, "method")) {
      if (typeof message.id !== "string" || !pending.has(message.id)) throw new ContractError("INVALID_RESPONSE", "Unknown host response id");
      if (Object.keys(message).some(key => !["jsonrpc", "id", "result", "error"].includes(key)) || Object.hasOwn(message, "result") === Object.hasOwn(message, "error")) throw new ContractError("INVALID_RESPONSE", "Invalid host response");
      const call = pending.get(message.id)!;
      if (Object.hasOwn(message, "error")) {
        const error = object(message.error);
        if (typeof error.code !== "number" || typeof error.message !== "string") throw new ContractError("INVALID_RESPONSE", "Invalid host error");
        pending.delete(message.id);
        call.cleanup();
        call.reject(new ContractError("HOST_ERROR", error.message));
      } else {
        pending.delete(message.id);
        call.cleanup();
        call.resolve(message.result);
      }
      return;
    }
    if (typeof message.method !== "string" || Object.keys(message).some(key => !["jsonrpc", "id", "method", "params"].includes(key))) throw new ContractError("INVALID_REQUEST", "Invalid request envelope");
    const id = message.id;
    if (id === undefined) {
      if (message.method !== "extension/cancel") throw new ContractError("INVALID_REQUEST", "Only cancellation can be a notification");
      await invoke(message.method, message.params);
      return;
    }
    if ((typeof id !== "string" && !Number.isSafeInteger(id)) || requests.has(id as string | number)) throw new ContractError("INVALID_REQUEST", "Invalid or duplicate request id");
    requests.add(id as string | number);
    try {
      const result = await invoke(message.method, message.params);
      await send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      const code = error instanceof ContractError ? error.code : "HANDLER_FAILED";
      await send({ jsonrpc: "2.0", id, error: { code: -32000, message: error instanceof ContractError ? error.message : "Extension handler failed", data: { code, retryable: false } } });
    } finally {
      requests.delete(id as string | number);
    }
  }
  return { receive, close };
}

export async function serve(extension: DefinedExtension, options: ServeOptions = {}): Promise<void> {
  const maxBytes = options.maxFrameBytes ?? MAX_FRAME_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 64 || maxBytes > MAX_FRAME_BYTES) throw new ContractError("INVALID_LIMITS", "Invalid frame limit");
  const session = createSession(extension, options.write ?? (frame => new Promise<void>((resolve, reject) => process.stdout.write(frame, error => error ? reject(error) : resolve()))), options);
  const active = new Set<Promise<void>>();
  const restoreNetwork = installNetworkShim();
  let failure: unknown;
  let buffer = new Uint8Array(0);
  try {
    for await (const chunk of options.input ?? process.stdin) {
      if (failure) throw failure;
      const bytes = typeof chunk === "string" ? new TextEncoder().encode(chunk) : chunk;
      let start = 0;
      for (let index = 0; index <= bytes.length; index++) {
        if (index < bytes.length && bytes[index] !== 10) continue;
        const part = bytes.subarray(start, index);
        if (buffer.length + part.length > maxBytes) throw new ContractError("DATA_LIMIT", "Frame exceeds limit");
        const joined = new Uint8Array(buffer.length + part.length);
        joined.set(buffer);
        joined.set(part, buffer.length);
        buffer = joined;
        start = index + 1;
        if (index === bytes.length) break;
        if (active.size >= 128) throw new ContractError("DATA_LIMIT", "Too many pending frames");
        const frame = parseJson(new TextDecoder("utf-8", { fatal: true }).decode(buffer), maxBytes);
        buffer = new Uint8Array(0);
        const task = session.receive(frame).catch(error => { failure = error; session.close(); });
        active.add(task);
        void task.finally(() => active.delete(task));
      }
    }
    if (buffer.length) throw new ContractError("INVALID_REQUEST", "Truncated final frame");
    if (failure) throw failure;
  } finally {
    session.close();
    await Promise.allSettled(active);
    restoreNetwork();
  }
}
