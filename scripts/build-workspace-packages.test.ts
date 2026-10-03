import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildOrder, buildWorkspacePackages, readWorkspacePackages, type WorkspacePackage } from "./build-workspace-packages.ts";

const ROOT = resolve(import.meta.dir, "..");
const pkg = (name: string, dependsOn: string[] = [], hasBuild = true): WorkspacePackage => ({ directory: `packages/${name}`, name, hasBuild, dependsOn });

describe("the workspace build order", () => {
  test("this repository builds every package with a build script, each after its workspace dependencies", () => {
    const packages = readWorkspacePackages(ROOT);
    const order = buildOrder(packages).map(p => p.name);
    expect(order.sort()).toEqual(packages.filter(p => p.hasBuild).map(p => p.name).sort());
    const position = new Map(buildOrder(packages).map((p, index) => [p.name, index]));
    for (const p of packages.filter(candidate => candidate.hasBuild)) {
      for (const dependency of p.dependsOn) {
        if (position.has(dependency)) expect(position.get(dependency)!).toBeLessThan(position.get(p.name)!);
      }
    }
    expect(order).toEqual(expect.arrayContaining(["@ezcorp/sdk", "@ezcorp/factory-sdk", "@ezcorp/factory-transport", "@ezcorp/factory-orchestrator", "@ezcorp/extension-contract", "@ezcorp/harness-client"]));
  });

  test("orders by dependency, ties by directory, through packages that have no build", () => {
    const packages = [pkg("d", ["b"]), pkg("c", ["kit"]), pkg("kit", ["a"], false), pkg("b", ["a"]), pkg("a")];
    expect(buildOrder(packages).map(p => p.name)).toEqual(["a", "b", "c", "d"]);
  });

  test("refuses a dependency cycle, naming it", () => {
    expect(() => buildOrder([pkg("a", ["b"]), pkg("b", ["c"]), pkg("c", ["a"])])).toThrow("workspace dependency cycle: a -> b -> c -> a");
  });

  test("reads workspaces from bun.lock and dependencies from every field, workspace names only", () => {
    const files: Record<string, string> = {
      "/r/bun.lock": '{ "workspaces": { "": {}, "packages/x": {}, "packages/y": {}, }, }',
      "/r/packages/x/package.json": JSON.stringify({ name: "@s/x", scripts: { build: "tsc" }, devDependencies: { "@s/y": "workspace:*", zod: "4" } }),
      "/r/packages/y/package.json": JSON.stringify({ name: "@s/y", peerDependencies: { "@s/x": "*" } }),
    };
    expect(readWorkspacePackages("/r", path => files[path]!)).toEqual([
      { directory: "packages/x", name: "@s/x", hasBuild: true, dependsOn: ["@s/y"] },
      { directory: "packages/y", name: "@s/y", hasBuild: false, dependsOn: ["@s/x"] },
    ]);
    expect(readWorkspacePackages("/r", path => (path === "/r/bun.lock" ? "{}" : files[path]!))).toEqual([]);
  });
});

describe("building the packages", () => {
  const fixture = () => {
    const root = mkdtempSync(join(tmpdir(), "build-packages-"));
    writeFileSync(join(root, "bun.lock"), JSON.stringify({ workspaces: { "": {}, "packages/a": {}, "packages/b": {} } }));
    for (const [name, build, dependencies] of [["a", "echo built-a > out.txt", {}], ["b", "exit 3", { a: "workspace:*" }]] as const) {
      mkdirSync(join(root, "packages", name), { recursive: true });
      writeFileSync(join(root, "packages", name, "package.json"), JSON.stringify({ name, scripts: { build }, dependencies }));
    }
    return root;
  };

  test("runs each build in order with the extra arguments, and stops at the first failure with its exit code", () => {
    const root = fixture();
    try {
      const calls: string[][] = [];
      const lines: string[] = [];
      const status = buildWorkspacePackages(root, ["--force"], (command, args) => { calls.push([command, ...args]); return calls.length === 1 ? 0 : 5; }, line => lines.push(line));
      expect(status).toBe(5);
      expect(calls).toEqual([
        ["bun", "run", "--cwd", join(root, "packages/a"), "build", "--force"],
        ["bun", "run", "--cwd", join(root, "packages/b"), "build", "--force"],
      ]);
      expect(lines).toEqual(["build:packages: a (packages/a)", "build:packages: b (packages/b)", "build:packages: b failed with exit 5"]);
      expect(buildWorkspacePackages(root, [], () => 0, () => {})).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test("spawns the real package builds by default", () => {
    const root = fixture();
    try {
      const lines: string[] = [];
      expect(buildWorkspacePackages(root, [], undefined, line => lines.push(line))).toBe(3);
      expect(readWorkspacePackages(root).map(p => p.name)).toEqual(["a", "b"]);
      expect(Bun.file(join(root, "packages/a/out.txt")).size).toBeGreaterThan(0);
      expect(lines.at(-1)).toBe("build:packages: b failed with exit 3");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
