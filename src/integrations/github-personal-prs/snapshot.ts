import { createHash } from "node:crypto";

export const SNAPSHOT_LIMITS = Object.freeze({ files: 2_000, fileBytes: 256 * 1024, totalBytes: 32 * 1024 * 1024, pathBytes: 1_024, transferChunkBytes: 256 * 1024, bundleBytes: 48 * 1024 * 1024 });

export interface SnapshotFileInput { path: string; mode: "100644" | "100755"; data: string; sha256: string }
export interface SnapshotFile { path: string; mode: "100644" | "100755"; bytes: Uint8Array; sha256: string }
export interface ValidatedSnapshot { files: SnapshotFile[]; digest: string; totalBytes: number }

export class SnapshotValidationError extends Error {
  constructor(public readonly code: "invalid_path" | "duplicate_path" | "invalid_content" | "limit_exceeded", message: string) {
    super(message);
    this.name = "SnapshotValidationError";
  }
}

function filePath(path: unknown): string {
  if (typeof path !== "string" || !path || Buffer.byteLength(path, "utf8") > SNAPSHOT_LIMITS.pathBytes || path.normalize("NFC") !== path || path.startsWith("/") || path.includes("\\") || path.includes("\0")) throw new SnapshotValidationError("invalid_path", "Snapshot has an invalid path");
  const parts = path.split("/");
  if (parts.some(part => !part || part === "." || part === ".." || part.toLowerCase() === ".git" || part.toLowerCase() === ".ezcorp" || [...part].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127))) throw new SnapshotValidationError("invalid_path", "Snapshot has an unsafe path");
  return path;
}

function decoded(input: unknown): Uint8Array {
  if (typeof input !== "string" || input.length > Math.ceil(SNAPSHOT_LIMITS.fileBytes / 3) * 4 + 4 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(input)) throw new SnapshotValidationError("invalid_content", "Snapshot content is not canonical base64");
  const bytes = Buffer.from(input, "base64");
  if (bytes.length > SNAPSHOT_LIMITS.fileBytes || bytes.toString("base64") !== input) throw new SnapshotValidationError("invalid_content", "Snapshot content is invalid or too large");
  return bytes;
}

export function validateSnapshot(input: readonly SnapshotFileInput[]): ValidatedSnapshot {
  if (!Array.isArray(input) || input.length > SNAPSHOT_LIMITS.files) throw new SnapshotValidationError("limit_exceeded", "Snapshot has too many files");
  const seen = new Set<string>();
  const files: SnapshotFile[] = [];
  let totalBytes = 0;
  for (const entry of input) {
    if (!entry || typeof entry !== "object") throw new SnapshotValidationError("invalid_content", "Snapshot entry is invalid");
    if (Object.keys(entry).some(key => !["path", "mode", "data", "sha256"].includes(key))) throw new SnapshotValidationError("invalid_content", "Snapshot has unexpected metadata");
    const path = filePath(entry.path);
    const folded = path.toLowerCase();
    if (seen.has(folded)) throw new SnapshotValidationError("duplicate_path", "Snapshot has colliding paths");
    seen.add(folded);
    if (entry.mode !== "100644" && entry.mode !== "100755") throw new SnapshotValidationError("invalid_content", "Snapshot mode is unsupported");
    const bytes = decoded(entry.data);
    totalBytes += bytes.length;
    if (totalBytes > SNAPSHOT_LIMITS.totalBytes) throw new SnapshotValidationError("limit_exceeded", "Snapshot is too large");
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (entry.sha256 !== sha256) throw new SnapshotValidationError("invalid_content", "Snapshot bytes do not match the manifest");
    files.push({ path, mode: entry.mode, bytes, sha256 });
  }
  files.sort((a, b) => Buffer.compare(Buffer.from(a.path), Buffer.from(b.path)));
  for (const file of files) {
    const parts = file.path.toLowerCase().split("/");
    for (let index = 1; index < parts.length; index++) if (seen.has(parts.slice(0, index).join("/"))) throw new SnapshotValidationError("duplicate_path", "Snapshot file is also a directory");
  }
  const hash = createHash("sha256");
  for (const file of files) {
    hash.update(file.path); hash.update("\0"); hash.update(file.mode); hash.update("\0"); hash.update(String(file.bytes.length)); hash.update("\0"); hash.update(file.sha256); hash.update("\n");
  }
  return { files, digest: hash.digest("hex"), totalBytes };
}
