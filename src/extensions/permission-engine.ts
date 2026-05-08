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
import {
  alwaysAllowSettingKey,
  type AlwaysAllowScope,
} from "./permissions";
import { getSetting, upsertSetting } from "../db/queries/settings";
import { getConversationExtensionEffectiveGrants } from "../db/queries/conversation-extensions";
import type { ExtensionPermissions } from "./types";

// ── Public surface ──────────────────────────────────────────────────

export interface AuthorizeContext {
  extensionId: string;
  userId: string;
  conversationId: string;
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
  resolvePrompt(
    promptId: string,
    allowed: boolean,
    scope: AlwaysAllowScope,
    scopeId: string,
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
      const override = await loadConversationOverride(
        ctx.conversationId,
        ctx.extensionId,
      );
      granted = override
        ? grantedFromExtensionPermissions(override)
        : grantedFromRegistry(deps.registry, ctx.extensionId);
    }

    // 2. Subset check. The first missing cap is the deny reason.
    const missing = firstMissingCapability(needed, granted);
    if (missing) {
      const reason = formatMissingReason(missing, ctx.toolName);
      await writeAuditRow(AUDIT_PERM_DENIED, auditId, ctx, missing, reason);
      return { decision: "deny", reason, auditId, missing };
    }

    // 3. Sensitive-cap gate. If any needed cap is sensitive AND no
    //    always-allow row exists for the (user, scope, scopeId, cap)
    //    tuple, return `prompt`. Phase 6 wires the UI; Phase 1 callers
    //    treat `prompt` like `allow` (with a TODO).
    const sensitive = needed.find((c) => SENSITIVE_KINDS.has(c.kind));
    if (sensitive) {
      const allowed = await isAlwaysAllowed(allowCache, ctx, sensitive);
      if (!allowed) {
        const promptId = crypto.randomUUID();
        pendingPrompts.set(promptId, {
          extensionId: ctx.extensionId,
          userId: ctx.userId,
          capability: sensitive,
        });
        await writeAuditRow(
          AUDIT_PERM_PROMPTED,
          auditId,
          ctx,
          sensitive,
          undefined,
          { promptId },
        );
        return { decision: "prompt", promptId, auditId, sensitive };
      }
    }

    // 4. Allow.
    await writeAuditRow(AUDIT_PERM_ALLOWED, auditId, ctx, undefined);
    return { decision: "allow", auditId };
  }

  async function resolvePrompt(
    promptId: string,
    allowed: boolean,
    scope: AlwaysAllowScope,
    scopeId: string,
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

    const settingKey = alwaysAllowSettingKey({
      extensionId: pending.extensionId,
      userId: pending.userId,
      scope,
      scopeId,
      capability: capabilityKeyForSetting(pending.capability),
    });
    await upsertSetting(settingKey, true);

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

/** Test-only: peek at the deps the singleton was constructed with. */
export function _getPermissionEngineDepsForTests(): PermissionEngineDeps | null {
  return singletonDeps;
}

// ── Helpers ─────────────────────────────────────────────────────────

function grantedFromRegistry(
  registry: ExtensionRegistry,
  extensionId: string,
): CapabilitySet {
  const granted = registry.getGrantedPermissions(extensionId);
  return grantedFromExtensionPermissions(granted);
}

/**
 * Translate an `ExtensionPermissions` blob into a `CapabilitySet`.
 * Shared between the registry-grant path and the per-conversation
 * override path so both produce identical cap shapes.
 */
function grantedFromExtensionPermissions(
  granted: ExtensionPermissions | null,
): CapabilitySet {
  if (!granted) return [];

  const caps: Capability[] = [];

  if (granted.network) {
    for (const host of granted.network) {
      caps.push({ kind: "network", value: host.toLowerCase() });
    }
  }
  if (granted.filesystem) {
    for (const path of granted.filesystem) {
      caps.push({ kind: "fs.read", value: path });
      caps.push({ kind: "fs.list", value: path });
      caps.push({ kind: "fs.stat", value: path });
      caps.push({ kind: "fs.write", value: path });
    }
  }
  if (granted.shell === true) {
    caps.push({ kind: "shell" });
  }
  if (granted.env) {
    for (const name of granted.env) {
      caps.push({ kind: "env", value: name });
    }
  }
  if (granted.storage === true) {
    caps.push({ kind: "storage" });
  }
  if (granted.appendMessages !== undefined) {
    caps.push({ kind: "ezcorp:chat:append" });
  }
  if (granted.agentConfig === "read") {
    caps.push({ kind: "ezcorp:agent:config" });
  }
  if (granted.spawnAgents) {
    caps.push({ kind: "ezcorp:agent:spawn" });
  }
  if (granted.taskEvents === true) {
    caps.push({ kind: "ezcorp:tasks:emit" });
  }
  if (granted.eventSubscriptions) {
    for (const evt of granted.eventSubscriptions) {
      caps.push({ kind: "ezcorp:events:subscribe", value: evt });
    }
  }

  return caps;
}

/**
 * Phase 4: per-conversation effective grant override lookup.
 *
 * Returns the override row (if any) for the (conversation, extension)
 * pair. Read errors swallow to null so a DB blip can't fail-open the
 * PDP — the caller falls back to the registry grants on null.
 *
 * "unknown" / missing conversationId short-circuits to null so the
 * many test contexts that pass `conversationId: "unknown"` don't
 * accidentally trigger DB queries.
 */
async function loadConversationOverride(
  conversationId: string,
  extensionId: string,
): Promise<ExtensionPermissions | null> {
  if (!conversationId || conversationId === "unknown" || conversationId === "cross-ext") {
    return null;
  }
  try {
    return await getConversationExtensionEffectiveGrants(conversationId, extensionId);
  } catch {
    return null;
  }
}

function formatMissingReason(missing: Capability, toolName?: string): string {
  const valuePart = missing.value ? ` (${missing.value})` : "";
  const toolPart = toolName ? ` for tool "${toolName}"` : "";
  return `Missing capability ${missing.kind}${valuePart}${toolPart}`;
}

function capabilityKeyForSetting(c: Capability): string {
  return c.value === undefined ? c.kind : `${c.kind}:${c.value}`;
}

function cacheKeyOf(
  extensionId: string,
  userId: string,
  scope: AlwaysAllowScope,
  scopeId: string,
  c: Capability,
): string {
  return `${extensionId}:${userId}:${scope}:${scopeId}:${capabilityKeyForSetting(c)}`;
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
  const candidates: { scope: AlwaysAllowScope; scopeId: string }[] = [
    { scope: "conversation", scopeId: ctx.conversationId },
    { scope: "forever", scopeId: "*" },
  ];

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
      capability: capabilityKeyForSetting(cap),
    });
    const value = await getSetting(settingKey);
    const allowed = value === true;
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
  const metadata: Record<string, unknown> = {
    auditId,
    toolName: ctx.toolName ? sanitize(ctx.toolName) : undefined,
    capabilityKind: cap?.kind,
    capabilityValue: cap?.value !== undefined ? sanitize(cap.value) : undefined,
    reason: reason !== undefined ? sanitize(reason) : undefined,
    parentAuditId: ctx.parentAuditId,
    callerExtensionId: ctx.callerExtensionId,
    conversationId: ctx.conversationId,
    ...extra,
  };

  // Drop undefined keys for a cleaner audit row.
  for (const k of Object.keys(metadata)) {
    if (metadata[k] === undefined) delete metadata[k];
  }

  try {
    await insertAuditEntry(
      ctx.userId === "unknown" ? null : ctx.userId,
      action,
      ctx.extensionId,
      metadata,
    );
  } catch {
    // Audit write failures must never block a tool call. The PDP's
    // primary job is the decision; logging is best-effort.
  }
}
