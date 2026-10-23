#!/usr/bin/env bun
/**
 * Every image the factory deployment profiles run is pinned by digest.
 *
 * Reads the factory Dockerfile's base images and every `image:` in the Compose
 * and Kubernetes templates (one lock mechanism for both deployment profiles),
 * and refuses any reference without `@sha256:<64 hex>`. The Kubernetes
 * renderer refuses an unpinned image itself (`kubernetes-profile.ts`). An image
 * the provisioner fills in at render time (`${EZCORP_FACTORY_..._IMAGE:?}`) is
 * accepted: the fleet settings refuse an unpinned installation image before
 * any template is rendered.
 *
 *   bun scripts/check-factory-deployment-locks.ts
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { factoryImagePinned } from "../src/factory/provisioning/image-pin";

const RENDERED = /^\$\{EZCORP_FACTORY_[A-Z_]+_IMAGE:\?\}$/;

export interface FactoryImageReference { readonly file: string; readonly line: number; readonly reference: string; readonly kind?: "download" }

/** A file the image build downloads. Pinned only by `ADD --checksum=sha256:<64 hex> <url>`; a RUN that fetches is never pinned. */
export interface FactoryArtifactReference { readonly file: string; readonly line: number; readonly reference: string; readonly pinned: boolean }

const CHECKSUM = /--checksum=sha256:[0-9a-f]{64}(?:\s|$)/;

export function dockerfileArtifacts(file: string, text: string): FactoryArtifactReference[] {
  const found: FactoryArtifactReference[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim();
    const url = /^ADD\s.*?(https?:\/\/\S+)/.exec(line);
    if (url) found.push({ file, line: index + 1, reference: url[1]!, pinned: CHECKSUM.test(line) });
    else if (/^RUN\s.*\b(?:curl|wget)\b/.test(line)) found.push({ file, line: index + 1, reference: line, pinned: false });
  });
  return found;
}

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

/** Every `image:` value in a Compose or Kubernetes template, quotes removed. */
export function composeImages(file: string, text: string): FactoryImageReference[] {
  const found: FactoryImageReference[] = [];
  text.split("\n").forEach((raw, index) => {
    const image = /^\s*image:\s*["']?([^"'\s#]+)["']?/.exec(raw);
    if (image) found.push({ file, line: index + 1, reference: image[1]! });
  });
  return found;
}

export function unpinnedFactoryImages(references: readonly FactoryImageReference[]): FactoryImageReference[] {
  return references.filter((entry) => !factoryImagePinned(entry.reference) && !RENDERED.test(entry.reference));
}

export async function checkFactoryDeploymentLocks(root: string): Promise<{ readonly checked: number; readonly unpinned: readonly FactoryImageReference[] }> {
  const dockerfile = join(root, "deploy/factory/Dockerfile");
  const dockerfileText = await readFile(dockerfile, "utf8");
  const references = dockerfileImages("deploy/factory/Dockerfile", dockerfileText);
  const artifacts = dockerfileArtifacts("deploy/factory/Dockerfile", dockerfileText);
  for (const directory of ["deploy/factory/compose", "deploy/factory/kubernetes"]) {
    for (const name of (await readdir(join(root, directory))).filter((entry) => entry.endsWith(".yml")).sort()) {
      references.push(...composeImages(`${directory}/${name}`, await readFile(join(root, directory, name), "utf8")));
    }
  }
  const unpinnedDownloads = artifacts.filter((entry) => !entry.pinned).map(({ file, line, reference }): FactoryImageReference => ({ file, line, reference, kind: "download" }));
  return { checked: references.length + artifacts.length, unpinned: [...unpinnedFactoryImages(references), ...unpinnedDownloads] };
}

export interface FactoryLockCheckIo { log(line: string): void; exit(code: number): void }
export const factoryLockCheckIo: FactoryLockCheckIo = { log: (line) => console.log(line), exit: (code) => { process.exitCode = code; } };

export async function runFactoryDeploymentLockCheck(argv: readonly string[], moduleUrl: string, root = resolve(import.meta.dir, ".."), io: FactoryLockCheckIo = factoryLockCheckIo): Promise<void> {
  if (!argv[1] || resolve(argv[1]) !== fileURLToPath(moduleUrl)) return;
  const { checked, unpinned } = await checkFactoryDeploymentLocks(root);
  for (const entry of unpinned) io.log(entry.kind === "download" ? `${entry.file}:${entry.line}: download ${entry.reference} is not pinned by sha256` : `${entry.file}:${entry.line}: image ${entry.reference} is not pinned by digest`);
  io.log(unpinned.length === 0 ? `Factory deployment locks OK: ${checked} image and download references, all pinned.` : `${unpinned.length} of ${checked} image and download references are not pinned.`);
  io.exit(unpinned.length === 0 ? 0 : 1);
}

await runFactoryDeploymentLockCheck(process.argv, import.meta.url);
