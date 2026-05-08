/**
 * Typed action strings for extension-permission audit entries. Every permission
 * grant, revoke, or rejection writes a row into the shared `audit_log` table
 * (`src/db/queries/audit-log.ts`) with one of these action values and a
 * metadata payload matching {@link ExtensionAuditMetadata}.
 *
 * Using the shared table (rather than a dedicated table) keeps the DB schema
 * small and lets the general-purpose audit-log viewer surface extension
 * events without any special-casing. Per-extension queries filter on
 * `target = extensionId` AND `action LIKE 'ext:%'` — see
 * `listAuditForExtension()`.
 */

export const EXT_AUDIT_ACTIONS = {
  /** An admin granted (or widened) a permission via the UI / API. */
  PERMISSION_GRANTED: "ext:permission-granted",
  /** An admin revoked (or narrowed) a permission. */
  PERMISSION_REVOKED: "ext:permission-revoked",
  /**
   * An attempt to grant a permission the manifest doesn't declare was clamped
   * by `clampToManifest()`. Logged so the admin UI can surface suspicious
   * widening attempts — the grant itself never reaches `grantedPermissions`.
   */
  PERMISSION_REJECTED: "ext:permission-rejected",
  /** A bundled extension was installed on first boot (or on a fresh DB). */
  BUNDLED_INSTALLED: "ext:bundled-installed",
  /**
   * `ensureBundledExtensions()` re-granted permissions on an existing
   * bundled row (e.g. after manual DB tampering revoked them). Normal
   * operation under the `BUNDLED_EXTENSIONS` code-review-is-approval model.
   */
  BUNDLED_REGRANTED: "ext:bundled-regranted",
  /**
   * A bundled extension's on-disk manifest permissions no longer match the
   * DB-stored permissions. Does not mutate the DB grant — fail-closed.
   * Signal only, to be investigated.
   */
  MANIFEST_DRIFTED: "ext:manifest-drifted",
  /**
   * An extension version bump had different `permissions` than the prior
   * install; `enabled` was flipped to false pending admin re-approval.
   */
  UPDATE_BLOCKED: "ext:update-blocked",
  // ── Capability tier (Phase 2+) ──
  /** A capability-tier permission (`taskEvents`, `spawnAgents`, or
   *  `agentConfig`) was granted. Separate from `PERMISSION_GRANTED` so
   *  the detail page can rank these with an elevated (red) badge. */
  CAPABILITY_GRANTED: "ext:capability-granted",
  /** A capability-tier permission was revoked. */
  CAPABILITY_REVOKED: "ext:capability-revoked",
  /** `ezcorp/spawn-assignment` refused a spawn because the per-hour
   *  quota or concurrent-run cap was exceeded (Phase 2d). */
  SPAWN_QUOTA_EXCEEDED: "ext:spawn-quota-exceeded",
  /** `ezcorp/cancel-run` successfully cancelled (or attempted to cancel)
   *  a sub-run the calling extension originated. The metadata `reason`
   *  field distinguishes outcomes: `"cancelled"`, `"not-owned"`,
   *  `"missing-run"`, `"permission-missing"` (Phase 4). */
  SPAWN_CANCELLED: "ext:spawn-cancelled",
  /** `ezcorp/spawn-assignment` successfully spawned a child agent run.
   *  The metadata carries `subConversationId`, `agentRunId`, and the
   *  effective grant set so the audit chain rooted here can be
   *  reconstructed (Phase 4 §M2). Every authorize() inside the
   *  child conversation's tool calls threads `parentAuditId` back to
   *  this row's id. */
  SPAWN_AUTHORIZED: "ext:spawn-authorized",
  /** `ezcorp/emit-task-event` rejected an emission — rate-limited,
   *  unauthorized conversation wiring, or malformed payload (Phase 2b). */
  EMIT_EVENT_REJECTED: "ext:emit-event-rejected",
  /** Server→extension `eventSubscriptions` delivery was dropped — the
   *  extension is rate-limited, the event payload is missing a
   *  `conversationId`, or defense-in-depth caught a routing mismatch
   *  (Phase 2c). The metadata `reason` field distinguishes them:
   *  `"rate-limited"`, `"not-wired"`, `"no-conversation-id"`. */
  EVENT_SUBSCRIPTION_DENIED: "ext:event-subscription-denied",
  /**
   * `ensureBundledExtensions()` self-healed a bundled extension's
   * `eventSubscriptions` grant: the on-disk manifest declared
   * additions (or net-new subscriptions) that were missing from
   * the DB-stored grant, so the host backfilled them into
   * `granted_permissions.eventSubscriptions` and the manifest's
   * `permissions.eventSubscriptions`. Only fires for the
   * eventSubscriptions field — every other permission field
   * still warns-and-fails-closed via MANIFEST_DRIFTED.
   *
   * Rationale: eventSubscriptions are infrastructure plumbing
   * (which canvas-style POST routes the extension can receive),
   * not a privacy/safety boundary like network/filesystem/shell.
   * Failing closed there would brick the canvas knob round-trip
   * for any bundled extension that adds a new event after its
   * first install — exactly the bug captured in the test
   * suite for this audit action.
   */
  BUNDLED_EVENT_SUBSCRIPTIONS_BACKFILLED: "ext:bundled-event-subscriptions-backfilled",
  /** A user updated their per-extension settings via PUT
   *  /api/extensions/[id]/settings/user. Settings can carry
   *  user-controlled values (e.g. an API key in a text field —
   *  there's no `secret:true` flag yet), so the mutation is
   *  audited with before/after values + the raw submitted blob. */
  SETTINGS_USER_UPDATED: "ext:settings.user.update",
  /** A user reset their per-extension settings via DELETE
   *  /api/extensions/[id]/settings/user. Audited with the
   *  pre-delete values for forensic trail. */
  SETTINGS_USER_RESET: "ext:settings.user.reset",
  // ── Phase 1: Policy Decision Point (PDP) ──
  /** PDP authorized a tool call / privileged op (every needed cap is
   *  covered by the effective grant set). Metadata: `{auditId, toolName,
   *  capabilityKind, capabilityValue, parentAuditId, callerExtensionId,
   *  conversationId}`. Phase 4 will populate `callerExtensionId` for
   *  cross-ext invokes. */
  PERM_ALLOWED: "ext:perm:allowed",
  /** PDP denied a privileged op — at least one needed cap is missing.
   *  Metadata: same shape as PERM_ALLOWED plus a `reason` field naming
   *  the missing cap. */
  PERM_DENIED: "ext:perm:denied",
  /** PDP returned `prompt` — every needed cap is granted but a
   *  sensitive cap (shell / fs.write) lacks an always-allow row. Phase
   *  6 wires the UI; Phase 1 callers treat this as `allow` so the
   *  audit row is the only externally visible signal. Metadata:
   *  `{auditId, toolName, capabilityKind, capabilityValue, promptId,
   *  conversationId}`. */
  PERM_PROMPTED: "ext:perm:prompted",
  // ── Phase 5: Bundled cap-ceiling + manifest tamper detection ──
  /**
   * `bundled.ts` install path clamped a user-requested grant to the
   * hardcoded `bundled-ceiling.ts` ceiling — at least one field was
   * narrowed by `intersectPermissions`. The persisted grant is the
   * clamped value; the audit metadata records the diff so an admin
   * can investigate. Metadata: `{extensionName, requested, effective}`
   * — both shapes are `ExtensionPermissions` JSON.
   */
  BUNDLED_CEILING_CLAMP: "ext:bundled:ceiling-clamp",
  /**
   * `bundled.ts` manifest-refresh path detected a mismatch between the
   * on-disk manifest and `manifest.lock.json` (tool-list, entrypoint,
   * or version). Extension is disabled; refresh is aborted; runtime
   * enforcement keeps the prior DB grant. Metadata:
   * `{extensionName, reason, expected, actual}`.
   */
  BUNDLED_MANIFEST_TAMPER: "ext:bundled:manifest-tamper",
  // ── Phase 7: MCP isolation (forward proxy + Linux netns) ──
  /**
   * `mcp-sandbox.ts` successfully started an MCP process inside a
   * fresh user+net+mount namespace. One row per MCP-extension start.
   * Metadata: `{extensionName, socketPath, kernel}` — the kernel
   * field carries `process.platform`+`process.versions.libuv` so a
   * fleet operator can audit which kernels the netns leg ran on.
   */
  MCP_NETNS_CREATED: "ext:mcp:netns-created",
  /**
   * The netns probe failed (non-Linux, hardened kernel, or seccomp
   * profile blocking unshare) so `mcp-sandbox.ts` fell back to the
   * "HTTPS_PROXY env only" mode. Bypassable by raw-socket libc; the
   * audit signal lets fleet monitoring identify deployments running
   * in less-strict mode. Metadata: `{extensionName, reason}` — the
   * reason string comes verbatim from `probeNetnsAvailability().reason`.
   */
  MCP_NETNS_FALLBACK: "ext:mcp:netns-fallback",
  /**
   * The per-MCP forward proxy refused a CONNECT request: token
   * mismatch, hostname not in the manifest's permitted list, byte
   * quota exhausted, or concurrent-connection cap reached. Metadata:
   * `{extensionName, hostname, reason}` where reason is one of
   * `"auth"`, `"host"`, `"quota:bytes"`, `"quota:concurrent"`.
   */
  MCP_HOST_BLOCKED: "ext:mcp:host-blocked",
  // ── Phase 50: SDK capability tier (Phase 51 handlers write these) ──
  // These rows accompany the high-volume sdk_capability_calls table:
  // every SDK call writes a row to sdk_capability_calls AND a row
  // here, the latter being what governance dashboards filter on.
  // The `permission` field on ExtensionAuditMetadata is now optional
  // because SDK_* rows don't carry a permission name — they carry
  // `capability` instead.
  /** ctx.llm.complete() succeeded. Metadata: capability='llm',
   *  provider, model, tokensUsed, costUsd, durationMs, conversationId. */
  SDK_LLM_CALL: "ext:sdk-llm-call",
  /** ctx.llm.complete() rejected before issuing the provider request
   *  (rate-limit, cost cap, un-granted provider). */
  SDK_LLM_REJECTED: "ext:sdk-llm-rejected",
  /** ctx.memory.read() / search() / getById(). */
  SDK_MEMORY_READ: "ext:sdk-memory-read",
  /** ctx.memory.write() / update() / delete(). */
  SDK_MEMORY_WRITE: "ext:sdk-memory-write",
  /** ctx.memory.* rejected (selfOnly violation, category-scope, etc.). */
  SDK_MEMORY_REJECTED: "ext:sdk-memory-rejected",
  /** ctx.lessons.read() / search() / getBySlug(). */
  SDK_LESSONS_READ: "ext:sdk-lessons-read",
  /** ctx.lessons.write() / update() / delete(). */
  SDK_LESSONS_WRITE: "ext:sdk-lessons-write",
  /** ctx.lessons.* rejected (slug collision, visibility scope). */
  SDK_LESSONS_REJECTED: "ext:sdk-lessons-rejected",
  /** ctx.schedule.register() — extension declared a recurring or
   *  delayed fire. */
  SDK_SCHEDULE_REGISTERED: "ext:sdk-schedule-registered",
  /** Daemon dispatched a fire callback to the extension. */
  SDK_SCHEDULE_FIRE: "ext:sdk-schedule-fire",
  /** ctx.schedule.* rejected (cron parse error, quota, dst-edge). */
  SDK_SCHEDULE_REJECTED: "ext:sdk-schedule-rejected",
  /** ctx.events.subscribe() — extension wired a new event listener. */
  SDK_EVENT_SUBSCRIBED: "ext:sdk-event-subscribed",
  /** Event delivery rejected (rate-limit, payload denied by allowlist). */
  SDK_EVENT_DELIVERY_REJECTED: "ext:sdk-event-delivery-rejected",
  /** Sampled audit row written when the dispatcher actually delivered an
   *  event to a subscribed extension (1-in-N — see
   *  `global:eventSubscriptionAuditSampleN` setting). */
  SDK_EVENT_DELIVERED: "ext:sdk-event-delivered",
  /** Schedule reconciler / daemon flipped a schedule's `enabled` to false
   *  after 5 consecutive errors. */
  SDK_SCHEDULE_DISABLED: "ext:sdk-schedule-disabled",
  /** Install-time governance: extension's manifest declared
   *  `permissions.env: ["FOO_API_KEY" | "BAR_TOKEN" | "BAZ_SECRET"]`.
   *  Soft warning today; hard error in v1.4. Migration path is
   *  `ctx.llm` (host-brokered credentials, key never crosses the
   *  RPC boundary). */
  ENV_KEY_LEAK_WARNING: "ext:env-key-leak-warning",
  /** ctx.llm.complete() denyAndDisable graduation — repeated attempts
   *  to use an un-granted provider in a 60s window. */
  SDK_LLM_DENIED_AND_DISABLED: "ext:sdk-llm-denied-and-disabled",
  /** ctx.lessons.write() requested visibility above
   *  `permissions.lessons.maxVisibility` — clamped down to
   *  the granted ceiling. Soft governance row (call still
   *  succeeds with the clamped visibility). */
  SDK_LESSONS_VISIBILITY_CLAMPED: "ext:sdk-lessons-visibility-clamped",
  /** ctx.schedule.fireNow() — extension explicitly fired a
   *  declared cron immediately. Counts against
   *  `permissions.schedule.maxRunsPerDay`. */
  SDK_SCHEDULE_FIRE_NOW: "ext:sdk-schedule-fire-now",
  /** ScheduleDaemon refused to dispatch because the day's
   *  `maxRunsPerDay` cap was exceeded. */
  SDK_SCHEDULE_QUOTA_EXCEEDED: "ext:sdk-schedule-quota-exceeded",
  /** ScheduleDaemon reaped a `running` row left over from a
   *  crash mid-fire. Marked for retry only when
   *  `maxRetries > 0`. */
  SDK_SCHEDULE_REAPED: "ext:sdk-schedule-reaped",
} as const;

// Re-export the three Phase 1 PDP action codes as named constants for
// import sites that don't go through the `EXT_AUDIT_ACTIONS.*` lookup
// (the PDP itself, every PEP). Keeping both forms means pre-existing
// code that already uses `EXT_AUDIT_ACTIONS.PERM_ALLOWED` keeps
// working.
export const AUDIT_PERM_ALLOWED = "ext:perm:allowed";
export const AUDIT_PERM_DENIED = "ext:perm:denied";
export const AUDIT_PERM_PROMPTED = "ext:perm:prompted";

// Phase 5 named-constant exports — same string values as the
// `EXT_AUDIT_ACTIONS.BUNDLED_*` keys above; provided for direct import
// at the call sites in `bundled.ts`.
export const AUDIT_BUNDLED_CEILING_CLAMP = "ext:bundled:ceiling-clamp";
export const AUDIT_BUNDLED_MANIFEST_TAMPER = "ext:bundled:manifest-tamper";

export type ExtAuditAction = typeof EXT_AUDIT_ACTIONS[keyof typeof EXT_AUDIT_ACTIONS];

/**
 * Metadata shape stored in `audit_log.metadata` for every `ext:*` row.
 * Downstream code (e.g. the detail page) can rely on this contract.
 *
 * Phase 50: `permission` is now optional. Permission-tier rows
 * (PERMISSION_GRANTED, etc.) populate it; SDK_* rows leave it
 * undefined and populate `capability` instead.
 */
export type ExtensionAuditMetadata = {
  /** Which permission field was affected (e.g. "storage", "shell", "network").
   *  Optional — SDK_* tier rows omit it and use `capability` instead. */
  permission?: string;
  /** SDK capability bucket — populated by SDK_* tier rows; undefined on
   *  permission-tier rows. */
  capability?: "llm" | "memory" | "lessons" | "schedule" | "events";
  /** Prior value — typically `boolean`, `string[]`, or `undefined`. */
  oldValue: unknown;
  /** Post-change value. For rejected attempts, the VALUE THAT WAS REJECTED. */
  newValue: unknown;
  /**
   * Who made the change. `"system"` for bundled-install / bundled-regrant /
   * manifest-drift / update-blocked (the server did it unprompted). An
   * admin-initiated change uses the user id as a string.
   */
  actor: "system" | string;
  /** Free-form explanation. For `UPDATE_BLOCKED`, include the version diff. */
  reason?: string;
} & Record<string, unknown>;
