// ── @ezcorp/sdk public types ────────────────────────────────────
// Public API surface for extension authors.
//
// Definitions below are duplicated from `src/extensions/types.ts` (host)
// pending the plan-line-192 host-shim flip — a team-lead-authorized
// change that will replace the host file with `export * from "@ezcorp/sdk"`.
// Until that lands, any change to a shared type MUST be made in BOTH
// places. Keep these two files byte-for-byte aligned for the overlapping
// declarations.

// ── V2 Component Definitions ─────────────────────────────────────

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>; // JSON Schema object
  cardType?: string; // Maps to frontend card component for custom rendering
  /**
   * When `true`, the host treats this tool as human-in-the-loop:
   * the subprocess JSON-RPC timeout race is skipped, and the watchdog
   * defers the idle kill for the duration of the call. Use only for
   * tools that explicitly block on a user reply (e.g. `ask_user_question`).
   * Default `false`.
   */
  requiresUserInput?: boolean;
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

// ── Settings Schema (user-editable extension config) ─────────────

export interface SettingsFieldSelect {
  type: "select";
  label: string;
  description?: string;
  options: { value: string; label: string }[];
  default?: string;
}

export interface SettingsFieldText {
  type: "text";
  label: string;
  description?: string;
  default?: string;
  minLength?: number;
  maxLength?: number;
  /** ECMAScript regex source. Validated server-side at admit time. */
  pattern?: string;
}

export interface SettingsFieldNumber {
  type: "number";
  label: string;
  description?: string;
  default?: number;
  min?: number;
  max?: number;
  step?: number;
  /** When true, only integers are accepted. */
  integer?: boolean;
}

export interface SettingsFieldBoolean {
  type: "boolean";
  label: string;
  description?: string;
  default?: boolean;
}

export type SettingsField =
  | SettingsFieldSelect
  | SettingsFieldText
  | SettingsFieldNumber
  | SettingsFieldBoolean;

/** Map of setting key → field declaration. Keys must match
 *  /^[a-z][a-z0-9_]{0,63}$/ (filesystem-safe identifier). */
export type SettingsSchema = Record<string, SettingsField>;

// ── Extension Manifest V2 ────────────────────────────────────────

// `entities` is re-imported from `@ezcorp/sdk/entities` so the same
// `EntityDeclaration` shape is used by extension authors (in
// `ezcorp.config.ts`) AND by the host's manifest validator. Keeping
// the import here (rather than re-declaring the interface) means
// schema/seed/preview shape changes in one place propagate to both
// sides — see `packages/@ezcorp/sdk/src/entities/types.ts`.
import type { EntityDeclaration } from "./entities/types";

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
   */
  acceptedAttachmentMimes?: string[];

  /**
   * User-editable configuration declared by the extension. The host renders
   * a form on the extension detail page, persists per-user + global values,
   * and injects the resolved map into tool calls. Keys must be filesystem-safe
   * identifiers; field declarations are validated at admit time.
   */
  settings?: SettingsSchema;

  /**
   * User-managed entity types declared by the extension. The host
   * auto-generates 5 CRUD tools per declaration
   * (`list_<plural>`, `get_<sing>`, `create_<sing>`, `update_<sing>`,
   * `delete_<sing>`), validates writes against the JSON Schema, and
   * renders an auto-table on the extension detail page. Records live
   * in the reserved storage namespace `__entity:<type>:<slug>` plus an
   * index at `__entity-index:<type>` — extensions may not write those
   * keys directly. See `@ezcorp/sdk/entities` for the
   * `EntityDeclaration` shape.
   */
  entities?: EntityDeclaration[];

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
    /** Emit task-panel bus events via ezcorp/emit-task-event. The host
     *  forces conversationId — extensions cannot target other conversations. */
    taskEvents?: boolean;
    /** Spawn sub-agent runs via ezcorp/spawn-assignment. Requires both
     *  fields when declared; credentials inherit from the parent conversation. */
    spawnAgents?: { maxPerHour: number; maxConcurrent?: number };
    /** Read-only access to the caller's agent configs via ezcorp/agent-configs. */
    agentConfig?: "read";
    /** Subscribe to server→extension bus-event notifications (Phase 2c).
     *  Each string names a bus event type from the 13 direct-carrier events
     *  — delivery is conversation-scoped to the `conversation_extensions`
     *  wiring. Unknown names are filtered at clamp time. */
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

  /**
   * Deterministic acceptance smoke test. OPTIONAL in the base validator;
   * REQUIRED via the author path for `tool`/`multi`. `ezcorp ext verify`
   * spins the extension up in a sandbox, calls `tool` with `input`, and
   * asserts the result against `expect`. `tool` must be a declared tool.
   */
  smokeTest?: {
    tool: string;
    input: Record<string, unknown>;
    expect: { isError?: boolean; textIncludes?: string };
  };

  // Marketplace metadata (optional for local installs)
  tags?: string[];
  changelog?: string;
  category?: string;
  checksum?: string;
  packageChecksums?: Record<string, string>;
}

// ── Permissions (granted at install time) ────────────────────────

export interface ExtensionPermissions {
  network?: string[];
  filesystem?: string[];
  shell?: boolean;
  env?: string[];
  storage?: boolean;
  grantedAt: Record<string, number>; // permission key -> timestamp
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
