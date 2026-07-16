// ── Run manager v0 — records + worktree lifecycle ────────────────────
//
// Persists one run per intercepted push, materializes a detached worktree from
// the gate bare repo, records it, and tears it down. M0 runs no pipeline; the
// findings model + step_results contract exist NOW (fail-closed) so later
// milestones plug in without re-shaping storage.
//
// Storage is the SDK `Storage("global")` bucket: gate runs are system/CI-like
// (a push is not a per-user chat action) and must be visible on the SHARED Hub
// dashboard, which renders the global scope only.

import { join } from "node:path";
import { Storage, withLock } from "@ezcorp/sdk/runtime";
import type { StorageScope } from "@ezcorp/sdk/runtime";
import type { ShellRunner } from "./shell";
import { PIPELINE_STEPS, type PipelineStep } from "./config";

// ── Persistence schema (spec §1 subset for M0/M1) ───────────────────

/**
 * Run lifecycle status. M0 shipped created→worktree_ready→completed|failed;
 * M1 adds the pipeline-executor states between worktree_ready and terminal:
 *   - `running`           — the executor is mid-pipeline
 *   - `awaiting_approval` — parked at a step gate, waiting for a respond event
 *   - `aborted`           — a user `abort` action terminated the run (upstream's
 *                           RunCancelled maps here — distinct from `failed`)
 */
export type RunStatus =
  | "created"
  | "worktree_ready"
  | "running"
  | "awaiting_approval"
  | "completed"
  | "failed"
  | "aborted";

/** Statuses from which no respond can ever resume a run. Only these release a
 *  kept worktree — everything else (awaiting_approval, running, …) keeps it. */
const TERMINAL_RUN_STATUSES: ReadonlySet<RunStatus> = new Set(["completed", "failed", "aborted"]);

/** Whether a run has reached a terminal state (completed/failed/aborted). */
export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.has(status);
}

/** One intercepted push. Mirrors the upstream `runs` table (M0 subset). */
export interface RunRecord {
  id: string;
  repoId: string;
  branch: string;
  ref: string;
  headSha: string;
  /** The push's `oldrev` — the branch tip the gate last observed before this
   *  push (all-zeros on a brand-new branch). The pipeline's force-push safety +
   *  force-with-lease anchor read this as the last-observed remote head. */
  baseSha: string;
  status: RunStatus;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
  /** ms the run has spent parked awaiting a human (0 until gates land). */
  parkedMs: number;
  /** ISO time an agent started waiting on this run, or null. NULL vs 0 is
   *  load-bearing telemetry the upstream schema keeps distinct. */
  awaitingAgentSince: string | null;
  /** Explicit user intent (from `git push gate -o intent="…"` or the run-start
   *  payload). Authoritative acceptance criteria when present (M1); transcript
   *  inference lands in M5. Null when no intent was supplied. */
  intent: string | null;
  /** Provenance of `intent`: "agent" = explicit/authoritative. Empty/null when
   *  no intent. (Inferred sources — "claude"/"codex"/… — arrive in M5.) */
  intentSource: string | null;
  error?: string;
}

/** Pipeline step lifecycle status (spec §8; mirrors upstream StepStatus). */
export type StepStatus =
  | "pending"
  | "running"
  | "fixing"
  | "awaiting_approval"
  | "fix_review"
  | "completed"
  | "skipped"
  | "failed";

/**
 * One step's outcome (spec §1 `step_results`). The M0 findings contract is
 * preserved; M1 adds the executor bookkeeping (status, round counters, parked
 * time) each step carries between invocations so a parked step resumes exactly.
 */
export interface StepResultRecord {
  runId: string;
  step: string;
  status: StepStatus;
  findings: Findings;
  agentPid: number | null;
  autoFixLimit: number;
  /** Number of executed rounds (initial + each fix). */
  round: number;
  /** Auto-fix rounds spent so far (bounded by autoFixLimit). */
  autoFixAttempts: number;
  /** Execution-only elapsed ms (excludes parked wait time). */
  executionMs: number;
  /** Agent's one-line summary from the most recent fix round, or null. */
  fixSummary: string | null;
}

/**
 * One execution round of a step (spec §1 `step_rounds`). Drives the round-history
 * prompt section and records what the user/auto-fixer selected each round.
 */
export interface StepRoundRecord {
  runId: string;
  step: string;
  round: number;
  /** "initial" for the first execution, "auto_fix" for every fix re-run. */
  trigger: "initial" | "auto_fix";
  /** Findings JSON produced this round (canonical wire), or null. */
  findingsJson: string | null;
  /** Merged user-override findings JSON for a user-driven fix round, or null. */
  userFindingsJson: string | null;
  /** JSON array of the finding ids selected for this round's fix, or null. */
  selectedFindingIds: string | null;
  /** Who selected: "auto_fix" (cap-driven) or "user" (respond fix), or null. */
  selectionSource: "auto_fix" | "user" | null;
  /** Agent's one-line fix summary for the round, or null. */
  fixSummary: string | null;
  /** Round wall-clock ms. */
  durationMs: number;
}

// ── Findings model (the safety contract — ported field-for-field) ───

export type FindingSeverity = "error" | "warning" | "info";
/** MISSING/empty/unknown `action` deserializes to `ask-user` — FAIL CLOSED. */
export type FindingAction = "no-op" | "auto-fix" | "ask-user";
export type FindingSource = "agent" | "user";

export interface Finding {
  id: string;
  severity: FindingSeverity;
  file: string;
  line: number | null;
  description: string;
  action: FindingAction;
  source: FindingSource;
  userInstructions: string;
  category: string;
}

export interface Findings {
  items: Finding[];
  summary: string;
  tested: string[];
  testingSummary: string;
  artifacts: string[];
  riskLevel: string;
  riskRationale: string;
}

const VALID_SEVERITIES: ReadonlySet<string> = new Set(["error", "warning", "info"]);
const VALID_ACTIONS: ReadonlySet<string> = new Set(["no-op", "auto-fix", "ask-user"]);

/** Coerce an unknown to string, defaulting to "". */
function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}
/** Coerce an unknown to a string[]. */
function strArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}
/**
 * First non-"" string among `keys` on `o`. Lets deserialization accept BOTH the
 * agent/upstream wire spelling (snake_case) and the internal camelCase spelling
 * for the same field, so a value survives a round-trip regardless of which
 * boundary produced it.
 */
function pick(o: Record<string, unknown>, ...keys: string[]): string {
  for (const k of keys) {
    const v = str(o[k]);
    if (v !== "") return v;
  }
  return "";
}

/**
 * Deserialize ONE finding, FAILING CLOSED on `action`: a missing, empty, or
 * unrecognized `action` becomes `ask-user` (always blocks) — enforced at the
 * deserialization boundary, not just in app logic (spec §1 invariant 6). An
 * unknown `severity`/`source` normalizes to the most conservative value.
 */
export function deserializeFinding(raw: unknown): Finding {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawAction = str(o.action).trim();
  const action: FindingAction = VALID_ACTIONS.has(rawAction) ? (rawAction as FindingAction) : "ask-user";
  const rawSeverity = str(o.severity).trim();
  const severity: FindingSeverity = VALID_SEVERITIES.has(rawSeverity)
    ? (rawSeverity as FindingSeverity)
    : "error";
  const source: FindingSource = str(o.source).trim() === "user" ? "user" : "agent";
  const line = typeof o.line === "number" && Number.isFinite(o.line) ? o.line : null;
  return {
    id: str(o.id),
    severity,
    file: str(o.file),
    line,
    description: str(o.description),
    action,
    source,
    userInstructions: pick(o, "user_instructions", "userInstructions"),
    category: str(o.category),
  };
}

/**
 * Deserialize a full Findings blob, fail-closed per item. Never throws.
 *
 * Accepts BOTH wire shapes: the agent/upstream shape (items under the `findings`
 * key, snake_case scalars) and the internal camelCase shape (items under
 * `items`). The `findings` key wins when both are present, mirroring upstream's
 * `findingsWire` (Items json:"findings", Legacy json:"items"). The M0 stub only
 * read `items`/camelCase, so it silently dropped every real review finding — a
 * finding whose action the whole fail-closed contract exists to route.
 */
export function deserializeFindings(raw: unknown): Findings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const rawItems = Array.isArray(o.findings)
    ? o.findings
    : Array.isArray(o.items)
      ? o.items
      : [];
  return {
    items: rawItems.map(deserializeFinding),
    summary: str(o.summary),
    tested: strArray(o.tested),
    testingSummary: pick(o, "testing_summary", "testingSummary"),
    artifacts: strArray(o.artifacts),
    riskLevel: pick(o, "risk_level", "riskLevel"),
    riskRationale: pick(o, "risk_rationale", "riskRationale"),
  };
}

/**
 * Serialize Findings to the canonical wire shape (items under `findings`,
 * snake_case scalars) — the exact shape `deserializeFindings` reads back and the
 * shape the agent JSON schema emits, so persisted findings round-trip cleanly.
 * Fields the finding did not set are omitted (upstream's `omitempty`).
 */
export function serializeFindings(f: Findings): string {
  const items = f.items.map((it) => {
    const out: Record<string, unknown> = {
      severity: it.severity,
      description: it.description,
      action: it.action,
    };
    if (it.id) out.id = it.id;
    if (it.file) out.file = it.file;
    if (it.line !== null) out.line = it.line;
    if (it.source) out.source = it.source;
    if (it.userInstructions) out.user_instructions = it.userInstructions;
    if (it.category) out.category = it.category;
    return out;
  });
  const out: Record<string, unknown> = { findings: items, summary: f.summary };
  if (f.tested.length > 0) out.tested = f.tested;
  if (f.testingSummary) out.testing_summary = f.testingSummary;
  if (f.artifacts.length > 0) out.artifacts = f.artifacts;
  if (f.riskLevel) out.risk_level = f.riskLevel;
  if (f.riskRationale) out.risk_rationale = f.riskRationale;
  return JSON.stringify(out);
}

/** An empty, fully-formed Findings blob (fail-closed default). */
export function emptyFindings(): Findings {
  return deserializeFindings({});
}

// ── Run store (Storage-backed) ──────────────────────────────────────

const RUN_KEY_PREFIX = "runs/";
const STEP_KEY_PREFIX = "step_results/";
/** A single index key listing every run id (newest last). Avoids depending on
 *  the ambiguous `storage.list` element shape; mirrors ez-code's loop-store. */
const RUN_INDEX_KEY = "run-index";
/** In-process lock key serializing the index read-modify-write. */
const INDEX_LOCK = "ez-code-factory:run-index";
const ROUND_KEY_PREFIX = "step_rounds/";
const runKey = (id: string): string => `${RUN_KEY_PREFIX}${id}`;
const stepKey = (runId: string, step: string): string => `${STEP_KEY_PREFIX}${runId}/${step}`;
const roundsKey = (runId: string, step: string): string => `${ROUND_KEY_PREFIX}${runId}/${step}`;

/** Per-run + per-step storage ops the run manager + executor need. */
export interface RunStore {
  createRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord | null>;
  listRuns(): Promise<RunRecord[]>;
  putStepResult(step: StepResultRecord): Promise<void>;
  getStepResult(runId: string, step: string): Promise<StepResultRecord | null>;
  /** Append one execution round for a step (M1 executor round history). */
  appendStepRound(round: StepRoundRecord): Promise<void>;
  /** All recorded rounds for a step, in insertion order. */
  getStepRounds(runId: string, step: string): Promise<StepRoundRecord[]>;
  /** Patch the most-recent round of a step (e.g. record a user fix selection on
   *  the parked round). No-op when the step has no rounds. */
  patchLastStepRound(runId: string, step: string, patch: Partial<StepRoundRecord>): Promise<void>;
}

/** A RunStore backed by the SDK `Storage` for the given scope. */
export function createRunStore(scope: StorageScope = "global"): RunStore {
  const storage = new Storage(scope);
  const readIndex = async (): Promise<string[]> => {
    const r = await storage.get<string[]>(RUN_INDEX_KEY);
    return Array.isArray(r.value) ? r.value : [];
  };
  return {
    async createRun(run) {
      await storage.set(runKey(run.id), run);
      // Serialize the index read-modify-write so concurrent pushes on
      // different branches don't clobber each other's index entries.
      await withLock(INDEX_LOCK, async () => {
        const idx = await readIndex();
        if (!idx.includes(run.id)) {
          idx.push(run.id);
          await storage.set(RUN_INDEX_KEY, idx);
        }
      });
    },
    async getRun(id) {
      const r = await storage.get<RunRecord>(runKey(id));
      return r.exists ? (r.value as RunRecord) : null;
    },
    async updateRun(id, patch) {
      const r = await storage.get<RunRecord>(runKey(id));
      if (!r.exists || !r.value) return null;
      const next: RunRecord = { ...r.value, ...patch, updatedAt: new Date().toISOString() };
      await storage.set(runKey(id), next);
      return next;
    },
    async listRuns() {
      const idx = await readIndex();
      const runs: RunRecord[] = [];
      for (const id of idx) {
        const r = await storage.get<RunRecord>(runKey(id));
        if (r.exists && r.value) runs.push(r.value);
      }
      // Newest first.
      runs.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
      return runs;
    },
    async putStepResult(step) {
      await storage.set(stepKey(step.runId, step.step), step);
    },
    async getStepResult(runId, step) {
      const r = await storage.get<StepResultRecord>(stepKey(runId, step));
      return r.exists ? (r.value as StepResultRecord) : null;
    },
    async appendStepRound(round) {
      const key = roundsKey(round.runId, round.step);
      const r = await storage.get<StepRoundRecord[]>(key);
      const rounds = Array.isArray(r.value) ? r.value : [];
      rounds.push(round);
      await storage.set(key, rounds);
    },
    async getStepRounds(runId, step) {
      const r = await storage.get<StepRoundRecord[]>(roundsKey(runId, step));
      return Array.isArray(r.value) ? r.value : [];
    },
    async patchLastStepRound(runId, step, patch) {
      const key = roundsKey(runId, step);
      const r = await storage.get<StepRoundRecord[]>(key);
      const rounds = Array.isArray(r.value) ? r.value : [];
      if (rounds.length === 0) return;
      rounds[rounds.length - 1] = { ...rounds[rounds.length - 1]!, ...patch };
      await storage.set(key, rounds);
    },
  };
}

// ── Run manager (worktree lifecycle + mutex) ─────────────────────────

/** The subset of a `push-received` payload the run manager consumes. */
export interface PushReceived {
  repoId: string;
  branch: string;
  ref: string;
  newSha: string;
  /** The branch's previous tip (`oldrev`) — all-zeros / absent on a new branch.
   *  Threaded to RunRecord.baseSha (the force-push safety anchor). */
  oldSha?: string;
  /** Explicit intent from `git push gate -o intent="…"`, or null/absent.
   *  Optional because a push without intent is a valid state (the intent step
   *  degrades to skipped). Authoritative acceptance criteria when present (M1);
   *  sanitized before it ever enters an agent prompt (prompts.ts). */
  intent?: string | null;
}

/** Max accepted length of an explicit intent push option (defence in depth —
 *  the payload is attacker-reachable; the prompt layer also sanitizes it). */
const MAX_INTENT_LEN = 4000;

/**
 * Extract an explicit `intent=…` from the push options array (git forwards
 * each `-o key=value`). Returns the first `intent=` value, trimmed and length-
 * capped, or null when none is present or the value is blank. Non-array /
 * malformed input yields null (fail-safe: no intent rather than a throw).
 */
export function parseIntentOption(pushOptions: unknown): string | null {
  if (!Array.isArray(pushOptions)) return null;
  for (const opt of pushOptions) {
    if (typeof opt !== "string") continue;
    if (!opt.startsWith("intent=")) continue;
    const value = opt.slice("intent=".length).trim();
    if (!value) return null;
    return value.length > MAX_INTENT_LEN ? value.slice(0, MAX_INTENT_LEN) : value;
  }
  return null;
}

/**
 * Validate an untrusted `push-received` payload (attacker-controlled — the
 * events route only bounds size/shape). Returns the typed fields or null if
 * any required field is missing/blank. A SHA must be hex; a ref/branch must be
 * non-empty and free of shell/path traversal characters.
 */
export function parsePushReceived(payload: unknown): PushReceived | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const repoId = str(p.repoId).trim();
  const branch = str(p.branch).trim();
  const ref = str(p.ref).trim();
  const newSha = str(p.newSha).trim();
  if (!repoId || !branch || !ref || !newSha) return null;
  if (!/^[0-9a-f]{7,64}$/i.test(newSha)) return null;
  // Reject an all-zero SHA — that is a branch DELETION (git sends 40/64 zeros),
  // which has no commit to check out and would only yield a junk "failed" run.
  if (/^0+$/.test(newSha)) return null;
  if (!/^[0-9a-f]{12}$/i.test(repoId)) return null;
  // A gate acts on branch updates only: reject tag/other refs (defence in depth
  // — the hook skips them too, but the events route is attacker-reachable).
  if (!ref.startsWith("refs/heads/")) return null;
  // A ref/branch may not contain shell metacharacters or path traversal.
  if (/[^\w./\-]/.test(branch) || branch.includes("..")) return null;
  if (/[^\w./\-]/.test(ref) || ref.includes("..")) return null;
  // oldrev: hex (7-64) or all-zeros (a brand-new branch). Anything else → treat
  // as absent (all-zeros), never a throw.
  const rawOld = str(p.oldSha).trim();
  const oldSha = /^[0-9a-f]{7,64}$/i.test(rawOld) ? rawOld : "0".repeat(40);
  return { repoId, branch, ref, newSha, oldSha, intent: parseIntentOption(p.pushOptions) };
}

/** A user's approval action at a parked gate. */
export type RespondAction = "approve" | "fix" | "skip" | "abort";
const RESPOND_ACTIONS: ReadonlySet<string> = new Set(["approve", "fix", "skip", "abort"]);

/** A validated `respond` gate action. */
export interface ParsedRespond {
  runId: string;
  step: PipelineStep;
  action: RespondAction;
  /** Agent-produced finding ids the user selected for a fix. */
  findingIds: string[];
  /** Per-finding user instructions, keyed by finding id. */
  instructions: Record<string, string>;
  /** User-authored findings to merge in for a fix. */
  addedFindings: unknown[];
}

/**
 * Validate an untrusted `respond` payload (attacker-reachable via the events
 * route). Requires a non-empty runId, a known pipeline step, and one of the
 * four actions; the fix-only fields default to empty. Returns null on any
 * violation — a malformed respond is a silent no-op, never a throw.
 */
export function parseRespondPayload(payload: unknown): ParsedRespond | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  const runId = str(p.runId).trim();
  const step = str(p.step).trim();
  const action = str(p.action).trim();
  if (!runId) return null;
  if (!(PIPELINE_STEPS as readonly string[]).includes(step)) return null;
  if (!RESPOND_ACTIONS.has(action)) return null;
  const findingIds = Array.isArray(p.findingIds)
    ? p.findingIds.filter((x): x is string => typeof x === "string")
    : [];
  const instructions: Record<string, string> = {};
  if (p.instructions && typeof p.instructions === "object") {
    for (const [k, v] of Object.entries(p.instructions as Record<string, unknown>)) {
      if (typeof v === "string") instructions[k] = v;
    }
  }
  const addedFindings = Array.isArray(p.addedFindings) ? p.addedFindings : [];
  return { runId, step: step as PipelineStep, action: action as RespondAction, findingIds, instructions, addedFindings };
}

/** Deterministic run id (sortable-ish; unique per push). */
export function newRunId(): string {
  return `run_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

/** Path of a run's detached worktree under the per-extension TMPDIR. */
export function worktreePathFor(tmpBase: string, repoId: string, runId: string): string {
  return join(tmpBase, "worktrees", repoId, runId);
}

export interface RunManagerDeps {
  /** Absolute gate bare-repo dir the pushed objects landed in. */
  gateDir: string;
  /** Base dir for per-run worktrees (the per-extension TMPDIR). */
  tmpBase: string;
  store: RunStore;
  run: ShellRunner;
  /** Called after each persisted state change so the caller can refresh the
   *  dashboard. Optional (tests omit it). */
  onChange?: () => Promise<void> | void;
  /**
   * Run the M1 pipeline against the ready worktree. Returns whether the run
   * PARKED at a gate. When omitted (M0), the lifecycle just marks the run
   * completed and tears the worktree down (the original behaviour). When
   * provided and the run parks, the worktree is KEPT (the human reviews +
   * fixes in it) and torn down later by `resumeGateLifecycle` on a terminal
   * respond; otherwise it is torn down here. The pipeline owns the run status.
   */
  runPipeline?: (ctx: { runId: string; worktreePath: string }) => Promise<{ parked: boolean }>;
}

export interface RunLifecycleResult {
  ok: boolean;
  runId: string;
  worktreePath: string;
  status: RunStatus;
  error?: string;
}

/** Remove a run's detached worktree, pruning as a fallback. Best-effort. */
export async function removeWorktree(run: ShellRunner, gateDir: string, wtPath: string): Promise<void> {
  const removed = await run(["git", "-C", gateDir, "worktree", "remove", "--force", wtPath], gateDir);
  if (removed.exitCode !== 0) {
    await run(["git", "-C", gateDir, "worktree", "prune"], gateDir);
  }
}

/**
 * Handle one validated push: create a run record, materialize a detached
 * worktree from the gate repo at `newSha`, record it, then tear it down. Runs
 * under a per-(repo,branch) in-process mutex so concurrent pushes to the SAME
 * branch serialize (different branches stay concurrent). The worktree is
 * removed on BOTH the success and failure paths.
 */
export async function runGateLifecycle(
  push: PushReceived,
  deps: RunManagerDeps,
): Promise<RunLifecycleResult> {
  const { gateDir, tmpBase, store, run } = deps;
  const notify = async () => {
    if (deps.onChange) await deps.onChange();
  };
  return withLock(`${push.repoId}:${push.branch}`, async (): Promise<RunLifecycleResult> => {
    const runId = newRunId();
    const wtPath = worktreePathFor(tmpBase, push.repoId, runId);
    let added = false;
    let keepWorktree = false;
    try {
      const now = new Date().toISOString();
      const intent = push.intent ?? null;
      const record: RunRecord = {
        id: runId,
        repoId: push.repoId,
        branch: push.branch,
        ref: push.ref,
        headSha: push.newSha,
        baseSha: push.oldSha ?? "0".repeat(40),
        status: "created",
        worktreePath: null,
        createdAt: now,
        updatedAt: now,
        parkedMs: 0,
        awaitingAgentSince: null,
        intent,
        intentSource: intent ? "agent" : null,
      };
      await store.createRun(record);
      await notify();

      const add = await run(
        ["git", "-C", gateDir, "worktree", "add", "--detach", wtPath, push.newSha],
        gateDir,
      );
      if (add.exitCode !== 0) {
        await store.updateRun(runId, {
          status: "failed",
          error: `worktree add failed (exit ${add.exitCode}): ${add.stderr.trim() || add.stdout.trim()}`,
        });
        await notify();
        return { ok: false, runId, worktreePath: wtPath, status: "failed", error: add.stderr.trim() };
      }
      added = true;
      // Best-effort per-worktree hook isolation: a checkout must not inherit
      // the bare repo's post-receive hook or bareness. No-op on old git.
      await run(["git", "-C", wtPath, "config", "--worktree", "core.bare", "false"], wtPath);
      await store.updateRun(runId, { status: "worktree_ready", worktreePath: wtPath });
      await notify();

      // M1: run the pipeline against the worktree. When it parks at a gate, KEEP
      // the worktree (the human reviews + fixes in it; a later respond resumes +
      // tears down). Otherwise it reached a terminal state — tear down here. When
      // no pipeline is wired (M0), fall back to the record-and-teardown behaviour.
      if (deps.runPipeline) {
        const { parked } = await deps.runPipeline({ runId, worktreePath: wtPath });
        if (parked) {
          keepWorktree = true;
          const parkedRun = await store.getRun(runId);
          return {
            ok: true,
            runId,
            worktreePath: wtPath,
            status: parkedRun?.status ?? "awaiting_approval",
          };
        }
        const finalRun = await store.getRun(runId);
        const status = finalRun?.status ?? "failed";
        return { ok: status === "completed", runId, worktreePath: wtPath, status, error: finalRun?.error };
      }

      await store.updateRun(runId, { status: "completed" });
      await notify();
      return { ok: true, runId, worktreePath: wtPath, status: "completed" };
    } catch (err) {
      // A THROW mid-lifecycle (e.g. a Storage RPC rejecting) would otherwise be
      // swallowed by the SDK channel's fire-and-forget notification path,
      // leaving the run stuck at created/worktree_ready forever with no trace.
      // Mark it failed (best-effort — the failing RPC may be the status write
      // itself) and surface one stderr line; the `finally` still tears the
      // worktree down so a throw never leaks a checkout.
      const message = err instanceof Error ? err.message : String(err);
      try {
        await store.updateRun(runId, { status: "failed", error: `lifecycle error: ${message}` });
        await notify();
      } catch {
        /* storage itself is unreachable — nothing more we can durably record */
      }
      process.stderr.write(`ez-code-factory: run ${runId} lifecycle error: ${message}\n`);
      return { ok: false, runId, worktreePath: wtPath, status: "failed", error: message };
    } finally {
      // Tear the worktree down on every terminal path (success + failure +
      // throw) so a run never leaks a checkout — UNLESS the pipeline parked, in
      // which case the worktree is deliberately kept for the human's review/fix
      // and removed by resumeGateLifecycle on the terminal respond.
      if (added && !keepWorktree) {
        await removeWorktree(run, gateDir, wtPath);
      }
    }
  });
}

/** Deps for resuming a parked run on a respond event. */
export interface ResumeDeps {
  gateDir: string;
  store: RunStore;
  run: ShellRunner;
  onChange?: () => Promise<void> | void;
  /** Apply the respond action to the parked run. Its RESULT is deliberately
   *  untrusted: worktree teardown keys off the run's PERSISTED status only. */
  respond: (ctx: { runId: string; worktreePath: string }) => Promise<unknown>;
}

/**
 * Resume a parked run when a `respond` event (approve/fix/skip/abort) arrives.
 * Reattaches the run's kept worktree, applies the action via the executor, and
 * tears the worktree down once the run's PERSISTED status is terminal (a
 * re-park keeps it). A REJECTED respond (stale dashboard, wrong step) reports
 * failure without touching the run — it stays awaiting_approval and MUST be
 * side-effect-free here, so teardown never keys off the respond result.
 * Returns the run's status, or null when the run/worktree is unavailable.
 */
export async function resumeGateLifecycle(
  runId: string,
  deps: ResumeDeps,
): Promise<{ status: RunStatus; parked: boolean } | null> {
  const rec = await deps.store.getRun(runId);
  if (!rec || !rec.worktreePath) return null;
  const wtPath = rec.worktreePath;
  return withLock(`${rec.repoId}:${rec.branch}`, async () => {
    let after: RunRecord | null = null;
    try {
      await deps.respond({ runId, worktreePath: wtPath });
    } finally {
      // Teardown keys off the run's PERSISTED status — never the respond
      // result. A rejected respond leaves the run parked (awaiting_approval);
      // destroying its kept worktree would strand the run with nothing left
      // to resume. Only a persisted terminal state releases the checkout —
      // and on doubt (store unreadable mid-teardown) we keep it: a leaked
      // worktree is recoverable, the human's kept one is not.
      try {
        after = await deps.store.getRun(runId);
      } catch {
        after = null;
      }
      if (after && isTerminalRunStatus(after.status)) {
        await removeWorktree(deps.run, deps.gateDir, wtPath);
      }
    }
    if (deps.onChange) await deps.onChange();
    return { status: after?.status ?? "failed", parked: after?.status === "awaiting_approval" };
  });
}
