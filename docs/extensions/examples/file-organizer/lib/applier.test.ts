import { describe, expect, test } from "bun:test";
import { planApply, routeDestination, type PlanEnv } from "./applier";
import type { Proposal } from "./proposals";

function proposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    id: "p1",
    kind: "move",
    src: "/w/a.txt",
    dst: "/w/sub/a.txt",
    reason: "route",
    ruleId: "r1",
    ruleLabel: "Route",
    folderId: "f1",
    snapshot: { size: 10, mtimeMs: 1, isSymlink: false, dev: 1, ino: 2, nlink: 1 },
    status: "pending",
    dedupeKey: "k",
    createdAt: "2026-06-17T00:00:00.000Z",
    version: 0,
    ...overrides,
  };
}

const noEnv: PlanEnv = { exists: () => false };

describe("planApply — move/rename", () => {
  test("emits mkdirp + copy + verify + unlink (EXDEV-safe ordering)", () => {
    const r = planApply(proposal(), noEnv);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.ops.map((o) => o.op)).toEqual(["mkdirp", "copy", "verify", "unlink"]);
      const copy = r.plan.ops.find((o) => o.op === "copy");
      expect(copy).toEqual({ op: "copy", src: "/w/a.txt", dst: "/w/sub/a.txt" });
      const verify = r.plan.ops.find((o) => o.op === "verify");
      expect(verify).toEqual({ op: "verify", path: "/w/sub/a.txt", expectedSize: 10 });
      expect(r.plan.resolvedDst).toBe("/w/sub/a.txt");
    }
  });

  test("never overwrites — collision gets a suffix", () => {
    const taken = new Set(["/w/sub/a.txt"]);
    const r = planApply(proposal(), { exists: (p) => taken.has(p) });
    expect(r.ok && r.plan.resolvedDst).toBe("/w/sub/a (2).txt");
  });

  test("missing dst is a hard error (non-skip)", () => {
    const r = planApply(proposal({ dst: null }), noEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skip).toBeUndefined();
  });

  test("symlink → benign skip", () => {
    const r = planApply(proposal({ snapshot: { ...proposal().snapshot, isSymlink: true } }), noEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skip).toBe(true);
  });

  test("case-insensitive same-file → benign skip", () => {
    const r = planApply(proposal({ src: "/w/A.TXT", dst: "/w/a.txt" }), { exists: () => false, caseInsensitive: true });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skip).toBe(true);
  });

  test("case-sensitive same-name is NOT a same-file no-op", () => {
    const r = planApply(proposal({ src: "/w/A.TXT", dst: "/w/a.txt" }), { exists: () => false, caseInsensitive: false });
    expect(r.ok).toBe(true);
  });
});

describe("planApply — delete-quarantine", () => {
  test("emits a single quarantine op with a fresh id", () => {
    const r = planApply(proposal({ kind: "delete-quarantine", dst: null }), { exists: () => false, quarantineIdGen: () => "q9" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan.ops).toEqual([{ op: "quarantine", src: "/w/a.txt", quarantineId: "q9" }]);
      expect(r.plan.resolvedDst).toBeNull();
    }
  });
  test("reuses an existing quarantineId when present", () => {
    const r = planApply(proposal({ kind: "delete-quarantine", dst: null, quarantineId: "preset" }), noEnv);
    expect(r.ok && (r.plan.ops[0] as { quarantineId: string }).quarantineId).toBe("preset");
  });
});

describe("planApply — unclassified / unknown", () => {
  test("unclassified is not directly applyable", () => {
    const r = planApply(proposal({ kind: "unclassified", dst: null }), noEnv);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.skip).toBeUndefined();
  });
});

describe("routeDestination", () => {
  test("joins root + dest + basename", () => {
    expect(routeDestination("/watched", "Images", "/watched/a.png")).toBe("/watched/Images/a.png");
  });
});
