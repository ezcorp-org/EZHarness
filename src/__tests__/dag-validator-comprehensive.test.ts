import { test, expect, describe, beforeEach } from "bun:test";
import { detectCycle } from "../runtime/dag-validator";

describe("detectCycle", () => {
  let allRefs: Map<string, string[]>;

  beforeEach(() => {
    allRefs = new Map();
  });

  // ── Unit Tests ──────────────────────────────────────────────────────

  describe("diamond dependency (no cycle)", () => {
    test("A->B, A->C, B->D, C->D has no cycle", () => {
      allRefs.set("researcher", ["writer", "reviewer"]);
      allRefs.set("writer", ["editor"]);
      allRefs.set("reviewer", ["editor"]);
      allRefs.set("editor", []);

      const result = detectCycle("researcher", ["writer", "reviewer"], allRefs);
      expect(result).toBeNull();
    });
  });

  describe("deep chain (no cycle)", () => {
    test("A->B->C->D->E linear chain has no cycle", () => {
      allRefs.set("researcher", ["writer"]);
      allRefs.set("writer", ["reviewer"]);
      allRefs.set("reviewer", ["editor"]);
      allRefs.set("editor", ["summarizer"]);
      allRefs.set("summarizer", []);

      const result = detectCycle("researcher", ["writer"], allRefs);
      expect(result).toBeNull();
    });
  });

  describe("deep chain with back-edge (cycle)", () => {
    test("A->B->C->D->E->B creates a cycle", () => {
      allRefs.set("researcher", ["writer"]);
      allRefs.set("writer", ["reviewer"]);
      allRefs.set("reviewer", ["editor"]);
      allRefs.set("editor", ["summarizer"]);
      allRefs.set("summarizer", ["writer"]); // back-edge

      const result = detectCycle("researcher", ["writer"], allRefs);
      expect(result).not.toBeNull();
      expect(result!.length).toBeGreaterThanOrEqual(2);
      // Cycle should contain writer since that's where the back-edge points
      expect(result!).toContain("writer");
    });
  });

  describe("multiple independent trees (no cycle)", () => {
    test("two separate trees have no cycle", () => {
      // Tree 1: researcher -> writer -> editor
      allRefs.set("researcher", ["writer"]);
      allRefs.set("writer", ["editor"]);
      allRefs.set("editor", []);
      // Tree 2: summarizer -> translator
      allRefs.set("summarizer", ["translator"]);
      allRefs.set("translator", []);

      const result = detectCycle("researcher", ["writer"], allRefs);
      expect(result).toBeNull();

      const result2 = detectCycle("summarizer", ["translator"], allRefs);
      expect(result2).toBeNull();
    });
  });

  describe("star topology (no cycle)", () => {
    test("A->B, A->C, A->D, A->E has no cycle", () => {
      allRefs.set("writer", []);
      allRefs.set("reviewer", []);
      allRefs.set("editor", []);
      allRefs.set("summarizer", []);

      const result = detectCycle("researcher", ["writer", "reviewer", "editor", "summarizer"], allRefs);
      expect(result).toBeNull();
    });
  });

  describe("adding edge that completes cycle", () => {
    test("adding editor->researcher in chain researcher->writer->editor creates cycle", () => {
      allRefs.set("researcher", ["writer"]);
      allRefs.set("writer", ["editor"]);
      allRefs.set("editor", []);

      // Adding editor -> researcher should create cycle
      const result = detectCycle("editor", ["researcher"], allRefs);
      expect(result).not.toBeNull();
      expect(result).toContain("editor");
      expect(result).toContain("researcher");
    });
  });

  describe("self-reference in middle of chain", () => {
    test("agent referencing itself is a cycle", () => {
      allRefs.set("researcher", ["writer"]);
      allRefs.set("writer", []);
      allRefs.set("reviewer", []);

      const result = detectCycle("writer", ["writer"], allRefs);
      expect(result).not.toBeNull();
      expect(result).toEqual(["writer", "writer"]);
    });
  });

  describe("restores allRefs map state after detection", () => {
    test("map is unchanged after cycle detection on complex graph", () => {
      allRefs.set("researcher", ["writer"]);
      allRefs.set("writer", ["reviewer"]);
      allRefs.set("reviewer", ["editor"]);
      allRefs.set("editor", []);
      allRefs.set("summarizer", []);

      const before = new Map(allRefs);

      // Try adding a cycle
      detectCycle("editor", ["researcher"], allRefs);

      // allRefs should be restored
      expect(allRefs.get("editor")).toEqual([]);
      expect(allRefs).toEqual(before);
    });

    test("restores when agent had no prior entry", () => {
      allRefs.set("researcher", ["writer"]);
      allRefs.set("writer", []);

      detectCycle("translator", ["researcher"], allRefs);

      // translator should not exist in the map
      expect(allRefs.has("translator")).toBe(false);
    });
  });

  describe("empty references array", () => {
    test("empty references never creates a cycle", () => {
      allRefs.set("researcher", ["writer"]);
      allRefs.set("writer", []);

      const result = detectCycle("researcher", [], allRefs);
      expect(result).toBeNull();
    });
  });

  describe("agent referencing non-existent agents", () => {
    test("referencing agents not in allRefs does not cycle", () => {
      allRefs.set("researcher", []);

      const result = detectCycle("researcher", ["ghost-agent", "phantom"], allRefs);
      expect(result).toBeNull();
    });
  });

  describe("simultaneous multiple cycles", () => {
    test("returns first found cycle in graph with multiple cycles", () => {
      // Create graph: researcher -> writer -> researcher (cycle 1)
      //               researcher -> reviewer -> editor -> researcher (cycle 2)
      allRefs.set("writer", ["researcher"]);
      allRefs.set("reviewer", ["editor"]);
      allRefs.set("editor", ["researcher"]);

      const result = detectCycle("researcher", ["writer", "reviewer"], allRefs);
      expect(result).not.toBeNull();
      // Should find a cycle containing researcher
      expect(result).toContain("researcher");
    });
  });

  // ── Integration Test ────────────────────────────────────────────────

  describe("multi-agent pipeline integration", () => {
    test("valid pipeline then cycle attempt", () => {
      // Build pipeline: researcher -> writer -> editor
      allRefs.set("researcher", ["writer"]);
      allRefs.set("writer", ["editor"]);
      allRefs.set("editor", []);

      // reviewer references writer (valid)
      const r1 = detectCycle("reviewer", ["writer"], allRefs);
      expect(r1).toBeNull();
      // Persist it
      allRefs.set("reviewer", ["writer"]);

      // summarizer references editor (valid)
      const r2 = detectCycle("summarizer", ["editor"], allRefs);
      expect(r2).toBeNull();
      allRefs.set("summarizer", ["editor"]);

      // translator references summarizer (valid)
      const r3 = detectCycle("translator", ["summarizer"], allRefs);
      expect(r3).toBeNull();
      allRefs.set("translator", ["summarizer"]);

      // Now try to make editor reference researcher (creates cycle)
      const r4 = detectCycle("editor", ["researcher"], allRefs);
      expect(r4).not.toBeNull();
      expect(r4).toContain("editor");
      expect(r4).toContain("researcher");

      // Verify allRefs is still clean
      expect(allRefs.get("editor")).toEqual([]);
    });
  });
});
