/**
 * API Registry - describes all API routes for auto-generated documentation.
 *
 * Schemas are NOT imported here to avoid cross-workspace Zod instance issues.
 * The docs endpoint (web/src/routes/api/docs/+server.ts) maps schemas at serve time.
 */

import type { ApiKeyScope } from "./auth/api-key";

/** The API-key scope a route requires (control tier), or "public" for
 *  unauthenticated routes. Optional today (not yet backfilled across all
 *  entries); NEW entries should declare it — the OpenAPI builder surfaces it
 *  and the route-contract meta-test will tighten the requirement over time. */
export type ApiRouteScope = ApiKeyScope | "public";

export interface ApiRouteEntry {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  description: string;
  category: string;
  /** Scope required to call this route (control tier) or "public". */
  scope?: ApiRouteScope;
  /** Remote-control metadata. `controllable: true` marks a route an external
   *  harness is expected to be able to drive (and the harness client should
   *  cover). See docs/harness-contract.md. */
  harness?: { controllable?: boolean };
  /** Schema key used by docs endpoint to resolve the Zod schema */
  schemaKey?: string;
  responseDescription?: string;
}

export const apiRegistry: ApiRouteEntry[] = [
  // Auth
  { method: "POST", path: "/api/auth/login", description: "Authenticate user and create session", category: "auth", scope: "public", schemaKey: "loginSchema" },
  { method: "POST", path: "/api/auth/logout", description: "End current session", category: "auth" },
  { method: "GET", path: "/api/auth/me", description: "Get current authenticated user", category: "auth", responseDescription: "User object with id, name, email, role" },
  { method: "POST", path: "/api/auth/setup", description: "Initial admin setup (first-run only)", category: "auth", schemaKey: "setupSchema" },
  { method: "POST", path: "/api/auth/invite", description: "Create user invitation link", category: "auth", schemaKey: "createInviteSchema" },
  { method: "POST", path: "/api/auth/invite/:token", description: "Accept invitation and create account", category: "auth" },
  { method: "POST", path: "/api/auth/reset-password", description: "Generate password reset token (admin)", category: "auth", schemaKey: "generateResetSchema" },
  { method: "POST", path: "/api/auth/reset-password/:token", description: "Consume reset token and set new password", category: "auth", schemaKey: "consumeResetSchema" },
  { method: "GET", path: "/api/auth/oauth", description: "Initiate OAuth login flow", category: "auth" },
  { method: "GET", path: "/api/auth/oauth/callback", description: "Handle OAuth provider callback", category: "auth" },

  // Account
  { method: "GET", path: "/api/account", description: "Get current user account details", category: "account" },
  { method: "PUT", path: "/api/account", description: "Update account name or email", category: "account" },
  { method: "PUT", path: "/api/account/password", description: "Change account password", category: "account" },

  // Conversations
  { method: "GET", path: "/api/conversations", description: "List conversations for active project", category: "conversations", responseDescription: "Array of conversation objects" },
  { method: "POST", path: "/api/conversations", description: "Create a new conversation", category: "conversations", scope: "chat", harness: { controllable: true }, schemaKey: "createConversationSchema" },
  { method: "GET", path: "/api/conversations/:id", description: "Get conversation by ID", category: "conversations", scope: "read" },
  { method: "PATCH", path: "/api/conversations/:id", description: "Update conversation title, model, or system prompt", category: "conversations", schemaKey: "updateConversationSchema" },
  { method: "DELETE", path: "/api/conversations/:id", description: "Delete a conversation", category: "conversations", scope: "chat" },
  { method: "GET", path: "/api/conversations/:id/messages", description: "List messages in a conversation", category: "conversations", scope: "read", responseDescription: "Array of message objects with tool calls" },
  { method: "POST", path: "/api/conversations/:id/messages", description: "Send a message and trigger AI response", category: "conversations", scope: "chat", harness: { controllable: true }, schemaKey: "createMessageSchema" },
  { method: "GET", path: "/api/conversations/:id/extensions", description: "List extensions wired to a conversation", category: "conversations", scope: "read", harness: { controllable: true }, responseDescription: "{ extensions: [{ id, name }] }" },
  { method: "POST", path: "/api/conversations/:id/extensions", description: "Wire installed extensions to a conversation", category: "conversations", scope: "extensions", harness: { controllable: true }, responseDescription: "{ wired: string[], extensionIds: string[] }" },
  { method: "GET", path: "/api/conversations/:id/export", description: "Export conversation as JSON/Markdown", category: "conversations" },
  { method: "POST", path: "/api/conversations/:id/active-run", description: "Cancel active run in conversation", category: "conversations" },
  { method: "GET", path: "/api/conversations/:id/tree", description: "Session-backed message tree + durable leaf pointer for the rewind/branch UI (409 when the history-producer flag is off)", category: "conversations", scope: "read", harness: { controllable: true }, responseDescription: "{ conversationId, currentLeaf: string|null, nodes: [{ id, parentId, role, excluded, createdAt }] }" },
  { method: "POST", path: "/api/conversations/:id/rewind", description: "Rewind/checkpoint the conversation to a message (moves the durable leaf pointer; 409 when the flag is off or a run is active)", category: "conversations", scope: "chat", harness: { controllable: true }, schemaKey: "rewindConversationSchema", responseDescription: "{ conversationId, currentLeaf, nodes } (the refreshed tree)" },
  { method: "POST", path: "/api/conversations/:id/messages/:mid/retry", description: "Clean A/B retry — re-run the target assistant message's parent user turn as a same-role sibling (no duplicate user row; 409 when the flag is off or a run is active)", category: "conversations", scope: "chat", harness: { controllable: true }, schemaKey: "retryMessageSchema", responseDescription: "{ userMessage, retriedMessageId, runId }" },
  { method: "GET", path: "/api/search/messages", description: "Hybrid/keyword/semantic message search (RRF)", category: "conversations", responseDescription: "{ hits, degraded, requestedMode, servedMode }" },

  // Daily Briefing
  { method: "GET", path: "/api/briefing/config", description: "Get the current user's Daily Briefing configuration (defaults when never configured)", category: "briefing" },
  { method: "PUT", path: "/api/briefing/config", description: "Update the current user's Daily Briefing configuration (cron, timezone, project, instructions, watchlist, model)", category: "briefing" },
  { method: "POST", path: "/api/briefing/run-now", description: "Trigger an immediate briefing run for the current user (rate-limited 1/5min)", category: "briefing", responseDescription: "{ started: true } (202)" },

  // GitHub Projects integration
  { method: "POST", path: "/api/integrations/github-projects/connect", description: "Resolve + validate a GitHub Projects board and link it to a project (stores an encrypted PAT for authMode 'pat')", category: "integrations", scope: "extensions", responseDescription: "{ linkId, boardTitle, ownerLogin, statusOptions, scopes, canComment }" },
  { method: "GET", path: "/api/integrations/github-projects/link", description: "List every GitHub board connected to the project, each with health and pause state", category: "integrations", scope: "extensions", responseDescription: "{ links: [...] }" },
  { method: "PATCH", path: "/api/integrations/github-projects/link", description: "Update the board's column→action map, poll interval, or pause/resume state", category: "integrations", scope: "extensions" },
  { method: "DELETE", path: "/api/integrations/github-projects/link", description: "Disconnect the board: purge the stored token, cancel active proposals, drop the link", category: "integrations", scope: "extensions" },
  { method: "POST", path: "/api/integrations/github-projects/link/refresh-columns", description: "Re-fetch the connected board's Status columns (id+name) host-side and persist them — self-heals empty/stale status_options without re-entering the PAT", category: "integrations", scope: "extensions" },
  { method: "GET", path: "/api/integrations/github-projects/proposals", description: "List a project's board-move proposals (active + history)", category: "integrations", scope: "extensions" },
  { method: "POST", path: "/api/integrations/github-projects/proposals/:id/approve", description: "Approve a pending proposal — spawn the PDP-gated conversation + run", category: "integrations", scope: "extensions" },
  { method: "POST", path: "/api/integrations/github-projects/proposals/:id/dismiss", description: "Dismiss a pending proposal without spawning", category: "integrations", scope: "extensions" },
  { method: "POST", path: "/api/integrations/github-projects/proposals/:id/rerun", description: "Re-run a terminal proposal — create a fresh pending proposal for the same card (normal approval gate applies)", category: "integrations", scope: "extensions" },

  // Agent Configs
  { method: "GET", path: "/api/agent-configs", description: "List agent configurations", category: "agents" },
  { method: "POST", path: "/api/agent-configs", description: "Create agent configuration", category: "agents", schemaKey: "createAgentConfigSchema" },
  { method: "GET", path: "/api/agent-configs/:id", description: "Get agent config by ID", category: "agents" },
  { method: "PUT", path: "/api/agent-configs/:id", description: "Update agent configuration", category: "agents" },
  { method: "DELETE", path: "/api/agent-configs/:id", description: "Delete agent configuration", category: "agents" },
  { method: "POST", path: "/api/agent-configs/generate", description: "Generate agent config from conversation", category: "agents", schemaKey: "generateAgentConfigSchema" },

  // Agents
  { method: "GET", path: "/api/agents", description: "List available agents", category: "agents" },
  { method: "POST", path: "/api/agents/:name/run", description: "Execute an agent by name", category: "agents", schemaKey: "runAgentSchema" },
  { method: "GET", path: "/api/agents/:name/test-conversations", description: "List test conversations for agent", category: "agents" },
  { method: "POST", path: "/api/agents/:id/share", description: "Share agent to marketplace", category: "agents" },

  // Extensions
  { method: "GET", path: "/api/extensions", description: "List installed extensions", category: "extensions", scope: "read", harness: { controllable: true } },
  { method: "POST", path: "/api/extensions", description: "Install extension from local path, a GitHub release, or a git clone URL — lands disabled with no permissions (requires an admin-role key)", category: "extensions", scope: "admin", harness: { controllable: true }, schemaKey: "installExtensionSchema" },
  { method: "GET", path: "/api/extensions/:id", description: "Get extension details", category: "extensions" },
  { method: "PATCH", path: "/api/extensions/:id", description: "Disable an installed extension (enabled:false only; enable via /activate) (requires an admin-role key)", category: "extensions", scope: "extensions", harness: { controllable: true } },
  { method: "DELETE", path: "/api/extensions/:id", description: "Uninstall extension (requires an admin-role key)", category: "extensions", scope: "extensions", harness: { controllable: true } },
  { method: "POST", path: "/api/extensions/:id/activate", description: "Enable an installed extension and (optionally) grant manifest-clamped permissions (requires an admin-role key)", category: "extensions", scope: "admin", harness: { controllable: true } },
  { method: "POST", path: "/api/extensions/:id/confirm", description: "Confirm extension installation", category: "extensions" },
  { method: "GET", path: "/api/extensions/:id/permissions", description: "Get extension permissions", category: "extensions" },
  { method: "PUT", path: "/api/extensions/:id/permissions", description: "Update extension permissions — clamped to the manifest (requires an admin-role key)", category: "extensions", scope: "admin", harness: { controllable: true } },
  { method: "GET", path: "/api/extensions/:name/tools", description: "List tools provided by extension", category: "extensions", scope: "read" },
  { method: "POST", path: "/api/extensions/:id/secrets", description: "Set (or rotate) an extension secret — encrypted, scope-isolated, AAD-bound; value never echoed back", category: "extensions", scope: "extensions", harness: { controllable: true } },
  { method: "DELETE", path: "/api/extensions/:id/secrets", description: "Delete an extension secret", category: "extensions", scope: "extensions", harness: { controllable: true } },

  // Extension RBAC grants (runtime gate = the delegation check in
  // src/auth/extension-rbac.ts; scope "admin" documents the surface for the
  // docs/OpenAPI tier — see the route headers).
  { method: "GET", path: "/api/rbac/extension-grants", description: "List extension RBAC grants visible to the caller (admin: all; manage-grant holders: their coverage + own; members: own rows only)", category: "admin", scope: "admin", responseDescription: "{ grants: [{ id, user: {id,email,name}, projectId, extensionId, scopes, grantedBy, updatedAt }] }" },
  { method: "POST", path: "/api/rbac/extension-grants", description: "Create an extension RBAC grant or replace an existing row's scope list (delegation-gated: admin, or a covering `manage` grant; `manage` itself is admin-only to grant)", category: "admin", scope: "admin" },
  { method: "DELETE", path: "/api/rbac/extension-grants/:id", description: "Revoke an extension RBAC grant (same delegation rules as create; audit row carries the pre-delete scopes)", category: "admin", scope: "admin" },

  // Marketplace
  { method: "GET", path: "/api/marketplace", description: "Browse marketplace listings", category: "marketplace" },
  { method: "POST", path: "/api/marketplace", description: "Publish agent to marketplace", category: "marketplace", schemaKey: "publishListingSchema" },
  { method: "GET", path: "/api/marketplace/:id", description: "Get marketplace listing details", category: "marketplace" },
  { method: "DELETE", path: "/api/marketplace/:id/delete", description: "Remove marketplace listing", category: "marketplace" },
  { method: "POST", path: "/api/marketplace/:id/install", description: "Install agent from marketplace", category: "marketplace" },
  { method: "POST", path: "/api/marketplace/:id/rate", description: "Rate a marketplace listing", category: "marketplace" },
  { method: "POST", path: "/api/marketplace/:id/flag", description: "Flag listing for moderation", category: "marketplace" },
  { method: "GET", path: "/api/marketplace/:id/flags", description: "Get flags for a listing (admin)", category: "marketplace" },
  { method: "GET", path: "/api/marketplace/:id/versions", description: "List versions of a listing", category: "marketplace" },
  { method: "GET", path: "/api/marketplace/flags", description: "List all flagged listings (admin)", category: "marketplace" },
  { method: "GET", path: "/api/marketplace/updates", description: "Check for available updates", category: "marketplace" },
  { method: "GET", path: "/api/marketplace/export/:id", description: "Export listing as manifest JSON", category: "marketplace" },
  { method: "POST", path: "/api/marketplace/import", description: "Import agent from manifest", category: "marketplace", schemaKey: "importManifestSchema" },

  // Knowledge Base
  { method: "GET", path: "/api/knowledge-base", description: "List knowledge base files for project", category: "knowledge-base" },
  { method: "POST", path: "/api/knowledge-base", description: "Upload file to knowledge base (multipart)", category: "knowledge-base" },
  { method: "GET", path: "/api/knowledge-base/:id", description: "Get knowledge base file details", category: "knowledge-base" },
  { method: "DELETE", path: "/api/knowledge-base/:id", description: "Delete knowledge base file", category: "knowledge-base" },

  // Memories
  { method: "GET", path: "/api/memories", description: "Search and list memories", category: "memories" },
  { method: "POST", path: "/api/memories", description: "Create a memory", category: "memories" },
  { method: "GET", path: "/api/memories/:id", description: "Get memory by ID", category: "memories" },
  { method: "PUT", path: "/api/memories/:id", description: "Update a memory", category: "memories" },
  { method: "DELETE", path: "/api/memories/:id", description: "Delete a memory", category: "memories" },

  // Projects
  { method: "GET", path: "/api/projects", description: "List projects for current user", category: "projects" },
  { method: "POST", path: "/api/projects", description: "Create a new project", category: "projects" },
  { method: "GET", path: "/api/projects/:id", description: "Get project by ID", category: "projects" },
  { method: "PUT", path: "/api/projects/:id", description: "Update project settings", category: "projects" },
  { method: "DELETE", path: "/api/projects/:id", description: "Delete a project", category: "projects" },
  { method: "PUT", path: "/api/projects/:id/tool-permission-mode", description: "Set tool permission mode for project", category: "projects" },

  // Settings
  { method: "GET", path: "/api/settings", description: "Get application settings", category: "settings" },
  { method: "GET", path: "/api/settings/:key", description: "Get single setting by key (requires an admin-role key)", category: "settings", scope: "admin", harness: { controllable: true } },
  { method: "PUT", path: "/api/settings/:key", description: "Update a setting value (requires an admin-role key)", category: "settings", scope: "admin", harness: { controllable: true } },
  { method: "GET", path: "/api/settings/developer", description: "Get developer settings and API keys", category: "settings" },
  { method: "POST", path: "/api/settings/developer/api-keys", description: "Create API key", category: "settings", schemaKey: "createApiKeySchema" },

  // Providers & Models
  { method: "GET", path: "/api/providers", description: "List configured AI providers", category: "providers" },
  { method: "POST", path: "/api/providers/:provider/test", description: "Test provider connection", category: "providers" },
  { method: "POST", path: "/api/providers/:provider/refresh-models", description: "Fetch latest models from the provider (direct /v1/models, enriched/backed by the models.dev catalog)", category: "providers" },
  { method: "GET", path: "/api/models", description: "List available AI models", category: "providers" },

  // Users & Teams
  { method: "GET", path: "/api/users", description: "List users (admin)", category: "users" },
  { method: "GET", path: "/api/users/:id", description: "Get user by ID", category: "users" },
  { method: "GET", path: "/api/users/search", description: "Search users by name or email", category: "users" },
  { method: "GET", path: "/api/teams", description: "List teams", category: "teams" },
  { method: "POST", path: "/api/teams", description: "Create a team", category: "teams" },
  { method: "GET", path: "/api/teams/:id", description: "Get team by ID", category: "teams" },
  { method: "PUT", path: "/api/teams/:id", description: "Update team", category: "teams" },
  { method: "DELETE", path: "/api/teams/:id", description: "Delete team", category: "teams" },
  { method: "GET", path: "/api/teams/:id/members", description: "List team members", category: "teams" },
  { method: "POST", path: "/api/teams/:id/members", description: "Add member to team", category: "teams" },

  // Pipelines
  { method: "GET", path: "/api/pipelines", description: "List pipelines", category: "pipelines" },
  { method: "GET", path: "/api/pipelines/:name", description: "Get pipeline by name", category: "pipelines" },
  { method: "POST", path: "/api/pipelines/:name/run", description: "Execute a pipeline", category: "pipelines" },

  // Tools
  { method: "GET", path: "/api/tools", description: "List available tools", category: "tools" },
  { method: "POST", path: "/api/tool-invoke", description: "Invoke a tool directly", category: "tools", scope: "extensions", harness: { controllable: true } },
  { method: "GET", path: "/api/tool-calls/:id/output", description: "Get tool call output", category: "tools" },
  { method: "POST", path: "/api/tool-calls/:id/permission", description: "Approve or deny tool permission", category: "tools", scope: "chat", harness: { controllable: true } },

  // Hub pages
  { method: "POST", path: "/api/hub/pages/:id/actions/:action", description: "Dispatch a named action on a core Hub page (scalar payload, rate-limited)", category: "hub", scope: "chat", harness: { controllable: true } },

  // Runs
  { method: "GET", path: "/api/runs", description: "List agent runs", category: "runs", scope: "read" },
  { method: "GET", path: "/api/runs/:id", description: "Get run details (append ?wait=1&timeoutMs= to block until terminal — run-to-completion)", category: "runs", scope: "read", harness: { controllable: true } },
  { method: "DELETE", path: "/api/runs/:id", description: "Cancel an in-flight run (ownership-gated)", category: "runs", scope: "chat", harness: { controllable: true } },

  // Observability
  { method: "GET", path: "/api/observability", description: "List observability events", category: "observability" },
  { method: "GET", path: "/api/observability/:conversationId", description: "Get events for conversation", category: "observability" },
  { method: "GET", path: "/api/runtime-events", description: "SSE stream of runtime events (run/tool/pipeline/agent lifecycle) — consumed by HarnessClient.streamEvents", category: "observability", scope: "read", harness: { controllable: true } },

  // Mentions
  { method: "GET", path: "/api/mentions/search", description: "Search mentionable items", category: "mentions" },

  // Composer suggestions
  { method: "POST", path: "/api/composer/suggest", description: "Rank the active mode/toolset's tools against a draft prompt (embedding retrieval + per-user usage prior) and optionally generate a local-LLM prompt enhancement", category: "composer", scope: "read", schemaKey: "suggestRequestSchema", responseDescription: "{ enabled, degraded?, tools?: [{name, extension, extensionType, description, score}], extensions?: [{name, description, score}], enhancement?: {enhanced, reason} | null, llmAvailable?, latencyMs }" },
  { method: "POST", path: "/api/composer/suggest/feedback", description: "Record composer-suggestion telemetry (shown/accepted/dismissed; never draft text)", category: "composer", scope: "chat", schemaKey: "suggestFeedbackSchema", responseDescription: "{ ok: true } (201)" },

  // System
  { method: "GET", path: "/api/health", description: "Health check endpoint", category: "system" },
  { method: "GET", path: "/api/warmup", description: "Pre-warm application caches", category: "system" },
  { method: "GET", path: "/api/quickstart", description: "Get quickstart checklist status", category: "system" },
  { method: "POST", path: "/api/quickstart", description: "Update quickstart step completion", category: "system" },
  { method: "GET", path: "/api/favicon", description: "Get application favicon", category: "system" },
  { method: "GET", path: "/api/audit-log", description: "List audit log entries (admin)", category: "admin" },
  { method: "GET", path: "/api/fs/list", description: "List files in a directory", category: "system" },
];
