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
  /** Optional operator instructions (≤ 500 chars) appended, sanitized, to the
   *  review-main + review-fix agent prompts. Empty/absent → nothing appended. */
  reviewInstructions?: string;
  /** Optional operator instructions (≤ 500 chars) appended, sanitized, to the
   *  three fix-round agent prompts (review-fix, test-fix, lint-fix). */
  fixInstructions?: string;
  /** Optional operator instructions (≤ 500 chars) appended, sanitized, to the
   *  document (housekeeping) agent prompt. */
  documentInstructions?: string;
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
  reviewInstructions?: string;
  fixInstructions?: string;
  documentInstructions?: string;
}

export const DEFAULT_JOB_ID = "default";
export const MAX_JOB_NAME_LEN = 80;
export const MAX_BRANCH_PATTERN_LEN = 120;
/** Shared cap for the free-text job fields (intent template + the three prompt
 *  instruction fields). ONE literal so the validator clamp, the Edit-job intent
 *  field, and the Edit-prompts dialog fields never drift (DRY — page.ts's
 *  MAX_INTENT_TEMPLATE_LEN aliases this). Also the host form validator's [1,500]
 *  ceiling — a larger hint is silently clamped, so this is the effective bound. */
export const MAX_JOB_TEXT_LEN = 500;
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
  // Prompt instructions: trim, clamp ≤ MAX_JOB_TEXT_LEN, empty → omitted (so a
  // cleared field actually removes the value — sibling-survival is handled by
  // the explicit carry in handleJobSave, not by keeping a stale value here).
  const review = clampJobText(draft.reviewInstructions);
  if (review) value.reviewInstructions = review;
  const fix = clampJobText(draft.fixInstructions);
  if (fix) value.fixInstructions = fix;
  const document = clampJobText(draft.documentInstructions);
  if (document) value.documentInstructions = document;
  return { ok: true, value };
}

/** Trim + clamp a free-text job field to {@link MAX_JOB_TEXT_LEN}; "" for a
 *  blank/absent value (the caller omits an empty field so a clear removes it). */
function clampJobText(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw.trim().slice(0, MAX_JOB_TEXT_LEN);
}

/**
 * Parse a free-form trigger spec (collected by the Edit-job form's `trigger`
 * field, prefilled via {@link formatTriggerSpec}) into a `JobTrigger`. Accepts
 * exactly the three shapes:
 *   - `push <pattern>`            (literal or single trailing '*' glob)
 *   - `schedule <every> <branch>` (`every` ∈ 15m|hourly|daily; literal branch)
 *   - `manual <branch>`           (literal branch)
 * Returns null on any malformed input — the caller surfaces a validation error
 * rather than silently keeping the old trigger. Branch validity is enforced by
 * the subsequent `validateJobDraft` (not here), so a bad branch still fails save.
 */
export function parseTriggerSpec(spec: string): JobTrigger | null {
  const parts = spec.trim().split(/\s+/).filter((p) => p !== "");
  const [kind, a, b] = parts;
  if (kind === "push" && a) return { kind: "push", branchPattern: a };
  if (kind === "manual" && a) return { kind: "manual", branch: a };
  if (kind === "schedule" && a && b) {
    if (a === "15m" || a === "hourly" || a === "daily") return { kind: "schedule", every: a, branch: b };
  }
  return null;
}

/**
 * Format a `JobTrigger` back into the free-form spec grammar {@link parseTriggerSpec}
 * accepts — the EXACT inverse, so `parseTriggerSpec(formatTriggerSpec(t))` round-trips
 * for every trigger (pinned by a test). Used to PREFILL the Edit-job form's trigger
 * field with the job's current trigger. Distinct from `triggerLabel` (page.ts), whose
 * ` · ` separators parseTriggerSpec MIS-parses — using it for the prefill would
 * silently corrupt the trigger on every save.
 */
export function formatTriggerSpec(t: JobTrigger): string {
  switch (t.kind) {
    case "push":
      return `push ${t.branchPattern}`;
    case "schedule":
      return `schedule ${t.every} ${t.branch}`;
    case "manual":
      return `manual ${t.branch}`;
  }
}

/** The concrete branch a `run-now` (or schedule tick) resolves a run on. A
 *  schedule/manual job carries a literal `branch`; a push job's `branchPattern`
 *  is concrete ONLY when it has no `*` glob (a glob push job has no single branch
 *  to run — run-now refuses it). */
export function jobConcreteBranch(job: Job): string | null {
  if (job.trigger.kind === "push") {
    return job.trigger.branchPattern.includes("*") ? null : job.trigger.branchPattern;
  }
  return job.trigger.branch;
}

/** Validate + extract a `jobId` from an attacker-reachable page-action payload
 *  (job-toggle / job-delete / run-now). Trimmed non-empty string, or null (the
 *  handler logs "invalid payload" and no-ops). Never throws. */
export function parseJobIdPayload(payload: unknown): string | null {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const jobId = (payload as Record<string, unknown>).jobId;
  if (typeof jobId !== "string") return null;
  const trimmed = jobId.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * The payload keys a job-edit prompt may carry. Each MUST be a slug-legal
 * payload key: the host `validatePrompt` (src/extensions/page-schema.ts:44,
 * `PROMPT_FIELD_REGEX = /^[a-z0-9][a-z0-9_]{0,31}$/`) silently rewrites any
 * non-slug `prompt.field` to the reserved `"value"` key — so a camelCase field
 * (e.g. `agentName`) would arrive under `payload.value` and this handler would
 * read `undefined`, silently CLEARING the field while still stamping updatedBy +
 * an audit line (a real live bug). These keys are lowercase snake_case ON
 * PURPOSE so the typed value survives the host validator intact. Every
 * prompt-driven builder MUST emit exactly these as its prompt `field` value
 * (pinned by a test). `toggle_step` is the ONE exception: it is a static
 * row-action payload KEY (the flow-table Skip/Run toggle), never a prompt
 * field, so the slug regex never touches it — it is listed here only so
 * {@link hasJobEditField} recognizes a toggle-only save as a real edit.
 */
export const JOB_EDIT_FIELDS = [
  "name",
  "branch_pattern",
  "trigger",
  "skip_steps",
  "agent_name",
  "intent_template",
  "review_instructions",
  "fix_instructions",
  "document_instructions",
  "toggle_step",
] as const;

/** True when a job-save payload carries at least one recognized editable field.
 *  A payload with none (e.g. a drifted camelCase field the host rewrote to
 *  `value`) must be REJECTED, never silently applied — see handleJobSave. */
export function hasJobEditField(patch: Record<string, unknown>): boolean {
  return JOB_EDIT_FIELDS.some((f) => patch[f] !== undefined);
}

/**
 * Fold ONE editable scalar (collected by a job-editor prompt) into a base draft
 * (the existing job's fields, or the create defaults). Each edit action supplies
 * exactly one of the slug-legal {@link JOB_EDIT_FIELDS}; whichever is present
 * overrides. `branch_pattern` applies to whichever field the CURRENT trigger
 * uses (push → pattern, schedule/manual → branch). An unparseable `trigger` spec
 * is a hard error (never a silent no-op). The RESULT still passes through
 * `validateJobDraft` at the call site — this only assembles the candidate.
 */
export function applyJobEdit(
  base: JobDraft,
  patch: Record<string, unknown>,
): { ok: true; draft: JobDraft } | { ok: false; error: string } {
  const draft: JobDraft = {
    name: base.name,
    trigger: { ...base.trigger },
    enabled: base.enabled,
    skipSteps: [...base.skipSteps],
    ...(base.agentName !== undefined ? { agentName: base.agentName } : {}),
    ...(base.intentTemplate !== undefined ? { intentTemplate: base.intentTemplate } : {}),
    // Sibling-survival carry site (1 of 4): fold the existing instructions into
    // the draft so editing an UNRELATED field (name, trigger, a sibling
    // instruction) never silently clears them.
    ...(base.reviewInstructions !== undefined ? { reviewInstructions: base.reviewInstructions } : {}),
    ...(base.fixInstructions !== undefined ? { fixInstructions: base.fixInstructions } : {}),
    ...(base.documentInstructions !== undefined ? { documentInstructions: base.documentInstructions } : {}),
  };
  if (typeof patch.name === "string") draft.name = patch.name;
  if (typeof patch.branch_pattern === "string") {
    draft.trigger =
      draft.trigger.kind === "push"
        ? { kind: "push", branchPattern: patch.branch_pattern }
        : { ...draft.trigger, branch: patch.branch_pattern };
  }
  if (typeof patch.trigger === "string") {
    const parsed = parseTriggerSpec(patch.trigger);
    if (!parsed) {
      return { ok: false, error: "trigger must be like 'push feat/*', 'schedule daily main', or 'manual main'" };
    }
    draft.trigger = parsed;
  }
  if (typeof patch.skip_steps === "string") {
    draft.skipSteps = patch.skip_steps
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== "") as PipelineStep[];
  }
  if (typeof patch.agent_name === "string") {
    const trimmed = patch.agent_name.trim();
    if (trimmed) draft.agentName = trimmed;
    else delete draft.agentName;
  }
  if (typeof patch.intent_template === "string") {
    const trimmed = patch.intent_template.trim();
    if (trimmed) draft.intentTemplate = trimmed;
    else delete draft.intentTemplate;
  }
  // Prompt-instruction fields: a present string OVERRIDES (blank clears — the
  // Edit-prompts dialog submits all three every save, so a cleared field must
  // remove, not keep). The ≤ 500 clamp is applied later by validateJobDraft.
  if (typeof patch.review_instructions === "string") {
    const trimmed = patch.review_instructions.trim();
    if (trimmed) draft.reviewInstructions = trimmed;
    else delete draft.reviewInstructions;
  }
  if (typeof patch.fix_instructions === "string") {
    const trimmed = patch.fix_instructions.trim();
    if (trimmed) draft.fixInstructions = trimmed;
    else delete draft.fixInstructions;
  }
  if (typeof patch.document_instructions === "string") {
    const trimmed = patch.document_instructions.trim();
    if (trimmed) draft.documentInstructions = trimmed;
    else delete draft.documentInstructions;
  }
  // Flow-table Skip↔Run toggle: XOR a single step in/out of skipSteps. The step
  // must be a known pipeline step and MUST NOT be protected (protected steps
  // always run — the row carries no toggle). Both rejections are hard errors so
  // the caller audits the refusal rather than silently mutating nothing.
  if (typeof patch.toggle_step === "string") {
    const step = patch.toggle_step.trim();
    if (!PIPELINE_STEP_SET.has(step)) {
      return { ok: false, error: `unknown step: ${step || "(empty)"}` };
    }
    if (PROTECTED_STEPS.includes(step as PipelineStep)) {
      return { ok: false, error: `cannot skip protected step '${step}' — it always runs` };
    }
    const idx = draft.skipSteps.indexOf(step as PipelineStep);
    if (idx >= 0) draft.skipSteps.splice(idx, 1);
    else draft.skipSteps.push(step as PipelineStep);
  }
  return { ok: true, draft };
}

/** Shallow old→new field diff for audit `detail` (never stores secrets — jobs
 *  hold none). Only changed top-level fields are reported. */
export function diffJob(before: Job, after: Job): Record<string, { from: unknown; to: unknown }> {
  const diff: Record<string, { from: unknown; to: unknown }> = {};
  const fields: (keyof Job)[] = [
    "name",
    "trigger",
    "enabled",
    "skipSteps",
    "agentName",
    "intentTemplate",
    "reviewInstructions",
    "fixInstructions",
    "documentInstructions",
  ];
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
