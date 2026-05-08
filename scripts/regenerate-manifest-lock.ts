#!/usr/bin/env bun
/**
 * Regenerate `manifest.lock.json` from the current bundled extension
 * manifests. Run by maintainers as part of any PR that legitimately
 * adds, removes, or modifies a bundled extension's tool list, entry
 * point, or version.
 *
 * Phase 5 — see `docs/extensions/security.md` for the full workflow.
 *
 * Walks the same `BUNDLED_EXTENSIONS` array consulted by `bundled.ts`,
 * reads each `ezcorp.config.ts` via `loadManifestFresh`, computes the
 * canonical-JSON SHA-256 of `manifest.tools`, and writes the lockfile
 * at `<repo-root>/manifest.lock.json`.
 *
 * Usage:
 *   bun run scripts/regenerate-manifest-lock.ts            # write
 *   bun run scripts/regenerate-manifest-lock.ts --dry-run  # diff only
 *   bun run scripts/regenerate-manifest-lock.ts --check    # CI gate
 *
 * The script logs an `added / removed / changed` diff against the
 * existing lockfile so the maintainer's PR description can quote it.
 *
 * `--check` is for CI: it computes the lockfile in memory, diffs it
 * against the on-disk file, and exits non-zero (1) if they differ.
 * That ensures every PR that touches an `ezcorp.config.ts` also
 * regenerates the lockfile in the same commit. `--dry-run` is for
 * humans (always exits 0); `--check` is the gate.
 *
 * Exit codes:
 *   0 — wrote (or in dry-run mode) successfully; or `--check` saw no diff
 *   1 — read/hash failure on at least one manifest;
 *       OR `--check` saw a diff (lockfile out of date)
 *   2 — invocation error (bad flag, mutually-exclusive flags, etc.)
 */

import { join } from "node:path";
import { canonicalizeAndHash } from "../src/extensions/bundled-lock";
import { loadManifestFresh } from "../src/extensions/loader";

interface BundledEntry {
  name: string;
  path: string;
}

// Mirror `BUNDLED_EXTENSIONS` from `src/extensions/bundled.ts`. Kept
// in sync by hand because importing `bundled.ts` would also import
// the DB query layer (Drizzle / PGlite) which the script doesn't need.
const BUNDLED: readonly BundledEntry[] = [
  { name: "scratchpad", path: "docs/extensions/examples/scratchpad" },
  { name: "task-tracking", path: "docs/extensions/examples/task-tracking" },
  { name: "orchestration", path: "docs/extensions/examples/orchestration" },
  { name: "ask-user", path: "docs/extensions/examples/ask-user" },
  { name: "project-analyzer", path: "docs/extensions/examples/project-analyzer" },
  { name: "markdown-utils", path: "docs/extensions/examples/markdown-utils" },
  { name: "code-review-delegator", path: "docs/extensions/examples/code-review-delegator" },
  { name: "github-stats", path: "docs/extensions/examples/github-stats" },
  { name: "multi-agent-orchestrator", path: "docs/extensions/examples/multi-agent-orchestrator" },
  { name: "research-agent", path: "docs/extensions/examples/research-agent" },
  { name: "file-refactor", path: "docs/extensions/examples/file-refactor" },
  { name: "log-analyzer", path: "docs/extensions/examples/log-analyzer" },
  { name: "todo-tracker", path: "docs/extensions/examples/todo-tracker" },
  { name: "task-stack", path: "docs/extensions/examples/task-stack" },
  { name: "ai-kit", path: "packages/@ezcorp/ai-kit" },
  { name: "web-search", path: "docs/extensions/examples/web-search" },
  { name: "openai-image-gen-2", path: "docs/extensions/examples/openai-image-gen-2" },
  { name: "property-intelligence-agent", path: "docs/extensions/examples/property-intelligence-agent" },
  { name: "claude-design", path: "docs/extensions/examples/claude-design" },
  { name: "excel", path: "docs/extensions/examples/excel" },
  { name: "kokoro-tts", path: "docs/extensions/examples/kokoro-tts" },
];

interface LockfileEntry {
  version: string;
  entrypoint: string;
  toolsHash: string;
}

interface LockfileShape {
  schemaVersion: 1;
  generatedAt: string;
  extensions: Record<string, LockfileEntry>;
}

/**
 * Pure-function form of the script body so tests can drive it without
 * spawning a subprocess. Reads manifests from `repoRoot`, computes
 * each entry's lockfile shape, and returns the resulting lockfile
 * object alongside the diff vs. the existing on-disk lockfile.
 *
 * Exported for `src/__tests__/manifest-tamper.test.ts`.
 */
export async function buildLockfile(repoRoot: string): Promise<{
  lockfile: LockfileShape;
  errors: Array<{ name: string; error: string }>;
}> {
  const extensions: Record<string, LockfileEntry> = {};
  const errors: Array<{ name: string; error: string }> = [];

  for (const entry of BUNDLED) {
    try {
      const dir = join(repoRoot, entry.path);
      const manifest = await loadManifestFresh(dir);
      extensions[entry.name] = {
        version: manifest.version,
        entrypoint: manifest.entrypoint ?? "",
        toolsHash: canonicalizeAndHash(manifest.tools ?? []),
      };
    } catch (err) {
      errors.push({ name: entry.name, error: String(err) });
    }
  }

  // Sort the `extensions` map keys so the on-disk JSON is stable
  // across runs regardless of `BUNDLED` ordering churn.
  const sorted: Record<string, LockfileEntry> = {};
  for (const k of Object.keys(extensions).sort()) {
    sorted[k] = extensions[k]!;
  }

  return {
    lockfile: {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      extensions: sorted,
    },
    errors,
  };
}

interface Diff {
  added: string[];
  removed: string[];
  changed: Array<{ name: string; field: string; before: string; after: string }>;
}

/**
 * Diff two lockfiles by extension. Field-level changes are reported
 * one row per (name, field) pair so the maintainer sees exactly what
 * shifted in their PR.
 *
 * Exported for `src/__tests__/manifest-tamper.test.ts`.
 */
export function diffLockfiles(
  before: LockfileShape | null,
  after: LockfileShape,
): Diff {
  const out: Diff = { added: [], removed: [], changed: [] };
  const beforeExts = before?.extensions ?? {};
  const afterExts = after.extensions;

  for (const name of Object.keys(afterExts)) {
    if (!(name in beforeExts)) {
      out.added.push(name);
      continue;
    }
    const a = beforeExts[name]!;
    const b = afterExts[name]!;
    for (const field of ["version", "entrypoint", "toolsHash"] as const) {
      if (a[field] !== b[field]) {
        out.changed.push({ name, field, before: a[field], after: b[field] });
      }
    }
  }
  for (const name of Object.keys(beforeExts)) {
    if (!(name in afterExts)) out.removed.push(name);
  }
  return out;
}

function formatDiff(diff: Diff): string {
  const lines: string[] = [];
  if (diff.added.length === 0 && diff.removed.length === 0 && diff.changed.length === 0) {
    lines.push("(no changes)");
    return lines.join("\n");
  }
  for (const name of diff.added) {
    lines.push(`  + ${name}`);
  }
  for (const name of diff.removed) {
    lines.push(`  - ${name}`);
  }
  for (const c of diff.changed) {
    lines.push(`  ~ ${c.name}.${c.field}: ${c.before} -> ${c.after}`);
  }
  return lines.join("\n");
}

/**
 * Pure-function form of `--check` mode for unit testing.
 *
 * Returns:
 *   - `{ exitCode: 0 }` when the on-disk lockfile matches the freshly
 *     computed one (no `added`, `removed`, or `changed` entries).
 *   - `{ exitCode: 1, message }` when there is ANY drift, with a
 *     human-readable diff + remediation hint.
 *
 * Exported for `src/__tests__/regenerate-manifest-lock.test.ts`.
 *
 * `--check` differs from `--dry-run`: dry-run prints the diff and
 * always exits 0 (it's an informational human tool); `--check` prints
 * the diff AND exits 1 on any drift (it's a CI gate).
 */
export function computeCheckDecision(diff: Diff): { exitCode: 0 | 1; message: string } {
  const drifted =
    diff.added.length > 0 || diff.removed.length > 0 || diff.changed.length > 0;
  if (!drifted) {
    return { exitCode: 0, message: "Lockfile is up to date." };
  }
  const remediation =
    "manifest.lock.json is out of date. Run `bun run scripts/regenerate-manifest-lock.ts` and commit the result.";
  return { exitCode: 1, message: `${formatDiff(diff)}\n\n${remediation}` };
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const check = args.includes("--check");

  // `--check` and `--dry-run` are mutually exclusive: dry-run is the
  // human informational mode (always exits 0), --check is the CI
  // gate (exits 1 on drift). Combining them would have ambiguous
  // intent.
  if (check && dryRun) {
    console.error("--check and --dry-run are mutually exclusive");
    console.error("usage: bun run scripts/regenerate-manifest-lock.ts [--dry-run | --check]");
    process.exit(2);
  }

  const KNOWN_FLAGS = new Set(["--dry-run", "--check"]);
  const unknown = args.find((a) => !KNOWN_FLAGS.has(a));
  if (unknown !== undefined) {
    console.error(`unknown flag: ${unknown}`);
    console.error("usage: bun run scripts/regenerate-manifest-lock.ts [--dry-run | --check]");
    process.exit(2);
  }

  // Repo root is the parent directory of `scripts/`. Same logic as
  // `bundled.ts:getProjectRoot` but expressed against import.meta.dir.
  const repoRoot = join(import.meta.dir, "..");
  const lockPath = join(repoRoot, "manifest.lock.json");

  const { lockfile, errors } = await buildLockfile(repoRoot);
  if (errors.length > 0) {
    console.error("regenerate-manifest-lock: failed to load these manifests:");
    for (const { name, error } of errors) {
      console.error(`  - ${name}: ${error}`);
    }
    process.exit(1);
  }

  let existing: LockfileShape | null = null;
  try {
    const file = Bun.file(lockPath);
    if (await file.exists()) {
      existing = JSON.parse(await file.text()) as LockfileShape;
    }
  } catch {
    // Existing lockfile unreadable — fall through to overwrite.
  }

  const diff = diffLockfiles(existing, lockfile);
  console.log(`Lockfile diff vs. ${lockPath}:`);
  console.log(formatDiff(diff));
  console.log(`\n${Object.keys(lockfile.extensions).length} bundled extensions hashed.`);

  if (check) {
    const { exitCode, message } = computeCheckDecision(diff);
    if (exitCode === 0) {
      console.log(message);
      return;
    }
    // Print remediation message to stderr so CI logs separate it
    // from the diff that already went to stdout.
    console.error(`\n${message}`);
    process.exit(exitCode);
  }

  if (dryRun) {
    console.log("[dry-run] not writing manifest.lock.json");
    return;
  }

  // Pretty-print with 2-space indent. The verifier ignores formatting
  // (parses then re-canonicalizes), but a human-readable lockfile makes
  // PR diffs actually reviewable.
  await Bun.write(lockPath, JSON.stringify(lockfile, null, 2) + "\n");
  console.log(`Wrote ${lockPath}`);
}

// Auto-run only when invoked as a script (not when imported by tests).
if (import.meta.main) {
  main().catch((err) => {
    console.error("regenerate-manifest-lock failed:", err);
    process.exit(1);
  });
}
