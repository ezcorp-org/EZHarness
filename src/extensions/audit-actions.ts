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
} as const;

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
