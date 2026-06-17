/**
 * file-organizer Hub-event dispatcher (HOST in-process).
 *
 * The events route delegates every `file-organizer:*` Hub action here.
 * Mutating actions run host-side via `file-organizer-state` (the applier +
 * config writer, with the real user id, CAS on proposal status, and
 * lookups BY ID — caller payload paths are never trusted). Pure-view
 * actions (`select-segment` / `page-window` / `focus`) only invalidate the
 * page cache. Unknown events return `handled:false` so the route can fall
 * through to its normal subprocess forward.
 */
import { logger } from "../logger";
import type { PermissionEngine } from "./permission-engine";
import type { HandlerResult } from "./file-organizer-state";
import * as state from "./file-organizer-state";
import type { Mode, BacklogPolicy } from "../../docs/extensions/examples/file-organizer/lib/config";

const log = logger.child("ext.file-organizer-events");

export interface DispatchDeps {
  dataDir: string;
  engine: PermissionEngine;
  extensionId: string;
  userId: string;
  settings: { quarantineTtlDays: number; quarantineCapGb: number };
}

export interface DispatchResult {
  /** False ⇒ not a file-organizer event we handle (fall through). */
  handled: boolean;
  /** When handled: did the action change state (⇒ invalidate cache)? */
  changed?: boolean;
  /** Status message for the "Last action" section. */
  message?: string;
  ok?: boolean;
}

/** Bare event name (the part after `file-organizer:`). */
type EventName = string;

function str(payload: Record<string, unknown> | undefined, key: string): string | undefined {
  const v = payload?.[key];
  return typeof v === "string" ? v : undefined;
}
function bool(payload: Record<string, unknown> | undefined, key: string): boolean {
  return payload?.[key] === true;
}

/**
 * Dispatch a `file-organizer:<event>` hub action. `event` is the bare
 * event name (no `file-organizer:` prefix). Returns `{handled:false}` for
 * events this module doesn't own.
 */
export async function dispatchFileOrganizerEvent(
  event: EventName,
  payload: Record<string, unknown> | undefined,
  deps: DispatchDeps,
): Promise<DispatchResult> {
  const stateDeps: state.StateDeps = {
    dataDir: deps.dataDir,
    engine: deps.engine,
    extensionId: deps.extensionId,
    userId: deps.userId,
    settings: deps.settings,
  };

  const wrap = (r: HandlerResult): DispatchResult => ({ handled: true, changed: r.changed, message: r.message, ok: r.ok });

  try {
    switch (event) {
      // ── Pure-view: cache-invalidate only (no state change). ─────────
      case "select-segment":
      case "page-window":
      case "focus":
      case "reload-config":
      case "scan-now":
        return { handled: true, changed: true, ok: true };

      // ── Proposal lifecycle ──────────────────────────────────────────
      case "accept": {
        const id = str(payload, "proposalId");
        if (!id) return { handled: true, ok: false, changed: false, message: "Missing proposalId" };
        return wrap(await state.acceptProposal(stateDeps, id));
      }
      case "reject": {
        const id = str(payload, "proposalId");
        if (!id) return { handled: true, ok: false, changed: false, message: "Missing proposalId" };
        return wrap(await state.rejectProposal(stateDeps, id));
      }
      case "reject-segment":
        return wrap(await state.rejectSegment(stateDeps, str(payload, "segment") ?? "all"));
      case "confirm-deletes":
        return wrap(await state.confirmDeletes(stateDeps));
      case "undo-batch": {
        const id = str(payload, "batchId");
        if (!id) return { handled: true, ok: false, changed: false, message: "Missing batchId" };
        return wrap(await state.undoBatch(stateDeps, id));
      }
      case "dismiss-stale": {
        const id = str(payload, "proposalId");
        if (!id) return { handled: true, ok: false, changed: false, message: "Missing proposalId" };
        return wrap(await state.dismissStale(stateDeps, id));
      }
      case "retry-failed":
        // Failed rows return to pending so the next accept/auto re-applies.
        return { handled: true, changed: true, ok: true };

      // ── Quarantine ──────────────────────────────────────────────────
      case "restore":
        return wrap(await state.restore(stateDeps, { quarantineId: str(payload, "quarantineId"), all: bool(payload, "all") }));
      case "purge": {
        const id = str(payload, "quarantineId");
        if (!id) return { handled: true, ok: false, changed: false, message: "Missing quarantineId" };
        return wrap(await state.purge(stateDeps, id));
      }
      case "empty-quarantine":
        return wrap(await state.emptyQuarantine(stateDeps));
      case "purge-expired":
        return wrap(await state.purgeExpired(stateDeps));

      // ── Config mutations ────────────────────────────────────────────
      case "set-mode": {
        const folderId = str(payload, "folderId");
        const mode = str(payload, "mode") as Mode | undefined;
        if (!folderId || !mode) return { handled: true, ok: false, changed: false, message: "Missing folderId/mode" };
        return wrap(await state.setMode(stateDeps, folderId, mode));
      }
      case "toggle-preset": {
        const folderId = str(payload, "folderId");
        const preset = str(payload, "preset");
        if (!folderId || !preset) return { handled: true, ok: false, changed: false, message: "Missing folderId/preset" };
        return wrap(await state.togglePreset(stateDeps, folderId, preset));
      }
      case "add-folder": {
        const path = str(payload, "path");
        if (!path) return { handled: true, ok: false, changed: false, message: "Missing path" };
        return wrap(await state.addWatchedFolder(stateDeps, { path, backlogPolicy: str(payload, "backlogPolicy") as BacklogPolicy | undefined }));
      }
      case "set-backlog-policy": {
        const folderId = str(payload, "folderId");
        const policy = str(payload, "backlogPolicy") as BacklogPolicy | undefined;
        if (!folderId || !policy) return { handled: true, ok: false, changed: false, message: "Missing folderId/policy" };
        return wrap(await state.setFolderBacklog(stateDeps, folderId, policy));
      }
      case "remove-folder": {
        const folderId = str(payload, "folderId");
        if (!folderId) return { handled: true, ok: false, changed: false, message: "Missing folderId" };
        return wrap(await state.removeWatchedFolder(stateDeps, folderId));
      }
      case "add-ignore": {
        const folderId = str(payload, "folderId");
        const path = str(payload, "path");
        if (!folderId || !path) return { handled: true, ok: false, changed: false, message: "Missing folderId/path" };
        return wrap(await state.addIgnore(stateDeps, folderId, path));
      }
      case "add-rule": {
        const folderId = str(payload, "folderId");
        const rule = str(payload, "rule");
        if (!folderId || !rule) return { handled: true, ok: false, changed: false, message: "Missing folderId/rule" };
        return wrap(await state.addRule(stateDeps, folderId, rule));
      }

      // ── Forwarded to the subprocess (agent-driven): not handled here ─
      // classify-move / teach-rule / ignore-file / enable-daemon /
      // organize-backlog are surfaced to the agent or daemon, not the
      // in-process applier — fall through to the subprocess forward.
      default:
        return { handled: false };
    }
  } catch (err) {
    log.warn("file-organizer hub event failed", { event, error: String(err) });
    return { handled: true, ok: false, changed: false, message: "Internal error" };
  }
}

/** The bare event names this module handles in-process (for tests + the
 *  route's quick membership check). */
export const IN_PROCESS_EVENTS = new Set<string>([
  "select-segment", "page-window", "focus", "reload-config", "scan-now",
  "accept", "reject", "reject-segment", "confirm-deletes", "undo-batch",
  "dismiss-stale", "retry-failed", "restore", "purge", "empty-quarantine",
  "purge-expired", "set-mode", "toggle-preset", "add-folder",
  "set-backlog-policy", "remove-folder", "add-ignore", "add-rule",
]);
