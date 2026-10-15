import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, test } from "bun:test";

import { filesDigest } from "@ezcorp/extension-runner";

import { REFERENCE_IMAGE_GUEST_ENTRYPOINT, referenceImageGuestDigest, referenceImageGuestFiles, referenceImageRunnerClosure } from "./closure.ts";
import { referenceImageLock, referenceImageModelPins } from "./lock.ts";
import { referenceImageModelDocument, sdxlClosureDirectoryFor } from "./model-lock.ts";

describe("the staged guest", () => {
  test("it stages the entrypoint, the pure modules, and the guest's own tests", async () => {
    const files = await referenceImageGuestFiles();
    const paths = Object.keys(files).sort();
    expect(paths).toContain(REFERENCE_IMAGE_GUEST_ENTRYPOINT);
    expect(paths).toContain("reference_image/png_format.py");
    expect(paths).toContain("reference_image/png_normalize.py");
    expect(paths).toContain("reference_image/ocr_report.py");
    expect(paths).toContain("reference_image/claims.py");
    expect(paths).toContain("reference_image/sdxl.py");
    expect(paths).toContain("reference_image/fixtures.py");
    expect(paths.some(path => path.startsWith("tests/test_"))).toBe(true);
  });

  test("every staged path is a Python module", async () => {
    for (const path of Object.keys(await referenceImageGuestFiles())) expect(path).toEndWith(".py");
  });

  test("the package markers are staged, so the guest can import its own modules", async () => {
    const paths = Object.keys(await referenceImageGuestFiles());
    expect(paths).toContain("reference_image/__init__.py");
    expect(paths).toContain("tests/__init__.py");
  });

  test("the staged bytes are the committed bytes", async () => {
    const files = await referenceImageGuestFiles();
    const onDisk = await Bun.file(new URL("./python/reference_image/png_format.py", import.meta.url).pathname).text();
    expect(files["reference_image/png_format.py"]).toBe(onDisk);
  });

  test("a distribution with no entrypoint is refused rather than staged", async () => {
    const project = await mkdtemp(join(tmpdir(), "ez-image-guest-"));
    await mkdir(join(project, "reference_image"), { recursive: true });
    await mkdir(join(project, "tests"), { recursive: true });
    await writeFile(join(project, "reference_image/__init__.py"), "");
    await writeFile(join(project, "tests/__init__.py"), "");
    await expect(referenceImageGuestFiles(project)).rejects.toThrow(/entrypoint is missing/);
  });

  test("the digest is the digest of exactly those files", async () => {
    expect(await referenceImageGuestDigest()).toBe(filesDigest(await referenceImageGuestFiles()));
  });

  test("staging twice yields the same digest", async () => {
    expect(await referenceImageGuestDigest()).toBe(await referenceImageGuestDigest());
  });
});

describe("the runner content lock", () => {
  test("it pins the interpreter the image ships, not the repository's host pin", async () => {
    const closure = await referenceImageRunnerClosure();
    expect(closure.pythonVersion).toBe(referenceImageLock.runtime.pythonVersion);
    const hostPin = (await Bun.file(new URL("../../../.python-version", import.meta.url).pathname).text()).trim();
    expect(closure.pythonVersion).not.toBe(hostPin);
  });

  test("it pins the committed dependency lock by digest", async () => {
    const closure = await referenceImageRunnerClosure();
    expect(closure.lockDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
  });

  test("it carries every recorded distribution, sorted", async () => {
    const closure = await referenceImageRunnerClosure();
    expect(closure.distributions.length).toBe(referenceImageLock.runtime.distributions.length);
    expect([...closure.distributions]).toEqual([...closure.distributions].sort());
    expect(closure.distributions).toContain("torch==2.12.0+rocm7.14.1");
    expect(closure.distributions).toContain("diffusers==0.40.0");
  });

  test("it carries the model weight pins and nothing that is not a weight", async () => {
    const closure = await referenceImageRunnerClosure();
    expect([...closure.models]).toEqual([...referenceImageModelPins()]);
    expect(closure.models.length).toBe(referenceImageLock.model.files.filter(file => file.digest !== undefined).length);
  });

  test("it names the resource class the attempt is admitted under", async () => {
    expect((await referenceImageRunnerClosure()).resourceClass).toBe(referenceImageLock.runtime.resourceClass);
  });

  test("it is frozen, so a caller cannot edit the pin it just read", async () => {
    expect(Object.isFrozen(await referenceImageRunnerClosure())).toBe(true);
  });
});

describe("the model-only reader", () => {
  test("it returns the committed model section without needing the runtime section", () => {
    const model = referenceImageModelDocument();
    expect(model.revision).toBe(referenceImageLock.model.revision);
    expect(model.repository).toBe(referenceImageLock.model.repository);
    expect(model.files.length).toBe(referenceImageLock.model.files.length);
  });

  test("what it returns is frozen", () => {
    const model = referenceImageModelDocument();
    expect(Object.isFrozen(model)).toBe(true);
    expect(Object.isFrozen(model.files[0])).toBe(true);
  });

  test("it resolves the same closure directory the full lock does", () => {
    expect(sdxlClosureDirectoryFor(referenceImageModelDocument())).toEndWith(`/${referenceImageLock.model.revision}`);
  });
});
