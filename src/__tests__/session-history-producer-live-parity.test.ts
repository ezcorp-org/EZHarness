/**
 * P3 LIVE parity: the session history producer, exercised through the REAL
 * `loadHistory` seam (design §5/§7-P3). For every shape the P2 dark suite
 * proved at the buildContext level, we now assert flag-ON `loadHistory`
 * output is byte-identical to the flag-OFF legacy CTE path — INCLUDING the
 * attachment/image rehydration P2 deferred (now CLOSED, since the transform
 * runs over the session-derived branch rows exactly as it runs over the CTE
 * rows).
 *
 * The ONLY normalised field is `timestamp` — both paths stamp each message
 * with wall-clock `Date.now()` at map time, so two loadHistory calls differ
 * by execution latency; it is never sent on the wire. Every other field
 * (role, content, injected image bytes/mime, parts ordering) is compared.
 *
 * Also covered: fail-open (a poisoned session falls back to legacy, the
 * turn still produces the right history) and a kill-switch flip mid-
 * conversation (OFF turns are caught up on the first ON read; flipping back
 * OFF leaves the legacy path untouched).
 */
import { test, expect, describe, beforeEach, afterAll, beforeAll, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { setupTestDb, closeTestDb, getTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";
import { agentSessionEntries, agentSessions } from "../db/schema";

mockDbConnection();

const { loadHistory } = await import("../runtime/stream-chat/load-history");
const { SESSION_HISTORY_PRODUCER_SETTING } = await import("../db/session-sync");
const { upsertSetting } = await import("../db/queries/settings");
const { createProject } = await import("../db/queries/projects");
const { createConversation, createMessage } = await import("../db/queries/conversations");
const { insertAttachment } = await import("../db/queries/attachments");
const { persistToolCall } = await import("../db/queries/tool-calls");
const { createExtension } = await import("../db/queries/extensions");

import type { StreamChatContext } from "../runtime/stream-chat/context";

const EXT = "openai-image-gen-2";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");
const SAFE_CWD = tmpdir();
let tmpRoot = "";
let testExtensionId = "";

function mkCtx(): StreamChatContext {
  return { system: undefined } as unknown as StreamChatContext;
}

/** loadHistory stamps each message with `Date.now()` at map time — normalise
 *  it (the ONLY non-deterministic field) before comparing. */
function stripTimestamps<T extends { timestamp?: unknown }>(msgs: T[]): T[] {
  return msgs.map((m) => ({ ...m, timestamp: 0 }));
}

async function setFlag(on: boolean): Promise<void> {
  await upsertSetting(SESSION_HISTORY_PRODUCER_SETTING, on);
}

/** Load loadHistory OFF (legacy reference) then ON (session candidate).
 *  The caller asserts byte-identity (timestamps normalised). */
async function loadParity(convId: string, opts: Record<string, unknown> = {}): Promise<{ ref: any[]; cand: any[] }> {
  await setFlag(false);
  const ref = (await loadHistory(mkCtx(), convId, opts)).history;
  await setFlag(true);
  const cand = (await loadHistory(mkCtx(), convId, opts)).history;
  return { ref, cand };
}

async function seedLinear(
  turns: Array<{ role: string; content: string; excluded?: boolean }>,
): Promise<{ convId: string; leafId: string; ids: string[] }> {
  const project = await createProject({ name: "LP", path: tmpRoot });
  const conv = await createConversation(project.id, { title: "t" });
  let parent: string | undefined;
  const ids: string[] = [];
  for (const t of turns) {
    const m = await createMessage(conv.id, { role: t.role, content: t.content, parentMessageId: parent });
    if (t.excluded) {
      await getTestDb().update((await import("../db/schema")).messages).set({ excluded: true }).where(eq((await import("../db/schema")).messages.id, m.id));
    }
    parent = m.id;
    ids.push(m.id);
  }
  return { convId: conv.id, leafId: ids[ids.length - 1]!, ids };
}

function writeImage(relUnderExt: string, bytes: Uint8Array): string {
  const abs = join(tmpRoot, ".ezcorp", "extension-data", EXT, relUnderExt);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, bytes as any);
  return `/api/ext-files/${EXT}/${relUnderExt}`;
}

beforeAll(async () => {
  await setupTestDb();
  const ext = await createExtension({
    name: "test-image-gen",
    version: "0.0.0",
    source: "test",
    manifest: { schemaVersion: 2, name: "test-image-gen", version: "0.0.0", entrypoint: "x", author: { name: "t" }, tools: [], permissions: {} } as any,
  });
  testExtensionId = ext.id;
});

afterAll(async () => {
  restoreModuleMocks();
  await closeTestDb();
  process.chdir(SAFE_CWD);
});

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "live-parity-"));
  process.chdir(tmpRoot);
});

afterEach(async () => {
  process.chdir(SAFE_CWD);
  if (tmpRoot) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch (err) { void err; }
    tmpRoot = "";
  }
  await setFlag(false);
});

describe("session history producer — LIVE loadHistory parity", () => {
  test("linear thread", async () => {
    const { convId, leafId } = await seedLinear([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ]);
    const { ref, cand } = await loadParity(convId, { parentMessageId: leafId });
    expect(stripTimestamps(cand)).toEqual(stripTimestamps(ref));
  });

  test("branched thread (edit/retry): only the active branch", async () => {
    const project = await createProject({ name: "LPB", path: tmpRoot });
    const conv = await createConversation(project.id, { title: "t" });
    const u1 = await createMessage(conv.id, { role: "user", content: "u1" });
    const a1 = await createMessage(conv.id, { role: "assistant", content: "a1", parentMessageId: u1.id });
    // abandoned branch
    const u2a = await createMessage(conv.id, { role: "user", content: "u2-abandoned", parentMessageId: a1.id });
    await createMessage(conv.id, { role: "assistant", content: "a2-abandoned", parentMessageId: u2a.id });
    // active branch (edited)
    const u2b = await createMessage(conv.id, { role: "user", content: "u2-active", parentMessageId: a1.id });
    const a2b = await createMessage(conv.id, { role: "assistant", content: "a2-active", parentMessageId: u2b.id });
    const { ref, cand } = await loadParity(conv.id, { parentMessageId: a2b.id });
    expect(stripTimestamps(cand)).toEqual(stripTimestamps(ref));
  });

  test("no parentMessageId → resolves the latest leaf identically", async () => {
    const { convId } = await seedLinear([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ]);
    const { ref, cand } = await loadParity(convId, {});
    expect(stripTimestamps(cand)).toEqual(stripTimestamps(ref));
  });

  test("synthetic + excluded rows dropped identically", async () => {
    const project = await createProject({ name: "LPS", path: tmpRoot });
    const conv = await createConversation(project.id, { title: "t" });
    const u1 = await createMessage(conv.id, { role: "user", content: "u1" });
    const x = await createMessage(conv.id, { role: "assistant", content: "excluded", parentMessageId: u1.id });
    await getTestDb().update((await import("../db/schema")).messages).set({ excluded: true }).where(eq((await import("../db/schema")).messages.id, x.id));
    const pr = await createMessage(conv.id, { role: "preprocess-result", content: "{}", parentMessageId: x.id });
    const ear = await createMessage(conv.id, { role: "ez-action-result", content: "{}", parentMessageId: pr.id });
    const u2 = await createMessage(conv.id, { role: "user", content: "u2", parentMessageId: ear.id });
    const ce = await createMessage(conv.id, { role: "capability-event", content: "{}", parentMessageId: u2.id });
    const a2 = await createMessage(conv.id, { role: "assistant", content: "a2", parentMessageId: ce.id });
    const { ref, cand } = await loadParity(conv.id, { parentMessageId: a2.id });
    expect(stripTimestamps(cand)).toEqual(stripTimestamps(ref));
  });

  test("empty conversation", async () => {
    const project = await createProject({ name: "LPE", path: tmpRoot });
    const conv = await createConversation(project.id, { title: "t" });
    const { ref, cand } = await loadParity(conv.id, {});
    expect(stripTimestamps(cand)).toEqual(stripTimestamps(ref));
  });

  // ── Rehydration parity CLOSED (P2's deferred exclusion) ──────────────
  test("attachment rehydration parity under an image-capable provider", async () => {
    const project = await createProject({ name: "LPA", path: tmpRoot });
    const conv = await createConversation(project.id, { title: "t" });
    const u1 = await createMessage(conv.id, { role: "user", content: "look at this" });
    await insertAttachment({
      messageId: u1.id,
      conversationId: conv.id,
      filename: "pic.png",
      mimeType: "image/png",
      sizeBytes: PNG_BYTES.length,
      storagePath: writeAttachmentFile("pic.png", PNG_BYTES),
      kind: "image",
    });
    const a1 = await createMessage(conv.id, { role: "assistant", content: "nice", parentMessageId: u1.id });
    const u2 = await createMessage(conv.id, { role: "user", content: "and again", parentMessageId: a1.id });
    // Image-capable provider → loadHistory lifts the attached user turn into
    // image content parts. Both paths must produce identical parts.
    const opts = { parentMessageId: u2.id, provider: "anthropic", model: "claude-sonnet-4-5" };
    await setFlag(false);
    const ref = (await loadHistory(mkCtx(), conv.id, opts)).history;
    await setFlag(true);
    const cand = (await loadHistory(mkCtx(), conv.id, opts)).history;
    expect(stripTimestamps(cand)).toEqual(stripTimestamps(ref));
    // Sanity: the attachment really WAS rehydrated into image parts (not a
    // both-fell-back-to-raw-text trivial pass) — the user turn that carried
    // the attachment is now a parts-array with an image.
    const withImage = cand.find((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.type === "image"));
    expect(withImage, "an image part was injected into the attached user turn").toBeDefined();
    expect((withImage as any).content.find((p: any) => p.type === "image").data).toBe(PNG_B64);
  });

  test("tool-generated image injection parity", async () => {
    const url = writeImage("generated/edit-me.png", PNG_BYTES);
    const project = await createProject({ name: "LPI", path: tmpRoot });
    const conv = await createConversation(project.id, { title: "t" });
    const u1 = await createMessage(conv.id, { role: "user", content: "make a cat" });
    const a1 = await createMessage(conv.id, { role: "assistant", content: `Here: ![cat](${url})`, parentMessageId: u1.id });
    const u2 = await createMessage(conv.id, { role: "user", content: "make it bigger", parentMessageId: a1.id });
    const opts = { parentMessageId: u2.id, provider: "anthropic", model: "claude-sonnet-4-5" };
    await setFlag(false);
    const ref = (await loadHistory(mkCtx(), conv.id, opts)).history;
    await setFlag(true);
    const cand = (await loadHistory(mkCtx(), conv.id, opts)).history;
    expect(stripTimestamps(cand)).toEqual(stripTimestamps(ref));
    // Sanity: the injected image really is present (not a both-empty pass).
    const candImages = cand.flatMap((m: any) => (Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "image") : []));
    expect(candImages).toHaveLength(1);
    expect((candImages[0] as any).data).toBe(PNG_B64);
  });

  // ── Tool-output image injection (URL only in tool_calls.output) ──────
  test("tool-output image injection parity", async () => {
    const url = writeImage("generated/tool-only.png", PNG_BYTES);
    const project = await createProject({ name: "LPT", path: tmpRoot });
    const conv = await createConversation(project.id, { title: "t" });
    const u1 = await createMessage(conv.id, { role: "user", content: "gen" });
    const a1 = await createMessage(conv.id, { role: "assistant", content: "Done.", parentMessageId: u1.id });
    await persistToolCall({
      conversationId: conv.id,
      messageId: a1.id,
      extensionId: testExtensionId,
      toolName: "generate",
      input: { prompt: "x" },
      output: { content: [{ type: "text", text: `![](${url})` }] },
      success: true,
      durationMs: 10,
    });
    const u2 = await createMessage(conv.id, { role: "user", content: "edit it", parentMessageId: a1.id });
    const { ref, cand } = await loadParity(conv.id, { parentMessageId: u2.id, provider: "anthropic", model: "claude-sonnet-4-5" });
    expect(stripTimestamps(cand)).toEqual(stripTimestamps(ref));
  });
});

describe("session history producer — fail-open + kill-switch flip", () => {
  test("poisoned session → fail-open to legacy, turn still produces correct history", async () => {
    const { convId, leafId } = await seedLinear([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
    ]);
    // Reference (legacy) output.
    await setFlag(false);
    const ref = (await loadHistory(mkCtx(), convId, { parentMessageId: leafId })).history;

    // Create the session, then POISON it: a leaf pointer to a non-existent
    // entry makes DbSessionStorage.open throw invalid_session.
    await setFlag(true);
    await loadHistory(mkCtx(), convId, { parentMessageId: leafId }); // creates the session
    const [session] = await getTestDb().select().from(agentSessions).where(eq(agentSessions.conversationId, convId));
    await getTestDb().insert(agentSessionEntries).values({
      sessionId: session.id,
      entryId: "poison-leaf",
      type: "leaf",
      parentId: null,
      timestamp: new Date().toISOString(),
      payload: { targetId: "does-not-exist" },
    });

    // With the poisoned session the ON path throws → falls back to legacy.
    const cand = (await loadHistory(mkCtx(), convId, { parentMessageId: leafId })).history;
    expect(stripTimestamps(cand)).toEqual(stripTimestamps(ref));
  });

  test("flip mid-conversation: OFF turns are caught up on first ON read; flipping OFF leaves legacy untouched", async () => {
    // Turns produced while the flag is OFF (no session, no live-append).
    await setFlag(false);
    const { convId, ids } = await seedLinear([
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "a2" },
    ]);
    const leafId = ids[ids.length - 1]!;
    const legacy = (await loadHistory(mkCtx(), convId, { parentMessageId: leafId })).history;

    // Flip ON: the first read backfills the WHOLE messages tree (all four
    // OFF-era turns) → parity with the legacy output.
    await setFlag(true);
    const enabled = (await loadHistory(mkCtx(), convId, { parentMessageId: leafId })).history;
    expect(stripTimestamps(enabled)).toEqual(stripTimestamps(legacy));

    // Flip back OFF: legacy path is byte-for-byte untouched by the session.
    await setFlag(false);
    const backToLegacy = (await loadHistory(mkCtx(), convId, { parentMessageId: leafId })).history;
    expect(stripTimestamps(backToLegacy)).toEqual(stripTimestamps(legacy));
  });
});

/** Write a user-attachment fixture file and return its storagePath. */
function writeAttachmentFile(name: string, bytes: Uint8Array): string {
  const abs = join(tmpRoot, ".ezcorp", "attachments", name);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, bytes as any);
  return abs;
}
