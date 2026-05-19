/**
 * Permission middleware for built-in tools.
 *
 * Controls which tool categories auto-approve vs require user confirmation,
 * with per-project settings storage and an async approval gate mechanism.
 */

import { getSetting } from "../../db/queries/settings";
import type { ToolCategory } from "./types";

// ── Types ───────────────────────────────────────────────────────────

// Re-export so existing callers that import ToolCategory from this module
// keep working — the type now lives in `./types` (single source of truth).
// Phase 48 added 'ez' to the union; Ez tools are always auto-approved
// (they're proposal/informational, the user's own panel triggers them,
// and the actual mutation surface is the destination form's Submit
// button — no LLM-driven side effects to gate on).
export type { ToolCategory };
export type PermissionMode = "ask" | "auto-edit" | "yolo";

const VALID_MODES = new Set<PermissionMode>(["ask", "auto-edit", "yolo"]);

// ── Permission Matrix ───────────────────────────────────────────────

const AUTO_APPROVE: Record<PermissionMode, Set<ToolCategory>> = {
  ask: new Set<ToolCategory>(["read", "ez"]),
  "auto-edit": new Set<ToolCategory>(["read", "write", "ez"]),
  yolo: new Set<ToolCategory>(["read", "write", "execute", "ez"]),
};

/**
 * Returns true if the given tool category requires user approval under the given mode.
 */
export function needsApproval(category: ToolCategory, mode: PermissionMode): boolean {
  return !AUTO_APPROVE[mode].has(category);
}

// ── Permission Mode Lookup ──────────────────────────────────────────

/**
 * Get the permission mode for a project.
 * Uses sessionOverride if provided, otherwise looks up stored setting, defaults to "ask".
 */
export async function getPermissionMode(
  projectId: string,
  sessionOverride?: PermissionMode,
): Promise<PermissionMode> {
  if (sessionOverride) return sessionOverride;

  const stored = await getSetting(`project:${projectId}:tool_permission_mode`);
  if (typeof stored === "string" && VALID_MODES.has(stored as PermissionMode)) {
    return stored as PermissionMode;
  }
  return "ask";
}

// ── Permission Gate ─────────────────────────────────────────────────

import type { AlwaysAllowScope } from "../../extensions/permissions";

/**
 * Phase 6 — extension-scoped permission gate metadata.
 *
 * Built-in tool gates resolve void (resolve() / reject()). Extension
 * gates additionally need to surface the user's chosen scope (session/
 * conversation/project/forever) so the resolving caller can persist the
 * always-allow row at the right scope tuple. We model the resolution
 * via a discriminated `ApprovalResolution` union — `allowed` flag plus
 * an optional scope. Built-in gates use the legacy void-resolve path
 * (no behavior change for existing callers); extension gates use
 * `createExtensionPermissionGate` which awaits an `ApprovalResolution`.
 */
export interface ApprovalResolution {
  allowed: boolean;
  /**
   * User-chosen always-allow scope. Required when `allowed === true` and
   * the request was extension-scoped; optional / ignored otherwise.
   */
  scope?: AlwaysAllowScope;
  /**
   * Phase 56 (per-capability TTL UI): user-chosen per-row TTL override.
   *   • `null`      — picker "Never" selection. Persists onto the
   *     always-allow row so the sweep evaluator skips it (Pitfall 6).
   *   • `number`    — positive finite override in ms. Wins over both
   *     TTL_CONFIG[kind] and foreverTtlMs.
   *   • `undefined` — picker omitted (legacy callers). Sweep falls back
   *     to the existing TTL_CONFIG[kind] / foreverTtlMs lookup.
   *
   * Validated upstream by `parseTtlOverrideMs` (`src/extensions/
   * ttl-validate.ts`); 0 / negative / NaN / Infinity never reach here.
   */
  ttlOverrideMs?: number | null;
}

interface PendingApproval {
  resolve: () => void;
  reject: (err: Error) => void;
  // sec-H2: conversation this gate belongs to, so the HTTP handler that
  // resolves it can verify the caller owns the conversation before acting.
  conversationId?: string;
  /**
   * Phase 6: extension-scoped gate marker. When set, the gate was
   * created by `createExtensionPermissionGate` and the resolver
   * (`resolvePermission`) MUST be called with a structured payload
   * (`approved + scope`). The legacy void-resolve `resolvePermission`
   * path still works on built-in gates whose `extension` field is
   * undefined.
   */
  extension?: ExtensionGateMeta;
}

interface ExtensionGateMeta {
  extensionId: string;
  userId: string;
  /**
   * Sensitive capability that triggered the prompt. The resolver uses
   * this to derive the legacy `shell|filesystem` operation name when
   * persisting the always-allow row via `setSensitiveAlwaysAllow`.
   */
  capabilityKind: "shell" | "fs.write";
  /**
   * Resolution promise — extension gates resolve to an
   * `ApprovalResolution`, not void. Stored separately from the
   * void-shaped `resolve` so the legacy gate path can stay simple.
   */
  resolveDetailed: (r: ApprovalResolution) => void;
}

const pendingApprovals = new Map<string, PendingApproval>();

/**
 * Create a permission gate that blocks until the user approves or denies.
 * Returns a promise that resolves on approval or rejects on denial.
 *
 * `conversationId` (optional) is stored alongside the gate so the route
 * handler can look up the conversation owner for a sec-H2 ownership check
 * before calling `resolvePermission`. Callers in the executor pass it.
 */
export function createPermissionGate(
  toolCallId: string,
  conversationId?: string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    pendingApprovals.set(toolCallId, { resolve, reject, conversationId });
  });
}

/**
 * Phase 6 — request used to open an extension-scoped permission gate.
 *
 * Mirrors the data already on the `tool:permission_request` bus event
 * for extension calls (`extensionId`, `capabilityKind`, `capabilityValue`)
 * so the SSE-side modal renders without an extra round-trip.
 */
export interface ExtensionPermissionRequest {
  /** PDP-minted prompt id. Becomes the gate's lookup key. */
  promptId: string;
  conversationId: string;
  userId: string;
  extensionId: string;
  toolName: string;
  /** Sensitive cap kind. Today the engine returns prompt only for
   *  `shell` and `fs.write` — see `SENSITIVE_KINDS` in capability-types.ts. */
  capabilityKind: "shell" | "fs.write";
  /** Sensitive cap value (e.g. concrete path for fs.write). */
  capabilityValue?: string;
}

/**
 * Phase 6 — open a permission gate for an extension-scoped request and
 * await the user's `{allowed, scope}` decision.
 *
 * Reuses the same `pendingApprovals` Map keyed by `promptId` (the PDP
 * mints one per `decision: "prompt"` return). When the user responds
 * via the `/api/tool-calls/:id/permission` route, the resolver
 * (`resolvePermission`) recognizes the extension-gate metadata and
 * resolves the structured `ApprovalResolution` instead of the legacy
 * void path.
 *
 * The caller (Phase 6 wired in `executeToolCall`'s `prompt` branch)
 * is responsible for:
 *   1. Persisting the always-allow row at the chosen scope via
 *      `setSensitiveAlwaysAllow` — capability kind translates as
 *      `"shell"` → "shell", `"fs.write"` → "filesystem" (matches
 *      legacy operation names the persistence layer expects).
 *   2. Re-running the tool call once `{allowed: true}` arrives.
 */
export function createExtensionPermissionGate(
  req: ExtensionPermissionRequest,
): Promise<ApprovalResolution> {
  return new Promise<ApprovalResolution>((resolve, _reject) => {
    pendingApprovals.set(req.promptId, {
      // Legacy resolve/reject are no-ops on extension gates — the
      // structured `resolveDetailed` path drives resolution. We still
      // populate them so the same Map shape works in `getPendingApproval`.
      resolve: () => resolve({ allowed: true, scope: "session" }),
      reject: () => resolve({ allowed: false }),
      conversationId: req.conversationId,
      extension: {
        extensionId: req.extensionId,
        userId: req.userId,
        capabilityKind: req.capabilityKind,
        resolveDetailed: resolve,
      },
    });
  });
}

/**
 * Returns the conversationId associated with a pending gate, or undefined
 * if no gate is pending (or the gate was created without one).
 * Used by the POST /api/tool-calls/:id/permission handler to authorize the
 * caller against the gate's owning conversation (sec-H2).
 */
export function getPendingApprovalConversation(
  toolCallId: string,
): string | undefined {
  return pendingApprovals.get(toolCallId)?.conversationId;
}

/**
 * Resolve a pending permission gate.
 *
 * Built-in tool gate (legacy): pass `approved` only. The gate promise
 * resolves on `true`, rejects with `"Permission denied"` on `false`.
 *
 * Extension-scoped gate (Phase 6): pass `approved` + the user-chosen
 * `scope`. The gate's structured `ApprovalResolution` resolves with the
 * pair so the caller can persist the always-allow row at the right
 * scope tuple. Built-in gates ignore `scope`.
 *
 * Phase 56 (per-capability TTL UI): optional `options.ttlOverrideMs`
 * carries the picker's per-row TTL choice (positive number, null for
 * Never, or undefined for legacy callers). Threaded into the
 * `ApprovalResolution` so the executor's resolver (which writes the
 * always-allow row) can pass it to `buildAlwaysAllowValue`. Built-in
 * gates ignore the field.
 *
 * No-op if the gate id is not pending.
 */
export function resolvePermission(
  toolCallId: string,
  approved: boolean,
  scope?: AlwaysAllowScope,
  options?: { ttlOverrideMs?: number | null },
): void {
  const pending = pendingApprovals.get(toolCallId);
  if (!pending) return;

  pendingApprovals.delete(toolCallId);
  if (pending.extension) {
    // Phase 6/56: extension gate — resolve with `{allowed, scope,
    // ttlOverrideMs}`. The `ttlOverrideMs` field is set only when the
    // caller supplied one (positive number OR null); undefined stays
    // unset so the downstream writer takes the legacy fallback path.
    const resolution: ApprovalResolution = approved
      ? {
          allowed: true,
          scope: scope ?? "session",
          ...(options !== undefined && options.ttlOverrideMs !== undefined
            ? { ttlOverrideMs: options.ttlOverrideMs }
            : {}),
        }
      : { allowed: false };
    pending.extension.resolveDetailed(resolution);
    return;
  }

  // Legacy built-in gate path. Built-in gates ignore scope and
  // ttlOverrideMs — they resolve to a bare allow/deny.
  if (approved) {
    pending.resolve();
  } else {
    pending.reject(new Error("Permission denied"));
  }
}

/**
 * Check if a toolCallId has a pending approval gate.
 */
export function getPendingApproval(toolCallId: string): boolean {
  return pendingApprovals.has(toolCallId);
}

/**
 * Phase 6 — read the extension-gate metadata for a pending prompt id.
 * Returns `undefined` for unknown ids OR for built-in gates (which lack
 * the `extension` field). Used by the resolver to translate the
 * sensitive capability kind into the legacy operation name when
 * persisting the always-allow row.
 */
export function getPendingExtensionGate(
  promptId: string,
): ExtensionGateMeta | undefined {
  return pendingApprovals.get(promptId)?.extension;
}
