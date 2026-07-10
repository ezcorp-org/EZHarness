import { pgTable, text, timestamp, jsonb, integer, real, serial, bigint, boolean, index, primaryKey, uniqueIndex, date, vector } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PipelineStep } from "../types";
import type { MemoryProvenance } from "../memory/types";
import { EMBEDDING_DIMENSIONS } from "../memory/types";
import type {
  GithubColumnActionMap,
  GithubProposalAction,
  GithubProposalStatus,
  GithubStatusOption,
} from "../integrations/github-projects/types";

export const projects = pgTable("projects", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  path: text("path").notNull(),
  icon: text("icon"),
  variables: jsonb("variables").notNull().$type<Record<string, unknown>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull().$type<unknown>(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runs = pgTable("runs", {
  id: text("id").primaryKey(),
  agentName: text("agent_name").notNull(),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  // Owning conversation for chat runs — used to enforce run ownership on
  // /api/runs/[id]. Null for agent/CLI runs that have no conversation.
  conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  // Initiating user — the principal who started the run. Authoritative for
  // run-ownership enforcement on /api/runs/[id] (closes the cross-tenant
  // IDOR that NULL conversation_id left open for agent/CLI/pre-migration
  // runs). For chat runs this is the ROOT conversation's owner (resolved at
  // insert time, so sub-conversation runs attribute to the real owner). Null
  // only for runs that genuinely cannot be attributed to a user — those are
  // admin-only for non-admins (fail closed). FK SET NULL: deleting a user
  // un-attributes their historical runs (then admin-only) rather than
  // cascading them away.
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  status: text("status").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
  result: jsonb("result").$type<{ success: boolean; output: unknown; error?: string | { code: string; message: string } }>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const runLogs = pgTable("run_logs", {
  id: serial("id").primaryKey(),
  runId: text("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  timestamp: bigint("timestamp", { mode: "number" }).notNull(),
  level: text("level").notNull(),
  message: text("message").notNull(),
});

export const conversations = pgTable("conversations", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  title: text("title").notNull().default("New conversation"),
  model: text("model"),
  provider: text("provider"),
  systemPrompt: text("system_prompt"),
  agentConfigId: text("agent_config_id").references(() => agentConfigs.id, { onDelete: "set null" }),
  modeId: text("mode_id").references(() => modes.id, { onDelete: "set null" }),
  parentConversationId: text("parent_conversation_id").references((): any => conversations.id, { onDelete: "cascade" }),
  parentMessageId: text("parent_message_id"),
  forkedFromConversationId: text("forked_from_conversation_id").references((): any => conversations.id, { onDelete: "set null" }),
  forkedFromMessageId: text("forked_from_message_id"),
  test: boolean("test").default(false),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  /** Phase 2d: opaque per-conversation bag for runtime-only flags. Currently
   *  holds `spawnDepth: number` tracked by spawn-assignment-handler.ts, plus
   *  the `/goal` feature's `goal` key (compile-time-only, no DB DDL — D3).
   *
   *  `goal` shape — see {@link import("../runtime/goal-host").PersistedGoal}:
   *    `{ condition: string; lastReason: string | null; createdAt: string }`.
   *  KEY PRESENCE = armed; KEY DELETION = disarm (achieve / clear / cap).
   *  There is no `armed` boolean on the persisted shape. Paused-ness lives
   *  ONLY in the in-memory `GoalRecord.status` and is never persisted, so a
   *  paused goal still has `metadata.goal` present and FR-13b can resume it. */
  metadata: jsonb("metadata").$type<Record<string, unknown> & {
    spawnDepth?: number;
    spawnParentAuditId?: string;
    goal?: {
      condition: string;
      lastReason: string | null;
      createdAt: string;
    };
  }>(),
  /** Phase 48: distinguishes regular per-project chats from the global Ez
   *  concierge conversation (one per user, enforced by a unique partial index
   *  `conversations_user_ez_unique` declared in migrate.ts). Mutating modeId
   *  on a kind='ez' row is rejected at the API layer. */
  kind: text("kind").notNull().default("regular").$type<"regular" | "ez">(),
  /** Per-conversation tool scoping. Keyed by extension id; the value is the
   *  list of selected tool names for that extension. Mirrors
   *  modes.extensionTools / agent_configs.extensionTools: an extension absent
   *  here (or mapped to an empty array) contributes ALL its tools, while a
   *  non-empty array narrows. Crucially this map can only NARROW the mode's
   *  allowlist — it never widens it (see src/runtime/executor.ts). */
  extensionTools: jsonb("extension_tools").$type<Record<string, string[]>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  /**
   * Free-form role string (no enum). Known values:
   *  - "user", "assistant", "system" — standard chat turns.
   *  - "extension" — synthetic placeholder rows for tool-card payloads.
   *  - "ez-action-result" — JSON-encoded EzActionResult cards.
   *  - "preprocess-result" — deterministic-preprocess tool cards
   *    (JSON `{extensionName, toolName, cardType?, ok, output}`),
   *    persisted by `src/runtime/stream-chat/preprocess.ts`, chained
   *    into the branch path, and stripped from LLM context by
   *    `load-history.ts`.
   *  - "capability-event" (Phase 52.5) — JSON sentinel inserted by
   *    `recordCapabilityCall` (write 3). Carries the
   *    `sdkCapabilityCallId` FK + a redacted summary of the call.
   *    Stripped from LLM context by `load-history.ts`. Renders inline
   *    via `CapabilityEventPill`. Visibility is gated client-side via
   *    `global:showBuiltinCapabilityEvents` /
   *    `global:showInstalledCapabilityEvents` settings; the row
   *    itself is ALWAYS inserted so audit replay stays complete.
   *
   * No migration is required to add a new value — column is plain
   * text.
   */
  role: text("role").notNull(),
  content: text("content").notNull(),
  thinkingContent: text("thinking_content"),
  model: text("model"),
  provider: text("provider"),
  // `cache*` fields are the WS0 prompt-cache meter (tokens served from / written
  // to the provider cache this turn + the derived hit-rate). `requested*` /
  // `routedTier` / `failover` are routing provenance (requested vs served —
  // the `model`/`provider` COLUMNS carry the served values; the jsonb carries
  // only what the columns can't). All optional — jsonb, so pre-cache rows and
  // non-caching providers remain valid with no migration. This is the ONE
  // canonical usage shape — `CreateMessageUsage` (queries/conversations.ts) and
  // the web `Message.usage` type (web/src/lib/api.ts) mirror it.
  usage: jsonb("usage").$type<{
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    cacheHitRate?: number;
    /** Subset of cacheWriteTokens written with 1h retention (Anthropic-only; billed at 2× input). */
    cacheWrite1hTokens?: number;
    /** User-pinned provider at request time; null ⇒ Auto/routed. */
    requestedProvider?: string | null;
    /** User-pinned model at request time; null ⇒ Auto/routed. */
    requestedModel?: string | null;
    /** Tier the router selected — only present when routing fired. */
    routedTier?: "fast" | "balanced" | "powerful";
    /** True when the served provider ≠ the initially resolved provider. */
    failover?: boolean;
  }>(),
  runId: text("run_id").references(() => runs.id, { onDelete: "set null" }),
  parentMessageId: text("parent_message_id"),
  // When true, load-history drops this row from the array sent to pi-ai on
  // subsequent turns. The transcript still renders it (struck-through).
  excluded: boolean("excluded").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Message Attachments (multi-modal uploads) ─────────────────────

export const messageAttachments = pgTable("message_attachments", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  storagePath: text("storage_path").notNull(),
  kind: text("kind").notNull().$type<"image" | "text" | "pdf" | "audio" | "extension-handle">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_msg_attachments_message").on(table.messageId),
  index("idx_msg_attachments_conversation").on(table.conversationId),
]);

export type MessageAttachment = typeof messageAttachments.$inferSelect;
export type NewMessageAttachment = typeof messageAttachments.$inferInsert;

// ── Phase 63: Message Chunks (hybrid chat search index) ───────────
// Durable per-message chunk store mirroring knowledge_base_chunks with
// the FK retargeted onto messages. Each chunk carries a vector(384)
// embedding on an HNSW index (NOT ivfflat) and records which model
// produced it (embedding_model_id). Both message-delete and the
// chained conversation-delete cascade away a message's chunks.
//
// DESIGN — `conversation_id` is DENORMALIZED here (research Open
// Question #2): Phase 65 SRCH-05 needs per-conversation scoping inside
// the ANN CTE without a join back to messages. The dual CASCADE
// precedent is message_attachments.

export const messageChunks = pgTable("message_chunks", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  messageId: text("message_id").notNull().references(() => messages.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
  embeddingModelId: text("embedding_model_id").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_message_chunks_message").on(table.messageId),
  index("idx_message_chunks_conversation").on(table.conversationId),
]);

// ── Phase 63: Message Embed Outbox (one row per message) ──────────
// LEAN per research Open Question #1: message_id PK gives the
// one-row-per-message guarantee AND the ON CONFLICT (message_id)
// upsert target Plan 03 uses. status/attempts/timestamps only — NO
// content-hash / model_id column (the Phase 64 worker reads the
// current message text at drain time). Defer any hash column to
// Phase 64 if the worker needs it.

export const messageEmbedOutbox = pgTable("message_embed_outbox", {
  messageId: text("message_id").primaryKey().references(() => messages.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  status: text("status").notNull().$type<"pending" | "in_progress" | "failed">().default("pending"),
  attempts: integer("attempts").notNull().default(0),
  // Phase 64: backoff gate. NULL = eligible immediately; a future timestamp
  // gates claimBatch until it passes. No DB default — NULL is the sentinel
  // (raw ALTER in migrate.ts adds the column; this binding lets the typed
  // upsert clear a stale stamp on re-enqueue).
  nextAttemptAfter: timestamp("next_attempt_after", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MessageChunk = typeof messageChunks.$inferSelect;
export type NewMessageChunk = typeof messageChunks.$inferInsert;
export type MessageEmbedOutbox = typeof messageEmbedOutbox.$inferSelect;

export const agentConfigs = pgTable("agent_configs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  capabilities: jsonb("capabilities").notNull().$type<string[]>().default(["llm"]),
  prompt: text("prompt").notNull(),
  inputSchema: jsonb("input_schema").$type<Record<string, unknown>>(),
  outputFormat: text("output_format").default("text"),
  provider: text("provider"),
  model: text("model"),
  temperature: real("temperature"),
  maxTokens: integer("max_tokens"),
  category: text("category"),
  extensions: jsonb("extensions").$type<string[]>().default([]),
  /** Per-extension tool subset (extension id → selected tool names), mirroring
   *  modes.extensionTools. An extension in `extensions` but absent here (or
   *  mapped to an empty array) contributes ALL its tools when the agent runs;
   *  a non-empty array narrows it to just those tools. Applied at the agent's
   *  execution chokepoint (ExtensionRegistry.getToolsForAgent). NULL for
   *  existing rows preserves prior all-tools behaviour. */
  extensionTools: jsonb("extension_tools").$type<Record<string, string[]>>(),
  references: jsonb("references").$type<{ agents: string[]; extensions: string[]; members?: import("../types").TeamMember[]; autoSpinUp?: boolean; teamToolScope?: import("../types").TeamToolScope }>().default({ agents: [], extensions: [] }),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const pipelineDefinitions = pgTable("pipeline_definitions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull().unique(),
  description: text("description").notNull().default(""),
  inputSchema: jsonb("input_schema").$type<Record<string, unknown>>(),
  steps: jsonb("steps").notNull().$type<PipelineStep[]>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Memory System ──────────────────────────────────────────────────

export const memories = pgTable("memories", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  content: text("content").notNull(),
  category: text("category").notNull().$type<"preferences" | "biographical" | "technical" | "decisions_goals">(),
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  messageIds: jsonb("message_ids").$type<string[]>(),
  confidence: text("confidence").notNull().default("medium").$type<"high" | "medium" | "low">(),
  status: text("status").notNull().default("active").$type<"active" | "stale" | "archived">(),
  lastAccessedAt: timestamp("last_accessed_at", { withTimezone: true }).notNull().defaultNow(),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
  provenance: jsonb("provenance").$type<MemoryProvenance>(),
  // Phase 51: extension-authored memories default `false` so they do
  // NOT auto-inject into LLM system prompts; host-extracted memories
  // default `true` (preserves current behavior; existing rows
  // backfilled to true via migration). Reads filter on this when
  // building system-prompt context. Column type is boolean NOT NULL
  // with a server default; the migration below handles legacy rows.
  injectionEligible: boolean("injection_eligible").notNull().default(true),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_memories_project_id").on(table.projectId),
  index("idx_memories_category").on(table.category),
]);

export const memoryAuditLog = pgTable("memory_audit_log", {
  id: serial("id").primaryKey(),
  memoryId: text("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
  action: text("action").notNull().$type<"created" | "updated" | "merged" | "deleted" | "status_change">(),
  previousContent: text("previous_content"),
  newContent: text("new_content"),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

// ── Memory ↔ Project junction (many-to-many) ──────────────────────

export const memoryProjects = pgTable("memory_projects", {
  memoryId: text("memory_id").notNull().references(() => memories.id, { onDelete: "cascade" }),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_memory_projects_memory").on(table.memoryId),
  index("idx_memory_projects_project").on(table.projectId),
]);

export type MemoryProject = typeof memoryProjects.$inferSelect;
export type NewMemoryProject = typeof memoryProjects.$inferInsert;

// Inferred types for memory operations
export type Memory = typeof memories.$inferSelect;
export type NewMemory = typeof memories.$inferInsert;

// ── Knowledge Base ───────────────────────────────────────────────

export const knowledgeBaseFiles = pgTable("knowledge_base_files", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  orgScoped: boolean("org_scoped").notNull().default(false),
  filename: text("filename").notNull(),
  mimeType: text("mime_type").notNull(),
  fileSize: integer("file_size").notNull(),
  chunkCount: integer("chunk_count").notNull().default(0),
  status: text("status").notNull().default("processing").$type<"processing" | "ready" | "error">(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const knowledgeBaseChunks = pgTable("knowledge_base_chunks", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  fileId: text("file_id").notNull().references(() => knowledgeBaseFiles.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  chunkIndex: integer("chunk_index").notNull(),
  embedding: vector("embedding", { dimensions: EMBEDDING_DIMENSIONS }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type KBFile = typeof knowledgeBaseFiles.$inferSelect;
export type NewKBFile = typeof knowledgeBaseFiles.$inferInsert;
export type KBChunk = typeof knowledgeBaseChunks.$inferSelect;
export type NewKBChunk = typeof knowledgeBaseChunks.$inferInsert;

// ── Extensions ────────────────────────────────────────────────────

export const extensions = pgTable("extensions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull().unique(),
  version: text("version").notNull(),
  description: text("description").notNull().default(""),
  manifest: jsonb("manifest").notNull().$type<import("../extensions/types").ExtensionManifestV2>(),
  source: text("source").notNull(),
  installPath: text("install_path"),
  enabled: boolean("enabled").notNull().default(true),
  grantedPermissions: jsonb("granted_permissions").notNull().$type<import("../extensions/types").ExtensionPermissions>().default({} as any),
  /**
   * v1.3 release-readiness security review HIGH 2 — install-time NARROWED choice.
   *
   * Distinct from `manifest.permissions` (the extension's REQUEST) and from
   * `grantedPermissions` (the CURRENT effective grant, which the
   * capability-expiry sweep may have narrowed to {}). Captures exactly what
   * the user/admin approved at install/activate time, including any narrowing
   * relative to the manifest's declared ceiling AND, for bundled extensions,
   * any clamping against `BUNDLED_CEILING`.
   *
   * The reapprove handler (`/api/extensions/[id]/reapprove`) reads this as
   * the authoritative ceiling for re-grants, so the user's narrowing survives
   * a sweep + reapprove cycle. Legacy rows installed before this column
   * existed are NULL and fall back to clamping against the manifest, which
   * is the pre-fix behavior. See `tasks/v1.3-security-review.md` HIGH 2.
   */
  installedPermissions: jsonb("installed_permissions").$type<import("../extensions/types").ExtensionPermissions>(),
  checksumVerified: boolean("checksum_verified").notNull().default(false),
  // Provenance flag: true ONLY when this row was created by bundled.ts's
  // ensureBundledExtensions path. Authorizes skipping the runtime checksum
  // gate. Must never be inferred from manifest.name — that lookup was the
  // finding #2 vulnerability (an attacker could install an extension
  // manifested as name:"ai-kit" and inherit bundled trust).
  isBundled: boolean("is_bundled").notNull().default(false),
  // Creator attribution for user-authored extensions. Set ONLY by the
  // authored-install path (installAuthoredDraft → installFromLocal);
  // bundled/github/mcp installs leave it NULL. Nullable + ON DELETE SET
  // NULL so deleting a user doesn't cascade-drop their extensions.
  // Recorded going-forward only — pre-existing rows are NULL and are
  // therefore never user-modifiable (admins can still act).
  creatorUserId: text("creator_user_id").references(() => users.id, { onDelete: "set null" }),
  // Admin-only gate: an extension may be re-opened/modified by its
  // creator ONLY when an admin has flipped this true. Defaults false so
  // the in-chat LLM can never silently rewrite an extension.
  modifiable: boolean("modifiable").notNull().default(false),
  consecutiveFailures: integer("consecutive_failures").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const toolCalls = pgTable("tool_calls", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
  messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
  extensionId: text("extension_id").notNull().references(() => extensions.id, { onDelete: "cascade" }),
  toolName: text("tool_name").notNull(),
  input: jsonb("input").$type<Record<string, unknown>>(),
  output: jsonb("output").$type<Record<string, unknown>>(),
  success: boolean("success").notNull(),
  durationMs: integer("duration_ms").notNull(),
  cardType: text("card_type"),
  // "inline" | "dock" | NULL. Drives the chat UI's DockHost auto-open.
  // NULL is treated as "inline" by the host — see web/src/lib/components/tool-cards/utils.ts:shouldRenderInDock.
  cardLayout: text("card_layout"),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  agentConfigId: text("agent_config_id").references(() => agentConfigs.id, { onDelete: "set null" }),
  model: text("model"),
  provider: text("provider"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  // Plain created_at index powers every analytics query's date-range filter.
  // A (tool_name, created_at) index would be dead weight for getToolUsageByTool —
  // that query has no tool_name predicate, and Postgres doesn't skip-scan.
  index("idx_tool_calls_created_at").on(table.createdAt),
  // Dimension-leading composites are used by the by-user/by-agent/by-model
  // queries which DO filter on the leading column (isNotNull(dim)).
  index("idx_tool_calls_user_created").on(table.userId, table.createdAt),
  index("idx_tool_calls_agent_created").on(table.agentConfigId, table.createdAt),
  index("idx_tool_calls_model_created").on(table.model, table.createdAt),
]);

// ── Composer suggestion telemetry ─────────────────────────────────
// Impression/acceptance events for composer suggestions (tool chips +
// prompt-enhancement). Deliberately content-free: kind/action/tool name/
// latency only — NEVER draft text (privacy contract; see
// docs/features/composer/suggestions.md). Acceptance rates are the
// measurement that decides whether the enhancement half keeps earning
// its sidecar.

export const suggestionFeedback = pgTable("suggestion_feedback", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  kind: text("kind").notNull().$type<"tool" | "enhance">(),
  action: text("action").notNull().$type<"shown" | "accepted" | "dismissed">(),
  toolName: text("tool_name"),
  latencyMs: integer("latency_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_suggestion_feedback_created").on(table.createdAt),
  index("idx_suggestion_feedback_kind_action").on(table.kind, table.action, table.createdAt),
]);

export type SuggestionFeedbackRow = typeof suggestionFeedback.$inferSelect;
export type NewSuggestionFeedbackRow = typeof suggestionFeedback.$inferInsert;

// ── Observability ─────────────────────────────────────────────────

export const observabilityEvents = pgTable("observability_events", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  messageId: text("message_id").references(() => messages.id, { onDelete: "set null" }),
  eventType: text("event_type").notNull(),
  data: jsonb("data").notNull(),
  durationMs: integer("duration_ms"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ObservabilityEvent = typeof observabilityEvents.$inferSelect;
export type NewObservabilityEvent = typeof observabilityEvents.$inferInsert;

// ── Extension Storage (isolated per-extension KV) ────────────────

export const extensionStorage = pgTable("extension_storage", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  extensionId: text("extension_id").notNull().references(() => extensions.id, { onDelete: "cascade" }),
  scope: text("scope").notNull().$type<"global" | "conversation" | "user">(),
  scopeId: text("scope_id"), // null for global, conversationId or userId for scoped
  key: text("key").notNull(),
  value: jsonb("value").notNull().$type<unknown>(),
  encrypted: boolean("encrypted").notNull().default(false),
  sizeBytes: integer("size_bytes").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_ext_storage_lookup").on(table.extensionId, table.scope, table.scopeId, table.key),
  index("idx_ext_storage_extension").on(table.extensionId),
  index("idx_ext_storage_expires").on(table.expiresAt),
]);

export type ExtensionStorageRow = typeof extensionStorage.$inferSelect;
export type NewExtensionStorageRow = typeof extensionStorage.$inferInsert;

// ── Extension Settings ────────────────────────────────────────────
// Per-user persistence for the manifest's `settings` schema. Values
// are merged at read time as `declared defaults < user override` by
// `resolveExtensionSettings()` in src/db/queries/extension-settings.ts.

export const extensionSettingsUser = pgTable("extension_settings_user", {
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  extensionId: text("extension_id").notNull().references(() => extensions.id, { onDelete: "cascade" }),
  values: jsonb("values").notNull().$type<Record<string, unknown>>().default({}),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.userId, table.extensionId] }),
]);

export type ExtensionSettingsUserRow = typeof extensionSettingsUser.$inferSelect;

export type Extension = typeof extensions.$inferSelect;
export type NewExtension = typeof extensions.$inferInsert;
export type ToolCall = typeof toolCalls.$inferSelect;

// ── Modes ─────────────────────────────────────────────────────────

export const modes = pgTable("modes", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  slug: text("slug").notNull().unique(),
  icon: text("icon"),
  description: text("description").notNull().default(""),
  systemPromptInstruction: text("system_prompt_instruction").notNull(),
  instructionPosition: text("instruction_position").notNull().default("prepend").$type<"prepend" | "append" | "replace">(),
  preferredModel: text("preferred_model"),
  preferredProvider: text("preferred_provider"),
  preferredThinkingLevel: text("preferred_thinking_level").$type<"off" | "minimal" | "low" | "medium" | "high" | "xhigh">(),
  temperature: real("temperature"),
  toolRestriction: text("tool_restriction").notNull().default("all").$type<"all" | "read-only" | "none" | "allowlist">(),
  /** Phase 48: when toolRestriction === 'allowlist', this column carries the
   *  exact set of tool names that survive filtering (orchestration tools are
   *  always preserved; see ORCHESTRATION_TOOLS in src/runtime/tools/filter.ts).
   *  NULL otherwise — the existing applyToolFilters intersection logic treats
   *  empty/missing allowedTools as a no-op for non-allowlist modes. */
  allowedTools: text("allowed_tools").array(),
  /** Extensions attached to this mode. When non-empty, the runtime resolves
   *  the union of tools provided by these extensions and uses that set as
   *  the effective allowlist (see src/runtime/executor.ts). When empty/null,
   *  the toolRestriction + allowedTools fallback continues to govern. */
  extensionIds: text("extension_ids").array(),
  /** Per-extension tool subset. Keyed by extension id; the value is the list
   *  of selected tool names for that extension. An extension present in
   *  extensionIds but absent here (or mapped to an empty array) contributes
   *  ALL its tools (backward-compatible default); a non-empty array narrows
   *  the contribution to just those tools. See src/runtime/executor.ts. */
  extensionTools: jsonb("extension_tools").$type<Record<string, string[]>>(),
  builtin: boolean("builtin").notNull().default(false),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Mode = typeof modes.$inferSelect;
export type NewMode = typeof modes.$inferInsert;

// ── Phase 37: Conversation Extensions (dynamic tool wiring) ─────

export const conversationExtensions = pgTable("conversation_extensions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull()
    .references(() => conversations.id, { onDelete: "cascade" }),
  extensionId: text("extension_id").notNull()
    .references(() => extensions.id, { onDelete: "cascade" }),
  addedByMessageId: text("added_by_message_id")
    .references(() => messages.id, { onDelete: "set null" }),
  /**
   * Phase 4: per-conversation effective grant override. When set,
   * the PDP consults THIS blob in place of `extensions.grantedPermissions`
   * for tool calls in this conversation. Only populated by spawn
   * assignment when the parent's caps need to clip the child — the
   * top-level conversation always leaves it null and falls back to
   * the extension's installed grants.
   */
  effectiveGrantedPermissions: jsonb("effective_granted_permissions")
    .$type<import("../extensions/types").ExtensionPermissions | null>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ConversationExtension = typeof conversationExtensions.$inferSelect;

// ── Phase 37: Active Runs (resilience tracking) ─────────────────

export const activeRuns = pgTable("active_runs", {
  id: text("id").primaryKey(),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  status: text("status").notNull().default("running").$type<"running" | "interrupted" | "completed">(),
  startedAt: timestamp("started_at", { withTimezone: true }).notNull().defaultNow(),
  lastHeartbeat: timestamp("last_heartbeat", { withTimezone: true }).notNull().defaultNow(),
  partialResponse: text("partial_response"),
});

export type ActiveRun = typeof activeRuns.$inferSelect;
export type NewActiveRun = typeof activeRuns.$inferInsert;

// ── Phase 8: Users & Auth ────────────────────────────────────────

export const users = pgTable("users", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email").notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  name: text("name").notNull(),
  role: text("role").notNull().default("member").$type<"admin" | "member">(),
  status: text("status").notNull().default("active").$type<"active" | "inactive">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  onboardedAt: timestamp("onboarded_at", { withTimezone: true }),
});

export const invites = pgTable("invites", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  email: text("email"),
  token: text("token").notNull().unique(),
  role: text("role").notNull().default("member").$type<"admin" | "member">(),
  createdBy: text("created_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export const passwordResetTokens = pgTable("password_reset_tokens", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  token: text("token").notNull().unique(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  usedAt: timestamp("used_at", { withTimezone: true }),
});

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;
export type Invite = typeof invites.$inferSelect;
export type NewInvite = typeof invites.$inferInsert;
export type PasswordResetToken = typeof passwordResetTokens.$inferSelect;
export type NewPasswordResetToken = typeof passwordResetTokens.$inferInsert;

// ── Phase 43: Sessions ──────────────────────────────────────────────

export const sessions = pgTable("sessions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull().unique(),
  // Sliding-refresh grace: when the token is rotated we move the previous
  // hash here for a few seconds so concurrent in-flight requests carrying
  // the pre-rotation cookie still authenticate (and don't get bounced as
  // "session_revoked"). NULL once the grace window passes.
  previousTokenHash: text("previous_token_hash"),
  previousTokenExpiresAt: timestamp("previous_token_expires_at", { withTimezone: true }),
  userAgent: text("user_agent"),
  ipAddress: text("ip_address"),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Session = typeof sessions.$inferSelect;
export type NewSession = typeof sessions.$inferInsert;

// ── Phase 43: Error Logs ────────────────────────────────────────────

export const errorLogs = pgTable("error_logs", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  level: text("level").notNull(),
  message: text("message").notNull(),
  stack: text("stack"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type ErrorLog = typeof errorLogs.$inferSelect;
export type NewErrorLog = typeof errorLogs.$inferInsert;

// ── Phase 8: Teams ──────────────────────────────────────────────────

export const teams = pgTable("teams", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  name: text("name").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const teamMembers = pgTable("team_members", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  teamId: text("team_id").notNull().references(() => teams.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  role: text("role").notNull().default("viewer").$type<"owner" | "editor" | "viewer">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type TeamMember = typeof teamMembers.$inferSelect;
export type NewTeamMember = typeof teamMembers.$inferInsert;

// ── Phase 8: Agent Shares ────────────────────────────────────────

export const agentShares = pgTable("agent_shares", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  agentId: text("agent_id").notNull().references(() => agentConfigs.id, { onDelete: "cascade" }),
  teamId: text("team_id").references(() => teams.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  sharedBy: text("shared_by").notNull().references(() => users.id, { onDelete: "cascade" }),
  permission: text("permission").notNull().default("read").$type<"read" | "edit">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AgentShare = typeof agentShares.$inferSelect;
export type NewAgentShare = typeof agentShares.$inferInsert;

// ── Phase 8: Audit Log ──────────────────────────────────────────

export const auditLog = pgTable("audit_log", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  action: text("action").notNull(),
  target: text("target"),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type AuditEntry = typeof auditLog.$inferSelect;
export type NewAuditEntry = typeof auditLog.$inferInsert;

// ── Phase 9: Marketplace ────────────────────────────────────────

import type { ExtensionManifestV2 } from "../extensions/types";

export const marketplaceListings = pgTable("marketplace_listings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  authorId: text("author_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  agentConfigId: text("agent_config_id").references(() => agentConfigs.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  description: text("description").notNull(),
  slug: text("slug").notNull().unique(),
  category: text("category").notNull(),
  tags: jsonb("tags").notNull().$type<string[]>().default([]),
  latestVersion: text("latest_version").notNull(),
  installCount: integer("install_count").notNull().default(0),
  ratingPositive: integer("rating_positive").notNull().default(0),
  ratingTotal: integer("rating_total").notNull().default(0),
  status: text("status").notNull().default("active").$type<"active" | "flagged" | "removed">(),
  flagCount: integer("flag_count").notNull().default(0),
  featured: boolean("featured").notNull().default(false),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const marketplaceVersions = pgTable("marketplace_versions", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  listingId: text("listing_id").notNull().references(() => marketplaceListings.id, { onDelete: "cascade" }),
  version: text("version").notNull(),
  manifest: jsonb("manifest").notNull().$type<ExtensionManifestV2>(),
  changelog: text("changelog"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const marketplaceRatings = pgTable("marketplace_ratings", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  listingId: text("listing_id").notNull().references(() => marketplaceListings.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  thumbsUp: boolean("thumbs_up").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const marketplaceFlags = pgTable("marketplace_flags", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  listingId: text("listing_id").notNull().references(() => marketplaceListings.id, { onDelete: "cascade" }),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  reason: text("reason").notNull(),
  category: text("category").notNull().default("other").$type<"spam" | "malicious" | "misleading" | "inappropriate" | "other">(),
  status: text("status").notNull().default("pending").$type<"pending" | "dismissed" | "removed">(),
  reviewedBy: text("reviewed_by").references(() => users.id, { onDelete: "set null" }),
  reviewedAt: timestamp("reviewed_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type MarketplaceListing = typeof marketplaceListings.$inferSelect;
export type NewMarketplaceListing = typeof marketplaceListings.$inferInsert;
export type MarketplaceVersion = typeof marketplaceVersions.$inferSelect;
export type NewMarketplaceVersion = typeof marketplaceVersions.$inferInsert;
export type MarketplaceRating = typeof marketplaceRatings.$inferSelect;
export type MarketplaceFlag = typeof marketplaceFlags.$inferSelect;

// ── Slash Commands ─────────────────────────────────────────────────
// Per-user slash-command templates. Filesystem-discovered commands
// (.claude/, .codex/, agents/) are NOT mirrored here — this table is the
// "DB-backed" source only, for commands the user creates through the app.

export const userCommands = pgTable("user_commands", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  body: text("body").notNull().default(""),
  frontmatter: jsonb("frontmatter").notNull().$type<Record<string, string>>().default({}),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export type UserCommand = typeof userCommands.$inferSelect;
export type NewUserCommand = typeof userCommands.$inferInsert;

// ── Phase 48: Ez Concierge Drafts ───────────────────────────────────
// One row per `propose_*` tool call from the Ez concierge mode. The Ez
// panel renders the result as an "Open prefilled form" card whose URL
// embeds this row's id; the destination page (e.g. /new-project,
// /agents/new) reads `?prefill=<id>`, hydrates form state from
// `payload`, and stamps `consumedAt` on submit. Rows expire 24h after
// `createdAt` regardless of consumption — sweepExpired() in
// src/db/queries/ez-drafts.ts is the GC.

export const ezDrafts = pgTable("ez_drafts", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  kind: text("kind").notNull().$type<"project" | "agent" | "extension">(),
  payload: jsonb("payload").notNull().$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  consumedAt: timestamp("consumed_at", { withTimezone: true }),
}, (table) => [
  index("idx_ez_drafts_user").on(table.userId),
  index("idx_ez_drafts_expires").on(table.expiresAt),
]);

export type EzDraft = typeof ezDrafts.$inferSelect;
export type NewEzDraft = typeof ezDrafts.$inferInsert;

// ── Feature Index (per-project) ────────────────────────────────────
// Project-scoped registry of "features" (named buckets of associated
// files). Drives the `$[feature:name]` mention sigil in chat — the
// composer picker queries this table, and the server-side prompt
// builder expands the mention into a system note listing the files.
//
// `source` columns are LOAD-BEARING for hybrid ownership:
//  - `features.source` ∈ {'user', 'agent'}: rescans only upsert
//    'agent'-sourced rows; user-created (or user-renamed) rows are
//    untouched. PATCH on an 'agent' row flips it to 'user' so the
//    next scan won't clobber the rename.
//  - `featureFiles.source` ∈ {'user', 'scan'}: replaceAgentFiles()
//    only deletes/reinserts 'scan' rows; 'user'-pinned files survive.
//
// See docs/plans/2026-05-01-feature-index-design.md.

export const features = pgTable("features", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  source: text("source").notNull().default("user").$type<"user" | "agent">(),
  // Project-relative directory path the agent scanner derived this
  // feature from (e.g. `src/chat/attachments`). Survives renames so
  // that a user-renamed feature stays linked to its source dir on the
  // next rescan, instead of the rescan creating a fresh duplicate
  // under the original slug. Null for hand-created (user-source) rows
  // that have no scanner origin, and null on rows created before this
  // column existed (back-compat).
  originPath: text("origin_path"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_features_project").on(table.projectId),
  index("idx_features_origin_path").on(table.projectId, table.originPath),
  // Slug uniqueness is per-project, enforced by a partial-free unique
  // index on (project_id, name); declared as a UNIQUE constraint in
  // migrate.ts so PGlite + external Postgres both accept it.
]);

export const featureFiles = pgTable("feature_files", {
  featureId: text("feature_id").notNull().references(() => features.id, { onDelete: "cascade" }),
  relpath: text("relpath").notNull(),
  source: text("source").notNull().default("scan").$type<"user" | "scan">(),
  addedAt: timestamp("added_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.featureId, table.relpath] }),
  index("idx_feature_files_feature").on(table.featureId),
]);

export type Feature = typeof features.$inferSelect;
export type NewFeature = typeof features.$inferInsert;
export type FeatureFile = typeof featureFiles.$inferSelect;
export type NewFeatureFile = typeof featureFiles.$inferInsert;

// ── Surface Coverage Audit ─────────────────────────────────────────
// Per-feature classification against the three "outward" surfaces:
// SDK (packages/@ezcorp/sdk), EzButton (web/src/lib/components/ez/),
// and MCP (packages/@ezcorp/ai-kit/src/mcp/server.ts).
//
// Keyed on (featureId, contentHash) so re-running the audit on an
// unchanged feature is a pure cache hit. The hash is derived from the
// feature's sorted relpaths + per-file head bytes — see
// src/runtime/audit/cache.ts. Stale rows are pruned by
// pruneStaleClassifications() when the hash changes.
//
// `via` distinguishes deterministic precheck verdicts from LLM
// judgments — precheck wins on conflict (see src/runtime/audit/run.ts).

export interface SurfaceVerdict {
  exposed: boolean;
  via: "precheck" | "llm";
  evidence?: string;
}

export interface SurfaceVerdicts {
  sdk: SurfaceVerdict;
  ezbutton: SurfaceVerdict;
  mcp: SurfaceVerdict;
}

export const featureClassifications = pgTable("feature_classifications", {
  featureId: text("feature_id").notNull().references(() => features.id, { onDelete: "cascade" }),
  contentHash: text("content_hash").notNull(),
  surfaces: jsonb("surfaces").$type<SurfaceVerdicts>().notNull(),
  rationale: text("rationale").notNull().default(""),
  classifiedAt: timestamp("classified_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.featureId, table.contentHash] }),
  index("idx_feature_classifications_feature").on(table.featureId),
]);

export type FeatureClassification = typeof featureClassifications.$inferSelect;
export type NewFeatureClassification = typeof featureClassifications.$inferInsert;

// ── Lessons (per-user-per-project, with promotion ladder) ─────────
//
// Drives the `%[lesson:slug]` mention sigil. A lesson is a small,
// self-contained note distilled from a prior conversation that the
// user (or the runtime distiller) wants surfaced again later.
//
// Visibility ladder (monotonic, human-promoted):
//   `user`    — visible only to (project_id, owner_id). Default for
//               distiller-captured lessons. Blast radius: the
//               capturing user's own future sessions.
//   `project` — visible to every member of the project.
//   `global`  — visible across all projects (v2 surface).
//
// Slug uniqueness rules (enforced by partial unique indexes in
// migrate.ts, since drizzle-orm has no portable partial-unique
// helper):
//   - visibility='user'              → UNIQUE(project_id, owner_id, slug)
//   - visibility IN ('project','global') → UNIQUE(project_id, slug)
//
// Counters (`firedCount`, `lastFiredAt`, `dismissedCount`) land in v1
// so usage data is collected from day one — UI wiring for dismissal
// + validation dashboards are deferred to v1.5/v3 per the plan.
//
// See tasks/lessons-keeper-v1.md for the full design.

export const lessons = pgTable("lessons", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  ownerId: text("owner_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  visibility: text("visibility").notNull().default("user").$type<"user" | "project" | "global">(),
  slug: text("slug").notNull(),
  title: text("title").notNull(),
  body: text("body").notNull(),
  frontmatter: jsonb("frontmatter").$type<Record<string, unknown>>(),
  // Phase 51 extends the source enum to include "extension" — the
  // ctx.lessons handler stamps this on writes.
  source: text("source").notNull().default("distiller").$type<"distiller" | "user" | "extension">(),
  sourceSha256: text("source_sha256"),
  // Phase 50: which extension authored this lesson, if any. NULL for
  // legacy host-distilled rows; populated by Phase 51's `ctx.lessons`
  // handler so the per-extension audit drill-down can attribute lessons
  // back to their source. ON DELETE SET NULL — uninstalling an extension
  // doesn't lose the lesson body, just the attribution.
  authorExtensionId: text("author_extension_id").references(() => extensions.id, { onDelete: "set null" }),
  firedCount: integer("fired_count").notNull().default(0),
  lastFiredAt: timestamp("last_fired_at", { withTimezone: true }),
  dismissedCount: integer("dismissed_count").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => [
  index("idx_lessons_project_owner").on(table.projectId, table.ownerId),
  index("idx_lessons_visibility").on(table.projectId, table.visibility),
  // Slug uniqueness is enforced by two partial unique indexes declared
  // in migrate.ts (PGlite supports `CREATE UNIQUE INDEX … WHERE`).
  // drizzle-orm has no first-class partial-unique helper, so we follow
  // the same migration-only pattern that `features.UNIQUE(project_id,
  // name)` and `agent_shares_agent_user_unique` use.
]);

export type Lesson = typeof lessons.$inferSelect;
export type NewLesson = typeof lessons.$inferInsert;

// ── Phase 50: SDK Capability Calls (high-volume per-call audit) ────
//
// One row per Phase 51 capability handler invocation
// (`ctx.llm.complete`, `ctx.memory.read`, `ctx.lessons.write`, etc.).
// Separated from the general-purpose `audit_log` table because the
// volumes (per-LLM-call frequencies) would crowd out the governance
// feed if merged. Per-capability retention thresholds (90/30/30/90 days
// for llm/memory/lessons/schedule) are swept hourly by the cleanup
// timer in `src/startup/background-timers.ts`.
//
// `on_behalf_of` is NOT NULL — every row carries the user the call
// was made on behalf of (derived via `handler-context.ts`). This is
// the structural defense against provenance spoofing: a subprocess
// cannot insert a row without a valid user attribution.
//
// `parent_call_id` is a self-FK declared inline (no `references()` on
// purpose — Drizzle's helper struggles with the same-table reference
// during initial schema build, and the integrity constraint isn't
// load-bearing; orphan parent_call_ids are tolerable for audit-only
// data).
export const sdkCapabilityCalls = pgTable("sdk_capability_calls", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  extensionId: text("extension_id").notNull().references(() => extensions.id, { onDelete: "cascade" }),
  // FK semantics: ON DELETE RESTRICT (NOT SET NULL).
  // The column is NOT NULL — pairing it with SET NULL was internally
  // inconsistent; user-delete would FK-violate. RESTRICT is the
  // defensible audit-trail semantic: a user with capability-call rows
  // cannot be hard-deleted; an admin must scrub PII separately
  // (Phase 52 admin tools) before the user row goes. Per validator
  // CR-2 in Phase 50.
  onBehalfOf: text("on_behalf_of").notNull().references(() => users.id, { onDelete: "restrict" }),
  conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  /** Self-FK to chain scheduled-fire → its child LLM call etc.
   *  Declared as plain text to avoid Drizzle's same-table-reference
   *  ergonomics; orphans tolerated (audit-only). */
  parentCallId: text("parent_call_id"),
  /** 'llm' | 'memory' | 'lessons' | 'schedule' | 'events' | 'search' */
  capability: text("capability").notNull().$type<"llm" | "memory" | "lessons" | "schedule" | "events" | "search">(),
  /** 'complete' | 'read' | 'write' | 'update' | 'delete' | 'fire' | 'register' | 'subscribe' */
  action: text("action").notNull(),
  resourceType: text("resource_type"),
  resourceId: text("resource_id"),
  before: jsonb("before").$type<unknown>(),
  after: jsonb("after").$type<unknown>(),
  success: boolean("success").notNull(),
  durationMs: integer("duration_ms").notNull(),
  errorCode: text("error_code"),
  errorMessage: text("error_message"),
  tokensUsed: integer("tokens_used"),
  costUsd: real("cost_usd"),
  provider: text("provider"),
  model: text("model"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  index("idx_sdk_cap_ext_created").on(table.extensionId, table.createdAt.desc()),
  // Partial index — most rows are conversation-scoped, but `register`
  // and some `fire` rows from scheduled handlers are not. Predicate
  // via raw SQL since Drizzle's `.where()` on indexes is the standard
  // pattern for this in the codebase.
  index("idx_sdk_cap_conv_created").on(table.conversationId, table.createdAt.desc())
    .where(sql`conversation_id IS NOT NULL`),
  index("idx_sdk_cap_user_capability_created").on(table.onBehalfOf, table.capability, table.createdAt.desc()),
  index("idx_sdk_cap_created").on(table.createdAt.desc()),
]);

export type SdkCapabilityCall = typeof sdkCapabilityCalls.$inferSelect;
export type NewSdkCapabilityCall = typeof sdkCapabilityCalls.$inferInsert;

// ── Phase 50: Lessons Audit Log ────────────────────────────────────
//
// Mirrors `memory_audit_log` shape. Captures full before/after body
// + frontmatter on every lesson mutation so admins have a forensic
// trail (forever retention — small table, debugging gold). Cascade
// delete: removing the lesson removes its audit history.
export const lessonsAuditLog = pgTable("lessons_audit_log", {
  id: serial("id").primaryKey(),
  lessonId: text("lesson_id").notNull().references(() => lessons.id, { onDelete: "cascade" }),
  /** 'created' | 'updated' | 'deleted' */
  action: text("action").notNull().$type<"created" | "updated" | "deleted">(),
  previousBody: text("previous_body"),
  newBody: text("new_body"),
  previousFrontmatter: jsonb("previous_frontmatter").$type<Record<string, unknown> | null>(),
  newFrontmatter: jsonb("new_frontmatter").$type<Record<string, unknown> | null>(),
  actorUserId: text("actor_user_id").references(() => users.id, { onDelete: "set null" }),
  actorExtensionId: text("actor_extension_id").references(() => extensions.id, { onDelete: "set null" }),
  reason: text("reason"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  index("idx_lessons_audit_lesson_created").on(table.lessonId, table.createdAt.desc()),
  index("idx_lessons_audit_actor_ext_created").on(table.actorExtensionId, table.createdAt.desc()),
]);

export type LessonAuditEntry = typeof lessonsAuditLog.$inferSelect;
export type NewLessonAuditEntry = typeof lessonsAuditLog.$inferInsert;

// ── Phase 51: ctx.llm — per-extension daily usage rollup ───────────
//
// 60s flush from in-process `LlmQuota` counters. The DB row is the
// durable record so a crash-restart doesn't reset the day's usage.
// Composite primary key on (extension_id, day) — one row per
// extension per UTC calendar day.
export const extensionLlmUsage = pgTable("extension_llm_usage", {
  extensionId: text("extension_id").notNull().references(() => extensions.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  calls: integer("calls").notNull().default(0),
  // TOTAL tokens (input + output) counted toward `maxTokensPerDay`.
  // DB column stays `output_tokens` for historical compat — it predates
  // input-token accounting; the field name reflects the real meaning.
  totalTokens: integer("output_tokens").notNull().default(0),
  // Cumulative cost in cents for the day — enforces `maxCostCentsPerDay`.
  costCents: integer("cost_cents").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.extensionId, table.day] }),
]);

export type ExtensionLlmUsage = typeof extensionLlmUsage.$inferSelect;
export type NewExtensionLlmUsage = typeof extensionLlmUsage.$inferInsert;

// ── Phase 51: ctx.memory — per-extension daily write rollup ───────
export const extensionMemoryWritesDaily = pgTable("extension_memory_writes_daily", {
  extensionId: text("extension_id").notNull().references(() => extensions.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  writes: integer("writes").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.extensionId, table.day] }),
]);

export type ExtensionMemoryWritesDaily = typeof extensionMemoryWritesDaily.$inferSelect;

// ── Phase 51: ctx.lessons — per-extension daily write rollup ──────
export const extensionLessonsWritesDaily = pgTable("extension_lessons_writes_daily", {
  extensionId: text("extension_id").notNull().references(() => extensions.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  writes: integer("writes").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.extensionId, table.day] }),
]);

export type ExtensionLessonsWritesDaily = typeof extensionLessonsWritesDaily.$inferSelect;

// ── Shared-search Phase 2: ctx.search — per-extension daily call rollup ──
// Mirrors `extension_memory_writes_daily`: the in-process counter is
// authoritative for the live process; this table is the durable record
// (60s flush + hydrate) so a crash-restart doesn't reset the day's
// search-call count to zero. Enforces `resolveSearchPolicy().quota`.
export const extensionSearchCallsDaily = pgTable("extension_search_calls_daily", {
  extensionId: text("extension_id").notNull().references(() => extensions.id, { onDelete: "cascade" }),
  day: date("day").notNull(),
  calls: integer("calls").notNull().default(0),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  primaryKey({ columns: [table.extensionId, table.day] }),
]);

export type ExtensionSearchCallsDaily = typeof extensionSearchCallsDaily.$inferSelect;

// ── Phase 51: ctx.schedule — persistent cron registrations ─────────
export const extensionSchedules = pgTable("extension_schedules", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  extensionId: text("extension_id").notNull().references(() => extensions.id, { onDelete: "cascade" }),
  cron: text("cron").notNull(),
  nextFireAt: timestamp("next_fire_at", { withTimezone: true, mode: "date" }).notNull(),
  lastFireAt: timestamp("last_fire_at", { withTimezone: true, mode: "date" }),
  lastFireStatus: text("last_fire_status").$type<"ok" | "error" | "timeout" | null>(),
  lastFireId: text("last_fire_id"),
  enabled: boolean("enabled").notNull().default(true),
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  uniqueIndex("uniq_ext_schedule").on(table.extensionId, table.cron),
  index("idx_schedule_ready").on(table.enabled, table.nextFireAt),
]);

export type ExtensionSchedule = typeof extensionSchedules.$inferSelect;
export type NewExtensionSchedule = typeof extensionSchedules.$inferInsert;

// ── Phase 51: ctx.schedule — per-fire history ──────────────────────
export const extensionScheduleFires = pgTable("extension_schedule_fires", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  scheduleId: text("schedule_id").notNull().references(() => extensionSchedules.id, { onDelete: "cascade" }),
  scheduledAt: timestamp("scheduled_at", { withTimezone: true, mode: "date" }).notNull(),
  firedAt: timestamp("fired_at", { withTimezone: true, mode: "date" }).notNull(),
  attempt: integer("attempt").notNull().default(0),
  status: text("status").notNull().$type<"pending" | "running" | "ok" | "error" | "timeout">(),
  durationMs: integer("duration_ms"),
  error: text("error"),
  catchUp: boolean("catch_up").notNull().default(false),
}, (table) => [
  index("idx_schedule_fires_pending").on(table.status, table.scheduledAt),
]);

export type ExtensionScheduleFire = typeof extensionScheduleFires.$inferSelect;
export type NewExtensionScheduleFire = typeof extensionScheduleFires.$inferInsert;

// ── Secure User-Site Preview / Port Exposure (Phase 1) ──────────────
//
// The preview registry. One row per exposed site (static or dynamic).
// Drives the `*.preview.<host>` reverse proxy's access layer: every
// request loads the row by its opaque, unguessable `id` (the subdomain
// label) and asserts `__ezpreview` token.userId === row.userId AND the
// row is not expired/revoked. This is one of THREE independent
// requester-only layers (attribution via netns, consent routing,
// access via token+registry) — see tasks/preview-port-exposure.md §1.
//
// `id` is the subdomain label AND the primary key — a 26-char Crockford
// base32 string from 128 bits of CSPRNG entropy (no enumeration; D4
// wildcard-subdomain routing makes the label the origin). `kind`
// discriminates `static` (served from `.ezcorp/sites/<id>/`, Phase 1)
// from `dynamic` (netns passthrough to `targetPort`, Phase 3). Exactly
// one of `targetPort` / `staticPath` is meaningful per kind; both are
// nullable so the column set covers both branches without a CHECK that
// PGlite and external Postgres would need to agree on.
//
// `status` ∈ {'active','revoked','expired'} is the coarse lifecycle
// flag the proxy reads first; `revokedAt` / `expiresAt` carry the
// precise timestamps. `lastSeenAt` is bumped by the proxy on each
// served request (liveness signal for the Phase 4 idle reaper).
//
// Indexed by `userId` (the revocation UI lists a user's previews) and
// `conversationId` (reaping on conversation close). FKs SET NULL so a
// deleted user/conversation orphans-but-keeps the row for audit; the
// proxy's access check then fails closed (userId mismatch).

export const previewSessions = pgTable("preview_sessions", {
  id: text("id").primaryKey(),
  userId: text("user_id").references(() => users.id, { onDelete: "set null" }),
  conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  /** The per-conversation network namespace id this preview's dynamic
   *  server lives in (Phase 3). NULL for static previews. */
  netnsId: text("netns_id"),
  kind: text("kind").notNull().$type<"static" | "dynamic">(),
  /** Dynamic only — the port the dev server listens on inside the netns. */
  targetPort: integer("target_port"),
  /** Static only — absolute path to the served site root
   *  (`.ezcorp/sites/<id>/`). Stored so the proxy doesn't have to
   *  re-derive it; still re-validated against the realpath jail. */
  staticPath: text("static_path"),
  status: text("status").notNull().default("active").$type<"active" | "revoked" | "expired">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [
  index("idx_preview_sessions_user").on(table.userId),
  index("idx_preview_sessions_conversation").on(table.conversationId),
]);

export type PreviewSession = typeof previewSessions.$inferSelect;
export type NewPreviewSession = typeof previewSessions.$inferInsert;

// ── Daily Briefing (Phase 1) — per-user briefing configuration ──────
//
// One config row per user (PK = user_id, locked decision §7.4 of the
// briefing spec). `next_fire_at` IS the claim target: the BriefingDaemon
// claims due rows with SELECT … FOR UPDATE SKIP LOCKED and advances
// next_fire_at to the next cron slot BEFORE dispatching (at-most-once,
// mirroring extension_schedules). `consecutive_errors` auto-disables the
// config at 5, mirroring the ScheduleDaemon's invariant.
//
// `watchlist` is stored (jsonb) from Phase 1 so the config API surface is
// stable, but the run pipeline only consumes it in Phase 3 (web-search
// section).

export const briefingConfigs = pgTable("briefing_configs", {
  userId: text("user_id").primaryKey().references(() => users.id, { onDelete: "cascade" }),
  enabled: boolean("enabled").notNull().default(false),
  /** 5-field cron, validated by `parseCron` (incl. its 5-minute-interval
   *  gate). Default 7am daily; the settings UI writes time-of-day +
   *  weekday presets as cron strings. */
  cron: text("cron").notNull().default("0 7 * * *"),
  /** IANA timezone, validated via Intl at the API layer. */
  timezone: text("timezone").notNull().default("UTC"),
  /** Where briefing conversations land. Nullable — the pipeline falls
   *  back to the user's most recently active project, else skips. */
  projectId: text("project_id").references(() => projects.id, { onDelete: "set null" }),
  /** Free-text user instructions — appended verbatim to the briefing
   *  conversation's system prompt. The instructions ARE the prompt. */
  instructions: text("instructions").notNull().default(""),
  watchlist: jsonb("watchlist").notNull().$type<Array<{ topic: string; addedAt: string }>>().default([]),
  /** NULL → instance default model resolution (resolveModel(undefined)). */
  model: text("model"),
  provider: text("provider"),
  lastFireAt: timestamp("last_fire_at", { withTimezone: true, mode: "date" }),
  lastFireStatus: text("last_fire_status").$type<"ok" | "error" | "skipped" | null>(),
  consecutiveErrors: integer("consecutive_errors").notNull().default(0),
  /** Precomputed next fire instant — THE claim target. NULL while disabled. */
  nextFireAt: timestamp("next_fire_at", { withTimezone: true, mode: "date" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  index("idx_briefing_ready").on(table.enabled, table.nextFireAt),
]);

export type BriefingConfig = typeof briefingConfigs.$inferSelect;
export type NewBriefingConfig = typeof briefingConfigs.$inferInsert;

// ── GitHub Projects integration ────────────────────────────────────────
// An EZCorp project connects to MANY GitHub Projects v2 boards (one row per
// board). A given board connects to a project only once
// (UNIQUE(project_id, board_node_id)). The PAT (when authMode='pat') is NOT
// stored here — it lives encrypted in the `extension_secrets` store at
// `apiToken` (the SHARED project token) and, optionally, `apiToken:<linkId>`
// (a per-board override). `enabled=false` = "pause polling" (board + token
// retained; daemon skips disabled links). See
// src/db/migrations/add-github-projects.ts and src/integrations/github-projects/.
export const githubProjectsLinks = pgTable("github_projects_links", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  /** GitHub Projects v2 node id (`PVT_…`), resolved from the pasted board URL. */
  boardNodeId: text("board_node_id").notNull(),
  boardUrl: text("board_url").notNull(),
  boardTitle: text("board_title").notNull().default(""),
  ownerLogin: text("owner_login").notNull().default(""),
  /** Node id of the single-select "Status" field whose options are the columns. */
  statusFieldId: text("status_field_id"),
  /** The board's Status-field options (id+name) captured at connect time. The
   *  connect response carries these transiently; persisting them lets the
   *  column-mapping editor render FULL, NAMED columns after a page reload
   *  (instead of falling back to the saved map's bare option-id keys, which
   *  shows ids and drops unmapped columns). Refreshed on every (re)connect. */
  statusOptions: jsonb("status_options").notNull().$type<GithubStatusOption[]>().default([]),
  /** Default model for spawned runs, stored as "<provider>:<model>". Null/empty
   *  → keep the instance default (the executor's provider preference order). The
   *  spawn bridge splits on the FIRST ':' and threads provider+model into
   *  streamChat so an instance without anthropic creds can pick a working model. */
  defaultModel: text("default_model"),
  /** Default permission mode for spawned runs — a runtime PermissionMode string
   *  ("ask" | "auto-edit" | "yolo"). Null/invalid → the spawn bridge falls back
   *  to "yolo" (auto-approve everything), matching the platform-wide default. An
   *  explicit per-column permissionMode override (still never yolo) takes
   *  precedence when set; this board-level value covers every other card move. */
  defaultPermissionMode: text("default_permission_mode"),
  authMode: text("auth_mode").notNull().$type<"pat" | "gh">().default("pat"),
  /** statusOptionId → action mapping. The daemon reads this every poll. */
  columnActionMap: jsonb("column_action_map").notNull().$type<GithubColumnActionMap>().default({}),
  /** Per-item updatedAt high-water marks so polls only diff what changed. */
  pollCursor: jsonb("poll_cursor").$type<Record<string, string>>(),
  pollIntervalSec: integer("poll_interval_sec").notNull().default(60),
  /** false = paused (board kept, polling + spawns stopped). */
  enabled: boolean("enabled").notNull().default(true),
  lastPolledAt: timestamp("last_polled_at", { withTimezone: true, mode: "date" }),
  lastError: text("last_error"),
  lastErrorAt: timestamp("last_error_at", { withTimezone: true, mode: "date" }),
  createdByUserId: text("created_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  // A project connects to MANY boards, each board only once per project.
  uniqueIndex("idx_gh_links_project_board").on(table.projectId, table.boardNodeId),
]);

export type GithubProjectsLink = typeof githubProjectsLinks.$inferSelect;
export type NewGithubProjectsLink = typeof githubProjectsLinks.$inferInsert;

// The proposal queue + concurrency unit. `dedupeKey` (server-derived
// projectId:itemNodeId:statusOptionId:action) is stamped for PROVENANCE only —
// anti-double-spawn is the partial single-active-per-card unique index
// `idx_gh_proposals_active_item` (see the mirror warning in the index list).
export const githubProjectsProposals = pgTable("github_projects_proposals", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  projectId: text("project_id").notNull().references(() => projects.id, { onDelete: "cascade" }),
  linkId: text("link_id").notNull().references(() => githubProjectsLinks.id, { onDelete: "cascade" }),
  itemNodeId: text("item_node_id").notNull(),
  contentNodeId: text("content_node_id"),
  statusOptionId: text("status_option_id").notNull(),
  statusName: text("status_name").notNull().default(""),
  action: text("action").notNull().$type<GithubProposalAction>(),
  title: text("title").notNull().default(""),
  ticketUrl: text("ticket_url"),
  dedupeKey: text("dedupe_key").notNull(),
  status: text("status").notNull().$type<GithubProposalStatus>().default("pending"),
  conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  agentRunId: text("agent_run_id"),
  proposedAt: timestamp("proposed_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  decidedAt: timestamp("decided_at", { withTimezone: true, mode: "date" }),
  decidedByUserId: text("decided_by_user_id").references(() => users.id, { onDelete: "set null" }),
  finishedAt: timestamp("finished_at", { withTimezone: true, mode: "date" }),
  error: text("error"),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  // WARNING — drizzle-side MIRROR only (the extension_secrets pattern). The
  // REAL index is the PARTIAL unique in src/db/migrate.ts:
  //   CREATE UNIQUE INDEX idx_gh_proposals_active_item
  //     ON github_projects_proposals(link_id, item_node_id)
  //     WHERE status IN ('pending','approved','spawned','running')
  // ≤1 ACTIVE proposal per card; terminal rows (done/failed/dismissed/
  // cancelled) free the card so column re-entry re-triggers. Never push this
  // table's DDL from drizzle-kit; migrate.ts is the source of truth (a
  // drifted push that lost the WHERE would block re-triggers forever).
  uniqueIndex("idx_gh_proposals_active_item")
    .on(table.linkId, table.itemNodeId)
    .where(sql`${table.status} IN ('pending','approved','spawned','running')`),
  index("idx_gh_proposals_project_status").on(table.projectId, table.status),
  index("idx_gh_proposals_link").on(table.linkId),
]);

export type GithubProjectsProposal = typeof githubProjectsProposals.$inferSelect;
export type NewGithubProjectsProposal = typeof githubProjectsProposals.$inferInsert;

// ── Extension secrets ──────────────────────────────────────────────────
// Dedicated, scope-isolated, AEAD-bound credential store for extensions
// (third-party API tokens etc.). The ciphertext is AES-256-GCM with the
// `extensionId:projectId` pair bound as AAD (see encryptWithAad in
// src/providers/encryption.ts) — a row copied to another extension or
// project fails to decrypt. (`user_id`/`name` are intentionally NOT part
// of the AAD — see aadFor in src/extensions/secrets-store.ts — so a
// same-scope rename or user→project slot move still decrypts; the unique
// scope tuple + FK cascade isolate those.) Plaintext is reachable ONLY via
// the host-side store
// (src/extensions/secrets-store.ts `getSecret`); it is NEVER wired to the
// extension sandbox. `extension_id` stores the stable manifest slug (e.g.
// "github-projects"), NOT the UUID `extensions.id`. The scope tuple
// (extension_id, project_id, user_id, name) is UNIQUE — the COALESCE-unique
// form lives in the raw migration (src/db/migrations/add-extension-secrets.ts),
// which is the source of truth for the FK + index.
export const extensionSecrets = pgTable("extension_secrets", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  extensionId: text("extension_id").notNull().references(() => extensions.name, { onDelete: "cascade" }), // stores the stable slug, NOT the UUID id
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  ciphertext: text("ciphertext").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  lastUsedAt: timestamp("last_used_at", { withTimezone: true, mode: "date" }),
  rotatedAt: timestamp("rotated_at", { withTimezone: true, mode: "date" }),
}, (table) => [
  // WARNING — drizzle-side MIRROR only. The REAL index is the COALESCE form
  // in src/db/migrate.ts (`… ON extension_secrets (extension_id,
  // COALESCE(project_id,''), COALESCE(user_id,''), name)`): a plain UNIQUE
  // over nullable columns treats every NULL as distinct, so a `drizzle-kit
  // push` from this definition would install a WEAKER index that allows
  // duplicate global / project-scoped secrets. Never push this table's DDL
  // from drizzle-kit; migrate.ts is the source of truth.
  uniqueIndex("idx_extension_secrets_scope").on(table.extensionId, table.projectId, table.userId, table.name),
]);

export type ExtensionSecret = typeof extensionSecrets.$inferSelect;
export type NewExtensionSecret = typeof extensionSecrets.$inferInsert;

// ── Extension RBAC grants ──────────────────────────────────────────────
// Per-user scope grants over the extension system: what the USER may do
// WITH an extension (invoke it, configure it, write its secrets, approve
// its runs, manage other users' grants). Complementary to the PDP in
// src/extensions/permission-engine.ts, which governs what the EXTENSION
// may do — do not conflate. NULL `project_id` = the grant covers ALL
// projects; NULL `extension_id` = ALL extensions. `scopes` is a JSONB
// array of validated scope names (core verbs + extension-declared custom
// scopes — see src/db/queries/extension-rbac.ts). `extension_id` stores
// the stable manifest SLUG (FK to extensions.name), NOT the UUID
// `extensions.id` — the extension_secrets precedent. Admins hold every
// scope implicitly and need no rows here; non-admin members are
// deny-by-default (see src/auth/extension-rbac.ts).
export const extensionRbacGrants = pgTable("extension_rbac_grants", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  projectId: text("project_id").references(() => projects.id, { onDelete: "cascade" }),
  extensionId: text("extension_id").references(() => extensions.name, { onDelete: "cascade" }), // stores the stable slug, NOT the UUID id
  scopes: jsonb("scopes").notNull().$type<string[]>(),
  grantedByUserId: text("granted_by_user_id").references(() => users.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true, mode: "date" }).notNull().defaultNow(),
}, (table) => [
  // WARNING — drizzle-side MIRROR only. The REAL index is the COALESCE form
  // in src/db/migrate.ts (`… ON extension_rbac_grants (user_id,
  // COALESCE(project_id,''), COALESCE(extension_id,''))`): a plain UNIQUE
  // over nullable columns treats every NULL as distinct, so a `drizzle-kit
  // push` from this definition would install a WEAKER index that allows
  // duplicate all-projects / all-extensions grant rows for the same user.
  // Never push this table's DDL from drizzle-kit; migrate.ts is the source
  // of truth.
  uniqueIndex("idx_extension_rbac_grants_scope").on(table.userId, table.projectId, table.extensionId),
]);

export type ExtensionRbacGrant = typeof extensionRbacGrants.$inferSelect;
export type NewExtensionRbacGrant = typeof extensionRbacGrants.$inferInsert;
