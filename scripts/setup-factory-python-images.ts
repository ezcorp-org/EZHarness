#!/usr/bin/env bun
/**
 * Puts the two pinned Python images on a CI host, for the suites that run
 * them: the CPython base (`DEFAULT_PYTHON_IMAGE`, the python guest and applied
 * controls suites) and the PyArrow data image (`pinned.json`, the reference
 * data journey).
 *
 * Both references come from the modules those suites read, so the step and
 * the tests cannot name different images. The base is pulled by digest. The
 * data image has no registry, so it is built from the committed recipe by
 * `scripts/build-factory-data-image.sh`, which fails when the build does not
 * reproduce the pinned digest. Nothing is tagged by hand and nothing floats.
 *
 * Usage (CI, through `.github/actions/factory-python-images`):
 *   bun scripts/setup-factory-python-images.ts
 */
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { DEFAULT_PYTHON_IMAGE } from "../packages/@ezcorp/extension-runner/src/index.ts";
import { factoryReferenceDataImage } from "../src/factory/reference-data/guest.ts";

export interface FactoryPythonImages {
  /** The CPython base, by registry digest. */
  readonly base: string;
  /** The PyArrow data image, by the manifest digest `pinned.json` records. */
  readonly data: string;
}

/** The two references, read from the pin source the suites read. */
export async function factoryPythonImages(): Promise<FactoryPythonImages> {
  return { base: DEFAULT_PYTHON_IMAGE, data: await factoryReferenceDataImage() };
}

export type Run = (command: string, args: readonly string[]) => number;

export const runInherited: Run = (command, args) => spawnSync(command, args, { stdio: "inherit" }).status ?? 1;

/**
 * Pulls the base, builds the data image from the recipe, and proves each
 * pinned reference resolves locally. Stops at the first failure and returns
 * its exit code with a line that names the image.
 */
export async function setupFactoryPythonImages(root: string, run: Run = runInherited, log: (line: string) => void = console.log, images: () => Promise<FactoryPythonImages> = factoryPythonImages): Promise<number> {
  const { base, data } = await images();
  const steps: readonly { readonly what: string; readonly command: string; readonly args: readonly string[] }[] = [
    { what: `pull ${base}`, command: "podman", args: ["pull", base] },
    { what: `find ${base}`, command: "podman", args: ["image", "exists", base] },
    { what: `build ${data} from the committed recipe`, command: "bash", args: [join(root, "scripts/build-factory-data-image.sh")] },
    { what: `find ${data}`, command: "podman", args: ["image", "exists", data] },
  ];
  for (const step of steps) {
    log(`factory python images: ${step.what}`);
    const status = run(step.command, step.args);
    if (status !== 0) {
      log(`factory python images: could not ${step.what} (exit ${status})`);
      return status;
    }
  }
  return 0;
}

export const SETUP_FACTORY_PYTHON_IMAGES_RESULT = import.meta.main ? await setupFactoryPythonImages(resolve(import.meta.dir, "..")) : undefined;
if (SETUP_FACTORY_PYTHON_IMAGES_RESULT !== undefined) process.exitCode = SETUP_FACTORY_PYTHON_IMAGES_RESULT;
