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
  "extension.test.ts",
  "extension.ts",
  "package.json",
  "tsconfig.json",
];

const FILES_WITHOUT_INDEX = [
  "extension.ts",
  ".gitignore",
  "README.md",
  "ezcorp.config.ts",
  "extension.test.ts",
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

  test("skill includes discovery entrypoint", async () => {
    await initExtension({ extName: "wisdom", type: "skill", description: "x", cwd: tmp });
    const files = readdirSync(join(tmp, "wisdom")).sort();
    expect(files).toEqual([...FILES_WITHOUT_INDEX].sort());
  });

  test("agent includes discovery entrypoint", async () => {
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
    expect(cfg).toContain('"name": "weather"');
  });

  test("package.json picks up name + description", async () => {
    await initExtension({ extName: "weather", type: "tool", description: "Get weather", cwd: tmp });
    const pkg = JSON.parse(readFileSync(join(tmp, "weather", "package.json"), "utf8"));
    expect(pkg.name).toBe("weather");
    expect(pkg.description).toBe("Get weather");
    expect(pkg.peerDependencies["@ezcorp/sdk"]).toBe("0.1.0");
  });

  test("tool entrypoint uses validated SDK transport", async () => {
    await initExtension({ extName: "weather", type: "tool", description: "x", cwd: tmp });
    const idx = readFileSync(join(tmp, "weather", "extension.ts"), "utf8");
    expect(idx).not.toContain("Bun.stdin.stream()");
    expect(idx).toContain("serve(");
    expect(idx).toContain("defineExtension(");
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
