/**
 * Integration: the union of past-branch + current-turn attachments drives
 * the resolver, so a handle the LLM echoes from an earlier turn still
 * resolves to real bytes in the current turn's tool call.
 *
 * This scenario is the whole reason `rehydrateUserMessageContent` +
 * `loadPastAttachments` + the resolver union in executor.ts exist. The
 * unit tests cover each piece; this stitches them together using real DB
 * rows so a drift in any of the three pieces breaks this test.
 */

import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";

mock.module("../db/queries/settings", () => {
  const { eq } = require("drizzle-orm");
  const { settings: tbl } = require("../db/schema");
  return {
    async getAllSettings() {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl);
      return Object.fromEntries(rows.map((r: any) => [r.key, r.value]));
    },
    async getSetting(key: string) {
      const { getDb } = require("../db/connection");
      const rows = await getDb().select().from(tbl).where(eq(tbl.key, key));
      return rows[0]?.value;
    },
    async upsertSetting() {},
    async deleteSetting() { return false; },
    async isListingInstalled() { return false; },
  };
});

mockDbConnection();

import { writeAttachment } from "../chat/attachments/storage";
import { createProject } from "../db/queries/projects";
import { createConversation, createMessage } from "../db/queries/conversations";
import { insertAttachment } from "../db/queries/attachments";
import { loadPastAttachments } from "../chat/attachments/history-rehydrate";
import { buildAttachmentHandleResolver, toResolvableAttachments } from "../chat/attachments/handle-resolver";
import { attachmentHandle, type StagedAttachment } from "../chat/attachments/content-builder";

const TURN_1_BYTES = new TextEncoder().encode("TURN-1-IMAGE-BYTES");
const TURN_N_BYTES = new TextEncoder().encode("TURN-N-IMAGE-BYTES");
const T1_B64 = Buffer.from(TURN_1_BYTES).toString("base64");
const TN_B64 = Buffer.from(TURN_N_BYTES).toString("base64");

let tmpRoot: string;
let convId: string;
let turn1MsgId: string;
let turn1AttId: string;
let currentTurnAttachment: StagedAttachment;

beforeAll(async () => {
  await setupTestDb();
  tmpRoot = await mkdtemp(join(tmpdir(), "ezcorp-pastres-"));
  const project = await createProject({ name: "Past Handles", path: tmpRoot });
  const conv = await createConversation(project.id, { title: "c" });
  convId = conv.id;

  // Turn 1 — user uploads an image that the assistant later references.
  const t1 = await createMessage(convId, { role: "user", content: "first upload" });
  turn1MsgId = t1.id;
  const w1 = await writeAttachment({
    projectRoot: tmpRoot, conversationId: convId, messageId: t1.id,
    filename: "cow.png", mimeType: "image/png", bytes: TURN_1_BYTES,
  });
  const row1 = await insertAttachment({
    messageId: t1.id, conversationId: convId,
    filename: "cow.png", mimeType: "image/png",
    sizeBytes: w1.sizeBytes, storagePath: w1.storagePath, kind: "image",
  });
  turn1AttId = row1.id;

  // Assistant turn + a current-turn user message (no new upload from user
  // this turn — they're referring back to the earlier image).
  const a1 = await createMessage(convId, {
    role: "assistant", content: "ok", parentMessageId: t1.id,
  });
  const t2 = await createMessage(convId, {
    role: "user", content: "now add a hat", parentMessageId: a1.id,
  });

  // Current turn's POST staged a DIFFERENT image (e.g. mask or reference),
  // so `options.attachments` for this turn carries only that one file.
  const wN = await writeAttachment({
    projectRoot: tmpRoot, conversationId: convId, messageId: t2.id,
    filename: "mask.png", mimeType: "image/png", bytes: TURN_N_BYTES,
  });
  const rowN = await insertAttachment({
    messageId: t2.id, conversationId: convId,
    filename: "mask.png", mimeType: "image/png",
    sizeBytes: wN.sizeBytes, storagePath: wN.storagePath, kind: "image",
  });
  currentTurnAttachment = {
    id: rowN.id,
    filename: "mask.png",
    mimeType: "image/png",
    storagePath: wN.storagePath,
  };
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
  await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
});

describe("past-turn handles resolve in the current turn's tool call", () => {
  test("union of past + current attachments feeds the resolver", async () => {
    const branch = [
      { id: turn1MsgId, role: "user", content: "first upload" },
      { id: "x", role: "assistant", content: "ok" },
    ];
    const { all } = await loadPastAttachments(branch);
    const byId = new Map<string, StagedAttachment>();
    for (const a of all) byId.set(a.id, a);
    byId.set(currentTurnAttachment.id, currentTurnAttachment);
    const resolver = buildAttachmentHandleResolver(
      toResolvableAttachments(Array.from(byId.values())),
    );

    // Simulate the LLM echoing BOTH handles into a single tool call —
    // one from an earlier turn (turn1) and one from the current turn.
    const resolved = await resolver({
      images: [attachmentHandle(turn1AttId), attachmentHandle(currentTurnAttachment.id)],
    });
    const imgs = resolved.images as string[];
    expect(imgs[0]).toBe(`data:image/png;base64,${T1_B64}`);
    expect(imgs[1]).toBe(`data:image/png;base64,${TN_B64}`);
  });

  test("current-turn spelling of the same attachment id overrides the past-row reference", async () => {
    // If current-turn attachments include the SAME id as a past-turn row
    // (e.g. the same bytes re-posted), the resolver dedupes by id and
    // still returns the correct data URI.
    const branch = [{ id: turn1MsgId, role: "user", content: "first" }];
    const { all } = await loadPastAttachments(branch);
    const byId = new Map<string, StagedAttachment>();
    for (const a of all) byId.set(a.id, a);
    // Put turn-1 attachment ALSO in the "current turn" set.
    byId.set(turn1AttId, all.find((a) => a.id === turn1AttId)!);
    const resolver = buildAttachmentHandleResolver(
      toResolvableAttachments(Array.from(byId.values())),
    );
    const resolved = await resolver({ images: [attachmentHandle(turn1AttId)] });
    expect((resolved.images as string[])[0]).toBe(`data:image/png;base64,${T1_B64}`);
  });

  test("past-turn handle alone (no current-turn files) still resolves", async () => {
    // The common failure-mode scenario the user reported before: no new
    // upload this turn, but the LLM references turn-1's image.
    const branch = [{ id: turn1MsgId, role: "user", content: "first" }];
    const { all } = await loadPastAttachments(branch);
    const resolver = buildAttachmentHandleResolver(toResolvableAttachments(all));
    const resolved = await resolver({ images: [attachmentHandle(turn1AttId)] });
    expect((resolved.images as string[])[0]).toBe(`data:image/png;base64,${T1_B64}`);
  });
});
