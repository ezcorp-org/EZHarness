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
} as const;

export type ExtAuditAction = typeof EXT_AUDIT_ACTIONS[keyof typeof EXT_AUDIT_ACTIONS];

/**
 * Metadata shape stored in `audit_log.metadata` for every `ext:*` row.
 * Downstream code (e.g. the detail page) can rely on this contract.
 */
export type ExtensionAuditMetadata = {
  /** Which permission field was affected (e.g. "storage", "shell", "network"). */
  permission: string;
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
