/**
 * Comprehensive coverage tests for pure-function extension modules:
 * - src/extensions/manifest.ts  (validators, satisfiesRange, validateDependencies, compareVersions, generateSlug, inferPackageType)
 * - src/extensions/source-parser.ts  (parseSource)
 * - src/extensions/dependency-resolver.ts  (detectCycles, formatDepTree, resolveDependencies)
 *
 * Targets coverage gaps not addressed by existing test suites.
 */

import { test, expect, describe } from "bun:test";

import {
  validateManifestV2,
  satisfiesRange,
  validateDependencies,
  compareVersions,
  generateSlug,
  inferPackageType,
} from "../extensions/manifest";

import { parseSource } from "../extensions/source-parser";

import {
  detectCycles,
  formatDepTree,
  resolveDependencies,
  type DependencyTreeNode,
  type ResolvedDep,
} from "../extensions/dependency-resolver";

import type {
  ExtensionManifestV2,
  DependencySpec,
} from "../extensions/types";

// ── Helpers ────────────────────────────────────────────────────────

function makeManifest(
  name: string,
  version: string,
  deps?: Record<string, DependencySpec>,
  extra?: Partial<ExtensionManifestV2>,
): ExtensionManifestV2 {
  return {
    schemaVersion: 2,
    name,
    version,
    description: `${name} ext`,
    author: { name: "test" },
    permissions: {},
    ...(deps ? { dependencies: deps } : {}),
    ...extra,
  };
}

// ══════════════════════════════════════════════════════════════════════
// ── manifest.ts ──────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

describe("manifest.ts coverage gaps", () => {
  // ── validateToolsArray edge cases ──────────────────────────────

  describe("validateToolsArray via validateManifestV2", () => {
    test("tools as a string rejects with 'tools must be an array'", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        tools: "not-array" as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("tools must be an array");
    });

    test("tools as a number rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        tools: 42 as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("tools must be an array");
    });

    test("tool item as primitive (number) rejects with 'must be an object'", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        tools: [123] as any,
        entrypoint: "./x.ts",
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("tools[0] must be an object"))).toBe(true);
    });

    test("tool item as string rejects with 'must be an object'", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        tools: ["bad"] as any,
        entrypoint: "./x.ts",
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("tools[0] must be an object"))).toBe(true);
    });

    test("tool item as false rejects with 'must be an object'", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        tools: [false] as any,
        entrypoint: "./x.ts",
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("tools[0] must be an object"))).toBe(true);
    });

    test("tool missing name reports name error", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        tools: [{ description: "d", inputSchema: {} }] as any,
        entrypoint: "./x.ts",
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("tools[0].name is required"))).toBe(true);
    });

    test("tool with name as number reports name error", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        tools: [{ name: 42, description: "d", inputSchema: {} }] as any,
        entrypoint: "./x.ts",
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("tools[0].name is required"))).toBe(true);
    });

    test("tool missing description reports description error", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        tools: [{ name: "x", inputSchema: {} }] as any,
        entrypoint: "./x.ts",
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("tools[0].description is required"))).toBe(true);
    });

    test("tool with inputSchema as string reports inputSchema error", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        tools: [{ name: "x", description: "d", inputSchema: "bad" }] as any,
        entrypoint: "./x.ts",
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("tools[0].inputSchema is required"))).toBe(true);
    });

    test("tool with inputSchema as null reports inputSchema error", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        tools: [{ name: "x", description: "d", inputSchema: null }] as any,
        entrypoint: "./x.ts",
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("tools[0].inputSchema is required"))).toBe(true);
    });

    test("non-object tool items continue to next item", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        tools: [null, { name: "ok", description: "ok", inputSchema: {} }] as any,
        entrypoint: "./x.ts",
      }));
      // First item error, second item valid
      expect(r.errors.some((e) => e.includes("tools[0] must be an object"))).toBe(true);
      expect(r.errors.some((e) => e.includes("tools[1]"))).toBe(false);
    });
  });

  // ── validateSkillsArray edge cases ─────────────────────────────

  describe("validateSkillsArray via validateManifestV2", () => {
    test("skills as a number rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        skills: 99 as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("skills must be an array");
    });

    test("skills as a boolean rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        skills: true as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("skills must be an array");
    });

    test("skill item as primitive rejects with 'must be an object'", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        skills: [42] as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("skills[0] must be an object"))).toBe(true);
    });

    test("skill item as undefined rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        skills: [undefined] as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("skills[0] must be an object"))).toBe(true);
    });

    test("skill missing name reports name error", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        skills: [{ description: "d" }] as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("skills[0].name is required"))).toBe(true);
    });

    test("skill missing description reports description error", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        skills: [{ name: "s" }] as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("skills[0].description is required"))).toBe(true);
    });

    test("non-object skill items continue to next item", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        skills: [false, { name: "ok", description: "ok" }] as any,
      }));
      expect(r.errors.some((e) => e.includes("skills[0] must be an object"))).toBe(true);
      expect(r.errors.some((e) => e.includes("skills[1]"))).toBe(false);
    });
  });

  // ── validateMcpServersArray edge cases ─────────────────────────

  describe("validateMcpServersArray via validateManifestV2", () => {
    test("mcpServers as a string rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        mcpServers: "bad" as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("mcpServers must be an array");
    });

    test("mcpServers as boolean rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        mcpServers: false as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("mcpServers must be an array");
    });

    test("mcpServer item as primitive rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        mcpServers: ["bad"] as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("mcpServers[0] must be an object"))).toBe(true);
    });

    test("mcpServer item as undefined rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        mcpServers: [undefined] as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("mcpServers[0] must be an object"))).toBe(true);
    });

    test("mcpServer missing name reports name error", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        mcpServers: [{ transport: "stdio", command: "node" }] as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("mcpServers[0].name is required"))).toBe(true);
    });

    test("mcpServer missing transport reports transport error", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        mcpServers: [{ name: "m" }] as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("mcpServers[0].transport"))).toBe(true);
    });

    test("stdio mcpServer missing command reports command error", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        mcpServers: [{ transport: "stdio", name: "m" }] as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("mcpServers[0].command"))).toBe(true);
    });

    test("http mcpServer missing url reports url error", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        mcpServers: [{ transport: "http", name: "m" }] as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("mcpServers[0].url"))).toBe(true);
    });

    test("non-object mcpServer items continue to next", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        mcpServers: [0, { transport: "stdio", name: "ok", command: "node" }] as any,
      }));
      expect(r.errors.some((e) => e.includes("mcpServers[0] must be an object"))).toBe(true);
      expect(r.errors.some((e) => e.includes("mcpServers[1]"))).toBe(false);
    });
  });

  // ── validateAgentComponent edge cases ──────────────────────────

  describe("validateAgentComponent via validateManifestV2", () => {
    test("agent as number rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        agent: 42 as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("agent must be an object");
    });

    test("agent as false rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        agent: false as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("agent must be an object");
    });

    test("agent with prompt as number rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        agent: { prompt: 42 } as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("agent.prompt is required");
    });

    test("agent with missing prompt rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        agent: {} as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("agent.prompt is required");
    });
  });

  // ── validateScriptsBlock edge cases ────────────────────────────

  describe("validateScriptsBlock via validateManifestV2", () => {
    test("scripts as number rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        scripts: 42 as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("scripts must be an object");
    });

    test("scripts as string rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        scripts: "bad" as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("scripts must be an object");
    });

    test("scripts as false rejects", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", undefined, {
        scripts: false as any,
      }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("scripts must be an object");
    });
  });

  // ── satisfiesRange comprehensive ──────────────────────────────

  describe("satisfiesRange", () => {
    test("exact match: same string returns true", () => {
      expect(satisfiesRange("1.2.3", "1.2.3")).toBe(true);
    });

    test("exact mismatch returns false", () => {
      expect(satisfiesRange("1.2.4", "1.2.3")).toBe(false);
    });

    test("non-caret, non-semver range: arbitrary string exact match", () => {
      expect(satisfiesRange("foo", "foo")).toBe(true);
      expect(satisfiesRange("bar", "foo")).toBe(false);
    });

    test("caret major>=1: same major, version >= floor", () => {
      expect(satisfiesRange("1.2.3", "^1.2.3")).toBe(true);
      expect(satisfiesRange("1.9.9", "^1.2.3")).toBe(true);
    });

    test("caret major>=1: same major, version < floor returns false", () => {
      expect(satisfiesRange("1.2.2", "^1.2.3")).toBe(false);
      expect(satisfiesRange("1.0.0", "^1.2.3")).toBe(false);
    });

    test("caret major>=1: different major returns false", () => {
      expect(satisfiesRange("2.0.0", "^1.2.3")).toBe(false);
      expect(satisfiesRange("0.9.9", "^1.0.0")).toBe(false);
    });

    test("caret major=0: same major and minor, patch >= floor", () => {
      expect(satisfiesRange("0.2.3", "^0.2.3")).toBe(true);
      expect(satisfiesRange("0.2.9", "^0.2.3")).toBe(true);
    });

    test("caret major=0: different minor returns false", () => {
      expect(satisfiesRange("0.3.0", "^0.2.3")).toBe(false);
      expect(satisfiesRange("0.1.9", "^0.2.3")).toBe(false);
    });

    test("caret major=0: patch below floor returns false", () => {
      expect(satisfiesRange("0.2.1", "^0.2.3")).toBe(false);
    });

    test("caret with multi-digit versions", () => {
      expect(satisfiesRange("10.5.0", "^10.0.0")).toBe(true);
      expect(satisfiesRange("11.0.0", "^10.0.0")).toBe(false);
    });
  });

  // ── validateDependencies comprehensive ─────────────────────────

  describe("validateDependencies", () => {
    test("non-object (string) rejects", () => {
      const r = validateDependencies("bad");
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("dependencies must be a plain object");
    });

    test("null rejects", () => {
      const r = validateDependencies(null);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("dependencies must be a plain object");
    });

    test("array rejects", () => {
      const r = validateDependencies([]);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("dependencies must be a plain object");
    });

    test("undefined rejects", () => {
      const r = validateDependencies(undefined);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("dependencies must be a plain object");
    });

    test("dep spec as non-object (string) rejects", () => {
      const r = validateDependencies({ foo: "^1.0.0" });
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("foo") && e.includes("must be an object"))).toBe(true);
    });

    test("dep spec as array rejects", () => {
      const r = validateDependencies({ foo: [1, 2] });
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("foo") && e.includes("must be an object"))).toBe(true);
    });

    test("dep spec as null rejects", () => {
      const r = validateDependencies({ foo: null });
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("foo") && e.includes("must be an object"))).toBe(true);
    });

    test("missing source rejects", () => {
      const r = validateDependencies({ foo: { version: "1.0.0" } });
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("foo") && e.includes("source"))).toBe(true);
    });

    test("source as number rejects", () => {
      const r = validateDependencies({ foo: { source: 42, version: "1.0.0" } });
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("foo") && e.includes("source"))).toBe(true);
    });

    test("missing version rejects", () => {
      const r = validateDependencies({ foo: { source: "github:u/r" } });
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("foo") && e.includes("version"))).toBe(true);
    });

    test("version as number rejects", () => {
      const r = validateDependencies({ foo: { source: "github:u/r", version: 1 } });
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("foo") && e.includes("version"))).toBe(true);
    });

    test("tilde version range rejects", () => {
      const r = validateDependencies({ foo: { source: "github:u/r", version: "~1.0.0" } });
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("~"))).toBe(true);
    });

    test("wildcard version rejects", () => {
      const r = validateDependencies({ foo: { source: "github:u/r", version: "*" } });
      expect(r.valid).toBe(false);
    });

    test(">= version range rejects", () => {
      const r = validateDependencies({ foo: { source: "github:u/r", version: ">=1.0.0" } });
      expect(r.valid).toBe(false);
    });

    test("valid exact version passes", () => {
      const r = validateDependencies({ foo: { source: "github:u/r", version: "1.0.0" } });
      expect(r.valid).toBe(true);
      expect(r.errors).toHaveLength(0);
    });

    test("valid caret version passes", () => {
      const r = validateDependencies({ foo: { source: "github:u/r", version: "^1.0.0" } });
      expect(r.valid).toBe(true);
    });

    test("empty deps object passes", () => {
      const r = validateDependencies({});
      expect(r.valid).toBe(true);
    });

    test("validateManifestV2 integrates validateDependencies", () => {
      const r = validateManifestV2(makeManifest("t", "1.0.0", {
        bad: { source: "github:u/r", version: "~1.0.0" },
      }));
      expect(r.valid).toBe(false);
      expect(r.errors.some((e) => e.includes("bad") && e.includes("~"))).toBe(true);
    });
  });

  // ── compareVersions comprehensive ──────────────────────────────

  describe("compareVersions", () => {
    test("equal versions return 0", () => {
      expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
      expect(compareVersions("0.0.0", "0.0.0")).toBe(0);
    });

    test("a < b returns -1 (major)", () => {
      expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
    });

    test("a > b returns 1 (major)", () => {
      expect(compareVersions("3.0.0", "2.0.0")).toBe(1);
    });

    test("a < b returns -1 (minor)", () => {
      expect(compareVersions("1.0.0", "1.1.0")).toBe(-1);
    });

    test("a > b returns 1 (minor)", () => {
      expect(compareVersions("1.2.0", "1.1.0")).toBe(1);
    });

    test("a < b returns -1 (patch)", () => {
      expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
    });

    test("a > b returns 1 (patch)", () => {
      expect(compareVersions("1.0.2", "1.0.1")).toBe(1);
    });
  });

  // ── generateSlug comprehensive ─────────────────────────────────

  describe("generateSlug", () => {
    test("basic slug conversion", () => {
      expect(generateSlug("Hello World")).toBe("hello-world");
    });

    test("special chars become hyphens", () => {
      expect(generateSlug("foo@bar!baz")).toBe("foo-bar-baz");
    });

    test("consecutive special chars collapse to single hyphen", () => {
      expect(generateSlug("a!!!b")).toBe("a-b");
    });

    test("leading/trailing special chars stripped", () => {
      expect(generateSlug("---hello---")).toBe("hello");
    });

    test("empty string returns empty", () => {
      expect(generateSlug("")).toBe("");
    });

    test("numbers preserved", () => {
      expect(generateSlug("v2.1-release")).toBe("v2-1-release");
    });

    test("all special chars returns empty", () => {
      expect(generateSlug("@#$%")).toBe("");
    });

    test("mixed case lowered", () => {
      expect(generateSlug("CamelCase")).toBe("camelcase");
    });
  });

  // ── inferPackageType (re-exported from manifest.ts) ────────────

  describe("inferPackageType", () => {
    test("agent-only returns 'agent'", () => {
      expect(inferPackageType(makeManifest("a", "1.0.0", undefined, {
        agent: { prompt: "hi" },
      }))).toBe("agent");
    });

    test("agent + tools returns 'extension'", () => {
      expect(inferPackageType(makeManifest("a", "1.0.0", undefined, {
        agent: { prompt: "hi" },
        tools: [{ name: "t", description: "d", inputSchema: {} }],
        entrypoint: "./x.ts",
      }))).toBe("extension");
    });

    test("agent + skills returns 'extension'", () => {
      expect(inferPackageType(makeManifest("a", "1.0.0", undefined, {
        agent: { prompt: "hi" },
        skills: [{ name: "s", description: "d" }],
      }))).toBe("extension");
    });

    test("agent + mcpServers returns 'extension'", () => {
      expect(inferPackageType(makeManifest("a", "1.0.0", undefined, {
        agent: { prompt: "hi" },
        mcpServers: [{ transport: "stdio", name: "m", command: "node" }],
      }))).toBe("extension");
    });

    test("agent + scripts returns 'extension'", () => {
      expect(inferPackageType(makeManifest("a", "1.0.0", undefined, {
        agent: { prompt: "hi" },
        scripts: { postinstall: "./s.ts" },
      }))).toBe("extension");
    });

    test("no components returns 'extension'", () => {
      expect(inferPackageType(makeManifest("a", "1.0.0"))).toBe("extension");
    });

    test("tools only returns 'extension'", () => {
      expect(inferPackageType(makeManifest("a", "1.0.0", undefined, {
        tools: [{ name: "t", description: "d", inputSchema: {} }],
        entrypoint: "./x.ts",
      }))).toBe("extension");
    });
  });
});

// ══════════════════════════════════════════════════════════════════════
// ── source-parser.ts ─────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

describe("source-parser.ts coverage gaps", () => {
  test("github:user/repo without ref", () => {
    const r = parseSource("github:user/repo");
    expect(r.type).toBe("github");
    expect(r.cloneUrl).toBe("https://github.com/user/repo.git");
    expect(r.displayName).toBe("user/repo");
    expect(r.ref).toBeUndefined();
    expect(r.original).toBe("github:user/repo");
  });

  test("github:user/repo@v1.0 with ref", () => {
    const r = parseSource("github:user/repo@v1.0");
    expect(r.type).toBe("github");
    expect(r.cloneUrl).toBe("https://github.com/user/repo.git");
    expect(r.displayName).toBe("user/repo");
    expect(r.ref).toBe("v1.0");
    expect(r.original).toBe("github:user/repo@v1.0");
  });

  test("gitlab:org/project without ref", () => {
    const r = parseSource("gitlab:org/project");
    expect(r.type).toBe("gitlab");
    expect(r.cloneUrl).toBe("https://gitlab.com/org/project.git");
    expect(r.displayName).toBe("org/project");
    expect(r.ref).toBeUndefined();
    expect(r.original).toBe("gitlab:org/project");
  });

  test("gitlab:org/project@ref with ref", () => {
    const r = parseSource("gitlab:org/project@develop");
    expect(r.type).toBe("gitlab");
    expect(r.cloneUrl).toBe("https://gitlab.com/org/project.git");
    expect(r.displayName).toBe("org/project");
    expect(r.ref).toBe("develop");
  });

  test("git@host:user/repo.git without ref", () => {
    const r = parseSource("git@github.com:user/repo.git");
    expect(r.type).toBe("ssh");
    expect(r.cloneUrl).toBe("git@github.com:user/repo.git");
    expect(r.displayName).toBe("user/repo");
    expect(r.ref).toBeUndefined();
  });

  test("git@host:user/repo.git@ref with ref", () => {
    const r = parseSource("git@github.com:user/repo.git@v2.0");
    expect(r.type).toBe("ssh");
    expect(r.cloneUrl).toBe("git@github.com:user/repo.git");
    expect(r.displayName).toBe("user/repo");
    expect(r.ref).toBe("v2.0");
  });

  test("file:///path/to/repo without ref", () => {
    const r = parseSource("file:///path/to/repo");
    expect(r.type).toBe("file");
    expect(r.cloneUrl).toBe("file:///path/to/repo");
    expect(r.displayName).toBe("/path/to/repo");
    expect(r.ref).toBeUndefined();
  });

  test("file:///path@ref with ref", () => {
    const r = parseSource("file:///path/to/repo@main");
    expect(r.type).toBe("file");
    expect(r.cloneUrl).toBe("file:///path/to/repo");
    expect(r.displayName).toBe("/path/to/repo");
    expect(r.ref).toBe("main");
  });

  test("https://host/path.git without ref", () => {
    const r = parseSource("https://example.com/repo.git");
    expect(r.type).toBe("https");
    expect(r.cloneUrl).toBe("https://example.com/repo.git");
    expect(r.displayName).toBe("example.com/repo");
    expect(r.ref).toBeUndefined();
  });

  test("https://host/path.git@ref with ref", () => {
    const r = parseSource("https://example.com/repo.git@v1.0");
    expect(r.type).toBe("https");
    expect(r.cloneUrl).toBe("https://example.com/repo.git");
    expect(r.displayName).toBe("example.com/repo");
    expect(r.ref).toBe("v1.0");
  });

  test("empty string throws", () => {
    expect(() => parseSource("")).toThrow("Source string is required");
  });

  test("unrecognized format throws", () => {
    expect(() => parseSource("ftp://something")).toThrow(/Unrecognized source format/);
  });

  test("random string throws", () => {
    expect(() => parseSource("just-a-name")).toThrow(/Unrecognized source format/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// ── dependency-resolver.ts ───────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════════

describe("dependency-resolver.ts coverage gaps", () => {
  // ── detectCycles ───────────────────────────────────────────────

  describe("detectCycles", () => {
    test("empty graph returns null", () => {
      expect(detectCycles(new Map())).toBeNull();
    });

    test("no cycle: linear chain", () => {
      const g = new Map<string, string[]>();
      g.set("A", ["B"]);
      g.set("B", ["C"]);
      g.set("C", []);
      expect(detectCycles(g)).toBeNull();
    });

    test("simple cycle: A -> B -> A", () => {
      const g = new Map<string, string[]>();
      g.set("A", ["B"]);
      g.set("B", ["A"]);
      const cycle = detectCycles(g);
      expect(cycle).not.toBeNull();
      expect(cycle![0]).toBe(cycle![cycle!.length - 1]); // cycle starts and ends same
    });

    test("diamond: no cycle", () => {
      const g = new Map<string, string[]>();
      g.set("A", ["B", "C"]);
      g.set("B", ["D"]);
      g.set("C", ["D"]);
      g.set("D", []);
      expect(detectCycles(g)).toBeNull();
    });

    test("complex cycle: A -> B -> C -> A", () => {
      const g = new Map<string, string[]>();
      g.set("A", ["B"]);
      g.set("B", ["C"]);
      g.set("C", ["A"]);
      const cycle = detectCycles(g);
      expect(cycle).not.toBeNull();
      expect(cycle![0]).toBe(cycle![cycle!.length - 1]);
    });

    test("self-loop detected", () => {
      const g = new Map<string, string[]>();
      g.set("X", ["X"]);
      const cycle = detectCycles(g);
      expect(cycle).not.toBeNull();
      expect(cycle).toContain("X");
    });

    test("disconnected acyclic components returns null", () => {
      const g = new Map<string, string[]>();
      g.set("A", ["B"]);
      g.set("B", []);
      g.set("C", ["D"]);
      g.set("D", []);
      expect(detectCycles(g)).toBeNull();
    });

    test("node with children not in graph keys (implicit leaf)", () => {
      const g = new Map<string, string[]>();
      g.set("A", ["B"]); // B has no entry in the graph
      expect(detectCycles(g)).toBeNull();
    });
  });

  // ── formatDepTree ──────────────────────────────────────────────

  describe("formatDepTree", () => {
    test("single root, no children", () => {
      const tree: DependencyTreeNode = {
        name: "root",
        version: "1.0.0",
        status: "install",
        children: [],
      };
      const out = formatDepTree(tree);
      expect(out).toBe("root@1.0.0 (new)");
      expect(out.split("\n")).toHaveLength(1);
    });

    test("root with one child", () => {
      const tree: DependencyTreeNode = {
        name: "root",
        version: "1.0.0",
        status: "install",
        children: [
          { name: "child", version: "2.0.0", status: "install", children: [] },
        ],
      };
      const out = formatDepTree(tree);
      expect(out).toContain("root@1.0.0 (new)");
      expect(out).toContain("child@2.0.0 (new)");
    });

    test("root with multiple children uses correct box-drawing chars", () => {
      const tree: DependencyTreeNode = {
        name: "root",
        version: "1.0.0",
        status: "install",
        children: [
          { name: "A", version: "1.0.0", status: "install", children: [] },
          { name: "B", version: "2.0.0", status: "already-installed", children: [] },
        ],
      };
      const out = formatDepTree(tree);
      const lines = out.split("\n");
      // First child uses non-last connector
      expect(lines[1]).toContain("A@1.0.0 (new)");
      // Second (last) child uses last connector
      expect(lines[2]).toContain("B@2.0.0 (installed)");
    });

    test("nested children render properly", () => {
      const tree: DependencyTreeNode = {
        name: "root",
        version: "1.0.0",
        status: "install",
        children: [
          {
            name: "A",
            version: "1.0.0",
            status: "install",
            children: [
              { name: "B", version: "2.0.0", status: "install", children: [] },
            ],
          },
        ],
      };
      const out = formatDepTree(tree);
      expect(out).toContain("root@1.0.0");
      expect(out).toContain("A@1.0.0");
      expect(out).toContain("B@2.0.0");
      expect(out.split("\n")).toHaveLength(3);
    });

    test("already-installed marker", () => {
      const tree: DependencyTreeNode = {
        name: "pkg",
        version: "3.0.0",
        status: "already-installed",
        children: [],
      };
      const out = formatDepTree(tree);
      expect(out).toContain("(installed)");
    });

    test("multiple first-child connectors and last-child connectors", () => {
      const tree: DependencyTreeNode = {
        name: "root",
        version: "1.0.0",
        status: "install",
        children: [
          { name: "A", version: "1.0.0", status: "install", children: [] },
          { name: "B", version: "1.0.0", status: "install", children: [] },
          { name: "C", version: "1.0.0", status: "install", children: [] },
        ],
      };
      const out = formatDepTree(tree);
      const lines = out.split("\n");
      expect(lines).toHaveLength(4);
      // Non-last children get tree connector
      expect(lines[1]).toMatch(/^├── /);
      expect(lines[2]).toMatch(/^├── /);
      // Last child at root level: prefix="" + isLast=true triggers isRoot,
      // so it renders without box-drawing prefix (known behavior)
      expect(lines[3]).toBe("C@1.0.0 (new)");
    });
  });

  // ── resolveDependencies ────────────────────────────────────────

  describe("resolveDependencies", () => {
    test("no deps returns empty toInstall and root-only tree", async () => {
      const root = makeManifest("root", "1.0.0");
      const result = await resolveDependencies(root, {
        getInstalled: async () => null,
        fetchManifest: async () => { throw new Error("should not call"); },
      });
      expect(result.toInstall).toHaveLength(0);
      expect(result.tree.name).toBe("root");
      expect(result.tree.version).toBe("1.0.0");
      expect(result.tree.children).toHaveLength(0);
    });

    test("empty deps object returns empty toInstall", async () => {
      const root = makeManifest("root", "1.0.0", {});
      const result = await resolveDependencies(root, {
        getInstalled: async () => null,
        fetchManifest: async () => { throw new Error("should not call"); },
      });
      expect(result.toInstall).toHaveLength(0);
    });

    test("single dep already installed and satisfying", async () => {
      const root = makeManifest("root", "1.0.0", {
        A: { source: "github:u/A", version: "^1.0.0" },
      });
      const result = await resolveDependencies(root, {
        getInstalled: async (name) => name === "A" ? { version: "1.5.0" } : null,
        fetchManifest: async () => makeManifest("A", "1.5.0"),
      });
      expect(result.toInstall).toHaveLength(1);
      expect(result.toInstall[0]!.alreadyInstalled).toBe(true);
    });

    test("single dep not installed", async () => {
      const root = makeManifest("root", "1.0.0", {
        A: { source: "github:u/A", version: "^1.0.0" },
      });
      const result = await resolveDependencies(root, {
        getInstalled: async () => null,
        fetchManifest: async () => makeManifest("A", "1.3.0"),
      });
      expect(result.toInstall).toHaveLength(1);
      expect(result.toInstall[0]!.name).toBe("A");
      expect(result.toInstall[0]!.version).toBe("1.3.0");
      expect(result.toInstall[0]!.alreadyInstalled).toBe(false);
      expect(result.toInstall[0]!.installId).toBe("A");
    });

    test("transitive deps in topological order (leaves first)", async () => {
      const root = makeManifest("root", "1.0.0", {
        A: { source: "github:u/A", version: "^1.0.0" },
      });
      const manifests: Record<string, ExtensionManifestV2> = {
        A: makeManifest("A", "1.0.0", {
          B: { source: "github:u/B", version: "^1.0.0" },
        }),
        B: makeManifest("B", "1.0.0"),
      };
      const result = await resolveDependencies(root, {
        getInstalled: async () => null,
        fetchManifest: async (src) => {
          const name = src.split("/").pop()!;
          return manifests[name]!;
        },
      });
      expect(result.toInstall).toHaveLength(2);
      const names = result.toInstall.map((d) => d.name);
      expect(names.indexOf("B")).toBeLessThan(names.indexOf("A"));
    });

    test("cycle detection throws", async () => {
      const root = makeManifest("root", "1.0.0", {
        A: { source: "github:u/A", version: "^1.0.0" },
      });
      const manifests: Record<string, ExtensionManifestV2> = {
        A: makeManifest("A", "1.0.0", {
          B: { source: "github:u/B", version: "^1.0.0" },
        }),
        B: makeManifest("B", "1.0.0", {
          A: { source: "github:u/A", version: "^1.0.0" },
        }),
      };
      await expect(
        resolveDependencies(root, {
          getInstalled: async () => null,
          fetchManifest: async (src) => {
            const name = src.split("/").pop()!;
            return manifests[name]!;
          },
        }),
      ).rejects.toThrow(/Circular dependency/);
    });

    test("multi-version ranges produce separate entries", async () => {
      const root = makeManifest("root", "1.0.0", {
        A: { source: "github:u/A", version: "^1.0.0" },
        B: { source: "github:u/B", version: "^1.0.0" },
      });
      const manifests: Record<string, ExtensionManifestV2> = {
        A: makeManifest("A", "1.0.0", {
          C: { source: "github:u/C", version: "^1.0.0" },
        }),
        B: makeManifest("B", "1.0.0", {
          C: { source: "github:u/C", version: "^2.0.0" },
        }),
        C: makeManifest("C", "2.0.0"),
      };
      const result = await resolveDependencies(root, {
        getInstalled: async () => null,
        fetchManifest: async (src) => {
          const name = src.split("/").pop()!;
          return manifests[name]!;
        },
      });
      const cEntries = result.toInstall.filter((d) => d.name === "C");
      expect(cEntries.length).toBe(2);
      expect(cEntries.some((d) => d.installId.includes("@"))).toBe(true);
    });

    test("tree has correct structure for deps", async () => {
      const root = makeManifest("root", "1.0.0", {
        A: { source: "github:u/A", version: "^1.0.0" },
      });
      const result = await resolveDependencies(root, {
        getInstalled: async () => null,
        fetchManifest: async () => makeManifest("A", "1.2.0"),
      });
      expect(result.tree.name).toBe("root");
      expect(result.tree.children).toHaveLength(1);
      expect(result.tree.children[0]!.name).toBe("A");
      expect(result.tree.children[0]!.version).toBe("1.2.0");
      expect(result.tree.children[0]!.status).toBe("install");
    });

    test("tree marks already-installed deps", async () => {
      const root = makeManifest("root", "1.0.0", {
        A: { source: "github:u/A", version: "^1.0.0" },
      });
      const result = await resolveDependencies(root, {
        getInstalled: async () => ({ version: "1.0.0" }),
        fetchManifest: async () => makeManifest("A", "1.0.0"),
      });
      expect(result.tree.children[0]!.status).toBe("already-installed");
    });
  });
});
