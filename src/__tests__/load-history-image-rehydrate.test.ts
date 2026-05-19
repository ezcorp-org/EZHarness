/**
 * Integration coverage for `loadHistory`'s image-rehydration path.
 *
 * Confirms that ext-files URLs written by the image-gen tool into prior
 * assistant messages are resolved back into `ImageContent` parts and
 * attached to the *next* user message (pi-ai's AssistantMessage doesn't
 * allow image parts, so injection happens on the user side).
 *
 * Cases:
 *   12. Vision-capable model → last assistant's images land on the next
 *       user message.
 *   13. Non-vision model → no rehydration, history is text-only.
 *   14. Last-N cap → images from assistants older than N are excluded.
 *   15. Trailing assistant → its images are silently dropped (no next user
 *       to attach to).
 *
 * Plus pure-function coverage for `pickAssistantIndicesToRehydrate` and
 * `findNextUserIndex` so the cap logic doesn't drift from the harness.
 */

import { test, expect, describe, beforeAll, afterAll, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setupTestDb, closeTestDb, mockDbConnection } from "./helpers/test-pglite";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

mockDbConnection();

import {
  loadHistory,
  findNextUserIndex,
  collectRehydratedImages,
  MAX_REHYDRATED_IMAGES,
  MAX_REHYDRATED_IMAGE_BYTES,
} from "../runtime/stream-chat/load-history";
import { createProject } from "../db/queries/projects";
import { createConversation, createMessage } from "../db/queries/conversations";
import { persistToolCall } from "../db/queries/tool-calls";
import { createExtension } from "../db/queries/extensions";
import type { StreamChatContext } from "../runtime/stream-chat/context";

const EXT = "openai-image-gen-2";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");
const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);

let tmpRoot = "";
// Don't snapshot process.cwd() — sibling tests in the same file run (e.g.
// ext-files-route.test.ts) may have chdir'd into a now-deleted tmp dir and
// left the process in a broken state. Always chdir back to a guaranteed
// location.
const SAFE_CWD = tmpdir();

/** Pull a parts-array off a user message's content; asserts the shape. */
function partsOf(content: unknown): Array<{ type: string; [k: string]: unknown }> {
  if (!Array.isArray(content)) throw new Error("expected parts-array content, got string");
  return content as Array<{ type: string; [k: string]: unknown }>;
}

/** Minimal StreamChatContext shape — loadHistory only mutates `.system`. */
function mkCtx(): StreamChatContext {
  return { system: undefined } as unknown as StreamChatContext;
}

let testExtensionId = "";

beforeAll(async () => {
  await setupTestDb();
  // tool_calls.extension_id has a FK → extensions.id, so seed a minimal
  // row. persistToolCall silently swallows insert errors (including FK
  // failures), so without this the tool-output rehydration tests would
  // see an empty tool_calls table and silently skip the interesting path.
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
  tmpRoot = mkdtempSync(join(tmpdir(), "loadhistory-"));
  // loadHistory → rehydrateAssistantMessageContent uses process.cwd() to
  // resolve ext-files paths. Point cwd at the test's tmp project root so
  // fixture files are discoverable.
  process.chdir(tmpRoot);
});

afterEach(() => {
  // Step OUT of tmpRoot before deleting it, so subsequent tests don't see
  // process.cwd() pointing at a deleted directory.
  process.chdir(SAFE_CWD);
  if (tmpRoot) {
    try { rmSync(tmpRoot, { recursive: true, force: true }); } catch {}
    tmpRoot = "";
  }
});

function writeImage(relUnderExt: string, bytes: Uint8Array): string {
  const abs = join(tmpRoot, ".ezcorp", "extension-data", EXT, relUnderExt);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, bytes as any);
  return `/api/ext-files/${EXT}/${relUnderExt}`;
}

/** Allocate `n` bytes whose first byte is `marker` so the base64 payload
 *  (and hence the path-key dedupe) is distinct per marker. */
function makeBytes(n: number, marker: number): Uint8Array {
  const b = new Uint8Array(n);
  b[0] = marker;
  return b;
}

// ── Pure-function cap coverage (no DB required) ────────────────────
//
// `collectRehydratedImages` queries `listToolCallOutputsForMessages`
// internally, but with an empty DB that returns []. Branches that take only
// message text (not tool outputs) exercise the cap logic without any DB
// rows — we verify the newest-first ordering, image count cap, and byte
// cap independently.
describe("collectRehydratedImages cap arithmetic", () => {
  let unitCwd = "";
  // Setup uses setupTestDb already (beforeAll above) so the queries layer
  // works even though we don't seed rows here.

  beforeEach(() => {
    unitCwd = mkdtempSync(join(tmpdir(), "cap-"));
    process.chdir(unitCwd);
  });

  afterEach(() => {
    process.chdir(SAFE_CWD);
    if (unitCwd) {
      try { rmSync(unitCwd, { recursive: true, force: true }); } catch {}
      unitCwd = "";
    }
  });

  function writeUnitImage(rel: string, bytes: Uint8Array): string {
    const abs = join(unitCwd, ".ezcorp", "extension-data", EXT, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, bytes as any);
    return `/api/ext-files/${EXT}/${rel}`;
  }

  test("respects custom maxImages limit", async () => {
    // 4 assistants each with one unique image; cap to 2.
    const urls = [
      writeUnitImage("generated/u0.png", makeBytes(8, 1)),
      writeUnitImage("generated/u1.png", makeBytes(8, 2)),
      writeUnitImage("generated/u2.png", makeBytes(8, 3)),
      writeUnitImage("generated/u3.png", makeBytes(8, 4)),
    ];
    const branch = [
      { id: "a", role: "user", content: "" },
      { id: "b", role: "assistant", content: `![](${urls[0]})` },
      { id: "c", role: "user", content: "" },
      { id: "d", role: "assistant", content: `![](${urls[1]})` },
      { id: "e", role: "user", content: "" },
      { id: "f", role: "assistant", content: `![](${urls[2]})` },
      { id: "g", role: "user", content: "" },
      { id: "h", role: "assistant", content: `![](${urls[3]})` },
      { id: "i", role: "user", content: "" },
    ];
    const out = new Map<number, Array<{ type: "image"; data: string; mimeType: string }>>();
    await collectRehydratedImages(branch, out, { maxImages: 2 });
    const total = Array.from(out.values()).flat().length;
    expect(total).toBe(2);
  });

  test("respects custom maxBytes limit", async () => {
    // 3 images of 100 bytes each; cap to 250 bytes → fits exactly 2.
    const urls = [
      writeUnitImage("generated/b0.png", makeBytes(100, 1)),
      writeUnitImage("generated/b1.png", makeBytes(100, 2)),
      writeUnitImage("generated/b2.png", makeBytes(100, 3)),
    ];
    const branch = [
      { id: "a", role: "user", content: "" },
      { id: "b", role: "assistant", content: `![](${urls[0]})` },
      { id: "c", role: "user", content: "" },
      { id: "d", role: "assistant", content: `![](${urls[1]})` },
      { id: "e", role: "user", content: "" },
      { id: "f", role: "assistant", content: `![](${urls[2]})` },
      { id: "g", role: "user", content: "" },
    ];
    const out = new Map<number, Array<{ type: "image"; data: string; mimeType: string }>>();
    await collectRehydratedImages(branch, out, { maxImages: 100, maxBytes: 250 });
    expect(Array.from(out.values()).flat().length).toBe(2);
  });

  test("prefers newest: under-cap means the last turn's image is injected first", async () => {
    const urls = [
      writeUnitImage("generated/n0.png", makeBytes(8, 1)),
      writeUnitImage("generated/n1.png", makeBytes(8, 2)),
    ];
    const branch = [
      { id: "a", role: "user", content: "" },
      { id: "b", role: "assistant", content: `![](${urls[0]})` },
      { id: "c", role: "user", content: "" },
      { id: "d", role: "assistant", content: `![](${urls[1]})` },
      { id: "e", role: "user", content: "" }, // idx 4 — nextUser for the last assistant
    ];
    const out = new Map<number, Array<{ type: "image"; data: string; mimeType: string }>>();
    await collectRehydratedImages(branch, out, { maxImages: 1 });
    // Only one image fits; it should be the NEWEST, attached to the final user (idx 4).
    expect(out.get(4)).toBeDefined();
    expect(out.get(4)!).toHaveLength(1);
    // The older turn's image (idx 2 would have received) is absent.
    expect(out.get(2)).toBeUndefined();
  });

  test("trailing assistant with no follow-up user: image is NOT consumed by the cap", async () => {
    // If the last assistant has no next-user, we skip it entirely. The
    // image doesn't count against the cap, leaving room for an older
    // in-range image to get in.
    const urls = [
      writeUnitImage("generated/t0.png", makeBytes(8, 1)),
      writeUnitImage("generated/t1.png", makeBytes(8, 2)),
    ];
    const branch = [
      { id: "a", role: "user", content: "" },
      { id: "b", role: "assistant", content: `![](${urls[0]})` },
      { id: "c", role: "user", content: "" },
      { id: "d", role: "assistant", content: `![](${urls[1]})` }, // trailing — skipped
    ];
    const out = new Map<number, Array<{ type: "image"; data: string; mimeType: string }>>();
    await collectRehydratedImages(branch, out, { maxImages: 1 });
    // The in-range image at idx 1 → nextUser idx 2 should be injected.
    expect(out.get(2)).toBeDefined();
    expect(out.get(2)!).toHaveLength(1);
  });

  test("empty branch → no-op", async () => {
    const out = new Map<number, Array<{ type: "image"; data: string; mimeType: string }>>();
    await collectRehydratedImages([], out);
    expect(out.size).toBe(0);
  });

  test("zero caps → no-op", async () => {
    const url = writeUnitImage("generated/z.png", makeBytes(8, 1));
    const branch = [
      { id: "a", role: "user", content: "" },
      { id: "b", role: "assistant", content: `![](${url})` },
      { id: "c", role: "user", content: "" },
    ];
    const out = new Map<number, Array<{ type: "image"; data: string; mimeType: string }>>();
    await collectRehydratedImages(branch, out, { maxImages: 0 });
    expect(out.size).toBe(0);
  });

  // ── Observability: log level on stat misses ──────────────────────
  //
  // When an ext-files URL can't be resolved on disk (most often because
  // a deployment forgot to mount the /app/.ezcorp volume — the real
  // bug that caused the original outage), the walker must log at warn
  // level so the failure surfaces above info-noise. Happy-path walks
  // stay at info.

  function captureStdStreams(): () => { stdout: string[]; stderr: string[] } {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const origOut = process.stdout.write.bind(process.stdout);
    const origErr = process.stderr.write.bind(process.stderr);
    (process.stdout.write as any) = (chunk: any, ...rest: any[]) => {
      stdout.push(String(chunk));
      return origOut(chunk, ...(rest as []));
    };
    (process.stderr.write as any) = (chunk: any, ...rest: any[]) => {
      stderr.push(String(chunk));
      return origErr(chunk, ...(rest as []));
    };
    return () => {
      (process.stdout.write as any) = origOut;
      (process.stderr.write as any) = origErr;
      return { stdout, stderr };
    };
  }

  function rehydrateLines(captured: string[]): Array<{ level: string; statMisses?: number; msg: string }> {
    const out: Array<{ level: string; statMisses?: number; msg: string }> = [];
    for (const chunk of captured) {
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const j = JSON.parse(line);
          if (j.subsystem === "executor.loadHistory.rehydrate" && j.msg.startsWith("walked")) {
            out.push({ level: j.level, statMisses: j.statMisses, msg: j.msg });
          }
        } catch { /* not JSON, skip */ }
      }
    }
    return out;
  }

  test("happy path (statMisses=0) logs at info level", async () => {
    const url = writeUnitImage("generated/ok.png", makeBytes(8, 1));
    const branch = [
      { id: "a", role: "user", content: "" },
      { id: "b", role: "assistant", content: `![](${url})` },
      { id: "c", role: "user", content: "" },
    ];
    const stop = captureStdStreams();
    const out = new Map<number, Array<{ type: "image"; data: string; mimeType: string }>>();
    await collectRehydratedImages(branch, out);
    const { stdout, stderr } = stop();
    // Log line must appear somewhere — confirms the observability path ran.
    const allLines = rehydrateLines([...stdout, ...stderr]);
    expect(allLines.length).toBeGreaterThan(0);
    const line = allLines[allLines.length - 1]!;
    expect(line.level).toBe("info");
    expect(line.statMisses).toBe(0);
    // Info lines land on stdout, not stderr.
    expect(rehydrateLines(stdout).length).toBeGreaterThan(0);
  });

  test("missing files (statMisses>0) logs at warn level", async () => {
    // URL points at a file that does NOT exist on disk — mimics the
    // production bug where the /app/.ezcorp volume wasn't mounted and
    // the referenced file was wiped by a container restart.
    const ghostUrl = `/api/ext-files/${EXT}/generated/never-written.png`;
    const branch = [
      { id: "a", role: "user", content: "" },
      { id: "b", role: "assistant", content: `![](${ghostUrl})` },
      { id: "c", role: "user", content: "" },
    ];
    const stop = captureStdStreams();
    const out = new Map<number, Array<{ type: "image"; data: string; mimeType: string }>>();
    await collectRehydratedImages(branch, out);
    const { stdout, stderr } = stop();
    const allLines = rehydrateLines([...stdout, ...stderr]);
    expect(allLines.length).toBeGreaterThan(0);
    const line = allLines[allLines.length - 1]!;
    expect(line.level).toBe("warn");
    expect(line.statMisses).toBeGreaterThan(0);
    expect(line.msg).toContain("some ext-files URLs could not be resolved");
    // Warn lines land on stderr, not stdout — confirms routing so
    // log shippers that split by stream handle them correctly.
    expect(rehydrateLines(stderr).length).toBeGreaterThan(0);
  });
});

describe("findNextUserIndex", () => {
  test("finds the nearest following user", () => {
    const branch = [
      { role: "user" },
      { role: "assistant" }, // from here
      { role: "assistant" }, // adjacent assistant — skip
      { role: "user" },      // ← match (idx 3)
      { role: "user" },
    ];
    expect(findNextUserIndex(branch, 1)).toBe(3);
  });

  test("no following user → -1", () => {
    const branch = [{ role: "user" }, { role: "assistant" }];
    expect(findNextUserIndex(branch, 1)).toBe(-1);
  });

  test("fromIdx at end → -1", () => {
    const branch = [{ role: "user" }];
    expect(findNextUserIndex(branch, 0)).toBe(-1);
  });
});

// ── Integration: wired loadHistory with real DB + real fs ──────────
describe("loadHistory image-rehydration", () => {
  async function seedBranch(
    turns: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<{ convId: string; leafId: string }> {
    const project = await createProject({ name: "LH", path: tmpRoot });
    const conv = await createConversation(project.id, { title: "t" });
    let parent: string | undefined;
    let leafId = "";
    for (const t of turns) {
      const m = await createMessage(conv.id, { role: t.role, content: t.content, parentMessageId: parent });
      parent = m.id;
      leafId = m.id;
    }
    return { convId: conv.id, leafId };
  }

  // ── Case 12 ─────────────────────────────────────────────────────
  test("vision-capable model: last assistant's image lands on the next user message", async () => {
    const url = writeImage("generated/edit-me.png", PNG_BYTES);
    const { convId, leafId } = await seedBranch([
      { role: "user", content: "make me a cat" },
      { role: "assistant", content: `Here: ![cat](${url})` },
      { role: "user", content: "make it bigger" }, // followup — gets the image injected
    ]);
    const { history } = await loadHistory(mkCtx(), convId, {
      parentMessageId: leafId,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });
    expect(history).toHaveLength(3);
    // Assistant message: text-only (pi-ai contract).
    expect(history[1]!.role).toBe("assistant");
    expect(Array.isArray((history[1] as any).content)).toBe(true);
    expect((history[1] as any).content.every((p: any) => p.type === "text" || p.type === "thinking")).toBe(true);
    // Follow-up user: parts-array with text + injected image.
    expect(history[2]!.role).toBe("user");
    const parts = partsOf((history[2] as any).content);
    const images = parts.filter((p) => p.type === "image");
    expect(images).toHaveLength(1);
    expect((images[0] as any).data).toBe(PNG_B64);
    expect((images[0] as any).mimeType).toBe("image/png");
    // The user's own typed text is preserved.
    const texts = parts.filter((p) => p.type === "text");
    expect(texts.length).toBeGreaterThanOrEqual(1);
    expect((texts[0] as any).text).toContain("make it bigger");
  });

  // ── Case 13 ─────────────────────────────────────────────────────
  test("non-vision model: no rehydration, follow-up user stays text-only", async () => {
    writeImage("generated/edit-me.png", PNG_BYTES);
    const { convId, leafId } = await seedBranch([
      { role: "user", content: "make me a cat" },
      { role: "assistant", content: `Here: ![cat](/api/ext-files/${EXT}/generated/edit-me.png)` },
      { role: "user", content: "make it bigger" },
    ]);
    const { history } = await loadHistory(mkCtx(), convId, {
      parentMessageId: leafId,
      provider: "my-custom-provider",
      model: "text-only-model",
    });
    // Follow-up user content stays as the raw string (no parts-array, no image).
    const followupContent = (history[2] as any).content;
    if (Array.isArray(followupContent)) {
      expect(followupContent.some((p: any) => p.type === "image")).toBe(false);
    } else {
      expect(typeof followupContent).toBe("string");
    }
  });

  // ── Smart cap: image count ─────────────────────────────────────
  test("image cap stops accumulation at MAX_REHYDRATED_IMAGES", async () => {
    // Seed MAX+2 assistant turns each with a distinct image.
    const n = MAX_REHYDRATED_IMAGES + 2;
    const urls: string[] = [];
    for (let i = 0; i < n; i++) {
      // Unique bytes per file so dedupe doesn't interfere with the count.
      urls.push(writeImage(`generated/cap-${i}.png`, new Uint8Array([i, 2, 3, 4])));
    }
    const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    for (let i = 0; i < n; i++) {
      turns.push({ role: "user", content: `u-${i}` });
      turns.push({ role: "assistant", content: `![](${urls[i]})` });
    }
    turns.push({ role: "user", content: "final" });

    const { convId, leafId } = await seedBranch(turns);
    const { history } = await loadHistory(mkCtx(), convId, {
      parentMessageId: leafId,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });
    const allImages = history.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "image") : [],
    );
    expect(allImages).toHaveLength(MAX_REHYDRATED_IMAGES);
  });

  // ── Smart cap: byte ceiling ────────────────────────────────────
  test("byte cap stops accumulation before MAX_REHYDRATED_IMAGES is hit", async () => {
    // Three assistants. Each produces a large image (2 MB). With a
    // byte cap of ~5 MB, we should fit exactly two — the third would
    // push cumulative bytes past the limit.
    const BIG_SIZE = 2 * 1024 * 1024;
    const bigBytes = new Uint8Array(BIG_SIZE);
    // Distinct payloads (different first byte) so the dedupe-by-path
    // set doesn't collapse them.
    for (let i = 0; i < 3; i++) bigBytes[0] = i + 1;
    const u0 = writeImage("generated/big-0.png", makeBytes(BIG_SIZE, 1));
    const u1 = writeImage("generated/big-1.png", makeBytes(BIG_SIZE, 2));
    const u2 = writeImage("generated/big-2.png", makeBytes(BIG_SIZE, 3));
    const { convId, leafId } = await seedBranch([
      { role: "user", content: "u0" },
      { role: "assistant", content: `![](${u0})` },
      { role: "user", content: "u1" },
      { role: "assistant", content: `![](${u1})` },
      { role: "user", content: "u2" },
      { role: "assistant", content: `![](${u2})` },
      { role: "user", content: "now" },
    ]);
    const { history } = await loadHistory(mkCtx(), convId, {
      parentMessageId: leafId,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });
    const allImages = history.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "image") : [],
    );
    // 2 * 2MB = 4 MB fits under 5 MB; 3 * 2 MB = 6 MB would exceed.
    expect(allImages).toHaveLength(2);
    // Verify the byte ceiling assumption still matches the production constant.
    expect(MAX_REHYDRATED_IMAGE_BYTES).toBeGreaterThanOrEqual(2 * BIG_SIZE);
    expect(MAX_REHYDRATED_IMAGE_BYTES).toBeLessThan(3 * BIG_SIZE);
  });

  // ── Smart cap: old image preserved when caps allow ─────────────
  test("an old image far back in history IS included when caps aren't hit", async () => {
    // Image at turn 1, then many text-only turns, then "final" user turn.
    const url = writeImage("generated/ancient.png", PNG_BYTES);
    const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    turns.push({ role: "user", content: "start" });
    turns.push({ role: "assistant", content: `![](${url})` });
    for (let i = 0; i < 10; i++) {
      turns.push({ role: "user", content: `chat-${i}` });
      turns.push({ role: "assistant", content: "no image here" });
    }
    turns.push({ role: "user", content: "actually, edit the original" });
    const { convId, leafId } = await seedBranch(turns);
    const { history } = await loadHistory(mkCtx(), convId, {
      parentMessageId: leafId,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });
    const allImages = history.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "image") : [],
    );
    // The old image is still there — only 1 image in the branch, well under caps.
    expect(allImages).toHaveLength(1);
    expect((allImages[0] as any).data).toBe(PNG_B64);
  });

  // ── Smart cap: cross-turn dedupe ───────────────────────────────
  test("same URL referenced in two different turns dedupes to one image", async () => {
    const url = writeImage("generated/same.png", PNG_BYTES);
    const { convId, leafId } = await seedBranch([
      { role: "user", content: "gen" },
      { role: "assistant", content: `first: ![](${url})` },
      { role: "user", content: "what do you think" },
      { role: "assistant", content: `still: ![](${url})` },
      { role: "user", content: "edit it" },
    ]);
    const { history } = await loadHistory(mkCtx(), convId, {
      parentMessageId: leafId,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });
    const allImages = history.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "image") : [],
    );
    expect(allImages).toHaveLength(1);
  });

  // ── Case 15 ─────────────────────────────────────────────────────
  test("trailing assistant with no following user: images are silently dropped", async () => {
    const url = writeImage("generated/tail.png", PNG_BYTES);
    const { convId, leafId } = await seedBranch([
      { role: "user", content: "make a thing" },
      { role: "assistant", content: `![](${url})` }, // trailing
    ]);
    const { history } = await loadHistory(mkCtx(), convId, {
      parentMessageId: leafId,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });
    expect(history).toHaveLength(2);
    // No user message receives injected images (there is none to attach to).
    const allImages = history.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "image") : [],
    );
    expect(allImages).toHaveLength(0);
  });

  test("assistant with no ext-files URLs: history is unchanged (no image parts added)", async () => {
    const { convId, leafId } = await seedBranch([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello, no images here" },
      { role: "user", content: "ok" },
    ]);
    const { history } = await loadHistory(mkCtx(), convId, {
      parentMessageId: leafId,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });
    const allImages = history.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "image") : [],
    );
    expect(allImages).toHaveLength(0);
  });

  // ── Tool-output scanning ────────────────────────────────────────
  // The extension's SKILL.md tells models NOT to echo the image URL into
  // their prose reply — the tool card renders it from the tool result
  // directly. Models following that guidance leave `messages.content`
  // URL-free, so the rehydrator must also scan `tool_calls.output`.
  test("assistant with empty text + tool output containing URL → image rehydrated", async () => {
    const url = writeImage("generated/tool-only.png", PNG_BYTES);
    const project = await createProject({ name: "ToolOnly", path: tmpRoot });
    const conv = await createConversation(project.id, { title: "t" });
    const m1 = await createMessage(conv.id, { role: "user", content: "gen" });
    // Model produced prose with no URL — perfectly fine per SKILL.md.
    const m2 = await createMessage(conv.id, { role: "assistant", content: "Done.", parentMessageId: m1.id });
    // Tool output carries the URL.
    await persistToolCall({
      conversationId: conv.id,
      messageId: m2.id,
      extensionId: testExtensionId,
      toolName: "generate",
      input: { prompt: "x" },
      output: { content: [{ type: "text", text: `Generated 1 image.\n\n![](${url})` }] },
      success: true,
      durationMs: 10,
    });
    const m3 = await createMessage(conv.id, { role: "user", content: "edit it", parentMessageId: m2.id });

    const { history } = await loadHistory(mkCtx(), conv.id, {
      parentMessageId: m3.id,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });
    const parts = partsOf((history[2] as any).content);
    const images = parts.filter((p) => p.type === "image");
    expect(images).toHaveLength(1);
    expect((images[0] as any).data).toBe(PNG_B64);
  });

  test("assistant echoes URL + same URL in tool output → deduped (one image)", async () => {
    const url = writeImage("generated/dup.png", PNG_BYTES);
    const project = await createProject({ name: "Dup", path: tmpRoot });
    const conv = await createConversation(project.id, { title: "t" });
    const m1 = await createMessage(conv.id, { role: "user", content: "gen" });
    const m2 = await createMessage(conv.id, {
      role: "assistant",
      content: `Here: ![](${url})`,
      parentMessageId: m1.id,
    });
    await persistToolCall({
      conversationId: conv.id,
      messageId: m2.id,
      extensionId: testExtensionId,
      toolName: "generate",
      input: { prompt: "x" },
      output: { content: [{ type: "text", text: `![](${url})` }] },
      success: true,
      durationMs: 10,
    });
    const m3 = await createMessage(conv.id, { role: "user", content: "edit", parentMessageId: m2.id });

    const { history } = await loadHistory(mkCtx(), conv.id, {
      parentMessageId: m3.id,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });
    const parts = partsOf((history[2] as any).content);
    expect(parts.filter((p) => p.type === "image")).toHaveLength(1);
  });

  test("multiple tool calls on one assistant → all scanned and injected", async () => {
    const u1 = writeImage("generated/tool-a.png", PNG_BYTES);
    const u2 = writeImage("generated/tool-b.png", JPG_BYTES);
    const project = await createProject({ name: "MultiTool", path: tmpRoot });
    const conv = await createConversation(project.id, { title: "t" });
    const m1 = await createMessage(conv.id, { role: "user", content: "gen two" });
    const m2 = await createMessage(conv.id, { role: "assistant", content: "", parentMessageId: m1.id });
    await persistToolCall({
      conversationId: conv.id,
      messageId: m2.id,
      extensionId: testExtensionId,
      toolName: "generate",
      input: { prompt: "a" },
      output: { content: [{ type: "text", text: `![](${u1})` }] },
      success: true,
      durationMs: 10,
    });
    await persistToolCall({
      conversationId: conv.id,
      messageId: m2.id,
      extensionId: testExtensionId,
      toolName: "generate",
      input: { prompt: "b" },
      output: { content: [{ type: "text", text: `![](${u2})` }] },
      success: true,
      durationMs: 10,
    });
    const m3 = await createMessage(conv.id, { role: "user", content: "combine", parentMessageId: m2.id });

    const { history } = await loadHistory(mkCtx(), conv.id, {
      parentMessageId: m3.id,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });
    const parts = partsOf((history[2] as any).content);
    expect(parts.filter((p) => p.type === "image")).toHaveLength(2);
  });

  test("tool call with non-image output → no-op (nothing injected)", async () => {
    const project = await createProject({ name: "NonImg", path: tmpRoot });
    const conv = await createConversation(project.id, { title: "t" });
    const m1 = await createMessage(conv.id, { role: "user", content: "run" });
    const m2 = await createMessage(conv.id, { role: "assistant", content: "done", parentMessageId: m1.id });
    await persistToolCall({
      conversationId: conv.id,
      messageId: m2.id,
      extensionId: testExtensionId,
      toolName: "search",
      input: { q: "x" },
      output: { content: [{ type: "text", text: "3 results found" }] },
      success: true,
      durationMs: 10,
    });
    const m3 = await createMessage(conv.id, { role: "user", content: "next", parentMessageId: m2.id });

    const { history } = await loadHistory(mkCtx(), conv.id, {
      parentMessageId: m3.id,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });
    const allImages = history.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "image") : [],
    );
    expect(allImages).toHaveLength(0);
  });

  test("multiple images in one assistant message: all land on the next user", async () => {
    // Distinct bytes so the dedupe-by-base64 logic doesn't collapse them.
    const a = writeImage("generated/a.png", PNG_BYTES);
    const b = writeImage("generated/b.png", JPG_BYTES);
    const { convId, leafId } = await seedBranch([
      { role: "user", content: "gen two" },
      { role: "assistant", content: `![](${a}) and ![](${b})` },
      { role: "user", content: "combine" },
    ]);
    const { history } = await loadHistory(mkCtx(), convId, {
      parentMessageId: leafId,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });
    const parts = partsOf((history[2] as any).content);
    expect(parts.filter((p) => p.type === "image")).toHaveLength(2);
  });
});
