// ── Jobs — named pipeline jobs per project (spec L4, ECF-native) ─────
//
// Multiple named jobs per project, each independently triggered by push
// (branch pattern), schedule (coarse sweep-tick routing), or manual ("Run
// now"). Jobs are ECF-NATIVE (NOT defineLoop) — they reuse ECF's existing
// RunRecord / step / IO machinery rather than adding a second run-record state
// machine. The kill switch still applies transitively (push fires ride the
// events route; tick fires ride the schedule daemon — both host-gated).
//
// Storage mirrors lib/runs.ts exactly: the SDK `Storage("global")` bucket with
// a `jobs/<jobId>` key family + a single `job-index` list, serialized by an
// in-process index lock. A DEFAULT job (`push`, pattern `*`, all steps,
// enabled) is auto-seeded on first read so today's behavior is preserved
// exactly; the seed is audited as actor `"system"`.

import { Storage, withLock } from "@ezcorp/sdk/runtime";
import type { StorageScope } from "@ezcorp/sdk/runtime";
import { PIPELINE_STEPS, type PipelineStep } from "./config";
import type { AuditLog } from "./audit";

// ── Model ───────────────────────────────────────────────────────────

/** Coarse schedule cadences routed off the existing every-15-min sweep tick. */
export type ScheduleEvery = "15m" | "hourly" | "daily";

/** How a job is triggered. */
export type JobTrigger =
  | { kind: "push"; branchPattern: string }
  | { kind: "schedule"; every: ScheduleEvery; branch: string }
  | { kind: "manual"; branch: string };

/** One named pipeline job. */
export interface Job {
  id: string;
  name: string;
  trigger: JobTrigger;
  enabled: boolean;
  /** Steps this job skips (reason `skipped by job <name>`). PROTECTED steps
   *  (intent/rebase/review/push) are rejected on save. */
  skipSteps: PipelineStep[];
  /** Optional agent override threaded into the run's dispatch options. */
  agentName?: string;
  /** Optional intent template applied to synthesized runs. */
  intentTemplate?: string;
  createdBy: string;
  createdAt: string;
  updatedBy: string;
  updatedAt: string;
  /** Last synthesized-run head sha, bookkept after each schedule/manual run so
   *  a no-change tick mints no no-op run (synthesized-run contract, C2). */
  lastHeadSha?: string;
  /** Last schedule-tick fire instant (ISO) for coarse due-evaluation. */
  lastScheduleFireAt?: string;
}

/** The editable subset a save action supplies (ids/timestamps are host-owned). */
export interface JobDraft {
  name: string;
  trigger: JobTrigger;
  enabled: boolean;
  skipSteps: PipelineStep[];
  agentName?: string;
  intentTemplate?: string;
}

export const DEFAULT_JOB_ID = "default";
export const MAX_JOB_NAME_LEN = 80;
export const MAX_BRANCH_PATTERN_LEN = 120;
/** Steps that MUST always run — skipping any would bypass the product's gate
 *  (review) or break the pipeline (intent/rebase/push). Rejected on save. */
export const PROTECTED_STEPS: readonly PipelineStep[] = ["intent", "rebase", "review", "push"] as const;
const SCHEDULE_EVERY: ReadonlySet<string> = new Set<ScheduleEvery>(["15m", "hourly", "daily"]);
const PIPELINE_STEP_SET: ReadonlySet<string> = new Set(PIPELINE_STEPS);

// ── Branch pattern matching (literal or single trailing '*' glob) ────

/** A branch pattern is a literal branch name, optionally with ONE trailing `*`
 *  glob. No regex, no interior/leading globs — validated + clamped on save. */
export function branchPatternValid(pattern: string): boolean {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.length > MAX_BRANCH_PATTERN_LEN) {
    return false;
  }
  const body = pattern.endsWith("*") ? pattern.slice(0, -1) : pattern;
  // Body may be empty (pattern "*"); otherwise branch-safe chars only (no
  // shell metacharacters / traversal — same charset as parsePushReceived).
  return /^[\w./\-]*$/.test(body) && !body.includes("..");
}

/** Match a branch against a (pre-validated) pattern: exact, or trailing-glob
 *  prefix. */
export function matchBranch(pattern: string, branch: string): boolean {
  if (pattern.endsWith("*")) return branch.startsWith(pattern.slice(0, -1));
  return pattern === branch;
}

/**
 * Pick the enabled PUSH job that best matches `branch`. An EXACT-branch job
 * beats any glob; among globs a longer prefix beats a shorter one; the default
 * catch-all (`*`) is least specific and only wins when nothing else matches.
 * Returns null when no enabled push job matches (caller audits `push-ignored`).
 */
export function matchPushJob(jobs: readonly Job[], branch: string): Job | null {
  let best: Job | null = null;
  let bestScore = -1;
  for (const job of jobs) {
    if (!job.enabled || job.trigger.kind !== "push") continue;
    const pattern = job.trigger.branchPattern;
    if (!matchBranch(pattern, branch)) continue;
    // Exact match dominates any glob; a longer glob prefix beats a shorter one.
    const score = pattern.endsWith("*") ? pattern.length - 1 : pattern.length + 1000;
    if (score > bestScore) {
      best = job;
      bestScore = score;
    }
  }
  return best;
}

// ── Schedule due-evaluation (coarse, off the every-15-min sweep tick) ─

function sameHourUTC(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate() && a.getUTCHours() === b.getUTCHours();
}
function sameDayUTC(a: Date, b: Date): boolean {
  return a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()
    && a.getUTCDate() === b.getUTCDate();
}

/**
 * Is a SCHEDULE-trigger job due on this sweep tick?
 *   - `15m`    → every tick (the sweep cron runs every 15 min).
 *   - `hourly` → the first tick of an hour it hasn't fired in.
 *   - `daily`  → the first tick of a UTC day it hasn't fired in.
 * `lastFireAt` is the job's own last-fire bookkeeping (null = never fired).
 * Non-schedule jobs are never due here.
 */
export function isScheduleJobDue(job: Job, now: Date, lastFireAt: Date | null): boolean {
  if (job.trigger.kind !== "schedule") return false;
  switch (job.trigger.every) {
    case "15m": return true;
    case "hourly": return lastFireAt === null || !sameHourUTC(lastFireAt, now);
    case "daily": return lastFireAt === null || !sameDayUTC(lastFireAt, now);
    default: return false;
  }
}

/** A synthesized run is only worth minting when HEAD actually advanced past the
 *  job's last bookkept head — never mint a no-op run (C2). */
export function shouldSynthesizeRun(job: Job, newSha: string): boolean {
  if (!newSha) return false;
  return job.lastHeadSha === undefined || job.lastHeadSha !== newSha;
}

// ── Validation (save-time) ──────────────────────────────────────────

/**
 * Validate + normalize a job draft. Returns the clamped value or the FIRST
 * validation error. Rejects: blank/over-long name, malformed trigger, invalid
 * branch pattern, unknown steps, and any PROTECTED step in `skipSteps`.
 */
export function validateJobDraft(
  draft: Partial<JobDraft>,
): { ok: true; value: JobDraft } | { ok: false; error: string } {
  const name = typeof draft.name === "string" ? draft.name.trim() : "";
  if (!name) return { ok: false, error: "name is required" };
  if (name.length > MAX_JOB_NAME_LEN) return { ok: false, error: `name must be ≤ ${MAX_JOB_NAME_LEN} chars` };

  const trigger = draft.trigger;
  if (!trigger || typeof trigger !== "object") return { ok: false, error: "trigger is required" };
  let normTrigger: JobTrigger;
  if (trigger.kind === "push") {
    if (!branchPatternValid(trigger.branchPattern)) {
      return { ok: false, error: `invalid branch pattern (literal or single trailing '*', ≤ ${MAX_BRANCH_PATTERN_LEN} chars)` };
    }
    normTrigger = { kind: "push", branchPattern: trigger.branchPattern };
  } else if (trigger.kind === "schedule") {
    if (!SCHEDULE_EVERY.has(trigger.every)) return { ok: false, error: "schedule 'every' must be 15m, hourly, or daily" };
    if (!branchPatternValid(trigger.branch) || trigger.branch.endsWith("*")) {
      return { ok: false, error: "schedule trigger requires a literal branch (no glob)" };
    }
    normTrigger = { kind: "schedule", every: trigger.every, branch: trigger.branch };
  } else if (trigger.kind === "manual") {
    if (!branchPatternValid(trigger.branch) || trigger.branch.endsWith("*")) {
      return { ok: false, error: "manual trigger requires a literal branch (no glob)" };
    }
    normTrigger = { kind: "manual", branch: trigger.branch };
  } else {
    return { ok: false, error: "trigger.kind must be push, schedule, or manual" };
  }

  const rawSkip = Array.isArray(draft.skipSteps) ? draft.skipSteps : [];
  const skipSteps: PipelineStep[] = [];
  for (const s of rawSkip) {
    if (!PIPELINE_STEP_SET.has(s as string)) return { ok: false, error: `unknown pipeline step: ${String(s)}` };
    if (PROTECTED_STEPS.includes(s as PipelineStep)) {
      return { ok: false, error: `step '${String(s)}' is protected and cannot be skipped` };
    }
    if (!skipSteps.includes(s as PipelineStep)) skipSteps.push(s as PipelineStep);
  }

  const value: JobDraft = {
    name,
    trigger: normTrigger,
    enabled: draft.enabled !== false,
    skipSteps,
  };
  if (typeof draft.agentName === "string" && draft.agentName.trim()) value.agentName = draft.agentName.trim();
  if (typeof draft.intentTemplate === "string" && draft.intentTemplate.trim()) {
    value.intentTemplate = draft.intentTemplate.trim();
  }
  return { ok: true, value };
}

/** Shallow old→new field diff for audit `detail` (never stores secrets — jobs
 *  hold none). Only changed top-level fields are reported. */
export function diffJob(before: Job, after: Job): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const fields: (keyof Job)[] = ["name", "trigger", "enabled", "skipSteps", "agentName", "intentTemplate"];
  for (const f of fields) {
    const a = JSON.stringify(before[f] ?? null);
    const b = JSON.stringify(after[f] ?? null);
    if (a !== b) diff[f] = { from: before[f] ?? null, to: after[f] ?? null };
  }
  return diff;
}

// ── Storage (jobs/<id> + job-index, mirroring the run store) ─────────

const JOB_KEY_PREFIX = "jobs/";
const JOB_INDEX_KEY = "job-index";
const JOB_INDEX_LOCK = "ez-code-factory:job-index";
const jobKey = (id: string): string => `${JOB_KEY_PREFIX}${id}`;

export interface JobStore {
  createJob(job: Job): Promise<void>;
  getJob(id: string): Promise<Job | null>;
  updateJob(id: string, patch: Partial<Job>): Promise<Job | null>;
  deleteJob(id: string): Promise<boolean>;
  listJobs(): Promise<Job[]>;
}

/** A JobStore backed by the SDK `Storage` for the given scope (default global). */
export function createJobStore(scope: StorageScope = "global"): JobStore {
  const storage = new Storage(scope);
  const readIndex = async (): Promise<string[]> => {
    const r = await storage.get<string[]>(JOB_INDEX_KEY);
    return Array.isArray(r.value) ? r.value : [];
  };
  return {
    async createJob(job) {
      await storage.set(jobKey(job.id), job);
      await withLock(JOB_INDEX_LOCK, async () => {
        const idx = await readIndex();
        if (!idx.includes(job.id)) {
          idx.push(job.id);
          await storage.set(JOB_INDEX_KEY, idx);
        }
      });
    },
    async getJob(id) {
      const r = await storage.get<Job>(jobKey(id));
      return r.exists && r.value ? r.value : null;
    },
    async updateJob(id, patch) {
      const r = await storage.get<Job>(jobKey(id));
      if (!r.exists || !r.value) return null;
      const next: Job = { ...r.value, ...patch, updatedAt: new Date().toISOString() };
      await storage.set(jobKey(id), next);
      return next;
    },
    async deleteJob(id) {
      const r = await storage.get<Job>(jobKey(id));
      if (!r.exists || !r.value) return false;
      await storage.delete(jobKey(id));
      await withLock(JOB_INDEX_LOCK, async () => {
        const idx = await readIndex();
        const next = idx.filter((x) => x !== id);
        if (next.length !== idx.length) await storage.set(JOB_INDEX_KEY, next);
      });
      return true;
    },
    async listJobs() {
      const idx = await readIndex();
      const jobs: Job[] = [];
      for (const id of idx) {
        const r = await storage.get<Job>(jobKey(id));
        if (r.exists && r.value) jobs.push(r.value);
      }
      return jobs;
    },
  };
}

/** The auto-seeded default job — preserves today's behavior EXACTLY: a push
 *  job matching every branch, all steps, enabled, owned by `"system"`. */
export function buildDefaultJob(now: string): Job {
  return {
    id: DEFAULT_JOB_ID,
    name: "Default",
    trigger: { kind: "push", branchPattern: "*" },
    enabled: true,
    skipSteps: [],
    createdBy: "system",
    createdAt: now,
    updatedBy: "system",
    updatedAt: now,
  };
}

/**
 * Load all jobs, AUTO-SEEDING the default job on first read (idempotent). The
 * seed itself is audited as actor `"system"`. Once any job exists this is a
 * plain list — a second call never re-seeds.
 */
export async function loadJobsWithDefault(store: JobStore, audit?: AuditLog): Promise<Job[]> {
  const jobs = await store.listJobs();
  if (jobs.length > 0) return jobs;
  // Guard the double-seed race: only the first writer audits.
  const existingDefault = await store.getJob(DEFAULT_JOB_ID);
  if (existingDefault) return [existingDefault];
  const def = buildDefaultJob(new Date().toISOString());
  await store.createJob(def);
  if (audit) {
    await audit.append({
      actor: "system",
      kind: "job-seed",
      jobId: def.id,
      detail: { name: def.name, trigger: def.trigger },
    });
  }
  return [def];
}
