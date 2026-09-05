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

describe("service workflow authoring boundary", () => {
  test("separates human consent from service identity and broker support", async () => {
    const security = await Bun.file(join(DOCS_DIR, "security.md")).text();
    expect(security).toContain("Release approval and job consent are separate human decisions");
    expect(security).toContain("keeps the human `userId` null");
    expect(security).toContain("Not every broker is service-enabled");
    expect(security).toContain("Direct host `ctx.file`, `ctx.shell` and `ctx.llm` adapters are denied");
  });

  test("requires real service effects and revocation rather than acceptance alone", async () => {
    const authoring = await Bun.file(join(DOCS_DIR, "AUTHORING.md")).text();
    expect(authoring).toContain("`Workflows.runFor({ jobRef, input })`");
    expect(authoring).toContain("acceptance, not completion");
    expect(authoring).toContain("revoke consent and prove another fire cannot create a run");
    expect(authoring).toContain("A changed release requires new consent");
  });

  test("keeps trusted-local separate from automatic runner recovery", async () => {
    const security = await Bun.file(join(DOCS_DIR, "security.md")).text();
    expect(security).toContain("there is no automatic host-process fallback");
    expect(security).toContain("`trusted-local` adapter is an explicit exception");
    expect(security).toContain("must never be described as isolated");
  });
});

async function readText(path: string): Promise<string> {
  return Bun.file(path).text();
}

async function _fileExists(path: string): Promise<boolean> {
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

/** Extract all relative markdown links like [text](relative-path.md) */
function extractInternalLinks(
  content: string,
): Array<{ text: string; href: string }> {
  const links: Array<{ text: string; href: string }> = [];
  const regex = /\[([^\]]*)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
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
  let match: RegExpExecArray | null;
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

  test("contains the extension landing heading", async () => {
    content ??= await readText(join(DOCS_DIR, "README.md"));
    expect(content).toContain("# Extensions");
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

  test("links to current harness authoring", async () => {
    content ??= await readText(join(DOCS_DIR, "README.md"));
    expect(content).toContain("AUTHORING.md");
  });

  test("requires an isolated build", async () => {
    content ??= await readText(join(DOCS_DIR, "README.md"));
    expect(content).toContain("isolated build and tests");
  });

  test("keeps edits separate from the active release", async () => {
    content ??= await readText(join(DOCS_DIR, "README.md"));
    expect(content).toContain("does not change the active release");
  });

  test("requires human review before activation", async () => {
    content ??= await readText(join(DOCS_DIR, "README.md"));
    expect(content).toContain("human review → activation");
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

  test("documents the actual default scaffold command", async () => {
    content ??= await readText(join(DOCS_DIR, "getting-started.md"));
    expect(content).toContain("bun src/cli.ts ext init my-extension");
    expect(content).toContain("inline manifest in `extension.ts`");
  });

  test("documents scaffold implementation and test files", async () => {
    content ??= await readText(join(DOCS_DIR, "getting-started.md"));
    expect(content).toContain("src/echo.ts");
    expect(content).toContain("src/echo.test.ts");
  });

  test("covers publishing", async () => {
    content ??= await readText(join(DOCS_DIR, "getting-started.md"));
    expect(content).toContain("publishExtension({ extDir, token })");
    expect(content).toContain("Publishing is not installation approval");
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

  test("documents runner failures and rejected automatic approval", async () => {
    content ??= await readText(join(DOCS_DIR, "getting-started.md"));
    expect(content).toContain("missing runner must not cause unisolated execution");
    expect(content).toContain("`--yes` cannot approve a release");
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
    test(`documents CLI command: ext ${cmd}`, async () => {
      content ??= await readText(join(DOCS_DIR, "api-reference.md"));
      expect(content).toMatch(new RegExp("`" + cmd + "(?:[ <`])"));
    });
  }

  const sdkTypes = [
    "defineExtension",
    "serve",
    "validateManifest",
    "defineRuntimeManifest",
    "createRuntimeExtension",
  ];

  for (const type of sdkTypes) {
    test(`documents SDK type: ${type}`, async () => {
      content ??= await readText(join(DOCS_DIR, "api-reference.md"));
      expect(content).toContain(type);
    });
  }

  test("keeps protocol framing inside the SDK", async () => {
    content ??= await readText(join(DOCS_DIR, "api-reference.md"));
    expect(content).toContain("SDK owns framing, cancellation, dispatch, and schema validation");
  });

  test("cross-links to manifest-schema.md", async () => {
    content ??= await readText(join(DOCS_DIR, "api-reference.md"));
    expect(content).toContain("manifest-schema.md");
  });

  test("documents every control tool and exact revision rules", async () => {
    content ??= await readText(join(DOCS_DIR, "api-reference.md"));
    for (const tool of ["describe", "workspace", "build", "inspect", "release"]) expect(content).toContain(`extensions_${tool}`);
    expect(content).toContain("expectedRevision");
    expect(content).toContain("idempotency key");
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
    "tools",
    "skills",
    "agents",
    "MCP",
    "workflows",
    "settings",
  ];

  for (const component of componentTypes) {
    test(`documents component type: ${component}`, async () => {
      content ??= await readText(join(DOCS_DIR, "manifest-schema.md"));
      expect(content).toContain(component);
    });
  }

  const permissionTypes = ["network", "filesystem", "shell", "env"];

  test("documents all retained capability families", async () => {
    content ??= await readText(join(DOCS_DIR, "manifest-schema.md"));
    for (const perm of permissionTypes) {
      expect(content).toContain(perm);
    }
  });

  test("cross-links to api-reference.md", async () => {
    content ??= await readText(join(DOCS_DIR, "manifest-schema.md"));
    expect(content).toContain("api-reference.md");
  });

  test("references the shared v4 template and canonical schema", async () => {
    content ??= await readText(join(DOCS_DIR, "manifest-schema.md"));
    expect(content).toContain("schemaVersion: 4");
    expect(content).toContain("extensions_describe");
    expect(content).toContain("extension-contract/src/wire-schema.json");
    expect(content).not.toContain("schemaVersion: 2");
  });

  test("separates declared capabilities from runtime authority", async () => {
    content ??= await readText(join(DOCS_DIR, "manifest-schema.md"));
    expect(content).toContain("A declaration is not a grant");
    expect(content).toContain("Changing a manifest on disk never updates an active installation");
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
  test("documented starter files match the executable shared scaffold", async () => {
    const content = await readText(join(DOCS_DIR, "getting-started.md"));
    const { scaffoldWorkspace } = await import("@ezcorp/sdk/scaffold");
    const scaffold = scaffoldWorkspace({ name: "my-extension", description: "Documented starter" });
    for (const path of ["extension.ts", "src/echo.ts", "src/echo.test.ts"]) {
      expect(content).toContain(path);
      expect(scaffold.files[path]).toBeDefined();
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
  test("delegates through the scoped SDK invoke helper", async () => {
    const content = await readText(
      join(EXAMPLES_DIR, "code-review-delegator", "index.ts"),
    );
    expect(content).toContain('from "@ezcorp/sdk/runtime"');
    expect(content).toContain('invoke<ToolCallResult>("project-analyzer.readFile"');
    expect(content).toContain('invoke<ToolCallResult>("code-quality.analyzeFile"');
  });
});

describe("markdown-utils/ezcorp.config.ts", () => {
  test("discovers validated v4 metadata without host-side config promotion", async () => {
    const { discoverFirstPartyManifest } = await import("./helpers/first-party-manifest");
    const manifest = await discoverFirstPartyManifest(join(EXAMPLES_DIR, "markdown-utils"));
    expect(manifest.schemaVersion).toBe(4);
    expect(Object.hasOwn(manifest, "_inheritedFromV2")).toBe(false);
  });
});
