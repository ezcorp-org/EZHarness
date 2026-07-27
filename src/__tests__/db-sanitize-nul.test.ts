/**
 * Unit suite for the shared NUL (U+0000) sanitizer.
 *
 * Postgres cannot represent U+0000 in `text` or `jsonb`, so any value carrying
 * one aborts the whole INSERT server-side. `sanitizeNulDeep` is the single
 * scrubber wired into drizzle's column mappers (src/db/nul-column-patch.ts);
 * these tests pin its exact semantics — including the identity-preserving
 * fast path the hot write path depends on.
 */
import { test, expect, describe } from "bun:test";
import { sanitizeNulDeep, sanitizeNulString, NUL_REPLACEMENT } from "../db/sanitize-nul";

// Built, never typed literally: a raw NUL byte in a source file is invisible
// in review and makes the file register as binary.
const NUL = String.fromCharCode(0);

describe("NUL_REPLACEMENT", () => {
  test("is U+FFFD REPLACEMENT CHARACTER, not an empty strip", () => {
    expect(NUL_REPLACEMENT).toBe(String.fromCharCode(0xfffd));
    expect(NUL_REPLACEMENT.length).toBe(1);
  });
});

describe("sanitizeNulString", () => {
  test("replaces a NUL at the START", () => {
    expect(sanitizeNulString(`${NUL}abc`)).toBe(`${NUL_REPLACEMENT}abc`);
  });

  test("replaces a NUL in the MIDDLE", () => {
    expect(sanitizeNulString(`ab${NUL}cd`)).toBe(`ab${NUL_REPLACEMENT}cd`);
  });

  test("replaces a NUL at the END", () => {
    expect(sanitizeNulString(`abc${NUL}`)).toBe(`abc${NUL_REPLACEMENT}`);
  });

  test("replaces EVERY NUL when there are several", () => {
    expect(sanitizeNulString(`${NUL}a${NUL}${NUL}b${NUL}`)).toBe(
      `${NUL_REPLACEMENT}a${NUL_REPLACEMENT}${NUL_REPLACEMENT}b${NUL_REPLACEMENT}`,
    );
  });

  test("a string that is ONLY a NUL becomes only the replacement char", () => {
    expect(sanitizeNulString(NUL)).toBe(NUL_REPLACEMENT);
  });

  test("does not strip — length is preserved", () => {
    const input = `ab${NUL}cd`;
    expect(sanitizeNulString(input)).toHaveLength(input.length);
  });

  test("returns the SAME instance for a clean string (no allocation)", () => {
    const clean = "nothing to do here";
    expect(sanitizeNulString(clean)).toBe(clean);
  });

  test("empty string is returned unchanged", () => {
    expect(sanitizeNulString("")).toBe("");
  });
});

describe("sanitizeNulDeep — primitives and empties", () => {
  test("scrubs a bare top-level string", () => {
    expect(sanitizeNulDeep(`x${NUL}y`)).toBe(`x${NUL_REPLACEMENT}y`);
  });

  test("passes non-string primitives through untouched", () => {
    expect(sanitizeNulDeep(null)).toBeNull();
    expect(sanitizeNulDeep(undefined)).toBeUndefined();
    expect(sanitizeNulDeep(42)).toBe(42);
    expect(sanitizeNulDeep(0)).toBe(0);
    expect(sanitizeNulDeep(true)).toBe(true);
    expect(sanitizeNulDeep(false)).toBe(false);
    expect(sanitizeNulDeep(10n)).toBe(10n);
  });

  test("empty object and empty array round-trip by identity", () => {
    const obj = {};
    const arr: unknown[] = [];
    expect(sanitizeNulDeep(obj)).toBe(obj);
    expect(sanitizeNulDeep(arr)).toBe(arr);
  });
});

describe("sanitizeNulDeep — objects", () => {
  test("scrubs string VALUES", () => {
    expect(sanitizeNulDeep({ error: `spawn${NUL} ENOENT` })).toEqual({
      error: `spawn${NUL_REPLACEMENT} ENOENT`,
    });
  });

  test("scrubs object KEYS", () => {
    const out = sanitizeNulDeep({ [`bad${NUL}key`]: "v" }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual([`bad${NUL_REPLACEMENT}key`]);
    expect(out[`bad${NUL_REPLACEMENT}key`]).toBe("v");
  });

  test("scrubs a key and its value at the same time", () => {
    const out = sanitizeNulDeep({ [`k${NUL}`]: `v${NUL}` }) as Record<string, unknown>;
    expect(out).toEqual({ [`k${NUL_REPLACEMENT}`]: `v${NUL_REPLACEMENT}` });
  });

  test("recurses through DEEPLY nested objects", () => {
    const out = sanitizeNulDeep({ a: { b: { c: { d: `deep${NUL}` } } } });
    expect(out).toEqual({ a: { b: { c: { d: `deep${NUL_REPLACEMENT}` } } } });
  });

  test("leaves non-string properties in place while scrubbing siblings", () => {
    const out = sanitizeNulDeep({ n: 1, ok: true, z: null, s: `a${NUL}` });
    expect(out).toEqual({ n: 1, ok: true, z: null, s: `a${NUL_REPLACEMENT}` });
  });

  test("returns the SAME object when nothing needed scrubbing", () => {
    const clean = { a: { b: "fine" }, n: 3 };
    expect(sanitizeNulDeep(clean)).toBe(clean);
  });

  test("handles a null-prototype object", () => {
    const obj = Object.create(null) as Record<string, unknown>;
    obj.k = `v${NUL}`;
    expect(sanitizeNulDeep(obj)).toEqual({ k: `v${NUL_REPLACEMENT}` });
  });
});

describe("sanitizeNulDeep — arrays", () => {
  test("scrubs strings inside an array", () => {
    expect(sanitizeNulDeep([`a${NUL}`, "b"])).toEqual([`a${NUL_REPLACEMENT}`, "b"]);
  });

  test("scrubs through arrays nested in objects nested in arrays", () => {
    const out = sanitizeNulDeep({ items: [{ deep: [`a${NUL}b`] }] });
    expect(out).toEqual({ items: [{ deep: [`a${NUL_REPLACEMENT}b`] }] });
  });

  test("preserves mixed element types", () => {
    expect(sanitizeNulDeep([1, "x", null, true, [`y${NUL}`]])).toEqual([
      1,
      "x",
      null,
      true,
      [`y${NUL_REPLACEMENT}`],
    ]);
  });

  test("returns the SAME array when nothing needed scrubbing", () => {
    const clean = ["a", { b: "c" }];
    expect(sanitizeNulDeep(clean)).toBe(clean);
  });
});

describe("sanitizeNulDeep — non-plain objects are left intact", () => {
  test("a Date is NOT rebuilt into a plain object", () => {
    const d = new Date("2026-07-20T00:00:00.000Z");
    const out = sanitizeNulDeep({ when: d }) as { when: Date };
    expect(out.when).toBe(d);
    expect(out.when instanceof Date).toBe(true);
  });

  test("a class instance survives with its prototype", () => {
    class Box {
      constructor(public label: string) {}
    }
    const box = new Box(`l${NUL}`);
    const out = sanitizeNulDeep({ box }) as { box: Box };
    // Untouched by design — rebuilding it would destroy the instance. Documented
    // in sanitize-nul.ts: only object/array literals reach jsonb here.
    expect(out.box).toBe(box);
    expect(out.box.label).toBe(`l${NUL}`);
  });
});

describe("sanitizeNulDeep — cycles and shared references", () => {
  test("a self-referencing object does not recurse forever", () => {
    const node: Record<string, unknown> = { name: `n${NUL}` };
    node.self = node;
    const out = sanitizeNulDeep(node) as Record<string, unknown>;
    expect(out.name).toBe(`n${NUL_REPLACEMENT}`);
    // The cycle is rebuilt against the NEW container, not the original.
    expect(out.self).toBe(out);
  });

  test("a two-node cycle through an array terminates", () => {
    const a: Record<string, unknown> = { tag: `a${NUL}` };
    const b: Record<string, unknown> = { tag: "b", back: [a] };
    a.fwd = b;
    const out = sanitizeNulDeep(a) as Record<string, unknown>;
    expect(out.tag).toBe(`a${NUL_REPLACEMENT}`);
    const fwd = out.fwd as Record<string, unknown>;
    expect((fwd.back as unknown[])[0]).toBe(out);
  });

  test("a shared (non-cyclic) subtree stays shared after scrubbing", () => {
    const shared = { v: `s${NUL}` };
    const out = sanitizeNulDeep({ x: shared, y: shared }) as Record<string, unknown>;
    expect(out.x).toEqual({ v: `s${NUL_REPLACEMENT}` });
    expect(out.x).toBe(out.y);
  });

  test("a clean shared subtree keeps its original identity", () => {
    const shared = { v: "clean" };
    const out = sanitizeNulDeep({ x: shared, y: shared, dirty: `d${NUL}` }) as Record<string, unknown>;
    expect(out.x).toBe(shared);
    expect(out.y).toBe(shared);
  });
});

describe("sanitizeNulDeep — the production payload shapes", () => {
  test("the observability tool_error payload that broke persistence", () => {
    const out = sanitizeNulDeep({
      toolName: "get_time",
      extensionId: "timezone-time",
      error: `spawn /app/web/.ezcorp/extensions/timezone-time-hi${NUL} /bin ENOENT`,
      duration: 12,
    });
    expect(out).toEqual({
      toolName: "get_time",
      extensionId: "timezone-time",
      error: `spawn /app/web/.ezcorp/extensions/timezone-time-hi${NUL_REPLACEMENT} /bin ENOENT`,
      duration: 12,
    });
  });

  test("a tool_calls output payload with content blocks", () => {
    const out = sanitizeNulDeep({
      content: [
        { type: "text", text: `failed${NUL}` },
        { type: "text", text: "ok" },
      ],
    });
    expect(out).toEqual({
      content: [
        { type: "text", text: `failed${NUL_REPLACEMENT}` },
        { type: "text", text: "ok" },
      ],
    });
  });
});
