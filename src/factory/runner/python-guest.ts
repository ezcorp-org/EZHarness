import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkspaceFiles } from "@ezcorp/extension-contract";
import { filesDigest, pythonLockDigest, type PythonRunnerClosure } from "@ezcorp/extension-runner";

/** The module the in-guest launcher imports and calls. */
export const FACTORY_PYTHON_GUEST_ENTRYPOINT = "guest.py";

/**
 * The distributions the pinned interpreter image actually ships. It is recorded
 * rather than assumed, so a base image that gained one fails the build instead
 * of reaching an attempt. The guest has no network and a read-only root, so the
 * installer present here can install nothing.
 */
export const FACTORY_PYTHON_GUEST_DISTRIBUTIONS = Object.freeze(["pip==25.3"]);

/** No model weights are pinned for the conformance guest; it runs no model. */
export const FACTORY_PYTHON_GUEST_MODELS = Object.freeze([] as readonly string[]);

const GENERATED_SCHEMAS = Object.freeze(["factory-runner-request.schema.json", "factory-runner-result.schema.json", "factory-guest-model-request.schema.json", "factory-guest-model-response.schema.json"]);

function repositoryRoot(): string {
  return join(import.meta.dir, "../../..");
}

function pythonProject(): string {
  return join(import.meta.dir, "python");
}

/**
 * Exactly the committed bytes one Python guest runs: its modules, its own test
 * suite, and the generated schemas the Bun runtime imports. The build seals this
 * map into an immutable artifact, so the guest that answers an attempt is the
 * same source this repository holds and the same schemas the other runtime uses.
 */
export async function factoryPythonGuestFiles(): Promise<WorkspaceFiles> {
  const project = pythonProject();
  const files: Record<string, string> = {};
  for (const entry of (await readdir(project)).sort()) {
    if (entry.endsWith(".py")) files[entry] = await readFile(join(project, entry), "utf8");
  }
  for (const entry of (await readdir(join(project, "tests"))).sort()) {
    // `test_refdata_*` belongs to the reference-data pack, whose guest image
    // carries PyArrow and whose suite this guest's image cannot import. The
    // build runs every staged test, so staging one it cannot run would fail it.
    if (entry.startsWith("test_refdata_")) continue;
    if (entry.endsWith(".py")) files[`tests/${entry}`] = await readFile(join(project, "tests", entry), "utf8");
  }
  for (const schema of GENERATED_SCHEMAS) {
    files[schema] = await readFile(join(repositoryRoot(), "packages/@ezcorp/factory-sdk/src", schema), "utf8");
  }
  if (!(FACTORY_PYTHON_GUEST_ENTRYPOINT in files)) throw new Error("The Python guest entrypoint is missing from the committed distribution.");
  return files;
}

/** The digest the build seals; a caller that stages other bytes gets a different one. */
export async function factoryPythonGuestDigest(): Promise<string> {
  return filesDigest(await factoryPythonGuestFiles());
}

/**
 * The content lock: the repository's own interpreter pin, the committed
 * `uv.lock` by digest, the importable closure, the model closure, and the C03
 * resource class. Nothing here is resolved at execution time.
 */
export async function factoryPythonRunnerClosure(resourceClass = "cpu-small"): Promise<PythonRunnerClosure> {
  const pythonVersion = (await readFile(join(repositoryRoot(), ".python-version"), "utf8")).trim();
  return Object.freeze({
    pythonVersion,
    lockDigest: await pythonLockDigest(join(pythonProject(), "uv.lock")),
    distributions: FACTORY_PYTHON_GUEST_DISTRIBUTIONS,
    models: FACTORY_PYTHON_GUEST_MODELS,
    resourceClass,
  });
}
