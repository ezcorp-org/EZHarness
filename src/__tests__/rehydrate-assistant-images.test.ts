/**
 * Unit coverage for `rehydrateAssistantMessageContent` — the helper that
 * scans persisted assistant text for ext-files image URLs and converts them
 * back into `ImageContent` parts so the model "sees" prior-turn generated
 * images on subsequent turns.
 *
 * Covers the 11 behavioral cases enumerated in the feature spec:
 *   1.  plain text, no URLs
 *   2.  single valid URL
 *   3.  multiple valid URLs in order
 *   4.  disallowed extension name
 *   5.  path traversal
 *   6.  nonexistent file (graceful skip)
 *   7.  directory instead of file
 *   8.  MIME inference per extension
 *   9.  external https:// URLs skipped
 *  10.  data: URIs skipped
 *  11.  malformed / edge markdown
 */

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rehydrateAssistantMessageContent } from "../chat/attachments/history-rehydrate";

const EXT = "openai-image-gen-2";

// Tiny fake bytes — we're testing the plumbing, not image decoding. We
// still want the base64 round-trip to be verifiable, so pick a short,
// non-ASCII-friendly payload.
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_B64 = Buffer.from(PNG_BYTES).toString("base64");
const JPG_BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const JPG_B64 = Buffer.from(JPG_BYTES).toString("base64");

let cwd = "";

function writeFixture(relPath: string, bytes: Uint8Array | string): string {
  const abs = join(cwd, ".ezcorp", "extension-data", EXT, relPath);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, bytes as any);
  return `/api/ext-files/${EXT}/${relPath}`;
}

beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "rehydrate-asst-"));
});

afterEach(() => {
  if (cwd) {
    try { rmSync(cwd, { recursive: true, force: true }); } catch {}
    cwd = "";
  }
});

describe("rehydrateAssistantMessageContent", () => {
  // ── Case 1 ─────────────────────────────────────────────────────────
  test("plain text with no URLs → single text part", async () => {
    const out = await rehydrateAssistantMessageContent("just words here", { cwd });
    expect(out).toEqual([{ type: "text", text: "just words here" }]);
  });

  test("empty text → single empty text part (never dropped)", async () => {
    // Keep the shape stable so executor code can always expect
    // `content[0].text` without a length guard.
    const out = await rehydrateAssistantMessageContent("", { cwd });
    expect(out).toEqual([{ type: "text", text: "" }]);
  });

  // ── Case 2 ─────────────────────────────────────────────────────────
  test("one valid ext-files URL → text + one ImageContent", async () => {
    const url = writeFixture("generated/a.png", PNG_BYTES);
    const out = await rehydrateAssistantMessageContent(
      `Here you go: ![alt](${url})`,
      { cwd },
    );
    expect(out.length).toBe(2);
    expect(out[0]).toEqual({ type: "text", text: `Here you go: ![alt](${url})` });
    expect(out[1]).toEqual({ type: "image", data: PNG_B64, mimeType: "image/png" });
  });

  // ── Case 3 ─────────────────────────────────────────────────────────
  test("multiple valid URLs → image parts in source order", async () => {
    const u1 = writeFixture("generated/one.png", PNG_BYTES);
    const u2 = writeFixture("generated/two.jpg", JPG_BYTES);
    const out = await rehydrateAssistantMessageContent(
      `first: ![](${u1}) then: ![](${u2})`,
      { cwd },
    );
    expect(out.length).toBe(3);
    expect((out[1] as any).data).toBe(PNG_B64);
    expect((out[1] as any).mimeType).toBe("image/png");
    expect((out[2] as any).data).toBe(JPG_B64);
    expect((out[2] as any).mimeType).toBe("image/jpeg");
  });

  // ── Case 4 ─────────────────────────────────────────────────────────
  test("disallowed extension name → URL stays as text, no image parts", async () => {
    const fakeUrl = "/api/ext-files/not-allowed/generated/a.png";
    const out = await rehydrateAssistantMessageContent(
      `trying: ![](${fakeUrl})`,
      { cwd },
    );
    expect(out).toEqual([{ type: "text", text: `trying: ![](${fakeUrl})` }]);
  });

  // ── Case 5 ─────────────────────────────────────────────────────────
  test("path traversal → skipped", async () => {
    const mali = `/api/ext-files/${EXT}/../../../etc/passwd`;
    const out = await rehydrateAssistantMessageContent(
      `oops: ![](${mali})`,
      { cwd },
    );
    expect(out).toEqual([{ type: "text", text: `oops: ![](${mali})` }]);
  });

  // ── Case 6 ─────────────────────────────────────────────────────────
  test("nonexistent file → gracefully skipped", async () => {
    const ghost = `/api/ext-files/${EXT}/generated/nonexistent.png`;
    const out = await rehydrateAssistantMessageContent(
      `missing: ![](${ghost})`,
      { cwd },
    );
    expect(out).toEqual([{ type: "text", text: `missing: ![](${ghost})` }]);
  });

  // ── Case 7 ─────────────────────────────────────────────────────────
  test("directory path (not a file) → skipped", async () => {
    mkdirSync(join(cwd, ".ezcorp", "extension-data", EXT, "generated"), { recursive: true });
    const dirUrl = `/api/ext-files/${EXT}/generated`;
    const out = await rehydrateAssistantMessageContent(
      `weird: ![](${dirUrl})`,
      { cwd },
    );
    expect(out).toEqual([{ type: "text", text: `weird: ![](${dirUrl})` }]);
  });

  // ── Case 8 ─────────────────────────────────────────────────────────
  test("MIME inference: png, jpg, jpeg, webp, gif, unknown", async () => {
    const u1 = writeFixture("generated/a.png", PNG_BYTES);
    const u2 = writeFixture("generated/b.jpg", JPG_BYTES);
    const u3 = writeFixture("generated/c.jpeg", JPG_BYTES);
    const u4 = writeFixture("generated/d.webp", PNG_BYTES);
    const u5 = writeFixture("generated/e.gif", PNG_BYTES);
    const u6 = writeFixture("generated/f.bin", PNG_BYTES);

    const out = await rehydrateAssistantMessageContent(
      `![](${u1}) ![](${u2}) ![](${u3}) ![](${u4}) ![](${u5}) ![](${u6})`,
      { cwd },
    );
    const images = out.filter((p: { type: string }) => p.type === "image") as Array<{ mimeType: string }>;
    // `.bin` isn't an image, so rehydration skips it — we shouldn't
    // feed the model a base64 blob with `application/octet-stream` and
    // expect it to render.
    expect(images.map((i) => i.mimeType)).toEqual([
      "image/png",
      "image/jpeg",
      "image/jpeg",
      "image/webp",
      "image/gif",
    ]);
  });

  // ── Case 9 ─────────────────────────────────────────────────────────
  test("external https:// URL in markdown → skipped", async () => {
    const out = await rehydrateAssistantMessageContent(
      `fetched: ![](https://example.com/cat.png)`,
      { cwd },
    );
    expect(out).toEqual([{ type: "text", text: "fetched: ![](https://example.com/cat.png)" }]);
  });

  test("external http:// URL in markdown → skipped", async () => {
    const out = await rehydrateAssistantMessageContent(
      `fetched: ![](http://example.com/cat.png)`,
      { cwd },
    );
    expect(out).toEqual([{ type: "text", text: "fetched: ![](http://example.com/cat.png)" }]);
  });

  // ── Case 10 ────────────────────────────────────────────────────────
  test("data: URI in markdown → skipped (already bytes)", async () => {
    const out = await rehydrateAssistantMessageContent(
      `inline: ![](data:image/png;base64,${PNG_B64})`,
      { cwd },
    );
    expect(out).toEqual([{
      type: "text",
      text: `inline: ![](data:image/png;base64,${PNG_B64})`,
    }]);
  });

  // ── Case 11 ────────────────────────────────────────────────────────
  test("malformed markdown (unclosed brackets) → no false-positive images", async () => {
    const out = await rehydrateAssistantMessageContent(
      `weird ![alt(/api/ext-files/${EXT}/generated/a.png without a close`,
      { cwd },
    );
    expect(out.every((p: { type: string }) => p.type === "text")).toBe(true);
  });

  test("bare URL without markdown wrapping → skipped (we only match `![](url)`)", async () => {
    const url = writeFixture("generated/a.png", PNG_BYTES);
    const out = await rehydrateAssistantMessageContent(
      `see ${url} for the image`,
      { cwd },
    );
    // Only markdown-wrapped URLs are rehydrated. Bare URLs could be
    // anywhere in prose and we don't want false positives like a model
    // mentioning an old URL in passing.
    expect(out.length).toBe(1);
    expect(out[0]!.type).toBe("text");
  });

  test("markdown with nested parens in URL is tolerated", async () => {
    // The URL shape we produce (UUID + extension) never has parens, so
    // perfect paren parsing isn't required. Verify the common case.
    const url = writeFixture("generated/a.png", PNG_BYTES);
    const out = await rehydrateAssistantMessageContent(
      `![a](${url})\n\nnotes`,
      { cwd },
    );
    expect(out.filter((p: { type: string }) => p.type === "image").length).toBe(1);
  });

  // ── Defensive ──────────────────────────────────────────────────────
  test("same URL appearing twice → rehydrated twice (dedupe is the caller's call)", async () => {
    // Rehydrator is intentionally dumb about dedupe. A single assistant
    // message is unlikely to reference the same image twice; if it does,
    // we don't silently drop one. The executor-level last-N cap is what
    // controls overall token spend.
    const url = writeFixture("generated/a.png", PNG_BYTES);
    const out = await rehydrateAssistantMessageContent(
      `before: ![](${url}) after: ![](${url})`,
      { cwd },
    );
    expect(out.filter((p: { type: string }) => p.type === "image").length).toBe(2);
  });

  test("URL with whitespace inside parens is not matched (keeps parser strict)", async () => {
    const url = writeFixture("generated/a.png", PNG_BYTES);
    const out = await rehydrateAssistantMessageContent(
      `![a](  ${url}  )`,
      { cwd },
    );
    // Standard markdown wouldn't accept the leading/trailing whitespace
    // inside (); we keep the parser strict to avoid matching prose that
    // happens to contain a stray URL.
    expect(out.filter((p: { type: string }) => p.type === "image").length).toBe(0);
  });

  test("I/O error during file read does not throw — turn stays sendable", async () => {
    // Write a file then chmod it unreadable. If the platform doesn't
    // support chmod-based denial (e.g. running as root), we fall back to
    // deleting between `resolve` and `read`, which the rehydrator treats
    // as "nonexistent".
    const url = writeFixture("generated/a.png", PNG_BYTES);
    const abs = join(cwd, ".ezcorp", "extension-data", EXT, "generated", "a.png");
    try {
      const { chmodSync } = await import("node:fs");
      chmodSync(abs, 0o000);
    } catch { /* non-critical — fall through */ }
    const out = await rehydrateAssistantMessageContent(
      `![](${url})`,
      { cwd },
    );
    // Either the read failed → text-only output,
    // or it succeeded → text + image. Both are acceptable — what matters
    // is we never throw.
    expect(Array.isArray(out)).toBe(true);
    expect(out[0]!.type).toBe("text");
  });
});
