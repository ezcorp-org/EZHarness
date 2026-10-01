/**
 * Every container file that runs `bun install --frozen-lockfile` must put on
 * disk, before the install, every file that install reads: the directory's
 * package.json and bun.lock, the package.json of EVERY workspace its bun.lock
 * names, and every patch file its package.json's `patchedDependencies` names.
 * A frozen install fails closed on any of them missing ("listed in bun.lock
 * but not on disk", "Couldn't find patch file"), and the image build dies
 * there. The lock and the manifest are the one source of truth: the list is
 * derived from them here, never kept by hand. The container files stay
 * explicit COPY lines because a builder cannot read the lock before the copy.
 *
 * A stage puts a file on disk by copying it, a directory that holds it, or the
 * whole context (`COPY . .`). Copies keep the repository layout in this repo's
 * container files, so a source path stands for its destination.
 *
 * Second rule: dist/ is never tracked, so a clean checkout has none. Every stage
 * that builds the web app or a workspace package must first build each
 * workspace the app sources import (with what those depend on) whose `import`
 * export points into dist/; a package build also builds its tsc references.
 * The set is derived from the imports and manifests, never kept by hand.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { basename, posix, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");

/** The workspace paths a bun.lock names, without the root package (""). */
function lockWorkspaces(lockText: string): string[] {
  const lock = Bun.JSONC.parse(lockText) as { workspaces?: Record<string, unknown> };
  return Object.keys(lock.workspaces ?? {}).filter(path => path !== "").sort();
}

/** The patch files a package.json's `patchedDependencies` names. */
function manifestPatches(manifestText: string): string[] {
  const manifest = JSON.parse(manifestText) as { patchedDependencies?: Record<string, string> };
  return Object.values(manifest.patchedDependencies ?? {}).sort();
}

/** Every repository path a frozen install in `directory` reads ("" is the repository root). */
function installInputs(directory: string, read: (path: string) => string): string[] {
  const at = (path: string) => posix.join(directory, path);
  return [
    at("package.json"),
    at("bun.lock"),
    ...lockWorkspaces(read(at("bun.lock"))).map(workspace => at(`${workspace}/package.json`)),
    ...manifestPatches(read(at("package.json"))).map(at),
  ];
}

/** Logical instructions: continuation lines joined, comments and blanks dropped. */
function instructions(text: string): string[] {
  const out: string[] = [];
  let pending = "";
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (pending === "" && (line === "" || line.startsWith("#"))) continue;
    if (line.endsWith("\\")) { pending += `${line.slice(0, -1)} `; continue; }
    out.push(pending + line);
    pending = "";
  }
  if (pending !== "") out.push(pending.trim());
  return out;
}

const normalizeDirectory = (directory: string) => posix.normalize(directory).replace(/^\.$/, "").replace(/\/$/, "");

/** Each shell step of a RUN command with the directory it runs in, following `cd <dir>` and `--cwd <dir>`. */
function runSteps(command: string): { directory: string; segment: string }[] {
  const steps: { directory: string; segment: string }[] = [];
  let directory = "";
  for (const segment of command.split(/&&|;|\|\|/)) {
    const cd = /(?:^|[\s('"])cd\s+([^\s)'"]+)/.exec(segment);
    if (cd) directory = cd[1]!;
    const cwd = /--cwd[=\s]+([^\s)'"]+)/.exec(segment);
    steps.push({ directory: normalizeDirectory(cwd ? cwd[1]! : directory), segment });
  }
  return steps;
}

/** The directory of each frozen install a RUN command performs. */
function frozenInstallDirectories(command: string): string[] {
  return runSteps(command).filter(step => /\bbun install\b/.test(step.segment) && step.segment.includes("--frozen-lockfile")).map(step => step.directory);
}

/** The source paths of a COPY instruction (options dropped, destination dropped). */
function copySources(instruction: string): string[] {
  const words = instruction.split(/\s+/).slice(1).filter(word => !word.startsWith("--"));
  return words.slice(0, -1).map(source => posix.normalize(source).replace(/\/$/, ""));
}

interface FrozenInstall {
  readonly instruction: number;
  readonly directory: string;
  readonly missing: readonly string[];
}

/** Each frozen install in a container file, with the inputs its stage has not put on disk. */
function frozenInstalls(containerText: string, inputs: (directory: string) => readonly string[]): FrozenInstall[] {
  const found: FrozenInstall[] = [];
  let copied: string[] = [];
  instructions(containerText).forEach((instruction, index) => {
    const keyword = instruction.split(/\s+/, 1)[0]!.toUpperCase();
    if (keyword === "FROM") { copied = []; return; }
    if (keyword === "COPY" && !/\s--from=/.test(instruction)) { copied.push(...copySources(instruction)); return; }
    if (keyword !== "RUN") return;
    for (const directory of frozenInstallDirectories(instruction)) {
      const onDisk = (path: string) => copied.some(source => source === "." || source === path || path.startsWith(`${source}/`));
      found.push({ instruction: index, directory, missing: inputs(directory).filter(path => !onDisk(path)) });
    }
  });
  return found;
}

/** True when an `exports` map resolves some subpath's `import` condition into ./dist/ (a build output, never tracked). */
function importsDist(exports: unknown): boolean {
  if (typeof exports !== "object" || exports === null) return false;
  return Object.entries(exports).some(([condition, target]) =>
    (condition === "import" && typeof target === "string" && target.startsWith("./dist/")) || importsDist(target));
}

/**
 * The workspaces the web bundle reads from dist/: every workspace the app sources import by name, with the workspaces those
 * depend on, kept when its `exports` send the `import` condition into ./dist/.
 */
function bundledDistWorkspaces(sources: readonly string[], workspaces: readonly string[], read: (path: string) => string): string[] {
  const manifest = (directory: string) => JSON.parse(read(`${directory}/package.json`)) as {
    name?: string; exports?: unknown; dependencies?: Record<string, string>; peerDependencies?: Record<string, string>;
  };
  const byName = new Map(workspaces.map(directory => [manifest(directory).name, directory]));
  const needed = new Set<string>();
  const need = (name: string) => {
    const directory = byName.get(name);
    if (directory === undefined || needed.has(directory)) return;
    needed.add(directory);
    const { dependencies = {}, peerDependencies = {} } = manifest(directory);
    for (const dependency of Object.keys({ ...dependencies, ...peerDependencies })) need(dependency);
  };
  for (const path of sources) {
    for (const match of read(path).matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)["'](@ezcorp\/[a-z0-9-]+)/g)) need(match[1]!);
  }
  return [...needed].filter(directory => importsDist(manifest(directory).exports)).sort();
}

/** The workspace directories a package build's tsconfig.build.json references (tsc -b builds them too). */
function buildReferences(directory: string, read: (path: string) => string): string[] {
  let text: string;
  try { text = read(`${directory}/tsconfig.build.json`); } catch { return []; }
  const config = Bun.JSONC.parse(text) as { references?: { path: string }[] };
  return (config.references ?? []).map(reference => normalizeDirectory(posix.join(directory, posix.dirname(reference.path))));
}

interface BundleBuild {
  readonly instruction: number;
  readonly missing: readonly string[];
}

const BUILD_STEP = /\bbun run(?:\s+--cwd[=\s]+\S+)?\s+build\b|\bvite build\b/;

/**
 * Each web build, and each stage that builds workspace packages without a web build, with the required dist/ workspaces the
 * stage has not built by then. A package build also builds its tsc project references.
 */
function bundleBuilds(containerText: string, required: readonly string[], references: (directory: string) => readonly string[]): BundleBuild[] {
  const found: BundleBuild[] = [];
  let built = new Set<string>();
  let lastPackageBuild = -1;
  let webBuilt = false;
  const missing = () => required.filter(directory => !built.has(directory));
  const build = (directory: string) => {
    if (built.has(directory)) return;
    built.add(directory);
    for (const reference of references(directory)) build(reference);
  };
  const closeStage = () => {
    if (lastPackageBuild >= 0 && !webBuilt) found.push({ instruction: lastPackageBuild, missing: missing() });
    built = new Set();
    lastPackageBuild = -1;
    webBuilt = false;
  };
  instructions(containerText).forEach((instruction, index) => {
    const keyword = instruction.split(/\s+/, 1)[0]!.toUpperCase();
    if (keyword === "FROM") { closeStage(); return; }
    if (keyword !== "RUN") return;
    for (const step of runSteps(instruction)) {
      if (!BUILD_STEP.test(step.segment)) continue;
      if (step.directory === "web") { webBuilt = true; found.push({ instruction: index, missing: missing() }); }
      else if (step.directory.startsWith("packages/")) { build(step.directory); lastPackageBuild = index; }
    }
  });
  closeStage();
  return found;
}

function git(...args: string[]): string {
  // A hook exports GIT_DIR and friends; this read finds its repository from cwd.
  const env = { ...process.env };
  for (const name of ["GIT_DIR", "GIT_INDEX_FILE", "GIT_WORK_TREE", "GIT_PREFIX"]) delete env[name];
  const result = spawnSync("git", args, { cwd: ROOT, env, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout;
}

/**
 * Tracked container files: a basename of Dockerfile or Containerfile, with or
 * without a `.<name>` suffix. A `.txt` copy is a validation record of a past
 * build input, never built, so it is not a container file.
 */
function isContainerFile(path: string): boolean {
  return /^(Dockerfile|Containerfile)(\.[A-Za-z0-9_-]+)?$/.test(basename(path)) && !path.endsWith(".txt");
}

describe("container files put every input of a frozen install on disk first", () => {
  const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
  const inputs = (directory: string) => installInputs(directory, read);
  const files = git("ls-files", "--", "*Dockerfile*", "*Containerfile*").split("\n").filter(Boolean).filter(isContainerFile);
  const installs = new Map(files.map(path => [path, frozenInstalls(read(path), inputs)]));

  test("the inputs come from the locks and manifests, and the scan finds the image files", () => {
    expect(inputs("")).toContain("packages/@ezcorp/sdk/package.json");
    expect(inputs("")).toContain("packages/@ezcorp/factory-sdk/package.json");
    expect(inputs("web")).toContain("web/patches/@stryker-mutator%2Fvitest-runner@10.0.0.patch");
    expect(installs.get("Dockerfile")?.map(install => install.directory)).toEqual(["", "web", "", "web"]);
    expect(installs.get("Dockerfile.dev")?.map(install => install.directory)).toEqual(["", "web"]);
  });

  test.each(files.length > 0 ? files : ["<none>"])("%s puts every frozen-install input on disk", path => {
    const incomplete = (installs.get(path) ?? []).filter(install => install.missing.length > 0);
    expect(incomplete.map(install => ({ path, ...install }))).toEqual([]);
  });
});

describe("container files build every dist/ workspace the web bundle reads before they build it", () => {
  const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
  const sources = git("ls-files", "--", "src", "web/src").split("\n")
    .filter(path => /\.(ts|js|svelte)$/.test(path) && !/(\.test\.|\.spec\.|__tests__\/)/.test(path));
  const required = bundledDistWorkspaces(sources, lockWorkspaces(read("bun.lock")), read);
  const files = git("ls-files", "--", "*Dockerfile*", "*Containerfile*").split("\n").filter(Boolean).filter(isContainerFile);
  const builds = new Map(files.map(path => [path, bundleBuilds(read(path), required, directory => buildReferences(directory, read))]));

  test("the required set comes from the app's imports, and the scan finds the building images", () => {
    expect(required).toEqual(expect.arrayContaining(["packages/@ezcorp/factory-sdk", "packages/@ezcorp/factory-transport", "packages/@ezcorp/sdk"]));
    expect(required).not.toContain("packages/@ezcorp/extension-runner");
    expect(buildReferences("packages/@ezcorp/sdk", read)).toEqual(["packages/@ezcorp/extension-contract"]);
    for (const path of ["Dockerfile", "Dockerfile.dev", "Dockerfile.test"]) expect(builds.get(path)?.length).toBeGreaterThan(0);
  });

  test.each(files.length > 0 ? files : ["<none>"])("%s builds every required dist/ workspace before the bundle", path => {
    const incomplete = (builds.get(path) ?? []).filter(check => check.missing.length > 0);
    expect(incomplete.map(check => ({ path, ...check }))).toEqual([]);
  });
});

describe("the container-file reader", () => {
  const inputs = (directory: string) => (directory === "" ? ["package.json", "packages/a/package.json", "packages/b/package.json"] : ["web/package.json", "web/patches/p.patch"]);

  test("reports each input a stage did not copy, per frozen install and directory", () => {
    const text = [
      "FROM base AS builder",
      "COPY package.json bun.lock ./",
      "COPY packages/a/package.json packages/a/",
      "RUN --mount=type=cache,target=/c bun install --frozen-lockfile --ignore-scripts",
      "COPY web/package.json web/bun.lock web/",
      "RUN cd web && bun install --frozen-lockfile",
      "FROM base",
      "COPY --chown=1:1 package.json packages/a/package.json ./",
      "COPY --chown=1:1 packages/b/package.json packages/b/",
      "COPY web/package.json web/",
      "COPY web/patches/ web/patches/",
      "RUN bun install --production --frozen-lockfile && bun install --cwd web --frozen-lockfile",
    ].join("\n");
    expect(frozenInstalls(text, inputs)).toEqual([
      { instruction: 3, directory: "", missing: ["packages/b/package.json"] },
      { instruction: 5, directory: "web", missing: ["web/patches/p.patch"] },
      { instruction: 11, directory: "", missing: [] },
      { instruction: 11, directory: "web", missing: [] },
    ]);
  });

  test("a whole-context copy satisfies the stage; a copy from another stage does not", () => {
    expect(frozenInstalls("FROM x\nCOPY . .\nRUN bun install --frozen-lockfile", inputs)).toEqual([{ instruction: 2, directory: "", missing: [] }]);
    expect(frozenInstalls("FROM x\nCOPY --from=builder . .\nRUN bun install --frozen-lockfile", inputs)[0]!.missing).toEqual(inputs(""));
  });

  test("a FROM resets what the stage has on disk", () => {
    expect(frozenInstalls("FROM x\nCOPY . .\nFROM y\nRUN bun install --frozen-lockfile", inputs)[0]!.missing).toEqual(inputs(""));
  });

  test("joins continuation lines, skips comments and unfrozen installs, follows cd in a subshell and sh -c", () => {
    const text = [
      "# RUN bun install --frozen-lockfile",
      "FROM x",
      "RUN bun install",
      "RUN sh -c 'cd web && bun install --frozen-lockfile'",
      "RUN echo ready \\",
      "  && bun install --frozen-lockfile \\",
      "  && (cd ./web/ && bun install --frozen-lockfile)",
      "RUN bun install --frozen-lockfile --cwd=. \\",
    ].join("\n");
    expect(frozenInstalls(text, inputs).map(install => [install.instruction, install.directory])).toEqual([[2, "web"], [3, ""], [3, "web"], [4, ""]]);
  });

  test("derives the inputs from the lock's workspaces and the manifest's patches", () => {
    const files: Record<string, string> = {
      "package.json": "{}",
      "bun.lock": '{ "workspaces": { "": {}, "packages/b": {}, "packages/a": {}, }, }',
      "web/package.json": '{ "patchedDependencies": { "x@1": "patches/x@1.patch" } }',
      "web/bun.lock": '{ "lockfileVersion": 1, }',
    };
    const read = (path: string) => files[path]!;
    expect(installInputs("", read)).toEqual(["package.json", "bun.lock", "packages/a/package.json", "packages/b/package.json"]);
    expect(installInputs("web", read)).toEqual(["web/package.json", "web/bun.lock", "web/patches/x@1.patch"]);
  });

  test("treats Dockerfile and Containerfile names as container files, never a .txt record", () => {
    expect(["Dockerfile", "Dockerfile.dev", "deploy/factory/Dockerfile", "x/Containerfile"].every(isContainerFile)).toBe(true);
    expect(["docs/inputs/Dockerfile.txt", "Dockerfile.dev.bak.old", "scripts/Dockerfile-notes.md"].some(isContainerFile)).toBe(false);
  });
});

describe("the bundle-build reader", () => {
  const required = ["packages/a", "packages/b", "packages/c"];
  const references = (directory: string) => (directory === "packages/b" ? ["packages/c"] : []);

  test("checks each web build against the packages its stage built, references included", () => {
    const text = [
      "FROM x AS builder",
      "COPY . .",
      "RUN bun run --cwd packages/b build",
      "RUN cd web && PI_SKIP_INIT=1 bun run build",
      "RUN bun run --cwd packages/a build --force",
      "RUN cd web && bunx vite build",
    ].join("\n");
    expect(bundleBuilds(text, required, references)).toEqual([
      { instruction: 3, missing: ["packages/a"] },
      { instruction: 5, missing: [] },
    ]);
  });

  test("checks a stage that builds packages without a web build at its last package build; a FROM resets it", () => {
    const text = ["FROM x", "RUN bun run --cwd packages/a build \\", " && bun run --cwd packages/b build", "FROM y", "RUN bun run build", "RUN echo done"].join("\n");
    expect(bundleBuilds(text, required, references)).toEqual([{ instruction: 1, missing: [] }]);
    expect(bundleBuilds("FROM x\nRUN bun run --cwd packages/a build", required, references)).toEqual([{ instruction: 1, missing: ["packages/b", "packages/c"] }]);
  });

  test("derives the required set from imports, dependencies and dist/ import exports", () => {
    const files: Record<string, string> = {
      "src/a.ts": 'import { x } from "@ezcorp/app";\nconst y = await import("@ezcorp/other/sub");',
      "web/src/b.svelte": "import '@ezcorp/unknown';",
      "packages/app/package.json": JSON.stringify({ name: "@ezcorp/app", exports: { ".": { bun: "./src/index.ts", import: "./dist/index.js" } }, dependencies: { "@ezcorp/lib": "workspace:*" } }),
      "packages/lib/package.json": JSON.stringify({ name: "@ezcorp/lib", exports: { "./x": { import: "./dist/x.js" } } }),
      "packages/other/package.json": JSON.stringify({ name: "@ezcorp/other", exports: { ".": { bun: "./src/index.ts", import: "./src/index.ts" } }, peerDependencies: { "@ezcorp/app": "*" } }),
      "packages/unused/package.json": JSON.stringify({ name: "@ezcorp/unused", exports: { ".": { import: "./dist/i.js" } } }),
    };
    const read = (path: string) => { const text = files[path]; if (text === undefined) throw new Error(`no ${path}`); return text; };
    const workspaces = ["packages/app", "packages/lib", "packages/other", "packages/unused"];
    expect(bundledDistWorkspaces(["src/a.ts", "web/src/b.svelte"], workspaces, read)).toEqual(["packages/app", "packages/lib"]);
    expect(importsDist("./dist/x.js")).toBe(false);
  });

  test("reads tsc project references relative to the package, and none without a build config", () => {
    const read = (path: string) => {
      if (path === "packages/b/tsconfig.build.json") return '{ // comment\n "references": [{ "path": "../c/tsconfig.build.json" }], }';
      throw new Error("ENOENT");
    };
    expect(buildReferences("packages/b", read)).toEqual(["packages/c"]);
    expect(buildReferences("packages/a", read)).toEqual([]);
  });
});
