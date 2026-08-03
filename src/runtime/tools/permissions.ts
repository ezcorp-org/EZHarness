/**
 * Permission middleware for built-in tools.
 *
 * Controls which tool categories auto-approve vs require user confirmation,
 * with per-project settings storage and an async approval gate mechanism.
 */

import { AsyncLocalStorage } from "node:async_hooks";
import { getSetting } from "../../db/queries/settings";
import { WORKFLOW_SCOPE_KEY_PREFIX } from "../workflow-scope-key";
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

/**
 * Default mode for a project with no explicitly-stored
 * `tool_permission_mode` setting (fresh install / never configured).
 */
export const DEFAULT_PERMISSION_MODE: PermissionMode = "yolo";

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
 * Uses sessionOverride if provided, otherwise looks up stored setting,
 * defaults to DEFAULT_PERMISSION_MODE ("yolo").
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
  return DEFAULT_PERMISSION_MODE;
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
   * Reject the gate's promise with a REAL error (as opposed to the
   * `reject` field above, which on an extension gate is re-pointed at
   * `resolve({allowed:false})` — a user *decline*, not a failure).
   * Populated for extension gates so the timeout / abort teardown paths
   * can settle the promise loudly instead of masquerading as a decline.
   */
  hardReject?: (err: Error) => void;
  /** Clear any timer / abort listener attached to this gate. Runs on every
   *  settlement path so a resolved gate leaves nothing behind. */
  cleanup?: () => void;
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
  /**
   * Sensitive cap kind, as the CALLER classified it.
   *
   * Caveat worth knowing when this value ends up in a user-facing
   * message: `SENSITIVE_KINDS` (capability-types.ts) has FOUR members —
   * `shell`, `fs.write`, `ezcorp:extension:install`,
   * `ezcorp:extension:modify` — but `executeToolCall` collapses them to
   * two (`sensitive.kind === "shell" ? "shell" : "fs.write"`) before
   * calling here, because that is the granularity the always-allow
   * persistence layer keys on. So an `ezcorp:extension:install` prompt
   * arrives labelled `fs.write`. This field reports what it was given;
   * it does not re-derive the PDP's true capability.
   */
  capabilityKind: "shell" | "fs.write";
  /** Sensitive cap value (e.g. concrete path for fs.write). */
  capabilityValue?: string;
  /**
   * Optional wall-clock bound on how long the gate may stay open before
   * it rejects with {@link PermissionGateTimeoutError}.
   *
   * DEFAULT IS UNSET — an omitted `timeoutMs` keeps the historical
   * "block until the user answers" chat semantics exactly (the chat path
   * is already bounded by the executor watchdog, which the caller
   * suspends for the duration of the prompt via
   * `registerPendingPermission`). Only non-interactive callers that have
   * no watchdog of their own should pass one.
   */
  timeoutMs?: number;
  /**
   * Optional cancellation signal. When it fires (or if it is ALREADY
   * aborted at creation time) the gate rejects with
   * {@link PermissionGateAbortedError} and drops out of
   * `pendingApprovals`, so a cancelled parent (e.g. an aborted workflow
   * run) tears its gates down instead of leaking a promise that can only
   * ever be settled by a user who will never see the prompt.
   */
  signal?: AbortSignal;
}

/**
 * A gate was opened inside an execution scope where NO human can answer
 * it (see {@link beginNonInteractiveScope}). Thrown synchronously — the
 * caller never awaits, so a sensitive capability can never hang a
 * non-interactive run.
 */
export class NonInteractiveApprovalRequiredError extends Error {
  constructor(
    readonly capabilityKind: string,
    readonly scopeKey: string,
  ) {
    super(
      `requires interactive approval for capability ${capabilityKind}, but the ` +
        `calling scope (${scopeKey}) is non-interactive`,
    );
    this.name = "NonInteractiveApprovalRequiredError";
  }
}

/** A gate was torn down by its `signal` (or its scope was cancelled). */
export class PermissionGateAbortedError extends Error {
  constructor() {
    super("permission gate aborted");
    this.name = "PermissionGateAbortedError";
  }
}

/** A gate exceeded its caller-supplied `timeoutMs` with no answer. */
export class PermissionGateTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`permission gate timed out after ${timeoutMs}ms with no response`);
    this.name = "PermissionGateTimeoutError";
  }
}

// ── Non-interactive execution scopes ────────────────────────────────
//
// A permission gate is only meaningful when SOMEONE can answer it. In a
// chat turn the prompt rides the conversation's SSE channel to the user
// who started it. A workflow run has no conversation and no live user
// attached to the dispatch, so a `prompt` decision there would park a
// promise that literally nobody can resolve — the run would hang until
// the process dies.
//
// `createExtensionPermissionGate` refuses such a gate IMMEDIATELY (no
// promise, no pending entry), recording which capability was refused so
// the caller can raise a precise, human-readable error.
//
// Refusal is decided by THREE independent checks, because key matching
// alone was demonstrably escapable (see the regression suite in
// `workflow-approval-escape.test.ts`):
//
//   1. AsyncLocalStorage — any gate opened anywhere in the dispatch's
//      async subtree, on ANY `conversationId`. This is the check that
//      makes the guarantee unconditional for in-process call chains: a
//      tool that opens a gate against some unrelated conversation id
//      still cannot park a promise the workflow would await.
//   2. The scope-key registry — the id the run passes as
//      `conversationId`. Catches reverse-RPC handlers, which run on the
//      subprocess transport's own async context and therefore do NOT
//      inherit (1).
//   3. The `NON_INTERACTIVE_KEY_PREFIX` id-space invariant. A key minted
//      by `workflowScopeKey()` names no conversation and never will, so
//      NOBODY can ever answer a gate raised against one — whether or not
//      the minting run is still live. This closes the cross-run race
//      where run B rebinds a shared subprocess's reverse-RPC handler and
//      then finishes, leaving run A's nested calls resolving to B's
//      now-deregistered key.
//
// Because a refused gate is never parked, none of the three paths can
// leak a `pendingApprovals` entry.

/**
 * Reserved `conversationId` prefix for ids that are NOT conversations.
 * `workflowScopeKey()` is the sole minter.
 *
 * The VALUE now has exactly one definition, in `../workflow-scope-key.ts`
 * — a leaf module that imports nothing, so the two persistence boundaries
 * under `src/db/queries/` can share it without this module's DB imports
 * riding along. This alias stays because it is the name every permission
 * call site already uses, and because the constant being re-exported here
 * is what stops a future edit re-typing the literal a third time.
 */
export const NON_INTERACTIVE_KEY_PREFIX = WORKFLOW_SCOPE_KEY_PREFIX;

interface NonInteractiveScope {
  /** Capability kind of the most recent refused gate, consumed by
   *  `takeDenial()`. Undefined until a gate is actually refused. */
  deniedCapabilityKind?: string;
  /** Detaches the abort listener when the scope ends. */
  cleanup: () => void;
}

const nonInteractiveScopes = new Map<string, NonInteractiveScope>();

/** Ambient scope for the CURRENT async subtree — check (1) above. */
const nonInteractiveAls = new AsyncLocalStorage<NonInteractiveScope>();

/** Handle returned by {@link beginNonInteractiveScope}. */
export interface NonInteractiveScopeHandle {
  /** Deregister the scope. Idempotent — safe to call from a `finally`. */
  end(): void;
  /**
   * Capability kind of a gate refused inside this scope since the last
   * call, or `undefined` if none was. Reading CLEARS it, so each refusal
   * is reported exactly once (the caller turns it into a step-level
   * error and must not re-attribute it to a later step).
   */
  takeDenial(): string | undefined;
  /**
   * Run `fn` with this scope ambient, so a gate opened ANYWHERE in its
   * async subtree is refused regardless of the `conversationId` it uses.
   * Wrap the actual dispatch in this — the key registry alone only
   * catches calls that faithfully propagate the scope key.
   */
  run<T>(fn: () => Promise<T>): Promise<T>;
}

/**
 * Mark `scopeKey` (the id passed as `conversationId` on every tool call
 * this scope makes) as non-interactive for the lifetime of the handle.
 *
 * `signal` is the scope's cancellation signal. When it fires, every gate
 * still pending under this key is rejected with
 * {@link PermissionGateAbortedError} — that is what makes a cancelled
 * parent tear its gates down rather than leak them.
 */
export function beginNonInteractiveScope(
  scopeKey: string,
  signal?: AbortSignal,
): NonInteractiveScopeHandle {
  const onAbort = (): void => {
    abortPendingApprovalsForScope(scopeKey);
  };
  if (signal) signal.addEventListener("abort", onAbort, { once: true });
  const scope: NonInteractiveScope = {
    cleanup: () => {
      if (signal) signal.removeEventListener("abort", onAbort);
    },
  };
  nonInteractiveScopes.set(scopeKey, scope);
  return {
    end: () => {
      scope.cleanup();
      nonInteractiveScopes.delete(scopeKey);
      // Belt-and-braces: a gate opened before the scope was registered
      // (or by a concurrent dispatch) would otherwise outlive its only
      // possible answerer.
      abortPendingApprovalsForScope(scopeKey);
    },
    takeDenial: () => {
      const kind = scope.deniedCapabilityKind;
      scope.deniedCapabilityKind = undefined;
      return kind;
    },
    run: (fn) => nonInteractiveAls.run(scope, fn),
  };
}

/**
 * Reject every pending gate whose `conversationId` matches `scopeKey`.
 *
 * Called automatically for a NON-interactive scope (on its abort signal and
 * on `end()`). Exported for the one caller that has no such scope to hang
 * it off: an INTERACTIVE workflow run
 * (`WorkflowExecutor.runWorkflow({conversationId})`) registers nothing, so
 * on cancel it must tear its own consent cards down or they stand forever
 * with no run left to answer into.
 *
 * `scopeKey` is a real conversation id in that case, so this rejects every
 * gate pending on that conversation — only ever called when the whole turn
 * is being cancelled.
 */
export function abortPendingApprovalsForScope(scopeKey: string): void {
  for (const [id, pending] of [...pendingApprovals]) {
    if (pending.conversationId !== scopeKey) continue;
    pendingApprovals.delete(id);
    pending.cleanup?.();
    pending.hardReject?.(new PermissionGateAbortedError());
  }
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
 *
 * Settlement paths (Phase EAW): the gate now settles on FOUR events, not
 * one. Historically only `resolvePermission` could settle it, so a gate
 * whose answerer never arrived hung forever.
 *   1. `resolvePermission` — the user answered (unchanged).
 *   2. Non-interactive scope — refused synchronously, before any promise
 *      is parked (see {@link beginNonInteractiveScope}).
 *   3. `req.signal` aborted — {@link PermissionGateAbortedError}.
 *   4. `req.timeoutMs` elapsed — {@link PermissionGateTimeoutError}.
 * Omitting both `signal` and `timeoutMs` reproduces the pre-existing
 * chat behaviour exactly.
 */
export function createExtensionPermissionGate(
  req: ExtensionPermissionRequest,
): Promise<ApprovalResolution> {
  // Fail FAST, never park: where nobody can answer, awaiting here would
  // hang the caller until the process dies. Three checks, in order of
  // precision — see the block comment above `NON_INTERACTIVE_KEY_PREFIX`
  // for why key matching alone is not sufficient.
  const scope =
    nonInteractiveAls.getStore() ?? nonInteractiveScopes.get(req.conversationId);
  if (scope) {
    scope.deniedCapabilityKind = req.capabilityKind;
    return Promise.reject(
      new NonInteractiveApprovalRequiredError(req.capabilityKind, req.conversationId),
    );
  }
  // No live scope claims it, but the id itself names no conversation —
  // a stale/foreign `workflow-run:` key from a run that already ended.
  // Unanswerable by construction, so refuse rather than park forever.
  if (req.conversationId.startsWith(NON_INTERACTIVE_KEY_PREFIX)) {
    return Promise.reject(
      new NonInteractiveApprovalRequiredError(req.capabilityKind, req.conversationId),
    );
  }

  return new Promise<ApprovalResolution>((resolve, reject) => {
    // Settle-once + self-cleanup wrapper shared by the timeout and abort
    // teardown paths (`resolvePermission` deletes the entry itself).
    const settleWithError = (err: Error): void => {
      const pending = pendingApprovals.get(req.promptId);
      if (!pending) return;
      pendingApprovals.delete(req.promptId);
      pending.cleanup?.();
      reject(err);
    };
    const onAbort = (): void => settleWithError(new PermissionGateAbortedError());
    const timer =
      req.timeoutMs !== undefined
        ? setTimeout(
            () => settleWithError(new PermissionGateTimeoutError(req.timeoutMs as number)),
            req.timeoutMs,
          )
        : undefined;
    if (req.signal) req.signal.addEventListener("abort", onAbort, { once: true });

    pendingApprovals.set(req.promptId, {
      // Legacy resolve/reject are no-ops on extension gates — the
      // structured `resolveDetailed` path drives resolution. We still
      // populate them so the same Map shape works in `getPendingApproval`.
      resolve: () => resolve({ allowed: true, scope: "session" }),
      reject: () => resolve({ allowed: false }),
      hardReject: reject,
      cleanup: () => {
        if (timer !== undefined) clearTimeout(timer);
        if (req.signal) req.signal.removeEventListener("abort", onAbort);
      },
      conversationId: req.conversationId,
      extension: {
        extensionId: req.extensionId,
        userId: req.userId,
        capabilityKind: req.capabilityKind,
        resolveDetailed: resolve,
      },
    });

    // An ALREADY-aborted signal never fires `abort`, so check after the
    // entry exists (settleWithError is a no-op without one).
    if (req.signal?.aborted) onAbort();
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
  // Drop the gate's timeout timer / abort listener before settling, so an
  // answered gate can't later be "timed out" onto an already-settled
  // promise (a silent no-op) and can't pin the event loop open.
  pending.cleanup?.();
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
