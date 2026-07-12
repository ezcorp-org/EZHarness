/**
 * Copy a message's attachments onto another message.
 *
 * Used when a regenerate/rerun/edit forks a NEW user message that re-sends the
 * original prompt without re-uploading the `File` bytes — the browser only
 * holds attachment metadata (`AttachmentSummary`), never the original bytes.
 * Without this, the forked user row has zero attachment rows, so the image
 * stops rendering (the UI keys attachments off `messageId`) and — via
 * `loadPastAttachments` — the model loses the image on this turn and every
 * later one.
 *
 * Bytes are copied to a FRESH file under the target message's own storage dir
 * rather than sharing the source `storagePath`, because on-disk GC is
 * per-message-directory (`deleteForMessage` rm-rf's `<conversationId>/
 * <messageId>/`). A shared path would let deleting one message orphan the
 * other's file. The result is structurally identical to a normal upload:
 * a row + staged entry + summary + its own bytes.
 */

import { listAttachmentsForMessage, insertAttachment } from "../../db/queries/attachments";
import { readAttachmentBytes, writeAttachment } from "./storage";
import type { StagedAttachment } from "./content-builder";
import type { AttachmentSummary } from "../../db/queries/conversations";

export interface ClonedAttachments {
  /** Fed to `streamChat`'s `attachments` option so the model re-sees the
   *  image on the forked turn. */
  staged: StagedAttachment[];
  /** Fed back on the response `userMessage.attachments` so the card renders
   *  immediately (and on reload via `attachAttachments`). */
  summaries: AttachmentSummary[];
}

export async function cloneAttachmentsForFork(opts: {
  projectRoot: string;
  conversationId: string;
  sourceMessageId: string;
  targetMessageId: string;
}): Promise<ClonedAttachments> {
  const staged: StagedAttachment[] = [];
  const summaries: AttachmentSummary[] = [];

  const sourceRows = await listAttachmentsForMessage(opts.sourceMessageId);
  for (const src of sourceRows) {
    const bytes = await readAttachmentBytes(src.storagePath);
    const written = await writeAttachment({
      projectRoot: opts.projectRoot,
      conversationId: opts.conversationId,
      messageId: opts.targetMessageId,
      filename: src.filename,
      mimeType: src.mimeType,
      bytes,
    });
    const row = await insertAttachment({
      messageId: opts.targetMessageId,
      conversationId: opts.conversationId,
      filename: src.filename,
      mimeType: src.mimeType,
      sizeBytes: written.sizeBytes,
      storagePath: written.storagePath,
      kind: src.kind,
    });
    staged.push({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      storagePath: written.storagePath,
    });
    summaries.push({
      id: row.id,
      filename: row.filename,
      mimeType: row.mimeType,
      sizeBytes: row.sizeBytes,
      kind: row.kind,
    });
  }

  return { staged, summaries };
}
