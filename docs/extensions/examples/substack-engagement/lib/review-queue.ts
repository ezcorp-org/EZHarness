// ── review-queue — draft review queue over an OWNERLESS store ───
//
// Locked decision #4: the queue must be reachable from an OWNERLESS cron
// fire (user-scope storage needs an owner the cron lacks). The decision
// names "project" scope; the SDK runtime Storage exposes no such scope
// (its scopes are global | conversation | user, and the host rejects
// anything else with -32602). "global" is the SDK's only ownerless scope
// and satisfies the decision's intent exactly — index.ts binds
// `new Storage("global")`. This module is scope-agnostic: it operates
// over an injected store, so the scope choice lives entirely in index.ts.
//
// Every outbound message (comment reply, welcome DM, note comment) is
// proposed into this queue as a record. The human approves / edits /
// rejects / sends; locked decision #1 means nothing sends autonomously.
//
// Records live under `queue:<id>`; a `queue-index` key holds the list
// of ids for cheap enumeration (mirrors how substack-pilot enumerates
// entity keys via its index). Rejected + sent items are retained so the
// UI can show history — a TTL sweep is deferred (the spec says add only
// if trivial; it isn't, given project-scope retention semantics).
//
// All logic is pure-ish over an injectable store (the same shape as the
// SDK's runtime `Storage`), so tests drive it with an in-memory fake —
// mirroring substack-pilot's `_setPostTypeStoreForTests`.

export type QueueKind = "reply" | "welcome-dm" | "note-comment";
export type QueueStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "sent"
  | "failed";

export interface QueueItem {
  id: string;
  kind: QueueKind;
  status: QueueStatus;
  /** post/comment id | subscriber id | note id this draft targets. */
  target_ref: string;
  /** The source text the draft responds to (comment body, etc.). */
  context: string;
  /** Editable draft body. Empty string for lazily-drafted follow-ups. */
  draft_body: string;
  /** Epoch ms; for follow-ups. null = send-ready now. */
  due_at: number | null;
  /** For welcome-dm follow-ups: 0 = welcome, 1.. = nudges. */
  sequence_step?: number;
  created_at: number;
  updated_at: number;
  /** Last send failure when status === "failed". */
  error?: string;
}

const QUEUE_PREFIX = "queue:";
const INDEX_KEY = "queue-index";

// ── Injectable store seam ───────────────────────────────────────
//
// Mirrors the SDK runtime Storage interface so the same in-memory fake
// works across every test file. The default is bound lazily by the
// caller (index.ts) to `new Storage("project")` — this module never
// imports Storage directly so unit tests stay free of channel wiring.

export interface QueueStoreLike {
  get<T = unknown>(
    key: string,
  ): Promise<{ value: T | null; exists: boolean }>;
  set<T = unknown>(key: string, value: T): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

let _store: QueueStoreLike | null = null;

/** Bind the production store (index.ts wires `new Storage("project")`). */
export function setQueueStore(store: QueueStoreLike): void {
  _store = store;
}

/** Test-only alias — identical to setQueueStore, named for symmetry
 *  with the other `_set*ForTests` seams in this extension. */
export function _setQueueStoreForTests(store: QueueStoreLike | null): void {
  _store = store;
}

function store(): QueueStoreLike {
  if (!_store) {
    throw new Error(
      "[substack-engagement] review-queue: store not bound — call setQueueStore() first",
    );
  }
  return _store;
}

// ── Id generation (injectable for deterministic tests) ──────────

let _idCounter = 0;
let _now: () => number = () => Date.now();
let _genId: () => string = () =>
  `q-${Date.now().toString(36)}-${(_idCounter++).toString(36)}`;

/** Test-only: make id + clock deterministic. */
export function _setClockForTests(now: () => number, genId?: () => string): void {
  _now = now;
  if (genId) _genId = genId;
}

/** The current epoch ms from the (test-injectable) clock. Shared by
 *  callers (e.g. subscribers.ts follow-up scheduling) so `due_at`
 *  computations and queue `created_at` stamps use ONE clock under test. */
export function now(): number {
  return _now();
}

export function _resetQueueForTests(): void {
  _store = null;
  _idCounter = 0;
  _now = () => Date.now();
  _genId = () => `q-${Date.now().toString(36)}-${(_idCounter++).toString(36)}`;
}

// ── Index helpers ───────────────────────────────────────────────

async function readIndex(): Promise<string[]> {
  const res = await store().get<string[]>(INDEX_KEY);
  if (!res.exists || !Array.isArray(res.value)) return [];
  return res.value;
}

async function writeIndex(ids: string[]): Promise<void> {
  await store().set(INDEX_KEY, ids);
}

// ── CRUD ────────────────────────────────────────────────────────

export interface EnqueueInput {
  kind: QueueKind;
  target_ref: string;
  context: string;
  draft_body: string;
  due_at?: number | null;
  sequence_step?: number;
  /** Override the generated status (defaults to "pending"). */
  status?: QueueStatus;
}

/** Append a new draft to the queue. Keeps the index consistent. */
export async function enqueue(input: EnqueueInput): Promise<QueueItem> {
  const now = _now();
  const item: QueueItem = {
    id: _genId(),
    kind: input.kind,
    status: input.status ?? "pending",
    target_ref: input.target_ref,
    context: input.context,
    draft_body: input.draft_body,
    due_at: input.due_at ?? null,
    created_at: now,
    updated_at: now,
  };
  if (input.sequence_step !== undefined) item.sequence_step = input.sequence_step;

  await store().set(`${QUEUE_PREFIX}${item.id}`, item);
  const ids = await readIndex();
  if (!ids.includes(item.id)) {
    ids.push(item.id);
    await writeIndex(ids);
  }
  return item;
}

/** Read every queue item, optionally filtered. Missing records are
 *  skipped (index/record drift is tolerated, never throws). */
export async function list(filter?: {
  status?: QueueStatus;
  kind?: QueueKind;
}): Promise<QueueItem[]> {
  const ids = await readIndex();
  const items: QueueItem[] = [];
  for (const id of ids) {
    const res = await store().get<QueueItem>(`${QUEUE_PREFIX}${id}`);
    if (!res.exists || !res.value) continue;
    const item = res.value;
    if (filter?.status && item.status !== filter.status) continue;
    if (filter?.kind && item.kind !== filter.kind) continue;
    items.push(item);
  }
  return items;
}

/** Read one item by id, or null when absent. */
export async function get(id: string): Promise<QueueItem | null> {
  const res = await store().get<QueueItem>(`${QUEUE_PREFIX}${id}`);
  if (!res.exists || !res.value) return null;
  return res.value;
}

/** Mutate one record via a patch. Stamps `updated_at`. Returns null when
 *  the id is unknown (so callers surface NOT_FOUND). */
export async function update(
  id: string,
  patch: Partial<Omit<QueueItem, "id" | "created_at">>,
): Promise<QueueItem | null> {
  const current = await get(id);
  if (!current) return null;
  const next: QueueItem = {
    ...current,
    ...patch,
    id: current.id,
    created_at: current.created_at,
    updated_at: _now(),
  };
  await store().set(`${QUEUE_PREFIX}${id}`, next);
  return next;
}

/** Find an existing pending/non-terminal item for a target_ref+kind so a
 *  re-scan doesn't enqueue a duplicate draft (dedupe per spec). Terminal
 *  states (rejected/sent) do NOT block a fresh draft for the same ref. */
export async function findActiveByTarget(
  kind: QueueKind,
  target_ref: string,
): Promise<QueueItem | null> {
  const items = await list({ kind });
  for (const item of items) {
    if (item.target_ref !== target_ref) continue;
    if (item.status === "rejected" || item.status === "sent") continue;
    return item;
  }
  return null;
}

// ── Status transitions ──────────────────────────────────────────

export async function approve(id: string): Promise<QueueItem | null> {
  return update(id, { status: "approved" });
}

export async function reject(id: string): Promise<QueueItem | null> {
  return update(id, { status: "rejected" });
}

export async function markSent(id: string): Promise<QueueItem | null> {
  // Clear any prior failure error on a successful (re)send.
  return update(id, { status: "sent", error: undefined });
}

export async function markFailed(id: string, error: string): Promise<QueueItem | null> {
  return update(id, { status: "failed", error });
}

export async function editBody(id: string, body: string): Promise<QueueItem | null> {
  return update(id, { draft_body: body });
}
