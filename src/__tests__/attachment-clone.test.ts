// Tests for `cloneAttachmentsForFork()` in `src/chat/attachments/clone.ts`.
//
// Lives in `src/__tests__/` (NOT `src/chat/attachments/__tests__/`) so the
// coverage host-set globs it — sibling backend attachment tests
// (attachment-storage.test.ts, content-builder.test.ts) live here too.
//
// The clone path re-materializes a source message's attachments onto a forked
// user row (regenerate/rerun/edit re-send without re-uploading the File bytes).
// Verified against a real PGlite instance + real on-disk storage:
//   - every source row is copied to the target message id,
//   - bytes land in a FRESH file under the TARGET message's own dir (the source
//     file is left untouched — the per-message-dir GC invariant),
//   - the returned `staged`/`summaries` carry the new row ids + display metadata,
//   - a source with no attachments yields an empty, no-op result.

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupTestDb, closeTestDb, mockDbConnection, getTestDb } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mockDbConnection();

const { cloneAttachmentsForFork } = await import("../chat/attachments/clone");
const { writeAttachment, readAttachmentBytes } = await import("../chat/attachments/storage");
const { listAttachmentsForMessage } = await import("../db/queries/attachments");
const { projects, conversations, messages, messageAttachments } = await import("../db/schema");

const PROJECT_ID = "proj-clone";
const CONV_ID = "conv-clone";
const SRC_MSG = "msg-src";
const TGT_MSG = "msg-tgt";
let TMP: string;

async function insertSourceAttachment(opts: {
  filename: string;
  mimeType: string;
  kind: "image" | "text" | "pdf" | "audio" | "extension-handle";
  bytes: Uint8Array;
}) {
  const written = await writeAttachment({
    projectRoot: TMP,
    conversationId: CONV_ID,
    messageId: SRC_MSG,
    filename: opts.filename,
    mimeType: opts.mimeType,
    bytes: opts.bytes,
  });
  await getTestDb().insert(messageAttachments).values({
    messageId: SRC_MSG,
    conversationId: CONV_ID,
    filename: opts.filename,
    mimeType: opts.mimeType,
    sizeBytes: written.sizeBytes,
    storagePath: written.storagePath,
    kind: opts.kind,
  } as never);
  return written;
}

beforeAll(async () => {
  await setupTestDb();
});

afterAll(async () => {
  await closeTestDb();
  restoreModuleMocks();
});

beforeEach(async () => {
  TMP = join(tmpdir(), `clone-att-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`);
  mkdirSync(TMP, { recursive: true });
  const db = getTestDb();
  await db.insert(projects).values({ id: PROJECT_ID, name: "Clone", path: TMP } as never);
  await db.insert(conversations).values({ id: CONV_ID, projectId: PROJECT_ID } as never);
  await db.insert(messages).values([
    { id: SRC_MSG, conversationId: CONV_ID, role: "user", content: "src" },
    { id: TGT_MSG, conversationId: CONV_ID, role: "user", content: "tgt" },
  ] as never);
});

afterEach(async () => {
  const db = getTestDb();
  await db.delete(messageAttachments);
  await db.delete(messages);
  await db.delete(conversations);
  await db.delete(projects);
  try { rmSync(TMP, { recursive: true, force: true }); } catch { /* swallow */ }
});

describe("cloneAttachmentsForFork", () => {
  test("copies a source attachment onto the target with fresh bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4, 5]);
    const src = await insertSourceAttachment({
      filename: "cow.png",
      mimeType: "image/png",
      kind: "image",
      bytes,
    });

    const result = await cloneAttachmentsForFork({
      projectRoot: TMP,
      conversationId: CONV_ID,
      sourceMessageId: SRC_MSG,
      targetMessageId: TGT_MSG,
    });

    // Returned shapes carry the new row + display metadata.
    expect(result.staged).toHaveLength(1);
    expect(result.summaries).toHaveLength(1);
    expect(result.summaries[0]).toMatchObject({
      filename: "cow.png",
      mimeType: "image/png",
      sizeBytes: 5,
      kind: "image",
    });
    expect(result.staged[0]).toMatchObject({ filename: "cow.png", mimeType: "image/png" });
    // staged + summary share the SAME new row id.
    expect(result.staged[0]!.id).toBe(result.summaries[0]!.id);

    // Fresh file under the TARGET message dir — NOT the source path.
    expect(result.staged[0]!.storagePath).not.toBe(src.storagePath);
    expect(result.staged[0]!.storagePath).toContain(TGT_MSG);

    // Row persisted on the target, pointing at the new path.
    const targetRows = await listAttachmentsForMessage(TGT_MSG);
    expect(targetRows).toHaveLength(1);
    expect(targetRows[0]!.messageId).toBe(TGT_MSG);
    expect(targetRows[0]!.storagePath).toBe(result.staged[0]!.storagePath);

    // Bytes copied faithfully; the source file is left untouched.
    expect(existsSync(src.storagePath)).toBe(true);
    const copied = await readAttachmentBytes(result.staged[0]!.storagePath);
    expect(Array.from(copied)).toEqual(Array.from(bytes));
  });

  test("copies multiple attachments, each to its own fresh file", async () => {
    await insertSourceAttachment({ filename: "a.png", mimeType: "image/png", kind: "image", bytes: new Uint8Array([1]) });
    await insertSourceAttachment({ filename: "notes.txt", mimeType: "text/plain", kind: "text", bytes: new Uint8Array([2, 2]) });

    const result = await cloneAttachmentsForFork({
      projectRoot: TMP,
      conversationId: CONV_ID,
      sourceMessageId: SRC_MSG,
      targetMessageId: TGT_MSG,
    });

    expect(result.staged).toHaveLength(2);
    expect(result.summaries).toHaveLength(2);
    // Distinct fresh files.
    expect(result.staged[0]!.storagePath).not.toBe(result.staged[1]!.storagePath);
    expect(await listAttachmentsForMessage(TGT_MSG)).toHaveLength(2);
    expect(new Set(result.summaries.map((s) => s.filename))).toEqual(new Set(["a.png", "notes.txt"]));
  });

  test("returns an empty, no-op result when the source has no attachments", async () => {
    const result = await cloneAttachmentsForFork({
      projectRoot: TMP,
      conversationId: CONV_ID,
      sourceMessageId: SRC_MSG,
      targetMessageId: TGT_MSG,
    });

    expect(result.staged).toEqual([]);
    expect(result.summaries).toEqual([]);
    expect(await listAttachmentsForMessage(TGT_MSG)).toHaveLength(0);
  });
});
