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
import { deriveHandlerContext, type HandlerContext, type RegisteredToolStub } from "./handler-context";
import { recordCapabilityCall } from "./recordCapabilityCall";
import { getDb } from "../db/connection";
import { memories } from "../db/schema";
import { sql, eq, and } from "drizzle-orm";
import type { ExtensionPermissions, JsonRpcRequest, JsonRpcResponse } from "./types";
import type { MemoryProvenance } from "../memory/types";
import { insertMemoryWithDailyExtensionQuota, memoryOwnedByUser } from "../db/queries/memories";
import { getProject } from "../db/queries/projects";
import { toVectorLiteral } from "../memory/vector-utils";

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

function softFail(req: JsonRpcRequest, reason: string, code = -32001): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code, message: reason, data: { reason } },
  };
}

type MemoryGrant = NonNullable<ExtensionPermissions["memory"]>;
type MemoryRow = typeof memories.$inferSelect;

interface ActionInput {
  req: JsonRpcRequest;
  params: MemoryHandlerParams;
  granted: MemoryGrant;
  handlerCtx: HandlerContext;
  ctx: MemoryHandlerContext;
  startedAt: number;
}

type ActionHandler = (a: ActionInput) => Promise<JsonRpcResponse>;

const listMemories: ActionHandler = async ({ req, params, granted, handlerCtx, startedAt }) => {
  // Always scope to the acting user — memories are per-user PII and
  // feed LLM context. `selfOnly` narrows further to this extension's
  // own memories, but is NOT a substitute for the user filter:
  // a shared (e.g. bundled) extension identity runs on behalf of
  // every user, so without this an extension acting for user B would
  // read user A's memories. `onBehalfOf` is host-stamped, never RPC.
  const conditions = [memoryOwnedByUser(handlerCtx.onBehalfOf)];
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
  const rows = await getDb().select().from(memories).where(where as never).limit(limit);
  await recordCapabilityCall({
    ctx: handlerCtx, capability: "memory", action: "list",
    durationMs: Date.now() - startedAt, success: true,
    after: { count: rows.length },
    insertChatPill: false,
  });
  return { jsonrpc: "2.0", id: req.id, result: { memories: rows.map(stripPrivate) } };
};

const getMemory: ActionHandler = async ({ req, params, granted, handlerCtx }) => {
  if (typeof params.id !== "string") return softFail(req, "id required");
  // userId in the WHERE → cross-user fetch returns an opaque
  // not-found rather than another user's memory.
  const rows = await getDb()
    .select()
    .from(memories)
    .where(and(eq(memories.id, params.id), memoryOwnedByUser(handlerCtx.onBehalfOf)));
  if (rows.length === 0) return softFail(req, "not-found");
  const row = rows[0]!;
  const prov = row.provenance as (MemoryProvenance & { extensionId?: string }) | null;
  if (granted.selfOnly && prov?.extensionId !== handlerCtx.actorExtensionId) {
    return softFail(req, "selfOnly-forbidden");
  }
  return { jsonrpc: "2.0", id: req.id, result: { memory: stripPrivate(row) } };
};

const writeMemory: ActionHandler = async ({ req, params, granted, handlerCtx, ctx, startedAt }) => {
  if (!params.input) return softFail(req, "input required");
  if (granted.categories && !granted.categories.includes(params.input.category)) {
    return softFail(req, "category-not-allowed");
  }
  if (params.input.projectId) {
    const project = await getProject(params.input.projectId);
    if (!project) return softFail(req, "project-not-found");
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
  const inserted = await insertMemoryWithDailyExtensionQuota({
    content: params.input.content,
    category: params.input.category,
    ...(params.input.projectId !== undefined ? { projectId: params.input.projectId ?? null } : {}),
    ...(params.input.projectId ? { projectIds: [params.input.projectId] } : {}),
    ...(handlerCtx.conversationId ? { conversationId: handlerCtx.conversationId } : {}),
    confidence: params.input.confidence ?? "medium",
    provenance: provenance as MemoryProvenance,
    injectionEligible: false,
    userId: handlerCtx.onBehalfOf,
    embedding,
  }, {
    extensionId: handlerCtx.actorExtensionId,
    day: todayUtcString(),
    maxWrites: granted.maxWritesPerDay,
  });
  if (!inserted) {
    const tomorrow = new Date();
    tomorrow.setUTCHours(24, 0, 0, 0);
    return {
      jsonrpc: "2.0", id: req.id,
      error: { code: -32103, message: "memory write quota exceeded",
               data: { reason: "writes-per-day", retryAfterMs: tomorrow.getTime() - Date.now() } },
    };
  }

  await recordCapabilityCall({
    ctx: handlerCtx, capability: "memory", action: "write",
    resourceType: "memory", resourceId: inserted.id,
    before: undefined,
    after: { id: inserted.id, category: params.input.category, contentSha256: hashStable(params.input.content) },
    durationMs: Date.now() - startedAt, success: true,
    insertChatPill: handlerCtx.conversationId !== null,
  });
  return { jsonrpc: "2.0", id: req.id, result: { memory: stripPrivate(inserted) } };
};

/**
 * Load the memory an update/archive targets. userId in the WHERE makes
 * another user's memory an opaque "not-found"; only the author extension
 * may change it ("not-author").
 */
async function loadOwnMemory(a: ActionInput): Promise<{ row: MemoryRow } | { error: JsonRpcResponse }> {
  if (typeof a.params.id !== "string") return { error: softFail(a.req, "id required") };
  const rows = await getDb()
    .select()
    .from(memories)
    .where(and(eq(memories.id, a.params.id), memoryOwnedByUser(a.handlerCtx.onBehalfOf)));
  if (rows.length === 0) return { error: softFail(a.req, "not-found") };
  const prov = rows[0]!.provenance as (MemoryProvenance & { extensionId?: string }) | null;
  if (prov?.extensionId !== a.handlerCtx.actorExtensionId) return { error: softFail(a.req, "not-author") };
  return { row: rows[0]! };
}

const updateMemory: ActionHandler = async (a) => {
  const loaded = await loadOwnMemory(a);
  if ("error" in loaded) return loaded.error;
  const { row } = loaded;
  const newContent = a.params.patch?.content;
  if (newContent !== undefined) {
    // Re-embed with the content so recall searches the new text, not the old.
    const embedding = await (a.ctx.embedFn ?? defaultEmbed)(newContent);
    await getDb().update(memories).set({
      content: newContent,
      embedding: sql.raw(toVectorLiteral(embedding)),
      updatedAt: new Date(),
    }).where(eq(memories.id, row.id));
  }
  await recordCapabilityCall({
    ctx: a.handlerCtx, capability: "memory", action: "update",
    resourceType: "memory", resourceId: row.id,
    durationMs: Date.now() - a.startedAt, success: true,
    perResourceAudit: {
      kind: "memory",
      memoryId: row.id,
      memoryAction: "updated",
      previousBody: row.content,
      newBody: newContent ?? row.content,
    },
    insertChatPill: a.handlerCtx.conversationId !== null,
  });
  return { jsonrpc: "2.0", id: a.req.id, result: { ok: true } };
};

const archiveMemory: ActionHandler = async (a) => {
  const loaded = await loadOwnMemory(a);
  if ("error" in loaded) return loaded.error;
  const { row } = loaded;
  await getDb().update(memories).set({ status: "archived", updatedAt: new Date() }).where(eq(memories.id, row.id));
  await recordCapabilityCall({
    ctx: a.handlerCtx, capability: "memory", action: "archive",
    resourceType: "memory", resourceId: row.id,
    durationMs: Date.now() - a.startedAt, success: true,
    perResourceAudit: {
      kind: "memory",
      memoryId: row.id,
      memoryAction: "status_change",
      previousBody: row.content,
      newBody: row.content,
    },
    insertChatPill: a.handlerCtx.conversationId !== null,
  });
  return { jsonrpc: "2.0", id: a.req.id, result: { ok: true } };
};

const ACTIONS: Record<MemoryHandlerParams["action"], ActionHandler> = {
  list: listMemories,
  get: getMemory,
  write: writeMemory,
  update: updateMemory,
  archive: archiveMemory,
};

const WRITE_ACTIONS: ReadonlySet<string> = new Set(["write", "update", "archive"]);

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

  if (WRITE_ACTIONS.has(params.action) && granted.access !== "write") {
    return softFail(req, "memory write access not granted");
  }

  const action = Object.hasOwn(ACTIONS, params.action) ? ACTIONS[params.action] : undefined;
  if (!action) return softFail(req, "unknown-action");
  return action({ req, params, granted, handlerCtx, ctx, startedAt });
}

function stripPrivate(row: typeof memories.$inferSelect): Record<string, unknown> {
  // Don't leak the embedding vector to the subprocess (it's bulky and
  // not useful client-side).
  const { embedding, ...rest } = row as Record<string, unknown>;
  void embedding;
  return rest;
}

function hashStable(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}
