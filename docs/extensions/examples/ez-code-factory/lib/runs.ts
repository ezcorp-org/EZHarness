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

// ── Persistence schema (spec §1 subset for M0) ──────────────────────

export type RunStatus = "created" | "worktree_ready" | "completed" | "failed";

/** One intercepted push. Mirrors the upstream `runs` table (M0 subset). */
export interface RunRecord {
  id: string;
  repoId: string;
  branch: string;
  ref: string;
  headSha: string;
  status: RunStatus;
  worktreePath: string | null;
  createdAt: string;
  updatedAt: string;
  /** ms the run has spent parked awaiting a human (0 until gates land). */
  parkedMs: number;
  /** ISO time an agent started waiting on this run, or null. NULL vs 0 is
   *  load-bearing telemetry the upstream schema keeps distinct. */
  awaitingAgentSince: string | null;
  error?: string;
}

/** One step's outcome (spec §1 `step_results`). Empty in M0 — the contract
 *  exists so pipeline milestones write findings without a schema change. */
export interface StepResultRecord {
  runId: string;
  step: string;
  findings: Findings;
  agentPid: number | null;
  autoFixLimit: number;
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
    userInstructions: str(o.userInstructions),
    category: str(o.category),
  };
}

/** Deserialize a full Findings blob, fail-closed per item. Never throws. */
export function deserializeFindings(raw: unknown): Findings {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const items = Array.isArray(o.items) ? o.items.map(deserializeFinding) : [];
  return {
    items,
    summary: str(o.summary),
    tested: strArray(o.tested),
    testingSummary: str(o.testingSummary),
    artifacts: strArray(o.artifacts),
    riskLevel: str(o.riskLevel),
    riskRationale: str(o.riskRationale),
  };
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
const runKey = (id: string): string => `${RUN_KEY_PREFIX}${id}`;
const stepKey = (runId: string, step: string): string => `${STEP_KEY_PREFIX}${runId}/${step}`;

/** Per-run + per-step storage ops the run manager needs. */
export interface RunStore {
  createRun(run: RunRecord): Promise<void>;
  getRun(id: string): Promise<RunRecord | null>;
  updateRun(id: string, patch: Partial<RunRecord>): Promise<RunRecord | null>;
  listRuns(): Promise<RunRecord[]>;
  putStepResult(step: StepResultRecord): Promise<void>;
  getStepResult(runId: string, step: string): Promise<StepResultRecord | null>;
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
  };
}

// ── Run manager (worktree lifecycle + mutex) ─────────────────────────

/** The subset of a `push-received` payload the run manager consumes. */
export interface PushReceived {
  repoId: string;
  branch: string;
  ref: string;
  newSha: string;
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
  if (!/^[0-9a-f]{12}$/i.test(repoId)) return null;
  // A ref/branch may not contain shell metacharacters or path traversal.
  if (/[^\w./\-]/.test(branch) || branch.includes("..")) return null;
  if (/[^\w./\-]/.test(ref) || ref.includes("..")) return null;
  return { repoId, branch, ref, newSha };
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
}

export interface RunLifecycleResult {
  ok: boolean;
  runId: string;
  worktreePath: string;
  status: RunStatus;
  error?: string;
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
    const now = new Date().toISOString();
    const record: RunRecord = {
      id: runId,
      repoId: push.repoId,
      branch: push.branch,
      ref: push.ref,
      headSha: push.newSha,
      status: "created",
      worktreePath: null,
      createdAt: now,
      updatedAt: now,
      parkedMs: 0,
      awaitingAgentSince: null,
    };
    await store.createRun(record);
    await notify();

    let added = false;
    try {
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

      // M0 stops here — no pipeline. Later milestones run steps against the
      // worktree between here and teardown.
      await store.updateRun(runId, { status: "completed" });
      await notify();
      return { ok: true, runId, worktreePath: wtPath, status: "completed" };
    } finally {
      // Tear the worktree down on EVERY path (success + failure) so a run
      // never leaks a checkout. `prune` is the belt-and-suspenders fallback if
      // `remove` itself failed (e.g. a stuck lock).
      if (added) {
        const removed = await run(
          ["git", "-C", gateDir, "worktree", "remove", "--force", wtPath],
          gateDir,
        );
        if (removed.exitCode !== 0) {
          await run(["git", "-C", gateDir, "worktree", "prune"], gateDir);
        }
      }
    }
  });
}
