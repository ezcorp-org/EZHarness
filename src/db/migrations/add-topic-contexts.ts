/**
 * Topic Contexts v1 migration
 *
 * Backs the "click a topic pill → extract that topic's context → copy +
 * store it searchable" feature. Four additive tables plus a seed of the
 * DB-resident classification enum.
 *
 * User's binding constraint: the classification type enum lives in the DB
 * (`context_types`) and every detection call reads the LIVE rows and
 * constrains the model's output to them — no near-duplicate enum
 * proliferation. Same discipline for topic labels (existing labels are fed
 * to the detection prompt for verbatim reuse; `lower(label)` uniqueness
 * keeps re-detection from spawning near-duplicate pills).
 *
 * Schema deltas (idempotent, additive — no destructive changes):
 *   - context_types (id slug PK, label, description, sort_order). Seeded
 *     with the 10 canonical types `ON CONFLICT (id) DO NOTHING` so a
 *     re-run (or an operator who edited a description) is not clobbered.
 *   - conversation_topics (id, conversation_id FK CASCADE, label, type_id
 *     FK, message_ids JSONB, timestamps) + a `(conversation_id,
 *     lower(label))` UNIQUE index. drizzle-orm has no portable
 *     functional-index helper, so — like the lessons partial-unique
 *     indexes — the `lower()` index is declared migration-side only.
 *   - conversation_topic_state (conversation_id PK FK CASCADE,
 *     last_message_id, message_count, model, analyzed_at) — the staleness
 *     watermark.
 *   - saved_contexts (id, user_id FK CASCADE, project_id FK CASCADE,
 *     conversation_id FK SET NULL, topic_label snapshot, type_id FK,
 *     title, content, model, message_count, timestamps) + a
 *     `(user_id, conversation_id, topic_label)` UNIQUE index (re-extract
 *     upserts, latest snapshot wins) and three read-path indexes.
 *
 * Re-detection semantics (NOT enforced at the DB — see
 * src/db/queries/contexts.ts `replaceTopics`): a transactional replace-set
 * keyed by `lower(label)`. Surviving labels KEEP their row id (stable pill
 * ids for the UI), missing labels are deleted, new labels inserted. The
 * `lower(label)` unique index is the safety net against a concurrent
 * double-detect racing two rows for the same label.
 *
 * This migration is applied automatically via src/db/migrate.ts. This file
 * exists for documentation and parallels add-lessons.ts.
 */
import { sql } from "drizzle-orm";

/** The 10 canonical classification types. Kept here (single source of
 *  truth) so both the migrate.ts inline seed and this doc-parallel `up()`
 *  stay identical. `description` is fed to the detection prompt. */
export const CONTEXT_TYPE_SEED: ReadonlyArray<{
  id: string;
  label: string;
  description: string;
  sortOrder: number;
}> = [
  { id: "feature", label: "Feature", description: "A capability or piece of functionality to build, or one that already exists.", sortOrder: 1 },
  { id: "idea", label: "Idea", description: "A proposal, suggestion, or brainstormed concept that has not been decided yet.", sortOrder: 2 },
  { id: "decision", label: "Decision", description: "A choice that was made, together with the reasoning behind it.", sortOrder: 3 },
  { id: "bug-fix", label: "Bug Fix", description: "A defect and how it was, or should be, resolved.", sortOrder: 4 },
  { id: "requirement", label: "Requirement", description: "A constraint or condition the solution must satisfy.", sortOrder: 5 },
  { id: "how-to", label: "How-To", description: "Step-by-step instructions or a procedure for accomplishing something.", sortOrder: 6 },
  { id: "code-snippet", label: "Code Snippet", description: "A concrete block of code, configuration, or command.", sortOrder: 7 },
  { id: "fact", label: "Fact", description: "A piece of reference information or an established truth worth remembering.", sortOrder: 8 },
  { id: "question", label: "Question", description: "An open question or unresolved inquiry raised in the conversation.", sortOrder: 9 },
  { id: "plan", label: "Plan", description: "A sequence of steps or a strategy toward a goal.", sortOrder: 10 },
];

export async function up(db: any): Promise<void> {
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS context_types (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      source TEXT NOT NULL DEFAULT 'seed',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  for (const t of CONTEXT_TYPE_SEED) {
    await db.execute(sql`
      INSERT INTO context_types (id, label, description, sort_order)
      VALUES (${t.id}, ${t.label}, ${t.description}, ${t.sortOrder})
      ON CONFLICT (id) DO NOTHING
    `);
  }

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS conversation_topics (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      label TEXT NOT NULL,
      type_id TEXT NOT NULL REFERENCES context_types(id) ON DELETE RESTRICT,
      message_ids JSONB NOT NULL DEFAULT '[]',
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_conversation_topics_conversation ON conversation_topics(conversation_id)`);
  // Case-insensitive label uniqueness per conversation — migration-only
  // (drizzle has no portable functional-index helper).
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_topics_conv_label_unique
      ON conversation_topics(conversation_id, lower(label))
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS conversation_topic_state (
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
      last_message_id TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      model TEXT,
      analyzed_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);

  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS saved_contexts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      project_id TEXT REFERENCES projects(id) ON DELETE CASCADE,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE SET NULL,
      topic_label TEXT NOT NULL,
      type_id TEXT NOT NULL REFERENCES context_types(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      model TEXT,
      message_count INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW()
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_saved_contexts_user_created ON saved_contexts(user_id, created_at DESC)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_saved_contexts_project ON saved_contexts(project_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_saved_contexts_type ON saved_contexts(type_id)`);
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_saved_contexts_unique
      ON saved_contexts(user_id, conversation_id, topic_label)
  `);
}
