import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir, type FileHandle } from "node:fs/promises";
import { validateSnapshot, SNAPSHOT_LIMITS, type SnapshotFileInput } from "../../../integrations/github-personal-prs/snapshot";

const CHUNK = 256 * 1024;
const MAX_BUNDLE = 48 * 1024 * 1024;
const MAX_SNAPSHOTS = 3;
const TTL_MS = 10 * 60_000;

interface FrozenExport { scope: string; resourceId: string; bytes: Uint8Array; createdAt: number }
export interface FrozenExportReceipt { snapshotId: string; byteLength: number; sha256: string }

function unsafe(message: string): never { throw new Error(message); }

async function regularFile(parent: FileHandle, name: string, device: bigint, budget: { bytes: number }): Promise<Uint8Array> {
  const handle = await open(`/proc/self/fd/${parent.fd}/${name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.dev !== device || before.size > BigInt(SNAPSHOT_LIMITS.fileBytes) || before.size > BigInt(SNAPSHOT_LIMITS.totalBytes - budget.bytes)) unsafe("Unsupported snapshot file");
    const bounded = Buffer.alloc(Number(before.size) + 1);
    let length = 0;
    while (length < bounded.length) {
      const { bytesRead } = await handle.read(bounded, length, bounded.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length !== Number(before.size)) unsafe("Snapshot file changed during export");
    const bytes = bounded.subarray(0, length);
    const after = await handle.stat({ bigint: true });
    if (bytes.length !== Number(before.size) || before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs) unsafe("Snapshot file changed during export");
    budget.bytes += bytes.length;
    return bytes;
  } finally { await handle.close(); }
}

async function collect(directory: FileHandle, device: bigint, prefix: string, output: SnapshotFileInput[], budget: { entries: number; bytes: number }): Promise<void> {
  const entries = await opendir(`/proc/self/fd/${directory.fd}`);
  try {
    for await (const entry of entries) {
      if (++budget.entries > SNAPSHOT_LIMITS.files * 2) unsafe("Snapshot has too many entries");
      if (!entry.name || entry.name.normalize("NFC") !== entry.name || entry.name === "." || entry.name === ".." || [".git", ".ezcorp"].includes(entry.name.toLowerCase()) || entry.name.includes("\\") || [...entry.name].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) unsafe("Snapshot contains an unsafe path");
      const path = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (output.length >= SNAPSHOT_LIMITS.files) unsafe("Snapshot has too many files");
      if (entry.isDirectory()) {
        const child = await open(`/proc/self/fd/${directory.fd}/${entry.name}`, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const stat = await child.stat({ bigint: true });
          if (!stat.isDirectory() || stat.dev !== device) unsafe("Unsupported snapshot directory");
          await collect(child, device, path, output, budget);
        } finally { await child.close(); }
      } else if (entry.isFile()) {
        const bytes = await regularFile(directory, entry.name, device, budget);
        const statHandle = await open(`/proc/self/fd/${directory.fd}/${entry.name}`, constants.O_RDONLY | constants.O_NOFOLLOW);
        let mode: "100644" | "100755";
        try { const stat = await statHandle.stat(); mode = stat.mode & 0o111 ? "100755" : "100644"; }
        finally { await statHandle.close(); }
        output.push({ path, mode, data: Buffer.from(bytes).toString("base64"), sha256: createHash("sha256").update(bytes).digest("hex") });
      } else unsafe("Snapshot contains a link or special file");
    }
  } finally { try { await entries.close(); } catch { /* for-await may close it first */ } }
}

/** The caller holds the binding's writer lease and has proved the container stopped. */
export class FrozenWorkspaceExports {
  private readonly snapshots = new Map<string, FrozenExport>();
  private pending = 0;

  async begin(root: string, scope: string, resourceId: string): Promise<FrozenExportReceipt> {
    this.prune();
    if (this.snapshots.size + this.pending >= MAX_SNAPSHOTS) unsafe("Too many retained workspace exports");
    this.pending++;
    try {
      const handle = await open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      let files: SnapshotFileInput[] = [];
      try {
        const stat = await handle.stat({ bigint: true });
        await collect(handle, stat.dev, "", files, { entries: 0, bytes: 0 });
      } finally { await handle.close(); }
      const validated = validateSnapshot(files);
      files = validated.files.map(file => ({ path: file.path, mode: file.mode, data: Buffer.from(file.bytes).toString("base64"), sha256: file.sha256 }));
      const bytes = Buffer.from(JSON.stringify(files));
      if (bytes.length > MAX_BUNDLE) unsafe("Serialized snapshot is too large");
      const snapshotId = randomUUID();
      this.snapshots.set(snapshotId, { scope, resourceId, bytes, createdAt: Date.now() });
      return { snapshotId, byteLength: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
    } finally { this.pending--; }
  }

  read(scope: string, resourceId: string, snapshotId: string, offsetBytes: number, lengthBytes: number): { snapshotId: string; offsetBytes: number; nextOffsetBytes: number; eof: boolean; data: string } {
    this.prune();
    const value = this.snapshots.get(snapshotId);
    if (!value || value.scope !== scope || value.resourceId !== resourceId) unsafe("Snapshot is unavailable");
    if (!Number.isSafeInteger(offsetBytes) || offsetBytes < 0 || offsetBytes > value.bytes.length || !Number.isSafeInteger(lengthBytes) || lengthBytes < 1 || lengthBytes > CHUNK) unsafe("Invalid snapshot range");
    const nextOffsetBytes = Math.min(value.bytes.length, offsetBytes + lengthBytes);
    return { snapshotId, offsetBytes, nextOffsetBytes, eof: nextOffsetBytes === value.bytes.length, data: Buffer.from(value.bytes.subarray(offsetBytes, nextOffsetBytes)).toString("base64") };
  }

  end(scope: string, resourceId: string, snapshotId: string): void {
    const value = this.snapshots.get(snapshotId);
    if (value && value.scope === scope && value.resourceId === resourceId) this.snapshots.delete(snapshotId);
  }

  private prune(): void {
    const cutoff = Date.now() - TTL_MS;
    for (const [id, value] of this.snapshots) if (value.createdAt < cutoff) this.snapshots.delete(id);
  }
}
