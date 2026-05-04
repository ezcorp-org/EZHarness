import { test, expect, describe, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeReport, type FeatureVerdict } from "../runtime/audit/report";
import type { FeatureClassification, SurfaceVerdicts } from "../db/schema";

let projectRoot: string;

beforeAll(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "audit-report-"));
});

afterAll(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function verdict(name: string, surfaces: Partial<SurfaceVerdicts> = {}, fromCache = false): FeatureVerdict {
  const filled: SurfaceVerdicts = {
    sdk: surfaces.sdk ?? { exposed: false, via: "precheck" },
    ezbutton: surfaces.ezbutton ?? { exposed: false, via: "precheck" },
    mcp: surfaces.mcp ?? { exposed: false, via: "precheck" },
  };
  return {
    feature: { id: `id-${name}`, name, description: "" },
    surfaces: filled,
    rationale: "",
    fromCache,
  };
}

describe("writeReport", () => {
  test("writes file under .ezcorp/audit-reports with date in name", async () => {
    const path = await writeReport({
      projectId: "p1",
      projectName: "My Project",
      projectRoot,
      verdicts: [verdict("foo")],
      prevClassifications: [],
      now: new Date("2026-05-03T00:00:00Z"),
    });
    expect(path).toContain(".ezcorp/audit-reports/");
    expect(path).toContain("my-project-2026-05-03.md");
    const text = readFileSync(path, "utf8");
    expect(text).toContain("# Surface Coverage Audit");
    expect(text).toContain("My Project");
  });

  test("summary table contains one row per feature with ✓/✗ marks", async () => {
    const path = await writeReport({
      projectId: "p1",
      projectName: "tbl",
      projectRoot,
      verdicts: [
        verdict("alpha", { sdk: { exposed: true, via: "precheck" } }),
        verdict("beta", { mcp: { exposed: true, via: "llm" } }),
      ],
      prevClassifications: [],
    });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("| alpha |");
    expect(text).toContain("| beta |");
    expect(text).toContain("✓");
    expect(text).toContain("✗");
  });

  test("missing-surface gap sections list features that lack each surface", async () => {
    const path = await writeReport({
      projectId: "p1",
      projectName: "gaps",
      projectRoot,
      verdicts: [
        verdict("has-sdk", { sdk: { exposed: true, via: "precheck", evidence: "config" } }),
        verdict("nothing"),
      ],
      prevClassifications: [],
    });
    const text = readFileSync(path, "utf8");
    expect(text).toMatch(/Missing SDK exposure[\s\S]*nothing/);
    expect(text).toMatch(/Missing EzButton exposure[\s\S]*has-sdk[\s\S]*nothing/);
    expect(text).toMatch(/Missing MCP exposure[\s\S]*has-sdk[\s\S]*nothing/);
  });

  test("delta section shows _No prior run_ when prev is empty", async () => {
    const path = await writeReport({
      projectId: "p1",
      projectName: "noprev",
      projectRoot,
      verdicts: [verdict("x")],
      prevClassifications: [],
    });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("No prior run");
  });

  test("delta section reports verdict flips when prev provided", async () => {
    const prev: FeatureClassification[] = [{
      featureId: "id-x",
      contentHash: "old",
      surfaces: {
        sdk: { exposed: false, via: "precheck" },
        ezbutton: { exposed: false, via: "precheck" },
        mcp: { exposed: false, via: "precheck" },
      },
      rationale: "",
      classifiedAt: new Date(),
    }];
    const path = await writeReport({
      projectId: "p1",
      projectName: "delta",
      projectRoot,
      verdicts: [verdict("x", { sdk: { exposed: true, via: "precheck" } })],
      prevClassifications: prev,
    });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("Verdict flips");
    expect(text).toContain("sdk: ✗ → ✓");
  });

  test("summary header includes cache-hit and LLM counts", async () => {
    const path = await writeReport({
      projectId: "p1",
      projectName: "counts",
      projectRoot,
      verdicts: [
        verdict("a", { sdk: { exposed: true, via: "llm" } }, true),
        verdict("b", { mcp: { exposed: true, via: "llm" } }, false),
      ],
      prevClassifications: [],
    });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("2 features");
    expect(text).toContain("1 from cache");
    expect(text).toContain("LLM verdicts");
  });

  test("coverage notes section surfaces evidence for ✓ verdicts", async () => {
    const path = await writeReport({
      projectId: "p1",
      projectName: "notes",
      projectRoot,
      verdicts: [
        verdict("auto-note", {
          sdk: { exposed: true, via: "precheck", evidence: "docs/extensions/examples/auto-note/ezcorp.config.ts" },
          mcp: { exposed: true, via: "precheck", evidence: "docs/extensions/examples/auto-note/ezcorp.config.ts: covered by extension_search MCP meta-tool" },
        }),
      ],
      prevClassifications: [],
    });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("## Coverage notes");
    expect(text).toContain("**auto-note** · SDK ✓");
    expect(text).toContain("**auto-note** · MCP ✓");
    expect(text).toContain("extension_search");
  });

  test("coverage notes skips ✓ rows without evidence", async () => {
    const path = await writeReport({
      projectId: "p1",
      projectName: "no-evidence",
      projectRoot,
      verdicts: [verdict("bare-true", { sdk: { exposed: true, via: "precheck" } })],
      prevClassifications: [],
    });
    const text = readFileSync(path, "utf8");
    const notesIdx = text.indexOf("## Coverage notes");
    const deltaIdx = text.indexOf("## Delta from last run");
    const notesBlock = text.slice(notesIdx, deltaIdx);
    expect(notesBlock).not.toContain("**bare-true**");
  });

  test("truncated flag emits a warning header", async () => {
    const path = await writeReport({
      projectId: "p1",
      projectName: "trunc",
      projectRoot,
      verdicts: [verdict("a")],
      prevClassifications: [],
      truncated: true,
    });
    const text = readFileSync(path, "utf8");
    expect(text).toContain("truncated");
  });
});
