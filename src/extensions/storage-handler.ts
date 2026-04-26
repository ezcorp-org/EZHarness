/**
 * Handles `ezcorp/storage` reverse RPC requests from extension subprocesses.
 * Provides isolated, DB-backed key-value storage with encryption, quotas, and rate limiting.
 */

import type { JsonRpcRequest, JsonRpcResponse, ExtensionPermissions, ExtensionManifestV2 } from "./types";
import {
  getStorageValue,
  setStorageValue,
  deleteStorageValue,
  listStorageKeys,
  getStorageUsage,
} from "../db/queries/extension-storage";
import { getConversationExtensionIds } from "../db/queries/conversation-extensions";
import { encrypt, decrypt } from "../providers/encryption";
import { createRateLimiter } from "./rate-limit";

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
}

// ── JSON-RPC error helpers ──────────────────────────────────────────

function rpcError(id: number | string, code: number, message: string): JsonRpcResponse {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function rpcResult(id: number | string, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id, result };
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

  // Permission check (builtin always allowed)
  if (!isBuiltin && !ctx.grantedPermissions.storage) {
    return rpcError(req.id, -32001, "Storage permission not granted");
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

  // Encrypt if requested
  if (shouldEncrypt) {
    valueToStore = encrypt(serialized);
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
