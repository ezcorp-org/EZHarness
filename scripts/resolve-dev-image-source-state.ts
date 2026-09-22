#!/usr/bin/env bun
/** Report whether files Docker can send from this checkout differ from HEAD. */
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, readlinkSync } from "node:fs";
import type { Dirent, Stats } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

type SourceState = "clean" | "dirty" | "unknown";
type TreeEntry = { mode: string; type: string; object: string };
type DockerRule = { pattern: string; negative: boolean };

class UnknownSourceState extends Error {}

function finish(state: SourceState): never {
  process.stdout.write(`${state}\n`);
  process.exit(0);
}

function dirty(reason: string): never {
  if (process.env.EZCORP_DEBUG_SOURCE_STATE === "1") process.stderr.write(`${reason}\n`);
  finish("dirty");
}

const argv = process.argv.slice(2);
const revisionOnly = argv[0] === "--revision";
if (revisionOnly) argv.shift();
const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(argv[0] ?? defaultRoot);

const gitEnv: Record<string, string> = {
  PATH: process.env.PATH ?? "/usr/bin:/bin",
  HOME: process.env.HOME ?? "/nonexistent",
  LC_ALL: "C",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_OPTIONAL_LOCKS: "0",
  GIT_NO_REPLACE_OBJECTS: "1",
};

function git(args: string[]): Uint8Array {
  const result = Bun.spawnSync({
    cmd: ["git", "-c", `safe.directory=${repoRoot}`, "-C", repoRoot, ...args],
    env: gitEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode !== 0) throw new UnknownSourceState();
  return result.stdout;
}

function gitText(args: string[]): string {
  return new TextDecoder().decode(git(args)).trim();
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw new UnknownSourceState();
  }
}

function toContextPath(path: string): string {
  return path.split(sep).join("/");
}

function parseHeadTree(): Map<string, TreeEntry> {
  const output = git(["ls-tree", "-r", "-z", "--full-tree", "HEAD", "--"]);
  const entries = new Map<string, TreeEntry>();
  let start = 0;
  for (let index = 0; index <= output.length; index++) {
    if (index !== output.length && output[index] !== 0) continue;
    if (index === start) { start = index + 1; continue; }
    const record = output.subarray(start, index);
    const tab = record.indexOf(9);
    if (tab < 0) throw new UnknownSourceState();
    const metadata = new TextDecoder().decode(record.subarray(0, tab)).split(" ");
    if (metadata.length !== 3) throw new UnknownSourceState();
    const path = new TextDecoder().decode(record.subarray(tab + 1));
    entries.set(path, { mode: metadata[0]!, type: metadata[1]!, object: metadata[2]! });
    start = index + 1;
  }
  return entries;
}

function trackedDirectories(entries: Iterable<string>): Set<string> {
  const directories = new Set<string>();
  for (const path of entries) {
    let parent = dirname(path);
    while (parent !== "." && !directories.has(parent)) {
      directories.add(parent);
      parent = dirname(parent);
    }
  }
  return directories;
}

function literalPrefix(pattern: string): string | undefined {
  const segments: string[] = [];
  for (const segment of pattern.split("/")) {
    if (!segment) continue;
    let literal = "";
    for (let index = 0; index < segment.length; index++) {
      const character = segment[index]!;
      if (character === "\\") {
        const escaped = segment[index + 1];
        if (escaped === undefined) return undefined;
        literal += escaped;
        index++;
      } else if (character === "*" || character === "?" || character === "[") {
        // A wildcard in the first path component can reopen any root entry.
        // A later wildcard can only reopen descendants of the complete static
        // components before it. Never use a partial component to prune.
        return segments.length === 0 ? undefined : segments.join("/");
      } else {
        literal += character;
      }
    }
    segments.push(literal);
  }
  return segments.join("/");
}

function negativeTraversalPrefixes(matcher: unknown): Array<string | undefined> {
  const rules = (matcher as { _rules?: DockerRule[] })._rules;
  if (!Array.isArray(rules)) throw new UnknownSourceState();
  return rules.filter(rule => rule.negative).map(rule => literalPrefix(rule.pattern));
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function blobHash(bytes: Uint8Array, algorithm: "sha1" | "sha256"): string {
  const header = new TextEncoder().encode(`blob ${bytes.byteLength}\0`);
  return createHash(algorithm).update(header).update(bytes).digest("hex");
}

try {
  if (gitText(["rev-parse", "--is-inside-work-tree"]) !== "true") finish("unknown");
  const revision = gitText(["rev-parse", "--verify", "HEAD"]);
  if (revisionOnly) {
    process.stdout.write(`${revision}\n`);
    process.exit(0);
  }

  const tree = parseHeadTree();
  const { default: dockerIgnore } = await import("@balena/dockerignore");
  const dockerfile = "Dockerfile.dev";
  const specificIgnore = `${dockerfile}.dockerignore`;
  const rootIgnore = ".dockerignore";
  const headHasSpecificIgnore = tree.has(specificIgnore);
  const worktreeHasSpecificIgnore = exists(join(repoRoot, specificIgnore));
  if (headHasSpecificIgnore !== worktreeHasSpecificIgnore) dirty("Dockerfile-specific ignore existence changed");
  const activeIgnore = worktreeHasSpecificIgnore ? specificIgnore : rootIgnore;
  const activeIgnorePath = join(repoRoot, activeIgnore);
  const ignoreContents = exists(activeIgnorePath) ? readFileSync(activeIgnorePath, "utf8") : "";
  const matcher = dockerIgnore({ ignorecase: false }).add(ignoreContents);
  const negativePrefixes = negativeTraversalPrefixes(matcher);
  const forcedInputs = new Set([dockerfile, specificIgnore, activeIgnore]);
  const directories = trackedDirectories(tree.keys());

  const included = (path: string): boolean => forcedInputs.has(path) || !matcher.ignores(path);
  const shouldTraverseIgnored = (path: string): boolean => {
    for (const prefix of negativePrefixes) {
      if (prefix === undefined) throw new UnknownSourceState();
      if (pathsOverlap(path, prefix)) return true;
    }
    return false;
  };

  const walk = (directory: string, relativeDirectory = ""): void => {
    let entries: Dirent[];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      throw new UnknownSourceState();
    }
    for (const entry of entries) {
      const path = toContextPath(relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name);
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!included(path)) {
          if (shouldTraverseIgnored(path)) walk(absolute, path);
          continue;
        }
        // Git has no empty-directory entry. An included directory without a
        // tracked descendant is therefore a new Docker-context input itself.
        if (!directories.has(path)) dirty(`included untracked directory: ${path} (ignore=${activeIgnore}, matched=${matcher.ignores(path)})`);
        walk(absolute, path);
        continue;
      }
      if (included(path) && !tree.has(path)) dirty(`included untracked path: ${path}`);
    }
  };
  walk(repoRoot);

  const objectFormat = gitText(["rev-parse", "--show-object-format"]);
  if (objectFormat !== "sha1" && objectFormat !== "sha256") throw new UnknownSourceState();
  for (const [path, expected] of tree) {
    if (!included(path)) continue;
    const absolute = join(repoRoot, path);
    let stat: Stats;
    try {
      stat = lstatSync(absolute);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") dirty(`included tracked path is absent: ${path}`);
      throw new UnknownSourceState();
    }
    if (expected.type !== "blob") throw new UnknownSourceState();
    let bytes: Uint8Array;
    if (expected.mode === "120000") {
      if (!stat.isSymbolicLink()) dirty(`tracked symlink type changed: ${path}`);
      bytes = readlinkSync(absolute, { encoding: "buffer" });
    } else if (expected.mode === "100644" || expected.mode === "100755") {
      if (!stat.isFile() || stat.isSymbolicLink()) dirty(`tracked regular-file type changed: ${path}`);
      // A local Docker context preserves all permission bits. Git's canonical
      // checkout modes are 0644 and 0755, so comparing only the executable bit
      // can falsely call a chmod 0600/0700/0775 context clean.
      const expectedPermissions = expected.mode === "100755" ? 0o755 : 0o644;
      if ((stat.mode & 0o7777) !== expectedPermissions) dirty(`tracked permission mode changed: ${path}`);
      bytes = readFileSync(absolute);
    } else {
      throw new UnknownSourceState();
    }
    if (blobHash(bytes, objectFormat) !== expected.object) dirty(`tracked bytes changed: ${path}`);
  }

  finish("clean");
} catch {
  finish("unknown");
}
