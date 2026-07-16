import { test, expect, describe } from "bun:test";
import {
  hasBlockingFindings,
  hasAskUserFindings,
  normalizeFindings,
  autoFixableFindings,
  filterFindings,
  summarizeSelectedFindings,
  isSelectedFindingsSummary,
  mergeUserOverrides,
  normalizeFindingsJSON,
  autoFixableFindingsJSON,
  hasAskUserFindingsJSON,
  filterFindingsJSON,
  mergeUserOverridesJSON,
  findingIDsJSON,
  marshalFindingIDs,
  combineSelectedFindingIDs,
  findingsCount,
  selectedFindingCount,
} from "./findings";
import { deserializeFindings, serializeFindings, type Findings } from "./runs";

function mk(items: unknown[], extra: Record<string, unknown> = {}): Findings {
  return deserializeFindings({ findings: items, ...extra });
}
function json(items: unknown[], extra: Record<string, unknown> = {}): string {
  return serializeFindings(mk(items, extra));
}

// ── predicates ──────────────────────────────────────────────────────

describe("hasBlockingFindings", () => {
  test("error/warning block; info alone does not", () => {
    expect(hasBlockingFindings(mk([{ severity: "info", description: "d", action: "no-op" }]).items)).toBe(false);
    expect(hasBlockingFindings(mk([{ severity: "warning", description: "d", action: "auto-fix" }]).items)).toBe(true);
    expect(hasBlockingFindings(mk([{ severity: "error", description: "d", action: "auto-fix" }]).items)).toBe(true);
    expect(hasBlockingFindings([])).toBe(false);
  });
});

describe("hasAskUserFindings", () => {
  test("true only when some action is ask-user", () => {
    expect(hasAskUserFindings(mk([{ severity: "info", description: "d", action: "no-op" }]))).toBe(false);
    expect(hasAskUserFindings(mk([{ severity: "info", description: "d", action: "ask-user" }]))).toBe(true);
  });
});

// ── selection + normalization ───────────────────────────────────────

describe("normalizeFindings", () => {
  test("assigns prefix-N ids only to items lacking one", () => {
    const f = normalizeFindings(
      mk([
        { severity: "info", description: "a", action: "no-op" },
        { id: "keep", severity: "info", description: "b", action: "no-op" },
      ]),
      "review",
    );
    expect(f.items[0]!.id).toBe("review-1");
    expect(f.items[1]!.id).toBe("keep");
  });
});

describe("autoFixableFindings", () => {
  test("keeps only auto-fix items", () => {
    const f = autoFixableFindings(
      mk([
        { severity: "warning", description: "a", action: "auto-fix" },
        { severity: "info", description: "b", action: "no-op" },
        { severity: "error", description: "c", action: "ask-user" },
      ]),
    );
    expect(f.items).toHaveLength(1);
    expect(f.items[0]!.description).toBe("a");
  });
});

describe("filterFindings", () => {
  const base = mk(
    [
      { id: "f1", severity: "warning", description: "a", action: "auto-fix" },
      { id: "f2", severity: "info", description: "b", action: "no-op" },
    ],
    { summary: "orig" },
  );
  test("empty ids → unchanged", () => {
    expect(filterFindings(base, [])).toBe(base);
  });
  test("subset selection rewrites summary", () => {
    const f = filterFindings(base, ["f1"]);
    expect(f.items).toHaveLength(1);
    expect(f.summary).toBe("1 selected finding");
  });
  test("selecting all keeps summary (no shrink)", () => {
    const f = filterFindings(base, ["f1", "f2"]);
    expect(f.summary).toBe("orig");
  });
});

describe("summarizeSelectedFindings", () => {
  test("0 / 1 / N phrasing", () => {
    expect(summarizeSelectedFindings(0)).toBe("0 selected findings");
    expect(summarizeSelectedFindings(1)).toBe("1 selected finding");
    expect(summarizeSelectedFindings(3)).toBe("3 selected findings");
  });
});

describe("isSelectedFindingsSummary", () => {
  test("recognizes machine phrasing, rejects prose", () => {
    expect(isSelectedFindingsSummary("0 selected findings")).toBe(true);
    expect(isSelectedFindingsSummary("1 selected finding")).toBe(true);
    expect(isSelectedFindingsSummary("5 selected findings")).toBe(true);
    expect(isSelectedFindingsSummary("some prose")).toBe(false);
    expect(isSelectedFindingsSummary(" selected findings")).toBe(false);
    expect(isSelectedFindingsSummary("x selected findings")).toBe(false);
  });
});

// ── mergeUserOverrides ──────────────────────────────────────────────

describe("mergeUserOverrides", () => {
  test("applies per-finding instructions", () => {
    const f = mergeUserOverrides(
      mk([{ id: "f1", severity: "warning", description: "a", action: "auto-fix" }]),
      { f1: "do it my way" },
      [],
    );
    expect(f.items[0]!.userInstructions).toBe("do it my way");
  });
  test("appends user findings: source=user, blank action→auto-fix, user-N ids on collision", () => {
    const f = mergeUserOverrides(
      mk([{ id: "user-1", severity: "warning", description: "existing", action: "auto-fix" }]),
      {},
      [
        { severity: "warning", description: "added-blank" }, // blank action → auto-fix
        { id: "user-1", severity: "error", description: "collide", action: "ask-user" }, // id taken → user-2
      ],
    );
    expect(f.items).toHaveLength(3);
    const added1 = f.items[1]!;
    expect(added1.source).toBe("user");
    expect(added1.action).toBe("auto-fix");
    expect(added1.id).toBe("user-2"); // user-1 is taken by the existing item
    const added2 = f.items[2]!;
    expect(added2.action).toBe("ask-user"); // explicit action preserved
    expect(added2.id).toBe("user-3");
  });
  test("rewrites a selected-findings summary when items are appended", () => {
    const base = mk([{ id: "f1", severity: "warning", description: "a", action: "auto-fix" }], {
      summary: "1 selected finding",
    });
    const f = mergeUserOverrides(base, {}, [{ severity: "info", description: "x" }]);
    expect(f.summary).toBe("2 selected findings");
  });
  test("unknown severity on an added finding → error; keeps explicit id when free", () => {
    const f = mergeUserOverrides(mk([]), {}, [
      { id: "mine", severity: "bogus", description: "x", action: "auto-fix" },
    ]);
    expect(f.items[0]!.severity).toBe("error");
    expect(f.items[0]!.id).toBe("mine");
  });
});

// ── JSON wrappers ───────────────────────────────────────────────────

describe("JSON wrappers", () => {
  test("normalizeFindingsJSON: empty → '' ; assigns ids otherwise", () => {
    expect(normalizeFindingsJSON("", "review")).toBe("");
    const out = normalizeFindingsJSON(json([{ severity: "info", description: "d", action: "no-op" }]), "review");
    expect(JSON.parse(out).findings[0].id).toBe("review-1");
  });
  test("autoFixableFindingsJSON: none → '' ; else only auto-fix", () => {
    expect(autoFixableFindingsJSON("")).toBe("");
    expect(autoFixableFindingsJSON(json([{ severity: "info", description: "d", action: "no-op" }]))).toBe("");
    const out = autoFixableFindingsJSON(json([{ severity: "warning", description: "d", action: "auto-fix" }]));
    expect(JSON.parse(out).findings).toHaveLength(1);
  });
  test("hasAskUserFindingsJSON: empty → false", () => {
    expect(hasAskUserFindingsJSON("")).toBe(false);
    expect(hasAskUserFindingsJSON(json([{ severity: "info", description: "d", action: "ask-user" }]))).toBe(true);
  });
  test("filterFindingsJSON: empty raw passthrough; empty ids → 0 selected", () => {
    expect(filterFindingsJSON("", ["f1"])).toBe("");
    const out = filterFindingsJSON(json([{ id: "f1", severity: "info", description: "d", action: "no-op" }]), []);
    const parsed = JSON.parse(out);
    expect(parsed.findings).toHaveLength(0);
    expect(parsed.summary).toBe("0 selected findings");
    const sel = filterFindingsJSON(
      json([
        { id: "f1", severity: "info", description: "d", action: "no-op" },
        { id: "f2", severity: "info", description: "e", action: "no-op" },
      ]),
      ["f2"],
    );
    expect(JSON.parse(sel).findings).toHaveLength(1);
  });
  test("mergeUserOverridesJSON: no overrides → input unchanged", () => {
    const raw = json([{ id: "f1", severity: "warning", description: "d", action: "auto-fix" }]);
    expect(mergeUserOverridesJSON(raw, {}, [])).toBe(raw);
    const merged = mergeUserOverridesJSON(raw, { f1: "note" }, [{ description: "added" }]);
    const parsed = JSON.parse(merged);
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0].user_instructions).toBe("note");
  });
  test("mergeUserOverridesJSON coerces a raw added finding (nonblank-unknown action → ask-user, numeric line)", () => {
    const merged = mergeUserOverridesJSON("", {}, [
      { severity: "warning", description: "raw", action: "bogus", line: 7 },
    ]);
    const added = JSON.parse(merged).findings[0];
    expect(added.action).toBe("ask-user"); // nonblank unrecognized action fails closed
    expect(added.line).toBe(7);
    expect(added.source).toBe("user");
  });
  test("findingIDsJSON + marshalFindingIDs", () => {
    expect(findingIDsJSON("")).toBe("");
    expect(marshalFindingIDs([])).toBe("");
    const out = findingIDsJSON(
      json([
        { id: "f1", severity: "info", description: "d", action: "no-op" },
        { severity: "info", description: "e", action: "no-op" }, // no id → skipped
      ]),
    );
    expect(JSON.parse(out)).toEqual(["f1"]);
  });
  test("combineSelectedFindingIDs: empty merged → selected; adds new user ids", () => {
    expect(combineSelectedFindingIDs(["a"], "")).toEqual(["a"]);
    const merged = json([
      { id: "a", severity: "info", description: "d", action: "no-op" },
      { id: "user-1", severity: "info", description: "e", action: "auto-fix", source: "user" },
      { severity: "info", description: "f", action: "no-op" }, // no id → skipped
    ]);
    expect(combineSelectedFindingIDs(["a"], merged)).toEqual(["a", "user-1"]);
  });
  test("findingsCount + selectedFindingCount (incl. malformed → 0)", () => {
    expect(findingsCount("")).toBe(0);
    expect(findingsCount("not-json")).toBe(0);
    const raw = json([
      { id: "f1", severity: "info", description: "d", action: "no-op" },
      { id: "f2", severity: "info", description: "e", action: "no-op" },
    ]);
    expect(findingsCount(raw)).toBe(2);
    expect(selectedFindingCount(raw, ["f1"])).toBe(1);
    expect(selectedFindingCount(raw, [])).toBe(2);
  });
});
