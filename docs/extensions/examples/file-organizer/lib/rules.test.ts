import { describe, expect, test } from "bun:test";
import {
  CIRCUIT_BREAKER_FRACTION,
  JUNK_TMP_MIN_AGE_MS,
  MAX_NAME_LENGTH,
  PRESETS,
  PRESET_NAMES,
  circuitTripped,
  compileGlob,
  expandPresets,
  extOf,
  globMatches,
  hasControlChar,
  parseDsl,
  ruleMatches,
  type FileFacts,
  type Rule,
} from "./rules";

function facts(overrides: Partial<FileFacts> = {}): FileFacts {
  return {
    path: "/w/file.tmp",
    name: "file.tmp",
    ext: "tmp",
    size: 100,
    mtimeMs: 0,
    isSymlink: false,
    nlink: 1,
    ...overrides,
  };
}

describe("glob compilation + ReDoS guard", () => {
  test("* and ? are the only specials", () => {
    expect(globMatches("*.tmp", "a.tmp")).toBe(true);
    expect(globMatches("*.tmp", "a.txt")).toBe(false);
    expect(globMatches("file?.log", "file1.log")).toBe(true);
    expect(globMatches("file?.log", "file12.log")).toBe(false);
  });
  test("regex metacharacters are escaped (literal match)", () => {
    expect(globMatches("a.b+c", "a.b+c")).toBe(true);
    expect(globMatches("a.b+c", "axbxxxc")).toBe(false);
  });
  test("* does not cross a slash", () => {
    expect(compileGlob("*.tmp").test("dir/a.tmp")).toBe(false);
  });
  test("over-long names are non-matching (length guard)", () => {
    const huge = "a".repeat(MAX_NAME_LENGTH + 1) + ".tmp";
    expect(globMatches("*.tmp", huge)).toBe(false);
  });
  test("case-insensitive", () => {
    expect(globMatches("*.TMP", "a.tmp")).toBe(true);
  });
});

describe("hasControlChar", () => {
  test("flags NUL/newline/DEL", () => {
    expect(hasControlChar("a\x00b")).toBe(true);
    expect(hasControlChar("a\nb")).toBe(true);
    expect(hasControlChar("a\x7fb")).toBe(true);
    expect(hasControlChar("normal.tmp")).toBe(false);
  });
});

describe("circuit breaker", () => {
  test("trips above the fraction with >=2 matches", () => {
    expect(circuitTripped(6, 10)).toBe(true);
    expect(circuitTripped(4, 10)).toBe(false);
  });
  test("never trips for a single match", () => {
    expect(circuitTripped(1, 1)).toBe(false);
  });
  test("never trips on empty scan", () => {
    expect(circuitTripped(0, 0)).toBe(false);
  });
  test("respects a custom fraction", () => {
    expect(circuitTripped(3, 10, 0.2)).toBe(true);
    expect(CIRCUIT_BREAKER_FRACTION).toBe(0.5);
  });
});

describe("ruleMatches", () => {
  const junk: Rule = { id: "j", label: "tmp", action: "quarantine", predicate: { glob: "*.tmp" }, destructive: true };
  const stale: Rule = { id: "s", label: "old", action: "route", dest: "Archive", predicate: { olderThanMs: 1000 }, destructive: false };
  const big: Rule = { id: "b", label: "big", action: "route", dest: "Big", predicate: { largerThanBytes: 500 }, destructive: false };
  const dup: Rule = { id: "d", label: "dup", action: "quarantine", predicate: { duplicate: true }, destructive: true };
  const ext: Rule = { id: "e", label: "pdf", action: "route", dest: "Docs", predicate: { ext: "pdf" }, destructive: false };

  test("junk glob match", () => {
    expect(ruleMatches(junk, facts())).toBe(true);
    expect(ruleMatches(junk, facts({ name: "a.txt" }))).toBe(false);
  });
  test("symlinks never match", () => {
    expect(ruleMatches(junk, facts({ isSymlink: true }))).toBe(false);
  });
  test("stale by age (strict greater-than)", () => {
    expect(ruleMatches(stale, facts({ mtimeMs: 0 }), { now: 2000 })).toBe(true);
    expect(ruleMatches(stale, facts({ mtimeMs: 1500 }), { now: 2000 })).toBe(false);
  });
  test("size threshold (strict greater-than)", () => {
    expect(ruleMatches(big, facts({ size: 600 }))).toBe(true);
    expect(ruleMatches(big, facts({ size: 500 }))).toBe(false);
  });
  test("exact ext match", () => {
    expect(ruleMatches(ext, facts({ ext: "pdf", name: "a.pdf" }))).toBe(true);
    expect(ruleMatches(ext, facts({ ext: "txt" }))).toBe(false);
  });
  test("duplicate requires isDuplicate flag", () => {
    expect(ruleMatches(dup, facts(), { now: Date.now(), isDuplicate: true })).toBe(true);
    expect(ruleMatches(dup, facts(), { now: Date.now(), isDuplicate: false })).toBe(false);
  });
  test("hardlinks excluded from dedup-delete", () => {
    expect(ruleMatches(dup, facts({ nlink: 2 }), { now: Date.now(), isDuplicate: true })).toBe(false);
  });
  test("a clauseless predicate never matches everything", () => {
    const empty: Rule = { id: "x", label: "x", action: "route", predicate: {}, destructive: false };
    expect(ruleMatches(empty, facts())).toBe(false);
  });
  test("combined clauses are AND", () => {
    const combo: Rule = { id: "c", label: "c", action: "quarantine", predicate: { glob: "*.log", olderThanMs: 1000 }, destructive: true };
    expect(ruleMatches(combo, facts({ name: "a.log", mtimeMs: 0 }), { now: 5000 })).toBe(true);
    expect(ruleMatches(combo, facts({ name: "a.log", mtimeMs: 4500 }), { now: 5000 })).toBe(false);
    expect(ruleMatches(combo, facts({ name: "a.txt", mtimeMs: 0 }), { now: 5000 })).toBe(false);
  });
});

describe("extOf", () => {
  test("strips dot + lowercases", () => {
    expect(extOf("A.TMP")).toBe("tmp");
    expect(extOf("noext")).toBe("");
    expect(extOf(".dotfile")).toBe("");
  });
});

describe("presets", () => {
  test("four named presets", () => {
    expect(PRESET_NAMES.sort()).toEqual(["downloads-router", "duplicate-killer", "junk-sweep", "stale-archiver"]);
  });
  test("expandPresets skips unknown names", () => {
    const rules = expandPresets(["junk-sweep", "bogus"]);
    expect(rules.length).toBe(PRESETS["junk-sweep"]!.length);
  });
  test("junk-sweep rules are destructive; router rules are not", () => {
    expect(PRESETS["junk-sweep"]!.every((r) => r.destructive)).toBe(true);
    expect(PRESETS["downloads-router"]!.every((r) => !r.destructive)).toBe(true);
  });

  test("junk-tmp has a min-age dwell guard (atomic-writer safety)", () => {
    const tmpRule = PRESETS["junk-sweep"]!.find((r) => r.id === "junk-tmp")!;
    expect(tmpRule.predicate.olderThanMs).toBe(JUNK_TMP_MIN_AGE_MS);
    // A FRESH .tmp (just created) must NOT match — it could be an
    // atomic-writer's write-temp→rename in flight.
    const now = 1_000_000_000;
    const fresh = facts({ name: "x.tmp", ext: "tmp", mtimeMs: now });
    expect(ruleMatches(tmpRule, fresh, { now })).toBe(false);
    // An OLD .tmp (well past the dwell window) IS swept.
    const old = facts({ name: "x.tmp", ext: "tmp", mtimeMs: now - JUNK_TMP_MIN_AGE_MS - 1 });
    expect(ruleMatches(tmpRule, old, { now })).toBe(true);
    // .bak/.DS_Store have no atomic-writer pattern ⇒ no age gate (match fresh).
    const bakRule = PRESETS["junk-sweep"]!.find((r) => r.id === "junk-bak")!;
    expect(bakRule.predicate.olderThanMs).toBeUndefined();
    expect(ruleMatches(bakRule, facts({ name: "x.bak", ext: "bak", mtimeMs: now }), { now })).toBe(true);
  });
});

describe("mini-DSL parser", () => {
  test("valid quarantine rule", () => {
    const r = parseDsl("*.tmp older 7d -> quarantine");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rule.action).toBe("quarantine");
      expect(r.rule.destructive).toBe(true);
      expect(r.rule.predicate.glob).toBe("*.tmp");
      expect(r.rule.predicate.olderThanMs).toBe(7 * 24 * 60 * 60 * 1000);
    }
  });
  test("valid routing rule with size", () => {
    const r = parseDsl("*.zip larger 100mb -> Archives");
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.rule.action).toBe("route");
      expect(r.rule.dest).toBe("Archives");
      expect(r.rule.predicate.largerThanBytes).toBe(100 * 1024 * 1024);
    }
  });
  test("hours duration", () => {
    const r = parseDsl("*.part older 12h -> quarantine");
    expect(r.ok && r.rule.predicate.olderThanMs).toBe(12 * 60 * 60 * 1000);
  });
  test("every size unit parses (gb / mb / kb / bare bytes)", () => {
    const bytes = (line: string): number | undefined => {
      const r = parseDsl(line);
      return r.ok ? r.rule.predicate.largerThanBytes : undefined;
    };
    expect(bytes("*.a larger 2gb -> X")).toBe(2 * 1024 ** 3);
    expect(bytes("*.b larger 3mb -> X")).toBe(3 * 1024 ** 2);
    expect(bytes("*.c larger 4kb -> X")).toBe(4 * 1024); // kb branch
    expect(bytes("*.d larger 500b -> X")).toBe(500); // bare-bytes default branch
  });
  test("deterministic rule id for the same input", () => {
    const a = parseDsl("*.tmp -> quarantine");
    const b = parseDsl("*.tmp -> quarantine");
    expect(a.ok && b.ok && a.rule.id === b.rule.id).toBe(true);
  });

  test.each([
    ["", "empty rule"],
    ["*.tmp older 7d", "missing '-> destination'"],
    ["*.tmp -> ", "missing destination after '->'"],
    ["-> quarantine", "missing file pattern"],
    ["*.tmp older -> quarantine", "'older' needs a duration"],
    ["*.tmp older 7x -> quarantine", "invalid duration"],
    ["*.tmp larger -> quarantine", "'larger' needs a size"],
    ["*.tmp larger 5tb -> quarantine", "invalid size"],
    ["*.tmp bogus -> quarantine", "unexpected token"],
  ])("malformed %p → error", (input, fragment) => {
    const r = parseDsl(input);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(fragment);
  });

  test("over-long rule rejected", () => {
    const r = parseDsl("a".repeat(MAX_NAME_LENGTH + 5) + " -> quarantine");
    expect(r.ok).toBe(false);
  });
  test("control-char glob rejected", () => {
    const r = parseDsl("a\tb -> quarantine");
    // a tab splits into tokens differently; use an embedded NUL instead.
    expect(parseDsl("a\x00b -> quarantine").ok).toBe(false);
    void r;
  });
});
