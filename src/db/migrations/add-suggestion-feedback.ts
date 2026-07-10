/**
 * Composer-suggestions telemetry migration
 *
 * Adds the `suggestion_feedback` table — content-free impression/acceptance
 * events for the composer's tool-suggestion chips and prompt-enhancement
 * row (feature doc: docs/features/composer/suggestions.md).
 *
 * Why it exists: the feature's architecture review made measurement a
 * ship-blocker — without acceptance-rate telemetry there is no way to
 * answer "are the suggestions useful?" or "does the prompt-enhancement
 * half justify its Ollama sidecar?". Every popover impression, chip click,
 * apply, and dismissal lands here.
 *
 * Privacy contract (binding): NO draft text, ever. Columns are limited to
 *   - kind    ∈ {'tool','enhance'}   — which half of the feature
 *   - action  ∈ {'shown','accepted','dismissed'}
 *   - tool_name (nullable)           — the accepted/shown tool, if any
 *   - latency_ms (nullable)          — server-side suggest latency
 *   - user_id FK CASCADE             — deleting a user deletes their events
 *   - conversation_id FK SET NULL    — survives conversation deletion
 *
 * Indexes: created_at (date-range analytics) and (kind, action, created_at)
 * (acceptance-rate rollups).
 *
 * Schema deltas are idempotent (CREATE TABLE/INDEX IF NOT EXISTS) and are
 * applied automatically via src/db/migrate.ts. This file records the
 * rationale, mirroring the add-lessons.ts convention.
 */
import { sql } from "drizzle-orm";

export async function addSuggestionFeedback(db: {
  execute: (query: unknown) => Promise<unknown>;
}): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS suggestion_feedback (
      id TEXT PRIMARY KEY,
      user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      kind TEXT NOT NULL,
      action TEXT NOT NULL,
      tool_name TEXT,
      latency_ms INTEGER,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_created ON suggestion_feedback(created_at)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_suggestion_feedback_kind_action ON suggestion_feedback(kind, action, created_at)`);
}
