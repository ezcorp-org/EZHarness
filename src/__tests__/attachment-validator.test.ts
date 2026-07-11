import { test, expect, describe } from "bun:test";
import { validateAttachment } from "../chat/attachments/validator";
import { getCapabilities } from "../providers/model-capabilities";

// Smallest valid PNG: 1×1 transparent.
const PNG_1x1 = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4,
  0x89, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0x00, 0x01, 0x00, 0x00,
  0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae,
  0x42, 0x60, 0x82,
]);

// A minimal "%PDF-1.4" header is enough for file-type to detect application/pdf.
const PDF_HEADER = new TextEncoder().encode("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n");

describe("validateAttachment", () => {
  const claude = getCapabilities("anthropic", "claude-sonnet-4-5");
  const textOnly = getCapabilities("my-custom-provider", "local");

  test("accepts a real PNG on a vision model", async () => {
    const res = await validateAttachment(PNG_1x1, "image/png", claude);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.canonicalMime).toBe("image/png");
  });

  test("rejects PNG on a text-only model: MIME_NOT_ALLOWED", async () => {
    const res = await validateAttachment(PNG_1x1, "image/png", textOnly);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("MIME_NOT_ALLOWED");
  });

  test("rejects oversized file: TOO_LARGE", async () => {
    const big = new Uint8Array(claude.maxBytesPerFile + 1);
    big.set(PNG_1x1, 0);
    const res = await validateAttachment(big, "image/png", claude);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("TOO_LARGE");
  });

  test("rejects MIME/magic mismatch: claims image/png but bytes are PDF", async () => {
    const res = await validateAttachment(PDF_HEADER, "image/png", claude);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("MIME_MISMATCH");
  });

  test("accepts plain-text file when bytes decode as UTF-8", async () => {
    const txt = new TextEncoder().encode("hello world\n");
    const res = await validateAttachment(txt, "text/plain", claude);
    expect(res.ok).toBe(true);
  });

  test("rejects text/plain with non-UTF-8 bytes", async () => {
    const bad = new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0xc0]);
    const res = await validateAttachment(bad, "text/plain", claude);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("NOT_UTF8");
  });

  test("accepts a real PDF on any model (pdf is always text-extracted)", async () => {
    const res = await validateAttachment(PDF_HEADER, "application/pdf", textOnly);
    expect(res.ok).toBe(true);
  });
});
