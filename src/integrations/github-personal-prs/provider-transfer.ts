import { createHash, randomUUID } from "node:crypto";
import type { SandboxController, SandboxMethodGroup, SandboxOperationResult } from "../../runtime/sandbox/controller/types";
import { validateSnapshot, type SnapshotFileInput, type ValidatedSnapshot } from "./snapshot";

const READ_CHUNK = 256 * 1024;
const MAX_EXPORT = 48 * 1024 * 1024;

export class WorkspaceTransferError extends Error {
  constructor(public readonly code: "provider_failed" | "tampered_snapshot" | "unsupported_workspace", message: string) {
    super(message);
    this.name = "WorkspaceTransferError";
  }
}

type Bridge = Pick<SandboxController, "admitSandboxMethod" | "executeAdmittedSandboxMethod">;

async function method(bridge: Bridge, userId: string, projectId: string, conversationId: string | undefined, group: SandboxMethodGroup, operation: string, payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const admitted = await bridge.admitSandboxMethod(userId, projectId, { group, operation, payload, idempotencyKey: randomUUID(), ...(conversationId ? { conversationId } : {}) });
  const completed: SandboxOperationResult = await bridge.executeAdmittedSandboxMethod(userId, admitted.id);
  const result = completed.result as Record<string, unknown> | undefined;
  const receipt = result?.receipt as { outcome?: string } | undefined;
  if (receipt?.outcome !== "succeeded") throw new WorkspaceTransferError("provider_failed", "Sandbox transfer did not complete");
  return result!;
}

/** Called only inside runPrivateWorkspaceImport for a newly created private resource. */
export async function importSnapshotToSandbox(bridge: Bridge, userId: string, projectId: string, snapshot: ValidatedSnapshot): Promise<void> {
  const root = await method(bridge, userId, projectId, undefined, "sandbox.files.v1", "list", { path: "/", limit: 1 });
  if (!Array.isArray(root.entries) || root.entries.length !== 0) throw new WorkspaceTransferError("unsupported_workspace", "Private sandbox is not empty");
  const directories = new Set<string>();
  for (const file of snapshot.files) {
    const parts = file.path.split("/");
    parts.pop();
    let directory = "";
    for (const part of parts) { directory += `/${part}`; directories.add(directory); }
  }
  for (const path of [...directories].sort((a, b) => a.length - b.length || a.localeCompare(b))) await method(bridge, userId, projectId, undefined, "sandbox.files.v1", "mkdir", { path, recursive: false });
  for (const file of snapshot.files) {
    if (file.bytes.length > READ_CHUNK) throw new WorkspaceTransferError("unsupported_workspace", "Repository file exceeds sandbox import limit");
    const path = `/${file.path}`;
    await method(bridge, userId, projectId, undefined, "sandbox.files.v1", "write", { path, encoding: "base64", data: Buffer.from(file.bytes).toString("base64") });
    await method(bridge, userId, projectId, undefined, "sandbox.files.v1", "chmod", { path, mode: file.mode === "100755" ? 0o755 : 0o644 });
    const observed = await method(bridge, userId, projectId, undefined, "sandbox.files.v1", "stat", { path });
    const stat = observed.entry as { kind?: string; sizeBytes?: number; mode?: number } | undefined;
    if (stat?.kind !== "file" || stat.sizeBytes !== file.bytes.length || (stat.mode! & 0o111 ? "100755" : "100644") !== file.mode) throw new WorkspaceTransferError("tampered_snapshot", "Imported file metadata changed");
    if (file.bytes.length) {
      const read = await method(bridge, userId, projectId, undefined, "sandbox.files.v1", "read", { path, offsetBytes: 0, lengthBytes: file.bytes.length });
      const bytes = Buffer.from(String(read.data), read.encoding === "base64" ? "base64" : "utf8");
      if (!bytes.equals(file.bytes) || read.eof !== true) throw new WorkspaceTransferError("tampered_snapshot", "Imported file bytes changed");
    }
  }
}

/** Controller admission takes the writer lease while beginExport copies the stopped tree. */
export async function exportSnapshotFromSandbox(bridge: Bridge, userId: string, projectId: string, conversationId: string): Promise<ValidatedSnapshot> {
  const begun = await method(bridge, userId, projectId, conversationId, "sandbox.transfer.v1", "beginExport", {});
  const snapshotId = String(begun.snapshotId);
  const byteLength = Number(begun.byteLength);
  if (!Number.isSafeInteger(byteLength) || byteLength < 2 || byteLength > MAX_EXPORT || typeof begun.sha256 !== "string") throw new WorkspaceTransferError("tampered_snapshot", "Invalid frozen snapshot receipt");
  const chunks: Uint8Array[] = [];
  let offset = 0;
  try {
    while (offset < byteLength) {
      const read = await method(bridge, userId, projectId, conversationId, "sandbox.transfer.v1", "readExport", { snapshotId, offsetBytes: offset, lengthBytes: Math.min(READ_CHUNK, byteLength - offset) });
      const bytes = Buffer.from(String(read.data), "base64");
      if (bytes.length === 0 || Number(read.offsetBytes) !== offset || Number(read.nextOffsetBytes) !== offset + bytes.length || offset + bytes.length > byteLength || Boolean(read.eof) !== (offset + bytes.length === byteLength)) throw new WorkspaceTransferError("tampered_snapshot", "Frozen snapshot chunk changed");
      chunks.push(bytes);
      offset += bytes.length;
    }
    const bundle = Buffer.concat(chunks);
    if (createHash("sha256").update(bundle).digest("hex") !== begun.sha256) throw new WorkspaceTransferError("tampered_snapshot", "Frozen snapshot digest changed");
    let input: unknown;
    try { input = JSON.parse(bundle.toString("utf8")); }
    catch { throw new WorkspaceTransferError("tampered_snapshot", "Frozen snapshot is invalid"); }
    try { return validateSnapshot(input as SnapshotFileInput[]); }
    catch { throw new WorkspaceTransferError("tampered_snapshot", "Frozen snapshot content is unsafe"); }
  } finally {
    await method(bridge, userId, projectId, conversationId, "sandbox.transfer.v1", "endExport", { snapshotId }).catch(() => undefined);
  }
}
