/**
 * Policy Decision Point (PDP) for extension capability checks.
 *
 * This is the SINGLE place that maps grants → allow/deny decisions.
 * Every privileged operation (Phase 1: tool dispatch; Phases 2-7:
 * reverse-RPC handlers, network/fs handlers, MCP proxy) must call
 * `engine.authorize(ctx, needed)` and route on the returned decision.
 *
 * Decisions:
 *   • `allow`  — every needed cap is covered by the effective grant.
 *   • `deny`   — at least one needed cap is missing; reason names it.
 *   • `prompt` — every cap granted, BUT a sensitive cap (shell/fs.write)
 *     lacks an always-allow row. Phase 6 wires the UI; in Phase 1 the
 *     ToolExecutor treats `prompt` the same as `allow` (no behavioral
 *     regression) and the audit row records `PERM_PROMPTED`.
 *
 * Every decision writes one `auditLog` row via `insertAuditEntry`. The
 * row's `metadata` field carries the full decision context plus a
 * `parentAuditId` chain so a sub-conversation's spawn can be traced
 * back to the originating tool call.
 *
 * Fail-closed contract: `createPermissionEngine` throws if any
 * dependency is missing. `ToolExecutor.constructor` requires the
 * engine — there is no `if (engine)` shortcut anywhere downstream.
 */

import type { ExtensionRegistry } from "./registry";
import type { EventBus } from "../runtime/events";
import type { AgentEvents } from "../types";
import {
  firstMissingCapability,
  grantsToCapabilitySet,
  SENSITIVE_KINDS,
  type Capability,
  type CapabilitySet,
} from "./capability-types";
import {
  AUDIT_PERM_ALLOWED,
  AUDIT_PERM_DENIED,
  AUDIT_PERM_PROMPTED,
} from "./audit-actions";
import { insertAuditEntry } from "../db/queries/audit-log";
import { logger } from "../logger";
import {
  alwaysAllowSettingKey,
  buildAlwaysAllowValue,
  parseAlwaysAllowValue,
  type AlwaysAllowScope,
} from "./permissions";
import { getSetting, upsertSetting } from "../db/queries/settings";
import { getConversationExtensionEffectiveGrants } from "../db/queries/conversation-extensions";
import { getConversationSpawnParentAuditId } from "../db/queries/conversations";
import type { ExtensionPermissions } from "./types";

// ── Phase 54 SEC-01 — TTL-bounded conversation-override cache ───────
//
// Primed by `primeConversationOverrideCache` (called from
// `addConversationExtensions` when an `effectiveGrantedPermissions`
// field is supplied — the spawn-assignment path). Read in
// `loadConversationOverride` BEFORE the DB query so PGlite warm-up lag
// at boot doesn't cascade to bundled-extension boot-spawn flakes (see
// `tasks/v1.3-security-review.md` CC1 + roadmap Pitfall 1). Bounded by
// active conversation count × wired extension count; lazy expiry on
// `get` keeps memory honest without a background sweeper.
//
// Module-scoped (not factory-scoped) because the prime caller
// (`addConversationExtensions`) doesn't have an engine handle — the
// `allowCache` is per-engine because it's tied to `resolvePrompt`
// lifecycle, but the override cache is process-scoped.
//
// Plan 02 swap (NOT in this plan): `loadConversationOverride`'s
// catch block currently returns null on DB failure. Plan 02 will
// swap to throw + caller upgrades the decision to fail-CLOSED.

interface OverrideCacheEntry {
  value: ExtensionPermissions | null;
  expiresAt: number;
}
const overrideCache = new Map<string, OverrideCacheEntry>();
const OVERRIDE_CACHE_TTL_MS = 60_000;

function overrideCacheKey(convId: string, extId: string): string {
  return `${convId}:${extId}`;
}

/**
 * Prime the conversation-override cache. Called from
 * `addConversationExtensions` when an `effectiveGrantedPermissions`
 * field is supplied (the spawn-assignment path). The messageToolbar
 * auto-wire path (no override) deliberately does NOT prime — the
 * registry fallback at `loadConversationOverride` returning null is
 * correct without warm-up risk.
 */
export function primeConversationOverrideCache(
  conversationId: string,
  extensionId: string,
  value: ExtensionPermissions | null,
): void {
  overrideCache.set(overrideCacheKey(conversationId, extensionId), {
    value,
    expiresAt: Date.now() + OVERRIDE_CACHE_TTL_MS,
  });
}

/** Test-only: drop the override cache. Mirrors `_resetCacheForTests`. */
export function _resetOverrideCacheForTests(): void {
  overrideCache.clear();
}

// ── Public surface ──────────────────────────────────────────────────

export interface AuthorizeContext {
  extensionId: string;
  /**
   * Phase 6: missing user/context becomes JSON `null` in audit rows
   * instead of the literal string `"unknown"`. The PDP type widens to
   * `string | null` so callers (`tool-executor.ts`, handlers) can pass
   * null directly without sentinel translation.
   */
  userId: string | null;
  conversationId: string | null;
  toolName?: string;
  /** Cross-extension call (Phase 4): the original caller's id. */
  callerExtensionId?: string;
  /**
   * Effective capability set when the request comes via `ezcorp/invoke`.
   * Phase 4 will populate this with `intersect(callerCaps, calleeCaps)`;
   * Phase 1 only plumbs the field. When provided, the engine uses it as
   * the effective grant set instead of the registry value.
   */
  capContext?: CapabilitySet;
  parentAuditId?: string;
}

export type Decision =
  | { decision: "allow"; auditId: string }
  | { decision: "deny"; reason: string; auditId: string; missing?: Capability }
  | { decision: "prompt"; promptId: string; auditId: string; sensitive: Capability };

export interface PermissionEngineDeps {
  registry: ExtensionRegistry;
  bus: EventBus<AgentEvents>;
  /**
   * Optional logger for diagnostic output. Has no audit semantics —
   * audit rows always go through `insertAuditEntry`. Defaults to a
   * no-op so engine construction works in tests without wiring a
   * logger.
   */
  logger?: { warn: (msg: string, meta?: Record<string, unknown>) => void };
  /**
   * Opaque db token. Audit + always-allow persistence go through the
   * shared `db/connection.ts → getDb()` helper, so a token is not
   * structurally required. The token is accepted (and validated) to
   * satisfy the spec's "fail-closed if any dep missing" contract:
   * passing `undefined` (or omitting the token) throws.
   *
   * Tests pass an opaque truthy value (`{}`); production passes the
   * real db connection getter. Will be tightened in Phase 6 once we
   * migrate audit writes to a request-scoped tx.
   */
  db?: unknown;
}

export interface PermissionEngine {
  authorize(ctx: AuthorizeContext, needed: CapabilitySet): Promise<Decision>;
  /**
   * Resolve a pending sensitive-cap prompt by writing the always-allow
   * row for the (user, scope, scopeId, capability) tuple.
   *
   * Phase 56 widens the signature with an optional `options.ttlOverrideMs`
   * carrying the picker's per-row TTL choice (positive number for a
   * bounded override, `null` for Never, or omit for the legacy
   * TTL_CONFIG fallback). `expiresAt` is materialized inside this
   * function (`now + ttlOverrideMs`) so admin UI / audit consumers see
   * the absolute timestamp directly.
   */
  resolvePrompt(
    promptId: string,
    allowed: boolean,
    scope: AlwaysAllowScope,
    scopeId: string,
    options?: { ttlOverrideMs?: number | null },
  ): Promise<void>;
  /** Test-only: drop the in-memory always-allow cache + pending prompts. */
  _resetCacheForTests(): void;
}

// ── Implementation ──────────────────────────────────────────────────

/**
 * Construct a fresh PermissionEngine. The result is intended to be a
 * process-singleton — see `getPermissionEngine()` below for the
 * canonical factory. Hot tests still call this directly to inject a
 * mock registry / bus.
 */
export function createPermissionEngine(deps: PermissionEngineDeps): PermissionEngine {
  if (!deps) throw new Error("PermissionEngine requires deps");
  if (!deps.registry) throw new Error("PermissionEngine requires registry");
  if (!deps.bus) throw new Error("PermissionEngine requires bus");
  if (deps.db === undefined) {
    throw new Error("PermissionEngine requires db (pass an opaque token in tests)");
  }

  // In-memory always-allow cache. Key shape:
  // `${extensionId}:${userId}:${scope}:${scopeId}:${capKind}:${capValue ?? ""}`.
  // Populated lazily on first miss; updated by `resolvePrompt`. Bounded
  // by extension count × user count × scope count × cap count — fine
  // for any plausible workload.
  const allowCache = new Map<string, boolean>();

  // Pending-prompt registry. Populated when the engine returns a
  // `prompt` decision; consumed when the UI calls `resolvePrompt`.
  // Phase 1 only writes here (Phase 6 reads).
  const pendingPrompts = new Map<
    string,
    { extensionId: string; userId: string; capability: Capability }
  >();

  async function authorize(
    ctx: AuthorizeContext,
    needed: CapabilitySet,
  ): Promise<Decision> {
    const auditId = crypto.randomUUID();

    // Phase 4 §M2 — resolve parentAuditId if the caller didn't set
    // one. Spawned-child conversations have a `spawnParentAuditId`
    // seed stored on `conversations.metadata` by the spawn-assignment
    // handler; the engine reads it once per authorize() so every
    // tool call inside the child threads its audit chain back to
    // the spawn's authorize row.
    let parentAuditId = ctx.parentAuditId;
    if (parentAuditId === undefined) {
      try {
        parentAuditId = (await loadSpawnParentAuditId(ctx.conversationId)) ?? undefined;
      } catch {
        // Fallback: leave undefined — audit chain will simply not
        // reach the spawn root, but the call still succeeds.
      }
    }
    const ctxWithChain: AuthorizeContext = {
      ...ctx,
      ...(parentAuditId !== undefined ? { parentAuditId } : {}),
    };

    // 1. Compute effective grant set.
    //
    // Resolution order (most-specific first):
    //   a. `ctx.capContext` — provided by `handlePiInvoke` for cross-
    //      extension calls; the caller×callee intersected set.
    //   b. Per-conversation effective grant override (Phase 4 §6.4) —
    //      written by `spawn-assignment-handler` so a sub-conversation
    //      can be capped by `intersect(parent, child-agent)` without
    //      mutating the extension's installed grants.
    //   c. Extension's installed grants from the registry (default).
    let granted: CapabilitySet;
    if (ctx.capContext) {
      granted = ctx.capContext;
    } else {
      let override: ExtensionPermissions | null;
      try {
        override = await loadConversationOverride(
          ctx.conversationId,
          ctx.extensionId,
        );
      } catch (error) {
        // Phase 54 SEC-01 (swap) — post-cache DB failure → fail-closed
        // deny. Plan 01's cache absorbs warm-up lag; if we still throw
        // after the cache miss, the underlying DB is unhealthy and
        // silent registry-grant widening would be a security
        // regression (CC1 close-out — see tasks/v1.3-security-review.md).
        const reason = "override-lookup-failed";
        await writeAuditRow(AUDIT_PERM_DENIED, auditId, ctxWithChain, undefined, reason, {
          underlyingError: error instanceof Error ? error.message : String(error),
        });
        return { decision: "deny", reason, auditId };
      }
      granted = override
        ? grantsToCapabilitySet(override)
        : grantedFromRegistry(deps.registry, ctx.extensionId);
    }

    // 2. Subset check. The first missing cap is the deny reason.
    const missing = firstMissingCapability(needed, granted);
    if (missing) {
      const reason = formatMissingReason(missing, ctx.toolName);
      await writeAuditRow(AUDIT_PERM_DENIED, auditId, ctxWithChain, missing, reason);
      return { decision: "deny", reason, auditId, missing };
    }

    // 3. Sensitive-cap gate. If any needed cap is sensitive AND no
    //    always-allow row exists for the (user, scope, scopeId, kind)
    //    tuple, return `prompt`. Phase 6 wires the UI in
    //    `tool-executor.ts` — the gate awaits the user's
    //    `{allowed, scope}` decision and persists the chosen scope via
    //    `resolvePrompt` below, which is the single writer for
    //    always-allow rows (kind-only key — clicking "Allow forever"
    //    grants the kind for ANY value, e.g. any path under fs.write).
    const sensitive = needed.find((c) => SENSITIVE_KINDS.has(c.kind));
    if (sensitive) {
      // `ezcorp:extension:install` is NEVER persisted as an
      // always-allow grant (every install is individually consented).
      // Force the read to "not allowed" so a stray/legacy row can
      // never suppress the prompt — defence-in-depth alongside the
      // non-persist carve-out in `resolvePrompt`.
      const allowed =
        sensitive.kind === "ezcorp:extension:install"
          ? false
          : await isAlwaysAllowed(allowCache, ctx, sensitive);
      if (!allowed) {
        // Bundled-ceiling auto-allow. Bundled extensions are first-party
        // code shipped in `src/extensions/bundled.ts`; their declared
        // sensitive caps were vetted into the bundled ceiling at install
        // and ALREADY passed the subset check above (needed ⊆ granted).
        // The interactive sensitive prompt exists to gate third-party /
        // user-authored extensions — forcing it on bundled extensions
        // (e.g. extension-author writing inside its own declared
        // `.ezcorp/extension-data` dir) only produced an unanswerable
        // gate and a permanently "stuck" chat. Audited with an explicit
        // reason so a security review can see WHY it wasn't prompted.
        // Fail-closed: a registry without `isBundled` (older/mock) →
        // `undefined === true` → false → fall through to the prompt.
        // Carve-out: `ezcorp:extension:install` MUST always prompt,
        // even though extension-author is bundled. The bundled
        // auto-allow exists so first-party code doesn't hit an
        // unanswerable fs/shell gate — but installing model-authored
        // code is precisely the decision a human must make every
        // time, so this kind is excluded from the bypass.
        if (
          sensitive.kind !== "ezcorp:extension:install" &&
          deps.registry.isBundled?.(ctx.extensionId) === true
        ) {
          await writeAuditRow(
            AUDIT_PERM_ALLOWED,
            auditId,
            ctxWithChain,
            sensitive,
            "bundled-ceiling-auto-allow",
          );
          return { decision: "allow", auditId };
        }
        const promptId = crypto.randomUUID();
        pendingPrompts.set(promptId, {
          extensionId: ctx.extensionId,
          userId: ctx.userId ?? "",
          capability: sensitive,
        });
        await writeAuditRow(
          AUDIT_PERM_PROMPTED,
          auditId,
          ctxWithChain,
          sensitive,
          undefined,
          { promptId },
        );
        return { decision: "prompt", promptId, auditId, sensitive };
      }
    }

    // 4. Allow.
    await writeAuditRow(AUDIT_PERM_ALLOWED, auditId, ctxWithChain, undefined);
    return { decision: "allow", auditId };
  }

  async function resolvePrompt(
    promptId: string,
    allowed: boolean,
    scope: AlwaysAllowScope,
    scopeId: string,
    options?: { ttlOverrideMs?: number | null },
  ): Promise<void> {
    const pending = pendingPrompts.get(promptId);
    if (!pending) {
      // Unknown prompt id — log via injected logger and return.
      // Phase 6 may surface a UI error.
      deps.logger?.warn("PermissionEngine.resolvePrompt: unknown promptId", {
        promptId,
      });
      return;
    }
    pendingPrompts.delete(promptId);

    if (!allowed) {
      // User declined: do not persist. The next sensitive call will
      // re-prompt. No audit row here — the deny is implicit at the
      // caller, which writes its own decision.
      return;
    }

    // `ezcorp:extension:install` is intentionally one-shot: an
    // approval authorizes THIS install only. Returning before the
    // upsert means no always-allow row (and no cache entry) is ever
    // written, so every subsequent install re-prompts regardless of
    // the scope the UI sent. Paired with the read-side force-false in
    // `authorize` above.
    if (pending.capability.kind === "ezcorp:extension:install") {
      return;
    }

    const settingKey = alwaysAllowSettingKey({
      extensionId: pending.extensionId,
      userId: pending.userId,
      scope,
      scopeId,
      capability: alwaysAllowCapKey(pending.capability),
    });
    // Cap-expiry Phase 1: write the `{allowed, grantedAt}` shape so a
    // future sweep can age this row out. Legacy boolean is never
    // written by new code.
    //
    // Phase 56: thread the picker's `ttlOverrideMs` + a freshly-
    // materialized `expiresAt` onto the row when supplied. Empty
    // options object stays byte-identical to pre-Phase-56 output
    // (per buildAlwaysAllowValue's contract — Plan 56-01).
    const now = Date.now();
    const ttlOverrideMs = options?.ttlOverrideMs;
    const expiresAt =
      ttlOverrideMs === null
        ? null
        : ttlOverrideMs !== undefined
          ? now + ttlOverrideMs
          : undefined;
    await upsertSetting(
      settingKey,
      buildAlwaysAllowValue(true, now, { ttlOverrideMs, expiresAt }),
    );

    // Update cache for this exact tuple so the next authorize call
    // sees the new value without a DB round-trip.
    const cacheKey = cacheKeyOf(
      pending.extensionId,
      pending.userId,
      scope,
      scopeId,
      pending.capability,
    );
    allowCache.set(cacheKey, true);
  }

  function _resetCacheForTests(): void {
    allowCache.clear();
    pendingPrompts.clear();
  }

  return { authorize, resolvePrompt, _resetCacheForTests };
}

// ── Singleton factory ──────────────────────────────────────────────
//
// Mirrors the `ExtensionRegistry.getInstance()` pattern. Lifted to a
// module-scoped singleton so the many short-lived `ToolExecutor`
// instances spawned per turn share one engine — and one always-allow
// cache. Production wires the registry + bus once at boot via
// `getPermissionEngine(...)`; tests reset it via
// `_resetPermissionEngineForTests`.

let singleton: PermissionEngine | null = null;
let singletonDeps: PermissionEngineDeps | null = null;

export function getPermissionEngine(deps?: PermissionEngineDeps): PermissionEngine {
  if (singleton) return singleton;
  if (!deps) {
    throw new Error(
      "PermissionEngine not initialized — first call must provide deps " +
        "(see runtime boot for the canonical wiring)",
    );
  }
  singleton = createPermissionEngine(deps);
  singletonDeps = deps;
  return singleton;
}

/** Test-only: drop the singleton so each test file gets a fresh instance. */
export function _resetPermissionEngineForTests(): void {
  singleton = null;
  singletonDeps = null;
}

/**
 * Test-only: install an arbitrary PermissionEngine implementation as
 * the singleton. Bypasses the deps validators so tests can install
 * stubs (e.g. `createStubPermissionEngine` from
 * `__tests__/helpers/permission-engine-stub.ts`) without wiring up a
 * real registry / bus / db. Tests that exercise wiring helpers like
 * `wireOrchestrationToolsForTurn` (which call the bare `getPermissionEngine()`)
 * use this to satisfy the fail-closed contract.
 */
export function _setPermissionEngineForTests(engine: PermissionEngine): void {
  singleton = engine;
  singletonDeps = null;
}

/** Test-only: peek at the deps the singleton was constructed with. */
export function _getPermissionEngineDepsForTests(): PermissionEngineDeps | null {
  return singletonDeps;
}

// ── Helpers ─────────────────────────────────────────────────────────

function grantedFromRegistry(
  registry: ExtensionRegistry,
  extensionId: string,
): CapabilitySet {
  // Phase 4 §M6 — single flattener. Both the registry-grant path
  // here and the per-conversation override path above funnel through
  // `grantsToCapabilitySet` from capability-types.ts so the two
  // routes produce identical cap shapes.
  return grantsToCapabilitySet(registry.getGrantedPermissions(extensionId));
}

/**
 * Phase 4: per-conversation effective grant override lookup.
 *
 * Returns the override row (if any) for the (conversation, extension)
 * pair from the cache or the DB. Plan 01's TTL-bounded cache absorbs
 * the PGlite warm-up window; if a DB read STILL throws after a cache
 * miss, the throw bubbles up to `authorize`, which catches it and
 * upgrades the decision to fail-CLOSED:
 *   `{decision: "deny", reason: "override-lookup-failed"}`.
 *
 * Phase 54 SEC-01 swap (Plan 02): inverted from Plan 01's null-fallback
 * semantic. With the cache in place, a true post-cache DB failure
 * means the DB is unhealthy — silent registry-grant widening would be
 * a security regression (CC1 close-out — see
 * tasks/v1.3-security-review.md).
 *
 * "unknown" / missing conversationId short-circuits to null so the
 * many test contexts that pass `conversationId: "unknown"` don't
 * accidentally trigger DB queries.
 */
async function loadConversationOverride(
  conversationId: string | null,
  extensionId: string,
): Promise<ExtensionPermissions | null> {
  // Phase 6: null is the canonical "no scope" signal; we still tolerate
  // legacy `"unknown"` / `"cross-ext"` strings during the migration so
  // tests that haven't been updated continue to short-circuit. New
  // callers should pass null.
  if (!conversationId || conversationId === "unknown" || conversationId === "cross-ext") {
    return null;
  }
  // Phase 54 SEC-01 — cache read BEFORE the DB query. The cache is
  // primed by `addConversationExtensions` when a spawn-assignment writes
  // an `effectiveGrantedPermissions` field, so the bundled boot-spawn
  // chain hits primed entries even while PGlite is still warming up.
  // Lazy expiry: drop expired entries on `get` so memory stays bounded
  // without a background sweeper.
  const cacheKey = overrideCacheKey(conversationId, extensionId);
  const cached = overrideCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.value;
  }
  if (cached) overrideCache.delete(cacheKey); // expired — drop opportunistically
  // Phase 54 SEC-01 (swap) — post-cache DB failure now BUBBLES UP.
  // The caller in authorize() catches the throw and emits a deny
  // decision with reason "override-lookup-failed" + an audit row.
  // Plan 01 added the cache absorption layer; this swap makes the
  // post-cache failure path strictly fail-closed.
  const value = await getConversationExtensionEffectiveGrants(conversationId, extensionId);
  overrideCache.set(cacheKey, { value, expiresAt: Date.now() + OVERRIDE_CACHE_TTL_MS });
  return value;
}

/**
 * Phase 4 §M2 — read the spawn-authorize audit id seeded on the
 * conversation by `spawn-assignment-handler`. Returns `null` for
 * top-level conversations or DB blips. The engine uses this as the
 * `parentAuditId` for every authorize() inside a spawned child so
 * the audit chain reaches the spawn's root row.
 */
async function loadSpawnParentAuditId(
  conversationId: string | null,
): Promise<string | null> {
  if (!conversationId || conversationId === "unknown" || conversationId === "cross-ext") {
    return null;
  }
  try {
    return await getConversationSpawnParentAuditId(conversationId);
  } catch {
    return null;
  }
}

function formatMissingReason(missing: Capability, toolName?: string): string {
  const valuePart = missing.value ? ` (${missing.value})` : "";
  const toolPart = toolName ? ` for tool "${toolName}"` : "";
  return `Missing capability ${missing.kind}${valuePart}${toolPart}`;
}

/**
 * Always-allow grants are kind-only: clicking "Allow forever" on a
 * sensitive prompt grants the kind for ANY value (any path under
 * `fs.write`, any command under `shell`). This collapses both writer
 * and reader to one key shape so a value-carrying lookup (e.g.
 * `fs.write:/tmp/x`) matches a grant that was written for the kind.
 *
 * Bug context: pre-fix, the writer wrote `:fs.write` while the reader
 * looked up `:fs.write:<path>` — they never matched, so users hitting
 * Allow Forever still re-prompted on every subsequent call.
 */
function alwaysAllowCapKey(c: Capability): string {
  return c.kind;
}

function cacheKeyOf(
  extensionId: string,
  userId: string | null,
  scope: AlwaysAllowScope,
  scopeId: string,
  c: Capability,
): string {
  // Phase 6: null userId is encoded as empty in the cache key. Keys are
  // local to one process; collision-safety is the same as before.
  return `${extensionId}:${userId ?? ""}:${scope}:${scopeId}:${alwaysAllowCapKey(c)}`;
}

/**
 * Look up always-allow for the (user, scope, scopeId, cap) tuple.
 * Tries each scope in order: conversation > forever. The caller's
 * `ctx.conversationId` is used as the conversation scopeId. Session
 * and project scopes are not yet emitted by the UI (Phase 6 will);
 * declared in `AlwaysAllowScope` for the future.
 */
async function isAlwaysAllowed(
  cache: Map<string, boolean>,
  ctx: AuthorizeContext,
  cap: Capability,
): Promise<boolean> {
  // Phase 6: null userId can't have a per-user always-allow row; null
  // conversationId can't have a conversation-scoped row. Skip those
  // candidates rather than constructing keys with empty strings.
  if (!ctx.userId) return false;

  const candidates: { scope: AlwaysAllowScope; scopeId: string }[] = [];
  if (ctx.conversationId) {
    candidates.push({ scope: "conversation", scopeId: ctx.conversationId });
    // Phase 6: also check session scope (cleared on restart) and
    // project scope (deferred — uses conversationId today; the cache
    // accommodates a future project lookup).
    candidates.push({ scope: "session", scopeId: `session:${ctx.userId}` });
    candidates.push({ scope: "project", scopeId: ctx.conversationId });
  }
  candidates.push({ scope: "forever", scopeId: "*" });

  for (const c of candidates) {
    const key = cacheKeyOf(ctx.extensionId, ctx.userId, c.scope, c.scopeId, cap);
    const cached = cache.get(key);
    if (cached === true) return true;
    if (cached === false) continue;

    const settingKey = alwaysAllowSettingKey({
      extensionId: ctx.extensionId,
      userId: ctx.userId,
      scope: c.scope,
      scopeId: c.scopeId,
      capability: alwaysAllowCapKey(cap),
    });
    const value = await getSetting(settingKey);
    // Cap-expiry Phase 1: read accepts BOTH legacy `boolean` and the
    // new `{allowed, grantedAt}` shape. Legacy `true` is treated as
    // "allowed, never expires" (Phase 2 sweep skips it).
    const allowed = parseAlwaysAllowValue(value) === "allowed";
    cache.set(key, allowed);
    if (allowed) return true;
  }

  return false;
}

// Strip C0 + DEL control chars from any user / extension-supplied
// string before it lands in the audit log (closes XSS/injection
// finding H4). The intentional control-character class is the whole
// point of the regex — biome's noControlCharactersInRegex is the
// wrong heuristic here.
// biome-ignore lint/suspicious/noControlCharactersInRegex: control-char strip is intentional
const CTRL_CHARS = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g;
const MAX_LOG_STR = 1024;

function sanitize(s: string): string {
  let out = s.replace(CTRL_CHARS, "");
  if (out.length > MAX_LOG_STR) out = `${out.slice(0, MAX_LOG_STR)}…`;
  return out;
}

async function writeAuditRow(
  action: string,
  auditId: string,
  ctx: AuthorizeContext,
  cap: Capability | undefined,
  reason?: string,
  extra?: Record<string, unknown>,
): Promise<void> {
  // Phase 6 — null userId/conversationId serialize as JSON null in the
  // metadata row, NOT the literal string "unknown". Empty strings are
  // also treated as null (legacy callers that haven't migrated to the
  // null contract). The audit_log column accepts null on both fields,
  // so analytics consumers see clean nulls rather than sentinel
  // strings.
  const conversationId =
    ctx.conversationId &&
    ctx.conversationId !== "unknown" &&
    ctx.conversationId !== "cross-ext"
      ? ctx.conversationId
      : null;

  const metadata: Record<string, unknown> = {
    auditId,
    toolName: ctx.toolName ? sanitize(ctx.toolName) : undefined,
    capabilityKind: cap?.kind,
    capabilityValue: cap?.value !== undefined ? sanitize(cap.value) : undefined,
    reason: reason !== undefined ? sanitize(reason) : undefined,
    parentAuditId: ctx.parentAuditId,
    callerExtensionId: ctx.callerExtensionId,
    conversationId,
    ...extra,
  };

  // Drop undefined keys for a cleaner audit row. `null` stays — it's
  // the canonical "no scope" signal for analytics.
  for (const k of Object.keys(metadata)) {
    if (metadata[k] === undefined) delete metadata[k];
  }

  try {
    await insertAuditEntry(
      ctx.userId && ctx.userId !== "unknown" ? ctx.userId : null,
      action,
      ctx.extensionId,
      metadata,
    );
  } catch (error) {
    // Phase 54 SEC-02 — dropped audit rows are now observable in
    // stderr AND persisted to error_logs (logger.error has a
    // recursion-guarded fire-and-forget hook to error_logs at
    // src/logger.ts:41-46). The PDP's primary job (decision)
    // already succeeded; this is the secondary observability path
    // for compliance auditors.
    logger.error("PermissionEngine: audit-write failure", {
      action,
      extensionId: ctx.extensionId,
      capabilityKind: cap?.kind,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
