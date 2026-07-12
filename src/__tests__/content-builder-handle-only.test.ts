import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUserContent,
  ATTACHMENT_HANDLE_SCHEME,
  attachmentHandle,
  type StagedAttachment,
} from "../chat/attachments/content-builder";
import {
  buildAttachmentHandleResolver,
  toResolvableAttachments,
} from "../chat/attachments/handle-resolver";
import { writeAttachment } from "../chat/attachments/storage";
import { getCapabilitiesWithExtensions } from "../providers/model-capabilities";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

let root: string;
let xlsxPath: string;
const SYNTH_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0xde, 0xad, 0xbe, 0xef]); // ZIP magic + filler

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ezcorp-cb-handle-"));
  xlsxPath = (await writeAttachment({
    projectRoot: root,
    conversationId: "c",
    messageId: "m",
    filename: "report.xlsx",
    mimeType: XLSX_MIME,
    bytes: SYNTH_BYTES,
  })).storagePath;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("extension-handle-only delivery strategy", () => {
  const att: StagedAttachment = {
    id: "att-xlsx-1",
    filename: "report.xlsx",
    mimeType: XLSX_MIME,
    storagePath: "", // populated in tests
  };

  test("emits a <file> block referencing the handle, NOT the bytes", async () => {
    const caps = getCapabilitiesWithExtensions("anthropic", "claude-sonnet-4-5", [XLSX_MIME]);
    const built = await buildUserContent("ingest this", [{ ...att, storagePath: xlsxPath }], caps);

    expect(Array.isArray(built)).toBe(true);
    if (!Array.isArray(built)) return;

    const fileText = built.find((p) => p.type === "text" && (p as { text: string }).text.includes("<file"));
    expect(fileText).toBeDefined();
    const text = (fileText as { type: "text"; text: string }).text;
    expect(text).toContain('name="report.xlsx"');
    expect(text).toContain(`type="${XLSX_MIME}"`);
    expect(text).toContain(attachmentHandle("att-xlsx-1"));
    // No base64-ish payload — handle-only must not embed bytes.
    expect(text.length).toBeLessThan(1000);
  });

  test("does NOT read attachment bytes from disk", async () => {
    // Point storagePath at a file that does not exist; the strategy
    // should still succeed because it never opens the file.
    const caps = getCapabilitiesWithExtensions("anthropic", "claude-sonnet-4-5", [XLSX_MIME]);
    const built = await buildUserContent(
      "no bytes please",
      [{ ...att, storagePath: "/definitely/does/not/exist.xlsx" }],
      caps,
    );
    expect(Array.isArray(built)).toBe(true);
  });

  test("rejects MIMEs not in the static OR extension allowlist", async () => {
    const caps = getCapabilitiesWithExtensions("anthropic", "claude-sonnet-4-5", [XLSX_MIME]);
    let caught: unknown;
    try {
      await buildUserContent("x", [{ ...att, mimeType: "application/x-rejected", storagePath: xlsxPath }], caps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
  });
});

describe("handle-resolver round-trip with extension-handle attachment", () => {
  test("rewrites ez-attachment://<id> in tool args to a data URI", async () => {
    const att: StagedAttachment = {
      id: "att-xlsx-2",
      filename: "data.xlsx",
      mimeType: XLSX_MIME,
      storagePath: xlsxPath,
    };
    const resolve = buildAttachmentHandleResolver(toResolvableAttachments([att]));
    const handle = `${ATTACHMENT_HANDLE_SCHEME}att-xlsx-2`;
    const resolved = await resolve({ source: handle, mode: "manifest" });
    expect((resolved.source as string).startsWith(`data:${XLSX_MIME};base64,`)).toBe(true);
    // Mode parameter must pass through unchanged.
    expect(resolved.mode).toBe("manifest");
  });

  test("unknown handle is left verbatim so the tool can return its own error", async () => {
    const resolve = buildAttachmentHandleResolver(
      toResolvableAttachments([
        { id: "known", filename: "a.xlsx", mimeType: XLSX_MIME, storagePath: xlsxPath },
      ]),
    );
    const result = await resolve({ source: `${ATTACHMENT_HANDLE_SCHEME}unknown-id` });
    expect(result.source).toBe(`${ATTACHMENT_HANDLE_SCHEME}unknown-id`);
  });
});
