/**
 * Review model for the GitHub-style "Files changed" panel.
 *
 * The chat diff panel has two upstream sources that historically rendered as
 * two visually different lists ("File Changes" from tool calls, "Code Diffs"
 * from fenced ```diff blocks in assistant messages). GitHub's review tab has
 * exactly ONE list — a file is a file — so this module normalises both sources
 * into a single `ReviewFile[]` and derives everything the UI shows from it:
 * per-file +/- counts, the change status, the 5-block diffstat, the header
 * totals, the filter, and the collapsible file tree.
 *
 * Everything here is pure (no DOM, no storage) so the whole model is unit
 * testable; the Svelte components below it only bind and paint.
 */

import type { ExtractedDiff, ToolCallDiffGroup } from "../diff-aggregator";

/** How a file changed, mirroring GitHub's file-header vocabulary. */
export type ReviewFileStatus = "added" | "removed" | "modified";

/** Which upstream source a file's diff came from. */
export type ReviewFileSource = "tool" | "message";

export interface ReviewFile {
  /** Stable identity for expand / viewed state (`tool:src/a.ts`). */
  key: string;
  /** Full display path (`src/lib/auth.ts`). */
  path: string;
  /** Directory portion, `""` when the file sits at the root. */
  dirname: string;
  /** File name portion. */
  basename: string;
  status: ReviewFileStatus;
  additions: number;
  deletions: number;
  /** The unified diff text handed to diff2html. */
  diffText: string;
  source: ReviewFileSource;
}

/** Header totals across every file in the review. */
export interface ReviewTotals {
  files: number;
  additions: number;
  deletions: number;
}

/** One cell of GitHub's five-square diffstat bar. */
export type DiffStatBlock = "added" | "deleted" | "neutral";

/**
 * A node in the left-hand file tree: either a directory or a file leaf.
 *
 * `key` — NOT `path` — is the identity the `{#each}` keys on. One conversation
 * can touch the same file twice (an early message's diff and a later one), so
 * two leaves can legitimately share a path; keying on path would raise
 * Svelte's `each_key_duplicate` and take the whole panel down with it.
 */
export type FileTreeNode =
  | { type: "dir"; key: string; name: string; path: string; children: FileTreeNode[] }
  | { type: "file"; key: string; name: string; path: string; file: ReviewFile };

/** Placeholder path for a fenced diff block that names no file. */
export const UNNAMED_DIFF_PATH = "unnamed diff";

/**
 * Changed-line count above which a file opens COLLAPSED, mirroring GitHub's
 * "Large diffs are not rendered by default".
 *
 * This is a rendering budget as much as a UI choice: every open card parses
 * its diff through diff2html and then walks each line through highlight.js, so
 * a conversation that rewrote a lock file would otherwise block the panel's
 * first paint on tens of thousands of lines.
 */
export const LARGE_DIFF_LINES = 500;

/** True when a file is big enough to open collapsed. */
export function isLargeDiff(file: ReviewFile): boolean {
  return file.additions + file.deletions > LARGE_DIFF_LINES;
}

/**
 * Count added / removed lines in a unified diff.
 *
 * `+++` / `---` are file headers, not content, so they are skipped — the same
 * rule `git diff --stat` uses.
 */
export function countDiffStats(diffText: string): { additions: number; deletions: number } {
  let additions = 0;
  let deletions = 0;
  for (const line of diffText.split("\n")) {
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+")) additions++;
    else if (line.startsWith("-")) deletions++;
  }
  return { additions, deletions };
}

/**
 * Classify a file from its counts. A diff that only adds is a new file, one
 * that only removes is a deletion; anything else (including an empty diff) is
 * a modification.
 */
export function deriveStatus(additions: number, deletions: number): ReviewFileStatus {
  if (additions > 0 && deletions === 0) return "added";
  if (deletions > 0 && additions === 0) return "removed";
  return "modified";
}

/** Split a path into its directory and file-name halves. */
export function splitPath(path: string): { dirname: string; basename: string } {
  const idx = path.lastIndexOf("/");
  if (idx === -1) return { dirname: "", basename: path };
  return { dirname: path.slice(0, idx), basename: path.slice(idx + 1) };
}

function makeFile(
  key: string,
  path: string,
  diffText: string,
  source: ReviewFileSource,
): ReviewFile {
  const { additions, deletions } = countDiffStats(diffText);
  const { dirname, basename } = splitPath(path);
  return {
    key,
    path,
    dirname,
    basename,
    status: deriveStatus(additions, deletions),
    additions,
    deletions,
    diffText,
    source,
  };
}

/**
 * Normalise both diff sources into one ordered file list.
 *
 * Tool-call groups come first (they are the agent's actual edits); fenced
 * message diffs follow. A tool group holding several edits to the same file is
 * concatenated into one diff so the file renders as a single GitHub file card.
 */
export function buildReviewFiles(
  toolGroups: ToolCallDiffGroup[],
  codeDiffs: ExtractedDiff[],
): ReviewFile[] {
  const files: ReviewFile[] = [];

  for (const group of toolGroups) {
    files.push(makeFile(`tool:${group.filePath}`, group.filePath, group.diffs.join("\n"), "tool"));
  }

  // Keyed by owning message + position WITHIN that message, never by the
  // flat index: a new diff arriving in an earlier message must not shift an
  // already-ticked file's identity onto its neighbour.
  const perMessage = new Map<string, number>();
  for (const diff of codeDiffs) {
    const nth = perMessage.get(diff.messageId) ?? 0;
    perMessage.set(diff.messageId, nth + 1);
    files.push(
      makeFile(
        `code:${diff.messageId}#${nth}`,
        diff.fileName ?? UNNAMED_DIFF_PATH,
        diff.content,
        "message",
      ),
    );
  }

  return files;
}

/** Sum the per-file counts for the panel header. */
export function totalStats(files: ReviewFile[]): ReviewTotals {
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    additions += f.additions;
    deletions += f.deletions;
  }
  return { files: files.length, additions, deletions };
}

/**
 * Case-insensitive substring filter over the file path — GitHub's "Filter
 * changed files" box. A blank / whitespace-only query matches everything.
 */
export function filterReviewFiles(files: ReviewFile[], query: string): ReviewFile[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return files;
  return files.filter((f) => f.path.toLowerCase().includes(needle));
}

/**
 * GitHub's five-square diffstat.
 *
 * Small changes (five lines or fewer) map ONE square per changed line and
 * leave the rest grey — that's why a one-line tweak on GitHub shows a single
 * green square, not a full green bar. Anything larger is scaled to fill all
 * five squares in proportion. A file with no counted lines is all grey.
 */
export function diffStatBlocks(additions: number, deletions: number): DiffStatBlock[] {
  const total = additions + deletions;
  if (total === 0) return Array<DiffStatBlock>(5).fill("neutral");

  const green = total > 5 ? Math.round((additions / total) * 5) : additions;
  const red = total > 5 ? 5 - green : deletions;

  return [
    ...Array<DiffStatBlock>(green).fill("added"),
    ...Array<DiffStatBlock>(red).fill("deleted"),
    ...Array<DiffStatBlock>(5 - green - red).fill("neutral"),
  ];
}

/**
 * Build the collapsible directory tree the left sidebar renders.
 *
 * Directories are emitted before files at each level (GitHub's ordering) and
 * both groups keep the incoming file order, so the tree and the diff list
 * always scroll in the same sequence.
 */
export function buildFileTree(files: ReviewFile[]): FileTreeNode[] {
  const root: FileTreeNode[] = [];
  const dirs = new Map<string, FileTreeNode & { type: "dir" }>();

  function dirNode(path: string): FileTreeNode & { type: "dir" } {
    const existing = dirs.get(path);
    if (existing) return existing;

    const { dirname, basename } = splitPath(path);
    const node = { type: "dir" as const, key: `dir:${path}`, name: basename, path, children: [] };
    dirs.set(path, node);
    (dirname ? dirNode(dirname).children : root).push(node);
    return node;
  }

  for (const file of files) {
    const leaf: FileTreeNode = {
      type: "file",
      key: `file:${file.key}`,
      name: file.basename,
      path: file.path,
      file,
    };
    (file.dirname ? dirNode(file.dirname).children : root).push(leaf);
  }

  return root;
}

/**
 * Immutably flip one member of a set.
 *
 * The panel keeps three of these (collapsed files, collapsed directories,
 * viewed files) and Svelte only re-renders on a NEW `Set` identity, so every
 * toggle goes through here rather than mutating in place.
 */
export function toggleInSet(set: ReadonlySet<string>, key: string): Set<string> {
  const next = new Set(set);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  return next;
}

/** Every directory path in the tree — the sidebar's default-expanded set. */
export function allDirPaths(nodes: FileTreeNode[]): string[] {
  const out: string[] = [];
  for (const node of nodes) {
    if (node.type !== "dir") continue;
    out.push(node.path);
    out.push(...allDirPaths(node.children));
  }
  return out;
}
