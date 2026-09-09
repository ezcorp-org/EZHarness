// Host-side entry points for the task-tracking bundled extension's state.
//
// Phase 3 commit-5 deletes src/runtime/tools/task-tracking.ts. The five
// task-panel API routes + `start-assignment.ts` + the spawn-assignment
// handler used to reach into that built-in's in-memory Map of
// `TaskSnapshot`s and its `emitSnapshot` / `persistToDb` helpers. After
// the cutover, the host commits task state and matching extension deliveries
// together in `extension_storage` under the task-tracking extension's id.
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

import { getDb, type DbTransaction } from "../db/connection";
import { sql } from "drizzle-orm";
import { assertConversationEventOwner, emitPersistedDomainEvent, publishDomainEvent, type DomainExtensionEvent } from "../extensions/domain-event-outbox";
import type { AgentEvents } from "../types";
import type { EventBus } from "./events";
import { LifecycleError } from "../extensions/v4/types";
import { verifyInvocationLocks } from "../extensions/runtime-locks";
import { canonicalJson, sha256 } from "@ezcorp/extension-contract";
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

/** Extension-storage key under which the task-tracking extension persists
 *  its per-conversation snapshot. Exported so the boot reconciliation pass
 *  (`boot-reconcile-assignments.ts`) enumerates the same key. */
export const STORAGE_KEY = "tasks";

// ── Extension-id resolution (cached) ────────────────────────────────

let cachedExtId: string | undefined;
const snapshotRevisions = new WeakMap<object, string>();

/**
 * Thrown when the bundled task-tracking extension has no row yet.
 *
 * A DEDICATED type because callers must tell it apart from a genuine read
 * failure: "not installed" means there are legitimately no tasks, while a DB
 * error means we don't KNOW. The cold-start loader used to collapse both into
 * an empty snapshot, which let a transient failure blank a populated task
 * panel once the panel started consuming that route.
 */
export class TaskTrackingNotInstalledError extends Error {
  constructor() {
    super("task-tracking extension not installed — did ensureBundledExtensions() run?");
    this.name = "TaskTrackingNotInstalledError";
  }
}

/**
 * Resolve the installed `task-tracking` extension's DB id. Cached
 * module-local after the first hit; resets on a fresh process only.
 * Throws {@link TaskTrackingNotInstalledError} if the extension isn't
 * installed — every bundled install happens in `ensureBundledExtensions()`,
 * so this only fires on a completely uninitialized boot.
 */
export async function getTaskTrackingExtensionId(): Promise<string> {
  if (cachedExtId) return cachedExtId;
  const row = await getExtensionByName("task-tracking");
  if (!row) {
    throw new TaskTrackingNotInstalledError();
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
  if (!row?.value) return undefined;
  const v = row.value as Partial<PersistedSnapshot> & { activeTaskId?: string };
  const snapshot: TaskSnapshot = {
    conversationId,
    tasks: Array.isArray(v.tasks) ? v.tasks : [],
    ...(v.activeTaskId !== undefined ? { activeTaskId: v.activeTaskId } : {}),
  };
  snapshotRevisions.set(snapshot, await sha256(canonicalJson(row.value)));
  return snapshot;
}

/**
 * Persist a snapshot for a conversation — used by the manual-assign
 * route which mutates state outside the tool-call path. Writes with
 * `schemaVersion: 1` so future re-reads see the current shape.
 */
export async function writeTaskSnapshotForConversation(
  conversationId: string,
  snapshot: Pick<TaskSnapshot, "tasks" | "activeTaskId">,
  options: { bus?: EventBus<AgentEvents>; principalId?: string; expectedRevision?: string; assignments?: Omit<AgentEvents["task:assignment_update"], "conversationId">[] } = {},
): Promise<void> {
  const frozen = JSON.parse(JSON.stringify(snapshot)) as typeof snapshot;
  const assignments = JSON.parse(JSON.stringify(options.assignments ?? [])) as NonNullable<typeof options.assignments>;
  const expectedRevision = options.expectedRevision ?? snapshotRevisions.get(snapshot);
  const extId = await getTaskTrackingExtensionId();
  const events = await getDb().transaction(async (transaction: DbTransaction) => {
    await verifyInvocationLocks(transaction);
    await transaction.execute(sql`SELECT id FROM conversations WHERE id = ${conversationId} FOR UPDATE`);
    if (options.principalId !== undefined) await assertConversationEventOwner(transaction, options.principalId, conversationId);
    if (expectedRevision !== undefined) {
      const current = await getStorageValue(extId, "conversation", conversationId, STORAGE_KEY, transaction);
      if (expectedRevision !== await sha256(canonicalJson(current?.value ?? null))) throw new LifecycleError("task_conflict", "Task state changed; reload before retrying.");
    }
    return persistTaskSnapshot(transaction, extId, conversationId, frozen, assignments);
  });
  snapshotRevisions.set(snapshot, await sha256(canonicalJson(taskSnapshotValue(frozen))));
  for (const event of events) emitPersistedDomainEvent(options.bus, event);
}

function taskSnapshotValue(snapshot: Pick<TaskSnapshot, "tasks" | "activeTaskId">): PersistedSnapshot {
  return { tasks: snapshot.tasks, schemaVersion: 1, ...(snapshot.activeTaskId !== undefined ? { activeTaskId: snapshot.activeTaskId } : {}) };
}

async function persistTaskSnapshot(transaction: DbTransaction, extId: string, conversationId: string, snapshot: Pick<TaskSnapshot, "tasks" | "activeTaskId">, assignments: Omit<AgentEvents["task:assignment_update"], "conversationId">[]): Promise<DomainExtensionEvent[]> {
  for (const update of assignments) {
    const task = snapshot.tasks.find(candidate => candidate.id === update.taskId);
    const assignment = task?.assignments.find(candidate => candidate.id === update.assignment.id) ?? task?.subtasks.flatMap(subtask => subtask.assignments ?? []).find(candidate => candidate.id === update.assignment.id);
    if (!assignment || canonicalJson(assignment) !== canonicalJson(update.assignment)) throw new LifecycleError("invalid_task_update", "Assignment event must match committed task state.");
  }
  const value = taskSnapshotValue(snapshot);
  const sizeBytes = Buffer.byteLength(JSON.stringify(value), "utf-8");
  await setStorageValue(extId, "conversation", conversationId, STORAGE_KEY, value, false, sizeBytes, undefined, transaction);
  const events: DomainExtensionEvent[] = [{ id: crypto.randomUUID(), type: "task:snapshot", conversationId, payload: { ...snapshot, conversationId } }, ...assignments.map(assignment => ({ id: crypto.randomUUID(), type: "task:assignment_update" as const, conversationId, payload: { ...assignment, conversationId } }))];
  for (const event of events) await publishDomainEvent(transaction, event);
  return events;
}

export async function writeTaskAssignmentForConversation(conversationId: string, update: Omit<AgentEvents["task:assignment_update"], "conversationId">, bus?: EventBus<AgentEvents>, principalId?: string): Promise<void> {
  const frozen = JSON.parse(JSON.stringify(update)) as typeof update;
  const extId = await getTaskTrackingExtensionId();
  const events = await getDb().transaction(async (transaction: DbTransaction) => {
    await verifyInvocationLocks(transaction);
    await transaction.execute(sql`SELECT id FROM conversations WHERE id = ${conversationId} FOR UPDATE`);
    const row = await getStorageValue(extId, "conversation", conversationId, STORAGE_KEY, transaction);
    if (principalId !== undefined) await assertConversationEventOwner(transaction, principalId, conversationId);
    const snapshot = row?.value as PersistedSnapshot | undefined;
    const task = snapshot?.tasks?.find(candidate => candidate.id === frozen.taskId);
    if (!task) throw new LifecycleError("task_not_found", "Assignment task does not exist.");
    const assignments = task.assignments.find(candidate => candidate.id === frozen.assignment.id) ? task.assignments : task.subtasks.find(subtask => subtask.assignments?.some(candidate => candidate.id === frozen.assignment.id))?.assignments;
    const existing = assignments?.find(candidate => candidate.id === frozen.assignment.id);
    if (!existing) throw new LifecycleError("assignment_not_found", "Assignment does not exist.");
    Object.assign(existing, frozen.assignment);
    return persistTaskSnapshot(transaction, extId, conversationId, snapshot!, [frozen]);
  });
  for (const event of events) emitPersistedDomainEvent(bus, event);
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
