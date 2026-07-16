// ── defineLoop — the Loop SDK primitive (extension facade) ──────────
//
// ONE declarative call collapses the boilerplate every autonomous SDK
// loop hand-rolls: settings resolution, the run-record + status state
// machine, idempotency, retention, failure policy, fire logging, and
// (opt-in) a Hub dashboard. The author writes only `act` (what to do) +
// small config.
//
// This module is the I/O-bearing facade: it composes the pure state
// machine (`loop-core`), the Storage-backed run store (`loop-store`), and
// the existing SDK trigger primitives (`Schedule`, `registerEventHandler`,
// `createToolDispatcher`, `definePage`/`pushPage`). It owns NO new
// transport and NO host table — run-state is Storage (spec decision #1/#2).
//
// Phase 2 ships trigger wiring + the run store + the deferred state
// machine + the shared helpers. Phase 3 layers the `log` artifact mirror
// and the dashboard helper on top (see `wireDashboard` / `writeArtifact`,
// added there).

import { Schedule, type ScheduleHandlerContext } from "./schedule";
import { registerEventHandler } from "./events";
import { createToolDispatcher, toolError, toolResult } from "./rpc";
import { definePage, pushPage } from "./page";
import { Llm } from "./llm";
import { invoke } from "./invoke";
import { spawnAssignment } from "./spawn";
import {
  APPROVED,
  AWAITING_APPROVAL,
  DECLINED,
  FINALIZING,
  autoDisableContext,
  classifyFailure,
  isParked,
  isProposalStale,
  resolveContract,
  validateActResult,
  validateCheckResult,
} from "./loop-core";
import { createLoopRunStore, type LoopRunStore } from "./loop-store";
import { wireLog, runTerminalLog } from "./loop-log";
import { LoopEvents } from "./loop-events";
import type {
  ActResult,
  ApprovalDecision,
  CheckResult,
  LoopActContext,
  LoopCheckContext,
  LoopCompleteContext,
  LoopDefinition,
  LoopMessage,
  LoopProposal,
  LoopRunState,
  LoopSettings,
  LoopTrigger,
  ResolvedContract,
} from "./loop-types";
import type { TaskAssignmentUpdateEvent } from "./host-event-types";
import type { ToolHandler, ToolHandlerContext } from "./rpc";

// ── Centralized provider → default-model map ────────────────────────
//
// The SINGLE copy of the provider-default map that lessons-distiller and
// memory-extractor each duplicated. Loops resolve the effective
// provider/model from settings via `resolveProviderModel`, deleting the
// per-extension copies (spec decision #6, the DRY win).
export const PROVIDER_DEFAULT_MODEL: Record<string, string> = {
  google: "gemini-2.0-flash-lite",
  openai: "gpt-4o-mini",
  anthropic: "claude-haiku-4-5-20250514",
  ollama: "gemma4:e2b",
};

/** Fallback provider when the setting is unset / unrecognized. */
export const DEFAULT_PROVIDER = "google";

/**
 * Resolve `{ provider, model }` from optional settings, applying the
 * shared default map. Any valid provider override wins; a blank/unknown
 * provider falls back to `google`; a blank model falls back to the
 * provider default. Pure. (Lifted verbatim from the two extensions so the
 * migration is behavior-preserving.)
 */
export function resolveProviderModel(
  providerSetting: string | undefined,
  modelSetting: string | undefined,
): { provider: string; model: string } {
  const provider =
    providerSetting && PROVIDER_DEFAULT_MODEL[providerSetting]
      ? providerSetting
      : DEFAULT_PROVIDER;
  const model =
    modelSetting && modelSetting.length > 0
      ? modelSetting
      : (PROVIDER_DEFAULT_MODEL[provider] ?? PROVIDER_DEFAULT_MODEL[DEFAULT_PROVIDER]!);
  return { provider, model };
}

// ── Shared act-context helpers (the §2 "yes" rows) ──────────────────

/** Effective settings for this extension on behalf of the acting user,
 *  with a `{}` fallback already applied (replaces every loop's
 *  hand-rolled try/catch). Injectable for tests. */
export type SettingsResolver = () => Promise<LoopSettings>;

const defaultSettingsResolver: SettingsResolver = async () => {
  try {
    return await invoke<LoopSettings>("runtime.settings.getMine", {});
  } catch {
    return {};
  }
};

/** Fetch + slice + format recent messages (replaces the verbatim
 *  last-20 code). Injectable for tests. */
export type MessagesResolver = (
  conversationId: string,
) => Promise<{ messages: LoopMessage[]; projectId: string | null }>;

const defaultMessagesResolver: MessagesResolver = async (conversationId) => {
  const result = await invoke<{
    messages: LoopMessage[];
    projectId?: string | null;
  }>("runtime.conversations.getMessages", { conversationId });
  return { messages: result.messages, projectId: result.projectId ?? null };
};

/** Canonical `[id] role: content` formatting — the shared slice format. */
export function formatMessages(messages: LoopMessage[]): string {
  return messages.map((m) => `[${m.id}] ${m.role}: ${m.content}`).join("\n\n");
}

// ── Module-level seams (test injection) ─────────────────────────────
//
// Mirrors the pattern the example extensions use (`_setRuntimeApiForTests`).
// Production wiring uses the channel-backed defaults; tests swap these to
// avoid a live pipe while still exercising the real facade logic.

/** Generic run-store constructor — the production default and the
 *  test seam share this exact shape, so name it once (a value-free type
 *  alias, erased at compile time). */
type StoreFactory = <O>(
  loopId: string,
  contract: ResolvedContract,
) => LoopRunStore<O>;

let settingsResolverImpl: SettingsResolver = defaultSettingsResolver;
let messagesResolverImpl: MessagesResolver = defaultMessagesResolver;
let spawnImpl: typeof spawnAssignment = spawnAssignment;
let llmFactory: () => Llm = () => new Llm();
let storeFactory: StoreFactory | null = null;
// The approval-event emitter (reverse RPC → host bus). Defaults to the
// channel-backed client; tests inject a spy to observe the content-free
// nudge without a live pipe.
let loopEventsImpl: LoopEvents = new LoopEvents();
// The `check` stage's host-mediated fetch. Defaults to the sandbox-wrapped
// global `fetch` (network-grant-gated by the preload); tests inject a stub
// to observe the check's external-data surface without a live network.
// Lazy binding: resolve the CURRENT global `fetch` at CALL time, not at
// module-eval. The sandbox preload wraps `globalThis.fetch` to gate it against
// the loop's network grant; if that wrap lands after this module loads, a
// module-eval capture (`= fetch`) would freeze the un-wrapped reference. The
// thin `(...a) => fetch(...a)` forwards to whatever `fetch` is bound at call
// time. (`as typeof fetch` re-adds the `preconnect` surface the wrapper doesn't
// forward — a check only ever *calls* fetch.)
const defaultCheckFetch: typeof fetch = ((...args: Parameters<typeof fetch>) =>
  fetch(...args)) as typeof fetch;
let checkFetchImpl: typeof fetch = defaultCheckFetch;

/** @internal test-only — override the settings resolver. */
export function _setSettingsResolverForTests(fn: SettingsResolver | null): void {
  settingsResolverImpl = fn ?? defaultSettingsResolver;
}
/** @internal test-only — override the recent-messages resolver. */
export function _setMessagesResolverForTests(fn: MessagesResolver | null): void {
  messagesResolverImpl = fn ?? defaultMessagesResolver;
}
/** @internal test-only — override the spawn dispatcher. */
export function _setSpawnForTests(fn: typeof spawnAssignment | null): void {
  spawnImpl = fn ?? spawnAssignment;
}
/** @internal test-only — override the Llm factory. */
export function _setLlmFactoryForTests(fn: (() => Llm) | null): void {
  llmFactory = fn ?? (() => new Llm());
}
/** @internal test-only — substitute the run store (in-memory KV). */
export function _setStoreFactoryForTests(fn: StoreFactory | null): void {
  storeFactory = fn;
}
/** @internal test-only — override the check stage's host-mediated fetch. */
export function _setCheckFetchForTests(fn: typeof fetch | null): void {
  checkFetchImpl = fn ?? defaultCheckFetch;
}
/** @internal test-only — override the approval-event emitter. */
export function _setLoopEventsForTests(fn: LoopEvents | null): void {
  loopEventsImpl = fn ?? new LoopEvents();
}

// ── Registry (multi-loop-per-extension) ─────────────────────────────
//
// One extension may declare N loops (memory-extractor needs 2). Each
// `defineLoop` registers an independent handle here; the deferred
// `task:assignment_update` dispatcher fans an inbound event to whichever
// loop owns the matching open run.

interface RegisteredLoop {
  id: string;
  contract: ResolvedContract;
  store: LoopRunStore;
  def: LoopDefinition;
  /** Phase-3 dashboard pusher, wired when `log.dashboard` is present. */
  pushDashboard?: () => Promise<void>;
}

const registry = new Map<string, RegisteredLoop>();
let assignmentHandlerInstalled = false;

// ── Fire-independent staleness sweep ────────────────────────────────
//
// The opportunistic sweep at the top of each fire only reaps a loop's stale
// proposals when THAT loop fires again — a loop whose trigger goes quiet (a
// rare cron, an event source that dries up) could hold a rotted proposal
// indefinitely. This hourly interval, armed once when the first loop is
// defined, sweeps EVERY registered loop's parked proposals independent of any
// fire, so a resident subprocess always makes progress.
//
// Honest limits: it runs ONLY while the subprocess is resident. If the
// subprocess is down (or was never started) no sweep happens until the loop's
// next fire or the next subprocess start catches up. It is not gated by the
// host loops kill-switch (that suspends host-side fires + deliveries, not this
// in-process cleanup); auto-decline is a safe, non-consequential resolution.
const STALE_SWEEP_INTERVAL_MS = 60 * 60 * 1000; // hourly
let staleSweepTimer: ReturnType<typeof setInterval> | null = null;

// ── Proposal-closure registry (in-memory, NOT persisted) ────────────
//
// A parked proposal's `finalize`/`discard` are closures — they cannot be
// JSON-serialized into Storage, so they live here keyed by
// `<loopId>:<runId>` only for the lifetime of the extension subprocess. A
// process restart loses them: a subsequent approve then finds NO closure and
// refuses to finalize (surfacing "verify manually" / leaving the run for the
// staleness sweep) — which is exactly the fail-safe the exactly-once
// guarantee wants. `finalize` is never invoked without its closure, so it can
// never double-act across a restart.
interface ProposalClosures {
  finalize: () => Promise<unknown>;
  discard?: () => Promise<void>;
}
const proposalClosures = new Map<string, ProposalClosures>();

function closureKey(loopId: string, runId: string): string {
  return `${loopId}:${runId}`;
}

/** Accumulated manual-trigger tool handlers across every loop in this
 *  extension. Exposed via `getLoopTools()` so an extension that hand-writes
 *  its own tools can merge them into a single `createToolDispatcher`. */
const loopToolHandlers: Record<string, ToolHandler> = {};

/** Return the manual-trigger tool handlers the loops registered. Spread
 *  this into your `createToolDispatcher({ ...getLoopTools(), myTool })` when
 *  the extension also hand-writes tools (the SDK dispatcher is
 *  last-call-wins, so a single merged registration is required). */
export function getLoopTools(): Record<string, ToolHandler> {
  return { ...loopToolHandlers };
}

/** @internal test-only — clear the loop registry + latches + tool map. */
export function __resetLoopsForTests(): void {
  registry.clear();
  assignmentHandlerInstalled = false;
  proposalClosures.clear();
  if (staleSweepTimer !== null) {
    clearInterval(staleSweepTimer);
    staleSweepTimer = null;
  }
  for (const k of Object.keys(loopToolHandlers)) delete loopToolHandlers[k];
}

/** @internal test-only — read a registered loop handle. */
export function _getRegisteredLoop(id: string): RegisteredLoop | undefined {
  return registry.get(id);
}

// ── defineLoop ──────────────────────────────────────────────────────

export function defineLoop<Input = unknown, Outcome = unknown>(
  def: LoopDefinition<Input, Outcome>,
): void {
  if (registry.has(def.id)) {
    throw new Error(
      `[@ezcorp/sdk] defineLoop: duplicate loop id "${def.id}" in this extension`,
    );
  }
  const contract = resolveContract<Input>(def.contract);
  const store: LoopRunStore<Outcome> = storeFactory
    ? storeFactory<Outcome>(def.id, contract as ResolvedContract)
    : createLoopRunStore<Outcome>(def.id, contract as ResolvedContract);

  const reg: RegisteredLoop = {
    id: def.id,
    contract: contract as ResolvedContract,
    store: store as LoopRunStore,
    def: def as LoopDefinition,
  };
  registry.set(def.id, reg);

  // Phase 3 hook — wire the optional dashboard (artifact mirror + page).
  wireLog(reg);

  const triggers = Array.isArray(def.trigger) ? def.trigger : [def.trigger];
  for (const trigger of triggers) {
    wireTrigger(reg, trigger);
  }

  // Deferred loops need the shared inbound-event handler installed once.
  ensureAssignmentHandler();
  // Arm the fire-independent staleness sweep once (no-op for loops without
  // `approval`, but cheap to leave running).
  ensureStaleSweepInterval();
}

/** Arm the hourly, fire-independent staleness sweep exactly once. Unref'd so
 *  it never keeps the subprocess alive on its own. */
function ensureStaleSweepInterval(): void {
  if (staleSweepTimer !== null) return;
  // Single-expression callback (the hourly tick just fires the sweep). Kept on
  // one line so the `setInterval` statement — executed on the first
  // `defineLoop` — is line-covered; the tick body itself is exercised via the
  // `sweepAllStaleProposals` unit tests.
  staleSweepTimer = setInterval(() => void sweepAllStaleProposals(), STALE_SWEEP_INTERVAL_MS);
  staleSweepTimer.unref?.();
}

/**
 * Sweep EVERY registered loop's parked proposals in one pass — the
 * fire-independent path the hourly interval drives. Iterates the registry so a
 * quiet loop's rotted proposals are reaped even when that loop never fires
 * again. Best-effort: a per-loop sweep failure never stops the others, and the
 * whole pass never throws. Returns the total number auto-declined. Exported for
 * the interval + tests.
 */
export async function sweepAllStaleProposals(
  nowMs: number = Date.now(),
): Promise<number> {
  let total = 0;
  for (const reg of registry.values()) {
    if (!reg.contract.approval) continue;
    try {
      total += await sweepStaleProposals(reg.id, nowMs);
    } catch {
      // One loop's sweep failure must not stop the rest.
    }
  }
  return total;
}

// ── Trigger wiring ──────────────────────────────────────────────────

function wireTrigger(reg: RegisteredLoop, trigger: LoopTrigger): void {
  switch (trigger.kind) {
    case "cron": {
      const schedule = new Schedule();
      schedule.on(trigger.cron, async (ctx: ScheduleHandlerContext) => {
        await runFire(reg, trigger, {
          fireId: ctx.fireId,
          firedAt: ctx.firedAt,
          catchUp: ctx.catchUp,
          input: ctx,
        });
      });
      break;
    }
    case "event": {
      registerEventHandler(trigger.event, async (payload) => {
        if (trigger.filter && !trigger.filter(payload)) {
          // Pre-gate decline → skip (logged, not an error). We still run
          // the fire so the skip is recorded uniformly.
          await runFire(reg, trigger, {
            fireId: cryptoId(),
            firedAt: new Date().toISOString(),
            catchUp: false,
            input: payload,
            preSkip: "filter_rejected",
          });
          return;
        }
        await runFire(reg, trigger, {
          fireId: cryptoId(),
          firedAt: new Date().toISOString(),
          catchUp: false,
          input: payload,
        });
      });
      break;
    }
    case "manual": {
      if (trigger.tool) {
        const handler: ToolHandler = async (
          args: Record<string, unknown>,
          ctx?: ToolHandlerContext,
        ) => {
          const result = await runFire(reg, trigger, {
            fireId: cryptoId(),
            firedAt: new Date().toISOString(),
            catchUp: false,
            input: args,
            toolCtx: ctx,
          });
          if (result.kind === "skip") {
            return toolResult(
              JSON.stringify({ loop: reg.id, skipped: true, reason: result.reason }),
            );
          }
          if (result.kind === "error") {
            return toolError(`${reg.id} failed: ${result.detail}`);
          }
          return toolResult(
            JSON.stringify({ loop: reg.id, runId: result.runId, status: result.status }),
          );
        };
        // Loud-fail on a manual-tool name collision. Because the SDK
        // dispatcher is last-call-wins, two loops (or a loop + a
        // hand-written tool of the same name) would otherwise SILENTLY
        // clobber each other — the DX footgun. Throwing here turns it into
        // an install-time crash with an actionable message.
        if (Object.hasOwn(loopToolHandlers, trigger.tool)) {
          throw new Error(
            `[@ezcorp/sdk] defineLoop: manual tool "${trigger.tool}" is already registered by another loop in this extension — give each loop's manual trigger a unique \`tool\` name`,
          );
        }
        // Accumulate into the shared loop-tool map and re-register the
        // MERGED set. `createToolDispatcher` replaces the `tools/call`
        // handler wholesale (last-call-wins), so registering the full
        // accumulated map each time keeps every loop's manual tool live.
        // An extension that ALSO hand-writes tools spreads `getLoopTools()`
        // into its own single `createToolDispatcher({ ...getLoopTools(),
        // ...ownTools })` call (see docs/extensions/loops.md).
        loopToolHandlers[trigger.tool] = handler;
        createToolDispatcher({ ...loopToolHandlers });
      }
      // `pageAction` triggers are wired through `log.dashboard.rowActions`
      // in Phase 3; a bare manual pageAction with no tool is a no-op here.
      break;
    }
  }
}

// ── Fire execution ──────────────────────────────────────────────────

interface FireMeta {
  fireId: string;
  firedAt: string;
  catchUp: boolean;
  input: unknown;
  /** When set, the trigger pre-gate already declined; short-circuit to a
   *  skip without invoking `act`. */
  preSkip?: string;
  toolCtx?: ToolHandlerContext;
}

type FireResult =
  | { kind: "skip"; reason: string }
  | { kind: "terminal"; runId: string; status: string }
  | { kind: "deferred"; runId: string; status: string }
  | { kind: "proposal"; runId: string; status: string }
  | { kind: "error"; detail: string };

/**
 * Execute one fire: resolve settings, build the act context, run `act`,
 * persist the run + advance the state machine, and apply failure policy.
 * Fail-soft — a thrown `act` is classified, never re-thrown to the host
 * (the listener/cron contract is fire-and-forget).
 */
async function runFire(
  reg: RegisteredLoop,
  trigger: LoopTrigger,
  meta: FireMeta,
): Promise<FireResult> {
  // Durable skip journal: a decline (check `proceed:false`, act `skip`, a
  // rejected event filter) is recorded at `loop:<id>:skips` so it has an audit
  // trace even when the cron/event trigger discards the `FireResult`. Records
  // for ALL trigger kinds (the trigger handlers never see the skip; runFire
  // owns the journaling uniformly).
  const journalSkip = (reason: string, lines: string[]): Promise<void> =>
    reg.store.recordSkip({
      at: new Date().toISOString(),
      reason,
      trigger: trigger.kind,
      logLines: lines,
    });

  // Opportunistic staleness sweep: auto-decline any parked proposal that has
  // rotted past the horizon. Best-effort — never blocks/fails the fire.
  if (reg.contract.approval) {
    try {
      await sweepStaleProposals(reg.id);
    } catch {
      // A sweep failure must never fail the fire.
    }
  }

  // Auto-disable latch: a disabled loop skips every fire (it stays
  // registered so a settings flip / restart can re-enable it).
  const initialMeta = await reg.store.getMeta();
  if (initialMeta.disabled) {
    // NOT journaled: a disabled loop declines EVERY fire, so recording each
    // would evict useful entries from the capped journal. The disabled latch
    // (`loop:<id>:meta`) is itself the durable signal.
    return { kind: "skip", reason: "auto_disabled" };
  }
  if (meta.preSkip) {
    // Event pre-gate decline (`filter_rejected`) — no audit-log lines yet.
    await journalSkip(meta.preSkip, []);
    return { kind: "skip", reason: meta.preSkip };
  }

  const settings = await settingsResolverImpl();
  const logLines: string[] = [];
  const log = (msg: string, level: "info" | "warn" | "error" = "info") => {
    logLines.push(`[${level}] ${msg}`);
  };
  const fire = {
    id: meta.fireId,
    firedAt: meta.firedAt,
    trigger,
    catchUp: meta.catchUp,
  };

  // ── check stage ──────────────────────────────────────────────────
  //
  // The deterministic pre-act gate. Runs BEFORE `act` (and after the
  // disabled/pre-skip gates) on `meta.input` (the RAW trigger input). A
  // `proceed:false` is a first-class skip; a thrown check is classified by
  // `contract.failure` exactly like a thrown act. An omitted `check` is
  // `proceed:true` — existing loops are unchanged (zero migration). On
  // `proceed:true` the check may enrich the input `act` sees.
  let effectiveInput = meta.input;
  if (reg.def.check) {
    const checkCtx: LoopCheckContext = {
      input: meta.input,
      settings,
      fire,
      cursor: {
        get: <T,>() => reg.store.getCursor<T>(),
        set: <T,>(value: T) => reg.store.setCursor<T>(value),
      },
      fetch: checkFetchImpl,
      log,
    };
    let checkResult: CheckResult;
    try {
      checkResult = await reg.def.check(checkCtx);
      // Validate INSIDE the fail-soft boundary: a malformed result (or any
      // throw while reading it) is classified like a thrown check via
      // `handleFailure`, never re-thrown to the fire-and-forget host.
      const invalidCheck = validateCheckResult(checkResult);
      if (invalidCheck) {
        return handleFailure(reg, new Error(invalidCheck));
      }
    } catch (err) {
      return handleFailure(reg, err);
    }
    if (checkResult.proceed === false) {
      // A non-throwing check is a healthy fire even when it declines —
      // reset the consecutive-error counter, then journal the skip.
      await resetErrorsIfNeeded(reg, initialMeta);
      await journalSkip(checkResult.reason, logLines);
      return { kind: "skip", reason: checkResult.reason };
    }
    // `proceed:true` with an explicit `input` REPLACES what `act` sees.
    if (checkResult.input !== undefined) effectiveInput = checkResult.input;
  }

  const ctx: LoopActContext = {
    fire,
    input: effectiveInput,
    settings,
    llm: llmFactory(),
    recentMessages: async (conversationId: string, n = 20) => {
      const { messages } = await messagesResolverImpl(conversationId);
      return messages.slice(-Math.max(0, n));
    },
    formatMessages,
    spawn: spawnImpl,
    log,
  };

  let result: ActResult;
  try {
    result = await reg.def.act(ctx);
  } catch (err) {
    return handleFailure(reg, err);
  }

  // Validate BEFORE resetting the error counter: an invalid act result is a
  // failure, so it must accumulate toward auto-disable. Resetting first would
  // reset-then-increment to 1 on every fire — the counter could never reach
  // `autoDisableAfter`, so a permanently-broken act would never disable.
  const invalid = validateActResult(result, reg.contract);
  if (invalid) {
    return handleFailure(reg, new Error(invalid));
  }

  // A VALID act result (terminal/deferred/skip) resets the consecutive-error
  // counter — the fire was healthy.
  await resetErrorsIfNeeded(reg, initialMeta);

  if (result.kind === "skip") {
    await journalSkip(result.reason, logLines);
    return { kind: "skip", reason: result.reason };
  }

  if (result.kind === "terminal") {
    const note = logLines[0];
    const key = idemKey(reg, effectiveInput);
    // Capture loops resolve in one fire — claim the run already at the
    // terminal status carrying the outcome (no redundant transition, so
    // the event log has a single entry). The run persists the EFFECTIVE
    // input (post-`check` enrichment) — what `act` actually processed.
    const { run } = await reg.store.claim({
      id: meta.fireId,
      loopId: reg.id,
      status: result.status,
      input: effectiveInput,
      outcome: result.outcome,
      ...(key ? { idempotencyKey: key } : {}),
      ...(note ? { note } : {}),
    });
    await afterTerminal(reg, run, result.outcome);
    return { kind: "terminal", runId: run.id, status: result.status };
  }

  if (result.kind === "proposal") {
    // Gated output: park the run in the primitive-owned `awaiting_approval`
    // state carrying the proposal SNAPSHOT (plain data). The finalize/discard
    // closures go to the in-memory registry (never persisted); a human
    // approve/decline resolves the run via `approveRun`/`declineRun`.
    const key = idemKey(reg, effectiveInput);
    const label = logLines[0] ?? `parked: ${result.status}`;
    const { run, created } = await reg.store.claim({
      id: meta.fireId,
      loopId: reg.id,
      status: AWAITING_APPROVAL,
      input: effectiveInput,
      proposal: result.proposal,
      ...(key ? { idempotencyKey: key } : {}),
      note: label,
    });
    // Idempotency: a duplicate fire keyed to an ALREADY-PARKED run returns the
    // existing run (`created:false`). Keep its ORIGINAL proposal snapshot AND
    // its ORIGINAL finalize/discard closures — overwriting the closures here
    // would bind them to THIS fire's act state while the persisted snapshot is
    // still the first fire's, a mismatch a later approve would finalize. So we
    // ONLY store closures + emit the pending nudge on a freshly-claimed run;
    // the duplicate is a silent no-op that re-reports the parked status.
    if (created) {
      storeClosures(reg.id, run.id, result.finalize, result.discard);
      await emitApprovalPending(reg, run);
      await reg.pushDashboard?.();
    }
    return { kind: "proposal", runId: run.id, status: run.status };
  }

  // Deferred: open a non-terminal run keyed by the spawned runId.
  const note = logLines[0];
  const deferredKey = idemKey(reg, effectiveInput);
  const { run } = await reg.store.claim({
    id: result.runId,
    loopId: reg.id,
    status: result.status,
    input: effectiveInput,
    ...(deferredKey ? { idempotencyKey: deferredKey } : {}),
    externalRunId: result.runId,
    ...(result.assignmentId ? { externalAssignmentId: result.assignmentId } : {}),
    ...(result.taskId ? { externalTaskId: result.taskId } : {}),
    ...(result.subConversationId ? { subConversationId: result.subConversationId } : {}),
    ...(note ? { note } : {}),
  });
  await reg.pushDashboard?.();
  return { kind: "deferred", runId: run.id, status: result.status };
}

function idemKey(reg: RegisteredLoop, input: unknown): string | undefined {
  return reg.contract.idempotencyKey?.(input);
}

/** Reset the consecutive-error counter after a non-throwing act. Only
 *  writes when it was non-zero (avoid needless KV churn). */
async function resetErrorsIfNeeded(
  reg: RegisteredLoop,
  current: { consecutiveErrors: number; disabled: boolean },
): Promise<void> {
  if (current.consecutiveErrors !== 0) {
    await reg.store.setMeta({ consecutiveErrors: 0, disabled: current.disabled });
  }
}

/** Apply the failure policy: classify, increment the consecutive counter,
 *  and auto-disable + notify when the threshold trips. Returns an error
 *  FireResult. */
async function handleFailure(
  reg: RegisteredLoop,
  err: unknown,
): Promise<FireResult> {
  const meta = await reg.store.getMeta();
  const decision = classifyFailure(err, meta.consecutiveErrors, reg.contract);
  const nextMeta = {
    consecutiveErrors: decision.consecutiveErrors,
    disabled: meta.disabled || decision.shouldDisable,
  };
  await reg.store.setMeta(nextMeta);
  if (decision.shouldDisable) {
    // Emit a user-visible notice — an auto-disable is NEVER a silent stop.
    // Best-effort; independent of (and before) the author's onAutoDisable hook.
    try {
      await loopEventsImpl.emitAutoDisabled({
        loopId: reg.id,
        consecutiveErrors: decision.consecutiveErrors,
      });
    } catch {
      // The notice is best-effort; the disabled latch is the durable signal.
    }
    if (reg.contract.onAutoDisable) {
      try {
        await reg.contract.onAutoDisable(
          autoDisableContext(reg.id, decision, err),
        );
      } catch {
        // Notification failure must not mask the original error.
      }
    }
  }
  return { kind: "error", detail: err instanceof Error ? err.message : String(err) };
}

/** Write the artifact mirror + push the dashboard after a terminal
 *  outcome. Delegates to the `loop-log` module (Phase 3); a loop with no
 *  `log` block is a no-op. */
async function afterTerminal(
  reg: RegisteredLoop,
  run: LoopRunState,
  outcome: unknown,
): Promise<void> {
  await runTerminalLog(reg, run, outcome);
}

// ── Approval resolution (primitive-owned) ────────────────────────────
//
// The primitive OWNS approve/decline + the state transitions; extensions
// only supply the `finalize`/`discard` closures. `approveRun`/`declineRun`
// are what a dashboard row-action (Phase 3) or a host route invokes — never
// re-implemented per loop, so governance + the LOCKED label capture can't be
// forgotten or faked.

function storeClosures(
  loopId: string,
  runId: string,
  finalize: () => Promise<unknown>,
  discard?: () => Promise<void>,
): void {
  proposalClosures.set(closureKey(loopId, runId), {
    finalize,
    ...(discard ? { discard } : {}),
  });
}

/** Emit the content-free approval-pending nudge (best-effort — an emit
 *  failure must never fail the fire or leave the run unparked). */
async function emitApprovalPending(
  reg: RegisteredLoop,
  run: LoopRunState,
): Promise<void> {
  try {
    await loopEventsImpl.emitApprovalPending({
      loopId: reg.id,
      runId: run.id,
      ...(run.subConversationId ? { conversationId: run.subConversationId } : {}),
    });
  } catch {
    // Content-free nudge; the authorized dashboard/GET is the source of truth.
  }
}

async function emitApprovalResolved(
  reg: RegisteredLoop,
  run: LoopRunState,
  decision: ApprovalDecision,
): Promise<void> {
  try {
    await loopEventsImpl.emitApprovalResolved({
      loopId: reg.id,
      runId: run.id,
      decision,
      ...(run.subConversationId ? { conversationId: run.subConversationId } : {}),
    });
  } catch {
    // Best-effort mirror; the audit stream + label store are authoritative.
  }
}

/** Append the LOCKED eval-signal label for a resolution. Written ONLY here
 *  (the single approval-resolution path). */
async function appendApprovalLabel(
  reg: RegisteredLoop,
  run: LoopRunState,
  proposal: LoopProposal,
  decision: ApprovalDecision,
  decidedBy: string,
  note?: string,
): Promise<void> {
  await reg.store.appendLabel({
    loopId: reg.id,
    runId: run.id,
    proposalSnapshot: proposal,
    decision,
    decidedBy,
    decidedAt: new Date().toISOString(),
    ...(note ? { note } : {}),
    loopConfigVersion: reg.contract.configVersion,
  });
}

export type ApprovalResolution =
  | { ok: true; runId: string; decision: "approved"; finalized: boolean; verifyManually?: boolean }
  | { ok: true; runId: string; decision: "declined" }
  | { ok: false; reason: string };

/**
 * Approve a parked proposal — the primitive-owned transition. Records
 * finalize-intent (`awaiting_approval → finalizing`) BEFORE invoking
 * `finalize`, so a crash between the intent and completion leaves the run in
 * `finalizing` (re-entry surfaces "verify manually", NEVER a re-invoke). The
 * approval label (the eval signal) is appended at decision time regardless of
 * the finalize outcome.
 *
 * SECURITY — `decidedBy` provenance: this value is stamped verbatim onto the
 * LOCKED approval label (the held-out eval signal) and the `loops:*` audit
 * mirror, so it is an authorization-critical identity. It MUST be supplied by
 * the HOST-SIDE approval route (Phase 3) from the authenticated session — NEVER
 * read from extension-supplied input, which a compromised loop could forge to
 * attribute a decision to another user. Extension code has no path to call this
 * with a caller-chosen identity. TODO(phase-3): the host approval route stamps
 * `decidedBy` from the request's authenticated user id; the `"system"` sentinel
 * is reserved for the staleness auto-decline only.
 */
export async function approveRun(
  loopId: string,
  runId: string,
  decidedBy: string,
): Promise<ApprovalResolution> {
  const reg = registry.get(loopId);
  if (!reg) return { ok: false, reason: "unknown_loop" };
  const run = await reg.store.get(runId);
  if (!run) return { ok: false, reason: "unknown_run" };
  if (run.status === APPROVED || run.status === DECLINED) {
    return { ok: false, reason: "already_resolved" };
  }
  if (run.status === FINALIZING) {
    // A finalize is already in flight (or crashed) — never re-invoke.
    return { ok: false, reason: "finalizing" };
  }
  if (run.status !== AWAITING_APPROVAL) {
    return { ok: false, reason: "not_parked" };
  }
  if (!run.proposal) return { ok: false, reason: "no_proposal" };

  const closures = proposalClosures.get(closureKey(loopId, runId));
  if (!closures) {
    // Process restarted → the finalize closure is gone. Flag the run for
    // manual verification and leave it (the staleness sweep will reap it).
    // Never fabricate a finalize.
    await reg.store.transitionIf(runId, AWAITING_APPROVAL, {
      status: AWAITING_APPROVAL,
      eventStatus: "closures_lost",
      verifyManually: true,
      note: "approve after restart — finalize closure lost; verify manually",
    });
    return { ok: false, reason: "closures_lost" };
  }

  // CAS: record finalize-intent. Only the winner of the flip proceeds — a
  // concurrent approve reads `finalizing` and bails, so `finalize` runs once
  // and the label is appended once.
  const parked = await reg.store.transitionIf(runId, AWAITING_APPROVAL, {
    status: FINALIZING,
    eventStatus: FINALIZING,
    note: `approved by ${decidedBy}`,
  });
  if (!parked) return { ok: false, reason: "already_resolved" };

  const proposal = run.proposal;
  // The LOCKED eval-signal label is written BEFORE finalize. If that write
  // throws, do NOT proceed to finalize with a missing signal AND do not leave
  // the run silently wedged in `finalizing` (a re-approve would forever return
  // `finalizing`). Flag it `verifyManually` so a human has an escape hatch —
  // `declineRun` accepts a `finalizing` run ONLY when this flag is set.
  try {
    await appendApprovalLabel(reg, parked, proposal, "approved", decidedBy);
  } catch (labelErr) {
    await reg.store.transitionIf(runId, FINALIZING, {
      status: FINALIZING,
      eventStatus: "label_append_failed",
      verifyManually: true,
      note: labelErr instanceof Error ? labelErr.message : String(labelErr),
    });
    return { ok: false, reason: "label_append_failed" };
  }
  await emitApprovalResolved(reg, parked, "approved");

  let outcome: unknown;
  let finalizeError: unknown;
  try {
    outcome = await closures.finalize();
  } catch (err) {
    finalizeError = err;
  }
  proposalClosures.delete(closureKey(loopId, runId));

  if (finalizeError) {
    // finalize threw — the side effect may be partial. Stay in `finalizing`,
    // flag verify-manually, never re-invoke.
    await reg.store.transitionIf(runId, FINALIZING, {
      status: FINALIZING,
      eventStatus: "finalize_failed",
      verifyManually: true,
      note: finalizeError instanceof Error ? finalizeError.message : String(finalizeError),
    });
    return { ok: true, runId, decision: "approved", finalized: false, verifyManually: true };
  }

  const finalRun = await reg.store.transitionIf(runId, FINALIZING, {
    status: APPROVED,
    eventStatus: APPROVED,
    outcome,
  });
  if (finalRun) await afterTerminal(reg, finalRun, outcome);
  return { ok: true, runId, decision: "approved", finalized: true };
}

/**
 * Decline a parked proposal — the primitive-owned transition. Flips
 * `awaiting_approval → declined` (terminal) atomically, appends the
 * `declined` label, emits the resolved nudge, then runs `discard`
 * best-effort (cleanup failure never un-declines). `decidedBy: "system"`
 * marks a staleness auto-decline.
 *
 * A `finalizing` run is normally NOT declinable (a finalize is in flight).
 * The one exception is a run flagged `verifyManually` — a crashed/lost-closure
 * finalize or a failed label append — which a human may decline as an escape
 * hatch so it never wedges forever in `finalizing`.
 *
 * SECURITY — `decidedBy` provenance: see {@link approveRun}. This identity is
 * stamped verbatim onto the LOCKED approval label + the audit mirror; the
 * HOST-SIDE approval route (Phase 3) MUST supply it from the authenticated
 * session and NEVER trust extension-supplied input. TODO(phase-3): host route
 * stamps `decidedBy` from the request's authenticated user; `"system"` is
 * reserved for the staleness auto-decline.
 */
export async function declineRun(
  loopId: string,
  runId: string,
  decidedBy: string,
  note?: string,
): Promise<ApprovalResolution> {
  const reg = registry.get(loopId);
  if (!reg) return { ok: false, reason: "unknown_loop" };
  const run = await reg.store.get(runId);
  if (!run) return { ok: false, reason: "unknown_run" };
  if (run.status === APPROVED || run.status === DECLINED) {
    return { ok: false, reason: "already_resolved" };
  }
  // Escape hatch: a `finalizing` run is declinable ONLY when it was flagged for
  // manual verification (crashed finalize / lost closure / failed label
  // append). Otherwise a finalize is legitimately in flight — never decline.
  if (run.status === FINALIZING) {
    if (run.verifyManually !== true) return { ok: false, reason: "finalizing" };
  } else if (run.status !== AWAITING_APPROVAL) {
    return { ok: false, reason: "not_parked" };
  }
  if (!run.proposal) return { ok: false, reason: "no_proposal" };

  const from = run.status;
  const declined = await reg.store.transitionIf(runId, from, {
    status: DECLINED,
    eventStatus: DECLINED,
    note: note ? `declined by ${decidedBy}: ${note}` : `declined by ${decidedBy}`,
  });
  if (!declined) return { ok: false, reason: "already_resolved" };

  await appendApprovalLabel(reg, declined, run.proposal, "declined", decidedBy, note);
  await emitApprovalResolved(reg, declined, "declined");

  const closures = proposalClosures.get(closureKey(loopId, runId));
  proposalClosures.delete(closureKey(loopId, runId));
  if (closures?.discard) {
    try {
      await closures.discard();
    } catch {
      // Cleanup is best-effort — a discard failure never un-declines the run.
    }
  }
  await afterTerminal(reg, declined, declined.outcome);
  return { ok: true, runId, decision: "declined" };
}

/**
 * Auto-decline every parked proposal that has rotted past the loop's
 * staleness horizon (`contract.approval.staleAfterDays`). Runs opportunistically
 * at the top of each fire and is exported for a periodic host sweep. Returns
 * the number auto-declined. Best-effort — never throws.
 */
export async function sweepStaleProposals(
  loopId: string,
  nowMs: number = Date.now(),
): Promise<number> {
  const reg = registry.get(loopId);
  if (!reg?.contract.approval) return 0;
  const staleAfterDays = reg.contract.approval.staleAfterDays;
  if (staleAfterDays <= 0) return 0;
  let count = 0;
  const runs = await reg.store.list();
  for (const run of runs) {
    if (!isProposalStale(run, staleAfterDays, nowMs)) continue;
    const res = await declineRun(
      loopId,
      run.id,
      "system",
      "auto-declined: parked proposal exceeded staleness horizon",
    );
    if (res.ok) count++;
  }
  return count;
}

/** @internal test-only — seed a proposal closure (e.g. to simulate a
 *  restart's lost closure by NOT seeding, or to inject a spy finalize). */
export function _setProposalClosuresForTests(
  loopId: string,
  runId: string,
  closures: ProposalClosures | null,
): void {
  if (closures) proposalClosures.set(closureKey(loopId, runId), closures);
  else proposalClosures.delete(closureKey(loopId, runId));
}

// ── Deferred completion: task:assignment_update ─────────────────────

function ensureAssignmentHandler(): void {
  if (assignmentHandlerInstalled) return;
  // Only install when at least one registered loop can go deferred. We
  // install unconditionally (cheap) — a loop with no open deferred run
  // simply never matches.
  assignmentHandlerInstalled = true;
  registerEventHandler("task:assignment_update", async (payload) => {
    await dispatchAssignmentUpdate(payload as TaskAssignmentUpdateEvent);
  });
}

/** Fan an inbound assignment update to whichever registered loop owns the
 *  matching OPEN run, then transition it. Idempotent — a late/duplicate
 *  event for a closed run is a no-op. */
export async function dispatchAssignmentUpdate(
  evt: TaskAssignmentUpdateEvent,
): Promise<void> {
  const a = evt.assignment;
  for (const reg of registry.values()) {
    const runs = await reg.store.list();
    const match = runs.find(
      (r) =>
        (!!a.agentRunId && r.id === a.agentRunId) ||
        (!!a.agentRunId && r.externalRunId === a.agentRunId) ||
        r.externalAssignmentId === a.id ||
        r.externalTaskId === evt.taskId,
    );
    if (!match) continue;

    // PARKED / CLOSED guard: a run in `awaiting_approval` / `finalizing` has
    // LEFT the deferred path — a human approve/decline (`approveRun` /
    // `declineRun`) owns its transitions now. A late or DUPLICATE
    // `task:assignment_update` must NEVER re-run `onComplete` (which would
    // replace the proposal snapshot + closures and emit a duplicate pending
    // nudge) nor flip the parked run to a terminal status WITHOUT a decision.
    // A run that is already terminal is likewise closed. Either case is a
    // no-op. (An assignment maps to exactly one loop's run — stop here.)
    if (isParked(match) || isTerminalStatus(match.status, reg.contract)) {
      return;
    }

    const nextStatus = mapAssignmentStatus(a.status, reg.contract);
    // The OPEN status observed under THIS event. Every transition below is a
    // compare-and-set against it, so a concurrent/duplicate event that already
    // advanced the run fails the CAS and no-ops (never double-terminalizes,
    // never re-parks).
    const expected = match.status;

    // Deferred → proposal composition: when a deferred run reaches a terminal
    // host status AND the loop declares `onComplete` + `approval`, let
    // `onComplete` turn the spawned agent's completion into a proposal (park)
    // or a terminal result — instead of terminalizing directly.
    if (
      isTerminalStatus(nextStatus, reg.contract) &&
      reg.def.onComplete &&
      reg.contract.approval
    ) {
      const handled = await runOnComplete(reg, match, nextStatus, expected, a.resultPreview);
      if (handled) return;
      // Fall through to the default terminalize when onComplete opted out.
    }

    const updated = await reg.store.transitionIf(match.id, expected, {
      status: nextStatus,
      ...(a.resultPreview ? { note: a.resultPreview } : {}),
    });
    if (!updated) {
      // CAS lost — a concurrent resolver already moved the run. No-op.
      return;
    }
    if (isTerminalStatus(nextStatus, reg.contract)) {
      await afterTerminal(reg, updated, updated.outcome);
    } else {
      await reg.pushDashboard?.();
    }
    // An assignment maps to exactly one loop's run; stop after the first
    // match.
    return;
  }
}

/**
 * Run a deferred loop's `onComplete` at the completion boundary and act on
 * its result:
 *   - `proposal` → park the run in `awaiting_approval` with the snapshot +
 *     store the finalize/discard closures + emit the pending nudge.
 *   - `terminal` → transition to the terminal status + outcome + artifact/log.
 *   - anything else / a throw / an invalid proposal → return false so the
 *     caller terminalizes with the default status (no strand).
 * Returns true when it fully handled the completion.
 */
async function runOnComplete(
  reg: RegisteredLoop,
  run: LoopRunState,
  mappedStatus: string,
  expectedStatus: string,
  resultPreview?: string,
): Promise<boolean> {
  const onComplete = reg.def.onComplete;
  if (!onComplete) return false;
  const settings = await settingsResolverImpl();
  const notes: string[] = [];
  const ctx: LoopCompleteContext = {
    run,
    status: mappedStatus,
    ...(resultPreview !== undefined ? { resultPreview } : {}),
    settings,
    log: (msg: string) => notes.push(msg),
  };
  let result: ActResult;
  try {
    result = await onComplete(ctx);
  } catch {
    // Never strand the run: fall back to the default terminalize.
    return false;
  }

  if (result.kind === "proposal") {
    if (validateActResult(result, reg.contract) !== null) return false;
    // CAS from the OPEN status the caller observed: a duplicate completion
    // that already parked/terminalized the run fails here, so we never
    // re-park (replace snapshot/closures) or emit a duplicate nudge. When the
    // CAS is lost we report "handled" — the concurrent event already resolved
    // this completion, so the caller must NOT default-terminalize.
    const parked = await reg.store.transitionIf(run.id, expectedStatus, {
      status: AWAITING_APPROVAL,
      eventStatus: result.status,
      proposal: result.proposal,
      ...(notes[0] ? { note: notes[0] } : {}),
    });
    if (!parked) return true;
    storeClosures(reg.id, run.id, result.finalize, result.discard);
    await emitApprovalPending(reg, parked);
    await reg.pushDashboard?.();
    return true;
  }

  if (result.kind === "terminal") {
    if (validateActResult(result, reg.contract) !== null) return false;
    const done = await reg.store.transitionIf(run.id, expectedStatus, {
      status: result.status,
      outcome: result.outcome,
      ...(notes[0] ? { note: notes[0] } : {}),
    });
    // CAS lost → a concurrent event already terminalized; still "handled".
    if (done) await afterTerminal(reg, done, result.outcome);
    return true;
  }

  // skip / deferred / invalid → default terminalize.
  return false;
}

/**
 * Map a host assignment status onto the contract vocabulary.
 *   - A status already in the vocabulary passes through verbatim (the
 *     common case — contracts declare `completed`/`failed`/`cancelled`).
 *   - A terminal-ish host status (`failed`/`cancelled`/`completed`) that
 *     isn't declared falls back to the contract's first terminal state.
 *   - Anything else keeps the run OPEN at the first non-terminal state.
 * `contract.terminal` and the non-terminal set are both non-empty by
 * construction (`resolveContract` guarantees ≥1 state and a terminal
 * subset), so the lookups always resolve. Pure.
 */
function mapAssignmentStatus(
  status: string,
  contract: ResolvedContract,
): string {
  if (contract.states.includes(status)) return status;
  if (status === "failed" || status === "cancelled" || status === "completed") {
    return contract.terminal[0]!;
  }
  // Reached only for an OPEN run (dispatchAssignmentUpdate matches live
  // runs only), so the contract always has a non-terminal state here.
  return contract.states.find((s) => !contract.terminal.includes(s))!;
}

function isTerminalStatus(status: string, contract: ResolvedContract): boolean {
  return contract.terminal.includes(status);
}

// Re-export the registered-loop shape for the log module.
export type { RegisteredLoop };
export { definePage, pushPage };

// ── small utils ─────────────────────────────────────────────────────

/** Fresh fire id. `crypto.randomUUID` is always present in the Bun
 *  extension runtime. */
function cryptoId(): string {
  return crypto.randomUUID();
}
