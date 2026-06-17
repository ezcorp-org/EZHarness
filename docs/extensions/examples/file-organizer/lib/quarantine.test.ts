import { describe, expect, test } from "bun:test";
import {
  QUARANTINE_SCHEMA_VERSION,
  emptyManifest,
  planQuarantine,
  planRestore,
  recordQuarantine,
  removeEntry,
  resolveNonOverwrite,
  selectPruneVictims,
  type QuarantineEntry,
  type QuarantineManifest,
} from "./quarantine";

describe("resolveNonOverwrite", () => {
  test("returns the path unchanged when free", () => {
    expect(resolveNonOverwrite("/a/b.txt", () => false)).toBe("/a/b.txt");
  });
  test("inserts ' (2)' before the extension on collision", () => {
    const taken = new Set(["/a/b.txt"]);
    expect(resolveNonOverwrite("/a/b.txt", (p) => taken.has(p))).toBe("/a/b (2).txt");
  });
  test("walks to the next free index", () => {
    const taken = new Set(["/a/b.txt", "/a/b (2).txt", "/a/b (3).txt"]);
    expect(resolveNonOverwrite("/a/b.txt", (p) => taken.has(p))).toBe("/a/b (4).txt");
  });
  test("handles extension-less names", () => {
    const taken = new Set(["/a/README"]);
    expect(resolveNonOverwrite("/a/README", (p) => taken.has(p))).toBe("/a/README (2)");
  });
  test("falls back to a timestamp suffix when every index is taken", () => {
    // `exists` always true ⇒ the 2..9999 loop is exhausted and the
    // timestamp tail (`name (<ms>).ext`) is returned.
    const out = resolveNonOverwrite("/a/b.txt", () => true);
    expect(/^\/a\/b \(\d{10,}\)\.txt$/.test(out)).toBe(true);
  });
});

describe("planQuarantine", () => {
  test("builds trash dir + entry with TTL", () => {
    const plan = planQuarantine(
      { trashRoot: "/d/.trash", id: "q1", originalPath: "/w/junk.tmp", proposalId: "p1", reason: "junk", batchId: null, size: 50, now: 1000, ttlMs: 5000 },
      () => false,
    );
    expect(plan.trashDir).toBe("/d/.trash/q1");
    expect(plan.trashPath).toBe("/d/.trash/q1/junk.tmp");
    expect(plan.entry.expiresAtMs).toBe(6000);
    expect(plan.entry.originalPath).toBe("/w/junk.tmp");
    expect(plan.entry.deletedAt).toBe(new Date(1000).toISOString());
  });
  test("collision inside trash dir gets a suffix", () => {
    const taken = new Set(["/d/.trash/q1/a.tmp"]);
    const plan = planQuarantine(
      { trashRoot: "/d/.trash", id: "q1", originalPath: "/w/a.tmp", proposalId: null, reason: "r", batchId: "b1", size: 1, now: 0, ttlMs: 1 },
      (p) => taken.has(p),
    );
    expect(plan.trashPath).toBe("/d/.trash/q1/a (2).tmp");
    expect(plan.entry.batchId).toBe("b1");
  });
});

describe("manifest record/remove/restore", () => {
  function withEntry(): { manifest: QuarantineManifest; entry: QuarantineEntry } {
    const entry: QuarantineEntry = {
      id: "q1", originalPath: "/w/a.txt", trashPath: "/d/.trash/q1/a.txt",
      proposalId: "p1", reason: "junk", deletedAt: new Date(0).toISOString(),
      batchId: null, size: 10, expiresAtMs: 1000,
    };
    return { manifest: recordQuarantine(emptyManifest(), entry), entry };
  }

  test("emptyManifest shape", () => {
    expect(emptyManifest().entries).toHaveLength(0);
    expect(emptyManifest().schemaVersion).toBe(QUARANTINE_SCHEMA_VERSION);
  });
  test("recordQuarantine appends", () => {
    const { manifest } = withEntry();
    expect(manifest.entries).toHaveLength(1);
  });
  test("removeEntry by id", () => {
    const { manifest } = withEntry();
    expect(removeEntry(manifest, "q1").entries).toHaveLength(0);
    expect(removeEntry(manifest, "nope").entries).toHaveLength(1);
  });
  test("planRestore resolves collision + returns entry", () => {
    const { manifest } = withEntry();
    const taken = new Set(["/w/a.txt"]);
    const plan = planRestore(manifest, "q1", (p) => taken.has(p));
    expect(plan).not.toBeNull();
    expect(plan!.restorePath).toBe("/w/a (2).txt");
    expect(plan!.trashPath).toBe("/d/.trash/q1/a.txt");
  });
  test("planRestore returns null for unknown id", () => {
    const { manifest } = withEntry();
    expect(planRestore(manifest, "zzz", () => false)).toBeNull();
  });
});

describe("selectPruneVictims", () => {
  function entry(id: string, opts: Partial<QuarantineEntry>): QuarantineEntry {
    return {
      id, originalPath: `/w/${id}`, trashPath: `/d/.trash/${id}/x`, proposalId: null,
      reason: "r", deletedAt: new Date(0).toISOString(), batchId: null, size: 100,
      expiresAtMs: 10_000, ...opts,
    };
  }

  test("TTL sweep selects expired entries", () => {
    const m: QuarantineManifest = { schemaVersion: 1, entries: [entry("a", { expiresAtMs: 500 }), entry("b", { expiresAtMs: 5000 })] };
    expect(selectPruneVictims(m, { now: 1000, capBytes: 0 })).toEqual(["a"]);
  });
  test("size cap evicts oldest-first until under cap", () => {
    const m: QuarantineManifest = {
      schemaVersion: 1,
      entries: [
        entry("old", { size: 100, deletedAt: new Date(1).toISOString(), expiresAtMs: 1e12 }),
        entry("mid", { size: 100, deletedAt: new Date(2).toISOString(), expiresAtMs: 1e12 }),
        entry("new", { size: 100, deletedAt: new Date(3).toISOString(), expiresAtMs: 1e12 }),
      ],
    };
    // 300 total, cap 150 → evict oldest-first until <=150: old (→200), mid (→100).
    expect(selectPruneVictims(m, { now: 0, capBytes: 150 }).sort()).toEqual(["mid", "old"]);
    // cap 250 → only the oldest needs to go.
    expect(selectPruneVictims(m, { now: 0, capBytes: 250 })).toEqual(["old"]);
  });
  test("cap 0 disables size eviction", () => {
    const m: QuarantineManifest = { schemaVersion: 1, entries: [entry("a", { size: 1e9, expiresAtMs: 1e12 })] };
    expect(selectPruneVictims(m, { now: 0, capBytes: 0 })).toHaveLength(0);
  });
  test("protectedIds are never selected", () => {
    const m: QuarantineManifest = { schemaVersion: 1, entries: [entry("a", { expiresAtMs: 1 })] };
    expect(selectPruneVictims(m, { now: 1000, capBytes: 0, protectedIds: new Set(["a"]) })).toHaveLength(0);
  });
  test("TTL + cap combine without double-listing", () => {
    const m: QuarantineManifest = {
      schemaVersion: 1,
      entries: [
        entry("expired", { expiresAtMs: 1, size: 100 }),
        entry("big1", { expiresAtMs: 1e12, size: 100, deletedAt: new Date(1).toISOString() }),
        entry("big2", { expiresAtMs: 1e12, size: 100, deletedAt: new Date(2).toISOString() }),
      ],
    };
    const victims = selectPruneVictims(m, { now: 1000, capBytes: 100 });
    expect(victims).toContain("expired");
    expect(new Set(victims).size).toBe(victims.length);
  });
});
