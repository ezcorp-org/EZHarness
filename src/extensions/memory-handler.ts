/**
 * `ezcorp/memory` reverse-RPC handler — `ctx.memory.{list,get,write,
 * update,archive}`.
 *
 * Locked invariants:
 *   - Provenance is stamped HOST-SIDE from `ctx.actorExtensionId`
 *     (never RPC meta — spoofing defense).
 *   - `injectionEligible` defaults to FALSE for extension-authored
 *     memories so they don't auto-inject into LLM system prompts.
 *   - `selfOnly: true` (default): list/get filter to memories whose
 *     `provenance.extensionId === ctx.actorExtensionId`.
 *   - update/archive: must be the author (rejects -32001 reason
 *     `"not-author"`).
 *   - Daily-write quota via `extension_memory_writes_daily`.
 */
import { logger } from "../logger";
import { deriveHandlerContext, type RegisteredToolStub } from "./handler-context";
import { recordCapabilityCall } from "./recordCapabilityCall";
import { getDb } from "../db/connection";
import { memories, extensionMemoryWritesDaily, conversations } from "../db/schema";
import { sql, eq, and, type SQL } from "drizzle-orm";
import type { ExtensionPermissions, JsonRpcRequest, JsonRpcResponse } from "./types";
import type { MemoryProvenance } from "../memory/types";

const log = logger.child("ext.memory-handler");

interface MemoryWriteInput {
  content: string;
  category: "preferences" | "biographical" | "technical" | "decisions_goals";
  confidence?: "high" | "medium" | "low";
  sourceMessageIds?: string[];
  projectId?: string | null;
}

interface MemoryHandlerParams {
  action: "list" | "get" | "write" | "update" | "archive";
  id?: string;
  input?: MemoryWriteInput;
  patch?: Partial<MemoryWriteInput> & { content?: string; confidence?: "high" | "medium" | "low" };
  /** list-only options. */
  category?: string;
  limit?: number;
}

export interface MemoryHandlerContext {
  granted: ExtensionPermissions;
  registeredTool: RegisteredToolStub;
  /** Test-only embedder swap. Production: Transformers.js
   *  all-MiniLM-L6-v2 via `src/memory/embedder.ts`. */
  embedFn?: (text: string) => Promise<number[]>;
}

const DEFAULT_DIM = 384;

async function defaultEmbed(text: string): Promise<number[]> {
  // Lazy import — production memory embedder is heavy
  // (Transformers.js). Tests inject a stub via `embedFn`.
  try {
    const mod = await import("../memory/embeddings");
    return mod.generateEmbedding(text);
  } catch {
    // Fallback: zero vector. Memory recall will be useless but the
    // call doesn't crash. Tests should always inject `embedFn`.
    return new Array<number>(DEFAULT_DIM).fill(0);
  }
}

function todayUtcString(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Track per-extension daily-write count + flush gate. Mirrors the
 *  rolling-day pattern from `llm-quota`. Inline here because the
 *  shape is much simpler (no rolling-hour, no tokens). */
const writeCounters = new Map<string, { day: string; count: number }>();

function checkAndConsumeWriteQuota(
  extensionId: string,
  maxWritesPerDay: number,
): { ok: true } | { ok: false; retryAfterMs: number } {
  const today = todayUtcString();
  let entry = writeCounters.get(extensionId);
  if (!entry || entry.day !== today) {
    entry = { day: today, count: 0 };
    writeCounters.set(extensionId, entry);
  }
  if (entry.count >= maxWritesPerDay) {
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    return { ok: false, retryAfterMs: tomorrow.getTime() - Date.now() };
  }
  entry.count += 1;
  // Async DB upsert — non-blocking.
  void (async () => {
    try {
      await getDb()
        .insert(extensionMemoryWritesDaily)
        .values({ extensionId, day: today, writes: entry!.count })
        .onConflictDoUpdate({
          target: [extensionMemoryWritesDaily.extensionId, extensionMemoryWritesDaily.day],
          set: { writes: entry!.count, updatedAt: sql`NOW()` },
        });
    } catch (err) {
      log.warn("write-quota-flush-failed", { extensionId, error: String(err) });
    }
  })();
  return { ok: true };
}

/** Test-only — clear quota counters. */
export function _resetMemoryWriteQuotaForTests(): void {
  writeCounters.clear();
}

/**
 * Predicate: the memory belongs to the acting user. Memories are
 * per-user PII, so every read/mutate path scopes to `onBehalfOf`
 * (host-stamped, never RPC). Two ownership shapes:
 *   - `userId` set (extension-written, or a future attributed row) →
 *     direct match.
 *   - `userId` NULL but `conversationId` set (host-extracted memories —
 *     `dedupAndWriteMemory`/compaction don't stamp userId) → derive the
 *     owner from the source conversation. This keeps host-extracted
 *     memories visible to THEIR user while still blocking a shared
 *     (bundled) extension acting for a different user.
 * A fully-orphaned row (NULL userId AND NULL conversationId) is visible
 * to no one — acceptable; such rows are unattributable.
 */
function ownedByActingUser(userId: string): SQL {
  return sql`(${memories.userId} = ${userId} OR (${memories.userId} IS NULL AND EXISTS (SELECT 1 FROM ${conversations} WHERE ${conversations.id} = ${memories.conversationId} AND ${conversations.userId} = ${userId})))`;
}

function softFail(req: JsonRpcRequest, reason: string, code = -32001): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code, message: reason, data: { reason } },
  };
}

export async function handlePiMemory(
  req: JsonRpcRequest,
  ctx: MemoryHandlerContext,
  rpcMeta?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const startedAt = Date.now();
  const handlerCtx = deriveHandlerContext(rpcMeta, ctx.registeredTool);
  const params = (req.params ?? {}) as unknown as MemoryHandlerParams;
  const granted = ctx.granted.memory;
  if (!granted) return softFail(req, "memory permission not granted");

  const isWriteAction = params.action === "write" || params.action === "update" || params.action === "archive";
  if (isWriteAction && granted.access !== "write") {
    return softFail(req, "memory write access not granted");
  }

  const db = getDb();

  switch (params.action) {
    case "list": {
      // Always scope to the acting user — memories are per-user PII and
      // feed LLM context. `selfOnly` narrows further to this extension's
      // own memories, but is NOT a substitute for the user filter:
      // a shared (e.g. bundled) extension identity runs on behalf of
      // every user, so without this an extension acting for user B would
      // read user A's memories. `onBehalfOf` is host-stamped, never RPC.
      const conditions = [ownedByActingUser(handlerCtx.onBehalfOf)];
      if (granted.selfOnly) {
        conditions.push(sql`provenance->>'extensionId' = ${handlerCtx.actorExtensionId}`);
      }
      if (typeof params.category === "string") {
        if (granted.categories && !granted.categories.includes(params.category as never)) {
          return softFail(req, "category-not-allowed");
        }
        conditions.push(eq(memories.category, params.category as never));
      }
      const limit = Math.min(typeof params.limit === "number" ? params.limit : 50, 200);
      const where = and(...conditions);
      const rows = await db.select().from(memories).where(where as never).limit(limit);
      await recordCapabilityCall({
        ctx: handlerCtx, capability: "memory", action: "list",
        durationMs: Date.now() - startedAt, success: true,
        after: { count: rows.length },
        insertChatPill: false,
      });
      return { jsonrpc: "2.0", id: req.id, result: { memories: rows.map(stripPrivate) } };
    }

    case "get": {
      if (typeof params.id !== "string") return softFail(req, "id required");
      // userId in the WHERE → cross-user fetch returns an opaque
      // not-found rather than another user's memory.
      const rows = await db
        .select()
        .from(memories)
        .where(and(eq(memories.id, params.id), ownedByActingUser(handlerCtx.onBehalfOf)));
      if (rows.length === 0) return softFail(req, "not-found");
      const row = rows[0]!;
      const prov = row.provenance as (MemoryProvenance & { extensionId?: string }) | null;
      if (granted.selfOnly && prov?.extensionId !== handlerCtx.actorExtensionId) {
        return softFail(req, "selfOnly-forbidden");
      }
      return { jsonrpc: "2.0", id: req.id, result: { memory: stripPrivate(row) } };
    }

    case "write": {
      if (!params.input) return softFail(req, "input required");
      if (granted.categories && !granted.categories.includes(params.input.category)) {
        return softFail(req, "category-not-allowed");
      }
      const quota = checkAndConsumeWriteQuota(handlerCtx.actorExtensionId, granted.maxWritesPerDay);
      if (!quota.ok) {
        return {
          jsonrpc: "2.0", id: req.id,
          error: { code: -32103, message: "memory write quota exceeded",
                   data: { reason: "writes-per-day", retryAfterMs: quota.retryAfterMs } },
        };
      }

      const embed = ctx.embedFn ?? defaultEmbed;
      const embedding = await embed(params.input.content);

      const provenance: MemoryProvenance & { extensionId: string; runId: string | null; injectionEligible: boolean } = {
        sourceConversationId: handlerCtx.conversationId ?? "",
        sourceMessageIds: params.input.sourceMessageIds ?? [],
        extractedAt: new Date(),
        confidence: params.input.confidence ?? "medium",
        history: [],
        extensionId: handlerCtx.actorExtensionId,
        runId: handlerCtx.runId,
        injectionEligible: false, // Locked: extension-authored memories don't auto-inject.
      };
      const [inserted] = await db.insert(memories).values({
        content: params.input.content,
        category: params.input.category,
        ...(params.input.projectId !== undefined ? { projectId: params.input.projectId ?? null } : {}),
        ...(handlerCtx.conversationId ? { conversationId: handlerCtx.conversationId } : {}),
        confidence: params.input.confidence ?? "medium",
        provenance: provenance as MemoryProvenance,
        injectionEligible: false,
        userId: handlerCtx.onBehalfOf,
      }).returning();

      // Write the embedding in a follow-up exec — vector assignments
      // need raw SQL (per memories.ts pattern).
      await db.execute(
        sql`UPDATE memories SET embedding = ${sql.raw(toVectorLiteral(embedding))} WHERE id = ${inserted!.id}`,
      );

      await recordCapabilityCall({
        ctx: handlerCtx, capability: "memory", action: "write",
        resourceType: "memory", resourceId: inserted!.id,
        before: undefined,
        after: { id: inserted!.id, category: params.input.category, contentSha256: hashStable(params.input.content) },
        durationMs: Date.now() - startedAt, success: true,
        perResourceAudit: {
          kind: "memory",
          memoryId: inserted!.id,
          memoryAction: "created",
          previousBody: null,
          newBody: params.input.content,
        },
        insertChatPill: handlerCtx.conversationId !== null,
      });
      return { jsonrpc: "2.0", id: req.id, result: { memory: stripPrivate(inserted!) } };
    }

    case "update": {
      if (typeof params.id !== "string") return softFail(req, "id required");
      const rows = await db
        .select()
        .from(memories)
        .where(and(eq(memories.id, params.id), ownedByActingUser(handlerCtx.onBehalfOf)));
      if (rows.length === 0) return softFail(req, "not-found");
      const row = rows[0]!;
      const prov = row.provenance as (MemoryProvenance & { extensionId?: string }) | null;
      if (prov?.extensionId !== handlerCtx.actorExtensionId) {
        return softFail(req, "not-author");
      }
      const newContent = params.patch?.content;
      if (newContent !== undefined) {
        await db.update(memories).set({ content: newContent, updatedAt: new Date() }).where(eq(memories.id, params.id));
      }
      await recordCapabilityCall({
        ctx: handlerCtx, capability: "memory", action: "update",
        resourceType: "memory", resourceId: params.id,
        durationMs: Date.now() - startedAt, success: true,
        perResourceAudit: {
          kind: "memory",
          memoryId: params.id,
          memoryAction: "updated",
          previousBody: row.content,
          newBody: newContent ?? row.content,
        },
        insertChatPill: handlerCtx.conversationId !== null,
      });
      return { jsonrpc: "2.0", id: req.id, result: { ok: true } };
    }

    case "archive": {
      if (typeof params.id !== "string") return softFail(req, "id required");
      const rows = await db
        .select()
        .from(memories)
        .where(and(eq(memories.id, params.id), ownedByActingUser(handlerCtx.onBehalfOf)));
      if (rows.length === 0) return softFail(req, "not-found");
      const row = rows[0]!;
      const prov = row.provenance as (MemoryProvenance & { extensionId?: string }) | null;
      if (prov?.extensionId !== handlerCtx.actorExtensionId) {
        return softFail(req, "not-author");
      }
      await db.update(memories).set({ status: "archived", updatedAt: new Date() }).where(eq(memories.id, params.id));
      await recordCapabilityCall({
        ctx: handlerCtx, capability: "memory", action: "archive",
        resourceType: "memory", resourceId: params.id,
        durationMs: Date.now() - startedAt, success: true,
        perResourceAudit: {
          kind: "memory",
          memoryId: params.id,
          memoryAction: "status_change",
          previousBody: row.content,
          newBody: row.content,
        },
        insertChatPill: handlerCtx.conversationId !== null,
      });
      return { jsonrpc: "2.0", id: req.id, result: { ok: true } };
    }

    default:
      return softFail(req, "unknown-action");
  }
}

function stripPrivate(row: typeof memories.$inferSelect): Record<string, unknown> {
  // Don't leak the embedding vector to the subprocess (it's bulky and
  // not useful client-side).
  const { embedding, ...rest } = row as Record<string, unknown>;
  void embedding;
  return rest;
}

function toVectorLiteral(vec: number[]): string {
  return `'[${vec.join(",")}]'::vector`;
}

function hashStable(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
