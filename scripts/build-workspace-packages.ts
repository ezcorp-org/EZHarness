#!/usr/bin/env bun
/**
 * Builds every workspace package that has a `build` script, in dependency
 * order. The one source of truth for the package build order: the root
 * `build:packages` script runs this, and the root postinstall and every
 * container file call that script instead of listing packages by hand.
 *
 * The workspaces come from bun.lock (what a frozen install links); the order
 * comes from each package's workspace dependencies, ties broken by path, so
 * the same tree always builds in the same order. Extra arguments pass through
 * to each package's build (e.g. `bun run build:packages --force`).
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface WorkspacePackage {
  readonly directory: string;
  readonly name: string;
  readonly hasBuild: boolean;
  /** Workspace package names this one depends on (any dependency field). */
  readonly dependsOn: readonly string[];
}

/** Every workspace bun.lock names, with what a build order needs from its package.json. */
export function readWorkspacePackages(root: string, read: (path: string) => string = path => readFileSync(path, "utf8")): WorkspacePackage[] {
  const lock = Bun.JSONC.parse(read(join(root, "bun.lock"))) as { workspaces?: Record<string, unknown> };
  const directories = Object.keys(lock.workspaces ?? {}).filter(directory => directory !== "");
  const manifests = directories.map(directory => ({
    directory,
    manifest: JSON.parse(read(join(root, directory, "package.json"))) as {
      name: string;
      scripts?: Record<string, string>;
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    },
  }));
  const names = new Set(manifests.map(({ manifest }) => manifest.name));
  return manifests.map(({ directory, manifest }) => ({
    directory,
    name: manifest.name,
    hasBuild: typeof manifest.scripts?.build === "string",
    dependsOn: Object.keys({ ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies }).filter(name => names.has(name)).sort(),
  }));
}

/**
 * The packages with a build script, each after every workspace package it
 * depends on (directly or through a package without a build). Throws on a
 * dependency cycle, which no order can satisfy.
 */
export function buildOrder(packages: readonly WorkspacePackage[]): WorkspacePackage[] {
  const byName = new Map(packages.map(pkg => [pkg.name, pkg]));
  const order: WorkspacePackage[] = [];
  const state = new Map<string, "visiting" | "done">();
  const visit = (pkg: WorkspacePackage, path: readonly string[]) => {
    if (state.get(pkg.name) === "done") return;
    if (state.get(pkg.name) === "visiting") throw new Error(`workspace dependency cycle: ${[...path, pkg.name].join(" -> ")}`);
    state.set(pkg.name, "visiting");
    for (const dependency of pkg.dependsOn) visit(byName.get(dependency)!, [...path, pkg.name]);
    state.set(pkg.name, "done");
    if (pkg.hasBuild) order.push(pkg);
  };
  for (const pkg of [...packages].sort((a, b) => a.directory.localeCompare(b.directory))) visit(pkg, []);
  return order;
}

type Run = (command: string, args: readonly string[]) => number;

const runInherited: Run = (command, args) => spawnSync(command, args, { stdio: "inherit" }).status ?? 1;

/** Builds each package in order; stops at the first failure and returns its exit code. */
export function buildWorkspacePackages(root: string, extraArgs: readonly string[], run: Run = runInherited, log: (line: string) => void = console.log): number {
  for (const pkg of buildOrder(readWorkspacePackages(root))) {
    log(`build:packages: ${pkg.name} (${pkg.directory})`);
    const status = run("bun", ["run", "--cwd", join(root, pkg.directory), "build", ...extraArgs]);
    if (status !== 0) {
      log(`build:packages: ${pkg.name} failed with exit ${status}`);
      return status;
    }
  }
  return 0;
}

if (import.meta.main) process.exit(buildWorkspacePackages(resolve(import.meta.dir, ".."), process.argv.slice(2)));
