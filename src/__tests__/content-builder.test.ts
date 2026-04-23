import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildUserContent,
  UnsupportedAttachmentError,
  type StagedAttachment,
} from "../chat/attachments/content-builder";
import { writeAttachment } from "../chat/attachments/storage";
import { getCapabilities } from "../providers/model-capabilities";

const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

function buildMinimalPdf(text: string): Uint8Array {
  const enc = new TextEncoder();
  const parts: Uint8Array[] = [];
  const offsets: number[] = [];
  let pos = 0;
  const push = (s: string) => { const b = enc.encode(s); parts.push(b); pos += b.byteLength; };
  push("%PDF-1.4\n");
  offsets[1] = pos; push("1 0 obj\n<</Type/Catalog/Pages 2 0 R>>\nendobj\n");
  offsets[2] = pos; push("2 0 obj\n<</Type/Pages/Kids[3 0 R]/Count 1>>\nendobj\n");
  offsets[3] = pos; push("3 0 obj\n<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>\nendobj\n");
  const stream = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET\n`;
  offsets[4] = pos; push(`4 0 obj\n<</Length ${stream.length}>>\nstream\n${stream}endstream\nendobj\n`);
  offsets[5] = pos; push("5 0 obj\n<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>\nendobj\n");
  const xrefPos = pos;
  push("xref\n0 6\n0000000000 65535 f \n");
  for (let i = 1; i <= 5; i++) push(String(offsets[i]).padStart(10, "0") + " 00000 n \n");
  push(`trailer\n<</Size 6/Root 1 0 R>>\nstartxref\n${xrefPos}\n%%EOF\n`);
  const total = parts.reduce((n, b) => n + b.byteLength, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const b of parts) { out.set(b, o); o += b.byteLength; }
  return out;
}

let root: string;
let pngPath: string;
let txtPath: string;
let pdfPath: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "ezcorp-cb-"));
  pngPath = (await writeAttachment({
    projectRoot: root, conversationId: "c", messageId: "m",
    filename: "cat.png", mimeType: "image/png", bytes: PNG_1x1,
  })).storagePath;
  txtPath = (await writeAttachment({
    projectRoot: root, conversationId: "c", messageId: "m",
    filename: "readme.txt", mimeType: "text/plain",
    bytes: new TextEncoder().encode("hello file"),
  })).storagePath;
  pdfPath = (await writeAttachment({
    projectRoot: root, conversationId: "c", messageId: "m",
    filename: "doc.pdf", mimeType: "application/pdf",
    bytes: buildMinimalPdf("PDF body"),
  })).storagePath;
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true }).catch(() => {});
});

describe("buildUserContent", () => {
  const vision = getCapabilities("anthropic", "claude-3-5-sonnet-20241022");
  const textOnly = getCapabilities("my-custom-provider", "local");

  test("no attachments → returns plain string (back-compat)", async () => {
    const out = await buildUserContent("just words", [], vision);
    expect(out).toBe("just words");
  });

  test("image on vision model → ImageContent with base64 + mimeType + handle ref block", async () => {
    const att: StagedAttachment = { id: "att-cat", filename: "cat.png", mimeType: "image/png", storagePath: pngPath };
    const out = await buildUserContent("look", [att], vision);
    expect(Array.isArray(out)).toBe(true);
    const parts = out as any[];
    expect(parts[0]).toEqual({ type: "text", text: "look" });
    expect(parts[1].type).toBe("image");
    expect(parts[1].mimeType).toBe("image/png");
    expect(parts[1].data).toBe(Buffer.from(PNG_1x1).toString("base64"));
    // Trailing text part exposes a short opaque handle (not raw bytes) so
    // the context stays cheap; the executor resolves it at tool-dispatch time.
    expect(parts[2].type).toBe("text");
    expect(parts[2].text).toContain(`handle="ez-attachment://att-cat"`);
    expect(parts[2].text).not.toContain("data:image/png;base64,");
  });

  test("text file → TextContent with <file name=...> wrapper", async () => {
    const att: StagedAttachment = { id: "att-txt", filename: "readme.txt", mimeType: "text/plain", storagePath: txtPath };
    const out = await buildUserContent("", [att], vision);
    expect(Array.isArray(out)).toBe(true);
    const parts = out as any[];
    expect(parts.length).toBe(1);
    expect(parts[0].type).toBe("text");
    expect(parts[0].text).toContain(`<file name="readme.txt" type="text/plain">`);
    expect(parts[0].text).toContain("hello file");
  });

  test("PDF → TextContent with extracted text wrapped", async () => {
    const att: StagedAttachment = { id: "att-pdf", filename: "doc.pdf", mimeType: "application/pdf", storagePath: pdfPath };
    const out = await buildUserContent("summarize", [att], textOnly);
    const parts = out as any[];
    expect(parts[0]).toEqual({ type: "text", text: "summarize" });
    expect(parts[1].type).toBe("text");
    expect(parts[1].text).toContain(`<file name="doc.pdf" type="application/pdf">`);
    expect(parts[1].text).toContain("PDF body");
  });

  test("image on non-vision model → UnsupportedAttachmentError", async () => {
    const att: StagedAttachment = { id: "att-cat", filename: "cat.png", mimeType: "image/png", storagePath: pngPath };
    let err: any;
    try { await buildUserContent("x", [att], textOnly); } catch (e) { err = e; }
    expect(err).toBeInstanceOf(UnsupportedAttachmentError);
    expect(err.code).toBe("UNSUPPORTED_ATTACHMENT");
    expect(err.filename).toBe("cat.png");
  });

  test("multiple attachments are preserved in order after the text part", async () => {
    const a: StagedAttachment = { id: "att-cat", filename: "cat.png", mimeType: "image/png", storagePath: pngPath };
    const b: StagedAttachment = { id: "att-txt", filename: "readme.txt", mimeType: "text/plain", storagePath: txtPath };
    const out = await buildUserContent("caption", [a, b], vision);
    const parts = out as any[];
    // text + image + text-file wrapper + handle ref block
    expect(parts.length).toBe(4);
    expect(parts[0].type).toBe("text");
    expect(parts[1].type).toBe("image");
    expect(parts[2].type).toBe("text");
    expect(parts[2].text).toContain("hello file");
    expect(parts[3].type).toBe("text");
    expect(parts[3].text).toContain(`handle="ez-attachment://att-cat"`);
  });

  test("multiple images each get their own indexed entry in the ref block", async () => {
    const a: StagedAttachment = { id: "att-cow", filename: "cow.png", mimeType: "image/png", storagePath: pngPath };
    const b: StagedAttachment = { id: "att-man", filename: "man.png", mimeType: "image/png", storagePath: pngPath };
    const out = await buildUserContent("replace farmer with man", [a, b], vision);
    const parts = out as any[];
    // text + 2 images + handle ref block
    expect(parts.length).toBe(4);
    const refs = parts[3].text as string;
    expect(refs).toContain(`index="1" filename="cow.png" mimeType="image/png" handle="ez-attachment://att-cow"`);
    expect(refs).toContain(`index="2" filename="man.png" mimeType="image/png" handle="ez-attachment://att-man"`);
    // Ref block is short — no inline base64 payloads.
    expect(refs).not.toContain("data:image/png;base64,");
  });

  test("text/PDF-only attachments do not emit a ref block", async () => {
    const att: StagedAttachment = { id: "att-txt", filename: "readme.txt", mimeType: "text/plain", storagePath: txtPath };
    const out = await buildUserContent("parse", [att], vision);
    const parts = out as any[];
    expect(parts.length).toBe(2);
    expect(parts[0].type).toBe("text");
    expect(parts[1].text).toContain("hello file");
    expect(parts[1].text).not.toContain("<attachment");
  });

  test("images-only, no user text → parts are image + ref block", async () => {
    const att: StagedAttachment = { id: "att-lone", filename: "cat.png", mimeType: "image/png", storagePath: pngPath };
    const out = await buildUserContent("", [att], vision);
    const parts = out as any[];
    expect(parts.length).toBe(2);
    expect(parts[0].type).toBe("image");
    expect(parts[1].type).toBe("text");
    expect(parts[1].text).toContain(`handle="ez-attachment://att-lone"`);
  });

  test("filename containing a double quote is escaped to single quote in the ref block", async () => {
    const att: StagedAttachment = { id: "att-q", filename: `weird"name".png`, mimeType: "image/png", storagePath: pngPath };
    const out = await buildUserContent("x", [att], vision);
    const parts = out as any[];
    const refs = parts[2].text as string;
    // The attribute value is wrapped in "...", so embedded " is replaced with '.
    expect(refs).toContain(`filename="weird'name'.png"`);
    expect(refs).not.toContain(`weird"name"`);
  });

  test("PDF + image mix emits PDF text wrapper separately and the image-only ref block", async () => {
    const img: StagedAttachment = { id: "att-img", filename: "cat.png", mimeType: "image/png", storagePath: pngPath };
    const pdf: StagedAttachment = { id: "att-pdf", filename: "doc.pdf", mimeType: "application/pdf", storagePath: pdfPath };
    const out = await buildUserContent("look", [img, pdf], vision);
    const parts = out as any[];
    // text + image + pdf-wrapper + ref block (images only)
    expect(parts.length).toBe(4);
    expect(parts[0].type).toBe("text");
    expect(parts[1].type).toBe("image");
    expect(parts[2].type).toBe("text");
    expect(parts[2].text).toContain(`<file name="doc.pdf"`);
    expect(parts[3].type).toBe("text");
    expect(parts[3].text).toContain(`handle="ez-attachment://att-img"`);
    expect(parts[3].text).not.toContain("att-pdf");
  });

  test("filename containing XML metacharacters keeps the ref tag well-formed", async () => {
    const att: StagedAttachment = {
      id: "att-xml",
      filename: `inject"><script>alert(1)</script>.png`,
      mimeType: "image/png",
      storagePath: pngPath,
    };
    const out = await buildUserContent("x", [att], vision);
    const refs = (out as any[])[2].text as string;
    // Exactly one ref tag emitted.
    expect((refs.match(/<attachment /g) ?? []).length).toBe(1);
    expect((refs.match(/\/>/g) ?? []).length).toBe(1);
    // The filename attribute value contains no raw `"` (would break the
    // attribute's own wrapping quotes). Our escape maps `"` to `'`.
    const filenameMatch = /filename="([^"]*)"/.exec(refs);
    expect(filenameMatch).not.toBeNull();
    expect(filenameMatch![1]).not.toContain(`"`);
    expect(filenameMatch![1]).toContain(`inject'>`); // `"` → `'` was applied
  });

  test("handle index increments across images even if non-image attachments are mixed in", async () => {
    const img1: StagedAttachment = { id: "att-1", filename: "a.png", mimeType: "image/png", storagePath: pngPath };
    const txt: StagedAttachment = { id: "att-txt2", filename: "notes.txt", mimeType: "text/plain", storagePath: txtPath };
    const img2: StagedAttachment = { id: "att-2", filename: "b.png", mimeType: "image/png", storagePath: pngPath };
    const out = await buildUserContent("", [img1, txt, img2], vision);
    const parts = out as any[];
    const refs = parts[parts.length - 1].text as string;
    expect(refs).toContain(`index="1" filename="a.png"`);
    expect(refs).toContain(`index="2" filename="b.png"`);
    // No reference to text file handle.
    expect(refs).not.toContain("att-txt2");
  });
});
