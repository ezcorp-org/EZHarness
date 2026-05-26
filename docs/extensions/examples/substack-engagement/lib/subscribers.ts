// ── subscribers — welcome DMs + timed follow-up sequences ───────
//
// Pillar 2. New-subscriber detection has NO webhook (locked decision /
// spec §2.2): we poll `client.listNewSubscribers(cursor)`, diff against
// a persisted cursor, and dedupe on subscriber id. Misses are expected —
// a subscriber not seen this poll surfaces on a later one.
//
// For each genuinely-new subscriber we:
//   1. draft a welcome DM (voice) → enqueue kind:"welcome-dm",
//      sequence_step:0, due_at: now (send-ready once approved).
//   2. schedule follow-up rows (sequence_step:1..) with due_at = now +
//      offset, draft_body:"" (drafted LAZILY at due time by
//      `runDueFollowups`, so a follow-up reflects the latest voice).
//
// Offsets + (optional) templates come from a `follow-up-sequence`
// entity; a built-in default is used when none is configured. All
// drafting flows through the shared `draftAndEnqueue` path in tools.ts
// (the same voice + LLM seam), so subscribers.ts adds no new seams.

import { toolError, toolResult } from "@ezcorp/sdk/runtime";
import type { ToolCallResult } from "@ezcorp/sdk";
import type { ToolHandlerContext } from "@ezcorp/sdk/runtime";
import { resolveClient } from "./substack-client";
import {
  enqueue,
  list,
  findActiveByTarget,
  update,
  now as queueNow,
  type QueueStoreLike,
} from "./review-queue";
import { draftAndEnqueue, draftRowBody, readVoiceProfile } from "./tools";

// ── Cursor persistence (over the same store as the queue) ───────
//
// The cursor lives at `subscriber-cursor` in the bound store. We use a
// tiny get/set seam so tests inject a fake without channel wiring; index
// .ts binds it to the same `new Storage("global")` as the queue.

const CURSOR_KEY = "subscriber-cursor";

let _cursorStore: Pick<QueueStoreLike, "get" | "set"> | null = null;

export function setCursorStore(store: Pick<QueueStoreLike, "get" | "set">): void {
  _cursorStore = store;
}

export function _setCursorStoreForTests(
  store: Pick<QueueStoreLike, "get" | "set"> | null,
): void {
  _cursorStore = store;
}

async function readCursor(): Promise<string | null> {
  if (!_cursorStore) return null;
  const res = await _cursorStore.get<string>(CURSOR_KEY);
  return res.exists && typeof res.value === "string" ? res.value : null;
}

async function writeCursor(cursor: string): Promise<void> {
  if (!_cursorStore) return;
  await _cursorStore.set(CURSOR_KEY, cursor);
}

// ── Follow-up sequence config ───────────────────────────────────

export interface FollowUpStep {
  /** Offset from the welcome (ms) at which this nudge becomes due. */
  offsetMs: number;
  /** Optional one-line steer appended to the draft prompt context. */
  note?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Built-in default sequence: a 3-day nudge then a 7-day nudge. */
export const DEFAULT_FOLLOWUP_SEQUENCE: FollowUpStep[] = [
  { offsetMs: 3 * DAY_MS, note: "Light 3-day check-in — anything they want to see more of?" },
  { offsetMs: 7 * DAY_MS, note: "7-day nudge — point to one popular past post." },
];

let _sequenceStore: Pick<QueueStoreLike, "get"> | null = null;

export function setSequenceStore(store: Pick<QueueStoreLike, "get">): void {
  _sequenceStore = store;
}

export function _setSequenceStoreForTests(
  store: Pick<QueueStoreLike, "get"> | null,
): void {
  _sequenceStore = store;
}

const SEQUENCE_ENTITY_KEY = "__entity:follow-up-sequence:default";

interface SequenceEntity {
  steps?: Array<{ offsetDays?: number; note?: string }>;
}

/**
 * Resolve the follow-up sequence. Reads the `follow-up-sequence` entity
 * (offsets in DAYS for human authoring) and converts to ms; falls back
 * to the built-in default when none is configured or the store is
 * unbound. Steps with a non-finite/negative offset are dropped.
 */
export async function resolveSequence(): Promise<FollowUpStep[]> {
  if (!_sequenceStore) return DEFAULT_FOLLOWUP_SEQUENCE;
  const res = await _sequenceStore.get<SequenceEntity>(SEQUENCE_ENTITY_KEY);
  if (!res.exists || !res.value || !Array.isArray(res.value.steps)) {
    return DEFAULT_FOLLOWUP_SEQUENCE;
  }
  const steps: FollowUpStep[] = [];
  for (const raw of res.value.steps) {
    const days = raw.offsetDays;
    if (typeof days !== "number" || !Number.isFinite(days) || days < 0) continue;
    const step: FollowUpStep = { offsetMs: Math.round(days * DAY_MS) };
    if (typeof raw.note === "string" && raw.note.trim().length > 0) {
      step.note = raw.note.trim();
    }
    steps.push(step);
  }
  return steps.length > 0 ? steps : DEFAULT_FOLLOWUP_SEQUENCE;
}

// ── scan_subscribers ────────────────────────────────────────────

export async function scanSubscribers(
  _args: Record<string, unknown>,
  ctx?: ToolHandlerContext,
): Promise<ToolCallResult> {
  const settings = (ctx?.invocationMetadata?.settings ?? {}) as Record<string, unknown>;
  const resolved = await resolveClient(settings);
  if (!resolved.ok) return toolError(resolved.error, resolved.reason);
  const client = resolved.client;

  const cursor = await readCursor();
  let page;
  try {
    page = await client.listNewSubscribers(cursor);
  } catch (err) {
    return toolError(
      `Failed to list subscribers: ${(err as Error).message}`,
      "CLIENT_ERROR",
    );
  }

  const profile = await readVoiceProfile();
  const sequence = await resolveSequence();
  // Use the queue's (test-injectable) clock so welcome `due_at: now` and
  // follow-up `due_at: now + offset` share ONE time source with the rows'
  // `created_at` stamps.
  const now = queueNow();

  let welcomed = 0;
  let skipped = 0;
  let followupsScheduled = 0;
  const failures: string[] = [];

  for (const sub of page.subscribers) {
    // Dedupe on subscriber id — a re-poll never re-welcomes the same sub.
    const existing = await findActiveByTarget("welcome-dm", sub.id);
    if (existing) {
      skipped++;
      continue;
    }

    // 1. Welcome DM — drafted now, send-ready (due_at: now) once approved.
    const welcomeCtx = `New subscriber: ${sub.name}`;
    const welcome = await draftAndEnqueue(profile, {
      kind: "welcome-dm",
      framework: "welcome-dm",
      target_ref: sub.id,
      context: welcomeCtx,
      due_at: now,
      sequence_step: 0,
    });
    if (!welcome.ok) {
      failures.push(`${sub.id}: ${welcome.error}`);
      continue;
    }
    welcomed++;

    // 2. Follow-up rows — empty draft_body, drafted LAZILY at due time so
    //    they reflect the latest voice. Enqueued via the queue directly
    //    (no LLM call now). sequence_step is 1-indexed.
    for (let i = 0; i < sequence.length; i++) {
      const step = sequence[i]!;
      await enqueueFollowupRow(sub.id, sub.name, i + 1, now + step.offsetMs);
      followupsScheduled++;
    }
  }

  // Advance the cursor so the next poll starts after this page.
  await writeCursor(page.cursor);

  return toolResult(
    JSON.stringify(
      {
        ok: true,
        seen: page.subscribers.length,
        welcomed,
        skipped,
        followupsScheduled,
        cursor: page.cursor,
        failed: failures.length,
        ...(failures.length > 0 ? { failures } : {}),
      },
      null,
      2,
    ),
  );
}

// Enqueue an undrafted follow-up row with an empty draft_body (the
// lazy-draft sentinel). The subscriber name is encoded into the context
// so the later lazy draft has voice context.
async function enqueueFollowupRow(
  subscriberId: string,
  subscriberName: string,
  step: number,
  dueAt: number,
): Promise<void> {
  await enqueue({
    kind: "welcome-dm",
    target_ref: subscriberId,
    context: `Follow-up for subscriber: ${subscriberName}`,
    draft_body: "", // lazy-draft sentinel
    due_at: dueAt,
    sequence_step: step,
  });
}

// ── runDueFollowups (lazy drafting at due time) ─────────────────
//
// The cron handler calls this every fire. It drafts any welcome-dm row
// that is DUE (due_at <= now), still PENDING, and NOT yet drafted
// (draft_body === ""). Not-yet-due rows and already-drafted rows are
// skipped. Drafting reflects the LATEST voice profile (the whole point
// of lazy drafting).

export async function runDueFollowups(
  now: number = Date.now(),
): Promise<{ drafted: number; skipped: number; failed: number }> {
  const profile = await readVoiceProfile();
  const candidates = (await list({ kind: "welcome-dm", status: "pending" })).filter(
    (i) => i.draft_body === "" && i.due_at !== null && i.due_at <= now,
  );

  let drafted = 0;
  let failed = 0;

  for (const item of candidates) {
    // Draft into the EXISTING row (draftAndEnqueue would create a new
    // one) — reuse the shared voice seam, then patch the body in place.
    const res = await draftRowBody(profile, "welcome-dm", item.context);
    if (!res.ok) {
      failed++;
      continue;
    }
    await update(item.id, { draft_body: res.body });
    drafted++;
  }

  // not-yet-due / already-drafted rows are simply never in `candidates`.
  return { drafted, skipped: 0, failed };
}
