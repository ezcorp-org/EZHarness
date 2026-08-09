/**
 * `read_files` — the ONLY way untrusted bytes enter an ez-factory
 * pipeline, and therefore the place the prompt-hygiene invariant lives.
 *
 * Every returned `content` goes through `frameUntrusted`
 * (`../sanitize.ts`) with no way around it: the sanitizer is imported
 * directly, not injected, so there is no seam a test could swap and no
 * flag a caller could pass. `grep -rn "frameUntrusted" extensions/ez-factory`
 * finding exactly this one call site is the proof.
 *
 * ── Bounds, and the two different things they do ───────────────────────
 *
 * Nothing here throws because the repository turned out to be big. Every
 * limit that the WORLD can exceed reports itself — an oversized file, an
 * unreadable directory, a budget that ran out — as a `skipped[]` entry or
 * a `truncated` flag, so a pipeline gets a partial answer it can see the
 * shape of rather than a failed step. Only malformed or over-cap INPUT is
 * rejected (invariant E, `./shared.ts`).
 *
 * ── The budget is 200 KB, not 4 MB ─────────────────────────────────────
 *
 * See {@link MAX_TOOL_OUTPUT_BYTES} for why the design doc's 4 MB figure
 * fails, and fails at the worst possible moment. Budgeting is against
 * SERIALIZED bytes, not raw content length, because that is what the host
 * measures: JSON escaping turns one quote into two bytes and one control
 * character into six, so a raw-length budget of 200 KB can serialize past
 * the 256 KB cap on ordinary source files.
 *
 * ── Path convention ────────────────────────────────────────────────────
 *
 * ONE convention, everywhere: paths are relative to the PROJECT ROOT, and
 * globs match that same project-root-relative path. `root` only narrows
 * where the walk starts. So a `files[].path` this tool returns can be fed
 * straight into `write_file` with no rebasing — which matters, because the
 * thing doing the feeding is a workflow ref written by hand.
 */
import { frameUntrusted } from "../sanitize";
import {
  DEFAULT_READ_TOTAL_BYTES,
  MAX_DEPTH,
  MAX_DIRS,
  MAX_FILES,
  MAX_FILE_BYTES,
  MAX_GLOBS,
  MAX_GLOB_LEN,
  MAX_PATH_LEN,
  MAX_TOOL_OUTPUT_BYTES,
  type ToolDeps,
  type ToolOutcome,
  optionalBoundedInt,
  optionalString,
  requireObject,
  requireStringList,
  resolveWithinRoot,
  runTool,
  serializedBytes,
} from "./shared";

export const READ_FILES_TOOL = "read_files";

/**
 * Directory names never descended into.
 *
 * Applied to DESCENDANTS only — an explicit `root` is honoured as given,
 * so a run can still read back its own artifacts under
 * `.ezcorp/extension-data/ez-factory/artifacts/<runId>`.
 *
 * Not cosmetic: without it a single `node_modules` exhausts the 500-
 * directory budget before the walk reaches any source, and `read_files`
 * returns an empty, "successful" result on a perfectly ordinary
 * repository. `.ezcorp` is excluded from descent for the same reason the
 * platform denies it at the PDP — nothing under it is source material.
 */
export const EXCLUDED_DIR_NAMES: ReadonlySet<string> = new Set([".git", "node_modules", ".ezcorp"]);

/** Root-anchored: Docker puts the PGlite datadir at `<root>/data/ezcorp`
 *  and backups at `<root>/data/backups` (EZCORP_DB_PATH=/app/data/ezcorp,
 *  project root /app) — both host-reserved. NOT blanket: a nested
 *  `src/data/` is ordinary source. */
export const EXCLUDED_ROOT_DIR_NAMES: ReadonlySet<string> = new Set(["data"]);

export type SkipReason = "file-too-large" | "budget-exhausted" | "unreadable" | "path-too-long";

export interface ReadFilesEntry {
  /** Project-root-relative. */
  path: string;
  /** Size ON DISK, before sanitizing — so a caller can tell that a small
   *  `content` came from a big file that was flattened, not from a small
   *  file. */
  bytes: number;
  /** Sanitized and wrapped in the untrusted-data markers. */
  content: string;
}

export interface ReadFilesSkip {
  path: string;
  reason: SkipReason;
}

export interface ReadFilesPayload {
  root: string;
  files: ReadFilesEntry[];
  skipped: ReadFilesSkip[];
  /**
   * `files.length` and `skipped.length` as SCALARS.
   *
   * Redundant on purpose, and load-bearing for workflow gates. A
   * condition compares with `deepEq` (`src/runtime/workflow-condition.ts`),
   * so a gate written as `{ref: "…skipped", op: "neq", value: "[]"}`
   * compares an ARRAY against the STRING `"[]"` — never equal, so `neq`
   * is ALWAYS TRUE and the branch always fires. `exists` is no better:
   * `[]` is neither undefined nor null. There is no "non-empty array"
   * operator, so without a scalar there is no correct way to gate on
   * "was anything skipped". Gate on `skippedCount` with `gt`/`eq`.
   */
  fileCount: number;
  skippedCount: number;
  /** Which aggregate bound bit, if any. Fixed-size on purpose: a
   *  variable-length "why" list would itself need a budget. Booleans, so a
   *  gate can use `truthy` directly. */
  truncated: { depth: boolean; dirs: boolean; files: boolean; budget: boolean };
  limits: {
    maxDepth: number;
    maxDirs: number;
    maxFiles: number;
    maxFileBytes: number;
    maxTotalBytes: number;
  };
}

/**
 * Build the tool. `deps.fs` is the only injected surface — see
 * {@link ToolDeps} for why the sanitizer deliberately is not.
 */
export function createReadFiles(deps: ToolDeps) {
  return async function readFiles(input: unknown): Promise<ToolOutcome> {
    return runTool(READ_FILES_TOOL, async () => {
      // ── Input (invariant E: reject, never clamp) ────────────────────
      const args = requireObject(input);
      const projectRoot = deps.projectRoot();
      const rootRel = optionalString(args, "root") ?? ".";
      const absRoot = resolveWithinRoot(projectRoot, rootRel, "root");
      // `globs` takes an array OR a newline-separated string, and
      // `maxFiles` / `maxTotalBytes` take a number OR a numeric string,
      // because a workflow step's `input` mapping values must ALL be
      // strings (`src/runtime/workflow-validator.ts`). Over-cap is still
      // rejected, never clamped.
      const patterns = requireStringList(args, "globs", MAX_GLOBS, MAX_GLOB_LEN);
      const budget =
        optionalBoundedInt(args, "maxTotalBytes", MAX_TOOL_OUTPUT_BYTES) ??
        DEFAULT_READ_TOTAL_BYTES;
      const fileLimit = optionalBoundedInt(args, "maxFiles", MAX_FILES) ?? MAX_FILES;

      // `Bun.Glob(...).match(...)` is pure string matching — it touches no
      // filesystem, which is why it survives the sandbox where
      // `Bun.glob` (the lowercase scanning helper) is poisoned. The walk
      // below supplies the paths; the glob only decides.
      const globs = patterns.map((p) => new Bun.Glob(p));
      const matches = (relPath: string): boolean => globs.some((g) => g.match(relPath));

      const payload: ReadFilesPayload = {
        root: rootRel,
        files: [],
        skipped: [],
        fileCount: 0,
        skippedCount: 0,
        truncated: { depth: false, dirs: false, files: false, budget: false },
        limits: {
          maxDepth: MAX_DEPTH,
          maxDirs: MAX_DIRS,
          maxFiles: fileLimit,
          maxFileBytes: MAX_FILE_BYTES,
          maxTotalBytes: budget,
        },
      };

      // Budget accounting, exact rather than approximately-safe:
      //
      //   · The baseline is the empty payload, measured with every
      //     `truncated` flag FALSE — five bytes, wider than `true`, so
      //     flipping one can only free space.
      //   · An appended element costs its own serialized bytes, plus one
      //     for the separating comma ONLY when the array is already
      //     non-empty, which is what `JSON.stringify` actually emits.
      //
      // The enforcement is `the serialized payload stays within
      // maxTotalBytes across a swept range` in `read-files.test.ts`, a
      // property test over 1400 consecutive budgets. Reasoning about this
      // arithmetic is easy to get wrong in a direction nothing reports:
      // an earlier version charged a comma unconditionally AND padded the
      // baseline for the two counters' digit growth, and the two errors
      // cancelled — so neither could be shown to matter, and the padding
      // turned out to be unreachable defence. Both are gone. If a future
      // change makes the accounting under-count, the sweep goes red.
      let used = serializedBytes(payload);
      const fits = (entry: unknown, into: readonly unknown[]): boolean => {
        const cost = serializedBytes(entry) + (into.length > 0 ? 1 : 0);
        if (used + cost > budget) return false;
        used += cost;
        return true;
      };
      const addSkip = (path: string, reason: SkipReason): void => {
        const entry: ReadFilesSkip = { path, reason };
        if (fits(entry, payload.skipped)) payload.skipped.push(entry);
        else payload.truncated.budget = true;
      };

      // ── Walk ────────────────────────────────────────────────────────
      // Breadth-first over an explicit queue: the directory counter is
      // then plainly the number of `list` calls made, and there is no
      // recursion whose depth could outrun the depth bound.
      const relRoot = rootRel === "." ? "" : rootRel.replace(/\/+$/, "");
      /** A path in both conventions at once: `rel` is what the globs match
       *  and what the result reports; `abs` is what the host's fs wants.
       *  Carrying both means neither is ever re-derived — and `abs`
       *  descends from the VALIDATED `absRoot`, so containment is
       *  established once rather than per entry. */
      interface Located {
        rel: string;
        abs: string;
      }
      const candidates: Located[] = [];
      const queue: Array<Located & { depth: number }> = [{ rel: relRoot, abs: absRoot, depth: 0 }];
      let dirsVisited = 0;

      walk: while (queue.length > 0) {
        if (dirsVisited >= MAX_DIRS) {
          payload.truncated.dirs = true;
          break;
        }
        const current = queue.shift() as Located & { depth: number };
        dirsVisited += 1;

        let entries: Array<{ name: string; isFile: boolean; isDirectory: boolean }>;
        try {
          entries = await deps.fs.list(current.abs);
        } catch {
          // A directory the host denies, or one that vanished mid-walk.
          // Reported, not thrown — the rest of the tree is still useful.
          addSkip(current.rel === "" ? "." : current.rel, "unreadable");
          continue;
        }

        // Sorted so the same tree always produces the same result, which
        // is what makes "the budget ran out here" reproducible.
        for (const entry of [...entries].sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
        )) {
          const rel = current.rel === "" ? entry.name : `${current.rel}/${entry.name}`;
          const abs = `${current.abs}/${entry.name}`;
          if (entry.isDirectory) {
            if (EXCLUDED_DIR_NAMES.has(entry.name)) continue;
            if (current.rel === "" && EXCLUDED_ROOT_DIR_NAMES.has(entry.name)) continue;
            if (current.depth + 1 > MAX_DEPTH) {
              payload.truncated.depth = true;
              continue;
            }
            queue.push({ rel, abs, depth: current.depth + 1 });
            continue;
          }
          if (!entry.isFile) continue;
          if (rel.length > MAX_PATH_LEN) {
            addSkip(rel.slice(0, MAX_PATH_LEN), "path-too-long");
            continue;
          }
          if (!matches(rel)) continue;
          if (candidates.length >= fileLimit) {
            payload.truncated.files = true;
            break walk;
          }
          candidates.push({ rel, abs });
        }
      }

      // ── Read, sanitize, budget ──────────────────────────────────────
      for (const { rel, abs } of candidates) {
        let size: number;
        let raw: string;
        try {
          size = (await deps.fs.stat(abs)).size;
          if (size > MAX_FILE_BYTES) {
            addSkip(rel, "file-too-large");
            continue;
          }
          raw = await deps.fs.read(abs);
        } catch {
          addSkip(rel, "unreadable");
          continue;
        }

        // THE chokepoint. Not injected, not conditional, not skippable.
        const entry: ReadFilesEntry = { path: rel, bytes: size, content: frameUntrusted(raw) };
        if (!fits(entry, payload.files)) {
          payload.truncated.budget = true;
          addSkip(rel, "budget-exhausted");
          continue;
        }
        payload.files.push(entry);
      }

      // Set LAST, from the arrays themselves, so the scalars a gate reads
      // can never disagree with the lists a later step reads.
      payload.fileCount = payload.files.length;
      payload.skippedCount = payload.skipped.length;

      return payload as unknown as Record<string, unknown>;
    });
  };
}
