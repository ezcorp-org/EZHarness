// Host extension types. The author-facing manifest contract lives in
// `@ezcorp/sdk`; this file only adds host-only runtime metadata and DB types.

import type {
  ExtensionManifestV2 as AuthorExtensionManifestV2,
  McpServerHttp as AuthorMcpServerHttp,
  McpServerSse as AuthorMcpServerSse,
  McpServerStdio as AuthorMcpServerStdio,
} from "@ezcorp/sdk";

export type {
  AgentComponentDefinition,
  CapabilityDeclaration,
  DependencySpec,
  ExtensionPageDeclaration,
  McpTransport,
  MessageToolbarItem,
  PreprocessorDecl,
  ScriptDefinition,
  SettingsField,
  SettingsFieldBoolean,
  SettingsFieldNumber,
  SettingsFieldSecret,
  SettingsFieldSelect,
  SettingsFieldText,
  SettingsSchema,
  SkillDefinition,
  ToolDefinition,
} from "@ezcorp/sdk";

/** Host-only MCP launch metadata. It is never author-written. */
export interface McpServerStdio extends AuthorMcpServerStdio {
  seccompFd?: number | null;
  onChildSpawned?: (pid: number, writeByte: (b: number) => Promise<void>) => Promise<void>;
  _internal_vethSetup?: {
    slot: number;
    vethId: string;
    hostSideName: string;
    nsSideName: string;
    vethIpv4: string;
  } | null;
}

export type McpServerHttp = AuthorMcpServerHttp;
export type McpServerSse = AuthorMcpServerSse;
export type McpServerDefinition = McpServerStdio | McpServerHttp | McpServerSse;

type AuthorPermissions = AuthorExtensionManifestV2["permissions"];

/**
 * Host view of the public manifest. The SDK owns every author-writable
 * declaration. The additions below are host-generated metadata for MCP rows
 * and bundled internal capabilities.
 */
export interface ExtensionManifestV2 extends Omit<
  AuthorExtensionManifestV2,
  "mcpServers" | "permissions" | "schemaVersion"
> {
  /** The host also persists and executes the isolated v4 manifest contract. */
  schemaVersion: AuthorExtensionManifestV2["schemaVersion"] | 4;
  mcpServers?: McpServerDefinition[];
  permissions: AuthorPermissions & {
    mcpInvoke?: boolean;
    custom?: {
      drafts?: { kinds: string[] };
      [key: string]: unknown;
    };
  };
}

export type ExtensionManifest = ExtensionManifestV2;

export interface ExtensionManifestInternal extends ExtensionManifestV2 {
  _inheritedFromV2?: boolean;
}

export type ExtensionPackageType = "agent" | "extension";

export function inferPackageType(manifest: ExtensionManifestV2): ExtensionPackageType {
  const hasTools = (manifest.tools?.length ?? 0) > 0;
  const hasSkills = (manifest.skills?.length ?? 0) > 0;
  const hasMcp = (manifest.mcpServers?.length ?? 0) > 0;
  const hasScripts = manifest.scripts != null;
  const hasAgent = manifest.agent != null;
  return hasAgent && !hasTools && !hasSkills && !hasMcp && !hasScripts
    ? "agent"
    : "extension";
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
  /** Host-granted v4 route/event authority; author shape remains in the shared legacy contract. */
  hostApi?: import("@ezcorp/extension-contract").ExtensionManifestV4["permissions"]["hostApi"];
  network?: string[];
  /** Host-granted v4 TCP destination authority. */
  networkTcp?: string[];
  /** Host-granted v4 credential names. */
  secretRead?: string[];
  filesystem?: string[];
  shell?: boolean;
  env?: string[];
  storage?: boolean;
  /** GRANTED form of the `kind:"mcp"` dispatch sentinel. See the matching
   *  field on `ExtensionManifestV2.permissions.mcpInvoke` for the contract.
   *  Auto-granted at install by `mcpInstallGrant`, revoked by submitting an
   *  explicit `mcpInvoke: false` to `PUT /api/extensions/[id]/permissions`. */
  mcpInvoke?: boolean;
  // Capability tier — see ExtensionManifestV2.permissions for the full
  // contract + the Phase 2+3 plan (`.claude/plans/tranquil-dancing-book.md`).
  taskEvents?: boolean;
  /** Grants the `ezcorp/emit-loop-event` reverse RPC (Loops EZ Mode
   *  Phase 2). See the matching field on
   *  `ExtensionManifestV2.permissions.loopEvents`. */
  loopEvents?: boolean;
  spawnAgents?: { maxPerHour: number; maxConcurrent?: number };
  agentConfig?: "read";
  /** Subscribed bus-event types (Phase 2c). Clamped at install time to
   *  the intersection of manifest declaration and the direct-carrier
   *  allowlist. */
  eventSubscriptions?: string[];
  /** Granted webhook slugs (Loops EZ Mode Phase 4). Clamped at install
   *  time to the intersection of manifest declaration and the submitted
   *  grant. The host routes an authenticated inbound POST onto the delivery
   *  queue only for a slug present here. See the matching manifest field. */
  webhooks?: string[];
  /** Granted dynamic-trigger envelope (C2). Every field is REQUIRED here
   *  (unlike the manifest, where all are optional) — the clamp always
   *  supplies a bound, and `intersectPermissions` does `Math.min`, so a
   *  ceiling row that omitted one would produce `NaN`. Same discipline as
   *  `workflows.maxRunsPerHour` above.
   *
   *  `webhookPrefix` is copied from the MANIFEST, never from the submitted
   *  grant: it names a slug namespace, and letting an install widen it
   *  would let a user hand one extension another extension's namespace. */
  triggers?: {
    maxCron: number;
    maxWebhooks: number;
    webhookPrefix: string;
    maxRunsPerDay: number;
  };
  /** Granted workflow triggers (W2). `names` are BARE workflow names
   *  clamped at install time to the intersection of the manifest
   *  declaration and the submitted grant; the host namespaces each to
   *  `<extensionName>:<name>` before resolving, so a granted name can
   *  only ever reach a workflow this extension itself ships.
   *  `maxRunsPerHour` is REQUIRED here (unlike the manifest, where it is
   *  optional) — the clamp always supplies a bound, and
   *  `intersectPermissions` does `Math.min` on it, so a ceiling row that
   *  omitted it would produce `NaN`. See the matching manifest field.
   *
   *  `names` MAY be empty here, but ONLY when `allowDelegated` is true
   *  (C3 / D-3). Before C3 an empty list was always a husk — it read as
   *  "granted" to a presence check while authorizing nothing — so the
   *  clamp dropped the whole grant. A delegated-only extension ships no
   *  workflows of its own, so `{names: [], allowDelegated: true}` is the
   *  ONLY shape in which an empty list means something. Every other
   *  empty-list path still collapses to `undefined`; see the three
   *  branches of `clampWorkflowsPermission`. */
  workflows?: { names: string[]; maxRunsPerHour: number; allowDelegated?: boolean };
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
