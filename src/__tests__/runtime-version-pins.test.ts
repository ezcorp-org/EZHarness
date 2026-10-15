import { describe, expect, test } from "bun:test";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..");

async function text(path: string): Promise<string> {
  return (await Bun.file(join(root, path)).text()).trim();
}

describe("factory runtime pins", () => {
  test("pins the verified Node and Python runtimes", async () => {
    expect(await text(".node-version")).toBe("24.14.1");
    expect(await text(".python-version")).toBe("3.13.12");
  });

  test.each([".github/workflows/ci.yml", ".github/workflows/release-sdk.yml"])(
    "%s reads the single Node pin",
    async (path) => {
      const workflow = await text(path);
      expect(workflow).toContain("node-version-file: .node-version");
      expect(workflow).not.toMatch(/node-version:\s*['"]?\d/);
    },
  );
});
