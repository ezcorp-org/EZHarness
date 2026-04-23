import { test, expect, describe } from "bun:test";
import { chunkText, isAllowedFile, ALLOWED_EXTENSIONS } from "../memory/chunking";

describe("ALLOWED_EXTENSIONS set", () => {
  test("is a Set (O(1) membership)", () => {
    expect(ALLOWED_EXTENSIONS).toBeInstanceOf(Set);
  });

  test("every entry starts with a dot and is lowercase", () => {
    for (const ext of ALLOWED_EXTENSIONS) {
      expect(ext.startsWith(".")).toBe(true);
      expect(ext).toBe(ext.toLowerCase());
    }
  });

  test("includes common text/code extensions", () => {
    expect(ALLOWED_EXTENSIONS.has(".md")).toBe(true);
    expect(ALLOWED_EXTENSIONS.has(".ts")).toBe(true);
    expect(ALLOWED_EXTENSIONS.has(".py")).toBe(true);
    expect(ALLOWED_EXTENSIONS.has(".json")).toBe(true);
  });

  test("excludes binary/image extensions", () => {
    expect(ALLOWED_EXTENSIONS.has(".jpg")).toBe(false);
    expect(ALLOWED_EXTENSIONS.has(".pdf")).toBe(false);
    expect(ALLOWED_EXTENSIONS.has(".zip")).toBe(false);
    expect(ALLOWED_EXTENSIONS.has(".exe")).toBe(false);
  });
});

describe("isAllowedFile — edge cases beyond the happy path", () => {
  test("handles filenames with multiple dots (takes last extension)", () => {
    expect(isAllowedFile("archive.tar.md")).toBe(true);
    // .tar is not in the allowed set; .md is, so the final segment wins.
    expect(isAllowedFile("notes.backup.json")).toBe(true);
    expect(isAllowedFile("image.md.jpg")).toBe(false);
  });

  test("trailing dot alone is not a valid extension", () => {
    expect(isAllowedFile("foo.")).toBe(false);
  });

  test("dotfile without secondary extension (e.g. '.env') is allowed when in set", () => {
    // .env IS in ALLOWED_EXTENSIONS; the function uses lastIndexOf(".")
    // which returns 0 for ".env", so slice(0) = ".env" — allowed.
    expect(isAllowedFile(".env")).toBe(true);
  });

  test("dotfile outside allowed set (e.g. '.DS_Store') returns false", () => {
    expect(isAllowedFile(".DS_Store")).toBe(false);
    expect(isAllowedFile(".gitignore")).toBe(false);
  });

  test("empty string returns false (no dot)", () => {
    expect(isAllowedFile("")).toBe(false);
  });

  test("mixed case extension is normalized before lookup", () => {
    expect(isAllowedFile("Script.Py")).toBe(true);
    expect(isAllowedFile("CONFIG.YAML")).toBe(true);
    expect(isAllowedFile("file.TxT")).toBe(true);
  });

  test("path prefix does not confuse the extension check", () => {
    expect(isAllowedFile("/tmp/project/data.csv")).toBe(true);
    expect(isAllowedFile("./subdir/file.go")).toBe(true);
    expect(isAllowedFile("weird.dir.name/file.md")).toBe(true);
  });
});

describe("chunkText — edge cases beyond the happy path", () => {
  test("empty string returns a single empty chunk", () => {
    const chunks = chunkText("");
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe("");
    expect(chunks[0]!.index).toBe(0);
  });

  test("text of exactly chunkSize fits in one chunk (no split)", () => {
    const text = "x".repeat(100);
    const chunks = chunkText(text, { chunkSize: 100, overlap: 10 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.content).toBe(text);
  });

  test("text one character over chunkSize produces at least two chunks", () => {
    const text = "x".repeat(101);
    const chunks = chunkText(text, { chunkSize: 100, overlap: 10 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
  });

  test("zero overlap: consecutive chunks do not share characters", () => {
    const text = Array.from({ length: 250 }, (_, i) => String.fromCharCode(33 + (i % 94))).join("");
    const chunks = chunkText(text, { chunkSize: 50, overlap: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    // With overlap=0, end of chunk[i] should match start of chunk[i+1] going char-for-char.
    // Reconstruction equals original text exactly.
    const reconstructed = chunks.map((c) => c.content).join("");
    expect(reconstructed).toBe(text);
  });

  test("overlap larger than chunkSize: forced minimum advance of 1 character", () => {
    // overlap >= chunkSize would otherwise cause an infinite loop; the code
    // clamps advance to at least 1.
    const text = "abcdefghij"; // length 10
    const chunks = chunkText(text, { chunkSize: 3, overlap: 100 });

    // Must terminate (not hang) and cover all positions.
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.length).toBeLessThanOrEqual(text.length);
    // All chunks must have some content.
    for (const c of chunks) {
      expect(c.content.length).toBeGreaterThan(0);
    }
  });

  test("default options apply when opts is omitted for long text", () => {
    const text = "word ".repeat(500); // 2500 chars, >> default chunkSize 512
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    // Default chunkSize=512, overlap=50 — each chunk (except last) <= 512.
    for (const c of chunks.slice(0, -1)) {
      expect(c.content.length).toBeLessThanOrEqual(512);
    }
  });

  test("text with trailing newline at end still covers all content", () => {
    const text = "a".repeat(600) + "\n";
    const chunks = chunkText(text, { chunkSize: 512, overlap: 50 });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    // Reconstruct by joining — trailing newline should appear in the last chunk.
    const last = chunks[chunks.length - 1]!;
    expect(last.content.endsWith("\n")).toBe(true);
  });

  test("newline preference: does not break before the halfway point", () => {
    // Put a newline at position 10 (well before halfway of a 200-char chunk).
    // The chunker should NOT break there; it only considers newlines after halfPoint.
    const text = "x".repeat(10) + "\n" + "y".repeat(300);
    const chunks = chunkText(text, { chunkSize: 200, overlap: 20 });
    // First chunk should not end at position 11 (the early newline).
    expect(chunks[0]!.content.length).toBeGreaterThan(11);
  });
});
