import { and, eq, isNull } from "drizzle-orm";
import { ProviderUnavailableError } from "../../providers/router";
import { friendlyProviderError } from "../../providers/provider-error";
import { logger } from "../../logger";
import { getDb } from "../../db/connection";
import { toolCalls } from "../../db/schema";
import * as activeRunsDb from "../../db/queries/active-runs";
import * as dbRuns from "../../db/queries/runs";
import { persistErrorMessage } from "../executor-helpers";
import type { StreamChatContext } from "./context";
import type { StreamChatHost } from "./host";

const log = logger.child("executor.streamChat.finalize");

/**
 * Claim the run's shared "error message persisted" slot. Returns `true`
 * if THIS caller won the race and should write the message; `false` if
 * the watchdog trip branch (or an earlier finalize) already persisted
 * one for this run — in which case we MUST NOT write a duplicate
 * (Locked decision 3 — exactly one visible error bubble per run).
 *
 * The check-and-set is synchronous (single-threaded JS event loop) so
 * it's race-safe vs. the watchdog, which also claims this set
 * synchronously in its trip branch before its fire-and-forget write.
 */
function claimErrorPersistSlot(host: StreamChatHost, runId: string): boolean {
  if (host.errorMessagePersisted.has(runId)) return false;
  host.errorMessagePersisted.add(runId);
  return true;
}

/** Options carried into finalize* — a strict subset of streamChat's `options`
 *  that the persistence/error paths read. */
export interface FinalizeOptions {
  parentMessageId?: string;
  model?: string;
  provider?: string;
  // accept any extras; persistErrorMessage will spread the original options through.
  [k: string]: unknown;
}

/**
 * Success-path finalization that runs after the LLM stream completes
 * cleanly. Writes the success result to `run`, drains the queued
 * per-turn DB writes, persists a fallback assistant message if no
 * per-turn save happened, and emits run:complete + obs:turn.
 *
 * The caller must already have verified `piAgent.state.errorMessage` is unset
 * and either rethrown or proceeded to here — this helper is for the
 * "no exception, normal completion" branch only.
 *
 * Skips entirely if `run.status === "cancelled"` (same guard as
 * `finalizeError`): cancelRun already recorded the terminal state and
 * emitted run:cancel, so a clean completion racing a user Stop must not
 * overwrite the status back to success or emit a second terminal event.
 */
export async function finalizeSuccess(
  ctx: StreamChatContext,
  host: StreamChatHost,
  conversationId: string,
  options: FinalizeOptions,
): Promise<void> {
  const { run } = ctx;
  if (run.status === "cancelled") return;
  run.status = "success";
  run.result = { success: true, output: { fullText: ctx.allTurnsText, memoriesUsed: run.memoriesUsed } };
  run.finishedAt = Date.now();

  host.bus.emit("run:status", { runId: run.id, status: "Saving response..." });
  // Wait for all queued per-turn DB operations to complete
  await ctx.dbQueue;

  // Fallback: if no turns were saved (edge case), save allTurnsText as single
  // message. "No turn saved" is detected against ctx.turnParentMessageId (not
  // options.parentMessageId): the deterministic-preprocess runner may have
  // chained `preprocess-result` rows and re-based the turn's parent onto the
  // last row — the two fields are identical when preprocess didn't run.
  //
  // A P4 §1.2 steer reconcile ALSO advances ctx.lastSavedMessageId (to the
  // steer's row) at delivery, so a run whose only "save" was a reconciled steer
  // would suppress this fallback. That's acceptable: a successful run with a
  // delivered steer virtually always has a subsequent turn_end save (the model
  // responds to the steer), and the steer content is already persisted — it IS
  // the user row the route created — so nothing is lost by not re-saving it here.
  if (host.persist && ctx.allTurnsText && ctx.lastSavedMessageId === ctx.turnParentMessageId) {
    try {
      const { createMessage } = await import("../../db/queries/conversations");
      const fallbackMsg = await createMessage(conversationId, {
        role: "assistant",
        content: ctx.allTurnsText,
        model: options.model,
        provider: options.provider,
        runId: run.id,
        parentMessageId: ctx.turnParentMessageId ?? undefined,
      });
      await getDb()
        .update(toolCalls)
        .set({ messageId: fallbackMsg.id })
        .where(and(
          eq(toolCalls.conversationId, conversationId),
          isNull(toolCalls.messageId),
        ));
      ctx.lastSavedMessageId = fallbackMsg.id;
    } catch (err) {
      log.error("Failed to persist fallback assistant message", { error: String(err) });
    }
  }

  host.bus.emit("run:complete", { run, conversationId });
  host.bus.emit("obs:turn", {
    conversationId,
    llmDurationMs: Date.now() - ctx.turnStart,
    toolDurationMs: 0,
    totalDurationMs: Date.now() - ctx.turnStart,
    tokenUsage: { input: ctx.totalUsage.input, output: ctx.totalUsage.output },
  });
}

/**
 * Error/cancellation-path finalization. Distinguishes three sub-paths:
 *   - AbortError → cancelled (saves partial turn text)
 *   - ProviderUnavailableError → structured JSON error payload
 *   - any other Error → flat error message
 *
 * Skips entirely if `run.status === "cancelled"` (cancelRun already
 * recorded the terminal state and emitted run:cancel).
 */
export async function finalizeError(
  ctx: StreamChatContext,
  host: StreamChatHost,
  conversationId: string,
  options: FinalizeOptions,
  err: unknown,
): Promise<void> {
  const { run } = ctx;
  if (run.status === "cancelled") return;

  if (err instanceof DOMException && err.name === "AbortError") {
    run.status = "cancelled";
    run.result = { success: true, output: { fullText: ctx.allTurnsText, partial: true } };
    run.finishedAt = Date.now();
    // Wait for queued turn saves to complete, then save current partial turn
    await ctx.dbQueue;
    if (host.persist && ctx.turnText) {
      try {
        const { createMessage } = await import("../../db/queries/conversations");
        const partialMsg = await createMessage(conversationId, {
          role: "assistant",
          content: ctx.turnText,
          model: options.model,
          provider: options.provider,
          runId: run.id,
          parentMessageId: ctx.lastSavedMessageId ?? undefined,
        });
        await getDb()
          .update(toolCalls)
          .set({ messageId: partialMsg.id })
          .where(and(
            eq(toolCalls.conversationId, conversationId),
            isNull(toolCalls.messageId),
          ));
      } catch (persistErr) {
        log.error("Failed to persist partial response", { error: String(persistErr) });
      }
    }
    host.bus.emit("run:cancel", { run, conversationId });
    return;
  }

  if (err instanceof ProviderUnavailableError) {
    run.status = "error";
    const errorPayload = JSON.stringify({
      type: "provider_unavailable",
      failedProvider: err.failedProvider,
      failedModel: err.failedModel,
      suggestion: err.suggestion,
      message: err.message,
    });
    run.result = { success: false, output: null, error: errorPayload };
    run.finishedAt = Date.now();
    // Skip if the watchdog already surfaced this run's error (no
    // duplicate bubble) — see claimErrorPersistSlot.
    if (claimErrorPersistSlot(host, run.id)) {
      await persistErrorMessage(
        conversationId,
        `Error: ${errorPayload}`,
        { ...options, parentMessageId: ctx.lastSavedMessageId ?? options.parentMessageId },
        run.id,
        host.persist,
      );
    }
    host.bus.emit("run:error", { run, runId: run.id, error: errorPayload, conversationId });
    return;
  }

  // Connection-class failures (unreachable Ollama/custom endpoint, refused
  // socket, DNS miss) otherwise leak the runtime's cryptic raw text — e.g.
  // "Was there a typo in the url or port?" — straight into the chat bubble.
  // Rewrite those into a clear, actionable message; everything else passes
  // through unchanged.
  const rawMessage = err instanceof Error ? err.message : String(err);
  const message =
    friendlyProviderError(err, {
      provider: run.provider ?? options.provider,
      model: options.model,
      baseUrl: ctx.modelBaseUrl,
    }) ?? rawMessage;
  run.status = "error";
  run.result = { success: false, output: null, error: message };
  run.finishedAt = Date.now();
  // Skip if the watchdog already surfaced this run's error (no
  // duplicate bubble) — see claimErrorPersistSlot.
  if (claimErrorPersistSlot(host, run.id)) {
    await persistErrorMessage(
      conversationId,
      `Error: ${message}`,
      { ...options, parentMessageId: ctx.lastSavedMessageId ?? options.parentMessageId },
      run.id,
      host.persist,
    );
  }
  host.bus.emit("run:error", { run, runId: run.id, error: message, conversationId });
}

/**
 * Always-runs finalization. Detaches every subscription/closure that
 * `streamChat`'s setup phases attached, clears per-tool abort
 * controllers, releases the watchdog and the executor's per-run maps,
 * and persists the terminal `run` row + active_runs cleanup.
 *
 * Idempotent for the maps it touches (Map.delete is a no-op on miss).
 */
export async function finalizeCleanup(
  ctx: StreamChatContext,
  host: StreamChatHost,
): Promise<void> {
  const { run } = ctx;
  ctx.unsub?.();
  ctx.unsubKill?.();
  ctx.unsubModeChange?.();
  for (const off of ctx.unsubAgentActivity) off();
  ctx.toolAbortControllers.clear();
  // Clear watchdog interval + activity tracking
  host.watchdog.clearRun(run.id);
  host.controllers.delete(run.id);
  host.activeAgents.delete(run.id);
  host.runConversations.delete(run.id);
  if (host.persist) {
    await dbRuns.updateRun(run);
    // Clean up active run row (or mark interrupted on error)
    try {
      if (run.status === "success" || run.status === "cancelled") {
        await activeRunsDb.deleteActiveRun(run.id);
      } else {
        await activeRunsDb.markInterrupted(run.id);
      }
    } catch (err) {
      log.error("Active run cleanup failed", { error: String(err) });
    }
  }
}

/**
 * Setup-phase safety-net finalization. Runs only when the outer
 * try/catch fires before the inner try (e.g. credential failures,
 * model-resolution errors, OAuth errors). Marks the run as errored,
 * persists the error message, aborts the controller (so any in-flight
 * sub-agents from auto-spin-up unwind), and tidies the run-tracking
 * maps + active_runs row.
 */
export async function finalizeSetupError(
  ctx: StreamChatContext,
  host: StreamChatHost,
  conversationId: string,
  options: FinalizeOptions,
  err: unknown,
): Promise<void> {
  const { run } = ctx;
  if (run.status === "running") {
    // Same connection-error translation as finalizeError — a model that
    // resolves to an unreachable endpoint can fail in the setup phase too.
    const message =
      friendlyProviderError(err, {
        provider: run.provider ?? options.provider,
        model: options.model,
        baseUrl: ctx.modelBaseUrl,
      }) ?? (err instanceof Error ? err.message : String(err));
    run.status = "error";
    run.result = { success: false, output: null, error: message };
    run.finishedAt = Date.now();
    // Skip if the watchdog already surfaced this run's error (no
    // duplicate bubble) — see claimErrorPersistSlot.
    if (claimErrorPersistSlot(host, run.id)) {
      await persistErrorMessage(conversationId, `Error: ${message}`, options, run.id, host.persist);
    }
    host.bus.emit("run:error", { run, runId: run.id, error: message, conversationId });
  }
  // Abort the controller so any in-flight sub-agents (auto-spin-up) get cancelled
  const ctrl = host.controllers.get(run.id);
  if (ctrl && !ctrl.signal.aborted) ctrl.abort();
  host.controllers.delete(run.id);
  host.runConversations.delete(run.id);
  if (host.persist) {
    try {
      await dbRuns.updateRun(run);
      await activeRunsDb.markInterrupted(run.id);
    } catch { /* cleanup failure is non-fatal */ }
  }
}
