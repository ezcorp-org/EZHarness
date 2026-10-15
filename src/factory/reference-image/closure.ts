/**
 * The image pack's guest, sealed through the shared Python recipe machinery.
 *
 * This is the counterpart of `src/factory/runner/python-guest.ts` for a guest
 * that runs a model. It stages exactly the committed source the guest runs and
 * declares the content lock the shared runner enforces: the interpreter the
 * image actually ships, the committed dependency lock by digest, the importable
 * distributions the image actually has, the model weights by digest, and the
 * resource class the attempt is admitted under.
 *
 * Nothing here resolves anything at execution time. The distribution list is
 * recorded rather than assumed, so an image that gained or lost a package fails
 * the build with `dependency_closure_changed` instead of reaching an attempt,
 * and the model pins are the same digests the fetcher verified byte for byte.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { filesDigest, pythonLockDigest, type PythonRunnerClosure } from "@ezcorp/extension-runner";

import { referenceImageLock, referenceImageModelPins, type ReferenceImageLock } from "./lock.ts";

/** The module the in-guest launcher imports and calls. */
export const REFERENCE_IMAGE_GUEST_ENTRYPOINT = "image_guest.py";

function pythonProject(): string {
  return join(import.meta.dir, "python");
}

/**
 * Exactly the committed bytes the image guest runs: its entrypoint, the pure
 * modules it imports, and its own test suite.
 *
 * The suite is staged because the shared Python build runs it inside the same
 * isolated profile the attempt will use. A guest whose tests do not pass in the
 * image never becomes an artifact, which is what makes "it works on the host" an
 * insufficient claim here.
 *
 * The directory is a parameter so the missing-entrypoint refusal can be
 * exercised. A guard that cannot be reached by a test is a guard nobody has
 * checked still works.
 */
export async function referenceImageGuestFiles(project: string = pythonProject()): Promise<WorkspaceFiles> {
  const files: Record<string, string> = {};
  for (const entry of (await readdir(project)).sort()) {
    if (entry.endsWith(".py")) files[entry] = await readFile(join(project, entry), "utf8");
  }
  for (const entry of (await readdir(join(project, "reference_image"))).sort()) {
    if (entry.endsWith(".py")) files[`reference_image/${entry}`] = await readFile(join(project, "reference_image", entry), "utf8");
  }
  for (const entry of (await readdir(join(project, "tests"))).sort()) {
    if (entry.endsWith(".py")) files[`tests/${entry}`] = await readFile(join(project, "tests", entry), "utf8");
  }
  if (!(REFERENCE_IMAGE_GUEST_ENTRYPOINT in files)) {
    throw new Error("The reference image guest entrypoint is missing from the committed distribution.");
  }
  return files;
}

/** The digest the build seals; a caller that stages other bytes gets a different one. */
export async function referenceImageGuestDigest(): Promise<string> {
  return filesDigest(await referenceImageGuestFiles());
}

/**
 * The content lock for the image guest.
 *
 * `pythonVersion` is the interpreter the pinned image ships, which is not the
 * repository's `.python-version`. Those two pins answer different questions:
 * the repository pin governs the host toolchain that lints, types, and measures
 * this source, and this one governs the interpreter that executes it inside the
 * image. Forcing them to agree would mean rebuilding the ROCm image to match a
 * host tool, and letting either drift unrecorded is what this lock prevents.
 */
export async function referenceImageRunnerClosure(lock: ReferenceImageLock = referenceImageLock): Promise<PythonRunnerClosure> {
  return Object.freeze({
    pythonVersion: lock.runtime.pythonVersion,
    lockDigest: await pythonLockDigest(join(pythonProject(), "uv.lock")),
    distributions: Object.freeze([...lock.runtime.distributions].sort()),
    models: referenceImageModelPins(lock),
    resourceClass: lock.runtime.resourceClass,
  });
}
