/**
 * API Registry - describes all API routes for auto-generated documentation.
 *
 * Schemas are NOT imported here to avoid cross-workspace Zod instance issues.
 * The docs endpoint (web/src/routes/api/docs/+server.ts) maps schemas at serve time.
 */

export interface ApiRouteEntry {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
  description: string;
  category: string;
  /** Schema key used by docs endpoint to resolve the Zod schema */
  schemaKey?: string;
  responseDescription?: string;
}

export const apiRegistry: ApiRouteEntry[] = [
  // Auth
  { method: "POST", path: "/api/auth/login", description: "Authenticate user and create session", category: "auth", schemaKey: "loginSchema" },
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
  { method: "POST", path: "/api/conversations", description: "Create a new conversation", category: "conversations", schemaKey: "createConversationSchema" },
  { method: "GET", path: "/api/conversations/:id", description: "Get conversation by ID", category: "conversations" },
  { method: "PATCH", path: "/api/conversations/:id", description: "Update conversation title, model, or system prompt", category: "conversations", schemaKey: "updateConversationSchema" },
  { method: "DELETE", path: "/api/conversations/:id", description: "Delete a conversation", category: "conversations" },
  { method: "GET", path: "/api/conversations/:id/messages", description: "List messages in a conversation", category: "conversations", responseDescription: "Array of message objects with tool calls" },
  { method: "POST", path: "/api/conversations/:id/messages", description: "Send a message and trigger AI response", category: "conversations", schemaKey: "createMessageSchema" },
  { method: "GET", path: "/api/conversations/:id/export", description: "Export conversation as JSON/Markdown", category: "conversations" },
  { method: "POST", path: "/api/conversations/:id/active-run", description: "Cancel active run in conversation", category: "conversations" },

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
  { method: "GET", path: "/api/extensions", description: "List installed extensions", category: "extensions" },
  { method: "POST", path: "/api/extensions", description: "Install extension from local path or GitHub", category: "extensions", schemaKey: "installExtensionSchema" },
  { method: "GET", path: "/api/extensions/:id", description: "Get extension details", category: "extensions" },
  { method: "DELETE", path: "/api/extensions/:id", description: "Uninstall extension", category: "extensions" },
  { method: "POST", path: "/api/extensions/:id/confirm", description: "Confirm extension installation", category: "extensions" },
  { method: "GET", path: "/api/extensions/:id/permissions", description: "Get extension permissions", category: "extensions" },
  { method: "PUT", path: "/api/extensions/:id/permissions", description: "Update extension permissions", category: "extensions" },
  { method: "GET", path: "/api/extensions/:name/tools", description: "List tools provided by extension", category: "extensions" },

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
  { method: "GET", path: "/api/settings/:key", description: "Get single setting by key", category: "settings" },
  { method: "PUT", path: "/api/settings/:key", description: "Update a setting value", category: "settings" },
  { method: "GET", path: "/api/settings/developer", description: "Get developer settings and API keys", category: "settings" },
  { method: "POST", path: "/api/settings/developer/api-keys", description: "Create API key", category: "settings", schemaKey: "createApiKeySchema" },

  // Providers & Models
  { method: "GET", path: "/api/providers", description: "List configured AI providers", category: "providers" },
  { method: "POST", path: "/api/providers/:provider/test", description: "Test provider connection", category: "providers" },
  { method: "POST", path: "/api/providers/:provider/refresh-models", description: "Fetch latest model list from the provider's /v1/models endpoint", category: "providers" },
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
  { method: "POST", path: "/api/tool-invoke", description: "Invoke a tool directly", category: "tools" },
  { method: "GET", path: "/api/tool-calls/:id/output", description: "Get tool call output", category: "tools" },
  { method: "POST", path: "/api/tool-calls/:id/permission", description: "Approve or deny tool permission", category: "tools" },

  // Runs
  { method: "GET", path: "/api/runs", description: "List agent runs", category: "runs" },
  { method: "GET", path: "/api/runs/:id", description: "Get run details", category: "runs" },

  // Observability
  { method: "GET", path: "/api/observability", description: "List observability events", category: "observability" },
  { method: "GET", path: "/api/observability/:conversationId", description: "Get events for conversation", category: "observability" },

  // Mentions
  { method: "GET", path: "/api/mentions/search", description: "Search mentionable items", category: "mentions" },

  // System
  { method: "GET", path: "/api/health", description: "Health check endpoint", category: "system" },
  { method: "GET", path: "/api/warmup", description: "Pre-warm application caches", category: "system" },
  { method: "GET", path: "/api/quickstart", description: "Get quickstart checklist status", category: "system" },
  { method: "POST", path: "/api/quickstart", description: "Update quickstart step completion", category: "system" },
  { method: "GET", path: "/api/favicon", description: "Get application favicon", category: "system" },
  { method: "GET", path: "/api/audit-log", description: "List audit log entries (admin)", category: "admin" },
  { method: "GET", path: "/api/fs/list", description: "List files in a directory", category: "system" },
];
