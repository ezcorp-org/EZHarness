// ── V2 Component Definitions ─────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema object
  cardType?: string; // Maps to frontend card component for custom rendering
  /**
   * Where the chat UI should render this tool's card when the call completes.
   *   "inline" (default) — render inside the message bubble, same as today.
   *   "dock"             — render in the floating right-side `DockHost` panel,
   *                        and replace the in-message slot with a navigable
   *                        "Canvas open ↗" pill. Only honored for
   *                        `status === "complete"`; running calls always
   *                        render inline (streaming-precedence rule).
   * Unknown values are tolerated and normalized to `"inline"` at the host —
   * the warning surfaces in the registry log without breaking install.
   */
  cardLayout?: "inline" | "dock";
}

export interface SkillDefinition {
  name: string;
  description: string;
  prompt?: string;
  files?: string[]; // Paths relative to package root
}

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerStdio {
  transport: "stdio";
  name: string;
  description?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

export interface McpServerHttp {
  transport: "http";
  name: string;
  description?: string;
  url: string;
  headers?: Record<string, string>;
}

export interface McpServerSse {
  transport: "sse";
  name: string;
  description?: string;
  url: string;
  headers?: Record<string, string>;
}

export type McpServerDefinition = McpServerStdio | McpServerHttp | McpServerSse;

export interface AgentComponentDefinition {
  prompt: string;
  category?: string;
  capabilities?: string[];
  modelRequirements?: {
    tier: "fast" | "balanced" | "powerful" | "reasoning";
    contextWindow?: number;
  };
  temperature?: number;
  maxTokens?: number;
  outputFormat?: "text" | "json";
  inputSchema?: Record<string, unknown>;
  exampleConversations?: Array<{
    title: string;
    messages: Array<{ role: "user" | "assistant"; content: string }>;
  }>;
}

export interface ScriptDefinition {
  // Lifecycle hooks
  postinstall?: string; // Script path relative to package root
  preuninstall?: string;
  // Named user-invokable commands
  commands?: Record<
    string,
    {
      entrypoint: string;
      description?: string;
    }
  >;
}

// ── Dependency Types ─────────────────────────────────────────────

export interface DependencySpec {
  source: string; // e.g. "github:user/repo" or "git:https://..."
  version: string; // exact "1.0.0" or caret "^1.0.0"
}

// ── Extension Manifest V2 ────────────────────────────────────────

export interface ExtensionManifestV2 {
  schemaVersion: 2;
  name: string; // Also serves as namespace prefix
  version: string; // semver
  description: string;
  author: {
    name: string;
    id?: string;
  };

  // Extension kind. Omitted or "local" for packaged subprocess extensions;
  // "mcp" for connection-based MCP server extensions (no installPath, no
  // sandboxed subprocess — tools come from a live MCP `tools/list` call,
  // cached into `tools[]` as a boot-time cache).
  kind?: "local" | "mcp";

  // Component declarations (all optional -- empty package is valid)
  entrypoint?: string; // Main MCP/tool server entrypoint (for tools[])
  persistent?: boolean;
  tools?: ToolDefinition[];
  skills?: SkillDefinition[];
  mcpServers?: McpServerDefinition[];
  agent?: AgentComponentDefinition;
  scripts?: ScriptDefinition;

  // Panel configuration for UI display
  panel?: {
    position: "bottom";
    stateSchema?: Record<string, unknown>;
    defaultCollapsed?: boolean;
  };

  // Lifecycle hooks this extension subscribes to
  lifecycleHooks?: string[];

  /**
   * MIME types this extension can ingest as user-uploaded attachments.
   *
   * When the extension is wired into a conversation (via `!ext:<name>` or
   * auto-attach), these MIMEs are unioned into the chat composer's
   * accept list and a generic "extension-handle-only" delivery strategy
   * is used: the LLM sees a `<file handle="ez-attachment://<id>" />`
   * reference rather than the file body, and the extension's own tools
   * read the bytes on demand by passing the handle (the runtime
   * substitutes it to a `data:` URI before tool dispatch).
   *
   * This keeps format-specific parsing logic (xlsx, docx, etc.) out of
   * core. Each entry must be a fully-qualified MIME type string.
   */
  acceptedAttachmentMimes?: string[];

  // Dependencies on other extensions
  dependencies?: Record<string, DependencySpec>;

  // Package-level metadata
  permissions: {
    network?: string[];
    filesystem?: string[];
    shell?: boolean;
    env?: string[];
    lifecycleHooks?: boolean; // requires user approval
    storage?: boolean; // persistent key-value storage
    // ── Capability tier (Phase 2+). Gated by EZCORP_DISABLE_CAPABILITY_TOOLS ──
    /** Emit `task:snapshot` / `task:assignment_update` bus events via
     *  `ezcorp/emit-task-event` reverse RPC. Conversation scope is forced
     *  by the host — extensions cannot target other conversations. */
    taskEvents?: boolean;
    /** Spawn sub-agent runs via `ezcorp/spawn-assignment`. Requires both
     *  fields when declared. Credentials are INHERITED from the parent
     *  conversation — installing this permission authorizes billing to the
     *  installing user's provider credits, up to the declared quota. */
    spawnAgents?: { maxPerHour: number; maxConcurrent?: number };
    /** Read-only access to the caller's agent configs via
     *  `ezcorp/agent-configs`. "read" is the only value today; the enum
     *  leaves room for a future "write" tier without a schema break. */
    agentConfig?: "read";
    /** Subscribe to server→extension bus-event notifications (Phase 2c).
     *  Each string names a bus event type from the direct-carrier set
     *  (see `src/runtime/sse-conversation-filter.ts` —
     *  `DIRECT_CARRIER_EVENT_TYPES`). Delivery is ALWAYS gated on
     *  conversation-scope: an extension only receives events for
     *  conversations it's wired to via `conversation_extensions`. Unknown
     *  event names are silently filtered at clamp time. */
    eventSubscriptions?: string[];
  };

  // Resource limits for subprocess
  resources?: {
    memory?: string; // e.g. "512MB", "1GB"
    storage?: string; // e.g. "5MB", "50MB" — max quota for extension_storage
    /**
     * Per-tool-call timeout in ms. Default: 30_000 (30s). Raise for
     * long-running upstream calls — e.g. image generation typically
     * takes 30-120s, well past the default.
     */
    callTimeoutMs?: number;
  };

  // Marketplace metadata (optional for local installs)
  tags?: string[];
  changelog?: string;
  category?: string;
  checksum?: string;
  packageChecksums?: Record<string, string>;
}

// Backward compat alias -- plan 03 will clean up remaining usages
export type ExtensionManifest = ExtensionManifestV2;

// ── Package Type Inference ───────────────────────────────────────

export type ExtensionPackageType = "agent" | "extension";

export function inferPackageType(
  manifest: ExtensionManifestV2,
): ExtensionPackageType {
  const hasTools = (manifest.tools?.length ?? 0) > 0;
  const hasSkills = (manifest.skills?.length ?? 0) > 0;
  const hasMcp = (manifest.mcpServers?.length ?? 0) > 0;
  const hasScripts = manifest.scripts != null;
  const hasAgent = manifest.agent != null;

  // "agent" only if JUST an agent with no other components
  if (hasAgent && !hasTools && !hasSkills && !hasMcp && !hasScripts) {
    return "agent";
  }
  return "extension";
}

// ── Marketplace Types (moved from src/marketplace/types.ts) ──────

export const MARKETPLACE_CATEGORIES = [
  "Productivity",
  "Development",
  "Writing",
  "Research",
  "Education",
  "Creative",
  "Data & Analysis",
  "Communication",
  "Other",
] as const;

export type MarketplaceCategory = (typeof MARKETPLACE_CATEGORIES)[number];

export type ListingStatus = "active" | "flagged" | "removed";
export type FlagStatus = "pending" | "dismissed" | "removed";
export type MarketplaceSortOption = "rating" | "popular" | "newest";

// ── Extension Panel Component Vocabulary ────────────────────────

export type PanelComponentType = "header" | "text" | "badge" | "progress" | "status" | "list" | "kv" | "counter" | "divider";

export interface PanelHeader { type: "header"; title: string; subtitle?: string; }
export interface PanelText { type: "text"; content: string; variant?: "muted" | "default" | "emphasis"; }
export interface PanelBadge { type: "badge"; label: string; color?: "blue" | "green" | "red" | "yellow" | "purple" | "gray"; }
export interface PanelProgress { type: "progress"; value: number; label?: string; }
export interface PanelStatus { type: "status"; label: string; state: "idle" | "running" | "success" | "error" | "warning"; }
export interface PanelListItem { label: string; status?: "pending" | "active" | "completed" | "failed"; detail?: string; badge?: string; badgeColor?: PanelBadge["color"]; }
export interface PanelList { type: "list"; items: PanelListItem[]; }
export interface PanelKV { type: "kv"; pairs: { key: string; value: string }[]; }
export interface PanelCounter { type: "counter"; label: string; value: number; total?: number; }
export interface PanelDivider { type: "divider"; }

export type PanelComponent = PanelHeader | PanelText | PanelBadge | PanelProgress | PanelStatus | PanelList | PanelKV | PanelCounter | PanelDivider;

export interface ExtensionPanelState {
  title: string;
  collapsed?: boolean;
  components: PanelComponent[];
}

// ── JSON-RPC Notification (fire-and-forget, no id) ──────────────

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, unknown>;
}

// ── Permissions (granted at install time) ────────────────────────

export interface ExtensionPermissions {
  network?: string[];
  filesystem?: string[];
  shell?: boolean;
  env?: string[];
  storage?: boolean;
  // Capability tier — see ExtensionManifestV2.permissions for the full
  // contract + the Phase 2+3 plan (`.claude/plans/tranquil-dancing-book.md`).
  taskEvents?: boolean;
  spawnAgents?: { maxPerHour: number; maxConcurrent?: number };
  agentConfig?: "read";
  /** Subscribed bus-event types (Phase 2c). Clamped at install time to
   *  the intersection of manifest declaration and the direct-carrier
   *  allowlist. */
  eventSubscriptions?: string[];
  grantedAt: Record<string, number>; // permission key -> timestamp
}

// ── Installed Extension (DB + runtime representation) ────────────

export interface InstalledExtension {
  id: string;
  name: string;
  version: string;
  description: string;
  manifest: ExtensionManifestV2;
  source: string; // "github:user/repo@v1.0" or "local:/path"
  installPath: string;
  enabled: boolean;
  grantedPermissions: ExtensionPermissions;
  checksumVerified: boolean;
  consecutiveFailures: number;
  createdAt: Date;
  updatedAt: Date;
}

// ── JSON-RPC 2.0 ────────────────────────────────────────────────

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number | string;
  method: string;
  params?: Record<string, unknown>;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string | null;
  result?: unknown;
  error?: {
    code: number;
    message: string;
    data?: unknown;
  };
}

// ── Tool Call Result ─────────────────────────────────────────────

export interface ToolCallResult {
  content: Array<{ type: "text"; text: string }>;
  isError: boolean;
}
