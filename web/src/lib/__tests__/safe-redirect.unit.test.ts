import { test, expect, describe } from "vitest";
import { safeReturnTo } from "../safe-redirect";

describe("safeReturnTo", () => {
  test("null/undefined/empty fall back to /", () => {
    expect(safeReturnTo(null)).toBe("/");
    expect(safeReturnTo(undefined)).toBe("/");
    expect(safeReturnTo("")).toBe("/");
  });

  test("legitimate same-origin paths pass through", () => {
    expect(safeReturnTo("/")).toBe("/");
    expect(safeReturnTo("/chat/abc123")).toBe("/chat/abc123");
    expect(safeReturnTo("/projects/xyz?tab=files")).toBe("/projects/xyz?tab=files");
    expect(safeReturnTo("/admin#settings")).toBe("/admin#settings");
  });

  test("protocol-relative URLs collapse to /", () => {
    expect(safeReturnTo("//evil.com")).toBe("/");
    expect(safeReturnTo("//evil.com/path")).toBe("/");
  });

  test("backslash-prefixed paths collapse to /", () => {
    expect(safeReturnTo("/\\evil.com")).toBe("/");
  });

  test("absolute URLs collapse to /", () => {
    expect(safeReturnTo("https://evil.com")).toBe("/");
    expect(safeReturnTo("http://evil.com/x")).toBe("/");
    expect(safeReturnTo("javascript:alert(1)")).toBe("/");
  });

  test("paths without leading slash collapse to /", () => {
    expect(safeReturnTo("chat/abc")).toBe("/");
    expect(safeReturnTo("foo")).toBe("/");
  });
});
