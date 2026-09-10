/**
 * Dependency-free unified-diff parser shared by coverage and gate checks.
 *
 * Keep this module free of product and parser dependencies: coverage runners
 * execute it after setup-bun but before any workspace dependency install.
 */
export type DiffFile = {
  file: string;
  addedLines: Set<number>;
  addedTexts: string[];
  removedTexts: string[];
};

/**
 * Parse `git diff --unified=0` output into per-file added line numbers
 * (new-side), the added text lines, and the removed text lines (old-side).
 *
 * A deleted file has `+++ /dev/null`; retain the preceding old-side path so
 * its removed lines cannot be attributed to the prior file in the diff.
 */
export function parseUnifiedDiff(diff: string): Map<string, DiffFile> {
  const files = new Map<string, DiffFile>();
  let cur: DiffFile | null = null;
  let oldPath: string | null = null;
  let newLine = 0;
  const startFile = (file: string): DiffFile => {
    const entry: DiffFile = { file, addedLines: new Set(), addedTexts: [], removedTexts: [] };
    files.set(file, entry);
    return entry;
  };
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ b/")) {
      cur = startFile(line.slice(6));
    } else if (line === "+++ /dev/null") {
      cur = startFile(oldPath ?? "/dev/null");
    } else if (line.startsWith("@@")) {
      const m = line.match(/\+(\d+)/);
      newLine = m?.[1] ? Number(m[1]) : 0;
    } else if (line.startsWith("--- a/")) {
      oldPath = line.slice(6);
    } else if (line === "--- /dev/null") {
      oldPath = null;
    } else if (cur && line.startsWith("+") && !line.startsWith("+++")) {
      cur.addedLines.add(newLine);
      cur.addedTexts.push(line.slice(1));
      newLine++;
    } else if (cur && line.startsWith("-")) {
      cur.removedTexts.push(line.slice(1));
    } else if (cur && !line.startsWith("\\")) {
      newLine++;
    }
  }
  return files;
}
