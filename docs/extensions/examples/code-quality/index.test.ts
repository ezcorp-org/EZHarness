import { test, expect, describe } from "bun:test";
import manifest from "./ezcorp.config";

describe("code-quality", () => {
  test("manifest has required fields", () => {
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.name).toBe("code-quality");
    expect(manifest.version).toBe("1.0.0");
    expect(manifest.author.name).toBe("EzCorp");
  });

  test("declares two tools", () => {
    expect(manifest.tools).toHaveLength(2);
    expect(manifest.tools?.[0]?.name).toBe("analyzeFile");
    expect(manifest.tools?.[1]?.name).toBe("analyzeDirectory");
  });

  test("has entrypoint", () => {
    expect(manifest.entrypoint).toBe("./index.ts");
  });

  test("declares preuninstall script", () => {
    expect(manifest.scripts?.preuninstall).toBe("./scripts/preuninstall.ts");
  });

  test("depends on project-analyzer", () => {
    expect(manifest.dependencies?.["project-analyzer"]).toBeDefined();
    expect(manifest.dependencies?.["project-analyzer"].version).toBe("^1.0.0");
  });
});
