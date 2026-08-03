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
  // Gate: `requireRole(locals,"admin")` only — no `requireScope`, so no scope
  // is declared. Reachability caveat for both methods on this exact path:
  // `/api/auth/invite` is in the hooks PUBLIC_PATHS allowlist
  // (web/src/hooks.server.ts:364), and `event.locals.user` is only ever
  // assigned INSIDE the `if (!isPublic)` block (assignment at :622, block
  // opens at :370). So neither a cookie session nor a Bearer key ever
  // populates `locals.user` here and the role gate denies every caller. Only
  // the `/:token` sub-path needs to be public. Reported as a finding; fixing
  // the allowlist is a separate change.
  { method: "GET", path: "/api/auth/invite", description: "List outstanding user invitations. Gate: requireRole(locals,\"admin\") only — no API-key scope gate", category: "auth", responseDescription: "{ invites }" },
  { method: "POST", path: "/api/auth/invite/:token", description: "Accept invitation and create account", category: "auth" },
  { method: "POST", path: "/api/auth/reset-password", description: "Generate password reset token (admin)", category: "auth", schemaKey: "generateResetSchema" },
  { method: "POST", path: "/api/auth/reset-password/:token", description: "Consume reset token and set new password", category: "auth", schemaKey: "consumeResetSchema" },
  { method: "GET", path: "/api/auth/oauth", description: "Initiate OAuth login flow", category: "auth" },
  { method: "GET", path: "/api/auth/oauth/callback", description: "Handle OAuth provider callback", category: "auth" },

  // Account
  { method: "GET", path: "/api/account", description: "Get current user account details", category: "account" },
  { method: "PUT", path: "/api/account", description: "Update account name or email", category: "account" },
  { method: "PUT", path: "/api/account/password", description: "Change account password", category: "account" },
  { method: "GET", path: "/api/account/sessions", description: "List the caller's OWN active sessions with the current one flagged", category: "account", scope: "read", responseDescription: "{ sessions: [{ id, userAgent, ipAddress, lastActiveAt, createdAt, isCurrent }] }" },
  // Self-service revoke: the `admin` SCOPE is a key write-gate, and the row is
  // re-checked against the caller's own session list (404 otherwise) — hence
  // no role check, and hence this file's presence in
  // route-contract.test.ts's KNOWN_SCOPE_ONLY_ADMIN list.
  { method: "DELETE", path: "/api/account/sessions", description: "Revoke one of the caller's OWN sessions by { sessionId } — 404 for a session the caller does not own, 400 for the current session (log out instead)", category: "account", scope: "admin", responseDescription: "{ success: true }" },
  { method: "GET", path: "/api/account/login-history", description: "The caller's last 10 `auth:login` audit entries", category: "account", scope: "read", responseDescription: "{ entries }" },

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
  { method: "GET", path: "/api/conversations/:id/graph", description: "Chat DAG for a conversation — level 1 (prompts + rewind/A-B forks + sub-agent spawns) by default, or level 2 (one turn's thinking/tool/sub-agent/error internals) with ?turn=<userMessageId>. Degrades to a flat chain instead of 409 when the history-producer flag is off", category: "conversations", scope: "read", responseDescription: "{ level: 1|2, rootId: string|null, conversationId, nodes: [{ id, kind, label, fullLabel?, status, createdAt, durationMs?, excluded?, drillable?, subConversationId?, extensionId? }], edges: [{ from, to, kind }], degraded? }" },
  { method: "POST", path: "/api/conversations/:id/rewind", description: "Rewind/checkpoint the conversation to a message (moves the durable leaf pointer; 409 when the flag is off or a run is active)", category: "conversations", scope: "chat", harness: { controllable: true }, schemaKey: "rewindConversationSchema", responseDescription: "{ conversationId, currentLeaf, nodes } (the refreshed tree)" },
  { method: "POST", path: "/api/conversations/:id/messages/:mid/retry", description: "Clean A/B retry — re-run the target assistant message's parent user turn as a same-role sibling (no duplicate user row; 409 when the flag is off or a run is active)", category: "conversations", scope: "chat", harness: { controllable: true }, schemaKey: "retryMessageSchema", responseDescription: "{ userMessage, retriedMessageId, runId }" },
  { method: "GET", path: "/api/search/messages", description: "Hybrid/keyword/semantic message search (RRF)", category: "conversations", responseDescription: "{ hits, degraded, requestedMode, servedMode }" },
  { method: "GET", path: "/api/conversations/:id/audit", description: "Per-conversation audit timeline (sdk_capability_calls scoped to the conversation), cursor-paginated with ?capability ?status=denial ?since ?until ?limit. Owner-only with an admin fallback for unowned rows; 404 (not 403) so the endpoint is not a conversation-id oracle", category: "conversations", scope: "read", responseDescription: "{ entries, nextCursor }" },

  // Topic Contexts
  { method: "GET", path: "/api/conversations/:id/topics", description: "Cached topic pills for a conversation (no LLM)", category: "contexts", scope: "read", responseDescription: "{ topics: [{ id, label, typeId, messageIds }], stale, analyzedAt }" },
  { method: "POST", path: "/api/conversations/:id/topics", description: "Detect topics for a conversation (stage-1 LLM); 503 when no model is available", category: "contexts", scope: "chat", responseDescription: "{ topics, stale, analyzedAt }" },
  { method: "POST", path: "/api/conversations/:id/topics/:topicId/extract", description: "Extract + save a topic's context (stage-2 LLM); 503 when no model is available", category: "contexts", scope: "chat", responseDescription: "{ context: { id, topicLabel, typeId, title, content, model, updatedAt } }" },
  { method: "GET", path: "/api/contexts", description: "Search saved topic contexts (library): ?projectId=&search=&typeId=&limit=&offset=", category: "contexts", scope: "read", responseDescription: "{ contexts, total }" },
  { method: "DELETE", path: "/api/contexts/:id", description: "Delete a saved context (owner or admin; 404 otherwise)", category: "contexts", scope: "write" },
  { method: "GET", path: "/api/context-types", description: "List the DB-resident topic classification types", category: "contexts", scope: "read", responseDescription: "{ types: [{ id, label, description, sortOrder }] }" },

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
  { method: "GET", path: "/api/extensions/:id/triggers", description: "List an extension's DYNAMIC cron + webhook triggers (created at runtime via ctx.triggers; invisible to the manifest and both reconcilers)", category: "extensions", scope: "admin" },
  { method: "GET", path: "/api/extensions/:id/reapprove-drift", description: "Preview a bundled extension's current on-disk, ceiling-clamped permissions and how they differ from the stored grant (requires an admin-role key)", category: "extensions", scope: "admin", responseDescription: "{ version, permissions, diffs: [{ field, oldValue, newValue }], ceilingClamped }" },
  { method: "POST", path: "/api/extensions/:id/reapprove-drift", description: "Re-approve a bundled extension's permission drift from its current on-disk manifest, clamped to the bundled ceiling (requires an admin-role key)", category: "extensions", scope: "admin", responseDescription: "{ extension, diffs: [{ field, oldValue, newValue }] }" },
  { method: "GET", path: "/api/extensions/:name/tools", description: "List tools provided by extension", category: "extensions", scope: "read" },
  { method: "POST", path: "/api/extensions/:id/secrets", description: "Set (or rotate) an extension secret — encrypted, scope-isolated, AAD-bound; value never echoed back", category: "extensions", scope: "extensions", harness: { controllable: true } },
  { method: "DELETE", path: "/api/extensions/:id/secrets", description: "Delete an extension secret", category: "extensions", scope: "extensions", harness: { controllable: true } },
  // The ONLY recovery path for an extension the host disabled on a filesystem
  // security violation: `activateExtension` refuses to re-enable while
  // `hasSecurityViolation(id)` holds ("Clear violations first."), and DELETE
  // here is what clears it. It went unregistered, so the one route an operator
  // needs to un-brick an extension was absent from the OpenAPI spec and the
  // harness client. Admin-role gated inline (`locals.user?.role !== "admin"`).
  { method: "GET", path: "/api/extensions/:id/violations", description: "List the filesystem/capability security violations recorded against an extension by the host gates (requires an admin-role key)", category: "extensions", scope: "admin", responseDescription: "{ violations: [{ extensionId, reason, path, timestamp }] }" },
  { method: "DELETE", path: "/api/extensions/:id/violations", description: "Clear an extension's recorded security violations — the prerequisite for re-enabling it via POST /api/extensions/:id/activate, which refuses while any violation stands (requires an admin-role key)", category: "extensions", scope: "admin", responseDescription: "{ cleared: true }" },

  // ── Per-extension audit drill-down ────────────────────────────────────
  // Both pair requireScope("admin") with requireRole(locals,"admin").
  { method: "GET", path: "/api/extensions/:id/audit", description: "Unified audit timeline for one extension — governance rows, SDK capability calls, and memory/lesson mutations fanned in and cursor-paginated (?capability ?status=denial ?since ?until ?limit); ?legacy=1 serves the pre-merge governance-only shape (requires an admin-role key)", category: "extensions", scope: "admin", responseDescription: "{ entries, nextCursor }" },
  { method: "GET", path: "/api/extensions/:id/audit/stats", description: "Stats strip for one extension over ?range=24h|7d|30d (unknown values fall back to 24h) — cost is an estimate, not provider billing (requires an admin-role key)", category: "extensions", scope: "admin", responseDescription: "{ totalCalls, totalCostUsd, successRate, denialCount }" },

  // ── defineEntity record CRUD (SDK phase 5) ────────────────────────────
  // Every handler binds the store to the CALLING user (`scopeId: user.id`),
  // so there is no cross-user read. Reads take "read", writes take
  // "extensions" — mirroring the settings PUT gate.
  { method: "GET", path: "/api/extensions/:id/entities/:type", description: "List an extension's entity records for the calling user; each row carries `_validationWarning` when its body no longer matches the manifest schema (soft read)", category: "extensions", scope: "read", responseDescription: "{ items: [{ slug, data, _validationWarning? }] }" },
  { method: "POST", path: "/api/extensions/:id/entities/:type", description: "Create one entity record — server-side slug + JSON-Schema validation (the client form is untrusted); 404 unknown extension/type, 409 duplicate slug", category: "extensions", scope: "extensions", responseDescription: "{ slug, data } (201)" },
  { method: "GET", path: "/api/extensions/:id/entities/:type/:slug", description: "Read one entity record (soft read — `_validationWarning` on schema drift)", category: "extensions", scope: "read", responseDescription: "{ slug, data, _validationWarning? }" },
  { method: "PUT", path: "/api/extensions/:id/entities/:type/:slug", description: "Shallow-merge update of one entity record — accepts { patch } or { data }; slug is immutable and a `slug` key in the body is a 400", category: "extensions", scope: "extensions", responseDescription: "{ slug, data }" },
  { method: "DELETE", path: "/api/extensions/:id/entities/:type/:slug", description: "Delete one entity record and drop it from the type index", category: "extensions", scope: "extensions", responseDescription: "{ deleted: boolean }" },

  { method: "GET", path: "/api/extensions/:id/expired-grants", description: "The capability grants that expired for this extension in the last 7 days, enriched with the user's sticky per-kind re-approval TTL — feeds the settings-page ExpiredGrantsBanner. Any authenticated caller: the rows are the caller's OWN permission state, unlike the admin-only /audit drill-down", category: "extensions", scope: "extensions", responseDescription: "{ grants: [{ …, capabilityKind, stickyTtlMs }] }" },

  // The three routes below apply NO `requireScope` call at all, so no
  // `scope` is declared — inventing one here would document an enforcement
  // the handler does not perform. What each DOES enforce is in its
  // description. Flagged in the registry-reconciliation findings.
  { method: "GET", path: "/api/extensions/:id/settings", description: "Per-user settings schema, declared defaults, the caller's values, the resolved blob, write-only secret presence probes, and held host capabilities. Gate: requireAuth only — no API-key scope gate, so a read-scoped key reaches it", category: "extensions", responseDescription: "{ schema, declaredDefaults, userValues, resolved, secrets, capabilities }" },
  { method: "PUT", path: "/api/extensions/:id/settings/user", description: "Write the caller's per-extension settings — secret-typed fields are encrypted into extension storage (empty string clears) and never echoed; the mutation is audited name-only. Gate: requireAuth only — no API-key scope gate, so a read-scoped key can perform this WRITE (and set/clear secrets)", category: "extensions", responseDescription: "{ ok: true, userValues, secrets }" },
  { method: "DELETE", path: "/api/extensions/:id/settings/user", description: "Reset the caller's per-extension settings to declared defaults (409 when the extension declares no settings schema). Gate: requireAuth only — no API-key scope gate", category: "extensions", responseDescription: "{ ok: true }" },
  { method: "POST", path: "/api/extensions/:id/modifiable", description: "Flip the per-extension `modifiable` flag that authorizes its CREATOR to re-open and edit it; refused for bundled extensions, idempotent, audited. Gate: requireRole(locals,\"admin\") only — no API-key scope gate, so any scope on an admin-role key reaches it", category: "extensions" },

  // Loops EZ Mode Phase 4 — inbound webhook trigger. Public data-plane: auth is
  // the per-hook token (NOT a session), so scope "public". Persists a delivery
  // onto the claim-before-dispatch queue; the WebhookDeliveryDaemon fires it.
  { method: "POST", path: "/api/hooks/:extensionId/:slug", description: "Deliver an inbound webhook to a loop's webhook trigger (per-hook token or X-Hub-Signature-256 HMAC; 256KB cap; per-hook rate limit + daily budget)", category: "extensions", scope: "public", harness: { controllable: true } },
  { method: "POST", path: "/api/extensions/:name/webhooks/:slug/rotate", description: "Rotate a webhook hook's per-hook secret and return the plaintext once (admin-gated; shown-once secrets UX)", category: "extensions", scope: "admin" },

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
  { method: "DELETE", path: "/api/marketplace/:id", description: "Soft-remove a listing (status → \"removed\"), audited as marketplace:remove — distinct from the legacy DELETE /api/marketplace/:id/delete path (requires an admin-role key)", category: "marketplace", scope: "admin", responseDescription: "{ ok: true }" },
  { method: "DELETE", path: "/api/marketplace/:id/delete", description: "Remove marketplace listing", category: "marketplace" },
  { method: "POST", path: "/api/marketplace/:id/install", description: "Install agent from marketplace", category: "marketplace" },
  { method: "POST", path: "/api/marketplace/:id/rate", description: "Rate a marketplace listing", category: "marketplace" },
  { method: "POST", path: "/api/marketplace/:id/flag", description: "Flag listing for moderation", category: "marketplace" },
  { method: "GET", path: "/api/marketplace/:id/flags", description: "Get flags for a listing (admin)", category: "marketplace" },
  { method: "PATCH", path: "/api/marketplace/:id/flags", description: "Resolve a pending moderation flag: { flagId, action: \"dismissed\" | \"removed\" }, audited as marketplace:flag:<action> (requires an admin-role key)", category: "marketplace", scope: "admin", responseDescription: "{ ok: true }" },
  { method: "GET", path: "/api/marketplace/:id/versions", description: "List versions of a listing", category: "marketplace" },
  { method: "GET", path: "/api/marketplace/flags", description: "List all flagged listings (admin)", category: "marketplace" },
  { method: "GET", path: "/api/marketplace/updates", description: "Check for available updates", category: "marketplace" },
  { method: "GET", path: "/api/marketplace/export/:id", description: "Export listing as manifest JSON", category: "marketplace" },
  { method: "POST", path: "/api/marketplace/import", description: "Import agent from manifest", category: "marketplace", schemaKey: "importManifestSchema" },

  // Knowledge Base
  { method: "GET", path: "/api/knowledge-base", description: "List knowledge base files for project", category: "knowledge-base", scope: "read" },
  { method: "POST", path: "/api/knowledge-base", description: "Upload file to knowledge base (multipart)", category: "knowledge-base", scope: "write" },
  { method: "GET", path: "/api/knowledge-base/:id", description: "Get knowledge base file details", category: "knowledge-base", scope: "read" },
  { method: "DELETE", path: "/api/knowledge-base/:id", description: "Delete knowledge base file", category: "knowledge-base", scope: "read" },

  // Memories
  { method: "GET", path: "/api/memories", description: "Search and list memories", category: "memories", scope: "read" },
  { method: "POST", path: "/api/memories", description: "Create a memory", category: "memories", scope: "write" },
  { method: "GET", path: "/api/memories/:id", description: "Get memory by ID", category: "memories", scope: "read" },
  { method: "PUT", path: "/api/memories/:id", description: "Update a memory", category: "memories", scope: "write" },
  { method: "DELETE", path: "/api/memories/:id", description: "Delete a memory", category: "memories", scope: "write" },

  // Projects
  { method: "GET", path: "/api/projects", description: "List projects for current user", category: "projects", scope: "read" },
  { method: "POST", path: "/api/projects", description: "Create a new project", category: "projects", scope: "write" },
  { method: "GET", path: "/api/projects/:id", description: "Get project by ID", category: "projects", scope: "read" },
  { method: "PUT", path: "/api/projects/:id", description: "Update project settings", category: "projects", scope: "read" },
  { method: "DELETE", path: "/api/projects/:id", description: "Delete a project", category: "projects", scope: "read" },
  { method: "PUT", path: "/api/projects/:id/tool-permission-mode", description: "Set tool permission mode for project", category: "projects" },

  // Settings
  { method: "GET", path: "/api/settings", description: "Get application settings", category: "settings" },
  { method: "GET", path: "/api/settings/:key", description: "Get single setting by key (requires an admin-role key)", category: "settings", scope: "admin", harness: { controllable: true } },
  { method: "PUT", path: "/api/settings/:key", description: "Update a setting value (requires an admin-role key)", category: "settings", scope: "admin", harness: { controllable: true } },
  { method: "DELETE", path: "/api/settings/:key", description: "Delete a setting value; internally-managed keys (the sensitive deny-list) are refused with 403 (requires an admin-role key)", category: "settings", scope: "admin", responseDescription: "{ ok: true }" },
  { method: "GET", path: "/api/settings/developer", description: "Get developer settings and API keys", category: "settings" },
  { method: "POST", path: "/api/settings/developer/api-keys", description: "Create API key", category: "settings", schemaKey: "createApiKeySchema" },
  // Self-service key management. The `admin` SCOPE on the write paths is a
  // write-gate for KEY principals only — there is no role check, and none is
  // wanted: every row is filtered to the CALLING user, so forcing an admin
  // role would lock members out of their own keys. This is why
  // `settings/developer{,/api-keys}` sit in route-contract.test.ts's
  // KNOWN_SCOPE_ONLY_ADMIN list.
  { method: "GET", path: "/api/settings/developer/api-keys", description: "List the caller's OWN API keys — keyId, name, scopes, role (legacy rows default to \"member\"), createdAt. Never the hash or the raw key", category: "settings", scope: "read", responseDescription: "{ keys: [{ keyId, name, scopes, role, createdAt }] }" },
  { method: "DELETE", path: "/api/settings/developer/api-keys", description: "Revoke one of the caller's OWN API keys by { keyId } — drops both the canonical row and its hash-index pointer so the key cannot re-authenticate via the fast path; 404 when the key is not the caller's", category: "settings", scope: "admin", responseDescription: "204 No Content" },
  { method: "POST", path: "/api/settings/developer", description: "Mint the caller's marketplace publish token — only its SHA-256 hash is stored, and the raw value is returned exactly once", category: "settings", scope: "admin", responseDescription: "{ token }" },
  { method: "DELETE", path: "/api/settings/developer", description: "Revoke the caller's marketplace publish token", category: "settings", scope: "admin", responseDescription: "204 No Content" },

  // Providers & Models
  { method: "GET", path: "/api/providers", description: "List configured AI providers", category: "providers" },
  { method: "POST", path: "/api/providers/:provider/test", description: "Test provider connection", category: "providers" },
  { method: "POST", path: "/api/providers/:provider/refresh-models", description: "Fetch latest models from the provider (direct /v1/models, enriched/backed by the models.dev catalog)", category: "providers" },
  { method: "GET", path: "/api/models", description: "List available AI models", category: "providers" },
  { method: "GET", path: "/api/models/default-selection", description: "Default model selection for a user with no saved pick — `provider:defaultSelection`, \"auto\" (route the first turn) or \"first\" (pin models[0]). Read-scoped, not admin-only, so an operator's revert reaches every user", category: "providers", scope: "read", responseDescription: '{ value: "auto" | "first" }' },

  // ── Instance-state writes gated on ROLE ONLY ──────────────────────────
  // Everything in this block calls `requireRole(locals,"admin")` and NOTHING
  // else — no `requireScope`. That is deliberate history (sec-C5 / sec-H1
  // replaced a cookie-no-op `requireScope("admin")` with the role gate) but it
  // left the KEY axis ungated: an admin-role key minted `--scopes read`
  // satisfies these. No `scope` is declared because none is enforced;
  // documenting one would describe a gate that does not exist. See the
  // registry-reconciliation findings — changing the gate is a separate,
  // reviewable security change, not part of a registration pass.
  { method: "POST", path: "/api/providers", description: "Store (encrypted) the instance's BYOK API key for anthropic|openai|google|openrouter, audited as provider:key_upsert. Gate: requireRole(locals,\"admin\") only — no API-key scope gate", category: "providers" },
  { method: "DELETE", path: "/api/providers", description: "Delete the instance's stored BYOK API key for one provider, audited as provider:key_delete. Gate: requireRole(locals,\"admin\") only — no API-key scope gate", category: "providers" },
  { method: "POST", path: "/api/providers/local/models", description: "List models offered by a caller-supplied local OpenAI-compatible baseUrl. Server-side fetch behind the sec-H1 SSRF guard: http(s) only, private/loopback rejected, and every resolved A/AAAA re-checked (DNS-rebinding pin). Gate: requireRole(locals,\"admin\") only — no API-key scope gate", category: "providers" },
  { method: "POST", path: "/api/providers/local/test", description: "Probe one { baseUrl, modelId } on a local OpenAI-compatible server, behind the same sec-H1 SSRF guard as /local/models. Gate: requireRole(locals,\"admin\") only — no API-key scope gate", category: "providers" },

  // MCP server lifecycle. Same role-only shape as the block above; each of
  // these opens an outbound connection to an operator-supplied MCP server.
  { method: "POST", path: "/api/mcp-servers", description: "Install an MCP server as an extension — a throwaway client must connect and return tools/list before anything is persisted (502 on failure, no mutation). Gate: requireRole(locals,\"admin\") only — no API-key scope gate", category: "extensions", responseDescription: "the installed extension row (201)" },
  { method: "PUT", path: "/api/mcp-servers/:id", description: "Edit an installed MCP server's config and re-snapshot its tools; a blank header value keeps the stored secret, and connectivity is verified before any write (502 leaves the config untouched). Gate: requireRole(locals,\"admin\") only — no API-key scope gate", category: "extensions" },
  { method: "POST", path: "/api/mcp-servers/:id/refresh", description: "Re-pull an installed MCP server's tool list into the registry cache (502 when the server is unreachable). Gate: requireRole(locals,\"admin\") only — no API-key scope gate", category: "extensions", responseDescription: "{ id, tools }" },

  // Search backend config — reuses the encrypted, deny-listed
  // `provider:apiKey:*` store, so keys are never readable back out.
  { method: "GET", path: "/api/search/backend", description: "Presence-only search-backend status: hasKey per BYOK provider (tavily|brave|exa|serpapi|jina) plus the SearXNG base URL. Keys are never returned. Gate: requireRole(locals,\"admin\") only — no API-key scope gate", category: "settings", responseDescription: "{ providers: [{ provider, hasKey }], searxngUrl }" },
  { method: "POST", path: "/api/search/backend", description: "Upsert either a BYOK search key (encrypted into provider:apiKey:*) or the SearXNG base URL (http(s) validated), audited as search:backend_upsert. Gate: requireRole(locals,\"admin\") only — no API-key scope gate", category: "settings" },
  { method: "DELETE", path: "/api/search/backend", description: "Delete one BYOK search key, audited as search:backend_delete. Gate: requireRole(locals,\"admin\") only — no API-key scope gate", category: "settings" },

  // Users & Teams
  { method: "GET", path: "/api/users", description: "List users (admin)", category: "users" },
  { method: "GET", path: "/api/users/:id", description: "Get user by ID", category: "users" },
  { method: "PUT", path: "/api/users/:id", description: "Activate or deactivate a user ({ status: \"active\" | \"inactive\" }); deactivation atomically transfers the user's agents to the acting admin and refuses self-deactivation (requires an admin-role key)", category: "users", scope: "admin", responseDescription: "{ user } (password hash stripped)" },
  { method: "GET", path: "/api/users/search", description: "Search users by name or email", category: "users" },
  { method: "GET", path: "/api/teams", description: "List teams", category: "teams" },
  { method: "POST", path: "/api/teams", description: "Create a team", category: "teams" },
  { method: "GET", path: "/api/teams/:id", description: "Get team by ID", category: "teams" },
  { method: "PUT", path: "/api/teams/:id", description: "Update team", category: "teams" },
  { method: "DELETE", path: "/api/teams/:id", description: "Delete team", category: "teams" },
  { method: "GET", path: "/api/teams/:id/members", description: "List team members", category: "teams" },
  { method: "POST", path: "/api/teams/:id/members", description: "Add member to team", category: "teams" },
  // Authorization here is the TEAM role (`requireTeamRole(locals, id, "owner")`,
  // which instance admins bypass), not the instance role — so the `admin`
  // SCOPE is a key write-gate only. That is why this file sits in
  // route-contract.test.ts's KNOWN_SCOPE_ONLY_ADMIN list.
  { method: "DELETE", path: "/api/teams/:id/members", description: "Remove a member from a team by { userId } — team OWNER (or an instance admin) only; refuses to remove the last owner", category: "teams", scope: "admin", responseDescription: "{ success: true }" },

  // Workflows
  { method: "GET", path: "/api/workflows", description: "List workflows the caller may see — filtered by ownership, so a read-scoped key with no project sees system workflows only (shorter array than pre-C6, same shape)", category: "workflows" },
  { method: "GET", path: "/api/workflows/:name", description: "Get workflow by name (404, not 403, when unauthorized — the endpoint is not an existence oracle)", category: "workflows" },
  { method: "POST", path: "/api/workflows/:name/run", description: "Execute a workflow", category: "workflows" },
  // NOT `controllable` yet: that flag asserts a matching
  // `@ezcorp/harness-client` method exists, and the parity meta-test
  // correctly fails without one. Claiming it while shipping no client
  // method would make the registry lie about the remote surface.
  { method: "GET", path: "/api/workflows/approvals", description: "List pending workflow approvals this caller may answer", category: "workflows", scope: "read", responseDescription: "{ approvals: PendingApproval[] }" },
  // NO `scope`, deliberately — and this is the one entry where the absence
  // is the point. `scope` renders as `security: [{ bearerAuth: [scope] }]`
  // (src/openapi.ts:40), i.e. "call this with a key holding that scope".
  // Answering an approval is the CONSENT boundary and is session-only
  // (`requireSessionAuth`): NO key of any scope can reach it, so declaring
  // one would publish a lie about a security boundary in the OpenAPI spec.
  { method: "POST", path: "/api/workflows/approvals/:id", description: "Answer a parked workflow approval and resume its run. SESSION-ONLY: refuses every API key (403) — a run parks on an approval so that a person decides, so a leaked key must not be able to spend one. Body { choice, form?, itemIds?, consentAll? }", category: "workflows", responseDescription: "{ run: WorkflowRun, consentAllUsed: boolean }" },
  // Operator control over a durable run. NOT an approval-answering path:
  // resume takes no choice and cannot clear a pending consent gate — a run
  // parked on an unanswered approval comes back 409 and stays answerable.
  // See `workflow-run-control.ts` and ported invariant 7.
  { method: "GET", path: "/api/workflows/runs", description: "Workflow run history, newest first — keyset paginated on (started_at, id); a non-admin sees only runs they initiated", category: "workflows", scope: "read", responseDescription: "{ runs: WorkflowRunSummary[], nextCursor?: { startedAt, id } }" },
  { method: "GET", path: "/api/workflows/runs/:id", description: "One run's trace: the run, its steps with per-step model/tokens/duration/resolved input/output, and each step's loop iterations (404, not 403, when unauthorized — a trace carries redacted-but-untrusted payloads)", category: "workflows", scope: "read", responseDescription: "{ run, steps: WorkflowTraceStep[], totals }" },
  { method: "POST", path: "/api/workflows/runs/:id/resume", description: "Continue a suspended workflow run", category: "workflows", scope: "chat", responseDescription: "{ run: WorkflowRun }" },
  { method: "POST", path: "/api/workflows/runs/:id/cancel", description: "Cancel a running or suspended workflow run", category: "workflows", scope: "chat", responseDescription: "{ cancelled: true }" },
  { method: "POST", path: "/api/workflows/:name/dry-run", description: "Simulate a workflow — transform/gate steps evaluated, everything else stubbed; zero LLM, zero side effects, no run row", category: "workflows" },
  { method: "POST", path: "/api/workflows/:name/fork", description: "Clone a workflow into an editable project-scoped copy owned by the caller", category: "workflows" },
  { method: "GET", path: "/api/workflows/:name/versions", description: "Version history for a workflow", category: "workflows" },
  { method: "POST", path: "/api/workflows/:name/claim", description: "Assign an owner to a system-owned workflow (admin)", category: "workflows", scope: "admin" },

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
  { method: "GET", path: "/api/runtime-events", description: "SSE stream of runtime events (run/tool/workflow/agent lifecycle) — consumed by HarnessClient.streamEvents", category: "observability", scope: "read", harness: { controllable: true } },

  // Mentions
  { method: "GET", path: "/api/mentions/search", description: "Search mentionable items", category: "mentions" },

  // Composer suggestions
  { method: "POST", path: "/api/composer/suggest", description: "Rank the active mode/toolset's tools against a draft prompt (embedding retrieval + per-user usage prior) and optionally generate a local-LLM prompt enhancement", category: "composer", scope: "read", schemaKey: "suggestRequestSchema", responseDescription: "{ enabled, degraded?, tools?: [{name, extension, extensionType, description, score}], extensions?: [{name, description, score}], enhancement?: {enhanced, reason} | null, llmAvailable?, latencyMs }" },
  { method: "POST", path: "/api/composer/suggest/feedback", description: "Record composer-suggestion telemetry (shown/accepted/dismissed; never draft text)", category: "composer", scope: "chat", schemaKey: "suggestFeedbackSchema", responseDescription: "{ ok: true } (201)" },

  // System
  { method: "GET", path: "/api/health", description: "Health check endpoint", category: "system" },
  // Was registered as GET (and carried in route-contract.test.ts's KNOWN_STALE
  // for exactly that reason); the handler on disk only exports POST.
  { method: "POST", path: "/api/warmup", description: "Pre-warm the embedding model so the first memory/search turn doesn't pay the load cost — best-effort, always 200", category: "system", scope: "read", responseDescription: "{ ok: true }" },
  // Both of these are in the hooks PUBLIC_PATHS allowlist
  // (web/src/hooks.server.ts:364) AND apply no gate of their own, so they are
  // genuinely reachable unauthenticated — hence scope "public".
  { method: "GET", path: "/api/ready", description: "Readiness probe — orthogonal to /api/health (liveness). 200 once migrate() has succeeded and the image is safe to route traffic to, 503 otherwise; orchestrators gate rollouts on this", category: "system", scope: "public" },
  { method: "GET", path: "/api/version", description: "Running version plus the cached upstream update check", category: "system", scope: "public" },
  { method: "GET", path: "/api/auth/ping", description: "No-op keepalive for the client-side session refresher — the real work is the sliding JWT rotation hooks.server.ts performs on the way through. 401 when unauthenticated (inline `locals.user` check; no scope gate)", category: "auth", responseDescription: "{ ok: boolean }" },
  { method: "GET", path: "/api/docs", description: "Self-describing API index: every apiRegistry entry with its JSON Schema request body where a schemaKey resolves", category: "system", scope: "read" },
  { method: "GET", path: "/api/models/capabilities", description: "Capability intersection for a ?provider/?model pick (or the auto-routing ladder), widened by the extensions wired to ?conversationId plus any ?extensions= drafted via !ext: mentions", category: "providers", scope: "read" },
  { method: "GET", path: "/api/active-agents", description: "In-flight agent runs, optionally filtered by ?projectId. Non-admins see only runs in conversations they own — the ownership filter is what stops a read-scoped key enumerating every tenant's runIds, agent names and conversation titles", category: "agents", scope: "read", responseDescription: "[{ runId, agentName, conversationId, parentConversationId, projectId, conversationTitle, startedAt }]" },
  { method: "GET", path: "/api/quickstart", description: "Get quickstart checklist status", category: "system" },
  { method: "POST", path: "/api/quickstart", description: "Update quickstart step completion", category: "system" },
  { method: "GET", path: "/api/favicon", description: "Get application favicon", category: "system" },
  { method: "GET", path: "/api/audit-log", description: "List audit log entries (admin)", category: "admin" },
  { method: "GET", path: "/api/admin/analytics/routing", description: "Routing + cost analytics: routed-vs-pinned share, tier mix, failover rate, mid-conversation model switches, A/B retry rate, and priced spend per provider+model (admin)", category: "admin", scope: "admin", responseDescription: "{ days, turns: { total, routed, pinned, legacy }, routedShare, tierMix, failover, switches, retries, spend: { segments, routedUsd, pinnedUsd, legacyUsd, totalUsd, unpricedTurns, unpricedTokens, conversations, usdPerConversation } }" },

  // ── Admin console + audit feeds ───────────────────────────────────────
  // All eight gate on BOTH axes: `requireScope(locals,"admin")` followed by
  // `requireRole(locals,"admin")`, so a member cookie and a non-admin key are
  // both rejected. Registered from the handlers, not from intent.
  { method: "GET", path: "/api/admin/sessions", description: "List every live session across all users (admin), optionally filtered by ?userId — carries userAgent + ipAddress per row", category: "admin", scope: "admin", responseDescription: "{ sessions: [{ id, userId, userName, userEmail, userAgent, ipAddress, lastActiveAt, createdAt }] }" },
  { method: "DELETE", path: "/api/admin/sessions", description: "Force-logout: revoke one session by { sessionId } or every session of a user by { userId } (admin)", category: "admin", scope: "admin", responseDescription: "{ success: true, revokedCount? }" },
  { method: "GET", path: "/api/admin/analytics", description: "Admin dashboard aggregates over the last ?days (clamped 1–365): chat activity, model usage, agent/extension/user stats, and tool usage by tool/agent/user/model", category: "admin", scope: "admin" },
  { method: "GET", path: "/api/admin/system", description: "Admin dashboard system panel: health, activity feed, and error summary", category: "admin", scope: "admin", responseDescription: "{ health, activityFeed, errorSummary }" },
  { method: "GET", path: "/api/admin/errors", description: "Paginated error-log feed (?limit clamped 1–500, ?offset ≥ 0) for the admin dashboard", category: "admin", scope: "admin", responseDescription: "{ errors, total }" },
  { method: "GET", path: "/api/admin/embed-progress", description: "Read-only message-embedding backfill progress — the same source the backfill CLI's --status flag reads", category: "admin", scope: "admin" },
  { method: "GET", path: "/api/audit", description: "Global cross-extension audit feed (sdk_capability_calls + governance rows), cursor-paginated; filters ?extensionId ?capability ?action ?onBehalfOf ?denialOnly ?search ?limit (clamped 1–200)", category: "admin", scope: "admin", responseDescription: "{ entries, nextCursor }" },
  { method: "GET", path: "/api/audit/stats", description: "Headline audit aggregates for ?range=24h|7d|30d (unknown values fall back to 24h): denial count, total calls, total cost, top-3 chattiest extensions, top-3 LLM spenders", category: "admin", scope: "admin" },

  { method: "GET", path: "/api/fs/list", description: "List files in a directory", category: "system" },
  // Gate is `requireScope(locals,"read")` + an INLINE `user.role !== "admin"`
  // check — NOT requireAdmin/requireRole, so the admin-gate pairing scan in
  // route-contract.test.ts cannot see it. Declared scope mirrors the handler:
  // "read" is genuinely what the key axis demands, even though the call
  // MUTATES the filesystem. See the reconciliation findings.
  { method: "POST", path: "/api/fs/mkdir", description: "Create a directory (recursive) inside the project sandbox — admin ROLE required AND the `admin` scope (until 2026-08 the scope gate was only `read`, so a nominally read-only key reached it); the target's nearest existing ancestor is realpath-checked against EZCORP_PROJECT_ROOT to block symlink escapes", category: "system", scope: "admin", responseDescription: "{ path } (201)" },
];
