import { toolEntrypoint, toolManifest, toolReadme, toolTest } from "./templates/tool";
import { skillEntrypoint, skillManifest, skillReadme, skillTest } from "./templates/skill";
import { agentEntrypoint, agentManifest, agentReadme, agentTest } from "./templates/agent";
import { multiEntrypoint, multiManifest, multiReadme, multiTest } from "./templates/multi";

const NAME_REGEX = /^[a-z0-9][a-z0-9-_.]{0,63}$/;

export type ExtType = "tool" | "skill" | "agent" | "multi";

export const EXT_TYPES: readonly ExtType[] = ["tool", "skill", "agent", "multi"] as const;

const GITIGNORE = `node_modules/
.env
dist/
*.log
.DS_Store
`;

function generateTsconfig(): string {
  return JSON.stringify({
    compilerOptions: {
      module: "ESNext",
      moduleResolution: "bundler",
      target: "ESNext",
      strict: true,
      types: ["bun"],
      skipLibCheck: true,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
    include: ["*.ts"],
    exclude: ["node_modules", "dist"],
  }, null, 2);
}

function generatePackageJson(name: string, description: string): string {
  return JSON.stringify({
    name,
    version: "0.1.0",
    description,
    type: "module",
    private: true,
    peerDependencies: {
      "@ezcorp/sdk": "0.1.0",
    },
  }, null, 2);
}

export interface ScaffoldOptions {
  name: string;
  type: ExtType;
  description: string;
}

export interface ScaffoldResult {
  /** Map of relative path → file content. No leading "./". */
  files: Record<string, string>;
}

export function scaffoldWorkspace(opts: Pick<ScaffoldOptions, "name" | "description">): ScaffoldResult {
  const { name, description } = opts;
  validateScaffoldName(name);
  const manifest = { schemaVersion: 4, name, version: "1.0.0", description, author: { name: "Extension author" }, permissions: {}, tools: [{ name: "echo", description: "Return the supplied text", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false }, outputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"], additionalProperties: false } }], smokeTest: { tool: "echo", input: { text: "hello" }, expect: { textIncludes: "hello" } } };
  return { files: {
    "extension.ts": `import { defineExtension, serve } from "@ezcorp/sdk/v4";\nimport { echo } from "./src/echo";\n\nconst extension = defineExtension({ manifest: ${JSON.stringify(manifest, null, 2)}, tools: { echo } });\nawait serve(extension);\n`,
    "src/echo.ts": "export function echo(input: Record<string, unknown>) {\n  return { text: input.text };\n}\n",
    "src/echo.test.ts": "import { expect, test } from \"bun:test\";\nimport { echo } from \"./echo\";\n\ntest(\"returns the supplied text\", () => {\n  expect(echo({ text: \"hello\" })).toEqual({ text: \"hello\" });\n});\n",
    "README.md": `# ${name}\n\n${description}\n\nBuild this workspace, review its tests and permissions, then approve the exact release before activation.\n`,
  } };
}

function validateScaffoldName(name: string): void {
  if (!name || typeof name !== "string") {
    throw new Error("scaffoldExtension: name is required");
  }
  if (!NAME_REGEX.test(name) || name.includes("..")) {
    throw new Error(
      `scaffoldExtension: name must match /^[a-z0-9][a-z0-9-_.]{0,63}$/ (got "${name}")`,
    );
  }
}

export function scaffoldExtension(opts: ScaffoldOptions): ScaffoldResult {
  validateScaffoldName(opts.name);
  if (!EXT_TYPES.includes(opts.type)) {
    throw new Error(
      `scaffoldExtension: type must be one of ${EXT_TYPES.join("|")}, got "${String(opts.type)}"`,
    );
  }

  const description = opts.description ?? "An ezcorp extension";

  let manifest: string;
  let entrypoint: string;
  let test: string;
  let readme: string;

  switch (opts.type) {
    case "tool":
      manifest = toolManifest(opts.name, description);
      entrypoint = toolEntrypoint(opts.name, description);
      test = toolTest(opts.name, description);
      readme = toolReadme(opts.name, description);
      break;
    case "skill":
      manifest = skillManifest(opts.name, description);
      entrypoint = skillEntrypoint(opts.name, description);
      test = skillTest(opts.name, description);
      readme = skillReadme(opts.name, description);
      break;
    case "agent":
      manifest = agentManifest(opts.name, description);
      entrypoint = agentEntrypoint(opts.name, description);
      test = agentTest(opts.name, description);
      readme = agentReadme(opts.name, description);
      break;
    case "multi":
      manifest = multiManifest(opts.name, description);
      entrypoint = multiEntrypoint(opts.name, description);
      test = multiTest(opts.name, description);
      readme = multiReadme(opts.name, description);
      break;
  }

  const files: Record<string, string> = {
    "ezcorp.config.ts": manifest,
    "extension.ts": entrypoint,
    "extension.test.ts": test,
    "README.md": readme,
    ".gitignore": GITIGNORE,
    "tsconfig.json": generateTsconfig(),
    "package.json": generatePackageJson(opts.name, description),
  };
  return { files };
}
