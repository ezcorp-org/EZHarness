// ── scratch — conversation-scoped pipeline state ────────────────
//
// The 3-tool surface (draft → revise → finalize) needs to carry the
// summary + current draft + round count BETWEEN tool calls without
// shuttling large markdown blobs back through the LLM. We keep that in
// conversation-scoped extension storage under a single key. Scope
// resolution is host-side from the subprocess's current conversation
// (`_meta.ezConversationId`), so no conversationId is passed explicitly.
//
// Test seam mirrors substack-pilot's `_setPostTypeStoreForTests`: a
// narrow StoreLike injected so `lib/pipeline.ts` is unit-testable with
// no `ezcorp/storage` RPC.

import { Storage } from "@ezcorp/sdk/runtime";

export const SCRATCH_KEY = "pipeline-scratch";

export interface Scratch {
  url: string;
  styleNote?: string;
  sourceTitle: string;
  summary: string;
  draft: string;
  /** Number of completed revise rounds — soft-capped in `lib/pipeline.ts`. */
  rounds: number;
}

interface StoreLike {
  get<T = unknown>(key: string): Promise<{ value: T | null; exists: boolean }>;
  set<T = unknown>(key: string, value: T): Promise<unknown>;
  delete(key: string): Promise<unknown>;
}

let _store: StoreLike = new Storage("conversation");

/** Test-only: inject a fake conversation store. Pass null to restore. */
export function _setStoreForTests(fake: StoreLike | null): void {
  _store = fake ?? new Storage("conversation");
}

export async function readScratch(): Promise<Scratch | null> {
  const res = await _store.get<Scratch>(SCRATCH_KEY);
  return res.exists && res.value ? res.value : null;
}

export async function writeScratch(s: Scratch): Promise<void> {
  await _store.set(SCRATCH_KEY, s);
}

export async function clearScratch(): Promise<void> {
  await _store.delete(SCRATCH_KEY);
}
