// ── Storage — typed client for ezcorp/storage reverse RPC ───────
//
// Wraps the host's storage-handler (src/extensions/storage-handler.ts)
// with a scoped, promise-returning class. Pre-send 1 MB guard mirrors
// the host's MAX_VALUE_BYTES so callers fail fast instead of eating a
// round-trip for a doomed `set`. Backoff rides out TRANSIENT rate-limit
// spikes — both the throttle code (-32029) and the per-second token-bucket
// limit (-32004, host MAX_OPS_PER_SECOND) — with exponential spacing from
// 20ms; a persistent limit still surfaces on the final attempt.
//
// `list()` NORMALIZES its wire payload: the host returns `listStorageKeys()`
// output verbatim, whose DB query yields row OBJECTS, not the bare strings the
// declared `StorageListResult` promises (see `list` below).

import { getChannel, JsonRpcError } from "./channel";

export type StorageScope = "global" | "conversation" | "user";

// Host limit mirrored client-side. Source:
// src/extensions/storage-handler.ts MAX_VALUE_BYTES.
const MAX_VALUE_BYTES = 1 * 1024 * 1024;

// Transient-limit backoff — start 20ms, double each retry, 5 max.
const THROTTLE_BASE_DELAY_MS = 20;
const THROTTLE_MAX_RETRIES = 5;
// -32029: the storage handler's own throttle. -32004: the host's per-second
// token-bucket limit (MAX_OPS_PER_SECOND) — a burst (pipeline writes + an
// SSE-triggered render re-pull storm) trips it; a short backoff clears the
// bucket. Both are TRANSIENT, so both retry on the same ladder.
const THROTTLE_ERROR_CODE = -32029;
const RATE_LIMIT_ERROR_CODE = -32004;
const TRANSIENT_ERROR_CODES: ReadonlySet<number> = new Set([
  THROTTLE_ERROR_CODE,
  RATE_LIMIT_ERROR_CODE,
]);

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

/**
 * Normalize the host's `list` payload into the declared `string[]`. The host's
 * `handleList` returns `listStorageKeys()` output VERBATIM, and that DB query
 * yields row OBJECTS — `{ key, sizeBytes, encrypted, expiresAt }` — not the
 * bare strings `StorageListResult` promises (src/db/queries/extension-storage.ts
 * :110). Left unhandled, a consumer that feeds these back into `get(key)` sends
 * an object where a string is required and the host rejects it with
 * -32602 "Key contains invalid characters". Normalizing HERE (the SDK boundary,
 * DRY) fixes every consumer with no ext change. Accept `string | { key: string
 * }` per element; drop anything else (defence against future shape drift).
 */
function normalizeListKeys(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const keys: string[] = [];
  for (const el of raw) {
    if (typeof el === "string") {
      keys.push(el);
    } else if (el && typeof el === "object" && typeof (el as { key?: unknown }).key === "string") {
      keys.push((el as { key: string }).key);
    }
  }
  return keys;
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
    // The host may deliver `keys` as row objects, not strings — normalize to the
    // declared `string[]` so consumers can feed each key straight into `get()`.
    const result = await this.request<{ keys?: unknown }>(params);
    return { keys: normalizeListKeys(result.keys) };
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
        const code = errorCode(err);
        if (
          code !== null &&
          TRANSIENT_ERROR_CODES.has(code) &&
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
