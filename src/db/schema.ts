import { pgTable, text, timestamp, jsonb, integer, real, serial, bigint, boolean, index, primaryKey, uniqueIndex, date, vector } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import type { PipelineStep } from "../types";
import type { MemoryProvenance } from "../memory/types";
import { EMBEDDING_DIMENSIONS } from "../memory/types";

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
   *  holds `spawnDepth: number` tracked by spawn-assignment-handler.ts. */
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  /** Phase 48: distinguishes regular per-project chats from the global Ez
   *  concierge conversation (one per user, enforced by a unique partial index
   *  `conversations_user_ez_unique` declared in migrate.ts). Mutating modeId
   *  on a kind='ez' row is rejected at the API layer. */
  kind: text("kind").notNull().default("regular").$type<"regular" | "ez">(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const messages = pgTable("messages", {
  id: text("id").primaryKey().$defaultFn(() => crypto.randomUUID()),
  conversationId: text("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  role: text("role").notNull(),
  content: text("content").notNull(),
  thinkingContent: text("thinking_content"),
  model: text("model"),
  provider: text("provider"),
  usage: jsonb("usage").$type<{ inputTokens: number; outputTokens: number }>(),
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
  checksumVerified: boolean("checksum_verified").notNull().default(false),
  // Provenance flag: true ONLY when this row was created by bundled.ts's
  // ensureBundledExtensions path. Authorizes skipping the runtime checksum
  // gate. Must never be inferred from manifest.name — that lookup was the
  // finding #2 vulnerability (an attacker could install an extension
  // manifested as name:"ai-kit" and inherit bundled trust).
  isBundled: boolean("is_bundled").notNull().default(false),
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
  source: text("source").notNull().default("distiller").$type<"distiller" | "user">(),
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
  /** 'llm' | 'memory' | 'lessons' | 'schedule' | 'events' */
  capability: text("capability").notNull().$type<"llm" | "memory" | "lessons" | "schedule" | "events">(),
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
  outputTokens: integer("output_tokens").notNull().default(0),
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
