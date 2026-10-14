import type { JsonRpcNotification, JsonRpcRequest, JsonRpcResponse, ToolCallResult } from "./types";

/**
 * The extension process contract: one extension's JSON-RPC peer.
 *
 * Production's only implementation is `ReleaseProcess`
 * (`release-process.ts`), which runs the extension in an extension-runner
 * worker. The host never spawns extension code (#246), so this contract has
 * no spawn surface at all. A host-spawned implementation, used only by fast
 * example and behavior tests, lives in
 * `src/__tests__/helpers/host-extension-process.ts`.
 */
export abstract class ExtensionProcess {
  constructor(public readonly extensionId: string) {}

  /** Make the process ready to take calls; throws when it cannot run. */
  abstract ensureRunning(): void;
  abstract call(method: string, params?: Record<string, unknown>, options?: { skipTimeout?: boolean }): Promise<JsonRpcResponse>;
  abstract callTool(
    toolName: string,
    args: Record<string, unknown>,
    meta?: Record<string, unknown>,
    options?: { skipTimeout?: boolean },
  ): Promise<ToolCallResult>;
  abstract sendNotification(method: string, params?: Record<string, unknown>): boolean | Promise<void>;
  abstract setRequestHandler(handler: (req: JsonRpcRequest) => Promise<JsonRpcResponse>): void;
  abstract setNotificationHandler(handler: (notification: JsonRpcNotification) => void): void;
  abstract kill(): void;
  abstract get isRunning(): boolean;
  /** Host-initiated calls still awaiting a response. */
  abstract get inFlightCallCount(): number;
  /** Resolves once no host-initiated call is in flight. */
  abstract whenCallsSettled(): Promise<void>;
}

export const DEFAULT_MEMORY_LIMIT_MB = 512;
export const MIN_MEMORY_LIMIT_MB = 512;

/**
 * Parse a memory limit string (e.g. "256MB", "1GB") to bytes.
 * Returns default if string is invalid.
 */
export function parseMemoryLimit(str: string): number {
  const match = str.match(/^(\d+)\s*(MB|GB)$/i);
  if (!match) return DEFAULT_MEMORY_LIMIT_MB * 1024 * 1024;

  const value = parseInt(match[1]!, 10);
  const unit = match[2]!.toUpperCase();

  if (unit === "GB") return value * 1024 * 1024 * 1024;
  return value * 1024 * 1024; // MB
}
