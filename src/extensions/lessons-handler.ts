/**
 * `ezcorp/lessons` reverse-RPC handler — `ctx.lessons.{list,get,write,
 * update,archive,recordFired,recordDismissed}`.
 *
 * Locked invariants:
 *   - `authorExtensionId` stamped HOST-SIDE from
 *     `handlerCtx.actorExtensionId` (never RPC meta).
 *   - `visibility` clamped to `granted.maxVisibility` (default
 *     "user"). Extensions cannot grant themselves global.
 *   - Composite slug uniqueness via the migration's
 *     `idx_lessons_user_slug_unique` partial index. On collision the
 *     handler returns the existing row with `created: false` instead
 *     of a hard error (soft outcome, surfaced via the SDK return shape).
 *   - `update` ownership gate: extension must be the author.
 */
import { logger } from "../logger";
import { deriveHandlerContext, type HandlerContext, type RegisteredToolStub } from "./handler-context";
import { recordCapabilityCall } from "./recordCapabilityCall";
import { getDb } from "../db/connection";
import { lessons, extensionLessonsWritesDaily } from "../db/schema";
import { sql, eq, and, type SQL } from "drizzle-orm";
import { insertAuditEntry } from "../db/queries/audit-log";
import { EXT_AUDIT_ACTIONS } from "./audit-actions";
import type { ExtensionPermissions, JsonRpcRequest, JsonRpcResponse } from "./types";

const log = logger.child("ext.lessons-handler");

const SLUG_RE = /^[a-z0-9-]{1,80}$/;

interface LessonInput {
  slug: string;
  title: string;
  body: string;
  visibility?: "user" | "project" | "global";
  frontmatter?: Record<string, unknown>;
  projectId: string;
}

interface LessonsParams {
  action: "list" | "get" | "write" | "update" | "archive" | "recordFired" | "recordDismissed";
  id?: string;
  slug?: string;
  projectId?: string;
  input?: LessonInput;
  patch?: Partial<LessonInput>;
  limit?: number;
}

export interface LessonsHandlerContext {
  granted: ExtensionPermissions;
  registeredTool: RegisteredToolStub;
}

/** Test-only — clear the in-process write counters. */
const writeCounters = new Map<string, { day: string; count: number }>();
export function _resetLessonsWriteQuotaForTests(): void {
  writeCounters.clear();
}

function todayUtcString(): string {
  return new Date().toISOString().slice(0, 10);
}

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
  void (async () => {
    try {
      await getDb()
        .insert(extensionLessonsWritesDaily)
        .values({ extensionId, day: today, writes: entry!.count })
        .onConflictDoUpdate({
          target: [extensionLessonsWritesDaily.extensionId, extensionLessonsWritesDaily.day],
          set: { writes: entry!.count, updatedAt: sql`NOW()` },
        });
    } catch (err) {
      log.warn("write-quota-flush-failed", { extensionId, error: String(err) });
    }
  })();
  return { ok: true };
}

function softFail(req: JsonRpcRequest, reason: string, code = -32001): JsonRpcResponse {
  return {
    jsonrpc: "2.0", id: req.id,
    error: { code, message: reason, data: { reason } },
  };
}

function isUniqueViolationError(err: unknown): boolean {
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur != null; i++) {
    const code = (cur as { code?: string }).code;
    if (code === "23505") return true;
    const message = (cur as { message?: string }).message;
    if (typeof message === "string" && /duplicate key|unique constraint/i.test(message)) return true;
    const next = (cur as { cause?: unknown }).cause;
    if (next === cur) break;
    cur = next;
  }
  return false;
}

function clampVisibility(
  requested: "user" | "project" | "global" | undefined,
  maxVisibility: "user" | "project",
): "user" | "project" {
  if (requested === "project" && maxVisibility === "project") return "project";
  // "global" requests are always clamped down to maxVisibility per
  // locked decision (extensions cannot grant themselves global).
  return "user";
}

type LessonsGrant = NonNullable<ExtensionPermissions["lessons"]>;
type LessonRow = typeof lessons.$inferSelect;

interface ActionInput {
  req: JsonRpcRequest;
  params: LessonsParams;
  granted: LessonsGrant;
  handlerCtx: HandlerContext;
  startedAt: number;
}

type ActionHandler = (a: ActionInput) => Promise<JsonRpcResponse>;

function ok(req: JsonRpcRequest, result: unknown): JsonRpcResponse {
  return { jsonrpc: "2.0", id: req.id, result };
}

/**
 * Rows an extension may see: ones it wrote for the user it acts for.
 * Same per-user scope as `ctx.memory` — without the owner filter, an
 * extension acting for user B could read or change user A's lessons.
 */
function ownLessons(handlerCtx: HandlerContext) {
  return and(
    eq(lessons.authorExtensionId, handlerCtx.actorExtensionId),
    eq(lessons.ownerId, handlerCtx.onBehalfOf),
  );
}

/**
 * Load the lesson an id-based mutation targets. Another user's lesson is
 * "not-found" (opaque, like memory); another extension's is "not-author".
 */
async function loadOwnLesson(a: ActionInput): Promise<{ row: LessonRow } | { error: JsonRpcResponse }> {
  if (typeof a.params.id !== "string") return { error: softFail(a.req, "id required") };
  const rows = await getDb().select().from(lessons)
    .where(and(eq(lessons.id, a.params.id), eq(lessons.ownerId, a.handlerCtx.onBehalfOf)));
  if (rows.length === 0) return { error: softFail(a.req, "not-found") };
  if (rows[0]!.authorExtensionId !== a.handlerCtx.actorExtensionId) {
    return { error: softFail(a.req, "not-author") };
  }
  return { row: rows[0]! };
}

const listLessons: ActionHandler = async ({ req, params, handlerCtx, startedAt }) => {
  const conditions = [ownLessons(handlerCtx)];
  if (typeof params.projectId === "string") {
    conditions.push(eq(lessons.projectId, params.projectId));
  }
  const rows = await getDb().select().from(lessons).where(and(...conditions))
    .limit(Math.min(typeof params.limit === "number" ? params.limit : 50, 200));
  await recordCapabilityCall({
    ctx: handlerCtx, capability: "lessons", action: "list",
    durationMs: Date.now() - startedAt, success: true,
    after: { count: rows.length },
    insertChatPill: false,
  });
  return ok(req, { lessons: rows });
};

/** `get` looks a lesson up by id, or else by slug within a project. */
function lessonKey(params: LessonsParams): SQL | undefined {
  if (typeof params.id === "string") return eq(lessons.id, params.id);
  if (typeof params.slug === "string" && typeof params.projectId === "string") {
    return and(eq(lessons.slug, params.slug), eq(lessons.projectId, params.projectId));
  }
  return undefined;
}

const getLesson: ActionHandler = async ({ req, params, handlerCtx }) => {
  const key = lessonKey(params);
  if (!key) return softFail(req, "id or (slug+projectId) required");
  const rows = await getDb().select().from(lessons).where(and(key, ownLessons(handlerCtx)));
  return ok(req, { lesson: rows[0] ?? null });
};

const writeLesson: ActionHandler = async ({ req, params, granted, handlerCtx, startedAt }) => {
  if (!params.input) return softFail(req, "input required");
  if (!SLUG_RE.test(params.input.slug)) return softFail(req, "invalid-slug");
  const db = getDb();

  const requestedVisibility = params.input.visibility;
  const visibility = clampVisibility(requestedVisibility, granted.maxVisibility);
  // Phase 51.3.5 audit: emit a soft governance row when the
  // requested visibility was higher than the granted ceiling.
  // Soft outcome — the call still succeeds with the clamped value.
  if (
    requestedVisibility !== undefined
    && requestedVisibility !== visibility
  ) {
    await insertAuditEntry(
      handlerCtx.onBehalfOf,
      EXT_AUDIT_ACTIONS.SDK_LESSONS_VISIBILITY_CLAMPED,
      handlerCtx.actorExtensionId,
      {
        capability: "lessons",
        oldValue: requestedVisibility,
        newValue: visibility,
        actor: "system",
        reason: `visibility clamped: requested=${requestedVisibility}, max=${granted.maxVisibility}`,
      },
    ).catch(() => {});
  }

  const quota = checkAndConsumeWriteQuota(handlerCtx.actorExtensionId, granted.maxWritesPerDay);
  if (!quota.ok) {
    return {
      jsonrpc: "2.0", id: req.id,
      error: { code: -32103, message: "lessons write quota exceeded",
               data: { reason: "writes-per-day", retryAfterMs: quota.retryAfterMs } },
    };
  }

  // Try to insert; on slug-collision, fetch the existing row and
  // return `created: false`.
  try {
    const [inserted] = await db.insert(lessons).values({
      projectId: params.input.projectId,
      ownerId: handlerCtx.onBehalfOf,
      visibility,
      slug: params.input.slug,
      title: params.input.title,
      body: params.input.body,
      ...(params.input.frontmatter ? { frontmatter: params.input.frontmatter } : {}),
      // Type tweak: source enum extended to include "extension"
      // by Phase 51's spec; cast to satisfy current Drizzle inferred type.
      source: "extension" as never,
      authorExtensionId: handlerCtx.actorExtensionId,
    }).returning();

    await recordCapabilityCall({
      ctx: handlerCtx, capability: "lessons", action: "write",
      resourceType: "lesson", resourceId: inserted!.id,
      after: { id: inserted!.id, slug: inserted!.slug, visibility, created: true },
      durationMs: Date.now() - startedAt, success: true,
      perResourceAudit: {
        kind: "lesson",
        lessonId: inserted!.id,
        lessonAction: "created",
        previousBody: null,
        newBody: params.input.body,
        previousFrontmatter: null,
        newFrontmatter: params.input.frontmatter ?? null,
      },
      insertChatPill: handlerCtx.conversationId !== null,
    });
    return ok(req, { lesson: inserted, created: true });
  } catch (err) {
    if (!isUniqueViolationError(err)) throw err;
    // Slug-collision soft outcome: return existing row.
    const existing = await db.select().from(lessons).where(and(
      eq(lessons.projectId, params.input.projectId),
      eq(lessons.slug, params.input.slug),
      ownLessons(handlerCtx),
    ));
    return ok(req, { lesson: existing[0] ?? null, created: false });
  }
};

const updateLesson: ActionHandler = async (a) => {
  const { req, params, granted, handlerCtx, startedAt } = a;
  const loaded = await loadOwnLesson(a);
  if ("error" in loaded) return loaded.error;
  const { row } = loaded;
  const setVals: Record<string, unknown> = { updatedAt: new Date() };
  if (params.patch?.body !== undefined) setVals.body = params.patch.body;
  if (params.patch?.title !== undefined) setVals.title = params.patch.title;
  if (params.patch?.frontmatter !== undefined) setVals.frontmatter = params.patch.frontmatter;
  if (params.patch?.visibility !== undefined) {
    setVals.visibility = clampVisibility(params.patch.visibility, granted.maxVisibility);
  }
  await getDb().update(lessons).set(setVals).where(eq(lessons.id, row.id));

  const previousFrontmatter = (row.frontmatter as Record<string, unknown> | null) ?? null;
  await recordCapabilityCall({
    ctx: handlerCtx, capability: "lessons", action: "update",
    resourceType: "lesson", resourceId: row.id,
    durationMs: Date.now() - startedAt, success: true,
    perResourceAudit: {
      kind: "lesson",
      lessonId: row.id,
      lessonAction: "updated",
      previousBody: row.body,
      newBody: params.patch?.body ?? row.body,
      previousFrontmatter,
      newFrontmatter: params.patch?.frontmatter ?? previousFrontmatter,
    },
    insertChatPill: handlerCtx.conversationId !== null,
  });
  return ok(req, { ok: true });
};

const archiveLesson: ActionHandler = async (a) => {
  const loaded = await loadOwnLesson(a);
  if ("error" in loaded) return loaded.error;
  // Hard delete is the simplest archive — the audit_log row preserves the body.
  await getDb().delete(lessons).where(eq(lessons.id, loaded.row.id));
  await recordCapabilityCall({
    ctx: a.handlerCtx, capability: "lessons", action: "archive",
    resourceType: "lesson", resourceId: loaded.row.id,
    durationMs: Date.now() - a.startedAt, success: true,
    insertChatPill: a.handlerCtx.conversationId !== null,
  });
  return ok(a.req, { ok: true });
};

/** Counter bump. Increments in SQL so concurrent calls do not lose counts. */
function bumpCounter(changes: () => Partial<Record<keyof LessonRow, unknown>>): ActionHandler {
  return async (a) => {
    // Only the author may bump. The bundled lesson-renderer exception is
    // deferred (Phase 53 ports lesson-renderer).
    const loaded = await loadOwnLesson(a);
    if ("error" in loaded) return loaded.error;
    await getDb().update(lessons).set(changes()).where(eq(lessons.id, loaded.row.id));
    return ok(a.req, { ok: true });
  };
}

const ACTIONS: Record<LessonsParams["action"], ActionHandler> = {
  list: listLessons,
  get: getLesson,
  write: writeLesson,
  update: updateLesson,
  archive: archiveLesson,
  recordFired: bumpCounter(() => ({ firedCount: sql`${lessons.firedCount} + 1`, lastFiredAt: new Date() })),
  recordDismissed: bumpCounter(() => ({ dismissedCount: sql`${lessons.dismissedCount} + 1` })),
};

const WRITE_ACTIONS: ReadonlySet<string> = new Set(["write", "update", "archive"]);

export async function handlePiLessons(
  req: JsonRpcRequest,
  ctx: LessonsHandlerContext,
  rpcMeta?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const startedAt = Date.now();
  const handlerCtx = deriveHandlerContext(rpcMeta, ctx.registeredTool);
  const params = (req.params ?? {}) as unknown as LessonsParams;
  const granted = ctx.granted.lessons;
  if (!granted) return softFail(req, "lessons permission not granted");

  if (WRITE_ACTIONS.has(params.action) && granted.access !== "write") {
    return softFail(req, "lessons write access not granted");
  }

  const action = Object.hasOwn(ACTIONS, params.action) ? ACTIONS[params.action] : undefined;
  if (!action) return softFail(req, "unknown-action");
  return action({ req, params, granted, handlerCtx, startedAt });
}
