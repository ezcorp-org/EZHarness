/**
 * Claude skill-bundle discovery + synthesis.
 *
 * A Claude skill is a directory with a `SKILL.md` (YAML frontmatter
 * `name`/`description` + a markdown instructions body) plus optional
 * helper scripts. EZCorp has no native "freeform skill" runtime, so
 * the import wizard turns each bundle into a **runnable tool
 * extension**: a synthesized `ezcorp.config.ts` declaring the generic
 * three-tool shim (`skill_info` / `list_scripts` / `run_script`) plus
 * the verbatim bundle copied under `./skill/`, handed to the existing
 * `installFromLocal` pipeline by the commit endpoint.
 *
 * The runner entrypoint is shipped as a sibling `.template.ts` and
 * copied verbatim — keeping it real, type-checked code instead of an
 * escaped string blob.
 */

import { readdir, realpath, mkdir, writeFile, cp } from "node:fs/promises";
import { join, basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parseCommandFile } from "../commands/parser";
import { realpathInsideRoot, EXCLUDED_DIR_NAMES } from "../fs/scan-fs";

export const SKILL_MARKER = "SKILL.md";
/** Max skill bundles surfaced from one upload. */
export const MAX_SKILL_BUNDLES = 200;
/** Max script files listed per bundle (preview only — runtime re-lists). */
export const MAX_SCRIPTS_PER_BUNDLE = 500;
const MAX_WALK_DEPTH = 32;

export interface ScanLimits {
  maxBundles: number;
  maxScripts: number;
  maxDepth: number;
}

export const DEFAULT_SCAN_LIMITS: ScanLimits = {
  maxBundles: MAX_SKILL_BUNDLES,
  maxScripts: MAX_SCRIPTS_PER_BUNDLE,
  maxDepth: MAX_WALK_DEPTH,
};

// Canonical tool descriptors. MUST stay in sync with `TOOLS` in
// skill-runner.template.ts (a test pins this). They live in both
// places because the runner template is standalone, copied-verbatim
// code that cannot import from this module.
export const SKILL_TOOLS = [
  {
    name: "skill_info",
    description:
      "Return this skill's full instructions (the SKILL.md body). Call this first to learn how to use the skill.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "list_scripts",
    description: "List the helper script/asset files bundled with this skill.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "run_script",
    description:
      "Run one bundled script from this skill. `script` is a path relative to the skill root; `args` are passed through.",
    inputSchema: {
      type: "object",
      properties: {
        script: { type: "string", description: "Skill-relative script path" },
        args: { type: "array", items: { type: "string" } },
      },
      required: ["script"],
    },
  },
] as const;

const RUNNER_TEMPLATE_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "skill-runner.template.ts",
);

export interface SkillBundle {
  /** Stable selection token (sanitized, unique within one scan). */
  id: string;
  /** Sanitized extension-name candidate (collisions resolved at commit). */
  name: string;
  /** Human label from frontmatter `name` or the bundle dir basename. */
  rawName: string;
  description: string;
  /** SKILL.md body — the skill's instructions. */
  instructions: string;
  /** Absolute bundle dir (contains SKILL.md). Server-internal. */
  dir: string;
  /** Bundle-relative file paths excluding SKILL.md. */
  scripts: string[];
}

/**
 * Sanitize an arbitrary skill label into a manifest-safe name:
 * `/^[a-z0-9][a-z0-9-_.]{0,63}$/`, no `..`.
 */
export function skillExtensionName(raw: string): string {
  let s = raw
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/\.\.+/g, ".")
    .replace(/^[^a-z0-9]+/, "")
    .replace(/[-_.]+$/g, "")
    .slice(0, 64)
    .replace(/[-_.]+$/g, "");
  return s.length > 0 ? s : "skill";
}

/**
 * Walk `scanRoot` for directories that directly contain a `SKILL.md`.
 * Confined via realpath; dotdirs are allowed (Claude skills live under
 * `.claude/skills/…`) but `EXCLUDED_DIR_NAMES` (`.git`, `.ezcorp`,
 * `node_modules`) are skipped. Deterministic (sorted) so the preview
 * and commit re-scans agree on ids.
 */
export async function scanSkillBundles(
  scanRoot: string,
  limits: ScanLimits = DEFAULT_SCAN_LIMITS,
): Promise<SkillBundle[]> {
  let realRoot: string;
  try {
    realRoot = await realpath(scanRoot);
  } catch {
    return [];
  }

  const bundleDirs: string[] = [];
  async function walk(dir: string, depth: number): Promise<void> {
    if (depth > limits.maxDepth || bundleDirs.length >= limits.maxBundles) return;
    if (!(await realpathInsideRoot(realRoot, dir))) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === SKILL_MARKER)) {
      bundleDirs.push(dir);
      return; // a skill bundle is a leaf for scan purposes
    }
    const subdirs = entries
      .filter((e) => e.isDirectory() && !EXCLUDED_DIR_NAMES.has(e.name))
      .map((e) => e.name)
      .sort();
    for (const name of subdirs) {
      if (bundleDirs.length >= limits.maxBundles) break;
      await walk(join(dir, name), depth + 1);
    }
  }
  await walk(realRoot, 0);

  const seen = new Set<string>();
  const out: SkillBundle[] = [];
  for (const dir of bundleDirs.sort()) {
    let raw: string;
    try {
      raw = await Bun.file(join(dir, SKILL_MARKER)).text();
    } catch {
      continue;
    }
    const { frontmatter, body } = parseCommandFile(raw);
    const rawName = (frontmatter.name?.trim() || basename(dir)).trim();
    const description =
      frontmatter.description?.trim() ||
      `Imported Claude skill: ${rawName}`;

    let id = skillExtensionName(rawName);
    if (seen.has(id)) {
      for (let i = 2; ; i++) {
        const cand = `${id}-${i}`.slice(0, 64);
        if (!seen.has(cand)) {
          id = cand;
          break;
        }
      }
    }
    seen.add(id);

    out.push({
      id,
      name: id,
      rawName,
      description,
      instructions: body,
      dir,
      scripts: await listBundleScripts(dir, limits),
    });
  }
  return out;
}

async function listBundleScripts(
  bundleDir: string,
  limits: ScanLimits,
): Promise<string[]> {
  const out: string[] = [];
  async function walk(dir: string, rel: string, depth: number): Promise<void> {
    if (depth > limits.maxDepth || out.length >= limits.maxScripts) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (out.length >= limits.maxScripts) return;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory() && !EXCLUDED_DIR_NAMES.has(e.name)) {
        await walk(join(dir, e.name), childRel, depth + 1);
      } else if (e.isFile() && childRel !== SKILL_MARKER) {
        out.push(childRel);
      }
    }
  }
  await walk(bundleDir, "", 0);
  return out;
}

/** The synthesized `ezcorp.config.ts` source for a skill bundle. */
export function buildSkillManifestSource(
  name: string,
  description: string,
): string {
  return `import { defineExtension } from "@ezcorp/sdk";

export default defineExtension({
  schemaVersion: 2,
  name: ${JSON.stringify(name)},
  version: "0.1.0",
  description: ${JSON.stringify(description)},
  author: { name: "Imported skill" },
  entrypoint: "./index.ts",
  tools: ${JSON.stringify(SKILL_TOOLS, null, 2)},
  permissions: { shell: true, filesystem: ["."] },
});
`;
}

/**
 * Write a self-contained installable extension dir for `bundle`:
 *
 *   destDir/
 *     ezcorp.config.ts   synthesized manifest (name/description from SKILL.md)
 *     index.ts           verbatim copy of the generic runner template
 *     skill/             verbatim copy of the Claude skill bundle
 *
 * The commit endpoint then calls `installFromLocal(destDir, …)`.
 */
export async function synthesizeSkillExtension(opts: {
  bundle: SkillBundle;
  destDir: string;
  /** Final manifest name (may be `-2`-suffixed by the caller on collision). */
  name: string;
}): Promise<void> {
  const { bundle, destDir, name } = opts;
  await mkdir(destDir, { recursive: true });
  await cp(bundle.dir, join(destDir, "skill"), {
    recursive: true,
    dereference: false,
    force: true,
  });
  await writeFile(
    join(destDir, "ezcorp.config.ts"),
    buildSkillManifestSource(name, bundle.description),
    "utf8",
  );
  const runner = await Bun.file(RUNNER_TEMPLATE_PATH).text();
  await writeFile(join(destDir, "index.ts"), runner, "utf8");
}
