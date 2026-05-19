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
  /** A user re-approved an expired grant via /api/extensions/[id]/reapprove.
   *  Distinguished from PERMISSION_GRANTED so SOC 2 / SIEM dashboards can
   *  filter the two operationally-different consent events. Metadata mirrors
   *  PERMISSION_GRANTED's shape. (Phase 54 SEC-04 / CC4 close-out — see
   *  tasks/v1.3-security-review.md.) */
  PERMISSION_REAPPROVED: "ext:permission-reapproved",
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
  /**
   * The S9 version-bump gate would normally disable a bundled
   * extension whose permissions changed under a new version, but the
   * extension is `critical` (loop-safety floor — `ask-user` /
   * `task-tracking`) AND the new permission set is WITHIN the bundled
   * ceiling. Instead of disabling (which would trap a stuck agent),
   * the host auto-accepts: records the new version and keeps
   * `enabled=true`. The ceiling is still the hard security bound — a
   * critical bump that EXCEEDS the ceiling is NOT auto-accepted (the
   * disable stands and the startup invariant escalates). One row per
   * auto-reapproved critical extension. Metadata:
   * `{extensionName, oldValue: <old version>, newValue: <new version>,
   * actor:"system", reason}`.
   */
  BUNDLED_CRITICAL_AUTO_REAPPROVED: "ext:bundled:critical-auto-reapproved",
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
  /**
   * Phase 55 / MCP-03 — a kernel seccomp log-mode hit was observed for
   * an MCP child process. Phase 55 ships the trimmed Docker default
   * seccomp profile in `SCMP_ACT_LOG` mode: every gated syscall is
   * recorded by the kernel (visible via `journalctl -k` as
   * `audit: type=1326` lines with `code=0x7ffc0000`), and a per-MCP
   * post-shutdown reader (`mcp-sandbox.ts`) parses those lines and
   * emits ONE row of this action per matching `pid` + `syscall` pair.
   *
   * Metadata shape:
   *   {
   *     permission: "network",      // re-used scope field for SIEM consistency
   *     oldValue: null, newValue: null, actor: "system",
   *     extensionName: string,      // manifest.name of the MCP-hosting extension
   *     syscall: number,            // numeric syscall id from the audit line
   *     code: string,               // "0x7ffc0000" (log) or "0x00050001" (errno, post-Phase-58)
   *     pid: string,                // host PID — matches `mcpChild.pid`
   *     arch: string,               // kernel audit arch code, e.g. "c000003e" (x86_64)
   *   }
   *
   * Phase 58 owns the readiness gate: ≥7 days with zero rows of this
   * action across the deployed MCP corpus → flip the profile from
   * SCMP_ACT_LOG to SCMP_ACT_ERRNO (enforce mode).
   *
   * Phase 58 / MCP-04 — under enforce mode (SCMP_ACT_ERRNO, post-flip), this
   * row continues to fire from the same soak reader path. The kernel uses
   * the same `audit: type=1326` line shape, so the parser is unchanged. The
   * `metadata.code` discriminator distinguishes the two modes:
   *
   *   - `0x7ffc0000` — SECCOMP_RET_LOG (Phase 55, observed-only)
   *   - `0x00050001` — SECCOMP_RET_ERRNO (Phase 58, killed-or-errno'd)
   *
   * SIEM dashboards that need to split should filter on `metadata.code`.
   * The action name stays `MCP_SECCOMP_VIOLATION` for SIEM stability.
   */
  MCP_SECCOMP_VIOLATION: "ext:mcp:seccomp-violation",
  /**
   * Phase 58 / MCP-05 — emitted per successful Stage 2 veth setup.
   *
   * Two-action split (CONTEXT-locked): MCP_NETNS_CREATED stays the
   * Stage 1 signal (bare `unshare -U -m`, no veth wiring). MCP_VETH_CREATED
   * fires ONLY on Stage 2 — host process created a veth pair, attached
   * the host-side peer to `br-ezcorp-mcp`, moved the namespace-side
   * peer into the child's netns, and successfully completed the
   * launcher handshake (`read -n 1` from FD 0). Operators reading
   * `/audit` see two distinct actions for the two modes; SIEM
   * dashboards can split Stage 1 vs Stage 2 footprint cleanly.
   *
   * Metadata: {
   *   permission: "network",      // SIEM-consistent scope field
   *   oldValue: null, newValue: null, actor: "system",
   *   extensionName: string,      // manifest.name
   *   vethId: string,             // 8-hex shortId from Bun.randomUUIDv7
   *   hostSideName: string,       // "mcp-<8hex>" (12 chars, on bridge)
   *   nsSideName: string,         // "mcp-<8hex>-ns" (15 chars, in ns)
   *   ipv4: string,               // "10.42.0.X/30" — MCP-side CIDR
   * }
   */
  MCP_VETH_CREATED: "ext:mcp:veth-created",
  /**
   * Phase 58 / MCP-05 — Plan 03 — emitted once per host process boot when
   * the orphan sweep runs (BEFORE the bridge is created). One row per
   * boot even if zero orphans were found — operators reading /audit
   * see that the sweep ran (positive signal, not a "no rows" silence).
   *
   * Sweep regex: /^mcp-[a-f0-9]{8}$/ matches Plan 02's host-side veth
   * naming. Kernel auto-deletes the namespace-side peer when its mate
   * goes; no separate ns-side cleanup needed.
   *
   * Metadata: {
   *   permission: "network", oldValue: null, newValue: null, actor: "system",
   *   count: number,           // number of orphans deleted (0 = clean shutdown)
   *   names: string[],         // list of deleted interface names
   * }
   *
   * Failure mode: if `ip link show` fails (CAP_NET_ADMIN missing),
   * Plan 03's initStage2 emits MCP_NETNS_FALLBACK instead with
   * reason='stage2 unavailable: CAP_NET_ADMIN missing' and degrades
   * the entire host process to Stage 1.
   */
  MCP_VETH_ORPHAN_SWEPT: "ext:mcp:veth-orphan-swept",
  /**
   * Phase 58 / MCP-05 — Plan 03 — emitted per spawn refusal when the
   * pre-spawn conntrack pressure check finds
   * /proc/sys/net/netfilter/nf_conntrack_count > 0.7 *
   * /proc/sys/net/netfilter/nf_conntrack_max. Threshold matches the
   * Linux kernel's own conntrack-pressure warning point.
   *
   * Companion to boot-time ensureConntrackCeiling (floor-guarantees
   * nf_conntrack_max >= 262144 — Debian bookworm ≥4GB RAM default
   * per kernel docs; the boot bump is idempotent only-write-if-lower).
   *
   * Metadata: {
   *   permission: "network", oldValue: null, newValue: null, actor: "system",
   *   extensionName: string,
   *   conntrackCount: number,  // current /proc/sys/net/netfilter/nf_conntrack_count
   *   conntrackMax: number,    // current /proc/sys/net/netfilter/nf_conntrack_max
   *   ratio: number,           // conntrackCount / conntrackMax (0..1)
   * }
   */
  MCP_CONNTRACK_HIGH: "ext:mcp:conntrack-high",
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
  /** v1.4: install gate refused to persist an extension because
   *  its manifest declared a credential-shaped env name
   *  (`*_API_KEY|TOKEN|SECRET`). One row per leaked name; the
   *  installer also throws `EnvKeyLeakInstallError` so the row
   *  exists alongside an aborted install. Sibling of
   *  `ENV_KEY_LEAK_WARNING`: the warning is "we see this; please
   *  migrate", this is "we refused to install".
   *
   *  Migration path stays `ctx.llm` (LLM creds, host-brokered)
   *  and future `ctx.secrets` (third-party API creds, v1.5+). */
  ENV_KEY_LEAK_INSTALL_BLOCKED: "ext:env-key-leak-install-blocked",
  /** v1.4: bundled extension with `envEscapeHatch: true` installed
   *  successfully despite declaring a credential-shaped env name.
   *  Bundled-trust + code-review-is-the-approval-gate model;
   *  `envEscapeHatch` is a transitional flag pending the v1.5+
   *  `ctx.secrets` host-brokered cred surface. Grep for
   *  `envEscapeHatch` to find every bundled exception when the
   *  migration lands. One row per credential-shaped env name. */
  ENV_KEY_LEAK_BUNDLED_ESCAPE_HATCH_USED: "ext:env-key-leak-bundled-escape-hatch-used",
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
  /**
   * Capability-expiry sweep revoked a permission grant whose
   * `grantedAt` aged past the per-capability TTL (see
   * `./perm-expiry-config.ts`). Phase 1 ships only the constant; the
   * sweep that emits this row lands in Phase 2 (see
   * `tasks/capability-expiry-milestone.md` § Phase 2).
   *
   * Metadata shape (Phase 2 contract — DO NOT widen without amending
   * the milestone plan):
   *   {
   *     capability: CapabilityExpiryKind,  // family that expired
   *     scope:      AlwaysAllowScope | "extensions-row",
   *     ttlMs:      number,                // resolved TTL at sweep time
   *     ageMs:      number,                // now() - grantedAt
   *   }
   *
   * `scope: "extensions-row"` distinguishes a per-extension grant on
   * the `extensions.granted_permissions` JSON column from an always-
   * allow row on `settings`. Phase 2 will refine if needed.
   */
  PERM_GRANT_EXPIRED: "ext:permission-grant-expired",
  /** ScheduleDaemon refused to dispatch because the day's
   *  `maxRunsPerDay` cap was exceeded. */
  SDK_SCHEDULE_QUOTA_EXCEEDED: "ext:sdk-schedule-quota-exceeded",
  /** ScheduleDaemon reaped a `running` row left over from a
   *  crash mid-fire. Marked for retry only when
   *  `maxRetries > 0`. */
  SDK_SCHEDULE_REAPED: "ext:sdk-schedule-reaped",
  /**
   * v1.4: a user flipped `memories.injection_eligible` for one of
   * their memories via PATCH /api/memories/[id]. Privacy-relevant —
   * an excluded memory is suppressed from the LLM system-prompt
   * injection path (gate already lives in
   * `src/extensions/memory-handler.ts`, Phase 51). The audit row
   * carries `{memoryId, oldValue, newValue, actor: <userId>}` plus
   * a free-form `reason` for forensic continuity.
   *
   * Wire-string follows the dotted-notation convention shared with
   * `SETTINGS_USER_UPDATED` (the closest analogue: a per-user,
   * privacy-relevant column flip).
   */
  MEMORY_INJECTION_ELIGIBILITY_CHANGED: "ext:memory.injection-eligibility.changed",
  // ── Phase 7: defineEntity SDK namespace migration ──
  /**
   * `runEntityNamespaceMigration` renamed legacy entity-CRUD storage
   * keys to the SDK's managed `__entity:*` / `__entity-index:*`
   * namespace. One row per migrated (extensionId, scope, scopeId)
   * cell. Metadata carries `{entityType, from, to, scope, scopeId,
   * recordsMigrated?, skippedSlugs?, cleanedStragglers?}`. Audit
   * trail covers crashed-mid-migration straggler cleanup as well.
   */
  ENTITY_NAMESPACE_MIGRATION: "ext:entity-namespace-migrated",
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
  // ── Phase 55 / MCP-03 — typed slots populated by MCP_SECCOMP_VIOLATION rows.
  // Optional everywhere; the existing `Record<string, unknown>` intersection
  // still permits arbitrary other metadata fields for other audit actions.
  /** Numeric syscall id (e.g. 51 for `listen` on x86_64). MCP-03 soak reader. */
  syscall?: number;
  /** Audit code string: `"0x7ffc0000"` (SECCOMP_RET_LOG, Phase 55 log mode) or
   *  `"0x00050001"` (SECCOMP_RET_ERRNO, Phase 58 enforce mode). */
  code?: string;
  /** Host PID of the MCP child whose syscall the kernel logged. */
  pid?: string;
  /** Kernel audit arch code, e.g. `"c000003e"` (x86_64). */
  arch?: string;
} & Record<string, unknown>;
