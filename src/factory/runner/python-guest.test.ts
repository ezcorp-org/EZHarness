import { expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { FACTORY_PYTHON_GUEST_DISTRIBUTIONS, FACTORY_PYTHON_GUEST_ENTRYPOINT, FACTORY_PYTHON_GUEST_MODELS, factoryPythonGuestDigest, factoryPythonGuestFiles, factoryPythonRunnerClosure } from "./python-guest";

/**
 * What one Python guest is built from, without building one.
 *
 * The container lane proves the image runs; this proves the STAGED SET, which
 * is the thing that changes when a generated schema is added. A schema the Bun
 * runtime validates against and the Python guest never receives is a parity
 * claim with nothing behind it, and the only place that can be caught cheaply
 * is here.
 */

const ROOT = join(import.meta.dir, "../../..");

test("the staged distribution carries the committed modules, its own tests, and every generated schema both runtimes read", async () => {
  const files = await factoryPythonGuestFiles();
  const staged = Object.keys(files).sort();

  expect(staged).toContain(FACTORY_PYTHON_GUEST_ENTRYPOINT);
  expect(staged).toContain("factory_materials.py");
  expect(staged).toContain("factory_validation.py");
  // The staging pair, which is what makes the Python guest able to validate a
  // frame the Bun runtime built.
  expect(staged).toContain("factory-guest-material-request.schema.json");
  expect(staged).toContain("factory-guest-material-response.schema.json");
  expect(staged).toContain("tests/test_factory_guest_material.py");

  // Exactly the repository's own bytes, not a copy written for the sandbox.
  const source = await readFile(join(import.meta.dir, "python/factory_materials.py"), "utf8");
  expect(files["factory_materials.py"]).toBe(source);
  const schema = await readFile(join(ROOT, "packages/@ezcorp/factory-sdk/src/factory-guest-material-request.schema.json"), "utf8");
  expect(files["factory-guest-material-request.schema.json"]).toBe(schema);
  expect(JSON.parse(schema).$id).toBe("urn:ezcorp:factory:guest-material-request:v1");

  // The reference-data pack's own tests are excluded, because this image
  // cannot import PyArrow and the build runs every staged test.
  expect(staged.filter(name => name.includes("test_refdata_"))).toEqual([]);
});

test("the digest is over that staged set, and the closure pins the interpreter and the lock", async () => {
  const files = await factoryPythonGuestFiles();
  const digest = await factoryPythonGuestDigest();
  expect(digest).toMatch(/^[a-f0-9]{64}$/);
  // Stable across calls over unchanged bytes: the build seals this, so a
  // caller that staged other bytes gets a different one.
  expect(await factoryPythonGuestDigest()).toBe(digest);
  expect(Object.keys(files).length).toBeGreaterThan(10);

  const closure = await factoryPythonRunnerClosure();
  expect(closure.pythonVersion).toBe((await readFile(join(ROOT, ".python-version"), "utf8")).trim());
  expect(closure.lockDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  expect(closure.distributions).toEqual(FACTORY_PYTHON_GUEST_DISTRIBUTIONS);
  expect(closure.models).toEqual(FACTORY_PYTHON_GUEST_MODELS);
  expect(closure.resourceClass).toBe("cpu-small");
  expect((await factoryPythonRunnerClosure("gpu-small")).resourceClass).toBe("gpu-small");
});
