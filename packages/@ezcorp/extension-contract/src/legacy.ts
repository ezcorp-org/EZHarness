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

/**
 * Per-tool capability declaration (Phase 1, manifest schemaVersion 3).
 *
 * Tools opt into specific runtime capabilities here; the host's PDP
 * intersects the declaration with the extension-wide grant at every tool
 * call. v2 manifests auto-promote via `migrateManifestV2ToV3`: each tool
 * inherits the extension-wide ceiling, and the result is flagged
 * `_inheritedFromV2: true` so the audit log can distinguish authored vs
 * inherited declarations.
 *
 * `custom` accepts namespaced capability names (e.g. `ezcorp:chat:append`)
 * for caps that don't fit the network/fs/shell/env/storage primitives.
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
   * Example user phrasings that should surface THIS tool in the composer
   * suggestion popover. Phrase each entry the way a user would ask — do NOT
   * restate `description`. Entries are embedded verbatim and matched
   * query↔example against the live draft, so authored examples improve
   * retrieval immediately and also seed the offline training export. Caps:
   * at most 5 entries, each 1..120 chars after trimming, no duplicates.
   * NEVER shown to the LLM (stripped before the tool spec is built).
   */
  suggestExamples?: string[];
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
   * must hold the scope (an explicit grant, or the admin role) at the
   * calling conversation's project, else the call is DENIED before the
   * subprocess runs. This is the ENFORCEMENT counterpart to the advisory
   * `ctx.rbac.check(scope)` — declaring it here means the host guarantees
   * the check, so extension code cannot bypass a denied scope.
   *
   * Must be a core verb (use / configure / secrets / approve-runs /
   * manage) or a custom scope declared in `permissions.rbacScopes`.
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
 * validated at admit time. `accepts` is a non-empty list of exact MIME
 * strings or `type/*` globs (e.g. `image/*`). No new permission axis:
 * the referenced tool runs under the extension's EXISTING granted
 * permissions and the host's PDP still gates every call.
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

/** Write-only secret (API token, credential). The value is NEVER stored in
 *  the settings JSON blob — the host encrypts it (same cipher path as the
 *  storage RPC's `encrypted: true`) and writes it to extension storage at
 *  `(extensionId, scope: "user", scopeId: <saving user>, key: storageKey)`,
 *  so your extension reads it through its existing SDK Storage surface
 *  (`new Storage("user")` + `storage.get(storageKey)`). Implicitly
 *  PER-USER; no `default` (secrets have none). */
export interface SettingsFieldSecret {
  type: "secret";
  label: string;
  description?: string;
  /** Extension-storage key the encrypted value is written to. Must match
   *  /^[a-z0-9][a-z0-9_.-]{0,63}$/ with no trailing dot (the storage RPC
   *  rejects dot-terminated keys on read). REQUIRED (and forbidden on all
   *  other field types). */
  storageKey: string;
}

export type SettingsField =
  | SettingsFieldSelect
  | SettingsFieldText
  | SettingsFieldNumber
  | SettingsFieldBoolean
  | SettingsFieldSecret;

/** Map of setting key → field declaration. Keys must match
 *  /^[a-z][a-z0-9_]{0,63}$/ (filesystem-safe identifier). */
export type SettingsSchema = Record<string, SettingsField>;

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
 * `event` MUST be prefixed with the extension's `name:`, AND the extension
 * MUST also list this event under `permissions.eventSubscriptions` —
 * toolbar contributions are gated by the same allowlist as canvas-card
 * events.
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
   * action bar in addition to / instead of the per-message hover toolbar.
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
   * The host route accepts EITHER `messageId` OR `messageIds[]` for
   * messageToolbar events, so an extension only needs to handle whichever
   * shapes match the `appliesToSelection` modes it opts into. Default
   * `"single"` preserves the original behavior for existing manifests.
   */
  appliesToSelection?: "single" | "bulk" | "both";
  /** Event name in this extension's namespace, e.g. "kokoro-tts:speak". */
  event: string;
}

// ── Hub Pages (Extension Pages Hub) ──────────────────────────────

/**
 * Hub page contributed by an extension. Each declared page becomes a
 * tab at `/hub/ext:<name>:<id>`, served by a `definePage({id, render,
 * actions})` registration (see `@ezcorp/sdk/runtime`'s `definePage` /
 * `PageBuilder` / `pushPage`). Declaring a page IS the grant — no
 * separate permission key. Page actions reuse
 * `permissions.eventSubscriptions`.
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
  /** Opt into project-aware renders: on `/project/<id>/hub/...` the
   *  page's `render` receives `{ project }`; on the global hub it
   *  receives `{ projects }` (the full list) for an overview/home view.
   *  See `PageRenderContext` in `runtime/page.ts`. */
  perProject?: boolean;
}

// ── Extension Manifest V2 ────────────────────────────────────────

// `entities` is re-imported from `@ezcorp/sdk/entities` so the same
// `EntityDeclaration` shape is used by extension authors (in
// `ezcorp.config.ts`) AND by the host's manifest validator. Keeping
// the import here (rather than re-declaring the interface) means
// schema/seed/preview shape changes in one place propagate to both
// sides — see `packages/@ezcorp/sdk/src/entities/types.ts`.
import type { EntityDeclaration } from "./entities";

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
   * User-editable configuration declared by the extension. The host renders
   * a form on the extension detail page, persists per-user + global values,
   * and injects the resolved map into tool calls. Keys must be filesystem-safe
   * identifiers; field declarations are validated at admit time.
   */
  settings?: SettingsSchema;

  /**
   * Hub pages contributed by this extension (max 3). See
   * `ExtensionPageDeclaration`.
   */
  pages?: ExtensionPageDeclaration[];

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

  /**
   * Third-party npm packages this extension imports at runtime — npm
   * REGISTRY package name → semver RANGE. Distinct from `dependencies`
   * (which are OTHER EZCorp extensions): these are ordinary npm modules
   * resolved from the host app's `node_modules` (or vendored under the
   * extension dir) at spawn time. NOT auto-installed in v1 — only
   * VERIFIED at install/activate/boot/spawn; the packages must already
   * exist in the deployment.
   */
  npmDependencies?: Record<string, string>;

  /**
   * Example user phrasings that should surface this EXTENSION as a whole in
   * the composer suggestion popover — for intent that spans the extension
   * rather than any single tool (e.g. "help me clean up my downloads
   * folder"). Same phrasing guidance and caps as the per-tool
   * `ToolDefinition.suggestExamples` (≤ 5 entries, 1..120 chars trimmed, no
   * duplicates). NEVER shown to the LLM.
   */
  suggestExamples?: string[];

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
    /** Emit the content-free loop-approval nudges (loops:approval_pending /
     *  loops:approval_resolved / loops:auto_disabled) via
     *  ezcorp/emit-loop-event (Loops EZ Mode Phase 2). Distinct from
     *  taskEvents: loop nudges fire ownerless and may broadcast globally, so
     *  they carry their own least-privilege gate. The host stamps the wire
     *  loopId with the emitting extension's id so an extension can only emit
     *  for its own loops. */
    loopEvents?: boolean;
    /** Spawn sub-agent runs via ezcorp/spawn-assignment. Requires both
     *  fields when declared; credentials inherit from the parent conversation. */
    spawnAgents?: { maxPerHour: number; maxConcurrent?: number };
    /** Read-only access to the caller's agent configs via ezcorp/agent-configs. */
    agentConfig?: "read";
    /** Subscribe to server→extension bus-event notifications (Phase 2c).
     *  Each string names a bus event type from the 13 direct-carrier events
     *  — delivery is conversation-scoped to the `conversation_extensions`
     *  wiring. Unknown names are filtered at clamp time.
     *
     *  Phase 51.4 added the object form
     *  `{events: string[], includeFullPayload?: boolean}`. When
     *  `includeFullPayload: true`, the dispatcher does NOT strip the
     *  heavy `input`/`output` blobs from `tool:start` /
     *  `tool:complete` payloads. Default false. */
    eventSubscriptions?: string[] | { events: string[]; includeFullPayload?: boolean };
    /** Receive inbound HTTP webhook deliveries (Loops EZ Mode Phase 4). Each
     *  string is a hook `slug`; the host mints a per-hook secret at install and
     *  routes an authenticated `POST /api/hooks/:extensionId/:slug` onto the
     *  loop delivery queue only for declared slugs. Webhook bodies are
     *  attacker-controllable, so a webhook-triggered loop is permanently
     *  `untrusted-input`. Undeclared slugs are dropped at install. */
    webhooks?: string[];
    /** Envelope for DYNAMIC cron + webhook triggers created at runtime via
     *  `ctx.triggers` (C2). Deliberately a SEPARATE key from `webhooks`
     *  above, which is a bare `string[]` of fixed author-chosen slugs — the
     *  two coexist, and an extension may declare both.
     *
     *  The extension never chooses a dynamic slug: it supplies a `key` and
     *  the host mints `<webhookPrefix><digest>` from the registry-resolved
     *  extension name, so collision and forgery are inexpressible rather
     *  than merely denied. `webhookPrefix` is therefore a NAMESPACE CLAIM
     *  and is taken from the manifest only — never widened by the submitted
     *  grant, which would let a user hand one extension another's
     *  namespace.
     *
     *  `maxRunsPerDay` is an extension-wide fire ENVELOPE, not a per-job
     *  allowance; the host additionally derives a per-key cap so one busy
     *  job cannot starve its siblings. */
    triggers?: {
      maxCron?: number;
      maxWebhooks?: number;
      webhookPrefix?: string;
      maxRunsPerDay?: number;
    };
    /** Trigger runs of workflows THIS extension ships, via `ctx.workflows`
     *  (the `Workflows` helper in `@ezcorp/sdk/runtime`). Ship the
     *  definitions as `*.workflow.yaml` files at the root of your extension
     *  directory; the host loads them under `<extensionName>:<name>` and
     *  lists them alongside its own. Each `names` entry is the BARE name
     *  from one of those files — the host applies the namespace prefix
     *  itself, so you can never address another extension's (or the host's)
     *  workflow. `maxRunsPerHour` is optional here; the host's clamp always
     *  supplies one (default 20, ceiling 500) because a run can fan out
     *  into agent steps that cost real LLM spend. Undeclared names are
     *  dropped at install.
     *
     *  `allowDelegated` (C3) additionally opts you into
     *  `ctx.workflows.runFor` — firing a workflow you do NOT ship, as the
     *  human who created a delegation for it. It is independent of
     *  `names`: an extension that only ever fires user-authored workflows
     *  declares `{names: [], allowDelegated: true}`, which is the one
     *  shape in which an empty `names` list is accepted. The flag by
     *  itself authorizes no job — every delegated fire is bound by a
     *  delegation record a human created for one named workflow, which
     *  the host re-reads on every call and which is revocable
     *  independently of this grant. */
    workflows?: { names: string[]; maxRunsPerHour?: number; allowDelegated?: boolean };
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
     *  resolves credentials and calls the provider directly, returning
     *  ONLY the result. */
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
    /** Brokered web search + URL read via `ctx.search` (shared-search
     *  Phase 1). The provider chain + SSRF guard run host-side. A bundled
     *  extension may declare `"inherit"` (full grant, tracks instance
     *  defaults), `false` (opt out), or an object of per-field upper
     *  bounds the resolver clamps against — the §3.1 three-state shape. */
    search?:
      | "inherit"
      | false
      | {
          quota?: number;
          maxResults?: number;
          providers?: string[] | "inherit";
        };
    /**
     * Custom RBAC scopes this extension DECLARES (extension-RBAC layer,
     * user→extension axis). Declarations, NOT privileges: each entry
     * names a per-extension scope that (a) appears as a grantable
     * option in the host's grant UI and (b) your extension code can
     * query at runtime via `ctx.rbac.check(name)` (the `Rbac` helper in
     * `@ezcorp/sdk/runtime`, brokered over the `ezcorp/rbac-check`
     * reverse-RPC). A user only HOLDS a scope when an instance admin /
     * manager explicitly grants it — declaring one confers nothing by
     * itself.
     *
     * Rules (host-validated at admit time; a bad declaration rejects
     * the manifest):
     *   - `name` matches `/^[a-z][a-z0-9-]*$/` and is implicitly
     *     namespaced to this extension
     *   - `name` must NOT collide with the built-in core verbs
     *     (`use` / `configure` / `secrets` / `approve-runs` / `manage`
     *     — those are checkable on every extension without declaring)
     *   - names must be unique; `description` is required (it is the
     *     text the grant UI shows the granting admin)
     *   - max 16 entries
     *
     * Additive to schemaVersion 2 — no schema bump.
     */
    rbacScopes?: Array<{ name: string; description: string }>;
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

  /**
   * Quality-tier routing (pi-caching/routing integration). Declares the
   * model tier this extension's work needs — a `powerful`-declaring
   * extension wired into a conversation nudges the heuristic tier
   * classifier up so its turns route to a strong model (and vice-versa for
   * `fast`). OPTIONAL: absent = the extension expresses no tier preference
   * and the length/tools heuristic decides. The declaration only takes
   * effect when the conversation has NO established model yet (routing is
   * tier-stable within a thread to protect the prompt cache).
   */
  routing?: { tier: "fast" | "balanced" | "powerful" };

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
