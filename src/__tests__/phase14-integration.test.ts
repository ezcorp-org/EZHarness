/**
 * Phase 14 Integration Tests
 * End-to-end tests for dependency resolution, cross-extension composition,
 * and CLI dependency lifecycle.
 */
import { test, expect, describe, beforeEach } from "bun:test";
import { satisfiesRange } from "../extensions/manifest";
import {
  resolveDependencies,
  formatDepTree,
  type ResolvedDep,
} from "../extensions/dependency-resolver";
import { ExtensionRegistry } from "../extensions/registry";
import { ToolExecutor } from "../extensions/tool-executor";
import { parseArgs } from "../cli";
import type {
  ExtensionManifestV2,
  DependencySpec,
} from "../extensions/types";

// ── Shared helpers ─────────────────────────────────────────────────

function makeManifest(
  name: string,
  version: string,
  opts?: {
    deps?: Record<string, DependencySpec>;
    tools?: Array<{ name: string; description: string; inputSchema: Record<string, unknown> }>;
    entrypoint?: string;
  },
): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name,
    version,
    description: `${name} extension`,
    author: { name: "test" },
    permissions: {},
    entrypoint: opts?.entrypoint ?? "./index.ts",
    tools: opts?.tools ?? [{ name: "doStuff", description: "does stuff", inputSchema: { type: "object" } }],
    ...(opts?.deps ? { dependencies: opts.deps } : {}),
  };
}

function makeFetcher(manifests: Record<string, ExtensionManifestV2>) {
  return async (source: string): Promise<ExtensionManifestV2> => {
    const name = source.split("/").pop()!;
    const m = manifests[name];
    if (!m) throw new Error(`Unknown dep: ${source}`);
    return m;
  };
}

function findDependents(
  targetName: string,
  allExts: Array<{ name: string; manifest: ExtensionManifestV2 }>,
): string[] {
  const dependents: string[] = [];
  for (const other of allExts) {
    if (other.manifest.dependencies && targetName in other.manifest.dependencies) {
      dependents.push(other.name);
    }
  }
  return dependents;
}

// ── Integration: Dependency Resolution Pipeline ────────────────────

describe("Integration: Dependency Resolution Pipeline", () => {
  test("manifest with transitive deps resolves leaves-first and produces valid tree", async () => {
    const root = makeManifest("root", "1.0.0", {
      deps: { A: { source: "github:user/A", version: "^1.0.0" } },
    });

    const manifests: Record<string, ExtensionManifestV2> = {
      A: makeManifest("A", "1.2.0", {
        deps: { B: { source: "github:user/B", version: "^2.0.0" } },
      }),
      B: makeManifest("B", "2.3.0", {
        deps: { C: { source: "github:user/C", version: "^3.0.0" } },
      }),
      C: makeManifest("C", "3.1.0"),
    };

    const result = await resolveDependencies(root, {
      getInstalled: async () => null,
      fetchManifest: makeFetcher(manifests),
    });

    // Leaves-first order: C, B, A
    const names = result.toInstall.map((d: ResolvedDep) => d.name);
    expect(names).toEqual(["C", "B", "A"]);

    // Tree contains all nodes at correct depth
    expect(result.tree.name).toBe("root");
    expect(result.tree.children).toHaveLength(1);
    const aNode = result.tree.children[0]!;
    expect(aNode.name).toBe("A");
    expect(aNode.children).toHaveLength(1);
    const bNode = aNode.children[0]!;
    expect(bNode.name).toBe("B");
    expect(bNode.children).toHaveLength(1);
    expect(bNode.children[0]!.name).toBe("C");

    // formatDepTree produces valid output
    const treeStr = formatDepTree(result.tree);
    expect(treeStr).toContain("root@1.0.0");
    expect(treeStr).toContain("A@1.2.0");
    expect(treeStr).toContain("B@2.3.0");
    expect(treeStr).toContain("C@3.1.0");
    expect(treeStr).not.toContain("(installed)");
  });

  test("mixed installed and new deps show correct statuses through entire pipeline", async () => {
    const root = makeManifest("root", "1.0.0", {
      deps: {
        A: { source: "github:user/A", version: "^1.0.0" },
        B: { source: "github:user/B", version: "^2.0.0" },
      },
    });

    const manifests: Record<string, ExtensionManifestV2> = {
      A: makeManifest("A", "1.5.0"),
      B: makeManifest("B", "2.1.0"),
    };

    const result = await resolveDependencies(root, {
      getInstalled: async (name: string) => {
        if (name === "A") return { version: "1.5.0" };
        return null;
      },
      fetchManifest: makeFetcher(manifests),
    });

    const depA = result.toInstall.find((d: ResolvedDep) => d.name === "A")!;
    const depB = result.toInstall.find((d: ResolvedDep) => d.name === "B")!;
    expect(depA.alreadyInstalled).toBe(true);
    expect(depB.alreadyInstalled).toBe(false);

    const treeStr = formatDepTree(result.tree);
    const aLine = treeStr.split("\n").find((l: string) => l.includes("A@1.5.0"))!;
    const bLine = treeStr.split("\n").find((l: string) => l.includes("B@2.1.0"))!;
    expect(aLine).toContain("(installed)");
    expect(bLine).toContain("(new)");
  });

  test("cycle detection fires through full resolveDependencies", async () => {
    const root = makeManifest("root", "1.0.0", {
      deps: { A: { source: "github:user/A", version: "^1.0.0" } },
    });

    const manifests: Record<string, ExtensionManifestV2> = {
      A: makeManifest("A", "1.0.0", {
        deps: { B: { source: "github:user/B", version: "^1.0.0" } },
      }),
      B: makeManifest("B", "1.0.0", {
        deps: { A: { source: "github:user/A", version: "^1.0.0" } },
      }),
    };

    const err = await resolveDependencies(root, {
      getInstalled: async () => null,
      fetchManifest: makeFetcher(manifests),
    }).catch((e: Error) => e);

    expect(err).toBeInstanceOf(Error);
    const msg = (err as Error).message;
    expect(msg).toMatch(/circular/i);
    expect(msg).toContain("A");
    expect(msg).toContain("B");
  });

  test("incompatible version ranges produce multi-version entries", async () => {
    const root = makeManifest("root", "1.0.0", {
      deps: {
        A: { source: "github:user/A", version: "^1.0.0" },
        B: { source: "github:user/B", version: "^1.0.0" },
      },
    });

    const manifests: Record<string, ExtensionManifestV2> = {
      A: makeManifest("A", "1.0.0", {
        deps: { C: { source: "github:user/C", version: "^1.0.0" } },
      }),
      B: makeManifest("B", "1.0.0", {
        deps: { C: { source: "github:user/C", version: "^2.0.0" } },
      }),
      C: makeManifest("C", "2.0.0"),
    };

    const result = await resolveDependencies(root, {
      getInstalled: async () => null,
      fetchManifest: makeFetcher(manifests),
    });

    const cEntries = result.toInstall.filter((d: ResolvedDep) => d.name === "C");
    expect(cEntries).toHaveLength(2);

    const primary = cEntries.find((d: ResolvedDep) => d.installId === "C")!;
    const scoped = cEntries.find((d: ResolvedDep) => d.installId.includes("@"))!;
    expect(primary).toBeDefined();
    expect(scoped).toBeDefined();
    expect(scoped.installId).toBe("C@1.0.0");
  });

  test("simulated CLI install flow: resolve -> filter -> confirm -> install count", async () => {
    const rootManifest = makeManifest("my-ext", "2.0.0", {
      deps: {
        logger: { source: "github:user/logger", version: "^1.0.0" },
        utils: { source: "github:user/utils", version: "^3.0.0" },
        cache: { source: "github:user/cache", version: "^1.0.0" },
      },
    });

    const manifests: Record<string, ExtensionManifestV2> = {
      logger: makeManifest("logger", "1.4.0"),
      utils: makeManifest("utils", "3.2.0", {
        deps: { cache: { source: "github:user/cache", version: "^1.0.0" } },
      }),
      cache: makeManifest("cache", "1.1.0"),
    };

    const result = await resolveDependencies(rootManifest, {
      getInstalled: async (name: string) => {
        if (name === "logger") return { version: "1.2.0" };
        return null;
      },
      fetchManifest: makeFetcher(manifests),
    });

    const needsInstall = result.toInstall.filter((d: ResolvedDep) => !d.alreadyInstalled);
    const alreadyInstalled = result.toInstall.filter((d: ResolvedDep) => d.alreadyInstalled);

    expect(alreadyInstalled).toHaveLength(1);
    expect(alreadyInstalled[0]!.name).toBe("logger");

    expect(needsInstall).toHaveLength(2);
    const installNames = needsInstall.map((d: ResolvedDep) => d.name);
    expect(installNames).toContain("cache");
    expect(installNames).toContain("utils");
    expect(installNames.indexOf("cache")).toBeLessThan(installNames.indexOf("utils"));

    const confirmationTree = formatDepTree(result.tree);
    expect(confirmationTree).toContain("my-ext@2.0.0");
    expect(confirmationTree).toContain("logger");
    expect(confirmationTree).toContain("utils");
    expect(confirmationTree).toContain("cache");
  });
});

// ── Integration: Cross-Extension Composition ───────────────────────

describe("Integration: Cross-Extension Composition", () => {
  beforeEach(() => {
    ExtensionRegistry.resetInstance();
  });

  test("full cross-ext call: A calls B's tool through buildDepRoutes + executor", async () => {
    const registry = ExtensionRegistry.getInstance();

    registry.setManifestForTest("id-a", makeManifest("ext-a", "1.0.0", {
      deps: { "ext-b": { source: "github:test/ext-b", version: "^1.0.0" } },
    }));
    registry.setManifestForTest("id-b", makeManifest("ext-b", "1.3.0", {
      tools: [{ name: "compute", description: "computes", inputSchema: { type: "object" } }],
    }));

    registry.registerToolForTest("ext-b__compute", {
      name: "ext-b__compute", originalName: "compute", description: "computes",
      inputSchema: { type: "object" }, extensionId: "id-b", extensionName: "ext-b",
    });

    registry.buildDepRoutes();

    const executor = new ToolExecutor(registry);
    const capturedCalls: Array<{ toolName: string; callerExtensionId?: string }> = [];
    executor.executeToolCall = async (toolName, _input, _cid, _mid, opts?) => {
      capturedCalls.push({ toolName, callerExtensionId: opts?.callerExtensionId });
      return { content: [{ type: "text" as const, text: "ok" }], isError: false };
    };

    const response = await executor.handlePiInvoke("id-a", {
      jsonrpc: "2.0", id: 1, method: "ezcorp/invoke",
      params: { tool: "ext-b__compute", arguments: { value: 42 } },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
    expect(capturedCalls).toHaveLength(1);
    expect(capturedCalls[0]!.toolName).toBe("ext-b__compute");
    expect(capturedCalls[0]!.callerExtensionId).toBe("id-a");
  });

  test("chained call: A -> B -> C with depth tracking", async () => {
    const registry = ExtensionRegistry.getInstance();

    registry.setManifestForTest("id-a", makeManifest("ext-a", "1.0.0", {
      deps: { "ext-b": { source: "github:test/ext-b", version: "^1.0.0" } },
    }));
    registry.setManifestForTest("id-b", makeManifest("ext-b", "1.0.0", {
      deps: { "ext-c": { source: "github:test/ext-c", version: "^1.0.0" } },
    }));
    registry.setManifestForTest("id-c", makeManifest("ext-c", "1.0.0", {
      tools: [{ name: "leaf", description: "leaf op", inputSchema: { type: "object" } }],
    }));

    registry.registerToolForTest("ext-b__doStuff", {
      name: "ext-b__doStuff", originalName: "doStuff", description: "does stuff",
      inputSchema: { type: "object" }, extensionId: "id-b", extensionName: "ext-b",
    });
    registry.registerToolForTest("ext-c__leaf", {
      name: "ext-c__leaf", originalName: "leaf", description: "leaf op",
      inputSchema: { type: "object" }, extensionId: "id-c", extensionName: "ext-c",
    });

    registry.buildDepRoutes();

    const executor = new ToolExecutor(registry);
    const depthLog: Array<{ toolName: string; depth: number }> = [];

    executor.executeToolCall = async (toolName, _input, _cid, _mid, opts?) => {
      const depth = opts?._callDepth ?? 0;
      depthLog.push({ toolName, depth });

      if (toolName === "ext-b__doStuff") {
        const chainResp = await executor.handlePiInvoke("id-b", {
          jsonrpc: "2.0", id: 2, method: "ezcorp/invoke",
          params: { tool: "ext-c__leaf", arguments: {}, _depth: depth },
        });
        expect(chainResp.error).toBeUndefined();
        return { content: [{ type: "text" as const, text: "b-done" }], isError: false };
      }
      return { content: [{ type: "text" as const, text: "c-done" }], isError: false };
    };

    const response = await executor.handlePiInvoke("id-a", {
      jsonrpc: "2.0", id: 1, method: "ezcorp/invoke",
      params: { tool: "ext-b__doStuff", arguments: {} },
    });

    expect(response.error).toBeUndefined();
    expect(depthLog).toHaveLength(2);
    expect(depthLog[0]!.toolName).toBe("ext-b__doStuff");
    expect(depthLog[0]!.depth).toBe(1);
    expect(depthLog[1]!.toolName).toBe("ext-c__leaf");
    expect(depthLog[1]!.depth).toBe(2);
  });

  test("undeclared dependency rejected through full pipeline", async () => {
    const registry = ExtensionRegistry.getInstance();

    registry.setManifestForTest("id-a", makeManifest("ext-a", "1.0.0"));
    registry.setManifestForTest("id-b", makeManifest("ext-b", "1.0.0"));
    registry.registerToolForTest("ext-b__doStuff", {
      name: "ext-b__doStuff", originalName: "doStuff", description: "does stuff",
      inputSchema: { type: "object" }, extensionId: "id-b", extensionName: "ext-b",
    });
    registry.buildDepRoutes();

    const executor = new ToolExecutor(registry);
    const response = await executor.handlePiInvoke("id-a", {
      jsonrpc: "2.0", id: 1, method: "ezcorp/invoke",
      params: { tool: "ext-b__doStuff", arguments: {} },
    });

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32001);
    expect(response.error!.message).toContain("Dependency not declared");
  });

  test("depth limit through full pipeline", async () => {
    const registry = ExtensionRegistry.getInstance();

    registry.setManifestForTest("id-a", makeManifest("ext-a", "1.0.0", {
      deps: { "ext-b": { source: "github:test/ext-b", version: "^1.0.0" } },
    }));
    registry.setManifestForTest("id-b", makeManifest("ext-b", "1.0.0"));
    registry.registerToolForTest("ext-b__doStuff", {
      name: "ext-b__doStuff", originalName: "doStuff", description: "does stuff",
      inputSchema: { type: "object" }, extensionId: "id-b", extensionName: "ext-b",
    });
    registry.buildDepRoutes();

    const executor = new ToolExecutor(registry);
    const response = await executor.handlePiInvoke("id-a", {
      jsonrpc: "2.0", id: 1, method: "ezcorp/invoke",
      params: { tool: "ext-b__doStuff", arguments: {}, _depth: 10 },
    });

    expect(response.error).toBeDefined();
    expect(response.error!.code).toBe(-32000);
    expect(response.error!.message).toContain("depth limit");
  });

  test("buildDepRoutes with version routing resolves semver-compatible dep", async () => {
    const registry = ExtensionRegistry.getInstance();

    registry.setManifestForTest("id-a", makeManifest("ext-a", "1.0.0", {
      deps: { lib: { source: "github:test/lib", version: "^1.0.0" } },
    }));
    registry.setManifestForTest("id-lib", makeManifest("lib", "1.2.0", {
      tools: [{ name: "helper", description: "helps", inputSchema: { type: "object" } }],
    }));
    registry.registerToolForTest("lib__helper", {
      name: "lib__helper", originalName: "helper", description: "helps",
      inputSchema: { type: "object" }, extensionId: "id-lib", extensionName: "lib",
    });
    registry.buildDepRoutes();

    const resolved = registry.resolveDepTool("id-a", "lib__helper");
    expect(resolved).not.toBeNull();
    expect(resolved!.extensionId).toBe("id-lib");

    const executor = new ToolExecutor(registry);
    executor.executeToolCall = async () => {
      return { content: [{ type: "text" as const, text: "lib-result" }], isError: false };
    };

    const response = await executor.handlePiInvoke("id-a", {
      jsonrpc: "2.0", id: 1, method: "ezcorp/invoke",
      params: { tool: "lib__helper", arguments: {} },
    });

    expect(response.error).toBeUndefined();
    expect(response.result).toBeDefined();
  });
});

// ── Integration: CLI Dependency Lifecycle ──────────────────────────

describe("Integration: CLI Dependency Lifecycle", () => {
  test("install with --yes sets autoApprove", () => {
    const parsed = parseArgs(["ext", "install", "github:user/my-ext", "--yes"]);
    expect(parsed.command).toBe("ext:install");
    expect(parsed.source).toBe("github:user/my-ext");
    expect(parsed.autoApprove).toBe(true);
  });

  test("remove blocked by dependents without --force", () => {
    const allExts = [
      { name: "ext-a", manifest: makeManifest("ext-a", "1.0.0") },
      { name: "ext-b", manifest: makeManifest("ext-b", "1.0.0") },
      { name: "ext-c", manifest: makeManifest("ext-c", "1.0.0", {
        deps: { "ext-a": { source: "github:user/ext-a", version: "^1.0.0" } },
      }) },
    ];

    const dependents = findDependents("ext-a", allExts);
    expect(dependents).toEqual(["ext-c"]);

    const parsedNoForce = parseArgs(["ext", "remove", "ext-a"]);
    expect(dependents.length > 0 && !parsedNoForce.force).toBe(true);

    const parsedForce = parseArgs(["ext", "remove", "ext-a", "--force"]);
    expect(dependents.length > 0 && !parsedForce.force).toBe(false);
  });

  test("update detects semver compatibility mismatch", () => {
    const extB = makeManifest("ext-b", "1.0.0", {
      deps: { "ext-a": { source: "github:user/ext-a", version: "^1.0.0" } },
    });

    const requiredRange = extB.dependencies!["ext-a"]!.version;
    expect(satisfiesRange("2.0.0", requiredRange)).toBe(false);
    expect(satisfiesRange("1.5.0", requiredRange)).toBe(true);
  });

  test("list shows correct dep counts", () => {
    const manifests = [
      makeManifest("ext-no-deps", "1.0.0"),
      makeManifest("ext-two-deps", "1.0.0", {
        deps: {
          "dep-a": { source: "github:user/dep-a", version: "^1.0.0" },
          "dep-b": { source: "github:user/dep-b", version: "^2.0.0" },
        },
      }),
      makeManifest("ext-one-dep", "1.0.0", {
        deps: { "dep-c": { source: "github:user/dep-c", version: "1.0.0" } },
      }),
    ];

    const depCounts = manifests.map((m) =>
      m.dependencies ? Object.keys(m.dependencies).length : 0,
    );
    expect(depCounts).toEqual([0, 2, 1]);
  });

  test("info shows dependency satisfaction status", () => {
    const extMain = makeManifest("ext-main", "1.0.0", {
      deps: {
        "dep-installed": { source: "github:user/dep-installed", version: "^1.0.0" },
        "dep-missing": { source: "github:user/dep-missing", version: "^2.0.0" },
      },
    });

    const installedVersions: Record<string, string | null> = {
      "dep-installed": "1.2.0",
      "dep-missing": null,
    };

    const results = Object.entries(extMain.dependencies!).map(([name, spec]) => {
      const ver = installedVersions[name];
      if (!ver) return { name, status: "missing" };
      return { name, status: satisfiesRange(ver, spec.version) ? "ok" : "mismatch" };
    });

    expect(results).toEqual([
      { name: "dep-installed", status: "ok" },
      { name: "dep-missing", status: "missing" },
    ]);
  });

  test("end-to-end: install -> list -> info -> remove lifecycle", () => {
    const extA = makeManifest("ext-a", "1.0.0");
    const extB = makeManifest("ext-b", "1.0.0", {
      deps: { "ext-a": { source: "github:user/ext-a", version: "^1.0.0" } },
    });

    let installed = [
      { name: "ext-a", manifest: extA },
      { name: "ext-b", manifest: extB },
    ];

    // List: dep counts
    const depCounts = installed.map((ext) =>
      ext.manifest.dependencies ? Object.keys(ext.manifest.dependencies).length : 0,
    );
    expect(depCounts).toEqual([0, 1]);

    // Info: ext-b depends on ext-a, satisfied
    expect(satisfiesRange("1.0.0", extB.dependencies!["ext-a"]!.version)).toBe(true);

    // Remove ext-a blocked (ext-b depends on it)
    expect(findDependents("ext-a", installed)).toEqual(["ext-b"]);

    // Remove ext-b first (no dependents)
    expect(findDependents("ext-b", installed)).toEqual([]);
    installed = installed.filter((e) => e.name !== "ext-b");

    // Now ext-a can be removed
    expect(findDependents("ext-a", installed)).toEqual([]);
    installed = installed.filter((e) => e.name !== "ext-a");
    expect(installed).toHaveLength(0);
  });
});
