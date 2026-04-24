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
  pickAssistantIndicesToRehydrate,
  findNextUserIndex,
  ASSISTANT_IMAGE_REHYDRATE_MAX,
} from "../runtime/stream-chat/load-history";
import { createProject } from "../db/queries/projects";
import { createConversation, createMessage } from "../db/queries/conversations";
import type { StreamChatContext } from "../runtime/stream-chat/context";

const EXT = "openai-image-gen-2";
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");

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

beforeAll(async () => {
  await setupTestDb();
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

// ── Pure-function cap coverage ──────────────────────────────────────
describe("pickAssistantIndicesToRehydrate", () => {
  test("picks the last N assistant indices", () => {
    const branch = [
      { role: "user" },
      { role: "assistant" }, // idx 1
      { role: "user" },
      { role: "assistant" }, // idx 3
      { role: "user" },
      { role: "assistant" }, // idx 5
      { role: "user" },
      { role: "assistant" }, // idx 7
    ];
    expect(Array.from(pickAssistantIndicesToRehydrate(branch, 3)).sort((a, b) => a - b)).toEqual([3, 5, 7]);
  });

  test("max=0 → empty set (no rehydration)", () => {
    const branch = [{ role: "assistant" }, { role: "user" }];
    expect(pickAssistantIndicesToRehydrate(branch, 0).size).toBe(0);
  });

  test("fewer assistants than max → returns all of them", () => {
    const branch = [{ role: "user" }, { role: "assistant" }, { role: "user" }];
    expect(Array.from(pickAssistantIndicesToRehydrate(branch, 5))).toEqual([1]);
  });

  test("empty branch → empty set", () => {
    expect(pickAssistantIndicesToRehydrate([], 3).size).toBe(0);
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

  // ── Case 14 ─────────────────────────────────────────────────────
  test("last-N cap excludes assistants older than N", async () => {
    // Generate N+2 assistants; only the last N should get rehydrated.
    const oldUrl = writeImage("generated/old.png", PNG_BYTES);
    const freshUrl = writeImage("generated/fresh.png", PNG_BYTES);

    // Assistants beyond the cap: write distinct filler images so we can
    // later assert they did NOT appear in the injected list.
    const turns: Array<{ role: "user" | "assistant"; content: string }> = [];
    // Old (outside cap) — position 1
    turns.push({ role: "user", content: "u-old-1" });
    turns.push({ role: "assistant", content: `![](${oldUrl})` });
    turns.push({ role: "user", content: "u-old-2" });
    // Fill until the cap boundary by alternating
    for (let i = 0; i < ASSISTANT_IMAGE_REHYDRATE_MAX; i++) {
      turns.push({ role: "assistant", content: `![](${freshUrl})` });
      turns.push({ role: "user", content: `u-fresh-${i}` });
    }

    const { convId, leafId } = await seedBranch(turns);
    const { history } = await loadHistory(mkCtx(), convId, {
      parentMessageId: leafId,
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
    });

    // Collect image parts across every user message.
    const allImages = history.flatMap((m: any) =>
      Array.isArray(m.content) ? m.content.filter((p: any) => p.type === "image") : [],
    );
    // Exactly ASSISTANT_IMAGE_REHYDRATE_MAX images — the oldest assistant
    // at turn 1 was excluded by the cap.
    expect(allImages).toHaveLength(ASSISTANT_IMAGE_REHYDRATE_MAX);
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

  test("multiple images in one assistant message: all land on the next user", async () => {
    const a = writeImage("generated/a.png", PNG_BYTES);
    const b = writeImage("generated/b.png", PNG_BYTES);
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
