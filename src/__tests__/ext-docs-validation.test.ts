import { test, expect, describe } from "bun:test";
import { join, dirname, resolve } from "path";
import { stat } from "node:fs/promises";

const DOCS_DIR = join(import.meta.dir, "../../docs/extensions");
const EXAMPLES_DIR = join(DOCS_DIR, "examples");

const EXAMPLES = [
  "github-stats",
  "project-analyzer",
  "markdown-utils",
  "research-agent",
  "code-review-delegator",
  "multi-agent-orchestrator",
  "web-search",
] as const;

async function readText(path: string): Promise<string> {
  return Bun.file(path).text();
}

async function fileExists(path: string): Promise<boolean> {
  return Bun.file(path).exists();
}

/** Check if a path exists as either a file or directory */
async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function lineCount(content: string): number {
  return content.split("\n").length;
}

/** Extract all relative markdown links like [text](relative-path.md) */
function extractInternalLinks(
  content: string,
): Array<{ text: string; href: string }> {
  const links: Array<{ text: string; href: string }> = [];
  const regex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    const href = match[2]!;
    // Skip absolute URLs and anchors
    if (href.startsWith("http") || href.startsWith("#")) continue;
    links.push({ text: match[1]!, href });
  }
  return links;
}

/** Extract fenced code blocks with optional language tag */
function extractCodeBlocks(
  content: string,
): Array<{ lang: string; code: string }> {
  const blocks: Array<{ lang: string; code: string }> = [];
  const regex = /```(\w*)\n([\s\S]*?)```/g;
  let match;
  while ((match = regex.exec(content)) !== null) {
    blocks.push({ lang: match[1]!, code: match[2]! });
  }
  return blocks;
}

// ── 1. Documentation content validation ─────────────────────────

describe("README.md (landing page)", () => {
  let content: string;

  test("loads README.md", async () => {
    content = await readText(join(DOCS_DIR, "README.md"));
    expect(content.length).toBeGreaterThan(0);
  });

  test("contains Extension Development heading", async () => {
    content ??= await readText(join(DOCS_DIR, "README.md"));
    expect(content).toContain("# Extension Development");
  });

  test("links to getting-started.md", async () => {
    content ??= await readText(join(DOCS_DIR, "README.md"));
    expect(content).toContain("getting-started.md");
  });

  test("links to api-reference.md", async () => {
    content ??= await readText(join(DOCS_DIR, "README.md"));
    expect(content).toContain("api-reference.md");
  });

  test("links to manifest-schema.md", async () => {
    content ??= await readText(join(DOCS_DIR, "README.md"));
    expect(content).toContain("manifest-schema.md");
  });

  test("links to examples/", async () => {
    content ??= await readText(join(DOCS_DIR, "README.md"));
    expect(content).toContain("examples/");
  });

  test("references ezcorp ext init", async () => {
    content ??= await readText(join(DOCS_DIR, "README.md"));
    expect(content).toContain("ezcorp ext init");
  });

  test("references ezcorp ext dev", async () => {
    content ??= await readText(join(DOCS_DIR, "README.md"));
    expect(content).toContain("ezcorp ext dev");
  });

  test("references ezcorp ext publish", async () => {
    content ??= await readText(join(DOCS_DIR, "README.md"));
    expect(content).toContain("ezcorp ext publish");
  });
});

describe("getting-started.md", () => {
  let content: string;

  test("loads getting-started.md", async () => {
    content = await readText(join(DOCS_DIR, "getting-started.md"));
    expect(content.length).toBeGreaterThan(0);
  });

  test("has prerequisites section", async () => {
    content ??= await readText(join(DOCS_DIR, "getting-started.md"));
    expect(content).toMatch(/## Prerequisites/i);
  });

  test("covers skill creation (Part 1)", async () => {
    content ??= await readText(join(DOCS_DIR, "getting-started.md"));
    expect(content).toContain("ezcorp ext init");
    expect(content).toContain("--type skill");
  });

  test("covers tool creation (Part 2)", async () => {
    content ??= await readText(join(DOCS_DIR, "getting-started.md"));
    expect(content).toContain("--type tool");
  });

  test("covers publishing", async () => {
    content ??= await readText(join(DOCS_DIR, "getting-started.md"));
    expect(content).toContain("ezcorp ext publish");
  });

  test("has troubleshooting section", async () => {
    content ??= await readText(join(DOCS_DIR, "getting-started.md"));
    expect(content).toMatch(/## Troubleshooting/i);
  });

  test("has code blocks for examples", async () => {
    content ??= await readText(join(DOCS_DIR, "getting-started.md"));
    const blocks = extractCodeBlocks(content);
    expect(blocks.length).toBeGreaterThan(0);
  });

  test("cross-links to api-reference.md", async () => {
    content ??= await readText(join(DOCS_DIR, "getting-started.md"));
    expect(content).toContain("api-reference.md");
  });

  test("cross-links to manifest-schema.md", async () => {
    content ??= await readText(join(DOCS_DIR, "getting-started.md"));
    expect(content).toContain("manifest-schema.md");
  });

  test("minimum length: 150 lines", async () => {
    content ??= await readText(join(DOCS_DIR, "getting-started.md"));
    expect(lineCount(content)).toBeGreaterThanOrEqual(150);
  });
});

describe("api-reference.md", () => {
  let content: string;

  test("loads api-reference.md", async () => {
    content = await readText(join(DOCS_DIR, "api-reference.md"));
    expect(content.length).toBeGreaterThan(0);
  });

  const cliCommands = [
    "init",
    "install",
    "update",
    "list",
    "remove",
    "info",
    "dev",
    "test",
    "publish",
  ];

  for (const cmd of cliCommands) {
    test(`documents CLI command: ezcorp ext ${cmd}`, async () => {
      content ??= await readText(join(DOCS_DIR, "api-reference.md"));
      expect(content).toContain(`ezcorp ext ${cmd}`);
    });
  }

  const sdkTypes = [
    "JsonRpcRequest",
    "JsonRpcResponse",
    "ToolCallResult",
    "ToolDefinition",
    "SkillDefinition",
  ];

  for (const type of sdkTypes) {
    test(`documents SDK type: ${type}`, async () => {
      content ??= await readText(join(DOCS_DIR, "api-reference.md"));
      expect(content).toContain(type);
    });
  }

  test("has JSON-RPC protocol section", async () => {
    content ??= await readText(join(DOCS_DIR, "api-reference.md"));
    expect(content).toMatch(/JSON-RPC Protocol/i);
  });

  test("cross-links to manifest-schema.md", async () => {
    content ??= await readText(join(DOCS_DIR, "api-reference.md"));
    expect(content).toContain("manifest-schema.md");
  });

  test("minimum length: 150 lines", async () => {
    content ??= await readText(join(DOCS_DIR, "api-reference.md"));
    expect(lineCount(content)).toBeGreaterThanOrEqual(150);
  });
});

describe("manifest-schema.md", () => {
  let content: string;

  test("loads manifest-schema.md", async () => {
    content = await readText(join(DOCS_DIR, "manifest-schema.md"));
    expect(content.length).toBeGreaterThan(0);
  });

  const requiredFields = [
    "schemaVersion",
    "name",
    "version",
    "description",
    "author",
    "permissions",
  ];

  for (const field of requiredFields) {
    test(`documents required field: ${field}`, async () => {
      content ??= await readText(join(DOCS_DIR, "manifest-schema.md"));
      expect(content).toContain(field);
    });
  }

  const componentTypes = [
    "tools[]",
    "skills[]",
    "agent",
    "mcpServers[]",
    "scripts",
    "dependencies",
  ];

  for (const component of componentTypes) {
    test(`documents component type: ${component}`, async () => {
      content ??= await readText(join(DOCS_DIR, "manifest-schema.md"));
      expect(content).toContain(component);
    });
  }

  const permissionTypes = ["network", "filesystem", "shell", "env"];

  test("has permissions deep-dive with all 4 types", async () => {
    content ??= await readText(join(DOCS_DIR, "manifest-schema.md"));
    for (const perm of permissionTypes) {
      expect(content).toContain(`### \`${perm}\``);
    }
  });

  test("cross-links to api-reference.md", async () => {
    content ??= await readText(join(DOCS_DIR, "manifest-schema.md"));
    expect(content).toContain("api-reference.md");
  });

  test("contains complete example manifest with defineExtension and schemaVersion: 2", async () => {
    content ??= await readText(join(DOCS_DIR, "manifest-schema.md"));
    const blocks = extractCodeBlocks(content);
    const tsBlocks = blocks.filter((b) => b.lang === "typescript");
    const fullExample = tsBlocks.find(
      (b) =>
        b.code.includes("schemaVersion") &&
        b.code.includes("tools") &&
        b.code.includes("permissions") &&
        b.code.includes("defineExtension"),
    );
    expect(fullExample).toBeDefined();

    // Validate it contains schemaVersion: 2
    expect(fullExample!.code).toContain("schemaVersion: 2");
  });

  test("minimum length: 150 lines", async () => {
    content ??= await readText(join(DOCS_DIR, "manifest-schema.md"));
    expect(lineCount(content)).toBeGreaterThanOrEqual(150);
  });
});

// ── 2. Internal link validation ─────────────────────────────────

describe("internal link integrity", () => {
  const mdFiles = [
    "README.md",
    "getting-started.md",
    "api-reference.md",
    "manifest-schema.md",
  ];

  for (const file of mdFiles) {
    test(`all internal links in ${file} resolve to existing files`, async () => {
      const filePath = join(DOCS_DIR, file);
      const content = await readText(filePath);
      const links = extractInternalLinks(content);

      expect(links.length).toBeGreaterThan(0);

      const broken: string[] = [];
      for (const link of links) {
        // Strip any fragment (anchor) from href
        const hrefBase = link.href.split("#")[0];
        if (!hrefBase) continue; // pure anchor link

        const targetPath = resolve(dirname(filePath), hrefBase);
        const exists = await pathExists(targetPath);
        if (!exists) {
          broken.push(`[${link.text}](${link.href}) -> ${targetPath}`);
        }
      }
      expect(broken).toEqual([]);
    });
  }

  // Also check example READMEs
  for (const name of EXAMPLES) {
    test(`all internal links in examples/${name}/README.md resolve`, async () => {
      const filePath = join(EXAMPLES_DIR, name, "README.md");
      const content = await readText(filePath);
      const links = extractInternalLinks(content);

      const broken: string[] = [];
      for (const link of links) {
        const hrefBase = link.href.split("#")[0];
        if (!hrefBase) continue;

        const targetPath = resolve(dirname(filePath), hrefBase);
        const exists = await pathExists(targetPath);
        if (!exists) {
          broken.push(`[${link.text}](${link.href}) -> ${targetPath}`);
        }
      }
      expect(broken).toEqual([]);
    });
  }
});

// ── 3. Code example validation ──────────────────────────────────

describe("getting-started.md code example validation", () => {
  test("all manifest code blocks use TypeScript defineExtension pattern", async () => {
    const content = await readText(join(DOCS_DIR, "getting-started.md"));
    const blocks = extractCodeBlocks(content);
    const tsManifestBlocks = blocks.filter(
      (b) => b.lang === "typescript" && b.code.includes("schemaVersion"),
    );

    expect(tsManifestBlocks.length).toBeGreaterThan(0);

    // Full manifest blocks should use defineExtension
    const fullBlocks = tsManifestBlocks.filter((b) => b.code.includes("export default"));
    for (const block of fullBlocks) {
      expect(block.code).toContain("defineExtension");
    }
  });

  test("no JSON manifest blocks remain in getting-started.md", async () => {
    const content = await readText(join(DOCS_DIR, "getting-started.md"));
    const blocks = extractCodeBlocks(content);
    const jsonBlocks = blocks.filter(
      (b) => b.lang === "json" && b.code.includes('"schemaVersion"'),
    );

    expect(jsonBlocks.length).toBe(0);
  });
});

// ── 4. Example extension content tests ──────────────────────────

describe("example extension README content", () => {
  for (const name of EXAMPLES) {
    test(`${name}/README.md contains install command`, async () => {
      const content = await readText(join(EXAMPLES_DIR, name, "README.md"));
      expect(content).toContain(
        `ezcorp ext install ./docs/extensions/examples/${name}`,
      );
    });

    test(`${name}/README.md mentions bun test`, async () => {
      const content = await readText(join(EXAMPLES_DIR, name, "README.md"));
      expect(content).toContain("bun test");
    });
  }
});

describe("github-stats/index.ts", () => {
  test("uses @ezcorp/sdk/runtime dispatcher", async () => {
    const content = await readText(join(EXAMPLES_DIR, "github-stats", "index.ts"));
    expect(content).toContain("@ezcorp/sdk/runtime");
    expect(content).toContain("createToolDispatcher");
  });
});

describe("code-review-delegator/index.ts", () => {
  test("references ezcorp/invoke", async () => {
    const content = await readText(
      join(EXAMPLES_DIR, "code-review-delegator", "index.ts"),
    );
    expect(content).toContain("ezcorp/invoke");
  });
});

describe("markdown-utils/ezcorp.config.ts", () => {
  test("exports a valid manifest with schemaVersion 2", async () => {
    const { loadManifest } = await import("../extensions/loader");
    const manifest = await loadManifest(join(EXAMPLES_DIR, "markdown-utils"));
    expect(manifest.schemaVersion).toBe(2);
  });
});
