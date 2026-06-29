import { test, expect, describe } from "bun:test";
import {
  getCapabilities,
  getCapabilitiesWithExtensions,
  isMimeAccepted,
  classifyMime,
  classifyMimeWithCaps,
  IMAGE_MIMES,
  TEXT_MIMES,
  PDF_MIMES,
  AUDIO_MIMES,
} from "../providers/model-capabilities";

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

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
    const caps = getCapabilities("google", "gemini-2.5-pro");
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
      ["google", "gemini-2.5-pro"],
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

  describe("getCapabilitiesWithExtensions", () => {
    test("with no extension MIMEs returns the base capabilities unchanged", () => {
      const base = getCapabilities("anthropic", "claude-3-5-sonnet-20241022");
      const overlay = getCapabilitiesWithExtensions("anthropic", "claude-3-5-sonnet-20241022", []);
      expect(overlay.acceptedMimeTypes).toEqual(base.acceptedMimeTypes);
      expect(overlay.kinds).toEqual(base.kinds);
      expect(overlay.kinds).not.toContain("extension-handle");
      expect(overlay.deliveryFor["extension-handle"]).toBeUndefined();
    });

    test("supplied MIMEs are added with extension-handle-only delivery", () => {
      const caps = getCapabilitiesWithExtensions("anthropic", "claude-3-5-sonnet-20241022", [XLSX_MIME]);
      expect(caps.acceptedMimeTypes).toContain(XLSX_MIME);
      expect(caps.kinds).toContain("extension-handle");
      expect(caps.deliveryFor["extension-handle"]).toBe("extension-handle-only");
      expect(isMimeAccepted(caps, XLSX_MIME)).toBe(true);
    });

    test("MIMEs already in the base allowlist are not downgraded to extension-handle", () => {
      // image/png is already a native image MIME on Claude. Even if a
      // misbehaving extension declares it, the base delivery wins.
      const caps = getCapabilitiesWithExtensions("anthropic", "claude-3-5-sonnet-20241022", ["image/png"]);
      expect(classifyMimeWithCaps(caps, "image/png")).toBe("image");
      expect(caps.deliveryFor.image).toBe("native-image");
    });

    test("classifyMimeWithCaps returns extension-handle for overlay MIMEs", () => {
      const caps = getCapabilitiesWithExtensions("anthropic", "claude-3-5-sonnet-20241022", [XLSX_MIME]);
      expect(classifyMimeWithCaps(caps, XLSX_MIME)).toBe("extension-handle");
      // Static whitelist still works through the same classifier.
      expect(classifyMimeWithCaps(caps, "image/png")).toBe("image");
      expect(classifyMimeWithCaps(caps, "application/pdf")).toBe("pdf");
      expect(classifyMimeWithCaps(caps, "application/octet-stream")).toBeNull();
    });

    test("duplicate MIMEs in the extension list dedupe", () => {
      const caps = getCapabilitiesWithExtensions(
        "anthropic",
        "claude-3-5-sonnet-20241022",
        [XLSX_MIME, XLSX_MIME, "application/x-vnd-foo", XLSX_MIME],
      );
      const occurrences = caps.acceptedMimeTypes.filter((m) => m === XLSX_MIME);
      expect(occurrences).toHaveLength(1);
      expect(caps.acceptedMimeTypes).toContain("application/x-vnd-foo");
    });

    test("non-string entries in the extension MIME list are dropped", () => {
      const caps = getCapabilitiesWithExtensions(
        "anthropic",
        "claude-3-5-sonnet-20241022",
        ["", XLSX_MIME, null as unknown as string, undefined as unknown as string],
      );
      expect(caps.acceptedMimeTypes).toContain(XLSX_MIME);
      expect(caps.acceptedMimeTypes).not.toContain("");
    });

    test("works on text-only models too — extension-handle is gated by capability, not modality", () => {
      const caps = getCapabilitiesWithExtensions("my-custom-provider", "some-local-llm", [XLSX_MIME]);
      expect(caps.kinds).not.toContain("image");
      expect(caps.kinds).toContain("extension-handle");
      expect(isMimeAccepted(caps, XLSX_MIME)).toBe(true);
    });
  });
});
