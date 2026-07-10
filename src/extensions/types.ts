// `entities` is re-imported from `@ezcorp/sdk/entities` so the host
// validator and the SDK-side manifest type stay in lockstep — same
// `EntityDeclaration` shape on both sides. See the duplicated-types
// comment in `packages/@ezcorp/sdk/src/types.ts:5-9` for the broader
// rule; entities is the first field that opts for the single-source-
// of-truth `import` pattern rather than the copy-paste pattern.
import type { EntityDeclaration } from "@ezcorp/sdk/entities";

// ── V2 Component Definitions ─────────────────────────────────────

/**
 * Per-tool capability declaration (Phase 1, manifest schemaVersion 3).
 *
 * Tools opt into specific runtime capabilities here; the host's PDP
 * (`./permission-engine.ts`) intersects the declaration with the
 * extension-wide grant at every tool call. v2 manifests auto-promote
 * via `migrateManifestV2ToV3`: each tool inherits the extension-wide
 * ceiling, and the result is flagged `_inheritedFromV2: true` so the
 * audit log can distinguish authored vs inherited declarations.
 *
 * `custom` accepts namespaced capability names (e.g. `ezcorp:chat:append`)
 * for caps that don't fit the network/fs/shell/env/storage primitives.
 * Phase 6 will migrate the legacy boolean fields (`appendMessages`,
 * `agentConfig`, `taskEvents`, `spawnAgents`, `eventSubscriptions`) onto
 * this surface.
 */
export interface CapabilityDeclaration {
  network?: { hosts: string[] };
  filesystem?: { paths: string[]; mode: ("read" | "write")[] };
  shell?: boolean;
  env?: string[];
  storage?: boolean;
  custom?: Record<string, string[] | boolean>;
}

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
  /**
   * When `true`, the host treats this tool as human-in-the-loop:
   * the subprocess JSON-RPC timeout race is skipped, and the watchdog
   * defers the idle kill for the duration of the call. Use only for
   * tools that explicitly block on a user reply (e.g. `ask_user_question`).
   * Default `false`.
   */
  requiresUserInput?: boolean;
  /**
   * Per-tool capability declaration (Phase 1, manifest v3 only).
   *
   * Optional on v2 manifests — `migrateManifestV2ToV3` synthesizes a
   * declaration from the extension-wide `permissions` block when this
   * field is absent. The PDP uses the FINAL post-migration value.
   */
  capabilities?: CapabilityDeclaration;
  /**
   * Extension-RBAC scope (user→extension axis) REQUIRED to invoke this
   * tool. When set, the host enforces it at dispatch: the acting user
   * must hold the scope — an explicit `extension_rbac_grants` row, or the
   * admin role — at the calling conversation's project, else the call is
   * DENIED before the subprocess runs (`PermissionDeniedError`). This is
   * the ENFORCEMENT counterpart to the advisory `ctx.rbac.check(scope)`
   * reverse-RPC: an extension can no longer bypass a denied scope by
   * ignoring the check result. Complementary to `capabilities` (what the
   * EXTENSION may do); this governs whether the USER may drive it.
   *
   * The value must be a core verb (use / configure / secrets /
   * approve-runs / manage) or a custom scope this manifest declares in
   * `permissions.rbacScopes` — validated at admit time. Absent = the tool
   * carries no user→extension gate (unchanged behavior).
   */
  rbacScope?: string;
}

export interface SkillDefinition {
  name: string;
  description: string;
  prompt?: string;
  files?: string[]; // Paths relative to package root
}

/**
 * Deterministic attachment preprocessor declaration (top-level manifest
 * field, schemaVersion 2 AND 3).
 *
 * When a user message carries attachments and this extension is wired to
 * the conversation (mention or prior wiring), the host invokes `tool`
 * deterministically — no LLM decision — once per matching attachment
 * BEFORE the assistant turn, with input
 * `{ attachment: "ez-attachment://<id>", filename, mimeType }` (the
 * handle resolves to a `data:<mime>;base64,` URI through the same
 * resolver LLM tool calls use). Results persist as `preprocess-result`
 * message rows and ground the LLM via a per-result system note.
 *
 * `tool` MUST name a tool declared in this manifest's `tools[]` —
 * validated at admit time by `validatePreprocessorsArray`
 * (./manifest.ts). `accepts` is a non-empty list of exact MIME strings
 * or `type/*` globs (e.g. `image/*`). No new permission axis: the
 * referenced tool runs under the extension's EXISTING granted
 * permissions and the PDP still gates inside `executeToolCall`.
 */
export interface PreprocessorDecl {
  tool: string;
  accepts: string[];
  description?: string;
}

export type McpTransport = "stdio" | "http" | "sse";

export interface McpServerStdio {
  transport: "stdio";
  name: string;
  description?: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Phase 55 / MCP-03: pre-opened raw FD pointing at the compiled
   * seccomp BPF blob. The transport caller passes this into Bun.spawn's
   * `stdio` array at index 3 (FD-passthrough); the launcher reads
   * `$EZCORP_MCP_BWRAP_SECCOMP_FD=3` and appends `--seccomp 3` to its
   * inner `bwrap` exec line. Parent MUST close the FD after spawn
   * returns. Null when the BPF is unavailable (dev hosts, kill-switch
   * active, etc.) — in that case the launcher silently runs without
   * the profile. Populated by `mcp-sandbox.ts:buildSandboxedMcpSpec()`.
   */
  seccompFd?: number | null;
  /**
   * Phase 58 / MCP-05: post-spawn hook invoked by McpClient AFTER the
   * SDK transport spawns the child process but BEFORE the JSON-RPC
   * `initialize` handshake. Used by Stage 2 to:
   *   1. Move the namespace-side veth peer into the child's netns via
   *      `ip link set <ns-side> netns <pid>`.
   *   2. Release the launcher's `read -n 1` handshake by writing a
   *      single byte to the child's stdin.
   *
   * Awaited — Open Question 1 lock: skipping the await opens a TOCTOU
   * race against the launcher's `ip addr add eth0 ...`. Wired from
   * `mcp-sandbox.ts:buildSandboxedMcpSpec()` when Stage 2 is active.
   * The `writeByte` callback abstracts the actual stdin write so the
   * caller (McpClient) decides how to reach the child's stdin without
   * coupling mcp-sandbox to the @modelcontextprotocol/sdk transport
   * internals.
   */
  onChildSpawned?: (pid: number, writeByte: (b: number) => Promise<void>) => Promise<void>;
  /**
   * Phase 58 / MCP-05: opaque carrier for the per-spawn veth allocation
   * — `_internal_` prefix signals "do not consume from outside the
   * registry callsite; subject to change." Read by `registry.ts` on
   * both the connect-failure tear-down path AND the happy-path
   * child-exited handler to release the slot + delete the host-side
   * veth. Null when Stage 2 is inactive (no veth setup happened).
   */
  _internal_vethSetup?: {
    slot: number;
    vethId: string;
    hostSideName: string;
    nsSideName: string;
    vethIpv4: string;
  } | null;
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

/**
 * Per-turn action icon contributed by an extension. Rendered in
 * `MessageToolbar.svelte` between the exclude and save-to-memory buttons.
 *
 * Click handler in the host posts to the existing extension event route
 * (`/api/extensions/<name>/events/<event>`) with
 * `{ messageId, conversationId, content, selection }`. The selection is
 * captured via `window.getSelection()` and clamped to the source row's
 * DOM (so highlighting in another row doesn't leak).
 *
 * `event` MUST be prefixed with the extension's `name:` (mirrors the
 * dispatcher rule in `event-subscription-dispatcher.ts:registerExtension`),
 * AND the extension MUST also list this event under
 * `permissions.eventSubscriptions` — toolbar contributions are gated by
 * the same allowlist as canvas-card events.
 */
export interface MessageToolbarItem {
  /** Unique id within the extension. Lowercase letters, digits, hyphens. */
  id: string;
  /** lucide-svelte icon name, e.g. "Volume2". */
  icon: string;
  /** Tooltip text shown on hover. */
  tooltip: string;
  /** Which message roles this icon should appear on. Default `"both"`. */
  appliesTo?: "user" | "assistant" | "both";
  /**
   * Whether this contribution participates in the multi-select bulk
   * action bar (`SelectModeActionBar.svelte`) in addition to / instead
   * of the per-message hover toolbar.
   *
   *   - `"single"` (default) — appears only on the per-message hover
   *     toolbar. Click POSTs `{ conversationId, messageId, content,
   *     selection }`.
   *   - `"bulk"`  — appears only in the multi-select bar. Click POSTs
   *     `{ conversationId, messageIds: string[], content }` where
   *     `content` is the concatenated content of the selected turns
   *     (no `selection` — bulk has no single highlight).
   *   - `"both"`  — appears in both. Single-row clicks send the
   *     single-id payload; bulk clicks send the array payload.
   *
   * The host route (`/api/extensions/[name]/events/[event]`) accepts
   * EITHER `messageId` OR `messageIds[]` for messageToolbar events,
   * so an extension only needs to handle whichever shapes match the
   * `appliesToSelection` modes it opts into. Default `"single"`
   * preserves the original behavior for existing manifests.
   */
  appliesToSelection?: "single" | "bulk" | "both";
  /** Event name in this extension's namespace, e.g. "kokoro-tts:speak". */
  event: string;
}

/**
 * Hub page contributed by an extension (Extension Pages Hub).
 *
 * Each declared page becomes a tab at `/hub/ext:<name>:<id>`, rendered
 * from a declarative component tree the extension serves over
 * `ezcorp/page.render` (and may push via `ezcorp/page-state`).
 * Declaring a page IS the grant — surfaced at install/detail UI like
 * other components; there is NO separate permission key, so bundled
 * extensions adopting a page cause no grantedPermissions drift. Page
 * actions reuse `permissions.eventSubscriptions` (the tree validator
 * drops action nodes whose event isn't declared there).
 */
export interface ExtensionPageDeclaration {
  /** Unique id within the extension. /^[a-z0-9][a-z0-9-]{0,31}$/ */
  id: string;
  /** Tab label. ≤ 50 chars. */
  title: string;
  /** lucide-svelte icon name, e.g. "Clock". Unknown names fall back. */
  icon?: string;
  /** ≤ 200 chars. */
  description?: string;
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

// ── Extension Manifest V2/V3 ──────────────────────────────────────
//
// Phase 1 introduces v3, which adds optional per-tool `capabilities` on
// `ToolDefinition`. The structural shape of the manifest itself is
// unchanged — only the `schemaVersion` literal widens to `2 | 3`. The
// validator (`./manifest.ts`) still gates which version is accepted.
//
// Loaders run `migrateManifestV2ToV3` after validation so every
// downstream consumer (registry, tool-executor, PDP) sees v3 shape
// regardless of the manifest's authored version.

export interface ExtensionManifestV2 {
  schemaVersion: 2 | 3;
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

  /**
   * Deterministic attachment preprocessors. Each entry names a declared
   * tool the host runs automatically on matching attachments before the
   * assistant turn — see {@link PreprocessorDecl} for the full contract.
   */
  preprocessors?: PreprocessorDecl[];

  /**
   * Per-turn action icons contributed to `MessageToolbar`. Each item must
   * declare an event that is also present in
   * `permissions.eventSubscriptions` (the same dispatcher allowlist used
   * by canvas-card events). See `MessageToolbarItem`.
   */
  messageToolbar?: MessageToolbarItem[];

  /**
   * Hub pages contributed by this extension (max 3). See
   * `ExtensionPageDeclaration`. Validated by `validatePagesArray`
   * (./manifest.ts) at admit time.
   */
  pages?: ExtensionPageDeclaration[];

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
     *  event names are silently filtered at clamp time.
     *
     *  Phase 51.4 added the object form
     *  `{events: string[], includeFullPayload?: boolean}`. When
     *  `includeFullPayload: true`, the dispatcher does NOT strip the
     *  heavy `input`/`output` blobs from `tool:start` /
     *  `tool:complete` payloads. Default false. */
    eventSubscriptions?: string[] | { events: string[]; includeFullPayload?: boolean };
    /** Author turns directly via the `ezcorp/append-message` reverse RPC.
     *  Conversation scope is forced by the host (the extension cannot
     *  target another conversation). The host always forces the new
     *  message's `excluded` flag to `true` regardless of what the
     *  extension passes in `excludedDefault`; the field is reserved for
     *  a future opt-in tier. Pairs naturally with `messageToolbar`
     *  (toolbar click → subprocess gets event → calls append-message). */
    appendMessages?: { excludedDefault: boolean };

    // ── Phase 51 capability surfaces ────────────────────────────────
    /** Brokered LLM access via `ctx.llm.complete()`. The token NEVER
     *  crosses the JSON-RPC boundary in either direction — the host
     *  resolves credentials and calls `pi-ai`'s `complete()` directly,
     *  returning ONLY the result. */
    llm?: {
      providers: string[];
      maxCallsPerHour?: number;
      maxCallsPerDay?: number;
      maxTokensPerCall?: number;
      maxTokensPerDay?: number;
      maxTimeoutMs?: number;
      allowedModels?: Record<string, string[]>;
      maxCostCentsPerDay?: number;
    };
    /** Read/write access to the user's memory store via `ctx.memory`.
     *  Extension-authored memories are stamped with provenance and
     *  default to `injectionEligible: false` so they don't auto-inject
     *  into LLM system prompts. `selfOnly: true` (the default) keeps
     *  reads scoped to memories this extension itself authored. */
    memory?: {
      access: "read" | "write";
      maxWritesPerDay?: number;
      categories?: ("preferences" | "biographical" | "technical" | "decisions_goals")[];
      selfOnly?: boolean;
    };
    /** Read/write access to the lessons corpus via `ctx.lessons`.
     *  `maxVisibility` is clamped to user|project (no global). Slug
     *  uniqueness composite includes the author extension so two
     *  extensions can share a slug for the same user. */
    lessons?: {
      access: "read" | "write";
      maxWritesPerDay?: number;
      maxVisibility?: "user" | "project";
    };
    /** Persistent cron schedules via `ctx.schedule`. All crons are
     *  declared in the manifest (max 8, min 5-min interval). The daemon
     *  enforces `maxRunsPerDay`, `maxRunDurationMs`, and the missed-run
     *  policy. `at-most-once` delivery is the default — extensions
     *  opt into at-least-once via `maxRetries > 0`. */
    schedule?: {
      crons: string[];
      maxRunsPerDay?: number;
      maxRunDurationMs?: number;
      missedRunPolicy?: "skip" | "fire-once" | "fire-all";
      maxRetries?: number;
      purpose?: string;
    };
    /** Brokered web search + URL read via `ctx.search`. The provider
     *  chain (SearXNG / DuckDuckGo / BYOK) runs HOST-side behind the
     *  SSRF egress guard — the extension never fetches a search backend
     *  itself. A bundled extension may declare the §3.1 three-state shape
     *  directly (`"inherit"` = full grant / track instance defaults,
     *  `false` = opt out, or an object of per-field upper bounds the
     *  Phase-2 resolver clamps against). The install/grant-time override
     *  (`grantedPermissions.search`) carries the same three states. */
    search?:
      | "inherit"
      | false
      | {
          /** Per-day call quota ceiling (Phase 2 enforces; Phase 1 records). */
          quota?: number;
          /** Default max results per search. */
          maxResults?: number;
          /** Allowed provider names, or `"inherit"` to track the instance
           *  default. Intersected with the KNOWN provider list at clamp time. */
          providers?: string[] | "inherit";
        };
    /**
     * Custom RBAC scopes this extension DECLARES (extension-RBAC layer,
     * user→extension axis). Declarations, NOT privileges: each entry
     * names a per-extension scope that (a) appears as a grantable
     * option in the admin grant UI and (b) extension code can query
     * via `ctx.rbac.check(name)` (`ezcorp/rbac-check` reverse-RPC).
     * Holding a scope always requires an explicit
     * `extension_rbac_grants` row (or the admin role) — declaring one
     * confers nothing by itself, so the bundled ceiling passes these
     * through un-clamped (see `bundled-ceiling.ts`) and grants never
     * carry them (`intersectPermissions` drops unknown keys).
     *
     * Names are implicitly namespaced per-extension, must match
     * `/^[a-z][a-z0-9-]*$/`, must NOT collide with the core verbs
     * (use / configure / secrets / approve-runs / manage), must be
     * unique, and `description` is required (it is what the grant UI
     * shows). Max 16 entries. Validated at admit time by
     * `validateRbacScopeDeclarations` (`src/extensions/rbac-scopes.ts`)
     * via `validatePermissionsBlock`.
     */
    rbacScopes?: Array<{ name: string; description: string }>;
    /**
     * Custom capability bag for reverse-RPCs that don't fit the
     * primary permission shape. Each key is a sub-capability namespace
     * (e.g. `drafts`); the value is a free-form record interpreted by
     * the corresponding handler.
     *
     * As of v1.4 the only registered key is `drafts`, used by the
     * bundled `extension-author` extension's `ezcorp/drafts` reverse-
     * RPC. Bundled-only — `BUNDLED_DRAFTS_ALLOWLIST` in
     * `drafts-handler.ts` enforces the bundled gate independent of
     * what user-installed manifests may declare.
     */
    custom?: {
      drafts?: { kinds: string[] };
      [key: string]: unknown;
    };
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
   * Deterministic acceptance smoke test. OPTIONAL in `validateManifestV2`
   * (the 47 existing bundled extensions stay valid) — REQUIRED only via
   * the author path (scaffold + `validate_extension` + author install
   * endpoint) for `tool`/`multi` kinds.
   *
   * `ezcorp ext verify` (and the author install endpoint) spin the
   * extension up in a sandbox, call `tool` with `input`, and assert the
   * result against `expect`. This is the machine-checked PASS artifact
   * that replaces self-judged "installed/enabled" — root-cause fix #2 of
   * the harness-smoke-test loop incident.
   *
   * `tool` MUST be one of the manifest's declared tool names
   * (cross-checked by `validateSmokeTest`).
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
  /** Algorithm version the `packageChecksums` baseline was recorded with
   *  (`"v2"` = dotfiles hashed). Absent on pre-versioning installs, which
   *  are verified in legacy (no-dotfile) mode. */
  packageChecksumsAlgo?: string;

  // ── Phase 4 deputy / orchestration opt-in flags ───────────────────
  /**
   * When `true`, this extension's tools accept caller capabilities via
   * `ezcorp/invoke` and run with `intersect(callerCaps, ownCaps)`.
   * Default `false` — pre-Phase-4 behavior, callee runs with its own
   * caps as-is. Bundled "deputy" extensions (e.g. ai-kit) opt in;
   * the install-time UI surfaces the elevated-trust nature.
   *
   * The runtime check is `=== true` — v2 manifests that don't carry
   * this field are treated as opted-out.
   *
   * Granted at install time on the `extensions.grantedPermissions`
   * blob — the runtime consults the GRANT, not the manifest. A
   * manifest declaring `acceptsCallerCaps: true` without user consent
   * is treated as if the flag were absent.
   */
  acceptsCallerCaps?: boolean;
  /**
   * When `true`, this extension's `ezcorp/spawn-assignment` calls do
   * NOT cap the child conversation by parent capabilities. The child
   * runs with its own agent-config-declared caps (still intersected
   * with the child manifest's declared permissions). Default `false`
   * — child caps are clipped by `intersect(parentGrants,
   * childManifestPerms)`. Only orchestration extensions whose entire
   * purpose is delegation should set this; the install-time UI
   * requires explicit consent.
   *
   * Like `acceptsCallerCaps`, the runtime consults the GRANT (not the
   * manifest) so a manifest without user consent is treated as
   * opted-out.
   */
  escalateChildCaps?: boolean;
}

// Backward compat alias -- plan 03 will clean up remaining usages
export type ExtensionManifest = ExtensionManifestV2;

/**
 * Internal manifest shape after `migrateManifestV2ToV3` runs. Only the
 * loader / registry produce this — extension authors never write
 * `_inheritedFromV2` themselves. The flag drives audit-log
 * disambiguation between authored v3 declarations and v2-inherited
 * ones.
 */
export interface ExtensionManifestInternal extends ExtensionManifestV2 {
  _inheritedFromV2?: boolean;
}

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

// ── Extension Pages Hub — page component vocabulary ─────────────
//
// Defined in `./page-schema.ts` (vocabulary + hand-rolled validator);
// re-exported here so consumers that already import panel types from
// this module get the page types from the same place. Type-only
// re-export — `validatePageTree` itself is imported from page-schema
// directly to keep this module value-free for the wire types.

export type {
  HubPageTree,
  PageNode,
  PageOnlyNode,
  PageAction,
  PageSection,
  PageHeading,
  PageMarkdown,
  PageStats,
  PageStatItem,
  PageTable,
  PageTableRow,
  PageButton,
  PageLink,
  PageEmptyState,
} from "./page-schema";

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
  /** Grants the `ezcorp/append-message` reverse RPC. See the matching
   *  field on `ExtensionManifestV2.permissions`. */
  appendMessages?: { excludedDefault: boolean };
  /**
   * Phase 4 deputy/orchestration opt-in flags persisted on install.
   * Mirrors the manifest declaration of the same names — the runtime
   * check is `=== true`. The user MUST consent at install time for
   * either to be honored at runtime; absence on either side defaults
   * to "opted-out".
   */
  acceptsCallerCaps?: boolean;
  escalateChildCaps?: boolean;

  // ── Phase 51 capability surfaces (granted = clamped manifest) ───
  llm?: {
    providers: string[];
    maxCallsPerHour: number;
    maxCallsPerDay: number;
    maxTokensPerCall?: number;
    maxTokensPerDay?: number;
    maxTimeoutMs?: number;
    allowedModels?: Record<string, string[]>;
    maxCostCentsPerDay?: number;
  };
  memory?: {
    access: "read" | "write";
    maxWritesPerDay: number;
    categories?: ("preferences" | "biographical" | "technical" | "decisions_goals")[];
    selfOnly: boolean;
  };
  lessons?: {
    access: "read" | "write";
    maxWritesPerDay: number;
    maxVisibility: "user" | "project";
  };
  schedule?: {
    crons: string[];
    maxRunsPerDay: number;
    maxRunDurationMs: number;
    missedRunPolicy: "skip" | "fire-once" | "fire-all";
    maxRetries: number;
  };
  /**
   * Brokered search grant — the §3.1 three-state shape:
   *   - `"inherit"`  → use the live instance defaults (Phase 2 resolver).
   *                    Storing the literal (not a snapshot) means changing
   *                    an instance default propagates to all inheritors.
   *   - `{…}`        → explicit per-field override (admin-gated, instance-
   *                    wide — it's a security bound, NOT a per-user pref).
   *                    Partial overrides are field-level-merged over the
   *                    instance defaults (Phase 2).
   *   - `false`      → search disabled for this extension (handler denies).
   *
   * Phase 1 only distinguishes `false` (deny) from everything-else
   * (allow with code defaults); the full field-level resolver + quota
   * enforcement is Phase 2.
   */
  search?:
    | "inherit"
    | false
    | {
        quota?: number;
        maxResults?: number;
        providers?: string[] | "inherit";
      };
  /**
   * Custom capability bag — granted form mirrors the manifest shape.
   * The host does NOT clamp `custom` today (the `drafts` capability is
   * bundled-only and gated by `BUNDLED_DRAFTS_ALLOWLIST`). User-
   * installed extensions may declare `custom.*` in their manifest, but
   * unknown keys have no semantic effect.
   */
  custom?: {
    drafts?: { kinds: string[] };
    [key: string]: unknown;
  };

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
