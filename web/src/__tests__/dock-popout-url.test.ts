/**
 * Tests for `extractPopoutUrl` — the pure helper extracted from
 * DockHost.svelte that turns a tool-call's `output` into a same-origin
 * pop-out URL (or null when the URL is unsafe / shape-wrong).
 *
 * The helper fronts the "Pop out" affordance the dock surfaces for any
 * tool result whose JSON carries an `iframeSrc`. Three accepted output
 * shapes (1) already-parsed object, (2) JSON string, (3) MCP envelope.
 * The same-origin + http(s)-only guard mirrors `validateIframeSrc`.
 *
 * validation: dock pop-out URL extractor
 */
import { describe, test, expect } from "bun:test";
import { extractPopoutUrl } from "../lib/components/tool-cards/iframe-card-logic.js";

const ORIGIN = "https://app.example.com";

describe("validation: extractPopoutUrl", () => {
  test("same-origin relative path → returns absolute same-origin URL", () => {
    const url = extractPopoutUrl(
      { iframeSrc: "/api/extensions/claude-design/data/preview.html" },
      ORIGIN,
    );
    expect(url).toBe(
      "https://app.example.com/api/extensions/claude-design/data/preview.html",
    );
  });

  test("same-origin absolute URL → returns it normalized", () => {
    const url = extractPopoutUrl(
      { iframeSrc: "https://app.example.com/api/extensions/claude-design/data/preview.html" },
      ORIGIN,
    );
    expect(url).toBe(
      "https://app.example.com/api/extensions/claude-design/data/preview.html",
    );
  });

  test("cross-origin URL → null", () => {
    const url = extractPopoutUrl(
      { iframeSrc: "https://evil.example.com/steal.html" },
      ORIGIN,
    );
    expect(url).toBeNull();
  });

  test("javascript: scheme → null", () => {
    const url = extractPopoutUrl({ iframeSrc: "javascript:alert(1)" }, ORIGIN);
    expect(url).toBeNull();
  });

  test("data: scheme → null", () => {
    const url = extractPopoutUrl(
      { iframeSrc: "data:text/html,<script>alert(1)</script>" },
      ORIGIN,
    );
    expect(url).toBeNull();
  });

  test("blob: scheme → null", () => {
    const url = extractPopoutUrl(
      { iframeSrc: "blob:https://app.example.com/abcd-1234" },
      ORIGIN,
    );
    expect(url).toBeNull();
  });

  test("file: scheme → null", () => {
    const url = extractPopoutUrl(
      { iframeSrc: "file:///etc/passwd" },
      ORIGIN,
    );
    expect(url).toBeNull();
  });

  test("string form (JSON-stringified) → accepted", () => {
    const url = extractPopoutUrl(
      JSON.stringify({ iframeSrc: "/x.html" }),
      ORIGIN,
    );
    expect(url).toBe("https://app.example.com/x.html");
  });

  test("MCP envelope { content: [{ type: 'text', text: '<json>' }] } → accepted", () => {
    const url = extractPopoutUrl(
      {
        content: [
          { type: "text", text: JSON.stringify({ iframeSrc: "/y.html" }) },
        ],
      },
      ORIGIN,
    );
    expect(url).toBe("https://app.example.com/y.html");
  });

  test("already-parsed object form → accepted", () => {
    const url = extractPopoutUrl({ iframeSrc: "/z.html" }, ORIGIN);
    expect(url).toBe("https://app.example.com/z.html");
  });

  test("missing iframeSrc field → null", () => {
    expect(extractPopoutUrl({}, ORIGIN)).toBeNull();
    expect(extractPopoutUrl({ otherField: "value" }, ORIGIN)).toBeNull();
  });

  test("output is null/undefined → null", () => {
    expect(extractPopoutUrl(null, ORIGIN)).toBeNull();
    expect(extractPopoutUrl(undefined, ORIGIN)).toBeNull();
  });

  test("unparseable JSON string → null", () => {
    expect(extractPopoutUrl("{not json", ORIGIN)).toBeNull();
  });

  test("MCP envelope with non-string text payload → null", () => {
    expect(
      extractPopoutUrl(
        { content: [{ type: "text", text: 42 }] },
        ORIGIN,
      ),
    ).toBeNull();
  });

  test("MCP envelope with no text-typed content → null", () => {
    expect(
      extractPopoutUrl(
        { content: [{ type: "image", url: "/x.png" }] },
        ORIGIN,
      ),
    ).toBeNull();
  });

  test("non-string iframeSrc → null", () => {
    expect(extractPopoutUrl({ iframeSrc: 42 }, ORIGIN)).toBeNull();
    expect(extractPopoutUrl({ iframeSrc: null }, ORIGIN)).toBeNull();
    expect(extractPopoutUrl({ iframeSrc: { url: "/x" } }, ORIGIN)).toBeNull();
  });
});
