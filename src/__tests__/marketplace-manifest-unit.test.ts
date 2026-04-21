import { test, expect, describe } from "bun:test";
import { validateManifestV2, compareVersions, generateSlug } from "../extensions/manifest";
import { MARKETPLACE_CATEGORIES } from "../extensions/types";

// ── Helpers ──────────────────────────────────────────────────────

function validV2AgentManifest(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    name: "test-agent",
    description: "A test agent",
    version: "1.0.0",
    author: { name: "Alice" },
    agent: { prompt: "You are helpful." },
    permissions: {},
    tags: ["test"],
    ...overrides,
  };
}

// ── validateManifestV2 ──────────────────────────────────────────

describe("validateManifestV2", () => {
  describe("non-object input", () => {
    test("null returns error", () => {
      const r = validateManifestV2(null);
      expect(r.valid).toBe(false);
      expect(r.errors).toEqual(["Manifest must be a non-null object"]);
    });

    test("undefined returns error", () => {
      const r = validateManifestV2(undefined);
      expect(r.valid).toBe(false);
      expect(r.errors).toEqual(["Manifest must be a non-null object"]);
    });

    test("string returns error", () => {
      const r = validateManifestV2("hello");
      expect(r.valid).toBe(false);
    });

    test("number returns error", () => {
      const r = validateManifestV2(42);
      expect(r.valid).toBe(false);
    });
  });

  describe("missing required fields individually", () => {
    test("missing schemaVersion", () => {
      const m = validV2AgentManifest();
      delete (m as any).schemaVersion;
      const r = validateManifestV2(m);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("schemaVersion must be 2");
    });

    test("missing name", () => {
      const m = validV2AgentManifest();
      delete (m as any).name;
      const r = validateManifestV2(m);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("name is required and must be a non-empty string");
    });

    test("missing description", () => {
      const m = validV2AgentManifest();
      delete (m as any).description;
      const r = validateManifestV2(m);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("description is required and must be a non-empty string");
    });

    test("missing version", () => {
      const m = validV2AgentManifest();
      delete (m as any).version;
      const r = validateManifestV2(m);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("version must be valid semver (e.g., 1.0.0)");
    });

    test("missing author", () => {
      const m = validV2AgentManifest();
      delete (m as any).author;
      const r = validateManifestV2(m);
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("author.name is required and must be a non-empty string");
    });
  });

  describe("schemaVersion validation", () => {
    test("string '2' is invalid", () => {
      const r = validateManifestV2(validV2AgentManifest({ schemaVersion: "2" }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("schemaVersion must be 2");
    });

    test("schemaVersion 1 is invalid", () => {
      const r = validateManifestV2(validV2AgentManifest({ schemaVersion: 1 }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("schemaVersion must be 2");
    });
  });

  describe("version format validation", () => {
    test.each(["1.0", "v1.0.0", "1.0.0.0", "abc", ""])("rejects '%s'", (version) => {
      const r = validateManifestV2(validV2AgentManifest({ version }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("version must be valid semver (e.g., 1.0.0)");
    });

    test.each(["0.0.1", "1.0.0", "10.20.30"])("accepts '%s'", (version) => {
      const r = validateManifestV2(validV2AgentManifest({ version }));
      expect(r.errors).not.toContain("version must be valid semver (e.g., 1.0.0)");
    });
  });

  describe("author validation", () => {
    test("author as string is invalid", () => {
      const r = validateManifestV2(validV2AgentManifest({ author: "Alice" }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("author.name is required and must be a non-empty string");
    });

    test("author with empty name is invalid", () => {
      const r = validateManifestV2(validV2AgentManifest({ author: { name: "" } }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("author.name is required and must be a non-empty string");
    });

    test("author with missing name is invalid", () => {
      const r = validateManifestV2(validV2AgentManifest({ author: {} }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("author.name is required and must be a non-empty string");
    });
  });

  describe("agent component validation", () => {
    test("agent without prompt fails", () => {
      const r = validateManifestV2(validV2AgentManifest({ agent: {} }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("agent.prompt is required");
    });

    test("agent with empty prompt fails", () => {
      const r = validateManifestV2(validV2AgentManifest({ agent: { prompt: "" } }));
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("agent.prompt is required");
    });
  });

  describe("multiple errors reported simultaneously", () => {
    test("empty object reports all missing fields", () => {
      const r = validateManifestV2({});
      expect(r.valid).toBe(false);
      expect(r.errors.length).toBeGreaterThanOrEqual(4);
      expect(r.errors).toContain("schemaVersion must be 2");
      expect(r.errors).toContain("name is required and must be a non-empty string");
      expect(r.errors).toContain("description is required and must be a non-empty string");
      expect(r.errors).toContain("version must be valid semver (e.g., 1.0.0)");
    });
  });

  describe("valid manifests", () => {
    test("minimal valid agent manifest", () => {
      const r = validateManifestV2(validV2AgentManifest());
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    test("manifest without agent (pure extension)", () => {
      const r = validateManifestV2({
        schemaVersion: 2,
        name: "test-extension",
        description: "A test extension",
        version: "1.0.0",
        author: { name: "Bob" },
        permissions: {},
      });
      expect(r.valid).toBe(true);
      expect(r.errors).toEqual([]);
    });

    test("manifest with tools requires entrypoint", () => {
      const r = validateManifestV2({
        schemaVersion: 2,
        name: "test-extension",
        description: "A test extension",
        version: "1.0.0",
        author: { name: "Bob" },
        tools: [{ name: "tool1", description: "A tool", inputSchema: {} }],
        permissions: {},
      });
      expect(r.valid).toBe(false);
      expect(r.errors).toContain("entrypoint is required when tools are declared");
    });
  });
});

// ── compareVersions ──────────────────────────────────────────────

describe("compareVersions", () => {
  test("equal versions return 0", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("0.0.0", "0.0.0")).toBe(0);
  });

  test("patch bump: 1.0.0 < 1.0.1", () => {
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
  });

  test("minor bump: 1.0.0 < 1.1.0", () => {
    expect(compareVersions("1.0.0", "1.1.0")).toBe(-1);
  });

  test("major bump: 1.0.0 < 2.0.0", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBe(-1);
  });

  test("higher to lower returns 1", () => {
    expect(compareVersions("2.0.0", "1.0.0")).toBe(1);
    expect(compareVersions("1.1.0", "1.0.0")).toBe(1);
    expect(compareVersions("1.0.1", "1.0.0")).toBe(1);
  });

  test("multi-digit: 1.10.0 > 1.9.0", () => {
    expect(compareVersions("1.10.0", "1.9.0")).toBe(1);
  });

  test("zero versions: 0.0.1 vs 0.0.0", () => {
    expect(compareVersions("0.0.1", "0.0.0")).toBe(1);
    expect(compareVersions("0.0.0", "0.0.1")).toBe(-1);
  });

  test("large numbers: 100.200.300 vs 100.200.299", () => {
    expect(compareVersions("100.200.300", "100.200.299")).toBe(1);
    expect(compareVersions("100.200.299", "100.200.300")).toBe(-1);
    expect(compareVersions("100.200.300", "100.200.300")).toBe(0);
  });
});

// ── generateSlug ─────────────────────────────────────────────────

describe("generateSlug", () => {
  test("simple name to lowercase-hyphenated", () => {
    expect(generateSlug("My Agent")).toBe("my-agent");
  });

  test("multiple spaces become single hyphen", () => {
    expect(generateSlug("hello   world")).toBe("hello-world");
  });

  test("special characters stripped", () => {
    expect(generateSlug("hello!@#$%world")).toBe("hello-world");
  });

  test("leading/trailing hyphens stripped", () => {
    expect(generateSlug("--hello--")).toBe("hello");
    expect(generateSlug("  hello  ")).toBe("hello");
  });

  test("unicode/non-ascii stripped", () => {
    expect(generateSlug("caf\u00e9 latt\u00e9")).toBe("caf-latt");
  });

  test("already lowercase unchanged", () => {
    expect(generateSlug("simple")).toBe("simple");
  });

  test("numbers preserved", () => {
    expect(generateSlug("Agent 007")).toBe("agent-007");
    expect(generateSlug("v2config")).toBe("v2config");
  });

  test("empty string returns empty string", () => {
    expect(generateSlug("")).toBe("");
  });
});

// ── MARKETPLACE_CATEGORIES ───────────────────────────────────────

describe("MARKETPLACE_CATEGORIES", () => {
  test("has exactly 9 entries", () => {
    expect(MARKETPLACE_CATEGORIES).toHaveLength(9);
  });

  test("all entries are strings", () => {
    for (const cat of MARKETPLACE_CATEGORIES) {
      expect(typeof cat).toBe("string");
    }
  });

  test.each(["Productivity", "Development", "Writing", "Research", "Education", "Creative", "Data & Analysis", "Communication", "Other"])(
    "contains '%s'",
    (category) => {
      expect(MARKETPLACE_CATEGORIES).toContain(category);
    },
  );
});
