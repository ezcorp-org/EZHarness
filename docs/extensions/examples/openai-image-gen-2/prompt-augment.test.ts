import { describe, expect, test } from "bun:test";
import { augmentPrompt, fieldsFromInput } from "./prompt-augment";

describe("augmentPrompt", () => {
  test("returns bare prompt when augment=false", () => {
    expect(augmentPrompt("a cat", false, { use_case: "ui-mockup" })).toBe("a cat");
  });
  test("trims the input prompt", () => {
    expect(augmentPrompt("   a cat  ", false)).toBe("a cat");
  });
  test("adds use case line first when provided", () => {
    const out = augmentPrompt("a cat", true, { use_case: "photorealistic-natural" });
    const lines = out.split("\n");
    expect(lines[0]).toBe("Use case: photorealistic-natural");
    expect(lines[1]).toBe("Primary request: a cat");
  });
  test("puts Primary request first when use_case is absent", () => {
    const out = augmentPrompt("a cat", true, { subject: "tabby" });
    expect(out.split("\n")[0]).toBe("Primary request: a cat");
  });
  test("emits each provided field with its label", () => {
    const out = augmentPrompt("a cat", true, {
      subject: "siamese", style: "watercolor", composition: "centered",
      lighting: "soft", palette: "warm", materials: "rough paper", scene: "window",
    });
    expect(out).toContain("Subject: siamese");
    expect(out).toContain("Style/medium: watercolor");
    expect(out).toContain("Composition/framing: centered");
    expect(out).toContain("Lighting/mood: soft");
    expect(out).toContain("Color palette: warm");
    expect(out).toContain("Materials/textures: rough paper");
    expect(out).toContain("Scene/background: window");
  });
  test("quotes verbatim text", () => {
    const out = augmentPrompt("logo", true, { text: "ACME 2026" });
    expect(out).toContain('Text (verbatim): "ACME 2026"');
  });
  test("emits constraints and negatives under distinct labels", () => {
    const out = augmentPrompt("cat", true, { constraints: "no watermark", negative: "no people" });
    expect(out).toContain("Constraints: no watermark");
    expect(out).toContain("Avoid: no people");
  });
  test("skips empty/undefined fields", () => {
    const out = augmentPrompt("a cat", true, { subject: "", lighting: undefined });
    expect(out).not.toContain("Subject:");
    expect(out).not.toContain("Lighting/mood:");
  });
  test("field order is stable", () => {
    const out = augmentPrompt("a cat", true, {
      use_case: "u", scene: "sc", subject: "sub", style: "st",
      composition: "co", lighting: "li", palette: "pa", materials: "ma",
      text: "tx", constraints: "cn", negative: "ng",
    });
    expect(out.split("\n")).toEqual([
      "Use case: u", "Primary request: a cat", "Scene/background: sc",
      "Subject: sub", "Style/medium: st", "Composition/framing: co",
      "Lighting/mood: li", "Color palette: pa", "Materials/textures: ma",
      'Text (verbatim): "tx"', "Constraints: cn", "Avoid: ng",
    ]);
  });
  test("empty prompt is preserved", () => {
    const out = augmentPrompt("", true, { use_case: "u" });
    expect(out).toContain("Primary request: ");
  });
});

describe("fieldsFromInput", () => {
  test("extracts string-typed hints", () => {
    const f = fieldsFromInput({ subject: "cat", style: "oil" });
    expect(f).toEqual({ subject: "cat", style: "oil" });
  });
  test("trims whitespace-only strings to undefined", () => {
    expect(fieldsFromInput({ subject: "   " }).subject).toBeUndefined();
  });
  test("ignores non-string values", () => {
    const f = fieldsFromInput({ subject: 123, style: null });
    expect(f.subject).toBeUndefined();
    expect(f.style).toBeUndefined();
  });
  test("leaves unknown keys out", () => {
    const f = fieldsFromInput({ foo: "bar", subject: "cat" });
    expect((f as any).foo).toBeUndefined();
    expect(f.subject).toBe("cat");
  });
});
