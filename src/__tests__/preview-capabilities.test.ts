/**
 * Secure User-Site Preview — capability detection (D2).
 *
 * uid mode when the setuid spawn helper works, else static (fail-closed for
 * dynamic previews; static previews always work).
 */
import { test, expect, describe, beforeEach } from "bun:test";

const caps = await import("../runtime/preview/preview-capabilities");

beforeEach(() => {
  caps._resetPreviewCapabilitiesForTests();
});

describe("previewCapabilities — capability MODE (uid > static)", () => {
  test("static (fail-closed) without the setuid helper", () => {
    // The test host has no installed /app setuid helper, so the real
    // check returns false.
    expect(caps.previewCapabilities()).toEqual({
      static: true,
      dynamic: false,
      mode: "static",
      reason: "dynamic previews disabled: setuid spawn helper not present/functional",
    });
  });

  test("uid mode when the helper is present", () => {
    expect(caps.computePreviewCapabilities({ helperPresent: () => true })).toEqual({
      static: true,
      dynamic: true,
      mode: "uid",
      reason: null,
    });
  });

  test("caches the result until reset", () => {
    const first = caps.previewCapabilities();
    expect(caps.previewCapabilities()).toBe(first);
    caps._resetPreviewCapabilitiesForTests();
    expect(caps.previewCapabilities()).not.toBe(first);
  });
});
