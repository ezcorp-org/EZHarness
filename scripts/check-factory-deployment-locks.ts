#!/usr/bin/env bun
/**
 * Every image the factory deployment profiles run is pinned by digest.
 *
 * Reads the factory Dockerfile's base images and every `image:` in the Compose
 * templates, and refuses any reference without `@sha256:<64 hex>`. An image
 * the provisioner fills in at render time (`${EZCORP_FACTORY_..._IMAGE:?}`) is
 * accepted: the fleet settings refuse an unpinned installation image before
 * any template is rendered.
 *
 *   bun scripts/check-factory-deployment-locks.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PINNED = /@sha256:[0-9a-f]{64}$/;
const RENDERED = /^\$\{EZCORP_FACTORY_[A-Z_]+_IMAGE:\?\}$/;

export interface FactoryImageReference { readonly file: string; readonly line: number; readonly reference: string }

/** Base images named in a Dockerfile: `ARG *_IMAGE=` defaults and literal `FROM` references. */
export function dockerfileImages(file: string, text: string): FactoryImageReference[] {
  const found: FactoryImageReference[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    const arg = /^ARG\s+[A-Z_]*IMAGE=(\S+)$/.exec(line);
    if (arg) found.push({ file, line: index + 1, reference: arg[1]! });
    const from = /^FROM\s+(\S+)/i.exec(line);
    if (from && !from[1]!.startsWith("${")) found.push({ file, line: index + 1, reference: from[1]! });
  });
  return found;
}

/** Every `image:` value in a Compose template, quotes removed. */
export function composeImages(file: string, text: string): FactoryImageReference[] {
  const found: FactoryImageReference[] = [];
  text.split("\n").forEach((raw, index) => {
    const image = /^\s*image:\s*["']?([^"'\s#]+)["']?/.exec(raw);
    if (image) found.push({ file, line: index + 1, reference: image[1]! });
  });
  return found;
}

export function unpinnedFactoryImages(references: readonly FactoryImageReference[]): FactoryImageReference[] {
  return references.filter((entry) => !PINNED.test(entry.reference) && !RENDERED.test(entry.reference));
}

export async function checkFactoryDeploymentLocks(root: string): Promise<{ readonly checked: number; readonly unpinned: readonly FactoryImageReference[] }> {
  const dockerfile = join(root, "deploy/factory/Dockerfile");
  const references = dockerfileImages("deploy/factory/Dockerfile", await readFile(dockerfile, "utf8"));
  const composeDirectory = join(root, "deploy/factory/compose");
  for (const name of (await readdir(composeDirectory)).filter((entry) => entry.endsWith(".yml")).sort()) {
    references.push(...composeImages(`deploy/factory/compose/${name}`, await readFile(join(composeDirectory, name), "utf8")));
  }
  return { checked: references.length, unpinned: unpinnedFactoryImages(references) };
}

export interface FactoryLockCheckIo { log(line: string): void; exit(code: number): void }
export const factoryLockCheckIo: FactoryLockCheckIo = { log: (line) => console.log(line), exit: (code) => { process.exitCode = code; } };

export async function runFactoryDeploymentLockCheck(argv: readonly string[], moduleUrl: string, root = resolve(import.meta.dir, ".."), io: FactoryLockCheckIo = factoryLockCheckIo): Promise<void> {
  if (!argv[1] || resolve(argv[1]) !== fileURLToPath(moduleUrl)) return;
  const { checked, unpinned } = await checkFactoryDeploymentLocks(root);
  for (const entry of unpinned) io.log(`${entry.file}:${entry.line}: image ${entry.reference} is not pinned by digest`);
  io.log(unpinned.length === 0 ? `Factory deployment locks OK: ${checked} image references, all pinned.` : `${unpinned.length} of ${checked} image references are not pinned.`);
  io.exit(unpinned.length === 0 ? 0 : 1);
}

await runFactoryDeploymentLockCheck(process.argv, import.meta.url);
