// ── notes — targeted Notes commenting (Phase 3) ─────────────────
//
// Pillar 3 (riskiest). For each note ref the user wants engaged
// (`targeted-notes-list` entity), fetch the note (client.listNote),
// draft a comment in the creator's voice + framework, and enqueue
// kind:"note-comment". Drafts only — sending is gated by the pacing
// guard in send_approved (lib/tools.ts), which can DEFER but never
// force-sends (locked constraint).
//
// All drafting flows through the shared `draftAndEnqueue` voice path;
// notes.ts adds no new LLM/queue seams. Targeted-note refs come from a
// tiny get-only store seam (the SDK managed entity namespace), injected
// by index.ts and swappable in tests.

import { toolError, toolResult } from "@ezcorp/sdk/runtime";
import type { ToolCallResult } from "@ezcorp/sdk";
import type { ToolHandlerContext } from "@ezcorp/sdk/runtime";
import { resolveClient } from "./substack-client";
import { findActiveByTarget, type QueueStoreLike } from "./review-queue";
import { draftAndEnqueue, readVoiceProfile } from "./tools";

// ── Targeted-notes-list reader (SDK managed entity namespace) ───

const TARGETED_ENTITY_KEY = "__entity:targeted-notes-list:default";

interface TargetedNotesEntity {
  /** Note refs (ids/urls) the user wants engaged. */
  noteRefs?: string[];
}

let _notesStore: Pick<QueueStoreLike, "get"> | null = null;

export function setNotesStore(store: Pick<QueueStoreLike, "get">): void {
  _notesStore = store;
}

export function _setNotesStoreForTests(
  store: Pick<QueueStoreLike, "get"> | null,
): void {
  _notesStore = store;
}

/** Read the configured targeted note refs (deduped, non-empty strings). */
export async function readTargetedNoteRefs(): Promise<string[]> {
  if (!_notesStore) return [];
  const res = await _notesStore.get<TargetedNotesEntity>(TARGETED_ENTITY_KEY);
  if (!res.exists || !res.value || !Array.isArray(res.value.noteRefs)) return [];
  const seen = new Set<string>();
  const refs: string[] = [];
  for (const ref of res.value.noteRefs) {
    if (typeof ref !== "string") continue;
    const trimmed = ref.trim();
    if (trimmed.length === 0 || seen.has(trimmed)) continue;
    seen.add(trimmed);
    refs.push(trimmed);
  }
  return refs;
}

// ── scan_notes ──────────────────────────────────────────────────

export async function scanNotes(
  _args: Record<string, unknown>,
  ctx?: ToolHandlerContext,
): Promise<ToolCallResult> {
  const settings = (ctx?.invocationMetadata?.settings ?? {}) as Record<string, unknown>;
  const resolved = await resolveClient(settings);
  if (!resolved.ok) return toolError(resolved.error, resolved.reason);
  const client = resolved.client;

  const refs = await readTargetedNoteRefs();
  const profile = await readVoiceProfile();

  let drafted = 0;
  let skipped = 0;
  let missing = 0;
  const failures: string[] = [];

  for (const ref of refs) {
    // Dedupe on the note ref — a re-scan never double-queues.
    const existing = await findActiveByTarget("note-comment", ref);
    if (existing) {
      skipped++;
      continue;
    }

    let note;
    try {
      note = await client.listNote(ref);
    } catch (err) {
      failures.push(`${ref}: ${(err as Error).message}`);
      continue;
    }
    // A missing/empty note body is a soft skip (the ref may have been
    // deleted upstream) — never an enqueue of an empty-context comment.
    if (!note || !note.body || note.body.trim().length === 0) {
      missing++;
      continue;
    }

    const res = await draftAndEnqueue(profile, {
      kind: "note-comment",
      framework: "note-comment",
      target_ref: ref,
      context: note.body,
    });
    if (res.ok) drafted++;
    else failures.push(`${ref}: ${res.error}`);
  }

  return toolResult(
    JSON.stringify(
      {
        ok: true,
        targeted: refs.length,
        drafted,
        skipped,
        missing,
        failed: failures.length,
        ...(failures.length > 0 ? { failures } : {}),
      },
      null,
      2,
    ),
  );
}
