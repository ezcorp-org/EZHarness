/**
 * `ezcorp/schedule` reverse-RPC handler — `ctx.schedule.fireNow()`.
 *
 * The SDK class only sends `action: "fire-now"` over `ezcorp/schedule`
 * today; the broader register/list surface lives at the manifest tier
 * (`reconcileSchedules` is called at install/update time). The handler
 * here:
 *
 *   1. Validates the cron string is in the extension's manifest-declared
 *      cron list (defense-in-depth — the SDK already drops silently,
 *      this is the host hard-enforce).
 *   2. Counts against `permissions.schedule.maxRunsPerDay`.
 *   3. Enqueues an immediate fire by inserting `extension_schedule_fires`
 *      with `status: "running"` and dispatching through the existing
 *      daemon path (or directly when the daemon isn't available).
 *   4. Audits via `recordCapabilityCall` with capability="schedule",
 *      action="fire-now".
 *
 * Soft-fail codes (mirrors lessons/memory handlers):
 *   -32001  permission missing / cron-not-declared / schedule-disabled
 *   -32103  quota exceeded
 */
import { logger } from "../logger";
import { deriveHandlerContext, type RegisteredToolStub } from "./handler-context";
import { recordCapabilityCall } from "./recordCapabilityCall";
import type { ScheduleDaemon } from "./schedule-daemon";
import type { ExtensionPermissions, JsonRpcRequest, JsonRpcResponse } from "./types";

const log = logger.child("ext.schedule-handler");

interface ScheduleParams {
  action: "fire-now";
  cron: string;
}

export interface ScheduleHandlerContext {
  granted: ExtensionPermissions;
  registeredTool: RegisteredToolStub;
  /** The daemon instance — used to share `fireNow` plumbing
   *  (counters + DB writes + dispatch). When `undefined`, the
   *  handler returns -32603 (no daemon configured).  */
  daemon?: ScheduleDaemon;
}

function softFail(req: JsonRpcRequest, reason: string, code = -32001): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id: req.id,
    error: { code, message: reason, data: { reason } },
  };
}

export async function handlePiSchedule(
  req: JsonRpcRequest,
  ctx: ScheduleHandlerContext,
  rpcMeta?: Record<string, unknown>,
): Promise<JsonRpcResponse> {
  const startedAt = Date.now();
  const handlerCtx = deriveHandlerContext(rpcMeta, ctx.registeredTool);
  const params = (req.params ?? {}) as unknown as ScheduleParams;
  const granted = ctx.granted.schedule;

  if (!granted) return softFail(req, "schedule permission not granted");
  if (params.action !== "fire-now") return softFail(req, "unknown-action", -32601);

  if (typeof params.cron !== "string" || !params.cron.trim()) {
    return softFail(req, "cron required");
  }
  // Manifest validation: the cron must be in the granted list.
  // Defense-in-depth — `reconcileSchedules` already pushed manifest
  // crons into `extension_schedules`, but a stale grant or out-of-sync
  // manifest could still be exploitable here.
  if (!granted.crons.includes(params.cron)) {
    await recordCapabilityCall({
      ctx: handlerCtx,
      capability: "schedule",
      action: "fire-now",
      durationMs: Date.now() - startedAt,
      success: false,
      errorCode: "SCHEDULE_CRON_NOT_DECLARED",
      errorMessage: "cron not in manifest",
      insertChatPill: false,
    });
    return softFail(req, "cron-not-declared");
  }

  if (!ctx.daemon) {
    log.warn("fireNow-without-daemon", { extensionId: handlerCtx.actorExtensionId });
    return softFail(req, "schedule-daemon-unavailable", -32603);
  }

  const result = await ctx.daemon.fireNow(handlerCtx.actorExtensionId, params.cron);
  if (!result.ok) {
    await recordCapabilityCall({
      ctx: handlerCtx,
      capability: "schedule",
      action: "fire-now",
      durationMs: Date.now() - startedAt,
      success: false,
      errorCode: result.reason,
      errorMessage: result.reason,
      insertChatPill: false,
    });
    if (result.reason === "max-runs-per-day-exceeded") {
      return {
        jsonrpc: "2.0", id: req.id,
        error: { code: -32103, message: "schedule quota exceeded",
                 data: { reason: "max-runs-per-day-exceeded" } },
      };
    }
    return softFail(req, result.reason);
  }

  await recordCapabilityCall({
    ctx: handlerCtx,
    capability: "schedule",
    action: "fire-now",
    durationMs: Date.now() - startedAt,
    success: true,
    after: { fireId: result.fireId, cron: params.cron },
    insertChatPill: handlerCtx.conversationId !== null,
  });

  return { jsonrpc: "2.0", id: req.id, result: { ok: true, fireId: result.fireId } };
}
