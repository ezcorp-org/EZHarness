// ── Extension Init Scaffolding ──────────────────────────────────
import { existsSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { logger } from "../../logger";
const log = logger.child("ext-sdk");

export interface InitOptions {
  extName?: string;
  type?: "tool" | "skill" | "agent" | "multi";
  description?: string;
  /** Override working directory (used by tests). Defaults to process.cwd() */
  cwd?: string;
}

type ExtType = "tool" | "skill" | "agent" | "multi";

const EXT_TYPES: ExtType[] = ["tool", "skill", "agent", "multi"];

interface TemplateModule {
  [key: string]: (name: string, description: string) => string;
}

// Template module paths keyed by type
const TEMPLATE_IMPORTS: Record<ExtType, () => Promise<TemplateModule>> = {
  tool:  () => import("./templates/tool"),
  skill: () => import("./templates/skill"),
  agent: () => import("./templates/agent"),
  multi: () => import("./templates/multi"),
};

// Prefix for template function names
const TEMPLATE_PREFIX: Record<ExtType, string> = {
  tool: "tool",
  skill: "skill",
  agent: "agent",
  multi: "multi",
};

const GITIGNORE = `node_modules/
.env
dist/
*.log
.DS_Store
`;

function generateTsconfig(): string {
  // Standalone tsconfig — no workspace-root `extends`. Scaffolded extensions
  // resolve `@ezcorp/sdk` via `bun add @ezcorp/sdk` from the npm registry,
  // identical to any third-party consumer.
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
    dependencies: {
      "@ezcorp/sdk": "^0.1.0",
    },
  }, null, 2);
}

/** Simple readline prompt (local to avoid circular deps with cli.ts) */
function ask(prompt: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, (answer) => {
      rl.close();
      resolve(answer);
    });
  });
}

export async function initExtension(opts: InitOptions): Promise<void> {
  if (!opts.extName) {
    throw new Error('Extension name required. Usage: ezcorp ext init <name> [--type tool|skill|agent|multi]');
  }

  const cwd = opts.cwd ?? process.cwd();
  const targetDir = resolve(cwd, opts.extName);

  if (existsSync(targetDir)) {
    throw new Error(`Directory "${opts.extName}" already exists`);
  }

  let extType = opts.type;
  let description = opts.description ?? "An ezcorp extension";

  // Interactive wizard if no --type provided
  if (!extType) {
    const descAnswer = await ask(`Description (${description}): `);
    if (descAnswer.trim()) description = descAnswer.trim();

    log.info("Extension type: 1) Tool - MCP tool server, 2) Skill - Prompt & knowledge, 3) Agent - Conversational persona, 4) Multi - Combined");

    const typeAnswer = await ask("\nSelect type [1-4]: ");
    const typeIdx = parseInt(typeAnswer.trim(), 10) - 1;
    extType = EXT_TYPES[typeIdx] ?? "tool";
  }

  // Load template module
  const templateMod = await TEMPLATE_IMPORTS[extType]();
  const prefix = TEMPLATE_PREFIX[extType];

  const manifest = templateMod[`${prefix}Manifest`]!(opts.extName, description);
  const entrypoint = templateMod[`${prefix}Entrypoint`]!(opts.extName, description);
  const testContent = templateMod[`${prefix}Test`]!(opts.extName, description);
  const readme = templateMod[`${prefix}Readme`]!(opts.extName, description);

  // Create directory
  mkdirSync(targetDir, { recursive: true });

  // Write files using Bun.write
  const writes: Promise<number>[] = [
    Bun.write(join(targetDir, "ezcorp.config.ts"), manifest),
    Bun.write(join(targetDir, "index.test.ts"), testContent),
    Bun.write(join(targetDir, "README.md"), readme),
    Bun.write(join(targetDir, ".gitignore"), GITIGNORE),
    Bun.write(join(targetDir, "tsconfig.json"), generateTsconfig()),
    Bun.write(join(targetDir, "package.json"), generatePackageJson(opts.extName, description)),
  ];

  // Only write index.ts if entrypoint is non-empty (skill/agent don't have one)
  if (entrypoint) {
    writes.push(Bun.write(join(targetDir, "index.ts"), entrypoint));
  }

  await Promise.all(writes);

  log.info("Created extension", { name: opts.extName, path: `./${opts.extName}/` });
  log.info(`Next: cd ${opts.extName} && bun install`);
}
