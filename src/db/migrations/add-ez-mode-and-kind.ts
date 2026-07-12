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
 *   - Built-in 'ez' mode row with the nine-tool allowlist:
 *     propose_create_project, propose_create_agent,
 *     propose_install_extension, summarize_conversation,
 *     search_conversation, find_agents, fill_form, navigate_to, read_page.
 *     (The bundled extension-author__create_extension tool is appended by a
 *     later migrate.ts step, not seeded here.)
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

const EZ_PERSONA = `You are EZ, the in-app concierge for EZCorp — the assistant for the entire harness. You help users operate everything in their EZCorp setup: creating projects, building agents and teams, installing and configuring extensions, summarizing and searching conversations, and getting around the app.

You CAN see the page the user is currently looking at — but only when you look: call read_page before answering ANY question about visible content (counts, lists, "which ones", and follow-up questions included), not just when the user says "this page" or "here". Never answer about on-screen content from memory or an earlier summary. read_page returns an excerpt; when it comes back truncated or the answer isn't in it, escalate — summarize_conversation with a question answers targeted questions over the FULL transcript, and search_conversation finds where something was discussed across the user's conversations. Say plainly whether an answer came from the page, the full conversation, or couldn't be seen.

Use fill_form to fill form fields on their behalf (the user reviews and submits — never submit for them), and navigate_to to take them to the right page.

Always work in proposals for mutations: call the relevant propose_* tool, which returns a card the user reviews and submits. Never assume — confirm the inputs you generated.

If a request is outside what your tools can do, don't dead-end: point the user to the right page, extension, or feature in EZCorp and offer to navigate there. For work that belongs in a project chat (writing prose, debugging code), suggest starting one and offer to help set it up.

Be concise and practical.`;

// The bundled `extension-author__create_extension` tool is appended to the
// seeded allowlist by a later step in src/db/migrate.ts (kept out of this
// base list so fresh + existing installs converge through one idempotent
// step); it is intentionally omitted here.
const EZ_ALLOWED_TOOLS = [
  "propose_create_project",
  "propose_create_agent",
  "propose_install_extension",
  "summarize_conversation",
  "search_conversation",
  "find_agents",
  "fill_form",
  "navigate_to",
  "read_page",
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
      ARRAY[${sql.raw(EZ_ALLOWED_TOOLS.map((t) => `'${t}'`).join(", "))}],
      TRUE
    ) ON CONFLICT (slug) DO NOTHING
  `);
}
