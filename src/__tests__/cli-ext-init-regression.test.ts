// Regression test for `bun run ext:init`.
//
// Pins the file set that initExtension() writes to disk so the
// scaffold.ts refactor (extracting the pure scaffolder behind
// `@ezcorp/sdk`) cannot silently drop a file or change the templates.
// If this test goes red, the CLI behavior diverged from the pre-refactor
// baseline — DO NOT relax assertions, fix the scaffolder.

import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initExtension } from "../extensions/sdk/init";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "ezcorp-cli-init-"));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

const FILES_WITH_INDEX = [
  ".gitignore",
  "README.md",
  "ezcorp.config.ts",
  "index.test.ts",
  "index.ts",
  "package.json",
  "tsconfig.json",
];

const FILES_WITHOUT_INDEX = [
  ".gitignore",
  "README.md",
  "ezcorp.config.ts",
  "index.test.ts",
  "package.json",
  "tsconfig.json",
];

describe("ext:init CLI — file set per type", () => {
  test("tool", async () => {
    await initExtension({ extName: "weather", type: "tool", description: "x", cwd: tmp });
    const files = readdirSync(join(tmp, "weather")).sort();
    expect(files).toEqual([...FILES_WITH_INDEX].sort());
  });

  test("multi", async () => {
    await initExtension({ extName: "combo", type: "multi", description: "x", cwd: tmp });
    const files = readdirSync(join(tmp, "combo")).sort();
    expect(files).toEqual([...FILES_WITH_INDEX].sort());
  });

  test("skill omits index.ts", async () => {
    await initExtension({ extName: "wisdom", type: "skill", description: "x", cwd: tmp });
    const files = readdirSync(join(tmp, "wisdom")).sort();
    expect(files).toEqual([...FILES_WITHOUT_INDEX].sort());
  });

  test("agent omits index.ts", async () => {
    await initExtension({ extName: "ducky", type: "agent", description: "x", cwd: tmp });
    const files = readdirSync(join(tmp, "ducky")).sort();
    expect(files).toEqual([...FILES_WITHOUT_INDEX].sort());
  });
});

describe("ext:init CLI — file content", () => {
  test("description flows into manifest", async () => {
    await initExtension({ extName: "weather", type: "tool", description: "Get weather", cwd: tmp });
    const cfg = readFileSync(join(tmp, "weather", "ezcorp.config.ts"), "utf8");
    expect(cfg).toContain("Get weather");
    expect(cfg).toContain('name: "weather"');
  });

  test("package.json picks up name + description", async () => {
    await initExtension({ extName: "weather", type: "tool", description: "Get weather", cwd: tmp });
    const pkg = JSON.parse(readFileSync(join(tmp, "weather", "package.json"), "utf8"));
    expect(pkg.name).toBe("weather");
    expect(pkg.description).toBe("Get weather");
    expect(pkg.dependencies["@ezcorp/sdk"]).toBeDefined();
  });

  test("tool's index.ts emits a JSON-RPC stdin reader", async () => {
    await initExtension({ extName: "weather", type: "tool", description: "x", cwd: tmp });
    const idx = readFileSync(join(tmp, "weather", "index.ts"), "utf8");
    expect(idx).toContain("Bun.stdin.stream()");
    expect(idx).toContain("handleRequest");
    expect(idx).toContain("tools/call");
  });
});

describe("ext:init CLI — error paths", () => {
  test("collision: existing directory throws", async () => {
    await initExtension({ extName: "first", type: "tool", description: "x", cwd: tmp });
    await expect(
      initExtension({ extName: "first", type: "tool", description: "x", cwd: tmp }),
    ).rejects.toThrow(/already exists/);
  });

  test("missing extName throws", async () => {
    await expect(initExtension({ cwd: tmp } as never)).rejects.toThrow(/Extension name required/);
  });
});
