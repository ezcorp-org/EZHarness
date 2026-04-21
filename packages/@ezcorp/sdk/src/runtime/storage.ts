// ── Storage — typed client for ezcorp/storage reverse RPC ───────
//
// Wraps the host's storage-handler (src/extensions/storage-handler.ts)
// with a scoped, promise-returning class. Pre-send 1 MB guard mirrors
// the host's MAX_VALUE_BYTES so callers fail fast instead of eating a
// round-trip for a doomed `set`. Throttle backoff on error code
// -32029 rides out transient rate-limit spikes with exponential
// spacing from 20ms.

import { getChannel, JsonRpcError } from "./channel";

export type StorageScope = "global" | "conversation" | "user";

// Host limit mirrored client-side. Source:
// src/extensions/storage-handler.ts MAX_VALUE_BYTES.
const MAX_VALUE_BYTES = 1 * 1024 * 1024;

// -32029 throttle backoff — start 20ms, double each retry, 5 max.
const THROTTLE_BASE_DELAY_MS = 20;
const THROTTLE_MAX_RETRIES = 5;
const THROTTLE_ERROR_CODE = -32029;

export interface StorageGetResult<T> {
  value: T | null;
  exists: boolean;
}

export interface StorageSetResult {
  ok: true;
  sizeBytes: number;
}

export interface StorageSetOptions {
  encrypted?: boolean;
  ttlSeconds?: number;
}

export interface StorageListOptions {
  prefix?: string;
  limit?: number;
}

export interface StorageListResult {
  keys: string[];
}

export interface StorageDeleteResult {
  deleted: boolean;
}

export type StorageBatchOp =
  | { action: "get"; key: string }
  | {
      action: "set";
      key: string;
      value: unknown;
      encrypted?: boolean;
      ttlSeconds?: number;
    }
  | { action: "delete"; key: string };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function guardValueSize(key: string, value: unknown): void {
  const bytes = Buffer.byteLength(JSON.stringify(value), "utf8");
  if (bytes > MAX_VALUE_BYTES) {
    throw new Error(
      `[@ezcorp/sdk] Storage: value exceeds 1 MB limit for key '${key}' (${bytes} bytes)`,
    );
  }
}

// Duck-typed code extraction — channel-native rejections arrive as
// plain `Error` without a code today (channel.ts:184-189 drops it),
// but JsonRpcError carriers and test-injected rejections propagate
// `.code`. Accept any numeric `code` field.
function errorCode(err: unknown): number | null {
  if (err instanceof JsonRpcError) return err.code;
  if (typeof err === "object" && err !== null && "code" in err) {
    const code = (err as { code: unknown }).code;
    if (typeof code === "number") return code;
  }
  return null;
}

export class Storage {
  private readonly scope: StorageScope;

  constructor(scope: StorageScope = "global") {
    this.scope = scope;
  }

  async get<T = unknown>(key: string): Promise<StorageGetResult<T>> {
    return this.request<StorageGetResult<T>>({
      action: "get",
      scope: this.scope,
      key,
    });
  }

  async set<T = unknown>(
    key: string,
    value: T,
    opts?: StorageSetOptions,
  ): Promise<StorageSetResult> {
    guardValueSize(key, value);
    const params: Record<string, unknown> = {
      action: "set",
      scope: this.scope,
      key,
      value,
    };
    if (opts?.encrypted !== undefined) params.encrypted = opts.encrypted;
    if (opts?.ttlSeconds !== undefined) params.ttlSeconds = opts.ttlSeconds;
    return this.request<StorageSetResult>(params);
  }

  async delete(key: string): Promise<StorageDeleteResult> {
    return this.request<StorageDeleteResult>({
      action: "delete",
      scope: this.scope,
      key,
    });
  }

  async list(opts?: StorageListOptions): Promise<StorageListResult> {
    const params: Record<string, unknown> = {
      action: "list",
      scope: this.scope,
    };
    if (opts?.prefix !== undefined) params.prefix = opts.prefix;
    if (opts?.limit !== undefined) params.limit = opts.limit;
    return this.request<StorageListResult>(params);
  }

  async batch(operations: StorageBatchOp[]): Promise<unknown[]> {
    for (const op of operations) {
      if (op.action === "set") guardValueSize(op.key, op.value);
    }
    const result = await this.request<{ results: unknown[] }>({
      action: "batch",
      scope: this.scope,
      operations,
    });
    return result.results;
  }

  private async request<T>(params: Record<string, unknown>): Promise<T> {
    let delay = THROTTLE_BASE_DELAY_MS;
    for (let attempt = 0; attempt <= THROTTLE_MAX_RETRIES; attempt++) {
      try {
        return await getChannel().request<T>("ezcorp/storage", params);
      } catch (err) {
        if (
          errorCode(err) === THROTTLE_ERROR_CODE &&
          attempt < THROTTLE_MAX_RETRIES
        ) {
          await sleep(delay);
          delay *= 2;
          continue;
        }
        throw err;
      }
    }
    // Unreachable — the loop either returns or throws on every branch.
    throw new Error("[@ezcorp/sdk] Storage: unreachable backoff loop exit");
  }
}
