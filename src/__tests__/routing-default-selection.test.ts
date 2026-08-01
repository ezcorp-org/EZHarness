/**
 * `provider:defaultSelection` — the tolerant READ and the strict WRITE.
 *
 * The pair is the point: the read must never let a bad row break the composer,
 * so it swallows everything; the write must therefore refuse everything the
 * read would swallow, or an operator's revert becomes a silent no-op. The last
 * describe block pins that relationship directly (write ⊆ read).
 */
import { describe, expect, test } from "bun:test";
import {
  DEFAULT_SELECTION_FALLBACK,
  DEFAULT_SELECTION_MODES,
  DEFAULT_SELECTION_SETTING_KEY,
  parseDefaultSelection,
  validateDefaultSelection,
} from "../runtime/routing/default-selection";

describe("constants", () => {
  test("the settings key is the documented one", () => {
    expect(DEFAULT_SELECTION_SETTING_KEY).toBe("provider:defaultSelection");
  });

  test("shipping default is auto — routing is on the default path", () => {
    expect(DEFAULT_SELECTION_FALLBACK).toBe("auto");
  });

  test("the mode list is exactly the two modes, auto first", () => {
    expect([...DEFAULT_SELECTION_MODES]).toEqual(["auto", "first"]);
  });
});

describe("parseDefaultSelection — tolerant read", () => {
  test("passes both modes through verbatim", () => {
    expect(parseDefaultSelection("auto")).toBe("auto");
    expect(parseDefaultSelection("first")).toBe("first");
  });

  test("an absent row reads as the shipping default", () => {
    expect(parseDefaultSelection(undefined)).toBe("auto");
    expect(parseDefaultSelection(null)).toBe("auto");
  });

  test("every malformed shape degrades instead of throwing", () => {
    for (const bad of ["Auto", "FIRST", "firstish", "", 1, 0, true, false, { mode: "first" }, ["first"]]) {
      expect(parseDefaultSelection(bad)).toBe("auto");
    }
  });
});

describe("validateDefaultSelection — strict write", () => {
  test("accepts auto and returns the normalized mode", () => {
    const res = validateDefaultSelection("auto");
    expect(res).toEqual({ ok: true, mode: "auto" });
  });

  test("accepts first — the revert must be storable", () => {
    const res = validateDefaultSelection("first");
    expect(res).toEqual({ ok: true, mode: "first" });
  });

  test("a near-miss string is REJECTED, quoting what was sent", () => {
    const res = validateDefaultSelection("First");
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a rejection");
    expect(res.error).toContain('"First"');
    // The message has to say what would have happened, not just "invalid".
    expect(res.error).toContain('read back as "auto"');
  });

  test("a non-string names its type rather than quoting it", () => {
    const res = validateDefaultSelection({ mode: "first" });
    expect(res.ok).toBe(false);
    if (res.ok) throw new Error("expected a rejection");
    expect(res.error).toContain("object");
    expect(res.error).toContain('"auto"');
    expect(res.error).toContain('"first"');
  });

  test("rejects absent / null / numeric values", () => {
    for (const bad of [undefined, null, 0, 1, true]) {
      expect(validateDefaultSelection(bad).ok).toBe(false);
    }
  });
});

describe("write ⊆ read — nothing storable is unreadable", () => {
  test("every accepted mode survives the tolerant read unchanged", () => {
    for (const mode of DEFAULT_SELECTION_MODES) {
      const res = validateDefaultSelection(mode);
      expect(res.ok).toBe(true);
      if (!res.ok) throw new Error(`expected ${mode} to be accepted`);
      expect(parseDefaultSelection(res.mode)).toBe(mode);
    }
  });

  test("the read's fallback is itself a writable mode", () => {
    expect(validateDefaultSelection(DEFAULT_SELECTION_FALLBACK).ok).toBe(true);
  });
});
