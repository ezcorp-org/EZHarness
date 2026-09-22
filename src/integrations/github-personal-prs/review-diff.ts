import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ValidatedSnapshot } from "./snapshot";

const MAX_FILES = 100;
const MAX_PATCH_FILE = 128 * 1024;
const MAX_PATCH_TOTAL = 512 * 1024;
const MAX_BINARY = 64 * 1024;

export interface ReviewFile {
  path: string;
  status: "added" | "modified" | "deleted";
  additions: number;
  deletions: number;
  patch: string;
  binary: boolean;
  beforeSha256?: string;
  afterSha256?: string;
  beforeBytes: number;
  afterBytes: number;
  beforeBase64?: string;
  afterBase64?: string;
}

export class ReviewDiffError extends Error {
  constructor(public readonly code: "unsupported_changes" | "diff_failed", message: string) {
    super(message);
    this.name = "ReviewDiffError";
  }
}

function text(bytes: Uint8Array): string | null {
  try { const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes); return value.includes("\0") ? null : value; }
  catch { return null; }
}

function lineCount(value: string): number { return value ? value.split("\n").length - (value.endsWith("\n") ? 1 : 0) : 0; }

async function patch(before: Uint8Array, after: Uint8Array, path: string, root: string): Promise<string> {
  const oldPath = join(root, "before"); const newPath = join(root, "after");
  await writeFile(oldPath, before); await writeFile(newPath, after);
  const child = Bun.spawn(["diff", "-u", "--label", `a/${path}`, "--label", `b/${path}`, oldPath, newPath], { env: { PATH: process.env.PATH ?? "", LANG: "C" }, stdout: "pipe", stderr: "pipe" });
  const output: Uint8Array[] = [];
  let size = 0;
  const reader = child.stdout.getReader();
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.length;
      if (size > MAX_PATCH_FILE) { child.kill(); throw new ReviewDiffError("unsupported_changes", "Review diff exceeds the file limit"); }
      output.push(part.value);
    }
  } finally { reader.releaseLock(); }
  const code = await child.exited;
  if (code !== 0 && code !== 1) throw new ReviewDiffError("diff_failed", "Could not prepare the frozen file diff");
  return Buffer.concat(output).toString("utf8");
}

/** Exact immutable base vs. artifact review. Excess data blocks confirmation. */
export async function buildReviewDiff(base: ValidatedSnapshot, current: ValidatedSnapshot): Promise<ReviewFile[]> {
  const old = new Map(base.files.map(file => [file.path, file]));
  const next = new Map(current.files.map(file => [file.path, file]));
  const changed = [...new Set([...old.keys(), ...next.keys()])].sort().filter(path => old.get(path)?.sha256 !== next.get(path)?.sha256 || old.get(path)?.mode !== next.get(path)?.mode);
  if (changed.length > MAX_FILES) throw new ReviewDiffError("unsupported_changes", "Too many changed files to review");
  const root = await mkdtemp(join(tmpdir(), "ez-pr-diff-"));
  const result: ReviewFile[] = [];
  let totalPatch = 0;
  try {
    for (const path of changed) {
      const before = old.get(path); const after = next.get(path);
      const beforeBytes = before?.bytes ?? new Uint8Array(); const afterBytes = after?.bytes ?? new Uint8Array();
      const beforeText = text(beforeBytes); const afterText = text(afterBytes);
      const binary = beforeText === null || afterText === null;
      if (binary && beforeBytes.length + afterBytes.length > MAX_BINARY) throw new ReviewDiffError("unsupported_changes", "Binary file exceeds the review limit");
      const rendered = binary ? "" : await patch(beforeBytes, afterBytes, path, root);
      totalPatch += Buffer.byteLength(rendered);
      if (totalPatch > MAX_PATCH_TOTAL) throw new ReviewDiffError("unsupported_changes", "Review diff exceeds the total limit");
      const modeNote = before?.mode !== after?.mode ? `Mode: ${before?.mode ?? "none"} → ${after?.mode ?? "none"}\n` : "";
      result.push({
        path, status: !before ? "added" : !after ? "deleted" : "modified",
        additions: afterText === null ? 0 : lineCount(afterText), deletions: beforeText === null ? 0 : lineCount(beforeText),
        patch: modeNote + rendered, binary, beforeBytes: beforeBytes.length, afterBytes: afterBytes.length,
        ...(before ? { beforeSha256: before.sha256 } : {}), ...(after ? { afterSha256: after.sha256 } : {}),
        ...(binary && before ? { beforeBase64: Buffer.from(beforeBytes).toString("base64") } : {}),
        ...(binary && after ? { afterBase64: Buffer.from(afterBytes).toString("base64") } : {}),
      });
    }
    return result;
  } finally { await rm(root, { recursive: true, force: true }); }
}
