// Unit tests for src/runtime/task-dependencies.ts — the pure-function
// module extracted during Phase 3 commit-1 so the host's /start endpoint
// pre-start gate and the task-tracking bundled extension share one
// implementation.
//
// This file REPLACES the legacy tool-surface tests that lived here. The
// dependsOn behavior they covered is still exercised through the built-in
// task-tracking tool suite (src/__tests__/task-tracking.test.ts,
// task-autostart.test.ts) until commit-5 deletes the built-in, at which
// point those suites are rewritten against the bundled extension and
// this file is the sole home for the pure-graph assertions.

import { test, expect, describe } from "bun:test";
import {
  detectCycle,
  isBlocked,
  unsatisfiedDeps,
  type ReadonlyTask,
  type ReadonlySnapshot,
} from "../runtime/task-dependencies";

function task(
  id: string,
  title: string,
  status: ReadonlyTask["status"],
  dependsOn?: string[],
): ReadonlyTask {
  return dependsOn ? { id, title, status, dependsOn } : { id, title, status };
}

function snap(tasks: ReadonlyTask[]): ReadonlySnapshot {
  return { tasks };
}

// ── unsatisfiedDeps ────────────────────────────────────────────────

describe("unsatisfiedDeps", () => {
  test("no dependsOn → []", () => {
    const t = task("a", "A", "pending");
    expect(unsatisfiedDeps(t, snap([t]))).toEqual([]);
  });

  test("all deps completed → []", () => {
    const a = task("a", "A", "completed");
    const b = task("b", "B", "pending", ["a"]);
    expect(unsatisfiedDeps(b, snap([a, b]))).toEqual([]);
  });

  test("one pending dep → returned", () => {
    const a = task("a", "A", "pending");
    const b = task("b", "B", "pending", ["a"]);
    const out = unsatisfiedDeps(b, snap([a, b]));
    expect(out).toHaveLength(1);
    expect(out[0]!.id).toBe("a");
  });

  test("unknown dep id is dropped (treated as satisfied)", () => {
    const b = task("b", "B", "pending", ["nonexistent"]);
    expect(unsatisfiedDeps(b, snap([b]))).toEqual([]);
  });

  test("active/failed deps count as unsatisfied (only 'completed' satisfies)", () => {
    const a = task("a", "A", "active");
    const b = task("b", "B", "failed");
    const c = task("c", "C", "pending", ["a", "b"]);
    const out = unsatisfiedDeps(c, snap([a, b, c]));
    expect(out.map((t) => t.id).sort()).toEqual(["a", "b"]);
  });
});

// ── isBlocked ──────────────────────────────────────────────────────

describe("isBlocked", () => {
  test("status != pending → never blocked", () => {
    const a = task("a", "A", "pending");
    const active = task("b", "B", "active", ["a"]);
    const completed = task("c", "C", "completed", ["a"]);
    const failed = task("d", "D", "failed", ["a"]);
    const s = snap([a, active, completed, failed]);
    expect(isBlocked(active, s)).toBe(false);
    expect(isBlocked(completed, s)).toBe(false);
    expect(isBlocked(failed, s)).toBe(false);
  });

  test("pending with no deps → not blocked", () => {
    const t = task("a", "A", "pending");
    expect(isBlocked(t, snap([t]))).toBe(false);
  });

  test("pending with pending deps → blocked", () => {
    const a = task("a", "A", "pending");
    const b = task("b", "B", "pending", ["a"]);
    expect(isBlocked(b, snap([a, b]))).toBe(true);
  });

  test("pending with all deps completed → not blocked", () => {
    const a = task("a", "A", "completed");
    const b = task("b", "B", "pending", ["a"]);
    expect(isBlocked(b, snap([a, b]))).toBe(false);
  });
});

// ── detectCycle ────────────────────────────────────────────────────

describe("detectCycle", () => {
  test("empty list → null", () => {
    expect(detectCycle([])).toBeNull();
  });

  test("acyclic chain → null", () => {
    const a = task("a", "A", "pending");
    const b = task("b", "B", "pending", ["a"]);
    const c = task("c", "C", "pending", ["b"]);
    expect(detectCycle([a, b, c])).toBeNull();
  });

  test("self-cycle → non-null with the task's title", () => {
    const a = task("a", "A", "pending", ["a"]);
    const cycle = detectCycle([a]);
    expect(cycle).not.toBeNull();
    expect(cycle!).toContain("A");
  });

  test("two-node cycle detected", () => {
    const a = task("a", "A", "pending", ["b"]);
    const b = task("b", "B", "pending", ["a"]);
    const cycle = detectCycle([a, b]);
    expect(cycle).not.toBeNull();
    expect(cycle!.includes("A")).toBe(true);
    expect(cycle!.includes("B")).toBe(true);
  });

  test("three-node cycle detected", () => {
    const a = task("a", "A", "pending", ["c"]);
    const b = task("b", "B", "pending", ["a"]);
    const c = task("c", "C", "pending", ["b"]);
    const cycle = detectCycle([a, b, c]);
    expect(cycle).not.toBeNull();
  });

  test("unknown dep is ignored (not a cycle)", () => {
    const a = task("a", "A", "pending", ["nonexistent"]);
    expect(detectCycle([a])).toBeNull();
  });

  test("diamond DAG → null (two paths, no back-edge)", () => {
    const a = task("a", "A", "pending");
    const b = task("b", "B", "pending", ["a"]);
    const c = task("c", "C", "pending", ["a"]);
    const d = task("d", "D", "pending", ["b", "c"]);
    expect(detectCycle([a, b, c, d])).toBeNull();
  });

  test("long acyclic chain does not overflow the stack (iterative DFS)", () => {
    const tasks: ReadonlyTask[] = [];
    for (let i = 0; i < 5000; i++) {
      tasks.push(
        i === 0
          ? task(`t${i}`, `T${i}`, "pending")
          : task(`t${i}`, `T${i}`, "pending", [`t${i - 1}`]),
      );
    }
    expect(detectCycle(tasks)).toBeNull();
  });

  test("cycle labels are non-empty strings when titles equal ids", () => {
    const a = task("a", "a", "pending", ["b"]);
    const b = task("b", "b", "pending", ["a"]);
    const cycle = detectCycle([a, b]);
    expect(cycle).not.toBeNull();
    expect(cycle!.every((s) => typeof s === "string" && s.length > 0)).toBe(true);
  });
});
