/**
 * Phase 48: Ez Mode + Conversation Kind + Ez Drafts migration
 *
 * Schema deltas (idempotent, additive — no destructive changes):
 *   - modes.allowed_tools (text[], NULL unless tool_restriction = 'allowlist')
 *   - conversations.kind (text NOT NULL DEFAULT 'regular') — 'regular' | 'ez'
 *   - ez_drafts table (uuid pk, user fk, kind, payload jsonb, createdAt,
 *     expiresAt, consumedAt) — 24h TTL drafts for the Ez concierge's
 *     `propose_*` tool family. The destination form page reads ?prefill=<id>
 *     and stamps consumed_at on submit.
 *   - Unique partial index `conversations_user_ez_unique` enforces exactly
 *     one ez-kind conversation per user at the DB level.
 *
 * Seed:
 *   - Built-in 'ez' mode row with the seven-tool allowlist:
 *     propose_create_project, propose_create_agent,
 *     propose_install_extension, summarize_conversation, find_agents,
 *     fill_form, navigate_to.
 *
 * The mode's `tool_restriction` is set to 'allowlist' — a new value added
 * to the existing 'all' | 'read-only' | 'none' set. applyToolFilters() in
 * src/runtime/tools/filter.ts already accepts an `allowedTools?: string[]`
 * filter; broadening the type union is the only filter-side change.
 *
 * The Ez persona text lives in `system_prompt_instruction`; tuning it is a
 * normal mode update, not a code change.
 *
 * This migration is applied automatically via src/db/migrate.ts. This file
 * exists for documentation and parallels add-fork-tracking.ts /
 * add-sub-convo-and-references.ts.
 */
import { sql } from "drizzle-orm";

const EZ_PERSONA = `You are EZ, the in-app concierge for EZCorp. You help users manage and operate their EZCorp setup — creating projects, building agents, installing extensions, and summarizing their conversations.

You are not a general-purpose assistant. If a user asks for help that isn't about EZCorp itself (e.g., writing prose, debugging unrelated code), gently redirect them to start a regular project chat.

Always work in proposals: when the user asks for a mutation, call the relevant propose_* tool, which returns a card with a button that opens the prefilled form. The user reviews and submits. Never assume — confirm the inputs you generated.

You have limited awareness of what the user is currently looking at. You CANNOT see their open page, the conversation they have on screen, or the form they are filling. If a request needs a specific id or path (e.g. "summarize this conversation"), ask the user for it or look it up via an available tool — do not guess.

Be terse. The user is doing real work and you are a tool, not a friend.`;

const EZ_ALLOWED_TOOLS = [
  "propose_create_project",
  "propose_create_agent",
  "propose_install_extension",
  "summarize_conversation",
  "find_agents",
  "fill_form",
  "navigate_to",
];

export async function up(db: any): Promise<void> {
  // ── Schema deltas ────────────────────────────────────────────────
  await db.execute(sql`ALTER TABLE modes ADD COLUMN IF NOT EXISTS allowed_tools TEXT[]`);
  await db.execute(sql`ALTER TABLE conversations ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'regular'`);

  // Ez drafts table
  await db.execute(sql`
    CREATE TABLE IF NOT EXISTS ez_drafts (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      kind TEXT NOT NULL,
      payload JSONB NOT NULL,
      created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
      consumed_at TIMESTAMP WITH TIME ZONE
    )
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ez_drafts_user ON ez_drafts(user_id)`);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_ez_drafts_expires ON ez_drafts(expires_at)`);

  // ── Unique partial index: one ez conversation per user ──────────
  await db.execute(sql`
    CREATE UNIQUE INDEX IF NOT EXISTS conversations_user_ez_unique
      ON conversations (user_id)
      WHERE kind = 'ez'
  `);

  // ── Seed Ez mode ────────────────────────────────────────────────
  // ON CONFLICT (slug) DO NOTHING — idempotent, mirrors the Plan/Code Review
  // mode seeds in migrate.ts. Re-running the migration leaves an existing
  // ez row untouched (admins can mutate via direct SQL if persona tuning
  // is needed; the API guard rejects PATCH on builtin = true).
  await db.execute(sql`
    INSERT INTO modes (
      id, slug, name, icon, description, system_prompt_instruction,
      instruction_position, tool_restriction, allowed_tools, builtin
    ) VALUES (
      'builtin-ez',
      'ez',
      'Ez',
      '🪄',
      'In-app concierge for managing your EZCorp setup.',
      ${EZ_PERSONA},
      'replace',
      'allowlist',
      ${EZ_ALLOWED_TOOLS},
      TRUE
    ) ON CONFLICT (slug) DO NOTHING
  `);
}
