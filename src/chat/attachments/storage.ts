/**
 * Attachment on-disk storage under <projectRoot>/.ezcorp/attachments/.
 *
 * Layout: .ezcorp/attachments/<conversationId>/<messageId>/<uuid>.<ext>
 * This mirrors the extension-data convention documented in AGENTS.md.
 */

import { resolve, join, extname, sep } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import {
  sandboxCapabilityUnavailable,
  type WorkspaceTarget,
} from "../../runtime/workspaces/target";

interface WrittenAttachment {
  storagePath: string;
  sizeBytes: number;
}

/** Root directory for all message attachments. */
export function attachmentsRoot(projectRoot: string): string {
  return resolve(projectRoot, ".ezcorp", "attachments");
}

function sanitizeSegment(s: string): string {
  // Defensive — ids are UUIDs/DB-generated, but never allow path traversal.
  return s.replace(/[^a-zA-Z0-9._-]/g, "_");
}

function extFromMime(mimeType: string, filename: string): string {
  const fromName = extname(filename).toLowerCase();
  if (fromName && /^\.[a-z0-9]{1,8}$/i.test(fromName)) return fromName;
  if (mimeType === "image/png") return ".png";
  if (mimeType === "image/jpeg") return ".jpg";
  if (mimeType === "image/webp") return ".webp";
  if (mimeType === "image/gif") return ".gif";
  if (mimeType === "application/pdf") return ".pdf";
  if (mimeType.startsWith("text/")) return ".txt";
  return "";
}

export async function writeAttachment(opts: {
  workspaceTarget: WorkspaceTarget;
  conversationId: string;
  messageId: string;
  filename: string;
  mimeType: string;
  bytes: Uint8Array;
}): Promise<WrittenAttachment> {
  if (opts.workspaceTarget.kind === "sandbox") {
    const capability = opts.workspaceTarget.backend?.attachments;
    if (!capability) throw sandboxCapabilityUnavailable("attachment write");
    const written = await capability.write({
      binding: opts.workspaceTarget.binding,
      conversationId: opts.conversationId,
      messageId: opts.messageId,
      filename: opts.filename,
      mimeType: opts.mimeType,
      bytes: opts.bytes,
    });
    if (!written.storageKey || written.sizeBytes !== opts.bytes.byteLength) {
      throw new Error("Sandbox attachment backend returned an invalid write receipt");
    }
    return { storagePath: written.storageKey, sizeBytes: written.sizeBytes };
  }
  const dir = join(
    attachmentsRoot(opts.workspaceTarget.root),
    sanitizeSegment(opts.conversationId),
    sanitizeSegment(opts.messageId),
  );
  await mkdir(dir, { recursive: true });
  const ext = extFromMime(opts.mimeType, opts.filename);
  const storagePath = join(dir, `${crypto.randomUUID()}${ext}`);
  await Bun.write(storagePath, opts.bytes);
  return { storagePath, sizeBytes: opts.bytes.byteLength };
}

export async function readAttachmentBytes(
  workspaceTarget: WorkspaceTarget,
  storagePath: string,
): Promise<Uint8Array> {
  if (workspaceTarget.kind === "sandbox") {
    const capability = workspaceTarget.backend?.attachments;
    if (!capability) throw sandboxCapabilityUnavailable("attachment read");
    return capability.read({ binding: workspaceTarget.binding, storageKey: storagePath });
  }
  const root = attachmentsRoot(workspaceTarget.root);
  const resolvedPath = resolve(storagePath);
  if (resolvedPath !== root && !resolvedPath.startsWith(root + sep)) {
    throw new Error("Attachment path is outside the selected local workspace");
  }
  const buf = await Bun.file(storagePath).arrayBuffer();
  return new Uint8Array(buf);
}

export async function deleteForMessage(opts: {
  workspaceTarget: WorkspaceTarget;
  conversationId: string;
  messageId: string;
}): Promise<void> {
  if (opts.workspaceTarget.kind === "sandbox") {
    const capability = opts.workspaceTarget.backend?.attachments;
    if (!capability) throw sandboxCapabilityUnavailable("attachment delete");
    await capability.delete({
      binding: opts.workspaceTarget.binding,
      conversationId: opts.conversationId,
      messageId: opts.messageId,
    });
    return;
  }
  const dir = join(
    attachmentsRoot(opts.workspaceTarget.root),
    sanitizeSegment(opts.conversationId),
    sanitizeSegment(opts.messageId),
  );
  await rm(dir, { recursive: true, force: true });
}

export async function deleteForConversation(opts: {
  workspaceTarget: WorkspaceTarget;
  conversationId: string;
}): Promise<void> {
  if (opts.workspaceTarget.kind === "sandbox") {
    const capability = opts.workspaceTarget.backend?.attachments;
    if (!capability) throw sandboxCapabilityUnavailable("attachment delete");
    await capability.delete({
      binding: opts.workspaceTarget.binding,
      conversationId: opts.conversationId,
    });
    return;
  }
  const dir = join(attachmentsRoot(opts.workspaceTarget.root), sanitizeSegment(opts.conversationId));
  await rm(dir, { recursive: true, force: true });
}
