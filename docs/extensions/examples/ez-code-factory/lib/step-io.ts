// ── Per-step, per-round observability record (step_io) ───────────────
//
// A structured record of everything one round of a step consumed and produced —
// its inputs (branch/head/worktree/trigger/config snapshot), the agent
// dispatches it made (prompts + bounded result previews + linkage, and any
// dispatch error), the TRUSTED repo shell commands it ran (test/lint output +
// exit code + duration), and its outputs (timings + outcome flags + any thrown
// error). Written at execution time under `step_io/<runId>/<step>/<round>`, one
// record per 1-based round (the same number `StepRoundRecord.round` uses).
//
// Why a NEW key family and not an array under one key: the SDK storage layer
// hard-caps a value at 1 MB and THROWS past it (storage.ts) — it never silently
// truncates. `step_rounds` accretes an array under one key; step_io deliberately
// keys per round so a long run can never grow one value past the cap. We ALSO
// bound every field ourselves (storage won't truncate for us) with an explicit,
// visible marker, and a final whole-record guard, so a step_io write can NEVER
// throw the 1 MB guard — and a write failure must never fail the run (the
// executor record-and-continues).
//
// PRIVACY (L6, verbatim precedent): the record carries WORK PRODUCT only —
// prompts (built from repo content), shell stdout/stderr, bounded agent RESULT
// PREVIEWS (the same class as findings), and errors. Agent conversation CONTENT
// (transcripts, turn-by-turn) NEVER enters a step_io record; the step-detail
// view deep-links the sub-conversation instead.

import type { RepoConfig } from "./repo-config";

// ── Key family ──────────────────────────────────────────────────────

/** Storage key prefix for the per-round observability records. */
export const STEP_IO_KEY_PREFIX = "step_io/";

/** Key for one round's IO record. Round is the 1-based round number that
 *  `StepRoundRecord.round` also uses (an errored final attempt writes a record
 *  here beyond the completed-round range — the loader lists the prefix rather
 *  than deriving a 1..round range). */
export function stepIOKey(runId: string, step: string, round: number): string {
  return `${STEP_IO_KEY_PREFIX}${runId}/${step}/${round}`;
}

/** List prefix for every round record of one step. */
export function stepIOPrefix(runId: string, step: string): string {
  return `${STEP_IO_KEY_PREFIX}${runId}/${step}/`;
}

// ── Field caps (ours — storage won't truncate for us) ───────────────

/** Prompt text cap. */
export const PROMPT_CAP = 16 * 1024;
/** Shell combined-output cap (mirrors ci.ts MAX_LOG_BYTES). */
export const SHELL_OUTPUT_CAP = 32 * 1024;
/** Agent result-preview / error cap. */
export const RESULT_PREVIEW_CAP = 2 * 1024;
/** Final whole-record guard — well under the 1 MB storage throw. */
export const RECORD_CAP = 256 * 1024;

/** Reserve for the middle-truncation marker (comfortably fits the byte count). */
const MARKER_RESERVE = 48;

/**
 * Middle-truncate `text` to at most `maxBytes` bytes with a visible marker
 * (`…[truncated <N> bytes]`), mirroring the existing ci.ts `trimLog` pattern.
 * Under the cap it returns the input unchanged. The result is byte-bounded by
 * `maxBytes` (the marker is reserved for, not added on top).
 */
export function boundText(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf-8");
  if (buf.length <= maxBytes) return text;
  const keep = Math.max(0, maxBytes - MARKER_RESERVE);
  const removed = buf.length - keep;
  const marker = `…[truncated ${removed} bytes]`;
  const head = Math.floor(keep / 2);
  const tail = keep - head;
  const headStr = buf.subarray(0, head).toString("utf-8");
  const tailStr = tail > 0 ? buf.subarray(buf.length - tail).toString("utf-8") : "";
  return `${headStr}${marker}${tailStr}`;
}

// ── Record shape ────────────────────────────────────────────────────

/** A small, stable snapshot of the resolved trusted repo config (the view shows
 *  which agent/commands the round ran under). NOT the whole RepoConfig — just
 *  the executing-relevant fields, so the record stays tiny. */
export interface StepIORepoConfigSnapshot {
  agent: string;
  allowRepoCommands: boolean;
  disableProjectSettings: boolean;
  commandTest: string;
  commandLint: string;
}

/** Project a resolved RepoConfig to the compact snapshot stored in the record. */
export function snapshotRepoConfig(rc: RepoConfig): StepIORepoConfigSnapshot {
  return {
    agent: rc.agent,
    allowRepoCommands: rc.allowRepoCommands,
    disableProjectSettings: rc.disableProjectSettings,
    commandTest: rc.commands.test,
    commandLint: rc.commands.lint,
  };
}

/** One agent dispatch the round made — prompt + bounded result preview + the
 *  spawn-handle linkage, plus an error string when the dispatch threw. */
export interface StepIODispatch {
  role: string;
  /** Fully-assembled step prompt (bounded to {@link PROMPT_CAP}). */
  promptText: string;
  /** Bounded agent RESULT PREVIEW (work product — NOT transcript content). */
  resultPreview: string;
  assignmentId: string;
  subConversationId: string;
  agentRunId: string;
  at: string;
  /** Present only when the dispatch threw (timeout / failed). */
  error?: string;
}

/** One TRUSTED repo shell command (test/lint) the round ran. Git plumbing is
 *  deliberately excluded (L7) — only `runStepShellCommand` records here. */
export interface StepIOShellCommand {
  command: string;
  exitCode: number;
  /** Combined stdout+stderr (bounded to {@link SHELL_OUTPUT_CAP}). */
  output: string;
  durationMs: number;
}

/** The round's outcome flags (mirrors StepOutcome, all coerced to booleans). */
export interface StepIOOutcomeFlags {
  needsApproval: boolean;
  autoFixable: boolean;
  skipped: boolean;
  skipRemaining: boolean;
  checksPassed: boolean;
}

/** All-false outcome flags — the shape recorded when a round THREW (no outcome). */
export function emptyOutcomeFlags(): StepIOOutcomeFlags {
  return {
    needsApproval: false,
    autoFixable: false,
    skipped: false,
    skipRemaining: false,
    checksPassed: false,
  };
}

/** One round's full observability record. */
export interface StepIORecord {
  runId: string;
  step: string;
  round: number;
  trigger: "initial" | "auto_fix";
  // Inputs
  branch: string;
  headSha: string;
  worktreePath: string;
  repoConfig: StepIORepoConfigSnapshot;
  startedAt: string;
  // Activity
  dispatches: StepIODispatch[];
  shellCommands: StepIOShellCommand[];
  // Outputs
  endedAt: string;
  durationMs: number;
  /** The message when `impl.execute` threw this round, else null. */
  error: string | null;
  outcome: StepIOOutcomeFlags;
}

/** The un-bounded record the executor assembles; {@link buildStepIORecord}
 *  applies the field caps + the final whole-record guard. */
export type RawStepIORecord = StepIORecord;

// ── Bounding ────────────────────────────────────────────────────────

function serializedBytes(record: StepIORecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf-8");
}

/**
 * Apply the final whole-record guard: while the serialized record exceeds `cap`,
 * halve the single largest bounded text field (a shell output, a prompt, a
 * result preview, or a dispatch error) each pass until it fits. The loop is
 * HARD-BOUNDED by a fixed iteration cap (`guard < 200`) — that cap, not a
 * per-pass shrink argument, is the real never-throw guarantee: it always
 * terminates. In practice each pass halves the largest text field, so a record
 * dominated by big blobs collapses well under `cap` within a handful of passes;
 * the only record that can exit still over `cap` is one whose STRUCTURAL JSON
 * alone (many rounds of tiny fields) exceeds it, which is still orders of
 * magnitude below the 1 MB storage guard — so a step_io write never throws it.
 */
export function enforceRecordCap(record: StepIORecord, cap: number = RECORD_CAP): StepIORecord {
  let guard = 0;
  while (serializedBytes(record) > cap && guard < 200) {
    guard += 1;
    let bestBytes = -1;
    let shrink: (() => void) | null = null;
    for (const s of record.shellCommands) {
      const b = Buffer.byteLength(s.output, "utf-8");
      if (b > bestBytes) {
        bestBytes = b;
        shrink = () => {
          s.output = boundText(s.output, Math.max(0, Math.floor(b / 2)));
        };
      }
    }
    for (const d of record.dispatches) {
      const pb = Buffer.byteLength(d.promptText, "utf-8");
      if (pb > bestBytes) {
        bestBytes = pb;
        shrink = () => {
          d.promptText = boundText(d.promptText, Math.max(0, Math.floor(pb / 2)));
        };
      }
      const rb = Buffer.byteLength(d.resultPreview, "utf-8");
      if (rb > bestBytes) {
        bestBytes = rb;
        shrink = () => {
          d.resultPreview = boundText(d.resultPreview, Math.max(0, Math.floor(rb / 2)));
        };
      }
      const eb = d.error !== undefined ? Buffer.byteLength(d.error, "utf-8") : -1;
      if (eb > bestBytes) {
        bestBytes = eb;
        shrink = () => {
          d.error = boundText(d.error ?? "", Math.max(0, Math.floor(eb / 2)));
        };
      }
    }
    if (!shrink || bestBytes <= 0) break; // nothing left to shrink — accept
    shrink();
  }
  return record;
}

/** Assemble the stored record from the raw one: cap every text field, then run
 *  the whole-record guard. Never throws. */
export function buildStepIORecord(raw: RawStepIORecord): StepIORecord {
  const record: StepIORecord = {
    ...raw,
    dispatches: raw.dispatches.map((d) => ({
      ...d,
      promptText: boundText(d.promptText, PROMPT_CAP),
      resultPreview: boundText(d.resultPreview, RESULT_PREVIEW_CAP),
      ...(d.error !== undefined ? { error: boundText(d.error, RESULT_PREVIEW_CAP) } : {}),
    })),
    shellCommands: raw.shellCommands.map((s) => ({
      ...s,
      output: boundText(s.output, SHELL_OUTPUT_CAP),
    })),
  };
  return enforceRecordCap(record);
}

// ── Per-round sink (fed by the recording dispatcher + runStepShellCommand) ──

/** Collects one round's dispatches + shell commands, drained into the record at
 *  round end. One instance per round. */
export interface StepIOSink {
  recordDispatch(dispatch: StepIODispatch): void;
  recordShell(command: StepIOShellCommand): void;
  dispatches(): StepIODispatch[];
  shellCommands(): StepIOShellCommand[];
}

/** A fresh, empty per-round IO sink. */
export function makeStepIOSink(): StepIOSink {
  const ds: StepIODispatch[] = [];
  const ss: StepIOShellCommand[] = [];
  return {
    recordDispatch(dispatch) {
      ds.push(dispatch);
    },
    recordShell(command) {
      ss.push(command);
    },
    dispatches() {
      return ds;
    },
    shellCommands() {
      return ss;
    },
  };
}
