/**
 * Unit tests for the shared diff2html render helper used by both the review
 * panel's file cards and the inline DiffCard.
 */
import { describe, expect, test } from "bun:test";
import { renderDiffHtml } from "./render-diff";

const DIFF = [
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -1,2 +1,2 @@",
  "-const ok = false;",
  "+const ok = true;",
].join("\n");

describe("renderDiffHtml", () => {
  test("side-by-side emits diff2html's two-column markup", () => {
    const html = renderDiffHtml(DIFF, "side-by-side");
    expect(html).toContain("d2h-file-side-diff");
  });

  test("line-by-line emits a single column (no side-diff element)", () => {
    const html = renderDiffHtml(DIFF, "line-by-line");
    expect(html).toContain("d2h-wrapper");
    expect(html).not.toContain("d2h-file-side-diff");
  });

  test("never draws diff2html's own file list — the panel draws its own tree", () => {
    expect(renderDiffHtml(DIFF, "side-by-side")).not.toContain("d2h-file-list");
  });

  test("input diff2html cannot parse falls back to escaped raw text", () => {
    const html = renderDiffHtml(undefined as unknown as string, "side-by-side");
    expect(html).toBe("<pre>undefined</pre>");
  });

  test("the fallback escapes markup so a diff cannot inject HTML", () => {
    const hostile = { toString: () => '<img src=x onerror="alert(1)">' };
    const html = renderDiffHtml(hostile as unknown as string, "line-by-line");
    expect(html).toContain("&lt;img");
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;");
  });
});
