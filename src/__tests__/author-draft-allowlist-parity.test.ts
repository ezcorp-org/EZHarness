import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { SCAFFOLD_DRAFT_FILES } from "../db/queries/ez-drafts";
import { scaffoldExtension } from "@ezcorp/sdk/scaffold";
import { validateWorkspaceFiles } from "@ezcorp/extension-contract";
import { discoverFirstPartyManifest } from "./helpers/first-party-manifest";

const root = join(import.meta.dir, "..", "..");

function webAllowlist(): string[] {
  const source = readFileSync(join(root, "web/src/lib/server/author-draft-files.ts"), "utf8");
  const start = source.indexOf("const AUTHOR_DRAFT_FILES");
  const end = source.indexOf("]);", start);
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return [...source.slice(start, end).matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
}

describe("draft import compatibility and v4 authoring boundary", () => {
  test("legacy host materialize and web read gates retain the same source files", () => {
    expect(webAllowlist().sort()).toEqual([...SCAFFOLD_DRAFT_FILES].sort());
  });

  test("the bundled diagnostic has no authority to edit drafts or install releases", async () => {
    const manifest = await discoverFirstPartyManifest(join(root, "docs/extensions/examples/extension-author"));
    expect(manifest.permissions).toEqual({});
    expect((manifest.tools ?? []).map((tool) => tool.name)).toEqual(["migration_status"]);
    expect(manifest.smokeTest?.expect?.textIncludes).toBe("EXTENSION_AUTHOR_MOVED_TO_HOST");
  });

  test("v4 generated source uses workspaces, not the retired draft allowlist", () => {
    for (const type of ["tool", "skill", "agent", "multi"] as const) {
      const { files } = scaffoldExtension({ name: "parity-probe", type, description: "workspace parity probe" });
      expect(validateWorkspaceFiles(files)).toEqual(files);
      expect(Object.keys(files).filter((path) => !SCAFFOLD_DRAFT_FILES.has(path)).sort()).toEqual(["extension.test.ts", "extension.ts"]);
      expect(files["index.ts"]).toBeUndefined();
      expect(files["extension.ts"]).toContain("serve(");
    }
  });

  test("legacy draft imports retain the documented seven keys", () => {
    expect([...SCAFFOLD_DRAFT_FILES].sort()).toEqual([".gitignore", "README.md", "ezcorp.config.ts", "index.test.ts", "index.ts", "package.json", "tsconfig.json"]);
  });
});
