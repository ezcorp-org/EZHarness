/**
 * Integration tests for `buildPromptInput` in
 * src/runtime/stream-chat/build-prompt.ts.
 *
 * Covers the three independent expansion phases (slash-command,
 * file-mention prepend, attachment lift) plus the non-fatal catch
 * blocks that gracefully degrade. Specifically guards the recently-
 * added extension-MIME overlay (lines 79–84) by stubbing
 * `getConversationExtensionMimes` to verify those MIMEs are unioned
 * into the capability check via `getCapabilitiesWithExtensions`.
 */
import { test, expect, describe, beforeAll, afterAll, mock } from "bun:test";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { restoreModuleMocks } from "./helpers/mock-cleanup";

afterAll(() => restoreModuleMocks());

import { writeAttachment } from "../chat/attachments/storage";
import type { StagedAttachment } from "../chat/attachments/content-builder";
import type { CommandResolver } from "../runtime/mention-wiring";

// ─── Mocks ─────────────────────────────────────────────────────────
//
// `buildPromptInput` calls into:
//   - `getProject(projectId)` from db/queries/projects
//   - `getConversationExtensionMimes(conversationId)` from
//     db/queries/conversation-extensions
// We stub both at module level so we don't need a real DB. Both stubs
// are mutated per-test via the wrapper helpers below.

let mockProject: { id: string; path: string } | undefined;
let projectShouldThrow = false;
mock.module("../db/queries/projects", () => ({
  getProject: async (id: string) => {
    if (projectShouldThrow) throw new Error("boom-project");
    if (!mockProject || mockProject.id !== id) return undefined;
    return mockProject;
  },
}));

let mockExtensionMimes: string[] = [];
let extMimesShouldThrow = false;
mock.module("../db/queries/conversation-extensions", () => ({
  getConversationExtensionMimes: async (_convId: string) => {
    if (extMimesShouldThrow) throw new Error("boom-ext-mimes");
    return mockExtensionMimes;
  },
}));

// Import AFTER the mocks are registered so the dynamic `await import()`
// inside buildPromptInput resolves to our stubs.
import { buildPromptInput } from "../runtime/stream-chat/build-prompt";

// ─── Test fixtures ────────────────────────────────────────────────

const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
  0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
  0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
]);

const XLSX_MIME =
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

let projectRoot: string;
let pngStoragePath: string;
let xlsxStoragePath: string;

beforeAll(async () => {
  projectRoot = await mkdtemp(join(tmpdir(), "build-prompt-int-"));
  // Real on-disk file referenced by @[file:foo.ts] mentions.
  await writeFile(join(projectRoot, "foo.ts"), "// foo\n");

  // Write attachment bytes into the canonical storage layout so
  // content-builder can read them back via `readAttachmentBytes`.
  pngStoragePath = (
    await writeAttachment({
      projectRoot,
      conversationId: "c-test",
      messageId: "m-test",
      filename: "cat.png",
      mimeType: "image/png",
      bytes: PNG_1x1,
    })
  ).storagePath;

  xlsxStoragePath = (
    await writeAttachment({
      projectRoot,
      conversationId: "c-test",
      messageId: "m-test",
      filename: "report.xlsx",
      mimeType: XLSX_MIME,
      bytes: new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad]),
    })
  ).storagePath;

  // Default project record — overridden by individual tests if needed.
  mockProject = { id: "proj-1", path: projectRoot };
});

afterAll(async () => {
  await rm(projectRoot, { recursive: true, force: true }).catch(() => {});
});

// ─── 1. Plain text ─────────────────────────────────────────────────

describe("buildPromptInput — plain text", () => {
  test("no mentions, no attachments → text passes through unchanged", async () => {
    const result = await buildPromptInput("just a normal message", {});
    expect(result.text).toBe("just a normal message");
    expect(result.images).toEqual([]);
  });
});

// ─── 2. Slash-command expansion ────────────────────────────────────

describe("buildPromptInput — slash-command expansion", () => {
  test("/[cmd:foo] is replaced with the command body", async () => {
    const resolver: CommandResolver = async (name) => {
      if (name === "foo") return { body: "EXPANDED FOO BODY" };
      return null;
    };
    const result = await buildPromptInput("hello /[cmd:foo]", {
      commandResolver: resolver,
    });
    expect(result.text).toContain("EXPANDED FOO BODY");
    expect(result.text).not.toContain("/[cmd:foo]");
    expect(result.images).toEqual([]);
  });
});

// ─── 3. File mention ───────────────────────────────────────────────

describe("buildPromptInput — file mention", () => {
  test("@[file:relpath] is prepended as a system note", async () => {
    mockProject = { id: "proj-1", path: projectRoot };
    projectShouldThrow = false;

    const result = await buildPromptInput(
      "look at @[file:foo.ts] for me",
      { projectId: "proj-1" },
    );
    // The system note is prepended; the original text follows after a
    // blank line.
    expect(result.text).toContain("[User referenced file: foo.ts");
    expect(result.text).toContain("look at @[file:foo.ts] for me");
    expect(result.text.indexOf("[User referenced file:")).toBeLessThan(
      result.text.indexOf("look at"),
    );
    expect(result.images).toEqual([]);
  });

  test("missing projectId → file mention is left as-is", async () => {
    const result = await buildPromptInput("look at @[file:foo.ts]", {});
    expect(result.text).toBe("look at @[file:foo.ts]");
  });
});

// ─── 4. Attachment-only ───────────────────────────────────────────

describe("buildPromptInput — image attachment", () => {
  test("image attachment on a vision model produces a native ImageContent", async () => {
    mockExtensionMimes = [];
    extMimesShouldThrow = false;

    const att: StagedAttachment = {
      id: "att-img-1",
      filename: "cat.png",
      mimeType: "image/png",
      storagePath: pngStoragePath,
    };
    const result = await buildPromptInput("describe this", {
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      attachments: [att],
    });
    expect(result.images).toHaveLength(1);
    expect(result.images[0]!.mimeType).toBe("image/png");
    expect(result.images[0]!.data).toBe(
      Buffer.from(PNG_1x1).toString("base64"),
    );
    // Text part still includes the user prompt and the attachment ref block.
    expect(result.text).toContain("describe this");
    expect(result.text).toContain("ez-attachment://att-img-1");
  });
});

// ─── 5. Combined: command + file + attachment ─────────────────────

describe("buildPromptInput — combined cmd + file + attachment", () => {
  test("all three merge correctly with no duplication", async () => {
    mockProject = { id: "proj-1", path: projectRoot };
    projectShouldThrow = false;
    mockExtensionMimes = [];

    const resolver: CommandResolver = async (name) =>
      name === "greet" ? { body: "BODY-GREET" } : null;

    const att: StagedAttachment = {
      id: "att-combo-1",
      filename: "cat.png",
      mimeType: "image/png",
      storagePath: pngStoragePath,
    };

    const result = await buildPromptInput(
      "/[cmd:greet] please look at @[file:foo.ts]",
      {
        projectId: "proj-1",
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        attachments: [att],
        commandResolver: resolver,
      },
    );

    // Command body is substituted exactly once.
    expect(result.text).toContain("BODY-GREET");
    expect((result.text.match(/BODY-GREET/g) ?? []).length).toBe(1);
    // The raw command token is gone post-expansion.
    expect(result.text).not.toContain("/[cmd:greet]");
    // File-mention system note is prepended.
    expect(result.text).toContain("[User referenced file: foo.ts");
    // Image was lifted to the images array.
    expect(result.images).toHaveLength(1);
    // Attachment handle ref block is present in text.
    expect(result.text).toContain("ez-attachment://att-combo-1");
  });
});

// ─── 6. Non-fatal: command resolver throws ────────────────────────

describe("buildPromptInput — non-fatal failures", () => {
  test("commandResolver throwing leaves the raw token in place", async () => {
    const throwing: CommandResolver = async () => {
      throw new Error("resolver-blew-up");
    };
    const result = await buildPromptInput("hi /[cmd:foo] there", {
      commandResolver: throwing,
    });
    // The catch swallows, so text equals the raw user message.
    expect(result.text).toBe("hi /[cmd:foo] there");
    expect(result.images).toEqual([]);
  });

  test("file-mention resolution failure is non-fatal — text still builds", async () => {
    // Force getProject to throw — simulates a DB connection blip.
    projectShouldThrow = true;
    try {
      const result = await buildPromptInput("see @[file:foo.ts]", {
        projectId: "proj-1",
      });
      // Catch swallows; the raw user message is preserved.
      expect(result.text).toBe("see @[file:foo.ts]");
      expect(result.images).toEqual([]);
    } finally {
      projectShouldThrow = false;
    }
  });

  test("getConversationExtensionMimes throwing is non-fatal — falls back to base caps", async () => {
    extMimesShouldThrow = true;
    try {
      const att: StagedAttachment = {
        id: "att-fallback",
        filename: "cat.png",
        mimeType: "image/png",
        storagePath: pngStoragePath,
      };
      const result = await buildPromptInput("hello", {
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        conversationId: "c-test",
        attachments: [att],
      });
      // Image still flows through using base capabilities.
      expect(result.images).toHaveLength(1);
      expect(result.images[0]!.mimeType).toBe("image/png");
    } finally {
      extMimesShouldThrow = false;
    }
  });
});

// ─── 7. Extension MIME overlay (build-prompt.ts:79–84) ─────────────

describe("buildPromptInput — extension MIME overlay", () => {
  test("conversation-wired extension MIMEs extend the accepted set", async () => {
    // Without the overlay, an .xlsx attachment on Anthropic Claude would
    // throw UnsupportedAttachmentError (xlsx is NOT in the static
    // capability table). With the overlay, it routes through the
    // extension-handle-only delivery strategy and the text passes
    // through with a <file> wrapper containing the handle.
    mockExtensionMimes = [XLSX_MIME];
    extMimesShouldThrow = false;

    const att: StagedAttachment = {
      id: "att-xlsx",
      filename: "report.xlsx",
      mimeType: XLSX_MIME,
      storagePath: xlsxStoragePath,
    };
    const result = await buildPromptInput("ingest this sheet", {
      provider: "anthropic",
      model: "claude-3-5-sonnet-20241022",
      conversationId: "c-test",
      attachments: [att],
    });

    // No native image — xlsx routes through extension-handle-only.
    expect(result.images).toEqual([]);
    // The <file> wrapper is in the text and references the handle, NOT
    // the raw bytes.
    expect(result.text).toContain('name="report.xlsx"');
    expect(result.text).toContain(`type="${XLSX_MIME}"`);
    expect(result.text).toContain("ez-attachment://att-xlsx");
    expect(result.text).toContain("ingest this sheet");
  });

  test("without conversationId, extension overlay is skipped — xlsx is rejected", async () => {
    // Sanity check: the overlay only kicks in when conversationId is
    // provided. Without it, xlsx falls through the static caps and
    // buildUserContent throws UnsupportedAttachmentError.
    mockExtensionMimes = [XLSX_MIME];
    const att: StagedAttachment = {
      id: "att-xlsx-noconv",
      filename: "report.xlsx",
      mimeType: XLSX_MIME,
      storagePath: xlsxStoragePath,
    };
    let caught: unknown;
    try {
      await buildPromptInput("hi", {
        provider: "anthropic",
        model: "claude-3-5-sonnet-20241022",
        // no conversationId
        attachments: [att],
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect(String((caught as Error).message)).toContain("not supported");
  });
});
