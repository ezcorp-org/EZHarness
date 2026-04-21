import { test, expect, describe } from "bun:test";
import {
  getCapabilities,
  isMimeAccepted,
  classifyMime,
  IMAGE_MIMES,
  TEXT_MIMES,
  PDF_MIMES,
  AUDIO_MIMES,
} from "../providers/model-capabilities";

describe("model-capabilities", () => {
  test("vision model (Claude) accepts images, text, and PDFs", () => {
    const caps = getCapabilities("anthropic", "claude-3-5-sonnet-20241022");
    expect(caps.kinds).toEqual(expect.arrayContaining(["image", "text", "pdf"]));
    expect(caps.kinds).not.toContain("audio");
    for (const m of IMAGE_MIMES) expect(isMimeAccepted(caps, m)).toBe(true);
    for (const m of TEXT_MIMES) expect(isMimeAccepted(caps, m)).toBe(true);
    for (const m of PDF_MIMES) expect(isMimeAccepted(caps, m)).toBe(true);
    for (const m of AUDIO_MIMES) expect(isMimeAccepted(caps, m)).toBe(false);
    expect(caps.deliveryFor.image).toBe("native-image");
    expect(caps.deliveryFor.pdf).toBe("pdf-text-extract");
  });

  test("vision model (GPT-4o) accepts images, text, and PDFs", () => {
    const caps = getCapabilities("openai", "gpt-4o");
    expect(caps.kinds).toEqual(expect.arrayContaining(["image", "text", "pdf"]));
    expect(caps.deliveryFor.image).toBe("native-image");
  });

  test("Gemini accepts images + PDFs with 20MB limit", () => {
    const caps = getCapabilities("google", "gemini-1.5-pro");
    expect(caps.kinds).toContain("image");
    expect(caps.kinds).toContain("pdf");
    expect(caps.maxBytesPerFile).toBe(20 * 1024 * 1024);
  });

  test("unknown/custom model defaults to text-only (no images)", () => {
    const caps = getCapabilities("my-custom-provider", "some-local-llm");
    expect(caps.kinds).toContain("text");
    expect(caps.kinds).toContain("pdf"); // PDFs are text-extracted so allowed
    expect(caps.kinds).not.toContain("image");
    expect(caps.kinds).not.toContain("audio");
    for (const m of IMAGE_MIMES) expect(isMimeAccepted(caps, m)).toBe(false);
    expect(caps.deliveryFor.image).toBeUndefined();
  });

  test("no Phase 1 model accepts audio — audio is gated until explicit wire-up", () => {
    for (const pair of [
      ["anthropic", "claude-3-5-sonnet-20241022"],
      ["openai", "gpt-4o"],
      ["google", "gemini-1.5-pro"],
      ["my-custom-provider", "local-llm"],
    ] as const) {
      const caps = getCapabilities(pair[0], pair[1]);
      expect(caps.kinds).not.toContain("audio");
      for (const m of AUDIO_MIMES) expect(isMimeAccepted(caps, m)).toBe(false);
    }
  });

  test("default size limits: max 10 files, ≥20MB per file", () => {
    const caps = getCapabilities("anthropic", "claude-3-5-sonnet-20241022");
    expect(caps.maxFilesPerMessage).toBe(10);
    expect(caps.maxBytesPerFile).toBeGreaterThanOrEqual(20 * 1024 * 1024);
  });

  test("classifyMime returns the right kind for each whitelist", () => {
    expect(classifyMime("image/png")).toBe("image");
    expect(classifyMime("text/plain")).toBe("text");
    expect(classifyMime("application/pdf")).toBe("pdf");
    expect(classifyMime("audio/mpeg")).toBe("audio");
    expect(classifyMime("application/octet-stream")).toBeNull();
  });
});
