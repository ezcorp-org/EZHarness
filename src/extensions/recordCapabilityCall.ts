/**
 * Shared dual-write wrapper that every Phase 51 capability handler
 * uses to persist the audit trail of a single call.
 *
 * Three writes, each in its own try/catch so an audit failure NEVER
 * aborts the underlying capability call (Pitfall #2 in research):
 *
 *   1. `insertSdkCapabilityCall(...)` — the row in
 *      `sdk_capability_calls`. `before` and `after` are passed through
 *      `redactForAudit` first.
 *   2. Optional per-resource audit row: `memory_audit_log` or
 *      `lessons_audit_log` if `perResourceAudit.kind` is set. Captures
 *      full before/after body + frontmatter that the high-volume
 *      sdk row deliberately doesn't carry.
 *   3. Optional in-chat capability-event message: a `messages` row with
 *      `role: "capability-event"` and metadata pointing at write 1.
 *      The chat UI's pill renderer is just a foreign key.
 *
 * Each failure writes to `error_logs` via `persistError` so an audit
 * hiccup is observable to admins, but does NOT propagate up to the
 * caller. Returns `{sdkCapabilityCallId}` so callers can chain child
 * calls (e.g. scheduled-fire → its LLM call) by passing
 * `parentCallId`.
 *
 * Reference: `tasks/v1.3-phase-50-audit-foundation.md` § 50.6.
 */
import { logger } from "../logger";
import { redactForAudit } from "./audit-redaction";
import {
  insertSdkCapabilityCall,
  type NewSdkCapabilityCall,
} from "../db/queries/sdk-capability-calls";
import { insertLessonAuditEntry } from "../db/queries/lessons-audit";
import { getExtension } from "../db/queries/extensions";
import { getDb } from "../db/connection";
import { memoryAuditLog, messages } from "../db/schema";
import { persistError } from "../db/queries/error-logs";
import type { HandlerContext } from "./handler-context";

const log = logger.child("audit.recordCapabilityCall");

export type SdkCapability = "llm" | "memory" | "lessons" | "schedule" | "events";

export interface CapabilityCallSpec {
  ctx: HandlerContext;
  capability: SdkCapability;
  /** Action verb — e.g. 'complete', 'read', 'write', 'fire', 'register'. */
  action: string;
  resourceType?: string;
  resourceId?: string;
  before?: unknown;
  after?: unknown;
  durationMs: number;
  success: boolean;
  errorCode?: string;
  errorMessage?: string;
  tokensUsed?: number;
  costUsd?: number;
  provider?: string;
  model?: string;
  /** When set, also writes a memory_audit_log or lessons_audit_log
   *  row capturing full before/after content. */
  perResourceAudit?: {
    kind: "memory" | "lesson";
    /** memory_audit_log uses a different shape — just `previousContent`/`newContent`/`reason`. */
    previousBody?: string | null;
    newBody?: string | null;
    /** lessons_audit_log only. */
    previousFrontmatter?: Record<string, unknown> | null;
    newFrontmatter?: Record<string, unknown> | null;
    /** Required when kind === "memory" — the memory row id. */
    memoryId?: string;
    /** Required when kind === "lesson" — the lesson row id. */
    lessonId?: string;
    /** memory_audit_log.action: 'created' | 'updated' | 'merged' | 'deleted' | 'status_change' */
    memoryAction?: "created" | "updated" | "merged" | "deleted" | "status_change";
    /** lessons_audit_log.action: 'created' | 'updated' | 'deleted' */
    lessonAction?: "created" | "updated" | "deleted";
  };
  /** When true (default for SDK calls during a chat), insert a
   *  capability-event message row referencing the sdk_capability_calls
   *  row id via `metadata.sdkCapabilityCallId`. Default: true if a
   *  conversationId is present, false otherwise. */
  insertChatPill?: boolean;
}

export interface CapabilityCallResult {
  /** The new row's id, or `""` if the sdk write itself failed (the
   *  call still returned successfully — the audit hiccup was
   *  swallowed). Callers passing `parentCallId` to a child call
   *  should check for `""` and skip the chain link. */
  sdkCapabilityCallId: string;
}

export async function recordCapabilityCall(
  spec: CapabilityCallSpec,
): Promise<CapabilityCallResult> {
  let sdkCapabilityCallId = "";

  // ── Write 1: sdk_capability_calls row ────────────────────────────
  try {
    const redactedBefore = spec.before !== undefined ? redactForAudit(spec.before).redacted : undefined;
    const redactedAfter = spec.after !== undefined ? redactForAudit(spec.after).redacted : undefined;
    const row: NewSdkCapabilityCall = {
      extensionId: spec.ctx.actorExtensionId,
      onBehalfOf: spec.ctx.onBehalfOf,
      conversationId: spec.ctx.conversationId,
      parentCallId: spec.ctx.parentCallId,
      capability: spec.capability,
      action: spec.action,
      resourceType: spec.resourceType ?? null,
      resourceId: spec.resourceId ?? null,
      // Pass undefined when not set; pass null when explicitly cleared.
      before: redactedBefore as unknown,
      after: redactedAfter as unknown,
      success: spec.success,
      durationMs: spec.durationMs,
      errorCode: spec.errorCode ?? null,
      errorMessage: spec.errorMessage ?? null,
      tokensUsed: spec.tokensUsed ?? null,
      costUsd: spec.costUsd ?? null,
      provider: spec.provider ?? null,
      model: spec.model ?? null,
    };
    const inserted = await insertSdkCapabilityCall(row);
    sdkCapabilityCallId = inserted.id;
  } catch (err) {
    log.warn("audit-write-failed", { which: "sdk_capability_calls", error: String(err) });
    await persistError({
      level: "warn",
      message: "audit-write-failed: sdk_capability_calls",
      stack: err instanceof Error ? err.stack ?? null : null,
      metadata: {
        actorExtensionId: spec.ctx.actorExtensionId,
        onBehalfOf: spec.ctx.onBehalfOf,
        capability: spec.capability,
        action: spec.action,
        success: spec.success,
        error: String(err),
      },
    }).catch(() => {});
    // Continue — writes 2 and 3 may still be useful.
  }

  // ── Write 2: per-resource audit ─────────────────────────────────
  if (spec.perResourceAudit) {
    try {
      const pra = spec.perResourceAudit;
      if (pra.kind === "memory" && pra.memoryId) {
        await getDb().insert(memoryAuditLog).values({
          memoryId: pra.memoryId,
          action: pra.memoryAction ?? "updated",
          previousContent: pra.previousBody ?? null,
          newContent: pra.newBody ?? null,
          reason: `ext:${spec.ctx.actorExtensionId}`,
        });
      } else if (pra.kind === "lesson" && pra.lessonId) {
        await insertLessonAuditEntry({
          lessonId: pra.lessonId,
          action: pra.lessonAction ?? "updated",
          previousBody: pra.previousBody ?? null,
          newBody: pra.newBody ?? null,
          previousFrontmatter: pra.previousFrontmatter ?? null,
          newFrontmatter: pra.newFrontmatter ?? null,
          actorExtensionId: spec.ctx.actorExtensionId,
          actorUserId: spec.ctx.onBehalfOf,
          reason: `ext:${spec.ctx.actorExtensionId}`,
        });
      }
    } catch (err) {
      log.warn("audit-write-failed", { which: "per-resource", error: String(err) });
      await persistError({
        level: "warn",
        message: `audit-write-failed: per-resource (${spec.perResourceAudit.kind})`,
        stack: err instanceof Error ? err.stack ?? null : null,
        metadata: {
          actorExtensionId: spec.ctx.actorExtensionId,
          kind: spec.perResourceAudit.kind,
          error: String(err),
        },
      }).catch(() => {});
    }
  }

  // ── Write 3: in-chat capability-event message ────────────────────
  // Default: insert when a conversationId is present, skip otherwise.
  // Caller can force-skip with `insertChatPill: false`.
  const shouldPill = spec.insertChatPill !== false && spec.ctx.conversationId !== null;
  if (shouldPill && sdkCapabilityCallId !== "") {
    // Phase 52.5 — surface the extension name in the pill payload so
    // the in-chat pill renders "lessons-keeper called gpt-4o-mini"
    // without a second fetch from the chat page. Resolve via getExtension;
    // null on lookup failure (audit row still works, pill falls back
    // to "extension").
    let extensionName: string | null = null;
    try {
      const ext = await getExtension(spec.ctx.actorExtensionId);
      extensionName = ext?.name ?? null;
    } catch {
      // non-fatal — continue with null name.
    }
    try {
      // Note: `messages` has no `metadata` column today; we encode the
      // pill payload into the `content` field as a JSON blob with a
      // sentinel key so the rest of the codebase doesn't accidentally
      // render it as user text. The Phase 52 pill component reads it
      // via the sentinel. When `messages.metadata` lands later, this
      // can be split.
      await getDb().insert(messages).values({
        conversationId: spec.ctx.conversationId!,
        role: "capability-event",
        content: JSON.stringify({
          __ezcorp_capability_event: true,
          sdkCapabilityCallId,
          capability: spec.capability,
          action: spec.action,
          resourceType: spec.resourceType,
          resourceId: spec.resourceId,
          success: spec.success,
          durationMs: spec.durationMs,
          costUsd: spec.costUsd,
          model: spec.model,
          provider: spec.provider,
          extensionName,
        }),
      });
    } catch (err) {
      log.warn("audit-write-failed", { which: "chat-pill", error: String(err) });
      await persistError({
        level: "warn",
        message: "audit-write-failed: chat-pill",
        stack: err instanceof Error ? err.stack ?? null : null,
        metadata: {
          actorExtensionId: spec.ctx.actorExtensionId,
          conversationId: spec.ctx.conversationId,
          sdkCapabilityCallId,
          error: String(err),
        },
      }).catch(() => {});
    }
  }

  return { sdkCapabilityCallId };
}
