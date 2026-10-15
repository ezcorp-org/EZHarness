#!/usr/bin/env bun
/**
 * Puts the pinned CPython base image on a CI host, for the suites that run
 * it (python guest, applied controls).
 *
 * The reference is `DEFAULT_PYTHON_IMAGE`, the value those suites and the
 * Python runner read, so the step and the tests cannot name different
 * images. It is pulled by registry digest and then proven present by that
 * same digest; nothing is tagged and nothing floats.
 *
 * The PyArrow data image (`src/factory/reference-data/image/pinned.json`) is
 * not pulled here: no registry holds it, and a hosted runner's podman does
 * not rebuild its pinned digest, so its journey suite runs in the lane that
 * holds the image (scripts/check-factory-lanes.ts).
 *
 * Usage (CI, through `.github/actions/factory-python-base`):
 *   bun scripts/setup-factory-python-base.ts
 */
import { spawnSync } from "node:child_process";
import { DEFAULT_PYTHON_IMAGE } from "../packages/@ezcorp/extension-runner/src/index.ts";

export type Run = (command: string, args: readonly string[]) => number;

export const runInherited: Run = (command, args) => spawnSync(command, args, { stdio: "inherit" }).status ?? 1;

/**
 * Pulls the base by digest and proves the digest resolves locally. Stops at
 * the first failure and returns its exit code with a line that names the image.
 */
export function setupFactoryPythonBase(run: Run = runInherited, log: (line: string) => void = console.log, image: string = DEFAULT_PYTHON_IMAGE): number {
  for (const [what, args] of [
    ["pull", ["pull", image]],
    ["find", ["image", "exists", image]],
  ] as const) {
    log(`factory python base: ${what} ${image}`);
    const status = run("podman", args);
    if (status !== 0) {
      log(`factory python base: could not ${what} ${image} (exit ${status})`);
      return status;
    }
  }
  return 0;
}

export const SETUP_FACTORY_PYTHON_BASE_RESULT = import.meta.main ? setupFactoryPythonBase() : undefined;
if (SETUP_FACTORY_PYTHON_BASE_RESULT !== undefined) process.exitCode = SETUP_FACTORY_PYTHON_BASE_RESULT;
