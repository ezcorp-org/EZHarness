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

describe("sanitizeNulDeep — the clean-subtree branches of the rebuild", () => {
  // A wholly clean value is answered by the allocation-free scan and never
  // reaches the rebuilding walk. These drive walk anyway — by pairing a clean
  // subtree with a dirty sibling — so its "nothing changed here, keep the
  // original" branches stay exercised.
  test("a clean ARRAY beside a dirty sibling keeps its identity", () => {
    const cleanArr = ["x", "y"];
    const out = sanitizeNulDeep({ arr: cleanArr, dirty: `d${NUL}` }) as Record<string, unknown>;
    expect(out.dirty).toBe(`d${NUL_REPLACEMENT}`);
    expect(out.arr).toBe(cleanArr);
  });

  test("a clean nested OBJECT beside a dirty sibling keeps its identity", () => {
    const cleanObj = { a: 1, b: "two" };
    const out = sanitizeNulDeep({ obj: cleanObj, dirty: `d${NUL}` }) as Record<string, unknown>;
    expect(out.obj).toBe(cleanObj);
  });

  test("a clean array nested deep inside a dirty tree keeps its identity", () => {
    const deepClean = [1, 2, 3];
    const out = sanitizeNulDeep({
      lvl1: { lvl2: { nums: deepClean, bad: `x${NUL}` } },
    }) as { lvl1: { lvl2: { nums: unknown } } };
    expect(out.lvl1.lvl2.nums).toBe(deepClean);
  });
});

describe("sanitizeNulDeep — fast path agrees with the rebuild", () => {
  // The scan is a performance shortcut that decides whether the rebuild runs at
  // all. If it ever disagreed with walk it would wave a NUL straight through to
  // Postgres and resurrect the original bug, so assert the invariant over
  // randomized shapes rather than a handful of hand-written ones.
  function randomValue(rng: () => number, depth: number): unknown {
    const roll = rng();
    if (depth > 4 || roll < 0.35) {
      if (roll < 0.1) return rng() < 0.5 ? `s${NUL}t` : "plain";
      if (roll < 0.18) return Math.floor(rng() * 100);
      if (roll < 0.24) return null;
      if (roll < 0.3) return rng() < 0.5;
      return rng() < 0.3 ? `${NUL}` : "leaf";
    }
    if (roll < 0.65) {
      const len = Math.floor(rng() * 4);
      return Array.from({ length: len }, () => randomValue(rng, depth + 1));
    }
    const obj: Record<string, unknown> = {};
    const keys = Math.floor(rng() * 4);
    for (let i = 0; i < keys; i++) {
      const key = rng() < 0.2 ? `k${NUL}${i}` : `k${i}`;
      obj[key] = randomValue(rng, depth + 1);
    }
    return obj;
  }

  /** Deterministic PRNG so a failure is reproducible. */
  function makeRng(seed: number): () => number {
    let s = seed;
    return () => {
      s = (s * 1664525 + 1013904223) % 4294967296;
      return s / 4294967296;
    };
  }

  function hasNul(value: unknown, seen = new Set<unknown>()): boolean {
    if (typeof value === "string") return value.includes(NUL);
    if (value === null || typeof value !== "object") return false;
    if (seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.some((v) => hasNul(v, seen));
    return Object.entries(value).some(([k, v]) => k.includes(NUL) || hasNul(v, seen));
  }

  test("no NUL survives, across 400 randomized structures", () => {
    let dirtyCount = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rng = makeRng(seed);
      const input = randomValue(rng, 0);
      const wasDirty = hasNul(input);
      if (wasDirty) dirtyCount++;
      const out = sanitizeNulDeep(input);
      expect(hasNul(out)).toBe(false);
      // A clean input must come back by identity (the scan's whole purpose).
      if (!wasDirty) expect(out).toBe(input);
    }
    // Guard the generator itself: if it stopped producing NULs the assertions
    // above would be vacuous.
    expect(dirtyCount).toBeGreaterThan(20);
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

describe("sanitizeNulDeep — an ESCAPED \\u0000 is not a NUL", () => {
  // The six literal characters backslash-u-0-0-0-0 are a perfectly legal text
  // value that Postgres stores happily. Corrupting them would silently rewrite
  // source code, JSON samples and regexes that users paste into chat.
  const ESCAPED = "\\u0000";

  test("the six-character escape is left byte-for-byte alone", () => {
    expect(sanitizeNulString(ESCAPED)).toBe(ESCAPED);
    expect(sanitizeNulString(ESCAPED)).toHaveLength(6);
  });

  test("it survives inside a larger string at the ORIGINAL identity", () => {
    const code = `const NUL = "${ESCAPED}"; // not a real NUL`;
    expect(sanitizeNulDeep(code)).toBe(code);
  });

  test("it survives nested in a jsonb payload, key and value alike", () => {
    const payload = { [`k${ESCAPED}`]: `v${ESCAPED}`, list: [ESCAPED] };
    expect(sanitizeNulDeep(payload)).toBe(payload);
    expect(Object.keys(payload)).toContain(`k${ESCAPED}`);
  });

  test("an escape sitting NEXT TO a real NUL: only the real one is replaced", () => {
    expect(sanitizeNulString(`${ESCAPED}${NUL}`)).toBe(`${ESCAPED}${NUL_REPLACEMENT}`);
  });
});

describe("sanitizeNulDeep — binary values are never mangled", () => {
  test("a Uint8Array containing a zero byte passes through untouched", () => {
    const bytes = new Uint8Array([0, 65, 0]);
    const out = sanitizeNulDeep({ bytes }) as { bytes: Uint8Array };
    // Identity, type AND contents: a zero BYTE is not a NUL character, and
    // rewriting one would corrupt every binary payload.
    expect(out.bytes).toBe(bytes);
    expect(out.bytes instanceof Uint8Array).toBe(true);
    expect(Array.from(out.bytes)).toEqual([0, 65, 0]);
  });

  test("a Buffer keeps its type and its zero bytes", () => {
    const buf = Buffer.from([0, 1, 0]);
    const out = sanitizeNulDeep({ buf }) as { buf: Buffer };
    expect(out.buf).toBe(buf);
    expect(Buffer.isBuffer(out.buf)).toBe(true);
    expect([...out.buf]).toEqual([0, 1, 0]);
  });
});

describe("sanitizeNulDeep — the allocation-free fast path bails safely", () => {
  // The scan that makes the clean case cheap does not memoize, so it has two
  // escape hatches into the (cycle-safe, memoizing) walk. Both must produce
  // exactly the same answer as if the scan had never existed.

  test("a CLEAN self-cycle terminates and keeps its identity", () => {
    const node: Record<string, unknown> = { name: "clean" };
    node.self = node;
    // Nothing to scrub, so the original comes back — cycle intact.
    expect(sanitizeNulDeep(node)).toBe(node);
    expect(node.self).toBe(node);
  });

  test("a cycle nested BELOW a clean prefix still terminates", () => {
    const inner: Record<string, unknown> = { tag: "inner" };
    inner.loop = inner;
    const outer = { a: "fine", b: { c: inner } };
    expect(sanitizeNulDeep(outer)).toBe(outer);
  });

  test("a value nested deeper than the scan depth cap is still scrubbed", () => {
    // 300 levels is past the cap, so this exercises the depth bail-out and
    // proves the fallback still finds the NUL at the bottom.
    let deep: Record<string, unknown> = { leaf: `x${NUL}` };
    for (let i = 0; i < 300; i++) deep = { next: deep };

    let node = sanitizeNulDeep(deep) as Record<string, unknown>;
    for (let i = 0; i < 300; i++) node = node.next as Record<string, unknown>;
    expect(node.leaf).toBe(`x${NUL_REPLACEMENT}`);
  });

  test("a heavily SHARED graph does not blow up exponentially", () => {
    // 25 levels of two-way sharing: 25 distinct objects but 2^25 (~33M)
    // distinct paths. The scan visits paths, not nodes, so without the node
    // budget this takes ~1s; with it, the walk (which memoizes) finishes in
    // single-digit ms. Asserting the wall clock is what pins the guard.
    let dag: unknown = { leaf: "clean" };
    for (let i = 0; i < 25; i++) dag = { a: dag, b: dag };

    const started = Bun.nanoseconds();
    const out = sanitizeNulDeep(dag);
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;

    expect(out).toBe(dag);
    expect(elapsedMs).toBeLessThan(250);
  });

  test("a shared graph carrying a NUL is scrubbed correctly and quickly", () => {
    let dag: unknown = { leaf: `bad${NUL}` };
    for (let i = 0; i < 25; i++) dag = { a: dag, b: dag };

    const started = Bun.nanoseconds();
    let node = sanitizeNulDeep(dag) as Record<string, unknown>;
    const elapsedMs = (Bun.nanoseconds() - started) / 1e6;

    for (let i = 0; i < 25; i++) node = node.a as Record<string, unknown>;
    expect(node.leaf).toBe(`bad${NUL_REPLACEMENT}`);
    expect(elapsedMs).toBeLessThan(250);
  });
});

describe("sanitizeNulDeep — clean values are returned without rebuilding", () => {
  test("a large clean payload comes back at its ORIGINAL identity", () => {
    // The fast path is what keeps the scrubber off the critical path of every
    // write; identity is the observable proof that nothing was cloned.
    const payload = {
      content: Array.from({ length: 500 }, (_, i) => ({ type: "text", text: `row ${i}` })),
    };
    const out = sanitizeNulDeep(payload);
    expect(out).toBe(payload);
    expect(out.content).toBe(payload.content);
    expect(out.content[0]).toBe(payload.content[0]);
  });

  test("nested clean containers each keep their identity", () => {
    const inner = { deep: ["a", "b"] };
    const outer = { inner, n: 1 };
    const out = sanitizeNulDeep(outer) as typeof outer;
    expect(out).toBe(outer);
    expect(out.inner).toBe(inner);
    expect(out.inner.deep).toBe(inner.deep);
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
