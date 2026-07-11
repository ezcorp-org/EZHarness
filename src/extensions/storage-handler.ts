/**
 * Handles `ezcorp/storage` reverse RPC requests from extension subprocesses.
 * Provides isolated, DB-backed key-value storage with encryption, quotas, and rate limiting.
 */

import type { JsonRpcRequest, JsonRpcResponse, ExtensionPermissions, ExtensionManifestV2 } from "./types";
import type { PermissionEngine } from "./permission-engine";
import {
  getStorageValue,
  setStorageValue,
  deleteStorageValue,
  listStorageKeys,
  getStorageUsage,
} from "../db/queries/extension-storage";
import { getConversationExtensionIds } from "../db/queries/conversation-extensions";
import { decrypt } from "../providers/encryption";
import { encryptStorageValue } from "./secret-settings";
import { createRateLimiter } from "./rate-limit";
import { rpcError, rpcResult } from "./json-rpc";

// ── Constants ────────────────────────────────────────────────────────

const DEFAULT_QUOTA_BYTES = 5 * 1024 * 1024;   // 5 MB
const MAX_QUOTA_BYTES = 100 * 1024 * 1024;      // 100 MB
const MAX_VALUE_BYTES = 1 * 1024 * 1024;         // 1 MB per key
const MAX_KEY_LENGTH = 256;
const MAX_OPS_PER_SECOND = 50;
const KEY_REGEX = /^[a-zA-Z0-9_.\-/:]{1,256}$/;
const RESERVED_PREFIXES = ["__", "ezcorp/"];

// ── Rate limiter (per extension) ────────────────────────────────────

const consumeTokens = createRateLimiter(MAX_OPS_PER_SECOND);

// ── Key validation ──────────────────────────────────────────────────

function validateKey(key: string, isBuiltin: boolean): string | null {
  if (!key || key.length > MAX_KEY_LENGTH) return "Key must be 1-256 characters";
  if (!KEY_REGEX.test(key)) return "Key contains invalid characters";
  if (key.startsWith(".") || key.endsWith(".")) return "Key cannot start/end with dot";
  if (key.startsWith("/") || key.endsWith("/")) return "Key cannot start/end with slash";
  if (!isBuiltin) {
    for (const prefix of RESERVED_PREFIXES) {
      if (key.startsWith(prefix)) return `Key prefix '${prefix}' is reserved`;
    }
  }
  return null;
}

// ── Quota parsing ───────────────────────────────────────────────────

function parseStorageQuota(manifest: ExtensionManifestV2): number {
  const raw = manifest.resources?.storage;
  if (!raw) return DEFAULT_QUOTA_BYTES;
  const match = raw.match(/^(\d+)\s*(KB|MB|GB)$/i);
  if (!match) return DEFAULT_QUOTA_BYTES;
  const num = parseInt(match[1]!, 10);
  const unit = match[2]!.toUpperCase();
  const multiplier = unit === "KB" ? 1024 : unit === "MB" ? 1024 * 1024 : 1024 * 1024 * 1024;
  return Math.min(num * multiplier, MAX_QUOTA_BYTES);
}

// ── Scope resolution ────────────────────────────────────────────────

type Scope = "global" | "conversation" | "user";

function resolveScopeId(scope: Scope, ctx: StorageContext): string | null {
  switch (scope) {
    // "global" is deliberately OWNERLESS: one install-wide bucket per
    // extension (scopeId NULL), shared across ALL users. That is what
    // makes it reachable from ownerless cron fires (schedule-daemon
    // fires carry no user or conversation) — see
    // docs/extensions/examples/substack-engagement/index.ts, locked
    // decision #4. Never put per-user data here; `handleSet` rejects
    // encrypted writes to this scope so secrets can't land in the
    // shared bucket.
    case "global": return null;
    case "conversation": return ctx.conversationId;
    case "user": return ctx.userId;
  }
}

// ── Context passed by tool-executor ─────────────────────────────────

export interface StorageContext {
  conversationId: string;
  userId: string;
  manifest: ExtensionManifestV2;
  grantedPermissions: ExtensionPermissions;
  /**
   * Phase 6: optional PDP for the canonical "is this allowed?" check.
   * When supplied, the handler delegates the permission decision to
   * `engine.authorize`. The field is optional so older callers (tests
   * that pre-date the PDP wiring) keep working with the same context
   * shape — the handler falls back to a structural boolean check when
   * `engine` is undefined. New production callers in
   * `tool-executor.ts` always thread the singleton.
   */
  engine?: PermissionEngine;
}

/**
 * Pre-flight for per-key actions (get/set/delete): validate the key shape
 * and consume one rate-limit token. Returns a `JsonRpcResponse` error to
 * forward to the caller, or `null` when the action is cleared to proceed.
 */
function preflightKeyOp(
  extensionId: string,
  id: number | string,
  key: string,
  isBuiltin: boolean,
  skipRateLimit: boolean,
): JsonRpcResponse | null {
  const keyErr = validateKey(key, isBuiltin);
  if (keyErr) return rpcError(id, -32602, keyErr);
  if (!skipRateLimit && !consumeTokens(extensionId, 1)) {
    return rpcError(id, -32004, "Rate limited");
  }
  return null;
}

// ── Main handler ────────────────────────────────────────────────────

export async function handleStorageRpc(
  extensionId: string,
  req: JsonRpcRequest,
  ctx: StorageContext,
): Promise<JsonRpcResponse> {
  const params = (req.params ?? {}) as Record<string, unknown>;
  const isBuiltin = extensionId === "builtin";

  // Phase 6: PDP is the sole gate. When `ctx.engine` is wired, the
  // handler defers the permission decision to `engine.authorize` so
  // the audit log records the call and always-allow semantics apply
  // uniformly. Builtin extensions are always allowed (the host's own
  // storage scope, never user-controlled). The legacy boolean check
  // remains as the fallback for context that pre-dates the PDP
  // wiring (some unit tests).
  if (!isBuiltin) {
    if (ctx.engine) {
      const decision = await ctx.engine.authorize(
        {
          extensionId,
          userId: ctx.userId && ctx.userId !== "unknown" ? ctx.userId : null,
          conversationId:
            ctx.conversationId && ctx.conversationId !== "unknown"
              ? ctx.conversationId
              : null,
          toolName: "ezcorp/storage",
        },
        [{ kind: "storage" }],
      );
      if (decision.decision === "deny") {
        return rpcError(req.id, -32001, "Storage permission not granted");
      }
    } else if (!ctx.grantedPermissions.storage) {
      // Legacy fallback for callers that didn't thread the engine.
      return rpcError(req.id, -32001, "Storage permission not granted");
    }
  }

  const action = params.action as string;
  if (!action) return rpcError(req.id, -32602, "Missing 'action' parameter");

  const scope = (params.scope as Scope) ?? "global";
  if (!["global", "conversation", "user"].includes(scope)) {
    return rpcError(req.id, -32602, "Invalid scope: must be global, conversation, or user");
  }

  const scopeId = resolveScopeId(scope, ctx);

  // Reject scoped storage when the required context is unavailable
  if (scope === "conversation" && (!scopeId || scopeId === "unknown")) {
    return rpcError(req.id, -32602, "Conversation scope unavailable in this context");
  }
  if (scope === "user" && (!scopeId || scopeId === "unknown")) {
    return rpcError(req.id, -32602, "User scope unavailable in this context");
  }

  // Validate conversation scope: extension must be wired to this conversation
  if (scope === "conversation" && !isBuiltin) {
    const extIds = await getConversationExtensionIds(ctx.conversationId);
    if (!extIds.includes(extensionId)) {
      return rpcError(req.id, -32001, "Extension not wired to this conversation");
    }
  }

  switch (action) {
    case "get": return handleGet(extensionId, req.id, params, scope, scopeId, isBuiltin);
    case "set": return handleSet(extensionId, req.id, params, scope, scopeId, ctx.manifest, isBuiltin);
    case "delete": return handleDelete(extensionId, req.id, params, scope, scopeId, isBuiltin);
    case "list": return handleList(extensionId, req.id, params, scope, scopeId);
    case "batch": return handleBatch(extensionId, req.id, params, scope, scopeId, ctx.manifest, isBuiltin);
    default: return rpcError(req.id, -32602, `Unknown action: ${action}`);
  }
}

// ── Action handlers ─────────────────────────────────────────────────

async function handleGet(
  extensionId: string, id: number | string,
  params: Record<string, unknown>, scope: Scope, scopeId: string | null,
  isBuiltin: boolean, skipRateLimit = false,
): Promise<JsonRpcResponse> {
  const key = params.key as string;
  const pre = preflightKeyOp(extensionId, id, key, isBuiltin, skipRateLimit);
  if (pre) return pre;

  const row = await getStorageValue(extensionId, scope, scopeId, key);
  if (!row) return rpcResult(id, { value: null, exists: false });

  let value = row.value;
  if (row.encrypted) {
    try {
      value = JSON.parse(decrypt(value as string));
    } catch {
      return rpcError(id, -32603, "Failed to decrypt stored value");
    }
  }

  return rpcResult(id, { value, exists: true });
}

async function handleSet(
  extensionId: string, id: number | string,
  params: Record<string, unknown>, scope: Scope, scopeId: string | null,
  manifest: ExtensionManifestV2, isBuiltin: boolean, skipRateLimit = false,
): Promise<JsonRpcResponse> {
  const key = params.key as string;
  const pre = preflightKeyOp(extensionId, id, key, isBuiltin, skipRateLimit);
  if (pre) return pre;

  const shouldEncrypt = params.encrypted === true;

  // Security: "global" scope is install-wide — one bucket shared by every
  // user of this extension (resolveScopeId → NULL). `encrypted: true` is
  // the API's "this is a secret" signal (docs/extensions/settings.md), and
  // per-user secrets must never land in a cross-user bucket, so encrypted
  // writes require an owner-bound scope. Builtin keeps the exemption it
  // has everywhere else (host-internal storage, never user-controlled).
  if (shouldEncrypt && scope === "global" && !isBuiltin) {
    return rpcError(
      id,
      -32602,
      "Encrypted values cannot use 'global' scope — it is shared across all users; use scope 'user' (or 'conversation') for secrets",
    );
  }

  let valueToStore: unknown = params.value;
  const serialized = JSON.stringify(valueToStore);
  const sizeBytes = Buffer.byteLength(serialized, "utf-8");

  if (sizeBytes > MAX_VALUE_BYTES) {
    return rpcError(id, -32602, `Value too large: ${sizeBytes} bytes (max ${MAX_VALUE_BYTES})`);
  }

  // Quota check
  const quota = parseStorageQuota(manifest);
  const usage = await getStorageUsage(extensionId);
  // Account for existing key size (upsert replaces it)
  const existing = await getStorageValue(extensionId, scope, scopeId, key);
  const delta = sizeBytes - (existing?.sizeBytes ?? 0);
  if (usage.totalBytes + delta > quota) {
    return rpcError(id, -32002, `Storage quota exceeded (${quota} bytes)`);
  }

  // Encrypt if requested — via the shared canonical helper so this path
  // and the host-side secret-settings write stay byte-identical.
  if (shouldEncrypt) {
    valueToStore = encryptStorageValue(valueToStore).stored;
  }

  const rawTtl = params.ttlSeconds;
  const ttlSeconds = typeof rawTtl === "number" && rawTtl > 0 && rawTtl <= 31_536_000 ? rawTtl : undefined;
  if (rawTtl !== undefined && !ttlSeconds) {
    return rpcError(id, -32602, "ttlSeconds must be a positive number (max 31536000 / 1 year)");
  }
  const expiresAt = ttlSeconds
    ? new Date(Date.now() + ttlSeconds * 1000)
    : undefined;

  await setStorageValue(extensionId, scope, scopeId, key, valueToStore, shouldEncrypt, sizeBytes, expiresAt);

  return rpcResult(id, { ok: true, sizeBytes });
}

async function handleDelete(
  extensionId: string, id: number | string,
  params: Record<string, unknown>, scope: Scope, scopeId: string | null,
  isBuiltin: boolean, skipRateLimit = false,
): Promise<JsonRpcResponse> {
  const key = params.key as string;
  const pre = preflightKeyOp(extensionId, id, key, isBuiltin, skipRateLimit);
  if (pre) return pre;

  const deleted = await deleteStorageValue(extensionId, scope, scopeId, key);
  return rpcResult(id, { deleted });
}

async function handleList(
  extensionId: string, id: number | string,
  params: Record<string, unknown>, scope: Scope, scopeId: string | null,
): Promise<JsonRpcResponse> {
  if (!consumeTokens(extensionId, 1)) return rpcError(id, -32004, "Rate limited");

  const prefix = params.prefix as string | undefined;
  const limit = Math.min((params.limit as number) ?? 100, 1000);
  const keys = await listStorageKeys(extensionId, scope, scopeId, prefix, limit);

  return rpcResult(id, { keys });
}

async function handleBatch(
  extensionId: string, id: number | string,
  params: Record<string, unknown>, scope: Scope, scopeId: string | null,
  manifest: ExtensionManifestV2, isBuiltin: boolean,
): Promise<JsonRpcResponse> {
  const operations = params.operations as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(operations) || operations.length === 0) {
    return rpcError(id, -32602, "Batch requires non-empty 'operations' array");
  }
  if (operations.length > 100) {
    return rpcError(id, -32602, "Batch limited to 100 operations");
  }
  if (!consumeTokens(extensionId, operations.length)) {
    return rpcError(id, -32004, "Rate limited");
  }

  const results: unknown[] = [];
  for (const op of operations) {
    const opAction = op.action as string;
    const opParams = { ...op, scope };
    let result: JsonRpcResponse;
    // skipRateLimit=true: tokens already consumed upfront for the whole batch
    switch (opAction) {
      case "get":
        result = await handleGet(extensionId, id, opParams, scope, scopeId, isBuiltin, true);
        break;
      case "set":
        result = await handleSet(extensionId, id, opParams, scope, scopeId, manifest, isBuiltin, true);
        break;
      case "delete":
        result = await handleDelete(extensionId, id, opParams, scope, scopeId, isBuiltin, true);
        break;
      default:
        result = rpcError(id, -32602, `Unknown batch action: ${opAction}`);
    }
    results.push(result.error ?? result.result);
  }

  return rpcResult(id, { results });
}
