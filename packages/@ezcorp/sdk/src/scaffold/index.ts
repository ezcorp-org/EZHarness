// ── Pure scaffolder for ezcorp extensions ────────────────────────────
//
// `scaffoldExtension({ name, type, description })` returns a
// `{ files: Record<relpath, content> }` map without touching the
// filesystem. Two consumers:
//   - `bun run ext:init` CLI (host's `src/extensions/sdk/init.ts`)
//   - `extension-author` bundled extension (writes to a draft dir
//     under `.ezcorp/extension-data/extension-author/drafts/<draftId>/`)
//
// External LLMs (Claude Code, ChatGPT, etc.) helping users build
// EZCorp extensions outside the app can also import this primitive:
// `import { scaffoldExtension } from "@ezcorp/sdk"`.

import { toolEntrypoint, toolManifest, toolReadme, toolTest } from "./templates/tool";
import { skillEntrypoint, skillManifest, skillReadme, skillTest } from "./templates/skill";
import { agentEntrypoint, agentManifest, agentReadme, agentTest } from "./templates/agent";
import { multiEntrypoint, multiManifest, multiReadme, multiTest } from "./templates/multi";

// Mirrors the host's `manifest.ts:NAME_REGEX`. Kept inline so the
// scaffolder doesn't reach into the validator's private constants.
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
  // Standalone tsconfig — no workspace-root `extends`. Scaffolded
  // extensions resolve `@ezcorp/sdk` via `bun add @ezcorp/sdk` from
  // the npm registry, identical to any third-party consumer.
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

export interface ScaffoldOptions {
  name: string;
  type: ExtType;
  description: string;
}

export interface ScaffoldResult {
  /** Map of relative path → file content. No leading "./". */
  files: Record<string, string>;
}

/**
 * Pure scaffolder. Does NOT write to disk — returns the file map for
 * the caller to persist. Throws on invalid `name` or `type`.
 *
 * The four templates produce different file sets:
 *   - tool/multi:  manifest + index.ts + index.test.ts + README + tsconfig + package.json + .gitignore
 *   - skill/agent: manifest + index.test.ts + README + tsconfig + package.json + .gitignore
 *     (no index.ts — skills are prompt-based, agents are persona-only)
 *
 * The `index.ts` omission for skill/agent matches the CLI's behavior
 * exactly.
 */
export function scaffoldExtension(opts: ScaffoldOptions): ScaffoldResult {
  if (!opts.name || typeof opts.name !== "string") {
    throw new Error("scaffoldExtension: name is required");
  }
  if (!NAME_REGEX.test(opts.name) || opts.name.includes("..")) {
    throw new Error(
      `scaffoldExtension: name must match /^[a-z0-9][a-z0-9-_.]{0,63}$/ (got "${opts.name}")`,
    );
  }
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
    "index.test.ts": test,
    "README.md": readme,
    ".gitignore": GITIGNORE,
    "tsconfig.json": generateTsconfig(),
    "package.json": generatePackageJson(opts.name, description),
  };
  // Skill/agent templates return empty entrypoint — omit `index.ts`
  // from the file map, matching the CLI's behavior.
  if (entrypoint) {
    files["index.ts"] = entrypoint;
  }
  return { files };
}
