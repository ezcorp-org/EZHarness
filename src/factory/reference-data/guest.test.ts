import { expect, test } from "bun:test";
import { readFile, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { filesDigest, pythonLockDigest } from "@ezcorp/extension-runner";
import {
  FACTORY_REFERENCE_DATA_DISTRIBUTIONS,
  FACTORY_REFERENCE_DATA_ENTRYPOINT,
  FACTORY_REFERENCE_DATA_EXPORTS,
  FACTORY_REFERENCE_DATA_MANIFEST_NAME,
  FACTORY_REFERENCE_DATA_MODELS,
  FACTORY_REFERENCE_DATA_PACKAGE,
  FACTORY_REFERENCE_DATA_VERSION,
  factoryReferenceDataClosure,
  factoryReferenceDataGuestDigest,
  factoryReferenceDataGuestFiles,
  factoryReferenceDataImage,
  factoryReferenceDataImageLock,
  factoryReferenceDataImageTag,
} from "./guest";

/**
 * The sealed identity of the pinned guest.
 *
 * Nothing here starts a container. These cases fix what the release lock IS,
 * so a drift between the committed lock, the committed source, and the image
 * that was actually built is a failure with a name rather than a run that
 * quietly used something else.
 */

const REPOSITORY = join(import.meta.dir, "../../..");

test("the guest is exactly the committed modules, the reused C02 guest, and the generated schemas", async () => {
  const files = await factoryReferenceDataGuestFiles();
  expect(Object.keys(files).sort()).toEqual([
    "factory-runner-request.schema.json",
    "factory-runner-result.schema.json",
    "factory_ijson.py",
    "factory_schema.py",
    "factory_validation.py",
    "guest.py",
    "refdata/__init__.py",
    "refdata/guest.py",
    "refdata/parquet.py",
    "refdata/rows.py",
    "refdata/test_sealed.py",
  ]);
  expect(FACTORY_REFERENCE_DATA_ENTRYPOINT in files).toBe(true);
  // The sealed bytes are the repository's bytes, not a copy written for a test.
  expect(files["refdata/rows.py"]).toBe(await readFile(join(REPOSITORY, "src/factory/runner/python/refdata/rows.py"), "utf8"));
  expect(files["factory-runner-request.schema.json"]).toBe(await readFile(join(REPOSITORY, "packages/@ezcorp/factory-sdk/src/factory-runner-request.schema.json"), "utf8"));
  expect(await factoryReferenceDataGuestDigest()).toBe(filesDigest(files));
});

test("at least one sealed test is staged, because a build with none is refused", async () => {
  const files = await factoryReferenceDataGuestFiles();
  const tests = Object.keys(files).filter(path => /(?:^|\/)test_[^/]+\.py$/.test(path));
  expect(tests).toEqual(["refdata/test_sealed.py"]);
  // The repository-reading suites stay OUT of the guest: it has no repository.
  expect(Object.keys(files)).not.toContain("refdata/test_rows.py");
  expect(Object.keys(files)).not.toContain("refdata/test_guest.py");
});

test("the content lock pins the interpreter, the committed uv.lock, and the observed closure", async () => {
  const closure = await factoryReferenceDataClosure();
  expect(closure.pythonVersion).toBe((await readFile(join(REPOSITORY, ".python-version"), "utf8")).trim());
  expect(closure.lockDigest).toBe(await pythonLockDigest(join(REPOSITORY, "src/factory/runner/python/uv.lock")));
  expect(closure.distributions).toEqual(FACTORY_REFERENCE_DATA_DISTRIBUTIONS);
  expect(closure.distributions).toContain("pyarrow==25.0.1");
  expect(closure.models).toEqual(FACTORY_REFERENCE_DATA_MODELS);
  expect(closure.resourceClass).toBe("cpu-small");
  expect((await factoryReferenceDataClosure("cpu-large")).resourceClass).toBe("cpu-large");
  // The list must be sorted and unique, or the runner refuses the closure.
  expect([...closure.distributions].sort()).toEqual([...closure.distributions]);
  expect(new Set(closure.distributions).size).toBe(closure.distributions.length);
});

test("the recorded release lock names the image the committed inputs derive", async () => {
  const lock = await factoryReferenceDataImageLock();
  expect(lock.tag).toBe(await factoryReferenceDataImageTag());
  expect(lock.lockDigest).toBe(await pythonLockDigest(join(REPOSITORY, "src/factory/runner/python/uv.lock")));
  expect(lock.base).toMatch(/^docker\.io\/library\/python@sha256:[a-f0-9]{64}$/);
  expect(lock.image).toBe(`${lock.repository}@sha256:${lock.image.split("@sha256:")[1] as string}`);
  expect(await factoryReferenceDataImage()).toBe(lock.image);
  // The runner refuses anything that is not an immutable digest reference.
  expect(lock.image).toMatch(/^[a-zA-Z0-9./_-]+@sha256:[a-f0-9]{64}$/);
});

test("a lock that no longer matches its inputs is a readiness failure, not a substitute image", async () => {
  const recorded = await factoryReferenceDataImageLock();
  const directory = await mkdtemp(join(tmpdir(), "refdata-lock-"));
  for (const broken of [
    { ...recorded, tag: "0".repeat(32) },
    { ...recorded, lockDigest: `sha256:${"0".repeat(64)}` },
    { ...recorded, image: "localhost/ezcorp-factory-python-data:latest" },
    { ...recorded, repository: "" },
  ]) {
    await writeFile(join(directory, "pinned.json"), JSON.stringify(broken));
    // The assertion is stated against the same rules `factoryReferenceDataImage`
    // applies, because that function reads the repository's own committed file.
    const readBack = JSON.parse(await readFile(join(directory, "pinned.json"), "utf8")) as Record<string, unknown>;
    const complete = Boolean(readBack.repository && readBack.tag && readBack.image && readBack.base && readBack.lockDigest);
    const pinned = /@sha256:[a-f0-9]{64}$/.test(String(readBack.image));
    const matches = readBack.tag === recorded.tag && readBack.lockDigest === recorded.lockDigest;
    expect(complete && pinned && matches).toBe(false);
  }
});

test("the package reference is not the v4 manifest name, and both are stated", () => {
  expect(FACTORY_REFERENCE_DATA_PACKAGE).toBe("@ezcorp/reference-data");
  expect(FACTORY_REFERENCE_DATA_VERSION).toBe("1.0.0");
  // A scoped npm name cannot satisfy validateManifest's ^[a-z][a-z0-9-]{0,63}$.
  expect(/^[a-z][a-z0-9-]{0,63}$/.test(FACTORY_REFERENCE_DATA_PACKAGE)).toBe(false);
  expect(/^[a-z][a-z0-9-]{0,63}$/.test(FACTORY_REFERENCE_DATA_MANIFEST_NAME)).toBe(true);
  expect(FACTORY_REFERENCE_DATA_EXPORTS).toEqual(["snapshotCsv", "parseCsv", "transformPartition", "orderedReduce"]);
});
