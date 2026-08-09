import { describe, expect, test } from "bun:test";
import {
  type IntersectableCapabilities,
  intersectCapabilities,
  routableRungs,
  uniqueRungs,
} from "../runtime/routing/auto-capabilities";

function caps(over: Partial<IntersectableCapabilities> = {}): IntersectableCapabilities {
  return {
    kinds: ["text", "pdf", "image"],
    acceptedMimeTypes: ["text/plain", "application/pdf", "image/png"],
    maxBytesPerFile: 10_000_000,
    maxFilesPerMessage: 10,
    ...over,
  };
}

describe("intersectCapabilities", () => {
  test("no candidates yields undefined — the caller keeps its text-only fallback", () => {
    // Deliberately NOT an empty-but-permissive object: an unconfigured ladder
    // must not fabricate limits the router never agreed to.
    expect(intersectCapabilities([])).toBeUndefined();
  });

  test("a single candidate passes through unchanged", () => {
    const only = caps();
    expect(intersectCapabilities([only])).toEqual({
      kinds: ["text", "pdf", "image"],
      acceptedMimeTypes: ["text/plain", "application/pdf", "image/png"],
      maxBytesPerFile: 10_000_000,
      maxFilesPerMessage: 10,
    });
  });

  test("drops a kind/MIME that any candidate lacks — the load-bearing case", () => {
    // A mixed ladder (one vision model, one text-only) must NOT offer images:
    // routing could serve either, and over-promising turns a hidden button into
    // a failed send.
    const vision = caps();
    const textOnly = caps({
      kinds: ["text", "pdf"],
      acceptedMimeTypes: ["text/plain", "application/pdf"],
    });
    const merged = intersectCapabilities([vision, textOnly]);
    expect(merged?.kinds).toEqual(["text", "pdf"]);
    expect(merged?.acceptedMimeTypes).toEqual(["text/plain", "application/pdf"]);
    expect(merged?.kinds).not.toContain("image");
    expect(merged?.acceptedMimeTypes).not.toContain("image/png");
  });

  test("widens to images by itself when EVERY rung is vision-capable", () => {
    const merged = intersectCapabilities([caps(), caps(), caps()]);
    expect(merged?.kinds).toContain("image");
    expect(merged?.acceptedMimeTypes).toContain("image/png");
  });

  test("takes the MINIMUM of both limits so no candidate can be violated", () => {
    const merged = intersectCapabilities([
      caps({ maxBytesPerFile: 10_000_000, maxFilesPerMessage: 10 }),
      caps({ maxBytesPerFile: 3_000_000, maxFilesPerMessage: 20 }),
      caps({ maxBytesPerFile: 8_000_000, maxFilesPerMessage: 4 }),
    ]);
    expect(merged?.maxBytesPerFile).toBe(3_000_000);
    expect(merged?.maxFilesPerMessage).toBe(4);
  });

  test("a zero-limit candidate clamps the whole set to zero", () => {
    const merged = intersectCapabilities([caps(), caps({ maxBytesPerFile: 0 })]);
    expect(merged?.maxBytesPerFile).toBe(0);
  });

  test("an empty accept list on one candidate empties the intersection", () => {
    const merged = intersectCapabilities([caps(), caps({ kinds: [], acceptedMimeTypes: [] })]);
    expect(merged?.kinds).toEqual([]);
    expect(merged?.acceptedMimeTypes).toEqual([]);
  });

  test("preserves the first candidate's ordering so the picker stays deterministic", () => {
    const first = caps({
      kinds: ["pdf", "text"],
      acceptedMimeTypes: ["application/pdf", "text/plain"],
    });
    const second = caps({
      kinds: ["text", "pdf"],
      acceptedMimeTypes: ["text/plain", "application/pdf"],
    });
    const merged = intersectCapabilities([first, second]);
    expect(merged?.kinds).toEqual(["pdf", "text"]);
    expect(merged?.acceptedMimeTypes).toEqual(["application/pdf", "text/plain"]);
  });

  test("is order-insensitive in WHAT survives, only in ordering", () => {
    const a = caps();
    const b = caps({ kinds: ["text"], acceptedMimeTypes: ["text/plain"] });
    const ab = intersectCapabilities([a, b]);
    const ba = intersectCapabilities([b, a]);
    expect([...(ab?.kinds ?? [])].sort()).toEqual([...(ba?.kinds ?? [])].sort());
    expect(ab?.maxBytesPerFile).toBe(ba!.maxBytesPerFile);
  });
});

describe("uniqueRungs", () => {
  const A = { provider: "anthropic", model: "m1" };
  const B = { provider: "openai", model: "m2" };
  const OR = { provider: "openrouter", model: "openrouter/auto" };

  test("flattens tiers in order", () => {
    expect(uniqueRungs([[A], [B]])).toEqual([A, B]);
  });

  test("dedupes a rung repeated across tiers — the built-in ladder's shape", () => {
    // openrouter/auto is listed in fast, balanced AND powerful; probing it
    // three times would also weight it three times in the intersection.
    expect(uniqueRungs([[A, OR], [OR], [OR]])).toEqual([A, OR]);
  });

  test("same model id on DIFFERENT providers stays distinct", () => {
    const ollama = { provider: "ollama", model: "m1" };
    expect(uniqueRungs([[A, ollama]])).toEqual([A, ollama]);
  });

  test("no tiers, and empty tiers, yield nothing", () => {
    expect(uniqueRungs([])).toEqual([]);
    expect(uniqueRungs([[], []])).toEqual([]);
  });
});

describe("routableRungs", () => {
  const anthropic = { provider: "anthropic", model: "claude" };
  const ollama = { provider: "ollama", model: "gemma" };
  const openai = { provider: "openai", model: "gpt" };

  test("drops rungs on providers with no credential", () => {
    expect(routableRungs([anthropic, ollama, openai], new Set(["anthropic", "openai"]))).toEqual([
      anthropic,
      openai,
    ]);
  });

  test("keeps ladder order among the survivors", () => {
    expect(routableRungs([openai, anthropic], new Set(["anthropic", "openai"]))).toEqual([
      openai,
      anthropic,
    ]);
  });

  test("NO available provider falls back to the full set, never to empty", () => {
    // Empty would 404 the endpoint and hide the paperclip. Degrade to the
    // pre-filter answer instead of to a broken composer.
    expect(routableRungs([anthropic, ollama], new Set())).toEqual([anthropic, ollama]);
  });

  test("an available provider absent from the ladder changes nothing", () => {
    expect(routableRungs([anthropic], new Set(["anthropic", "google"]))).toEqual([anthropic]);
  });

  test("an empty ladder stays empty — the fallback must not invent rungs", () => {
    expect(routableRungs([], new Set(["anthropic"]))).toEqual([]);
  });
});
