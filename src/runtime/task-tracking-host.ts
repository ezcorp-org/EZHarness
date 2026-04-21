// Host-side entry points for the task-tracking bundled extension's state.
//
// Phase 3 commit-5 deletes src/runtime/tools/task-tracking.ts. The five
// task-panel API routes + `start-assignment.ts` + the spawn-assignment
// handler used to reach into that built-in's in-memory Map of
// `TaskSnapshot`s and its `emitSnapshot` / `persistToDb` helpers. After
// the cutover, state lives inside the extension subprocess and is
// persisted via the host's `extension_storage` table under the
// task-tracking extension's real DB id.
//
// This file is the one server-side place that reaches into that
// storage table. Consumers call the exposed helpers instead of reaching
// directly at the DB — the alternative is every API route duplicating
// the extension-id lookup and the key-shape assertion.
//
// Type re-exports: consumer files that used to import the TaskAssignment
// / TaskSnapshot / TrackedTask shapes from `runtime/tools/task-tracking`
// retarget here. The source of truth is the extension's index.ts — we
// simply re-export so "host code" has a stable import path that doesn't
// reach into `docs/extensions/examples/...`.

import { getDb } from "../db/connection";
import { conversationExtensions } from "../db/schema";
import { getExtensionByName } from "../db/queries/extensions";
import {
  getStorageValue,
  setStorageValue,
  deleteStorageValue,
} from "../db/queries/extension-storage";

// ── Type surface ────────────────────────────────────────────────────

export type {
  TaskStatus,
  AssignmentStatus,
  TaskAssignment,
  TrackedSubtask,
  TrackedTask,
  PersistedSnapshot,
} from "../../docs/extensions/examples/task-tracking/index";

import type {
  TrackedTask,
  PersistedSnapshot,
} from "../../docs/extensions/examples/task-tracking/index";

/** Legacy shape kept for API consumers that still serialize
 *  `{ conversationId, tasks, activeTaskId }`. Internally the extension
 *  stores a `PersistedSnapshot` (no conversationId — the extension-
 *  storage row key provides it), but web/* consumers and bus emissions
 *  carry the conversation id explicitly. */
export interface TaskSnapshot {
  conversationId: string;
  tasks: TrackedTask[];
  activeTaskId?: string;
}

const STORAGE_KEY = "tasks";

// ── Extension-id resolution (cached) ────────────────────────────────

let cachedExtId: string | undefined;

/**
 * Resolve the installed `task-tracking` extension's DB id. Cached
 * module-local after the first hit; resets on a fresh process only.
 * Throws if the extension isn't installed — every bundled install
 * happens in `ensureBundledExtensions()`, so this only fires on a
 * completely uninitialized boot.
 */
export async function getTaskTrackingExtensionId(): Promise<string> {
  if (cachedExtId) return cachedExtId;
  const row = await getExtensionByName("task-tracking");
  if (!row) {
    throw new Error(
      "task-tracking extension not installed — did ensureBundledExtensions() run?",
    );
  }
  cachedExtId = row.id;
  return cachedExtId;
}

/** Test-only: clear the cached extension id so mocks re-resolve. */
export function _resetTaskTrackingExtensionIdCache(): void {
  cachedExtId = undefined;
}

// ── Snapshot read/write ────────────────────────────────────────────

/**
 * Read the task snapshot for a conversation from the extension's
 * storage row. Returns `undefined` if the task-tracking extension has
 * never been wired to this conversation or no tasks exist.
 *
 * Handles both the new `PersistedSnapshot` shape (with
 * `schemaVersion: 1`) and the legacy pre-Phase-3 shape (no version
 * field) so a migration-mid-upgrade read doesn't throw. Callers get a
 * consistent `TaskSnapshot` with `conversationId` attached.
 */
export async function getTaskSnapshotForConversation(
  conversationId: string,
): Promise<TaskSnapshot | undefined> {
  const extId = await getTaskTrackingExtensionId();
  const row = await getStorageValue(extId, "conversation", conversationId, STORAGE_KEY);
  if (!row || !row.value) return undefined;
  const v = row.value as Partial<PersistedSnapshot> & { activeTaskId?: string };
  return {
    conversationId,
    tasks: Array.isArray(v.tasks) ? v.tasks : [],
    ...(v.activeTaskId !== undefined ? { activeTaskId: v.activeTaskId } : {}),
  };
}

/**
 * Persist a snapshot for a conversation — used by the manual-assign
 * route which mutates state outside the tool-call path. Writes with
 * `schemaVersion: 1` so future re-reads see the current shape.
 */
export async function writeTaskSnapshotForConversation(
  conversationId: string,
  snapshot: Pick<TaskSnapshot, "tasks" | "activeTaskId">,
): Promise<void> {
  const extId = await getTaskTrackingExtensionId();
  const value: PersistedSnapshot = {
    tasks: snapshot.tasks,
    schemaVersion: 1,
    ...(snapshot.activeTaskId !== undefined ? { activeTaskId: snapshot.activeTaskId } : {}),
  };
  const sizeBytes = Buffer.byteLength(JSON.stringify(value), "utf-8");
  await setStorageValue(extId, "conversation", conversationId, STORAGE_KEY, value, false, sizeBytes);
}

/**
 * Remove the stored snapshot for a conversation — used by tests (and
 * by a potential future "reset conversation" admin action).
 */
export async function deleteTaskSnapshotForConversation(
  conversationId: string,
): Promise<boolean> {
  const extId = await getTaskTrackingExtensionId();
  return deleteStorageValue(extId, "conversation", conversationId, STORAGE_KEY);
}

// ── Wiring helper ───────────────────────────────────────────────────

/**
 * Ensure the task-tracking extension is wired to the given conversation.
 * Idempotent via the existing UNIQUE(conversation_id, extension_id)
 * constraint on `conversation_extensions`. Call this at the top of any
 * route or tool-invoke path that's about to read/write the snapshot —
 * it cheaply guarantees the row exists before the first tool call.
 *
 * The plan's "wire-on-first-use" contract lives here: executor boot and
 * bundled install both SKIP per-conversation wiring, and instead every
 * consumer trips this helper before touching the storage row.
 */
export async function ensureTaskTrackingWired(
  conversationId: string,
): Promise<void> {
  const extId = await getTaskTrackingExtensionId();
  const db = getDb();
  await db
    .insert(conversationExtensions)
    .values({ conversationId, extensionId: extId })
    .onConflictDoNothing();
}
