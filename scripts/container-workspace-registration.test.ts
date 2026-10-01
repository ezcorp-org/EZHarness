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
 * Second rule: dist/ and tsc build info are never part of a context
 * (.dockerignore, and Dockerfile.test.dockerignore beside its file, exclude
 * them), so a stage that builds the web app must first build every workspace
 * package, and it does so only through the root `build:packages` script
 * (scripts/build-workspace-packages.ts derives the order). No container file
 * or root script builds one package by hand.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
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

const BUILD_STEP = /\bbun run(?:\s+--cwd[=\s]+\S+)?\s+build\b|\bvite build\b/;
const BUILD_PACKAGES_STEP = /\bbun run build:packages\b/;

interface BuildFinding {
  readonly instruction: number;
  readonly finding: string;
}

/** Package builds that bypass `build:packages`, and web builds whose stage has not run it first. */
function buildFindings(containerText: string): BuildFinding[] {
  const found: BuildFinding[] = [];
  let packagesBuilt = false;
  instructions(containerText).forEach((instruction, index) => {
    const keyword = instruction.split(/\s+/, 1)[0]!.toUpperCase();
    if (keyword === "FROM") { packagesBuilt = false; return; }
    if (keyword !== "RUN") return;
    for (const step of runSteps(instruction)) {
      if (step.directory === "" && BUILD_PACKAGES_STEP.test(step.segment)) packagesBuilt = true;
      else if (!BUILD_STEP.test(step.segment)) continue;
      else if (step.directory.startsWith("packages/")) found.push({ instruction: index, finding: `builds ${step.directory} by hand` });
      else if (step.directory === "web" && !packagesBuilt) found.push({ instruction: index, finding: "builds web before bun run build:packages" });
    }
  });
  return found;
}

/** The ignore file a build of `containerFile` from the repository root uses: `<file>.dockerignore` beside it, else the root one. */
function ignoreFileFor(containerFile: string, exists: (path: string) => boolean): string {
  return exists(`${containerFile}.dockerignore`) ? `${containerFile}.dockerignore` : ".dockerignore";
}

const BUILD_OUTPUT_RULES = ["packages/@ezcorp/*/dist", "packages/@ezcorp/*/*.tsbuildinfo"];

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

describe("workspace packages are built from source, through one script, in every image", () => {
  const read = (path: string) => readFileSync(resolve(ROOT, path), "utf8");
  const files = git("ls-files", "--", "*Dockerfile*", "*Containerfile*").split("\n").filter(Boolean).filter(isContainerFile);
  const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;

  test("the root build:packages script is the one package build, and postinstall uses it", () => {
    expect(scripts["build:packages"]).toBe("bun scripts/build-workspace-packages.ts");
    expect(scripts.postinstall).toContain("bun run build:packages");
    const handBuilt = Object.entries(scripts).filter(([, command]) => runSteps(command).some(step => step.directory.startsWith("packages/") && BUILD_STEP.test(step.segment)));
    expect(handBuilt).toEqual([]);
  });

  test.each(files.length > 0 ? files : ["<none>"])("%s builds packages only through build:packages, before any web build", path => {
    expect(buildFindings(read(path)).map(finding => ({ path, ...finding }))).toEqual([]);
  });

  test.each(files.length > 0 ? files : ["<none>"])("%s builds from a context that excludes workspace build outputs", path => {
    if (!instructions(read(path)).some(instruction => /^COPY\s/i.test(instruction) && !/\s--from=/.test(instruction) && copySources(instruction).includes("."))) return;
    const ignore = ignoreFileFor(path, candidate => existsSync(resolve(ROOT, candidate)));
    const rules = read(ignore).split("\n").map(line => line.trim());
    expect({ path, ignore, missing: BUILD_OUTPUT_RULES.filter(rule => !rules.includes(rule)) }).toEqual({ path, ignore, missing: [] });
  });

  test("the images that build packages are found", () => {
    for (const path of ["Dockerfile", "Dockerfile.dev", "Dockerfile.test", "deploy/factory/Dockerfile"]) {
      expect(instructions(read(path)).some(instruction => BUILD_PACKAGES_STEP.test(instruction))).toBe(true);
    }
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

describe("the build-step reader", () => {
  test("flags a package built by hand and a web build before build:packages, per stage", () => {
    const text = [
      "FROM x AS builder",
      "COPY . .",
      "RUN cd web && bun run build",
      "RUN bun run --cwd packages/a build && (cd packages/b && bun run build)",
      "RUN bun run build:packages --force",
      "RUN cd web && PI_SKIP_INIT=1 bun run build",
      "FROM y",
      "RUN sh -c 'cd web && bunx vite build'",
      "RUN bun run build",
    ].join("\n");
    expect(buildFindings(text)).toEqual([
      { instruction: 2, finding: "builds web before bun run build:packages" },
      { instruction: 3, finding: "builds packages/a by hand" },
      { instruction: 3, finding: "builds packages/b by hand" },
      { instruction: 7, finding: "builds web before bun run build:packages" },
    ]);
  });

  test("uses the ignore file beside a container file when there is one", () => {
    expect(ignoreFileFor("Dockerfile.test", path => path === "Dockerfile.test.dockerignore")).toBe("Dockerfile.test.dockerignore");
    expect(ignoreFileFor("deploy/factory/Dockerfile", () => false)).toBe(".dockerignore");
  });
});
